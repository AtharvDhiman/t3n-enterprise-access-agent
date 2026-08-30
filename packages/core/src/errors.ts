/**
 * Typed error hierarchy.
 *
 * Two audiences, one class: every error carries a `publicMessage` that is safe
 * to render in a browser, and an optional `internal` payload that is only ever
 * written to server logs. Route handlers serialize `toPublicJSON()`; nothing
 * else. That split is what keeps node URLs, key material and upstream response
 * bodies out of HTTP responses.
 */

export type ErrorCode =
  | "T3N_CONFIG_MISSING"
  | "T3N_AUTH_FAILED"
  | "T3N_NOT_AUTHORIZED"
  | "T3N_UNAVAILABLE"
  | "T3N_CAPABILITY_UNAVAILABLE"
  | "CLAIM_SOURCE_UNAVAILABLE"
  | "POLICY_NOT_FOUND"
  | "POLICY_INVALID"
  | "REQUEST_INVALID"
  | "AGENT_TOOL_FAILED"
  | "LLM_UNAVAILABLE"
  | "AUDIT_WRITE_FAILED"
  | "INTERNAL";

/** HTTP status paired with each code, so routes never hand-map statuses. */
const STATUS_BY_CODE: Record<ErrorCode, number> = {
  T3N_CONFIG_MISSING: 503,
  T3N_AUTH_FAILED: 502,
  T3N_NOT_AUTHORIZED: 403,
  T3N_UNAVAILABLE: 503,
  T3N_CAPABILITY_UNAVAILABLE: 501,
  CLAIM_SOURCE_UNAVAILABLE: 503,
  POLICY_NOT_FOUND: 404,
  POLICY_INVALID: 500,
  REQUEST_INVALID: 400,
  AGENT_TOOL_FAILED: 500,
  LLM_UNAVAILABLE: 503,
  AUDIT_WRITE_FAILED: 500,
  INTERNAL: 500,
};

export interface AppErrorOptions {
  /** Safe to show a user. Must not contain secrets or personal data. */
  publicMessage?: string;
  /** Server-log-only context. */
  internal?: Record<string, unknown>;
  /** Concrete, actionable next step for the operator or user. */
  remediation?: string;
  cause?: unknown;
}

export class AppError extends Error {
  readonly code: ErrorCode;
  readonly status: number;
  readonly publicMessage: string;
  readonly remediation: string | null;
  readonly internal: Record<string, unknown>;

  constructor(code: ErrorCode, message: string, options: AppErrorOptions = {}) {
    super(message, options.cause !== undefined ? { cause: options.cause } : undefined);
    this.name = new.target.name;
    this.code = code;
    this.status = STATUS_BY_CODE[code];
    this.publicMessage = options.publicMessage ?? message;
    this.remediation = options.remediation ?? null;
    this.internal = options.internal ?? {};
  }

  /** The only shape that may cross the HTTP boundary. */
  toPublicJSON(): {
    error: { code: ErrorCode; message: string; remediation: string | null };
  } {
    return {
      error: {
        code: this.code,
        message: this.publicMessage,
        remediation: this.remediation,
      },
    };
  }
}

/** T3N credentials absent or malformed. */
export class T3nConfigMissingError extends AppError {
  constructor(detail: string, options: AppErrorOptions = {}) {
    super("T3N_CONFIG_MISSING", `T3N configuration incomplete: ${detail}`, {
      publicMessage: "Terminal 3 is not configured on this server.",
      remediation:
        "Set T3N_API_KEY and T3N_AGENT_KEY in .env, then restart. Claim keys at https://www.terminal3.io/claim-page",
      ...options,
    });
  }
}

/** Handshake or authenticate failed against the node. */
export class T3nAuthError extends AppError {
  constructor(detail: string, options: AppErrorOptions = {}) {
    super("T3N_AUTH_FAILED", `T3N authentication failed: ${detail}`, {
      publicMessage: "Could not authenticate with Terminal 3.",
      remediation:
        "Verify the keys in .env are valid secp256k1 keys claimed from the Terminal 3 claim page, and that T3N_ENV matches where they were issued.",
      ...options,
    });
  }
}

/**
 * The agent is authenticated but the subject has not granted it access.
 *
 * This is a first-class, *expected* outcome — not a failure. It is precisely the
 * case the privacy model exists to make visible.
 */
export class T3nNotAuthorizedError extends AppError {
  readonly missingScopes: readonly string[];

