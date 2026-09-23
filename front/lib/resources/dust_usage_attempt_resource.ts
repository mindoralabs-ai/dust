// biome-ignore-all lint/plugin/noRawSql: PostgreSQL atomic insert, row locks, and SKIP LOCKED leases have no Sequelize model equivalent here.
import { createHash, randomUUID } from "node:crypto";
import { frontSequelize } from "@app/lib/resources/storage";
import type { Transaction } from "sequelize";
import { QueryTypes } from "sequelize";

// A journal row is committed before a generation request is dispatched. Never
// reuse an attempt ID for a provider retry, even when the original response is
// unavailable: the original may have incurred a charge.
export type FrontUsageAttempt = {
  attemptId: string;
  tenantId: string;
  workspaceId: string;
  conversationId: string;
  model: string;
  routeId: string;
};

export type FrontUsageCounts = {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
};

type JournalRow = {
  attemptId: string;
  identityHash: string;
  state:
    | "started"
    | "unknown"
    | "exact"
    | "no_charge"
    | "manual_review_required";
  providerOperationId: string | null;
  eventEnvelope: string | null;
  eventHash: string | null;
  noChargeEvidenceHash: string | null;
  noChargeEvidenceRef: string | null;
  createdAt: Date | string;
};

const identityPattern = /^[A-Za-z0-9_-]{1,128}$/;
const tenantPattern = /^[a-z0-9][a-z0-9-]{0,62}$/;
const referencePattern = /^[A-Za-z0-9_.:/-]{1,256}$/;
const MAX_COUNT = 2147483647;

function requireIdentity(value: string): void {
  if (!identityPattern.test(value) || value === "unknown") {
    throw new Error("Invalid Dust usage identity");
  }
}

function requireReference(value: string): void {
  if (!referencePattern.test(value)) {
    throw new Error("Invalid Dust usage reference");
  }
}

