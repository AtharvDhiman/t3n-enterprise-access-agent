/**
 * Policy engine — the component that actually decides.
 *
 * Covers every decision path and, importantly, the *distinctions between* them:
 * absent evidence must not behave like failed evidence, and a consent gap must
 * not behave like either.
 */

import { describe, expect, it } from "vitest";

import { NOW, claim, claimSet, daysFromNow, loadRealEngine, request } from "./helpers";

const engine = loadRealEngine();
const EMPLOYEE_SCOPES = ["compliance/employment", "compliance/identity"];

const evaluate = (req: Parameters<typeof engine.evaluate>[0], claims: Parameters<typeof engine.evaluate>[1]) =>
  engine.evaluate(req, claims, { now: NOW, auditId: "aud_test" });

describe("APPROVED", () => {
  it("approves when every requirement is satisfied and no manual approval is needed", () => {
    const result = evaluate(
      request(),
      claimSet([claim("identity_verified"), claim("employment_verified")], {
        requestedScopes: EMPLOYEE_SCOPES,
      }),
    );

    expect(result.decision).toBe("APPROVED");
    expect(result.policy).toBe("employee_access");
    expect(result.satisfiedRequirements).toEqual(["identity_verified", "employment_verified"]);
    expect(result.missingRequirements).toEqual([]);
  });

  it("is deterministic — identical inputs give an identical decision", () => {
    const req = request();
    const claims = claimSet([claim("identity_verified"), claim("employment_verified")], {
      requestedScopes: EMPLOYEE_SCOPES,
    });
    const a = evaluate(req, claims);
    const b = evaluate(req, claims);
    expect(a).toEqual(b);
  });
});

describe("REVIEW_REQUIRED", () => {
  it("escalates when a required claim is simply absent", () => {
    const result = evaluate(
      request(),
      claimSet([claim("identity_verified")], { requestedScopes: EMPLOYEE_SCOPES }),
    );

    expect(result.decision).toBe("REVIEW_REQUIRED");
    expect(result.missingRequirements).toEqual(["employment_verified"]);
    expect(
      result.requirementDetail.find((r) => r.claimId === "employment_verified")?.reason,
    ).toBe("missing");
  });

  it("escalates — and names the scope — when consent is withheld", () => {
    const result = evaluate(
      request(),
      claimSet([claim("identity_verified")], {
        requestedScopes: EMPLOYEE_SCOPES,
        authorizedScopes: ["compliance/identity"],
      }),
    );

    expect(result.decision).toBe("REVIEW_REQUIRED");
    const detail = result.requirementDetail.find((r) => r.claimId === "employment_verified");
    expect(detail?.reason).toBe("not_authorized");
    expect(result.nextAction).toContain("compliance/employment");
    expect(result.riskFlags.map((f) => f.code)).toContain("CONSENT_NOT_VERIFIED");
  });

  it("escalates when assurance is below the policy minimum", () => {
    const result = evaluate(
      request(),
      claimSet(
        [claim("identity_verified"), claim("employment_verified", { assurance: "substantial" })],
        { requestedScopes: EMPLOYEE_SCOPES },
      ),
    );

    expect(result.decision).toBe("REVIEW_REQUIRED");
    expect(
      result.requirementDetail.find((r) => r.claimId === "employment_verified")?.reason,
    ).toBe("insufficient_assurance");
  });

  it("escalates when a policy demands a human approver even though all checks pass", () => {
    const result = evaluate(
      request({ resource: "production_database", accessLevel: "admin" }),
      claimSet(
        [claim("identity_verified"), claim("employment_verified"), claim("security_training")],
        {
          requestedScopes: [
            "compliance/background",
            "compliance/employment",
            "compliance/identity",
            "compliance/training",
          ],
        },
      ),
    );

    expect(result.policy).toBe("privileged_access");
    expect(result.decision).toBe("REVIEW_REQUIRED");
    // Nothing failed — the escalation is the control itself.
    expect(result.missingRequirements).toEqual([]);
    expect(result.riskFlags.map((f) => f.code)).toContain("MANUAL_APPROVAL_REQUIRED");
  });
});

describe("DENIED", () => {
  it("denies when a required verification explicitly failed", () => {
    const result = evaluate(
      request({ subjectType: "contractor", resource: "source_repository", accessLevel: "write" }),
      claimSet(
        [
          claim("identity_verified"),
          claim("contractor_verified"),
          claim("company_verified", { verified: false, assurance: "none" }),
        ],
        {
          requestedScopes: [
            "compliance/company",
            "compliance/contractor",
            "compliance/identity",
            "compliance/legal",
          ],
        },
      ),
    );

    expect(result.decision).toBe("DENIED");
    expect(
      result.requirementDetail.find((r) => r.claimId === "company_verified")?.reason,
    ).toBe("not_verified");
    expect(result.riskFlags.map((f) => f.code)).toContain("FAILED_VERIFICATION");
  });

  it("denies an expired claim under a policy whose expired behaviour is deny", () => {
    const result = evaluate(
      request({ resource: "production_database", accessLevel: "admin" }),
      claimSet(
        [
          claim("identity_verified"),
          claim("employment_verified"),
          claim("security_training", { expiresAt: daysFromNow(-1) }),
        ],
        {
          requestedScopes: [
            "compliance/background",
            "compliance/employment",
            "compliance/identity",
            "compliance/training",
          ],
        },
      ),
    );

    expect(result.policy).toBe("privileged_access");
    expect(result.decision).toBe("DENIED");
    expect(
      result.requirementDetail.find((r) => r.claimId === "security_training")?.reason,
    ).toBe("expired");
  });

  it("denies a request outside the policy's declared envelope", () => {
    const result = evaluate(
      request({ policyId: "employee_access", subjectType: "contractor" }),
      claimSet([claim("identity_verified"), claim("employment_verified")], {
        requestedScopes: EMPLOYEE_SCOPES,
      }),
    );

    expect(result.decision).toBe("DENIED");
    expect(result.riskFlags.map((f) => f.code)).toContain("OUT_OF_POLICY_SCOPE");
  });

  it("fails closed when no policy matches at all", () => {
    const result = evaluate(
      request({ resource: "nonexistent_resource" }),
      claimSet([], { requestedScopes: [] }),
    );

    expect(result.decision).toBe("DENIED");
    expect(result.policy).toBe("(none)");
    expect(result.riskFlags.map((f) => f.code)).toContain("NO_MATCHING_POLICY");
    // Nothing may be read when no policy authorised reading anything.
    expect(result.dataAccess.claimsRead).toBe(0);
  });
});

