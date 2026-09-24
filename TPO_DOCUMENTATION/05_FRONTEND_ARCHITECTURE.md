# 05 — Frontend Architecture

`frontend/src/` — 168 files, ~22,100 lines of TypeScript/TSX.

## 1. Routing

`HashRouter` (routes are `#/command`, `#/simulation`, …) matching
`nav.json`'s route strings verbatim. Route table: `src/App.tsx`.

| Path | Component | Shell | Notes |
|---|---|---|---|
| `/` | → `/login` | — | Redirect |
| `/login` | `pages/Login.tsx` | none | Accepts **any** email + **any** password |
| `/home` | `pages/Home.tsx` | none | Portal: 6 module cards, connector rail, advisor |
| `/command` | `pages/CommandCenter.tsx` | AppShell | |
| `/investigations` | `pages/Investigations.tsx` | AppShell | |
| `/intelligence` | `pages/Intelligence.tsx` | AppShell | |
| `/simulation` | `pages/Simulation.tsx` | AppShell | 3 modes in one route |
| `/decision` | `pages/Decision.tsx` | AppShell | |
| `/calendar` | `pages/Calendar.tsx` | AppShell | |
| `/reports` | `pages/Reports.tsx` | AppShell | |
| `/connections` | `pages/Connections.tsx` | AppShell | |
| `/settings` | `pages/Settings.tsx` | AppShell | |
| `*` | → `/login` | — | Catch-all |

**There is no route guard.** `/command` is reachable without ever visiting
`/login`. `pages/Home.tsx` exists but is used by no route.

## 2. Layout

```
components/layout/
  AppShell.tsx   page frame: Sidebar + Topbar + breadcrumbs + content slot
  Sidebar.tsx    navMain (5) + navSecondary (4) from /api/nav; collapsible,
                 collapsed state persisted in store/sidebar.ts
  Topbar.tsx     breadcrumbs, user chip (from hooks/useAuth.ts)
```

Sidebar groups, straight from `nav.json`:

- **navMain** — Command Center, Investigations, Promotion Intelligence,
  Simulation Studio, Decision Center
- **navSecondary** — Calendar, Reports, Data Connections, Settings

## 3. Component map

| Directory | Files | Contents |
|---|---:|---|
| `components/ui/` | 22 | Button, Card, Modal, Dropdown, Table, Tabs, Toast, Confirm, Spinner, Badge, Chip, Pill, Field, IconButton, InfoPopover, SidePopover, AlertBanner, LiveStatus, RiskList, Kpi, **TpoKpi**, BrandLogo |
| `components/charts/` | 10 | Sparkline, Donut, DonutBreakdown, GroupedBar, DualLine, Waterfall, Forecast, ComboBarLine, `useChartWidth` — **hand-rolled SVG, no library** |
| `components/command/` | 10 | FilterBar, MultiSelect, ChartFrame, **ChartSections** (6 chart sections, 953 lines), RankedBar, ScatterQuadrant, TrendPanels, RiskAlertsPanel, PromotionMixCard, States, `riskRanking.ts` |
| `components/calendar/` | 4 | PromotionMatrix, PromotionDetailPanel, UpcomingEventsPanel, `statusColors.ts` |
| `components/simulation/` | 12 | ContextBar, ScenarioRow, CurrentPlanPanel, LeverPanel, ScenarioResultPanel, ComparisonTable, RecommendationPanel, WeeklyImpactPanel, RiskPanel, TrendChart, `panels.tsx` |
| `components/optimization/` | 2 | GeneralOptimization (507 lines), Slider |
| `components/rescue/` | 1 | TargetRescue (1,115 lines) |
| `components/reports/` | 1 | ExportReportButton |
| `components/investigations/` | 8 | InvestigationGraph, NodeDetailPopover, BizQuestionCard, AccelList, ProgressStrip, QueryBar, ActiveInvBanner, `graphLayout.ts` |
| `components/intelligence/` | 8 | `tabs.tsx` (8 tabs), AiAnswerCard, KeyInsightsList, SalesTrendChart, SaturationChart, RegionVarianceBars, `useStreamedAnswer`, `answerFormat` |
| `components/portal/` | 13 | ModuleGrid, ConnectorLogo, HeroArt, `catalog.ts` (the 27-entry connector catalogue), `modules.ts`, `connectors.ts`, and 6 connector modals |

