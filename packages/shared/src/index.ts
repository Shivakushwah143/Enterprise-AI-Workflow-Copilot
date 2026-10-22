/**
 * Shared contracts for the Enterprise AI Workflow Copilot.
 *
 * Everything that crosses a module boundary (HTTP handler -> agent -> engine,
 * or extension -> API) is described here once, as a zod schema plus its
 * inferred type. No package re-declares these shapes.
 */
import { z } from "zod";

/* ------------------------------------------------------------------ */
/* Identity, tenancy, roles                                            */
/* ------------------------------------------------------------------ */

export const RoleSchema = z.enum(["admin", "employee", "viewer"]);
export type Role = z.infer<typeof RoleSchema>;

export const PermissionSchema = z.enum([
  "application:write",
  "workflow:read",
  "workflow:approve",
  "skill:execute",
  "execution:read",
  "knowledge:write",
]);
export type Permission = z.infer<typeof PermissionSchema>;

/** Static permission matrix. Server-side authorization reads this table only. */
export const ROLE_PERMISSIONS: Record<Role, readonly Permission[]> = {
  admin: [
    "application:write",
    "workflow:read",
    "workflow:approve",
    "skill:execute",
    "execution:read",
    "knowledge:write",
  ],
  employee: ["workflow:read", "skill:execute", "execution:read"],
  viewer: ["workflow:read", "execution:read"],
};

export function roleCan(role: Role, permission: Permission): boolean {
  return ROLE_PERMISSIONS[role].includes(permission);
}

export const SessionSchema = z.object({
  token: z.string(),
  tenantId: z.string(),
  tenantSlug: z.string(),
  userId: z.string(),
  role: RoleSchema,
  displayName: z.string(),
  expiresAt: z.string(),
});
export type Session = z.infer<typeof SessionSchema>;

/* ------------------------------------------------------------------ */
/* Applications, workflows, skills                                     */
/* ------------------------------------------------------------------ */

export const ApplicationKindSchema = z.enum(["browser", "desktop"]);
export type ApplicationKind = z.infer<typeof ApplicationKindSchema>;

export const ApplicationSchema = z.object({
  id: z.string(),
  tenantId: z.string(),
  name: z.string(),
  baseUrl: z.string().url(),
  kind: ApplicationKindSchema,
  verificationBaseUrl: z.string().url().nullable(),
  createdAt: z.string(),
});
export type Application = z.infer<typeof ApplicationSchema>;

export const RegisterApplicationSchema = z.object({
  name: z.string().min(2).max(120),
  baseUrl: z.string().url(),
  /** Where independent read-back happens. Defaults to baseUrl. */
  verificationBaseUrl: z.string().url().optional(),
  kind: ApplicationKindSchema.default("browser"),
});

export const RiskClassSchema = z.enum(["reversible", "irreversible"]);
export type RiskClass = z.infer<typeof RiskClassSchema>;

/** How a step's target was described at record time. */
export const AnchorKindSchema = z.enum([
  "structural",
  "template",
  "ocr",
  "geometry",
  "none",
]);
export type AnchorKind = z.infer<typeof AnchorKindSchema>;

/**
 * Uncertainty is preserved, never smoothed away. Any value other than
 * `identified` blocks automatic approval of the generated skill.
 */
export const ElementConfidenceSchema = z.enum([
  "identified",
  "probable",
  "unknown",
]);
export type ElementConfidence = z.infer<typeof ElementConfidenceSchema>;

export const WorkflowStepSchema = z.object({
  id: z.string(),
  index: z.number().int().nonnegative(),
  intent: z.string(),
  action: z.string(),
  risk: RiskClassSchema,
  anchorKind: AnchorKindSchema,
  /** Semantic element identity: role + accessible name derived at ingest. */
  elementRole: z.string().nullable(),
  elementName: z.string().nullable(),
  selector: z.string().nullable(),
  ocrText: z.string().nullable(),
  fieldLabel: z.string().nullable(),
  paramName: z.string().nullable(),
  isSecret: z.boolean(),
  postconditions: z.array(
    z.object({
      kind: z.string(),
      detail: z.string().nullable(),
    }),
  ),
  confidence: ElementConfidenceSchema,
  uncertaintyNote: z.string().nullable(),
});
export type WorkflowStep = z.infer<typeof WorkflowStepSchema>;

