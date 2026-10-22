/**
 * Parameter binding: recording -> workflow steps -> execution inputs.
 *
 * The recording names parameters (`company_name`), the compiled bundle maps
 * them onto steps (`type <company_name>`), and the approved skill declares
 * which are required. Execution must not re-derive any of that by guessing: it
 * binds all three once, and the binding is what decides whether an input is
 * missing, optional, secret, or unbound.
 */
import type { ParamSpec, Skill, Workflow, WorkflowStep } from "@copilot/shared";

export interface ParameterBinding {
  name: string;
  label: string;
  /** Required inputs block execution; optional ones may be absent. */
  required: boolean;
  secret: boolean;
  /** Steps that consume this parameter, in execution order. */
  steps: number[];
  fieldLabels: string[];
  /** True when a step needs the value even though no ParamSpec declared it. */
  inferredFromSteps: boolean;
}

function specFor(skill: Skill, name: string): ParamSpec | undefined {
  return skill.requiredInputs.find((param) => param.name === name);
}

function stepsFor(workflow: Workflow, name: string): WorkflowStep[] {
  return workflow.steps.filter((step) => step.paramName === name);
}

/**
 * One row per parameter, in the order the skill declares them and then any
 * parameter that only the steps know about (older bundles).
 */
export function bindParameters(workflow: Workflow, skill: Skill): ParameterBinding[] {
  const bindings: ParameterBinding[] = [];
  const seen = new Set<string>();

  const bind = (name: string, spec: ParamSpec | undefined): void => {
    if (seen.has(name)) return;
    seen.add(name);
    const consuming = stepsFor(workflow, name);
    // A parameter a step consumes cannot be optional: the step would type an
    // empty value. Declared optionality is honoured only for unused params.
    const required = consuming.length > 0 ? true : (spec?.required ?? true);
    bindings.push({
      name,
      label: spec?.label ?? name.replace(/_/g, " "),
      required,
      secret: Boolean(spec?.secret ?? consuming.some((step) => step.isSecret)),
      steps: consuming.map((step) => step.index),
      fieldLabels: consuming
        .map((step) => step.fieldLabel)
        .filter((label): label is string => Boolean(label)),
      inferredFromSteps: !spec && consuming.length > 0,
    });
  };

  for (const spec of skill.requiredInputs) bind(spec.name, spec);
  for (const step of workflow.steps) {
    if (step.paramName) bind(step.paramName, specFor(skill, step.paramName));
  }

  return bindings;
}

/** Required bindings with no supplied value. Never fills a guess in. */
export function missingRequired(
  bindings: ParameterBinding[],
  inputs: Record<string, string>,
): ParameterBinding[] {
  return bindings.filter((binding) => binding.required && !inputs[binding.name]);
}

/** Non-secret values the engine may receive (secrets go through the environment). */
export function replayValues(
  bindings: ParameterBinding[],
  inputs: Record<string, string>,
): Record<string, string> {
  const values: Record<string, string> = {};
  for (const binding of bindings) {
    const value = inputs[binding.name];
    if (value !== undefined && !binding.secret) values[binding.name] = value;
  }
  return values;
}
