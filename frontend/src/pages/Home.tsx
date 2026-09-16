import { useEffect, useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { Dropdown, IconButton, ThemeToggle, useToast } from '../components/ui'
import { Icon } from '../icons'
import { useCurrentUser, useLogout } from '../hooks/useAuth'
import { useStarStatus } from '../hooks/useDatasets'
import { HeroArt } from '../components/portal/HeroArt'
import { ModuleGrid } from '../components/portal/ModuleGrid'
import { ConnectorRail } from '../components/portal/ConnectorRail'
import { INITIAL_CONNECTORS } from '../components/portal/connectors'
import { UploadModal } from '../components/portal/modals/UploadModal'
import { AzureDatasetModal } from '../components/portal/modals/AzureDatasetModal'
import { DatabricksModal } from '../components/portal/modals/DatabricksModal'
import { SapModal } from '../components/portal/modals/SapModal'
import { PowerBiModal } from '../components/portal/modals/PowerBiModal'
import { NielsenModal } from '../components/portal/modals/NielsenModal'
import { loadAzureConn, loadDatasetSource, saveDatasetSource } from '../lib/portalConnectors'
import type { ConnectorSpecial, PortalConnector } from '../types/portal'

// Connectors the portal does not offer. A DISPLAY choice and nothing more:
// the catalog in components/portal/connectors.ts still carries them, their
// modals and the /api/proxy endpoints behind them are untouched, and offering
// one again means only removing its key from here.
const HIDDEN_ON_HOME = new Set(['sap', 'niq', 'pbi'])

// Ported from home.html + js/portal.js's Portal.initHome(). Same topbar/hero/module
// grid/connector rail/advisor layout as the vanilla app, state-driven instead of
// direct DOM mutation.
export function Home() {
  const { data: user } = useCurrentUser()
  const { data: starStatus } = useStarStatus()
  const logout = useLogout()
  const navigate = useNavigate()
  const { show } = useToast()
  const [connectors, setConnectors] = useState<PortalConnector[]>(() =>
    INITIAL_CONNECTORS.filter((c) => !HIDDEN_ON_HOME.has(c.key)),
  )
  const [modal, setModal] = useState<ConnectorSpecial | 'upload' | null>(null)
  const [source, setSource] = useState<string | null>(() => loadDatasetSource())
  const [uploadTarget, setUploadTarget] = useState<PortalConnector | null>(null)

  // Reflect a saved Azure session (this browser tab) before first paint, same as
  // the vanilla app's renderConnectors().
  useEffect(() => {
    const saved = loadAzureConn()
    if (saved) {
      setConnectors((prev) => prev.map((c) => (c.key === 'azure' ? { ...c, on: true, detail: c.detail || 'Saved session' } : c)))
    }
  }, [])

  // Excel / Shared Drives reflects real ingested data, not a hardcoded flag.
  // The core star-schema tables in the Data/ folder are what it reports: those
  // are the files every dashboard and KPI actually reads, so "6 of 6 core
  // tables" is the honest description of the connection. Only the six count —
  // the upload route rejects anything else by name, so there is no such thing
  // as a standalone profiled upload to mention alongside them any more.
  useEffect(() => {
    if (!starStatus) return
    const present = starStatus.files.filter((f) => f.present).length
    const total = starStatus.files.length
    setConnectors((prev) =>
      prev.map((c) =>
        c.key === 'xls'
          ? { ...c, on: present > 0, detail: total ? `${present}/${total} core tables` : undefined }
          : c,
      ),
    )
  }, [starStatus])

  const updateConnector = (key: string, patch: Partial<PortalConnector>) => {
    setConnectors((prev) => prev.map((c) => (c.key === key ? { ...c, ...patch } : c)))
  }

  // Null unless a dataset is really installed, so a Reset silently retires the
  // remembered source rather than leaving the rail claiming a stale one.
  const presentCount = starStatus?.files.filter((f) => f.present).length ?? 0
  const totalCount = starStatus?.files.length ?? 0
  const anyLoaded = presentCount > 0
  const sourceConnector = anyLoaded ? connectors.find((c) => c.key === source) ?? null : null
  // Read from the star status rather than the connector's own label, so the
  // count is right even for a dataset loaded before the source was recorded.
  const sourceDetail = totalCount ? `${presentCount}/${totalCount} core tables` : null

  const closeModal = () => {
    setModal(null)
    setUploadTarget(null)
  }

  // Remember which connector the dataset came from — the backend stores the six
  // files but not their provenance, so the rail could not otherwise say.
  const onConnected = (key: string) => (detail: string) => {
    saveDatasetSource(key)
    setSource(key)
    updateConnector(key, { on: true, detail })
  }

  const signOut = () => {
    logout.mutate(undefined, { onSuccess: () => navigate('/login', { replace: true }) })
  }

  // RequireAuth (see App.tsx) only mounts this page once /auth/me has already
  // resolved, so this is effectively always populated — just a type-safety guard.
  if (!user) return null

  return (
    <div className="min-h-screen bg-surface-page">
      <header className="flex h-[72px] items-center gap-3 border-b border-border-subtle bg-surface-card px-4 sm:px-8">
        <Link to="/home" className="flex min-w-0 items-center gap-3">
          <img src="/image.png" alt="TransOrg" className="h-[34px] w-[34px] shrink-0" />
          <div className="min-w-0">
            <h1 className="truncate text-md leading-[1.25] sm:text-lg">Agentic CPG &amp; Retail Intelligence Platform</h1>
            <p className="mt-px hidden truncate text-sm text-ink-muted sm:block">Enterprise decision intelligence for FMCG/CPG</p>
          </div>
        </Link>
        <div className="flex-1" />
        <div className="flex shrink-0 items-center gap-1.5 sm:gap-2">
          <ThemeToggle />
          <IconButton icon="bell" onClick={() => show('No notifications yet — this is a fresh workspace.')} title="Notifications" />
          <IconButton icon="help" onClick={() => show('Help center coming soon.')} title="Help" />
          <Dropdown
            selected=""
            options={[{ label: `Signed in as ${user.email}`, value: 'noop' }, { label: 'Sign out' }]}
            onSelect={(val) => {
              if (val === 'noop') return
              signOut()
            }}
            trigger={
              <div
                className="grid h-9 w-9 shrink-0 cursor-pointer place-items-center rounded-full bg-[linear-gradient(135deg,#6B47FF,#8C6EFF)] text-sm font-bold text-white"
                title={user.name}
              >
                {user.initials}
              </div>
            }
          />
        </div>
      </header>

      <main className="mx-auto max-w-[1920px] p-[20px_16px_40px] sm:p-[34px_40px_64px]">
        <div className="fade-in-up mb-7 flex items-center justify-between gap-6">
          <div className="min-w-0 flex-1">
            {/* The person's name as they gave it -- capitals shout, and mangle
                names that are not meant to be uppercased. */}
            <h2 className="mb-2 text-xl font-extrabold tracking-[-0.02em] sm:text-2xl">Good to see you, {user.name}.</h2>
            <p className="max-w-[60ch] text-base leading-[1.6] text-ink-secondary">
              Trade Promotion Optimization is live — measure, diagnose and simulate every promotion against its baseline.
              Five more modules are on the roadmap.
            </p>
            {/* THE ONE THING TO DO on this page, said once as a button rather
                than left to the card grid to imply. */}
            <Link
              to="/command"
              className="mt-4 inline-flex h-10 items-center gap-2 rounded-[var(--r-md)] bg-brand-violet px-4 text-base font-semibold text-white no-underline shadow-[var(--shadow-violet)] transition-[background-color,transform] duration-150 hover:bg-brand-violet-600 motion-safe:hover:-translate-y-px focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-violet/60 [&_svg]:h-4 [&_svg]:w-4"
            >
              Open Trade Promotion Optimization
              <Icon name="arrowRight" />
            </Link>
          </div>
          <div className="hidden shrink-0 md:block">
            <HeroArt />
          </div>
        </div>

        <div className="grid grid-cols-[1fr_360px] items-start gap-6 @max-[1080px]:grid-cols-1">
          <ModuleGrid />

          <div className="flex flex-col gap-6">
            <ConnectorRail
              connectors={connectors}
              onOpenSpecial={(special) => setModal(special)}
              onOpenUpload={(c) => {
                setUploadTarget(c)
                setModal('upload')
              }}
              loaded={anyLoaded}
              sourceName={sourceConnector?.name ?? null}
              sourceDetail={sourceDetail}
            />
          </div>
        </div>
      </main>

      {modal === 'upload' && uploadTarget && <UploadModal connector={uploadTarget} onClose={closeModal} onConnected={onConnected('xls')} />}
      {modal === 'azure' && (
        <AzureDatasetModal connector={connectors.find((c) => c.key === 'azure')!} onClose={closeModal} onConnected={onConnected('azure')} />
      )}
      {modal === 'databricks' && (
        <DatabricksModal
          connector={connectors.find((c) => c.key === 'databricks')!}
          onClose={closeModal}
          onConnected={onConnected('databricks')}
        />
      )}
      {modal === 'sap' && <SapModal connector={connectors.find((c) => c.key === 'sap')!} onClose={closeModal} onConnected={onConnected('sap')} />}
      {modal === 'powerbi' && (
        <PowerBiModal connector={connectors.find((c) => c.key === 'pbi')!} onClose={closeModal} onConnected={onConnected('pbi')} />
      )}
      {modal === 'nielsen' && (
        <NielsenModal connector={connectors.find((c) => c.key === 'niq')!} onClose={closeModal} onConnected={onConnected('niq')} />
      )}
    </div>
  )
}
