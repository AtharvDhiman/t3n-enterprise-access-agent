/**
 * The compliance service and the agent tool surface.
 *
 * These exercise the whole pipeline — validate, resolve, fetch, decide, record —
 * without any network, which is what makes them safe to run in CI.
 */

import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";

import { AuditStore } from "@t3n-aca/core";
import type { AppConfig } from "@t3n-aca/t3n";

import { ComplianceService } from "../apps/server/src/service";
import { TOOL_DEFINITIONS, executeTool } from "../apps/server/src/agent/tools";
import { loadRealEngine } from "./helpers";

function buildService(): ComplianceService {
  const dir = mkdtempSync(join(tmpdir(), "t3n-svc-"));
  const config: AppConfig = {
    claimSource: "demo",
    t3n: null,
    t3nConfigError: "not configured in tests",
    t3nWarnings: [],
    auditLogPath: join(dir, "audit.jsonl"),
    auditSalt: "test-salt",
    port: 0,
    anthropicApiKey: null,
    anthropicModel: "claude-sonnet-4-5",
  };
  return new ComplianceService({
    config,
    engine: loadRealEngine(),
    audit: new AuditStore(config.auditLogPath),
    connection: null,
  });
}

let service: ComplianceService;
beforeEach(async () => {
  service = buildService();
  await service.audit.init();
});

describe("evaluation pipeline", () => {
  it("produces the four demo scenarios' intended decisions", async () => {
    const cases = [
      ["demo:subject:alice", "employee", "employee_dashboard", "read", "APPROVED"],
      ["demo:subject:ben", "employee", "employee_dashboard", "read", "REVIEW_REQUIRED"],
      ["demo:subject:carla", "contractor", "source_repository", "write", "DENIED"],
      ["demo:subject:dara", "employee", "production_database", "admin", "REVIEW_REQUIRED"],
    ] as const;

    for (const [subjectRef, subjectType, resource, accessLevel, expected] of cases) {
      const { decision } = await service.evaluate({
        subjectRef,
        subjectType,
        resource,
        accessLevel,
      });
      expect(decision.decision, `${subjectRef} → ${resource}`).toBe(expected);
    }
  });

  it("rejects a malformed request with field-level detail", async () => {
    await expect(
      service.evaluate({ subjectRef: "", subjectType: "alien", resource: "x", accessLevel: "read" }),
    ).rejects.toThrowError(/validation failed/);
  });

  it("rejects a missing body", async () => {
    await expect(service.evaluate(undefined)).rejects.toThrowError(/validation failed/);
  });

  it("rejects an over-long subject reference", async () => {
    await expect(
      service.evaluate({
        subjectRef: "x".repeat(500),
        subjectType: "employee",
        resource: "employee_dashboard",
        accessLevel: "read",
      }),
    ).rejects.toThrow();
  });
});

describe("audit records", () => {
  it("writes one record per decision, containing no raw subject or claim values", async () => {
    const { audit } = await service.evaluate({
      subjectRef: "demo:subject:alice",
      subjectLabel: "Alice Example",
      subjectType: "employee",
      resource: "employee_dashboard",
      accessLevel: "read",
      justification: "quarterly access review",
    });

    const serialized = JSON.stringify(audit);
    expect(serialized).not.toContain("demo:subject:alice");
    expect(serialized).not.toContain("Alice Example");
    expect(serialized).not.toContain("quarterly access review");
    // Claim ids are recorded; assurance levels and dates are not.
    expect(audit.claimsUsed).toContain("identity_verified");
    expect(serialized).not.toContain("government");
  });

  it("records enough to answer 'why did the agent decide this?'", async () => {
    const { audit } = await service.evaluate({
      subjectRef: "demo:subject:ben",
      subjectType: "employee",
      resource: "employee_dashboard",
      accessLevel: "read",
    });

    expect(audit.decision).toBe("REVIEW_REQUIRED");
    expect(audit.policyId).toBe("employee_access");
    expect(audit.missingRequirements).toEqual(["employment_verified"]);
    expect(audit.scopesRequested.length).toBeGreaterThan(audit.scopesAuthorized.length);
    expect(audit.nextAction).toBeTruthy();
  });

  it("keeps statistics consistent with what was recorded", async () => {
    await service.evaluate({
      subjectRef: "demo:subject:alice",
      subjectType: "employee",
      resource: "employee_dashboard",
      accessLevel: "read",
    });
    await service.evaluate({
      subjectRef: "demo:subject:carla",
      subjectType: "contractor",
      resource: "source_repository",
      accessLevel: "write",
    });

    const stats = service.audit.stats();
    expect(stats.total).toBe(2);
    expect(stats.approved).toBe(1);
    expect(stats.denied).toBe(1);
    expect(stats.demoDecisions).toBe(2);
    expect(stats.liveDecisions).toBe(0);
  });

  it("filters by decision, policy and free text", async () => {
    await service.evaluate({
      subjectRef: "demo:subject:alice",
      subjectType: "employee",
      resource: "employee_dashboard",
      accessLevel: "read",
    });
    await service.evaluate({
      subjectRef: "demo:subject:carla",
      subjectType: "contractor",
      resource: "source_repository",
      accessLevel: "write",
    });

    expect(service.audit.query({ decision: "DENIED" }).total).toBe(1);
    expect(service.audit.query({ policyId: "employee_access" }).total).toBe(1);
    expect(service.audit.query({ search: "source_repo" }).total).toBe(1);
    expect(service.audit.query({ subjectType: "contractor" }).total).toBe(1);
  });

  it("survives a truncated final line in the journal", async () => {
    const { appendFileSync } = await import("node:fs");
    await service.evaluate({
      subjectRef: "demo:subject:alice",
      subjectType: "employee",
      resource: "employee_dashboard",
      accessLevel: "read",
    });
    const path = service.audit["path"] as unknown as string;
    appendFileSync(path, '{"auditId":"broken","tim');

    const reopened = new AuditStore(path);
    await reopened.init();
    expect(reopened.stats().total).toBe(1);
  });
});

