import { useEffect, useMemo, useState } from "react";
import { ArrowRight, Eye, EyeOff, Play } from "lucide-react";

import {
  api,
  ApiError,
  type DashboardSummary,
  type DecisionResult,
  type DemoScenario,
  type PolicySummary,
  type T3nStatus,
} from "../lib/api";
import {
  Card,
  DecisionBanner,
  EmptyState,
  ErrorNotice,
  Field,
  RequirementRow,
  RiskFlagList,
  SourceBadge,
  inputClass,
} from "../components/ui";

const SUBJECT_TYPES = ["employee", "contractor", "vendor", "partner"] as const;

export function NewRequest() {
  const [policies, setPolicies] = useState<PolicySummary[]>([]);
  const [scenarios, setScenarios] = useState<DemoScenario[]>([]);
  const [summary, setSummary] = useState<DashboardSummary | null>(null);
  const [status, setStatus] = useState<T3nStatus | null>(null);
  const [loadError, setLoadError] = useState<ApiError | null>(null);

  const [subjectRef, setSubjectRef] = useState("");
  const [subjectLabel, setSubjectLabel] = useState("");
  const [subjectType, setSubjectType] = useState<string>("employee");
  const [resource, setResource] = useState("employee_dashboard");
  const [accessLevel, setAccessLevel] = useState("read");
  const [policyId, setPolicyId] = useState("");
  const [justification, setJustification] = useState("");

  const [result, setResult] = useState<DecisionResult | null>(null);
  const [submitError, setSubmitError] = useState<ApiError | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    void (async () => {
      try {
        const [p, s, d, st] = await Promise.all([
          api.policies(),
          api.scenarios(),
          api.dashboard(),
          api.t3nStatus(),
        ]);
        setPolicies(p.policies);
        setScenarios(s.scenarios);
        setSummary(d);
        setStatus(st);
      } catch (err) {
        if (err instanceof ApiError) setLoadError(err);
      }
    })();
  }, []);

  const liveMode = summary?.claimSource.mode === "live";
  /**
   * In live mode the seeded subject is the tenant's own DID (Terminal 3's
   * documented self-grant pattern). Offering it as one click is what stops the
   * live path from requiring someone to hand-copy a 40-hex DID.
   */
  const liveSubjectDid = status?.tenant.did ?? null;

  /** Resources and levels offered depend on the chosen policy, when there is one. */
  const { resourceOptions, levelOptions } = useMemo(() => {
    const chosen = policies.find((p) => p.id === policyId);
    if (chosen) {
      return { resourceOptions: chosen.resources, levelOptions: chosen.accessLevels };
    }
    const all = new Set<string>();
    const levels = new Set<string>();
    for (const p of policies) {
      p.resources.forEach((r) => all.add(r));
      p.accessLevels.forEach((l) => levels.add(l));
    }
    return { resourceOptions: [...all].sort(), levelOptions: [...levels].sort() };
  }, [policies, policyId]);

  function loadScenario(s: DemoScenario) {
    setSubjectRef(s.subjectRef);
    setSubjectLabel(s.subjectLabel);
    setSubjectType(s.subjectType);
    setResource(s.resource);
    setAccessLevel(s.accessLevel);
    setPolicyId(s.policyId);
    setJustification("");
    setResult(null);
    setSubmitError(null);
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setSubmitError(null);
    setResult(null);
    try {
      const decision = await api.evaluate({
        subjectRef: subjectRef.trim(),
        subjectLabel: subjectLabel.trim() || undefined,
        subjectType,
        resource,
        accessLevel,
        policyId: policyId || undefined,
        justification: justification.trim() || undefined,
      });
      setResult(decision);
    } catch (err) {
      if (err instanceof ApiError) setSubmitError(err);
    } finally {
      setBusy(false);
    }
  }

  if (loadError) return <ErrorNotice message={loadError.message} remediation={loadError.remediation} />;

  return (
    <div className="space-y-6">
      <header>
        <h1 className="text-2xl font-bold tracking-tight text-ink-900">New access request</h1>
        <p className="mt-1 text-sm text-ink-600">
          The agent reads only the claims this policy requires, and only if the subject has
          consented.
        </p>
      </header>

      {liveMode && liveSubjectDid && (
        <Card
          title="Live subject"
          subtitle="This deployment has one seeded subject on Terminal 3 testnet."
          right={<SourceBadge source="LIVE_T3N" />}
        >
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="min-w-0">
              <p className="break-all font-mono text-xs text-ink-800">{liveSubjectDid}</p>
              <p className="mt-1.5 text-xs leading-relaxed text-ink-500">
                Consent covers identity and employment, but deliberately not security training —
                so <code className="font-mono">employee_dashboard</code> approves while{" "}
                <code className="font-mono">production_database</code> escalates for a consent
                reason.
              </p>
            </div>
            <button
              onClick={() => {
                setSubjectRef(liveSubjectDid);
                setSubjectLabel("Seeded live subject");
                setSubjectType("employee");
                setResult(null);
                setSubmitError(null);
              }}
              className="shrink-0 rounded-lg border border-ink-300 px-3 py-1.5 text-xs font-medium text-ink-700 transition hover:bg-ink-50"
            >
              Use this subject
            </button>
          </div>
        </Card>
      )}

      {scenarios.length > 0 && (
        <Card
          title="Demo scenarios"
          subtitle={
            liveMode
              ? "These use local fixtures. The server is in LIVE mode, so they will be refused — set CLAIM_SOURCE=demo to run them."
              : "One click loads a scenario. These use local fixtures, never Terminal 3 data."
          }
          right={<SourceBadge source="DEMO_FIXTURE" />}
        >
          <div className="grid gap-3 sm:grid-cols-2">
            {scenarios.map((s) => (
              <button
                key={s.id}
                onClick={() => loadScenario(s)}
                className={`group rounded-lg border p-3 text-left transition ${liveMode ? "border-ink-200 opacity-60 hover:opacity-100" : "border-ink-200 hover:border-ink-400 hover:bg-ink-50"}`}
              >
                <div className="flex items-center justify-between gap-2">
                  <span className="text-sm font-semibold text-ink-900">{s.label}</span>
                  <Play className="h-3.5 w-3.5 shrink-0 text-ink-400 group-hover:text-ink-700" aria-hidden />
                </div>
                <p className="mt-1 text-xs leading-relaxed text-ink-600">{s.narrative}</p>
                <p className="mt-2 font-mono text-[11px] text-ink-400">
                  expects {s.expectedDecision}
                </p>
              </button>
            ))}
          </div>
        </Card>
      )}

      <div className="grid gap-6 lg:grid-cols-5">
        <Card title="Request details" className="lg:col-span-2">
          <form onSubmit={submit} className="space-y-4">
            <Field
              label="Subject reference"
              hint="A did:t3n DID in live mode, or a demo fixture id. Never a name or email."
            >
              <input
                className={inputClass}
                value={subjectRef}
                onChange={(e) => setSubjectRef(e.target.value)}
                placeholder="did:t3n:… or demo:subject:alice"
                required
              />
            </Field>

            <Field label="Display label" hint="Shown to reviewers only. Never stored in the audit log.">
              <input
                className={inputClass}
                value={subjectLabel}
                onChange={(e) => setSubjectLabel(e.target.value)}
                placeholder="Optional"
              />
            </Field>

            <div className="grid gap-4 sm:grid-cols-2">
              <Field label="Subject type">
                <select
                  className={inputClass}
                  value={subjectType}
                  onChange={(e) => setSubjectType(e.target.value)}
                >
                  {SUBJECT_TYPES.map((t) => (
                    <option key={t} value={t}>
                      {t}
                    </option>
                  ))}
                </select>
              </Field>
              <Field label="Access level">
                <select
                  className={inputClass}
                  value={accessLevel}
                  onChange={(e) => setAccessLevel(e.target.value)}
                >
                  {levelOptions.map((l) => (
                    <option key={l} value={l}>
                      {l}
                    </option>
                  ))}
                </select>
              </Field>
            </div>

            <Field label="Resource">
              <select
                className={inputClass}
                value={resource}
                onChange={(e) => setResource(e.target.value)}
              >
                {resourceOptions.map((r) => (
                  <option key={r} value={r}>
                    {r}
                  </option>
                ))}
              </select>
            </Field>

            <Field label="Policy" hint="Leave on auto to let the engine resolve one.">
              <select
                className={inputClass}
                value={policyId}
                onChange={(e) => setPolicyId(e.target.value)}
              >
                <option value="">Auto-resolve</option>
                {policies.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.label}
                  </option>
                ))}
              </select>
            </Field>

            <Field label="Justification" hint="Never sent to Terminal 3, never stored in the audit log.">
              <textarea
                className={`${inputClass} min-h-[72px] resize-y`}
                value={justification}
                onChange={(e) => setJustification(e.target.value)}
                placeholder="Optional business reason"
              />
            </Field>

            <button
              type="submit"
              disabled={busy || subjectRef.trim() === ""}
              className="inline-flex w-full items-center justify-center gap-2 rounded-lg bg-ink-900 px-4 py-2.5 text-sm font-semibold text-white shadow-sm transition hover:bg-ink-800 disabled:cursor-not-allowed disabled:opacity-40"
            >
              {busy ? "Evaluating…" : "Evaluate request"}
              {!busy && <ArrowRight className="h-4 w-4" aria-hidden />}
            </button>
          </form>
        </Card>

        <div className="space-y-6 lg:col-span-3">
          {submitError && (
            <ErrorNotice message={submitError.message} remediation={submitError.remediation} />
          )}

          {!result && !submitError && (
            <EmptyState
              title="No decision yet"
              hint="Load a demo scenario or fill in the form, then evaluate."
            />
          )}

          {result && <DecisionDetail result={result} />}
        </div>
      </div>
    </div>
  );
}

