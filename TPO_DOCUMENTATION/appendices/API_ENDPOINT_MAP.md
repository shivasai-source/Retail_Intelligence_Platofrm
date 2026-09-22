# Appendix — API Endpoint Map

**63 routes**, enumerated from `app.openapi()` on 2026-08-24.
Full request/response detail: [06_API_REFERENCE.md](../06_API_REFERENCE.md).

**No route is authenticated.** See [KNOWN_LIMITATIONS.md](KNOWN_LIMITATIONS.md) §2.

## Health / configuration (1)

| Module | Endpoint | Method | Purpose | Frontend consumer |
|---|---|---|---|---|
| Health | `/api/health` | GET | Liveness | — (manual / ops) |

## Command Center — filters + KPI (8)

All eight share the same 14-dimension filter contract.

| Module | Endpoint | Method | Purpose | Frontend consumer |
|---|---|---|---|---|
| Filters | `/api/command-center/filters` | GET | Dependent option lists | `useFilterOptions` → `FilterBar`, GenOpt & Rescue pickers |
| KPI | `/api/command-center/kpis` | GET | The 6 KPI cards | `useKpis` → `TpoKpiTile` |
| KPI | `/api/command-center/trend` | GET | Trade Spend / Incremental Sales / ROI over time | `useTrend` → `TrendPanels` |
| KPI | `/api/command-center/risk-alerts` | GET | Events below the ROI target, banded | `useRiskAlerts` → `RiskAlertsPanel`, `AlertBanner` |
| KPI | `/api/command-center/underperforming-promotions` | GET | Underperforming events, At Stake DESC | `useUnderperforming` → table |
| KPI | `/api/command-center/top-promotions` | GET | Best events by ROI | `useTopPromotions` → `TopPerformingSection` |
| KPI | `/api/command-center/promotion-mix` | GET | Trade Spend share by offer | `usePromotionMix` → `PromotionMixCard` |
| KPI | `/api/command-center/breakdown` | GET | Every KPI per value of one dimension | `useBreakdown` → all 6 chart sections |

## Calendar (4)

| Module | Endpoint | Method | Purpose | Frontend consumer |
|---|---|---|---|---|
| Calendar | `/api/promotion-calendar/matrix` | GET | 12-month × N-channel grid | `usePromotionMatrix` → `PromotionMatrix` |
| Calendar | `/api/promotion-calendar/cell` | GET | One Channel × Month, + weeks for weekly channels | `usePromotionCell` → `PromotionDetailPanel` |
| Calendar | `/api/promotion-calendar/upcoming` | GET | Promotion starts + business events | `useUpcoming` → `UpcomingEventsPanel` |
| Calendar (legacy) | `/api/calendar` | GET | 6 authored business events | `useCalendar` (`useMisc`) |

## RCA / Investigations (4)

| Module | Endpoint | Method | Purpose | Frontend consumer |
|---|---|---|---|---|
| RCA | `/api/investigation-types` | GET | The 4 archetypes + example questions | `useInvestigationTypes` |
| RCA | `/api/investigations/{type}` | GET | **Static** causal graph, accelerators, node details | `useOrchestration` → `InvestigationGraph` |
| RCA | `/api/investigations/legacy` | GET | **Static** pre-multi-type block | `useLegacyInvestigation` |
| RCA | `/api/focus` | GET | **Static** context chips | `useFocus` |

## Promotion Intelligence — all static (3)

| Module | Endpoint | Method | Purpose | Frontend consumer |
|---|---|---|---|---|
| Intelligence | `/api/intelligence/{type}` | GET | **Static** tab content | `useIntelligencePage` |
| Intelligence | `/api/intelligence-answers/{type}` | GET | **Static** narrative with `[g]/[r]/[n]` markup | `useIntelligenceAnswer` → `AiAnswerCard` |
| Intelligence | `/api/intelligence-default` | GET | **Static** shared base block | `useIntelligencePage` — **merged as the base**, then overridden per type |

## Simulation Studio (3)

| Module | Endpoint | Method | Purpose | Frontend consumer |
|---|---|---|---|---|
| Simulation | `/api/simulation/scope` | POST | Measured plan, lever ranges and defaults, fitted lift model | `useStudioScope` → `Simulation.tsx` |
| Simulation | `/api/simulation/simulate` | POST | Three levers → the window's Revenue and ROI beside the current plan | `useStudioSimulate` → `ResultStrip`, `WindowChart` |
| Simulation | `/api/simulation/curve` | POST | Revenue and ROI at every discount depth for the budget and days | `useStudioCurve` → `CurveChart` |

## Decision Center (4)

| Module | Endpoint | Method | Purpose | Frontend consumer |
|---|---|---|---|---|
| Decision | `/api/decision/record` | POST | Assemble one governed record | `useDecisionRecord` |
| Decision | `/api/decision/briefing` | POST | Render `briefing.json` + `briefing.html` | `useDecisionBriefing` |
| Decision | `/api/decision/{type}` | GET | **Static** legacy block | none found |
| Decision | `/api/decision-default` | GET | **Static** legacy block | none found |

