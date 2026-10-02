import { checkResolvedConnectorProvidersEnabled } from "@connectors/api/enabled_connector_providers";
import { runCommand } from "@connectors/lib/cli";
import { isKnownConnectorProvider } from "@connectors/lib/enabled_connector_providers";
import { apiError, withLogging } from "@connectors/logger/withlogging";
import { ConnectorResource } from "@connectors/resources/connector_resource";
import type {
  AdminCommandType,
  AdminResponseType,
  ConnectorsAPIErrorWithStatusCode,
  WithConnectorsAPIErrorReponse,
} from "@connectors/types";
import { AdminCommandSchema } from "@connectors/types";
import type { ConnectorProvider, Result } from "@dust-tt/client";
import { assertNever, Err, Ok } from "@dust-tt/client";
import type { Request, Response } from "express";
import { fromError } from "zod-validation-error";

/**
 * The providers that an admin command requires:
 * - `none`: its major command's provider when that is a provider (`notion`, `slack`, ...), and
 *   nothing otherwise. The command stops, pauses, deletes, reads or stores Dust-side state only,
 *   or acts only on connectors of its major command's provider: it looks them up by that type, or
 *   refuses another type before any side effect.
 * - `named_connector`: its major command's provider when that is a provider, and the type of the
 *   connector that its `connectorId`, or its `wId` and `dsId`, name. The command finds that
 *   connector whatever its type, and acts on it with its major command's provider's API,
 *   workflows or tables.
 * - `provider_arg`: only the provider that its `arg` argument names. The command acts only on the
 *   connectors of that provider, which it looks up by that type, so it requires its major
 *   command's provider only when the argument names it.
 * - `providers`: only `providers`, whose connectors it looks up by type. They include its major
 *   command's provider only when it acts on that provider's connectors.
 */
type AdminCommandTarget =
  | { kind: "none" }
  | { kind: "named_connector" }
  | { kind: "provider_arg"; arg: "provider" | "providerType" }
  | { kind: "providers"; providers: readonly ConnectorProvider[] };

const NONE: AdminCommandTarget = { kind: "none" };
const NAMED_CONNECTOR: AdminCommandTarget = { kind: "named_connector" };

// Keyed by every command of `AdminCommandSchema`, so that a command added upstream fails
// type-checking here until it is classified.
type AdminCommandTargets = {
  [C in AdminCommandType as C["majorCommand"]]: Record<
    C["command"],
    AdminCommandTarget
  >;
};

/**
 * @cc [owner:jchen0824,label:security] admin-command-targets
 * For every request, the providers that each command's entry requires MUST include every provider
 * whose connectors its handler (`runCommand` in `@connectors/lib/cli`, and the provider `lib/cli`
 * it calls) can start work for, or whose API it calls with a connector's credentials. The entry is
 * `named_connector` when the handler finds a connector by `connectorId`, or by `wId` and `dsId`,
 * without refusing another type before any side effect. A handler that acts on connectors (starts
 * work for them, calls their API or changes their configuration) only after looking them up by
 * the type an argument names, or by fixed types that are not just its major command's provider,
 * MUST have a `provider_arg` entry, or a `providers` entry listing exactly those types: such a
 * request requires its major command's provider only when the handler acts on that provider's
 * connectors. A change to a handler MUST re-classify its command in the same change.
 */
