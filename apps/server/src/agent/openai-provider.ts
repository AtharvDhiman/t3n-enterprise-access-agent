/**
 * OpenAI-compatible provider.
 *
 * Implemented with plain `fetch` rather than a vendor SDK, deliberately: the
 * chat-completions wire format is small and stable, and this keeps the
 * dependency list honest — one adapter serves OpenAI, Google Gemini (via its
 * OpenAI-compatible endpoint), Groq, OpenRouter, Together and a local Ollama
 * without adding a single package.
 *
 * Verified against OpenAI (`gpt-4o-mini`) and Gemini
 * (`https://generativelanguage.googleapis.com/v1beta/openai`, `gemini-2.5-flash`).
 */

import {
  LlmProviderError,
  type LlmConversation,
  type LlmProvider,
  type LlmToolCall,
  type LlmToolResult,
  type LlmHistoryTurn,
  type LlmToolSchema,
  type LlmTurn,
} from "./provider.ts";

interface ChatMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string | null;
  tool_calls?: Array<{
    id: string;
    type: "function";
    function: { name: string; arguments: string };
  }>;
  tool_call_id?: string;
}

const REQUEST_TIMEOUT_MS = 60_000;

/** Translate our neutral tool schema into OpenAI's `function` shape. */
function toOpenAiTools(tools: readonly LlmToolSchema[]): unknown[] {
  return tools.map((t) => ({
    type: "function",
    function: {
      name: t.name,
      description: t.description,
      parameters: t.input_schema,
    },
  }));
}

class OpenAiConversation implements LlmConversation {
  private readonly messages: ChatMessage[];
  private readonly tools: unknown[];

  constructor(
    private readonly baseUrl: string,
    private readonly apiKey: string,
    private readonly model: string,
    systemPrompt: string,
    userMessage: string,
    tools: readonly LlmToolSchema[],
    history: readonly LlmHistoryTurn[] = [],
  ) {
    this.messages = [
      { role: "system", content: systemPrompt },
      ...history.map((h) => ({ role: h.role, content: h.content }) as ChatMessage),
      { role: "user", content: userMessage },
    ];
    this.tools = toOpenAiTools(tools);
  }

  addToolResults(results: LlmToolResult[]): void {
    for (const r of results) {
      this.messages.push({
        role: "tool",
        tool_call_id: r.id,
        content: r.content,
      });
    }
  }

  async next(): Promise<LlmTurn> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

    let response: Response;
    try {
      response = await fetch(`${this.baseUrl}/chat/completions`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${this.apiKey}`,
        },
        body: JSON.stringify({
          model: this.model,
          messages: this.messages,
          tools: this.tools,
          tool_choice: "auto",
          max_tokens: 1500,
        }),
        signal: controller.signal,
      });
    } catch (err) {
      throw new LlmProviderError(
        controller.signal.aborted
          ? "the language model did not respond in time"
          : "could not reach the language model",
        { cause: err },
      );
    }
    // NOTE: the timer is deliberately NOT cleared here. `fetch` resolves as
    // soon as the headers arrive, so clearing it at this point left the body
    // read completely unbounded — a provider that sent headers and then stalled
    // held the request open indefinitely, and REQUEST_TIMEOUT_MS bounded
    // nothing that mattered. It is cleared after the body has been consumed.

    if (!response.ok) {
      // Read the status only. The body can echo back the prompt — which may
      // contain a subject reference — and could carry provider account detail;
      // neither belongs in our logs or in an error a user might see.
      throw new LlmProviderError(
        `the language model rejected the request (HTTP ${response.status})`,
      );
    }

    let body: {
      choices?: Array<{
        message?: {
          content?: string | null;
          tool_calls?: Array<{ id: string; function: { name: string; arguments: string } }>;
        };
      }>;
    };
    try {
      body = (await response.json()) as typeof body;
    } catch (err) {
      throw new LlmProviderError(
        controller.signal.aborted
          ? "the language model did not finish responding in time"
          : "the language model returned an unreadable response",
        { cause: err },
      );
    } finally {
      clearTimeout(timer);
    }

    const message = body.choices?.[0]?.message;
    if (!message) {
      throw new LlmProviderError("the language model returned no message");
    }

    const rawCalls = message.tool_calls ?? [];
    const toolCalls: LlmToolCall[] = rawCalls.map((c) => {
      let input: unknown = {};
      try {
        // Arguments arrive as a JSON *string*. A model can emit malformed JSON;
        // treating that as an empty object lets tool-input validation produce
        // the real, specific error rather than crashing the turn here.
        input = c.function.arguments ? JSON.parse(c.function.arguments) : {};
      } catch {
        input = {};
      }
      return { id: c.id, name: c.function.name, input };
    });

    // Echo the assistant turn back into history so the follow-up request is
    // well-formed; OpenAI requires the tool_calls message to precede its
    // tool results.
    this.messages.push({
      role: "assistant",
      content: message.content ?? null,
      ...(rawCalls.length > 0
        ? {
            tool_calls: rawCalls.map((c) => ({
              id: c.id,
              type: "function" as const,
              function: { name: c.function.name, arguments: c.function.arguments },
            })),
          }
        : {}),
    });

    return { text: (message.content ?? "").trim(), toolCalls };
  }
}

export class OpenAiCompatibleProvider implements LlmProvider {
  readonly name: string;
  readonly model: string;
  private readonly baseUrl: string;
  private readonly apiKey: string;

  constructor(params: { apiKey: string; baseUrl: string; model: string; label?: string }) {
    this.apiKey = params.apiKey;
    // Trailing slashes are a classic source of `//chat/completions` 404s.
    this.baseUrl = params.baseUrl.replace(/\/+$/, "");
    this.model = params.model;
    this.name = params.label ?? "openai-compatible";
  }

  start(
    systemPrompt: string,
    userMessage: string,
    tools: readonly LlmToolSchema[],
    history: readonly LlmHistoryTurn[] = [],
  ): LlmConversation {
    return new OpenAiConversation(
      this.baseUrl,
      this.apiKey,
      this.model,
      systemPrompt,
      userMessage,
      tools,
      history,
    );
  }
}
