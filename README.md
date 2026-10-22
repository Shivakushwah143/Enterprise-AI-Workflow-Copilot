# Enterprise AI Workflow Copilot

An admin demonstrates a business workflow once. The copilot learns it, an admin
approves it as a skill, and an employee then asks for the outcome in plain
language. The agent selects the approved skill, runs it against the real
application with **new input data**, and an independent read-back of the system
of record decides whether the run succeeded.

The rule the whole codebase is built around: **UI completion is not success.**
A run is `VERIFIED` only when the business system itself shows the record.
Engine success plus an oracle miss is `FAILED`.

```
record  ->  learn  ->  parameterize  ->  replay  ->  verify
(OpenAdapt)          (admin approves)            (system of record)
```

## Quick start

```bash
pnpm install

# One command for the local stack: demo apps (:4300, :4400) + API (:4000)
pnpm dev

# In another terminal: sign in as admin@acme.test (tenant acme-demo)
pnpm seed            # idempotent fixtures: tenants, users, apps, SOPs
```

Build the extension and load `apps/extension/.output/chrome-mv3` as an
unpacked extension in Chrome:

```bash
pnpm build:extension
```

## Verifying it works

| Command | What it proves |
| --- | --- |
| `pnpm typecheck` | Root scripts/tests plus every workspace package type-check |
| `pnpm test:unit` | Bundle inspection, intent/plan, verification, tenant scoping |
| `pnpm test:integration` | Real HTTP API + PostgreSQL + demo app; includes the "engine claims success, record absent" failure |
| `pnpm demo:scenarios` | Full lifecycle with the real OpenAdapt engine: record, compile, approve, execute with new inputs, verify, then a deliberate rejected write |
| `pnpm verify:extension` | Loads the built MV3 extension in Chromium, signs in through the side panel, highlights the recorded control with Driver.js, executes and displays `VERIFIED` and `FAILED` |
| `TEST_DATABASE_URL=postgres://copilot:copilot@127.0.0.1:5432/copilot pnpm test:integration` | The same suite against Dockerized PostgreSQL + pgvector |

`pnpm demo:scenarios` needs the OpenAdapt engine (below) and exits `2` with the
reason when it is unavailable. `pnpm verify:extension` re-uses the newest
compiled bundle from a scenario run.

## Learn my app (interactive recording)

An admin demonstrates a workflow in a real browser: `POST /api/recordings` with
`mode: "interactive"` opens a headed Chromium session; the admin performs the
workflow and `POST /api/recordings/:id/stop` finishes it. The bridge passes the
field names that should become parameters (and any secret fields, whose values
are never persisted). The recording is then compiled into a draft workflow for
review and approval. Nothing executes before approval.

The same command accepts an automated stand-in (`--demo`) for CI, which reports
`driver: synthetic:<app>`; it is never presented as a human demonstration.

## Stagehand (optional AI browser path)

`@browserbasehq/stagehand` v4 is an optional dependency of the API. With model
credentials configured (`OPENAI_API_KEY` or `ANTHROPIC_API_KEY`, optionally
`STAGEHAND_MODEL=provider/model`) the route `/api/stagehand/tasks` can observe
and act in its own local browser session. It cannot attach to the extension's
tab. Consequential instructions require `approved: true`; the API never
self-approves. Without credentials the capability reports `unconfigured` and
the route returns 503.

## Engine setup (OpenAdapt)

The engine is an optional, external dependency. Nothing above the
`WorkflowEngine` interface imports it.

```bash
python -m venv .venv-flow
.venv-flow/Scripts/python.exe -m pip install -e "research/OpenAdapt/packages/flow[browser]"
.venv-flow/Scripts/python.exe -m playwright install chromium
```

`PYTHON_BIN` and `OPENADAPT_BRIDGE` override the interpreter and bridge path.
`probe` (exposed as `/api/capabilities`) reports honestly when the engine or
Chromium is missing.

## Layout

```
apps/api        Hono API: auth, recordings, approvals, plans, executions, knowledge
apps/demo       Two disposable business apps (AcmeDesk CRM, StockDesk) + SQLite
apps/extension  WXT MV3 extension: side panel UI, Driver.js highlighting
packages/shared     zod contracts shared across every boundary
packages/knowledge  PostgreSQL repositories (pg or embedded PGlite), retrieval
packages/workflow   Engine interface, OpenAdapt bridge adapter, bundle inspection, verification
packages/agent      Intent resolution, planning, guarded execution
scripts             dev stack, end-to-end scenarios, extension verification
tests               unit + integration suites
```

## Security and honesty boundaries

- Tenant and role come from the bearer token, never the request body. A row from
  another tenant is reported `404`, not `403`.
- Irreversible workflows need explicit acknowledgement at approval and explicit
  approval per execution.
- Secrets are never placed in a plan, never sent through argv, and never filled
  in by the model.
- Missing capabilities (model, embeddings, pgvector, Stagehand, engine) are
  reported as `unconfigured`/`blocked` and degrade to a documented fallback;
  nothing is fabricated.
- Stagehand, when installed, drives its **own** browser session. It cannot
  attach to the extension's tab, and the API says so.
- The extension's content script only highlights a recorded selector and shows a
  recording indicator. It never clicks or types.

See `SESSION_HANDOFF.md` for the state inventory and `PHASE4_VALIDATION.md` for
the Phase 4 evidence, PASS/FAIL/BLOCKED results and remaining blockers.
