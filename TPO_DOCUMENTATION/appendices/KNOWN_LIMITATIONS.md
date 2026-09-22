# Appendix — Known Limitations

Every limitation found during the audit of 2026-08-24. Nothing is hidden.

Many of these are **deliberate refusals** with a stated reason in the code —
those are marked **[Deferred]**, and the reason is quoted rather than
paraphrased. Others are genuine gaps.

---

## 1. Filter reach on the Command Center — **behaviour ≠ documentation**

**Severity: high** — this is the most likely thing to surprise a user.

**Only two Command Center queries receive the full filter selection:**

| Receives all 14 dimensions | Receives `year` + `currency` + local params |
|---|---|
| `/kpis` · `/filters` | `/trend` · `/risk-alerts` · `/underperforming-promotions` · `/promotion-mix` · `/top-promotions` · `/breakdown` |

So selecting **Channel = Modern Trade** narrows the six KPI cards but leaves the
trend, the risk alerts, both tables, the promotion mix and all six chart
sections describing the whole year across every channel.

**The backend supports the full payload on all eight routes** —
`routers/command_center.get_filters` is shared by every one of them. The
frontend chooses not to send it. `hooks/useCommandCenter.useScope()` states the
intent:

> *"KPI CARDS answer 'what do the numbers look like for exactly this selection'…
> CHARTS answer 'how did promotions behave over the year', and each carries its
> own local control… what is not named is not sent… It also means chart caches
> survive a Channel or Product change untouched."*

**Two comments in the repository state the opposite and are incorrect as
written:**

- `frontend/src/store/commandFilters.ts` — *"Every panel — KPI cards, trend,
  risk alerts, promotion mix, both tables — reads this same object and sends it
  to the backend verbatim."*
- `frontend/src/components/command/ChartSections.tsx` — *"Every one reads the
  SAME filter state as the KPI cards, through the same `useBreakdown` hook."*

Recorded, **not silently reconciled**. Resolving it is a product decision:
either send the filters and accept the cache churn, or change the two comments
and label the charts as year-scoped on screen.

---

## 2. Authentication and authorization — **[Deferred]**

**Severity: critical for any shared or public deployment.**

**All 63 API routes are unauthenticated.** There is no identity provider, no
session, no token and no route guard anywhere.

Anyone who can reach the process can:

- store a scenario or a decision (`POST /api/store/scenarios`, `/decisions`),
- append versions to records they did not create,
- read every stored decision (`GET /api/store/decisions`),
- generate a report into the shared library (`POST /api/reports`),
- read every stored report and its artifacts,
- **delete any report, or empty the entire library** (`DELETE /api/reports`).

Nothing in the store is private and nothing is attributable: every record
carries `owner: null` with `NO_OWNER_NOTE`.

The sign-in at `#/login` accepts **any** email with **any** password, checks
neither, reaches no server, and issues no token. `#/command` is reachable
without ever visiting it.

**Why it was deferred rather than faked** — `backend/app/routers/store.py`:

> *"B11 was DEFERRED: this project has no identity provider, and building access
> control on a self-asserted email would be an enforcement claim with nothing
> behind it… This is stated rather than fixed because the fix requires
> authentication, which does not exist. It is safe on a single-user localhost
> deployment and is NOT safe on a shared or public one."*

**Additional exposure:**

- The connector proxies forward caller-supplied credentials to third-party
  hosts. `POST /api/proxy/generic/rest` will call **any URL it is given** — on an
  exposed host that is an open forwarder. Credentials are not persisted or
  logged, but they transit the process.
- `/docs` and `/openapi.json` are served unguarded.

**Mitigation:** host it behind something that authenticates, or do not expose it.

**Documentation drift:** `routers/store.py` says *"none of the 52 routes"*. The
count is now **63**; the statement itself remains true. `README.md`'s deployment
note lists two write endpoints and predates the Report Center's five.

---

## 3. RCA / Investigations is static content

**Severity: high** — the page looks analytical and is not.

The causal graph, node metrics, deltas, impacts, evidence strings, accelerator
statuses, progress percentage, insight and source counts are **authored JSON**
in `backend/app/data/investigations.json`. The staged "multi-agent build" is a
timer-driven animation.

**`focus.json` reports a trade spend of ₹98.6 Cr for a scope the validated
engine measures at ₹7.7 Cr** — more than an order of magnitude apart. The same
figure appears in `investigations.json`'s `contextChips`.

The application handles this correctly at the boundary:
`app/tpo/studio.py` refuses to let any RCA figure enter a calculation,
and stamps every context field with its provenance. But **on screen, the numbers
are presented without that qualification.**

