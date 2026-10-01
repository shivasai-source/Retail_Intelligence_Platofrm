import { CATALOG, type CatalogEntry } from '../portal/catalog'

// THE MMM MODULE'S DATA CONNECTIONS CONFIG.
//
// Market Mix & Marketing Intelligence has no ingestion behind it. There is one
// dataset namespace on this backend — `/api/datasets/star`, the six TPO tables
// in backend/app/star_dataset.py — and files are identified by their column
// headers (Base_Quantity, Actual_Revenue, Promotion_Id). A media-spend export
// handed to it is rejected as unrecognised, correctly.
//
// THREE TILES OPEN; THE OTHER TWENTY-FOUR SAY "Soon". The line is drawn by what
// each connector can actually do for MMM *today*, traced through the code:
//
//   powerbi     FUNCTIONAL. PowerBiModal signs in with MSAL and reads
//               /api/proxy/powerbi/{workspaces,reports}. It installs nothing --
//               not for MMM and not for TPO either -- so it is module-agnostic
//               already and is reused verbatim.
//
//   azure-blob  PARTIAL. Authenticating and listing containers/blobs is generic
//   databricks  and reusable; the INSTALL half of AzureDatasetModal and
//               DatabricksModal is `star_dataset.install()` writing TPO's Data/
//               folder. So MMM opens MmmSourceBrowser, which drives the very
//               same hooks for the browse half and then stops, rather than
//               importing MMM files into TPO's dataset.
//
//   excel       PARTIAL. TPO's UploadModal posts to /api/datasets, which IS
//               `star_dataset.install()` writing TPO's Data/ folder -- so MMM
//               must not reach it. MmmSourceBrowser's upload mode opens the
//               real picker and reads each CSV's header row in the browser
//               (lib/starSchema.ts#readHeader, the same helper TPO's picker
//               uses), so you can see the columns the platform would receive.
//               It sends nothing: there is no MMM ingestion route to send to.
//
//   everything  SOON. No backend at all, for TPO or MMM.
//   else
//
// That is catalog.ts's own rule -- an honest "Soon" beats a tile that fails
// after you have typed credentials into it -- applied per connector rather than
// to the whole catalogue.

/** Tiles whose TPO description names the six-table star schema or promotion
 *  data. Reworded for MMM; every other description is source-generic and is
 *  carried across untouched. */
const MMM_DESCRIPTIONS: Record<string, string> = {
  excel:
    'Upload marketing, sales and pricing extracts as .csv, .xlsx or .xls straight from your machine. Files are matched on their column headers, so their names do not matter.',
  'azure-blob':
    'Browse containers and blobs in an Azure storage account — authenticated with a SAS token — and pick the media, sales and pricing extracts MMM reads.',
  databricks:
    'Browse Unity Catalog catalogs, schemas and tables over a SQL warehouse endpoint, and pick the media, sales and pricing tables MMM reads.',
  powerbi:
    'Sign in with your Microsoft account to list the workspaces, dashboards and reports the platform can read alongside your marketing and business data.',
}

/** The TPO catalogue's landscape, with MMM's truth written over it.
 *
 *  Derived from CATALOG rather than copied, so a connector added to the
 *  platform's catalogue appears on both modules' pages and the two can never
 *  drift into listing different sources. */
/** What each MMM tile opens. A connector absent from this map is `planned`,
 *  which is what keeps a tile inert -- the pairing CatalogEntry describes. */
export type MmmOpens = 'azure' | 'databricks' | 'powerbi' | 'upload'

export const MMM_OPENS: Record<string, MmmOpens> = {
  excel: 'upload',
  'azure-blob': 'azure',
  databricks: 'databricks',
  powerbi: 'powerbi',
}

export const MMM_CATALOG: CatalogEntry[] = CATALOG.map((entry) => {
  const opens = MMM_OPENS[entry.id]
  return {
    ...entry,
    description: MMM_DESCRIPTIONS[entry.id] ?? entry.description,
    status: opens ? ('available' as const) : ('planned' as const),
    // `portalKey` stays undefined even on an open tile: it names an
    // INITIAL_CONNECTORS entry whose modal installs TPO's star schema, and MMM
    // must not reach it.
    //
    // `special` follows TPO's own convention rather than carrying MMM's choice:
    // absent means "the file dialog", set means "the account dialog" (see
    // CatalogEntry). That is also what ConnectorTile reads to label its action
    // row, so Excel says "Upload files" and the other three say "Connect
    // account" exactly as on TPO. MMM_OPENS above is what actually decides
    // which dialog opens -- `ConnectorSpecial` is TPO's union and is not
    // widened for MMM.
    portalKey: undefined,
    special: opens === 'upload' ? undefined : opens,
  }
})

