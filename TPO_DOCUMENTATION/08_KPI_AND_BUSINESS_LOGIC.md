# 08 — KPI and Business Logic

**Every formula in this document is transcribed from
`backend/app/tpo/aggregate.py`.** Nothing here is inferred, and there is
deliberately no second implementation of any of it — not in another endpoint,
and not in the frontend, which fetches results and formats them.

## 0. The foundation

> On every row of `fact_sales`, promoted or not,
> **`Base_Quantity == Actual_Quantity`**.

Verified across all 205,920 rows. So `Actual_Quantity − Base_Quantity` is
identically zero and measures nothing. Uplift is instead measured against a
**non-promotional baseline**:

```
baseline(product, channel) = mean(Base_Quantity)
                             over rows with Promotion_Id = -1
                             for that product IN THAT CHANNEL
                             INSIDE the current filter selection
```

### The chain, in the order it is computed

```
per-(product, channel) baseline
   → incremental quantity   Σ over promoted rows of (Actual_Quantity − baseline)
   → incremental sales      Σ over promoted rows of (that × Actual_Price)
   → ROI
   → PEI                    (last, from the components above)
```

Trade Spend and Margin Impact are **independent** of that chain — plain sums and
ratios over the filtered rows. Cannibalization is also independent — a
within-period contrast between neighbouring SKUs.

### Four invariants

1. **Only promoted rows contribute incremental volume.** A product never
   promoted in the selection contributes zero — its ordinary sales are not
   incremental sales.
2. **Every product carries its OWN baseline.** One pooled average across
   products would measure pack size, not promotional response.
3. **That baseline is per CHANNEL.** `Schedule` is a property of the channel:
   CH001/CH004 book one row per **week** (mean `Base_Quantity` 142.9) while
   CH002/CH003/CH005 book one per **month** (576.9). Pooling them measures
   period length — it drags F25 all-channel ROI from **141.2% to 8.6%**.
   Guarded by `test_baseline_is_keyed_per_channel`.
4. **A promoted (product, channel) with no non-promoted row in the selection has
   no baseline.** It is **skipped and reported** (`Volume.skipped`), never
   defaulted to zero.

### Additivity — looks like a bug, is not

| KPI | Additive? |
|---|---|
| Trade Spend | **Yes** — a plain row sum |
| Margin Impact | Ratio of summed revenue and cost; components add |
| Incremental Quantity / Sales, ROI, PEI, TSE | **No** |

A year is **not** the sum of its months, and All Channels is **not** the sum of
the five channels, because each selection re-derives its baseline from its own
non-promoted rows. January's uplift is judged against January's ordinary
trading; the year's against the year's.

Pinned by `test_incremental_sales_is_not_additive_across_months`. The
`breakdown` endpoint therefore computes `share_pct` **on Trade Spend only** and
its docstring instructs callers to render a **ranking, never a composition**
(measured drift on this data: −17.6%).

### Guards

```python
safe_divide(n, d)  → None if d == 0, or if the result is NaN / ±inf
```

Every ratio in the engine goes through it. **A KPI that cannot be computed
returns `None`, never `0`** — a fabricated zero reads as a measurement.

---

## 1. Trade Spend

| | |
|---|---|
| **Business meaning** | Total investment behind the promotion — the discount given away plus the promotion expenditure booked against it |
| **Formula** | `Σ (Base_Revenue − Actual_Revenue + Promotion_Cost)` |
| **Inputs** | `discount_value` (= `Base_Revenue − Actual_Revenue`) and `promotion_cost` per `WeekRow` |
| **Row set** | `rows_for(state)` — **the selection**, promoted and non-promoted alike |
| **Aggregation** | Plain sum. Fully additive |
| **Null handling** | `None` when the selection is empty |
| **Zero handling** | Not a divisor. `0` is a legitimate value (nothing promoted) |
| **YoY** | Generic path — the delta is already full-precision (2 dp on figures in the hundreds of millions) |
| **Implemented in** | `aggregate.calculate_trade_spend` |
| **Endpoints** | `/kpis`, `/trend`, `/risk-alerts`, `/underperforming-promotions`, `/top-promotions`, `/promotion-mix`, `/breakdown`, `/simulation/*` |
| **UI** | `TpoKpiTile` (card 1), `TrendPanels`, `RiskAlertsPanel`, both tables, `PromotionMixCard`, every chart section |
| **`lower_is_better`** | `true` |

