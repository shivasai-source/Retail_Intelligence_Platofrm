import { InfoPopover } from '../ui'
import { ControlGroup, Segmented } from './shared'
import type { CountRule, RulesBlock, TimingRule } from '../../types/planner'

/** The two rules a re-plan runs under, in words a planner uses.
 *
 *  WEEKS: may a promotion move to another week of the period, or must each
 *  stay where it is (and only its offer change)? PROMOTIONS: the same number
 *  as today, fewer (a loss-making one may simply not run), or more (up to the
 *  busiest product-store in the channel)? A promotion carried in from the
 *  calendar keeps its weeks -- that IS the question asked. */
export function PlanRules({
  timing,
  count,
  onTiming,
  onCount,
  focus,
  rules,
}: {
  timing: TimingRule
  count: CountRule
  onTiming: (t: TimingRule) => void
  onCount: (c: CountRule) => void
  focus: boolean
  rules?: RulesBlock
}) {
  return (
    <div className="flex flex-wrap items-end gap-x-6 gap-y-3">
      <ControlGroup label="Scheduling">
        <Segmented
          label="Scheduling"
          value={focus ? 'fixed' : timing}
          onChange={onTiming}
          disabled={focus}
          options={[
            { value: 'free', label: 'Flexible', title: 'Promotions may be rescheduled to any week of the period' },
            { value: 'fixed', label: 'Fixed', title: 'Each promotion keeps its week; only its offer can change' },
          ]}
        />
      </ControlGroup>
      <ControlGroup label="Promotion count">
        <Segmented
          label="Promotion count"
          value={count}
          onChange={onCount}
          options={[
            { value: 'keep', label: 'Same count', title: 'Exactly as many promotions as the current plan' },
            { value: 'fewer', label: 'Allow fewer', title: 'A promotion that loses money may be withdrawn' },
            ...(focus ? [] : [{ value: 'more' as const, label: 'Allow more', title: 'Up to the busiest product-store in the channel' }]),
          ]}
        />
      </ControlGroup>
      {rules && rules.channels.length > 0 && (
        <span className="pb-2.5">
        <InfoPopover label="The planning rules" title="The planning rules" width={360}>
          <div className="mt-1.5 space-y-2 text-[14px] leading-snug text-ink-secondary">
            <p>Read from the data, per channel:</p>
            <ul className="space-y-1.5">
              {rules.channels.map((c) => (
                <li key={c.channel_id}>
                  <span className="font-semibold text-ink-primary">{c.channel}</span> books by the{' '}
                  {c.grain}, leaves {c.gap} {c.grain}
                  {c.gap === 1 ? '' : 's'} between promotions and runs at most {c.max_share_pct.toFixed(2)}% of{' '}
                  {c.grain}s promoted. Offers: {c.menu.map((m) => `${m.depth_pct}%`).join(', ')}
                  {', '}plus each festival's own offer in its festival {c.grain}.
                </li>
              ))}
            </ul>
            <p>Only product-stores the data has seen promoted can be promoted.</p>
          </div>
        </InfoPopover>
        </span>
      )}
    </div>
  )
}
