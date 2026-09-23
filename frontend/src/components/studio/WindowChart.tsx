import { useState } from 'react'
import { useChartWidth } from '../charts/useChartWidth'
import type { Money, WeekPoint } from '../../types/studio'
import { niceTicks } from './ticks'

/** Revenue, week by week across the window: no promotion, the current plan
 *  and the scenario side by side. Grouped bars rather than lines because a
 *  window is one to five weeks — a line through two points says nothing a
 *  pair of bars does not, and a one-week window has nothing to draw a line
 *  between.
 *
 *  THE SCENARIO CARRIES ITS BAND. `scenario_revenue_low/high` is the fitted
 *  model's residual band, and drawing it is the point of the chart: the
 *  scenario bar alone claims a precision the model never had. When the
 *  scenario and the current plan differ by less than the band — which they
 *  usually do at small lever moves — the reader can SEE that the difference
 *  is inside the noise instead of reading a confident 0.39% in the subtitle
 *  and believing it. The band is the scenario's alone; the current plan and
 *  the baseline are the same engine at the band's midpoint.
 *
 *  BUILT TO BE READ WITHOUT A HOVER. Every figure on the plot is the
 *  payload's own display string. A 24px bar is narrower than the money
 *  string that belongs to it, so only the scenario — the subject of the
 *  page — is labelled against its mark; the three values live in a strip
 *  under each group's week label, which keeps the numbers on the page,
 *  keeps them off each other, and gives a one-week window something to
 *  fill the space it would otherwise leave blank.
 *
 *  Three series, fixed colours — the same three the project's forecast chart
 *  uses (grey baseline, brand blue current plan, emerald scenario), assigned
 *  to the entity, never to a rank: the scenario stays green whether it beat
 *  the current plan or not. Grey on "No promotion" is deliberate: it is the
 *  reference the other two are read against, not a third identity competing
 *  for attention. Identity is never colour alone — the legend names each
 *  series and the bars are directly labelled.
 */

export const SERIES = [
  { key: 'baseline_revenue', label: 'No promotion', color: '#94A3B8' },
  { key: 'current_revenue', label: 'Current plan', color: 'var(--brand-blue)' },
  { key: 'scenario_revenue', label: 'Scenario', color: '#10B981' },
] as const

const SCENARIO = SERIES[2]

/** Marks stay thin: a bar caps at 24px however much room the slot has, and
 *  the leftover is air rather than a wider block. A one- or two-week window
 *  is three or six bars in a card the width of the page, though, and 24px
 *  marks in that much space read as a mistake rather than as restraint -- so
 *  the cap eases for the short windows only. */
const BAR_MAX = 24
const BAR_MAX_SHORT = 34
const BAR_GAP = 2
const GROUP_MAX = 300
const PAD_L = 64
const PAD_R = 12

/** A bar with a 4px rounded top and square feet on the baseline. */
function barPath(x: number, top: number, w: number, h: number): string {
  const r = Math.min(4, w / 2, h)
  const bottom = top + h
  if (h <= 0) return ''
  return `M${x},${bottom} L${x},${top + r} Q${x},${top} ${x + r},${top} L${x + w - r},${top} Q${x + w},${top} ${x + w},${top + r} L${x + w},${bottom} Z`
}

