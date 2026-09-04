/**
 * Terminal 3 connection management.
 *
 * ## Server-side only
 *
 * Nothing here may be imported from `apps/web`. The SDK loads a WASM component
 * that breaks under Vite/Webpack/Turbopack (an officially acknowledged rough
 * edge — see `docs/T3N_RESEARCH.md`), and the credentials it needs must never
 * reach a browser. The boundary is enforced by import direction: only
 * `apps/server` depends on this package.
 *
 * ## Identities
 *
 * - **tenant** — the enterprise. Org admin, holds credits, writes claim records.
 * - **agent**  — the compliance agent, provisioned via `createAgent`. Has its
 *   own DID, its own opaque `t3n_key_…` credential, and an org-hosted card.
 *   Its authority is exactly what data owners have granted it.
 *
 * ## Enforcement modes
 *
 * `checkDelegation` always runs **as the agent**, using the agent's own
 * credential — so the authorization question is answered by the platform,
 * about the agent, with nothing disclosed. What varies is who executes the
 * subsequent read; see `EnforcementMode` in `config.ts`.
 */

import {
  T3nClient,
  setEnvironment,
  loadWasmComponent,
  eth_get_address,
  metamask_sign,
  createEthAuthInput,
  fetchTrustedManifest,
  getNodeUrl,
  discoverWhoami,
  createOrgDataClientFromSession,
  formatTokens,
  type WasmComponent,
  type SessionOrgDataClient,
} from "@terminal3/t3n-sdk";

import {
  createLogger,
  shortenDid,
  T3nAuthError,
  T3nUnavailableError,
  type Logger,
} from "@t3n-aca/core";

import type { EnforcementMode, T3nConfig } from "./config.ts";

export type ConnectionState = "disconnected" | "connecting" | "connected" | "error";

/** Identity view, safe to serialise to a browser. Contains no key material. */
export interface IdentityStatus {
  authenticated: boolean;
  did: string | null;
  shortDid: string;
  organisations: string[];
  owner: string | null;
  /** Formatted credit balance, or null when not readable for this identity. */
  balance: string | null;
}

export interface T3nStatus {
  configured: boolean;
  configError: string | null;
  warnings: string[];
  environment: string;
  /** Resolved node URL — a public endpoint, not a secret. */
  nodeUrl: string | null;
  state: ConnectionState;
  wasmLoaded: boolean;
  tenant: IdentityStatus;
  agent: IdentityStatus;
  orgDid: string | null;
  contractId: string;
  enforcementMode: EnforcementMode;
  /** Plain-language explanation of the active enforcement mode. */
  enforcementDetail: string;
  lastError: string | null;
  lastCheckedAt: string | null;
  connectedAt: string | null;
}

const EMPTY_IDENTITY: IdentityStatus = {
  authenticated: false,
  did: null,
  shortDid: "—",
  organisations: [],
  owner: null,
  balance: null,
};

export interface AuthenticatedSession {
  client: T3nClient;
  did: string;
}

const ENFORCEMENT_DETAIL: Record<EnforcementMode, string> = {
  AGENT_SESSION:
    "The agent holds its own credited session. Authorization is checked as the agent and the claim read is executed under the agent's own DID — enforced by Terminal 3 end to end.",
  DELEGATED_TENANT_READ:
    "Authorization is checked as the agent, using the agent's own DID and credential, before anything is read — an unauthorized request discloses nothing. The read itself runs on the tenant's credited session, restricted to the scopes the on-network grant record actually covers, because the agent's opaque credential cannot invoke core tee: contracts and an uncredited DID cannot open metered reads.",
  UNAVAILABLE:
    "Live claim reads are not available. Terminal 3 is not connected or the agent has not been provisioned.",
};

export class T3nConnection {
  private readonly config: T3nConfig;
  private readonly log: Logger;

