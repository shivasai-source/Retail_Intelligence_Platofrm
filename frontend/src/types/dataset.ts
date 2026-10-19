// Mirrors backend/app/dataset_store.py's stored records and profile shape.

export interface DatasetSummary {
  id: string
  filename: string
  owner: string
  size_bytes: number
  rows: number
  column_count: number
  uploaded_at: number
}

export type ColumnKind = 'numeric' | 'categorical' | 'datetime' | 'text'

export interface DatasetColumn {
  name: string
  dtype: string
  kind: ColumnKind
  null_count: number
  unique_count: number
  // numeric
  min?: number | string | null
  max?: number | string | null
  mean?: number | null
  median?: number | null
  std?: number | null
  p25?: number | null
  p75?: number | null
  // categorical
  top_values?: { value: string | number | null; count: number }[]
}

export interface DatasetProfile {
  rows: number
  column_count: number
  columns: DatasetColumn[]
  sample_rows: Record<string, string | number | boolean | null>[]
}

export interface DatasetDetail extends DatasetSummary {
  profile: DatasetProfile
}

// One of the six star-schema tables, written into the Data/ folder the TPO
// loader reads. Mirrors backend/app/star_dataset.py.
export type StarRole = 'fact' | 'product' | 'geo_store' | 'channel' | 'promotion' | 'date'

export interface StarInstalledFile {
  role: StarRole
  filename: string
  original_name: string
  matched_by: string
  size_bytes: number
  /** On a sync only: rows now and before, size before, and whether the
   *  content changed (null when there was no earlier copy). */
  rows?: number
  previous_rows?: number | null
  previous_size_bytes?: number | null
  changed?: boolean | null
}

export interface StarInstallResult {
  installed: StarInstalledFile[]
  /** Canonical filenames that already existed and were overwritten. */
  replaced: string[]
  /** Fact rows the reloaded store holds — null when nothing was installed. */
  rows: number | null
  data_dir: string
  /** What merging several sales files did. Absent for a single-file upload. */
  union?: StarUnionStats
}

export interface StarStatusFile {
  role: StarRole
  label: string
  filename: string
  /** Columns the loader reads from this table — what identifies it. */
  required_columns: string[]
  /** Columns read when present and never required. */
  optional_columns?: string[]
  /** False for a dimension the loader derives when it is absent, so an empty
   *  slot is not a gap the user has to fill. Older payloads omit it. */
  required?: boolean
  present: boolean
  size_bytes: number
  modified_at: number | null
}

export interface StarStatus {
  data_dir: string
  files: StarStatusFile[]
  complete: boolean
  /** Every required table present — uploading is closed until a reset. */
  locked: boolean
}

/** How the last pull from the connected source went. */
export interface SourceSync {
  /** ISO timestamp (UTC). */
  at: string
  ok: boolean
  /** Fact rows loaded — null when the sync failed. */
  rows: number | null
  previous_rows: number | null
  error: string | null
}

/** Where the loaded dataset came from — never includes the stored token.
 *  See backend/app/source_sync.py. */
export interface SourceStatus {
  kind: 'azure' | 'databricks' | null
  /** True when the data can be pulled again from its source. */
  syncable: boolean
  label: string | null
  /** Storage account, or Databricks workspace URL. */
  origin: string | null
  items: string[]
  saved_at: string | null
  last_sync: SourceSync | null
  syncing: boolean
}

/** What a loaded dataset covers -- see `snapshot` in backend/app/star_dataset.py. */
export interface DataSnapshot {
  rows: number
  first_day: string | null
  last_day: string | null
  weeks: number
  products: number
  stores: number
  channels: number
  promotions: number
}

export interface SourceSyncResult {
  rows: number
  previous_rows: number
  source: string
  last_sync: SourceSync
  /** The data before the sync (null when nothing was loaded) and after it. */
  before: DataSnapshot | null
  after: DataSnapshot | null
  /** The tables the sync wrote, with their sizes. */
  installed?: StarInstalledFile[]
}

/** A window of rows from one installed table, for the View panel. */
export interface StarPreview {
  role: StarRole
  label: string
  filename: string
  columns: string[]
  rows: Record<string, string>[]
  /** Total data rows in the file, not just those returned. */
  row_count: number
  offset: number
  limit: number
  size_bytes: number
  modified_at: number
}

export interface StarResetResult {
  /** Canonical filenames actually deleted. */
  removed: string[]
  data_dir: string
}

export interface UploadResult {
  datasets: DatasetSummary[]
  errors: { filename: string; error: string }[]
  /** Present when the upload included star-schema files. */
  star: StarInstallResult | null
}

