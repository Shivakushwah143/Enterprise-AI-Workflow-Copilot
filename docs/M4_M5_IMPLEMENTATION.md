# P0 + M4 + M5 — implementation and evidence

Run date: 2026-10-22. Branch `main`. Additive changes; no engine, database,
provider or approval rule was replaced. M0–M3 behaviour still passes its tests.

| Check | Command | Result |
| --- | --- | --- |
| Typecheck | `pnpm exec tsc --noEmit -p tsconfig.json` | PASS — 0 errors |
| Unit | `pnpm vitest run tests/unit` | PASS — **96 tests** (84 previous + 12 new) |
| API integration | `pnpm vitest run tests/integration/api.test.ts` | PASS — **31 tests** |
| M1–M3 regression smoke | `pnpm exec tsx scripts/m1m2m3-smoke.ts` | PASS — **22/22** |
| M4 A/B | `pnpm exec tsx scripts/m4-memory-ab.ts` | **0/3 → 3/3 verified** (see §3) |
| M5 two applications | `pnpm exec tsx scripts/m5-two-apps-smoke.ts` | PASS — **13/13** |
| M5 external readiness | `pnpm exec tsx scripts/m5-onboard-app.ts check` | **BLOCKED** — no external instance configured |

---

## 1. P0 — the rejected-write gap is closed

The engine report already carried two fields we never read: per-step
`safety_halt` / `safety_refusal_evidence`, and `halt.observed_texts` (the text the
application displayed when the run stopped). The bridge now forwards them, the
adapter maps them, and `classifyFailure` uses them in this order:

| Evidence on a halted step | Classification |
| --- | --- |
| `safety_refusal_evidence` present | `policy / SAFETY_HALT` — a real policy refusal |
| no refusal record, but the app showed a rejection (`Save failed: … rejected`, `validation failed`, `already exists`, `forbidden`, …) | `application / APPLICATION_REJECTED` |
| `safety_halt` with neither | `unknown / SAFETY_HALT_UNEXPLAINED` — no cause is invented |

Recorded evidence: `failure.evidence.applicationEvidence = { source:
"engine_observed_text", messages: [...], httpStatus: null }`. Customer input
values and e-mail addresses are stripped before the text is stored; the honest
part is `httpStatus: null`, because the engine exposes no response status. This
is application evidence, not HTTP evidence, and it is labelled as such.

Consequence, verified in the smoke and integration tests: the same rejected write
that M3 reported as `policy / SAFETY_HALT` is now `application /
APPLICATION_REJECTED`, with the app's own message, and is still never retried and
never reported `VERIFIED`.

---

## 2. M4 — memory is retrievable, applicable and used (implementation)

- `packages/agent/src/memory.ts` — `assessRepair` gates reuse on **tenant,
  application, workflow, workflow version, application origin, and the recorded
  control the repair describes**; each rejection records its reason.
- `ExecuteSchema.memory: "enabled" | "disabled"`, default `enabled`. `disabled`
  performs **no store read at all** (unit-tested: zero calls).
- Pre-flight order in `apps/api/src/targets.ts`: recorded selector → **reviewed
  repair** → role/label/text → bounded AI. A repair is used only if its selector
  is present in the live page; it never overrides a direct DOM identity match.
- `matchRepairs` attributes the run: `applied` (the repair decided what ran) vs
  `confirmed` (fresh re-discovery agreed with it).
- Every execution stores `memory: { mode, retrieved[], appliedRepairIds[],
  confirmedRepairIds[] }` and each step stores `repairId` +
  `resolutionSource: "repair"`.
- Promotion is unchanged: a candidate becomes reusable only through
  `POST /api/repairs/:id/review` by a role holding `workflow:approve`.

---

## 3. M4 — the controlled comparison (actual numbers)

### Why the earlier comparison showed nothing

A first A/B on an id-only change (`renamed-selector`) reported **NO MEASURED
IMPROVEMENT**: the repair was retrieved and applied 3/3, but the semantic ladder
re-identified the renamed control by its label and the engine's `template` rung
resolved it too, so both arms verified 3/3. The repair was used, not decisive.
Memory can only change an outcome where the deterministic evidence is genuinely
gone. That is the scenario below.

### The scenario that isolates it

The same application ships a design-system restyle: the save control **keeps the
id from the previous release** (`#save-customer-v2`) and its label is now rendered
by CSS (`::after`), so the DOM carries no text while the screen is pixel-identical
to the recording. Probe (engine only, no copilot): `success=true`, step 5 resolved
via `template`, record written — the engine can still act; the DOM-text ladder
cannot identify it. Nothing is switched off in either arm: the ladder runs the
same in both, and `memory: "disabled"` simply refuses to read the store.

Learning run: `renamed-selector` → ladder discovers `#save-customer-v2` → run
verified → candidate `0d72c3fd…` → approved by the admin (`workflow:approve`).
Then three pairs, alternating order, database reset before every run, no AI
locator, same workflow version `a463d643…` v1 and the same input per pair.

| Metric | memory_disabled | memory_enabled |
| --- | --- | --- |
| **Verified completion** | **0/3** | **3/3** |
| Failure reason | `selector / CONTROL_NOT_RESOLVED` ×3 (refused before acting) | none |
| Repairs retrieved | 0 (no read) | 3 |
| Repairs applied | 0 | **3** (same repair each run) |
| Step 6 resolution | `none` → refusal | `repair` ×3 |
| Engine model calls | 0 | 0 |
| Recovery / repair attempts | 0 | 0 |
| Human interventions (per run) | 0 | 0 |
| Median wall duration | 2 030 ms (refusal) | 11 267 ms (real execution) |

