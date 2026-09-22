# Module 05 — Decision Center

**Route:** `#/decision` · **Page:** `frontend/src/pages/Decision.tsx`
**Store:** `frontend/src/store/decisionScenarios.ts` (board, localStorage) · `POST/GET/DELETE /api/store/board-decisions` (saved decisions)
**Status:** Rebuilt 2026-09-22 — the open module; the first four are frozen

## What the page does

1. **Scenario cards** — up to three, one per slot ("Scenario 1/2/3", a slot
   is reused after removal), each sent from the Simulation Studio's **Add to
   Decision Center**. A card shows the scope, the three lever values as chips,
   and the deciding figures up front: **Revenue** and **ROI** with their
   movement against the current plan and the ROI status (Profitable /
   Break-even / Loss-making). **Choose this scenario** marks it as the
   decision. The studio refuses the same scenario twice (same scope, currency
   and levers) and a fourth.
2. The better **Revenue** and **ROI** across the cards get a check. Revenue
   is a total over the window, so it is ranked only when every scenario runs
   the same number of days; ROI is a rate and ranks regardless. (A separate
   "Side by side" table was tried and removed the same day at the user's
   request — the cards carry the comparison; the export keeps a full table.)
3. **Decision** — the chosen scenario, a rationale, and **Save decision**,
   which stores the whole board (`board_decisions`: the scenarios exactly as
   snapshotted, the chosen slot, the rationale, the dataset fingerprint).
4. **Saved decisions** — the history, newest first, each with the chosen
   scenario's depth, days, revenue and ROI and its rationale. **Review**
   reloads that board (banner: "Reviewing a saved decision"); **Clear
   history** removes all of them after confirmation.
5. **Export Report** — the `decision-center` report module rendered from the
   board (`options.board`): the decision, the rationale and the comparison
   table, PDF and Excel.

**Nothing on the page is calculated.** Every figure is the display string the
studio produced when the scenario was added; "best" compares the numbers
behind those strings and produces no new number. Dropped from the page as
noise: the per-metric comparison table, revenue and ROI ranges, "revenue vs
no promotion"; the levers are chips on the card.

The earlier candidate board, governed record, briefing, AI brief and history
UI described below were removed with the studio that fed them. Their backend
routes (`/api/decision/*`, `/api/store/decisions`) remain and still serve
records stored before 2026-09-22; `tests/legacy_journey.py` keeps their tests
running. `tests/test_board_decisions.py` covers the new store and export.

---

## Historical description (the page before 2026-09-22)

> Every file path below was removed on 2026-09-22 along with the studio that
> fed this page. The section is kept as a record of what the page used to do,
> not as a map of the code.

## 1. Purpose

Decision Center is the **final stage** of the TPO workflow:

```
Command Center → RCA / Investigation → Simulation Studio → Decision Center
```

It answers one question: *I have selected a scenario. What exactly am I
deciding, why was this scenario selected, what is its expected impact, what are
the risks, and what evidence supports the decision?*

It is **not** another analytics dashboard. It assembles an existing simulation
scenario, its recommendation, its risk assessment and its investigation context
into one traceable **Decision Record**.

> **An assembly, not a calculation.** `app/tpo/decision.py`:
> *"Nothing here computes a KPI, re-derives an uplift, re-runs a comparison,
> re-applies the recommendation policy or re-assesses risk. Every figure is
> carried through verbatim… If a number in Decision Center ever disagrees with
> the same number in Simulation Studio, the cause is a bug in this file rather
> than a second opinion."*

## 2. User workflow

| Step | What happens |
|---|---|
| 1 | In Simulation Studio, run and select a scenario |
| 2 | **Open Decision Center** carries six payloads across in `store/decisionDraft.ts` |
| 3 | The page posts them to `POST /api/decision/record`, which validates and assembles |
| 4 | **Save Decision** → `POST /api/store/decisions` mints the id and appends a version |
| 5 | **Generate AI Decision Brief** explains the record in executive language *(optional)* |
| 6 | **Generate Briefing** renders the artifacts; **Download** writes them |
| 7 | **Export Report** stores a report in the Report Center; the Reports page downloads it |
| 8 | **Decision History** reopens any stored decision by id |

Opening `#/decision` with nothing carried and nothing saved shows **"No scenario
has been carried here"**, a Back to Simulation Studio action, and the history
list. No KPI card is rendered.

