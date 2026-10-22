# Phase 6 validation — browser UX, Stagehand session boundaries, application identity

Run date: 2026-10-22. Branch `main`. Baseline: Phase 5 (`PHASE5_VALIDATION.md`:
Groq 13/13, Stagehand 8/8, scenarios 42/42, unit 40/40, integration 24/24).
Every result below was produced in this environment; nothing is inferred, and
no credential value appears in this file or in the evidence artifacts.

## Checkpoint

| Feature | PASS / FAIL / BLOCKED | Evidence |
| --- | --- | --- |
| Browser end-to-end UX | **PASS** | `pnpm verify:extension` → **25/25**: sign-in, live capabilities, context, plan, approval, execution, VERIFIED + evidence, FAILED path, reopening restores the operation |
| Real docked side panel | **HUMAN PENDING** (automation limit) | The panel UI is exercised as the extension's own page in real Chromium. Chrome's docked side-panel chrome is browser UI that Playwright cannot drive; exact manual procedure below. Manifest + `openPanelOnActionClick` are configured |
| Guided mode | **PASS** | Mode label `Guided — Current browser tab` from the server; Driver.js highlight; **Check this step** verifies the recorded control in the tab; no autonomous controls rendered |
| Autonomous mode | **PASS** | Pre-flight (target application, skill, inputs, requested actions, impact, session type), explicit approval, session id + live status + terminal result, and a real session started from the panel button |
| Stagehand session isolation | **PASS** | `pnpm check:stagehand` → **12/12** incl. session id/target, terminal status, another tenant 404, unknown/expired 404 |
| Duplicate application resolution | **PASS** | 16 unit tests + API integration: ambiguous 409 with candidates, explicit choice honoured, no arbitrary row, idempotent registration, skills stay linked |
| Tenant isolation | **PASS** | Cross-tenant resolution returns `none`; foreign `applicationId` 404; foreign session 404; plans never use another application's skill |
| Browser demo | **PASS** | `pnpm demo:scenarios` → **42/42** (record → skill → approve → natural language → execute → verify; policy refusal + read-back intact) |

## P1 — interactive browser UX

Implemented in the side panel (`apps/extension/entrypoints/sidepanel/App.tsx`):

- **Execution mode is explicit** and persisted: `Autonomous — Controlled browser
  session` by default, `Guided — Current browser tab` when chosen. The labels
  come from `/api/capabilities.browserModes`, not from wording invented in the
  UI. Nothing switches mode on its own.
- **Guided mode** states that it never acts for you. It highlights the recorded
  selector with Driver.js and now *verifies* the step: a new
  `COPILOT_VERIFY_STEP` content-script message reports whether the recorded
  control is present and visible in the tab. Observation only — the content
  script still never clicks, types or reads values.
- **Autonomous pre-flight** shows the target application and URL, the selected
  approved skill, inputs (resolved values, never secrets), the recorded steps
  with their risk classes, expected business impact, whether approval is
  required, and the session type (`Controlled browser session … not your tab`).
- **Live status**: the panel polls the session id, shows `running` → terminal,
  the action log, the summary, and an explicit error when the session failed.
  A session the server no longer knows about becomes `expired` in the panel,
  not a permanent spinner.
- **Persistence**: the workspace (mode, plan, execution id, recording id, draft
  workflow id, session id, explicit application choice) is stored in
  `chrome.storage.local` and re-read from the API on reopen. A plan that
  expired while the panel was closed is reported as expired instead of being
  reused.
- **Recording cancellation**: `POST /api/recordings/:id/cancel` closes the live
  recorder, marks the row `cancelled`, and compiles nothing. Cancelling is
  admin-only and refused (409) when no live session exists.
- **Expired plans**: a 404 from execution clears the plan and asks the user to
  state the outcome again.
- **Conflicting actions are disabled** while planning, executing or starting a
  session (re-plan, execute, AI session, start recording).
- Employees still get no approval controls: the Learn section is admin-only and
  the server enforces `workflow:approve`.

Acceptance evidence (`pnpm verify:extension`, 25/25):

```
PASS  side panel signs in through the API
PASS  capability badge reports the live engine state          Engine: available
PASS  context panel names the registered application          AcmeDesk CRM — http://127.0.0.1:4300/
PASS  the panel names the active execution mode               Autonomous — Controlled browser session
PASS  guided mode says it uses the current tab                Guided — Current browser tab
PASS  Driver.js highlights the recorded control in the tab
PASS  the overlay can be dismissed
PASS  guidance follows a page state that changed after recording
PASS  a missing control is reported instead of highlighted
PASS  guided mode verifies the recorded control in the page it is showing
PASS  panel demands explicit approval for the irreversible workflow
PASS  autonomous pre-flight names the target, skill, actions and session type
PASS  guided mode offers no autonomous execution controls     executeButtons=0 stagehandButtons=0
PASS  execution panel shows the verified outcome              outcome: VERIFIED
PASS  panel shows the system-of-record evidence               PASSED · system_of_record
PASS  reopening the panel restores the plan and result        outcome=VERIFIED planVisible=1
PASS  a controlled browser session is created with an operation id and its target
PASS  the session reports its own progress and a real terminal status
PASS  the reopened panel shows the session's real status and identity
PASS  a rejected write is shown as FAILED in the panel
25/25 extension checks passed
```

