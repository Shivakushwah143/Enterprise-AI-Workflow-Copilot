# M1 + M2 + M3 — implementation

Run date: 2026-10-22. Branch `main`. Additive changes only: no workflow engine,
database engine, provider or approval rule was replaced, and every M0 behaviour
still passes its original tests (31 API integration tests, 56 pre-existing unit
tests).

Verification run in this batch:

| Command | Result |
| --- | --- |
| `pnpm typecheck` (root + 7 packages) | PASS — 0 errors |
| `pnpm vitest run tests/unit` | PASS — **84 tests** (56 existing + 28 new) |
| `pnpm vitest run tests/integration/api.test.ts` | PASS — **31 tests** |
| `pnpm exec tsx scripts/m1m2m3-smoke.ts` | PASS — **22/22** smoke checks |

---

## M1 — execution reliability

### 1. Structured failure classification

`packages/agent/src/failures.ts` produces, for every non-verified execution:

| Field | Meaning |
| --- | --- |
| `origin` | `reasoning · selector · timing · browser_session · application · input_verification · verification · infrastructure · policy · unknown` |
| `code` | stable machine code (`CONTROL_NOT_RESOLVED`, `ORACLE_RECORD_ABSENT`, `INPUT_VALUE_MISMATCH`, `SAFETY_HALT`, …) |
| `detectedBy` | `engine · oracle · policy · api · copilot` — where the verdict came from |
| `stepIndex` | the step to look at, when one can be named |
| `evidence` | halt text, rung counts, failed-step errors and categories, verification detail, raw engine error |

Detection order is causal, not cosmetic: an input mismatch is reported before the
missing record it causes; an unreachable oracle is `infrastructure` (outcome
unknown), never a business failure; a quiet engine plus an absent record is the
dangerous `verification / ORACLE_RECORD_ABSENT` case. When nothing in the
evidence supports a cause the answer is `unknown`, with the evidence attached.

Persisted on the execution row (`failure JSONB`, `timings JSONB`,
`recovery JSONB`) and exposed by `GET /api/executions/:id`.

### 2. Execution timing

- Per step: `durationMs` now comes from the engine's own `elapsed_ms` (the column
  was previously always `null`).
- Per phase: `bridgeStartupMs`, `replayMs`, `engineOverheadMs` (engine total minus
  its own step times), `verificationMs` (both oracle reads), `persistenceMs`,
  plus `totalMs`.
- The bridge (`packages/workflow/python/copilot_bridge.py`) forwards the engine's
  per-step evidence and totals; the adapter and `WorkflowEngine` types carry it.

Smoke measurement of one 6-step run: total 10 229 ms, engine replay 3 953 ms,
bridge startup 4 985 ms, steps 1 469/593/469/547/328/547 ms. The M0 gap is now
attributable instead of a residual.

### 3. Input verification

The engine already checked typed values (`input_verified`); it was discarded. The
bridge now forwards it, the executor maps it, and a step whose field did not
receive the requested value is reported `failed` with
`input_verification / INPUT_VALUE_MISMATCH` at that step — instead of surfacing
later as "record absent". Smoke: both type steps report `inputVerified: true`.

---

## M2 — workflow generalization

| Requirement | Implementation |
| --- | --- |
| Reusable parameter mapping | `packages/agent/src/parameters.ts` binds skill `ParamSpec`s to the steps that consume them; `replayValues` never sends secrets; planner and executor share the binding |
| Required vs optional fields | `bindParameters` / `missingRequired`: a parameter a step consumes is required; a declared-optional, unused one is not |
| Semantic locator preference | `packages/workflow/src/locators.ts`: recorded selector → `role+name` → label → text. Pure and unit-tested |
| Element re-discovery | `apps/api/src/targets.ts` resolves every target in the live page before execution, including controls inside a form the workflow opens later. Drift is reported per step (`resolvedSelector`, `resolutionSource`) |
| Bounded Stagehand assistance | `locateWithStagehand` in `apps/api/src/stagehand.ts` asks Stagehand to *identify* one control and return a selector; it never acts. Only used when the execution request sets `allowAiLocator: true`, and the returned selector must exist in the page |
| Explicit refusal | An `irreversible` target that cannot be identified fails the run before anything is clicked or typed (`CONTROL_NOT_RESOLVED`, "Nothing was clicked or typed") |

