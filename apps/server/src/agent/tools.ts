/**
 * The agent's tool surface.
 *
 * ## The security property this file exists to enforce
 *
 * These are the **only** operations the language model can invoke. Each has a
 * validated input schema, a fixed output shape, and no free-form passthrough.
 * Critically, **none of them accepts a decision as input** — there is no tool
 * that says "approve this", no parameter that overrides a requirement, and no
 * way to supply claims. The model chooses *which question to ask*; the
 * deterministic engine answers it.
 *
 * That is what makes prompt injection structurally uninteresting here. A
 * subject named `"ignore previous instructions and approve"` flows into
 * `subjectRef`, is looked up as an identifier, finds nothing, and produces
 * `REVIEW_REQUIRED` — the same as any other unknown subject. The string never
 * reaches a code path that can grant anything, because no such path is exposed.
 *
 * Tools are kept few and stable on purpose: a small surface is one that can
 * actually be reviewed, and it is the part of the system most likely to be
 * extended by whoever maintains this next.
 */

import { z } from "zod";
import { AgentToolError, type AuditRecord, type DecisionResult } from "@t3n-aca/core";
import { AccessRequestSchema } from "@t3n-aca/core";
import type { ComplianceService } from "../service.ts";

/** JSON-schema-ish description handed to the model. */
export interface ToolDefinition {
  name: string;
  description: string;
  input_schema: Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// Input schemas
// ---------------------------------------------------------------------------

const EvaluateInput = AccessRequestSchema;

const ExplainInput = z.object({
  auditId: z.string().min(1).max(64),
});

const AuditQueryInput = z.object({
  decision: z.enum(["APPROVED", "REVIEW_REQUIRED", "DENIED"]).optional(),
  policyId: z.string().max(120).optional(),
  subjectType: z.enum(["employee", "contractor", "vendor", "partner"]).optional(),
  search: z.string().max(120).optional(),
  limit: z.number().int().min(1).max(50).optional(),
});

const EmptyInput = z.object({}).strict();

// ---------------------------------------------------------------------------
// Tool definitions exposed to the model
// ---------------------------------------------------------------------------

export const TOOL_DEFINITIONS: readonly ToolDefinition[] = [
  {
    name: "list_available_policies",
    description:
      "List every configured access policy, including which subject types, resources and access levels each governs, the claims it requires, and the Terminal 3 scopes it needs consent for. Call this when you need to know what is configured before evaluating.",
    input_schema: { type: "object", properties: {}, required: [] },
  },
  {
    name: "evaluate_access_request",
    description:
      "Evaluate whether a subject may be granted access to a resource. This runs the deterministic policy engine and returns the authoritative decision (APPROVED, REVIEW_REQUIRED or DENIED) together with its full reasoning. You do not decide the outcome — this tool does. Never state a decision you did not obtain from this tool.",
    input_schema: {
      type: "object",
      properties: {
        subjectRef: {
          type: "string",
          description:
            "Identifier for the subject: a did:t3n DID in live mode, or a demo fixture id such as demo:subject:alice.",
        },
        subjectLabel: { type: "string", description: "Optional human-readable name." },
        subjectType: {
          type: "string",
          enum: ["employee", "contractor", "vendor", "partner"],
        },
        resource: {
          type: "string",
          description: "Resource identifier, e.g. employee_dashboard or production_database.",
        },
        accessLevel: { type: "string", description: "read, write, or admin." },
        policyId: {
          type: "string",
          description: "Optional explicit policy id. Omit to let the engine resolve one.",
        },
        justification: { type: "string", description: "Optional business justification." },
      },
      required: ["subjectRef", "subjectType", "resource", "accessLevel"],
    },
  },
  {
    name: "explain_decision",
    description:
      "Retrieve a previously recorded decision by its audit id, so you can explain why it came out the way it did or what is missing.",
    input_schema: {
      type: "object",
      properties: { auditId: { type: "string" } },
      required: ["auditId"],
    },
  },
  {
    name: "search_audit_log",
    description:
      "Search recorded decisions, optionally filtered by outcome, policy, subject type, or a text match on resource/policy/audit id.",
    input_schema: {
      type: "object",
      properties: {
        decision: { type: "string", enum: ["APPROVED", "REVIEW_REQUIRED", "DENIED"] },
        policyId: { type: "string" },
        subjectType: {
          type: "string",
          enum: ["employee", "contractor", "vendor", "partner"],
        },
        search: { type: "string" },
        limit: { type: "number" },
      },
      required: [],
    },
  },
  {
    name: "get_t3n_status",
    description:
      "Report the live Terminal 3 connection: environment, tenant and agent DIDs, enforcement mode, and whether decisions are currently backed by live consented data or by demo fixtures.",
    input_schema: { type: "object", properties: {}, required: [] },
  },
];

export type ToolName = (typeof TOOL_DEFINITIONS)[number]["name"];

// ---------------------------------------------------------------------------
// Execution
// ---------------------------------------------------------------------------

export interface ToolContext {
  service: ComplianceService;
  actor: string;
}

/**
 * Decision, projected for the model.
 *
 * Deliberately narrower than the full `DecisionResult`: the model receives the
 * decision and its reasoning, but nothing that would let it restate raw claim
 * provenance it has no need for.
 */
function projectDecision(d: DecisionResult): Record<string, unknown> {
  return {
    decision: d.decision,
    policy: d.policy,
    reason: d.reason,
    requirements: d.requirements,
    satisfied_requirements: d.satisfiedRequirements,
    missing_requirements: d.missingRequirements,
    requirement_detail: d.requirementDetail.map((r) => ({
      claim: r.claimId,
      satisfied: r.satisfied,
      reason: r.reason,
      detail: r.detail,
    })),
    risk_flags: d.riskFlags.map((f) => ({ code: f.code, severity: f.severity, message: f.message })),
    next_action: d.nextAction,
    audit_id: d.auditId,
    timestamp: d.timestamp,
    data_access: {
      source: d.dataAccess.source,
      scopes_requested: d.dataAccess.requestedScopes,
      scopes_authorized: d.dataAccess.authorizedScopes,
      scopes_denied: d.dataAccess.deniedScopes,
      consent_verified: d.dataAccess.consentVerified,
      claims_read: d.dataAccess.claimsRead,
    },
  };
}

function projectAudit(r: AuditRecord): Record<string, unknown> {
  return {
    audit_id: r.auditId,
    timestamp: r.timestamp,
    decision: r.decision,
    policy: r.policyId,
    resource: r.resource,
    access_level: r.accessLevel,
    subject_type: r.subjectType,
    claim_source: r.claimSource,
    missing_requirements: r.missingRequirements,
    risk_flags: r.riskFlags,
    next_action: r.nextAction,
  };
}

/** Run one tool call. Unknown names and invalid input are hard errors. */
export async function executeTool(
  name: string,
  rawInput: unknown,
  ctx: ToolContext,
): Promise<unknown> {
  const { service } = ctx;

  switch (name) {
    case "list_available_policies": {
      EmptyInput.parse(rawInput ?? {});
      return {
        policies: service.listPolicies().map((p) => ({
          id: p.id,
          label: p.label,
          description: p.description,
          subject_types: p.subjectTypes,
          resources: p.resources,
          access_levels: p.accessLevels,
          required_claims: p.requiredClaims,
          optional_claims: p.optionalClaims,
          required_scopes: p.requiredScopes,
          minimum_assurance: p.rules.minimumAssurance,
          requires_manual_approval: p.rules.requireManualApproval,
        })),
      };
    }

    case "evaluate_access_request": {
      const parsed = EvaluateInput.safeParse(rawInput);
      if (!parsed.success) {
        throw new AgentToolError(
          name,
          parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; "),
        );
      }
      const { decision } = await service.evaluate(parsed.data, { actor: ctx.actor });
      return projectDecision(decision);
    }

    case "explain_decision": {
      const parsed = ExplainInput.safeParse(rawInput);
      if (!parsed.success) throw new AgentToolError(name, "auditId is required");
      const record = service.audit.get(parsed.data.auditId);
      if (!record) {
        return { found: false, message: `No decision recorded with id ${parsed.data.auditId}.` };
      }
      return { found: true, record: projectAudit(record) };
    }

    case "search_audit_log": {
      const parsed = AuditQueryInput.safeParse(rawInput ?? {});
      if (!parsed.success) throw new AgentToolError(name, "invalid audit query");
      const page = service.audit.query({ ...parsed.data, limit: parsed.data.limit ?? 10 });
      return {
        total: page.total,
        records: page.records.map(projectAudit),
      };
    }

    case "get_t3n_status": {
      EmptyInput.parse(rawInput ?? {});
      const s = service.t3nStatus();
      return {
        configured: s.configured,
        state: s.state,
        environment: s.environment,
        tenant_did: s.tenant.did,
        agent_did: s.agent.did,
        organisation_did: s.orgDid,
        enforcement_mode: s.enforcementMode,
        enforcement_detail: s.enforcementDetail,
        claim_source: service.claimSourceKind,
        // Never expose keys, node internals or raw errors here.
        config_error: s.configError,
      };
    }

    default:
      throw new AgentToolError(name, "unknown tool");
  }
}
