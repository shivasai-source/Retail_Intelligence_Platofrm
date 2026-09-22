# TPO Intelligence — Documentation

**Audit date:** 2026-08-24 · **Branch:** `shiva` · **HEAD:** `870bec5`

This package documents the TPO Intelligence application **as it exists in this
repository today**. Where the code and older documentation disagree, the code
wins and the discrepancy is recorded in
[12_CHANGE_HISTORY.md](12_CHANGE_HISTORY.md) and
[appendices/KNOWN_LIMITATIONS.md](appendices/KNOWN_LIMITATIONS.md).

Every claim below was verified by reading the repository. Status labels used
throughout:

| Label | Meaning |
|---|---|
| **Implemented** | Working code, reachable from the UI, covered by tests where tests exist |
| **Partial** | Present but incomplete; the gap is named |
| **Static** | Served from authored JSON under `backend/app/data/`, not computed from the datasets |
| **Deferred** | Deliberately not built, with a stated reason in the code |
| **Not implemented** | Absent |

---

## 1. What TPO Intelligence is

A Trade Promotion Optimization analytics application for an Indian FMCG
portfolio. It measures what promotions actually did, explains where the money
went, lets a planner test approved promotion treatments against the same
validated engine, and assembles a governed decision record from the result.

The repository root is named `Retail_Intelligence_Platofrm` and the FastAPI
service is titled `TIQ API`; the product name shown in the UI is **TPO
Intelligence**. The portal at `#/home` lists six intelligence modules, of which
**only Trade Promotion Optimization is live** — the other five are marked
`live: false` in `frontend/src/components/portal/modules.ts`.

**Business purpose.** Trade promotion is the second-largest line on an FMCG
P&L and the least well measured. This application answers four questions from
one dataset and one KPI engine:

1. What did we spend, and what did it return? (Command Center)
2. Why did a specific promotion underperform? (Investigations / RCA)
3. What would an approved treatment do instead? (Simulation Studio)
4. What are we deciding, on what evidence? (Decision Center)

## 2. Target users

Roles the application's own content and workflows support:

| Role | What they use |
|---|---|
| Trade Marketing | Command Center, Promotion Calendar, Simulation Studio |
| Revenue Growth Management | KPI cards, ROI/PEI, scenario simulation |
| Category Management | Category/Brand breakdowns, cannibalization |
| Key Account Management | Retailer & Distributor performance, Channel performance |
| Commercial Finance | Trade Spend, Margin Impact, Decision Center records |
| Analytics / Data Science | `debug` blocks on every KPI payload, validation scripts |

There is **no role model in the application**. No route is guarded, no
permission is checked, and Settings deliberately shows no job title — see
[appendices/KNOWN_LIMITATIONS.md](appendices/KNOWN_LIMITATIONS.md).

## 3. Main workflow

```
        Command Center                 (measure — where is the money going?)
              │  click a risk alert or an underperforming promotion
              ▼
      Investigations / RCA             (diagnose — why?)
              │  carry the scope
              ▼
      Simulation Studio                (test — what would an approved treatment do?)
        ├── Investigation Simulation
        └── three levers: discount · trade spend · days
              │  carry the chosen scenario
              ▼
       Decision Center                 (record — what are we deciding?)
```

**Calendar and Reports are first-class modules and are NOT steps in that
chain.** The Promotion Calendar is a standalone plan view (Year → Month →
Channel → Promotion → Products). The Report Center is a cross-cutting library
that Command Center, Simulation Studio and Decision Center generate into.

## 4. Modules

| Module | Route | Status | Doc |
|---|---|---|---|
| Command Center | `#/command` | Implemented, real data | [modules/01](modules/01_COMMAND_CENTER.md) |
| Investigations / RCA | `#/investigations` | **Static content + real hand-off** | [modules/02](modules/02_RCA.md) |
| Promotion Intelligence | `#/intelligence` | **Static** (authored JSON) | [modules/03](modules/03_PROMOTION_INTELLIGENCE.md) |
| Simulation Studio | `#/simulation` | Implemented — three levers (discount, trade spend, days) | [modules/04](modules/04_SIMULATION_STUDIO.md) |
| Decision Center | `#/decision` | Implemented, no approval workflow | [modules/05](modules/05_DECISION_CENTER.md) |
| Promotion Calendar | `#/calendar` | Implemented, real data | [modules/06](modules/06_PROMOTION_CALENDAR.md) |
| Report Center | `#/reports` | Implemented, persisted artifacts | [modules/07](modules/07_REPORTS.md) |
| Data Connections | `#/connections` | **Static catalogue + live proxies** | [modules/08](modules/08_DATA_CONNECTIONS.md) |
| Settings | `#/settings` | **Static, read-only** | [modules/09](modules/09_SETTINGS.md) |
| Portal (Login / Home) | `#/login`, `#/home` | Client-side auth stand-in | [modules/09](modules/09_SETTINGS.md) |

## 5. Technology stack

| Layer | Technology |
|---|---|
| Frontend | React 19, TypeScript ~6.0, Vite 8, Tailwind CSS v4, React Router 7 (HashRouter), TanStack Query 5, Zustand 5 |
| Charts | Hand-rolled SVG components — **no charting library** |
| Backend | Python 3.13, FastAPI 0.141, Pydantic v2, Uvicorn |
| Report writers | openpyxl (`.xlsx`), reportlab (`.pdf`) |
| Analytical store | 5 CSVs → one in-process columnar cache (`array` module); **no analytical database** |
| Persistence | SQLite (stdlib), `backend/.store/tiq.db` |
| Tests | pytest — 1,470 passing (verified 2026-08-24) |

