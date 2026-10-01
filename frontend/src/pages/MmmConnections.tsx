import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { AppShell } from '../components/layout/AppShell'
import { Button } from '../components/ui'
import { Icon } from '../icons'
import { ConnectionsCatalog } from '../components/connections/ConnectionsCatalog'
import { DatasetStrip } from '../components/connections/DatasetStrip'
import { CATEGORY_ORDER } from '../components/portal/catalog'
import { MMM_CATALOG, MMM_NAV, MMM_OPENS, mmmDatasetStatus } from '../components/connections/mmm'
import type { MmmOpens } from '../components/connections/mmm'
import { MmmSourceBrowser } from '../components/connections/MmmSourceBrowser'
import { PowerBiModal } from '../components/portal/modals/PowerBiModal'
import { INITIAL_CONNECTORS } from '../components/portal/connectors'
import type { CatalogEntry } from '../components/portal/catalog'

// MMM — DATA CONNECTIONS. The module's only screen, and the same page TPO's
// Data Connections is: the shell, the strip, the search box, the family filter,
// the category sections and the tile grid all come from the same components, so
// the two cannot drift apart visually.
//
// WHAT IS DIFFERENT IS THE TRUTH IT TELLS. Three tiles open -- Power BI, Azure
// Blob and Databricks -- and the other twenty-four say "Soon". The split is
// what each connector can actually do for MMM today, not what its tile looks
// like; mmm.ts traces the reasoning per connector. Nothing opened from here
// installs anything: MMM has no ingestion, so the counter stays at 0 and no
// dialog claims otherwise.
//
// THE BLOCK ORDER IS TPO'S, EXACTLY: title + subtitle, dataset strip, catalogue.
// An earlier revision added a "What MMM needs" card listing MMM_CORE_DATASETS
// between the strip and the catalogue. It was a block TPO's page does not have,
// which is the one thing this page must not invent — TPO does not enumerate its
// six tables here either (RequireDataset's gate does that). MMM_CORE_DATASETS
// still supplies the strip's denominator, and is where that list belongs when
// MMM grows a gate of its own.

/** No MMM source can be connected yet, so nothing is ever marked connected.
 *  Module-level so the catalogue's memo is not invalidated every render. */
const NO_CONNECTIONS: ReadonlySet<string> = new Set<string>()

/** Power BI's modal takes a PortalConnector for its header. Reused as-is --
 *  it reads workspaces and installs nothing, on either module. */
const PBI_CONNECTOR = INITIAL_CONNECTORS.find((c) => c.key === 'pbi')!

export function MmmConnections() {
  const navigate = useNavigate()
  // The same four facts TPO reads out of /api/datasets/star, for MMM. Today
  // every one of them is 0/false, and honestly so — see mmmDatasetStatus.
  const { present, total, complete } = mmmDatasetStatus()
  const [modal, setModal] = useState<MmmOpens | null>(null)

  // Only an `available` entry can open anything -- ConnectionsCatalog already
  // disables the rest, and this is the second guard so a future catalogue edit
  // cannot make a "Soon" tile raise a dialog.
  const openTile = (entry: CatalogEntry) => {
    if (entry.status !== 'available') return
    // MMM_OPENS, not `entry.special`: special is TPO's union and carries no
    // 'upload' member, so the catalogue encodes MMM's choice separately.
    const opens = MMM_OPENS[entry.id]
    if (opens) setModal(opens)
  }

  return (
    <AppShell
      activeKey="connections"
      crumbs={[{ label: 'MMM Intelligence' }, { label: 'Data Connections' }]}
      nav={MMM_NAV}
      brand="MMM Intelligence"
      brandHref="/home"
      datasetComplete={complete}
    >
      <div className="fade-in mb-5">
        <h1>Data Connections</h1>
        <p className="mt-1.5 text-base text-ink-muted">
          MMM reads marketing, sales, pricing, trade and external business data. None of the{' '}
          {MMM_CATALOG.length} catalogued sources connect to MMM yet — they are listed so the data
          landscape stays visible.
        </p>
      </div>

      {/* THE WAY ON, WIRED EXACTLY AS TPO WIRES IT. pages/Connections.tsx
          renders its "Continue to Insights Hub" button only when `complete` is
          true, and so does this: the button is the reward for a loaded dataset,
          not decoration. Today `complete` is false, so — as on TPO's page with
          an empty Data/ folder — no button renders. It appears on its own the
          day MMM data lands, with no edit here. */}
      <DatasetStrip
        complete={complete}
        present={present}
        total={total}
        unit="core datasets"
        headline={complete ? 'Dataset loaded' : 'No dataset loaded yet'}
        body={
          complete
            ? 'The MMM Insights Hub is unlocked. Connect another source at any time to replace the dataset.'
            : 'Connect your marketing, sales, pricing, trade and business data sources to power Market Mix & Marketing Intelligence. No MMM connector is wired up yet, so nothing below can be connected today.'
        }
        action={
          complete ? (
            <Button variant="primary" onClick={() => navigate('/mmm/insights')}>
              Continue to Insights Hub <Icon name="arrowRight" />
            </Button>
          ) : undefined
        }
      />

      <ConnectionsCatalog
        catalog={MMM_CATALOG}
        categoryOrder={CATEGORY_ORDER}
        connectedIds={NO_CONNECTIONS}
        onOpenTile={openTile}
      />

      {/* Power BI reused verbatim from TPO: same modal, same MSAL sign-in, same
          /api/proxy/powerbi routes. It lists workspaces and reports and writes
          no dataset, which is exactly as true for MMM as it is for TPO. */}
      {modal === 'powerbi' && (
        <PowerBiModal
          connector={PBI_CONNECTOR}
          onClose={() => setModal(null)}
          onConnected={() => {
            /* Nothing to record: Power BI installs no dataset, so MMM's counter
               must not move. TPO's page says the same in its own comment. */
          }}
        />
      )}

      {/* Azure and Databricks: the browse half of TPO's flow, through the same
          hooks, stopping before an install that would write TPO's Data/ folder. */}
      {/* Azure, Databricks and Excel: the usable half of TPO's flow -- real
          auth and browsing, or a real file picker that reads real headers --
          stopping before an install that would write TPO's Data/ folder. */}
      {(modal === 'azure' || modal === 'databricks' || modal === 'upload') && (
        <MmmSourceBrowser mode={modal} onClose={() => setModal(null)} />
      )}
    </AppShell>
  )
}