export const WorkflowStatusSchema = z.enum(["draft", "approved", "rejected"]);
export type WorkflowStatus = z.infer<typeof WorkflowStatusSchema>;

export const WorkflowSchema = z.object({
  id: z.string(),
  tenantId: z.string(),
  applicationId: z.string(),
  applicationName: z.string(),
  name: z.string(),
  description: z.string().nullable(),
  status: WorkflowStatusSchema,
  bundlePath: z.string().nullable(),
  recordingId: z.string().nullable(),
  steps: z.array(WorkflowStepSchema),
  uncertainty: z.array(z.string()),
  createdAt: z.string(),
});
export type Workflow = z.infer<typeof WorkflowSchema>;

export const ParamSpecSchema = z.object({
  name: z.string(),
  label: z.string(),
  required: z.boolean(),
  secret: z.boolean(),
});
export type ParamSpec = z.infer<typeof ParamSpecSchema>;

export const VerificationTierSchema = z.enum([
  "system_of_record",
  "separate_session",
  "reopened",
  "same_screen",
  "none",
]);
export type VerificationTier = z.infer<typeof VerificationTierSchema>;

/**
 * The independent read-back contract bound to a skill at approval time.
 *
 * OpenAdapt gives us the contract and the tiers; the business-system oracle is
 * ours to supply (`audit §4.6`). `url` may contain `{param}` placeholders, and
 * `expect` maps a field in the fetched record to the input that must appear
 * there. No contract means no VERIFIED outcome, ever.
 */
export const VerificationContractSchema = z.object({
  kind: z.literal("http"),
  tier: VerificationTierSchema.default("system_of_record"),
  url: z.string().min(1),
  /** Dot path to the array (or object) of records in the JSON response. */
  recordPath: z.string().default("items"),
  /** observed field name -> the input param whose value must be there. */
  expect: z.record(z.string()).default({}),
  match: z.enum(["includes", "equals"]).default("equals"),
});
export type VerificationContract = z.infer<typeof VerificationContractSchema>;

export const SkillSchema = z.object({
  id: z.string(),
  tenantId: z.string(),
  workflowId: z.string(),
  workflowName: z.string(),
  applicationId: z.string(),
  name: z.string(),
  description: z.string(),
  status: z.enum(["active", "disabled"]),
  requiredInputs: z.array(ParamSpecSchema),
  triggeredBy: z.array(z.string()),
  verification: VerificationContractSchema.nullable(),
  approvedBy: z.string().nullable(),
  approvedAt: z.string().nullable(),
  version: z.number().int(),
});
export type Skill = z.infer<typeof SkillSchema>;

/* ------------------------------------------------------------------ */
/* Recording                                                           */
/* ------------------------------------------------------------------ */

export const RecordingModeSchema = z.enum(["scripted", "interactive"]);
export type RecordingMode = z.infer<typeof RecordingModeSchema>;

export const RecordingStatusSchema = z.enum([
  "recording",
  "compiled",
  "failed",
  "cancelled",
]);
export type RecordingStatus = z.infer<typeof RecordingStatusSchema>;

export const RecordingSchema = z.object({
  id: z.string(),
  tenantId: z.string(),
  applicationId: z.string(),
  status: RecordingStatusSchema,
  mode: RecordingModeSchema,
  workflowId: z.string().nullable(),
  error: z.string().nullable(),
  startedAt: z.string(),
  finishedAt: z.string().nullable(),
});
export type Recording = z.infer<typeof RecordingSchema>;

export const StartRecordingSchema = z.object({
  applicationId: z.string().min(1),
  /**
   * `interactive` opens a headed browser for the admin to demonstrate in;
   * `scripted` replays the app's built-in demonstration (no human needed).
   */
  mode: RecordingModeSchema.default("interactive"),
  workflowName: z.string().min(2).max(120).optional(),
  /** Field names whose typed values become replay parameters. */
  paramFields: z.array(z.string().min(1)).max(20).default([]),
  /** Field names whose values are never persisted. */
  secretFields: z.array(z.string().min(1)).max(20).default([]),
});

/* ------------------------------------------------------------------ */
/* Browser execution modes                                            */
/* ------------------------------------------------------------------ */

