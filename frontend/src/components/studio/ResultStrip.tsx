import { Icon } from '../../icons'
import { Pill, type PillTone } from '../ui'
import type { Direction, RoiStatus, SimulateResponse } from '../../types/studio'

/** The two answers: what happens to Revenue and to ROI over the window.
 *
 *  EVERY STRING HERE IS THE PAYLOAD'S. The current → scenario values, the
 *  delta, its sign and the ROI status are all read off `/simulate`; nothing is
 *  subtracted, divided or rounded on the client. The tile only decides colour
 *  and arrow from the direction the engine reported. */

const ROI_STATUS: Record<RoiStatus, { label: string; tone: PillTone }> = {
  profitable: { label: 'Profitable', tone: 'success' },
  break_even: { label: 'Break-even', tone: 'warning' },
  loss_making: { label: 'Loss-making', tone: 'danger' },
  not_applicable: { label: 'No promotion', tone: 'neutral' },
}

function Arrow({ direction }: { direction: Direction }) {
  if (direction === 'up') return <Icon name="trending" className="h-4 w-4 text-status-success" />
  if (direction === 'down') return <Icon name="trending" className="h-4 w-4 rotate-180 -scale-x-100 text-status-danger" />
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
}: {
  label: string
  current: string
  scenario: string
  delta: string
  direction: Direction
  status?: { label: string; tone: PillTone }
  stale: boolean
  /** One line under the figures — the measured anchor, when there is one. */
  note?: string | null
}) {
  return (
    <div
      className={`rounded-[var(--r-lg)] border border-border-subtle bg-surface-card px-6 py-5 shadow-[var(--shadow-card-soft)] transition-opacity ${
        stale ? 'opacity-70' : ''
      }`}
    >
      <div className="flex items-center justify-between gap-3">
        <div className="text-base font-semibold text-ink-muted">{label}</div>
        {status && <Pill tone={status.tone}>{status.label}</Pill>}
      </div>
      <div className="mt-2 flex flex-wrap items-baseline gap-x-3">
        <span className="text-md font-semibold text-ink-muted [font-variant-numeric:tabular-nums]">{current}</span>
        <span className="text-ink-muted">→</span>
        <span className="text-[30px] font-extrabold leading-none tracking-[-0.02em] text-ink-primary [font-variant-numeric:tabular-nums]">
          {scenario}
        </span>
      </div>
      <div className="mt-3 flex flex-wrap items-center gap-x-3 gap-y-1 text-base">
        <span className={`inline-flex items-center gap-1.5 font-bold [font-variant-numeric:tabular-nums] ${deltaTone(direction)}`}>
          <Arrow direction={direction} />
          {direction === 'unchanged' ? 'Same as current plan' : direction === 'not_applicable' ? '—' : `${delta} vs current plan`}
        </span>
      </div>
      {note && <div className="mt-1.5 text-sm text-ink-muted [font-variant-numeric:tabular-nums]">{note}</div>}
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
