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
  overlay,
}: {
  items: Array<{ key: string; label: string; value: number | null; display: string; details: Array<[string, string, string?]> }>
  color: string
  /** Axis tick text for a raw value. */
  format: (v: number) => string
  ariaLabel: string
  /** A second measure as a dot on each column, on its own right-hand axis —
   *  the ROAS over the revenue or spend columns. One value per item. */
  overlay?: { color: string; values: Array<number | null>; format: (v: number) => string }
}) {
  const { ref, width, height } = useChartSize(520, 300)
  const [hover, setHover] = useState<number | null>(null)
  const n = items.length
  const padL = 60
  const padR = overlay ? 46 : 8
  const padT = 22
  const padB = 28
  const innerW = Math.max(120, width - padL - padR)
  const innerH = Math.max(80, height - padT - padB)
  const values = items.map((c) => c.value).filter((v): v is number => v !== null)
  const { lo, hi, ticks } = axis(values.length ? values : [1])
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

  // The overlay's axis has as many steps as the left one, so its labels sit
  // on the same gridlines; it starts at 0 (or below, for a negative value).
  const oValues = overlay ? overlay.values.filter((v): v is number => v !== null) : []
  const oDiv = Math.max(1, ticks.length - 1)
  const oLoRaw = Math.min(0, ...oValues)
  const oStep = niceStep((Math.max(BREAKEVEN_ROAS, ...oValues) - oLoRaw) / oDiv || 1)
  const oLo = oLoRaw < 0 ? Math.floor(oLoRaw / oStep) * oStep : 0
  const oHi = oLo + oStep * oDiv
  const yO = (v: number) => padT + innerH * (1 - (v - oLo) / (oHi - oLo || 1))

  return (
    <div ref={ref} className="relative min-h-[260px] w-full flex-1">
      <svg className="absolute inset-0" width={width} height={height} role="img" aria-label={ariaLabel}>
        {ticks.map((t, k) => (
          <g key={t}>
            <line x1={padL} x2={padL + innerW} y1={y(t)} y2={y(t)} stroke={t === lo ? 'var(--border-default)' : 'var(--border-subtle)'} />
            <text x={padL - 7} y={y(t) + 3} textAnchor="end" fontSize={10} fill="var(--text-muted)">
              {format(t)}
            </text>
            {overlay && (
              <text x={padL + innerW + 7} y={y(t) + 3} textAnchor="start" fontSize={10} fill="var(--text-muted)">
                {overlay.format(oLo + oStep * k)}
              </text>
            )}
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
                y={height - 9}
                textAnchor="middle"
                fontSize={10.5}
                fontWeight={isActive ? 700 : 600}
                fill={isActive ? 'var(--text-primary)' : 'var(--text-secondary)'}
              >
                {fit(c.label)}
              </text>
              {overlay && overlay.values[i] !== null && overlay.values[i] !== undefined && (
                <circle
                  cx={cx(i)}
                  cy={yO(overlay.values[i] as number)}
                  r={isActive ? 6 : 5}
                  fill={overlay.color}
                  stroke="var(--surface-card)"
                  strokeWidth={2}
                  opacity={active === null || isActive ? 1 : 0.5}
                  className="transition-[r,opacity] duration-150"
                />
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
  const { lo, hi, ticks } = axis(values.length ? values : [1])
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
                <text x={cx(i)} y={v < 0 ? y(v) + 13 : y(v) - 6} textAnchor="middle" fontSize={10} fontWeight={700} fill="var(--text-primary)">
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
  const PREV = 'color-mix(in srgb, var(--brand-violet) 55%, transparent)'

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

/** The tone a ROAS wears beside a bar: green at or above break-even, red
 *  below it, muted when there is none — as TPO's ROI wears its tone. */
export function roasTone(roas: number | null): string {
  if (roas === null) return 'var(--text-muted)'
  return roas >= BREAKEVEN_ROAS ? 'var(--status-success)' : 'var(--status-danger)'
}

export interface ShareBarRow {
  key: string
  label: string
  sub?: string
  value: number
  display: string
  share: string
  /** A second figure after the value — the ROAS, in its tone — as TPO's
   *  ranked rows print the ROI beside the ranked metric. */
  aside?: { text: string; color: string }
  /** The hover tooltip's rows: [label, value, swatch?]. */
  details?: Array<[string, string, string?]>
}

/** Horizontal share bars — one row per item, ranked, the bar scaled to the
 *  largest, with a tooltip of the row's every figure on hover or focus. */
export function ShareBars({
  rows,
  color = SERIES.spend,
  ranked = true,
  inline = false,
}: {
  rows: ShareBarRow[]
  color?: string
  ranked?: boolean
  /** One line per row — rank, name, bar, value — and only the value: the
   *  row's other figures live in the hover tooltip. */
  inline?: boolean
}) {
  const [hover, setHover] = useState<{ index: number; top: number; above: boolean } | null>(null)
  // ROAS can be negative. Scale by magnitude so a loss remains visible rather
  // than producing an invalid negative-width bar.
  const max = Math.max(...rows.map((r) => Math.abs(r.value)), 1)
  const active = hover !== null && hover.index < rows.length ? hover : null
  const activeRow = active ? rows[active.index] : null

  const enter = (index: number) => (e: React.SyntheticEvent<HTMLLIElement>) => {
    const li = e.currentTarget
    const list = li.parentElement
    // Below the row in the top half of the list, above it in the bottom
    // half, so the tooltip stays inside the card and never covers the row.
    const above = list ? li.offsetTop > list.clientHeight / 2 : false
    setHover({ index, top: above ? li.offsetTop - 6 : li.offsetTop + li.offsetHeight + 6, above })
  }

  const tooltip = active && activeRow?.details && (
    <div
      role="tooltip"
      className="pointer-events-none absolute right-0 z-20 w-60 rounded-[var(--r-md)] border border-border-default bg-surface-card p-2.5 text-xs shadow-[var(--shadow-lg)]"
      style={active.above ? { top: active.top, transform: 'translateY(-100%)' } : { top: active.top }}
    >
      <div className="font-bold text-ink-primary">{activeRow.label}</div>
      {activeRow.sub && <div className="text-ink-muted">{activeRow.sub}</div>}
      {activeRow.details.map(([k, v, swatch]) => (
        <TipRow key={k} k={k} v={v} swatch={swatch} />
      ))}
    </div>
  )

  if (inline) {
    return (
      <div className="relative">
        <ul className="flex flex-col">
          {rows.map((r, i) => {
            const isActive = active?.index === i
            const pct = (Math.abs(r.value) / max) * 100
            return (
              <li
                key={r.key}
                tabIndex={r.details ? 0 : undefined}
                onMouseEnter={enter(i)}
                onMouseLeave={() => setHover(null)}
                onFocus={enter(i)}
                onBlur={() => setHover(null)}
                className={`grid grid-cols-[1.25rem_minmax(0,9.5rem)_minmax(0,1fr)_auto] items-center gap-x-3 rounded-[var(--r-sm)] px-2 py-[7px] text-sm transition-[background-color,opacity] duration-150 focus:outline-none focus-visible:ring-1 focus-visible:ring-brand-violet ${
                  isActive ? 'bg-surface-hover' : ''
                } ${active && !isActive ? 'opacity-55' : ''}`}
              >
                <span className="text-right tabular-nums text-ink-muted">{ranked ? i + 1 : ''}</span>
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
              </li>
            )
          })}
        </ul>
        {tooltip}
      </div>
    )
  }

  return (
    <div className="relative">
      <ul className="flex flex-col gap-1">
        {rows.map((r, i) => {
          const isActive = active?.index === i
          return (
            <li
              key={r.key}
              tabIndex={r.details ? 0 : undefined}
              onMouseEnter={enter(i)}
              onMouseLeave={() => setHover(null)}
              onFocus={enter(i)}
              onBlur={() => setHover(null)}
              className={`rounded-[var(--r-sm)] px-1.5 py-1 transition-[background-color,opacity] duration-150 focus:outline-none focus-visible:ring-1 focus-visible:ring-brand-violet ${
                isActive ? 'bg-surface-hover' : ''
              } ${active && !isActive ? 'opacity-60' : ''}`}
            >
              <div className="mb-1 flex items-baseline justify-between gap-3 text-sm">
                <span className="flex min-w-0 items-baseline gap-1.5">
                  {ranked && <span className="tabular-nums text-ink-muted">{i + 1}</span>}
                  <span className="truncate font-semibold text-ink-primary">
                    {r.label}
                    {r.sub && <span className="ml-1.5 font-normal text-ink-muted">{r.sub}</span>}
                  </span>
                </span>
                <span className="shrink-0 tabular-nums text-ink-secondary">
                  <span className="font-bold text-ink-primary">{r.display}</span>
                  {r.aside && (
                    <>
                      {' · '}
                      <span className="font-semibold" style={{ color: r.aside.color }}>
                        {r.aside.text}
                      </span>
                    </>
                  )}
                  <span className="text-ink-muted"> · {r.share}</span>
                </span>
              </div>
              <div className="h-2 overflow-hidden rounded-full bg-surface-muted">
                <div
                  className="h-full rounded-full transition-[width] duration-300"
                  style={{ width: `${(Math.abs(r.value) / max) * 100}%`, background: r.value < 0 ? 'var(--status-danger)' : color }}
                />
              </div>
            </li>
          )
        })}
      </ul>
      {tooltip}
    </div>
  )
}
