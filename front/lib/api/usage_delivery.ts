import { createHash, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import type { DustTenantRouteResolver } from "@app/lib/api/tenant_route";
import type { FrontUsageClaim } from "@app/lib/api/usage_journal";
import {
  claimFrontUsageWork,
  completeFrontUsageClaim,
  deferFrontUsageClaim,
  validateFrontUsageClaim,
} from "@app/lib/api/usage_journal";
import { concurrentExecutor } from "@app/lib/utils/async_utils";
import { z } from "zod";

const MAX_RECEIPT_BYTES = 2048;
const MAX_ENVELOPE_BYTES = 16384;
const batchSuccesses = new WeakMap<
  FrontUsageBatchSuccess,
  {
    issuedAt: number;
    heartbeatedTenants: Set<string>;
  }
>();

/** Opaque evidence that this process completed a reconciliation batch. */
export type FrontUsageBatchSuccess = Readonly<{ processed: number }>;

export function consumeFrontUsageBatchSuccess(
  success: FrontUsageBatchSuccess,
  tenantId: string
): boolean {
  const issued = batchSuccesses.get(success);
  if (
    !issued ||
    Date.now() - issued.issuedAt > 10_000 ||
    issued.heartbeatedTenants.has(tenantId)
  ) {
    return false;
  }
  issued.heartbeatedTenants.add(tenantId);
  return true;
}

const deliveryReceiptSchema = z.strictObject({
  stream_id: z.string().regex(/^\d+-\d+$/),
  envelope_sha256: z.string().regex(/^[a-f0-9]{64}$/),
  replayed: z.boolean(),
});
const frozenEnvelopeBindingSchema = z.object({
  tenant_id: z.string(),
  workspace_id: z.string(),
  attempt_id: z.string(),
  component: z.literal("dust-front"),
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
): Promise<FrontUsageBatchSuccess> {
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
  const success = Object.freeze({ processed: claims.length });
  batchSuccesses.set(success, {
    issuedAt: Date.now(),
    heartbeatedTenants: new Set(),
  });
  return success;
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
    const binding = frozenEnvelopeBindingSchema.safeParse(fields);
    if (
      digest !== claim.eventHash ||
      !binding.success ||
      binding.data.tenant_id !== claim.tenantId ||
      binding.data.workspace_id !== claim.workspaceId ||
      binding.data.attempt_id !== claim.attemptId
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
    await validateFrontUsageClaim(claim);
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
