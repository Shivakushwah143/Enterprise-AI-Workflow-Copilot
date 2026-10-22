/**
 * Configurable LLM provider.
 *
 * One call shape (`completeJson`) over two wire formats (OpenAI-compatible
 * chat completions, Anthropic messages). With no credentials the client is
 * `UnconfiguredLlm`, which throws `capability_unavailable` instead of guessing
 * - every caller has a deterministic fallback and reports which path it used.
 */
import { CopilotError } from "@copilot/shared";

export interface LlmStatus {
  provider: string | null;
  model: string | null;
  status: "configured" | "unconfigured";
  detail: string;
}

export interface LlmClient {
  readonly provider: string;
  readonly model: string;
  completeJson(input: {
    system: string;
    user: string;
    maxTokens?: number;
    timeoutMs?: number;
  }): Promise<{ text: string; modelCalls: number }>;
}

class UnconfiguredLlm implements LlmClient {
  readonly provider = "none";
  readonly model = "none";

  async completeJson(): Promise<{ text: string; modelCalls: number }> {
    throw new CopilotError(
      "capability_unavailable",
      "No LLM provider configured. Set LLM_PROVIDER and an API key (OPENAI_API_KEY / ANTHROPIC_API_KEY) to enable model-based reasoning. The copilot falls back to deterministic intent parsing.",
      503,
    );
  }
}

class OpenAICompatLlm implements LlmClient {
  constructor(
    readonly provider: string,
    readonly model: string,
    private readonly apiKey: string,
    private readonly baseUrl: string,
  ) {}

  async completeJson(input: {
    system: string;
    user: string;
    maxTokens?: number;
    timeoutMs?: number;
  }): Promise<{ text: string; modelCalls: number }> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), input.timeoutMs ?? 30_000);
    try {
      const response = await fetch(`${this.baseUrl}/chat/completions`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${this.apiKey}`,
        },
        signal: controller.signal,
        body: JSON.stringify({
          model: this.model,
          temperature: 0,
          max_tokens: input.maxTokens ?? 800,
          response_format: { type: "json_object" },
          messages: [
            { role: "system", content: input.system },
            { role: "user", content: input.user },
          ],
        }),
      });
      if (!response.ok) {
        throw new Error(`LLM returned HTTP ${response.status}`);
      }
      const payload = (await response.json()) as {
        choices?: { message?: { content?: string } }[];
      };
      const text = payload.choices?.[0]?.message?.content ?? "";
      if (!text) throw new Error("LLM returned an empty completion");
      return { text, modelCalls: 1 };
    } finally {
      clearTimeout(timer);
    }
  }
}

class AnthropicLlm implements LlmClient {
  readonly provider = "anthropic";

  constructor(
    readonly model: string,
    private readonly apiKey: string,
  ) {}

  async completeJson(input: {
    system: string;
    user: string;
    maxTokens?: number;
    timeoutMs?: number;
  }): Promise<{ text: string; modelCalls: number }> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), input.timeoutMs ?? 30_000);
    try {
      const response = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-api-key": this.apiKey,
          "anthropic-version": "2023-06-01",
        },
        signal: controller.signal,
        body: JSON.stringify({
          model: this.model,
          max_tokens: input.maxTokens ?? 800,
          temperature: 0,
          system: `${input.system}\nReply with a single JSON object and nothing else.`,
          messages: [{ role: "user", content: input.user }],
        }),
      });
      if (!response.ok) {
        throw new Error(`LLM returned HTTP ${response.status}`);
      }
      const payload = (await response.json()) as {
        content?: { type: string; text?: string }[];
      };
      const text =
        payload.content?.filter((c) => c.type === "text").map((c) => c.text ?? "").join("") ??
        "";
      if (!text) throw new Error("LLM returned an empty completion");
      return { text, modelCalls: 1 };
    } finally {
      clearTimeout(timer);
    }
  }
}

export function configuredLlm(): LlmClient {
  const provider = (process.env.LLM_PROVIDER ?? "").toLowerCase();
  const model = process.env.LLM_MODEL;
  if (provider === "openai" && process.env.OPENAI_API_KEY) {
    return new OpenAICompatLlm(
      "openai",
      model ?? "gpt-4o-mini",
      process.env.OPENAI_API_KEY,
      process.env.OPENAI_BASE_URL ?? "https://api.openai.com/v1",
    );
  }
  if (provider === "anthropic" && process.env.ANTHROPIC_API_KEY) {
    return new AnthropicLlm(model ?? "claude-3-5-sonnet-latest", process.env.ANTHROPIC_API_KEY);
  }
  if (provider === "openai-compatible" && process.env.LLM_API_KEY && process.env.LLM_BASE_URL) {
    return new OpenAICompatLlm(
      "openai-compatible",
      model ?? "default",
      process.env.LLM_API_KEY,
      process.env.LLM_BASE_URL,
    );
  }
  return new UnconfiguredLlm();
}

export function llmStatus(client: LlmClient = configuredLlm()): LlmStatus {
  if (client.provider === "none") {
    return {
      provider: null,
      model: null,
      status: "unconfigured",
      detail:
        "No LLM configured. Intent parsing is deterministic (rule-based) and reported as such; no model calls are made.",
    };
  }
  return {
    provider: client.provider,
    model: client.model,
    status: "configured",
    detail: `Model reasoning enabled via ${client.provider} (${client.model}).`,
  };
}

/** Strip markdown fences and parse the first JSON object in a completion. */
export function parseJsonObject(text: string): unknown {
  const trimmed = text.trim().replace(/^```(?:json)?/i, "").replace(/```$/, "").trim();
  try {
    return JSON.parse(trimmed);
  } catch {
    const start = trimmed.indexOf("{");
    const end = trimmed.lastIndexOf("}");
    if (start >= 0 && end > start) {
      return JSON.parse(trimmed.slice(start, end + 1));
    }
    throw new Error("LLM completion was not JSON");
  }
}
