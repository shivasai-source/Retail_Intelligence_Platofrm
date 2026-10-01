# Module 01 — Command Center

**Route:** `#/command` · **Page:** `frontend/src/pages/CommandCenter.tsx` (636 lines)
**Status:** Implemented against real data

## 1. Purpose

The measurement surface. Answers "what did we spend, what did it return, and
where is it going wrong?" for one filtered scope, and hands the worst offender
off to an investigation.

## 2. User workflow

```
land on #/command
   └─ default year adopted from /filters (never hardcoded)
      └─ 6 KPI cards + headline alert banner
         ├─ read the trend, the alerts, the two tables, the mix, 6 chart sections
         ├─ narrow with the filter bar → cards re-query, options reconcile
         ├─ Export Report → stored in the Report Center
         └─ click a risk alert or an underperforming row
               → scope hand-off → #/investigations
```

## 3. Filters

`FilterBar` (`components/command/FilterBar.tsx`), backed by
`store/commandFilters.ts`.

**Primary row (always visible):** Year (single) · Channel (**multi**) ·
Retailer (**multi**, hidden when the scope offers none) · More Filters toggle ·
Currency toggle (INR / USD) · Refresh.

**More Filters (expanded panel):** Month · Category (**multi**) ·
Brand (**multi**) · Product · Offer · Promotion Type · Region · State · City ·
Tier · Distributor · Clear-all.

Behaviour: OR within a dimension, AND across dimensions; dependent option lists;
symmetric reconciliation with recency tie-breaking. Full detail:
[07_FILTER_AND_SCOPE_ARCHITECTURE.md](../07_FILTER_AND_SCOPE_ARCHITECTURE.md).

## 4. KPI cards (6)

Rendered as `TpoKpiTile` in `TpoKpiGrid`. Order and presentation from
`KPI_ORDER` / `KPI_STYLE`; **label, value, formula, delta and unavailability
reason all come from the API.**

| # | Card | Unit | Icon / tint | Lower is better |
|---|---|---|---|---|
| 1 | Trade Spend | currency | wallet / lavender | ✔ |
| 2 | Incremental Sales | currency | barChart / sky | |
| 3 | Promotion ROI | percent | target / violet | |
| 4 | Margin Impact | percent | coins / amber | |
| 5 | Promotion Efficiency Index | score | gauge / mint | |
| 6 | Cannibalization Rate | percent | cannib / rose | ✔ |

Each tile carries an ⓘ popover with the formula and meaning from
`service.KPI_SPECS`, and a delta line (`+11.7%` / `vs F24`, or `—` /
`no comparison period`).

**The Cannibalization card is the only one with an evidence sub-label**
(`cannibalizationSub`):
- available → `"vs F24 · 47 comparable events"`
- unavailable but measurable wider →
  `"12.4% across Diwali Special 25 · all channels · 9 comparable events"`

Endpoint: `GET /api/command-center/kpis` — **the full filter payload**.
Formulas: [08_KPI_AND_BUSINESS_LOGIC.md](../08_KPI_AND_BUSINESS_LOGIC.md).

## 5. Alerts button

The Hub used to carry three alert surfaces of its own — a strip leading with
the single worst alert, a Target ROI popover in the toolbar, and a card listing
every event below target by severity. All three now live in one place, the
**alerts dialog on Investigations** (`components/investigations/AlertsModal`),
and the Hub carries only the door: an **Alerts** button in the title row
(`components/command/AlertsButton`) where the strip sat.

The button computes nothing. Its count is the sum of the three band counts the
`/risk-alerts` payload reports (computed server-side over every banded event,
not the `limit`-capped rows), read through the same `useRiskAlerts` at the same
`ALERT_FETCH_LIMIT` the notification bell uses, so React Query serves both from
one cache entry. Its tint is the worst band present: danger while any Critical
exists, warning for High or Medium only, neutral at zero. It is disabled when
the selection has no rows.

Clicking it navigates to `#/investigations` with an `OPEN_ALERTS_STATE_KEY`
intent in router state (`lib/askWhy`, beside the Ask-why one, minted per press).
Investigations opens the dialog over itself, blurred, in two steps:

1. **Set the target ROI** — `TargetRoiForm`, the body of the old toolbar
   popover, writing to the Hub's filter store. Every opening starts here.
2. **Promotion events below ROI target** — `RiskAlertsPanel`, the same
   component, bands, ranking and "View all" the Hub drew beside its trend
   chart, judged against the target just set, with a *Change target* link back.

An **Ask why** on a row goes through `useAlertHandoff` exactly as a Hub row did,
and the dialog closes because the page behind it is the answer. The backdrop
does not dismiss it (a stray click should not undo the step); Escape and ✕ do.

## 6. Panels and charts

Ten analytical surfaces below the cards — one of them, Risk Alerts, has moved
to the alerts dialog on Investigations (§5) and is listed for its data path.

