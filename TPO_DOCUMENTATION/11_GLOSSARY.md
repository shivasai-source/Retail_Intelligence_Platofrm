# 11 — Glossary

Terms as **this project** uses them. Where a term has a formula, it is the one
in `backend/app/tpo/aggregate.py`.

---

**Approved treatment / Approved promotion treatment rule**
One of five entries in `config.TREATMENT_RULES` mapping a discount depth to the
uplift **band** it is approved to produce: PR001 5%, PR002 10%, PR003 15%,
PS001 20%, PB001 25%. These are the design parameters the dataset was generated
under, verified against the live file — **not** an elasticity, a model fit, an
ML prediction, an MMM estimate or a forecast.
`response.PROVENANCE = "Approved TPO promotion treatment rule"`.

**Approved uplift range / band**
The `low`–`high` uplift a treatment is approved to produce (e.g. PR003 = 40–50%).
Carried **whole**; never collapsed to a midpoint. Labelled
`RANGE_LABEL = "Approved uplift range"`. **Not a confidence interval, not
statistical uncertainty, not model confidence.**

**At Stake**
`max(Trade Spend × 1.50 − Incremental Sales, 0)` — the additional incremental
revenue a promotion event needs to reach the 50% ROI target. Written as the
inversion of the ROI definition, not as a literal 1.5. Never negative. The
primary ranking key for risk alerts and the underperforming table.

**Baseline**
`mean(Base_Quantity)` over a product's **non-promoted** rows **in that channel**,
inside the current filter selection. The counterfactual every uplift is measured
against. It moves with every filter — reported unrounded to 4 dp in `debug` so
nobody mistakes it for a constant.

**Brand Form**
`dim_product.Brand` — the product family that four pack sizes share (e.g.
"Laundry Detergent", "Taped Diapers"). Nine of them. The boundary within which
cannibalization is measured. Exposed as the `brand` filter dimension.

**Business week**
The week ordinal the dataset numbers for itself (`fact_sales.Week`), resolved to
calendar days through `dim_date`. The finest analytical grain this project
supports; `fact_sales.Date` is scrambled on three channels and is not used.

**Cadence**
A channel's promotion planning rhythm: **WEEKLY** (CH001, CH004) or **MONTHLY**
(CH002, CH003, CH005). Declared once in `promo_calendar.CADENCE` — the project's
stated channel structure, deliberately not inferred from the transaction
pattern. Agrees with `fact_sales.Schedule`.

**Cannibalization**
`Total Cannibalized Quantity ÷ Promotional Incremental Quantity × 100` — the
share of a promotion's extra volume taken from the pack sizes immediately either
side of it in the same Brand Form. Only losses count; a neighbour trading above
its baseline was not cannibalized.

**Cannibalization Score**
A 0–100 bucketed rating of the rate (≤5% → 100, ≤10% → 90, ≤20% → 75, ≤30% → 60,
≤50% → 40, above → 20). Lower rate = higher score. Not a PEI component.

**Checkpoint** *(Target Rescue)*
A **completed business week**, not a day. `"auto"` follows the channel's
cadence — the latest completed week for a WEEKLY channel, the mid-month week
(`MONTHLY_CHECKPOINT_WEEK = 3`) for a MONTHLY one. `"latest"`, or an explicit
week ordinal. A week the month does not contain is **rejected**, never clamped.

**Clearance mechanic** *(Target Rescue)*
An approved treatment whose promotion-master name is **not** a percentage —
i.e. a mechanic rather than a price discount. The master holds exactly one:
`PB001 = "Buy3Get1"`, at 25%, which is also the deepest approved depth. Buy2Get1
is never offered, because fabricating an uplift and a cost for it is the one
thing this must not do.

**Command Center**
The measurement module. Six KPI cards, a trend, risk alerts, two tables and six
chart sections over one `FilterState`.

**Decision record**
The read-only artifact `POST /api/decision/record` assembles from a context, a
simulation, a recommendation, a risk assessment and (optionally) a weekly
decomposition. **An assembly, not a calculation** — nothing is recomputed. Always
a draft: `can_be_approved` is `false` in every record.

**Decision briefing**
The portable form of a decision record — `briefing.json` plus a self-contained
`briefing.html` the browser can print to PDF. States on every page that it is a
draft, not approved, not saved, and names no author or approver.

**Evidence floor** *(cannibalization)*
`CANNIBALIZATION_MIN_EVENTS = 3`. Below three comparable promotion events the
rate is reported unavailable, because a share computed over one or two events is
not a rate.

**F24 / F25**
Display labels for calendar years 2024 and 2025 (`formatting.fiscal_label`).
**Display only** — the calculation, the filter and the stored data all use the
real year. April–March fiscal semantics are **not** implemented; `dim_date`'s
`Quarter` is calendar.

**FilterState**
The one frozen, hashable filter contract over 14 dimensions
(`app/tpo/filters.py`). Every Command Center endpoint and every simulation mode
resolves the same object.

**General Optimization** *(removed 2026-09-22)*
Simulation Studio mode B. Allocates a trade-spend budget across a category,
channel and month by choosing one approved treatment per candidate product.
Maximises revenue at `uplift_low` subject to spend at `uplift_high` staying
inside the ceiling.

**Governance gap**
A boundary this project has **not** approved — a budget ceiling, a margin floor,
a cannibalization limit, a PEI floor, a maximum discount or duration. Reported
as a named gap (`risk.UNDEFINED_THRESHOLDS`) rather than filled in with a
plausible number.