/**
 * Where the work happens. `guided` runs in the employee's own tab and the
 * employee performs the steps; `autonomous` runs in a controlled browser the
 * employee is not looking at. The distinction is never inferred: the caller
 * chooses it explicitly, and nothing switches it silently.
 */
export const ExecutionModeSchema = z.enum(["guided", "autonomous"]);
export type ExecutionMode = z.infer<typeof ExecutionModeSchema>;

/**
 * One AI-driven browser operation in a controlled session.
 *
 * The id is the operation id: progress, audit records and results are all keyed
 * by it, and it is only readable by the tenant that started it. `targetUrl`
 * must resolve to an application registered to that tenant.
 */
export const BrowserSessionSchema = z.object({
  id: z.string(),
  tenantId: z.string(),
  userId: z.string(),
  mode: z.literal("autonomous"),
  /** Stated in the UI so nobody thinks the employee's tab is being driven. */
  sessionType: z.literal("controlled_browser_session"),
  applicationId: z.string(),
  applicationName: z.string(),
  targetUrl: z.string(),
  instruction: z.string(),
  approved: z.boolean(),
  planId: z.string().nullable(),
  skillId: z.string().nullable(),
  status: z.enum(["running", "completed", "failed", "cancelled", "expired"]),
  summary: z.string().nullable(),
  actions: z.array(z.string()),
  observed: z.unknown().nullable(),
  error: z.string().nullable(),
  startedAt: z.string(),
  finishedAt: z.string().nullable(),
});
export type BrowserSession = z.infer<typeof BrowserSessionSchema>;

/* ------------------------------------------------------------------ */
/* Intent -> plan -> execution                                         */
/* ------------------------------------------------------------------ */

export const IntentRequestSchema = z.object({
  intent: z.string().min(3).max(2000),
  applicationId: z.string().optional(),
});
export type IntentRequest = z.infer<typeof IntentRequestSchema>;

export const PlannedInputSchema = z.object({
  name: z.string(),
  label: z.string(),
  secret: z.boolean(),
  value: z.string().nullable(),
});
export type PlannedInput = z.infer<typeof PlannedInputSchema>;

export const PlanSchema = z.object({
  id: z.string(),
  tenantId: z.string(),
  intent: z.string(),
  skillId: z.string().nullable(),
  skillName: z.string().nullable(),
  workflowId: z.string().nullable(),
  applicationId: z.string().nullable(),
  confidence: z.number().min(0).max(1),
  /** Retrieved candidates, best first, with the score that selected them. */
  candidates: z.array(
    z.object({
      skillId: z.string(),
      skillName: z.string(),
      score: z.number(),
      reason: z.string(),
    }),
  ),
  missingInputs: z.array(ParamSpecSchema),
  resolvedInputs: z.array(PlannedInputSchema),
  /** `true` when execution needs an explicit human approval first. */
  requiresApproval: z.boolean(),
  approvalReason: z.string().nullable(),
  blockers: z.array(z.string()),
  createdAt: z.string(),
});
export type Plan = z.infer<typeof PlanSchema>;

export const ApproveWorkflowSchema = z.object({
  /** The generated skill is never auto-approved: this call IS the approval. */
  name: z.string().min(2).max(120).optional(),
  description: z.string().max(2000).optional(),
  triggeredBy: z.array(z.string()).default([]),
  verification: VerificationContractSchema.nullable().default(null),
  /** Required acknowledgement for workflows with any irreversible step. */
  acknowledgeRisk: z.boolean().default(false),
});
export type ApproveWorkflowRequest = z.infer<typeof ApproveWorkflowSchema>;

export const ExecuteSchema = z.object({
  planId: z.string().min(1),
  inputs: z.record(z.string()).default({}),
  /** Explicit human approval for consequential writes. */
  approved: z.boolean().default(false),
  /**
   * Bounded AI assistance for target re-discovery when deterministic
   * resolution fails. Off by default: the caller authorizes it per execution,
   * and it is only used for locating an element, never for deciding policy.
   */
  allowAiLocator: z.boolean().default(false),
  /**
   * Whether reviewed procedural memory may be used for this execution.
   * `disabled` is a hard switch: no repair is read, so a comparison run cannot
   * benefit from anything the agent has already learned.
   */
  memory: z.enum(["enabled", "disabled"]).default("enabled"),
});
export type ExecuteRequest = z.infer<typeof ExecuteSchema>;

