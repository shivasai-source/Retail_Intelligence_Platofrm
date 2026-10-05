import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { Button } from '../../components/ui'
import { Icon } from '../../icons'
import { ConnectionsCatalog } from '../../components/connections/ConnectionsCatalog'
import { DatasetStrip } from '../../components/connections/DatasetStrip'
import { CATEGORY_ORDER, type CatalogEntry } from '../../components/portal/catalog'
import { PowerBiModal } from '../../components/portal/modals/PowerBiModal'
import { INITIAL_CONNECTORS } from '../../components/portal/connectors'
import { MMM_CATALOG, MMM_OPENS, type MmmOpens } from '../catalog'
import { MMM_ROUTES } from '../nav'
import { useMmmStatus } from '../hooks'
import { MmmShell } from '../components/MmmShell'
import { MmmSourceBrowser } from '../components/MmmSourceBrowser'
import { MmmUploadModal } from '../components/MmmUploadModal'
import { MmmDataRequirements } from '../components/MmmDataRequirements'

// MMM — DATA CONNECTIONS. The same page TPO's Data Connections is — the shell,
// the dataset strip, the search box, the family filter and the tile grid all
// come from the same components — over MMM's own dataset:
//
//   * the strip reads GET /api/mmm/dataset (what is loaded, from which file);
//   * "What do I upload?" opens MMM's requirements guide, which also opens on
//     its own while nothing is loaded, until the reader asks it not to —
//     exactly TPO's behaviour, with its own remembered setting;
//   * Excel / Shared Drives opens MMM's upload dialog, which installs into
//     MMM's data folder; Azure and Databricks browse; Power BI signs in.

const GUIDE_MUTED_KEY = 'mmm.dataGuide.muted'

function guideMuted(): boolean {
  try {
    return Boolean(localStorage.getItem(GUIDE_MUTED_KEY))
  } catch {
    return false
  }
}

function setGuideMuted(muted: boolean) {
  try {
    if (muted) localStorage.setItem(GUIDE_MUTED_KEY, '1')
    else localStorage.removeItem(GUIDE_MUTED_KEY)
  } catch {
    /* not remembered */
  }
}

const PBI_CONNECTOR = INITIAL_CONNECTORS.find((c) => c.key === 'pbi')!

export function MmmConnections() {
  const navigate = useNavigate()
  const { data: status } = useMmmStatus()
  const [modal, setModal] = useState<MmmOpens | 'requirements' | null>(null)
  const [guideAuto, setGuideAuto] = useState(false)

  const complete = Boolean(status?.complete)
  const statusKnown = status !== undefined

  useEffect(() => {
    if (!statusKnown || complete || modal !== null || guideMuted()) return
    setGuideAuto(true)
    setModal('requirements')
    // Only the first settled status matters; later changes must not reopen it.
  }, [statusKnown]) // eslint-disable-line react-hooks/exhaustive-deps

  const connected: ReadonlySet<string> = new Set(complete ? ['excel'] : [])

  const openTile = (entry: CatalogEntry) => {
    if (entry.status !== 'available') return
    const opens = MMM_OPENS[entry.id]
    if (opens) setModal(opens)
  }

  const close = () => {
    setModal(null)
    setGuideAuto(false)
  }

  const available = MMM_CATALOG.filter((c) => c.status === 'available').length

  return (
    <MmmShell activeKey="connections" page="Data Connections">
      <div className="fade-in mb-5">
        <h1>Data Connections</h1>
        <p className="mt-1.5 text-base text-ink-muted">
          {available} of {MMM_CATALOG.length} sources connect to MMM today — the rest are in the catalog so
          the landscape stays visible.
        </p>
      </div>

      <DatasetStrip
        complete={complete}
        present={status?.present ?? 0}
        total={status?.total ?? 0}
        unit="column groups"
        headline={
          complete
            ? status?.source_name
              ? `Dataset loaded from ${status.source_name}`
              : 'Dataset loaded'
            : 'No dataset loaded yet'
        }
        body={
          complete && status
            ? `${status.rows.toLocaleString()} days (${status.period.from} – ${status.period.to}) across ${status.media_channels} media channels. Upload another file at any time to replace it.`
            : 'MMM reads one daily file — date, revenue and spend per media channel. Upload it through Excel / Shared Drives to unlock the Insights Hub, Calendar and Reports.'
        }
        action={
          <>
            <Button variant={complete ? 'ghost' : 'secondary'} onClick={() => setModal('requirements')}>
              <Icon name="book" /> {complete ? 'Data requirements' : 'What do I upload?'}
            </Button>
            {complete && (
              <Button variant="primary" onClick={() => navigate(MMM_ROUTES.insights)}>
                Continue to Insights Hub <Icon name="arrowRight" />
              </Button>
            )}
          </>
        }
      />

      <ConnectionsCatalog
        catalog={MMM_CATALOG}
        categoryOrder={CATEGORY_ORDER}
        connectedIds={connected}
        onOpenTile={openTile}
      />

      {modal === 'requirements' && (
        <MmmDataRequirements
          onClose={close}
          onStartUpload={() => {
            setGuideAuto(false)
            setModal('upload')
          }}
          autoOpened={guideAuto}
          onDontShowAgain={setGuideMuted}
        />
      )}
      {modal === 'upload' && <MmmUploadModal onClose={close} />}
      {(modal === 'azure' || modal === 'databricks') && <MmmSourceBrowser mode={modal} onClose={close} />}
      {modal === 'powerbi' && (
        <PowerBiModal
          connector={PBI_CONNECTOR}
          onClose={close}
          onConnected={() => {
            /* Power BI installs no dataset, on either module. */
          }}
        />
      )}
    </MmmShell>
  )
}
