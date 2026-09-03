# Message to send Terminal 3 directly

The listing scores **bug submission quality**, and it names a Telegram contact
([@wardumb](https://t.me/wardumb)) plus <devrel@terminal3.io>. Sending the
findings directly — rather than only burying them in a repo — does two things:
it gets a blocking issue in front of the people who can fix it, and it puts your
name next to a genuinely useful contribution before judging.

BUG-1 in particular is affecting **every developer on their platform right now**.
The latest published SDK cannot authenticate against testnet at all. Anyone
starting the quickstart today hits it and probably assumes they did something
wrong.

Send the short version on Telegram, and the full version by email.

---

## Telegram — short

> Hi Ian — submitted for the T3N agent bounty (DID `did:t3n:2eaed84a2d5d72c2f8a19f1a832e8d63d96a9e5a`).
>
> Flagging one thing separately because I think it's affecting everyone right now: **SDK 5.3.0 can't authenticate against testnet at all.** `fetchTrustedManifest("testnet")` throws "Trust manifest … is malformed", and since `trustAnchor` is required by `T3nClient`, handshake never happens — so the quickstart dead-ends on step 3.
>
> Cause: 5.3.0's `TrustAnchor` requires `rtmr1_allowlist`, but `GET /api/trust-manifest` on the testnet node doesn't return that field. It only returns `rtmr3_allowlist`.
>
> I bisected it against the live endpoint: 5.3.0 fails, and 5.2.0 / 5.1.0 / 5.0.0 / 4.46.0 all work. Pinning 5.2.0 unblocked me.
>
> Anyone hitting this today will probably assume it's their own setup. Might be worth a note in the quickstart until the node serves the field.
>
> Two smaller ones in my write-up: claiming a second API key doesn't actually create a second identity (both keys resolved to the same DID, which quietly breaks tenant/agent separation), and `delegation.check` appears to ignore its `scopes` parameter — an ungranted scope still returns `authorised: true`.
>
> Full details: https://github.com/AtharvDhiman/t3n-enterprise-access-agent/blob/master/docs/bugs.md

---

## Email — full

**To:** devrel@terminal3.io
**Subject:** SDK 5.3.0 cannot authenticate against testnet — trust manifest missing `rtmr1_allowlist`

> Hi,
>
> I built an enterprise access & compliance agent for the Superteam bounty and
> hit eight issues along the way. Writing up the most serious one properly
> because I think it's currently blocking every new developer.
>
> **Environment**
> Cluster: testnet (`https://cn-api.sg.testnet.t3n.terminal3.io`)
> Node v22.19.0, Windows 11
> Contract `tee:org-data/contracts` v2.7.0
> Date: 2026-08-30
>
> **BUG-1 — SDK 5.3.0 cannot authenticate against testnet (critical, blocking)**
>
> `fetchTrustedManifest("testnet")` throws:
>
> ```
> Error: Trust manifest at https://cn-api.sg.testnet.t3n.terminal3.io/api/trust-manifest is malformed.
> ```
>
> Because `trustAnchor` is a required field on `T3nClient`, this blocks
> `handshake()` and therefore every subsequent operation. The quickstart cannot
> be completed on the current published SDK.
>
> **Cause:** 5.3.0's `TrustAnchor` type requires `rtmr1_allowlist` ("Must be
> non-empty. This is the real SP-003 mitigation"). The testnet node does not
> serve that field. Live response, HTTP 200:
>
> ```json
> {
>   "cluster": "testnet",
>   "version": 1787800421,
>   "peer_ids": ["QmPk4AtbFore74fJoP4CoS9Q96TvRvoQWR4VmkYtkBLmwz", "..."],
>   "rtmr3_allowlist": ["+XO6nLsfqnTkX0VcNk9AaXAu79ErxURODtjuGOIF8Sk7OQYq3PVVsMG8jzDEeNJQ"],
>   "signed_at": "2026-08-27T03:13:41Z",
>   "signature": "387384a9186bd06ab8..."
> }
> ```
>
> No `rtmr1_allowlist` key. Timing fits a client-ahead-of-cluster rollout: the
> manifest was signed 2026-08-27, 5.3.0 published 2026-08-28.
>
> **Version bisection**, each run against the live endpoint:
>
> | SDK | Result |
> |---|---|
> | 5.3.0 | ✗ malformed |
> | 5.2.0 | ✓ works |
> | 5.1.0 | ✓ works |
> | 5.0.0 | ✓ works |
> | 4.46.0 | ✓ works |
>
> **Workaround:** pin `"@terminal3/t3n-sdk": "5.2.0"` exactly — a caret range
> resolves back to 5.3.0 and reintroduces it.
>
> **Suggestion:** either serve `rtmr1_allowlist` from testnet nodes, or have the
> SDK treat it as optional with a loud warning when absent. An error naming the
> missing field would also have turned a 40-minute investigation into a
> one-minute one.
>
> ---
>
> **BUG-2 — claiming a second API key does not create a second identity (high)**
>
> The register-agent page says the claim page "issues a fresh key together with
> metered test credits every time, so you can revisit it once per agent". In
> practice every key claimed while signed in to the same account resolves to the
> **same DID** — two different private keys, two different Ethereum addresses,
> one DID.
>
> This matters because the authentication/authorization model depends on the
> agent being a different principal from the tenant. Following the docs literally
> produces an agent that silently holds the tenant's full authority, with no
> error. A locally generated keypair *does* mint a distinct DID, confirming it is
> account binding rather than key handling — but such a key has zero credits.
>
> I worked around it with `createAgent`, which mints a genuinely separate agent
> DID. Suggest the register-agent page say so explicitly.
>
> ---
>
> **BUG-3 — `delegation.check` ignores the `scopes` parameter (medium)**
>
> Functions are enforced correctly; scopes appear not to be. With an agent granted
> exactly `compliance/identity` and `compliance/employment`:
>
> | Query | authorised | satisfied | missing |
> |---|---|---|---|
> | granted scopes + granted functions | true | 1 | [] |
> | **`compliance/training` (never granted)** | **true** | 1 | [] |
> | ungranted function `org-data-write` | false | 0 | 1 |
>
> Also `satisfied[].scopes` is always `[]` even when the grant demonstrably
> carries scopes (`getAgentAuth()` shows them).
>
> The failure mode is permissive rather than restrictive, so an application that
> trusted `authorised` alone as a scope gate would believe it had consent it does
> not have. I compensated by reading the authoritative grant record instead.
>
> ---
>
> Five further issues (invoke restricted to `z:` contracts and the resulting dead
> end for org-provisioned agents; zero-credit DIDs unable to perform read-only
> operations; contract naming inconsistent between `contracts.list` and
> `getContractVersion`; the packaged npm README contradicting the docs site on
> environment names) are written up with reproductions here:
>
> https://github.com/AtharvDhiman/t3n-enterprise-access-agent/blob/master/docs/bugs.md
>
> Happy to answer questions or re-test anything against a fix.
>
> Worth saying: `createAgent` is genuinely excellent, the
> authentication/authorization split is the right model and is enforced in
> practice, error hygiene in the keyed transports is well designed, and having
> every docs page available as Markdown made research fast and accurate.
>
> Ayush Dhiman
> DID `did:t3n:2eaed84a2d5d72c2f8a19f1a832e8d63d96a9e5a`