**Verdict: MEMORY IMPROVED VERIFIED COMPLETION — 0/3 → 3/3.** The enabled arm
was verified against the application's own record each time; the disabled arm
refused before anything was clicked or typed, so no write could occur. The
duration difference is the cost of doing the work, not a regression.

Boundaries of this evidence: one workflow, one repair, three pairs, one
application. The repair is consulted *before* fresh discovery, so its
applicability gate (tenant, application, workflow, version, learned origin,
unchanged recorded control, selector present in the live page) is what carries
the safety. A stale repair cannot be used: it fails applicability and the run
refuses rather than guessing.

---

## 4. M5 — multi-application integration

### What is generic now

- An application is configuration: `{ name, baseUrl (identity),
  verificationBaseUrl }`, registered idempotently through
  `POST /api/applications`. No executor branch knows any application name.
- `scripts/m5-onboard-app.ts` — `check` (external prerequisites),
  `onboard --name --url` (register + prove the identity resolves + list that
  application's workflows), `verify --skill --intent [--inputs] [--no-approve]`
  (execute with new input, read back; `--no-approve` must be refused).
- Verification is the skill's HTTP read-back contract; the workflow, its version
  and its skills are scoped per tenant and application, and repairs carry
  application + workflow version + learned origin.

### Actual verification (two project-owned demo applications)

`scripts/m5-two-apps-smoke.ts` runs the same code path for AcmeDesk (:4300) and
StockDesk (:4400): register from configuration → identity resolves → scripted
demonstration → compiled draft → administrator approval with a read-back contract
→ execution with a **new** input → independent read-back → refusal check → memory
isolation check. 13/13 checks passed. Two independent records were verified:

| Application | Workflow | Outcome | Verification source |
| --- | --- | --- | --- |
| AcmeDesk CRM | Create customer v1 | `VERIFIED` | `/api/customers?name=Wingtip Toys` — 1 record |
| StockDesk Inventory | Register stock item v1 | `VERIFIED` | `/api/items?sku=SKU-WINGTIP-7` — 1 record |

Refusals: an unapproved consequential run returned `REJECTED_POLICY` and wrote
nothing; a repair learned for AcmeDesk was assessed against StockDesk and
rejected (`learned on a different application`); another tenant read 0 repairs.

**These are demos.** They prove the pipeline is not AcmeDesk-specific. They are
not evidence about SynTask or Twenty CRM.

### Independent applications — BLOCKED

`scripts/m5-onboard-app.ts check` output:

| Application | State | Missing |
| --- | --- | --- |
| SynTask HRMS | BLOCKED | `SYNTASK_BASE_URL`, `SYNTASK_API_TOKEN` (and an isolated test tenant + a role allowed to create employees) |
| Twenty CRM | BLOCKED | `TWENTY_BASE_URL`, `TWENTY_API_TOKEN` (and an isolated workspace + API token for a test account) |

No instance was contacted, cloned, installed or deployed. Nothing was recorded
against either application, and no human demonstration is claimed.

---

## 5. Remaining blockers

1. **Independent applications (M5).** Blocked on credentials/URLs for an
   isolated SynTask tenant and a Twenty workspace, plus a test role that may
   create records, plus their read-back endpoints. Once supplied:
   `check` → `onboard` → administrator records (human) → approve with a read-back
   contract → `verify`. A human must perform the demonstration; that step is
   HUMAN PENDING.
2. **Outcome-level memory improvement (M4).** Demonstrated for a control that
   loses its DOM identity but keeps its pixels (0/3 → 3/3). Not demonstrated for a
   control that also changes appearance (id + wording): there the engine's
   `template` rung fails and refuses (`geometry` rung, irreversible), so an
   engine-side selector override would be needed — out of scope here.
3. **HTTP status for rejected writes.** Still unavailable from the engine; the
   classification uses the application's displayed message and says
   `httpStatus: null`.
4. **AI locator assistance** remains implemented-but-unproven in a smoke: a probe
   against a relabelled control returned no observation, and it is off by default.
5. **Scale.** Three pairs and one execution per application; no benchmark.

---

## 6. Running it

```bash
pnpm install
pnpm demo                       # API (:4110) + AcmeDesk (:4300)
pnpm exec tsx scripts/m5-onboard-app.ts check
COPILOT_API_URL=http://127.0.0.1:4110 COPILOT_TOKEN=<admin token> \
  pnpm exec tsx scripts/m5-onboard-app.ts onboard --name "SynTask HRMS" --url "$SYNTASK_BASE_URL"
pnpm exec tsx scripts/m4-memory-ab.ts     # A/B comparison, writes .copilot-data/m4/<stamp>/
pnpm exec tsx scripts/m5-two-apps-smoke.ts
pnpm exec tsx scripts/m1m2m3-smoke.ts
```

Manual steps still required (HUMAN PENDING): an administrator must demonstrate
each new application's workflow in a browser (interactive recording), and a
reviewer with `workflow:approve` must approve the compiled workflow and any
repair candidate.
