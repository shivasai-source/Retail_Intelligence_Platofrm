import { useEffect, useState } from 'react'
import { Icon } from '../../icons'
import type { RiskAlert } from '../../types/commandCenter'

/** THE ONE ALERT THE PAGE LEADS WITH, as a compact strip in the header's
 *  top-right corner — where a reader looks for status — rather than a
 *  full-width banner pushed beneath the KPI cards.
 *
 *  It is the same alert `topPriorityAlert` ranks first (Critical before High
 *  before Medium, then worst ROI, then largest stake) and clicking it hands
 *  that alert to Investigations exactly as the old banner did. Nothing about
 *  which alert leads, or where it goes, has changed; only where it sits.
 *
 *  The icon keeps the banner's slow pulse and the strip flashes its ring
 *  every 18s (the vanilla app's `_cmdWobble` beat), so it draws the eye
 *  without shouting for it. */
export function PriorityAlert({ alert, onOpen }: { alert: RiskAlert; onOpen: () => void }) {
  const [flash, setFlash] = useState(false)

  useEffect(() => {
    const id = window.setInterval(() => {
      setFlash(true)
      window.setTimeout(() => setFlash(false), 600)
    }, 18000)
    return () => window.clearInterval(id)
  }, [])

  return (
    <button
      type="button"
      onClick={onOpen}
      aria-label={`${alert.severity} alert: ${alert.title}. ${alert.at_stake_display} at stake. Open in Investigations`}
      className={`fade-in group/alert inline-flex max-w-full cursor-pointer items-center gap-2.5 rounded-[var(--r-pill)] border border-[var(--alert-border)] bg-[var(--alert-bg)] py-1.5 pl-1.5 pr-3 text-left transition-[box-shadow,transform,border-color] duration-[220ms] ease-[var(--ease-out)] hover:border-[var(--alert-ink)] hover:shadow-[0_6px_16px_rgba(220,38,38,0.14)] focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--alert-ink)]/50 motion-safe:hover:-translate-y-px ${
        flash ? 'shadow-[0_0_0_5px_rgba(239,68,68,0.18)]' : 'shadow-[0_0_0_0_rgba(239,68,68,0)]'
      }`}
    >
      <span className="grid h-7 w-7 shrink-0 animate-[pulseDot_2s_ease-in-out_infinite] place-items-center rounded-full bg-[var(--alert-dot-bg)] text-[var(--alert-ink)] [&_svg]:h-4 [&_svg]:w-4 [&_svg]:stroke-2">
        <Icon name="warning" />
      </span>
      <span className="min-w-0 truncate text-sm">
        <span className="mr-1.5 rounded-[var(--r-sm)] bg-[var(--alert-ink)] px-1.5 py-px text-2xs font-bold uppercase tracking-wide text-[var(--alert-badge-ink)]">
          {alert.severity}
        </span>
        <span className="font-semibold text-[var(--alert-ink)]">{alert.title}</span>
        <span className="text-[var(--alert-ink-soft)]"> · {alert.at_stake_display} at stake</span>
      </span>
      <span className="inline-flex shrink-0 items-center gap-1 text-sm font-semibold text-[var(--alert-ink)] [&_svg]:h-3.5 [&_svg]:w-3.5 [&_svg]:transition-transform [&_svg]:duration-[220ms] motion-safe:group-hover/alert:[&_svg]:translate-x-0.5">
        View
        <Icon name="arrowRight" />
      </span>
    </button>
  )
}
