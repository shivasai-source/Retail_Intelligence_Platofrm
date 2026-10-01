import { useState } from 'react'
import { Button, Field, Input, Modal, Spinner } from '../ui'
import { Icon } from '../../icons'
import { fmtSize } from '../../lib/portalConnectors'
import {
  useAzureBlobs,
  useAzureContainers,
  useDbxCatalogs,
  useDbxSchemas,
  useDbxTables,
} from '../../hooks/useDatasets'
// Header reading only. `matchHeader`/`classifyFiles` next to it in that module
// decide TPO's six roles and are deliberately NOT used here -- a media-spend
// export is not a star table and must not be graded as one.
import { readHeader } from '../../lib/starSchema'

// MMM — SOURCE BROWSER. Sign in to a storage account or a warehouse, browse
// what is actually there, and stop.
//
// WHY THIS EXISTS RATHER THAN REUSING AzureDatasetModal / DatabricksModal.
// Those two are star-schema INSTALLERS. Read their imports: `useAzureInspect`,
// `useAzureInstall`, `StarInspectResult`, `StarRole`, `MissingTables`,
// `StarFileViewer`, and a `useStarStatus()` panel listing the six installed
// tables. Their browse step is generic, but everything after it writes TPO's
// Data/ folder through `star_dataset.install()`. Opening either from MMM would
// either import MMM files into TPO's dataset — the one thing the brief forbids
// — or require inventing the MMM ingestion contract, which does not exist.
//
// SO THE MECHANISM IS REUSED, NOT THE INSTALLER. Every request below goes
// through the SAME hooks TPO's modals use (hooks/useDatasets.ts) and therefore
// the same FastAPI routes and the same credential handling: nothing is
// re-implemented, and no TPO file is touched. What is absent is the install
// call — there is nowhere honest to send the bytes yet.
//
// CREDENTIALS ARE NOT PERSISTED HERE. TPO's modals save a session so a tile can
// say "Connected"; this holds them in component state for the life of the
// dialog and drops them on close. A saved MMM sign-in would claim a standing
// connection to a module that cannot yet read anything through it.

type Mode = 'azure' | 'databricks' | 'upload'

const TITLE: Record<Mode, string> = {
  azure: 'Azure Blob Storage',
  databricks: 'Databricks',
  upload: 'Excel / Shared Drives',
}

/** THE UPLOAD MODE IS A FILE INSPECTOR, NOT AN UPLOADER.
 *
 *  TPO's UploadModal calls `useUploadDatasets` -> POST /api/datasets, and that
 *  route IS `star_dataset.install()`: it writes the six canonical CSVs into the
 *  Data/ folder the TPO loader reads, matched on TPO's column headers. Pointing
 *  MMM at it would import marketing files into TPO's dataset and silently
 *  replace the live promotion data -- which is the one outcome every version of
 *  this brief rules out.
 *
 *  So this mode stops one step short of that call. It opens the real file
 *  picker, and it does real work on what you choose: `readHeader` (the same
 *  helper lib/starSchema.ts exports for TPO's picker) reads each CSV's header
 *  row IN THE BROWSER, so you can see the columns the platform would receive.
 *  Nothing is sent anywhere. The moment an MMM ingestion route exists, this is
 *  where its call goes. */

/** The honest end of the road, shown once something is selected. */
function NotIngested({ kind, items }: { kind: string; items: string[] }) {
  return (
    <div className="mt-3.5 rounded-[var(--r-md)] border border-border-subtle bg-surface-muted p-[12px_14px]">
      <div className="flex items-start gap-2 [&_svg]:mt-px [&_svg]:h-[15px] [&_svg]:w-[15px] [&_svg]:shrink-0">
        <Icon name="info" />
        <div className="min-w-0">
          <div className="text-base font-bold text-ink-primary">
            {items.length} {kind}
            {items.length === 1 ? '' : 's'} selected — not imported
          </div>
          <p className="mt-0.5 text-sm leading-[1.5] text-ink-muted">
            MMM has no ingestion yet, so nothing was read, copied or installed. This browser
            confirms the platform can reach the source and see what is in it.
          </p>
          <ul className="mt-2 flex flex-col gap-1">
            {items.map((i) => (
              <li key={i} className="truncate text-sm text-ink-secondary" title={i}>
                {i}
              </li>
            ))}
          </ul>
        </div>
      </div>
    </div>
  )
}

