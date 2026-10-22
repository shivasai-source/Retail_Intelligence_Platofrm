import { useRef, useState } from 'react'
import { Icon } from '../../icons'
import { BrandLogo, Button, IconButton, Modal, Spinner, useConfirm, useToast } from '../../components/ui'
import { InstallProgress } from '../../components/portal/modals/InstallProgress'
import { fmtSize } from '../../lib/portalConnectors'
import { readHeader } from '../../lib/starSchema'
import { ApiError } from '../../lib/api'
import { useMmmInspect, useMmmPreview, useMmmReset, useMmmStatus, useMmmUpload } from '../hooks'
import { MmmColumnMapper } from './MmmColumnMapper'
import type { MmmCoverage, MmmDeliveryInspect } from '../types'
import { checkFromInspect, checkHeader, columnsIn, MEDIA_CHANNELS, type MmmHeaderCheck } from '../schema'
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
// ONE TABLE, AND IT REPLACES — BUT IT CAN ARRIVE IN SEVERAL FILES. TPO
// installs six DIFFERENT tables as a set and makes you reset first. MMM has
// one table, so a selection of several files is several PERIODS of it
// ("Jan-Mar", "Apr-Jun"), merged on the day by the server
// (backend/app/mmm/day_union.py) and installed as the single daily table every
// MMM page reads. A new upload simply replaces the loaded one. With data
// loaded the dialog opens on what is installed — View data, Replace file,
// Remove — rather than on an empty dropzone.
//
// WHAT THE SCREEN OWES THE READER BEFORE AN INSTALL is what the merge is about
// to decide, because none of it is visible afterwards: which period each file
// covers, which days NOBODY sent (an absent month is not zero spend), which
// files repeat days, and which columns are not in every file and will
// therefore be left out rather than filled with zeros.
//
// A HEADER THAT IS NOT OURS IS MAPPED, NOT REFUSED. A client extract calling
// revenue `NetSales` used to be turned away as "Missing required column:
// Revenue" — a message about the wrong problem. Now the server is asked what
// the file's columns could mean (POST /api/mmm/dataset/inspect →
// app/mmm/mapping.py) and the reader confirms the mapping on MmmColumnMapper
// before anything is installed. A file that already uses MMM's names never
// sees that screen.

interface Picked {
  /** The delivery, in the order it was chosen. */
  files: File[]
  /** null while the server is reading the files. */
  check: MmmHeaderCheck | null
  checkError?: string
  /** The server's reading of the whole delivery: one entry per file with its
   *  own proposal, the coverage arithmetic, and whether the MERGED table would
   *  install. Absent for a single CSV whose header the browser read and found
   *  canonical — nothing needs mapping and there is nothing to merge, so
   *  nothing is asked. */
  delivery?: MmmDeliveryInspect
  /** The reader's confirmed renames, per filename. */
  mappings?: Record<string, Record<string, string>>
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
  /** On the mapping screen rather than the dropzone. */
  const [mapping, setMapping] = useState(false)
  /** Which file of the delivery the mapping screen is showing. */
  const [mappingFile, setMappingFile] = useState(0)

  const loaded = Boolean(status.data?.complete)
  const showDropzone = !loaded || replacing

  const choose = async (list: FileList | null) => {
    const files = [...(list ?? [])]
    if (!files.length) return
    setError('')
    setNotes([])
    setMapping(false)
    setMappingFile(0)

    // ONE CSV WHOSE HEADER IS ALREADY OURS needs neither the server nor the
    // mapping screen: the browser has read the names and they match, and a
    // single file has no periods to reconcile.
    if (files.length === 1) {
      const headers = await readHeader(files[0])
      if (headers.length && checkHeader(headers).ok) {
        setPicked({ files, check: checkHeader(headers) })
        return
      }
    }
    // Anything else goes to the server: a workbook it must open, a header that
    // does not match as it stands, or SEVERAL FILES, whose spans and repeats
    // only the rows can answer. `coverage` is asked for once per selection,
    // not on every edit — it reads every row.
    setPicked({ files, check: null })
    inspect.mutate(
      { files, coverage: files.length > 1 },
      {
        onSuccess: (r) => setPicked({ files, check: checkFromInspect(r), delivery: r }),
        onError: (e) => setPicked({ files, check: null, checkError: e.message }),
      },
    )
  }

