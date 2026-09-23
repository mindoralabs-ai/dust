//! Server-only Core resolver for Mindora's signed, short-lived Dust mapping.
//!
//! Each resolution fetches and verifies a fresh signer export. No stale-cache
//! fallback is permitted after a timeout, invalid signature, or expiry. The
//! retained cache only fences global revision rollback and conflicting replay.

use crate::workspace_assertion::VerifiedWorkspace;
use anyhow::{anyhow, bail, Context, Result};
use async_trait::async_trait;
use base64::{engine::general_purpose::STANDARD, Engine};
use ring::signature::{UnparsedPublicKey, ED25519};
use serde::Deserialize;
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::collections::{HashMap, HashSet};
use std::path::PathBuf;
use std::sync::Mutex;
use std::time::Duration;
use url::Url;

const DOMAIN: &[u8] = b"mindora.dust.mapping-bundle.v1\0";
const MAX_BUNDLE_BYTES: usize = 512 * 1024;
const MAX_ENTRIES: usize = 1_000;

#[async_trait]
pub trait BundleFetcher: Send + Sync {
    async fn fetch(&self) -> Result<Vec<u8>>;
}

/// Uses only the review-pinned private signer URL and a server-mounted export
/// credential. The export credential never enters the bundle or any log.
pub struct HttpBundleFetcher {
    client: reqwest::Client,
    url: Url,
    export_key_file: PathBuf,
}

impl HttpBundleFetcher {
    pub fn new(url: &str, export_key_file: PathBuf) -> Result<Self> {
        let parsed = Url::parse(url)?;
        if !private_origin(&parsed)
            || parsed.path() != "/internal/dust/registry/bundle"
            || parsed.query().is_some()
            || parsed.fragment().is_some()
        {
            bail!("invalid private Dust registry export URL");
        }
        Ok(Self {
            client: reqwest::Client::builder()
                .timeout(Duration::from_secs(3))
                .redirect(reqwest::redirect::Policy::none())
                .build()?,
            url: parsed,
            export_key_file,
        })
    }
}

#[async_trait]
impl BundleFetcher for HttpBundleFetcher {
    async fn fetch(&self) -> Result<Vec<u8>> {
        let key = std::fs::read_to_string(&self.export_key_file)
            .context("Dust registry export credential unavailable")?;
        let key = key.trim();
        if key.len() < 32 {
            bail!("Dust registry export credential unavailable");
        }
        let mut response = self
            .client
            .get(self.url.clone())
            .header("X-Internal-Auth", key)
            .send()
            .await
            .context("Dust registry export unavailable")?
            .error_for_status()
            .context("Dust registry export unavailable")?;
        if response
            .content_length()
            .is_some_and(|n| n > MAX_BUNDLE_BYTES as u64)
        {
            bail!("Dust registry bundle too large");
        }
        let mut bytes = Vec::new();
        while let Some(chunk) = response.chunk().await? {
            if bytes.len() + chunk.len() > MAX_BUNDLE_BYTES {
                bail!("Dust registry bundle too large");
            }
            bytes.extend_from_slice(&chunk);
        }
        Ok(bytes)
    }
}

#[derive(Clone, Debug)]
pub struct PinnedVerifier {
    pub key_id: String,
    pub public_key: [u8; 32],
}

impl PinnedVerifier {
    pub fn from_base64(key_id: String, raw_public_key_base64: &str) -> Result<Self> {
        let raw = STANDARD.decode(raw_public_key_base64)?;
        let public_key: [u8; 32] = raw
            .try_into()
            .map_err(|_| anyhow!("invalid Dust registry verifier length"))?;
        let expected = key_id_for_public_key(&public_key);
        if key_id != expected {
            bail!("Dust registry verifier key ID does not match pinned key");
        }
        Ok(Self { key_id, public_key })
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct CoreTenantRoute {
    pub tenant_id: String,
    pub workspace_id: String,
    pub private_route: String,
    pub admission_url: String,
    pub usage_ingest_url: String,
    pub core_credential_ref: String,
    pub journal_target: String,
    pub revision: u64,
    pub key_id: String,
}

/// Restricted route for settling a paid attempt already durably recorded by
/// Core. It intentionally carries no admission endpoint or provider allowance.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct CoreUsageDeliveryRoute {
    pub tenant_id: String,
    pub workspace_id: String,
    pub usage_ingest_url: String,
    pub core_credential_ref: String,
    pub journal_target: String,
    pub current_revision: u64,
    pub key_id: String,
}

#[derive(Clone, Debug)]
struct SeenRevision {
    revision: u64,
    payload_digest: [u8; 32],
    tenant_identity: HashMap<String, (String, String)>,
}

pub struct CoreTenantRouteResolver<F> {
    fetcher: F,
    pinned: HashMap<String, [u8; 32]>,
    required_revision: u64,
    seen: Mutex<Option<SeenRevision>>,
}

impl<F: BundleFetcher> CoreTenantRouteResolver<F> {
    pub fn new(fetcher: F, pins: Vec<PinnedVerifier>, required_revision: u64) -> Result<Self> {
        if !(1..=2).contains(&pins.len()) || required_revision == 0 {
            bail!("invalid Dust registry verifier configuration");
        }
        let mut pinned = HashMap::new();
        for pin in pins {
            let expected = key_id_for_public_key(&pin.public_key);
            if pin.key_id != expected || pinned.insert(pin.key_id, pin.public_key).is_some() {
                bail!("invalid or duplicate Dust registry verifier");
            }
        }
        Ok(Self {
            fetcher,
            pinned,
            required_revision,
            seen: Mutex::new(None),
        })
    }

