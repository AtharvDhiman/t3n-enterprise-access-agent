/**
 * The deterministic policy engine.
 *
 * ## Contract
 *
 * `evaluate()` is a **pure function** of (config, request, claim set, clock).
 * Same inputs → same output, always. It performs no I/O, makes no network
 * calls, and consults no language model. This is the only component in the
 * system permitted to produce a `Decision`.
 *
 * That property is the security boundary: an LLM can phrase a request however
 * it likes and can summarise the result however it likes, but it cannot reach
 * inside this function. There is no prompt, no instruction and no crafted
 * subject name that changes the outcome, because none of those things are
 * inputs to the computation.
 *
 * ## Decision precedence (fail-closed, evaluated in order)
 *
 *   1. Request is out of the policy's declared envelope  → DENIED
 *   2. Any requirement failed hard (per `failed_claim_behavior`) → DENIED
 *   3. Any requirement unsatisfied for any other reason   → REVIEW_REQUIRED
 *   4. Policy demands a human approver                    → REVIEW_REQUIRED
 *   5. Otherwise                                          → APPROVED
 *
 * Note the asymmetry, which is deliberate: a *failed* verification denies, but
 * an *absent* one only escalates. "We checked and it is false" and "we were not
 * permitted to look" are different facts and must not collapse into the same
 * outcome.
 */

import {
  assuranceRank,
  newAuditId,
  type AccessRequest,
  type AssuranceLevel,
  type Claim,
  type ClaimSet,
  type Decision,
  type DecisionResult,
  type RequirementResult,
  type RiskFlag,
} from "@t3n-aca/core";
import { PolicyNotFoundError } from "@t3n-aca/core";

import type { PolicyDefinition, PolicyFile } from "./schema.ts";

/** Rules for one policy after defaults have been merged in. */
export interface EffectiveRules {
  minimumAssurance: AssuranceLevel;
  maxClaimAgeDays: number;
  expiredClaimBehavior: "review" | "deny";
  failedClaimBehavior: "review" | "deny";
  expiringSoonDays: number;
  requireManualApproval: boolean;
  flagMissingOptional: boolean;
}

export interface EvaluateOptions {
  /** Injected clock. Defaults to now. Injectable so tests are deterministic. */
  now?: Date;
  /** Injected audit id. Defaults to a fresh one. */
  auditId?: string;
}

/** Public summary of a configured policy, safe to send to the browser. */
export interface PolicySummary {
  id: string;
  label: string;
  description: string;
  subjectTypes: readonly string[];
  resources: readonly string[];
  accessLevels: readonly string[];
  requiredClaims: readonly string[];
  optionalClaims: readonly string[];
  /** T3N scopes this policy needs consent for. */
  requiredScopes: readonly string[];
  rules: EffectiveRules;
}

/** Tolerance for ordinary clock skew between this host and an issuer. */
const CLOCK_SKEW_TOLERANCE_DAYS = 1;

const MS_PER_DAY = 86_400_000;

export class PolicyEngine {
  private readonly config: PolicyFile;

  constructor(config: PolicyFile) {
    this.config = config;
  }

  get version(): string {
    return this.config.version;
  }

  // -------------------------------------------------------------------------
  // Configuration access
  // -------------------------------------------------------------------------

  policyIds(): string[] {
    return Object.keys(this.config.policies);
  }

  getPolicy(policyId: string): PolicyDefinition {
    const policy = this.config.policies[policyId];
    if (!policy) throw new PolicyNotFoundError(policyId, this.policyIds());
    return policy;
  }

  /** Merge a policy's overrides over the file defaults. */
  effectiveRules(policyId: string): EffectiveRules {
    const { rules } = this.getPolicy(policyId);
    const d = this.config.defaults;
    return {
      minimumAssurance: rules.minimum_assurance ?? d.minimum_assurance,
      maxClaimAgeDays: rules.max_claim_age_days ?? d.max_claim_age_days,
      expiredClaimBehavior: rules.expired_claim_behavior ?? d.expired_claim_behavior,
      failedClaimBehavior: rules.failed_claim_behavior ?? d.failed_claim_behavior,
      expiringSoonDays: rules.expiring_soon_days ?? d.expiring_soon_days,
      requireManualApproval: rules.require_manual_approval ?? false,
      flagMissingOptional: rules.flag_missing_optional ?? false,
    };
  }

