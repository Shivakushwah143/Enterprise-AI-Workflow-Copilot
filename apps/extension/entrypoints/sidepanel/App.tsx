import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type {
  BrowserSession,
  Capabilities,
  Execution,
  ExecutionMode,
  Guidance,
  LandingPage,
  Recording,
  Role,
  Workflow,
} from "@copilot/shared";
import {
  ApiError,
  DEFAULT_API_BASE,
  api,
  type PlanResponse,
  type StoredConfig,
} from "./api.js";

const STORAGE_KEY = "copilot.session";
const WORKSPACE_KEY = "copilot.workspace";

function messageOf(error: unknown): string {
  if (error instanceof ApiError) return `${error.code}: ${error.message}`;
  if (error instanceof Error) return error.message;
  return String(error);
}

function loadConfig(): Promise<StoredConfig> {
  return new Promise((resolve) => {
    chrome.storage.local.get(STORAGE_KEY, (result) => {
      const stored = result[STORAGE_KEY] as Partial<StoredConfig> | undefined;
      resolve({
        apiBase: stored?.apiBase ?? DEFAULT_API_BASE,
        token: stored?.token ?? null,
        role: stored?.role ?? null,
        displayName: stored?.displayName ?? null,
      });
    });
  });
}

function saveConfig(config: StoredConfig | null): Promise<void> {
  return new Promise((resolve) => {
    if (!config) {
      chrome.storage.local.remove(STORAGE_KEY, () => resolve());
      return;
    }
    chrome.storage.local.set({ [STORAGE_KEY]: config }, () => resolve());
  });
}

/**
 * In-flight work survives closing and reopening the panel.
 *
 * Only identifiers and the last plan are stored; everything shown is re-read
 * from the API on restore, so a reopened panel can never display a cached
 * "success" that the server would not repeat.
 */
interface Workspace {
  mode: ExecutionMode;
  planResult: PlanResponse | null;
  executionId: string | null;
  recordingId: string | null;
  workflowId: string | null;
  browserSessionId: string | null;
  applicationChoice: { id: string; baseUrl: string } | null;
}

function loadWorkspace(): Promise<Partial<Workspace>> {
  return new Promise((resolve) => {
    chrome.storage.local.get(WORKSPACE_KEY, (result) => {
      resolve((result[WORKSPACE_KEY] as Partial<Workspace> | undefined) ?? {});
    });
  });
}

function saveWorkspace(workspace: Workspace): Promise<void> {
  return new Promise((resolve) => {
    chrome.storage.local.set({ [WORKSPACE_KEY]: workspace }, () => resolve());
  });
}

function clearWorkspace(): Promise<void> {
  return new Promise((resolve) => {
    chrome.storage.local.remove(WORKSPACE_KEY, () => resolve());
  });
}

function queryTabs(query: chrome.tabs.QueryInfo): Promise<chrome.tabs.Tab[]> {
  return new Promise((resolve) => {
    chrome.tabs.query(query, (tabs) => resolve(tabs ?? []));
  });
}

interface TabResponse {
  ok: boolean;
  highlighted?: boolean;
  found?: boolean;
  visible?: boolean;
  reason?: string;
}

interface AmbiguousApplication {
  id: string;
  name: string;
  baseUrl: string;
}

const OUTCOME_CLASS: Record<string, string> = {
  VERIFIED: "outcome ok",
  COMPLETED_UNVERIFIED: "outcome warn",
  HALTED: "outcome bad",
  FAILED: "outcome bad",
  REJECTED: "outcome bad",
  REJECTED_POLICY: "outcome bad",
};