  /** Re-ask the server with the mapping as it stands, so the verdict under the
   *  rows is the install's own and not this screen's opinion. */
  const recheck = (mappings: Record<string, Record<string, string>>) => {
    if (!picked) return
    inspect.mutate(
      { files: picked.files, mappings, coverage: picked.files.length > 1 },
      {
        onSuccess: (r) =>
          setPicked((prev) =>
            prev ? { ...prev, check: checkFromInspect(r), delivery: r, mappings } : prev,
          ),
        onError: (e) => setError(e.message),
      },
    )
  }

  const go = (mappings?: Record<string, Record<string, string>>) => {
    if (!picked) return
    setError('')
    upload.mutate({ files: picked.files, mappings: mappings ?? picked.mappings }, {
      onSuccess: (result) => {
        const from = picked.files.length > 1 ? ` from ${picked.files.length} files` : ''
        show(
          `MMM dataset loaded${from} — ${result.rows.toLocaleString()} days, ${result.media_columns.length} channels.`,
          { duration: 4000 },
        )
        setNotes(result.warnings)
        setPicked(null)
        setReplacing(false)
        setMapping(false)
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

  // THE MAPPING SCREEN. Its own view rather than a section of the dropzone:
  // it is a decision about every column in the file, and reading it next to a
  // drop target invites dropping another file half way through.
  //
  // ONE FILE AT A TIME, with a switcher when the delivery has several. A
  // client who renamed a column half way through the year is the ordinary
  // case, so each file keeps its OWN mapping and the screen never applies one
  // file's answer to another's columns. The tick on a tab is the file's own
  // verdict; the line under the tabs is the delivery's, which is what the
  // install actually judges.
  if (mapping && picked?.delivery) {
    const files = picked.delivery.files
    const current = files[Math.min(mappingFile, files.length - 1)]
    const confirmed = picked.mappings ?? {}
    return (
      <Modal open onClose={onClose} maxWidthClassName="max-w-[640px]">
        <div className="flex items-center justify-between border-b border-border-subtle p-[16px_20px]">
          <div className="flex items-center gap-2.5">
            <div className="grid h-9 w-9 place-items-center overflow-hidden rounded-[9px]">
              <BrandLogo logo="excel" name="Excel / Shared Drives" />
            </div>
            <div>
              <h3 className="text-md font-medium">Match your columns to MMM's</h3>
              <div className="mt-0.5 text-sm text-ink-muted">
                {files.length > 1
                  ? `${files.length} files · each keeps its own column names`
                  : current.filename}{' '}
                · nothing is read until you confirm
              </div>
            </div>
          </div>
          <IconButton icon="x" onClick={onClose} />
        </div>

        {files.length > 1 && (
          <div className="flex flex-wrap items-center gap-1.5 border-b border-border-subtle px-5 py-2.5">
            {files.map((f, i) => (
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
             rather than carrying the last file's choices across. */
          key={current.filename}
          inspection={current}
          busy={upload.isPending || inspect.isPending}
          deliveryOk={picked.delivery.ok}
          deliveryProblems={picked.delivery.problems}
          onBack={() => setMapping(false)}
          onTry={(renames) => recheck({ ...confirmed, [current.filename]: renames })}
          onConfirm={(renames) => {
            const next = { ...confirmed, [current.filename]: renames }
            setPicked((prev) => (prev ? { ...prev, mappings: next } : prev))
            // More files still to map: move on rather than installing.
            const unmapped = files.findIndex((f, i) => i !== mappingFile && !f.ok && !next[f.filename])
            if (unmapped >= 0) {
              setMappingFile(unmapped)
              recheck(next)
              return
            }
            go(next)
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

  const s = status.data
  const check = picked?.check
  /** Files the install would SKIP as they stand — unreadable, or missing a
   *  column MMM needs that nothing maps to. Named here because the delivery
   *  can be installable while a file in it is not. */
  const skipped = (picked?.delivery?.files ?? []).filter((f) => !f.ok)
  /** Whether the mapping screen is worth offering at all. */
  const needsMapping = Boolean(picked?.delivery) && (!check?.ok || skipped.length > 0)
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
            <h3 className="text-md font-medium">{showDropzone ? 'Upload your MMM dataset' : 'Your MMM dataset'}</h3>
            <div className="mt-0.5 text-sm text-ink-muted">
              {showDropzone
                ? picked && picked.files.length > 1
                  ? `${picked.files.length} files · read as ${picked.files.length} periods of one table`
                  : 'One daily table · one file, or several periods'
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
            <div className="mb-3.5 flex items-start gap-2 rounded-[var(--r-md)] bg-status-success-bg p-[10px_12px] text-sm leading-[1.5] text-[var(--pill-success-ink)] [&_svg]:mt-px [&_svg]:h-[15px] [&_svg]:w-[15px] [&_svg]:shrink-0">
              <Icon name="checkCircle" />
              <span>
                Every MMM page is reading from this file. Uploading another file replaces it.
              </span>
            </div>
            <div className="rounded-[var(--r-md)] bg-surface-muted p-[12px_14px]">
              <div className="flex items-center gap-2.5">
                <Icon name="database" className="h-4 w-4 shrink-0 text-[var(--pill-success-ink)]" />
                <div className="min-w-0 flex-1">
                  <div className="truncate text-base font-medium">{s.source_name ?? 'MMM daily dataset'}</div>
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
                      className={`h-3.5 w-3.5 shrink-0 ${g.present ? 'text-[var(--pill-success-ink)]' : 'text-ink-muted'}`}
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
              <strong className="mb-1 block text-base">
                Click to choose files, or drag them here
              </strong>
              <span className="text-sm text-ink-muted">
                One row per day · Date, Revenue and at least one _Spend column. Several files are
                read as several periods of one table.
              </span>
            </div>
            <input
              ref={inputRef}
              type="file"
              accept=".csv,.xlsx,.xls"
              multiple
              className="hidden"
              onChange={(e) => { void choose(e.target.files); e.target.value = '' }}
            />
            <button
              type="button"
              onClick={() => setGuide(true)}
              className="mt-2.5 inline-flex items-center gap-1.5 text-sm font-medium text-brand-violet hover:underline [&_svg]:h-3.5 [&_svg]:w-3.5"
            >
              <Icon name="book" /> Not sure what to upload? See every column and download a template
            </button>

            {picked && (
              <div className="mt-3.5 flex flex-col gap-1.5">
                {picked.files.map((file, i) => {
                  const span = picked.delivery?.coverage?.files.find(
                    (f) => f.filename === file.name,
                  )
                  const own = picked.delivery?.files[i]
                  return (
                    <div key={file.name} className="rounded-[var(--r-md)] bg-surface-muted p-[10px_12px]">
                      <div className="flex items-center gap-2.5">
                        <Icon
                          name={span?.unreadable ? 'x' : own ? (own.ok ? 'check' : 'info') : check?.ok ? 'check' : 'file'}
                          className={`h-4 w-4 shrink-0 ${
                            span?.unreadable
                              ? 'text-[var(--pill-danger-ink)]'
                              : own?.ok || (!own && check?.ok)
                                ? 'text-[var(--pill-success-ink)]'
                                : own
                                  ? 'text-[var(--pill-warning-ink)]'
                                  : 'text-ink-muted'
                          }`}
                        />
                        <span className="min-w-0 flex-1 truncate text-base font-medium" title={file.name}>
                          {file.name}
                        </span>
                        <span className="shrink-0 text-xs text-ink-muted">{fmtSize(file.size)}</span>
                        <button
                          type="button"
                          onClick={() => {
                            const left = picked.files.filter((f) => f !== file)
                            if (!left.length) setPicked(null)
                            else void choose(left as unknown as FileList)
                          }}
                          aria-label={`Remove ${file.name}`}
                          className="grid h-5 w-5 shrink-0 place-items-center rounded-full text-ink-muted hover:bg-status-danger-bg hover:text-[var(--pill-danger-ink)]"
                        >
                          <Icon name="x" className="h-3.5 w-3.5" />
                        </button>
                      </div>
                      {/* WHAT PERIOD THIS FILE HOLDS — the whole reason several
                          files are allowed, so it is said per file. */}
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
                      {span?.unreadable && (
                        <div className="mt-1 pl-[26px] text-xs text-[var(--pill-danger-ink)]">
                          {span.error || 'MMM cannot read this file; it will be skipped.'}
                        </div>
                      )}
                    </div>
                  )
                })}

                {inspect.isPending && (
                  <div className="flex items-center gap-2 px-1 text-xs text-ink-muted">
                    <Spinner className="h-3.5 w-3.5" />{' '}
                    {picked.files.length > 1
                      ? 'Reading each file’s columns and period on the server…'
                      : 'Reading the columns on the server…'}
                  </div>
                )}
                {picked.checkError && (
                  <div className="px-1 text-xs text-[var(--pill-danger-ink)]">{picked.checkError}</div>
                )}
              </div>
            )}

            {/* THE DELIVERY, AS THE MERGE WILL SEE IT. None of this is visible
                after the install, so it is said before. */}
            {picked?.delivery?.coverage && <CoveragePanel coverage={picked.delivery.coverage} />}

            {/* WHAT THE FILE HOLDS, group by group — the rows TPO's dialog
                draws for its six files: a tick or a flag, the group, and in
                a line what was found or what is missing. */}
            {check && <GroupChecklist check={check} referenceFound={referenceFound} extraChannels={extraChannels} />}

            {/* A FILE THE INSTALL WOULD LEAVE OUT, while the rest of the
                delivery is fine. Said plainly: it is the one case where
                everything looks right and a quarter of the history is
                silently absent. */}
            {check?.ok && skipped.length > 0 && (
              <div className="mt-2.5 flex items-start gap-2 rounded-[var(--r-md)] bg-status-warning-bg p-[10px_12px] text-sm leading-[1.5] text-[var(--pill-warning-ink)] [&_svg]:mt-px [&_svg]:h-[15px] [&_svg]:w-[15px] [&_svg]:shrink-0">
                <Icon name="warning" />
                <span>
                  The rest of this delivery will load, but{' '}
                  <strong className="font-medium">
                    {skipped.map((f) => f.filename).join(', ')}
                  </strong>{' '}
                  {skipped.length === 1 ? 'does' : 'do'} not match the contract and would be left
                  out. Match {skipped.length === 1 ? 'its' : 'their'} columns, or upload without{' '}
                  {skipped.length === 1 ? 'it' : 'them'}.
                </span>
              </div>
            )}

            {/* WHAT TO DO ABOUT A HEADER THAT IS NOT OURS. Said here rather
                than only on the button, because the checklist above it reads
                as a refusal otherwise. */}
            {picked?.delivery && !check?.ok && (
              <div className="mt-2.5 flex items-start gap-2 rounded-[var(--r-md)] bg-surface-muted p-[10px_12px] text-sm leading-[1.5] text-ink-muted [&_svg]:mt-px [&_svg]:h-[15px] [&_svg]:w-[15px] [&_svg]:shrink-0">
                <Icon name="info" />
                <span>
                  This file uses its own column names.{' '}
                  {picked.delivery.files.every((f) => f.proposal.is_complete)
                    ? 'MMM has matched every column it needs — check the mapping and confirm it.'
                    : 'Match them to MMM’s columns and it can be loaded.'}
                </span>
              </div>
            )}
          </>
        )}

        <InstallProgress
          active={upload.isPending}
          estimateMs={Math.max(
            3000,
            ((picked?.files ?? []).reduce((sum, f) => sum + f.size, 0) / (2 * 1024 * 1024)) * 1000,
          )}
          label="Uploading & validating"
          note="Every row is checked; the file is then written to MMM's data folder and every MMM page reloads from it."
        />

        {error && (
          <div className="mt-3.5 rounded-[var(--r-md)] bg-status-danger-bg p-[10px_12px] text-sm leading-[1.55] text-[var(--pill-danger-ink)]">
            {error}
          </div>
        )}
      </div>

      <div className="flex items-center justify-between gap-2 border-t border-border-subtle p-[14px_22px]">
        <span className="text-xs text-ink-muted">
          {loaded && !replacing
            ? `${s?.rows.toLocaleString()} days loaded`
            : picked && picked.files.length > 1
              ? `${picked.files.length} files${picked.delivery?.coverage ? ` · ${picked.delivery.coverage.days.toLocaleString()} days` : ''}`
              : '.csv, .xlsx or .xls'}
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
              {/* A file whose header is not ours is not a dead end any more:
                  the same button leads to the mapping screen instead. */}
              {needsMapping && (
                <Button
                  variant={check?.ok ? 'secondary' : 'primary'}
                  onClick={() => {
                    const first = picked!.delivery!.files.findIndex((f) => !f.ok)
                    setMappingFile(first < 0 ? 0 : first)
                    setMapping(true)
                  }}
                  disabled={inspect.isPending || upload.isPending}
                >
                  <Icon name="arrowRight" /> Match columns
                </Button>
              )}
              {(!needsMapping || check?.ok) && (
                <Button variant="primary" onClick={() => go()} disabled={!check?.ok || upload.isPending}>
                  <Icon name="plus" />{' '}
                  {upload.isPending
                    ? 'Loading dataset…'
                    : skipped.length > 0
                      ? `Upload without ${skipped.length === 1 ? 'it' : 'them'}`
                      : 'Upload & Process'}
                </Button>
              )}
            </>
          )}
        </div>
      </div>
    </Modal>
  )
}

/** WHAT THE MERGE IS ABOUT TO DO, before it does it.
 *
 *  Three things, each of which is invisible once the install has happened and
 *  each of which is a silent wrong number if nobody says it:
 *
 *    the SPAN      what the delivery covers end to end, and how many days;
 *    the GAPS      days inside that span nobody sent — an absent month is not
 *                  zero spend, and MMM derives its calendar from Date itself,
 *                  so a missing October would simply cease to exist;
 *    the REPEATS   days in more than one file, counted once, later period
 *                  winning — and how many of those disagreed, which is a data
 *                  problem the reader should know they have;
 *    the COLUMNS   not in every file, so left out rather than filled with
 *                  zeros — a channel that looks switched off for one quarter
 *                  moves its whole response curve.
 *
 *  Exported because the source browser shows the same panel for a selection of
 *  blobs or tables: the merge does not care how the periods arrived. */
export function CoveragePanel({ coverage }: { coverage: MmmCoverage }) {
  const readable = coverage.files.filter((f) => !f.unreadable)
  if (!readable.length) return null
  return (
    <div className="mt-3 rounded-[var(--r-md)] border border-border-subtle p-[11px_13px]">
      <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
        <span className="text-base font-medium">
          {readable.length === 1 ? 'This file covers' : `These ${readable.length} files cover`}
        </span>
        <span className="text-sm text-ink-muted [font-variant-numeric:tabular-nums]">
          {coverage.first} – {coverage.last} · {coverage.days.toLocaleString()} days
        </span>
      </div>

      {coverage.gaps.length > 0 && (
        <div className="mt-2 flex items-start gap-2 rounded-[var(--r-md)] bg-status-warning-bg p-[9px_11px] text-xs leading-[1.5] text-[var(--pill-warning-ink)] [&_svg]:mt-px [&_svg]:h-[14px] [&_svg]:w-[14px] [&_svg]:shrink-0">
          <Icon name="warning" />
          <span>
            <strong className="font-medium">
              Nobody sent {coverage.gaps.length === 1 ? 'these days' : 'these runs of days'}:
            </strong>{' '}
            {coverage.gaps.join('; ')}. They will be absent rather than zero, and the baseline is
            estimated over the days that are there.
          </span>
        </div>
      )}

      {coverage.overlaps.length > 0 && (
        <div className="mt-2 flex items-start gap-2 text-xs leading-[1.5] text-ink-muted [&_svg]:mt-px [&_svg]:h-[14px] [&_svg]:w-[14px] [&_svg]:shrink-0">
          <Icon name="info" />
          <span>
            {coverage.overlaps.join('; ')} — counted once, keeping the later period's version.
            {coverage.conflicting_rows > 0 && (
              <>
                {' '}
                <strong className="font-medium text-[var(--pill-warning-ink)]">
                  {coverage.conflicting_rows.toLocaleString()} of them disagree about their figures.
                </strong>
              </>
            )}
          </span>
        </div>
      )}

      {coverage.dropped_columns.length > 0 && (
        <div className="mt-2 flex items-start gap-2 text-xs leading-[1.5] text-ink-muted [&_svg]:mt-px [&_svg]:h-[14px] [&_svg]:w-[14px] [&_svg]:shrink-0">
          <Icon name="info" />
          <span>
            Not in every file, so left out rather than filled with zeros:{' '}
            {coverage.dropped_columns.join(', ')}.
          </span>
        </div>
      )}

      {!coverage.has_warnings && readable.length > 1 && (
        <div className="mt-2 flex items-start gap-2 text-xs leading-[1.5] text-ink-muted [&_svg]:mt-px [&_svg]:h-[14px] [&_svg]:w-[14px] [&_svg]:shrink-0">
          <Icon name="check" />
          <span>Continuous, no repeated days, and every file holds the same columns.</span>
        </div>
      )}
    </div>
  )
}

/** One row per column group, as TPO's upload dialog lists its six tables.
 *  Exported because the source browser shows the same checklist for a blob or
 *  a warehouse table — the contract does not change with the transport. */
export function GroupChecklist({
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
  const tone = { ok: 'text-[var(--pill-success-ink)]', warn: 'text-[var(--pill-warning-ink)]', bad: 'text-[var(--pill-danger-ink)]', none: 'text-ink-muted' } as const
  const icon = { ok: 'check', warn: 'info', bad: 'x', none: 'info' } as const
  return (
    <div className="mt-2.5 flex flex-col gap-2">
      {rows.map((r) => (
        <div key={r.key} className="flex items-center gap-2.5 rounded-[var(--r-md)] bg-surface-muted p-[9px_12px]">
          <Icon name={icon[r.state]} className={`h-4 w-4 shrink-0 ${tone[r.state]}`} />
          <div className="min-w-0 flex-1">
            <div className="truncate text-base font-medium">{r.title}</div>
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
            <h3 className="text-md font-medium">MMM daily dataset</h3>
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
          <div className="p-5 text-sm text-[var(--pill-danger-ink)]">{preview.error.message}</div>
        ) : (
          <table className="w-max border-collapse text-xs">
            <thead className="sticky top-0 bg-surface-card">
              <tr>
                {data?.columns.map((c) => (
                  <th key={c} className="whitespace-nowrap border-b border-border-default px-3 py-2 text-left font-medium text-ink-muted">
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