A separate probe exercised the panel's own **Run in AI browser session**
button (not just the API): HTTP 202, `stagehand.session.started`, then
`status=completed` with `identity=session … · controlled_browser_session ·
AcmeDesk CRM`. `.copilot-data/phase6-panel-autonomous.ts`.

Cancellation was probed against the real recorder:

```
start: HTTP 202 status=recording
cancel: HTTP 200 cancelled=true status=cancelled
PASS  a cancelled recording compiles nothing and creates no skill
      workflows 0 -> 0 linkedWorkflow=no
```

## P2 — Stagehand session boundaries

`apps/api/src/stagehand.ts` now owns a small, explicit session registry.

- Every autonomous operation is a `BrowserSession` with an operation id, the
  tenant and user that started it, the registered application and URL,
  approval flag, plan/skill ids, status, action log, summary, observed
  evidence, timestamps.
- **Approval gate before any provider contact**: a consequential instruction
  without `approved: true` is a 409 even when model credentials are absent.
  `POST /api/stagehand/sessions` never approves on the caller's behalf.
- **Tenant scoping**: the target URL must resolve to an application registered
  to the caller's tenant (400 otherwise); a named skill must be that tenant's
  and belong to the same application; a session id from another tenant is 404.
- **Progress and recovery**: status is readable after the panel reopens;
  finished sessions expire after 15 minutes, memory is bounded, and a session
  still `running` after 10 minutes is reported `failed` rather than hanging.
  An unknown/expired id returns 404 with an actionable message.
- **Cleanup**: the browser is closed in a `finally` for both the one-shot task
  and the registry path; no session is reused across tenants.
- **No sensitive logging**: session logs carry ids, tenant, application, URL
  and status only — never credentials, cookies or page content.

`pnpm check:stagehand` (live Groq + real Chromium) → **12/12**:

```
PASS  observe returns candidates for the real page
PASS  one bounded action changes the UI, verified in the DOM   form before=false after=true
PASS  a missing control is not reported as a successful action  success=false
PASS  a consequential instruction is refused before a provider  HTTP 409
PASS  the browser session wrote nothing to the application      0 records
PASS  a controlled browser session is created with an operation id and its target
PASS  the session reports its own progress and a real terminal status
PASS  another tenant cannot read the session                    HTTP 404
PASS  an unknown or expired session returns 404 instead of a stale success
```

**Known boundary (unchanged and now stated in the UI):** Stagehand drives its
own controlled Chromium. It cannot attach to the extension's tab, and the
panel never implies it does.

## P3 — production-safe application resolution

`packages/knowledge/src/store.ts` replaces "longest `startsWith` on the raw
string, take the first row" with a deterministic resolver.

- `normalizeApplicationUrl`: `scheme://host[:port][/path]`, lowercased host,
  default ports dropped, duplicate/trailing slashes collapsed, query and hash
  removed. Non-HTTP values have **no** identity (null), so they cannot match.
- `resolveApplicationForUrl(tenantId, url)`:
  1. exact normalized identity → the row, **unless** more than one row shares
     it → `ambiguous` (never "the oldest one");
  2. otherwise the longest base **path** on a segment boundary **within the
     same origin** (`/crm` matches `/crm/customers`, not `/crmx`) → the row;
     a tie at that length → `ambiguous`;
  3. otherwise `none`.
  Candidates are gathered from this tenant only, so a foreign row can neither
  win nor create ambiguity.
- `/api/context` returns **409 `application_ambiguous`** with the candidate list
  and accepts an explicit, tenant-scoped `applicationId`; the panel renders the
  chooser and remembers the choice only for the page it was made on.
- `/api/plans` accepts `applicationId` and filters candidate skills to that
  application, so a neighbouring app or duplicate can never supply the skill.
- `ensureApplication` is idempotent per (tenant, normalized identity) and
  serializes concurrent registrations in-process. `POST /api/applications`
  returns the existing row with `reused: true` instead of inserting again.
  Seeding uses the same path, so re-seeding stops accumulating duplicates.
- Existing rows are **never** merged or deleted; workflows/skills/executions
  keep pointing at the row they were approved for.

Tests — `tests/unit/application-resolution.test.ts` (16/16): exact match, same
app across routes, distinct apps on one origin by path, lookalike path
(`/crmx`) not matching, most-specific base path wins, duplicate rows with
different skills → ambiguous and the skill stays linked, unknown app, foreign
tenant, non-HTTP page, identity normalization, idempotent registration,
five concurrent registrations converging on one row, existing approvals still
linked, and a URL with no identity refused.

API integration (31 tests total, all passing) adds: ambiguous 409 with
candidates → explicit choice returns the right app and skills; a foreign
`applicationId` is 404; registration is reused; plan scoped by application
never returns another app's skill; recording cancel refusals; an unregistered
page cannot start a controlled session; a consequential AI instruction is 409;
an unknown session id is 404.

### Duplicate rows: inspection and remediation plan (not executed)

