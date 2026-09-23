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
use crate::usage_journal::{CoreUsageAttempt, CoreUsageJournal, EmbeddingUsage, StartOutcome};
use crate::workspace_assertion::VerifiedWorkspace;
use anyhow::{anyhow, Result};
use async_trait::async_trait;
use futures::{stream, StreamExt};
use serde_json::{json, Value};
use std::future::Future;
use std::path::PathBuf;
use std::sync::Arc;
use std::sync::OnceLock;
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
}

static CORE_VERTEX_RUNTIME: OnceLock<Result<CoreVertexRuntime, String>> = OnceLock::new();

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
        if !export_key.is_absolute() || !journal_path.is_absolute() {
            return Err(anyhow!("Core Vertex runtime configuration unavailable"));
        }
        let fetcher = HttpBundleFetcher::new(&signer_url, export_key)?;
        let pin = PinnedVerifier::from_base64(key_id, &public_key)?;
        Ok(Self {
            resolver: CoreTenantRouteResolver::new(fetcher, vec![pin], minimum_revision)?,
            journal: CoreUsageJournal::open(journal_path)?,
            admission: CoreAdmissionClient::new()?,
        })
    }
}

fn core_vertex_runtime() -> Result<&'static CoreVertexRuntime> {
    let runtime = CORE_VERTEX_RUNTIME.get_or_init(|| {
        CoreVertexRuntime::from_environment()
            .map_err(|_| "Core Vertex runtime configuration unavailable".to_string())
    });
    runtime
        .as_ref()
        .map_err(|_| anyhow!("Core Vertex runtime configuration unavailable"))
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
    admit: A,
    provider: P,
) -> Result<VertexEmbeddingResponse>
where
    A: FnOnce(CoreTenantRoute, CoreUsageAttempt, StartOutcome) -> AFut,
    AFut: Future<Output = Result<()>>,
    P: FnOnce() -> PFut,
    PFut: Future<Output = Result<VertexEmbeddingResponse>>,
{
    if model != MODEL_ID || route.revision == 0 {
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
    let started = journal.start(&attempt)?;
    if started != StartOutcome::Created {
        return Err(anyhow!("Vertex embedding attempt was not new"));
    }
    if admit(route.clone(), attempt.clone(), started)
        .await
        .is_err()
    {
        journal.settle_no_charge(
            &attempt.attempt_id,
            &format!("predispatch:admission-failed:{}", attempt.attempt_id),
        )?;
        return Err(anyhow!("Vertex embedding quota admission unavailable"));
    }
    let response = match provider().await {
        Ok(response) => response,
        Err(_) => {
            journal.mark_unknown(&attempt.attempt_id)?;
            return Err(anyhow!("Vertex embedding provider result unavailable"));
        }
    };
    let usage = response
        .usage_metadata
        .get("promptTokenCount")
        .and_then(Value::as_u64)
        .filter(|count| (1..=2_147_483_647).contains(count));
    if response.vector.len() != DIMENSIONS
        || response.vector.iter().any(|value| !value.is_finite())
        || usage.is_none()
    {
        journal.mark_unknown(&attempt.attempt_id)?;
        return Err(anyhow!("Vertex embedding response or usage unavailable"));
    }
    // embedContent has no provider operation ID in its documented response.
    // The unique client request ID remains the stable local dedup identity.
    journal.settle_exact(
        &attempt,
        &format!("client:{}", attempt.provider_request_id),
        EmbeddingUsage {
            input_tokens: usage.unwrap() as u32,
        },
    )?;
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
            .map(|value| value.as_f64().filter(|v| v.is_finite()))
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
                request_id: if request_id.is_empty() {
                    None
                } else {
                    Some(request_id)
                },
            }
            .into());
        }
        let payload: Value = response
            .json()
            .await
            .map_err(|_| anyhow!("Vertex embedding response JSON is invalid"))?;
        Self::parse_response(payload)
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
    /// Each input is resolved from a verified workspace, durably journaled,
    /// and admitted for its tenant before exactly one provider dispatch.
    async fn embed_with_workspace(
        &self,
        text: Vec<&str>,
        task_type: EmbeddingTaskType,
        _extras: Option<Value>,
        workspace: Option<&VerifiedWorkspace>,
    ) -> Result<Vec<EmbedderVector>> {
        let workspace = workspace
            .filter(|workspace| !workspace.sid().is_empty())
            .ok_or_else(|| anyhow!("Vertex embedding requires verified workspace"))?;
        if std::env::var("DUST_CORE_VERTEX_PROVIDER_IO_ENABLED").as_deref() != Ok("1") {
            return Err(anyhow!("Vertex embedding provider I/O is disabled"));
        }
        let runtime = core_vertex_runtime()?;
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
        let results = stream::iter(owned_inputs.into_iter().map(|input| {
            let token_source = self.token_source.clone();
            let endpoint = endpoint.clone();
            let client = self.client.clone();
            async move {
                let route = runtime.resolver.resolve(workspace).await?;
                run_guarded_attempt(
                    &runtime.journal,
                    &route,
                    &self.id,
                    &format!("embedding:{}", workspace.sid()),
                    |route, attempt, started| async move {
                        runtime
                            .admission
                            .require_admission(&route, &attempt, started)
                            .await
                            .map_err(|_| anyhow!("Vertex embedding quota admission unavailable"))?;
                        let current = runtime.resolver.resolve(workspace).await?;
                        if current != route {
                            return Err(anyhow!("Vertex embedding route changed before dispatch"));
                        }
                        Ok(())
                    },
                    || async move {
                        // ADC is downstream of the per-attempt journal and CRM
                        // admission. A denied tenant must not request a token.
                        let token = token_source.token().await?;
                        Self::request_one(&client, &endpoint, &token, &input, task_type).await
                    },
                )
                .await
            }
        }))
        .buffered(MAX_CONCURRENT_REQUESTS)
        .collect::<Vec<_>>()
        .await;
        results
            .into_iter()
            .map(|result| {
                result.map(|response| EmbedderVector {
                    created: crate::utils::now(),
                    provider: ProviderID::VertexAI.to_string(),
                    model: self.id.clone(),
                    vector: response.vector,
                })
            })
            .collect()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicUsize, Ordering};
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    use tokio::net::TcpListener;

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
            document.pointer("/content/parts/0/text").unwrap(),
            "title: none | text: sample"
        );
        assert_eq!(
            query.pointer("/content/parts/0/text").unwrap(),
            "task: search result | query: sample"
        );
        assert_eq!(
            query
                .pointer("/embedContentConfig/outputDimensionality")
                .unwrap(),
            DIMENSIONS
        );
        assert_eq!(
            query.pointer("/embedContentConfig/autoTruncate").unwrap(),
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
                .unwrap()
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
            .unwrap()
            .remove("usageMetadata");
        assert!(VertexAIEmbedder::parse_response(missing_usage).is_err());
        let mut truncated = response;
        truncated["truncated"] = json!(true);
        assert!(VertexAIEmbedder::parse_response(truncated).is_err());
        let without_false_field = json!({"embedding": {"values": vec![0.25; DIMENSIONS]}, "usageMetadata": {"promptTokenCount": 7}});
        assert!(VertexAIEmbedder::parse_response(without_false_field).is_ok());
        for invalid_value in [json!("NaN"), json!(null)] {
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
        let dir = tempdir().unwrap();
        let journal =
            crate::usage_journal::CoreUsageJournal::open(dir.path().join("usage.sqlite")).unwrap();
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
        let provider_calls = AtomicUsize::new(0);
        let denied = run_guarded_attempt(
            &journal,
            &route,
            MODEL_ID,
            "embedding-test",
            |_, _, _| async { Err(anyhow!("quota denied")) },
            || async {
                provider_calls.fetch_add(1, Ordering::SeqCst);
                unreachable!()
            },
        )
        .await;
        assert!(denied.is_err());
        assert_eq!(provider_calls.load(Ordering::SeqCst), 0);

        let response = run_guarded_attempt(
            &journal,
            &route,
            MODEL_ID,
            "embedding-test",
            |_, _, started| async move {
                assert_eq!(started, crate::usage_journal::StartOutcome::Created);
                Ok(())
            },
            || async {
                provider_calls.fetch_add(1, Ordering::SeqCst);
                Ok(VertexEmbeddingResponse {
                    vector: vec![0.25; DIMENSIONS],
                    usage_metadata: json!({"promptTokenCount": 7}),
                })
            },
        )
        .await
        .unwrap();
        assert_eq!(response.vector.len(), DIMENSIONS);
        assert_eq!(provider_calls.load(Ordering::SeqCst), 1);
        let exact = journal.claim_due("reconciler", 20).unwrap();
        assert_eq!(exact.len(), 1);
        assert_eq!(exact[0].state, "exact");
        assert!(exact[0]
            .event_envelope
            .as_ref()
            .unwrap()
            .contains("\"input_tokens\":\"7\""));

        let ambiguous = run_guarded_attempt(
            &journal,
            &route,
            MODEL_ID,
            "embedding-test",
            |_, _, _| async { Ok(()) },
            || async { Err(anyhow!("transport timeout")) },
        )
        .await;
        assert!(ambiguous.is_err());
        let unresolved = journal.claim_due("reconciler2", 20).unwrap();
        assert_eq!(unresolved.len(), 1);
        assert_eq!(unresolved[0].state, "unknown");
        assert!(unresolved[0].event_envelope.is_none());
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
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let server = tokio::spawn(async move {
            let (mut socket, _) = listener.accept().await.unwrap();
            let mut request = Vec::new();
            loop {
                let mut chunk = [0u8; 4096];
                let read = socket.read(&mut chunk).await.unwrap();
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
                    .unwrap();
                if request.len() >= header_end + 4 + content_length {
                    break;
                }
            }
            let request = String::from_utf8(request).unwrap();
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
            socket.write_all(response.as_bytes()).await.unwrap();
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
        .unwrap();
        assert_eq!(result.vector.len(), DIMENSIONS);
        assert_eq!(result.usage_metadata["promptTokenCount"], 4);
        server.await.unwrap();
    }

    #[tokio::test]
    async fn retryable_status_sanitizes_request_id_and_hides_provider_body() {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let server = tokio::spawn(async move {
            let (mut socket, _) = listener.accept().await.unwrap();
            let mut buffer = [0u8; 4096];
            let _ = socket.read(&mut buffer).await.unwrap();
            socket.write_all(b"HTTP/1.1 429 Too Many Requests\r\nx-goog-request-id: abc-123\r\ncontent-length: 15\r\n\r\nprivate-payload").await.unwrap();
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
        let model_error = error.downcast_ref::<ModelError>().unwrap();
        assert!(model_error.retryable.is_some());
        assert_eq!(model_error.request_id.as_deref(), Some("abc-123"));
        let message = error.to_string();
        assert!(!message.contains("private-payload"));
        assert!(!message.contains("secret-token"));
        assert!(!message.contains("sensitive-input"));
        server.await.unwrap();
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
            let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
            let address = listener.local_addr().unwrap();
            let server = tokio::spawn(async move {
                let (mut socket, _) = listener.accept().await.unwrap();
                let mut buffer = [0u8; 4096];
                let _ = socket.read(&mut buffer).await.unwrap();
                let body = "secret-provider-error";
                let response = format!(
                    "HTTP/1.1 {status} Rejected\r\ncontent-length: {}\r\n\r\n{body}",
                    body.len()
                );
                socket.write_all(response.as_bytes()).await.unwrap();
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
            let model_error = error.downcast_ref::<ModelError>().unwrap();
            assert_eq!(model_error.retryable.is_some(), status == 500);
            assert!(!error.to_string().contains("secret"));
            server.await.unwrap();
        }

        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let server = tokio::spawn(async move {
            let (mut socket, _) = listener.accept().await.unwrap();
            let mut buffer = [0u8; 4096];
            let _ = socket.read(&mut buffer).await.unwrap();
            tokio::time::sleep(Duration::from_millis(100)).await;
        });
        let client = reqwest::Client::builder()
            .timeout(Duration::from_millis(10))
            .build()
            .unwrap();
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
        server.await.unwrap();
    }

    #[tokio::test]
    async fn private_batch_preserves_order_and_bounds_concurrency() {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let active = Arc::new(AtomicUsize::new(0));
        let maximum = Arc::new(AtomicUsize::new(0));
        let server = {
            let active = active.clone();
            let maximum = maximum.clone();
            tokio::spawn(async move {
                for _ in 0..12 {
                    let (mut socket, _) = listener.accept().await.unwrap();
                    let active = active.clone();
                    let maximum = maximum.clone();
                    tokio::spawn(async move {
                        let mut request = Vec::new();
                        loop {
                            let mut chunk = [0u8; 4096];
                            let read = socket.read(&mut chunk).await.unwrap();
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
                                .unwrap();
                            if request.len() >= header_end + 4 + length {
                                break;
                            }
                        }
                        let body_start = request
                            .windows(4)
                            .position(|window| window == b"\r\n\r\n")
                            .unwrap()
                            + 4;
                        let body: Value = serde_json::from_slice(&request[body_start..]).unwrap();
                        let input = body
                            .pointer("/content/parts/0/text")
                            .unwrap()
                            .as_str()
                            .unwrap();
                        let index: usize =
                            input.rsplit(':').next().unwrap().trim().parse().unwrap();
                        let concurrent = active.fetch_add(1, Ordering::SeqCst) + 1;
                        maximum.fetch_max(concurrent, Ordering::SeqCst);
                        tokio::time::sleep(Duration::from_millis(30)).await;
                        active.fetch_sub(1, Ordering::SeqCst);
                        let body = json!({"embedding":{"values":vec![index as f64; DIMENSIONS]},"usageMetadata":{"promptTokenCount":1}}).to_string();
                        let response = format!("HTTP/1.1 200 OK\r\ncontent-type: application/json\r\ncontent-length: {}\r\n\r\n{}", body.len(), body);
                        socket.write_all(response.as_bytes()).await.unwrap();
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
        .unwrap()
        .unwrap();
        for (index, result) in results.iter().enumerate() {
            assert_eq!(result.vector[0], index as f64);
        }
        assert!(maximum.load(Ordering::SeqCst) <= MAX_CONCURRENT_REQUESTS);
        assert!(maximum.load(Ordering::SeqCst) > 1);
        server.await.unwrap();
    }
}