    /// `workspace` must be the value returned by the signed Front-to-Core
    /// assertion validator, never a request header or caller-selected tenant.
    pub async fn resolve(&self, workspace: &VerifiedWorkspace) -> Result<CoreTenantRoute> {
        let raw = self.fetcher.fetch().await?;
        let now = chrono::Utc::now().timestamp();
        self.resolve_bundle(&raw, workspace.sid(), now)
    }

    /// Fresh signed routes for the server-configured POC workspaces only.
    /// No caller-selected tenant or browser value reaches this interface.
    pub async fn resolve_maintenance(
        &self,
        workspace_ids: &[String],
    ) -> Result<Vec<CoreTenantRoute>> {
        if workspace_ids.is_empty() || workspace_ids.len() > 2 {
            bail!("invalid Dust maintenance workspace selection");
        }
        let raw = self.fetcher.fetch().await?;
        let envelope = self.verify_bundle(&raw, chrono::Utc::now().timestamp())?;
        workspace_ids
            .iter()
            .map(|workspace_id| {
                let entry = envelope
                    .payload
                    .tenants
                    .iter()
                    .find(|tenant| tenant.active && tenant.workspace_id == *workspace_id)
                    .ok_or_else(|| anyhow!("inactive or unmapped Dust workspace"))?;
                Ok(CoreTenantRoute {
                    tenant_id: entry.tenant_id.clone(),
                    workspace_id: entry.workspace_id.clone(),
                    private_route: entry.private_route.clone(),
                    admission_url: entry.admission_url.clone(),
                    usage_ingest_url: entry.usage_ingest_url.clone(),
                    core_credential_ref: entry.core_credential_ref.clone(),
                    journal_target: entry.journal_target.clone(),
                    revision: envelope.payload.revision,
                    key_id: envelope.key_id.clone(),
                })
            })
            .collect()
    }

    /// Resolve only delivery for an existing exact-usage journal claim. A
    /// revoked membership may still owe accounting; this never authorizes a
    /// new admission or model request. The registry's owner transaction keeps
    /// tenant, workspace, and private route immutable across revisions.
    pub async fn resolve_delivery(
        &self,
        claim: &crate::usage_journal::ClaimedWork,
    ) -> Result<CoreUsageDeliveryRoute> {
        if claim.state != "exact" || claim.event_envelope.is_none() {
            bail!("Core usage claim is not ready for delivery");
        }
        let raw = self.fetcher.fetch().await?;
        self.resolve_delivery_bundle(&raw, claim, chrono::Utc::now().timestamp())
    }

    fn resolve_delivery_bundle(
        &self,
        raw: &[u8],
        claim: &crate::usage_journal::ClaimedWork,
        now: i64,
    ) -> Result<CoreUsageDeliveryRoute> {
        if !tenant_slug(&claim.tenant_id) || !identity(&claim.workspace_id) {
            bail!("invalid persisted Core usage identity");
        }
        let (route_tenant, route_revision) = claim
            .route_id
            .split_once(':')
            .ok_or_else(|| anyhow!("invalid persisted Core usage route identity"))?;
        let parsed_revision = route_revision
            .parse::<u64>()
            .context("invalid persisted Core usage route revision")?;
        if route_tenant != claim.tenant_id
            || parsed_revision == 0
            || route_revision != parsed_revision.to_string()
            || parsed_revision < self.required_revision
        {
            bail!("Core usage route identity mismatch");
        }
        let envelope = self.verify_bundle(raw, now)?;
        if envelope.payload.revision < parsed_revision {
            bail!("Core usage route revision is newer than registry");
        }
        let entry = envelope
            .payload
            .tenants
            .iter()
            .find(|tenant| tenant.tenant_id == claim.tenant_id)
            .ok_or_else(|| anyhow!("Core usage tenant mapping no longer exists"))?;
        if entry.workspace_id != claim.workspace_id || entry.revision > parsed_revision {
            bail!("Core usage workspace mapping changed after attempt");
        }
        // `validate_payload` has already pinned the private origin, exact
        // tenant-scoped usage URL, component-specific key path, and journal.
        // The signer source rejects mutations to an existing tenant identity.
        Ok(CoreUsageDeliveryRoute {
            tenant_id: entry.tenant_id.clone(),
            workspace_id: entry.workspace_id.clone(),
            usage_ingest_url: entry.usage_ingest_url.clone(),
            core_credential_ref: entry.core_credential_ref.clone(),
            journal_target: entry.journal_target.clone(),
            current_revision: envelope.payload.revision,
            key_id: envelope.key_id,
        })
    }

