# Running TIQ locally

Two processes, two terminals.

## 1. Backend (FastAPI)

```
python -m venv venv                       # first time only, from the repo root
./venv/Scripts/pip install -r backend/requirements.txt   # first time only
cd backend
../venv/Scripts/python -m uvicorn app.main:app --reload --host 127.0.0.1 --port 8100
```
Health check: http://127.0.0.1:8100/api/health

The virtualenv lives at the repo root (`venv/`), not inside `backend/`. If
uvicorn says port 8100 is already in use, a backend is already running —
`netstat -ano | findstr :8100` gives the PID; `Stop-Process -Id <pid> -Force`
it (there are usually two python PIDs, kill both) before starting another.

**`--reload` is unreliable on this machine.** WatchFiles logs "Reloading..." but
the old server process is never replaced (seen repeatedly on 2026-09-15, on a
clean tree, under an OneDrive-hosted checkout), so backend edits appear to do
nothing. Restart by hand — kill every `uvicorn`/`spawn_main` python process,
check `netstat -ano | findstr :8100` is empty, then start again — and confirm
with a request whose answer you changed, not with `/api/health`.

Port 8100, not 8000 — 8000/8001/8002/8010/8020 were all already in use by other
local projects on this machine when this was scaffolded. Change it in both
`app/main.py`'s CORS origins and `frontend/vite.config.ts`'s proxy target if
you need to move it back.

## 1b. Agent API key (first time only)

The agent-backed features call OpenAI from the server, and the key lives in
`backend/.env`:

```
cp backend/.env.example backend/.env     # then paste your key into it
```

`backend/.env` is **gitignored**, so it is never carried by a branch, a clone or
a merge — every machine creates its own. A missing key is not a broken checkout;
it surfaces in the UI as:

> Investigation failed — No OPENAI_API_KEY configured. Add it to backend/.env and restart the server.

The server reads it once at import (`app/agents/client.py`), so **restart
uvicorn after editing the file**. Keep the key server-side: anything put in a
`VITE_*` variable is inlined into the bundle and shipped to the browser.

What actually depends on it:

| Needs the key | Works without it |
| --- | --- |
| Investigations (the whole module) | Insights Hub, Simulation, Decision, Reports, Calendar |
| Promotion Intelligence — "Go deeper" analysis | Promotion Intelligence — facts, KPIs, charts (`/facts`, `/context`) |

## 2. Frontend (Vite + React)

```
cd frontend
npm install       # first time only
npm run dev
```
Opens on http://localhost:5173 — or the next free port if that one's taken
(check the terminal output; this machine landed on 5174 during scaffolding).
Vite proxies everything under `/api/*` to the backend, so the browser only
ever talks to one origin.

## Production build (Phase 7 — cutover, complete)

```
cd frontend && npm run build
cd ../backend && ../venv/Scripts/python -m uvicorn app.main:app --host 127.0.0.1 --port 8100
```
Builds `frontend/dist/`, then runs the backend alone (no `--reload`, no Vite,
no separate connector proxy) — `app/main.py` auto-mounts `dist/` once it
exists, so this one process is the entire app: UI, API, and all 6 data
connectors. Confirmed working end-to-end at http://127.0.0.1:8100/ — sign
in, every page, and a real connector fetch (NielsenIQ → a live REST API)
all verified with the Vite dev server not even running.

This supersedes `TPO_Sushane_Frontend/TPO-New-Frontend-tpo-focused/`, the
original vanilla HTML/CSS/JS app this was migrated from — every page, the
design system, and all 6 connectors (Azure/Databricks/SAP/Power BI/
NielsenIQ/OpenAI advisor) have a verified equivalent here. That folder was
left untouched throughout the migration and hasn't been deleted; nothing
in this repo depends on it.

## Known local quirks (this machine, not the app)

- Vite sometimes only binds `::1` (IPv6 loopback), not `127.0.0.1` (IPv4) —
  use `http://localhost:<port>` if `127.0.0.1:<port>` refuses to connect.
