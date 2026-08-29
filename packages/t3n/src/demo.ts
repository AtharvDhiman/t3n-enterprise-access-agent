/**
 * Deterministic demo fixtures.
 *
 * ## The one rule this file must never break
 *
 * Demo data must never be presentable as Terminal 3 data. Every claim set
 * produced here is stamped `DEMO_FIXTURE`, which the policy engine turns into a
 * `DEMO_DATA` risk flag, which the UI renders as a banner and the audit log
 * records permanently. There is no configuration that makes a fixture look
 * live, and the live source never falls back to this file.
 *
 * Demo mode exists so the product is understandable without credentials — not
 * so it can pretend to have them.
 *
 * ## Determinism, and why it is anchored to *today*
 *
 * Claim timestamps are offsets from **the start of the current UTC day**, not
 * from a hard-coded calendar date. That choice is deliberate and was made after
 * getting it wrong: pinning fixtures to a fixed past epoch makes them silently
 * rot, because a claim written to expire "20 days after the epoch" eventually
 * falls into the past and starts producing DENIED where the scenario intends
 * REVIEW_REQUIRED. A demo that degrades a month after it was written is worse
 * than one that is honest about its clock.
 *
 * Anchoring to the current day keeps what actually matters constant — the
 * *decision* each scenario produces — for as long as the project exists. Tests
 * that need an exact instant inject `now` into the engine directly rather than
 * relying on these fixtures.
 */

import type { Claim, ClaimSet, SubjectType } from "@t3n-aca/core";
import { emptyClaimSet, type ClaimRequest, type ClaimSource } from "./source.ts";

const DAY = 86_400_000;

/** Start of the current UTC day. Stable within a run and across a day. */
function todayUtcStart(): number {
  const now = new Date();
  return Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
}

const at = (offsetDays: number): string =>
  new Date(todayUtcStart() + offsetDays * DAY).toISOString();

function claim(
  id: string,
  overrides: Partial<Claim> & Pick<Claim, "verified" | "assurance">,
): Claim {
  return {
    id,
    verifiedAt: at(-120),
    expiresAt: at(240),
    issuerCategory: null,
    evidenceRef: null,
    ...overrides,
  };
}

export interface DemoScenario {
  id: string;
  label: string;
  /** What this scenario is meant to demonstrate. */
  narrative: string;
  subjectRef: string;
  subjectLabel: string;
  subjectType: SubjectType;
  /** Suggested request, so the UI can load a scenario in one click. */
  suggestedResource: string;
  suggestedAccessLevel: string;
  suggestedPolicy: string;
  /** The decision this scenario is built to produce. */
  expectedDecision: "APPROVED" | "REVIEW_REQUIRED" | "DENIED";
  /** Scopes the subject has consented to. */
  consentedScopes: string[];
  claims: Claim[];
}

/**
 * The four scenarios, one per decision path plus the manual-approval case.
 *
 * Between them they exercise every reason an evaluation can fail: absent
 * consent, absent evidence, failed evidence, and a policy control that fires
 * even when everything passes.
 */
