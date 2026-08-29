# Security

## Reporting a vulnerability

Open a private security advisory on the repository, or email the maintainer.
Please do not open a public issue for anything exploitable.

For issues in Terminal 3 itself: <devrel@terminal3.io> or the
[developer Telegram](https://t.me/terminal3developer). Platform issues found
while building this are documented in [docs/bugs.md](docs/bugs.md).

---

## Threat model

### What we are protecting

1. **Subject personal data** — the whole point. The system is designed so that
   the data it would be most damaging to leak is never in it.
2. **Credentials** — a T3N API key *is* a secp256k1 private key. The agent
   credential is a bearer token.
3. **Decision integrity** — no path may produce `APPROVED` other than the
   deterministic engine on satisfied requirements.
4. **The audit trail** — must remain a truthful, append-only record.

### Who we are protecting against

| Adversary | Capability | Primary control |
|---|---|---|
| Malicious requester | Submits crafted requests through the UI or API | Strict schema validation; no free text reaches the engine |
| Prompt injector | Controls text the LLM will read (subject names, justifications, resource strings) | The LLM has no tool that can grant access; the engine takes no natural-language input |
| Curious insider | Can read the audit log | Salted-hash subjects; claim ids only, never values |
| Network attacker | Intercepts traffic to the T3N node | SDK's HTTPS guard; operator-signed, pinned trust anchor |
| Compromised agent key | Holds the agent credential | Agent authority is exactly what data owners granted; revocable without a key change; time-boxed |
| Log scraper | Reads server logs or error responses | Deep redaction; public/internal error split |

### Explicitly out of scope

- **Dashboard authentication.** There is none. This is a single-tenant internal
  tool; put it behind SSO or a reverse proxy before exposing it. See
  [docs/deployment.md](docs/deployment.md).
- **Denial of service.** No rate limiting is implemented; terminate at your
  ingress.
- **Physical/host compromise.** A `.env` reader has the keys. Use a secret
  manager in production.

---

## Controls

### Secrets

- No secret in source, in documentation, or in any committed file.
- `.env` is git-ignored; `.env.example` contains only placeholders.
- Credentials are read **server-side only**. `apps/web` does not depend on
  `packages/t3n`, so the SDK and its credentials cannot enter the browser bundle
  — an accidental import fails to resolve.
- **No `VITE_`-prefixed secret exists.** Anything so prefixed is public by
  definition in a Vite build.
- Every log payload passes `redact()`, which masks values by key name and scans
  free text for private-key-shaped strings.
- Configuration distinguishes *absent* from *placeholder* from *malformed*, so an
  unedited `.env.example` copy is reported as "not filled in" rather than
  producing a confusing auth failure.
- A `T3N_AGENT_KEY` identical to `T3N_API_KEY` is **ignored with a warning** —
  accepting it would silently give the agent the tenant's full authority.

### Decision integrity

- `PolicyEngine.evaluate()` is pure: `(config, request, claimSet, now) → Decision`.
  No I/O, no network, no model.
- The LLM's five tools accept no decision, no override, and no claim. There is no
  `approve_request`. Asserted by test.
- The API ignores unknown body fields; sending `{"decision":"APPROVED"}` changes
  nothing (tested).
- Fail-closed throughout: no matching policy → `DENIED`; unknown consent →
  `REVIEW_REQUIRED`; a claim source error propagates rather than degrading to
  "no claims", which would look identical to "no evidence" and could turn an
  outage into a stream of denials.

### Prompt injection

The engine takes no natural-language input, so injected text arrives as an
identifier and is looked up like any other. The suite runs seven injection
strings through both `subjectRef` and `justification` and asserts none yields
`APPROVED`.

The system prompt also instructs the model to treat such text as data and to
never state a decision it did not receive from a tool — but that is
defence-in-depth, not the control. The control is that the capability is absent.

### Data minimization

- The domain model has **no field** for a date of birth, address, document
  number, or photograph. Adding one is a design regression.
- Scopes are derived from the resolved policy *before* the subject is passed to
  any source, so no input can widen what is read.
- What may actually be read is bounded by the **on-network grant record**, read
  fresh each evaluation — so revocation takes effect immediately.
- Consent is checked *before* reading. An unauthorized request discloses nothing:
  verified live, `checkDelegation` returns `disclosed: false` before a grant.
- `issuerCategory` is a category, not a named organisation.

### Audit

- Append-only JSONL. Subject stored as salted SHA-256; the raw reference and the
  display label are never written (tested).
- Claim **ids** recorded; values, assurance levels and verification dates are not.
- Justification free-text is never stored and never sent to T3N.
- `AUDIT_SALT` is per-deployment, so journals from different deployments are not
  cross-linkable.

### Transport & input

- The SDK refuses to relay a credential over plain HTTP (loopback excepted); our
  config validates `T3N_BASE_URL` the same way rather than bypassing it.
- The trust anchor is operator-signed and verified against a key pinned in the
  SDK. We never construct one by hand — doing so would defeat node attestation.
- All request bodies and query strings are zod-validated. JSON body limit 128 kB.
- `x-powered-by` disabled. No CORS middleware — the API is same-origin in
  production.

### Errors

`AppError` carries a `publicMessage` (browser-safe) and an `internal` payload
(server logs only). Routes serialise `toPublicJSON()` and nothing else, keeping
node URLs, upstream bodies, and key material out of responses (tested).

---

## Deliberate non-controls

Things a reviewer might expect, with the reason they are absent:

- **No encryption of the audit file at rest.** It contains no personal data by
  construction. Use disk encryption if your environment requires it.
- **No signature on audit records.** The file is append-only and
  operator-controlled. T3N's `getActivityLog` already provides hash-chained
  tamper evidence and is the right place to mirror this — listed under future
  improvements rather than half-implemented.
- **No rate limiting.** Belongs at ingress, not in application code.

---

## If a credential is compromised

1. **Agent credential** — clear `T3N_AGENT_API_KEY` / `T3N_AGENT_DID`, run
   `npm run t3n:setup` to mint a new agent, `npm run t3n:seed` to re-issue
   grants, and have data owners remove grants naming the retired DID. The blast
   radius is bounded: exactly what was granted, and grants are time-boxed.
2. **Tenant key** — claim a new key and update `T3N_API_KEY`. It binds to the
   same DID, so org ownership and grants survive.
3. **Both** — review the audit journal and T3N's activity log for the exposure
   window.

Full procedures: [docs/OPERATIONS.md](docs/OPERATIONS.md).
