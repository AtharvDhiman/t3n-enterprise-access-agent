//! T3N Enterprise Access & Compliance Tenant Contract
//!
//! Updated for T3N per-function grant scoping and host:tenant@2.0.0.
//!
//! # Breaking Changes from Previous Version (v1.x -> v2.0.0):
//! 1. `CONTRACT_VERSION` bumped to MAJOR version `2.0.0`.
//! 2. Rebuilt against updated host runtime (`host:tenant@2.0.0`).
//! 3. `host::delegated_scopes()` returns `Vec<Scope>` records (`{ path, access }`)
//!    instead of `Vec<String>`. Contract now reads `.path` and verifies `.access` contains `AccessVerb::Read`.
//! 4. `host::delegated_read_scopes()` removed: the old roster split is retired.
//! 5. `host::delegated_functions()` returns a single function `String` (or `"*"`),
//!    enforcing that each grant row targets a specific function.

wit_bindgen::generate!({
    world: "tenant-contract",
    path: "wit",
});

use exports::t3n::tenant_contract::tenant_contract::Guest;
use host::AccessVerb;
use serde::{Deserialize, Serialize};

/// Major version bump per T3N upgrade requirement.
pub const CONTRACT_VERSION: &str = "2.0.0";

pub struct TenantContract;

#[derive(Debug, Deserialize)]
pub struct AccessEvaluationRequest {
    pub subject_did: String,
    pub policy_id: String,
    pub required_scopes: Vec<String>,
}

#[derive(Debug, Serialize)]
pub struct AccessEvaluationResponse {
    pub contract_version: String,
    pub granted_function: String,
    pub authorized_scopes: Vec<String>,
    pub withheld_scopes: Vec<String>,
    pub decision: String,
    pub explanation: String,
}

impl Guest for TenantContract {
    /// Returns the contract version.
    fn contract_version() -> String {
        CONTRACT_VERSION.to_string()
    }

    /// Evaluates access requests using per-function scoped data grants.
    fn evaluate_access(request_json: String) -> String {
        // Step 1: Verify function-level authorization.
        // Each grant carries exactly one function, or "*" for all-functions marker.
        let delegated_fn = host::delegated_functions();
        let is_authorized_function = delegated_fn == "evaluate-access" || delegated_fn == "*";

        if !is_authorized_function {
            let refusal = AccessEvaluationResponse {
                contract_version: CONTRACT_VERSION.to_string(),
                granted_function: delegated_fn,
                authorized_scopes: vec![],
                withheld_scopes: vec![],
                decision: "DENIED".to_string(),
                explanation: "Calling agent is not granted access to function 'evaluate-access'".to_string(),
            };
            return serde_json::to_string(&refusal).unwrap_or_else(|_| "{\"error\":\"json_serialization\"}".to_string());
        }

        // Step 2: Read scoped data paths with { path, access } records.
        // Filter for scopes conferring the 'read' access verb.
        let delegated_scopes = host::delegated_scopes();
        let readable_scopes: Vec<String> = delegated_scopes
            .into_iter()
            .filter(|scope| scope.access.contains(&AccessVerb::Read))
            .map(|scope| scope.path)
            .collect();

        // Step 3: Parse evaluation request
        let req: AccessEvaluationRequest = match serde_json::from_str(&request_json) {
            Ok(parsed) => parsed,
            Err(e) => {
                let err_res = AccessEvaluationResponse {
                    contract_version: CONTRACT_VERSION.to_string(),
                    granted_function: delegated_fn,
                    authorized_scopes: vec![],
                    withheld_scopes: vec![],
                    decision: "DENIED".to_string(),
                    explanation: format!("Invalid request payload: {e}"),
                };
                return serde_json::to_string(&err_res).unwrap_or_default();
            }
        };

        // Step 4: Determine authorized vs withheld scopes
        let mut authorized = Vec::new();
        let mut withheld = Vec::new();

        for scope in &req.required_scopes {
            if readable_scopes.iter().any(|s| s == scope) {
                authorized.push(scope.clone());
            } else {
                withheld.push(scope.clone());
            }
        }

        let decision = if withheld.is_empty() {
            "APPROVED"
        } else {
            "REVIEW_REQUIRED"
        };

        let explanation = if withheld.is_empty() {
            format!("All {} required scopes were authorized under per-function delegation.", authorized.len())
        } else {
            format!(
                "Consent was withheld for {} scope(s): {}. Escalating to human reviewer.",
                withheld.len(),
                withheld.join(", ")
            )
        };

        let response = AccessEvaluationResponse {
            contract_version: CONTRACT_VERSION.to_string(),
            granted_function: delegated_fn,
            authorized_scopes: authorized,
            withheld_scopes: withheld,
            decision: decision.to_string(),
            explanation,
        };

        serde_json::to_string(&response).unwrap_or_else(|_| "{\"error\":\"json_serialization\"}".to_string())
    }
}

export!(TenantContract);
