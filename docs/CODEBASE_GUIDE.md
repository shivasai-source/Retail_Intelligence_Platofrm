# TIQ — Retail Intelligence Platform (TPO)
## Complete Codebase Guide: Workflow & File-by-File Reference

> **Trade Promotion Optimization** platform. React 19 + TypeScript + Vite frontend,
> Python FastAPI backend, a 205,920-row star-schema dataset, an OpenAI-backed
> multi-agent investigation layer, SQLite persistence, and Excel/PDF report export.
>
> Generated from a full read of the repository.

---

## Table of Contents

1. [What This System Is](#1-what-this-system-is)
2. [The Big Picture — Architecture](#2-the-big-picture--architecture)
3. [The Data Foundation](#3-the-data-foundation)
4. [The Core Workflow, End to End](#4-the-core-workflow-end-to-end)
5. [The KPI Engine — Exact Formulas](#5-the-kpi-engine--exact-formulas)
6. [The Nine Modules & Their Journeys](#6-the-nine-modules--their-journeys)
7. [The AI Agent Layer](#7-the-ai-agent-layer)
8. [Request Lifecycle — A Traced Example](#8-request-lifecycle--a-traced-example)
9. [File-by-File Reference — Backend](#9-file-by-file-reference--backend)
10. [File-by-File Reference — Frontend](#10-file-by-file-reference--frontend)
11. [Data, Scripts, Tests](#11-data-scripts-tests)
12. [API Endpoint Map](#12-api-endpoint-map)
13. [Design Principles That Govern The Code](#13-design-principles-that-govern-the-code)

---

## 1. What This System Is

TIQ is a **Trade Promotion Optimization (TPO)** decision platform for a consumer-goods
manufacturer selling through Indian retail channels. It answers one commercial
question in a chain of increasingly specific forms:

> *We spent money discounting product. Did it pay? Where didn't it? What should we
> do differently? And can I defend that decision later?*

The platform is built around a **decision journey** rather than a set of dashboards.
Each module hands off to the next:

```
Command Center  →  Investigations  →  Promotion Intelligence  →  Simulation Studio
   (what?)          (why?)              (what does it mean?)      (what if?)
                                                                       ↓
   Reports    ←    Promotion Calendar   ←        Decision Center
   (defend it)      (when does it land?)          (decide & record it)
```

### The Central Philosophy

The codebase is unusually opinionated, and understanding this is essential to
reading it. Three rules are enforced everywhere, in docstrings, in structure, and
in tests:

| Rule | What it means in practice |
| --- | --- |
| **One definition, one place** | There is exactly ONE `roi_multiple()` in the codebase. The KPI card, the risk alert, the report export and the AI agent all call it. Two implementations could drift; one cannot. |
| **Never fabricate a number** | When a metric can't be computed, it returns `None` — never `0`, never an interpolation, never a midpoint. A missing comparison period renders as `—`, not `0%`, because "0% change" is a different and false claim. |
| **Compute, then present** | Currency conversion, F24/F25 labels, and magnitude formatting (`₹162.4 Cr`) are *display* concerns applied once at the edge. No KPI function takes a currency argument. |

A recurring comment pattern in this repo is a section headed
*"WHAT THIS MODULE REFUSES TO DO"* — listing capabilities deliberately **not**
built, because building them would mean inventing business policy in code where
nobody would review it.

---

## 2. The Big Picture — Architecture

### Process topology

**Development** — two processes:
```
Browser  →  Vite dev server (:5173/5175)  →  proxy /api/*  →  FastAPI (:8100)
```

**Production** — one process:
```
Browser  →  FastAPI (:8100)  →  serves frontend/dist/ AND /api/*
```

`app/main.py` auto-mounts `frontend/dist/` as static files if the folder exists,
so the entire application — UI, API, and all six data connectors — is a single
uvicorn process. There is no separate connector proxy.

### Layer diagram

```
┌──────────────────────────────────────────────────────────────────────┐
│ FRONTEND  React 19 · TypeScript · Vite · Tailwind v4 · HashRouter    │
│                                                                      │
│  pages/ (11)          →  components/ (~130)  →  charts/ (hand-SVG)  │
│       ↓                                                              │
│  hooks/ (21)  — TanStack Query: server state, caching, polling       │
│       ↓                                                              │
│  store/ (10)  — Zustand: cross-page handoff state, localStorage      │
│       ↓                                                              │
│  lib/api.ts   — fetch wrapper, uniform ApiError                      │
└──────────────────────────────────────────────────────────────────────┘
                              ↓  /api/*
┌──────────────────────────────────────────────────────────────────────┐
│ BACKEND  FastAPI                                                     │
│                                                                      │
│  routers/ (17)  — HTTP surface only: parse, authorize, delegate      │
│       ↓                                                              │
│  ┌─────────────────┬──────────────────┬───────────────────────────┐ │
│  │ app/tpo/ (21)   │ app/agents/ (9)  │ app/reports/ (5)          │ │
│  │ THE ENGINE      │ LLM layer        │ xlsx / pdf export         │ │
│  │ filters→        │ plan→analyse→    │ adapters → ReportDoc →    │ │
│  │ aggregate→      │ specialists→     │ two writers               │ │
│  │ service         │ synthesis        │                           │ │
│  └─────────────────┴──────────────────┴───────────────────────────┘ │
│       ↓                                                              │
│  app/store/ (4)  — SQLite, append-only, the ONLY writer              │
│  app/tpo/loader.py  — 5 CSVs → cached columnar in-memory store       │
└──────────────────────────────────────────────────────────────────────┘
                              ↓
        Data/ — 6 CSVs, 205,920 fact rows      backend/.store/tiq.db
```

### The single most important architectural fact

```
load  →  filter  →  aggregate  →  calculate  →  format
```

**Never** calculate-then-filter. Every Command Center endpoint resolves the *same*
`FilterState` object, so the KPI cards, trend chart, risk alerts, promotion mix and
both tables are always describing the identical scope. This is why the six cards on
screen can never disagree with each other.

---

## 3. The Data Foundation

### The star schema — `Data/`

| File | Rows | Role |
| --- | --- | --- |
| `fact_sales_2024_2025_all_channels.csv` | **205,920** | The fact table |
| `dim_date2425_corrected.csv` | 882 | Calendar: Date, Year, Month, Quarter, Week, Day |
| `dim_geo_store_final.csv` | 509 | Store → Channel, Retailer, Distributor, Region, State, City, Tier |
| `dim_promotion_final.csv` | 18 | Promotion → Name, Type, Description |
| `dim_product_reordered.csv` | 36 | Product → Name, Brand (Brand Form), Category, Size, Cost |
| `dim_channel.csv` | 5 | Channel → Name, Type |

**Fact columns:** `Transaction_Id, Date, Week, Month, Product_id, Store_Id,
Channel_Id, Promotion_Id, Base_Quantity, Actual_Quantity, Base_Price, Actual_Price,
Base_Revenue, Actual_Revenue, Total_Cost, Promotion_Cost, Schedule`

**Joins:** fact → product (`Product_id`), → store (`Store_Id`), → channel
(`Channel_Id`), → promotion (`Promotion_Id`), → date (`Year` + `Week`).

### Three data facts that drive the code's design

**1. `Promotion_Id = "-1"` means *not promoted*.**
This constant (`loader.NO_PROMOTION`) is load-bearing: the baseline that every
uplift is measured against is built from exactly these rows.

**2. `fact_sales.Month` is wrong for 22.6% of rows — it is never used.**
The CH002/CH004 generators set `Date = Week_Start` but never re-derived `Month`,
and CH002/CH004/CH005 carry a scrambled `Date` — 51.9% of their rows disagree with
the `Week_Start` that `dim_date` gives for their own `(Year, Week)`. That puts
**46,440 of 205,920 rows in the wrong month.**

The fix, in `Dimensions.week_start`: the analytical month is recovered by joining
`(Year, Week)` → `dim_date` → the first calendar day of that business week. `Week`
is intact in every row and `dim_date` is clean, so this reproduces the two
known-good channels exactly. An unresolvable `(Year, Week)` pair raises loudly
rather than silently misfiling the row.

**3. The baseline is keyed on `(product, CHANNEL)`, not product alone.**
`Schedule` is a property of the channel — CH001/CH004 book one row per *week*
(mean `Base_Quantity` 142.9), CH002/CH003/CH005 one per *month* (576.9). Pooling
them measures period length rather than promotional response: it drags F25
all-channel ROI from **2.4 down to 1.1**. Guarded by
`test_baseline_is_keyed_per_channel`.

### The loader's storage strategy — `app/tpo/loader.py`

205,920 rows of Python objects would be tens of MB and slow to scan. Instead the
store is **columnar**: one `array('d')`/`array('i')` per field, with dimensions
held as *integer codes* into a lookup table.

```python
product_code: array('i')   store_code: array('i')   promo_code: array('i')
year: array('h')  month: array('b')  week: array('b')  promoted: array('b')
base_quantity / actual_quantity / base_revenue / actual_revenue / … : array('d')
```

A filter pass becomes a tight loop over integers — three array lookups and two
integer comparisons per row. Loaded **once** via `@lru_cache(maxsize=1)` on
`get_store()` and reused by every endpoint (~15 MB, ~2 s, one time).

`app/main.py` warms this on a **daemon thread at startup**, because without it the
first user pays for the CSV parse plus a full KPI pass — about 20 seconds of blank
screen. A warmup failure is logged and swallowed; it must never stop the server booting.

### Derived at load time: product rank

Each SKU gets a `rank` 1–4 by pack size within its Brand Form, computed from `Size`
(never hardcoded). **This is what makes cannibalization measurable** — a promoted
SKU's "neighbours" are the pack sizes immediately either side of it. Rank 1 (the
smallest pack) is never promoted in this data (0 promoted rows, vs 24,210 / 24,660 /
11,430 at ranks 2/3/4) but it is the primary *victim*, so it appears as a neighbour
and never as a promoter.

---

## 4. The Core Workflow, End to End

### 4.1 Boot

1. `uvicorn app.main:app` → FastAPI instance created.
2. `@app.on_event("startup")` spawns the `tiq-warmup` daemon thread:
   - `get_store()` parses 5 CSVs → cached `FactStore`.
   - `build_intelligence_facts({"year": 2025}, ("core",))` precomputes the default
     Promotion Intelligence scope.
3. 17 routers are mounted.
4. If `frontend/dist/` exists, it is mounted at `/` as static files.

### 4.2 Authentication

`app/auth_store.py` — accounts are created **implicitly on first login**, preserving
the frictionless demo UX, but the same email now requires the same password on every
subsequent login. Passwords are **PBKDF2-HMAC-SHA256, 200,000 iterations, per-user
salt** (stdlib only — no passlib/bcrypt dependency).

Sessions are real: a `secrets.token_urlsafe(32)` token in an **httpOnly cookie**
(`tiq_session`, 14-day TTL) looked up against a server-side store — not a
localStorage guess. `app/deps.py::current_user` 401s any route without a valid
cookie, and `RequireAuth` gates every frontend route but `/login`.

### 4.3 The filter → KPI pipeline (the heart of the system)

This is the path taken by every Command Center request:

```
Query params  (year, month, channel[], retailer[], region[], …)
     ↓
FilterState.build(...)          ← frozen, hashable dataclass. 14 dimensions.
     ↓
_fail_masks(store, state)       ← per CODE (55 stores/36 products/16 promos),
                                   a bitmask of which dimensions it fails.
                                   Evaluated once per code, not once per row.
     ↓
_matching_indices(...)          ← ONE pass over 205,920 rows: three array
                                   lookups + two int comparisons each.
     ↓
_to_week_rows(...)              ← group to KPI grain:
                                   (product, channel, week, offer)
     ↓
tuple[WeekRow, ...]             ← @lru_cache(128) — repeated identical scopes
                                   are free.
     ↓
aggregate.calculate_kpis(...)   ← the arithmetic
     ↓
service.kpis(...)               ← assemble cards + formatting + meta
     ↓
JSON  →  React
```

#### The two row sets — a critical distinction

`filters.py` returns **two different row sets** from one selection:

| Function | Contains | Read by |
| --- | --- | --- |
| `rows_for(state)` | **Exactly** what the user selected | Trade Spend, Margin Impact |
| `baseline_rows_for(state)` | The selection **plus** the non-promoted rows the volume chain needs as a counterfactual | Incremental Sales, ROI, PEI |

They differ *only* when an Offer or Promotion-type filter is active.

**Why this exists:** previously they were one set, which let a "New Year Savings 24"
filter under F25 report Margin Impact 56.3% off 6,615 baseline rows while Trade
Spend was zero — six cards describing two different populations.

#### Dependent filter options

Options are generated from the rows a selection **actually admits**, never from the
dimension tables. An option appears if and only if choosing it returns ≥1 row — so
the UI cannot offer a choice that empties the dashboard. Selecting F25 no longer
offers the six 2024-only seasonal offers; selecting Region = South no longer offers
the 17 retailers that trade nowhere near it.

The algorithm (`_present_values`) is one pass scoring each row by **how many
constraints it fails**: zero failures → it feeds every dimension's list; exactly one
failure → it feeds only that dimension's "lifted" list; two or more → it feeds
nothing. A dimension's own constraint is lifted when computing its own list, so the
control still offers the currently-selected value and its siblings.

---

## 5. The KPI Engine — Exact Formulas

All of this lives in **`app/tpo/aggregate.py`** (1,097 lines). Every number the
platform displays traces back here.

### The grain: `WeekRow`

One `(product, channel, week, offer)` slice. **Stores are pooled** inside that group
— one product's week in one channel is one observation however many outlets carried
it. **Offers are not pooled**: a week running both a 5% and a 10% promotion is two
promotion events, and merging them would report an event that never ran.

### Trade Spend

```
Trade Spend = Σ (Base_Revenue − Actual_Revenue + Promotion_Cost)
```

Both halves of the promotional investment: the **discount given away** plus the
**Promotion_Cost ledger**. Summed over *every* filtered row, not just promoted ones
— a non-promoted row carries `Base_Revenue == Actual_Revenue` and zero
`Promotion_Cost`, so it contributes nothing on its own terms.

> **A corrected bug, documented in the source:** an earlier implementation summed
> `Promotion_Cost` alone, reasoning the discount was already inside
> `Actual_Revenue`. That understated the 2025 figure by **₹23.10 Cr** and flattered
> every ratio built on it. Trade Spend measures *investment*, not revenue.

### The baseline and Incremental Sales

```
baseline(product, channel) = mean(Base_Quantity) over rows with Promotion_Id = -1

Incremental Quantity = Σ over promoted rows of (Actual_Quantity − baseline)
Incremental Sales    = Σ over promoted rows of (Actual_Quantity − baseline) × Actual_Price
```

Computed from the aggregate grain using the identity
`Actual_Revenue == Actual_Quantity × Actual_Price`:

```
Σ((Aq − b) × Ap) = Σ(Actual_Revenue) − b × Σ(Actual_Price)
```

so `actual_price_sum` and `transaction_count` make the row-level formula **exact**
without walking every transaction. Each promoted row is valued at its **own**
`Actual_Price` — two different discounts in one selection are never collapsed into a
pooled price.

**Negative results are kept.** A promoted row below the product's ordinary level is
genuine underperformance; clamping at zero would turn a loss-making promotion into a
neutral one.

A `(product, channel)` with promoted rows but **no** non-promoted row is *skipped*
and reported in `skipped[]` — its baseline is never defaulted to zero.

### Promotion ROI — the single definition

```
ROI = Incremental Sales / Trade Spend        (a bare multiple, 2 dp: 1.40)
```

**A bare multiple of trade spend at TWO decimal places** — the one deliberate
exception to the project's one-decimal rule, because a 0.1 step here is ten points
of the old percent scale (the old −3.6% is 0.96; at one decimal it would print as
1.0 and pass for break-even). 1.00 is break-even — the spend came back and nothing
more — and anything below it lost money. No unit sign: `1.40`, not `1.4x`. The earlier
definition, `(Incremental Sales − Trade Spend) / Trade Spend × 100`, was the same
ratio less one, in percent: 40.0% on the old scale is 1.4 on this one, and every
threshold in the codebase was restated with `x = pct / 100 + 1` (target 50% → 1.5).

`aggregate.roi_multiple()` is the **only** ROI in the product. The KPI card, every
promotion event, the risk-alert severity bands, the underperforming table, the
report export and the AI agents all call it. Returns **`None`** — never zero, never
infinity — when nothing was spent: there is no return to express against no
investment.

> The Simulation Studio used to divide revenue by spend in the browser and call the
> result "ROI" — a different numerator, sitting next to a Command Center reporting
> against a 1.5 target. It no longer computes anything.

### Margin Impact

```
Margin % = Σ(Actual_Revenue − Total_Cost) / Σ(Actual_Revenue) × 100
```

**One ratio of summed revenue and cost** — not an average of per-row margins.
Averaging ratios across rows of very different sizes is the classic error this
deliberately avoids.

### Trade Spend Efficiency

```
TSE % = Incremental Sales / Trade Spend × 100
```

Note `TSE = ROI + 100` by definition — which is exactly why it is **not** a PEI
component (see below).

### Incremental Profit

```
Incremental Profit = Incremental Sales − Incremental Product Cost − Trade Spend
```

### Cannibalization

```
loss(neighbour)  = max(baseline × its rows − its actual quantity, 0)
increment(promo) = its actual quantity − baseline × its rows
rate %           = Σ loss / Σ increment × 100
```

A **promotion event** is one `(Brand Form, channel, business week, promoted SKU)`.
The channel is part of the identity because a weekly-grain channel and a
monthly-grain one are not comparable observations.

Rules encoded:
- **Only losses count** — `max(…, 0)` per neighbour. A neighbour trading *above* its
  baseline was not cannibalized; letting that subtract would net one Brand Form's
  loss against another's growth and understate the effect.
- A neighbour **on its own promotion** that week is skipped entirely — its movement
  is its own uplift, not the promoted SKU's theft.
- An event whose promoted SKU shows **no uplift** (`increment ≤ 0`) is dropped.
- Neighbours are `rank ± 1` within the Brand Form, bounded to 1–4.

Score buckets: `≤5% → 100`, `≤10% → 90`, `≤20% → 75`, `≤30% → 60`, `≤50% → 40`,
else `20`.

### PEI — Promotion Effectiveness Index

```
PEI = 0.40 × norm(ROI − 1.0) + 0.30 × norm(Incremental Qty %) + 0.30 × norm(Margin Impact)
```

Each component is divided by its ceiling and clamped onto 0–100 first. ROI enters
as its **net return** — the multiple less the 1.0 that is only the spend coming
back — so a break-even promotion scores zero on that component and a 2.0 one hits
the ceiling. The index is numerically what it was when ROI was a net percentage.

| Component | Weight | Ceiling |
| --- | --- | --- |
| ROI net return (ROI − 1.0) | 0.40 | 1.0 |
| Incremental Quantity % | 0.30 | 50.0 % |
| Margin Impact | 0.30 | 40.0 % |

**Weight redistribution:** a component with no value contributes nothing and *its
weight is redistributed across the rest*, so PEI stays on a 0–100 scale rather than
being dragged toward zero whenever one input is undefined.

**Returns `None` when nothing in the selection was promoted** — two of three
components would be undefined and redistribution would collapse the index onto
Margin Impact alone, scoring a never-promoted SKU purely on its gross margin. There
is no promotion to index the efficiency of.

***Deliberately excluded:** Trade Spend Efficiency (because `TSE = ROI × 100`, so
carrying both would put 45% of the weight on one signal) and the cannibalization
score (a headline KPI in its own right). Both are still computed and shown; they
just don't feed the index.

### Computed LAST

PEI is computed *last*, from the KPIs above — never as a parallel calculation.

### The target

```python
PROMOTION_TARGET_ROI = 1.5     # a multiple of trade spend

SEVERITY_BANDS = {
    "critical": 1.25,   # ROI < 1.25
    "high":     1.4,    # 1.25 ≤ ROI < 1.4
    "medium":   1.5,    # 1.4 ≤ ROI < 1.5
}
```

At or above target is **not an alert at all**.

**"At Stake"** inverts the ROI definition:
```
Target Incremental Sales = Trade Spend × (1 + target/100)
```
which at the default 50% target is `trade_spend × 1.50`. Written as the inversion
rather than a literal `1.5` so the two cannot disagree if the target ever moves.

### Two things that look like bugs and are not

**A year is not the sum of its months.** Trade Spend and Margin Impact are plain row
sums and *do* add up. Incremental Sales, ROI and PEI are measured against a baseline
**re-derived from whatever is selected** — January's uplift is judged against
January's ordinary trading, and the year's against the year's. Pinned by
`test_incremental_sales_is_not_additive_across_months`.

**The baseline is keyed per channel.** See §3 above.

### Currency & labels — `app/tpo/formatting.py`

- Every KPI is calculated in **INR** and stays there. The canonical number travels
  in `value`; only `display_value` is converted, and the rate is read from config in
  exactly one place.
- **ROI, PEI and Cannibalization are never converted**, whatever the currency toggle says.
- `₹162.4 Cr` uses the Indian crore/lakh convention; USD uses B/M/K.
- `fiscal_label(2024) → "F24"` — display only. The underlying year stays 2024
  everywhere else; no dataset field is renamed.
- `delta_label` returns an **em dash** when movement is undefined — a fabricated 0%
  would read as "no change", a different and false claim.

---

## 6. The Nine Modules & Their Journeys

### 1 · Command Center — `#/command`
**The "what".** Six KPI cards (Trade Spend, Incremental Sales, ROI, Margin Impact,
PEI, Cannibalization), a trend chart with the 50% target benchmark line, risk alerts
banded by severity, an underperforming-promotions table, promotion mix by offer, and
top promotions. One `FilterBar` drives all of it through a single `FilterState`.

### 2 · Investigations (RCA) — `#/investigations`
**The "why".** A radial causal graph built by a multi-agent pipeline
(plan → aggregate → specialists in parallel → synthesis). Node detail popovers,
staged build choreography, and a query bar with keyword-based type inference across
four archetypes: `diagnostic`, `optimization`, `launch`, `strategic`.

### 3 · Promotion Intelligence — `#/intelligence`
**The "what it means".** Eight tabs. The headline analysis is the **discount
saturation curve** — ROI plotted against effective discount depth. The dataset's
mechanics carry real depth points: "5% Discount" through "20% Discount", plus
Buy3Get1 = **25% effective** (one free unit in four). Five real points make this a
genuine elasticity read rather than a decorative curve.

*Saturation* is defined as the shallowest depth at or beyond which ROI has fallen
below target **and keeps falling** — reported as `None` when the curve never crosses
it, rather than inventing a threshold.

Also: contribution waterfall by mechanic, incremental-sales-vs-target trend, and
dimension tables. Sections are **memoised per (section, scope)** because
`service.breakdown()` re-runs the whole KPI engine once per group — a breakdown over
31 retailers is 31 passes, and computing every section eagerly took ~40 s.

### 4 · Simulation Studio — `#/simulation`
**The "what if".** Three genuinely separate modes:

**(a) Investigation Simulation** — scenario execution against approved treatments.
**(b) General Optimization** — allocate a trade-spend budget across a scope:
*"Given a category, channel and month, which products should carry a promotion, at
which approved depth, so revenue is maximised without spend exceeding a ceiling?"*
**(c) Target Rescue** — *"Is this month's unit target on track, and if not, what is
the LEAST AGGRESSIVE approved intervention that recovers it?"*

The three share only what must not be written twice: the one `FilterState`, the
approved economics, and the validated KPI definitions.

#### The approved promotion response model — `app/tpo/response.py` + `config.py`

Five **approved treatment rules**, each mapping a discount depth to the uplift
**band** it is approved to produce:

| Treatment | Discount `d` | Uplift band |
| --- | --- | --- |
| PR001 | 5 % | 15 – 20 % |
| PR002 | 10 % | 25 – 35 % |
| PR003 | 15 % | 40 – 50 % |
| PS001 | 20 % | 55 – 65 % (2024 seasonal price cut) |
| PB001 | 25 % | 60 – 72 % (2025 seasonal Buy3Get1) |

Verified to hold in the live file — the audit measures uplifts of 18.2 / 30.3 /
43.8 / 60.5 / 69.1 %, each inside its own band.

**Break-even uplift**, derived (not fitted). With `Base_Quantity = Actual_Quantity
= b(1+u)`, discount `d`, promotion cost rate `c = 0.03` on Base_Revenue:

```
Incremental Sales = b·u·P·(1−d)
Trade Spend       = b·(1+u)·P·(d+c)
ROI               = u(1−d) / ((1+u)(d+c)) − 1

ROI = 0  ⟺  u* = (d + c) / (1 − c − 2d)
```

**Three things this module refuses to do:**
- **No interpolation.** `get_treatment_response(12)` *raises*. 12% is not a
  shallower PR003 — it's a treatment nobody approved.
- **No midpoint.** PR003 is 40–50%, not 45%. The band is carried whole; collapsing
  it would manufacture precision the rule doesn't grant.
- **No spend input.** Trade Spend is *derived* (`b(1+u)P(d+c)`), so it's an output
  of a treatment, not an independent dial.

Every response carries a `PROVENANCE` block stating these are **design parameters
the dataset was generated under** — NOT an estimated elasticity, NOT a model fit,
NOT an ML prediction, NOT an MMM estimate, NOT a forecast.

### 5 · Decision Center — `#/decision`
**Decide and record.** Assembles one read-only `DecisionRecord` from results earlier
phases already produced — investigation context, the selected scenario's simulation,
the recommendation, the risk assessment, optionally the weekly decomposition.

**An assembly, not a calculation.** Every figure is carried through verbatim and
`provenance.assembled_from` names its source. Sections are **validated against each
other** before assembly: `risk.provenance.scenario_provenance == simulation.provenance`
proves the risk describes this scenario and no other. A mismatch is *refused*, not
merged — a record silently combining scenario A's impact with scenario B's
recommendation would look authoritative and be wrong.

Also carries an **AI Decision Brief**: one OpenAI call turning the record into six
readable paragraphs. It is an *explanation layer* — the model never receives a raw
number it could do arithmetic on.

### 6 · Promotion Calendar — `#/calendar`
Year → Month → Channel → Promotion matrix, a detail panel, and upcoming events. A
**presentation read model**, not a second analytics engine — it reads the same
`WeekRow` stream through the same `filters.rows_for` and does no arithmetic beyond
counting distinct products.

### 7 · Reports — `#/reports`
Real `.xlsx` (openpyxl) and real `.pdf` (reportlab platypus) — not a CSV renamed, not
HTML renamed. Seven modules × two formats would be fourteen bespoke generators; instead:

```
module adapter → ReportDoc → excel.write() → .xlsx bytes
                           → pdf.write()   → .pdf bytes
```

An adapter knows about promotions and KPIs and never about openpyxl. A writer knows
about column widths and page breaks and never about ROI. **Adapters call the same
service function the screen calls**, so an export cannot disagree with the screen.

### 8 · Data Connections — `#/connections`
Six live connectors proxied through `/api/proxy/*`: Databricks, SAP OData, Power BI,
NielsenIQ (generic REST), OpenAI advisor chat, plus Azure Blob (CORS-native, direct
browser fetch — never proxied).

### 9 · Settings — `#/settings`
Profile, preferences, theme.

---

## 7. The AI Agent Layer

**Model:** OpenAI `gpt-4o-mini` (overridable via `OPENAI_MODEL`), called with
`response_format: json_schema, strict: true` — the graph renders from these fields,
so parsing prose and hoping would be the wrong trade.

**Key handling:** read from `backend/.env` (gitignored) at import, server-side only,
never sent to the browser and never in a response body. Deliberately separate from
the portal Advisor's bring-your-own-key `/api/proxy/openai/chat` flow.

### The division of labour

> **Python computes. The model reasons.**

Every number an agent sees is calculated by the deterministic engine. The model
never receives raw rows and never does arithmetic. This keeps the analysis grounded
(a model asked to "compute ROI" from 2,000 rows will approximate and drift), keeps
token cost flat regardless of dataset size, and makes the numbers reproducible.

### The four-stage pipeline

```
1. PLAN        one call.  Maps the dataset's real column names onto semantic
                          roles, picks the investigation archetype, and chooses
                          which specialists are worth running for THIS question
                          and THESE columns.
2. AGGREGATE   pure pandas / the TPO engine. No model.
3. SPECIALISTS N calls IN PARALLEL, one per analysis, each seeing only its own
                          aggregate table. Each returns a structured finding.
4. SYNTHESIS   one call.  Cross-cutting narrative over all findings. The confidence
                          beside it is measured, not written — see `confidence.py`.
```

Graph **structure** — node positions, icon choice, progress arithmetic — is assembled
deterministically in Python afterwards. The model supplies *judgement*, not layout.
That is what keeps the rendered graph stable across runs.

### Two pipelines, one contract

| Pipeline | Source of numbers |
| --- | --- |
| `pipeline.py` | Uploaded CSV/Excel → pandas aggregates (`aggregates.py`) |
| `star_pipeline.py` | The TPO star schema → `app/tpo/service.py` via `star_tools.py` |

Both produce the identical finding/synthesis schemas, so the graph renders the same.
The star pipeline's figures agree with the Command Center **by construction** —
`star_tools.py` is a thin adapter over the same engine, deliberately *not* a pandas
reimplementation, because that would quietly drift and make Investigations
contradict the Command Center on the same dataset.

### The specialist roster — `roster.py`

Previously the planner *invented* a specialist per question, and every one did the
same thing: one breakdown, one metric. Different names, identical method — which is
why findings overlapped.

Now there is a **fixed roster of genuinely different analysts**, each owning one link
in the promotion-ROI causal chain, each pulling its *own* data via different service
calls:

```
ROI = Incremental Sales / Trade Spend

Is it even abnormal?         → benchmark
Where did the money go?      → spend_allocation
Did the offer type convert?  → mechanic_efficiency
Which specific offers failed?→ offer_forensics
```

The orchestrator's job becomes **selection** — which lenses this question needs —
rather than invention.

### Promotion Intelligence agents — `intelligence_agent.py`

Two calls, **deliberately sequential**: the **Analyst** diagnoses, then the
**Advisor** sees those conclusions and recommends against them — rather than forming
opinions and advice simultaneously from raw tables. *Diagnosis before prescription.*

Recommendations carry **simulation parameters**, so Simulation Studio can pick them
up directly — closing the investigate → diagnose → simulate loop rather than ending
at a paragraph of advice.

### Run persistence — `investigation_runs.py`

Runs are persisted so a browser reload doesn't re-run the pipeline (which would mean
paying OpenAI twice for the same answer). The frontend polls
`GET /api/investigations/runs/{id}` and renders whatever stage it's at. An in-memory
dict is the live view; a JSON file survives restarts; the most recent 50 are kept.

A `kind` field (`investigation` | `intelligence`) separates the two consumers of this
shared store — inferred from result shape for records that predate the field
(investigations carry `orchestration`, analyses carry `analysis`/`recommendations`).

### Dataset ingestion — `dataset_store.py`

Uploaded files land on disk, pandas parses them, and a **profile** is cached: schema,
null counts, numeric distributions (min/max/mean/median/std/p25/p75), top categorical
values, and 5 sample rows.

**The profile exists because of one hard constraint: raw rows must never be sent to
an LLM.** A promotion dataset is easily hundreds of thousands of rows — it would blow
the context window, cost a fortune, and produce *worse* analysis than well-chosen
aggregates. **Agents read profiles, never CSVs.**

Date-like text columns are promoted to real datetimes when ≥90% of non-null values
parse — without this, a `week` column of ISO strings profiles as just another
low-cardinality category, and an agent reading that has no way to know it's the time
axis. Columns with >50 distinct values are `text` (identifiers), not `categorical`.

---

## 8. Request Lifecycle — A Traced Example

**User action:** on Command Center, selects Region = South, Channel = Modern Trade,
Period = March F25.

```
1. FilterBar (React)
   → commandFilters Zustand store updates
   → useCommandCenter hook's query key changes

2. TanStack Query fires:
   GET /api/command-center/kpis?year=2025&month=3&region=South&channel=CH002

3. routers/command_center.py
   → FilterState.build(year=2025, month=3, region=["South"], channel=["CH002"])
     · _norm() drops "All …" tokens and empties → None (unconstrained)
     · frozensets make the state hashable

4. service.kpis(state, currency="INR")
   → filters.rows_for(state)            [cache hit? return]
     · _fail_masks: 55 stores → bitmask, 36 products → bitmask, 16 promos → bitmask
     · _matching_indices: one pass over 205,920 rows
     · _to_week_rows: group to (product, channel, week, offer)
   → filters.baseline_rows_for(state)   [same here — no offer filter active]

5. aggregate.calculate_kpis(rows, volume_rows)
   → calculate_trade_spend      Σ(discount_value + promotion_cost)
   → _volume()                  per-(product,channel) baseline → incremental
   → calculate_incremental_sales
   → roi_multiple(inc_sales, trade_spend)
   → calculate_margin
   → cannibalization_detail     rank±1 neighbours, losses only
   → calculate_pei              LAST, from the above
   → and the same again for state.comparison() → F24 → growth deltas

6. service.kpis assembles six cards:
   { key, label, value (canonical INR), display_value ("₹7.7 Cr"),
     delta, delta_label ("vs F24"), trend, formula, meaning, lower_is_better }
   + meta { period_label: "March F25", applied filters, row counts }

7. JSON → useCommandCenter → <TpoKpi> cards render
```

Every other Command Center endpoint (`/trend`, `/risk-alerts`, `/promotion-mix`, …)
resolves the **same `FilterState`** — which is why the six cards, the chart and the
tables can never describe different populations.

---


## 9. File-by-File Reference — Backend

### 9.1 Top-level modules — `backend/app/`

| File | Lines | Purpose |
| --- | --- | --- |
| `main.py` | 106 | FastAPI app. Startup daemon thread warms the fact store + default Intelligence scope. CORS for the Vite dev origins with `allow_credentials` (needed now that auth sets a cookie). Mounts 17 routers, then `frontend/dist/` as static if built. |
| `deps.py` | 18 | `current_user` — 401s unless the request carries a valid session cookie. Exported as `CurrentUser = Depends(current_user)`. |
| `data_loader.py` | 29 | `load(name)` reads and `@lru_cache`s `app/data/{name}.json`. Contract is "immutable, cached at import time" — nothing writes through it. |
| `auth_store.py` | 125 | PBKDF2-HMAC-SHA256 @ 200k iterations, per-user salt, stdlib only. Implicit account creation on first login; the same email then needs the same password. Server-side sessions, 14-day TTL. Lock-guarded JSON files. |
| `dataset_store.py` | 248 | Upload ingestion + profiling. Caches schema, null counts, numeric distributions, top categoricals and 5 sample rows. **Raw rows must never reach an LLM** — agents read profiles, never CSVs. Promotes date-like columns when ≥90% parse. |
| `investigation_history.py` | 41 | Recent-questions list. Deliberately separate from `data_loader` because that cache is immutable and this file is mutable. Lock-guarded; de-dupes on (type, question); caps at 8. |
| `investigation_runs.py` | 132 | Run state. In-memory dict is the live view, JSON survives restart, most recent 50 kept. `kind` separates investigation vs intelligence runs (inferred from result shape for older records). |
| `intelligence_engine.py` | 632 | The deterministic half of Promotion Intelligence: saturation curve, contribution waterfall, inc-sales-vs-target trend, dimension tables, risk summary, **driver decomposition** (`roi_gap_decomposition` — each mechanic's exact contribution to the ROI gap against target) and **lever positions** (the measured current value of every simulation lever). Sections memoised per (section, scope) — eager computation took ~40 s. |

### 9.2 The engine — `backend/app/tpo/` (21 files, ~10,900 lines)

| File | Lines | Purpose |
| --- | --- | --- |
| `config.py` | 150 | Every tunable in one place: data dir resolution (`$TPO_DATA_DIR` → repo `Data/` → OneDrive), the 1.5 ROI target, severity bands, the five approved treatment rules, the break-even algebra, INR base currency and the USD rate. |
| `loader.py` | 418 | The 5 CSVs → one cached columnar store. Derives product rank and the analytical month from `(Year, Week)`. Raises loudly on an unresolvable week. |
| `filters.py` | 520 | THE filter engine. `FilterState` (14 dims, frozen, hashable), bitmask fail-masks per code, `rows_for` / `baseline_rows_for`, and dependent option generation. |
| `aggregate.py` | 1,097 | THE KPI engine. Every formula in §5 lives here. |
| `service.py` | 1,079 | Payloads for the Command Center endpoints. Computes no KPI — assembles cards, labels, meta and the cannibalization scope ladder. |
| `formatting.py` | 120 | Currency, magnitude, F24/F25 labels, delta strings. The only place the exchange rate is read. |
| `response.py` | 183 | The approved promotion response model. Refuses interpolation, midpoints and spend inputs. Carries `PROVENANCE` on every answer. |
| `execution.py` | 423 | B2.2 — synthesizes counterfactual `WeekRow`s at each end of the approved uplift band and hands them to the engine. Computes no KPI itself. |
| `scenarios.py` | 219 | B1 — the scenario model. An unrun hypothetical carries `result: None`, never zero and never the baseline's numbers. |
| `comparison.py` | 467 | B4.1 — lines up already-computed results with a delta per metric. Does not rank, score, weight or recommend. |
| `recommendation.py` | 585 | B4.3 — `RECOMMENDATION_POLICY` is data, not code: objective, economic constraint, primary metric, band end, tie-breakers. `recommend()` walks that structure and hardcodes no metric name. |
| `risk.py` | 624 | B6 — reports evidence, not verdicts. No score, no weighting, no probability. A metric with no approved boundary is reported as a measurement plus a stated governance gap. |
| `weekly.py` | 415 | B5 — decomposition, not forecast. Every week returned is a week the data has rows for. |
| `investigation.py` | 274 | B3.1 — the RCA → Simulation context contract. Every field is stamped with its provenance because RCA's own chips are authored fiction. |
| `decision.py` | 726 | B7 — assembles one read-only decision record; cross-validates every section; refuses a mismatch rather than merging. |
| `decision_brief.py` | 495 | The AI explanation layer. Not a calculator, not a decision maker — the model never receives a raw number it could do arithmetic on. |
| `briefing.py` | 537 | B8 — renders a record as portable `briefing.json` + self-contained `briefing.html`. A renderer, nothing else. |
| `simulation.py` | 660 | Phase A — orchestration only. Levers are accepted, validated, echoed, and move nothing (`levers.applied` is always false). |
| `optimization.py` | 1,019 | Mode B — allocate a trade-spend budget across a scope under the approved economics. |
| `rescue.py` | 2,604 | Mode C — is the month's unit target on track, and what is the least aggressive approved intervention that recovers it? The largest backend file. |
| `promo_calendar.py` | 449 | Year → Month → Channel → Promotion read model. Counts distinct products and nothing else. |

### 9.3 Routers — `backend/app/routers/` (17 files)

Routers hold **no business logic**: they validate a Pydantic body or parse query params into one shared `FilterState`, delegate, and serialise.

| File | Lines | Prefix | Notes |
| --- | --- | --- | --- |
| `auth.py` | 76 | `/api/auth` | `_public()` strips salt/hash. `/me` returns **401, not `null`**, so callers can't mistake "loading" for "logged out". |
| `briefing.py` | 58 | `/api/decision` | A separate router on the same prefix because B7's contract is frozen. `InvalidRecord` → 422, never 500. |
| `command.py` | 12 | `/api` | Legacy static Command payload. |
| `command_center.py` | 117 | `/api/command-center` | 8 endpoints sharing one `get_filters` dependency. The `by`/`metric` regexes are **built at import from `service.BREAKDOWN_DIMENSIONS`**, so route and implementation cannot drift. |
| `connectors.py` | 303 | `/api/proxy` | 7 connector proxies. Credentials forwarded, never persisted or logged. Checks Databricks returned JSON, because its front door serves an HTML sign-in page with a **200**. |
| `datasets.py` | 66 | `/api/datasets` | All 4 routes authenticated. 50 MB/file. Non-owner gets **404, not 403**, so existence can't be probed. |
| `decision.py` | 79 | `/api/decision` | POST `/record`. All inputs are payloads the client already holds, posted back — that is what guarantees Decision Center describes the same numbers. `SectionMismatch` → 422 naming the two sections. |
| `decision_brief.py` | 80 | `/api/decision` | POST `/brief`. **No prompt field is accepted** — it would let a caller redirect the model away from explaining the record. No key → 503; dead service → 502. |
| `intelligence.py` | 246 | `/api/promotion-intelligence` | 5 routes, all authenticated. Prefix deliberately avoids `pages.py`'s `/api/intelligence/{type}`, whose Literal would swallow `/facts`. |
| `investigations.py` | 207 | `/api` | 9 routes. **Route ordering is load-bearing** — `/recent` and `/runs` must precede `/investigations/{type}` or Starlette's Literal validation 422s on "recent". |
| `misc.py` | 42 | `/api` | 5 static readers. A comment marks where a fake `/api/reports` was **deleted** — it would have shadowed the real Report Center listing. |
| `nav.py` | 22 | `/api` | `/nav`, `/user`, `/focus`. |
| `pages.py` | 39 | `/api` | Per-archetype authored page data + three `-default` routes kept for fidelity. |
| `promotion_calendar.py` | 66 | `/api/promotion-calendar` | Mounted here, not `/api/calendar`, which `misc.py` already owns. Documents a Pydantic v2 gotcha: a `pattern=` on a `list[str]` query param applies to the **list**, not its items. |
| `reports.py` | 214 | `/api/reports` | 7 routes. **GENERATE IS NOT DOWNLOAD** — POST returns a `report_id`, never bytes; exactly one route answers with a file. |
| `simulation.py` | 697 | `/api/simulation` | 11 routes across three modes. `_REJECTED_INPUTS` rejects `spend_amount` **by name with a reason**, because a caller sending it has a mistaken model of the economics. |
| `store.py` | 230 | `/api/store` | 6 routes. The docstring is a security disclosure written into the code; `UNAUTHENTICATED` is attached to every route's OpenAPI description. `VersionConflict` → **409** with `current_version`. |

### 9.4 Agents — `backend/app/agents/` (9 files)

| File | Lines | Purpose |
| --- | --- | --- |
| `client.py` | 65 | The one OpenAI client. `gpt-4o-mini` default; key from `backend/.env` via an **explicit path** (not `find_dotenv()`, which walks the call stack). `complete_json()` uses `strict: true` json_schema. |
| `aggregates.py` | 327 | Pure pandas for the uploaded-CSV pipeline. `ColumnRoles.from_dict` **drops any column the model hallucinated**. `by_segment()` ranks on a `roi_index` because single-dimension breakdowns cannot see interactions. |
| `roster.py` | 339 | The fixed roster of 9 star-schema specialists, each owning one link in the ROI causal chain and pulling its own data. The cannibalization fetcher ships two different measures side by side and tells the model not to conflate them. |
| `pipeline.py` | 566 | The uploaded-CSV pipeline + the deterministic graph assembler. Nodes are placed on a ring (`x = 50 + 34·cos θ`), because asking an LLM for coordinates produces overlapping nodes that drift between runs. `MAX_SPECIALISTS = 6`. |
| `star_tools.py` | 441 | Thin adapter over `app/tpo/service.py`. `_bounded_int` guards against a planner emitting `month=41`. `neighbour_sales_decline` is a careful two-pass analysis with an explicit `causality_note`. |
| `star_pipeline.py` | 682 | The star-schema pipeline. Leads with an **answerability gate** (refuse questions about people, weather, chit-chat), disambiguated by a value index so "is dussehra good or bad?" resolves to the *offer* named Dussehra Deal 25. Runs a **standing panel of 6** specialists every time. |
| `intelligence_agent.py` | 544 | Analyst (temp 0.2) → Advisor (temp 0.3), sequential. Tone markup `[g]/[r]/[n]` is stripped from everything except `narrative`, because it leaked into insight titles as literal `[r]29.2%[/r]`. Neither agent supplies a figure any more: driver weights come from `roi_gap_decomposition`, `simulation.current_value` from `lever_positions`, and both confidences from `confidence.py`. |
| `figures.py` | 239 | **Numeric provenance.** Flattens what an agent was given into the set of values it may cite, then checks what it wrote: chart bars that do not trace are dropped before they are drawn, node deltas are subtracted here from two operands the agent named, prose figures are flagged. |
| `confidence.py` | 423 | **The evidence score.** The one place a `confidence` percentage is produced — four components (support, breadth, completeness, traceability) combined by geometric mean. Specified in [`CONFIDENCE_SCORE.md`](CONFIDENCE_SCORE.md). |

**Temperatures used:** planner 0.1 · specialists 0.2 · synthesis 0.3 · Analyst 0.2 · Advisor 0.3.

### 9.5 Reports — `backend/app/reports/` (5 files)

| File | Lines | Purpose |
| --- | --- | --- |
| `model.py` | 197 | The `ReportDoc` intermediate. **Values are carried raw with a kind** — a cell holds `9071892.0`, not `"₹90.7 L"`, so Excel gets a real number and the PDF gets the project's own display string. A missing key is **blank, not zero**. |
| `service.py` | 394 | Module registry (5 modules), scope validation, filenames, dispatch. An unknown scope key is **rejected, not dropped** — silently ignoring `regionn` would export a wider scope and look successful. |
| `excel.py` | 328 | openpyxl writer. Typed cells, number formats, frozen headers, autofilters. Knows nothing about the business. |
| `pdf.py` | 376 | reportlab platypus writer. Substitutes `₹` → `Rs.` because none of reportlab's bundled fonts carries U+20B9; Excel keeps the real symbol. Renders through `app/tpo/formatting.py` so the PDF can't disagree with the screen. |
| `adapters.py` | 1,394 | Five module adapters. Each calls the **same service function the screen calls** and copies figures across — grep for arithmetic and you find rounding for display and nothing else. |

The five report modules: `command-center`, `simulation-investigation`,
`simulation-general-optimization`, `simulation-target-rescue`, `decision-center`.
Only modules with a real, computed source of truth are registered; purely
administrative screens are deliberately absent.

### 9.6 Store — `backend/app/store/` (5 files)

**Every write in the project lives in this package**, and `test_store_persistence.py` enforces it: no module outside `app/store/` may contain `sqlite3` or an `INSERT`.

| File | Lines | Purpose |
| --- | --- | --- |
| `db.py` | 183 | SQLite connection (per-thread, WAL, autocommit) + the schema. 5 tables; `scenario_results` and `decision_versions` are **append-only**. Every `owner` is NULL, deliberately. |
| `fingerprint.py` | 111 | SHA-256 over the exact bytes of every source CSV, in fixed filename order — the only thing that reliably identifies the data is the data. The filename is hashed too, so moving content between files is a different dataset. Never supplied by a client. |
| `repository.py` | 506 | The only module that reads/writes scenarios and decisions. Optimistic concurrency via `expected_version` → 409. A stale record is **reported, never resolved**. |
| `reports.py` | 351 | The Report Center store. Artifacts held as blobs in the row so a delete is atomic and no filesystem path is ever exposed. Deliberately **not** append-only — a report is a derived artifact. `READY` is never written without bytes. |
| `__init__.py` | 23 | Documents the four-module split and the persistence invariant. |

**Schema (5 tables):**

| Table | Key columns | Notes |
| --- | --- | --- |
| `investigations` | `id, natural_key UNIQUE, investigation_type, question, scope_json, source, owner, created_at` | Found again by natural key (SHA-256 of type + question + filter state) so the same question over the same scope does not mint a second. |
| `scenarios` | `id, investigation_id, name, scope_json, current_version, owner, timestamps` | Mutable only in `name` and `current_version`. |
| `scenario_results` | **PK (scenario_id, version)**, `payload_json, dataset_version, created_at` | **Append-only.** One row per save. |
| `decisions` | `id, investigation_id, scenario_id, scenario_name, current_version, owner, timestamps` | This id is the one a person cites. |
| `decision_versions` | **PK (decision_id, version)**, `record_json, dataset_version, created_at` | **Append-only.** `record_json` is the B7 record verbatim. |

Payloads are stored **whole in a single column**, never shredded per-metric — a KPI
split across columns would be a second representation of a number the engine already
computed, and the first time the two disagreed the store would be lying.

---

## 10. File-by-File Reference — Frontend

React 19 + TypeScript SPA. The rule enforced throughout: **the frontend calculates
nothing.** Every business figure arrives from FastAPI with its own display string; the
client renders, re-orders the pre-computed, and routes state between modules.

### 10.1 Build & entry

| File | Lines | What it does |
| --- | --- | --- |
| `package.json` | 30 | 5 runtime deps, 9 dev. No UI kit, no chart library, no form library, **no test runner**. Charts are hand-rolled SVG. |
| `vite.config.ts` | 21 | React + Tailwind plugins. Dev :5173, proxy `/api` → `127.0.0.1:8100`. Prod is same-origin, so `API_BASE = "/api"` works unchanged in both. |
| `src/main.tsx` | 19 | `StrictMode` → `QueryClientProvider` → `ToastProvider` → `ConfirmProvider` → `App`. StrictMode's double-mount causes several documented workarounds in the pages. |
| `src/App.tsx` | 44 | Router only. **HashRouter** deliberately — routes match the vanilla predecessor's `#/command` URLs verbatim, so `nav.json` needed no changes. 12 routes; all but `/login` wrapped in `<RequireAuth>`. |
| `src/index.css` | 283 | Tailwind v4 CSS-first config. `@theme` aliases tokens into Tailwind namespaces (brand colors are named `brand-*` because bare palette names silently suppress utility generation). Keyframes incl. a damped 6-step `bellSwing` pivoting at the bell's hanger. `.cc-ambient` is pinned `right:0` — a negative right was the page's only source of horizontal scroll. |
| `src/styles/tokens.css` | 228 | The single source of truth for colour, radius and shadow. `@theme` only *references* these; it never redefines a value. |

**The dark theme is one block.** Because Tailwind v4 keeps the `var()` in the emitted
CSS rather than inlining it, redefining a token under `:root[data-theme='dark']`
re-themes every component that already uses it — so no page or shared component is
edited and none can drift. It is explicitly **not an inversion**: status colours keep
their meaning and are only lifted for legibility, pastel backgrounds become low-alpha
washes (a pastel block on `#141B2E` reads as a glowing panel), and the brand hue steps
up to `#8C6EFF` because `#6B47FF` is near the readability floor on a dark card. Brand
identity, spacing, radii and layout dimensions deliberately do not change — *a theme is
a palette, not a redesign.*

### 10.2 `src/lib/` — API and pure logic

| File | Lines | What it does |
| --- | --- | --- |
| `api.ts` | 77 | The single fetch layer. `ApiError` carries `status`. `apiFetch`/`apiPost`/`apiUpload` (sets no Content-Type so the browser generates the multipart boundary)/`apiDelete`, all funnelling through `unwrap` → `detailOf`, which flattens FastAPI's 422 field-error array to `"field.path: msg; …"`. |
| `queryClient.ts` | 11 | `staleTime: 30_000`, `retry: 1`, `refetchOnWindowFocus: false`. |
| `labels.ts` | 33 | `calendarYear()` — Command Center display policy only: `F25` → `2025`. A display-side rewrite rather than a change to the shared backend `fiscal_label`, which would relabel four other modules. |
| `askWhy.ts` | 109 | The Command Center → Investigations hand-off contract. `AskWhyIntent.id` is minted **per click** because comparing question *text* meant clicking the same alert twice read as already-run and did nothing. |
| `portalConnectors.ts` | 146 | Connector plumbing. Accepts both `{detail}` and legacy `{error}`. **Azure Blob is backend-free** — real browser→Blob REST, because Blob supports CORS. `loadMsal()` lazily injects MSAL from a CDN for Power BI AAD sign-in. |
| `decisionCandidates.ts` | 579 | **Pure functions only.** Converts each module's response into a common `DecisionCandidate` and ranks them. |

#### `decisionCandidates.ts` — the ranking rules

- **`DIRECTION`** — `trade_spend`/`cannibalization` = lower; sales/units/roi/margin/pei = higher; **discount depth and duration are `neutral`** — they are *settings*, not outcomes.
- `candidateFromOptimization` returns **null** unless `status === 'optimized'`, and carries only 3 metrics — deriving ROI/margin would invent the figures the ranking runs on.
- **`rankCandidates`:** only metrics **every** candidate reports may vote (a metric one is missing is still shown but does not score). Bands rank at their **low** end. One point per scenario beaten, unweighted.
- **Risk does not vote and is not shown** — the risk engine computes no score, so ranking it would imply a comparable number.
- A winner requires **≥2 criteria, at least one higher-is-better** — otherwise "the only shared figure is trade spend" would crown the cheapest plan. Ties break on **ROI only**; an unbreakable tie returns `winnerId: null`.
- **`explainWinner`** returns `{strengths, caveats}` — losses are collected too, because a case listing only strengths is advocacy.

### 10.3 `src/store/` — Zustand (10 stores)

| File | Lines | Persisted | Purpose |
| --- | --- | --- | --- |
| `commandFilters.ts` | 244 | no | THE one filter state for the Command Center |
| `activeInvestigation.ts` | 175 | ✅ v2 | Active investigation + workspace pointer + CC scope hand-off |
| `simulationScenarios.ts` | 219 | no | Scenario cards, levers, results |
| `targetRescue.ts` | 114 | no | Target Rescue controls |
| `intelligenceHandoff.ts` | 102 | no | Promotion Intelligence → Simulation |
| `generalOptimization.ts` | 95 | no | Simulation mode enum + optimizer controls |
| `decisionDraft.ts` | 82 | no | Simulation → Decision Center draft |
| `theme.ts` | 69 | ✅ | light/dark |
| `decisionCandidates.ts` | 65 | no | The Decision Center comparison board |
| `savedRefs.ts` | 62 | ✅ | Server-minted ids (pointers only) |

**`commandFilters.reconcile(options)`** is the correctness guarantee. It replaced a
hand-written parent→child cascade that let **138 contradictory states** survive. It is
*symmetric* — it only asks whether a value is still offered — with `lastTouched` pruned
**last** so the filter you just clicked wins. Termination is documented: passes only
remove values, and an unchanged pass returns the **same object identity** so React Query
isn't re-triggered (no update→refetch→reconcile loop). `toQuery()` repeats arrays and
omits empty lists, so "unconstrained" is never confused with "constrained to nothing".

**`activeInvestigation`** holds workspace state rather than the page, because navigating
away unmounts it and destroyed a finished run's pointer. It is a **pointer, not a copy**.
`InvestigationScope` separates `identifiers` (real ids the source provided) from `labels`
(display-only, never converted back into codes).

**`simulationScenarios`** keeps `seededLevers` as a **separate copy** so Reset returns
each scenario to *its own* start. `patch()` is the single place scenario isolation is
enforced. `status: 'simulated'` is set in exactly one place, only with a response in hand.

**`intelligenceHandoff.proposedDiscountPct`** is deliberately strict: a number only when
the lever is `discount_depth` **and** the prose contains exactly one number **and** it
carries `%`. `"10–12%"`, `"shift spend to Modern Trade"` and `"reduce depth"` all yield
`null` — a number on the slider reads as advice.

**`decisionDraft.draftSignature`** is built from identity + treatment, not payloads.
Simulation Studio drops the draft the moment it stops matching, so a decision record can
never describe a changed scenario.

**`theme`** applies `data-theme` in `onRehydrateStorage`, not from a render, so a reload
doesn't flash the light palette.

### 10.4 `src/hooks/` — data access (21 files)

| Hook | Lines | Endpoints |
| --- | --- | --- |
| `useNav.ts` | 24 | GET `/nav`, `/user`, `/focus` |
| `useMisc.ts` | 20 | GET `/calendar`, `/connections`, `/settings` |
| `useAuth.ts` | 51 | GET `/auth/me`; POST `/auth/login`, `/auth/logout` |
| `useDatasets.ts` | 45 | GET/POST/DELETE `/datasets` |
| `useCommandCenter.ts` | 200 | `/command-center/*` (7 hooks) |
| `useInvestigations.ts` | 54 | `/investigation-types`, `/investigations/*` |
| `useInvestigationRun.ts` | 39 | POST `/investigations/run`, GET `/investigations/runs/{id}` |
| `useInvestigationContext.ts` | 70 | POST `/simulation/context` |
| `useIntelligence.ts` | 28 | `/intelligence-default`, `/intelligence/{type}` |
| `usePromotionIntelligence.ts` | 102 | `/promotion-intelligence/*` |
| `useSimulation.ts` | 180 | `/simulation/{run,simulate,compare,recommend,weekly,risk}` |
| `useOptimization.ts` | 40 | `/simulation/general-optimization[/scope]` |
| `useTargetRescue.ts` | 71 | `/simulation/target-rescue[/scope]` |
| `useDecision.ts` | 22 | POST `/decision/record` |
| `useDecisionBrief.ts` | 54 | POST `/decision/brief` |
| `useBriefing.ts` | 55 | POST `/decision/briefing` |
| `useStore.ts` | 93 | `/store/scenarios`, `/store/decisions` |
| `useReportCenter.ts` | 145 | `/reports*` |
| `usePromotionCalendar.ts` | 52 | `/promotion-calendar/{matrix,cell,upcoming}` |
| `useAlertHandoff.ts` | 89 | (navigation only) |
| `useElementSize.ts` | 21 | (ResizeObserver) |

**Notable behaviours:**

- **`useAuth`** — the session is an httpOnly cookie. `useCurrentUser` retries everything **except a 401** (only a 401 means signed out, and it's final) and uses `staleTime/gcTime: Infinity` with `refetchOnMount: false` — without this it inherited the 30 s default and refetched on every page mount, where one hiccup bounced the user to `/login` mid-session.
- **`useCommandCenter`** — a documented **two-scope split**. `key()` uses year+currency only, so chart caches survive a Channel/Product change; `fullKey()` uses every filter. Every query is gated on `initialised`, because the default year isn't known until `/filters` answers. All use `placeholderData: (prev) => prev`.
- **`useSimulation`** — `useSimulateScenario` **must** be called with `mutateAsync`: several scenarios can be in flight, they share one observer, and a second `mutate` overwrites the first's `onSuccess`, stranding a card on "Running…" forever. Deltas are computed server-side because *which* delta is valid depends on the metric type (a difference in multiples for ROI, points for margin, absolute + % for money).
- **`useReportCenter`** — enforces **generate ≠ download**. `downloadArtifact` is the only file-saving path; it rejects a zero-byte blob because an empty workbook reads as "we measured nothing".
- **`useDecisionBrief`** — `retry: false`; a failed AI call won't succeed on an immediate identical retry, and a retry loop against a paid API is the wrong default. `briefFailure` distinguishes 503 (no key) from 502.
- **`useAlertHandoff`** — builds **one** narrowed FilterState and sends it to **both** consumers (the Simulation store and the router's `askWhy` state). The **week stays a label**: Incremental Sales is measured against the selection's non-promoted rows, and a week-narrowed scope has none, reporting 0.0 instead of the row's real ROI.
- **`useInvestigationContext`** — `investigation_started: list.length > 0` is load-bearing: it lets the backend refuse to report the store's seeded example question as the user's own. No KPI value is ever sent.
- **`useStore`** — saves are mutations, loads are queries with `staleTime: Infinity` (a stored version is immutable). `useClearDecisions` is flagged as **the one destructive action in the application**.

### 10.5 `src/pages/` — 12 pages

| Page | Lines | Purpose |
| --- | --- | --- |
| `Login.tsx` | 94 | The unguarded entry. First sign-in for an email creates the account; after that the password is genuinely checked. |
| `Home.tsx` | 195 | The portal. `ModuleGrid` (six modules, TPO live) + `ConnectorRail` + five modals. Marks Excel/Shared Drives connected from **real** `useDatasets()` data, not a hardcoded flag. |
| `PlaceholderPage.tsx` | 36 | Template for an unbuilt route; no longer referenced. |
| `Connections.tsx` | 81 | Catalog of the four connectors Home offers. Connect hands off to `/home`, which owns the modals and session state, rather than faking a connection. |
| `Settings.tsx` | 120 | Shows the **signed-in user's** name and email, not a persona from `settings.json`, and states plainly "Signed in locally — no identity provider, nothing here is verified". Integrations carry "Not connected" pills rather than the fictional green "Active" ones they replaced. |
| `Calendar.tsx` | 232 | Year → Month → Channel → Promotion matrix. A **plan, not a diary**. Channel options come from `all_channels` (the full roster), or picking CH001 would make the others unreachable. |
| `Reports.tsx` | 586 | The Report Center — the library, and **the only place the app saves a file**. Every row is a real artifact; the page it replaced had six seeded fake rows. |
| `CommandCenter.tsx` | 631 | The observation layer and the origin of both RCA hand-offs. |
| `Investigations.tsx` | 853 | The investigation workspace. |
| `Intelligence.tsx` | 644 | The layer *below* an investigation: mechanism, where it bites, what it's worth. |
| `Simulation.tsx` | 1130 | The Simulation Studio, three modes. |
| `Decision.tsx` | 1498 | The Governed Decision Center — an assembly, not a dashboard. |

#### `CommandCenter.tsx` (631)

Four render branches: **skeleton** (laid out as the real grid so nothing jumps —
`initialised` is part of the condition because the queries are *disabled* until the year
is known, which would otherwise fall through to the error branch), **error**, **empty**
(`row_count === 0` → the filter bar plus a clear action, not a grid of zeros), and the
full page. The period defaults to `Math.max(...years)` — never a hardcoded year a future
extract might not have.

`worstPromotions` is a **client-side re-ranking** by worst ROI then largest trade spend —
no figure is recomputed, only re-ordered. The header row carries `relative z-20` because
`.fade-in` animates opacity and therefore establishes a stacking context that would trap
the More Filters popover beneath its later siblings.

#### `Investigations.tsx` (853)

`launch()` uses **`mutateAsync`** — `mutate`'s callbacks are dropped when StrictMode
tears down the observer, so an *effect*-initiated launch (i.e. every "Ask why" hand-off)
fired the POST and lost `setRunId`, leaving the page polling for nothing. Failures are
*recorded* as `launchError` as well as toasted, because a faded toast is not a readable
state.

The hand-off effect keys on `intentKey` and checks the **store-backed**
`launchedIntentKey`, so Back replays the state without re-running the investigation. A
**404 on a restored `runId`** (the store outlives the backend's 50-run window) triggers
`clearRun()` plus a toast rather than an eternal "Planning…". `OutOfScope` is the
documented fix for *"Who is shahrukh khan"* returning a confident root cause about his
promotions.

#### `Intelligence.tsx` (644)

Deliberately has **no filter bar** — it inherits the investigation's scope, and
re-scoping is the Command Center's job. Seven tabs, each lazily pulling its own fact
section. The Incremental Sales target multiple is *derived from* `target_roi` rather
than a hardcoded "1.5×".

`withoutCannibalization()` is a **display filter only**: the card was removed from this
page but the Advisor kept writing insights about the rate. `openInSimulation()` carries
the handoff **and** calls `setSimulationMode('investigation')` — the studio remembers the
last mode, and the other two modes would silently ignore everything carried across.

#### `Simulation.tsx` (1130)

Scope resolves as `handoffFilters ?? investigationScope?.filters ?? commandFilters`.
**Every hook runs in every mode** — the branch is in the JSX, not around the hooks — so
switching back is instant and each mode's store keeps its own scope.

Each keyed effect holds a guard ref and **clears it on cleanup**. This is the documented
StrictMode fix: react-query's MutationObserver has `onUnsubscribe` but no `onSubscribe`,
so a request fired on the discarded pass returns 200 to a listener nobody holds, and the
page hangs on "Calculating baseline KPIs…" forever.

`onRun()` captures the requested id/name/scope **before** starting, then applies two
guards: discard if `scopeKey` has moved on, and **refuse** (via `failRun`) if
`data.scenario_id !== requestedId` — putting one scenario's KPIs under another's name is
called out as the single most damaging thing the page could do. `exportScope`/
`exportOptions` read each mode's store via `getState()` **at click time**, so a Target
Rescue export can never carry the optimizer's plan.

#### `Decision.tsx` (1498)

The header docblock enumerates everything removed from the authored predecessor:
`decision.json`'s ROI of 2.55, an "89% data confidence", strategy rows for two
unsupported levers, "Budget Compliance — Compliant" against thresholds that don't exist,
and an approval animation claiming finance had been notified. **Recommended ≠ approved:**
`approved` is always false.

`RecordView` renders in the order a decision is *read*: Context → Recommended Plan →
Strategy → Impact → Comparison → Governance → Readiness → Evidence → **AI Brief** →
Actions. The brief sits *after* the evidence so a reader meets the computed record first,
and it is generated **on click only** — no effect fires it, so page readiness never
depends on an external service.

- **`BriefingPreview`** renders `response.html` in a **`sandbox=""` iframe** — the artifact itself, never a second React re-layout that could disagree with it.
- **`ExcludedRowsNote`** — *"the most dangerous number on this page is a zero nobody explained."*
- **`RecommendedPlanSection`** prints the recommended scenario's **name** resolved from the comparison — it used to print `scenario-b` at a commercial director.
- **`StoredBanner`** — staleness is **reported, never resolved**.
- **`ErrorState`** distinguishes **422** (payloads describe different things; retry can't fix it) from everything else.

`persistDecision()` appends `expected_version` **only** to the decision this browser
owns, so a 409 protects unseen work. A reopened decision exports its **stored bytes**
rather than re-assembling against today's dataset.

### 10.6 `src/components/ui/` — design-system primitives (24 files)

All ports of the vanilla `css/components.css`. Nothing here fetches data.

`index.ts` (barrel), `Badge` (12), `Chip` (11), `Spinner` (8), `Pill` (37), `Button` (45),
`IconButton` (27), `BrandLogo` (33), `ThemeToggle` (36), `LiveStatus` (28), `Kpi` (46),
`Tabs` (46), `Card` (47), `Table` (39), `Field` (64), `Modal` (41), `Dropdown` (92),
`SidePopover` (52), `InfoPopover` (121), `TpoKpi` (158), `AlertBanner` (72),
`RiskList` (60), `Toast` (67), `Confirm` (67).

**Worth knowing:**
- **`Dropdown`** portals its menu to `document.body` with `position: fixed` at the trigger's `getBoundingClientRect()` — deliberate, because ancestors animating `opacity`/`transform` create stacking contexts that would trap an absolutely-positioned menu under sibling cards.
- **`InfoPopover`** is the single "ⓘ" affordance. Opens on hover **and** focus; a click *pins* it (so it works on touch and keyboard); flips above the trigger only when there genuinely is no room below. Replaces the native `title` attribute.
- **`TpoKpi`** — `trend: null` omits the arrow entirely rather than defaulting to a direction, and `lowerIsBetter` separates *direction* from *desirability* via `isGood = (trend === 'up') !== lowerIsBetter`. `[animation-fill-mode:backwards]` is load-bearing: `fade-in-up` ships `both`, whose final `translateY(0)` would beat the hover lift.
- **`CardHeader`** has `min-h-[63px]` so two side-by-side cards start their content at the same y regardless of whether the actions slot holds a control or plain text.
- **`AlertBanner`** — the CTA calls `stopPropagation` *and* `preventDefault` and invokes `onClick` itself; without that the Link navigated while the banner's handler never ran, so the CTA arrived with no scope handed over.

### 10.7 `src/components/charts/` — SVG primitives (9 files)

Hand-rolled SVG, no charting library. `useChartWidth` (24) adds a `ResizeObserver` so
charts stay correct across sidebar collapse and viewport resize.

`Sparkline` (82), `Donut` (46), `DonutBreakdown` (93), `DualLine` (94), `GroupedBar` (122),
`Forecast` (136), `Waterfall` (159), `ComboBarLine` (161).

`Waterfall` runs a cumulative accumulator where `base`/`total` bars start at 0 and reset
the running total. `ComboBarLine` puts ROI on a fixed left axis and Amount (Cr) on a
data-derived right axis.

### 10.8 `src/components/layout/` (3 files)

- **`AppShell.tsx`** (52) — content inset is **one number at every width**: `md:pl-[var(--sidebar-w)]`. Replaced a three-way rule that existed to serve a sidebar that changed width under the pointer.
- **`Topbar.tsx`** (90) — sticky 62px header. The Help button was removed (it opened a toast promising a nonexistent help centre).
- **`Sidebar.tsx`** (310) — a **static** 224px column that never changes width. It used to collapse to a rail and expand on hover, so labels appeared mid-read and content reflowed; a later revision held it open on the Command Center only, making the chrome disagree between routes. The keyboard-focus tooltip is **portaled to body** so neither `overflow-x-hidden` nor the nav's scroll container can clip it.

### 10.9 `src/components/command/` — Command Center (12 files)

| File | Lines | Notes |
| --- | --- | --- |
| `riskRanking.ts` | 74 | Pure ranking kept apart so the panel, the hero banner and the bell read **one** definition. Ranks by **severity band then financial impact** — ranking by ROI alone filled the Critical tab with tiny 5%-discount events. `ALERT_FETCH_LIMIT` is the whole set, because the endpoint emits one concatenated list and truncates the tail. |
| `States.tsx` | 142 | `Stale` marks React Query `placeholderData` as provisional rather than letting last scope's numbers read as current. `EmptyState` deliberately isn't "₹0" — zero is a real KPI answer. `ErrorState` prints the actual error, never silently falling back to stale values. |
| `ChartFrame.tsx` | 127 | **Order matters: error beats empty beats loading** — a failed request must never be reported as "no data for these filters". `controls` sit outside the loading swap so they keep their position during a refetch. |
| `RankedBar.tsx` | 104 | A **ranking, never a composition** — Incremental Sales isn't additive across groups, so each row scales against the largest bar, not a total. |
| `ScatterQuadrant.tsx` | 142 | **Linear ROI axis deliberately** — ROI is legitimately negative and a log scale can't represent that. The dashed target line reads `meta.target_roi`; nothing hard-codes 1.5. |
| `PromotionMixCard.tsx` | 141 | Groups by **mechanic, not offer** — the 20% seasonal mechanic is six `Promotion_Id`s sharing one name, so grouping by offer scattered the largest 2024 mechanic across six slices. |
| `MultiSelect.tsx` | 237 | Can't reuse `Dropdown` because that closes on every pick — three channels would be three round-trips. `SelectionChips` are individually removable, because a comma-joined string reads as one ambiguous value. |
| `FilterBar.tsx` | 310 | **Escape-only close, deliberately:** every control inside portals its menu to `document.body`, so a click-outside handler would close the panel out from under an in-progress selection. Distributor is hidden below 2 useful options. |
| `NotificationBell.tsx` | 284 | Reads the **same** hook and ranking as the panel below, so it costs no extra request and can't disagree. **The bell itself is the indicator** — no badge or count: it *rings* while alerts exist, pauses while open, and is inert at zero. The count is stated in `aria-label`. **No relative timestamp** is rendered, because the API carries only a business week. |
| `RiskAlertsPanel.tsx` | 275 | **Two ways in, one hand-off** — a severity is a band, not an event, so no identifier is ever derived from the word "Critical". Rows are `<button>`s so they're keyboard-operable. |
| `TrendPanels.tsx` | 242 | **ROI is never plotted against the money axis.** `niceStep()` walks a finer ladder than the usual 1/2/5, because an ₹8.3 Cr peak would otherwise round to a ₹20 Cr axis and squash the series into the bottom 40%. **Null ROI is never drawn as zero** — the series is split into runs of consecutive non-null points. |
| `ChartSections.tsx` | 953 | Six chart sections. **`TopPerformingSection`** carries three documented guards, because raw ROI ranking is structurally degenerate — `ROI = u(1−d)/((1+u)(d+c))` means the shallowest discount always wins, filling all ten rows with "5% Discount": (1) drop events below the **median** trade spend of the eligible population, computed per render; (2) dedupe on promotion+channel+period; (3) a hard cap of 2 rows per mechanic, leaving spare slots empty rather than handing them back. |

### 10.10 `src/components/decision/` (6 files)

- **`CandidateBoard.tsx`** (541) — **compares; does not compute.** Every figure is the string its own engine formatted; the only thing produced here is the *order*, and the rule that produced it is printed above the result. "Add Scenario" sets `setMode` **before** navigating, because the studio remembers its last mode.
- **`ComparisonSection.tsx`** (228) — renders `/compare` verbatim. Every scenario column shows **both ends of the approved uplift range**, never a midpoint. Excluded scenarios are listed with their reason, because a zero would read as "we evaluated this and it came to nothing".
- **`DecisionHistory.tsx`** (209) — **headers only**, so opening one is a second request by id, which guarantees the record shown is read back from the store rather than reconstructed from a summary. **No owner column** — the app has no auth, so inventing "Created by" would fabricate attribution.
- **`EvidenceSection.tsx`** (176) — the traceability surface, deliberately a *section* rather than a tooltip, because a cited decision must be findable later. Ids that don't exist yet print "Not saved".
- **`StrategySection.tsx`** (210) — three columns, three kinds of fact, labelled: **Current** is measured, **Selected** is the scenario's setting, **Recommended** is the chosen treatment depth. A lever with `modelled: false` is marked as such.
- **`AiDecisionBrief.tsx`** (145) — prose *beside* the deterministic evidence, never instead of it. **Nothing runs on load.** Failure is a card state, never a page state; Save Decision is never blocked by it.

### 10.11 `src/components/simulation/` (12 files)

- **`LeverPanel.tsx`** (510) — the heaviest doc block in the codebase. Discount is a slider over the approved *points*, not a numeric range, so no handle position means 7%. **0% is a stop and explicitly not a treatment** — offered because "run no promotion" is a real question, but no approved uplift band exists for it. **Trade Spend is not editable** — it's an output. **Duration is selectable and still not modelled**, and the badge says so.
- **`ScenarioResultPanel.tsx`** (269) — two columns, because the approved rule is a *band*: PR002 is approved for 25–35% uplift, not 30%. Explicitly **not** a confidence interval.
- **`RiskPanel.tsx`** (440) — keeps **evidence**, **governance gap** and **action** visibly apart. No score, no traffic light, and never "safe" or "good".
- **`RecommendationPanel.tsx`** (357) — **"Under the current decision policy" sits in the header, not a tooltip** — swap the policy and a different scenario wins. No ranked list, no 1st/2nd/3rd, no score.
- **`ComparisonTable.tsx`** (254) — built so comparison cannot quietly become recommendation: **no green/red on deltas** (colouring encodes better/worse and `preference` is null on every metric), **no sorting**, **no midpoint**.
- **`WeeklyImpactPanel.tsx`** (341) — a decomposition, not a forecast. The band is drawn with **deliberately no middle line**, because the approved uplift range has no expected value.
- **`RecommendationHandoffCard.tsx`** (86) — **states what was pre-set and what was not**: a control that moved for unexplained reasons is indistinguishable from advice nobody gave.
- **`panels.tsx`** (223) — the comparable-event count travels *with* the rate, because a rate's meaning depends on how many events stood behind it.
- Plus `ContextBar` (171), `CurrentPlanPanel` (62), `ScenarioRow` (114), `TrendChart` (59).

### 10.12 `src/components/investigations/` (9 files)

- **`cannibalizationNode.ts`** (47) — every other node's headline comes from the specialist's free-text `metric`; cannibalization has **one** defined number. Binding to prose let three things through: the raw field name printed as a value, an empty figure where a computed one existed, and a figure that *contradicted* the computed one.
- **`graphLayout.ts`** (72) + **`InvestigationGraph.tsx`** (152) — nodes evenly spaced around an ellipse; edges land just outside the centre hub rather than at its exact centre. **One transform for the whole stage**, so edge geometry never has to know a zoom exists.
- **`ProgressStrip.tsx`** (76) — two documented corrections: the "Confidence Score" tile was removed (it printed 82% / "↑ +6 pp vs last run" that nothing computes), and "Total Records Analyzed" now reports rows in the investigated **scope** rather than the whole fact table.
- **`ActiveInvBanner.tsx`** (64) — the proceed props are **optional and deliberately omitted** where a plain link would be wrong: on a page whose action must *carry* state, a second same-labelled button would land the user on an empty page.
- Plus `NodeDetailPopover` (84), `AccelList` (68), `BizQuestionCard` (62), `QueryBar` (50).

### 10.13 `src/components/intelligence/` (8 files)

- **`answerFormat.ts`** (70) + **`useStreamedAnswer.ts`** (82) — types the synthesis in character-by-character with tone-aware runs and punctuation-aware pacing. A module-level `Set` means each investigation type streams **once per session**.
- **`AiAnswerCard.tsx`** (80) — two documented removals: the **source pills are gone** (SAP/NielsenIQ/DMS/Retail Exec were a hardcoded array claiming provenance nothing records), and the confidence badge is gone (it printed an authored 82–87%).
- **`SaturationChart.tsx`** (70), `SalesTrendChart` (63), `RegionVarianceBars` (48), `KeyInsightsList` (52), `tabs.tsx` (397, eight tab bodies).

### 10.14 `src/components/calendar/` (4 files)

- **`statusColors.ts`** (104) — **the** promotion-status palette, one definition imported by cells, legend, details and the Upcoming feed. Deliberately **not** the app's theme tokens: those serve KPI and alert surfaces and shift with them, while the calendar's four statuses are their own semantic set. Colour is never the only signal — every cell states its name, ids and product count.
- **`PromotionMatrix.tsx`** (194) — **one reusable component for every channel**, never one calendar per channel, so a promotion in October lines up across channels by eye. The channel header is `sticky left-0` because a horizontally-scrolled row is otherwise unattributable.
- **`PromotionDetailPanel.tsx`** (237) — weekly channels additionally show a week-by-week breakdown, because October's Dussehra and Diwali stay two distinct weekly promotions and are never merged.
- **`UpcomingEventsPanel.tsx`** (123) — a **contextual** feed, never a fixed list, and never crosses into another year because the matrix beside it is a one-year plan.

### 10.15 `src/components/portal/` (13 files incl. `modals/`)

`connectors.ts` (14), `modules.ts` (54), `HeroArt` (34), `ModuleGrid` (57),
`ConnectorRail` (99), `AdvisorCard` (171), `modals/shared.tsx` (108), `UploadModal` (160),
`SapModal` (143), `NielsenModal` (183), `PowerBiModal` (166), `AzureModal` (165),
`DatabricksModal` (164).

- **`ConnectorRail`** — special connectors **can't be switched on blind**: turning one *on* opens its modal instead of toggling.
- **`AdvisorCard`** — `buildSystemPrompt()` composes the system message **from the `MODULES` catalog itself**, marking each LIVE or coming-soon, and instructs the model not to invent capabilities.
- **`UploadModal`** — files **genuinely upload**; previously this was a 1.1 s `setTimeout` and nothing ever left the browser. Handles partial success by naming the failures rather than silently dropping them.
- **`NielsenModal`** — a **generic REST shell**, because there is no single standardized public NielsenIQ API; nothing is guessed.
- **`AzureModal`** — direct browser REST, no backend, because Blob Storage supports CORS. The SAS token stays in `sessionStorage` only.

### 10.16 Remaining component groups

- **`optimization/Slider.tsx`** (74) — a **native `<input type="range">`** wearing the platform accent rather than a hand-built track: keyboard-operable, screen-reader-labelled and touch-correct for free. Endpoints are always rendered, because a slider whose range is off-screen invites reading the handle position as a value.
- **`optimization/GeneralOptimization.tsx`** (573) — **computes nothing**; every optimized figure is a band. A plan that couldn't be produced renders its reason, not a grid of zeros. Re-measures scope whenever category/channel/month move, because the ceiling slider can't be bounded until the historical average for *this* scope is known.
- **`rescue/TargetRescue.tsx`** (1150, the largest frontend file) — **two projections kept visually apart** in different cards, never blended into one headline: the run-rate projection (division, labelled as such) and the intervention ladder (a counterfactual under an approved treatment). Progress is counted in completed business weeks, and the checkpoint follows the channel's promotion cadence. No day figure is offered as a sales read.
- **`promotionIntelligence/SaturationChart.tsx`** (93) — **every point is a real mechanic**, so the x-axis is the actual set of depths the business runs (5/10/15/25%) rather than a smooth synthetic sweep, and the visible gap between 15% and 25% is information.
- **`promotionIntelligence/panels.tsx`** (347) — shared panels + `fmtCr` (a crore is the unit Indian trade finance reports in).
- **`reports/ExportReportButton.tsx`** (112) — the one generate control. **It does not download anything.** A single button rather than a format menu, because both artifacts are produced and the format choice belongs at the point of download. **Scope is resolved at click time** via callbacks, which is what makes "change a filter, generate again" produce a different report with no cache to invalidate.
- **`RequireAuth.tsx`** (26) — order is load-bearing: `if (user) return children` is checked **before** the error branch, so a background `/auth/me` failure can't throw an already-signed-in user back to `/login`.
- **`icons/`** (3 files, ~110 Lucide-style paths) and **`types/`** (30 files) — the largest type modules are `targetRescue.ts` (512), `simulation.ts` (294), `commandCenter.ts` (242), `decision.ts` (229), `optimization.ts` (223).

### 10.17 Cross-page data flow

```
Login ──▶ Home (portal, connectors, uploads)
             │
             ▼
        CommandCenter ──(useAlertHandoff / handOffPromotion)──┐
         │  commandFilters                                     │ activeInvestigation.scope
         │                                                     │ + router state askWhy
         ▼                                                     ▼
        Simulation ◀───────────────────────────────────  Investigations
         ▲   │  scope = handoff ?? invScope ?? commandFilters       │ runId
         │   │                                                      ▼
         │   │                                                Intelligence
         │   └──(intelligenceHandoff, setMode('investigation'))──────┘
         │
         │ decisionDraft.carry / decisionCandidates.add
         ▼
        Decision ──(useGenerateReport)──▶ Reports ──(downloadArtifact)──▶ file
```

### 10.18 Five recurring frontend conventions

1. Every business figure arrives with its own `display_value` and an `available` /
   `unavailable_reason` pair — the UI renders **the reason**, never a blank or a zero.
2. Mutations wherever there is a body or real request state; queries wherever a result is
   immutable (`staleTime: Infinity`).
3. Each cross-page hand-off is a dedicated session-only store carrying **results, never
   calculations**, invalidated by a signature.
4. `mutateAsync` is mandatory wherever concurrency or effect-initiated calls are possible,
   and every keyed effect clears its guard ref on cleanup for StrictMode.
5. **Portal-to-body for every floating layer** (`Dropdown`, `MultiSelect`, `InfoPopover`,
   `SidePopover`, `NotificationBell`, the Sidebar tooltip), because the app's entrance
   animations animate `opacity`/`transform` and therefore establish stacking contexts.

---

## 11. Data, Scripts, Tests

### 11.1 The six CSVs

Covered in §3. Row counts: fact **205,920**; dim_date 882; dim_geo_store 509;
dim_product 36; dim_promotion 18; dim_channel 5.

**Channel row split:** CH001 37,440 · CH002 37,440 · CH003 37,440 · **CH004 56,160** ·
CH005 37,440.
**Promotion split:** 146,070 unpromoted (`-1`, 70.9%) · 46,530 promoted.
**Grain:** exactly one row per `(Product_id, Store_Id, Year, Week)`.

**Catalogue:** 3 categories × 3 brand forms each × 4 pack sizes = 36 SKUs.
Fabric & Home Care (Laundry Detergent, Fabric Conditioner, Dryer Sheets), Baby Care
(Taped Diapers, Baby Wipes, L_Diapers), Health Care (Toothpaste, Toothbrushes,
Cough & Cold).

**Derived economics in the data:** `Total_Cost = round(0.65 × Base_Revenue)` (65% COGS);
`Promotion_Cost = round(0.03 × Base_Revenue)` on promoted rows.

**The seasonal calendar** carries six festivals × two years — and the **mechanic differs
by year**: 2024 ids (`PB*24`) are the 20% price cut (PS001); 2025 ids (`PB*25`) are
Buy3Get1 (PB001). Events: New Year, Holi, Summer, Independence, Dussehra, Diwali.

Two departures from a textbook star:
1. **The date conformance is broken and worked around** — there is no clean `Date_Key`;
   the only sound path to a month is through `Week`. (`fact.Date` disagrees with its own
   `(Year, Week)` on ~25% of rows.)
2. **`Channel_Id` is a snowflake shortcut** — it sits on both the fact and
   `dim_geo_store`, which is what the breakdown "fast path" exploits.

Several `dim_product` cells carry **leading spaces** (`" Laundry Detergent"`), which the
loader's `_clean()` strips — otherwise one brand splits into two filter options.
`dim_promotion_final.csv` carries a **UTF-8 BOM**, which is why the loader reads with
`utf-8-sig`.

### 11.2 `scripts/` — 9 Python + 1 Node

All Python scripts put `backend/` on `sys.path` and import the **real** `app.tpo` engine,
so no script can compute a KPI differently from what the application shows. Most honour
`$TPO_DATA_DIR`.

**Auditors (read-only)**
- `audit_roi_realism.py` — ROI at three grains through the frozen engine; derives the break-even algebra rather than fitting it. Reads its rules back from `app/tpo/config.py`.
- `audit_seasonal_2024_vs_2025.py` — pairs the six seasonal events across years and diagnoses negative PB001 ROI.
- `diagnose_promotion_economics.py` — which economic driver in the generated data produces unrealistic ROI, given the engine is correct.

**Fixers (rewrite fact rows)**
- `regenerate_ch001.py` — CH001's source notebook **never applied a promotional uplift** (the word doesn't appear in it, while CH002–CH005 each carry an `UPLIFT_RANGES` table). Promotions moved price and cost but never volume (~0% measured uplift). Transforms the existing 37,440 rows in place rather than re-running the notebook, which would redraw every random factor.
- `fix_promotion_economics.py` — two giveaway defects, the same mistake twice: *volume was given away and never booked as investment.* **(A)** CH002 2024: 2,430 seasonal rows carry `Actual_Price == Base_Price` despite a "20% Discount", split purely by Product_id with zero overlap. **(B)** Buy3Get1 booked only the 3% overhead while one unit in four walked out free — ROI of 1210–1295% by channel.
- `represent_pb001_as_price_discount.py` — **the currently approved representation.** Moves the Buy3Get1 investment from the cost side to the price side (`Actual_Price = 0.75 × Base_Price`). Trade Spend is arithmetically identical either way (`0.28 × Base_Rev`); what changes is that incremental units are now valued at 75% of list, lowering Incremental Sales and therefore ROI. **Supersedes** `fix_promotion_economics.py`'s Defect-B treatment.
- `correct_ch002_f25_buy3get1.py` — **SUPERSEDED, marked DO NOT RUN.** Kept for the audit trail and its four-option comparison, which records the ROI each candidate treatment produced (free goods costed nowhere 540.1%; as a price effect 13.4%; as a cost 44.5%; COGS + 3% overhead 98.2%; COGS replacing the 3% 127.1%). Its 3%-rate guard aborts a re-run.

**Validators**
- `validate_fact_data.py` — checks A–G of the correction brief. Pins row count 205,920, the expected discount per treatment, and the approved uplift ranges — "frozen by the brief; never widened to make a run pass".
- `validate_promotion_schedule.py` — validates promotion *assignment*. Documents why the obvious fix fails: because the fact holds one row per (Product, Store, Year, Week), rewriting a stray row's Week **creates a duplicate grain rather than moving into a free slot**. A trial correction of 405 rows produced 405 duplicate grains and 36 grains carrying both a promotion and no-promotion; it was reverted. Every off-month assignment is classed **CLASS 2 / blocked** — the only correct repair is a swap with recomputed economics, which needs the original generator.

**Migration**
- `convert-data.mjs` — the one-off Phase 1 migration. Loads the vanilla prototype's `data.js` in a `node:vm` sandbox (shimming `window`, stubbing `localStorage`) and splits `window.DATA` into ~20 JSON files. Two things don't survive JSON: `lever.fmt` arrow functions become a `decimals` integer, detected by **regex on the formatter's own source** (probing it with a test value silently misreported no-op formatters); and the `getActiveInvType()` localStorage helpers are dropped entirely — client session state, not data, and now a Zustand store.

### 11.3 `backend/tests/` — 34 files

The suite asserts **invariants, refusals and provenance** rather than frozen numbers.

**Core engine (7 files)** — `test_command_center.py` (the 18 spec filter cases as
invariants), `test_breakdown.py` (a breakdown group returns exactly what filtering to
that value returns; only Trade Spend may carry a share), `test_filter_options.py`
(**soundness** — every option offered returns ≥1 row — **and completeness**),
`test_filter_reconciliation.py` (mirrors the frontend store's algorithm in Python,
since there is no frontend test runner), `test_month_semantics.py` (**perturbs the month
column in memory** and asserts nothing moves, which is stronger than comparing two
loads), `test_kpi_delta_precision.py` (deltas come from the unrounded pair — PEI as a
whole number made `(62−68)/68` answer the wrong question, moving deltas by up to 2.4 pp),
`test_response_model.py` (pins the five treatments **as literals** — *"a test that reads
its expectation from the code it is testing proves only that the code is
self-consistent"*).

**Simulation (12 files)** — scenarios, execution, comparison, recommendation, risk,
weekly, cannibalization scope, determinism, general optimization (×2), target rescue.
`test_simulation_determinism.py` proves there is **no import path**, transitively, from
any simulation module to the OpenAI client, and that identical requests produce
identical **bytes**. `test_target_rescue.py` is the largest file in the suite (82 KB).

**Investigations (4)** — `test_investigation_context.py` (refusals — RCA's chips claim
₹98.6 Cr where the engine measures ₹7.7 Cr), `test_investigation_handoff.py`,
`test_end_to_end_journey.py`, `test_decision_journey.py`.

**Decision Center (6)** — `test_decision_brief_ai.py` proves the model **cannot reach a
number it could recompute**: `projection()` sends display strings, so the two numbers
needed for a midpoint are never in the payload.

**Reports (2)** — `test_report_center.py` (generate ≠ download, asserted on content type,
body *and* the absence of `Content-Disposition`), `test_reports_export.py` (opens files
back with `openpyxl` and `pypdf` — *"a 200 proves nothing about a report"*).

**Cross-cutting (3)** — `test_store_persistence.py` (byte-for-byte read-back; history is
never rewritten; **no module outside `app/store/` may contain `sqlite3` or an `INSERT`**),
`test_unauthenticated_disclosure.py` (B11 was *deferred*, so what was done was
**disclosure** — the tests guard against the exposure staying while the honest warning
quietly disappears, **or the reverse**), `test_upstream_truthfulness.py` (scans claim
**shape**, not words, because the pages must discuss governance in order to deny it).

### 11.4 `backend/app/data/` — 21 JSON files

**Static content** (served via `data_loader.load`): `nav.json`, `user.json`, `focus.json`,
`command.json`, `investigation-types.json`, `investigations.json` (35 KB, the four RCA
node graphs), `intelligence-answers.json`, `pages-by-type.json` (43 KB, the largest),
`intelligence.json`, `simulation.json`, `decision.json`, `calendar.json`,
`connections.json`, `ai-watch.json`, `recommendations.json`, `settings.json`.

**Dead:** `reports.json` — no `load("reports")` call exists anywhere. Superseded by the
real Report Center, whose contract is that every row corresponds to a stored artifact.

**Runtime state** (written by the app): `auth-users.json`, `auth-sessions.json`,
`investigation-runs.json`, `investigation-history.json`.

A visible **legacy/live split**: `command.json`, `simulation.json`, `decision.json` and
`intelligence.json` are the pre-engine prototype payloads still served on legacy routes,
while the live modules compute from `Data/` through `app/tpo/`. `decision.json`'s
`governance[]` block is the source of the "Budget compliance OK" claims B9 removed, and
its `strategy[7]` block held the three invented levers.

### 11.5 `frontend/e2e/` — 4 `.mjs` files

There is no frontend test runner, so these drive **real headless Chrome over the Chrome
DevTools Protocol with zero dependencies** (Node 22+ ships a global `WebSocket`). All
default to `E2E_BASE=http://127.0.0.1:8011`.

- **`cdp.mjs`** — the shared library, not a test. Spawns Chrome into a temp profile, opens the WebSocket, correlates requests via an id→promise map, collects console errors, page exceptions and failed requests, and supports per-method CDP event handlers.
- **`concurrent-runs.mjs`** — a regression pin. `useSimulateScenario` is one *shared* mutation observer, and `mutate(vars, {onSuccess})` stores callbacks on the **observer, not the request** — so running A then B before A returned overwrote A's callbacks. A's request succeeded server-side and the client never heard: `applyResult` never ran and the card sat on "Running…" forever. Documents why this must be a browser test: **the store was never at fault, so a store-level unit test passes against the broken code.**
- **`concurrent-failures.mjs`** — the mixed success/failure companion: a failing run must settle its own card and **must not settle anybody else's**. Induces the failure with Chrome's `Fetch` domain, pausing each `/simulate` request, reading the scenario id from the POST body and failing exactly one. Nothing in the application is stubbed.
- **`full-platform.mjs`** — final QA in one real browser pass: Login → Command Center → RCA → Simulation (all three modes) → Decision → Calendar → Reports. Asserts each module loads, **settles** (a probe scans body text for ~14 spinner phrases) and shows no unexplained value. **Counts duplicate API requests per route.** Explicitly read-only: it writes nothing to the store.

### 11.6 Dependencies

**Backend** (`requirements.txt`, each entry annotated with *why*): fastapi, uvicorn,
pydantic, httpx, **openpyxl** (the xlsx writer named by the brief — *"a CSV renamed .xlsx
is not a workbook"*; doubles as the reader for uploaded .xlsx), **reportlab** (the pdf
writer), **pypdf** (test-only, reads generated PDFs back), pandas + python-multipart
(dataset ingestion), openai + python-dotenv (agents), pytest.

Notably **no auth dependency** — PBKDF2 is stdlib `hashlib`, and a test asserts this file
stayed clean.

**Frontend:** 5 runtime deps (react 19.2, react-dom, react-router-dom 7.18,
@tanstack/react-query 5.101, zustand 5.0) and 9 dev deps (vite 8, typescript 6.0,
tailwindcss 4.3 + its first-party Vite plugin, oxlint, types). **No test-runner
dependency** — which is exactly why the reconciliation algorithm is mirrored in Python
and the e2e harness is hand-rolled on CDP. `oxlint` (Rust) replaces ESLint; Tailwind v4
via the Vite plugin means there is no `tailwind.config.js` or PostCSS chain.

### 11.7 `TPO_DOCUMENTATION/` — 31 markdown files

14 at root (`00_PROJECT_OVERVIEW` … `12_CHANGE_HISTORY`, plus `README`), `appendices/` (5:
API_ENDPOINT_MAP, DATASET_MAP, FILE_MAP, KNOWN_LIMITATIONS, VALIDATION_MATRIX),
`modules/` (9, one per module) and `simulation/` (3, one per simulation mode).

Two worth knowing: **`06_API_REFERENCE.md`** (35 KB, every route by module) and
**`appendices/KNOWN_LIMITATIONS.md`** — the honest list, including that RCA/Investigations
and Promotion Intelligence *page content* is static, that Command Center filter reach
differs from the documentation in places, and that authentication/authorization on the
store is **[Deferred]**.

---

## 12. API Endpoint Map

**~80 endpoints across 17 routers.** Auth is applied on exactly three routers:
`datasets` (all 4), `intelligence` (all 5) and `investigations` (3 of 9). Every other
route is unauthenticated — stated openly in `store.py`'s docstring, in every affected
route's OpenAPI description, and in the README.

| Prefix | Endpoints |
| --- | --- |
| `/api/auth` | POST `/login`, POST `/logout`, GET `/me` |
| `/api/command-center` | GET `/filters`, `/kpis`, `/trend`, `/risk-alerts`, `/underperforming-promotions`, `/promotion-mix`, `/top-promotions`, `/breakdown` |
| `/api/promotion-calendar` | GET `/matrix`, `/cell`, `/upcoming` |
| `/api/simulation` | POST `/context`, `/run`, `/simulate`, `/compare`, `/recommend`, `/weekly`, `/risk`, `/general-optimization[/scope]`, `/target-rescue[/scope]` |
| `/api/decision` | POST `/record`, `/brief`, `/briefing` |
| `/api/store` | POST `/scenarios`, `/decisions`; GET `/scenarios/{id}`, `/decisions`, `/decisions/{id}`; DELETE `/decisions` |
| `/api/reports` | GET `/modules`, ``, `/{id}`, `/{id}/download/{fmt}`; POST ``; DELETE ``, `/{id}` |
| `/api/promotion-intelligence` | GET `/facts`, `/context`, `/runs`, `/runs/{id}`; POST `/analyze` |
| `/api/datasets` | POST, GET, GET `/{id}`, DELETE `/{id}` |
| `/api/proxy` | POST `/databricks/{warehouses,query}`, `/sap/odata`, `/powerbi/{workspaces,reports}`, `/generic/rest`, `/openai/chat` |
| `/api` (investigations) | POST `/investigations/{run,query}`; GET `/investigations/{runs,recent,legacy,{type}}`, `/investigation-types`, `/intelligence-answers/{type}` |
| `/api` (static) | GET `/health`, `/nav`, `/user`, `/focus`, `/command`, `/calendar`, `/connections`, `/ai-watch`, `/recommendations`, `/settings`, plus `pages.py`'s per-type routes |

**Error-code conventions, used consistently:**

| Code | Meaning in this codebase |
| --- | --- |
| **401** | No valid session. `/auth/me` returns this rather than `null`, so callers can't confuse loading with logged-out. |
| **404** | Not found — *also* used for a non-owner accessing a dataset, so existence can't be probed. |
| **409** | Version conflict. The request was well formed and would have been accepted a moment ago; the caller should reload rather than guess. Body carries `current_version`. |
| **422** | Well-formed but internally inconsistent or unsatisfiable — a section mismatch (naming the two sections), an unapproved discount, a scope holding nothing a treatment could replace. **A zeroed result would be the wrong answer.** |
| **502** | This endpoint did its job and the thing it depends on did not. |
| **503** | The server is working correctly and one optional capability is switched off. The message names the setting, never its value. |

---

## 13. Design Principles That Govern The Code

These recur across the whole repository and explain most of its structure.

**1. One definition, one place.**
One `roi_multiple()`. One `FilterState`. One `ReportDoc` feeding two writers rather than
fourteen bespoke generators. One `Promotion.label`. One promotion-status palette for the
Calendar. The Command Center's `by`/`metric` route regexes are built at import from the
service's own lists so they cannot drift. Where a rule genuinely is written twice
(`optimization._price_and_baseline` restating `aggregate._volume`'s baseline for a
population `_volume` skips), a test asserts the two agree — *"the duplication is guarded
by that test rather than by hope."*

**2. Never fabricate a number.**
`None`, never `0`. No midpoint from a band. No interpolation between approved treatments.
A missing key in a report table is **blank, not zero** — writing 0 would turn "not
measurable" into "measured as nothing". An undefined comparison renders `—`, because a
fabricated 0% reads as "no change", a different and false claim. Null ROI breaks the
trend line into runs rather than being plotted at zero.

**3. Compute, then present.**
Currency, magnitude and F24/F25 labels are display concerns applied once at the edge. The
canonical figure travels in `value`; only `display_value` is converted. **No KPI function
anywhere takes a currency argument.** ROI, PEI and cannibalization are never converted.

**4. Python computes, the model reasons.**
Agents never see raw rows and never do arithmetic. The AI brief's `projection()`
deliberately sends display strings, so the two numbers needed to compute a midpoint are
never in the payload. Graph layout is deterministic Python — asking an LLM for
coordinates produces overlapping nodes that drift between runs.

**5. State the refusal in the code.**
A recurring section header is *"WHAT THIS MODULE REFUSES TO DO"*. Risk assessment computes
no score because no threshold was ever approved — a metric with no boundary is reported as
a measurement plus a **stated governance gap**, which is the true state of affairs and is
actionable in a way a fabricated verdict is not.

**6. Business policy is data, not code.**
`RECOMMENDATION_POLICY` is a structure `recommend()` walks; it hardcodes no metric name
and no direction. A test proves it by swapping the primary metric at runtime and watching
the outcome follow. Target Rescue's `RANKING_BASIS` implements tie-breakers that in
practice never fire, *"because a policy that exists only in a comment is a policy nobody
can test."*

**7. Snap to what is measurable; never interpolate between measurable points.**
The discount control snaps to the five approved depths. The Target Rescue checkpoint snaps
to a complete business week — *"a value between two measurable points is not a shallower
version of either, it is a number nobody can measure."* Ties in both resolve **downward**,
to the more conservative reading.

**8. Append-only, and the exception is named.**
Scenario results and decision versions are written once. There is no UPDATE and no DELETE
for them anywhere in the store package. The one delete — clearing decisions — is called
out as a deliberate exception, is unfiltered (so a history that looks empty *is* empty),
and touches nothing else. Reports are the counter-case and say why: a report is a derived
artifact, regenerable from its stored scope, so deleting one destroys no history.

**9. Disclose what wasn't built.**
Every `owner` column is NULL because there is no verified actor to attribute a row to, and
the column exists so identity has somewhere to go when it arrives. The unauthenticated
write endpoints are documented in the module docstring, in every route's OpenAPI
description, in the README, and in a test that guards against the warning quietly
disappearing while the exposure remains.

**10. Fix the data, freeze the engine.**
Every audit script opens by restating that `aggregate.py` is correct and untouched, and
imports the real engine so a diagnosis cannot drift from what the UI shows. The
unrealistic ROI came from the generators — CH001 never applying uplift, CH002 F24 selling
"20% off" at list price, Buy3Get1 giving away a quarter of its volume free.

**11. Record the post-mortem beside the fix.**
Trade Spend's docstring explains the ₹23.10 Cr understatement a previous definition
caused. The report adapter carries a 25-line account of why "Total alerts 200" printed
beneath "Critical 897 · High 350 · Medium 323". The filter store documents the 138
contradictory states its predecessor allowed. The e2e tests document why a unit test
would have passed against the broken code. Superseded scripts are kept, marked
DO-NOT-RUN, with guards that abort a re-run.

---

## Appendix — Cross-cutting formula index

| Quantity | Formula | Owner |
| --- | --- | --- |
| Baseline | `mean(Base_Quantity)` over `Promotion_Id = -1` rows, per **(product, channel)**, inside the selection | `aggregate._volume` |
| Trade Spend | `Σ(Base_Revenue − Actual_Revenue + Promotion_Cost)` over **all** filtered rows | `aggregate.calculate_trade_spend` |
| Incremental Quantity | `Σ over promoted rows (Actual_Quantity − baseline)` | `aggregate.calculate_incremental_quantity` |
| Incremental Qty % | `incremental_quantity / baseline_quantity × 100` | `aggregate.calculate_incremental_quantity_percent` |
| Incremental Sales | `Σ(Actual_Revenue) − baseline × Σ(Actual_Price)` ≡ `Σ(Aq−b)×Ap` | `aggregate.calculate_incremental_sales` |
| **ROI** | `Incremental Sales / Trade Spend` — a multiple, `1.4` | `aggregate.roi_multiple` |
| Margin Impact | `Σ(Actual_Revenue − Total_Cost) / Σ(Actual_Revenue) × 100` | `aggregate.calculate_margin` |
| Trade Spend Efficiency | `Incremental Sales / Trade Spend × 100` (= ROI × 100) | `aggregate.calculate_trade_spend_efficiency` |
| Incremental Profit | `Incremental Sales − Incremental Product Cost − Trade Spend` | `aggregate.calculate_incremental_profit` |
| Cannibalization | `Σ max(nb_baseline×nb_txns − nb_actual, 0) / Σ(promo_actual − baseline×promo_txns) × 100` | `aggregate.cannibalization_detail` |
| Cannib. score | ≤5→100, ≤10→90, ≤20→75, ≤30→60, ≤50→40, else 20 | `aggregate.cannibalization_score` |
| **PEI** | `Σ(clamp(component/cap,0,1)×100 × w) / Σw`; w = .40/.30/.30; caps = 100/50/40 | `aggregate.calculate_pei` |
| Growth | `(value − previous) / abs(previous) × 100`, taken **before** rounding | `aggregate.calculate_growth` / `_precise` |
| At Stake | `max(Trade Spend × (1 + 50/100) − Incremental Sales, 0)` | `config.target_incremental_sales` |
| Break-even uplift | `u* = (d + c) / (1 − c − 2d)` | `config.breakeven_uplift` |
| Headroom | `uplift_low/high − breakeven_uplift` | `response.TreatmentResponse` |
| Counterfactual row | `q = b·n·(1+u)`; `p = P(1−d)`; `rev = q·p`; `disc = q·P − rev`; `pcost = c·q·P`; `tc = k·q` | `execution.synthesize` |
| Optimizer option | `units = b(1+u)`; `gross = units·P`; `rev = gross(1−d)`; `spend = gross(d+c)` | `optimization._options` |
| Observed discount depth | `Σ(Base_Rev − Actual_Rev) / Σ(Base_Rev) × 100` — from prices, never a promotion's name | `simulation._measure` |
| Run-rate projection | `(units_mtd / days_elapsed) × days_in_month` | `rescue.pace_block` |
| Target attainment | `units_mtd / target_units × 100`; ≥80 on track, ≥70 watch, else at risk | `rescue.target_status` |

---

*End of guide.*
