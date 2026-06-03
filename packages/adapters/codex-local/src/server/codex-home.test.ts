import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  prepareManagedCodexHome,
  resolveManagedCodexHomeDir,
  resolveLegacyCompanyCodexHomeDir,
} from "./codex-home.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeTmpEnv(tmpDir: string): NodeJS.ProcessEnv {
  return {
    PAPERCLIP_HOME: path.join(tmpDir, ".paperclip"),
    PAPERCLIP_INSTANCE_ID: "test",
  };
}

const noopLog: (stream: "stdout" | "stderr", chunk: string) => Promise<void> =
  async () => {};

const captureLog = (lines: string[]): typeof noopLog =>
  async (_stream, chunk) => void lines.push(chunk);

// ---------------------------------------------------------------------------
// Task 1 (D-1767 S4): resolveManagedCodexHomeDir keyed on agentId
// ---------------------------------------------------------------------------

describe("D-1767 S4 — resolveManagedCodexHomeDir", () => {
  it("returns distinct dirs for two agents in the same company", () => {
    const env = makeTmpEnv("/fake");
    const companyId = "company-abc";
    const dir1 = resolveManagedCodexHomeDir(env, companyId, "agent-1");
    const dir2 = resolveManagedCodexHomeDir(env, companyId, "agent-2");
    expect(dir1).not.toBe(dir2);
    expect(dir1).toContain("agent-1");
    expect(dir2).toContain("agent-2");
  });

  it("contains companyId and agentId in the path", () => {
    const env = makeTmpEnv("/fake");
    const dir = resolveManagedCodexHomeDir(env, "company-abc", "agent-xyz");
    expect(dir).toContain("company-abc");
    expect(dir).toContain("agent-xyz");
  });

  it("falls back to legacy company-keyed path when agentId is absent", () => {
    const env = makeTmpEnv("/fake");
    const perAgent = resolveManagedCodexHomeDir(env, "company-abc", "agent-xyz");
    const legacy = resolveManagedCodexHomeDir(env, "company-abc");
    expect(legacy).not.toContain("agent-xyz");
    expect(perAgent).not.toBe(legacy);
  });
});

// ---------------------------------------------------------------------------
// Task 2: manual env CODEX_HOME override still wins
// ---------------------------------------------------------------------------

describe("D-1767 S4 — manual CODEX_HOME override wins", () => {
  let tmpDir: string;
  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "codex-home-test-"));
  });
  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it("resolveManagedCodexHomeDir respects CODEX_HOME env (resolveSharedCodexHomeDir parity)", async () => {
    // The manual override is handled in execute.ts (configuredCodexHome check),
    // not inside resolveManagedCodexHomeDir.  This test verifies the path
    // returned without an override is NOT the shared CODEX_HOME path, so the
    // override in execute.ts is meaningful.
    const overridePath = path.join(tmpDir, "my-override");
    const envWithOverride: NodeJS.ProcessEnv = {
      CODEX_HOME: overridePath,
      PAPERCLIP_HOME: path.join(tmpDir, ".paperclip"),
      PAPERCLIP_INSTANCE_ID: "test",
    };
    const managedDir = resolveManagedCodexHomeDir(envWithOverride, "cid", "aid");
    // The managed dir must NOT equal the shared dir (the override wins in execute.ts,
    // and resolveManagedCodexHomeDir doesn't consume CODEX_HOME itself).
    expect(path.resolve(managedDir)).not.toBe(path.resolve(overridePath));
  });
});

// ---------------------------------------------------------------------------
// Task 3: first-run seed from legacy company home
// ---------------------------------------------------------------------------

