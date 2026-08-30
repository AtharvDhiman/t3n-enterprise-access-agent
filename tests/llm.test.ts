/**
 * The language-model provider layer.
 *
 * The point of these tests is not that the model says the right thing — that
 * cannot be asserted offline, and is not a property the product depends on.
 * It is that provider *selection* behaves predictably, that a missing or
 * mismatched credential produces a useful message rather than a bare HTTP
 * error, and that swapping providers cannot widen what the agent can do.
 */

import { describe, expect, it } from "vitest";

import { llmKeyHostMismatch, loadLlmConfig, type AppConfig } from "@t3n-aca/t3n";
import { createLlmProvider } from "../apps/server/src/agent/factory";
import { TOOL_DEFINITIONS } from "../apps/server/src/agent/tools";

function appConfig(llm: Partial<AppConfig["llm"]>): AppConfig {
  return {
    claimSource: "demo",
    t3n: null,
    t3nConfigError: null,
    t3nWarnings: [],
    auditLogPath: "./data/test.jsonl",
    auditSalt: "s",
    port: 0,
    llm: {
      provider: "auto",
      openaiApiKey: null,
      openaiBaseUrl: "https://api.openai.com/v1",
      openaiModel: "gpt-4o-mini",
      anthropicApiKey: null,
      anthropicBaseUrl: null,
      anthropicModel: "claude-sonnet-4-5",
      ...llm,
    },
  };
}

describe("configuration", () => {
  it("defaults to OpenAI's endpoint when none is given", () => {
    const llm = loadLlmConfig({});
    expect(llm.openaiBaseUrl).toBe("https://api.openai.com/v1");
    expect(llm.provider).toBe("auto");
  });

  it("accepts any OpenAI-compatible endpoint", () => {
    const llm = loadLlmConfig({
      OPENAI_BASE_URL: "https://generativelanguage.googleapis.com/v1beta/openai",
      OPENAI_MODEL: "gemini-2.5-flash",
    });
    expect(llm.openaiBaseUrl).toContain("googleapis");
    expect(llm.openaiModel).toBe("gemini-2.5-flash");
  });

  it("falls back to auto for an unrecognised LLM_PROVIDER", () => {
    expect(loadLlmConfig({ LLM_PROVIDER: "hal9000" }).provider).toBe("auto");
  });

  it("prefers LLM_* over OPENAI_*, so an ambient OPENAI_API_KEY cannot hijack it", () => {
    // The motivating case: OPENAI_API_KEY set machine-wide beats .env, because
    // dotenv never overrides an existing variable. A project-scoped name wins
    // back control without anyone editing their system environment.
    const llm = loadLlmConfig({
      OPENAI_API_KEY: "sk-ambient-machine-wide",
      OPENAI_BASE_URL: "https://api.openai.com/v1",
      OPENAI_MODEL: "gpt-4o-mini",
      LLM_API_KEY: "project-key",
      LLM_BASE_URL: "https://generativelanguage.googleapis.com/v1beta/openai",
      LLM_MODEL: "gemini-2.5-flash",
    });
    expect(llm.openaiApiKey).toBe("project-key");
    expect(llm.openaiBaseUrl).toContain("googleapis");
    expect(llm.openaiModel).toBe("gemini-2.5-flash");
  });

  it("still honours OPENAI_* when no LLM_* equivalent is set", () => {
    const llm = loadLlmConfig({ OPENAI_API_KEY: "sk-only", OPENAI_MODEL: "gpt-4.1-mini" });
    expect(llm.openaiApiKey).toBe("sk-only");
    expect(llm.openaiModel).toBe("gpt-4.1-mini");
  });
});

describe("provider selection", () => {
  it("reports unavailable, with a reason, when no key is configured", () => {
    const { provider, reason } = createLlmProvider(appConfig({}));
    expect(provider).toBeNull();
    expect(reason).toContain("OPENAI_API_KEY");
  });

  it("selects OpenAI-compatible when only that key is present", () => {
    const { provider } = createLlmProvider(appConfig({ openaiApiKey: "sk-test" }));
    expect(provider?.name).toBe("openai");
  });

  it("selects Anthropic when only that key is present", () => {
    const { provider } = createLlmProvider(appConfig({ anthropicApiKey: "sk-ant-test" }));
    expect(provider?.name).toBe("anthropic");
  });

  it("honours an explicit LLM_PROVIDER when both keys are present", () => {
    const both = { openaiApiKey: "sk-test", anthropicApiKey: "sk-ant-test" };
    expect(createLlmProvider(appConfig({ ...both, provider: "anthropic" })).provider?.name).toBe(
      "anthropic",
    );
    expect(createLlmProvider(appConfig({ ...both, provider: "openai" })).provider?.name).toBe(
      "openai",
    );
  });

  it("explains itself when the requested provider has no key", () => {
    const { provider, reason } = createLlmProvider(
      appConfig({ provider: "anthropic", openaiApiKey: "sk-test" }),
    );
    expect(provider).toBeNull();
    expect(reason).toContain("ANTHROPIC_API_KEY");
  });

  it("labels the backend by host, so status reports what it really talks to", () => {
    const gemini = createLlmProvider(
      appConfig({
        openaiApiKey: "k",
        openaiBaseUrl: "https://generativelanguage.googleapis.com/v1beta/openai",
      }),
    );
    expect(gemini.provider?.name).toBe("gemini");

    const local = createLlmProvider(
      appConfig({ openaiApiKey: "k", openaiBaseUrl: "http://localhost:11434/v1" }),
    );
    expect(local.provider?.name).toBe("local");
  });
});

