# Changelog

Format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/);
versioning follows [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [1.0.0] — 2026-08-29

First release. Built for the Terminal 3 ADK challenge.

### Added

- **Deterministic policy engine** — pure function of (config, request, claims, clock).
  Three outcomes: `APPROVED`, `REVIEW_REQUIRED`, `DENIED`. All rules in
  `config/policies.yaml`, validated strictly on load.
- **Live Terminal 3 integration** — tenant and agent identities, organisation
  provisioning via `createAgent`, consent recorded with `agentAuthUpdate`,
  authorization checked with `checkDelegation`, claim records in
  `tee:org-data/contracts` scopes.
- **Data-minimization receipt** on every decision: scopes requested vs.
  authorized vs. withheld, and the number of claims actually read.
- **Enforcement-mode detection** — the app probes what the platform permits and
  reports `AGENT_SESSION` or `DELEGATED_TENANT_READ` honestly rather than
  claiming a guarantee it cannot deliver.
- **Append-only audit journal** (JSONL) with salted-hash subjects, claim ids
  only, and no claim values or free text.
- **Enterprise dashboard** (React + Vite + Tailwind + lucide): Dashboard, New
  request, Audit log, Policies, T3N status, Ask.
- **Optional, provider-agnostic natural-language layer** whose tool surface
  exposes no operation capable of granting access. Works with any
  OpenAI-compatible endpoint (OpenAI, Google Gemini, Groq, OpenRouter, local
  Ollama) or Anthropic, selected automatically from whichever key is present.
  Verified end-to-end against Gemini, including live prompt-injection attempts.
- **Demo mode** with four deterministic scenarios, permanently labelled
  `DEMO DATA` and structurally unable to impersonate live data.
- **102 tests** covering all three decision paths, prompt injection, secret
  redaction, config validation, and the HTTP API. Runs offline.
- Operational scripts: `t3n:connect`, `t3n:setup`, `t3n:seed`.
- Documentation: architecture, maintenance, deployment, operations, handover,
  demo script, security threat model, and eight reproduced platform bug reports.

### Fixed during development

- Demo fixtures were anchored to a fixed past epoch, so scenario D silently
  decayed from `REVIEW_REQUIRED` to `DENIED` as its claim expired. Fixtures are
  now anchored to the current UTC day.
- The agent-credential validator rejected every real credential by disallowing
  the `.` separator in `t3n_key_<keyId>.<secret>`.
- A demo fixture id submitted in live mode surfaced an opaque HTTP 400 that
  misattributed the cause to the agent key. Live mode now validates the subject
  reference before any network call.
- The log redactor over-redacted `scopesAuthorized`, removing exactly the field
  needed to diagnose consent problems.
- **`npm start` and `npm run dev` were broken.** npm runs a workspace script
  with cwd set to the workspace, so `config/policies.yaml` and `.env` resolved
  under `apps/server/`. Both are now resolved from the detected project root
  (`apps/server/src/paths.ts`), so the server works from any launch directory.
- **The dev server hung on startup** under `tsx watch`, which deadlocks the
  Terminal 3 WASM component load. The `dev` script now uses plain `tsx`; see
  `docs/bugs.md` BUG-8.
- A React `key` warning from the audit table: the fragment wrapping each row is
  the array element, so the key belonged there rather than on the inner `<tr>`.
- Provenance badges and decision chips wrapped onto two lines in narrow table
  columns.
- The natural-language layer was hard-wired to Anthropic, so a team without that
  specific credential could not use it at all. It is now provider-agnostic.
- A variable exported in the shell silently overrode `.env` (standard dotenv
  precedence), which sent an OpenAI key to Google and surfaced only as a bare
  HTTP 400. The server now warns at startup naming any shadowed variable, and
  flags an obvious key/endpoint mismatch.

### Known issues

- Pinned to `@terminal3/t3n-sdk@5.2.0`: version 5.3.0 cannot authenticate against
  testnet at all. See `docs/bugs.md` BUG-1.
- Default enforcement mode is `DELEGATED_TENANT_READ` because of platform
  constraints documented as BUG-4 and BUG-5.
- `checkDelegation` does not enforce the `scopes` parameter (BUG-3), so scope
  decisions are taken from the on-network grant record instead.
