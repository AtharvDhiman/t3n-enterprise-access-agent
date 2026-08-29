# T3N Research Notes (Phase 0)

Research performed before implementation. Everything below was verified against
either the **live official documentation** at `https://docs.terminal3.io` or the
**actually installed SDK** (`@terminal3/t3n-sdk@5.3.0`, published 2026-08-29).

Nothing in this file is guessed. Where something is unverified, it says so explicitly.

**Verification method**

| What | How verified |
|---|---|
| Docs | Raw Markdown pulled from `https://docs.terminal3.io/<path>.md` (every docs page is agent-readable by appending `.md`). Index: `https://docs.terminal3.io/llms.txt` |
| SDK API surface | `npm install @terminal3/t3n-sdk` then reading `dist/index.d.ts` (271 KB of type declarations) directly |
| SDK version | `npm view @terminal3/t3n-sdk` → `5.3.0` |

---

## 1. Core concepts

### DID (Decentralized Identifier)

`did:t3n:<40 hex chars>`. Opaque, platform-assigned. Bound to a secp256k1 keypair
the first time that key authenticates.

> **Hard rule from the docs, repeated in three places:** never hardcode, derive, or
> construct a DID. Always read it back from the authenticated session
> (`did.value`). Deriving it locally produces `tenant not found`.

Three distinct DID roles matter for this project:

| Role | Who | Key |
|---|---|---|
| **Tenant DID** | The enterprise deploying the agent | `T3N_API_KEY` |
| **Agent DID** | The compliance agent itself | `T3N_AGENT_KEY` — **must be a separate key** |
| **Subject DID** | The employee / contractor being evaluated (the *data owner*) | Their own key; we never hold it |

An agent's credit balance is **separate from its tenant's and starts at zero**.
Reusing the tenant key for the agent is documented as the most common cause of
`InsufficientCreditError`.

### Authentication ≠ Authorization

This is the single most important concept in the platform, and it is the reason
this project uses T3N at all.

- **Authenticating** proves the agent's identity (handshake → authenticate → DID).
- **Authorizing** is separate: the **data owner**, not the agent and not the tenant
  developer, must explicitly grant the agent access, scoped three ways at once:
  **which contract**, **which functions**, and **which scopes/hosts**.

From the Agent Auth page: an agent with no matching grant can still *call* a
contract — the call just fails when it tries to touch data or network, with
`host/http.egress_denied`.

The docs state the design rationale directly: splitting the two means the blast
radius of a leaked agent key is exactly what users explicitly granted it, and a
user can revoke access without any key changing.

### Data minimization primitives

| Primitive | Meaning |
|---|---|
| **Scopes** | Named org-data partitions (e.g. `compliance/identity`). A grant names exact scopes. |
| **Placeholders** | `{{profile.<field>}}` — resolved server-side *inside the enclave*. The literal placeholder string is what contract code sends; the real value never enters WASM memory. |
| **Public maps** | `z:<tid>:public:<tail>` — world-readable. Docs: **never put PII here.** |

---

## 2. Environments

Verified in `dist/index.d.ts`:

```ts
type Environment = "sandbox" | "testnet" | "production";
declare const NODE_URLS: Record<Environment, string>;
```

The **docs and the official Claude skill both use `setEnvironment("testnet")`**, and
the SDK's public build defaults to `testnet`. The bundled `README.md` inside the npm
package still describes `sandbox`/`production` only — that README is stale relative
to the docs. This project uses `testnet`, matching the documentation and skill.

`setEnvironment()` sets the node URL for every client constructed *afterwards*. An
explicit `baseUrl` on `T3nClient` takes precedence.

---

## 3. Authentication flow (verified working pattern)

```ts
import {
  T3nClient, setEnvironment, loadWasmComponent,
  eth_get_address, metamask_sign, createEthAuthInput, fetchTrustedManifest,
} from "@terminal3/t3n-sdk";

setEnvironment("testnet");

const wasmComponent = await loadWasmComponent();   // all client crypto runs in here
const address = eth_get_address(process.env.T3N_API_KEY!);

const t3n = new T3nClient({
  trustAnchor: await fetchTrustedManifest("testnet"), // operator-signed, verified
  wasmComponent,                                      // against a key pinned in the package
  handlers: { EthSign: metamask_sign(address, undefined, process.env.T3N_API_KEY!) },
});

await t3n.handshake();                                     // opens encrypted session
const did = await t3n.authenticate(createEthAuthInput(address));
const tenantDid = did.value;                               // did:t3n:...
```

Notes:

- `trustAnchor` is **required**. `fetchTrustedManifest` returns an operator-signed
  anchor verified against a public key pinned in the package; it never returns an
  unverified one.
- The API key **is** the secp256k1 private key. It never leaves the machine — it is
  used locally to sign the login challenge.
- `handshake()` must precede `authenticate()`. The session ID is **server-minted**
  from the `Session-Id` response header; a client-supplied session ID is rejected
  (closes the session-fixation vector).

