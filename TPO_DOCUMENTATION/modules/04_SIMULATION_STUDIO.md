# Module 04 — Simulation Studio

**Route:** `#/simulation` · **Page:** `frontend/src/pages/Simulation.tsx`
**Service:** `backend/app/tpo/studio.py` · **Router:** `backend/app/routers/simulation.py`
**Status:** Implemented — rebuilt 2026-09-22, replacing the earlier three-mode studio

## 1. The question

> *"If I run this scope at discount **d**, with a trade-spend budget **S**, for
> **N** days — what happens to Revenue and to ROI over those N days?"*

Three sliders, two answers. Every other control the earlier studio carried —
the three named scenarios, the mode switch, General Optimization, Target
Rescue, the comparison table, the recommendation policy, the risk panel and
the Decision Center hand-off — is gone. The page is the three levers, the two
result tiles, a week-by-week chart and a discount-depth curve.

```
┌─ Scope: Year · Channel · Category · Brand · Product · More filters · ₹/$ ──────────┐
│                                                                                    │
│  Discount      ●────────────   12.0 %                                              │
│  Trade spend   ──────●──────   ₹4.2 Cr   Funds 71% of the scope · budget binding   │
│  Days          ───●─────────   14 days   2 business weeks                          │
│                                                                                    │
│  REVENUE · 14 days   ₹56.3 Cr → ₹49.5 Cr    ▼ −₹6.8 Cr (−12.0%) vs current plan    │
│  ROI · 14 days       1.50 → 1.46            ▼ −0.04   [Profitable · above 1.00]    │
│                                                                                    │
│  Revenue by week: no promotion · current plan · scenario, every bar labelled        │
│  What each discount depth would do: Revenue and ROI curves, break-even marked       │
└────────────────────────────────────────────────────────────────────────────────────┘
```

## 2. What each lever physically does

