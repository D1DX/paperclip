import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { AdapterExecutionContext } from "@paperclipai/adapter-utils";

const TRUTHY_ENV_RE = /^(1|true|yes|on)$/i;
const COPIED_SHARED_FILES = ["config.json", "config.toml", "instructions.md"] as const;
// D-1767 (S4): auth.json is now COPIED per-agent rather than symlinked to the
// shared company home. Symlink -> shared home meant every codex_local agent in
// the same company shared one ChatGPT OAuth session; a second agent waking
// would rotate/burn the first agent's refresh token. By copying per-agent we
// isolate each agent's OAuth session by construction -- no per-agent env needed.
const COPIED_PER_AGENT_FILES = ["auth.json"] as const;
const DEFAULT_PAPERCLIP_INSTANCE_ID = "default";

function nonEmpty(value: string | undefined): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

export async function pathExists(candidate: string): Promise<boolean> {
  return fs.access(candidate).then(() => true).catch(() => false);
}

export function resolveSharedCodexHomeDir(
  env: NodeJS.ProcessEnv = process.env,
): string {
  const fromEnv = nonEmpty(env.CODEX_HOME);
  return fromEnv ? path.resolve(fromEnv) : path.join(os.homedir(), ".codex");
}

function isWorktreeMode(env: NodeJS.ProcessEnv): boolean {
  return TRUTHY_ENV_RE.test(env.PAPERCLIP_IN_WORKTREE ?? "");
}

/**
 * D-1767 (S4): returns the per-agent managed Codex home directory.
 * When both companyId and agentId are provided the path is:
 *   <paperclipHome>/instances/<instanceId>/companies/<companyId>/agents/<agentId>/codex-home
 * This guarantees each agent gets its own isolated Codex home (and therefore
 * its own auth.json) by construction -- no per-agent env var required.
 *
 * When only companyId is provided (legacy / fallback):
 *   <paperclipHome>/instances/<instanceId>/companies/<companyId>/codex-home
 *
 * When neither is provided (very old callers / tests):
 *   <paperclipHome>/instances/<instanceId>/codex-home
 */
export function resolveManagedCodexHomeDir(
  env: NodeJS.ProcessEnv,
  companyId?: string,
  agentId?: string,
): string {
  const paperclipHome = nonEmpty(env.PAPERCLIP_HOME) ?? path.resolve(os.homedir(), ".paperclip");
  const instanceId = nonEmpty(env.PAPERCLIP_INSTANCE_ID) ?? DEFAULT_PAPERCLIP_INSTANCE_ID;
  if (companyId && agentId) {
    // Per-agent path -- the canonical path for D-1767 S4.
    return path.resolve(
      paperclipHome,
      "instances",
      instanceId,
      "companies",
      companyId,
      "agents",
      agentId,
      "codex-home",
    );
  }
  return companyId
    ? path.resolve(paperclipHome, "instances", instanceId, "companies", companyId, "codex-home")
    : path.resolve(paperclipHome, "instances", instanceId, "codex-home");
}

async function ensureParentDir(target: string): Promise<void> {
  await fs.mkdir(path.dirname(target), { recursive: true });
}

async function ensureSymlink(target: string, source: string): Promise<void> {
  const existing = await fs.lstat(target).catch(() => null);
  if (!existing) {
    await ensureParentDir(target);
    await fs.symlink(source, target);
    return;
  }

  if (!existing.isSymbolicLink()) {
    return;
  }

  const linkedPath = await fs.readlink(target).catch(() => null);
  if (!linkedPath) return;

  const resolvedLinkedPath = path.resolve(path.dirname(target), linkedPath);
  if (resolvedLinkedPath === source) return;

  await fs.unlink(target);
  await fs.symlink(source, target);
}

async function ensureCopiedFile(target: string, source: string): Promise<void> {
  const existing = await fs.lstat(target).catch(() => null);
  if (existing) return;
  await ensureParentDir(target);
  await fs.copyFile(source, target);
}

/**
 * D-1861 (S-2): A managed per-agent Codex home with no auth.json means the
 * agent has never been provisioned. Emit ONE loud, structured diagnostic so
 * the failure is visible at the source instead of surfacing later as an opaque
 * "401 Missing bearer" that looks like an expired token. The fleet probe
 * Check-C catches the same class from the outside.
 *
 * D-1861 (S-1): we deliberately do NOT seed auth.json from any shared/other
 * home. The seed-from-shared crutch (the old PAPERCLIP_CODEX_SEED_SHARED_AGENT_IDS
 * allowlist) is retired — every codex_local agent owns its own auth.json (own
 * device-auth or own OPENAI_API_KEY), isolated by construction. Copying another
 * home's live token is exactly the refresh-token burn this whole design exists
 * to prevent.
 */
