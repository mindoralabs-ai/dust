//! Core-only delivery of frozen embedding usage to its signed tenant route.
//! No path in this module retries or starts a provider request.

use crate::tenant_route::{
    BundleFetcher, CoreTenantRoute, CoreTenantRouteResolver, CoreUsageDeliveryRoute,
};
use crate::usage_journal::{ClaimedWork, CoreUsageJournal};
use async_trait::async_trait;
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::path::Path;
use std::time::Duration;
use url::Url;

const MAX_ENVELOPE_BYTES: usize = 16 * 1024;
const MAX_RECEIPT_BYTES: usize = 2048;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum DeliveryError {
    Unavailable,
}

impl std::fmt::Display for DeliveryError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "Core usage delivery unavailable")
    }
}

impl std::error::Error for DeliveryError {}

struct DeliveryRequest {
    url: Url,
    key: String,
    envelope: String,
}

#[async_trait]
trait Transport: Send + Sync {
    async fn send(&self, request: DeliveryRequest) -> Result<Value, DeliveryError>;
}

struct HttpTransport {
    client: reqwest::Client,
}

#[async_trait]
impl Transport for HttpTransport {
    async fn send(&self, request: DeliveryRequest) -> Result<Value, DeliveryError> {
        let mut response = self
            .client
            .post(request.url)
            .header("Content-Type", "application/json")
            .header("X-Internal-Auth", request.key)
            .body(request.envelope)
            .send()
            .await
            .map_err(|_| DeliveryError::Unavailable)?;
        if response.status() != reqwest::StatusCode::OK
            || response
                .content_length()
                .is_some_and(|n| n > MAX_RECEIPT_BYTES as u64)
        {
            return Err(DeliveryError::Unavailable);
        }
        let mut bytes = Vec::new();
        while let Some(chunk) = response
            .chunk()
            .await
            .map_err(|_| DeliveryError::Unavailable)?
        {
            if bytes.len() + chunk.len() > MAX_RECEIPT_BYTES {
                return Err(DeliveryError::Unavailable);
            }
            bytes.extend_from_slice(&chunk);
        }
        serde_json::from_slice(&bytes).map_err(|_| DeliveryError::Unavailable)
    }
}

pub struct CoreUsageDeliveryClient {
    transport: HttpTransport,
}

impl CoreUsageDeliveryClient {
    pub fn new() -> Result<Self, DeliveryError> {
        let client = reqwest::Client::builder()
            .timeout(Duration::from_secs(5))
            .redirect(reqwest::redirect::Policy::none())
            .no_proxy()
            .build()
            .map_err(|_| DeliveryError::Unavailable)?;
        Ok(Self {
            transport: HttpTransport { client },
        })
    }

    /// One bounded iteration for a Core-owned scheduler. Every claim is
    /// settled or deferred independently; none invokes a paid model effect.
    pub async fn process_due_batch<F: BundleFetcher>(
        &self,
        journal: &CoreUsageJournal,
        resolver: &CoreTenantRouteResolver<F>,
    ) -> Result<usize, DeliveryError> {
        let owner = format!("core_{}", uuid::Uuid::new_v4());
        // Each claim can spend up to 3s refreshing the route and 5s sending.
        // Three sequential claims leave room for SQLite settlement within the 60s lease.
        let claims = journal
            .claim_due(&owner, 3)
            .map_err(|_| DeliveryError::Unavailable)?;
        let mut failed = false;
        for claim in &claims {
            if self.process_claim(journal, resolver, claim).await.is_err() {
                failed = true;
            }
        }
        if failed {
            return Err(DeliveryError::Unavailable);
        }
        Ok(claims.len())
    }

    /// Send independent journal evidence after a successful reconciliation
    /// batch. Provider I/O is not involved in this path.
    pub async fn send_heartbeat(
        &self,
        journal: &CoreUsageJournal,
        route: &CoreTenantRoute,
    ) -> Result<(), DeliveryError> {
        send_heartbeat_with(&self.transport, journal, route, |path| {
            std::fs::read_to_string(path).map_err(|_| DeliveryError::Unavailable)
        })
        .await
    }

