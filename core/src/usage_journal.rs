//! Core-owned, retained SQLite journal for embedding provider attempts.
//!
//! Callers must consume the `StartOutcome::Created` permit before dispatching
//! provider I/O. This module deliberately does not dispatch or retry effects.
//! Its SQLite path must be on the retained Core PVC, not the container layer.

use anyhow::{anyhow, bail, Context, Result};
use chrono::{SecondsFormat, TimeZone, Utc};
use rusqlite::{params, Connection, OptionalExtension, Transaction, TransactionBehavior};
use std::collections::{BTreeMap, HashMap};
use std::path::{Path, PathBuf};
use std::time::Duration;
use uuid::Uuid;

const MIGRATION: &str = include_str!("stores/migrations/20260923_dust_usage_journal.sql");
const START_TIMEOUT_MS: i64 = 5 * 60 * 1000;
const CLAIM_LEASE_MS: i64 = 60 * 1000;
const RETRY_DELAY_MS: i64 = 60 * 1000;
const REVIEW_DEADLINE_MS: i64 = 24 * 60 * 60 * 1000;
const EMBEDDING_RESULT_RETRY_WINDOW_MS: i64 = 30 * 24 * 60 * 60 * 1000;
/// Upper bound of a direct workspace's configured daily token limit.
pub const DIRECT_DAILY_TOKEN_LIMIT_MAX: u64 = 1_000_000_000;
/// Upper bound of a frozen usage envelope's `input_tokens`.
const ENVELOPE_INPUT_TOKENS_MAX: u32 = 2_147_483_647;

/// Tenant of direct provider mode's local journal rows. A signed tenant may
/// use the same ID: `DIRECT_POC_ROUTE_ID`, not the tenant, identifies a
/// direct row.
pub const DIRECT_POC_TENANT_ID: &str = "poc-direct";

/// Route of direct provider mode's local journal rows. A signed attempt's
/// route is `<tenant>:<decimal registry revision>`, so no signed attempt can
/// carry this non-numeric revision.
pub const DIRECT_POC_ROUTE_ID: &str = "poc-direct:direct";

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct CoreUsageAttempt {
    pub attempt_id: String,
    /// Client-generated before dispatch, so ambiguous transport failures still
    /// have a stable provider-side lookup reference.
    pub provider_request_id: String,
    pub tenant_id: String,
    pub workspace_id: String,
    pub conversation_id: String,
    pub route_id: String,
    pub model: String,
}

#[derive(Debug, PartialEq, Eq)]
pub struct CreatedPermit {
    attempt: CoreUsageAttempt,
}

impl CreatedPermit {
    pub fn matches_attempt(&self, attempt: &CoreUsageAttempt) -> bool {
        self.attempt == *attempt
    }
}

#[derive(Debug, PartialEq, Eq)]
pub enum StartOutcome {
    Created(CreatedPermit),
    Duplicate,
}

#[derive(Debug, PartialEq, Eq)]
pub enum DirectStartOutcome {
    Created(CreatedPermit),
    Duplicate,
    /// The daily limit would be exceeded; nothing was written.
    OverLimit,
}

#[cfg(test)]
impl StartOutcome {
    pub(crate) fn created_for_test(attempt: CoreUsageAttempt) -> Self {
        Self::Created(CreatedPermit { attempt })
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct EmbeddingUsage {
    /// A complete provider-reported `usageMetadata.promptTokenCount`.
    pub input_tokens: u32,
}

#[derive(Debug)]
pub struct PaidEmbeddingRecoveryRequired;

impl std::fmt::Display for PaidEmbeddingRecoveryRequired {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "paid embedding result requires manual recovery")
    }
}

impl std::error::Error for PaidEmbeddingRecoveryRequired {}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ClaimedWork {
    pub attempt_id: String,
    pub tenant_id: String,
    pub workspace_id: String,
    pub route_id: String,
    pub provider_request_id: String,
    pub provider_operation_id: Option<String>,
    pub state: String,
    pub event_envelope: Option<String>,
    pub first_unresolved_at_ms: Option<i64>,
    pub retry_count: u32,
    pub manual_review_required: bool,
    pub lease_owner: String,
    pub lease_nonce: String,
}

#[derive(Clone, Debug)]
pub struct CoreUsageJournal {
    path: PathBuf,
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct CoreJournalHealth {
    pub checked_at_seconds: f64,
    pub oldest_delivery_at_seconds: f64,
    pub unresolved_count: u64,
}

impl CoreUsageJournal {
    /// Opens a file-backed database and commits its schema before returning.
    /// The caller owns retention, backup, and restore of the parent PVC.
    pub fn open(path: impl AsRef<Path>) -> Result<Self> {
        let path = path.as_ref();
        if path.as_os_str().is_empty() || path == Path::new(":memory:") {
            bail!("Core usage journal requires a retained file path");
        }
        let journal = Self {
            path: path.to_path_buf(),
        };
        let conn = journal.connection()?;
        conn.execute_batch(MIGRATION)?;
        conn.execute(
            "UPDATE dust_embedding_results SET vector_json = NULL
             WHERE created_at_ms < ?1 AND vector_json IS NOT NULL",
            [now_ms() - EMBEDDING_RESULT_RETRY_WINDOW_MS],
        )?;
        Ok(journal)
    }

    fn connection(&self) -> Result<Connection> {
        let conn = Connection::open(&self.path)
            .with_context(|| format!("opening Core usage journal at {}", self.path.display()))?;
        conn.busy_timeout(Duration::from_secs(5))?;
        // FULL sync is required before the model effect starts. WAL by itself
        // does not guarantee a committed journal row survives a host crash.
        let mode: String = conn.query_row("PRAGMA journal_mode=WAL", [], |r| r.get(0))?;
        if !mode.eq_ignore_ascii_case("wal") {
            bail!("Core usage journal could not enable WAL");
        }
        conn.pragma_update(None, "synchronous", "FULL")?;
        Ok(conn)
    }

    /// Persist the signed registry fence on the same retained, FULL-sync volume
    /// as the usage outbox before a route can authorize a provider effect.
    pub fn fence_registry(
        &self,
        revision: u64,
        digest: [u8; 32],
        current: &HashMap<String, String>,
    ) -> Result<()> {
        let mut conn = self.connection()?;
        let unchanged: Option<(u64, Vec<u8>, String)> = conn
            .query_row(
                "SELECT revision, payload_digest, tenant_identity_json
                 FROM dust_tenant_route_fence WHERE singleton = 1",
                [],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
            )
            .optional()?;
        if let Some((prior_revision, prior_digest, prior_json)) = unchanged {
            if revision == prior_revision && digest.as_slice() == prior_digest.as_slice() {
                let retained: HashMap<String, String> = serde_json::from_str(&prior_json)?;
                if retained
                    .iter()
                    .all(|(tenant_id, identity)| current.get(tenant_id) == Some(identity))
                {
                    return Ok(());
                }
                bail!("Dust registry tenant identity changed or disappeared");
            }
        }
        let tx = conn.transaction_with_behavior(TransactionBehavior::Immediate)?;
        let prior: Option<(u64, Vec<u8>, String)> = tx
            .query_row(
                "SELECT revision, payload_digest, tenant_identity_json
                 FROM dust_tenant_route_fence WHERE singleton = 1",
                [],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
            )
            .optional()?;
        let mut retained = HashMap::new();
        if let Some((prior_revision, prior_digest, prior_json)) = prior {
            if revision < prior_revision
                || (revision == prior_revision && digest.as_slice() != prior_digest.as_slice())
            {
                bail!("Dust registry revision rollback or conflict");
            }
            retained = serde_json::from_str::<HashMap<String, String>>(&prior_json)?;
            for (tenant_id, prior_identity) in &retained {
                if current.get(tenant_id) != Some(prior_identity) {
                    bail!("Dust registry tenant identity changed or disappeared");
                }
            }
            if revision == prior_revision && digest.as_slice() == prior_digest.as_slice() {
                return Ok(());
            }
        }
        retained.extend(
            current
                .iter()
                .map(|(key, value)| (key.clone(), value.clone())),
        );
        tx.execute(
            "INSERT INTO dust_tenant_route_fence
             (singleton, revision, payload_digest, tenant_identity_json)
             VALUES (1, ?1, ?2, ?3)
             ON CONFLICT(singleton) DO UPDATE SET revision = excluded.revision,
               payload_digest = excluded.payload_digest,
               tenant_identity_json = excluded.tenant_identity_json",
            params![
                revision,
                digest.as_slice(),
                serde_json::to_string(&retained)?
            ],
        )?;
        tx.commit()?;
        Ok(())
    }

    /// @cc [label:security;backend] dust-core-journal-health-evidence
    /// Health evidence comes from a successful tenant-local retained SQLite
    /// read; unknown attempts and stale exact outbox rows remain visible.
    /// Rows on `DIRECT_POC_ROUTE_ID` are not a signed tenant's and are never
    /// counted, even when the tenant ID is `DIRECT_POC_TENANT_ID`.
    pub fn read_health(&self, tenant_id: &str) -> Result<CoreJournalHealth> {
        validate_identity(tenant_id)?;
        let conn = self.connection()?;
        let (unresolved, oldest): (i64, Option<i64>) = conn.query_row(
            "SELECT count(CASE WHEN state IN ('started', 'unknown', 'manual_review_required') THEN 1 END),
                    min(CASE WHEN state = 'exact' AND delivered_at_ms IS NULL THEN created_at_ms END)
             FROM dust_usage_attempts WHERE tenant_id = ?1 AND route_id <> ?2",
            params![tenant_id, DIRECT_POC_ROUTE_ID],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )?;
        Ok(CoreJournalHealth {
            checked_at_seconds: now_ms() as f64 / 1000.0,
            oldest_delivery_at_seconds: oldest.map(|v| v as f64 / 1000.0).unwrap_or(0.0),
            unresolved_count: u64::try_from(unresolved)?,
        })
    }

