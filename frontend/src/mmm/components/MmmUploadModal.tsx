import { useRef, useState } from 'react'
import { Icon } from '../../icons'
import { BrandLogo, Button, IconButton, Modal, Spinner, useConfirm, useToast } from '../../components/ui'
import { InstallProgress } from '../../components/portal/modals/InstallProgress'
import { fmtSize } from '../../lib/portalConnectors'
import { readHeader } from '../../lib/starSchema'
import { ApiError } from '../../lib/api'
import { useMmmInspect, useMmmPreview, useMmmReset, useMmmStatus, useMmmUpload } from '../hooks'
import { checkHeader, columnsIn, MEDIA_CHANNELS, type MmmHeaderCheck } from '../schema'
import { MmmDataRequirements } from './MmmDataRequirements'

// MMM — UPLOAD. The Excel / Shared Drives connector for MMM, laid out like
// TPO's UploadModal and talking only to MMM's installer (POST /api/mmm/dataset,
// backend/app/mmm/dataset.py), which writes MMM's own data folder.
//
// THE COLUMNS ARE CHECKED BEFORE ANYTHING IS SENT. A CSV's header row is read in
// the browser (the same readHeader TPO's picker uses) and checked against the
// contract in ../schema.ts: required columns, how many of the 22 reference
// channels were found, which optional columns are missing, which are ignored.
// A workbook cannot be opened in the browser, so its header is checked by
// POST /api/mmm/dataset/inspect instead — the same answer, from the server.
// The server then validates every ROW on upload and reports every problem at
// once.
//
// ONE FILE, AND IT REPLACES. TPO installs six tables as a set and makes you
// reset first; MMM is one table, so a new upload simply replaces the loaded
// one. With data loaded the dialog opens on what is installed — View data,
// Replace file, Remove — rather than on an empty dropzone.

interface Picked {
  file: File
  /** null while a workbook's header is being checked on the server. */
  check: MmmHeaderCheck | null
  checkError?: string
}