    /// @cc [label:security;backend] dust-core-frozen-usage-delivery
    /// A failed receipt or route refresh leaves exact usage durable and due
    /// again. Unknown usage remains blocked until separate provider evidence.
    pub async fn process_claim<F: BundleFetcher>(
        &self,
        journal: &CoreUsageJournal,
        resolver: &CoreTenantRouteResolver<F>,
        claim: &ClaimedWork,
    ) -> Result<(), DeliveryError> {
        if claim.state != "exact" {
            journal
                .defer_claim(claim)
                .map_err(|_| DeliveryError::Unavailable)?;
            return Ok(());
        }
        journal
            .validate_leased_claim(claim)
            .map_err(|_| DeliveryError::Unavailable)?;
        let delivered = match resolver.resolve_delivery(claim).await {
            Ok(route) => send_exact_with(&self.transport, &route, claim, |path| {
                std::fs::read_to_string(path).map_err(|_| DeliveryError::Unavailable)
            })
            .await
            .is_ok(),
            Err(_) => false,
        };
        if delivered {
            journal
                .complete_delivery(claim)
                .map_err(|_| DeliveryError::Unavailable)?;
        } else {
            journal
                .defer_claim(claim)
                .map_err(|_| DeliveryError::Unavailable)?;
        }
        Ok(())
    }
}

/// @cc [label:security;backend] dust-core-independent-heartbeat
/// A successful retained-journal read and tenant-specific Core credential
/// precede a bounded heartbeat to only the fresh signed private route.
async fn send_heartbeat_with<T: Transport>(
    transport: &T,
    journal: &CoreUsageJournal,
    route: &CoreTenantRoute,
    read_key: impl FnOnce(&Path) -> Result<String, DeliveryError>,
) -> Result<(), DeliveryError> {
    if route.core_credential_ref
        != format!(
            "/var/run/secrets/dust/tenants/{}/dust-core-usage-key",
            route.tenant_id
        )
        || route.journal_target != format!("tenant:{}:dust-usage", route.tenant_id)
    {
        return Err(DeliveryError::Unavailable);
    }
    let health = journal
        .read_health(&route.tenant_id)
        .map_err(|_| DeliveryError::Unavailable)?;
    let key = read_key(Path::new(&route.core_credential_ref))?;
    if !(32..=4096).contains(&key.len()) || key.chars().any(|c| c.is_whitespace() || c.is_control())
    {
        return Err(DeliveryError::Unavailable);
    }
    let url = Url::parse(&format!(
        "{}/internal/usage/producers/dust-core/heartbeat",
        route.private_route
    ))
    .map_err(|_| DeliveryError::Unavailable)?;
    if !private_url(&url)
        || url.path() != "/internal/usage/producers/dust-core/heartbeat"
        || url.query().is_some()
        || url.fragment().is_some()
    {
        return Err(DeliveryError::Unavailable);
    }
    let observed_at = chrono::Utc::now().timestamp_millis() as f64 / 1000.0;
    let envelope = serde_json::json!({
        "tenant_id": route.tenant_id,
        "observed_at": observed_at,
        "journal_checked_at": health.checked_at_seconds,
        "reconciler_heartbeat_at": observed_at,
        "oldest_delivery_at": health.oldest_delivery_at_seconds,
        "journal_healthy": true,
        "unresolved_count": health.unresolved_count,
    })
    .to_string();
    let receipt = transport
        .send(DeliveryRequest { url, key, envelope })
        .await?;
    let fields = receipt.as_object().ok_or(DeliveryError::Unavailable)?;
    if fields.len() != 2
        || fields.get("accepted") != Some(&Value::Bool(true))
        || fields
            .get("heartbeat_interval_seconds")
            .and_then(Value::as_u64)
            != Some(15)
    {
        return Err(DeliveryError::Unavailable);
    }
    Ok(())
}

