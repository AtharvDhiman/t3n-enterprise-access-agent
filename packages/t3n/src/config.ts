/**
 * Terminal 3 configuration, read from the environment.
 *
 * Two jobs, both about failing honestly:
 *
 *  1. Never let key material reach anywhere it should not. Config is loaded in
 *     the Node process only and is never serialised to a client.
 *  2. Distinguish *absent* from *placeholder* from *malformed*. A `.env` copied
 *     from `.env.example` and left unedited still contains a syntactically
 *     plausible key; treating that as configured would surface a confusing
 *     authentication failure instead of "you have not filled this in yet".
 */

import { z } from "zod";
import { T3nConfigMissingError } from "@t3n-aca/core";

export type T3nEnvironment = "sandbox" | "testnet" | "production";
export type ClaimSourceMode = "live" | "demo";

/** Which language-model backend the optional NL layer talks to. */
export type LlmProviderChoice = "auto" | "openai" | "anthropic";

/**
 * Language-model settings for the optional natural-language layer.
 *
 * Deliberately generic. The `openai*` fields address any OpenAI-compatible
 * chat-completions endpoint — OpenAI, Google Gemini, Groq, OpenRouter, a local
 * Ollama — so an inheriting team can use whatever credential they already hold
 * rather than acquiring one specific vendor's.
 */
export interface LlmConfig {
  readonly provider: LlmProviderChoice;
  readonly openaiApiKey: string | null;
  readonly openaiBaseUrl: string;
  readonly openaiModel: string;
  readonly anthropicApiKey: string | null;
  readonly anthropicBaseUrl: string | null;
  readonly anthropicModel: string;
}

/**
 * How claim reads are actually enforced. Determined at connect time by probing
 * what the platform allows this deployment to do, not by configuration alone.
 *
 * - `AGENT_SESSION` — the agent holds its own credited session and performs
 *   reads under its own DID. Platform-enforced end to end. Strongest.
 * - `DELEGATED_TENANT_READ` — the agent's authority is still checked as the
 *   agent (its own DID and credential, via `checkDelegation`, with no data
 *   disclosed), but the read executes on the tenant's credited session,
 *   restricted to the scopes the on-network grant record actually covers.
 * - `UNAVAILABLE` — no live reads possible.
 */
export type EnforcementMode = "AGENT_SESSION" | "DELEGATED_TENANT_READ" | "UNAVAILABLE";

/** A secp256k1 private key: `0x` + 64 hex characters. */
const PRIVATE_KEY_RE = /^0x[0-9a-fA-F]{64}$/;
/**
 * The opaque agent credential returned by `createAgent`.
 *
 * Shape observed from a real provisioning call: `t3n_key_` followed by a
 * dot-separated key id and secret, e.g. `t3n_key_<keyId>.<secret>`. The dot is
 * significant — an alphanumeric-only pattern rejects every real credential.
 */
const AGENT_API_KEY_RE = /^t3n_key_[A-Za-z0-9._-]{8,}$/;
/** The all-zero key shipped in `.env.example` as a fill-me-in marker. */
const PLACEHOLDER_KEY = `0x${"0".repeat(64)}`;
const DID_RE = /^did:t3n:[0-9a-f]{40}$/i;

export interface T3nConfig {
  /** Tenant (enterprise) private key — session auth, org admin, credited. */
  readonly tenantKey: string;
  /** Opaque agent credential from `createAgent`. Keyed transports only. */
  readonly agentApiKey: string | null;
  /** Agent DID recorded at provisioning time. Verified against the network. */
  readonly agentDid: string | null;
  /** Optional agent private key enabling `AGENT_SESSION` mode. */
  readonly agentKey: string | null;
  readonly orgDid: string | null;
  readonly environment: T3nEnvironment;
  readonly baseUrl: string | null;
  readonly contractId: string;
}

export interface AppConfig {
  readonly claimSource: ClaimSourceMode;
  readonly t3n: T3nConfig | null;
  /** Why T3N config is unusable, when it is. Safe to display. */
  readonly t3nConfigError: string | null;
  /** Non-fatal configuration observations, safe to display. */
  readonly t3nWarnings: readonly string[];
  readonly auditLogPath: string;
  readonly auditSalt: string;
  readonly port: number;
  readonly llm: LlmConfig;
}

