# Screenshots

Save the eight images here with **exactly these filenames** — the main
[README](../../README.md) references them by name, and GitHub will render them
inline on the repository landing page.

| Filename | What to capture |
|---|---|
| `01-dashboard.png` | Dashboard — stat tiles, Terminal 3 connection card, and recent decisions showing both `LIVE T3N` and `DEMO DATA` badges |
| `02-new-request.png` | New access request — the four scenario cards and the request form |
| `03-approved.png` | An APPROVED result — banner, requirements, and the data-access receipt |
| `04-review-required.png` | A REVIEW_REQUIRED result — **must include the "What the agent was allowed to see" panel** with a non-empty *Withheld* column |
| `05-denied.png` | A DENIED result — banner plus the `FAILED_VERIFICATION` risk flag |
| `06-audit-log.png` | Audit log with one row expanded, showing `SUBJECT (SALTED HASH)` |
| `07-policies.png` | Policies — the four policies and the claim → scope vocabulary table |
| `08-t3n-status.png` | T3N status — both DIDs, the organisation, and the enforcement mode |

## Which one matters most

`04-review-required.png` is the single most important image in the repository.
It is the only one that shows the whole argument at once: the policy asked for
four scopes, consent covered two, the agent read two claims, and it named the
missing consent instead of guessing.

If you capture nothing else, capture that one.

## Capturing them

```bash
npm run dev     # dashboard on http://localhost:5173
```

Use `CLAIM_SOURCE=demo` if you want all four scenarios reachable in one click;
use `live` for screenshots that carry the `LIVE T3N` badge. A mix of both across
the eight images is ideal — it demonstrates that the distinction is real.

Full-window captures at roughly 1400px wide read well on GitHub. PNG, and keep
each under about 500 KB so the page stays fast.