    pub fn start(&self, attempt: &CoreUsageAttempt) -> Result<StartOutcome> {
        self.start_inner(attempt, None)
    }

    /// Reserve an upsert input in the same durable transaction as its attempt.
    /// A duplicate may not obtain a dispatch permit, even while the first
    /// provider request is still in flight or after an ambiguous crash.
    pub fn start_embedding(
        &self,
        attempt: &CoreUsageAttempt,
        input_hash: &[u8; 32],
    ) -> Result<StartOutcome> {
        self.start_inner(attempt, Some(input_hash))
    }

    /// @cc [owner:jchen0824,label:security;backend] signed-start-excludes-direct-route
    /// `start` and `start_embedding` MUST refuse an attempt whose `route_id` is
    /// `DIRECT_POC_ROUTE_ID`, writing nothing, so only
    /// `start_direct_within_limit` writes direct rows. They accept any tenant
    /// ID, including `DIRECT_POC_TENANT_ID`.
    fn start_inner(
        &self,
        attempt: &CoreUsageAttempt,
        input_hash: Option<&[u8; 32]>,
    ) -> Result<StartOutcome> {
        validate_attempt(attempt)?;
        if attempt.route_id == DIRECT_POC_ROUTE_ID {
            bail!("direct Core usage attempts require the daily limit check");
        }
        let mut conn = self.connection()?;
        let tx = conn.transaction_with_behavior(TransactionBehavior::Immediate)?;
        Self::insert_started(tx, attempt, input_hash)
    }

    /// @cc [owner:jchen0824,label:security;backend] dust-core-direct-start-within-limit
    /// Only `DIRECT_POC_TENANT_ID` attempts on route `DIRECT_POC_ROUTE_ID` are
    /// accepted. One IMMEDIATE transaction reads the workspace's
    /// `DIRECT_POC_TENANT_ID` rows on `DIRECT_POC_ROUTE_ID` created at or after
    /// `since_ms`, never a signed route's rows, and inserts the attempt (and its
    /// input reservation). A `no_charge` row holds nothing. It returns
    /// `OverLimit` and writes nothing when the summed exact `input_tokens`, plus
    /// `reservation_tokens` for each `started`, `unknown` or
    /// `manual_review_required` row and for this attempt, exceed
    /// `daily_token_limit`. Each exact row's envelope `input_tokens` must be a
    /// JSON string of canonical decimal digits (`0`, or digits without a
    /// leading zero, sign, space or any other character) no greater than
    /// `ENVELOPE_INPUT_TOKENS_MAX`. Any other value, including a JSON number,
    /// a missing field or an unparsable envelope, makes the exact total
    /// unreadable. An unreadable exact total is an error that writes nothing,
    /// never zero or a partial sum.
    pub fn start_direct_within_limit(
        &self,
        attempt: &CoreUsageAttempt,
        input_hash: Option<&[u8; 32]>,
        since_ms: i64,
        daily_token_limit: u64,
        reservation_tokens: u64,
    ) -> Result<DirectStartOutcome> {
        validate_attempt(attempt)?;
        if attempt.tenant_id != DIRECT_POC_TENANT_ID || attempt.route_id != DIRECT_POC_ROUTE_ID {
            bail!("Core direct usage attempt route mismatch");
        }
        if reservation_tokens == 0
            || daily_token_limit < reservation_tokens
            || daily_token_limit > DIRECT_DAILY_TOKEN_LIMIT_MAX
        {
            bail!("invalid Core direct usage window");
        }
        let mut conn = self.connection()?;
        let tx = conn.transaction_with_behavior(TransactionBehavior::Immediate)?;
        // `build_envelope` stores `input_tokens` as a canonical decimal JSON
        // string. SQLite's CAST reads "12oops" as 12 and "oops" as 0, so only
        // text that equals its own integer rendering, within the envelope
        // bound, is counted; any other exact row is unreadable.
        let (exact_tokens, unreadable_exact, unsettled_attempts): (i64, i64, i64) = tx.query_row(
            "WITH window_rows AS (
               SELECT state,
                 json_type(event_envelope, '$.input_tokens') AS token_type,
                 json_extract(event_envelope, '$.input_tokens') AS token_text
               FROM dust_usage_attempts
               WHERE tenant_id = ?1 AND route_id = ?5
                 AND state IN ('exact', 'started', 'unknown', 'manual_review_required')
                 AND created_at_ms >= ?3 AND workspace_id = ?2
             ), checked_rows AS (
               SELECT state,
                 CASE WHEN state = 'exact' AND token_type = 'text'
                   AND CAST(CAST(token_text AS INTEGER) AS TEXT) = token_text
                   AND CAST(token_text AS INTEGER) BETWEEN 0 AND ?4
                 THEN CAST(token_text AS INTEGER) END AS exact_tokens
               FROM window_rows
             )
             SELECT
               COALESCE(SUM(exact_tokens), 0),
               count(CASE WHEN state = 'exact' AND exact_tokens IS NULL THEN 1 END),
               count(CASE WHEN state <> 'exact' THEN 1 END)
             FROM checked_rows",
            params![
                DIRECT_POC_TENANT_ID,
                attempt.workspace_id,
                since_ms,
                ENVELOPE_INPUT_TOKENS_MAX,
                DIRECT_POC_ROUTE_ID
            ],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
        )?;
        if unreadable_exact != 0 {
            bail!("Core direct usage total unavailable");
        }
        let exact_tokens = u64::try_from(exact_tokens)?;
        let unsettled_attempts = u64::try_from(unsettled_attempts)?;
        // Reserve for this attempt as well as every unsettled one.
        let projected_tokens = unsettled_attempts
            .checked_add(1)
            .and_then(|attempts| attempts.checked_mul(reservation_tokens))
            .and_then(|reserved| reserved.checked_add(exact_tokens))
            .ok_or_else(|| anyhow!("Core direct usage total unavailable"))?;
        if projected_tokens > daily_token_limit {
            // Dropping the transaction leaves the journal unchanged.
            return Ok(DirectStartOutcome::OverLimit);
        }
        Ok(match Self::insert_started(tx, attempt, input_hash)? {
            StartOutcome::Created(permit) => DirectStartOutcome::Created(permit),
            StartOutcome::Duplicate => DirectStartOutcome::Duplicate,
        })
    }

