/**
 * Domain types shared across the policy engine, the T3N adapter, the agent and
 * the HTTP API.
 *
 * Design rule enforced throughout this file: **no raw personal data has a home
 * here.** There is deliberately no `dateOfBirth`, `address`, `phone` or
 * `documentNumber` field anywhere in the domain model. The agent reasons over
 * *assertions about* a person, never the underlying evidence. If a future change
 * needs one of those fields, that is a signal the design has drifted — see
 * `docs/architecture.md`.
 */

import { z } from "zod";

// ---------------------------------------------------------------------------
// Decisions
// ---------------------------------------------------------------------------

/** The only three outcomes an access evaluation can produce. */
export const DECISIONS = ["APPROVED", "REVIEW_REQUIRED", "DENIED"] as const;
export type Decision = (typeof DECISIONS)[number];

/**
 * Assurance level of a claim, ordered weakest → strongest.
 *
 * Ordering is total and is what `minimum_assurance` in a policy compares
 * against. Kept as an ordered tuple rather than a numeric enum so that
 * `policies.yaml` stays human-readable.
 */
export const ASSURANCE_LEVELS = ["none", "low", "substantial", "high"] as const;
export type AssuranceLevel = (typeof ASSURANCE_LEVELS)[number];

/** Numeric rank for comparison. Higher is stronger. */
export function assuranceRank(level: AssuranceLevel): number {
  return ASSURANCE_LEVELS.indexOf(level);
}

/** Subject categories an access request can be made for. */
export const SUBJECT_TYPES = ["employee", "contractor", "vendor", "partner"] as const;
export type SubjectType = (typeof SUBJECT_TYPES)[number];

// ---------------------------------------------------------------------------
// Claims — the minimized unit of evidence
// ---------------------------------------------------------------------------

/**
 * A single verified assertion about a subject.
 *
 * This is intentionally *not* a document, a scan, or a profile. It is the
 * smallest thing a compliance rule can act on: "this was verified, to this
 * standard, by this kind of issuer, and it is valid until this date".
 *
 * `evidenceRef` is a **reference**, never content — an opaque pointer that a
 * human auditor with the proper authority could resolve out-of-band. It is
 * never resolved by this system.
 */
export interface Claim {
  /** Stable claim identifier, e.g. `identity_verified`. */
  readonly id: string;
  /** Whether the assertion currently holds. */
  readonly verified: boolean;
  /** How strongly it was verified. */
  readonly assurance: AssuranceLevel;
  /** ISO-8601 timestamp of verification, or null if unknown. */
  readonly verifiedAt: string | null;
  /** ISO-8601 expiry, or null if the claim does not expire. */
  readonly expiresAt: string | null;
  /**
   * Category of issuer (e.g. `government`, `employer`, `training_provider`).
   * A category, deliberately not a named organisation — the identity of the
   * issuer is frequently more sensitive than the claim itself.
   */
  readonly issuerCategory: string | null;
  /** Opaque audit pointer. Never contains personal data. */
  readonly evidenceRef: string | null;
}

export const ClaimSchema = z.object({
  id: z.string().min(1),
  verified: z.boolean(),
  assurance: z.enum(ASSURANCE_LEVELS),
  verifiedAt: z.string().datetime().nullable(),
  expiresAt: z.string().datetime().nullable(),
  issuerCategory: z.string().min(1).nullable(),
  evidenceRef: z.string().min(1).nullable(),
});

/**
 * Where a set of claims came from. Surfaced in the UI and stamped into every
 * audit record so a live decision can never be confused with a demo one.
 */
export type ClaimSourceKind = "LIVE_T3N" | "DEMO_FIXTURE";

/**
 * The result of asking a claim source for a subject's claims.
 *
 * `requestedScopes` vs `authorizedScopes` is the data-minimization receipt:
 * it records exactly what was asked for and exactly what consent permitted.
 */
export interface ClaimSet {
  readonly subjectRef: string;
  readonly source: ClaimSourceKind;
  /** Scopes the policy required us to ask for. */
  readonly requestedScopes: readonly string[];
  /** Scopes consent actually permitted. Subset of `requestedScopes`. */
  readonly authorizedScopes: readonly string[];
  /** Scopes that were required but not consented to. */
  readonly deniedScopes: readonly string[];
  /** Claims actually retrieved. Only ever from `authorizedScopes`. */
  readonly claims: readonly Claim[];
  /** True when the subject has granted this agent the access it asked for. */
  readonly consentVerified: boolean;
  /** Set when the source could not be consulted at all. */
  readonly unavailableReason: string | null;
}

