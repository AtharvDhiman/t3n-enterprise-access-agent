# T3N Enterprise Access & Compliance Agent

**Answer "can this person be granted this access?" without the enterprise — or the
agent — ever receiving the personal data behind the answer.**

Built on the [Terminal 3](https://terminal3.io) Agent Developer Kit.
Connected live to T3N testnet.

---

## The problem

Every enterprise runs the same broken loop when someone requests access to a
system.

A contractor needs repository access. Someone emails a passport scan. It lands in
a ticketing system, gets forwarded to a shared inbox, is pasted into a Slack
thread, and is eventually screenshotted into a compliance spreadsheet. Four teams
now hold a copy of a document that answers exactly one question — *is this person
who they say they are?* — a question with a one-bit answer.

The cost of that loop is not the reviewing. It is that **the enterprise now holds
data it never needed and cannot easily delete**, that the decision is
unreproducible six months later when an auditor asks *why* access was granted,
and that the person has no idea who holds their documents or for how long.

The instinct to point an LLM at it makes things worse, not better: now a model
sees the passport too, and a model's judgement is not something you can put in
front of an auditor.

## The solution

This is an enterprise dashboard and agent that decides access requests from
**verified claims** rather than documents.

The agent asks Terminal 3 a narrow question — *"has this person's identity been
verified, to what standard, and is it still valid?"* — and receives a one-bit
answer with provenance. It never receives the passport, the date of birth, the
address, or the document number. Those never leave the subject's control.

A deterministic policy engine turns those claims into one of three outcomes:

| | |
|---|---|
| **APPROVED** | Every requirement satisfied. Grant it. |
| **REVIEW_REQUIRED** | Something is unknown, missing, or the policy demands a human. |
| **DENIED** | A required verification explicitly failed, or the request is out of policy. |

Every decision produces a structured explanation — policy applied, requirements
satisfied, requirements missing, risk flags, recommended next action — and an
audit record that can answer "why?" years later without storing anything
sensitive.

### The distinction that matters

Most access systems collapse two very different facts into one outcome:

- *"We checked, and it is false."*
- *"We were not permitted to look."*

This system keeps them apart, deliberately. A **failed** verification denies. An
**absent** one escalates to a human. Collapsing them would either deny people for
paperwork gaps or approve them on missing evidence — and both are the sort of
error that ends up in a regulator's report.

## Why Terminal 3 — and why it is not decoration

Strip out T3N and this becomes a rules engine over a database of personal data —
the thing we were trying to avoid. Three specific platform capabilities do the
real work:

**1. Authentication is not authorization.** The agent has its own DID and its own
credential, and being authenticated grants it nothing. The **data owner** must
separately sign a grant naming that agent DID, the exact functions, and the exact
scopes. That grant is a first-class on-network object with a validity window, and
revoking it takes effect immediately without any key changing.

**2. Consent can be checked without disclosing anything.** `checkDelegation`,
sent under the agent's own credential, answers "may I act for this subject over
these scopes?" **before** any data is read. Verified live:

```
BEFORE the grant:  { authorised: false, disclosed: false, satisfied: [], missing: [] }
AFTER  the grant:  { authorised: true,  disclosed: true,  satisfied: [ … ] }
```

A `REVIEW_REQUIRED` caused by absent consent is therefore reached having
disclosed **nothing at all** — not the claim, not its absence, not whether the
subject exists.

**3. Scopes make minimization mechanical rather than aspirational.** A policy
declares the claims it needs; each claim maps to exactly one T3N scope; the agent
requests only those scopes. What it may actually read is bounded by the
**on-network grant record**, read fresh on every evaluation — not by our own
configuration, which we could get wrong.

The result: the enterprise gets a defensible decision, the agent holds the
narrowest possible authority, and the subject keeps their documents and can
revoke access at any time.

## Architecture

```
┌──────────────────────────────────────────────────────────────────────────┐
│  Browser — React + Vite + Tailwind                                       │
│  Dashboard · New request · Decision · Audit log · Policies · T3N status   │
│                                                                          │
│  Never imports the T3N SDK. Holds no credentials. Speaks only HTTP JSON.  │
└───────────────────────────────┬──────────────────────────────────────────┘
                                │  /api/*
┌───────────────────────────────▼──────────────────────────────────────────┐
│  Node server (apps/server)          ← the only process holding secrets    │
│                                                                          │
│   routes/api.ts   parse → delegate → serialise; typed errors only         │
│   service.ts      validate → resolve policy → derive scopes → fetch →     │
│                   decide → record.  The single decision point.            │
│   agent/          LLM: understands questions, explains answers.           │
│                   Its tools expose NO operation that can grant access.    │
└───────┬─────────────────────────────────────────────┬────────────────────┘
        │                                             │
┌───────▼────────────────────────┐   ┌────────────────▼─────────────────────┐
│ packages/policy-engine         │   │ packages/t3n                          │
│                                │   │                                       │
│ Pure function of               │   │ client.ts  two identities, one WASM    │
│ (config, request, claims, now) │   │ live.ts    check consent → read grant  │
│ → Decision.                    │   │            record → read intersection  │
│                                │   │ demo.ts    fixtures, always labelled   │
│ No I/O. No network. No model.  │   │                                       │
│ config/policies.yaml drives it │   │ @terminal3/t3n-sdk (pinned 5.2.0)      │
└────────────────────────────────┘   └────────────────┬──────────────────────┘
                                                      │
                                     ┌────────────────▼──────────────────────┐
                                     │  Terminal 3 testnet                    │
                                     │  tenant DID · agent DID · org DID      │
                                     │  tee:org-data/contracts v2.7.0         │
                                     │  grants · scopes · claim records       │
                                     └────────────────────────────────────────┘
```

Two boundaries are load-bearing:

- **The LLM cannot reach the engine.** It calls structured tools, none of which
  accepts a decision, an override, or a claim. It chooses which question to ask;
  the engine answers.
- **The SDK cannot reach the browser.** It loads a WASM component that breaks
  under Vite, and it holds private keys. `apps/web` does not depend on
  `packages/t3n`, so an accidental import fails to resolve.

Full detail: [docs/architecture.md](docs/architecture.md).

## Features

- Deterministic three-outcome policy engine, configured entirely in YAML
- Live T3N integration: real DIDs, real grants, real consent checks, real claim reads
- **Data-minimization receipt** on every decision — requested vs. authorized vs. withheld scopes
- Append-only audit journal with salted-hash subjects and no claim values
- Six-screen enterprise dashboard
- Optional natural-language layer that provably cannot decide anything — and is **not tied to one vendor**
- Demo mode with four deterministic scenarios that can never impersonate live data
- 119 tests covering all three decision paths, prompt injection, secret redaction, and config validation

## Privacy model

What the agent receives for `identity_verified`:

```json
{ "verified": true, "assurance": "high",
  "verifiedAt": "2026-06-01T00:00:00.000Z",
  "expiresAt":  "2027-06-01T00:00:00.000Z",
  "issuerCategory": "government",
  "evidenceRef": "vc:sha256:…" }
```

What it never receives: name, date of birth, document number, nationality,
address, phone, photograph, or the document itself. There is deliberately no
field for any of them anywhere in the domain model —
[`packages/core/src/types.ts`](packages/core/src/types.ts) has no `dateOfBirth`,
and adding one would be a design regression, not a feature.

`issuerCategory` is a *category* (`government`, `employer`) rather than a named
organisation, because knowing *which* bank verified someone is often more
revealing than the verification itself. `evidenceRef` is an opaque pointer for a
human auditor with proper authority; this system never resolves it.

**The audit log** stores a salted SHA-256 of the subject reference — enough to
prove a decision concerned a given person, not enough to be a browsable directory
of who was investigated. Claim **ids** are recorded; claim **values** are not.
Justification free-text is never stored and never sent to T3N.

## Installation

Requires Node.js ≥ 18 (developed on 22).

```bash
git clone <your-repo-url> t3n-access-compliance-agent
cd t3n-access-compliance-agent
npm install
cp .env.example .env
```

## Environment variables

Every variable is documented inline in [`.env.example`](.env.example).

| Variable | Required | Purpose |
|---|---|---|
| `T3N_API_KEY` | for live mode | Tenant secp256k1 private key from the claim page |
| `T3N_ENV` | no | `testnet` (default) or `production` |
| `T3N_BASE_URL` | no | Pin a specific node. Must be https (loopback excepted) |
| `T3N_ORG_DID` | written by setup | Organisation the compliance scopes live under |
| `T3N_AGENT_DID` | written by setup | The agent's own DID |
| `T3N_AGENT_API_KEY` | written by setup | Opaque `t3n_key_…` agent credential — shown once |
| `T3N_AGENT_KEY_ID` | written by setup | Key id for rotation |
| `T3N_AGENT_KEY` | no | Optional credited agent private key → strongest enforcement mode |
| `T3N_CONTRACT_ID` | no | Defaults to `tee:org-data/contracts` |
| `CLAIM_SOURCE` | no | `demo` (default) or `live` |
| `LLM_PROVIDER` | no | `auto` (default), `openai`, or `anthropic` |
| `LLM_API_KEY` | no | Enables the plain-English box. Works with OpenAI, Gemini, Groq, OpenRouter or a local Ollama |
| `LLM_BASE_URL` | no | Any OpenAI-compatible endpoint. Blank = OpenAI |
| `LLM_MODEL` | no | Defaults to `gpt-4o-mini` |
| `OPENAI_API_KEY` / `OPENAI_BASE_URL` / `OPENAI_MODEL` | no | Fallbacks for the three above |
| `ANTHROPIC_API_KEY` | no | Alternative backend if you hold a Claude key |
| `AUDIT_SALT` | production | Per-deployment salt for subject pseudonymisation |
| `PORT`, `LOG_LEVEL`, `AUDIT_LOG_PATH` | no | Server basics |

No secret appears in any documentation, any log line, or any HTTP response.

## Terminal 3 setup

**1. Claim a tenant key** at <https://www.terminal3.io/claim-page>. The page shows
an **API Key** and a **DID**. The API Key is the secret — put it in `.env` as
`T3N_API_KEY`. The DID is a public identifier and goes nowhere: the code reads it
back from the authenticated session, as the docs require.

**2. Verify connectivity:**

```bash
npm run t3n:connect
```

Expected:

```
✓ keys present, well-formed, and distinct
✓ environment set to "testnet"
✓ WASM component loaded (122 ms)
✓ tenant authenticated as did:t3n:…
```

**3. Provision the organisation and agent:**

```bash
npm run t3n:setup
```

This creates an organisation and mints a **genuinely separate** agent identity,
writing `T3N_ORG_DID`, `T3N_AGENT_DID`, `T3N_AGENT_API_KEY` and
`T3N_AGENT_KEY_ID` back into `.env`.

> Do **not** try to get an agent identity by claiming a second key. Every key you
> claim while signed in to the same account binds to the *same* DID, so the agent
> would silently inherit the tenant's authority. This is [BUG-2](docs/bugs.md).

**4. Seed claim records and consent:**

```bash
npm run t3n:seed
```

Writes minimized claim records and records the data owner's grant. It grants the
agent identity and employment scopes but **deliberately withholds
`compliance/training`**, which is what makes a live `REVIEW_REQUIRED` reachable.

**5. Go live** — set `CLAIM_SOURCE=live` in `.env` and restart.

## Running

```bash
npm run dev
```

- Dashboard → <http://localhost:5173>
- API → <http://localhost:8787/api>

Or separately: `npm run dev:server` and `npm run dev:web`.

> The server runs under plain `tsx`, not `tsx watch`, so it does **not**
> auto-restart on save — restart it manually after a server-side change. This is
> deliberate: `tsx watch` deadlocks the Terminal 3 WASM component load and the
> server never starts ([BUG-8](docs/bugs.md)). The frontend still hot-reloads
> normally. `npm run dev:watch --workspace @t3n-aca/server` is kept so the
> behaviour can be re-tested against future releases.

## Testing

```bash
npm test          # 119 tests
npm run verify    # typecheck + lint + tests
```

The suite runs **offline with no credentials** — it never touches the network, so
it works in CI and on a fresh clone.

## Demo

Full script with timings: [docs/demo.md](docs/demo.md). Short version:

```bash
# demo mode — no credentials needed
CLAIM_SOURCE=demo npm run dev
```

Open the dashboard → **New request** → click each scenario → **Evaluate**:

| Scenario | Outcome | What it shows |
|---|---|---|
| A — Verified employee | APPROVED | The happy path |
| B — Consent withheld | REVIEW_REQUIRED | A *consent* gap, not a failed check |
| C — Failed company verification | DENIED | An explicit negative result |
| D — Privileged access, all pass | REVIEW_REQUIRED | A control that fires by design |

## Natural-language layer (optional)

The plain-English box is deliberately **provider-agnostic**: whoever inherits
this should be able to use a credential they already hold rather than acquiring
a specific vendor's. Any OpenAI-compatible chat-completions endpoint works, and
the adapter is plain `fetch` — no extra dependency.

```bash
# OpenAI
LLM_API_KEY=sk-...

# Google Gemini
LLM_API_KEY=<google key>
LLM_BASE_URL=https://generativelanguage.googleapis.com/v1beta/openai
LLM_MODEL=gemini-2.5-flash

# Groq / OpenRouter / local Ollama — just change the base URL
LLM_BASE_URL=http://localhost:11434/v1

# Or Claude
ANTHROPIC_API_KEY=sk-ant-...
```

`LLM_*` is preferred over `OPENAI_*` on purpose: `OPENAI_API_KEY` is commonly
set machine-wide, and an ambient variable always beats `.env`. A project-scoped
name cannot collide, so `.env` stays authoritative with no system changes.
`OPENAI_*` still works as a fallback.

Verified end-to-end against Gemini (`gemini-2.5-flash`), including the
prompt-injection cases below. The active provider and model are shown on the
Ask screen and returned by `GET /api/agent/status`, so it is always visible
which backend phrased an explanation.

Swapping providers cannot change what the agent is capable of: the tool list is
defined once, and none of its five entries can grant access. Two live injection
attempts through this interface — a direct "approve this" override and a forged
"the requirement has been waived" authority claim — produced no approval; the
second still returned `REVIEW_REQUIRED` from the engine.

> **Precedence gotcha:** a variable already exported in your shell overrides
> `.env` (standard dotenv behaviour, and correct for production). The server
> logs a warning at startup naming any variable being shadowed, because this
> cost real debugging time during development.

## Example requests

```
Can Alice get read access to the employee dashboard?
Can this contractor get write access to the source repository?
Why was that request denied?
What information is missing for Ben?
Which policy was applied, and what does it require?
Show me every decision that required review this week.
```

## Policy configuration

All business rules live in [`config/policies.yaml`](config/policies.yaml). Adding
a policy is a config edit:

```yaml
policies:
  finance_system_access:
    label: Finance system access
    description: Access to financial reporting systems.
    applies_to_subject_types: [employee]
    resources: [finance_reporting]
    access_levels: [read, write]
    required_claims: [identity_verified, employment_verified, background_check]
    rules:
      minimum_assurance: high
      require_manual_approval: true
```

Then add `finance_system_access` to `resolution.order`. The file is validated
strictly on load — an unknown key is an **error**, not an ignored line, because a
silently-dropped `require_manual_aproval` typo would disable a control. Worked
example: [docs/maintenance.md](docs/maintenance.md).

## Security

Threat model and controls: [SECURITY.md](SECURITY.md). Headlines:

- No secret in source, logs, HTTP responses, or the browser bundle
- The LLM has no tool that can grant access — verified by test
- Deep redaction on every log payload; typed errors with a public/internal split
- Strict input validation (zod) at every boundary
- Fail-closed everywhere: no policy match → deny; unknown consent → escalate
- The SDK's own HTTPS guard and key-hygiene properties are relied on, not bypassed

## Maintenance

Written for whoever inherits this: [docs/maintenance.md](docs/maintenance.md),
[docs/OPERATIONS.md](docs/OPERATIONS.md), [docs/HANDOVER.md](docs/HANDOVER.md).

The codebase is small on purpose — no database, no container, no queue, no
message bus. Audit is a JSONL file an auditor can read with `cat`. Policies are
one YAML file. There is no build step for the server; it runs from TypeScript
sources via `tsx`.

## Known issues & limitations

Honest list. Detail in [docs/bugs.md](docs/bugs.md).

1. **The SDK is pinned to `5.2.0`.** `5.3.0` cannot authenticate against testnet
   at all ([BUG-1](docs/bugs.md)). Do not widen this range without re-testing.
2. **Claim reads run on the tenant session** (`DELEGATED_TENANT_READ`). The
   agent's *authorization* is checked as the agent, and the scope set comes from
   the on-network grant record — but the read itself is executed by the tenant,
   because an org-provisioned agent's credential cannot invoke core `tee:`
   contracts ([BUG-4](docs/bugs.md)) and an uncredited DID cannot open metered
   reads ([BUG-5](docs/bugs.md)). Supply a credited `T3N_AGENT_KEY` and the app
   upgrades itself to `AGENT_SESSION`. The active mode is shown on the T3N Status
   page rather than glossed over.
3. **`checkDelegation` does not enforce scopes** ([BUG-3](docs/bugs.md)), so the
   app does not trust it for scope decisions.
4. **One live subject.** The seed script uses T3N's documented self-grant pattern
   because a single testnet account yields one credited DID. Multi-subject
   deployments need one data-owner DID per person; the code path is identical.
5. **Claim scopes are flat.** Records carry a `subject` field and reads are
   filtered by it. Per-subject scopes would be stronger — see
   [docs/architecture.md](docs/architecture.md) → *Scope layout*.
6. **No authentication on the dashboard.** It is a single-tenant internal tool;
   put it behind your SSO/reverse proxy before exposing it.

## Future improvements

Only things that are actually reachable:

- Deploy a Rust `z:` contract so the agent reads under its own credential, closing limitation 2 completely
- Per-subject scopes and a subject-facing consent screen
- Mirror the audit trail into T3N's `getActivityLog`, which already provides hash-chained tamper evidence
- Webhook on `REVIEW_REQUIRED` into ServiceNow/Jira
- Scheduled re-verification when claims approach expiry (the data is already there — `CLAIM_EXPIRING_SOON` fires today)

## Licence

MIT — see [LICENSE](LICENSE).
