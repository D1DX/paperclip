import { describe, expect, it } from "vitest";
import type { AdapterModelProfileDefinition } from "../adapters/index.js";
import {
  mergeModelProfileAdapterConfig,
  normalizeModelProfileWakeContext,
  resolveModelProfileApplication,
} from "../services/heartbeat.ts";

const cheapProfile: AdapterModelProfileDefinition = {
  key: "cheap",
  label: "Cheap",
  adapterConfig: {
    model: "adapter-cheap",
    modelReasoningEffort: "low",
  },
  source: "adapter_default",
};

describe("heartbeat model profile application", () => {
  it("applies cheap profile patches before explicit issue adapter config overrides", () => {
    const modelProfile = resolveModelProfileApplication({
      adapterModelProfiles: [cheapProfile],
      agentRuntimeConfig: {},
      issueModelProfile: "cheap",
      contextSnapshot: {},
    });

    const merged = mergeModelProfileAdapterConfig({
      baseConfig: {
        model: "primary",
        modelReasoningEffort: "high",
        approvalPolicy: "strict",
      },
      modelProfile,
      issueAdapterConfig: {
        model: "issue-explicit",
      },
    });

    expect(modelProfile).toMatchObject({
      requested: "cheap",
      requestedBy: "issue_override",
      applied: "cheap",
      configSource: "adapter_default",
      fallbackReason: null,
    });
    expect(merged).toEqual({
      model: "issue-explicit",
      modelReasoningEffort: "low",
      approvalPolicy: "strict",
    });
  });

  it("lets agent runtime profile config customize adapter defaults", () => {
    const modelProfile = resolveModelProfileApplication({
      adapterModelProfiles: [cheapProfile],
      agentRuntimeConfig: {
        modelProfiles: {
          cheap: {
            adapterConfig: {
              model: "agent-cheap",
            },
          },
        },
      },
      issueModelProfile: null,
      contextSnapshot: { modelProfile: "cheap" },
    });

    expect(modelProfile).toMatchObject({
      requested: "cheap",
      requestedBy: "wake_context",
      applied: "cheap",
      configSource: "agent_runtime",
      adapterConfig: {
        model: "agent-cheap",
        modelReasoningEffort: "low",
      },
    });
  });

  it("falls back to the primary config when the adapter does not support the requested profile", () => {
    const modelProfile = resolveModelProfileApplication({
      adapterModelProfiles: [],
      agentRuntimeConfig: {
        modelProfiles: {
          cheap: {
            adapterConfig: {
              model: "agent-cheap",
            },
          },
        },
      },
      issueModelProfile: null,
      contextSnapshot: { modelProfile: "cheap" },
    });

    const merged = mergeModelProfileAdapterConfig({
      baseConfig: {
        model: "primary",
      },
      modelProfile,
      issueAdapterConfig: null,
    });

    expect(modelProfile).toMatchObject({
      requested: "cheap",
      applied: null,
      fallbackReason: "adapter_profile_not_supported",
      adapterConfig: null,
    });
    expect(merged).toEqual({ model: "primary" });
  });

  it("normalizes a wake payload model profile into run context", () => {
    const contextSnapshot = normalizeModelProfileWakeContext({
      contextSnapshot: {},
      payload: { modelProfile: "cheap" },
    });

    expect(contextSnapshot).toMatchObject({ modelProfile: "cheap" });
  });
});

describe("D-1839 recovery cheap-profile model inheritance (codex_local)", () => {
  const codexCheapProfile: AdapterModelProfileDefinition = {
    key: "cheap",
    label: "Cheap",
    adapterConfig: { model: "gpt-5.3-codex-spark", modelReasoningEffort: "low" },
    source: "adapter_default",
  };

  it("inherits the agent's configured model when a recovery wake requests the adapter-default cheap profile on codex_local", () => {
    const modelProfile = resolveModelProfileApplication({
      adapterModelProfiles: [codexCheapProfile],
      agentRuntimeConfig: {},
      issueModelProfile: null,
      contextSnapshot: { modelProfile: "cheap" },
      adapterType: "codex_local",
    });

    expect(modelProfile).toMatchObject({
      requested: "cheap",
      requestedBy: "wake_context",
      applied: null,
      configSource: null,
      fallbackReason: "recovery_profile_inherits_agent_model",
      adapterConfig: null,
    });

    // The merge must leave the agent's own model untouched (no spark override).
    const merged = mergeModelProfileAdapterConfig({
      baseConfig: { model: "gpt-5.5" },
      modelProfile,
      issueAdapterConfig: null,
    });
    expect(merged).toEqual({ model: "gpt-5.5" });
  });

  it("still applies an explicit issue_override cheap profile on codex_local (operator choice preserved)", () => {
    const modelProfile = resolveModelProfileApplication({
      adapterModelProfiles: [codexCheapProfile],
      agentRuntimeConfig: {},
      issueModelProfile: "cheap",
      contextSnapshot: {},
      adapterType: "codex_local",
    });

    expect(modelProfile).toMatchObject({
      requested: "cheap",
      requestedBy: "issue_override",
      applied: "cheap",
      configSource: "adapter_default",
    });
    expect(modelProfile.adapterConfig).toMatchObject({ model: "gpt-5.3-codex-spark" });
  });

  it("still applies an agent-configured cheap profile on a codex_local recovery wake (agent_runtime preserved)", () => {
    const modelProfile = resolveModelProfileApplication({
      adapterModelProfiles: [codexCheapProfile],
      agentRuntimeConfig: { modelProfiles: { cheap: { adapterConfig: { model: "gpt-5.4" } } } },
      issueModelProfile: null,
      contextSnapshot: { modelProfile: "cheap" },
      adapterType: "codex_local",
    });

    expect(modelProfile).toMatchObject({
      requested: "cheap",
      requestedBy: "wake_context",
      applied: "cheap",
      configSource: "agent_runtime",
    });
    expect(modelProfile.adapterConfig).toMatchObject({ model: "gpt-5.4" });
  });

  it("does not suppress the cheap lane for non-codex_local adapters on a recovery wake", () => {
    const modelProfile = resolveModelProfileApplication({
      adapterModelProfiles: [cheapProfile],
      agentRuntimeConfig: {},
      issueModelProfile: null,
      contextSnapshot: { modelProfile: "cheap" },
      adapterType: "claude_code",
    });

    expect(modelProfile).toMatchObject({
      requested: "cheap",
      requestedBy: "wake_context",
      applied: "cheap",
      configSource: "adapter_default",
    });
    expect(modelProfile.adapterConfig).toMatchObject({ model: "adapter-cheap" });
  });
});