export function DecisionDetail({ result }: { result: DecisionResult }) {
  return (
    <div className="space-y-6">
      <DecisionBanner
        decision={result.decision}
        reason={result.reason}
        policy={result.policy}
      />

      <Card title="Recommended next action">
        <p className="text-sm leading-relaxed text-ink-800">{result.nextAction}</p>
      </Card>

      <Card
        title="Requirements"
        subtitle={`${result.satisfiedRequirements.length} of ${result.requirements.length} satisfied`}
      >
        {result.requirementDetail.length === 0 ? (
          <p className="text-sm text-ink-500">No requirements were evaluated.</p>
        ) : (
          <ul className="-my-1">
            {result.requirementDetail.map((r) => (
              <RequirementRow
                key={r.claimId}
                claimId={r.claimId}
                satisfied={r.satisfied}
                detail={r.detail}
                reason={r.reason}
              />
            ))}
          </ul>
        )}
      </Card>

      <DataAccessCard result={result} />

      <Card title="Risk flags">
        <RiskFlagList flags={result.riskFlags} />
      </Card>

      <Card title="Audit">
        <dl className="grid gap-3 text-sm sm:grid-cols-3">
          <div>
            <dt className="text-xs uppercase tracking-wide text-ink-500">Audit ID</dt>
            <dd className="mt-0.5 font-mono text-xs text-ink-900">{result.auditId}</dd>
          </div>
          <div>
            <dt className="text-xs uppercase tracking-wide text-ink-500">Timestamp</dt>
            <dd className="mt-0.5 text-xs text-ink-900">
              {new Date(result.timestamp).toLocaleString()}
            </dd>
          </div>
          <div>
            <dt className="text-xs uppercase tracking-wide text-ink-500">Policy version</dt>
            <dd className="mt-0.5 font-mono text-xs text-ink-900">{result.policyVersion}</dd>
          </div>
        </dl>
      </Card>
    </div>
  );
}

