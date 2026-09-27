import { createServer } from "node:http";
import config from "@app/lib/api/config";
import { stopPocRuntime } from "@app/lib/api/dust_poc_runtime";
import logger from "@app/logger/logger";
import {
  areTemporalWorkersRunning,
  runInWorkerContext,
} from "@app/temporal/bundle_helper";
import { runDustPocUsageReconciler } from "@app/temporal/dust_usage/worker";
import type { WorkerName } from "@app/temporal/worker_registry";
import {
  ALL_WORKERS,
  ALL_WORKERS_BUT_RELOCATION,
  workerFunctions,
} from "@app/temporal/worker_registry";
import { getWorkerRuntimeOptions } from "@app/temporal/worker_runtime_options";
import { setupGlobalErrorHandler } from "@app/types/shared/utils/global_error_handler";
import type { Logger, LogLevel } from "@temporalio/common/lib/logger";
import { Runtime } from "@temporalio/worker/lib/runtime";
import yargs from "yargs";
import { hideBin } from "yargs/helpers";

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

// Install once per process — before creating Worker/Client.
Runtime.install(
  getWorkerRuntimeOptions(
    pinoAdapter,
    config.getTemporalDatadogMetricsEnabled()
  )
);

async function runWorkers(workers: WorkerName[]) {
  if (workers.length === 0 || new Set(workers).size !== workers.length) {
    throw new Error("Select at least one Temporal worker without duplicates.");
  }
  let shuttingDown = false;
  const healthServer = createServer((request, response) => {
    if (request.method !== "GET" || request.url !== "/readyz") {
      response.writeHead(404).end();
      return;
    }
    response
      .writeHead(
        !shuttingDown && areTemporalWorkersRunning(workers) ? 200 : 503
      )
      .end();
  });
  const healthPort = Number(process.env.WORKER_HEALTH_PORT ?? "8081");
  if (!Number.isInteger(healthPort) || healthPort < 1 || healthPort > 65535) {
    throw new Error("WORKER_HEALTH_PORT must be a valid TCP port.");
  }
  await new Promise<void>((resolve, reject) => {
    healthServer.once("error", reject);
    healthServer.listen(healthPort, "127.0.0.1", () => {
      healthServer.off("error", reject);
      resolve();
    });
  });

  const reconcilerAbort = new AbortController();
  const stopReconciler = () => {
    shuttingDown = true;
    reconcilerAbort.abort();
    void stopPocRuntime().catch((err) =>
      logger.error({ error: err }, "Error stopping Dust POC route resolver.")
    );
  };
  process.once("SIGTERM", stopReconciler);
  process.once("SIGINT", stopReconciler);
  void runDustPocUsageReconciler(reconcilerAbort.signal).catch((err) =>
    logger.error({ error: err }, "Error running Dust POC usage reconciler.")
  );
  let remainingWorkers = workers.length;
  for (const worker of workers) {
    void runInWorkerContext(worker, () => workerFunctions[worker]())
      .then(() => {
        if (!shuttingDown) {
          throw new Error(`${worker} worker stopped unexpectedly.`);
        }
        remainingWorkers -= 1;
        if (remainingWorkers === 0) {
          healthServer.close();
        }
      })
      .catch((err) => {
        logger.error({ error: err }, `Error running ${worker} worker.`);
        process.exit(1);
      });
  }
}

yargs(hideBin(process.argv))
  .option("workers", {
    alias: "w",
    type: "array",
    choices: ALL_WORKERS,
    default: ALL_WORKERS_BUT_RELOCATION,
    demandOption: true,
    description: "Choose one or multiple workers to run.",
  })
  .help()
  .alias("help", "h")
  .parseAsync()
  .then(async (args) => runWorkers(args.workers as WorkerName[]))
  .catch((err) => {
    logger.error({ error: err }, "Error running workers");
    process.exit(1);
  });
