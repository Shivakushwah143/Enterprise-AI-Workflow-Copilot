/**
 * Bundle inspection: OpenAdapt's compiled `workflow.json` -> copilot entities.
 *
 * We keep SEMANTIC identity (role, accessible name, selector, OCR label,
 * field label) and the recorded risk class, and we preserve uncertainty: a
 * step whose target is only a pixel crop is marked `probable`, and a step with
 * no anchor at all is `unknown`. Approving a workflow with anything less than
 * `identified` is possible, but the approval API makes the operator
 * acknowledge it.
 */
import { readFile } from "node:fs/promises";
import path from "node:path";
import type { ParamSpec, WorkflowStep } from "@copilot/shared";

interface RawStructural {
  selector?: string | null;
  role?: string | null;
  name?: string | null;
  automation_id?: string | null;
}

interface RawAnchor {
  template?: string;
  structural?: RawStructural | null;
  ocr_text?: string | null;
  context_text?: string | null;
  landmarks?: unknown[];
}

interface RawPostcondition {
  kind?: string;
  text?: string | null;
  url_contains?: string | null;
}

interface RawStep {
  id?: string;
  intent?: string;
  action?: string;
  anchor?: RawAnchor | null;
  text?: string | null;
  param?: string | null;
  field_label?: string | null;
  secret?: boolean;
  risk?: string;
  risk_review_required?: boolean;
  expect?: RawPostcondition[];
}

interface RawParamSpec {
  name?: string;
  required?: boolean;
  kind?: string;
  type?: string;
}

export interface RawWorkflow {
  schema_version?: number;
  name?: string;
  params?: Record<string, unknown>;
  /**
   * Schema 1 emits an array of specs; schema 2 (openadapt-flow 2.x) emits a
   * map keyed by parameter name. Both are accepted - the engine is the source
   * of truth for parameter names either way.
   */
  param_specs?: RawParamSpec[] | Record<string, RawParamSpec>;
  secret_params?: string[];
  steps?: RawStep[];
}

function paramSpecs(raw: RawWorkflow): RawParamSpec[] {
  const specs = raw.param_specs;
  if (!specs) return [];
  if (Array.isArray(specs)) return specs;
  return Object.entries(specs).map(([name, spec]) => ({ ...spec, name: spec?.name ?? name }));
}

export interface InspectedBundle {
  name: string;
  schemaVersion: number | null;
  steps: Omit<WorkflowStep, "id">[];
  params: ParamSpec[];
  uncertainty: string[];
  /** True when the bundle declares an irreversible step. */
  hasIrreversibleStep: boolean;
}

function structuralLocatable(raw?: RawStructural | null): boolean {
  if (!raw) return false;
  return Boolean(raw.selector || raw.automation_id || (raw.role && raw.name));
}

function describePostcondition(post: RawPostcondition): {
  kind: string;
  detail: string | null;
} {
  return {
    kind: String(post.kind ?? "unknown"),
    detail: post.text ?? post.url_contains ?? null,
  };
}

export function inspectWorkflow(raw: RawWorkflow): InspectedBundle {
  const uncertainty: string[] = [];
  const steps: Omit<WorkflowStep, "id">[] = [];

  for (const [index, step] of (raw.steps ?? []).entries()) {
    const action = String(step.action ?? "unknown");
    const anchor = step.anchor ?? null;
    const locatable = structuralLocatable(anchor?.structural);

    let anchorKind: WorkflowStep["anchorKind"] = "none";
    if (locatable) anchorKind = "structural";
    else if (anchor?.ocr_text) anchorKind = "ocr";
    else if (anchor?.template) anchorKind = "template";

    let confidence: WorkflowStep["confidence"] = "unknown";
    let note: string | null = null;
    if (anchorKind === "structural") {
      confidence = "identified";
    } else if (anchorKind === "ocr" || anchorKind === "template") {
      confidence = "probable";
      note = `Target re-found by ${anchorKind} evidence only; no structural locator was captured.`;
    } else if (["key", "hotkey", "wait", "scroll"].includes(action)) {
      // Keyboard-only steps legitimately have no target element.
      confidence = "identified";
    } else {
      note = "No target anchor was captured for this step.";
    }
    if (note) uncertainty.push(`step ${index + 1} (${action}): ${note}`);

    steps.push({
      index,
      intent: String(step.intent ?? `${action} step ${index + 1}`),
      action,
      risk: step.risk === "irreversible" ? "irreversible" : "reversible",
      anchorKind,
      elementRole: anchor?.structural?.role ?? null,
      elementName: anchor?.structural?.name ?? null,
      selector: anchor?.structural?.selector ?? null,
      ocrText: anchor?.ocr_text ?? null,
      fieldLabel: step.field_label ?? null,
      paramName: step.param ?? null,
      isSecret: Boolean(step.secret),
      postconditions: (step.expect ?? []).map(describePostcondition),
      confidence,
      uncertaintyNote: note,
    });
  }

  const secretParams = new Set(raw.secret_params ?? []);
  const params: ParamSpec[] = [];
  for (const spec of paramSpecs(raw)) {
    if (!spec.name) continue;
    params.push({
      name: spec.name,
      label: spec.name.replace(/_/g, " "),
      required: spec.required !== false,
      secret: secretParams.has(spec.name),
    });
  }
  // A parameter typed during the demonstration may not appear in param_specs
  // on older bundles; fall back to the steps so nothing is silently dropped.
  for (const step of steps) {
    if (!step.paramName) continue;
    if (params.some((p) => p.name === step.paramName)) continue;
    params.push({
      name: step.paramName,
      label: (step.fieldLabel ?? step.paramName).replace(/_/g, " "),
      required: true,
      secret: step.isSecret,
    });
  }

  return {
    name: String(raw.name ?? "workflow"),
    schemaVersion: raw.schema_version ?? null,
    steps,
    params,
    uncertainty,
    hasIrreversibleStep: steps.some((s) => s.risk === "irreversible"),
  };
}

export async function inspectBundle(bundleDir: string): Promise<InspectedBundle> {
  const file = path.join(bundleDir, "workflow.json");
  const raw = JSON.parse(await readFile(file, "utf8")) as RawWorkflow;
  return inspectWorkflow(raw);
}