  private wasm: WasmComponent | null = null;
  private tenantSession: AuthenticatedSession | null = null;
  private agentSession: AuthenticatedSession | null = null;
  private agentWhoami: { organisations: string[]; owner: string | null } | null = null;
  /**
   * The agent DID the network itself reports for our credential.
   *
   * This is authoritative. `T3N_AGENT_DID` is a convenience recorded at
   * provisioning time and can easily be absent — `.env.example` ships it blank,
   * and a hand-edited or restored `.env` loses it. Preferring the configured
   * value over the confirmed one meant a blank variable silently produced a
   * null agent DID, an empty grant set, and every live decision reported as
   * withheld consent.
   */
  private confirmedAgentDid: string | null = null;
  /** In-flight re-authentication, so a session-expiry storm produces one. */
  private reconnecting: Promise<void> | null = null;
  private tenantBalance: string | null = null;
  private agentBalance: string | null = null;
  /** Raw spendable base units for the agent; the enforcement decision reads this. */
  private agentCredits: bigint | null = null;
  private mode: EnforcementMode = "UNAVAILABLE";

  private state: ConnectionState = "disconnected";
  private lastError: string | null = null;
  private lastCheckedAt: string | null = null;
  private connectedAt: string | null = null;
  private inflight: Promise<void> | null = null;

  constructor(config: T3nConfig, logger?: Logger) {
    this.config = config;
    this.log = logger ?? createLogger("t3n");
  }

  get environment(): string {
    return this.config.environment;
  }
  get contractId(): string {
    return this.config.contractId;
  }
  get agentApiKey(): string | null {
    return this.config.agentApiKey;
  }
  get enforcementMode(): EnforcementMode {
    return this.mode;
  }

  /** Node URL for keyed transports. */
  get nodeUrl(): string {
    if (this.config.baseUrl) return this.config.baseUrl;
    return getNodeUrl();
  }

  /**
   * The org DID whose compliance scopes we read. Never derived — taken from
   * provisioning or falling back to the authenticated tenant's own DID.
   */
  get orgDid(): string | null {
    return this.config.orgDid ?? this.tenantSession?.did ?? null;
  }

  /**
   * The agent's DID, preferring what the network confirmed.
   *
   * Order matters: the DID the node returned for our own credential beats
   * anything recorded in `.env`, which beats the session DID. Note the session
   * DID is deliberately *last* — in `AGENT_SESSION` mode that is the
   * `T3N_AGENT_KEY` identity, whereas grants were issued to the
   * `createAgent`-provisioned DID, so filtering grants by the session DID would
   * match nothing.
   */
  get agentDid(): string | null {
    return this.confirmedAgentDid ?? this.config.agentDid ?? this.agentSession?.did ?? null;
  }

  isConnected(): boolean {
    return this.state === "connected";
  }

  async connect(): Promise<void> {
    if (this.state === "connected") return;
    if (this.inflight) return this.inflight;
    const attempt: Promise<void> = this.doConnect().finally(() => {
      // Only retire the slot if it is still ours. An unconditional
      // `this.inflight = null` here let an older, slower attempt clear a slot
      // that a newer one had since taken, so the next caller saw an empty slot
      // and started a third connect while the second was still running.
      if (this.inflight === attempt) this.inflight = null;
    });
    this.inflight = attempt;
    return attempt;
  }

  /**
   * Drop cached sessions so the next `connect()` re-authenticates.
   *
   * Clearing `inflight` matters: a reset during an in-progress connect would
   * otherwise leave the stale promise in place, and the next caller would await
   * a connection attempt for sessions that have already been discarded.
   *
   * That is also why `reconnectAfterExpiry` must not call this directly on
   * every caller — see the note there.
   */
  reset(reason?: string): void {
    this.tenantSession = null;
    this.agentSession = null;
    this.agentWhoami = null;
    this.confirmedAgentDid = null;
    this.agentBalance = null;
    this.agentCredits = null;
    this.inflight = null;
    this.state = "disconnected";
    this.connectedAt = null;
    this.mode = "UNAVAILABLE";
    if (reason) {
      this.lastError = reason;
      this.log.warn("connection reset", { reason });
    }
  }