Also missing: **no investigation identifier exists** anywhere (router, data
files, client state), so a simulation cannot be traced back to the investigation
that prompted it; and **no structured problem statement exists**.

---

## 4. Promotion Intelligence is entirely static

**Severity: high** — same reason.

All 8 tabs render literals from `pages-by-type.json`: the waterfall, key
insights, saturation curve, incremental-sales trend and regional variance.

The "AI synthesis" (`useStreamedAnswer`) is a **typing animation over static
text**; no model is called. (The one genuinely live LLM path is the Home page's
`AdvisorCard` → `/api/proxy/openai/chat`.)

The page's promotion and period dropdowns are **hardcoded arrays in the TSX**
and drive nothing, and the page is **disconnected from the global filter
state**.

The authored insight *"Discount saturation observed beyond 18%"* is not derived
from — and is not consistent with — this project's approved treatment depths
(5/10/15/20/25), whose response model explicitly refuses to interpolate.

Only 4 variants exist, one per archetype, so two different investigations of the
same type render identically.

---

## 5. Data-quality defects in the source data

**Severity: medium — all are handled, but they constrain what can be built.**

| # | Defect | Scale | Handling |
|---|---|---|---|
| 1 | `fact_sales.Month` disagrees with the business week | **46,440 of 205,920 rows (22.6%)** | The column is never read; the month comes from `(Year, Week) → dim_date` |
| 2 | `fact_sales.Date` scrambled on CH002/CH004/CH005 | **51.9% of those rows** | Only the year is read. **Day-grain analysis is impossible** — the Simulation Studio's window is measured in complete business weeks for this reason |
| 3 | `PS001` / `PB001` absent from the fact table | — | Expected; the dated seasonal ids carry their economics |
| 4 | `Promotion_Name` not unique (7× "20% Discount", 7× "Buy3Get1") | 14 of 18 rows | `Promotion.label` uses the description |
| 5 | Blank `Retailer` on every B2B store | 64 stores | `retailer_available: false`; the control hides |
| 6 | Stray leading spaces in dim_product / dim_promotion | several cells | `loader._clean` |
| 7 | BOM in `dim_promotion_final.csv` | 1 file | `utf-8-sig` |
| 8 | dim_date describes 2026; no transactions exist | 151 days | `available_years()` reads the fact stream |

---

## 6. No approval workflow — **[Deferred]**

`can_be_approved` is `false` in **every** decision record.

> *"This project defines no approval criteria: nothing states who approves a
> promotion decision, against which tests, or in what order. A record cannot be
> declared approvable against rules that do not exist."*

No approver, no author, no notification, no audit trail of who did what. The
decision briefing prints this on the page so a reader of an emailed PDF cannot
miss it.

Decision Center is described as the place execution would happen, but **nothing
in this application executes a promotion.**

---

## 7. No governance thresholds exist — **[Deferred]**

The project has approved **no** budget ceiling, margin floor, cannibalization
limit, PEI floor, maximum discount or maximum duration.

`risk.py` reports each as a named **governance gap** rather than inventing one:

> *"Writing 'Trade Spend > 10 Cr = High Risk' here would create a business rule
> by implementation, in a file nobody would think to review."*

The one boundary that **is** used — under 2 pp of break-even headroom = "NO
MARGIN" — is cited to `scripts/audit_roi_realism.py` with its provenance
attached.

**Consequence:** the risk panel often reports "unknown" severity. That is
accurate, not a bug, but it limits how actionable the panel can be.

---

## 8. Simulation modelling limits — **[Deferred]**

| Not modelled | Stated reason |
|---|---|
| **Forecasting** | None exists. Three near-neighbours are labelled as what they are: the uplift band is *"not a confidence interval"*, the weekly view is *"a decomposition, not a forecast"*, and the studio's lift curve carries the evidence it was fitted from |
| **Elasticity** | The treatment rules are the dataset's **design parameters**, verified to hold — not a fitted curve |
| **Discount interpolation** | *"12% is not a shallower PR003 — it is a treatment nobody approved… inventing one would be a coefficient, not a rule."* Only 5/10/15/20/25 can be priced |
| **Band midpoint** | *"The approved rule for PR003 is 40-50%, not 45%… Collapsing it would manufacture a precision the rule does not grant, and would throw away the only honest uncertainty this model has"* |
| **Duration response** | No approved rule maps weeks to uplift. `duration_weeks` is echoed with `modelled: false` |
| **Spend as an input** | Trade Spend is `b(1+u)P(d+c)` — an output |
| **Retailer incentive** | No dataset splits retailer support out of `Promotion_Cost` |
| **Inventory allocation** | The project holds no inventory data |
| **Cannibalization response** | The approved rules define none. The engine still **measures** it on synthesized rows |
| **Buy2Get1 as a rescue mechanic** | The promotion master holds none, and fabricating an uplift and a cost for it *"is the one thing this must not do"* |

