/**
 * Regressions found by an adversarial multi-agent review of this codebase.
 *
 * Each test corresponds to a defect that was real, reproduced against the
 * shipped code, and is now fixed. They exist so the same fail-open cannot
 * return quietly.
 */

import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { AuditStore, hashSubject, type AuditRecord } from "@t3n-aca/core";
import { parsePolicyConfig, validatePolicyConfig } from "@t3n-aca/policy-engine";
import {
  DEMO_SCENARIOS,
  DemoClaimSource,
  LiveT3nClaimSource,
  T3nConnection,
  emptyClaimSet,
  findScenario,
  type AppConfig,
  type ClaimSource,
} from "@t3n-aca/t3n";

import { ComplianceService } from "../apps/server/src/service";
import { NOW, POLICY_PATH, claim, claimSet, daysFromNow, loadRealEngine, request } from "./helpers";

const AGENT_DID = "did:t3n:befa498bb1b2c3d4e5f60718293a4b5c6d7e8e66";
const ORG_DID = "did:t3n:bc00034f1122334455667788990011223344a367";
const SUBJECT_DID = "did:t3n:2eaed84a2d5d72c2f8a19f1a832e8d63d96a9e5a";
const OTHER_DID = "did:t3n:1111111111111111111111111111111111111111";

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
/** Like `serviceWithCountingSource`, but keeps the real demo source's behaviour. */
async function serviceWithRecordingSource(dirPrefix: string): Promise<{
  service: ComplianceService;
  audit: AuditStore;
}> {
  const dir = mkdtempSync(join(tmpdir(), dirPrefix));
  const path = join(dir, "audit.jsonl");
  const audit = new AuditStore(path);
  await audit.init();
  const service = new ComplianceService({
    config: serviceConfig(path),
    engine: loadRealEngine(),
    audit,
    connection: null,
  });
  return { service, audit };
}

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

describe("a session-expiry storm must produce one re-authentication, not one per request", () => {
  // A T3N session TTL elapses for every in-flight request at once, and each one
  // calls reconnectAfterExpiry(). Because reset() clears `inflight` along with
  // the cached sessions, each caller cleared the slot the previous one had just
  // filled and started its own full re-auth: N trust-manifest fetches, N
  // handshakes, N authenticates, and N-1 orphaned sessions on the node. A slow
  // loser's failure path then stamped state="error"/mode="UNAVAILABLE" over a
  // connection a sibling had already brought up.
  function connectionWithCountingConnect(delayMs: number) {
    const conn = Object.create(T3nConnection.prototype) as T3nConnection;
    const self = conn as unknown as Record<string, unknown>;
    self.config = { environment: "testnet", contractId: "tee:org-data/contracts" };
    self.log = { info() {}, warn() {}, error() {}, child: () => self.log };
    self.inflight = null;
    self.reconnecting = null;
    self.state = "disconnected";
    self.tenantSession = null;
    self.agentSession = null;
    self.mode = "UNAVAILABLE";

    let calls = 0;
    self.doConnect = async () => {
      calls++;
      (self as { state: string }).state = "connecting";
      await new Promise((r) => setTimeout(r, delayMs));
      (self as { state: string }).state = "connected";
      (self as { tenantSession: unknown }).tenantSession = { did: "did:t3n:tenant" };
    };
    return { conn, calls: () => calls };
  }

  it("coalesces concurrent reconnects into a single attempt", async () => {
    const { conn, calls } = connectionWithCountingConnect(40);

    await conn.connect();
    expect(calls()).toBe(1);

    // Five requests all discover the expired session at the same moment.
    await Promise.all([
      conn.reconnectAfterExpiry(),
      conn.reconnectAfterExpiry(),
      conn.reconnectAfterExpiry(),
      conn.reconnectAfterExpiry(),
      conn.reconnectAfterExpiry(),
    ]);

    // One re-authentication, not five.
    expect(calls()).toBe(2);
    expect(conn.isConnected()).toBe(true);
  });

  it("still reconnects again when the session expires a second time", async () => {
    const { conn, calls } = connectionWithCountingConnect(10);
    await conn.connect();
    await conn.reconnectAfterExpiry();
    await conn.reconnectAfterExpiry();
    // Coalescing must not latch: three distinct expiry events, three connects.
    expect(calls()).toBe(3);
  });

  it("does not let a finished attempt retire a newer attempt's slot", async () => {
    const { conn } = connectionWithCountingConnect(20);
    const self = conn as unknown as { inflight: Promise<void> | null };

    const first = conn.connect();
    conn.reset("forced");
    const second = conn.connect();
    const slotDuringSecond = self.inflight;

    await first;
    // `first` settling must leave `second`'s slot alone — clearing it let the
    // next caller start a third connect while the second was still running.
    expect(self.inflight).toBe(slotDuringSecond);
    await second;
    expect(self.inflight).toBeNull();
  });
});

