/**
 * The live Terminal 3 claim source.
 *
 * ## The sequence, and why it is in this order
 *
 *   1. **Ask the platform whether the agent may act** — `checkDelegation`, sent
 *      with the *agent's own credential*, naming the subject and the exact
 *      scopes this policy needs. Nothing is read. If the answer is no, we stop
 *      here: a `REVIEW_REQUIRED` caused by absent consent is reached having
 *      disclosed **nothing at all**.
 *
 *   2. **Read the on-network grant record** — `grantsGet` returns the scopes
 *      consent actually covers for this agent DID. This, not our own config,
 *      is what bounds the read. If a subject revokes, this set shrinks and the
 *      next evaluation reads less, with no code change and no redeploy.
 *
 *   3. **Read only the intersection** — requested scopes ∩ granted scopes.
 *      Scopes the policy wanted but consent did not cover are reported as
 *      `deniedScopes` and become missing requirements, never silent gaps.
 *
 * ## What is deliberately absent
 *
 * There is no path here that falls back to fixtures, retries with a wider
 * scope set, or reads "while we're here" data the policy did not ask for. Each
 * of those would be a quiet betrayal of the guarantee the product makes.
 */

import { InvokeError, SessionExpiredError, discoverCheckDelegation } from "@terminal3/t3n-sdk";

import {
  ClaimSourceUnavailableError,
  createLogger,
  T3nUnavailableError,
  type Claim,
  type ClaimSet,
  type Logger,
} from "@t3n-aca/core";

import type { T3nConnection } from "./client.ts";
import {
  ClaimRecordSchema,
  claimRecordToClaim,
  decodePayloadHex,
  emptyClaimSet,
  type ClaimRequest,
  type ClaimSource,
} from "./source.ts";

/** Functions a claim read needs. Verified against the deployed contract. */
const READ_FUNCTIONS = ["org-data-get", "org-data-list"] as const;

/** Entries fetched per `dataList` call. */
const PAGE_SIZE = 50;

/**
 * Hard ceiling on entries scanned per scope, across all pages.
 *
 * A bound is necessary — an unbounded walk of a large shared scope would hang a
 * request. But a bound that is reached must never be reported as a complete
 * read, which is what the single un-paged `dataList(limit: 50)` call did: a
 * scope holding one record per claim type per subject silently stopped at the
 * 50th entry, so from the 51st subject onwards a fully consented, perfectly
 * valid claim was never read and the ClaimSet still said `consentVerified:
 * true` with no risk flag. The engine then stated positively that the subject
 * had no such evidence.
 */
const MAX_ENTRIES_PER_SCOPE = 1000;

/** Live subjects are Terminal 3 DIDs. Demo fixture ids are not. */
const SUBJECT_DID_RE = /^did:t3n:[0-9a-f]{40}$/i;

export class LiveT3nClaimSource implements ClaimSource {
  readonly kind = "LIVE_T3N" as const;
  readonly description = "Consented claims read from Terminal 3";

  private readonly connection: T3nConnection;
  private readonly log: Logger;

  constructor(connection: T3nConnection, logger?: Logger) {
    this.connection = connection;
    this.log = logger ?? createLogger("t3n:live");
  }

