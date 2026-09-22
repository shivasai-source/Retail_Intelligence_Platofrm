# Module 03 — Promotion Intelligence

**Route:** `#/intelligence` · **Page:** `frontend/src/pages/Intelligence.tsx` (139 lines)
**Sidebar label:** "Promotion Intelligence"
**Status:** **STATIC — every figure on this page is authored JSON**

> This module is a **causal understanding presentation layer** ported from the
> predecessor application. It reads
> `backend/app/data/pages-by-type.json[{type}].intelligence` and
> `backend/app/data/intelligence-answers.json[{type}]`, and renders them.
>
> **It does not touch `app/tpo/` at all.** No CSV is read, no KPI engine is
> called, and no filter is applied. Nothing on this page is computed from the
> 205,920-row fact table.
>
> Where real promotion analysis exists in this application, it is in the
> **Command Center** (measured KPIs, breakdowns, cannibalization, risk alerts)
> and the **Promotion Calendar** — see
> [modules/01](01_COMMAND_CENTER.md) and [modules/06](06_PROMOTION_CALENDAR.md).

## 1. Purpose (as built)

Presents a narrative "causal understanding" of one investigation archetype: a
waterfall decomposition, key insights, a discount-saturation curve, an
incremental-sales trend and regional variance — with an AI-styled synthesis
answer above them.

## 2. Structure

```
ActiveInvBanner                      (active investigation type + question)
AiAnswerCard                         (streamed narrative with tone markup)
8 tabs
```

### The 8 tabs — `components/intelligence/tabs.tsx` (397 lines)

| # | Tab | Component |
|---|---|---|
| 1 | Overview | `OverviewTab` |
| 2 | Contribution | `ContributionTab` |
| 3 | Drivers | `DriversTab` |
| 4 | Segments | `SegmentsTab` |
| 5 | Retailers | `RetailersTab` |
| 6 | Regions | `RegionsTab` |
| 7 | SKU Level | `SkuLevelTab` |
| 8 | Insights | `InsightsTab` |

All eight receive the same `IntelligencePageData` object, which
`useIntelligencePage` builds by **merging two endpoints**:

```ts
{ ...GET /api/intelligence-default,   // the shared base: tabs and every
                                      // table not overridden per type
  ...GET /api/intelligence/{type} }   // title, subtitle, waterfall, etc.
```

> `backend/app/routers/pages.py` describes the `*-default` routes as *"kept for
> fidelity, not used by the per-type pages above"*. That is **accurate for
> `/simulation-default` and `/decision-default`, and inaccurate for
> `/intelligence-default`**, which this page genuinely reads.

## 3. Data shape — `pages-by-type.json[type].intelligence`

| Key | Type | Example |
|---|---|---|
| `title` | string | `"Promotion Performance Intelligence"` |
| `subtitle` | string | `"Causal Understanding Layer · Diagnostic mode"` |
| `waterfall` | array | `[{label: "Base Sales", value: 120.2, type: "base"}, {label: "Promotion Lift", value: 38.4, type: "positive"}, …]` |
| `waterfallNote` | string | Authored explanation |
| `keyInsights` | array | `[{title, desc, impact, trend}]` |
| `saturationCurve` | object | `{points: [{x: 0, y: 10}, {x: 5, y: 22}, …]}` |
| `incSalesTrend` | object | `{labels: ["Apr W1", …], actual: [...], …}` |
| `regionVariance` | array | `[{region: "North", variance: -12.4}, …]` |
| `regionNote` | string | Authored explanation |

**Every number above is a literal in the JSON file.** For example, the
`saturationCurve` peaks at x = 18–20 and the accompanying insight reads
*"Discount saturation observed beyond 18%"* — an authored assertion, not a
measured elasticity. This project's real approved discount depths are 5, 10, 15,
20 and 25 percent (`config.TREATMENT_RULES`) and its response model explicitly
refuses to interpolate between them.

Four variants exist — one per investigation archetype (`diagnostic`,
`optimization`, `launch`, `strategic`).

## 4. The AI answer

`GET /api/intelligence-answers/{type}` → `intelligence-answers.json`.

Rendered by `AiAnswerCard` + `useStreamedAnswer`, which types the authored text
out character by character. **This is a rendering effect over static text — no
model is called, and no `/api/proxy/openai/chat` request is made from this
page.**

The text carries `[g]` / `[r]` / `[n]` **tone markup** (good / risk / neutral),
parsed by `answerFormat.ts` and tinted by the frontend. The backend serves the
markup intact and explicitly leaves rendering to the client.

The stream fires **once per investigation type per session**, tracked by a
module-level `Set`.

Supporting components: `KeyInsightsList`, `SalesTrendChart`, `SaturationChart`,
`RegionVarianceBars` — all SVG, all reading the JSON.

## 5. Controls

