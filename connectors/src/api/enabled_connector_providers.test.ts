import { execFile } from "node:child_process";
import { createHmac } from "node:crypto";
import { once } from "node:events";
import { Server } from "node:http";
import net from "node:net";
import path from "node:path";
import { promisify } from "node:util";
import {
  ADMIN_COMMAND_TARGETS,
  checkAdminCommandProvidersEnabled,
} from "@connectors/api/admin";
import { checkConnectorProviderEnabled } from "@connectors/api/enabled_connector_providers";
import { isAppMentionMessage } from "@connectors/api/webhooks/slack/utils";
import { startServer } from "@connectors/api_server";
import { ConfluenceClient } from "@connectors/connectors/confluence/lib/confluence_client";
import * as confluenceUtils from "@connectors/connectors/confluence/lib/utils";
import { DustProjectConnectorManager } from "@connectors/connectors/dust_project";
import { launchGithubIssueSyncWorkflow } from "@connectors/connectors/github/temporal/client";
import type { BaseConnectorManager } from "@connectors/connectors/interface";
import { ConnectorManagerError } from "@connectors/connectors/interface";
import { processNotionWebhookEvent } from "@connectors/connectors/notion/lib/webhooks";
import { botReplaceMention } from "@connectors/connectors/slack/bot";
import { submitFeedbackToAPI } from "@connectors/connectors/slack/feedback_api";
import { getSlackClientForTeam } from "@connectors/connectors/slack/feedback_modal";
import { getSlackClient } from "@connectors/connectors/slack/lib/slack_client";
import { slackThreadInternalIdFromSlackThreadIdentifier } from "@connectors/connectors/slack/lib/utils";
import {
  launchJoinChannelWorkflow,
  launchSlackMigrateChannelsFromLegacyBotToNewBotWorkflow,
  launchSlackWebhookEventWorkflow,
} from "@connectors/connectors/slack/temporal/client";
import { processSlackWebhookEventActivity } from "@connectors/connectors/slack/temporal/webhook_activities";
import { SlackBotConnectorManager } from "@connectors/connectors/slack_bot";
import { WebcrawlerConnectorManager } from "@connectors/connectors/webcrawler";
import { launchFirecrawlCrawlStartedWorkflow } from "@connectors/connectors/webcrawler/temporal/client";
import * as zendeskAccessToken from "@connectors/connectors/zendesk/lib/zendesk_access_token";
import { runCommand } from "@connectors/lib/cli";
import * as dataSources from "@connectors/lib/data_sources";
import {
  PROVIDER_GROUPS,
  parseEnabledConnectorProviders,
} from "@connectors/lib/enabled_connector_providers";
import { ConfluenceConfigurationModel } from "@connectors/lib/models/confluence";
import {
  GithubCodeRepositoryModel,
  GithubConnectorStateModel,
} from "@connectors/lib/models/github";
import { GongTranscriptModel } from "@connectors/lib/models/gong";
import { GoogleDriveFilesModel } from "@connectors/lib/models/google_drive";
import { IntercomWorkspaceModel } from "@connectors/lib/models/intercom";
import { NotionConnectorStateModel } from "@connectors/lib/models/notion";
import {
  SlackBotWhitelistModel,
  SlackChannelModel,
  SlackConfigurationModel,
  SlackMessagesModel,
} from "@connectors/lib/models/slack";
import { WebCrawlerConfigurationModel } from "@connectors/lib/models/webcrawler";
import { ZendeskConfigurationModel } from "@connectors/lib/models/zendesk";
import { ConnectorResource } from "@connectors/resources/connector_resource";
import { SlackConfigurationResource } from "@connectors/resources/slack_configuration_resource";
import { ConnectorModel } from "@connectors/resources/storage/models/connector_model";
import type {
  AdminCommandType,
  ConnectorConfiguration,
} from "@connectors/types";
import * as connectorsTypes from "@connectors/types";
import { AdminCommandSchema } from "@connectors/types";
import type { ConnectorProvider } from "@dust-tt/client";
import { Err, Ok } from "@dust-tt/client";
import { WebClient } from "@slack/web-api";
import nacl from "tweetnacl";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";

const secrets = vi.hoisted(() => {
  const values = {
    api: "test-connectors-secret",
    webhooks: "test-webhooks-secret",
    github: "test-github-webhook-secret",
  };
  // The auth middleware reads these once, when it is imported.
  vi.stubEnv("DUST_CONNECTORS_SECRET", values.api);
  vi.stubEnv("DUST_CONNECTORS_WEBHOOKS_SECRET", values.webhooks);
  vi.stubEnv("GITHUB_WEBHOOK_SECRET", values.github);
  return values;
});

// Request logs would interleave with the test report.
vi.mock("morgan", () => ({
  default: () => (_req: unknown, _res: unknown, next: () => void) => next(),
}));

// The boundaries the routes reach once their guard lets a request through: Temporal workflows,
// the Slack and Dust APIs, and admin CLI commands.
vi.mock(import("@connectors/lib/cli"), async (importOriginal) => ({
  ...(await importOriginal()),
  runCommand: vi.fn(),
}));
vi.mock(
  import("@connectors/connectors/slack/temporal/client"),
  async (importOriginal) => ({
    ...(await importOriginal()),
    launchJoinChannelWorkflow: vi.fn(),
    launchSlackMigrateChannelsFromLegacyBotToNewBotWorkflow: vi.fn(),
    launchSlackWebhookEventWorkflow: vi.fn(),
  })
);
vi.mock(
  import("@connectors/connectors/slack/lib/slack_client"),
  async (importOriginal) => ({
    ...(await importOriginal()),
    getSlackClient: vi.fn(),
  })
);
// Not `importOriginal`: through the module's import cycle, `webhook_slack_bot_interaction` would
// bind to the original module.
vi.mock(import("@connectors/connectors/slack/bot"), () => ({
  botAnswerMessage: vi.fn(),
  botAnswerUserQuestion: vi.fn(),
  botReplaceMention: vi.fn(),
  botValidateToolExecution: vi.fn(),
  getBotEnabled: vi.fn(),
  getSlackConnector: vi.fn(),
}));
vi.mock(
  import("@connectors/connectors/github/temporal/client"),
  async (importOriginal) => ({
    ...(await importOriginal()),
    launchGithubIssueSyncWorkflow: vi.fn(),
  })
);
vi.mock(
  import("@connectors/connectors/notion/lib/webhooks"),
  async (importOriginal) => ({
    ...(await importOriginal()),
    processNotionWebhookEvent: vi.fn(),
  })
);
vi.mock(
  import("@connectors/connectors/webcrawler/temporal/client"),
  async (importOriginal) => ({
    ...(await importOriginal()),
    launchFirecrawlCrawlStartedWorkflow: vi.fn(),
  })
);

function partialSlackError(enabled: SlackProvider, missing: SlackProvider) {
  return `CONNECTORS_ENABLED_PROVIDERS enables ${enabled} but not ${missing}: slack and slack_bot share the slack worker and must be enabled together`;
}

// Lists that enable one Slack provider without the other, and the error they parse to.
const PARTIAL_SLACK_LISTS = [
  { list: "slack", error: partialSlackError("slack", "slack_bot") },
  { list: "slack_bot", error: partialSlackError("slack_bot", "slack") },
  {
    list: "dust_project,slack_bot",
    error: partialSlackError("slack_bot", "slack"),
  },
  { list: " notion , slack ", error: partialSlackError("slack", "slack_bot") },
];

const MALFORMED_VALUES = [
  "",
  " ",
  "dust_project,",
  ",dust_project",
  "dust_project,,notion",
  "dust_project,unknown",
  "Dust_Project",
  "dust_project,dust_project",
  "constructor",
  ...PARTIAL_SLACK_LISTS.map(({ list }) => list),
];

// Keyed by `ConnectorProvider`, so that a provider added upstream fails type-checking here until it
// is listed.
const EVERY_PROVIDER: Record<ConnectorProvider, true> = {
  bigquery: true,
  confluence: true,
  discord_bot: true,
  dust_project: true,
  github: true,
  gong: true,
  google_drive: true,
  intercom: true,
  microsoft: true,
  microsoft_bot: true,
  notion: true,
  salesforce: true,
  slack: true,
  slack_bot: true,
  snowflake: true,
  webcrawler: true,
  zendesk: true,
};

const WEBCRAWLER_CONFIGURATION = {
  url: "https://example.com",
  depth: 1,
  maxPageToCrawl: 10,
  crawlMode: "website",
  crawlFrequency: "never",
  headers: {},
};

const DISCORD_KEYS = nacl.sign.keyPair();

type ApiRequest = {
  method: "POST" | "PATCH";
  path: string;
  body: string;
  contentType: string;
  headers?: Record<string, string>;
};

type ApiResponse = { status: number; body: unknown };

function jsonRequest(
  method: ApiRequest["method"],
  path: string,
  value: unknown,
  headers?: Record<string, string>
): ApiRequest {
  return {
    method,
    path,
    body: JSON.stringify(value),
    contentType: "application/json",
    headers,
  };
}

function webhookPath(route: string) {
  return `/webhooks/${secrets.webhooks}/${route}`;
}

const SIGNALS = ["SIGTERM", "SIGINT"] as const;
const stopApis: Array<() => Promise<void>> = [];
// `startServer` listens on every address. On an ephemeral port that another process holds on
// 127.0.0.1, requests sent to 127.0.0.1 would reach that process, so the API listens there only.
const API_HOST = "127.0.0.1";

// Starts the real API (`startServer`) on an ephemeral port. Started inside a test, it serves
// requests within that test's database transaction.
async function startApi() {
  const signalListeners = SIGNALS.map((s) => process.listeners(s));
  const serverListen = net.Server.prototype.listen;
  const listen = vi
    .spyOn(net.Server.prototype, "listen")
    .mockImplementation(function (this: net.Server, port, listeningListener) {
      return serverListen.call(
        this,
        { port, host: API_HOST },
        listeningListener
      );
    });
  let server: Server | undefined;
  try {
    startServer(0);
    const [context] = listen.mock.contexts;
    server = context instanceof Server ? context : undefined;
  } finally {
    listen.mockRestore();
  }
  if (!server) {
    throw new Error("startServer did not listen");
  }
  stopApis.push(async () => {
    const closed = once(server, "close");
    server.close();
    server.closeAllConnections();
    await closed;
    SIGNALS.forEach((signal, i) => {
      for (const listener of process.listeners(signal)) {
        if (!signalListeners[i]?.includes(listener)) {
          process.off(signal, listener);
        }
      }
    });
  });
  if (!server.listening) {
    await once(server, "listening");
  }
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("API server has no TCP address");
  }
  if (address.address !== API_HOST) {
    throw new Error(
      `API server listens on ${address.address}, not on ${API_HOST}`
    );
  }

  return {
    app: server.listeners("request")[0],
    async send(request: ApiRequest): Promise<ApiResponse> {
      const res = await fetch(
        `http://${API_HOST}:${address.port}${request.path}`,
        {
          method: request.method,
          headers: {
            "content-type": request.contentType,
            ...(request.path.startsWith("/webhooks")
              ? {}
              : { authorization: `Bearer ${secrets.api}` }),
            ...request.headers,
          },
          body: request.body,
        }
      );
      const text = await res.text();
      return {
        status: res.status,
        body: res.headers.get("content-type")?.includes("json")
          ? JSON.parse(text)
          : text,
      };
    },
  };
}

