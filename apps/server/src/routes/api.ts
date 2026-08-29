/**
 * HTTP API.
 *
 * Every handler follows the same shape: parse, delegate, serialise. No business
 * logic lives here.
 *
 * Two rules hold across all of them:
 *   - errors leave via `toAppError().toPublicJSON()`, so a response can never
 *     carry an internal message, a node URL, or key material;
 *   - nothing derived from a credential is ever serialised, including in the
 *     status route, which returns DIDs (public identifiers) and never keys.
 */

import { Router, type Request, type Response } from "express";
import { z } from "zod";

import { createLogger, toAppError } from "@t3n-aca/core";
import { DEMO_SCENARIOS } from "@t3n-aca/t3n";

import type { ComplianceService } from "../service.ts";
import type { ComplianceAgent } from "../agent/agent.ts";

const log = createLogger("api");

/** Wrap an async handler so a rejection becomes a typed JSON error. */
function handle(fn: (req: Request, res: Response) => Promise<void>) {
  return async (req: Request, res: Response): Promise<void> => {
    try {
      await fn(req, res);
    } catch (err) {
      const appError = toAppError(err);
      // Full detail to the server log, safe projection to the caller.
      log.error("request failed", {
        path: req.path,
        code: appError.code,
        message: appError.message,
        internal: appError.internal,
      });
      res.status(appError.status).json(appError.toPublicJSON());
    }
  };
}

const AuditQuerySchema = z.object({
  decision: z.enum(["APPROVED", "REVIEW_REQUIRED", "DENIED"]).optional(),
  policyId: z.string().max(120).optional(),
  subjectType: z.enum(["employee", "contractor", "vendor", "partner"]).optional(),
  from: z.string().max(40).optional(),
  to: z.string().max(40).optional(),
  search: z.string().max(200).optional(),
  limit: z.coerce.number().int().min(1).max(200).optional(),
  offset: z.coerce.number().int().min(0).optional(),
});

const AskSchema = z.object({
  message: z.string().min(1).max(4000),
});

export function createApiRouter(
  service: ComplianceService,
  agent: ComplianceAgent | null,
): Router {
  const router = Router();

  // --- health ------------------------------------------------------------
  router.get(
    "/health",
    handle(async (_req, res) => {
      res.json({ ok: true, uptimeSeconds: Math.round(process.uptime()) });
    }),
  );

  // --- dashboard ---------------------------------------------------------
  router.get(
    "/dashboard",
    handle(async (_req, res) => {
      res.json(service.dashboard());
    }),
  );

  // --- T3N status --------------------------------------------------------
  router.get(
    "/t3n/status",
    handle(async (_req, res) => {
      res.json(service.t3nStatus());
    }),
  );

  // --- policies ----------------------------------------------------------
  router.get(
    "/policies",
    handle(async (_req, res) => {
      res.json({
        version: service.engine.version,
        policies: service.listPolicies(),
        claims: service.listClaims(),
      });
    }),
  );

  // --- demo scenarios ----------------------------------------------------
  router.get(
    "/demo/scenarios",
    handle(async (_req, res) => {
      res.json({
        // Explicitly labelled at the API boundary too, not only in the UI.
        source: "DEMO_FIXTURE",
        scenarios: DEMO_SCENARIOS.map((s) => ({
          id: s.id,
          label: s.label,
          narrative: s.narrative,
          subjectRef: s.subjectRef,
          subjectLabel: s.subjectLabel,
          subjectType: s.subjectType,
          resource: s.suggestedResource,
          accessLevel: s.suggestedAccessLevel,
          policyId: s.suggestedPolicy,
          expectedDecision: s.expectedDecision,
          consentedScopes: s.consentedScopes,
        })),
      });
    }),
  );

  // --- evaluate ----------------------------------------------------------
  router.post(
    "/requests",
    handle(async (req, res) => {
      const { decision } = await service.evaluate(req.body, { actor: "ui" });
      res.status(200).json(decision);
    }),
  );

  // --- audit -------------------------------------------------------------
  router.get(
    "/audit",
    handle(async (req, res) => {
      const parsed = AuditQuerySchema.safeParse(req.query);
      if (!parsed.success) {
        res.status(400).json({
          error: {
            code: "REQUEST_INVALID",
            message: "Invalid audit query.",
            remediation: parsed.error.issues.map((i) => i.message).join("; "),
          },
        });
        return;
      }
      res.json(service.audit.query(parsed.data));
    }),
  );

  router.get(
    "/audit/:auditId",
    handle(async (req, res) => {
      const record = service.audit.get(String(req.params.auditId));
      if (!record) {
        res.status(404).json({
          error: { code: "NOT_FOUND", message: "No such audit record.", remediation: null },
        });
        return;
      }
      res.json(record);
    }),
  );

  // --- natural language --------------------------------------------------
  router.get(
    "/agent/status",
    handle(async (_req, res) => {
      res.json({
        available: agent !== null,
        reason: agent
          ? null
          : "ANTHROPIC_API_KEY is not set. Every other feature works without it.",
      });
    }),
  );

  router.post(
    "/agent/ask",
    handle(async (req, res) => {
      if (!agent) {
        res.status(503).json({
          error: {
            code: "LLM_UNAVAILABLE",
            message: "The natural-language layer is not enabled on this server.",
            remediation: "Set ANTHROPIC_API_KEY in .env and restart.",
          },
        });
        return;
      }
      const parsed = AskSchema.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({
          error: { code: "REQUEST_INVALID", message: "A message is required.", remediation: null },
        });
        return;
      }
      const turn = await agent.run(parsed.data.message, { service, actor: "agent" });
      res.json(turn);
    }),
  );

  return router;
}