## 3. Simulation → Decision handoff

`store/decisionDraft.ts` carries **six results the page already holds**. Nothing
is recomputed on either side.

| Field | Source contract | Required |
|---|---|---|
| `context` | `POST /api/simulation/context` | yes |
| `simulation` | `POST /api/simulation/simulate` — the scenario chosen to carry | yes |
| `recommendation` | `POST /api/simulation/recommend` | yes |
| `risk` | `POST /api/simulation/risk` | yes |
| `weekly` | `POST /api/simulation/weekly`, when that view was open | optional |
| `comparison` | `POST /api/simulation/compare` | optional |
| `baseline` | `POST /api/simulation/run` — the **measured** baseline | optional |

**Consistency is enforced, not hoped for.** The draft carries a `signature`
built from scope, scenario, treatment, recommendation and risk status, and
Simulation Studio drops it the moment that signature stops matching
(`Simulation.tsx`). Simulation showing *Optimized Plan* while Decision Center
shows *Aggressive Growth* is structurally impossible unless the user changed the
scenario.

## 3a. Page states — and the bug that made them matter

Every async path on this page has four states, and none of them can hang.

| State | Shown |
|---|---|
| Loading | *"Building your decision record…"* |
| Success | The record |
| Error | *"Unable to build the decision record"* + the server's reason + **Retry** / **Back to Simulation Studio** |
| Empty | *"No scenario has been carried here"* + **Back to Simulation Studio** + Decision History |

A **422** is treated as its own case, because it is not retryable: the payloads
carried here disagree with each other. The page shows *"Scenario data is
inconsistent. Please return to Simulation Studio and reopen the selected
scenario."*, the server's message naming which two sections disagree, and leads
with **Back to Simulation Studio** rather than a Retry that cannot help.

### The infinite-loading root cause (fixed)

The page previously sat on *"Assembling the decision record…"* forever, with no
error, nothing logged and nothing to retry.

**Cause.** The effect that posts to `/api/decision/record` guarded itself with a
`useRef` holding the draft signature, and **that guard had no cleanup**. React's
`StrictMode` (active in `main.tsx`) mounts, unmounts and remounts on first
mount, and react-query drops a mutation's observer on unsubscribe without ever
re-attaching it — `MutationObserver` has `onUnsubscribe` but no `onSubscribe`.
So:

1. Mount #1 set `requested.current = signature` and fired the request.
2. The StrictMode unmount discarded that mutation's observer.
3. Mount #2 saw `requested.current === signature` and **returned early**.
4. The only request in flight was one nobody was listening to. It returned
   `200`, `onSuccess` never ran, `data` never arrived, `isPending` never
   cleared, and no error was ever raised.

**Fix.** Return a cleanup that clears the ref, so the surviving pass issues the
request it can actually receive. It is still one request per signature.
`Simulation.tsx` already carried this exact fix on its `/run` effect, with the
same explanation — Decision Center never got it.

This was a genuine promise-never-resolves hang, not a slow backend: no timeout
was added, and none would have helped.

## 4. Cross-validation

Sections are checked **against each other** before anything is assembled. A
mismatch raises `SectionMismatch` → **422** naming which two sections disagree.

| Check | What it prevents |
|---|---|
| `risk.scenario_id == scenario_id` | risk from another scenario |
| `risk.provenance.scenario_provenance == simulation.provenance` | risk computed from a different run of this scenario |
| `context.filter_state == simulation.scope.filters_applied` | a scope the investigation never described |
| scenario ∈ recommendation's eligible ∪ excluded | a recommendation that never saw this scenario |
| `weekly.scenario_id` / `discount_pct` / scope | a decomposition of something else |
| `comparison.scope == scenario scope` | a table computed over other rows |
| scenario ∈ `comparison.scenarios` | a comparison this scenario is absent from |
| `baseline.scope.filters_applied == scenario scope` | a measured value from another selection |

## 5. The DecisionRecord

