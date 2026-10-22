/**
 * API client for the side panel.
 *
 * Every value the UI shows comes from one of these calls; nothing is inferred
 * locally. Errors carry the server's `{error:{code,message}}` verbatim.
 */
import type {
  Capabilities,
  Execution,
  LandingPage,
  Plan,
  Recording,
  Role,
  Skill,
  Workflow,
} from "@copilot/shared";

export const DEFAULT_API_BASE = "http://127.0.0.1:4000";

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

export interface StoredConfig {
  apiBase: string;
  token: string | null;
  role: Role | null;
  displayName: string | null;
}

export interface LoginResponse {
  token: string;
  tenantId: string;
  tenantSlug: string;
  userId: string;
  role: Role;
  displayName: string;
  expiresAt: string;
}

export interface PlanResponse {
  plan: Plan;
  method: "model" | "deterministic";
  notes: string[];
  modelCalls: number;
  knowledge: {
    hits: { chunkId: string; title: string; content: string; score: number; method: string }[];
    method: "keyword" | "vector";
    notice: string | null;
  };
}

export interface RecordingResponse {
  recording: Recording;
  workflow: Workflow | null;
}

export interface ApproveResponse {
  workflow: Workflow;
  skill: Skill;
}

export async function apiRequest<T>(
  config: Pick<StoredConfig, "apiBase" | "token">,
  path: string,
  init: { method?: string; body?: unknown } = {},
): Promise<T> {
  const headers: Record<string, string> = { accept: "application/json" };
  if (init.body !== undefined) headers["content-type"] = "application/json";
  if (config.token) headers["authorization"] = `Bearer ${config.token}`;

  const response = await fetch(`${config.apiBase.replace(/\/$/, "")}${path}`, {
    method: init.method ?? "GET",
    headers,
    body: init.body === undefined ? undefined : JSON.stringify(init.body),
  });

  const text = await response.text();
  let payload: unknown = null;
  if (text) {
    try {
      payload = JSON.parse(text);
    } catch {
      payload = null;
    }
  }

  if (!response.ok) {
    const error = payload as { error?: { code?: string; message?: string } } | null;
    throw new ApiError(
      response.status,
      error?.error?.code ?? "http_error",
      error?.error?.message ?? `Request failed with HTTP ${response.status}`,
    );
  }
  return payload as T;
}

export const api = {
  login: (apiBase: string, tenantSlug: string, email: string) =>
    apiRequest<LoginResponse>({ apiBase, token: null }, "/api/auth/login", {
      method: "POST",
      body: { tenantSlug, email },
    }),
  capabilities: (config: StoredConfig) => apiRequest<Capabilities>(config, "/api/capabilities"),
  context: (config: StoredConfig, url: string) =>
    apiRequest<LandingPage>(config, `/api/context?url=${encodeURIComponent(url)}`),
  plan: (config: StoredConfig, intent: string) =>
    apiRequest<PlanResponse>(config, "/api/plans", { method: "POST", body: { intent } }),
  execute: (config: StoredConfig, body: { planId: string; inputs: Record<string, string>; approved: boolean }) =>
    apiRequest<Execution>(config, "/api/executions", { method: "POST", body }),
  execution: (config: StoredConfig, id: string) =>
    apiRequest<Execution>(config, `/api/executions/${id}`),
  startRecording: (config: StoredConfig, applicationId: string) =>
    apiRequest<RecordingResponse["recording"]>(config, "/api/recordings", {
      method: "POST",
      body: { applicationId, mode: "scripted" },
    }),
  recording: (config: StoredConfig, id: string) =>
    apiRequest<RecordingResponse>(config, `/api/recordings/${id}`),
  approve: (
    config: StoredConfig,
    workflowId: string,
    body: {
      name?: string;
      description?: string;
      triggeredBy: string[];
      verification: {
        kind: "http";
        tier: "system_of_record";
        url: string;
        recordPath: string;
        expect: Record<string, string>;
        match: "includes" | "equals";
      } | null;
      acknowledgeRisk: boolean;
    },
  ) => apiRequest<ApproveResponse>(config, `/api/workflows/${workflowId}/approve`, {
    method: "POST",
    body,
  }),
  reject: (config: StoredConfig, workflowId: string) =>
    apiRequest<Workflow>(config, `/api/workflows/${workflowId}/reject`, { method: "POST" }),
  guidance: (config: StoredConfig, skillId: string, stepIndex: number) =>
    apiRequest<{
      skillId: string;
      stepIndex: number;
      totalSteps: number;
      action: string;
      instruction: string;
      selector: string | null;
      elementName: string | null;
      risk: "reversible" | "irreversible";
      highlightable: boolean;
    }>(config, `/api/guidance?skillId=${encodeURIComponent(skillId)}&stepIndex=${stepIndex}`),
};