Also: `/run` records levers and **applies none** (`levers.applied: false`).

---

## 9. No frontend tests

**Severity: medium.**

No Vitest, Jest, Testing Library or Playwright configuration exists, and no test
file exists anywhere under `frontend/`. The backend suite says so openly —
`test_filter_reconciliation.py` notes that the reconciliation logic lives in
`frontend/src/store/commandFilters.ts` and that *"this project has no frontend
test [suite]"*.

**Untested in consequence:** filter reconciliation and recency tie-breaking,
the two-scope query split (§1), chart rendering, the Simulation Studio mode
switch and store isolation, the report download path, the Calendar's layout
mechanism, and every component's empty/error state.

Related: TypeScript types under `frontend/src/types/` are **hand-written**, not
generated from the OpenAPI schema, and **no schema-sync step exists** — so the
two can drift without a compile error.

---

## 10. Calendar gaps

| # | Limitation |
|---|---|
| 1 | **No dedicated test module** for the Calendar's routes. Its date semantics are covered indirectly by `test_month_semantics.py` |
| 2 | The business-event source (`calendar.json`) holds **6 events, June–July 2025 only**. Every other month's "upcoming" is promotion starts alone |
| 3 | The feed **never crosses years** — in December, "upcoming" is empty rather than showing January |
| 4 | **Not connected to the global filter state.** Only year and channel narrow it |
| 5 | **No export** — the Calendar is absent from `reports.service.MODULES` |
| 6 | The page defaults to a literal `useState(2025)` before the matrix reports which years exist; it self-corrects |
| 7 | `kind: "festival"` is a tint bucket only, not a business category |

---

## 11. Report Center limitations

| # | Limitation |
|---|---|
| 1 | **The library is global and unauthenticated** — any caller can list, download, delete, or empty it |
| 2 | **`created_by` is not implemented** — `owner` is always `null` |
| 3 | **No charts in reports.** `ReportDoc` has four section kinds (`kpi`, `kv`, `table`, `text`) and no image kind |
| 4 | **No CSV format** — `xlsx` and `pdf` only |
| 5 | **No report for Calendar, Investigations or Promotion Intelligence** — correctly, none has a computed dataset behind it |
| 6 | The rupee glyph is **substituted** in PDFs; no bundled reportlab font can draw it |
| 7 | Artifacts are BLOBs in `tiq.db`, so it grows with the library. **No retention policy, no size cap, no cleanup** |
| 8 | The Decision Center report needs the client to carry four payloads; it cannot be generated from a stored `decision_id` alone |
| 9 | Generation is **synchronous** — the request blocks while both artifacts are written |
| 10 | `backend/app/data/reports.json` is a **dead file**; its endpoint was removed because `misc` is registered first and would have shadowed the real listing |

---

## 12. Settings and Data Connections are non-functional

| # | Limitation |
|---|---|
| 1 | Settings is **entirely read-only**; nothing can be changed or persisted |
| 2 | `defaultPeriod: "Q2 FY25"` and `defaultChannel` are **not applied anywhere**. `"Q2 FY25"` is not even expressible — there is no quarter dimension |
| 3 | No theme or density control exists despite the rows |
| 4 | All three integrations show **Not connected**, correctly — none exists |
| 5 | The `#/connections` catalogue is **entirely authored**; statuses, row counts and freshness are not measured |
| 6 | Three of its four KPI tiles ("3.8 min", "142K+", "92%") are **string literals in the TSX** |
| 7 | The catalogue and the working portal connectors are **two disjoint lists** |
| 8 | **No connector feeds the analytical datasets** |
| 9 | Add Source shows a toast and does nothing |

---

## 13. Three identities in one session

| Surface | Shows |
|---|---|
| `store/portalUser` default | `"Abhinav"` |
| `Topbar` (from `/api/user`) | `"Sanjay Kumar" · "Commercial Analyst"` — **a static persona** |
| Settings profile | The email the visitor typed |

This is the same class of mismatch B9 corrected on the Settings card; the
Topbar still reads the persona.

---

## 14. Architectural and operational constraints

