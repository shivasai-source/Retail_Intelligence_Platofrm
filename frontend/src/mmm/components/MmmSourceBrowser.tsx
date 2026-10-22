import { useState } from 'react'
import { Button, Field, Input, Modal, Spinner, useToast } from '../../components/ui'
import { Icon } from '../../icons'
import { InstallProgress } from '../../components/portal/modals/InstallProgress'
import { fmtSize } from '../../lib/portalConnectors'
import { ApiError } from '../../lib/api'
import {
  useAzureBlobs,
  useAzureContainers,
  useAzureInstallProgress,
  useDbxCatalogs,
  useDbxSchemas,
  useDbxTables,
} from '../../hooks/useDatasets'
import {
  useMmmAzureInspect,
  useMmmAzureInstall,
  useMmmDbxInspect,
  useMmmDbxInstall,
  useMmmStatus,
} from '../hooks'
import { checkFromInspect, MEDIA_CHANNELS, type MmmHeaderCheck } from '../schema'
import type { MmmDeliveryInspect, MmmInstallResult } from '../types'
import { CoveragePanel, GroupChecklist } from './MmmUploadModal'
import { MmmColumnMapper } from './MmmColumnMapper'

// MMM — AZURE BLOB STORAGE AND DATABRICKS. Sign in, browse what is there, pick
// the daily table and install it, exactly as the Excel connector installs an
// uploaded file.
//
// WHY THIS EXISTS RATHER THAN REUSING AzureDatasetModal / DatabricksModal.
// Those two are STAR-SCHEMA installers: everything after their browse step
// writes TPO's Data/ folder through `star_dataset.install()`. Opening either
// from MMM would import an MMM file into TPO's dataset. So the BROWSE requests
// go through the very hooks those modals use (hooks/useDatasets.ts — same
// routes, same credential handling, nothing re-implemented), and the install
// goes to MMM's own routes (POST /api/mmm/dataset/{azure,databricks}/install,
// backend/app/mmm/sources.py), which write MMM's data folder and never TPO's.
//
// ONE TABLE, SEVERAL PERIODS. MMM reads a single daily table, so a selection
// of several blobs or tables is several PERIODS of it — "Jan-Mar", "Apr-Jun" —
// merged on the day by the server (backend/app/mmm/day_union.py) exactly as a
// multi-file upload is. Not TPO's "six or nothing": nothing here is six
// different tables. Installing replaces whatever was loaded, the same rule the
// upload dialog follows, and the WHOLE selection is remembered so the Live
// pill pulls every period again.
//
// THE COLUMNS ARE CHECKED BEFORE ANYTHING IS INSTALLED, and by the same
// contract a file is checked against: the inspect step reads a blob's header
// (256 KB) or Unity Catalog's column list (no query at all), and the answer is
// drawn with the upload dialog's own checklist.
//
// AND A SOURCE THAT USES ITS OWN COLUMN NAMES IS MAPPED, NOT REFUSED — the
// same screen the upload dialog shows (MmmColumnMapper), over the same
// proposal from the same server rules. The confirmed mapping is SAVED with the
// connection, so every later sync reads the source the same way (see
// app/mmm/source_sync.py).
//
// CREDENTIALS ARE NOT KEPT IN THE BROWSER. They are held in component state
// for the life of the dialog and sent with each request; nothing is written to
// localStorage, so closing the dialog forgets them here. A SUCCESSFUL INSTALL
// does save the connection on the SERVER, which is what lets the Live pill
// pull the same source again (app/mmm/source_sync.py) — the same trade TPO's
// connectors make, with the same mitigation: connect with a read-only token
// that expires. An upload or a reset clears that record.

type Mode = 'azure' | 'databricks'

const TITLE: Record<Mode, string> = {
  azure: 'Azure Blob Storage',
  databricks: 'Databricks',
}

/** What MMM can read from this source — a blob must be a file it can parse. */
const READABLE = /\.(csv|xlsx|xls)$/i

/** A blob is picked by its path within the container; the server names the
 *  file it read by its basename. */
const basename = (name: string) => name.split('/').pop() ?? name