describe("D-1767 S4 — first-run seed from legacy company home", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "codex-home-seed-test-"));
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it("seeds auth.json from legacy company home into a fresh per-agent home", async () => {
    const env = makeTmpEnv(tmpDir);
    const companyId = "company-seed-test";
    const agentId = "agent-seed-test";
    // D-1767 (S4): seeding is gated to the allowlist — list this agent.
    env.PAPERCLIP_CODEX_SEED_SHARED_AGENT_IDS = agentId;

    // Write auth.json into the legacy company home (the pre-S4 shared path).
    const legacyHome = resolveLegacyCompanyCodexHomeDir(env, companyId);
    await fs.mkdir(legacyHome, { recursive: true });
    await fs.writeFile(
      path.join(legacyHome, "auth.json"),
      JSON.stringify({ refresh_token: "legacy-token" }),
      { mode: 0o600 },
    );

    const logs: string[] = [];
    const targetHome = await prepareManagedCodexHome(env, captureLog(logs), companyId, {
      agentId,
    });

    // The returned home must be the per-agent path.
    expect(targetHome).toContain(agentId);

    // auth.json must have been copied into the per-agent home.
    const authContent = await fs.readFile(path.join(targetHome, "auth.json"), "utf8");
    expect(JSON.parse(authContent)).toEqual({ refresh_token: "legacy-token" });

    // The legacy home's auth.json must still exist (copy-from, never move-from).
    const legacyAuthExists = await fs
      .access(path.join(legacyHome, "auth.json"))
      .then(() => true)
      .catch(() => false);
    expect(legacyAuthExists).toBe(true);

    // A cutover log line must have been emitted.
    expect(logs.some((l) => l.includes("D-1767") && l.includes("seeded"))).toBe(true);
  });

  it("does NOT overwrite an existing auth.json in the per-agent home on second run", async () => {
    const env = makeTmpEnv(tmpDir);
    const companyId = "company-idempotent";
    const agentId = "agent-idempotent";
    // D-1767 (S4): seeding is gated to the allowlist — list this agent.
    env.PAPERCLIP_CODEX_SEED_SHARED_AGENT_IDS = agentId;

    // Legacy home with one token.
    const legacyHome = resolveLegacyCompanyCodexHomeDir(env, companyId);
    await fs.mkdir(legacyHome, { recursive: true });
    await fs.writeFile(
      path.join(legacyHome, "auth.json"),
      JSON.stringify({ refresh_token: "legacy-token" }),
      { mode: 0o600 },
    );

    // First run: seeds.
    const targetHome = await prepareManagedCodexHome(env, noopLog, companyId, { agentId });

    // Simulate agent rotating its own token between runs.
    await fs.writeFile(
      path.join(targetHome, "auth.json"),
      JSON.stringify({ refresh_token: "agent-own-token" }),
      { mode: 0o600 },
    );

    // Second run: must NOT overwrite.
    await prepareManagedCodexHome(env, noopLog, companyId, { agentId });

    const authContent = await fs.readFile(path.join(targetHome, "auth.json"), "utf8");
    expect(JSON.parse(authContent)).toEqual({ refresh_token: "agent-own-token" });
  });

  it("does NOT seed from the shared home when the agent is not allowlisted (cutover footgun guard)", async () => {
    const env = makeTmpEnv(tmpDir);
    const companyId = "company-not-allowed";
    const agentId = "agent-not-allowed";
    // Intentionally NOT in PAPERCLIP_CODEX_SEED_SHARED_AGENT_IDS.
    env.PAPERCLIP_CODEX_SEED_SHARED_AGENT_IDS = "some-other-agent";

    // A live token sits in the legacy company home (e.g. Lidi's shared token).
    const legacyHome = resolveLegacyCompanyCodexHomeDir(env, companyId);
    await fs.mkdir(legacyHome, { recursive: true });
    await fs.writeFile(
      path.join(legacyHome, "auth.json"),
      JSON.stringify({ refresh_token: "another-agents-live-token" }),
      { mode: 0o600 },
    );

    const targetHome = await prepareManagedCodexHome(env, noopLog, companyId, { agentId });

    // The new agent's home must NOT have copied the other agent's live token.
    const seeded = await fs
      .access(path.join(targetHome, "auth.json"))
      .then(() => true)
      .catch(() => false);
    expect(seeded).toBe(false);

    // The legacy token is untouched.
    const legacyAuth = await fs.readFile(path.join(legacyHome, "auth.json"), "utf8");
    expect(JSON.parse(legacyAuth)).toEqual({ refresh_token: "another-agents-live-token" });
  });
});
