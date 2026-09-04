/**
 * Redaction and pseudonymisation helpers.
 *
 * Everything that leaves the process — logs, audit rows, HTTP responses — goes
 * through here. The rules are deliberately blunt: it is much easier to review a
 * conservative redactor than to audit every call site.
 */

import { createHash, randomUUID } from "node:crypto";

/** Keys whose values are never logged, matched case-insensitively as substrings. */
const SENSITIVE_KEY_PATTERNS = [
  "key",
  "secret",
  "token",
  "password",
  "passwd",
  "credential",
  "authorization",
  "auth",
  "signature",
  "privatekey",
  "mnemonic",
  "seed",
] as const;

/**
 * Keys allowed through despite matching a pattern above.
 *
 * The patterns are deliberately broad, which means they catch a handful of
 * fields that are about *authorization state* rather than credentials — scope
 * lists, booleans, counts. Redacting those makes logs useless for the exact
 * diagnosis they exist to support ("which scopes did consent cover?"), so they
 * are named explicitly here. Every entry is a value that carries no secret.
 */
const SAFE_KEY_ALLOWLIST = new Set([
  "keys", // e.g. { keys: 3 } — a count
  "keyid",
  "authorized",
  "authorised",
  "authorizedscopes",
  "authorisedscopes",
  "scopesauthorized",
  "scopesauthorised",
  "unauthorizedscopes",
  "authstatus",
  "authenticated",
  "enforcementmode",
]);

const REDACTED = "[REDACTED]";

function isSensitiveKey(key: string): boolean {
  const lower = key.toLowerCase();
  if (SAFE_KEY_ALLOWLIST.has(lower)) return false;
  return SENSITIVE_KEY_PATTERNS.some((p) => lower.includes(p));
}

/**
 * Mask key-like material, keeping just enough to correlate across logs.
 *
 * `0xabcdef…123456` — 6 leading, 4 trailing. Anything short enough that a
 * partial reveal would be meaningful is fully redacted.
 */
export function maskSecret(value: string): string {
  if (value.length <= 12) return REDACTED;
  return `${value.slice(0, 6)}…${value.slice(-4)}`;
}

/**
 * Credential shapes recognised inside free text.
 *
 * Key-based redaction only fires when a secret arrives as the *value* of a
 * suspiciously-named field. A secret embedded in a sentence — an SDK error
 * message, a URL in a log line, a header dump — reaches the log through
 * `scrubText` instead, and that recognised exactly one shape: a `0x`-prefixed
 * hex private key. It therefore missed:
 *
 *   - `t3n_key_…`, this project's OWN agent credential, and the one actually
 *     relayed in an HTTP header on every delegation check
 *   - `sk-…` (OpenAI, OpenRouter, Groq) and `AIza…` (Gemini — the provider this
 *     deployment is configured with today)
 *   - a bearer token in a quoted Authorization header
 *
 * Each pattern is anchored on a distinctive prefix rather than on "long
 * random-looking string", because a Terminal 3 DID is 40 hex characters and is
 * a PUBLIC identifier that the status page, the audit trail and every debug
 * session depend on. Redacting those would break the transparency this system
 * is built to provide, so the patterns are deliberately narrow.
 */
const SECRET_PATTERNS: readonly RegExp[] = [
  // Tenant / agent private key.
  /\b0x[a-fA-F0-9]{32,}\b/g,
  // Terminal 3 opaque agent credential: t3n_key_<keyId>.<secret>
  /\bt3n_key_[A-Za-z0-9]+(?:\.[A-Za-z0-9_-]+)?/g,
  // OpenAI-compatible providers.
  /\bsk-[A-Za-z0-9_-]{16,}/g,
  // Google / Gemini.
  /\bAIza[A-Za-z0-9_-]{30,}/g,
];

/** `Authorization: Bearer <token>` and friends, however they are quoted. */
const BEARER_RE = /\b(Bearer|Basic)\s+([A-Za-z0-9._~+/=-]{12,})/gi;

/**
 * Strip anything that looks like key material out of a free-text string.
 *
 * Deliberately conservative about what it will NOT touch: `did:t3n:<40 hex>`
 * identifiers pass through untouched, because an operator who cannot see which
 * agent a log line concerns cannot debug anything.
 */
export function scrubText(text: string): string {
  let out = text;
  for (const pattern of SECRET_PATTERNS) {
    out = out.replace(pattern, (m) => maskSecret(m));
  }
  return out.replace(
    BEARER_RE,
    (_m, scheme: string, token: string) => `${scheme} ${maskSecret(token)}`,
  );
}

/**
 * Deep-redact an arbitrary value for logging.
 *
 * Cycles are handled; depth is capped so a pathological object cannot stall the
 * logger.
 */
export function redact(value: unknown, maxDepth = 8): unknown {
  return redactInner(value, maxDepth, new WeakSet());
}

function redactInner(value: unknown, depth: number, seen: WeakSet<object>): unknown {
  if (value === null || value === undefined) return value;
  if (typeof value === "string") return scrubText(value);
  if (typeof value === "number" || typeof value === "boolean") return value;
  if (typeof value === "bigint") return value.toString();
  if (typeof value === "function") return "[Function]";
  if (value instanceof Error) {
    return { name: value.name, message: scrubText(value.message) };
  }
  if (depth <= 0) return "[Truncated]";

  if (typeof value === "object") {
    if (seen.has(value as object)) return "[Circular]";
    seen.add(value as object);

    if (Array.isArray(value)) {
      return value.slice(0, 100).map((v) => redactInner(v, depth - 1, seen));
    }

    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = isSensitiveKey(k)
        ? typeof v === "string"
          ? maskSecret(v)
          : REDACTED
        : redactInner(v, depth - 1, seen);
    }
    return out;
  }
  return String(value);
}

/**
 * Pseudonymise a subject reference for the audit log.
 *
 * Salted so audit files from different deployments are not cross-linkable, and
 * so the hash is not reversible via a rainbow table of known DIDs. The salt is
 * deployment-scoped and lives in the environment.
 */
export function hashSubject(subjectRef: string, salt: string): string {
  // Canonicalised first. Terminal 3 DIDs are hex and compared case-insensitively
  // everywhere else in this system (see the grant filter in packages/t3n), so
  // hashing the raw string gave one subject two audit identities depending on
  // how the DID happened to be typed — and broke the documented proof that an
  // auditor can recompute the hash from a known subject reference.
  const canonical = subjectRef.trim().toLowerCase();
  return createHash("sha256").update(`${salt}:${canonical}`).digest("hex").slice(0, 32);
}

/** Stable, collision-resistant audit identifier. */
export function newAuditId(): string {
  return `aud_${randomUUID().replace(/-/g, "").slice(0, 24)}`;
}

/**
 * Shorten a DID for display: `did:t3n:1a2b3c…9f8e`.
 * Not a secret, but full DIDs make the UI unreadable.
 */
export function shortenDid(did: string | null | undefined): string {
  if (!did) return "—";
  const body = did.startsWith("did:t3n:") ? did.slice("did:t3n:".length) : did;
  if (body.length <= 12) return did;
  return `did:t3n:${body.slice(0, 6)}…${body.slice(-4)}`;
}
