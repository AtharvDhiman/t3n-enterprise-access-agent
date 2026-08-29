/**
 * The claim-source abstraction.
 *
 * The policy engine never learns where claims came from beyond a
 * `ClaimSourceKind` tag, which is exactly the amount it needs to know in order
 * to refuse to present a demo result as a live one.
 *
 * Two implementations exist — `LiveT3nClaimSource` and `DemoClaimSource` — and
 * they are never blended. A single evaluation is entirely live or entirely
 * demo. There is deliberately no "fall back to fixtures when T3N is down" path:
 * silently substituting fake evidence for real evidence is precisely the
 * failure mode that would make this system untrustworthy.
 */

import { z } from "zod";
import type { Claim, ClaimSet, ClaimSourceKind } from "@t3n-aca/core";

/** What the engine needs read, expressed in T3N terms. */
export interface ClaimRequest {
  /** Subject DID (live) or fixture id (demo). */
  readonly subjectRef: string;
  /** The complete set of scopes this policy permits us to ask for. */
  readonly requiredScopes: readonly string[];
  /** claimId → scope, so a source can map records back to claims. */
  readonly claimScopes: Readonly<Record<string, string>>;
}

export interface ClaimSource {
  readonly kind: ClaimSourceKind;
  /** Human-readable description for the UI. */
  readonly description: string;
  fetchClaims(request: ClaimRequest): Promise<ClaimSet>;
}

// ---------------------------------------------------------------------------
// Wire format for a stored claim record
// ---------------------------------------------------------------------------

/**
 * The on-network shape of a claim record.
 *
 * Intentionally tiny. A record contains an *outcome and its provenance*, never
 * the evidence that produced it. Anyone who compromised this record set would
 * learn that a person's identity was verified to a given standard — not their
 * name, their document, or their date of birth.
 */
export const ClaimRecordSchema = z
  .object({
    /** Schema version, so stored records can migrate. */
    v: z.literal(1),
    /**
     * The subject this assertion is about (`did:t3n:…`).
     *
     * Present so a scope can hold records for more than one subject and a read
     * can be filtered down to the one being evaluated. In the strongest
     * deployment each subject is their own data owner with their own
     * per-subject scopes, and consent is therefore per person; this field is
     * what keeps the code correct in the interim, where several subjects may
     * share a scope. See docs/architecture.md → "Scope layout".
     */
    subject: z.string().min(1).max(120),
    claim: z.string().min(1).max(80),
    verified: z.boolean(),
    assurance: z.enum(["none", "low", "substantial", "high"]),
    verifiedAt: z.string().datetime().nullable().default(null),
    expiresAt: z.string().datetime().nullable().default(null),
    issuerCategory: z.string().min(1).max(80).nullable().default(null),
    evidenceRef: z.string().min(1).max(200).nullable().default(null),
  })
  .strict();

export type ClaimRecord = z.infer<typeof ClaimRecordSchema>;

export function claimRecordToClaim(record: ClaimRecord): Claim {
  return {
    id: record.claim,
    verified: record.verified,
    assurance: record.assurance,
    verifiedAt: record.verifiedAt,
    expiresAt: record.expiresAt,
    issuerCategory: record.issuerCategory,
    evidenceRef: record.evidenceRef,
  };
}

// ---------------------------------------------------------------------------
// Hex helpers — org-data payloads cross the wire as hex-encoded bytes
// ---------------------------------------------------------------------------

export function encodePayloadHex(value: unknown): string {
  return Buffer.from(JSON.stringify(value), "utf8").toString("hex");
}

export function decodePayloadHex(payloadHex: string): unknown {
  const normalized = payloadHex.startsWith("0x") ? payloadHex.slice(2) : payloadHex;
  const text = Buffer.from(normalized, "hex").toString("utf8");
  return JSON.parse(text);
}

/** Build an "everything denied" claim set — used when consent is absent. */
export function emptyClaimSet(
  subjectRef: string,
  source: ClaimSourceKind,
  requestedScopes: readonly string[],
  unavailableReason: string | null = null,
): ClaimSet {
  return {
    subjectRef,
    source,
    requestedScopes,
    authorizedScopes: [],
    deniedScopes: [...requestedScopes],
    claims: [],
    consentVerified: false,
    unavailableReason,
  };
}
