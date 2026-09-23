use jsonwebtoken::{decode, Algorithm, DecodingKey, Validation};
use serde::{Deserialize, Serialize};
use std::collections::HashSet;

pub const HEADER: &str = "x-dust-workspace-assertion";
const AUDIENCE: &str = "dust-core-vertex-embedding";

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq, Hash)]
pub struct DataSourcePair {
    pub project_id: i64,
    pub data_source_id: String,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
struct Claims {
    aud: String,
    exp: usize,
    iat: usize,
    workspace_sid: String,
    data_sources: Vec<DataSourcePair>,
}

/// This value can only be constructed after checking the Front signature and exact request pairs.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct VerifiedWorkspace {
    sid: String,
}

impl VerifiedWorkspace {
    pub fn sid(&self) -> &str {
        &self.sid
    }
}

pub fn verify(token: Option<&str>, requested: &[DataSourcePair]) -> Option<VerifiedWorkspace> {
    let secret = std::env::var("DUST_CORE_WORKSPACE_ASSERTION_SECRET").ok()?;
    if secret.len() < 32 || requested.is_empty() {
        return None;
    }
    let mut validation = Validation::new(Algorithm::HS256);
    validation.leeway = 0;
    validation.set_audience(&[AUDIENCE]);
    validation.required_spec_claims.insert("exp".to_string());
    validation.required_spec_claims.insert("iat".to_string());
    let claims = decode::<Claims>(
        token?,
        &DecodingKey::from_secret(secret.as_bytes()),
        &validation,
    )
    .ok()?
    .claims;
    let now = (crate::utils::now() / 1000) as usize;
    if claims.iat > now + 10 || now.saturating_sub(claims.iat) > 90 || claims.exp > now + 90 {
        return None;
    }
    if claims.workspace_sid.is_empty() || claims.data_sources.is_empty() {
        return None;
    }
    let expected: HashSet<_> = requested.iter().collect();
    let asserted: HashSet<_> = claims.data_sources.iter().collect();
    if expected != asserted {
        return None;
    }
    Some(VerifiedWorkspace {
        sid: claims.workspace_sid,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use jsonwebtoken::{encode, EncodingKey, Header};

    fn token(secret: &str, audience: &str, exp: usize, pairs: Vec<DataSourcePair>) -> String {
        match encode(
            &Header::new(Algorithm::HS256),
            &Claims {
                aud: audience.into(),
                exp,
                iat: (crate::utils::now() / 1000) as usize,
                workspace_sid: "w-test".into(),
                data_sources: pairs,
            },
            &EncodingKey::from_secret(secret.as_bytes()),
        ) {
            Ok(token) => token,
            Err(error) => panic!("test token encoding failed: {error}"),
        }
    }

    #[test]
    fn forged_missing_expired_and_partial_bulk_assertions_fail() {
        let secret = "test-secret-".repeat(4);
        std::env::set_var("DUST_CORE_WORKSPACE_ASSERTION_SECRET", &secret);
        let a = DataSourcePair {
            project_id: 1,
            data_source_id: "a".into(),
        };
        let b = DataSourcePair {
            project_id: 2,
            data_source_id: "b".into(),
        };
        let future = (crate::utils::now() / 1000 + 60) as usize;
        assert!(verify(None, std::slice::from_ref(&a)).is_none());
        assert!(verify(
            Some(&token(
                "wrong-secret-with-adequate-length-for-tests",
                AUDIENCE,
                future,
                vec![a.clone()]
            )),
            std::slice::from_ref(&a)
        )
        .is_none());
        assert!(verify(
            Some(&token(&secret, AUDIENCE, 1, vec![a.clone()])),
            std::slice::from_ref(&a)
        )
        .is_none());
        assert!(verify(
            Some(&token(&secret, AUDIENCE, future - 61, vec![a.clone()])),
            std::slice::from_ref(&a)
        )
        .is_none());
        assert!(verify(
            Some(&token(&secret, "other-audience", future, vec![a.clone()])),
            std::slice::from_ref(&a)
        )
        .is_none());
        let partial = token(&secret, AUDIENCE, future, vec![a.clone()]);
        assert!(verify(Some(&partial), &[a.clone(), b.clone()]).is_none());
        assert!(verify(Some(&partial), &[b]).is_none());
        assert_eq!(
            verify(
                Some(&token(&secret, AUDIENCE, future, vec![a.clone()])),
                &[a]
            )
            .expect("verified test workspace assertion")
            .sid(),
            "w-test"
        );
    }

    #[test]
    fn caller_extras_cannot_override_verified_workspace() {
        use crate::providers::embedder::{EmbedderRequest, EmbeddingTaskType};
        use crate::providers::provider::ProviderID;
        let secret = "test-secret-".repeat(4);
        std::env::set_var("DUST_CORE_WORKSPACE_ASSERTION_SECRET", &secret);
        let pair = DataSourcePair {
            project_id: 1,
            data_source_id: "a".into(),
        };
        let future = (crate::utils::now() / 1000 + 60) as usize;
        let workspace = verify(
            Some(&token(&secret, AUDIENCE, future, vec![pair.clone()])),
            &[pair],
        )
        .unwrap();
        let request = EmbedderRequest::new(
            ProviderID::VertexAI,
            "gemini-embedding-2-1536",
            vec!["query"],
            EmbeddingTaskType::RetrievalQuery,
            Some(serde_json::json!({"workspace_sid": "forged", "_dust_verified_workspace_sid": "forged"})),
        ).with_verified_workspace(Some(workspace));
        assert_eq!(request.verified_workspace_sid(), Some("w-test"));
        let serialized = serde_json::to_value(&request).unwrap();
        assert!(serialized.get("verified_workspace").is_none());
    }

    #[test]
    fn repeated_authorized_pair_is_allowed_but_new_pair_is_not() {
        let secret = "test-secret-".repeat(4);
        std::env::set_var("DUST_CORE_WORKSPACE_ASSERTION_SECRET", &secret);
        let a = DataSourcePair {
            project_id: 1,
            data_source_id: "shared-source".into(),
        };
        let b = DataSourcePair {
            project_id: 2,
            data_source_id: "other-source".into(),
        };
        let future = (crate::utils::now() / 1000 + 60) as usize;
        let assertion = token(&secret, AUDIENCE, future, vec![a.clone()]);
        assert!(verify(Some(&assertion), &[a.clone(), a.clone()]).is_some());
        assert!(verify(Some(&assertion), &[a.clone(), a, b]).is_none());
    }
}
