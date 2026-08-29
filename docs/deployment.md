# Deployment

Deliberately boring. There is no database, container, queue, or message bus to
operate — a Node process, a YAML file, and an append-only journal.

## Requirements

- Node.js ≥ 18 (developed on 22)
- Outbound HTTPS to `cn-api.sg.testnet.t3n.terminal3.io` (or the production node)
- A writable directory for the audit journal
- ~200 MB disk for `node_modules`

## Build and run

```bash
npm ci
npm run build        # builds the dashboard into apps/web/dist
npm start            # runs the API server
```

The server runs from TypeScript sources via `tsx` — no server build step, so
there is no compiled artefact that can drift from the source you are reading.

## Serving the dashboard

The API does not serve static files. Point your existing web server at
`apps/web/dist` and proxy `/api` to the Node process. Nginx:

```nginx
server {
  listen 443 ssl;
  server_name access.internal.example.com;

  # Put your SSO / auth_request in front of everything. The app has no
  # authentication of its own — see SECURITY.md.

  root /srv/t3n-aca/apps/web/dist;
  location / { try_files $uri /index.html; }

  location /api/ {
    proxy_pass http://127.0.0.1:8787;
    proxy_set_header Host $host;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
  }
}
```

Because both are same-origin in production, no CORS configuration is needed.

## Environment

Copy `.env.example` to `.env` and fill it in. In production prefer real
environment variables (systemd `EnvironmentFile=`, or your platform's secret
manager) over a file on disk.

**Set these before going live:**

```bash
NODE_ENV=production
T3N_ENV=production          # only after testing against testnet
CLAIM_SOURCE=live
LOG_LEVEL=info
AUDIT_LOG_PATH=/var/lib/t3n-aca/audit.jsonl
AUDIT_SALT=<32 hex chars, unique per deployment, then never changed>
```

Generate the salt once:

```bash
node -e "console.log(require('crypto').randomBytes(16).toString('hex'))"
```

> `AUDIT_SALT` must not change after the journal has records — existing hashes
> would stop matching. To rotate it, archive the journal and start a new one.

## First-run provisioning

Run once per deployment, in order:

```bash
npm run t3n:connect     # must print did:t3n:… before continuing
npm run t3n:setup       # creates the org + agent; writes DIDs back to .env
npm run t3n:seed        # scope writers, claim records, consent grants
```

`t3n:setup` writes `T3N_AGENT_API_KEY` into `.env`. If you manage configuration
elsewhere, copy that value into your secret store immediately — it is returned
exactly once and is not recoverable.

## systemd

```ini
[Unit]
Description=T3N Access & Compliance Agent
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=t3n-aca
WorkingDirectory=/srv/t3n-aca
EnvironmentFile=/etc/t3n-aca/env
ExecStart=/usr/bin/npm start
Restart=on-failure
RestartSec=5

# The process needs to write only the audit journal.
NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=strict
ProtectHome=true
ReadWritePaths=/var/lib/t3n-aca

[Install]
WantedBy=multi-user.target
```

```bash
sudo chmod 600 /etc/t3n-aca/env
sudo chown t3n-aca /etc/t3n-aca/env
```

## Health checks

```
GET /api/health      → { ok: true, uptimeSeconds }
GET /api/t3n/status  → connection state, DIDs, enforcement mode
```

Use `/api/health` for liveness. **Do not** use `/api/t3n/status` for liveness —
the server is intentionally designed to stay up when Terminal 3 is unreachable so
an operator can see *why*. Alert on it separately.

## Startup behaviour

| Condition | Behaviour | Rationale |
|---|---|---|
| Policy file invalid | **Exits** | A compliance system must not run on rules it could not parse |
| `CLAIM_SOURCE=live` but T3N unconfigured | **Exits** | Never silently serve fixtures to someone who asked for live data |
| T3N configured but unreachable | **Starts**, status shows the error | The status page is how you diagnose it |
| No `ANTHROPIC_API_KEY` | **Starts**, NL layer disabled | Optional feature |
| No `AUDIT_SALT` | **Starts** with a warning, uses a dev default | Set it in production |

## Upgrading

```bash
git pull
npm ci
npm run verify        # typecheck + lint + 97 tests
npm run build
sudo systemctl restart t3n-aca
curl -s localhost:8787/api/health
```

If the release changes the SDK version, read
[maintenance.md → Updating the SDK](maintenance.md) first. The pin to `5.2.0` is
deliberate ([BUG-1](bugs.md)).

## Backup

Two things matter:

1. **`.env` / your secret store** — the agent credential cannot be recovered.
   Losing it means re-provisioning the agent and re-issuing every grant.
2. **The audit journal** — append-only; back it up like any compliance record.

`config/policies.yaml` lives in git.

Nothing else holds state. A rebuilt host with those two restored is fully
functional.

## Scaling

Single process handles a request in single-digit milliseconds plus Terminal 3
round-trip. Reasoning about capacity:

- The T3N session and WASM component are created **once** and reused. There is no
  per-request handshake.
- The policy engine does no I/O.
- The audit store keeps an in-memory mirror, so dashboard queries need no disk
  reads.

If you ever need more than one instance, the constraint is the audit file: give
each instance its own journal and merge for reporting, or move the store behind
a shared implementation of the same small interface.