export const ADMIN_COMMAND_TARGETS: AdminCommandTargets = {
  batch: {
    "full-resync": { kind: "provider_arg", arg: "provider" },
    "restart-all": { kind: "provider_arg", arg: "provider" },
    "resume-all": { kind: "provider_arg", arg: "provider" },
    "stop-all": NONE,
  },
  // Every command refuses a connector that is not a Confluence connector.
  confluence: {
    "check-page-exists": NONE,
    "check-space-access": NONE,
    "ignore-near-rate-limit": NONE,
    me: NONE,
    "resolve-space-from-url": NONE,
    "skip-page": NONE,
    "sync-space": NONE,
    "unignore-near-rate-limit": NONE,
    "update-parents": NONE,
    "upsert-page": NONE,
    "upsert-pages": NONE,
  },
  connectors: {
    stop: NONE,
    pause: NONE,
    // No handler: the command fails.
    delete: NONE,
    "get-parents": NONE,
    // Store the connector's error state only.
    "set-error": NONE,
    "clear-error": NONE,
    unpause: NAMED_CONNECTOR,
    resume: NAMED_CONNECTOR,
    "full-resync": NAMED_CONNECTOR,
    restart: NAMED_CONNECTOR,
    "set-permission": NAMED_CONNECTOR,
    "garbage-collect": NAMED_CONNECTOR,
  },
  // Every command finds its connector by `connectorId`, refusing a non-GitHub one, or by `wId` and
  // `dsId`, whatever its type.
  github: {
    "resync-repo": NAMED_CONNECTOR,
    "resync-repo-code": NAMED_CONNECTOR,
    "code-sync": NAMED_CONNECTOR,
    "sync-issue": NAMED_CONNECTOR,
    "force-daily-code-sync": NAMED_CONNECTOR,
    "skip-issue": NAMED_CONNECTOR,
    "skip-repo": NAMED_CONNECTOR,
    "unskip-repo": NAMED_CONNECTOR,
    "list-skipped-repos": NAMED_CONNECTOR,
    "skip-code-file": NAMED_CONNECTOR,
    "unskip-code-file": NAMED_CONNECTOR,
    "clear-installation-id": NAMED_CONNECTOR,
  },
  // Every command refuses a connector that is not a Gong connector.
  gong: {
    "force-resync": NONE,
    "delete-transcript": NONE,
  },
  // `getConnector` finds a connector by `connectorId`, or by `wId` and `dsId`, whatever its type.
  google_drive: {
    "garbage-collect-all": NONE,
    "restart-all-incremental-sync-workflows": NONE,
    "get-file-metadata": NAMED_CONNECTOR,
    "check-file": NAMED_CONNECTOR,
    "get-google-parents": NAMED_CONNECTOR,
    "clean-invalid-parents": NAMED_CONNECTOR,
    "upsert-file": NAMED_CONNECTOR,
    "update-core-parents": NAMED_CONNECTOR,
    "start-full-sync": NAMED_CONNECTOR,
    "start-incremental-sync": NAMED_CONNECTOR,
    "skip-file": NAMED_CONNECTOR,
    "list-labels": NAMED_CONNECTOR,
    "export-folder-structure": NAMED_CONNECTOR,
    // No handler: the command fails. Classified as the commands that use `getConnector`.
    "restart-google-webhooks": NAMED_CONNECTOR,
    "register-webhook": NAMED_CONNECTOR,
    "register-all-webhooks": NAMED_CONNECTOR,
  },
  // Every command refuses a connector that is not an Intercom connector.
  intercom: {
    "force-resync-articles": NONE,
    "force-resync-all-conversations": NONE,
    "check-conversation": NONE,
    "fetch-conversation": NONE,
    "fetch-articles": NONE,
    "check-missing-conversations": NONE,
    "check-teams": NONE,
    "set-conversations-sliding-window": NONE,
    "get-conversations-sliding-window": NONE,
    "search-conversations": NONE,
    "restart-schedules": NONE,
  },
  // `getConnector` finds a connector by `connectorId`, or by `wId` and `dsId`, whatever its type.
  microsoft: {
    "garbage-collect-all": NONE,
    "restart-all-incremental-sync-workflows": NONE,
    "check-file": NAMED_CONNECTOR,
    "start-full-sync": NAMED_CONNECTOR,
    "start-incremental-sync": NAMED_CONNECTOR,
    "skip-file": NAMED_CONNECTOR,
    "sync-node": NAMED_CONNECTOR,
    "update-parent-in-node-table": NAMED_CONNECTOR,
    "update-core-parents": NAMED_CONNECTOR,
    // No handler: the command fails. Classified as the commands that use `getConnector`.
    "get-parents": NAMED_CONNECTOR,
  },
  // Every command looks up Notion connectors by type.
  notion: {
    "skip-page": NONE,
    "skip-database": NONE,
    "upsert-page": NONE,
    "upsert-database": NONE,
    "search-pages": NONE,
    "update-core-parents": NONE,
    "check-url": NONE,
    "find-url": NONE,
    "delete-url": NONE,
    me: NONE,
    "stop-all-garbage-collectors": NONE,
    "update-parents-fields": NONE,
    "clear-parents-last-updated-at": NONE,
    "update-orphaned-resources-parents": NONE,
    "api-request": NONE,
  },
  // Every command refuses a connector that is not a Salesforce connector.
  salesforce: {
    "check-connection": NONE,
    "run-soql": NONE,
    "setup-synced-query": NONE,
    "sync-query": NONE,
  },
  // `run-auto-join` and `whitelist-bot` act only on the connector of the provider that
  // `providerType` names, and refuse one other than `slack` or `slack_bot` before any side effect.
  // `whitelist-domains` acts only on the `slack_bot` connector, and `cutover-legacy-bot` on the
  // `slack` and `slack_bot` connectors. The other commands look up Slack connectors by type
  // (`uninstall-for-unknown-team-ids` has no handler).
  slack: {
    "add-channel-to-sync": NONE,
    "cutover-legacy-bot": {
      kind: "providers",
      providers: ["slack", "slack_bot"],
    },
    "enable-bot": NONE,
    "remove-channel-from-sync": NONE,
    "skip-channel": NONE,
    "skip-thread": NONE,
    "sync-channel": NONE,
    "sync-channel-metadata": NONE,
    "sync-thread": NONE,
    "uninstall-for-unknown-team-ids": NONE,
    "unskip-channel": NONE,
    "run-auto-join": { kind: "provider_arg", arg: "providerType" },
    "whitelist-bot": { kind: "provider_arg", arg: "providerType" },
    "whitelist-domains": { kind: "providers", providers: ["slack_bot"] },
    "check-channel": NONE,
    "delete-conversation": NONE,
  },
  // Every command refuses a connector that is not a Snowflake connector.
  snowflake: {
    "fetch-databases": NONE,
    "fetch-schemas": NONE,
    "fetch-tables": NONE,
  },
  // Read Temporal state or stop a workflow.
  temporal: {
    "check-queue": NONE,
    "find-unprocessed-workflows": NONE,
    "stop-workflow": NONE,
  },
  webcrawler: {
    // Starts the scheduler of webcrawler connectors.
    "start-scheduler": NONE,
    // Find the connector by `connectorId`, whatever its type.
    "update-frequency": NAMED_CONNECTOR,
    "set-actions": NAMED_CONNECTOR,
  },
  // Every command refuses a connector that is not a Zendesk connector.
  zendesk: {
    "check-is-admin": NONE,
    "count-tickets": NONE,
    "resync-tickets": NONE,
    "fetch-ticket": NONE,
    "fetch-brand": NONE,
    "resync-help-centers": NONE,
    "resync-brand-metadata": NONE,
    "sync-ticket": NONE,
    "get-retention-period": NONE,
    "set-retention-period": NONE,
    "add-organization-tag": NONE,
    "remove-organization-tag": NONE,
    "add-ticket-tag": NONE,
    "remove-ticket-tag": NONE,
    "set-rate-limit": NONE,
  },
};

