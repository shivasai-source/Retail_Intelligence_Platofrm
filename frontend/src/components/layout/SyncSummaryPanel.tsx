import { useEffect } from 'react'
import { createPortal } from 'react-dom'
import { Icon } from '../../icons'
import { SourceMark } from './SyncOverlay'
import type { DataSnapshot, SourceSyncResult, StarInstalledFile } from '../../types/dataset'

// WHAT A SYNC CHANGED. A centred card once "Live · synced" has pulled the
// data, before -> now throughout:
//   * three headline tiles -- rows, period, weeks -- the value now, the value
//     before the sync beneath it (marked with a history icon), and the change
//     as a badge;
//   * coverage (products, stores, channels, promotions), before / now / change;
//   * the files: which were updated and which were not, updated first, each
//     with its rows before and now. No file sizes.
// DATA CHANGES ONLY -- no sales, spend or other KPI figures; those belong to
// the pages. Stays until the reader closes it (Close, the ×, Escape or a
// click outside). "Already up to date" when nothing moved.

const NUM = new Intl.NumberFormat('en-IN')
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

// Months and years only -- the app names periods that way, never by day.
const month = (iso: string | null) => (iso ? `${MONTHS[Number(iso.slice(5, 7)) - 1]} ${iso.slice(0, 4)}` : '—')
const span = (s: DataSnapshot) => `${month(s.first_day)} – ${month(s.last_day)}`
const monthIndex = (iso: string | null) => (iso ? Number(iso.slice(0, 4)) * 12 + Number(iso.slice(5, 7)) : 0)

/** What each table holds, by its star role. */
const ROLE_NAMES: Record<string, string> = {
  fact: 'Sales facts',
  product: 'Products',
  geo_store: 'Stores & geography',
  channel: 'Channels',
  promotion: 'Promotions',
  date: 'Calendar',
}
const ROLE_ORDER = ['fact', 'product', 'geo_store', 'promotion', 'channel', 'date']

type Tone = 'up' | 'down' | 'flat'

interface Change {
  label: string
  was: string
  now: string
  /** The change in words ("−81,900", "+1 month"), or null when nothing moved. */
  delta: string | null
  tone: Tone
}

function signed(d: number, unit = ''): string {
  return `${d > 0 ? '+' : '−'}${NUM.format(Math.abs(d))}${unit}`
}

function count(label: string, b: DataSnapshot | null, a: DataSnapshot, key: keyof DataSnapshot): Change {
  const now = a[key] as number
  const was = b ? (b[key] as number) : null
  const d = was === null ? 0 : now - was
  return { label, was: was === null ? '—' : NUM.format(was), now: NUM.format(now), delta: d ? signed(d) : null, tone: d > 0 ? 'up' : d < 0 ? 'down' : 'flat' }
}

function period(b: DataSnapshot | null, a: DataSnapshot): Change {
  const months = (s: DataSnapshot) => monthIndex(s.last_day) - monthIndex(s.first_day) + 1
  const d = b ? months(a) - months(b) : 0
  const moved = !!b && span(a) !== span(b)
  return {
    label: 'Period',
    was: b ? span(b) : '—',
    now: span(a),
    delta: moved ? (d ? signed(d, Math.abs(d) === 1 ? ' month' : ' months') : 'Shifted') : null,
    tone: d > 0 ? 'up' : d < 0 ? 'down' : 'flat',
  }
}

/** Nothing in the data's shape moved: the same rows, span and counts. */
export function unchanged(b: DataSnapshot | null, a: DataSnapshot | null): boolean {
  if (!b || !a) return false
  return (Object.keys(a) as (keyof DataSnapshot)[]).every((k) => a[k] === b[k])
}

const TONE_PILL: Record<Tone, string> = {
  up: 'bg-status-success-bg text-[var(--pill-success-ink)]',
  down: 'bg-status-danger-bg text-status-danger',
  flat: 'bg-surface-muted text-ink-muted',
}

function DeltaPill({ change }: { change: Change }) {
  return (
    <span className={`inline-flex items-center rounded-[var(--r-pill)] px-2 py-0.5 text-xs font-medium [font-variant-numeric:tabular-nums] ${TONE_PILL[change.delta ? change.tone : 'flat']}`}>
      {change.delta ?? 'No change'}
    </span>
  )
}

function SectionTitle({ children, aside }: { children: React.ReactNode; aside?: React.ReactNode }) {
  return (
    <div className="mb-2 mt-5 flex items-baseline justify-between gap-3">
      <span className="text-base font-medium text-ink-primary">{children}</span>
      {aside && <span className="text-sm text-ink-muted">{aside}</span>}
    </div>
  )
}

