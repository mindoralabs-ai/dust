import { AsyncLocalStorage } from "node:async_hooks";
import logger from "@app/logger/logger";
import { isDevelopment } from "@app/types/shared/env";
import { normalizeError } from "@app/types/shared/utils/error_utils";
import { Worker } from "@temporalio/worker";
import { readFileSync } from "fs";
import path from "path";

import type { WorkerName } from "./worker_registry";

// Webpack is per Worker.create(workflowsPath). Running those in parallel
// re-walks the same graph ~30 times and saturates disk. Queue creates in
// dev; worker.run() still overlaps once each bundle is ready.
let workflowBundleQueue: Promise<void> = Promise.resolve();

const workerNameContext = new AsyncLocalStorage<WorkerName>();
const runningWorkers = new Map<WorkerName, Set<Worker>>();

/**
 * @cc [owner:jchen0824,label:performance;error-handling] selected-worker-readiness
 * A selected worker is ready only after its Temporal Worker has entered RUNNING;
 * an uncreated, stopped, draining, or failed Worker must never report ready.
 */
export function areTemporalWorkersRunning(workerNames: WorkerName[]): boolean {
  return (
    workerNames.length > 0 &&
    workerNames.every((name) => {
      const workers = runningWorkers.get(name);
      return (
        workers &&
        workers.size > 0 &&
        [...workers].every((worker) => worker.getState() === "RUNNING")
      );
    })
  );
}

export function runInWorkerContext<T>(workerName: WorkerName, run: () => T): T {
  return workerNameContext.run(workerName, run);
}

export function createTemporalWorker(
  ...args: Parameters<typeof Worker.create>
): ReturnType<typeof Worker.create> {
  const workerName = workerNameContext.getStore();
  const register = (worker: Worker) => {
    if (workerName) {
      const workers = runningWorkers.get(workerName) ?? new Set<Worker>();
      workers.add(worker);
      runningWorkers.set(workerName, workers);
    }
    return worker;
  };
  if (!isDevelopment() || process.env.USE_TEMPORAL_BUNDLES === "true") {
    return Worker.create(...args).then(register);
  }

  const worker = workflowBundleQueue
    .then(() => Worker.create(...args))
    .then(register);
  workflowBundleQueue = worker.then(
    () => undefined,
    () => undefined
  );
  return worker;
}

/**
 * Returns the workflow configuration for a worker.
 * In production, uses pre-built bundles. In development, uses runtime bundling.
 *
 * @param workerName The worker name
 * @param workflowsPath The RESOLVED path to workflows (use require.resolve("./workflows") from worker)
 */
export function getWorkflowConfig({
  workerName,
  getWorkflowsPath,
}: {
  workerName: WorkerName;
  getWorkflowsPath: () => string;
}) {
  if (!isDevelopment() || process.env.USE_TEMPORAL_BUNDLES === "true") {
    const bundlePath = path.join(
      __dirname,
      "../dist/temporal-bundles",
      `${workerName}.bundle.js`
    );

    try {
      const code = readFileSync(bundlePath, "utf8");
      return { workflowBundle: { code } };
    } catch (error) {
      logger.error(
        {
          error: normalizeError(error),
          workerName,
        },
        "Failed to read workflow bundle, falling back to runtime bundling"
      );

      // Fallback to runtime bundling if bundle read fails.
      return { workflowsPath: getWorkflowsPath() };
    }
  }

  // Development: use runtime bundling
  return { workflowsPath: getWorkflowsPath() };
}
