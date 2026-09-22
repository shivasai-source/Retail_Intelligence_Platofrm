# Module 02 — Investigations / Root Cause Analysis

**Route:** `#/investigations` · **Page:** `frontend/src/pages/Investigations.tsx` (361 lines)
**Status:** **Static content + a real scope hand-off**

> **Read this first.** The causal graph, node details, accelerators, progress
> percentage, confidence figures and context chips on this page are **authored
> JSON**, not analysis. the investigation payload states it
> plainly: *"the RCA layer is entirely static… One of those chips reports a
> trade spend of ₹98.6 Cr for a scope the validated engine measures at ₹7.7 Cr."*
>
> What **is** real: the scope that arrives from the Command Center, and the
> contract that carries it forward to Simulation Studio while refusing to let
> any RCA figure enter a calculation.

## 1. The workflow, and where it is real

```
Command Center                                    [REAL]
   │  risk alert / underperforming row clicked
   │  → InvestigationScope { filters, origin, identifiers, labels }
   ▼
Investigations                                    [STATIC BELOW THIS LINE]
   │  type inferred from the query text
   │  causal graph, accelerators, node details rendered from JSON
   ▼
Root Cause Analysis        authored `nodeDetails`
Evidence                   authored `evidence` strings
Explanation                authored `headline` / `body`
   │
   ▼
Simulation Studio                                 [REAL AGAIN]
   POST /api/simulation/context validates the hand-off field by field
```

## 2. Investigation inputs

### From the Command Center (real)

`store/activeInvestigation.InvestigationScope`:

```ts
{ filters,        // the validated Command Center FilterState, copied
  origin,         // 'risk_alert' | 'underperforming' | 'query'
  label,          // what the user clicked
  identifiers,    // ONLY codes the source genuinely provided
  labels,         // display-only; never converted into codes
  at }
```

| Origin | Narrows by |
|---|---|
| `risk_alert` | `promotion_id`, `product_id`, `channel_id` |
| `underperforming` | `promotion_id`, `product_id`, `channel_id` |
| `query` | nothing — the user typed a question |

Neither can narrow to a week: `FilterState` has no week dimension.

### From the query bar (real input, static consequence)

`inferType(q)` — keyword matching on the typed question:

| Pattern | Type |
|---|---|
| `optimi[sz]e`, `maximi[sz]e`, `best plan`, `allocat`, `improve roi`, `lever` | `optimization` |
| `launch`, `new sku`, `new product`, `prioriti[sz]e` | `launch` |
| `portfolio`, `channel mix`, `strategic`, `fy26`, `long-term`, `growth budget`, `rebalance` | `strategic` |
| *(otherwise)* | `diagnostic` |

The inferred type selects **which authored JSON block to render**. It does not
run an analysis.

### Page controls (cosmetic)

`PROMO_OPTIONS`, `PERIOD_OPTIONS`, `LAYOUT_OPTIONS` are **hardcoded arrays in
the page** ("South MT Push (Apr – Jun)", "Q1 FY25", "Radial", …). They are
ported dropdown chrome and drive nothing.

## 3. The four investigation archetypes

`GET /api/investigation-types` → `investigation-types.json`:

| Key | Title | Badge | Purpose | Stated duration |
|---|---|---|---|---|
| `diagnostic` | Diagnostic | POST-MORTEM | Understand **why** a past or in-flight promotion underperformed | ~5–8 min |
| `optimization` | Optimization | IN-FLIGHT | Maximize ROI of an active or upcoming promotion through TPO levers | ~6–10 min |
| `launch` | Launch Planning | FORWARD-LOOKING | Plan a new product launch or major campaign | ~7–12 min |
| `strategic` | Strategic Review | LONG-TERM | Quarter/portfolio-level review | — |

Each carries four **example questions**. Those examples matter downstream — see
§7.

The stated durations are authored copy; nothing measures or enforces them.

## 4. What is rendered (all static)

`GET /api/investigations/{type}` → `investigations.json.orchestrations[type]`:

| Key | Shape | Example content |
|---|---|---|
| `center` | `{label, sub}` | `"South MT Push"`, `"(Apr – Jun 25)"` |
| `contextChips` | `{period, channel, region, spend}` | `"₹98.6 Cr"` ← **contradicts the engine** |
| `nodes` | 8 items | `{key, label, metric, delta, trend, impact, icon, pos:{x,y}}` |
| `accelerators` | 6 items | `{key, name, desc, status, icon, tone, node}` |
| `progress` | `{completed, total, pct, insights, sources}` | `7/8`, `88%`, 16 insights, 24 sources |
| `nodeDetails` | keyed by node | `{headline, body, evidence, …}` |

Rendered by:

| Component | Renders |
|---|---|
| `InvestigationGraph` + `graphLayout.ts` | The radial causal graph; node positions come from the JSON's own `pos` |
| `NodeDetailPopover` | `nodeDetails[key]` in a side popover |
| `AccelList` | The six "accelerators", with a staged multi-agent **build choreography** driven by `useEffect` timers |
| `ProgressStrip` | The authored `progress` block |
| `BizQuestionCard` | The active question |
| `QueryBar` | Free-text input + type inference |
| `ActiveInvBanner` | The active investigation banner, shared with Intelligence / Simulation / Decision |

