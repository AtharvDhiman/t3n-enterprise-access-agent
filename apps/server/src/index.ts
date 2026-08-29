/**
 * Server entrypoint.
 *
 * Startup order matters and is deliberate:
 *
 *   1. Load and **validate** the policy file. An invalid policy is fatal — a
 *      compliance system that starts with rules it could not parse is worse
 *      than one that refuses to start.
 *   2. Load the audit journal, so history is present before the first request.
 *   3. Connect to Terminal 3 — **non-fatal**. A connection problem must leave
 *      the server running so an operator can see the status page that explains
 *      it. Demo mode also has to work with no credentials at all.
 *
 * This is also the boundary that keeps the T3N SDK out of the browser: the
 * WASM component is loaded in this process and nothing under `apps/web`
 * imports `@t3n-aca/t3n`.
 */

import "dotenv/config";

import { resolve } from "node:path";
import express from "express";

import { AuditStore, createLogger } from "@t3n-aca/core";
import { PolicyEngine, loadPolicyConfig } from "@t3n-aca/policy-engine";
import { T3nConnection, loadAppConfig } from "@t3n-aca/t3n";

import { ComplianceService } from "./service.ts";
import { ComplianceAgent } from "./agent/agent.ts";
import { createApiRouter } from "./routes/api.ts";

const log = createLogger("server");

const POLICY_PATH =
  process.env.POLICY_PATH?.trim() || resolve(process.cwd(), "config/policies.yaml");

async function main(): Promise<void> {
  const config = loadAppConfig();

  // --- policies (fatal on failure) ---------------------------------------
  const policyConfig = await loadPolicyConfig(POLICY_PATH);
  const engine = new PolicyEngine(policyConfig);
  log.info("policies loaded", {
    path: POLICY_PATH,
    version: policyConfig.version,
    policies: engine.policyIds(),
  });

  // --- audit --------------------------------------------------------------
  const audit = new AuditStore(resolve(process.cwd(), config.auditLogPath));
  await audit.init();
  log.info("audit journal ready", {
    path: config.auditLogPath,
    records: audit.stats().total,
  });

  if (!process.env.AUDIT_SALT?.trim()) {
    log.warn(
      "AUDIT_SALT is not set — using the development default. Set a unique value per deployment (see docs/OPERATIONS.md).",
    );
  }

  // --- Terminal 3 (non-fatal) --------------------------------------------
  let connection: T3nConnection | null = null;
  if (config.t3n) {
    connection = new T3nConnection(config.t3n, log.child("t3n"));
  } else {
    log.warn("Terminal 3 is not configured", { reason: config.t3nConfigError });
  }
  for (const warning of config.t3nWarnings) log.warn(warning);

  if (config.claimSource === "live" && !connection) {
    // Refusing here rather than quietly serving fixtures: an operator who asked
    // for live data must never be handed demo data without noticing.
    log.error(
      "CLAIM_SOURCE=live but Terminal 3 is not configured. Refusing to start rather than silently serving demo fixtures.",
    );
    process.exit(1);
  }

  const service = new ComplianceService({ config, engine, audit, connection });
  await service.warmup();

  const agent = config.anthropicApiKey
    ? new ComplianceAgent(config.anthropicApiKey, config.anthropicModel, log.child("agent"))
    : null;
  if (!agent) {
    log.info("natural-language layer disabled (no ANTHROPIC_API_KEY); all other features active");
  }

  // --- HTTP ---------------------------------------------------------------
  const app = express();
  app.disable("x-powered-by");
  app.use(express.json({ limit: "128kb" }));

  // The API is same-origin in production (Vite proxies it in development), so
  // no CORS middleware is enabled: not opening a cross-origin surface is
  // simpler and safer than configuring one.
  app.use("/api", createApiRouter(service, agent));

  app.listen(config.port, () => {
    const status = service.t3nStatus();
    log.info("server listening", {
      port: config.port,
      claimSource: config.claimSource,
      t3nState: status.state,
      enforcementMode: status.enforcementMode,
    });
    process.stdout.write(
      `\n  T3N Enterprise Access & Compliance Agent\n` +
        `  API          http://localhost:${config.port}/api\n` +
        `  claim source ${config.claimSource.toUpperCase()} (${service.claimSourceKind})\n` +
        `  T3N          ${status.state}${status.state === "connected" ? ` · ${status.enforcementMode}` : ""}\n\n`,
    );
  });
}

main().catch((err: unknown) => {
  log.error("fatal startup error", { error: err instanceof Error ? err.message : String(err) });
  if (err instanceof Error && err.stack) process.stderr.write(`${err.stack}\n`);
  process.exit(1);
});