function hash(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function canonicalJson(fields: Record<string, string>): string {
  return JSON.stringify(
    Object.fromEntries(
      Object.entries(fields).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    )
  );
}

function validateAttempt(attempt: FrontUsageAttempt): void {
  requireIdentity(attempt.attemptId);
  if (!tenantPattern.test(attempt.tenantId)) {
    throw new Error("Invalid Dust usage tenant identity");
  }
  requireIdentity(attempt.workspaceId);
  requireReference(attempt.conversationId);
  requireReference(attempt.model);
  const route = /^([a-z0-9][a-z0-9-]{0,62}):(0|[1-9][0-9]*)$/.exec(
    attempt.routeId
  );
  if (
    !route ||
    route[1] !== attempt.tenantId ||
    !Number.isSafeInteger(Number(route[2]))
  ) {
    throw new Error("Invalid Dust usage route identity");
  }
}

function identityHash(attempt: FrontUsageAttempt): string {
  return hash(
    canonicalJson({
      attempt_id: attempt.attemptId,
      tenant_id: attempt.tenantId,
      workspace_id: attempt.workspaceId,
      conversation_id: attempt.conversationId,
      model: attempt.model,
      route_id: attempt.routeId,
    })
  );
}

export function newFrontUsageAttemptId(): string {
  return randomUUID();
}

/**
 * @cc [label:security;backend] dust-front-journal-health-evidence
 * A producer heartbeat reflects a successful tenant-local durable-journal
 * read. Unknown attempts and stale exact deliveries remain visible to CRM.
 */
export async function readFrontUsageHealth(tenantId: string): Promise<{
  checkedAtSeconds: number;
  oldestDeliveryAtSeconds: number;
  unresolvedCount: number;
}> {
  requireIdentity(tenantId);
  const [[unresolved], [delivery]] = await Promise.all([
    frontSequelize.query<{ unresolvedCount: string }>(
      `SELECT COUNT(*) AS "unresolvedCount" FROM "dust_usage_attempts"
       WHERE "tenantId" = :tenantId
         AND "state" IN ('started', 'unknown', 'manual_review_required')`,
      { replacements: { tenantId }, type: QueryTypes.SELECT }
    ),
    frontSequelize.query<{ oldestDeliveryAt: string | null }>(
      `SELECT EXTRACT(EPOCH FROM MIN("createdAt")) AS "oldestDeliveryAt"
       FROM "dust_usage_attempts" WHERE "tenantId" = :tenantId
         AND "state" = 'exact' AND "deliveredAt" IS NULL`,
      { replacements: { tenantId }, type: QueryTypes.SELECT }
    ),
  ]);
  const unresolvedCount = Number(unresolved?.unresolvedCount);
  const oldestDeliveryAt =
    delivery?.oldestDeliveryAt === null
      ? 0
      : Number(delivery?.oldestDeliveryAt);
  if (
    !Number.isSafeInteger(unresolvedCount) ||
    unresolvedCount < 0 ||
    !Number.isFinite(oldestDeliveryAt) ||
    oldestDeliveryAt < 0
  ) {
    throw new Error("Dust Front usage journal health unavailable");
  }
  return {
    checkedAtSeconds: Date.now() / 1000,
    oldestDeliveryAtSeconds: oldestDeliveryAt,
    unresolvedCount,
  };
}

/**
 * `created` is the only outcome permitting this caller to dispatch provider I/O.
 * A duplicate is never another allowance, even if the row is still `started`.
 * PostgreSQL's transaction commit is the durability boundary; setting
 * synchronous_commit explicitly prevents a weaker session default.
 */
export async function startFrontUsageAttempt(
  attempt: FrontUsageAttempt
): Promise<"created" | "duplicate"> {
  validateAttempt(attempt);
  const digest = identityHash(attempt);
  return frontSequelize.transaction(async (transaction) => {
    await frontSequelize.query("SET LOCAL synchronous_commit = on", {
      transaction,
    });
    const inserted = await frontSequelize.query<{ attemptId: string }>(
      `INSERT INTO "dust_usage_attempts"
        ("attemptId", "tenantId", "workspaceId", "conversationId", "model", "routeId", "identityHash", "nextRetryAt", "createdAt", "updatedAt")
       VALUES (:attemptId, :tenantId, :workspaceId, :conversationId, :model, :routeId, :digest, now() + interval '5 minutes', now(), now())
       ON CONFLICT ("attemptId") DO NOTHING RETURNING "attemptId"`,
      {
        replacements: { ...attempt, digest },
        transaction,
        type: QueryTypes.SELECT,
      }
    );
    if (inserted.length === 1) {
      return "created";
    }
    const [existing] = await frontSequelize.query<JournalRow>(
      `SELECT "identityHash" FROM "dust_usage_attempts" WHERE "attemptId" = :attemptId`,
      {
        replacements: { attemptId: attempt.attemptId },
        transaction,
        type: QueryTypes.SELECT,
      }
    );
    if (!existing || existing.identityHash !== digest) {
      throw new Error("Conflicting Dust usage attempt identity");
    }
    return "duplicate";
  });
}

async function withLockedAttempt<T>(
  attemptId: string,
  apply: (row: JournalRow, transaction: Transaction) => Promise<T>
): Promise<T> {
  requireIdentity(attemptId);
  return frontSequelize.transaction(async (transaction) => {
    await frontSequelize.query("SET LOCAL synchronous_commit = on", {
      transaction,
    });
    const [row] = await frontSequelize.query<JournalRow>(
      `SELECT "attemptId", "identityHash", "state", "providerOperationId", "eventEnvelope", "eventHash", "noChargeEvidenceHash", "noChargeEvidenceRef", "createdAt"
         FROM "dust_usage_attempts" WHERE "attemptId" = :attemptId FOR UPDATE`,
      { replacements: { attemptId }, transaction, type: QueryTypes.SELECT }
    );
    if (!row) {
      throw new Error("Dust usage attempt was not durably started");
    }
    return apply(row, transaction);
  });
}

/** Unknown means a provider effect may have happened. It is never no-charge. */
export async function markFrontUsageUnknown(
  attemptId: string,
  providerOperationId?: string
): Promise<void> {
  if (providerOperationId !== undefined) {
    requireReference(providerOperationId);
  }
  await withLockedAttempt(attemptId, async (row, transaction) => {
    if (
      providerOperationId &&
      row.providerOperationId &&
      row.providerOperationId !== providerOperationId
    ) {
      throw new Error("Conflicting provider operation identity");
    }
    if (row.state === "unknown" || row.state === "manual_review_required") {
      if (providerOperationId && !row.providerOperationId) {
        await frontSequelize.query(
          `UPDATE "dust_usage_attempts" SET "providerOperationId" = :providerOperationId,
             "updatedAt" = now() WHERE "attemptId" = :attemptId`,
          { replacements: { attemptId, providerOperationId }, transaction }
        );
      }
      return;
    }
    if (row.state !== "started") {
      throw new Error("Conflicting Dust usage terminal replay");
    }
    await frontSequelize.query(
      `UPDATE "dust_usage_attempts" SET "state" = 'unknown',
         "providerOperationId" = COALESCE(:providerOperationId, "providerOperationId"),
         "firstUnresolvedAt" = COALESCE("firstUnresolvedAt", now()),
         "nextRetryAt" = now(), "updatedAt" = now()
       WHERE "attemptId" = :attemptId`,
      {
        replacements: {
          attemptId,
          providerOperationId: providerOperationId ?? null,
        },
        transaction,
      }
    );
  });
}

/** Long provider calls renew their started lease, never a completed attempt. */
export async function heartbeatFrontUsageAttempt(
  attemptId: string
): Promise<void> {
  requireIdentity(attemptId);
  await frontSequelize.transaction(async (transaction) => {
    await frontSequelize.query("SET LOCAL synchronous_commit = on", {
      transaction,
    });
    const [updated] = await frontSequelize.query<{ attemptId: string }>(
      `UPDATE "dust_usage_attempts" SET "nextRetryAt" = now() + interval '5 minutes',
       "updatedAt" = now() WHERE "attemptId" = :attemptId AND "state" = 'started'
     RETURNING "attemptId"`,
      { replacements: { attemptId }, transaction, type: QueryTypes.SELECT }
    );
    if (!updated) {
      throw new Error("Dust usage attempt is no longer active");
    }
  });
}

/** Only use after durable provider evidence establishes there was no charge. */
export async function settleFrontUsageNoCharge(
  attemptId: string,
  verifiedProviderEvidenceRef: string
): Promise<void> {
  requireReference(verifiedProviderEvidenceRef);
  await withLockedAttempt(attemptId, async (row, transaction) => {
    const evidenceHash = hash(verifiedProviderEvidenceRef);
    if (row.state === "no_charge") {
      if (
        row.noChargeEvidenceHash !== evidenceHash ||
        row.noChargeEvidenceRef !== verifiedProviderEvidenceRef
      ) {
        throw new Error("Conflicting Dust usage terminal replay");
      }
      return;
    }
    if (row.state === "exact") {
      throw new Error("Conflicting Dust usage terminal replay");
    }
    await frontSequelize.query(
      `UPDATE "dust_usage_attempts" SET "state" = 'no_charge',
         "noChargeEvidenceHash" = :evidenceHash, "noChargeEvidenceRef" = :verifiedProviderEvidenceRef,
         "manualReviewRequired" = false,
         "nextRetryAt" = NULL, "leaseOwner" = NULL, "leaseNonce" = NULL, "leaseUntil" = NULL,
         "updatedAt" = now() WHERE "attemptId" = :attemptId`,
      {
        replacements: { attemptId, evidenceHash, verifiedProviderEvidenceRef },
        transaction,
      }
    );
  });
}

export function buildFrontUsageEnvelope(input: {
  attempt: FrontUsageAttempt;
  providerOperationId: string;
  eventTime: Date;
  counts: FrontUsageCounts;
}): string {
  validateAttempt(input.attempt);
  requireReference(input.providerOperationId);
  if (Number.isNaN(input.eventTime.getTime())) {
    throw new Error("Invalid provider event time");
  }
  for (const count of [
    input.counts.inputTokens,
    input.counts.outputTokens,
    input.counts.cacheReadTokens,
    input.counts.cacheWriteTokens,
  ]) {
    if (!Number.isSafeInteger(count) || count < 0 || count > MAX_COUNT) {
      throw new Error("Incomplete or invalid provider usage metadata");
    }
  }
  return canonicalJson({
    tenant_id: input.attempt.tenantId,
    agent: "dust",
    component: "dust-front",
    workspace_id: input.attempt.workspaceId,
    attempt_id: input.attempt.attemptId,
    conversation_id: input.attempt.conversationId,
    provider_operation_id: input.providerOperationId,
    model: input.attempt.model,
    ts: input.eventTime.toISOString(),
    event_type: "token",
    input_tokens: String(input.counts.inputTokens),
    output_tokens: String(input.counts.outputTokens),
    cache_read_tokens: String(input.counts.cacheReadTokens),
    cache_write_tokens: String(input.counts.cacheWriteTokens),
    quantity: "0",
  });
}

/** Freeze the complete event bytes before asynchronous tenant-stream delivery. */
export async function settleFrontUsageExact(input: {
  attempt: FrontUsageAttempt;
  providerOperationId: string;
  counts: FrontUsageCounts;
}): Promise<string> {
  validateAttempt(input.attempt);
  return withLockedAttempt(
    input.attempt.attemptId,
    async (row, transaction) => {
      if (row.identityHash !== identityHash(input.attempt)) {
        throw new Error("Conflicting Dust usage attempt identity");
      }
      if (
        row.providerOperationId &&
        row.providerOperationId !== input.providerOperationId
      ) {
        throw new Error("Conflicting provider operation identity");
      }
      const envelope = buildFrontUsageEnvelope({
        ...input,
        attempt: input.attempt,
        eventTime: new Date(row.createdAt),
      });
      const eventHash = hash(envelope);
      if (row.state === "exact") {
        if (row.eventHash !== eventHash || row.eventEnvelope !== envelope) {
          throw new Error("Conflicting Dust usage terminal replay");
        }
        await frontSequelize.query(
          `UPDATE "dust_usage_attempts" SET "manualReviewRequired" = false,
             "firstUnresolvedAt" = now(), "nextRetryAt" = now(), "updatedAt" = now()
           WHERE "attemptId" = :attemptId AND "manualReviewRequired" = true`,
          { replacements: { attemptId: input.attempt.attemptId }, transaction }
        );
        return envelope;
      }
      if (row.state === "no_charge") {
        throw new Error("Conflicting Dust usage terminal replay");
      }
      await frontSequelize.query(
        `UPDATE "dust_usage_attempts" SET "state" = 'exact',
         "providerOperationId" = :providerOperationId,
         "eventEnvelope" = :envelope, "eventHash" = :eventHash,
         "firstUnresolvedAt" = now(), "manualReviewRequired" = false,
         "nextRetryAt" = now(), "updatedAt" = now()
       WHERE "attemptId" = :attemptId`,
        {
          replacements: {
            attemptId: input.attempt.attemptId,
            providerOperationId: input.providerOperationId,
            envelope,
            eventHash,
          },
          transaction,
        }
      );
      return envelope;
    }
  );
}

export type FrontUsageClaim = {
  attemptId: string;
  tenantId: string;
  workspaceId: string;
  routeId: string;
  state: string;
  eventEnvelope: string | null;
  eventHash: string | null;
  providerOperationId: string | null;
  firstUnresolvedAt: Date | null;
  retryCount: number;
  manualReviewRequired: boolean;
  leaseOwner: string;
  leaseNonce: string;
};

/**
 * @cc [label:security;concurrency] dust-front-usage-claim-fence
 * A fresh lease nonce fences each claimed batch; only that lease may mark the
 * frozen event delivered or defer it. Reused worker owner names confer no access.
 */
export async function claimFrontUsageWork(
  leaseOwner: string,
  limit = 20
): Promise<FrontUsageClaim[]> {
  requireIdentity(leaseOwner);
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
    throw new Error("Invalid Dust usage claim limit");
  }
  return frontSequelize.transaction(async (transaction) => {
    await frontSequelize.query("SET LOCAL synchronous_commit = on", {
      transaction,
    });
    const leaseNonce = randomUUID();
    return frontSequelize.query<FrontUsageClaim>(
      `WITH due AS (
         SELECT "attemptId" FROM "dust_usage_attempts"
          WHERE "deliveredAt" IS NULL
            AND "manualReviewRequired" = false
            AND ("leaseUntil" IS NULL OR "leaseUntil" < now())
            AND "nextRetryAt" <= now()
            AND "state" IN ('started', 'unknown', 'exact')
          ORDER BY CASE WHEN "state" = 'exact' AND "retryCount" = 0
                        THEN 0 ELSE 1 END,
                   "nextRetryAt", "createdAt"
          LIMIT :limit FOR UPDATE SKIP LOCKED
       )
       UPDATE "dust_usage_attempts" AS j SET "leaseOwner" = :leaseOwner,
         "leaseNonce" = :leaseNonce,
         "leaseUntil" = now() + interval '60 seconds', "updatedAt" = now()
         FROM due WHERE j."attemptId" = due."attemptId"
       RETURNING j."attemptId", j."tenantId", j."workspaceId", j."routeId", j."state",
                 j."eventEnvelope", j."eventHash", j."providerOperationId",
                 j."firstUnresolvedAt", j."retryCount", j."manualReviewRequired", j."leaseOwner", j."leaseNonce"`,
      {
        replacements: { leaseOwner, leaseNonce, limit },
        transaction,
        type: QueryTypes.SELECT,
      }
    );
  });
}

