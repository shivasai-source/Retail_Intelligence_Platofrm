# Module 08 — Data Connections

**Route:** `#/connections` · **Page:** `frontend/src/pages/Connections.tsx` (modified in the working tree)
**Sidebar label:** "Data Connections"
**Status:** **Static catalogue** + **live connector proxies on the Portal**

Two different things carry this name in the repository, and they are not
connected to each other:

| | Data Connections page (`#/connections`) | Portal connector rail (`#/home`) |
|---|---|---|
| What it shows | A **catalogue** read from `connections.json` | Six connectors with working modals |
| Backed by | Authored JSON | Live `httpx` proxies at `/api/proxy/*` |
| Can it fetch data? | **No** | **Yes** — real credentials, real upstream calls |
| Does anything reach the TPO datasets? | **No** | **No** |

## 1. The Data Connections page — static

`GET /api/connections` → `backend/app/data/connections.json`. Eight rows:

| Name | Description | Status | Rows | Freshness |
|---|---|---|---|---|
| SAP S/4HANA | Sales, pricing, claims | Connected | 2.4M | 2 min ago |
| NielsenIQ | — | Connected | — | — |
| DMS | — | Connected | — | — |
| Retail Execution App | — | Connected | — | — |
| Excel / Shared Drives | — | Connected | — | — |
| Promo Calendar | — | Connected | — | — |
| Power BI | — | Available | — | — |
| Snowflake | — | Available | — | — |

Row shape: `{ name, desc, status, rows, freshness, logo }`.

**Every field is authored.** No connection is tested, no row count is measured
and no freshness timestamp is real. The page header reads
`"{n} sources connected · {m} available · all systems healthy"` — computed from
the JSON's own `status` strings.

### The KPI strip is hardcoded in the page

```tsx
<Kpi label="Connected"   value={String(connected.length)} … />
<Kpi label="Avg Refresh" value="3.8 min"  … />
<Kpi label="Rows Today"  value="142K+"    … />
<Kpi label="Governance"  value="92%"      … />
```

Only "Connected" is derived (from the JSON). **"3.8 min", "142K+" and "92%" are
string literals in the TSX**, as are "SLA met", "+18% vs avg" and "Compliant".

### Export Catalog — disabled with a reason

```tsx
<Button variant="secondary" disabled
  title="Connector configuration is not a reportable dataset. Report export is
         available on Command Center, Simulation Studio and Decision Center.">
  <Icon name="download" /> Export Catalog — not available
</Button>
```

The page's own comment records why: *"This had no handler at all — an enabled
button that did nothing."* It is now disabled and says why rather than
pretending.

**Add Source** shows a toast (`"Opening connector catalog…"`) and does nothing
else.

## 2. The Portal connector rail — genuinely live

`frontend/src/components/portal/connectors.ts` — six connectors on `#/home`:

| Key | Name | Description | Default | Path |
|---|---|---|---|---|
| `sap` | SAP S/4HANA | Sales, pricing, claims — via OData | off | `POST /api/proxy/sap/odata` |
| `niq` | NielsenIQ | Market & scanner data — custom endpoint | off | `POST /api/proxy/generic/rest` |
| `pbi` | Power BI | Existing dashboards & reports | off | `POST /api/proxy/powerbi/{workspaces,reports}` |
| `xls` | Excel / Shared Drives | Promotion planning files | **on** | Local upload modal |
| `azure` | Azure Blob Storage | Blob containers & Data Lake files | off | **Direct browser fetch — not proxied** |
| `databricks` | Databricks | SQL warehouses & Delta tables | off | `POST /api/proxy/databricks/{warehouses,query}` |

Modals: `components/portal/modals/{Sap,Nielsen,PowerBi,Upload,Azure,Databricks}Modal.tsx`.

The `AdvisorCard` is a seventh live path — `POST /api/proxy/openai/chat`.

### Why a proxy exists

`backend/app/routers/connectors.py`:

> *"Databricks' REST API and most SAP Gateway/OData services don't send
> `Access-Control-Allow-Origin` headers, so a browser calling them directly gets
> blocked by CORS regardless of how correct the credentials are… Forwarding
> server-to-server, where CORS doesn't apply, is the only fix."*

**Azure Blob Storage is never routed through it** — it is CORS-native, so the
browser fetches it directly.

Since the proxy now lives inside the same FastAPI process that serves the
frontend, the browser talks to one same-origin backend for everything. There is
**no separate `connector_proxy.py` process** to start; `PROXY_BASE` in
`lib/portalConnectors.ts` points at `/api`.

### Credential handling

> *"Nothing here talks to Claude or any third party [beyond the named upstream].
> Credentials submitted through the portal's connector modals are forwarded
> straight to Databricks/SAP/Power BI/etc. and back; **nothing is persisted to
> disk or logged**."*

### Error semantics

`upstream_error()` carries the original proxy's heuristics: Microsoft-style
`{"error": {"code", "message"}}` bodies are unwrapped, and the Databricks
"got an HTML login page back" check is preserved. Network failure → **502**
naming the host and suggesting VPN.

Timeout: **45 s** (`connectors.TIMEOUT`).

> **Migration note.** FastAPI serialises errors as `{"detail": …}`, not the old
> proxy's `{"error": …}`. `proxyFetch()` checks both keys so nothing broke, but
> new connector work should follow the `detail` shape.

## 3. What actually feeds the analytics

**Nothing on either surface.** The TPO datasets are the five CSVs under `Data/`,
resolved by `app/tpo/config._resolve_data_dir()` and loaded by
`app/tpo/loader.py`. No connector writes to them, and no connector response
reaches the KPI engine.

The Excel upload modal accepts files client-side; it does not ingest them into
the analytical store.

## 4. Reports

**No report is generated from this module** — it is absent from
`reports.service.MODULES`, and the page's disabled Export Catalog button states
the reason.

## 5. Known limitations

| # | Limitation |
|---|---|
| 1 | The `#/connections` catalogue is **entirely authored**. Statuses, row counts and freshness are not measured |
| 2 | Three of the four KPI tiles are **string literals in the TSX** |
| 3 | The catalogue and the working portal connectors are **two disjoint lists** (SAP, NielsenIQ and Power BI appear in both; DMS, Retail Execution App, Promo Calendar and Snowflake are catalogue-only; Azure Blob Storage and Databricks are portal-only) |
| 4 | **No connector feeds the analytical datasets** |
| 5 | Connector credentials transit the server process. On an exposed host, `POST /api/proxy/generic/rest` will call **any URL it is given** — an open forwarder |
| 6 | The proxy routes are **unauthenticated**, like every other route |
| 7 | Add Source is a toast |

## 6. File map

| Concern | File |
|---|---|
| Page | `frontend/src/pages/Connections.tsx` |
| Portal rail | `frontend/src/components/portal/ConnectorRail.tsx`, `connectors.ts` |
| Modals | `frontend/src/components/portal/modals/*` (7 files) |
| Advisor | `frontend/src/components/portal/ConnectorRail.tsx` |
| Client | `frontend/src/lib/portalConnectors.ts` |
| Hook | `frontend/src/hooks/useMisc.ts` |
| Types | `frontend/src/types/connections.ts`, `portal.ts` |
| Router (catalogue) | `backend/app/routers/misc.py` |
| Router (proxies) | `backend/app/routers/connectors.py` (303 lines, 7 routes) |
| Data | `backend/app/data/connections.json` |
| Tests | **none** |
