import { useState } from 'react'
import { useChartWidth } from '../../components/charts/useChartWidth'
import { columnPath, tooltipLeft, TipRow, useChartSize } from '../../components/command/ChartSections'
import { SERIES } from '../../components/command/series'

/** MMM's charts, drawn the way TPO's Insights Hub draws its own
 *  (components/command/TrendPanels.tsx, ChartSections.tsx): plain SVG,
 *  straight lines, one shared grid, the platform's series palette, rounded
 *  column ends from the shared `columnPath`, and a tooltip that sits beside the
 *  hovered period rather than over it.
 *
 *  THE SAME VOCABULARY AS TPO. Revenue wears TPO's Incremental Sales violet, ad
 *  spend TPO's Trade Spend orange and ROAS TPO's ROI teal, so a reader moving
 *  between the hubs reads "money in", "money out" and "return" the same way.
 *  The baseline is the dashed reference line, as TPO's Target ROI is. */

export const MMM_SERIES = {
  revenue: SERIES.incremental,
  spend: SERIES.spend,
  roas: SERIES.roi,
  baseline: 'var(--text-muted)',
} as const

/** Column roles, as TPO's Performance Comparison card colours them. */
export const FILL = {
  current: 'var(--brand-violet)',
  against: 'color-mix(in srgb, var(--brand-violet) 42%, transparent)',
  idle: 'color-mix(in srgb, var(--text-primary) 12%, transparent)',
} as const
const STROKE_AGAINST = 'color-mix(in srgb, var(--brand-violet) 55%, transparent)'

const NICE = [1, 1.5, 2, 2.5, 3, 4, 5, 6, 7.5, 10]
function niceStep(raw: number): number {
  if (raw <= 0) return 1
  const mag = 10 ** Math.floor(Math.log10(raw))
  return (NICE.find((c) => c >= raw / mag - 1e-9) ?? 10) * mag
}

/** Axis labels: ₹ crore / lakh, $ M / K, two decimals — the backend's money(). */
export function axisMoney(value: number, currency: string): string {
  const symbol = currency === 'USD' ? '$' : '₹'
  const a = Math.abs(value)
  const steps: Array<[number, string]> =
    currency === 'USD' ? [[1e9, 'B'], [1e6, 'M'], [1e3, 'K']] : [[1e7, 'Cr'], [1e5, 'L'], [1e3, 'K']]
  for (const [size, suffix] of steps) if (a >= size) return `${symbol}${(value / size).toFixed(2)} ${suffix}`
  return `${symbol}${value.toFixed(0)}`
}

/** An axis from 0 (or below, when a value is negative) to a round maximum,
 *  in four equal steps. */
function axis(values: number[], floorAtZero = true) {
  const DIVISIONS = 4
  const hiRaw = Math.max(...values, floorAtZero ? 1 : 0)
  const loRaw = Math.min(0, ...values)
  const step = niceStep((hiRaw - loRaw) / DIVISIONS || 1)
  const lo = loRaw < 0 ? Math.floor(loRaw / step) * step : 0
  let hi = lo + step * DIVISIONS
  while (hi < hiRaw - 1e-9) hi += step
  const ticks: number[] = []
  for (let t = lo; t <= hi + step / 1e6; t += step) ticks.push(t)
  return { lo, hi, ticks }
}

const TICK_PITCH = 56

export type MmmTrendSeries = 'revenue' | 'spend' | 'baseline' | 'roas'

/** Revenue, ad spend and baseline revenue on the money axis (left), ROAS on
 *  the multiple axis (right). The two axes share one set of gridlines. A
 *  bucket with no ROAS (no spend, or no baseline) leaves a gap, never a 0. */
