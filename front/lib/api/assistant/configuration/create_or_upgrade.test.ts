import { createOrUpgradeAgentConfiguration } from "@app/lib/api/assistant/configuration/create_or_upgrade";
import { createResourceTest } from "@app/tests/utils/generic_resource_tests";
import type { PostOrPatchAgentConfigurationRequestBody } from "@app/types/api/agent_configuration";
import { AUTO_MODEL_CONFIG } from "@app/types/assistant/models/auto";
import { GEMINI_3_7_FLASH_MODEL_CONFIG } from "@app/types/assistant/models/google_ai_studio";
import { GPT_5_5_MODEL_CONFIG } from "@app/types/assistant/models/openai";
import type { ModelConfigurationType } from "@app/types/assistant/models/types";
import { afterEach, describe, expect, it, vi } from "vitest";

function makeAssistant(
  model: ModelConfigurationType,
  editorId: string
): PostOrPatchAgentConfigurationRequestBody["assistant"] {
  return {
    name: "ModelLockAgent",
    description: "Agent saved by the model lock tests",
    instructions: "Answer briefly.",
    pictureUrl: "https://dust.tt/static/systemavatar/test_avatar_1.png",
    status: "active",
    scope: "visible",
    model: {
      providerId: model.providerId,
      modelId: model.modelId,
      temperature: 0.7,
      reasoningEffort: model.defaultReasoningEffort,
    },
    actions: [],
    tags: [],
    editors: [{ sId: editorId }],
  };
}

// The POC mode is cached once read as "1", so the lock-off case runs first.
describe("createOrUpgradeAgentConfiguration model lock", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("saves an agent on any supported model outside the isolated POC", async () => {
    const { authenticator, user } = await createResourceTest({
      role: "admin",
    });

    const result = await createOrUpgradeAgentConfiguration({
      auth: authenticator,
      assistant: makeAssistant(GPT_5_5_MODEL_CONFIG, user.sId),
    });

    if (result.isErr()) {
      throw result.error;
    }
    expect(result.value.model.modelId).toBe(GPT_5_5_MODEL_CONFIG.modelId);
  });

  it.each([
    GPT_5_5_MODEL_CONFIG,
    AUTO_MODEL_CONFIG,
  ])("rejects an agent on $displayName in the isolated POC", async (model) => {
    vi.stubEnv("DUST_POC_MODE", "1");
    const { authenticator, user } = await createResourceTest({
      role: "admin",
    });

    const result = await createOrUpgradeAgentConfiguration({
      auth: authenticator,
      assistant: makeAssistant(model, user.sId),
    });

    if (result.isOk()) {
      throw new Error(`Saved an agent on ${model.displayName}`);
    }
    expect(result.error.message).toBe(
      `Model "${model.displayName}" is not available in this deployment. ` +
        `Use ${GEMINI_3_7_FLASH_MODEL_CONFIG.displayName}.`
    );
  });

  it("saves an agent on Gemini 3.7 Flash in the isolated POC", async () => {
    vi.stubEnv("DUST_POC_MODE", "1");
    const { authenticator, user } = await createResourceTest({
      role: "admin",
    });

    const result = await createOrUpgradeAgentConfiguration({
      auth: authenticator,
      assistant: makeAssistant(GEMINI_3_7_FLASH_MODEL_CONFIG, user.sId),
    });

    if (result.isErr()) {
      throw result.error;
    }
    expect(result.value.model).toMatchObject({
      providerId: GEMINI_3_7_FLASH_MODEL_CONFIG.providerId,
      modelId: GEMINI_3_7_FLASH_MODEL_CONFIG.modelId,
    });
  });

  it("rejects Gemini 3.7 Flash where the workspace cannot run it", async () => {
    vi.stubEnv("DUST_POC_MODE", "1");
    // A free plan excludes large models such as Gemini 3.7 Flash.
    const { authenticator, user } = await createResourceTest({
      role: "admin",
      plan: "freeNoProductAccess",
    });

    const result = await createOrUpgradeAgentConfiguration({
      auth: authenticator,
      assistant: makeAssistant(GEMINI_3_7_FLASH_MODEL_CONFIG, user.sId),
    });

    if (result.isOk()) {
      throw new Error("Saved an agent the workspace cannot run");
    }
    expect(result.error.message).toBe(
      `${GEMINI_3_7_FLASH_MODEL_CONFIG.displayName} is not available in this workspace.`
    );
  });
});
