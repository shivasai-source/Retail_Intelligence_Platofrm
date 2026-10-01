import { useMemo, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { AppShell } from '../components/layout/AppShell'
import { Button } from '../components/ui'
import { Icon } from '../icons'
import { useStarStatus } from '../hooks/useDatasets'
import { CATALOG, CATEGORY_ORDER, type CatalogEntry } from '../components/portal/catalog'
import { ConnectionsCatalog } from '../components/connections/ConnectionsCatalog'
import { DatasetStrip } from '../components/connections/DatasetStrip'
import { INITIAL_CONNECTORS } from '../components/portal/connectors'
import { UploadModal } from '../components/portal/modals/UploadModal'
import { AzureDatasetModal } from '../components/portal/modals/AzureDatasetModal'
import { DatabricksModal } from '../components/portal/modals/DatabricksModal'
import { PowerBiModal } from '../components/portal/modals/PowerBiModal'
import { loadAzureConn, loadDatasetSource, loadProxyConn, saveDatasetSource } from '../lib/portalConnectors'
import type { ConnectorSpecial } from '../types/portal'

// DATA CONNECTIONS — the catalog, and the one place data gets into the platform.
//
// Ported from transorg-engineering/connector-template (app/page.tsx +
// components/catalog-grid.tsx): search box, family filter, category sections and
// a tile grid whose unimplemented entries are greyed out rather than hidden.
// The template's Next.js server actions are not ported — clicking a live tile
// raises the dialog this app already has, against the FastAPI backend it already
// talks to. Nothing behind this page changed.
//
// THE CATALOGUE UI NOW LIVES IN components/connections/ and is shared with the
// MMM module's own Data Connections page. Only the things that are TPO's — the
// six-table star schema, the four dialogs that install it, the breadcrumb —
// are still here. The page renders what it always rendered.
//
// THIS PAGE IS THE FRONT DOOR. The portal's "Connected Data Sources" rail is
// gone and the TPO card lands here while the platform has no data, so this is
// the only screen a new user can act on — hence the dataset strip at the top,
// which says what is loaded and, once the six tables are in, points at the way
// out. Every other TPO page stays locked until then (see RequireDataset and the
// Sidebar's lock).

/** The connector a live tile hands off to, by INITIAL_CONNECTORS key. */
const portalConnector = (key: string) => INITIAL_CONNECTORS.find((c) => c.key === key)!

/** Saved sign-ins, read fresh whenever a dialog closes. */
function readSessions() {
  return {
    'azure-blob': loadAzureConn() !== null,
    databricks: loadProxyConn('databricks') !== null,
    powerbi: loadProxyConn('powerbi') !== null,
  } as Record<string, boolean>
}

export function Connections() {
  const navigate = useNavigate()
  const { data: starStatus } = useStarStatus()

  const [modal, setModal] = useState<ConnectorSpecial | 'upload' | null>(null)
  const [source, setSource] = useState<string | null>(() => loadDatasetSource())
  const [sessions, setSessions] = useState(readSessions)

  const present = starStatus?.files.filter((f) => f.present).length ?? 0
  const total = starStatus?.files.length ?? 0
  const complete = Boolean(starStatus?.complete)
  const anyLoaded = present > 0

  // A tile says "Connected" for one of two reasons: it is the connector the
  // installed star schema came from, or it holds a saved sign-in of its own
  // (Power BI never installs a dataset, so that is the only way it can).
  const connected = useMemo(() => {
    const ids = new Set<string>()
    for (const [id, on] of Object.entries(sessions)) if (on) ids.add(id)
    if (anyLoaded && source) {
      const entry = CATALOG.find((c) => c.portalKey === source)
      if (entry) ids.add(entry.id)
    }
    return ids
  }, [sessions, anyLoaded, source])

  const availableCount = CATALOG.filter((c) => c.status === 'available').length

  const closeModal = () => {
    setModal(null)
    // sessionStorage is not reactive, so the tiles learn about a new sign-in
    // here rather than on a timer.
    setSessions(readSessions())
  }

  // Only the three connectors that really install the star schema record
  // themselves as its source. Power BI reads workspaces and loads no tables, so
  // claiming it as the dataset's origin would be a lie the rail used to tell.
  const onConnected = (key: string) => () => {
    if (key === 'xls' || key === 'azure' || key === 'databricks') {
      saveDatasetSource(key)
      setSource(key)
    }
    setSessions(readSessions())
  }

  const openTile = (entry: CatalogEntry) => {
    if (entry.status !== 'available') return
    setModal(entry.special ?? 'upload')
  }

  const sourceLabel = source ? (CATALOG.find((c) => c.portalKey === source)?.label ?? null) : null
  const loadedFrom = anyLoaded ? sourceLabel : null

  return (
    <AppShell activeKey="connections" crumbs={[{ label: 'TPO Intelligence' }, { label: 'Data Connections' }]}>
      <div className="fade-in mb-5">
        <h1>Data Connections</h1>
        <p className="mt-1.5 text-base text-ink-muted">
          {availableCount} of {CATALOG.length} sources connect today — the rest are in the catalog so the
          landscape stays visible.
        </p>
      </div>

      <DatasetStrip
        complete={complete}
        present={present}
        total={total}
        unit="core tables"
        headline={
          complete
            ? loadedFrom
              ? `Dataset loaded from ${loadedFrom}`
              : 'Dataset loaded'
            : 'No dataset loaded yet'
        }
        body={
          complete
            ? 'Every module is unlocked. Connect another source at any time to replace the dataset.'
            : 'The platform reads six core tables and every KPI, chart and report is built from them. Connect a source below to unlock Insights Hub and the rest of TPO.'
        }
        action={
          complete ? (
            <Button variant="primary" onClick={() => navigate('/command')}>
              Continue to Insights Hub <Icon name="arrowRight" />
            </Button>
          ) : undefined
        }
      />

      <ConnectionsCatalog
        catalog={CATALOG}
        categoryOrder={CATEGORY_ORDER}
        connectedIds={connected}
        onOpenTile={openTile}
      />

      {modal === 'upload' && (
        <UploadModal connector={portalConnector('xls')} onClose={closeModal} onConnected={onConnected('xls')} />
      )}
      {modal === 'azure' && (
        <AzureDatasetModal connector={portalConnector('azure')} onClose={closeModal} onConnected={onConnected('azure')} />
      )}
      {modal === 'databricks' && (
        <DatabricksModal
          connector={portalConnector('databricks')}
          onClose={closeModal}
          onConnected={onConnected('databricks')}
        />
      )}
      {modal === 'powerbi' && (
        <PowerBiModal connector={portalConnector('pbi')} onClose={closeModal} onConnected={onConnected('pbi')} />
      )}
    </AppShell>
  )
}
