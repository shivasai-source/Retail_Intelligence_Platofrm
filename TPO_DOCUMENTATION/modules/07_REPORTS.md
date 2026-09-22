# Module 07 — Reports (the TPO Intelligence Report Center)

**Route:** `#/reports` · **Page:** `frontend/src/pages/Reports.tsx` (586 lines)
**Status:** Implemented · **First-class module**

A **report-management system**, not an export button.

## 1. The workflow

```
Module screen  (Command Center / Simulation Studio / Decision Center)
      │  [Export Report]  ← reads scope + options AT CLICK TIME
      ▼
POST /api/reports  { module, scope, options, currency, formats }
      │  the server RE-RUNS the authoritative service over that scope
      ▼
Report artifact created and STORED
      │  .xlsx bytes + .pdf bytes + a stored preview, in SQLite
      ▼
201 → METADATA ONLY  { report_id, name, status: "ready", formats, preview }
      │  toast: "Report generated successfully — {name}. Open Reports to download it."
      │  a [View Report] button appears beside the export button
      ▼
Report Center  (#/reports)
      │  library · filter · search · preview
      ▼
[Download Excel] / [Download PDF]
      ▼
GET /api/reports/{id}/download/{fmt}  ← THE ONLY ROUTE THAT ANSWERS WITH A FILE
      ▼
browser saves the file
```

## 2. GENERATE ≠ DOWNLOAD

This separation is the whole point of the module, and it is enforced in three
places:

| Layer | Enforcement |
|---|---|
| Route table | `POST /api/reports` returns metadata and **never bytes**. A file crosses the wire only from the explicit download route |
| Service | `service.generate()` returns a `report_id`. *"It does NOT return bytes: handing a file back here is what made the old behaviour download on click"* |
| Client | `useGenerateReport` posts and receives metadata; **nothing in it touches a blob or an anchor**. `downloadArtifact` is a separate function |

The predecessor `/export` endpoint answered with a file, which is why a click
downloaded immediately.

**`ExportReportButton` is a single button, not a format menu.** Both artifacts
are produced and stored; the choice of format belongs at the point of download.
It also **does not navigate** — the brief was explicit that generating must not
force the user off the module they are working in, so the follow-up is offered
as a [View Report] button rather than taken for them.

The success toast fires **only after the server confirms a `ready` report with
artifacts behind it**; a failure shows the server's own reason.

## 3. The client posts a scope, not results

> *"What travels is what the user SELECTED — filters, the mode, the control
> values. The server re-runs the authoritative service over that scope, so a
> client cannot put a number into a stored report that this project's engine did
> not produce."*

`scope` keys must be `filters.DIMENSIONS`. **An unknown key is rejected, not
dropped** — silently ignoring `regionn` would hand back a report over a *wider*
scope than the caller asked for, and it would look successful.

`options` carries the module's own control values — a scenario's discount, the
the studio's three lever values, the Decision Center board. **Inputs, never
results.** Credential-shaped keys (`password`, `token`, `secret`,
`authorization`, `auth`, `api_key`, `apikey`, `cookie`, `session`) are stripped
before storage.

## 4. The report registry — 5 modules

`reports.service.MODULES`:

| Key | Label | Filename stem | Adapter |
|---|---|---|---|
| `command-center` | Command Center | `TPO_Command_Center` | `adapters.command_center` |
| `simulation-investigation` | Simulation Studio — Investigation Simulation | `TPO_Simulation_Investigation` | `adapters.simulation_investigation` |
| `decision-center` | Decision Center | `TPO_Decision_Record` | `adapters.decision_center` |

`GET /api/reports/modules` serves this list, so the UI offers the control only
where a real reportable dataset exists.

### Deliberately absent

