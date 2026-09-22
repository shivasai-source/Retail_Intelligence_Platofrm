# 06 — API Reference

**63 routes**, enumerated from `app.openapi()` on 2026-08-24. Interactive docs
are served at `/docs` (Swagger) and `/redoc` when the app is running.

> **AUTHENTICATION: NONE.** No route in this application is guarded. There is
> no identity provider, no session, no token and no route guard anywhere. The
> five `/api/store/*` routes and `POST/DELETE /api/reports*` are **writes any
> caller can reach**. Every store route repeats this in its OpenAPI
> description. See [appendices/KNOWN_LIMITATIONS.md](appendices/KNOWN_LIMITATIONS.md).
>
> Note: `app/routers/store.py`'s docstring says "none of the **52** routes in
> this application is [guarded]". The count is now 63; the statement itself
> remains true.

Compact table form: [appendices/API_ENDPOINT_MAP.md](appendices/API_ENDPOINT_MAP.md).

---

## 0. Health

### `GET /api/health`
`{ "ok": true, "service": "tiq-api" }`. No parameters.

---

## 1. Command Center — `/api/command-center` (8 routes)

**All eight accept the same filter query parameters**, parsed once by
`routers/command_center.get_filters` into the one `FilterState`.

### Shared filter parameters

| Param | Type | Notes |
|---|---|---|
| `year` | int | Real calendar year (2024 / 2025). Absent = All Years |
| `month` | int 1–12 | Absent = whole year |
| `channel` | list[str] | `Channel_Id` — repeat the key: `?channel=CH002&channel=CH003` |
| `retailer` | list[str] | |
| `region` | list[str] | |
| `state` | list[str] | |
| `city` | list[str] | |
| `tier` | list[str] | |
| `distributor` | list[str] | |
| `category` | list[str] | |
| `brand` | list[str] | The Brand Form |
| `product` | list[str] | `Product_id` |
| `promotion` | list[str] | `Promotion_Id` (the Offer) |
| `promotion_type` | list[str] | Regular / Seasonal / Normal |
| `currency` | `INR`\|`USD` | **Display only.** Default `INR` |

Within a dimension values are **OR**ed; across dimensions they are **AND**ed.
An empty list and an `"All …"` token both mean *unconstrained*.

Every response carries a `meta` block:

```json
{ "period": "October F25", "period_label": "F25", "comparison_period": "F24",
  "currency": "INR", "base_currency": "INR", "exchange_rate": 1.0,
  "target_roi_pct": 50.0, "row_count": 4312, "filters_applied": { … } }
```

---

### `GET /api/command-center/filters`
Dependent option lists for the current selection.

**Response:** `years[]`, `year_labels{}` (`"2025": "F25"`), `months[{code,name}]`,
`channels[{code,name}]`, `retailers[{code,name}]`, **`retailer_available`** (bool —
false for a B2B-only scope), `regions[]`, `states[]`, `cities[]`, `tiers[]`,
`distributors[]`, `categories[]`, `brands[]`, `products[{code,name}]`,
`offers[{code,name,type}]`, `promotion_types[]`, `currencies[]`, `selected{}`.

An option appears **iff** picking it returns at least one row.

**Frontend consumer:** `useFilterOptions` → `FilterBar`, and the scope pickers
in the Simulation Studio.

---

### `GET /api/command-center/kpis`
The six KPI cards.

Extra param: `currency`.

```json
{ "kpis": {
    "trade_spend": {
      "key": "trade_spend", "label": "Trade Spend", "unit": "currency",
      "value": 907189245.0, "display_value": "₹90.7 Cr",
      "previous_value": 812…, "delta": 11.7, "delta_display": "+11.7%",
      "delta_sub": "vs F24", "difference": …, "trend": "up",
      "available": true, "unavailable_reason": null,
      "info": { "name": …, "formula": …, "meaning": … }
    },
    "incremental_sales": {…}, "promotion_roi": {…}, "margin_impact": {…},
    "pei": {…},
    "cannibalization_rate": { …, "comparable_events": 47, "measured_at": null }
  },
  "meta": {…} }
```

Card keys: `trade_spend`, `incremental_sales`, `promotion_roi`,
`margin_impact`, `pei`, `cannibalization_rate`.

`value` is always the canonical **base-currency** number; only `display_value`
is converted. ROI, PEI and Cannibalization carry the same `value` in both
currencies by construction.

