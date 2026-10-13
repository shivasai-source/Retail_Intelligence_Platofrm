import { useState } from 'react'
import { useChartWidth } from '../charts/useChartWidth'
import { niceTicks } from './ticks'
import type { CurvePoint, CurveResponse } from '../../types/planner'

/** Profit and revenue at every average discount, the what-if lever's track.
 *
 *  The Studio's curve idiom, kept plain: one straight-segment line per panel,
 *  today's discount as a blue reference line, the lever's position as an
 *  emerald marker, the most profitable depth as a violet ring, and a dashed
 *  boundary where the data's deepest observed discount ends -- beyond it the
 *  line is a what-if, not evidence. One axis per panel, never two scales on
 *  one chart. The Monte Carlo's P10 - P90 at each depth is in the tooltip,
 *  not drawn as a band: the chart stays plain. */

const CURRENT = 'var(--brand-blue)'
const SCENARIO = '#10B981'
const LINE = 'var(--brand-violet)'

export function PlannerCurve({
  curve,
  scenario,
  format,
}: {
  curve: CurveResponse
  scenario: { discount_pct: number; profit: number | null; revenue: number | null; profitDisplay: string; revenueDisplay: string } | null
  format: (v: number) => string
}) {
  const [hover, setHover] = useState<number | null>(null)
  return (
    <div>
      <div className="grid grid-cols-2 gap-6 @max-[900px]:grid-cols-1">
        <Panel
          title="Profit"
          curve={curve}
          pick={(p) => p.profit.value}
          scenario={scenario && { x: scenario.discount_pct, y: scenario.profit, display: scenario.profitDisplay }}
          best={curve.best ? { x: curve.best.discount_pct, display: curve.best.profit.display } : null}
          format={format}
          hover={hover}
          setHover={setHover}
        />
        <Panel
          title="Revenue"
          curve={curve}
          pick={(p) => p.revenue.value}
          scenario={scenario && { x: scenario.discount_pct, y: scenario.revenue, display: scenario.revenueDisplay }}
          best={null}
          format={format}
          hover={hover}
          setHover={setHover}
        />
      </div>
      <div className="mt-3 flex flex-wrap items-center gap-x-5 gap-y-1 text-[14px] text-ink-muted">
        <span className="inline-flex items-center gap-1.5">
          <span className="inline-block h-0.5 w-4 rounded" style={{ background: LINE }} /> Each discount
        </span>
        <span className="inline-flex items-center gap-1.5">
          <span className="inline-block h-2.5 w-2.5 rounded-full" style={{ background: SCENARIO }} /> Scenario
        </span>
        <span className="inline-flex items-center gap-1.5">
          <span className="inline-block h-4 w-0 border-l-2 border-dashed" style={{ borderColor: CURRENT }} /> Current plan
        </span>
        {curve.best && (
          <span className="inline-flex items-center gap-1.5">
            <span className="inline-block h-2.5 w-2.5 rounded-full border-2" style={{ borderColor: LINE }} /> Best
          </span>
        )}
        <span className="inline-flex items-center gap-1.5">
          <span className="inline-block h-4 w-0 border-l border-dashed border-ink-muted" /> Data limit
        </span>
      </div>
    </div>
  )
}