| Module | Why |
|---|---|
| **Investigations / RCA** | No computed dataset — its content is authored JSON |
| **Promotion Intelligence** | Same |
| **Calendar** | Not in the registry |
| **Data Connections** | *"Connector configuration is not a reportable dataset."* The page's Export Catalog button is **disabled with that reason** — it previously existed with no handler at all |
| **Settings** | Purely administrative |

## 5. Report content — where the values come from

**Reports are not static templates.** Each adapter calls **the same service
function the screen's own endpoint calls**:

```
app/tpo/*  →  the endpoint the screen used   →  the screen
           →  the adapter                    →  ReportDoc → .xlsx / .pdf
```

So the export cannot disagree with the screen: both are downstream of the same
call. **No adapter divides, multiplies or compares two KPIs to derive a third.**

| Module | Service calls |
|---|---|
| Command Center | `service.kpis`, `service.risk_alerts`, `service.promotion_mix`, `service.top_promotions` |
| Investigation Simulation | `simulation.run` (+ `execution.simulate` when a discount was set) |
| Simulation Studio | `studio.simulate` |
| Decision Center | `decision.build_record` over the posted payloads |

### What each report contains

| Module | Contents |
|---|---|
| **Command Center** | The 6 KPI cards (value, previous, delta, trend, availability, evidence basis, `measured_at`), the risk counts and alert rows, the promotion mix, the top promotions, the filters block, meta and disclaimers |
| **Investigation Simulation** | The measured Current Plan and the simulated scenario **side by side as two labelled columns** — never merged — with the simulated one reported as the approved uplift **band** (low and high) |
| **Simulation Studio** | The three levers, the window's plans side by side, the week-by-week table, the lift model's notes |
| **Decision Center** | The whole record, flattened into sections **without reinterpreting any of it**. Approval and persistence language is copied verbatim |

**A missing value is a blank cell, never `0`.** A figure the engine could not
produce must read as absent in the export exactly as it does on screen.

**Charts are not exported.** Reports carry KPI blocks, key-value blocks, tables
and text — `ReportDoc` has four section kinds (`kpi`, `kv`, `table`, `text`) and
no image or chart kind.

## 6. The two writers

One intermediate document, two writers — five modules × two formats would
otherwise be ten bespoke generators, and the day one drifts is the day the same
report says two different things in two formats.

```
adapter → ReportDoc → excel.write(doc, currency) → .xlsx bytes
                    → pdf.write(doc, currency)   → .pdf bytes
```

A writer knows about column widths and page breaks and **never about ROI**.
An adapter knows about KPIs and **never about openpyxl or reportlab**.

### Values are carried raw, with a kind

A currency cell holds `9071892.0` and the column says `currency`; it does **not**
hold `"₹90.7 L"`.

- **Excel** receives a real number it can sum, sort and chart, plus a number
  format whose currency symbol follows the user's selection — a USD session
  never produces a rupee-formatted workbook.
- **PDF** renders through `app/tpo/formatting.money` — **the same function the
  screen used**. The one substitution is the rupee glyph, which none of the
  bundled reportlab fonts can draw.

The **KPI display string is authoritative**: `KpiEntry.display` is the card's own
`display_value`, and a writer showing text must show *that*, never a
re-rendering of `value`. Re-formatting looks harmless and is not —
`formatting.score` at two decimals turns the card's `"66"` into `"66.00"`.

### Real files, not renamed ones

`openpyxl` produces genuine zipped OOXML with typed cells, number formats,
frozen headers and autofilters. `reportlab`'s platypus produces a paginated PDF
with a flowable frame, so tables break across pages properly and headers repeat.
A section may request landscape, and the document is built in page templates so
it genuinely re-frames.

`tests/test_reports_export.py` (41 tests) **opens the generated bytes with real
readers** and asserts on page count, metadata and extracted text — a 200 proves
nothing about a report.

## 7. Report persistence

`backend/app/store/reports.py` → the `reports` table in `backend/.store/tiq.db`.

