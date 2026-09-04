/**
 * Regressions found by an adversarial multi-agent review of this codebase.
 *
 * Each test corresponds to a defect that was real, reproduced against the
 * shipped code, and is now fixed. They exist so the same fail-open cannot
 * return quietly.
 */

import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { AuditStore, type AuditRecord } from "@t3n-aca/core";
import { validatePolicyConfig } from "@t3n-aca/policy-engine";
import {
  LiveT3nClaimSource,
  emptyClaimSet,
  type AppConfig,
  type ClaimSource,
  type T3nConnection,
} from "@t3n-aca/t3n";

import { ComplianceService } from "../apps/server/src/service";
import { NOW, claim, claimSet, daysFromNow, loadRealEngine, request } from "./helpers";

const AGENT_DID = "did:t3n:befa498bb1b2c3d4e5f60718293a4b5c6d7e8e66";
const ORG_DID = "did:t3n:bc00034f1122334455667788990011223344a367";

const engine = loadRealEngine();
const EMPLOYEE_SCOPES = ["compliance/employment", "compliance/identity"];
const ev = (req: Parameters<typeof engine.evaluate>[0], claims: Parameters<typeof engine.evaluate>[1]) =>
  engine.evaluate(req, claims, { now: NOW, auditId: "aud_regression" });

describe("a policy must not be shadowed out of existence by an earlier one", () => {
  // `resolvePolicyId` is an ordered first-match. `vendor_readonly_access` sat
  // below `contractor_access`, which is a superset on subject types, resources
  // and access levels — so every request it was written for resolved to the
  // stricter contractor policy instead, demanding a claim vendors do not have
  // and requesting two scopes the governing policy never needed.
  it.each([
    ["vendor", "internal_wiki"],
    ["vendor", "project_workspace"],
    ["partner", "internal_wiki"],
    ["partner", "project_workspace"],
  ])("a %s reading %s resolves to vendor_readonly_access", (subjectType, resource) => {
    expect(
      engine.resolvePolicyId(request({ subjectType: subjectType as never, resource, accessLevel: "read" })),
    ).toBe("vendor_readonly_access");
  });

  it("asks only for the two scopes that policy actually needs", () => {
    expect(engine.requiredScopes("vendor_readonly_access")).toEqual([
      "compliance/company",
      "compliance/identity",
    ]);
  });

  it("a fully verified vendor is approved rather than escalated", () => {
    const result = ev(
      request({ subjectType: "vendor", resource: "internal_wiki", accessLevel: "read" }),
      claimSet([claim("identity_verified"), claim("company_verified")], {
        requestedScopes: ["compliance/company", "compliance/identity"],
      }),
    );
    expect(result.policy).toBe("vendor_readonly_access");
    expect(result.decision).toBe("APPROVED");
  });

  it("the schema now rejects a shadowed policy instead of silently allowing it", () => {
    // Membership in resolution.order was checked; reachability was not.
    const shadowed = {
      version: "1.0.0",
      claims: { identity_verified: { scope: "compliance/identity", label: "Identity", description: "x" } },
      defaults: {
        minimum_assurance: "substantial",
        max_claim_age_days: 365,
        expired_claim_behavior: "review",
        failed_claim_behavior: "deny",
        expiring_soon_days: 30,
      },
      policies: {
        broad: {
          label: "Broad", description: "x",
          applies_to_subject_types: ["contractor", "vendor"],
          resources: ["wiki", "repo"], access_levels: ["read", "write"],
          required_claims: ["identity_verified"],
        },
        narrow: {
          label: "Narrow", description: "x",
          applies_to_subject_types: ["vendor"],
          resources: ["wiki"], access_levels: ["read"],
          required_claims: ["identity_verified"],
        },
      },
      resolution: { order: ["broad", "narrow"], no_match_behavior: "deny" },
    };
    expect(() => validatePolicyConfig(shadowed)).toThrowError(/unreachable/);
  });
});