```jsonc
{
  "decision_id": null,           // this contract persists nothing
  "status": "draft",
  "scenario":        { scenario_id, name, treatment, discount_pct, uplift, range_label },
  "investigation":   { … from context, with per-field provenance … },
  "scope":           { filters_applied, period, row_count,
                       promoted_row_count, excluded_rows },
  "strategy":        { available, treatment, levers[], baseline_available,
                       baseline_unavailable_reason, note },
  "expected_impact": [ … per metric, BOTH band ends … ],
  "comparison":      { available, status, scenarios[], metrics[],
                       economic_basis, measured_note }   // or { available: false, reason }
  "recommendation":  { is_this_scenario, policy_version, reason, … },
  "governance":      { overall_status, findings[], governance_gaps[], limitations[] },
  "weekly":          { available, week_count, weeks[], … }  // or { available: false, reason }
  "readiness":       { can_be_approved: false, reason, blockers[], unverified[],
                       states: { recommended, governed, ready_to_review, approved },
                       states_note },
  "provenance":      { assembled_from[], kpi_engine, response_rule,
                       promotion_cost_rate, recommendation_policy_version,
                       risk_policy_version, scenario_provenance, method },
  "meta":            { phase, persisted: false, persistence_note }
}
```

`strategy` and `comparison` are **additive**. A record assembled without the
comparison and baseline payloads carries both sections with the reason each one
is empty (`decision.NO_COMPARISON_CARRIED`, `decision.NO_BASELINE_CARRIED`) and
every other section byte-identical.

## 6. Page sections

| # | Section | Component | Shows |
|---|---|---|---|
| A | Header | `Decision.tsx` | Back to Simulation · Save Decision · Export Report · Generate Briefing |
| B | Decision under review | `ContextSection` | **Decision ID**, version, status, scope, investigation + question (with an ⓘ when there is none) |
| C | Recommended Plan | `RecommendedPlanSection` | Selected scenario, recommended scenario, **Why this scenario?**, policy |
| D | Strategy | `components/decision/StrategySection.tsx` | Per lever: **Current (measured) · Selected · Recommended** |
| E | Expected Impact | `ImpactSection` / `ImpactRow` | **Both ends of the approved range. No midpoint.** Marked `Simulated` |
| — | Weekly note | `WeeklyNote` | Present only when a weekly decomposition was carried |
| F | Scenario Comparison | `components/decision/ComparisonSection.tsx` | Measured baseline column beside each scenario's simulated band |
| G | Risk & Governance | `GovernanceSection` / `FindingRow` | Risk status, findings by severity, governance gaps, method limitations |
| H | Decision Readiness | `ReadinessSection` | Four states, blockers, unverified items, **Approval: Not configured · Execution: Not configured** |
| I | Evidence & Provenance | `components/decision/EvidenceSection.tsx` | Decision/investigation/scenario IDs, version, dataset fingerprint + freshness, policies, assembled-from |
| J | AI Decision Brief | `components/decision/AiDecisionBrief.tsx` | Six-paragraph explanation, **on demand only**. Explanation-only badge, model name, disclaimer |
| K | Actions | `ActionsSection` | Save Decision · Generate Briefing → Download |
| L | Decision History | `components/decision/DecisionHistory.tsx` | Every stored decision: id, scenario, version, saved time, status, freshness |
| — | Stored banner | `StoredBanner` | After a save or a reopen: id, version, stale state |

## 7. Strategy — only levers that exist

The rows are `simulation.levers`, written by the engine. Nothing is added.

| Column | Source | Kind |
|---|---|---|
| **Current** | `/simulation/run` → `current_plan.fields[]` | **measured**, with the derivation string that produced it |
| **Selected** | `/simulation/simulate` → `levers[]` | the scenario's own setting |
| **Recommended** | the recommended scenario's `discount_pct` in the comparison, read **by id** | policy preference |

**Discount only carries a recommended value.** The decision policy chooses a
*scenario*, and the only lever a scenario varies is its treatment depth;
duration and spend carry *"The decision policy chooses a scenario, not a value
for this lever. Nothing recommends one."*

A lever the engine records but does not model is badged **Not modelled** — the
expected impact does not respond to it, and the page says so.

**Retailer Incentive, Inventory Allocation and Budget Allocation do not
appear.** `simulation._LEVER_META`: *"no field in any of the five datasets
splits retailer support out of Promotion_Cost, and the project holds no
inventory data at all. A lever with nothing behind it is not offered."*

## 8. Measured vs simulated

Kept in different fields at every level, and labelled at every level.

