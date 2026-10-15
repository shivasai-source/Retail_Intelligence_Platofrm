import { useEffect, useState } from 'react'
import { InfoPopover, Spinner } from '../ui'
import { Icon } from '../../icons'
import { ChangesTable } from './ChangesTable'
import { FigureCompare } from './FigureCompare'
import { PlanRules } from './PlanRules'
import { WeekTrend } from './WeekTrend'
import { axisMoney, FactList, Panel, PlanChanges, QuickChip, StaleOverlay, StudioButton as Button, TYPE } from './shared'
import type { CountRule, TargetResponse, TimingRule } from '../../types/planner'

/** PROFIT TARGET. "Grow profit % by X" -- the fewest product-stores to
 *  re-plan, what the plan looks like beside the current one, the week-by-week
 *  impact and every change. Out of reach: the most that is reachable, and a
 *  one-click way to lift the rule that blocks it. */

const QUICK = [1, 2, 3, 5]

export function TargetPanel({
  targetPct,
  onTarget,
  timing,
  count,
  onTiming,
  onCount,
  focus,
  data,
  fetching,
  error,
}: {
  targetPct: number
  onTarget: (v: number) => void
  timing: TimingRule
  count: CountRule
  onTiming: (t: TimingRule) => void
  onCount: (c: CountRule) => void
  focus: boolean
  data: TargetResponse | undefined
  fetching: boolean
  error: Error | null
}) {
  const [draft, setDraft] = useState(String(targetPct))
  useEffect(() => setDraft(String(targetPct)), [targetPct])
  const commit = () => {
    const v = Number(draft)
    if (Number.isFinite(v) && v > 0 && v <= 1000) onTarget(Math.round(v * 100) / 100)
    else setDraft(String(targetPct))
  }
  const fmt = (v: number) => axisMoney(v, data?.exchange_rate ?? 1, data?.currency ?? 'INR')
  const rp = data?.replan
  const reachable = !!rp?.reachable
  const pts = (v: number | null | undefined) => (v == null ? '—' : `${v >= 0 ? '+' : ''}${v.toFixed(2)} pts`)

  return (
    <div className="grid gap-5">
      <Panel>
        <div className="flex flex-wrap items-end justify-between gap-5">
          <div className="flex flex-col gap-1.5">
            <span className={`flex items-center gap-1 ${TYPE.eyebrow}`}>
              Grow profit % by
              <InfoPopover label="How the target works" title="How the target works" width={300}>
                <div className="mt-1.5 space-y-1.5 text-base leading-snug text-ink-secondary">
                  <p>
                    <b>Profit % = (SP − CP) ÷ CP × 100</b>
                  </p>
                  <p>SP = revenue at the prices paid. CP = product cost + promotion cost.</p>
                  <p>+X adds X points with CP held at the current plan's: CP 100, SP 105 is 5%; +5 takes SP to 110.</p>
                </div>
              </InfoPopover>
            </span>
            <div className="flex flex-wrap items-center gap-2">
              <label className="flex h-10 items-center rounded-[var(--r-md)] border-2 border-brand-violet/40 bg-surface-card px-3 focus-within:border-brand-violet">
                <span className={`mr-0.5 ${TYPE.cell} !text-brand-violet`}>+</span>
                <input
                  style={{ outline: 'none' }}
                  value={draft}
                  inputMode="decimal"
                  aria-label="Profit % increase, in points"
                  onChange={(e) => setDraft(e.target.value.replace(/[^0-9.]/g, ''))}
                  onBlur={commit}
                  onKeyDown={(e) => e.key === 'Enter' && commit()}
                  className={`w-12 bg-transparent outline-none ${TYPE.cell} !text-brand-violet`}
                />
                <span className={`${TYPE.cell} !text-brand-violet`}>%</span>
              </label>
              {QUICK.map((q) => (
                <QuickChip key={q} active={q === targetPct} onClick={() => onTarget(q)}>
                  +{q}%
                </QuickChip>
              ))}
            </div>
          </div>
          <PlanRules timing={timing} count={count} onTiming={onTiming} onCount={onCount} focus={focus} rules={data?.rules} />
        </div>
      </Panel>

      {error && (
        <Panel>
          <div className={TYPE.title}>Could not work out the target</div>
          <div className={`mt-1 ${TYPE.label}`}>{error.message}</div>
        </Panel>
      )}
      {!data && !error && (
        <div className={`flex items-center gap-3 ${TYPE.label}`}>
          <Spinner /> Searching…
        </div>
      )}

      {data && rp && (
        <StaleOverlay on={fetching}>
          {/* THE VERDICT: the answer, the four numbers behind it, and how far
              the target sits inside what these rules can reach. */}
          <TargetVerdict
            reachable={reachable}
            targetPct={data.target_pct}
            maxPct={rp.max_profit_change_pct}
            nowPct={data.profit_pct.display}
            goalPct={data.goal_profit_pct.display}
            needed={data.needed.display}
            costBase={data.cost_base.display}
            stores={rp.impact.product_stores_affected}
            alternatives={
              !reachable
                ? rp.alternatives.map((a) => ({
                    key: a.label,
                    label: a.rule === 'timing' ? 'Flexible scheduling' : a.label.startsWith('Allow dropping') ? 'Allow fewer' : 'Allow more',
                    reach: pts(a.max_profit_change_pct),
                    title: a.label,
                    apply: () => {
                      if (a.rule === 'timing') onTiming('free')
                      else if (a.label.startsWith('Allow dropping')) onCount('fewer')
                      else onCount('more')
                    },
                  }))
                : []
            }
          />

          {/* THE RE-PLAN, AND WHAT IT DOES TO THE FIGURES */}
          <div className="mt-5 grid items-stretch gap-5 @min-[1100px]:grid-cols-[440px_minmax(0,1fr)]">
            <Panel
              title="Re-plan the calendar"
              actions={
                <span className={`rounded-full px-2.5 py-1 ${TYPE.delta} ${reachable ? 'bg-status-success/10 text-status-success' : 'bg-status-warning/10 text-status-warning'}`}>
                  {reachable ? 'Reaches the target' : 'Best possible'}
                </span>
              }
            >
              <div className={TYPE.hero}>{rp.deltas.profit.absolute.display}</div>
              <div className={`mt-2 ${TYPE.label}`}>
                Profit % <span className="text-ink-primary">{data.profit_pct.display}</span> →{' '}
                <span className="text-brand-violet">{rp.figures.profit_pct.display}</span>{' '}
                <span className="text-status-success">({rp.deltas.profit_pct.absolute_display})</span>
              </div>

              <div className="mt-5">
                <PlanChanges impact={rp.impact} />
              </div>

              {rp.band && (
                <div className="mt-5">
                  <div className={TYPE.eyebrow}>How sure · {rp.band.draws.toLocaleString()} simulations</div>
                  <div className="mt-1">
                    <FactList
                      items={[
                        { label: 'Likely profit added', value: rp.band.profit_change.display, dot: 'var(--brand-violet)', title: 'In 8 of every 10 simulations the profit added falls in this range (P10 – P90)' },
                        ...(reachable && rp.band.chance_reach_pct != null
                          ? [{ label: 'Chance of hitting the target', value: `${rp.band.chance_reach_pct.toFixed(2)}%`, dot: 'var(--brand-violet)', title: 'Share of simulations in which this plan adds the profit needed' }]
                          : []),
                        ...(!reachable && (rp.shortfall?.value ?? 0) > 0
                          ? [{ label: 'Still short of the target', value: rp.shortfall.display, dot: 'var(--status-warning)', tone: 'text-status-warning', title: 'What no plan can cover under these rules' }]
                          : []),
                      ]}
                    />
                  </div>
                </div>
              )}
            </Panel>

            <Panel title="What the re-plan changes">
              <FigureCompare
                columns={[
                  { title: 'Baseline', figures: data.baseline, muted: true },
                  { title: 'Current plan', sub: 'today', figures: data.current },
                  { title: 'Re-planned', sub: 'proposed', figures: rp.figures, deltas: rp.deltas, recommended: true, band: rp.band },
                ]}
              />
            </Panel>
          </div>

          {rp.changes.length > 0 && (
            <>
              {!focus && (
                <Panel title="Week by week" className="mt-5">
                  <WeekTrend weeks={rp.weekly} format={fmt} planLabel="Re-planned" />
                </Panel>
              )}
              <Panel title="Promotions that change" className="mt-5">
                <ChangesTable rows={rp.changes} truncated={rp.changes_truncated} total={rp.changed_product_stores} />
              </Panel>
            </>
          )}
        </StaleOverlay>
      )}
    </div>
  )
}