## 4. Hooks — the only API callers

`src/hooks/` — 15 modules. No component calls `fetch` directly except
`useReportCenter.downloadArtifact` and `useBriefing.saveBriefing`, which need
raw `Response` access for blobs and `Content-Disposition`.

| Hook module | Endpoints |
|---|---|
| `useCommandCenter.ts` | `/command-center/{kpis,filters,trend,risk-alerts,underperforming-promotions,promotion-mix,breakdown,top-promotions}` |
| `usePromotionCalendar.ts` | `/promotion-calendar/{matrix,cell,upcoming}` |
| `useSimulation.ts` | `/simulation/{run,simulate,compare,recommend,weekly,risk}` |
| `useInvestigationContext.ts` | `/simulation/context` |
| `useOptimization.ts` | `/simulation/general-optimization[/scope]` |
| `useTargetRescue.ts` | `/simulation/target-rescue[/scope]` |
| `useDecision.ts` | `/decision/record` |
| `useBriefing.ts` | `/decision/briefing` (+ client-side file save) |
| `useStore.ts` | `/store/{scenarios,decisions}` |
| `useReportCenter.ts` | `/reports` (list, generate, delete, clear) + `/reports/{id}/download/{fmt}` |
| `useInvestigations.ts` | `/investigation-types`, `/investigations/{type}`, `/investigations/legacy` |
| `useIntelligence.ts` | `/intelligence-default`, `/intelligence/{type}`, `/intelligence-answers/{type}` |
| `useNav.ts` | `/nav`, `/user`, `/focus` |
| `useMisc.ts` | `/calendar`, `/connections`, `/settings` |
| `useElementSize.ts` | — (ResizeObserver utility) |

### API client — `src/lib/api.ts`

```ts
const API_BASE = "/api";
apiFetch<T>(path)          // GET
apiPost<T>(path, body)     // POST, JSON
class ApiError { status; message }
```

`unwrap()` reads FastAPI's `{"detail": …}` and flattens a Pydantic 422 field
list into `"field: message; field: message"`.

### React Query configuration — `src/lib/queryClient.ts`

```ts
staleTime: 30_000
retry: 1
refetchOnWindowFocus: false
```

Most queries also set `placeholderData: (previous) => previous`, so a filter
change shows the previous result dimmed (`<Stale>`) rather than a spinner.

## 5. ⚠ Two query scopes on the Command Center — an important behaviour

`useCommandCenter.useScope()` documents a deliberate split, and it is **not**
what the surrounding comments in `store/commandFilters.ts` and
`components/command/ChartSections.tsx` claim:

| Query | Filters actually sent |
|---|---|
| `useKpis` | **The full filter payload** — all 14 dimensions |
| `useFilterOptions` | **The full filter payload** (no currency) |
| `useTrend` | `year`, `currency`, `granularity` |
| `useRiskAlerts` | `year`, `currency`, `limit` |
| `useUnderperforming` | `year`, `currency`, `limit` |
| `usePromotionMix` | `year`, `currency` |
| `useTopPromotions` | `year`, `currency`, `limit` |
| `useBreakdown` | `year`, `currency`, `by`, `metric`, `limit`, and optionally `promotion` (a chart-level control) |

The stated rationale: *"KPI cards answer 'what do the numbers look like for
exactly this selection'… charts answer 'how did promotions behave over the
year' and each carries its own local control… what is not named is not sent."*
The practical effect is that chart caches survive a Channel or Product change.

**The consequence, which is not documented in the code:** selecting
Channel = Modern Trade narrows the six KPI cards but leaves the trend, the risk
alerts, both tables and all six chart sections describing the whole year across
every channel. Two comments in the repository state the opposite:

- `store/commandFilters.ts`: *"Every panel — KPI cards, trend, risk alerts,
  promotion mix, both tables — reads this same object and sends it to the
  backend verbatim."*
- `components/command/ChartSections.tsx`: *"Every one reads the SAME filter
  state as the KPI cards."*

The backend supports the full payload on all eight routes
(`routers/command_center.get_filters` is shared by every one of them); the
frontend chooses not to send it. Recorded in
[appendices/KNOWN_LIMITATIONS.md](appendices/KNOWN_LIMITATIONS.md) as a
documentation/behaviour discrepancy, **not silently reconciled**.