  async fetchClaims(request: ClaimRequest): Promise<ClaimSet> {
    const { subjectRef, requiredScopes } = request;

    // Check this before touching the network. A demo fixture id sent to the
    // live source otherwise fails deep inside the delegation call as an opaque
    // HTTP 400, which reads like a credential problem and sends whoever hits it
    // off debugging the wrong thing entirely.
    if (!SUBJECT_DID_RE.test(subjectRef)) {
      throw new ClaimSourceUnavailableError(
        `subject reference "${subjectRef}" is not a Terminal 3 DID`,
        {
          publicMessage:
            "Live mode needs a Terminal 3 DID as the subject reference, not a demo fixture id.",
          remediation:
            "Use a did:t3n:… subject (the T3N Status page shows the seeded one), or set CLAIM_SOURCE=demo in .env to run the demo scenarios.",
        },
      );
    }

    await this.connection.connect();

    const orgDid = this.connection.orgDid;
    if (!orgDid) {
      throw new T3nUnavailableError("no organisation DID is configured", {
        remediation: "Run `npm run t3n:setup` to provision an organisation.",
      });
    }

    // --- Step 1: authorization, as the agent, disclosing nothing -----------
    const authorised = await this.checkAgentAuthorization(subjectRef, requiredScopes);
    if (!authorised) {
      this.log.info("agent is not authorized for this subject; no data read", {
        subject: subjectRef,
        requestedScopes: requiredScopes,
      });
      return emptyClaimSet(subjectRef, this.kind, requiredScopes);
    }

    // --- Step 2: what did consent actually cover? --------------------------
    // Sessions expire. Retry exactly once through a fresh session rather than
    // failing every request from here to process restart.
    let grantedScopes: Set<string>;
    try {
      grantedScopes = await this.readGrantedScopes(orgDid);
    } catch (err) {
      if (!(err instanceof SessionExpiredError)) throw err;
      this.log.info("T3N session expired; re-authenticating and retrying once");
      await this.connection.reconnectAfterExpiry();
      grantedScopes = await this.readGrantedScopes(orgDid);
    }

    const authorizedScopes = requiredScopes.filter((s) => grantedScopes.has(s));
    const deniedScopes = requiredScopes.filter((s) => !grantedScopes.has(s));

    if (deniedScopes.length > 0) {
      this.log.info("consent does not cover every scope this policy needs", {
        authorized: authorizedScopes,
        denied: deniedScopes,
      });
    }

    // --- Step 3: read only the intersection --------------------------------
    const claims: Claim[] = [];
    const unreadable: string[] = [];

    for (const scope of authorizedScopes) {
      try {
        let result: { claims: Claim[]; dropped: number };
        try {
          result = await this.readScope(orgDid, scope, subjectRef);
        } catch (err) {
          if (!(err instanceof SessionExpiredError)) throw err;
          await this.connection.reconnectAfterExpiry();
          result = await this.readScope(orgDid, scope, subjectRef);
        }
        claims.push(...result.claims);

        // A record that failed to decode or failed schema validation was
        // dropped with only a log line, so a partial read reached the engine
        // looking complete — and the engine then stated positively that the
        // subject has "no verified claim on record", turning what should have
        // been a DENIED into a confident REVIEW_REQUIRED with no risk flag.
        // Treat the scope as unread: the operator sees a degraded source
        // rather than a fabricated absence of evidence.
        if (result.dropped > 0) {
          this.log.warn("scope contained records that could not be read", {
            scope,
            dropped: result.dropped,
          });
          unreadable.push(scope);
        }
      } catch (err) {
        // A scope that consent covers but the platform still refuses is a real
        // signal, not something to swallow: treat it as not authorized.
        this.log.warn("scope read failed despite an apparent grant", {
          scope,
          error: err instanceof Error ? err.message : String(err),
        });
        unreadable.push(scope);
      }
    }

    const effectiveAuthorized = authorizedScopes.filter((s) => !unreadable.includes(s));
    const effectiveDenied = [...deniedScopes, ...unreadable];

    return {
      subjectRef,
      source: this.kind,
      requestedScopes: requiredScopes,
      authorizedScopes: effectiveAuthorized,
      deniedScopes: effectiveDenied,
      claims,
      consentVerified: effectiveDenied.length === 0,
      unavailableReason:
        unreadable.length > 0
          ? `${unreadable.length} consented scope(s) could not be read`
          : null,
    };
  }

  /**
   * Ask the platform, as the agent, whether it may act for this subject.
   *
   * Uses the agent's own opaque credential so the question is answered about
   * the *agent's* authority, not the tenant's. Returns `false` on a definite
   * refusal; throws only when the platform could not be consulted at all —
   * "unknown" must never be rendered as "authorized".
   */
  private async checkAgentAuthorization(
    subjectRef: string,
    requiredScopes: readonly string[],
  ): Promise<boolean> {
    const apiKey = this.connection.agentApiKey;
    if (!apiKey) {
      throw new T3nUnavailableError("the agent has not been provisioned", {
        remediation: "Run `npm run t3n:setup` to mint an agent identity.",
      });
    }

    try {
      const result = await discoverCheckDelegation(
        { baseUrl: this.connection.nodeUrl, apiKey },
        {
          contract: this.connection.contractId,
          pii_did: subjectRef,
          functions: [...READ_FUNCTIONS],
          scopes: [...requiredScopes],
        },
      );

      this.log.info("delegation check", {
        subject: subjectRef,
        authorised: result.authorised,
        disclosed: result.disclosed,
        satisfied: result.satisfied.length,
        missing: result.missing.length,
      });

      return result.authorised;
    } catch (err) {
      if (err instanceof InvokeError) {
        throw new T3nUnavailableError("the delegation check could not be completed", {
          cause: err,
          remediation:
            "Verify T3N_AGENT_API_KEY is the opaque t3n_key_… credential from provisioning.",
        });
      }
      throw err;
    }
  }

