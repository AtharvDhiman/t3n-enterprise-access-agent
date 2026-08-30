/**
 * The language-model provider boundary.
 *
 * ## Why this abstraction exists
 *
 * The natural-language layer is a convenience, not the product. Binding it to
 * one vendor's SDK would mean that whoever inherits this repo must hold *that
 * vendor's* credential to use a feature that has nothing to do with the
 * compliance logic. So the agent loop talks to this interface, and providers
 * are small adapters behind it.
 *
 * Two are shipped:
 *   - `anthropic`  — Claude, via the official SDK.
 *   - `openai`     — anything speaking OpenAI-compatible chat completions with
 *                    tool calling: OpenAI itself, Google Gemini (via its
 *                    OpenAI-compatible endpoint), Groq, OpenRouter, a local
 *                    Ollama. One adapter, many backends, no new dependency.
 *
 * ## What a provider may and may not do
 *
 * A provider translates messages and tool calls. It has no access to the policy
 * engine, cannot reach the claim sources, and never sees a credential beyond
 * its own. Swapping providers cannot change a decision, because no provider can
 * make one — see `tools.ts`.
 */

/** A tool invocation requested by the model, in provider-neutral form. */
export interface LlmToolCall {
  /** Provider-assigned id, echoed back with the result. */
  id: string;
  name: string;
  input: unknown;
}

/** One model turn: some text, and/or some tool calls. */
export interface LlmTurn {
  text: string;
  toolCalls: LlmToolCall[];
}

/** The outcome of running one tool, fed back to the model. */
export interface LlmToolResult {
  id: string;
  /** JSON-encoded result, or a safe error object. */
  content: string;
  isError: boolean;
}

/** Tool schema handed to the model. Mirrors JSON Schema. */
export interface LlmToolSchema {
  name: string;
  description: string;
  input_schema: Record<string, unknown>;
}

/**
 * A single conversation.
 *
 * Each provider keeps its own native message history internally, so the shared
 * agent loop never has to know whether it is talking to content blocks or
 * `tool_calls` arrays.
 */
export interface LlmConversation {
  /** Ask the model for its next turn. */
  next(): Promise<LlmTurn>;
  /** Record tool results so the next `next()` can see them. */
  addToolResults(results: LlmToolResult[]): void;
}

/**
 * A prior exchange, replayed so a follow-up has context.
 *
 * Only the *text* of earlier turns is carried, not their tool calls. That is
 * enough for the case this exists to serve — the model asks a clarifying
 * question and the user answers it — without replaying tool state the engine
 * has already acted on. Every tool call is re-issued fresh against live data,
 * so an answer can never be assembled from a stale earlier result.
 */
export interface LlmHistoryTurn {
  role: "user" | "assistant";
  content: string;
}

export interface LlmProvider {
  /** Provider id, surfaced in `/api/agent/status` for transparency. */
  readonly name: string;
  readonly model: string;
  start(
    systemPrompt: string,
    userMessage: string,
    tools: readonly LlmToolSchema[],
    history?: readonly LlmHistoryTurn[],
  ): LlmConversation;
}

/** Raised when a provider cannot be reached or replies unusably. */
export class LlmProviderError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "LlmProviderError";
  }
}
