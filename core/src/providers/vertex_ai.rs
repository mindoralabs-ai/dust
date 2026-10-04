use crate::providers::chat_messages::ChatMessage;
use crate::providers::embedder::{Embedder, EmbedderVector, EmbeddingTaskType};
use crate::providers::llm::{
    ChatFunction, LLMChatGeneration, LLMGeneration, TokenizerSingleton, LLM,
};
use crate::providers::provider::{ModelError, ModelErrorRetryOptions, Provider, ProviderID};
use crate::providers::tiktoken::tiktoken::{
    batch_tokenize_async, cl100k_base_singleton, decode_async, encode_async,
};
use crate::quota_admission::{AdmissionError, CoreAdmissionClient};
use crate::run::Credentials;
use crate::tenant_route::{
    CoreTenantRoute, CoreTenantRouteResolver, HttpBundleFetcher, PinnedVerifier,
};
use crate::usage_delivery::CoreUsageDeliveryClient;
use crate::usage_journal::{
    CoreUsageAttempt, CoreUsageJournal, DirectStartOutcome, EmbeddingUsage,
    PaidEmbeddingRecoveryRequired, StartOutcome, DIRECT_DAILY_TOKEN_LIMIT_MAX, DIRECT_POC_ROUTE_ID,
    DIRECT_POC_TENANT_ID,
};
use crate::workspace_assertion::VerifiedWorkspace;
use anyhow::{anyhow, Result};
use async_trait::async_trait;
use futures::{stream, stream::FuturesUnordered, StreamExt};
use serde_json::{json, Value};
use std::collections::HashMap;
use std::future::Future;
use std::path::PathBuf;
use std::sync::Arc;
use std::sync::{Mutex, OnceLock};
use std::time::Duration;
use tokio::sync::mpsc::UnboundedSender;

const MODEL_ID: &str = "gemini-embedding-2-1536";
const API_MODEL_ID: &str = "gemini-embedding-2";
const DIMENSIONS: usize = 1536;
const CLOUD_SCOPE: &str = "https://www.googleapis.com/auth/cloud-platform";
const MAX_CONCURRENT_REQUESTS: usize = 8;
const CONTEXT_SIZE: usize = 8_192;
const DIRECT_PROVIDER_MODE_ENV: &str = "DUST_POC_DIRECT_PROVIDER_MODE";
/// Each unsettled direct attempt holds this many tokens of the daily limit
/// until its exact usage replaces it. It is `context_size`, the model input
/// limit: requests send `autoTruncate: false`, so Vertex rejects longer input
/// instead of truncating and billing it. The embedder's cl100k counts are not
/// an upper bound on Gemini's `promptTokenCount` (a different tokenizer, plus
/// the task prefix), so they cannot size this reservation.
const DIRECT_EMBEDDING_RESERVATION_TOKENS: u64 = CONTEXT_SIZE as u64;
const MS_PER_DAY: i64 = 24 * 60 * 60 * 1000;

#[async_trait]
trait VertexTokenSource: Send + Sync {
    async fn token(&self) -> Result<String>;
}

struct AdcTokenSource;

#[derive(Debug)]
struct PreDispatchTokenError;

#[derive(Debug)]
pub struct AmbiguousVertexEffect;

impl std::fmt::Display for AmbiguousVertexEffect {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "Vertex provider effect requires accounting review")
    }
}

impl std::error::Error for AmbiguousVertexEffect {}

/// Vertex answered the request with a complete HTTP 4xx response: it refused
/// the request, which it does not bill.
#[derive(Debug)]
struct VertexRejectedRequest {
    status: u16,
    request_id: Option<String>,
}

impl VertexRejectedRequest {
    /// `settle_no_charge` evidence: the status, and Vertex's sanitized
    /// request ID when the response carried one.
    fn evidence_ref(&self) -> String {
        match &self.request_id {
            Some(request_id) => format!("vertex:rejected:{}:{request_id}", self.status),
            None => format!("vertex:rejected:{}", self.status),
        }
    }
}

impl std::fmt::Display for VertexRejectedRequest {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(
            f,
            "Vertex rejected the embedding request with HTTP status {}",
            self.status
        )
    }
}

impl std::error::Error for VertexRejectedRequest {}

impl std::fmt::Display for PreDispatchTokenError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "Vertex ADC unavailable before dispatch")
    }
}

impl std::error::Error for PreDispatchTokenError {}

#[async_trait]
impl VertexTokenSource for AdcTokenSource {
    async fn token(&self) -> Result<String> {
        let provider = gcp_auth::provider()
            .await
            .map_err(|_| anyhow!("Vertex ADC initialization failed"))?;
        let token = provider
            .token(&[CLOUD_SCOPE])
            .await
            .map_err(|_| anyhow!("Vertex ADC token retrieval failed"))?;
        Ok(token.as_str().to_string())
    }
}

#[derive(Default)]
pub struct VertexAIProvider;

impl VertexAIProvider {
    pub fn new() -> Self {
        Self
    }
}

#[async_trait]
impl Provider for VertexAIProvider {
    fn id(&self) -> ProviderID {
        ProviderID::VertexAI
    }

    fn setup(&self) -> Result<()> {
        Ok(())
    }

    async fn test(&self) -> Result<()> {
        Err(anyhow!(
            "Vertex embedding requires tenant admission and a durable usage journal"
        ))
    }

    fn llm(
        &self,
        id: String,
        _tokenizer: Option<TokenizerSingleton>,
    ) -> Box<dyn LLM + Sync + Send> {
        Box::new(UnsupportedVertexLLM { id })
    }

    fn embedder(&self, id: String) -> Box<dyn Embedder + Sync + Send> {
        Box::new(VertexAIEmbedder::new(id))
    }
}

struct UnsupportedVertexLLM {
    id: String,
}

#[async_trait]
impl LLM for UnsupportedVertexLLM {
    fn id(&self) -> String {
        self.id.clone()
    }
    async fn initialize(&mut self, _credentials: Credentials) -> Result<()> {
        Err(anyhow!("vertex_ai is an embedding-only provider"))
    }
    fn context_size(&self) -> usize {
        0
    }
    async fn encode(&self, _text: &str) -> Result<Vec<usize>> {
        Err(anyhow!("vertex_ai is an embedding-only provider"))
    }
    async fn decode(&self, _tokens: Vec<usize>) -> Result<String> {
        Err(anyhow!("vertex_ai is an embedding-only provider"))
    }
    async fn tokenize(&self, _texts: Vec<String>) -> Result<Vec<Vec<(usize, String)>>> {
        Err(anyhow!("vertex_ai is an embedding-only provider"))
    }
    async fn generate(
        &self,
        _prompt: &str,
        _max_tokens: Option<i32>,
        _temperature: f32,
        _n: usize,
        _stop: &Vec<String>,
        _frequency_penalty: Option<f32>,
        _presence_penalty: Option<f32>,
        _top_p: Option<f32>,
        _top_logprobs: Option<i32>,
        _extras: Option<Value>,
        _event_sender: Option<UnboundedSender<Value>>,
    ) -> Result<LLMGeneration> {
        Err(anyhow!("vertex_ai is an embedding-only provider"))
    }
    async fn chat(
        &self,
        _messages: &Vec<ChatMessage>,
        _functions: &Vec<ChatFunction>,
        _function_call: Option<String>,
        _temperature: f32,
        _top_p: Option<f32>,
        _n: usize,
        _stop: &Vec<String>,
        _max_tokens: Option<i32>,
        _presence_penalty: Option<f32>,
        _frequency_penalty: Option<f32>,
        _logprobs: Option<bool>,
        _top_logprobs: Option<i32>,
        _extras: Option<Value>,
        _event_sender: Option<UnboundedSender<Value>>,
    ) -> Result<LLMChatGeneration> {
        Err(anyhow!("vertex_ai is an embedding-only provider"))
    }
}

pub struct VertexAIEmbedder {
    id: String,
    project: Option<String>,
    client: reqwest::Client,
    token_source: Arc<dyn VertexTokenSource>,
    #[cfg(test)]
    test_endpoint: Option<String>,
}

#[derive(Debug)]
#[allow(dead_code)] // Carried to the future admission/journal wrapper; public embed stays closed.
struct VertexEmbeddingResponse {
    vector: Vec<f64>,
    usage_metadata: Value,
}

/// Inputs of one guarded batch after the shared request checks.
struct GuardedBatch {
    endpoint: String,
    inputs: Vec<String>,
    positions: Vec<usize>,
    upsert_key: Option<String>,
}

struct CoreVertexRuntime {
    resolver: CoreTenantRouteResolver<HttpBundleFetcher>,
    journal: CoreUsageJournal,
    admission: CoreAdmissionClient,
    workspaces: Vec<String>,
}

static CORE_VERTEX_RUNTIME: OnceLock<CoreVertexRuntime> = OnceLock::new();
static CORE_VERTEX_RUNTIME_INIT: Mutex<()> = Mutex::new(());

impl CoreVertexRuntime {
    fn from_environment() -> Result<Self> {
        let required = |name: &str| -> Result<String> {
            std::env::var(name)
                .ok()
                .filter(|value| !value.is_empty())
                .ok_or_else(|| anyhow!("Core Vertex runtime configuration unavailable"))
        };
        let signer_url = required("DUST_CORE_REGISTRY_SIGNER_URL")?;
        let export_key = PathBuf::from(required("DUST_CORE_REGISTRY_EXPORT_KEY_FILE")?);
        let key_id = required("DUST_CORE_REGISTRY_KEY_ID")?;
        let public_key = required("DUST_CORE_REGISTRY_PUBLIC_KEY_BASE64")?;
        let minimum_revision = required("DUST_CORE_REGISTRY_MIN_REVISION")?
            .parse::<u64>()
            .map_err(|_| anyhow!("Core Vertex runtime configuration unavailable"))?;
        let journal_path = PathBuf::from(required("DUST_CORE_USAGE_JOURNAL_PATH")?);
        let workspaces = required("DUST_POC_WORKSPACE_IDS")?
            .split(',')
            .map(str::to_owned)
            .collect::<Vec<_>>();
        if workspaces.len() != 2
            || workspaces[0] == workspaces[1]
            || workspaces.iter().any(|id| {
                id.is_empty()
                    || id.len() > 128
                    || !id
                        .bytes()
                        .all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_')
            })
        {
            return Err(anyhow!("Core Vertex runtime configuration unavailable"));
        }
        if !export_key.is_absolute() || !journal_path.is_absolute() {
            return Err(anyhow!("Core Vertex runtime configuration unavailable"));
        }
        let fetcher = HttpBundleFetcher::new(&signer_url, export_key)?;
        let pin = PinnedVerifier::from_base64(key_id, &public_key)?;
        let mut pins = vec![pin];
        let next_key_id = std::env::var("DUST_CORE_REGISTRY_NEXT_KEY_ID").ok();
        let next_public_key = std::env::var("DUST_CORE_REGISTRY_NEXT_PUBLIC_KEY_BASE64").ok();
        match (next_key_id, next_public_key) {
            (Some(key_id), Some(public_key)) => {
                pins.push(PinnedVerifier::from_base64(key_id, &public_key)?);
            }
            (None, None) => {}
            _ => return Err(anyhow!("Core Vertex runtime configuration unavailable")),
        }
        let journal = CoreUsageJournal::open(journal_path)?;
        Ok(Self {
            resolver: CoreTenantRouteResolver::new_retained(
                fetcher,
                pins,
                minimum_revision,
                journal.clone(),
            )?,
            journal,
            admission: CoreAdmissionClient::new()?,
            workspaces,
        })
    }
}

fn core_vertex_runtime() -> Result<&'static CoreVertexRuntime> {
    if let Some(runtime) = CORE_VERTEX_RUNTIME.get() {
        return Ok(runtime);
    }
    let _guard = CORE_VERTEX_RUNTIME_INIT
        .lock()
        .map_err(|_| anyhow!("Core Vertex runtime initialization unavailable"))?;
    if CORE_VERTEX_RUNTIME.get().is_none() {
        let runtime = CoreVertexRuntime::from_environment()
            .map_err(|_| anyhow!("Core Vertex runtime configuration unavailable"))?;
        let _ = CORE_VERTEX_RUNTIME.set(runtime);
    }
    CORE_VERTEX_RUNTIME
        .get()
        .ok_or_else(|| anyhow!("Core Vertex runtime initialization unavailable"))
}

/// `DUST_POC_DIRECT_PROVIDER_MODE`: unset or `0` is off and `1` is on. Any
/// other value is a configuration error, never a fallback to either mode.
fn direct_provider_mode(value: Result<String, std::env::VarError>) -> Result<bool> {
    match value.as_deref() {
        Err(std::env::VarError::NotPresent) | Ok("0") => Ok(false),
        Ok("1") => Ok(true),
        _ => Err(anyhow!(
            "Core Vertex direct provider mode configuration unavailable"
        )),
    }
}

struct CoreDirectVertexRuntime {
    journal: CoreUsageJournal,
    workspace_id: String,
    daily_token_limit: u64,
}

static CORE_DIRECT_VERTEX_RUNTIME: OnceLock<CoreDirectVertexRuntime> = OnceLock::new();
static CORE_DIRECT_VERTEX_RUNTIME_INIT: Mutex<()> = Mutex::new(());

