use std::fmt;

use crate::cached_request::CachedRequest;
use crate::providers::provider::{provider, with_retryable_back_off, ProviderID};
use crate::run::Credentials;
use crate::workspace_assertion::VerifiedWorkspace;
use anyhow::{anyhow, Result};
use async_trait::async_trait;
use clap::ValueEnum;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use tracing::{error, info};

/// @cc [label:security;backend] embedding-task-is-server-selected
/// The retrieval task is an explicit server-selected input, included in the request cache key;
/// provider-specific extras cannot replace its instruction.
#[derive(Debug, Serialize, Deserialize, PartialEq, Eq, Clone, Copy)]
pub enum EmbeddingTaskType {
    RetrievalDocument,
    RetrievalQuery,
}

impl EmbeddingTaskType {
    pub fn prepare(self, text: &str) -> String {
        match self {
            Self::RetrievalDocument => format!("title: none | text: {text}"),
            Self::RetrievalQuery => format!("task: search result | query: {text}"),
        }
    }
}

#[derive(Debug, Serialize, Deserialize, PartialEq, Clone)]
pub struct EmbedderVector {
    pub created: u64,
    pub provider: String,
    pub model: String,
    pub vector: Vec<f64>,
}

#[async_trait]
pub trait Embedder {
    fn id(&self) -> String;

    async fn initialize(&mut self, credentials: Credentials) -> Result<()>;

    fn context_size(&self) -> usize;
    fn embedding_size(&self) -> usize;

    async fn encode(&self, text: &str) -> Result<Vec<usize>>;
    async fn decode(&self, tokens: Vec<usize>) -> Result<String>;
    async fn tokenize(&self, texts: Vec<String>) -> Result<Vec<Vec<(usize, String)>>>;

    async fn embed(
        &self,
        text: Vec<&str>,
        task_type: EmbeddingTaskType,
        extras: Option<Value>,
    ) -> Result<Vec<EmbedderVector>>;

    /// Vertex implementations can consume verified workspace identity without trusting extras.
    /// Legacy embedders retain their existing behavior.
    async fn embed_with_workspace(
        &self,
        text: Vec<&str>,
        task_type: EmbeddingTaskType,
        extras: Option<Value>,
        _workspace: Option<&VerifiedWorkspace>,
    ) -> Result<Vec<EmbedderVector>> {
        self.embed(text, task_type, extras).await
    }
}

impl CachedRequest for EmbedderRequest {
    /// The version of the cache. This should be incremented whenever the inputs or
    /// outputs of the request are changed, to ensure that the cached data is invalidated.
    const VERSION: i32 = 2;

    const REQUEST_TYPE: &'static str = "embedder";
}

#[derive(Debug, Serialize, Deserialize, PartialEq, Clone)]
pub struct EmbedderRequest {
    hash: String,
    provider_id: ProviderID,
    model_id: String,
    text: Vec<String>,
    task_type: EmbeddingTaskType,
    extras: Option<Value>,
    // Never accept workspace authority through deserialized requests or cache payloads.
    #[serde(skip)]
    verified_workspace: Option<VerifiedWorkspace>,
}

impl EmbedderRequest {
    pub fn new(
        provider_id: ProviderID,
        model_id: &str,
        text: Vec<&str>,
        task_type: EmbeddingTaskType,
        extras: Option<Value>,
    ) -> Self {
        let mut hasher = blake3::Hasher::new();
        hasher.update(provider_id.to_string().as_bytes());
        hasher.update(model_id.as_bytes());
        hasher.update(EmbedderRequest::version().to_string().as_bytes());
        hasher.update(
            serde_json::to_string(&task_type)
                .expect("task type serialization")
                .as_bytes(),
        );

        text.iter().for_each(|s| {
            hasher.update(s.as_bytes());
        });
        if let Some(extra) = &extras {
            hasher.update(extra.to_string().as_bytes());
        }

        Self {
            hash: format!("{}", hasher.finalize().to_hex()),
            provider_id,
            model_id: String::from(model_id),
            text: text.into_iter().map(String::from).collect::<Vec<_>>(),
            task_type,
            extras,
            verified_workspace: None,
        }
    }

    pub fn with_verified_workspace(mut self, workspace: Option<VerifiedWorkspace>) -> Self {
        if let Some(workspace) = workspace.filter(|_| self.provider_id == ProviderID::VertexAI) {
            self.hash = blake3::hash(format!("{}:{}", self.hash, workspace.sid()).as_bytes())
                .to_hex()
                .to_string();
            self.verified_workspace = Some(workspace);
        }
        self
    }

    pub fn verified_workspace_sid(&self) -> Option<&str> {
        self.verified_workspace.as_ref().map(VerifiedWorkspace::sid)
    }

    pub fn hash(&self) -> &str {
        &self.hash
    }