Summed over **every** filtered row, not just promoted ones, exactly as written.
A non-promoted row carries `Base_Revenue == Actual_Revenue` and a zero
`Promotion_Cost`, so the two readings agree numerically — but summing the whole
set stays correct if a later extract ever books a discount against a
non-promoted row.

> **Corrected history.** An earlier implementation summed `Promotion_Cost`
> alone, reasoning the discount was already inside `Actual_Revenue`. That does
> not survive contact with the definition: Trade Spend measures **investment**,
> and the price cut is the larger part of what was invested. That version
> understated the predecessor project's 2025 figure by **₹23.10 Cr** and
> flattered every ratio built on it.

`debug` exposes both halves (`trade_spend_discount`,
`trade_spend_promotion_cost`) so the card reconciles.

---

## 2. Incremental Quantity

| | |
|---|---|
| **Business meaning** | Units the promotion added above ordinary trading |
| **Formula** | `Σ over promoted rows of (Actual_Quantity − baseline(product, channel))` |
| **Row set** | `baseline_rows_for(state)` |
| **Aggregation** | Sum over `(product, channel)` groups |
| **Null handling** | `None` on an empty selection or where no baseline exists |
| **Negative** | **Kept, never clamped** — a promoted row below the product's ordinary level is genuine underperformance |
| **Implemented in** | `aggregate.calculate_incremental_quantity` (rounded to 0 dp) |
| **Endpoints** | `/breakdown` (`incremental_units`), `/simulation/run`, `/simulation/simulate`, `/simulation/weekly` |
| **UI** | Simulation KPI tables, `RankedBar` when metric = Incremental Units |

Not a Command Center card. It **is** exposed as a Simulation Studio figure
(`incremental_units`) read straight off the same engine function.

## 3. Incremental Quantity %

```
Incremental Quantity ÷ baseline_quantity × 100
```

where `baseline_quantity = Σ (baseline × promoted transaction count)` — the
volume those same promoted rows would have moved at ordinary levels. A PEI
component; not a card of its own. `aggregate.calculate_incremental_quantity_percent`,
2 dp.

---

## 4. Incremental Sales

| | |
|---|---|
| **Business meaning** | Revenue the promotion added above the product's ordinary trading level, with every row valued at its own actual price |
| **Formula** | `Σ over promoted rows of (Actual_Quantity − baseline) × Actual_Price` |
| **Row set** | `baseline_rows_for(state)` |
| **Aggregation** | Per `(product, channel)`, then summed |
| **Null handling** | `None` on an empty selection |
| **YoY** | Generic path |
| **Implemented in** | `aggregate.calculate_incremental_sales` (2 dp) |
| **Endpoints** | `/kpis`, `/trend`, `/risk-alerts`, `/underperforming-promotions`, `/top-promotions`, `/breakdown`, `/simulation/*` |
| **UI** | Card 2, trend series, chart sections, simulation tables |

### Computed exactly, at aggregate grain

Using `Actual_Revenue == Actual_Quantity × Actual_Price`:

```
Σ((Aq − b)·Ap) = Σ(Aq·Ap) − b·Σ(Ap)
               = Σ(Actual_Revenue) − b · actual_price_sum
```

So `actual_price_sum` and `transaction_count` make the row-level formula exact
without walking every transaction. **Each promoted row is valued at its own
`Actual_Price`** — two different discounts in one selection are never collapsed
into a single pooled price.

`average_promotion_price` (pooled `Σrevenue / Σquantity`) exists for
**reporting only** and never feeds this figure.

---

## 5. Promotion ROI

| | |
|---|---|
| **Business meaning** | Return earned on every rupee invested |
| **Formula** | `(Incremental Sales − Trade Spend) ÷ Trade Spend × 100` |
| **Target** | `config.PROMOTION_TARGET_ROI_PCT = 50.0` |
| **Row sets** | Spend from `rows_for`; uplift from `baseline_rows_for` |
| **Null handling** | `None` — **never zero, never infinite** — when nothing was spent: there is no return to express against no investment |
| **YoY** | `_precise` — the delta is taken from the **unrounded** pair, then the reported values are rounded to 2 dp |
| **Implemented in** | `aggregate.roi_percent` (the one expression) and `aggregate.calculate_roi` (the card) |
| **Endpoints** | `/kpis`, `/trend` (per point), `/risk-alerts`, `/underperforming-promotions`, `/top-promotions`, `/breakdown`, `/simulation/*` |
| **UI** | Card 3, trend teal line + dashed target, alert severity, "vs Target" columns |