export function MmmTrend({
  trend,
  rate,
  currency,
  hidden,
  height = 380,
}: {
  trend: {
    labels: string[]
    revenue: number[]
    spend: number[]
    baseline: Array<number | null>
    roas: Array<number | null>
    revenue_display: string[]
    spend_display: string[]
    baseline_display: string[]
    roas_display: string[]
    widened: boolean[]
  }
  rate: number
  currency: string
  hidden: ReadonlySet<MmmTrendSeries>
  height?: number
}) {
  const { ref, width } = useChartWidth(640)
  const [hover, setHover] = useState<number | null>(null)
  const n = trend.labels.length
  const padL = 64
  const padR = 52
  const padT = 14
  const padB = 26
  const innerW = Math.max(120, width - padL - padR)
  const innerH = Math.max(80, height - padT - padB)
  const step = n > 0 ? innerW / n : innerW
  const x = (i: number) => padL + step * i + step / 2

  const show = (k: MmmTrendSeries) => !hidden.has(k)
  const moneyValues = [
    ...(show('revenue') ? trend.revenue : []),
    ...(show('spend') ? trend.spend : []),
    ...(show('baseline') ? trend.baseline.filter((v): v is number => v !== null) : []),
  ]
  const money = axis(moneyValues.length ? moneyValues : [...trend.revenue, ...trend.spend])
  const yMoney = (v: number) => padT + innerH * (1 - (v - money.lo) / (money.hi - money.lo || 1))
  // The ROAS axis is divided into the same four steps as the money axis, so
  // its labels land on the money axis's gridlines.
  const roasValues = trend.roas.filter((v): v is number => v !== null)
  const roasLoRaw = Math.min(0, ...roasValues)
  const roasHiRaw = Math.max(1, ...roasValues)
  const roasStep = niceStep((roasHiRaw - roasLoRaw) / (money.ticks.length - 1) || 1)
  const roasLo = roasLoRaw < 0 ? Math.floor(roasLoRaw / roasStep) * roasStep : 0
  const roasHi = roasLo + roasStep * (money.ticks.length - 1)
  const yRoas = (v: number) => padT + innerH * (1 - (v - roasLo) / (roasHi - roasLo || 1))

  const line = (values: Array<number | null>, y: (v: number) => number) => {
    const runs: string[] = []
    let run: string[] = []
    values.forEach((v, i) => {
      if (v === null) {
        if (run.length) runs.push(run.join(' '))
        run = []
      } else run.push(`${x(i)},${y(v)}`)
    })
    if (run.length) runs.push(run.join(' '))
    return runs
  }

  const every = Math.max(1, Math.ceil(TICK_PITCH / step))
  const active = hover !== null && hover < n ? hover : null
  const TIP_W = 228
  const tipLeft = active === null ? 0 : tooltipLeft(width, x(active) - step / 2, x(active) + step / 2, TIP_W, 8)

  return (
    <div ref={ref} className="relative w-full">
      <svg width={width} height={height} role="img" aria-label="Revenue, ad spend, baseline and ROAS trend">
        {money.ticks.map((t, k) => {
          const yy = yMoney(t)
          return (
            <g key={t}>
              <line x1={padL} x2={width - padR} y1={yy} y2={yy} stroke={t === money.lo ? 'var(--border-default)' : 'var(--border-subtle)'} />
              <text x={padL - 8} y={yy + 3} textAnchor="end" fontSize={10} fill="var(--text-muted)">
                {axisMoney(t * rate, currency)}
              </text>
              {show('roas') && (
                <text x={width - padR + 8} y={yy + 3} textAnchor="start" fontSize={10} fill="var(--text-muted)">
                  {(roasLo + roasStep * k).toFixed(2)}x
                </text>
              )}
            </g>
          )
        })}
        {active !== null && (
          <line x1={x(active)} x2={x(active)} y1={padT} y2={padT + innerH} stroke="var(--border-strong)" strokeDasharray="3 3" />
        )}
        {show('baseline') &&
          line(trend.baseline, yMoney).map((pts, k) => (
            <polyline key={`b${k}`} fill="none" stroke={MMM_SERIES.baseline} strokeWidth={2} strokeDasharray="5 4" points={pts} />
          ))}
        {show('revenue') && (
          <polyline fill="none" stroke={MMM_SERIES.revenue} strokeWidth={2} strokeLinejoin="round" points={line(trend.revenue, yMoney).join(' ')} />
        )}
        {show('spend') && (
          <polyline fill="none" stroke={MMM_SERIES.spend} strokeWidth={2} strokeLinejoin="round" points={line(trend.spend, yMoney).join(' ')} />
        )}
        {show('roas') &&
          line(trend.roas, yRoas).map((pts, k) => (
            <polyline key={`r${k}`} fill="none" stroke={MMM_SERIES.roas} strokeWidth={2} strokeLinejoin="round" points={pts} />
          ))}
        {n === 1 &&
          (['revenue', 'spend'] as const).map((k) =>
            show(k) ? <circle key={k} cx={x(0)} cy={yMoney(trend[k][0])} r={3.5} fill={MMM_SERIES[k]} /> : null,
          )}
        {active !== null && (
          <>
            {show('revenue') && <circle cx={x(active)} cy={yMoney(trend.revenue[active])} r={3.5} fill={MMM_SERIES.revenue} />}
            {show('spend') && <circle cx={x(active)} cy={yMoney(trend.spend[active])} r={3.5} fill={MMM_SERIES.spend} />}
            {show('baseline') && trend.baseline[active] !== null && (
              <circle cx={x(active)} cy={yMoney(trend.baseline[active] as number)} r={3.5} fill={MMM_SERIES.baseline} />
            )}
            {show('roas') && trend.roas[active] !== null && (
              <circle cx={x(active)} cy={yRoas(trend.roas[active] as number)} r={3.5} fill={MMM_SERIES.roas} />
            )}
          </>
        )}
        {trend.labels.map((l, i) =>
          i % every === 0 ? (
            <text key={l} x={x(i)} y={height - 6} textAnchor="middle" fontSize={10} fill="var(--text-muted)">
              {l}
            </text>
          ) : null,
        )}
        {trend.labels.map((l, i) => (
          <rect
            key={`h${l}`}
            x={x(i) - step / 2}
            y={0}
            width={step}
            height={height}
            fill="transparent"
            onMouseEnter={() => setHover(i)}
            onMouseLeave={() => setHover(null)}
          />
        ))}
      </svg>
      {active !== null && (
        <div
          className="pointer-events-none absolute top-2 z-20 rounded-[var(--r-md)] border border-border-default bg-surface-card p-2.5 text-xs shadow-[var(--shadow-lg)]"
          style={{ left: tipLeft, width: TIP_W }}
        >
          <div className="font-bold text-ink-primary">{trend.labels[active]}</div>
          <TipRow swatch={MMM_SERIES.revenue} k="Revenue" v={trend.revenue_display[active]} />
          <TipRow swatch={MMM_SERIES.spend} k="Ad spend" v={trend.spend_display[active]} />
          <TipRow swatch={MMM_SERIES.baseline} k="Baseline revenue" v={trend.baseline_display[active]} />
          <TipRow swatch={MMM_SERIES.roas} k="ROAS" v={trend.roas_display[active]} />
          {trend.widened[active] && (
            <div className="mt-1.5 border-t border-border-subtle pt-1.5 leading-[1.4] text-ink-muted">
              Baseline estimated over a wider window: this period lacks one kind of day the formula needs.
            </div>
          )}
        </div>
      )}
    </div>
  )
}

