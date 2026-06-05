import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  prepareManagedCodexHome,
  resolveManagedCodexHomeDir,
  resolveSharedCodexHomeDir,
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
// D-1861 (S-1/S-2): no auth seeding — own auth.json only + loud missing-auth
// ---------------------------------------------------------------------------

describe("D-1861 S-1/S-2 — uniform provisioning, no seed, loud missing-auth", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "codex-home-d1861-test-"));
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it("S-1: never copies another home's auth.json into a fresh per-agent home", async () => {
    const env = makeTmpEnv(tmpDir);
    // Point the shared home at a dir holding a live token (e.g. Lidi's).
    const sharedHome = path.join(tmpDir, "shared-codex");
    env.CODEX_HOME = sharedHome;
    await fs.mkdir(sharedHome, { recursive: true });
    await fs.writeFile(
      path.join(sharedHome, "auth.json"),
      JSON.stringify({ refresh_token: "another-agents-live-token" }),
      { mode: 0o600 },
    );

    const targetHome = await prepareManagedCodexHome(env, noopLog, "company-x", {
      agentId: "agent-fresh",
    });

    // The fresh agent's home must NOT have copied the shared token.
    const seeded = await fs
      .access(path.join(targetHome, "auth.json"))
      .then(() => true)
      .catch(() => false);
    expect(seeded).toBe(false);

    // The shared token is untouched.
    const sharedAuth = await fs.readFile(path.join(sharedHome, "auth.json"), "utf8");
    expect(JSON.parse(sharedAuth)).toEqual({ refresh_token: "another-agents-live-token" });
  });

  it("S-2: emits a loud AUTH MISSING diagnostic when the per-agent home has no auth.json", async () => {
    const env = makeTmpEnv(tmpDir);
    env.CODEX_HOME = path.join(tmpDir, "shared-codex"); // distinct from the managed home
    const agentId = "agent-unprovisioned";
    const logs: string[] = [];

    const targetHome = await prepareManagedCodexHome(env, captureLog(logs), "company-x", {
      agentId,
    });

    expect(targetHome).toContain(agentId);
    expect(
      logs.some((l) => l.includes("AUTH MISSING") && l.includes(agentId)),
    ).toBe(true);
  });

  it("S-2: does NOT warn when the per-agent home already has its own auth.json", async () => {
    const env = makeTmpEnv(tmpDir);
    env.CODEX_HOME = path.join(tmpDir, "shared-codex");
    const companyId = "company-x";
    const agentId = "agent-provisioned";

    // Pre-provision the agent's OWN auth.json in its managed home.
    const managedHome = resolveManagedCodexHomeDir(env, companyId, agentId);
    await fs.mkdir(managedHome, { recursive: true });
    await fs.writeFile(
      path.join(managedHome, "auth.json"),
      JSON.stringify({ refresh_token: "agent-own-token" }),
      { mode: 0o600 },
    );

    const logs: string[] = [];
    await prepareManagedCodexHome(env, captureLog(logs), companyId, { agentId });

    // No AUTH MISSING warning, and the agent's own token is untouched.
    expect(logs.some((l) => l.includes("AUTH MISSING"))).toBe(false);
    const authContent = await fs.readFile(path.join(managedHome, "auth.json"), "utf8");
    expect(JSON.parse(authContent)).toEqual({ refresh_token: "agent-own-token" });
  });

  it("retired: PAPERCLIP_CODEX_SEED_SHARED_AGENT_IDS no longer seeds (allowlist is dead)", async () => {
    const env = makeTmpEnv(tmpDir);
    const sharedHome = path.join(tmpDir, "shared-codex");
    env.CODEX_HOME = sharedHome;
    const agentId = "agent-allowlisted";
    // Even if the (now-removed) allowlist names this agent, no seed occurs.
    env.PAPERCLIP_CODEX_SEED_SHARED_AGENT_IDS = agentId;
    await fs.mkdir(sharedHome, { recursive: true });
    await fs.writeFile(
      path.join(sharedHome, "auth.json"),
      JSON.stringify({ refresh_token: "shared-token" }),
      { mode: 0o600 },
    );

    const targetHome = await prepareManagedCodexHome(env, noopLog, "company-x", { agentId });

    const seeded = await fs
      .access(path.join(targetHome, "auth.json"))
      .then(() => true)
      .catch(() => false);
    expect(seeded).toBe(false);
  });
});

// Reference resolveSharedCodexHomeDir so the import is used even if the suite
// above is trimmed; documents that the shared home is read-only (seed source
// retired — D-1861 S-1).
describe("D-1861 — shared home is never a write target", () => {
  it("resolveSharedCodexHomeDir honours CODEX_HOME", () => {
    expect(resolveSharedCodexHomeDir({ CODEX_HOME: "/x/y" })).toBe(path.resolve("/x/y"));
  });
});
