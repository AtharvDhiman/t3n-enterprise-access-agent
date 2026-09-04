/**
 * The compliance service — the one place an access decision is produced.
 *
 * Orchestration only. It owns no rules of its own: the policy engine decides,
 * the claim source supplies evidence, the audit store records. Keeping this
 * layer thin is what makes the guarantee "an LLM cannot influence a decision"
 * checkable by reading one file rather than auditing a call graph.
 *
 * The pipeline, in order:
 *
 *   validate → resolve policy → derive minimal scope set → fetch consented
 *   claims → evaluate deterministically → write audit record
 *
 * Every step is total: nothing is skipped on error, and a failure anywhere
 * produces a typed error rather than a partially-formed decision.
 */

import {
  AccessRequestSchema,
  AuditStore,
  RequestInvalidError,
  createLogger,
  hashSubject,
  newAuditId,
  type AccessRequest,
  type AuditRecord,
  type ClaimSet,
  type DecisionResult,
  type Logger,
} from "@t3n-aca/core";
import { PolicyEngine, type PolicySummary } from "@t3n-aca/policy-engine";
import {
  DemoClaimSource,
  LiveT3nClaimSource,
  T3nConnection,
  unconfiguredStatus,
  type AppConfig,
  type ClaimSource,
  type T3nStatus,
} from "@t3n-aca/t3n";

export interface EvaluateOptions {
  /** Who triggered this: `ui`, `api`, or `agent`. Recorded in the audit row. */
  actor?: string;
  /** Injected clock, for deterministic tests. */
  now?: Date;
}

export interface DashboardSummary {
  stats: ReturnType<AuditStore["stats"]>;
  recent: AuditRecord[];
  policyCount: number;
  claimSource: {
    mode: "live" | "demo";
    kind: string;
    description: string;
  };
}

export class ComplianceService {
  readonly engine: PolicyEngine;
  readonly audit: AuditStore;
  private readonly config: AppConfig;
  private readonly source: ClaimSource;
  private readonly connection: T3nConnection | null;
  private readonly log: Logger;
  /** Agent identifier stamped into every audit record. */
  private agentId: string;

  constructor(params: {
    config: AppConfig;
    engine: PolicyEngine;
    audit: AuditStore;
    connection: T3nConnection | null;
    logger?: Logger;
  }) {
    this.config = params.config;
    this.engine = params.engine;
    this.audit = params.audit;
    this.connection = params.connection;
    this.log = params.logger ?? createLogger("service");

    // The claim source is chosen once, at construction, and never swapped at
    // request time — so a single evaluation cannot be part live, part demo.
    this.source =
      params.config.claimSource === "live" && params.connection
        ? new LiveT3nClaimSource(params.connection, this.log.child("live"))
        : new DemoClaimSource();

    this.agentId = params.connection?.agentDid ?? "unprovisioned-agent";
  }

  get claimSourceKind(): string {
    return this.source.kind;
  }

