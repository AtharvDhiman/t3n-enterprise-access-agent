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
  private tenantBalance: string | null = null;
  private agentBalance: string | null = null;
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

  /** The agent's DID, as verified against the network where possible. */
  get agentDid(): string | null {
    return this.agentSession?.did ?? this.config.agentDid;
  }

  isConnected(): boolean {
    return this.state === "connected";
  }

  async connect(): Promise<void> {
    if (this.state === "connected") return;
    if (this.inflight) return this.inflight;
    this.inflight = this.doConnect().finally(() => {
      this.inflight = null;
    });
    return this.inflight;
  }

  reset(): void {
    this.tenantSession = null;
    this.agentSession = null;
    this.agentWhoami = null;
    this.state = "disconnected";
    this.connectedAt = null;
    this.mode = "UNAVAILABLE";
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
      this.tenantBalance = await this.readBalance(this.tenantSession);

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
            this.agentBalance = await this.readBalance(session);
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
          if (this.config.agentDid && who.did !== this.config.agentDid) {
            this.log.warn("provisioned T3N_AGENT_DID disagrees with the network", {
              configured: this.config.agentDid,
              actual: who.did,
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
    if (this.agentSession && this.agentBalance && !this.agentBalance.startsWith("0 ")) {
      return "AGENT_SESSION";
    }
    if (this.tenantSession && this.config.agentApiKey) return "DELEGATED_TENANT_READ";
    if (this.tenantSession) return "DELEGATED_TENANT_READ";
    return "UNAVAILABLE";
  }

  private async readBalance(session: AuthenticatedSession): Promise<string | null> {
    try {
      const row = await session.client.getBalance();
      return formatTokens(BigInt(row.available));
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
