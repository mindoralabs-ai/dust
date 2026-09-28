import type { AgentBuilderFormData } from "@app/components/agent_builder/AgentBuilderFormContext";
import {
  getDefaultAgentFormData,
  withPocDefaultModel,
} from "@app/components/agent_builder/transformAgentConfiguration";
import { UserFactory } from "@app/tests/utils/UserFactory";
import { GEMINI_3_7_FLASH_MODEL_CONFIG } from "@app/types/assistant/models/google_ai_studio";
import { GPT_5_5_MODEL_CONFIG } from "@app/types/assistant/models/openai";
import type { ReasoningEffort } from "@app/types/assistant/models/types";
import { describe, expect, it } from "vitest";

const LOCKED_DEFAULT = { ...GEMINI_3_7_FLASH_MODEL_CONFIG, isSelectable: true };

async function formSeededOnGpt(
  reasoningEffort: ReasoningEffort
): Promise<AgentBuilderFormData> {
  const user = await UserFactory.basic();
  const formData = getDefaultAgentFormData({
    user: user.toJSON(),
    defaultModel: { ...GPT_5_5_MODEL_CONFIG, isSelectable: true },
  });
  return {
    ...formData,
    generationSettings: { ...formData.generationSettings, reasoningEffort },
  };
}

describe("withPocDefaultModel", () => {
  it("moves a form seeded on another model to the default, keeping an effort it supports", async () => {
    const formData = await formSeededOnGpt("medium");

    const normalized = withPocDefaultModel(formData, LOCKED_DEFAULT);

    expect(normalized.generationSettings).toMatchObject({
      modelSettings: {
        providerId: GEMINI_3_7_FLASH_MODEL_CONFIG.providerId,
        modelId: GEMINI_3_7_FLASH_MODEL_CONFIG.modelId,
      },
      reasoningEffort: "medium",
    });
    expect(normalized.instructions).toBe(formData.instructions);
  });

  it("takes the default's effort where it does not support the seeded one", async () => {
    // Gemini 3.7 Flash has no `none` effort.
    const formData = await formSeededOnGpt("none");

    const normalized = withPocDefaultModel(formData, LOCKED_DEFAULT);

    expect(normalized.generationSettings.reasoningEffort).toBe(
      GEMINI_3_7_FLASH_MODEL_CONFIG.defaultReasoningEffort
    );
  });

  it("leaves a form already on the default model unchanged", async () => {
    const user = await UserFactory.basic();
    const formData = getDefaultAgentFormData({
      user: user.toJSON(),
      defaultModel: LOCKED_DEFAULT,
    });

    expect(withPocDefaultModel(formData, LOCKED_DEFAULT)).toBe(formData);
  });
});