**Cannibalization extras.** When the pinned scope has fewer than
`CANNIBALIZATION_MIN_EVENTS = 3` comparable events, `value` is suppressed to
`null` with an `unavailable_reason`, and `measured_at` may carry a wider-scope
measurement:

```json
"measured_at": { "value": 12.4, "display_value": "12.4%",
                 "comparable_events": 9, "lifted": ["channel"],
                 "scope_label": "Diwali Special 25 · all channels" }
```

**Frontend consumer:** `useKpis` → `TpoKpiTile` grid.

---

### `GET /api/command-center/trend`
Trade Spend, Incremental Sales and ROI over time.

Extra params: `granularity` = `week` (default) | `month`, `currency`.

```json
{ "granularity": "week",
  "labels": ["W01 F25", "W02 F25", …],
  "series": { "roi": [141.2, …], "incremental_sales": [...],
              "trade_spend": [...], "target_roi": [50.0, …] },
  "display": { "incremental_sales": ["₹1.2 Cr", …], "trade_spend": […], "roi": […] },
  "meta": {…} }
```

Trade Spend and Incremental Sales **sum exactly** to the headline cards over the
same selection: `period_series` holds the selection-wide baseline fixed and
groups only the per-row terms. `roi` per point goes through the same
`roi_percent`. A `null` in `roi` means no spend in that period.

**Frontend consumer:** `useTrend` → `TrendPanels`.

---

### `GET /api/command-center/risk-alerts`
Promotion events below the ROI target, banded and ranked.

Extra params: `currency`, `limit` (default 20).

```json
{ "counts": { "critical": 12, "high": 31, "medium": 44,
              "target_achieved": 210, "total_events": 297 },
  "alerts": [ { "id": "P21-64ct|CH002|2025-W41|PBDI25",
                "severity": "Critical", "tone": "danger",
                "title": "ROI below target — Diwali Special 25",
                "description": "…: ROI 12.4% against a 50% target.",
                "roi_pct": 12.4, "trade_spend": …, "trade_spend_display": "₹1.2 Cr",
                "incremental_sales": …, "at_stake": …, "at_stake_display": "₹0.6 Cr",
                "channel": "Modern Trade", "product": "…", "week": "2025-W41",
                "promotion_id": "PBDI25", "product_id": "P21-64ct",
                "channel_id": "CH002" } ],
  "meta": {…} }
```

- **Grain:** one promotion **event** = `(product, channel, business week, offer)`.
- **Bands** (`config.SEVERITY_BANDS`, ROI %): Critical `< 25`, High `25–40`,
  Medium `40–50`. At or above 50% is not an alert.
- **Ranking** (`_rank_key`): At Stake DESC → Trade Spend DESC → ROI ASC.
  At Stake leads deliberately, so a tiny promotion with a catastrophic
  percentage does not outrank a large one quietly losing more money.
- **At Stake** = `max(trade_spend × 1.50 − incremental_sales, 0)` — the extra
  incremental revenue needed to reach target. Never negative.
- **`week` is deliberately not a drill-down filter.** `FilterState` has no week,
  and narrowing to the promoted week would remove the non-promoted rows the
  counterfactual needs, collapsing ROI to −100%.

**Frontend consumer:** `useRiskAlerts` → `RiskAlertsPanel`, `AlertBanner`.

---

### `GET /api/command-center/underperforming-promotions`
Same event grain, ROI below target, sorted by At Stake DESC.

Extra params: `currency`, `limit` (default 20).

Row fields: `promotion`, `promotion_id`, `product`, `product_id`, `channel`,
`channel_id`, `period` (week key), `roi_pct`, `roi_display`, `vs_target_pp`,
`trade_spend`, `trade_spend_display`, `at_stake`, `at_stake_display`,
`primary_cause`, `action`, `status`. Plus `total` and `meta`.

`primary_cause` / `action` come from `service._CAUSES` — four ordered
predicates over numbers the engine already produced; first match wins. Nothing
is invented.

---

### `GET /api/command-center/top-promotions`
Best-performing events by ROI descending. Extra params: `currency`,
`limit` (default 10).

Row fields: `promotion`, `product`, `channel`, `period`, `roi_pct`,
`roi_display`, `vs_target_pp`, `trade_spend(_display)`,
`incremental_sales(_display)`, `status` (`On Track` | `Underperforming`).

---

### `GET /api/command-center/promotion-mix`
Trade Spend share by offer, grouped on `Promotion_Id` and labelled by
`Promotion.label` (the description). Extra param: `currency`.

