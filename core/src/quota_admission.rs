//! Fail-closed, server-only admission for one Core embedding attempt.
//!
//! A caller must resolve `CoreTenantRoute` from the signed registry and commit
//! `CoreUsageAttempt` to the retained journal before invoking this client.
//! Nothing in this module performs provider I/O or retries an admission request.

use crate::tenant_route::CoreTenantRoute;
use crate::usage_journal::{CoreUsageAttempt, StartOutcome};
use async_trait::async_trait;
use serde_json::{json, Map, Value};
use std::path::Path;
use std::time::Duration;
use url::Url;

const ADMISSION_PATH: &str = "/internal/usage/dust/admission";
const TIMEOUT: Duration = Duration::from_secs(2);
const MAX_BODY_BYTES: usize = 16 * 1024;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AdmissionError {
    Denied,
    Unavailable,
}

impl std::fmt::Display for AdmissionError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Denied => write!(f, "Dust token quota exceeded"),
            Self::Unavailable => write!(f, "Dust quota admission unavailable"),
        }
    }
}

impl std::error::Error for AdmissionError {}

struct AdmissionRequest {
    url: Url,
    key: String,
    attempt_id: String,
}

#[async_trait]
trait Transport: Send + Sync {
    async fn send(&self, request: AdmissionRequest) -> Result<Value, AdmissionError>;
}

struct HttpTransport {
    client: reqwest::Client,
}

#[async_trait]
impl Transport for HttpTransport {
    async fn send(&self, request: AdmissionRequest) -> Result<Value, AdmissionError> {
        let response = self
            .client
            .post(request.url)
            .header("X-Internal-Auth", request.key)
            .json(&json!({ "operation_id": request.attempt_id }))
            .send()
            .await
            .map_err(|_| AdmissionError::Unavailable)?;
        if response.status() != reqwest::StatusCode::OK
            || response
                .content_length()
                .is_some_and(|n| n > MAX_BODY_BYTES as u64)
        {
            return Err(AdmissionError::Unavailable);
        }
        let mut response = response;
        let mut bytes = Vec::new();
        while let Some(chunk) = response
            .chunk()
            .await
            .map_err(|_| AdmissionError::Unavailable)?
        {
            if bytes.len() + chunk.len() > MAX_BODY_BYTES {
                return Err(AdmissionError::Unavailable);
            }
            bytes.extend_from_slice(&chunk);
        }
        serde_json::from_slice(&bytes).map_err(|_| AdmissionError::Unavailable)
    }
}

/// Uses the route and credential chosen by the signed server-side mapping.
/// Constructing this client does not dispatch any request.
pub struct CoreAdmissionClient {
    transport: HttpTransport,
}

impl CoreAdmissionClient {
    pub fn new() -> Result<Self, AdmissionError> {
        let client = reqwest::Client::builder()
            .timeout(TIMEOUT)
            .redirect(reqwest::redirect::Policy::none())
            .no_proxy()
            .build()
            .map_err(|_| AdmissionError::Unavailable)?;
        Ok(Self {
            transport: HttpTransport { client },
        })
    }

    /// Exactly one CRM decision for a freshly committed journal attempt.
    /// A duplicate journal attempt cannot authorize another provider dispatch.
    pub async fn require_admission(
        &self,
        route: &CoreTenantRoute,
        attempt: &CoreUsageAttempt,
        journal_start: StartOutcome,
    ) -> Result<(), AdmissionError> {
        require_with(&self.transport, route, attempt, journal_start, |path| {
            std::fs::read_to_string(path).map_err(|_| AdmissionError::Unavailable)
        })
        .await
    }
}