  /**
   * The T3N scopes a policy needs.
   *
   * This is the data-minimization calculation: the exact, complete set of
   * scopes the agent may request for this policy, and no others. Required and
   * optional claims both count — an optional claim still needs consent to be
   * read — but nothing outside the policy is ever included.
   */
  requiredScopes(policyId: string): string[] {
    const policy = this.getPolicy(policyId);
    const scopes = new Set<string>();
    for (const claimId of [...policy.required_claims, ...policy.optional_claims]) {
      const def = this.config.claims[claimId];
      // Schema validation guarantees this exists; the guard keeps the function
      // total rather than relying on that invariant at runtime.
      if (def) scopes.add(def.scope);
    }
    return [...scopes].sort();
  }

  /** Scope for a single claim, or null if the claim is not defined. */
  scopeForClaim(claimId: string): string | null {
    return this.config.claims[claimId]?.scope ?? null;
  }

  listPolicies(): PolicySummary[] {
    return this.policyIds().map((id) => {
      const p = this.getPolicy(id);
      return {
        id,
        label: p.label,
        description: p.description.trim(),
        subjectTypes: p.applies_to_subject_types,
        resources: p.resources,
        accessLevels: p.access_levels,
        requiredClaims: p.required_claims,
        optionalClaims: p.optional_claims,
        requiredScopes: this.requiredScopes(id),
        rules: this.effectiveRules(id),
      };
    });
  }

  /** Claim vocabulary, for the UI's policy screen. */
  listClaims(): Array<{ id: string; scope: string; label: string; description: string }> {
    return Object.entries(this.config.claims).map(([id, def]) => ({
      id,
      scope: def.scope,
      label: def.label,
      description: def.description.trim(),
    }));
  }

  // -------------------------------------------------------------------------
  // Policy resolution
  // -------------------------------------------------------------------------

  /**
   * Choose the policy governing a request.
   *
   * Ordered first-match, never a score. When the caller names a policy we use
   * exactly that one — an explicit choice is never silently overridden, because
   * an operator who names a policy is entitled to see that policy's verdict.
   *
   * Returns `null` when nothing matches and the config says to deny.
   */
  resolvePolicyId(request: AccessRequest): string | null {
    if (request.policyId) {
      this.getPolicy(request.policyId); // throws PolicyNotFoundError if unknown
      return request.policyId;
    }
    for (const candidateId of this.config.resolution.order) {
      const policy = this.config.policies[candidateId];
      if (!policy) continue;
      if (!policy.applies_to_subject_types.includes(request.subjectType)) continue;
      if (!policy.resources.includes(request.resource)) continue;
      if (!policy.access_levels.includes(request.accessLevel)) continue;
      return candidateId;
    }
    return null;
  }

  // -------------------------------------------------------------------------
  // Evaluation
  // -------------------------------------------------------------------------

