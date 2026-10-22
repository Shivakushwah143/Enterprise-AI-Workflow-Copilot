# M0 — Functional reliability baseline

Run date: 2026-10-22. Branch `main`, unmodified product code (two diagnostic
files added under `scripts/m0/`, this report added).

Every number below comes from a run in this environment. Artifacts are named.
Nothing was inferred, and no result was hand-edited.

---

## 0. Scope, and two blockers stated up front

| Item in the brief | Reality in this repository | Verdict |
| --- | --- | --- |
| `Enterprise_AI_Copilot_Functional_Reliability_Plan.md` | **Not present.** No file of that name exists, and no document in the repo names the M0 milestones. The brief in the task message was used as the plan. | MISSING INPUT |
| A running, isolated **SynTask** environment | **Absent.** `SynTask` appears nowhere in the tree (source, docs, env, scripts). There is no HR/employee system, no credentials, no base URL, no read-back contract. | **BLOCKED** — see §9 for the exact prerequisite |
| "Employee-creation" workflow | The only business object this project can create is a **customer** (`AcmeDesk CRM`) or a **stock item** (`StockDesk`). There is no employee entity anywhere in the demo apps, the schema, or the workflow language. | Mapped to the canonical record-creation workflow: **Create customer** |

Because the brief also said *"execute the baseline; do not return another
research plan"* and *"do not silently substitute synthetic demos for real-app
tests"*, the baseline was executed against the repository's own **real, running,
isolated** application — and is labelled as that, not as SynTask, throughout.

What is real about the target: `apps/demo` is an HTTP server with its own SQLite
database, driven over HTTP by a real Chromium; the copilot's verification reads
that database through a channel the GUI never touches. What is *not* real: the
application is purpose-built for this project and frozen (stable ids, no layout
churn, no latency, no auth expiry), and the demonstration that created the
recording was performed by a Playwright stand-in rather than a human. Both facts
bound every conclusion in §6.

---

## 1. What was inspected (step 1 of the brief)

Path by path, with the distinction the brief asked for:

| Capability | Implementation | Classification |
| --- | --- | --- |
| OpenAdapt recording | `packages/workflow/python/copilot_bridge.py` → `openadapt_flow.Recorder` in a headed/headless Chromium; 6 real events, 12 real frames | **Real** (driver is scripted when no human is present — labelled `synthetic:<app>`) |
| Compilation | `openadapt-flow compile` → bundle with `workflow.json`, `param_specs` (schema 2 map supported) | **Real** |
| Stagehand execution | `apps/api/src/stagehand.ts`, Groq-backed, own controlled Chromium; cannot attach to the extension tab | **Real**, separate path from compiled replay |
| Browser-session management | OpenAdapt subprocess per execution (`runBridge`), 5-minute default budget; Stagehand sessions are an in-process registry with TTL | **Real**; per-execution **cold start** (see §7) |
| Deterministic replay | `openadapt_flow replay` via bridge; `structural` resolution rung; postconditions on clicks | **Real**; no healing/model fallback invoked (`heal=0`, `modelCalls=0` in all runs) |
| System-of-record verification | `packages/workflow/src/verification.ts` — independent HTTP read, `equals` match, pre-run duplicate guard, unreachable oracle = failed | **Real and deciding**; it is the only reason a run can be `VERIFIED` |
| Planning | Groq `openai/gpt-oss-120b` via `/api/plans`, deterministic fallback exists | **Real** (model used in 10/10 plans) |
| Vector retrieval | `vectorSearch: unconfigured` (no embedding provider) | **Unsupported here** (keyword retrieval is active) |
| Playwright traces | Not produced by the product. Captured for this baseline by a diagnostic shim (`scripts/m0/playwright-trace-shim/sitecustomize.py`) loaded through `PYTHONPATH` | **Absent in product**, **diagnostic only** |
| Docked Chrome side panel | Not automatable with Playwright (browser chrome) | **Unsupported** (documented HUMAN PENDING in `PHASE6_VALIDATION.md`) |
| Human interactive recording | Works, requires a person at the machine | **Real, not exercised** (no operator) |

---

## 2. Method

- **Isolation.** Disposable stack: AcmeDesk CRM on `127.0.0.1:4300`, API on
  `:4110`, embedded PostgreSQL (PGlite) and the app's SQLite under
  `.copilot-data/m0/<stamp>/`. No `DATABASE_URL`, no customer data, nothing
  written outside `.copilot-data/`.