describe("a journal that cannot be written must not report itself healthy", () => {
  // `init()` only ever reads, so a journal on a read-only mount or under a path
  // the process cannot create loaded perfectly and `GET /api/health` returned
  // `{ok: true}` — while every POST /api/requests returned 500, because a
  // decision that cannot be recorded is not made. The documented liveness probe
  // reported a total outage as healthy.
  it("reports a usable path as writable", async () => {
    const dir = mkdtempSync(join(tmpdir(), "t3n-writable-"));
    const store = new AuditStore(join(dir, "nested", "audit.jsonl"));
    const result = await store.writable();
    expect(result).toEqual({ writable: true, reason: null });
  });

  it("reports an unusable path as not writable, and names it", async () => {
    const dir = mkdtempSync(join(tmpdir(), "t3n-unwritable-"));
    // A file where a directory is required: creating the parent fails with
    // ENOTDIR on every platform, unlike permission bits which Windows ignores.
    const blocker = join(dir, "blocker");
    writeFileSync(blocker, "not a directory", "utf8");
    const path = join(blocker, "sub", "audit.jsonl");

    const store = new AuditStore(path);
    const result = await store.writable();

    expect(result.writable).toBe(false);
    expect(result.reason).toContain(path);

    // And the thing the health check exists to predict: appending really does
    // fail on this path, so `writable: false` is not a false alarm.
    await expect(
      store.append({
        auditId: "aud_x",
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
      }),
    ).rejects.toThrow();
  });
});

describe("a scope read must page, and must never pass off a truncated read as complete", () => {
  // `dataList` returns one page plus a `next_offset`. Both `next_offset` and
  // `total` were ignored, so every scope read stopped at the first 50 entries
  // with nothing anywhere saying so: from the 51st subject in a shared scope
  // onwards, a fully consented and perfectly valid claim was never read, the
  // ClaimSet still said consentVerified with no risk flag, and the engine
  // stated positively that the subject had no such evidence.
  function sourceOverPages(totalEntries: number) {
    const PAGE = 50;
    let listCalls = 0;
    const entryFor = (i: number) => `entry${i}`;

    const source = new LiveT3nClaimSource({
      agentDid: AGENT_DID,
      orgDid: ORG_DID,
      contractId: "tee:org-data/contracts",
      async readerOrgData() {
        return {
          async dataList({ offset = 0 }: { offset?: number }) {
            listCalls++;
            const ids: string[] = [];
            for (let i = offset; i < Math.min(offset + PAGE, totalEntries); i++) {
              ids.push(entryFor(i));
            }
            const next = offset + PAGE < totalEntries ? offset + PAGE : null;
            return { entry_ids: ids, next_offset: next, total: totalEntries };
          },
          async dataGet({ entryId }: { entryId: string }) {
            const index = Number(entryId.replace("entry", ""));
            const record = {
              v: 1,
              // Only the last entry belongs to our subject — so if the read
              // stops early, the claim is silently missed.
              subject: index === totalEntries - 1 ? SUBJECT_DID : OTHER_DID,
              claim: "identity_verified",
              verified: true,
              assurance: "high",
              verifiedAt: daysFromNow(-30),
              expiresAt: daysFromNow(300),
              issuerCategory: "government",
              evidenceRef: "vc:sha256:identity_verified",
            };
            return {
              payload_hex: Buffer.from(JSON.stringify(record), "utf8").toString("hex"),
            };
          },
        };
      },
    } as unknown as T3nConnection);

    const readScope = (
      source as unknown as {
        readScope(
          orgDid: string,
          scope: string,
          subjectRef: string,
        ): Promise<{ claims: unknown[]; dropped: number }>;
      }
    ).readScope.bind(source);

    return { readScope, listCalls: () => listCalls };
  }

  it("reads past the first page to find a claim at entry 120", async () => {
    const { readScope, listCalls } = sourceOverPages(121);
    const result = await readScope(ORG_DID, "compliance/identity", SUBJECT_DID);
    // Three pages: 0-49, 50-99, 100-120.
    expect(listCalls()).toBe(3);
    expect(result.claims).toHaveLength(1);
    expect(result.dropped).toBe(0);
  });

  it("still stops after one page when the scope fits in one", async () => {
    const { readScope, listCalls } = sourceOverPages(12);
    await readScope(ORG_DID, "compliance/identity", SUBJECT_DID);
    expect(listCalls()).toBe(1);
  });

  it("refuses rather than returning a partial read when the ceiling is hit", async () => {
    const { readScope } = sourceOverPages(5000);
    // Failing here is the point: the caller turns this into a degraded scope,
    // so a truncated read can never be mistaken for an absence of evidence.
    await expect(readScope(ORG_DID, "compliance/identity", SUBJECT_DID)).rejects.toThrow(
      /too large|more than/i,
    );
  });
});