function privateKeyProblem(value: string | undefined, name: string): string | null {
  if (!value || value.trim() === "") return `${name} is not set`;
  const v = value.trim();
  if (v === PLACEHOLDER_KEY) {
    return `${name} is still the placeholder from .env.example — paste your real key from https://www.terminal3.io/claim-page`;
  }
  if (!PRIVATE_KEY_RE.test(v)) {
    return `${name} is not a valid secp256k1 private key (expected 0x followed by 64 hex characters)`;
  }
  return null;
}

const EnvironmentSchema = z.enum(["sandbox", "testnet", "production"]);

/**
 * Build T3N config from the environment.
 *
 * Returns `{ config: null, error }` rather than throwing: an unconfigured
 * deployment is an expected state (demo mode, first run before provisioning),
 * and the server must still start and report it accurately.
 */
export function loadT3nConfig(env: NodeJS.ProcessEnv = process.env): {
  config: T3nConfig | null;
  error: string | null;
  warnings: string[];
} {
  const problems: string[] = [];
  const warnings: string[] = [];

  const tenantProblem = privateKeyProblem(env.T3N_API_KEY, "T3N_API_KEY");
  if (tenantProblem) problems.push(tenantProblem);
  const tenantKey = env.T3N_API_KEY?.trim() ?? "";

  const envParse = EnvironmentSchema.safeParse(env.T3N_ENV?.trim() || "testnet");
  if (!envParse.success) {
    problems.push("T3N_ENV must be one of: sandbox, testnet, production");
  }

  const baseUrlRaw = env.T3N_BASE_URL?.trim();
  if (baseUrlRaw) {
    try {
      const parsed = new URL(baseUrlRaw);
      const isLoopback = ["localhost", "127.0.0.1", "[::1]", "::1"].includes(parsed.hostname);
      if (parsed.protocol !== "https:" && !isLoopback) {
        problems.push(
          "T3N_BASE_URL must use https — the SDK refuses to relay a credential over an insecure transport",
        );
      }
    } catch {
      problems.push("T3N_BASE_URL is not a valid URL");
    }
  }

  // --- agent provisioning artefacts (warnings, not errors) ----------------
  const agentApiKeyRaw = env.T3N_AGENT_API_KEY?.trim() || "";
  let agentApiKey: string | null = null;
  if (agentApiKeyRaw) {
    if (AGENT_API_KEY_RE.test(agentApiKeyRaw)) {
      agentApiKey = agentApiKeyRaw;
    } else if (PRIVATE_KEY_RE.test(agentApiKeyRaw)) {
      warnings.push(
        "T3N_AGENT_API_KEY looks like a private key, not the opaque t3n_key_… credential returned by provisioning. Run `npm run t3n:setup`.",
      );
    } else {
      warnings.push("T3N_AGENT_API_KEY is not a recognised t3n_key_… credential.");
    }
  } else {
    warnings.push("T3N_AGENT_API_KEY is not set — run `npm run t3n:setup` to provision an agent identity.");
  }

  const agentDidRaw = env.T3N_AGENT_DID?.trim() || "";
  let agentDid: string | null = null;
  if (agentDidRaw) {
    if (DID_RE.test(agentDidRaw)) agentDid = agentDidRaw;
    else warnings.push("T3N_AGENT_DID is not a well-formed did:t3n identifier.");
  }

  const orgDidRaw = env.T3N_ORG_DID?.trim() || "";
  let orgDid: string | null = null;
  if (orgDidRaw) {
    if (DID_RE.test(orgDidRaw)) orgDid = orgDidRaw;
    else warnings.push("T3N_ORG_DID is not a well-formed did:t3n identifier.");
  } else {
    warnings.push("T3N_ORG_DID is not set — run `npm run t3n:setup`.");
  }

  // --- optional agent private key (upgrades enforcement mode) -------------
  const agentKeyRaw = env.T3N_AGENT_KEY?.trim() || "";
  let agentKey: string | null = null;
  if (agentKeyRaw && agentKeyRaw !== PLACEHOLDER_KEY) {
    if (!PRIVATE_KEY_RE.test(agentKeyRaw)) {
      warnings.push("T3N_AGENT_KEY is set but is not a valid secp256k1 private key — ignoring it.");
    } else if (agentKeyRaw.toLowerCase() === tenantKey.toLowerCase()) {
      warnings.push(
        "T3N_AGENT_KEY is identical to T3N_API_KEY — ignoring it, since it would give the agent the tenant's full authority.",
      );
    } else {
      agentKey = agentKeyRaw;
    }
  }

  if (problems.length > 0) {
    return { config: null, error: problems.join("; "), warnings };
  }

  return {
    config: {
      tenantKey,
      agentApiKey,
      agentDid,
      agentKey,
      orgDid,
      environment: envParse.success ? envParse.data : "testnet",
      baseUrl: baseUrlRaw || null,
      contractId: env.T3N_CONTRACT_ID?.trim() || "tee:org-data/contracts",
    },
    error: null,
    warnings,
  };
}

