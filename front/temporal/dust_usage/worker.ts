import { setTimeout } from "node:timers/promises";
import { dustPocMode } from "@app/lib/api/dust_poc_mode";
import {
  pocRouteResolverForMaintenance,
  pocRoutesForMaintenance,
} from "@app/lib/api/dust_poc_runtime";
import { runFrontUsageDeliveryBatch } from "@app/lib/api/usage_delivery";
import { sendFrontUsageHeartbeat } from "@app/lib/api/usage_heartbeat";
import logger from "@app/logger/logger";

/**
 * @cc [label:security;backend] dust-front-reconciler-no-model-effect
 * The POC worker may claim and deliver frozen accounting rows, including
 * while provider I/O is disabled. It must never invoke or retry a model.
 */
export async function runDustPocUsageReconciler(
  signal?: AbortSignal
): Promise<void> {
  if (!dustPocMode()) {
    return;
  }
  async function runLoop(task: () => Promise<void>, intervalMs: number) {
    while (!signal?.aborted) {
      try {
        await task();
      } catch {
        logger.warn("Dust POC usage reconciliation unavailable");
      }
      try {
        await setTimeout(intervalMs, undefined, { signal });
      } catch {
        if (!signal?.aborted) {
          throw new Error("Dust POC reconciliation timer unavailable");
        }
      }
    }
  }
  await Promise.all([
    runLoop(async () => {
      const resolver = await pocRouteResolverForMaintenance();
      await runFrontUsageDeliveryBatch(resolver);
    }, 30_000),
    runLoop(async () => {
      const routes = await pocRoutesForMaintenance();
      await Promise.all(routes.map((route) => sendFrontUsageHeartbeat(route)));
    }, 10_000),
  ]);
}