  /**
   * Evaluate one requirement against the claim set.
   *
   * Order of checks matters and is fixed:
   *   consent → presence → verified → freshness → assurance
   * Reporting "not authorized" before "missing" is what lets a reviewer tell
   * a consent problem apart from an evidence problem.
   */
  private evaluateRequirement(
    claimId: string,
    claimSet: ClaimSet,
    rules: EffectiveRules,
    now: Date,
  ): RequirementResult {
    const scope = this.scopeForClaim(claimId);
    const label = this.config.claims[claimId]?.label ?? claimId;

    if (scope && !claimSet.authorizedScopes.includes(scope)) {
      return {
        claimId,
        satisfied: false,
        reason: "not_authorized",
        detail: `${label}: the subject has not authorized this agent to read "${scope}", so this could not be checked.`,
      };
    }

    const claim = claimSet.claims.find((c) => c.id === claimId);
    if (!claim) {
      return {
        claimId,
        satisfied: false,
        reason: "missing",
        detail: `${label}: no verified claim on record.`,
      };
    }

    if (!claim.verified) {
      return {
        claimId,
        satisfied: false,
        reason: "not_verified",
        detail: `${label}: verification was attempted and did not pass.`,
      };
    }

    // An unparseable date must never read as "no expiry". `new Date("nonsense")`
    // yields NaN, and every comparison against NaN is false — so a malformed
    // timestamp would sail through both checks below as though the claim were
    // permanently valid. Treat it as unusable instead.
    if (claim.expiresAt !== null) {
      const expiryMs = new Date(claim.expiresAt).getTime();
      if (Number.isNaN(expiryMs)) {
        return {
          claimId,
          satisfied: false,
          reason: "expired",
          detail: `${label}: expiry date is unreadable, so validity cannot be established.`,
        };
      }
      if (expiryMs <= now.getTime()) {
        return {
          claimId,
          satisfied: false,
          reason: "expired",
          detail: `${label}: expired on ${claim.expiresAt.slice(0, 10)}.`,
        };
      }
    }

    // A claim with no verification date cannot be shown to be fresh, and
    // "cannot be shown" must not resolve to "is". Skipping the age check when
    // `verifiedAt` is null made an undated claim permanently valid — it passed
    // even under privileged_access, whose whole purpose is a tightened 180-day
    // window with `expired_claim_behavior: deny`. Absent evidence of freshness
    // is treated exactly like stale evidence, which is what fail-closed means.
    if (claim.verifiedAt === null) {
      return {
        claimId,
        satisfied: false,
        reason: "expired",
        detail: `${label}: no verification date on record, so its age cannot be checked against the ${rules.maxClaimAgeDays}-day maximum for this policy.`,
      };
    }

    const verifiedMs = new Date(claim.verifiedAt).getTime();
    if (Number.isNaN(verifiedMs)) {
      return {
        claimId,
        satisfied: false,
        reason: "expired",
        detail: `${label}: verification date is unreadable, so its age cannot be checked.`,
      };
    }

    const ageDays = (now.getTime() - verifiedMs) / MS_PER_DAY;
    // A future verification date is not evidence of anything. It made `ageDays`
    // negative, so the freshness test passed trivially and a claim stamped a
    // year ahead read as maximally fresh — the one input that should never be
    // trusted was the one that could never go stale. Clock skew of a few
    // minutes is normal, so allow a small tolerance and reject beyond it.
    if (ageDays < -CLOCK_SKEW_TOLERANCE_DAYS) {
      return {
        claimId,
        satisfied: false,
        reason: "expired",
        detail: `${label}: the verification date is in the future, so its age cannot be established.`,
      };
    }
    if (ageDays > rules.maxClaimAgeDays) {
      return {
        claimId,
        satisfied: false,
        reason: "expired",
        detail: `${label}: last verified ${Math.floor(ageDays)} days ago, exceeding the ${rules.maxClaimAgeDays}-day maximum for this policy.`,
      };
    }

    if (assuranceRank(claim.assurance) < assuranceRank(rules.minimumAssurance)) {
      return {
        claimId,
        satisfied: false,
        reason: "insufficient_assurance",
        detail: `${label}: verified at "${claim.assurance}" assurance, below the required "${rules.minimumAssurance}".`,
      };
    }

    return {
      claimId,
      satisfied: true,
      reason: "satisfied",
      detail: `${label}: verified at "${claim.assurance}" assurance.`,
    };
  }