| # | Surface | Component | Endpoint | Local control |
|---|---|---|---|---|
| 1 | **Promotion Performance Trend** | `TrendPanels` | `/trend` | Weekly / Monthly |
| 2 | **Risk Alerts** — *moved to Investigations, §5* | `RiskAlertsPanel` inside `AlertsModal` | `/risk-alerts` | severity segmentation (client) |
| 3 | **Top Underperforming Promotions** | table in the page | `/underperforming-promotions` | — |
| 4 | **Promotion Mix** | `PromotionMixCard` | `/promotion-mix` | — |
| 5 | **Channel Performance** | `ChannelSection` → `RankedBar` | `/breakdown?by=channel` | discount-mechanic selector |
| 6 | **Top Performing Promotions** | `TopPerformingSection` | `/top-promotions` | — |
| 7 | **Retailer & Distributor Performance** | `RetailerDistributorSection` | `/breakdown?by=retailer` + `by=distributor` | metric |
| 8 | **Promotion Contribution** | `PromotionContributionSection` | `/breakdown?by=promotion_mechanic` | Incremental Sales / Trade Spend |
| 9 | **Product Performance** | `ProductSection` | `/breakdown?by=product` | metric |
| 10 | **Regular vs Seasonal Performance** | `PromotionTypeSection` | `/breakdown?by=promotion_type` | metric |

Layout: the trend on a row of its own (the Risk Alerts card that shared it has
moved, §5); then the underperforming table; then the mix; then the six chart
sections in three two-column rows.

### 6.1 Promotion Performance Trend

Three business series plus a dashed reference: Incremental Sales (violet),
Trade Spend (red), ROI % (teal `#14B8A6`), Target ROI (dashed, from
`meta.target_roi_pct`).

The currency **symbol and rate both come from the trend response**, not the KPI
response — taking the symbol from the KPI payload let the axis briefly render ₹
against USD-converted numbers while the slower query settled.

Height is fixed at 438 px — the figure it settled on while a Risk Alerts
sibling drove the row, kept now the row is its own.

### 6.2 Risk Alerts (in the alerts dialog on Investigations)

The API emits **one concatenated Critical → High → Medium list** and truncates
the tail, so the top of the High band sits behind every Critical row and a small
`limit` cannot reach it. The dialog therefore fetches the whole set
(`ALERT_FETCH_LIMIT = 100000`) and segments client-side. React Query caches it
per scope and target, so this is one request per scope, not per render — and
the Alerts button, the notification bell and the query bar's *From an alert*
menu all read that same entry.

The dialog's header names the target the events were judged against, with a
*Change target* link back to step one and an ⓘ explaining the banding rule; the
severity strip shows `"{target_achieved} of {total_events} at target"`. A
target change re-judges the list behind a `Stale` wash rather than blanking it.

### 6.3 Top Underperforming Promotions

Same reason for the full fetch (`UNDERPERFORMING_FETCH_LIMIT = 100000`): the API
ranks by **At Stake DESC**, so the worst-ROI promotions are not at the head of
its list. The page re-ranks and renders up to `UNDERPERFORMING_ROWS = 25` rows
inside a `UNDERPERFORMING_VIEWPORT_PX = 252` scroller, so the card keeps a fixed
height whatever the row count. The header reports the **true total**.

Columns: Promotion · Product · Channel · Period · ROI · vs Target · Trade Spend ·
At Stake · Primary Cause · Action · Status.

### 6.4 Channel Performance

Not a Top-N ranking — **every channel the scope contains**, ordered by the
backend's own metric ordering. Its discount-mechanic selector is a genuine
re-query, not a relabelling: mechanics come from
`/breakdown?by=promotion_mechanic`, whose groups carry the `Promotion_Id`s
behind each one, and selecting one scopes the channel query through the existing
`promotion` list filter.

> That control previously held a hardcoded PR001/PR002/PR003 list, which by
> construction could never select the 20% seasonal mechanic (six offers) or
> Buy3Get1.

Mechanics sort by their leading percentage (5 → 10 → 15 → 20); Buy3Get1, having
none, sorts last.

### 6.5 Top Performing Promotions

Client-side ranking with two stated guards:

1. **Median Trade Spend floor** — only events at or above the scope's median
   spend are eligible, so a ₹17k promotion posting 1,398% cannot outrank one
   carrying real money.
2. **Per-mechanic cap** — at most N rows per mechanic. *"The cap is never
   relaxed. A single year runs four mechanics, so a year scope yields eight rows
   and All Years ten; a shorter, honest list beats handing the spare slots back
   to the mechanic that already dominates."*

Deduplicated on `promotion|channel|period`.

### 6.6 Regular vs Seasonal Performance

Its footnote adapts to the metric: for shareable metrics, *"Share of {metric};
the two types total 100% of the scope"*; for ROI, *"ROI is a ratio, so it carries
no share — {leader} leads by {n} pts."*

### 6.7 Product / Retailer & Distributor Performance

Top 10 by the selected metric, ROI breaking ties, footnoted with the true total
and *"A ranking, not a share of the total."*

## 7. Interaction and hand-off