    pub async fn execute(&self, credentials: Credentials) -> Result<Vec<EmbedderVector>> {
        if self.provider_id == ProviderID::VertexAI && self.verified_workspace.is_none() {
            return Err(anyhow!("Vertex embedding requires verified workspace"));
        }
        let mut embedder = provider(self.provider_id).embedder(self.model_id.clone());
        embedder.initialize(credentials).await?;

        let out = with_retryable_back_off(
            || {
                embedder.embed_with_workspace(
                    self.text.iter().map(|s| s.as_str()).collect::<Vec<_>>(),
                    self.task_type,
                    self.extras.clone(),
                    self.verified_workspace.as_ref(),
                )
            },
            |err_msg, sleep, attempts| {
                info!(
                    provider_id = self.provider_id.to_string(),
                    model_id = self.model_id,
                    attempts = attempts,
                    sleep = sleep.as_millis(),
                    err_msg = err_msg,
                    "Retry querying"
                );
            },
            |err| {
                error!(
                    provider_id = self.provider_id.to_string(),
                    model_id = self.model_id,
                    err_msg = err.message,
                    request_id = err.request_id.as_deref().unwrap_or(""),
                    "EmbedderRequest model error",
                );
            },
        )
        .await;

        match out {
            Ok(c) => {
                info!(
                    provider_id = self.provider_id.to_string(),
                    model_id = self.model_id,
                    chunk_count = self.text.len(),
                    total_text_length = self.text.iter().fold(0, |acc, s| acc + s.len()),
                    "Success querying"
                );
                Ok(c)
            }
            Err(e) => Err(anyhow!(
                "Error querying `{}:{}`: error={}",
                self.provider_id.to_string(),
                self.model_id,
                e.to_string(),
            )),
        }
    }

    // pub async fn execute_with_cache(
    //     &self,
    //     credentials: Credentials,
    //     project: Project,
    //     store: Box<dyn Store + Send + Sync>,
    //     use_cache: bool,
    // ) -> Result<EmbedderVector> {
    //     let embedding = {
    //         match use_cache {
    //             false => None,
    //             true => {
    //                 let mut embeddings = store.embedder_cache_get(&project, self).await?;
    //                 match embeddings.len() {
    //                     0 => None,
    //                     _ => Some(embeddings.remove(0)),
    //                 }
    //             }
    //         }
    //     };

    //     match embedding {
    //         Some(embedding) => Ok(embedding),
    //         None => {
    //             let embedding = self.execute(credentials).await?;
    //             store
    //                 .embedder_cache_store(&project, self, &embedding)
    //                 .await?;
    //             Ok(embedding)
    //         }
    //     }
    // }
}

#[derive(Debug, ValueEnum, Clone, PartialEq)]
pub enum SupportedEmbedderModels {
    #[clap(name = "text-embedding-3-large-1536")]
    TextEmbedding3Large1536,
    #[clap(name = "mistral-embed")]
    MistralEmbed,
    #[clap(name = "gemini-embedding-2-1536")]
    GeminiEmbedding21536,
}

impl fmt::Display for SupportedEmbedderModels {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            SupportedEmbedderModels::TextEmbedding3Large1536 => {
                write!(f, "text-embedding-3-large-1536")
            }
            SupportedEmbedderModels::MistralEmbed => {
                write!(f, "mistral-embed")
            }
            SupportedEmbedderModels::GeminiEmbedding21536 => write!(f, "gemini-embedding-2-1536"),
        }
    }
}

// Custom type to map provider to models.
pub struct EmbedderProvidersModelMap;

impl EmbedderProvidersModelMap {
    fn get_models(provider: &ProviderID) -> Result<Vec<SupportedEmbedderModels>> {
        match provider {
            ProviderID::OpenAI => Ok(vec![SupportedEmbedderModels::TextEmbedding3Large1536]),
            ProviderID::Mistral => Ok(vec![SupportedEmbedderModels::MistralEmbed]),
            ProviderID::VertexAI => Ok(vec![SupportedEmbedderModels::GeminiEmbedding21536]),
            _ => Err(anyhow!("Provider not supported for embeddings.")),
        }
    }

    pub fn is_model_supported(provider: &ProviderID, model: &SupportedEmbedderModels) -> bool {
        if let Ok(models) = Self::get_models(provider) {
            models.contains(model)
        } else {
            false
        }
    }
}

#[cfg(test)]
mod vertex_contract_tests {
    use super::*;
    use std::str::FromStr;

    #[tokio::test]
    async fn vertex_request_without_verified_workspace_stops_before_provider_io() {
        let request = EmbedderRequest::new(
            ProviderID::VertexAI,
            "gemini-embedding-2-1536",
            vec!["query"],
            EmbeddingTaskType::RetrievalQuery,
            None,
        );
        let error = request.execute(Credentials::new()).await.unwrap_err();
        assert!(error.to_string().contains("requires verified workspace"));
    }

    #[test]
    fn vertex_model_is_registered_only_for_vertex() {
        let vertex = <ProviderID as FromStr>::from_str("vertex_ai").unwrap();
        let model = SupportedEmbedderModels::GeminiEmbedding21536;
        assert!(EmbedderProvidersModelMap::is_model_supported(
            &vertex, &model
        ));
        assert!(!EmbedderProvidersModelMap::is_model_supported(
            &ProviderID::OpenAI,
            &model
        ));
        assert_eq!(model.to_string(), "gemini-embedding-2-1536");
    }

    #[test]
    fn document_and_query_tasks_have_distinct_cache_keys() {
        let document = EmbedderRequest::new(
            ProviderID::VertexAI,
            "gemini-embedding-2-1536",
            vec!["same text"],
            EmbeddingTaskType::RetrievalDocument,
            None,
        );
        let query = EmbedderRequest::new(
            ProviderID::VertexAI,
            "gemini-embedding-2-1536",
            vec!["same text"],
            EmbeddingTaskType::RetrievalQuery,
            None,
        );
        assert_ne!(document.hash(), query.hash());
    }
}
