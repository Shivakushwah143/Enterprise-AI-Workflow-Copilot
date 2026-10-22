# Phase 5 validation — live providers and the working product

Run date: 2026-10-22. Branch `main`. Baseline: `5651335` (Phase 4 complete:
51 tests, 38 scenario checks, 15 extension checks). Every result below was
produced in this environment; nothing is inferred. No credential value appears
in this file or in any evidence artifact.

## Checkpoint

| Component | Verdict | Evidence |
| --- | --- | --- |
| Groq | **PASS** | `pnpm check:groq` → **13/13**; real completion (`method=model`, `modelCalls=1`, 954 ms, `openai/gpt-oss-120b`), approved skill selected, write gated, run `VERIFIED` by read-back |
| Neon | **PASS** (read + isolated write) | Read-only probe of `DATABASE_URL`: PostgreSQL 18.6, pgvector 0.8.6, 19 tables. One plan written/read back/tenant-scoped/removed in the separate `neondb_test` database |
| Stagehand | **PASS** | `pnpm check:stagehand` → **8/8**; Groq-backed `observe` + `act` in real Chromium, UI change verified in the DOM, missing control reported as failure, API route 200 `ok:true` |
| OpenAdapt | **PASS** | Engine available (2.3.0, Python 3.12.3, Chromium installed); real record → compile → replay in the scenario run |
| Workflow demonstration | **PASS** | `pnpm demo:scenarios` → **42/42** across AcmeDesk CRM and StockDesk: record, compile, approve, natural-language request (model planner), policy refusal, execute, verify against the application database |

### Groq — 13/13

```
provider: groq model: openai/gpt-oss-120b
PASS  the API reports the provider it will actually use        groq / openai/gpt-oss-120b
PASS  an administrator approves the learned workflow           HTTP 201
PASS  a missing required value is reported, never invented     missing=["email"]
PASS  Groq answered and the plan says so                       method=model modelCalls=1 latency=954ms
PASS  the model selected the approved skill (not an invented one)  confidence=1
PASS  the new customer values come from the request            {"company_name":"ABC Technologies","email":"ops@abctech.test"}
PASS  a write plan still requires explicit approval            requiresApproval=true
PASS  a prompt asking to skip approval still needs approval    requiresApproval=true
PASS  executing without the human approval is refused          outcome=REJECTED_POLICY
PASS  the approved run is VERIFIED by an out-of-band read-back  outcome=VERIFIED
PASS  the application database really contains the record      1 record
PASS  an uncovered request is reported as unavailable          skillId=null
PASS  and it cannot be executed                                HTTP 409
13/13 checks passed
```

Evidence: `.copilot-data/groq-check/2026-10-22T11-03-17-397Z/evidence.json`.

### Neon — read-only live probe, isolated write

```
database: ep-shiny-leaf-…-pooler.c-7.us-east-2.aws.neon.tech/neondb ssl=require
server:   PostgreSQL 18.6 (fd34222) on aarch64-unknown-linux-gnu
database/user: neondb / neondb_owner
pgvector: 0.8.6
tables (19): app_pages, applications, doc_chunks, documents, execution_steps,
             executions, graph_edges, graph_nodes, plans, recordings, roles,
             sessions, skills, tenants, ui_elements, users,
             verification_results, workflow_steps, workflows
skills: 6 rows · workflows: 6 · plans: 1 · executions: 4 · documents: 2
```

The live database was **inspected only** (`SELECT` statements, no DDL/DML).
`pnpm check:neon` writes skills, workflows and plans, so it was deliberately
not run against `neondb`.

Persistence was proved on the derived, disposable test database instead:

```
target database: …neon.tech/neondb_test
PASS  one plan written, read back, and tenant-scoped
      rows for this id before=0 readBack=yes otherTenantVisible=0
      probe row removed: yes
```

Because the pooler terminates TLS before Postgres, `pg_stat_ssl` reports
`ssl=false` on the pooled leg; the connection string requires TLS and the
non-pooled host is reachable.

### Stagehand — 8/8

```
stagehand: configured
PASS  localBrowser.launch starts a controlled Chromium session
PASS  Stagehand.create accepts the Groq model                     model=groq/openai/gpt-oss-120b
PASS  observe returns candidates for the real page                1 candidate ('New customer' button)
PASS  one bounded action changes the UI, verified in the DOM     form before=false after=true
PASS  a missing control is not reported as a successful action   success=false ("No action found")
PASS  a consequential instruction is refused before a provider   HTTP 409
PASS  the browser session wrote nothing to the application        0 customer records
PASS  the API route reports the real Stagehand run               HTTP 200 ok:true
8/8 checks passed
```

### Workflow demonstration — 42/42

```
PASS  the interactive recording compiles into a parameterized workflow
PASS  AcmeDesk CRM: demonstration accepted / compiled / approved into an active skill
PASS  AcmeDesk CRM: the agent selects the approved skill from natural language
      method=model confidence=1 intent="Create a customer named "Northwind Freight" …"
PASS  AcmeDesk CRM: executing without the policy approval is refused   outcome=REJECTED_POLICY
PASS  AcmeDesk CRM: execution VERIFIED by the system of record         outcome=VERIFIED
PASS  AcmeDesk CRM: the application database contains the new record   id=2, createdAt=11:08:21Z
PASS  StockDesk: demonstration → skill → natural language → VERIFIED   method=model confidence=0.99
PASS  a refused write produces FAILED, never VERIFIED
PASS  a missing control fails the run instead of claiming success
PASS  an existing record is refused before anything runs
PASS  a request no approved skill covers is reported as unavailable
PASS  history shows verified and failed runs side by side
PASS  extension context resolves AcmeDesk CRM / StockDesk
PASS  plans, executions and verification evidence are persisted
42/42 checks passed
```