async function send(request: ApiRequest) {
  return (await startApi()).send(request);
}

function notEnabled(providers: readonly string[]): ApiResponse {
  return {
    status: 403,
    body: {
      error: {
        type: "invalid_request_error",
        message: `Connector provider not enabled on this deployment: ${providers.join(", ")}`,
      },
    },
  };
}

function misconfiguredError(error: string) {
  return {
    type: "internal_server_error",
    message: `Invalid connectors configuration: ${error}`,
  };
}

// The answer to any guarded request while the list is malformed with `error`.
function misconfigured(error: string): ApiResponse {
  return { status: 500, body: { error: misconfiguredError(error) } };
}

function createRequest(provider: string, configuration: unknown = null) {
  return jsonRequest("POST", `/connectors/create/${provider}`, {
    workspaceAPIKey: "sk-test",
    dataSourceId: "data-source",
    workspaceId: "workspace",
    connectionId: "connection",
    configuration,
  });
}

function makeConnector(
  type: ConnectorProvider,
  { paused }: { paused: boolean } = { paused: false }
) {
  return ConnectorModel.create({
    type,
    connectionId: "connection",
    workspaceAPIKey: "sk-test",
    workspaceId: "workspace",
    dataSourceId: "data-source",
    pausedAt: paused ? new Date() : null,
  });
}

const MANAGERS: Partial<
  Record<ConnectorProvider, BaseConnectorManager<ConnectorConfiguration>>
> = {
  webcrawler: WebcrawlerConnectorManager.prototype,
  dust_project: DustProjectConnectorManager.prototype,
};

function managerOf(provider: ConnectorProvider) {
  const manager = MANAGERS[provider];
  if (!manager) {
    throw new Error(`No test manager for ${provider}`);
  }
  return manager;
}

function slackInteraction(route: string): ApiRequest {
  const payload = {
    type: "block_actions",
    team: { id: "T1", domain: "team" },
    channel: { id: "C1", name: "general" },
    container: { message_ts: "2.0", channel_id: "C1", thread_ts: "1.0" },
    user: { id: "U1" },
    actions: [
      {
        type: "static_select",
        action_id: "static_agent_config",
        block_id: JSON.stringify({ slackChatBotMessageId: 7 }),
        selected_option: {
          text: { type: "plain_text", text: "Agent" },
          value: "agent-sid",
        },
        action_ts: "3.0",
      },
    ],
    trigger_id: "trigger",
    response_url: "https://hooks.slack.com/actions/response",
  };
  return {
    method: "POST",
    path: webhookPath(route),
    body: new URLSearchParams({ payload: JSON.stringify(payload) }).toString(),
    contentType: "application/x-www-form-urlencoded",
  };
}

type PreparedRequest = {
  request: ApiRequest;
  // Asserts the handler ran: its answer and, where it has one, the work it started.
  expectHandled: (res: ApiResponse) => Promise<void> | void;
  // Asserts the work the handler would have started did not happen.
  expectNoEffect?: () => Promise<void> | void;
};

type GuardedRoute = {
  // As registered by `startServer`.
  route: string;
  // The provider the request acts on.
  provider: ConnectorProvider;
  // The providers the guard checks, when they are not just `provider`.
  guardedProviders?: readonly ConnectorProvider[];
  // A list that does not enable `provider`.
  disablingList?: string;
  // Whether the route acts on `dust_project`, so that `dust_project` alone lets it through.
  servesDustProject: boolean;
  prepare: (provider: ConnectorProvider) => Promise<PreparedRequest>;
};