export function WindowChart({
  weeks,
  format,
  height = 300,
}: {
  weeks: WeekPoint[]
  /** A base-currency value as an axis tick, in the display currency. */
  format: (value: number) => string
  height?: number
}) {
  const { ref, width: available } = useChartWidth(720)
  // A chart is a figure, not a canvas. Left to fill the card, a one-week
  // window drew a 1250px-wide plot around a 180px cluster of bars, with
  // gridlines running off into nothing on both sides. The plot is capped to
  // what its data needs and centred; a long window still spans the card.
  const w = Math.min(available, PAD_L + PAD_R + weeks.length * GROUP_MAX + 150)
  const [hover, setHover] = useState<number | null>(null)
  const padL = PAD_L
  const padR = PAD_R
  const padT = 34
  const innerW = Math.max(1, w - padL - padR)

  // The scale has to clear the band's top, not just the bars', or the high
  // cap of a wide band would be drawn off the plot.
  const values = weeks.flatMap((p) => [
    p.baseline_revenue.value ?? 0,
    p.current_revenue.value ?? 0,
    p.scenario_revenue.value ?? 0,
    p.scenario_revenue_high.value ?? 0,
  ])
  const top = Math.max(1, ...values)
  const maxV = top * 1.2
  const y = (v: number) => padT + innerH * (1 - v / maxV)

  // Slots are capped and the cluster is centred, so a one-week window is a
  // properly proportioned figure rather than three blocks stretched across
  // the card.
  const groupW = Math.min(innerW / Math.max(1, weeks.length), GROUP_MAX)
  const clusterX = padL + (innerW - groupW * weeks.length) / 2
  const barCap = weeks.length <= 2 ? BAR_MAX_SHORT : BAR_MAX
  const barW = Math.max(8, Math.min(barCap, (groupW * 0.5 - BAR_GAP * 2) / 3))
  const groupInner = barW * 3 + BAR_GAP * 2
  const plateW = Math.max(Math.min(groupW - 10, GROUP_MAX - 10), groupInner + 40)
  // The strip's two columns are centred inside the plate rather than pinned
  // to its edges, so a wide plate does not strand a swatch opposite its own
  // number.
  const stripW = Math.min(plateW - 24, 196)
  const gridLines = niceTicks(0, top).filter((v) => v > 0)

  // THE VALUE STRIP. A 24px bar is narrower than the money string that
  // belongs to it, so a label per bar collides with its neighbours. The
  // values go under the axis instead, one line per series against its own
  // swatch — the numbers stay on the page, the plot stays readable, and the
  // space a short window leaves empty gets used.
  const strip = stripW >= 108
  // The series name rides along whenever the strip is wide enough to hold
  // it, so the swatch sits beside a word rather than marooned opposite a
  // right-aligned number.
  const stripNames = strip && stripW >= 144
  const padB = 46 + (strip ? 56 : 0)
  // `height` sizes the PLOT, not the SVG: the strip is extra chrome under
  // the axis and grows the figure rather than squashing the bars. A fixed
  // box that has to swallow its own axis band is how charts end up with a
  // tiny nested scrollbar.
  const innerH = Math.max(1, height - padT - 46)
  const svgH = padT + innerH + padB

  return (
    <div ref={ref} className="relative">
      <div className="mx-auto" style={{ maxWidth: w }}>
      <svg viewBox={`0 0 ${w} ${svgH}`} width="100%" height={svgH} role="img" aria-label="Revenue by week">
        {gridLines.map((v) => (
          <g key={v}>
            <line x1={padL} y1={y(v)} x2={padL + innerW} y2={y(v)} stroke="var(--border-subtle)" />
            <text x={padL - 10} y={y(v) + 3.5} textAnchor="end" fontSize={12} fill="var(--text-muted)" style={{ fontVariantNumeric: 'tabular-nums' }}>
              {format(v)}
            </text>
          </g>
        ))}
        <line x1={padL} y1={y(0)} x2={padL + innerW} y2={y(0)} stroke="var(--border-default)" />

        {weeks.map((p, i) => {
          const groupX = clusterX + i * groupW
          const centre = groupX + groupW / 2
          const x0 = centre - groupInner / 2
          const hovered = hover === i
          const lo = p.scenario_revenue_low.value ?? 0
          const hi = p.scenario_revenue_high.value ?? 0
          const scenarioX = x0 + 2 * (barW + BAR_GAP)
          const baseV = p.baseline_revenue.value ?? 0
          const scenV = p.scenario_revenue.value ?? 0
          // The bracket only earns its ink where the gap is tall enough to
          // read and there is room beside the plate to write in.
          const upliftRoom = (plateW - groupInner) / 2 >= 86
          const uplift = upliftRoom && y(baseV) - y(scenV) >= 22 ? (p.incremental_vs_baseline.value ?? 0) : 0
          return (
            <g
              key={p.week}
              tabIndex={0}
              role="group"
              aria-label={`${p.label}: ${SERIES.map((s) => `${s.label} ${p[s.key].display}`).join(', ')}`}
              onMouseEnter={() => setHover(i)}
              onMouseLeave={() => setHover(null)}
              onFocus={() => setHover(i)}
              onBlur={() => setHover(null)}
              className="outline-none"
            >
              {/* The group's own plate: the hover target, and the thing that
                  makes a sparse cluster read as a deliberate figure. */}
              <rect
                x={centre - plateW / 2}
                y={padT - 22}
                width={plateW}
                height={innerH + 22 + (strip ? padB - 12 : 0)}
                rx={10}
                fill={hovered ? 'var(--surface-hover)' : 'var(--surface-muted)'}
                opacity={hovered ? 1 : 0.55}
                style={{ transition: 'opacity 120ms, fill 120ms' }}
              />

              {SERIES.map((s, j) => {
                const v = p[s.key].value ?? 0
                const x = x0 + j * (barW + BAR_GAP)
                const barTop = y(v)
                const h = Math.max(0, y(0) - barTop)
                const isScenario = s.key === SCENARIO.key
                return (
                  <g key={s.key}>
                    <path
                      d={barPath(x, barTop, barW, h)}
                      fill={s.color}
                      opacity={hover === null || hovered ? 1 : 0.45}
                      style={{ transition: 'opacity 120ms' }}
                    />
                    {isScenario && (
                      <text
                        x={x + barW / 2}
                        y={Math.min(barTop, y(hi)) - 10}
                        textAnchor="middle"
                        fontSize={12.5}
                        fontWeight={700}
                        fill="var(--text-primary)"
                        opacity={hover === null || hovered ? 1 : 0.5}
                        style={{ fontVariantNumeric: 'tabular-nums', transition: 'opacity 120ms' }}
                      >
                        {p[s.key].display}
                      </text>
                    )}
                  </g>
                )
              })}

              {/* THE MODEL'S BAND on the scenario, low to high. Drawn over the
                  bar it belongs to, ringed in the surface colour so it stays
                  legible against the fill. */}
              {hi > lo && (
                <g opacity={hover === null || hovered ? 1 : 0.45} style={{ transition: 'opacity 120ms' }}>
                  <rect x={scenarioX} y={y(hi)} width={barW} height={Math.max(1, y(lo) - y(hi))} fill={SCENARIO.color} opacity={0.22} />
                  {[hi, lo].map((v) => (
                    <line
                      key={v}
                      x1={scenarioX - 3}
                      x2={scenarioX + barW + 3}
                      y1={y(v)}
                      y2={y(v)}
                      stroke="var(--surface-card)"
                      strokeWidth={3.5}
                      strokeLinecap="round"
                    />
                  ))}
                  {[hi, lo].map((v) => (
                    <line
                      key={`c${v}`}
                      x1={scenarioX - 3}
                      x2={scenarioX + barW + 3}
                      y1={y(v)}
                      y2={y(v)}
                      stroke={SCENARIO.color}
                      strokeWidth={1.6}
                      strokeLinecap="round"
                    />
                  ))}
                  <line x1={scenarioX + barW / 2} x2={scenarioX + barW / 2} y1={y(hi)} y2={y(lo)} stroke={SCENARIO.color} strokeWidth={1.6} />
                </g>
              )}

              {/* WHAT THE PROMOTION ADDS. The gap between the no-promotion
                  bar and the scenario is the reason the window is being
                  simulated at all, and a grouped bar chart leaves a reader to
                  eyeball it. The bracket measures it and the payload names
                  it. */}
              {uplift > 0 && (
                <g opacity={hover === null || hovered ? 1 : 0.45} style={{ transition: 'opacity 120ms' }}>
                  <path
                    d={`M${x0 - 7},${y(baseV)} L${x0 - 13},${y(baseV)} L${x0 - 13},${y(scenV)} L${x0 - 7},${y(scenV)}`}
                    fill="none"
                    stroke="var(--border-default)"
                    strokeWidth={1.2}
                  />
                  <text
                    x={x0 - 17}
                    y={(y(baseV) + y(scenV)) / 2 + 4}
                    textAnchor="end"
                    fontSize={11.5}
                    fontWeight={600}
                    fill="var(--text-muted)"
                    style={{ fontVariantNumeric: 'tabular-nums' }}
                  >
                    {`+${p.incremental_vs_baseline.display}`}
                  </text>
                </g>
              )}

              <text x={centre} y={padT + innerH + 22} textAnchor="middle" fontSize={13} fontWeight={600} fill="var(--text-secondary)">
                {p.label}
                <tspan fill="var(--text-muted)" fontWeight={400}>{`  ·  ${p.days} days`}</tspan>
              </text>

              {strip &&
                SERIES.map((s, j) => {
                  const rowY = padT + innerH + 44 + j * 16
                  const left = centre - stripW / 2
                  const right = centre + stripW / 2
                  return (
                    <g key={`v${s.key}`} opacity={hover === null || hovered ? 1 : 0.55} style={{ transition: 'opacity 120ms' }}>
                      <rect
                        x={stripNames ? left : right - 66}
                        y={rowY - 7}
                        width={7}
                        height={7}
                        rx={1.5}
                        fill={s.color}
                      />
                      {stripNames && (
                        <text x={left + 13} y={rowY} fontSize={11.5} fill="var(--text-muted)">
                          {s.label}
                        </text>
                      )}
                      <text
                        x={right}
                        y={rowY}
                        textAnchor="end"
                        fontSize={11.5}
                        fontWeight={s.key === SCENARIO.key ? 700 : 500}
                        fill={s.key === SCENARIO.key ? 'var(--text-primary)' : 'var(--text-secondary)'}
                        style={{ fontVariantNumeric: 'tabular-nums' }}
                      >
                        {p[s.key].display}
                      </text>
                    </g>
                  )
                })}
            </g>
          )
        })}
      </svg>

      {hover !== null && weeks[hover] && (
          <HoverCard
            point={weeks[hover]}
            centre={clusterX + (hover + 0.5) * groupW}
            plateW={plateW}
            width={w}
          />
        )}
      </div>
    </div>
  )
}

