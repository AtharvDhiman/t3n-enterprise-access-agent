/**
 * Shared presentational pieces.
 *
 * One rule runs through all of them: a decision's *meaning* must survive being
 * skimmed. Colour alone never carries it — every state also has an icon and a
 * word, so the UI stays readable in a screenshot, in greyscale, and to anyone
 * who does not distinguish red from green.
 */

import type { ReactNode } from "react";
import {
  AlertTriangle,
  Check,
  CircleAlert,
  CircleHelp,
  Database,
  ShieldCheck,
  X,
} from "lucide-react";

import type { ClaimSourceKind, Decision, RiskFlag } from "../lib/api";

export function Card({
  title,
  subtitle,
  right,
  children,
  className = "",
}: {
  title?: string;
  subtitle?: string;
  right?: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  return (
    <section
      className={`rounded-xl border border-ink-200 bg-white shadow-sm ${className}`}
    >
      {(title || right) && (
        <header className="flex items-start justify-between gap-4 border-b border-ink-100 px-5 py-4">
          <div>
            {title && <h2 className="text-sm font-semibold text-ink-900">{title}</h2>}
            {subtitle && <p className="mt-0.5 text-xs text-ink-500">{subtitle}</p>}
          </div>
          {right}
        </header>
      )}
      <div className="p-5">{children}</div>
    </section>
  );
}

const DECISION_STYLE: Record<
  Decision,
  { label: string; chip: string; bar: string; icon: ReactNode }
> = {
  APPROVED: {
    label: "Approved",
    chip: "bg-emerald-50 text-emerald-800 ring-emerald-600/20",
    bar: "bg-emerald-600",
    icon: <Check className="h-4 w-4" aria-hidden />,
  },
  REVIEW_REQUIRED: {
    label: "Review required",
    chip: "bg-amber-50 text-amber-900 ring-amber-600/20",
    bar: "bg-amber-500",
    icon: <CircleAlert className="h-4 w-4" aria-hidden />,
  },
  DENIED: {
    label: "Denied",
    chip: "bg-rose-50 text-rose-800 ring-rose-600/20",
    bar: "bg-rose-600",
    icon: <X className="h-4 w-4" aria-hidden />,
  },
};

export function DecisionChip({ decision }: { decision: Decision }) {
  const s = DECISION_STYLE[decision];
  return (
    <span
      className={`inline-flex items-center gap-1.5 whitespace-nowrap rounded-full px-2.5 py-1 text-xs font-semibold ring-1 ring-inset ${s.chip}`}
    >
      {s.icon}
      {s.label}
    </span>
  );
}

/** The large, unmissable verdict shown at the top of a result. */
export function DecisionBanner({
  decision,
  reason,
  policy,
}: {
  decision: Decision;
  reason: string;
  policy: string;
}) {
  const s = DECISION_STYLE[decision];
  return (
    <div className="overflow-hidden rounded-xl border border-ink-200 bg-white shadow-sm">
      <div className={`h-1.5 w-full ${s.bar}`} />
      <div className="flex flex-col gap-3 p-6 sm:flex-row sm:items-start sm:justify-between">
        <div className="min-w-0">
          <div className="flex items-center gap-3">
            <span
              className={`inline-flex h-10 w-10 items-center justify-center rounded-full ring-1 ring-inset ${s.chip}`}
            >
              {s.icon}
            </span>
            <h1 className="text-2xl font-bold tracking-tight text-ink-900">{s.label}</h1>
          </div>
          <p className="mt-3 max-w-3xl text-sm leading-relaxed text-ink-700">{reason}</p>
        </div>
        <div className="shrink-0 text-left sm:text-right">
          <div className="text-[11px] font-medium uppercase tracking-wide text-ink-400">
            Policy applied
          </div>
          <div className="font-mono text-sm text-ink-900">{policy}</div>
        </div>
      </div>
    </div>
  );
}

/**
 * The provenance badge.
 *
 * This is the most important two words on the screen: it is what stops a demo
 * result ever being mistaken for a real one.
 */
export function SourceBadge({ source }: { source: ClaimSourceKind }) {
  if (source === "LIVE_T3N") {
    return (
      <span className="inline-flex items-center gap-1.5 whitespace-nowrap rounded-md bg-sky-50 px-2 py-1 text-xs font-semibold text-sky-800 ring-1 ring-inset ring-sky-600/20">
        <ShieldCheck className="h-3.5 w-3.5" aria-hidden />
        LIVE T3N
      </span>
    );
  }
  return (
    <span className="inline-flex items-center gap-1.5 whitespace-nowrap rounded-md bg-violet-50 px-2 py-1 text-xs font-semibold text-violet-800 ring-1 ring-inset ring-violet-600/20">
      <Database className="h-3.5 w-3.5" aria-hidden />
      DEMO DATA
    </span>
  );
}

export function StatTile({
  label,
  value,
  tone = "neutral",
  icon,
}: {
  label: string;
  value: number | string;
  tone?: "neutral" | "approved" | "review" | "denied";
  icon?: ReactNode;
}) {
  const tones = {
    neutral: "text-ink-900",
    approved: "text-emerald-700",
    review: "text-amber-700",
    denied: "text-rose-700",
  } as const;
  return (
    <div className="rounded-xl border border-ink-200 bg-white p-5 shadow-sm">
      <div className="flex items-center justify-between">
        <span className="text-xs font-medium uppercase tracking-wide text-ink-500">{label}</span>
        {icon}
      </div>
      <div className={`mt-2 text-3xl font-bold tabular-nums ${tones[tone]}`}>{value}</div>
    </div>
  );
}

const SEVERITY_STYLE = {
  high: "bg-rose-50 text-rose-800 ring-rose-600/20",
  medium: "bg-amber-50 text-amber-900 ring-amber-600/20",
  low: "bg-ink-100 text-ink-700 ring-ink-400/20",
} as const;

export function RiskFlagList({ flags }: { flags: RiskFlag[] }) {
  if (flags.length === 0) {
    return <p className="text-sm text-ink-500">No risk flags raised.</p>;
  }
  return (
    <ul className="space-y-2">
      {flags.map((f) => (
        <li
          key={`${f.code}-${f.message}`}
          className={`flex items-start gap-2.5 rounded-lg px-3 py-2.5 text-sm ring-1 ring-inset ${SEVERITY_STYLE[f.severity]}`}
        >
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden />
          <span>
            <span className="font-mono text-xs font-semibold">{f.code}</span>
            <span className="mx-1.5 opacity-40">·</span>
            {f.message}
          </span>
        </li>
      ))}
    </ul>
  );
}

/** A requirement row: satisfied, or unsatisfied with the precise cause. */
export function RequirementRow({
  claimId,
  satisfied,
  detail,
  reason,
}: {
  claimId: string;
  satisfied: boolean;
  detail: string;
  reason: string;
}) {
  return (
    <li className="flex items-start gap-3 border-b border-ink-100 py-3 last:border-0">
      <span
        className={`mt-0.5 inline-flex h-5 w-5 shrink-0 items-center justify-center rounded-full ${
          satisfied ? "bg-emerald-100 text-emerald-700" : "bg-amber-100 text-amber-800"
        }`}
      >
        {satisfied ? (
          <Check className="h-3 w-3" aria-hidden />
        ) : (
          <CircleHelp className="h-3 w-3" aria-hidden />
        )}
      </span>
      <div className="min-w-0">
        <div className="flex flex-wrap items-center gap-2">
          <span className="font-mono text-sm text-ink-900">{claimId}</span>
          {!satisfied && (
            <span className="rounded bg-ink-100 px-1.5 py-0.5 font-mono text-[10px] uppercase tracking-wide text-ink-600">
              {reason.replace(/_/g, " ")}
            </span>
          )}
        </div>
        <p className="mt-0.5 text-sm text-ink-600">{detail}</p>
      </div>
    </li>
  );
}

export function EmptyState({ title, hint }: { title: string; hint?: string }) {
  return (
    <div className="rounded-xl border border-dashed border-ink-300 bg-ink-50/50 px-6 py-10 text-center">
      <p className="text-sm font-medium text-ink-700">{title}</p>
      {hint && <p className="mt-1 text-xs text-ink-500">{hint}</p>}
    </div>
  );
}

export function ErrorNotice({
  message,
  remediation,
}: {
  message: string;
  remediation?: string | null;
}) {
  return (
    <div className="flex items-start gap-3 rounded-xl border border-rose-200 bg-rose-50 p-4">
      <AlertTriangle className="mt-0.5 h-5 w-5 shrink-0 text-rose-600" aria-hidden />
      <div>
        <p className="text-sm font-semibold text-rose-900">{message}</p>
        {remediation && <p className="mt-1 text-sm text-rose-800">{remediation}</p>}
      </div>
    </div>
  );
}

export function Field({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: ReactNode;
}) {
  return (
    <label className="block">
      <span className="mb-1.5 block text-xs font-semibold uppercase tracking-wide text-ink-600">
        {label}
      </span>
      {children}
      {hint && <span className="mt-1 block text-xs text-ink-500">{hint}</span>}
    </label>
  );
}

export const inputClass =
  "w-full rounded-lg border border-ink-300 bg-white px-3 py-2 text-sm text-ink-900 shadow-sm outline-none transition focus:border-ink-500 focus:ring-2 focus:ring-ink-900/10";

export function Mono({ children }: { children: ReactNode }) {
  return <span className="font-mono text-xs text-ink-700">{children}</span>;
}