Evidence: `.copilot-data/scenarios/2026-10-22T11-06-21-619Z/evidence.json`
(bundles in `recordings/`, engine reports in `runs/<id>/report.json`).

Two observations worth recording, both honest by construction:

- On the CRM run the engine **halted** on a postcondition after a retry, yet
  the run is `VERIFIED`. The record was created at 11:08:21Z inside this run
  (fresh `createdAt`), so the read-back is of this run's effect, not a stale
  row; the printed message says the engine stopped and the record exists,
  rather than claiming the engine succeeded.
- Deterministic fallback remains intact and labelled: without a model key the
  plan reports `method=deterministic`; with one, `method=model`.

## Failure-log triage (first meaningful failure)

The log `.copilot-data/pg-integration-2.log` ended with 22/24 passing. Two
failures, in order:

1. `interactive Learn My App > keeps the session live …` — **timeout at 30 s**
   (17.3 s in the preceding run). Remote round-trips plus a headed recording.
   Not a product failure; the test had no explicit budget.
2. `extension-facing endpoints > reports the application and suggested skills`
   — `expected [] to include 'Create customer'`. **Confirmed defect** in the
   test's setup, not in the endpoint.

Root cause of (2), measured read-only against `neondb_test`:

```
AcmeDesk CRM rows for the tenant: 3
  [0] b36b97e8 baseUrl=http://127.0.0.1:4300 skills=0 <- findApplicationForUrl picks this
  [1] c94d0e5f baseUrl=http://127.0.0.1:4300 skills=0
  [2] 71cc425b baseUrl=http://127.0.0.1:4300 skills=1
```

A remote database keeps its rows between runs. `beforeAll` registered a new
`AcmeDesk CRM` on every run, so the tenant accumulated three rows with the same
base URL; `findApplicationForUrl` resolves the oldest (whichever comes first),
while this run's skill hangs off the newest. The endpoint answered correctly
for the row it resolved. On embedded PostgreSQL the temp directory is fresh, so
the duplicate never appeared there.

### Corrections made in this batch

- `tests/integration/api.test.ts` — `beforeAll` reuses the tenant's existing
  `AcmeDesk CRM` row instead of inserting a duplicate, so the row the skill is
  attached to is the row `/api/context` resolves. Assertions unchanged.
- `tests/integration/api.test.ts` — the interactive test gets an explicit 60 s
  budget, matching the remote-latency allowance already documented on
  `waitForCompiled`; its assertions unchanged.
- `scripts/check-groq.ts` — each run uses its own demo data directory. The
  first run of this batch reported `REJECTED` because the previous run's
  `ABC Technologies` record was still in the reused demo database and the
  duplicate guard (correctly) refused the new one. That was state, not Groq;
  the re-run is 13/13.

## Focused tests (files changed in this batch)

| Command | Result |
| --- | --- |
| `pnpm typecheck` (root + 7 packages) | PASS |
| `pnpm test:unit` | PASS — 5 files, 40 tests |
| `pnpm vitest run tests/integration/api.test.ts` (embedded PostgreSQL) | PASS — 24/24, 19.4 s |
| `pnpm check:groq` | PASS — 13/13 (re-run after the data-dir fix) |
| `pnpm check:stagehand` | PASS — 8/8 |
| `pnpm demo:scenarios` | PASS — 42/42 |
| `pnpm dev` smoke | PASS — `/api/health` ok; capabilities `engine.available=true`, `llm=groq/configured`; CRM HTTP 200 |

The suite was not re-run against the remote test database: the fast-execution
instruction forbids repeating full integration runs, and the duplicate-row
cause above is proved read-only. The first run after this change will reuse row
`[0]`, and the skill it creates will attach to that same row, which is the
self-consistency the fix establishes.

## Blocked / limitations

1. **Semantic search is still inactive** — no embeddings provider;
   `vectorSearch: unconfigured`. pgvector 0.8.6 is installed and the column
   exists, so this is configuration only.
2. **A human-recorded demonstration was not performed** — no operator at this
   machine. The interactive pipeline is exercised with an automated stand-in,
   labelled `driver: synthetic:acme-crm`; the system refuses to invent steps.
3. **Stagehand cannot attach to the extension's tab** — it drives its own
   controlled Chromium; the two paths are intentionally separate.
4. **Docked side panel is not automated**; the extension was verified in Phase 4
   through the panel as an extension page (15/15).
5. **`pnpm dev` uses `DATABASE_URL` when it is set**, i.e. Neon. The scenario
   runner (`pnpm demo:scenarios`) always uses its own disposable embedded
   PostgreSQL under `.copilot-data/scenarios/<stamp>/pg`, which is the
   recommended way to demonstrate without writing to the live database.
6. **Credentials:** the three live checks used the values already configured in
   `.env`; no key or connection string was printed or written to evidence. If
   those values are the ones previously exposed, rotate them and re-run
   `pnpm check:groq`, `pnpm check:stagehand` and the read-only probe.

## Commands

```bash
# Full working-product demonstration (record → skill → approve → natural
# language → execute → verify), both demo apps, disposable database:
pnpm demo:scenarios

# Live providers:
pnpm check:groq          # real Groq request through the intent engine
pnpm check:stagehand     # Groq-backed browser interaction in Chromium

# Run the product interactively:
pnpm dev                 # API :4000, AcmeDesk CRM :4300, StockDesk :4400
```
