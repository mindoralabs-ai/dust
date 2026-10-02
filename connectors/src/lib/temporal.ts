import logger from "@connectors/logger/logger";
import type { ModelId } from "@connectors/types";
import { assertNever } from "@dust-tt/client";
import { Context } from "@temporalio/activity";
import {
  Client,
  Connection,
  type ConnectionOptions,
  defaultPayloadConverter,
  WorkflowNotFoundError,
} from "@temporalio/client";
import { defineSearchAttributeKey } from "@temporalio/common";
import { NativeConnection } from "@temporalio/worker";
import fs from "fs-extra";

type TemporalTlsMode = "disabled" | "server" | "mutual";

// Define the connectorId search attribute key for typed access.
export const connectorIdSearchAttribute = defineSearchAttributeKey<"INT">(
  "connectorId",
  "INT"
);

// Assuming one cached workflows takes 2MB on average,
// we can cache 292 workflows in 4096MB, which is the max heap size
// we give to our temporal workers.
// Add some margin to it, so we don't hit the limit, and we get to 200.
export const TEMPORAL_MAXED_CACHED_WORKFLOWS = 200;

// This is a singleton connection to the Temporal server.
let TEMPORAL_CLIENT: Client | undefined;

const CONNECTOR_ID_CACHE: Record<string, ModelId> = {};

export async function getTemporalClient(): Promise<Client> {
  if (TEMPORAL_CLIENT) {
    return TEMPORAL_CLIENT;
  }
  const connectionOptions = await getConnectionOptions();
  const connection = await Connection.connect(connectionOptions);
  const client = new Client({
    connection,
    namespace: process.env.TEMPORAL_NAMESPACE,
  });
  TEMPORAL_CLIENT = client;

  return client;
}

/**
 * @cc [owner:jchen0824,label:security;error-handling] connectors-temporal-custom-address-explicit-security
 * When `TEMPORAL_ADDRESS` is set, the connection MUST require `TEMPORAL_NAMESPACE` and an explicit
 * valid `TEMPORAL_TLS_MODE`, reject settings that contradict that mode, and MUST NOT fall back to
 * the Temporal Cloud address. `TEMPORAL_TLS_MODE`, `TEMPORAL_TLS_CA_PATH` or
 * `TEMPORAL_TLS_SERVER_NAME` without `TEMPORAL_ADDRESS` MUST be rejected.
 */
/**
 * @cc [owner:jchen0824,label:architecture] connectors-temporal-address-independent-of-namespace
 * `TEMPORAL_ADDRESS` MUST be used unchanged as the address for API clients and workers, and
 * MUST NOT be derived from `TEMPORAL_NAMESPACE`.
 */
export async function getConnectionOptions(): Promise<
  | {
      address: string;
      tls: ConnectionOptions["tls"];
    }
  | Record<string, never>