describe("agent tool surface", () => {
  const ctx = () => ({ service, actor: "test" });

  it("exposes no tool that can grant access directly", () => {
    const names = TOOL_DEFINITIONS.map((t) => t.name);
    expect(names).toEqual([
      "list_available_policies",
      "evaluate_access_request",
      "explain_decision",
      "search_audit_log",
      "get_t3n_status",
    ]);
    // The tool that *produces* a decision must not accept one as input.
    // (`search_audit_log` does take a `decision` filter — that is a read
    // predicate over recorded history, not an outcome the caller supplies.)
    const evaluateTool = TOOL_DEFINITIONS.find((t) => t.name === "evaluate_access_request");
    const evaluateProps = Object.keys(
      (evaluateTool?.input_schema as { properties?: Record<string, unknown> }).properties ?? {},
    );
    expect(evaluateProps).not.toContain("decision");
    expect(evaluateProps).not.toContain("outcome");

    for (const t of TOOL_DEFINITIONS) {
      const props = Object.keys(
        (t.input_schema as { properties?: Record<string, unknown> }).properties ?? {},
      );
      expect(props).not.toContain("approve");
      expect(props).not.toContain("override");
      expect(props).not.toContain("claims");
    }
  });

  it("rejects an unknown tool name", async () => {
    await expect(executeTool("grant_access", {}, ctx())).rejects.toThrowError(/unknown tool/);
  });

  it("validates evaluate_access_request input", async () => {
    await expect(
      executeTool("evaluate_access_request", { subjectRef: "x" }, ctx()),
    ).rejects.toThrow();
  });

  it("returns the engine's decision verbatim", async () => {
    const result = (await executeTool(
      "evaluate_access_request",
      {
        subjectRef: "demo:subject:alice",
        subjectType: "employee",
        resource: "employee_dashboard",
        accessLevel: "read",
      },
      ctx(),
    )) as Record<string, unknown>;

    expect(result.decision).toBe("APPROVED");
    expect(result.audit_id).toBeTruthy();
    expect(result.data_access).toBeTruthy();
  });

  it("lists policies with their required scopes", async () => {
    const result = (await executeTool("list_available_policies", {}, ctx())) as {
      policies: Array<{ id: string; required_scopes: string[] }>;
    };
    const employee = result.policies.find((p) => p.id === "employee_access");
    expect(employee?.required_scopes).toEqual(["compliance/employment", "compliance/identity"]);
  });

  it("reports a missing audit record rather than fabricating one", async () => {
    const result = (await executeTool("explain_decision", { auditId: "aud_nope" }, ctx())) as {
      found: boolean;
    };
    expect(result.found).toBe(false);
  });

  it("never exposes credentials through get_t3n_status", async () => {
    const result = await executeTool("get_t3n_status", {}, ctx());
    const serialized = JSON.stringify(result);
    expect(serialized).not.toMatch(/0x[0-9a-f]{64}/i);
    expect(serialized).not.toContain("t3n_key_");
  });
});

describe("dashboard", () => {
  it("reports which claim source is in use", () => {
    const summary = service.dashboard();
    expect(summary.claimSource.mode).toBe("demo");
    expect(summary.claimSource.kind).toBe("DEMO_FIXTURE");
    expect(summary.policyCount).toBeGreaterThan(0);
  });
});