## Reports (7)

| Module | Endpoint | Method | Purpose | Frontend consumer |
|---|---|---|---|---|
| Reports | `/api/reports/modules` | GET | What can be generated | (registry; page reads `modules` from the listing) |
| Reports | `/api/reports` | **POST** | Generate → **returns metadata, never bytes** | `useGenerateReport` → `ExportReportButton` |
| Reports | `/api/reports` | GET | The library, filtered | `useReportLibrary` → Reports page |
| Reports | `/api/reports/{report_id}` | GET | Metadata + **stored** preview | `ReportPreviewModal` |
| Reports | `/api/reports/{report_id}/download/{fmt}` | GET | **The only route that answers with a file** | `downloadArtifact` |
| Reports | `/api/reports/{report_id}` | **DELETE** | Remove report + artifacts | `useDeleteReport` |
| Reports | `/api/reports` | **DELETE** | Empty the whole library | `useClearReports` |

## Storage — all unauthenticated (5)

| Module | Endpoint | Method | Purpose | Frontend consumer |
|---|---|---|---|---|
| Store | `/api/store/scenarios` | **POST** | Store a simulation result (append a version) | `useSaveScenario` |
| Store | `/api/store/board-decisions` | **POST** | Store a Decision Center board (scenarios, chosen slot, rationale) | `useSaveBoardDecision` |
| Store | `/api/store/board-decisions` | GET | Saved board decisions, newest first, with a summary | `useBoardDecisions` |
| Store | `/api/store/board-decisions/{id}` | GET | One saved board, whole | `useLoadBoardDecision` |
| Store | `/api/store/board-decisions` | **DELETE** | Clear the board decision history | `useClearBoardDecisions` |
| Store | `/api/store/scenarios/{scenario_id}` | GET | Read one back, with `stale` | `useStoredScenario` |
| Store | `/api/store/decisions` | **POST** | Store a decision record (append a version) | `useSaveDecision` |
| Store | `/api/store/decisions` | GET | List stored decisions, newest first | `useStoredDecisions` |
| Store | `/api/store/decisions/{decision_id}` | GET | Read one back byte-for-byte | `useStoredDecision` |

## Connector proxies (7)

| Module | Endpoint | Method | Purpose | Frontend consumer |
|---|---|---|---|---|
| Connectors | `/api/proxy/databricks/warehouses` | POST | List SQL warehouses | `DatabricksModal` |
| Connectors | `/api/proxy/databricks/query` | POST | Execute a SQL statement | `DatabricksModal` |
| Connectors | `/api/proxy/sap/odata` | POST | SAP Gateway / OData | `SapModal` |
| Connectors | `/api/proxy/powerbi/workspaces` | POST | List Power BI groups | `PowerBiModal` |
| Connectors | `/api/proxy/powerbi/reports` | POST | List Power BI reports | `PowerBiModal` |
| Connectors | `/api/proxy/generic/rest` | POST | Any REST endpoint (NielsenIQ) | `NielsenModal` |
| Connectors | `/api/proxy/openai/chat` | POST | OpenAI chat completions | `AdvisorCard` |

## Static content (7)

| Module | Endpoint | Method | Purpose | Frontend consumer |
|---|---|---|---|---|
| Shell | `/api/nav` | GET | Sidebar structure | `useNav` → `Sidebar` |
| Shell | `/api/user` | GET | **Static persona** | `useUser` → `Topbar` |
| Settings | `/api/settings` | GET | Preferences + integration names | `useSettings` |
| Connections | `/api/connections` | GET | **Static** connector catalogue | `useConnections` |
| Legacy | `/api/command` | GET | **Static** legacy block | **none found** |
| Legacy | `/api/ai-watch` | GET | **Static** | **none found** |
| Legacy | `/api/recommendations` | GET | **Static** | **none found** |

## Summary

| Group | Routes |
|---|---:|
| Command Center | 8 |
| Calendar | 4 |
| RCA / Investigations | 4 |
| Promotion Intelligence | 3 |
| Simulation (A / B / C / legacy) | 7 + 2 + 2 + 2 = 13 |
| Decision Center | 4 |
| Reports | 7 |
| Storage | 5 |
| Connector proxies | 7 |
| Static content | 7 |
| Health | 1 |
| **Total** | **63** |

## Routes with no frontend consumer found

| Endpoint | Note |
|---|---|
| `/api/command` | Legacy static block; the real Command Center reads `/api/command-center/*` |
| `/api/ai-watch` | Static |
| `/api/recommendations` | Static |
| `/api/decision/{type}`, `/api/decision-default` | Superseded by `/api/decision/record` |
| `/api/reports/modules` | Available; the Reports page reads the `modules` list off the library response instead |
