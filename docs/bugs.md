# Bug reports & platform findings

Issues **actually encountered** while building this project against Terminal 3.
Nothing here is hypothetical: every item was reproduced, and the reproduction
steps below are the ones that were actually run.

**Environment for all reports**

| | |
|---|---|
| Cluster | `testnet` — `https://cn-api.sg.testnet.t3n.terminal3.io` |
| SDK | `@terminal3/t3n-sdk` (versions noted per report) |
| Node | v22.19.0 |
| OS | Windows 11 (26100) |
| Date | 2026-08-29 |
| Contract | `tee:org-data/contracts` v2.7.0 |

Contact for follow-up: <devrel@terminal3.io> / [developer Telegram](https://t.me/terminal3developer).

---

## BUG-1 — SDK 5.3.0 rejects the live testnet trust manifest, blocking all authentication

**Severity: Critical — blocks every SDK operation on testnet.**
**Status: worked around by pinning `5.2.0`.**

### Summary

`fetchTrustedManifest("testnet")` throws `Trust manifest at … is malformed.` on
SDK **5.3.0**. Because `trustAnchor` is a required field of `T3nClient`, this
blocks `handshake()` and therefore *everything*. SDK **5.2.0 and earlier work
against the same live endpoint**, so this is a regression introduced in 5.3.0.

### Root cause

5.3.0's `TrustAnchor` requires `rtmr1_allowlist` (documented in the type as
*"Must be non-empty. This is the real SP-003 mitigation"*). The testnet node
does not serve that field.

Live response from `GET /api/trust-manifest` (2026-08-29, HTTP 200):

```json
{
  "cluster": "testnet",
  "version": 1787800421,
  "peer_ids": ["QmPk4AtbFore74fJoP4CoS9Q96TvRvoQWR4VmkYtkBLmwz", "…"],
  "rtmr3_allowlist": ["+XO6nLsfqnTkX0VcNk9AaXAu79ErxURODtjuGOIF8Sk7OQYq3PVVsMG8jzDEeNJQ"],
  "signed_at": "2026-08-27T03:13:41Z",
  "signature": "387384a9186bd06ab8…"
}
```

There is **no `rtmr1_allowlist` key**. The SDK's `SignedTrustManifest` interface
declares it as required.

Timeline is consistent with a client-ahead-of-cluster rollout: the manifest was
signed 2026-08-27; 5.3.0 was published 2026-08-28.

### Reproduction

```bash
npm install @terminal3/t3n-sdk@5.3.0
node --input-type=module -e '
import { fetchTrustedManifest, setEnvironment } from "@terminal3/t3n-sdk";
setEnvironment("testnet");
await fetchTrustedManifest("testnet");
'
```

### Expected vs. actual

- **Expected:** a verified `TrustAnchor`.
- **Actual:** `Error: Trust manifest at https://cn-api.sg.testnet.t3n.terminal3.io/api/trust-manifest is malformed.`

### Version bisection (each run against the live endpoint)

| SDK version | Result |
|---|---|
| 5.3.0 | ✗ `malformed` |
| 5.2.0 | ✓ OK (`rtmr1_allowlist` undefined, `rtmr3_allowlist` length 1) |
| 5.1.0 | ✓ OK |
| 5.0.0 | ✓ OK |
| 4.46.0 | ✓ OK |

### Workaround

Pin the SDK to `5.2.0` **exactly** (not `^5.2.0`, which resolves to 5.3.0):

```json
"@terminal3/t3n-sdk": "5.2.0"
```

### Suggested fix

Either serve `rtmr1_allowlist` from testnet nodes, or have the SDK treat it as
optional with a loud warning when absent, so a client cannot be published that
cannot talk to the running cluster. A version-skew error naming the missing
field would also have turned a 40-minute investigation into a 1-minute one.

### Does it block functionality?

Yes, totally — until pinned. This is the single highest-impact issue found.

---

## BUG-2 — Claiming a second API key does not create a second identity

**Severity: High — silently defeats tenant/agent separation.**
**Status: worked around via `createAgent`.**

### Summary

