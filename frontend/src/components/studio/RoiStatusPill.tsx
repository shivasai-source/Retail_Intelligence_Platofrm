import { Icon } from '../../icons'
import { Pill, type PillTone } from '../ui'

/** The ROI verdict in words, keyed by the tone the engine's status maps to.
 *  "Net Gain" / "Net Loss" rather than "Profitable" / "Loss-making": the pill
 *  sits beside an ROI multiple, and what a reader wants from it is whether
 *  the promotion came out ahead of what it cost. */
export const ROI_STATUS_LABEL: Record<'success' | 'warning' | 'danger' | 'neutral', string> = {
  success: 'Net Gain',
  warning: 'Break-even',
  danger: 'Net Loss',
  neutral: 'No promotion',
}

/** The verdict as a pill that reads at a glance: the larger size, bold, with
 *  an arrow on a gain or a loss. Used by the studio's ROI tile, its Optimize
 *  card and the Decision Center, so the three say it the same way. */
export function RoiStatusPill({ tone }: { tone: 'success' | 'warning' | 'danger' | 'neutral' }) {
  const arrow = tone === 'success' ? 'arrowUp' : tone === 'danger' ? 'arrowDown' : null
  return (
    <Pill tone={tone as PillTone} size="md" className="font-bold">
      {arrow && <Icon name={arrow} className="h-3.5 w-3.5" />}
      {ROI_STATUS_LABEL[tone]}
    </Pill>
  )
}
