import { useEffect, useState } from "react";
import { Activity, CheckCircle2, ShieldAlert, XCircle } from "lucide-react";

import { api, ApiError, type DashboardSummary, type T3nStatus } from "../lib/api";
import {
  Card,
  DecisionChip,
  EmptyState,
  ErrorNotice,
  SourceBadge,
  StatTile,
} from "../components/ui";

export function Dashboard({ onOpenAudit }: { onOpenAudit: () => void }) {
  const [data, setData] = useState<DashboardSummary | null>(null);
  const [status, setStatus] = useState<T3nStatus | null>(null);
  const [error, setError] = useState<ApiError | null>(null);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const [d, s] = await Promise.all([api.dashboard(), api.t3nStatus()]);
        if (!cancelled) {
          setData(d);
          setStatus(s);
        }
      } catch (err) {
        if (!cancelled && err instanceof ApiError) setError(err);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  if (error) return <ErrorNotice message={error.message} remediation={error.remediation} />;
  if (!data || !status) return <p className="text-sm text-ink-500">Loading…</p>;

  const connected = status.state === "connected";

  return (
    <div className="space-y-6">
      <header>
        <h1 className="text-2xl font-bold tracking-tight text-ink-900">Dashboard</h1>
        <p className="mt-1 text-sm text-ink-600">
          Access decisions made from user-authorized data, with a full audit trail.
        </p>
      </header>

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <StatTile
          label="Total decisions"
          value={data.stats.total}
          icon={<Activity className="h-4 w-4 text-ink-400" aria-hidden />}
        />
        <StatTile
          label="Approved"
          value={data.stats.approved}
          tone="approved"
          icon={<CheckCircle2 className="h-4 w-4 text-emerald-500" aria-hidden />}
        />
        <StatTile
          label="Review required"
          value={data.stats.reviewRequired}
          tone="review"
          icon={<ShieldAlert className="h-4 w-4 text-amber-500" aria-hidden />}
        />
        <StatTile
          label="Denied"
          value={data.stats.denied}
          tone="denied"
          icon={<XCircle className="h-4 w-4 text-rose-500" aria-hidden />}
        />
      </div>

      <div className="grid gap-6 lg:grid-cols-3">
        <Card
          title="Terminal 3 connection"
          subtitle="Where the evidence behind these decisions comes from"
          className="lg:col-span-1"
        >
          <dl className="space-y-3 text-sm">
            <div className="flex items-center justify-between gap-3">
              <dt className="text-ink-500">Status</dt>
              <dd>
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
              </dd>
            </div>
            <div className="flex items-center justify-between gap-3">
              <dt className="text-ink-500">Environment</dt>
              <dd className="font-mono text-xs text-ink-900">{status.environment}</dd>
            </div>
            <div className="flex items-center justify-between gap-3">
              <dt className="text-ink-500">Agent DID</dt>
              <dd className="font-mono text-xs text-ink-900">{status.agent.shortDid}</dd>
            </div>
            <div className="flex items-center justify-between gap-3">
              <dt className="text-ink-500">Decisions use</dt>
              <dd>
                <SourceBadge source={data.claimSource.kind} />
              </dd>
            </div>
          </dl>
          <p className="mt-4 border-t border-ink-100 pt-3 text-xs leading-relaxed text-ink-500">
            {data.claimSource.description}
          </p>
        </Card>

        <Card
          title="Recent decisions"
          subtitle="Newest first"
          className="lg:col-span-2"
          right={
            <button
              onClick={onOpenAudit}
              className="rounded-lg border border-ink-300 px-3 py-1.5 text-xs font-medium text-ink-700 transition hover:bg-ink-50"
            >
              View audit log
            </button>
          }
        >
          {data.recent.length === 0 ? (
            <EmptyState
              title="No decisions recorded yet"
              hint="Submit an access request to see it appear here."
            />
          ) : (
            <div className="-mx-5 -my-1 overflow-x-auto">
              <table className="w-full min-w-[560px] text-sm">
                <thead>
                  <tr className="border-b border-ink-100 text-left text-xs uppercase tracking-wide text-ink-500">
                    <th className="px-5 py-2 font-medium">Decision</th>
                    <th className="px-5 py-2 font-medium">Resource</th>
                    <th className="px-5 py-2 font-medium">Policy</th>
                    <th className="px-5 py-2 font-medium">Source</th>
                    <th className="px-5 py-2 font-medium">When</th>
                  </tr>
                </thead>
                <tbody>
                  {data.recent.map((r) => (
                    <tr key={r.auditId} className="border-b border-ink-50 last:border-0">
                      <td className="px-5 py-2.5">
                        <DecisionChip decision={r.decision} />
                      </td>
                      <td className="px-5 py-2.5 font-mono text-xs text-ink-800">{r.resource}</td>
                      <td className="px-5 py-2.5 font-mono text-xs text-ink-600">{r.policyId}</td>
                      <td className="px-5 py-2.5">
                        <SourceBadge source={r.claimSource} />
                      </td>
                      <td className="whitespace-nowrap px-5 py-2.5 text-xs text-ink-500">
                        {new Date(r.timestamp).toLocaleString()}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Card>
      </div>
    </div>
  );
}