/** Columns with a value label above each, filling the card's height. Used by
 *  the comparison card (one column per period) and Revenue by Promotion Type
 *  (one per offer). `role` colours a column as TPO's comparison card does. */
export function ValueColumns({
  columns,
  format,
  ariaLabel,
  tooltip,
}: {
  columns: Array<{
    key: string
    label: string
    sub?: string
    value: number | null
    display: string
    role: 'current' | 'against' | 'idle'
  }>
  /** Axis tick text for a raw value. */
  format: (v: number) => string
  ariaLabel: string
  tooltip?: (index: number) => React.ReactNode
}) {
  const { ref, width, height } = useChartSize(520, 240)
  const [hover, setHover] = useState<number | null>(null)
  const padL = 60
  const padR = 8
  const padT = 22
  const padB = columns.some((c) => c.sub) ? 38 : 26
  const innerW = Math.max(120, width - padL - padR)
  const innerH = Math.max(80, height - padT - padB)
  const values = columns.map((c) => c.value).filter((v): v is number => v !== null)
  const { lo, hi, ticks } = axis(values.length ? values : [1])
  const y = (v: number) => padT + innerH * (1 - (v - lo) / (hi - lo || 1))
  const slot = innerW / Math.max(1, columns.length)
  const barW = Math.max(10, Math.min(56, slot * 0.5))
  const cx = (i: number) => padL + slot * i + slot / 2
  const zeroY = y(0)
  const active = hover !== null && hover < columns.length ? hover : null

  return (
    <div ref={ref} className="relative min-h-[220px] w-full flex-1">
      <svg className="absolute inset-0" width={width} height={height} role="img" aria-label={ariaLabel}>
        {ticks.map((t) => (
          <g key={t}>
            <line x1={padL} x2={padL + innerW} y1={y(t)} y2={y(t)} stroke={t === lo ? 'var(--border-default)' : 'var(--border-subtle)'} />
            <text x={padL - 7} y={y(t) + 3} textAnchor="end" fontSize={10} fill="var(--text-muted)">
              {format(t)}
            </text>
          </g>
        ))}
        {lo < 0 && <line x1={padL} x2={padL + innerW} y1={zeroY} y2={zeroY} stroke="var(--border-strong)" />}
        {columns.map((c, i) => {
          const isActive = active === i
          return (
            <g key={c.key}>
              <rect
                x={padL + slot * i + 1}
                y={padT - 8}
                width={Math.max(0, slot - 2)}
                height={innerH + 14}
                rx={6}
                fill="var(--surface-hover)"
                opacity={isActive ? 1 : 0}
                className="transition-opacity duration-150"
              />
              {c.value !== null && (
                <>
                  <path
                    d={columnPath(cx(i) - barW / 2, Math.min(y(c.value), zeroY), barW, Math.max(Math.abs(y(c.value) - zeroY), 2), c.value < 0)}
                    fill={FILL[c.role]}
                    stroke={c.role === 'against' ? STROKE_AGAINST : 'transparent'}
                    opacity={active === null || isActive ? 1 : 0.5}
                    className="transition-opacity duration-150"
                  />
                  <text
                    x={cx(i)}
                    y={c.value < 0 ? y(c.value) + 13 : y(c.value) - 6}
                    textAnchor="middle"
                    fontSize={10.5}
                    fontWeight={700}
                    fill="var(--text-primary)"
                  >
                    {c.display}
                  </text>
                </>
              )}
              {c.value === null && (
                <text x={cx(i)} y={zeroY - 6} textAnchor="middle" fontSize={10} fill="var(--text-muted)">
                  —
                </text>
              )}
              <text
                x={cx(i)}
                y={height - (c.sub ? 22 : 8)}
                textAnchor="middle"
                fontSize={10.5}
                fontWeight={c.role === 'idle' ? 500 : 700}
                fill={c.role === 'idle' ? 'var(--text-muted)' : 'var(--text-primary)'}
              >
                {c.label}
              </text>
              {c.sub && (
                <text x={cx(i)} y={height - 8} textAnchor="middle" fontSize={9.5} fill="var(--text-muted)">
                  {c.sub}
                </text>
              )}
              <rect
                x={padL + slot * i}
                y={0}
                width={slot}
                height={height}
                fill="transparent"
                onMouseEnter={() => setHover(i)}
                onMouseLeave={() => setHover(null)}
              />
            </g>
          )
        })}
      </svg>
      {active !== null && tooltip && (
        <div
          className="pointer-events-none absolute top-0 z-20 w-52 rounded-[var(--r-md)] border border-border-default bg-surface-card p-2.5 text-xs shadow-[var(--shadow-lg)]"
          style={{ left: tooltipLeft(width, padL + slot * active, padL + slot * (active + 1), 208) }}
        >
          {tooltip(active)}
        </div>
      )}
    </div>
  )
}

