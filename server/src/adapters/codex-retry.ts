// D-1853: bounded inline retry for a transient missing-bearer 401 on the codex
// Responses-API call. This happens when codex spawns in a window with no auth
// attached — e.g. a Paperclip redeploy landing mid-run — while the credential is
// otherwise healthy. The upstream codex adapter classifies KNOWN transient errors
// as `transient_upstream` (the heartbeat scheduler retries those via
// `retryNotBefore`); the missing-bearer 401 is NOT in that taxonomy, so it lands
// as a hard adapter failure and strands the agent in status:error (D-1853 incident:
// 5 issues stranded in_review on Lidi after a redeploy mid-review). We retry ONLY
// this signature, bounded, so a genuine auth death (truly revoked credential) still
// surfaces after the attempts — a few retries cannot fix a real revocation.

export const CODEX_TRANSIENT_401 = /\b401\b|missing bearer or basic authentication/i;

/** Minimal structural shape of a codex execute result (fields used by the detector). */
export interface CodexExecuteResultLike {
  exitCode: number | null;
  errorFamily?: string | null;
  errorMessage?: string | null;
  resultJson?: unknown;
}

/**
 * True when `result` is a transient missing-bearer 401 worth an inline retry.
 * Excludes success (exitCode 0) and results already classified `transient_upstream`
 * (the scheduler owns those). Matches the 401 / missing-bearer signature in either
 * `errorMessage` or the serialized `resultJson`.
 */
export function isCodexTransient401(result: CodexExecuteResultLike): boolean {
  if (result.exitCode === 0) return false;
  if (result.errorFamily === "transient_upstream") return false;
  return CODEX_TRANSIENT_401.test(`${result.errorMessage ?? ""} ${JSON.stringify(result.resultJson ?? {})}`);
}

/** Backoff (ms) before the Nth inline retry attempt (1-indexed). */
export const codexRetryBackoffMs = (attempt: number): number => attempt * 2000;

export const CODEX_MAX_ATTEMPTS = 3;