- **Learn once, execute ten times.** One scripted recording → one compiled
  bundle (6 steps, 2 uncertainty notes) → one admin approval binding the
  verification contract
  `http://127.0.0.1:4300/api/customers?name={company_name}`,
  `expect={"name":"company_name","email":"email"}`, `match=equals`.
- **Ten independent executions**, each a fresh `POST /api/plans` from a natural
  language request followed by `POST /api/executions` with `approved: true`.
  Ten different employee data sets, including punctuation, non-ASCII, a
  numeric-leading name, and a 49-character name with a `+` address.
- **Evidence per execution:** plan provenance and latency, wall-clock execution
  time, engine report (per-step `ok`, `rung`, postconditions, halt reason,
  `total_ms`), the API's step rows, the verification result, an independent
  HTTP read-back of the application, and a Playwright trace
  (`screenshots=True, snapshots=True`).
- **Trace capture without touching code.** The replay browser lives inside the
  bridge subprocess. A `sitecustomize` module on `PYTHONPATH` starts/stops
  tracing on the context Playwright creates; it is inert unless `M0_TRACE_DIR`
  is set and reports failures on stderr instead of raising. Result: **13 trace
  archives, one per browser session** — 10 executions, 2 probe replays, and the
  recording — with **110–217 recorded actions each**, screenshots and DOM
  snapshots, 0.7–2.4 MB per archive.
- **Time-boxing.** `ENGINE_TIMEOUT_MS=120000` per execution. No retry loops:
  every execution ran exactly once.
- **Instrument validation.** After the ten runs, three bounded fault probes
  used the demo app's own `/api/faults` switch (no code change) to prove the
  harness can detect a failure at all.

Reproduce:

```bash
pnpm exec tsx scripts/m0/reliability-baseline.ts
# optional: M0_ENGINE_TIMEOUT_MS=120000 M0_API_PORT=4110
```

---

## 3. Ten-run results (canonical baseline)

Evidence: `.copilot-data/m0/2026-10-22T13-45-34-426Z/evidence.json`
(runs, probes, traces, engine reports under `runs/<executionId>/report.json`).

| # | Employee data | Note | Outcome | Plan (method / latency) | Exec wall | Engine replay | Steps | Engine state | Verification | Read-back | Trace |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 01 | Northwind Freight · ops@northwind.test | plain | **VERIFIED** | model / 2509 ms | 10 884 ms | 5 406 ms | 6/6 ok | clean, 0 heals | PASS `system_of_record` | 1 record | yes |
| 02 | Contoso Logistics · dana@contoso.test | plain | **VERIFIED** | model / 1449 ms | 10 438 ms | 5 438 ms | 6/6 ok | clean, 0 heals | PASS | 1 record | yes |
| 03 | Fabrikam Rail · ops@fabrikam.test | plain | **VERIFIED** | model / 1500 ms | 11 235 ms | 5 359 ms | 6/6 ok | clean, 0 heals | PASS | 1 record | yes |
| 04 | O'Rourke Haulage · paddy@orourke.test | apostrophe | **VERIFIED** | model / 1631 ms | 10 835 ms | 5 094 ms | 6/6 ok | clean, 0 heals | PASS | 1 record | yes |
| 05 | Müller Logistik · kontakt@mueller.test | non-ASCII | **VERIFIED** | model / 1153 ms | 10 560 ms | 5 438 ms | 6/6 ok | clean, 0 heals | PASS | 1 record | yes |
| 06 | 3M Supply Co · buyer@3msupply.test | leading digit | **VERIFIED** | model / 1201 ms | 11 373 ms | 5 266 ms | 6/6 ok | clean, 0 heals | PASS | 1 record | yes |
| 07 | A Very Long Company Name Holdings International · long.name+ap@example.test | long, `+` address | **VERIFIED** | model / 2701 ms | 11 501 ms | 5 812 ms | 6/6 ok | clean, 0 heals | PASS | 1 record | yes |
| 08 | Tailspin Toys · sales@tailspin.test | plain | **VERIFIED** | model / 1059 ms | 10 403 ms | 5 250 ms | 6/6 ok | clean, 0 heals | PASS | 1 record | yes |
| 09 | Wingtip Traders · hello@wingtip.test | plain | **VERIFIED** | model / 1545 ms | 11 373 ms | 6 032 ms | 6/6 ok | clean, 0 heals | PASS | 1 record | yes |
| 10 | Adventure Works · orders@adventure.test | plain | **VERIFIED** | model / 1224 ms | 10 571 ms | 5 250 ms | 6/6 ok | clean, 0 heals | PASS | 1 record | yes |