```json
{ "slices": [ { "code": "PBDI25", "label": "Diwali Special 25", "type": "Seasonal",
                "spend": …, "spend_display": "₹4.1 Cr", "pct": 18.3,
                "color": "#7C5CFF" } ],
  "total_spend": …, "total_spend_display": "…", "meta": {…} }
```

Only offers present in the selection are returned. Buckets are never
reverse-engineered from a realised price.

---

### `GET /api/command-center/breakdown`
**Every KPI, per value of one dimension.** One endpoint behind every ranking
chart — deliberately not one per dimension.

| Param | Values |
|---|---|
| `by` **(required)** | `channel`, `retailer`, `product`, `category`, `brand`, `promotion`, `promotion_mechanic`, `promotion_type`, `distributor`, `region`, `state`, `city` |
| `metric` | `incremental_sales` (default), `trade_spend`, `incremental_units`, `roi` |
| `limit` | 1–50, default 10 |
| `currency` | |

```json
{ "by": "channel", "metric": "incremental_sales",
  "groups": [ { "code": "CH002", "label": "Modern Trade",
                "trade_spend": …, "trade_spend_display": "₹4.1 Cr",
                "incremental_units": …, "incremental_sales": …,
                "incremental_sales_display": "…", "roi": 141.2,
                "margin_impact": 33.8, "pei": 66,
                "cannibalization": 8.4, "share_pct": 31.2 } ],
  "truncated": false, "total_groups": 5, "meta": {…} }
```

- `by=promotion_mechanic` groups on `Promotion_Name` (the mechanic, e.g.
  "20% Discount") and each group additionally carries **`members`** — the
  `Promotion_Id`s behind it, so a caller can re-scope through the existing
  `promotion` filter instead of hard-coding a mechanic map.
- **`share_pct` is computed on Trade Spend only** — the one additive money
  measure. Incremental Sales does not reliably add up (−17.6% on this data),
  so the caller must render a **ranking, never a composition**.
- `null` metrics sort last regardless of direction.

`tests/test_breakdown.py` asserts the partition fast path and a genuine
re-filter agree for every supported dimension.

---

## 2. Promotion Calendar — `/api/promotion-calendar` (3 routes)

Mounted separately from `/api/calendar` (the legacy business-event feed), whose
contract is unchanged.

### `GET /api/promotion-calendar/matrix?year=&channel=`
`channel` may repeat; omitted = every channel. An unknown code → **422** naming
it.

```json
{ "year": 2025, "years": [2024, 2025],
  "months": [{ "month": 1, "name": "January", "abbr": "Jan" }, …],
  "all_channels": [ { "channel_id": "CH001", "name": "E-commerce",
                      "cadence": "WEEKLY" }, … ],
  "channels": [ { "channel_id": "CH002", "name": "Modern Trade",
                  "cadence": "MONTHLY",
                  "cells": [ { "month": 10, "kind": "festival",
                               "label": "Dussehra Deal 25 + Diwali Special 25",
                               "promotion_ids": ["PBDU25","PBDI25"],
                               "product_count": 9, "promotion_count": 3,
                               "extra_regular": 1 } ] } ] }
```

`all_channels` is the **full roster** independent of the `channel` filter, so
the picker never traps the user in one channel. `kind` ∈ `none`, `regular`,
`seasonal`, `festival` (two or more seasonal events in one month).

### `GET /api/promotion-calendar/cell?year=&month=&channel=`
`month` 1–12, `channel` must be one of CH001–CH005.

Returns `cell` (as above), `promotions[]` (each with `promotion_id`, `mechanic`,
`type`, `description`, `metadata_missing`, `product_count`, `weeks[]`,
`products[]`), and — **for WEEKLY channels only** — `weeks[]` with
`week_key`, `week_number`, `week_start` (ISO) and that week's promotions.

`products[]` are ordered by Brand Form then SKU rank (smallest → largest pack),
never alphabetically.

### `GET /api/promotion-calendar/upcoming?year=&after_month=&channel=&limit=`
`after_month` 0–12 (0 = whole year), `limit` 1–200 default 60.

Merges two real sources, never synthesised:
1. **Promotion starts** from the fact stream — `source: "promotion"`,
   with `promotion_id`, `product_count`, `week_number`.
2. **Business events** from `app/data/calendar.json` — `source: "event"`,
   types `review` / `launch` / `extension` / `data` / `closure`. That file
   holds **June–July 2025 only**.

Sorted by `(date, channel_id, name)`. **The feed never crosses years.**

