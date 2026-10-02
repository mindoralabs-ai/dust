import {
  superviseWorkers,
  WORKER_SHUTDOWN_SIGNALS,
  workerSelectionArgs,
} from "@connectors/temporal/worker_health";
import type { WorkerName } from "@connectors/temporal/worker_registry";
import {
  ALL_WORKERS,
  WORKER_PROVIDERS,
  workerFunctions,
} from "@connectors/temporal/worker_registry";
import {
  EnvironmentConfig,
  isDevelopment,
  setupGlobalErrorHandler,
} from "@connectors/types";
import { closeRedisClients } from "@connectors/types/shared/redis_client";
import type { Logger, LogLevel } from "@temporalio/common/lib/logger";
import { Runtime } from "@temporalio/worker/lib/runtime";
import { hideBin } from "yargs/helpers";

import { apiConfig } from "./lib/api/config";
import { errorFromAny } from "./lib/error";
import logger from "./logger/logger";

setupGlobalErrorHandler(logger);

const pinoAdapter: Logger = {
  log: (level: LogLevel, msg: string, meta: Record<string, unknown>) =>
    ({
      TRACE: logger.trace,
      DEBUG: logger.debug,
      INFO: logger.info,
      WARN: logger.warn,
      ERROR: logger.error,
    })[level](meta ?? {}, msg),
  info: (msg: string, meta: Record<string, unknown>) =>
    logger.info(meta ?? {}, msg),
  warn: (msg: string, meta: Record<string, unknown>) =>
    logger.warn(meta ?? {}, msg),
  error: (msg: string, meta: Record<string, unknown>) =>
    logger.error(meta ?? {}, msg),
  debug: (msg: string, meta: Record<string, unknown>) =>
    logger.debug(meta ?? {}, msg),
  trace: (msg: string, meta: Record<string, unknown>) =>
    logger.trace(meta ?? {}, msg),
};

// Install once per process — before creating Worker/Client
Runtime.install({
  logger: pinoAdapter,
  // `superviseWorkers` marks shutdown on the same signals.
  shutdownSignals: [...WORKER_SHUTDOWN_SIGNALS],
});

/**
 * @cc [owner:jchen0824,label:security] connectors-start-worker-enabled-providers
 * `superviseWorkers` MUST receive `WORKER_PROVIDERS` and this process's raw
 * `CONNECTORS_ENABLED_PROVIDERS` value, as read by `apiConfig.getEnabledConnectorProviders`.
 */
async function runWorkers(workers: WorkerName[]) {
  await superviseWorkers(workers, {
    runWorker: (worker) => workerFunctions[worker](),
    workerProviders: WORKER_PROVIDERS,
    enabledProviders: apiConfig.getEnabledConnectorProviders(),
    healthPort: EnvironmentConfig.getOptionalEnvVariable("WORKER_HEALTH_PORT"),
    onceSignal: (signal, listener) => process.once(signal, listener),
    exit: (code) => process.exit(code),
  });

  // Shutdown Temporal native runtime *once*
  // Fix the issue of connectors hanging after receiving SIGINT in dev
  // We don't have this issue with front workers, and deserve an investigation (no appetite for now)
  if (isDevelopment()) {
    await Runtime.instance().shutdown();
  }

  // Shutdown potential Redis clients.
  await closeRedisClients();
}

workerSelectionArgs(hideBin(process.argv), ALL_WORKERS)
  .parseAsync()
  .then(async (args) =>
    runWorkers((args.workers ?? ALL_WORKERS) as WorkerName[])
  )
  .catch((err) => {
    logger.error(errorFromAny(err), "Error running workers");
    process.exit(1);
  });
