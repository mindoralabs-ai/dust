import type { Server } from "node:http";
import { createServer } from "node:http";
import { parseEnabledConnectorProviders } from "@connectors/lib/enabled_connector_providers";
import { errorFromAny } from "@connectors/lib/error";
import logger from "@connectors/logger/logger";
import {
  areTemporalWorkersRunning,
  runInWorkerContext,
} from "@connectors/temporal/bundle_helper";
import type {
  WORKER_PROVIDERS,
  WorkerName,
} from "@connectors/temporal/worker_registry";
import yargs from "yargs";

/**
 * @cc [owner:jchen0824,label:error-handling] connectors-worker-selection-args
 * A bare `--workers` flag MUST parse to an empty `workers` selection, never to every worker, and an
 * omitted flag MUST leave `workers` undefined. Every given name MUST be kept, including duplicates,
 * and a name outside `allWorkers` MUST be rejected.
 */
export function workerSelectionArgs(
  argv: string[],
  allWorkers: readonly string[]
) {
  return yargs(argv)
    .option("workers", {
      alias: "w",
      type: "array",
      choices: allWorkers,
      // No yargs default: it would also replace a bare `--workers` with every worker, which must be
      // rejected as an empty selection instead. Omitting the flag still selects every worker.
      description:
        "Choose one or multiple workers to run (all workers when omitted).",
    })
    .help()
    .alias("help", "h");
}

/**
 * @cc [owner:jchen0824,label:api;performance] connectors-worker-health-port
 * An unset or empty `WORKER_HEALTH_PORT` value MUST return `undefined`, so that no health listener
 * is opened. Any other value that is not a TCP port from 1 to 65535 MUST throw.
 */
export function parseWorkerHealthPort(
  value: string | undefined
): number | undefined {
  if (value === undefined || value === "") {
    return undefined;
  }
  const port = Number(value);
  if (!Number.isSafeInteger(port) || port < 1 || port > 65535) {
    throw new Error("WORKER_HEALTH_PORT must be a valid TCP port.");
  }
  return port;
}

/**
 * @cc [owner:jchen0824,label:api;performance] connectors-worker-readyz
 * The listener MUST bind to `127.0.0.1` only, and the returned promise MUST reject on a listen
 * error. `GET /readyz` MUST return 200 only while `isShuttingDown()` is false and
 * `areTemporalWorkersRunning(workers)` is true, and 503 otherwise. Any other method or path MUST
 * return 404.
 */
export async function startWorkerHealthServer(
  port: number,
  workers: WorkerName[],
  isShuttingDown: () => boolean
): Promise<Server> {
  const server = createServer((request, response) => {
    if (request.method !== "GET" || request.url !== "/readyz") {
      response.writeHead(404).end();
      return;
    }
    response
      .writeHead(
        !isShuttingDown() && areTemporalWorkersRunning(workers) ? 200 : 503
      )
      .end();
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });

  return server;
}

/**
 * @cc [owner:jchen0824,label:error-handling;performance] connectors-worker-shutdown-signals
 * The Temporal runtime that `start_worker.ts` installs MUST receive exactly
 * `WORKER_SHUTDOWN_SIGNALS` as its `shutdownSignals`, never the SDK default, and
 * `superviseWorkers` MUST mark shutdown on each of them: a Worker that the runtime drains on one of
 * these signals then returns without being taken for a crash.
 */
export const WORKER_SHUTDOWN_SIGNALS = [
  "SIGINT",
  "SIGTERM",
  "SIGQUIT",
  "SIGUSR2",
] as const;

export type WorkerShutdownSignal = (typeof WORKER_SHUTDOWN_SIGNALS)[number];

type WorkerSupervision = {
  runWorker: (worker: WorkerName) => Promise<void>;
  // Connector providers that each worker does work for.
  workerProviders: typeof WORKER_PROVIDERS;
  // Raw `CONNECTORS_ENABLED_PROVIDERS` value.
  enabledProviders: string | undefined;
  // Raw `WORKER_HEALTH_PORT` value.
  healthPort: string | undefined;
  onceSignal: (signal: WorkerShutdownSignal, listener: () => void) => void;
  exit: (code: number) => void;
};