    fn resolve_bundle(&self, raw: &[u8], workspace_id: &str, now: i64) -> Result<CoreTenantRoute> {
        let envelope = self.verify_bundle(raw, now)?;
        let payload = &envelope.payload;
        let entry = payload
            .tenants
            .iter()
            .find(|tenant| tenant.workspace_id == workspace_id && tenant.active)
            .ok_or_else(|| anyhow!("inactive or unmapped Dust workspace"))?;
        Ok(CoreTenantRoute {
            tenant_id: entry.tenant_id.clone(),
            workspace_id: entry.workspace_id.clone(),
            private_route: entry.private_route.clone(),
            admission_url: entry.admission_url.clone(),
            usage_ingest_url: entry.usage_ingest_url.clone(),
            core_credential_ref: entry.core_credential_ref.clone(),
            journal_target: entry.journal_target.clone(),
            revision: payload.revision,
            key_id: envelope.key_id,
        })
    }

    fn verify_bundle(&self, raw: &[u8], now: i64) -> Result<SignedBundle> {
        if raw.is_empty() || raw.len() > MAX_BUNDLE_BYTES {
            bail!("invalid Dust registry bundle size");
        }
        let envelope: SignedBundle = serde_json::from_slice(raw)?;
        let key = self
            .pinned
            .get(&envelope.key_id)
            .ok_or_else(|| anyhow!("unknown Dust registry signing key"))?;
        let payload_value = serde_json::to_value(&envelope.payload)?;
        let mut signed = serde_json::Map::new();
        signed.insert("key_id".into(), Value::String(envelope.key_id.clone()));
        signed.insert("payload".into(), payload_value.clone());
        let mut message = DOMAIN.to_vec();
        message.extend(canonical_ascii(&Value::Object(signed))?.as_bytes());
        let signature = STANDARD.decode(&envelope.signature)?;
        if signature.len() != 64 {
            bail!("invalid Dust registry signature length");
        }
        UnparsedPublicKey::new(&ED25519, key)
            .verify(&message, &signature)
            .map_err(|_| anyhow!("invalid Dust registry signature"))?;

        let payload = &envelope.payload;
        if payload.schema_version != 2
            || payload.revision < self.required_revision
            || payload.issued_at > now
            || payload.expires_at <= now
            || payload.issued_at.checked_add(60) != Some(payload.expires_at)
            || payload.tenants.is_empty()
            || payload.memberships.is_empty()
            || payload.tenants.len() > MAX_ENTRIES
            || payload.memberships.len() > MAX_ENTRIES
        {
            bail!("stale or invalid Dust registry payload");
        }
        validate_payload(payload)?;
        // The signer refreshes issued/expiry timestamps every export without
        // incrementing the registry revision. Fence conflicting bindings at
        // one revision, while allowing a fresh signature over a new lease.
        let mut stable_payload = payload_value.clone();
        let stable_fields = stable_payload
            .as_object_mut()
            .ok_or_else(|| anyhow!("invalid Dust registry payload"))?;
        stable_fields.remove("issued_at");
        stable_fields.remove("expires_at");
        stable_fields["tenants"]
            .as_array_mut()
            .ok_or_else(|| anyhow!("invalid Dust registry tenants"))?
            .sort_by(|a, b| {
                a["tenant_id"]
                    .as_str()
                    .unwrap_or_default()
                    .cmp(b["tenant_id"].as_str().unwrap_or_default())
            });
        stable_fields["memberships"]
            .as_array_mut()
            .ok_or_else(|| anyhow!("invalid Dust registry memberships"))?
            .sort_by(|a, b| {
                a["tenant_id"]
                    .as_str()
                    .unwrap_or_default()
                    .cmp(b["tenant_id"].as_str().unwrap_or_default())
                    .then_with(|| {
                        a["employee_id"]
                            .as_str()
                            .unwrap_or_default()
                            .cmp(b["employee_id"].as_str().unwrap_or_default())
                    })
            });
        let digest: [u8; 32] = Sha256::digest(canonical_ascii(&stable_payload)?.as_bytes()).into();
        let tenant_identity: HashMap<String, (String, String)> = payload
            .tenants
            .iter()
            .map(|tenant| {
                (
                    tenant.tenant_id.clone(),
                    (tenant.workspace_id.clone(), tenant.private_route.clone()),
                )
            })
            .collect();
        {
            let mut seen = self
                .seen
                .lock()
                .map_err(|_| anyhow!("Dust registry cache unavailable"))?;
            if let Some(prior) = seen.as_ref() {
                if payload.revision < prior.revision
                    || (payload.revision == prior.revision && digest != prior.payload_digest)
                {
                    bail!("Dust registry revision rollback or conflict");
                }
                for (tenant_id, prior_identity) in &prior.tenant_identity {
                    if let Some(current_identity) = tenant_identity.get(tenant_id) {
                        if prior_identity != current_identity {
                            bail!("Dust registry tenant identity changed");
                        }
                    }
                }
            }
            let mut retained_identities = seen
                .as_ref()
                .map(|prior| prior.tenant_identity.clone())
                .unwrap_or_default();
            retained_identities.extend(tenant_identity);
            *seen = Some(SeenRevision {
                revision: payload.revision,
                payload_digest: digest,
                tenant_identity: retained_identities,
            });
        }
        Ok(envelope)
    }
}

#[derive(Clone, Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct SignedBundle {
    key_id: String,
    payload: Payload,
    signature: String,
}

