# 01 — System Architecture

## 1. Deployment shape

**One process in production.** `backend/app/main.py` mounts
`frontend/dist/` at `/` with `StaticFiles(html=True)` when the folder exists,
so a production deployment is a single Uvicorn process serving the SPA, the
API and all connector proxies from one origin.

**Two processes in development.** Vite (`:5173`) proxies `/api/*` to FastAPI
(`:8100`) — see `frontend/vite.config.ts`. The browser only ever talks to one
origin in both modes, so CORS is not in play. The CORS middleware in
`main.py` allow-lists `127.0.0.1`/`localhost` on ports 5173 and 5175 purely for
direct API calls that bypass the Vite proxy.

```
DEV                                   PROD
┌──────────┐                          ┌────────────────────────────┐
│ browser  │                          │ browser                    │
└────┬─────┘                          └────────────┬───────────────┘
     │ :5173                                       │ :8100
┌────▼──────────────┐                 ┌────────────▼───────────────┐
│ Vite dev server   │                 │ Uvicorn / FastAPI          │
│  SPA + HMR        │                 │  ├── StaticFiles → dist/   │
│  /api/* ──proxy──►┼──► :8100        │  └── /api/* routers        │
└───────────────────┘                 └────────────────────────────┘
```

## 2. Layered view

```
┌───────────────────────────────────────────────────────────────────────┐
│ FRONTEND — React 19 SPA, HashRouter                                   │
│   pages/          11 routes                                           │
│   components/     ui · charts · command · calendar · simulation ·     │
│                   optimization · rescue · reports · investigations ·  │
│                   intelligence · portal · layout                      │
│   hooks/          15 TanStack Query hooks — the ONLY API callers       │
│   store/          7 Zustand stores (filters, scenarios, drafts, …)    │
│   lib/api.ts      apiFetch / apiPost — one fetch wrapper, one error   │
│   COMPUTES NO KPI. Formats and renders what the API returns.          │
└───────────────────────────┬───────────────────────────────────────────┘
                            │  HTTP /api/*  (JSON, plus 2 binary routes)
┌───────────────────────────▼───────────────────────────────────────────┐
│ API / ROUTERS — backend/app/routers/ (13 modules, 63 routes)          │
│   Parse query params or a Pydantic body → FilterState → delegate →    │
│   serialise. NO BUSINESS LOGIC LIVES HERE.                            │
│   command_center · simulation · reports · store · decision ·          │
│   briefing · promotion_calendar · investigations · pages · nav ·      │
│   command · misc · connectors                                         │
└───────────────────────────┬───────────────────────────────────────────┘
                            │
┌───────────────────────────▼───────────────────────────────────────────┐
│ SERVICES — backend/app/tpo/                                            │
│   service.py          Command Center payloads, breakdown, KPI specs    │
│   simulation.py       measured scenario baseline (Phase A)             │
│   execution.py        counterfactual row synthesis (B2.2)              │
│   studio.py           Simulation Studio — fitted lift curve, the       │
│                       three levers, the window, the depth curve        │
│   decision.py         record assembly for stored legacy records        │
│   briefing.py         portable JSON + HTML artifact (B8)               │
│   promo_calendar.py   Calendar read model                              │
│   scenarios.py        scenario model & fabrication guard (B1)          │
│   NONE OF THESE COMPUTE A KPI.                                        │
└───────────────────────────┬───────────────────────────────────────────┘
                            │
┌───────────────────────────▼───────────────────────────────────────────┐
│ CALCULATION / BUSINESS RULES                                          │
│   aggregate.py   THE KPI ENGINE — the only arithmetic in the project  │
│   filters.py     THE filter engine + dependent option lists            │
│   response.py    the 5 approved promotion treatment rules (typed read) │
│   config.py      every tunable: data path, ROI target, FX, treatments  │
│   formatting.py  currency, magnitude, F24/F25 labels — DISPLAY ONLY    │
└───────────────────────────┬───────────────────────────────────────────┘
                            │
┌───────────────────────────▼───────────────────────────────────────────┐
│ DATA / STORAGE                                                        │
│   loader.py         5 CSVs → cached columnar FactStore (lru_cache 1)   │
│   data_loader.py    app/data/*.json → cached dicts (static page data)  │
│   store/db.py       SQLite connection + append-only schema             │
│   store/repository.py   scenarios & decisions (append-only)            │
│   store/reports.py      report metadata + xlsx/pdf BLOBs (deletable)   │
│   store/fingerprint.py  dataset fingerprint, computed server-side      │
└───────────────────────────────────────────────────────────────────────┘
```

## 3. Module → API → service map

