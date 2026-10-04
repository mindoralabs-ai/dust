use crate::providers::anthropic::anthropic::AnthropicProvider;
use crate::providers::azure_openai::AzureOpenAIProvider;
use crate::providers::embedder::Embedder;
use crate::providers::google_ai_studio::GoogleAiStudioProvider;
use crate::providers::llm::{TokenizerSingleton, LLM};
use crate::providers::mistral::MistralProvider;
use crate::providers::noop::NoopProvider;
use crate::providers::openai::OpenAIProvider;
use crate::providers::vertex_ai::VertexAIProvider;
use crate::utils::ParseError;
use anyhow::{anyhow, Result};
use async_trait::async_trait;
use clap::ValueEnum;
use futures::prelude::*;
use serde::{Deserialize, Serialize};
use std::fmt;
use std::str::FromStr;
use std::time::Duration;

use super::deepseek::DeepseekProvider;
use super::fireworks::FireworksProvider;
use super::xai::XaiProvider;

#[derive(Debug, Clone, Copy, Serialize, PartialEq, ValueEnum, Deserialize)]
#[serde(rename_all = "lowercase")]
#[clap(rename_all = "lowercase")]
pub enum ProviderID {
    OpenAI,
    #[serde(rename = "azure_openai")]
    AzureOpenAI,
    Anthropic,
    Mistral,
    #[serde(rename = "vertex_ai")]
    #[clap(name = "vertex_ai")]
    VertexAI,
    #[serde(rename = "google_ai_studio")]
    GoogleAiStudio,
    Deepseek,
    Fireworks,
    Xai,
    Noop,
}

impl fmt::Display for ProviderID {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            ProviderID::OpenAI => write!(f, "openai"),
            ProviderID::AzureOpenAI => write!(f, "azure_openai"),
            ProviderID::Anthropic => write!(f, "anthropic"),
            ProviderID::Mistral => write!(f, "mistral"),
            ProviderID::VertexAI => write!(f, "vertex_ai"),
            ProviderID::GoogleAiStudio => write!(f, "google_ai_studio"),
            ProviderID::Deepseek => write!(f, "deepseek"),
            ProviderID::Fireworks => write!(f, "fireworks"),
            ProviderID::Xai => write!(f, "xai"),
            ProviderID::Noop => write!(f, "noop"),
        }
    }
}

impl FromStr for ProviderID {
    type Err = ParseError;
    fn from_str(s: &str) -> Result<Self, Self::Err> {
        match s {
            "openai" => Ok(ProviderID::OpenAI),
            "azure_openai" => Ok(ProviderID::AzureOpenAI),
            "anthropic" => Ok(ProviderID::Anthropic),
            "mistral" => Ok(ProviderID::Mistral),
            "vertex_ai" => Ok(ProviderID::VertexAI),
            "google_ai_studio" => Ok(ProviderID::GoogleAiStudio),
            "deepseek" => Ok(ProviderID::Deepseek),
            "fireworks" => Ok(ProviderID::Fireworks),
            "xai" => Ok(ProviderID::Xai),
            "noop" => Ok(ProviderID::Noop),
            _ => Err(ParseError::with_message(
                "Unknown provider ID \
                 (possible values: openai, azure_openai, anthropic, mistral, vertex_ai, google_ai_studio, deepseek, fireworks, xai, noop)",
            ))?,
        }
    }
}

#[derive(Debug, Clone)]
pub struct ModelErrorRetryOptions {
    pub sleep: Duration,
    pub factor: u32,
    pub retries: usize,
}

#[derive(Debug)]
pub struct ModelError {
    pub message: String,
    pub retryable: Option<ModelErrorRetryOptions>,
    pub request_id: Option<String>,
}

impl fmt::Display for ModelError {
    fn fmt(&self, f: &mut fmt::Formatter) -> fmt::Result {
        write!(
            f,
            "[model_error(retryable={}{})] {}",
            self.retryable.is_some(),
            match self.request_id.as_ref() {
                Some(r) => format!(", request_id={}", r),
                None => String::from(""),
            },
            self.message
        )
    }
}

impl std::error::Error for ModelError {}

/// @cc [owner:jchen0824,label:error-handling;performance] back-off-waits-only-before-a-retry
/// When `f`'s `n`th call fails with a `ModelError` whose `retryable` is
/// `Some(retry)`, `f` is called again only if `n <= retry.retries`, after a
/// wait of `retry.sleep` the first time and of `retry.factor` times the
/// previous wait after that; `log_retry` receives that wait and `n` first.
/// Otherwise it returns `Too many retries (<retry.retries>): <error>` at once,
/// with no wait and no `log_retry` call.
pub async fn with_retryable_back_off<F, O>(
    mut f: impl FnMut() -> F,
    log_retry: impl Fn(&str, &Duration, usize) -> (),
    log_model_error: impl Fn(&ModelError) -> (),
) -> Result<O>
where
    F: Future<Output = Result<O, anyhow::Error>>,
{
    let mut attempts = 0_usize;
    let mut sleep: Option<Duration> = None;
    let out = loop {
        match f().await {
            Err(e) => match e.downcast::<ModelError>() {
                Ok(err) => {
                    log_model_error(&err);
                    match err.retryable.clone() {
                        Some(retry) => {
                            attempts += 1;
                            if attempts > retry.retries {
                                break Err(anyhow!(
                                    "Too many retries ({}): {}",
                                    retry.retries,
                                    err
                                ));
                            }
                            let wait = match sleep {
                                None => retry.sleep,
                                Some(b) => b * retry.factor,
                            };
                            sleep = Some(wait);
                            log_retry(&err.message, &wait, attempts);
                            tokio::time::sleep(wait).await;
                        }
                        None => {
                            break Err(anyhow!("{}", err));
                        }
                    };
                }
                Err(err) => break Err(err),
            },
            Ok(out) => break Ok(out),
        }
    };
    out
}

