/**
 * Target resolution contract.
 *
 * The browser-side implementation lives in the API layer (`targets.ts` there),
 * so this package stays free of Playwright and the executor can be unit-tested
 * with a plain stub. A resolution never invents a selector: `source: "none"`
 * means "could not identify", which the caller must treat as a refusal for
 * consequential steps.
 */
import type { WorkflowStep } from "@copilot/shared";
import type { KnownTarget } from "./memory.js";

export type ResolutionSource =
  | "recorded"
  | "rediscovered"
  | "ai_assisted"
  | "repair"
  | "none";

export interface TargetResolution {
  stepIndex: number;
  /** CSS selector usable by the engine, or null when nothing was identified. */
  selector: string | null;
  source: ResolutionSource;
  /** Candidates that were tried, in order, for the audit record. */
  tried: string[];
  detail: string;
  /** Set when a reviewed repair supplied the selector. */
  repairId?: string | null;
}

/**
 * Resolve targets, optionally using selectors supplied by reviewed memory.
 * `known` is empty when memory is disabled or nothing applicable exists.
 */
export type TargetResolver = (
  steps: WorkflowStep[],
  known: KnownTarget[],
) => Promise<TargetResolution[]>;

/** Optional bounded AI fallback, authorized per execution by the caller. */
export type LocatorAssist = (step: WorkflowStep) => Promise<string | null>;