| Module | Endpoints it calls | Service | Data source |
|---|---|---|---|
| Command Center | `/api/command-center/*` (8) | `tpo/service.py` | CSVs |
| Investigations | `/api/investigation-types`, `/api/investigations/{type}`, `/api/investigations/legacy`, `/api/focus` | `data_loader.py` | **JSON** |
| Promotion Intelligence | `/api/intelligence/{type}`, `/api/intelligence-answers/{type}`, `/api/intelligence-default` | `data_loader.py` | **JSON** |
| Simulation Studio | `/api/simulation/{scope,simulate,curve}` | `tpo/studio.py` | CSVs |
| Decision Center | `/api/store/board-decisions*` | `store/repository.py` | posted payloads + SQLite |
| Calendar | `/api/promotion-calendar/{matrix,cell,upcoming}` | `tpo/promo_calendar.py` | CSVs + `calendar.json` |
| Reports | `/api/reports*` | `reports/service.py` → `tpo/*` | CSVs → SQLite BLOBs |
| Data Connections | `/api/connections`, `/api/proxy/*` | `data_loader.py`, `routers/connectors.py` | **JSON** + live third-party APIs |
| Settings | `/api/settings`, `/api/user` | `data_loader.py` | **JSON** |
| App shell | `/api/nav`, `/api/user`, `/api/focus` | `data_loader.py` | **JSON** |

## 4. Data flow — a Command Center request

```
1  User changes a filter
      └─ frontend/src/store/commandFilters.ts  (Zustand)
2  Every panel's hook re-queries with the SAME serialised filter dict
      └─ hooks/useCommandCenter.ts → toQuery() → /api/command-center/kpis?...
3  routers/command_center.get_filters()  →  FilterState.build(...)
4  filters.rows_for(state)            → exactly the selected rows
   filters.baseline_rows_for(state)   → + non-promoted rows the uplift needs
   state.widened_to_brand_form()      → + pack-size neighbours (cannibalization)
5  aggregate.calculate_kpis(rows, previous_rows, family_rows, volume_rows, …)
6  service.kpis() attaches labels, formulas, display strings, deltas
7  JSON → hook → TpoKpiTile
8  /filters returns dependent option lists → store.reconcile() prunes any
   selection the new scope no longer offers
```

Steps 4–5 are cached: `rows_for` and `baseline_rows_for` are
`lru_cache(maxsize=128)` on the hashable frozen `FilterState`, and the whole
`FactStore` is `lru_cache(maxsize=1)` for the process lifetime.

## 5. Data flow — a report

```
Screen (Command Center / Simulation Studio / Decision Center)
   │  ExportReportButton reads scope + options AT CLICK TIME
   ▼
POST /api/reports  { module, scope, options, currency, formats }
   │  ⚠ the client posts what it SELECTED, never what it was SHOWN
   ▼
reports/service.generate()
   ├─ to_state(scope) → the ONE FilterState  (unknown key → 422)
   ├─ store.begin()   → row opened with status "generating"
   ├─ adapters.<module>(state, currency, options)
   │      └─ calls the SAME tpo service function the screen's endpoint calls
   │         → ReportDoc  (sections, tables, KPI entries, disclaimers)
   ├─ excel.write(doc) → .xlsx bytes      reportlab pdf.write(doc) → .pdf bytes
   └─ store.finish()  → status "ready", both BLOBs + a stored preview
   ▼
201 { report_id, name, status, formats, preview, … }   ← METADATA, NOT BYTES
   ▼
Reports page → GET /api/reports/{id}/download/{fmt} → the only route that
                                                     answers with a file
```

## 6. Cross-cutting architectural rules

These are enforced by code and by tests, not by convention:

| Rule | Enforced by |
|---|---|
| One KPI implementation, server-side | `aggregate.py` is the only module with the formulas; `tests/test_studio.py` asserts parity between Simulation Studio and Command Center figures |
| One filter model | `SimulationFilters` field names asserted equal to `filters.DIMENSIONS`; report `to_state()` rejects unknown keys |
| Currency is presentation | No KPI function takes a currency argument; `formatting._rate` is the single conversion point |
| Every write lives in `app/store/` | `tests/test_store_persistence.test_the_store_is_the_only_thing_that_writes` — no module outside the package may contain `sqlite3` or an `INSERT` |
| Nothing fabricates a scenario result | `scenarios.assert_no_fabricated_results` runs on the real payload |
| No invented thresholds | `risk.UNDEFINED_THRESHOLDS` reports governance gaps instead |
| Generate ≠ download | `POST /api/reports` returns metadata; only `GET /…/download/{fmt}` returns bytes |
| Unapproved discounts are refused, not interpolated | `response.UnapprovedDiscount` |

## 7. What the architecture deliberately does not contain

- **No analytical database.** The 5 CSVs are the analytical store.
- **No ORM.** SQLite is used through stdlib `sqlite3` with hand-written SQL.
- **No charting library.** Every chart is hand-rolled SVG under
  `frontend/src/components/charts/`.
- **No modelling dependency.** The studio's lift curve is a weighted
  least-squares fit solved in plain Python (`tpo/studio.py`); no SciPy, no
  scikit-learn.
- **No forecasting and no black box.** The curve is fitted to the dataset's
  own promoted weeks and calibrated to the scope, and `model.provenance` —
  `fitted`, `fitted_dataset_wide` or `approved_rules` — travels on every
  response, with the evidence it was fitted from.
- **No authentication layer.** See [appendices/KNOWN_LIMITATIONS.md](appendices/KNOWN_LIMITATIONS.md).