describe("an inclusive audit date bound must include that whole day", () => {
  // `from`/`to` were compared as raw strings against full ISO timestamps, so
  // `to=2026-08-29` excluded every record on 2026-08-29 — "2026-08-29T12:00Z"
  // sorts after "2026-08-29". An auditor pulling everything up to an incident
  // date silently lost the day the incident happened.
  function storeWith(timestamps: string[]): AuditStore {
    const dir = mkdtempSync(join(tmpdir(), "t3n-bounds-"));
    const store = new AuditStore(join(dir, "audit.jsonl"));
    const rows = timestamps.map((ts, i) => ({ ...auditRecord(`aud_${i}`), timestamp: ts }));
    (store as unknown as { records: AuditRecord[]; loaded: boolean }).records = rows;
    (store as unknown as { loaded: boolean }).loaded = true;
    return store;
  }

  const DAY_BEFORE = "2026-08-28T23:59:59.000Z";
  const MORNING = "2026-08-29T00:00:00.000Z";
  const MIDDAY = "2026-08-29T12:00:00.000Z";
  const LAST_MS = "2026-08-29T23:59:59.999Z";
  const NEXT_DAY = "2026-08-30T00:00:01.000Z";

  it("includes every record on the `to` date", () => {
    const store = storeWith([DAY_BEFORE, MORNING, MIDDAY, LAST_MS, NEXT_DAY]);
    const page = store.query({ to: "2026-08-29", limit: 500 });
    expect(page.records.map((r) => r.timestamp).sort()).toEqual([
      DAY_BEFORE,
      MORNING,
      MIDDAY,
      LAST_MS,
    ]);
  });

  it("includes every record on the `from` date", () => {
    const store = storeWith([DAY_BEFORE, MORNING, MIDDAY, NEXT_DAY]);
    const page = store.query({ from: "2026-08-29", limit: 500 });
    expect(page.records.map((r) => r.timestamp).sort()).toEqual([MORNING, MIDDAY, NEXT_DAY]);
  });

  it("still honours a full ISO bound", () => {
    const store = storeWith([MORNING, MIDDAY, NEXT_DAY]);
    expect(store.query({ to: "2026-08-29T12:00:00.000Z", limit: 500 }).total).toBe(2);
  });

  it("ignores an unparseable bound rather than matching nothing", () => {
    // Returning zero rows for a typo is the most misleading answer an audit
    // log can give — it reads as "no such decisions were ever made".
    const store = storeWith([MORNING, MIDDAY, NEXT_DAY]);
    expect(store.query({ to: "last tuesday", limit: 500 }).total).toBe(3);
  });
});