const CARD_W = 248

/** What the hovered week holds, including the figures the plot has no room
 *  for: the scenario's band, its trade spend, and both ROIs.
 *
 *  It sits BESIDE the group it describes, never over it. A card centred on
 *  the mark covers the bars the reader is pointing at — which is most of the
 *  plot when the window is one week and the cluster is centred. It takes the
 *  free side, and only falls back to sitting above when neither side fits. */
function HoverCard({ point, centre, plateW, width }: { point: WeekPoint; centre: number; plateW: number; width: number }) {
  const right = centre + plateW / 2 + 12
  const left = centre - plateW / 2 - 12 - CARD_W
  const x = right + CARD_W <= width ? right : left >= 0 ? left : Math.max(8, Math.min(width - CARD_W - 8, centre - CARD_W / 2))
  const rows: [string, string, string][] = [
    ...SERIES.map((s) => [s.color, s.label, (point[s.key] as Money).display] as [string, string, string]),
  ]
  return (
    <div
      className="pointer-events-none absolute top-6 z-10 rounded-[var(--r-md)] border border-border-subtle bg-surface-card px-3 py-2 text-sm shadow-[var(--shadow-md)]"
      style={{ left: x, width: CARD_W }}
    >
      <div className="font-bold text-ink-primary">
        {point.label} · {point.days} days
      </div>
      {rows.map(([color, label, value]) => (
        <div key={label} className="mt-1 flex items-center gap-2 [font-variant-numeric:tabular-nums]">
          <span className="inline-block h-2.5 w-2.5 rounded-sm" style={{ background: color }} />
          <span className="text-ink-muted">{label}</span>
          <span className="ml-auto font-semibold text-ink-primary">{value}</span>
        </div>
      ))}
      <div className="mt-1 flex items-center gap-2 [font-variant-numeric:tabular-nums]">
        <span className="ml-[1.125rem] text-ink-muted">Scenario vs no promotion</span>
        <span className="ml-auto font-semibold text-ink-primary">+{point.incremental_vs_baseline.display}</span>
      </div>
      <div className="mt-1 flex items-center gap-2 [font-variant-numeric:tabular-nums]">
        <span className="ml-[1.125rem] text-ink-muted">Scenario range</span>
        <span className="ml-auto font-semibold text-ink-primary">
          {point.scenario_revenue_low.display} – {point.scenario_revenue_high.display}
        </span>
      </div>
      <div className="mt-1.5 space-y-1 border-t border-border-subtle pt-1.5 [font-variant-numeric:tabular-nums]">
        <div className="flex items-center gap-2">
          <span className="text-ink-muted">ROI · current → scenario</span>
          <span className="ml-auto font-semibold text-ink-primary">
            {point.current_roi.display} → {point.scenario_roi.display}
          </span>
        </div>
        <div className="flex items-center gap-2">
          <span className="text-ink-muted">Scenario trade spend</span>
          <span className="ml-auto font-semibold text-ink-primary">{point.scenario_trade_spend.display}</span>
        </div>
      </div>
    </div>
  )
}

/** The legend the two studio charts share, rendered by the card header so it
 *  sits on the title line rather than under the plot. The band gets an entry
 *  of its own: it is a fourth thing on the plot, and a mark nobody named
 *  would just be a smudge on the scenario bar. */
export function SeriesLegend() {
  return (
    <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-sm font-medium text-ink-secondary">
      {SERIES.map((s) => (
        <span key={s.key} className="inline-flex items-center gap-1.5">
          <span className="inline-block h-2.5 w-2.5 rounded-sm" style={{ background: s.color }} />
          {s.label}
        </span>
      ))}
      <span className="inline-flex items-center gap-1.5">
        <span
          className="inline-block h-3 w-3 rounded-sm border-y-2"
          style={{ background: `color-mix(in srgb, ${SCENARIO.color} 22%, transparent)`, borderColor: SCENARIO.color }}
        />
        Model range
      </span>
    </div>
  )
}