| Control | Effect |
|---|---|
| Investigation type | From `store/activeInvestigation` — selects which of the four JSON blocks to render |
| Promotion dropdown | **`PROMO_OPTIONS` is hardcoded in the page** — `['South MT Push', 'North GT Boost', 'Value Pack Bonanza']`. Drives nothing |
| Period dropdown | **`PERIOD_OPTIONS` is hardcoded** — `['Q1 FY25' … 'Q4 FY25']`. Drives nothing |
| Focus chips | From `GET /api/focus` → `focus.json` — **static, and its `spend: "₹98.6 Cr"` contradicts the engine's ₹7.7 Cr for the same scope** |

**There is no filter bar on this page** and no connection to
`store/commandFilters`.

## 6. Endpoints

| Endpoint | Serves |
|---|---|
| `GET /api/intelligence/{type}` | `pages-by-type.json[type].intelligence` |
| `GET /api/intelligence-default` | `intelligence.json` — the shared base block, **merged under** the per-type override |
| `GET /api/intelligence-answers/{type}` | The authored narrative |
| `GET /api/investigation-types` | The 4 archetypes |
| `GET /api/focus` | Static context chips |

`{type}` ∈ `diagnostic` \| `optimization` \| `launch` \| `strategic`
(`data_loader.InvestigationType`, a `Literal` — an unknown value is a 422).

## 7. Promotion analysis that IS real, and where to find it

The prompt for this documentation asks about promotion performance, comparison,
types, mechanics, economics, filters, rankings, detail views and
underperformance logic. All of that exists — **in other modules**:

| Capability | Where it is real |
|---|---|
| Promotion performance | Command Center KPI cards, `/breakdown?by=promotion` |
| Promotion comparison | `/breakdown?by=promotion_mechanic`, `by=promotion_type`; Simulation `/compare` |
| Promotion **types** | `Regular` / `Seasonal` / `Normal` from `dim_promotion.Promotion_Type` — a real filter dimension and a real breakdown dimension |
| Promotion **mechanics** | `Promotion_Name` — "5% Discount", "10% Discount", "15% Discount", "20% Discount", "Buy3Get1". Exposed as `by=promotion_mechanic`, whose groups carry their member `Promotion_Id`s |
| Promotion **economics** | `config.TREATMENT_RULES` + `response.py` — five approved treatments with uplift bands and break-even |
| Promotion filters | The `promotion` and `promotion_type` dimensions |
| Promotion rankings | `/top-promotions`, `/underperforming-promotions`, `/breakdown` |
| Promotion detail | Calendar cell detail (`/promotion-calendar/cell`) — offer, mechanic, type, event name, weeks, promoted SKUs |
| Underperformance logic | `service._CAUSES` + the severity bands — see [08](../08_KPI_AND_BUSINESS_LOGIC.md) §13 |

**Verified promotion inventory** (from `dim_promotion_final.csv` and the fact
table) is documented in [03_DATA_ARCHITECTURE.md](../03_DATA_ARCHITECTURE.md) §7,
including the fact that `PS001` and `PB001` appear in the dimension but **not**
in the fact table, and that every 2024 seasonal event is a 20% price discount
while every 2025 one is Buy3Get1.

## 8. Reports

**No report is generated from this module.** It is absent from
`reports.service.MODULES`, correctly — there is no computed dataset behind it.

## 9. Known limitations

| # | Limitation |
|---|---|
| 1 | **Every figure on the page is authored JSON.** Waterfall, insights, saturation curve, trend, regional variance |
| 2 | The "AI synthesis" is a typing animation over static text; no model is called |
| 3 | The promotion and period dropdowns are hardcoded and drive nothing |
| 4 | The page is **disconnected from the global filter state** |
| 5 | `focus.json`'s spend figure contradicts the validated engine by more than an order of magnitude |
| 6 | The saturation insight ("beyond 18%") is not derived from, and is not consistent with, this project's approved treatment depths |
| 7 | Only 4 authored variants exist — one per archetype — so two different investigations of the same type render identically |

## 10. File map

| Concern | File |
|---|---|
| Page | `frontend/src/pages/Intelligence.tsx` |
| Tabs | `frontend/src/components/intelligence/tabs.tsx` |
| AI answer | `frontend/src/components/intelligence/{AiAnswerCard,useStreamedAnswer,answerFormat}.ts(x)` |
| Charts | `frontend/src/components/intelligence/{SalesTrendChart,SaturationChart,RegionVarianceBars,KeyInsightsList}.tsx` |
| Hook | `frontend/src/hooks/usePromotionIntelligence.ts` |
| Types | `frontend/src/types/promotionIntelligence.ts` |
| Router | `backend/app/routers/intelligence.py`, `investigations.py` |
| Data | `backend/app/data/{pages-by-type,intelligence,intelligence-answers,focus}.json` |
| Tests | **none** — there is nothing computed to test |
