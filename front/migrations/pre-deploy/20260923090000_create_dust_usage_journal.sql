-- Front owns generation accounting. Retain this table across pod replacement;
-- the tenant stream is a delivery target, not the source of truth.
CREATE TABLE "dust_usage_attempts" (
  "attemptId" VARCHAR(128) PRIMARY KEY,
  "tenantId" VARCHAR(128) NOT NULL,
  "workspaceId" VARCHAR(128) NOT NULL,
  "conversationId" VARCHAR(256) NOT NULL,
  "model" VARCHAR(256) NOT NULL,
  "routeId" VARCHAR(256) NOT NULL,
  "identityHash" VARCHAR(64) NOT NULL,
  "state" VARCHAR(32) NOT NULL DEFAULT 'started'
    CHECK ("state" IN ('started', 'unknown', 'exact', 'no_charge', 'manual_review_required')),
  "providerOperationId" VARCHAR(256),
  "noChargeEvidenceRef" VARCHAR(256),
  "noChargeEvidenceHash" VARCHAR(64),
  "eventEnvelope" VARCHAR(16384),
  "eventHash" VARCHAR(64),
  "deliveredAt" TIMESTAMP WITH TIME ZONE,
  "firstUnresolvedAt" TIMESTAMP WITH TIME ZONE,
  "retryCount" INTEGER NOT NULL DEFAULT 0 CHECK ("retryCount" >= 0),
  "manualReviewRequired" BOOLEAN NOT NULL DEFAULT false,
  "nextRetryAt" TIMESTAMP WITH TIME ZONE,
  "leaseOwner" VARCHAR(128),
  "leaseNonce" VARCHAR(128),
  "leaseUntil" TIMESTAMP WITH TIME ZONE,
  "createdAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
  "updatedAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
  CHECK (("eventEnvelope" IS NULL AND "eventHash" IS NULL) OR
         ("state" = 'exact' AND "eventEnvelope" IS NOT NULL AND "eventHash" IS NOT NULL)),
  CHECK ("deliveredAt" IS NULL OR "state" = 'exact'),
  CHECK ("state" <> 'no_charge' OR
         ("noChargeEvidenceRef" IS NOT NULL AND "noChargeEvidenceHash" IS NOT NULL))
);

CREATE INDEX "dust_usage_attempts_reconcile_idx" ON "dust_usage_attempts"
  ("nextRetryAt", "leaseUntil")
  WHERE "state" IN ('started', 'unknown', 'exact', 'manual_review_required')
    AND "deliveredAt" IS NULL;
CREATE INDEX "dust_usage_attempts_tenant_state_idx" ON "dust_usage_attempts"
  ("tenantId", "state", "createdAt");
