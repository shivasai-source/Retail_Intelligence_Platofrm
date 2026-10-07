import { useEffect, useRef, useState } from 'react'
import { Icon } from '../../../icons'

// The progress strip shown while a dataset is being loaded, on all three
// connectors (Excel upload, Azure, Databricks).
//
// THE PERCENTAGE IS AN ESTIMATE AND SAYS SO. The install is one blocking
// request — the server streams no progress back — so there is no true
// completion figure to report. Claiming an exact one would be inventing it.
// What this does instead is honest and still useful: it counts real elapsed
// time, shows it, and eases a bar towards the estimate so the user can see the
// request is alive and roughly how much longer it has. The bar approaches but
// never reaches the end on its own; only `done` fills it.
//
// The curve is deliberately asymptotic rather than linear. A linear bar that
// hits 100% and then sits there is worse than no bar at all — it reads as
// "finished, but frozen". This one decelerates, so overrunning the estimate
// looks like slow progress, which is what it is.

/** Fraction complete for `elapsed` against `estimate`, easing out to CEILING. */
const CEILING = 0.94
function eased(elapsed: number, estimate: number): number {
  if (estimate <= 0) return 0
  // 1 - e^(-kt) reaches ~86% of CEILING at t = estimate, then keeps crawling.
  return CEILING * (1 - Math.exp(-2 * (elapsed / estimate)))
}

function fmtDuration(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000))
  if (s < 60) return `${s}s`
  return `${Math.floor(s / 60)}m ${String(s % 60).padStart(2, '0')}s`
}

export function InstallProgress({
  active,
  done = false,
  estimateMs,
  label,
  note,
  measured,
}: {
  /** True while the request is in flight. Resets the clock on each new run. */
  active: boolean
  /** Fills the bar to 100% — set once the request has actually returned. */
  done?: boolean
  /** Rough expected duration, used only to shape the bar and the "~left" hint. */
  estimateMs: number
  /** What is happening, e.g. "Downloading from Azure". */
  label: string
  /** Optional second line — why it takes as long as it does. */
  note?: string
  /** REAL progress, when the server reports it (the Azure install does). It
   *  replaces the time-based estimate: the bar shows `fraction`, the label
   *  says which stage is running, and `detail` takes the "~left" slot. */
  measured?: { fraction: number; label: string; detail: string } | null
}) {
  const [elapsed, setElapsed] = useState(0)
  const startedAt = useRef<number | null>(null)

  useEffect(() => {
    if (!active) {
      startedAt.current = null
      setElapsed(0)
      return
    }
    startedAt.current = Date.now()
    setElapsed(0)
    // 250ms is frequent enough to feel live without repainting needlessly.
    const id = setInterval(() => {
      if (startedAt.current !== null) setElapsed(Date.now() - startedAt.current)
    }, 250)
    return () => clearInterval(id)
  }, [active])

  if (!active && !done) return null

  // A measured figure is held under 100% until the request has actually
  // returned, so "100%" always means finished.
  const fraction = done ? 1 : measured ? Math.min(measured.fraction, 0.99) : eased(elapsed, estimateMs)
  const pct = Math.round(fraction * 100)
  const shownLabel = measured && !done ? measured.label : label
  const remaining = estimateMs - elapsed

  return (
    <div className="mt-3.5 rounded-[var(--r-md)] bg-surface-muted p-[11px_13px]">
      <div className="mb-2 flex items-center gap-2">
        <span className="text-brand-violet [&_svg]:h-[15px] [&_svg]:w-[15px]">
          <Icon name={done ? 'checkCircle' : 'download'} />
        </span>
        <span className="min-w-0 flex-1 truncate text-sm font-bold">{done ? 'Loaded' : shownLabel}</span>
        <span className="shrink-0 text-sm font-bold tabular-nums text-brand-violet">{pct}%</span>
      </div>

      <div
        role="progressbar"
        aria-valuenow={pct}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-label={shownLabel}
        className="h-1.5 w-full overflow-hidden rounded-[999px] bg-border-strong"
      >
        <div
          className="h-full rounded-[999px] bg-brand-violet transition-[width] duration-300 ease-out"
          style={{ width: `${pct}%` }}
        />
      </div>

      <div className="mt-1.5 flex items-baseline justify-between gap-2 text-xs text-ink-muted">
        <span className="tabular-nums">{fmtDuration(elapsed)} elapsed</span>
        {!done && (
          <span className="tabular-nums">
            {measured
              ? measured.detail
              : remaining > 0
                ? `~${fmtDuration(remaining)} left (estimate)`
                : 'taking longer than usual…'}
          </span>
        )}
      </div>

      {note && !done && <div className="mt-1.5 text-xs leading-[1.5] text-ink-muted">{note}</div>}
    </div>
  )
}