export function MmmUploadModal({ onClose }: { onClose: () => void }) {
  const status = useMmmStatus()
  const upload = useMmmUpload()
  const inspect = useMmmInspect()
  const reset = useMmmReset()
  const { show } = useToast()
  const confirm = useConfirm()
  const inputRef = useRef<HTMLInputElement>(null)

  const [picked, setPicked] = useState<Picked | null>(null)
  const [replacing, setReplacing] = useState(false)
  const [dragging, setDragging] = useState(false)
  const [error, setError] = useState('')
  const [notes, setNotes] = useState<string[]>([])
  const [guide, setGuide] = useState(false)
  const [viewing, setViewing] = useState(false)

  const loaded = Boolean(status.data?.complete)
  const showDropzone = !loaded || replacing

  const choose = async (list: FileList | null) => {
    const file = list?.[0]
    if (!file) return
    setError('')
    setNotes([])
    const headers = await readHeader(file)
    if (headers.length) {
      setPicked({ file, check: checkHeader(headers) })
      return
    }
    // A workbook: the server reads its header.
    setPicked({ file, check: null })
    inspect.mutate(file, {
      onSuccess: (r) =>
        setPicked({
          file,
          check: {
            media: r.media_columns,
            rollups: r.rollup_columns ?? [],
            promo: columnsIn('promo')
              .map((c) => c.name)
              .filter((n) => !r.missing_optional.includes(n)),
            missingRequired: r.missing_required,
            missingOptional: r.missing_optional.filter((c) => !c.endsWith('_Spend')),
            ignored: r.ignored,
            ok: r.ok,
          },
        }),
      onError: (e) => setPicked({ file, check: null, checkError: e.message }),
    })
  }

  const go = () => {
    if (!picked) return
    setError('')
    upload.mutate(picked.file, {
      onSuccess: (result) => {
        show(`MMM dataset loaded — ${result.rows.toLocaleString()} days, ${result.media_columns.length} channels.`, {
          duration: 4000,
        })
        setNotes(result.warnings)
        setPicked(null)
        setReplacing(false)
      },
      onError: (e) => setError(e instanceof ApiError ? e.message : "Couldn't reach the server — is the backend running?"),
    })
  }

  const remove = () =>
    confirm({
      title: 'Remove the MMM dataset?',
      body:
        'The loaded file is deleted from MMM’s data folder and every MMM page goes back to its upload prompt. ' +
        'TPO’s data is not touched. This cannot be undone.',
      primaryText: 'Remove dataset',
      icon: 'alertTriangle',
      onConfirm: () =>
        reset.mutate(undefined, {
          onSuccess: () => {
            setNotes([])
            show('MMM dataset removed — upload a new file.', { duration: 3500 })
          },
          onError: (e) => setError(e instanceof ApiError ? e.message : "Couldn't reach the server."),
        }),
    })

  if (guide) return <MmmDataRequirements onBack={() => setGuide(false)} onClose={onClose} />
  if (viewing) return <MmmDataViewer onBack={() => setViewing(false)} onClose={onClose} />

  const s = status.data
  const check = picked?.check
  const referenceFound = check ? check.media.filter((m) => (MEDIA_CHANNELS as readonly string[]).includes(m)).length : 0
  const extraChannels = check ? check.media.length - referenceFound : 0

  return (
    <Modal open onClose={onClose} maxWidthClassName="max-w-[540px]">
      <div className="flex items-center justify-between border-b border-border-subtle p-[16px_20px]">
        <div className="flex items-center gap-2.5">
          <div className="grid h-9 w-9 place-items-center overflow-hidden rounded-[9px]">
            <BrandLogo logo="excel" name="Excel / Shared Drives" />
          </div>
          <div>
            <h3 className="text-md font-bold">{showDropzone ? 'Upload your MMM dataset' : 'Your MMM dataset'}</h3>
            <div className="mt-0.5 text-sm text-ink-muted">
              {showDropzone
                ? 'One daily file · columns are matched on their headers'
                : 'Loaded · view, replace or remove'}
            </div>
          </div>
        </div>
        <IconButton icon="x" onClick={onClose} />
      </div>

      <div className="max-h-[64vh] overflow-y-auto p-5">
        {status.isLoading && (
          <div className="flex items-center justify-center gap-2 py-8 text-sm text-ink-muted">
            <Spinner /> Checking what's loaded…
          </div>
        )}

        {/* ---------------- LOADED ---------------- */}
        {s && loaded && !replacing && (
          <>
            <div className="mb-3.5 flex items-start gap-2 rounded-[var(--r-md)] bg-status-success-bg p-[10px_12px] text-sm leading-[1.5] text-[#047857] [&_svg]:mt-px [&_svg]:h-[15px] [&_svg]:w-[15px] [&_svg]:shrink-0">
              <Icon name="checkCircle" />
              <span>
                Every MMM page is reading from this file. Uploading another file replaces it.
              </span>
            </div>
            <div className="rounded-[var(--r-md)] bg-surface-muted p-[12px_14px]">
              <div className="flex items-center gap-2.5">
                <Icon name="database" className="h-4 w-4 shrink-0 text-[#047857]" />
                <div className="min-w-0 flex-1">
                  <div className="truncate text-base font-semibold">{s.source_name ?? 'MMM daily dataset'}</div>
                  <div className="mt-px text-xs text-ink-muted">
                    {s.rows.toLocaleString()} days · {s.period.from} – {s.period.to} · {s.media_channels} media
                    channels · {fmtSize(s.size_bytes)}
                  </div>
                </div>
                <Button variant="secondary" size="sm" onClick={() => setViewing(true)}>
                  <Icon name="eye" /> View
                </Button>
              </div>
              <ul className="mt-3 grid grid-cols-2 gap-x-4 gap-y-1.5 border-t border-border-subtle pt-3 @max-[480px]:grid-cols-1">
                {s.files.map((g) => (
                  <li key={g.key} className="flex items-center gap-2 text-sm">
                    <Icon
                      name={g.present ? 'check' : 'info'}
                      className={`h-3.5 w-3.5 shrink-0 ${g.present ? 'text-[#047857]' : 'text-ink-muted'}`}
                    />
                    <span className={g.present ? 'text-ink-primary' : 'text-ink-muted'}>{g.label}</span>
                    <span className="ml-auto text-xs text-ink-muted">
                      {g.key === 'media' ? `${g.found} channels` : `${g.found}/${g.columns.length}`}
                    </span>
                  </li>
                ))}
              </ul>
            </div>
            {notes.length > 0 && <Notes notes={notes} />}
          </>
        )}

        {/* ---------------- DROPZONE ---------------- */}
        {!status.isLoading && showDropzone && (
          <>
            <div
              onClick={() => inputRef.current?.click()}
              onDragEnter={(e) => { e.preventDefault(); setDragging(true) }}
              onDragOver={(e) => { e.preventDefault(); setDragging(true) }}
              onDragLeave={(e) => { e.preventDefault(); setDragging(false) }}
              onDrop={(e) => { e.preventDefault(); setDragging(false); void choose(e.dataTransfer.files) }}
              className={`cursor-pointer rounded-[var(--r-lg)] border-2 border-dashed p-[24px_18px] text-center transition-colors ${
                dragging
                  ? 'border-brand-violet bg-brand-violet-50'
                  : 'border-border-strong hover:border-brand-violet hover:bg-brand-violet-50'
              }`}
            >
              <div className="mx-auto mb-2.5 grid h-10 w-10 place-items-center rounded-[10px] bg-tint-lavender text-tint-lavender-icon [&_svg]:h-5 [&_svg]:w-5">
                <Icon name="plus" />
              </div>
              <strong className="mb-1 block text-base">Click to choose a file, or drag it here</strong>
              <span className="text-sm text-ink-muted">
                One row per day · Date, Revenue and at least one _Spend column
              </span>
            </div>
            <input
              ref={inputRef}
              type="file"
              accept=".csv,.xlsx,.xls"
              className="hidden"
              onChange={(e) => { void choose(e.target.files); e.target.value = '' }}
            />
            <button
              type="button"
              onClick={() => setGuide(true)}
              className="mt-2.5 inline-flex items-center gap-1.5 text-sm font-bold text-brand-violet hover:underline [&_svg]:h-3.5 [&_svg]:w-3.5"
            >
              <Icon name="book" /> Not sure what to upload? See every column and download a template
            </button>

            {picked && (
              <div className="mt-3.5 rounded-[var(--r-md)] bg-surface-muted p-[10px_12px]">
                <div className="flex items-center gap-2.5">
                  <Icon
                    name={check?.ok ? 'check' : check ? 'info' : 'file'}
                    className={`h-4 w-4 shrink-0 ${check?.ok ? 'text-[#047857]' : check ? 'text-[#B91C1C]' : 'text-ink-muted'}`}
                  />
                  <span className="min-w-0 flex-1 truncate text-base font-semibold">{picked.file.name}</span>
                  <span className="shrink-0 text-xs text-ink-muted">{fmtSize(picked.file.size)}</span>
                  <button
                    type="button"
                    onClick={() => setPicked(null)}
                    aria-label="Remove file"
                    className="grid h-5 w-5 shrink-0 place-items-center rounded-full text-ink-muted hover:bg-status-danger-bg hover:text-[#B91C1C]"
                  >
                    <Icon name="x" className="h-3.5 w-3.5" />
                  </button>
                </div>

                {!check && !picked.checkError && (
                  <div className="mt-2 flex items-center gap-2 pl-[26px] text-xs text-ink-muted">
                    <Spinner className="h-3.5 w-3.5" /> Excel workbook — reading its columns on the server…
                  </div>
                )}
                {picked.checkError && (
                  <div className="mt-2 pl-[26px] text-xs text-[#B91C1C]">{picked.checkError}</div>
                )}

              </div>
            )}

            {/* WHAT THE FILE HOLDS, group by group — the rows TPO's dialog
                draws for its six files: a tick or a flag, the group, and in
                a line what was found or what is missing. */}
            {check && <GroupChecklist check={check} referenceFound={referenceFound} extraChannels={extraChannels} />}
          </>
        )}

        <InstallProgress
          active={upload.isPending}
          estimateMs={Math.max(3000, ((picked?.file.size ?? 0) / (2 * 1024 * 1024)) * 1000)}
          label="Uploading & validating"
          note="Every row is checked; the file is then written to MMM's data folder and every MMM page reloads from it."
        />

        {error && (
          <div className="mt-3.5 rounded-[var(--r-md)] bg-status-danger-bg p-[10px_12px] text-sm leading-[1.55] text-[#B91C1C]">
            {error}
          </div>
        )}
      </div>

      <div className="flex items-center justify-between gap-2 border-t border-border-subtle p-[14px_22px]">
        <span className="text-xs text-ink-muted">
          {loaded && !replacing ? `${s?.rows.toLocaleString()} days loaded` : '.csv, .xlsx or .xls'}
        </span>
        <div className="flex gap-2">
          {loaded && !replacing ? (
            <>
              <Button variant="ghost" onClick={remove} disabled={reset.isPending}>
                {reset.isPending ? 'Removing…' : 'Remove'}
              </Button>
              <Button variant="primary" onClick={() => setReplacing(true)}>
                <Icon name="refresh" /> Replace file
              </Button>
            </>
          ) : (
            <>
              <Button
                variant="ghost"
                onClick={() => (replacing ? (setReplacing(false), setPicked(null)) : onClose())}
              >
                Cancel
              </Button>
              <Button variant="primary" onClick={go} disabled={!check?.ok || upload.isPending}>
                <Icon name="plus" />{' '}
                {upload.isPending ? 'Loading dataset…' : check && !check.ok ? 'Fix the columns first' : 'Upload & Process'}
              </Button>
            </>
          )}
        </div>
      </div>
    </Modal>
  )
}

