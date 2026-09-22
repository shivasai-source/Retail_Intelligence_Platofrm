# 12 — Change History

Reconstructed from **repository evidence only**: `git log` (17 commits),
`DEV.md`'s phase notes, the phase markers carried in code (`Phase A`, `B1`–`B12`),
and script docstrings. No date or commit id is invented.

## 1. Commit timeline

| Commit | Date | Subject |
|---|---|---|
| `b414efc` | 2026-08-18 | Initial commit: TIQ Retail Intelligence Platform migration |
| `3da195b` | 2026-08-18 | Add command center implementation and supporting updates |
| `e20f2ee` | 2026-08-18 | Add Command Center charts phase: `/breakdown` endpoint and chart components |
| `bb1bfc3` | 2026-08-19 | first commit |
| `8540e67` | 2026-08-19 | Command Center: promotion economics fix and chart rebuild |
| `de411be` | 2026-08-20 | Command Center: derive promotion mechanic from the API, and align the cards |
| `a2e8a49` | 2026-08-20 | Promotion Calendar: real Year > Month > Channel > Promotion read model |
| `336781e` | 2026-08-20 | feat: establish simulation KPI foundation |
| `fb00177` | 2026-08-20 | feat: TPO Simulation Studio & governed Decision Center (B1-B12) |
| `3a4881f` | 2026-08-21 | Portal: rename the platform and drop the COMING SOON badges |
| `7ab713a` | 2026-08-21 | Simulation Studio: let the baseline run reach the page |
| `f9394e0` | 2026-08-21 | Command Center: drill into the event that was clicked, not its neighbourhood |
| `2589dea` | 2026-08-21 | Cannibalization: resolve the scope the metric actually needs |
| `177143b` | 2026-08-21 | KPI deltas and cannibalization scope fixes |
| `a42a61c` | 2026-08-21 | Command Center: make every risk alert and severity band actionable |
| `d150c06` | 2026-08-21 | Simulation Studio: add General Optimization as a second, separate mode |
| `870bec5` | 2026-08-24 | Polish collapsible sidebar navigation |

## 2. Evolution by area

### 2.1 Predecessor and migration

This repository **supersedes** a vanilla HTML/CSS/JS application at
`TPO_Sushane_Frontend/TPO-New-Frontend-tpo-focused/`. Every page, the design
system and all six connectors have a verified equivalent here. That folder was
left untouched and nothing in this repository depends on it.

`DEV.md` records the migration phases:

| Phase | Scope |
|---|---|
| 1 | Backend scaffold; `scripts/convert-data.mjs` split the vanilla app's `js/data.js` into `backend/app/data/*.json` |
| 2 | Design system — icons, 22 UI primitives, 8 SVG charts, layout, all ported onto Tailwind utilities over the existing tokens |
| 3 | Routing — `HashRouter` matching `nav.json`'s route strings verbatim |
| 4 | All 9 app pages made real |
| 5 | Portal — `/login`, `/home`, connector rail, advisor card, 6 modals |
| 6 | Connectors — the standalone `connector_proxy.py` (stdlib `urllib`) ported onto FastAPI + `httpx`, mounted at `/api/proxy/*`. `PROXY_BASE` moved from `http://127.0.0.1:8020` to `/api` |
| 7 | Cutover — FastAPI serves `frontend/dist`; one process, one deploy |

**One behaviour difference recorded from phase 6:** FastAPI serialises errors as
`{"detail": …}`, not the old proxy's `{"error": …}`. `proxyFetch()` checks both
keys; new connector work should follow the `detail` shape.

### 2.2 Data generation and correction

Evidenced by `scripts/` docstrings — these ran against the CSVs and are
historical:

| Script | What it changed |
|---|---|
| `regenerate_ch001.py` | CH001 (E-commerce) rows regenerated: the source notebook never applied a promotional uplift at all |
| `diagnose_promotion_economics.py` | Read-only. Identified which economic driver in the generated data produced unrealistic ROI, with the KPI engine held frozen |
| `correct_ch002_f25_buy3get1.py` | **SUPERSEDED — the file says DO NOT RUN.** Applied 0.1925 to CH002 alone (3% overhead + 25% free goods at 65% COGS). Kept for the audit trail |
| `fix_promotion_economics.py` | The global replacement: both defects were the same mistake — volume given away and never booked as investment. Applied across all five channels, valuing free goods at **list** price (0.03 + 0.25 = 0.28), consistent with how Trade Spend values a price discount everywhere else |
| `represent_pb001_as_price_discount.py` | Buy3Get1 re-represented as a **25% effective price discount** rather than a promotional cost — the approved business treatment |
| `validate_fact_data.py` | Read-only post-correction validation, checks A–G |
| `validate_promotion_schedule.py` | Read-only: every promotion sits in the business month the promotion strategy assigns it |
| `audit_roi_realism.py` / `audit_seasonal_2024_vs_2025.py` | Read-only ROI audits through the frozen engine |