Full detail: [02_TECH_STACK.md](02_TECH_STACK.md).

## 6. How to run locally

```bash
# Backend (terminal 1)
cd backend
python -m venv .venv
./.venv/Scripts/pip install -r requirements.txt
./.venv/Scripts/python -m uvicorn app.main:app --reload --host 127.0.0.1 --port 8100

# Frontend (terminal 2)
cd frontend
npm install
npm run dev
```

Open the URL Vite prints. Sign in with **any** email and **any** password —
the login is a client-side stand-in.

Production: `npm run build` in `frontend/`, then run the backend alone; FastAPI
auto-mounts `frontend/dist/` and serves UI + API from one origin.

Full detail, including data-directory resolution and environment variables:
[10_DEPLOYMENT_AND_LOCAL_SETUP.md](10_DEPLOYMENT_AND_LOCAL_SETUP.md).

## 7. Current implementation status

**Implemented against real data**
- 5-CSV star schema loaded into one cached columnar store (205,920 fact rows)
- One KPI engine (`app/tpo/aggregate.py`) — Trade Spend, Incremental Quantity /
  Quantity %, Incremental Sales, Promotion ROI, Margin Impact, Trade Spend
  Efficiency, Cannibalization, PEI
- One filter engine with dependent option lists and 14 dimensions
- Command Center: 6 KPI cards, trend, risk alerts, 2 tables, 6 chart sections
- Promotion Calendar: matrix, cell detail, upcoming feed
- Simulation Studio: 3 separate modes over the 5 approved treatment rules
- Decision Center: assembled record + portable briefing (JSON + HTML)
- Report Center: generate → store → list → preview → download `.xlsx` / `.pdf`
- SQLite persistence for scenarios, decisions and report artifacts

**Static (authored JSON, not computed)**
- Investigations causal graph, node details, progress and confidence figures
- Promotion Intelligence (all 8 tabs) and its AI-synthesis narrative
- Data Connections catalogue, Settings content, `focus.json` context chips

**Deferred / not implemented**
- Authentication, authorization, sessions, route guards, ownership (B11)
- Approval workflow in Decision Center (no approval criteria exist)
- Frontend test suite

## 8. Major known limitations

1. **Every API route is unauthenticated, including the writes.** 63 routes, no
   guards. Safe on single-user localhost; not safe on a shared host.
2. **RCA is display fiction.** `focus.json` reports a trade spend of ₹98.6 Cr
   for a scope the engine measures at ₹7.7 Cr. The simulation contract
   deliberately refuses to let any RCA figure enter a calculation.
3. **`fact_sales.Month` and `fact_sales.Date` are untrustworthy.** 22.6% of
   rows carry a month that disagrees with their business week; 51.9% of
   CH002/CH004/CH005 rows carry a scrambled `Date`. The analytical month is
   recovered from `(Year, Week) → dim_date` everywhere.
4. **Volume-derived KPIs are not additive.** A year is not the sum of its
   months; All Channels is not the sum of five channels. This is correct
   behaviour, not a bug — see [08_KPI_AND_BUSINESS_LOGIC.md](08_KPI_AND_BUSINESS_LOGIC.md).
5. **No approval, no ownership, no notification.** Decision records are drafts,
   `owner` is always `null`, and nothing is ever emailed.

Full list: [appendices/KNOWN_LIMITATIONS.md](appendices/KNOWN_LIMITATIONS.md).

---

## Document index

| # | Document |
|---|---|
| 00 | [Project Overview](00_PROJECT_OVERVIEW.md) |
| 01 | [System Architecture](01_SYSTEM_ARCHITECTURE.md) |
| 02 | [Tech Stack](02_TECH_STACK.md) |
| 03 | [Data Architecture](03_DATA_ARCHITECTURE.md) |
| 04 | [Backend Architecture](04_BACKEND_ARCHITECTURE.md) |
| 05 | [Frontend Architecture](05_FRONTEND_ARCHITECTURE.md) |
| 06 | [API Reference](06_API_REFERENCE.md) |
| 07 | [Filter & Scope Architecture](07_FILTER_AND_SCOPE_ARCHITECTURE.md) |
| 08 | [KPI & Business Logic](08_KPI_AND_BUSINESS_LOGIC.md) |
| 09 | [Testing & Validation](09_TESTING_AND_VALIDATION.md) |
| 10 | [Deployment & Local Setup](10_DEPLOYMENT_AND_LOCAL_SETUP.md) |
| 11 | [Glossary](11_GLOSSARY.md) |
| 12 | [Change History](12_CHANGE_HISTORY.md) |

**Modules:** [Command Center](modules/01_COMMAND_CENTER.md) ·
[Investigations / RCA](modules/02_RCA.md) ·
[Promotion Intelligence](modules/03_PROMOTION_INTELLIGENCE.md) ·
[Simulation Studio](modules/04_SIMULATION_STUDIO.md) ·
[Decision Center](modules/05_DECISION_CENTER.md) ·
[Calendar](modules/06_PROMOTION_CALENDAR.md) ·
[Reports](modules/07_REPORTS.md) ·
[Data Connections](modules/08_DATA_CONNECTIONS.md) ·
[Settings](modules/09_SETTINGS.md)

**Appendices:** [API Endpoint Map](appendices/API_ENDPOINT_MAP.md) ·
[Dataset Map](appendices/DATASET_MAP.md) ·
[Known Limitations](appendices/KNOWN_LIMITATIONS.md)