function adminCommandTarget({
  majorCommand,
  command,
}: AdminCommandType): AdminCommandTarget | null {
  const targets: Partial<Record<string, AdminCommandTarget>> =
    ADMIN_COMMAND_TARGETS[majorCommand];
  return Object.hasOwn(targets, command) ? (targets[command] ?? null) : null;
}

// Only digits: Postgres reads `1_0` or `0x1A` as other ids than `parseInt` does, and the
// `connectors` command passes `connectorId` to Postgres as it is.
function parseConnectorId(value: unknown): number | null {
  const id =
    typeof value === "string" && /^[0-9]+$/.test(value) ? Number(value) : value;
  return typeof id === "number" && Number.isSafeInteger(id) ? id : null;
}

// The types of the connectors that `connectorId`, or `wId` and `dsId`, name. Fails unless every
// identifier given names a connector, so that a handler reading one of them alone, or in another
// order, cannot reach an unchecked connector.
async function namedConnectorProviders(
  args: Readonly<Record<string, unknown>>
): Promise<Result<ConnectorProvider[], Error>> {
  const { connectorId, wId, dsId } = args;
  if (connectorId === undefined && dsId === undefined) {
    return new Err(new Error("it names no connector"));
  }

  const providers: ConnectorProvider[] = [];
  if (connectorId !== undefined) {
    const id = parseConnectorId(connectorId);
    if (id === null) {
      return new Err(new Error(`invalid connectorId: ${connectorId}`));
    }
    const connector = await ConnectorResource.fetchById(id);
    if (!connector) {
      return new Err(new Error(`no connector has id ${id}`));
    }
    providers.push(connector.type);
  }
  if (dsId !== undefined) {
    if (typeof wId !== "string" || typeof dsId !== "string") {
      return new Err(new Error("wId and dsId must both be strings"));
    }
    const connector = await ConnectorResource.findByDataSource({
      workspaceId: wId,
      dataSourceId: dsId,
    });
    if (!connector) {
      return new Err(
        new Error(`no connector has workspace ${wId} and data source ${dsId}`)
      );
    }
    providers.push(connector.type);
  }

  return new Ok(providers);
}

