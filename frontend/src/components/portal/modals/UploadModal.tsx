import { useEffect, useRef, useState } from 'react'
import { Icon } from '../../../icons'
import { Modal, Button, IconButton, useToast, useConfirm, BrandLogo, Spinner } from '../../ui'
import { fmtSize } from '../../../lib/portalConnectors'
import {
  useInspectStarUpload,
  useResetStar,
  useStarStatus,
  useUploadDatasets,
} from '../../../hooks/useDatasets'
import {
  classifyFiles,
  crossFileProblems,
  DERIVABLE_ROLES,
  REQUIRED_ROLES,
  ROLE_COLUMNS,
  STAR_ROLE_LABELS,
  withMapping,
} from '../../../lib/starSchema'
import type { ClassifiedFile } from '../../../lib/starSchema'
import { ApiError } from '../../../lib/api'
import type { PortalConnector } from '../../../types/portal'
import type { StarColumnMapping, StarRole } from '../../../types/dataset'
import { StarFileViewer } from './StarFileViewer'
import { InstallProgress } from './InstallProgress'
import { DataRequirementsDetail } from './DataRequirementsDetail'
import { ColumnMappingPanel } from './ColumnMappingPanel'
import { UploadCoverageCard } from './UploadCoverageCard'

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
  const [selection, setSelection] = useState<ClassifiedFile[]>([])
  const [dragging, setDragging] = useState(false)
  const [error, setError] = useState('')
  const [viewing, setViewing] = useState<StarRole | null>(null)
  const [showGuide, setShowGuide] = useState(false)
  // What the mapping screen settled: which table each file is, and which of
  // its columns holds each value we need. Empty until the user goes there.
  const [mapping, setMapping] = useState<StarColumnMapping[]>([])
  const [showMapping, setShowMapping] = useState(false)
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
    setSelection((prev) => {
      // De-duplicate by name+size: dropping the same folder twice is easy.
      const seen = new Set(prev.map((c) => `${c.file.name}:${c.file.size}`))
      return [...prev, ...next.filter((c) => !seen.has(`${c.file.name}:${c.file.size}`))]
    })
  }

  // SEVERAL SALES FILES ARE A DELIVERY, so what they add up to has to be on
  // screen before the user installs them: the span, the weeks nobody sent and
  // the boundary rows that will be de-duplicated. Asked of the backend rather
  // than worked out here, because the week rule that decides what counts as a
  // gap is the loader's own (`_derive_week`) and a second copy of it would
  // eventually describe a different dataset from the one installed.
  const coverageProbe = useInspectStarUpload()

  // Every check below reads the selection AS MAPPED. Without this a client's
  // own export stays labelled "not one of the 6 tables" after the user has
  // just finished saying what its columns are, and the upload button stays
  // disabled over a problem that has been answered.
  const classified = withMapping(selection, mapping)

  // A role is satisfied when every file of it carries every required column —
  // the same rule the backend applies in star_dataset.validate.
  //
  // SEVERAL SALES FILES ARE A DELIVERY, NOT A MISTAKE: a client's history
  // arrives as "Jan-Mar", "Apr-Jun", "Jul-Sep", and the backend merges them
  // (app/fact_union.py). Several copies of a DIMENSION is still a mistake —
  // two product masters are two versions of one list.
  const byRole = new Map<StarRole, ClassifiedFile[]>()
  for (const c of classified) {
    if (c.role) byRole.set(c.role, [...(byRole.get(c.role) ?? []), c])
  }
  const satisfied = new Set(
    [...byRole.entries()]
      .filter(
        ([role, files]) =>
          files.every((f) => f.missingColumns.length === 0) &&
          (role === 'fact' || files.length === 1),
      )
      .map(([role]) => role),
  )
  // Only the REQUIRED tables can be "still missing". dim_channel, dim_promotion
  // and dim_date are derived by the loader when absent, so listing them here
  // would ask the user for files no source system has.
  const missingRoles = REQUIRED_ROLES.filter((r) => !satisfied.has(r))
  // Leaving a derivable dimension out is only a problem when nothing stands in
  // for it — the same CROSS_FILE_RULES the backend enforces.
  const standInProblems = crossFileProblems(classified)
  const duplicated = [...byRole.entries()]
    .filter(([role, f]) => f.length > 1 && role !== 'fact')
    .map(([role]) => role)
  const factFiles = byRole.get('fact') ?? []
  const incompleteFiles = classified.filter((c) => c.role && c.missingColumns.length > 0)
  const derived = DERIVABLE_ROLES.filter((r) => !satisfied.has(r))
  // A workbook's header can't be read in the browser (see readHeader), so the
  // backend decides. Never block the upload on one.
  const undetermined = classified.filter((c) => c.undetermined)
  // Headers matched none of the six. Blocks the upload here rather than letting
  // the server refuse the whole set after a 21 MB round trip.
  const extras = classified.filter((c) => !c.role && !c.undetermined)
  const ready =
    classified.length > 0 &&
    extras.length === 0 &&
    (standInProblems.length === 0 || undetermined.length > 0) &&
    (missingRoles.length === 0 || undetermined.length > 0)

  // ~4 MB/s end to end (upload + parse + write), floored so a tiny set still
  // shows a sane countdown rather than snapping straight to done.
  const totalBytes = classified.reduce((n, c) => n + c.file.size, 0)
  const uploadEstimateMs = Math.max(4000, (totalBytes / (4 * 1024 * 1024)) * 1000)

  // Clear a stale error as soon as the selection changes — it described a set
  // the user has since edited.
  useEffect(() => setError(''), [classified.length])

  // Ask what the sales files add up to, once there is more than one of them.
  // Keyed on the files and the mapping, because the dates cannot be found
  // until the mapping has renamed the client's date column to `Date`.
  const factKey = factFiles.map((c) => `${c.file.name}:${c.file.size}`).join('|')
  const mappingKey = JSON.stringify(mapping)
  useEffect(() => {
    if (factFiles.length < 2) return
    coverageProbe.mutate({ files: classified.map((c) => c.file), mapping, coverage: true })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [factKey, mappingKey])
  const coverage = factFiles.length >= 2 ? coverageProbe.data?.coverage : undefined

  const go = () => {
    setError('')
    upload.mutate(
      { files: classified.map((c) => c.file), mapping },
      {
        onSuccess: (result) => {
          const installed = result.star?.installed.length ?? 0
          if (installed) {
            const rows = result.star?.rows
            onConnected(`${installed} core tables${rows ? ` · ${rows.toLocaleString()} fact rows` : ''}`)
            // A delivery that silently lost rows to de-duplication is
            // something the user should be told, not something they should
            // have to notice from a total that looks low.
            const union = result.star?.union
            const merged =
              union && union.files > 1
                ? ` ${union.files} sales files merged${
                    union.duplicates_removed
                      ? `, ${union.duplicates_removed.toLocaleString()} repeated rows counted once`
                      : ''
                  }.`
                : ''
            show(`Dataset loaded — ${rows?.toLocaleString() ?? ''} fact rows ready.${merged}`, {
              duration: merged ? 7000 : 4000,
            })
          }
          if (result.errors.length) {
            setError(result.errors.map((e) => e.error).join(' '))
            return
          }
          // Stay open on success: the modal flips to the loaded view, so the
          // user can confirm what landed instead of the dialog just vanishing.
          setSelection([])
          setMapping([])
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
        'Every star file will be deleted from the data folder and every dashboard will go back to ' +
        'its upload prompt. This cannot be undone — you will need to upload the full set again.',
      primaryText: 'Delete every file',
      icon: 'alertTriangle',
      onConfirm: () => {
        setError('')
        reset.mutate(undefined, {
          onSuccess: (result) => {
            setViewing(null)
            setSelection([])
            setMapping([])
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
  // And for the mapping screen, which is where a file whose columns are named
  // the client's way gets turned into one the loader can read.
  if (showMapping) {
    return (
      <ColumnMappingPanel
        files={selection.map((c) => c.file)}
        initial={mapping}
        onBack={() => setShowMapping(false)}
        onClose={onClose}
        onApply={(settled) => {
          setMapping(settled)
          setShowMapping(false)
        }}
      />
    )
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
            <h3 className="text-md font-medium">{locked ? 'Your dataset' : 'Upload your dataset'}</h3>
            <div className="mt-0.5 text-sm text-ink-muted">
              {locked
                ? `${installed.length} table${installed.length === 1 ? '' : 's'} loaded · view or reset`
                : 'Sales, products and stores · recognised by their column headers'}
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
            <div className="mb-3.5 flex items-start gap-2 rounded-[var(--r-md)] bg-status-success-bg p-[10px_12px] text-sm leading-[1.5] text-[var(--pill-success-ink)] [&_svg]:mt-px [&_svg]:h-[15px] [&_svg]:w-[15px] [&_svg]:shrink-0">
              <Icon name="checkCircle" />
              <span>
                Your dataset is loaded and every dashboard is reading from it. To load a different
                dataset, reset first — a star schema is only consistent as one set.
              </span>
            </div>

            <div className="flex flex-col gap-2">
              {installed.map((f) => (
                <div
                  key={f.role}
                  className="flex items-center gap-2.5 rounded-[var(--r-md)] bg-surface-muted p-[9px_12px]"
                >
                  <Icon name="database" className="h-4 w-4 shrink-0 text-[var(--pill-success-ink)]" />
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-base font-medium">{f.label}</div>
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
                Sales, products and stores — names don't matter, columns identify them
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
              className="mt-2.5 inline-flex items-center gap-1.5 text-sm font-medium text-brand-violet hover:underline [&_svg]:h-3.5 [&_svg]:w-3.5"
            >
              <Icon name="book" /> Not sure what to upload? See what each file needs
            </button>
            {/* Always available once files are picked, not only when something
                is wrong: a file can be recognised and still have one column
                under a name we don't know, and the user is the one who can
                see that. */}
            {selection.length > 0 && (
              <button
                type="button"
                onClick={() => setShowMapping(true)}
                className="mt-1.5 flex items-center gap-1.5 text-sm font-medium text-brand-violet hover:underline [&_svg]:h-3.5 [&_svg]:w-3.5"
              >
                <Icon name="arrowTransform" />
                {mapping.length > 0
                  ? 'Review how your columns are matched'
                  : 'Columns named differently? Match them to ours'}
              </button>
            )}

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
                        className={`h-4 w-4 shrink-0 ${ok ? 'text-[var(--pill-success-ink)]' : c.undetermined ? 'text-ink-muted' : 'text-[var(--pill-danger-ink)]'}`}
                      />
                      <div className="min-w-0 flex-1">
                        <div className="truncate text-base font-medium">{c.file.name}</div>
                        <div className="mt-px text-xs leading-[1.45]">
                          {ok && c.role ? (
                            <span className="text-[var(--pill-success-ink)]">{STAR_ROLE_LABELS[c.role]}</span>
                          ) : c.role ? (
                            <span className="text-[var(--pill-danger-ink)]">
                              {STAR_ROLE_LABELS[c.role]} — missing {c.missingColumns.join(', ')}
                            </span>
                          ) : c.undetermined ? (
                            <span className="text-ink-muted">Excel workbook — checked on upload</span>
                          ) : (
                            <span className="text-[var(--pill-danger-ink)]">
                              Columns not recognised — match them, or remove it
                            </span>
                          )}
                        </div>
                      </div>
                      <span className="shrink-0 text-xs text-ink-muted">{fmtSize(c.file.size)}</span>
                      <button
                        onClick={() => {
                          setSelection((prev) => prev.filter((_, idx) => idx !== i))
                          setMapping((prev) => prev.filter((m) => m.filename !== c.file.name))
                        }}
                        className={`grid h-5 w-5 shrink-0 place-items-center rounded-full hover:bg-status-danger-bg hover:text-[var(--pill-danger-ink)] ${
                          extra ? 'text-[var(--pill-danger-ink)]' : 'text-ink-muted'
                        }`}
                      >
                        <Icon name="x" className="h-3.5 w-3.5" />
                      </button>
                    </div>
                  )
                })}
              </div>
            )}

            {/* A file whose headers matched nothing. TWO WAYS OUT NOW, and the
                likelier one is first: a client's own export is not a wrong
                file, it is the right file under its own column names. */}
            {extras.length > 0 && (
              <div className="mt-3.5 rounded-[var(--r-md)] bg-status-danger-bg p-[11px_13px]">
                <div className="mb-1.5 flex items-center gap-1.5 text-sm font-medium text-[var(--pill-danger-ink)] [&_svg]:h-[14px] [&_svg]:w-[14px]">
                  <Icon name="alertTriangle" />
                  {extras.length === 1
                    ? "1 file's columns weren't recognised"
                    : `${extras.length} files' columns weren't recognised`}
                </div>
                <div className="text-xs leading-[1.5] text-[var(--pill-danger-ink)]">
                  {extras.map((c) => `'${c.file.name}'`).join(', ')} — if this is your own export,
                  match its columns to ours. Otherwise remove it.
                </div>
                <Button
                  variant="secondary"
                  size="sm"
                  className="mt-2"
                  onClick={() => setShowMapping(true)}
                >
                  <Icon name="arrowTransform" /> Match columns
                </Button>
              </div>
            )}

            {/* What is still needed, named table by table. */}
            {classified.length > 0 && missingRoles.length > 0 && undetermined.length === 0 && (
              <div className="mt-3.5 rounded-[var(--r-md)] bg-status-danger-bg p-[11px_13px]">
                <div className="mb-1.5 flex items-center gap-1.5 text-sm font-medium text-[var(--pill-danger-ink)] [&_svg]:h-[14px] [&_svg]:w-[14px]">
                  <Icon name="info" />
                  {missingRoles.length} of {REQUIRED_ROLES.length} required tables still missing — upload to continue the pipeline
                </div>
                <ul className="flex flex-col gap-1">
                  {missingRoles.map((role) => {
                    const incomplete = incompleteFiles.find((c) => c.role === role)
                    return (
                      <li key={role} className="text-xs leading-[1.5] text-[var(--pill-danger-ink)]">
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

            {/* A derivable dimension left out with nothing standing in for it.
                Caught here rather than after a 21 MB round trip. */}
            {classified.length > 0 && standInProblems.length > 0 && undetermined.length === 0 && (
              <div className="mt-3.5 rounded-[var(--r-md)] bg-status-danger-bg p-[11px_13px]">
                <div className="mb-1.5 flex items-center gap-1.5 text-sm font-medium text-[var(--pill-danger-ink)] [&_svg]:h-[14px] [&_svg]:w-[14px]">
                  <Icon name="alertTriangle" />
                  A column is needed in place of a table you didn't upload
                </div>
                <ul className="flex flex-col gap-1">
                  {standInProblems.map((p) => (
                    <li key={p} className="text-xs leading-[1.5] text-[var(--pill-danger-ink)]">{p}</li>
                  ))}
                </ul>
              </div>
            )}

            {/* What several sales files add up to — the span, the weeks
                nobody sent, and the rows that will be de-duplicated. */}
            {coverage && <UploadCoverageCard coverage={coverage} />}

            {classified.length > 0 && missingRoles.length === 0 && extras.length === 0 && standInProblems.length === 0 && (
              <div className="mt-3.5 flex items-start gap-2 rounded-[var(--r-md)] bg-surface-muted p-[10px_12px] text-sm leading-[1.5] text-ink-muted [&_svg]:mt-px [&_svg]:h-[15px] [&_svg]:w-[15px] [&_svg]:shrink-0">
                <Icon name="check" />
                <span>
                  All {REQUIRED_ROLES.length} required tables recognised. They'll be written to the data folder and
                  every dashboard will load from them.
                  {derived.length > 0 && (
                    <>
                      {' '}The {derived.map((r) => STAR_ROLE_LABELS[r].toLowerCase()).join(', ')}{' '}
                      {derived.length === 1 ? 'is' : 'are'} derived from what you uploaded.
                    </>
                  )}
                </span>
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
          <div className="mt-3.5 rounded-[var(--r-md)] bg-status-danger-bg p-[10px_12px] text-sm leading-[1.55] text-[var(--pill-danger-ink)]">
            {error}
          </div>
        )}
      </div>

      <div className="flex items-center justify-between gap-2 border-t border-border-subtle p-[14px_22px]">
        <span className="text-xs text-ink-muted">
          {locked
            ? `${installed.length} loaded`
            : classified.length > 0
              ? `${REQUIRED_ROLES.length - missingRoles.length} of ${REQUIRED_ROLES.length} required ready`
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