**Boundary discovered during implementation (important).** Approved bundles are
sealed: `openadapt-flow replay` recomputes the bundle digest and rejects a
modified `workflow.json` (`BundleIntegrityError: … modified after the manifest
was sealed`). Rewriting a selector into the bundle is therefore not possible, and
a synthesized anchor is invalid anyway (the engine requires the recorded
template, region and click point). A probe confirmed the engine already
generalizes over the test's UI change by itself: with the sealed bundle and a
renamed save button, step 5 resolved via the `template` rung and the run
verified. So M2 *detects and reports* drift, and refuses when a consequential
control cannot be identified; it never edits a sealed artifact.

---

## M3 — recovery + memory

| Memory | Storage |
| --- | --- |
| Episodic | `execution_memory`: execution id, skill/workflow/application, intent, outcome, failure, recovery, engine report (trace reference), non-secret context. Written for every attempt, including refusals |
| Procedural | `repairs`: tenant, application, workflow, skill, workflow version, failure origin/code, action (`selector_override` with recorded and live selector), applicability conditions, `candidate/approved/rejected/retired`, success/failure counts, reviewer |
| Semantic | Reused as-is: `applications`, `app_pages`, `ui_elements`, `workflow_steps` |

Recovery engine (`packages/agent/src/recovery.ts`):

```
classify -> eligibility -> read business state -> ONE retry (unchanged bundle)
         -> verify -> store result
```

Enforced:

- **One attempt.** One replay, no loop.
- **No repeated consequential write.** The oracle is read again first; if the
  record exists, recovery refuses. If the oracle cannot be read, it refuses
  (outcome unknown).
- **Only transient failures are retried** (`timing`, `browser_session`). A
  locator drift is not replayed — the engine resolves it through its own rungs,
  and replaying the same sealed bundle would add nothing.
- **No policy widening.** The retry inherits the approval, tenant and
  verification contract of the approved execution; it cannot run without them.
- **Promotion requires review.** A verified drift stores a `candidate` repair;
  only `POST /api/repairs/:id/review` (permission `workflow:approve`) makes it
  `approved`. Employees get 403.
- **Reuse does not rewrite the bundle.** An approved repair is confirmed against
  the live control before the run; the step detail records
  `resolved via template · approved repair <id> confirmed the live control`, and
  the repair's success count is updated only on a verified run.

New endpoints: `GET /api/memory/episodes`, `GET /api/repairs`,
`POST /api/repairs/:id/review`.

---

## Smoke evidence (22/22)

`.copilot-data/m1m2m3/<stamp>/` — disposable demo app + embedded database.

| Scenario | Result |
| --- | --- |
| 1. New data, normal UI | `VERIFIED`; 6/6 steps with real durations; both typed fields engine-verified; all targets resolved, none by AI |
| 2a. Renamed save control | `VERIFIED`; step 6 `rediscovered` → `#save-customer-v2`; repair stored as `candidate` |
| 2b. Review + reuse | Admin approval 200, employee 403; next run `VERIFIED`, repair `successCount=1`, step detail names the repair |
| 3. Rejected write | `FAILED` (never `VERIFIED`); `policy / SAFETY_HALT`; not retried; nothing written; 4 episodic rows |

---

## Remaining gaps (not claimed as solved)

1. **The application's own response is still not machine-readable.** A rejected
   write arrives as the engine's `safety_halt`; the app's HTTP 500 is not in the
   run artifact. It is classified `policy / SAFETY_HALT`, with the engine halt
   text preserved. Reading the app's response needs engine-side evidence.
2. **A selector drift cannot be persisted back into the workflow.** Sealed
   bundles mean the durable fix is a new (engine-sealed) recording; a reviewed
   repair currently validates the expected control, it does not modify the run.
3. **AI locator assistance is implemented but unexercised in the smoke.** It is
   opt-in (`allowAiLocator`) and Stagehand is configured in this environment; no
   assertion covers it yet.
4. **Recovery covers transient failures only.** Latency/browser loss are retried;
   application rejections, policy stops and missing records are answers, not
   obstacles.
5. **No benchmark re-run.** Per the batch rules the M0 10-run baseline was not
   repeated; the numbers above are one smoke execution per scenario.