  /**
   * Re-authenticate after a session expires.
   *
   * A T3N session has a TTL. Without this, a long-running server that connected
   * at startup failed every live request forever once that TTL elapsed:
   * `connect()` short-circuits on `state === "connected"`, so nothing ever
   * re-authenticated, and the status page kept reporting a dead session as
   * healthy. Callers use this to retry a read exactly once.
   */
  async reconnectAfterExpiry(): Promise<void> {
    // Coalesce. A session TTL expires for every in-flight request at once, and
    // each one lands here. Because `reset()` clears `inflight` as well as the
    // cached sessions, N concurrent callers each cleared the slot the previous
    // one had just filled and then started their own full re-authentication:
    // N trust-manifest fetches, N handshakes, N authenticate round trips, and
    // N-1 orphaned sessions left open on the node. Worse, a slow loser's catch
    // stamps state="error" and mode="UNAVAILABLE" over a connection a sibling
    // had already brought up, briefly downgrading enforcement for everyone.
    //
    // The first caller through does the reset and the reconnect; everyone else
    // waits on that same attempt, which is what they wanted anyway.
    if (this.reconnecting) return this.reconnecting;
    this.reconnecting = (async () => {
      this.reset("session expired; re-authenticating");
      await this.connect();
    })().finally(() => {
      this.reconnecting = null;
    });
    return this.reconnecting;
  }

  private async doConnect(): Promise<void> {
    this.state = "connecting";
    this.lastError = null;
    const started = Date.now();

    try {
      setEnvironment(this.config.environment);

      if (!this.wasm) {
        this.log.info("loading T3N WASM component");
        this.wasm = await loadWasmComponent();
      }

      this.tenantSession = await this.authenticateIdentity("tenant", this.config.tenantKey);
      this.tenantBalance = (await this.readBalance(this.tenantSession))?.display ?? null;

      // Optional: an agent private key upgrades us to AGENT_SESSION, but only
      // if it is genuinely a different, credited identity. Anything less and we
      // fall back rather than pretend.
      if (this.config.agentKey) {
        try {
          const session = await this.authenticateIdentity("agent", this.config.agentKey);
          if (session.did === this.tenantSession.did) {
            this.log.warn(
              "T3N_AGENT_KEY resolves to the tenant's own DID — ignoring it. Claim a key under a different account for a separate agent identity.",
            );
          } else {
            this.agentSession = session;
            const bal = await this.readBalance(session);
            this.agentBalance = bal?.display ?? null;
            // A session whose balance could not be read, or whose credit is
            // exhausted, must not be treated as spendable.
            this.agentCredits = bal && !bal.exhausted ? bal.available : null;
          }
        } catch (err) {
          this.log.warn("agent session authentication failed; continuing without it", {
            error: err instanceof Error ? err.message : String(err),
          });
        }
      }

      // Verify the provisioned agent identity via its own credential.
      if (this.config.agentApiKey) {
        try {
          const who = await discoverWhoami({
            baseUrl: this.nodeUrl,
            apiKey: this.config.agentApiKey,
          });
          this.agentWhoami = { organisations: who.organisations, owner: who.owner };
          // Keep it: this is the authoritative identity for our credential.
          this.confirmedAgentDid = who.did;
          if (this.config.agentDid && who.did !== this.config.agentDid) {
            this.log.warn(
              "provisioned T3N_AGENT_DID disagrees with the network; using the network's value",
              { configured: this.config.agentDid, actual: who.did },
            );
          } else if (!this.config.agentDid) {
            this.log.info("T3N_AGENT_DID was not set; recovered it from the network", {
              agentDid: shortenDid(who.did),
            });
          }
        } catch (err) {
          this.log.warn("agent whoami failed — the agent credential may be invalid", {
            error: err instanceof Error ? err.message : String(err),
          });
          this.agentWhoami = null;
        }
      }

      this.mode = this.resolveEnforcementMode();

      this.state = "connected";
      this.connectedAt = new Date().toISOString();
      this.log.info("T3N connected", {
        environment: this.config.environment,
        tenantDid: shortenDid(this.tenantSession.did),
        agentDid: shortenDid(this.agentDid),
        mode: this.mode,
        ms: Date.now() - started,
      });
    } catch (err) {
      this.state = "error";
      this.mode = "UNAVAILABLE";
      this.lastError = err instanceof Error ? err.message : String(err);
      this.log.error("T3N connection failed", { error: this.lastError });
      throw err;
    } finally {
      this.lastCheckedAt = new Date().toISOString();
    }
  }

