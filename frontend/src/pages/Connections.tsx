import { useMemo, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { AppShell } from '../components/layout/AppShell'
import { Button, Input, Pill } from '../components/ui'
import { Icon } from '../icons'
import { useStarStatus } from '../hooks/useDatasets'
import { CATALOG, CATEGORY_ORDER, type CatalogEntry } from '../components/portal/catalog'
import { ConnectorLogo } from '../components/portal/ConnectorLogo'
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
// THIS PAGE IS NOW THE FRONT DOOR. The portal's "Connected Data Sources" rail is
// gone and the TPO card lands here while the platform has no data, so this is
// the only screen a new user can act on — hence the dataset strip at the top,
// which says what is loaded and, once the six tables are in, points at the way
// out. Every other TPO page stays locked until then (see RequireDataset and the
// Sidebar's lock).

type FamilyFilter = 'all' | 'object' | 'tabular'

const FILTERS: Array<{ value: FamilyFilter; label: string }> = [
  { value: 'all', label: 'All sources' },
  { value: 'object', label: 'Files & objects' },
  { value: 'tabular', label: 'Tables & rows' },
]

const FAMILY_LABEL: Record<CatalogEntry['family'], string> = {
  object: 'Files & objects',
  tabular: 'Tables & rows',
}

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

  const [query, setQuery] = useState('')
  const [family, setFamily] = useState<FamilyFilter>('all')
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

  const visible = useMemo(() => {
    const q = query.trim().toLowerCase()
    return CATALOG.filter((c) => {
      if (family !== 'all' && c.family !== family) return false
      if (!q) return true
      return (
        c.label.toLowerCase().includes(q) ||
        c.description.toLowerCase().includes(q) ||
        c.category.toLowerCase().includes(q)
      )
    })
  }, [query, family])

  const grouped = useMemo(
    () =>
      CATEGORY_ORDER.map((category) => ({
        category,
        items: visible.filter((c) => c.category === category),
      })).filter((g) => g.items.length > 0),
    [visible],
  )

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
        sourceLabel={anyLoaded ? sourceLabel : null}
        onContinue={() => navigate('/command')}
      />

      <div className="mb-5 flex flex-col gap-3 sm:flex-row sm:items-center">
        <div className="relative sm:max-w-xs sm:flex-1">
          <Icon
            name="search"
            className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-ink-disabled"
          />
          <Input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search connectors…"
            className="pl-9"
            aria-label="Search connectors"
          />
        </div>

        <div className="flex items-center gap-1 rounded-[var(--r-lg)] border border-border-subtle bg-surface-card p-1">
          {FILTERS.map((f) => (
            <button
              key={f.value}
              type="button"
              onClick={() => setFamily(f.value)}
              aria-pressed={family === f.value}
              className={`rounded-[var(--r-md)] px-3 py-1 text-sm font-semibold transition-colors duration-150 ${
                family === f.value
                  ? 'bg-brand-violet text-white'
                  : 'text-ink-secondary hover:bg-surface-muted hover:text-ink-primary'
              }`}
            >
              {f.label}
            </button>
          ))}
        </div>
      </div>

      {grouped.length === 0 ? (
        <p className="rounded-[var(--r-xl)] border border-border-subtle bg-surface-card py-12 text-center text-base text-ink-muted">
          No connectors match “{query}”.
        </p>
      ) : (
        <div className="flex flex-col gap-7">
          {grouped.map(({ category, items }) => (
            <section key={category}>
              <div className="mb-3 flex items-center gap-2">
                <h3 className="text-xs font-bold uppercase tracking-wide text-ink-muted">{category}</h3>
                <span className="text-sm text-ink-muted">{items.length}</span>
              </div>

              <div className="grid grid-cols-4 gap-4 @max-[1240px]:grid-cols-3 @max-[900px]:grid-cols-2 @max-[620px]:grid-cols-1">
                {items.map((entry) => (
                  <ConnectorTile
                    key={entry.id}
                    entry={entry}
                    connected={connected.has(entry.id)}
                    onSelect={() => openTile(entry)}
                  />
                ))}
              </div>
            </section>
          ))}
        </div>
      )}

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

/** What the platform currently has, and the way out once it has enough. */
function DatasetStrip({
  complete,
  present,
  total,
  sourceLabel,
  onContinue,
}: {
  complete: boolean
  present: number
  total: number
  sourceLabel: string | null
  onContinue: () => void
}) {
  return (
    <div
      className={`fade-in-up mb-6 flex flex-wrap items-center gap-4 rounded-[var(--r-xl)] border p-[16px_20px] ${
        complete ? 'border-[#A7D8C4] bg-status-success-bg' : 'border-border-subtle bg-surface-card'
      }`}
    >
      <span
        className={`grid h-11 w-11 shrink-0 place-items-center rounded-[11px] [&_svg]:h-5 [&_svg]:w-5 ${
          complete ? 'bg-[#047857] text-white' : 'bg-tint-lavender text-tint-lavender-icon'
        }`}
      >
        <Icon name={complete ? 'checkCircle' : 'database'} />
      </span>

      <div className="min-w-[240px] flex-1">
        <div className="text-md font-bold">
          {complete
            ? sourceLabel
              ? `Dataset loaded from ${sourceLabel}`
              : 'Dataset loaded'
            : 'No dataset loaded yet'}
        </div>
        <p className="mt-0.5 text-base leading-[1.55] text-ink-muted">
          {complete
            ? 'Every module is unlocked. Connect another source at any time to replace the dataset.'
            : 'The platform reads six core tables and every KPI, chart and report is built from them. Connect a source below to unlock Insights Hub and the rest of TPO.'}
        </p>
      </div>

      <div className="flex shrink-0 items-center gap-3">
        <Pill tone={complete ? 'success' : 'neutral'} dot={complete}>
          {total ? `${present} of ${total} core tables` : 'Checking…'}
        </Pill>
        {complete && (
          <Button variant="primary" onClick={onContinue}>
            Continue to Insights Hub <Icon name="arrowRight" />
          </Button>
        )}
      </div>
    </div>
  )
}

function ConnectorTile({
  entry,
  connected,
  onSelect,
}: {
  entry: CatalogEntry
  connected: boolean
  onSelect: () => void
}) {
  const available = entry.status === 'available'

  return (
    <button
      type="button"
      onClick={onSelect}
      disabled={!available}
      title={
        available
          ? connected
            ? `Reconnect or browse ${entry.label}`
            : `Connect ${entry.label}`
          : `${entry.label} is in the catalog but not wired up yet`
      }
      className={[
        'flex h-full flex-col gap-3 rounded-[var(--r-xl)] border bg-surface-card p-4 text-left shadow-[var(--shadow-sm)]',
        'transition-[box-shadow,border-color,transform] duration-150',
        available
          ? 'cursor-pointer hover:-translate-y-px hover:shadow-[var(--shadow-md)] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--brand-violet)]'
          : 'cursor-not-allowed opacity-55',
        connected ? 'border-[#A7D8C4]' : 'border-border-subtle',
        available && !connected ? 'hover:border-brand-violet' : '',
      ].join(' ')}
    >
      <div className="flex items-start gap-3">
        <ConnectorLogo connectorId={entry.id} label={entry.label} mark={entry.mark} />
        <div className="min-w-0 flex-1">
          <div className="truncate text-base font-bold text-ink-primary">{entry.label}</div>
          <div className="mt-0.5 text-sm text-ink-muted">{FAMILY_LABEL[entry.family]}</div>
        </div>
        {!available ? (
          <Pill tone="neutral">Soon</Pill>
        ) : connected ? (
          <Pill tone="success" dot>
            Connected
          </Pill>
        ) : null}
      </div>

      <p className="line-clamp-3 text-sm leading-[1.55] text-ink-secondary">{entry.description}</p>

      {available && (
        <span className="mt-auto flex items-center gap-1.5 pt-1 text-sm font-bold text-brand-violet [&_svg]:h-3.5 [&_svg]:w-3.5">
          <Icon name={entry.special ? 'database' : 'plus'} />
          {connected ? 'Browse / reconnect' : entry.special ? 'Connect account' : 'Upload files'}
        </span>
      )}
    </button>
  )
}
