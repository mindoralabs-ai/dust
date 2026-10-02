import { execFile } from "node:child_process";
import { createHmac } from "node:crypto";
import { once } from "node:events";
import { Server } from "node:http";
import net from "node:net";
import path from "node:path";
import { promisify } from "node:util";
import { parseEnabledConnectorProviders } from "@connectors/api/enabled_connector_providers";
import { startServer } from "@connectors/api_server";
import { DustProjectConnectorManager } from "@connectors/connectors/dust_project";
import { launchGithubIssueSyncWorkflow } from "@connectors/connectors/github/temporal/client";
import type { BaseConnectorManager } from "@connectors/connectors/interface";
import { ConnectorManagerError } from "@connectors/connectors/interface";
import { processNotionWebhookEvent } from "@connectors/connectors/notion/lib/webhooks";
import { botReplaceMention } from "@connectors/connectors/slack/bot";
import { getSlackClient } from "@connectors/connectors/slack/lib/slack_client";
import {
  launchJoinChannelWorkflow,
  launchSlackWebhookEventWorkflow,
} from "@connectors/connectors/slack/temporal/client";
import { WebcrawlerConnectorManager } from "@connectors/connectors/webcrawler";
import { launchFirecrawlCrawlStartedWorkflow } from "@connectors/connectors/webcrawler/temporal/client";
import { runCommand } from "@connectors/lib/cli";
import { GithubConnectorStateModel } from "@connectors/lib/models/github";
import { NotionConnectorStateModel } from "@connectors/lib/models/notion";
import { SlackChannelModel } from "@connectors/lib/models/slack";
import { ConnectorModel } from "@connectors/resources/storage/models/connector_model";
import type { ConnectorConfiguration } from "@connectors/types";
import * as connectorsTypes from "@connectors/types";
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
];

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

// Starts the real API (`startServer`) on an ephemeral port. Started inside a test, it serves
// requests within that test's database transaction.
async function startApi() {
  const signalListeners = SIGNALS.map((s) => process.listeners(s));
  const listen = vi.spyOn(net.Server.prototype, "listen");
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

  return {
    app: server.listeners("request")[0],
    async send(request: ApiRequest): Promise<ApiResponse> {
      const res = await fetch(
        `http://127.0.0.1:${address.port}${request.path}`,
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

// Every route whose handler calls `checkConnectorProviderEnabled` or is wrapped by
// `withEnabledConnectorProviders`.
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
    route: "POST /connectors/admin",
    provider: "notion",
    servesDustProject: false,
    async prepare() {
      vi.mocked(runCommand).mockResolvedValue({ success: true });
      const command = {
        majorCommand: "notion",
        command: "check-url",
        args: { url: "https://www.notion.so/page" },
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
    disablingList: "slack_bot",
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
    disablingList: "slack_bot",
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
    disablingList: "slack_bot",
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
    disablingList: "slack",
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
    disablingList: "slack",
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

  it("exits the API entrypoint with that error before it listens", {
    timeout: 60_000,
  }, async () => {
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
          CONNECTORS_ENABLED_PROVIDERS: "dust_project,notio",
        },
        // A process that started listening would never exit.
        timeout: 50_000,
      }
    );

    await expect(run).rejects.toMatchObject({
      code: 1,
      stderr: expect.stringContaining(
        "Invalid connectors configuration: CONNECTORS_ENABLED_PROVIDERS names an unknown connector provider: notio"
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
    });
  }

  it("serves the slack_bot webhook when the list enables slack_bot", async () => {
    vi.stubEnv("CONNECTORS_ENABLED_PROVIDERS", "slack_bot");

    expect(
      await send(
        jsonRequest("POST", webhookPath("slack_bot"), {
          type: "url_verification",
          challenge: "challenge",
        })
      )
    ).toEqual({ status: 200, body: { challenge: "challenge" } });
  });

  it("serves the slack webhook when the list enables slack", async () => {
    vi.stubEnv("CONNECTORS_ENABLED_PROVIDERS", "slack");
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

  it("links channels of a slack_bot connector when the list enables slack_bot", async () => {
    vi.stubEnv("CONNECTORS_ENABLED_PROVIDERS", "slack_bot");
    const route = GUARDED_ROUTES.find(
      (r) => r.route === "PATCH /slack/channels/linked_with_agent"
    );
    if (!route) {
      throw new Error("linked_with_agent route missing from the table");
    }
    const prepared = await route.prepare("slack_bot");

    await prepared.expectHandled(await send(prepared.request));
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