describe("a claim verified in the future is not fresh evidence", () => {
  // `ageDays = now - verifiedAt` went negative for a future date, so the
  // `> maxClaimAgeDays` test passed trivially: the one input that should never
  // be trusted was the only one that could never go stale.
  const scopes = ["compliance/employment", "compliance/identity"];

  it("does not satisfy a requirement", () => {
    const result = ev(
      request({ subjectType: "employee", resource: "internal_wiki", accessLevel: "read" }),
      claimSet(
        [
          claim("identity_verified"),
          claim("employment_verified", { verifiedAt: daysFromNow(400) }),
        ],
        { requestedScopes: scopes },
      ),
    );
    expect(result.decision).not.toBe("APPROVED");
    const employment = result.requirementDetail.find((r) => r.claimId === "employment_verified");
    expect(employment?.satisfied).toBe(false);
    expect(employment?.detail).toMatch(/future/i);
  });

  it("tolerates ordinary clock skew", () => {
    // Minutes of skew between this host and an issuer is normal and must not
    // start failing real claims.
    const result = ev(
      request({ subjectType: "employee", resource: "internal_wiki", accessLevel: "read" }),
      claimSet(
        [
          claim("identity_verified"),
          claim("employment_verified", { verifiedAt: daysFromNow(0.01) }),
        ],
        { requestedScopes: scopes },
      ),
    );
    expect(result.decision).toBe("APPROVED");
  });
});

describe("a subject reference must hash to one audit identity", () => {
  // DIDs are hex and are compared case-insensitively everywhere else, so
  // hashing the raw string gave one subject two audit identities depending on
  // how the DID happened to be typed — and broke the documented proof that an
  // auditor can recompute the hash from a known subject reference.
  it("is case- and whitespace-insensitive", () => {
    const salt = "test-salt";
    const lower = "did:t3n:2eaed84a2d5d72c2f8a19f1a832e8d63d96a9e5a";
    expect(hashSubject(lower.toUpperCase(), salt)).toBe(hashSubject(lower, salt));
    expect(hashSubject(`  ${lower}  `, salt)).toBe(hashSubject(lower, salt));
  });

  it("still separates different subjects, and different salts", () => {
    const a = "did:t3n:2eaed84a2d5d72c2f8a19f1a832e8d63d96a9e5a";
    const b = "did:t3n:befa498bd983b6629e12977245899e0f8e0ee66b";
    expect(hashSubject(a, "s1")).not.toBe(hashSubject(b, "s1"));
    expect(hashSubject(a, "s1")).not.toBe(hashSubject(a, "s2"));
  });
});

describe("a policy shadowed by the union of earlier entries must be rejected", () => {
  // The first version of this guard compared each policy against ONE earlier
  // policy at a time, so joint coverage was structurally undetectable. An
  // operator could add a policy that tightened a control — requiring an NDA and
  // a named approver — watch it validate, see it listed by GET /api/policies,
  // and have it govern nothing, while the looser policies underneath kept
  // auto-approving the access they thought they had just gated.
  const base = (order: string[], extra = "") => `
version: "1.0.0"
claims:
  identity_verified: { scope: compliance/identity, label: Identity, description: d }
  nda_signed: { scope: compliance/legal, label: NDA, description: d }
defaults:
  minimum_assurance: substantial
  max_claim_age_days: 365
  expired_claim_behavior: review
  failed_claim_behavior: deny
  expiring_soon_days: 30
policies:
  emp_wiki:
    label: Employee wiki
    description: d
    applies_to_subject_types: [employee]
    resources: [internal_wiki, expense_system]
    access_levels: [read]
    required_claims: [identity_verified]
  con_wiki:
    label: Contractor wiki
    description: d
    applies_to_subject_types: [contractor]
    resources: [internal_wiki, project_workspace]
    access_levels: [read]
    required_claims: [identity_verified]
${extra}
resolution:
  order: [${order.join(", ")}]
  no_match_behavior: deny
`;

  const everyoneWiki = `  everyone_wiki:
    label: Wiki for anyone, with an NDA
    description: d
    applies_to_subject_types: [employee, contractor]
    resources: [internal_wiki]
    access_levels: [read]
    required_claims: [identity_verified, nda_signed]
    rules:
      require_manual_approval: true
`;

  const messageFor = (yaml: string): string => {
    try {
      parsePolicyConfig(yaml);
      return "";
    } catch (err) {
      return err instanceof Error ? err.message : String(err);
    }
  };

  it("rejects a policy covered jointly by two earlier ones", () => {
    const message = messageFor(base(["emp_wiki", "con_wiki", "everyone_wiki"], everyoneWiki));
    expect(message).toMatch(/everyone_wiki.*unreachable/i);
    // And it names both culprits, not one arbitrary earlier entry.
    expect(message).toContain("emp_wiki");
    expect(message).toContain("con_wiki");
  });

  it("accepts the broad policy when it is ordered first, and the narrow ones keep their own ground", () => {
    expect(messageFor(base(["everyone_wiki", "emp_wiki", "con_wiki"], everyoneWiki))).toBe("");
  });

  it("names a duplicated order entry instead of advising the impossible", () => {
    // The old message read: move "emp_wiki" above "emp_wiki".
    const message = messageFor(base(["emp_wiki", "emp_wiki", "con_wiki"]));
    expect(message).toMatch(/listed more than once/i);
    expect(message).not.toMatch(/above "emp_wiki"/);
  });

  it("still accepts the shipped policy file", () => {
    expect(messageFor(readFileSync(POLICY_PATH, "utf8"))).toBe("");
  });
});

