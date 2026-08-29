import { useEffect, useRef, useState } from "react";
import { Send, Sparkles, Wrench } from "lucide-react";

import { api, ApiError, type AgentTurn } from "../lib/api";
import { Card, EmptyState, ErrorNotice } from "../components/ui";

interface Message {
  role: "user" | "assistant";
  text: string;
  tools?: Array<{ name: string; ok: boolean }>;
}

const EXAMPLES = [
  "Can Alice get read access to the employee dashboard?",
  "Which policies are configured?",
  "Can Dara get admin access to the production database, and why?",
  "Show me every request that was denied.",
];

export function Ask() {
  const [available, setAvailable] = useState<boolean | null>(null);
  const [reason, setReason] = useState<string | null>(null);
  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<ApiError | null>(null);
  const endRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    void api
      .agentStatus()
      .then((s) => {
        setAvailable(s.available);
        setReason(s.reason);
      })
      .catch(() => setAvailable(false));
  }, []);

  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages]);

  async function send(text: string) {
    const message = text.trim();
    if (message === "" || busy) return;
    setMessages((m) => [...m, { role: "user", text: message }]);
    setInput("");
    setBusy(true);
    setError(null);
    try {
      const turn: AgentTurn = await api.ask(message);
      setMessages((m) => [
        ...m,
        { role: "assistant", text: turn.reply, tools: turn.toolsUsed },
      ]);
    } catch (err) {
      if (err instanceof ApiError) setError(err);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-6">
      <header>
        <h1 className="text-2xl font-bold tracking-tight text-ink-900">Ask in plain English</h1>
        <p className="mt-1 text-sm text-ink-600">
          The model interprets your question and explains the result. It cannot make or change a
          decision — the deterministic policy engine does that, and the model can only report what
          the engine returned.
        </p>
      </header>

      {available === false && (
        <ErrorNotice
          message="The natural-language layer is not enabled."
          remediation={reason ?? "Set ANTHROPIC_API_KEY in .env and restart the server."}
        />
      )}

      {available && (
        <>
          <Card title="Conversation">
            {messages.length === 0 ? (
              <div className="space-y-4">
                <EmptyState title="Ask a question to get started" />
                <div className="flex flex-wrap gap-2">
                  {EXAMPLES.map((e) => (
                    <button
                      key={e}
                      onClick={() => void send(e)}
                      className="rounded-full border border-ink-300 px-3 py-1.5 text-xs text-ink-700 transition hover:border-ink-500 hover:bg-ink-50"
                    >
                      {e}
                    </button>
                  ))}
                </div>
              </div>
            ) : (
              <div className="space-y-4">
                {messages.map((m, i) => (
                  <div
                    key={`${m.role}-${i}`}
                    className={m.role === "user" ? "flex justify-end" : "flex justify-start"}
                  >
                    <div
                      className={`max-w-[85%] rounded-2xl px-4 py-3 text-sm leading-relaxed ${
                        m.role === "user"
                          ? "bg-ink-900 text-white"
                          : "border border-ink-200 bg-white text-ink-800"
                      }`}
                    >
                      {m.role === "assistant" && (
                        <div className="mb-1.5 flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wide text-ink-400">
                          <Sparkles className="h-3 w-3" aria-hidden />
                          Agent
                        </div>
                      )}
                      <p className="whitespace-pre-wrap">{m.text}</p>
                      {m.tools && m.tools.length > 0 && (
                        <div className="mt-2.5 flex flex-wrap items-center gap-1.5 border-t border-ink-100 pt-2">
                          <Wrench className="h-3 w-3 text-ink-400" aria-hidden />
                          {m.tools.map((t, ti) => (
                            <span
                              key={`${t.name}-${ti}`}
                              className={`rounded px-1.5 py-0.5 font-mono text-[10px] ${
                                t.ok ? "bg-ink-100 text-ink-600" : "bg-rose-100 text-rose-700"
                              }`}
                            >
                              {t.name}
                            </span>
                          ))}
                        </div>
                      )}
                    </div>
                  </div>
                ))}
                {busy && <p className="text-xs text-ink-500">Thinking…</p>}
                <div ref={endRef} />
              </div>
            )}
          </Card>

          {error && <ErrorNotice message={error.message} remediation={error.remediation} />}

          <form
            onSubmit={(e) => {
              e.preventDefault();
              void send(input);
            }}
            className="flex gap-2"
          >
            <input
              value={input}
              onChange={(e) => setInput(e.target.value)}
              placeholder="Ask about an access request, a policy, or a past decision…"
              className="flex-1 rounded-lg border border-ink-300 bg-white px-4 py-2.5 text-sm shadow-sm outline-none transition focus:border-ink-500 focus:ring-2 focus:ring-ink-900/10"
            />
            <button
              type="submit"
              disabled={busy || input.trim() === ""}
              className="inline-flex items-center gap-2 rounded-lg bg-ink-900 px-4 py-2.5 text-sm font-semibold text-white transition hover:bg-ink-800 disabled:opacity-40"
            >
              <Send className="h-4 w-4" aria-hidden />
              Send
            </button>
          </form>
        </>
      )}
    </div>
  );
}
