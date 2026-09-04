import { useEffect, useState } from "react";
import { AlertTriangle, Building2, Bot, KeyRound, RefreshCw, Server, ShieldCheck } from "lucide-react";

import { api, ApiError, type IdentityStatus, type T3nStatus } from "../lib/api";
import { Card, ErrorNotice } from "../components/ui";

export function T3nStatusPage() {
  const [status, setStatus] = useState<T3nStatus | null>(null);
  const [error, setError] = useState<ApiError | null>(null);
  const [busy, setBusy] = useState(false);

  async function refresh() {
    setBusy(true);
    try {
      setStatus(await api.t3nStatus());
      setError(null);
    } catch (err) {
      if (err instanceof ApiError) setError(err);
    } finally {
      setBusy(false);
    }
  }

  useEffect(() => {
    void refresh();
  }, []);

  // Deliberately NOT an early return on `error`. This page's whole job is
  // showing connection health, and returning the error alone unmounted the
  // Refresh button with it — so one transient blip left the page permanently
  // stuck, with the single control that could clear it gone. Navigating to the
  // view you are already on does not help either: `setView` is a no-op and
  // React keeps the same instance and its error state. The error is rendered
  // above whatever status we have instead, and Refresh always stays.
  if (!status && !error) return <p className="text-sm text-ink-500">Loading…</p>;

  const connected = status?.state === "connected";

  return (
    <div className="space-y-6">
      <header className="flex items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold tracking-tight text-ink-900">Terminal 3 status</h1>
          <p className="mt-1 text-sm text-ink-600">
            Identities, connection, and how access is actually enforced. No credential is ever shown
            here — or sent to this page.
          </p>
        </div>
        <button
          onClick={() => void refresh()}
          disabled={busy}
          className="inline-flex shrink-0 items-center gap-1.5 rounded-lg border border-ink-300 px-3 py-1.5 text-xs font-medium text-ink-700 transition hover:bg-ink-50 disabled:opacity-40"
        >
          <RefreshCw className={`h-3.5 w-3.5 ${busy ? "animate-spin" : ""}`} aria-hidden />
          Refresh
        </button>
      </header>

      {error && (
        <ErrorNotice message={error.message} remediation={error.remediation} />
      )}

      {!status ? (
        <p className="text-sm text-ink-500">
          No status to show. Use Refresh once the API is reachable again.
        </p>
      ) : (
        <StatusBody status={status} connected={connected} />
      )}
    </div>
  );
}

