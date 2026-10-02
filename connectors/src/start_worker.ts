import {
  superviseWorkers,
  workerSelectionArgs,
} from "@connectors/temporal/worker_health";
import type { WorkerName } from "@connectors/temporal/worker_registry";
import {
  ALL_WORKERS,
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
});

async function runWorkers(workers: WorkerName[]) {
  await superviseWorkers(workers, {
    runWorker: (worker) => workerFunctions[worker](),
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