Two hand-off paths — the alert one from the alerts dialog on Investigations
(`hooks/useAlertHandoff.ts`), the promotion one in `pages/CommandCenter.tsx`:

```ts
handOffAlert(alert)        // from the alerts dialog (AlertsModal) — see §5
handOffPromotion(row)      // from the underperforming table
```

Both call `startFromCommandCenter({ filters, origin, label, identifiers, labels })`
and navigate to `#/investigations`. A 700 ms delay lets the row's press
animation finish.

**What narrows and what does not:**

| Carried | Not carried |
|---|---|
| The current `FilterState`, **copied not mutated** | The week — `FilterState` has no week dimension |
| `promotion_id`, `product_id`, `channel_id` (real codes) | Display names — they stay in `labels` |
| | The period selection, deliberately left alone |

Two reasons, both documented at the site:

- Narrowing to the promoted **week** would remove the non-promoted rows the
  counterfactual needs, and the drill-down would report **−100%** instead of the
  row's own ROI.
- Moving the **period** window would move the baseline, so the drill-down would
  answer a different question from the row that was clicked.

Converting a display name back into a code by guessing would be a second filter
model wearing a disguise.

## 8. Tooltips and info popovers

- Per-card ⓘ: name, formula, meaning (from `service.KPI_SPECS`).
- Trend ⓘ: Incremental Sales, Trade Spend, ROI and the target, as formulas.
- Alerts dialog ⓘ (on Investigations): the severity banding rule.
- Truncated table cells carry a native `title` attribute.

## 9. Export

`ExportReportButton` with `module="command-center"`. The scope is read **at
click time** from the same `commandFilters` store every panel reads, via
`toSimulationFilters` — the *same* converter the Simulation Studio posts with,
reused rather than rewritten, because a second implementation is how an export
starts describing a different selection from the screen.

The report contains the six KPI cards, the risk summary and counts, the alert
rows, the promotion mix and the top promotions. Options: `alert_limit`
(default 200), `top_limit` (default 20).

Clicking **generates into the Report Center** — it does not download. See
[modules/07_REPORTS.md](07_REPORTS.md).

## 10. Loading, empty, error and stale states

`components/command/States.tsx`:

| State | Rendering |
|---|---|
| First load | `KpiSkeleton` + `PanelSkeleton` |
| Refetching | `<Stale>` dims the previous result — `placeholderData: (previous) => previous` means no spinner flash |
| Error | `ErrorState` with the API's own message + Retry |
| Empty scope (`meta.row_count === 0`) | `CcEmptyState` per panel |
| KPI unavailable | `—` plus the API's `unavailable_reason` |

## 11. Responsive behaviour

- Trend/alerts grid collapses to one column below **1280 px**.
- Filter bar uses `flex-wrap` so it reflows on tablet rather than forcing a
  horizontal scrollbar; nothing is hidden or reordered.
- Charts measure their host via `useChartWidth`.
- Chart sections sit in `grid-cols-2` collapsing to one column on narrow
  viewports.

## 12. ⚠ Known limitation — filter reach

**Only the six KPI cards and the filter options respond to the full filter
selection.** The trend, the risk alerts, both tables, the mix and all six chart
sections receive **`year` + `currency`** plus their own local controls.

So selecting Channel = Modern Trade narrows the cards but leaves everything
below them describing the whole year across every channel. The backend accepts
the full payload on all eight routes; the frontend chooses not to send it, to
keep chart caches alive across a Channel or Product change
(`hooks/useCommandCenter.useScope()`).

Two comments in the repository state the opposite. See
[appendices/KNOWN_LIMITATIONS.md](../appendices/KNOWN_LIMITATIONS.md) §1.

## 13. File map

| Concern | File |
|---|---|
| Page | `frontend/src/pages/CommandCenter.tsx` |
| Filter bar | `frontend/src/components/command/{FilterBar,MultiSelect}.tsx` |
| Chart sections | `frontend/src/components/command/ChartSections.tsx` |
| Chart frame / bars | `frontend/src/components/command/{ChartFrame,RankedBar,ScatterQuadrant}.tsx` |
| Trend | `frontend/src/components/command/TrendPanels.tsx` |
| Alerts | `frontend/src/components/command/{RiskAlertsPanel,riskRanking}.ts(x)` |
| Mix | `frontend/src/components/command/PromotionMixCard.tsx` |
| States | `frontend/src/components/command/States.tsx` |
| Hooks | `frontend/src/hooks/useCommandCenter.ts` |
| Store | `frontend/src/store/commandFilters.ts` |
| Types | `frontend/src/types/commandCenter.ts` |
| Router | `backend/app/routers/command_center.py` |
| Service | `backend/app/tpo/service.py` |
| Engine | `backend/app/tpo/aggregate.py` |
| Filters | `backend/app/tpo/filters.py` |
| Tests | `backend/tests/test_command_center.py`, `test_breakdown.py`, `test_filter_options.py`, `test_kpi_delta_precision.py` |
