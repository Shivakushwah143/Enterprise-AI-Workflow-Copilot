/**
 * Intent understanding.
 *
 * Two paths, and the plan always says which one ran:
 *   - model path: a configured LLM picks the skill and extracts inputs;
 *   - deterministic path: token overlap + typed field extraction.
 *
 * The deterministic path exists because an enterprise copilot must not invent
 * a skill or a customer name, and because the demo has to work with no API key.
 * Neither path can invent a value for a secret parameter.
 */
import type { ParamSpec, Skill, Workflow } from "@copilot/shared";
import { configuredLlm, parseJsonObject, type LlmClient } from "./llm.js";

export interface SkillContext {
  skill: Skill;
  workflow: Workflow;
}

export interface IntentResolution {
  skillId: string | null;
  confidence: number;
  scores: { skillId: string; skillName: string; score: number; reason: string }[];
  inputs: Record<string, string>;
  missing: ParamSpec[];
  method: "model" | "deterministic";
  modelCalls: number;
  notes: string[];
}

/**
 * Filler only. Business nouns (`customer`, `stock`, `item`) are deliberately
 * NOT stopped: they are the terms that discriminate one skill from another.
 */
const STOPWORDS = new Set([
  "the", "a", "an", "and", "or", "please", "for", "to", "in", "of", "with", "me",
  "create", "add", "make", "new", "my", "our", "named",
  "called", "this", "that", "it", "on", "at", "into", "can", "you", "i", "want",
  "need", "should", "would", "like", "is", "are", "be", "do",
]);

function tokens(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length > 2 && !STOPWORDS.has(t));
}

function skillVocabulary(context: SkillContext): string {
  const { skill, workflow } = context;
  return [
    skill.name,
    skill.description,
    skill.triggeredBy.join(" "),
    workflow.name,
    workflow.description ?? "",
    workflow.applicationName,
    workflow.steps.map((s) => `${s.intent} ${s.elementName ?? ""} ${s.fieldLabel ?? ""}`).join(" "),
    skill.requiredInputs.map((p) => `${p.name} ${p.label}`).join(" "),
  ].join(" ");
}

/** Explainable retrieval: which intent tokens the skill actually answers. */
export function scoreSkills(
  contexts: SkillContext[],
  intent: string,
): { skillId: string; skillName: string; score: number; reason: string }[] {
  const intentTokens = tokens(intent);
  return contexts
    .map((context) => {
      const vocabulary = new Set(tokens(skillVocabulary(context)));
      const matched = intentTokens.filter((t) => vocabulary.has(t));
      const triggerHit = context.skill.triggeredBy.some((trigger) =>
        intent.toLowerCase().includes(trigger.toLowerCase()),
      );
      const raw = (matched.length + (triggerHit ? 1.5 : 0)) / Math.max(3, intentTokens.length);
      const score = Math.min(1, Number(raw.toFixed(3)));
      const reason = matched.length
        ? `matched ${matched.join(", ")}${triggerHit ? " (explicit trigger)" : ""}`
        : triggerHit
          ? "matched an explicit trigger phrase"
          : "no vocabulary overlap";
      return {
        skillId: context.skill.id,
        skillName: context.skill.name,
        score,
        reason,
      };
    })
    .sort((a, b) => b.score - a.score);
}

/**
 * Deterministic field extraction. Typed by parameter name, so the agent
 * understands "email" as an email and "quantity" as a number.
 */
export function extractInputs(
  intent: string,
  params: ParamSpec[],
): { inputs: Record<string, string>; missing: ParamSpec[] } {
  const inputs: Record<string, string> = {};
  const emailMatch = intent.match(/[\w.+-]+@[\w-]+\.[\w.-]+/);
  const quoted = intent.match(/["“']([^"”']{2,120})["”']/);
  const named = intent.match(
    /\b(?:named|called|for)\s+([A-Z0-9][^,.;\n]{1,80}?)(?:\s+(?:with|and|at)\b|[,.;]|$)/,
  );
  const bare = intent.match(
    /\b(?:create|add|register|make|new)\b[^0-9]{0,40}?\b(?:customer|client|account|company|item|stock)\b\s+([A-Z][^,.;\n]{1,60})/,
  );

  for (const param of params) {
    if (param.secret) continue; // never guess a secret
    const name = param.name.toLowerCase();
    let value: string | undefined;

    if (name.includes("email") || name.includes("mail")) {
      value = emailMatch?.[0];
    } else if (/(quantity|qty|count|amount|number)/.test(name)) {
      // A number next to the word "quantity" wins; a bare number that is part
      // of an identifier (SKU-8842) must not be mistaken for the quantity.
      const nearKeyword = intent.match(
        /(?:quantity|qty|count|amount|number)\D{0,12}(-?\d+(?:\.\d+)?)/i,
      );
      const standalone = intent.match(/(?<![\w.-])\d+(?:\.\d+)?(?![\w.-])/);
      value = nearKeyword?.[1] ?? standalone?.[0];
    } else if (/(sku|code|reference|ref)/.test(name)) {
      const code = intent.match(/\b[A-Z0-9]{2,}(?:-[A-Z0-9]{2,})+\b/);
      value = code?.[0];
    } else if (/(name|company|client|customer|title|label)/.test(name)) {
      value = quoted?.[1] ?? named?.[1] ?? bare?.[1];
    }

    // Explicit "key: value" or "key=value" always wins.
    const explicit = intent.match(
      new RegExp(`\\b${param.name}\\s*[:=]\\s*([^,;\\n]{1,120})`, "i"),
    );
    if (explicit?.[1]) value = explicit[1].trim();

    if (value) {
      inputs[param.name] = value.trim().replace(/^[-–]\s*/, "").replace(/[.\s]+$/, "");
    }
  }

  const missing = params.filter((p) => inputs[p.name] === undefined);
  return { inputs, missing };
}