- If `npm run dev` logs "Port 5173 is in use, trying another one," something
  else already holds it — check the terminal for which port it actually
  picked before assuming the app is down.
- Port 5173 *and* 5174 are both permanently held on this machine by an
  unrelated project (`C:\Users\TransOrg\Desktop\TPO-Platform\frontend` —
  note the different path, not this repo). Don't kill that process assuming
  it's leftover cruft. This app's dev server reliably lands on **5175**
  here; always check the terminal output rather than assuming 5173.

## Routing (Phase 3)

`HashRouter` (routes are `#/command`, `#/investigations`, ... — matches `nav.json`'s
route strings verbatim, ported straight from the vanilla app's hand-rolled hash
router). `frontend/src/App.tsx` is the route table; `pages/CommandCenter.tsx` is the
first real page, the rest are `pages/Home.tsx` until Phase 4.

Floating menus (`components/ui/Dropdown.tsx`) portal to `document.body` with
`position: fixed`, deliberately matching the vanilla app's `UI.openDropdown` — an
`absolute`-positioned menu gets trapped behind later sibling cards because our
`.fade-in`/`.fade-in-up` entrance animations establish a stacking context (animating
`opacity`/`transform` does that per spec) wherever they're used as an ancestor. If a
future floating element (tooltip, popover) needs the same treatment, portal it too
rather than trying to out-z-index the animation.

## Portal (Phase 5)

