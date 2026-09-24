import type { ConnectorSpecial } from '../../types/portal'

// THE CONNECTOR CATALOG, ported from transorg-engineering/connector-template
// (lib/connectors/catalog.ts + the per-provider `ConnectorDef` headers).
//
// The template is a Next.js app whose 25 providers each carry a real `connect()`
// against their own SDK. This platform's backend is the FastAPI one in backend/
// and is unchanged: it installs a six-table star schema from an upload, from an
// Azure container or from a Databricks table, and it reads Power BI workspaces.
// So the catalog is the template's LANDSCAPE with this backend's TRUTH written
// over it — the four sources that really connect are `available`, and every
// other template provider is carried at `planned`, greyed out and refusing to
// open a dialog.
//
// That is the template's own `stub()` convention, and its reason holds here: an
// honest "Soon" beats a tile that fails after you have typed credentials into
// it. Promoting one is a one-line change — give it a `portalKey` and flip
// `status` — once a connector exists behind it.

export type ConnectorFamily = 'object' | 'tabular'
export type ConnectorStatus = 'available' | 'planned'

export interface CatalogEntry {
  id: string
  label: string
  family: ConnectorFamily
  category: string
  description: string
  /** Two-letter fallback for when ConnectorLogo has no brand mark registered. */
  mark: string
  status: ConnectorStatus
  /**
   * The INITIAL_CONNECTORS key whose modal this tile opens. Set on every
   * `available` entry and on no `planned` one — that pairing is what makes a
   * tile clickable, so the two can never drift apart.
   */
  portalKey?: string
  /** Which dialog the tile raises. Absent means the upload dialog. */
  special?: ConnectorSpecial
}

/** Display order for the catalog's sections. */
export const CATEGORY_ORDER = [
  'Object storage',
  'Warehouse',
  'Database',
  'SaaS',
  'BI & reporting',
] as const

/* ------------------------------------------------------------------ object family */

/** Paths, folders and bytes. */
const OBJECT_CONNECTORS: CatalogEntry[] = [
  {
    id: 'excel',
    label: 'Excel / Shared Drives',
    family: 'object',
    category: 'Object storage',
    description:
      'Upload the six core tables as .csv, .xlsx or .xls straight from your machine. Files are matched on their column headers, so their names do not matter.',
    mark: 'XL',
    status: 'available',
    portalKey: 'xls',
  },
  {
    id: 'azure-blob',
    label: 'Azure Blob Storage',
    family: 'object',
    category: 'Object storage',
    description:
      'Browse containers and blobs in an Azure storage account — authenticated with a SAS token — and install the star schema from the ones you pick.',
    mark: 'AZ',
    status: 'available',
    portalKey: 'azure',
    special: 'azure',
  },
  {
    id: 'local-fs',
    label: 'Local filesystem',
    family: 'object',
    category: 'Object storage',
    description:
      'Browse and edit files in a directory on the machine running this app. No credentials needed.',
    mark: 'FS',
    status: 'planned',
  },
  {
    id: 's3',
    label: 'Amazon S3',
    family: 'object',
    category: 'Object storage',
    description:
      'Browse, upload, download and delete objects in an S3 bucket. Works with any S3-compatible endpoint — MinIO, Cloudflare R2, Wasabi.',
    mark: 'S3',
    status: 'planned',
  },
  {
    id: 'gcs',
    label: 'Google Cloud Storage',
    family: 'object',
    category: 'Object storage',
    description:
      'Browse, upload, download and delete objects in a GCS bucket, authenticated with a service account key or the ambient GCP credentials.',
    mark: 'GS',
    status: 'planned',
  },
  {
    id: 'gdrive',
    label: 'Google Drive',
    family: 'object',
    category: 'Object storage',
    description:
      'Browse a shared Drive folder, upload and download files, and export Google Docs and Sheets to Office formats.',
    mark: 'GD',
    status: 'planned',
  },
  {
    id: 'onedrive',
    label: 'OneDrive / SharePoint',
    family: 'object',
    category: 'Object storage',
    description:
      'Browse a SharePoint document library or a user’s OneDrive through Microsoft Graph — upload, download, rename and delete.',
    mark: 'OD',
    status: 'planned',
  },
  {
    id: 'dropbox',
    label: 'Dropbox',
    family: 'object',
    category: 'Object storage',
    description:
      'Browse, upload, download, rename and delete files in a Dropbox account or team space, with chunked uploads for large files.',
    mark: 'DB',
    status: 'planned',
  },
  {
    id: 'box',
    label: 'Box',
    family: 'object',
    category: 'Object storage',
    description:
      'Browse a Box folder, upload and download files, rename and move items, and delete to the trash — authenticated as a JWT or Client Credentials app.',
    mark: 'BX',
    status: 'planned',
  },
  {
    id: 'sftp',
    label: 'SFTP / FTPS',
    family: 'object',
    category: 'Object storage',
    description:
      'Browse, upload, download, rename and delete files on any SSH server — the universal fallback when no dedicated connector fits.',
    mark: 'SF',
    status: 'planned',
  },
]

/* ------------------------------------------------------------------ warehouses */

