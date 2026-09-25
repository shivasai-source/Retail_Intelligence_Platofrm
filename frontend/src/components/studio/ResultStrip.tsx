import { Icon } from '../../icons'
import { RoiStatusPill } from './RoiStatusPill'
import type { Direction, RoiStatus, SimulateResponse } from '../../types/studio'

/** The two answers: what happens to Revenue and to ROI over the window.
 *
 *  EVERY STRING HERE IS THE PAYLOAD'S. The current → scenario values, the
 *  delta, its sign and the ROI status are all read off `/simulate`; nothing is
 *  subtracted, divided or rounded on the client. The tile only decides colour
 *  and arrow from the direction the engine reported. */

const ROI_STATUS: Record<RoiStatus, 'success' | 'warning' | 'danger' | 'neutral'> = {
  profitable: 'success',
  break_even: 'warning',
  loss_making: 'danger',
  not_applicable: 'neutral',
}

function Arrow({ direction }: { direction: Direction }) {
  if (direction === 'up') return <Icon name="trending" className="h-4 w-4 text-status-success" />
  if (direction === 'down') return <Icon name="trending" className="h-4 w-4 rotate-180 -scale-x-100 text-status-danger" />
  return null
}

const VERDICT_INK = {
  success: 'text-[var(--pill-success-ink)]',
  warning: 'text-[var(--pill-warning-ink)]',
  danger: 'text-[var(--pill-danger-ink)]',
  neutral: 'text-ink-secondary',
} as const

/** THE PILL'S SUBJECT, SPELLED OUT. "Net Loss" beside "Same as current plan"
 *  reads as a verdict on the comparison — as if matching the plan were a loss.
 *  It is a verdict on the ROI level: below 1.00x the promotion earns back less
 *  than it spends. When the scenario IS the current plan, both are in that
 *  position, and the line says so. */
function roiVerdict(status: RoiStatus, direction: Direction): string | null {
  const both = direction === 'unchanged'
  if (status === 'loss_making') {
    return both
      ? 'Both plans earn back less than they spend (ROI below 1.00x).'
      : 'This scenario earns back less than it spends (ROI below 1.00x).'
  }
  if (status === 'profitable') {
    return both
      ? 'Both plans earn back more than they spend (ROI above 1.00x).'
      : 'This scenario earns back more than it spends (ROI above 1.00x).'
  }
  if (status === 'break_even') {
    return both
      ? 'Both plans earn back exactly what they spend (ROI 1.00x).'
      : 'This scenario earns back exactly what it spends (ROI 1.00x).'
  }
  return null
}

function deltaTone(direction: Direction) {
  if (direction === 'up') return 'text-status-success'
  if (direction === 'down') return 'text-status-danger'
  return 'text-ink-muted'
}

function Tile({
  label,
  current,
  scenario,
  delta,
  direction,
  status,
  stale,
  note,
  verdict,
}: {
  label: string
  current: string
  scenario: string
  delta: string
  direction: Direction
  status?: 'success' | 'warning' | 'danger' | 'neutral'
  stale: boolean
  /** One line under the figures — the measured anchor, when there is one. */
  note?: string | null
  /** What the status pill is a verdict ON, in words, in the pill's tone. */
  verdict?: string | null
}) {
  return (
    <div
      className={`rounded-[var(--r-lg)] border border-border-subtle bg-surface-card px-5 py-4 shadow-[var(--shadow-card-soft)] transition-opacity ${
        stale ? 'opacity-70' : ''
      }`}
    >
      <div className="flex items-center justify-between gap-3">
        <div className="text-md font-bold text-ink-primary">{label}</div>
        {status && <RoiStatusPill tone={status} />}
      </div>
      <div className="mt-3 flex flex-wrap items-baseline gap-x-2.5">
        <span className="text-lg font-bold text-ink-primary [font-variant-numeric:tabular-nums]">{current}</span>
        <span className="text-ink-muted">→</span>
        <span className="text-[24px] font-bold leading-none tracking-[-0.01em] text-ink-primary [font-variant-numeric:tabular-nums]">
          {scenario}
        </span>
      </div>
      <div className="mt-2.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-sm">
        <span className={`inline-flex items-center gap-1.5 font-semibold [font-variant-numeric:tabular-nums] ${direction === 'unchanged' ? 'text-ink-secondary' : deltaTone(direction)}`}>
          <Arrow direction={direction} />
          {direction === 'unchanged' ? 'Same as current plan' : direction === 'not_applicable' ? '—' : `${delta} vs current plan`}
        </span>
      </div>
      {verdict && status && (
        <div className={`mt-1.5 text-sm font-medium ${VERDICT_INK[status]}`}>{verdict}</div>
      )}
      {note && <div className="mt-1.5 text-sm text-ink-secondary [font-variant-numeric:tabular-nums]">{note}</div>}
    </div>
  )
}

export function ResultStrip({
  result,
  stale,
  measuredRoi,
}: {
  result: SimulateResponse
  stale: boolean
  /** The scope's measured ROI (the Insights Hub's / Promotion Intelligence's
   *  figure), shown beside the modelled current plan so the two are never
   *  mistaken for each other. */
  measuredRoi?: string | null
}) {
  const { current_plan: current, scenario, deltas } = result
  const days = result.window.days
  return (
    <div className="grid grid-cols-2 gap-4 @max-[760px]:grid-cols-1">
      <Tile
        label={`Revenue over ${days} days`}
        current={current.revenue.display}
        scenario={scenario.revenue.display}
        delta={`${deltas.revenue.absolute.display} (${deltas.revenue.percent_display})`}
        direction={deltas.revenue.direction}
        stale={stale}
      />
      <Tile
        label={`ROI over ${days} days`}
        current={current.roi.display}
        scenario={scenario.roi.display}
        delta={deltas.roi.absolute_display}
        direction={deltas.roi.direction}
        status={ROI_STATUS[deltas.roi.status]}
        verdict={roiVerdict(deltas.roi.status, deltas.roi.direction)}
        stale={stale}
        note={
          measuredRoi && current.roi.value != null && measuredRoi !== current.roi.display
            ? `Current plan ${current.roi.display} is the model's expectation at ${current.discount_pct.toFixed(2)}%; the scope measured ${measuredRoi}.`
            : null
        }
      />
    </div>
  )
}
