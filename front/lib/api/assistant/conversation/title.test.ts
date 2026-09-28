import { runMultiActionsAgent } from "@app/lib/api/assistant/call_llm";
import { ensureConversationTitle } from "@app/lib/api/assistant/conversation/title";
import { AgentConfigurationFactory } from "@app/tests/utils/AgentConfigurationFactory";
import { ConversationFactory } from "@app/tests/utils/ConversationFactory";
import { createResourceTest } from "@app/tests/utils/generic_resource_tests";
import { GEMINI_3_7_FLASH_MODEL_CONFIG } from "@app/types/assistant/models/google_ai_studio";
import { GPT_5_1_MODEL_CONFIG } from "@app/types/assistant/models/openai";
import { Ok } from "@app/types/shared/result";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@app/lib/api/assistant/call_llm", () => ({
  runMultiActionsAgent: vi.fn(),
}));

async function generateTitle() {
  const { authenticator } = await createResourceTest({ role: "admin" });
  const agent = await AgentConfigurationFactory.createTestAgent(authenticator);
  const conversation = await ConversationFactory.create(authenticator, {
    agentConfigurationId: agent.sId,
    messagesCreatedAt: [new Date()],
  });
  vi.mocked(runMultiActionsAgent).mockResolvedValueOnce(
    new Ok({
      actions: [
        { name: "update_title", arguments: { conversation_title: "Lock" } },
      ],
    })
  );

  const title = await ensureConversationTitle(authenticator, {
    conversation: { ...conversation, title: null },
  });

  return { title, llmCalls: vi.mocked(runMultiActionsAgent).mock.calls };
}

// The POC mode is cached once read as "1", so the lock-off case runs first.
describe("ensureConversationTitle model", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("titles with the fast model of the first whitelisted provider", async () => {
    const { title, llmCalls } = await generateTitle();

    expect(title).toBe("Lock");
    expect(llmCalls).toHaveLength(1);
    expect(llmCalls[0][1]).toMatchObject({
      providerId: GPT_5_1_MODEL_CONFIG.providerId,
      modelId: GPT_5_1_MODEL_CONFIG.modelId,
    });
  });

  it("titles with Gemini 3.7 Flash in the isolated POC", async () => {
    vi.stubEnv("DUST_POC_MODE", "1");

    const { title, llmCalls } = await generateTitle();

    expect(title).toBe("Lock");
    expect(llmCalls).toHaveLength(1);
    expect(llmCalls[0][1]).toMatchObject({
      providerId: GEMINI_3_7_FLASH_MODEL_CONFIG.providerId,
      modelId: GEMINI_3_7_FLASH_MODEL_CONFIG.modelId,
    });
  });
});