**None of the metrics, deltas, impacts, evidence strings, progress percentages,
insight counts or source counts is computed.** The accelerator "Completed"
statuses and the staged animation are choreography, not work.

`GET /api/investigations/legacy` serves the pre-multi-type block, kept for
fidelity with the predecessor app.

## 5. Active investigation state

`store/activeInvestigation.ts`, persisted to `localStorage` under
`tiq.activeInvestigation`. Holds `activeType`, `activeQuestion`, a recent `list`
(max 8), and the Command Center `scope`.

It carries across all four investigation-linked pages (Investigations,
Promotion Intelligence, Simulation Studio, Decision Center) — exactly as the
predecessor app's `window.getActiveInvType()` globals did.

Its default question is hardcoded:

```
"Why did South Modern Trade Push underperform despite increased trade spend?"
```

which is also `diagnostic`'s seeded example. That collision is deliberate and
handled — see §7.

## 6. RCA → Simulation hand-off — **implemented, with honest gaps**

`POST /api/simulation/context` (removed 2026-09-22 with the old Simulation Studio) was **contract
plumbing only**. It runs no scenario, computes no KPI, and does not touch
`/run` or `/simulate`.

Every field comes back stamped with a **provenance**:

| `source` | Meaning |
|---|---|
| `rca` | Genuinely supplied by the investigation |
| `command_center` | Came from the Command Center's validated state |
| `filter_state` | Derived from the scope itself |
| `seed_example` | Matches a seeded example — **not** something the user asked |
| `unavailable` | No system in this project supplies this field |

### What crosses the boundary

| Field | Status |
|---|---|
| `filters` | **Real** — the one `FilterState` |
| `question` | Real **only if** `investigation_started` is true and it is not a seeded example |
| `investigation_id` | **`unavailable`** — nothing in the investigations router, its data files or its client state assigns one |
| `investigation_type` | Optional, carried |
| `problem_statement` | **`unavailable`** — RCA's node details are authored display copy, not a structured statement |
| **Any KPI value, trade spend or ROI** | **Never.** Not accepted, not carried |

### Three rules the contract enforces

1. **No invented question.** `activeInvestigation` seeds itself with an example
   copied from `investigation-types.json`, and a user who has never run an
   investigation still carries it. A context built from that seed would put an
   authored sentence in front of the user as though they had asked it. The
   seeded examples are known — they are in the same JSON — so a matching
   question is reported as `seed_example`.

2. **No static KPI as a simulation input.** The scope travels as a
   `FilterState` and Simulation **measures it for itself**, through the same
   engine the Command Center uses. This is the rule that keeps the ₹98.6 Cr
   context chip out of every calculation.

3. **No second filter model.** RCA's context chips are display strings —
   "Modern Trade", "Apr - Jun 2025" — and are **not** converted into filters.
   A conversion that guessed at codes from labels would be a second filter model
   wearing a disguise.

Tested, until its removal, by `tests/test_investigation_context.py`, which the module
describes as being *"about what it REFUSES to do"*, and
and `tests/test_investigation_handoff.py` covered the half a server can
prove.

## 7. Navigation

- **In:** `#/command` (alert or table click), or direct navigation.
- **Out:** `#/intelligence` (same active type), `#/simulation` (the hand-off),
  and onward to `#/decision`.
- The active type and question travel through the persisted store, not through
  the URL.

## 8. Reports

**No report is generated from this module.** It is absent from
`reports.service.MODULES`, correctly — there is no computed dataset behind it.

## 9. Known limitations

| # | Limitation |
|---|---|
| 1 | The causal graph, node metrics, evidence, progress and confidence figures are **authored JSON** |
| 2 | `contextChips.spend` reports **₹98.6 Cr** where the engine measures **₹7.7 Cr** for the same scope |
| 3 | **No investigation identifier exists.** A simulation cannot be traced back to the investigation that prompted it. `investigation_id` is `null` with the reason, and the field exists so the contract will not change shape when one arrives |
| 4 | **No structured problem statement exists** |
| 5 | The staged accelerator "analysis" is a timer-driven animation |
| 6 | `PROMO_OPTIONS` / `PERIOD_OPTIONS` / `LAYOUT_OPTIONS` are hardcoded and drive nothing |
| 7 | The hand-off cannot narrow to a week, by design (`FilterState` has no week) |

## 10. File map

| Concern | File |
|---|---|
| Page | `frontend/src/pages/Investigations.tsx` |
| Components | `frontend/src/components/investigations/*` (8 files) |
| Store | `frontend/src/store/activeInvestigation.ts` |
| Hooks | `frontend/src/hooks/useInvestigations.ts` |
| Types | `frontend/src/types/{investigation,orchestration,investigationContext}.ts` |
| Router (content) | `backend/app/routers/investigations.py` |
| Router (hand-off) | `backend/app/routers/simulation.py` → `POST /context` |
| Contract | *removed 2026-09-22 — the studio takes its own scope* |
| Data | `backend/app/data/{investigations,investigation-types,focus}.json` |
| Tests | `backend/tests/test_studio.py` |