/** Analytical engines. All of these speak SQL. */
const WAREHOUSE_CONNECTORS: CatalogEntry[] = [
  {
    id: 'databricks',
    label: 'Databricks',
    family: 'tabular',
    category: 'Warehouse',
    description:
      'Browse Unity Catalog catalogs, schemas and tables over a SQL warehouse endpoint, and install the star schema from the tables you pick.',
    mark: 'DX',
    status: 'available',
    portalKey: 'databricks',
    special: 'databricks',
  },
  {
    id: 'snowflake',
    label: 'Snowflake',
    family: 'tabular',
    category: 'Warehouse',
    description:
      'Query and modify Snowflake tables from the app — browse the schema, filter rows, and run guarded inserts, updates and deletes.',
    mark: 'SN',
    status: 'planned',
  },
  {
    id: 'bigquery',
    label: 'BigQuery',
    family: 'tabular',
    category: 'Warehouse',
    description:
      'Browse datasets, filter rows and run guarded DML against BigQuery, with a per-query byte cap so a stray SELECT * cannot run up a bill.',
    mark: 'BQ',
    status: 'planned',
  },
  {
    id: 'redshift',
    label: 'Amazon Redshift',
    family: 'tabular',
    category: 'Warehouse',
    description:
      'Browse Redshift tables — including Spectrum external tables — filter and sort rows, and run guarded inserts, updates and deletes.',
    mark: 'RS',
    status: 'planned',
  },
]

/* ------------------------------------------------------------------ databases */

/** Operational stores. */
const DATABASE_CONNECTORS: CatalogEntry[] = [
  {
    id: 'postgres',
    label: 'PostgreSQL',
    family: 'tabular',
    category: 'Database',
    description:
      'Browse tables, filter and sort rows, and insert, edit or delete records in any PostgreSQL database — including Supabase, Neon and RDS.',
    mark: 'PG',
    status: 'planned',
  },
  {
    id: 'mysql',
    label: 'MySQL / MariaDB',
    family: 'tabular',
    category: 'Database',
    description:
      'Full row-level CRUD against MySQL, MariaDB, PlanetScale or Aurora MySQL — browse tables, filter, edit cells and delete records.',
    mark: 'MY',
    status: 'planned',
  },
  {
    id: 'sqlserver',
    label: 'SQL Server',
    family: 'tabular',
    category: 'Database',
    description:
      'Browse tables and views in Microsoft SQL Server or Azure SQL, filter and sort rows, and run guarded inserts, updates and deletes.',
    mark: 'MS',
    status: 'planned',
  },
  {
    id: 'clickhouse',
    label: 'ClickHouse',
    family: 'tabular',
    category: 'Database',
    description:
      'Browse columnar tables over the ClickHouse HTTP interface, filter and sort rows, and run guarded mutations.',
    mark: 'CH',
    status: 'planned',
  },
  {
    id: 'mongodb',
    label: 'MongoDB',
    family: 'tabular',
    category: 'Database',
    description:
      'Browse collections as tables with a schema sampled from the documents themselves — filter, sort, edit fields and delete documents.',
    mark: 'MG',
    status: 'planned',
  },
  {
    id: 'elasticsearch',
    label: 'Elasticsearch',
    family: 'tabular',
    category: 'Database',
    description:
      'Browse an index as rows with columns read from its mapping — filter and sort with the query DSL, and bulk-index or delete documents.',
    mark: 'ES',
    status: 'planned',
  },
]

/* ------------------------------------------------------------------ SaaS record sources */

/** Record APIs — fixed object types, their own query dialects, hard rate limits. */
const SAAS_CONNECTORS: CatalogEntry[] = [
  {
    id: 'gsheets',
    label: 'Google Sheets',
    family: 'tabular',
    category: 'SaaS',
    description:
      'Treat each tab of a spreadsheet as a table — browse rows, edit cells in place, append new rows and delete existing ones.',
    mark: 'GS',
    status: 'planned',
  },
  {
    id: 'airtable',
    label: 'Airtable',
    family: 'tabular',
    category: 'SaaS',
    description:
      'Browse tables in an Airtable base, filter and sort records, and create, edit or delete them in batches through a personal access token.',
    mark: 'AT',
    status: 'planned',
  },
  {
    id: 'salesforce',
    label: 'Salesforce',
    family: 'tabular',
    category: 'SaaS',
    description:
      'Browse standard and custom objects, filter and sort records with SOQL pushed down to the org, and create, edit or delete records in batches.',
    mark: 'SC',
    status: 'planned',
  },
  {
    id: 'hubspot',
    label: 'HubSpot',
    family: 'tabular',
    category: 'SaaS',
    description:
      'Browse contacts, companies, deals and custom objects from the CRM, with filters and sorting pushed down to HubSpot’s search API.',
    mark: 'HS',
    status: 'planned',
  },
  {
    id: 'notion',
    label: 'Notion',
    family: 'tabular',
    category: 'SaaS',
    description:
      'Browse Notion databases as tables — read every property type, edit cells in place, add pages and archive them.',
    mark: 'NO',
    status: 'planned',
  },
  {
    id: 'jira',
    label: 'Jira',
    family: 'tabular',
    category: 'SaaS',
    description:
      'Browse a Jira project’s issues as rows — filter and sort them, edit summaries, labels and descriptions in place, create issues and delete them.',
    mark: 'JR',
    status: 'planned',
  },
]

/* ------------------------------------------------------------------ BI & reporting */

// Not a template category. Power BI is this platform's own connector and is
// neither a warehouse nor a record API, so it gets its own section rather than
// being filed somewhere it does not belong.
const BI_CONNECTORS: CatalogEntry[] = [
  {
    id: 'powerbi',
    label: 'Power BI',
    family: 'tabular',
    category: 'BI & reporting',
    description:
      'Sign in with your Microsoft account to list the workspaces, dashboards and reports the platform can read alongside your promotion data.',
    mark: 'BI',
    status: 'available',
    portalKey: 'pbi',
    special: 'powerbi',
  },
]

/** Every connector the catalog knows about. */
export const CATALOG: CatalogEntry[] = [
  ...OBJECT_CONNECTORS,
  ...WAREHOUSE_CONNECTORS,
  ...DATABASE_CONNECTORS,
  ...SAAS_CONNECTORS,
  ...BI_CONNECTORS,
]
