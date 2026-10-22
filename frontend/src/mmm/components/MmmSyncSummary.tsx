import { useEffect } from 'react'
import { createPortal } from 'react-dom'
import { Icon } from '../../icons'
import { SourceMark } from '../../components/layout/SyncOverlay'
import type { MmmDataSnapshot, MmmSyncResult } from '../types'

// WHAT A SYNC CHANGED, for MMM. The same card TPO's sync puts up
// (components/layout/SyncSummaryPanel) — the same frame, the same gradient
// hairline, the same "before → now" throughout, the same SourceMark — over
// MMM's one table instead of TPO's six:
//
//   * three headline tiles: days, period, media channels;
//   * the value now, the value before the sync beneath it (marked with a
//     history icon), and the change as a badge;
//   * "Already up to date" when nothing moved.
//
// DATA CHANGES ONLY — no revenue, spend or any other figure. Those belong to
// the pages, and a summary that quoted them would be a second place for a
// number to be wrong.
//
// Why not reuse TPO's panel outright: it is built around a star schema — six
// files by role, products, stores, channels, promotions. None of that exists
// here, and the half that does (days, period) would have been the only half
// drawn. What IS shared is the furniture.

const NUM = new Intl.NumberFormat('en-IN')
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

/** MMM's dates come back as DD-MM-YYYY, the format it installs them in. */
function monthLabel(ddmmyyyy: string | null): string {
  if (!ddmmyyyy) return '—'
  const [, month, year] = ddmmyyyy.split('-')
  const index = Number(month) - 1
  return MONTHS[index] ? `${MONTHS[index]} ${year}` : ddmmyyyy
}

const span = (s: MmmDataSnapshot) => `${monthLabel(s.first_day)} – ${monthLabel(s.last_day)}`

function monthIndex(ddmmyyyy: string | null): number {
  if (!ddmmyyyy) return 0
  const [, month, year] = ddmmyyyy.split('-')
  return Number(year) * 12 + Number(month)
}

type Tone = 'up' | 'down' | 'flat'

interface Change {
  label: string
  was: string
  now: string
  /** The change in words ("+4", "+1 month"), or null when nothing moved. */
  delta: string | null
  tone: Tone
}

const signed = (d: number, unit = '') => `${d > 0 ? '+' : '−'}${NUM.format(Math.abs(d))}${unit}`

function count(label: string, before: MmmDataSnapshot, after: MmmDataSnapshot,
               key: 'rows' | 'media_channels'): Change {
  const d = after[key] - before[key]
  return {
    label,
    was: NUM.format(before[key]),
    now: NUM.format(after[key]),
    delta: d ? signed(d) : null,
    tone: d > 0 ? 'up' : d < 0 ? 'down' : 'flat',
  }
}

function period(before: MmmDataSnapshot, after: MmmDataSnapshot): Change {
  const months = (s: MmmDataSnapshot) => monthIndex(s.last_day) - monthIndex(s.first_day) + 1
  const d = months(after) - months(before)
  const moved = span(after) !== span(before)
  return {
    label: 'Period',
    was: span(before),
    now: span(after),
    delta: moved ? (d ? signed(d, Math.abs(d) === 1 ? ' month' : ' months') : 'Shifted') : null,
    tone: d > 0 ? 'up' : d < 0 ? 'down' : 'flat',
  }
}

function DeltaPill({ change }: { change: Change }) {
  if (!change.delta) return <span className="text-sm text-ink-muted">—</span>
  const tone =
    change.tone === 'up'
      ? 'bg-status-success-bg text-[var(--pill-success-ink)]'
      : change.tone === 'down'
        ? 'bg-status-danger-bg text-[var(--pill-danger-ink)]'
        : 'bg-surface-muted text-ink-muted'
  return (
    <span
      className={`inline-flex items-center rounded-[var(--r-pill)] px-2 py-0.5 text-sm font-medium [font-variant-numeric:tabular-nums] ${tone}`}
    >
      {change.delta}
    </span>
  )
}

/** True when the sync found nothing new. Said plainly rather than drawn as a
 *  table of zeroes. */
export function unchanged(before: MmmDataSnapshot, after: MmmDataSnapshot): boolean {
  return (
    before.rows === after.rows &&
    before.media_channels === after.media_channels &&
    before.first_day === after.first_day &&
    before.last_day === after.last_day
  )
}

export function MmmSyncSummary({
  result,
  onClose,
}: {
  result: MmmSyncResult
  onClose: () => void
}) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose()
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  const { before, after } = result
  const same = unchanged(before, after)
  const tiles: Change[] = [
    count('Days', before, after, 'rows'),
    period(before, after),
    count('Media channels', before, after, 'media_channels'),
  ]
  const at = new Date(result.synced_at).toLocaleString(undefined, {
    day: 'numeric',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
  })
  const addedDays = after.rows - before.rows
  const headline = same
    ? `${result.source} holds exactly what you already had — ${NUM.format(after.rows)} days.`
    : addedDays > 0
      ? `${NUM.format(addedDays)} more ${addedDays === 1 ? 'day' : 'days'} came in — ${NUM.format(before.rows)} → ${NUM.format(after.rows)}.`
      : `The source now holds ${NUM.format(after.rows)} days, from ${NUM.format(before.rows)}.`

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

        <div className="flex shrink-0 items-center gap-4 px-6 pb-4 pt-5">
          <SourceMark
            kind={result.kind === 'azure' ? 'azure' : 'databricks'}
            name={result.source}
            state="done"
          />
          <div className="min-w-0 flex-1">
            <div className="text-xl font-normal text-ink-primary">
              {same ? 'Already up to date' : 'Data synced'}
            </div>
            <div className="truncate text-sm text-ink-muted" title={result.item}>
              {result.source} · {result.item} · {at}
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

          <div className="mt-4 grid grid-cols-[1fr_1.45fr_1fr] gap-3">
            {tiles.map((t) => (
              <div key={t.label} className="rounded-[var(--r-lg)] border border-border-subtle px-3.5 py-3">
                <div className="flex items-center justify-between gap-2">
                  <span className="text-sm text-ink-muted">{t.label}</span>
                  {!same && <DeltaPill change={t} />}
                </div>
                <div
                  className={`mt-1.5 text-ink-primary ${
                    t.label === 'Period' ? 'text-md [font-variant-numeric:tabular-nums]' : 'kpi-value'
                  }`}
                >
                  {t.now}
                </div>
                {!same && (
                  <div
                    className="mt-1 flex items-center gap-1 truncate text-sm text-ink-muted [&_svg]:h-3.5 [&_svg]:w-3.5 [&_svg]:shrink-0"
                    title={`Before the sync: ${t.was}`}
                  >
                    <Icon name="history" />
                    <span className="truncate">{t.was}</span>
                  </div>
                )}
              </div>
            ))}
          </div>

          {result.warnings.length > 0 && (
            <div className="mt-4 rounded-[var(--r-lg)] border border-border-subtle p-[11px_13px] text-sm leading-[1.5] text-ink-muted">
              {result.warnings.map((w) => (
                <div key={w}>{w}</div>
              ))}
            </div>
          )}
        </div>

        <div className="flex shrink-0 items-center justify-between gap-3 border-t border-border-subtle bg-surface-muted px-6 py-3">
          <span className="text-sm text-ink-muted">
            {same ? 'Nothing changed, so nothing reloaded.' : 'Every MMM page now reads the synced data.'}
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
