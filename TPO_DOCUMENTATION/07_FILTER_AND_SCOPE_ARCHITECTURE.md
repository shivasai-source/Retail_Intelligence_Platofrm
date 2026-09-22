# 07 — Filter and Scope Architecture

`backend/app/tpo/filters.py` (520 lines) ·
`frontend/src/store/commandFilters.ts` (244 lines) ·
`frontend/src/components/command/FilterBar.tsx`

## 1. The one rule

```
load → filter → aggregate → calculate
```

Never *calculate, then filter the displayed values*. Every Command Center
endpoint resolves the **same** `FilterState`, so the cards, trend, alerts,
mix and tables are describing one scope by construction rather than by
coincidence.

`FilterState` is a **frozen dataclass** — hashable, so resolved row sets are
`lru_cache`d on it directly.

## 2. The 14 dimensions

`filters.DIMENSIONS`, grouped by where each value comes from:

| Group | Dimensions | Source |
|---|---|---|
| Row | `year`, `month` | The fact row (month derived from `(Year, Week) → dim_date`) |
| Store | `channel`, `retailer`, `region`, `state`, `city`, `tier`, `distributor` | `dim_geo_store` |
| Product | `category`, `brand`, `product` | `dim_product` (`brand` = the **Brand Form**) |
| Promotion | `promotion`, `promotion_type` | `dim_promotion` |

`year`/`month` are `int | None`; every other dimension is
`frozenset[str] | None`. **`None` means unconstrained.**

Values carried are **real codes**, never display names: `CH002` not
"Modern Trade", `PBDI25` not "Diwali Special 25", `P21-64ct` not the SKU name.

`Country` exists in `dim_geo_store` but is a single value (India) and is **not**
a filter dimension.

Adding a dimension is a single registry entry — the filter pass, the option
generator and the cascade all read the same table.

## 3. Selection semantics

| Rule | Behaviour |
|---|---|
| Within one dimension | **OR** — `channel=[CH002, CH003]` selects either |
| Across dimensions | **AND** — channel AND category AND month |
| Empty list | **Unconstrained** (not "match nothing") |
| `"All Channels"` / `"all"` token | **Unconstrained** — stripped by `_norm` against `_ALL_TOKENS` |
| Unknown dimension name | `ValueError` → **422** |

Treating an empty list as "match nothing" would blank the dashboard the moment
a dependent dropdown was cleared; treating `"All Channels"` as a literal value
would match no channel at all.

### Multi-select vs single-select (frontend)

`store/commandFilters.MULTI_SELECT` — only four dimensions accumulate values in
the UI:

**Multi-select:** `channel`, `retailer`, `category`, `brand`
**Single-select:** `region`, `state`, `city`, `tier`, `distributor`, `product`,
`promotion`, `promotion_type`, plus `year` and `month`

The **API models every one of them as a list**; single-select is a UI choice, so
widening a control later needs no contract change.

## 4. Two row sets — and why the distinction matters

```python
rows_for(state)            # EXACTLY what the user selected
baseline_rows_for(state)   # the same, PLUS the non-promoted rows the
                           # volume chain needs as a counterfactual
```

| KPI | Reads |
|---|---|
| Trade Spend, Margin Impact | `rows_for` — the population on screen |
| Incremental Quantity / Quantity % / Sales, ROI, PEI, Trade Spend Efficiency | `baseline_rows_for` |
| Cannibalization | `baseline_rows_for(state.widened_to_brand_form())` |

The two sets are **the same object** unless an Offer or Promotion-type filter is
active. `_matching_indices(..., keep_baseline=True)` re-admits non-promoted rows
that an Offer filter would otherwise exclude.

**Why:** they used to be one set, which let a "New Year Savings 24" filter under
F25 report Margin Impact 56.3% off 6,615 baseline rows while Trade Spend was
zero — six cards describing two different populations.

Numerically the widening is safe for spend, because a non-promoted row carries
`Base_Revenue == Actual_Revenue` and a zero `Promotion_Cost` and so contributes
nothing to Trade Spend.

### The cannibalization widening

`state.widened_to_brand_form()` lifts a **Product** filter to that SKU's Brand
Form, because cannibalization measures a promoted pack against its pack-size
neighbours and a Product filter would have removed exactly those neighbours.
The Product filter still travels separately as `promoted_products`, so a sibling
can be a **victim** but never a **promoter**.

Both widenings are required. `baseline_rows_for` was once applied only when a
Product filter existed, which starved the metric under an Offer filter: no SKU
had a baseline, so every candidate event was excluded. That is the exact scope
the Simulation Studio always uses.