function FileRow({ file }: { file: StarInstalledFile }) {
  const status = file.changed === null || file.changed === undefined ? 'new' : file.changed ? 'updated' : 'same'
  const pill =
    status === 'updated'
      ? 'bg-brand-blue-50 text-brand-blue'
      : status === 'new'
        ? 'bg-status-success-bg text-[var(--pill-success-ink)]'
        : 'bg-surface-muted text-ink-muted'
  const n = (v: number | null | undefined) => (v == null ? '—' : NUM.format(v))
  return (
    <div className="grid grid-cols-[32px_minmax(0,1fr)_auto_96px] items-center gap-3 px-3 py-2.5">
      <span
        className={`grid h-8 w-8 place-items-center rounded-[var(--r-md)] [&_svg]:h-4 [&_svg]:w-4 ${
          status === 'same' ? 'bg-surface-muted text-ink-muted' : 'bg-brand-violet-50 text-brand-violet'
        }`}
      >
        <Icon name="database" />
      </span>
      <div className="min-w-0">
        <div className="text-base text-ink-primary">{ROLE_NAMES[file.role] ?? file.role}</div>
        <div className="truncate text-sm text-ink-muted" title={file.original_name}>
          {file.original_name}
        </div>
      </div>
      <div className="text-right text-sm [font-variant-numeric:tabular-nums]">
        {status === 'updated' ? (
          <>
            <span className="text-ink-muted">{n(file.previous_rows)}</span>
            <span className="px-1.5 text-ink-muted">→</span>
            <span className="text-ink-primary">{n(file.rows)}</span>
          </>
        ) : (
          <span className="text-ink-secondary">{n(file.rows)}</span>
        )}
        <div className="text-xs text-ink-muted">rows</div>
      </div>
      <span className={`justify-self-end rounded-[var(--r-pill)] px-2 py-0.5 text-xs font-medium ${pill}`}>
        {status === 'updated' ? 'Updated' : status === 'new' ? 'New' : 'No change'}
      </span>
    </div>
  )
}

