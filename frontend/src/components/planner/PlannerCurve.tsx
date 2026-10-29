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
const SCENARIO = 'var(--status-success)'
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
  //: WHICH POINT, AND IN WHICH PANEL. The point is shared so both charts mark
  //: the same discount -- reading profit and revenue at one depth is the whole
  //: job -- but the readout belongs to the chart the pointer is actually in.
  //: Shared, both panels opened a full tooltip at once: two identical boxes,
  //: each covering the curve it was describing.
  const [hover, setHover] = useState<{ i: number; panel: string } | null>(null)
  const at = (title: string) => ({
    hover: hover?.i ?? null,
    showTip: hover?.panel === title,
    setHover: (i: number | null) => setHover(i == null ? null : { i, panel: title }),
  })
  return (
    <div>
      <div className="grid grid-cols-2 gap-6 @max-[900px]:grid-cols-1">
        <Panel
          title="Profit"
          curve={curve}
          pick={(p) => p.profit.value}
          detail={(p) => ({ value: p.profit.display, range: p.profit_range?.display ?? null, roi: p.roi.display })}
          scenario={scenario && { x: scenario.discount_pct, y: scenario.profit, display: scenario.profitDisplay }}
          best={curve.best ? { x: curve.best.discount_pct, display: curve.best.profit.display } : null}
          format={format}
          {...at('Profit')}
        />
        <Panel
          title="Revenue"
          curve={curve}
          pick={(p) => p.revenue.value}
          detail={(p) => ({ value: p.revenue.display, range: p.revenue_range?.display ?? null })}
          scenario={scenario && { x: scenario.discount_pct, y: scenario.revenue, display: scenario.revenueDisplay }}
          best={null}
          format={format}
          {...at('Revenue')}
        />
      </div>
      <div className="mt-3 flex flex-wrap items-center gap-x-5 gap-y-1 text-base text-ink-muted">
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
  detail,
  scenario,
  best,
  format,
  hover,
  showTip,
  setHover,
  height = 250,
}: {
  title: string
  curve: CurveResponse
  pick: (p: CurvePoint) => number | null
  /** What this panel reads out: its own figure and range, plus -- on the
   *  profit panel, where it is the question being asked -- the ROI. */
  detail: (p: CurvePoint) => { value: string; range: string | null; roi?: string }
  scenario: { x: number; y: number | null; display: string } | null
  best: { x: number; display: string } | null
  format: (v: number) => string
  hover: number | null
  /** The pointer is in THIS panel, so this is the one that reads out. */
  showTip: boolean
  setHover: (i: number | null) => void
  height?: number
}) {
  const { ref, width: w } = useChartWidth(360)
  // Room for half of a centred 15px "30%" past the last tick.
  const padR = 24
  const padT = 30
  const padB = 44
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
  const ticks = niceTicks(yMin, yMax).filter((t) => t >= yMin && t <= yMax)
  // The y gutter is sized from the longest tick label at 15px (~9px a
  // character, plus the 8px gap and a little air), so "₹456.00 Cr" never
  // runs off the SVG's left edge.
  const padL = Math.max(48, Math.max(...ticks.map((t) => format(t).length)) * 9 + 16)
  const innerW = Math.max(1, w - padL - padR)
  const X = (x: number) => padL + ((x - xMin) / Math.max(1e-9, xMax - xMin)) * innerW
  const Y = (v: number) => padT + innerH * (1 - (v - yMin) / Math.max(1e-9, yMax - yMin))
  const path = pts.map((p, i) => `${i ? 'L' : 'M'} ${X(p.x)} ${Y(p.v)}`).join(' ')
  // Every 5% where there is room; a narrow panel steps by 10% or more so the
  // 15px "35%" labels (~35px) keep at least ~48px between their centres.
  const xStep = 5 * Math.max(1, Math.ceil(48 / Math.max(1, (5 / Math.max(1e-9, xMax - xMin)) * innerW)))
  const xTicks = Array.from({ length: Math.floor(xMax / xStep) + 1 }, (_, i) => i * xStep).filter((x) => x >= xMin && x <= xMax)
  const today = curve.current_discount_pct
  const bestPt = best ? pts.reduce((a, p) => (Math.abs(p.x - best.x) < Math.abs(a.x - best.x) ? p : a), pts[0]) : null
  const hovered = hover != null ? curve.points[hover] : null
  //: This panel's own y at the hovered depth -- the revenue panel marks the
  //: revenue curve, not the profit one.
  const hoveredY = hovered ? pick(hovered) : null
  const tip = hovered ? detail(hovered) : null
  const mid = (xMin + xMax) / 2

  return (
    <div ref={ref} className="relative">
      <div className="mb-1 text-base font-medium text-ink-primary">{title}</div>
      <svg
        viewBox={`0 0 ${w} ${height}`}
        width="100%"
        height={height}
        role="img"
        aria-label={`${title} by average discount`}
        className="cursor-crosshair"
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
            <text x={padL - 8} y={Y(t) + 4} textAnchor="end" fontSize={15} fill="var(--text-muted)">
              {format(t)}
            </text>
          </g>
        ))}
        <line x1={padL} x2={padL + innerW} y1={padT + innerH} y2={padT + innerH} stroke="var(--border-default)" />
        {xTicks.map((x) => (
          <text key={x} x={X(x)} y={padT + innerH + 18} textAnchor="middle" fontSize={15} fill="var(--text-muted)">
            {x}%
          </text>
        ))}
        <text x={padL + innerW / 2} y={height - 6} textAnchor="middle" fontSize={15} fontWeight={500} fill="var(--text-secondary)">
          Average discount
        </text>

        {/* Where the data's deepest discount ends. */}
        {curve.evidence_max < xMax && (
          <g>
            <line x1={X(curve.evidence_max)} x2={X(curve.evidence_max)} y1={padT} y2={padT + innerH} stroke="var(--text-muted)" strokeDasharray="3 3" />
            <text x={X(curve.evidence_max) + 4} y={padT + 12} fontSize={15} fill="var(--text-muted)">
              data limit
            </text>
          </g>
        )}

        <path d={path} fill="none" stroke={LINE} strokeWidth={2.4} strokeLinejoin="round" strokeLinecap="round" />

        <line x1={X(today)} x2={X(today)} y1={padT - 4} y2={padT + innerH} stroke={CURRENT} strokeWidth={1.4} strokeDasharray="4 3" />
        <text x={X(today) + (today > mid ? -6 : 6)} y={padT - 10} textAnchor={today > mid ? 'end' : 'start'} fontSize={15} fontWeight={500} fill={CURRENT}>
          Current {today.toFixed(2)}%
        </text>

        {bestPt && (
          <g>
            <circle cx={X(bestPt.x)} cy={Y(bestPt.v)} r={6} fill="var(--surface-card)" stroke={LINE} strokeWidth={2.4} />
            <text
              x={X(bestPt.x)}
              y={Y(bestPt.v) - 12}
              textAnchor="middle"
              fontSize={15}
              fontWeight={500}
              fill="var(--text-secondary)"
              stroke="var(--surface-card)"
              strokeWidth={4}
              paintOrder="stroke"
            >
              Best {bestPt.x.toFixed(2)}%
            </text>
          </g>
        )}

        {/* WHERE THE POINTER IS. A bare rule did not answer it: the rule is
            vertical and the question is "which point on this line am I
            reading", so the point itself is marked on this panel's own curve,
            and the discount is printed at the axis under the rule, haloed in
            the surface colour so it reads over the tick label it lands on. */}
        {hovered && hoveredY != null && (
          <g>
            {/* Solid, and in the ink at a third: dashed and rule-grey, it was
                both invisible against the gridlines and easy to mistake for
                the two reference lines, which are the dashed ones. */}
            <line
              x1={X(hovered.discount_pct)}
              x2={X(hovered.discount_pct)}
              y1={padT}
              y2={padT + innerH}
              stroke="var(--text-primary)"
              strokeOpacity={0.35}
            />
            <circle cx={X(hovered.discount_pct)} cy={Y(hoveredY)} r={7} fill="var(--surface-card)" />
            <circle cx={X(hovered.discount_pct)} cy={Y(hoveredY)} r={4.5} fill={LINE} />
            <text
              x={X(hovered.discount_pct)}
              y={padT + innerH + 18}
              textAnchor="middle"
              fontSize={15}
              fontWeight={500}
              fill="var(--text-primary)"
              stroke="var(--surface-card)"
              strokeWidth={5}
              paintOrder="stroke"
            >
              {hovered.discount_pct.toFixed(2)}%
            </text>
          </g>
        )}

        {scenario?.y != null && (
          <g>
            <circle cx={X(scenario.x)} cy={Y(scenario.y)} r={8} fill="var(--surface-card)" />
            <circle cx={X(scenario.x)} cy={Y(scenario.y)} r={6} fill={SCENARIO} />
          </g>
        )}
      </svg>
      {/* THREE OR FOUR LINES, NOT NINE. It used to read out profit, revenue,
          ROI and both ranges, in both panels at once: a box deep enough to
          cover the curve it was describing, twice over. A panel answers for
          its own figure, and the one beside it answers for the other. */}
      {hovered && showTip && tip && (
        <div
          className="pointer-events-none absolute top-7 z-10 max-w-[70%] rounded-[var(--r-md)] border border-border-subtle bg-surface-card px-3 py-2 text-base shadow-[var(--shadow-md)] [font-variant-numeric:tabular-nums]"
          // ALWAYS ON THE FAR SIDE FROM THE POINTER. Centred over the hovered
          // depth, the box sat on the very crosshair and marker it exists to
          // explain -- the reading was hidden by the reading. Pinned to the
          // opposite corner it never covers the point, and it does not jump
          // about as the pointer moves within a half.
          style={X(hovered.discount_pct) < padL + innerW / 2 ? { right: 8 } : { left: 8 }}
        >
          <div className="font-medium text-ink-primary">{hovered.discount_pct.toFixed(2)}% average discount</div>
          <div className="mt-0.5 text-ink-secondary">
            {title} <span className="font-medium text-ink-primary">{tip.value}</span>
          </div>
          {tip.roi && (
            <div className="text-ink-secondary">
              ROI <span className="font-medium text-ink-primary">{tip.roi}</span>
            </div>
          )}
          {tip.range && (
            <div className="text-ink-secondary">
              P10 – P90 <span className="text-ink-primary">{tip.range}</span>
            </div>
          )}
          {hovered.beyond_evidence && <div className="mt-0.5 text-status-warning">Beyond the data</div>}
        </div>
      )}
    </div>
  )
}
