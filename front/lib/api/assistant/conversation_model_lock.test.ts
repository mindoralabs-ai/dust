import {
  editUserMessage,
  getPocUnrunnableModelError,
  postUserMessage,
  retryAgentMessage,
} from "@app/lib/api/assistant/conversation";
import type { Authenticator } from "@app/lib/auth";
import { ConversationResource } from "@app/lib/resources/conversation_resource";
import { launchAgentLoopWorkflow } from "@app/temporal/agent_loop/client";
import { AgentConfigurationFactory } from "@app/tests/utils/AgentConfigurationFactory";
import { ConversationFactory } from "@app/tests/utils/ConversationFactory";
import { createResourceTest } from "@app/tests/utils/generic_resource_tests";
import type { LightAgentConfigurationType } from "@app/types/assistant/agent";
import type {
  AgentMessageType,
  UserMessageContext,
} from "@app/types/assistant/conversation";
import { GEMINI_3_7_FLASH_MODEL_CONFIG } from "@app/types/assistant/models/google_ai_studio";
import { NOOP_MODEL_CONFIG } from "@app/types/assistant/models/noop";
import {
  GPT_5_5_MODEL_CONFIG,
  GPT_5_MINI_MODEL_CONFIG,
} from "@app/types/assistant/models/openai";
import type { ModelConfigurationType } from "@app/types/assistant/models/types";
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

async function postPreLockReply(
  auth: Authenticator,
  model: ModelConfigurationType
): Promise<{
  conversationResource: ConversationResource;
  reply: AgentMessageType;
}> {
  const agent = await AgentConfigurationFactory.createTestAgent(auth, {
    name: `Agent answered on ${model.displayName}`,
    description: "Agent whose reply predates the POC model lock",
    model: { providerId: model.providerId, modelId: model.modelId },
  });
  const conversation = await ConversationFactory.create(auth, {
    agentConfigurationId: agent.sId,
    messagesCreatedAt: [],
    visibility: "unlisted",
  });
  const conversationResource = await ConversationResource.fetchById(
    auth,
    conversation.sId
  );
  if (!conversationResource) {
    throw new Error("Failed to fetch the conversation");
  }
  const posted = await postUserMessage(auth, {
    conversationResource,
    content: `Hello @${agent.name}`,
    mentions: [{ configurationId: agent.sId }],
    context: webContext(auth),
    skipToolsValidation: false,
    skipDustAutoMention: true,
  });
  if (posted.isErr()) {
    throw new Error(posted.error.api_error.message);
  }
  const [reply] = posted.value.agentMessages;
  expect(reply.resolvedModel).toMatchObject({ modelId: model.modelId });
  return { conversationResource, reply };
}

// The POC mode is cached once read as "1", so this case, whose replies are
// posted with the lock off, runs first.
describe("retrying a reply resolved before the POC model lock", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("retries it on Gemini 3.7 Flash, or refuses where the workspace cannot run that", async () => {
    const { authenticator: auth } = await createResourceTest({ role: "admin" });
    const runnable = await postPreLockReply(auth, GPT_5_5_MODEL_CONFIG);
    // A free plan runs small models such as GPT-5 mini, not Gemini 3.7 Flash.
    const { authenticator: freeAuth } = await createResourceTest({
      role: "admin",
      plan: "freeNoProductAccess",
    });
    const unrunnable = await postPreLockReply(
      freeAuth,
      GPT_5_MINI_MODEL_CONFIG
    );

    vi.stubEnv("DUST_POC_MODE", "1");
    const retried = await retryAgentMessage(auth, {
      conversationResource: runnable.conversationResource,
      message: runnable.reply,
    });
    const refused = await retryAgentMessage(freeAuth, {
      conversationResource: unrunnable.conversationResource,
      message: unrunnable.reply,
    });

    if (retried.isErr()) {
      throw new Error(retried.error.api_error.message);
    }
    expect(retried.value.resolvedModel).toMatchObject(LOCKED_MODEL);
    if (refused.isOk()) {
      throw new Error("Retried a reply the workspace cannot run");
    }
    expect(refused.error.api_error).toMatchObject({
      type: "invalid_request_error",
      message: "The model is not supported.",
    });

    // A reply already on Gemini 3.7 Flash is not reused once the workspace
    // cannot run it.
    const refusedReuse = await retryAgentMessage(freeAuth, {
      conversationResource: unrunnable.conversationResource,
      message: {
        ...unrunnable.reply,
        resolvedModel: {
          ...LOCKED_MODEL,
          reasoningEffort: GEMINI_3_7_FLASH_MODEL_CONFIG.defaultReasoningEffort,
        },
      },
    });
    expect(refusedReuse.isErr()).toBe(true);
  });
});

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