async fn require_with<T: Transport>(
    transport: &T,
    route: &CoreTenantRoute,
    attempt: &CoreUsageAttempt,
    journal_start: StartOutcome,
    read_key: impl FnOnce(&Path) -> Result<String, AdmissionError>,
) -> Result<(), AdmissionError> {
    let url = validate_route(route, attempt, journal_start)?;
    let key = read_key(Path::new(&route.core_credential_ref))?;
    // Reject whitespace and header-injection characters, including a pasted
    // trailing newline. The mounted secret must be the exact CRM key.
    if key.is_empty()
        || key.len() > 4096
        || key.chars().any(|c| c.is_whitespace() || c.is_control())
    {
        return Err(AdmissionError::Unavailable);
    }
    let response = transport
        .send(AdmissionRequest {
            url,
            key,
            attempt_id: attempt.attempt_id.clone(),
        })
        .await?;
    parse_decision(response)
}

fn validate_route(
    route: &CoreTenantRoute,
    attempt: &CoreUsageAttempt,
    journal_start: StartOutcome,
) -> Result<Url, AdmissionError> {
    if journal_start != StartOutcome::Created
        || !identity(&route.tenant_id)
        || !identity(&route.workspace_id)
        || !identity(&attempt.attempt_id)
        || attempt.tenant_id != route.tenant_id
        || attempt.workspace_id != route.workspace_id
        || route.revision == 0
        || route.key_id.is_empty()
        || route.journal_target != format!("tenant:{}:dust-usage", route.tenant_id)
        || route.core_credential_ref
            != format!(
                "/var/run/secrets/dust/tenants/{}/dust-core-usage-key",
                route.tenant_id
            )
    {
        return Err(AdmissionError::Unavailable);
    }
    let base = Url::parse(&route.private_route).map_err(|_| AdmissionError::Unavailable)?;
    let url = Url::parse(&route.admission_url).map_err(|_| AdmissionError::Unavailable)?;
    if !private_url(&base)
        || base.path() != "/"
        || base.query().is_some()
        || base.fragment().is_some()
        || !private_url(&url)
        || url.path() != ADMISSION_PATH
        || url.query().is_some()
        || url.fragment().is_some()
        || route.admission_url != format!("{}/{}", route.private_route, &ADMISSION_PATH[1..])
        || base.origin() != url.origin()
    {
        return Err(AdmissionError::Unavailable);
    }
    Ok(url)
}