`/login` and `/home` — ported from login.html/home.html + js/portal.js. Client-side
auth is a real server session (`hooks/useAuth.ts` → `POST /api/auth/login`) —
no real identity provider yet. `/` redirects to `/login`; the live "Trade Promotion
Optimization" module card on Home links straight to `/command` via React Router
(a same-app navigation now, vs. the vanilla app's full page load to `index.html`).

`components/portal/` — `ModuleGrid`, `ConnectorRail`, `AdvisorCard` (OpenAI capability
chat), `modals/` (Upload, Azure, Databricks, SAP, PowerBI, Nielsen).

Connector backends were intentionally left unchanged in this phase — see Phase 6 below
for where that logic moved.

## Connectors (Phase 6)

`backend/app/routers/connectors.py` — Databricks/SAP/Power BI/NielsenIQ/OpenAI proxy
logic ported from the standalone `connector_proxy.py` (stdlib `urllib`) onto
FastAPI + `httpx.AsyncClient`, same request/response shapes and error semantics
(`_upstream_error`'s heuristics, the Databricks "got an HTML login page back" check,
etc.) — mounted at `/api/proxy/*` alongside the rest of the API.

`frontend/src/lib/portalConnectors.ts`'s `PROXY_BASE` now points at `/api` instead of
`http://127.0.0.1:8020` — same-origin via the Vite dev proxy in dev, and genuinely
same-origin in prod once FastAPI serves the built frontend (Phase 7). No separate
`python connector_proxy.py` process to start anymore; the 5 connector modals'
user-facing copy was updated to stop mentioning it. Azure Blob Storage is unaffected —
it never went through the proxy (CORS-native, direct browser fetch).

One behavior difference worth knowing: FastAPI's `HTTPException` serializes errors as
`{"detail": "..."}`, not the old proxy's `{"error": "..."}` — `proxyFetch()` checks
both keys so nothing broke, but new connector work should follow the `detail` shape.

Run `./.venv/Scripts/pip install -r requirements.txt` again after pulling this phase —
it added `httpx`.

## Pages (Phase 4)

All 9 routes are real pages now — `pages/{CommandCenter,Investigations,Intelligence,
Simulation,Decision,Calendar,Reports,Connections,Settings}.tsx`. `pages/Home.tsx`
is no longer used by any route but is left in place as a template if a 10th page is
ever needed.

- **Investigations**: radial causal graph (`components/investigations/`), node detail
  side-popover, staged multi-agent "build" choreography, query bar with keyword-based
  type inference.
- **Intelligence**: 8 tabs (`components/intelligence/`), streaming AI-synthesis answer
  with `[g]/[r]/[n]` tone markup (`useStreamedAnswer`, once per investigation type per
  session via a module-level `Set`).
- **Simulation**: the deterministic scenario engine (`components/simulation/
  simulationEngine.ts` — `compute()`, `buildRisk()`) ported verbatim; multi-scenario
  compare mode, lever dirty-tracking, the 5s "engine warmup" / recompute overlay.
- **Decision**: approval workflow stepper, governance/strategy/impact cards.
- Active investigation state (type + question + recent list) lives in a Zustand store,
  `store/activeInvestigation.ts`, persisted to localStorage — carries across all 4
  investigation-linked pages exactly like the vanilla app's `window.getActiveInvType()`
  globals did.
- Deliberate simplification, applied consistently: connector/source logos (AI-answer
  source pills, Data Connections cards) use the existing icon set with tinted badges
  instead of porting ~10 bespoke brand SVG marks pixel-for-pixel.

## Design system (Phase 2)

`frontend/src/icons/` — ported icon set (`ICON_PATHS` + `<Icon name="..."/>`).
`frontend/src/components/ui/` — Button, Pill, Badge, Chip, Card, IconButton,
Spinner, Kpi, Tabs, Field/Input/Select/Textarea, Modal, Toast (`useToast()`).
`frontend/src/components/charts/` — Sparkline, Donut, DonutBreakdown,
GroupedBar, DualLine, Waterfall, Forecast, ComboBarLine — hand-rolled SVG,
ported 1:1 from `js/components/charts.js` et al. in the vanilla app.
`frontend/src/components/layout/` — Sidebar, Topbar, AppShell (wired to
`useNav`/`useUser`). All ported from `css/components.css` + `css/layout.css`
rules onto Tailwind utilities that reference the tokens in `tokens.css` —
no new colors/spacing invented, only translated.

## TPO Insights Hub backend (real data)

The Insights Hub reads the finalized TPO datasets through a new FastAPI
service. Run it exactly as above — no extra process, no database.

```
backend/app/tpo/
  config.py      one place for the data path, the 1.5 ROI target and the
                 INR->USD rate. Nothing else reads os.environ.
  loader.py      the 5 CSVs -> one cached columnar store (~15 MB, ~2 s once)
  filters.py     THE filter engine + dependent option lists
  aggregate.py   THE KPI engine — adapted from the validated previous project
  service.py     payloads for the 7 endpoints
  formatting.py  currency, magnitude and the F24/F25 labels
```

Datasets resolve in order: `$TPO_DATA_DIR`, then the in-repo `Data/`, then
`~/OneDrive/Desktop/TPO_FINAL/`.
`TPO_USD_PER_INR` overrides the exchange rate (default 0.0115).

Endpoints, all taking the same filter query params:

```
/api/command-center/{filters,kpis,trend,risk-alerts,
                    underperforming-promotions,promotion-mix,top-promotions}
```

Tests: `cd backend && ../venv/Scripts/python.exe -m pytest tests/ -q`

### Two things that look like bugs and are not

**A year is not the sum of its months.** Trade Spend and Margin Impact are
plain row sums and do add up. Incremental Sales, ROI and PEI are measured
against a baseline re-derived from whatever is selected, so January's uplift
is judged against January's ordinary trading and the year's against the
year's. `test_incremental_sales_is_not_additive_across_months` pins this.

**The baseline is keyed on (product, CHANNEL), not product alone.** `Schedule`
is a property of the channel — CH001/CH004 book one row per week (mean
Base_Quantity 142.9), CH002/CH003/CH005 one per month (576.9). Pooling them
measures period length rather than promotional response: it drags F25
all-channel ROI from 2.4 to 1.1. `test_baseline_is_keyed_per_channel`
guards it.
