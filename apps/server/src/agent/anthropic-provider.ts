/**
 * Anthropic provider.
 *
 * Uses the official SDK, which was already a dependency. Kept alongside the
 * OpenAI-compatible adapter so a deployment holding a Claude key needs no
 * configuration gymnastics.
 */

import Anthropic from "@anthropic-ai/sdk";

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

class AnthropicConversation implements LlmConversation {
  private readonly messages: Anthropic.MessageParam[];

  constructor(
    private readonly client: Anthropic,
    private readonly model: string,
    private readonly systemPrompt: string,
    userMessage: string,
    private readonly tools: readonly LlmToolSchema[],
    history: readonly LlmHistoryTurn[] = [],
  ) {
    this.messages = [
      ...history.map((h) => ({ role: h.role, content: h.content }) as Anthropic.MessageParam),
      { role: "user", content: userMessage },
    ];
  }

  addToolResults(results: LlmToolResult[]): void {
    this.messages.push({
      role: "user",
      content: results.map((r) => ({
        type: "tool_result" as const,
        tool_use_id: r.id,
        content: r.content,
        ...(r.isError ? { is_error: true } : {}),
      })),
    });
  }

  async next(): Promise<LlmTurn> {
    let response: Anthropic.Message;
    try {
      response = await this.client.messages.create({
        model: this.model,
        max_tokens: 1500,
        system: this.systemPrompt,
        tools: this.tools as unknown as Anthropic.Tool[],
        messages: this.messages,
      });
    } catch (err) {
      throw new LlmProviderError("could not reach the language model", { cause: err });
    }

    const toolUses = response.content.filter(
      (b): b is Anthropic.ToolUseBlock => b.type === "tool_use",
    );

    if (toolUses.length > 0) {
      // Preserve the assistant turn verbatim; the API requires each
      // tool_result to reference a tool_use it can still see.
      this.messages.push({ role: "assistant", content: response.content });
    }

    const text = response.content
      .filter((b): b is Anthropic.TextBlock => b.type === "text")
      .map((b) => b.text)
      .join("\n")
      .trim();

    const toolCalls: LlmToolCall[] = toolUses.map((u) => ({
      id: u.id,
      name: u.name,
      input: u.input,
    }));

    return { text, toolCalls };
  }
}

export class AnthropicProvider implements LlmProvider {
  readonly name = "anthropic";
  readonly model: string;
  private readonly client: Anthropic;

  constructor(params: { apiKey: string; model: string; baseUrl?: string | null }) {
    this.model = params.model;
    this.client = new Anthropic({
      apiKey: params.apiKey,
      ...(params.baseUrl ? { baseURL: params.baseUrl } : {}),
    });
  }

  start(
    systemPrompt: string,
    userMessage: string,
    tools: readonly LlmToolSchema[],
    history: readonly LlmHistoryTurn[] = [],
  ): LlmConversation {
    return new AnthropicConversation(
      this.client,
      this.model,
      systemPrompt,
      userMessage,
      tools,
      history,
    );
  }
}
