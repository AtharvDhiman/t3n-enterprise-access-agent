/**
 * HTTP API.
 *
 * Exercised against a real Express app on an ephemeral port — no mocking of the
 * routing layer, because the properties worth testing here (status codes, error
 * projection, what a response is allowed to contain) live in that layer.
 */

import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";

import express from "express";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { AuditStore } from "@t3n-aca/core";
import type { AppConfig } from "@t3n-aca/t3n";

import { ComplianceService } from "../apps/server/src/service";
import { createApiRouter } from "../apps/server/src/routes/api";
import { loadRealEngine } from "./helpers";

let server: Server;
let baseUrl: string;

beforeAll(async () => {
  const dir = mkdtempSync(join(tmpdir(), "t3n-api-"));
  const config: AppConfig = {
    claimSource: "demo",
    t3n: null,
    t3nConfigError: "not configured in tests",
    t3nWarnings: ["example warning"],
    auditLogPath: join(dir, "audit.jsonl"),
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
  const audit = new AuditStore(config.auditLogPath);
  await audit.init();
  const service = new ComplianceService({
    config,
    engine: loadRealEngine(),
    audit,
    connection: null,
  });

  const app = express();
  app.disable("x-powered-by");
  app.use(express.json({ limit: "128kb" }));
  app.use("/api", createApiRouter(service, null));

  await new Promise<void>((resolve) => {
    server = app.listen(0, () => resolve());
  });
  const { port } = server.address() as AddressInfo;
  baseUrl = `http://127.0.0.1:${port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

const get = (path: string) => fetch(`${baseUrl}/api${path}`);
const post = (path: string, body: unknown) =>
  fetch(`${baseUrl}/api${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });

describe("read endpoints", () => {
  it("reports health", async () => {
    const res = await get("/health");
    expect(res.status).toBe(200);
    expect((await res.json()).ok).toBe(true);
  });

  it("returns policies with their claim vocabulary", async () => {
    const res = await get("/policies");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.policies.length).toBeGreaterThan(0);
    expect(body.claims.length).toBeGreaterThan(0);
  });

  it("labels demo scenarios at the API boundary, not only in the UI", async () => {
    const body = await (await get("/demo/scenarios")).json();
    expect(body.source).toBe("DEMO_FIXTURE");
    expect(body.scenarios).toHaveLength(4);
  });

  it("reports T3N status without leaking credentials", async () => {
    const res = await get("/t3n/status");
    expect(res.status).toBe(200);
    const text = JSON.stringify(await res.json());
    expect(text).not.toMatch(/0x[0-9a-f]{64}/i);
    expect(text).not.toContain("t3n_key_");
    expect(text).not.toContain("tenantKey");
  });

  it("reports the natural-language layer as unavailable when unconfigured", async () => {
    const body = await (await get("/agent/status")).json();
    expect(body.available).toBe(false);
    expect(body.reason).toBeTruthy();
    // No provider configured means no provider or model is claimed.
    expect(body.provider).toBeNull();
    expect(body.model).toBeNull();
  });
});

describe("evaluation endpoint", () => {
  it("returns a decision for a valid request", async () => {
    const res = await post("/requests", {
      subjectRef: "demo:subject:alice",
      subjectType: "employee",
      resource: "employee_dashboard",
      accessLevel: "read",
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.decision).toBe("APPROVED");
    expect(body.auditId).toMatch(/^aud_/);
  });

  it("rejects an invalid body with 400 and a remediation hint", async () => {
    const res = await post("/requests", { subjectRef: "" });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error.code).toBe("REQUEST_INVALID");
    expect(body.error.remediation).toBeTruthy();
  });

  it("rejects an unknown policy id with 404", async () => {
    const res = await post("/requests", {
      subjectRef: "demo:subject:alice",
      subjectType: "employee",
      resource: "employee_dashboard",
      accessLevel: "read",
      policyId: "does_not_exist",
    });
    expect(res.status).toBe(404);
    expect((await res.json()).error.code).toBe("POLICY_NOT_FOUND");
  });

  it("does not accept a decision supplied by the caller", async () => {
    const res = await post("/requests", {
      subjectRef: "demo:subject:ben",
      subjectType: "employee",
      resource: "employee_dashboard",
      accessLevel: "read",
      decision: "APPROVED",
      approved: true,
    });
    expect(res.status).toBe(200);
    // The extra fields are ignored; the engine's own verdict stands.
    expect((await res.json()).decision).toBe("REVIEW_REQUIRED");
  });
});

describe("audit endpoints", () => {
  it("lists and filters recorded decisions", async () => {
    await post("/requests", {
      subjectRef: "demo:subject:carla",
      subjectType: "contractor",
      resource: "source_repository",
      accessLevel: "write",
    });

    const all = await (await get("/audit")).json();
    expect(all.total).toBeGreaterThan(0);

    const denied = await (await get("/audit?decision=DENIED")).json();
    expect(denied.records.every((r: { decision: string }) => r.decision === "DENIED")).toBe(true);
  });

  it("rejects a malformed audit query", async () => {
    const res = await get("/audit?limit=abc");
    expect(res.status).toBe(400);
  });

  it("returns 404 for an unknown audit id", async () => {
    const res = await get("/audit/aud_missing");
    expect(res.status).toBe(404);
  });

  it("never returns a raw subject reference", async () => {
    await post("/requests", {
      subjectRef: "demo:subject:alice",
      subjectType: "employee",
      resource: "employee_dashboard",
      accessLevel: "read",
    });
    const text = JSON.stringify(await (await get("/audit")).json());
    expect(text).not.toContain("demo:subject:alice");
  });
});

describe("natural-language endpoint", () => {
  it("returns 503 when disabled rather than pretending to answer", async () => {
    const res = await post("/agent/ask", { message: "can alice have access?" });
    expect(res.status).toBe(503);
    expect((await res.json()).error.code).toBe("LLM_UNAVAILABLE");
  });
});
