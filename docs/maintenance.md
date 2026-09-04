# Maintenance

Written for the person who inherits this and has not read the rest of the repo.

## Orientation in five minutes

```
config/policies.yaml          ← all business rules. Start here.
packages/policy-engine/       ← decides. Pure function. No I/O.
packages/t3n/                 ← the only place that talks to Terminal 3.
packages/core/                ← types, errors, redaction, audit store.
apps/server/                  ← HTTP + orchestration + optional LLM.
apps/web/                     ← dashboard. Talks HTTP only.
scripts/                      ← one-off Terminal 3 operations.
```

If you change one thing, `npm run verify` tells you whether you broke anything.

## Running locally

```bash
npm install
cp .env.example .env      # fill in T3N_API_KEY for live mode
npm run dev               # dashboard :5173, API :8787
```

The server does not auto-restart on save (see [BUG-8](bugs.md)); restart it
after a server-side change. The frontend hot-reloads normally.

Demo mode needs no credentials at all — `CLAIM_SOURCE=demo` is the default.

## Adding a policy

Everything happens in `config/policies.yaml`. No code changes.

**1. Make sure the claims exist.** If your policy needs evidence the system does
not yet know about, add it to `claims:` first:

```yaml
claims:
  insurance_verified:
    scope: compliance/insurance      # the T3N scope this claim lives in
    label: Professional indemnity insurance verified
    description: >
      Confirms active professional indemnity cover. The agent learns only that
      cover is active — never the insurer, the policy number, or the sum insured.
```

Keep writing descriptions in that style: state what the agent learns *and* what
it does not. It is the clearest place to notice if a claim is carrying more than
it should.

**2. Add the policy:**

```yaml
policies:
  consultant_access:
    label: Consultant access
    description: Access for an external consultant engaged on a client project.
    applies_to_subject_types: [contractor, partner]
    resources: [project_workspace, internal_wiki]
    access_levels: [read]
    required_claims: [identity_verified, contractor_verified, insurance_verified]
    optional_claims: [nda_signed]
    rules:
      minimum_assurance: high
      require_manual_approval: false
      flag_missing_optional: true
```

**3. Add it to `resolution.order`.** Validation *fails* if you forget — an
unreachable policy is treated as a configuration error, not something to warn
about. Order matters: it is first-match, most-specific first.

**4. Verify:**

```bash
npm test
```

The config tests parse the real file, so a mistake shows up immediately with the
offending path.

### Rules you can set per policy

| Key | Meaning |
|---|---|
| `minimum_assurance` | `none` \| `low` \| `substantial` \| `high` |
| `max_claim_age_days` | Claims verified longer ago are stale |
| `expired_claim_behavior` | `review` or `deny` |
| `failed_claim_behavior` | `review` or `deny` (defaults to `deny`) |
| `expiring_soon_days` | Warning window for `CLAIM_EXPIRING_SOON` |
| `require_manual_approval` | Always escalate, even when everything passes |
| `flag_missing_optional` | Raise a flag when an optional claim is absent |

Anything omitted inherits from `defaults:`.

## Adding a resource type or access level

Add the string to the relevant policy's `resources:` or `access_levels:`. They
are lower_snake_case identifiers validated by the schema. The dashboard's
dropdowns are populated from the API, so new values appear with no frontend
change.

## Adding a claim source

Implement `ClaimSource` (`packages/t3n/src/source.ts`) — one method,
`fetchClaims(request) → ClaimSet` — and select it in `ComplianceService`'s
constructor.

Two rules a new source must honour:

- Return a truthful `ClaimSourceKind`. Never let a non-live source report `LIVE_T3N`.
- Never return claims from a scope outside `request.requiredScopes`.

## Updating the Terminal 3 SDK

> **The SDK is pinned to `5.2.0` deliberately.** `5.3.0` cannot authenticate
> against testnet at all — see [bugs.md BUG-1](bugs.md).

To try a newer version:

```bash
npm install @terminal3/t3n-sdk@<version> --workspace @t3n-aca/t3n
npm install @terminal3/t3n-sdk@<version>            # root, for scripts/
npm run t3n:connect                                 # MUST print a did:t3n: value
npm run verify
```