> {
  const {
    NODE_ENV = "development",
    TEMPORAL_ADDRESS,
    TEMPORAL_TLS_MODE,
    TEMPORAL_CERT_PATH,
    TEMPORAL_CERT_KEY_PATH,
    TEMPORAL_TLS_CA_PATH,
    TEMPORAL_TLS_SERVER_NAME,
    TEMPORAL_NAMESPACE,
  } = process.env;

  if (
    !TEMPORAL_ADDRESS &&
    (TEMPORAL_TLS_MODE || TEMPORAL_TLS_CA_PATH || TEMPORAL_TLS_SERVER_NAME)
  ) {
    throw new Error(
      "TEMPORAL_ADDRESS is required when custom Temporal TLS settings are set"
    );
  }

  if (TEMPORAL_ADDRESS) {
    if (!TEMPORAL_NAMESPACE) {
      throw new Error(
        "TEMPORAL_NAMESPACE is required when TEMPORAL_ADDRESS is set"
      );
    }
    if (!TEMPORAL_TLS_MODE) {
      throw new Error(
        "TEMPORAL_TLS_MODE is required when TEMPORAL_ADDRESS is set"
      );
    }
    if (!isTemporalTlsMode(TEMPORAL_TLS_MODE)) {
      throw new Error(
        "TEMPORAL_TLS_MODE must be one of: disabled, server, mutual"
      );
    }

    switch (TEMPORAL_TLS_MODE) {
      case "disabled":
        if (
          TEMPORAL_CERT_PATH ||
          TEMPORAL_CERT_KEY_PATH ||
          TEMPORAL_TLS_CA_PATH ||
          TEMPORAL_TLS_SERVER_NAME
        ) {
          throw new Error(
            "Temporal TLS certificate settings cannot be used when TEMPORAL_TLS_MODE=disabled"
          );
        }
        return { address: TEMPORAL_ADDRESS, tls: false };
      case "server": {
        if (TEMPORAL_CERT_PATH || TEMPORAL_CERT_KEY_PATH) {
          throw new Error(
            "TEMPORAL_CERT_PATH and TEMPORAL_CERT_KEY_PATH require TEMPORAL_TLS_MODE=mutual"
          );
        }
        const serverRootCACertificate = TEMPORAL_TLS_CA_PATH
          ? await fs.readFile(TEMPORAL_TLS_CA_PATH)
          : undefined;
        return {
          address: TEMPORAL_ADDRESS,
          tls: {
            serverNameOverride: TEMPORAL_TLS_SERVER_NAME,
            serverRootCACertificate,
          },
        };
      }
      case "mutual": {
        if (!TEMPORAL_CERT_PATH || !TEMPORAL_CERT_KEY_PATH) {
          throw new Error(
            "TEMPORAL_CERT_PATH and TEMPORAL_CERT_KEY_PATH are required when TEMPORAL_TLS_MODE=mutual"
          );
        }
        const [cert, key, serverRootCACertificate] = await Promise.all([
          fs.readFile(TEMPORAL_CERT_PATH),
          fs.readFile(TEMPORAL_CERT_KEY_PATH),
          TEMPORAL_TLS_CA_PATH
            ? fs.readFile(TEMPORAL_TLS_CA_PATH)
            : Promise.resolve(undefined),
        ]);
        return {
          address: TEMPORAL_ADDRESS,
          tls: {
            clientCertPair: { crt: cert, key },
            serverNameOverride: TEMPORAL_TLS_SERVER_NAME,
            serverRootCACertificate,
          },
        };
      }
      default:
        assertNever(TEMPORAL_TLS_MODE);
    }
  }

  const isDeployed = ["production", "staging"].includes(NODE_ENV);

  if (!isDeployed) {
    return {};
  }

  if (!TEMPORAL_CERT_PATH || !TEMPORAL_CERT_KEY_PATH || !TEMPORAL_NAMESPACE) {
    throw new Error(
      "TEMPORAL_CERT_PATH, TEMPORAL_CERT_KEY_PATH and TEMPORAL_NAMESPACE are required " +
        `when NODE_ENV=${NODE_ENV}, but not found in the environment`
    );
  }

  const cert = await fs.readFile(TEMPORAL_CERT_PATH);
  const key = await fs.readFile(TEMPORAL_CERT_KEY_PATH);

  return {
    address: `${TEMPORAL_NAMESPACE}.tmprl.cloud:7233`,
    tls: {
      clientCertPair: {
        crt: cert,
        key,
      },
    },
  };
}

function isTemporalTlsMode(value: string): value is TemporalTlsMode {
  return ["disabled", "server", "mutual"].includes(value);
}

// Programmatically retrieves the arguments that were passed to a Temporal workflow.
async function getTemporalWorkflowArguments({
  workflowId,
}: {
  workflowId: string;
}): Promise<unknown[]> {
  const client = await getTemporalClient();

  // Fetch the first event.
  const response = await client.workflowService.getWorkflowExecutionHistory({
    namespace: process.env.TEMPORAL_NAMESPACE,
    execution: { workflowId },
    maximumPageSize: 1,
  });
  const startEvent = response.history?.events?.[0];

  const payloads =
    startEvent?.workflowExecutionStartedEventAttributes?.input?.payloads ?? [];

  // This will always return an array, each entry matches a line of what's under Input in the UI under the event.
  return payloads.map((p) => defaultPayloadConverter.fromPayload(p));
}