- **Expected Impact** carries a `Simulated` badge in its header and a footnote
  pointing at the measured figures.
- **Scenario Comparison** has one **Current · measured** column
  (`metrics[].baseline`) and one **simulated band** per scenario
  (`metrics[].scenarios[].low` / `.high`).
- `comparison.measured_note` states it in the record itself, so any renderer —
  including the report writer — carries it.

**No band is ever collapsed.** An ROI of 48%–61% renders as `48% – 61%`. There
is no midpoint field to render and none is derived anywhere.

**A metric with no value keeps the engine's reason** in an ⓘ. It is never
zero-filled, and a scenario nobody ran is `excluded` with its reason rather than
a row of zeros.

## 9. Risk, readiness, approval and execution

`readiness.can_be_approved` is `false` in **every** record.
`decision.NO_APPROVAL_CRITERIA`:

> *"This project defines no approval criteria: nothing states who approves a
> promotion decision, against which tests, or in what order. A record cannot be
> declared approvable against rules that do not exist."*

`readiness.blockers` always begins with that, then adds every **high-severity
`attention`** finding. `readiness.unverified` collects the remaining
`attention`/`unknown` findings **plus every governance gap** — the boundaries
this project has never approved.

The page prints **Approval: Not configured** and **Execution: Not configured**.

**Nothing fabricated.** There is no "Budget Compliant", no "Margin Safe", no
"Within Risk Envelope", no "14/14 Governance Checks Passed" and no confidence
score anywhere in the record or the page. Those claims were made against
thresholds this project has never defined.

`readiness.states` keeps four things apart:

| State | Value |
|---|---|
| `recommended` | Whether the policy chose **this** scenario |
| `governed` | `risk.overall_status == "clear"` |
| `ready_to_review` | Always `true` |
| `approved` | **Always `false`** |

## 10. Persistence, versioning and provenance

Storage is SQLite (`backend/app/store/`), **append-only**, and a separate
explicit action from assembling a record.

```
Save Decision → POST /api/store/decisions { record, investigation_id?,
                                            scenario_id?, decision_id?,
                                            expected_version? }
```

- **Server-minted ids.** `dec_…`, `scn_…`, `inv_…`. The session-local
  `scenario-N` is a counter that resets on reseed and can never be a durable key.
- **The record is stored untouched** — `decision_id: null`, `status: "draft"`,
  `meta.persisted: false`, exactly as assembled. The storage identity lives in
  the **envelope around it**, which is what lets a stored record be handed
  straight to `/api/decision/briefing`.
- **Append-only versioning.** Re-saving appends a version to
  `decision_versions`; there is no `UPDATE` and no `DELETE` in the package. A
  stale `expected_version` → **409** naming `current_version`.
- **Dataset fingerprint.** SHA-256 over the exact bytes of every source CSV in
  fixed filename order, computed server-side; no route accepts a client-supplied
  one. Recorded at write time, compared at read time.
- **Stale is reported, never resolved.** When the fingerprint differs, the
  envelope says `stale: true` with the reason and the historical payload is
  returned exactly as written. **Nothing is recomputed and nothing is
  overwritten.**
- **`owner` is always `null`**, with `NO_OWNER_NOTE` returned beside it. There is
  no authentication, so there is no actor to attribute a row to.

The browser remembers the last saved id in `store/savedRefs.ts` (`localStorage`)
— a **pointer only**. Clearing it loses the shortcut, not the decision: the
record is still retrievable by id, and Decision History lists every stored one.

**Reopening.** `DecisionHistory` → `GET /api/store/decisions/{id}` renders the
stored bytes. A reopened decision outranks a carried draft, so asking for a
specific id always shows that id.

## 11. Briefing and Report Center

Two separate downstream paths, both using the **current displayed record**.

**Generate Briefing** → `POST /api/decision/briefing` renders `briefing.html`
(self-contained; a browser prints it to PDF) and `briefing.json`. **Generating
does not download.** The artifacts appear with an explicit **Download** control,
matching the Report Center's generate-then-download shape. Nothing is stored and
nobody is notified.

The artifact insists on its own limits in the JSON envelope, the page header, a
banner and every printed page footer:

> *"This briefing is a DRAFT. The decision it describes is NOT APPROVED and NOT
> SAVED… Nothing here authorises spend, and no reviewer has signed it."*