#[async_trait]
pub trait Provider {
    fn id(&self) -> ProviderID;

    fn setup(&self) -> Result<()>;
    async fn test(&self) -> Result<()>;

    fn llm(&self, id: String, tokenizer: Option<TokenizerSingleton>) -> Box<dyn LLM + Sync + Send>;
    fn embedder(&self, id: String) -> Box<dyn Embedder + Sync + Send>;
}

pub fn provider(t: ProviderID) -> Box<dyn Provider + Sync + Send> {
    match t {
        ProviderID::Anthropic => Box::new(AnthropicProvider::new()),
        ProviderID::AzureOpenAI => Box::new(AzureOpenAIProvider::new()),
        ProviderID::GoogleAiStudio => Box::new(GoogleAiStudioProvider::new()),
        ProviderID::Mistral => Box::new(MistralProvider::new()),
        ProviderID::VertexAI => Box::new(VertexAIProvider::new()),
        ProviderID::OpenAI => Box::new(OpenAIProvider::new()),
        ProviderID::Deepseek => Box::new(DeepseekProvider::new()),
        ProviderID::Fireworks => Box::new(FireworksProvider::new()),
        ProviderID::Xai => Box::new(XaiProvider::new()),
        ProviderID::Noop => Box::new(NoopProvider::new()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Mutex;
    use std::time::Instant;

    // A third wait, after the last call, would last 20 s: far beyond
    // `BACK_OFF_TIMEOUT`.
    const RETRY: ModelErrorRetryOptions = ModelErrorRetryOptions {
        sleep: Duration::from_millis(2),
        factor: 100,
        retries: 2,
    };
    const BACK_OFF_TIMEOUT: Duration = Duration::from_secs(5);

    struct BackOffRun {
        result: Result<usize>,
        calls: Vec<Instant>,
        retries: Vec<(Duration, usize)>,
    }

    /// Runs the back-off over calls that fail with a `RETRY` model error,
    /// except the call numbered `succeeding_call` (from 1), which returns its
    /// number.
    async fn back_off_run(succeeding_call: Option<usize>) -> BackOffRun {
        let calls = Mutex::new(Vec::new());
        let retries = Mutex::new(Vec::new());
        let result = tokio::time::timeout(
            BACK_OFF_TIMEOUT,
            with_retryable_back_off(
                || {
                    let call = {
                        let mut calls = calls.lock().expect("call log");
                        calls.push(Instant::now());
                        calls.len()
                    };
                    async move {
                        if Some(call) == succeeding_call {
                            Ok(call)
                        } else {
                            Err(anyhow!(ModelError {
                                message: "throttled".into(),
                                retryable: Some(RETRY),
                                request_id: None,
                            }))
                        }
                    }
                },
                |_, wait, attempts| retries.lock().expect("retry log").push((*wait, attempts)),
                |_| {},
            ),
        )
        .await
        .expect("the back-off returns without waiting after its last call");
        BackOffRun {
            result,
            calls: calls.into_inner().expect("call log"),
            retries: retries.into_inner().expect("retry log"),
        }
    }

    /// `retries` waits of the configured delays, each before the next call.
    fn assert_configured_waits(run: &BackOffRun) {
        assert_eq!(
            run.retries,
            vec![
                (Duration::from_millis(2), 1),
                (Duration::from_millis(200), 2)
            ]
        );
        assert_eq!(run.calls.len(), RETRY.retries + 1);
        for (pair, (wait, _)) in run.calls.windows(2).zip(&run.retries) {
            assert!(pair[1].duration_since(pair[0]) >= *wait);
        }
    }

    #[tokio::test]
    async fn persistent_retryable_failure_stops_without_a_final_wait() {
        let run = back_off_run(None).await;
        assert_configured_waits(&run);
        let error = run.result.expect_err("the retries are exhausted");
        assert_eq!(
            error.to_string(),
            "Too many retries (2): [model_error(retryable=true)] throttled"
        );
    }

    #[tokio::test]
    async fn success_on_the_last_retry_is_returned() {
        let run = back_off_run(Some(RETRY.retries + 1)).await;
        assert_configured_waits(&run);
        assert_eq!(
            run.result.expect("the last retry succeeds"),
            RETRY.retries + 1
        );
    }
}