// The providers that `target` requires, as `AdminCommandTarget` describes, given the providers of
// its major command.
async function resolveAdminCommandProviders(
  majorProviders: readonly ConnectorProvider[],
  target: AdminCommandTarget,
  args: Readonly<Record<string, unknown>>
): Promise<Result<readonly ConnectorProvider[], Error>> {
  switch (target.kind) {
    case "none":
      return new Ok(majorProviders);
    case "named_connector": {
      const namedRes = await namedConnectorProviders(args);
      if (namedRes.isErr()) {
        return namedRes;
      }
      return new Ok([...majorProviders, ...namedRes.value]);
    }
    case "provider_arg": {
      const provider = args[target.arg];
      if (typeof provider !== "string" || !isKnownConnectorProvider(provider)) {
        return new Err(
          new Error(`${target.arg} names no connector provider: ${provider}`)
        );
      }
      return new Ok([provider]);
    }
    case "providers":
      return new Ok(target.providers);
    default:
      assertNever(target);
  }
}

/**
 * @cc [owner:jchen0824,label:security] admin-command-provider-guard
 * When `CONNECTORS_ENABLED_PROVIDERS` is set, returns `Ok` for an admin command only when the list
 * enables every provider that its entry in `ADMIN_COMMAND_TARGETS` requires, and requires no
 * other provider: its major command's provider, when that is a provider, only for a `none` or
 * `named_connector` entry. It refuses a command without an entry, and one whose entry does not
 * resolve. A command whose major command is not a provider and whose entry is `none` is `Ok`
 * whatever the list. The connectors are looked up only when the list is set.
 */
