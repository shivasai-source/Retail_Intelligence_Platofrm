import type { ReactNode } from 'react'
import { Spinner } from '../ui'
import { ChangesTable } from './ChangesTable'
import { FigureCompare } from './FigureCompare'
import { PlanRules } from './PlanRules'
import { WeekTrend } from './WeekTrend'
import { axisMoney, FactList, Panel, PlanChanges, StaleOverlay, TYPE } from './shared'
import type { BestResponse, CountRule, TimingRule } from '../../types/planner'

/** BEST PLAN. Every promotion's offer and week re-chosen for the most profit
 *  under the two rules: the gain and what changes, the current plan beside
 *  the optimized one, the week-by-week impact and every change. */
export function BestPlanPanel({
  timing,
  count,
  onTiming,
  onCount,
  focus,
  data,
  fetching,
  error,
  action,
}: {
  timing: TimingRule
  count: CountRule
  onTiming: (t: TimingRule) => void
  onCount: (c: CountRule) => void
  focus: boolean
  data: BestResponse | undefined
  fetching: boolean
  error: Error | null
  action?: ReactNode
}) {
  const fmt = (v: number) => axisMoney(v, data?.exchange_rate ?? 1, data?.currency ?? 'INR')
  const rp = data?.replan

  return (
    <div className="grid gap-5">
      <Panel>
        <div className="flex flex-wrap items-end justify-between gap-5">
          <div>
            <div className={TYPE.eyebrow}>Optimize for</div>
            <div className={`mt-1.5 flex h-10 items-center ${TYPE.title}`}>Maximum profit</div>
          </div>
          <PlanRules timing={timing} count={count} onTiming={onTiming} onCount={onCount} focus={focus} rules={data?.rules} />
        </div>
      </Panel>

      {error && (
        <Panel>
          <div className={TYPE.title}>Could not optimise this selection</div>
          <div className={`mt-1 ${TYPE.label}`}>{error.message}</div>
        </Panel>
      )}
      {!data && !error && (
        <div className={`flex items-center gap-3 ${TYPE.label}`}>
          <Spinner /> Optimising…
        </div>
      )}

      {data && rp && (
        <StaleOverlay on={fetching}>
          <div className="grid items-stretch gap-5 @min-[1100px]:grid-cols-[440px_minmax(0,1fr)]">
            <Panel title="Profit gain" actions={action}>
              {/* THE CARD ENDS LEVEL WITH THE ONE BESIDE IT, AND ITS BLOCKS
                  TAKE THE SLACK -- the same rule as the What-if lever. Three
                  ways of using the extra height were tried in front of the
                  user and rejected: leaving it under the last line (dead
                  white), pushing the last block down (a hole in the middle),
                  and sharing it between the sections (every gap grew, so the
                  card read as stretched). What grows here is the things that
                  can: the change tiles, which are boxes, and the two lists,
                  whose rows stay equal to each other however much there is to
                  go round. The headings stay with what they head. */}
              <div className="flex h-full flex-col">
                {/* The gain and the line that reads it are one thing: grouped, so
                    that when this card shares out height the slack never lands
                    between a figure and its own caption. */}
                <div>
                  <div className={TYPE.hero}>{rp.deltas.profit.absolute.display}</div>
                  <div className={`mt-2 ${TYPE.label}`}>
                    Profit % <span className="text-ink-primary">{data.current.profit_pct.display}</span> →{' '}
                    <span className="text-brand-violet">{rp.figures.profit_pct.display}</span>{' '}
                    <span className="text-status-success">({rp.deltas.profit_pct.absolute_display})</span>
                  </div>
                </div>

                <div className="mt-6 flex flex-1 flex-col">
                  <PlanChanges impact={rp.impact} />
                </div>

                <div className="mt-6 flex flex-1 flex-col">
                  <div className={TYPE.eyebrow}>Result</div>
                  <div className="mt-1 flex flex-1 flex-col [&>ul]:flex [&>ul]:flex-1 [&>ul]:flex-col [&_li]:min-h-[44px] [&_li]:flex-1 [&_li]:py-2">
                    <FactList
                      items={[
                        { label: 'Revenue', value: rp.deltas.revenue.absolute.display, dot: 'var(--border-strong)' },
                        { label: 'ROI', value: `${data.current.roi.display} → ${rp.figures.roi.display}`, dot: 'var(--border-strong)' },
                        { label: 'Average discount', value: `${data.current.avg_discount.display} → ${rp.figures.avg_discount.display}`, dot: 'var(--border-strong)' },
                      ]}
                    />
                  </div>
                </div>

                {/* ONE ROW DOES NOT GROW: a list of a single fact given a
                    share of the card's height becomes one very tall row with
                    its heading stranded above it. The rows that share the
                    slack are the ones there are several of. */}
                {rp.band && (
                  <div className="mt-6">
                    <div className={TYPE.eyebrow}>How sure · {rp.band.draws.toLocaleString()} simulations</div>
                    <div className="mt-1 [&_li]:py-3">
                      <FactList
                        items={[
                          { label: 'Likely profit gain', value: rp.band.profit_change.display, dot: 'var(--brand-violet)', title: 'In 8 of every 10 simulations the profit gain falls in this range (P10 – P90)' },
                        ]}
                      />
                    </div>
                  </div>
                )}
              </div>
            </Panel>

            <Panel title="What the best plan changes">
              <FigureCompare
                columns={[
                  { title: 'Baseline', figures: data.baseline, muted: true },
                  { title: 'Current plan', sub: 'today', figures: data.current },
                  { title: 'Optimized', sub: 'proposed', figures: rp.figures, deltas: rp.deltas, recommended: true, band: rp.band },
                ]}
              />
            </Panel>
          </div>

          {!focus && rp.changes.length > 0 && (
            <Panel title="Week by week" className="mt-5">
              <WeekTrend weeks={rp.weekly} format={fmt} planLabel="Optimized" />
            </Panel>
          )}

          <Panel title="Promotions that change" className="mt-5">
            <ChangesTable rows={rp.changes} truncated={rp.changes_truncated} total={rp.changed_product_stores} />
          </Panel>
        </StaleOverlay>
      )}
    </div>
  )
}