| Lever | Effect in the engine |
|---|---|
| **Discount** | Sets the promoted price `P(1 − d)` and, through the fitted lift curve, the volume uplift. Continuous in steps of 0.5 pt, bounded by the deepest depth the data shows plus 5 points. |
| **Days** | The window, 1 to `min(MAX_DAYS, evidence_max)` — a 30-day planning cap and, under it, the longest run any promotion in the data actually holds (`evidence_max_days`, measured the same way the observed plan's median run is). `N/7` business weeks; a partial last week is pro-rated by its fraction, because the dataset is only knowable at week grain. A week-in-promotion fade and a post-promotion dip are both estimated from the data and applied **only when detected**. |
| **Trade spend** | The budget. Discount and days set what promoting the whole scope for the window would cost (the engine's Trade Spend on those rows); the budget sets how much of the scope can be funded: `coverage = min(1, S / full_cost)`. The uncovered share trades at its ordinary level. Spend is therefore still an *output* of the promotion arithmetic — the slider decides how much of the scope that arithmetic applies to, never the arithmetic itself. |

**The budget slider's track is derived, not the scope's ceiling.** `/scope`
reports the absolute worst case — the deepest depth over the longest window,
priced at the top of the band — which at a 7-day plan costing ₹81.35 L left
seven eighths of the travel beyond full coverage, where dragging changed
nothing but the unspent figure. The page runs the track to a quarter past the
*live* full-coverage cost instead, so the binding range is most of the travel.
It never ends below the budget already settled: the budget is the one lever
that is a constraint the reader brings, so shortening the window makes it
generous rather than confiscating it.

**Optimize** appears only while a product carried in from Promotion
Intelligence is the selection. Each lever card carries a tick: a ticked lever
is free to vary from its minimum up to where its slider sits — the slider is
the ceiling, so moving it widens or narrows the range — and an unticked lever
is held. The button is off, with the reason in its tooltip, until at least
one lever is ticked with a range above zero. The answer comes back as a card
beside the sliders (searched ranges, now vs best for each lever, ROI, revenue
and spend at both, with the engine's own delta); **Apply** moves the sliders
there, and until then they are untouched. The page searches nothing itself.

While that card is up **the exploration deck stands down** — the two result
tiles, the week chart and the depth curve are hidden. The reader arrived with
a question rather than an exploration, and the card already carries the
figures on both sides of the move; four more panels underneath, all still
showing the position Optimize has just superseded, would leave them working
out which numbers are the answer. The deck returns the moment it is useful
again: on **Dismiss**, on **Apply**, and as soon as any slider moves (the card
says it has gone stale, and hiding the charts would stop the reader seeing the
move they just made). A scope with no product carried in never hides it,
because Optimize does not appear there at all.

A consequence worth stating: **the budget scales a promotion; it does not
change its economics.** Halving the budget halves Trade Spend and Incremental
Sales together, so ROI is unchanged and Revenue falls. That is the honest
answer with this data — nothing in it ties extra spend to extra lift.

## 3. KPI formulas are untouched

The studio computes no KPI. It decides which rows exist in the window and what
quantity each carries, then hands those rows to `app/tpo/aggregate.py` — the
same functions the Insights Hub cards call:

| Figure | Function |
|---|---|
| Revenue | `Sum(Actual_Revenue)` via the engine's own reducer (the numerator of `calculate_margin`) |
| Trade Spend | `calculate_trade_spend` — `Sum(Base_Revenue − Actual_Revenue + Promotion_Cost)` |
| Incremental Sales / Units | `calculate_incremental_sales` / `calculate_incremental_quantity` |
| ROI | `calculate_roi` — IS ÷ TS, a multiple at two decimals; 1.00 is break-even |
| Margin | `calculate_margin` |

`tests/test_studio.py::test_the_studio_defines_no_kpi_of_its_own` asserts the
module contains no division of its own and calls those four functions;
`test_roi_on_the_payload_is_incremental_sales_over_trade_spend` asserts the ROI
on every payload is exactly IS ÷ TS of the same payload.

The window is measured with the two-set call the earlier weekly decomposition
used: `rows` is the window; `volume_rows` is the scope's own non-promoted rows
plus the window's, so the baseline the engine derives is the very one the
templates were built from and Incremental Sales reconciles by construction.
Each week is measured on its own the same way, so the weekly revenues sum to
the window's exactly.

## 4. The lift model

A response curve **fitted to the promoted rows the dataset holds**. For each
promoted `(product, channel, week, offer)` row: the observed depth
`d = discount_value / list_revenue` and the observed uplift
`u = actual_quantity / (baseline × transactions) − 1` against that
`(product, channel)`'s non-promotional baseline — the rule `aggregate._volume`
applies, stated identically (`test_the_baseline_rule_is_the_engines`). Then a
weighted least-squares fit of

```
log(1 + u) = b1·d + b2·d²        (through the origin: no discount, no lift)
```

The quadratic term lets the curve saturate, which the data shows it does
(`log(1+u)/d` falls from ~3.3 at 5% to ~2.2 at 25%). **The band is the
10th–90th percentile of the residuals** — what the evidence itself scattered
by, not an assumed confidence interval — and every result carries low / mid /
high.

| Fallback | When |
|---|---|
| `fitted` | The scope holds ≥ 40 promoted weeks across ≥ 2 depths |
| `fitted_dataset_wide` | It does not; the whole dataset does |
| `approved_rules` | Neither does; the curve is drawn through `config.TREATMENT_RULES`' bands |

`model.provenance` names which one on every response, with `n_events`,
`n_depths`, `r_squared`, the observed depth range and the slider's domain.

**Fade and dip are findings, not assumptions.** The depth-adjusted residual is
regressed on week-in-run (fade) and the week after a run is compared with
baseline (dip); either is applied only when |t| ≥ 2, and the model's notes say
so either way. On the shipped dataset: no dip (+0.2% ± 6.4%, n = 6,264) and,
scope-wide, a fade of −0.2% per week (t = −3.1) that is applied because it is
what the data says.

**Calibration to the scope.** Whatever curve was chosen, its depth term is
scaled (`LiftModel.scale`, bounded 0.25–4) so that at the depths the scope
actually ran it reproduces the lift the scope actually measured — the ratio of
observed to fitted log-lift over the scope's own promoted weeks, weighted by
transactions. A scale rather than a shift, so no discount still means no lift
and shallow depths are never pushed below the ordinary level. This is what
makes the studio's current plan agree with the measured figures the other
modules show (`test_the_current_plan_reproduces_what_the_scope_measured`).
`model.calibration` carries the scale and the event count.

The model is memoised per `FilterState` (`studio.lift_model`) and cleared with
the row caches when a dataset is installed (`app/star_dataset.py`).

## 5. What it does not invent

- No display or feature effect — no data carries one.
- No cannibalization response — the approved rules define none.
- No daily distribution inside a week; no seasonality for a window with no
  calendar position.
- No forecast, no probability, no confidence score.

## 6. Endpoints

### `POST /api/simulation/scope`
Body `{ filters, currency }`. Returns the scope's measured history (revenue,
trade spend, incremental sales, ROI), the observed plan (spend-weighted average
depth, typical run length), each lever's `{min, max, step, default}` and the
lift model. The defaults are the current plan — its depth, its typical days,
and what that costs at full coverage — so the page opens with every delta at
zero. They are **exact**, not rounded to the sliders' steps: the discount
default is the observed depth itself, so the header and the lever cannot
disagree, and the budget default is the plan's own cost, so the studio opens
funding the whole scope with nothing unspent. The budget slider's step is
nudged to divide that default, because a native range input snaps its thumb to
`min + k · step`. **422** with `Nothing to simulate` when no product-channel in
scope has a non-promoted week to base a scenario on.

### `POST /api/simulation/simulate`
Body `{ filters, currency, discount_pct, trade_spend, days }`; `extra="forbid"`.
Returns `baseline` (no promotion), `current_plan` (the scope's observed depth
at full coverage over the same window) and `scenario`, each with revenue,
units, trade spend, incremental sales / units, ROI, margin and a low/high
band; `deltas` (revenue absolute and percent, ROI absolute, each with a
direction; the scenario's ROI status `profitable | break_even | loss_making |
not_applicable`); `levers.trade_spend` (requested, consumed, full-coverage
cost, coverage, binding, unspent); `window`; `weekly`; `model`; `method`.

Each `weekly` entry carries that week's baseline, current-plan and scenario
revenue, the scenario's low/high band and its trade spend, both ROIs, and
`incremental_vs_baseline` — the scenario's revenue less the no-promotion
baseline, so the chart can annotate the gap it draws rather than the page
subtracting two figures of its own.

**422** with a reason for a depth outside the model's domain, a window outside
1–`MAX_DAYS` days, a negative budget, an unknown lever, or nothing to simulate. Never
a zeroed result.

### `POST /api/simulation/optimize`
Body `{ filters, currency, discount_pct, trade_spend, days, vary }`, where
`vary` maps a lever to the **top** of its range (every range starts at the
lever's minimum) and a lever not named is held at the value given. One
product at a time — it is the Promotion Intelligence hand-off's tool — and a
wider scope, an empty `vary` or an unknown lever is a **422**.

Returns `best` (the levers, their figures, the ROI status and which levers
`changed`), `from` (the baseline levers and their figures), `gain` (the same
delta block `simulate` reports), `searched` (each range and how many
positions were priced) and `already_optimal`.

**`from` is the current plan for any lever being searched.** That lever's
slider is the top of its range, so its position says how far to look, not
where the plan stands; taking the baseline from it compared the answer
against wherever the handle happened to be left while the range was set up.
A *held* lever's baseline is the value it was held at, because that is what
the search actually kept it at.

The objective is lexicographic, and has to be: the budget only scales a
promotion, so ROI is identical at every budget, and days only scale it unless
a fade or dip is fitted. It maximises ROI **at the two decimals the page
shows**; among ties the higher revenue; among those the lower spend. That
turns "any budget" into *fund the whole scope and no more*, and "any length"
into *the longest window still earning this ROI*. The search is exhaustive —
every slider step of discount, every whole day, and the budget analytically
(the smaller of the ceiling and the full-coverage cost, since nothing above
it changes the figures and nothing below it can win) — and every point is
priced by the same engine `simulate` uses.

### `POST /api/simulation/curve`
Body `{ filters, currency, trade_spend, days }`. Revenue and ROI (each with
low/high) at every depth the slider allows in 2.5-point steps, plus the
current plan's depth, holding the budget and window fixed — each point is the
same arithmetic `/simulate` runs at that depth, nothing interpolated. Keyed by
the page on budget and days only, so dragging the discount slider moves a
marker along a curve already on screen.

## 7. Frontend

| Concern | File |
|---|---|
| Page | `frontend/src/pages/Simulation.tsx` |
| Sliders, result tiles, chart | `frontend/src/components/studio/{LeverSlider,ResultStrip,WindowChart}.tsx` |
| Hooks | `frontend/src/hooks/useStudio.ts` — `/scope` as a query; `/simulate` as a query keyed on the debounced levers with `placeholderData`, so dragging back to a visited value is instant and the tiles never blank between ticks |
| Types | `frontend/src/types/studio.ts` |
| Scope | The studio's own filter store (`store/studioFilters.ts`, a second instance of the Insights Hub's store shape), edited by the shared `FilterBar` in its `studio` layout: Year, Channel, Category, Brand and Product on the bar; Retailer and geography behind "More Filters"; no Month, Offer or Promotion Type |
| Hand-off | Promotion Intelligence's **Go to Simulation** (beside "Go deeper") calls `carryProductToStudio` (`store/studioHandoff.ts`): it applies the investigation's scope to the studio's filters — **year, channel, category, brand, product, the offer (promotion) and any geography** the scope names — and records the hand-off. Year and offer are carried on purpose: the investigation's figures are one year's, one promotion's, and the studio's "Measured" line must show the same ones (it does — same engine, same rows). The offer is not on the studio's bar, so the banner names it: "From Promotion Intelligence · *product* · *offer* · F25". "Show all products" — or clearing the product from its dropdown, which also drops the hidden offer — returns the studio to its ordinary state. The studio's filters and hand-off persist per tab (sessionStorage) so a reload keeps them |
| Measured vs modelled | The scope line shows the scope's **measured** trade spend, incremental sales and ROI (the Insights Hub's / Promotion Intelligence's figures, from the same engine). The lift curve is **calibrated to the scope** (§4), so the studio's current plan — the observed depth replayed over the observed run length — reproduces those measured figures; for the investigated Dussehra Deal 25 event the current plan returns ₹81.4 L / ₹78.4 L / 0.96 exactly. Where they still differ (a scope whose promotions ran at several depths), the ROI tile says so in one line |
| No ranges | The page shows no low–high ranges anywhere — tiles, charts, tooltips, the lift note and the export all carry one figure per quantity. The band still exists in the payload (`band`, `lift.low/high`, the curve's `*_low/_high`) for any consumer that wants it |
| Curve chart | `components/studio/CurveChart.tsx` — Revenue and ROI at every depth (`/curve`), the scenario as a marker on the curve, the current plan's depth as a reference line, break-even drawn on the ROI panel |

Every string on screen is the payload's `display`; the client subtracts,
divides and rounds nothing.

## 8. Add to Decision Center

The header's **Add to Decision Center** snapshots the scenario on screen —
scope label, currency, the three lever values and the KPI rows as displayed
— into `store/decisionScenarios.ts`, where Decision Center shows up to three
side by side. The button is disabled, with the reason as its tooltip, while
the result is still resolving, when the same scenario (same scope, currency
and levers) is already there, and when three are held. A "n/3 in Decision
Center →" link appears once anything has been added.

## 9. Export

`module: "simulation-studio"` → `adapters.simulation_studio`, which calls
`studio.simulate` with the three lever values the page was holding. Sections:
levers, the window result table (baseline / current plan / scenario with low
and high), scenario vs current plan, week by week, the lift model's notes and
the method.

## 10. What was removed, and what still reads the old payloads

Removed: `app/tpo/{simulation,scenarios,execution,comparison,recommendation,
weekly,risk,investigation,optimization,rescue,response}.py`, the eleven
routes they served, `components/{simulation,optimization,rescue}/`, their
hooks, stores and types, and their tests.

Decision Center, the decision briefing and the durable store were built on the
earlier studio's payloads and still read them from stored records.
`app/tpo/decision.py` keeps the KPI and lever keys it needs inlined
(`LEGACY_KPI_KEYS`, `LEGACY_LEVER_META`); the tests that used to walk the old
journey load `tests/fixtures/legacy_journey.json` — one journey captured from
the endpoints before they were removed — through `tests/legacy_journey.py`.
Decision Center was later rebuilt around the studio's own scenarios (see
modules/05).

## 11. Known limitations

1. The budget cannot change ROI (§2) — by design, not by omission.
2. Days below seven are a pro-rata of one business week.
3. A depth beyond the observed maximum + 5 points is refused, not extrapolated.
4. The fitted curve is per scope with dataset-wide and rule fallbacks; a scope
   whose promotions all ran at one depth borrows the dataset's curve.
5. A scenario sent to Decision Center is a snapshot of display strings; it does not follow later slider moves.