// Every route whose handler calls `checkConnectorProviderEnabled` or
// `checkResolvedConnectorProvidersEnabled`, or is wrapped by `withEnabledConnectorProviders`.
const GUARDED_ROUTES: GuardedRoute[] = [
  {
    route: "POST /connectors/create/:connector_provider",
    provider: "webcrawler",
    servesDustProject: true,
    async prepare(provider) {
      const create =
        provider === "webcrawler"
          ? vi
              .spyOn(WebcrawlerConnectorManager, "create")
              .mockResolvedValue(
                new Err(
                  new ConnectorManagerError(
                    "INVALID_CONFIGURATION",
                    "stubbed manager"
                  )
                )
              )
          : vi.spyOn(DustProjectConnectorManager, "create");
      return {
        request: createRequest(
          provider,
          provider === "webcrawler" ? WEBCRAWLER_CONFIGURATION : null
        ),
        async expectHandled(res) {
          expect(create).toHaveBeenCalledOnce();
          if (provider === "webcrawler") {
            // The stubbed manager answers 400: reaching it shows nothing refused the provider.
            expect(res).toEqual({
              status: 400,
              body: {
                error: {
                  type: "invalid_request_error",
                  message: "stubbed manager",
                },
              },
            });
          } else {
            expect(res.status).toBe(200);
            expect(res.body).toMatchObject({ type: provider });
            expect(
              await ConnectorModel.count({ where: { type: provider } })
            ).toBe(1);
          }
        },
        async expectNoEffect() {
          expect(create).not.toHaveBeenCalled();
          expect(await ConnectorModel.count()).toBe(0);
        },
      };
    },
  },
  {
    route: "POST /connectors/update/:connector_id/",
    provider: "webcrawler",
    servesDustProject: true,
    async prepare(provider) {
      const connector = await makeConnector(provider, { paused: true });
      const update = vi
        .spyOn(managerOf(provider), "update")
        .mockResolvedValue(new Ok(connector.id.toString()));
      return {
        request: jsonRequest("POST", `/connectors/update/${connector.id}/`, {
          connectionId: "new-connection",
        }),
        async expectHandled(res) {
          expect(res).toEqual({
            status: 200,
            body: { connectorId: connector.id.toString() },
          });
          expect(update).toHaveBeenCalledWith({
            connectionId: "new-connection",
          });
          await connector.reload();
          expect(connector.pausedAt).toBeNull();
        },
        async expectNoEffect() {
          expect(update).not.toHaveBeenCalled();
          await connector.reload();
          expect(connector.pausedAt).not.toBeNull();
        },
      };
    },
  },
  {
    route: "POST /connectors/unpause/:connector_id",
    provider: "webcrawler",
    servesDustProject: true,
    async prepare(provider) {
      const connector = await makeConnector(provider, { paused: true });
      const resume = vi
        .spyOn(managerOf(provider), "resume")
        .mockResolvedValue(new Ok(undefined));
      return {
        request: jsonRequest("POST", `/connectors/unpause/${connector.id}`, {}),
        async expectHandled(res) {
          expect(res.status).toBe(204);
          expect(resume).toHaveBeenCalledOnce();
          await connector.reload();
          expect(connector.pausedAt).toBeNull();
        },
        async expectNoEffect() {
          expect(resume).not.toHaveBeenCalled();
          await connector.reload();
          expect(connector.pausedAt).not.toBeNull();
        },
      };
    },
  },
  {
    route: "POST /connectors/sync/:connector_id",
    provider: "webcrawler",
    servesDustProject: true,
    async prepare(provider) {
      const connector = await makeConnector(provider);
      const sync = vi
        .spyOn(managerOf(provider), "sync")
        .mockResolvedValue(new Ok("workflow-id"));
      return {
        request: jsonRequest("POST", `/connectors/sync/${connector.id}`, {}),
        expectHandled(res) {
          expect(res).toEqual({
            status: 200,
            body: { workflowId: "workflow-id" },
          });
          expect(sync).toHaveBeenCalledWith({ fromTs: null });
        },
        expectNoEffect() {
          expect(sync).not.toHaveBeenCalled();
        },
      };
    },
  },
  {
    // Only `dust_project` connectors reach the guard, so a list without it disables the route.
    route: "POST /connectors/sync/:connector_id/incremental",
    provider: "dust_project",
    disablingList: "webcrawler",
    servesDustProject: true,
    async prepare(provider) {
      const connector = await makeConnector(provider);
      const sync = vi
        .spyOn(managerOf(provider), "requestIncrementalSync")
        .mockResolvedValue(new Ok("workflow-id"));
      return {
        request: jsonRequest(
          "POST",
          `/connectors/sync/${connector.id}/incremental`,
          {}
        ),
        expectHandled(res) {
          expect(res).toEqual({
            status: 200,
            body: { workflowId: "workflow-id" },
          });
          expect(sync).toHaveBeenCalledOnce();
        },
        expectNoEffect() {
          expect(sync).not.toHaveBeenCalled();
        },
      };
    },
  },
  {
    route: "POST /connectors/:connector_id/permissions",
    provider: "webcrawler",
    servesDustProject: true,
    async prepare(provider) {
      const connector = await makeConnector(provider);
      const setPermissions = vi
        .spyOn(managerOf(provider), "setPermissions")
        .mockResolvedValue(new Ok(undefined));
      return {
        request: jsonRequest(
          "POST",
          `/connectors/${connector.id}/permissions`,
          { resources: [{ internal_id: "node", permission: "read" }] }
        ),
        expectHandled(res) {
          expect(res).toEqual({ status: 200, body: { success: true } });
          expect(setPermissions).toHaveBeenCalledWith({
            permissions: { node: "read" },
          });
        },
        expectNoEffect() {
          expect(setPermissions).not.toHaveBeenCalled();
        },
      };
    },
  },
  {
    // Only webcrawler connectors support configuration patching.
    route: "PATCH /connectors/:connector_id/configuration",
    provider: "webcrawler",
    servesDustProject: false,
    async prepare(provider) {
      const connector = await makeConnector(provider);
      const configure = vi
        .spyOn(managerOf(provider), "configure")
        .mockResolvedValue(new Ok(undefined));
      return {
        request: jsonRequest(
          "PATCH",
          `/connectors/${connector.id}/configuration`,
          { configuration: WEBCRAWLER_CONFIGURATION }
        ),
        expectHandled(res) {
          expect(res.status).toBe(200);
          expect(res.body).toMatchObject({ type: provider });
          expect(configure).toHaveBeenCalledWith({
            configuration: WEBCRAWLER_CONFIGURATION,
          });
        },
        expectNoEffect() {
          expect(configure).not.toHaveBeenCalled();
        },
      };
    },
  },
  {
    route: "POST /connectors/:connector_id/config/:config_key",
    provider: "webcrawler",
    servesDustProject: true,
    async prepare(provider) {
      const connector = await makeConnector(provider);
      const setConfigurationKey = vi
        .spyOn(managerOf(provider), "setConfigurationKey")
        .mockResolvedValue(new Ok(undefined));
      return {
        request: jsonRequest(
          "POST",
          `/connectors/${connector.id}/config/someKey`,
          { configValue: "value" }
        ),
        expectHandled(res) {
          expect(res).toEqual({
            status: 200,
            body: {
              connectorId: connector.id,
              configKey: "someKey",
              configValue: "value",
            },
          });
          expect(setConfigurationKey).toHaveBeenCalledWith({
            configKey: "someKey",
            configValue: "value",
          });
        },
        expectNoEffect() {
          expect(setConfigurationKey).not.toHaveBeenCalled();
        },
      };
    },
  },
  {
    // A command that starts work for its provider: a command that starts none runs under any list.
    route: "POST /connectors/admin",
    provider: "notion",
    servesDustProject: false,
    async prepare() {
      vi.mocked(runCommand).mockResolvedValue({ success: true });
      const command = {
        majorCommand: "notion",
        command: "upsert-page",
        args: { wId: "workspace", dsId: "data-source", pageId: "page" },
      };
      return {
        request: jsonRequest("POST", "/connectors/admin", command),
        expectHandled(res) {
          expect(res).toEqual({ status: 200, body: { success: true } });
          expect(runCommand).toHaveBeenCalledWith(command);
        },
        expectNoEffect() {
          expect(runCommand).not.toHaveBeenCalled();
        },
      };
    },
  },
  {
    route: "PATCH /slack/channels/linked_with_agent",
    provider: "slack",
    servesDustProject: false,
    async prepare(provider) {
      const connector = await makeConnector(provider);
      const channel = await SlackChannelModel.create({
        connectorId: connector.id,
        slackChannelId: "C1",
        slackChannelName: "general",
        private: false,
        permission: "read_write",
      });
      vi.mocked(getSlackClient).mockResolvedValue(new WebClient());
      vi.mocked(launchJoinChannelWorkflow).mockResolvedValue(
        new Ok("workflow")
      );
      return {
        request: jsonRequest("PATCH", "/slack/channels/linked_with_agent", {
          agent_configuration_id: "agent",
          slack_channel_internal_ids: ["slack-channel-C1"],
          connector_id: connector.id.toString(),
        }),
        async expectHandled(res) {
          expect(res).toEqual({ status: 200, body: { success: true } });
          await channel.reload();
          expect(channel.agentConfigurationId).toBe("agent");
          expect(launchJoinChannelWorkflow).toHaveBeenCalledWith(
            connector.id,
            "C1",
            "join-only"
          );
        },
        async expectNoEffect() {
          await channel.reload();
          expect(channel.agentConfigurationId).toBeNull();
          expect(launchJoinChannelWorkflow).not.toHaveBeenCalled();
        },
      };
    },
  },
  {
    route: "POST /webhooks/:webhook_secret/slack",
    provider: "slack",
    servesDustProject: false,
    async prepare() {
      vi.mocked(launchSlackWebhookEventWorkflow).mockResolvedValue(
        new Ok("workflow")
      );
      return {
        request: jsonRequest("POST", webhookPath("slack"), {
          type: "event_callback",
          team_id: "T1",
          event_id: "Ev1",
          event: { type: "app_mention", channel: "C1", ts: "1.0" },
        }),
        expectHandled(res) {
          expect(res.status).toBe(200);
          expect(launchSlackWebhookEventWorkflow).toHaveBeenCalledWith(
            "T1",
            "Ev1",
            { type: "app_mention", channelId: "C1", ts: "1.0" }
          );
        },
        expectNoEffect() {
          expect(launchSlackWebhookEventWorkflow).not.toHaveBeenCalled();
        },
      };
    },
  },
  {
    route: "POST /webhooks/:webhook_secret/slack_interaction",
    provider: "slack",
    servesDustProject: false,
    async prepare() {
      vi.mocked(botReplaceMention).mockResolvedValue(new Ok(undefined));
      return {
        request: slackInteraction("slack_interaction"),
        async expectHandled(res) {
          // Slack interactions are acknowledged before they are handled.
          expect(res.status).toBe(200);
          await vi.waitFor(() =>
            expect(botReplaceMention).toHaveBeenCalledWith(
              7,
              "agent-sid",
              expect.objectContaining({ slackTeamId: "T1" })
            )
          );
        },
        expectNoEffect() {
          expect(botReplaceMention).not.toHaveBeenCalled();
        },
      };
    },
  },
  {
    route: "POST /webhooks/:webhook_secret/slack_bot",
    provider: "slack_bot",
    servesDustProject: false,
    async prepare() {
      return {
        request: jsonRequest("POST", webhookPath("slack_bot"), {
          type: "url_verification",
          challenge: "challenge",
        }),
        expectHandled(res) {
          expect(res).toEqual({
            status: 200,
            body: { challenge: "challenge" },
          });
        },
      };
    },
  },
  {
    route: "POST /webhooks/:webhook_secret/slack_bot_interaction",
    provider: "slack_bot",
    servesDustProject: false,
    async prepare() {
      vi.mocked(botReplaceMention).mockResolvedValue(new Ok(undefined));
      return {
        request: slackInteraction("slack_bot_interaction"),
        async expectHandled(res) {
          // Slack interactions are acknowledged before they are handled.
          expect(res.status).toBe(200);
          await vi.waitFor(() =>
            expect(botReplaceMention).toHaveBeenCalledWith(
              7,
              "agent-sid",
              expect.objectContaining({ slackTeamId: "T1" })
            )
          );
        },
        expectNoEffect() {
          expect(botReplaceMention).not.toHaveBeenCalled();
        },
      };
    },
  },
  {
    route: "POST /webhooks/:webhooks_secret/github",
    provider: "github",
    servesDustProject: false,
    async prepare(provider) {
      const connector = await makeConnector(provider);
      await GithubConnectorStateModel.create({
        connectorId: connector.id,
        installationId: "42",
        webhooksEnabledAt: new Date(Date.now() - 60_000),
        codeSyncEnabled: false,
      });
      vi.mocked(launchGithubIssueSyncWorkflow).mockResolvedValue(undefined);
      const body = JSON.stringify({
        action: "opened",
        installation: { id: 42, account: { login: "org" } },
        organization: { login: "org" },
        repository: { id: 9, name: "repo" },
        issue: { id: 70, number: 7 },
      });
      return {
        request: {
          method: "POST",
          path: webhookPath("github"),
          body,
          contentType: "application/json",
          headers: {
            "x-github-event": "issues",
            "x-hub-signature-256": `sha256=${createHmac("sha256", secrets.github).update(body).digest("hex")}`,
          },
        },
        expectHandled(res) {
          expect(res.status).toBe(200);
          expect(launchGithubIssueSyncWorkflow).toHaveBeenCalledWith(
            connector.id,
            "org",
            "repo",
            9,
            7
          );
        },
        expectNoEffect() {
          expect(launchGithubIssueSyncWorkflow).not.toHaveBeenCalled();
        },
      };
    },
  },
  {
    route: "POST /webhooks/:webhooks_secret/notion",
    provider: "notion",
    servesDustProject: false,
    async prepare(provider) {
      const connector = await makeConnector(provider);
      await NotionConnectorStateModel.create({
        connectorId: connector.id,
        notionWorkspaceId: "notion-workspace",
      });
      vi.mocked(processNotionWebhookEvent).mockResolvedValue(undefined);
      return {
        request: jsonRequest("POST", webhookPath("notion"), {
          workspace_id: "notion-workspace",
          type: "page.content_updated",
          entity: { id: "page" },
        }),
        expectHandled(res) {
          expect(res.status).toBe(200);
          expect(processNotionWebhookEvent).toHaveBeenCalledWith({
            connectorId: connector.id,
            event: { type: "page.content_updated", entity_id: "page" },
          });
        },
        expectNoEffect() {
          expect(processNotionWebhookEvent).not.toHaveBeenCalled();
        },
      };
    },
  },
  {
    route: "POST /webhooks/:webhooks_secret/firecrawl",
    provider: "webcrawler",
    servesDustProject: false,
    async prepare(provider) {
      const connector = await makeConnector(provider);
      vi.mocked(launchFirecrawlCrawlStartedWorkflow).mockResolvedValue(
        new Ok("workflow")
      );
      return {
        request: jsonRequest("POST", webhookPath("firecrawl"), {
          success: true,
          type: "crawl.started",
          id: "crawl",
          data: [],
          metadata: { connectorId: connector.id.toString() },
          error: null,
        }),
        expectHandled(res) {
          expect(res.status).toBe(200);
          expect(launchFirecrawlCrawlStartedWorkflow).toHaveBeenCalledWith(
            connector.id,
            "crawl"
          );
        },
        expectNoEffect() {
          expect(launchFirecrawlCrawlStartedWorkflow).not.toHaveBeenCalled();
        },
      };
    },
  },
  {
    route: "POST /webhooks/:webhooks_secret/discord/app",
    provider: "discord_bot",
    servesDustProject: false,
    async prepare() {
      vi.stubEnv(
        "DISCORD_APP_PUBLIC_KEY",
        Buffer.from(DISCORD_KEYS.publicKey).toString("hex")
      );
      const body = JSON.stringify({ type: 1, token: "token" });
      const timestampSeconds = "1700000000";
      const signature = nacl.sign.detached(
        new Uint8Array(Buffer.from(timestampSeconds + body)),
        DISCORD_KEYS.secretKey
      );
      return {
        // A signed ping, answered with a pong.
        request: {
          method: "POST",
          path: webhookPath("discord/app"),
          body,
          contentType: "application/json",
          headers: {
            "x-signature-ed25519": Buffer.from(signature).toString("hex"),
            "x-signature-timestamp": timestampSeconds,
          },
        },
        expectHandled(res) {
          expect(res).toEqual({ status: 200, body: { type: 1 } });
        },
      };
    },
  },
  {
    route: "POST /webhooks/:webhook_secret/microsoft_teams_bot",
    provider: "microsoft_bot",
    servesDustProject: false,
    async prepare() {
      vi.stubEnv("MICROSOFT_BOT_ID", "microsoft-bot");
      return {
        // Without a Bot Framework token, the handler answers 401.
        request: jsonRequest("POST", webhookPath("microsoft_teams_bot"), {
          type: "message",
        }),
        expectHandled(res) {
          expect(res).toEqual({
            status: 401,
            body: {
              error: {
                type: "invalid_request_error",
                message: "Missing or invalid Authorization header",
              },
            },
          });
        },
      };
    },
  },
];

// Routes that never check the allowlist: read-only, pausing and deleting routes, and routes that
// only store Dust-side settings.
const UNGUARDED_ROUTES = [
  "GET /",
  "GET /profiler",
  "POST /connectors/pause/:connector_id",
  "DELETE /connectors/delete/:connector_id",
  "GET /connectors/:connector_id",
  "GET /connectors",
  "GET /connectors/:connector_id/permissions",
  "GET /slack/channels/linked_with_agent",
  "GET /slack/bots/summoning_whitelist",
  "POST /slack/bots/summoning_whitelist",
  "DELETE /slack/bots/summoning_whitelist",
  "GET /notion/url/status",
  "GET /connectors/:connector_id/notion/workspace_id",
  "POST /webhooks_router_entries/:webhook_secret/:provider/:providerWorkspaceId",
  "GET /webhooks_router_entries/:webhook_secret/:provider/:providerWorkspaceId",
  "GET /connectors/:connector_id/config/:config_key",
];