function Row({
  label,
  sub,
  selected,
  onClick,
  icon,
}: {
  label: string
  sub?: string
  selected?: boolean
  onClick: () => void
  icon: 'folder' | 'file' | 'database'
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`flex w-full items-center gap-2.5 rounded-[var(--r-md)] p-[8px_12px] text-left transition-colors duration-150 ${
        selected ? 'bg-brand-violet-50' : 'hover:bg-surface-muted'
      }`}
    >
      <Icon
        name={icon === 'folder' ? 'layers' : icon === 'file' ? 'file' : 'database'}
        className="h-4 w-4 shrink-0 text-ink-muted"
      />
      <span className="min-w-0 flex-1">
        <span className="block truncate text-base text-ink-primary">{label}</span>
        {sub && <span className="block truncate text-2xs text-ink-muted">{sub}</span>}
      </span>
      {selected && <Icon name="check" className="h-4 w-4 shrink-0 text-[#047857]" />}
    </button>
  )
}

export function MmmSourceBrowser({ mode, onClose }: { mode: Mode; onClose: () => void }) {
  // --- credentials, held for the life of the dialog only
  const [account, setAccount] = useState('')
  const [sas, setSas] = useState('')
  const [workspaceUrl, setWorkspaceUrl] = useState('')
  const [token, setToken] = useState('')
  const [error, setError] = useState<string | null>(null)

  // --- the same hooks TPO's modals call
  const azContainers = useAzureContainers()
  const azBlobs = useAzureBlobs()
  const dbxCatalogs = useDbxCatalogs()
  const dbxSchemas = useDbxSchemas()
  const dbxTables = useDbxTables()

  // --- browse state
  const [containers, setContainers] = useState<string[] | null>(null)
  const [container, setContainer] = useState<string | null>(null)
  const [catalogs, setCatalogs] = useState<string[] | null>(null)
  const [catalog, setCatalog] = useState<string | null>(null)
  const [schemas, setSchemas] = useState<string[] | null>(null)
  const [schema, setSchema] = useState<string | null>(null)
  const [picked, setPicked] = useState<string[]>([])
  /** Local files the reader chose, with headers read in the browser. Never sent. */
  const [chosen, setChosen] = useState<Array<{ name: string; size: number; headers: string[] }>>([])

  const chooseFiles = async (list: FileList | null) => {
    setError(null)
    if (!list?.length) return
    const files = Array.from(list)
    const read = await Promise.all(
      files.map(async (f) => ({ name: f.name, size: f.size, headers: await readHeader(f) })),
    )
    setChosen(read)
  }

  const busy =
    azContainers.isPending ||
    azBlobs.isPending ||
    dbxCatalogs.isPending ||
    dbxSchemas.isPending ||
    dbxTables.isPending

  const fail = (e: unknown) => setError(e instanceof Error ? e.message : 'Request failed')
  const toggle = (name: string) =>
    setPicked((p) => (p.includes(name) ? p.filter((x) => x !== name) : [...p, name]))

  const connect = () => {
    setError(null)
    setPicked([])
    if (mode === 'azure') {
      azContainers.mutate(
        { account: account.trim(), sas: sas.trim() },
        { onSuccess: (r) => setContainers(r.containers.map((c) => c.name)), onError: fail },
      )
    } else {
      dbxCatalogs.mutate(
        { workspace_url: workspaceUrl.trim(), token: token.trim() },
        { onSuccess: (r) => setCatalogs(r.catalogs.map((c) => c.name)), onError: fail },
      )
    }
  }

  const openContainer = (name: string) => {
    setError(null)
    setContainer(name)
    setPicked([])
    azBlobs.mutate({ account: account.trim(), sas: sas.trim(), container: name, prefix: '' }, { onError: fail })
  }

  const openCatalog = (name: string) => {
    setError(null)
    setCatalog(name)
    setSchema(null)
    setPicked([])
    dbxSchemas.mutate(
      { workspace_url: workspaceUrl.trim(), token: token.trim(), catalog: name },
      { onSuccess: (r) => setSchemas(r.schemas.map((s) => s.name)), onError: fail },
    )
  }

  const openSchema = (name: string) => {
    setError(null)
    setSchema(name)
    setPicked([])
    dbxTables.mutate(
      { workspace_url: workspaceUrl.trim(), token: token.trim(), catalog: catalog ?? '', schema_name: name },
      { onError: fail },
    )
  }

  // The upload mode has no sign-in step: there is nothing to authenticate
  // against, so it goes straight to the picker.
  const signedIn =
    mode === 'upload' ? true : mode === 'azure' ? containers !== null : catalogs !== null
  const canConnect =
    mode === 'azure'
      ? account.trim() !== '' && sas.trim() !== ''
      : workspaceUrl.trim() !== '' && token.trim() !== ''

  return (
    <Modal open onClose={onClose} maxWidthClassName="max-w-[620px]">
      <div className="flex items-start justify-between gap-3 border-b border-border-subtle p-[16px_20px]">
        <div className="min-w-0">
          <h2 className="text-md font-bold">{TITLE[mode]}</h2>
          <p className="mt-0.5 text-sm text-ink-muted">
            {mode === 'upload'
              ? 'Inspect the files and their columns. MMM cannot import them yet.'
              : 'Browse what this source holds. MMM cannot import from it yet.'}
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
        {mode === 'upload' ? (
          <>
            <label className="flex cursor-pointer flex-col items-center gap-2 rounded-[var(--r-lg)] border border-dashed border-border-strong p-7 text-center transition-colors duration-150 hover:border-brand-violet">
              <span className="grid h-10 w-10 place-items-center rounded-full bg-tint-lavender text-tint-lavender-icon [&_svg]:h-[18px] [&_svg]:w-[18px]">
                <Icon name="plus" />
              </span>
              <span className="text-base font-bold text-ink-primary">Choose files</span>
              <span className="text-sm text-ink-muted">.csv, .xlsx or .xls from this machine</span>
              <input
                type="file"
                multiple
                accept=".csv,.xlsx,.xls"
                className="hidden"
                onChange={(e) => void chooseFiles(e.target.files)}
              />
            </label>

            {chosen.length > 0 && (
              <div className="mt-3.5 flex flex-col gap-1">
                {chosen.map((f) => (
                  <div
                    key={f.name}
                    className="rounded-[var(--r-md)] bg-surface-muted p-[8px_12px]"
                  >
                    <div className="flex items-center gap-2.5">
                      <Icon name="file" className="h-4 w-4 shrink-0 text-ink-muted" />
                      <span className="min-w-0 flex-1 truncate text-base text-ink-primary">{f.name}</span>
                      <span className="shrink-0 text-2xs text-ink-muted">{fmtSize(f.size)}</span>
                    </div>
                    <div className="mt-0.5 pl-[26px] text-2xs text-ink-muted">
                      {f.headers.length
                        ? `${f.headers.length} columns · ${f.headers.slice(0, 6).join(', ')}${f.headers.length > 6 ? '…' : ''}`
                        : 'Columns are read on the server — .xlsx cannot be opened in the browser'}
                    </div>
                  </div>
                ))}
              </div>
            )}

            {chosen.length > 0 && <NotIngested kind="file" items={chosen.map((f) => f.name)} />}
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
            <p className="mt-3 text-sm leading-[1.5] text-ink-muted">
              Credentials are sent with each request and never stored — the same handling TPO's
              connectors use.
            </p>
          </>
        ) : mode === 'azure' ? (
          <>
            {!container ? (
              <>
                <div className="mb-2 text-xs font-bold uppercase tracking-wide text-ink-muted">
                  Containers ({containers?.length ?? 0})
                </div>
                <div className="flex flex-col gap-1">
                  {containers?.map((c) => (
                    <Row key={c} label={c} icon="folder" onClick={() => openContainer(c)} />
                  ))}
                </div>
              </>
            ) : (
              <>
                <button
                  type="button"
                  onClick={() => {
                    setContainer(null)
                    setPicked([])
                  }}
                  className="mb-2 flex items-center gap-1 text-sm font-semibold text-brand-violet [&_svg]:h-3.5 [&_svg]:w-3.5"
                >
                  <Icon name="chevronLeft" /> All containers
                </button>
                <div className="mb-2 text-xs font-bold uppercase tracking-wide text-ink-muted">
                  {container} · {azBlobs.data?.files.length ?? 0} files
                </div>
                <div className="flex flex-col gap-1">
                  {azBlobs.data?.files.map((f) => (
                    <Row
                      key={f.name}
                      label={f.display_name}
                      sub={fmtSize(f.size_bytes)}
                      icon="file"
                      selected={picked.includes(f.name)}
                      onClick={() => toggle(f.name)}
                    />
                  ))}
                </div>
                {picked.length > 0 && <NotIngested kind="file" items={picked} />}
              </>
            )}
          </>
        ) : (
          <>
            {!catalog ? (
              <>
                <div className="mb-2 text-xs font-bold uppercase tracking-wide text-ink-muted">
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
                  className="mb-2 flex items-center gap-1 text-sm font-semibold text-brand-violet [&_svg]:h-3.5 [&_svg]:w-3.5"
                >
                  <Icon name="chevronLeft" /> All catalogs
                </button>
                <div className="mb-2 text-xs font-bold uppercase tracking-wide text-ink-muted">
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
                    setPicked([])
                  }}
                  className="mb-2 flex items-center gap-1 text-sm font-semibold text-brand-violet [&_svg]:h-3.5 [&_svg]:w-3.5"
                >
                  <Icon name="chevronLeft" /> {catalog}
                </button>
                <div className="mb-2 text-xs font-bold uppercase tracking-wide text-ink-muted">
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
                      onClick={() => toggle(t.name)}
                    />
                  ))}
                </div>
                {picked.length > 0 && <NotIngested kind="table" items={picked} />}
              </>
            )}
          </>
        )}

        {busy && (
          <div className="mt-3 flex items-center gap-2 text-sm text-ink-muted">
            <Spinner className="h-4 w-4" /> Contacting {TITLE[mode]}…
          </div>
        )}
        {error && (
          <div
            role="alert"
            className="mt-3 rounded-[var(--r-md)] bg-status-danger-bg p-[10px_12px] text-sm leading-[1.5] text-[#B91C1C]"
          >
            {error}
          </div>
        )}
      </div>

      <div className="flex items-center justify-between gap-3 border-t border-border-subtle p-[14px_20px]">
        <span className="text-sm text-ink-muted">
          {mode === 'upload'
            ? chosen.length
              ? `${chosen.length} file${chosen.length === 1 ? '' : 's'} inspected · nothing sent`
              : 'No files chosen'
            : signedIn
              ? 'Connected · browsing only'
              : 'Not connected'}
        </span>
        <div className="flex items-center gap-2">
          <Button variant="ghost" onClick={onClose}>
            Close
          </Button>
          {mode !== 'upload' && !signedIn && (
            <Button variant="primary" onClick={connect} disabled={!canConnect || busy}>
              Connect
            </Button>
          )}
        </div>
      </div>
    </Modal>
  )
}