impl CoreDirectVertexRuntime {
    /// @cc [owner:jchen0824,label:security;backend] dust-core-direct-config-fails-closed
    /// Direct mode reads only `DUST_POC_DIRECT_WORKSPACE_ID` (1-128 of
    /// `[A-Za-z0-9_-]`), `DUST_CORE_DIRECT_EMBEDDING_DAILY_TOKEN_LIMIT` (decimal
    /// digits from the per-attempt reservation to `DIRECT_DAILY_TOKEN_LIMIT_MAX`)
    /// and an absolute `DUST_CORE_USAGE_JOURNAL_PATH`. A missing or malformed value
    /// is an error before the journal is opened; signed registry variables and
    /// `DUST_POC_WORKSPACE_IDS` are neither required nor read.
    fn from_lookup(lookup: impl Fn(&str) -> Option<String>) -> Result<Self> {
        let unavailable = || anyhow!("Core Vertex direct runtime configuration unavailable");
        let required = |name: &str| {
            lookup(name)
                .filter(|value| !value.is_empty())
                .ok_or_else(unavailable)
        };
        let workspace_id = required("DUST_POC_DIRECT_WORKSPACE_ID")?;
        let daily_token_limit = required("DUST_CORE_DIRECT_EMBEDDING_DAILY_TOKEN_LIMIT")?;
        let journal_path = PathBuf::from(required("DUST_CORE_USAGE_JOURNAL_PATH")?);
        if workspace_id.len() > 128
            || !workspace_id
                .bytes()
                .all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_')
            || !daily_token_limit.bytes().all(|b| b.is_ascii_digit())
            || !journal_path.is_absolute()
        {
            return Err(unavailable());
        }
        let daily_token_limit = daily_token_limit
            .parse::<u64>()
            .map_err(|_| unavailable())?;
        if !(DIRECT_EMBEDDING_RESERVATION_TOKENS..=DIRECT_DAILY_TOKEN_LIMIT_MAX)
            .contains(&daily_token_limit)
        {
            return Err(unavailable());
        }
        Ok(Self {
            journal: CoreUsageJournal::open(journal_path)?,
            workspace_id,
            daily_token_limit,
        })
    }
}

fn core_direct_vertex_runtime() -> Result<&'static CoreDirectVertexRuntime> {
    if let Some(runtime) = CORE_DIRECT_VERTEX_RUNTIME.get() {
        return Ok(runtime);
    }
    let _guard = CORE_DIRECT_VERTEX_RUNTIME_INIT
        .lock()
        .map_err(|_| anyhow!("Core Vertex direct runtime initialization unavailable"))?;
    if CORE_DIRECT_VERTEX_RUNTIME.get().is_none() {
        let runtime = CoreDirectVertexRuntime::from_lookup(|name| std::env::var(name).ok())
            .map_err(|_| anyhow!("Core Vertex direct runtime configuration unavailable"))?;
        let _ = CORE_DIRECT_VERTEX_RUNTIME.set(runtime);
    }
    CORE_DIRECT_VERTEX_RUNTIME
        .get()
        .ok_or_else(|| anyhow!("Core Vertex direct runtime initialization unavailable"))
}

/// Direct mode never admits or delivers remotely, so the route has no network
/// destination. Fixed fields keep the journal's route binding stable.
fn direct_poc_route(workspace_id: &str) -> CoreTenantRoute {
    CoreTenantRoute {
        tenant_id: DIRECT_POC_TENANT_ID.to_owned(),
        workspace_id: workspace_id.to_owned(),
        private_route: "direct:none".to_owned(),
        admission_url: "direct:none".to_owned(),
        usage_ingest_url: "direct:none".to_owned(),
        core_credential_ref: "direct:none".to_owned(),
        journal_target: format!("tenant:{DIRECT_POC_TENANT_ID}:dust-usage"),
        revision: 0,
        key_id: "direct".to_owned(),
    }
}

fn utc_day_start_ms(now_ms: i64) -> i64 {
    now_ms - now_ms.rem_euclid(MS_PER_DAY)
}

/// @cc [label:security;backend] dust-core-reconciler-no-model-effect
/// This loop may deliver durable accounting while provider I/O is disabled.
/// A failed delivery never retries an embedding request. In direct provider
/// mode without `DUST_CORE_REGISTRY_SIGNER_URL` it returns without starting the
/// delivery or heartbeat loops. When `DUST_POC_DIRECT_PROVIDER_MODE` is set to
/// a value other than `0` or `1`, it logs one error without that value and
/// returns without starting either loop, with or without a signer.
pub async fn run_core_usage_reconciler() {
    run_core_usage_reconciler_with(|name| std::env::var(name)).await
}

async fn run_core_usage_reconciler_with(env: impl Fn(&str) -> Result<String, std::env::VarError>) {
    if env("DUST_POC_MODE").as_deref() != Ok("1") {
        return;
    }
    let Ok(direct) = direct_provider_mode(env(DIRECT_PROVIDER_MODE_ENV)) else {
        tracing::error!(
            "Dust Core usage reconciliation is off: direct provider mode configuration unavailable"
        );
        return;
    };
    // Direct rows are never delivered; without a signer there is no signed
    // route to reconcile or heartbeat against.
    if direct && !env("DUST_CORE_REGISTRY_SIGNER_URL").is_ok_and(|url| !url.is_empty()) {
        tracing::info!("Dust Core usage reconciliation is off in direct provider mode");
        return;
    }
    tokio::join!(run_core_delivery_loop(), run_core_heartbeat_loop());
}

async fn run_core_delivery_loop() {
    loop {
        if let Ok(runtime) = core_vertex_runtime() {
            if let Ok(client) = CoreUsageDeliveryClient::new() {
                if client
                    .process_due_batch(&runtime.journal, &runtime.resolver)
                    .await
                    .is_err()
                {
                    tracing::warn!("Dust Core usage reconciliation unavailable");
                }
            } else {
                tracing::warn!("Dust Core usage reconciliation unavailable");
            }
        } else {
            tracing::warn!("Dust Core usage reconciliation unavailable");
        }
        tokio::time::sleep(Duration::from_secs(5)).await;
    }
}

async fn run_core_heartbeat_loop() {
    let mut ticker = tokio::time::interval(Duration::from_secs(10));
    loop {
        ticker.tick().await;
        let result = async {
            let runtime = core_vertex_runtime()?;
            let client = CoreUsageDeliveryClient::new()?;
            let routes = runtime
                .resolver
                .resolve_maintenance_each(&runtime.workspaces)
                .await?;
            let outcomes = futures::future::join_all(routes.into_iter().map(|route| async {
                let route = route?;
                client.send_heartbeat(&runtime.journal, &route).await?;
                Ok::<(), anyhow::Error>(())
            }))
            .await;
            if outcomes.iter().any(Result::is_err) {
                return Err(anyhow!("Dust Core usage heartbeat unavailable"));
            }
            Ok::<(), anyhow::Error>(())
        }
        .await;
        if result.is_err() {
            tracing::warn!("Dust Core usage heartbeat unavailable");
        }
    }
}

fn same_signed_route(a: &CoreTenantRoute, b: &CoreTenantRoute) -> bool {
    a.tenant_id == b.tenant_id
        && a.workspace_id == b.workspace_id
        && a.private_route == b.private_route
        && a.admission_url == b.admission_url
        && a.usage_ingest_url == b.usage_ingest_url
        && a.core_credential_ref == b.core_credential_ref
        && a.journal_target == b.journal_target
}

fn embedding_input_hash(
    route: &CoreTenantRoute,
    model: &str,
    task_type: EmbeddingTaskType,
    upsert_key: &str,
    text: &str,
) -> [u8; 32] {
    let mut hasher = blake3::Hasher::new();
    for part in [
        route.tenant_id.as_str(),
        route.workspace_id.as_str(),
        model,
        upsert_key,
        &task_type.prepare(text),
    ] {
        hasher.update(&(part.len() as u64).to_le_bytes());
        hasher.update(part.as_bytes());
    }
    *hasher.finalize().as_bytes()
}

fn coalesce_document_inputs(inputs: Vec<String>) -> (Vec<String>, Vec<usize>) {
    let mut unique = Vec::new();
    let mut indexes = HashMap::new();
    let mut positions = Vec::with_capacity(inputs.len());
    for input in inputs {
        let index = if let Some(index) = indexes.get(&input) {
            *index
        } else {
            let index = unique.len();
            indexes.insert(input.clone(), index);
            unique.push(input);
            index
        };
        positions.push(index);
    }
    (unique, positions)
}

fn finish_embedding_batch(
    results: Vec<Result<Vec<f64>>>,
    model: &str,
) -> Result<Vec<EmbedderVector>> {
    if results.iter().any(|result| {
        result
            .as_ref()
            .err()
            .is_some_and(|error| error.downcast_ref::<AmbiguousVertexEffect>().is_some())
    }) {
        return Err(AmbiguousVertexEffect.into());
    }
    results
        .into_iter()
        .map(|result| {
            result.map(|vector| EmbedderVector {
                created: crate::utils::now(),
                provider: ProviderID::VertexAI.to_string(),
                model: model.to_owned(),
                vector,
            })
        })
        .collect()
}

/// Stop pulling new inputs after an ambiguous paid effect, while allowing
/// already-started attempts to finish their own journal settlement.
async fn collect_guarded_embeddings<F, Fut>(
    inputs: Vec<String>,
    execute: F,
) -> Vec<Result<Vec<f64>>>
where
    F: Fn(String) -> Fut,
    Fut: Future<Output = Result<Vec<f64>>>,
{
    let mut source = inputs.into_iter().enumerate().map(|(index, input)| {
        let future = execute(input);
        async move { (index, future.await) }
    });
    let mut active = FuturesUnordered::new();
    for _ in 0..MAX_CONCURRENT_REQUESTS {
        if let Some(future) = source.next() {
            active.push(future);
        }
    }
    let mut completed = Vec::new();
    let mut ambiguous = false;
    while let Some((index, result)) = active.next().await {
        ambiguous |= result
            .as_ref()
            .err()
            .is_some_and(|error| error.downcast_ref::<AmbiguousVertexEffect>().is_some());
        completed.push((index, result));
        if !ambiguous {
            if let Some(future) = source.next() {
                active.push(future);
            }
        }
    }
    completed.sort_by_key(|(index, _)| *index);
    completed.into_iter().map(|(_, result)| result).collect()
}

fn positioned_vectors(
    positions: Vec<usize>,
    unique_vectors: Vec<EmbedderVector>,
) -> Vec<EmbedderVector> {
    positions
        .into_iter()
        .map(|index| unique_vectors[index].clone())
        .collect()
}

/// A paid result that can no longer be served is an ambiguous effect, never
/// a reason to dispatch the same input again.
fn retained_embedding(
    journal: &CoreUsageJournal,
    input_hash: &[u8; 32],
) -> Result<Option<Vec<f64>>> {
    journal.cached_embedding(input_hash).map_err(|error| {
        if error
            .downcast_ref::<PaidEmbeddingRecoveryRequired>()
            .is_some()
        {
            anyhow!(AmbiguousVertexEffect)
        } else {
            error
        }
    })
}

/// ADC is requested only by a journaled, admitted attempt. A failed or
/// stalled token request is proven to precede dispatch.
async fn predispatch_token(token_source: &dyn VertexTokenSource) -> Result<String> {
    tokio::time::timeout(Duration::from_secs(30), token_source.token())
        .await
        .map_err(|_| anyhow!(PreDispatchTokenError))?
        .map_err(|_| anyhow!(PreDispatchTokenError))
}

/// How `run_guarded_attempt` commits its durable start.
#[derive(Clone, Copy, Debug)]
enum AttemptStart {
    /// Signed tenant route: the caller's `admit` performs CRM admission.
    Signed,
    /// Direct POC route: the start also applies the UTC-day token limit.
    DirectWithinLimit { daily_token_limit: u64 },
}

/// @cc [label:security;backend] vertex-embedding-attempt-accounting
/// A unique, durable attempt precedes each provider request, and `admit`
/// must succeed between that start and the request. With
/// `AttemptStart::DirectWithinLimit` the start also applies the UTC-day token
/// limit; an over-limit start returns `AdmissionError::Denied` with no journal
/// row and no `admit` or provider call. A response is returned only after exact
/// provider usage is frozen. A `VertexRejectedRequest` (a complete HTTP 4xx
/// response) settles the attempt `no_charge` with evidence
/// `vertex:rejected:<status>[:<request id>]`, which releases its input
/// reservation, and is returned as that non-ambiguous error. Every other
/// provider failure, including a transport error, timeout, incomplete
/// response, 3xx, 5xx or invalid 2xx, and a rejection whose `no_charge`
/// settlement fails, remains unresolved, never no-charge, and returns
/// `AmbiguousVertexEffect`.

