# Handover

Everything needed to take ownership of this project. Written on the assumption
the reader has not spoken to the original author.

The challenge asks whether the agent should keep running or be handed over. This
project is built so **either works**: there is no hosted service to inherit, no
proprietary dependency, and no state that lives only in the author's head. What
follows is the whole picture.

## What this is, in one paragraph

An enterprise dashboard and agent that decides access requests ("can this
contractor get repository access?") from **verified claims** held on Terminal 3,
rather than from personal documents. A deterministic policy engine produces
`APPROVED` / `REVIEW_REQUIRED` / `DENIED` with a full explanation; the agent
never receives dates of birth, document numbers, or addresses, and reads a
subject's claims only within the consent that subject granted to the agent's DID.

## Architecture in 60 seconds

```
apps/web  ──HTTP──▶  apps/server  ──▶  packages/policy-engine   (decides; pure)
                          │
                          └──────────▶  packages/t3n            (only T3N caller)
                                             │
                                             ▼
                                     Terminal 3 testnet
```

- **The engine decides.** Pure function of (config, request, claims, clock). No I/O, no model.
- **The LLM cannot decide.** Its tools expose no operation that grants access.
- **The SDK never reaches the browser.** WASM + credentials stay server-side.

Detail: [architecture.md](architecture.md).

## Credentials you need

| Credential | Where it comes from | Notes |
|---|---|---|
| `T3N_API_KEY` | <https://www.terminal3.io/claim-page> | A secp256k1 private key. Comes with test credits |
| `T3N_AGENT_API_KEY` | `npm run t3n:setup` | Opaque `t3n_key_…`. **Returned once, never recoverable** |
| `ANTHROPIC_API_KEY` | <https://console.anthropic.com> | Optional |

If you are taking over an existing deployment, you need the current `.env` (or
its secret-store equivalent). If you cannot get the agent credential, you do not
need it: run `npm run t3n:setup` to mint a fresh agent and `npm run t3n:seed` to
re-issue grants. Nothing is lost except the retired agent DID's history.

## Environment variables

Every one is documented inline in [`.env.example`](../.env.example) and tabulated
in the [README](../README.md#environment-variables).

The four that matter operationally:

- `CLAIM_SOURCE` — `live` or `demo`. Demo needs no credentials and is clearly labelled everywhere.
- `T3N_ENV` — `testnet` or `production`.
- `AUDIT_SALT` — set once per deployment, then **never change it**.
- `T3N_AGENT_KEY` — optional; supplying a *credited, distinct* agent private key upgrades enforcement to `AGENT_SESSION`.

## Standing it up from nothing

```bash
git clone <repo> && cd t3n-access-compliance-agent
npm install
cp .env.example .env

# demo mode works immediately, no credentials:
npm run dev                     # → http://localhost:5173

# for live:
#   put your claim-page key in T3N_API_KEY, then:
npm run t3n:connect             # must print did:t3n:…
npm run t3n:setup               # creates org + agent, writes DIDs to .env
npm run t3n:seed                # claim records + consent grants
#   set CLAIM_SOURCE=live, restart
npm run verify                  # typecheck + lint + 121 tests
```

Production: [deployment.md](deployment.md).

## Operational responsibilities

| Area | What it involves | Reference |
|---|---|---|
| Uptime | One Node process. `/api/health` for liveness | [OPERATIONS.md](OPERATIONS.md) |
| Credits | Metered T3N operations; top up from the claim page | OPERATIONS |
| Consent windows | Grants expire ~90 days; renewals must be diarised | OPERATIONS |
| Policy changes | Edit YAML, run tests, commit, restart | [maintenance.md](maintenance.md) |
| Audit retention | Rotate on a restart boundary; archive | OPERATIONS |
| Secret rotation | Agent credential is the fiddly one | maintenance / SECURITY |
| Dependency updates | **The SDK pin is deliberate** | maintenance |

Realistically this is well under an hour a month once running, plus whatever your
own change control adds.

## Monitoring

Alert on: `/api/health` failing; `/api/t3n/status` `state !== "connected"` for
> 10 min; credit balance low; `enforcementMode === "UNAVAILABLE"` while live;
any `"level":"error"` log line.

Do **not** use the T3N status endpoint for liveness — the server intentionally
stays up when Terminal 3 is down so you can see why.

## Troubleshooting entry points

1. **T3N Status page** — state, both DIDs, enforcement mode, config warnings.
2. **`npm run t3n:connect`** — talks to the SDK directly, bypassing this project's
   code. Separates "Terminal 3 problem" from "our problem". This is the single
   most useful command in the repo.
3. **[bugs.md](bugs.md)** — eight reproduced platform issues. Check here before
   assuming a bug is yours; several are not.
4. **[maintenance.md → Common failures](maintenance.md)** — symptom/cause/fix table.

## The three things most likely to bite you

1. **Do not widen the SDK version range.** `@terminal3/t3n-sdk` is pinned to
   `5.2.0` *exactly*. Version `5.3.0` cannot authenticate against testnet at all —
   `fetchTrustedManifest` throws `malformed` because it requires an
   `rtmr1_allowlist` field the cluster does not serve ([BUG-1](bugs.md)). A
   caret range silently reintroduces this. Always run `npm run t3n:connect` after
   any SDK change.

2. **Do not try to create an agent by claiming a second API key.** Every key
   claimed under the same account resolves to the **same DID**, so the agent
   would silently hold the tenant's full authority — defeating the entire
   security model, without any error. Use `npm run t3n:setup`
   ([BUG-2](bugs.md)).

3. **Do not switch to `CLAIM_SOURCE=demo` to work around a Terminal 3 outage.**
   That substitutes fictional evidence for real evidence. The system refuses to
   do this silently by design; do not defeat it manually. Pause decisions
   instead.

## Backup and recovery

Back up exactly two things:

1. **`.env` / secret store** — the agent credential is unrecoverable.
2. **The audit journal** — append-only compliance record.

Everything else (policies, code) is in git. A rebuilt host with those two
restored is fully functional. On-network state (org, agent identity, grants,
claim records) lives on Terminal 3 and survives host loss entirely.

Recovery from total loss *including* the agent credential: reprovision with
`t3n:setup` + `t3n:seed`. Existing claim records are untouched; only the agent
identity and grants are recreated.

## Known limitations you are inheriting

Stated plainly so nothing is a surprise:

1. **Enforcement is `DELEGATED_TENANT_READ` by default.** Authorization is
   checked as the agent and the readable scope set comes from the on-network
   grant record — but the read itself executes on the tenant session, because an
   org-provisioned agent's credential cannot invoke core `tee:` contracts
   ([BUG-4](bugs.md)) and an uncredited DID cannot open metered reads
   ([BUG-5](bugs.md)). The UI states the active mode rather than glossing it.
   *Closing this* means either a credited agent DID (set `T3N_AGENT_KEY`, no code
   change) or deploying a Rust `z:` contract.
2. **`checkDelegation` ignores `scopes`** ([BUG-3](bugs.md)) — the app compensates
   by reading the grant record. If the platform fixes this, the compensation can
   be simplified but is not wrong.
3. **One live subject**, via T3N's documented self-grant pattern. Multi-subject
   needs one data-owner DID per person; the code path is identical.
4. **Flat claim scopes.** Per-subject scopes are stronger; `ClaimRecordSchema`
   already carries `subject` so the code is correct in the interim.
5. **No dashboard authentication.** Put it behind SSO before exposing it.

## Where to get help

- Terminal 3 docs — <https://docs.terminal3.io> (append `.md` to any page for Markdown; index at `/llms.txt`)
- Developer Telegram — <https://t.me/terminal3developer>
- <devrel@terminal3.io>
- Platform status — <https://status.terminal3.io/>

## Handover checklist

- [ ] Repository access transferred
- [ ] `.env` (or secret-store entries) transferred securely — **not** over chat or email
- [ ] Audit journal archive transferred
- [ ] `npm run verify` passes on the new owner's machine
- [ ] `npm run t3n:connect` prints a `did:t3n:…` on the new owner's machine
- [ ] New owner has read [bugs.md](bugs.md) — especially BUG-1 and BUG-2
- [ ] Monitoring/alerting repointed
- [ ] Consent-window renewal diarised
- [ ] Decision made on `T3N_ENV`: stay on testnet, or move to production