**A second, independent baseline run reproduced this exactly: 10/10 VERIFIED,
10/10 engine-clean** (`.copilot-data/m0/2026-10-22T13-40-31-866Z/evidence.json`;
median execution 11 513 ms, engine median 5 875 ms). **20/20 executions across
two independent runs.**

### Measured rates

| Measure | Result |
| --- | --- |
| Business success (`VERIFIED` by system of record) | **10/10 = 100 %** (20/20 over two baselines) |
| Engine-clean (no halt, every step `ok`) | 10/10 |
| Plan provenance | model 10/10, `modelCalls=1` each, confidence 0.99–1.00 |
| Resolution rungs | `{structural: 4}` per run; `healCount=0`, engine `modelCalls=0` |
| Execution wall time | median 10 884 ms · p95 11 373 ms · min 10 403 · max 11 501 |
| Engine-reported replay time | median 5 406 ms |
| Unattributed time (wall − engine) | median **5 409 ms ≈ 49.5 %** of wall time |
| Step rows carrying a duration | **0 of 60** |
| Type steps with a postcondition | **0 of 20** |
| Playwright trace archives | 13 (10 runs + 2 probe replays + 1 recording; the duplicate probe never started a browser) |

Read-back freshness was checked explicitly: every row's `createdAt` falls inside
its own execution window, and a direct SQLite query at the end found **11 rows —
the 10 runs plus the single `Acme Demo Ltd` demonstration row**. No run could
have "verified" a record left by an earlier one.

The non-ASCII case is worth stating precisely, because it is the kind of result
that is usually wrong: the stored bytes are `4d c3 bc 6c 6c 65 72 …` — correct
UTF-8 for `Müller`. Round-trip through plan → typed input → HTTP → SQLite →
read-back is byte-exact.

---

## 4. Failure classification

Taxonomy applied to every execution: **reasoning** (wrong/no skill, invented or
dropped inputs), **selector** (control not resolvable), **timing** (budget
exceeded), **browser session** (browser/context lost), **application** (the
business app refuses or errors), **verification** (engine claims success, record
absent; or pre-run duplicate), **infrastructure** (API/DB/dependency).

| Category | Happy-path runs (n=10) | Fault probes (n=3) |
| --- | --- | --- |
| reasoning | 0 | 0 |
| selector | 0 | 1 origin (missing-control) — **detected as `unknown`** |
| timing | 0 | 0 |
| browser session | 0 | 0 |
| application | 0 | 1 origin (rejected-write) — **detected as `unknown`** |
| verification | 0 | 1 (duplicate-data) — detected correctly |
| infrastructure | 0 | 0 |

**The ten-run baseline produced no failure of any category.** That is a result
about the target, not a clean bill of health (§6).

### Instrument validation — and what it exposed

The harness classified **3/3 probe outcomes correctly** (`REJECTED`, `FAILED`,
`FAILED`) but only **1/3 failure origins**. That gap is the single most useful
finding of M0:

| Probe (injected, not agent error) | Outcome | Origin | What the automated classifier could say | What the run actually reported |
| --- | --- | --- | --- | --- |
| `duplicate-data` — same data as run 01 | `REJECTED` ✔ | verification | `verification` ✔ | "a matching record already exists in the system of record, so a success here could not be attributed to this run" |
| `rejected-write` — app returns HTTP 500, persists nothing | `FAILED` ✔ | application | **`unknown`** ✘ | "Postconditions failed for step 'step_005' (click 'Save customer'): expected screen state not reached (**semantic drift**) — failed: region_stable" |
| `missing-control` — save button removed from the page | `FAILED` ✔ | selector | **`unknown`** ✘ | "Step 'step_005' … is irreversible but only resolved via the **'geometry' rung** — needs human confirmation; refusing to act (v0 policy)" |

Both failures were **safe**: nothing was written (direct DB check: `Fabrikam
Refused` 0 rows, `Fabrikam No Control` 0 rows), and the read-back agreed. But an
application rejection is reported as *semantic drift*, and a vanished control is
reported as *policy refusal*. A human reading the run log has to reverse-engineer
the cause; a machine cannot do it at all. The application's own HTTP 500 never
reaches the run artifact.

---

## 5. The three highest-impact fixes (evidence-based)