---

## 4. Data-access mechanisms available *without* writing a Rust contract

This project deliberately uses T3N's **built-in** TEE contracts rather than
authoring a custom Rust/WASM contract. Rationale: `cargo`/`rustup` are not required,
there is no compile-and-register step in the handover burden, and the built-in
`tee:org-data/contracts` contract already provides exactly the primitives an
access-and-compliance decision needs.

Verified classes in `dist/index.d.ts`:

### `OrgDataClient` / `SessionOrgDataClient`

`createOrgDataClientFromSession(t3n, baseUrl)` builds one from an already
handshaked+authenticated `T3nClient`. Confirmed methods used by this project:

| Method | Input → Output | Used for |
|---|---|---|
| `createPolicy` | `{ orgDid, initialAdminDid, maxAdmins? }` → `MutationResponse` | One-time org bootstrap |
| `writeData` | `{ orgDid, scope, payloadHex, clientSeqNo \| entryId }` → `MutationResponse` | Writing minimized claim records / audit rows |
| `dataGet` | `{ orgDid, scope, entryId }` → `{ entry_id, payload_hex }` | Reading a single claim record |
| `dataList` | `{ orgDid, scope, offset?, limit? }` → `{ entry_ids, next_offset, total }` | Enumerating a scope |
| `setGrants` | `{ orgDid, contractId, grants: UserGrant[] }` → `MutationResponse` | Recording consent |
| `grantsGet` / `getDelegation` | → `OrgContractGrants` / `OrgContractDelegation` | Reading current consent |
| `listAgents` | `{...}` → `ListAgentsResponse` | Agent registry view |
| `agentCardGet` / `agentCardPublish` | → card | Agent identity/discovery |
| `secretWrite` / `secretGet` | → secret record | Server-side secret storage |

`UserGrant` (exact shape, verified):

```ts
interface UserGrant {
  user_did: string;   // did:t3n:<40-hex>
  functions: string[];// WIT function names the user may invoke
  scopes: string[];   // data scope paths the user may access
}
```

### `discoverCheckDelegation` — the authorization pre-check

This is the centerpiece of the privacy model in this project.

```ts
declare function discoverCheckDelegation(
  opts: DiscoverOptions,        // { baseUrl, apiKey, timeoutMs? }
  params: GrantCheckParams,
): Promise<GrantCheckResult>;

interface GrantCheckParams {
  contract:  string;   // target contract whose requirements are checked
  pii_did:   string;   // the member the agent wants to act for (the SUBJECT)
  functions: string[]; // functions the intended action needs
  scopes:    string[]; // org-data scopes the intended action needs
}

interface GrantCheckResult {
  authorised: boolean;
  disclosed:  boolean;
  satisfied:  DelegationGrantRef[];
  missing:    DelegationGrantRef[];
}
```

Why this matters: the agent can ask *"am I permitted to act for this subject over
exactly these scopes?"* and get back **`satisfied` / `missing`** — **without reading
any personal data at all**. A `REVIEW_REQUIRED` decision caused by absent consent is
therefore reached with **zero** data disclosure.

`DiscoverOptions.apiKey` is relayed in an `X-T3N-Api-Key` header. The SDK enforces
an HTTPS guard (loopback excepted) *before any network activity*, and every
`InvokeError` it throws carries a fixed generic message — the response body and the
API key are never interpolated into errors. That is a genuinely good security
property and this project relies on it.

### Discovery family (API-key based, session-free)

`discoverWhoami`, `discoverListContracts`, `discoverDescribeContract`,
`discoverDescribeFunction`, `discoverCheckDelegation`.

```ts
interface WhoamiResult {
  did: string;               // DID the relayed api key resolves to
  organisations: string[];   // org DIDs the agent belongs to
  owner: string | null;      // owning/managing DID; best-effort, mutable
}
```

These POST a `{ method, params }` envelope to `POST /api/discover`. They do **not**
open a session — cheap enough to use for a liveness/status check.

---

## 5. Agent registration

Two paths, both documented:

1. **Public self-registration** (`/developers/agents/register-agent`) — via the
   `t3n` CLI that ships in the SDK's `bin`:
   ```
   t3n whoami --env testnet                       # read the DID back, never derive it
   t3n agent create-card --did "$AGENT_DID"       # ERC-8004 registration-v1 card
   t3n agent host-card --file agent-card.json     # T3N hosts it, ≤16 KiB
   t3n agent registry "$AGENT_DID" --env testnet  # verify
   ```
   Card is then served verbatim at `GET /api/agent-card/<did>`, publicly resolvable.
   Under the hood `host-card` writes to the built-in `tee:org-data/contracts`
   contract in the self-owned `agent-cards` scope, then publishes a copy to the
   world-readable `public:agent_cards` map.

2. **Organization-owned** (`/developers/agents/provision-org-agent`) — card private
   by default.

Registration is a **metered write** — it consumes the agent's own credits.