**Every ROI in this application goes through `roi_percent`** — the card via
`calculate_roi`, and each promotion event via the service layer, which then
feeds the alerts' displayed ROI, their severity banding and the underperforming
table. The inputs differ (whole selection vs one event); the arithmetic cannot.

`precision=None` returns the same arithmetic unrounded, for a delta that must
not be taken from two already-rounded numbers.

> **Corrected history.** The Simulation Studio used to divide revenue by spend
> in the browser and call the result "ROI" — a different formula in different
> units, sitting beside a Command Center reporting against a 50% target. It no
> longer computes anything.

---

## 6. Margin Impact

| | |
|---|---|
| **Business meaning** | Gross margin retained across the selected period |
| **Formula** | `Σ(Actual_Revenue − Total_Cost) ÷ Σ(Actual_Revenue) × 100` |
| **Row set** | `rows_for(state)` |
| **Aggregation** | **One ratio of summed revenue and cost** — deliberately *not* an average of per-row margins, which is the classic error across rows of very different sizes |
| **Null handling** | `None` on an empty selection or zero revenue |
| **YoY** | `_precise`, 2 dp |
| **Implemented in** | `aggregate.calculate_margin` |
| **Endpoints** | `/kpis`, `/breakdown`, `/simulation/*` |
| **UI** | Card 4, chart sections, simulation tables |

`debug` exposes `actual_revenue` and `total_cost` so the card reconciles against
the fact table without a second query.

---

## 7. Trade Spend Efficiency

```
Incremental Sales ÷ Trade Spend × 100
```

Returned per rupee invested. `aggregate.calculate_trade_spend_efficiency`, 2 dp.

**Computed and returned, but deliberately not a PEI component:**
`TSE = ROI + 100` by definition, so carrying both would put 45% of PEI's weight
on one signal. Not a Command Center card either; present in the KPI bundle and
in `debug`.

---

## 8. Cannibalization Rate

| | |
|---|---|
| **Business meaning** | Share of a promotion's extra volume that came out of its neighbouring pack sizes in the same Brand Form |
| **Formula** | `Total Cannibalized Quantity ÷ Promotional Incremental Quantity × 100` |
| **Row set** | `baseline_rows_for(state.widened_to_brand_form())`, with the Product filter travelling separately as `promoted_products` |
| **Null handling** | `None` when the selection cannot support the metric |
| **YoY** | `_cannibalization_metric` — each period derives its own rate from its own promotions and baselines; the delta is taken from the two **unrounded** rates (`overall_exact`) |
| **Implemented in** | `aggregate.cannibalization_detail` / `calculate_cannibalization` |
| **Endpoints** | `/kpis`, `/breakdown`, `/simulation/simulate` |
| **UI** | Card 6, with an evidence sub-label |
| **`lower_is_better`** | `true` |

### The event definition

A **promotion event** is one `(Brand Form, channel, business week, promoted SKU)`.
The channel is part of the identity because a weekly-grain channel and a
monthly-grain one are not comparable observations.

```
loss(neighbour)  = max(neighbour_baseline × its rows − its actual quantity, 0)
increment(promo) = promoted actual quantity − promoted_baseline × its rows
rate             = Σ loss ÷ Σ increment × 100
```

Both quantities accumulate over events and are divided **once at the end** — a
ratio of sums, never a mean of ratios. Per Brand Form, the same rule over that
Brand Form's own events.

### Neighbours

`_adjacent_ranks(r)` = the pack sizes immediately either side: rank 2 neighbours
1 and 3; rank 4 neighbours only 3. **Rank 1 (the smallest pack) is never
promoted** in this data — 0 promoted rows at rank 1 against 24,210 / 24,660 /
11,430 at ranks 2/3/4 — but it is the primary victim, so it appears as a
neighbour and never as a promoter. Everything is confined to one Brand Form,
never across brands or categories.

### Exclusion rules (each one reported, never silently applied)