/** One row per column group, as TPO's upload dialog lists its six tables. */
function GroupChecklist({
  check,
  referenceFound,
  extraChannels,
}: {
  check: MmmHeaderCheck
  referenceFound: number
  extraChannels: number
}) {
  const promoAll = columnsIn('promo').map((c) => c.name)
  const flags = ['Festival_Flag', 'Seasonal_Flag', 'Promotion_Flag']
  const missingFlags = flags.filter((f) => !check.promo.includes(f))
  const calendarMissing = columnsIn('calendar').filter((c) => check.missingOptional.includes(c.name)).length
  const rows: Array<{ key: string; state: 'ok' | 'warn' | 'bad' | 'none'; title: string; detail: string; count?: string }> = [
    {
      key: 'core',
      state: check.missingRequired.length ? 'bad' : 'ok',
      title: 'Date & revenue',
      detail: check.missingRequired.length ? `Missing ${check.missingRequired.join(', ')} — required` : 'Date and Revenue found',
      count: `${2 - check.missingRequired.length}/2`,
    },
    {
      key: 'media',
      state: check.media.length ? 'ok' : 'bad',
      title: 'Media spend',
      detail: check.media.length
        ? `${referenceFound} of ${MEDIA_CHANNELS.length} reference channels` +
          (extraChannels ? ` · ${extraChannels} more _Spend column${extraChannels === 1 ? '' : 's'} read as channels` : '')
        : 'No _Spend column — at least one channel is required',
      count: `${check.media.length} channels`,
    },
    {
      key: 'rollup',
      state: check.rollups.length ? 'ok' : 'none',
      title: 'Channel totals',
      detail: check.rollups.length
        ? 'Checked against the sub-channels — never counted twice'
        : 'Optional — not in this file',
      count: check.rollups.length ? `${check.rollups.length} found` : undefined,
    },
    {
      key: 'promo',
      state: check.promo.length === promoAll.length ? 'ok' : missingFlags.length ? 'warn' : 'none',
      title: 'Promotions & events',
      detail:
        check.promo.length === promoAll.length
          ? 'Festival, Seasonal and Promotion flags, discount and offer'
          : missingFlags.length
            ? `Missing ${missingFlags.join(', ')} — the baseline needs all three flags`
            : `Missing ${promoAll.filter((c) => !check.promo.includes(c)).join(', ')}`,
      count: `${check.promo.length}/${promoAll.length}`,
    },
    {
      key: 'calendar',
      state: 'ok',
      title: 'Calendar fields',
      detail: calendarMissing ? `${calendarMissing} worked out from Date` : 'Month, Quarter, Week and Year found',
      count: `${4 - calendarMissing}/4`,
    },
  ]
  const tone = { ok: 'text-[#047857]', warn: 'text-[#B45309]', bad: 'text-[#B91C1C]', none: 'text-ink-muted' } as const
  const icon = { ok: 'check', warn: 'info', bad: 'x', none: 'info' } as const
  return (
    <div className="mt-2.5 flex flex-col gap-2">
      {rows.map((r) => (
        <div key={r.key} className="flex items-center gap-2.5 rounded-[var(--r-md)] bg-surface-muted p-[9px_12px]">
          <Icon name={icon[r.state]} className={`h-4 w-4 shrink-0 ${tone[r.state]}`} />
          <div className="min-w-0 flex-1">
            <div className="truncate text-base font-semibold">{r.title}</div>
            <div className={`mt-px text-xs leading-[1.45] ${r.state === 'ok' ? 'text-ink-muted' : tone[r.state]}`}>{r.detail}</div>
          </div>
          {r.count && <span className="shrink-0 text-xs text-ink-muted">{r.count}</span>}
        </div>
      ))}
      {check.ignored.length > 0 && (
        <div className="px-1 text-xs leading-[1.5] text-ink-muted">Not read by MMM, ignored: {check.ignored.join(', ')}</div>
      )}
    </div>
  )
}