    /// Insert a `started` attempt, and reserve its embedding input when given,
    /// inside the caller's IMMEDIATE transaction. A reserved input rolls the
    /// new attempt back and returns `Duplicate`.
    fn insert_started(
        tx: Transaction<'_>,
        attempt: &CoreUsageAttempt,
        input_hash: Option<&[u8; 32]>,
    ) -> Result<StartOutcome> {
        let now = now_ms();
        let inserted = tx.execute(
            "INSERT INTO dust_usage_attempts
             (attempt_id, provider_request_id, tenant_id, workspace_id, conversation_id,
              route_id, model, state, next_retry_at_ms, created_at_ms, updated_at_ms)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, 'started', ?8, ?9, ?9)
             ON CONFLICT(attempt_id) DO NOTHING",
            params![
                attempt.attempt_id,
                attempt.provider_request_id,
                attempt.tenant_id,
                attempt.workspace_id,
                attempt.conversation_id,
                attempt.route_id,
                attempt.model,
                now + START_TIMEOUT_MS,
                now
            ],
        )?;
        if inserted == 0 {
            let existing: CoreUsageAttempt = tx.query_row(
                "SELECT attempt_id, provider_request_id, tenant_id, workspace_id,
                        conversation_id, route_id, model FROM dust_usage_attempts WHERE attempt_id = ?1",
                [&attempt.attempt_id],
                |r| {
                    Ok(CoreUsageAttempt {
                        attempt_id: r.get(0)?,
                        provider_request_id: r.get(1)?,
                        tenant_id: r.get(2)?,
                        workspace_id: r.get(3)?,
                        conversation_id: r.get(4)?,
                        route_id: r.get(5)?,
                        model: r.get(6)?,
                    })
                },
            )?;
            if existing != *attempt {
                bail!("conflicting Core usage attempt identity");
            }
        }
        if inserted == 1 {
            if let Some(input_hash) = input_hash {
                let reserved = tx.execute(
                    "INSERT OR IGNORE INTO dust_embedding_results
                     (input_hash, attempt_id, vector_json, created_at_ms)
                     VALUES (?1, ?2, NULL, ?3)",
                    params![input_hash.as_slice(), attempt.attempt_id, now],
                )?;
                if reserved == 0 {
                    // Dropping the transaction also rolls back the new attempt.
                    return Ok(StartOutcome::Duplicate);
                }
            }
        }
        tx.commit()?;
        Ok(if inserted == 1 {
            StartOutcome::Created(CreatedPermit {
                attempt: attempt.clone(),
            })
        } else {
            StartOutcome::Duplicate
        })
    }

    /// Renew a long-running `started` attempt. Failure means the provider gate
    /// must stop further I/O; a settled attempt cannot be made active again.
    pub fn heartbeat_started(&self, attempt_id: &str) -> Result<()> {
        validate_identity(attempt_id)?;
        let conn = self.connection()?;
        let now = now_ms();
        let changed = conn.execute(
            "UPDATE dust_usage_attempts SET next_retry_at_ms = ?2, updated_at_ms = ?3
             WHERE attempt_id = ?1 AND state = 'started' AND next_retry_at_ms > ?3",
            params![attempt_id, now + START_TIMEOUT_MS, now],
        )?;
        if changed != 1 {
            bail!("Core usage attempt is not active");
        }
        Ok(())
    }

    /// A dispatched request with absent or invalid provider usage, and no
    /// provider evidence that it was rejected unbilled, is unknown, never a
    /// synthetic zero-token charge or a no-charge conclusion.
    pub fn mark_unknown(&self, attempt_id: &str) -> Result<()> {
        self.mark_unknown_with_operation(attempt_id, None)
    }

    /// Retain a provider response ID when an ambiguous result supplies one.
    pub fn mark_unknown_with_operation(
        &self,
        attempt_id: &str,
        provider_operation_id: Option<&str>,
    ) -> Result<()> {
        validate_identity(attempt_id)?;
        if let Some(operation_id) = provider_operation_id {
            validate_reference(operation_id)?;
        }
        let mut conn = self.connection()?;
        let tx = conn.transaction_with_behavior(TransactionBehavior::Immediate)?;
        let (state, existing_operation): (String, Option<String>) = tx
            .query_row(
                "SELECT state, provider_operation_id FROM dust_usage_attempts WHERE attempt_id = ?1",
                [attempt_id],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .optional()?
            .ok_or_else(|| anyhow!("Core usage attempt was not durably started"))?;
        if provider_operation_id.is_some()
            && existing_operation
                .as_deref()
                .is_some_and(|id| Some(id) != provider_operation_id)
        {
            bail!("conflicting Core provider operation identity");
        }
        match state.as_str() {
            "started" => {
                let now = now_ms();
                tx.execute(
                    "UPDATE dust_usage_attempts SET state = 'unknown',
                     provider_operation_id = COALESCE(provider_operation_id, ?3),
                     first_unresolved_at_ms = COALESCE(first_unresolved_at_ms, ?2),
                     next_retry_at_ms = ?2, updated_at_ms = ?2 WHERE attempt_id = ?1",
                    params![attempt_id, now, provider_operation_id],
                )?;
            }
            "unknown" | "manual_review_required" => {
                if provider_operation_id.is_some() && existing_operation.is_none() {
                    tx.execute(
                        "UPDATE dust_usage_attempts SET provider_operation_id = ?2,
                         updated_at_ms = ?3 WHERE attempt_id = ?1",
                        params![attempt_id, provider_operation_id, now_ms()],
                    )?;
                }
            }
            _ => bail!("conflicting Core usage terminal replay"),
        }
        tx.commit()?;
        Ok(())
    }

    /// Only call with provider evidence proving no charge occurred.
    pub fn settle_no_charge(&self, attempt_id: &str, evidence_ref: &str) -> Result<()> {
        validate_identity(attempt_id)?;
        validate_reference(evidence_ref)?;
        let mut conn = self.connection()?;
        let tx = conn.transaction_with_behavior(TransactionBehavior::Immediate)?;
        let existing: (String, Option<String>) = tx
            .query_row(
                "SELECT state, no_charge_evidence_ref FROM dust_usage_attempts WHERE attempt_id = ?1",
                [attempt_id],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .optional()?
            .ok_or_else(|| anyhow!("Core usage attempt was not durably started"))?;
        match existing.0.as_str() {
            "no_charge" if existing.1.as_deref() == Some(evidence_ref) => {}
            "started" | "unknown" | "manual_review_required" => {
                tx.execute(
                    "UPDATE dust_usage_attempts SET state = 'no_charge', no_charge_evidence_ref = ?2,
                     next_retry_at_ms = NULL, lease_owner = NULL, lease_nonce = NULL,
                     lease_until_ms = NULL, manual_review_required = 0, updated_at_ms = ?3
                     WHERE attempt_id = ?1",
                    params![attempt_id, evidence_ref, now_ms()],
                )?;
            }
            _ => bail!("conflicting Core usage terminal replay"),
        }
        tx.execute(
            "DELETE FROM dust_embedding_results
             WHERE attempt_id = ?1 AND vector_json IS NULL",
            [attempt_id],
        )?;
        tx.commit()?;
        Ok(())
    }

    /// Freeze the exact tenant-stream event in the same commit as settlement.
    /// `usage` must come from complete provider metadata, not a text estimate.
    pub fn settle_exact(
        &self,
        attempt: &CoreUsageAttempt,
        provider_operation_id: &str,
        usage: EmbeddingUsage,
    ) -> Result<String> {
        self.settle_exact_inner(attempt, provider_operation_id, usage, None)
    }

    /// Store a paid result and its exact usage evidence in one retained commit.
    pub fn settle_exact_with_embedding(
        &self,
        attempt: &CoreUsageAttempt,
        provider_operation_id: &str,
        usage: EmbeddingUsage,
        input_hash: &[u8; 32],
        vector: &[f64],
    ) -> Result<String> {
        if vector.len() != 1536 || vector.iter().any(|v| !v.is_finite()) {
            bail!("invalid retained embedding result");
        }
        self.settle_exact_inner(
            attempt,
            provider_operation_id,
            usage,
            Some((input_hash, vector)),
        )
    }

    pub fn cached_embedding(&self, input_hash: &[u8; 32]) -> Result<Option<Vec<f64>>> {
        let conn = self.connection()?;
        let retained: Option<(Option<String>, i64)> = conn
            .query_row(
                "SELECT r.vector_json, r.created_at_ms FROM dust_embedding_results r
                 JOIN dust_usage_attempts a ON a.attempt_id = r.attempt_id
                 WHERE r.input_hash = ?1 AND a.state = 'exact'",
                [input_hash.as_slice()],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .optional()?;
        // A `match`, not `let ... else`: cc-check's Rust grammar loses every
        // declaration after a let-else, including the contracts below.
        let (json, created_at_ms) = match retained {
            Some(retained) => retained,
            None => return Ok(None),
        };
        if created_at_ms < now_ms() - EMBEDDING_RESULT_RETRY_WINDOW_MS {
            return Err(PaidEmbeddingRecoveryRequired.into());
        }
        let json = json.ok_or(PaidEmbeddingRecoveryRequired)?;
        let vector: Vec<f64> =
            serde_json::from_str(&json).map_err(|_| PaidEmbeddingRecoveryRequired)?;
        if vector.len() != 1536 || vector.iter().any(|v| !v.is_finite()) {
            return Err(PaidEmbeddingRecoveryRequired.into());
        }
        Ok(Some(vector))
    }

    fn settle_exact_inner(
        &self,
        attempt: &CoreUsageAttempt,
        provider_operation_id: &str,
        usage: EmbeddingUsage,
        embedding: Option<(&[u8; 32], &[f64])>,
    ) -> Result<String> {
        validate_attempt(attempt)?;
        validate_reference(provider_operation_id)?;
        let mut conn = self.connection()?;
        let tx = conn.transaction_with_behavior(TransactionBehavior::Immediate)?;
        let existing = tx
            .query_row(
                "SELECT provider_request_id, tenant_id, workspace_id, conversation_id, route_id,
                        model, state, provider_operation_id, event_envelope, created_at_ms
                 FROM dust_usage_attempts WHERE attempt_id = ?1",
                [&attempt.attempt_id],
                |r| {
                    Ok((
                        CoreUsageAttempt {
                            attempt_id: attempt.attempt_id.clone(),
                            provider_request_id: r.get(0)?,
                            tenant_id: r.get(1)?,
                            workspace_id: r.get(2)?,
                            conversation_id: r.get(3)?,
                            route_id: r.get(4)?,
                            model: r.get(5)?,
                        },
                        r.get::<_, String>(6)?,
                        r.get::<_, Option<String>>(7)?,
                        r.get::<_, Option<String>>(8)?,
                        r.get::<_, i64>(9)?,
                    ))
                },
            )
            .optional()?
            .ok_or_else(|| anyhow!("Core usage attempt was not durably started"))?;
        if existing.0 != *attempt {
            bail!("conflicting Core usage attempt identity");
        }
        let envelope = build_envelope(attempt, provider_operation_id, usage, existing.4)?;
        match existing.1.as_str() {
            "exact"
                if existing.2.as_deref() == Some(provider_operation_id)
                    && existing.3.as_deref() == Some(envelope.as_str()) =>
            {
                tx.execute(
                    "UPDATE dust_usage_attempts SET manual_review_required = 0,
                     first_unresolved_at_ms = ?2, next_retry_at_ms = ?2, updated_at_ms = ?2
                     WHERE attempt_id = ?1 AND manual_review_required = 1",
                    params![attempt.attempt_id, now_ms()],
                )?;
            }
            "started" | "unknown" | "manual_review_required" => {
                tx.execute(
                    "UPDATE dust_usage_attempts SET state = 'exact', provider_operation_id = ?2,
                     event_envelope = ?3, first_unresolved_at_ms = ?4, next_retry_at_ms = ?4,
                     manual_review_required = 0, updated_at_ms = ?4
                     WHERE attempt_id = ?1",
                    params![
                        attempt.attempt_id,
                        provider_operation_id,
                        envelope,
                        now_ms()
                    ],
                )?;
            }
            _ => bail!("conflicting Core usage terminal replay"),
        }
        if let Some((input_hash, vector)) = embedding {
            tx.execute(
                "UPDATE dust_embedding_results SET vector_json = NULL
                 WHERE created_at_ms < ?1 AND vector_json IS NOT NULL",
                [now_ms() - EMBEDDING_RESULT_RETRY_WINDOW_MS],
            )?;
            let updated = tx.execute(
                "UPDATE dust_embedding_results SET vector_json = ?3, created_at_ms = ?4
                 WHERE input_hash = ?1 AND attempt_id = ?2
                   AND (vector_json IS NULL OR vector_json = ?3)",
                params![
                    input_hash.as_slice(),
                    attempt.attempt_id,
                    serde_json::to_string(vector)?,
                    now_ms()
                ],
            )?;
            if updated != 1 {
                bail!("Core embedding reservation missing or conflicting");
            }
        }
        tx.commit()?;
        Ok(envelope)
    }

    /// @cc [owner:jchen0824,label:security;backend] dust-core-direct-rows-never-claimed
    /// Rows on `DIRECT_POC_ROUTE_ID` are never leased, in any state, so no
    /// delivery, deferral or manual-review path can act on them. A signed
    /// route's rows remain claimable whatever their tenant ID, including
    /// `DIRECT_POC_TENANT_ID`.
    pub fn claim_due(&self, lease_owner: &str, limit: usize) -> Result<Vec<ClaimedWork>> {
        validate_identity(lease_owner)?;
        if !(1..=100).contains(&limit) {
            bail!("invalid Core usage claim limit");
        }
        let conn = self.connection()?;
        let now = now_ms();
        let nonce = Uuid::new_v4().to_string();
        // Atomically leases due reconciliation and outbox work. The nonce protects
        // against a stale worker completing a newer claim by the same owner.
        let mut stmt = conn.prepare(
            "WITH due AS (
               SELECT attempt_id, next_retry_at_ms, created_at_ms,
                      CASE WHEN state = 'exact' AND retry_count = 0 THEN 0 ELSE 1 END AS class
               FROM dust_usage_attempts
               WHERE delivered_at_ms IS NULL AND next_retry_at_ms <= ?1
                 AND manual_review_required = 0
                 AND (lease_until_ms IS NULL OR lease_until_ms < ?1)
                 AND state IN ('started', 'unknown', 'exact')
                 AND route_id <> ?6
             ), ranked AS (
               SELECT attempt_id, class, next_retry_at_ms,
                      row_number() OVER (
                        PARTITION BY class
                        ORDER BY next_retry_at_ms, created_at_ms, attempt_id
                      ) AS rank
               FROM due
             ), chosen AS (
               SELECT attempt_id FROM ranked
               ORDER BY CASE WHEN ?2 = 1 THEN 0
                             WHEN class = 1 AND rank = 1 THEN 0
                             WHEN class = 0 AND rank < ?2 THEN 1
                             WHEN class = 1 THEN 2 ELSE 3 END,
                        next_retry_at_ms, rank
               LIMIT ?2
             )
             UPDATE dust_usage_attempts SET lease_owner = ?3, lease_nonce = ?4,
               lease_until_ms = ?5, updated_at_ms = ?1
             WHERE attempt_id IN (SELECT attempt_id FROM chosen)
             RETURNING attempt_id, tenant_id, workspace_id, route_id, provider_request_id,
               provider_operation_id, state, event_envelope, first_unresolved_at_ms,
               retry_count, manual_review_required, lease_owner, lease_nonce",
        )?;
        let claims = stmt
            .query_map(
                params![
                    now,
                    limit as i64,
                    lease_owner,
                    nonce,
                    now + CLAIM_LEASE_MS,
                    DIRECT_POC_ROUTE_ID
                ],
                |r| {
                    Ok(ClaimedWork {
                        attempt_id: r.get(0)?,
                        tenant_id: r.get(1)?,
                        workspace_id: r.get(2)?,
                        route_id: r.get(3)?,
                        provider_request_id: r.get(4)?,
                        provider_operation_id: r.get(5)?,
                        state: r.get(6)?,
                        event_envelope: r.get(7)?,
                        first_unresolved_at_ms: r.get(8)?,
                        retry_count: r.get(9)?,
                        manual_review_required: r.get::<_, i64>(10)? != 0,
                        lease_owner: r.get(11)?,
                        lease_nonce: r.get(12)?,
                    })
                },
            )?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        Ok(claims)
    }

    /// Confirm the exact frozen row and active lease before any tenant I/O.
    pub fn validate_leased_claim(&self, claim: &ClaimedWork) -> Result<()> {
        validate_identity(&claim.attempt_id)?;
        validate_identity(&claim.lease_owner)?;
        validate_identity(&claim.lease_nonce)?;
        let conn = self.connection()?;
        let persisted = conn
            .query_row(
                "SELECT attempt_id, tenant_id, workspace_id, route_id, provider_request_id,
                        provider_operation_id, state, event_envelope,
                        first_unresolved_at_ms, retry_count, manual_review_required,
                        lease_owner, lease_nonce
                 FROM dust_usage_attempts
                 WHERE attempt_id = ?1 AND lease_owner = ?2 AND lease_nonce = ?3
                   AND lease_until_ms > ?4 AND state = 'exact' AND delivered_at_ms IS NULL",
                params![
                    claim.attempt_id,
                    claim.lease_owner,
                    claim.lease_nonce,
                    now_ms()
                ],
                |r| {
                    Ok(ClaimedWork {
                        attempt_id: r.get(0)?,
                        tenant_id: r.get(1)?,
                        workspace_id: r.get(2)?,
                        route_id: r.get(3)?,
                        provider_request_id: r.get(4)?,
                        provider_operation_id: r.get(5)?,
                        state: r.get(6)?,
                        event_envelope: r.get(7)?,
                        first_unresolved_at_ms: r.get(8)?,
                        retry_count: r.get(9)?,
                        manual_review_required: r.get::<_, i64>(10)? != 0,
                        lease_owner: r.get(11)?,
                        lease_nonce: r.get(12)?,
                    })
                },
            )
            .optional()?;
        if persisted.as_ref() != Some(claim) {
            bail!("Core usage claim is not the leased frozen row");
        }
        Ok(())
    }

    /// Acknowledge only after the tenant stream durably accepts the frozen event.
    pub fn complete_delivery(&self, claim: &ClaimedWork) -> Result<()> {
        let conn = self.connection()?;
        let now = now_ms();
        let changed = conn.execute(
            "UPDATE dust_usage_attempts SET delivered_at_ms = ?4,
             next_retry_at_ms = NULL, lease_owner = NULL, lease_nonce = NULL,
             lease_until_ms = NULL, manual_review_required = 0, updated_at_ms = ?4
             WHERE attempt_id = ?1 AND lease_owner = ?2 AND lease_nonce = ?3
               AND lease_until_ms > ?4 AND state = 'exact' AND event_envelope IS NOT NULL",
            params![claim.attempt_id, claim.lease_owner, claim.lease_nonce, now],
        )?;
        if changed != 1 {
            bail!("Core usage delivery lease was lost or attempt is not exact");
        }
        Ok(())
    }

    /// Defer reconciliation or a failed outbox delivery. Never retries the paid
    /// model effect. At 24 hours, keep work visible and blocked for manual review.
    pub fn defer_claim(&self, claim: &ClaimedWork) -> Result<()> {
        let conn = self.connection()?;
        let now = now_ms();
        let changed = conn.execute(
            "UPDATE dust_usage_attempts SET
               state = CASE WHEN state = 'exact' THEN 'exact'
                            WHEN COALESCE(first_unresolved_at_ms, created_at_ms) <= ?5
                              THEN 'manual_review_required' ELSE 'unknown' END,
               first_unresolved_at_ms = COALESCE(first_unresolved_at_ms, ?4),
               manual_review_required = CASE WHEN COALESCE(first_unresolved_at_ms, created_at_ms) <= ?5
                                             THEN 1 ELSE 0 END,
               retry_count = retry_count + 1, next_retry_at_ms = ?6,
               lease_owner = NULL, lease_nonce = NULL, lease_until_ms = NULL,
               updated_at_ms = ?4
             WHERE attempt_id = ?1 AND lease_owner = ?2 AND lease_nonce = ?3
               AND lease_until_ms > ?4 AND state IN ('started', 'unknown', 'exact', 'manual_review_required')",
            params![
                claim.attempt_id,
                claim.lease_owner,
                claim.lease_nonce,
                now,
                now - REVIEW_DEADLINE_MS,
                now + RETRY_DELAY_MS
            ],
        )?;
        if changed != 1 {
            bail!("Core usage reconciliation lease was lost");
        }
        Ok(())
    }
}

fn now_ms() -> i64 {
    Utc::now().timestamp_millis()
}

fn validate_identity(value: &str) -> Result<()> {
    if value.is_empty()
        || value.len() > 128
        || value == "unknown"
        || !value
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-')
    {
        bail!("invalid Core usage identity");
    }
    Ok(())
}

fn validate_reference(value: &str) -> Result<()> {
    if value.is_empty()
        || value.len() > 256
        || !value
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'_' | b'-' | b'.' | b':' | b'/'))
    {
        bail!("invalid Core usage reference");
    }
    Ok(())
}