// ===== Azure Blob Storage source =====
// The same six tables as the Excel connector, reached from a storage account.
// Credentials are passed per request; a successful install saves them for
// syncing (backend/app/source_sync.py) — see
// backend/app/azure_blob.py.

export interface AzureContainer {
  name: string
}

export interface AzureBlob {
  /** Full blob name, including any virtual-folder prefix. The address. */
  name: string
  /** Just the part below the folder being viewed — what the list shows. */
  display_name: string
  size_bytes: number
  modified: string
}

export interface AzureBlobListing {
  container: string
  prefix: string
  /** Virtual subfolders at this level, as full prefixes ending in '/'. */
  folders: string[]
  files: AzureBlob[]
  /** Azure cut the listing short — more blobs exist than are shown. */
  truncated: boolean
}

/** One file in an inspect result, matched to a table by its header. */
export interface StarInspectFile {
  filename: string
  role: StarRole | null
  label: string | null
  missing_columns: string[]
  recognised: boolean
  /** How the role was decided: 'column headers' (the file already uses our
   *  names), 'recognised column names' (reached through an alias) or
   *  'chosen by you'. Null for a file that matched nothing. */
  matched_by?: string | null
  /** canonical column -> the file's own column standing for it. */
  mapping?: Record<string, string>
  /** canonical column -> 'exact' (already our name), 'alias' (a synonym) or
   *  'chosen' (the user said so). Drives how settled each row looks. */
  mapping_sources?: Record<string, string>
  /** Columns the mapping displaced: the file carried a canonical name and
   *  something else was mapped onto it. Two columns cannot share a name. */
  dropped_columns?: string[]
  /** Every column the file carries, as uploaded. Present even when the file
   *  was not recognised — it is what the mapping screen offers to choose from. */
  columns?: string[]
  /** Up to three DISTINCT example values per column. The only way to tell
   *  Base_Price from Actual_Price by eye, which no name check can do — and
   *  several values rather than one because on an unpromoted row the two are
   *  equal, so a single example proved nothing. */
  samples?: Record<string, string[]>
}

/** What the user has settled for one file on the mapping screen: the table it
 *  is, and canonical column -> that file's own column. Sent alongside the
 *  files on both inspect and upload — see backend/app/column_mapping.py. */
export interface StarColumnMapping {
  filename: string
  role: StarRole | null
  columns: Record<string, string>
}

export interface StarInspectResult {
  files: StarInspectFile[]
  missing_roles: {
    role: StarRole
    label: string
    required_columns: string[]
    /** False for a dimension the loader derives; not a blocker. */
    required?: boolean
  }[]
  ready: boolean
  /** Empty when ready; otherwise names exactly what is wrong. */
  message: string
  locked: boolean
  /** Present only when several sales files were selected — what they add up
   *  to, for the user to confirm before anything is installed. */
  coverage?: StarCoverage
}

/** What a multi-file sales delivery spans, and where it is thin.
 *  Mirrors backend/app/fact_union.py. */
export interface StarCoverage {
  files: {
    filename: string
    rows: number
    first: string
    last: string
    missing_columns: string[]
    unreadable: boolean
  }[]
  first: string
  last: string
  weeks: number
  rows_delivered: number
  /** Runs of absent weeks, each already phrased ("weeks 41-44 of 2024").
   *  A missing week is NOT zero sales — it is no data at all, and nothing
   *  downstream would flag it. */
  gaps: string[]
  /** Files whose periods touch the same week, so rows will be de-duplicated. */
  overlaps: string[]
  /** Columns dropped for not being present in every file. */
  dropped_columns: string[]
}

/** What merging several sales files actually did. Empty for a single file. */
export interface StarUnionStats {
  files: number
  rows_in: number
  rows_out: number
  duplicates_removed: number
  conflicts: number
  dropped_columns: string[]
}

// ===== Databricks Unity Catalog source =====
// The same six tables again, this time as catalog tables rather than files.
// Browsing is metadata-only; data moves once, at install. Credentials are sent
// per request; a successful install saves them for syncing — see
// backend/app/source_sync.py.

export interface DbxCatalog {
  name: string
  comment: string
}

export interface DbxSchema {
  name: string
  comment: string
}

export interface DbxTable {
  name: string
  table_type: string
  comment: string
  /** Column names, supplied by Unity Catalog with the listing — this is what
   *  identifies a table's star role, with no query and no data read. */
  columns: string[]
}

export interface DbxTableListing {
  catalog: string
  schema_name: string
  tables: DbxTable[]
}

/** A table the user has picked, fully qualified. `schema_name` rather than
 *  `schema` because Pydantic reserves the latter on the backend model. */
export interface DbxTableSel {
  catalog: string
  schema_name: string
  name: string
}