describe("key / endpoint mismatch detection", () => {
  // This exact mistake cost real debugging time: an OpenAI key exported in the
  // shell shadowed the .env value and was sent to Google, which replied with a
  // bare HTTP 400.
  it("flags an OpenAI key pointed at a non-OpenAI host", () => {
    const warning = llmKeyHostMismatch(
      "sk-proj-abc",
      "https://generativelanguage.googleapis.com/v1beta/openai",
    );
    expect(warning).toContain("googleapis");
    expect(warning).toContain("shell");
  });

  it("flags a non-OpenAI key pointed at OpenAI", () => {
    expect(llmKeyHostMismatch("AQ.Ab8-token", "https://api.openai.com/v1")).toContain(
      "does not look like an OpenAI key",
    );
  });

  it("stays quiet when they agree", () => {
    expect(llmKeyHostMismatch("sk-proj-abc", "https://api.openai.com/v1")).toBeNull();
    expect(llmKeyHostMismatch("gsk_abc", "https://api.groq.com/openai/v1")).toBeNull();
  });

  it("stays quiet when there is no key to judge", () => {
    expect(llmKeyHostMismatch(null, "https://api.openai.com/v1")).toBeNull();
  });
});

describe("the tool surface is provider-independent", () => {
  it("offers every provider the same five tools, none of which can grant access", () => {
    // Swapping providers must not widen capability: the tool list is defined
    // once and handed to whichever backend is configured.
    const names = TOOL_DEFINITIONS.map((t) => t.name);
    expect(names).toHaveLength(5);
    expect(names).not.toContain("approve_request");
    expect(names).not.toContain("grant_access");
    expect(names).not.toContain("override_policy");
  });

  it("describes tools in a shape both providers can consume", () => {
    for (const tool of TOOL_DEFINITIONS) {
      // Lower snake_case, digits allowed (`get_t3n_status`). Some providers
      // reject function names outside this character set.
      expect(tool.name).toMatch(/^[a-z][a-z0-9_]*$/);
      expect(tool.description.length).toBeGreaterThan(20);
      expect(tool.input_schema).toHaveProperty("type", "object");
      expect(tool.input_schema).toHaveProperty("properties");
    }
  });
});

describe("conversation history", () => {
  // Regression: the model would ask a clarifying question the user could never
  // answer, because every message started a fresh conversation.
  it("replays prior turns into the provider", async () => {
    const seen: unknown[] = [];
    const fake = {
      name: "fake",
      model: "fake-1",
      start(_system: string, _user: string, _tools: readonly unknown[], history?: unknown) {
        seen.push(history);
        return {
          next: async () => ({ text: "ok", toolCalls: [] }),
          addToolResults: () => {},
        };
      },
    };

    const { ComplianceAgent } = await import("../apps/server/src/agent/agent");
    const agent = new ComplianceAgent(fake as never);
    await agent.run("he is an employee", { service: null as never, actor: "test" }, [
      { role: "user", content: "can Ben get access?" },
      { role: "assistant", content: "What is Ben's subject type?" },
    ]);

    expect(seen[0]).toEqual([
      { role: "user", content: "can Ben get access?" },
      { role: "assistant", content: "What is Ben's subject type?" },
    ]);
  });

  it("defaults to no history, so a first message carries nothing", async () => {
    const seen: unknown[] = [];
    const fake = {
      name: "fake",
      model: "fake-1",
      start(_s: string, _u: string, _t: readonly unknown[], history?: unknown) {
        seen.push(history);
        return { next: async () => ({ text: "ok", toolCalls: [] }), addToolResults: () => {} };
      },
    };
    const { ComplianceAgent } = await import("../apps/server/src/agent/agent");
    await new ComplianceAgent(fake as never).run("hello", {
      service: null as never,
      actor: "test",
    });
    expect(seen[0]).toEqual([]);
  });
});
