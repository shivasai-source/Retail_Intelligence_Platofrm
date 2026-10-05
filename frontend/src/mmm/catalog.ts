import { CATALOG, type CatalogEntry } from '../components/portal/catalog'

// THE MMM MODULE'S CONNECTOR CATALOGUE — TPO's catalogue, with MMM's truth
// written over it.
//
// FOUR TILES OPEN; THE OTHER TWENTY-THREE SAY "Soon". The line is drawn by what
// each connector can actually do for MMM today:
//
//   excel       FUNCTIONAL. Opens MmmUploadModal, which checks the file's
//               columns in the browser and installs it through
//               POST /api/mmm/dataset (backend/app/mmm/dataset.py) — MMM's own
//               installer and data folder, never TPO's Data/.
//
//   powerbi     FUNCTIONAL. PowerBiModal signs in with MSAL and reads
//               /api/proxy/powerbi. It installs nothing, on either module, so it
//               is reused verbatim.
//
//   azure-blob  BROWSE ONLY. Authenticating and listing is generic and reused
//   databricks  (MmmSourceBrowser drives the same hooks TPO's modals use). Their
//               INSTALL half is TPO's star-schema installer, which MMM must not
//               reach; an MMM install from these sources is not built yet, so
//               the browser says so and stops.
//
//   everything  SOON. No backend at all, for TPO or MMM.
//   else
//
// Derived from CATALOG rather than copied, so a connector added to the
// platform's catalogue appears on both modules' pages and the two can never
// list different sources.

/** Tiles whose TPO description names the six-table star schema. Reworded for
 *  MMM; every other description is source-generic and carried across. */
const MMM_DESCRIPTIONS: Record<string, string> = {
  excel:
    'Upload the daily MMM file — date, revenue and spend per media channel — as .csv, .xlsx or .xls. Columns are matched on their headers, so the file name does not matter.',
  'azure-blob':
    'Browse containers and blobs in an Azure storage account — authenticated with a SAS token — to find the daily MMM extract.',
  databricks:
    'Browse Unity Catalog catalogs, schemas and tables over a SQL warehouse endpoint to find the daily MMM table.',
  powerbi:
    'Sign in with your Microsoft account to list the workspaces, dashboards and reports the platform can read alongside your marketing data.',
}

/** What each open MMM tile opens. A connector absent here stays `planned`. */
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
    // `portalKey` names an INITIAL_CONNECTORS entry whose modal installs TPO's
    // star schema, so it stays undefined on every MMM tile.
    portalKey: undefined,
    // TPO's convention: absent = "the file dialog", set = "the account
    // dialog". ConnectorTile reads it to label the action row.
    special: opens === 'upload' ? undefined : opens,
  }
})
