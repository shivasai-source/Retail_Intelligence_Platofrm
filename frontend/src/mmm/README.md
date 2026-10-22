# MMM — Market Mix & Marketing Intelligence (frontend)

Everything the MMM module owns in the frontend is in this folder. The backend twin is
`backend/app/mmm/`; TPO's code stays where it was and is only reused, never copied.

```
mmm/
  routes.tsx         every /mmm/* route, mounted in App.tsx as {mmmRoutes()}
  nav.ts             MMM's routes, sidebar rail and brand
  store.ts           shared filter scope (year, quarter, month, week, date range,
                     channels, promotion type, event) and currency across MMM pages
  kpiDeck.ts         the hub's headline three KPIs and the six a reader can add
  hooks.ts           react-query hooks for every /api/mmm/* endpoint
  types.ts           payload types, one per backend module
  schema.ts          the column contract (mirror of backend/app/mmm/schema.py),
                     upload rules, template rows, client-side header check
  catalog.ts         MMM's connector catalogue (TPO's CATALOG, MMM's truth)

  pages/
    MmmInsights.tsx     Insights Hub — KPIs (Revenue, Ad Spend, ROAS + addable), trend,
                        YAGO/PAGO/MAGO comparison, events, promotions, baseline, channels
    MmmCalendar.tsx     Media Calendar — channel x month flighting, month detail
    MmmReports.tsx      Report Center over MMM's reports (shared ReportCenterPage)
    MmmConnections.tsx  Data Connections — strip, guide, catalogue, upload
    MmmSettings.tsx     Settings (shared SettingsPage) + MMM dataset card

  components/
    MmmShell.tsx            AppShell configured for MMM (rail, brand, padlock, top bar)
    RequireMmmDataset.tsx   the gate on MMM's own dataset status
    MmmDataRequirements.tsx "What do I upload?" — every column, template download
    MmmUploadModal.tsx      upload with in-browser column check; view / replace / remove
    MmmSourceBrowser.tsx    Azure / Databricks — browse, check, install one blob or table
    MmmColumnMapper.tsx     "your column -> MMM's column", for a header that is not ours
                            (one file at a time, with a switcher for a delivery)
    MmmSyncStatus.tsx       the Live pill: pull the connected source again
    MmmSyncSummary.tsx      what that sync changed (days, period, channels: before -> now)
    MmmToolbar.tsx          year + currency controls (Calendar)
    MmmFilterBar.tsx        the Insights Hub filter bar and More Filters panel (TPO's layout)
    MmmAddKpiMenu.tsx       Add KPI, as TPO's
    MmmPanels.tsx           comparison, events, promotion type and baseline cards
    charts.tsx              trend (revenue, spend, baseline, ROAS), columns, share bars
```

## Loading data

Four connectors do something today, as TPO's four do:

  * **Excel / Shared Drives** — one daily file, installed through
    `POST /api/mmm/dataset`.
  * **Azure Blob** and **Databricks** — browse the account or Unity Catalog,
    check the columns, install one blob or one table. The browse requests go
    through TPO's own hooks (`hooks/useDatasets.ts`); the install goes to MMM's
    routes, which write MMM's data folder and never TPO's star schema.
  * **Power BI** — signs in and lists workspaces. It installs no dataset, on
    either module.

A HEADER THAT IS NOT OURS IS MAPPED, NOT REFUSED. `backend/app/mmm/mapping.py`
proposes which of the file's columns stands for each of MMM's and says which
pass found it (our own name, a synonym, a channel under another spend word, a
misspelling, or a spend column read as a channel of its own). A name that could
mean two channels — `Print`, `OOH`, `Social` — is never guessed at: the reader
is asked. Only the confirmed mapping is installed.

ONE TABLE, BUT IT CAN ARRIVE IN SEVERAL FILES. TPO installs six DIFFERENT
tables as a set and makes you reset first. MMM has one table, so a selection of
several files — or several blobs, or several warehouse tables — is several
PERIODS of it: "Jan-Mar", "Apr-Jun", "Jul-Sep", out of order, with a month
nobody cut and a boundary day re-sent. `backend/app/mmm/day_union.py` merges
them on the day, making the same three decisions TPO's `app/fact_union.py`
makes about its fact table:

  * SCHEMA — a column only some files have is dropped and reported, never
    filled with zeros. A channel that looks switched off for one quarter moves
    its whole response curve, and so every Budget Optimizer recommendation.
  * OVERLAP — a day in two files is counted once and the later period wins. A
    disagreement is counted separately from a harmless re-send, because a
    conflict is a data problem the reader should know they have.
  * COVERAGE — a month nobody sent is an absent month, not zero spend, and the
    upload screen says so BEFORE the install (`CoveragePanel`).

Whatever comes out of the merge is validated by the code a single upload goes
through, so a delivery can never be judged by looser rules than one file. Any
install then replaces what was loaded.

EACH FILE KEEPS ITS OWN MAPPING. A client who renamed a column half way
through the year is the ordinary case, so the mapping is keyed by filename and
one file's names are never applied to another's columns — the API refuses a
flat mapping sent with several files rather than guessing.

A SOURCE INSTALL CAN BE PULLED AGAIN. The connection, EVERY blob or table of
the delivery and the confirmed mappings are saved
(`backend/app/mmm/source_sync.py`), so the Live pill in the top bar re-reads
the same selection the same way and picks up the days added since. An upload or
a reset clears that record — a file on a laptop cannot be re-read.

## The data contract

One daily file, matched on its column headers (reference: `MMM_Final_Daily_Dataset.csv`,
33 columns). **Required:** `Date`, `Revenue`, and at least one `*_Spend` column.
Everything else is optional; `Month`, `Quarter`, `Week_of_Year` and `Year` are derived
from `Date` when missing. Uploading a new file replaces the loaded one. MMM's file is
stored in its own subfolder of `Data/` (`Data/mmm/`, or `$MMM_DATA_DIR`), apart from TPO's six star files.

## What the figures are

Revenue and ad spend are sums of the upload. **Baseline Revenue, Incremental Revenue and
ROAS are estimates**, from one formula in `backend/app/mmm/baseline.py`:

    X = avg daily revenue, ad spend > 0 and Holiday, Trending, Promotion flags all 1
    Y = avg daily revenue, ad spend = 0 and all three flags 1
    R = avg daily revenue, ad spend > 0 and all three flags 0
    Z = X − Y                     revenue from ad spend, per day
    baseline per day = R − Z      × days in range = baseline revenue
    ROAS = (revenue − baseline revenue) ÷ ad spend

It is **re-estimated for every range**: the filter scope, each comparison period, and each
trend bucket. Any new MMM module must call `baseline.Engine(...).estimate(mask)` rather than
reuse a figure. A range with no day of one kind is widened a week either side at a time until it
has one, and the page says so. The period filters (year, quarter, month, week, date range) set the
baseline's days. The promotion-type and event filters only narrow the days it is applied to. The
channel filter sets what counts as ad spend (`backend/app/mmm/scope.py`).