| Excluded | Reason |
|---|---|
| Promoted SKU with no non-promoted row in the selection | No baseline to measure its uplift against |
| Event with `increment ≤ 0` | There is no promotional gain for a loss to be a share of, and it would put a non-positive number in the denominator |
| A neighbour itself on promotion that week | Its movement is its own uplift, not the promoted SKU's theft |
| A neighbour with no non-promoted baseline | Same as above |
| An event with no adjacent SKU available | Nothing to measure against |

**Only losses count.** A neighbour trading *above* its baseline was not
cannibalized; letting that subtract would net one Brand Form's loss against
another's growth — hence `max(…, 0)` per neighbour.

### Cannibalization Score

`aggregate.cannibalization_score` — bucketed, lower rate = higher score:

| Rate ≤ | 5% | 10% | 20% | 30% | 50% | above |
|---|---|---|---|---|---|---|
| Score | 100 | 90 | 75 | 60 | 40 | 20 |

Returned in the bundle and in `debug`; **not a PEI component** and not a card.

### The evidence floor and the measurement ladder (reporting, not arithmetic)

Both live in `service.py`; `aggregate.cannibalization_detail` stays the one
implementation.

**Floor** — `CANNIBALIZATION_MIN_EVENTS = 3`. Below that the card reports
unavailable, exactly as it does when nothing was comparable: *"a share computed
over one or two events is not a rate this selection can support."* Suppressing
the value drops **every** derived figure with it — a delta against a rate the
card no longer shows would be a comparison to nothing.

**Ladder** — `_CANNIBALIZATION_LADDER`, walked in order, each rung lifting
**one** dimension from the pinned scope (never cumulative, so the subject stays
recognisable):

```
1. ("channel",)                      → same promotion, same SKU, all channels
2. ("promotion", "promotion_type")   → same SKU, same channel, all promotions
```

The **Product pin is never lifted** — it is what makes the answer about the SKU
on screen. The first rung that clears the floor wins, so the reported figure is
the narrowest scope the evidence supports.

`value` stays the **pinned** scope's rate and is never overwritten by a
fallback; the wider figure travels beside it in `measured_at` carrying its own
`scope_label`.

> **The ladder deliberately does not run inside a simulation.** Widening the
> scope would hand the scenario a different population to re-base, and Phase A
> models no scenario response over rows the user did not select. A simulated
> scenario gets the **floor only**; the studio shows the resolved measured
> figure beside those cells.

---

## 9. Promotion Efficiency Index (PEI)

| | |
|---|---|
| **Business meaning** | A 0–100 composite of the three headline KPIs |
| **Formula** | `0.40 × ROI + 0.30 × Incremental Qty % + 0.30 × Margin Impact` |
| **Normalisation** | Each component `÷ its ceiling`, clamped onto 0–100 first |
| **Ceilings** (`PEI_SCALE`) | ROI 100% · Incremental Qty % 50% · Margin 40% |
| **Null handling** | `None` when **nothing in the selection was promoted** |
| **YoY** | `_precise`, reported to 0 dp |
| **Implemented in** | `aggregate.calculate_pei` — computed **last**, from the KPIs above, not in parallel |
| **Endpoints** | `/kpis`, `/breakdown`, `/simulation/*` |
| **UI** | Card 5 |

**Weight redistribution.** A component with no value contributes nothing and
**its weight is redistributed** across the rest, so PEI stays on a 0–100 scale
rather than being dragged toward zero whenever one input is undefined.

**Why null when nothing was promoted:** two of the three components are
undefined, and redistribution would collapse the index onto Margin Impact alone
— scoring a never-promoted SKU purely on its gross margin. There is no promotion
to index the efficiency of.

**Not components, and why:** Trade Spend Efficiency (`= ROI + 100`, so 45% of
the weight would rest on one signal) and Cannibalization (a headline KPI in its
own right). Both are still computed and shown.

`precision` rounds only the **result**; the three components keep their own
rounding, because they are the KPIs as this project defines them.

**PEI reads `rows` — the selection as filtered.** The Brand-Form widening
applied to cannibalization does not reach it.

---

## 10. Baseline

Not a card — the primitive everything volume-derived rests on.

```
baseline(product, channel) = Σ Base_Quantity over non-promoted rows
                             ÷ Σ transaction_count over those rows
```

`Base_Quantity`, not `Actual_Quantity`: the baseline is the ordinary demand
level the source records for a non-promoted row.

Reported unrounded to **4 dp** in `debug.per_product[].baseline_avg`, precisely
so nobody mistakes it for a constant — **it moves with every filter**.