describe("demo fixtures must not decay while the server is up", () => {
  // DEMO_SCENARIOS is a module-level constant, so every fixture date was
  // evaluated once at import. On a long-running server the offsets drift out of
  // the policy's max_claim_age_days and scenario D — whose point is that every
  // requirement passes and the answer is STILL REVIEW_REQUIRED because a human
  // approver is required — silently turned into DENIED after about three weeks.
  it("re-anchors claim dates to the current day on every read", () => {
    const scenario = findScenario("demo:subject:dara");
    expect(scenario).not.toBeNull();

    const dated = scenario!.claims.filter((c) => c.verifiedAt !== null);
    expect(dated.length).toBeGreaterThan(0);

    const todayStart = Date.UTC(
      new Date().getUTCFullYear(),
      new Date().getUTCMonth(),
      new Date().getUTCDate(),
    );
    for (const c of dated) {
      const ageDays = (todayStart - Date.parse(c.verifiedAt!)) / 86_400_000;
      // The privileged policy allows 180 days. Every fixture claim must stay
      // comfortably inside that no matter how long the process has been up.
      expect(ageDays).toBeLessThan(180);
      expect(ageDays).toBeGreaterThanOrEqual(0);
    }
  });

  it("keeps every scenario's documented outcome reachable", async () => {
    const source = new DemoClaimSource();
    const engine = loadRealEngine();

    for (const s of DEMO_SCENARIOS) {
      const req = request({
        subjectRef: s.subjectRef,
        subjectType: s.subjectType as never,
        resource: s.suggestedResource,
        accessLevel: s.suggestedAccessLevel as never,
      });
      const policyId = engine.resolvePolicyId(req);
      expect(policyId).not.toBeNull();

      const policy = engine.getPolicy(policyId!);
      const claimScopes: Record<string, string> = {};
      for (const id of [...policy.required_claims, ...policy.optional_claims]) {
        const scope = engine.scopeForClaim(id);
        if (scope) claimScopes[id] = scope;
      }

      const claims = await source.fetchClaims({
        subjectRef: s.subjectRef,
        requiredScopes: engine.requiredScopes(policyId!),
        claimScopes,
      });
      const decision = engine.evaluate(req, claims, { auditId: "aud_demo" });
      expect(decision.decision, `scenario ${s.id}`).toBe(s.expectedDecision);
    }
  });
});

describe("a failed optional claim is not an absent one", () => {
  // "We have no background check" and "the background check came back adverse"
  // are opposite facts, and the second is the one a reviewer most needs. Both
  // were reported to the approver, and written to the audit record, as absent.
  const PRIVILEGED_SCOPES = [
    "compliance/background",
    "compliance/employment",
    "compliance/identity",
    "compliance/training",
  ];
  const privileged = () =>
    request({ subjectType: "employee", resource: "production_database", accessLevel: "admin" });
  const core = () => [
    claim("identity_verified"),
    claim("employment_verified"),
    claim("security_training"),
  ];

  it("flags a present-but-failed optional claim as failed", () => {
    const result = ev(
      privileged(),
      claimSet([...core(), claim("background_check", { verified: false })], {
        requestedScopes: PRIVILEGED_SCOPES,
      }),
    );
    const codes = result.riskFlags.map((f) => f.code);
    expect(codes).toContain("OPTIONAL_CLAIM_FAILED");
    expect(codes).not.toContain("OPTIONAL_CLAIM_ABSENT");
    expect(result.riskFlags.find((f) => f.code === "OPTIONAL_CLAIM_FAILED")?.message).toMatch(
      /did NOT pass/i,
    );
  });

  it("still flags a genuinely absent optional claim as absent", () => {
    const result = ev(privileged(), claimSet(core(), { requestedScopes: PRIVILEGED_SCOPES }));
    const codes = result.riskFlags.map((f) => f.code);
    expect(codes).toContain("OPTIONAL_CLAIM_ABSENT");
    expect(codes).not.toContain("OPTIONAL_CLAIM_FAILED");
  });

  it("raises neither when the optional claim passed", () => {
    const result = ev(
      privileged(),
      claimSet([...core(), claim("background_check")], { requestedScopes: PRIVILEGED_SCOPES }),
    );
    const codes = result.riskFlags.map((f) => f.code);
    expect(codes).not.toContain("OPTIONAL_CLAIM_ABSENT");
    expect(codes).not.toContain("OPTIONAL_CLAIM_FAILED");
  });
});

