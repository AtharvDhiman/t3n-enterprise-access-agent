import { useEffect, useState } from "react";
import { FileCode2, Lock, UserCheck } from "lucide-react";

import { api, ApiError, type ClaimDefinition, type PolicySummary } from "../lib/api";
import { Card, ErrorNotice } from "../components/ui";

export function Policies() {
  const [policies, setPolicies] = useState<PolicySummary[]>([]);
  const [claims, setClaims] = useState<ClaimDefinition[]>([]);
  const [version, setVersion] = useState("");
  const [error, setError] = useState<ApiError | null>(null);

  useEffect(() => {
    void (async () => {
      try {
        const p = await api.policies();
        setPolicies(p.policies);
        setClaims(p.claims);
        setVersion(p.version);
      } catch (err) {
        if (err instanceof ApiError) setError(err);
      }
    })();
  }, []);

  if (error) return <ErrorNotice message={error.message} remediation={error.remediation} />;

  return (
    <div className="space-y-6">
      <header>
        <h1 className="text-2xl font-bold tracking-tight text-ink-900">Policies</h1>
        <p className="mt-1 text-sm text-ink-600">
          Business rules live in{" "}
          <code className="rounded bg-ink-100 px-1.5 py-0.5 font-mono text-xs">
            config/policies.yaml
          </code>
          , version <span className="font-mono">{version}</span>. Changing them is a config edit,
          never a code change.
        </p>
      </header>

      <div className="grid gap-5 lg:grid-cols-2">
        {policies.map((p) => (
          <Card
            key={p.id}
            title={p.label}
            subtitle={p.id}
            right={
              p.rules.requireManualApproval ? (
                <span className="inline-flex items-center gap-1 rounded-md bg-amber-50 px-2 py-1 text-[11px] font-semibold text-amber-900 ring-1 ring-inset ring-amber-600/20">
                  <Lock className="h-3 w-3" aria-hidden />
                  Manual approval
                </span>
              ) : null
            }
          >
            <p className="text-sm leading-relaxed text-ink-700">{p.description}</p>

            <div className="mt-4 space-y-3">
              <Row label="Required claims">
                <div className="flex flex-wrap gap-1.5">
                  {p.requiredClaims.map((c) => (
                    <Tag key={c} tone="required">
                      {c}
                    </Tag>
                  ))}
                </div>
              </Row>

              {p.optionalClaims.length > 0 && (
                <Row label="Optional claims">
                  <div className="flex flex-wrap gap-1.5">
                    {p.optionalClaims.map((c) => (
                      <Tag key={c}>{c}</Tag>
                    ))}
                  </div>
                </Row>
              )}

              <Row label="T3N scopes needed">
                <div className="flex flex-wrap gap-1.5">
                  {p.requiredScopes.map((s) => (
                    <Tag key={s} tone="scope">
                      {s}
                    </Tag>
                  ))}
                </div>
              </Row>

              <Row label="Applies to">
                <span className="text-xs text-ink-700">
                  {p.subjectTypes.join(", ")} · {p.accessLevels.join(" / ")}
                </span>
              </Row>

              <Row label="Resources">
                <span className="font-mono text-[11px] leading-relaxed text-ink-600">
                  {p.resources.join(", ")}
                </span>
              </Row>

              <Row label="Rules">
                <span className="text-xs text-ink-700">
                  minimum assurance <strong>{p.rules.minimumAssurance}</strong> · max claim age{" "}
                  <strong>{p.rules.maxClaimAgeDays}d</strong> · expired ⇒{" "}
                  <strong>{p.rules.expiredClaimBehavior}</strong> · failed ⇒{" "}
                  <strong>{p.rules.failedClaimBehavior}</strong>
                </span>
              </Row>
            </div>
          </Card>
        ))}
      </div>

      <Card
        title="Claim vocabulary"
        subtitle="Each claim maps to exactly one Terminal 3 scope — this mapping is what makes minimization concrete"
        right={<FileCode2 className="h-4 w-4 text-ink-400" aria-hidden />}
      >
        <div className="-mx-5 overflow-x-auto">
          <table className="w-full min-w-[640px] text-sm">
            <thead>
              <tr className="border-b border-ink-100 text-left text-xs uppercase tracking-wide text-ink-500">
                <th className="px-5 py-2 font-medium">Claim</th>
                <th className="px-5 py-2 font-medium">Scope</th>
                <th className="px-5 py-2 font-medium">What the agent learns</th>
              </tr>
            </thead>
            <tbody>
              {claims.map((c) => (
                <tr key={c.id} className="border-b border-ink-50 align-top last:border-0">
                  <td className="px-5 py-3">
                    <div className="flex items-center gap-1.5">
                      <UserCheck className="h-3.5 w-3.5 shrink-0 text-ink-400" aria-hidden />
                      <span className="font-mono text-xs text-ink-900">{c.id}</span>
                    </div>
                    <div className="mt-0.5 text-xs text-ink-500">{c.label}</div>
                  </td>
                  <td className="px-5 py-3 font-mono text-xs text-sky-800">{c.scope}</td>
                  <td className="px-5 py-3 text-xs leading-relaxed text-ink-600">{c.description}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Card>
    </div>
  );
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="grid grid-cols-[130px_1fr] items-start gap-3">
      <span className="pt-0.5 text-[11px] font-semibold uppercase tracking-wide text-ink-500">
        {label}
      </span>
      <div className="min-w-0">{children}</div>
    </div>
  );
}

function Tag({
  children,
  tone = "default",
}: {
  children: React.ReactNode;
  tone?: "default" | "required" | "scope";
}) {
  const tones = {
    default: "bg-ink-100 text-ink-700",
    required: "bg-ink-900 text-white",
    scope: "bg-sky-50 text-sky-800 ring-1 ring-inset ring-sky-600/20",
  } as const;
  return (
    <span className={`rounded px-1.5 py-0.5 font-mono text-[11px] ${tones[tone]}`}>{children}</span>
  );
}