## 6. State management — 7 Zustand stores

| Store | Persisted | Holds |
|---|---|---|
| `commandFilters.ts` | no | THE Command Center filter state, currency, expanded flag, `lastTouched`, `reconcile()` |
| `studioFilters.ts` | **sessionStorage** (`tiq.studioFilters`) | The Simulation Studio's OWN scope — a second instance of the same store shape, so the studio and the Insights Hub cannot re-scope each other |
| `studioHandoff.ts` | **sessionStorage** (`tiq.studioHandoff`) | The product Promotion Intelligence carried into the studio |
| `decisionScenarios.ts` | **localStorage** (`tiq.decisionScenarios`) | The scenarios on the Decision Center board, as the studio snapshotted them |
| `activeInvestigation.ts` | **localStorage** (`tiq.activeInvestigation`) | Active investigation type, question, recent list, and the Command Center **scope hand-off** |
| `savedRefs.ts` | **localStorage** | Last stored investigation / scenario / decision ids — pointers only |
| `portalUser.ts` | **localStorage** | The email typed at sign-in and derived initials |
| `sidebar.ts` | **localStorage** | Sidebar collapsed state |

**Mode isolation is deliberate.** The three Simulation Studio modes each own
their controls, so switching modes cannot carry one mode's scope into another,
and the Simulation Studio's own scope cannot silently re-scope the
investigation path.

## 7. Type definitions

`src/types/` — 23 modules mirroring the API response shapes:
`commandCenter`, `simulation`, `comparison`, `recommendation`, `risk`,
`weekly`, `decision`, `investigation`, `investigationContext`, `orchestration`,
`intelligence`, `promotionCalendar`, `calendar`, `optimization`,
`targetRescue`, `reportCenter`, `reports`, `store`, `connections`, `settings`,
`nav`, `portal`, `briefing`.

These are **hand-written and not generated** from the OpenAPI schema, so they
can drift from the backend without a compile error. There is no schema-sync
step in the build.

## 8. Rendering conventions

- **The frontend computes no KPI.** Values, display strings, formulas, deltas,
  tooltips and unavailability reasons all arrive from the API. The one place a
  component derives anything is presentational ranking and truncation
  (`riskRanking.ts`, `ChartSections`' median filter and per-mechanic cap), and
  each is documented at the site.
- **Currency symbols come from the same payload as the numbers.** The trend
  chart deliberately reads its symbol from `trend.data.meta.currency`, not from
  the KPI response, so a mid-switch render cannot show ₹ against USD figures.
- **Null renders as `—`, never as `0`.** Every panel has an explicit
  `EmptyState` / `ErrorState` / `unavailable_reason` path.
- **Floating menus portal to `document.body`** with `position: fixed`. The
  `.fade-in` / `.fade-in-up` entrance animations establish a stacking context
  (animating `opacity`/`transform` does so per spec), which traps an
  `absolute`-positioned menu behind later sibling cards.

## 9. Charts

All SVG, all hand-written. `useChartWidth` supplies a measured width so charts
are responsive without a layout library.

| Component | Used by |
|---|---|
| `TrendPanels` (composite) | Command Center — Promotion Performance Trend |
| `RankedBar` | Channel Performance |
| `DonutBreakdown` / `Donut` | `PromotionMixCard` |
| `ScatterQuadrant` | available in `components/command/` |
| `Sparkline`, `GroupedBar`, `DualLine`, `Waterfall`, `Forecast`, `ComboBarLine` | design-system components ported from the predecessor app; used by Intelligence tabs and simulation panels |

The six Command Center chart sections in `ChartSections.tsx` render their rows
as CSS-sized bars rather than as SVG chart components.

## 10. Build output

```
tsc -b            → 0 errors      (verified 2026-08-24)
oxlint            → 0 errors, 6 warnings (all react/only-export-components)
vite build        → 210 modules, 648 kB JS (172 kB gzip), 76 kB CSS
```

The six lint warnings are the "fast refresh only works when a file only exports
components" rule, triggered by files that export a component plus a constant or
a hook: `Sparkline.tsx`, `LiveStatus.tsx`, `Confirm.tsx`, `Toast.tsx`,
`PromotionMatrix.tsx`, `simulation/panels.tsx`.

**No code splitting is configured**; Vite warns that the single chunk exceeds
500 kB.
