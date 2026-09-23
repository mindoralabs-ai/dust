use crate::providers::chat_messages::ChatMessage;
use crate::providers::embedder::{Embedder, EmbedderVector, EmbeddingTaskType};
use crate::providers::llm::{
    ChatFunction, LLMChatGeneration, LLMGeneration, TokenizerSingleton, LLM,
};
use crate::providers::provider::{ModelError, ModelErrorRetryOptions, Provider, ProviderID};
use crate::providers::tiktoken::tiktoken::{
    batch_tokenize_async, cl100k_base_singleton, decode_async, encode_async,
};
use crate::quota_admission::CoreAdmissionClient;
use crate::run::Credentials;
use crate::tenant_route::{
    CoreTenantRoute, CoreTenantRouteResolver, HttpBundleFetcher, PinnedVerifier,
};
use crate::usage_delivery::CoreUsageDeliveryClient;
use crate::usage_journal::{
    CoreUsageAttempt, CoreUsageJournal, EmbeddingUsage, PaidEmbeddingRecoveryRequired, StartOutcome,
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

/// @cc [label:security;backend] dust-core-reconciler-no-model-effect
/// This loop may deliver durable accounting while provider I/O is disabled.
/// A failed delivery never retries an embedding request.
pub async fn run_core_usage_reconciler() {
    if std::env::var("DUST_POC_MODE").as_deref() != Ok("1") {
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

/// @cc [label:security;backend] vertex-embedding-attempt-accounting
/// A unique, durable attempt and tenant-bound admission precede each provider
/// request. A response is returned only after exact provider usage is frozen;
/// ambiguous or incomplete responses remain unresolved, never no-charge.
async fn run_guarded_attempt<A, AFut, P, PFut>(
    journal: &CoreUsageJournal,
    route: &CoreTenantRoute,
    model: &str,
    conversation_id: &str,
    input_hash: Option<[u8; 32]>,
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
    let attempt = CoreUsageAttempt {
        attempt_id: uuid::Uuid::new_v4().to_string(),
        provider_request_id: uuid::Uuid::new_v4().to_string(),
        tenant_id: route.tenant_id.clone(),
        workspace_id: route.workspace_id.clone(),
        conversation_id: conversation_id.to_string(),
        route_id: format!("{}:{}", route.tenant_id, route.revision),
        model: model.to_string(),
    };
    let started = match input_hash.as_ref() {
        Some(hash) => journal.start_embedding(&attempt, hash)?,
        None => journal.start(&attempt)?,
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
            let operation_id = error
                .downcast_ref::<ModelError>()
                .and_then(|provider_error| provider_error.request_id.as_deref());
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
/// Public embedding, including the typed workspace path, must fail before obtaining ADC or
/// sending a provider request until a trusted workspace route, fresh CRM admission and durable
/// attempt journal are integrated.
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
        if !status.is_success() {
            let retryable = if status.as_u16() == 429 || status.is_server_error() {
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
        8192
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
    /// Each distinct document input is resolved from a verified workspace,
    /// durably journaled, and admitted before one provider dispatch. Repeated
    /// positions in the same batch reuse that vector without another paid call.
    /// Query inputs keep one attempt per position.
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
        let runtime = core_vertex_runtime()?;
        if !runtime.workspaces.iter().any(|id| id == workspace.sid()) {
            return Err(anyhow!("Vertex embedding workspace is not enabled"));
        }
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
        let (owned_inputs, positions) = if task_type == EmbeddingTaskType::RetrievalDocument {
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
        let results = collect_guarded_embeddings(owned_inputs, |input| {
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
                    if let Some(vector) =
                        runtime.journal.cached_embedding(&hash).map_err(|error| {
                            if error
                                .downcast_ref::<PaidEmbeddingRecoveryRequired>()
                                .is_some()
                            {
                                anyhow!(AmbiguousVertexEffect)
                            } else {
                                error
                            }
                        })?
                    {
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
                        let token =
                            tokio::time::timeout(Duration::from_secs(30), token_source.token())
                                .await
                                .map_err(|_| anyhow!(PreDispatchTokenError))?
                                .map_err(|_| anyhow!(PreDispatchTokenError))?;
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
        let unique_vectors = finish_embedding_batch(results, &self.id)?;
        Ok(positions
            .into_iter()
            .map(|index| unique_vectors[index].clone())
            .collect())
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
        let throttled = run_guarded_attempt(
            &journal,
            &route,
            MODEL_ID,
            "embedding-test",
            None,
            |_, _, _| async { Ok(()) },
            |_| async {
                provider_calls.fetch_add(1, Ordering::SeqCst);
                Err(anyhow!(ModelError {
                    message: "Vertex embedding HTTP status 429".into(),
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
        assert!(throttled
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
    async fn retryable_status_sanitizes_request_id_and_hides_provider_body() {
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
        let model_error = error
            .downcast_ref::<ModelError>()
            .expect("test operation failed");
        assert!(model_error.retryable.is_some());
        assert_eq!(model_error.request_id.as_deref(), Some("abc-123"));
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
            let model_error = error
                .downcast_ref::<ModelError>()
                .expect("test operation failed");
            assert_eq!(model_error.retryable.is_some(), status == 500);
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
}
