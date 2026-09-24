-- This database must live on Core's retained PVC. The tenant stream is an
-- outbox destination, never the source of truth for paid provider effects.
CREATE TABLE IF NOT EXISTS dust_usage_attempts (
    attempt_id TEXT PRIMARY KEY,
    provider_request_id TEXT NOT NULL UNIQUE,
    tenant_id TEXT NOT NULL,
    workspace_id TEXT NOT NULL,
    conversation_id TEXT NOT NULL,
    route_id TEXT NOT NULL,
    model TEXT NOT NULL,
    state TEXT NOT NULL DEFAULT 'started'
        CHECK (state IN ('started', 'unknown', 'exact', 'no_charge', 'manual_review_required')),
    provider_operation_id TEXT UNIQUE,
    no_charge_evidence_ref TEXT,
    event_envelope TEXT,
    delivered_at_ms INTEGER,
    first_unresolved_at_ms INTEGER,
    retry_count INTEGER NOT NULL DEFAULT 0 CHECK (retry_count >= 0),
    manual_review_required INTEGER NOT NULL DEFAULT 0 CHECK (manual_review_required IN (0, 1)),
    next_retry_at_ms INTEGER,
    lease_owner TEXT,
    lease_nonce TEXT,
    lease_until_ms INTEGER,
    created_at_ms INTEGER NOT NULL,
    updated_at_ms INTEGER NOT NULL,
    CHECK (event_envelope IS NULL OR state = 'exact'),
    CHECK (delivered_at_ms IS NULL OR state = 'exact'),
    CHECK (state <> 'no_charge' OR no_charge_evidence_ref IS NOT NULL)
);

CREATE INDEX IF NOT EXISTS dust_usage_attempts_reconcile_idx
    ON dust_usage_attempts (next_retry_at_ms, lease_until_ms)
    WHERE delivered_at_ms IS NULL
      AND state IN ('started', 'unknown', 'exact', 'manual_review_required');
CREATE INDEX IF NOT EXISTS dust_usage_attempts_tenant_state_idx
    ON dust_usage_attempts (tenant_id, state, created_at_ms);

-- Durable rollback and tenant-identity fence; accepted before provider I/O.
CREATE TABLE IF NOT EXISTS dust_tenant_route_fence (
    singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
    revision INTEGER NOT NULL,
    payload_digest BLOB NOT NULL,
    tenant_identity_json TEXT NOT NULL
);
