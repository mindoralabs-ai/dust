// biome-ignore-all lint/plugin/noRawSql: PostgreSQL atomic insert, row locks, and SKIP LOCKED leases have no Sequelize model equivalent here.
import { createHash, randomUUID } from "node:crypto";
import type { TenantRoute } from "@app/lib/api/tenant_route";
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
  routeBindingHash: string | null;
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

function requireWorkspaceId(value: string): void {
  if (value.length < 1 || value.length > 256) {
    throw new Error("Invalid Dust usage workspace identity");
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
  requireWorkspaceId(attempt.workspaceId);
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

/** Ignore export signing metadata and global revision; tenant route fields are immutable. */
export function frontUsageRouteBindingHash(route: TenantRoute): string {
  return hash(
    canonicalJson({
      tenant_id: route.tenantId,
      workspace_id: route.workspaceId,
      private_route: route.privateRoute,
      admission_url: route.admissionUrl,
      usage_ingest_url: route.usageIngestUrl,
      journal_target: route.journalTarget,
      front_credential_ref: route.frontCredentialRef,
      core_credential_ref: route.coreCredentialRef,
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
  const [health] = await frontSequelize.query<{
    unresolvedCount: string;
    oldestDeliveryAt: string | null;
  }>(
    `SELECT
       (SELECT COUNT(*) FROM "dust_usage_attempts"
        WHERE "tenantId" = :tenantId
          AND "state" IN ('started', 'unknown', 'manual_review_required')) AS "unresolvedCount",
       (SELECT EXTRACT(EPOCH FROM MIN("createdAt"))
        FROM "dust_usage_attempts" WHERE "tenantId" = :tenantId
          AND "state" = 'exact' AND "deliveredAt" IS NULL) AS "oldestDeliveryAt"`,
    { replacements: { tenantId }, type: QueryTypes.SELECT }
  );
  const unresolvedCount = Number(health?.unresolvedCount);
  const oldestDeliveryAt =
    health?.oldestDeliveryAt === null ? 0 : Number(health?.oldestDeliveryAt);
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
  attempt: FrontUsageAttempt,
  route: TenantRoute
): Promise<"created" | "duplicate"> {
  validateAttempt(attempt);
  if (
    route.tenantId !== attempt.tenantId ||
    route.workspaceId !== attempt.workspaceId ||
    `${route.tenantId}:${route.revision}` !== attempt.routeId
  ) {
    throw new Error("Dust usage journal route mismatch");
  }
  const digest = identityHash(attempt);
  const routeBindingHash = frontUsageRouteBindingHash(route);
  return frontSequelize.transaction(async (transaction) => {
    await frontSequelize.query("SET LOCAL synchronous_commit = on", {
      transaction,
    });
    const inserted = await frontSequelize.query<{ attemptId: string }>(
      `INSERT INTO "dust_usage_attempts"
        ("attemptId", "tenantId", "workspaceId", "conversationId", "model", "routeId", "routeBindingHash", "identityHash", "nextRetryAt", "createdAt", "updatedAt")
       VALUES (:attemptId, :tenantId, :workspaceId, :conversationId, :model, :routeId, :routeBindingHash, :digest, now() + interval '5 minutes', now(), now())
       ON CONFLICT ("attemptId") DO NOTHING RETURNING "attemptId"`,
      {
        replacements: { ...attempt, digest, routeBindingHash },
        transaction,
        type: QueryTypes.SELECT,
      }
    );
    if (inserted.length === 1) {
      return "created";
    }
    const [existing] = await frontSequelize.query<JournalRow>(
      `SELECT "identityHash", "routeBindingHash" FROM "dust_usage_attempts" WHERE "attemptId" = :attemptId`,
      {
        replacements: { attemptId: attempt.attemptId },
        transaction,
        type: QueryTypes.SELECT,
      }
    );
    if (
      !existing ||
      existing.identityHash !== digest ||
      existing.routeBindingHash !== routeBindingHash
    ) {
      throw new Error("Conflicting Dust usage attempt identity");
    }
    return "duplicate";
  });
}

/** An in-process, single-use proof tied to one committed journal insertion. */
export type FrontUsageStartPermit = Readonly<{ attemptId: string }>;
type PermitBinding = Readonly<{
  attemptId: string;
  tenantId: string;
  workspaceId: string;
  routeId: string;
  admissionUrl: string;
  frontCredentialRef: string;
}>;
const issuedStartPermits = new WeakMap<FrontUsageStartPermit, PermitBinding>();

export async function startFrontUsageAttemptForAdmission(
  attempt: FrontUsageAttempt,
  route: TenantRoute
): Promise<FrontUsageStartPermit | null> {
  if (
    route.tenantId !== attempt.tenantId ||
    route.workspaceId !== attempt.workspaceId ||
    `${route.tenantId}:${route.revision}` !== attempt.routeId
  ) {
    throw new Error("Dust usage admission route mismatch");
  }
  if ((await startFrontUsageAttempt(attempt, route)) !== "created") {
    return null;
  }
  const permit = Object.freeze({ attemptId: attempt.attemptId });
  issuedStartPermits.set(permit, {
    attemptId: attempt.attemptId,
    tenantId: attempt.tenantId,
    workspaceId: attempt.workspaceId,
    routeId: attempt.routeId,
    admissionUrl: route.admissionUrl,
    frontCredentialRef: route.frontCredentialRef,
  });
  return permit;
}

export async function consumeFrontUsageStartPermit(
  permit: FrontUsageStartPermit | null,
  attemptId: string,
  route: TenantRoute
): Promise<boolean> {
  const binding = permit && issuedStartPermits.get(permit);
  if (
    !permit ||
    !binding ||
    binding.attemptId !== attemptId ||
    binding.tenantId !== route.tenantId ||
    binding.workspaceId !== route.workspaceId ||
    binding.routeId !== `${route.tenantId}:${route.revision}` ||
    binding.admissionUrl !== route.admissionUrl ||
    binding.frontCredentialRef !== route.frontCredentialRef
  ) {
    return false;
  }
  issuedStartPermits.delete(permit);
  const [active] = await frontSequelize.query<{ attemptId: string }>(
    `UPDATE "dust_usage_attempts"
       SET "nextRetryAt" = now() + interval '5 minutes', "updatedAt" = now()
     WHERE "attemptId" = :attemptId AND "state" = 'started'
       AND "nextRetryAt" > now()
       AND ("leaseUntil" IS NULL OR "leaseUntil" < now())
       AND "routeBindingHash" = :routeBindingHash
     RETURNING "attemptId"`,
    {
      replacements: {
        attemptId,
        routeBindingHash: frontUsageRouteBindingHash(route),
      },
      transaction: null,
      type: QueryTypes.SELECT,
    }
  );
  return Boolean(active);
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
       AND ("leaseUntil" IS NULL OR "leaseUntil" < now())
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
  routeBindingHash: string | null;
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

/** Check the exact frozen row and current lease before external tenant I/O. */
export async function validateFrontUsageClaim(
  claim: FrontUsageClaim
): Promise<void> {
  requireIdentity(claim.attemptId);
  requireIdentity(claim.leaseOwner);
  requireIdentity(claim.leaseNonce);
  const [persisted] = await frontSequelize.query<FrontUsageClaim>(
    `SELECT "attemptId", "tenantId", "workspaceId", "routeId", "routeBindingHash", "state",
            "eventEnvelope", "eventHash", "providerOperationId",
            "firstUnresolvedAt", "retryCount", "manualReviewRequired",
            "leaseOwner", "leaseNonce"
       FROM "dust_usage_attempts"
      WHERE "attemptId" = :attemptId AND "leaseOwner" = :leaseOwner
        AND "leaseNonce" = :leaseNonce AND "leaseUntil" > now()
        AND "state" = 'exact' AND "deliveredAt" IS NULL
        AND "manualReviewRequired" = false`,
    {
      replacements: {
        attemptId: claim.attemptId,
        leaseOwner: claim.leaseOwner,
        leaseNonce: claim.leaseNonce,
      },
      type: QueryTypes.SELECT,
    }
  );
  const same =
    persisted &&
    persisted.attemptId === claim.attemptId &&
    persisted.tenantId === claim.tenantId &&
    persisted.workspaceId === claim.workspaceId &&
    persisted.routeId === claim.routeId &&
    persisted.routeBindingHash === claim.routeBindingHash &&
    persisted.state === claim.state &&
    persisted.eventEnvelope === claim.eventEnvelope &&
    persisted.eventHash === claim.eventHash &&
    persisted.providerOperationId === claim.providerOperationId &&
    Number(new Date(persisted.firstUnresolvedAt ?? 0)) ===
      Number(new Date(claim.firstUnresolvedAt ?? 0)) &&
    persisted.retryCount === claim.retryCount &&
    persisted.manualReviewRequired === claim.manualReviewRequired &&
    persisted.leaseOwner === claim.leaseOwner &&
    persisted.leaseNonce === claim.leaseNonce;
  if (!same) {
    throw new Error("Dust usage claim is not the leased frozen row");
  }
}

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
      `WITH ranked AS (
         SELECT "attemptId", "nextRetryAt",
                CASE WHEN "state" = 'exact' AND "retryCount" = 0
                     THEN 0 ELSE 1 END AS priority_class,
                row_number() OVER (
                  PARTITION BY CASE WHEN "state" = 'exact' AND "retryCount" = 0
                                    THEN 0 ELSE 1 END
                  ORDER BY "nextRetryAt", "createdAt", "attemptId"
                ) AS priority_rank
           FROM "dust_usage_attempts"
          WHERE "deliveredAt" IS NULL
            AND "manualReviewRequired" = false
            AND ("leaseUntil" IS NULL OR "leaseUntil" < now())
            AND "nextRetryAt" <= now()
            AND "state" IN ('started', 'unknown', 'exact')
       ), due AS (
         SELECT j."attemptId" FROM "dust_usage_attempts" AS j
           JOIN ranked AS r ON j."attemptId" = r."attemptId"
          WHERE j."deliveredAt" IS NULL AND j."manualReviewRequired" = false
            AND (j."leaseUntil" IS NULL OR j."leaseUntil" < now())
            AND j."nextRetryAt" <= now()
            AND j."state" IN ('started', 'unknown', 'exact')
          ORDER BY CASE WHEN :limit = 1 THEN 0
                        WHEN r.priority_class = 1 AND r.priority_rank = 1 THEN 0
                        WHEN r.priority_class = 0 AND r.priority_rank < :limit THEN 1
                        WHEN r.priority_class = 1 THEN 2 ELSE 3 END,
                   r."nextRetryAt", r.priority_rank
          LIMIT :limit FOR UPDATE OF j SKIP LOCKED
       )
       UPDATE "dust_usage_attempts" AS j SET "leaseOwner" = :leaseOwner,
         "leaseNonce" = :leaseNonce,
         "leaseUntil" = now() + interval '60 seconds', "updatedAt" = now()
         FROM due WHERE j."attemptId" = due."attemptId"
       RETURNING j."attemptId", j."tenantId", j."workspaceId", j."routeId", j."routeBindingHash", j."state",
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
  static startForAdmission = startFrontUsageAttemptForAdmission;
  static consumeStartPermit = consumeFrontUsageStartPermit;
  static markUnknown = markFrontUsageUnknown;
  static heartbeat = heartbeatFrontUsageAttempt;
  static settleNoCharge = settleFrontUsageNoCharge;
  static settleExact = settleFrontUsageExact;
  static claimWork = claimFrontUsageWork;
  static validateClaim = validateFrontUsageClaim;
  static completeClaim = completeFrontUsageClaim;
  static deferClaim = deferFrontUsageClaim;
}