---

## 3. Simulation Studio — `/api/simulation` (3 routes)

All POST with a JSON body. Every body sets `extra="forbid"`, so an unknown
field is a **422** rather than a silent ignore. The shared `filters` object
mirrors `FilterState` exactly (`tests/test_studio.py` asserts the field names
equal `filters.DIMENSIONS`). Service: `app/tpo/studio.py`; full description in
[modules/04](modules/04_SIMULATION_STUDIO.md).

### `POST /api/simulation/scope`
Body `{ filters?, currency? }`.

Returns, for the scope: `measured` (its history — revenue, trade spend,
incremental sales, ROI), `observed_plan` (spend-weighted average depth,
typical run length in weeks and days), `levers` — each of `discount_pct`,
`days`, `trade_spend` as `{min, max, step, default, unit}` — the `model`
(provenance, coefficients, residual band, evidence counts, observed and
allowed depth range, fade and post-promotion-dip findings, notes) and
`exchange_rate` for the budget slider's live readout.

**422** — `Nothing to simulate` when no product-channel in scope has a
non-promoted week to base a scenario on.

### `POST /api/simulation/simulate`
Body `{ filters?, currency?, discount_pct, trade_spend, days }`.

Returns `baseline` (no promotion), `current_plan` (the scope's observed depth
at full coverage over the same window) and `scenario`, each carrying
`revenue`, `units`, `trade_spend`, `incremental_sales`, `incremental_units`,
`roi`, `margin_pct` and a `band` (revenue, ROI and incremental sales at the
low and high end of the lift band); `deltas.revenue` (`absolute`, `percent`,
`direction`) and `deltas.roi` (`absolute`, `direction`, `status` ∈
`profitable | break_even | loss_making | not_applicable`); `vs_baseline`;
`levers.trade_spend` (`requested`, `consumed`, `full_coverage_cost`,
`coverage`, `binding`, `unspent`); `window` (`days`, `weeks`,
`partial_week_fraction`); `lift` (low / mid / high); `weekly` (one entry per
business week with baseline, current and scenario revenue, the scenario's
low/high, and each plan's weekly ROI); `after_window` (only when a
post-promotion dip was detected); `model`; `method`.

Every monetary figure is `{value, display}` — `value` in base currency INR,
`display` in the requested currency. ROI is a bare two-decimal multiple.

**422** with a reason — a depth outside the model's domain (the deepest
observed depth plus 5 points), a window outside 1–35 days, a negative budget,
an unknown lever, or nothing to simulate. Never a zeroed result.

### `POST /api/simulation/curve`
Body `{ filters?, currency?, trade_spend, days }`.