/// @cc [owner:jchen0824,label:security;backend] vertex-embedding-attempt-route-id
/// An `AttemptStart::Signed` attempt's `route_id` is
/// `<route.tenant_id>:<route.revision>` with a decimal revision, as CRM
/// admission and signed delivery require. An `AttemptStart::DirectWithinLimit`
/// attempt's `route_id` is `DIRECT_POC_ROUTE_ID`, whatever the route's fields.
async fn run_guarded_attempt<A, AFut, P, PFut>(
    journal: &CoreUsageJournal,
    route: &CoreTenantRoute,
    model: &str,
    conversation_id: &str,
    input_hash: Option<[u8; 32]>,
    start: AttemptStart,
    admit: A,
    provider: P,
) -> Result<VertexEmbeddingResponse>
where
    A: FnOnce(CoreTenantRoute, CoreUsageAttempt, StartOutcome) -> AFut,
    AFut: Future<Output = Result<()>>,
    P: FnOnce(CoreUsageAttempt) -> PFut,
    PFut: Future<Output = Result<VertexEmbeddingResponse>>,
{
    if model != MODEL_ID {
        return Err(anyhow!("Vertex embedding route unavailable"));
    }
    let route_id = match start {
        AttemptStart::Signed => format!("{}:{}", route.tenant_id, route.revision),
        AttemptStart::DirectWithinLimit { .. } => DIRECT_POC_ROUTE_ID.to_owned(),
    };
    let attempt = CoreUsageAttempt {
        attempt_id: uuid::Uuid::new_v4().to_string(),
        provider_request_id: uuid::Uuid::new_v4().to_string(),
        tenant_id: route.tenant_id.clone(),
        workspace_id: route.workspace_id.clone(),
        conversation_id: conversation_id.to_string(),
        route_id,
        model: model.to_string(),
    };
    let started = match start {
        AttemptStart::Signed => match input_hash.as_ref() {
            Some(hash) => journal.start_embedding(&attempt, hash)?,
            None => journal.start(&attempt)?,
        },
        AttemptStart::DirectWithinLimit { daily_token_limit } => {
            match journal.start_direct_within_limit(
                &attempt,
                input_hash.as_ref(),
                utc_day_start_ms(chrono::Utc::now().timestamp_millis()),
                daily_token_limit,
                DIRECT_EMBEDDING_RESERVATION_TOKENS,
            )? {
                DirectStartOutcome::Created(permit) => StartOutcome::Created(permit),
                DirectStartOutcome::Duplicate => StartOutcome::Duplicate,
                // Nothing was written, so no settlement is owed.
                DirectStartOutcome::OverLimit => return Err(AdmissionError::Denied.into()),
            }
        }
    };
    if !matches!(&started, StartOutcome::Created(_)) {
        return if input_hash.is_some() {
            Err(AmbiguousVertexEffect.into())
        } else {
            Err(anyhow!("Vertex embedding attempt was not new"))
        };
    }
    if let Err(error) = admit(route.clone(), attempt.clone(), started).await {
        journal.settle_no_charge(
            &attempt.attempt_id,
            &format!("predispatch:admission-failed:{}", attempt.attempt_id),
        )?;
        return Err(error);
    }
    let response = match provider(attempt.clone()).await {
        Ok(response) => response,
        Err(error) if error.downcast_ref::<PreDispatchTokenError>().is_some() => {
            journal.settle_no_charge(
                &attempt.attempt_id,
                &format!("predispatch:adc-failed:{}", attempt.attempt_id),
            )?;
            return Err(anyhow!("Vertex ADC unavailable before dispatch"));
        }
        Err(error) => {
            let rejection = error.downcast_ref::<VertexRejectedRequest>();
            // Vertex refused the request and did not bill it. Releasing the
            // attempt and its input reservation lets a later request retry.
            if let Some(rejection) = rejection {
                if journal
                    .settle_no_charge(&attempt.attempt_id, &rejection.evidence_ref())
                    .is_ok()
                {
                    return Err(error);
                }
            }
            let operation_id = error
                .downcast_ref::<ModelError>()
                .and_then(|provider_error| provider_error.request_id.as_deref())
                .or_else(|| rejection.and_then(|rejection| rejection.request_id.as_deref()));
            if journal
                .mark_unknown_with_operation(&attempt.attempt_id, operation_id)
                .is_err()
            {
                tracing::error!("Dust Core unknown-effect journal write unavailable");
            }
            // Vertex embedContent has no idempotency key. Retrying this
            // ambiguous effect through EmbedderRequest would create a second
            // charged attempt, so do not forward ModelError's retry flag.
            return Err(AmbiguousVertexEffect.into());
        }
    };
    let usage = response
        .usage_metadata
        .get("promptTokenCount")
        .and_then(Value::as_u64)
        .filter(|count| (1..=2_147_483_647).contains(count));
    if response.vector.len() != DIMENSIONS
        || response
            .vector
            .iter()
            .any(|value| !value.is_finite() || !(*value as f32).is_finite())
        || usage.is_none()
    {
        if journal.mark_unknown(&attempt.attempt_id).is_err() {
            tracing::error!("Dust Core unknown-effect journal write unavailable");
        }
        return Err(AmbiguousVertexEffect.into());
    }
    // embedContent has no provider operation ID in its documented response.
    // The unique client request ID remains the stable local dedup identity.
    let input_tokens = usage.ok_or_else(|| anyhow!("Vertex embedding usage unavailable"))? as u32;
    let operation_id = format!("client:{}", attempt.provider_request_id);
    match input_hash {
        Some(hash) => journal.settle_exact_with_embedding(
            &attempt,
            &operation_id,
            EmbeddingUsage { input_tokens },
            &hash,
            &response.vector,
        ),
        None => journal.settle_exact(&attempt, &operation_id, EmbeddingUsage { input_tokens }),
    }
    .map_err(|_| AmbiguousVertexEffect)?;
    Ok(response)
}

/// @cc [label:security;backend] vertex-embedding-admission-boundary
/// Public embedding must fail before obtaining ADC or sending a provider request. The typed
/// workspace path may do either only for an attempt that is durably journaled and admitted:
/// by fresh CRM admission on a signed workspace route, or, in direct provider mode, by the
/// journal's daily-limit start for the one configured workspace.
impl VertexAIEmbedder {
    pub fn new(id: String) -> Self {
        Self {
            id,
            project: None,
            client: reqwest::Client::builder()
                .timeout(Duration::from_secs(60))
                .redirect(reqwest::redirect::Policy::none())
                .build()
                .expect("static Vertex client configuration"),
            token_source: Arc::new(AdcTokenSource),
            #[cfg(test)]
            test_endpoint: None,
        }
    }

    fn validate_configuration(model_id: &str, project: &str, location: &str) -> Result<()> {
        if model_id != MODEL_ID {
            return Err(anyhow!("unsupported Vertex embedding model"));
        }
        if project.is_empty()
            || !project
                .bytes()
                .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == b'-')
        {
            return Err(anyhow!("invalid Vertex project ID"));
        }
        if location != "global" {
            return Err(anyhow!("Vertex embedding location must be global"));
        }
        Ok(())
    }

    fn request_body(text: &str, task_type: EmbeddingTaskType) -> Value {
        json!({
            "content": {"role": "user", "parts": [{"text": task_type.prepare(text)}]},
            "embedContentConfig": {"outputDimensionality": DIMENSIONS, "autoTruncate": false}
        })
    }

    fn parse_response(response: Value) -> Result<VertexEmbeddingResponse> {
        // Proto3 JSON may omit a false boolean. A present non-boolean is malformed.
        if response
            .get("truncated")
            .is_some_and(|value| value.as_bool() != Some(false))
        {
            return Err(anyhow!("Vertex embedding response was truncated"));
        }
        let values = response
            .pointer("/embedding/values")
            .and_then(Value::as_array)
            .ok_or_else(|| anyhow!("Vertex embedding response is missing values"))?;
        if values.len() != DIMENSIONS {
            return Err(anyhow!(
                "Vertex embedding response has an invalid vector length"
            ));
        }
        let vector = values
            .iter()
            .map(|value| {
                value
                    .as_f64()
                    .filter(|v| v.is_finite() && (*v as f32).is_finite())
            })
            .collect::<Option<Vec<_>>>()
            .ok_or_else(|| anyhow!("Vertex embedding response has invalid vector values"))?;
        let usage_metadata = response
            .get("usageMetadata")
            .ok_or_else(|| anyhow!("Vertex embedding response has no valid usage metadata"))?;
        usage_metadata
            .get("promptTokenCount")
            .and_then(Value::as_u64)
            .filter(|count| *count > 0)
            .ok_or_else(|| anyhow!("Vertex embedding response has no valid usage metadata"))?;
        Ok(VertexEmbeddingResponse {
            vector,
            usage_metadata: usage_metadata.clone(),
        })
    }

    // Kept private until the admission/journal wrapper can persist and settle usage per attempt.
    /// @cc [owner:jchen0824,label:security;backend] vertex-complete-4xx-is-rejection
    /// `request_one` returns `VertexRejectedRequest` only for a response whose
    /// status is 400 to 499 and whose body was received in full. A transport
    /// error, timeout, body cut short, 3xx, 5xx or invalid 2xx response
    /// returns another error, never `VertexRejectedRequest`.
    async fn request_one(
        client: &reqwest::Client,
        endpoint: &str,
        token: &str,
        text: &str,
        task_type: EmbeddingTaskType,
    ) -> Result<VertexEmbeddingResponse> {
        if text.trim().is_empty() {
            return Err(anyhow!("Vertex embedding input is empty"));
        }
        let response = client
            .post(endpoint)
            .bearer_auth(token)
            .json(&Self::request_body(text, task_type))
            .send()
            .await
            .map_err(|_| anyhow!("Vertex embedding transport error"))?;
        let status = response.status();
        let request_id = response
            .headers()
            .get("x-goog-request-id")
            .and_then(|v| v.to_str().ok())
            .unwrap_or("")
            .chars()
            .filter(|c| c.is_ascii_alphanumeric() || *c == '-')
            .take(80)
            .collect::<String>();
        let request_id = if request_id.is_empty() {
            None
        } else {
            Some(request_id)
        };
        if status.is_client_error() {
            // Only a complete response proves the refusal. A body cut short
            // leaves the request's outcome unknown.
            response
                .bytes()
                .await
                .map_err(|_| anyhow!("Vertex embedding transport error"))?;
            return Err(VertexRejectedRequest {
                status: status.as_u16(),
                request_id,
            }
            .into());
        }
        if !status.is_success() {
            let retryable = if status.is_server_error() {
                Some(ModelErrorRetryOptions {
                    sleep: Duration::from_secs(1),
                    factor: 2,
                    retries: 2,
                })
            } else {
                None
            };
            return Err(ModelError {
                message: format!("Vertex embedding HTTP status {}", status.as_u16()),
                retryable,
                request_id,
            }
            .into());
        }
        let payload: Value = response.json().await.map_err(|_| ModelError {
            message: "Vertex embedding response JSON is invalid".into(),
            retryable: None,
            request_id: request_id.clone(),
        })?;
        Self::parse_response(payload).map_err(|_| {
            ModelError {
                message: "Vertex embedding response is invalid".into(),
                retryable: None,
                request_id,
            }
            .into()
        })
    }

    /// Shared request checks for one guarded batch: initialized project,
    /// non-empty inputs, coalesced document inputs and their upsert identity.
    fn guarded_batch(
        &self,
        text: Vec<&str>,
        task_type: EmbeddingTaskType,
        extras: Option<Value>,
    ) -> Result<GuardedBatch> {
        let project = self
            .project
            .as_deref()
            .ok_or_else(|| anyhow!("Vertex embedder is not initialized"))?;
        let endpoint = format!(
            "https://aiplatform.googleapis.com/v1/projects/{project}/locations/global/publishers/google/models/{API_MODEL_ID}:embedContent"
        );
        #[cfg(test)]
        let endpoint = self
            .test_endpoint
            .as_deref()
            .unwrap_or(&endpoint)
            .to_string();
        let owned_inputs = text.into_iter().map(str::to_owned).collect::<Vec<_>>();
        if owned_inputs.iter().any(|input| input.trim().is_empty()) {
            return Err(anyhow!("Vertex embedding input is empty"));
        }
        let (inputs, positions) = if task_type == EmbeddingTaskType::RetrievalDocument {
            coalesce_document_inputs(owned_inputs)
        } else {
            let positions = (0..owned_inputs.len()).collect();
            (owned_inputs, positions)
        };
        let upsert_key = if task_type == EmbeddingTaskType::RetrievalDocument {
            Some(
                extras
                    .as_ref()
                    .and_then(|value| value.get("dust_poc_upsert_key"))
                    .and_then(Value::as_str)
                    .filter(|key| !key.is_empty())
                    .ok_or_else(|| anyhow!("Vertex document embedding requires upsert identity"))?
                    .to_owned(),
            )
        } else {
            None
        };
        Ok(GuardedBatch {
            endpoint,
            inputs,
            positions,
            upsert_key,
        })
    }

    /// @cc [owner:jchen0824,label:security;backend] dust-core-direct-embedding
    /// Direct provider mode embeds only for the one configured workspace, without
    /// the signed registry, CRM admission or usage delivery; any other workspace is
    /// refused before a journal write. Each input's daily-limit check and journal
    /// start commit in one transaction before its ADC token request or provider
    /// I/O, and an over-limit input is denied with `AdmissionError::Denied`, no row
    /// and no provider call. Its journal rows use `DIRECT_POC_TENANT_ID` and route
    /// `DIRECT_POC_ROUTE_ID`, and are never claimed for delivery. An input that
    /// Vertex rejects with a complete HTTP 4xx response settles `no_charge`: its
    /// row no longer holds the daily-limit reservation, and a later request for
    /// the same input starts a new attempt.
    async fn embed_direct(
        &self,
        runtime: &CoreDirectVertexRuntime,
        text: Vec<&str>,
        task_type: EmbeddingTaskType,
        extras: Option<Value>,
        workspace: &VerifiedWorkspace,
    ) -> Result<Vec<EmbedderVector>> {
        if workspace.sid() != runtime.workspace_id {
            return Err(anyhow!("Vertex embedding workspace is not enabled"));
        }
        let GuardedBatch {
            endpoint,
            inputs,
            positions,
            upsert_key,
        } = self.guarded_batch(text, task_type, extras)?;
        let route = direct_poc_route(&runtime.workspace_id);
        let results = collect_guarded_embeddings(inputs, |input| {
            let token_source = self.token_source.clone();
            let endpoint = endpoint.clone();
            let client = self.client.clone();
            let upsert_key = upsert_key.clone();
            let route = &route;
            async move {
                let input_hash = (task_type == EmbeddingTaskType::RetrievalDocument).then(|| {
                    embedding_input_hash(
                        route,
                        &self.id,
                        task_type,
                        upsert_key.as_deref().unwrap_or_default(),
                        &input,
                    )
                });
                if let Some(hash) = input_hash {
                    if let Some(vector) = retained_embedding(&runtime.journal, &hash)? {
                        return Ok(vector);
                    }
                }
                run_guarded_attempt(
                    &runtime.journal,
                    route,
                    &self.id,
                    &format!("embedding:{}", workspace.sid()),
                    input_hash,
                    AttemptStart::DirectWithinLimit {
                        daily_token_limit: runtime.daily_token_limit,
                    },
                    // The daily-limit start is the admission in direct mode.
                    |_, _, _| async { Ok(()) },
                    |attempt| async move {
                        let token = predispatch_token(token_source.as_ref()).await?;
                        runtime
                            .journal
                            .heartbeat_started(&attempt.attempt_id)
                            .map_err(|_| anyhow!(PreDispatchTokenError))?;
                        Self::request_one(&client, &endpoint, &token, &input, task_type).await
                    },
                )
                .await
                .map(|response| response.vector)
            }
        })
        .await;
        Ok(positioned_vectors(
            positions,
            finish_embedding_batch(results, &self.id)?,
        ))
    }

    #[allow(dead_code)]
    async fn request_batch(
        &self,
        texts: Vec<&str>,
        task_type: EmbeddingTaskType,
    ) -> Result<Vec<VertexEmbeddingResponse>> {
        let project = self
            .project
            .as_deref()
            .ok_or_else(|| anyhow!("Vertex embedder is not initialized"))?;
        let token = self.token_source.token().await?;
        let endpoint = format!(
            "https://aiplatform.googleapis.com/v1/projects/{project}/locations/global/publishers/google/models/{API_MODEL_ID}:embedContent"
        );
        #[cfg(test)]
        let endpoint = self
            .test_endpoint
            .as_deref()
            .unwrap_or(&endpoint)
            .to_string();
        let client = self.client.clone();
        let token_value = Arc::new(token);
        let mut results = stream::iter(texts.into_iter().enumerate().map(|(index, text)| {
            let client = client.clone();
            let token = token_value.clone();
            let endpoint = endpoint.clone();
            async move {
                let result = Self::request_one(&client, &endpoint, &token, text, task_type).await;
                (index, result)
            }
        }))
        .buffer_unordered(MAX_CONCURRENT_REQUESTS)
        .collect::<Vec<_>>()
        .await;
        results.sort_by_key(|(index, _)| *index);
        results.into_iter().map(|(_, result)| result).collect()
    }
}