  private buildRiskFlags(
    request: AccessRequest,
    policyId: string,
    claimSet: ClaimSet,
    rules: EffectiveRules,
    requirementResults: readonly RequirementResult[],
    now: Date,
  ): RiskFlag[] {
    const flags: RiskFlag[] = [];
    const policy = this.getPolicy(policyId);

    if (claimSet.source === "DEMO_FIXTURE") {
      flags.push({
        code: "DEMO_DATA",
        severity: "medium",
        message:
          "Evaluated against local demo fixtures, not live Terminal 3 data. Not valid for a real access decision.",
      });
    }

    if (claimSet.unavailableReason) {
      flags.push({
        code: "CLAIM_SOURCE_DEGRADED",
        severity: "high",
        message: `Claim source was degraded: ${claimSet.unavailableReason}`,
      });
    }

    if (!claimSet.consentVerified) {
      flags.push({
        code: "CONSENT_NOT_VERIFIED",
        severity: "high",
        message:
          "The subject has not granted this agent consent for every scope this policy requires.",
      });
    }

    if (claimSet.deniedScopes.length > 0) {
      flags.push({
        code: "PARTIAL_CONSENT",
        severity: "medium",
        message: `Consent was withheld for: ${claimSet.deniedScopes.join(", ")}.`,
      });
    }

    // Claims that pass today but expire soon — actionable before they bite.
    const soonMs = rules.expiringSoonDays * MS_PER_DAY;
    for (const claim of claimSet.claims) {
      if (!claim.expiresAt) continue;
      const dueIn = new Date(claim.expiresAt).getTime() - now.getTime();
      if (dueIn > 0 && dueIn <= soonMs) {
        flags.push({
          code: "CLAIM_EXPIRING_SOON",
          severity: "low",
          message: `"${claim.id}" expires on ${claim.expiresAt.slice(0, 10)}.`,
        });
      }
    }

    if (rules.flagMissingOptional) {
      for (const claimId of policy.optional_claims) {
        const present = claimSet.claims.some((c) => c.id === claimId && c.verified);
        if (!present) {
          flags.push({
            code: "OPTIONAL_CLAIM_ABSENT",
            severity: "low",
            message: `Recommended (not required) claim "${claimId}" is absent.`,
          });
        }
      }
    }

    if (rules.requireManualApproval) {
      flags.push({
        code: "MANUAL_APPROVAL_REQUIRED",
        severity: "medium",
        message: "This policy always requires a named human approver.",
      });
    }

    const failed = requirementResults.filter((r) => r.reason === "not_verified");
    if (failed.length > 0) {
      flags.push({
        code: "FAILED_VERIFICATION",
        severity: "high",
        message: `Verification explicitly failed for: ${failed.map((r) => r.claimId).join(", ")}.`,
      });
    }

    if (request.subjectType !== "employee" && rules.requireManualApproval) {
      flags.push({
        code: "EXTERNAL_SUBJECT_PRIVILEGED",
        severity: "high",
        message: `A non-employee subject (${request.subjectType}) is requesting access under a policy that requires manual approval.`,
      });
    }

    return flags;
  }

