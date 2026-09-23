import { readFile } from "node:fs/promises";
import type { TenantRoute } from "@app/lib/api/tenant_route";
import { readBoundedReceipt } from "@app/lib/api/usage_delivery";
import { readFrontUsageHealth } from "@app/lib/api/usage_journal";
import { z } from "zod";

const heartbeatReceiptSchema = z.strictObject({
  accepted: z.literal(true),
  heartbeat_interval_seconds: z.literal(15),
});

/**
 * @cc [label:security;backend] dust-front-independent-heartbeat
 * Send one tenant's evidence only after its durable journal read and the
 * bounded reconciler have succeeded. The destination and component key come
 * exclusively from a fresh signed route, never a browser or prompt.
 */
export async function sendFrontUsageHeartbeat(
  route: TenantRoute,
  fetchImpl: typeof fetch = fetch
): Promise<void> {
  const health = await readFrontUsageHealth(route.tenantId);
  const observedAtSeconds = Date.now() / 1000;
  const key = (await readFile(route.frontCredentialRef, "utf8")).trim();
  if (key.length < 32 || key.length > 4096 || /[\r\n]/.test(key)) {
    throw new Error("Dust Front usage heartbeat unavailable");
  }
  const response = await fetchImpl(
    `${route.privateRoute}/internal/usage/producers/dust-front/heartbeat`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Internal-Auth": key },
      body: JSON.stringify({
        tenant_id: route.tenantId,
        observed_at: observedAtSeconds,
        journal_checked_at: health.checkedAtSeconds,
        reconciler_heartbeat_at: observedAtSeconds,
        oldest_delivery_at: health.oldestDeliveryAtSeconds,
        journal_healthy: true,
        unresolved_count: health.unresolvedCount,
      }),
      cache: "no-store",
      redirect: "error",
      signal: AbortSignal.timeout(5_000),
    }
  );
  const receipt =
    response.status === 200 ? await readBoundedReceipt(response) : null;
  if (!heartbeatReceiptSchema.safeParse(receipt).success) {
    throw new Error("Dust Front usage heartbeat unavailable");
  }
}
