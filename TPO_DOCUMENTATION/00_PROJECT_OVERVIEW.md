# 00 — Project Overview

## 1. Objective

TPO Intelligence is a Trade Promotion Optimization application. It takes a
finalized FMCG transaction dataset and turns it into four things a commercial
team can act on:

1. a **measurement** of what promotions cost and what they returned,
2. a **diagnosis** of which promotion events are underperforming and by how much,
3. a **counterfactual** built from approved promotion treatment rules, and
4. a **decision record** that carries every figure through unchanged.

## 2. The business problem

Trade promotion spend is booked in two places at once — the price given away
and the promotion cost ledger — and the volume it buys is only meaningful
against what the product would have sold anyway. Most reporting gets one of
those wrong. This application fixes the definition in exactly one place
(`backend/app/tpo/aggregate.py`) and makes every consumer read it:

```
Trade Spend        = Σ (Base_Revenue − Actual_Revenue + Promotion_Cost)
Incremental Sales  = Σ over promoted rows of (Actual_Quantity − baseline) × Actual_Price
Promotion ROI      = (Incremental Sales − Trade Spend) ÷ Trade Spend × 100
```

where `baseline` is the mean `Base_Quantity` over that product's **non-promoted
rows in that channel, inside the current filter selection**.

Three design decisions follow from that, and all three are load-bearing:

- **The baseline is keyed on (product, channel), not product alone.** CH001 and
  CH004 book one fact row per week; CH002/CH003/CH005 book one per month.
  Pooling them measures period length instead of promotional response — it
  drags F25 all-channel ROI from 141.2% to 8.6%. Guarded by
  `tests/test_command_center.test_baseline_is_keyed_per_channel`.
- **The baseline is re-derived per selection.** So a year is *not* the sum of
  its months for volume-derived KPIs. Guarded by
  `test_incremental_sales_is_not_additive_across_months`.
- **A KPI that cannot be computed returns `null`, never `0`.** A fabricated
  zero reads as a measurement.

## 3. Target users

Supported by the application's actual content and workflows:

| Role | Primary surface |
|---|---|
| Trade Marketing | Command Center, Promotion Calendar, Simulation Studio |
| Revenue Growth Management | KPI cards, ROI/PEI, scenario simulation |
| Category Management | Category / Brand-form breakdowns, cannibalization |
| Sales / Commercial | Channel Performance, Risk Alerts |
| Key Account Management | Retailer & Distributor Performance |
| Commercial Finance | Trade Spend, Margin Impact, Decision records, Reports |
| Senior Management | Command Center headline + Report Center PDFs |
| Analytics / Data Science | `debug` blocks, `scripts/validate_*.py` |

**Not supported:** Brand Management as a distinct surface (brand exists only as
a *Brand Form* filter dimension), and Supply / Demand Planning — the project
holds no inventory or forecast data at all, and
`backend/app/routers/simulation.py` explicitly rejects an
`inventory_allocation` lever for that reason.

There is **no role-based access control**. The application has no identity
provider, so no user is authenticated, no route is guarded and no record is
attributed. See [appendices/KNOWN_LIMITATIONS.md](appendices/KNOWN_LIMITATIONS.md).

## 4. Analytical workflow

```
   ┌──────────────────────────────────────────────────────────────┐
   │  Command Center                                              │
   │  6 KPI cards · trend · risk alerts · 2 tables · 6 charts     │
   │  ONE FilterState across every panel                          │
   └───────────────┬──────────────────────────────────────────────┘
                   │ click a risk alert / underperforming row
                   │ → carries FilterState + (promotion_id, product_id, channel_id)
                   ▼
   ┌──────────────────────────────────────────────────────────────┐
   │  Investigations / RCA                    [STATIC CONTENT]    │
   │  causal graph, accelerators, node details — authored JSON    │
   │  the SCOPE hand-off is real; the analysis on screen is not   │
   └───────────────┬──────────────────────────────────────────────┘
                   │ POST /api/simulation/context validates the hand-off
                   ▼
   ┌──────────────────────────────────────────────────────────────┐
   │  Simulation Studio — three levers over one window            │
   │  discount · trade-spend budget · days                        │
   │                                                              │
   └───────────────┬──────────────────────────────────────────────┘
                   │ "Add to Decision Center" carries the scenario
                   │ (scope + levers + its KPIs, as displayed)
                   ▼
   ┌──────────────────────────────────────────────────────────────┐
   │  Decision Center                                             │
   │  assembled record · governance · readiness · briefing        │
   │  NOT approved — no approval criteria exist in this project   │
   └──────────────────────────────────────────────────────────────┘

   ── standalone, not in the chain ──────────────────────────────
   Promotion Calendar   Year → Month → Channel → Promotion → Products
   Report Center        generate → store → list → preview → download
```