`Volume.skipped` lists every `(product, channel)` that had promoted rows but no
baseline, with the reason.

---

## 11. Forecast

**Not implemented, and refused by design.**

There is no forecasting anywhere in this application. Three near-neighbours
exist and each is explicitly labelled as something else:

| Feature | What it actually is |
|---|---|
| `/simulation/simulate` `low`/`high` | The two ends of an **approved uplift band** — *"not a confidence interval, not statistical uncertainty and not model confidence"* |
| `/simulation/weekly` | A **decomposition across observed business weeks** — *"every week returned is a week the data has rows for"* |

`components/charts/Forecast.tsx` exists as a design-system component ported from
the predecessor app.

---

## 12. Promotion uplift — the approved response model

`backend/app/tpo/studio.py`'s fitted lift curve, with `config.TREATMENT_RULES` as its last-resort fallback.

| Treatment | Discount `d` | Uplift band | Break-even `u*` | Headroom low → high |
|---|---|---|---|---|
| PR001 | 5% | 15 – 20% | 9.2% | +5.8 → +10.8 pp |
| PR002 | 10% | 25 – 35% | 16.9% | +8.1 → +18.1 pp |
| PR003 | 15% | 40 – 50% | 26.9% | +13.1 → +23.1 pp |
| PS001 | 20% | 55 – 65% | 40.4% | +14.6 → +24.6 pp |
| PB001 | 25% | 60 – 72% | 59.6% | **+0.4** → +12.4 pp |

### The economics

With `b` = baseline volume, `P` = list price, `d` = discount, `u` = uplift,
`c` = `PROMOTION_COST_RATE` = 0.03:

```
Incremental Sales = b·u·P·(1 − d)
Trade Spend       = b·(1 + u)·P·(d + c)
ROI               = u(1 − d) / ((1 + u)(d + c)) − 1

ROI = 0  ⟺  u* = (d + c) / (1 − c − 2d)
```

`config.breakeven_uplift` is **derived, not fitted**, and relocated verbatim
from `scripts/audit_roi_realism.py`, which now imports it back. Its domain
caveat is documented: the denominator goes non-positive once `2d + c ≥ 1`
(beyond a 48.5% discount). The approved treatments top out at 25%.

### What these rules are, and are not

They are **the design parameters the dataset was generated under**, verified to
hold in the live file — the audit measures uplifts of 18.2 / 30.3 / 43.8 / 60.5
/ 69.1 percent, each inside its own band.

They are **not** an elasticity estimated from observed variation, **not** a
model fit, **not** an ML prediction, **not** an MMM estimate and **not** a
forecast. `response.PROVENANCE = "Approved TPO promotion treatment rule"`
travels on every response so a UI cannot present them as something else.

### Three refusals

| Refusal | Why |
|---|---|
| **No interpolation** | 12% is not a shallower PR003 — it is a treatment nobody approved. `get_treatment_response(12)` raises `UnapprovedDiscount` rather than inventing a band |
| **No midpoint** | PR003's rule is 40–50%, not 45%. Collapsing a band manufactures precision the rule does not grant and throws away the only honest uncertainty this model has |
| **No spend input** | Trade Spend is `b(1+u)P(d+c)` — an **output** of a treatment, not a dial. Nothing in the module accepts one |

Cannibalization response is likewise absent: the approved rules define none.
The engine still **measures** cannibalization on synthesized rows, and that
value is returned as **engine-derived**, never as a response curve.

### Counterfactual row synthesis — `execution.synthesize`

For a row covering `n` transactions with baseline `b` and list price `P`:

```
quantity        = b · n · (1 + u)
price           = P · (1 − d)
actual_revenue  = quantity · price
base_revenue    = quantity · P
discount_value  = base_revenue − actual_revenue
promotion_cost  = c · base_revenue
total_cost      = unit_cost · quantity
base_quantity   = quantity            (Base_Quantity == Actual_Quantity holds)
actual_price_sum = price · n
```

**No KPI is computed here.** The row records what it would have recorded, and
the engine reads it. Synthesizing rows rather than writing a closed-form
`simulated_roi = …` means the scenario inherits every decision the engine
already makes — the per-`(product, channel)` baseline, the Brand-Form widening,
the negative-uplift policy, the rounding — for free and identically.