// Rejects a selected worker when the allowlist enables none of the providers it does work for.
function checkWorkersProvidersEnabled(
  workers: WorkerName[],
  workerProviders: typeof WORKER_PROVIDERS,
  enabledProviders: string | undefined
) {
  const enabledRes = parseEnabledConnectorProviders(enabledProviders);
  if (enabledRes.isErr()) {
    throw new Error(
      `Invalid connectors configuration: ${enabledRes.error.message}`
    );
  }
  const enabled = enabledRes.value;
  if (enabled === null) {
    return;
  }

  const refused = workers.filter(
    (worker) => !workerProviders[worker].some((p) => enabled.has(p))
  );
  if (refused.length > 0) {
    throw new Error(
      `CONNECTORS_ENABLED_PROVIDERS enables no provider of these workers: ${refused
        .map((worker) => `${worker} (${workerProviders[worker].join(", ")})`)
        .join("; ")}.`
    );
  }
}

/**
 * @cc [owner:jchen0824,label:error-handling;performance] connectors-worker-fail-fast-health
 * The returned promise MUST reject before any worker starts when `workers` is empty or contains
 * duplicates, when `healthPort` is invalid, or when the health listener cannot listen. Each selected
 * worker runs inside `runInWorkerContext` with its own name. If a selected worker throws, or returns
 * before any signal of `WORKER_SHUTDOWN_SIGNALS` was received through `onceSignal`,
 * `Error running <worker> worker.` MUST be logged and `exit(1)` called.
 */
/**
 * @cc [owner:jchen0824,label:security;error-handling] connectors-worker-enabled-providers
 * When `enabledProviders` is set, the returned promise MUST reject before any signal listener,
 * health listener or worker starts if `parseEnabledConnectorProviders` returns an error for it, or
 * if it enables none of the providers that `workerProviders` lists for a selected worker. A selected
 * worker for which it enables at least one of those providers MUST NOT be refused for its
 * providers. When `enabledProviders` is unset, no worker is refused for its providers.
 */
/**
 * @cc [owner:jchen0824,label:api;performance] connectors-worker-health-listener
 * The health listener from `startWorkerHealthServer` MUST be listening before any worker starts when
 * `healthPort` is set and not empty, and MUST NOT be opened otherwise. Once any signal of
 * `WORKER_SHUTDOWN_SIGNALS` was received through `onceSignal`, `GET /readyz` MUST return 503 while
 * the listener stays open.
 */
/**
 * @cc [owner:jchen0824,label:error-handling;performance] connectors-worker-signal-defers-to-temporal
 * Receiving any signal of `WORKER_SHUTDOWN_SIGNALS` through `onceSignal`, at any phase, MUST NOT
 * call `exit` and MUST NOT stop or wait for any worker: it only marks shutdown. Signal-driven
 * shutdown belongs to the Temporal runtime that `start_worker.ts` installs, which also stops a
 * Worker whose `run()` starts after the signal. A selected worker that returns after the signal
 * MUST NOT cause `exit(1)`.
 */
export async function superviseWorkers(
  workers: WorkerName[],
  {
    runWorker,
    workerProviders,
    enabledProviders,
    healthPort,
    onceSignal,
    exit,
  }: WorkerSupervision
): Promise<void> {
  if (workers.length === 0 || new Set(workers).size !== workers.length) {
    throw new Error("Select at least one Temporal worker without duplicates.");
  }
  checkWorkersProvidersEnabled(workers, workerProviders, enabledProviders);

  let shuttingDown = false;
  const markShuttingDown = () => {
    shuttingDown = true;
  };
  for (const signal of WORKER_SHUTDOWN_SIGNALS) {
    onceSignal(signal, markShuttingDown);
  }

  const port = parseWorkerHealthPort(healthPort);
  const healthServer =
    port === undefined
      ? undefined
      : await startWorkerHealthServer(port, workers, () => shuttingDown);

  const exitOnWorkerError = (worker: WorkerName, err: unknown) => {
    logger.error(errorFromAny(err), `Error running ${worker} worker.`);
    exit(1);
  };

  // Start all workers in parallel
  const promises = workers.map((worker) =>
    Promise.resolve()
      .then(() => runInWorkerContext(worker, () => runWorker(worker)))
      .then(
        () => {
          if (!shuttingDown) {
            exitOnWorkerError(
              worker,
              new Error(`${worker} worker stopped unexpectedly.`)
            );
          }
        },
        (err) => exitOnWorkerError(worker, err)
      )
  );

  // Wait for all workers to complete
  await Promise.all(promises);
  healthServer?.close();
}