  /**
   * Choose the strongest mode the platform actually permits.
   *
   * A credited agent session is required for `AGENT_SESSION`: an agent DID with
   * a zero balance cannot open a metered read, so claiming that mode without
   * checking the balance would mean advertising an enforcement guarantee that
   * fails on first use.
   */
  private resolveEnforcementMode(): EnforcementMode {
    // Judge credit on the raw base units, never on the formatted string.
    // `formatTokens(0n)` does not render as "0 " — it produces "0.000000" — so
    // the old `startsWith("0 ")` test never matched and an uncredited agent was
    // promoted to AGENT_SESSION, exactly the case .env.example warns about.
    // The first metered read then failed with InsufficientCreditError while the
    // status page claimed the strongest enforcement mode.
    if (this.agentSession && this.agentCredits !== null && this.agentCredits > 0n) {
      return "AGENT_SESSION";
    }
    if (this.tenantSession && this.config.agentApiKey) return "DELEGATED_TENANT_READ";
    if (this.tenantSession) return "DELEGATED_TENANT_READ";
    return "UNAVAILABLE";
  }

  /**
   * Formatted balance for display, plus the raw base units for decisions.
   *
   * Returning both keeps `formatTokens` where it belongs — in the UI — and
   * stops any code path from inferring "has credit" by inspecting a string.
   */
  private async readBalance(
    session: AuthenticatedSession,
  ): Promise<{ display: string; available: bigint; exhausted: boolean } | null> {
    try {
      const row = await session.client.getBalance();
      const available = BigInt(row.available);
      return {
        display: formatTokens(available),
        available,
        exhausted: Boolean(row.credit_exhausted),
      };
    } catch {
      return null;
    }
  }

  private async authenticateIdentity(
    role: "tenant" | "agent",
    privateKey: string,
  ): Promise<AuthenticatedSession> {
    if (!this.wasm) throw new T3nUnavailableError("WASM component was not loaded");

    let address: string;
    try {
      address = eth_get_address(privateKey);
    } catch (err) {
      throw new T3nAuthError(`${role} key is not a usable private key`, {
        cause: err,
        internal: { role },
      });
    }

    let trustAnchor;
    try {
      trustAnchor = await fetchTrustedManifest(this.config.environment);
    } catch (err) {
      throw new T3nUnavailableError(
        `could not fetch a valid trusted manifest for "${this.config.environment}"`,
        {
          cause: err,
          internal: { role },
          remediation:
            "This is usually an SDK/cluster version skew. See docs/bugs.md — the SDK version is pinned deliberately.",
        },
      );
    }

    const client = new T3nClient({
      ...(this.config.baseUrl ? { baseUrl: this.config.baseUrl } : {}),
      trustAnchor,
      wasmComponent: this.wasm,
      handlers: { EthSign: metamask_sign(address, undefined, privateKey) },
    });

    try {
      await client.handshake();
    } catch (err) {
      throw new T3nAuthError(`${role} handshake failed`, {
        cause: err,
        internal: { role, environment: this.config.environment },
      });
    }

    let did: string;
    try {
      did = (await client.authenticate(createEthAuthInput(address))).value;
    } catch (err) {
      throw new T3nAuthError(`${role} authentication failed`, {
        cause: err,
        internal: { role, environment: this.config.environment },
      });
    }

    if (!did.startsWith("did:t3n:")) {
      throw new T3nAuthError(`${role} session returned an unexpected DID format`, {
        internal: { role },
      });
    }

    this.log.info(`${role} authenticated`, { did: shortenDid(did) });
    return { client, did };
  }