function Notes({ notes }: { notes: string[] }) {
  return (
    <div className="mt-3 rounded-[var(--r-md)] border border-border-subtle p-[10px_12px] text-xs leading-[1.5] text-ink-muted">
      {notes.map((n) => (
        <div key={n}>{n}</div>
      ))}
    </div>
  )
}

/** The installed rows — the first 100 — the MMM twin of TPO's StarFileViewer. */
function MmmDataViewer({ onBack, onClose }: { onBack: () => void; onClose: () => void }) {
  const preview = useMmmPreview(100)
  const data = preview.data
  return (
    <Modal open onClose={onClose} maxWidthClassName="max-w-[min(1100px,94vw)]">
      <div className="flex items-center justify-between gap-3 border-b border-border-subtle p-[14px_20px]">
        <div className="flex min-w-0 items-center gap-2.5">
          <IconButton icon="chevronLeft" title="Back" onClick={onBack} />
          <div className="min-w-0">
            <h3 className="text-md font-bold">MMM daily dataset</h3>
            <div className="mt-0.5 text-sm text-ink-muted">
              {data ? `First ${data.rows.length} of ${data.total.toLocaleString()} days · ${data.columns.length} columns` : 'Loading…'}
            </div>
          </div>
        </div>
        <IconButton icon="x" onClick={onClose} />
      </div>
      <div className="max-h-[66vh] overflow-auto">
        {preview.isLoading ? (
          <div className="grid min-h-[200px] place-items-center">
            <Spinner />
          </div>
        ) : preview.isError ? (
          <div className="p-5 text-sm text-[#B91C1C]">{preview.error.message}</div>
        ) : (
          <table className="w-max border-collapse text-xs">
            <thead className="sticky top-0 bg-surface-card">
              <tr>
                {data?.columns.map((c) => (
                  <th key={c} className="whitespace-nowrap border-b border-border-default px-3 py-2 text-left font-semibold text-ink-muted">
                    {c}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {data?.rows.map((row, i) => (
                <tr key={i} className="border-b border-border-subtle">
                  {row.map((v, j) => (
                    <td key={j} className="whitespace-nowrap px-3 py-1.5 tabular-nums text-ink-secondary">
                      {v ?? ''}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </Modal>
  )
}