## 5. The comparison period

`FilterState.comparison(store)` returns the **same dimensional filters over the
previous year**. Only the year moves; every other constraint carries across
unchanged — comparing a filtered current period against unfiltered history
would be comparing two different populations.

Returns `None` when there is no earlier year in the data, and every delta then
resolves to **undefined rather than a fabricated 0%** (a zero reads as "no
change", which is a different and false statement).

## 6. Dependent option lists

`options_for(state)` derives every list from **the rows the selection actually
admits**, never from the dimension tables. An option is offered **iff** picking
it returns at least one row.

### How it works — one pass, scored by failures

`_present_values` walks the fact table once. Each row is scored by how many
constraints it fails:

| Failures | Contributes to |
|---|---|
| 0 | Every dimension's list |
| exactly 1 (dimension *D*) | **Only D's** lifted list |
| ≥ 2 | Nothing — reachable from nowhere |

**A dimension's own constraint is lifted when computing its own list**, so the
control still offers the value currently selected and its siblings, while every
other constraint stays in force. Reading only the "fails-only-D" bucket dropped
the active selection out of its own dropdown; the lifted list is therefore the
union of the fully-passing rows and the fails-only-D rows.

That structure is why the lists narrow **together** rather than one at a time.

### Guarantees

- **No duplicates** — collected into a set, sorted
- **No blanks** — an empty value is dropped, and `retailer_available: false`
  tells the UI to hide the control (B2B carries no Retailer)
- **No dead options** — selecting F25 no longer offers the six 2024-only
  seasonal offers; Region = South no longer offers the 17 retailers that trade
  nowhere near it

Offers are labelled by `Promotion.label` (= `Promotion_Description`), the one
unique shared name. Products are sorted by Brand Form then pack rank.

Pinned by `tests/test_filter_options.py` (15 tests).

## 7. Frontend reconciliation

`store/commandFilters.reconcile(options)` drops any selection the backend no
longer offers under the current scope.

It replaces a hand-written parent→child cascade tree, which was
**one-directional**: it cleared children when a parent changed but never the
reverse, so **138 contradictory states** (Channel = E-commerce held alongside
Region = Central; Tier 3 alongside Region = West; …) survived it and resolved to
an empty dashboard.

Reconciliation is **symmetric by construction** — it asks only whether a value
is still reachable, so it fixes a contradiction whichever side the user created.

### Recency breaks the tie

Two contradictory selections invalidate **each other**, so a stateless pass
would clear both and one click would wipe an unrelated filter. `lastTouched` is
therefore pruned **last**:

```
1. prune everything EXCEPT the just-touched dimension
2. if that changed nothing, prune everything including it
```

The filter you clicked wins; the one it contradicts gives way.

### Termination

Every pass strictly **removes** values and never adds one, so the selection set
shrinks monotonically and the empty selection is a fixed point. When nothing is
removed the object identity is unchanged, no state update is emitted, React
Query is not re-triggered, and the update → refetch → reconcile cycle cannot
loop.

Pinned by `tests/test_filter_reconciliation.py` (16 tests) — which notes
explicitly that the reconciliation itself lives in the frontend and this project
has no frontend test suite, so the tests cover the server-side half.

## 8. Default state and initialisation

```
EMPTY_FILTERS = { year: null, month: null, …all lists empty }
```

The default **year** is adopted only once `/filters` reports which years exist —
never hardcoded to a year the data might not contain. `initialise(year)` sets it
once and records it as `defaultYear`; `reset()` restores that year and clears
everything else, so the primary controls always keep a valid selection rather
than a blank one.

Until `initialised` is true, every panel query is **disabled**. Without that
gate, `year: null` (a valid "All Years" scope) would fetch the whole two-year
dataset and immediately refetch the real year, doubling first-load traffic.

## 9. Wire format

`toQuery(filters, currency)`:

```
?year=2025&month=10&channel=CH002&channel=CH003&category=Baby%20Care&currency=INR
```

- Lists are **repeated keys**, never joined — matching
  `routers/command_center.ListParam`.
- Empty lists are **omitted entirely**, so "no constraint" and "constrained to
  nothing" stay distinguishable on the wire.
- `year` absent (never an empty string) means All Years.

For POST bodies, `SimulationFilters` mirrors `FilterState` exactly;
`tests/test_studio.py` asserts the model's field names **equal**
`filters.DIMENSIONS`, so the two cannot drift.

## 10. ⚠ Which panels actually receive the filters

This is the most important practical fact about scope in this application, and
the code comments around it are out of date.

| Query | Filters sent |
|---|---|
| `/command-center/kpis` | **All 14 dimensions** |
| `/command-center/filters` | **All 14 dimensions** |
| `/command-center/trend` | `year` + `granularity` |
| `/command-center/risk-alerts` | `year` + `limit` |
| `/command-center/underperforming-promotions` | `year` + `limit` |
| `/command-center/promotion-mix` | `year` |
| `/command-center/top-promotions` | `year` + `limit` |
| `/command-center/breakdown` | `year` + `by`/`metric`/`limit` (+ a chart-level `promotion`) |

The **backend accepts the full payload on all eight**. The **frontend chooses
not to send it** for six of them — `hooks/useCommandCenter.useScope()` documents
the intent: *"charts answer 'how did promotions behave over the year' and each
carries its own local control… what is not named is not sent"*, which keeps
chart caches alive across a Channel or Product change.

**Effect:** selecting Channel = Modern Trade narrows the six KPI cards but
leaves the trend, the risk alerts, both tables and all six chart sections
describing the whole year across every channel.

Two in-repo comments state the opposite and are **incorrect as written**:

- `store/commandFilters.ts` — *"Every panel … reads this same object and sends
  it to the backend verbatim."*
- `components/command/ChartSections.tsx` — *"Every one reads the SAME filter
  state as the KPI cards."*

Recorded, not reconciled — see
[appendices/KNOWN_LIMITATIONS.md](appendices/KNOWN_LIMITATIONS.md).

## 11. Scope propagation beyond the Command Center

### Command Center → Investigations (implemented)

`store/activeInvestigation.InvestigationScope` carries:

```ts
{ filters,                    // the validated FilterState at hand-off
  origin,                     // 'risk_alert' | 'underperforming' | 'query'
  label,
  identifiers,                // ONLY codes the source genuinely provided
  labels,                     // display-only; NEVER converted to codes
  at }
```

- A **risk alert** carries real `promotion_id`, `product_id` and `channel_id`.
- An **underperforming row** carries the same three codes for the event it
  measured.
- **Neither can narrow to a week.** `FilterState` has no week dimension, and an
  event's Incremental Sales is measured against the **selection's** non-promoted
  rows — narrowing to the promoted week removes them and collapses ROI to −100%.
  `row.period` therefore stays a display label.
- **The period selection is left alone** on a drill-down, for the same reason:
  moving the window moves the baseline and would answer a different question
  from the row that was clicked.
- Display names stay in `labels`. Converting "Modern Trade" back into `CH002` by
  guessing would be a second filter model wearing a disguise.

### Investigations → Simulation (implemented, with honest gaps)

`POST /api/simulation/context` validates the hand-off and stamps every field
with its provenance. `investigation_id` comes back `null` with the reason —
RCA assigns none. **No RCA KPI value enters a simulation**; the scope travels as
a `FilterState` and Simulation measures it for itself.

### Simulation Studio mode isolation

The three modes deliberately do **not** share a scope:

| Mode | Scope source | Dimensions offered |
|---|---|---|
| Investigation Simulation | `commandFilters` (or the RCA hand-off) | all 14 |
| Simulation Studio | `store/studioFilters` | `year`, `channel`, `category`, `brand`, `product` (+ geography behind More Filters) |

A shared month or channel would mean changing a control in one mode silently
re-scoped another. The narrower modes reject the other dimensions at the
contract boundary (`extra="forbid"`) rather than accepting a scope their screen
cannot explain.

### Reports

`ExportReportButton` reads `scope` and `options` through **callbacks at click
time** — so a report always reflects what the screen shows at the moment it is
asked for, and there is no cache to invalidate. Each Simulation Studio mode's
export reads that mode's own store.

## 12. Calendar's Year + Week → Month logic

The Promotion Calendar and every KPI use the **same** derived month.
`WeekRow.month` is already `dim_date`'s month for the business week, so
`promo_calendar` re-derives nothing:

```
fact row  (Year, Week)
   → dim_date days for that (Year, Week)
   → min(days)                       ← week start
   → that date's calendar Month      ← THE analytical month
```

`fact_sales.Month` is never read after load, and `fact_sales.Date` supplies only
the year. The loader **raises** if a `(Year, Week)` pair has no dim_date match.

`available_years()` reads the years from the **fact** stream, not dim_date, so
2026 — which dim_date describes but no transaction touches — is never offered.