**Export Report** → `ExportReportButton module="decision-center"` → stored in the
Report Center → downloaded as Excel or PDF from the Reports page.

The adapter takes **two ways in**:

| Option | Behaviour |
|---|---|
| `decision_record` | a record that already exists — a **reopened decision exports its stored bytes** |
| `record` | the Simulation payloads, assembled by `decision.build_record`, the same function the API calls |

The `decision_record` path exists because re-assembling a stored decision from
today's dataset would silently republish a historical decision at current
numbers — exactly what the fingerprint exists to prevent. An `options.storage`
block carries the decision id, version, dataset fingerprint and stale flag into
the export.

The report prints the record and reinterprets none of it: identity, strategy,
expected impact (both band ends), the comparison, the recommendation, risk
findings, governance gaps, readiness blockers and provenance. An unavailable
metric prints its reason, never a zero.

## 11a. The OpenAI explanation layer

> **OpenAI is used only to generate an executive explanation. The LLM is not the
> source of truth for any TPO KPI, calculation, recommendation, risk score,
> governance rule or approval decision.**

```
DATA → deterministic KPI → Simulation → deterministic Risk
     → deterministic Recommendation → DECISION RECORD
                                            │
                          ┌─────────────────┴─────────────────┐
                    Exact numbers                    LLM explanation
                    (every card)                     (one card, optional)
                          └─────────────────┬─────────────────┘
                                     DECISION CENTER
```

### Responsibilities

| Deterministic engines | The LLM |
|---|---|
| Every KPI, band and delta | Nothing |
| Which scenario is recommended | Nothing |
| Risk status, findings, severities | Nothing |
| Readiness, blockers, approval state | Nothing |
| Persistence, ids, versions, fingerprint | Nothing |
| — | Six paragraphs of prose explaining the above |

### Why it cannot invent a number

`decision_brief.projection()` sends the model a deliberate **projection**, not
the record:

- **Display strings, never floats.** A band arrives as one preformatted string
  — `"₹6.9 Cr - ₹8.6 Cr"`. There is no `low` and no `high` field, so there is no
  pair of numbers to average. A midpoint is not merely forbidden by the prompt;
  the inputs for one are never present.
- **Measured and simulated in separate lists**, each row carrying an explicit
  `kind` (`simulated` / `measured_historical`).
- **Unavailable metrics travel as their reason**, never as zero.
- **Ids, fingerprints and internal provenance are withheld** — the model has no
  reason to explain an id and every reason not to paraphrase one.

The request model accepts `{ record }` and **forbids extras**, so no prompt,
persona or instruction can redirect the model away from explaining this record.

Output is **strict JSON schema** (`strict: true`, six required fields,
`additionalProperties: false`), so the card renders known sections rather than
parsing prose.

### The figure check

`unverified_figures()` extracts every number the model wrote and reports any
that do not appear in the projection it was given. Comparison is normalised
(`15.0` and `15` are the same figure) and bare single digits are ignored.

It is **advisory, not a gate**: the brief is still returned and rendered, with a
caution strip above it naming the flagged figures. The deterministic cards are
unaffected either way. In live testing against `gpt-4o-mini` the list came back
empty and every figure was quoted verbatim, ranges intact.

### Security

| Requirement | How |
|---|---|
| Key server-side only | Read by `app/agents/client.py` from `backend/.env` (gitignored) |
| Never in the frontend | Not in any `VITE_*` variable; the browser calls `/api/decision/brief` and sends only the record |
| Never in a request | No request model accepts a key — an extra field is a **422** |
| Never in a response | The response is prose + disclaimer + model name |
| Never in the OpenAPI schema | Asserted by `test_the_openapi_schema_exposes_no_key_field` |
| Never in an error | A missing key returns a message naming the **setting**, never a value |

### Failure behaviour

**Decision Center never depends on this call.**

| Case | Result |
|---|---|
| No key configured | **503** → card reads *"AI explanation not configured"*, names the setting. Page fully usable |
| Service unreachable / timeout | **502** → card reads *"AI explanation unavailable"* + **Retry**. Page fully usable |
| Incomplete answer | **502** naming the empty section — never a card with a blank heading |
| Model mentions an unsupported number | Text is rendered as explanation; the flagged figure is called out; **deterministic values remain authoritative** |

