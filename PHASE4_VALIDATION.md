# Phase 4 validation — interactive, cross-application copilot

Run date: 2026-10-22. Branch `main`. Baseline at start: `47c420d` (44 tests,
19 scenario checks, 10 extension checks). Every result below was produced in
this environment; nothing is inferred.

## Environment

| Component | Value |
| --- | --- |
| OS / shell | Windows 11, Git Bash |
| Node / pnpm | v24.13.1 / 10.14.0 |
| Python | 3.12.3 (`.venv-flow`) |
| Engine | OpenAdapt Flow 2.3.0 (editable install from `research/OpenAdapt/packages/flow`) |
| Browser | Chrome for Testing 156.0.8078.4 (Playwright build 1248) |
| Database | PostgreSQL 16 + pgvector 0.8.7 (Docker, `pgvector/pgvector:pg16`, healthy) |
| Stagehand | 4.3.0 (`@browserbasehq/stagehand`, optional dependency of `@copilot/api`) |

## Results

| Requirement | Status | Evidence |
| --- | --- | --- |
| **P1** Interactive "Learn my app" | **PASS** (pipeline) / **LIMITATION** (no human) | Engine `record-interactive` command, API `POST /api/recordings` (mode `interactive`) + `POST /api/recordings/:id/stop`, panel controls (`record-mode`, parameter/secret fields, stop button). Real headed-Chromium recording through the OpenAdapt interactive recorder: 6 events / 12 frames, compiled to a 6-step parameterized workflow. Stop path: a stop request ended a live session and the recorder flushed and closed. The recording was driven by an automated stand-in (`--demo`), which the bridge reports as `driver: synthetic:acme-crm`; **no human performed a demonstration in this run**. The API route itself was also exercised end-to-end against the real engine (same routes the panel calls): `POST /api/recordings {mode:"interactive"}` → `202`, status `recording` with a real headed Chromium session; after 6 s `POST /api/recordings/:id/stop` → `202 {stopping:true}`; status then settled at `failed` with *"The demonstration contained no recorded actions. Nothing was compiled…"* — no operator was present to click anything, and the system refused to invent steps. |
| **P2** Stagehand | **PASS** (integration) / **BLOCKED** (live run) | `@browserbasehq/stagehand` 4.3.0 installed; adapter rewritten for the v4 API (`Stagehand.create` + `localBrowser.launch`, `observe` before `act`); `/api/capabilities` now reports `stagehand: unconfigured` instead of `blocked`; a consequential instruction without approval is refused with 409 before any provider check; an approved instruction without credentials returns 503, never a fabricated success. Live execution needs `OPENAI_API_KEY`/`ANTHROPIC_API_KEY` (or a compatible `STAGEHAND_MODEL`). |
| **P3** Enterprise persistence | **PASS** (PostgreSQL + pgvector) / **BLOCKED** (semantic search) | `docker compose up -d` → healthy pgvector container. Same 23-test suite run against real PostgreSQL: 23/23. `pg_extension` shows `vector 0.8.7`; `doc_chunks.embedding` exists with `udt_name = vector`. Plans moved from an in-memory map to a `plans` table (tenant-scoped, 30-minute TTL, pruned on read) and verified for tenant isolation. Plans/executions/verifications rows counted after the run: 6 / 5 / 4. Semantic search still requires an embeddings provider: with none configured `/api/capabilities` reports `vectorSearch: unconfigured` and retrieval stays keyword-only. |
| **P4** Driver.js guidance | **PASS** (via extension page) / **LIMITATION** (docking) | In real Chromium: `.driver-popover` rendered on the recorded control (`#new-customer`) with its recorded label; Escape dismisses the overlay (0 overlay elements afterwards, controls usable); guidance followed a page state that only exists after a click (`#customer-name` after the form opened); a selector absent from the page left `dataset.copilotHighlighted` unset and the panel reported "Could not highlight: element-not-found". The side panel was opened as its own extension page, not docked — the messaging path is identical, but Chrome's side-panel docking itself is not automated here. |
| **P5** Cross-application proof | **PASS** — 38/38 checks | AcmeDesk CRM **and** StockDesk each: record → compile → admin approval → natural-language request with new data → policy refusal without approval → approved execution → `VERIFIED` by out-of-band read-back of the application database. Failure matrix: refused write (`reject-create`) → `FAILED` + record absent; missing control (`missing-control)` → `FAILED` + record absent; duplicate record → `REJECTED` before execution; employee approval/recording attempts → 403. |
| **P6** Final validation | **PASS** | Below. |

## Commands and exact outcomes

```bash
# 1. Types (root scripts/tests + 7 packages)
pnpm typecheck                  # exit 0

# 2. Unit + integration on embedded PostgreSQL (PGlite)
pnpm test                       # 5 files, 51 tests passed

# 3. Same integration suite against Dockerized PostgreSQL + pgvector
docker compose up -d            # pgvector/pgvector:pg16, healthy
TEST_DATABASE_URL="postgres://copilot:copilot@127.0.0.1:5432/copilot" \
  pnpm test:integration         # 23 tests passed

# 4. Extension build
pnpm build:extension            # chrome-mv3, 226.17 kB, exit 0

# 5. Cross-application end-to-end with the real engine
pnpm demo:scenarios             # 38/38 checks passed

# 6. Real Chromium verification of the built extension
pnpm verify:extension           # 15/15 checks passed
```

The interactive API route was additionally driven once against the real engine
with a one-off scripted client (`POST /api/recordings` → `POST …/stop` → poll);
that check is not in the committed suite because it opens a visible browser and
needs a person at the keyboard — see "Manual demonstration" below.

Evidence artifacts (gitignored):

- `.copilot-data/scenarios/2026-10-22T05-58-08-654Z/evidence.json` — 38 checks,
  bundles, run reports (`runs/<id>/report.json`).
- `.copilot-data/extension-check/evidence.json` — 15 checks; screenshots in
  `extension-check/shots/` (`app-highlighted.png`, `sidepanel-verified.png`,
  `sidepanel-failed.png`).
- `.copilot-data/interactive-probe/` — a standalone interactive recording and
  its compiled bundle (parameters `company_name`, `email`).

## What changed in Phase 4

- **Interactive recording**: `recordInteractive` on the engine interface,
  `record-interactive` in the Python bridge (headed, stop-file, optional
  synthetic demo driver, `param_fields`/`secret_fields`), recording lifecycle
  split into scripted/interactive with a compile-and-ingest stage, `stop`
  endpoint, and panel controls for mode and parameter fields.
- **Stagehand v4**: adapter rewritten for the installed major version, capability
  reporting distinguishes *not installed* from *installed but unconfigured*, and
  the approval policy runs before any provider check.
- **Persistence**: `plans` table + `savePlan`/`getPlan`; the API no longer keeps
  plans in memory.
- **Demo applications**: `missing-control` fault mode (serves the page without
  the save control) for both apps.
- **Intent extraction**: a quantity is no longer read out of a SKU
  (`SKU-8842` + `quantity 40` → `40`).
- **Test harness**: the integration suite refuses to run against a foreign
  demo server on port 4300 and waits for the demo process to release SQLite
  before deleting its temp directory (fixed a Windows `EBUSY` teardown).

## Unresolved / blocked

1. **No human-driven demonstration was performed** in this session (there is no
   operator at this machine). The interactive pipeline is proven with an
   automated stand-in plus a real stop path; a true "admin teaches by hand" run
   is the one-minute manual step: start the stack, open the app, Start recording,
   perform the workflow, Stop, approve.
2. **Stagehand cannot execute here**: no model credentials. Status is
   `unconfigured` and the route returns 503 with the exact env vars.
3. **Semantic search is inactive**: no embeddings provider; pgvector itself is
   installed and the column exists.
4. **Docked side panel is not automated**: highlighting is verified through the
   panel as an extension page (same `chrome.tabs.sendMessage` path).
5. **Plans expire after 30 minutes** and are pruned on the next plan write; this
   is a retention policy, not durable workflow state.
6. Docker Desktop must be running before `docker compose up -d`; the default
   `pnpm dev` path uses embedded PostgreSQL and needs no Docker.

## Manual demonstration (human path)

```bash
pnpm dev                       # demo apps :4300/:4400, API :4000
pnpm build:extension           # load apps/extension/.output/chrome-mv3 unpacked
# In the extension: sign in as admin@acme.test / tenant acme-demo
#   Learn this app → Interactive → Start recording
#   Perform the workflow in the browser window that opens
#   Stop recording → review the proposed workflow → bind a read-back contract → Approve
# Sign in as employee@acme.test → state the outcome in your own words → approve → Execute
```