## 5. Major capabilities

| Capability | Status |
|---|---|
| 14-dimension filtering with dependent, self-reconciling option lists | Implemented |
| 8 KPIs from one engine, with prior-year deltas at full precision | Implemented |
| Cannibalization at promotion-event grain, with an evidence floor and a measurement ladder | Implemented |
| Per-dimension breakdown behind every chart (one endpoint, 12 dimensions, 4 metrics) | Implemented |
| Risk alerts banded by ROI against a 50% target, with "At Stake" ranking | Implemented |
| Promotion Calendar over 2 years × 5 channels, weekly and monthly cadence | Implemented |
| Counterfactual scenario execution over 5 approved treatments | Implemented |
| Trade-spend budget allocation (exact multiple-choice knapsack) | Implemented |
| Monthly unit-target rescue with an approved intervention ladder | Implemented |
| Governed decision record + portable JSON/HTML briefing | Implemented |
| Report Center with stored `.xlsx` and `.pdf` artifacts | Implemented |
| Durable scenario/decision storage (append-only SQLite) | Implemented |
| RCA causal analysis | **Static** |
| Promotion Intelligence (8 tabs) | **Static** |
| Authentication / authorization | **Deferred** |
| Approval workflow | **Not implemented** |
| Forecasting, elasticity, ML, MMM | **Not implemented — and refused by design** |

## 6. Data architecture (summary)

Five CSVs under `Data/`, loaded once per process into a columnar in-memory
store. There is **no analytical database** — SQLite is used only for
application writes (scenarios, decisions, report artifacts).

```
fact_sales_2024_2025_all_channels.csv   205,920 rows   grain: Transaction_Id
        │
        ├── Product_id    → dim_product_reordered.csv     (36)
        ├── Store_Id      → dim_geo_store_final.csv       (509)
        ├── Channel_Id    → dim_channel.csv               (5)
        ├── Promotion_Id  → dim_promotion_final.csv       (18)
        └── (Year, Week)  → dim_date2425_corrected.csv    (882)  ← the authoritative month
```

Full detail: [03_DATA_ARCHITECTURE.md](03_DATA_ARCHITECTURE.md).

## 7. Application architecture (summary)

```
React SPA (HashRouter)  →  /api/*  →  FastAPI routers  →  app/tpo services
                                                       →  app/reports (writers)
                                                       →  app/store (SQLite)
                                                              │
                                                     app/tpo/aggregate.py
                                                     ── the ONE KPI engine ──
```

The architectural rule enforced throughout: **no KPI arithmetic exists outside
`app/tpo/aggregate.py`**. Routers parse and serialise. Services assemble
payloads. Report adapters call the same service functions the screen calls. The
frontend formats what it is given and computes nothing.

Full detail: [01_SYSTEM_ARCHITECTURE.md](01_SYSTEM_ARCHITECTURE.md).

## 8. Module map

| Module | Frontend page | Backend router | Service |
|---|---|---|---|
| Command Center | `pages/CommandCenter.tsx` | `routers/command_center.py` | `tpo/service.py` |
| Investigations | `pages/Investigations.tsx` | `routers/investigations.py` | `data_loader.py` (JSON) |
| Promotion Intelligence | `pages/Intelligence.tsx` | `routers/intelligence.py` | `intelligence_engine.py` |
| Simulation Studio | `pages/Simulation.tsx` | `routers/simulation.py` | `tpo/{simulation,execution,comparison,recommendation,risk,weekly,optimization,rescue}.py` |
| Decision Center | `pages/Decision.tsx` | `routers/{decision,briefing}.py` | `tpo/{decision,briefing}.py` |
| Calendar | `pages/Calendar.tsx` | `routers/promotion_calendar.py` | `tpo/promo_calendar.py` |
| Reports | `pages/Reports.tsx` | `routers/reports.py` | `reports/service.py`, `store/reports.py` |
| Data Connections | `pages/Connections.tsx` | `routers/{misc,connectors}.py` | JSON + `httpx` proxies |
| Settings | `pages/Settings.tsx` | `routers/misc.py` | `data_loader.py` (JSON) |
| Storage | (hooks only) | `routers/store.py` | `store/repository.py` |