fn validate_attempt(a: &CoreUsageAttempt) -> Result<()> {
    for id in [&a.attempt_id, &a.provider_request_id, &a.tenant_id] {
        validate_identity(id)?;
    }
    if a.workspace_id.is_empty() || a.workspace_id.encode_utf16().count() > 256 {
        bail!("invalid Core usage workspace");
    }
    for reference in [&a.conversation_id, &a.route_id, &a.model] {
        validate_reference(reference)?;
    }
    Ok(())
}

fn build_envelope(
    attempt: &CoreUsageAttempt,
    provider_operation_id: &str,
    usage: EmbeddingUsage,
    created_at_ms: i64,
) -> Result<String> {
    if usage.input_tokens > ENVELOPE_INPUT_TOKENS_MAX {
        bail!("invalid provider usage metadata");
    }
    let time = Utc
        .timestamp_millis_opt(created_at_ms)
        .single()
        .ok_or_else(|| anyhow!("invalid Core usage event time"))?;
    let mut fields = BTreeMap::new();
    for (key, value) in [
        ("tenant_id", attempt.tenant_id.as_str()),
        ("agent", "dust"),
        ("component", "dust-core"),
        ("workspace_id", attempt.workspace_id.as_str()),
        ("attempt_id", attempt.attempt_id.as_str()),
        ("conversation_id", attempt.conversation_id.as_str()),
        ("provider_operation_id", provider_operation_id),
        ("model", attempt.model.as_str()),
        ("event_type", "token"),
        ("output_tokens", "0"),
        ("cache_read_tokens", "0"),
        ("cache_write_tokens", "0"),
        ("quantity", "0"),
    ] {
        fields.insert(key, value.to_owned());
    }
    fields.insert("ts", time.to_rfc3339_opts(SecondsFormat::Millis, true));
    fields.insert("input_tokens", usage.input_tokens.to_string());
    Ok(serde_json::to_string(&fields)?)
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::tempdir;

    #[test]
    fn expired_start_cannot_be_renewed_for_provider_dispatch() {
        let dir = tempdir().expect("test directory");
        let journal = CoreUsageJournal::open(dir.path().join("usage.sqlite")).expect("journal");
        let entry = attempt("expired-start");
        journal.start(&entry).expect("durable start");
        journal
            .connection()
            .expect("journal connection")
            .execute(
                "UPDATE dust_usage_attempts SET next_retry_at_ms = ?1 WHERE attempt_id = ?2",
                params![now_ms() - 1, entry.attempt_id],
            )
            .expect("expire start");
        assert!(journal.heartbeat_started(&entry.attempt_id).is_err());
    }

    #[test]
    fn embedding_reservation_blocks_duplicate_dispatch_and_releases_proven_no_charge() {
        let dir = tempdir().expect("test directory");
        let journal = CoreUsageJournal::open(dir.path().join("usage.sqlite")).expect("journal");
        let hash = [3_u8; 32];
        let first = attempt("first-embedding");
        let duplicate = attempt("duplicate-embedding");
        let other = attempt("other-document");
        assert!(matches!(
            journal
                .start_embedding(&first, &hash)
                .expect("first permit"),
            StartOutcome::Created(_)
        ));
        assert_eq!(
            journal
                .start_embedding(&duplicate, &hash)
                .expect("duplicate blocked"),
            StartOutcome::Duplicate
        );
        assert!(journal
            .connection()
            .expect("connection")
            .query_row(
                "SELECT attempt_id FROM dust_usage_attempts WHERE attempt_id = ?1",
                [&duplicate.attempt_id],
                |row| row.get::<_, String>(0),
            )
            .optional()
            .expect("rolled back attempt")
            .is_none());
        assert!(matches!(
            journal
                .start_embedding(&other, &[4_u8; 32])
                .expect("different document permit"),
            StartOutcome::Created(_)
        ));
        journal
            .settle_no_charge(&first.attempt_id, "predispatch:denied")
            .expect("proven no charge");
        assert!(matches!(
            journal
                .start_embedding(&duplicate, &hash)
                .expect("reservation released"),
            StartOutcome::Created(_)
        ));
    }

    #[test]
    fn settled_embedding_survives_reopen_and_never_precedes_exact_usage() {
        let dir = tempdir().expect("test directory");
        let path = dir.path().join("usage.sqlite");
        let journal = CoreUsageJournal::open(&path).expect("journal");
        let entry = attempt("cached-embedding");
        let hash = [7_u8; 32];
        assert!(journal
            .cached_embedding(&hash)
            .expect("cache read")
            .is_none());
        journal
            .start_embedding(&entry, &hash)
            .expect("durable reservation");
        assert!(journal
            .cached_embedding(&hash)
            .expect("cache read")
            .is_none());
        let vector = vec![0.25; 1536];
        journal
            .settle_exact_with_embedding(
                &entry,
                "client:cached-embedding",
                EmbeddingUsage { input_tokens: 7 },
                &hash,
                &vector,
            )
            .expect("atomic settlement");
        let reopened = CoreUsageJournal::open(&path).expect("reopen journal");
        assert_eq!(
            reopened.cached_embedding(&hash).expect("cache read"),
            Some(vector)
        );
        assert_eq!(
            reopened
                .claim_due("cache-test-worker", 1)
                .expect("usage claim")[0]
                .state,
            "exact"
        );
        reopened
            .connection()
            .expect("journal connection")
            .execute(
                "UPDATE dust_embedding_results SET created_at_ms = ?1 WHERE input_hash = ?2",
                params![
                    now_ms() - EMBEDDING_RESULT_RETRY_WINDOW_MS - 1,
                    hash.as_slice()
                ],
            )
            .expect("age retained vector");
        let reopened = CoreUsageJournal::open(&path).expect("reopen and prune");
        assert!(reopened.cached_embedding(&hash).is_err());
        let retained_marker: Option<String> = reopened
            .connection()
            .expect("journal connection")
            .query_row(
                "SELECT vector_json FROM dust_embedding_results WHERE input_hash = ?1",
                [hash.as_slice()],
                |row| row.get(0),
            )
            .expect("retained marker");
        assert!(retained_marker.is_none());
    }

    fn attempt(id: &str) -> CoreUsageAttempt {
        CoreUsageAttempt {
            attempt_id: id.into(),
            provider_request_id: format!("provider_{id}"),
            tenant_id: "tenant_A".into(),
            workspace_id: "workspace_A".into(),
            conversation_id: "data-source/1".into(),
            route_id: "route_A".into(),
            model: "gemini-embedding-2-1536".into(),
        }
    }

    #[test]
    fn start_is_durable_and_duplicate_never_reauthorizes_io() {
        let dir = tempdir().expect("test operation failed");
        let path = dir.path().join("core-usage.sqlite");
        let j = CoreUsageJournal::open(&path).expect("test operation failed");
        let a = attempt("a1");
        assert!(matches!(
            j.start(&a).expect("test operation failed"),
            StartOutcome::Created(_)
        ));
        drop(j);
        let j = CoreUsageJournal::open(&path).expect("test operation failed");
        assert_eq!(
            j.start(&a).expect("test operation failed"),
            StartOutcome::Duplicate
        );
        let mut conflict = a.clone();
        conflict.tenant_id = "tenant_B".into();
        assert!(j.start(&conflict).is_err());
        let mut second = attempt("a2");
        second.provider_request_id = a.provider_request_id;
        assert!(j.start(&second).is_err());
    }

    #[test]
    fn exact_envelope_is_frozen_and_claim_is_fenced() {
        let dir = tempdir().expect("test operation failed");
        let j = CoreUsageJournal::open(dir.path().join("core-usage.sqlite"))
            .expect("test operation failed");
        let a = attempt("a1");
        j.start(&a).expect("test operation failed");
        let first = j
            .settle_exact(
                &a,
                "provider_receipt_1",
                EmbeddingUsage { input_tokens: 23 },
            )
            .expect("test operation failed");
        let replay = j
            .settle_exact(
                &a,
                "provider_receipt_1",
                EmbeddingUsage { input_tokens: 23 },
            )
            .expect("test operation failed");
        assert_eq!(first, replay);
        assert!(first.contains("\"tenant_id\":\"tenant_A\""));
        let event: serde_json::Value = serde_json::from_str(&first).expect("test operation failed");
        let keys: Vec<&str> = event
            .as_object()
            .expect("test operation failed")
            .keys()
            .map(String::as_str)
            .collect();
        assert_eq!(
            keys,
            vec![
                "agent",
                "attempt_id",
                "cache_read_tokens",
                "cache_write_tokens",
                "component",
                "conversation_id",
                "event_type",
                "input_tokens",
                "model",
                "output_tokens",
                "provider_operation_id",
                "quantity",
                "tenant_id",
                "ts",
                "workspace_id",
            ]
        );
        assert!(j
            .settle_exact(
                &a,
                "provider_receipt_1",
                EmbeddingUsage { input_tokens: 24 }
            )
            .is_err());
        assert!(j.settle_no_charge("a1", "receipt/no-charge").is_err());
        let claim = j
            .claim_due("worker_1", 10)
            .expect("test operation failed")
            .remove(0);
        assert_eq!(claim.workspace_id, "workspace_A");
        assert_eq!(claim.event_envelope.as_deref(), Some(first.as_str()));
        assert!(j
            .claim_due("worker_2", 10)
            .expect("test operation failed")
            .is_empty());
        let mut stale = claim.clone();
        stale.lease_nonce = "wrong".into();
        assert!(j.complete_delivery(&stale).is_err());
        j.complete_delivery(&claim).expect("test operation failed");
        assert!(j
            .claim_due("worker_2", 10)
            .expect("test operation failed")
            .is_empty());
    }

    #[test]
    fn health_reports_unresolved_and_undelivered_work_per_tenant() {
        let dir = tempdir().expect("test operation failed");
        let j = CoreUsageJournal::open(dir.path().join("core-usage.sqlite"))
            .expect("test operation failed");
        let a = attempt("a1");
        let b = attempt("a2");
        j.start(&a).expect("test operation failed");
        j.start(&b).expect("test operation failed");
        j.settle_exact(&b, "receipt_2", EmbeddingUsage { input_tokens: 2 })
            .expect("test operation failed");
        let health = j.read_health("tenant_A").expect("test operation failed");
        assert_eq!(health.unresolved_count, 1);
        assert!(health.oldest_delivery_at_seconds > 0.0);
        assert!(health.checked_at_seconds >= health.oldest_delivery_at_seconds);
        assert_eq!(
            j.read_health("tenant_B")
                .expect("test operation failed")
                .unresolved_count,
            0
        );
        j.settle_no_charge("a1", "predispatch:test:a1")
            .expect("test operation failed");
        assert_eq!(
            j.read_health("tenant_A")
                .expect("test operation failed")
                .unresolved_count,
            0
        );
        let claim = j
            .claim_due("worker_health", 10)
            .expect("test operation failed")
            .remove(0);
        j.complete_delivery(&claim).expect("test operation failed");
        assert_eq!(
            j.read_health("tenant_A")
                .expect("test operation failed")
                .oldest_delivery_at_seconds,
            0.0
        );
    }

    #[test]
    fn ambiguous_effect_stays_unresolved_through_retries_and_deadline() {
        let dir = tempdir().expect("test operation failed");
        let j = CoreUsageJournal::open(dir.path().join("core-usage.sqlite"))
            .expect("test operation failed");
        j.start(&attempt("a1")).expect("test operation failed");
        j.mark_unknown("a1").expect("test operation failed");
        j.mark_unknown("a1").expect("test operation failed");
        let first = j
            .claim_due("worker_1", 10)
            .expect("test operation failed")
            .remove(0);
        assert_eq!(first.state, "unknown");
        j.defer_claim(&first).expect("test operation failed");
        let conn = j.connection().expect("test operation failed");
        conn.execute(
            "UPDATE dust_usage_attempts SET next_retry_at_ms = ?2,
             first_unresolved_at_ms = ?3 WHERE attempt_id = ?1",
            params!["a1", now_ms() - 1, now_ms() - REVIEW_DEADLINE_MS - 1],
        )
        .expect("test operation failed");
        let overdue = j
            .claim_due("worker_2", 10)
            .expect("test operation failed")
            .remove(0);
        j.defer_claim(&overdue).expect("test operation failed");
        let state: String = conn
            .query_row(
                "SELECT state FROM dust_usage_attempts WHERE attempt_id = 'a1'",
                [],
                |r| r.get(0),
            )
            .expect("test operation failed");
        assert_eq!(state, "manual_review_required");
        conn.execute(
            "UPDATE dust_usage_attempts SET next_retry_at_ms = ?2 WHERE attempt_id = ?1",
            params!["a1", now_ms() - 1],
        )
        .expect("test retry update failed");
        assert!(j
            .claim_due("worker_manual", 10)
            .expect("test claim failed")
            .is_empty());
        j.settle_no_charge("a1", "provider/verified-no-charge")
            .expect("test operation failed");
        assert!(j
            .claim_due("worker_3", 10)
            .expect("test operation failed")
            .is_empty());
    }

    #[test]
    fn exact_row_flagged_for_manual_review_is_not_reclaimed() {
        let dir = tempdir().expect("test operation failed");
        let journal = CoreUsageJournal::open(dir.path().join("core-usage.sqlite"))
            .expect("test operation failed");
        let attempt = attempt("manual-exact");
        journal.start(&attempt).expect("test operation failed");
        journal
            .settle_exact(
                &attempt,
                "manual-provider-operation",
                EmbeddingUsage { input_tokens: 2 },
            )
            .expect("test operation failed");
        let claim = journal
            .claim_due("manual-worker", 1)
            .expect("test operation failed")
            .remove(0);
        let conn = journal.connection().expect("test operation failed");
        conn.execute(
            "UPDATE dust_usage_attempts SET first_unresolved_at_ms = ?2 WHERE attempt_id = ?1",
            params![attempt.attempt_id, now_ms() - REVIEW_DEADLINE_MS - 1],
        )
        .expect("test operation failed");
        journal.defer_claim(&claim).expect("test operation failed");
        conn.execute(
            "UPDATE dust_usage_attempts SET next_retry_at_ms = ?2 WHERE attempt_id = ?1",
            params![attempt.attempt_id, now_ms() - 1],
        )
        .expect("test operation failed");
        assert!(journal
            .claim_due("another-worker", 1)
            .expect("test operation failed")
            .is_empty());
        journal
            .settle_exact(
                &attempt,
                "manual-provider-operation",
                EmbeddingUsage { input_tokens: 2 },
            )
            .expect("test exact evidence failed");
        let replayed = journal
            .claim_due("evidence-worker", 1)
            .expect("test claim failed")
            .remove(0);
        journal.defer_claim(&replayed).expect("test defer failed");
        let (state, manual): (String, i64) = conn
            .query_row(
                "SELECT state, manual_review_required FROM dust_usage_attempts WHERE attempt_id = ?1",
                [&attempt.attempt_id],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .expect("test query failed");
        assert_eq!(state, "exact");
        assert_eq!(manual, 0);
        conn.execute(
            "UPDATE dust_usage_attempts SET next_retry_at_ms = ?2 WHERE attempt_id = ?1",
            params![attempt.attempt_id, now_ms() - 1],
        )
        .expect("test operation failed");
        assert_eq!(
            journal
                .claim_due("retry-worker", 1)
                .expect("test claim failed")
                .len(),
            1
        );
    }

    #[test]
    fn fresh_exact_usage_is_not_starved_by_failed_older_claims() {
        let dir = tempdir().expect("test operation failed");
        let journal = CoreUsageJournal::open(dir.path().join("core-usage.sqlite"))
            .expect("test operation failed");
        let conn = journal.connection().expect("test operation failed");
        for index in 0..4 {
            let entry = attempt(&format!("fair-{index}"));
            journal.start(&entry).expect("test operation failed");
            journal
                .settle_exact(
                    &entry,
                    &format!("provider-fair-{index}"),
                    EmbeddingUsage { input_tokens: 1 },
                )
                .expect("test operation failed");
            if index < 3 {
                conn.execute(
                    "UPDATE dust_usage_attempts SET retry_count = 1 WHERE attempt_id = ?1",
                    [&entry.attempt_id],
                )
                .expect("test operation failed");
            }
        }
        let claimed = journal
            .claim_due("fair-worker", 3)
            .expect("test claim failed");
        assert!(claimed.iter().any(|claim| claim.attempt_id == "fair-3"));
    }

    #[test]
    fn older_reconciliation_keeps_a_slot_when_fresh_exact_work_is_continuous() {
        let dir = tempdir().expect("test operation failed");
        let journal = CoreUsageJournal::open(dir.path().join("core-usage.sqlite"))
            .expect("test operation failed");
        let older = attempt("older-reconciliation");
        journal.start(&older).expect("test operation failed");
        journal
            .mark_unknown(&older.attempt_id)
            .expect("test operation failed");
        for index in 0..4 {
            let entry = attempt(&format!("fresh-{index}"));
            journal.start(&entry).expect("test operation failed");
            journal
                .settle_exact(
                    &entry,
                    &format!("provider-fresh-{index}"),
                    EmbeddingUsage { input_tokens: 1 },
                )
                .expect("test operation failed");
        }
        let claims = journal
            .claim_due("fair-worker", 3)
            .expect("test operation failed");
        assert_eq!(claims.len(), 3);
        assert!(claims
            .iter()
            .any(|claim| claim.attempt_id == older.attempt_id));
        assert_eq!(
            claims.iter().filter(|claim| claim.state == "exact").count(),
            2
        );
    }

    #[test]
    fn unchanged_registry_fence_does_not_require_the_writer_lock() {
        let dir = tempdir().expect("test operation failed");
        let journal = CoreUsageJournal::open(dir.path().join("core-usage.sqlite"))
            .expect("test operation failed");
        let tenants = HashMap::from([("tenant-a".to_owned(), "identity-a".to_owned())]);
        journal
            .fence_registry(1, [7; 32], &tenants)
            .expect("test operation failed");
        let mut other = journal.connection().expect("test operation failed");
        let writer = other
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .expect("test operation failed");
        journal
            .fence_registry(1, [7; 32], &tenants)
            .expect("unchanged fence should only read");
        writer.rollback().expect("test operation failed");
    }

    #[test]
    fn leased_claim_validation_rejects_changed_frozen_evidence() {
        let dir = tempdir().expect("test operation failed");
        let journal = CoreUsageJournal::open(dir.path().join("core-usage.sqlite"))
            .expect("test operation failed");
        let entry = attempt("frozen-claim");
        journal.start(&entry).expect("test operation failed");
        journal
            .settle_exact(
                &entry,
                "provider-frozen-claim",
                EmbeddingUsage { input_tokens: 2 },
            )
            .expect("test operation failed");
        let claim = journal
            .claim_due("worker-frozen", 1)
            .expect("test operation failed")
            .remove(0);
        journal
            .validate_leased_claim(&claim)
            .expect("valid frozen claim");
        let mut modified = claim.clone();
        modified.event_envelope = Some("{\"fabricated\":true}".into());
        assert!(journal.validate_leased_claim(&modified).is_err());
    }

    #[test]
    fn expired_lease_is_reclaimed_after_reopen_and_stale_worker_is_rejected() {
        let dir = tempdir().expect("test operation failed");
        let path = dir.path().join("core-usage.sqlite");
        let j = CoreUsageJournal::open(&path).expect("test operation failed");
        let a = attempt("a1");
        j.start(&a).expect("test operation failed");
        j.settle_exact(&a, "receipt_1", EmbeddingUsage { input_tokens: 4 })
            .expect("test operation failed");
        let stale = j
            .claim_due("worker_1", 1)
            .expect("test operation failed")
            .remove(0);
        drop(j);

        let j = CoreUsageJournal::open(&path).expect("test operation failed");
        assert!(j
            .claim_due("worker_2", 1)
            .expect("test operation failed")
            .is_empty());
        j.connection()
            .expect("test operation failed")
            .execute(
                "UPDATE dust_usage_attempts SET lease_until_ms = ?2 WHERE attempt_id = ?1",
                params![a.attempt_id, now_ms() - 1],
            )
            .expect("test operation failed");
        let replacement = j
            .claim_due("worker_2", 1)
            .expect("test operation failed")
            .remove(0);
        assert_eq!(replacement.event_envelope, stale.event_envelope);
        assert!(j.complete_delivery(&stale).is_err());
        j.complete_delivery(&replacement)
            .expect("test operation failed");
    }

    #[test]
    fn durable_start_failure_is_not_a_dispatch_allowance() {
        let dir = tempdir().expect("test operation failed");
        assert!(CoreUsageJournal::open(dir.path()).is_err());
        assert!(CoreUsageJournal::open(":memory:").is_err());
    }

    const RESERVATION: u64 = 100;

    fn direct_attempt(id: &str) -> CoreUsageAttempt {
        CoreUsageAttempt {
            attempt_id: id.into(),
            provider_request_id: format!("provider_{id}"),
            tenant_id: DIRECT_POC_TENANT_ID.into(),
            workspace_id: "workspace_A".into(),
            conversation_id: "embedding:workspace_A".into(),
            route_id: DIRECT_POC_ROUTE_ID.into(),
            model: "gemini-embedding-2-1536".into(),
        }
    }

    fn start_direct(
        journal: &CoreUsageJournal,
        attempt: &CoreUsageAttempt,
        input_hash: Option<&[u8; 32]>,
        since_ms: i64,
        daily_token_limit: u64,
    ) -> DirectStartOutcome {
        journal
            .start_direct_within_limit(
                attempt,
                input_hash,
                since_ms,
                daily_token_limit,
                RESERVATION,
            )
            .expect("direct start")
    }

    fn row_counts(journal: &CoreUsageJournal) -> (i64, i64) {
        journal
            .connection()
            .expect("journal connection")
            .query_row(
                "SELECT (SELECT count(*) FROM dust_usage_attempts),
                        (SELECT count(*) FROM dust_embedding_results)",
                [],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .expect("row counts")
    }

    #[test]
    fn bundled_sqlite_extracts_frozen_string_input_tokens() {
        let dir = tempdir().expect("test directory");
        let journal = CoreUsageJournal::open(dir.path().join("usage.sqlite")).expect("journal");
        let entry = direct_attempt("json-envelope");
        start_direct(&journal, &entry, None, 0, 1_000);
        journal
            .settle_exact(&entry, "client:json", EmbeddingUsage { input_tokens: 23 })
            .expect("exact settlement");
        // libsqlite3-sys 0.28 bundles SQLite 3.45 with JSON1 enabled.
        let (kind, tokens): (String, i64) = journal
            .connection()
            .expect("journal connection")
            .query_row(
                "SELECT typeof(json_extract(event_envelope, '$.input_tokens')),
                        CAST(json_extract(event_envelope, '$.input_tokens') AS INTEGER)
                 FROM dust_usage_attempts WHERE attempt_id = ?1",
                [&entry.attempt_id],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .expect("json_extract over the frozen envelope");
        assert_eq!((kind.as_str(), tokens), ("text", 23));
    }

    #[test]
    fn direct_over_limit_start_writes_no_row() {
        let dir = tempdir().expect("test directory");
        let journal = CoreUsageJournal::open(dir.path().join("usage.sqlite")).expect("journal");
        for index in 0..3 {
            assert!(matches!(
                start_direct(
                    &journal,
                    &direct_attempt(&format!("within-{index}")),
                    None,
                    0,
                    3 * RESERVATION,
                ),
                DirectStartOutcome::Created(_)
            ));
        }
        assert_eq!(row_counts(&journal), (3, 0));
        assert_eq!(
            start_direct(
                &journal,
                &direct_attempt("over"),
                Some(&[9_u8; 32]),
                0,
                3 * RESERVATION,
            ),
            DirectStartOutcome::OverLimit
        );
        assert_eq!(row_counts(&journal), (3, 0));
    }

    #[test]
    fn direct_unsettled_attempts_hold_their_reservation() {
        let dir = tempdir().expect("test directory");
        let journal = CoreUsageJournal::open(dir.path().join("usage.sqlite")).expect("journal");
        let limit = 2 * RESERVATION;
        let unknown = direct_attempt("unknown-effect");
        let review = direct_attempt("review");
        let next = direct_attempt("next");
        start_direct(&journal, &unknown, None, 0, limit);
        start_direct(&journal, &review, None, 0, limit);
        assert_eq!(
            start_direct(&journal, &next, None, 0, limit),
            DirectStartOutcome::OverLimit
        );
        journal
            .mark_unknown(&unknown.attempt_id)
            .expect("ambiguous effect");
        journal
            .connection()
            .expect("journal connection")
            .execute(
                "UPDATE dust_usage_attempts SET state = 'manual_review_required',
                 manual_review_required = 1 WHERE attempt_id = ?1",
                [&review.attempt_id],
            )
            .expect("manual review");
        assert_eq!(
            start_direct(&journal, &next, None, 0, limit),
            DirectStartOutcome::OverLimit
        );
        journal
            .settle_no_charge(&unknown.attempt_id, "provider/verified-no-charge")
            .expect("proven no charge");
        assert!(matches!(
            start_direct(&journal, &next, None, 0, limit),
            DirectStartOutcome::Created(_)
        ));
    }

    #[test]
    fn direct_limit_sums_exact_tokens_from_string_envelopes() {
        let dir = tempdir().expect("test directory");
        let journal = CoreUsageJournal::open(dir.path().join("usage.sqlite")).expect("journal");
        let limit = 1_000;
        for (id, input_tokens) in [("exact-a", 650), ("exact-b", 200)] {
            let entry = direct_attempt(id);
            start_direct(&journal, &entry, None, 0, limit);
            journal
                .settle_exact(
                    &entry,
                    &format!("client:{id}"),
                    EmbeddingUsage { input_tokens },
                )
                .expect("exact settlement");
        }
        // 850 exact + 100 reserved fits; 850 + 2 x 100 does not.
        assert!(matches!(
            start_direct(&journal, &direct_attempt("fits"), None, 0, limit),
            DirectStartOutcome::Created(_)
        ));
        assert_eq!(
            start_direct(&journal, &direct_attempt("exceeds"), None, 0, limit),
            DirectStartOutcome::OverLimit
        );
    }

    #[test]
    fn direct_limit_fails_closed_on_non_canonical_exact_tokens() {
        let dir = tempdir().expect("test directory");
        let journal = CoreUsageJournal::open(dir.path().join("usage.sqlite")).expect("journal");
        let limit = 1_000;
        let mut exact = Vec::new();
        for (id, input_tokens) in [("valid", 650), ("rewritten", 1)] {
            let entry = direct_attempt(id);
            start_direct(&journal, &entry, None, 0, limit);
            journal
                .settle_exact(
                    &entry,
                    &format!("client:{id}"),
                    EmbeddingUsage { input_tokens },
                )
                .expect("exact settlement");
            exact.push(entry);
        }
        let rewrite_envelope = |envelope: &str| {
            journal
                .connection()
                .expect("journal connection")
                .execute(
                    &format!(
                        "UPDATE dust_usage_attempts SET event_envelope = {envelope}
                         WHERE attempt_id = ?1"
                    ),
                    [&exact[1].attempt_id],
                )
                .expect("rewrite envelope");
        };
        // `build_envelope` writes a decimal string; anything else fails closed,
        // including a JSON number.
        for envelope in [
            "json_set(event_envelope, '$.input_tokens', 'oops')",
            "json_set(event_envelope, '$.input_tokens', '12oops')",
            "json_set(event_envelope, '$.input_tokens', '')",
            "json_set(event_envelope, '$.input_tokens', ' 12')",
            "json_set(event_envelope, '$.input_tokens', '-1')",
            "json_set(event_envelope, '$.input_tokens', '+12')",
            "json_set(event_envelope, '$.input_tokens', '012')",
            "json_set(event_envelope, '$.input_tokens', '2147483648')",
            "json_set(event_envelope, '$.input_tokens', '99999999999999999999')",
            "json_set(event_envelope, '$.input_tokens', 12)",
            "json_remove(event_envelope, '$.input_tokens')",
            "'{\"input_tokens\":'",
        ] {
            rewrite_envelope(envelope);
            assert!(
                journal
                    .start_direct_within_limit(
                        &direct_attempt("next"),
                        Some(&[7_u8; 32]),
                        0,
                        limit,
                        RESERVATION,
                    )
                    .is_err(),
                "{envelope}"
            );
            assert_eq!(row_counts(&journal), (2, 0), "{envelope}");
        }
        rewrite_envelope("json_object('input_tokens', '2147483647')");
        assert_eq!(
            start_direct(&journal, &direct_attempt("bound"), None, 0, limit),
            DirectStartOutcome::OverLimit
        );
        // 650 + 250 exact + 100 reserved fits; another 100 does not.
        rewrite_envelope("json_object('input_tokens', '250')");
        assert!(matches!(
            start_direct(&journal, &direct_attempt("fits"), None, 0, limit),
            DirectStartOutcome::Created(_)
        ));
        assert_eq!(
            start_direct(&journal, &direct_attempt("exceeds"), None, 0, limit),
            DirectStartOutcome::OverLimit
        );
    }

    #[test]
    fn direct_limit_ignores_rows_before_the_window_start() {
        let dir = tempdir().expect("test directory");
        let journal = CoreUsageJournal::open(dir.path().join("usage.sqlite")).expect("journal");
        let since_ms = now_ms() - 60_000;
        let earlier = direct_attempt("earlier");
        let boundary = direct_attempt("boundary");
        start_direct(&journal, &earlier, None, since_ms, RESERVATION);
        journal
            .settle_exact(
                &earlier,
                "client:earlier",
                EmbeddingUsage { input_tokens: 90 },
            )
            .expect("exact settlement");
        let backdate = |attempt: &CoreUsageAttempt, created_at_ms: i64| {
            journal
                .connection()
                .expect("journal connection")
                .execute(
                    "UPDATE dust_usage_attempts SET created_at_ms = ?2 WHERE attempt_id = ?1",
                    params![attempt.attempt_id, created_at_ms],
                )
                .expect("backdate attempt");
        };
        backdate(&earlier, since_ms - 1);
        assert!(matches!(
            start_direct(&journal, &boundary, None, since_ms, RESERVATION),
            DirectStartOutcome::Created(_)
        ));
        backdate(&boundary, since_ms);
        assert_eq!(
            start_direct(
                &journal,
                &direct_attempt("late"),
                None,
                since_ms,
                RESERVATION
            ),
            DirectStartOutcome::OverLimit
        );
    }

    #[test]
    fn direct_start_keeps_duplicate_input_reservation() {
        let dir = tempdir().expect("test directory");
        let journal = CoreUsageJournal::open(dir.path().join("usage.sqlite")).expect("journal");
        let hash = [5_u8; 32];
        assert!(matches!(
            start_direct(&journal, &direct_attempt("first"), Some(&hash), 0, 1_000),
            DirectStartOutcome::Created(_)
        ));
        assert_eq!(
            start_direct(&journal, &direct_attempt("second"), Some(&hash), 0, 1_000),
            DirectStartOutcome::Duplicate
        );
        assert_eq!(row_counts(&journal), (1, 1));
    }

    /// A signed attempt of a tenant named `DIRECT_POC_TENANT_ID`, as an
    /// existing signed registry may define.
    fn signed_direct_tenant_attempt(id: &str) -> CoreUsageAttempt {
        let mut signed = direct_attempt(id);
        signed.route_id = format!("{DIRECT_POC_TENANT_ID}:7");
        signed
    }

    #[test]
    fn direct_route_constant_is_not_a_signed_route() {
        let (tenant, revision) = DIRECT_POC_ROUTE_ID
            .split_once(':')
            .expect("direct route has a tenant and a revision");
        assert_eq!(tenant, DIRECT_POC_TENANT_ID);
        assert!(revision.parse::<u64>().is_err());
    }

    #[test]
    fn direct_and_signed_starts_cannot_cross_routes() {
        let dir = tempdir().expect("test directory");
        let journal = CoreUsageJournal::open(dir.path().join("usage.sqlite")).expect("journal");
        let direct = direct_attempt("direct");
        assert!(journal.start(&direct).is_err());
        assert!(journal.start_embedding(&direct, &[1_u8; 32]).is_err());
        let mut other_tenant = attempt("other-tenant");
        other_tenant.route_id = DIRECT_POC_ROUTE_ID.into();
        assert!(journal.start(&other_tenant).is_err());
        let signed = attempt("signed");
        assert!(journal
            .start_direct_within_limit(&signed, None, 0, 1_000, RESERVATION)
            .is_err());
        let signed_direct_tenant = signed_direct_tenant_attempt("signed-direct-tenant");
        assert!(journal
            .start_direct_within_limit(&signed_direct_tenant, None, 0, 1_000, RESERVATION)
            .is_err());
        for (limit, reservation) in [
            (RESERVATION - 1, RESERVATION),
            (DIRECT_DAILY_TOKEN_LIMIT_MAX + 1, RESERVATION),
            (1_000, 0),
        ] {
            assert!(journal
                .start_direct_within_limit(&direct, None, 0, limit, reservation)
                .is_err());
        }
        assert_eq!(row_counts(&journal), (0, 0));
        // A signed registry may name its tenant `poc-direct`.
        assert!(matches!(
            journal
                .start_embedding(&signed_direct_tenant, &[2_u8; 32])
                .expect("signed start of the direct tenant ID"),
            StartOutcome::Created(_)
        ));
        assert_eq!(row_counts(&journal), (1, 1));
    }

    #[test]
    fn claim_due_never_leases_direct_rows() {
        let dir = tempdir().expect("test directory");
        let journal = CoreUsageJournal::open(dir.path().join("usage.sqlite")).expect("journal");
        let direct_exact = direct_attempt("direct-exact");
        let direct_unknown = direct_attempt("direct-unknown");
        start_direct(&journal, &direct_exact, None, 0, 1_000);
        journal
            .settle_exact(
                &direct_exact,
                "client:direct-exact",
                EmbeddingUsage { input_tokens: 3 },
            )
            .expect("exact settlement");
        start_direct(&journal, &direct_unknown, None, 0, 1_000);
        journal
            .mark_unknown(&direct_unknown.attempt_id)
            .expect("ambiguous effect");
        let signed = attempt("signed-exact");
        let signed_direct_tenant = signed_direct_tenant_attempt("signed-direct-tenant");
        for entry in [&signed, &signed_direct_tenant] {
            journal.start(entry).expect("signed start");
            journal
                .settle_exact(
                    entry,
                    &format!("client:{}", entry.attempt_id),
                    EmbeddingUsage { input_tokens: 3 },
                )
                .expect("exact settlement");
        }
        let mut claimed = journal
            .claim_due("direct-filter", 100)
            .expect("claims")
            .into_iter()
            .map(|claim| claim.attempt_id)
            .collect::<Vec<_>>();
        claimed.sort();
        let mut expected = vec![
            signed.attempt_id.clone(),
            signed_direct_tenant.attempt_id.clone(),
        ];
        expected.sort();
        assert_eq!(claimed, expected);
    }

    #[test]
    fn direct_limit_and_signed_health_never_count_each_others_rows() {
        let dir = tempdir().expect("test directory");
        let journal = CoreUsageJournal::open(dir.path().join("usage.sqlite")).expect("journal");
        // Signed rows of a tenant named `poc-direct`, in the direct workspace,
        // unsettled and exact, do not hold the direct daily limit.
        let signed_unknown = signed_direct_tenant_attempt("signed-unknown");
        let signed_exact = signed_direct_tenant_attempt("signed-exact");
        journal.start(&signed_unknown).expect("signed start");
        journal
            .mark_unknown(&signed_unknown.attempt_id)
            .expect("ambiguous effect");
        journal.start(&signed_exact).expect("signed start");
        journal
            .settle_exact(
                &signed_exact,
                "client:signed-exact",
                EmbeddingUsage { input_tokens: 900 },
            )
            .expect("exact settlement");
        assert!(matches!(
            start_direct(&journal, &direct_attempt("direct-a"), None, 0, RESERVATION),
            DirectStartOutcome::Created(_)
        ));
        assert_eq!(
            start_direct(&journal, &direct_attempt("direct-b"), None, 0, RESERVATION),
            DirectStartOutcome::OverLimit
        );
        // The unsettled direct row is not the signed tenant's unresolved work.
        assert_eq!(
            journal
                .read_health(DIRECT_POC_TENANT_ID)
                .expect("signed health")
                .unresolved_count,
            1
        );
    }
}