/* ------------------------------------------------------------------ */
/* Memory use audit                                                    */
/* ------------------------------------------------------------------ */

export const MemoryModeSchema = z.enum(["enabled", "disabled"]);
export type MemoryMode = z.infer<typeof MemoryModeSchema>;

/** One stored repair considered for this run, with the decision taken. */
export const MemoryUseSchema = z.object({
  repairId: z.string(),
  stepIndex: z.number().int().nullable(),
  /** `false` when any applicability condition did not hold. */
  applicable: z.boolean(),
  reason: z.string(),
  /** `true` only when the repair actually determined what was executed. */
  applied: z.boolean(),
});
export type MemoryUse = z.infer<typeof MemoryUseSchema>;

export const MemoryAuditSchema = z.object({
  mode: MemoryModeSchema,
  /** Repairs the store returned for this workflow, and what was decided. */
  retrieved: z.array(MemoryUseSchema).default([]),
  /** Repairs that determined what was executed. */
  appliedRepairIds: z.array(z.string()).default([]),
  /** Repairs that agreed with a fresh re-discovery (validated, not decisive). */
  confirmedRepairIds: z.array(z.string()).default([]),
});
export type MemoryAudit = z.infer<typeof MemoryAuditSchema>;

/* ------------------------------------------------------------------ */
/* Failure diagnostics, timing, recovery, memory                       */
/* ------------------------------------------------------------------ */

/**
 * Where a failure originated. This is the machine-readable answer to "whose
 * fault was it?", decided from evidence — never from the outcome alone.
 */
export const FailureOriginSchema = z.enum([
  "reasoning",
  "selector",
  "timing",
  "browser_session",
  "application",
  "input_verification",
  "verification",
  "infrastructure",
  "policy",
  "unknown",
]);
export type FailureOrigin = z.infer<typeof FailureOriginSchema>;

export const FailureResultSchema = z.object({
  origin: FailureOriginSchema,
  /** Stable machine code, e.g. CONTROL_NOT_RESOLVED, ORACLE_RECORD_ABSENT. */
  code: z.string(),
  detectedBy: z.enum(["engine", "oracle", "policy", "api", "copilot"]),
  detail: z.string(),
  stepIndex: z.number().int().nullable().default(null),
  /** Safe raw evidence: statuses, selectors, rungs, halt text. Never secrets. */
  evidence: z.record(z.unknown()).default({}),
});
export type FailureResult = z.infer<typeof FailureResultSchema>;

export const ExecutionPhaseTimingsSchema = z.object({
  /** Process start until the bridge returned (engine work included). */
  bridgeStartupMs: z.number().nullable().default(null),
  /** Engine-reported replay time. */
  replayMs: z.number().nullable().default(null),
  /** Engine total minus the sum of its own step times (launch/shutdown). */
  engineOverheadMs: z.number().nullable().default(null),
  /** Both oracle reads together. */
  verificationMs: z.number().nullable().default(null),
  /** Writing steps, verification and the final execution row. */
  persistenceMs: z.number().nullable().default(null),
});
export type ExecutionPhaseTimings = z.infer<typeof ExecutionPhaseTimingsSchema>;

export const ExecutionTimingsSchema = z.object({
  totalMs: z.number().int(),
  phases: ExecutionPhaseTimingsSchema,
  engineReportedMs: z.number().nullable().default(null),
});
export type ExecutionTimings = z.infer<typeof ExecutionTimingsSchema>;

export const RecoveryAttemptSchema = z.object({
  source: z.enum(["repair_memory", "rediscovery"]),
  repairId: z.string().nullable().default(null),
  stepIndex: z.number().int().nullable().default(null),
  fromSelector: z.string().nullable().default(null),
  toSelector: z.string().nullable().default(null),
  outcome: z.enum(["recovered", "not_recovered", "refused"]),
  detail: z.string(),
  verifyPassed: z.boolean(),
});
export type RecoveryAttempt = z.infer<typeof RecoveryAttemptSchema>;

export const RecoverySummarySchema = z.object({
  attempted: z.boolean(),
  reason: z.string(),
  attempts: z.array(RecoveryAttemptSchema).default([]),
});
export type RecoverySummary = z.infer<typeof RecoverySummarySchema>;

