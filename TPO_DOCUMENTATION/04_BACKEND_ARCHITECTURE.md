# 04 — Backend Architecture

`backend/app/` — 50 Python modules, ~17,500 lines.

## 1. Package layout

```
backend/
├── requirements.txt
├── .store/tiq.db                 SQLite (gitignored)
├── tests/                        29 modules, 1,470 tests
└── app/
    ├── main.py                   FastAPI app, CORS, router mounting, static mount
    ├── data_loader.py            app/data/*.json → cached dicts
    ├── data/                     18 authored JSON files (static page content)
    ├── models/                   __init__.py only — EMPTY PACKAGE
    ├── routers/                  13 modules — HTTP boundary, no business logic
    │   ├── command_center.py     8 Command Center routes
    │   ├── simulation.py         12 routes across the 3 simulation modes
    │   ├── reports.py            7 Report Center routes
    │   ├── store.py              5 persistence routes
    │   ├── decision.py           POST /api/decision/record
    │   ├── briefing.py           POST /api/decision/briefing
    │   ├── promotion_calendar.py 3 Calendar routes
    │   ├── investigations.py     4 RCA content routes
    │   ├── pages.py              6 per-type static page routes
    │   ├── connectors.py         7 outbound proxy routes
    │   ├── nav.py                /nav, /user, /focus
    │   ├── command.py            /command (legacy static)
    │   └── misc.py               /calendar, /connections, /ai-watch,
    │                             /recommendations, /settings
    ├── tpo/                      21 modules — services + the calculation core
    ├── reports/                   5 modules — report framework and writers
    └── store/                     4 modules — the ONLY place that writes
```

`app/models/` contains nothing but an `__init__.py`. Pydantic request models
live beside the routes that use them; response shapes are plain `dict[str, Any]`
assembled by the services.

## 2. Separation of concerns

| Layer | May do | May **not** do |
|---|---|---|
| `routers/` | Parse query params or a validated body into a `FilterState`, call one service function, map a domain exception onto a status code | Compute anything; hold a threshold; know about openpyxl or SQL |
| `tpo/` services | Assemble payloads, attach provenance, decide what to *report* | Define a KPI formula |
| `tpo/aggregate.py` | Every KPI formula in the project | Know about HTTP, currency, or filters |
| `tpo/filters.py` | Select rows, build dependent option lists | Compute a KPI |
| `tpo/formatting.py` | Currency conversion, magnitude, period labels | Touch a stored `value` |
| `reports/adapters.py` | Call the same service the screen calls, copy figures into a `ReportDoc` | Divide, multiply or compare two KPIs |
| `reports/{excel,pdf}.py` | Lay out a `ReportDoc` | Know a KPI's name |
| `store/` | Every `sqlite3` call and every `INSERT` in the project | Compute anything |

`tests/test_store_persistence.py` enforces the last rule mechanically: no module
outside `app/store/` may contain `sqlite3` or an `INSERT`. That test is why the
Report Center's table lives in `app/store/reports.py` and not beside the report
writers that use it.

## 3. `app/main.py`

```python
app = FastAPI(title="TIQ API", version="0.1.0")
app.add_middleware(CORSMiddleware, allow_origins=[…5173/5175 loopback…], …)

@app.get("/api/health") → {"ok": True, "service": "tiq-api"}

for r in (nav, command, command_center, investigations, pages, misc,
          connectors, promotion_calendar, simulation, decision, briefing,
          store, reports):
    app.include_router(r.router)

_dist = <repo>/frontend/dist
if _dist.is_dir():
    app.mount("/", StaticFiles(directory=_dist, html=True), name="frontend")
```

**Router registration order matters.** `misc` is mounted before `reports`; that
is why the fake `GET /api/reports` was *removed* from `misc.py` rather than left
in place — it would have shadowed the real Report Center listing.

The static mount is guarded on the folder existing, so `uvicorn app.main:app`
still works before a frontend build has ever been run.

## 4. `app/tpo/` — the calculation core

### 4.1 `config.py` (150 lines) — every tunable, in one place

Dataset resolution, the 50% ROI target, severity bands, the FX rate, the
promotion cost rate, and `TREATMENT_RULES`. Nothing else in `app/tpo/` reads
`os.environ` or hard-codes a rate.