No production failure occurred, so these are the three conditions that will
either cause the next failure or make it undiagnosable. Ranked by impact.

### 1. Failure origin is not machine-readable — everything else is guesswork

**Evidence.** 2 of 3 injected failures were unclassifiable from the run artifact
(§4). The app's HTTP status is dropped between `executeSkill` and the stored
execution. Engine halts describe symptoms — `semantic drift`,
`region_stable region=(168, 259, 944, 72)`, `geometry rung` — never a cause.
The API's step rows carry only a free-text `detail`. There is no error code on
any step, engine halt, or verification result.

**Fix (M1).** Emit a structured failure record per run: `origin`
(`reasoning|selector|timing|browser_session|application|verification|
infrastructure`), `detected_by` (`engine|oracle|policy|api`), and the raw
evidence (HTTP status + body, selector, engine rung, halt code). Have the
bridge map OpenAdapt halt reasons onto that enum rather than passing prose
through. This is additive: no rewrite of execution or verification.

**Why first.** Every other reliability number in M1 depends on failures being
attributable. Without this, a 100 % baseline cannot be distinguished from an
instrument that cannot see.

### 2. There is no per-step or per-phase timing

**Evidence.** **0 of 60** step rows carry a duration (the executor hard-codes
`durationMs: null` for every step). Execution wall time is 10 884 ms median
while the engine reports 5 406 ms — **49.5 % of the run is unattributed**
(median gap 5 409 ms, range 5 000–6 107 ms). The gap contains process spawn,
Chromium launch, two oracle reads and DB writes; the artifact cannot say which.

**Fix (M1).** Record `durationMs` per step from the engine report, and emit
phase timings for `bridge_spawn`, `browser_launch`, `replay`, `precheck_read`,
`post_read`, `persist`. Publish p50/p95 per skill. Only then decide whether the
5.4 s belongs in engineering (warm session/browser reuse) or is inherent.

**Why second.** Latency is the most visible reliability property an employee
feels, and the current artifact makes it unfixable without a stopwatch outside
the system.

### 3. Typed values are never proven to have landed

**Evidence.** **20 of 20** type steps report `postconditions_ok: null` and
`rung: null`; all four click steps per run report `postconditions_ok: true`. The
only proof that `company_name` and `email` were typed correctly is the final
system-of-record read. So a dropped or truncated keystroke is indistinguishable
from a failed save, a wrong selector, or an application rejection — it surfaces
as "record absent" at verification.

**Fix (M1).** Add a postcondition to each type step: read the field's value
after typing and assert it equals the parameter (the engine already has the page
handle). Record the observed value on mismatch.

**Why third.** It localises a whole class of silent failures to the exact step
and field, and it is a small, additive change in the bundle/compile step — not a
change to the verification doctrine.

> Deliberately **not** in the top three: giving the workflow a recovery/healing
> path. It is the largest latent risk (every run used `structural` resolution
> with `heal=0` and engine `modelCalls=0`, so any UI change is a hard failure —
> demonstrated by the `missing-control` probe), but it is a product decision
> about autonomy, and M1 should be able to *measure* drift before adding
> recovery. That measurement is the first M1 entry criterion in §8.

---

## 6. What this baseline does not prove

Written down because a 100 % figure invites exactly the wrong conclusion.

1. **Ceiling effect.** The target app has stable ids, no animation, no latency,
   no auth expiry, no concurrency, and no layout change between runs. The
   workflow resolves **4 of 6 steps structurally with zero healing** every time.
   A 100 % result on this target is a statement about the target's stability.
   It is **not** a production reliability estimate.
2. **The demonstration was scripted.** No human performed the workflow
   (no operator at this machine); the recorder was driven by a Playwright
   stand-in and the bridge labels it `synthetic:acme-crm`. The compiled bundle
   is genuine, but a human demonstration could produce different steps.
3. **One workflow, one application, one direction.** Only "create customer" on
   AcmeDesk CRM. No counts, no updates, no deletes, no cross-application run.
4. **Headless.** Replay ran headless Chromium; a headed session has different
   timing and window focus behaviour.
5. **Trace overhead is included in the timings.** Playwright tracing with
   screenshots was on for every run, so wall and engine times are inflated
   relative to a production run by an amount this baseline did not isolate.
6. **No concurrency or session-loss testing.** Runs were strictly sequential,
   with one long-lived employee token. Browser-crash, API-restart and
   token-expiry behaviour were not exercised.
7. **The taxonomy is heuristic.** Origin detection matches free text
   (§4). Treat any future per-category count as provisional until fix #1 lands.

