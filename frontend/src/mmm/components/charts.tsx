import { useLayoutEffect, useRef, useState, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
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

/** `axis`, with room above the tallest column for the value label printed
 *  over it: a peak within ~12% of the axis top had its label sitting on the
 *  top gridline's own tick. */
function axisWithLabelRoom(values: number[]) {
  const peak = Math.max(0, ...values)
  return axis(peak > 0 ? [...values, peak * 1.12] : values)
}

const TICK_PITCH = 56

/** X-axis ticks every `every` labels, printing the year only on the first
 *  tick and where it changes — "Jan 2025, Feb, Mar … Jan 2026", as TPO's
 *  trend does. Tooltips keep the full label. */
function yearAwareTicks(labels: string[], every: number): Array<{ i: number; text: string }> {
  const out: Array<{ i: number; text: string }> = []
  let lastYear: string | null = null
  for (let i = 0; i < labels.length; i += every) {
    const label = labels[i]
    const year = label.match(/\b(\d{4})\b/)?.[1] ?? null
    out.push({ i, text: year && year === lastYear ? label.replace(/\s*\b\d{4}\b/, '').trim() : label })
    lastYear = year
  }
  return out
}

/** The legend's toggles. `breakeven` is the dashed 1.00x reference on the
 *  ROAS axis, as TPO's `target` is the dashed Target ROI. */
export type MmmTrendSeries = 'revenue' | 'spend' | 'baseline' | 'roas' | 'breakeven'

/** ROAS at which incremental revenue equals ad spend. */
export const BREAKEVEN_ROAS = 1

const PERIOD_WORD = { day: 'Day', week: 'Week', month: 'Month' } as const

/** Revenue, ad spend and baseline revenue on the money axis (left), ROAS on
 *  the multiple axis (right). The two axes share one set of gridlines. A
 *  bucket with no ROAS (no spend, or no baseline) leaves a gap, never a 0.
 *  The tooltip lists only the series the legend has left on, as TPO's does. */
export function MmmTrend({
  trend,
  rate,
  currency,
  hidden,
  height = 380,
}: {
  trend: {
    granularity?: 'day' | 'week' | 'month'
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
    days?: number[]
    ad_days?: number[]
    events?: Array<Array<{ label: string; days: number; pct: number }>>
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
  const roasDivs = Math.max(1, money.ticks.length - 1)
  const roasFloor = (step: number) => (roasLoRaw < 0 ? Math.floor(roasLoRaw / step) * step : 0)
  let roasStep = niceStep((roasHiRaw - roasLoRaw) / roasDivs || 1)
  // Flooring a negative minimum to a whole step can leave the top of the
  // axis below the highest ROAS, and the line ran off the plot. Widen the
  // step until the axis holds every value.
  while (roasFloor(roasStep) + roasStep * roasDivs < roasHiRaw - 1e-9) roasStep = niceStep(roasStep * 1.001)
  const roasLo = roasFloor(roasStep)
  const roasHi = roasLo + roasStep * roasDivs
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
  const xTicks = yearAwareTicks(trend.labels, every)
  const active = hover !== null && hover < n ? hover : null
  // Wider when the period's event mix is listed, so a combination such as
  // "Festival + Seasonal + 10% Discount" stays on one line.
  const TIP_W = trend.events ? 300 : 228
  const tipLeft = active === null ? 0 : tooltipLeft(width, x(active) - step / 2, x(active) + step / 2, TIP_W, 8)
  const moneyAxis = show('revenue') || show('spend') || show('baseline')
  const roasAxis = show('roas') || show('breakeven')
  const roasAt = active === null ? null : trend.roas[active]
  const periodWord = PERIOD_WORD[trend.granularity ?? 'month']

  return (
    <div ref={ref} className="relative w-full">
      <svg width={width} height={height} role="img" aria-label="Revenue, ad spend, baseline and ROAS trend">
        {money.ticks.map((t, k) => {
          const yy = yMoney(t)
          return (
            <g key={t}>
              <line x1={padL} x2={width - padR} y1={yy} y2={yy} stroke={t === money.lo ? 'var(--border-default)' : 'var(--border-subtle)'} />
              {moneyAxis && (
                <text x={padL - 8} y={yy + 3} textAnchor="end" fontSize={10} fill="var(--text-muted)">
                  {axisMoney(t * rate, currency)}
                </text>
              )}
              {roasAxis && (
                <text x={width - padR + 8} y={yy + 3} textAnchor="start" fontSize={10} fill="var(--text-muted)">
                  {(roasLo + roasStep * k).toFixed(2)}x
                </text>
              )}
            </g>
          )
        })}
        {/* Break-even — a reference on the ROAS axis, never a business curve. */}
        {show('breakeven') && (
          <>
            <line
              x1={padL}
              x2={width - padR}
              y1={yRoas(BREAKEVEN_ROAS)}
              y2={yRoas(BREAKEVEN_ROAS)}
              stroke={MMM_SERIES.roas}
              strokeWidth={1.5}
              strokeDasharray="2 4"
              opacity={0.7}
            />
            <text
              x={width - padR - 4}
              y={yRoas(BREAKEVEN_ROAS) - 4}
              textAnchor="end"
              fontSize={10}
              fontWeight={700}
              fill="var(--text-muted)"
            >
              Break-even {BREAKEVEN_ROAS.toFixed(2)}x
            </text>
          </>
        )}
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
        {xTicks.map((t) => (
          <text key={t.i} x={x(t.i)} y={height - 6} textAnchor="middle" fontSize={10} fill="var(--text-muted)">
            {t.text}
          </text>
        ))}
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
          <div className="flex items-center justify-between gap-2 font-bold text-ink-primary">
            <span className="truncate">
              {periodWord} {trend.labels[active]}
            </span>
            {roasAt !== null && roasAt < BREAKEVEN_ROAS && (
              <span className="shrink-0 text-[11px] font-semibold text-status-danger">Below break-even</span>
            )}
          </div>
          {show('revenue') && <TipRow swatch={MMM_SERIES.revenue} k="Revenue" v={trend.revenue_display[active]} />}
          {show('spend') && <TipRow swatch={MMM_SERIES.spend} k="Ad spend" v={trend.spend_display[active]} />}
          {show('baseline') && <TipRow swatch={MMM_SERIES.baseline} k="Baseline revenue" v={trend.baseline_display[active]} />}
          {show('roas') &&
            (roasAt === null ? (
              <div className="mt-1 text-ink-muted">ROAS — no ad spend or no baseline</div>
            ) : (
              <TipRow swatch={MMM_SERIES.roas} k="ROAS" v={trend.roas_display[active]} />
            ))}
          {show('breakeven') && <TipRow k="Break-even ROAS" v={`${BREAKEVEN_ROAS.toFixed(2)}x`} />}
          {!moneyAxis && !roasAxis && <div className="mt-1 text-ink-muted">Every series is hidden.</div>}
          {trend.events && trend.ad_days && (
            <EventMix title="Ad spend days" days={trend.ad_days[active]} of={trend.days?.[active]} events={trend.events[active]} />
          )}
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
  onPick,
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
  /** Makes a column clickable — the comparison card picks its period this way. */
  onPick?: (index: number) => void
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
  const { lo, hi, ticks } = axisWithLabelRoom(values.length ? values : [1])
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
                className={onPick ? 'cursor-pointer' : undefined}
                onMouseEnter={() => setHover(i)}
                onMouseLeave={() => setHover(null)}
                onClick={onPick ? () => onPick(i) : undefined}
              />
            </g>
          )
        })}
      </svg>
      {active !== null && tooltip && (
        <div
          className="pointer-events-none absolute top-0 z-20 w-56 rounded-[var(--r-md)] border border-border-default bg-surface-card p-2.5 text-xs shadow-[var(--shadow-lg)]"
          style={{ left: tooltipLeft(width, padL + slot * active, padL + slot * (active + 1), 224) }}
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

/** RANKED COLUMNS — one column per item on one axis, in the colour of the
 *  measure, the measure's value above each column and the item's name below.
 *  Nothing else is printed: the item's other figures are in the tooltip
 *  beside the hovered column. Fills the height its card is given, so it sits
 *  level with a taller neighbour instead of leaving the card's foot empty. */
export function RankedColumns({
  items,
  color,
  format,
  ariaLabel,
}: {
  items: Array<{
    key: string
    label: string
    value: number | null
    display: string
    /** A second figure under the name — the ROAS, in its tone — as TPO's
     *  Sales by Region prints the ROI under each region. */
    sub?: { text: string; color: string }
    details: Array<[string, string, string?]>
  }>
  color: string
  /** Axis tick text for a raw value. */
  format: (v: number) => string
  ariaLabel: string
}) {
  const { ref, width, height } = useChartSize(520, 300)
  const [hover, setHover] = useState<number | null>(null)
  const n = items.length
  const padL = 60
  const padR = 8
  const padT = 22
  const padB = items.some((c) => c.sub) ? 42 : 28
  const innerW = Math.max(120, width - padL - padR)
  const innerH = Math.max(80, height - padT - padB)
  const values = items.map((c) => c.value).filter((v): v is number => v !== null)
  const { lo, hi, ticks } = axisWithLabelRoom(values.length ? values : [1])
  const y = (v: number) => padT + innerH * (1 - (v - lo) / (hi - lo || 1))
  const slot = innerW / Math.max(1, n)
  const barW = Math.max(14, Math.min(44, slot * 0.46))
  const cx = (i: number) => padL + slot * i + slot / 2
  const zeroY = y(0)
  const active = hover !== null && hover < n ? hover : null
  // Names are cut to the slot so neighbours never collide; the full name is
  // in the tooltip.
  const maxChars = Math.max(4, Math.floor((slot - 6) / 6))
  const fit = (s: string) => (s.length > maxChars ? `${s.slice(0, maxChars - 1)}…` : s)
  const TIP_W = 224


  return (
    <div ref={ref} className="relative min-h-[260px] w-full flex-1">
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
        {items.map((c, i) => {
          const isActive = active === i
          const negative = c.value !== null && c.value < 0
          return (
            <g key={c.key}>
              <rect
                x={padL + slot * i + 2}
                y={padT - 14}
                width={Math.max(0, slot - 4)}
                height={innerH + 14}
                rx={6}
                fill="var(--surface-hover)"
                opacity={isActive ? 1 : 0}
                className="transition-opacity duration-150"
              />
              {c.value !== null && c.value !== 0 && (
                <path
                  d={columnPath(cx(i) - barW / 2, Math.min(y(c.value), zeroY), barW, Math.max(Math.abs(y(c.value) - zeroY), 2), negative)}
                  fill={negative ? 'var(--status-danger)' : color}
                  opacity={active === null || isActive ? 1 : 0.45}
                  className="transition-opacity duration-150"
                />
              )}
              <text
                x={cx(i)}
                y={c.value === null ? zeroY - 6 : negative ? y(c.value) + 13 : y(c.value) - 6}
                textAnchor="middle"
                fontSize={10.5}
                fontWeight={700}
                fill={c.value === null ? 'var(--text-muted)' : 'var(--text-primary)'}
                opacity={active === null || isActive ? 1 : 0.55}
              >
                {c.value === null ? '—' : c.display}
              </text>
              <text
                x={cx(i)}
                y={height - (c.sub ? 23 : 9)}
                textAnchor="middle"
                fontSize={10.5}
                fontWeight={isActive ? 700 : 600}
                fill={isActive ? 'var(--text-primary)' : 'var(--text-secondary)'}
              >
                {fit(c.label)}
              </text>
              {c.sub && (
                <text x={cx(i)} y={height - 8} textAnchor="middle" fontSize={10} fontWeight={700} fill={c.sub.color}>
                  {c.sub.text}
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
      {active !== null && (
        <div
          role="tooltip"
          className="pointer-events-none absolute top-0 z-20 rounded-[var(--r-md)] border border-border-default bg-surface-card p-2.5 text-xs shadow-[var(--shadow-lg)]"
          style={{ left: tooltipLeft(width, padL + slot * active, padL + slot * (active + 1), TIP_W), width: TIP_W }}
        >
          <div className="font-bold text-ink-primary">{items[active].label}</div>
          {items[active].details.map(([k, v, swatch]) => (
            <TipRow key={k} k={k} v={v} swatch={swatch} />
          ))}
        </div>
      )}
      <ul className="sr-only">
        {items.map((c) => (
          <li key={c.key}>
            {c.label}: {c.details.map(([k, v]) => `${k} ${v}`).join(', ')}
          </li>
        ))}
      </ul>
    </div>
  )
}

/** CONTEXT COLUMNS — TPO's Performance Comparison chart: the thirteen months
 *  ending at the selected one, the selected month solid, the month it is
 *  compared with tinted and outlined, every other month recessive. Thirteen
 *  so the year-ago month is the left-most column. Only the two highlighted
 *  columns carry a value label; every month's figures are in its tooltip,
 *  and clicking a month selects it. */
export function ContextColumns({
  points,
  format,
  ariaLabel,
  onPick,
}: {
  points: Array<{
    key: string
    month: string
    /** Printed under the month on the first column and at each January. */
    year: string | null
    value: number | null
    display: string
    role: 'current' | 'against' | 'idle'
    title: string
    details: Array<[string, string, string?]>
  }>
  format: (v: number) => string
  ariaLabel: string
  onPick?: (index: number) => void
}) {
  const { ref, width, height } = useChartSize(560, 250)
  const [hover, setHover] = useState<number | null>(null)
  const n = points.length
  const padL = 60
  const padR = 8
  const padT = 20
  const padB = 34
  const innerW = Math.max(120, width - padL - padR)
  const innerH = Math.max(80, height - padT - padB)
  const values = points.map((p) => p.value).filter((v): v is number => v !== null)
  const { lo, hi, ticks } = axisWithLabelRoom(values.length ? values : [1])
  const y = (v: number) => padT + innerH * (1 - (v - lo) / (hi - lo || 1))
  const zeroY = y(0)
  const slot = innerW / Math.max(1, n)
  const barW = Math.max(6, Math.min(26, slot * 0.56))
  const cx = (i: number) => padL + slot * i + slot / 2
  const active = hover !== null && hover < n ? hover : null
  const TIP_W = 208

  return (
    <div ref={ref} className="relative min-h-[200px] w-full flex-1">
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
        {points.map((p, i) => {
          const isActive = active === i
          const v = p.value
          const highlighted = p.role !== 'idle'
          return (
            <g key={p.key}>
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
              {v !== null && (
                <path
                  d={columnPath(cx(i) - barW / 2, Math.min(y(v), zeroY), barW, Math.max(Math.abs(y(v) - zeroY), 2), v < 0)}
                  fill={FILL[p.role]}
                  stroke={p.role === 'against' ? STROKE_AGAINST : 'transparent'}
                  opacity={active === null || isActive ? 1 : 0.5}
                  className="transition-opacity duration-150"
                />
              )}
              {highlighted && v !== null && (
                // The first and last columns align their label inward, so it
                // never overhangs the plot onto the axis labels.
                <text
                  x={i === 0 ? cx(i) - barW / 2 : i === n - 1 ? cx(i) + barW / 2 : cx(i)}
                  y={v < 0 ? y(v) + 13 : y(v) - 6}
                  textAnchor={i === 0 ? 'start' : i === n - 1 ? 'end' : 'middle'}
                  fontSize={10}
                  fontWeight={700}
                  fill="var(--text-primary)"
                >
                  {p.display}
                </text>
              )}
              <text
                x={cx(i)}
                y={height - 19}
                textAnchor="middle"
                fontSize={10}
                fontWeight={highlighted ? 700 : 500}
                fill={highlighted ? 'var(--text-primary)' : 'var(--text-muted)'}
              >
                {p.month}
              </text>
              {p.year && (
                <text x={cx(i)} y={height - 7} textAnchor="middle" fontSize={10} fontWeight={700} fill="var(--text-muted)">
                  {p.year}
                </text>
              )}
              <rect
                x={padL + slot * i}
                y={0}
                width={slot}
                height={height}
                fill="transparent"
                className={onPick ? 'cursor-pointer' : undefined}
                onMouseEnter={() => setHover(i)}
                onMouseLeave={() => setHover(null)}
                onClick={onPick ? () => onPick(i) : undefined}
              />
            </g>
          )
        })}
      </svg>
      {active !== null && (
        <div
          role="tooltip"
          className="pointer-events-none absolute top-0 z-20 rounded-[var(--r-md)] border border-border-default bg-surface-card p-2.5 text-xs shadow-[var(--shadow-lg)]"
          style={{ left: tooltipLeft(width, padL + slot * active, padL + slot * (active + 1), TIP_W), width: TIP_W }}
        >
          <div className="font-bold text-ink-primary">{points[active].title}</div>
          {points[active].details.map(([k, v, swatch]) => (
            <TipRow key={k} k={k} v={v} swatch={swatch} />
          ))}
        </div>
      )}
      <ul className="sr-only">
        {points.map((p) => (
          <li key={p.key}>
            {p.title}: {p.details.map(([k, v]) => `${k} ${v}`).join(', ')}
          </li>
        ))}
      </ul>
    </div>
  )
}

/** RUNNING LINES — YTD as it built up: one line for this year's running
 *  total and one, dashed, for the same months a year earlier, from January
 *  to the selected month. The gap between them is the YTD comparison, read
 *  month by month. */
export function RunningLines({
  labels,
  current,
  previous,
  currentName,
  previousName,
  format,
  ariaLabel,
}: {
  labels: string[]
  current: Array<number | null>
  previous: Array<number | null>
  currentName: string
  previousName: string
  /** Formats a raw (rupee) value for both the axis and the tooltip. */
  format: (v: number) => string
  ariaLabel: string
}) {
  const { ref, width, height } = useChartSize(560, 250)
  const [hover, setHover] = useState<number | null>(null)
  const n = labels.length
  const padL = 60
  const padR = 16
  const padT = 20
  const padB = 24
  const innerW = Math.max(120, width - padL - padR)
  const innerH = Math.max(80, height - padT - padB)
  const all = [...current, ...previous].filter((v): v is number => v !== null)
  const { lo, hi, ticks } = axis(all.length ? all : [1])
  const y = (v: number) => padT + innerH * (1 - (v - lo) / (hi - lo || 1))
  const step = innerW / Math.max(1, n)
  const x = (i: number) => padL + step * i + step / 2
  const path = (vals: Array<number | null>) =>
    vals.map((v, i) => (v === null ? null : `${x(i)},${y(v)}`)).filter(Boolean).join(' ')
  const active = hover !== null && hover < n ? hover : null
  const TIP_W = 220
  const PREV = 'var(--text-muted)'

  return (
    <div ref={ref} className="relative min-h-[200px] w-full flex-1">
      <svg className="absolute inset-0" width={width} height={height} role="img" aria-label={ariaLabel}>
        {ticks.map((t) => (
          <g key={t}>
            <line x1={padL} x2={padL + innerW} y1={y(t)} y2={y(t)} stroke={t === lo ? 'var(--border-default)' : 'var(--border-subtle)'} />
            <text x={padL - 7} y={y(t) + 3} textAnchor="end" fontSize={10} fill="var(--text-muted)">
              {format(t)}
            </text>
          </g>
        ))}
        {active !== null && (
          <line x1={x(active)} x2={x(active)} y1={padT} y2={padT + innerH} stroke="var(--border-strong)" strokeDasharray="3 3" />
        )}
        <polyline fill="none" stroke={PREV} strokeWidth={2} strokeDasharray="5 4" strokeLinejoin="round" points={path(previous)} />
        <polyline fill="none" stroke="var(--brand-violet)" strokeWidth={2} strokeLinejoin="round" points={path(current)} />
        {current.map((v, i) =>
          v === null ? null : (
            <circle key={`c${i}`} cx={x(i)} cy={y(v)} r={active === i || i === n - 1 ? 4 : 2.5} fill="var(--brand-violet)" />
          ),
        )}
        {previous.map((v, i) =>
          v === null ? null : <circle key={`p${i}`} cx={x(i)} cy={y(v)} r={active === i || i === n - 1 ? 4 : 2.5} fill={PREV} />,
        )}
        {labels.map((l, i) => (
          <text key={l} x={x(i)} y={height - 6} textAnchor="middle" fontSize={10} fontWeight={active === i ? 700 : 500} fill="var(--text-muted)">
            {l}
          </text>
        ))}
        {labels.map((l, i) => (
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
          role="tooltip"
          className="pointer-events-none absolute top-0 z-20 rounded-[var(--r-md)] border border-border-default bg-surface-card p-2.5 text-xs shadow-[var(--shadow-lg)]"
          style={{ left: tooltipLeft(width, x(active) - step / 2, x(active) + step / 2, TIP_W, 8), width: TIP_W }}
        >
          <div className="font-bold text-ink-primary">Jan – {labels[active]} (to date)</div>
          <TipRow swatch="var(--brand-violet)" k={currentName} v={current[active] === null ? '—' : format(current[active] as number)} />
          <TipRow swatch={PREV} k={previousName} v={previous[active] === null ? '—' : format(previous[active] as number)} />
        </div>
      )}
      <ul className="sr-only">
        {labels.map((l, i) => (
          <li key={l}>
            Jan to {l}: {currentName} {current[i] === null ? '—' : format(current[i] as number)}, {previousName}{' '}
            {previous[i] === null ? '—' : format(previous[i] as number)}
          </li>
        ))}
      </ul>
    </div>
  )
}

/** THE FIVE DRIVERS of the decomposition, in ring order, each with a hue of
 *  its own. Ad Spend wears the page's spend orange (the trend's Ad Spend
 *  line); the baseline a slate that reads on the card without shouting.
 *  Theme tokens, so dark mode follows. */
export const DRIVERS = [
  { key: 'baseline', label: 'Baseline', color: 'color-mix(in srgb, var(--text-secondary) 38%, var(--surface-card))' },
  { key: 'festival', label: 'Festival', color: 'var(--brand-violet)' },
  { key: 'seasonal', label: 'Seasonal', color: 'var(--tint-teal-icon)' },
  { key: 'promotion', label: 'Promotion', color: 'var(--tint-rose-icon)' },
  { key: 'media', label: 'Ad Spend', color: SERIES.spend },
] as const
export type DriverKey = (typeof DRIVERS)[number]['key']

/** One ring segment from angle a0 to a1 (radians, 0 = 12 o'clock). */
function arcPath(cx: number, cy: number, r0: number, r1: number, a0: number, a1: number): string {
  const sweep = a1 - a0
  if (sweep >= Math.PI * 2 - 1e-6) {
    // A full ring: two halves, since one arc cannot start and end at a point.
    return `${arcPath(cx, cy, r0, r1, a0, a0 + Math.PI)} ${arcPath(cx, cy, r0, r1, a0 + Math.PI, a1)}`
  }
  const p = (r: number, a: number) => `${cx + r * Math.sin(a)},${cy - r * Math.cos(a)}`
  const large = sweep > Math.PI ? 1 : 0
  return `M${p(r1, a0)} A${r1},${r1} 0 ${large} 1 ${p(r1, a1)} L${p(r0, a1)} A${r0},${r0} 0 ${large} 0 ${p(r0, a0)} Z`
}

interface DonutSlice {
  key: string
  kind: 'baseline' | 'event' | 'media'
  label: string
  value: number
  display: string
  share: number
  share_display: string
  members: Array<{ label: string; value: number; display: string }>
}

const pctText = (p: number) => `${p.toFixed(2)}%`

/** REVENUE DECOMPOSITION DONUT — the heart of the hub. Three levels:
 *
 *  DRIVERS   Baseline, Festival, Seasonal, Promotion and Ad Spend on one ring,
 *            total revenue in the centre. Selection is the card's chips;
 *            only Ad Spend (row or slice, marked ›) opens a level down.
 *  CHANNELS  Ad Spend's contribution as a ring of its channels. Each channel
 *            (row or slice, marked ›) opens; hovering a row previews its
 *            sub-channels on the ring.
 *  SUB-CHANNELS  One channel's contribution as a ring of its sub-channels,
 *            in shades of the channel's colour, with its own legend.
 *
 *  NOTHING MOVES ON HOVER, SELECTION OR NAVIGATION: the summary has a fixed
 *  height and the legend rows a fixed size. A slice too thin to see gets a
 *  minimum width on the ring; its true figure is always the legend's. */
export function DecompositionDonut({
  slices,
  totalDisplay,
  selected,
  drilled,
  onDrill,
  format,
}: {
  slices: DonutSlice[]
  totalDisplay: string
  selected: ReadonlySet<DriverKey>
  /** Ad Spend opened (the channels level or below). */
  drilled: boolean
  onDrill: (open: boolean) => void
  /** Formats a summed raw amount. */
  format: (v: number) => string
}) {
  const { ref, width, height } = useChartSize(560, 300)
  const [hoverKey, setHover] = useState<string | null>(null)
  // Channels level: the channel whose row is hovered (previewed on the ring)
  // and the channel opened (the sub-channels level).
  const [previewKey, setPreview] = useState<string | null>(null)
  const [channelKey, setChannel] = useState<string | null>(null)

  const revenue = slices.reduce((t, sl) => t + sl.value, 0) || 1
  const valueOf = (k: DriverKey) =>
    slices.filter((sl) => (k === 'media' ? sl.kind === 'media' : sl.key === k)).reduce((t, sl) => t + sl.value, 0)
  const channels = slices.filter((sl) => sl.kind === 'media' && sl.value > 0)
  const adTotal = valueOf('media')
  const open = drilled && channels.length > 0

  type Seg = { key: string; label: string; value: number; display: string; color: string; pct: number; pctRevenue: number; members: DonutSlice['members'] }
  const channelSegs: Seg[] = channels.map((ch, i) => ({
    key: ch.key,
    label: ch.label,
    value: ch.value,
    display: ch.display,
    color: PART_COLORS[i % PART_COLORS.length],
    pct: (ch.value / (adTotal || 1)) * 100,
    pctRevenue: (ch.value / revenue) * 100,
    members: ch.members,
  }))
  /** A channel's sub-channels, in shades of its colour. */
  const subSegs = (ch: Seg): Seg[] => {
    const whole = ch.members.reduce((t, m) => t + m.value, 0) || 1
    const shades = [100, 72, 50, 32, 20]
    return ch.members.map((m, i) => ({
      key: `${ch.key}:${m.label}`,
      label: m.label,
      value: m.value,
      display: m.display,
      color: `color-mix(in srgb, ${ch.color} ${shades[i % shades.length]}%, var(--surface-card))`,
      pct: (m.value / whole) * 100,
      pctRevenue: (m.value / revenue) * 100,
      members: [],
    }))
  }
  const channel = open ? (channelSegs.find((ch) => ch.key === channelKey && ch.members.length > 0) ?? null) : null
  const level: 'drivers' | 'channels' | 'sub' = !open ? 'drivers' : channel ? 'sub' : 'channels'

  const driverSegs: Seg[] = DRIVERS.map((d) => {
    const value = valueOf(d.key)
    const own = slices.find((sl) => sl.key === d.key)
    return {
      key: d.key as string,
      label: d.label,
      value,
      display: own?.display ?? format(value),
      color: d.color as string,
      pct: (value / revenue) * 100,
      pctRevenue: (value / revenue) * 100,
      members: [],
    }
  }).filter((d) => d.value > 0)

  /** The legend's parts at this level. */
  const segments: Seg[] = level === 'drivers' ? driverSegs : level === 'channels' ? channelSegs : subSegs(channel!)
  const hover = segments.some((sg) => sg.key === hoverKey) ? hoverKey : null
  const preview = level === 'channels' ? (channelSegs.find((ch) => ch.key === previewKey && ch.members.length > 0) ?? null) : null
  /** The ring's parts: the legend's, or a hovered channel's sub-channels. */
  const ringParts = preview ? subSegs(preview) : segments

  // The ring: a part under ~1.2% is drawn at that width so it can be seen
  // and pointed at; the sweep is renormalised to a full circle.
  const MIN = 0.075
  const raw = ringParts.map((sg) => Math.max((sg.pct / 100) * Math.PI * 2, MIN))
  const scale = (Math.PI * 2) / (raw.reduce((x, y) => x + y, 0) || 1)
  let angle = 0
  const arcs = ringParts.map((sg, i) => {
    const a0 = angle
    angle += raw[i] * scale
    return { ...sg, a0, a1: angle }
  })

  const stacked = width < 480
  // Below the drivers the legend gets more width for the longer names.
  const size = Math.max(180, Math.min(stacked ? width - 20 : width * (open ? 0.33 : 0.4), height - 10, open ? 240 : 270))
  const c = size / 2
  const r1 = c - 8
  const r0 = r1 * 0.62
  const anySelected = level === 'drivers' && selected.size > 0
  const isOn = (k: string) => hover === k || (level === 'drivers' && selected.has(k as DriverKey))
  const isDim = (k: string) => (hover !== null || anySelected) && !isOn(k)

  const picked = level === 'drivers' ? segments.filter((sg) => selected.has(sg.key as DriverKey)) : []
  const pickedValue = picked.reduce((t, sg) => t + sg.value, 0)
  const hovered = preview ? null : hover ? (ringParts.find((sg) => sg.key === hover) ?? null) : null

  /** Only what opens a level is clickable: Ad Spend, then each channel. */
  const opens = (key: string) => (level === 'drivers' && key === 'media') || level === 'channels'
  const openSeg = (key: string) => {
    if (level === 'drivers' && key === 'media') {
      setChannel(null)
      onDrill(true)
    } else if (level === 'channels') {
      setPreview(null)
      setHover(null)
      setChannel(key)
    }
  }

  // The centre: what is hovered or previewed, else what the level is about.
  const centre = preview
    ? { value: preview.display, label: preview.label, sub: `${preview.members.length} sub-channel${preview.members.length === 1 ? '' : 's'}` }
    : hovered
      ? { value: hovered.display, label: hovered.label, sub: `${pctText(hovered.pct)} of ${level === 'drivers' ? 'revenue' : level === 'channels' ? 'Ad Spend' : channel!.label}` }
      : level === 'sub'
        ? { value: channel!.display, label: channel!.label, sub: `${pctText(channel!.pct)} of Ad Spend` }
        : level === 'channels'
          ? { value: format(adTotal), label: 'Ad Spend', sub: `${pctText((adTotal / revenue) * 100)} of revenue` }
          : { value: totalDisplay, label: 'Total revenue', sub: '' }

  const back = (label: string, onClick: () => void) => (
    <button
      type="button"
      onClick={onClick}
      className="inline-flex cursor-pointer items-center gap-1 rounded-[var(--r-sm)] text-sm font-semibold text-brand-violet hover:underline focus:outline-none focus-visible:ring-1 focus-visible:ring-brand-violet"
    >
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2.4} strokeLinecap="round" strokeLinejoin="round" className="h-3.5 w-3.5" aria-hidden="true">
        <path d="m15 18-6-6 6-6" />
      </svg>
      {label}
    </button>
  )

  return (
    <div ref={ref} className={`relative flex min-h-[280px] w-full flex-1 gap-6 ${stacked ? 'flex-col items-center' : 'items-center'}`}>
      <div className="relative shrink-0" style={{ width: size, height: size }}>
        <svg
          width={size}
          height={size}
          role="img"
          aria-label={level === 'drivers' ? 'Revenue by driver' : level === 'channels' ? 'Ad Spend contribution by channel' : `${channel!.label} by sub-channel`}
          className="overflow-visible"
        >
          {arcs.map((a) => {
            const clickable = !preview && opens(a.key)
            return (
              <path
                key={a.key}
                d={arcPath(c, c, !preview && isOn(a.key) ? r0 - 2 : r0, !preview && isOn(a.key) ? r1 + 6 : r1, a.a0, a.a1)}
                fill={a.color}
                stroke="var(--surface-card)"
                strokeWidth={2}
                opacity={!preview && isDim(a.key) ? 0.25 : 1}
                className={`transition-opacity duration-200 ${clickable ? 'cursor-pointer' : ''}`}
                onMouseEnter={() => (preview ? undefined : setHover(a.key))}
                onMouseLeave={() => setHover(null)}
                onClick={clickable ? () => openSeg(a.key) : undefined}
              >
                <title>{`${a.label}: ${a.display}`}</title>
              </path>
            )
          })}
        </svg>
        {/* The centre in HTML, in TPO's donut type (components/charts/DonutBreakdown). */}
        <div className="pointer-events-none absolute inset-0 grid place-items-center">
          <div className="max-w-[62%] text-center">
            <div className="text-xl font-extrabold tabular-nums text-ink-primary">{centre.value}</div>
            <div className="mt-0.5 text-sm font-semibold leading-tight text-ink-muted">{centre.label}</div>
            {centre.sub && <div className="text-sm tabular-nums text-ink-muted">{centre.sub}</div>}
          </div>
        </div>
      </div>

      <div className={`relative min-w-0 ${stacked ? 'w-full' : 'flex-1'}`}>
        {/* THE SUMMARY — fixed height, so nothing moves. */}
        <div className="mb-3 flex h-[72px] flex-col justify-center rounded-[var(--r-md)] bg-surface-muted px-4">
          {level === 'sub' ? (
            <>
              <div className="flex items-center justify-between gap-3">
                {back('Ad Spend', () => setChannel(null))}
                <span className="text-xl font-extrabold tabular-nums text-ink-primary">{channel!.display}</span>
              </div>
              <div className="mt-0.5 flex items-baseline justify-between gap-3 text-sm text-ink-muted">
                <span className="truncate">{channel!.label} · by sub-channel</span>
                <span className="shrink-0 tabular-nums">{pctText(channel!.pct)} of Ad Spend</span>
              </div>
            </>
          ) : level === 'channels' ? (
            <>
              <div className="flex items-center justify-between gap-3">
                {back('All drivers', () => onDrill(false))}
                <span className="text-xl font-extrabold tabular-nums text-ink-primary">{format(adTotal)}</span>
              </div>
              <div className="mt-0.5 flex items-baseline justify-between gap-3 text-sm text-ink-muted">
                <span className="truncate">Ad Spend · by channel</span>
                <span className="shrink-0 tabular-nums">{pctText((adTotal / revenue) * 100)} of {totalDisplay}</span>
              </div>
            </>
          ) : anySelected ? (
            <>
              <div className="flex items-baseline justify-between gap-3">
                <span className="text-xl font-extrabold tabular-nums text-ink-primary">{format(pickedValue)}</span>
                <span className="text-md font-bold tabular-nums text-brand-violet">{pctText((pickedValue / revenue) * 100)}</span>
              </div>
              <div className="mt-0.5 flex items-baseline justify-between gap-3 text-sm text-ink-muted">
                <span className="truncate">From {picked.map((sg) => sg.label).join(' + ')}</span>
                <span className="shrink-0 tabular-nums">of {totalDisplay}</span>
              </div>
            </>
          ) : (
            // Nothing selected: the decomposition's headline — what the
            // events and ads added above the baseline (the ring's centre
            // already states total revenue).
            <>
              <div className="flex items-baseline justify-between gap-3">
                <span className="text-xl font-extrabold tabular-nums text-ink-primary">{format(revenue - valueOf('baseline'))}</span>
                <span className="text-md font-bold tabular-nums text-brand-violet">{pctText(((revenue - valueOf('baseline')) / revenue) * 100)}</span>
              </div>
              <div className="mt-0.5 flex items-baseline justify-between gap-3 text-sm text-ink-muted">
                <span className="truncate">Above baseline · events and ads</span>
                <span className="shrink-0 tabular-nums">of {totalDisplay}</span>
              </div>
            </>
          )}
        </div>

        <ul className="flex flex-col">
          {segments.map((sg) => {
            const clickable = opens(sg.key)
            const Row = clickable ? 'button' : 'div'
            return (
              <li key={sg.key}>
                <Row
                  {...(clickable
                    ? { type: 'button' as const, onClick: () => openSeg(sg.key), title: level === 'drivers' ? 'Open Ad Spend by channel' : `Open ${sg.label} by sub-channel` }
                    : {})}
                  onMouseEnter={() => {
                    setHover(sg.key)
                    if (level === 'channels') setPreview(sg.key)
                  }}
                  onMouseLeave={() => {
                    setHover(null)
                    setPreview(null)
                  }}
                  className={`grid h-10 w-full items-center gap-x-2 rounded-[var(--r-md)] px-2.5 text-left transition-[background-color,opacity] duration-150 focus:outline-none focus-visible:ring-1 focus-visible:ring-brand-violet ${
                    level === 'drivers' ? 'grid-cols-[12px_minmax(0,1fr)_7rem_4.2rem] text-md' : 'grid-cols-[12px_minmax(0,1fr)_5.4rem_3.7rem] text-base'
                  } ${clickable ? 'cursor-pointer' : 'cursor-default'} ${isOn(sg.key) ? 'bg-surface-hover' : ''} ${isDim(sg.key) ? 'opacity-50' : ''}`}
                >
                  <span className="h-3 w-3 rounded-full" style={{ background: sg.color }} />
                  <span className="flex min-w-0 items-center gap-1.5">
                    <span className={`truncate ${level === 'drivers' && selected.has(sg.key as DriverKey) ? 'font-semibold text-ink-primary' : 'text-ink-secondary'}`}>
                      {sg.label}
                    </span>
                    {clickable && (
                      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2.4} strokeLinecap="round" strokeLinejoin="round" className="h-3.5 w-3.5 shrink-0 text-brand-violet" aria-hidden="true">
                        <path d="m9 18 6-6-6-6" />
                      </svg>
                    )}
                  </span>
                  <span className="text-right font-semibold tabular-nums text-ink-primary">{sg.display}</span>
                  <span className="text-right text-base tabular-nums text-ink-muted">{pctText(sg.pct)}</span>
                </Row>
              </li>
            )
          })}
        </ul>
      </div>
    </div>
  )
}

/** A categorical palette for parts of a whole — channels, sub-channels —
 *  ordered so neighbouring slices stay apart. */
export const PART_COLORS = [
  SERIES.spend,
  'var(--brand-blue)',
  'var(--tint-teal-icon)',
  'var(--tint-coral-icon)',
  'var(--tint-lemon-icon)',
  'var(--brand-violet)',
  'var(--tint-mint-icon)',
  'var(--tint-sky-icon)',
]

/** SHARE DONUT — parts of a whole as a ring with a legend, built like the
 *  Revenue Decomposition beside it: total in the centre, the hovered part
 *  named there instead, fixed legend rows, and every part's figures in a
 *  floating tooltip so nothing moves. `onPick` makes slices and rows open
 *  something (the Channel card drills into a channel). */
export function ShareDonut({
  items,
  totalDisplay,
  totalLabel,
  onPick,
  hint,
}: {
  items: Array<{
    key: string
    label: string
    value: number
    display: string
    details: Array<[string, string, string?]>
    mix?: { days: number; of: number; events: Array<{ label: string; days: number; pct: number }> }
  }>
  totalDisplay: string
  totalLabel: string
  onPick?: (key: string) => void
  hint?: string
}) {
  const { ref, width, height } = useChartSize(560, 300)
  const [hoverKey, setHover] = useState<string | null>(null)
  const [tipState, setTip] = useState<{ key: string; anchor: TipAnchor } | null>(null)
  const rowRefs = useRef(new Map<string, HTMLLIElement>())
  const legendRef = useRef<HTMLDivElement>(null)
  // A slice and its legend row open the same tooltip, beside the row.
  const point = (key: string) => {
    setHover(key)
    const li = rowRefs.current.get(key)
    if (li && legendRef.current) setTip({ key, anchor: anchorOf(li, legendRef.current) })
  }
  const leave = () => {
    setHover(null)
    setTip(null)
  }
  // Hover counts only while it points at a part on screen: a click that
  // drills in replaces the parts under a still pointer, which would
  // otherwise leave every new part faded.
  const hover = items.some((it) => it.key === hoverKey) ? hoverKey : null
  const tip = tipState && items.some((it) => it.key === tipState.key) ? tipState : null
  const total = items.reduce((t, it) => t + Math.max(it.value, 0), 0) || 1
  const parts = items.map((it, i) => ({ ...it, pct: (Math.max(it.value, 0) / total) * 100, color: PART_COLORS[i % PART_COLORS.length] }))

  const MIN = 0.06
  const raw = parts.map((p) => Math.max((p.pct / 100) * Math.PI * 2, p.value > 0 ? MIN : 0))
  const scale = (Math.PI * 2) / (raw.reduce((a, b) => a + b, 0) || 1)
  let angle = 0
  const arcs = parts.map((p, i) => {
    const a0 = angle
    angle += raw[i] * scale
    return { ...p, a0, a1: angle }
  })

  const stacked = width < 480
  const size = Math.max(180, Math.min(stacked ? width - 20 : width * 0.36, height - 10, 240))
  const c = size / 2
  const r1 = c - 8
  const r0 = r1 * 0.62
  const hovered = hover ? parts.find((p) => p.key === hover) : null
  const tipItem = tip ? parts.find((p) => p.key === tip.key) : null

  return (
    <div ref={ref} className={`relative flex min-h-[280px] w-full flex-1 gap-4 ${stacked ? 'flex-col items-center' : 'items-center'}`}>
      <div className="relative shrink-0" style={{ width: size, height: size }}>
        <svg width={size} height={size} role="img" aria-label={`${totalLabel} by part`} className="overflow-visible">
          {arcs.map((a) => (
            <path
              key={a.key}
              d={arcPath(c, c, hover === a.key ? r0 - 2 : r0, hover === a.key ? r1 + 6 : r1, a.a0, a.a1)}
              fill={a.color}
              stroke="var(--surface-card)"
              strokeWidth={2}
              opacity={hover !== null && hover !== a.key ? 0.3 : 1}
              className={`transition-opacity duration-200 ${onPick ? 'cursor-pointer' : ''}`}
              onMouseEnter={() => point(a.key)}
              onMouseLeave={leave}
              onClick={onPick ? () => onPick(a.key) : undefined}
            >
            </path>
          ))}
        </svg>
        <div className="pointer-events-none absolute inset-0 grid place-items-center">
          <div className="max-w-[60%] text-center">
            <div className="text-xl font-extrabold tabular-nums text-ink-primary">{hovered ? hovered.display : totalDisplay}</div>
            <div className="mt-0.5 text-sm font-semibold leading-tight text-ink-muted">{hovered ? hovered.label : totalLabel}</div>
            {hovered && <div className="text-sm tabular-nums text-ink-muted">{hovered.pct.toFixed(2)}%</div>}
          </div>
        </div>
      </div>

      <div ref={legendRef} className={`relative min-w-0 ${stacked ? 'w-full' : 'flex-1'}`}>
        <ul className="flex flex-col">
          {parts.map((p) => {
            const on = hover === p.key
            return (
              <li
                key={p.key}
                ref={(el) => {
                  if (el) rowRefs.current.set(p.key, el)
                  else rowRefs.current.delete(p.key)
                }}
              >
                <button
                  type="button"
                  onMouseEnter={() => point(p.key)}
                  onMouseLeave={leave}
                  onFocus={() => point(p.key)}
                  onBlur={leave}
                  onClick={onPick ? () => onPick(p.key) : undefined}
                  className={`grid h-10 w-full grid-cols-[12px_minmax(0,1fr)_5.8rem_3.6rem] items-center gap-x-2 rounded-[var(--r-md)] px-2 text-left text-base transition-[background-color,opacity] duration-150 focus:outline-none focus-visible:ring-1 focus-visible:ring-brand-violet ${
                    onPick ? 'cursor-pointer' : 'cursor-default'
                  } ${on ? 'bg-surface-hover' : ''} ${hover !== null && !on ? 'opacity-50' : ''}`}
                >
                  <span className="h-3 w-3 rounded-full" style={{ background: p.color }} />
                  <span className="truncate text-ink-secondary">{p.label}</span>
                  <span className="text-right font-semibold tabular-nums text-ink-primary">{p.display}</span>
                  <span className="text-right text-base tabular-nums text-ink-muted">{p.pct.toFixed(2)}%</span>
                </button>
              </li>
            )
          })}
        </ul>
        {tipItem && tip && (
          <FloatingTip anchor={tip.anchor} width={tipItem.mix ? 320 : 256}>
            <div className="font-bold text-ink-primary">{tipItem.label}</div>
            {tipItem.details.map(([k, v, sw]) => (
              <TipRow key={k} k={k} v={v} swatch={sw} />
            ))}
            {tipItem.mix && <EventMix title="Active days" days={tipItem.mix.days} of={tipItem.mix.of} events={tipItem.mix.events} limit={5} />}
            {hint && <div className="mt-1.5 border-t border-border-subtle pt-1.5 font-semibold text-brand-violet">{hint}</div>}
          </FloatingTip>
        )}
      </div>
    </div>
  )
}

/** Where a floating tooltip is pinned: the hovered row's top and bottom, and
 *  the right edge it lines up with — all in viewport pixels. */
interface TipAnchor {
  top: number
  bottom: number
  right: number
}

const anchorOf = (row: HTMLElement, edge: HTMLElement): TipAnchor => {
  const r = row.getBoundingClientRect()
  return { top: r.top, bottom: r.bottom, right: edge.getBoundingClientRect().right }
}

/** A tooltip on the page's top layer, so a scrolling card body cannot clip
 *  it: right-aligned to the anchor, below the row when it fits on screen,
 *  above it otherwise, and never off the screen. */
function FloatingTip({ anchor, width, children }: { anchor: TipAnchor; width: number; children: ReactNode }) {
  const ref = useRef<HTMLDivElement>(null)
  const [top, setTop] = useState<number | null>(null)
  useLayoutEffect(() => {
    const h = ref.current?.offsetHeight ?? 0
    const room = window.innerHeight - 8
    const below = anchor.bottom + 6
    const above = anchor.top - 6 - h
    setTop(below + h <= room ? below : above >= 8 ? above : Math.max(8, room - h))
  }, [anchor.top, anchor.bottom])
  const left = Math.max(8, Math.min(anchor.right - width, window.innerWidth - width - 8))
  return createPortal(
    <div
      ref={ref}
      role="tooltip"
      className="pointer-events-none fixed z-[60] rounded-[var(--r-md)] border border-border-default bg-surface-card p-2.5 text-xs shadow-[var(--shadow-lg)]"
      style={{ left, top: top ?? anchor.bottom + 6, width, visibility: top === null ? 'hidden' : 'visible' }}
    >
      {children}
    </div>,
    document.body,
  )
}

/** EVENT MIX — what else was on during a set of ad days: every combination of
 *  Festival, Seasonal and promotion type, with its days and share of those
 *  days, largest first. Past `limit` rows the rest fold into one "Other
 *  combinations" line, so the block stays a fixed, readable size; "Ad spend
 *  only" (an ad day with nothing else on) is always last. The days always add
 *  up to the header's count. Used by the trend's and the Channel card's
 *  tooltips. */
export function EventMix({
  title,
  days,
  of,
  events,
  limit = 8,
}: {
  title: string
  days: number
  /** The period's days, for "180 of 365 days". */
  of?: number
  events: Array<{ label: string; days: number; pct: number }>
  limit?: number
}) {
  const only = events.find((e) => e.label === 'Ad spend only')
  const combos = events.filter((e) => e.label !== 'Ad spend only')
  const shown = combos.length > limit + 1 ? combos.slice(0, limit) : combos
  const folded = combos.slice(shown.length)
  const foldedDays = folded.reduce((t, e) => t + e.days, 0)
  const row = (label: string, d: number, pct: number, strong = false, key = label) => (
    <div key={key} className="flex items-baseline justify-between gap-3 text-[11px] leading-[1.5]">
      <span className={`min-w-0 truncate ${strong ? 'font-semibold text-ink-primary' : 'text-ink-secondary'}`} title={label}>
        {label}
      </span>
      <span className="shrink-0 tabular-nums text-ink-primary">
        {d} <span className="text-ink-muted">{d === 1 ? 'day' : 'days'} · {pct.toFixed(2)}%</span>
      </span>
    </div>
  )
  return (
    <div className="mt-1.5 border-t border-border-subtle pt-1.5">
      <div className="mb-0.5 flex items-baseline justify-between font-bold text-ink-primary">
        <span>{title}</span>
        <span className="font-semibold text-ink-muted">{of !== undefined ? `${days} of ${of} days` : `${days} days`}</span>
      </div>
      {days === 0 && <div className="text-[11px] text-ink-muted">No ad spend in this period.</div>}
      {shown.map((e) => row(e.label, e.days, e.pct))}
      {folded.length > 0 && row(`Other combinations (${folded.length})`, foldedDays, days ? (foldedDays / days) * 100 : 0, false, '__other')}
      {only && (
        <div className="mt-0.5 border-t border-dashed border-border-subtle pt-0.5">{row(only.label, only.days, only.pct, true)}</div>
      )}
    </div>
  )
}

/** The tone a ROAS wears beside a bar: green at or above break-even, red
 *  below it, muted when there is none — as TPO's ROI wears its tone. */
export function roasTone(roas: number | null): string {
  if (roas === null) return 'var(--text-muted)'
  return roas >= BREAKEVEN_ROAS ? 'var(--status-success)' : 'var(--status-danger)'
}

export interface ShareBarRow {
  key: string
  label: string
  value: number
  display: string
  /** Muted text after the value — the share, where one adds to 100%; '' for none. */
  share: string
  /** The hover tooltip's rows: [label, value, swatch?]. */
  details?: Array<[string, string, string?]>
  /** The tooltip's event mix over the row's active days. */
  mix?: { days: number; of: number; events: Array<{ label: string; days: number; pct: number }> }
}

/** Ranked horizontal bars, one line per row — rank, name, bar, value — the
 *  bar scaled to the largest. Only the value is printed; the row's other
 *  figures are in a tooltip on hover or keyboard focus. */
export function ShareBars({
  rows,
  color = SERIES.spend,
  onPick,
  hint,
  fill = false,
}: {
  rows: ShareBarRow[]
  color?: string
  /** Makes each row a button — the Channel card drills into a channel. */
  onPick?: (key: string) => void
  /** A line at the foot of the tooltip, e.g. what clicking does. */
  hint?: string
  /** Spread a short list over the card's height, as TPO's ranked rows do,
   *  instead of stacking it at the top of a half-empty card. */
  fill?: boolean
}) {
  const [hover, setHover] = useState<{ index: number; anchor: TipAnchor } | null>(null)
  // ROAS can be negative. Scale by magnitude so a loss remains visible rather
  // than producing an invalid negative-width bar.
  const max = Math.max(...rows.map((r) => Math.abs(r.value)), 1)
  const active = hover !== null && hover.index < rows.length ? hover : null
  const activeRow = active ? rows[active.index] : null

  const enter = (index: number) => (e: React.SyntheticEvent<HTMLLIElement>) => {
    const li = e.currentTarget
    setHover({ index, anchor: anchorOf(li, li.parentElement ?? li) })
  }

  return (
    <div className={`relative ${fill ? 'flex flex-1 flex-col' : ''}`}>
      <ul className={`flex flex-col ${fill ? 'flex-1 justify-around' : ''}`}>
        {rows.map((r, i) => {
          const isActive = active?.index === i
          const pct = (Math.abs(r.value) / max) * 100
          return (
            <li
              key={r.key}
              tabIndex={r.details || onPick ? 0 : undefined}
              role={onPick ? 'button' : undefined}
              onMouseEnter={enter(i)}
              onMouseLeave={() => setHover(null)}
              onFocus={enter(i)}
              onBlur={() => setHover(null)}
              onClick={onPick ? () => onPick(r.key) : undefined}
              onKeyDown={onPick ? (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onPick(r.key) } } : undefined}
              className={`grid ${onPick ? 'cursor-pointer grid-cols-[1.25rem_minmax(0,9.5rem)_minmax(0,1fr)_auto_14px]' : 'grid-cols-[1.25rem_minmax(0,9.5rem)_minmax(0,1fr)_auto]'} items-center gap-x-3 rounded-[var(--r-sm)] px-2 py-[7px] text-sm transition-[background-color,opacity] duration-150 focus:outline-none focus-visible:ring-1 focus-visible:ring-brand-violet ${
                isActive ? 'bg-surface-hover' : ''
              } ${active && !isActive ? 'opacity-55' : ''}`}
            >
              <span className="text-right tabular-nums text-ink-muted">{i + 1}</span>
              <span className="truncate font-semibold text-ink-primary" title={r.label}>
                {r.label}
              </span>
              <span className="h-2.5 overflow-hidden rounded-full bg-surface-muted">
                <span
                  className="block h-full rounded-full transition-[width] duration-300"
                  style={{
                    // A sliver keeps a tiny value visible; a zero or missing
                    // value ("—") draws no bar at all.
                    width: `${pct > 0 ? Math.max(pct, 1.5) : 0}%`,
                    background: r.value < 0 ? 'var(--status-danger)' : color,
                  }}
                />
              </span>
              <span className="min-w-[5.5rem] text-right font-bold tabular-nums text-ink-primary">
                {r.display}
                {r.share && <span className="ml-1 text-xs font-medium text-ink-muted">{r.share}</span>}
              </span>
              {onPick && (
                <Chevron className={`h-3.5 w-3.5 transition-colors ${isActive ? 'text-brand-violet' : 'text-ink-disabled'}`} />
              )}
            </li>
          )
        })}
      </ul>
      {active && activeRow?.details && (
        <FloatingTip anchor={active.anchor} width={activeRow.mix ? 320 : 240}>
          <div className="font-bold text-ink-primary">{activeRow.label}</div>
          {activeRow.details.map(([k, v, swatch]) => (
            <TipRow key={k} k={k} v={v} swatch={swatch} />
          ))}
          {activeRow.mix && <EventMix title="Active days" days={activeRow.mix.days} of={activeRow.mix.of} events={activeRow.mix.events} limit={5} />}
          {hint && <div className="mt-1.5 border-t border-border-subtle pt-1.5 font-semibold text-brand-violet">{hint}</div>}
        </FloatingTip>
      )}
    </div>
  )
}

/** A right-pointing chevron, drawn inline so this file needs no icon import. */
function Chevron({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2.2} strokeLinecap="round" strokeLinejoin="round" className={className} aria-hidden="true">
      <path d="m9 18 6-6-6-6" />
    </svg>
  )
}