[Register a Public Agent](https://docs.terminal3.io/developers/agents/register-agent)
says the claim page *"issues a fresh key together with metered test credits every
time, so you can revisit it once per agent, not just once for yourself."* This
reads as: revisit the page to get an agent identity.

In practice, **every key claimed while signed in to the same account resolves to
the same DID.** Two different private keys, two different Ethereum addresses,
one DID — the new key is registered as an additional *authenticator* on the
existing account rather than as a new identity.

This matters because the whole authentication-vs-authorization model rests on
the agent being a *different principal* from the tenant. Following the docs
literally produces an agent that silently holds the tenant's full authority.

### Reproduction

Claim two keys from the claim page while signed in with the same account, then:

```ts
setEnvironment("testnet");
const a = await authenticate(process.env.T3N_API_KEY!);    // key 1
const b = await authenticate(process.env.T3N_AGENT_KEY!);  // key 2
console.log(a, b, a === b);
```

### Expected vs. actual

- **Expected (per docs):** two distinct `did:t3n:` values.
- **Actual:** both return `did:t3n:2eaed84a2d5d72c2f8a19f1a832e8d63d96a9e5a`.
  Addresses differ (`0xd4d7b88b…` vs `0x53540ec8…`); the DID does not.

A **locally generated** keypair *does* mint a distinct DID
(`did:t3n:9cfe74c0…`), confirming it is account binding, not key handling — but
such a key has **zero credits**, so it cannot pay for metered operations.

### Workaround

Provision the agent properly with `T3nClient.createAgent(orgDid, name)`, which
mints a genuinely separate agent DID under an organisation and returns a
one-time opaque `t3n_key_…` credential. This project's
[`scripts/t3n-setup.ts`](../scripts/t3n-setup.ts) does exactly that.

### Suggested fix

Clarify on the register-agent page that revisiting the claim page adds an
authenticator to the *same* account, and that `createAgent` (or org
provisioning) is the way to obtain a separate agent identity. As written, the
page points developers at a method that cannot produce the outcome it promises.

---

## BUG-3 — `delegation.check` ignores the `scopes` parameter

**Severity: Medium — an authorization check reports success for scopes it was never granted.**
**Status: mitigated in application code.**

### Summary

`discoverCheckDelegation` (and the session `checkDelegation`) enforces the
`functions` parameter correctly but appears to **ignore `scopes` entirely**:

- requesting a scope that was never granted still returns `authorised: true`;
- `satisfied[].scopes` is always `[]`, even when the grant demonstrably carries
  scopes (`getAgentAuth()` shows them).

### Reproduction

Grant an agent exactly two scopes:

```ts
await t3n.agentAuthUpdate({ agents: [{ agentDid, scripts: [{
  scriptName: "tee:org-data",
  functions: ["org-data-get", "org-data-list"],
  scopes:     ["compliance/identity", "compliance/employment"],
  readScopes: ["compliance/identity", "compliance/employment"],
  allowedHosts: [],
}]}]});
```

Then check against a scope that was **not** granted:

| Query | `authorised` | `satisfied` | `missing` |
|---|---|---|---|
| granted scopes, granted functions | `true` | 1 | `[]` |
| **`compliance/training` (never granted)** | **`true`** | 1 | `[]` |
| mixed granted + ungranted | `true` | 1 | `[]` |
| `org-data-write` (function not granted) | `false` | 0 | 1 entry |

The function check works. The scope check does not.

### Expected vs. actual

- **Expected:** a scope outside the grant yields `authorised: false`, or appears
  in `missing`, and `satisfied[].scopes` reflects the granted scopes.
- **Actual:** ungranted scopes are indistinguishable from granted ones, and
  `satisfied[].scopes` is empty.

### Impact & workaround

An application that trusted `authorised` alone as a scope-level gate would
believe it had consent it does not have. This project therefore does **not**
rely on it for scope decisions: it uses `checkDelegation` as the *agent-level*
gate (which works), and separately reads the authoritative grant record via
`grantsGet` to determine which scopes may actually be read — see
[`packages/t3n/src/live.ts`](../packages/t3n/src/live.ts).

### Does it block functionality?

No — but it is a security-relevant footgun, because the failure mode is
permissive rather than restrictive.

---

## BUG-4 — `invoke` cannot reach core `tee:` contracts, which is undocumented

**Severity: Medium — an org-provisioned agent cannot read org data.**
**Status: architectural workaround; documented as a limitation.**

### Summary

`createAgent` returns an opaque `t3n_key_…` credential, and the SDK documents
the keyed transports (`invoke`, `discover*`) as the way to use it. But **every**
`invoke` call against a core contract is refused:

```json
{"error":"invoke is restricted to z: (tenant) contracts","code":"bad_request"}
```

So an agent provisioned exactly as the docs describe can authenticate
(`discoverWhoami` works, returning its DID, org and owner) and can be granted
scopes on `tee:org-data/contracts` — but cannot then read them, because the only
transport its credential works with refuses that contract class.

Combined with **BUG-2** (a claimed key cannot be a separate identity) and the
credit floor on session reads, there is no documented path by which a separate
agent identity reads core org-data. The available options are: deploy a custom
Rust `z:` contract, or obtain a credited agent DID under a different account.

### Reproduction

```bash
curl -sS -X POST https://cn-api.sg.testnet.t3n.terminal3.io/api/invoke \
  -H 'content-type: application/json' -H "X-T3N-Api-Key: $T3N_AGENT_API_KEY" \
  -d '{"contract_id":"tee:org-data/contracts","contract_version":"2.7.0",
       "function_name":"org-data-list","input":{"org_did":"'"$T3N_ORG_DID"'","scope":"compliance/identity"}}'
```

Returns HTTP 400 `invoke is restricted to z: (tenant) contracts` for every core
contract and every function, including read-only ones.

### Note on error opacity

The SDK's `InvokeError` deliberately carries a fixed generic message and never
interpolates the response body — good key hygiene, but it means the actual cause
above is invisible from the SDK. It was only found by calling the endpoint
directly. A non-secret `code` field surfaced on the error object would keep the
hygiene property and still be debuggable.

### Suggested fix

Document the `z:`-only restriction on `invoke` prominently, and state which
transport an org-provisioned agent should use to read `tee:org-data`.

---

## BUG-5 — A zero-credit DID cannot perform even read-only operations

**Severity: Low–Medium — mostly a documentation/UX issue.**

### Summary

A locally generated keypair authenticates successfully and receives a DID, but
any org-data read fails with:

```
InsufficientCreditError: InsufficientCredit (account=cc78572e…, required=10000000000, available=0)
```

`required=10000000000` base units (≈10,000 tokens) appears to be a **minimum
balance floor**, not the operation's price — the tenant's balance moved only
~30 tokens across dozens of operations during this build.

Because credits are only obtainable from the claim page, and the claim page
cannot mint a second identity (BUG-2), a self-generated agent identity is
unusable in practice.

### Suggested fix

Distinguish "reserve floor" from "price" in the error message, and document how
to fund an agent DID (or state plainly that org-provisioned agents draw on the
org's balance).

---

## BUG-6 — Contract naming is inconsistent between `contracts.list` and `getContractVersion`

**Severity: Low — costs a debugging cycle.**

`listContracts()` reports the contract as `tee:org-data`, but
`getContractVersion()` only accepts the `/contracts` suffix:

```
getContractVersion("tee:org-data")           → Error: 404 Not Found
getContractVersion("tee:org-data/contracts") → "2.7.0"
```

Confusingly, `discoverDescribeContract` accepts **both** and returns identical
descriptors. Whichever form is canonical, the three surfaces should agree — or
the 404 should say "did you mean `tee:org-data/contracts`?".

---

## BUG-7 — The published package README contradicts the documentation site

**Severity: Low — misleading, and fails silently rather than loudly.**

`node_modules/@terminal3/t3n-sdk/README.md` states:

> - `sandbox` — the public test network …
> - `production` — the public mainnet network.

and its examples call `fetchTrustedManifest("sandbox")`. The documentation site,
the Quickstart, and the official Claude Code skill all use **`testnet`**.

The type union accepts all three (`"sandbox" | "testnet" | "production"`), and
`NODE_URLS` maps `sandbox` and `testnet` to the *same* URL today — so following
the packaged README appears to work and would break the day those diverge. A
developer reading only the package README has no way to notice.

**Suggested fix:** regenerate the packaged README from the docs site, or drop
the environment section from it and link to the Quickstart.

---

## BUG-8 — `tsx watch` deadlocks `loadWasmComponent()`

**Severity: Medium — breaks the obvious dev-server setup.**
**Status: worked around by not using `tsx watch` for the server.**

### Summary

Running the server under `tsx watch` hangs indefinitely at
`loadWasmComponent()`. The same file under plain `tsx` loads the component in
~120 ms and connects in ~3.4 s.

This is a third variant of the SDK's known bundler/runtime friction — the docs
warn about Next.js, Vite and Webpack, but not about `tsx watch`, which is the
natural choice for a Node dev server and is what the SDK's own quickstart
implies (`npx tsx quickstart.ts`).

### Reproduction

```bash
# hangs at "loading T3N WASM component", never listens
npx tsx watch apps/server/src/index.ts

# same file, same cwd, same env — works
npx tsx apps/server/src/index.ts
```

Observed log under `tsx watch`, with nothing following it for 25+ seconds:

```json
{"level":"info","scope":"server:t3n","msg":"loading T3N WASM component"}
```

### Expected vs. actual

- **Expected:** `tsx watch` behaves like `tsx` plus file watching.
- **Actual:** the WASM component load never resolves, so the server never
  reaches `listen()`.

`tsx watch` supervises the app in a child process and restarts it on change;
the WASM component's instantiation appears not to complete under that
supervisor. We did not root-cause it further, because the workaround is cheap.

### Workaround

Use plain `tsx` for the server. `apps/server`'s `dev` script is
`tsx src/index.ts`, and `dev:watch` is kept alongside it so the behaviour can be
re-tested against future SDK or `tsx` releases:

```json
"dev":       "tsx src/index.ts",
"dev:watch": "tsx watch src/index.ts"
```

The cost is losing auto-restart on save. That is a fair trade: the server starts
in about four seconds, and a dev command that silently hangs is far more
expensive than one that needs a manual restart.

### Does it block functionality?

Not the product — only the watch-mode developer convenience.

---

## Not bugs — behaviour that was simply unclear

Recorded because each cost real time, and a sentence of documentation would
have prevented it.

| Observation | Note |
|---|---|
| The claim page's "API Key" **is** a secp256k1 private key | Calling it an "API key" alongside a separate "DID" field invites pasting the DID where the key belongs. |
| `createAgent`'s `apiKey` is returned **exactly once** | Correct and clearly documented in the type — worth repeating in the guide, since losing it means re-minting the agent. |
| Org-data ACLs default to deny | Documented, and genuinely the right default; `setWriters` must be called before the first `writeData` or it fails with `NotScopeWriter`. |
| `agentAuthUpdate` auto-applies a ~90-day validity window | Sensible, but the automatic `validFromSecs`/`validUntilSecs` are not mentioned in the Agent Auth page. |
| The agent credential contains a `.` separator | `t3n_key_<keyId>.<secret>`. An alphanumeric-only validator rejects every real credential — this project's did, briefly. |

---

## What worked well

Worth saying, since a bug list is a biased sample:

- **`createAgent` is excellent** — atomic mint + registry record + hosted card
  in one transaction, with all-or-nothing semantics.
- **The authentication/authorization split** is the right model and is enforced
  in practice: before consent, `checkDelegation` returned
  `authorised: false, disclosed: false` — no data, and no *inference* about data.
- **Error hygiene in the keyed transports** is genuinely well designed: the API
  key is never interpolated into an error or a log line.
- **`getActivityLog`** provides hash-chained, tamper-evident activity records
  with `actor` and `on_behalf_of` — better audit primitives than most platforms.
- **Docs are agent-readable** (`.md` on any URL, plus `/llms.txt`), which made
  research fast and accurate.