async fn send_exact_with<T: Transport>(
    transport: &T,
    route: &CoreUsageDeliveryRoute,
    claim: &ClaimedWork,
    read_key: impl FnOnce(&Path) -> Result<String, DeliveryError>,
) -> Result<(), DeliveryError> {
    let envelope = claim
        .event_envelope
        .as_ref()
        .ok_or(DeliveryError::Unavailable)?;
    if claim.state != "exact"
        || envelope.is_empty()
        || envelope.len() > MAX_ENVELOPE_BYTES
        || claim.tenant_id != route.tenant_id
        || claim.workspace_id != route.workspace_id
        || route.journal_target != format!("tenant:{}:dust-usage", route.tenant_id)
        || route.core_credential_ref
            != format!(
                "/var/run/secrets/dust/tenants/{}/dust-core-usage-key",
                route.tenant_id
            )
    {
        return Err(DeliveryError::Unavailable);
    }
    let event: Value = serde_json::from_str(envelope).map_err(|_| DeliveryError::Unavailable)?;
    if event.get("tenant_id").and_then(Value::as_str) != Some(claim.tenant_id.as_str())
        || event.get("workspace_id").and_then(Value::as_str) != Some(claim.workspace_id.as_str())
        || event.get("attempt_id").and_then(Value::as_str) != Some(claim.attempt_id.as_str())
        || event.get("component").and_then(Value::as_str) != Some("dust-core")
    {
        return Err(DeliveryError::Unavailable);
    }
    let url = Url::parse(&route.usage_ingest_url).map_err(|_| DeliveryError::Unavailable)?;
    if !private_url(&url)
        || url.path() != "/internal/usage/events"
        || url.query().is_some()
        || url.fragment().is_some()
    {
        return Err(DeliveryError::Unavailable);
    }
    let key = read_key(Path::new(&route.core_credential_ref))?;
    if !(32..=4096).contains(&key.len()) || key.chars().any(|c| c.is_whitespace() || c.is_control())
    {
        return Err(DeliveryError::Unavailable);
    }
    let expected_hash = format!("{:x}", Sha256::digest(envelope.as_bytes()));
    let receipt = transport
        .send(DeliveryRequest {
            url,
            key,
            envelope: envelope.clone(),
        })
        .await?;
    let fields = receipt.as_object().ok_or(DeliveryError::Unavailable)?;
    let stream_id = fields
        .get("stream_id")
        .and_then(Value::as_str)
        .ok_or(DeliveryError::Unavailable)?;
    if fields.len() != 3
        || !fields.contains_key("replayed")
        || !fields.get("replayed").is_some_and(Value::is_boolean)
        || fields.get("envelope_sha256").and_then(Value::as_str) != Some(expected_hash.as_str())
        || !valid_stream_id(stream_id)
    {
        return Err(DeliveryError::Unavailable);
    }
    Ok(())
}

fn valid_stream_id(value: &str) -> bool {
    let Some((millis, sequence)) = value.split_once('-') else {
        return false;
    };
    !millis.is_empty()
        && !sequence.is_empty()
        && millis.bytes().all(|b| b.is_ascii_digit())
        && sequence.bytes().all(|b| b.is_ascii_digit())
}