/** Average daily revenue on days WITH an event beside days WITHOUT it, one
 *  pair per event: "with" in the brand violet, "without" in its tint. */
export function PairedColumns({
  groups,
  rate,
  currency,
}: {
  groups: Array<{
    key: string
    label: string
    with_avg: number | null
    with_avg_display: string
    without_avg: number | null
    without_avg_display: string
    with_days: number
    without_days: number
    difference_display: string
  }>
  rate: number
  currency: string
}) {
  const { ref, width, height } = useChartSize(520, 240)
  const [hover, setHover] = useState<number | null>(null)
  const padL = 60
  const padR = 8
  const padT = 16
  const padB = 38
  const innerW = Math.max(120, width - padL - padR)
  const innerH = Math.max(80, height - padT - padB)
  const values = groups.flatMap((g) => [g.with_avg, g.without_avg]).filter((v): v is number => v !== null)
  const { lo, hi, ticks } = axis(values.length ? values : [1])
  const y = (v: number) => padT + innerH * (1 - (v - lo) / (hi - lo || 1))
  const slot = innerW / Math.max(1, groups.length)
  const barW = Math.max(8, Math.min(30, slot * 0.3))
  const gap = 4
  const cx = (i: number) => padL + slot * i + slot / 2
  const active = hover !== null && hover < groups.length ? hover : null

  return (
    <div ref={ref} className="relative min-h-[220px] w-full flex-1">
      <svg className="absolute inset-0" width={width} height={height} role="img" aria-label="Average daily revenue, days with versus without each event">
        {ticks.map((t) => (
          <g key={t}>
            <line x1={padL} x2={padL + innerW} y1={y(t)} y2={y(t)} stroke={t === lo ? 'var(--border-default)' : 'var(--border-subtle)'} />
            <text x={padL - 7} y={y(t) + 3} textAnchor="end" fontSize={10} fill="var(--text-muted)">
              {axisMoney(t * rate, currency)}
            </text>
          </g>
        ))}
        {groups.map((g, i) => {
          const isActive = active === i
          const bars: Array<[number | null, string, string]> = [
            [g.with_avg, FILL.current, 'transparent'],
            [g.without_avg, FILL.against, STROKE_AGAINST],
          ]
          return (
            <g key={g.key}>
              <rect
                x={padL + slot * i + 1}
                y={padT - 6}
                width={Math.max(0, slot - 2)}
                height={innerH + 12}
                rx={6}
                fill="var(--surface-hover)"
                opacity={isActive ? 1 : 0}
                className="transition-opacity duration-150"
              />
              {bars.map(([v, fill, stroke], k) =>
                v === null ? null : (
                  <path
                    key={k}
                    d={columnPath(cx(i) + (k === 0 ? -barW - gap / 2 : gap / 2), y(v), barW, Math.max(y(lo) - y(v), 2), false)}
                    fill={fill}
                    stroke={stroke}
                    opacity={active === null || isActive ? 1 : 0.5}
                    className="transition-opacity duration-150"
                  />
                ),
              )}
              <text x={cx(i)} y={height - 22} textAnchor="middle" fontSize={10.5} fontWeight={700} fill="var(--text-primary)">
                {g.label}
              </text>
              <text x={cx(i)} y={height - 8} textAnchor="middle" fontSize={9.5} fill="var(--text-muted)">
                {g.difference_display}
              </text>
              <rect
                x={padL + slot * i}
                y={0}
                width={slot}
                height={height}
                fill="transparent"
                onMouseEnter={() => setHover(i)}
                onMouseLeave={() => setHover(null)}
              />
            </g>
          )
        })}
      </svg>
      {active !== null && (
        <div
          className="pointer-events-none absolute top-0 z-20 w-56 rounded-[var(--r-md)] border border-border-default bg-surface-card p-2.5 text-xs shadow-[var(--shadow-lg)]"
          style={{ left: tooltipLeft(width, padL + slot * active, padL + slot * (active + 1), 224) }}
        >
          <div className="font-bold text-ink-primary">{groups[active].label}</div>
          <TipRow swatch={FILL.current} k={`With · ${groups[active].with_days.toLocaleString()} days`} v={groups[active].with_avg_display} />
          <TipRow swatch={FILL.against} k={`Without · ${groups[active].without_days.toLocaleString()} days`} v={groups[active].without_avg_display} />
          <TipRow k="Difference" v={groups[active].difference_display} />
        </div>
      )}
    </div>
  )
}

/** Horizontal share bars — one row per item, the bar scaled to the largest. */
export function ShareBars({
  rows,
  color = SERIES.spend,
}: {
  rows: Array<{ key: string; label: string; sub?: string; value: number; display: string; share: string }>
  color?: string
}) {
  const max = Math.max(...rows.map((r) => r.value), 1)
  return (
    <ul className="flex flex-col gap-2.5">
      {rows.map((r) => (
        <li key={r.key}>
          <div className="mb-1 flex items-baseline justify-between gap-3 text-sm">
            <span className="min-w-0 truncate font-semibold text-ink-primary" title={r.label}>
              {r.label}
              {r.sub && <span className="ml-1.5 font-normal text-ink-muted">{r.sub}</span>}
            </span>
            <span className="shrink-0 tabular-nums text-ink-secondary">
              {r.display} <span className="text-ink-muted">· {r.share}</span>
            </span>
          </div>
          <div className="h-2 overflow-hidden rounded-full bg-surface-muted">
            <div className="h-full rounded-full" style={{ width: `${(r.value / max) * 100}%`, background: color }} />
          </div>
        </li>
      ))}
    </ul>
  )
}