  /**
   * Evaluate an access request. The single decision point of the system.
   */
  evaluate(
    request: AccessRequest,
    claimSet: ClaimSet,
    options: EvaluateOptions = {},
  ): DecisionResult {
    const now = options.now ?? new Date();
    const auditId = options.auditId ?? newAuditId();
    const timestamp = now.toISOString();

    // --- Step 0: resolve the governing policy ------------------------------
    const policyId = this.resolvePolicyId(request);
    if (policyId === null) {
      // Fail closed. No policy covers this combination, so nothing authorises it.
      const denyByDefault = this.config.resolution.no_match_behavior === "deny";
      return {
        decision: denyByDefault ? "DENIED" : "REVIEW_REQUIRED",
        policy: "(none)",
        policyVersion: this.config.version,
        reason: `No configured policy covers a "${request.subjectType}" requesting "${request.accessLevel}" access to "${request.resource}".`,
        requirements: [],
        satisfiedRequirements: [],
        missingRequirements: [],
        requirementDetail: [],
        riskFlags: [
          {
            code: "NO_MATCHING_POLICY",
            severity: "high",
            message:
              "No policy matched this request. Access is refused by default rather than falling back to a permissive policy.",
          },
        ],
        nextAction: denyByDefault
          ? "Define a policy covering this resource and access level in config/policies.yaml, or correct the request."
          : "Route to a compliance officer: no policy covers this request.",
        timestamp,
        auditId,
        dataAccess: {
          source: claimSet.source,
          requestedScopes: [],
          authorizedScopes: [],
          deniedScopes: [],
          consentVerified: false,
          // No policy means no scopes were needed, so nothing was read.
          claimsRead: 0,
        },
      };
    }

    const policy = this.getPolicy(policyId);
    const rules = this.effectiveRules(policyId);

    // --- Step 1: is the request inside the policy's declared envelope? -----
    const envelopeViolations: string[] = [];
    if (!policy.applies_to_subject_types.includes(request.subjectType)) {
      envelopeViolations.push(
        `policy "${policyId}" does not apply to subject type "${request.subjectType}" (applies to: ${policy.applies_to_subject_types.join(", ")})`,
      );
    }
    if (!policy.resources.includes(request.resource)) {
      envelopeViolations.push(
        `policy "${policyId}" does not govern resource "${request.resource}"`,
      );
    }
    if (!policy.access_levels.includes(request.accessLevel)) {
      envelopeViolations.push(
        `policy "${policyId}" does not permit access level "${request.accessLevel}" (permits: ${policy.access_levels.join(", ")})`,
      );
    }

    const requirements = policy.required_claims;
    const requestedScopes = this.requiredScopes(policyId);

    if (envelopeViolations.length > 0) {
      return {
        decision: "DENIED",
        policy: policyId,
        policyVersion: this.config.version,
        reason: `Request falls outside the policy's scope: ${envelopeViolations.join("; ")}.`,
        requirements,
        satisfiedRequirements: [],
        missingRequirements: [...requirements],
        requirementDetail: [],
        riskFlags: [
          {
            code: "OUT_OF_POLICY_SCOPE",
            severity: "high",
            message: envelopeViolations.join("; "),
          },
        ],
        nextAction:
          "Correct the request, or select a policy that governs this resource and access level.",
        timestamp,
        auditId,
        dataAccess: {
          source: claimSet.source,
          requestedScopes,
          authorizedScopes: claimSet.authorizedScopes,
          deniedScopes: claimSet.deniedScopes,
          consentVerified: claimSet.consentVerified,
          claimsRead: claimSet.claims.length,
        },
      };
    }

    // --- Step 2: evaluate every requirement --------------------------------
    const requirementDetail = requirements.map((claimId) =>
      this.evaluateRequirement(claimId, claimSet, rules, now),
    );

    const satisfiedRequirements = requirementDetail
      .filter((r) => r.satisfied)
      .map((r) => r.claimId);
    const unsatisfied = requirementDetail.filter((r) => !r.satisfied);
    const missingRequirements = unsatisfied.map((r) => r.claimId);

    // --- Step 3: which failures are hard denials? --------------------------
    const hardDenials = unsatisfied.filter((r) => {
      if (r.reason === "not_verified") return rules.failedClaimBehavior === "deny";
      if (r.reason === "expired") return rules.expiredClaimBehavior === "deny";
      // "missing", "not_authorized" and "insufficient_assurance" are all
      // remediable and never deny on their own: the correct answer to "we do
      // not know" is to ask a human, not to refuse.
      return false;
    });

    const riskFlags = this.buildRiskFlags(
      request,
      policyId,
      claimSet,
      rules,
      requirementDetail,
      now,
    );

    // --- Step 4: decide -----------------------------------------------------
    let decision: Decision;
    let reason: string;
    let nextAction: string;

    if (hardDenials.length > 0) {
      decision = "DENIED";
      reason = `Denied: ${hardDenials.map((r) => r.detail).join(" ")}`;
      nextAction =
        "Do not grant access. The subject must resolve the failed verification and submit a new request.";
    } else if (unsatisfied.length > 0) {
      decision = "REVIEW_REQUIRED";
      const consentIssues = unsatisfied.filter((r) => r.reason === "not_authorized");
      reason = `Cannot approve automatically: ${unsatisfied.map((r) => r.detail).join(" ")}`;
      nextAction =
        consentIssues.length > 0
          ? `Ask the subject to grant this agent access to: ${consentIssues
              .map((r) => this.scopeForClaim(r.claimId) ?? r.claimId)
              .join(", ")}. Then re-run the check.`
          : "Route to a compliance reviewer with the missing requirements above.";
    } else if (rules.requireManualApproval) {
      decision = "REVIEW_REQUIRED";
      reason = `All ${requirements.length} requirements are satisfied, but policy "${policyId}" requires a named human approver for this level of access.`;
      nextAction =
        "Route to an authorised approver for sign-off. All automated checks have passed.";
    } else {
      decision = "APPROVED";
      reason = `All ${requirements.length} requirements satisfied at "${rules.minimumAssurance}" assurance or above.`;
      nextAction = `Grant "${request.accessLevel}" access to "${request.resource}". Re-verify when the earliest claim expires.`;
    }

    return {
      decision,
      policy: policyId,
      policyVersion: this.config.version,
      reason,
      requirements,
      satisfiedRequirements,
      missingRequirements,
      requirementDetail,
      riskFlags,
      nextAction,
      timestamp,
      auditId,
      dataAccess: {
        source: claimSet.source,
        requestedScopes,
        authorizedScopes: claimSet.authorizedScopes,
        deniedScopes: claimSet.deniedScopes,
        consentVerified: claimSet.consentVerified,
        claimsRead: claimSet.claims.length,
      },
    };
  }
}

/** Convenience for tests: build a claim quickly. */
export function makeClaim(id: string, overrides: Partial<Claim> = {}): Claim {
  return {
    id,
    verified: true,
    assurance: "high",
    verifiedAt: new Date().toISOString(),
    expiresAt: null,
    issuerCategory: null,
    evidenceRef: null,
    ...overrides,
  };
}
