import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  describeUrl,
  envUrl,
  envValue,
  findEnvFile,
  isConfiguredValue,
  loadProjectEnv,
  parseDotEnv,
} from "@copilot/shared";
import { configuredLlm, llmStatus, parseJsonObject } from "@copilot/agent";

const touched: string[] = [];
afterEach(async () => {
  for (const dir of touched.splice(0)) await rm(dir, { recursive: true, force: true });
  vi.unstubAllGlobals();
  delete process.env["GROQ_API_KEY"];
  delete process.env["LLM_PROVIDER"];
  delete process.env["LLM_MODEL"];
});

describe("environment loading", () => {
  it("parses values, comments, quotes and export", () => {
    const parsed = parseDotEnv(
      [
        "# a comment",
        "PLAIN=value",
        "export PREFIXED=yes",
        'QUOTED="a b"',
        "SINGLE='c d'",
        "NOT_A_PAIR",
        "=novalue",
      ].join("\n"),
    );
    expect(parsed).toEqual({
      PLAIN: "value",
      PREFIXED: "yes",
      QUOTED: "a b",
      SINGLE: "c d",
    });
  });

  it("treats documentation placeholders as unconfigured", () => {
    expect(isConfiguredValue("YOUR_SEPARATE_TEST_DATABASE_URL")).toBe(false);
    expect(isConfiguredValue("  ")).toBe(false);
    expect(isConfiguredValue(undefined)).toBe(false);
    expect(isConfiguredValue("<your-key>")).toBe(false);
    expect(isConfiguredValue("postgres://u:p@h/db")).toBe(true);
  });

  it("rejects a URL that is really a placeholder", () => {
    process.env["TEST_DATABASE_URL"] = "YOUR_SEPARATE_TEST_DATABASE_URL";
    expect(envValue("TEST_DATABASE_URL")).toBeUndefined();
    expect(envUrl("TEST_DATABASE_URL")).toBeUndefined();
    process.env["TEST_DATABASE_URL"] = "postgres://user:pass@127.0.0.1:5432/test";
    expect(envUrl("TEST_DATABASE_URL")).toContain("127.0.0.1");
    delete process.env["TEST_DATABASE_URL"];
  });

  it("loads the nearest .env without overriding the real environment", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "copilot-env-"));
    touched.push(dir);
    const nested = path.join(dir, "apps", "api");
    await writeFile(path.join(dir, ".env"), "COPILOT_TEST_FROM_FILE=file-value\nCOPILOT_TEST_PRESET=from-file\n");
    await (await import("node:fs/promises")).mkdir(nested, { recursive: true });
    expect(findEnvFile(nested)).toBe(path.join(dir, ".env"));

    process.env["COPILOT_TEST_PRESET"] = "from-shell";
    const result = loadProjectEnv({ startDir: nested });
    expect(result.path).toBe(path.join(dir, ".env"));
    expect(result.keys).toContain("COPILOT_TEST_FROM_FILE");
    expect(process.env["COPILOT_TEST_FROM_FILE"]).toBe("file-value");
    expect(process.env["COPILOT_TEST_PRESET"]).toBe("from-shell");
    delete process.env["COPILOT_TEST_FROM_FILE"];
    delete process.env["COPILOT_TEST_PRESET"];
  });

  it("describes a database target without its credentials", () => {
    const described = describeUrl("postgres://user:secret@db.example.com:5432/app?sslmode=require");
    expect(described).toBe("db.example.com/app ssl=require");
    expect(described).not.toContain("secret");
    expect(describeUrl(undefined)).toBe("unset");
  });
});

describe("Groq provider", () => {
  it("activates from GROQ_API_KEY alone and reports the model", () => {
    process.env["GROQ_API_KEY"] = "gsk_test_key_not_real";
    const client = configuredLlm();
    expect(client.provider).toBe("groq");
    expect(client.model).toBe("openai/gpt-oss-120b");
    expect(llmStatus(client).status).toBe("configured");
  });

  it("stays unconfigured when the key is a placeholder", () => {
    process.env["GROQ_API_KEY"] = "YOUR_GROQ_KEY";
    const client = configuredLlm();
    expect(client.provider).toBe("none");
    expect(llmStatus(client).status).toBe("unconfigured");
  });

  it("sends the OpenAI-compatible shape Groq expects and returns the text", async () => {
    process.env["GROQ_API_KEY"] = "gsk_test_key_not_real";
    const calls: { url: string; body: any; auth: string | null }[] = [];
    vi.stubGlobal("fetch", async (url: string, init: RequestInit) => {
      calls.push({
        url: String(url),
        body: JSON.parse(String(init.body)),
        auth: (init.headers as Record<string, string>)["authorization"] ?? null,
      });
      return new Response(
        JSON.stringify({ choices: [{ message: { content: '{"skillId":null}' } }] }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    });

    const result = await configuredLlm().completeJson({ system: "s", user: "u" });
    expect(result.modelCalls).toBe(1);
    expect(parseJsonObject(result.text)).toEqual({ skillId: null });
    expect(calls[0]!.url).toBe("https://api.groq.com/openai/v1/chat/completions");
    expect(calls[0]!.auth).toBe("Bearer gsk_test_key_not_real");
    expect(calls[0]!.body.model).toBe("openai/gpt-oss-120b");
    expect(calls[0]!.body.max_completion_tokens).toBe(800);
    expect(calls[0]!.body.response_format).toEqual({ type: "json_object" });
  });

  it("surfaces an authentication failure instead of a completion", async () => {
    process.env["GROQ_API_KEY"] = "gsk_test_key_not_real";
    vi.stubGlobal("fetch", async () =>
      new Response(JSON.stringify({ error: { message: "invalid api key" } }), { status: 401 }),
    );
    await expect(configuredLlm().completeJson({ system: "s", user: "u" })).rejects.toThrow(
      /HTTP 401.*GROQ_API_KEY|check the groq API key/i,
    );
  });

  it("retries once on a rate limit, then reports it", async () => {
    process.env["GROQ_API_KEY"] = "gsk_test_key_not_real";
    let attempts = 0;
    vi.stubGlobal("fetch", async () => {
      attempts += 1;
      return new Response(JSON.stringify({ error: { message: "rate limited" } }), { status: 429 });
    });
    await expect(configuredLlm().completeJson({ system: "s", user: "u" })).rejects.toThrow(
      /HTTP 429/,
    );
    expect(attempts).toBe(2);
  });

  it("falls back to plain JSON when the model rejects response_format", async () => {
    process.env["GROQ_API_KEY"] = "gsk_test_key_not_real";
    const bodies: any[] = [];
    vi.stubGlobal("fetch", async (_url: string, init: RequestInit) => {
      const body = JSON.parse(String(init.body));
      bodies.push(body);
      if (body.response_format) {
        return new Response("response_format is not supported for this model", { status: 400 });
      }
      return new Response(JSON.stringify({ choices: [{ message: { content: "```json\n{}\n```" } }] }), {
        status: 200,
      });
    });
    const result = await configuredLlm().completeJson({ system: "s", user: "u" });
    expect(bodies).toHaveLength(2);
    expect(bodies[1]!.response_format).toBeUndefined();
    expect(parseJsonObject(result.text)).toEqual({});
  });

  it("reports a provider that is down rather than inventing a plan", async () => {
    process.env["GROQ_API_KEY"] = "gsk_test_key_not_real";
    vi.stubGlobal("fetch", async () => new Response("gateway down", { status: 503 }));
    await expect(configuredLlm().completeJson({ system: "s", user: "u" })).rejects.toThrow(
      /HTTP 503/,
    );
  });
});