fn private_url(url: &Url) -> bool {
    if url.scheme() != "https" || !url.username().is_empty() || url.password().is_some() {
        return false;
    }
    let Some(host) = url.host_str() else {
        return false;
    };
    if let Ok(ip) = host.parse::<std::net::Ipv4Addr>() {
        return ip.is_private();
    }
    host.ends_with(".internal") || host.ends_with(".svc.cluster.local")
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::usage_journal::CoreUsageAttempt;
    use serde_json::json;
    use std::sync::Mutex;

    struct MockTransport {
        sent: Mutex<Vec<(String, String, String)>>,
        receipt: Value,
    }

    #[async_trait]
    impl Transport for MockTransport {
        async fn send(&self, request: DeliveryRequest) -> Result<Value, DeliveryError> {
            self.sent.lock().expect("test operation failed").push((
                request.url.to_string(),
                request.key,
                request.envelope,
            ));
            Ok(self.receipt.clone())
        }
    }

    fn claim() -> ClaimedWork {
        ClaimedWork {
            attempt_id: "attempt_1".into(),
            tenant_id: "tenant-a".into(),
            workspace_id: "workspace-a".into(),
            route_id: "tenant-a:23".into(),
            provider_request_id: "request_1".into(),
            provider_operation_id: Some("operation_1".into()),
            state: "exact".into(),
            event_envelope: Some(
                r#"{"agent":"dust","attempt_id":"attempt_1","component":"dust-core","tenant_id":"tenant-a","workspace_id":"workspace-a"}"#.into(),
            ),
            first_unresolved_at_ms: None,
            retry_count: 0,
            manual_review_required: false,
            lease_owner: "worker_1".into(),
            lease_nonce: "nonce_1".into(),
        }
    }

    fn route() -> CoreUsageDeliveryRoute {
        CoreUsageDeliveryRoute {
            tenant_id: "tenant-a".into(),
            workspace_id: "workspace-a".into(),
            usage_ingest_url: "https://crm-a.internal/internal/usage/events".into(),
            core_credential_ref: "/var/run/secrets/dust/tenants/tenant-a/dust-core-usage-key"
                .into(),
            journal_target: "tenant:tenant-a:dust-usage".into(),
            current_revision: 23,
            key_id: "pin_1".into(),
        }
    }

    #[tokio::test]
    async fn frozen_exact_event_uses_only_the_signed_tenant_route_and_valid_receipt() {
        let claim = claim();
        let raw = claim
            .event_envelope
            .as_ref()
            .expect("test operation failed");
        let digest = format!("{:x}", Sha256::digest(raw.as_bytes()));
        let transport = MockTransport {
            sent: Mutex::new(Vec::new()),
            receipt: json!({"stream_id":"123-0","envelope_sha256":digest,"replayed":false}),
        };
        send_exact_with(&transport, &route(), &claim, |_| Ok("a".repeat(40)))
            .await
            .expect("test operation failed");
        let sent = transport.sent.lock().expect("test operation failed");
        assert_eq!(sent.len(), 1);
        assert_eq!(sent[0].0, "https://crm-a.internal/internal/usage/events");
        assert_eq!(sent[0].2, *raw);
    }

    #[tokio::test]
    async fn cross_tenant_route_or_conflicting_receipt_never_completes() {
        let claim = claim();
        let transport = MockTransport {
            sent: Mutex::new(Vec::new()),
            receipt: json!({"stream_id":"123-0","envelope_sha256":"0".repeat(64),"replayed":false}),
        };
        let mut other = route();
        other.tenant_id = "tenant-b".into();
        assert!(
            send_exact_with(&transport, &other, &claim, |_| Ok("b".repeat(40)))
                .await
                .is_err()
        );
        assert!(transport
            .sent
            .lock()
            .expect("test operation failed")
            .is_empty());
        assert!(
            send_exact_with(&transport, &route(), &claim, |_| Ok("a".repeat(40)))
                .await
                .is_err()
        );
        assert_eq!(
            transport.sent.lock().expect("test operation failed").len(),
            1
        );
    }

    #[tokio::test]
    async fn heartbeat_uses_tenant_local_journal_and_core_key() {
        let dir = tempfile::tempdir().expect("test operation failed");
        let journal =
            CoreUsageJournal::open(dir.path().join("usage.sqlite")).expect("test operation failed");
        journal
            .start(&CoreUsageAttempt {
                attempt_id: "attempt_health".into(),
                provider_request_id: "request_health".into(),
                tenant_id: "tenant-a".into(),
                workspace_id: "workspace-a".into(),
                conversation_id: "embedding:workspace-a".into(),
                route_id: "tenant-a:23".into(),
                model: "gemini-embedding-2-1536".into(),
            })
            .expect("test operation failed");
        let route = CoreTenantRoute {
            tenant_id: "tenant-a".into(),
            workspace_id: "workspace-a".into(),
            private_route: "https://crm-a.internal".into(),
            admission_url: "https://crm-a.internal/internal/usage/dust/admission".into(),
            usage_ingest_url: "https://crm-a.internal/internal/usage/events".into(),
            core_credential_ref: "/var/run/secrets/dust/tenants/tenant-a/dust-core-usage-key"
                .into(),
            journal_target: "tenant:tenant-a:dust-usage".into(),
            revision: 23,
            key_id: "pin_1".into(),
        };
        let transport = MockTransport {
            sent: Mutex::new(Vec::new()),
            receipt: json!({"accepted":true,"heartbeat_interval_seconds":15}),
        };
        send_heartbeat_with(&transport, &journal, &route, |_| Ok("a".repeat(40)))
            .await
            .expect("test operation failed");
        let sent = transport.sent.lock().expect("test operation failed");
        assert_eq!(sent.len(), 1);
        assert_eq!(
            sent[0].0,
            "https://crm-a.internal/internal/usage/producers/dust-core/heartbeat"
        );
        let evidence: Value = serde_json::from_str(&sent[0].2).expect("test operation failed");
        assert_eq!(evidence["tenant_id"], "tenant-a");
        assert_eq!(evidence["unresolved_count"], 1);
        drop(sent);
        assert!(send_heartbeat_with(&transport, &journal, &route, |_| {
            Ok(format!(" {}", "a".repeat(40)))
        })
        .await
        .is_err());
        assert_eq!(
            transport.sent.lock().expect("test operation failed").len(),
            1
        );
        let mut cross_tenant = route.clone();
        cross_tenant.tenant_id = "tenant-b".into();
        assert!(
            send_heartbeat_with(&transport, &journal, &cross_tenant, |_| {
                Ok("b".repeat(40))
            })
            .await
            .is_err()
        );
        assert_eq!(
            transport.sent.lock().expect("test operation failed").len(),
            1
        );
    }
}