Returns `points` — one per discount depth from 0 to the model's domain in
2.5-point steps (plus the current plan's depth, flagged `is_current_plan`),
each with `coverage`, `revenue` / `revenue_low` / `revenue_high`,
`trade_spend`, `roi` / `roi_low` / `roi_high` and `roi_status` — with
`current_plan_discount_pct`, `break_even_roi` (1.0) and `method`. Each point
is the same arithmetic `/simulate` runs at that depth. Same 422s as
`/simulate`.

---

## 4. Decision Center — `/api/decision` (2 POST + 3 legacy GET)

### `POST /api/decision/record`
Body — five results the client **already holds**, posted back rather than
recomputed:

| Field | Source |
|---|---|
| `context` | `/api/simulation/context` |
| `simulation` | `/api/simulation/simulate` (the scenario chosen to carry) |
| `recommendation` | `/api/simulation/recommend` |
| `risk` | `/api/simulation/risk` |
| `weekly` *(optional)* | `/api/simulation/weekly` |

An **assembly, not a calculation.** Sections are validated **against each
other** first — the strongest check is free, since `/risk` already carries the
exact simulation provenance it assessed. A mismatch → **422** naming which two
sections disagree.

`can_be_approved` is **`false` in every record**: this project defines no
approval criteria (`decision.NO_APPROVAL_CRITERIA`). `decision_id` is `null`,
`status` is `"draft"`, `meta.persisted` is `false`. Nothing is approved, nothing
is persisted by this route, and nobody is notified.

### `POST /api/decision/briefing`
Body: `{ "record": <the whole /decision/record payload> }` — `extra="forbid"`,
so a filter, scenario id, KPI, author or approver arriving is a **422**.

Renders two artifacts: `briefing.json` and a self-contained `briefing.html` the
browser can print to PDF. **A renderer, not a calculation** — no dataset is
read and no policy is re-applied. An incomplete record → **422** naming what is
wrong (`InvalidRecord`).

The artifact states, in the envelope, the header banner, a page banner and the
print footer, that it is a **draft, not approved and not saved**, and that it
**names no author and no approver** because this application cannot establish
who produced or reviewed it. Nothing is persisted.

### Static page readers — **removed**

Six routes once served authored JSON from `app/data/` through
`routers/pages.py`: `/api/intelligence/{type}`, `/api/intelligence-default`,
`/api/simulation/{type}`, `/api/simulation-default`, `/api/decision/{type}`
and `/api/decision-default`. The router and its seed blocks are gone —
Promotion Intelligence is computed by `intelligence_engine.py`, and the
Simulation and Decision blocks had no consumer.


## 5. Report Center — `/api/reports` (7 routes)

> **GENERATE ≠ DOWNLOAD**, and the route table is where that is enforced.
> `POST /api/reports` returns **metadata** and never bytes. A file crosses the
> wire only from the explicit download route.

### `GET /api/reports/modules`
Which modules can be generated, and in which formats.

```json
{ "modules": [ { "key": "command-center", "label": "Command Center",
                 "formats": ["xlsx","pdf"] }, … ],
  "formats": ["xlsx","pdf"] }
```

Registry keys: `command-center`, `simulation-investigation`,
`simulation-general-optimization`, `simulation-target-rescue`,
`decision-center`.

### `POST /api/reports` → **201**
```json
{ "module": "command-center",
  "scope":   { "year": 2025, "month": 10, "channel": ["CH002"] },
  "options": { "top_limit": 20 },
  "currency": "INR",
  "formats": ["xlsx","pdf"] }
```

**The client posts a SCOPE, not results.** The server re-runs the authoritative
service over that scope, so a client cannot put a number into a stored report
that this project's engine did not produce.

`scope` keys must be `filters.DIMENSIONS`; an unknown key → **422** naming it
(silently dropping `regionn` would widen the report's scope and look successful).
`options` are the module's own control values — inputs, never results;
credential-shaped keys are stripped before storage (`_SENSITIVE`).

Errors: unknown module → **404**; the module cannot report on this request →
**422**; a row that reached `ready` with no bytes → **500**.

Per-module required `options`:

| Module | Required | Optional |
|---|---|---|
| `command-center` | — | `alert_limit` (200), `top_limit` (20) |
| `simulation-investigation` | — | `discount_pct`, `scenario_id`, `scenario_name`, `duration_weeks`, `filename_hint` |
| `simulation-general-optimization` | — (falls back to the historical average) | `max_trade_spend`, `min_discount_pct`, `max_discount_pct` |
| `simulation-target-rescue` | **`target_units`** | `current_discount_pct`, `checkpoint`, `max_additional_trade_spend` |
| `decision-center` | **`record`** with `context`, `simulation`, `recommendation`, `risk` | `record.weekly` |

### `GET /api/reports?module=&format=&search=&limit=`
`limit` 1–500, default 200. Newest first.

```json
{ "reports": [ { "report_id": "…", "name": "Command Center — F25 · October · Modern Trade",
                 "module": "command-center", "module_label": "Command Center",
                 "title": "Trade Promotion Performance Report",
                 "scope_label": "…", "scope": {…}, "filters": [["Year","2025"],…],
                 "currency": "INR", "status": "ready", "error": null,
                 "preview": {…}, 
                 "formats": { "xlsx": "TPO_Command_Center_2025_Oct_Modern_Trade.xlsx",
                              "pdf": "…pdf" },
                 "available_formats": ["pdf","xlsx"],
                 "created_at": "2026-08-24T12:42:03+05:30",
                 "owner": null, "owner_note": "Ownership is unverified…" } ],
  "total": 12, "returned": 12,
  "modules": [{ "key": …, "label": … }],
  "owner_note": "…" }
```

**Every row corresponds to a stored artifact.** There are no seeded rows; an
empty library returns an empty list.

### `GET /api/reports/{report_id}`
One report's metadata and its **stored** preview. The preview is the one that
was generated, **not a fresh evaluation** — re-running the module here would
show today's numbers under yesterday's report. **404** if unknown.

Preview fields: `module`, `title`, `scope_line`, `generated_display`,
`headline`, `headline_tone`, `kpis[]`, `highlights[]`, `narrative[]`,
`empty_reason`, `disclaimers[]`.

### `GET /api/reports/{report_id}/download/{fmt}`
`fmt` ∈ `xlsx` | `pdf`. **The only route that answers with a file.**

Headers: `Content-Disposition: attachment; filename="…"`,
`Access-Control-Expose-Headers: Content-Disposition` (the browser fetch reads
the filename from there and it is not CORS-safelisted), `Content-Length`,
`Cache-Control: no-store`.

**404** for an unknown report or a format never generated (distinct exceptions,
so the UI can disable one button without hiding the row). **500** if the stored
artifact is empty — nothing is sent.

### `DELETE /api/reports/{report_id}` → **204**
Removes the report and both artifacts together. A report is a **derived**
artifact, regenerable from its stored scope, so deleting one destroys no
history — which is why this exists here while the scenario and decision tables
beside it remain append-only.

### `DELETE /api/reports` → **200**
`{ "deleted": 12, "total": 0 }`. **Not filtered** — it empties the whole
library, not the rows the page is currently showing. Clearing an already-empty
library is a success with a count of zero.

---

## 6. Storage — `/api/store` (5 routes)

> **UNAUTHENTICATED, and said so out loud.** Every route below repeats
> `store.UNAUTHENTICATED` in its OpenAPI description. There is no
> client-supplied fingerprint (computed server-side at write, compared
> server-side at read) and no owner field on any request model.

| Route | Body / params | Notes |
|---|---|---|
| `POST /api/store/scenarios` | `context`, `simulation`, `name?`, `scenario_id?`, `expected_version?` | Appends a version; never overwrites |
| `GET /api/store/scenarios/{id}?version=` | | Returns `stale` — whether the source data has changed. Nothing is recomputed |
| `POST /api/store/decisions` | `record`, `investigation_id?`, `scenario_id?`, `decision_id?`, `expected_version?` | Record stored **untouched** (`decision_id: null`, `status: draft`), storage identity in the envelope — so it can be handed straight back to `/api/decision/briefing` |
| `GET /api/store/decisions?limit=` | 1–200, default 50 | Headers only, newest first |
| `GET /api/store/decisions/{id}?version=` | | Byte-for-byte |

A write against a stale `expected_version` → **409** whose body names
`current_version`, so the caller can reload rather than guess.

---

## 7. Connector proxies — `/api/proxy` (7 routes)

Server-to-server forwarding, because Databricks' REST API and most SAP
Gateway/OData services send no CORS headers. Azure Blob Storage is **not**
proxied — it is CORS-native and fetched directly by the browser.

| Route | Upstream |
|---|---|
| `POST /api/proxy/databricks/warehouses` | Databricks SQL warehouses list |
| `POST /api/proxy/databricks/query` | Databricks SQL statement execution |
| `POST /api/proxy/sap/odata` | SAP Gateway / OData |
| `POST /api/proxy/powerbi/workspaces` | Power BI groups |
| `POST /api/proxy/powerbi/reports` | Power BI reports |
| `POST /api/proxy/generic/rest` | Any REST endpoint (used for NielsenIQ) |
| `POST /api/proxy/openai/chat` | OpenAI chat completions (the Home advisor card) |

Timeout 45 s. Network failure → **502** (`UpstreamError`) with the host named.
**Credentials are forwarded and never persisted or logged.**

---

## 8. Static content routes (12)

| Route | Serves | Frontend consumer |
|---|---|---|
| `GET /api/nav` | `nav.json` | `Sidebar` |
| `GET /api/user` | `user.json` (**static persona**) | `Topbar` |
| `GET /api/focus` | `focus.json` (**static; figures contradict the engine**) | Investigations, Intelligence |
| `GET /api/investigation-types` | 4 archetypes + example questions | Investigations, Simulation |
| `GET /api/investigations/{type}` | Static causal graph | Investigations |
| `GET /api/investigations/legacy` | Pre-multi-type block | Investigations |
| `GET /api/intelligence/{type}` | Static tab content | Promotion Intelligence |
| `GET /api/intelligence-answers/{type}` | Static AI narrative with `[g]/[r]/[n]` tone markup | `AiAnswerCard` |
| `GET /api/calendar` | 6 business events (Jun–Jul 2025) | `useMisc` |
| `GET /api/connections` | 8 connector rows | Data Connections |
| `GET /api/settings` | Preferences + integration names | Settings |
| `GET /api/command` | Legacy static block | **no consumer found** |
| `GET /api/ai-watch` | Static | **no consumer found** |
| `GET /api/recommendations` | Static | **no consumer found** |
