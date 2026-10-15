import { useId, useState, type ReactNode } from 'react'
import { Spinner } from '../ui'
import { Icon } from '../../icons'
import { FigureCompare } from './FigureCompare'
import { PlannerCurve } from './PlannerCurve'
import { WeekTrend } from './WeekTrend'
import { axisMoney, FactList, Panel, QuickChip, shiftText, StaleOverlay, toneClass, TYPE } from './shared'
import type { CurveResponse, Lever, WhatIfResponse } from '../../types/planner'

/** WHAT-IF. One lever -- the average discount -- opening on the current
 *  plan's. Every promotion moves by the same points and keeps its weeks. */

//: Symmetric nudges either side of today's discount, shallowest first. Not a
//: menu of every depth worth trying -- anything else is typed into the field
//: beside them, which is why +20 is gone rather than replaced by +25.
const STEPS = [-15, -10, -5, 5, 10, 15]

/** The discount typed rather than nudged.
 *
 *  Kept as its own draft until it is committed: re-pricing a plan on every
 *  keystroke would fire a request for "1", "1.", "1.2" on the way to 12.49,
 *  and clamping mid-type would fight the person -- typing "5" as the first
 *  digit of "15" must not snap. So the field holds whatever is being typed and
 *  only Enter, Tab or clicking away commits it, clamped at that point.
 *
 *  Sized and weighted with the Studio's other controls (40px, 14px medium), so
 *  it sits level with the chips beside it. */
function DiscountInput({
  id,
  value,
  min,
  max,
  onCommit,
}: {
  id: string
  value: number
  min: number
  max: number
  onCommit: (v: number) => void
}) {
  const [draft, setDraft] = useState<string | null>(null)
  const shown = draft ?? value.toFixed(2)

  const commit = () => {
    if (draft === null) return
    const parsed = Number(draft.replace(/[^\d.-]/g, ''))
    setDraft(null)
    // An unreadable entry is not a reason to move the plan: fall back to the
    // value that was already set rather than to 0, which would silently price
    // the whole selection at no discount.
    if (Number.isFinite(parsed)) onCommit(parsed)
  }

  return (
    <div className="relative">
      <input
        id={id}
        type="text"
        inputMode="decimal"
        value={shown}
        aria-label="Average discount, percent"
        onChange={(e) => setDraft(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            e.preventDefault()
            e.currentTarget.blur()
          }
          if (e.key === 'Escape') setDraft(null)
        }}
        className="h-10 w-[108px] rounded-[var(--r-md)] border border-border-subtle bg-surface-card pl-3 pr-7 text-base font-medium text-ink-primary [font-variant-numeric:tabular-nums] transition-colors hover:border-border-strong focus:border-brand-violet focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-violet"
      />
      <span className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 text-base font-medium text-ink-muted">
        %
      </span>
      <span className="sr-only">
        Between {min.toFixed(0)} and {max.toFixed(0)} percent
      </span>
    </div>
  )
}

