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

import dotenv from "dotenv";
import express from "express";

import { AuditStore, createLogger, toAppError } from "@t3n-aca/core";
import { PolicyEngine, loadPolicyConfig } from "@t3n-aca/policy-engine";
import { T3nConnection, loadAppConfig } from "@t3n-aca/t3n";

import { PROJECT_ROOT, resolveFromRoot, shadowedEnvNames } from "./paths.ts";
import { ComplianceService } from "./service.ts";
import { ComplianceAgent } from "./agent/agent.ts";
import { createLlmProvider } from "./agent/factory.ts";
import { createApiRouter } from "./routes/api.ts";

// Loaded with an explicit root-relative path rather than `dotenv/config`, which
// reads `.env` from the current working directory — and npm runs a workspace
// script with cwd set to the workspace, not the repo root. Must run before
// anything reads process.env, including the logger's LOG_LEVEL.
const ENV_PATH = resolveFromRoot(".env");
dotenv.config({ path: ENV_PATH });

const log = createLogger("server");

const POLICY_PATH = resolveFromRoot(
  process.env.POLICY_PATH?.trim() || "config/policies.yaml",
);

async function main(): Promise<void> {
  const config = loadAppConfig();

  // --- policies (fatal on failure) ---------------------------------------
  const policyConfig = await loadPolicyConfig(POLICY_PATH);
  const engine = new PolicyEngine(policyConfig);
  log.info("policies loaded", {
    projectRoot: PROJECT_ROOT,
    path: POLICY_PATH,
    version: policyConfig.version,
    policies: engine.policyIds(),
  });

  // --- audit --------------------------------------------------------------
  const audit = new AuditStore(resolveFromRoot(config.auditLogPath));
  await audit.init();
  log.info("audit journal ready", {
    path: config.auditLogPath,
    records: audit.stats().total,
  });
  if (audit.wasRepaired) {
    // The journal is meant to be evidence. Silently loading fewer records than
    // the file contains, and reporting the reduced number as if it were the
    // whole truth, is the one failure an audit trail must never have. Say it
    // loudly, once, at the only moment an operator is looking.
    log.warn(
      "the audit journal was damaged and has been repaired: at least one record was unreadable and has been skipped. The count above is therefore lower than the number of decisions actually made.",
      {
        path: config.auditLogPath,
        remediation:
          "Inspect the file directly (it is JSONL — one decision per line) to see what was lost, and keep a copy before it is rotated. See docs/OPERATIONS.md.",
      },
    );
  }

  const shadowed = shadowedEnvNames(ENV_PATH, process.env);
  if (shadowed.length > 0) {
    log.warn(
      `These variables are set in .env but overridden by your shell environment, which wins: ${shadowed.join(", ")}. Unset them in your shell, or edit the shell value instead.`,
    );
  }

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

  const { provider, reason: llmReason } = createLlmProvider(config, log.child("agent"));
  const agent = provider ? new ComplianceAgent(provider, log.child("agent")) : null;
  if (!agent) log.info("natural-language layer disabled; all other features active", { reason: llmReason });

  // --- HTTP ---------------------------------------------------------------
  const app = express();
  app.disable("x-powered-by");
  app.use(express.json({ limit: "128kb" }));

  // The API is same-origin in production (Vite proxies it in development), so
  // no CORS middleware is enabled: not opening a cross-origin surface is
  // simpler and safer than configuring one.
  app.use("/api", createApiRouter(service, agent, llmReason));

  // This port serves the API only — the dashboard is a separate static build
  // (see docs/deployment.md). Someone who opens it in a browser expecting the
  // UI would otherwise get Express's bare "Cannot GET /", which explains
  // nothing. Point them at the right place and list what does exist here.
  app.get("/", (_req, res) => {
    res.json({
      service: "T3N Enterprise Access & Compliance Agent — API",
      note: "This port serves the JSON API. The dashboard runs separately.",
      dashboard: "http://localhost:5173 (development)",
      endpoints: [
        "GET  /api/health",
        "GET  /api/dashboard",
        "GET  /api/t3n/status",
        "GET  /api/policies",
        "GET  /api/demo/scenarios",
        "POST /api/requests",
        "GET  /api/audit",
        "GET  /api/audit/:auditId",
        "GET  /api/agent/status",
        "POST /api/agent/ask",
      ],
    });
  });

  // Unknown paths answer in the same error shape as every other route, rather
  // than falling through to Express's HTML default.
  app.use((req, res) => {
    res.status(404).json({
      error: {
        code: "NOT_FOUND",
        message: `No such endpoint: ${req.method} ${req.path}`,
        remediation: "See GET / for the list of available endpoints.",
      },
    });
  });

  // Terminal error handler.
  //
  // The per-route `handle()` wrapper catches anything thrown *inside* a
  // handler, but errors raised *before* one runs — malformed JSON or an
  // oversized body rejected by `express.json()` — bypass it entirely and hit
  // Express's default handler, which renders an HTML page containing a stack
  // trace and absolute filesystem paths. Sending `{"a",,}` to /api/requests
  // disclosed the deployment's directory layout. Everything now leaves through
  // the same safe projection as the rest of the API.
  app.use(
    (
      err: unknown,
      _req: express.Request,
      res: express.Response,
      _next: express.NextFunction,
    ): void => {
      const bodyError = err as { type?: string };
      const appError = toAppError(err);

      // Map body-parser's own failure types onto our vocabulary so a client
      // gets an actionable reason rather than a generic 500.
      if (bodyError?.type === "entity.parse.failed") {
        res.status(400).json({
          error: {
            code: "REQUEST_INVALID",
            message: "The request body is not valid JSON.",
            remediation: "Send a well-formed JSON object with content-type: application/json.",
          },
        });
        return;
      }
      if (bodyError?.type === "entity.too.large") {
        res.status(413).json({
          error: {
            code: "REQUEST_INVALID",
            message: "The request body is too large.",
            remediation: "Requests are limited to 128 kB.",
          },
        });
        return;
      }

      log.error("unhandled request error", {
        code: appError.code,
        message: appError.message,
        internal: appError.internal,
      });
      res.status(appError.status).json(appError.toPublicJSON());
    },
  );

  // Bind BEFORE warming the Terminal 3 connection.
  //
  // Two reasons. First, `listen` used to be the last statement, so a port
  // collision was discovered only after five seconds of loading the WASM
  // component and authenticating two identities against testnet — work that was
  // then thrown away. Now it fails in milliseconds. Second, `listen` emits its
  // failure as an `error` EVENT, not a rejection: with no listener attached,
  // Node re-threw it as an unhandled 'error' event *after* `main()` had already
  // resolved, so `main().catch()` never saw it and an operator whose port was
  // busy got a raw internal stack trace instead of a sentence telling them what
  // to do. Awaiting a promise that settles on either event fixes both.
  const server = await new Promise<import("node:http").Server>((resolve, reject) => {
    const listener = app.listen(config.port, () => resolve(listener));
    listener.on("error", (err: NodeJS.ErrnoException) => {
      if (err.code === "EADDRINUSE") {
        log.error(`port ${config.port} is already in use`, {
          remediation:
            "Stop whatever is listening on it, or set PORT in .env to a free port. Note that a PORT exported in your shell overrides .env.",
        });
      } else if (err.code === "EACCES") {
        log.error(`not permitted to bind port ${config.port}`, {
          remediation: "Ports below 1024 need elevated privileges. Choose a higher PORT.",
        });
      } else {
        log.error("the server could not start", { code: err.code, message: err.message });
      }
      reject(err);
    });
  });

  // Non-fatal, and deliberately after the bind: a request that arrives during
  // warmup joins the same in-flight connect rather than starting a second one,
  // so nothing races and the status page is reachable while it happens.
  await service.warmup();

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

  installShutdownHandlers(server);
}