Rows whose `(product, channel)` has no baseline are **dropped and counted**
(`scope.excluded_rows`), never left at measured values beside counterfactual
ones.

---

## 13. Risk and alert calculations

### Severity bands (`config.SEVERITY_BANDS`, ROI %)

| Band | Condition | Tone |
|---|---|---|
| Critical | ROI < 25 | danger |
| High | 25 ≤ ROI < 40 | danger |
| Medium | 40 ≤ ROI < 50 | warning |
| *(none)* | ROI ≥ 50 | at target — not an alert |

Only events with `trade_spend > 0` are banded.

### At Stake

```
target_incremental_sales(spend) = spend × (1 + PROMOTION_TARGET_ROI_PCT/100)
At Stake = max(target_incremental_sales(spend) − incremental_sales, 0)
```

Written as the **inversion of the ROI definition**, not as a literal `× 1.5`, so
the two cannot disagree if the target moves. Never negative — an event already
at target has nothing at stake.

### Ranking (`service._rank_key`)

```
At Stake DESC  →  Trade Spend DESC  →  ROI ASC
```

At Stake leads deliberately: it is the business-priority metric. Ranking by
most-negative ROI first would put a tiny promotion with a catastrophic
percentage above a large one quietly losing far more money.

### Primary cause (`service._CAUSES`) — first match wins

| Predicate | Cause | Action |
|---|---|---|
| `incremental_sales ≤ 0` | No measurable uplift over baseline | Review whether the offer reached the shelf |
| Brand-Form cannibalization > 25% | High cannibalization within the Brand Form | Shift the offer to a non-adjacent pack size |
| `incremental_sales / trade_spend < 1` | Trade spend exceeds the revenue it returned | Reduce discount depth or promotion cost |
| *(otherwise)* | Uplift below the level the spend requires | Re-test at a shallower discount |

Every predicate reads only numbers the engine already produced.

### Simulation risk assessment *(removed 2026-09-22 with the old studio)*

A different thing entirely — a **governance assessment**, not a score:

- **No invented thresholds.** This project has never approved a budget ceiling,
  a margin floor, a cannibalization limit, a PEI floor, a maximum discount or a
  maximum duration. Writing one here would create a business rule by
  implementation, in a file nobody would think to review. So a metric with no
  approved boundary is reported as a **measurement plus a stated governance
  gap** (`UNDEFINED_THRESHOLDS`).
- **No score, no weighting, no probability, no confidence.** Severity comes
  from explicit rules or is `unknown`.
- **No recomputation.** Every number is read off results already produced.
- **The one boundary it does use is cited.** `scripts/audit_roi_realism.py`
  marks a treatment with under 2 percentage points of break-even headroom as
  "NO MARGIN". That is the project's own documented economic boundary, so it is
  reused with its provenance attached rather than replaced.

---

## 14. Period-over-period (YoY) behaviour

```python
calculate_growth(value, previous) → KpiMetric(value, previous_year,
                                              difference, growth)
growth = (value − previous) / abs(previous) × 100
```

Returns the movement **undefined** — not `0%` — when there is no comparable
prior period or the previous value is zero. `formatting.delta_label` renders
that as `—` with `"no comparison period"`.

### Precision — `_precise`

**Two rounded numbers make a wrong ratio.** PEI is reported as a whole number,
so a delta computed from the reported pair moved by up to **0.4 percentage
points** against the same delta from the underlying values; ROI and Margin
Impact, at 2 dp, moved by up to 0.01.

So ROI, Margin Impact, PEI and Cannibalization take their delta from the
**unrounded** pair and only the reported values are rounded afterwards. The
card's displayed value is unchanged by construction — rounding the unrounded
result to the same precision the KPI function used is the same number.

Trade Spend and Incremental Sales stay on the generic path: rounded to 2 dp on
figures in the hundreds of millions, so the reported delta is already the
full-precision one.

Pinned by `tests/test_kpi_delta_precision.py` (14 tests).

### `trend` vs `lower_is_better`

`_trend_of` returns `"up"` / `"down"` as a **direction only**. Whether that
direction is good travels separately as `lower_is_better` on the spec, because
a rising Trade Spend is a rise, not an improvement.

---

## 15. Period series (the trend chart)

`aggregate.period_series(rows, key)` splits Trade Spend and Incremental Sales
across periods. **Not a second definition — the same arithmetic, grouped:**