#[async_trait]
impl Embedder for VertexAIEmbedder {
    fn id(&self) -> String {
        self.id.clone()
    }

    async fn initialize(&mut self, _credentials: Credentials) -> Result<()> {
        let project = std::env::var("VERTEX_AI_PROJECT_ID").unwrap_or_default();
        let location = std::env::var("VERTEX_AI_LOCATION").unwrap_or_else(|_| "global".to_string());
        Self::validate_configuration(&self.id, &project, &location)?;
        self.project = Some(project);
        Ok(())
    }

    fn context_size(&self) -> usize {
        CONTEXT_SIZE
    }
    fn embedding_size(&self) -> usize {
        DIMENSIONS
    }

    async fn encode(&self, text: &str) -> Result<Vec<usize>> {
        encode_async(cl100k_base_singleton(), text).await
    }

    async fn decode(&self, tokens: Vec<usize>) -> Result<String> {
        decode_async(cl100k_base_singleton(), tokens).await
    }

    async fn tokenize(&self, texts: Vec<String>) -> Result<Vec<Vec<(usize, String)>>> {
        batch_tokenize_async(cl100k_base_singleton(), texts).await
    }

    async fn embed(
        &self,
        _text: Vec<&str>,
        _task_type: EmbeddingTaskType,
        _extras: Option<Value>,
    ) -> Result<Vec<EmbedderVector>> {
        Err(anyhow!("Vertex embedding is disabled until trusted tenant admission and durable usage accounting are integrated"))
    }

    /// @cc [label:security;backend] vertex-embedding-provider-dispatch-gate
    /// Each input pulled before an ambiguous completion is resolved from a
    /// verified workspace, durably journaled, and admitted before dispatch:
    /// through the signed route and CRM, or, when `DUST_POC_DIRECT_PROVIDER_MODE`
    /// is `1`, through the direct daily-limit start. A mode value other than unset,
    /// `0` or `1`, or an incomplete direct configuration, refuses the batch before
    /// a journal write or provider I/O. Repeated document positions reuse that
    /// vector without another paid call; query positions each have their own
    /// attempt. After an ambiguous effect, no new inputs are pulled and
    /// already-started attempts settle. A Vertex rejection (a complete HTTP 4xx
    /// response, settled `no_charge`) is not an ambiguous effect: it does not
    /// stop new inputs from being pulled, and the batch then fails with a
    /// non-ambiguous error unless another input's effect is ambiguous.
    async fn embed_with_workspace(
        &self,
        text: Vec<&str>,
        task_type: EmbeddingTaskType,
        extras: Option<Value>,
        workspace: Option<&VerifiedWorkspace>,
    ) -> Result<Vec<EmbedderVector>> {
        let workspace = workspace
            .filter(|workspace| !workspace.sid().is_empty())
            .ok_or_else(|| anyhow!("Vertex embedding requires verified workspace"))?;
        if std::env::var("DUST_POC_MODE").as_deref() != Ok("1")
            || std::env::var("DUST_CORE_VERTEX_PROVIDER_IO_ENABLED").as_deref() != Ok("1")
        {
            return Err(anyhow!("Vertex embedding provider I/O is disabled"));
        }
        if direct_provider_mode(std::env::var(DIRECT_PROVIDER_MODE_ENV))? {
            let runtime = core_direct_vertex_runtime()?;
            return self
                .embed_direct(runtime, text, task_type, extras, workspace)
                .await;
        }
        let runtime = core_vertex_runtime()?;
        if !runtime.workspaces.iter().any(|id| id == workspace.sid()) {
            return Err(anyhow!("Vertex embedding workspace is not enabled"));
        }
        let GuardedBatch {
            endpoint,
            inputs,
            positions,
            upsert_key,
        } = self.guarded_batch(text, task_type, extras)?;
        let results = collect_guarded_embeddings(inputs, |input| {
            let token_source = self.token_source.clone();
            let endpoint = endpoint.clone();
            let client = self.client.clone();
            let upsert_key = upsert_key.clone();
            async move {
                let route = runtime.resolver.resolve(workspace).await?;
                let input_hash = (task_type == EmbeddingTaskType::RetrievalDocument).then(|| {
                    embedding_input_hash(
                        &route,
                        &self.id,
                        task_type,
                        upsert_key.as_deref().unwrap_or_default(),
                        &input,
                    )
                });
                if let Some(hash) = input_hash {
                    if let Some(vector) = retained_embedding(&runtime.journal, &hash)? {
                        return Ok(vector);
                    }
                }
                let dispatch_route = route.clone();
                run_guarded_attempt(
                    &runtime.journal,
                    &route,
                    &self.id,
                    &format!("embedding:{}", workspace.sid()),
                    input_hash,
                    AttemptStart::Signed,
                    |route, attempt, started| async move {
                        runtime
                            .admission
                            .require_admission(&route, &attempt, started)
                            .await
                            .map_err(anyhow::Error::from)?;
                        let current = runtime.resolver.resolve(workspace).await?;
                        // Signing-key rotation does not change the signed tenant route.
                        if !same_signed_route(&current, &route) {
                            return Err(anyhow!("Vertex embedding route changed before dispatch"));
                        }
                        Ok(())
                    },
                    |attempt| async move {
                        // ADC is downstream of the per-attempt journal and CRM
                        // admission. A denied tenant must not request a token.
                        let token = predispatch_token(token_source.as_ref()).await?;
                        runtime
                            .journal
                            .heartbeat_started(&attempt.attempt_id)
                            .map_err(|_| anyhow!(PreDispatchTokenError))?;
                        let current = runtime
                            .resolver
                            .resolve(workspace)
                            .await
                            .map_err(|_| anyhow!(PreDispatchTokenError))?;
                        if !same_signed_route(&current, &dispatch_route) {
                            return Err(anyhow!(PreDispatchTokenError));
                        }
                        Self::request_one(&client, &endpoint, &token, &input, task_type).await
                    },
                )
                .await
                .map(|response| response.vector)
            }
        })
        .await;
        Ok(positioned_vectors(
            positions,
            finish_embedding_batch(results, &self.id)?,
        ))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicUsize, Ordering};
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    use tokio::net::TcpListener;

    #[test]
    fn repeated_document_chunks_share_one_dispatch_result() {
        let (unique, positions) = coalesce_document_inputs(vec![
            "first".into(),
            "repeat".into(),
            "repeat".into(),
            "first".into(),
        ]);
        assert_eq!(unique, vec!["first", "repeat"]);
        assert_eq!(positions, vec![0, 1, 1, 0]);
    }

    #[test]
    fn embedding_reservation_key_is_scoped_to_document_version() {
        let route = CoreTenantRoute {
            tenant_id: "tenant-a".into(),
            workspace_id: "workspace-a".into(),
            private_route: "https://crm-a.internal".into(),
            admission_url: "https://crm-a.internal/admission".into(),
            usage_ingest_url: "https://crm-a.internal/usage".into(),
            core_credential_ref: "core-key".into(),
            journal_target: "tenant:tenant-a:dust-usage".into(),
            revision: 1,
            key_id: "pin-a".into(),
        };
        assert_ne!(
            embedding_input_hash(
                &route,
                MODEL_ID,
                EmbeddingTaskType::RetrievalDocument,
                "document-a:version-1",
                "repeated text",
            ),
            embedding_input_hash(
                &route,
                MODEL_ID,
                EmbeddingTaskType::RetrievalDocument,
                "document-b:version-1",
                "repeated text",
            )
        );
    }

    #[test]
    fn ambiguous_input_takes_precedence_over_earlier_predispatch_error() {
        let results = vec![
            Err(anyhow!("admission unavailable")),
            Err(AmbiguousVertexEffect.into()),
        ];
        let error = finish_embedding_batch(results, MODEL_ID).expect_err("ambiguous batch");
        assert!(error.downcast_ref::<AmbiguousVertexEffect>().is_some());
    }

    #[tokio::test]
    async fn ambiguous_batch_drains_active_attempts_without_scheduling_more() {
        let started = Arc::new(AtomicUsize::new(0));
        let settled = Arc::new(AtomicUsize::new(0));
        let results =
            collect_guarded_embeddings((0..12).map(|index| index.to_string()).collect(), |input| {
                let started = started.clone();
                let settled = settled.clone();
                async move {
                    started.fetch_add(1, Ordering::SeqCst);
                    if input == "0" {
                        return Err(AmbiguousVertexEffect.into());
                    }
                    tokio::time::sleep(Duration::from_millis(5)).await;
                    settled.fetch_add(1, Ordering::SeqCst);
                    Ok(vec![0.0; DIMENSIONS])
                }
            })
            .await;
        assert_eq!(started.load(Ordering::SeqCst), MAX_CONCURRENT_REQUESTS);
        assert_eq!(settled.load(Ordering::SeqCst), MAX_CONCURRENT_REQUESTS - 1);
        assert_eq!(results.len(), MAX_CONCURRENT_REQUESTS);
        assert!(finish_embedding_batch(results, MODEL_ID)
            .expect_err("ambiguous batch")
            .downcast_ref::<AmbiguousVertexEffect>()
            .is_some());
    }