**Incremental Quantity**
`Σ over promoted rows of (Actual_Quantity − baseline)`. May be negative; not
clamped.

**Incremental Sales**
`Σ over promoted rows of (Actual_Quantity − baseline) × Actual_Price`, each row
valued at its **own** price. The single source of truth for incremental revenue.

**Investigation Simulation**
Simulation Studio mode A. The measured Current Plan for the scope, plus what an
approved treatment would do to it.

**Mechanic**
`dim_promotion.Promotion_Name` — "5% Discount", "20% Discount", "Buy3Get1".
**Not unique**: seven rows share "20% Discount". Exposed as the
`promotion_mechanic` breakdown dimension, whose groups carry the member
`Promotion_Id`s.

**Margin Impact**
`Σ(Actual_Revenue − Total_Cost) ÷ Σ(Actual_Revenue) × 100` — one ratio of summed
revenue and cost, never an average of per-row margins.

**Normal** *(promotion type)*
`dim_promotion.Promotion_Type` for `Promotion_Id = -1`, the not-promoted marker.
The other two types are Regular and Seasonal.

**Optimization**
In this project, historically the **General Optimization** budget allocation —
an exact multiple-choice knapsack over discrete approved depths. Note that the
Investigation Simulation's "Optimized Plan" scenario is a **label, not a claim**:
nothing makes it better than the Current Plan, because nothing evaluates either
until it is run.

**P1 / P2 / P3 / P4**
Not project terminology. The pack-size positions inside a Brand Form are called
**ranks 1–4** (`Product.rank`), derived from the leading number in `Size`.
Rank 1 is the smallest pack and is never promoted in this data.

**PEI — Promotion Efficiency Index**
`0.40 × ROI + 0.30 × Incremental Qty % + 0.30 × Margin Impact`, each component
normalised onto 0–100 against its ceiling. A missing component's weight is
redistributed. `null` when nothing in the selection was promoted.

**Promotion event**
The grain risk alerts, the underperforming table and cannibalization report at:
one `(product, channel, business week, offer)`. Different offers are never
merged — a week running both a 5% and a 10% promotion is two events.

**Promotion lift / uplift**
`u` — the fractional volume increase an approved treatment is rated to produce.
Always a band, never a point.

**Provenance**
A stamp travelling with a value saying where it came from. Two uses:
`response.PROVENANCE` on every simulation payload, and the RCA context contract's
per-field `source` ∈ `rca`, `command_center`, `filter_state`, `seed_example`,
`unavailable`.

**RCA — Root Cause Analysis**
The Investigations module. In this repository its causal graph, node details,
progress and confidence figures are **authored JSON**; only the scope hand-off
into Simulation Studio is real.

**Regular promotion**
`Promotion_Type = "Regular"` — the year-round mechanics PR001/PR002/PR003
(5% / 10% / 15%).

**Report artifact**
The stored `.xlsx` or `.pdf` bytes belonging to one generated report, held as a
BLOB in the `reports` row. A **derived** artifact — regenerable from its stored
scope, and therefore deletable, unlike the append-only scenario and decision
history.

**RGM — Revenue Growth Management**
The commercial discipline this application serves: managing price, promotion,
mix and trade investment to grow revenue and margin.

**Risk alert**
A promotion event whose ROI is below the 50% target and whose Trade Spend is
positive, banded Critical / High / Medium and ranked by At Stake.

**ROI — Promotion ROI**
`(Incremental Sales − Trade Spend) ÷ Trade Spend × 100`. `null` — never zero,
never infinite — when nothing was spent. Target 50%.

**Run-rate projection** *(Target Rescue)*
Month-to-date units ÷ days the completed business weeks cover, extended over the
days all the month's business weeks cover. **Division, not a forecast** — the
label is `RUN_RATE_LABEL` and no model stands behind it.

**Scenario**
A named lever set over the simulation context. Exactly one — Current Plan — is
`measured`; the rest are `hypothetical`, and carry `result: null` until an
execution actually produces one, at which point their status becomes
`simulated`.

**Seasonal promotion**
`Promotion_Type = "Seasonal"` — the twelve dated festival offers (New Year,
Holi, Summer, Independence, Dussehra, Diwali × 2024/2025), plus the two generic
seasonal masters PS001 and PB001 (which do not appear in the fact table). Every
2024 seasonal event is a 20% price discount; every 2025 one is Buy3Get1.

**Simulation**
Execution of one hypothetical scenario: an approved discount resolves to a
treatment, counterfactual `WeekRow`s are synthesized at each end of its uplift
band, and the **existing validated KPI engine** reads them. No KPI is computed in
the simulation service.

**Target Rescue** *(removed 2026-09-22)*
Simulation Studio mode C. Assesses a month's unit target at a completed-week
checkpoint and recommends the **least aggressive** approved intervention that
recovers it. Recommends only — it creates nothing and activates nothing.

**Trade Spend**
`Σ (Base_Revenue − Actual_Revenue + Promotion_Cost)` — both halves of the
promotional investment: the price cut given away, plus the promotion cost
ledger.

**Trade Spend Efficiency (TSE)**
`Incremental Sales ÷ Trade Spend × 100`. Equals `ROI + 100` by definition, which
is why it is deliberately **not** a PEI component.

**TPO — Trade Promotion Optimization**
The commercial discipline, and the name of this application. The one live module
of the six on the portal's Home page.

**Treatment**
See *Approved treatment*.

**WeekRow**
The KPI engine's input grain: one `(product, channel, business week, offer)`
slice of the filtered dataset. Stores are pooled inside the group; offers are
not.
