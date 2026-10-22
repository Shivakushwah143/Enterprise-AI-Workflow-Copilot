/**
 * M5 — onboarding an independent application.
 *
 * The pipeline does not know any application by name. Everything an application
 * needs is configuration: a base URL (its identity), the administrator's browser
 * session for the demonstration, and a verification contract that reads the
 * business record back from the application itself.
 *
 *   check                          what is missing before a real app can be onboarded
 *   onboard --name --url           register (idempotent) and prove the identity resolves
 *   verify --skill --inputs JSON   execute an approved skill with new input, read back
 *   verify ... --no-approve        the same run without approval: must be refused
 *
 * Against a running API:
 *   COPILOT_API_URL=http://127.0.0.1:4110 COPILOT_TOKEN=... \
 *     pnpm tsx scripts/m5-onboard-app.ts onboard --name "SynTask HRMS" --url "$SYNTASK_BASE_URL"
 */
import { readFile } from "node:fs/promises";

const apiBase = (process.env.COPILOT_API_URL ?? "http://127.0.0.1:4110").replace(/\/$/, "");
const token = process.env.COPILOT_TOKEN ?? "";

interface Args {
  command: string;
  flags: Map<string, string | true>;
}

function parseArgs(argv: string[]): Args {
  const [command = "check", ...rest] = argv;
  const flags = new Map<string, string | true>();
  for (let i = 0; i < rest.length; i += 1) {
    const arg = rest[i]!;
    if (!arg.startsWith("--")) continue;
    const key = arg.slice(2);
    const next = rest[i + 1];
    if (next && !next.startsWith("--")) {
      flags.set(key, next);
      i += 1;
    } else {
      flags.set(key, true);
    }
  }
  return { command, flags };
}

function flag(args: Args, name: string): string | null {
  const value = args.flags.get(name);
  return typeof value === "string" ? value : null;
}

