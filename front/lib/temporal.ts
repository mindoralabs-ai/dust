import { Context } from "@temporalio/activity";
import type {
  ConnectionOptions,
  WorkflowClientInterceptor,
  WorkflowExecutionDescription,
} from "@temporalio/client";
import { Client, Connection, WorkflowNotFoundError } from "@temporalio/client";
import { OpenTelemetryWorkflowClientInterceptor } from "@temporalio/interceptors-opentelemetry";
import { NativeConnection } from "@temporalio/worker";
import fs from "fs-extra";

type TemporalNamespaces = "agent" | "connectors" | "front" | "relocation";
type TemporalTlsMode = "disabled" | "server" | "mutual";
export const temporalWorkspaceToEnvVar: Record<TemporalNamespaces, string> = {
  agent: "TEMPORAL_AGENT_NAMESPACE",
  connectors: "TEMPORAL_CONNECTORS_NAMESPACE",
  front: "TEMPORAL_NAMESPACE",
  relocation: "TEMPORAL_RELOCATION_NAMESPACE",
};

export const TEMPORAL_MAXED_CACHED_WORKFLOWS = 50;

// This is a singleton connection to the Temporal server.
const TEMPORAL_CLIENTS: Partial<Record<TemporalNamespaces, Client>> = {};

export async function getTemporalClientForNamespace(
  namespace: TemporalNamespaces,
  workflows: WorkflowClientInterceptor[] = []
) {
  const cachedClient = TEMPORAL_CLIENTS[namespace];
  if (cachedClient) {
    return cachedClient;
  }
  const envVarForTemporalNamespace = temporalWorkspaceToEnvVar[namespace];
  const connectionOptions = await getConnectionOptions(
    envVarForTemporalNamespace
  );
  const connection = await Connection.connect(connectionOptions);
  const client = new Client({
    connection,
    namespace: process.env[envVarForTemporalNamespace],
    interceptors: {
      workflow: workflows,
    },
  });
  TEMPORAL_CLIENTS[namespace] = client;

  return client;
}

/**
 * @cc [owner:jchen0824,label:security;error-handling] temporal-custom-address-explicit-security
 * When `TEMPORAL_ADDRESS` is set, the connection MUST require the selected namespace and an
 * explicit valid `TEMPORAL_TLS_MODE`, reject settings that contradict that mode, and MUST NOT fall
 * back to the Temporal Cloud address.
 */
/**
 * @cc [owner:jchen0824,label:architecture] temporal-address-independent-of-namespace
 * `TEMPORAL_ADDRESS` MUST be used unchanged for every Temporal namespace so API clients and workers
 * select namespaces independently from the shared server endpoint.
 */
export async function getConnectionOptions(
  envVarForTemporalNamespace: string = temporalWorkspaceToEnvVar["front"]
): Promise<
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
  } = process.env;
  const temporalNamespace = process.env[envVarForTemporalNamespace];

  if (
    !TEMPORAL_ADDRESS &&
    (TEMPORAL_TLS_MODE || TEMPORAL_TLS_CA_PATH || TEMPORAL_TLS_SERVER_NAME)
  ) {
    throw new Error(
      "TEMPORAL_ADDRESS is required when custom Temporal TLS settings are set"
    );
  }

  if (TEMPORAL_ADDRESS) {
    if (!temporalNamespace) {
      throw new Error(
        `${envVarForTemporalNamespace} is required when TEMPORAL_ADDRESS is set`
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
    }
  }

  const isDeployed = ["production", "staging"].includes(NODE_ENV);

  if (!isDeployed) {
    return {};
  }

  if (!TEMPORAL_CERT_PATH || !TEMPORAL_CERT_KEY_PATH || !temporalNamespace) {
    throw new Error(
      `TEMPORAL_CERT_PATH, TEMPORAL_CERT_KEY_PATH and ${envVarForTemporalNamespace} are required ` +
        `when NODE_ENV=${NODE_ENV}, but not found in the environment`
    );
  }

  const cert = await fs.readFile(TEMPORAL_CERT_PATH);
  const key = await fs.readFile(TEMPORAL_CERT_KEY_PATH);

  return {
    address: `${temporalNamespace}.tmprl.cloud:7233`,
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

export async function getTemporalAgentWorkerConnection(): Promise<{
  connection: NativeConnection;
  namespace: string | undefined;
}> {
  const connectionOptions = await getConnectionOptions(
    temporalWorkspaceToEnvVar["agent"]
  );
  const connection = await NativeConnection.connect(connectionOptions);
  return { connection, namespace: process.env.TEMPORAL_AGENT_NAMESPACE };
}

export async function getTemporalWorkerConnection(): Promise<{
  connection: NativeConnection;
  namespace: string | undefined;
}> {
  const connectionOptions = await getConnectionOptions();
  const connection = await NativeConnection.connect(connectionOptions);
  return { connection, namespace: process.env.TEMPORAL_NAMESPACE };
}

export async function getTemporalClientForAgentNamespace() {
  return getTemporalClientForNamespace("agent", [
    new OpenTelemetryWorkflowClientInterceptor(),
  ]);
}

export async function getTemporalClientForFrontNamespace() {
  return getTemporalClientForNamespace("front", [
    new OpenTelemetryWorkflowClientInterceptor(),
  ]);
}

export async function getTemporalClientForConnectorsNamespace() {
  return getTemporalClientForNamespace("connectors");
}

export async function describeTemporalWorkflow(
  temporalClient: Client,
  {
    workflowId,
  }: {
    workflowId: string;
  }
): Promise<WorkflowExecutionDescription | null> {
  try {
    return await temporalClient.workflow.getHandle(workflowId).describe();
  } catch (err) {
    if (err instanceof WorkflowNotFoundError) {
      return null;
    }

    throw err;
  }
}

/**
 * Checks if there are any running upsert workflows for a specific datasource.
 * Returns the count of running workflows.
 */
export async function checkRunningUpsertWorkflows({
  workspaceId,
  dataSourceId,
}: {
  workspaceId: string;
  dataSourceId: string;
}): Promise<number> {
  const client = await getTemporalClientForFrontNamespace();

  // Query for all Active upsert workflows for this datasource
  const query = `WorkflowId STARTS_WITH "upsert-queue-document-${workspaceId}-${dataSourceId}-" AND ExecutionStatus="Running"`;
  const workflows = client.workflow.list({ query });

  let count = 0;
  for await (const _workflow of workflows) {
    count++;
  }

  return count;
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