/** Throwing variant, for code paths that genuinely require T3N. */
export function requireT3nConfig(env: NodeJS.ProcessEnv = process.env): T3nConfig {
  const { config, error } = loadT3nConfig(env);
  if (!config) throw new T3nConfigMissingError(error ?? "unknown configuration problem");
  return config;
}

export function loadAppConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const { config, error, warnings } = loadT3nConfig(env);
  const requested = (env.CLAIM_SOURCE?.trim().toLowerCase() || "demo") as ClaimSourceMode;
  const claimSource: ClaimSourceMode = requested === "live" ? "live" : "demo";
  const port = Number.parseInt(env.PORT?.trim() || "8787", 10);

  return {
    claimSource,
    t3n: config,
    t3nConfigError: error,
    t3nWarnings: warnings,
    auditLogPath: env.AUDIT_LOG_PATH?.trim() || "./data/audit.jsonl",
    // Deployment-scoped salt. Falls back to a fixed development value so demo
    // runs are reproducible; production must set it (see docs/OPERATIONS.md).
    auditSalt: env.AUDIT_SALT?.trim() || "t3n-aca-development-salt",
    port: Number.isFinite(port) && port > 0 && port < 65536 ? port : 8787,
    llm: loadLlmConfig(env),
  };
}

const LLM_PROVIDER_CHOICES: readonly LlmProviderChoice[] = ["auto", "openai", "anthropic"];

/**
 * Warn when the credential and the endpoint obviously disagree.
 *
 * This exists because it actually happened: `.env` named Gemini's base URL
 * while the shell already exported an `OPENAI_API_KEY`, and **dotenv does not
 * override variables that are already set** — so an OpenAI key was sent to
 * Google and the only feedback was a bare HTTP 400. The check is a heuristic on
 * key prefix versus host; it never blocks, it just names the likely cause.
 */
export function llmKeyHostMismatch(apiKey: string | null, baseUrl: string): string | null {
  if (!apiKey) return null;
  let host: string;
  try {
    host = new URL(baseUrl).hostname;
  } catch {
    return null;
  }
  const isOpenAiKey = apiKey.startsWith("sk-");
  if (isOpenAiKey && !host.includes("openai.com")) {
    return `OPENAI_API_KEY looks like an OpenAI key ("sk-…") but OPENAI_BASE_URL points at ${host}. Note that a variable already set in your shell overrides .env.`;
  }
  if (!isOpenAiKey && host.includes("openai.com")) {
    return `OPENAI_BASE_URL points at OpenAI but OPENAI_API_KEY does not look like an OpenAI key ("sk-…"). Note that a variable already set in your shell overrides .env.`;
  }
  return null;
}

export function loadLlmConfig(env: NodeJS.ProcessEnv = process.env): LlmConfig {
  const requested = (env.LLM_PROVIDER?.trim().toLowerCase() || "auto") as LlmProviderChoice;
  const provider = LLM_PROVIDER_CHOICES.includes(requested) ? requested : "auto";

  return {
    provider,
    openaiApiKey: env.OPENAI_API_KEY?.trim() || null,
    // Defaults to OpenAI; point it at any compatible host to use that instead.
    openaiBaseUrl: env.OPENAI_BASE_URL?.trim() || "https://api.openai.com/v1",
    openaiModel: env.OPENAI_MODEL?.trim() || "gpt-4o-mini",
    anthropicApiKey: env.ANTHROPIC_API_KEY?.trim() || null,
    anthropicBaseUrl: env.ANTHROPIC_BASE_URL?.trim() || null,
    anthropicModel: env.ANTHROPIC_MODEL?.trim() || "claude-sonnet-4-5",
  };
}