beforeEach(() => {
  // Redis is not available: the webhook rate limiter lets every request through. Spied on the
  // `@connectors/types` barrel, which the test setup loads before any `vi.mock` applies.
  vi.spyOn(connectorsTypes, "rateLimiter").mockResolvedValue(1);
});

afterEach(async () => {
  await Promise.all(stopApis.splice(0).map((stop) => stop()));
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

// Run first, before any `startServer` call installs the global error handlers of this process.
describe("startServer", () => {
  const PROCESS_EVENTS = [
    "SIGTERM",
    "SIGINT",
    "uncaughtException",
    "unhandledRejection",
  ];

  it.each(MALFORMED_VALUES)("refuses to start when the list is %j", (value) => {
    vi.stubEnv("CONNECTORS_ENABLED_PROVIDERS", value);
    const parsed = parseEnabledConnectorProviders(value);
    const listen = vi.spyOn(net.Server.prototype, "listen");
    const processListenerCounts = () =>
      PROCESS_EVENTS.map((event) => process.listenerCount(event));
    const before = processListenerCounts();

    expect(() => startServer(0)).toThrow(
      `Invalid connectors configuration: ${parsed.isErr() ? parsed.error.message : ""}`
    );
    expect(listen).not.toHaveBeenCalled();
    // `setupGlobalErrorHandler` would swallow the error: no handler may be installed first.
    expect(processListenerCounts()).toEqual(before);
  });

  it.each([
    {
      list: "dust_project,notio",
      error:
        "CONNECTORS_ENABLED_PROVIDERS names an unknown connector provider: notio",
    },
    { list: "slack_bot", error: partialSlackError("slack_bot", "slack") },
  ])("exits the API entrypoint with that error before it listens when the list is $list", {
    timeout: 60_000,
  }, async ({ list, error }) => {
    const run = promisify(execFile)(
      process.execPath,
      ["--import", "tsx", "src/start_server.ts", "-p", "3002"],
      {
        cwd: path.resolve(__dirname, "../.."),
        env: {
          NODE_ENV: "test",
          LOG_LEVEL: "silent",
          // Required to load the server, never connected to before it refuses to start.
          CONNECTORS_DATABASE_URI: "postgres://localhost/unused_test",
          DUST_CONNECTORS_SECRET: secrets.api,
          DUST_CONNECTORS_WEBHOOKS_SECRET: secrets.webhooks,
          CONNECTORS_ENABLED_PROVIDERS: list,
        },
        // A process that started listening would never exit.
        timeout: 50_000,
      }
    );

    await expect(run).rejects.toMatchObject({
      code: 1,
      stderr: expect.stringContaining(
        `Invalid connectors configuration: ${error}`
      ),
    });
  });
});

describe("parseEnabledConnectorProviders", () => {
  it("enables every provider when the variable is unset", () => {
    const res = parseEnabledConnectorProviders(undefined);
    expect(res.isOk() && res.value).toBeNull();
  });

  it("parses a trimmed comma-separated list of providers", () => {
    const res = parseEnabledConnectorProviders(" dust_project , webcrawler ");
    expect(res.isOk() && [...(res.value ?? [])]).toEqual([
      "dust_project",
      "webcrawler",
    ]);
  });

  it.each(MALFORMED_VALUES)("rejects %j", (value) => {
    expect(parseEnabledConnectorProviders(value).isErr()).toBe(true);
  });

  it.each(
    PARTIAL_SLACK_LISTS
  )("rejects $list, which enables one Slack provider without the other", ({
    list,
    error,
  }) => {
    const res = parseEnabledConnectorProviders(list);
    expect(res.isErr() && res.error.message).toBe(error);
  });

  it("accepts a list that enables slack and slack_bot together", () => {
    for (const list of ["slack,slack_bot", " slack_bot , dust_project,slack"]) {
      const res = parseEnabledConnectorProviders(list);
      expect(res.isOk() && res.value?.has("slack")).toBe(true);
      expect(res.isOk() && res.value?.has("slack_bot")).toBe(true);
    }
  });

  it("accepts a list that enables neither Slack provider", () => {
    for (const list of ["dust_project", "dust_project,notion"]) {
      expect(parseEnabledConnectorProviders(list).isOk()).toBe(true);
    }
  });

  it("rejects a list that enables only some providers of any provider group", () => {
    for (const [worker, group] of Object.entries(PROVIDER_GROUPS)) {
      expect(parseEnabledConnectorProviders(group.join(",")).isOk()).toBe(true);
      for (const provider of group) {
        const res = parseEnabledConnectorProviders(provider);
        expect(res.isErr() && res.error.message).toContain(
          `${group.join(" and ")} share the ${worker} worker and must be enabled together`
        );
      }
    }
  });
});

describe("checkConnectorProviderEnabled", () => {
  it.each(
    PARTIAL_SLACK_LISTS
  )("refuses every provider as misconfigured when the list is $list", ({
    list,
    error,
  }) => {
    vi.stubEnv("CONNECTORS_ENABLED_PROVIDERS", list);

    for (const provider of Object.keys(EVERY_PROVIDER)) {
      const res = checkConnectorProviderEnabled(provider);
      expect(res.isErr() && res.error).toEqual({
        status_code: 500,
        api_error: misconfiguredError(error),
      });
    }
  });
});

const ROUTER_STACK_SCHEMA = z.array(
  z.object({
    route: z
      .object({ path: z.string(), methods: z.record(z.string(), z.boolean()) })
      .optional(),
  })
);

describe("routes guarded by CONNECTORS_ENABLED_PROVIDERS", () => {
  it("lists every route the API serves as guarded or unguarded", async () => {
    const { app } = await startApi();
    // Express 4 keeps its routes in `app._router.stack`, which it does not type.
    const stack = ROUTER_STACK_SCHEMA.parse(
      app && Reflect.get(Reflect.get(app, "_router"), "stack")
    );
    const routes = stack.flatMap(({ route }) =>
      route
        ? Object.keys(route.methods).map(
            (method) => `${method.toUpperCase()} ${route.path}`
          )
        : []
    );

    // A route added upstream fails here until it is listed as guarded or as unguarded.
    expect(routes.sort()).toEqual(
      [...GUARDED_ROUTES.map((r) => r.route), ...UNGUARDED_ROUTES].sort()
    );
  });

  for (const route of GUARDED_ROUTES) {
    describe(route.route, () => {
      it("refuses a provider the list does not enable", async () => {
        vi.stubEnv(
          "CONNECTORS_ENABLED_PROVIDERS",
          route.disablingList ?? "dust_project"
        );
        const prepared = await route.prepare(route.provider);

        expect(await send(prepared.request)).toEqual(
          notEnabled(route.guardedProviders ?? [route.provider])
        );
        await prepared.expectNoEffect?.();
      });

      it("serves every provider when the variable is unset", async () => {
        vi.stubEnv("CONNECTORS_ENABLED_PROVIDERS", undefined);
        const prepared = await route.prepare(route.provider);

        await prepared.expectHandled(await send(prepared.request));
      });

      if (route.servesDustProject) {
        it("serves dust_project when the list enables it", async () => {
          vi.stubEnv("CONNECTORS_ENABLED_PROVIDERS", "dust_project");
          const prepared = await route.prepare("dust_project");

          await prepared.expectHandled(await send(prepared.request));
        });
      }

      // The API refuses to start under such a list, so it changes after startup.
      it.each(
        PARTIAL_SLACK_LISTS
      )("refuses as misconfigured when the list becomes $list after startup", async ({
        list,
        error,
      }) => {
        vi.stubEnv("CONNECTORS_ENABLED_PROVIDERS", "slack,slack_bot");
        const api = await startApi();
        const prepared = await route.prepare(route.provider);
        vi.stubEnv("CONNECTORS_ENABLED_PROVIDERS", list);

        expect(await api.send(prepared.request)).toEqual(misconfigured(error));
        await prepared.expectNoEffect?.();
      });
    });
  }

  it("serves the slack_bot webhook when the list enables slack and slack_bot", async () => {
    vi.stubEnv("CONNECTORS_ENABLED_PROVIDERS", "slack,slack_bot");

    expect(
      await send(
        jsonRequest("POST", webhookPath("slack_bot"), {
          type: "url_verification",
          challenge: "challenge",
        })
      )
    ).toEqual({ status: 200, body: { challenge: "challenge" } });
  });

  it("serves the slack webhook when the list enables slack and slack_bot", async () => {
    vi.stubEnv("CONNECTORS_ENABLED_PROVIDERS", "slack,slack_bot");
    vi.mocked(launchSlackWebhookEventWorkflow).mockResolvedValue(
      new Ok("workflow")
    );

    const res = await send(
      jsonRequest("POST", webhookPath("slack"), {
        type: "event_callback",
        team_id: "T1",
        event_id: "Ev1",
        event: { type: "app_mention", channel: "C1", ts: "1.0" },
      })
    );

    expect(res.status).toBe(200);
    expect(launchSlackWebhookEventWorkflow).toHaveBeenCalled();
  });

  function linkedWithAgentRoute() {
    const route = GUARDED_ROUTES.find(
      (r) => r.route === "PATCH /slack/channels/linked_with_agent"
    );
    if (!route) {
      throw new Error("linked_with_agent route missing from the table");
    }
    return route;
  }

  it("links channels of a slack_bot connector when the list enables slack and slack_bot", async () => {
    vi.stubEnv("CONNECTORS_ENABLED_PROVIDERS", "slack,slack_bot");
    const prepared = await linkedWithAgentRoute().prepare("slack_bot");

    await prepared.expectHandled(await send(prepared.request));
  });

  // The route checks the connector's own type, not only `slack`.
  it("refuses to link channels of a slack_bot connector when the list enables neither Slack provider", async () => {
    vi.stubEnv("CONNECTORS_ENABLED_PROVIDERS", "dust_project");
    const prepared = await linkedWithAgentRoute().prepare("slack_bot");

    expect(await send(prepared.request)).toEqual(notEnabled(["slack_bot"]));
    await prepared.expectNoEffect?.();
  });

  it("refuses a provider name it does not know", async () => {
    vi.stubEnv("CONNECTORS_ENABLED_PROVIDERS", "dust_project");

    expect(await send(createRequest("not_a_provider"))).toEqual(
      notEnabled(["not_a_provider"])
    );
    expect(await ConnectorModel.count()).toBe(0);
  });

  it("runs admin commands that do not belong to a provider", async () => {
    vi.stubEnv("CONNECTORS_ENABLED_PROVIDERS", "dust_project");
    vi.mocked(runCommand).mockResolvedValue({ success: true });

    expect(
      await send(
        jsonRequest("POST", "/connectors/admin", {
          majorCommand: "connectors",
          command: "clear-error",
          args: { connectorId: "1" },
        })
      )
    ).toEqual({ status: 200, body: { success: true } });
    expect(runCommand).toHaveBeenCalledOnce();
  });

  it.each(
    MALFORMED_VALUES
  )("refuses every provider when the list becomes %j after startup", async (value) => {
    vi.stubEnv("CONNECTORS_ENABLED_PROVIDERS", "dust_project");
    const api = await startApi();
    vi.stubEnv("CONNECTORS_ENABLED_PROVIDERS", value);
    const create = vi.spyOn(DustProjectConnectorManager, "create");

    const res = await api.send(createRequest("dust_project"));

    expect(res.status).toBe(500);
    expect(res.body).toMatchObject({
      error: { type: "internal_server_error" },
    });
    expect(create).not.toHaveBeenCalled();
    expect(await ConnectorModel.count()).toBe(0);
  });
});

// Each connector a test creates needs its own data source.
function makeAdminTarget(type: ConnectorProvider) {
  return ConnectorModel.create({
    type,
    connectionId: "connection",
    workspaceAPIKey: "sk-test",
    workspaceId: "workspace",
    dataSourceId: `data-source-${type}`,
    pausedAt: null,
  });
}

const UNRESOLVED: ApiResponse = {
  status: 403,
  body: {
    error: {
      type: "invalid_request_error",
      message: expect.stringMatching(
        /^Cannot check which connector providers this request acts on: /
      ),
    },
  },
};

type AdminApiCase = {
  title: string;
  // `undefined` leaves the variable unset.
  list: string | undefined;
  // Creates the connectors the command names.
  command: () => Promise<AdminCommandType>;
  // The answer, or `null` when the command reaches `runCommand`.
  refusal: ApiResponse | null;
};

// Commands the admin route whitelists, sent through the app `startServer` builds.
const ADMIN_API_CASES: AdminApiCase[] = [
  {
    // It requires only the provider that providerType names, not its major command's slack.
    title:
      "refuses slack run-auto-join on slack_bot for slack_bot when the list enables neither Slack provider",
    list: "dust_project",
    command: async () => ({
      majorCommand: "slack",
      command: "run-auto-join",
      args: { wId: "workspace", providerType: "slack_bot" },
    }),
    refusal: notEnabled(["slack_bot"]),
  },
  {
    title:
      "runs slack run-auto-join on slack_bot when the list enables slack and slack_bot",
    list: "slack,slack_bot",
    command: async () => ({
      majorCommand: "slack",
      command: "run-auto-join",
      args: { wId: "workspace", providerType: "slack_bot" },
    }),
    refusal: null,
  },
  {
    title:
      "runs slack run-auto-join on slack when the list enables slack and slack_bot",
    list: "slack,slack_bot",
    command: async () => ({
      majorCommand: "slack",
      command: "run-auto-join",
      args: { wId: "workspace", providerType: "slack" },
    }),
    refusal: null,
  },
  {
    title:
      "refuses slack run-auto-join on slack when the list enables neither Slack provider",
    list: "dust_project",
    command: async () => ({
      majorCommand: "slack",
      command: "run-auto-join",
      args: { wId: "workspace", providerType: "slack" },
    }),
    refusal: notEnabled(["slack"]),
  },
  {
    title: "refuses slack run-auto-join without a providerType",
    list: "slack,slack_bot",
    command: async () => ({
      majorCommand: "slack",
      command: "run-auto-join",
      args: { wId: "workspace" },
    }),
    refusal: UNRESOLVED,
  },
  {
    title: "refuses slack run-auto-join on a providerType that is no provider",
    list: "slack,slack_bot",
    command: async () => ({
      majorCommand: "slack",
      command: "run-auto-join",
      args: { wId: "workspace", providerType: "constructor" },
    }),
    refusal: UNRESOLVED,
  },
  {
    // It deletes through a workflow that it signals.
    title: "refuses notion delete-url when the list does not enable notion",
    list: "dust_project",
    command: async () => ({
      majorCommand: "notion",
      command: "delete-url",
      args: {
        wId: "workspace",
        dsId: "data-source",
        url: "https://www.notion.so/page",
      },
    }),
    refusal: notEnabled(["notion"]),
  },
  {
    // It starts a garbage collection when the channel is synced.
    title:
      "refuses slack skip-channel when the list enables neither Slack provider",
    list: "dust_project",
    command: async () => ({
      majorCommand: "slack",
      command: "skip-channel",
      args: { wId: "workspace", channelId: "C1", skipReason: "noise" },
    }),
    refusal: notEnabled(["slack"]),
  },
  {
    title:
      "refuses google_drive upsert-file on a webcrawler connector named by connectorId",
    list: "google_drive",
    command: async () => ({
      majorCommand: "google_drive",
      command: "upsert-file",
      args: {
        wId: "workspace",
        connectorId: (await makeAdminTarget("webcrawler")).id.toString(),
        fileId: "file",
      },
    }),
    refusal: notEnabled(["webcrawler"]),
  },
  {
    title:
      "refuses google_drive upsert-file on a webcrawler connector named by wId and dsId",
    list: "google_drive",
    command: async () => ({
      majorCommand: "google_drive",
      command: "upsert-file",
      args: {
        wId: "workspace",
        dsId: (await makeAdminTarget("webcrawler")).dataSourceId,
        fileId: "file",
      },
    }),
    refusal: notEnabled(["webcrawler"]),
  },
  {
    title:
      "refuses google_drive upsert-file when its dsId names a connector of a provider the list does not enable",
    list: "google_drive",
    command: async () => ({
      majorCommand: "google_drive",
      command: "upsert-file",
      args: {
        wId: "workspace",
        connectorId: (await makeAdminTarget("google_drive")).id.toString(),
        dsId: (await makeAdminTarget("webcrawler")).dataSourceId,
        fileId: "file",
      },
    }),
    refusal: notEnabled(["webcrawler"]),
  },
  {
    title: "runs google_drive upsert-file on a google_drive connector",
    list: "google_drive",
    command: async () => ({
      majorCommand: "google_drive",
      command: "upsert-file",
      args: {
        wId: "workspace",
        connectorId: (await makeAdminTarget("google_drive")).id.toString(),
        fileId: "file",
      },
    }),
    refusal: null,
  },
  {
    title: "refuses google_drive upsert-file naming no connector",
    list: "google_drive",
    command: async () => ({
      majorCommand: "google_drive",
      command: "upsert-file",
      args: { wId: "workspace", fileId: "file" },
    }),
    refusal: UNRESOLVED,
  },
  {
    title: "refuses google_drive upsert-file on a connectorId no connector has",
    list: "google_drive",
    command: async () => ({
      majorCommand: "google_drive",
      command: "upsert-file",
      args: {
        wId: "workspace",
        connectorId: `${(await makeAdminTarget("google_drive")).id + 1}`,
        fileId: "file",
      },
    }),
    refusal: UNRESOLVED,
  },
  {
    // Postgres reads `<id>_0` as another connector id than `parseInt` does.
    title:
      "refuses google_drive upsert-file on a connectorId that is not only digits",
    list: "google_drive",
    command: async () => ({
      majorCommand: "google_drive",
      command: "upsert-file",
      args: {
        wId: "workspace",
        connectorId: `${(await makeAdminTarget("google_drive")).id}_0`,
        fileId: "file",
      },
    }),
    refusal: UNRESOLVED,
  },
  {
    // It stores the crawler configuration only, whatever the connector's type.
    title:
      "runs webcrawler update-frequency on a dust_project connector when the list enables only webcrawler",
    list: "webcrawler",
    command: async () => ({
      majorCommand: "webcrawler",
      command: "update-frequency",
      args: {
        connectorId: (await makeAdminTarget("dust_project")).id.toString(),
        crawlFrequency: "never",
      },
    }),
    refusal: null,
  },
  {
    title: "runs webcrawler update-frequency on a webcrawler connector",
    list: "webcrawler",
    command: async () => ({
      majorCommand: "webcrawler",
      command: "update-frequency",
      args: {
        connectorId: (await makeAdminTarget("webcrawler")).id.toString(),
        crawlFrequency: "never",
      },
    }),
    refusal: null,
  },
  {
    title: "runs connectors set-error on a connector of any provider",
    list: "dust_project",
    command: async () => ({
      majorCommand: "connectors",
      command: "set-error",
      args: {
        wId: "workspace",
        connectorId: (await makeAdminTarget("webcrawler")).id.toString(),
        error: "oauth_token_revoked",
      },
    }),
    refusal: null,
  },
  {
    title:
      "runs google_drive upsert-file naming no connector when the variable is unset",
    list: undefined,
    command: async () => ({
      majorCommand: "google_drive",
      command: "upsert-file",
      args: { wId: "workspace", connectorId: "0", fileId: "file" },
    }),
    refusal: null,
  },
  {
    title:
      "runs slack run-auto-join without a providerType when the variable is unset",
    list: undefined,
    command: async () => ({
      majorCommand: "slack",
      command: "run-auto-join",
      args: { wId: "workspace" },
    }),
    refusal: null,
  },
];

async function checkAdmin(command: AdminCommandType) {
  const res = await checkAdminCommandProvidersEnabled(command);
  return res.isErr()
    ? { status: res.error.status_code, body: { error: res.error.api_error } }
    : null;
}

const CONNECTORS_COMMANDS_STARTING_WORK = [
  "unpause",
  "resume",
  "full-resync",
  "restart",
  "set-permission",
  "garbage-collect",
] as const;

const CONNECTORS_COMMANDS_STARTING_NO_WORK = [
  "stop",
  "pause",
  "delete",
  "get-parents",
  "set-error",
  "clear-error",
] as const;

const BATCH_COMMANDS_STARTING_WORK = [
  "full-resync",
  "restart-all",
  "resume-all",
] as const;

const TEMPORAL_COMMANDS = [
  "check-queue",
  "find-unprocessed-workflows",
  "stop-workflow",
] as const;

describe("POST /connectors/admin command targets", () => {
  it("classifies exactly the commands of AdminCommandSchema", () => {
    const schemaCommands = AdminCommandSchema.options.flatMap((schema) =>
      schema.shape.command.options.map(
        (literal) => `${schema.shape.majorCommand.value} ${literal.value}`
      )
    );
    const classified = Object.entries(ADMIN_COMMAND_TARGETS).flatMap(
      ([majorCommand, targets]) =>
        Object.keys(targets).map((command) => `${majorCommand} ${command}`)
    );

    // A command added upstream fails here until `ADMIN_COMMAND_TARGETS` classifies it.
    expect(classified.sort()).toEqual(schemaCommands.sort());
  });

  for (const adminCase of ADMIN_API_CASES) {
    it(adminCase.title, async () => {
      vi.stubEnv("CONNECTORS_ENABLED_PROVIDERS", adminCase.list);
      vi.mocked(runCommand).mockResolvedValue({ success: true });
      const command = await adminCase.command();

      const res = await send(jsonRequest("POST", "/connectors/admin", command));

      if (adminCase.refusal) {
        expect(res).toEqual(adminCase.refusal);
        expect(runCommand).not.toHaveBeenCalled();
      } else {
        expect(res).toEqual({ status: 200, body: { success: true } });
        expect(runCommand).toHaveBeenCalledWith(command);
      }
    });
  }

  // The commands below are not whitelisted by the admin route: their guard is checked directly,
  // for when a command is whitelisted.
  describe("checkAdminCommandProvidersEnabled", () => {
    beforeEach(() => {
      vi.stubEnv("CONNECTORS_ENABLED_PROVIDERS", "dust_project");
    });

    it.each(
      CONNECTORS_COMMANDS_STARTING_WORK
    )("refuses connectors %s on a connector of a provider the list does not enable", async (command) => {
      const connector = await makeAdminTarget("webcrawler");

      expect(
        await checkAdmin({
          majorCommand: "connectors",
          command,
          args: { wId: "workspace", connectorId: connector.id.toString() },
        })
      ).toEqual(notEnabled(["webcrawler"]));
    });

    it.each(
      CONNECTORS_COMMANDS_STARTING_WORK
    )("refuses connectors %s on a connector named by wId and dsId of a provider the list does not enable", async (command) => {
      const connector = await makeAdminTarget("webcrawler");

      expect(
        await checkAdmin({
          majorCommand: "connectors",
          command,
          args: { wId: "workspace", dsId: connector.dataSourceId },
        })
      ).toEqual(notEnabled(["webcrawler"]));
    });

    it.each(
      CONNECTORS_COMMANDS_STARTING_WORK
    )("runs connectors %s on a connector of a provider the list enables", async (command) => {
      const connector = await makeAdminTarget("dust_project");

      expect(
        await checkAdmin({
          majorCommand: "connectors",
          command,
          args: { wId: "workspace", connectorId: connector.id.toString() },
        })
      ).toBeNull();
    });

    it.each(
      CONNECTORS_COMMANDS_STARTING_WORK
    )("refuses connectors %s naming no connector", async (command) => {
      expect(
        await checkAdmin({
          majorCommand: "connectors",
          command,
          args: { wId: "workspace" },
        })
      ).toEqual(UNRESOLVED);
    });

    it.each(
      CONNECTORS_COMMANDS_STARTING_WORK
    )("runs connectors %s naming no connector when the variable is unset", async (command) => {
      vi.stubEnv("CONNECTORS_ENABLED_PROVIDERS", undefined);

      expect(
        await checkAdmin({
          majorCommand: "connectors",
          command,
          args: { wId: "workspace" },
        })
      ).toBeNull();
    });

    it.each(
      CONNECTORS_COMMANDS_STARTING_NO_WORK
    )("runs connectors %s on a connector of any provider", async (command) => {
      const connector = await makeAdminTarget("webcrawler");

      expect(
        await checkAdmin({
          majorCommand: "connectors",
          command,
          args: { wId: "workspace", connectorId: connector.id.toString() },
        })
      ).toBeNull();
      expect(
        await checkAdmin({ majorCommand: "connectors", command, args: {} })
      ).toBeNull();
    });

    it.each(
      BATCH_COMMANDS_STARTING_WORK
    )("refuses batch %s on a provider the list does not enable", async (command) => {
      expect(
        await checkAdmin({
          majorCommand: "batch",
          command,
          args: { provider: "webcrawler" },
        })
      ).toEqual(notEnabled(["webcrawler"]));
    });

    it.each(
      BATCH_COMMANDS_STARTING_WORK
    )("runs batch %s on a provider the list enables", async (command) => {
      expect(
        await checkAdmin({
          majorCommand: "batch",
          command,
          args: { provider: "dust_project" },
        })
      ).toBeNull();
    });

    it.each(
      BATCH_COMMANDS_STARTING_WORK
    )("refuses batch %s without a provider", async (command) => {
      expect(
        await checkAdmin({ majorCommand: "batch", command, args: {} })
      ).toEqual(UNRESOLVED);
    });

    it("runs batch stop-all on any provider", async () => {
      expect(
        await checkAdmin({
          majorCommand: "batch",
          command: "stop-all",
          args: { provider: "webcrawler" },
        })
      ).toBeNull();
    });

    it.each(TEMPORAL_COMMANDS)("runs temporal %s", async (command) => {
      expect(
        await checkAdmin({ majorCommand: "temporal", command, args: {} })
      ).toBeNull();
    });

    // It stores the slack_bot connector's whitelisted domains only.
    it("runs slack whitelist-domains when the list enables neither Slack provider", async () => {
      expect(
        await checkAdmin({
          majorCommand: "slack",
          command: "whitelist-domains",
          args: { wId: "workspace", whitelistedDomains: "example.com:group" },
        })
      ).toBeNull();
    });

    // It migrates the slack connector's channels to the slack_bot connector.
    it("runs slack cutover-legacy-bot only when the list enables slack and slack_bot", async () => {
      const slackCommand: AdminCommandType = {
        majorCommand: "slack",
        command: "cutover-legacy-bot",
        args: { wId: "workspace" },
      };

      expect(await checkAdmin(slackCommand)).toEqual(notEnabled(["slack"]));
      vi.stubEnv("CONNECTORS_ENABLED_PROVIDERS", "slack,slack_bot");
      expect(await checkAdmin(slackCommand)).toBeNull();
    });

    it.each(
      PARTIAL_SLACK_LISTS
    )("refuses every slack command that starts work as misconfigured when the list is $list", async ({
      list,
      error,
    }) => {
      vi.stubEnv("CONNECTORS_ENABLED_PROVIDERS", list);
      const slackCommands: AdminCommandType[] = [
        {
          majorCommand: "slack",
          command: "run-auto-join",
          args: { wId: "workspace", providerType: "slack_bot" },
        },
        {
          majorCommand: "slack",
          command: "cutover-legacy-bot",
          args: { wId: "workspace" },
        },
        {
          majorCommand: "slack",
          command: "sync-channel",
          args: { wId: "workspace", channelId: "C1" },
        },
        {
          majorCommand: "slack",
          command: "skip-channel",
          args: { wId: "workspace", channelId: "C1", skipReason: "noise" },
        },
      ];

      for (const slackCommand of slackCommands) {
        expect(await checkAdmin(slackCommand)).toEqual(misconfigured(error));
      }
    });

    // They start no work, so the list does not concern them.
    it.each(
      PARTIAL_SLACK_LISTS
    )("runs slack commands that start no work when the list is $list", async ({
      list,
    }) => {
      vi.stubEnv("CONNECTORS_ENABLED_PROVIDERS", list);
      const slackCommands: AdminCommandType[] = [
        {
          majorCommand: "slack",
          command: "whitelist-bot",
          args: {
            wId: "workspace",
            botName: "bot",
            whitelistType: "index_messages",
            providerType: "slack",
          },
        },
        {
          majorCommand: "slack",
          command: "delete-conversation",
          args: { wId: "workspace", channelId: "C1", threadTs: "1.0" },
        },
      ];

      for (const slackCommand of slackCommands) {
        expect(await checkAdmin(slackCommand)).toBeNull();
      }
    });

    it("refuses github resync-repo on a connector named by wId and dsId of a provider the list does not enable", async () => {
      vi.stubEnv("CONNECTORS_ENABLED_PROVIDERS", "github");
      const connector = await makeAdminTarget("dust_project");

      expect(
        await checkAdmin({
          majorCommand: "github",
          command: "resync-repo",
          args: {
            wId: "workspace",
            dsId: connector.dataSourceId,
            owner: "org",
            repo: "repo",
          },
        })
      ).toEqual(notEnabled(["dust_project"]));
    });
  });
});

// The `runCommand` that the admin route calls, which this file replaces for the routes.
async function actualRunCommand(command: AdminCommandType) {
  const cli = await vi.importActual<typeof import("@connectors/lib/cli")>(
    "@connectors/lib/cli"
  );
  return cli.runCommand(command);
}

type AvailableAdminCase = {
  title: string;
  // A list that enables none of the providers the command acts on.
  list: string;
  // Creates what the handler acts on. Returns the command, the handler's answer, and a check of
  // what the handler did.
  prepare: () => Promise<{
    command: AdminCommandType;
    result: unknown;
    expectEffect: () => Promise<void> | void;
  }>;
};

// Commands that start no work and that the admin route whitelists, sent through the app
// `startServer` builds to their real handler.
const AVAILABLE_ADMIN_API_CASES: AvailableAdminCase[] = [
  {
    title:
      "slack delete-conversation when the list enables neither Slack provider",
    list: "dust_project",
    async prepare() {
      const { slack } = await makeSlackTeam(null);
      const documentId = slackThreadInternalIdFromSlackThreadIdentifier({
        channelId: "C1",
        threadTs: "1.0",
      });
      await SlackMessagesModel.create({
        connectorId: slack.id,
        channelId: "C1",
        messageTs: "1.0",
        documentId,
      });
      const deleteDocument = vi
        .spyOn(dataSources, "deleteDataSourceDocument")
        .mockResolvedValue(undefined);
      return {
        command: {
          majorCommand: "slack",
          command: "delete-conversation",
          args: { wId: "workspace", channelId: "C1", threadTs: "1.0" },
        },
        result: { success: true },
        async expectEffect() {
          expect(deleteDocument).toHaveBeenCalledWith(
            expect.objectContaining({ dataSourceId: slack.dataSourceId }),
            documentId,
            expect.anything()
          );
          expect(
            await SlackMessagesModel.count({ where: { connectorId: slack.id } })
          ).toBe(0);
        },
      };
    },
  },
  {
    title:
      "confluence check-page-exists when the list does not enable confluence",
    list: "dust_project",
    async prepare() {
      const connector = await makeAdminTarget("confluence");
      await ConfluenceConfigurationModel.create({
        connectorId: connector.id,
        cloudId: "cloud",
        url: "https://acme.atlassian.net",
        userAccountId: "user",
      });
      vi.spyOn(confluenceUtils, "getConfluenceClient").mockResolvedValue(
        new ConfluenceClient("token", { cloudId: "cloud" })
      );
      const getPages = vi
        .spyOn(ConfluenceClient.prototype, "getPagesByIdsInSpace")
        .mockResolvedValue({ results: [], _links: {} });
      return {
        command: {
          majorCommand: "confluence",
          command: "check-page-exists",
          args: {
            connectorId: connector.id,
            url: "https://acme.atlassian.net/wiki/spaces/SPACE/pages/123/Page",
          },
        },
        result: { exists: false },
        expectEffect() {
          expect(getPages).toHaveBeenCalledWith({
            spaceKey: "SPACE",
            pageIds: ["123"],
          });
        },
      };
    },
  },
  {
    title:
      "connectors set-error on a webcrawler connector when the list does not enable webcrawler",
    list: "dust_project",
    async prepare() {
      const connector = await makeAdminTarget("webcrawler");
      return {
        command: {
          majorCommand: "connectors",
          command: "set-error",
          args: {
            wId: "workspace",
            connectorId: connector.id.toString(),
            error: "oauth_token_revoked",
          },
        },
        result: { success: true },
        async expectEffect() {
          expect(await ConnectorModel.findByPk(connector.id)).toMatchObject({
            errorType: "oauth_token_revoked",
          });
        },
      };
    },
  },
  {
    title:
      "intercom set-conversations-sliding-window when the list does not enable intercom",
    list: "dust_project",
    async prepare() {
      const connector = await makeAdminTarget("intercom");
      await IntercomWorkspaceModel.create({
        connectorId: connector.id,
        intercomWorkspaceId: "intercom-workspace",
        name: "Acme",
        region: "US",
        conversationsSlidingWindow: 90,
        syncAllConversations: "disabled",
        shouldSyncNotes: true,
      });
      return {
        command: {
          majorCommand: "intercom",
          command: "set-conversations-sliding-window",
          args: { connectorId: connector.id, conversationsSlidingWindow: 7 },
        },
        result: { success: true },
        async expectEffect() {
          expect(
            await IntercomWorkspaceModel.findOne({
              where: { connectorId: connector.id },
            })
          ).toMatchObject({ conversationsSlidingWindow: 7 });
        },
      };
    },
  },
  {
    title:
      "notion clear-parents-last-updated-at when the list does not enable notion",
    list: "dust_project",
    async prepare() {
      const connector = await makeAdminTarget("notion");
      await NotionConnectorStateModel.create({
        connectorId: connector.id,
        notionWorkspaceId: "notion-workspace",
        parentsLastUpdatedAt: new Date(),
      });
      return {
        command: {
          majorCommand: "notion",
          command: "clear-parents-last-updated-at",
          args: { wId: "workspace", connectorId: connector.id.toString() },
        },
        result: { success: true },
        async expectEffect() {
          expect(
            await NotionConnectorStateModel.findOne({
              where: { connectorId: connector.id },
            })
          ).toMatchObject({ parentsLastUpdatedAt: null });
        },
      };
    },
  },
  {
    title:
      "slack whitelist-bot on slack when the list enables neither Slack provider",
    list: "dust_project",
    async prepare() {
      const { slack } = await makeSlackTeam(null);
      return {
        command: {
          majorCommand: "slack",
          command: "whitelist-bot",
          args: {
            wId: "workspace",
            botName: "bot",
            whitelistType: "index_messages",
            providerType: "slack",
          },
        },
        result: { success: true },
        async expectEffect() {
          expect(
            await SlackBotWhitelistModel.findOne({
              where: { connectorId: slack.id },
            })
          ).toMatchObject({ botName: "bot", whitelistType: "index_messages" });
        },
      };
    },
  },
  {
    title:
      "webcrawler update-frequency when the list does not enable webcrawler",
    list: "dust_project",
    async prepare() {
      const connector = await makeAdminTarget("webcrawler");
      await WebCrawlerConfigurationModel.create({
        connectorId: connector.id,
        url: "https://example.com",
        depth: 1,
        maxPageToCrawl: 10,
        crawlMode: "website",
        crawlFrequency: "weekly",
        sitemapOnly: false,
      });
      return {
        command: {
          majorCommand: "webcrawler",
          command: "update-frequency",
          args: {
            connectorId: connector.id.toString(),
            crawlFrequency: "never",
          },
        },
        result: { success: true },
        async expectEffect() {
          expect(
            await WebCrawlerConfigurationModel.findOne({
              where: { connectorId: connector.id },
            })
          ).toMatchObject({ crawlFrequency: "never" });
        },
      };
    },
  },
];

// Commands that start no work and that the admin route does not whitelist: their guard, then their
// real handler.
const AVAILABLE_ADMIN_COMMAND_CASES: AvailableAdminCase[] = [
  {
    title: "github skip-repo when the list does not enable github",
    list: "dust_project",
    async prepare() {
      const connector = await makeAdminTarget("github");
      await GithubCodeRepositoryModel.create({
        connectorId: connector.id,
        repoId: "1",
        repoLogin: "org",
        repoName: "repo",
        sourceUrl: "https://github.com/org/repo",
        forceDailySync: false,
      });
      return {
        command: {
          majorCommand: "github",
          command: "skip-repo",
          args: {
            connectorId: connector.id.toString(),
            repoId: "1",
            skipReason: "too large",
          },
        },
        result: { success: true },
        async expectEffect() {
          expect(
            await GithubCodeRepositoryModel.findOne({
              where: { connectorId: connector.id },
            })
          ).toMatchObject({ skipReason: "too large" });
        },
      };
    },
  },
  {
    title: "gong delete-transcript when the list does not enable gong",
    list: "dust_project",
    async prepare() {
      const connector = await makeAdminTarget("gong");
      await GongTranscriptModel.create({
        connectorId: connector.id,
        callId: "call",
        callDate: Date.now(),
        title: "Call",
        url: "https://app.gong.io/call?id=call",
      });
      const deleteDocument = vi
        .spyOn(dataSources, "deleteDataSourceDocument")
        .mockResolvedValue(undefined);
      return {
        command: {
          majorCommand: "gong",
          command: "delete-transcript",
          args: { connectorId: connector.id, callId: "call" },
        },
        result: { callId: "call" },
        async expectEffect() {
          expect(deleteDocument).toHaveBeenCalledWith(
            expect.objectContaining({ dataSourceId: connector.dataSourceId }),
            `gong-transcript-${connector.id}-call`,
            expect.anything()
          );
          expect(
            await GongTranscriptModel.count({
              where: { connectorId: connector.id },
            })
          ).toBe(0);
        },
      };
    },
  },
  {
    title: "google_drive skip-file when the list does not enable google_drive",
    list: "dust_project",
    async prepare() {
      const connector = await makeAdminTarget("google_drive");
      return {
        command: {
          majorCommand: "google_drive",
          command: "skip-file",
          args: {
            connectorId: connector.id.toString(),
            fileId: "file",
            reason: "too large",
          },
        },
        result: { success: true },
        async expectEffect() {
          expect(
            await GoogleDriveFilesModel.findOne({
              where: { connectorId: connector.id },
            })
          ).toMatchObject({ driveFileId: "file", skipReason: "too large" });
        },
      };
    },
  },
  {
    title: "zendesk set-rate-limit when the list does not enable zendesk",
    list: "dust_project",
    async prepare() {
      const connector = await makeAdminTarget("zendesk");
      await ZendeskConfigurationModel.create({
        connectorId: connector.id,
        subdomain: "acme",
        retentionPeriodDays: 180,
        syncUnresolvedTickets: false,
        hideCustomerDetails: false,
        customFieldsConfig: [],
      });
      vi.spyOn(
        zendeskAccessToken,
        "getZendeskSubdomainAndAccessToken"
      ).mockResolvedValue({ accessToken: "token", subdomain: "acme" });
      return {
        command: {
          majorCommand: "zendesk",
          command: "set-rate-limit",
          args: { connectorId: connector.id, rateLimitTps: 5 },
        },
        result: { success: true },
        async expectEffect() {
          expect(
            await ZendeskConfigurationModel.findOne({
              where: { connectorId: connector.id },
            })
          ).toMatchObject({ rateLimitTransactionsPerSecond: 5 });
        },
      };
    },
  },
];

// Commands that start no work and whose handlers call their provider's API: only their guard runs.
const AVAILABLE_PROVIDER_API_COMMANDS: AdminCommandType[] = [
  {
    majorCommand: "microsoft",
    command: "check-file",
    args: { connectorId: "1", internalId: "file" },
  },
  {
    majorCommand: "salesforce",
    command: "check-connection",
    args: { wId: "workspace", dsId: "data-source" },
  },
  {
    majorCommand: "snowflake",
    command: "fetch-databases",
    args: { connectorId: 1 },
  },
  {
    majorCommand: "zendesk",
    command: "fetch-ticket",
    args: { connectorId: 1, ticketId: 1 },
  },
];

describe("admin commands that start no work", () => {
  afterEach(() => {
    vi.mocked(runCommand).mockReset();
  });

  for (const adminCase of AVAILABLE_ADMIN_API_CASES) {
    it(`runs ${adminCase.title}`, async () => {
      vi.stubEnv("CONNECTORS_ENABLED_PROVIDERS", adminCase.list);
      vi.mocked(runCommand).mockImplementation(actualRunCommand);
      const { command, result, expectEffect } = await adminCase.prepare();

      expect(
        await send(jsonRequest("POST", "/connectors/admin", command))
      ).toEqual({ status: 200, body: result });
      await expectEffect();
    });
  }

  for (const adminCase of AVAILABLE_ADMIN_COMMAND_CASES) {
    it(`runs ${adminCase.title}`, async () => {
      vi.stubEnv("CONNECTORS_ENABLED_PROVIDERS", adminCase.list);
      const { command, result, expectEffect } = await adminCase.prepare();

      expect(await checkAdmin(command)).toBeNull();
      expect(await actualRunCommand(command)).toEqual(result);
      await expectEffect();
    });
  }

  it.each(
    AVAILABLE_PROVIDER_API_COMMANDS
  )("lets $majorCommand $command through when the list does not enable $majorCommand", async (command) => {
    vi.stubEnv("CONNECTORS_ENABLED_PROVIDERS", "dust_project");

    expect(await checkAdmin(command)).toBeNull();
  });

  // The caller's SOQL can update records in Salesforce, so these require salesforce.
  it.each([
    "run-soql",
    "setup-synced-query",
  ] as const)("refuses salesforce %s when the list does not enable salesforce", async (command) => {
    vi.stubEnv("CONNECTORS_ENABLED_PROVIDERS", "dust_project");

    expect(
      await checkAdmin({
        majorCommand: "salesforce",
        command,
        args: {
          wId: "workspace",
          dsId: "data-source",
          soql: "SELECT Id FROM Account FOR VIEW",
        },
      })
    ).toEqual(notEnabled(["salesforce"]));
  });
});

type SlackProvider = Extract<ConnectorProvider, "slack" | "slack_bot">;

// Slack team `T1`, with a connector of each Slack provider in one Dust workspace and the provider
// whose bot is enabled, if any.
async function makeSlackTeam(activeBot: SlackProvider | null) {
  const makeSlackConnector = (type: SlackProvider) =>
    ConnectorResource.makeNew(
      type,
      {
        connectionId: "connection",
        workspaceAPIKey: "sk-test",
        workspaceId: "workspace",
        dataSourceId: `data-source-${type}`,
      },
      {
        autoReadChannelPatterns: [],
        botEnabled: type === activeBot,
        feedbackVisibleToAuthorOnly: true,
        restrictedSpaceAgentsEnabled: true,
        slackTeamId: "T1",
      }
    );

  return {
    slack: await makeSlackConnector("slack"),
    slack_bot: await makeSlackConnector("slack_bot"),
  };
}

// This file replaces the module wholesale for the routes.
function importActualSlackBot() {
  return vi.importActual<typeof import("@connectors/connectors/slack/bot")>(
    "@connectors/connectors/slack/bot"
  );
}

const ACTIVE_BOT_CASES: {
  // `undefined` leaves the variable unset.
  list: string | undefined;
  activeBot: SlackProvider;
  found: boolean;
}[] = [
  { list: undefined, activeBot: "slack", found: true },
  { list: undefined, activeBot: "slack_bot", found: true },
  { list: "slack,slack_bot", activeBot: "slack", found: true },
  { list: "slack,slack_bot", activeBot: "slack_bot", found: true },
  { list: "dust_project", activeBot: "slack", found: false },
  { list: "dust_project,notion", activeBot: "slack_bot", found: false },
  // Malformed lists, including lists that enable one Slack provider without the other.
  { list: "slack", activeBot: "slack", found: false },
  { list: "slack_bot", activeBot: "slack_bot", found: false },
  { list: "slack_bot,", activeBot: "slack_bot", found: false },
];

// The team's active bot is a connector of a provider the list does not enable.
const REFUSED_ACTIVE_BOTS = [
  { list: "dust_project", activeBot: "slack" },
  { list: "dust_project", activeBot: "slack_bot" },
] as const;

// Every caller of `SlackConfigurationResource.fetchByActiveBot` that can start work for the bot,
// except the slack_bot webhook's own lookups: that webhook runs only under a list that enables
// slack_bot, and so slack, which enables the active bot's type. `run` calls it for team `T1` and
// checks its answer when it finds no bot.
const ACTIVE_BOT_CALLERS: { name: string; run: () => Promise<void> }[] = [
  {
    // Used by botAnswerMessage, botReplaceMention and botValidateToolExecution, which the slack,
    // slack_bot, slack_interaction and slack_bot_interaction webhooks call.
    name: "getSlackConnector",
    async run() {
      const { getSlackConnector } = await importActualSlackBot();
      const res = await getSlackConnector({
        slackTeamId: "T1",
        slackChannel: "C1",
        slackUserId: "U1",
        slackMessageTs: "1.0",
      });
      expect(res.isErr()).toBe(true);
    },
  },
  {
    name: "botAnswerUserQuestion",
    async run() {
      const { botAnswerUserQuestion } = await importActualSlackBot();
      const res = await botAnswerUserQuestion({
        actionId: "action",
        answer: { selectedOptions: [] },
        conversationId: "conversation",
        messageId: "message",
        slackChatBotMessageId: 7,
        slackTeamId: "T1",
        slackChannel: "C1",
        slackThreadTs: "1.0",
        responseUrl: undefined,
      });
      expect(res.isErr() && res.error.message).toBe(
        "Failed to find a Slack configuration for which the bot is enabled. Slack team id: T1."
      );
    },
  },
  {
    name: "getSlackClientForTeam",
    async run() {
      await expect(getSlackClientForTeam("T1")).rejects.toThrow(
        "Failed to find Slack configuration for team T1"
      );
    },
  },
  {
    name: "submitFeedbackToAPI",
    async run() {
      await submitFeedbackToAPI({
        conversationId: "conversation",
        messageId: "message",
        workspaceId: "workspace",
        slackUserId: "U1",
        slackTeamId: "T1",
        thumbDirection: "up",
        feedbackContent: "",
        slackChannelId: "C1",
        slackMessageTs: "1.0",
        slackThreadTs: "1.0",
        responseUrl: "https://hooks.slack.com/actions/response",
      });
    },
  },
  {
    name: "isAppMentionMessage",
    async run() {
      expect(await isAppMentionMessage("<@U1> hello", "T1")).toBe(false);
    },
  },
  {
    // Run by the connectors worker for the slack webhook.
    name: "processSlackWebhookEventActivity on a direct message",
    async run() {
      await processSlackWebhookEventActivity({
        teamId: "T1",
        event: {
          type: "direct_message",
          channelId: "D1",
          ts: "1.0",
          userId: "U1",
        },
      });
    },
  },
  {
    name: "processSlackWebhookEventActivity on member_joined_channel",
    async run() {
      await processSlackWebhookEventActivity({
        teamId: "T1",
        event: { type: "member_joined_channel", channelId: "C1", userId: "U1" },
      });
    },
  },
];

describe("connectors that guarded handlers resolve beyond their route's check", () => {
  describe("the team's active Slack bot", () => {
    it.each(
      ACTIVE_BOT_CASES
    )("finds an active $activeBot bot when the list is $list: $found", async ({
      list,
      activeBot,
      found,
    }) => {
      vi.stubEnv("CONNECTORS_ENABLED_PROVIDERS", list);
      const connectors = await makeSlackTeam(activeBot);

      const slackConfig =
        await SlackConfigurationResource.fetchByActiveBot("T1");

      expect(slackConfig?.connectorId ?? null).toBe(
        found ? connectors[activeBot].id : null
      );
    });

    for (const caller of ACTIVE_BOT_CALLERS) {
      it.each(
        REFUSED_ACTIVE_BOTS
      )(`${caller.name} acts for no bot when the list is $list and the active bot is $activeBot`, async ({
        list,
        activeBot,
      }) => {
        vi.stubEnv("CONNECTORS_ENABLED_PROVIDERS", list);
        await makeSlackTeam(activeBot);

        await caller.run();

        expect(getSlackClient).not.toHaveBeenCalled();
      });
    }

    // The API refuses to start under such a list, so it changes after startup.
    it.each(
      PARTIAL_SLACK_LISTS
    )("refuses Slack bot events as misconfigured when the list becomes $list after startup", async ({
      list,
      error,
    }) => {
      vi.stubEnv("CONNECTORS_ENABLED_PROVIDERS", "slack,slack_bot");
      const api = await startApi();
      const connectors = await makeSlackTeam("slack");
      await SlackChannelModel.create({
        connectorId: connectors.slack.id,
        slackChannelId: "C1",
        slackChannelName: "general",
        private: false,
        permission: "read_write",
        agentConfigurationId: "agent",
        autoRespondWithoutMention: true,
      });
      vi.stubEnv("CONNECTORS_ENABLED_PROVIDERS", list);

      for (const event of [
        { channel_type: "im", channel: "D1" },
        { channel_type: "channel", channel: "C1" },
      ]) {
        const res = await api.send(
          jsonRequest("POST", webhookPath("slack_bot"), {
            type: "event_callback",
            team_id: "T1",
            event: {
              type: "message",
              user: "U1",
              text: "hello",
              ts: "1.0",
              ...event,
            },
          })
        );

        expect(res).toEqual(misconfigured(error));
      }
      expect(getSlackClient).not.toHaveBeenCalled();
    });
  });

  describe("POST /connectors/:connector_id/config/botEnabled on slack_bot", () => {
    it("migrates the legacy slack connector's channels when the list enables slack and slack_bot", async () => {
      vi.stubEnv("CONNECTORS_ENABLED_PROVIDERS", "slack,slack_bot");
      const connectors = await makeSlackTeam(null);

      const res = await send(
        jsonRequest(
          "POST",
          `/connectors/${connectors.slack_bot.id}/config/botEnabled`,
          { configValue: "true" }
        )
      );

      expect(res).toEqual({
        status: 200,
        body: {
          connectorId: connectors.slack_bot.id,
          configKey: "botEnabled",
          configValue: "true",
        },
      });
      expect(
        await SlackConfigurationModel.findOne({
          where: { connectorId: connectors.slack_bot.id },
        })
      ).toMatchObject({ botEnabled: true });
      expect(
        launchSlackMigrateChannelsFromLegacyBotToNewBotWorkflow
      ).toHaveBeenCalledWith(connectors.slack.id, connectors.slack_bot.id);
    });

    // The API refuses to start under such a list, so it changes after startup.
    it.each(
      PARTIAL_SLACK_LISTS
    )("neither enables the bot nor migrates when the list becomes $list after startup", async ({
      list,
      error,
    }) => {
      vi.stubEnv("CONNECTORS_ENABLED_PROVIDERS", "slack,slack_bot");
      const api = await startApi();
      const connectors = await makeSlackTeam(null);
      vi.stubEnv("CONNECTORS_ENABLED_PROVIDERS", list);

      const res = await api.send(
        jsonRequest(
          "POST",
          `/connectors/${connectors.slack_bot.id}/config/botEnabled`,
          { configValue: "true" }
        )
      );

      expect(res).toEqual(misconfigured(error));
      expect(
        await SlackConfigurationModel.findOne({
          where: { connectorId: connectors.slack_bot.id },
        })
      ).toMatchObject({ botEnabled: false });
      expect(
        launchSlackMigrateChannelsFromLegacyBotToNewBotWorkflow
      ).not.toHaveBeenCalled();
    });

    // The route refuses a list that does not enable slack_bot, so the manager is called directly.
    it("enables the bot without migrating the legacy connector's channels when the list does not enable slack", async () => {
      vi.stubEnv("CONNECTORS_ENABLED_PROVIDERS", "dust_project");
      const connectors = await makeSlackTeam(null);

      const res = await new SlackBotConnectorManager(
        connectors.slack_bot.id
      ).setConfigurationKey({ configKey: "botEnabled", configValue: "true" });

      expect(res.isOk()).toBe(true);
      expect(
        await SlackConfigurationModel.findOne({
          where: { connectorId: connectors.slack_bot.id },
        })
      ).toMatchObject({ botEnabled: true });
      expect(
        launchSlackMigrateChannelsFromLegacyBotToNewBotWorkflow
      ).not.toHaveBeenCalled();
    });
  });

  describe("POST /webhooks/:webhooks_secret/firecrawl", () => {
    function crawlStarted(connectorId: number) {
      return jsonRequest("POST", webhookPath("firecrawl"), {
        success: true,
        type: "crawl.started",
        id: "crawl",
        data: [],
        metadata: { connectorId: connectorId.toString() },
        error: null,
      });
    }

    it("refuses a body naming a connector of a provider the list does not enable", async () => {
      vi.stubEnv("CONNECTORS_ENABLED_PROVIDERS", "webcrawler");
      const connector = await makeConnector("notion");

      expect(await send(crawlStarted(connector.id))).toEqual(
        notEnabled(["notion"])
      );
      expect(launchFirecrawlCrawlStartedWorkflow).not.toHaveBeenCalled();
    });

    it("serves a body naming a connector of a provider the list enables", async () => {
      vi.stubEnv("CONNECTORS_ENABLED_PROVIDERS", "webcrawler,notion");
      vi.mocked(launchFirecrawlCrawlStartedWorkflow).mockResolvedValue(
        new Ok("workflow")
      );
      const connector = await makeConnector("notion");

      const res = await send(crawlStarted(connector.id));

      expect(res.status).toBe(200);
      expect(launchFirecrawlCrawlStartedWorkflow).toHaveBeenCalledWith(
        connector.id,
        "crawl"
      );
    });
  });
});