describe("the absent-vs-failed distinction", () => {
  it("treats a missing claim and a failed claim differently, on identical requests", () => {
    const base = request();
    const missing = evaluate(
      base,
      claimSet([claim("identity_verified")], { requestedScopes: EMPLOYEE_SCOPES }),
    );
    const failed = evaluate(
      base,
      claimSet([claim("identity_verified"), claim("employment_verified", { verified: false })], {
        requestedScopes: EMPLOYEE_SCOPES,
      }),
    );

    expect(missing.decision).toBe("REVIEW_REQUIRED");
    expect(failed.decision).toBe("DENIED");
  });
});

describe("staleness", () => {
  it("rejects a claim older than the policy's maximum age", () => {
    const result = evaluate(
      request(),
      claimSet(
        [
          claim("identity_verified"),
          claim("employment_verified", { verifiedAt: daysFromNow(-400), expiresAt: null }),
        ],
        { requestedScopes: EMPLOYEE_SCOPES },
      ),
    );

    expect(result.decision).toBe("REVIEW_REQUIRED");
    expect(
      result.requirementDetail.find((r) => r.claimId === "employment_verified")?.reason,
    ).toBe("expired");
  });

  it("flags a claim that is valid now but expires soon", () => {
    const result = evaluate(
      request(),
      claimSet(
        [claim("identity_verified"), claim("employment_verified", { expiresAt: daysFromNow(5) })],
        { requestedScopes: EMPLOYEE_SCOPES },
      ),
    );

    expect(result.decision).toBe("APPROVED");
    expect(result.riskFlags.map((f) => f.code)).toContain("CLAIM_EXPIRING_SOON");
  });
});

describe("data minimization", () => {
  it("requests only the scopes its policy declares", () => {
    const scopes = engine.requiredScopes("employee_access");
    expect(scopes).toEqual(EMPLOYEE_SCOPES);
    expect(scopes).not.toContain("compliance/training");
    expect(scopes).not.toContain("compliance/background");
  });

  it("records requested vs. authorized scopes on every decision", () => {
    const result = evaluate(
      request(),
      claimSet([claim("identity_verified")], {
        requestedScopes: EMPLOYEE_SCOPES,
        authorizedScopes: ["compliance/identity"],
      }),
    );

    expect(result.dataAccess.requestedScopes).toEqual(EMPLOYEE_SCOPES);
    expect(result.dataAccess.authorizedScopes).toEqual(["compliance/identity"]);
    expect(result.dataAccess.deniedScopes).toEqual(["compliance/employment"]);
    expect(result.dataAccess.consentVerified).toBe(false);
  });

  it("flags demo-sourced decisions so they can never pass as live", () => {
    const result = evaluate(
      request(),
      claimSet([claim("identity_verified"), claim("employment_verified")], {
        requestedScopes: EMPLOYEE_SCOPES,
        source: "DEMO_FIXTURE",
      }),
    );
    expect(result.riskFlags.map((f) => f.code)).toContain("DEMO_DATA");
  });

  it("does not flag live decisions as demo", () => {
    const result = evaluate(
      request(),
      claimSet([claim("identity_verified"), claim("employment_verified")], {
        requestedScopes: EMPLOYEE_SCOPES,
        source: "LIVE_T3N",
      }),
    );
    expect(result.riskFlags.map((f) => f.code)).not.toContain("DEMO_DATA");
  });
});

describe("policy resolution", () => {
  it("resolves privileged access ahead of employee access for a privileged resource", () => {
    expect(
      engine.resolvePolicyId(request({ resource: "production_database", accessLevel: "admin" })),
    ).toBe("privileged_access");
  });

  it("honours an explicitly named policy rather than re-resolving", () => {
    expect(
      engine.resolvePolicyId(
        request({ policyId: "vendor_readonly_access", subjectType: "vendor", resource: "internal_wiki" }),
      ),
    ).toBe("vendor_readonly_access");
  });

  it("returns null when nothing matches", () => {
    expect(engine.resolvePolicyId(request({ resource: "unknown_thing" }))).toBeNull();
  });

  it("throws a helpful error for an unknown policy id", () => {
    expect(() => engine.getPolicy("no_such_policy")).toThrowError(/no policy with id/);
  });
});