    struct FakeTokenSource(Result<String, &'static str>);

    #[async_trait]
    impl VertexTokenSource for FakeTokenSource {
        async fn token(&self) -> Result<String> {
            self.0
                .clone()
                .map_err(|_| anyhow!("Vertex ADC initialization failed"))
        }
    }

    fn test_embedder(endpoint: String, token: Result<String, &'static str>) -> VertexAIEmbedder {
        let mut embedder = VertexAIEmbedder::new(MODEL_ID.to_string());
        embedder.project = Some("test-project".to_string());
        embedder.token_source = Arc::new(FakeTokenSource(token));
        embedder.test_endpoint = Some(endpoint);
        embedder
    }

    #[test]
    fn request_body_uses_content_instructions_without_legacy_task_type() {
        let document =
            VertexAIEmbedder::request_body("sample", EmbeddingTaskType::RetrievalDocument);
        let query = VertexAIEmbedder::request_body("sample", EmbeddingTaskType::RetrievalQuery);
        assert_eq!(
            document
                .pointer("/content/parts/0/text")
                .expect("test operation failed"),
            "title: none | text: sample"
        );
        assert_eq!(
            query
                .pointer("/content/parts/0/text")
                .expect("test operation failed"),
            "task: search result | query: sample"
        );
        assert_eq!(
            query
                .pointer("/embedContentConfig/outputDimensionality")
                .expect("test operation failed"),
            DIMENSIONS
        );
        assert_eq!(
            query
                .pointer("/embedContentConfig/autoTruncate")
                .expect("test operation failed"),
            false
        );
        assert!(document.get("taskType").is_none());
    }

    #[test]
    fn only_pinned_model_and_global_location_are_accepted() {
        assert!(VertexAIEmbedder::validate_configuration(
            MODEL_ID,
            "agentplatform-492815",
            "global"
        )
        .is_ok());
        assert!(VertexAIEmbedder::validate_configuration(
            "gemini-embedding-001",
            "agentplatform-492815",
            "global"
        )
        .is_err());
        assert!(VertexAIEmbedder::validate_configuration(MODEL_ID, "", "global").is_err());
        assert!(VertexAIEmbedder::validate_configuration(
            MODEL_ID,
            "agentplatform-492815",
            "us-central1"
        )
        .is_err());
    }

    #[test]
    fn response_requires_exact_finite_vector_and_usage() {
        let response = json!({"embedding": {"values": vec![0.25; DIMENSIONS]}, "usageMetadata": {"promptTokenCount": 7}, "truncated": false});
        assert_eq!(
            VertexAIEmbedder::parse_response(response.clone())
                .expect("test operation failed")
                .usage_metadata["promptTokenCount"],
            7
        );
        for size in [0, DIMENSIONS - 1, DIMENSIONS + 1] {
            let mut wrong_size = response.clone();
            wrong_size["embedding"]["values"] = json!(vec![0.25; size]);
            assert!(VertexAIEmbedder::parse_response(wrong_size).is_err());
        }
        let mut missing_usage = response.clone();
        missing_usage
            .as_object_mut()
            .expect("test operation failed")
            .remove("usageMetadata");
        assert!(VertexAIEmbedder::parse_response(missing_usage).is_err());
        let mut truncated = response;
        truncated["truncated"] = json!(true);
        assert!(VertexAIEmbedder::parse_response(truncated).is_err());
        let without_false_field = json!({"embedding": {"values": vec![0.25; DIMENSIONS]}, "usageMetadata": {"promptTokenCount": 7}});
        assert!(VertexAIEmbedder::parse_response(without_false_field).is_ok());
        for invalid_value in [json!("NaN"), json!(null), json!(1e300)] {
            let mut invalid = json!({"embedding": {"values": vec![0.25; DIMENSIONS]}, "usageMetadata": {"promptTokenCount": 7}});
            invalid["embedding"]["values"][0] = invalid_value;
            assert!(VertexAIEmbedder::parse_response(invalid).is_err());
        }
        let zero_usage = json!({"embedding": {"values": vec![0.25; DIMENSIONS]}, "usageMetadata": {"promptTokenCount": 0}});
        assert!(VertexAIEmbedder::parse_response(zero_usage).is_err());
    }

    #[tokio::test]
    async fn public_embed_fails_before_adc_or_network() {
        let embedder = VertexAIEmbedder::new(MODEL_ID.to_string());
        assert!(embedder
            .embed(
                vec!["sensitive"],
                EmbeddingTaskType::RetrievalDocument,
                None
            )
            .await
            .is_err());
    }

    #[tokio::test]
    async fn guarded_attempt_requires_durable_start_and_admission_before_provider_io() {
        use crate::tenant_route::CoreTenantRoute;
        use tempfile::tempdir;
        let dir = tempdir().expect("test operation failed");
        let journal = crate::usage_journal::CoreUsageJournal::open(dir.path().join("usage.sqlite"))
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
            key_id: "pin-a".into(),
        };
        let mut rotated_key = route.clone();
        rotated_key.key_id = "pin-b".into();
        assert!(same_signed_route(&route, &rotated_key));
        rotated_key.revision += 1;
        assert!(same_signed_route(&route, &rotated_key));
        rotated_key.workspace_id = "other-workspace".into();
        assert!(!same_signed_route(&route, &rotated_key));
        let provider_calls = AtomicUsize::new(0);
        let denied = run_guarded_attempt(
            &journal,
            &route,
            MODEL_ID,
            "embedding-test",
            None,
            AttemptStart::Signed,
            |_, _, _| async { Err(crate::quota_admission::AdmissionError::Denied.into()) },
            |_| async {
                provider_calls.fetch_add(1, Ordering::SeqCst);
                unreachable!()
            },
        )
        .await;
        assert_eq!(
            denied
                .as_ref()
                .err()
                .and_then(|error| error.downcast_ref::<crate::quota_admission::AdmissionError>()),
            Some(&crate::quota_admission::AdmissionError::Denied)
        );
        assert_eq!(provider_calls.load(Ordering::SeqCst), 0);

        let response = run_guarded_attempt(
            &journal,
            &route,
            MODEL_ID,
            "embedding-test",
            None,
            AttemptStart::Signed,
            |_, _, started| async move {
                assert!(matches!(
                    started,
                    crate::usage_journal::StartOutcome::Created(_)
                ));
                Ok(())
            },
            |_| async {
                provider_calls.fetch_add(1, Ordering::SeqCst);
                Ok(VertexEmbeddingResponse {
                    vector: vec![0.25; DIMENSIONS],
                    usage_metadata: json!({"promptTokenCount": 7}),
                })
            },
        )
        .await
        .expect("test operation failed");
        assert_eq!(response.vector.len(), DIMENSIONS);
        assert_eq!(provider_calls.load(Ordering::SeqCst), 1);
        let exact = journal
            .claim_due("reconciler", 20)
            .expect("test operation failed");
        assert_eq!(exact.len(), 1);
        assert_eq!(exact[0].state, "exact");
        assert!(exact[0]
            .event_envelope
            .as_ref()
            .expect("test operation failed")
            .contains("\"input_tokens\":\"7\""));

        let adc_failed = run_guarded_attempt(
            &journal,
            &route,
            MODEL_ID,
            "embedding-test",
            None,
            AttemptStart::Signed,
            |_, _, _| async { Ok(()) },
            |_| async { Err(anyhow!(PreDispatchTokenError)) },
        )
        .await;
        assert!(adc_failed.is_err());
        let conn = rusqlite::Connection::open(dir.path().join("usage.sqlite"))
            .expect("test operation failed");
        let no_charge: i64 = conn
            .query_row(
                "SELECT count(*) FROM dust_usage_attempts WHERE state = 'no_charge'",
                [],
                |row| row.get(0),
            )
            .expect("test operation failed");
        assert_eq!(no_charge, 2); // Admission denial and ADC failure, both before dispatch.

        let ambiguous = run_guarded_attempt(
            &journal,
            &route,
            MODEL_ID,
            "embedding-test",
            None,
            AttemptStart::Signed,
            |_, _, _| async { Ok(()) },
            |_| async { Err(anyhow!("transport timeout")) },
        )
        .await;
        assert!(ambiguous.is_err());
        let unresolved = journal
            .claim_due("reconciler2", 20)
            .expect("test operation failed");
        assert_eq!(unresolved.len(), 1);
        assert_eq!(unresolved[0].state, "unknown");
        assert!(unresolved[0].event_envelope.is_none());

        let provider_calls_before = provider_calls.load(Ordering::SeqCst);
        let unavailable = run_guarded_attempt(
            &journal,
            &route,
            MODEL_ID,
            "embedding-test",
            None,
            AttemptStart::Signed,
            |_, _, _| async { Ok(()) },
            |_| async {
                provider_calls.fetch_add(1, Ordering::SeqCst);
                Err(anyhow!(ModelError {
                    message: "Vertex embedding HTTP status 503".into(),
                    retryable: Some(ModelErrorRetryOptions {
                        sleep: Duration::from_secs(1),
                        factor: 2,
                        retries: 2,
                    }),
                    request_id: Some("abc-123".into()),
                }))
            },
        )
        .await;
        assert!(unavailable
            .as_ref()
            .err()
            .and_then(|error| error.downcast_ref::<ModelError>())
            .is_none());
        assert_eq!(
            provider_calls.load(Ordering::SeqCst),
            provider_calls_before + 1
        );
        let claims = journal
            .claim_due("provider-id-inspector", 20)
            .expect("test operation failed");
        assert!(claims.iter().any(|claim| {
            claim.state == "unknown" && claim.provider_operation_id.as_deref() == Some("abc-123")
        }));

        let journal_dir = dir.path().to_path_buf();
        let unavailable_journal = run_guarded_attempt(
            &journal,
            &route,
            MODEL_ID,
            "embedding-test",
            None,
            AttemptStart::Signed,
            |_, _, _| async { Ok(()) },
            |_| async move {
                std::fs::remove_dir_all(journal_dir).expect("test operation failed");
                Err(anyhow!("provider result unknown"))
            },
        )
        .await
        .expect_err("post-dispatch journal failure must be ambiguous");
        assert!(unavailable_journal
            .downcast_ref::<AmbiguousVertexEffect>()
            .is_some());
    }

    #[tokio::test]
    async fn typed_embedding_rejects_missing_and_forged_workspace_before_provider_io() {
        use crate::workspace_assertion::{verify, DataSourcePair};
        let embedder = VertexAIEmbedder::new(MODEL_ID.to_string());
        let pair = DataSourcePair {
            project_id: 7,
            data_source_id: "ds-1".to_string(),
        };
        let forged = verify(Some("forged-workspace-assertion"), &[pair]);
        assert!(forged.is_none());
        for workspace in [None, forged.as_ref()] {
            let error = embedder
                .embed_with_workspace(
                    vec!["sensitive"],
                    EmbeddingTaskType::RetrievalQuery,
                    None,
                    workspace,
                )
                .await
                .unwrap_err();
            assert_eq!(
                error.to_string(),
                "Vertex embedding requires verified workspace"
            );
        }
    }

    #[tokio::test]
    async fn accidental_llm_selection_returns_an_error_without_panicking() {
        let mut llm = VertexAIProvider::new().llm("gemini-embedding-2-1536".to_string(), None);
        assert!(llm.initialize(Credentials::new()).await.is_err());
        assert!(llm
            .generate(
                "sample",
                None,
                0.0,
                1,
                &vec![],
                None,
                None,
                None,
                None,
                None,
                None
            )
            .await
            .is_err());
    }

    #[tokio::test]
    async fn transport_sends_instruction_and_bearer_header_without_leaking_response_body() {
        let listener = TcpListener::bind("127.0.0.1:0")
            .await
            .expect("test operation failed");
        let address = listener.local_addr().expect("test operation failed");
        let server = tokio::spawn(async move {
            let (mut socket, _) = listener.accept().await.expect("test operation failed");
            let mut request = Vec::new();
            loop {
                let mut chunk = [0u8; 4096];
                let read = socket
                    .read(&mut chunk)
                    .await
                    .expect("test operation failed");
                assert!(read > 0);
                request.extend_from_slice(&chunk[..read]);
                let Some(header_end) = request.windows(4).position(|window| window == b"\r\n\r\n")
                else {
                    continue;
                };
                let headers = String::from_utf8_lossy(&request[..header_end]);
                let content_length = headers
                    .lines()
                    .find_map(|line| {
                        line.to_ascii_lowercase()
                            .strip_prefix("content-length: ")
                            .and_then(|value| value.parse::<usize>().ok())
                    })
                    .expect("test operation failed");
                if request.len() >= header_end + 4 + content_length {
                    break;
                }
            }
            let request = String::from_utf8(request).expect("test operation failed");
            assert!(request.starts_with("POST /v1/projects/test/locations/global/publishers/google/models/gemini-embedding-2:embedContent HTTP/1.1"));
            assert!(request
                .to_ascii_lowercase()
                .contains("authorization: bearer test-token"));
            assert!(request.contains("task: search result | query: sample"));
            assert!(!request.contains("taskType"));
            let body = json!({"embedding":{"values":vec![0.5;DIMENSIONS]},"usageMetadata":{"promptTokenCount":4},"truncated":false}).to_string();
            let response = format!(
                "HTTP/1.1 200 OK\r\ncontent-type: application/json\r\ncontent-length: {}\r\n\r\n{}",
                body.len(),
                body
            );
            socket
                .write_all(response.as_bytes())
                .await
                .expect("test operation failed");
        });
        let endpoint = format!("http://{address}/v1/projects/test/locations/global/publishers/google/models/gemini-embedding-2:embedContent");
        let result = VertexAIEmbedder::request_one(
            &reqwest::Client::new(),
            &endpoint,
            "test-token",
            "sample",
            EmbeddingTaskType::RetrievalQuery,
        )
        .await
        .expect("test operation failed");
        assert_eq!(result.vector.len(), DIMENSIONS);
        assert_eq!(result.usage_metadata["promptTokenCount"], 4);
        server.await.expect("test operation failed");
    }