function Panel({
  title,
  curve,
  pick,
  scenario,
  best,
  format,
  hover,
  setHover,
  height = 250,
}: {
  title: string
  curve: CurveResponse
  pick: (p: CurvePoint) => number | null
  scenario: { x: number; y: number | null; display: string } | null
  best: { x: number; display: string } | null
  format: (v: number) => string
  hover: number | null
  setHover: (i: number | null) => void
  height?: number
}) {
  const { ref, width: w } = useChartWidth(360)
  const padL = 64
  const padR = 16
  const padT = 30
  const padB = 40
  const innerW = Math.max(1, w - padL - padR)
  const innerH = Math.max(1, height - padT - padB)

  const pts = curve.points.map((p) => ({ x: p.discount_pct, v: pick(p) })).filter((p): p is { x: number; v: number } => p.v != null)
  if (!pts.length) return <div ref={ref} />
  const xMin = pts[0].x
  const xMax = pts[pts.length - 1].x
  const values = [...pts.map((p) => p.v), ...(scenario?.y != null ? [scenario.y] : [])]
  const lo = Math.min(...values)
  const hi = Math.max(...values)
  const yMin = lo - (hi - lo) * 0.15
  const yMax = hi + (hi - lo) * 0.2 + 1e-9
  const X = (x: number) => padL + ((x - xMin) / Math.max(1e-9, xMax - xMin)) * innerW
  const Y = (v: number) => padT + innerH * (1 - (v - yMin) / Math.max(1e-9, yMax - yMin))
  const path = pts.map((p, i) => `${i ? 'L' : 'M'} ${X(p.x)} ${Y(p.v)}`).join(' ')
  const ticks = niceTicks(yMin, yMax).filter((t) => t >= yMin && t <= yMax)
  const xTicks = Array.from({ length: Math.floor(xMax / 5) + 1 }, (_, i) => i * 5).filter((x) => x >= xMin && x <= xMax)
  const today = curve.current_discount_pct
  const bestPt = best ? pts.reduce((a, p) => (Math.abs(p.x - best.x) < Math.abs(a.x - best.x) ? p : a), pts[0]) : null
  const hovered = hover != null ? curve.points[hover] : null
  const mid = (xMin + xMax) / 2

  return (
    <div ref={ref} className="relative">
      <div className="mb-1 text-[14px] font-semibold text-ink-primary">{title}</div>
      <svg
        viewBox={`0 0 ${w} ${height}`}
        width="100%"
        height={height}
        role="img"
        aria-label={`${title} by average discount`}
        onMouseLeave={() => setHover(null)}
        onMouseMove={(e) => {
          const rect = e.currentTarget.getBoundingClientRect()
          const px = ((e.clientX - rect.left) / rect.width) * w
          let bi = 0
          let bd = Infinity
          curve.points.forEach((p, i) => {
            const d = Math.abs(X(p.discount_pct) - px)
            if (d < bd) {
              bd = d
              bi = i
            }
          })
          setHover(bi)
        }}
      >
        {ticks.map((t) => (
          <g key={t}>
            <line x1={padL} x2={padL + innerW} y1={Y(t)} y2={Y(t)} stroke="var(--border-subtle)" />
            <text x={padL - 8} y={Y(t) + 4} textAnchor="end" fontSize={13} fill="var(--text-muted)">
              {format(t)}
            </text>
          </g>
        ))}
        <line x1={padL} x2={padL + innerW} y1={padT + innerH} y2={padT + innerH} stroke="var(--border-default)" />
        {xTicks.map((x) => (
          <text key={x} x={X(x)} y={padT + innerH + 17} textAnchor="middle" fontSize={13} fill="var(--text-muted)">
            {x}%
          </text>
        ))}
        <text x={padL + innerW / 2} y={height - 4} textAnchor="middle" fontSize={13} fontWeight={600} fill="var(--text-secondary)">
          Average discount
        </text>

        {/* Where the data's deepest discount ends. */}
        {curve.evidence_max < xMax && (
          <g>
            <line x1={X(curve.evidence_max)} x2={X(curve.evidence_max)} y1={padT} y2={padT + innerH} stroke="var(--text-muted)" strokeDasharray="3 3" />
            <text x={X(curve.evidence_max) + 4} y={padT + 12} fontSize={13} fill="var(--text-muted)">
              data limit
            </text>
          </g>
        )}

        <path d={path} fill="none" stroke={LINE} strokeWidth={2.4} strokeLinejoin="round" strokeLinecap="round" />

        <line x1={X(today)} x2={X(today)} y1={padT - 4} y2={padT + innerH} stroke={CURRENT} strokeWidth={1.4} strokeDasharray="4 3" />
        <text x={X(today) + (today > mid ? -6 : 6)} y={padT - 10} textAnchor={today > mid ? 'end' : 'start'} fontSize={13} fontWeight={600} fill={CURRENT}>
          Current {today.toFixed(2)}%
        </text>

        {bestPt && (
          <g>
            <circle cx={X(bestPt.x)} cy={Y(bestPt.v)} r={6} fill="var(--surface-card)" stroke={LINE} strokeWidth={2.4} />
            <text
              x={X(bestPt.x)}
              y={Y(bestPt.v) - 12}
              textAnchor="middle"
              fontSize={13}
              fontWeight={600}
              fill="var(--text-secondary)"
              stroke="var(--surface-card)"
              strokeWidth={4}
              paintOrder="stroke"
            >
              Best {bestPt.x.toFixed(2)}%
            </text>
          </g>
        )}

        {hovered && <line x1={X(hovered.discount_pct)} x2={X(hovered.discount_pct)} y1={padT} y2={padT + innerH} stroke="var(--text-muted)" strokeDasharray="2 3" />}

        {scenario?.y != null && (
          <g>
            <circle cx={X(scenario.x)} cy={Y(scenario.y)} r={8} fill="var(--surface-card)" />
            <circle cx={X(scenario.x)} cy={Y(scenario.y)} r={6} fill={SCENARIO} />
          </g>
        )}
      </svg>
      {hovered && (
        <div
          className="pointer-events-none absolute top-7 z-10 rounded-[var(--r-md)] border border-border-subtle bg-surface-card px-3 py-2 text-[14px] shadow-[var(--shadow-md)] [font-variant-numeric:tabular-nums]"
          style={{ left: `${Math.min(78, Math.max(22, (X(hovered.discount_pct) / w) * 100))}%`, transform: 'translateX(-50%)' }}
        >
          <div className="font-semibold text-ink-primary">{hovered.discount_pct.toFixed(2)}% average discount</div>
          <div className="mt-0.5 text-ink-secondary">
            Profit <span className="font-semibold text-ink-primary">{hovered.profit.display}</span>
          </div>
          <div className="text-ink-secondary">
            Revenue <span className="font-semibold text-ink-primary">{hovered.revenue.display}</span>
          </div>
          <div className="text-ink-secondary">
            ROI <span className="font-semibold text-ink-primary">{hovered.roi.display}</span>
          </div>
          {hovered.profit_range && (
            <div className="mt-1 border-t border-border-subtle pt-1 text-ink-secondary">
              <div>
                Profit P10 – P90 <span className="text-ink-primary">{hovered.profit_range.display}</span>
              </div>
              <div>
                Revenue P10 – P90 <span className="text-ink-primary">{hovered.revenue_range.display}</span>
              </div>
            </div>
          )}
          {hovered.beyond_evidence && <div className="mt-0.5 text-status-warning">Beyond the data</div>}
        </div>
      )}
    </div>
  )
}