describe("demo output must never pass for live output, on any path", () => {
  // The out-of-envelope short-circuit assembled its own risk-flag list and so
  // dropped the demo label, letting a fixture-backed decision reach a reviewer
  // with nothing marking it as demo data.
  it("labels a demo decision that is denied for being out of policy scope", () => {
    const result = ev(
      // internal_wiki is not governed by privileged_access.
      request({
        subjectType: "employee",
        resource: "internal_wiki",
        accessLevel: "read",
        policyId: "privileged_access",
      }),
      claimSet([claim("identity_verified")], {
        source: "DEMO_FIXTURE",
        requestedScopes: ["compliance/identity"],
      }),
    );
    expect(result.decision).toBe("DENIED");
    const codes = result.riskFlags.map((f) => f.code);
    expect(codes).toContain("OUT_OF_POLICY_SCOPE");
    expect(codes).toContain("DEMO_DATA");
  });

  it("does not label a live decision as demo", () => {
    const result = ev(
      request({
        subjectType: "employee",
        resource: "internal_wiki",
        accessLevel: "read",
        policyId: "privileged_access",
      }),
      claimSet([claim("identity_verified")], {
        source: "LIVE_T3N",
        requestedScopes: ["compliance/identity"],
      }),
    );
    expect(result.riskFlags.map((f) => f.code)).not.toContain("DEMO_DATA");
  });
});

describe("a request no policy governs must not reach the claim source", () => {
  // `resolvePolicyId` returns an explicitly supplied policyId without checking
  // it applies, so a request naming a policy that does not govern its resource
  // still reached the source — a live disclosure and a credit spent for a
  // decision the engine was always going to deny.
  it("skips the source when the named policy does not govern the resource", async () => {
    const { service, audit, calls } = await serviceWithCountingSource("t3n-envelope-");

    const { decision } = await service.evaluate(
      {
        subjectRef: "demo:subject:alice",
        subjectType: "employee",
        resource: "internal_wiki",
        accessLevel: "read",
        policyId: "privileged_access",
      },
      { now: NOW },
    );

    expect(calls()).toBe(0);
    expect(decision.decision).toBe("DENIED");
    expect(decision.riskFlags.map((f) => f.code)).toContain("OUT_OF_POLICY_SCOPE");
    // The row is still written — skipping the lookup must not skip the record.
    expect(audit.query().total).toBe(1);
  });

  it("still calls the source when the named policy does govern it", async () => {
    const { service, calls } = await serviceWithCountingSource("t3n-envelope-ok-");
    await service.evaluate(
      {
        subjectRef: "demo:subject:alice",
        subjectType: "employee",
        resource: "internal_wiki",
        accessLevel: "read",
        policyId: "employee_access",
      },
      { now: NOW },
    );
    expect(calls()).toBe(1);
  });
});