export const RepairStatusSchema = z.enum([
  "candidate",
  "approved",
  "rejected",
  "retired",
]);
export type RepairStatus = z.infer<typeof RepairStatusSchema>;

export const RepairActionSchema = z.object({
  kind: z.literal("selector_override"),
  stepIndex: z.number().int(),
  fromSelector: z.string().nullable(),
  toSelector: z.string().min(1),
});
export type RepairAction = z.infer<typeof RepairActionSchema>;

/**
 * A verified repair. Reused only when `approved`: an automatic success is
 * evidence for review, not permission to act unattended next time.
 */
export const RepairSchema = z.object({
  id: z.string(),
  tenantId: z.string(),
  applicationId: z.string(),
  workflowId: z.string(),
  skillId: z.string(),
  workflowVersion: z.number().int(),
  failureOrigin: FailureOriginSchema,
  failureCode: z.string(),
  action: RepairActionSchema,
  conditions: z.record(z.unknown()).default({}),
  status: RepairStatusSchema,
  successCount: z.number().int(),
  failureCount: z.number().int(),
  createdBy: z.string().nullable(),
  reviewedBy: z.string().nullable(),
  createdAt: z.string(),
  reviewedAt: z.string().nullable(),
  lastUsedAt: z.string().nullable(),
});
export type Repair = z.infer<typeof RepairSchema>;

export const ReviewRepairSchema = z.object({
  status: z.enum(["approved", "rejected", "retired"]),
  note: z.string().max(500).optional(),
});
export type ReviewRepairRequest = z.infer<typeof ReviewRepairSchema>;

export const ExecutionOutcomeSchema = z.enum([
  "VERIFIED",
  "COMPLETED_UNVERIFIED",
  "HALTED",
  "FAILED",
  "REJECTED",
  "REJECTED_POLICY",
]);
export type ExecutionOutcome = z.infer<typeof ExecutionOutcomeSchema>;

export const ExecutionStepResultSchema = z.object({
  index: z.number().int(),
  stepId: z.string().nullable(),
  intent: z.string(),
  status: z.enum(["ok", "healed", "failed", "skipped", "not_run"]),
  rung: z.string().nullable(),
  detail: z.string().nullable(),
  durationMs: z.number().nullable(),
  /** Engine's own check that the typed value landed in the field. */
  inputVerified: z.boolean().nullable().default(null),
  /** Selector actually used, which may differ from the recorded one. */
  resolvedSelector: z.string().nullable().default(null),
  resolutionSource: z
    .enum(["recorded", "rediscovered", "ai_assisted", "repair", "none"])
    .default("none"),
  /** The reviewed repair that supplied the selector, when one did. */
  repairId: z.string().nullable().default(null),
});
export type ExecutionStepResult = z.infer<typeof ExecutionStepResultSchema>;

export const VerificationResultSchema = z.object({
  tier: VerificationTierSchema,
  passed: z.boolean(),
  source: z.string(),
  expected: z.record(z.unknown()),
  observed: z.record(z.unknown()).nullable(),
  detail: z.string(),
  createdAt: z.string(),
});
export type VerificationResult = z.infer<typeof VerificationResultSchema>;

export const ExecutionSchema = z.object({
  id: z.string(),
  tenantId: z.string(),
  skillId: z.string(),
  workflowId: z.string(),
  intent: z.string(),
  inputs: z.record(z.string()),
  status: z.enum(["queued", "running", "succeeded", "failed", "halted"]),
  outcome: ExecutionOutcomeSchema.nullable(),
  /** Raw engine verdict, kept separate from ours: the engine is one witness. */
  engineOutcome: z.string().nullable(),
  engineReportPath: z.string().nullable(),
  steps: z.array(ExecutionStepResultSchema),
  verification: VerificationResultSchema.nullable(),
  message: z.string().nullable(),
  modelCalls: z.number().int(),
  failure: FailureResultSchema.nullable().default(null),
  timings: ExecutionTimingsSchema.nullable().default(null),
  recovery: RecoverySummarySchema.nullable().default(null),
  /** Which repairs were considered, and whether any of them was used. */
  memory: MemoryAuditSchema.nullable().default(null),
  startedAt: z.string(),
  finishedAt: z.string().nullable(),
});
export type Execution = z.infer<typeof ExecutionSchema>;