async function warnIfPerAgentAuthMissing(
  targetHome: string,
  agentId: string,
  onLog: AdapterExecutionContext["onLog"],
): Promise<void> {
  const authTarget = path.join(targetHome, "auth.json");
  const existing = await fs.lstat(authTarget).catch(() => null);
  if (existing) return;
  await onLog(
    "stderr",
    `[paperclip] AUTH MISSING for agent ${agentId}: no auth.json in managed Codex home "${targetHome}". ` +
      `This agent has not been provisioned — every run will fail with "401 Missing bearer" (this is a MISSING ` +
      `credential, not an expired one). Fix: CODEX_HOME="${targetHome}" codex login --device-auth (its OWN ` +
      `login — never copy another agent's auth.json), or set adapter_config.env.OPENAI_API_KEY. ` +
      `See platforms/paperclip/docs/codex-credential-lifecycle.md.\n`,
  );
}

/**
 * Writes an `auth.json` containing only `OPENAI_API_KEY` so the codex CLI can
 * authenticate via API key. Overwrites any existing file or symlink at that
 * path. Required because the codex CLI (>= 0.122) ignores the `OPENAI_API_KEY`
 * environment variable and only reads credentials from `$CODEX_HOME/auth.json`.
 */
export async function writeApiKeyAuthJson(home: string, apiKey: string): Promise<void> {
  await fs.mkdir(home, { recursive: true });
  const target = path.join(home, "auth.json");
  await fs.rm(target, { force: true });
  await fs.writeFile(target, JSON.stringify({ OPENAI_API_KEY: apiKey }), { mode: 0o600 });
}

export async function prepareManagedCodexHome(
  env: NodeJS.ProcessEnv,
  onLog: AdapterExecutionContext["onLog"],
  companyId?: string,
  options: { apiKey?: string | null; agentId?: string } = {},
): Promise<string> {
  // D-1767 (S4): key the managed home on agentId when available so every
  // codex_local agent gets its own isolated Codex home (and auth.json) by
  // construction.  Falls back to the legacy company-keyed path when agentId is
  // absent (e.g. legacy callers, test fixtures that don't pass an agentId).
  const targetHome = resolveManagedCodexHomeDir(env, companyId, options.agentId);
  const apiKey = nonEmpty(options.apiKey ?? undefined);

  const sourceHome = resolveSharedCodexHomeDir(env);
  const seedFromShared = path.resolve(sourceHome) !== path.resolve(targetHome);

  await fs.mkdir(targetHome, { recursive: true });

  if (seedFromShared) {
    if (!apiKey) {
      if (companyId && options.agentId) {
        // D-1861 (S-1): per-agent isolated home. No auth seeding — the agent
        // owns its own auth.json. (S-2) warn loudly if it has not been provisioned.
        await warnIfPerAgentAuthMissing(targetHome, options.agentId, onLog);
      } else {
        // Legacy no-agentId path (old callers / test fixtures only): symlink
        // auth.json to the shared home. Real agents always pass agentId and
        // take the isolated path above.
        for (const name of COPIED_PER_AGENT_FILES) {
          const source = path.join(sourceHome, name);
          if (!(await pathExists(source))) continue;
          await ensureSymlink(path.join(targetHome, name), source);
        }
      }
    }

    // Copy non-secret shared config (config.toml etc.) — never auth.json.
    for (const name of COPIED_SHARED_FILES) {
      const source = path.join(sourceHome, name);
      if (!(await pathExists(source))) continue;
      await ensureCopiedFile(path.join(targetHome, name), source);
    }

    await onLog(
      "stdout",
      `[paperclip] Using ${isWorktreeMode(env) ? "worktree-isolated" : "Paperclip-managed"} Codex home "${targetHome}".\n`,
    );
  }

  if (apiKey) {
    await writeApiKeyAuthJson(targetHome, apiKey);
    await onLog(
      "stdout",
      `[paperclip] Wrote API-key auth.json into Codex home "${targetHome}" from configured OPENAI_API_KEY.\n`,
    );
  }

  return targetHome;
}