function Row({
  label,
  sub,
  selected,
  disabled,
  onClick,
  icon,
}: {
  label: string
  sub?: string
  selected?: boolean
  disabled?: boolean
  onClick: () => void
  icon: 'folder' | 'file' | 'database'
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className={`flex w-full items-center gap-2.5 rounded-[var(--r-md)] p-[8px_12px] text-left transition-colors duration-150 ${
        selected ? 'bg-brand-violet-50' : 'hover:bg-surface-muted'
      } ${disabled ? 'cursor-not-allowed opacity-55 hover:bg-transparent' : ''}`}
    >
      <Icon
        name={icon === 'folder' ? 'layers' : icon === 'file' ? 'file' : 'database'}
        className="h-4 w-4 shrink-0 text-ink-muted"
      />
      <span className="min-w-0 flex-1">
        <span className="block truncate text-base text-ink-primary">{label}</span>
        {sub && <span className="block truncate text-2xs text-ink-muted">{sub}</span>}
      </span>
      {selected && <Icon name="check" className="h-4 w-4 shrink-0 text-[var(--pill-success-ink)]" />}
    </button>
  )
}

export function MmmSourceBrowser({ mode, onClose }: { mode: Mode; onClose: () => void }) {
  const { show } = useToast()
  const status = useMmmStatus()

  // --- credentials, held for the life of the dialog only
  const [account, setAccount] = useState('')
  const [sas, setSas] = useState('')
  const [workspaceUrl, setWorkspaceUrl] = useState('')
  const [token, setToken] = useState('')
  const [error, setError] = useState<string | null>(null)

  // --- browsing: the same hooks TPO's modals call
  const azContainers = useAzureContainers()
  const azBlobs = useAzureBlobs()
  const dbxCatalogs = useDbxCatalogs()
  const dbxSchemas = useDbxSchemas()
  const dbxTables = useDbxTables()

  // --- checking and installing: MMM's own routes
  const azInspect = useMmmAzureInspect()
  const azInstall = useMmmAzureInstall()
  const dbxInspect = useMmmDbxInspect()
  const dbxInstall = useMmmDbxInstall()

  // --- browse state
  const [containers, setContainers] = useState<string[] | null>(null)
  const [container, setContainer] = useState<string | null>(null)
  /** A SAS scoped to one container (sr=c) cannot enumerate the account, so the
   *  reader names the container instead. Normal, not an error — often the only
   *  kind of token someone who does not own the account can be given. */
  const [containerScoped, setContainerScoped] = useState(false)
  const [manualContainer, setManualContainer] = useState('')
  const [catalogs, setCatalogs] = useState<string[] | null>(null)
  const [catalog, setCatalog] = useState<string | null>(null)
  const [schemas, setSchemas] = useState<string[] | null>(null)
  const [schema, setSchema] = useState<string | null>(null)
  /** The blobs or tables chosen, in the order they were ticked. */
  const [picked, setPicked] = useState<string[]>([])
  const [check, setCheck] = useState<MmmHeaderCheck | null>(null)
  const [installed, setInstalled] = useState<MmmInstallResult | null>(null)
  /** The server's reading of the selection: one entry per file with its own
   *  mapping proposal, the coverage arithmetic, and whether the MERGED table
   *  would install. */
  const [inspection, setInspection] = useState<MmmDeliveryInspect | null>(null)
  /** The reader's confirmed renames, per file. */
  const [renames, setRenames] = useState<Record<string, Record<string, string>>>({})
  /** On the mapping screen rather than the browser. */
  const [mapping, setMapping] = useState(false)
  const [mappingFile, setMappingFile] = useState(0)

  // Each install run gets its own id, so the bar polls that run's bytes.
  const [progressId, setProgressId] = useState<string | null>(null)
  const progress = useAzureInstallProgress(progressId, azInstall.isPending)

  const creds = { account: account.trim(), sas: sas.trim() }
  const dbxCreds = { workspace_url: workspaceUrl.trim(), token: token.trim() }
  const inspecting = azInspect.isPending || dbxInspect.isPending
  const installing = azInstall.isPending || dbxInstall.isPending
  const busy =
    azContainers.isPending ||
    azBlobs.isPending ||
    dbxCatalogs.isPending ||
    dbxSchemas.isPending ||
    dbxTables.isPending

  const fail = (e: unknown) =>
    setError(
      e instanceof ApiError
        ? e.message
        : e instanceof Error
          ? e.message
          : "Couldn't reach the server — is the backend running?",
    )

  const clearPick = () => {
    setPicked([])
    setCheck(null)
    setInstalled(null)
    setInspection(null)
    setRenames({})
    setMapping(false)
    setMappingFile(0)
    setError(null)
  }

  const connect = () => {
    setError(null)
    clearPick()
    if (mode === 'azure') {
      azContainers.mutate(creds, {
        onSuccess: (r) => {
          setContainers(r.containers.map((c) => c.name))
          setContainerScoped(Boolean(r.container_scoped))
        },
        onError: fail,
      })
    } else {
      dbxCatalogs.mutate(dbxCreds, {
        onSuccess: (r) => setCatalogs(r.catalogs.map((c) => c.name)),
        onError: fail,
      })
    }
  }

  /** One level of a container. A container is its root prefix, so this walks
   *  into virtual subfolders too — without it a blob in `exports/2026/` could
   *  not be reached at all, which is most of how real accounts are laid out. */
  const openFolder = (name: string, prefix: string) => {
    clearPick()
    setContainer(name)
    azBlobs.mutate({ ...creds, container: name, prefix }, { onError: fail })
  }

  const openCatalog = (name: string) => {
    clearPick()
    setCatalog(name)
    setSchema(null)
    dbxSchemas.mutate(
      { ...dbxCreds, catalog: name },
      { onSuccess: (r) => setSchemas(r.schemas.map((s) => s.name)), onError: fail },
    )
  }

  const openSchema = (name: string) => {
    clearPick()
    setSchema(name)
    dbxTables.mutate({ ...dbxCreds, catalog: catalog ?? '', schema_name: name }, { onError: fail })
  }

  /** Ticking a file or a table checks the whole selection's columns straight
   *  away: that answer is what the Load button is enabled on, so it is never a
   *  later surprise. Un-ticking re-asks for what is left. */
  const pick = (name: string) => {
    const next = picked.includes(name) ? picked.filter((n) => n !== name) : [...picked, name]
    setCheck(null)
    setInspection(null)
    setInstalled(null)
    setRenames({})
    setMapping(false)
    setMappingFile(0)
    setError(null)
    setPicked(next)
    if (next.length) inspectWith(next, {})
  }

  /** Ask the server what this selection's columns mean, with the mappings
   *  tried on. Every edit on the mapping screen comes back through here, so
   *  the verdict is always the install's own rules rather than a second
   *  opinion.
   *
   *  `coverage` is asked for only when there are SEVERAL periods to reconcile,
   *  because it costs a full download of every file; one file has no spans to
   *  compare and its header is enough. */
  const inspectWith = (names: string[], withMapping: Record<string, Record<string, string>>) => {
    const took = (r: MmmDeliveryInspect) => {
      setCheck(checkFromInspect(r))
      setInspection(r)
    }
    const coverage = names.length > 1
    if (mode === 'azure') {
      azInspect.mutate(
        {
          ...creds,
          blobs: names.map((name) => ({ container: container ?? '', name })),
          mapping: withMapping,
          coverage,
        },
        { onSuccess: took, onError: fail },
      )
    } else {
      dbxInspect.mutate(
        {
          ...dbxCreds,
          tables: names.map((name) => ({
            catalog: catalog ?? '',
            schema_name: schema ?? '',
            name,
          })),
          mapping: withMapping,
          coverage,
        },
        { onSuccess: took, onError: fail },
      )
    }
  }

  const done = (result: MmmInstallResult) => {
    setInstalled(result)
    const from = picked.length > 1 ? ` (${picked.length} periods)` : ''
    show(
      `MMM dataset loaded from ${TITLE[mode]}${from} — ${result.rows.toLocaleString()} days, ${result.media_columns.length} channels.`,
      { duration: 4000 },
    )
  }

  const runInstall = (withMapping: Record<string, Record<string, string>> = renames) => {
    if (!picked.length) return
    setError(null)
    if (mode === 'azure') {
      const id =
        typeof crypto !== 'undefined' && 'randomUUID' in crypto
          ? crypto.randomUUID()
          : `${Date.now()}-${Math.random().toString(36).slice(2)}`
      setProgressId(id)
      azInstall.mutate(
        {
          ...creds,
          blobs: picked.map((name) => ({ container: container ?? '', name })),
          progress_id: id,
          mapping: withMapping,
        },
        { onSuccess: done, onError: fail },
      )
    } else {
      dbxInstall.mutate(
        {
          ...dbxCreds,
          tables: picked.map((name) => ({
            catalog: catalog ?? '',
            schema_name: schema ?? '',
            name,
          })),
          mapping: withMapping,
        },
        { onSuccess: done, onError: fail },
      )
    }
  }

  // REAL BYTES WHILE AZURE DOWNLOADS. A Databricks export reports nothing, so
  // its bar stays on the time-based estimate the strip draws by default.
  const measured = (() => {
    const p = progress.data
    if (!azInstall.isPending || !p) return null
    const mb = (n: number) => `${(n / (1024 * 1024)).toFixed(1)} MB`
    if (p.stage === 'downloading' && p.bytes_total > 0) {
      return {
        fraction: 0.85 * (p.bytes_done / p.bytes_total),
        label: 'Downloading from Azure',
        detail: `${mb(p.bytes_done)} of ${mb(p.bytes_total)}`,
      }
    }
    if (p.stage === 'installing') {
      return { fraction: 0.95, label: 'Checking every row', detail: 'Writing MMM’s data folder…' }
    }
    return null
  })()

  const signedIn = mode === 'azure' ? containers !== null : catalogs !== null
  const canConnect =
    mode === 'azure' ? creds.account !== '' && creds.sas !== '' : dbxCreds.workspace_url !== '' && dbxCreds.token !== ''
  const referenceFound = check
    ? check.media.filter((m) => (MEDIA_CHANNELS as readonly string[]).includes(m)).length
    : 0
  /** Files the install would skip as they stand. */
  const skipped = (inspection?.files ?? []).filter((f) => !f.ok)
  const needsMapping = Boolean(inspection) && (!check?.ok || skipped.length > 0)
  const loaded = Boolean(status.data?.complete)

  // THE MAPPING SCREEN, over the whole dialog: it is a decision about every
  // column in the source, and reading it beside a file list invites changing
  // the selection half way through.
  if (mapping && inspection && inspection.files.length) {
    const current = inspection.files[Math.min(mappingFile, inspection.files.length - 1)]
    return (
      <Modal open onClose={onClose} maxWidthClassName="max-w-[620px]">
        <div className="flex items-start justify-between gap-3 border-b border-border-subtle p-[16px_20px]">
          <div className="min-w-0">
            <h2 className="text-md font-medium">Match the source's columns to MMM's</h2>
            <p className="mt-0.5 truncate text-sm text-ink-muted" title={picked.join(', ')}>
              {picked.length > 1
                ? `${picked.length} ${mode === 'azure' ? 'files' : 'tables'} · each keeps its own column names`
                : picked[0]}{' '}
              · nothing is read until you confirm
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="grid h-7 w-7 shrink-0 place-items-center rounded-[var(--r-md)] text-ink-muted hover:bg-surface-muted [&_svg]:h-4 [&_svg]:w-4"
          >
            <Icon name="x" />
          </button>
        </div>
        {inspection.files.length > 1 && (
          <div className="flex flex-wrap items-center gap-1.5 border-b border-border-subtle px-5 py-2.5">
            {inspection.files.map((f, i) => (
              <button
                key={f.filename}
                type="button"
                onClick={() => setMappingFile(i)}
                className={`inline-flex max-w-[220px] items-center gap-1.5 rounded-[var(--r-pill)] border px-2.5 py-1 text-sm transition-colors [&_svg]:h-3.5 [&_svg]:w-3.5 [&_svg]:shrink-0 ${
                  i === mappingFile
                    ? 'border-brand-violet bg-brand-violet-50 text-brand-violet'
                    : 'border-border-subtle text-ink-secondary hover:border-brand-violet'
                }`}
                title={f.filename}
              >
                <Icon
                  name={f.ok ? 'check' : 'info'}
                  className={f.ok ? 'text-[var(--pill-success-ink)]' : 'text-[var(--pill-warning-ink)]'}
                />
                <span className="truncate">{f.filename}</span>
              </button>
            ))}
          </div>
        )}
        <MmmColumnMapper
          /* Remounted per file so the rows reset to THAT file's proposal
             rather than carrying the last one's choices across. */
          key={current.filename}
          inspection={current}
          busy={installing || inspecting}
          deliveryOk={inspection.ok}
          deliveryProblems={inspection.problems}
          onBack={() => setMapping(false)}
          onTry={(next) => {
            const merged = { ...renames, [current.filename]: next }
            setRenames(merged)
            if (picked.length) inspectWith(picked, merged)
          }}
          onConfirm={(next) => {
            const merged = { ...renames, [current.filename]: next }
            setRenames(merged)
            // More files still unmatched: move on rather than installing.
            const unmapped = inspection.files.findIndex(
              (f, i) => i !== mappingFile && !f.ok && !merged[f.filename],
            )
            if (unmapped >= 0) {
              setMappingFile(unmapped)
              if (picked.length) inspectWith(picked, merged)
              return
            }
            setMapping(false)
            runInstall(merged)
          }}
        />
        {error && (
          <div className="border-t border-border-subtle p-[12px_20px] text-sm leading-[1.55] text-[var(--pill-danger-ink)]">
            {error}
          </div>
        )}
      </Modal>
    )
  }

  return (
    <Modal open onClose={onClose} maxWidthClassName="max-w-[620px]">
      <div className="flex items-start justify-between gap-3 border-b border-border-subtle p-[16px_20px]">
        <div className="min-w-0">
          <h2 className="text-md font-medium">{TITLE[mode]}</h2>
          <p className="mt-0.5 text-sm text-ink-muted">
            {mode === 'azure'
              ? 'Browse a storage account and load the daily MMM data from it. Several files are read as several periods.'
              : 'Browse Unity Catalog and load the daily MMM data from it. Several tables are read as several periods.'}
          </p>
        </div>
        <button
          type="button"
          onClick={onClose}
          aria-label="Close"
          className="grid h-7 w-7 shrink-0 place-items-center rounded-[var(--r-md)] text-ink-muted hover:bg-surface-muted [&_svg]:h-4 [&_svg]:w-4"
        >
          <Icon name="x" />
        </button>
      </div>

      <div className="max-h-[60vh] overflow-y-auto p-[16px_20px]">
        {/* ---------------- INSTALLED ---------------- */}
        {installed ? (
          <>
            <div className="flex items-start gap-2 rounded-[var(--r-md)] bg-status-success-bg p-[10px_12px] text-sm leading-[1.5] text-[var(--pill-success-ink)] [&_svg]:mt-px [&_svg]:h-[15px] [&_svg]:w-[15px] [&_svg]:shrink-0">
              <Icon name="checkCircle" />
              <span>
                Every MMM page is now reading from{' '}
                {picked.length > 1 ? `these ${picked.length} periods` : picked[0]}. The Insights
                Hub, Calendar, Budget Optimizer and Reports are unlocked.
              </span>
            </div>
            <div className="mt-3 rounded-[var(--r-md)] bg-surface-muted p-[12px_14px] text-sm text-ink-secondary">
              {installed.rows.toLocaleString()} days · {installed.status.period.from} –{' '}
              {installed.status.period.to} · {installed.media_columns.length} media channels
            </div>
            {installed.warnings.length > 0 && (
              <div className="mt-3 rounded-[var(--r-md)] border border-border-subtle p-[10px_12px] text-xs leading-[1.5] text-ink-muted">
                {installed.warnings.map((w) => (
                  <div key={w}>{w}</div>
                ))}
              </div>
            )}
          </>
        ) : !signedIn ? (
          <>
            {mode === 'azure' ? (
              <>
                <Field label="Storage account">
                  <Input value={account} onChange={(e) => setAccount(e.target.value)} placeholder="mystorageaccount" />
                </Field>
                <div className="mt-3">
                  <Field label="SAS token">
                    <Input value={sas} onChange={(e) => setSas(e.target.value)} placeholder="sv=2022-11-02&ss=b&..." />
                  </Field>
                </div>
              </>
            ) : (
              <>
                <Field label="Workspace URL">
                  <Input
                    value={workspaceUrl}
                    onChange={(e) => setWorkspaceUrl(e.target.value)}
                    placeholder="https://adb-1234567890.1.azuredatabricks.net"
                  />
                </Field>
                <div className="mt-3">
                  <Field label="Personal access token">
                    <Input value={token} onChange={(e) => setToken(e.target.value)} placeholder="dapi..." />
                  </Field>
                </div>
              </>
            )}
            {/* SAID PLAINLY, because it is a security decision the reader is
                making: browsing keeps nothing, but LOADING data saves the
                connection so the Live pill can pull the source again. The
                same handling TPO's connectors use. */}
            <p className="mt-3 text-sm leading-[1.5] text-ink-muted">
              Browsing keeps nothing — credentials are sent with each request. If you load a
              dataset, this connection is saved on the server so the Live pill can pull the source
              again; use a read-only token that expires. Removing the dataset clears it.
            </p>
          </>
        ) : mode === 'azure' ? (
          <>
            {!container ? (
              containerScoped ? (
                /* A container-scoped token: ask which container it is for,
                   since the account cannot be enumerated with it. */
                <>
                  <div className="mb-2 flex items-start gap-2 rounded-[var(--r-md)] bg-surface-muted p-[10px_12px] text-sm leading-[1.5] text-ink-muted [&_svg]:mt-px [&_svg]:h-[15px] [&_svg]:w-[15px] [&_svg]:shrink-0">
                    <Icon name="info" />
                    <span>
                      This token is scoped to a single container, so the list of containers cannot be
                      read. Enter the container name it was created for.
                    </span>
                  </div>
                  <div className="flex gap-2">
                    <Input
                      value={manualContainer}
                      onChange={(e) => setManualContainer(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter' && manualContainer.trim()) openFolder(manualContainer.trim(), '')
                      }}
                      placeholder="container name"
                    />
                    <Button
                      variant="secondary"
                      onClick={() => openFolder(manualContainer.trim(), '')}
                      disabled={!manualContainer.trim() || busy}
                    >
                      Open
                    </Button>
                  </div>
                </>
              ) : (
                <>
                  <div className="mb-2 text-xs font-medium text-ink-muted">
                    Containers ({containers?.length ?? 0})
                  </div>
                  <div className="flex flex-col gap-1">
                    {containers?.map((c) => (
                      <Row key={c} label={c} icon="folder" onClick={() => openFolder(c, '')} />
                    ))}
                    {containers?.length === 0 && (
                      <div className="text-sm text-ink-muted">No containers visible to this SAS token.</div>
                    )}
                  </div>
                </>
              )
            ) : (
              <>
                {/* UP ONE LEVEL, not straight back to the containers: a blob is
                    usually several folders deep, and dropping the whole path on
                    every step back would make it unreachable in practice. */}
                <button
                  type="button"
                  onClick={() => {
                    const prefix = azBlobs.data?.prefix ?? ''
                    if (prefix) openFolder(container, prefix.replace(/[^/]+\/$/, ''))
                    else {
                      setContainer(null)
                      clearPick()
                    }
                  }}
                  className="mb-2 flex items-center gap-1 text-sm font-medium text-brand-violet [&_svg]:h-3.5 [&_svg]:w-3.5"
                >
                  <Icon name="chevronLeft" />{' '}
                  {azBlobs.data?.prefix ? 'Up one level' : containerScoped ? 'Another container' : 'All containers'}
                </button>
                <div className="mb-2 truncate text-xs font-medium text-ink-muted">
                  {container}/{azBlobs.data?.prefix ?? ''} · {azBlobs.data?.folders.length ?? 0} folders ·{' '}
                  {azBlobs.data?.files.length ?? 0} files
                </div>
                <div className="flex flex-col gap-1">
                  {azBlobs.data?.folders.map((f) => (
                    <Row
                      key={f}
                      label={f.replace(azBlobs.data?.prefix ?? '', '').replace(/\/$/, '')}
                      icon="folder"
                      onClick={() => openFolder(container, f)}
                    />
                  ))}
                  {azBlobs.data?.files.map((f) => (
                    <Row
                      key={f.name}
                      label={f.display_name}
                      sub={
                        READABLE.test(f.name)
                          ? fmtSize(f.size_bytes)
                          : `${fmtSize(f.size_bytes)} · MMM reads .csv, .xlsx and .xls`
                      }
                      icon="file"
                      selected={picked.includes(f.name)}
                      disabled={!READABLE.test(f.name) || installing}
                      onClick={() => pick(f.name)}
                    />
                  ))}
                  {azBlobs.data && !azBlobs.data.folders.length && !azBlobs.data.files.length && (
                    <div className="text-sm text-ink-muted">Nothing here.</div>
                  )}
                </div>
                {azBlobs.data?.truncated && (
                  <div className="mt-2 text-xs leading-[1.5] text-ink-muted">
                    Azure cut this listing short — more blobs exist than are shown. Open a subfolder to
                    narrow it.
                  </div>
                )}
              </>
            )}
          </>
        ) : (
          <>
            {!catalog ? (
              <>
                <div className="mb-2 text-xs font-medium text-ink-muted">
                  Catalogs ({catalogs?.length ?? 0})
                </div>
                <div className="flex flex-col gap-1">
                  {catalogs?.map((c) => (
                    <Row key={c} label={c} icon="database" onClick={() => openCatalog(c)} />
                  ))}
                </div>
              </>
            ) : !schema ? (
              <>
                <button
                  type="button"
                  onClick={() => setCatalog(null)}
                  className="mb-2 flex items-center gap-1 text-sm font-medium text-brand-violet [&_svg]:h-3.5 [&_svg]:w-3.5"
                >
                  <Icon name="chevronLeft" /> All catalogs
                </button>
                <div className="mb-2 text-xs font-medium text-ink-muted">
                  {catalog} · schemas ({schemas?.length ?? 0})
                </div>
                <div className="flex flex-col gap-1">
                  {schemas?.map((s) => (
                    <Row key={s} label={s} icon="folder" onClick={() => openSchema(s)} />
                  ))}
                </div>
              </>
            ) : (
              <>
                <button
                  type="button"
                  onClick={() => {
                    setSchema(null)
                    clearPick()
                  }}
                  className="mb-2 flex items-center gap-1 text-sm font-medium text-brand-violet [&_svg]:h-3.5 [&_svg]:w-3.5"
                >
                  <Icon name="chevronLeft" /> {catalog}
                </button>
                <div className="mb-2 text-xs font-medium text-ink-muted">
                  {catalog}.{schema} · {dbxTables.data?.tables.length ?? 0} tables
                </div>
                <div className="flex flex-col gap-1">
                  {dbxTables.data?.tables.map((t) => (
                    <Row
                      key={t.name}
                      label={t.name}
                      sub={`${t.columns.length} columns`}
                      icon="database"
                      selected={picked.includes(t.name)}
                      disabled={installing}
                      onClick={() => pick(t.name)}
                    />
                  ))}
                </div>
              </>
            )}
          </>
        )}

        {/* WHAT WAS PICKED AND WHETHER MMM CAN READ IT — the upload dialog's
            own checklist, because the contract is the same whether the columns
            arrived in a file, a blob or a warehouse table. */}
        {!installed && picked.length > 0 && (
          <div className="mt-3.5">
            {picked.map((name) => {
              // The server names each file by its BASENAME; an Azure blob is
              // picked by its path within the container.
              const own = inspection?.files.find((f) => f.filename === basename(name))
              const span = inspection?.coverage?.files.find((f) => f.filename === basename(name))
              return (
                <div key={name} className="mb-1.5 rounded-[var(--r-md)] bg-surface-muted p-[10px_12px]">
                  <div className="flex items-center gap-2.5">
                    <Icon
                      name={span?.unreadable ? 'x' : own ? (own.ok ? 'check' : 'info') : mode === 'azure' ? 'file' : 'database'}
                      className={`h-4 w-4 shrink-0 ${
                        span?.unreadable
                          ? 'text-[var(--pill-danger-ink)]'
                          : own?.ok
                            ? 'text-[var(--pill-success-ink)]'
                            : own
                              ? 'text-[var(--pill-warning-ink)]'
                              : 'text-ink-muted'
                      }`}
                    />
                    <span className="min-w-0 flex-1 truncate text-base font-medium" title={name}>
                      {name}
                    </span>
                    {!installing && (
                      <button
                        type="button"
                        onClick={() => pick(name)}
                        aria-label={`Remove ${name}`}
                        className="grid h-5 w-5 shrink-0 place-items-center rounded-full text-ink-muted hover:bg-status-danger-bg hover:text-[var(--pill-danger-ink)]"
                      >
                        <Icon name="x" className="h-3.5 w-3.5" />
                      </button>
                    )}
                  </div>
                  {span && !span.unreadable && (
                    <div className="mt-1 pl-[26px] text-xs text-ink-muted [font-variant-numeric:tabular-nums]">
                      {span.first} – {span.last} · {span.days.toLocaleString()} days
                      {span.missing_columns.length > 0 && (
                        <span className="text-[var(--pill-warning-ink)]">
                          {' '}· missing {span.missing_columns.join(', ')}
                        </span>
                      )}
                    </div>
                  )}
                </div>
              )
            })}
            {inspecting && (
              <div className="mt-2 flex items-center gap-2 pl-[26px] text-xs text-ink-muted">
                <Spinner className="h-3.5 w-3.5" />{' '}
                {picked.length > 1
                  ? 'Reading each one’s columns and period…'
                  : mode === 'azure'
                    ? 'Reading its column headers…'
                    : 'Reading its columns from Unity Catalog…'}
              </div>
            )}
            {inspection?.coverage && <CoveragePanel coverage={inspection.coverage} />}
            {check && (
              <GroupChecklist
                check={check}
                referenceFound={referenceFound}
                extraChannels={check.media.length - referenceFound}
              />
            )}
            {check && !check.ok && inspection && (
              <div className="mt-2.5 flex items-start gap-2 rounded-[var(--r-md)] bg-surface-muted p-[10px_12px] text-sm leading-[1.5] text-ink-muted [&_svg]:mt-px [&_svg]:h-[15px] [&_svg]:w-[15px] [&_svg]:shrink-0">
                <Icon name="info" />
                <span>
                  This source uses its own column names.{' '}
                  {inspection.files.every((f) => f.proposal.is_complete)
                    ? 'MMM has matched every column it needs — check the mapping and confirm it.'
                    : 'Match them to MMM’s columns and it can be loaded.'}{' '}
                  The mapping is saved with the connection, so a later sync reads it the same way.
                </span>
              </div>
            )}
            {check?.ok && loaded && (
              <div className="mt-2.5 flex items-start gap-2 rounded-[var(--r-md)] bg-surface-muted p-[10px_12px] text-xs leading-[1.5] text-ink-muted [&_svg]:mt-px [&_svg]:h-[14px] [&_svg]:w-[14px] [&_svg]:shrink-0">
                <Icon name="info" />
                <span>
                  This replaces the MMM dataset currently loaded. TPO's data is not touched.
                </span>
              </div>
            )}
          </div>
        )}

        <InstallProgress
          active={installing}
          estimateMs={mode === 'azure' ? 30_000 : 60_000}
          label={mode === 'azure' ? 'Downloading from Azure' : 'Exporting from Databricks'}
          note={
            picked.length > 1
              ? `All ${picked.length} periods are read, merged on the day, checked row by row, and written as MMM's single daily table.`
              : mode === 'azure'
                ? "The blob is downloaded, every row is checked, and MMM's data folder is rewritten."
                : "The table is exported to CSV on a SQL warehouse, every row is checked, and MMM's data folder is rewritten."
          }
          measured={measured}
        />

        {busy && (
          <div className="mt-3 flex items-center gap-2 text-sm text-ink-muted">
            <Spinner className="h-4 w-4" /> Contacting {TITLE[mode]}…
          </div>
        )}
        {error && (
          <div
            role="alert"
            className="mt-3 rounded-[var(--r-md)] bg-status-danger-bg p-[10px_12px] text-sm leading-[1.5] text-[var(--pill-danger-ink)]"
          >
            {error}
          </div>
        )}
      </div>

      <div className="flex items-center justify-between gap-3 border-t border-border-subtle p-[14px_20px]">
        <span className="text-sm text-ink-muted">
          {installed
            ? 'Dataset loaded'
            : !signedIn
              ? 'Not connected'
              : picked.length > 0
                ? `${picked.length} selected${
                    inspection?.coverage ? ` · ${inspection.coverage.days.toLocaleString()} days` : ''
                  }`
                : mode === 'azure'
                  ? container
                    ? 'Connected · tick the files to load'
                    : 'Connected · open a container'
                  : 'Connected · tick the tables to load'}
        </span>
        <div className="flex items-center gap-2">
          <Button variant="ghost" onClick={onClose}>
            {installed ? 'Done' : 'Close'}
          </Button>
          {!signedIn && (
            <Button variant="primary" onClick={connect} disabled={!canConnect || busy}>
              Connect
            </Button>
          )}
          {/* A FILE THAT WOULD BE SKIPPED MUST STILL REACH THE MAPPER. The
              delivery's verdict and a file's are different questions: three
              periods where the third uses the client's own names is a
              perfectly installable delivery, and offering no mapping route
              would skip that period behind a warning nobody has to read. So
              any file that is not ok puts Match columns on screen, beside
              Load rather than instead of it when the rest would install. */}
          {signedIn && !installed && picked.length > 0 && needsMapping && (
            <Button
              variant={check?.ok ? 'secondary' : 'primary'}
              onClick={() => {
                const first = inspection!.files.findIndex((f) => !f.ok)
                setMappingFile(first < 0 ? 0 : first)
                setMapping(true)
              }}
              disabled={inspecting || installing}
            >
              <Icon name="arrowRight" /> Match columns
            </Button>
          )}
          {signedIn && !installed && picked.length > 0 && (
            !needsMapping || check?.ok ? (
              <Button
                variant="primary"
                onClick={() => runInstall()}
                disabled={!check?.ok || installing || inspecting}
              >
                <Icon name="plus" />{' '}
                {installing
                  ? 'Loading dataset…'
                  : skipped.length > 0
                    ? `Load without ${skipped.length === 1 ? 'it' : 'them'}`
                    : picked.length > 1
                      ? `Load these ${picked.length} ${mode === 'azure' ? 'files' : 'tables'}`
                      : mode === 'azure'
                        ? 'Load this file'
                        : 'Load this table'}
              </Button>
            ) : null
          )}
        </div>
      </div>
    </Modal>
  )
}
