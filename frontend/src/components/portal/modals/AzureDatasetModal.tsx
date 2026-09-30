import { useEffect, useState } from 'react'
import { Icon } from '../../../icons'
import { MissingTables } from './MissingTables'
import { InstallProgress } from './InstallProgress'
import { Modal, Button, IconButton, Field, Input, Spinner, useToast, useConfirm, BrandLogo } from '../../ui'
import { ErrorBox, InfoNote } from './shared'
import { fmtSize, saveAzureConn, loadAzureConn } from '../../../lib/portalConnectors'
import {
  useStarStatus,
  useResetStar,
  useAzureContainers,
  useAzureBlobs,
  useAzureInspect,
  useAzureInstall,
} from '../../../hooks/useDatasets'
import type { AzureBlobSel } from '../../../hooks/useDatasets'
import { STAR_ROLE_LABELS } from '../../../lib/starSchema'
import { ApiError } from '../../../lib/api'
import type { PortalConnector } from '../../../types/portal'
import type { AzureBlobListing, StarInspectResult, StarRole } from '../../../types/dataset'
import { StarFileViewer } from './StarFileViewer'

// Loading the six star-schema tables from an Azure Blob Storage container.
//
// THE SAME CONNECTOR AS EXCEL, WITH A DIFFERENT SOURCE. Every rule about what
// is acceptable — the six tables identified by column headers, all of them or
// none, no extra files, locked once loaded, reset before reloading — is the
// backend's `star_dataset` and is shared with the Excel upload. This modal
// differs only in where the bytes come from, and so deliberately mirrors
// UploadModal's states: loaded shows View/Reset with no picker at all; empty
// shows the picker.
//
// THE BYTES NEVER TOUCH THE BROWSER. Selecting files sends blob NAMES to the
// backend, which fetches them from Azure server-to-server. Downloading 21 MB
// into the tab only to upload the same 21 MB back would be slower and would
// additionally require CORS on the storage account — a setting many users
// cannot change. The SAS token is sent per request and is not persisted server
// side; `saveAzureConn` keeps it in this tab's sessionStorage only, so
// reopening the modal doesn't mean re-pasting it.
export function AzureDatasetModal({
  connector,
  onClose,
  onConnected,
}: {
  connector: PortalConnector
  onClose: () => void
  onConnected: (detail: string) => void
}) {
  const saved = loadAzureConn()
  const [account, setAccount] = useState(saved?.account ?? '')
  const [sas, setSas] = useState(saved?.sas ?? '')
  const [showSas, setShowSas] = useState(false)
  const [error, setError] = useState('')
  const [containers, setContainers] = useState<string[] | null>(null)
  // A SAS scoped to one container (sr=c) can't enumerate the account, so the
  // user names the container instead. Normal, not an error — often the only
  // kind of token someone who doesn't own the account can be given.
  const [containerScoped, setContainerScoped] = useState(false)
  const [manualContainer, setManualContainer] = useState('')
  const [listing, setListing] = useState<AzureBlobListing | null>(null)
  const [picked, setPicked] = useState<AzureBlobSel[]>([])
  const [inspection, setInspection] = useState<StarInspectResult | null>(null)
  const [viewing, setViewing] = useState<StarRole | null>(null)

  const { show } = useToast()
  const confirm = useConfirm()
  const status = useStarStatus()
  const reset = useResetStar()
  const listContainers = useAzureContainers()
  const listBlobs = useAzureBlobs()
  const inspect = useAzureInspect()
  const install = useAzureInstall()

  const locked = status.data?.locked ?? false
  const creds = { account: account.trim(), sas: sas.trim() }
  const busy = listContainers.isPending || listBlobs.isPending || inspect.isPending || install.isPending

  const fail = (e: unknown) =>
    setError(e instanceof ApiError ? e.message : "Couldn't reach the server — is the backend running?")

  const connect = () => {
    setError('')
    if (!creds.account || !creds.sas) {
      setError('Enter both a storage account name and a SAS token.')
      return
    }
    listContainers.mutate(creds, {
      onSuccess: (res) => {
        setContainers(res.containers.map((c) => c.name))
        setContainerScoped(res.container_scoped)
        setListing(null)
        saveAzureConn(creds)
      },
      onError: fail,
    })
  }

  const openFolder = (container: string, prefix: string) => {
    setError('')
    listBlobs.mutate(
      { ...creds, container, prefix },
      { onSuccess: setListing, onError: fail },
    )
  }

  // Selection is account-wide, not per-folder: the six tables are often spread
  // across folders, so navigating away must not silently drop what was ticked.
  const toggle = (container: string, name: string) => {
    setInspection(null)
    setPicked((prev) => {
      const hit = prev.findIndex((b) => b.container === container && b.name === name)
      return hit >= 0 ? prev.filter((_, i) => i !== hit) : [...prev, { container, name }]
    })
  }
  const isPicked = (container: string, name: string) =>
    picked.some((b) => b.container === container && b.name === name)

  // Clear a stale error whenever the selection changes — it described a set the
  // user has since edited. Keyed on the selection's CONTENTS, not its length:
  // swapping one file for another leaves the count identical, and that is
  // exactly the edit most likely to follow an error about a specific file.
  // (The stale identification itself is dropped in `toggle`, which is the only
  // thing that can invalidate one.)
  const pickedKey = picked.map((b) => `${b.container}/${b.name}`).join('|')
  useEffect(() => setError(''), [pickedKey])

  const runInspect = () => {
    setError('')
    inspect.mutate(
      { ...creds, blobs: picked },
      { onSuccess: setInspection, onError: fail },
    )
  }

  const runInstall = () => {
    setError('')
    install.mutate(
      { ...creds, blobs: picked },
      {
        onSuccess: (res) => {
          const rows = res.rows
          onConnected(`${res.installed.length} core tables${rows ? ` · ${rows.toLocaleString()} fact rows` : ''}`)
          show(`Dataset loaded from Azure — ${rows?.toLocaleString() ?? ''} fact rows ready.`, { duration: 4000 })
          // Stay open: the modal flips to the loaded view so the user can see
          // what landed rather than the dialog just disappearing.
          setPicked([])
          setInspection(null)
        },
        onError: fail,
      },
    )
  }

  const doReset = () => {
    confirm({
      title: 'Reset uploaded data?',
      body:
        'All 6 files will be deleted from the data folder and every dashboard will go back to ' +
        'its upload prompt. This cannot be undone — you will need to load the full set again.',
      primaryText: 'Delete all 6 files',
      icon: 'alertTriangle',
      onConfirm: () => {
        setError('')
        reset.mutate(undefined, {
          onSuccess: (res) => {
            setViewing(null)
            setPicked([])
            setInspection(null)
            show(`${res.removed.length} files cleared — load a new dataset.`, { duration: 3500 })
          },
          onError: fail,
        })
      },
    })
  }

  if (viewing) {
    return <StarFileViewer role={viewing} onBack={() => setViewing(null)} onClose={onClose} />
  }

  const installed = status.data?.files.filter((f) => f.present) ?? []
  const ready = inspection?.ready ?? false

  return (
    <Modal open onClose={onClose} maxWidthClassName="max-w-[560px]">
      <div className="flex items-center justify-between border-b border-border-subtle p-[16px_20px]">
        <div className="flex items-center gap-2.5">
          <div className="grid h-9 w-9 shrink-0 place-items-center overflow-hidden rounded-[9px]">
            <BrandLogo logo="azure" name={connector.name} />
          </div>
          <div>
            <h3 className="text-md font-bold">{locked ? 'Your dataset' : 'Load dataset from Azure'}</h3>
            <div className="mt-0.5 text-sm text-ink-muted">
              {locked ? 'All 6 tables loaded · view or reset' : 'Pick the 6 tables · recognised by their column headers'}
            </div>
          </div>
        </div>
        <IconButton icon="x" onClick={onClose} />
      </div>

      <div className="max-h-[64vh] overflow-y-auto p-5">
        <ErrorBox message={error} />

        {status.isLoading && (
          <div className="flex items-center justify-center gap-2 py-8 text-sm text-ink-muted">
            <Spinner /> Checking what's loaded…
          </div>
        )}

        {/* ---------------- LOADED: view / reset, no picker ---------------- */}
        {!status.isLoading && locked && (
          <>
            <div className="mb-3.5 flex items-start gap-2 rounded-[var(--r-md)] bg-status-success-bg p-[10px_12px] text-sm leading-[1.5] text-[#047857] [&_svg]:mt-px [&_svg]:h-[15px] [&_svg]:w-[15px] [&_svg]:shrink-0">
              <Icon name="checkCircle" />
              <span>
                All 6 tables are loaded and every dashboard is reading from them. To load a different
                dataset, reset first — the six files are only consistent as one set.
              </span>
            </div>
            <div className="flex flex-col gap-2">
              {installed.map((f) => (
                <div key={f.role} className="flex items-center gap-2.5 rounded-[var(--r-md)] bg-surface-muted p-[9px_12px]">
                  <Icon name="database" className="h-4 w-4 shrink-0 text-[#047857]" />
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-base font-semibold">{f.label}</div>
                    <div className="mt-px truncate text-xs leading-[1.45] text-ink-muted">
                      {f.filename} · {fmtSize(f.size_bytes)}
                    </div>
                  </div>
                  <Button variant="secondary" size="sm" onClick={() => setViewing(f.role)}>
                    <Icon name="eye" /> View
                  </Button>
                </div>
              ))}
            </div>
          </>
        )}

        {/* ---------------- EMPTY: credentials, then the picker ---------------- */}
        {!status.isLoading && !locked && (
          <>
            <div className="mb-3">
              <Field label="Storage account name">
                <Input
                  value={account}
                  onChange={(e) => { setAccount(e.target.value); setContainers(null); setContainerScoped(false) }}
                  placeholder="mystorageaccount"
                />
              </Field>
            </div>
            <div className="mb-1.5">
              <Field label="SAS token">
                <div className="relative">
                  <Input
                    type={showSas ? 'text' : 'password'}
                    value={sas}
                    onChange={(e) => { setSas(e.target.value); setContainers(null); setContainerScoped(false) }}
                    placeholder="sv=2024-...&ss=b&srt=co&sp=rl&se=...&sig=..."
                    className="pr-9"
                  />
                  <button
                    type="button"
                    onClick={() => setShowSas((v) => !v)}
                    className="absolute right-1 top-1/2 grid h-[26px] w-[26px] -translate-y-1/2 place-items-center rounded-md text-ink-muted"
                  >
                    <Icon name="eye" className="h-4 w-4" />
                  </button>
                </div>
              </Field>
            </div>
            <InfoNote>
              Needs Read and List permission on blobs and containers. The files are fetched by the
              server, so CORS does not need to be enabled on the storage account. Once the data loads,
              the server keeps this connection so the Live pill can sync new rows — use a read-only
              token that expires.
            </InfoNote>

            <Button
              variant="secondary"
              block
              className="mt-3.5"
              onClick={connect}
              disabled={listContainers.isPending}
            >
              <Icon name="database" />{' '}
              {listContainers.isPending ? 'Connecting…' : containers ? 'Reconnect' : 'Connect & list containers'}
            </Button>

            {/* A container-scoped token: ask which container it is for. */}
            {containerScoped && !listing && (
              <div className="mt-3.5">
                <div className="mb-2 flex items-start gap-2 rounded-[var(--r-md)] bg-surface-muted p-[10px_12px] text-sm leading-[1.5] text-ink-muted [&_svg]:mt-px [&_svg]:h-[15px] [&_svg]:w-[15px] [&_svg]:shrink-0">
                  <Icon name="info" />
                  <span>
                    This token is scoped to a single container, so the list of containers can't be
                    read. Enter the container name it was created for.
                  </span>
                </div>
                <div className="flex gap-2">
                  <Input
                    value={manualContainer}
                    onChange={(e) => setManualContainer(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter' && manualContainer.trim()) {
                        openFolder(manualContainer.trim(), '')
                      }
                    }}
                    placeholder="container name"
                  />
                  <Button
                    variant="secondary"
                    onClick={() => openFolder(manualContainer.trim(), '')}
                    disabled={!manualContainer.trim() || listBlobs.isPending}
                  >
                    {listBlobs.isPending ? 'Opening…' : 'Open'}
                  </Button>
                </div>
              </div>
            )}

            {/* Containers */}
            {containers && !containerScoped && !listing && (
              <div className="mt-3.5">
                <div className="mb-2 text-sm text-ink-muted">
                  {containers.length} container{containers.length === 1 ? '' : 's'} — open one to pick files
                </div>
                <div className="flex max-h-[240px] flex-col gap-1.5 overflow-y-auto">
                  {containers.map((name) => (
                    <button
                      key={name}
                      onClick={() => openFolder(name, '')}
                      className="flex items-center gap-2.5 rounded-[var(--r-md)] bg-surface-muted p-[9px_11px] text-left text-base font-semibold hover:bg-brand-violet-50 hover:text-brand-violet"
                    >
                      <Icon name="folder" className="h-4 w-4 text-ink-muted" />
                      <span className="min-w-0 flex-1 truncate">{name}</span>
                      <Icon name="chevronRight" className="h-4 w-4 text-ink-muted" />
                    </button>
                  ))}
                  {!containers.length && (
                    <div className="text-sm text-ink-muted">No containers visible to this SAS token.</div>
                  )}
                </div>
              </div>
            )}

            {/* Blobs in one container/folder */}
            {listing && (
              <div className="mt-3.5">
                <button
                  onClick={() => {
                    // Up one virtual folder, or out of the container entirely.
                    const parent = listing.prefix.replace(/[^/]+\/$/, '')
                    if (listing.prefix) openFolder(listing.container, parent)
                    else setListing(null)  // back to the container list / name prompt
                  }}
                  className="mb-2 inline-flex items-center gap-1 text-sm font-bold text-brand-violet"
                >
                  <Icon name="chevronLeft" className="h-3.5 w-3.5" />
                  {/* At the container root a scoped token has no list to go back
                      to — it returns to the name prompt, so say that instead of
                      offering "All containers" and showing nothing. */}
                  {listing.prefix
                    ? 'Up one level'
                    : containerScoped
                      ? 'Change container'
                      : 'All containers'}
                </button>
                <div className="mb-2 truncate text-sm text-ink-muted">
                  {listing.container}/{listing.prefix}
                  {listBlobs.isPending && ' · loading…'}
                </div>

                <div className="flex max-h-[240px] flex-col gap-1.5 overflow-y-auto">
                  {listing.folders.map((f) => (
                    <button
                      key={f}
                      onClick={() => openFolder(listing.container, f)}
                      className="flex items-center gap-2.5 rounded-[var(--r-md)] bg-surface-muted p-[9px_11px] text-left text-base font-semibold hover:bg-brand-violet-50 hover:text-brand-violet"
                    >
                      <Icon name="folder" className="h-4 w-4 text-ink-muted" />
                      <span className="min-w-0 flex-1 truncate">{f.replace(listing.prefix, '')}</span>
                      <Icon name="chevronRight" className="h-4 w-4 text-ink-muted" />
                    </button>
                  ))}

                  {listing.files.map((b) => {
                    const on = isPicked(listing.container, b.name)
                    return (
                      <button
                        key={b.name}
                        onClick={() => toggle(listing.container, b.name)}
                        className={`flex items-center gap-2.5 rounded-[var(--r-md)] p-[9px_11px] text-left text-base ${
                          on ? 'bg-brand-violet-50 text-brand-violet' : 'bg-surface-muted hover:bg-surface-hover'
                        }`}
                      >
                        <Icon
                          name={on ? 'checkCircle' : 'file'}
                          className={`h-4 w-4 shrink-0 ${on ? 'text-brand-violet' : 'text-ink-muted'}`}
                        />
                        <span className="min-w-0 flex-1 truncate font-medium">{b.display_name}</span>
                        <span className="shrink-0 text-xs text-ink-muted">{fmtSize(b.size_bytes)}</span>
                      </button>
                    )
                  })}

                  {!listing.folders.length && !listing.files.length && (
                    <div className="text-sm text-ink-muted">No CSV or Excel files in this folder.</div>
                  )}
                </div>

                {listing.truncated && (
                  <div className="mt-1.5 text-xs text-ink-muted">
                    Listing was cut short — this folder holds more files than shown.
                  </div>
                )}
              </div>
            )}

            {/* What was picked, and what the headers say it is. */}
            {picked.length > 0 && (
              <div className="mt-3.5">
                <div className="mb-2 flex items-center justify-between gap-2">
                  <span className="text-sm font-bold">
                    {picked.length} file{picked.length === 1 ? '' : 's'} selected
                  </span>
                  <button
                    onClick={() => { setPicked([]); setInspection(null) }}
                    className="text-xs font-semibold text-ink-muted hover:text-[#B91C1C]"
                  >
                    Clear all
                  </button>
                </div>
                <div className="flex flex-col gap-2">
                  {picked.map((b) => {
                    const leaf = b.name.split('/').pop() ?? b.name
                    const found = inspection?.files.find((f) => f.filename === leaf)
                    const ok = found?.recognised && found.missing_columns.length === 0
                    return (
                      <div key={`${b.container}/${b.name}`} className="flex items-center gap-2.5 rounded-[var(--r-md)] bg-surface-muted p-[9px_12px]">
                        <Icon
                          name={!inspection ? 'file' : ok ? 'check' : 'info'}
                          className={`h-4 w-4 shrink-0 ${!inspection ? 'text-ink-muted' : ok ? 'text-[#047857]' : 'text-[#B91C1C]'}`}
                        />
                        <div className="min-w-0 flex-1">
                          <div className="truncate text-base font-semibold">{leaf}</div>
                          <div className="mt-px truncate text-xs leading-[1.45]">
                            {!inspection ? (
                              <span className="text-ink-muted">{b.container}/{b.name}</span>
                            ) : ok && found?.role ? (
                              <span className="text-[#047857]">{STAR_ROLE_LABELS[found.role]}</span>
                            ) : found?.recognised && found.role ? (
                              <span className="text-[#B91C1C]">
                                {STAR_ROLE_LABELS[found.role]} — missing {found.missing_columns.join(', ')}
                              </span>
                            ) : (
                              <span className="text-[#B91C1C]">Not one of the 6 tables — remove it</span>
                            )}
                          </div>
                        </div>
                        <button
                          onClick={() => toggle(b.container, b.name)}
                          className="grid h-5 w-5 shrink-0 place-items-center rounded-full text-ink-muted hover:bg-status-danger-bg hover:text-[#B91C1C]"
                        >
                          <Icon name="x" className="h-3.5 w-3.5" />
                        </button>
                      </div>
                    )
                  })}
                </div>
              </div>
            )}

            {/* The backend's own verdict, which names exactly what is wrong. */}
            {inspection && !inspection.ready && <MissingTables inspection={inspection} />}

            <InstallProgress
              active={install.isPending}
              estimateMs={60_000}
              label="Downloading from Azure"
              note="The six blobs are downloaded and written to the data folder. The fact table is the big one."
            />

            {inspection?.ready && (
              <div className="mt-3.5 flex items-start gap-2 rounded-[var(--r-md)] bg-surface-muted p-[10px_12px] text-sm leading-[1.5] text-ink-muted [&_svg]:mt-px [&_svg]:h-[15px] [&_svg]:w-[15px] [&_svg]:shrink-0">
                <Icon name="check" />
                <span>All 6 tables recognised. They'll be downloaded from Azure and every dashboard will load from them.</span>
              </div>
            )}
          </>
        )}
      </div>

      <div className="flex items-center justify-between gap-2 border-t border-border-subtle p-[14px_22px]">
        <span className="text-xs text-ink-muted">
          {locked ? '6 of 6 loaded' : picked.length > 0 ? `${picked.length} selected` : 'Read + List SAS token'}
        </span>
        <div className="flex gap-2">
          {locked ? (
            <>
              <Button variant="ghost" onClick={onClose}>Close</Button>
              <Button variant="secondary" onClick={doReset} disabled={reset.isPending}>
                <Icon name="refresh" /> {reset.isPending ? 'Resetting…' : 'Reset'}
              </Button>
            </>
          ) : (
            <>
              <Button variant="ghost" onClick={onClose}>Cancel</Button>
              {/* Check first, load second — identification is a 256 KB read per
                  file, so the user learns what is wrong before 21 MB moves. */}
              {!ready ? (
                <Button variant="primary" onClick={runInspect} disabled={picked.length === 0 || busy}>
                  <Icon name="search" /> {inspect.isPending ? 'Checking…' : 'Check files'}
                </Button>
              ) : (
                <Button variant="primary" onClick={runInstall} disabled={busy}>
                  <Icon name="download" /> {install.isPending ? 'Loading dataset…' : 'Load 6 tables'}
                </Button>
              )}
            </>
          )}
        </div>
      </div>
    </Modal>
  )
}
