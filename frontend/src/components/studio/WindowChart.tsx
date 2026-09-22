import { useState } from 'react'
import { useChartWidth } from '../charts/useChartWidth'
import type { WeekPoint } from '../../types/studio'
import { niceTicks } from './ticks'

/** Revenue, week by week across the window: no promotion, the current plan
 *  and the scenario side by side. Grouped bars rather than lines because a
 *  window is one to five weeks — a line through two points says nothing a
 *  pair of bars does not, and a one-week window has nothing to draw a line
 *  between.
 *
 *  BUILT TO BE READ ACROSS A TABLE. Every bar carries its own value in the
 *  payload's display string, so the chart answers "how much" without a
 *  hover. Three series, fixed colours —
 *  the same three the project's forecast chart uses (grey baseline, brand
 *  blue current plan, emerald scenario), assigned to the entity, never to a
 *  rank: the scenario stays green whether it beat the current plan or not.
 *  Identity is never colour alone: the legend names each series. */

export const SERIES = [
  { key: 'baseline_revenue', label: 'No promotion', color: '#94A3B8' },
  { key: 'current_revenue', label: 'Current plan', color: 'var(--brand-blue)' },
  { key: 'scenario_revenue', label: 'Scenario', color: '#10B981' },
] as const

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
  const { ref, width: w } = useChartWidth(720)
  const [hover, setHover] = useState<number | null>(null)
  const padL = 64
  const padR = 12
  const padT = 34
  const padB = 40
  const innerW = Math.max(1, w - padL - padR)
  const innerH = Math.max(1, height - padT - padB)

  const values = weeks.flatMap((p) => [
    p.baseline_revenue.value ?? 0,
    p.current_revenue.value ?? 0,
    p.scenario_revenue.value ?? 0,
  ])
  const top = Math.max(1, ...values)
  const maxV = top * 1.18
  const y = (v: number) => padT + innerH * (1 - v / maxV)

  const groupW = innerW / Math.max(1, weeks.length)
  const barGap = 6
  const groupPad = Math.min(36, groupW * 0.16)
  const barW = Math.max(10, Math.min(72, (groupW - groupPad * 2 - barGap * 2) / 3))
  const groupInner = barW * 3 + barGap * 2
  const gridLines = niceTicks(0, top).filter((v) => v > 0)

  return (
    <div ref={ref} className="relative">
      <svg viewBox={`0 0 ${w} ${height}`} width="100%" height={height} role="img" aria-label="Revenue by week">
        {gridLines.map((v) => (
          <g key={v}>
            <line x1={padL} y1={y(v)} x2={padL + innerW} y2={y(v)} stroke="var(--border-subtle)" />
            <text x={padL - 10} y={y(v) + 3.5} textAnchor="end" fontSize={12} fill="var(--text-muted)">
              {format(v)}
            </text>
          </g>
        ))}
        <line x1={padL} y1={y(0)} x2={padL + innerW} y2={y(0)} stroke="var(--border-default)" />
        {weeks.map((p, i) => {
          const groupX = padL + i * groupW
          const x0 = groupX + (groupW - groupInner) / 2
          const hovered = hover === i
          return (
            <g key={p.week} onMouseEnter={() => setHover(i)} onMouseLeave={() => setHover(null)}>
              <rect x={groupX} y={padT - 20} width={groupW} height={innerH + 20} fill="transparent" />
              {SERIES.map((s, j) => {
                const v = p[s.key].value ?? 0
                const x = x0 + j * (barW + barGap)
                const barTop = y(v)
                const h = Math.max(0, y(0) - barTop)
                const labelTop = barTop
                return (
                  <g key={s.key}>
                    <rect
                      x={x}
                      y={barTop}
                      width={barW}
                      height={h}
                      rx={5}
                      fill={s.color}
                      opacity={hover === null || hovered ? 1 : 0.4}
                      style={{ transition: 'opacity 120ms, height 240ms, y 240ms' }}
                    />
                    {/* The bar's own value, in the payload's words. */}
                    <text
                      x={x + barW / 2}
                      y={labelTop - 8}
                      textAnchor="middle"
                      fontSize={12}
                      fontWeight={700}
                      fill="var(--text-primary)"
                      style={{ fontVariantNumeric: 'tabular-nums' }}
                    >
                      {p[s.key].display}
                    </text>
                  </g>
                )
              })}
              <text x={groupX + groupW / 2} y={padT + innerH + 18} textAnchor="middle" fontSize={13} fontWeight={600} fill="var(--text-secondary)">
                {p.label}
              </text>
              <text x={groupX + groupW / 2} y={padT + innerH + 33} textAnchor="middle" fontSize={12} fill="var(--text-muted)">
                {p.days} days
              </text>
            </g>
          )
        })}
      </svg>

      {hover !== null && weeks[hover] && (
        <div
          className="pointer-events-none absolute top-1 z-10 rounded-[var(--r-md)] border border-border-subtle bg-surface-card px-3 py-2 text-sm shadow-[var(--shadow-md)]"
          style={{ left: `${Math.min(88, Math.max(12, ((hover + 0.5) / weeks.length) * 100))}%`, transform: 'translateX(-50%)' }}
        >
          <div className="font-bold text-ink-primary">
            {weeks[hover].label} · {weeks[hover].days} days
          </div>
          {SERIES.map((s) => (
            <div key={s.key} className="mt-1 flex items-center gap-2 [font-variant-numeric:tabular-nums]">
              <span className="inline-block h-2.5 w-2.5 rounded-sm" style={{ background: s.color }} />
              <span className="text-ink-muted">{s.label}</span>
              <span className="ml-auto font-semibold text-ink-primary">{weeks[hover][s.key].display}</span>
            </div>
          ))}
          <div className="mt-1 flex items-center gap-2 border-t border-border-subtle pt-1 [font-variant-numeric:tabular-nums]">
            <span className="text-ink-muted">ROI · current → scenario</span>
            <span className="ml-auto font-semibold text-ink-primary">
              {weeks[hover].current_roi.display} → {weeks[hover].scenario_roi.display}
            </span>
          </div>
        </div>
      )}
    </div>
  )
}

/** The legend the two studio charts share, rendered by the card header so it
 *  sits on the title line rather than under the plot. */
export function SeriesLegend() {
  return (
    <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-sm font-medium text-ink-secondary">
      {SERIES.map((s) => (
        <span key={s.key} className="inline-flex items-center gap-1.5">
          <span className="inline-block h-2.5 w-2.5 rounded-sm" style={{ background: s.color }} />
          {s.label}
        </span>
      ))}
    </div>
  )
}