`applications` has **no** unique constraint today:

```sql
CREATE TABLE IF NOT EXISTS applications (
  id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  name TEXT NOT NULL, base_url TEXT NOT NULL, verification_base_url TEXT,
  kind TEXT NOT NULL DEFAULT 'browser', created_at TIMESTAMPTZ NOT NULL
);
```

A unique index cannot be added safely while duplicates exist (the remote test
database currently has three `AcmeDesk CRM` rows for one tenant). Reviewed
plan, to be run by a person against a named database:

1. Inventory groups: `GROUP BY tenant_id, normalized(base_url)` — normalization
   must use the same rules as `normalizeApplicationUrl` (a Node script, not a
   SQL guess), and be reviewed before any write.
2. For each group choose a canonical row: the one referenced by the most
   workflows (tie-break: the oldest with at least one approved skill).
3. Re-point `workflows.application_id` to the canonical row; `skills` and
   `executions` follow through their workflow, and `graph_nodes` labels are
   updated. Nothing is deleted; old rows stay until an operator confirms.
4. Only after every group has one referenced row: add a stored `identity`
   column, backfill it with `normalizeApplicationUrl`, then create
   `UNIQUE (tenant_id, identity)`.
5. Re-run `pnpm check:neon` (or the read-only probe) to confirm one identity per
   tenant and that no workflow lost its application.

Until then the resolver refuses ambiguity, which is the safe failure mode.

## P4 — verification

| Command | Result |
| --- | --- |
| `pnpm typecheck` (root + 7 packages) | PASS — 0 errors |
| `pnpm test:unit` | PASS — 6 files, **56 tests** |
| `pnpm vitest run tests/integration/api.test.ts tests/unit/application-resolution.test.ts` | PASS — **47 tests** |
| `pnpm check:stagehand` | PASS — **12/12** |
| `pnpm demo:scenarios` | PASS — **42/42** |
| `pnpm verify:extension` | PASS — **25/25** |
| `pnpm build:extension` | PASS — chrome-mv3, 237.76 kB |

The complete Neon integration suite was **not** re-run; the remote test
database was only read during Phase 5 diagnostics. All browser work used
disposable local data (`.copilot-data/...`).

## Manual acceptance — real docked side panel (HUMAN PENDING)

Chrome's side panel is browser chrome; Playwright cannot click it, and opening
`sidepanel.html` as a tab is not the same surface (this is what the automated
run does, and it is labelled as such). The one-minute manual pass:

```bash
pnpm dev                # API :4000, AcmeDesk CRM :4300, StockDesk :4400
pnpm build:extension    # then load apps/extension/.output/chrome-mv3 unpacked
```

1. `chrome://extensions` → Developer mode → **Load unpacked** →
   `apps/extension/.output/chrome-mv3`. Pin the toolbar button.
2. Open `http://127.0.0.1:4300`, then click the toolbar button: the **docked
   side panel** opens (not a tab).
3. Sign in as `admin@acme.test`, tenant `acme-demo`.
4. **Learn this app** → Interactive → **Start recording**; a separate browser
   window opens — perform the workflow there (New customer → name → email →
   Save). Press **Stop recording** in the panel.
5. Review the proposed workflow, its steps, uncertainty and confidence; fill the
   read-back URL (e.g. `http://127.0.0.1:4300/api/customers?name={company_name}`)
   and expected fields (`{"name":"company_name","email":"email"}`); **Approve**.
6. Switch the mode to **Guided** and press **Highlight** / **Check this step**:
   the recorded control is outlined in the page and the panel reports it is
   present and visible. The copilot does not act.
7. Sign in as `employee@acme.test`, open the CRM, ask
   `Create a customer named "Northwind Freight" with contact ops@northwind.test`,
   press **Plan**, review the pre-flight, tick **I approve this run**, then
   **Execute approved workflow**.
8. Watch the status, the step list and the verification evidence: `VERIFIED`
   only when the read-back finds the record. Repeat with
   `POST /api/faults {"mode":"reject-create"}` to see `FAILED`.
9. Close the side panel and reopen it from the toolbar: the plan and the last
   execution come back from the API.
10. In **Autonomous** mode press **Run in AI browser session** and watch the
    session id, `running` and the terminal status — it is a separate controlled
    browser, not this tab.

## Remaining limitations

1. **Docked side panel is not automated** (above). Everything else in the panel
   is asserted in real Chromium.
2. **Guided mode is observation-only** by design: it highlights and verifies,
   it does not click for the employee.
3. **Browser sessions are in-process**: they survive panel reopen but not an API
   restart, and there is no database audit table for them yet (logs carry the
   session id, tenant and status).
4. **No unique index on application identity yet** — the resolver refuses
   ambiguity instead, and the remediation plan above is not executed against
   any live database.
5. **Interactive recording still needs a human** for a real demonstration; the
   cancelled-recording and stop paths are verified with the real recorder.
6. **Vector search remains unconfigured** (no embeddings provider) — unchanged.
7. Deterministic replay remains synchronous: the panel shows an in-flight state
   and then the step results; live per-step progress is available for AI
   sessions, not for OpenAdapt replay.