| # | Constraint |
|---|---|
| 1 | **No cache invalidation.** The CSVs are immutable for the process lifetime; changing one requires a **restart** |
| 2 | **Single process assumed.** Multiple workers would each hold their own 15 MB store and contend on one SQLite file |
| 3 | **No migration tool.** `SCHEMA_VERSION = 1`, tables created with `CREATE TABLE IF NOT EXISTS` |
| 4 | **No Dockerfile, no compose file, no CI configuration** |
| 5 | **No logging configuration, no metrics, no monitoring** — beyond Uvicorn's default and the loader's stdout warnings |
| 6 | **No code splitting.** The JS bundle is 648 kB and Vite warns about it |
| 7 | **No `.env` support** — environment variables must be set in the shell |
| 8 | The test suite takes **~11 minutes**; several modules build the full store |
| 9 | Windows-oriented commands throughout `README.md` / `DEV.md` (`./.venv/Scripts/…`) |
| 10 | Two virtualenvs exist on the development machine (`backend/.venv` documented, repo-root `venv/` used for the audit) |

---

## 15. Modelling constraints that follow from the data

| # | Constraint |
|---|---|
| 1 | **Volume KPIs are not additive.** A year is not the sum of its months; All Channels is not the sum of five channels. Correct behaviour, but it means `share_pct` can only be computed on Trade Spend, and every ranking chart must be read as a ranking rather than a composition |
| 2 | **F24/F25 are calendar years.** Fiscal Apr–Mar semantics are not implemented; `dim_date`'s `Quarter` is calendar. Changing this would require re-baselining every KPI |
| 3 | **No week dimension in `FilterState`.** A drill-down reaches `(promotion, product, channel)` and pools whatever weeks that triple traded in scope — exact for a single-week event, a pooled figure otherwise |
| 4 | **Rank 1 is never promoted**, so the smallest pack is only ever a cannibalization victim |
| 5 | **Cannibalization needs ≥3 comparable events.** Narrow scopes report unavailable, or fall back to a wider scope via the ladder |
| 6 | **Only two years of data** (2024, 2025), so exactly one YoY comparison is possible and 2024 has no predecessor |
| 7 | **`Country` is a single value** and is not a filter dimension |

---

## 16. Documentation discrepancies

Recorded in full in [12_CHANGE_HISTORY.md](../12_CHANGE_HISTORY.md) §3.
Summary:

| # | Claim | Reality |
|---|---|---|
| 1 | "Every panel … sends [the filters] to the backend verbatim" | Only `/kpis` and `/filters` do — §1 above |
| 2 | "Every one reads the SAME filter state as the KPI cards" | `useBreakdown` sends `year` only |
| 3 | "none of the **52** routes … is [guarded]" | **63** routes; the statement remains true |
| 4 | `DEV.md`: "the deterministic scenario engine (`simulationEngine.ts`) ported verbatim" | **That file no longer exists** — Phase A removed the browser-side engine |
| 5 | `README.md`: SQLite persists "saved scenarios and decisions" | Also report metadata **and artifacts** |
| 6 | `README.md`: the deployment warning lists two write endpoints | The Report Center added five more, including two deletes |
| 7 | `README.md`: "React 18" | `package.json` declares **React ^19.2.8** |
| 8 | `DEV.md`: "All 9 routes are real pages now" | **11 routes** exist |
| 9 | `settings.json` preferences | **Nothing reads them as defaults** |
| 10 | `focus.json`: "₹98.6 Cr" | The engine measures **₹7.7 Cr** |
| 11 | `README.md`: "Not yet done: … full TypeScript strictness on a few JSON-shaped `any`s" | `tsc -b` currently passes with **0 errors** |
| 12 | `routers/pages.py`: the `*-default` routes are "not used by the per-type pages above" | True for simulation and decision; **`/intelligence-default` IS used** as the merge base |

---

## 17. In-flight work observed during this audit

The working tree carries **uncommitted changes** at the time of writing:

  entire Report Center (`app/reports/`, `app/routers/reports.py`,
  `app/store/reports.py`, the frontend page hook and export button, and two test
  modules).
- **Modified:** `app/main.py`, `app/routers/{misc,simulation}.py`,
  `app/store/__init__.py`, `requirements.txt`, and six frontend pages.

A refactor completed **during** the audit: the Report Center's table moved from
`app/reports/store.py` to `app/store/reports.py`, because
`test_store_persistence.test_the_store_is_the_only_thing_that_writes` requires
every `sqlite3` call and `INSERT` to live inside `app/store/`. For a short
window the two import sites still pointed at the old path and the application
did not import; that was resolved before the test run, which finished
**1,470 passed**.

**Implication:** the documentation in this package describes the **working
tree**, not the last commit. Some of what is documented is not yet in git
history.