const SYSTEM_PROMPT = `You are an enterprise workflow planner. You must choose at most one
approved skill from the list and extract its input values from the user's request.
Never invent a value that is not in the request. Never fill a secret input.
Reply with JSON: {"skillId": string|null, "inputs": {name: string}, "confidence": number, "reason": string}`;

export async function resolveIntent(
  contexts: SkillContext[],
  intent: string,
  llm: LlmClient = configuredLlm(),
): Promise<IntentResolution> {
  const scores = scoreSkills(contexts, intent);
  const notes: string[] = [];

  if (contexts.length === 0) {
    return {
      skillId: null,
      confidence: 0,
      scores,
      inputs: {},
      missing: [],
      method: "deterministic",
      modelCalls: 0,
      notes: ["No approved skills are available in this tenant."],
    };
  }

  if (llm.provider !== "none") {
    try {
      const catalog = contexts.map((c) => ({
        id: c.skill.id,
        name: c.skill.name,
        description: c.skill.description,
        application: c.workflow.applicationName,
        steps: c.workflow.steps.map((s) => s.intent),
        inputs: c.skill.requiredInputs.map((p) => ({
          name: p.name,
          label: p.label,
          secret: p.secret,
        })),
      }));
      const response = await llm.completeJson({
        system: SYSTEM_PROMPT,
        user: `Approved skills:\n${JSON.stringify(catalog, null, 2)}\n\nUser request: ${intent}`,
      });
      const parsed = parseJsonObject(response.text) as {
        skillId?: unknown;
        inputs?: unknown;
        confidence?: unknown;
        reason?: unknown;
      };
      const chosen = contexts.find((c) => c.skill.id === parsed.skillId);
      if (!chosen) {
        return {
          skillId: null,
          confidence: 0,
          scores,
          inputs: {},
          missing: [],
          method: "model",
          modelCalls: response.modelCalls,
          notes: [
            `Model did not select a valid skill (${String(parsed.reason ?? "no reason given")}).`,
          ],
        };
      }
      const allowed = new Set(chosen.skill.requiredInputs.filter((p) => !p.secret).map((p) => p.name));
      const inputs: Record<string, string> = {};
      const rawInputs = (parsed.inputs ?? {}) as Record<string, unknown>;
      for (const [key, value] of Object.entries(rawInputs)) {
        if (!allowed.has(key)) {
          notes.push(`Model proposed an unknown or secret input "${key}"; ignored.`);
          continue;
        }
        if (value !== null && value !== undefined && String(value).trim() !== "") {
          inputs[key] = String(value).trim();
        }
      }
      // Fill anything the model left out deterministically; no invention.
      const fallback = extractInputs(intent, chosen.skill.requiredInputs);
      for (const [key, value] of Object.entries(fallback.inputs)) {
        if (inputs[key] === undefined) inputs[key] = value;
      }
      const missing = chosen.skill.requiredInputs.filter((p) => inputs[p.name] === undefined);
      return {
        skillId: chosen.skill.id,
        confidence: Math.max(0, Math.min(1, Number(parsed.confidence ?? 0.6))),
        scores,
        inputs,
        missing,
        method: "model",
        modelCalls: response.modelCalls,
        notes,
      };
    } catch (error) {
      notes.push(
        `Model planner unavailable (${error instanceof Error ? error.message : "unknown error"}); deterministic planner used.`,
      );
    }
  } else {
    notes.push("No LLM configured: intent was resolved deterministically.");
  }

  const best = scores[0];
  if (!best || best.score < 0.15) {
    return {
      skillId: null,
      confidence: best?.score ?? 0,
      scores,
      inputs: {},
      missing: [],
      method: "deterministic",
      modelCalls: 0,
      notes: [...notes, "No approved skill matched this request."],
    };
  }
  const chosen = contexts.find((c) => c.skill.id === best.skillId);
  if (!chosen) {
    return {
      skillId: null,
      confidence: 0,
      scores,
      inputs: {},
      missing: [],
      method: "deterministic",
      modelCalls: 0,
      notes,
    };
  }
  const { inputs, missing } = extractInputs(intent, chosen.skill.requiredInputs);
  return {
    skillId: chosen.skill.id,
    confidence: best.score,
    scores,
    inputs,
    missing,
    method: "deterministic",
    modelCalls: 0,
    notes,
  };
}
