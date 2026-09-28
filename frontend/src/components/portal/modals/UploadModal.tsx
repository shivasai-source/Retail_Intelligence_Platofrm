import { useEffect, useRef, useState } from 'react'
import { Icon } from '../../../icons'
import { Modal, Button, IconButton, useToast, useConfirm, BrandLogo, Spinner } from '../../ui'
import { fmtSize } from '../../../lib/portalConnectors'
import { useUploadDatasets, useStarStatus, useResetStar } from '../../../hooks/useDatasets'
import { classifyFiles, ROLE_COLUMNS, STAR_ROLES, STAR_ROLE_LABELS } from '../../../lib/starSchema'
import type { ClassifiedFile } from '../../../lib/starSchema'
import { ApiError } from '../../../lib/api'
import type { PortalConnector } from '../../../types/portal'
import type { StarRole } from '../../../types/dataset'
import { StarFileViewer } from './StarFileViewer'
import { InstallProgress } from './InstallProgress'
import { DataRequirementsDetail } from './DataRequirementsDetail'

// The Excel connector's upload screen.
//
// FILES ARE IDENTIFIED BY THEIR COLUMN HEADERS, NOT THEIR NAMES. Whatever the
// user's export is called — `Book1.xlsx`, `export (3).csv` — its columns say
// which of the six tables it is, and this modal reads that header in the
// browser to label each file as it is added.
//
// TWO STATES, because the backend only has two. A star schema is consistent
// only as a complete set, so `star_dataset` allows exactly "all six of one
// dataset" or "empty", and refuses an upload while a set is installed. This
// modal mirrors that: with data loaded it shows the six files with View and
// Reset and no dropzone at all; empty, it shows the dropzone and names exactly
// which tables are still missing. Rendering an upload button that the server
// would answer with a 409 would be a worse way to say the same thing.
//
// ONLY THE SIX ARE ACCEPTED. A file whose header matches no table is refused by
// name rather than quietly stored elsewhere — an unrecognised file here is
// nearly always the wrong file picked, and hiding that behind a success message
// is how a user ends up wondering why a dashboard never changed.
export function UploadModal({
  connector,
  onClose,
  onConnected,
}: {
  connector: PortalConnector
  onClose: () => void
  onConnected: (detail: string) => void
}) {
  const [classified, setClassified] = useState<ClassifiedFile[]>([])
  const [dragging, setDragging] = useState(false)
  const [error, setError] = useState('')
  const [viewing, setViewing] = useState<StarRole | null>(null)
  const [showGuide, setShowGuide] = useState(false)
  const inputRef = useRef<HTMLInputElement>(null)
  const { show } = useToast()
  const confirm = useConfirm()
  const upload = useUploadDatasets()
  const status = useStarStatus()
  const reset = useResetStar()
  const processing = upload.isPending
  const locked = status.data?.locked ?? false

  const addFiles = async (list: FileList | null) => {
    if (!list) return
    const next = await classifyFiles(Array.from(list))
    setClassified((prev) => {
      // De-duplicate by name+size: dropping the same folder twice is easy.
      const seen = new Set(prev.map((c) => `${c.file.name}:${c.file.size}`))
      return [...prev, ...next.filter((c) => !seen.has(`${c.file.name}:${c.file.size}`))]
    })
  }

  // A role is satisfied by exactly one file carrying every required column —
  // the same rule the backend applies in star_dataset.validate.
  const byRole = new Map<StarRole, ClassifiedFile[]>()
  for (const c of classified) {
    if (c.role) byRole.set(c.role, [...(byRole.get(c.role) ?? []), c])
  }
  const satisfied = new Set(
    [...byRole.entries()]
      .filter(([, files]) => files.length === 1 && files[0].missingColumns.length === 0)
      .map(([role]) => role),
  )
  const missingRoles = STAR_ROLES.filter((r) => !satisfied.has(r))
  const duplicated = [...byRole.entries()].filter(([, f]) => f.length > 1).map(([role]) => role)
  const incompleteFiles = classified.filter((c) => c.role && c.missingColumns.length > 0)
  // A workbook's header can't be read in the browser (see readHeader), so the
  // backend decides. Never block the upload on one.
  const undetermined = classified.filter((c) => c.undetermined)
  // Headers matched none of the six. Blocks the upload here rather than letting
  // the server refuse the whole set after a 21 MB round trip.
  const extras = classified.filter((c) => !c.role && !c.undetermined)
  const ready =
    classified.length > 0 &&
    extras.length === 0 &&
    (missingRoles.length === 0 || undetermined.length > 0)

  // ~4 MB/s end to end (upload + parse + write), floored so a tiny set still
  // shows a sane countdown rather than snapping straight to done.
  const totalBytes = classified.reduce((n, c) => n + c.file.size, 0)
  const uploadEstimateMs = Math.max(4000, (totalBytes / (4 * 1024 * 1024)) * 1000)

  // Clear a stale error as soon as the selection changes — it described a set
  // the user has since edited.
  useEffect(() => setError(''), [classified.length])

  const go = () => {
    setError('')
    upload.mutate(
      classified.map((c) => c.file),
      {
        onSuccess: (result) => {
          const installed = result.star?.installed.length ?? 0
          if (installed) {
            const rows = result.star?.rows
            onConnected(`${installed} core tables${rows ? ` · ${rows.toLocaleString()} fact rows` : ''}`)
            show(`Dataset loaded — ${rows?.toLocaleString() ?? ''} fact rows ready.`, { duration: 4000 })
          }
          if (result.errors.length) {
            setError(result.errors.map((e) => e.error).join(' '))
            return
          }
          // Stay open on success: the modal flips to the loaded view, so the
          // user can confirm what landed instead of the dialog just vanishing.
          setClassified([])
        },
        onError: (e) => {
          setError(e instanceof ApiError ? e.message : "Couldn't reach the server — is the backend running?")
        },
      },
    )
  }

  const doReset = () => {
    confirm({
      title: 'Reset uploaded data?',
      body:
        'All 6 files will be deleted from the data folder and every dashboard will go back to ' +
        'its upload prompt. This cannot be undone — you will need to upload the full set again.',
      primaryText: 'Delete all 6 files',
      icon: 'alertTriangle',
      onConfirm: () => {
        setError('')
        reset.mutate(undefined, {
          onSuccess: (result) => {
            setViewing(null)
            setClassified([])
            show(`${result.removed.length} files cleared — upload a new dataset.`, { duration: 3500 })
          },
          onError: (e) => {
            setError(e instanceof ApiError ? e.message : "Couldn't reach the server.")
          },
        })
      },
    })
  }

  // The View panel takes over the whole modal — a 100-row table needs the width
  // far more than the file list behind it does.
  if (viewing) {
    return <StarFileViewer role={viewing} onBack={() => setViewing(null)} onClose={onClose} />
  }
  // Same takeover for the requirements guide, so files already picked survive it.
  if (showGuide) {
    return <DataRequirementsDetail onBack={() => setShowGuide(false)} onClose={onClose} />
  }

  const installed = status.data?.files.filter((f) => f.present) ?? []

  return (
    <Modal open onClose={onClose} maxWidthClassName="max-w-[500px]">
      <div className="flex items-center justify-between border-b border-border-subtle p-[16px_20px]">
        <div className="flex items-center gap-2.5">
          <div className="grid h-9 w-9 place-items-center overflow-hidden rounded-[9px]">
            <BrandLogo logo="excel" name={connector.name} />
          </div>
          <div>
            <h3 className="text-md font-bold">{locked ? 'Your dataset' : 'Upload your dataset'}</h3>
            <div className="mt-0.5 text-sm text-ink-muted">
              {locked ? 'All 6 tables loaded · view or reset' : 'All 6 tables · recognised by their column headers'}
            </div>
          </div>
        </div>
        <IconButton icon="x" onClick={onClose} />
      </div>

      <div className="max-h-[62vh] overflow-y-auto p-5">
        {status.isLoading && (
          <div className="flex items-center justify-center gap-2 py-8 text-sm text-ink-muted">
            <Spinner /> Checking what's loaded…
          </div>
        )}

        {/* ---------------- LOADED: view / reset, no dropzone ---------------- */}
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
                <div
                  key={f.role}
                  className="flex items-center gap-2.5 rounded-[var(--r-md)] bg-surface-muted p-[9px_12px]"
                >
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

        {/* ---------------- EMPTY: the dropzone ---------------- */}
        {!status.isLoading && !locked && (
          <>
            <div
              onClick={() => inputRef.current?.click()}
              onDragEnter={(e) => { e.preventDefault(); setDragging(true) }}
              onDragOver={(e) => { e.preventDefault(); setDragging(true) }}
              onDragLeave={(e) => { e.preventDefault(); setDragging(false) }}
              onDrop={(e) => { e.preventDefault(); setDragging(false); void addFiles(e.dataTransfer.files) }}
              className={`cursor-pointer rounded-[var(--r-lg)] border-2 border-dashed p-[24px_18px] text-center transition-colors ${
                dragging
                  ? 'border-brand-violet bg-brand-violet-50'
                  : 'border-border-strong hover:border-brand-violet hover:bg-brand-violet-50'
              }`}
            >
              <div className="mx-auto mb-2.5 grid h-10 w-10 place-items-center rounded-[10px] bg-tint-lavender text-tint-lavender-icon [&_svg]:h-5 [&_svg]:w-5">
                <Icon name="plus" />
              </div>
              <strong className="mb-1 block text-base">Click to choose files, or drag them here</strong>
              <span className="text-sm text-ink-muted">
                Exactly the 6 standard tables — names don't matter, columns identify them
              </span>
            </div>
            <input
              ref={inputRef}
              type="file"
              multiple
              accept=".xlsx,.xls,.csv"
              className="hidden"
              onChange={(e) => { void addFiles(e.target.files); e.target.value = '' }}
            />
            <button
              type="button"
              onClick={() => setShowGuide(true)}
              className="mt-2.5 inline-flex items-center gap-1.5 text-sm font-bold text-brand-violet hover:underline [&_svg]:h-3.5 [&_svg]:w-3.5"
            >
              <Icon name="book" /> Not sure what to upload? See what each file needs
            </button>

            {classified.length > 0 && (
              <div className="mt-3.5 flex flex-col gap-2">
                {classified.map((c, i) => {
                  const ok = Boolean(c.role) && c.missingColumns.length === 0
                  const extra = !c.role && !c.undetermined
                  return (
                    <div
                      key={`${c.file.name}:${c.file.size}`}
                      className="flex items-center gap-2.5 rounded-[var(--r-md)] bg-surface-muted p-[9px_12px]"
                    >
                      <Icon
                        name={ok ? 'check' : c.undetermined ? 'file' : 'info'}
                        className={`h-4 w-4 shrink-0 ${ok ? 'text-[#047857]' : c.undetermined ? 'text-ink-muted' : 'text-[#B91C1C]'}`}
                      />
                      <div className="min-w-0 flex-1">
                        <div className="truncate text-base font-semibold">{c.file.name}</div>
                        <div className="mt-px text-xs leading-[1.45]">
                          {ok && c.role ? (
                            <span className="text-[#047857]">{STAR_ROLE_LABELS[c.role]}</span>
                          ) : c.role ? (
                            <span className="text-[#B91C1C]">
                              {STAR_ROLE_LABELS[c.role]} — missing {c.missingColumns.join(', ')}
                            </span>
                          ) : c.undetermined ? (
                            <span className="text-ink-muted">Excel workbook — checked on upload</span>
                          ) : (
                            <span className="text-[#B91C1C]">
                              Not one of the 6 tables — remove it, it can't be uploaded
                            </span>
                          )}
                        </div>
                      </div>
                      <span className="shrink-0 text-xs text-ink-muted">{fmtSize(c.file.size)}</span>
                      <button
                        onClick={() => setClassified((prev) => prev.filter((_, idx) => idx !== i))}
                        className={`grid h-5 w-5 shrink-0 place-items-center rounded-full hover:bg-status-danger-bg hover:text-[#B91C1C] ${
                          extra ? 'text-[#B91C1C]' : 'text-ink-muted'
                        }`}
                      >
                        <Icon name="x" className="h-3.5 w-3.5" />
                      </button>
                    </div>
                  )
                })}
              </div>
            )}

            {/* Extra files block the upload outright — say so on its own, since
                the fix (remove it) differs from "upload the missing table". */}
            {extras.length > 0 && (
              <div className="mt-3.5 rounded-[var(--r-md)] bg-status-danger-bg p-[11px_13px]">
                <div className="mb-1.5 flex items-center gap-1.5 text-sm font-bold text-[#B91C1C] [&_svg]:h-[14px] [&_svg]:w-[14px]">
                  <Icon name="alertTriangle" />
                  {extras.length} file{extras.length > 1 ? 's are' : ' is'} not one of the 6 tables
                </div>
                <div className="text-xs leading-[1.5] text-[#B91C1C]">
                  Only the 6 standard tables can be uploaded. Remove{' '}
                  {extras.map((c) => `'${c.file.name}'`).join(', ')} to continue.
                </div>
              </div>
            )}

            {/* What is still needed, named table by table. */}
            {classified.length > 0 && missingRoles.length > 0 && undetermined.length === 0 && (
              <div className="mt-3.5 rounded-[var(--r-md)] bg-status-danger-bg p-[11px_13px]">
                <div className="mb-1.5 flex items-center gap-1.5 text-sm font-bold text-[#B91C1C] [&_svg]:h-[14px] [&_svg]:w-[14px]">
                  <Icon name="info" />
                  {missingRoles.length} of 6 tables still missing — upload to continue the pipeline
                </div>
                <ul className="flex flex-col gap-1">
                  {missingRoles.map((role) => {
                    const incomplete = incompleteFiles.find((c) => c.role === role)
                    return (
                      <li key={role} className="text-xs leading-[1.5] text-[#B91C1C]">
                        <strong>{STAR_ROLE_LABELS[role]}</strong>
                        {duplicated.includes(role) ? (
                          <> — uploaded more than once, keep one</>
                        ) : incomplete ? (
                          <> — missing {incomplete.missingColumns.join(', ')}</>
                        ) : (
                          <span className="opacity-80"> — needs {ROLE_COLUMNS[role].join(', ')}</span>
                        )}
                      </li>
                    )
                  })}
                </ul>
              </div>
            )}

            {classified.length > 0 && missingRoles.length === 0 && extras.length === 0 && (
              <div className="mt-3.5 flex items-start gap-2 rounded-[var(--r-md)] bg-surface-muted p-[10px_12px] text-sm leading-[1.5] text-ink-muted [&_svg]:mt-px [&_svg]:h-[15px] [&_svg]:w-[15px] [&_svg]:shrink-0">
                <Icon name="check" />
                <span>All 6 tables recognised. They'll be written to the data folder and every dashboard will load from them.</span>
              </div>
            )}
          </>
        )}

        {/* Upload is a single blocking request, so the bar is time-based; the
            estimate scales with the bytes actually being sent. */}
        <InstallProgress
          active={processing}
          estimateMs={uploadEstimateMs}
          label="Uploading & processing"
          note="The files are written to the data folder and every dashboard reloads from them."
        />

        {error && (
          <div className="mt-3.5 rounded-[var(--r-md)] bg-status-danger-bg p-[10px_12px] text-sm leading-[1.55] text-[#B91C1C]">
            {error}
          </div>
        )}
      </div>

      <div className="flex items-center justify-between gap-2 border-t border-border-subtle p-[14px_22px]">
        <span className="text-xs text-ink-muted">
          {locked
            ? `6 of 6 loaded`
            : classified.length > 0
              ? `${satisfied.size} of 6 ready`
              : '.csv, .xlsx or .xls'}
        </span>
        <div className="flex gap-2">
          {locked ? (
            <>
              <Button variant="ghost" onClick={onClose}>
                Close
              </Button>
              <Button variant="secondary" onClick={doReset} disabled={reset.isPending}>
                <Icon name="refresh" /> {reset.isPending ? 'Resetting…' : 'Reset'}
              </Button>
            </>
          ) : (
            <>
              <Button variant="ghost" onClick={onClose}>
                Cancel
              </Button>
              <Button variant="primary" onClick={go} disabled={!ready || processing}>
                <Icon name="plus" />{' '}
                {processing
                  ? 'Loading dataset…'
                  : extras.length > 0
                    ? 'Remove extra files'
                    : ready
                      ? 'Upload & Process'
                      : `${missingRoles.length} missing`}
              </Button>
            </>
          )}
        </div>
      </div>
    </Modal>
  )
}