export async function checkAdminCommandProvidersEnabled(
  adminCommand: AdminCommandType
): Promise<Result<void, ConnectorsAPIErrorWithStatusCode>> {
  const { majorCommand, command, args } = adminCommand;
  const target = adminCommandTarget(adminCommand);
  const majorProviders: ConnectorProvider[] = isKnownConnectorProvider(
    majorCommand
  )
    ? [majorCommand]
    : [];
  if (target?.kind === "none" && majorProviders.length === 0) {
    return new Ok(undefined);
  }

  return checkResolvedConnectorProvidersEnabled(async () => {
    if (!target) {
      return new Err(
        new Error(`admin command ${majorCommand} ${command} is not classified`)
      );
    }
    return resolveAdminCommandProviders(majorProviders, target, args);
  });
}

const whitelistedCommands = [
  {
    majorCommand: "notion",
    command: "check-url",
  },
  {
    majorCommand: "notion",
    command: "find-url",
  },
  {
    majorCommand: "notion",
    command: "delete-url",
  },
  {
    majorCommand: "notion",
    command: "upsert-page",
  },
  {
    majorCommand: "notion",
    command: "upsert-database",
  },
  {
    majorCommand: "notion",
    command: "clear-parents-last-updated-at",
  },
  {
    majorCommand: "notion",
    command: "update-orphaned-resources-parents",
  },
  {
    majorCommand: "notion",
    command: "api-request",
  },
  {
    majorCommand: "slack",
    command: "whitelist-bot",
  },
  {
    majorCommand: "slack",
    command: "skip-channel",
  },
  {
    majorCommand: "slack",
    command: "unskip-channel",
  },
  {
    majorCommand: "slack",
    command: "run-auto-join",
  },
  {
    majorCommand: "slack",
    command: "check-channel",
  },
  {
    majorCommand: "slack",
    command: "delete-conversation",
  },
  {
    majorCommand: "connectors",
    command: "set-error",
  },
  {
    majorCommand: "connectors",
    command: "clear-error",
  },
  {
    majorCommand: "zendesk",
    command: "fetch-ticket",
  },
  {
    majorCommand: "webcrawler",
    command: "update-frequency",
  },
  {
    majorCommand: "webcrawler",
    command: "set-actions",
  },
  {
    majorCommand: "confluence",
    command: "check-page-exists",
  },
  {
    majorCommand: "google_drive",
    command: "upsert-file",
  },
  {
    majorCommand: "intercom",
    command: "get-conversations-sliding-window",
  },
  {
    majorCommand: "intercom",
    command: "set-conversations-sliding-window",
  },
];

const _adminAPIHandler = async (
  req: Request<Record<string, string>, AdminResponseType, AdminCommandType>,
  res: Response<WithConnectorsAPIErrorReponse<AdminResponseType>>
) => {
  const adminCommandValidation = AdminCommandSchema.safeParse(req.body);

  if (!adminCommandValidation.success) {
    return apiError(req, res, {
      api_error: {
        type: "invalid_request_error",
        message: `Invalid request body: ${fromError(adminCommandValidation.error).toString()}`,
      },
      status_code: 400,
    });
  }

  const adminCommand = adminCommandValidation.data;

  if (
    !whitelistedCommands.some(
      (cmd) =>
        cmd.majorCommand === adminCommand.majorCommand &&
        cmd.command === adminCommand.command
    )
  ) {
    return apiError(req, res, {
      api_error: {
        type: "invalid_request_error",
        message: `Command not whitelisted: ${adminCommand.majorCommand} ${adminCommand.command}`,
      },
      status_code: 400,
    });
  }

  const enabledRes = await checkAdminCommandProvidersEnabled(adminCommand);
  if (enabledRes.isErr()) {
    return apiError(req, res, enabledRes.error);
  }

  switch (req.method) {
    case "POST": {
      const result = await runCommand(adminCommand);
      return res.json(result);
    }
    default: {
      return apiError(req, res, {
        api_error: {
          type: "invalid_request_error",
          message: `Invalid request method: ${req.method}`,
        },
        status_code: 400,
      });
    }
  }
};

export const adminAPIHandler = withLogging(_adminAPIHandler);
