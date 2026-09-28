import { resolveModel } from "@app/lib/api/assistant/resolve_model";
import type { Authenticator } from "@app/lib/auth";
import { AgentConfigurationFactory } from "@app/tests/utils/AgentConfigurationFactory";
import { createResourceTest } from "@app/tests/utils/generic_resource_tests";
import type { AgentConfigurationType } from "@app/types/assistant/agent";
import { GEMINI_3_7_FLASH_MODEL_CONFIG } from "@app/types/assistant/models/google_ai_studio";
import { NOOP_MODEL_CONFIG } from "@app/types/assistant/models/noop";
import { GPT_5_5_MODEL_CONFIG } from "@app/types/assistant/models/openai";
import type { ModelConfigurationType } from "@app/types/assistant/models/types";
import type { WhitelistableFeature } from "@app/types/shared/feature_flags";
import { afterEach, describe, expect, it, vi } from "vitest";

// Noop, which serves static replies without a provider, sits behind this flag.
const NOOP_FEATURE_FLAGS: WhitelistableFeature[] = ["noop_model_feature"];

async function agentOn(
  model: ModelConfigurationType
): Promise<{ auth: Authenticator; agent: AgentConfigurationType }> {
  const { authenticator } = await createResourceTest({ role: "admin" });
  const agent = await AgentConfigurationFactory.createTestAgent(authenticator, {
    name: `Agent on ${model.displayName}`,
    description: "Agent resolved by the model lock tests",
    model: { providerId: model.providerId, modelId: model.modelId },
  });
  return { auth: authenticator, agent };
}

// The POC mode is cached once read as "1", so the lock-off case runs first.
describe("resolveModel model lock", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("keeps a noop agent on noop outside the isolated POC", async () => {
    const { auth, agent } = await agentOn(NOOP_MODEL_CONFIG);

    const resolution = await resolveModel(auth, {
      configuration: agent,
      featureFlags: NOOP_FEATURE_FLAGS,
    });

    expect(resolution?.resolvedModel.modelId).toBe(NOOP_MODEL_CONFIG.modelId);
  });

  it("runs an agent saved on another model on Gemini 3.7 Flash in the isolated POC", async () => {
    vi.stubEnv("DUST_POC_MODE", "1");
    const { auth, agent } = await agentOn(GPT_5_5_MODEL_CONFIG);

    const resolution = await resolveModel(auth, {
      configuration: agent,
      featureFlags: NOOP_FEATURE_FLAGS,
    });

    expect(resolution?.resolvedModel).toEqual({
      providerId: GEMINI_3_7_FLASH_MODEL_CONFIG.providerId,
      modelId: GEMINI_3_7_FLASH_MODEL_CONFIG.modelId,
      reasoningEffort: GEMINI_3_7_FLASH_MODEL_CONFIG.defaultReasoningEffort,
    });
  });

  it("keeps a noop agent's static reply on noop in the isolated POC", async () => {
    vi.stubEnv("DUST_POC_MODE", "1");
    const { auth, agent } = await agentOn(NOOP_MODEL_CONFIG);

    const resolution = await resolveModel(auth, {
      configuration: agent,
      featureFlags: NOOP_FEATURE_FLAGS,
    });

    expect(resolution?.resolvedModel).toEqual({
      providerId: NOOP_MODEL_CONFIG.providerId,
      modelId: NOOP_MODEL_CONFIG.modelId,
      reasoningEffort: NOOP_MODEL_CONFIG.defaultReasoningEffort,
    });
  });

  it("falls back to Gemini 3.7 Flash, not another model, where noop is off in the isolated POC", async () => {
    vi.stubEnv("DUST_POC_MODE", "1");
    const { auth, agent } = await agentOn(NOOP_MODEL_CONFIG);

    const resolution = await resolveModel(auth, {
      configuration: agent,
      featureFlags: [],
    });

    expect(resolution?.resolvedModel).toMatchObject({
      providerId: GEMINI_3_7_FLASH_MODEL_CONFIG.providerId,
      modelId: GEMINI_3_7_FLASH_MODEL_CONFIG.modelId,
    });
  });

  it("resolves no model where the workspace cannot run Gemini 3.7 Flash in the isolated POC", async () => {
    vi.stubEnv("DUST_POC_MODE", "1");
    // A free plan excludes large models such as Gemini 3.7 Flash.
    const { authenticator: auth } = await createResourceTest({
      role: "admin",
      plan: "freeNoProductAccess",
    });
    const agent = await AgentConfigurationFactory.createTestAgent(auth, {
      name: "Agent on a free plan",
      description: "Agent resolved by the model lock tests",
      model: {
        providerId: GPT_5_5_MODEL_CONFIG.providerId,
        modelId: GPT_5_5_MODEL_CONFIG.modelId,
      },
    });

    const resolution = await resolveModel(auth, {
      configuration: agent,
      featureFlags: NOOP_FEATURE_FLAGS,
    });

    expect(resolution).toBeNull();
  });
});
