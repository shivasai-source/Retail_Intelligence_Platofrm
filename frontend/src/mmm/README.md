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
    MmmSourceBrowser.tsx    Azure / Databricks browse-only
    MmmToolbar.tsx          year + currency controls (Calendar)
    MmmFilterBar.tsx        the Insights Hub filter bar and More Filters panel (TPO's layout)
    MmmAddKpiMenu.tsx       Add KPI, as TPO's
    MmmPanels.tsx           comparison, events, promotion type and baseline cards
    charts.tsx              trend (revenue, spend, baseline, ROAS), columns, share bars
```

## The data contract

One daily file, matched on its column headers (reference: `MMM_Final_Daily_Dataset.csv`,
33 columns). **Required:** `Date`, `Revenue`, and at least one `*_Spend` column.
Everything else is optional; `Month`, `Quarter`, `Week_of_Year` and `Year` are derived
from `Date` when missing. Uploading a new file replaces the loaded one. MMM's file is
stored apart from TPO's `Data/` folder (`backend/.store/mmm/`, or `$MMM_DATA_DIR`).

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