`target_incremental_sales(trade_spend)` inverts the ROI definition rather than
hard-coding `× 1.5`, so the "At Stake" figure cannot disagree with the target if
the target moves.

`breakeven_uplift(d, c)` is relocated verbatim from
`scripts/audit_roi_realism.py`, which now imports it back. Its domain caveat is
documented and deliberately unguarded: the denominator goes non-positive once
`2d + c ≥ 1` (beyond a 48.5% discount), and the approved treatments top out at
25%.

### 4.2 `loader.py` (418 lines) — the data layer

Reads the five CSVs into `FactStore`. Dataclasses `Product`, `Store`,
`Promotion`, `Channel`, `Dimensions`. Derives `Product.rank` from `Size`.
Derives the analytical month from `(Year, Week) → dim_date`. Raises on an
unresolvable `(Year, Week)`; warns (but keeps the row) on an unknown dimension id.

### 4.3 `filters.py` (520 lines) — the filter engine

One frozen, hashable `FilterState` over 14 dimensions. Two row sets:
`rows_for` (exactly the selection) and `baseline_rows_for` (plus the
non-promoted rows the volume chain needs). Dependent option lists via
`_present_values`. Full treatment: [07_FILTER_AND_SCOPE_ARCHITECTURE.md](07_FILTER_AND_SCOPE_ARCHITECTURE.md).

**Performance design:** dimension predicates are evaluated once per *code*
(55 stores / 36 products / 16 promotions) into bitmasks, not once per row across
205,920 rows. The row pass is then three array lookups and two integer
comparisons.

### 4.4 `aggregate.py` (1,097 lines) — THE KPI engine

The only arithmetic in the project. Full treatment:
[08_KPI_AND_BUSINESS_LOGIC.md](08_KPI_AND_BUSINESS_LOGIC.md).

Key entry points: `calculate_kpis`, `calculate_trade_spend`,
`calculate_incremental_sales`, `roi_percent`, `calculate_margin`,
`calculate_pei`, `cannibalization_detail`, `period_series`, `build_debug`.

### 4.5 `service.py` (1,079 lines) — Command Center payloads

`KPI_SPECS` (the six cards with their formula text and tooltip copy),
`kpis`, `trend`, `risk_alerts`, `underperforming_promotions`,
`top_promotions`, `promotion_mix`, `filters`, `breakdown`.

Also owns two **reporting** rules that are not arithmetic:
`CANNIBALIZATION_MIN_EVENTS = 3` (the evidence floor) and
`_CANNIBALIZATION_LADDER` (the measurement ladder).

### 4.6 `formatting.py` (120 lines) — presentation

`fiscal_label` (2024 → `F24`), `period_label`, `money` (INR Cr/L/K vs USD
B/M/K), `percent`, `score`, `quantity`, `delta_label`. `_rate` is the single FX
conversion point. **No KPI function anywhere takes a currency argument.**

### 4.7 `response.py` (183 lines) — the approved treatment rules

`TreatmentResponse` (frozen), `get_treatment_response(discount_pct)`,
`get_treatment(key)`, `all_treatments()`, `APPROVED_DISCOUNT_PCT`,
`UnapprovedDiscount`, `PROVENANCE`.

Three refusals, stated in the module docstring and enforced in code:
**no interpolation** between approved depths, **no midpoint** of a band,
**no spend input** (Trade Spend is `b(1+u)P(d+c)` — an output).

Units contract: `discount_pct` is a **percentage**; `uplift_*`,
`breakeven_uplift` and `headroom_*` are **fractions**. The `_pct` suffix is the
contract.

### 4.8 Simulation services

| Module | Lines | Role |
|---|---:|---|
| `scenarios.py` | 197 | The scenario model (B1). Three default templates; `assert_no_fabricated_results`; `levers_are_isolated` |
| `simulation.py` | 660 | The **measured** baseline (Phase A). Computes nothing — reads `service.kpis` |
| `execution.py` | 423 | Counterfactual `WeekRow` synthesis (B2.2), then hands rows to `aggregate` |
| `comparison.py` | 467 | Side-by-side with per-metric deltas at both band ends (B4.1). Never ranks |
| `recommendation.py` | 585 | `RECOMMENDATION_POLICY` as data + a walker (B4.3) |
| `risk.py` | 624 | Governance assessment (B6). No score, no invented threshold |
| `weekly.py` | 415 | Decomposition across observed business weeks (B5) |
| `investigation.py` | 274 | RCA → Simulation context contract (B3.1) |
| `studio.py` | ~1,150 | Simulation Studio — fitted lift curve, the three levers, the window, the depth curve |