// ---------------------------------------------------------------------------
// Requests
// ---------------------------------------------------------------------------

/**
 * An access request awaiting evaluation.
 *
 * `subjectRef` is a pseudonymous handle (a T3N DID in live mode, a fixture id in
 * demo mode) — never a name, email or employee number. `subjectLabel` exists
 * purely so a human reviewer sees something readable in the UI; it is excluded
 * from audit records by construction.
 */
export interface AccessRequest {
  readonly subjectRef: string;
  readonly subjectLabel?: string;
  readonly subjectType: SubjectType;
  readonly resource: string;
  readonly accessLevel: string;
  /** Explicit policy id. When omitted, the engine resolves one. */
  readonly policyId?: string;
  /** Free-text justification from the requester. Never sent to T3N. */
  readonly justification?: string;
}

export const AccessRequestSchema = z.object({
  subjectRef: z.string().min(1).max(256),
  subjectLabel: z.string().max(120).optional(),
  subjectType: z.enum(SUBJECT_TYPES),
  resource: z.string().min(1).max(120),
  accessLevel: z.string().min(1).max(60),
  policyId: z.string().min(1).max(120).optional(),
  justification: z.string().max(2000).optional(),
});

// ---------------------------------------------------------------------------
// Evaluation output
// ---------------------------------------------------------------------------

/** Why a single requirement passed or failed. */
export interface RequirementResult {
  readonly claimId: string;
  readonly satisfied: boolean;
  /** Machine-readable cause when unsatisfied. */
  readonly reason:
    | "satisfied"
    | "missing"
    | "not_verified"
    | "expired"
    | "insufficient_assurance"
    | "not_authorized";
  readonly detail: string;
}

/** A non-fatal signal that a human reviewer should weigh. */
export interface RiskFlag {
  readonly code: string;
  readonly severity: "low" | "medium" | "high";
  readonly message: string;
}

/**
 * The complete, structured outcome of one evaluation.
 *
 * Everything a reviewer needs to understand *why*, and nothing that would leak
 * the underlying evidence.
 */
export interface DecisionResult {
  readonly decision: Decision;
  readonly policy: string;
  readonly policyVersion: string;
  readonly reason: string;
  readonly requirements: readonly string[];
  readonly satisfiedRequirements: readonly string[];
  readonly missingRequirements: readonly string[];
  readonly requirementDetail: readonly RequirementResult[];
  readonly riskFlags: readonly RiskFlag[];
  readonly nextAction: string;
  readonly timestamp: string;
  readonly auditId: string;
  /** Data-minimization receipt. */
  readonly dataAccess: {
    readonly source: ClaimSourceKind;
    readonly requestedScopes: readonly string[];
    readonly authorizedScopes: readonly string[];
    readonly deniedScopes: readonly string[];
    readonly consentVerified: boolean;
    /** Count of claims read. The values themselves are not echoed. */
    readonly claimsRead: number;
  };
}

// ---------------------------------------------------------------------------
// Audit
// ---------------------------------------------------------------------------

/**
 * An append-only audit row.
 *
 * Deliberately stores `subjectHash` rather than `subjectRef`: a decision can be
 * proven to relate to a given subject by recomputing the hash, without the log
 * itself being a directory of who was evaluated for what.
 */
export interface AuditRecord {
  readonly auditId: string;
  readonly timestamp: string;
  readonly agentId: string;
  readonly requestType: string;
  readonly policyId: string;
  readonly policyVersion: string;
  readonly decision: Decision;
  readonly subjectHash: string;
  readonly subjectType: SubjectType;
  readonly resource: string;
  readonly accessLevel: string;
  readonly claimSource: ClaimSourceKind;
  /** Scope names only — never claim values. */
  readonly scopesRequested: readonly string[];
  readonly scopesAuthorized: readonly string[];
  readonly claimsUsed: readonly string[];
  readonly missingRequirements: readonly string[];
  readonly riskFlags: readonly string[];
  readonly nextAction: string;
  /** Who/what triggered it: `api`, `agent`, `ui`. */
  readonly actor: string;
}