export const DEMO_SCENARIOS: readonly DemoScenario[] = [
  {
    id: "verified-employee",
    label: "A — Verified employee",
    narrative:
      "Every requirement satisfied at high assurance, and the policy does not demand a human approver. The straightforward approval path.",
    subjectRef: "demo:subject:alice",
    subjectLabel: "Alice (employee)",
    subjectType: "employee",
    suggestedResource: "employee_dashboard",
    suggestedAccessLevel: "read",
    suggestedPolicy: "employee_access",
    expectedDecision: "APPROVED",
    consentedScopes: ["compliance/identity", "compliance/employment"],
    claims: [
      claim("identity_verified", {
        verified: true,
        assurance: "high",
        issuerCategory: "government",
        evidenceRef: "vc:sha256:demo-alice-identity",
      }),
      claim("employment_verified", {
        verified: true,
        assurance: "high",
        issuerCategory: "employer",
        evidenceRef: "vc:sha256:demo-alice-employment",
      }),
    ],
  },

  {
    id: "missing-employment",
    label: "B — Consent withheld for employment",
    narrative:
      "Identity is verified, but the subject has not consented to the employment scope. The agent cannot see that evidence, so it must not guess — it escalates. Note that the missing item is a *consent* gap, not a failed check.",
    subjectRef: "demo:subject:ben",
    subjectLabel: "Ben (employee)",
    subjectType: "employee",
    suggestedResource: "employee_dashboard",
    suggestedAccessLevel: "read",
    suggestedPolicy: "employee_access",
    expectedDecision: "REVIEW_REQUIRED",
    // Employment scope deliberately absent.
    consentedScopes: ["compliance/identity"],
    claims: [
      claim("identity_verified", {
        verified: true,
        assurance: "high",
        issuerCategory: "government",
        evidenceRef: "vc:sha256:demo-ben-identity",
      }),
    ],
  },

  {
    id: "failed-verification",
    label: "C — Failed company verification",
    narrative:
      "A contractor whose employing company was checked and did not pass. This is an explicit negative result, not an absence of information — so the policy denies rather than escalating.",
    subjectRef: "demo:subject:carla",
    subjectLabel: "Carla (contractor)",
    subjectType: "contractor",
    suggestedResource: "source_repository",
    suggestedAccessLevel: "write",
    suggestedPolicy: "contractor_access",
    expectedDecision: "DENIED",
    consentedScopes: [
      "compliance/identity",
      "compliance/contractor",
      "compliance/company",
      "compliance/legal",
    ],
    claims: [
      claim("identity_verified", {
        verified: true,
        assurance: "high",
        issuerCategory: "government",
        evidenceRef: "vc:sha256:demo-carla-identity",
      }),
      claim("contractor_verified", {
        verified: true,
        assurance: "high",
        issuerCategory: "employer",
        evidenceRef: "vc:sha256:demo-carla-contractor",
      }),
      // The explicit failure that drives the denial.
      claim("company_verified", {
        verified: false,
        assurance: "none",
        issuerCategory: "registry",
        evidenceRef: "vc:sha256:demo-carla-company",
      }),
      claim("nda_signed", { verified: true, assurance: "substantial", issuerCategory: "employer" }),
    ],
  },

  {
    id: "privileged-manual-approval",
    label: "D — Privileged access, all checks pass",
    narrative:
      "Every requirement is satisfied, yet the outcome is still REVIEW_REQUIRED: the privileged-access policy always requires a named human approver. A control that fires by design, not a failure — and the clearest illustration that the engine, not the model, decides.",
    subjectRef: "demo:subject:dara",
    subjectLabel: "Dara (employee)",
    subjectType: "employee",
    suggestedResource: "production_database",
    suggestedAccessLevel: "admin",
    suggestedPolicy: "privileged_access",
    expectedDecision: "REVIEW_REQUIRED",
    consentedScopes: [
      "compliance/identity",
      "compliance/employment",
      "compliance/training",
      "compliance/background",
    ],
    claims: [
      claim("identity_verified", {
        verified: true,
        assurance: "high",
        issuerCategory: "government",
        evidenceRef: "vc:sha256:demo-dara-identity",
      }),
      claim("employment_verified", {
        verified: true,
        assurance: "high",
        issuerCategory: "employer",
        evidenceRef: "vc:sha256:demo-dara-employment",
      }),
      claim("security_training", {
        verified: true,
        assurance: "high",
        issuerCategory: "training_provider",
        // Deliberately close to expiry so the "expiring soon" flag is visible.
        expiresAt: at(20),
        evidenceRef: "vc:sha256:demo-dara-training",
      }),
      claim("background_check", {
        verified: true,
        assurance: "high",
        issuerCategory: "screening_provider",
        evidenceRef: "vc:sha256:demo-dara-background",
      }),
    ],
  },
];

export function findScenario(subjectRef: string): DemoScenario | null {
  return DEMO_SCENARIOS.find((s) => s.subjectRef === subjectRef) ?? null;
}

export class DemoClaimSource implements ClaimSource {
  readonly kind = "DEMO_FIXTURE" as const;
  readonly description = "Deterministic local fixtures — not Terminal 3 data";

  async fetchClaims(request: ClaimRequest): Promise<ClaimSet> {
    const { subjectRef, requiredScopes } = request;
    const scenario = findScenario(subjectRef);

    if (!scenario) {
      // An unknown subject is genuinely unknown. Returning "no consent, no
      // claims" is the truthful answer and drives REVIEW_REQUIRED, which is
      // what should happen for someone the system has never heard of.
      return emptyClaimSet(
        subjectRef,
        this.kind,
        requiredScopes,
        "No demo fixture exists for this subject.",
      );
    }

    const authorizedScopes = requiredScopes.filter((s) => scenario.consentedScopes.includes(s));
    const deniedScopes = requiredScopes.filter((s) => !scenario.consentedScopes.includes(s));

    // Only surface claims whose scope consent actually covers — the fixture
    // enforces the same minimization rule the live path does, so demo and live
    // decisions are comparable.
    const claimScopes = request.claimScopes;
    const visible = scenario.claims.filter((c) => {
      const scope = claimScopes[c.id];
      return scope !== undefined && authorizedScopes.includes(scope);
    });

    return {
      subjectRef,
      source: this.kind,
      requestedScopes: requiredScopes,
      authorizedScopes,
      deniedScopes,
      claims: visible,
      consentVerified: deniedScopes.length === 0,
      unavailableReason: null,
    };
  }
}