export async function getTemporalWorkerConnection(): Promise<{
  connection: NativeConnection;
  namespace: string | undefined;
}> {
  const connectionOptions = await getConnectionOptions();
  const connection = await NativeConnection.connect(connectionOptions);
  return { connection, namespace: process.env.TEMPORAL_NAMESPACE };
}

export async function getConnectorId(
  workflowId: string
): Promise<ModelId | null> {
  if (!CONNECTOR_ID_CACHE[workflowId]) {
    const client = await getTemporalClient();
    const workflowHandle = client.workflow.getHandle(workflowId);
    const described = await workflowHandle.describe();

    let connectorId: ModelId | null = null;

    // Try to get connectorId from memo first.
    if (described.memo && described.memo.connectorId) {
      const memoValue = described.memo.connectorId;
      if (typeof memoValue === "number") {
        connectorId = memoValue;
      } else if (typeof memoValue === "string") {
        connectorId = parseInt(memoValue, 10);
      }
    }

    // Fallback to typedSearchAttributes if memo doesn't have connectorId.
    if (connectorId === null) {
      connectorId =
        described.typedSearchAttributes?.get(connectorIdSearchAttribute) ??
        null;
    }

    // If we still don't have a connector ID, look it up in the arguments of the workflow.
    if (connectorId === null) {
      const args = await getTemporalWorkflowArguments({ workflowId });

      if (
        typeof args[0] === "object" &&
        args[0] !== null &&
        "connectorId" in args[0] &&
        typeof args[0].connectorId === "number"
      ) {
        connectorId = args[0].connectorId;
      }
    }

    if (connectorId !== null) {
      CONNECTOR_ID_CACHE[workflowId] = connectorId;
    }
  }
  return CONNECTOR_ID_CACHE[workflowId] || null;
}

export async function terminateWorkflow(workflowId: string, reason?: string) {
  const client = await getTemporalClient();
  try {
    const workflowHandle = client.workflow.getHandle(workflowId);
    await workflowHandle.terminate(reason);
    return true;
  } catch (e) {
    if (!(e instanceof WorkflowNotFoundError)) {
      throw e;
    }
  }
  return false;
}

export async function terminateAllWorkflowsForConnectorId({
  connectorId,
  stopReason,
}: {
  connectorId: ModelId;
  stopReason: string;
}) {
  const client = await getTemporalClient();

  const workflowInfos = client.workflow.list({
    query: `ExecutionStatus = 'Running' AND connectorId = ${connectorId}`,
  });

  logger.info(
    {
      connectorId,
    },
    "About to terminate all workflows for connectorId"
  );

  for await (const handle of workflowInfos) {
    logger.info(
      { connectorId, workflowId: handle.workflowId },
      "Terminating Temporal workflow"
    );

    const workflowHandle = client.workflow.getHandle(handle.workflowId);
    try {
      await workflowHandle.terminate(stopReason);
    } catch (err) {
      // Intentionally ignore errors that indicate the workflow no longer exists.
      if (err instanceof WorkflowNotFoundError) {
        continue;
      }
      throw err;
    }
  }

  return;
}

// This function allows to heartbeat back to the temporal workflow, but also
// awaits a temporal sleep(0), which allows to throw an exception if the activity should be cancelled.
export async function heartbeat() {
  try {
    Context.current();
  } catch (_error) {
    // If we're not in a temporal context, Context.current() will throw
    // In this case, we just return without doing anything
    // This allows the function to be called safely outside of temporal activities
    return;
  }
  Context.current().heartbeat();
  await Context.current().sleep(0);
}
