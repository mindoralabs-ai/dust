import { createHash, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import type { DustTenantRouteResolver } from "@app/lib/api/tenant_route";
import type { FrontUsageClaim } from "@app/lib/api/usage_journal";
import {
  claimFrontUsageWork,
  completeFrontUsageClaim,
  deferFrontUsageClaim,
} from "@app/lib/api/usage_journal";
import { concurrentExecutor } from "@app/lib/utils/async_utils";
import { z } from "zod";

const MAX_RECEIPT_BYTES = 2048;
const MAX_ENVELOPE_BYTES = 16384;

const deliveryReceiptSchema = z.strictObject({
  stream_id: z.string().regex(/^\d+-\d+$/),
  envelope_sha256: z.string().regex(/^[a-f0-9]{64}$/),
  replayed: z.boolean(),
});

function validReceipt(value: unknown, expectedHash: string): boolean {
  const parsed = deliveryReceiptSchema.safeParse(value);
  return parsed.success && parsed.data.envelope_sha256 === expectedHash;
}

/**
 * @cc [label:security;backend] dust-front-accounting-batch-only
 * This batch processes retained journal claims and may retry only accounting
 * delivery. It must never invoke or retry a provider model request.
 */
export async function runFrontUsageDeliveryBatch(
  resolver: DustTenantRouteResolver,
  fetchImpl: typeof fetch = fetch
): Promise<number> {
  const claims = await claimFrontUsageWork(`front_${randomUUID()}`, 20);
  let failed = false;
  await concurrentExecutor(
    claims,
    async (claim) => {
      try {
        await deliverFrontUsageClaim(claim, resolver, fetchImpl);
      } catch {
        failed = true;
      }
    },
    { concurrency: 8 }
  );
  if (failed) {
    throw new Error("Dust usage reconciliation unavailable");
  }
  return claims.length;
}

export async function readBoundedReceipt(response: Response): Promise<unknown> {
  if (!response.body) {
    throw new Error("Dust usage delivery unavailable");
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }
      size += value.byteLength;
      if (size > MAX_RECEIPT_BYTES) {
        throw new Error("Dust usage delivery unavailable");
      }
      chunks.push(value);
    }
  } finally {
    await reader.cancel().catch(() => undefined);
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

/**
 * @cc [label:security;backend] dust-front-frozen-usage-delivery
 * Only an exact, byte-frozen journal event may be sent to its fresh signed
 * tenant route. A matching CRM receipt is required before fenced completion;
 * ambiguous provider results remain blocked for evidence-based recovery.
 */
export async function deliverFrontUsageClaim(
  claim: FrontUsageClaim,
  resolver: DustTenantRouteResolver,
  fetchImpl: typeof fetch = fetch
): Promise<void> {
  const lease = {
    attemptId: claim.attemptId,
    leaseOwner: claim.leaseOwner,
    leaseNonce: claim.leaseNonce,
  };
  if (claim.state !== "exact") {
    await deferFrontUsageClaim(lease);
    return;
  }

  let delivered = false;
  try {
    const envelope = claim.eventEnvelope;
    if (
      !envelope ||
      Buffer.byteLength(envelope, "utf8") > MAX_ENVELOPE_BYTES ||
      !claim.eventHash
    ) {
      throw new Error("Invalid frozen Dust usage event");
    }
    const digest = createHash("sha256").update(envelope, "utf8").digest("hex");
    const fields: unknown = JSON.parse(envelope);
    if (
      digest !== claim.eventHash ||
      typeof fields !== "object" ||
      fields === null ||
      Array.isArray(fields) ||
      (fields as Record<string, unknown>).tenant_id !== claim.tenantId ||
      (fields as Record<string, unknown>).workspace_id !== claim.workspaceId ||
      (fields as Record<string, unknown>).attempt_id !== claim.attemptId ||
      (fields as Record<string, unknown>).component !== "dust-front"
    ) {
      throw new Error("Invalid frozen Dust usage event");
    }
    await resolver.refresh();
    const route = resolver.resolveForDelivery(claim.tenantId, claim.routeId);
    if (
      route.tenantId !== claim.tenantId ||
      route.workspaceId !== claim.workspaceId
    ) {
      throw new Error("Dust usage route mismatch");
    }
    const key = (await readFile(route.frontCredentialRef, "utf8")).trim();
    if (key.length < 32 || key.length > 4096 || /[\r\n]/.test(key)) {
      throw new Error("Dust usage delivery unavailable");
    }
    const response = await fetchImpl(route.usageIngestUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Internal-Auth": key },
      body: envelope,
      cache: "no-store",
      redirect: "error",
      signal: AbortSignal.timeout(5_000),
    });
    if (
      response.status !== 200 ||
      !validReceipt(await readBoundedReceipt(response), digest)
    ) {
      throw new Error("Dust usage delivery unavailable");
    }
    delivered = true;
  } catch {
    // Never leak the private route, component credential, or provider material.
    // The exact envelope remains in the durable journal for a later retry.
  }
  await completeFrontUsageClaim({ ...lease, delivered });
}