/** What MMM needs before it can model anything.
 *
 *  PROPOSED, NOT INSTALLED. TPO's six tables come from the backend, which
 *  defines their roles, their filenames and every column the loader reads.
 *  MMM has no such definition anywhere in this repository — it exists only as a
 *  roadmap tile — so this list is a statement of the data MMM requires, not a
 *  contract the backend enforces. It drives the counter and nothing else, and
 *  the counter reads 0 because no MMM source can be connected yet.
 *
 *  When MMM ingestion is built, this is the list its roles should be reconciled
 *  against — and the counter should move to the backend's status endpoint, the
 *  way TPO's reads `/api/datasets/star`. */
export interface MmmCoreDataset {
  key: string
  label: string
  detail: string
  /** Installed? Always false today — see mmmDatasetStatus below. Shaped like
   *  StarStatusFile.present so the readiness check reads the same on both
   *  modules and a real backend can fill it later without changing callers. */
  present: boolean
}

export const MMM_CORE_DATASETS: MmmCoreDataset[] = [
  {
    key: 'sales',
    label: 'Sales & revenue',
    detail: 'Units and revenue by product, market and period — what the mix is modelled against.',
    present: false,
  },
  {
    key: 'media-spend',
    label: 'Media spend',
    detail: 'Investment by channel, campaign, period and geography.',
    present: false,
  },
  {
    key: 'media-delivery',
    label: 'Media delivery',
    detail: 'Impressions, clicks, reach and frequency against that spend.',
    present: false,
  },
  {
    key: 'campaign-channel',
    label: 'Campaign & channel',
    detail: 'Campaign and media channel attributes the spend and delivery join to.',
    present: false,
  },
  {
    key: 'price-trade',
    label: 'Price & trade spend',
    detail: 'Price points, promotions and trade investment over the same periods.',
    present: false,
  },
  {
    key: 'product',
    label: 'Product & distribution',
    detail: 'Product attributes and distribution or availability by market.',
    present: false,
  },
  {
    key: 'geography',
    label: 'Market & geography',
    detail: 'The geographic hierarchy sales and media are reported against.',
    present: false,
  },
  {
    key: 'calendar',
    label: 'Calendar & external factors',
    detail: 'Seasonality, holidays, competitor activity and macro variables.',
    present: false,
  },
]

/** MMM's navigation — the module's rail, not just this page's.
 *
 *  ONE ROW PER PAGE THAT EXISTS, and no more. TPO's rail comes from
 *  GET /api/nav and lists the nine screens TPO actually has; MMM has two, so
 *  it lists two. A rail offering a Simulation or a Reports row would be
 *  advertising doors onto a wall — the same reason Sidebar padlocks TPO's rows
 *  when no dataset is loaded.
 *
 *  Order is TPO's: the hub first, then the screens that feed it, exactly as
 *  nav.json puts Insights Hub above Data Connections.
 *
 *  Shaped as NavData so it drops into the existing Sidebar unchanged. The rail
 *  is mounted with `datasetComplete` from mmmDatasetStatus(), so Insights Hub
 *  carries the same padlock TPO's rows carry until data is loaded — and
 *  `connections`, which is in Sidebar's ALWAYS_OPEN, stays reachable because it
 *  is the screen that clears the lock. Same rule, same rail, both modules. */
export const MMM_NAV = {
  navMain: [
    { key: 'insights', label: 'Insights Hub', icon: 'grid', route: '#/mmm/insights' },
    { key: 'connections', label: 'Data Connections', icon: 'database', route: '#/mmm/connections' },
  ],
  navSecondary: [],
}

/** MMM's readiness check — the same question `/api/datasets/star` answers for
 *  TPO, asked of MMM.
 *
 *  SHAPED LIKE TPO'S, DERIVED HONESTLY. StarStatus reports `files`, `present`,
 *  `total` and `complete`, and TPO's Data Connections strip, its sidebar lock
 *  and its RequireDataset gate all read those four. MMM's readers read the same
 *  four, so the two modules' flow is one flow written once.
 *
 *  WHAT IT IS NOT is a backend call, because there is no MMM backend. Every
 *  dataset is `present: false` and `complete` is false, and that is not a
 *  placeholder — it is the truth: `MMM_CATALOG` carries no `available`
 *  connector, so no MMM source can have delivered anything. The derivation is
 *  deliberately the catalogue rather than a hardcoded `false`, so the day a
 *  connector is promoted this stops lying on its own.
 *
 *  WHEN MMM INGESTION LANDS this becomes a react-query hook over the MMM
 *  status endpoint, exactly as hooks/useDatasets.ts#useStarStatus is. Its
 *  callers do not change. */
export interface MmmDatasetStatus {
  files: MmmCoreDataset[]
  present: number
  total: number
  complete: boolean
}

export function mmmDatasetStatus(): MmmDatasetStatus {
  // No connector can be connected, so nothing can be installed. Not a constant
  // `false` — this answer follows the catalogue.
  const reachable = MMM_CATALOG.some((c) => c.status === 'available')
  const files = MMM_CORE_DATASETS.map((d) => ({ ...d, present: reachable && d.present }))
  const present = files.filter((f) => f.present).length
  return { files, present, total: files.length, complete: present > 0 && present === files.length }
}
