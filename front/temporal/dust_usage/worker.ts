import { setTimeout } from "node:timers/promises";
import { dustPocMode } from "@app/lib/api/dust_poc_mode";
import { pocRouteResolverForMaintenance } from "@app/lib/api/dust_poc_runtime";
import { runFrontUsageDeliveryBatch } from "@app/lib/api/usage_delivery";
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
  while (!signal?.aborted) {
    try {
      const resolver = await pocRouteResolverForMaintenance();
      await runFrontUsageDeliveryBatch(resolver);
    } catch {
      logger.warn("Dust POC usage reconciliation unavailable");
    }
    try {
      await setTimeout(30_000, undefined, { signal });
    } catch {
      if (!signal?.aborted) {
        throw new Error("Dust POC reconciliation timer unavailable");
      }
    }
  }
}