| Column | Notes |
|---|---|
| `id` | The `report_id` |
| `name` | Readable — `"Command Center — F25 · October · Modern Trade"` |
| `module`, `module_label` | Registry key + label |
| `title` | The document title |
| `scope_label` | The one-line scope |
| `scope_json`, `options_json`, `filters_json` | What it was generated from |
| `currency` | |
| `status` | `generating` → `ready` \| `failed` |
| `error` | The reason, when failed |
| `preview_json` | The **stored** preview |
| `xlsx_name`, `xlsx_blob`, `pdf_name`, `pdf_blob` | The artifacts themselves |
| `owner` | **Always `NULL`** — there is no authentication |
| `created_at` | Indexed `DESC` |

**`created_by` is not implemented.** The column exists as `owner` and is always
null, with `NO_OWNER_NOTE` returned beside every listing.

### Why BLOBs and not files

`db.py`'s rationale for SQLite is *"it is a single file, so a deployment is a
copy"*. Writing the `.xlsx` and `.pdf` beside it as loose files would break
that, and would make an orphaned artifact possible the moment a metadata row and
a directory disagreed. Holding them in the row makes a delete **atomic**, and no
filesystem path is ever exposed to the browser — a report is addressed only by
its `report_id`. Reports are 5–50 KB.

### Lifecycle ordering

A row is opened **`generating` first**, so a failure leaves a `failed` report
**with its reason in the library** rather than nothing at all. The document is
built **once** and written in both formats from it — two builds could disagree,
and would run the authoritative service twice for one report.

A malformed scope is rejected **before** the row is opened: that is a rejected
*request*, not a failed report, and should not leave a `failed` row behind.

`READY` is never written for a row whose bytes are absent, and the route returns
**500** rather than 201 if that somehow happened.

### Not append-only — a deliberate departure

The scenario and decision tables beside it are append-only and guarded as such.
A report is a **derived artifact**, regenerable from its stored scope, so
deleting one destroys no history — and a library nobody can tidy is a library
that fills with noise.

## 8. The Report Center page

```
Header   [Clear all]            (disabled on an empty library, with a reason)
Filters  module ▾ · format ▾ · search
Table    Name · Module · Scope · Generated · Status · [View] [Excel] [PDF] [🗑]
```

| Element | Behaviour |
|---|---|
| **Listing** | Newest first. Server-side `module` / `format` / `search` filters, `limit` 1–500 (default 200) |
| **Every row has an artifact** | There are no seeded example rows |
| **Status pill** | `ready` / `generating` / `failed`; a failed row's `error` is its tooltip |
| **View** | Opens `ReportPreviewModal` |
| **Excel / PDF** | Offered **only for a format that exists**. `formats.xlsx` and `formats.pdf` are the stored filenames, `null` when never written — and the button is **disabled with a reason rather than hidden**: *"PDF not available" tells the reader something; a missing button does not* |
| **Delete** | Confirms, naming the report and stating it can be generated again from its module |
| **Clear all** | Confirms with the count. **Not filtered** — it empties the whole library, because a clear that spared what a filter was hiding would leave reports behind in a library the user believes is empty |
| **Empty state** | Distinguishes "no reports yet" from "your filter matched nothing" |

### The preview

`GET /api/reports/{id}` returns the **stored** preview:
`module`, `title`, `scope_line`, `generated_display`, `headline`,
`headline_tone`, `kpis[]`, `highlights[]` (≤8), `narrative[]` (≤4),
`empty_reason`, `disclaimers[]`.

> **The preview is the one that was generated, not a fresh evaluation.**
> Re-running the module here would show **today's** numbers under a report
> generated yesterday, and the library would disagree with the artifacts it is
> listing.

It carries only what a reader needs to confirm the report is the right one —
not the whole document. That is what the artifacts are for.

### The download

`downloadArtifact` is *"the only place this application saves a file"*. It:

1. fetches the artifact (nothing is generated),
2. **refuses an empty blob** — *"an empty workbook opens to a blank grid and
   reads as 'we measured nothing', which is a different claim from 'the artifact
   is missing'"*,