  async tenant(): Promise<AuthenticatedSession> {
    await this.connect();
    if (!this.tenantSession) throw new T3nAuthError("tenant session unavailable");
    return this.tenantSession;
  }

  /** The agent's own session, when one exists (AGENT_SESSION mode only). */
  async agentOrNull(): Promise<AuthenticatedSession | null> {
    await this.connect();
    return this.agentSession;
  }

  async tenantOrgData(): Promise<SessionOrgDataClient> {
    const { client } = await this.tenant();
    return createOrgDataClientFromSession(client, this.nodeUrl);
  }

  /** Org-data client for whichever identity performs reads in the active mode. */
  async readerOrgData(): Promise<SessionOrgDataClient> {
    await this.connect();
    if (this.mode === "AGENT_SESSION" && this.agentSession) {
      return createOrgDataClientFromSession(this.agentSession.client, this.nodeUrl);
    }
    return this.tenantOrgData();
  }

  status(configError: string | null = null, warnings: readonly string[] = []): T3nStatus {
    let nodeUrl: string | null = null;
    try {
      nodeUrl = this.nodeUrl;
    } catch {
      nodeUrl = this.config.baseUrl;
    }

    const agentDid = this.agentDid;

    return {
      configured: true,
      configError,
      warnings: [...warnings],
      environment: this.config.environment,
      nodeUrl,
      state: this.state,
      wasmLoaded: this.wasm !== null,
      tenant: this.tenantSession
        ? {
            authenticated: true,
            did: this.tenantSession.did,
            shortDid: shortenDid(this.tenantSession.did),
            organisations: [],
            owner: null,
            balance: this.tenantBalance,
          }
        : EMPTY_IDENTITY,
      agent: agentDid
        ? {
            // The agent is "authenticated" when the network has confirmed its
            // credential, either by session or by a successful keyed whoami.
            authenticated: this.agentSession !== null || this.agentWhoami !== null,
            did: agentDid,
            shortDid: shortenDid(agentDid),
            organisations: this.agentWhoami?.organisations ?? [],
            owner: this.agentWhoami?.owner ?? null,
            balance: this.agentBalance,
          }
        : EMPTY_IDENTITY,
      orgDid: this.orgDid,
      contractId: this.config.contractId,
      enforcementMode: this.mode,
      enforcementDetail: ENFORCEMENT_DETAIL[this.mode],
      lastError: this.lastError,
      lastCheckedAt: this.lastCheckedAt,
      connectedAt: this.connectedAt,
    };
  }
}

/** Status shape used when T3N is not configured at all. */
export function unconfiguredStatus(
  configError: string | null,
  warnings: readonly string[] = [],
  environment = "testnet",
): T3nStatus {
  return {
    configured: false,
    configError,
    warnings: [...warnings],
    environment,
    nodeUrl: null,
    state: "disconnected",
    wasmLoaded: false,
    tenant: EMPTY_IDENTITY,
    agent: EMPTY_IDENTITY,
    orgDid: null,
    contractId: "—",
    enforcementMode: "UNAVAILABLE",
    enforcementDetail: ENFORCEMENT_DETAIL.UNAVAILABLE,
    lastError: null,
    lastCheckedAt: new Date().toISOString(),
    connectedAt: null,
  };
}