/** Delivery must use the frozen bytes and tenant route from the claimed row. */
export async function completeFrontUsageClaim(input: {
  attemptId: string;
  leaseOwner: string;
  leaseNonce: string;
  delivered: boolean;
}): Promise<void> {
  requireIdentity(input.attemptId);
  requireIdentity(input.leaseOwner);
  requireIdentity(input.leaseNonce);
  await frontSequelize.transaction(async (transaction) => {
    await frontSequelize.query("SET LOCAL synchronous_commit = on", {
      transaction,
    });
    const [updated] = await frontSequelize.query<{ attemptId: string }>(
      `UPDATE "dust_usage_attempts" SET
       "deliveredAt" = CASE WHEN :delivered THEN now() ELSE "deliveredAt" END,
       "firstUnresolvedAt" = CASE WHEN :delivered THEN "firstUnresolvedAt"
                                   ELSE COALESCE("firstUnresolvedAt", now()) END,
       "manualReviewRequired" = CASE WHEN :delivered THEN false
         ELSE COALESCE("firstUnresolvedAt", now()) <= now() - interval '24 hours' END,
       "retryCount" = "retryCount" + CASE WHEN :delivered THEN 0 ELSE 1 END,
       "nextRetryAt" = CASE WHEN :delivered THEN NULL ELSE now() + interval '1 minute' END,
       "leaseOwner" = NULL, "leaseNonce" = NULL, "leaseUntil" = NULL, "updatedAt" = now()
     WHERE "attemptId" = :attemptId AND "leaseOwner" = :leaseOwner
       AND "leaseNonce" = :leaseNonce
       AND "leaseUntil" > now() AND "state" = 'exact'
     RETURNING "attemptId"`,
      { replacements: input, transaction, type: QueryTypes.SELECT }
    );
    if (!updated) {
      throw new Error(
        "Dust usage delivery lease was lost or attempt is not exact"
      );
    }
  });
}

