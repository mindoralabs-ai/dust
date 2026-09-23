//! Core-owned, retained SQLite journal for embedding provider attempts.
//!
//! Callers must treat only `StartOutcome::Created` as permission to dispatch
//! provider I/O. This module deliberately does not dispatch or retry effects.
//! Its SQLite path must be on the retained Core PVC, not the container layer.

use anyhow::{anyhow, bail, Context, Result};
use chrono::{SecondsFormat, TimeZone, Utc};
use rusqlite::{params, Connection, OptionalExtension, TransactionBehavior};
use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use std::time::Duration;
use uuid::Uuid;

const MIGRATION: &str = include_str!("stores/migrations/20260923_dust_usage_journal.sql");
const START_TIMEOUT_MS: i64 = 5 * 60 * 1000;
const CLAIM_LEASE_MS: i64 = 60 * 1000;
const RETRY_DELAY_MS: i64 = 60 * 1000;
const REVIEW_DEADLINE_MS: i64 = 24 * 60 * 60 * 1000;

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

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum StartOutcome {
    Created,
    Duplicate,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct EmbeddingUsage {
    /// A complete provider-reported `usageMetadata.promptTokenCount`.
    pub input_tokens: u32,
}

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
    pub checked_at: f64,
    pub oldest_delivery_at: f64,
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

    /// @cc [label:security;backend] dust-core-journal-health-evidence
    /// Health evidence comes from a successful tenant-local retained SQLite
    /// read; unknown attempts and stale exact outbox rows remain visible.
    pub fn read_health(&self, tenant_id: &str) -> Result<CoreJournalHealth> {
        validate_identity(tenant_id)?;
        let conn = self.connection()?;
        let (unresolved, oldest): (i64, Option<i64>) = conn.query_row(
            "SELECT count(CASE WHEN state IN ('started', 'unknown', 'manual_review_required') THEN 1 END),
                    min(CASE WHEN state = 'exact' AND delivered_at_ms IS NULL THEN created_at_ms END)
             FROM dust_usage_attempts WHERE tenant_id = ?1",
            params![tenant_id],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )?;
        Ok(CoreJournalHealth {
            checked_at: now_ms() as f64 / 1000.0,
            oldest_delivery_at: oldest.map(|v| v as f64 / 1000.0).unwrap_or(0.0),
            unresolved_count: u64::try_from(unresolved)?,
        })
    }

    pub fn start(&self, attempt: &CoreUsageAttempt) -> Result<StartOutcome> {
        validate_attempt(attempt)?;
        let mut conn = self.connection()?;
        let tx = conn.transaction_with_behavior(TransactionBehavior::Immediate)?;
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
        tx.commit()?;
        Ok(if inserted == 1 {
            StartOutcome::Created
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
             WHERE attempt_id = ?1 AND state = 'started'",
            params![attempt_id, now + START_TIMEOUT_MS, now],
        )?;
        if changed != 1 {
            bail!("Core usage attempt is not active");
        }
        Ok(())
    }

    /// A dispatched request with absent or invalid provider usage is unknown,
    /// never a synthetic zero-token charge or a no-charge conclusion.
    pub fn mark_unknown(&self, attempt_id: &str) -> Result<()> {
        validate_identity(attempt_id)?;
        let mut conn = self.connection()?;
        let tx = conn.transaction_with_behavior(TransactionBehavior::Immediate)?;
        let state: String = tx
            .query_row(
                "SELECT state FROM dust_usage_attempts WHERE attempt_id = ?1",
                [attempt_id],
                |r| r.get(0),
            )
            .optional()?
            .ok_or_else(|| anyhow!("Core usage attempt was not durably started"))?;
        match state.as_str() {
            "started" => {
                let now = now_ms();
                tx.execute(
                    "UPDATE dust_usage_attempts SET state = 'unknown',
                     first_unresolved_at_ms = COALESCE(first_unresolved_at_ms, ?2),
                     next_retry_at_ms = ?2, updated_at_ms = ?2 WHERE attempt_id = ?1",
                    params![attempt_id, now],
                )?;
            }
            "unknown" | "manual_review_required" => {}
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
                    && existing.3.as_deref() == Some(envelope.as_str()) => {}
            "started" | "unknown" | "manual_review_required" => {
                tx.execute(
                    "UPDATE dust_usage_attempts SET state = 'exact', provider_operation_id = ?2,
                     event_envelope = ?3, next_retry_at_ms = ?4, updated_at_ms = ?4
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
        tx.commit()?;
        Ok(envelope)
    }

    /// Atomically leases due reconciliation and outbox work. The nonce protects
    /// against a stale worker completing a newer claim by the same owner.
    pub fn claim_due(&self, lease_owner: &str, limit: usize) -> Result<Vec<ClaimedWork>> {
        validate_identity(lease_owner)?;
        if !(1..=100).contains(&limit) {
            bail!("invalid Core usage claim limit");
        }
        let mut conn = self.connection()?;
        let tx = conn.transaction_with_behavior(TransactionBehavior::Immediate)?;
        let now = now_ms();
        let mut stmt = tx.prepare(
            "SELECT attempt_id FROM dust_usage_attempts
             WHERE delivered_at_ms IS NULL AND next_retry_at_ms <= ?1
               AND (lease_until_ms IS NULL OR lease_until_ms < ?1)
               AND state IN ('started', 'unknown', 'exact', 'manual_review_required')
             ORDER BY created_at_ms, attempt_id LIMIT ?2",
        )?;
        let ids = stmt
            .query_map(params![now, limit as i64], |r| r.get::<_, String>(0))?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        drop(stmt);
        let mut claims = Vec::with_capacity(ids.len());
        for id in ids {
            let nonce = Uuid::new_v4().to_string();
            tx.execute(
                "UPDATE dust_usage_attempts SET lease_owner = ?2, lease_nonce = ?3,
                 lease_until_ms = ?4, updated_at_ms = ?5 WHERE attempt_id = ?1",
                params![id, lease_owner, nonce, now + CLAIM_LEASE_MS, now],
            )?;
            claims.push(tx.query_row(
                "SELECT attempt_id, tenant_id, workspace_id, route_id, provider_request_id,
                        provider_operation_id, state, event_envelope,
                        first_unresolved_at_ms, retry_count, manual_review_required,
                        lease_owner, lease_nonce
                 FROM dust_usage_attempts WHERE attempt_id = ?1",
                [id],
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
            )?);
        }
        tx.commit()?;
        Ok(claims)
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
    for id in [
        &a.attempt_id,
        &a.provider_request_id,
        &a.tenant_id,
        &a.workspace_id,
    ] {
        validate_identity(id)?;
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
    if usage.input_tokens > 2_147_483_647 {
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
        let dir = tempdir().unwrap();
        let path = dir.path().join("core-usage.sqlite");
        let j = CoreUsageJournal::open(&path).unwrap();
        let a = attempt("a1");
        assert_eq!(j.start(&a).unwrap(), StartOutcome::Created);
        drop(j);
        let j = CoreUsageJournal::open(&path).unwrap();
        assert_eq!(j.start(&a).unwrap(), StartOutcome::Duplicate);
        let mut conflict = a.clone();
        conflict.tenant_id = "tenant_B".into();
        assert!(j.start(&conflict).is_err());
        let mut second = attempt("a2");
        second.provider_request_id = a.provider_request_id;
        assert!(j.start(&second).is_err());
    }

    #[test]
    fn exact_envelope_is_frozen_and_claim_is_fenced() {
        let dir = tempdir().unwrap();
        let j = CoreUsageJournal::open(dir.path().join("core-usage.sqlite")).unwrap();
        let a = attempt("a1");
        j.start(&a).unwrap();
        let first = j
            .settle_exact(
                &a,
                "provider_receipt_1",
                EmbeddingUsage { input_tokens: 23 },
            )
            .unwrap();
        let replay = j
            .settle_exact(
                &a,
                "provider_receipt_1",
                EmbeddingUsage { input_tokens: 23 },
            )
            .unwrap();
        assert_eq!(first, replay);
        assert!(first.contains("\"tenant_id\":\"tenant_A\""));
        let event: serde_json::Value = serde_json::from_str(&first).unwrap();
        let keys: Vec<&str> = event
            .as_object()
            .unwrap()
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
        let claim = j.claim_due("worker_1", 10).unwrap().remove(0);
        assert_eq!(claim.workspace_id, "workspace_A");
        assert_eq!(claim.event_envelope.as_deref(), Some(first.as_str()));
        assert!(j.claim_due("worker_2", 10).unwrap().is_empty());
        let mut stale = claim.clone();
        stale.lease_nonce = "wrong".into();
        assert!(j.complete_delivery(&stale).is_err());
        j.complete_delivery(&claim).unwrap();
        assert!(j.claim_due("worker_2", 10).unwrap().is_empty());
    }

    #[test]
    fn health_reports_unresolved_and_undelivered_work_per_tenant() {
        let dir = tempdir().unwrap();
        let j = CoreUsageJournal::open(dir.path().join("core-usage.sqlite")).unwrap();
        let a = attempt("a1");
        let b = attempt("a2");
        j.start(&a).unwrap();
        j.start(&b).unwrap();
        j.settle_exact(&b, "receipt_2", EmbeddingUsage { input_tokens: 2 })
            .unwrap();
        let health = j.read_health("tenant_A").unwrap();
        assert_eq!(health.unresolved_count, 1);
        assert!(health.oldest_delivery_at > 0.0);
        assert!(health.checked_at >= health.oldest_delivery_at);
        assert_eq!(j.read_health("tenant_B").unwrap().unresolved_count, 0);
        j.settle_no_charge("a1", "predispatch:test:a1").unwrap();
        assert_eq!(j.read_health("tenant_A").unwrap().unresolved_count, 0);
        let claim = j.claim_due("worker_health", 10).unwrap().remove(0);
        j.complete_delivery(&claim).unwrap();
        assert_eq!(j.read_health("tenant_A").unwrap().oldest_delivery_at, 0.0);
    }

    #[test]
    fn ambiguous_effect_stays_unresolved_through_retries_and_deadline() {
        let dir = tempdir().unwrap();
        let j = CoreUsageJournal::open(dir.path().join("core-usage.sqlite")).unwrap();
        j.start(&attempt("a1")).unwrap();
        j.mark_unknown("a1").unwrap();
        j.mark_unknown("a1").unwrap();
        let first = j.claim_due("worker_1", 10).unwrap().remove(0);
        assert_eq!(first.state, "unknown");
        j.defer_claim(&first).unwrap();
        let conn = j.connection().unwrap();
        conn.execute(
            "UPDATE dust_usage_attempts SET next_retry_at_ms = ?2,
             first_unresolved_at_ms = ?3 WHERE attempt_id = ?1",
            params!["a1", now_ms() - 1, now_ms() - REVIEW_DEADLINE_MS - 1],
        )
        .unwrap();
        let overdue = j.claim_due("worker_2", 10).unwrap().remove(0);
        j.defer_claim(&overdue).unwrap();
        let state: String = conn
            .query_row(
                "SELECT state FROM dust_usage_attempts WHERE attempt_id = 'a1'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(state, "manual_review_required");
        j.settle_no_charge("a1", "provider/verified-no-charge")
            .unwrap();
        assert!(j.claim_due("worker_3", 10).unwrap().is_empty());
    }

    #[test]
    fn expired_lease_is_reclaimed_after_reopen_and_stale_worker_is_rejected() {
        let dir = tempdir().unwrap();
        let path = dir.path().join("core-usage.sqlite");
        let j = CoreUsageJournal::open(&path).unwrap();
        let a = attempt("a1");
        j.start(&a).unwrap();
        j.settle_exact(&a, "receipt_1", EmbeddingUsage { input_tokens: 4 })
            .unwrap();
        let stale = j.claim_due("worker_1", 1).unwrap().remove(0);
        drop(j);

        let j = CoreUsageJournal::open(&path).unwrap();
        assert!(j.claim_due("worker_2", 1).unwrap().is_empty());
        j.connection()
            .unwrap()
            .execute(
                "UPDATE dust_usage_attempts SET lease_until_ms = ?2 WHERE attempt_id = ?1",
                params![a.attempt_id, now_ms() - 1],
            )
            .unwrap();
        let replacement = j.claim_due("worker_2", 1).unwrap().remove(0);
        assert_eq!(replacement.event_envelope, stale.event_envelope);
        assert!(j.complete_delivery(&stale).is_err());
        j.complete_delivery(&replacement).unwrap();
    }

    #[test]
    fn durable_start_failure_is_not_a_dispatch_allowance() {
        let dir = tempdir().unwrap();
        assert!(CoreUsageJournal::open(dir.path()).is_err());
        assert!(CoreUsageJournal::open(":memory:").is_err());
    }
}