export function WhatIfPanel({
  lever,
  value,
  onChange,
  result,
  curve,
  fetching,
  action,
}: {
  lever: Lever
  value: number
  onChange: (v: number) => void
  result: WhatIfResponse | undefined
  curve: CurveResponse | undefined
  fetching: boolean
  /** "Add to Decision Center", supplied by the page. */
  action?: ReactNode
}) {
  const id = useId()
  const current = lever.default
  const shift = value - current
  const rel = current ? (shift / current) * 100 : null
  const best = curve?.best ?? null
  const beyond = value > lever.evidence_max
  const rate = result?.exchange_rate ?? curve?.exchange_rate ?? 1
  const currency = result?.currency ?? curve?.currency ?? 'INR'
  const pctOf = (v: number) => ((v - lever.min) / (lever.max - lever.min)) * 100
  const clamp = (v: number) => Math.round(Math.min(lever.max, Math.max(lever.min, v)) * 100) / 100
  const atCurrent = Math.abs(shift) < 0.005
  const step = (s: number) => Math.abs(value - clamp(current + s)) < 0.005 && !atCurrent

  const facts = [
    { label: 'Current plan', value: `${current.toFixed(2)}%`, dot: 'var(--brand-blue)' },
    ...(best
      ? [{ label: 'Most profitable', value: `${best.discount_pct.toFixed(2)}% · ${best.profit.display}`, dot: 'var(--brand-violet)', title: 'The discount with the highest median profit across the Monte Carlo draws' }]
      : []),
    { label: 'Data covers', value: `0% – ${lever.evidence_max.toFixed(0)}%`, dot: 'var(--border-strong)' },
    ...(result
      ? [
          { label: 'Promotions affected', value: result.current.promotions.display, dot: 'var(--border-strong)' },
          {
            label: 'Profit change',
            value: result.deltas.profit.direction === 'unchanged' ? '—' : result.deltas.profit.absolute.display,
            dot: result.deltas.profit.direction === 'down' ? 'var(--status-danger)' : 'var(--status-success)',
            tone: toneClass(result.deltas.profit.direction),
          },
          ...(result.band
            ? [
                { label: 'Likely profit change', value: result.band.profit_change.display, dot: 'var(--brand-violet)', title: `Over ${result.band.draws.toLocaleString()} Monte Carlo draws` },
                { label: 'Chance profit rises', value: `${result.band.chance_gain_pct.toFixed(2)}%`, dot: 'var(--brand-violet)', title: 'Share of Monte Carlo draws in which this discount earns more than the current plan' },
              ]
            : []),
        ]
      : []),
  ]

  return (
    <div className="grid gap-5">
      <div className="grid items-stretch gap-5 @min-[1100px]:grid-cols-[440px_minmax(0,1fr)]">
        <Panel title={<label htmlFor={id}>Average discount</label>} actions={action}>
          <div className="flex items-end gap-3">
            <span className={TYPE.hero}>{value.toFixed(2)}%</span>
            <span
              className={`mb-0.5 rounded-full px-2.5 py-0.5 ${TYPE.delta} ${atCurrent ? 'bg-ink-primary/[0.05] text-ink-secondary' : 'bg-brand-violet-50 text-brand-violet'}`}
            >
              {atCurrent ? 'Current plan' : shiftText(shift, rel)}
            </span>
          </div>

          <div className="mt-5">
            <input
              id={id}
              type="range"
              min={lever.min}
              max={lever.max}
              step={lever.step}
              value={value}
              aria-valuetext={`${value.toFixed(2)} percent`}
              onChange={(e) => onChange(Number(e.target.value))}
              className="w-full cursor-pointer accent-brand-violet"
            />
            <div className="pointer-events-none relative h-4">
              <span className="absolute -translate-x-1/2 text-sm text-brand-blue" style={{ left: `${pctOf(current)}%` }}>
                ▲
              </span>
            </div>
            <div className={`flex justify-between ${TYPE.delta} text-ink-muted`}>
              <span>0%</span>
              <span>{lever.max.toFixed(0)}%</span>
            </div>
          </div>

          {/* TYPE A DISCOUNT. The slider and the nudges below both move in
              fixed amounts, which cannot express "price it at 12.75%" -- a
              planner usually has a figure in mind rather than a step. This is
              that figure, entered directly and clamped to the lever's own
              bounds. The nudges stay because moving BY a number of points is a
              different question from setting one, and they are now labelled
              "pts" so which is which is unambiguous. */}
          {/* Two rows, because they answer two different questions. The first
              SETS a discount -- the figure a planner usually arrives with. The
              second MOVES it by a number of points from today's, which is a
              relative question and was the only one the panel used to ask.
              Separating them also stops seven controls wrapping into a ragged
              block: each row is now one homogeneous group. */}
          <div className="mt-4 flex flex-wrap items-end gap-2">
            <div>
              <label htmlFor={`${id}-exact`} className={`block pb-1 ${TYPE.eyebrow}`}>
                Set discount
              </label>
              <DiscountInput id={`${id}-exact`} value={value} min={lever.min} max={lever.max} onCommit={(v) => onChange(clamp(v))} />
            </div>
            <QuickChip onClick={() => onChange(current)} title={`Back to the current plan (${current.toFixed(2)}%)`}>
              <Icon name="refresh" /> Reset
            </QuickChip>
            {best && (
              <QuickChip accent active={Math.abs(value - best.discount_pct) < 0.005} onClick={() => onChange(best.discount_pct)} title="The most profitable average discount">
                <Icon name="target" /> Best {best.discount_pct.toFixed(2)}%
              </QuickChip>
            )}
          </div>

          <div className="mt-3">
            {/* The group's label carries the unit, so the chips do not have to
                repeat it. "+5" alone was the ambiguity worth fixing -- five
                percent, or five points of it? -- and naming the baseline they
                move from answers that once, for all five, and keeps them on
                one row. */}
            <div className={TYPE.eyebrow}>Or move it in points from today's {current.toFixed(2)}%</div>
            <div className="mt-1.5 flex flex-wrap gap-2">
              {STEPS.map((s) => (
                <QuickChip key={s} active={step(s)} onClick={() => onChange(clamp(current + s))} title={`${s > 0 ? '+' : ''}${s} points on the current plan's ${current.toFixed(2)}% — ${clamp(current + s).toFixed(2)}%`}>
                  {s > 0 ? '+' : ''}
                  {s}
                </QuickChip>
              ))}
            </div>
          </div>

          {(beyond || result?.clipped_at_zero) && (
            <div className={`mt-4 flex items-center gap-2 rounded-[var(--r-md)] bg-status-warning/10 px-3 py-2 ${TYPE.label} [&_svg]:h-4 [&_svg]:w-4`}>
              <Icon name="alertTriangle" className="shrink-0 text-status-warning" />
              {beyond ? 'Deeper than the data — an estimate' : 'Some promotions reach 0% and stop'}
            </div>
          )}

          <div className="mt-5 border-t border-border-subtle pt-3">
            <div className={TYPE.eyebrow}>At a glance</div>
            <div className="mt-1">
              <FactList items={facts} />
            </div>
          </div>
        </Panel>

        <Panel title="What this discount changes" actions={fetching ? <Spinner /> : undefined}>
          {result ? (
            <StaleOverlay on={fetching}>
              <FigureCompare
                columns={[
                  // The zero point first, so the three columns read left to
                  // right as "do nothing", "what we do", "what we would do".
                  { title: 'Baseline', figures: result.baseline, muted: true },
                  { title: 'Current plan', sub: `${current.toFixed(2)}%`, figures: result.current },
                  { title: 'Scenario', sub: `${result.discount_pct.toFixed(2)}%`, figures: result.scenario, deltas: result.deltas, band: result.band },
                ]}
                rows={['profit', 'profit_pct', 'revenue', 'trade_spend', 'roi', 'incremental_sales', 'units', 'margin_pct', 'avg_discount', 'promotions']}
              />
            </StaleOverlay>
          ) : (
            <div className={`flex items-center gap-3 ${TYPE.label}`}>
              <Spinner /> Pricing…
            </div>
          )}
        </Panel>
      </div>

      <Panel title="Every discount level">
        {curve ? (
          <PlannerCurve
            curve={curve}
            scenario={
              result
                ? {
                    discount_pct: result.discount_pct,
                    profit: result.scenario.profit.value,
                    revenue: result.scenario.revenue.value,
                    profitDisplay: result.scenario.profit.display,
                    revenueDisplay: result.scenario.revenue.display,
                  }
                : null
            }
            format={(v) => axisMoney(v, rate, currency)}
          />
        ) : (
          <div className={`flex items-center gap-3 ${TYPE.label}`}>
            <Spinner /> Working out every level…
          </div>
        )}
      </Panel>

      {result && result.weekly.length > 0 && (
        <Panel title="Week by week">
          <StaleOverlay on={fetching}>
            <WeekTrend weeks={result.weekly} format={(v) => axisMoney(v, rate, currency)} planLabel="Scenario" />
          </StaleOverlay>
        </Panel>
      )}
    </div>
  )
}