function StatusBody({ status, connected }: { status: T3nStatus; connected: boolean }) {
  return (
    <>
      {!status.configured && (
        <ErrorNotice
          message="Terminal 3 is not configured on this server."
          remediation={
            status.configError ??
            "Set T3N_API_KEY in .env, then run `npm run t3n:setup`. Claim a key at https://www.terminal3.io/claim-page"
          }
        />
      )}

      {status.warnings.length > 0 && (
        <div className="rounded-xl border border-amber-200 bg-amber-50 p-4">
          <div className="flex items-start gap-3">
            <AlertTriangle className="mt-0.5 h-5 w-5 shrink-0 text-amber-600" aria-hidden />
            <div>
              <p className="text-sm font-semibold text-amber-900">Configuration warnings</p>
              <ul className="mt-1 list-inside list-disc space-y-0.5 text-sm text-amber-800">
                {status.warnings.map((w) => (
                  <li key={w}>{w}</li>
                ))}
              </ul>
            </div>
          </div>
        </div>
      )}

      <div className="grid gap-5 lg:grid-cols-3">
        <Card title="Connection" right={<Server className="h-4 w-4 text-ink-400" aria-hidden />}>
          <dl className="space-y-3 text-sm">
            <KV label="State">
              <span
                className={`inline-flex items-center gap-1.5 rounded-full px-2 py-0.5 text-xs font-semibold ring-1 ring-inset ${
                  connected
                    ? "bg-emerald-50 text-emerald-800 ring-emerald-600/20"
                    : "bg-rose-50 text-rose-800 ring-rose-600/20"
                }`}
              >
                <span
                  className={`h-1.5 w-1.5 rounded-full ${connected ? "bg-emerald-500" : "bg-rose-500"}`}
                />
                {status.state}
              </span>
            </KV>
            <KV label="Environment">
              <span className="font-mono text-xs">{status.environment}</span>
            </KV>
            <KV label="Node">
              <span className="break-all font-mono text-[11px] text-ink-600">
                {status.nodeUrl ?? "—"}
              </span>
            </KV>
            <KV label="WASM component">
              <span className="text-xs">{status.wasmLoaded ? "loaded" : "not loaded"}</span>
            </KV>
            <KV label="Contract">
              <span className="font-mono text-[11px]">{status.contractId}</span>
            </KV>
            {status.connectedAt && (
              <KV label="Connected at">
                <span className="text-xs">{new Date(status.connectedAt).toLocaleString()}</span>
              </KV>
            )}
          </dl>
          {status.lastError && (
            <p className="mt-3 rounded-lg bg-rose-50 px-3 py-2 text-xs text-rose-800">
              {status.lastError}
            </p>
          )}
        </Card>

        <IdentityCard
          title="Tenant identity"
          subtitle="The enterprise. Owns policies, scopes and the audit trail."
          identity={status.tenant}
          icon={<Building2 className="h-4 w-4 text-ink-400" aria-hidden />}
        />

        <IdentityCard
          title="Agent identity"
          subtitle="The compliance agent. Holds only what subjects have granted it."
          identity={status.agent}
          icon={<Bot className="h-4 w-4 text-ink-400" aria-hidden />}
        />
      </div>

      <Card
        title="Enforcement mode"
        subtitle="How authorization is actually enforced for claim reads"
        right={
          <span className="rounded-md bg-ink-900 px-2 py-1 font-mono text-[11px] font-semibold text-white">
            {status.enforcementMode}
          </span>
        }
      >
        <p className="text-sm leading-relaxed text-ink-700">{status.enforcementDetail}</p>
      </Card>

      <Card
        title="Organisation"
        right={<ShieldCheck className="h-4 w-4 text-ink-400" aria-hidden />}
      >
        <dl className="space-y-3 text-sm">
          <KV label="Organisation DID">
            <span className="break-all font-mono text-[11px]">{status.orgDid ?? "—"}</span>
          </KV>
          <KV label="Agent belongs to">
            <span className="break-all font-mono text-[11px]">
              {status.agent.organisations.length > 0 ? status.agent.organisations.join(", ") : "—"}
            </span>
          </KV>
          <KV label="Agent owner">
            <span className="break-all font-mono text-[11px]">{status.agent.owner ?? "—"}</span>
          </KV>
        </dl>
      </Card>

      <div className="flex items-start gap-3 rounded-xl border border-ink-200 bg-ink-50 p-4">
        <KeyRound className="mt-0.5 h-4 w-4 shrink-0 text-ink-500" aria-hidden />
        <p className="text-xs leading-relaxed text-ink-600">
          DIDs are public identifiers and safe to display. Private keys and the agent's opaque
          credential are read from the server environment only — they are never sent to the browser,
          never logged, and never returned by any API route.
        </p>
      </div>
    </>
  );
}

function IdentityCard({
  title,
  subtitle,
  identity,
  icon,
}: {
  title: string;
  subtitle: string;
  identity: IdentityStatus;
  icon: React.ReactNode;
}) {
  return (
    <Card title={title} subtitle={subtitle} right={icon}>
      <dl className="space-y-3 text-sm">
        <KV label="Authenticated">
          <span
            className={`text-xs font-semibold ${identity.authenticated ? "text-emerald-700" : "text-ink-500"}`}
          >
            {identity.authenticated ? "yes" : "no"}
          </span>
        </KV>
        <KV label="DID">
          <span className="break-all font-mono text-[11px]">{identity.did ?? "—"}</span>
        </KV>
        <KV label="Credits">
          <span className="font-mono text-xs">{identity.balance ?? "—"}</span>
        </KV>
      </dl>
    </Card>
  );
}

function KV({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="grid grid-cols-[120px_1fr] items-start gap-2">
      <dt className="text-xs text-ink-500">{label}</dt>
      <dd className="min-w-0 text-ink-900">{children}</dd>
    </div>
  );
}
