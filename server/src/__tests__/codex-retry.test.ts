import { describe, it, expect } from "vitest";
import { isCodexTransient401, codexRetryBackoffMs, CODEX_MAX_ATTEMPTS } from "../adapters/codex-retry.js";

describe("isCodexTransient401 (D-1853)", () => {
  it("flags a missing-bearer 401 in errorMessage", () => {
    expect(
      isCodexTransient401({
        exitCode: 1,
        errorMessage:
          "unexpected status 401 Unauthorized: Missing bearer or basic authentication in header, url: https://api.openai.com/v1/responses",
      }),
    ).toBe(true);
  });

  it("flags a 401 surfaced only via resultJson", () => {
    expect(isCodexTransient401({ exitCode: 1, resultJson: { error: "401 Unauthorized" } })).toBe(true);
  });

  it("does NOT flag a success result (exitCode 0)", () => {
    expect(
      isCodexTransient401({ exitCode: 0, errorMessage: "Missing bearer or basic authentication" }),
    ).toBe(false);
  });

  it("does NOT flag an already-classified transient_upstream error (scheduler owns those)", () => {
    expect(
      isCodexTransient401({ exitCode: 1, errorFamily: "transient_upstream", errorMessage: "high demand" }),
    ).toBe(false);
  });

  it("does NOT flag a non-401 hard failure", () => {
    expect(isCodexTransient401({ exitCode: 1, errorMessage: "ENOENT: codex binary not found" })).toBe(false);
  });

  it("does NOT match a bare '401' substring inside an unrelated number", () => {
    // word-boundary guard: 1401 / 4012 should not trip the \b401\b alternation
    expect(isCodexTransient401({ exitCode: 1, errorMessage: "processed 14012 tokens" })).toBe(false);
  });

  it("bounds: backoff grows per attempt; max attempts is 3", () => {
    expect(codexRetryBackoffMs(1)).toBe(2000);
    expect(codexRetryBackoffMs(2)).toBe(4000);
    expect(CODEX_MAX_ATTEMPTS).toBe(3);
  });
});
