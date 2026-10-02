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
 * The providers that an admin command requires. A handler starts work for a connector or provider
 * when it starts, signals, restarts or unpauses a workflow or schedule, syncs, upserts into (or
 * re-parents in) a Dust data source, or calls the provider's API to change provider state.
 * - `available`: none. The handler starts no work: it reads (Dust-side state, Temporal, or a
 *   provider's API without changing provider state), stores Dust-side state, or pauses, stops or
 *   deletes (connectors, workflows, Dust documents or rows) without starting or signalling a
 *   workflow.
 * - `none`: its major command's provider, for a major command that is a provider (`notion`,
 *   `slack`, ...). The handler starts work only for connectors of that provider: it looks them up
 *   by that type, or refuses another type before any side effect.
 * - `named_connector`: its major command's provider when that is a provider, and the type of the
 *   connector that its `connectorId`, or its `wId` and `dsId`, name. The handler finds that
 *   connector whatever its type, and starts work for it with its major command's provider's
 *   workflows, API or data source documents.
 * - `provider_arg`: only the provider that its `arg` argument names. The handler starts work only
 *   for the connectors of that provider, which it looks up by that type, so it requires its major
 *   command's provider only when the argument names it.
 * - `providers`: only `providers`, the types by which it looks up the connectors it starts work
 *   for. They include its major command's provider only when it starts work for that provider's
 *   connectors.
 */
type AdminCommandTarget =
  | { kind: "available" }
  | { kind: "none" }
  | { kind: "named_connector" }
  | { kind: "provider_arg"; arg: "provider" | "providerType" }
  | { kind: "providers"; providers: readonly ConnectorProvider[] };

const AVAILABLE = { kind: "available" } as const;
const NONE = { kind: "none" } as const;
const NAMED_CONNECTOR = { kind: "named_connector" } as const;

// Keyed by every command of `AdminCommandSchema`, so that a command added upstream fails
// type-checking here until it is classified. A major command that is not a provider has no `none`
// entry.
type AdminCommandTargets = {
  [C in AdminCommandType as C["majorCommand"]]: Record<
    C["command"],
    C["majorCommand"] extends ConnectorProvider
      ? AdminCommandTarget
      : Exclude<AdminCommandTarget, { kind: "none" }>
  >;
};

/**
 * @cc [owner:jchen0824,label:security] admin-command-targets
 * For every request, the providers that each command's entry requires MUST include every provider
 * that its handler (`runCommand` in `@connectors/lib/cli`, the provider `lib/cli` it calls, and
 * what they call) can start work for, itself or for its connectors, as `AdminCommandTarget`
 * defines starting work. The entry is `available` only when the handler starts no work whatever
 * its arguments: a handler that starts work only for some arguments (a flag, a value that
 * increases), or that has a code path that might start work, is classified as starting work. The
 * entry is `named_connector` when the handler starts work for a connector that it finds by
 * `connectorId`, or by `wId` and `dsId`, without refusing another type before any side effect. A
 * handler that starts work only for connectors that it looks up by the type an argument names, or
 * by fixed types that are not just its major command's provider, MUST have a `provider_arg` entry,
 * or a `providers` entry listing exactly those types. A command without a handler fails before
 * any side effect; its entry is the one that a handler doing what its name says would have. A
 * change to a handler, including adding one, MUST re-classify its command in the same change.
 */