async function api<T = any>(
  method: string,
  route: string,
  body?: unknown,
): Promise<{ status: number; body: T }> {
  if (!token) {
    throw new Error("COPILOT_TOKEN is required (an administrator's bearer token).");
  }
  const response = await fetch(`${apiBase}${route}`, {
    method,
    headers: {
      accept: "application/json",
      authorization: `Bearer ${token}`,
      ...(body === undefined ? {} : { "content-type": "application/json" }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  return { status: response.status, body: (text ? JSON.parse(text) : null) as T };
}

/**
 * The two external targets the batch names. Only environment presence is
 * checked: no URL is contacted when it is not configured, and nothing is
 * installed or cloned.
 */
const EXTERNAL = [
  {
    slug: "syntask",
    label: "SynTask HRMS",
    url: "SYNTASK_BASE_URL",
    credential: "SYNTASK_API_TOKEN",
    workflow: "Create employee",
    readback: "an employee record readable by employee id or email",
    login: "an isolated SynTask test tenant plus a test role allowed to create employees",
  },
  {
    slug: "twenty",
    label: "Twenty CRM",
    url: "TWENTY_BASE_URL",
    credential: "TWENTY_API_TOKEN",
    workflow: "Create person/company",
    readback: "a person or company record readable through the REST API",
    login: "an isolated Twenty workspace plus an API token for a test account",
  },
] as const;

async function reachable(url: string): Promise<{ ok: boolean; detail: string }> {
  try {
    const response = await fetch(url, {
      method: "GET",
      redirect: "follow",
      signal: AbortSignal.timeout(8_000),
    });
    return { ok: response.ok || response.status < 400, detail: `HTTP ${response.status}` };
  } catch (error) {
    return { ok: false, detail: error instanceof Error ? error.message : String(error) };
  }
}

async function check(): Promise<number> {
  let available = 0;
  for (const target of EXTERNAL) {
    const url = process.env[target.url];
    const credential = Boolean(process.env[target.credential]);
    const probe = url ? await reachable(url) : { ok: false, detail: "not configured" };
    const state = url && probe.ok && credential ? "AVAILABLE" : "BLOCKED";
    if (state === "AVAILABLE") available += 1;
    console.log(
      JSON.stringify({
        application: target.label,
        slug: target.slug,
        state,
        url: url ? `${new URL(url).origin} (configured)` : null,
        credential: credential ? "configured" : "missing",
        probe: probe.detail,
        missing: [
          ...(url ? [] : [target.url]),
          ...(credential ? [] : [target.credential]),
          ...(url && !probe.ok ? ["a reachable instance at " + target.url] : []),
        ],
        required: [target.login, `a workflow "${target.workflow}"`, `read-back contract: ${target.readback}`],
      }),
    );
  }
  console.log(
    available === 0
      ? "BLOCKED: no independent application is configured; set the variables above and re-run."
      : `${available}/${EXTERNAL.length} independent applications are configured.`,
  );
  if (available === 0) {
    const availableLocal = await Promise.all(
      ["http://127.0.0.1:4300", "http://127.0.0.1:4400"].map(async (url) => ({
        url,
        ...(await reachable(url)),
      })),
    );
    console.log(
      `local demo applications: ${availableLocal
        .map((row) => `${row.url}=${row.ok ? "up" : "down"}`)
        .join(", ")} (project-owned demos; never counted as independent)`,
    );
  }
  return 0;
}

async function onboard(args: Args): Promise<number> {
  const name = flag(args, "name");
  const url = flag(args, "url");
  if (!name || !url) throw new Error("onboard requires --name and --url");
  const verificationPath = flag(args, "verification");

  const registered = await api<any>("POST", "/api/applications", {
    name,
    baseUrl: url,
    ...(verificationPath
      ? { verificationBaseUrl: flag(args, "verification-base-url") ?? url }
      : {}),
  });
  if (registered.status >= 400) {
    console.error(`registration failed: HTTP ${registered.status} ${JSON.stringify(registered.body)}`);
    return 1;
  }
  const application = registered.body;
  console.log(
    `registered: ${application.name} ${application.id} (${application.baseUrl})${application.reused ? " — existing row reused" : ""}`,
  );

  // Identity is the base URL. Prove the API resolves this exact page to this row.
  const context = await api<any>("GET", `/api/context?url=${encodeURIComponent(url)}`);
  const resolved = context.body?.applicationId === application.id;
  console.log(
    `identity: ${resolved ? "resolves to this application" : `NOT resolved (${context.status})`}`,
  );

  const workflows = await api<any>("GET", "/api/workflows");
  const forApp = (workflows.body?.items ?? []).filter(
    (row: any) => row.applicationId === application.id,
  );
  console.log(
    `workflows: ${forApp.length} for this application` +
      (forApp.length
        ? ` — ${forApp.map((row: any) => `${row.name} [${row.status}]`).join(", ")}`
        : " — none yet; the administrator must record one (interactive recording) before anything can run"),
  );

  if (!resolved) return 1;

  if (verificationPath) {
    const contract = JSON.parse(await readFile(verificationPath, "utf8"));
    console.log(
      `verification contract for approval: ${JSON.stringify({ kind: contract.kind, tier: contract.tier, url: contract.url, recordPath: contract.recordPath })}`,
    );
  }
  return 0;
}

async function verify(args: Args): Promise<number> {
  const skillId = flag(args, "skill");
  const intent = flag(args, "intent");
  const inputs = JSON.parse(flag(args, "inputs") ?? "{}") as Record<string, string>;
  const approved = !args.flags.has("no-approve");
  if (!skillId || !intent) throw new Error("verify requires --skill and --intent");

  const plan = await api<any>("POST", "/api/plans", { intent });
  if (!plan.body?.plan?.id) {
    console.error(`no plan: HTTP ${plan.status} ${JSON.stringify(plan.body)}`);
    return 1;
  }
  if (plan.body.plan.blockers?.length) {
    console.error(`plan blocked: ${plan.body.plan.blockers.join(" ")}`);
    return 1;
  }
  const execution = await api<any>("POST", "/api/executions", {
    planId: plan.body.plan.id,
    inputs,
    approved,
    allowAiLocator: false,
    memory: "enabled",
  });
  const run = execution.body;
  console.log(
    JSON.stringify(
      {
        outcome: run?.outcome,
        status: run?.status,
        verified: run?.verification?.passed ?? null,
        verificationTier: run?.verification?.tier ?? null,
        failure: run?.failure ?? null,
        memory: run?.memory ?? null,
        message: run?.message,
      },
      null,
      2,
    ),
  );
  if (!approved) {
    const refused = run?.outcome === "REJECTED_POLICY";
    console.log(refused ? "safety: refused without approval" : "SAFETY FAILURE: executed without approval");
    return refused ? 0 : 1;
  }
  return run?.outcome === "VERIFIED" ? 0 : 1;
}

async function main(): Promise<number> {
  const args = parseArgs(process.argv.slice(2));
  switch (args.command) {
    case "check":
      return check();
    case "onboard":
      return onboard(args);
    case "verify":
      return verify(args);
    default:
      console.error("usage: check | onboard --name --url | verify --skill --intent [--inputs JSON] [--no-approve]");
      return 2;
  }
}

main()
  .then((code) => process.exit(code))
  .catch((error) => {
    console.error(`M5 ERROR: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  });