3. reads the filename from `Content-Disposition` (exposed via
   `Access-Control-Expose-Headers`, since it is not CORS-safelisted),
4. saves through a synthetic anchor — the same technique
   `hooks/useBriefing.saveBriefing` uses, this project's one proven download
   path,
5. resolves **only once the browser has the bytes**, so a caller that announces
   a download has one behind it.

## 9. Filenames

`service.filename()` — shaped from what the reader actually chose, so two
exports of two different scopes never collide in a Downloads folder:

```
{stem}_{year}_{month3}_{channel-or-N_channels}_{filename_hint}.{ext}
TPO_Command_Center_2025_Oct_Modern_Trade.xlsx
```

Sanitisation strips filesystem-unsafe characters, collapses underscores, caps
each fragment at 60 characters, and **removes UUID-shaped runs** — a raw
identifier nobody wants in a filename.

The channel is included precisely because without it two exports of the same
month for different channels land on the same name and the browser silently
suffixes "(1)".

The **library name** is deliberately different from the filename: a person
scanning a library reads *"Command Center — October F25 · Modern Trade"*, not
`TPO_Command_Center_2025_Oct_Modern_Trade.xlsx`.

## 10. Error handling

| Situation | Response |
|---|---|
| Unknown module | **404** listing the exportable modules |
| Unknown scope key | **422** naming the key and the valid dimensions |
| Adapter cannot report (missing `target_units`, missing `record`, empty scope) | **422** with the adapter's own sentence |
| Writer raised | Row flipped to `failed` with `"{ExcType}: {message}"`, then re-raised |
| Report reached `ready` with no bytes | **500** — never 201 for a report with no artifact |
| Unknown report id | **404** (`ReportNotFound`) |
| Format never generated | **404** (`ArtifactNotFound`) — a **distinct** exception, so the UI can disable one button without hiding the row |
| Stored artifact empty | **500** — nothing is sent |

## 11. Known limitations

| # | Limitation |
|---|---|
| 1 | **The library is global and unauthenticated.** Any caller can list, download, delete a report, or empty the entire library |
| 2 | **`created_by` is not implemented** — `owner` is always `null` |
| 3 | **No charts in reports.** `ReportDoc` has no image or chart section kind |
| 4 | **No CSV format.** Only `xlsx` and `pdf` |
| 5 | **Calendar, Investigations and Promotion Intelligence have no report**, correctly — none has a computed dataset behind it |
| 6 | The rupee symbol is substituted in PDFs; no bundled font can draw it |
| 7 | Artifacts live in the SQLite file, so it grows with the library. **No retention policy, no size cap, no automatic cleanup** |
| 8 | The Decision Center report requires the client to carry four payloads; it cannot be generated from a stored `decision_id` alone |
| 9 | Generation is **synchronous** — the request blocks while both artifacts are written |
| 10 | `backend/app/data/reports.json` is a **dead file**. Its endpoint was removed from `misc.py`, because `misc` is registered first and a fake-data route on that path would have **shadowed** the real listing |

## 12. File map

| Concern | File |
|---|---|
| Page | `frontend/src/pages/Reports.tsx` |
| Export button | `frontend/src/components/reports/ExportReportButton.tsx` |
| Client | `frontend/src/hooks/useReportCenter.ts` |
| Types | `frontend/src/types/reportCenter.ts`, `reports.ts` |
| Router | `backend/app/routers/reports.py` |
| Registry + dispatch | `backend/app/reports/service.py` |
| Adapters | `backend/app/reports/adapters.py` (981 lines) |
| Document model | `backend/app/reports/model.py` |
| Writers | `backend/app/reports/excel.py`, `pdf.py` |
| Persistence | `backend/app/store/reports.py` |
| Tests | `backend/tests/test_report_center.py` (28), `test_reports_export.py` (41) |