// Where the workspace cannot run the locked model, both preflights refuse the
// message rather than leaving resolveModel with no model to run.
describe("message preflights where the workspace cannot run the POC model", () => {
  let auth: Authenticator;
  let agent: LightAgentConfigurationType;
  let conversationResource: ConversationResource;

  beforeEach(async () => {
    vi.stubEnv("DUST_POC_MODE", "1");
    // A free plan excludes large models such as Gemini 3.7 Flash.
    ({ authenticator: auth } = await createResourceTest({
      role: "admin",
      plan: "freeNoProductAccess",
    }));
    agent = await AgentConfigurationFactory.createTestAgent(auth, {
      name: "Agent on a free plan",
      description: "Agent the workspace cannot run under the POC model lock",
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

  it("refuses a post mentioning the agent", async () => {
    const result = await postUserMessage(auth, {
      conversationResource,
      content: `Hello @${agent.name}`,
      mentions: [{ configurationId: agent.sId }],
      context: webContext(auth),
      skipToolsValidation: false,
      skipDustAutoMention: true,
    });

    if (result.isOk()) {
      throw new Error("Posted to an agent the workspace cannot run");
    }
    expect(result.error.api_error).toMatchObject({
      type: "invalid_request_error",
      message: "The model is not supported.",
    });
    expect(launchAgentLoopWorkflow).not.toHaveBeenCalled();
  });

  it("refuses an edit mentioning the agent", async () => {
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

    if (result.isOk()) {
      throw new Error("Edited a message to an agent the workspace cannot run");
    }
    expect(result.error.api_error).toMatchObject({
      type: "invalid_request_error",
      message: "The model is not supported.",
    });
    expect(launchAgentLoopWorkflow).not.toHaveBeenCalled();
  });
});

describe("getPocUnrunnableModelError", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("refuses only where resolveModel would find no model to run", async () => {
    vi.stubEnv("DUST_POC_MODE", "1");
    const { authenticator: auth } = await createResourceTest({ role: "admin" });
    // A free plan excludes large models such as Gemini 3.7 Flash.
    const { authenticator: freeAuth } = await createResourceTest({
      role: "admin",
      plan: "freeNoProductAccess",
    });
    const gpt = {
      providerId: GPT_5_5_MODEL_CONFIG.providerId,
      modelId: GPT_5_5_MODEL_CONFIG.modelId,
    };
    const noop = {
      providerId: NOOP_MODEL_CONFIG.providerId,
      modelId: NOOP_MODEL_CONFIG.modelId,
    };

    expect(await getPocUnrunnableModelError(auth, gpt)).toBeNull();
    // Noop is off in this workspace, so a noop agent falls back to Gemini.
    expect(await getPocUnrunnableModelError(auth, noop)).toBeNull();
    expect(await getPocUnrunnableModelError(freeAuth, gpt)).toMatchObject({
      status_code: 400,
    });
    expect(await getPocUnrunnableModelError(freeAuth, noop)).toMatchObject({
      status_code: 400,
    });
  });
});