- Trade Spend is a plain row sum, so it splits trivially.
- Incremental Sales holds the **baseline FIXED** at the one computed over the
  whole selection and groups only the per-row terms. Recomputing it per period
  would measure each week against its own trading level, and the weeks would no
  longer add up to the headline number.

Period keys are zero-padded (`"2025-W07"`, `"2025-03"`), so a plain string sort
is chronological across a year boundary.

A period with no promoted row gets `incremental_sales = 0` — **not a gap**: it
traded, it simply ran no promotion.

This same function computes per-event Trade Spend and Incremental Sales for the
risk alerts and the underperforming table (keyed on
`product|channel|week|promotion`), which is why the events **sum exactly to the
headline cards** rather than forming a second, disagreeing total.

---

## 16. Currency handling

**Currency conversion is a presentation concern.**

- Every KPI is calculated in `BASE_CURRENCY = "INR"` and stays there.
- The canonical number travels in `value`; only `display_value` is converted.
- **No KPI function anywhere takes a currency argument.** The rate is read from
  config in exactly one place — `formatting._rate`.
- ROI, PEI and Cannibalization are percentages, scores and rates and are
  **never** converted, whatever the toggle says.

Magnitude formatting: INR uses the crore/lakh convention (`Cr`, `L`, `K`); USD
uses `B` / `M` / `K`.

Default rate `TPO_USD_PER_INR = 0.0115`.

## 17. Period labels

`fiscal_label(2024) → "F24"` is **display only**. The calculation, the filter
and the stored data all continue to use `2024`, and no dataset field is renamed
to produce the label.

**F24/F25 are calendar years 2024 and 2025.** April–March fiscal-year semantics
are deliberately **not** implemented, because `dim_date` carries no fiscal-year
field (its `Quarter` is calendar: Q1 = Jan–Mar). Changing this would change
which rows a period selects and would require re-baselining every KPI.

---

## 18. The debug block

Every KPI payload carries `debug` (`aggregate.build_debug`), so any headline
figure can be reproduced by hand from the filtered data:

`rows_in_scope`, `volume_rows_in_scope`, `promoted_rows`,
`promoted_product_channels`, `average_promotion_price`, `actual_revenue`,
`total_cost`, `baseline_quantity`, `incremental_product_cost`,
`incremental_profit`, `products_without_baseline`, all eight KPIs,
`trade_spend_discount` + `trade_spend_promotion_cost`,
`cannibalization_debug` (with the top 25 events),
`brand_form_cannibalization`, `comparable_events`, `excluded_events`,
`excluded_detail` (top 25), and `per_product` — one row per promoted
`(product, channel)` with its baseline to 4 dp.

`incremental_profit = Incremental Sales − Incremental Product Cost − Trade Spend`.

---

## 19. KPI → endpoint → UI summary

| KPI | Card | Engine function | Primary endpoint | UI component |
|---|---|---|---|---|
| Trade Spend | 1 | `calculate_trade_spend` | `/command-center/kpis` | `TpoKpiTile` |
| Incremental Sales | 2 | `calculate_incremental_sales` | `/command-center/kpis` | `TpoKpiTile` |
| Promotion ROI | 3 | `calculate_roi` → `roi_percent` | `/command-center/kpis` | `TpoKpiTile` |
| Margin Impact | 4 | `calculate_margin` | `/command-center/kpis` | `TpoKpiTile` |
| PEI | 5 | `calculate_pei` | `/command-center/kpis` | `TpoKpiTile` |
| Cannibalization Rate | 6 | `cannibalization_detail` | `/command-center/kpis` | `TpoKpiTile` + evidence sub-label |
| Incremental Quantity | — | `calculate_incremental_quantity` | `/breakdown`, `/simulation/*` | `RankedBar`, simulation tables |
| Incremental Quantity % | — | `calculate_incremental_quantity_percent` | (PEI component) | — |
| Trade Spend Efficiency | — | `calculate_trade_spend_efficiency` | `/kpis` bundle, `debug` | — |
| Cannibalization Score | — | `cannibalization_score` | `/kpis` bundle, `debug` | — |
| Incremental Profit | — | `calculate_incremental_profit` | `debug` | — |

The card label, formula text and tooltip copy all live in `service.KPI_SPECS`,
beside the code that reads the engine — so a tooltip cannot drift from the
arithmetic it describes.