export const ADMIN_COMMAND_TARGETS: AdminCommandTargets = {
  batch: {
    "full-resync": { kind: "provider_arg", arg: "provider" },
    "restart-all": { kind: "provider_arg", arg: "provider" },
    "resume-all": { kind: "provider_arg", arg: "provider" },
    // Stops the connectors of `provider` only.
    "stop-all": AVAILABLE,
  },
  // Every command refuses a connector that is not a Confluence connector.
  confluence: {
    "check-page-exists": AVAILABLE,
    "check-space-access": AVAILABLE,
    // No handler: the command fails. It would store a Dust-side setting.
    "ignore-near-rate-limit": AVAILABLE,
    me: AVAILABLE,
    "resolve-space-from-url": AVAILABLE,
    // Stores the page's skip reason, after reading the page from Confluence.
    "skip-page": AVAILABLE,
    "sync-space": NONE,
    "unignore-near-rate-limit": AVAILABLE,
    // Re-parents the space's pages and folders in the data source.
    "update-parents": NONE,
    "upsert-page": NONE,
    "upsert-pages": NONE,
  },
  connectors: {
    stop: AVAILABLE,
    pause: AVAILABLE,
    // No handler: the command fails.
    delete: AVAILABLE,
    "get-parents": AVAILABLE,
    "set-error": AVAILABLE,
    "clear-error": AVAILABLE,
    unpause: NAMED_CONNECTOR,
    resume: NAMED_CONNECTOR,
    "full-resync": NAMED_CONNECTOR,
    restart: NAMED_CONNECTOR,
    "set-permission": NAMED_CONNECTOR,
    "garbage-collect": NAMED_CONNECTOR,
  },
  // Every command finds its connector by `connectorId`, refusing a non-GitHub one, or by `wId` and
  // `dsId`, whatever its type. The skip, list and clear commands read or store Dust-side state.
  github: {
    "resync-repo": NAMED_CONNECTOR,
    "resync-repo-code": NAMED_CONNECTOR,
    "code-sync": NAMED_CONNECTOR,
    "sync-issue": NAMED_CONNECTOR,
    "force-daily-code-sync": NAMED_CONNECTOR,
    "skip-issue": AVAILABLE,
    "skip-repo": AVAILABLE,
    "unskip-repo": AVAILABLE,
    "list-skipped-repos": AVAILABLE,
    "skip-code-file": AVAILABLE,
    "unskip-code-file": AVAILABLE,
    "clear-installation-id": AVAILABLE,
  },
  // Every command refuses a connector that is not a Gong connector.
  gong: {
    "force-resync": NONE,
    "delete-transcript": AVAILABLE,
  },
  // `getConnector` finds a connector by `connectorId`, or by `wId` and `dsId`, whatever its type.
  google_drive: {
    "garbage-collect-all": NONE,
    "restart-all-incremental-sync-workflows": NONE,
    "get-file-metadata": AVAILABLE,
    "check-file": AVAILABLE,
    // With `--fix true`, deletes files from and upserts folders into the data source.
    "get-google-parents": NAMED_CONNECTOR,
    "clean-invalid-parents": NAMED_CONNECTOR,
    "upsert-file": NAMED_CONNECTOR,
    "update-core-parents": NAMED_CONNECTOR,
    "start-full-sync": NAMED_CONNECTOR,
    "start-incremental-sync": NAMED_CONNECTOR,
    "skip-file": AVAILABLE,
    "list-labels": AVAILABLE,
    "export-folder-structure": AVAILABLE,
    // No handler: the command fails. It would register Google webhooks for the named connector.
    "restart-google-webhooks": NAMED_CONNECTOR,
    "register-webhook": NAMED_CONNECTOR,
    "register-all-webhooks": NAMED_CONNECTOR,
  },
  // Every command refuses a connector that is not an Intercom connector.
  intercom: {
    // Clears the articles' upsert timestamps only; it starts no sync.
    "force-resync-articles": AVAILABLE,
    "force-resync-all-conversations": NONE,
    "check-conversation": AVAILABLE,
    "fetch-conversation": AVAILABLE,
    "fetch-articles": AVAILABLE,
    "check-missing-conversations": AVAILABLE,
    "check-teams": AVAILABLE,
    "set-conversations-sliding-window": AVAILABLE,
    "get-conversations-sliding-window": AVAILABLE,
    "search-conversations": AVAILABLE,
    "restart-schedules": NONE,
  },
  // `getConnector` finds a connector by `connectorId`, or by `wId` and `dsId`, whatever its type.
  microsoft: {
    "garbage-collect-all": NONE,
    "restart-all-incremental-sync-workflows": NONE,
    "check-file": AVAILABLE,
    "start-full-sync": NAMED_CONNECTOR,
    "start-incremental-sync": NAMED_CONNECTOR,
    // Reads the file from Microsoft and stores its skip reason.
    "skip-file": AVAILABLE,
    "sync-node": NAMED_CONNECTOR,
    // Reads the nodes from Microsoft and stores their parents in the node table only.
    "update-parent-in-node-table": AVAILABLE,
    "update-core-parents": NAMED_CONNECTOR,
    // No handler: the command fails. It would read parents.
    "get-parents": AVAILABLE,
  },
  // Every command looks up Notion connectors by type.
  notion: {
    "skip-page": AVAILABLE,
    "skip-database": AVAILABLE,
    "upsert-page": NONE,
    "upsert-database": NONE,
    "search-pages": AVAILABLE,
    "update-core-parents": NONE,
    "check-url": AVAILABLE,
    "find-url": AVAILABLE,
    // Deletes through the deletion crawl workflow, which it signals with start.
    "delete-url": NONE,
    me: AVAILABLE,
    "stop-all-garbage-collectors": AVAILABLE,
    // No handler: the command fails. It would re-parent documents in the data source.
    "update-parents-fields": NONE,
    "clear-parents-last-updated-at": AVAILABLE,
    "update-orphaned-resources-parents": NONE,
    // Sends only GET requests, and POST requests to `search`.
    "api-request": AVAILABLE,
  },
  // Every command refuses a connector that is not a Salesforce connector.
  salesforce: {
    "check-connection": AVAILABLE,
    // Sends the caller's SOQL unchanged, and `FOR VIEW` or `FOR REFERENCE` updates records'
    // view dates in Salesforce.
    "run-soql": NONE,
    // Runs the caller's SOQL as `run-soql` does and, with `--execute`, stores it for the next sync.
    "setup-synced-query": NONE,
    "sync-query": NONE,
  },
  // `run-auto-join` starts work only for the connector of the provider that `providerType` names,
  // and refuses one other than `slack` or `slack_bot` before any side effect. `cutover-legacy-bot`
  // migrates the `slack` connector's channels to the `slack_bot` connector. The other commands look
  // up Slack connectors by type. `enable-bot`, `whitelist-bot` and `whitelist-domains` store
  // Dust-side configuration only; `skip-channel` and `unskip-channel` start a garbage collection or
  // a sync when the channel is synced.
  slack: {
    "add-channel-to-sync": NONE,
    "cutover-legacy-bot": {
      kind: "providers",
      providers: ["slack", "slack_bot"],
    },
    "enable-bot": AVAILABLE,
    "remove-channel-from-sync": NONE,
    "skip-channel": NONE,
    "skip-thread": AVAILABLE,
    "sync-channel": NONE,
    "sync-channel-metadata": NONE,
    "sync-thread": NONE,
    // No handler: the command fails. It would uninstall the app from teams.
    "uninstall-for-unknown-team-ids": AVAILABLE,
    "unskip-channel": NONE,
    "run-auto-join": { kind: "provider_arg", arg: "providerType" },
    "whitelist-bot": AVAILABLE,
    "whitelist-domains": AVAILABLE,
    "check-channel": AVAILABLE,
    "delete-conversation": AVAILABLE,
  },
  // Every command refuses a connector that is not a Snowflake connector.
  snowflake: {
    "fetch-databases": AVAILABLE,
    "fetch-schemas": AVAILABLE,
    "fetch-tables": AVAILABLE,
  },
  // Read Temporal state or terminate a workflow.
  temporal: {
    "check-queue": AVAILABLE,
    "find-unprocessed-workflows": AVAILABLE,
    "stop-workflow": AVAILABLE,
  },
  webcrawler: {
    // Starts the scheduler of webcrawler connectors.
    "start-scheduler": NONE,
    // Store the crawler configuration of the connector that `connectorId` names.
    "update-frequency": AVAILABLE,
    "set-actions": AVAILABLE,
  },
  // Every command refuses a connector that is not a Zendesk connector.
  zendesk: {
    "check-is-admin": AVAILABLE,
    "count-tickets": AVAILABLE,
    "resync-tickets": NONE,
    "fetch-ticket": AVAILABLE,
    "fetch-brand": AVAILABLE,
    "resync-help-centers": NONE,
    "resync-brand-metadata": NONE,
    "sync-ticket": NONE,
    "get-retention-period": AVAILABLE,
    // Starts a ticket sync when the retention period increases.
    "set-retention-period": NONE,
    "add-organization-tag": AVAILABLE,
    "remove-organization-tag": AVAILABLE,
    "add-ticket-tag": AVAILABLE,
    "remove-ticket-tag": AVAILABLE,
    "set-rate-limit": AVAILABLE,
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
// its major command. A `none` entry of a major command that is not a provider resolves to none.
async function resolveAdminCommandProviders(
  majorProviders: readonly ConnectorProvider[],
  target: Exclude<AdminCommandTarget, { kind: "available" }>,
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
 * Returns `Ok` for an admin command whose entry in `ADMIN_COMMAND_TARGETS` is `available`, without
 * reading `CONNECTORS_ENABLED_PROVIDERS`. For any other command, when the variable is set, returns
 * `Ok` only when the entry resolves to at least one provider, the list enables every provider that
 * the entry requires, and the entry requires no other provider: its major command's provider only
 * for a `none` or `named_connector` entry. It refuses a command without an entry, and one whose
 * entry does not resolve. When the variable is unset, it returns `Ok`. The connectors are looked
 * up only when the list is set.
 */
export async function checkAdminCommandProvidersEnabled(
  adminCommand: AdminCommandType
): Promise<Result<void, ConnectorsAPIErrorWithStatusCode>> {
  const { majorCommand, command, args } = adminCommand;
  const target = adminCommandTarget(adminCommand);
  if (target?.kind === "available") {
    return new Ok(undefined);
  }

  const majorProviders: ConnectorProvider[] = isKnownConnectorProvider(
    majorCommand
  )
    ? [majorCommand]
    : [];
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