/** The answer to "+X%": reachable or not, in one sentence; the four numbers
 *  behind it; and a bar of how much of the reachable lift the target needs. */
function TargetVerdict({
  reachable,
  targetPct,
  maxPct,
  nowPct,
  goalPct,
  needed,
  costBase,
  stores,
  alternatives,
}: {
  reachable: boolean
  targetPct: number
  maxPct: number | null
  nowPct: string
  goalPct: string
  needed: string
  costBase: string
  stores: number
  alternatives: { key: string; label: string; reach: string; title: string; apply: () => void }[]
}) {
  const t = targetPct.toFixed(2)
  const max = Math.max(0, maxPct ?? 0)
  const scale = Math.max(targetPct, max, 0.01) * 1.12
  const fill = (max / scale) * 100
  const mark = (targetPct / scale) * 100
  const tone = reachable
    ? { border: 'border-status-success/30', band: 'bg-status-success/[0.06]', solid: 'bg-status-success', text: 'text-status-success' }
    : { border: 'border-status-warning/40', band: 'bg-status-warning/[0.08]', solid: 'bg-status-warning', text: 'text-status-warning' }
  const stats = [
    { label: 'Profit % now', value: nowPct },
    { label: 'Target Profit %', value: goalPct },
    { label: 'Profit needed', value: `+${needed}`, title: `${t}% of cost ${costBase}` },
    { label: 'Most reachable', value: `+${max.toFixed(2)} pts`, title: 'The biggest Profit % lift these rules allow' },
  ]
  return (
    <section className={`overflow-hidden rounded-[var(--r-lg)] border bg-surface-card shadow-[var(--shadow-card-soft)] ${tone.border}`}>
      <div className={`flex flex-wrap items-center gap-4 px-6 py-5 ${tone.band}`}>
        <span className={`grid h-11 w-11 shrink-0 place-items-center rounded-full text-white [&_svg]:h-5 [&_svg]:w-5 ${tone.solid}`}>
          <Icon name={reachable ? 'checkCircle' : 'alertTriangle'} />
        </span>
        <div className="min-w-0 flex-1">
          {/* The page's one verdict, so it keeps text-lg -- but at the medium
              weight every other heading in the Studio uses. It was the only
              font-normal heading here. */}
          <div className="text-lg font-medium text-ink-primary">
            Growing Profit % by +{t}% is <span className={tone.text}>{reachable ? 'reachable' : 'out of reach'}</span>
          </div>
          <div className={`mt-1 ${TYPE.label}`}>
            {reachable
              ? `Re-planning ${stores.toLocaleString()} product-stores takes Profit % from ${nowPct} to ${goalPct}.`
              : `With these rules the most is +${max.toFixed(2)} pts. Relax a rule to go further.`}
          </div>
        </div>
        {alternatives.length > 0 && (
          <div className="flex flex-wrap gap-2">
            {alternatives.map((a) => (
              <Button key={a.key} variant="secondary" onClick={a.apply} title={a.title}>
                {a.label} → {a.reach}
              </Button>
            ))}
          </div>
        )}
      </div>

      <div className="grid grid-cols-4 divide-x divide-border-subtle border-t border-border-subtle @max-[800px]:grid-cols-2 @max-[800px]:divide-y">
        {stats.map((st) => (
          <div key={st.label} className="px-6 py-4" title={st.title}>
            <div className={TYPE.label}>{st.label}</div>
            <div className={`mt-1 ${TYPE.value}`}>{st.value}</div>
          </div>
        ))}
      </div>

      <div className="border-t border-border-subtle px-6 py-4">
        <div className={`flex flex-wrap items-center justify-between gap-2 ${TYPE.label}`}>
          <span>Target against what is reachable</span>
          <span>
            <span className="text-ink-primary">+{t} pts</span> of <span className={tone.text}>+{max.toFixed(2)} pts</span> possible
          </span>
        </div>
        <div className="relative mt-3 h-2.5 rounded-full bg-surface-muted">
          <div className={`absolute inset-y-0 left-0 rounded-full ${reachable ? 'bg-brand-violet' : 'bg-status-warning'}`} style={{ width: `${fill}%` }} />
          <div className="absolute -top-1.5 h-[22px] w-[3px] -translate-x-1/2 rounded-full bg-ink-primary" style={{ left: `${Math.min(100, mark)}%` }} title={`Target +${t} pts`} />
        </div>
        <div className={`mt-2 flex justify-between ${TYPE.label} !text-ink-muted`}>
          <span>0 pts</span>
          <span className="inline-flex items-center gap-3">
            <span className="inline-flex items-center gap-1.5">
              <span className={`inline-block h-2.5 w-2.5 rounded-full ${reachable ? 'bg-brand-violet' : 'bg-status-warning'}`} /> Reachable
            </span>
            <span className="inline-flex items-center gap-1.5">
              <span className="inline-block h-3 w-[3px] rounded-full bg-ink-primary" /> Target
            </span>
          </span>
        </div>
      </div>
    </section>
  )
}