export default function App() {
  const [config, setConfig] = useState<StoredConfig>({
    apiBase: DEFAULT_API_BASE,
    token: null,
    role: null,
    displayName: null,
  });
  const [ready, setReady] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const [tenantSlug, setTenantSlug] = useState("acme-demo");
  const [email, setEmail] = useState("admin@acme.test");

  const [capabilities, setCapabilities] = useState<Capabilities | null>(null);
  const [context, setContext] = useState<LandingPage | null>(null);
  const [tabUrl, setTabUrl] = useState("");

  const [intent, setIntent] = useState("Create a customer named ABC Technologies.");
  const [planResult, setPlanResult] = useState<PlanResponse | null>(null);
  const [inputValues, setInputValues] = useState<Record<string, string>>({});
  const [approvalChecked, setApprovalChecked] = useState(false);
  const [execution, setExecution] = useState<Execution | null>(null);

  const [recording, setRecording] = useState<Recording | null>(null);
  const [recordMode, setRecordMode] = useState<"interactive" | "scripted">("interactive");
  const [paramFields, setParamFields] = useState("company_name, email");
  const [secretFields, setSecretFields] = useState("");
  const [draftWorkflow, setDraftWorkflow] = useState<Workflow | null>(null);
  const [verificationUrl, setVerificationUrl] = useState("");
  const [verificationRecordPath, setVerificationRecordPath] = useState("items");
  const [verificationExpect, setVerificationExpect] = useState("{}");
  const [approvedSkillName, setApprovedSkillName] = useState<string | null>(null);

  const [guidance, setGuidance] = useState<Guidance | null>(null);
  const [guidanceNote, setGuidanceNote] = useState<string | null>(null);
  const [stepIndex, setStepIndex] = useState(0);
  const [stepCheck, setStepCheck] = useState<{
    found: boolean;
    visible: boolean;
    reason: string;
  } | null>(null);

  // Execution mode is chosen by the user and persisted; nothing switches it.
  const [mode, setMode] = useState<ExecutionMode>("autonomous");
  const [plannedWorkflow, setPlannedWorkflow] = useState<Workflow | null>(null);
  const [browserSession, setBrowserSession] = useState<BrowserSession | null>(null);
  const [ambiguous, setAmbiguous] = useState<AmbiguousApplication[]>([]);
  // An explicit choice is only valid for the page it was made on; carrying it
  // to another application would execute the wrong skill.
  const [applicationChoice, setApplicationChoice] = useState<{
    id: string;
    baseUrl: string;
  } | null>(null);
  const pollTimer = useRef<number | null>(null);
  const sessionTimer = useRef<number | null>(null);
  const restored = useRef(false);

  const role: Role | null = config.role;
  const isAdmin = role === "admin";
  const signedIn = Boolean(config.token);

  const findTargetTab = useCallback(async (): Promise<chrome.tabs.Tab | null> => {
    const tabs = await queryTabs({});
    const httpTabs = tabs.filter(
      (tab): tab is chrome.tabs.Tab & { url: string } =>
        typeof tab.url === "string" && /^https?:/i.test(tab.url),
    );
    // The active tab is the app when the side panel is docked. If the panel is
    // open as its own tab (as the automated test does), fall back to the first
    // web page the user has open.
    return httpTabs.find((tab) => tab.active) ?? httpTabs[0] ?? null;
  }, []);

  const sendToTab = useCallback(
    async <T extends TabResponse = TabResponse,>(message: unknown): Promise<T> => {
      const tab = await findTargetTab();
      if (tab?.id === undefined) return { ok: false, reason: "no-target-tab" } as T;
      return new Promise<T>((resolve) => {
        chrome.tabs.sendMessage(tab.id as number, message, (response: unknown) => {
          const lastError = chrome.runtime.lastError;
          if (lastError) {
            resolve({ ok: false, reason: lastError.message ?? "unreachable" } as T);
            return;
          }
          resolve((response as T | undefined) ?? ({ ok: false, reason: "no-response" } as T));
        });
      });
    },
    [findTargetTab],
  );

  const refreshContext = useCallback(async () => {
    const tab = await findTargetTab();
    const url = tab?.url ?? "";
    setTabUrl(url);
    if (!url) {
      setContext(null);
      return;
    }
    const chosen =
      applicationChoice && url.startsWith(applicationChoice.baseUrl)
        ? applicationChoice.id
        : null;
    if (applicationChoice && !chosen) setApplicationChoice(null);
    try {
      const next = await api.context(config, url, chosen);
      setContext(next);
      setAmbiguous([]);
    } catch (cause) {
      if (cause instanceof ApiError && cause.code === "application_ambiguous") {
        const candidates = (cause.detail["candidates"] ?? []) as AmbiguousApplication[];
        setAmbiguous(candidates);
        setContext(null);
        setError(null);
        setNotice(
          "This page matches more than one registered application. Choose the one this page is.",
        );
        return;
      }
      setError(messageOf(cause));
    }
  }, [config, findTargetTab, applicationChoice]);

  useEffect(() => {
    void loadConfig().then((stored) => {
      setConfig(stored);
      setReady(true);
    });
  }, []);

  useEffect(() => {
    if (!ready || !config.token) return;
    let cancelled = false;
    void (async () => {
      try {
        const caps = await api.capabilities(config);
        if (!cancelled) setCapabilities(caps);
      } catch (cause) {
        if (!cancelled) setError(messageOf(cause));
      }
    })();
    void refreshContext();
    return () => {
      cancelled = true;
    };
  }, [ready, config.token, config.apiBase, refreshContext, config]);

  useEffect(
    () => () => {
      if (pollTimer.current !== null) window.clearTimeout(pollTimer.current);
      if (sessionTimer.current !== null) window.clearTimeout(sessionTimer.current);
    },
    [],
  );

  /* ---------------- restore in-flight work after reopening ---------------- */

  useEffect(() => {
    if (!ready || !config.token || restored.current) return;
    restored.current = true;
    void (async () => {
      const workspace = await loadWorkspace();
      if (workspace.mode === "guided" || workspace.mode === "autonomous") {
        setMode(workspace.mode);
      }
      if (workspace.applicationChoice) setApplicationChoice(workspace.applicationChoice);
      if (workspace.planResult?.plan?.id) {
        try {
          // Re-read the plan: an expired plan must not look usable.
          const plan = await api.planById(config, workspace.planResult.plan.id);
          setPlanResult({ ...workspace.planResult, plan });
          if (plan.workflowId) {
            try {
              setPlannedWorkflow(await api.workflow(config, plan.workflowId));
            } catch {
              /* the workflow may be gone; the plan still shows the skill name */
            }
          }
        } catch {
          setNotice("The previous plan expired. State the outcome again.");
        }
      }
      if (workspace.executionId) {
        try {
          setExecution(await api.execution(config, workspace.executionId));
        } catch {
          /* execution history is advisory when restored */
        }
      }
      if (workspace.recordingId) {
        try {
          const response = await api.recording(config, workspace.recordingId);
          setRecording(response.recording);
          if (response.workflow) setDraftWorkflow(response.workflow);
          if (response.recording.status === "recording") {
            setNotice("A recording is still live; resuming its status.");
            pollRecording(response.recording.id);
          }
        } catch {
          /* a finished recording is not necessarily restorable */
        }
      }
      if (workspace.workflowId) {
        try {
          setDraftWorkflow(await api.workflow(config, workspace.workflowId));
        } catch {
          /* the draft may have been rejected or removed */
        }
      }
      if (workspace.browserSessionId) {
        try {
          const session = await api.browserSession(config, workspace.browserSessionId);
          setBrowserSession(session);
          if (session.status === "running") pollBrowserSession(session.id);
        } catch {
          setNotice("The previous browser session has ended. Start a new one if needed.");
        }
      }
    })();
    // Restore exactly once per signed-in session.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ready, config.token]);

  useEffect(() => {
    if (!ready || !config.token || !restored.current) return;
    void saveWorkspace({
      mode,
      planResult,
      executionId: execution?.id ?? null,
      recordingId: recording?.id ?? null,
      workflowId: draftWorkflow?.id ?? null,
      browserSessionId: browserSession?.id ?? null,
      applicationChoice,
    });
  }, [
    ready,
    config.token,
    mode,
    planResult,
    execution,
    recording,
    draftWorkflow,
    browserSession,
    applicationChoice,
    context?.applicationId,
  ]);

  const login = async (): Promise<void> => {
    setError(null);
    setBusy("login");
    try {
      const response = await api.login(config.apiBase, tenantSlug, email);
      const next: StoredConfig = {
        apiBase: config.apiBase,
        token: response.token,
        role: response.role,
        displayName: response.displayName,
      };
      await saveConfig(next);
      setConfig(next);
    } catch (cause) {
      setError(messageOf(cause));
    } finally {
      setBusy(null);
    }
  };

  const signOut = async (): Promise<void> => {
    await saveConfig(null);
    setConfig({ apiBase: config.apiBase, token: null, role: null, displayName: null });
    setCapabilities(null);
    setContext(null);
    setPlanResult(null);
    setExecution(null);
    setRecording(null);
    setDraftWorkflow(null);
    setBrowserSession(null);
    setPlannedWorkflow(null);
    setAmbiguous([]);
    setApplicationChoice(null);
    restored.current = false;
    await clearWorkspace();
  };

  const createPlan = async (): Promise<void> => {
    setError(null);
    setNotice(null);
    setBusy("plan");
    setPlanResult(null);
    setExecution(null);
    setApprovalChecked(false);
    setBrowserSession(null);
    setPlannedWorkflow(null);
    try {
      const response = await api.plan(
        config,
        intent,
        applicationChoice?.id ?? context?.applicationId ?? null,
      );
      setPlanResult(response);
      setInputValues({});
      // The pre-flight needs the real step list and risks of the selected
      // workflow, not a summary invented here.
      if (response.plan.workflowId) {
        try {
          setPlannedWorkflow(await api.workflow(config, response.plan.workflowId));
        } catch {
          setPlannedWorkflow(null);
        }
      }
    } catch (cause) {
      setError(messageOf(cause));
    } finally {
      setBusy(null);
    }
  };

  const runExecution = async (): Promise<void> => {
    if (!planResult) return;
    setError(null);
    setBusy("execute");
    setExecution(null);
    try {
      const inputs: Record<string, string> = { ...inputValues };
      for (const resolved of planResult.plan.resolvedInputs) {
        if (inputs[resolved.name] === undefined && resolved.value !== null) {
          inputs[resolved.name] = resolved.value;
        }
      }
      const result = await api.execute(config, {
        planId: planResult.plan.id,
        inputs,
        approved: approvalChecked,
      });
      setExecution(result);
    } catch (cause) {
      if (cause instanceof ApiError && cause.status === 404) {
        setPlanResult(null);
        setPlannedWorkflow(null);
        setNotice("That plan was not found or has expired. State the outcome again.");
        return;
      }
      setError(messageOf(cause));
    } finally {
      setBusy(null);
    }
  };

  const cancelRecording = async (): Promise<void> => {
    if (!recording) return;
    setBusy("record-cancel");
    setError(null);
    try {
      const cancelled = await api.cancelRecording(config, recording.id);
      setRecording(cancelled);
      if (pollTimer.current !== null) window.clearTimeout(pollTimer.current);
      await sendToTab({ type: "COPILOT_RECORDING_INDICATOR", active: false });
      setDraftWorkflow(null);
      setNotice("Recording cancelled. Nothing was compiled and no skill was created.");
    } catch (cause) {
      setError(messageOf(cause));
    } finally {
      setBusy(null);
    }
  };

  /** Guided mode: ask the page whether the recorded control is really there. */
  const verifyCurrentStep = async (): Promise<void> => {
    const selector = guidance?.selector ?? null;
    if (!selector) {
      setStepCheck({
        found: false,
        visible: false,
        reason: "No recorded selector for this step, so nothing can be checked.",
      });
      return;
    }
    const response = await sendToTab({ type: "COPILOT_VERIFY_STEP", selector });
    setStepCheck({
      found: Boolean(response.found),
      visible: Boolean(response.visible),
      reason: response.reason ?? "unknown",
    });
  };

  const pollBrowserSession = (sessionId: string): void => {
    let attempts = 0;
    const tick = async (): Promise<void> => {
      attempts += 1;
      try {
        const session = await api.browserSession(config, sessionId);
        setBrowserSession(session);
        if (session.status !== "running") return;
        if (attempts > 120) {
          setError("The browser session is taking too long; check the execution history.");
          return;
        }
        sessionTimer.current = window.setTimeout(() => void tick(), 1500);
      } catch (cause) {
        // A session the server no longer knows about has ended; say so rather
        // than leaving a stale "running" badge on screen.
        if (cause instanceof ApiError && cause.status === 404) {
          setNotice("The browser session ended. Start a new one if the task is unfinished.");
          setBrowserSession((current) =>
            current && current.id === sessionId
              ? { ...current, status: "expired", finishedAt: new Date().toISOString() }
              : current,
          );
          return;
        }
        setError(messageOf(cause));
      }
    };
    sessionTimer.current = window.setTimeout(() => void tick(), 1200);
  };

  const runAutonomous = async (): Promise<void> => {
    if (!tabUrl) {
      setError("Open the target application in a tab first.");
      return;
    }
    setError(null);
    setNotice(null);
    setBusy("autonomous");
    setBrowserSession(null);
    if (sessionTimer.current !== null) window.clearTimeout(sessionTimer.current);
    try {
      const created = await api.startBrowserSession(config, {
        url: tabUrl,
        instruction: intent,
        approved: approvalChecked,
        planId: planResult?.plan.id ?? null,
        skillId: planResult?.plan.skillId ?? null,
      });
      setBrowserSession(created);
      pollBrowserSession(created.id);
    } catch (cause) {
      if (cause instanceof ApiError && cause.code === "application_ambiguous") {
        setAmbiguous((cause.detail["candidates"] ?? []) as AmbiguousApplication[]);
        setNotice("Choose which application this page is before starting a session.");
        return;
      }
      setError(messageOf(cause));
    } finally {
      setBusy(null);
    }
  };

  const startRecording = async (): Promise<void> => {
    if (!context?.applicationId) {
      setError("This page is not a registered application, so there is nothing to record.");
      return;
    }
    setError(null);
    setNotice(null);
    setBusy("record");
    setDraftWorkflow(null);
    const fields = paramFields
      .split(",")
      .map((field) => field.trim())
      .filter((field) => field.length > 0);
    const secrets = secretFields
      .split(",")
      .map((field) => field.trim())
      .filter((field) => field.length > 0);
    try {
      const created = await api.startRecording(config, context.applicationId, {
        mode: recordMode,
        paramFields: fields,
        secretFields: secrets,
      });
      setRecording(created);
      await sendToTab({ type: "COPILOT_RECORDING_INDICATOR", active: true });
      setNotice(
        recordMode === "interactive"
          ? "A browser window opened. Perform the workflow there, then press Stop recording."
          : "Running the application's built-in demonstration.",
      );
      pollRecording(created.id);
    } catch (cause) {
      setError(messageOf(cause));
    } finally {
      setBusy(null);
    }
  };

  const pollRecording = (recordingId: string): void => {
    let attempts = 0;
    const tick = async (): Promise<void> => {
      attempts += 1;
      if (attempts > 200) return;
      try {
        const response = await api.recording(config, recordingId);
        setRecording(response.recording);
        if (response.recording.status === "compiled") {
          setDraftWorkflow(response.workflow);
          await sendToTab({ type: "COPILOT_RECORDING_INDICATOR", active: false });
          return;
        }
        if (
          response.recording.status === "failed" ||
          response.recording.status === "cancelled"
        ) {
          await sendToTab({ type: "COPILOT_RECORDING_INDICATOR", active: false });
          setError(response.recording.error ?? "The recording failed.");
          return;
        }
        pollTimer.current = window.setTimeout(() => void tick(), 1500);
      } catch (cause) {
        setError(messageOf(cause));
      }
    };
    pollTimer.current = window.setTimeout(() => void tick(), 1200);
  };

  const stopRecording = async (): Promise<void> => {
    if (!recording || recording.status !== "recording") {
      setError("There is no recording in progress.");
      return;
    }
    setError(null);
    setBusy("record-stop");
    try {
      // The server finishes the browser session, flushes the events and then
      // compiles; polling continues until the recording leaves `recording`.
      await api.stopRecording(config, recording.id);
      setNotice("Stopping the recording; the browser is flushing the last events.");
      if (pollTimer.current !== null) window.clearTimeout(pollTimer.current);
      pollRecording(recording.id);
    } catch (cause) {
      setError(messageOf(cause));
    } finally {
      setBusy(null);
    }
  };

  const approveWorkflow = async (): Promise<void> => {
    if (!draftWorkflow) return;
    setError(null);
    setBusy("approve");
    try {
      let expect: Record<string, string> = {};
      if (verificationExpect.trim().length > 0) {
        const parsed: unknown = JSON.parse(verificationExpect);
        if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
          throw new Error('"expect" must be a JSON object like {"name":"company_name"}');
        }
        expect = Object.fromEntries(
          Object.entries(parsed as Record<string, unknown>).map(([key, value]) => [
            key,
            String(value),
          ]),
        );
      }
      const url = verificationUrl.trim();
      const response = await api.approve(config, draftWorkflow.id, {
        triggeredBy: [],
        verification: url
          ? {
              kind: "http",
              tier: "system_of_record",
              url,
              recordPath: verificationRecordPath.trim() || "items",
              expect,
              match: "equals",
            }
          : null,
        acknowledgeRisk: true,
      });
      setDraftWorkflow(response.workflow);
      setApprovedSkillName(response.skill.name);
      setNotice(
        url
          ? `Approved as "${response.skill.name}" with an independent read-back contract.`
          : `Approved as "${response.skill.name}" without a verification contract: runs will end COMPLETED_UNVERIFIED, never VERIFIED.`,
      );
    } catch (cause) {
      setError(messageOf(cause));
    } finally {
      setBusy(null);
    }
  };

  const rejectWorkflow = async (): Promise<void> => {
    if (!draftWorkflow) return;
    setBusy("reject");
    try {
      const workflow = await api.reject(config, draftWorkflow.id);
      setDraftWorkflow(workflow);
      setNotice("Workflow rejected. It is not executable.");
    } catch (cause) {
      setError(messageOf(cause));
    } finally {
      setBusy(null);
    }
  };

  const requestGuidance = async (nextIndex: number): Promise<void> => {
    const skillId =
      planResult?.plan.skillId ?? context?.suggestedSkills[0]?.id ?? null;
    if (!skillId) {
      setGuidanceNote("No approved skill is available for this page.");
      return;
    }
    setGuidanceNote(null);
    try {
      const result = await api.guidance(config, skillId, Math.max(0, nextIndex));
      setGuidance(result);
      setStepIndex(result.stepIndex);
      if (!result.highlightable) {
        setGuidanceNote("No verified selector for this step - not highlighting");
        await sendToTab({ type: "COPILOT_CLEAR_HIGHLIGHT" });
        return;
      }
      const response = await sendToTab({
        type: "COPILOT_HIGHLIGHT",
        selector: result.selector,
        instruction: result.instruction,
        elementName: result.elementName,
      });
      if (!response.highlighted) {
        setGuidanceNote(`Could not highlight: ${response.reason ?? "unknown reason"}`);
      }
    } catch (cause) {
      setGuidanceNote(messageOf(cause));
    }
  };

  const clearHighlight = async (): Promise<void> => {
    await sendToTab({ type: "COPILOT_CLEAR_HIGHLIGHT" });
    setGuidance(null);
    setGuidanceNote(null);
  };

  const plan = planResult?.plan ?? null;
  const missingInputs = useMemo(() => plan?.missingInputs ?? [], [plan]);
  const verdict = execution?.outcome ?? null;

  if (!ready) {
    return <main className="panel">Loading…</main>;
  }

  return (
    <main className="panel">
      <header className="brand">
        <h1>Workflow Copilot</h1>
        <p className="muted">Approved workflows, executed and verified.</p>
      </header>

      {error ? (
        <div className="alert bad" data-testid="error">
          {error}
        </div>
      ) : null}
      {notice ? (
        <div className="alert info" data-testid="notice">
          {notice}
        </div>
      ) : null}

      {!signedIn ? (
        <section className="card">
          <h2>Connect</h2>
          <label htmlFor="api-base">API base URL</label>
          <input
            id="api-base"
            data-testid="api-base"
            value={config.apiBase}
            onChange={(event) =>
              setConfig({ ...config, apiBase: event.target.value })
            }
          />
          <label htmlFor="login-tenant">Tenant</label>
          <input
            id="login-tenant"
            data-testid="login-tenant"
            value={tenantSlug}
            onChange={(event) => setTenantSlug(event.target.value)}
          />
          <label htmlFor="login-email">Email</label>
          <input
            id="login-email"
            data-testid="login-email"
            value={email}
            onChange={(event) => setEmail(event.target.value)}
          />
          <button
            type="button"
            data-testid="login-submit"
            disabled={busy === "login"}
            onClick={() => void login()}
          >
            {busy === "login" ? "Connecting…" : "Sign in"}
          </button>
          <p className="muted small">
            Local demo sign-in: the tenant and email identify a seeded user. There
            is no password in this build, so do not use real accounts.
          </p>
        </section>
      ) : (
        <>
          <section className="card">
            <div className="row space">
              <div>
                <h2>Session</h2>
                <p className="muted small" data-testid="connection-status">
                  {config.apiBase} · {role} · {config.displayName}
                </p>
              </div>
              <button
                type="button"
                data-testid="sign-out"
                className="secondary"
                onClick={() => void signOut()}
              >
                Sign out
              </button>
            </div>
            <div className="badges">
              <Badge
                testId="capability-llm"
                label="Model"
                value={capabilities?.llm.status ?? "unknown"}
                title={capabilities?.llm.detail ?? ""}
              />
              <Badge
                testId="capability-vector"
                label="Vector search"
                value={capabilities?.vectorSearch.status ?? "unknown"}
                title={capabilities?.vectorSearch.detail ?? ""}
              />
              <Badge
                testId="capability-stagehand"
                label="Stagehand"
                value={capabilities?.stagehand.status ?? "unknown"}
                title={capabilities?.stagehand.detail ?? ""}
              />
              <Badge
                testId="capability-engine"
                label="Engine"
                value={
                  capabilities
                    ? capabilities.engine.available
                      ? "available"
                      : "unavailable"
                    : "unknown"
                }
                title={capabilities?.engine.detail ?? ""}
              />
            </div>
          </section>

          <section className="card">
            <div className="row space">
              <h2>Current application</h2>
              <button type="button" className="link" onClick={() => void refreshContext()}>
                Refresh
              </button>
            </div>
            <p className="muted small break" data-testid="app-context">
              {context?.appName ?? "Not a registered application"}
              {" — "}
              {tabUrl || "no page detected"}
            </p>
            {context?.suggestedSkills.length ? (
              <ul className="list">
                {context.suggestedSkills.map((skill) => (
                  <li key={skill.id}>
                    <strong>{skill.name}</strong>
                    <span className="muted small"> {skill.description}</span>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="muted small">No approved skill is registered for this app yet.</p>
            )}
          </section>

          <section className="card">
            <h2>Execution mode</h2>
            <select
              data-testid="mode-select"
              value={mode}
              onChange={(event) =>
                setMode(event.target.value === "guided" ? "guided" : "autonomous")
              }
            >
              <option value="guided">Guided — I perform it in this tab</option>
              <option value="autonomous">Autonomous — a controlled browser does it</option>
            </select>
            <p className="small" data-testid="execution-mode">
              {mode === "guided"
                ? `${capabilities?.browserModes.guided.label ?? "Guided"} — ${
                    capabilities?.browserModes.guided.context ?? "Current browser tab"
                  }`
                : `${capabilities?.browserModes.autonomous.label ?? "Autonomous"} — ${
                    capabilities?.browserModes.autonomous.context ?? "Controlled browser session"
                  }`}
            </p>
            <p className="muted small" data-testid="execution-mode-detail">
              {mode === "guided"
                ? "You perform each step in your own tab. The copilot highlights the recorded control and checks it is there; it never acts for you."
                : "The copilot works in a separate controlled browser, not in your tab. An approved workflow still needs your explicit approval before it runs."}
            </p>
            {ambiguous.length > 0 ? (
              <div className="alert warn" data-testid="ambiguous-applications">
                <strong>Which application is this page?</strong>
                <ul className="list">
                  {ambiguous.map((candidate) => (
                    <li key={candidate.id}>
                      <button
                        type="button"
                        className="link"
                        data-testid={`choose-application-${candidate.id}`}
                        onClick={() => {
                          setApplicationChoice({ id: candidate.id, baseUrl: candidate.baseUrl });
                          setAmbiguous([]);
                          setNotice(null);
                        }}
                      >
                        {candidate.name}
                      </button>
                      <span className="muted small"> {candidate.baseUrl}</span>
                    </li>
                  ))}
                </ul>
                <p className="muted small">
                  Several registered applications share this identity. Nothing is
                  chosen automatically.
                </p>
              </div>
            ) : null}
          </section>

          <section className="card">
            <h2>Ask for an outcome</h2>
            <textarea
              data-testid="intent-input"
              rows={3}
              value={intent}
              onChange={(event) => setIntent(event.target.value)}
            />
            <button
              type="button"
              data-testid="plan-submit"
              disabled={
                busy === "plan" ||
                busy === "execute" ||
                busy === "autonomous" ||
                intent.trim().length < 3
              }
              onClick={() => void createPlan()}
            >
              {busy === "plan" ? "Planning…" : "Plan"}
            </button>

            {plan ? (
              <div className="stack">
                <p data-testid="plan-skill">
                  <strong>{plan.skillName ?? "No skill selected"}</strong>
                  <span className="muted small">
                    {" "}
                    confidence {plan.confidence.toFixed(2)} ·{" "}
                    {planResult?.method ?? "deterministic"} planner
                  </span>
                </p>
                {plan.blockers.length > 0 ? (
                  <div className="alert bad" data-testid="plan-blockers">
                    {plan.blockers.join(" ")}
                  </div>
                ) : null}
                <ul className="list" data-testid="plan-candidates">
                  {plan.candidates.map((candidate) => (
                    <li key={candidate.skillId}>
                      {candidate.skillName} · {candidate.score.toFixed(2)} ·{" "}
                      <span className="muted small">{candidate.reason}</span>
                    </li>
                  ))}
                </ul>
                {planResult?.notes.length ? (
                  <ul className="list muted small" data-testid="plan-notes">
                    {planResult.notes.map((note) => (
                      <li key={note}>{note}</li>
                    ))}
                  </ul>
                ) : null}

                <div data-testid="plan-missing-inputs">
                  {missingInputs.length === 0 ? (
                    <p className="muted small">All required inputs are known.</p>
                  ) : (
                    missingInputs.map((param) => (
                      <div key={param.name}>
                        <label htmlFor={`missing-${param.name}`}>{param.label}</label>
                        <input
                          id={`missing-${param.name}`}
                          data-testid={`missing-${param.name}`}
                          type={param.secret ? "password" : "text"}
                          value={inputValues[param.name] ?? ""}
                          onChange={(event) =>
                            setInputValues({
                              ...inputValues,
                              [param.name]: event.target.value,
                            })
                          }
                        />
                      </div>
                    ))
                  )}
                </div>

                {plan.requiresApproval ? (
                  <div className="alert warn" data-testid="approval-required">
                    <strong>Approval required.</strong>{" "}
                    {plan.approvalReason ?? "This run writes to a business system."}
                    <label className="check">
                      <input
                        type="checkbox"
                        data-testid="approval-checkbox"
                        checked={approvalChecked}
                        onChange={(event) => setApprovalChecked(event.target.checked)}
                      />
                      I approve this run.
                    </label>
                  </div>
                ) : (
                  <label className="check">
                    <input
                      type="checkbox"
                      data-testid="approval-checkbox"
                      checked={approvalChecked}
                      onChange={(event) => setApprovalChecked(event.target.checked)}
                    />
                    Approve this run (optional for reversible steps).
                  </label>
                )}

                {mode === "guided" ? (
                  <p className="alert info" data-testid="guided-note">
                    Guided mode does not act for you. Use “Highlight” and
                    “Check this step” to walk through the approved workflow in this
                    tab, or switch to Autonomous to have the copilot run it in a
                    controlled browser.
                  </p>
                ) : (
                  <div className="stack" data-testid="autonomous-preflight">
                    <h3>Controlled browser session</h3>
                    <p className="small" data-testid="session-target">
                      Target application: {context?.appName ?? "not registered"} ·{" "}
                      {tabUrl || "no page detected"}
                    </p>
                    <p className="small" data-testid="session-skill">
                      Selected skill: {plan.skillName ?? "none — no approved workflow covers this"}
                    </p>
                    <p className="small" data-testid="session-type">
                      Session type:{" "}
                      {capabilities?.browserModes.autonomous.context ??
                        "Controlled browser session"}{" "}
                      (not your tab)
                    </p>
                    <div data-testid="session-inputs">
                      <p className="small">Inputs</p>
                      <ul className="list muted small">
                        {plan.resolvedInputs.map((input) => (
                          <li key={input.name}>
                            {input.name} = {input.secret ? "••••" : input.value ?? "(missing)"}
                          </li>
                        ))}
                        {missingInputs.map((input) => (
                          <li key={input.name}>
                            {input.name} = {inputValues[input.name] ? "(supplied)" : "(missing)"}
                          </li>
                        ))}
                      </ul>
                    </div>
                    <div data-testid="session-actions">
                      <p className="small">Requested actions</p>
                      <ol className="steps">
                        {(plannedWorkflow?.steps ?? []).map((step) => (
                          <li key={step.id}>
                            <span className="idx">{step.index + 1}</span>
                            <span>{step.intent}</span>
                            <span className="muted small"> {step.risk}</span>
                          </li>
                        ))}
                        {(plannedWorkflow?.steps ?? []).length === 0 ? (
                          <li className="muted small">No approved workflow steps are bound.</li>
                        ) : null}
                      </ol>
                    </div>
                    <p className="small" data-testid="session-impact">
                      Expected impact:{" "}
                      {plan.requiresApproval
                        ? `writes to ${context?.appName ?? "the application"}; the result is only accepted after an independent read-back.`
                        : "read-only; no write is requested by this plan."}
                    </p>
                    <p className="small" data-testid="session-approval">
                      {plan.requiresApproval
                        ? approvalChecked
                          ? "You approved this run."
                          : "Approval is required before this run can start."
                        : "No consequential step, so no approval is required."}
                    </p>
                    <button
                      type="button"
                      data-testid="execute-button"
                      disabled={
                        busy === "execute" ||
                        busy === "autonomous" ||
                        plan.blockers.length > 0 ||
                        (plan.requiresApproval && !approvalChecked) ||
                        missingInputs.some((input) => !inputValues[input.name])
                      }
                      onClick={() => void runExecution()}
                    >
                      {busy === "execute" ? "Executing…" : "Execute approved workflow"}
                    </button>
                    <button
                      type="button"
                      className="secondary"
                      data-testid="stagehand-run"
                      // The AI path exists for the case no approved workflow
                      // covers, so plan blockers do not disable it; the policy
                      // gate and approval still do.
                      disabled={
                        busy === "autonomous" ||
                        busy === "execute" ||
                        (plan.requiresApproval && !approvalChecked)
                      }
                      onClick={() => void runAutonomous()}
                    >
                      {busy === "autonomous"
                        ? "Starting session…"
                        : "Run in AI browser session"}
                    </button>
                    <p className="muted small">
                      The AI browser starts from the same request and is bounded; it
                      reports what it actually did and never claims your tab was used.
                    </p>
                  </div>
                )}
                <p className="muted small">
                  The agent never fills a missing input itself: it asks, then runs.
                </p>
              </div>
            ) : null}
          </section>

          {execution ? (
            <section className="card">
              <h2>Execution</h2>
              <p
                className={OUTCOME_CLASS[verdict ?? ""] ?? "outcome"}
                data-testid="execution-outcome"
              >
                {verdict ?? execution.status}
              </p>
              <p className="small" data-testid="execution-message">
                {execution.message ?? ""}
              </p>
              <p className="muted small" data-testid="execution-engine-outcome">
                engine outcome: {execution.engineOutcome ?? "none"} · model calls:{" "}
                {execution.modelCalls}
              </p>
              {verdict !== null && verdict !== "VERIFIED" ? (
                <p className="alert bad">
                  The system of record did not confirm this operation. Treat it as
                  not completed.
                </p>
              ) : null}
              <ol className="steps" data-testid="step-list">
                {execution.steps.map((step) => (
                  <li key={`${step.index}-${step.stepId ?? "step"}`} className={step.status}>
                    <span className="idx">{step.index + 1}</span>
                    <span>{step.intent}</span>
                    <span className="muted small">
                      {step.status}
                      {step.rung ? ` · ${step.rung}` : ""}
                    </span>
                  </li>
                ))}
              </ol>
              <div data-testid="verification-result" className="verify">
                {execution.verification ? (
                  <>
                    <p className="small">
                      {execution.verification.passed ? "PASSED" : "NOT CONFIRMED"} ·{" "}
                      {execution.verification.tier} · {execution.verification.source}
                    </p>
                    <p className="muted small">{execution.verification.detail}</p>
                    {execution.verification.observed ? (
                      <pre className="json">
                        {JSON.stringify(execution.verification.observed, null, 2)}
                      </pre>
                    ) : null}
                  </>
                ) : (
                  <p className="muted small">
                    No verification contract is bound to this skill, so completion
                    cannot be proven.
                  </p>
                )}
              </div>
            </section>
          ) : null}

          {isAdmin ? (
            <section className="card">
              <h2>Learn this app</h2>
              <p className="muted small">
                A demonstration is recorded, compiled into a workflow, and then
                waits for your approval. Nothing executes until you approve it.
              </p>
              <label htmlFor="record-mode">How should the demonstration run?</label>
              <select
                id="record-mode"
                data-testid="record-mode"
                value={recordMode}
                onChange={(event) =>
                  setRecordMode(event.target.value === "scripted" ? "scripted" : "interactive")
                }
              >
                <option value="interactive">Interactive — I perform it in a browser</option>
                <option value="scripted">Built-in demonstration (no human)</option>
              </select>
              <label htmlFor="record-param-fields">
                Parameter fields (comma separated field names)
              </label>
              <input
                id="record-param-fields"
                data-testid="record-param-fields"
                value={paramFields}
                onChange={(event) => setParamFields(event.target.value)}
              />
              <label htmlFor="record-secret-fields">Secret fields (never persisted)</label>
              <input
                id="record-secret-fields"
                data-testid="record-secret-fields"
                value={secretFields}
                onChange={(event) => setSecretFields(event.target.value)}
              />
              <div className="row">
                <button
                  type="button"
                  data-testid="record-start"
                  disabled={
                    busy === "record" ||
                    busy === "execute" ||
                    busy === "autonomous" ||
                    recording?.status === "recording"
                  }
                  onClick={() => void startRecording()}
                >
                  Start recording
                </button>
                <button
                  type="button"
                  data-testid="record-stop"
                  className="secondary"
                  disabled={recording?.status !== "recording" || busy === "record-stop"}
                  onClick={() => void stopRecording()}
                >
                  Stop recording
                </button>
                <button
                  type="button"
                  className="link"
                  data-testid="record-cancel"
                  disabled={recording?.status !== "recording" || busy === "record-cancel"}
                  onClick={() => void cancelRecording()}
                >
                  Cancel recording
                </button>
              </div>
              {recording?.status === "recording" ? (
                <p className="recording" data-testid="recording-indicator">
                  ● Recording demonstration
                </p>
              ) : null}
              {recording ? (
                <p className="muted small">
                  recording {recording.id.slice(0, 8)} · {recording.status} ·{" "}
                  {recording.mode}
                  {recording.error ? ` · ${recording.error}` : ""}
                </p>
              ) : null}

              {draftWorkflow ? (
                <div className="stack">
                  <h3>Proposed workflow: {draftWorkflow.name}</h3>
                  <p className="muted small">{draftWorkflow.status}</p>
                  <ol className="steps" data-testid="workflow-preview">
                    {draftWorkflow.steps.map((step) => (
                      <li key={step.id}>
                        <span className="idx">{step.index + 1}</span>
                        <span>{step.intent}</span>
                        <span className="muted small">
                          {step.action} · {step.risk} · {step.confidence}
                          {step.selector ? ` · ${step.selector}` : ""}
                          {step.uncertaintyNote ? ` · ${step.uncertaintyNote}` : ""}
                        </span>
                      </li>
                    ))}
                  </ol>
                  <div data-testid="workflow-uncertainty">
                    {draftWorkflow.uncertainty.length === 0 ? (
                      <p className="muted small">No recorded uncertainty.</p>
                    ) : (
                      <ul className="list muted small">
                        {draftWorkflow.uncertainty.map((item) => (
                          <li key={item}>{item}</li>
                        ))}
                      </ul>
                    )}
                  </div>
                  <h4>Independent read-back contract</h4>
                  <p className="muted small">
                    Without this the run can never be VERIFIED. Use {"{param}"} for
                    input values.
                  </p>
                  <label htmlFor="verification-url">Read-back URL</label>
                  <input
                    id="verification-url"
                    data-testid="verification-url-input"
                    placeholder="http://127.0.0.1:4300/api/customers?name={company_name}"
                    value={verificationUrl}
                    onChange={(event) => setVerificationUrl(event.target.value)}
                  />
                  <label htmlFor="verification-recordpath">Record path</label>
                  <input
                    id="verification-recordpath"
                    data-testid="verification-recordpath-input"
                    value={verificationRecordPath}
                    onChange={(event) => setVerificationRecordPath(event.target.value)}
                  />
                  <label htmlFor="verification-expect">
                    Expected fields (JSON: observed field → input name)
                  </label>
                  <input
                    id="verification-expect"
                    data-testid="verification-expect-input"
                    placeholder='{"name":"company_name","email":"email"}'
                    value={verificationExpect}
                    onChange={(event) => setVerificationExpect(event.target.value)}
                  />
                  <div className="row">
                    <button
                      type="button"
                      data-testid="approve-button"
                      disabled={busy === "approve" || draftWorkflow.status === "approved"}
                      onClick={() => void approveWorkflow()}
                    >
                      {draftWorkflow.status === "approved" ? "Approved" : "Approve workflow"}
                    </button>
                    <button
                      type="button"
                      data-testid="reject-button"
                      className="secondary"
                      disabled={busy === "reject"}
                      onClick={() => void rejectWorkflow()}
                    >
                      Reject
                    </button>
                  </div>
                  {approvedSkillName ? (
                    <p className="small">Executable skill: {approvedSkillName}</p>
                  ) : null}
                </div>
              ) : null}
            </section>
          ) : null}

          {context?.suggestedSkills.length ? (
            <section className="card">
              <h2>Walk me through it</h2>
              <div className="row">
                <button
                  type="button"
                  data-testid="guidance-prev"
                  className="secondary"
                  onClick={() => void requestGuidance(stepIndex - 1)}
                >
                  Previous
                </button>
                <button
                  type="button"
                  data-testid="guidance-next"
                  onClick={() => void requestGuidance(stepIndex + 1)}
                >
                  Next
                </button>
                <button
                  type="button"
                  data-testid="highlight-current"
                  className="secondary"
                  onClick={() => void requestGuidance(stepIndex)}
                >
                  Highlight
                </button>
                <button type="button" className="link" onClick={() => void clearHighlight()}>
                  Clear
                </button>
              </div>
              <p className="small" data-testid="guidance-instruction">
                {guidance
                  ? `Step ${guidance.stepIndex + 1}/${guidance.totalSteps}: ${guidance.instruction}`
                  : "No step highlighted yet."}
              </p>
              {guidanceNote ? (
                <p className="muted small" data-testid="guidance-note">
                  {guidanceNote}
                </p>
              ) : null}
              <p className="muted small" data-testid="guided-context">
                Guided — Current browser tab · you act, the copilot highlights and checks.
              </p>
              <button
                type="button"
                className="secondary"
                data-testid="guidance-verify"
                onClick={() => void verifyCurrentStep()}
              >
                Check this step
              </button>
              {stepCheck ? (
                <p
                  className={stepCheck.found && stepCheck.visible ? "outcome ok" : "outcome bad"}
                  data-testid="guidance-verified"
                >
                  {stepCheck.found && stepCheck.visible
                    ? "The recorded control is on the page and visible."
                    : `Not observed in this tab (${stepCheck.reason}). The step is not confirmed.`}
                </p>
              ) : null}
            </section>
          ) : null}

          {browserSession ? (
            <section className="card">
              <h2>Controlled browser session</h2>
              <p className="muted small" data-testid="browser-session-id">
                session {browserSession.id.slice(0, 8)} · {browserSession.sessionType} ·{" "}
                {browserSession.applicationName}
              </p>
              <p className="small" data-testid="browser-session-target">
                {browserSession.targetUrl}
              </p>
              <p
                className={
                  browserSession.status === "completed"
                    ? "outcome ok"
                    : browserSession.status === "running"
                      ? "outcome warn"
                      : "outcome bad"
                }
                data-testid="browser-session-status"
              >
                {browserSession.status}
              </p>
              {browserSession.summary ? (
                <p className="small" data-testid="browser-session-summary">
                  {browserSession.summary}
                </p>
              ) : null}
              {browserSession.error ? (
                <p className="alert bad" data-testid="browser-session-error">
                  {browserSession.error}
                </p>
              ) : null}
              <ol className="steps" data-testid="browser-session-actions">
                {browserSession.actions.map((action, index) => (
                  <li key={`${index}-${action}`}>
                    <span className="idx">{index + 1}</span>
                    <span>{action}</span>
                  </li>
                ))}
              </ol>
            </section>
          ) : null}
        </>
      )}
    </main>
  );
}

function Badge(props: {
  testId: string;
  label: string;
  value: string;
  title: string;
}) {
  const kind = props.value === "configured" || props.value === "available" ? "ok" : "warn";
  return (
    <span className={`badge ${kind}`} data-testid={props.testId} title={props.title}>
      {props.label}: {props.value}
    </span>
  );
}