export function SyncSummaryPanel({ kind, result, onClose }: { kind: string; result: SourceSyncResult; onClose: () => void }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose()
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [onClose])

  const after = result.after
  const before = result.before
  const files = [...(result.installed ?? [])].sort(
    (x, y) => Number(!!y.changed) - Number(!!x.changed) || ROLE_ORDER.indexOf(x.role) - ROLE_ORDER.indexOf(y.role),
  )
  const filesChanged = files.filter((f) => f.changed).length
  const same = unchanged(before, after) && filesChanged === 0
  const at = new Date(result.last_sync.at).toLocaleTimeString('en-IN', { hour: 'numeric', minute: '2-digit' })

  const tiles = after ? [count('Rows', before, after, 'rows'), period(before, after), count('Weeks', before, after, 'weeks')] : []
  const coverage = after
    ? [
        count('Products', before, after, 'products'),
        count('Stores', before, after, 'stores'),
        count('Channels', before, after, 'channels'),
        count('Promotions', before, after, 'promotions'),
      ]
    : []

  const added = result.rows - result.previous_rows
  const headline = !before
    ? `Loaded ${NUM.format(result.rows)} rows from ${result.source}.`
    : same
      ? `The platform already has the latest data from ${result.source}. Nothing new since the last sync.`
      : added !== 0 && after
        ? (
            <>
              {NUM.format(Math.abs(added))} {added > 0 ? 'more' : 'fewer'} rows · <span className="whitespace-nowrap text-ink-secondary">{span(before)}</span>
              <span className="px-1.5 text-ink-muted">→</span>
              <span className="whitespace-nowrap font-medium">{span(after)}</span>
            </>
          )
        : `${filesChanged} of ${files.length} files were updated at ${result.source}.`

  return createPortal(
    <div
      className="fade-in fixed inset-0 z-[130] grid place-items-center bg-[rgba(15,22,41,0.4)] p-4 backdrop-blur-[3px]"
      onClick={(e) => e.target === e.currentTarget && onClose()}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label="What the sync changed"
        className={`fade-in-up flex max-h-[calc(100vh-2rem)] ${same ? 'w-[480px]' : 'w-[620px]'} max-w-full flex-col overflow-hidden rounded-[var(--r-xl)] border border-border-default bg-surface-card shadow-[var(--shadow-lg)]`}
      >
        <div className="h-1 shrink-0 bg-[linear-gradient(90deg,var(--brand-violet),var(--brand-blue),var(--status-success))]" />

        {/* HEADER */}
        <div className="flex shrink-0 items-center gap-4 px-6 pb-4 pt-5">
          <SourceMark kind={kind} name={result.source} state="done" />
          <div className="min-w-0 flex-1">
            <div className="text-xl font-normal text-ink-primary">{same ? 'Already up to date' : 'Data synced'}</div>
            <div className="text-sm text-ink-muted">
              {result.source} · {at}
              {!same && files.length > 0 ? ` · ${filesChanged} of ${files.length} files updated` : ''}
            </div>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="grid h-8 w-8 shrink-0 cursor-pointer place-items-center self-start rounded-full text-ink-muted transition-colors hover:bg-surface-hover hover:text-ink-primary [&_svg]:h-4 [&_svg]:w-4"
          >
            <Icon name="x" />
          </button>
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto px-6 pb-5">
          <p
            className={`rounded-[var(--r-md)] border-l-4 px-3 py-2 text-base text-ink-primary ${
              same ? 'border-status-success bg-status-success-bg' : 'border-brand-blue bg-brand-blue-50'
            }`}
          >
            {headline}
          </p>

          {/* THE THREE THAT MATTER MOST: now, was, and the change */}
          {after && (
            <div className="mt-4 grid grid-cols-[1fr_1.45fr_1fr] gap-3">
              {tiles.map((t) => (
                <div key={t.label} className="rounded-[var(--r-lg)] border border-border-subtle px-3.5 py-3">
                  <div className="flex items-center justify-between gap-2">
                    <span className="text-sm text-ink-muted">{t.label}</span>
                    {!same && <DeltaPill change={t} />}
                  </div>
                  <div className={`mt-1.5 text-ink-primary ${t.label === 'Period' ? 'text-md [font-variant-numeric:tabular-nums]' : 'kpi-value'}`}>{t.now}</div>
                  {!same && (
                    <div className="mt-1 flex items-center gap-1 truncate text-sm text-ink-muted [&_svg]:h-3.5 [&_svg]:w-3.5 [&_svg]:shrink-0" title={`Before the sync: ${t.was}`}>
                      <Icon name="history" />
                      <span className="truncate">{t.was}</span>
                    </div>
                  )}
                </div>
              ))}
            </div>
          )}

          {!same && after && (
            <>
              {/* COVERAGE */}
              <SectionTitle aside={coverage.every((c) => !c.delta) ? 'No change' : undefined}>Coverage</SectionTitle>
              <div className="overflow-hidden rounded-[var(--r-lg)] border border-border-subtle">
                <table className="w-full text-base [font-variant-numeric:tabular-nums]">
                  <thead className="bg-surface-muted text-left text-sm text-ink-muted">
                    <tr>
                      <th className="px-3 py-2 font-medium">&nbsp;</th>
                      <th className="w-[96px] px-3 py-2 text-right font-medium">Before</th>
                      <th className="w-[96px] px-3 py-2 text-right font-medium">Now</th>
                      <th className="w-[120px] px-3 py-2 text-right font-medium">Change</th>
                    </tr>
                  </thead>
                  <tbody>
                    {coverage.map((c) => (
                      <tr key={c.label} className="border-t border-border-subtle">
                        <td className="whitespace-nowrap px-3 py-2 text-ink-secondary">{c.label}</td>
                        <td className="px-3 py-2 text-right text-ink-muted">{c.was}</td>
                        <td className="px-3 py-2 text-right text-ink-primary">{c.now}</td>
                        <td className="px-3 py-2 text-right">
                          <DeltaPill change={c} />
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </>
          )}

          {/* THE FILES: which changed, updated first */}
          {!same && files.length > 0 && (
            <>
              <SectionTitle aside={`${filesChanged} of ${files.length} updated`}>Files</SectionTitle>
              <div className="divide-y divide-border-subtle overflow-hidden rounded-[var(--r-lg)] border border-border-subtle">
                {files.map((f) => (
                  <FileRow key={f.filename} file={f} />
                ))}
              </div>
            </>
          )}
        </div>

        {/* FOOTER */}
        <div className="flex shrink-0 items-center justify-between gap-3 border-t border-border-subtle bg-surface-muted px-6 py-3">
          <span className="text-sm text-ink-muted">
            {same ? `All ${files.length || 'the'} files match what you had.` : 'Every page now reads the synced data.'}
          </span>
          <button
            type="button"
            onClick={onClose}
            className="h-9 cursor-pointer rounded-[var(--r-md)] bg-brand-violet px-5 text-base font-medium text-white transition-colors hover:bg-brand-violet-600"
          >
            Close
          </button>
        </div>
      </div>
    </div>,
    document.body,
  )
}
