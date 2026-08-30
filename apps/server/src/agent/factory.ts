/**
 * Selecting a language-model provider from configuration.
 *
 * Auto-detection is deliberate. The natural-language box is a convenience, and
 * making someone read documentation to discover *which* of their existing keys
 * this project wants is friction with no benefit. If exactly one provider is
 * configured, use it; if several are, `LLM_PROVIDER` settles it.
 *
 * Returning `null` is a first-class outcome, not a failure: no provider means
 * the feature reports itself unavailable and everything else works.
 */

import { createLogger, type Logger } from "@t3n-aca/core";
import { llmKeyHostMismatch, type AppConfig } from "@t3n-aca/t3n";

import { AnthropicProvider } from "./anthropic-provider.ts";
import { OpenAiCompatibleProvider } from "./openai-provider.ts";
import type { LlmProvider } from "./provider.ts";

export function createLlmProvider(
  config: AppConfig,
  logger?: Logger,
): { provider: LlmProvider | null; reason: string | null } {
  const log = logger ?? createLogger("agent:factory");
  const llm = config.llm;

  const hasAnthropic = Boolean(llm.anthropicApiKey);
  const hasOpenAi = Boolean(llm.openaiApiKey);

  if (!hasAnthropic && !hasOpenAi) {
    return {
      provider: null,
      reason:
        "No language-model key is configured. Set OPENAI_API_KEY (works with OpenAI, Gemini, Groq, OpenRouter or a local Ollama) or ANTHROPIC_API_KEY in .env. Every other feature works without it.",
    };
  }

  // Explicit choice wins; otherwise prefer whichever single one is configured.
  const requested = llm.provider;
  const chosen =
    requested !== "auto" ? requested : hasOpenAi ? "openai" : "anthropic";

  if (chosen === "anthropic") {
    if (!llm.anthropicApiKey) {
      return {
        provider: null,
        reason: "LLM_PROVIDER=anthropic but ANTHROPIC_API_KEY is not set.",
      };
    }
    log.info("language model configured", { provider: "anthropic", model: llm.anthropicModel });
    return {
      provider: new AnthropicProvider({
        apiKey: llm.anthropicApiKey,
        model: llm.anthropicModel,
        baseUrl: llm.anthropicBaseUrl,
      }),
      reason: null,
    };
  }

  if (!llm.openaiApiKey) {
    return {
      provider: null,
      reason: "LLM_PROVIDER=openai but OPENAI_API_KEY is not set.",
    };
  }

  const mismatch = llmKeyHostMismatch(llm.openaiApiKey, llm.openaiBaseUrl);
  if (mismatch) log.warn(mismatch);

  // Label by host so the status endpoint says "gemini" rather than a generic
  // "openai-compatible" when that is what it is actually talking to.
  const label = labelForBaseUrl(llm.openaiBaseUrl);
  log.info("language model configured", {
    provider: label,
    model: llm.openaiModel,
    baseUrl: llm.openaiBaseUrl,
  });

  return {
    provider: new OpenAiCompatibleProvider({
      apiKey: llm.openaiApiKey,
      baseUrl: llm.openaiBaseUrl,
      model: llm.openaiModel,
      label,
    }),
    reason: null,
  };
}

function labelForBaseUrl(baseUrl: string): string {
  try {
    const host = new URL(baseUrl).hostname;
    if (host.includes("googleapis")) return "gemini";
    if (host.includes("openai.com")) return "openai";
    if (host.includes("groq")) return "groq";
    if (host.includes("openrouter")) return "openrouter";
    if (host === "localhost" || host === "127.0.0.1") return "local";
    return host;
  } catch {
    return "openai-compatible";
  }
}
