import {
  editUserMessage,
  postUserMessage,
} from "@app/lib/api/assistant/conversation";
import type { Authenticator } from "@app/lib/auth";
import { ConversationResource } from "@app/lib/resources/conversation_resource";
import { launchAgentLoopWorkflow } from "@app/temporal/agent_loop/client";
import { AgentConfigurationFactory } from "@app/tests/utils/AgentConfigurationFactory";
import { ConversationFactory } from "@app/tests/utils/ConversationFactory";
import { createResourceTest } from "@app/tests/utils/generic_resource_tests";
import type { LightAgentConfigurationType } from "@app/types/assistant/agent";
import type { UserMessageContext } from "@app/types/assistant/conversation";
import { GEMINI_3_7_FLASH_MODEL_CONFIG } from "@app/types/assistant/models/google_ai_studio";
import { GPT_5_5_MODEL_CONFIG } from "@app/types/assistant/models/openai";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@app/temporal/agent_loop/client", () => ({
  launchAgentLoopWorkflow: vi.fn(),
  launchCompactionWorkflow: vi.fn(),
}));

vi.mock("@app/lib/api/assistant/streaming/events", () => ({
  publishAgentMessagesEvents: vi.fn(),
  publishConversationEvent: vi.fn(),
  publishMessageEventsOnMessagePostOrEdit: vi.fn(),
}));

vi.mock("@app/lib/api/assistant/pubsub", () => ({
  gracefullyStopAgentLoop: vi.fn(),
}));

const LOCKED_MODEL = {
  providerId: GEMINI_3_7_FLASH_MODEL_CONFIG.providerId,
  modelId: GEMINI_3_7_FLASH_MODEL_CONFIG.modelId,
};

function webContext(auth: Authenticator): UserMessageContext {
  const user = auth.getNonNullableUser().toJSON();
  return {
    username: user.username,
    timezone: "UTC",
    fullName: user.fullName,
    email: user.email,
    profilePictureUrl: user.image,
    origin: "web",
  };
}

// An agent saved on another provider before the lock was turned on still runs,
// on the locked model, through both message preflights.
describe("message preflights under the POC model lock", () => {
  let auth: Authenticator;
  let agent: LightAgentConfigurationType;
  let conversationResource: ConversationResource;

  beforeEach(async () => {
    vi.stubEnv("DUST_POC_MODE", "1");
    ({ authenticator: auth } = await createResourceTest({ role: "admin" }));
    agent = await AgentConfigurationFactory.createTestAgent(auth, {
      name: "Agent saved on GPT",
      description: "Agent saved before the POC model lock",
      model: {
        providerId: GPT_5_5_MODEL_CONFIG.providerId,
        modelId: GPT_5_5_MODEL_CONFIG.modelId,
      },
    });
    const conversation = await ConversationFactory.create(auth, {
      agentConfigurationId: agent.sId,
      messagesCreatedAt: [],
      visibility: "unlisted",
    });
    const resource = await ConversationResource.fetchById(
      auth,
      conversation.sId
    );
    if (!resource) {
      throw new Error("Failed to fetch the conversation");
    }
    conversationResource = resource;
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("posts a message to the agent, which runs Gemini 3.7 Flash", async () => {
    const result = await postUserMessage(auth, {
      conversationResource,
      content: `Hello @${agent.name}`,
      mentions: [{ configurationId: agent.sId }],
      context: webContext(auth),
      skipToolsValidation: false,
      skipDustAutoMention: true,
    });

    if (result.isErr()) {
      throw new Error(result.error.api_error.message);
    }
    expect(
      result.value.agentMessages.map((message) => message.resolvedModel)
    ).toMatchObject([LOCKED_MODEL]);
    expect(launchAgentLoopWorkflow).toHaveBeenCalledTimes(1);
  });

  it("edits a message to mention the agent, which runs Gemini 3.7 Flash", async () => {
    const posted = await postUserMessage(auth, {
      conversationResource,
      content: "A message without mentions",
      mentions: [],
      context: webContext(auth),
      skipToolsValidation: false,
      skipDustAutoMention: true,
    });
    if (posted.isErr()) {
      throw new Error(posted.error.api_error.message);
    }

    const result = await editUserMessage(auth, {
      conversationResource,
      message: posted.value.userMessage,
      content: `Hello @${agent.name}`,
      mentions: [{ configurationId: agent.sId }],
      skipToolsValidation: false,
    });

    if (result.isErr()) {
      throw new Error(result.error.api_error.message);
    }
    expect(
      result.value.agentMessages.map((message) => message.resolvedModel)
    ).toMatchObject([LOCKED_MODEL]);
  });
});