### 4.9 Decision services

| Module | Lines | Role |
|---|---:|---|
| `decision.py` | 386 | Assembles a record from 4–5 posted payloads; validates them against each other; `SectionMismatch` → 422 |
| `briefing.py` | 537 | Renders one record as `briefing.json` + a self-contained `briefing.html`; `InvalidRecord` → 422 |

### 4.10 `promo_calendar.py` (449 lines)

The Calendar read model. `CADENCE`, `matrix`, `cell_detail`, `upcoming`,
`available_years`. Counts distinct products and nothing else — no KPI logic.

## 5. `app/reports/` — the report framework

```
service.py    MODULES registry (5 entries) · to_state · filename · build · generate
adapters.py   5 module adapters — each calls the SAME service the screen calls
model.py      ReportDoc / Section / Table / Column / KpiEntry — dataclasses only
excel.py      openpyxl writer — typed cells, number formats, frozen headers
pdf.py        reportlab platypus writer — page templates, landscape sections
```

One intermediate document, two writers:

```
adapter → ReportDoc → excel.write()  → .xlsx bytes
                    → pdf.write()    → .pdf bytes
```

Five modules × two formats would otherwise have been ten bespoke generators.

**Values are carried raw with a kind.** A currency cell holds `9071892.0` and
the column says `currency`; Excel receives a real number it can sum, and the PDF
renders it through `formatting.money` — the same function the screen used.
A missing value is written as a **blank cell, never 0**.

The rupee glyph is substituted in the PDF (`_UNPRINTABLE`) because no bundled
reportlab font can draw it.

## 6. `app/store/` — persistence

```
db.py           connection (thread-local), WAL, schema, SCHEMA_VERSION, NO_OWNER_NOTE
fingerprint.py  server-side dataset fingerprint — no client may assert one
repository.py   scenarios + decisions (append-only)
reports.py      report metadata + artifact BLOBs (deletable)
```

`repository.py` and `reports.py` are separate **on purpose**: scenario and
decision history is append-only and guarded as such; a generated report is a
derived artifact that may be deleted and regenerated. Merging them would have
meant weakening that guard.

Optimistic concurrency: a write carrying a stale `expected_version` returns
**409** with the version that is actually current, not 422.

## 7. Error-handling conventions

| Status | Used for | Example |
|---|---|---|
| 200 / 201 | Success (201 on report generate) | |
| 204 | Report deleted | `DELETE /api/reports/{id}` |
| 404 | Unknown module / report / stored record | `service.UnsupportedModule` |
| **409** | Version conflict on an append-only write | `repository.VersionConflict` (body names `current_version`) |
| **422** | Well-formed request the domain refuses | Unapproved discount, empty scope, section mismatch, impossible checkpoint, unknown filter dimension, product outside its category |
| 500 | A report row reached `ready` with no bytes | Guarded explicitly rather than serving an empty file |
| 502 | Upstream connector unreachable | `connectors.UpstreamError` |

The consistent choice of **422 over 404** for a well-formed but unanswerable
domain request is deliberate and documented at each site: "the scope is
well-formed and holds nothing a treatment could replace — a zeroed result would
be the wrong answer."

FastAPI serialises errors as `{"detail": …}`; `frontend/src/lib/api.ts` unwraps
both a string detail and a Pydantic 422 field-error list.

## 8. Caching

| Cache | Size | Invalidation |
|---|---|---|
| `loader.get_store()` | 1 | Process lifetime |
| `data_loader.load(name)` | unbounded | Process lifetime |
| `filters.rows_for` | 128 | Keyed on the frozen `FilterState` |
| `filters.baseline_rows_for` | 128 | Same |
| `filters._present_values` | 64 | Same |
| `promo_calendar._aggregate(year)` | 4 | Process lifetime |
| `promo_calendar.available_years()` | 1 | Process lifetime |
| `investigation.seeded_questions()` | — | Read from `investigation-types.json` |

There is **no cache invalidation path**. The CSVs are immutable for the process
lifetime; changing them requires a restart.
