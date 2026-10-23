import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { useIsFetching } from '@tanstack/react-query'
import { Icon } from '../../icons'
import { Spinner } from '../ui'

/** THE REFRESH POP-UP. While the Insights Hub reloads -- the Refresh button,
 *  or a new period from the calendar -- a small card says what is happening,
 *  how far along it is and roughly how long is left, then closes itself.
 *
 *  PROGRESS is read from the hub's own queries (every one is keyed under
 *  `command-center`): the share of the queries in flight at the start that
 *  have since landed. TIME LEFT is an estimate from how long the last few
 *  reloads took, remembered in this browser; the bar never claims more than
 *  the queries say, so it cannot reach the end before the data does.
 *
 *  A CENTRED DIALOG over a dimmed page, the same frame as the Sync now
 *  summary (SyncSummaryPanel).
 *
 *  IT ONLY APPEARS IF THERE IS A WAIT WORTH REPORTING. It used to open the
 *  instant a reload started and stay for a minimum of 1.2 seconds — so a
 *  period the browser already had cached, which renders in under 100ms, still
 *  cost the reader a second and a bit of dimmed page and a progress bar for
 *  work that was already done. The dialog made fast changes feel slow, which
 *  is the opposite of what a progress indicator is for.
 *
 *  So nothing is shown for GRACE_MS. If the data lands inside that window the
 *  page simply updates — which is the honest rendering of "that was instant".
 *  If it does not, the dialog opens and then obeys the minimum, because a
 *  dialog that flashes for 200ms at the END of a long wait is its own kind of
 *  noise. */

const KEY = 'tpo.refreshDurations'
const DEFAULT_MS = 4000
/** Below this, a reload is not worth a dialog: the page just updates. Chosen
 *  as roughly the point where a change stops reading as instant. */
const GRACE_MS = 350
/** Once it HAS opened, how long it stays, so it cannot flash. */
const MIN_SHOWN_MS = 700

function readDurations(): number[] {
  try {
    const raw = JSON.parse(localStorage.getItem(KEY) ?? '[]')
    return Array.isArray(raw) ? raw.filter((n) => typeof n === 'number' && n > 0) : []
  } catch {
    return []
  }
}

function remember(ms: number) {
  try {
    localStorage.setItem(KEY, JSON.stringify([...readDurations(), ms].slice(-5)))
  } catch {
    /* storage unavailable: the estimate falls back to the default */
  }
}

function estimateMs(): number {
  const d = readDurations()
  return d.length ? d.reduce((a, b) => a + b, 0) / d.length : DEFAULT_MS
}

/** `token` changes each time a reload starts; `title` says which kind. */
export function RefreshProgress({ token, title }: { token: number; title: string }) {
  const fetching = useIsFetching({ queryKey: ['command-center'] })
  const [run, setRun] = useState<{ started: number; estimate: number; peak: number } | null>(null)
  const [now, setNow] = useState(() => Date.now())
  const [done, setDone] = useState(false)
  const seenFetch = useRef(false)
  /** The dialog is on screen. A run can exist without this — that is the
   *  grace window, where the reload is tracked but nothing is drawn. */
  const [shown, setShown] = useState(false)
  const shownAt = useRef(0)

  // A new reload: start the clock. Nothing is drawn yet.
  useEffect(() => {
    if (!token) return
    seenFetch.current = false
    setDone(false)
    setShown(false)
    setRun({ started: Date.now(), estimate: estimateMs(), peak: 0 })
  }, [token])

  // Still going after the grace window? Then it is worth saying so.
  useEffect(() => {
    if (!run || shown) return
    const t = window.setTimeout(() => {
      shownAt.current = Date.now()
      setShown(true)
    }, GRACE_MS)
    return () => window.clearTimeout(t)
  }, [run, shown])

  // Track the queries in flight; close when they have all landed.
  useEffect(() => {
    if (!run) return
    if (fetching > 0) {
      seenFetch.current = true
      if (fetching > run.peak) setRun({ ...run, peak: fetching })
      return
    }
    // Nothing in flight. Wait briefly for the reload to begin; then finish —
    // immediately if the dialog was never drawn, or after its minimum if it
    // was, so it cannot flash.
    const elapsed = Date.now() - run.started
    const minimum = shown ? MIN_SHOWN_MS - (Date.now() - shownAt.current) : 0
    const wait = Math.max(seenFetch.current ? 0 : 600, minimum)
    const t = window.setTimeout(() => {
      if (seenFetch.current) remember(elapsed)
      if (!shown) {
        // It was never on screen, so there is nothing to close gracefully.
        setRun(null)
        return
      }
      setDone(true)
      window.setTimeout(() => setRun(null), 700)
    }, wait)
    return () => window.clearTimeout(t)
  }, [fetching, run, shown])

  // Tick the clock while open.
  useEffect(() => {
    if (!run || done) return
    const t = window.setInterval(() => setNow(Date.now()), 200)
    return () => window.clearInterval(t)
  }, [run, done])

  if (!run || !shown) return null

  const elapsed = Math.max(0, now - run.started)
  const byQueries = run.peak ? (run.peak - fetching) / run.peak : 0
  const byTime = Math.min(elapsed / run.estimate, 0.95)
  // The clock carries the bar between query landings; the queries cap it.
  const pct = done ? 100 : Math.round(Math.min(Math.max(byQueries, byTime), byQueries + (1 - byQueries) * 0.9) * 100)
  const leftS = Math.ceil(Math.max(0, run.estimate - elapsed) / 1000)
  // Every query has landed: the countdown is over whatever the estimate said.
  const landed = run.peak > 0 && fetching === 0
  const status = done ? 'Done' : landed || leftS <= 0 ? 'Almost done…' : `About ${leftS}s left`

  return createPortal(
    <div className="fade-in fixed inset-0 z-[130] grid place-items-center bg-[rgba(15,22,41,0.4)] p-4 backdrop-blur-[3px]">
      <div
        role="dialog"
        aria-modal="true"
        aria-live="polite"
        aria-label={done ? 'Data refreshed' : title}
        className="fade-in-up flex w-[420px] max-w-full flex-col overflow-hidden rounded-[var(--r-xl)] border border-border-default bg-surface-card shadow-[var(--shadow-lg)]"
      >
        <div className="h-1 shrink-0 bg-[linear-gradient(90deg,var(--brand-violet),var(--brand-blue),var(--status-success))]" />
        <div className="flex items-center gap-4 px-6 pb-5 pt-5">
          <span className="grid h-11 w-11 shrink-0 place-items-center rounded-full bg-brand-violet-50 text-brand-violet [&_svg]:h-5 [&_svg]:w-5">
            {done ? <Icon name="checkCircle" /> : <Spinner />}
          </span>
          <div className="min-w-0 flex-1">
            <div className="flex items-baseline justify-between gap-3">
              <span className="text-ink-primary">{done ? 'Data refreshed' : title}</span>
              <span className="shrink-0 text-ink-muted [font-variant-numeric:tabular-nums]">{pct}%</span>
            </div>
            <span className="mt-2.5 block h-1.5 overflow-hidden rounded-full bg-surface-muted">
              <span className="block h-full rounded-full bg-brand-violet transition-[width] duration-200" style={{ width: `${pct}%` }} />
            </span>
            <div className="mt-2 text-ink-muted [font-variant-numeric:tabular-nums]">{status}</div>
          </div>
        </div>
      </div>
    </div>,
    document.body,
  )
}