    #[tokio::test]
    async fn rejected_status_sanitizes_request_id_and_hides_provider_body() {
        let listener = TcpListener::bind("127.0.0.1:0")
            .await
            .expect("test operation failed");
        let address = listener.local_addr().expect("test operation failed");
        let server = tokio::spawn(async move {
            let (mut socket, _) = listener.accept().await.expect("test operation failed");
            let mut buffer = [0u8; 4096];
            let _ = socket
                .read(&mut buffer)
                .await
                .expect("test operation failed");
            socket.write_all(b"HTTP/1.1 429 Too Many Requests\r\nx-goog-request-id: abc-123\r\ncontent-length: 15\r\n\r\nprivate-payload").await.expect("test operation failed");
        });
        let error = VertexAIEmbedder::request_one(
            &reqwest::Client::new(),
            &format!("http://{address}/embed"),
            "secret-token",
            "sensitive-input",
            EmbeddingTaskType::RetrievalDocument,
        )
        .await
        .unwrap_err();
        let rejection = error
            .downcast_ref::<VertexRejectedRequest>()
            .expect("a complete 429 is a rejection");
        assert_eq!(rejection.status, 429);
        assert_eq!(rejection.request_id.as_deref(), Some("abc-123"));
        assert_eq!(rejection.evidence_ref(), "vertex:rejected:429:abc-123");
        let message = error.to_string();
        assert!(!message.contains("private-payload"));
        assert!(!message.contains("secret-token"));
        assert!(!message.contains("sensitive-input"));
        server.await.expect("test operation failed");
    }

    #[tokio::test]
    async fn malformed_success_preserves_provider_request_id() {
        let listener = TcpListener::bind("127.0.0.1:0")
            .await
            .expect("test operation failed");
        let address = listener.local_addr().expect("test operation failed");
        let server = tokio::spawn(async move {
            let (mut socket, _) = listener.accept().await.expect("test operation failed");
            let mut buffer = [0u8; 4096];
            let _ = socket
                .read(&mut buffer)
                .await
                .expect("test operation failed");
            socket
                .write_all(b"HTTP/1.1 200 OK\r\nx-goog-request-id: response-42\r\ncontent-length: 7\r\n\r\ninvalid")
                .await
                .expect("test operation failed");
        });
        let error = VertexAIEmbedder::request_one(
            &reqwest::Client::new(),
            &format!("http://{address}/embed"),
            "test-token",
            "sample",
            EmbeddingTaskType::RetrievalQuery,
        )
        .await
        .expect_err("malformed success must be rejected");
        assert_eq!(
            error
                .downcast_ref::<ModelError>()
                .and_then(|error| error.request_id.as_deref()),
            Some("response-42")
        );
        server.await.expect("test operation failed");
    }

    #[tokio::test]
    async fn injected_adc_failure_prevents_http() {
        let embedder = test_embedder(
            "http://127.0.0.1:1/unreachable".to_string(),
            Err("private credential material"),
        );
        let error = embedder
            .request_batch(vec!["sample"], EmbeddingTaskType::RetrievalQuery)
            .await
            .unwrap_err();
        assert_eq!(error.to_string(), "Vertex ADC initialization failed");
    }

    #[tokio::test]
    async fn rejected_statuses_and_timeout_hide_provider_material() {
        for status in [401, 403, 500] {
            let listener = TcpListener::bind("127.0.0.1:0")
                .await
                .expect("test operation failed");
            let address = listener.local_addr().expect("test operation failed");
            let server = tokio::spawn(async move {
                let (mut socket, _) = listener.accept().await.expect("test operation failed");
                let mut buffer = [0u8; 4096];
                let _ = socket
                    .read(&mut buffer)
                    .await
                    .expect("test operation failed");
                let body = "secret-provider-error";
                let response = format!(
                    "HTTP/1.1 {status} Rejected\r\ncontent-length: {}\r\n\r\n{body}",
                    body.len()
                );
                socket
                    .write_all(response.as_bytes())
                    .await
                    .expect("test operation failed");
            });
            let error = VertexAIEmbedder::request_one(
                &reqwest::Client::new(),
                &format!("http://{address}/embed"),
                "secret-token",
                "secret-input",
                EmbeddingTaskType::RetrievalQuery,
            )
            .await
            .unwrap_err();
            if status == 500 {
                let model_error = error
                    .downcast_ref::<ModelError>()
                    .expect("test operation failed");
                assert!(model_error.retryable.is_some());
            } else {
                assert_eq!(
                    error
                        .downcast_ref::<VertexRejectedRequest>()
                        .map(|rejection| rejection.status),
                    Some(status)
                );
            }
            assert!(!error.to_string().contains("secret"));
            server.await.expect("test operation failed");
        }

        let listener = TcpListener::bind("127.0.0.1:0")
            .await
            .expect("test operation failed");
        let address = listener.local_addr().expect("test operation failed");
        let server = tokio::spawn(async move {
            let (mut socket, _) = listener.accept().await.expect("test operation failed");
            let mut buffer = [0u8; 4096];
            let _ = socket
                .read(&mut buffer)
                .await
                .expect("test operation failed");
            tokio::time::sleep(Duration::from_millis(100)).await;
        });
        let client = reqwest::Client::builder()
            .timeout(Duration::from_millis(10))
            .build()
            .expect("test operation failed");
        let error = VertexAIEmbedder::request_one(
            &client,
            &format!("http://{address}/embed"),
            "secret-token",
            "secret-input",
            EmbeddingTaskType::RetrievalQuery,
        )
        .await
        .unwrap_err();
        assert_eq!(error.to_string(), "Vertex embedding transport error");
        server.await.expect("test operation failed");
    }

    #[tokio::test]
    async fn production_client_does_not_follow_provider_redirects() {
        let listener = TcpListener::bind("127.0.0.1:0")
            .await
            .expect("test operation failed");
        let address = listener.local_addr().expect("test operation failed");
        let server = tokio::spawn(async move {
            let (mut socket, _) = listener.accept().await.expect("test operation failed");
            let mut buffer = [0u8; 4096];
            let _ = socket
                .read(&mut buffer)
                .await
                .expect("test operation failed");
            let response = format!(
                "HTTP/1.1 307 Temporary Redirect\r\nLocation: http://{address}/embed\r\nContent-Length: 0\r\n\r\n"
            );
            socket
                .write_all(response.as_bytes())
                .await
                .expect("test operation failed");
            tokio::time::timeout(Duration::from_millis(100), listener.accept())
                .await
                .is_err()
        });
        let embedder = VertexAIEmbedder::new(MODEL_ID.to_owned());
        let error = VertexAIEmbedder::request_one(
            &embedder.client,
            &format!("http://{address}/embed"),
            "test-token",
            "sample",
            EmbeddingTaskType::RetrievalQuery,
        )
        .await
        .expect_err("redirect must remain an ambiguous response");
        assert!(error.to_string().contains("307"));
        assert!(server.await.expect("test operation failed"));
    }

    #[tokio::test]
    async fn private_batch_preserves_order_and_bounds_concurrency() {
        let listener = TcpListener::bind("127.0.0.1:0")
            .await
            .expect("test operation failed");
        let address = listener.local_addr().expect("test operation failed");
        let active = Arc::new(AtomicUsize::new(0));
        let maximum = Arc::new(AtomicUsize::new(0));
        let server = {
            let active = active.clone();
            let maximum = maximum.clone();
            tokio::spawn(async move {
                for _ in 0..12 {
                    let (mut socket, _) = listener.accept().await.expect("test operation failed");
                    let active = active.clone();
                    let maximum = maximum.clone();
                    tokio::spawn(async move {
                        let mut request = Vec::new();
                        loop {
                            let mut chunk = [0u8; 4096];
                            let read = socket
                                .read(&mut chunk)
                                .await
                                .expect("test operation failed");
                            request.extend_from_slice(&chunk[..read]);
                            let Some(header_end) =
                                request.windows(4).position(|window| window == b"\r\n\r\n")
                            else {
                                continue;
                            };
                            let headers = String::from_utf8_lossy(&request[..header_end]);
                            let length = headers
                                .lines()
                                .find_map(|line| {
                                    line.to_ascii_lowercase()
                                        .strip_prefix("content-length: ")
                                        .and_then(|v| v.parse::<usize>().ok())
                                })
                                .expect("test operation failed");
                            if request.len() >= header_end + 4 + length {
                                break;
                            }
                        }
                        let body_start = request
                            .windows(4)
                            .position(|window| window == b"\r\n\r\n")
                            .expect("test operation failed")
                            + 4;
                        let body: Value = serde_json::from_slice(&request[body_start..])
                            .expect("test operation failed");
                        let input = body
                            .pointer("/content/parts/0/text")
                            .expect("test operation failed")
                            .as_str()
                            .expect("test operation failed");
                        let index: usize = input
                            .rsplit(':')
                            .next()
                            .expect("test operation failed")
                            .trim()
                            .parse()
                            .expect("test operation failed");
                        let concurrent = active.fetch_add(1, Ordering::SeqCst) + 1;
                        maximum.fetch_max(concurrent, Ordering::SeqCst);
                        tokio::time::sleep(Duration::from_millis(30)).await;
                        active.fetch_sub(1, Ordering::SeqCst);
                        let body = json!({"embedding":{"values":vec![index as f64; DIMENSIONS]},"usageMetadata":{"promptTokenCount":1}}).to_string();
                        let response = format!("HTTP/1.1 200 OK\r\ncontent-type: application/json\r\ncontent-length: {}\r\n\r\n{}", body.len(), body);
                        socket
                            .write_all(response.as_bytes())
                            .await
                            .expect("test operation failed");
                    });
                }
            })
        };
        let embedder = test_embedder(
            format!("http://{address}/embed"),
            Ok("test-token".to_string()),
        );
        let inputs = (0..12).map(|index| index.to_string()).collect::<Vec<_>>();
        let results = tokio::time::timeout(
            Duration::from_secs(5),
            embedder.request_batch(
                inputs.iter().map(String::as_str).collect(),
                EmbeddingTaskType::RetrievalQuery,
            ),
        )
        .await
        .expect("test operation failed")
        .expect("test operation failed");
        for (index, result) in results.iter().enumerate() {
            assert_eq!(result.vector[0], index as f64);
        }
        assert!(maximum.load(Ordering::SeqCst) <= MAX_CONCURRENT_REQUESTS);
        assert!(maximum.load(Ordering::SeqCst) > 1);
        server.await.expect("test operation failed");
    }

    const DIRECT_WORKSPACE: &str = "workspace-direct";

    struct CountingTokenSource(Arc<AtomicUsize>);

    #[async_trait]
    impl VertexTokenSource for CountingTokenSource {
        async fn token(&self) -> Result<String> {
            self.0.fetch_add(1, Ordering::SeqCst);
            Ok("test-token".to_string())
        }
    }

    fn direct_embedder(endpoint: String, token_requests: Arc<AtomicUsize>) -> VertexAIEmbedder {
        let mut embedder = test_embedder(endpoint, Ok("unused".to_string()));
        embedder.token_source = Arc::new(CountingTokenSource(token_requests));
        embedder
    }

    fn direct_runtime(dir: &std::path::Path, daily_token_limit: u64) -> CoreDirectVertexRuntime {
        CoreDirectVertexRuntime {
            journal: CoreUsageJournal::open(dir.join("direct.sqlite"))
                .expect("test journal failed"),
            workspace_id: DIRECT_WORKSPACE.to_string(),
            daily_token_limit,
        }
    }

    fn attempt_rows(dir: &std::path::Path) -> i64 {
        rusqlite::Connection::open(dir.join("direct.sqlite"))
            .expect("test journal connection failed")
            .query_row("SELECT count(*) FROM dust_usage_attempts", [], |row| {
                row.get(0)
            })
            .expect("test count failed")
    }

    fn verified_workspace(sid: &str) -> VerifiedWorkspace {
        use crate::workspace_assertion::{verify, DataSourcePair, TEST_SECRET_LOCK};
        let secret = "isolated-dust-core-direct-test-secret-long-enough";
        let pair = DataSourcePair {
            project_id: 1,
            data_source_id: "data-source-1".into(),
        };
        let now = chrono::Utc::now().timestamp();
        let claims = json!({
            "aud": "dust-core-vertex-embedding", "iat": now,
            "exp": now + 60, "workspace_sid": sid,
            "data_sources": [pair.clone()]
        });
        let _guard = TEST_SECRET_LOCK.lock().expect("test assertion secret lock");
        std::env::set_var("DUST_CORE_WORKSPACE_ASSERTION_SECRET", secret);
        let token = jsonwebtoken::encode(
            &jsonwebtoken::Header::new(jsonwebtoken::Algorithm::HS256),
            &claims,
            &jsonwebtoken::EncodingKey::from_secret(secret.as_bytes()),
        )
        .expect("test token failed");
        verify(Some(&token), &[pair]).expect("test workspace assertion failed")
    }

    /// One loopback response to a Vertex embedding request.
    #[derive(Clone, Copy)]
    enum Reply {
        /// A valid embedding reporting this many prompt tokens.
        Embedding(u64),
        /// A complete response with this status and a small error body.
        Status(u16),
        /// This status, with the connection closed before the declared body ends.
        TruncatedStatus(u16),
        /// The connection closed without any response.
        Drop,
    }