fn identity(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 128
        && value != "unknown"
        && value
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-')
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

fn exact_keys(map: &Map<String, Value>, expected: &[&str]) -> bool {
    map.len() == expected.len() && expected.iter().all(|key| map.contains_key(*key))
}

fn period(value: &Value) -> bool {
    value
        .as_str()
        .is_some_and(|stamp| chrono::DateTime::parse_from_rfc3339(stamp).is_ok())
}

fn parse_decision(value: Value) -> Result<(), AdmissionError> {
    let map = value.as_object().ok_or(AdmissionError::Unavailable)?;
    if !exact_keys(
        map,
        &[
            "enforcement_enabled",
            "allowed",
            "period_start",
            "period_end",
            "dimensions",
            "denied_dimensions",
            "code",
        ],
    ) || map["enforcement_enabled"] != true
        || !period(&map["period_start"])
        || !period(&map["period_end"])
    {
        return Err(AdmissionError::Unavailable);
    }
    let allowed = map["allowed"]
        .as_bool()
        .ok_or(AdmissionError::Unavailable)?;
    let dimensions = map["dimensions"]
        .as_object()
        .ok_or(AdmissionError::Unavailable)?;
    if !exact_keys(dimensions, &["tokens"]) {
        return Err(AdmissionError::Unavailable);
    }
    let tokens = dimensions["tokens"]
        .as_object()
        .ok_or(AdmissionError::Unavailable)?;
    if !exact_keys(tokens, &["used", "limit", "allowed"]) {
        return Err(AdmissionError::Unavailable);
    }
    let used = tokens["used"].as_i64().ok_or(AdmissionError::Unavailable)?;
    let limit = if tokens["limit"].is_null() {
        None
    } else {
        Some(
            tokens["limit"]
                .as_i64()
                .ok_or(AdmissionError::Unavailable)?,
        )
    };
    let token_allowed = tokens["allowed"]
        .as_bool()
        .ok_or(AdmissionError::Unavailable)?;
    if used < 0
        || limit.is_some_and(|n| n < 0)
        || token_allowed != limit.is_none_or(|n| used < n)
        || token_allowed != allowed
    {
        return Err(AdmissionError::Unavailable);
    }
    let denied = map["denied_dimensions"]
        .as_array()
        .ok_or(AdmissionError::Unavailable)?;
    if allowed && denied.is_empty() && map["code"].is_null() {
        return Ok(());
    }
    if !allowed && denied.len() == 1 && denied[0] == "tokens" && map["code"] == "quota_exceeded" {
        return Err(AdmissionError::Denied);
    }
    Err(AdmissionError::Unavailable)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Mutex;

    struct FakeTransport(Mutex<Vec<(String, String, String)>>, Value);

    #[async_trait]
    impl Transport for FakeTransport {
        async fn send(&self, request: AdmissionRequest) -> Result<Value, AdmissionError> {
            self.0
                .lock()
                .unwrap()
                .push((request.url.to_string(), request.key, request.attempt_id));
            Ok(self.1.clone())
        }
    }

    fn route() -> CoreTenantRoute {
        CoreTenantRoute {
            tenant_id: "alpha".into(),
            workspace_id: "w1".into(),
            private_route: "https://crm.alpha.internal".into(),
            admission_url: "https://crm.alpha.internal/internal/usage/dust/admission".into(),
            usage_ingest_url: "https://crm.alpha.internal/internal/usage/events".into(),
            core_credential_ref: "/var/run/secrets/dust/tenants/alpha/dust-core-usage-key".into(),
            journal_target: "tenant:alpha:dust-usage".into(),
            revision: 1,
            key_id: "pinned".into(),
        }
    }

    fn attempt() -> CoreUsageAttempt {
        CoreUsageAttempt {
            attempt_id: "attempt1".into(),
            provider_request_id: "request1".into(),
            tenant_id: "alpha".into(),
            workspace_id: "w1".into(),
            conversation_id: "conversation1".into(),
            route_id: "route1".into(),
            model: "gemini-embedding-2".into(),
        }
    }

    fn response(allowed: bool) -> Value {
        json!({
            "enforcement_enabled": true,
            "allowed": allowed,
            "period_start": "2026-09-01T00:00:00Z",
            "period_end": "2026-10-01T00:00:00Z",
            "dimensions": {"tokens": {"used": 10, "limit": 11, "allowed": allowed}},
            "denied_dimensions": if allowed { json!([]) } else { json!(["tokens"]) },
            "code": if allowed { Value::Null } else { json!("quota_exceeded") },
        })
    }

    #[tokio::test]
    async fn only_matching_route_and_fresh_journal_attempt_can_dispatch() {
        let transport = FakeTransport(Mutex::new(Vec::new()), response(true));
        let mut wrong = attempt();
        wrong.tenant_id = "beta".into();
        assert_eq!(
            require_with(&transport, &route(), &wrong, StartOutcome::Created, |_| Ok(
                "key".into()
            ))
            .await,
            Err(AdmissionError::Unavailable)
        );
        assert_eq!(
            require_with(
                &transport,
                &route(),
                &attempt(),
                StartOutcome::Duplicate,
                |_| Ok("key".into())
            )
            .await,
            Err(AdmissionError::Unavailable)
        );
        let mut wrong_route = route();
        wrong_route.core_credential_ref =
            "/var/run/secrets/dust/tenants/beta/dust-core-usage-key".into();
        assert_eq!(
            require_with(
                &transport,
                &wrong_route,
                &attempt(),
                StartOutcome::Created,
                |_| Ok("key".into())
            )
            .await,
            Err(AdmissionError::Unavailable)
        );
        assert!(transport.0.lock().unwrap().is_empty());

        require_with(
            &transport,
            &route(),
            &attempt(),
            StartOutcome::Created,
            |path| {
                assert_eq!(
                    path,
                    Path::new("/var/run/secrets/dust/tenants/alpha/dust-core-usage-key")
                );
                Ok("core-alpha-key".into())
            },
        )
        .await
        .unwrap();
        assert_eq!(
            transport.0.lock().unwrap().as_slice(),
            &[(
                "https://crm.alpha.internal/internal/usage/dust/admission".into(),
                "core-alpha-key".into(),
                "attempt1".into()
            )]
        );
    }

    #[tokio::test]
    async fn invalid_key_or_public_route_never_dispatches() {
        let transport = FakeTransport(Mutex::new(Vec::new()), response(true));
        let mut public = route();
        public.private_route = "https://example.com".into();
        public.admission_url = "https://example.com/internal/usage/dust/admission".into();
        assert_eq!(
            require_with(
                &transport,
                &public,
                &attempt(),
                StartOutcome::Created,
                |_| Ok("key".into())
            )
            .await,
            Err(AdmissionError::Unavailable)
        );
        assert_eq!(
            require_with(
                &transport,
                &route(),
                &attempt(),
                StartOutcome::Created,
                |_| Ok("bad\nkey".into())
            )
            .await,
            Err(AdmissionError::Unavailable)
        );
        assert!(transport.0.lock().unwrap().is_empty());
    }

    #[tokio::test]
    async fn tenant_route_selects_only_its_mounted_core_key() {
        let transport = FakeTransport(Mutex::new(Vec::new()), response(true));
        let mut beta_route = route();
        beta_route.tenant_id = "beta".into();
        beta_route.workspace_id = "w2".into();
        beta_route.private_route = "https://crm.beta.internal".into();
        beta_route.admission_url = "https://crm.beta.internal/internal/usage/dust/admission".into();
        beta_route.core_credential_ref =
            "/var/run/secrets/dust/tenants/beta/dust-core-usage-key".into();
        beta_route.journal_target = "tenant:beta:dust-usage".into();
        let mut beta_attempt = attempt();
        beta_attempt.tenant_id = "beta".into();
        beta_attempt.workspace_id = "w2".into();
        beta_attempt.attempt_id = "attempt2".into();
        require_with(
            &transport,
            &beta_route,
            &beta_attempt,
            StartOutcome::Created,
            |path| {
                assert_eq!(
                    path,
                    Path::new("/var/run/secrets/dust/tenants/beta/dust-core-usage-key")
                );
                Ok("core-beta-key".into())
            },
        )
        .await
        .unwrap();
        assert_eq!(
            transport.0.lock().unwrap().as_slice(),
            &[(
                "https://crm.beta.internal/internal/usage/dust/admission".into(),
                "core-beta-key".into(),
                "attempt2".into()
            )]
        );
    }

    #[test]
    fn response_requires_coherent_enabled_token_decision() {
        assert_eq!(parse_decision(response(true)), Ok(()));
        let mut denied = response(false);
        denied["dimensions"]["tokens"]["used"] = json!(11);
        assert_eq!(parse_decision(denied), Err(AdmissionError::Denied));
        let mut disabled = response(true);
        disabled["enforcement_enabled"] = json!(false);
        assert_eq!(parse_decision(disabled), Err(AdmissionError::Unavailable));
        let mut no_period = response(true);
        no_period["period_start"] = Value::Null;
        assert_eq!(parse_decision(no_period), Err(AdmissionError::Unavailable));
        let mut mismatch = response(true);
        mismatch["dimensions"]["tokens"]["allowed"] = json!(false);
        assert_eq!(parse_decision(mismatch), Err(AdmissionError::Unavailable));
        let mut extra = response(true);
        extra["dimensions"]["leads"] = json!({"used": 0, "limit": null, "allowed": true});
        assert_eq!(parse_decision(extra), Err(AdmissionError::Unavailable));
        assert_eq!(
            parse_decision(json!({"error": {"code": "quota_unavailable"}})),
            Err(AdmissionError::Unavailable)
        );
    }
}