---

## 7. Observations that are not failures but should be tracked

- **Cold start per execution.** Every run spawns Python + Chromium anew. The
  5.4 s unattributed gap is the price; it is consistent (σ small), so it is
  structural, not noise.
- **The engine never claims success on its own.** `execution_outcome` is
  `COMPLETED_UNVERIFIED` in 10/10 runs; only the independent read-back produces
  `VERIFIED`. The project's core doctrine held under repetition.
- **The duplicate guard is a real gate, not a message.** Probe 1 was refused
  before any browser work started (0 trace archives).
- **The demo app's own duplicate check (409) never fired**, because the pre-run
  oracle guard refuses first. That ordering is correct but means the 409 path
  is still only covered by unit/integration tests.
- **Traces are the richest artifact and are unowned by the product.** They only
  exist because of the diagnostic shim. Fix #1 becomes much cheaper if a trace
  is produced per execution as a first-class artifact.

---

## 8. Recommended M1 entry criteria

1. **Adversarial target matrix before more happy-path runs.** Same 10-run
   protocol against (a) a drifted page (renamed/removed control), (b) injected
   response latency and one 5xx, (c) an expired session mid-run, (d) a
   concurrent duplicate request. The app already exposes `reject-create` and
   `missing-control`; the rest needs test-fixture work, which is why it is M1.
2. **Land fix #1 (structured failure origin) first**, then re-run this harness:
   the probe table in §4 must flip from 1/3 to 3/3 automated origin detection
   before any category count is trusted.
3. **Land fix #2 and publish p50/p95 per phase**, then decide on session reuse
   with data instead of intuition.
4. **Land fix #3** and re-run the non-ASCII, apostrophe and long-name cases —
   they are the ones that would expose a typing truncation first.
5. Re-run the *same* baseline on the real SynTask target (§9) before any
   reliability claim is made about it.

---

## 9. BLOCKED: exact prerequisite for the real SynTask baseline

The M0 brief requires a **running, isolated SynTask test environment** and an
**employee-creation** workflow. Neither exists in this repository or on this
machine. To run the brief as written, provide:

1. A reachable SynTask instance dedicated to testing (base URL, e.g.
   `https://syntask-test.<host>`), isolated from production, with its data
   resettable between runs.
2. Test credentials for two roles: an admin who can approve a learned workflow,
   and an employee who can request it. Tenant/workspace id for each.
3. Confirmation that the employee-creation form is reachable by a browser and
   that creating the same employee twice is either rejected or is safe to
   repeat (the pre-run duplicate guard needs a deterministic answer).
4. A **read-back contract** for verification: an HTTP endpoint (or read-only DB
   view) that returns created employees, the JSON path to the records, and the
   field mapping — e.g. `GET /api/employees?email={email}` →
   `items[]`, `expect={"email":"email","full_name":"full_name"}`.
5. Network egress from this machine to that instance, and confirmation that
   driving it with an automated browser is permitted.

With those, `scripts/m0/reliability-baseline.ts` runs unchanged except for the
application definition (base URL + parameter names + verification contract),
which is data in `packages/workflow/src/demos.ts` — not a code change to the
execution path.

---

## 10. Artifacts

| Artifact | Path |
| --- | --- |
| Baseline evidence (canonical, 10 runs + 3 probes) | `.copilot-data/m0/2026-10-22T13-45-34-426Z/evidence.json` |
| Replication evidence (10 runs) | `.copilot-data/m0/2026-10-22T13-40-31-866Z/evidence.json` |
| Engine reports per execution | `.copilot-data/m0/<stamp>/runs/<executionId>/report.json` |
| Playwright traces (13 archives) | `.copilot-data/m0/2026-10-22T13-45-34-426Z/traces/*.zip` |
| Compiled bundle | `.copilot-data/m0/<stamp>/recordings/<recordingId>-bundle/` |
| Application database (disposable) | `.copilot-data/m0/<stamp>/demo/acme.db` |
| Harness | `scripts/m0/reliability-baseline.ts` |
| Trace shim (diagnostic, inert unless `M0_TRACE_DIR`) | `scripts/m0/playwright-trace-shim/sitecustomize.py` |

`.copilot-data/` is gitignored by design; the evidence above is local to this
machine. No product code, dependency or schema was modified for M0. Type check
after adding the harness: `pnpm exec tsc --noEmit -p tsconfig.json` → 0 errors.