  /**
   * Scopes the on-network grant record currently covers for this agent DID.
   *
   * This is the authoritative consent state. Reading it every evaluation is
   * what makes revocation take effect immediately.
   */
  private async readGrantedScopes(orgDid: string): Promise<Set<string>> {
    const agentDid = this.connection.agentDid;
    // An unknown agent identity is a configuration failure, not an answer.
    // Returning an empty set here made it indistinguishable from "the subject
    // granted nothing": every decision came back REVIEW_REQUIRED with every
    // scope withheld, and the operator was told to go and ask for consent the
    // subject had already given.
    if (!agentDid) {
      throw new T3nUnavailableError("the agent DID could not be determined", {
        publicMessage: "The agent identity is not configured, so consent cannot be checked.",
        remediation:
          "Run `npm run t3n:setup` to provision an agent, or set T3N_AGENT_DID in .env. Check the T3N Status page for the current identity.",
      });
    }

    const org = await this.connection.tenantOrgData();
    const record = await org.grantsGet({
      orgDid,
      contractId: this.connection.contractId,
    });

    const granted = new Set<string>();
    for (const grant of record.grants) {
      if (grant.user_did.toLowerCase() !== agentDid.toLowerCase()) continue;
      // A grant only counts if it also carries the functions a read needs.
      const hasReadFunctions = READ_FUNCTIONS.every(
        (fn) => grant.functions.includes(fn) || grant.functions.includes("*"),
      );
      if (!hasReadFunctions) continue;
      for (const scope of grant.scopes) granted.add(scope);
    }
    return granted;
  }

  /**
   * Read, validate, and subject-filter every claim record in one scope.
   *
   * Pages through the whole scope. `dataList` returns one page plus a
   * `next_offset`; ignoring it capped every read at the first 50 entries with
   * nothing anywhere saying so. Throws if the ceiling is reached, which the
   * caller turns into a degraded read rather than a confident answer — an
   * incomplete read must not be able to masquerade as an absence of evidence.
   */
  private async readScope(
    orgDid: string,
    scope: string,
    subjectRef: string,
  ): Promise<{ claims: Claim[]; dropped: number }> {
    const org = await this.connection.readerOrgData();

    const entryIds: string[] = [];
    let offset = 0;
    for (;;) {
      const listing = await org.dataList({ orgDid, scope, offset, limit: PAGE_SIZE });
      entryIds.push(...listing.entry_ids);

      if (listing.next_offset === null) break;
      if (entryIds.length >= MAX_ENTRIES_PER_SCOPE) {
        throw new ClaimSourceUnavailableError(
          `scope "${scope}" holds more than ${MAX_ENTRIES_PER_SCOPE} entries`,
          {
            publicMessage: "A consented scope was too large to read completely.",
            remediation:
              "Split the scope, or raise MAX_ENTRIES_PER_SCOPE. The decision was not made on a partial read.",
          },
        );
      }
      // A page that advances nothing would spin forever; treat it as the end.
      if (listing.entry_ids.length === 0 || listing.next_offset <= offset) break;
      offset = listing.next_offset;
    }

    const claims: Claim[] = [];
    // A record we could not read might be the one for this subject — we cannot
    // know, because the part that says whose it is failed to decode. Counting
    // them lets the caller mark the scope as incompletely read instead of
    // returning a short list that looks like a complete one.
    let dropped = 0;
    for (const entryId of entryIds) {
      const entry = await org.dataGet({ orgDid, scope, entryId });
      let decoded: unknown;
      try {
        decoded = decodePayloadHex(entry.payload_hex);
      } catch {
        this.log.warn("claim record is not decodable; skipping", { scope, entryId });
        dropped++;
        continue;
      }
      const parsed = ClaimRecordSchema.safeParse(decoded);
      if (!parsed.success) {
        // Never let an unrecognised record shape reach the policy engine — a
        // malformed record must not be able to masquerade as a valid claim.
        this.log.warn("claim record failed schema validation; skipping", {
          scope,
          entryId,
          issues: parsed.error.issues.map((i) => i.message),
        });
        dropped++;
        continue;
      }
      // A scope may hold records for several subjects; only the one under
      // evaluation is relevant, and reading past it would be exactly the
      // over-collection this system exists to avoid.
      if (parsed.data.subject.toLowerCase() !== subjectRef.toLowerCase()) continue;

      claims.push(claimRecordToClaim(parsed.data));
    }
    return { claims, dropped };
  }
}