---

## 6. Capabilities / TEE / WIT

Relevant even though this project writes no Rust, because it constrains what any
future custom contract could do:

- **Capabilities come entirely from WIT imports** in `world.wit`. There is no
  separate capability manifest. Importing an interface *is* requesting the capability.
- Confirmed-available host interfaces: `http`, `http-with-placeholders`, `kv-store`,
  `tenant` (`tenant-context`), `logging`.
- Confirmed-to-exist but maturity varies: `did-registry`, `agent-auth`,
  `user-profile`, `user-removal`, `contracts-call`, `authorisation`, `otp`,
  `config/read`, `provider-config`, `time/clock`, `node-config`, `stash`,
  `agent-registry`.
- Listed **coming soon**: `signing`, `outbox`, `vp`.
- `tenant_did()` returns **raw bytes** and must be hex-encoded **exactly once** when
  building a `z:<tid>:` path. Missing *or* double hex-encoding both silently produce
  a path matching nothing.

## 7. Outbound HTTP

Documented rule: **outbound HTTP is authorized by the calling user's grant, not by
the contract.** A correct-looking contract still fails with `host/http.egress_denied`
until a data owner signs an `agent-auth-update` naming the agent DID, the script, the
functions, and `allowedHosts`.

This project makes **no outbound HTTP from inside T3N**, so this constraint does not
bind it — but it is the reason the architecture treats consent as the gate.

---

## 8. Secrets handling

- The API key **is** a private key. Never commit it, never log it, never send it to a
  browser.
- SDK provides `maskKeyMaterial`, `redactSecrets`, `redactSecretsFromJson` — this
  project uses its own redaction at the logging boundary and never logs key material.
- Server-side only: the SDK loads a **WASM component**, and the docs explicitly warn
  that Next.js/Turbopack, Vite, and older Webpack break on it. **The SDK must never
  reach the browser bundle.**
- T3N-side secret storage exists (`secretWrite`/`secretGet`, KV maps with explicit
  `readers`/`writers` — ACLs **default to deny**).

---

## 9. Known SDK / platform limitations found during research

Documented here; reproducible issues are written up properly in [`bugs.md`](./bugs.md).

1. **WASM vs. bundlers.** Officially acknowledged as a "known rough edge". Mitigated
   architecturally: T3N runs only in the Node server process.
2. **Stale README in the published package.** `node_modules/@terminal3/t3n-sdk/README.md`
   documents environments as `sandbox | production` and shows
   `fetchTrustedManifest("sandbox")`, while the live docs and the official Claude
   skill use `testnet`. The type union accepts all three, so this misleads silently
   rather than failing loudly.
3. **Unverified delegation-credential surface.** The docs' own reference page flags
   `buildDelegationCredential()`, `signCredential()`, `signAgentInvocation()`,
   `DelegationCustodialClient`, `getAuditEvents()` as *"observed in community code
   only — not confirmed"*. **This project does not use any of them.**
4. **Agent credits start at zero** and are separate from the tenant's.
5. **Re-registering a contract can reroute version-pinned calls.**
6. **KV map ACLs default to deny** — `readers`/`writers` must be set explicitly.

---

## 10. Design consequences for this project

| Research finding | What we did about it |
|---|---|
| Authentication ≠ authorization | Consent (`discoverCheckDelegation`) is a **hard gate** before any claim read |
| `GrantCheckResult.satisfied` / `.missing` | Mapped straight onto the decision's satisfied/missing requirements — no data read needed to produce `REVIEW_REQUIRED` |
| Scopes are the minimization unit | Policies declare required **claims**; claims map to scopes; the agent requests **only** the scopes its policy needs |
| Never derive a DID | All DIDs read back from session / `whoami`; nothing derived |
| WASM breaks bundlers | T3N confined to `packages/t3n`, imported only by `apps/server` |
| API key is a private key | Server-side only, `.env`, never in `VITE_*`, never logged, never returned by any API route |
| Agent needs its own key + credits | Separate `T3N_AGENT_KEY`; status page reports both identities distinctly |
| Unverified SDK surfaces exist | Explicitly avoided; documented above |

---

## 11. Sources

- Docs index — <https://docs.terminal3.io/llms.txt>
- Quickstart — <https://docs.terminal3.io/developers/adk/get-started/quickstart.md>
- Agent Auth — <https://docs.terminal3.io/developers/adk/overview/agent-auth-adk.md>
- Register a Public Agent — <https://docs.terminal3.io/developers/agents/register-agent.md>
- SDK & API Reference — <https://docs.terminal3.io/developers/adk/reference.md>
- Common Errors — <https://docs.terminal3.io/developers/adk/tips/common-errors.md>
- AI Coding Assistants / skill file — <https://docs.terminal3.io/developers/adk/support/ai-coding-assistants.md>
- Installed SDK types — `node_modules/@terminal3/t3n-sdk/dist/index.d.ts` @ 5.3.0