    /// Answers the Nth request with `replies[N]`, the last one repeating, and
    /// counts requests. Each response closes its connection.
    async fn scripted_server(
        replies: Vec<Reply>,
    ) -> (String, Arc<AtomicUsize>, tokio::task::JoinHandle<()>) {
        let listener = TcpListener::bind("127.0.0.1:0")
            .await
            .expect("test operation failed");
        let address = listener.local_addr().expect("test operation failed");
        let requests = Arc::new(AtomicUsize::new(0));
        let counter = requests.clone();
        let server = tokio::spawn(async move {
            loop {
                let (mut socket, _) = listener.accept().await.expect("test operation failed");
                let mut request = Vec::new();
                loop {
                    let mut chunk = [0u8; 4096];
                    let read = socket
                        .read(&mut chunk)
                        .await
                        .expect("test operation failed");
                    assert!(read > 0);
                    request.extend_from_slice(&chunk[..read]);
                    let Some(header_end) =
                        request.windows(4).position(|window| window == b"\r\n\r\n")
                    else {
                        continue;
                    };
                    let headers = String::from_utf8_lossy(&request[..header_end]);
                    let length = headers
                        .lines()
                        .find_map(|line| {
                            line.to_ascii_lowercase()
                                .strip_prefix("content-length: ")
                                .and_then(|value| value.parse::<usize>().ok())
                        })
                        .expect("test operation failed");
                    if request.len() >= header_end + 4 + length {
                        break;
                    }
                }
                let index = counter.fetch_add(1, Ordering::SeqCst);
                let reply = replies[index.min(replies.len() - 1)];
                let response = match reply {
                    Reply::Embedding(prompt_token_count) => {
                        let body = json!({"embedding":{"values":vec![0.5;DIMENSIONS]},"usageMetadata":{"promptTokenCount":prompt_token_count}}).to_string();
                        format!("HTTP/1.1 200 OK\r\ncontent-type: application/json\r\nconnection: close\r\ncontent-length: {}\r\n\r\n{}", body.len(), body)
                    }
                    Reply::Status(status) => {
                        let body = r#"{"error":{"status":"provider-detail"}}"#;
                        format!("HTTP/1.1 {status} Error\r\nx-goog-request-id: req-{status}\r\ncontent-type: application/json\r\nconnection: close\r\ncontent-length: {}\r\n\r\n{body}", body.len())
                    }
                    Reply::TruncatedStatus(status) => format!(
                        "HTTP/1.1 {status} Error\r\nconnection: close\r\ncontent-length: 100\r\n\r\n{{\"error\""
                    ),
                    Reply::Drop => String::new(),
                };
                socket
                    .write_all(response.as_bytes())
                    .await
                    .expect("test operation failed");
            }
        });
        (format!("http://{address}/embed"), requests, server)
    }

    /// Answers every request with a valid embedding and counts requests.
    async fn embedding_server(
        prompt_token_count: u64,
    ) -> (String, Arc<AtomicUsize>, tokio::task::JoinHandle<()>) {
        scripted_server(vec![Reply::Embedding(prompt_token_count)]).await
    }