  constructor(missingScopes: readonly string[], options: AppErrorOptions = {}) {
    super(
      "T3N_NOT_AUTHORIZED",
      `agent lacks consent for scopes: ${missingScopes.join(", ")}`,
      {
        publicMessage:
          "The subject has not authorized this agent to read the information this policy requires.",
        remediation:
          "The subject (data owner) must grant this agent DID access to the listed scopes before the request can be evaluated.",
        ...options,
      },
    );
    this.missingScopes = missingScopes;
  }
}

/** Node unreachable, timed out, or returned an unusable response. */
export class T3nUnavailableError extends AppError {
  constructor(detail: string, options: AppErrorOptions = {}) {
    super("T3N_UNAVAILABLE", `T3N unavailable: ${detail}`, {
      publicMessage: "Terminal 3 is currently unreachable.",
      remediation: "Check https://status.terminal3.io/ and retry.",
      ...options,
    });
  }
}

/** An SDK/platform capability this build needs is not available. */
export class T3nCapabilityUnavailableError extends AppError {
  constructor(capability: string, options: AppErrorOptions = {}) {
    super("T3N_CAPABILITY_UNAVAILABLE", `capability unavailable: ${capability}`, {
      publicMessage: `Terminal 3 capability "${capability}" is not available in this environment.`,
      remediation: "Check the SDK version and the ADK changelog for this capability.",
      ...options,
    });
  }
}

export class ClaimSourceUnavailableError extends AppError {
  constructor(detail: string, options: AppErrorOptions = {}) {
    super("CLAIM_SOURCE_UNAVAILABLE", `claim source unavailable: ${detail}`, {
      publicMessage: "The claim source could not be consulted.",
      remediation: "Check CLAIM_SOURCE in .env and the Terminal 3 connection status.",
      ...options,
    });
  }
}

export class PolicyNotFoundError extends AppError {
  constructor(policyId: string, available: readonly string[] = []) {
    super("POLICY_NOT_FOUND", `no policy with id "${policyId}"`, {
      publicMessage: `No policy named "${policyId}" is configured.`,
      remediation:
        available.length > 0
          ? `Available policies: ${available.join(", ")}. Policies live in config/policies.yaml.`
          : "Define the policy in config/policies.yaml.",
      internal: { policyId, available },
    });
  }
}

export class PolicyInvalidError extends AppError {
  constructor(detail: string, options: AppErrorOptions = {}) {
    super("POLICY_INVALID", `policy configuration invalid: ${detail}`, {
      publicMessage: "The policy configuration is invalid.",
      remediation: "Fix config/policies.yaml. Run `npm test` to validate it.",
      ...options,
    });
  }
}

export class RequestInvalidError extends AppError {
  readonly issues: readonly string[];

  constructor(issues: readonly string[]) {
    super("REQUEST_INVALID", `request validation failed: ${issues.join("; ")}`, {
      publicMessage: "The request is not valid.",
      remediation: issues.join("; "),
      internal: { issues },
    });
    this.issues = issues;
  }
}

export class AgentToolError extends AppError {
  constructor(tool: string, detail: string, options: AppErrorOptions = {}) {
    super("AGENT_TOOL_FAILED", `tool "${tool}" failed: ${detail}`, {
      publicMessage: `The agent could not complete the "${tool}" step.`,
      ...options,
      internal: { tool, ...(options.internal ?? {}) },
    });
  }
}

export class LlmUnavailableError extends AppError {
  constructor(detail: string, options: AppErrorOptions = {}) {
    super("LLM_UNAVAILABLE", `language model unavailable: ${detail}`, {
      publicMessage: "The natural-language layer is not available.",
      remediation:
        "Set OPENAI_API_KEY (works with OpenAI, Gemini, Groq, OpenRouter or a local Ollama) or ANTHROPIC_API_KEY in .env. All other features work without it.",
      ...options,
    });
  }
}

export class AuditWriteError extends AppError {
  constructor(detail: string, options: AppErrorOptions = {}) {
    super("AUDIT_WRITE_FAILED", `audit write failed: ${detail}`, {
      publicMessage: "The decision could not be recorded to the audit log.",
      remediation: "Check AUDIT_LOG_PATH is writable.",
      ...options,
    });
  }
}

/** Narrow an unknown thrown value to an AppError, wrapping anything else. */
export function toAppError(err: unknown): AppError {
  if (err instanceof AppError) return err;
  const message = err instanceof Error ? err.message : String(err);
  return new AppError("INTERNAL", message, {
    publicMessage: "An unexpected internal error occurred.",
    cause: err,
  });
}
