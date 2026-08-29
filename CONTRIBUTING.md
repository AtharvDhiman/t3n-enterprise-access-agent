# Contributing

## Setup

```bash
npm install
cp .env.example .env
npm run dev          # demo mode works with no credentials
```

## Before every commit

```bash
npm run verify       # typecheck + lint + 97 tests
```

CI runs the same command. The suite is offline and needs no credentials, so
there is no reason for it not to pass locally first.

## Where things go

| Change | Location |
|---|---|
| A business rule (policy, threshold, resource) | `config/policies.yaml` — **not code** |
| Decision logic | `packages/policy-engine/src/evaluate.ts` |
| Terminal 3 interaction | `packages/t3n/` — nowhere else |
| Shared types, errors, redaction, audit | `packages/core/` |
| HTTP surface | `apps/server/src/routes/` |
| UI | `apps/web/src/` |

## Invariants — please do not break these

These are the properties the project exists to provide. A change that violates
one is not a trade-off; it is a defect.

1. **The policy engine stays pure.** `evaluate()` takes (config, request,
   claims, clock) and returns a decision. No I/O, no network, no model, no
   `Date.now()` — the clock is injected so behaviour is reproducible.

2. **The LLM cannot decide.** No tool may accept a decision, an override, or a
   claim. If you add a tool, add a test asserting it cannot grant access.

3. **The T3N SDK never reaches the browser.** `apps/web` must not depend on
   `@t3n-aca/t3n`. The SDK's WASM component breaks under Vite and it handles
   private keys. Response types in `apps/web/src/lib/api.ts` are hand-written
   duplicates for this reason — keep them that way.

4. **Demo data can never look live.** Any new claim source must report a truthful
   `ClaimSourceKind`, and no code path may fall back from live to fixtures.

5. **No personal data in the domain model.** There is no `dateOfBirth`, no
   `address`, no `documentNumber` anywhere, and adding one is a design
   regression. Claims are outcomes plus provenance.

6. **The audit log stores no raw subject and no claim values.** Subjects are
   salted hashes; claim ids only.

7. **Secrets never leave the server.** Not in a response, not in a log, not in a
   `VITE_` variable. Route errors through `AppError.toPublicJSON()`.

8. **Fail closed.** No matching policy → deny. Unknown consent → escalate. Never
   convert a source failure into "no claims".

## Style

- TypeScript strict mode, ES modules, `.ts` extensions in relative imports.
- Small modules; avoid files that do several unrelated things.
- Comments explain **why**, not what. If a line's rationale is non-obvious —
  especially a security or privacy decision — say so.
- No new dependency without a clear reason. The dependency list is short
  deliberately, and "maintainable by someone else" is a design goal.

## Tests

Add a test with any behaviour change. In particular:

- A new decision path → a case in `tests/policy-engine.test.ts`
- A new tool → a case in `tests/service.test.ts` asserting it cannot grant access
- A new endpoint → a case in `tests/api.test.ts`
- Anything touching secrets, redaction, or the audit record → `tests/security.test.ts`

Tests must not require network access or credentials.

## Changing policies

`config/policies.yaml` is validated strictly: an unknown key is an error, not an
ignored line, because a silently-dropped `require_manual_aproval` typo would
disable a control. Run `npm test` after editing — the config tests parse the real
file and name the offending path.

## Reporting Terminal 3 issues

Platform issues go in [docs/bugs.md](docs/bugs.md), with: environment, SDK
version, reproduction steps, expected vs. actual, severity, workaround, and
whether it blocks functionality. Only document what you actually reproduced.

Report upstream via <devrel@terminal3.io> or the
[developer Telegram](https://t.me/terminal3developer).