/** Keep the unresolved block after the ceiling; never infer no-charge. */
export async function deferFrontUsageClaim(input: {
  attemptId: string;
  leaseOwner: string;
  leaseNonce: string;
}): Promise<void> {
  requireIdentity(input.attemptId);
  requireIdentity(input.leaseOwner);
  requireIdentity(input.leaseNonce);
  await frontSequelize.transaction(async (transaction) => {
    await frontSequelize.query("SET LOCAL synchronous_commit = on", {
      transaction,
    });
    const [updated] = await frontSequelize.query<{ attemptId: string }>(
      `UPDATE "dust_usage_attempts" SET
       "state" = CASE WHEN COALESCE("firstUnresolvedAt", "createdAt") <= now() - interval '24 hours'
                       THEN 'manual_review_required' ELSE 'unknown' END,
       "manualReviewRequired" = COALESCE("firstUnresolvedAt", "createdAt") <= now() - interval '24 hours',
       "firstUnresolvedAt" = COALESCE("firstUnresolvedAt", now()),
       "retryCount" = "retryCount" + 1,
       "nextRetryAt" = now() + interval '1 minute',
       "leaseOwner" = NULL, "leaseNonce" = NULL, "leaseUntil" = NULL, "updatedAt" = now()
     WHERE "attemptId" = :attemptId AND "leaseOwner" = :leaseOwner
       AND "leaseNonce" = :leaseNonce
       AND "leaseUntil" > now() AND "state" IN ('started', 'unknown')
     RETURNING "attemptId"`,
      { replacements: input, transaction, type: QueryTypes.SELECT }
    );
    if (!updated) {
      throw new Error("Dust usage reconciliation lease was lost");
    }
  });
}

/** Durable PostgreSQL boundary for Dust generation accounting. */
export class DustUsageAttemptResource {
  static readHealth = readFrontUsageHealth;
  static start = startFrontUsageAttempt;
  static markUnknown = markFrontUsageUnknown;
  static heartbeat = heartbeatFrontUsageAttempt;
  static settleNoCharge = settleFrontUsageNoCharge;
  static settleExact = settleFrontUsageExact;
  static claimWork = claimFrontUsageWork;
  static completeClaim = completeFrontUsageClaim;
  static deferClaim = deferFrontUsageClaim;
}