/**
 * Stop cleanly on a signal, and never die silently on a stray error.
 *
 * Without this the process was killed instantly. Two things went wrong. A
 * request whose decision had already been appended to the journal got a socket
 * reset instead of a response, so the permanent record said a decision was made
 * and the caller never learned what it was. And a kill landing inside an
 * `appendFile` truncated the line being written — the exact damage `init()` now
 * has to repair on the next boot. Draining first makes both rare rather than
 * routine.
 *
 * The rejection and exception handlers are here for a different reason: Node's
 * default is to terminate with a stack trace on stderr and nothing in the
 * structured log, so a production crash left an operator reading the service
 * journal with no record of what happened.
 */
function installShutdownHandlers(server: import("node:http").Server): void {
  let shuttingDown = false;

  const shutdown = (signal: string, code = 0): void => {
    if (shuttingDown) {
      // A second Ctrl+C means "stop waiting". Honour it, rather than appearing
      // to hang while a slow request drains.
      log.warn(`${signal} received again — exiting immediately`);
      process.exit(130);
    }
    shuttingDown = true;
    log.info(`${signal} received — refusing new connections and draining`);

    // Bounded: a request wedged on a slow Terminal 3 call must not hold the
    // process open forever, or an operator's restart hangs.
    const timer = setTimeout(() => {
      log.warn("shutdown timed out after 10s — exiting with requests still in flight");
      process.exit(code || 1);
    }, 10_000);
    timer.unref();

    server.close((err) => {
      if (err) {
        log.error("error while closing the server", { message: err.message });
        process.exit(1);
      }
      log.info("shutdown complete");
      process.exit(code);
    });
  };

  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));

  process.on("unhandledRejection", (reason: unknown) => {
    log.error("unhandled promise rejection", {
      error: reason instanceof Error ? reason.message : String(reason),
      stack: reason instanceof Error ? reason.stack : undefined,
    });
    shutdown("unhandledRejection", 1);
  });

  process.on("uncaughtException", (err: Error) => {
    log.error("uncaught exception", { error: err.message, stack: err.stack });
    shutdown("uncaughtException", 1);
  });
}

main().catch((err: unknown) => {
  log.error("fatal startup error", { error: err instanceof Error ? err.message : String(err) });
  // A stack trace helps for an unexpected failure. For a bind failure we have
  // already printed the cause and the remediation in plain language, and
  // following it with Node's internal frames buries the useful line.
  const explained =
    err instanceof Error && typeof (err as NodeJS.ErrnoException).code === "string";
  if (!explained && err instanceof Error && err.stack) process.stderr.write(`${err.stack}\n`);
  process.exit(1);
});
