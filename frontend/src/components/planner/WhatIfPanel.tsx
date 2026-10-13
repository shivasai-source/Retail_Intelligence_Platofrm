import { useId, type ReactNode } from 'react'
import { Spinner } from '../ui'
import { Icon } from '../../icons'
import { FigureCompare } from './FigureCompare'
import { PlannerCurve } from './PlannerCurve'
import { WeekTrend } from './WeekTrend'
import { axisMoney, FactList, Panel, QuickChip, shiftText, StaleOverlay, toneClass, TYPE } from './shared'
import type { CurveResponse, Lever, WhatIfResponse } from '../../types/planner'

/** WHAT-IF. One lever -- the average discount -- opening on the current
 *  plan's. Every promotion moves by the same points and keeps its weeks. */

const STEPS = [-5, 5, 10, 15, 20]

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
        <Panel title={<label htmlFor={id}>Average discount</label>}>
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

          <div className="mt-4 flex flex-wrap gap-2">
            {STEPS.map((s) => (
              <QuickChip key={s} active={step(s)} onClick={() => onChange(clamp(current + s))} title={`${s > 0 ? '+' : ''}${s} points on the current plan`}>
                {s > 0 ? '+' : ''}
                {s}
              </QuickChip>
            ))}
            <QuickChip onClick={() => onChange(current)} title="Back to the current plan">
              <Icon name="refresh" />
            </QuickChip>
            {best && (
              <QuickChip accent active={Math.abs(value - best.discount_pct) < 0.005} onClick={() => onChange(best.discount_pct)} title="The most profitable average discount">
                <Icon name="target" /> Best {best.discount_pct.toFixed(2)}%
              </QuickChip>
            )}
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

        <Panel title="Current plan vs scenario" actions={fetching ? <Spinner /> : action}>
          {result ? (
            <StaleOverlay on={fetching}>
              <FigureCompare
                columns={[
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
