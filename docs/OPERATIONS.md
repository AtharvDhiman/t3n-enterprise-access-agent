# Operations

Running this after launch. Assumes it is deployed per
[deployment.md](deployment.md).

## Daily / weekly

| Cadence | Check | Where |
|---|---|---|
| Continuous | Liveness | `GET /api/health` |
| Continuous | T3N connection state | `GET /api/t3n/status` → `state` |
| Weekly | Credit balance | T3N Status page → tenant credits |
| Weekly | Decision mix | Dashboard tiles |
| Weekly | `CLAIM_EXPIRING_SOON` flags | Audit log filter |
| Monthly | Grant validity windows | `getAgentAuth()` → `validUntilSecs` |
| Monthly | Journal size | `ls -lh $AUDIT_LOG_PATH` |

## Monitoring

Alert on:

- `GET /api/health` non-200 → **page**
- `/api/t3n/status` `state !== "connected"` for > 10 min → **warn**
- Tenant credit balance below your threshold → **warn** (writes fail at zero)
- `enforcementMode === "UNAVAILABLE"` while `CLAIM_SOURCE=live` → **warn**
- Log lines with `"level":"error"` → **warn**

Logs are JSON lines, one per event, already redacted:

```json
{"ts":"…","level":"info","scope":"service","msg":"decision recorded",
 "meta":{"auditId":"aud_…","decision":"APPROVED","policy":"employee_access",
         "source":"LIVE_T3N","scopesRequested":2,"scopesAuthorized":2}}
```

A useful signal: `scopesRequested > scopesAuthorized` sustained across many
subjects usually means a consent-collection problem, not an evidence problem.

## Credits

Terminal 3 operations are metered. Reads are cheap; writes (`setWriters`,
`writeData`, `setGrants`, `agentAuthUpdate`, `createAgent`) cost more. Building
and testing this project consumed roughly 1,300 of 20,000 test credits.

When the balance runs low: claim a fresh key from the claim page. Because a
re-claimed key binds to the **same DID** ([BUG-2](bugs.md)), credits land on the
existing account and no re-provisioning is needed. Update `T3N_API_KEY` and
restart.

At zero balance, reads fail with `InsufficientCreditError` and the status page
shows the connection degraded.

## Managing policies

Policies live in `config/policies.yaml`, in git.

```bash
# 1. edit config/policies.yaml
npm test                       # validates the real file + all decision paths
git commit -am "policy: require background check for finance access"
# 2. deploy, then:
sudo systemctl restart t3n-aca
curl -s localhost:8787/api/policies | head
```

The server **exits** on an invalid policy file, so a bad change fails at restart
rather than at the first request. Keep the previous revision handy; rollback is
`git revert` plus a restart.

Policy changes are not retroactive: past decisions were made under the version
recorded in their audit record (`policyVersion`). Bump `version:` in the file
whenever you change rules, so the audit trail stays interpretable.

## Managing consent

Consent is held on Terminal 3, not here.

**Grant** — the data owner signs:

```ts
await t3n.agentAuthUpdate({ agents: [{ agentDid, scripts: [{
  scriptName: "tee:org-data/contracts",
  functions: ["org-data-get", "org-data-list"],
  scopes: ["compliance/identity"], readScopes: ["compliance/identity"],
  allowedHosts: [],
}]}]});
```

**Inspect** — `await t3n.getAgentAuth()` returns the current policy including the
validity window.

**Revoke** — remove the agent entry and re-submit, or let the window lapse. The
next evaluation reads the updated grant record, so revocation is effective
immediately with no restart and no key change.

Grants carry an automatic ~90-day window. Diary a renewal, or evaluations will
start returning `REVIEW_REQUIRED` for consent reasons when it lapses — which is
correct behaviour, but surprising if unexpected.

## Audit journal

Append-only JSONL at `AUDIT_LOG_PATH`. Readable directly:

```bash
tail -5 /var/lib/t3n-aca/audit.jsonl | jq .
jq -r 'select(.decision=="DENIED") | [.timestamp,.policyId,.resource] | @tsv' audit.jsonl
```

**Rotation.** Do not use logrotate's `copytruncate` — it can interleave with an
in-flight append. Rotate on a restart boundary:

```bash
sudo systemctl stop t3n-aca
mv audit.jsonl audit-$(date +%Y%m).jsonl
sudo systemctl start t3n-aca
```

The in-memory mirror is rebuilt from the file at startup, so the dashboard shows
the current journal only. Keep archives for reporting.

**Retention** is your policy decision. The journal contains no personal data by
construction, so retention is driven by compliance requirements rather than
privacy limits.

**Never edit it.** Append-only is the property that makes it evidence.

## Secret rotation

See [maintenance.md → Rotating secrets](maintenance.md) for the mechanics.
Operationally:

| Secret | Cadence | Disruption |
|---|---|---|
| `T3N_API_KEY` | on suspicion, or per policy | None — same DID, grants survive |
| `T3N_AGENT_API_KEY` | on suspicion | Re-provision agent + re-issue grants |
| `AUDIT_SALT` | never after first record | Requires journal changeover |
| `ANTHROPIC_API_KEY` | per policy | NL layer only |

## Incident response

**Terminal 3 unreachable.** The server stays up by design. Live evaluations fail
with a typed error rather than falling back to fixtures. Check
<https://status.terminal3.io/>, then `npm run t3n:connect` to separate a platform
problem from ours. Do **not** switch to `CLAIM_SOURCE=demo` to "keep things
working" — that substitutes fictional evidence for real evidence. Pause access
decisions instead.

**Wrong decisions suspected.** Every decision is reproducible: take the audit
record's `policyId`, `policyVersion` and `claimsUsed`, check out that policy
revision, and re-run. Because the engine is a pure function with an injected
clock, you will get the same answer.

**Agent credential compromised.** Follow [SECURITY.md](../SECURITY.md). Blast
radius is bounded to what data owners granted, and grants are time-boxed.

**Disk full.** Appends fail with `AUDIT_WRITE_FAILED` and the decision returns a
500 — deliberately, since a decision that could not be recorded should not be
reported as made. Free space and retry.

## Routine tasks

```bash
# who are we, right now
curl -s localhost:8787/api/t3n/status | jq '{state,environment,enforcementMode,orgDid}'

# this week's decisions by outcome
curl -s 'localhost:8787/api/audit?limit=200' | jq -r '.records[].decision' | sort | uniq -c

# what a policy currently requires
curl -s localhost:8787/api/policies | jq '.policies[] | select(.id=="privileged_access")'

# re-verify the platform connection end to end
npm run t3n:connect
```