**No automatic call on page load.** There is no effect that fires this — only
the button. That is what guarantees a slow or unavailable model cannot delay or
block the page. Carrying a new scenario resets the brief, so an explanation can
never sit under numbers it does not describe.

**Save Decision is never blocked by AI failure.** The two share no state.

## 12. APIs

| Method | Route | Purpose |
|---|---|---|
| `POST` | `/api/decision/record` | Assemble one record from 4 required + 3 optional payloads |
| `POST` | `/api/decision/briefing` | Render one record as `briefing.html` + `briefing.json` |
| `POST` | `/api/decision/brief` | **AI explanation** of one record. 503 = no key, 502 = model unavailable |
| `POST` | `/api/store/decisions` | Store a record (or append a version) |
| `GET` | `/api/store/decisions` | List stored decisions, newest first — headers only |
| `GET` | `/api/store/decisions/{id}` | Read one back byte for byte (`?version=` for a specific one) |
| `POST` | `/api/store/scenarios` | Store a simulation result — mints the `investigation_id` |
| `GET` | `/api/store/scenarios/{id}` | Read a stored scenario back |
| `POST` | `/api/reports` | Generate a `decision-center` report into the Report Center |

## 13. File map

| Concern | File |
|---|---|
| Page | `frontend/src/pages/Decision.tsx` |
| Sections | `frontend/src/components/decision/{StrategySection,ComparisonSection,EvidenceSection,AiDecisionBrief,DecisionHistory}.tsx` |
| Draft store | `frontend/src/store/decisionDraft.ts` |
| Saved ids | `frontend/src/store/savedRefs.ts` |
| Hooks | `frontend/src/hooks/{useDecision,useBriefing,useDecisionBrief,useStore}.ts` |
| Types | `frontend/src/types/{decision,decisionBrief,comparison,risk,store}.ts` |
| Routers | `backend/app/routers/{decision,briefing,decision_brief,store}.py` |
| Services | `backend/app/tpo/{decision,briefing,decision_brief}.py` |
| OpenAI client | `backend/app/agents/client.py` (shared; reads `backend/.env`) |
| Persistence | `backend/app/store/{repository,db,fingerprint}.py` |
| Report adapter | `backend/app/reports/adapters.decision_center` |
| Tests | `test_decision_record.py`, `test_decision_center_sections.py`, `test_decision_brief_ai.py`, `test_decision_briefing.py`, `test_decision_journey.py`, `test_store_persistence.py`, `test_saved_decision_label.py`, `test_upstream_truthfulness.py` |

## 14. Known limitations

| # | Limitation |
|---|---|
| 1 | **No approval workflow.** `can_be_approved` is always `false`; no criteria exist to build one against. Approval reads **Not configured** |
| 2 | **No execution / write-back.** Nothing is written into the Calendar, `fact_sales`, `dim_promotion` or any CSV. Execution reads **Not configured** |
| 3 | **No approver, no author, no notification.** No identity provider exists; the briefing states this on the page |
| 4 | `owner` is `null` on every stored record |
| 5 | `POST /api/decision/record` persists nothing; storage is a separate explicit action |
| 6 | Storage is **unauthenticated** — anyone who can reach the process can store a decision, append versions to records they did not create, and read every stored decision. Safe on single-user localhost, **not** on a shared deployment |
| 7 | The Strategy section's **Current** column and the **Scenario Comparison** need the baseline and comparison payloads. Reaching Decision Center without them leaves both stating their reason rather than showing values |
| 8 | Only `discount_pct` carries a **Recommended** value — the decision policy chooses a scenario, not a lever setting |
| 9 | Decision History has no filter, search or pagination beyond the endpoint's `limit` |
| 10 | The AI Decision Brief needs `OPENAI_API_KEY` in `backend/.env`. Without it that one card is unavailable and **everything else works unchanged** |
| 11 | The brief is **not persisted**. It is regenerated on request and is not stored with the decision, not included in the saved record and not carried into the report or the briefing artifacts |
| 12 | `unverified_figures` is a string match over numbers, not a semantic check. It catches an invented figure; it cannot catch a correct figure described wrongly. The deterministic cards remain the authority |
| 13 | The brief is generated in one call with no streaming, so a slow model shows a spinner on that card until it returns |
