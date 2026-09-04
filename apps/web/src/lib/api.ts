/**
 * API client and the shapes the server returns.
 *
 * These interfaces are written by hand rather than imported from the server
 * workspace on purpose: importing from `@t3n-aca/t3n` would pull the Terminal 3
 * SDK — and its WASM component — into the browser bundle, which is exactly what
 * the architecture forbids. Duplicating a handful of response shapes is the
 * cheap price of that guarantee, and `npm run typecheck` covers both sides.
 */

export type Decision = "APPROVED" | "REVIEW_REQUIRED" | "DENIED";
export type ClaimSourceKind = "LIVE_T3N" | "DEMO_FIXTURE";
export type SubjectType = "employee" | "contractor" | "vendor" | "partner";

export interface RequirementResult {
  claimId: string;
  satisfied: boolean;
  reason:
    | "satisfied"
    | "missing"
    | "not_verified"
    | "expired"
    | "insufficient_assurance"
    | "not_authorized";
  detail: string;
}

export interface RiskFlag {
  code: string;
  severity: "low" | "medium" | "high";
  message: string;
}

export interface DecisionResult {
  decision: Decision;
  policy: string;
  policyVersion: string;
  reason: string;
  requirements: string[];
  satisfiedRequirements: string[];
  missingRequirements: string[];
  requirementDetail: RequirementResult[];
  riskFlags: RiskFlag[];
  nextAction: string;
  timestamp: string;
  auditId: string;
  dataAccess: {
    source: ClaimSourceKind;
    requestedScopes: string[];
    authorizedScopes: string[];
    deniedScopes: string[];
    consentVerified: boolean;
    claimsRead: number;
  };
}

export interface AuditRecord {
  auditId: string;
  timestamp: string;
  agentId: string;
  requestType: string;
  policyId: string;
  policyVersion: string;
  decision: Decision;
  subjectHash: string;
  subjectType: SubjectType;
  resource: string;
  accessLevel: string;
  claimSource: ClaimSourceKind;
  scopesRequested: string[];
  scopesAuthorized: string[];
  claimsUsed: string[];
  missingRequirements: string[];
  riskFlags: string[];
  nextAction: string;
  actor: string;
}

export interface IdentityStatus {
  authenticated: boolean;
  did: string | null;
  shortDid: string;
  organisations: string[];
  owner: string | null;
  balance: string | null;
}

export interface T3nStatus {
  configured: boolean;
  configError: string | null;
  warnings: string[];
  environment: string;
  nodeUrl: string | null;
  state: "disconnected" | "connecting" | "connected" | "error";
  wasmLoaded: boolean;
  tenant: IdentityStatus;
  agent: IdentityStatus;
  orgDid: string | null;
  contractId: string;
  enforcementMode: "AGENT_SESSION" | "DELEGATED_TENANT_READ" | "UNAVAILABLE";
  enforcementDetail: string;
  lastError: string | null;
  lastCheckedAt: string | null;
  connectedAt: string | null;
}

export interface PolicySummary {
  id: string;
  label: string;
  description: string;
  subjectTypes: string[];
  resources: string[];
  accessLevels: string[];
  requiredClaims: string[];
  optionalClaims: string[];
  requiredScopes: string[];
  rules: {
    minimumAssurance: string;
    maxClaimAgeDays: number;
    expiredClaimBehavior: string;
    failedClaimBehavior: string;
    expiringSoonDays: number;
    requireManualApproval: boolean;
    flagMissingOptional: boolean;
  };
}

export interface ClaimDefinition {
  id: string;
  scope: string;
  label: string;
  description: string;
}

export interface DashboardSummary {
  stats: {
    total: number;
    approved: number;
    reviewRequired: number;
    denied: number;
    byPolicy: Record<string, number>;
    liveDecisions: number;
    demoDecisions: number;
  };
  recent: AuditRecord[];
  policyCount: number;
  claimSource: { mode: "live" | "demo"; kind: ClaimSourceKind; description: string };
}

export interface DemoScenario {
  id: string;
  label: string;
  narrative: string;
  subjectRef: string;
  subjectLabel: string;
  subjectType: SubjectType;
  resource: string;
  accessLevel: string;
  policyId: string;
  expectedDecision: Decision;
  consentedScopes: string[];
}

export interface AgentTurn {
  reply: string;
  toolsUsed: Array<{ name: string; ok: boolean }>;
  decision: unknown | null;
}

/** Error shape every failing endpoint returns. */
export class ApiError extends Error {
  readonly code: string;
  readonly remediation: string | null;
  readonly status: number;

  constructor(status: number, code: string, message: string, remediation: string | null) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.code = code;
    this.remediation = remediation;
  }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  let response: Response;
  try {
    response = await fetch(`/api${path}`, {
      headers: { "content-type": "application/json" },
      ...init,
    });
  } catch {
    throw new ApiError(
      0,
      "NETWORK",
      "Could not reach the server.",
      "Check that the API is running (npm run dev:server).",
    );
  }

  // Inside a try. `fetch` resolves as soon as the headers arrive, so a
  // connection that dies while the body is streaming rejects HERE, not above —
  // and it rejects with a raw TypeError. Every caller does
  // `catch (err) { if (err instanceof ApiError) ... }`, so that TypeError was
  // swallowed by all of them and the page sat on "Loading…" forever with
  // nothing on screen or in the console to say why.
  let text: string;
  try {
    text = await response.text();
  } catch {
    throw new ApiError(
      response.status,
      "NETWORK",
      "The connection dropped while the server was responding.",
      "Check that the API is still running, then try again.",
    );
  }
  let body: unknown = null;
  if (text.length > 0) {
    try {
      body = JSON.parse(text);
    } catch {
      throw new ApiError(response.status, "BAD_RESPONSE", "The server returned an unreadable response.", null);
    }
  }

  if (!response.ok) {
    const err = (body as { error?: { code?: string; message?: string; remediation?: string | null } })
      ?.error;
    throw new ApiError(
      response.status,
      err?.code ?? "UNKNOWN",
      err?.message ?? `Request failed with status ${response.status}.`,
      err?.remediation ?? null,
    );
  }

  return body as T;
}

export interface AuditQuery {
  decision?: string;
  policyId?: string;
  subjectType?: string;
  search?: string;
  limit?: number;
  offset?: number;
}

export const api = {
  dashboard: () => request<DashboardSummary>("/dashboard"),
  t3nStatus: () => request<T3nStatus>("/t3n/status"),
  policies: () =>
    request<{ version: string; policies: PolicySummary[]; claims: ClaimDefinition[] }>("/policies"),
  scenarios: () =>
    request<{ source: string; scenarios: DemoScenario[] }>("/demo/scenarios"),
  evaluate: (body: Record<string, unknown>) =>
    request<DecisionResult>("/requests", { method: "POST", body: JSON.stringify(body) }),
  audit: (q: AuditQuery = {}) => {
    const params = new URLSearchParams();
    for (const [k, v] of Object.entries(q)) {
      if (v !== undefined && v !== "" && v !== null) params.set(k, String(v));
    }
    const qs = params.toString();
    return request<{ records: AuditRecord[]; total: number; offset: number; limit: number }>(
      `/audit${qs ? `?${qs}` : ""}`,
    );
  },
  agentStatus: () =>
    request<{
      available: boolean;
      provider: string | null;
      model: string | null;
      reason: string | null;
    }>("/agent/status"),
  ask: (message: string, history: Array<{ role: "user" | "assistant"; content: string }> = []) =>
    request<AgentTurn>("/agent/ask", {
      method: "POST",
      body: JSON.stringify({ message, history }),
    }),
};
