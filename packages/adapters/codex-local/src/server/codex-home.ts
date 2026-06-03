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

/**
 * Returns the legacy company-level managed Codex home directory.
 * Used internally as the seed source for a newly-created per-agent home so
 * that already-authed agents (e.g. Lidi) keep working on first upgrade without
 * re-authentication.  Never mutates or deletes this path.
 */
export function resolveLegacyCompanyCodexHomeDir(
  env: NodeJS.ProcessEnv,
  companyId: string,
): string {
  const paperclipHome = nonEmpty(env.PAPERCLIP_HOME) ?? path.resolve(os.homedir(), ".paperclip");
  const instanceId = nonEmpty(env.PAPERCLIP_INSTANCE_ID) ?? DEFAULT_PAPERCLIP_INSTANCE_ID;
  return path.resolve(paperclipHome, "instances", instanceId, "companies", companyId, "codex-home");
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
 * D-1767 (S4): If the per-agent target home does not yet have auth.json, seed
 * it from the first of the candidate sources that exists (copy -- never move or
 * delete the source).  Sources tried in order:
 *   1. The legacy company-level managed Codex home (the old shared path before
 *      S4; Lidi lives here -- copying keeps Lidi authed on first upgrade).
 *   2. The process-level shared Codex home (resolveSharedCodexHomeDir).
 *
 * Cutover safety properties:
 * - Copy-from, never move-from: sources are left intact.
 * - Only copies if target auth.json is absent: won't clobber an existing one.
 * - Non-blocking: failure is logged, not thrown (auth will simply be absent and
 *   Codex will prompt the user, the same behaviour as before S4).
 */
async function seedPerAgentAuthJson(
  targetHome: string,
  companyId: string,
  agentId: string,
  env: NodeJS.ProcessEnv,
  onLog: AdapterExecutionContext["onLog"],
): Promise<void> {
  const authTarget = path.join(targetHome, "auth.json");
  const existing = await fs.lstat(authTarget).catch(() => null);
  // Only seed when auth.json is truly absent (not a broken symlink).
  if (existing) return;

  // D-1767 (S4) cutover safety: auto-seeding copies an EXISTING (possibly live)
  // shared auth.json into this agent's fresh home. That is only safe for the
  // pre-S4 agent(s) that already legitimately own the shared ChatGPT session
  // (e.g. Lidi on /paperclip/.codex). Auto-seeding a *new* agent from the live
  // shared token would copy another agent's OAuth session and re-introduce the
  // exact refresh-token burn S4 exists to prevent. So seeding is gated to an
  // explicit allowlist (PAPERCLIP_CODEX_SEED_SHARED_AGENT_IDS, comma-separated
  // agent ids — set it to the pre-S4 live agent(s) at the S4 deploy); every
  // other agent must provide its own auth.json (own device-auth or
  // OPENAI_API_KEY) before first wake, or codex fails loudly rather than
  // silently burning another agent's token.
  const seedAllowlist = (env.PAPERCLIP_CODEX_SEED_SHARED_AGENT_IDS ?? "")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
  if (!seedAllowlist.includes(agentId)) {
    await onLog(
      "stdout",
      `[paperclip] D-1767: agent ${agentId} not in PAPERCLIP_CODEX_SEED_SHARED_AGENT_IDS — skipping shared-auth seed (agent must own its auth.json).\n`,
    );
    return;
  }

  const candidates: string[] = [
    // 1. Legacy company-level managed home (old shared path -- where Lidi's auth.json lives).
    path.join(resolveLegacyCompanyCodexHomeDir(env, companyId), "auth.json"),
    // 2. Process-level shared home (~/.codex or $CODEX_HOME).
    path.join(resolveSharedCodexHomeDir(env), "auth.json"),
  ];

  for (const src of candidates) {
    // Follow symlinks to check the real file exists.
    const srcStat = await fs.stat(src).catch(() => null);
    if (!srcStat) continue;
    try {
      await ensureParentDir(authTarget);
      await fs.copyFile(src, authTarget);
      // Ensure 0o600 regardless of source permissions.
      await fs.chmod(authTarget, 0o600);
      await onLog(
        "stdout",
        `[paperclip] D-1767: seeded per-agent auth.json from "${src}" (first-run cutover).\n`,
      );
      return;
    } catch {
      // Non-fatal -- fall through to next candidate.
    }
  }
  // No source found; Codex will handle missing auth on its own.
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
        // D-1767 (S4) per-agent path: copy (never symlink) auth.json, seeding
        // from the legacy company home on first run for cutover safety — gated
        // to the PAPERCLIP_CODEX_SEED_SHARED_AGENT_IDS allowlist inside.
        await seedPerAgentAuthJson(targetHome, companyId, options.agentId, env, onLog);
      } else {
        // Pre-S4 legacy path: symlink auth.json to the shared home (companyId
        // present but no agentId).  Keeps old behaviour for any caller that has
        // not yet been updated.
        for (const name of COPIED_PER_AGENT_FILES) {
          const source = path.join(sourceHome, name);
          if (!(await pathExists(source))) continue;
          await ensureSymlink(path.join(targetHome, name), source);
        }
      }
    }

    for (const name of COPIED_SHARED_FILES) {
      const source = path.join(sourceHome, name);
      if (!(await pathExists(source))) continue;
      await ensureCopiedFile(path.join(targetHome, name), source);
    }

    await onLog(
      "stdout",
      `[paperclip] Using ${isWorktreeMode(env) ? "worktree-isolated" : "Paperclip-managed"} Codex home "${targetHome}" (seeded from "${sourceHome}").\n`,
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