describe("a claim that cannot be shown to be fresh must not pass as fresh", () => {
  // The age check was skipped entirely when `verifiedAt` was null, which made
  // an undated claim permanently valid — including under privileged_access,
  // whose entire purpose is a tightened window with expired ⇒ deny.
  it("an undated claim does not satisfy a requirement", () => {
    const result = ev(
      request(),
      claimSet([claim("identity_verified"), claim("employment_verified", { verifiedAt: null })], {
        requestedScopes: EMPLOYEE_SCOPES,
      }),
    );
    expect(result.decision).not.toBe("APPROVED");
    expect(result.requirementDetail.find((r) => r.claimId === "employment_verified")?.reason).toBe(
      "expired",
    );
  });

  it("an undated claim is DENIED under a policy whose expired behaviour is deny", () => {
    const result = ev(
      request({ resource: "production_database", accessLevel: "admin" }),
      claimSet(
        [
          claim("identity_verified"),
          claim("employment_verified"),
          claim("security_training", { verifiedAt: null }),
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
  });

  it("an unparseable date is treated as unusable, not as no-expiry", () => {
    // `new Date("nonsense").getTime()` is NaN, and every comparison with NaN is
    // false — so a malformed timestamp previously sailed through both checks.
    for (const bad of [{ expiresAt: "not-a-date" }, { verifiedAt: "13/45/2026" }]) {
      const result = ev(
        request(),
        claimSet([claim("identity_verified"), claim("employment_verified", bad)], {
          requestedScopes: EMPLOYEE_SCOPES,
        }),
      );
      expect(result.decision, JSON.stringify(bad)).not.toBe("APPROVED");
    }
  });

  it("a dated, in-window claim still passes — the fix is not a blanket rejection", () => {
    const result = ev(
      request(),
      claimSet(
        [claim("identity_verified"), claim("employment_verified", { verifiedAt: daysFromNow(-10) })],
        { requestedScopes: EMPLOYEE_SCOPES },
      ),
    );
    expect(result.decision).toBe("APPROVED");
  });
});

// ---------------------------------------------------------------------------
// Second review round.
// ---------------------------------------------------------------------------

/** A minimal, valid audit row. Only the fields these tests read matter. */
function auditRecord(auditId: string): AuditRecord {
  return {
    auditId,
    timestamp: NOW.toISOString(),
    agentId: "t3n-aca",
    requestType: "access_request",
    policyId: "employee_access",
    policyVersion: "1.0.0",
    decision: "DENIED",
    subjectHash: "0".repeat(64),
    subjectType: "employee",
    resource: "internal_wiki",
    accessLevel: "read",
    claimSource: "DEMO_FIXTURE",
    scopesRequested: [],
    scopesAuthorized: [],
    claimsUsed: [],
    missingRequirements: [],
    riskFlags: [],
    nextAction: "none",
    actor: "test",
  };
}

function serviceConfig(auditLogPath: string): AppConfig {
  return {
    claimSource: "demo",
    t3n: null,
    t3nConfigError: "not configured in tests",
    t3nWarnings: [],
    auditLogPath,
    auditSalt: "test-salt",
    port: 0,
    llm: {
      provider: "auto",
      openaiApiKey: null,
      openaiBaseUrl: "https://api.openai.com/v1",
      openaiModel: "gpt-4o-mini",
      anthropicApiKey: null,
      anthropicBaseUrl: null,
      anthropicModel: "claude-sonnet-4-5",
    },
  };
}

/**
 * Build a service whose claim source counts the calls it receives.
 *
 * The source is replaced through a cast rather than a constructor parameter on
 * purpose: the production type deliberately offers no way to swap the source
 * after construction, and a test should not be the reason that guarantee gets
 * weakened.
 */
async function serviceWithCountingSource(dirPrefix: string): Promise<{
  service: ComplianceService;
  audit: AuditStore;
  calls: () => number;
}> {
  const dir = mkdtempSync(join(tmpdir(), dirPrefix));
  const path = join(dir, "audit.jsonl");
  const audit = new AuditStore(path);
  await audit.init();

  let calls = 0;
  const spy: ClaimSource = {
    kind: "DEMO_FIXTURE",
    description: "counts calls",
    async fetchClaims(req) {
      calls++;
      return emptyClaimSet(req.subjectRef, "DEMO_FIXTURE", req.requiredScopes);
    },
  };

  const service = new ComplianceService({
    config: serviceConfig(path),
    engine: loadRealEngine(),
    audit,
    connection: null,
  });
  (service as unknown as { source: ClaimSource }).source = spy;

  return { service, audit, calls: () => calls };
}

describe("a torn audit line must not take the next decision down with it", () => {
  // `init()` skipped an unparseable trailing line, which read as robust. It was
  // not: the file still ended mid-record, so the next `append()` concatenated
  // its JSON onto that fragment and produced one more unparseable line. The
  // decision that had been written *successfully* then vanished on the next
  // load — one interrupted write silently destroyed two records, and kept
  // destroying one more on every restart after that.
  it("keeps a decision appended after a truncated line", async () => {
    const dir = mkdtempSync(join(tmpdir(), "t3n-audit-torn-"));
    const path = join(dir, "audit.jsonl");

    // A complete record, then a write cut off mid-object: no trailing newline.
    writeFileSync(
      path,
      `${JSON.stringify(auditRecord("aud_first"))}\n{"auditId":"aud_torn","decis`,
      "utf8",
    );

    const store = new AuditStore(path);
    await store.init();
    expect(store.wasRepaired).toBe(true);
    expect(store.query().total).toBe(1);

    await store.append(auditRecord("aud_second"));

    // Re-reading from disk is the part that used to lose the record.
    const reopened = new AuditStore(path);
    await reopened.init();
    expect(reopened.query().records.map((r) => r.auditId).sort()).toEqual([
      "aud_first",
      "aud_second",
    ]);
  });

  it("reports an intact journal as intact", async () => {
    const dir = mkdtempSync(join(tmpdir(), "t3n-audit-clean-"));
    const path = join(dir, "audit.jsonl");
    writeFileSync(path, `${JSON.stringify(auditRecord("aud_ok"))}\n`, "utf8");
    const store = new AuditStore(path);
    await store.init();
    expect(store.wasRepaired).toBe(false);
    expect(store.query().total).toBe(1);
  });
});

describe("a request no policy governs must not be sent to the claim source", () => {
  // The decision is already DENIED and the scope set is empty, yet the source
  // was called anyway — which in live mode means the subject's DID travels to
  // Terminal 3 in a delegation check, and a credit is spent, for a lookup whose
  // result cannot change the answer. The cheapest disclosure is the one that
  // never happens.
  it("does not touch the source, and still writes an audit row", async () => {
    const { service, audit, calls } = await serviceWithCountingSource("t3n-nopolicy-");

    // `contractor` + `production_database` + `admin` matches no policy:
    // `privileged_access` is the only one covering that resource and it applies
    // to employees only, while `contractor_access` does not list the resource.
    const req = request({
      subjectType: "contractor",
      resource: "production_database",
      accessLevel: "admin",
    });
    expect(loadRealEngine().resolvePolicyId(req)).toBeNull();

    const { decision, audit: row } = await service.evaluate(req, { now: NOW });

    expect(calls()).toBe(0);
    expect(decision.decision).toBe("DENIED");
    expect(row.scopesRequested).toEqual([]);
    // Skipping the lookup must not skip the record.
    expect(audit.query().total).toBe(1);
    expect(audit.get(row.auditId)?.decision).toBe("DENIED");
  });

  it("still calls the source when a policy does govern the request", async () => {
    const { service, calls } = await serviceWithCountingSource("t3n-policy-");
    await service.evaluate(
      request({ subjectType: "employee", resource: "internal_wiki", accessLevel: "read" }),
      { now: NOW },
    );
    expect(calls()).toBe(1);
  });
});

describe("an unknown agent identity is a failure, not an empty grant set", () => {
  // `readGrantedScopes` returned `new Set()` when the agent DID could not be
  // determined. Every scope then read as "consent does not cover this", so the
  // operator was told to go and ask a subject for permission that had already
  // been given, and nothing in the UI pointed at the agent identity as the real
  // problem. A configuration fault must never be rendered as a consent answer.
  it("throws rather than reporting no consent", async () => {
    const source = new LiveT3nClaimSource({
      agentDid: null,
      orgDid: ORG_DID,
      contractId: "tee:org-data/contracts",
      async tenantOrgData() {
        throw new Error("must not be reached: the DID check comes first");
      },
    } as unknown as T3nConnection);

    const readGrantedScopes = (
      source as unknown as { readGrantedScopes(orgDid: string): Promise<Set<string>> }
    ).readGrantedScopes.bind(source);

    await expect(readGrantedScopes(ORG_DID)).rejects.toThrow(/agent DID/i);
  });

  it("reads the grant record when the agent DID is known", async () => {
    const source = new LiveT3nClaimSource({
      agentDid: AGENT_DID,
      orgDid: ORG_DID,
      contractId: "tee:org-data/contracts",
      async tenantOrgData() {
        return {
          async grantsGet() {
            return {
              contract_id: "tee:org-data/contracts",
              grants: [
                {
                  user_did: AGENT_DID,
                  functions: ["org-data-get", "org-data-list"],
                  scopes: ["compliance/identity"],
                },
                // Another principal's grant must not widen ours.
                {
                  user_did: ORG_DID,
                  functions: ["*"],
                  scopes: ["compliance/background"],
                },
              ],
            };
          },
        };
      },
    } as unknown as T3nConnection);

    const readGrantedScopes = (
      source as unknown as { readGrantedScopes(orgDid: string): Promise<Set<string>> }
    ).readGrantedScopes.bind(source);

    expect([...(await readGrantedScopes(ORG_DID))]).toEqual(["compliance/identity"]);
  });
});
