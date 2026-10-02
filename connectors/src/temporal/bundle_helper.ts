import { AsyncLocalStorage } from "node:async_hooks";
import logger from "@connectors/logger/logger";
import { normalizeError } from "@connectors/types/api";
import { isDevelopment } from "@connectors/types/shared/env";
import { Worker } from "@temporalio/worker";
import { readFileSync } from "fs";
import path from "path";

import type { WorkerName } from "./worker_registry";

const workerNameContext = new AsyncLocalStorage<WorkerName>();
const createdWorkers = new Map<WorkerName, Set<Worker>>();

/**
 * @cc [owner:jchen0824,label:performance;error-handling] connectors-selected-worker-readiness
 * Selected workers are ready only when the selection is non-empty and every selected worker name
 * has at least one Temporal Worker created through `createTemporalWorker`, all in state `RUNNING`.
 * A worker name with no tracked Worker, or with an initializing, draining, stopped or failed
 * Worker, MUST never report ready.
 */
export function areTemporalWorkersRunning(workerNames: WorkerName[]): boolean {
  return (
    workerNames.length > 0 &&
    workerNames.every((name) => {
      const workers = createdWorkers.get(name);
      return (
        workers !== undefined &&
        workers.size > 0 &&
        [...workers].every((worker) => worker.getState() === "RUNNING")
      );
    })
  );
}

/**
 * Runs `run` with `workerName` as the worker context used by `createTemporalWorker`.
 */
export function runInWorkerContext<T>(workerName: WorkerName, run: () => T): T {
  return workerNameContext.run(workerName, run);
}

/**
 * Creates a Temporal Worker. When called inside `runInWorkerContext`, the Worker is tracked under
 * that worker name for `areTemporalWorkersRunning`.
 */
export async function createTemporalWorker(
  ...args: Parameters<typeof Worker.create>
): Promise<Worker> {
  const workerName = workerNameContext.getStore();
  const worker = await Worker.create(...args);
  if (workerName) {
    const workers = createdWorkers.get(workerName) ?? new Set<Worker>();
    workers.add(worker);
    createdWorkers.set(workerName, workers);
  }
  return worker;
}

/**
 * Returns the workflow configuration for a worker.
 * In production, uses pre-built bundles. In development, uses runtime bundling.
 *
 * @param workerName The worker name
 * @param getWorkflowsPath Lazy getter for the RESOLVED path to workflows
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

  // Development: use runtime bundling.
  return { workflowsPath: getWorkflowsPath() };
}