/**
 * The data-minimization receipt.
 *
 * This card is the point of the product: it shows exactly what the agent asked
 * for, what consent allowed, and what it therefore could not see.
 */
function DataAccessCard({ result }: { result: DecisionResult }) {
  const { dataAccess } = result;
  return (
    <Card
      title="What the agent was allowed to see"
      subtitle="Requested vs. authorized — the data-minimization receipt"
      right={<SourceBadge source={dataAccess.source} />}
    >
      <div className="grid gap-4 sm:grid-cols-2">
        <div>
          <div className="mb-2 flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wide text-emerald-700">
            <Eye className="h-3.5 w-3.5" aria-hidden />
            Authorized ({dataAccess.authorizedScopes.length})
          </div>
          {dataAccess.authorizedScopes.length === 0 ? (
            <p className="text-sm text-ink-500">Nothing. No data was read.</p>
          ) : (
            <ul className="space-y-1">
              {dataAccess.authorizedScopes.map((s) => (
                <li
                  key={s}
                  className="rounded bg-emerald-50 px-2 py-1 font-mono text-xs text-emerald-900"
                >
                  {s}
                </li>
              ))}
            </ul>
          )}
        </div>
        <div>
          <div className="mb-2 flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wide text-ink-500">
            <EyeOff className="h-3.5 w-3.5" aria-hidden />
            Withheld ({dataAccess.deniedScopes.length})
          </div>
          {dataAccess.deniedScopes.length === 0 ? (
            <p className="text-sm text-ink-500">None — consent covered everything required.</p>
          ) : (
            <ul className="space-y-1">
              {dataAccess.deniedScopes.map((s) => (
                <li key={s} className="rounded bg-ink-100 px-2 py-1 font-mono text-xs text-ink-600">
                  {s}
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>
      <p className="mt-4 border-t border-ink-100 pt-3 text-xs leading-relaxed text-ink-500">
        The agent read <strong className="text-ink-800">{dataAccess.claimsRead}</strong> claim
        {dataAccess.claimsRead === 1 ? "" : "s"} — verification outcomes only. It never receives
        dates of birth, document numbers, addresses, or any other underlying evidence.
      </p>
    </Card>
  );
}
