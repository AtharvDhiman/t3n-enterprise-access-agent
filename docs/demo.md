# Demo script (3–5 minutes)

Two ways to run it. **Demo mode** needs no credentials and is fully
deterministic — use it if anything is uncertain. **Live mode** proves the
Terminal 3 integration is real. The strongest demo uses live mode for the first
half and demo mode for the four decision paths.

## Before you start

```bash
npm install
npm run dev          # dashboard :5173, API :8787
```

For live mode also: `npm run t3n:connect`, `npm run t3n:setup`,
`npm run t3n:seed`, then set `CLAIM_SOURCE=live` and restart.

Have the dashboard open at <http://localhost:5173>.

---

## 0:00 — The problem (30s)

> "A contractor needs repository access. Today someone emails a passport scan. It
> ends up in a ticketing system, a shared inbox, a Slack thread, and a compliance
> spreadsheet. Four teams now hold a document that answers exactly one question —
> is this person who they say they are — and that answer is one bit.
>
> Six months later an auditor asks *why* access was granted, and nobody can
> reconstruct it. Pointing an LLM at this makes it worse: now a model sees the
> passport, and a model's judgement isn't auditable."

---

## 0:30 — Terminal 3 is really connected (45s)

Open **T3N status**.

> "This is live Terminal 3 testnet. Two separate identities: the tenant — the
> enterprise — and the agent, which has its own DID, its own credential, and its
> own agent card hosted by T3N.
>
> That separation is the point. The agent being authenticated grants it nothing.
> The data owner has to separately sign a grant naming this agent DID, exactly
> which functions, and exactly which scopes."

Point at **Enforcement mode**.

> "And we're explicit about how it's enforced, including where the current
> testnet limits bite. That's on the screen rather than buried."

---

## 1:15 — A decision, and what it did *not* read (60s)

**New request** → **Use this subject** (live) → resource `employee_dashboard`,
level `read` → **Evaluate**.

> "Approved. Policy applied, both requirements satisfied at high assurance."

Scroll to **What the agent was allowed to see**.

> "This is the part that matters. The policy needed two scopes. Consent covered
> both. The agent read two claims — verification *outcomes*.
>
> It never received a date of birth, a document number, or an address. There's no
> field for them anywhere in the system. The passport never left the subject's
> control."

---

## 2:15 — The same subject, a stricter policy (45s)

Change resource to `production_database`, level `admin` → **Evaluate**.

> "Review required — and look at *why*."

Point at the withheld scopes.

> "The privileged policy needs security training and a background check. The
> subject consented to identity and employment, but not those. So the agent
> couldn't see them — and it didn't guess.
>
> Critically, it didn't read those scopes and get nothing. It was never permitted
> to look. Before consent, Terminal 3's own delegation check returns
> `authorised: false, disclosed: false` — no data, and no inference about data.
>
> The next action tells the operator exactly which consent to request."

---

## 3:00 — All three outcomes (60s)

Switch to demo mode if you want the full set (`CLAIM_SOURCE=demo`, restart), then
click through the scenarios:

- **A — Verified employee** → **APPROVED**
- **B — Consent withheld** → **REVIEW_REQUIRED**

> "Note this is a *consent* gap, not a failed check."

- **C — Failed company verification** → **DENIED**

> "Here we did check, and it failed. That's an explicit negative result, so the
> policy denies rather than escalating.
>
> That distinction — 'we checked and it's false' versus 'we weren't allowed to
> look' — is deliberate. Collapse them and you either deny people over paperwork
> gaps or approve them on evidence you never saw."

- **D — Privileged access, all checks pass** → **REVIEW_REQUIRED**

> "Everything passed, and it still escalates: this policy always requires a named
> human approver. A control that fires by design.
>
> And notice the banner — these four say **DEMO DATA**. The earlier ones said
> **LIVE T3N**. Demo data can never present itself as real; that's enforced in
> the engine and stamped permanently into the audit record."

---

## 4:00 — Audit and maintenance (45s)

Open **Audit log**, expand a row.

> "Every decision, permanently recorded, filterable. Enough to answer 'why did
> the agent decide this?' years later: policy, requirements, what was missing,
> risk flags, the action taken.
>
> The subject is a salted hash — enough to prove a decision concerned a given
> person, not enough to be a browsable list of who was investigated. Claim ids
> are recorded; claim values never are."

Open **Policies**.

> "All the business rules live in one YAML file. Adding a policy or changing an
> assurance threshold is a config edit, not a code change — validated strictly on
> load, so a typo fails at startup rather than silently disabling a control.
>
> No database, no container, no queue. The audit log is a file you can read with
> `cat`. 204 tests, all offline."

---

## 4:45 — Close (15s)

> "Terminal 3 isn't decoration here. It's what makes the agent's authority
> narrower than the enterprise's, revocable by the person the data is about, and
> checkable *before* anything is disclosed.
>
> The enterprise gets a defensible decision. The person keeps their documents."

---

## If something goes wrong

- **Live mode failing?** Switch to `CLAIM_SOURCE=demo` and restart — all four
  scenarios work with no credentials. Say plainly that you're showing demo data;
  the UI already does.
- **T3N shows disconnected?** Open T3N Status; it names the reason. `npm run
  t3n:connect` separates a platform problem from an app problem.
- **Demo scenario refused in live mode?** Expected — the error says so. Demo
  fixture ids aren't DIDs.

## Screenshot checklist

1. **Dashboard** — stats, connection card, LIVE/DEMO badges in recent decisions
2. **New request** — the four scenario cards
3. **APPROVED** — banner + requirements + data-access receipt
4. **REVIEW_REQUIRED** — the withheld-scopes panel (the strongest single image)
5. **DENIED** — banner + `FAILED_VERIFICATION` flag
6. **Audit log** — a row expanded, showing the salted subject hash
7. **Policies** — claim vocabulary with the claim → scope mapping
8. **T3N status** — both DIDs, org, enforcement mode
