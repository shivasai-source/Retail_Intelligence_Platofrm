# Module 08 — Data Connections

**Route:** `#/connections` · **Page:** `frontend/src/pages/Connections.tsx`
**Sidebar label:** "Data Connections"
**Status:** **The platform's front door** — the one surface that gets data in

This page used to be a static catalogue read from `connections.json`, sitting
beside a second, genuinely live connector rail on the portal (`#/home`). Two
surfaces carried the name, neither pointed at the other, and only one of them
worked. That is no longer the case:

- The **portal rail is gone**. `#/home` is the module grid and nothing else.
- **This page is the only place a connection is made**, and it is where the TPO
  module card sends a user who has no dataset yet.
- Its catalogue is **ported from `transorg-engineering/connector-template`** —
  the same families, categories, copy and tile layout — with this platform's own
  four working connectors promoted to `available` and the rest carried as
  greyed-out `planned` entries.

## 1. The page

Three bands, top to bottom.

### The dataset strip

Reads `GET /api/datasets/star` (`useStarStatus()`) and states plainly what the
platform holds:

| State | Strip |
|---|---|
| Six tables present | Green. "Dataset loaded from {source}", `6 of 6 core tables`, and a **Continue to Insights Hub** button |
| Anything less | Neutral. "No dataset loaded yet", `n of 6 core tables`, and what the six tables are for |

`{source}` is read from `localStorage` (`tiq_dataset_source`), written by
whichever connector installed the schema. The backend stores the six files but
not their provenance, so the browser is the only thing that can name it; when it
cannot, the strip says "Dataset loaded" without claiming a source.

### Search and family filter

A search box over label/description/category, and three chips — **All sources**,
**Files & objects**, **Tables & rows** — filtering on `family`. Both are the
template's, verbatim in behaviour.

### The catalogue

`frontend/src/components/portal/catalog.ts` — **27 entries in five sections**,
ordered by `CATEGORY_ORDER`:

| Category | Entries | Available |
|---|---|---|
| Object storage | 10 | Excel / Shared Drives, Azure Blob Storage |
| Warehouse | 4 | Databricks |
| Database | 6 | — |
| SaaS | 6 | — |
| BI & reporting | 1 | Power BI |

An `available` tile carries a `portalKey` naming the connector in
`connectors.ts` whose modal it raises; a `planned` tile carries none, renders at
`opacity-55` with a **Soon** pill, and is a `disabled` button. That pairing is
what makes a tile clickable, so the two cannot drift apart.

> This is the template's own `stub()` convention and its reason holds here: an
> honest "Soon" beats a tile that fails after you have typed credentials into
> it. Promoting one is a one-line change — give it a `portalKey` and flip
> `status` — once a connector exists behind it.

Logos come from `components/portal/ConnectorLogo.tsx`, also ported: brand marks
from the `simple-icons` package, plus in-house glyphs for the Amazon, Microsoft
and Salesforce marks that package no longer ships. The chip stays white in both
themes, because several marks are near-black and vanish on a dark card.

A **Connected** pill appears on a tile for one of two reasons: it is the
connector the installed star schema came from, or it holds a saved sign-in of
its own in `sessionStorage`. Power BI never installs a dataset, so the second is
the only way it can be marked connected.

## 2. The gate

Every other TPO page is computed from the six star-schema CSVs, so with `Data/`
empty they have nothing to render. Three mechanisms, one truth
(`status.complete`):

| Where | Behaviour |
|---|---|
| `components/RequireDataset.tsx` | Route gate. Replaces the page with an upload prompt, and links here |
| `components/layout/Sidebar.tsx` | Locks the nav. Every row but **Data Connections** and **Settings** renders as a dimmed, `aria-disabled` `<span>` with a padlock — no `href`, so ctrl-click and "open in new tab" cannot get around it |
| `components/portal/ModuleGrid.tsx` | The TPO card routes to `#/connections` instead of `#/command`, and says so with a "Connect data first" pill |

The lock lifts the moment an install succeeds: the mutation invalidates every
query, `useStarStatus` re-fetches, and `complete` flips. No reload, no restart.

`ALWAYS_OPEN` in `Sidebar.tsx` is the list of keys that stay reachable — gating
this page would lock the user out of the only screen that can clear the gate.

## 3. The connector proxy — unchanged

`backend/app/routers/connectors.py`. Nothing in this module's rework touched the
backend.

