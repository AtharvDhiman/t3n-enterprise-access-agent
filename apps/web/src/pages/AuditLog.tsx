import { useCallback, useEffect, useState } from "react";
import { Search } from "lucide-react";

import { api, ApiError, type AuditRecord, type PolicySummary } from "../lib/api";
import { Card, DecisionChip, EmptyState, ErrorNotice, SourceBadge, inputClass } from "../components/ui";
import { formatWhen } from "../lib/format";

const PAGE_SIZE = 25;

export function AuditLog() {
  const [records, setRecords] = useState<AuditRecord[]>([]);
  const [total, setTotal] = useState(0);
  const [offset, setOffset] = useState(0);
  const [policies, setPolicies] = useState<PolicySummary[]>([]);
  const [error, setError] = useState<ApiError | null>(null);
  const [expanded, setExpanded] = useState<string | null>(null);

  const [decision, setDecision] = useState("");
  const [policyId, setPolicyId] = useState("");
  const [subjectType, setSubjectType] = useState("");
  const [search, setSearch] = useState("");

  const load = useCallback(
    async (nextOffset: number) => {
      try {
        const page = await api.audit({
          decision: decision || undefined,
          policyId: policyId || undefined,
          subjectType: subjectType || undefined,
          search: search || undefined,
          limit: PAGE_SIZE,
          offset: nextOffset,
        });
        setRecords(page.records);
        setTotal(page.total);
        setOffset(page.offset);
        setError(null);
      } catch (err) {
        if (err instanceof ApiError) setError(err);
      }
    },
    [decision, policyId, subjectType, search],
  );

  useEffect(() => {
    void api
      .policies()
      .then((p) => setPolicies(p.policies))
      .catch(() => setPolicies([]));
  }, []);

  useEffect(() => {
    void load(0);
  }, [load]);

  return (
    <div className="space-y-6">
      <header>
        <h1 className="text-2xl font-bold tracking-tight text-ink-900">Audit log</h1>
        <p className="mt-1 text-sm text-ink-600">
          Every decision, permanently recorded. Subjects are stored as salted hashes, and claim
          values are never written here.
        </p>
      </header>

      <Card title="Filters">
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <select className={inputClass} value={decision} onChange={(e) => setDecision(e.target.value)}>
            <option value="">All decisions</option>
            <option value="APPROVED">Approved</option>
            <option value="REVIEW_REQUIRED">Review required</option>
            <option value="DENIED">Denied</option>
          </select>
          <select className={inputClass} value={policyId} onChange={(e) => setPolicyId(e.target.value)}>
            <option value="">All policies</option>
            {policies.map((p) => (
              <option key={p.id} value={p.id}>
                {p.label}
              </option>
            ))}
          </select>
          <select
            className={inputClass}
            value={subjectType}
            onChange={(e) => setSubjectType(e.target.value)}
          >
            <option value="">All subject types</option>
            <option value="employee">employee</option>
            <option value="contractor">contractor</option>
            <option value="vendor">vendor</option>
            <option value="partner">partner</option>
          </select>
          <div className="relative">
            <Search
              className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-ink-400"
              aria-hidden
            />
            <input
              className={`${inputClass} pl-9`}
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Resource, policy, audit id"
            />
          </div>
        </div>
      </Card>

      {error && <ErrorNotice message={error.message} remediation={error.remediation} />}

      <Card title={`${total} decision${total === 1 ? "" : "s"}`} subtitle="Newest first">
        {records.length === 0 ? (
          <EmptyState title="No matching decisions" hint="Adjust the filters, or submit a request." />
        ) : (
          <>
            <div className="-mx-5 overflow-x-auto">
              <table className="w-full min-w-[720px] text-sm">
                <thead>
                  <tr className="border-b border-ink-100 text-left text-xs uppercase tracking-wide text-ink-500">
                    <th className="px-5 py-2 font-medium">Decision</th>
                    <th className="px-5 py-2 font-medium">Resource</th>
                    <th className="px-5 py-2 font-medium">Level</th>
                    <th className="px-5 py-2 font-medium">Policy</th>
                    <th className="px-5 py-2 font-medium">Type</th>
                    <th className="px-5 py-2 font-medium">Source</th>
                    <th className="px-5 py-2 font-medium">When</th>
                  </tr>
                </thead>
                <tbody>
                  {records.map((r) => (
                    <>
                      <tr
                        key={r.auditId}
                        onClick={() => setExpanded(expanded === r.auditId ? null : r.auditId)}
                        className="cursor-pointer border-b border-ink-50 transition hover:bg-ink-50 last:border-0"
                      >
                        <td className="px-5 py-2.5">
                          <DecisionChip decision={r.decision} />
                        </td>
                        <td className="px-5 py-2.5 font-mono text-xs text-ink-800">{r.resource}</td>
                        <td className="px-5 py-2.5 font-mono text-xs text-ink-600">{r.accessLevel}</td>
                        <td className="px-5 py-2.5 font-mono text-xs text-ink-600">{r.policyId}</td>
                        <td className="px-5 py-2.5 text-xs text-ink-600">{r.subjectType}</td>
                        <td className="px-5 py-2.5">
                          <SourceBadge source={r.claimSource} />
                        </td>
                        <td className="whitespace-nowrap px-5 py-2.5 text-xs text-ink-500">
                          {formatWhen(r.timestamp)}
                        </td>
                      </tr>
                      {expanded === r.auditId && (
                        <tr key={`${r.auditId}-detail`} className="bg-ink-50/60">
                          <td colSpan={7} className="px-5 py-4">
                            <AuditDetail record={r} />
                          </td>
                        </tr>
                      )}
                    </>
                  ))}
                </tbody>
              </table>
            </div>

            <div className="mt-4 flex items-center justify-between border-t border-ink-100 pt-4">
              <span className="text-xs text-ink-500">
                Showing {offset + 1}–{Math.min(offset + PAGE_SIZE, total)} of {total}
              </span>
              <div className="flex gap-2">
                <button
                  disabled={offset === 0}
                  onClick={() => void load(Math.max(0, offset - PAGE_SIZE))}
                  className="rounded-lg border border-ink-300 px-3 py-1.5 text-xs font-medium text-ink-700 transition hover:bg-ink-50 disabled:opacity-40"
                >
                  Previous
                </button>
                <button
                  disabled={offset + PAGE_SIZE >= total}
                  onClick={() => void load(offset + PAGE_SIZE)}
                  className="rounded-lg border border-ink-300 px-3 py-1.5 text-xs font-medium text-ink-700 transition hover:bg-ink-50 disabled:opacity-40"
                >
                  Next
                </button>
              </div>
            </div>
          </>
        )}
      </Card>
    </div>
  );
}