    /// `(state, no_charge_evidence_ref, route_id)` of each attempt, oldest first.
    fn attempt_states(path: &std::path::Path) -> Vec<(String, Option<String>, String)> {
        let conn = rusqlite::Connection::open(path).expect("test journal connection failed");
        let mut statement = conn
            .prepare(
                "SELECT state, no_charge_evidence_ref, route_id FROM dust_usage_attempts
                 ORDER BY created_at_ms, rowid",
            )
            .expect("test query failed");
        let rows = statement
            .query_map([], |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)))
            .expect("test query failed")
            .collect::<rusqlite::Result<Vec<_>>>()
            .expect("test rows failed");
        rows
    }

    fn input_reservations(path: &std::path::Path) -> i64 {
        rusqlite::Connection::open(path)
            .expect("test journal connection failed")
            .query_row("SELECT count(*) FROM dust_embedding_results", [], |row| {
                row.get(0)
            })
            .expect("test count failed")
    }

    #[tokio::test]
    async fn direct_rejection_settles_no_charge_and_a_retry_starts_a_new_attempt() {
        for status in [400, 429] {
            let dir = tempfile::tempdir().expect("test operation failed");
            let journal_path = dir.path().join("direct.sqlite");
            // One unsettled attempt would hold the whole daily limit.
            let runtime = direct_runtime(dir.path(), DIRECT_EMBEDDING_RESERVATION_TOKENS);
            let (endpoint, provider_requests, server) =
                scripted_server(vec![Reply::Status(status), Reply::Embedding(11)]).await;
            let embedder = direct_embedder(endpoint, Arc::new(AtomicUsize::new(0)));
            let workspace = verified_workspace(DIRECT_WORKSPACE);
            let extras = Some(json!({"dust_poc_upsert_key": "document-a:version-1"}));
            let embed = || {
                embedder.embed_direct(
                    &runtime,
                    vec!["chunk over Gemini's token limit"],
                    EmbeddingTaskType::RetrievalDocument,
                    extras.clone(),
                    &workspace,
                )
            };
            let error = embed().await.expect_err("Vertex rejected the input");
            assert!(error.downcast_ref::<AmbiguousVertexEffect>().is_none());
            assert_eq!(
                error
                    .downcast_ref::<VertexRejectedRequest>()
                    .map(|rejection| rejection.status),
                Some(status)
            );
            assert_eq!(provider_requests.load(Ordering::SeqCst), 1);
            assert_eq!(
                attempt_states(&journal_path),
                vec![(
                    "no_charge".to_string(),
                    Some(format!("vertex:rejected:{status}:req-{status}")),
                    DIRECT_POC_ROUTE_ID.to_string()
                )]
            );
            assert_eq!(input_reservations(&journal_path), 0);

            let retried = embed().await.expect("a retry starts a new attempt");
            assert_eq!(retried[0].vector, vec![0.5; DIMENSIONS]);
            assert_eq!(provider_requests.load(Ordering::SeqCst), 2);
            let states = attempt_states(&journal_path);
            assert_eq!(
                states
                    .iter()
                    .map(|(state, _, _)| state.as_str())
                    .collect::<Vec<_>>(),
                vec!["no_charge", "exact"]
            );
            assert_eq!(input_reservations(&journal_path), 1);
            server.abort();
        }
    }

    #[tokio::test]
    async fn direct_ambiguous_failures_keep_the_reservation_without_another_call() {
        for reply in [
            Reply::Status(500),
            Reply::Status(503),
            Reply::Status(307),
            Reply::TruncatedStatus(400),
            Reply::Drop,
        ] {
            let dir = tempfile::tempdir().expect("test operation failed");
            let journal_path = dir.path().join("direct.sqlite");
            let runtime = direct_runtime(dir.path(), 500_000);
            let (endpoint, provider_requests, server) =
                scripted_server(vec![reply, Reply::Embedding(11)]).await;
            let embedder = direct_embedder(endpoint, Arc::new(AtomicUsize::new(0)));
            let workspace = verified_workspace(DIRECT_WORKSPACE);
            let extras = Some(json!({"dust_poc_upsert_key": "document-a:version-1"}));
            for _ in 0..2 {
                let error = embedder
                    .embed_direct(
                        &runtime,
                        vec!["chunk"],
                        EmbeddingTaskType::RetrievalDocument,
                        extras.clone(),
                        &workspace,
                    )
                    .await
                    .expect_err("an unproven outcome stays ambiguous");
                assert!(error.downcast_ref::<AmbiguousVertexEffect>().is_some());
                // The retry finds the reservation and never calls Vertex.
                assert_eq!(provider_requests.load(Ordering::SeqCst), 1);
            }
            assert_eq!(
                attempt_states(&journal_path),
                vec![("unknown".to_string(), None, DIRECT_POC_ROUTE_ID.to_string())]
            );
            assert_eq!(input_reservations(&journal_path), 1);
            server.abort();
        }
    }

    fn signed_route(tenant_id: &str) -> CoreTenantRoute {
        CoreTenantRoute {
            tenant_id: tenant_id.into(),
            workspace_id: "workspace-a".into(),
            private_route: "https://crm-a.internal".into(),
            admission_url: "https://crm-a.internal/internal/usage/dust/admission".into(),
            usage_ingest_url: "https://crm-a.internal/internal/usage/events".into(),
            core_credential_ref: format!(
                "/var/run/secrets/dust/tenants/{tenant_id}/dust-core-usage-key"
            ),
            journal_target: format!("tenant:{tenant_id}:dust-usage"),
            revision: 7,
            key_id: "pin-a".into(),
        }
    }

    /// One signed attempt for `input_hash` that sends a document chunk to
    /// `endpoint` with the production client, which follows no redirect.
    async fn signed_loopback_attempt(
        journal: &CoreUsageJournal,
        route: &CoreTenantRoute,
        endpoint: &str,
        input_hash: [u8; 32],
    ) -> Result<VertexEmbeddingResponse> {
        run_guarded_attempt(
            journal,
            route,
            MODEL_ID,
            "embedding:workspace-a",
            Some(input_hash),
            AttemptStart::Signed,
            |_, _, _| async { Ok(()) },
            |_| async move {
                VertexAIEmbedder::request_one(
                    &VertexAIEmbedder::new(MODEL_ID.to_owned()).client,
                    endpoint,
                    "test-token",
                    "chunk",
                    EmbeddingTaskType::RetrievalDocument,
                )
                .await
            },
        )
        .await
    }

    #[tokio::test]
    async fn signed_rejection_settles_no_charge_but_a_server_error_stays_unresolved() {
        let dir = tempfile::tempdir().expect("test operation failed");
        let journal_path = dir.path().join("signed.sqlite");
        let journal = CoreUsageJournal::open(&journal_path).expect("test journal failed");
        let route = signed_route("tenant-a");
        let (endpoint, provider_requests, server) = scripted_server(vec![
            Reply::Status(400),
            Reply::Embedding(7),
            Reply::Status(500),
        ])
        .await;
        let rejected = signed_loopback_attempt(&journal, &route, &endpoint, [1; 32])
            .await
            .expect_err("Vertex rejected the input");
        assert!(rejected.downcast_ref::<VertexRejectedRequest>().is_some());
        // A no-charge row owes CRM no delivery, review or unresolved count.
        assert!(journal
            .claim_due("signed-rejection", 100)
            .expect("test claim failed")
            .is_empty());
        assert_eq!(
            journal
                .read_health("tenant-a")
                .expect("test health failed")
                .unresolved_count,
            0
        );
        assert_eq!(input_reservations(&journal_path), 0);

        let retried = signed_loopback_attempt(&journal, &route, &endpoint, [1; 32])
            .await
            .expect("a retry starts a new attempt");
        assert_eq!(retried.vector, vec![0.5; DIMENSIONS]);
        let failed = signed_loopback_attempt(&journal, &route, &endpoint, [2; 32])
            .await
            .expect_err("a server error is ambiguous");
        assert!(failed.downcast_ref::<AmbiguousVertexEffect>().is_some());
        assert_eq!(provider_requests.load(Ordering::SeqCst), 3);
        assert_eq!(
            attempt_states(&journal_path)
                .into_iter()
                .map(|(state, evidence, _)| (state, evidence))
                .collect::<Vec<_>>(),
            vec![
                (
                    "no_charge".to_string(),
                    Some("vertex:rejected:400:req-400".to_string())
                ),
                ("exact".to_string(), None),
                ("unknown".to_string(), None),
            ]
        );
        assert_eq!(
            journal
                .read_health("tenant-a")
                .expect("test health failed")
                .unresolved_count,
            1
        );
        server.abort();
    }

    #[tokio::test]
    async fn signed_attempt_route_stays_numeric_for_the_direct_tenant_id() {
        let dir = tempfile::tempdir().expect("test operation failed");
        let journal_path = dir.path().join("signed.sqlite");
        let journal = CoreUsageJournal::open(&journal_path).expect("test journal failed");
        // An existing signed registry may name a tenant `poc-direct`.
        let route = signed_route(DIRECT_POC_TENANT_ID);
        let (endpoint, _, server) = embedding_server(7).await;
        signed_loopback_attempt(&journal, &route, &endpoint, [3; 32])
            .await
            .expect("signed attempt of the poc-direct tenant");
        let claims = journal
            .claim_due("signed-direct-tenant", 100)
            .expect("test claim failed");
        assert_eq!(claims.len(), 1);
        assert_eq!(
            (claims[0].state.as_str(), claims[0].route_id.as_str()),
            ("exact", "poc-direct:7")
        );
        assert_ne!(claims[0].route_id, DIRECT_POC_ROUTE_ID);
        server.abort();
    }

    #[test]
    fn direct_provider_mode_accepts_only_unset_zero_or_one() {
        use std::env::VarError;
        assert!(!direct_provider_mode(Err(VarError::NotPresent)).expect("unset mode"));
        assert!(!direct_provider_mode(Ok("0".into())).expect("disabled mode"));
        assert!(direct_provider_mode(Ok("1".into())).expect("enabled mode"));
        for value in ["", "true", "on", "2", "01", " 1", "1 "] {
            assert!(direct_provider_mode(Ok(value.into())).is_err());
        }
        assert!(direct_provider_mode(Err(VarError::NotUnicode("1".into()))).is_err());
    }

    #[test]
    fn direct_runtime_configuration_fails_closed_before_opening_the_journal() {
        let dir = tempfile::tempdir().expect("test operation failed");
        let path = |name: &str| dir.path().join(name).display().to_string();
        let build = |overrides: &[(&str, Option<&str>)], journal: String| {
            let mut env = HashMap::from([
                ("DUST_POC_DIRECT_WORKSPACE_ID", DIRECT_WORKSPACE.to_string()),
                (
                    "DUST_CORE_DIRECT_EMBEDDING_DAILY_TOKEN_LIMIT",
                    "500000".to_string(),
                ),
                ("DUST_CORE_USAGE_JOURNAL_PATH", journal),
            ]);
            for (name, value) in overrides {
                match value {
                    Some(value) => env.insert(name, value.to_string()),
                    None => env.remove(name),
                };
            }
            CoreDirectVertexRuntime::from_lookup(|name| env.get(name).cloned())
        };
        // No signed registry variable or DUST_POC_WORKSPACE_IDS is supplied.
        let runtime = build(&[], path("valid.sqlite")).expect("valid direct configuration");
        assert_eq!(
            (runtime.workspace_id.as_str(), runtime.daily_token_limit),
            (DIRECT_WORKSPACE, 500_000)
        );
        let longest = "w".repeat(128);
        for valid in [
            ("DUST_POC_DIRECT_WORKSPACE_ID", longest.as_str()),
            ("DUST_CORE_DIRECT_EMBEDDING_DAILY_TOKEN_LIMIT", "8192"),
            ("DUST_CORE_DIRECT_EMBEDDING_DAILY_TOKEN_LIMIT", "1000000000"),
        ] {
            assert!(build(&[(valid.0, Some(valid.1))], path("valid.sqlite")).is_ok());
        }

        let too_long = "w".repeat(129);
        let refused = dir.path().join("refused.sqlite");
        for invalid in [
            ("DUST_POC_DIRECT_WORKSPACE_ID", None),
            ("DUST_POC_DIRECT_WORKSPACE_ID", Some("")),
            ("DUST_POC_DIRECT_WORKSPACE_ID", Some("workspace a")),
            ("DUST_POC_DIRECT_WORKSPACE_ID", Some("workspace/a")),
            ("DUST_POC_DIRECT_WORKSPACE_ID", Some("wörkspace")),
            ("DUST_POC_DIRECT_WORKSPACE_ID", Some(too_long.as_str())),
            ("DUST_CORE_DIRECT_EMBEDDING_DAILY_TOKEN_LIMIT", None),
            ("DUST_CORE_DIRECT_EMBEDDING_DAILY_TOKEN_LIMIT", Some("")),
            ("DUST_CORE_DIRECT_EMBEDDING_DAILY_TOKEN_LIMIT", Some("8191")),
            (
                "DUST_CORE_DIRECT_EMBEDDING_DAILY_TOKEN_LIMIT",
                Some("1000000001"),
            ),
            (
                "DUST_CORE_DIRECT_EMBEDDING_DAILY_TOKEN_LIMIT",
                Some("+500000"),
            ),
            (
                "DUST_CORE_DIRECT_EMBEDDING_DAILY_TOKEN_LIMIT",
                Some(" 500000"),
            ),
            (
                "DUST_CORE_DIRECT_EMBEDDING_DAILY_TOKEN_LIMIT",
                Some("500000.0"),
            ),
            ("DUST_CORE_DIRECT_EMBEDDING_DAILY_TOKEN_LIMIT", Some("-1")),
            (
                "DUST_CORE_DIRECT_EMBEDDING_DAILY_TOKEN_LIMIT",
                Some("99999999999999999999999"),
            ),
            ("DUST_CORE_USAGE_JOURNAL_PATH", None),
            ("DUST_CORE_USAGE_JOURNAL_PATH", Some("")),
            (
                "DUST_CORE_USAGE_JOURNAL_PATH",
                Some("direct-relative.sqlite"),
            ),
        ] {
            assert!(
                build(&[invalid], refused.display().to_string()).is_err(),
                "{invalid:?} must fail closed"
            );
            assert!(!refused.exists(), "{invalid:?} opened the journal");
        }
    }

    #[tokio::test]
    async fn direct_mode_configuration_errors_refuse_embedding_before_any_io() {
        struct EnvGuard;
        impl Drop for EnvGuard {
            fn drop(&mut self) {
                for name in [
                    "DUST_POC_MODE",
                    "DUST_CORE_VERTEX_PROVIDER_IO_ENABLED",
                    DIRECT_PROVIDER_MODE_ENV,
                ] {
                    std::env::remove_var(name);
                }
            }
        }
        let workspace = verified_workspace(DIRECT_WORKSPACE);
        let token_requests = Arc::new(AtomicUsize::new(0));
        let embedder = direct_embedder(
            "http://127.0.0.1:1/unreachable".to_string(),
            token_requests.clone(),
        );
        let _env = EnvGuard;
        for name in [
            "DUST_POC_DIRECT_WORKSPACE_ID",
            "DUST_CORE_DIRECT_EMBEDDING_DAILY_TOKEN_LIMIT",
            "DUST_CORE_USAGE_JOURNAL_PATH",
        ] {
            std::env::remove_var(name);
        }
        std::env::set_var("DUST_POC_MODE", "1");
        std::env::set_var("DUST_CORE_VERTEX_PROVIDER_IO_ENABLED", "1");
        for (mode, expected) in [
            (
                "true",
                "Core Vertex direct provider mode configuration unavailable",
            ),
            (
                "",
                "Core Vertex direct provider mode configuration unavailable",
            ),
            ("1", "Core Vertex direct runtime configuration unavailable"),
        ] {
            std::env::set_var(DIRECT_PROVIDER_MODE_ENV, mode);
            let error = embedder
                .embed_with_workspace(
                    vec!["sensitive"],
                    EmbeddingTaskType::RetrievalQuery,
                    None,
                    Some(&workspace),
                )
                .await
                .expect_err("misconfigured direct mode must fail closed");
            assert_eq!(error.to_string(), expected);
        }
        assert_eq!(token_requests.load(Ordering::SeqCst), 0);
    }

    #[tokio::test]
    async fn direct_mode_refuses_other_workspace_before_journal_write() {
        let dir = tempfile::tempdir().expect("test operation failed");
        let runtime = direct_runtime(dir.path(), 500_000);
        let token_requests = Arc::new(AtomicUsize::new(0));
        let embedder = direct_embedder(
            "http://127.0.0.1:1/unreachable".to_string(),
            token_requests.clone(),
        );
        let error = embedder
            .embed_direct(
                &runtime,
                vec!["sensitive"],
                EmbeddingTaskType::RetrievalQuery,
                None,
                &verified_workspace("workspace-other"),
            )
            .await
            .expect_err("other workspace must be refused");
        assert_eq!(
            error.to_string(),
            "Vertex embedding workspace is not enabled"
        );
        assert_eq!(attempt_rows(dir.path()), 0);
        assert_eq!(token_requests.load(Ordering::SeqCst), 0);
    }

    #[tokio::test]
    async fn direct_over_limit_is_denied_without_a_row_or_provider_io() {
        let dir = tempfile::tempdir().expect("test operation failed");
        let runtime = direct_runtime(dir.path(), DIRECT_EMBEDDING_RESERVATION_TOKENS);
        // An unsettled attempt already holds the whole daily limit.
        let route = direct_poc_route(DIRECT_WORKSPACE);
        let held = CoreUsageAttempt {
            attempt_id: "held-attempt".into(),
            provider_request_id: "held-request".into(),
            tenant_id: route.tenant_id.clone(),
            workspace_id: route.workspace_id.clone(),
            conversation_id: format!("embedding:{DIRECT_WORKSPACE}"),
            route_id: DIRECT_POC_ROUTE_ID.into(),
            model: MODEL_ID.into(),
        };
        assert!(matches!(
            runtime
                .journal
                .start_direct_within_limit(
                    &held,
                    None,
                    utc_day_start_ms(chrono::Utc::now().timestamp_millis()),
                    runtime.daily_token_limit,
                    DIRECT_EMBEDDING_RESERVATION_TOKENS,
                )
                .expect("test start failed"),
            DirectStartOutcome::Created(_)
        ));
        let token_requests = Arc::new(AtomicUsize::new(0));
        let embedder = direct_embedder(
            "http://127.0.0.1:1/unreachable".to_string(),
            token_requests.clone(),
        );
        let error = embedder
            .embed_direct(
                &runtime,
                vec!["query"],
                EmbeddingTaskType::RetrievalQuery,
                None,
                &verified_workspace(DIRECT_WORKSPACE),
            )
            .await
            .expect_err("over-limit input must be denied");
        assert_eq!(
            error.downcast_ref::<AdmissionError>(),
            Some(&AdmissionError::Denied)
        );
        assert_eq!(attempt_rows(dir.path()), 1);
        assert_eq!(token_requests.load(Ordering::SeqCst), 0);
    }

    #[tokio::test]
    async fn direct_success_settles_exact_tokens_and_reuses_the_paid_vector() {
        let dir = tempfile::tempdir().expect("test operation failed");
        let runtime = direct_runtime(dir.path(), 500_000);
        let (endpoint, provider_requests, server) = embedding_server(11).await;
        let token_requests = Arc::new(AtomicUsize::new(0));
        let embedder = direct_embedder(endpoint, token_requests.clone());
        let workspace = verified_workspace(DIRECT_WORKSPACE);
        let extras = Some(json!({"dust_poc_upsert_key": "document-a:version-1"}));
        let first = embedder
            .embed_direct(
                &runtime,
                vec!["repeated chunk", "repeated chunk"],
                EmbeddingTaskType::RetrievalDocument,
                extras.clone(),
                &workspace,
            )
            .await
            .expect("direct embedding failed");
        assert_eq!(first.len(), 2);
        assert_eq!(first[0].vector, vec![0.5; DIMENSIONS]);
        assert_eq!(provider_requests.load(Ordering::SeqCst), 1);
        let settled: (String, String, String, String) =
            rusqlite::Connection::open(dir.path().join("direct.sqlite"))
                .expect("test journal connection failed")
                .query_row(
                    "SELECT tenant_id, route_id, state,
                            json_extract(event_envelope, '$.input_tokens')
                     FROM dust_usage_attempts",
                    [],
                    |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)),
                )
                .expect("test settled row failed");
        assert_eq!(
            settled,
            (
                DIRECT_POC_TENANT_ID.to_string(),
                DIRECT_POC_ROUTE_ID.to_string(),
                "exact".to_string(),
                "11".to_string()
            )
        );

        let second = embedder
            .embed_direct(
                &runtime,
                vec!["repeated chunk"],
                EmbeddingTaskType::RetrievalDocument,
                extras,
                &workspace,
            )
            .await
            .expect("retained direct embedding failed");
        assert_eq!(second[0].vector, first[0].vector);
        assert_eq!(provider_requests.load(Ordering::SeqCst), 1);
        assert_eq!(token_requests.load(Ordering::SeqCst), 1);
        assert_eq!(attempt_rows(dir.path()), 1);
        server.abort();
    }

    #[tokio::test]
    async fn direct_mode_without_signer_does_not_start_the_reconciler() {
        let env = |signer_url: Option<&'static str>| {
            move |name: &str| match (name, signer_url) {
                ("DUST_POC_MODE", _) | (DIRECT_PROVIDER_MODE_ENV, _) => Ok("1".to_string()),
                ("DUST_CORE_REGISTRY_SIGNER_URL", Some(url)) => Ok(url.to_string()),
                _ => Err(std::env::VarError::NotPresent),
            }
        };
        assert!(tokio::time::timeout(
            Duration::from_secs(1),
            run_core_usage_reconciler_with(env(None))
        )
        .await
        .is_ok());
        // With a signer, signed rows still owe delivery, so the loops run.
        assert!(tokio::time::timeout(
            Duration::from_millis(50),
            run_core_usage_reconciler_with(env(Some(
                "https://registry.internal/internal/dust/registry/bundle"
            ))),
        )
        .await
        .is_err());
    }

    #[tokio::test]
    async fn invalid_direct_mode_does_not_start_the_reconciler() {
        use std::env::VarError;
        let env = |mode: Result<&'static str, VarError>, signer_url: Option<&'static str>| {
            move |name: &str| match (name, signer_url) {
                ("DUST_POC_MODE", _) => Ok("1".to_string()),
                (DIRECT_PROVIDER_MODE_ENV, _) => mode.clone().map(str::to_string),
                ("DUST_CORE_REGISTRY_SIGNER_URL", Some(url)) => Ok(url.to_string()),
                _ => Err(VarError::NotPresent),
            }
        };
        let signer_urls = [
            None,
            Some("https://registry.internal/internal/dust/registry/bundle"),
        ];
        for mode in [Ok("true"), Ok(""), Err(VarError::NotUnicode("1".into()))] {
            for signer_url in signer_urls {
                assert!(tokio::time::timeout(
                    Duration::from_secs(1),
                    run_core_usage_reconciler_with(env(mode.clone(), signer_url)),
                )
                .await
                .is_ok());
            }
        }
        // Unset or `0` is signed mode, whose loops run with or without a signer.
        for mode in [Err(VarError::NotPresent), Ok("0")] {
            for signer_url in signer_urls {
                assert!(tokio::time::timeout(
                    Duration::from_millis(50),
                    run_core_usage_reconciler_with(env(mode.clone(), signer_url)),
                )
                .await
                .is_err());
            }
        }
    }

    #[test]
    fn direct_limit_window_starts_at_utc_midnight() {
        use chrono::TimeZone;
        let midnight_ms = chrono::Utc
            .with_ymd_and_hms(2026, 10, 4, 0, 0, 0)
            .single()
            .expect("test time failed")
            .timestamp_millis();
        assert_eq!(utc_day_start_ms(midnight_ms), midnight_ms);
        assert_eq!(utc_day_start_ms(midnight_ms + MS_PER_DAY - 1), midnight_ms);
        assert_eq!(utc_day_start_ms(midnight_ms - 1), midnight_ms - MS_PER_DAY);
    }
}