| Connector | Path |
|---|---|
| Excel / Shared Drives | Local upload → `POST /api/datasets` + star install |
| Azure Blob Storage | **Direct browser fetch — not proxied** |
| Databricks | `POST /api/proxy/databricks/{warehouses,query}` |
| Power BI | `POST /api/proxy/powerbi/{workspaces,reports}` |
| SAP S/4HANA | `POST /api/proxy/sap/odata` — modal exists, **not in the catalogue** |
| NielsenIQ | `POST /api/proxy/generic/rest` — modal exists, **not in the catalogue** |

### Why a proxy exists

> *"Databricks' REST API and most SAP Gateway/OData services don't send
> `Access-Control-Allow-Origin` headers, so a browser calling them directly gets
> blocked by CORS regardless of how correct the credentials are… Forwarding
> server-to-server, where CORS doesn't apply, is the only fix."*

**Azure Blob Storage is never routed through it** — it is CORS-native, so the
browser fetches it directly, and its SAS token stays in `sessionStorage` only.

Since the proxy lives inside the same FastAPI process that serves the frontend,
the browser talks to one same-origin backend for everything. There is **no
separate `connector_proxy.py` process** to start; `PROXY_BASE` in
`lib/portalConnectors.ts` points at `/api`.

### Credential handling

> *"Credentials submitted through the connector modals are forwarded straight to
> Databricks/SAP/Power BI/etc. and back; **nothing is persisted to disk or
> logged**."*

### Error semantics

`upstream_error()` unwraps Microsoft-style `{"error": {"code", "message"}}`
bodies and preserves the Databricks "got an HTML login page back" check. Network
failure → **502** naming the host and suggesting VPN. Timeout: **45 s**
(`connectors.TIMEOUT`).

> **Migration note.** FastAPI serialises errors as `{"detail": …}`, not the old
> proxy's `{"error": …}`. `proxyFetch()` checks both keys so nothing broke, but
> new connector work should follow the `detail` shape.

## 4. What feeds the analytics

The six CSVs under `Data/`, resolved by `app/tpo/config._resolve_data_dir()` and
loaded by `app/tpo/loader.py`. Three connectors write them: the Excel upload
through `POST /api/datasets`, Azure Blob through `POST /api/datasets/azure/install`
and Databricks through `POST /api/datasets/databricks/install`. Power BI reads
workspaces and installs nothing.

## 5. Reports

**No report is generated from this module** — it is absent from
`reports.service.MODULES`.

## 6. Known limitations

| # | Limitation |
|---|---|
| 1 | **23 of 27 catalogue entries are `planned`** and refuse to connect. They are labelled "Soon" and disabled, but they are still a catalogue of things that do not work |
| 2 | SAP S/4HANA and NielsenIQ have **working modals that no tile raises** — they were hidden on the old portal rail and were not carried into the catalogue |
| 3 | `GET /api/connections` and `backend/app/data/connections.json` are **dead**: the authored eight-row catalogue they serve has no reader. `useConnections()` and `types/connections.ts` are likewise unreferenced |
| 4 | The **Connected** pill depends on `localStorage`; a dataset installed in another browser shows as loaded but sourceless |
| 5 | Connector credentials transit the server process. On an exposed host, `POST /api/proxy/generic/rest` will call **any URL it is given** — an open forwarder |
| 6 | The proxy routes are **unauthenticated**, like every other route |

## 7. File map

| Concern | File |
|---|---|
| Page | `frontend/src/pages/Connections.tsx` |
| Catalogue | `frontend/src/components/portal/catalog.ts` |
| Logos | `frontend/src/components/portal/ConnectorLogo.tsx` |
| Connector keys | `frontend/src/components/portal/connectors.ts` |
| Modals | `frontend/src/components/portal/modals/*` |
| Route gate | `frontend/src/components/RequireDataset.tsx` |
| Nav lock | `frontend/src/components/layout/Sidebar.tsx` (`ALWAYS_OPEN`) |
| Module card | `frontend/src/components/portal/ModuleGrid.tsx` |
| Client | `frontend/src/lib/portalConnectors.ts` |
| Hook | `frontend/src/hooks/useDatasets.ts` (`useStarStatus`) |
| Types | `frontend/src/types/portal.ts` |
| Router (proxies) | `backend/app/routers/connectors.py` |
| Router (datasets) | `backend/app/routers/datasets.py` |
| Tests | **none** |