/** The "why did the agent decide this?" view, answerable from the log alone. */
function AuditDetail({ record }: { record: AuditRecord }) {
  return (
    <dl className="grid gap-4 text-xs sm:grid-cols-2 lg:grid-cols-4">
      <Detail label="Audit ID" value={record.auditId} mono />
      <Detail label="Agent DID" value={record.agentId} mono />
      <Detail label="Subject (salted hash)" value={record.subjectHash} mono />
      <Detail label="Triggered by" value={record.actor} />
      <Detail
        label="Scopes requested"
        value={record.scopesRequested.length > 0 ? record.scopesRequested.join(", ") : "—"}
        mono
      />
      <Detail
        label="Scopes authorized"
        value={record.scopesAuthorized.length > 0 ? record.scopesAuthorized.join(", ") : "none"}
        mono
      />
      <Detail
        label="Claims consulted"
        value={record.claimsUsed.length > 0 ? record.claimsUsed.join(", ") : "none"}
        mono
      />
      <Detail
        label="Missing requirements"
        value={record.missingRequirements.length > 0 ? record.missingRequirements.join(", ") : "none"}
        mono
      />
      <Detail
        label="Risk flags"
        value={record.riskFlags.length > 0 ? record.riskFlags.join(", ") : "none"}
        mono
      />
      <div className="sm:col-span-2 lg:col-span-4">
        <dt className="font-semibold uppercase tracking-wide text-ink-500">Next action</dt>
        <dd className="mt-1 text-sm text-ink-800">{record.nextAction}</dd>
      </div>
    </dl>
  );
}

function Detail({ label, value, mono }: { label: string; value: string; mono?: boolean }) {
  return (
    <div className="min-w-0">
      <dt className="font-semibold uppercase tracking-wide text-ink-500">{label}</dt>
      <dd className={`mt-1 break-words text-ink-800 ${mono ? "font-mono text-[11px]" : ""}`}>
        {value}
      </dd>
    </div>
  );
}
