import { useEffect, useState } from "react";
import {
  Bot,
  FileText,
  LayoutDashboard,
  MessageSquare,
  PlusCircle,
  ScrollText,
} from "lucide-react";

import { api, type DashboardSummary, type T3nStatus } from "./lib/api";
import { SourceBadge } from "./components/ui";
import { Dashboard } from "./pages/Dashboard";
import { NewRequest } from "./pages/NewRequest";
import { AuditLog } from "./pages/AuditLog";
import { Policies } from "./pages/Policies";
import { T3nStatusPage } from "./pages/T3nStatusPage";
import { Ask } from "./pages/Ask";

type View = "dashboard" | "request" | "audit" | "policies" | "t3n" | "ask";

const NAV: Array<{ id: View; label: string; icon: typeof LayoutDashboard }> = [
  { id: "dashboard", label: "Dashboard", icon: LayoutDashboard },
  { id: "request", label: "New request", icon: PlusCircle },
  { id: "audit", label: "Audit log", icon: ScrollText },
  { id: "policies", label: "Policies", icon: FileText },
  { id: "t3n", label: "T3N status", icon: Bot },
  { id: "ask", label: "Ask", icon: MessageSquare },
];

export default function App() {
  const [view, setView] = useState<View>("dashboard");
  const [status, setStatus] = useState<T3nStatus | null>(null);
  const [summary, setSummary] = useState<DashboardSummary | null>(null);

  // Re-read on navigation so the banner reflects the current server state
  // rather than a snapshot taken when the tab was first opened.
  useEffect(() => {
    void api.t3nStatus().then(setStatus).catch(() => setStatus(null));
    void api.dashboard().then(setSummary).catch(() => setSummary(null));
  }, [view]);

  return (
    <div className="flex min-h-screen bg-ink-50 text-ink-900">
      <aside className="hidden w-60 shrink-0 flex-col border-r border-ink-800 bg-ink-950 lg:flex">
        <div className="border-b border-ink-800 px-5 py-5">
          <div className="flex items-center gap-2">
            <span className="flex h-7 w-7 items-center justify-center rounded-lg bg-white/10 text-xs font-bold text-white">
              T3
            </span>
            <span className="text-sm font-semibold leading-tight text-white">
              Access &amp; Compliance
            </span>
          </div>
          <p className="mt-2 text-[11px] leading-relaxed text-ink-400">
            Privacy-preserving access decisions on Terminal 3
          </p>
        </div>

        <nav className="flex-1 space-y-1 p-3">
          {NAV.map((item) => {
            const Icon = item.icon;
            const active = view === item.id;
            return (
              <button
                key={item.id}
                onClick={() => setView(item.id)}
                className={`flex w-full items-center gap-2.5 rounded-lg px-3 py-2 text-sm transition ${
                  active
                    ? "bg-white/10 font-semibold text-white"
                    : "text-ink-300 hover:bg-white/5 hover:text-white"
                }`}
              >
                <Icon className="h-4 w-4 shrink-0" aria-hidden />
                {item.label}
              </button>
            );
          })}
        </nav>

        <div className="border-t border-ink-800 p-4">
          <div className="flex items-center gap-2 text-[11px] text-ink-400">
            <span
              className={`h-1.5 w-1.5 shrink-0 rounded-full ${
                status?.state === "connected" ? "bg-emerald-400" : "bg-rose-400"
              }`}
            />
            T3N {status?.state ?? "unknown"} · {status?.environment ?? "—"}
          </div>
          {status?.agent.did && (
            <div className="mt-1.5 break-all font-mono text-[10px] text-ink-500">
              {status.agent.shortDid}
            </div>
          )}
        </div>
      </aside>

      <div className="flex min-w-0 flex-1 flex-col">
        {/* Provenance banner: the single most important thing to never get wrong. */}
        {summary && (
          <div
            className={`flex flex-wrap items-center justify-between gap-2 border-b px-6 py-2.5 text-xs ${
              summary.claimSource.kind === "LIVE_T3N"
                ? "border-sky-200 bg-sky-50 text-sky-900"
                : "border-violet-200 bg-violet-50 text-violet-900"
            }`}
          >
            <div className="flex items-center gap-2">
              <SourceBadge source={summary.claimSource.kind} />
              <span>{summary.claimSource.description}</span>
            </div>
            {status?.enforcementMode && status.enforcementMode !== "UNAVAILABLE" && (
              <span className="font-mono text-[11px] opacity-70">{status.enforcementMode}</span>
            )}
          </div>
        )}

        {/* Mobile nav */}
        <div className="flex gap-1 overflow-x-auto border-b border-ink-200 bg-white px-3 py-2 lg:hidden">
          {NAV.map((item) => (
            <button
              key={item.id}
              onClick={() => setView(item.id)}
              className={`whitespace-nowrap rounded-lg px-3 py-1.5 text-xs transition ${
                view === item.id ? "bg-ink-900 font-semibold text-white" : "text-ink-600"
              }`}
            >
              {item.label}
            </button>
          ))}
        </div>

        <main className="mx-auto w-full max-w-6xl flex-1 px-6 py-8">
          {view === "dashboard" && <Dashboard onOpenAudit={() => setView("audit")} />}
          {view === "request" && <NewRequest />}
          {view === "audit" && <AuditLog />}
          {view === "policies" && <Policies />}
          {view === "t3n" && <T3nStatusPage />}
          {view === "ask" && <Ask />}
        </main>
      </div>
    </div>
  );
}