**The KPI engine was untouched throughout.** Trade Spend and ROI have the same
definitions before and after every correction.

### 2.3 Channel expansion

The current dataset is `fact_sales_2024_2025_all_channels.csv` — 205,920 rows,
five channels. `config.py` records that this **deliberately supersedes** the
predecessor project's fact table, which was *"stale (61,360 rows, no
`Channel_Id`)"*.

The finalized channel model is CH001 E-commerce, CH002 Modern Trade,
CH003 General Trade, CH004 Travel & Hospitality, CH005 B2B.

### 2.4 KPI development

| Change | Evidence |
|---|---|
| Engine adapted from the validated predecessor project; formulas unchanged, schema changed | `aggregate.py` docstring |
| **Trade Spend corrected** from `Σ Promotion_Cost` alone to `Σ(Base_Revenue − Actual_Revenue + Promotion_Cost)`. The old version understated the predecessor's 2025 figure by **₹23.10 Cr** and flattered every ratio built on it | `calculate_trade_spend` docstring |
| **Baseline gained a channel key** when the schema gained channels. Pooling weekly and monthly channels dragged F25 all-channel ROI from 141.2% to 8.6% | `aggregate.py`, `DEV.md`, `test_baseline_is_keyed_per_channel` |
| **Two row sets split** (`rows_for` / `baseline_rows_for`). They were one set, which let an Offer filter report Margin Impact 56.3% off 6,615 baseline rows while Trade Spend was zero | `filters.py` docstring |
| **Deltas taken before rounding** (`_precise`). PEI's reported delta moved by up to 0.4 pp; ROI and Margin by up to 0.1 | `177143b`, `tests/test_kpi_delta_precision.py` |
| **Cannibalization scope fixed twice** — the Brand-Form widening, then `baseline_rows_for` unconditionally. The second one had been conditional on the first, starving the metric under an Offer filter (i.e. the Simulation Studio's normal scope) | `2589dea`, `177143b`, `tests/test_simulation_cannibalization.py` |
| **Evidence floor + measurement ladder added** for cannibalization | `service.py` |

### 2.5 Command Center

| Change | Commit |
|---|---|
| Initial implementation | `3da195b` |
| `/breakdown` endpoint + chart components — one endpoint behind every ranking chart | `e20f2ee` |
| Promotion economics fix and chart rebuild | `8540e67` |
| Promotion **mechanic derived from the API**, cards aligned. Replaced a hardcoded three-entry PR001/PR002/PR003 list which, by construction, could never select the 20% seasonal mechanic or Buy3Get1 | `de411be` |
| **Drill into the event that was clicked**, not its neighbourhood — the alert and underperforming rows gained real `promotion_id` / `product_id` / `channel_id` | `f9394e0` |
| Every risk alert and severity band made actionable | `a42a61c` |

### 2.6 Filter architecture

The frontend once relied on a hand-written parent→child cascade tree. It was
**one-directional** — it cleared children when a parent changed but never the
reverse — so **138 contradictory states** survived it and resolved to an empty
dashboard. It was replaced by symmetric reachability-based `reconcile()`, with
`lastTouched` recency breaking the tie. Recorded in
`frontend/src/store/commandFilters.ts`.

Backend option generation was likewise moved from the dimension tables to the
rows a selection actually admits, so no dead option can be offered.

### 2.7 Promotion Calendar

`a2e8a49` replaced the authored calendar with a **real Year → Month → Channel →
Promotion read model** over the same `WeekRow` stream every KPI reads. The
legacy `/api/calendar` business-event feed was kept unchanged and is merged into
the Upcoming panel, which is why the new routes are mounted at
`/api/promotion-calendar`.

### 2.8 Simulation Studio

| Phase | What it added |
|---|---|
| **Phase A** (`336781e`) | The Simulation Studio **stopped computing and started reading**. It had divided revenue by spend in the browser and called it "ROI". Levers became recorded-but-not-applied (`levers.applied: false`) |
| **B1** | The scenario model; measured vs hypothetical never mixed; `assert_no_fabricated_results` |
| **B2.1** | `response.py` — the typed read of the approved treatment rules; no interpolation, no midpoint, no spend input |
| **B2.2** | `execution.py` — counterfactual row synthesis, then the existing engine. The first phase in which `status: "simulated"` is legitimate |
| **B3.1** | `investigation.py` — the RCA → Simulation context contract, with per-field provenance |
| **B3.2** | The Command Center scope hand-off (frontend + `test_investigation_handoff.py`) |
| **B4.1** | `comparison.py` — side by side, deltas at both band ends, **no ranking** |
| **B4.3** | `recommendation.py` — the decision **policy as data** |
| **B5** | `weekly.py` — decomposition across observed weeks, not a forecast |
| **B6** | `risk.py` — governance assessment; no invented thresholds, no score |
| **B7** | `decision.py` — the assembled record |
| **B8** | `briefing.py` — the portable artifact |
| **B10** | `store/` — SQLite, append-only, `owner: null` |
| **B11** | **DEFERRED** — authentication. Stated out loud rather than faked |
| **B12** | (referenced in `fb00177`'s subject line) |
| `7ab713a` | Let the baseline run actually reach the page |
| `d150c06` | **General Optimization** added as a second, separate mode |
| *(uncommitted)* | **Target Rescue** — the third mode |

#### 2026-09-22 — the studio rebuilt around three levers

The three-mode studio (Investigation Simulation, General Optimization, Target
Rescue) was removed whole — services, eleven routes, components, hooks,
stores, types, report adapters and tests — and replaced by `app/tpo/studio.py`
and a single-panel page: a discount slider, a trade-spend budget slider and a
days slider, with Revenue and ROI over the window shown beside the scope's
current plan run over the same window. The lift curve is fitted to the
dataset's promoted rows (with dataset-wide and approved-rule fallbacks) rather
than read from five hardcoded treatments; the budget buys coverage of the
scope; days are pro-rated business weeks. No KPI formula changed — the window
rows are read by `aggregate.py` exactly as measured rows are. Decision Center
still reads the earlier payloads from stored records; its tests load a
snapshot (`tests/fixtures/legacy_journey.json`) in place of the removed
endpoints. See [modules/04](modules/04_SIMULATION_STUDIO.md).

### 2.9 Decision Center

`fb00177` replaced authored content with the assembled record. What was removed,
per `pages/Decision.tsx`'s own docstring:

- an ROI of 2.55 in units Simulation had abandoned,
- "Data Confidence — High (89%)",
- strategy rows for **Retailer Incentive** and **Inventory Allocation** — two
  levers no dataset in this project supports,
- a governance panel reporting "Budget Compliance — Compliant" and "Margin
  Threshold — Compliant" **against thresholds B6 established do not exist**,
- an approval animation announcing that the finance team had been notified.

### 2.10 Reports

*(Uncommitted at the time of this audit.)* The previous `/export` endpoint
answered with a file, which is why a click downloaded immediately. It was
replaced by the **Report Center**: generate → store → list → preview →
download, with `POST /api/reports` returning metadata and only
`/download/{fmt}` returning bytes.

The old `GET /api/reports` in `misc.py` — six authored rows ("Sanjay Kumar",
"4.2 MB", "Just now") with no artifact behind any — was **removed rather than
left dead**, because `misc` is registered first and would have shadowed the real
listing.

**A refactor landed during this audit:** the Report Center's table moved from
`app/reports/store.py` to `app/store/reports.py`, because
`test_store_persistence.test_the_store_is_the_only_thing_that_writes` caught it
— persistence belongs beside the rest of the persistence. Both packages'
docstrings now record the reason.

### 2.11 Settings and Data Connections

`fb00177`'s B9 corrected two things on Settings:

- The profile card printed "Sanjay Kumar · Commercial Analyst ·
  sanjay.k@company.com" from `settings.json`, beside the initials of whoever had
  actually signed in — **two different people on one card**. It now shows the
  email the visitor typed, labelled for what it is. No role is shown: there is no
  authorization model to source one from.
- Three integration rows (SSO, Slack, Email) carried a green tick and an
  "Active" pill. None of them exists. They are now listed as **Not connected**.

On Data Connections, an "Export Catalog" button existed with **no handler at
all**. It is now disabled with a stated reason: connector configuration is not a
reportable dataset.

### 2.12 Portal

`3a4881f` renamed the platform and dropped the "COMING SOON" badges from the
five non-live module cards. TPO remains the only `live: true` module.
`870bec5` polished the collapsible sidebar.

---

## 3. Discrepancies between existing documentation and the code

Recorded here rather than silently reconciled, per the source-of-truth rule.

| # | Claim | Where | Actual |
|---|---|---|---|
| 1 | *"Every panel — KPI cards, trend, risk alerts, promotion mix, both tables — reads this same object and sends it to the backend verbatim."* | `frontend/src/store/commandFilters.ts` | **Only `/kpis` and `/filters` receive the full payload.** Trend, risk alerts, underperforming, mix, top-promotions and breakdown receive `year` + `currency` + their own local params |
| 2 | *"Every one reads the SAME filter state as the KPI cards, through the same `useBreakdown` hook."* | `frontend/src/components/command/ChartSections.tsx` | Same as #1 — `useBreakdown` sends `year` only |
| 3 | *"none of the **52** routes in this application is [guarded]"* | `backend/app/routers/store.py` | **63 routes** today. The statement itself remains true |
| 4 | *"Simulation: the deterministic scenario engine (`components/simulation/simulationEngine.ts` — `compute()`, `buildRisk()`) ported verbatim"* | `DEV.md`, Phase 4 | **That file no longer exists.** Phase A removed the browser-side engine; the page now posts a scope and renders what the API returns |
| 5 | *"Saved scenarios and decisions now persist to SQLite… the JSON files under `app/data/` are still read-only page content."* | `README.md` | Still true, but **incomplete**: report metadata and artifacts also persist to the same database |
| 6 | Deployment warning lists two write endpoints | `README.md` | There are now more: `POST /api/reports`, `DELETE /api/reports/{id}` and `DELETE /api/reports` (which empties the whole library) |
| 7 | *"`frontend/` — React 18"* | `README.md` | `package.json` declares **React ^19.2.8** |
| 8 | *"All 9 routes are real pages now"* | `DEV.md`, Phase 4 | **11 routes** exist today (`/login` and `/home` were added in Phase 5) |
| 9 | Settings preferences show `defaultPeriod: "Q2 FY25"`, `defaultChannel: "All Channels"` | `backend/app/data/settings.json` | **Nothing reads these as defaults.** The Command Center's default year comes from `/filters`; the channel default is "all" |
| 10 | `focus.json` reports `spend: "₹98.6 Cr"` for South MT Push, Apr–Jun 2025 | `backend/app/data/focus.json` | The validated engine measures **₹7.7 Cr** for that scope. `investigation.py` cites this explicitly as the reason no RCA figure may enter a simulation |
| 11 | *"Not yet done: … full TypeScript strictness on a few JSON-shaped `any`s"* | `README.md` | `tsc -b` currently passes with **0 errors** |
| 12 | The three `*-default` routes are *"kept for fidelity, not used by the per-type pages above"* | `backend/app/routers/pages.py` | **Accurate for `/simulation-default` and `/decision-default`; inaccurate for `/intelligence-default`**, which `useIntelligencePage` merges as the base layer under the per-type override |

## 4. Deliberate deferrals, restated

These are **not** oversights. Each is refused in code with a stated reason.

| Deferred | Reason, as recorded |
|---|---|
| Authentication / authorization (**B11**) | No identity provider exists; authorization built on a self-asserted email would be an enforcement claim with nothing behind it |
| Approval workflow | This project defines no approval criteria — nothing states who approves, against which tests, or in what order |
| Duration as a lever | No approved rule maps promotion weeks to uplift |
| Spend as a lever | Trade Spend is `b(1+u)P(d+c)` — an output of a treatment, not an input |
| Retailer incentive lever | No dataset splits retailer support out of `Promotion_Cost` |
| Inventory allocation lever | The project holds no inventory data |
| Cannibalization response to discount | The approved rules define none |
| Day-grain analysis | `fact_sales.Date` is scrambled on three channels; the finest trustworthy grain is the completed business week |
| Buy2Get1 as a rescue mechanic | The promotion master holds no Buy2Get1; fabricating an uplift and a cost for it is exactly what must not happen |
| Fiscal-year (Apr–Mar) semantics | `dim_date` carries no fiscal-year field; its `Quarter` is calendar |
| Report export on Settings and Data Connections | Neither has a reportable dataset behind it |