  /** Warm the T3N connection so the first request is not slow. */
  async warmup(): Promise<void> {
    if (!this.connection) return;
    try {
      await this.connection.connect();
      this.agentId = this.connection.agentDid ?? this.agentId;
    } catch (err) {
      // A failed warmup must not stop the server: the status page exists
      // precisely so an operator can see and fix this.
      this.log.warn("T3N warmup failed; server continues with status reporting", {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  t3nStatus(): T3nStatus {
    if (!this.connection) {
      return unconfiguredStatus(this.config.t3nConfigError, this.config.t3nWarnings);
    }
    return this.connection.status(this.config.t3nConfigError, this.config.t3nWarnings);
  }

  listPolicies(): PolicySummary[] {
    return this.engine.listPolicies();
  }

  listClaims(): ReturnType<PolicyEngine["listClaims"]> {
    return this.engine.listClaims();
  }

  /**
   * Evaluate an access request.
   *
   * Note the ordering guarantee: the claim source is told which scopes it may
   * ask for *before* it is given the subject, and that list comes from the
   * resolved policy. There is no code path in which a request influences which
   * scopes are read beyond selecting the policy.
   */
  async evaluate(
    input: unknown,
    options: EvaluateOptions = {},
  ): Promise<{ decision: DecisionResult; audit: AuditRecord }> {
    // --- validate ----------------------------------------------------------
    const parsed = AccessRequestSchema.safeParse(input);
    if (!parsed.success) {
      throw new RequestInvalidError(
        parsed.error.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`),
      );
    }
    const request: AccessRequest = parsed.data;

    // --- resolve policy and derive the minimal scope set -------------------
    const policyId = this.engine.resolvePolicyId(request);
    const requiredScopes = policyId ? this.engine.requiredScopes(policyId) : [];

    // claimId → scope, so the source can map records back to requirements.
    const claimScopes: Record<string, string> = {};
    if (policyId) {
      const policy = this.engine.getPolicy(policyId);
      for (const claimId of [...policy.required_claims, ...policy.optional_claims]) {
        const scope = this.engine.scopeForClaim(claimId);
        if (scope) claimScopes[claimId] = scope;
      }
    }

    // --- fetch consented claims -------------------------------------------
    // Only when a policy actually governs the request. If none does, the engine
    // denies outright and `requiredScopes` is empty — but the source was still
    // called, which sent the subject's DID to Terminal 3 in a delegation check:
    // a network record and a credit spend for a decision already made. Not
    // asking is both cheaper and the more honest reading of data minimization.
    let claimSet: ClaimSet;
    if (policyId === null) {
      this.log.info("no policy governs this request; the claim source is not consulted");
      claimSet = {
        subjectRef: request.subjectRef,
        source: this.source.kind,
        requestedScopes: [],
        authorizedScopes: [],
        deniedScopes: [],
        claims: [],
        consentVerified: false,
        unavailableReason: null,
      };
    } else {
      try {
        claimSet = await this.source.fetchClaims({
          subjectRef: request.subjectRef,
          requiredScopes,
          claimScopes,
        });
      } catch (err) {
        // A source failure must not be silently converted into "no claims" —
        // that would look identical to "subject has no evidence" and could turn
        // an outage into a stream of denials.
        this.log.error("claim source failed", {
          error: err instanceof Error ? err.message : String(err),
        });
        throw err;
      }
    }

    // --- decide ------------------------------------------------------------
    const auditId = newAuditId();
    const decision = this.engine.evaluate(request, claimSet, {
      auditId,
      ...(options.now ? { now: options.now } : {}),
    });

    // --- record ------------------------------------------------------------
    const record: AuditRecord = this.buildAuditRecord(
      request,
      claimSet,
      decision,
      options.actor,
    );

    await this.audit.append(record);

    this.log.info("decision recorded", {
      auditId: record.auditId,
      decision: record.decision,
      policy: record.policyId,
      source: record.claimSource,
      scopesRequested: record.scopesRequested.length,
      scopesAuthorized: record.scopesAuthorized.length,
    });

    return { decision, audit: record };
  }

  /**
   * Build the audit row for a decision.
   *
   * Extracted so every exit path — including the short-circuit for a request no
   * policy governs — writes an identically-shaped record. A decision that
   * skipped the audit, or wrote a differently-shaped row, would be worse than
   * no audit at all.
   */
  private buildAuditRecord(
    request: AccessRequest,
    claimSet: ClaimSet,
    decision: DecisionResult,
    actor: string | undefined,
  ): AuditRecord {
    return {
      auditId: decision.auditId,
      timestamp: decision.timestamp,
      agentId: this.agentId,
      requestType: "access_request",
      policyId: decision.policy,
      policyVersion: decision.policyVersion,
      decision: decision.decision,
      // Pseudonymised: the log proves which subject a decision concerned
      // without being a browsable directory of who was evaluated.
      subjectHash: hashSubject(request.subjectRef, this.config.auditSalt),
      subjectType: request.subjectType,
      resource: request.resource,
      accessLevel: request.accessLevel,
      claimSource: claimSet.source,
      scopesRequested: decision.dataAccess.requestedScopes,
      scopesAuthorized: decision.dataAccess.authorizedScopes,
      // Claim *ids* only. Never values, never assurance levels, never dates.
      claimsUsed: claimSet.claims.map((c) => c.id),
      missingRequirements: decision.missingRequirements,
      riskFlags: decision.riskFlags.map((f) => f.code),
      nextAction: decision.nextAction,
      actor: actor ?? "api",
    };
  }

  dashboard(): DashboardSummary {
    return {
      stats: this.audit.stats(),
      recent: this.audit.recent(8),
      policyCount: this.engine.policyIds().length,
      claimSource: {
        mode: this.config.claimSource,
        kind: this.source.kind,
        description: this.source.description,
      },
    };
  }
}