If `t3n:connect` fails at the trust-manifest step, the version is still affected
by BUG-1; revert. Keep the root and workspace versions identical — a mismatch
means the diagnostic script and the app talk to the platform through different
code.

Check the [ADK changelog](https://docs.terminal3.io/developers/adk/changelog)
before upgrading. If contract function names change, they are all in
`packages/t3n/src/live.ts` (`READ_FUNCTIONS`) and `scripts/t3n-seed.ts`.

Re-discover the authoritative function list at any time:

```ts
await discoverDescribeContract({ baseUrl, apiKey }, { contract: "tee:org-data/contracts" });
```

## Rotating secrets

**Tenant key.** Claim a new key, update `T3N_API_KEY`, restart, run
`npm run t3n:connect`. Note the new key binds to the **same** DID (that is
[BUG-2](bugs.md), and here it works in your favour) — so org ownership and grants
survive rotation.

**Agent credential.** The opaque credential cannot be re-read. To rotate, clear
`T3N_AGENT_API_KEY` and `T3N_AGENT_DID` from `.env`, re-run `npm run t3n:setup`
to mint a fresh agent, then re-run `npm run t3n:seed` so grants name the new
agent DID. Old grants pointing at the retired DID should be removed by the data
owner.

**Audit salt.** `AUDIT_SALT` must not change once a journal has records — the
hashes would no longer match earlier entries. To rotate, archive the existing
journal and start a new one, recording the changeover date.

## Running the tests

```bash
npm test              # 163 tests
npm run test:watch
npm run verify        # typecheck + lint + tests — run before every commit
```

The suite never touches the network and needs no credentials.

## Deploying

See [deployment.md](deployment.md).

## Common failures

| Symptom | Cause | Fix |
|---|---|---|
| `Trust manifest … is malformed` | SDK 5.3.0 vs testnet ([BUG-1](bugs.md)) | Pin `5.2.0` exactly |
| `Invalid Ethereum private key` | `T3N_API_KEY` unset or placeholder | Fill in `.env` |
| Server exits: "CLAIM_SOURCE=live but Terminal 3 is not configured" | Intentional. It refuses to serve fixtures while claiming to be live | Configure T3N, or set `CLAIM_SOURCE=demo` |
| "Live mode needs a Terminal 3 DID" | Demo fixture id submitted in live mode | Use the seeded DID from T3N Status, or switch to demo |
| `NotScopeWriter` | Org-data ACLs default to deny | `setWriters` before writing — `npm run t3n:seed` does it |
| `InsufficientCredit` | Agent DID has no credits ([BUG-5](bugs.md)) | Leave `T3N_AGENT_KEY` blank; `DELEGATED_TENANT_READ` handles it |
| `invoke is restricted to z: contracts` | Keyed transport cannot reach core contracts ([BUG-4](bugs.md)) | Expected; not used on the live path |
| Policy file rejected at startup | Strict schema | Read the error — it names the exact path |
| Vite fails with a WASM error | Something imported `@t3n-aca/t3n` into `apps/web` | Remove it. The SDK must stay server-side |
| Server hangs at "loading T3N WASM component" | Running under `tsx watch` ([BUG-8](bugs.md)) | Use plain `tsx` — that is what `dev`/`start` already do |
| `cannot read policy file at …/apps/server/config/policies.yaml` | Paths resolved against cwd instead of the repo root | Fixed by `apps/server/src/paths.ts`; do not reintroduce `resolve(process.cwd(), …)` |
| Agent DID equals tenant DID | Second claimed key ([BUG-2](bugs.md)) | Use `npm run t3n:setup` |

## Troubleshooting method

1. **Check the T3N Status page first.** State, both DIDs, enforcement mode and
   warnings are all there, and it distinguishes "not configured" from
   "configured but failing".
2. **Run `npm run t3n:connect`.** It talks to the SDK directly, bypassing this
   project's code, so it separates "Terminal 3 problem" from "our problem".
3. **Read the server log.** JSON lines, already redacted, with the scope that
   emitted them.
4. **`InvokeError` messages are deliberately generic** — the SDK never
   interpolates the response body. To see the real cause, call
   `POST /api/invoke` directly with curl (see [bugs.md BUG-4](bugs.md)).
5. **Check [bugs.md](bugs.md)** before assuming it is your code. Several sharp
   edges here are platform-side and documented with reproductions.
