/**
 * Configurable LLM provider.
 *
 * One call shape (`completeJson`) over two wire formats (OpenAI-compatible
 * chat completions, Anthropic messages). Groq is OpenAI-compatible, so it is
 * the same client with a different base URL - no second SDK, no second wire
 * format to keep in sync.
 *
 * With no credentials the client is `UnconfiguredLlm`, which throws
 * `capability_unavailable` instead of guessing - every caller has a
 * deterministic fallback and reports which path it used.
 */
import { CopilotError, envValue } from "@copilot/shared";

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
      "No LLM provider configured. Set GROQ_API_KEY (or LLM_PROVIDER with OPENAI_API_KEY / ANTHROPIC_API_KEY) to enable model-based reasoning. The copilot falls back to deterministic intent parsing and says so.",
      503,
    );
  }
}

/**
 * A provider answered, but not with what we asked for.
 *
 * Kept separate from a transport failure so the caller can say "rate limited"
 * instead of "model unavailable": they need different responses from a human.
 */
class ProviderError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly body: string,
  ) {
    super(message);
    this.name = "ProviderError";
  }

  get rateLimited(): boolean {
    return this.status === 429;
  }

  get retryable(): boolean {
    return this.status === 429 || this.status >= 500;
  }
}

class OpenAICompatLlm implements LlmClient {
  constructor(
    readonly provider: string,
    readonly model: string,
    private readonly apiKey: string,
    private readonly baseUrl: string,
    /** Groq deprecates `max_tokens` in favour of `max_completion_tokens`. */
    private readonly tokenField: "max_tokens" | "max_completion_tokens" = "max_tokens",
  ) {}

  async completeJson(input: {
    system: string;
    user: string;
    maxTokens?: number;
    timeoutMs?: number;
  }): Promise<{ text: string; modelCalls: number }> {
    // One retry, only for the two cases where retrying is not a lie: the
    // provider said "slow down" (429) or had a server fault (5xx).
    let attempt = 0;
    for (;;) {
      try {
        return await this.once(input);
      } catch (error) {
        const retryable = error instanceof ProviderError && error.retryable;
        if (!retryable || attempt >= 1) throw error;
        attempt += 1;
        await new Promise((resolve) => setTimeout(resolve, 600));
      }
    }
  }

  private async once(input: {
    system: string;
    user: string;
    maxTokens?: number;
    timeoutMs?: number;
  }): Promise<{ text: string; modelCalls: number }> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), input.timeoutMs ?? 30_000);
    const body = (jsonMode: boolean): string =>
      JSON.stringify({
        model: this.model,
        temperature: 0,
        [this.tokenField]: input.maxTokens ?? 800,
        ...(jsonMode ? { response_format: { type: "json_object" } } : {}),
        messages: [
          { role: "system", content: input.system },
          { role: "user", content: input.user },
        ],
      });
    try {
      let response = await this.post(body(true), controller.signal);
      // Some models (and older endpoints) reject `response_format`. The parser
      // already copes with fenced JSON, so falling back is safe rather than
      // silently degrading accuracy.
      if (response.status === 400) {
        const detail = await response.text();
        if (/response_format|json_object/i.test(detail)) {
          response = await this.post(body(false), controller.signal);
        } else {
          throw this.failure(400, detail);
        }
      }
      if (!response.ok) throw this.failure(response.status, await response.text());
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

  private post(body: string, signal: AbortSignal): Promise<Response> {
    return fetch(`${this.baseUrl}/chat/completions`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${this.apiKey}`,
      },
      signal,
      body,
    });
  }

  private failure(status: number, detail: string): ProviderError {
    const snippet = detail.slice(0, 240);
    const hint =
      status === 401 || status === 403
        ? ` (check the ${this.provider} API key)`
        : status === 429
          ? " (provider rate limit)"
          : status === 404
            ? ` (model "${this.model}" is not available to this key)`
            : "";
    return new ProviderError(
      `${this.provider} returned HTTP ${status}${hint}: ${snippet}`,
      status,
      snippet,
    );
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

/** Default Groq model: verified available to a real key (see PHASE5_VALIDATION). */
export const DEFAULT_GROQ_MODEL = "openai/gpt-oss-120b";

export function configuredLlm(): LlmClient {
  const explicit = (envValue("LLM_PROVIDER") ?? "").toLowerCase();
  const model = envValue("LLM_MODEL");
  // `GROQ_API_KEY` alone is enough: it is the provider this project ships with,
  // and requiring a second variable to activate it would be a trap.
  const provider = explicit || (envValue("GROQ_API_KEY") ? "groq" : "");
  if (provider === "groq" && envValue("GROQ_API_KEY")) {
    return new OpenAICompatLlm(
      "groq",
      model ?? envValue("GROQ_MODEL") ?? DEFAULT_GROQ_MODEL,
      envValue("GROQ_API_KEY")!,
      envValue("GROQ_BASE_URL") ?? "https://api.groq.com/openai/v1",
      "max_completion_tokens",
    );
  }
  if (provider === "openai" && envValue("OPENAI_API_KEY")) {
    return new OpenAICompatLlm(
      "openai",
      model ?? "gpt-4o-mini",
      envValue("OPENAI_API_KEY")!,
      envValue("OPENAI_BASE_URL") ?? "https://api.openai.com/v1",
    );
  }
  if (provider === "anthropic" && envValue("ANTHROPIC_API_KEY")) {
    return new AnthropicLlm(model ?? "claude-3-5-sonnet-latest", envValue("ANTHROPIC_API_KEY")!);
  }
  if (provider === "openai-compatible" && envValue("LLM_API_KEY") && envValue("LLM_BASE_URL")) {
    return new OpenAICompatLlm(
      "openai-compatible",
      model ?? "default",
      envValue("LLM_API_KEY")!,
      envValue("LLM_BASE_URL")!,
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
    detail: `Model reasoning enabled via ${client.provider} (${client.model}); if a call fails, the plan says so and falls back to deterministic parsing.`,
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