#[derive(Clone, Debug, Deserialize, serde::Serialize)]
#[serde(deny_unknown_fields)]
struct Payload {
    schema_version: u32,
    revision: u64,
    issued_at: i64,
    expires_at: i64,
    tenants: Vec<TenantEntry>,
    memberships: Vec<MemberEntry>,
}

#[derive(Clone, Debug, Deserialize, serde::Serialize)]
#[serde(deny_unknown_fields)]
struct TenantEntry {
    tenant_id: String,
    workspace_id: String,
    workos_organization_id: String,
    private_route: String,
    journal_target: String,
    revision: u64,
    front_credential_ref: String,
    core_credential_ref: String,
    active: bool,
    admission_url: String,
    usage_ingest_url: String,
}

#[derive(Clone, Debug, Deserialize, serde::Serialize)]
#[serde(deny_unknown_fields)]
struct MemberEntry {
    tenant_id: String,
    employee_id: String,
    authority_namespace: String,
    dust_user_id: String,
    workos_user_id: String,
    active: bool,
    revision: u64,
}

fn validate_payload(payload: &Payload) -> Result<()> {
    let mut tenants = HashSet::new();
    let mut workspaces = HashSet::new();
    let mut organizations = HashSet::new();
    let mut routes = HashSet::new();
    let mut journals = HashSet::new();
    let mut credentials = HashSet::new();
    for t in &payload.tenants {
        if !tenant_slug(&t.tenant_id)
            || !identity(&t.workspace_id)
            || !reference(&t.workos_organization_id)
            || t.revision > payload.revision
            || !tenants.insert(t.tenant_id.as_str())
            || !workspaces.insert(t.workspace_id.as_str())
            || !organizations.insert(t.workos_organization_id.as_str())
            || !routes.insert(t.private_route.as_str())
            || !journals.insert(t.journal_target.as_str())
        {
            bail!("duplicate or invalid Dust tenant binding");
        }
        let origin = Url::parse(&t.private_route)?;
        if !private_origin(&origin)
            || origin.path() != "/"
            || origin.query().is_some()
            || origin.fragment().is_some()
        {
            bail!("invalid Dust tenant private route");
        }
        let base = t.private_route.trim_end_matches('/');
        if t.private_route != base
            || t.admission_url != format!("{base}/internal/usage/dust/admission")
            || t.usage_ingest_url != format!("{base}/internal/usage/events")
            || t.journal_target != format!("tenant:{}:dust-usage", t.tenant_id)
        {
            bail!("invalid Dust tenant route or journal target");
        }
        let root = format!("/var/run/secrets/dust/tenants/{}", t.tenant_id);
        if t.front_credential_ref != format!("{root}/dust-front-usage-key")
            || t.core_credential_ref != format!("{root}/dust-core-usage-key")
            || !credentials.insert(t.front_credential_ref.as_str())
            || !credentials.insert(t.core_credential_ref.as_str())
        {
            bail!("invalid Dust component credential references");
        }
    }
    let mut member_pairs = HashSet::new();
    let mut dust_users = HashSet::new();
    let mut workos_users = HashSet::new();
    let mut active_count: HashMap<&str, usize> = HashMap::new();
    for m in &payload.memberships {
        if !tenants.contains(m.tenant_id.as_str())
            || !identity(&m.employee_id)
            || m.authority_namespace != "control-ui"
            || !reference(&m.dust_user_id)
            || !reference(&m.workos_user_id)
            || m.revision > payload.revision
            || !member_pairs.insert((m.tenant_id.as_str(), m.employee_id.as_str()))
            || !dust_users.insert(m.dust_user_id.as_str())
            || !workos_users.insert(m.workos_user_id.as_str())
        {
            bail!("partial or duplicate Dust membership");
        }
        if m.active {
            *active_count.entry(m.tenant_id.as_str()).or_default() += 1;
        }
    }
    for t in &payload.tenants {
        let count = active_count.get(t.tenant_id.as_str()).copied().unwrap_or(0);
        if t.active != (count > 0)
            || !payload
                .memberships
                .iter()
                .any(|m| m.tenant_id == t.tenant_id)
        {
            bail!("inactive or partial Dust workspace binding");
        }
    }
    Ok(())
}

fn private_origin(url: &Url) -> bool {
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

fn tenant_slug(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 63
        && value
            .bytes()
            .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-')
        && (value.as_bytes()[0].is_ascii_lowercase() || value.as_bytes()[0].is_ascii_digit())
        && value.as_bytes()[value.len() - 1] != b'-'
}

fn identity(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 128
        && value != "unknown"
        && value
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-')
}

fn reference(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 256
        && value
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'_' | b'-' | b'.' | b':' | b'/'))
}