describe("a caller-supplied policyId must not widen what is read", () => {
  // `resolvePolicyId` honours an explicit policyId without checking it is the
  // one the resolver would pick, and several policies legitimately overlap. A
  // vendor reading the wiki resolves to vendor_readonly_access (2 scopes);
  // naming contractor_access on the same request — one optional body field the
  // schema accepts — read 4. Real over-collection of consented data, extra
  // credit spend, extra on-network records, and a flat contradiction of the
  // stated guarantee that no input can widen what is read.
  const vendorWikiRead = {
    subjectRef: "demo:subject:carla",
    subjectType: "vendor" as const,
    resource: "internal_wiki",
    accessLevel: "read" as const,
  };

  it("the two policies really do differ, so the test means something", () => {
    const engine = loadRealEngine();
    expect(engine.resolvePolicyId(vendorWikiRead)).toBe("vendor_readonly_access");
    expect(engine.governs("contractor_access", vendorWikiRead)).toBe(true);
    expect(engine.requiredScopes("contractor_access").length).toBeGreaterThan(
      engine.requiredScopes("vendor_readonly_access").length,
    );
  });

  it("reads only the governing policy's scopes even when a broader one is named", async () => {
    const { service } = await serviceWithRecordingSource("t3n-widen-");
    const { decision } = await service.evaluate(
      { ...vendorWikiRead, policyId: "contractor_access" },
      { now: NOW },
    );

    const engine = loadRealEngine();
    const governing = engine.requiredScopes("vendor_readonly_access");
    // The named policy still decides…
    expect(decision.policy).toBe("contractor_access");
    // …but it cannot see beyond what the governing policy justified reading.
    expect([...decision.dataAccess.requestedScopes].sort()).toEqual([...governing].sort());
    expect(decision.dataAccess.requestedScopes).not.toContain("compliance/contractor");
    expect(decision.dataAccess.requestedScopes).not.toContain("compliance/legal");
  });

  it("an unqualified request is unaffected", async () => {
    const { service } = await serviceWithRecordingSource("t3n-nowiden-");
    const { decision } = await service.evaluate(vendorWikiRead, { now: NOW });
    expect(decision.policy).toBe("vendor_readonly_access");
    expect([...decision.dataAccess.requestedScopes].sort()).toEqual(
      [...loadRealEngine().requiredScopes("vendor_readonly_access")].sort(),
    );
  });
});

describe("an unreadable record only casts doubt when the subject's claim is missing", () => {
  // Marking a whole scope unread on ANY dropped record was too blunt. Scopes are
  // shared, so an unparseable record usually belongs to somebody else — and the
  // part naming its subject is exactly what failed to parse. On the live testnet
  // each seeded scope holds one legacy record of an older shape, which turned a
  // correct APPROVED into REVIEW_REQUIRED claiming the subject had withheld
  // consent they had in fact granted. Caught by a live end-to-end check.
  function sourceWith(entries: Array<{ subject: string } | "corrupt">) {
    const source = new LiveT3nClaimSource({
      agentDid: AGENT_DID,
      orgDid: ORG_DID,
      contractId: "tee:org-data/contracts",
      async readerOrgData() {
        return {
          async dataList() {
            return {
              entry_ids: entries.map((_, i) => `e${i}`),
              next_offset: null,
              total: entries.length,
            };
          },
          async dataGet({ entryId }: { entryId: string }) {
            const entry = entries[Number(entryId.slice(1))];
            if (entry === "corrupt") {
              // Valid hex, decodes to JSON, but the shape is wrong — exactly
              // the legacy records sitting in the real scopes.
              const bad = JSON.stringify({ v: 1, claim: "identity_verified" });
              return { payload_hex: Buffer.from(bad, "utf8").toString("hex") };
            }
            const record = {
              v: 1,
              subject: entry.subject,
              claim: "identity_verified",
              verified: true,
              assurance: "high",
              verifiedAt: daysFromNow(-30),
              expiresAt: daysFromNow(300),
              issuerCategory: "government",
              evidenceRef: "vc:sha256:identity_verified",
            };
            return { payload_hex: Buffer.from(JSON.stringify(record), "utf8").toString("hex") };
          },
        };
      },
    } as unknown as T3nConnection);

    return (
      source as unknown as {
        readScope(
          orgDid: string,
          scope: string,
          subjectRef: string,
        ): Promise<{ claims: unknown[]; dropped: number }>;
      }
    ).readScope.bind(source);
  }

  it("reads the subject's claim despite an unparseable neighbour", async () => {
    const readScope = sourceWith(["corrupt", { subject: SUBJECT_DID }]);
    const result = await readScope(ORG_DID, "compliance/identity", SUBJECT_DID);
    expect(result.claims).toHaveLength(1);
    expect(result.dropped).toBe(1);
  });

  it("reports the drop when nothing was readable for the subject", async () => {
    const readScope = sourceWith(["corrupt", { subject: OTHER_DID }]);
    const result = await readScope(ORG_DID, "compliance/identity", SUBJECT_DID);
    expect(result.claims).toHaveLength(0);
    expect(result.dropped).toBe(1);
  });
});