/** One attempt, with what failed and what (if anything) repaired it. */
export const EpisodeSchema = z.object({
  id: z.string(),
  tenantId: z.string(),
  executionId: z.string(),
  skillId: z.string(),
  workflowId: z.string(),
  applicationId: z.string(),
  intent: z.string(),
  outcome: ExecutionOutcomeSchema.nullable(),
  failure: FailureResultSchema.nullable(),
  recovery: RecoverySummarySchema.nullable(),
  /** Engine report path; the trace reference for this episode. */
  traceRef: z.string().nullable(),
  context: z.record(z.unknown()).default({}),
  createdAt: z.string(),
});
export type Episode = z.infer<typeof EpisodeSchema>;

/* ------------------------------------------------------------------ */
/* UI guidance (Driver.js)                                             */
/* ------------------------------------------------------------------ */

export const GuidanceSchema = z.object({
  skillId: z.string(),
  stepIndex: z.number().int(),
  totalSteps: z.number().int(),
  action: z.string(),
  instruction: z.string(),
  /** CSS selector used to highlight the real element. Null when unknown. */
  selector: z.string().nullable(),
  elementName: z.string().nullable(),
  risk: RiskClassSchema,
  /** `false` when no element could be identified: never highlight a guess. */
  highlightable: z.boolean(),
});
export type Guidance = z.infer<typeof GuidanceSchema>;

export const LandingPageSchema = z.object({
  href: z.string(),
  path: z.string(),
  title: z.string(),
  appName: z.string().nullable(),
  applicationId: z.string().nullable(),
  suggestedSkills: z.array(
    z.object({ id: z.string(), name: z.string(), description: z.string() }),
  ),
});
export type LandingPage = z.infer<typeof LandingPageSchema>;

/* ------------------------------------------------------------------ */
/* Capability reporting (no fabricated success)                        */
/* ------------------------------------------------------------------ */

export const CapabilityStatusSchema = z.enum(["configured", "unconfigured", "blocked"]);
export type CapabilityStatus = z.infer<typeof CapabilityStatusSchema>;

export const CapabilitiesSchema = z.object({
  engine: z.object({
    kind: z.string(),
    available: z.boolean(),
    detail: z.string(),
  }),
  llm: z.object({
    provider: z.string().nullable(),
    model: z.string().nullable(),
    status: CapabilityStatusSchema,
    detail: z.string(),
  }),
  embeddings: z.object({
    provider: z.string().nullable(),
    status: CapabilityStatusSchema,
    detail: z.string(),
  }),
  vectorSearch: z.object({
    status: CapabilityStatusSchema,
    detail: z.string(),
  }),
  stagehand: z.object({
    status: CapabilityStatusSchema,
    detail: z.string(),
  }),
  /**
   * The two execution modes as the server sees them. The panel renders exactly
   * these labels, so what the employee reads is not wording invented in the UI.
   */
  browserModes: z.object({
    guided: z.object({
      available: z.literal(true),
      label: z.string(),
      context: z.string(),
    }),
    autonomous: z.object({
      status: CapabilityStatusSchema,
      label: z.string(),
      context: z.string(),
      detail: z.string(),
    }),
  }),
  database: z.object({
    kind: z.enum(["postgres", "pglite"]),
    tenancyEnforced: z.literal(true),
  }),
});
export type Capabilities = z.infer<typeof CapabilitiesSchema>;

/* ------------------------------------------------------------------ */
/* Errors                                                              */
/* ------------------------------------------------------------------ */

export class CopilotError extends Error {
  constructor(
    readonly code:
      | "unauthenticated"
      | "forbidden"
      | "not_found"
      | "invalid_request"
      | "conflict"
      | "application_ambiguous"
      | "capability_unavailable"
      | "engine_failure"
      | "verification_failed",
    message: string,
    readonly status = 400,
    readonly detail: Record<string, unknown> = {},
  ) {
    super(message);
    this.name = "CopilotError";
  }
}

/* ---------------- environment ---------------- */

export {
  parseDotEnv,
  isConfiguredValue,
  envValue,
  envUrl,
  findEnvFile,
  loadProjectEnv,
  describeUrl,
  type EnvFileResult,
} from "./env.js";