fn key_id_for_public_key(public_key: &[u8; 32]) -> String {
    let fingerprint = Sha256::digest(public_key);
    let mut id = String::from("ed25519-");
    for byte in &fingerprint[..8] {
        use std::fmt::Write;
        write!(&mut id, "{byte:02x}").expect("formatting into a String cannot fail");
    }
    id
}

/// Python's `json.dumps(sort_keys=True,separators=(',', ':'),ensure_ascii=True)`
/// wire contract. Only parsed JSON values are accepted, never floating numbers.
fn canonical_ascii(value: &Value) -> Result<String> {
    fn write(v: &Value, out: &mut String) -> Result<()> {
        match v {
            Value::Null => out.push_str("null"),
            Value::Bool(b) => out.push_str(if *b { "true" } else { "false" }),
            Value::Number(n) => {
                if !n.is_i64() && !n.is_u64() {
                    bail!("non-integer Dust registry number");
                }
                out.push_str(&n.to_string());
            }
            Value::String(s) => {
                let json = serde_json::to_string(s)?;
                for c in json.chars() {
                    if c.is_ascii() {
                        out.push(c);
                    } else {
                        for unit in c.encode_utf16(&mut [0; 2]).iter() {
                            out.push_str(&format!("\\u{unit:04x}"));
                        }
                    }
                }
            }
            Value::Array(items) => {
                out.push('[');
                for (index, item) in items.iter().enumerate() {
                    if index > 0 {
                        out.push(',');
                    }
                    write(item, out)?;
                }
                out.push(']');
            }
            Value::Object(map) => {
                out.push('{');
                let mut keys: Vec<_> = map.keys().collect();
                keys.sort();
                for (index, key) in keys.into_iter().enumerate() {
                    if index > 0 {
                        out.push(',');
                    }
                    write(&Value::String(key.clone()), out)?;
                    out.push(':');
                    write(&map[key], out)?;
                }
                out.push('}');
            }
        }
        Ok(())
    }
    let mut out = String::new();
    write(value, &mut out)?;
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;
    use ring::rand::SystemRandom;
    use ring::signature::{Ed25519KeyPair, KeyPair};
    use std::sync::atomic::{AtomicBool, Ordering};
    use std::sync::Arc;

    struct MockFetcher {
        raw: Arc<Mutex<Vec<u8>>>,
        fail: Arc<AtomicBool>,
    }

    #[async_trait]
    impl BundleFetcher for MockFetcher {
        async fn fetch(&self) -> Result<Vec<u8>> {
            if self.fail.load(Ordering::SeqCst) {
                bail!("simulated signer timeout");
            }
            Ok(self.raw.lock().expect("test operation failed").clone())
        }
    }

    fn keypair() -> Ed25519KeyPair {
        let bytes =
            Ed25519KeyPair::generate_pkcs8(&SystemRandom::new()).expect("test operation failed");
        Ed25519KeyPair::from_pkcs8(bytes.as_ref()).expect("test operation failed")
    }

    fn payload(now: i64, revision: u64) -> Value {
        serde_json::json!({
            "schema_version": 2,
            "revision": revision,
            "issued_at": now,
            "expires_at": now + 60,
            "tenants": [{
                "tenant_id": "alpha",
                "workspace_id": "workspace_A",
                "workos_organization_id": "org_1",
                "private_route": "https://10.1.1.2",
                "journal_target": "tenant:alpha:dust-usage",
                "revision": revision,
                "front_credential_ref": "/var/run/secrets/dust/tenants/alpha/dust-front-usage-key",
                "core_credential_ref": "/var/run/secrets/dust/tenants/alpha/dust-core-usage-key",
                "active": true,
                "admission_url": "https://10.1.1.2/internal/usage/dust/admission",
                "usage_ingest_url": "https://10.1.1.2/internal/usage/events"
            }],
            "memberships": [{
                "tenant_id": "alpha", "employee_id": "employee_1",
                "authority_namespace": "control-ui", "dust_user_id": "dust_user_1",
                "workos_user_id": "workos_user_1", "active": true, "revision": revision
            }]
        })
    }

    fn signed(payload: Value, key: &Ed25519KeyPair) -> Vec<u8> {
        let key_id = key_id_for_public_key(
            key.public_key()
                .as_ref()
                .try_into()
                .expect("test operation failed"),
        );
        let mut message = serde_json::Map::new();
        message.insert("key_id".into(), Value::String(key_id.clone()));
        message.insert("payload".into(), payload.clone());
        let mut bytes = DOMAIN.to_vec();
        bytes.extend(
            canonical_ascii(&Value::Object(message))
                .expect("test operation failed")
                .as_bytes(),
        );
        let signature = STANDARD.encode(key.sign(&bytes).as_ref());
        serde_json::to_vec(&serde_json::json!({
            "key_id": key_id, "payload": payload, "signature": signature
        }))
        .expect("test operation failed")
    }

    fn resolver(
        raw: Vec<u8>,
        key: &Ed25519KeyPair,
        required_revision: u64,
    ) -> (
        CoreTenantRouteResolver<MockFetcher>,
        Arc<Mutex<Vec<u8>>>,
        Arc<AtomicBool>,
    ) {
        let public_key: [u8; 32] = key
            .public_key()
            .as_ref()
            .try_into()
            .expect("test operation failed");
        let shared = Arc::new(Mutex::new(raw));
        let fail = Arc::new(AtomicBool::new(false));
        let resolver = CoreTenantRouteResolver::new(
            MockFetcher {
                raw: shared.clone(),
                fail: fail.clone(),
            },
            vec![PinnedVerifier {
                key_id: key_id_for_public_key(&public_key),
                public_key,
            }],
            required_revision,
        )
        .expect("test operation failed");
        (resolver, shared, fail)
    }

    fn settled_claim() -> crate::usage_journal::ClaimedWork {
        crate::usage_journal::ClaimedWork {
            attempt_id: "attempt_1".into(),
            tenant_id: "alpha".into(),
            workspace_id: "workspace_A".into(),
            route_id: "alpha:7".into(),
            provider_request_id: "provider_1".into(),
            provider_operation_id: Some("receipt_1".into()),
            state: "exact".into(),
            event_envelope: Some("{\"frozen\":\"event\"}".into()),
            first_unresolved_at_ms: None,
            retry_count: 0,
            manual_review_required: false,
            lease_owner: "worker_1".into(),
            lease_nonce: "nonce_1".into(),
        }
    }

    #[test]
    fn verifies_signature_domain_revision_and_exact_workspace() {
        let key = keypair();
        let now = chrono::Utc::now().timestamp();
        let (resolver, _, _) = resolver(signed(payload(now, 7), &key), &key, 7);
        let route = resolver
            .resolve_bundle(&signed(payload(now, 7), &key), "workspace_A", now)
            .expect("test operation failed");
        assert_eq!(route.tenant_id, "alpha");
        assert_eq!(route.revision, 7);
        assert!(route.core_credential_ref.ends_with("/dust-core-usage-key"));
        // Signer leases renew each request while the registry revision stays 7.
        assert!(resolver
            .resolve_bundle(&signed(payload(now + 1, 7), &key), "workspace_A", now + 1)
            .is_ok());
        let mut conflicting_same_revision = payload(now + 1, 7);
        conflicting_same_revision["tenants"][0]["workspace_id"] =
            Value::String("workspace_B".into());
        assert!(resolver
            .resolve_bundle(
                &signed(conflicting_same_revision, &key),
                "workspace_B",
                now + 1
            )
            .is_err());
        assert!(resolver
            .resolve_bundle(&signed(payload(now, 7), &key), "workspace_B", now)
            .is_err());
        let mut tampered: Value =
            serde_json::from_slice(&signed(payload(now, 8), &key)).expect("test operation failed");
        tampered["payload"]["tenants"][0]["tenant_id"] = Value::String("beta".into());
        assert!(resolver
            .resolve_bundle(
                &serde_json::to_vec(&tampered).expect("test operation failed"),
                "workspace_A",
                now
            )
            .is_err());
        let mut stale = payload(now, 6);
        assert!(resolver
            .resolve_bundle(&signed(stale.clone(), &key), "workspace_A", now)
            .is_err());
        stale["revision"] = Value::from(7);
        stale["expires_at"] = Value::from(now);
        assert!(resolver
            .resolve_bundle(&signed(stale, &key), "workspace_A", now)
            .is_err());
        let other_key = keypair();
        assert!(resolver
            .resolve_bundle(&signed(payload(now, 8), &other_key), "workspace_A", now)
            .is_err());
    }

    #[test]
    fn rejects_partial_duplicate_or_cross_tenant_component_routes() {
        let key = keypair();
        let now = chrono::Utc::now().timestamp();
        let (resolver, _, _) = resolver(signed(payload(now, 1), &key), &key, 1);
        let mut bad = payload(now, 1);
        bad["tenants"][0]["core_credential_ref"] =
            bad["tenants"][0]["front_credential_ref"].clone();
        assert!(resolver
            .resolve_bundle(&signed(bad, &key), "workspace_A", now)
            .is_err());
        let mut duplicate = payload(now, 1);
        let tenant = duplicate["tenants"][0].clone();
        duplicate["tenants"]
            .as_array_mut()
            .expect("test operation failed")
            .push(tenant);
        assert!(resolver
            .resolve_bundle(&signed(duplicate, &key), "workspace_A", now)
            .is_err());
        let mut inactive = payload(now, 1);
        inactive["tenants"][0]["active"] = Value::Bool(false);
        inactive["memberships"][0]["active"] = Value::Bool(false);
        assert!(resolver
            .resolve_bundle(&signed(inactive, &key), "workspace_A", now)
            .is_err());
        let mut public = payload(now, 1);
        public["tenants"][0]["private_route"] = Value::String("https://example.com".into());
        public["tenants"][0]["admission_url"] =
            Value::String("https://example.com/internal/usage/dust/admission".into());
        public["tenants"][0]["usage_ingest_url"] =
            Value::String("https://example.com/internal/usage/events".into());
        assert!(resolver
            .resolve_bundle(&signed(public, &key), "workspace_A", now)
            .is_err());
        let mut short_lease = payload(now, 2);
        short_lease["expires_at"] = Value::from(now + 1);
        assert!(resolver
            .resolve_bundle(&signed(short_lease, &key), "workspace_A", now)
            .is_err());
    }

    #[test]
    fn removed_tenant_identity_cannot_be_reintroduced_with_a_new_route() {
        let key = keypair();
        let now = chrono::Utc::now().timestamp();
        let mut initial = payload(now, 7);
        let mut beta = initial["tenants"][0].clone();
        beta["tenant_id"] = Value::String("beta".into());
        beta["workspace_id"] = Value::String("workspace_B".into());
        beta["workos_organization_id"] = Value::String("org_2".into());
        beta["private_route"] = Value::String("https://10.1.1.3".into());
        beta["journal_target"] = Value::String("tenant:beta:dust-usage".into());
        beta["front_credential_ref"] =
            Value::String("/var/run/secrets/dust/tenants/beta/dust-front-usage-key".into());
        beta["core_credential_ref"] =
            Value::String("/var/run/secrets/dust/tenants/beta/dust-core-usage-key".into());
        beta["admission_url"] =
            Value::String("https://10.1.1.3/internal/usage/dust/admission".into());
        beta["usage_ingest_url"] = Value::String("https://10.1.1.3/internal/usage/events".into());
        let mut beta_member = initial["memberships"][0].clone();
        beta_member["tenant_id"] = Value::String("beta".into());
        beta_member["employee_id"] = Value::String("employee_2".into());
        beta_member["dust_user_id"] = Value::String("dust_user_2".into());
        beta_member["workos_user_id"] = Value::String("workos_user_2".into());
        initial["tenants"]
            .as_array_mut()
            .expect("test array")
            .push(beta.clone());
        initial["memberships"]
            .as_array_mut()
            .expect("test array")
            .push(beta_member.clone());
        let (resolver, _, _) = resolver(signed(initial.clone(), &key), &key, 7);
        assert!(resolver
            .resolve_bundle(&signed(initial, &key), "workspace_A", now)
            .is_ok());
        let mut reordered = payload(now, 7);
        reordered["tenants"] = serde_json::json!([beta.clone(), reordered["tenants"][0].clone()]);
        reordered["memberships"] =
            serde_json::json!([beta_member.clone(), reordered["memberships"][0].clone()]);
        assert!(resolver
            .resolve_bundle(&signed(reordered, &key), "workspace_A", now)
            .is_ok());

        let mut without_alpha = payload(now + 1, 8);
        without_alpha["tenants"] = serde_json::json!([beta.clone()]);
        without_alpha["memberships"] = serde_json::json!([beta_member.clone()]);
        assert!(resolver
            .resolve_bundle(&signed(without_alpha, &key), "workspace_B", now + 1)
            .is_ok());

        let mut reintroduced = payload(now + 2, 9);
        reintroduced["tenants"][0]["workspace_id"] = Value::String("workspace_C".into());
        reintroduced["tenants"]
            .as_array_mut()
            .expect("test array")
            .push(beta);
        reintroduced["memberships"]
            .as_array_mut()
            .expect("test array")
            .push(beta_member);
        assert!(resolver
            .resolve_bundle(&signed(reintroduced, &key), "workspace_C", now + 2)
            .is_err());
    }

    #[tokio::test]
    async fn injected_fetch_failure_blocks_even_with_recent_verified_bundle() {
        let key = keypair();
        let now = chrono::Utc::now().timestamp();
        let (resolver, shared, fail) = resolver(signed(payload(now, 7), &key), &key, 7);
        // This exercises the public path after a real signed Front assertion.
        let secret = "isolated-dust-core-route-test-secret-long-enough";
        std::env::set_var("DUST_CORE_WORKSPACE_ASSERTION_SECRET", secret);
        let pair = crate::workspace_assertion::DataSourcePair {
            project_id: 1,
            data_source_id: "data-source-1".into(),
        };
        let claims = serde_json::json!({
            "aud": "dust-core-vertex-embedding", "iat": now,
            "exp": now + 60, "workspace_sid": "workspace_A",
            "data_sources": [pair.clone()]
        });
        let token = jsonwebtoken::encode(
            &jsonwebtoken::Header::new(jsonwebtoken::Algorithm::HS256),
            &claims,
            &jsonwebtoken::EncodingKey::from_secret(secret.as_bytes()),
        )
        .expect("test operation failed");
        let workspace = crate::workspace_assertion::verify(Some(&token), &[pair])
            .expect("test operation failed");
        assert_eq!(
            resolver
                .resolve(&workspace)
                .await
                .expect("test operation failed")
                .tenant_id,
            "alpha"
        );
        fail.store(true, Ordering::SeqCst);
        assert!(resolver.resolve(&workspace).await.is_err());
        fail.store(false, Ordering::SeqCst);
        *shared.lock().expect("test operation failed") = signed(payload(now, 6), &key);
        assert!(resolver.resolve(&workspace).await.is_err());
    }

    #[tokio::test]
    async fn maintenance_routes_require_fresh_signed_workspace_bindings() {
        let key = keypair();
        let now = chrono::Utc::now().timestamp();
        let (resolver, _shared, fail) = resolver(signed(payload(now, 7), &key), &key, 7);
        let routes = resolver
            .resolve_maintenance(&["workspace_A".to_string()])
            .await
            .expect("test operation failed");
        assert_eq!(routes.len(), 1);
        assert_eq!(routes[0].tenant_id, "alpha");
        assert!(resolver
            .resolve_maintenance(&["workspace_B".to_string()])
            .await
            .is_err());
        fail.store(true, Ordering::SeqCst);
        assert!(resolver
            .resolve_maintenance(&["workspace_A".to_string()])
            .await
            .is_err());
    }

    #[test]
    fn canonical_ascii_matches_python_string_escaping() {
        let input = serde_json::json!({"z": "😀 café", "a": [1, true]});
        assert_eq!(
            canonical_ascii(&input).expect("test operation failed"),
            "{\"a\":[1,true],\"z\":\"\\ud83d\\ude00 caf\\u00e9\"}"
        );
    }

    #[test]
    fn signer_endpoint_and_verifier_must_be_pinned_independently() {
        assert!(HttpBundleFetcher::new(
            "https://registry.internal/internal/dust/registry/bundle",
            PathBuf::from("/unused/test-key")
        )
        .is_ok());
        assert!(HttpBundleFetcher::new(
            "https://example.com/internal/dust/registry/bundle",
            PathBuf::from("/unused/test-key")
        )
        .is_err());
        assert!(HttpBundleFetcher::new(
            "https://registry.internal/internal/dust/registry/bindings",
            PathBuf::from("/unused/test-key")
        )
        .is_err());
        let key = keypair();
        let pubkey = key.public_key().as_ref();
        assert!(
            PinnedVerifier::from_base64("ed25519-untrusted".into(), &STANDARD.encode(pubkey))
                .is_err()
        );
        assert!(PinnedVerifier::from_base64(
            key_id_for_public_key(pubkey.try_into().expect("test operation failed")),
            &STANDARD.encode(pubkey)
        )
        .is_ok());
    }

    #[tokio::test]
    async fn historical_exact_usage_can_deliver_after_revocation_but_cannot_admit() {
        let key = keypair();
        let now = chrono::Utc::now().timestamp();
        let (resolver, shared, _) = resolver(signed(payload(now, 7), &key), &key, 7);
        let claim = settled_claim();
        assert_eq!(
            resolver
                .resolve_delivery_bundle(&signed(payload(now, 7), &key), &claim, now)
                .expect("test operation failed")
                .tenant_id,
            "alpha"
        );
        let mut revoked = payload(now, 8);
        revoked["tenants"][0]["revision"] = Value::from(7);
        revoked["tenants"][0]["active"] = Value::Bool(false);
        revoked["memberships"][0]["active"] = Value::Bool(false);
        *shared.lock().expect("test operation failed") = signed(revoked.clone(), &key);
        let delivery = resolver
            .resolve_delivery(&claim)
            .await
            .expect("test operation failed");
        assert_eq!(delivery.current_revision, 8);
        assert_eq!(
            delivery.usage_ingest_url,
            "https://10.1.1.2/internal/usage/events"
        );
        assert!(resolver
            .resolve_bundle(&signed(revoked.clone(), &key), "workspace_A", now)
            .is_err());

        let mut cross_tenant = claim.clone();
        cross_tenant.tenant_id = "beta".into();
        assert!(resolver.resolve_delivery(&cross_tenant).await.is_err());
        let mut wrong_workspace = claim.clone();
        wrong_workspace.workspace_id = "workspace_B".into();
        assert!(resolver.resolve_delivery(&wrong_workspace).await.is_err());
        let mut bad_route = claim.clone();
        bad_route.route_id = "alpha:9".into();
        assert!(resolver.resolve_delivery(&bad_route).await.is_err());
        let mut not_exact = claim.clone();
        not_exact.state = "unknown".into();
        assert!(resolver.resolve_delivery(&not_exact).await.is_err());
    }

    #[test]
    fn newer_signed_revision_cannot_change_a_previously_seen_private_route() {
        let key = keypair();
        let now = chrono::Utc::now().timestamp();
        let (resolver, _, _) = resolver(signed(payload(now, 7), &key), &key, 7);
        let claim = settled_claim();
        resolver
            .resolve_delivery_bundle(&signed(payload(now, 7), &key), &claim, now)
            .expect("test operation failed");
        let mut redirected = payload(now, 8);
        redirected["tenants"][0]["private_route"] = Value::String("https://10.1.1.3".into());
        redirected["tenants"][0]["admission_url"] =
            Value::String("https://10.1.1.3/internal/usage/dust/admission".into());
        redirected["tenants"][0]["usage_ingest_url"] =
            Value::String("https://10.1.1.3/internal/usage/events".into());
        assert!(resolver
            .resolve_delivery_bundle(&signed(redirected, &key), &claim, now)
            .is_err());
    }
}
