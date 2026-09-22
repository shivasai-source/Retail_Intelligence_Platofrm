import { useId, useState } from 'react'
import { useChartWidth } from '../charts/useChartWidth'
import type { CurvePoint, CurveResponse } from '../../types/studio'
import { niceTicks } from './ticks'

/** The trade-off the discount slider moves along: Revenue and ROI at every
 *  depth the slider allows, with the budget and the window held where they
 *  are. Two panels with one axis each — never one chart with two y-scales —
 *  so revenue climbing and ROI falling can be read as two facts rather than
 *  one crossing.
 *
 *  WHAT IS ON EACH PANEL, all of it from the payload:
 *    - the curve: the figure at every depth;
 *    - the scenario as an emerald marker, at the slider's exact depth and the
 *      figures `/simulate` returned for it — the curve's points are the same
 *      arithmetic at fixed steps, so the two agree wherever they meet;
 *    - the current plan's depth as a blue reference line (a dot would sit off
 *      the curve: the current plan runs at full coverage, the curve at the
 *      chosen budget);
 *    - where the budget stops covering the whole scope, shaded and labelled —
 *      that is why revenue can fall as the discount deepens;
 *    - on the revenue panel, the peak; on the ROI panel, break-even (1.00)
 *      with the loss-making region tinted and the depth it starts at named.
 *  Nothing is interpolated or recomputed: every annotation reads a point. */

const CURRENT = { color: 'var(--brand-blue)', label: 'Current plan' }
const SCENARIO = { color: '#10B981', label: 'Scenario' }
const CURVE = 'var(--brand-violet)'

interface Marker {
  discount_pct: number
  revenue: number | null
  roi: number | null
  revenueDisplay: string
  roiDisplay: string
}

export function CurveChart({
  curve,
  current,
  scenario,
  format,
  height = 260,
}: {
  curve: CurveResponse
  current: Marker
  scenario: Marker
  format: (value: number) => string
  height?: number
}) {
  const bindingFrom = curve.points.find((p) => p.discount_pct > 0 && p.coverage < 1)?.discount_pct ?? null
  // "Loses money from": the first loss-making depth PAST the ROI peak, so a
  // shallow depth that barely pays back is not reported as where losses begin.
  const roiPeakIndex = curve.points.reduce((best, p, i) => ((p.roi.value ?? -Infinity) > (curve.points[best].roi.value ?? -Infinity) ? i : best), 0)
  const lossFrom = curve.points.slice(roiPeakIndex).find((p) => p.roi_status === 'loss_making')?.discount_pct ?? null
  const peak = curve.points.reduce<CurvePoint | null>(
    (best, p) => (p.revenue.value != null && (best == null || p.revenue.value > (best.revenue.value ?? -Infinity)) ? p : best),
    null,
  )

  return (
    <div>
      <div className="grid grid-cols-2 gap-6 @max-[900px]:grid-cols-1">
        <Panel
          title="Revenue over the window"
          curve={curve}
          pick={(p) => ({ v: p.revenue.value, display: p.revenue.display })}
          marker={{ ...SCENARIO, x: scenario.discount_pct, y: scenario.revenue, display: scenario.revenueDisplay }}
          reference={{ ...CURRENT, x: current.discount_pct }}
          bindingFrom={bindingFrom}
          peak={peak && peak.revenue.value != null ? { x: peak.discount_pct, y: peak.revenue.value, display: peak.revenue.display } : null}
          format={format}
          zoom
          height={height}
        />
        <Panel
          title="ROI over the window"
          curve={curve}
          pick={(p) => ({ v: p.roi.value, display: p.roi.display })}
          marker={{ ...SCENARIO, x: scenario.discount_pct, y: scenario.roi, display: scenario.roiDisplay }}
          reference={{ ...CURRENT, x: current.discount_pct }}
          bindingFrom={bindingFrom}
          breakEven={{ value: curve.break_even_roi, lossFrom }}
          format={(v) => v.toFixed(2)}
          height={height}
        />
      </div>
      <div className="mt-3 flex flex-wrap items-center gap-x-5 gap-y-1 text-sm text-ink-muted">
        <span className="inline-flex items-center gap-1.5">
          <span className="inline-block h-0.5 w-4 rounded" style={{ background: CURVE }} /> At each depth
        </span>
        <span className="inline-flex items-center gap-1.5">
          <span className="inline-block h-2.5 w-2.5 rounded-full" style={{ background: SCENARIO.color }} /> Scenario
        </span>
        <span className="inline-flex items-center gap-1.5">
          <span className="inline-block h-4 w-0 border-l-2 border-dashed" style={{ borderColor: CURRENT.color }} /> Current plan depth
        </span>
        {bindingFrom != null && (
          <span className="inline-flex items-center gap-1.5">
            <span className="inline-block h-3 w-4 rounded-sm bg-status-warning opacity-25" /> Budget covers less of the scope
          </span>
        )}
      </div>
    </div>
  )
}

function Panel({
  title,
  curve,
  pick,
  marker,
  reference,
  bindingFrom,
  peak,
  breakEven,
  format,
  zoom = false,
  height,
}: {
  title: string
  curve: CurveResponse
  pick: (p: CurvePoint) => { v: number | null; display: string }
  marker: { color: string; label: string; x: number; y: number | null; display: string }
  reference: { color: string; label: string; x: number }
  /** The first depth at which the budget no longer covers the whole scope. */
  bindingFrom: number | null
  peak?: { x: number; y: number; display: string } | null
  breakEven?: { value: number; lossFrom: number | null }
  format: (value: number) => string
  /** Start the axis just under the lowest curve value instead of at zero, so
   *  a line that moves by a tenth of its height stays readable. The axis is
   *  labelled, so nothing is hidden. Off for ROI, where zero and 1.00 are the
   *  points of reference. */
  zoom?: boolean
  height: number
}) {
  const { ref, width: w } = useChartWidth(360)
  const clipId = useId()
  const [hover, setHover] = useState<number | null>(null)
  const padL = 60
  const padR = 16
  const padT = 34
  const padB = 44
  const innerW = Math.max(1, w - padL - padR)
  const innerH = Math.max(1, height - padT - padB)

  const points = curve.points.map((p) => ({ x: p.discount_pct, coverage: p.coverage, ...pick(p) }))
  const drawn = points.filter((p) => p.v != null) as { x: number; v: number; display: string }[]
  const xMin = Math.min(...points.map((p) => p.x))
  const xMax = Math.max(...points.map((p) => p.x))

  // THE SCALE COMES FROM THE LINE and the points of reference on it.
  const lineValues = [...drawn.map((p) => p.v), ...(marker.y == null ? [] : [marker.y]), ...(breakEven ? [breakEven.value] : [])]
  const rawMax = Math.max(1e-9, ...lineValues)
  const rawMin = Math.min(...lineValues)
  const yMin = zoom ? Math.max(0, rawMin - (rawMax - rawMin) * 0.6) : 0
  const yMax = rawMax + (rawMax - yMin) * 0.22
  const X = (x: number) => padL + ((x - xMin) / Math.max(1e-9, xMax - xMin)) * innerW
  const Y = (v: number) => padT + innerH * (1 - (v - yMin) / Math.max(1e-9, yMax - yMin))

  const line = drawn.map((p, i) => `${i === 0 ? 'M' : 'L'} ${X(p.x)} ${Y(p.v)}`).join(' ')
  const grid = niceTicks(yMin, rawMax)
  const xTicks = Array.from({ length: Math.floor(xMax / 5) + 1 }, (_, i) => i * 5).filter((x) => x <= xMax)
  const hovered = hover != null ? points[hover] : null

  // Labels sit on the side of their anchor that faces away from the other
  // annotations, so a scenario at the current plan's depth still reads.
  const mid = (xMin + xMax) / 2
  const markerSide: 'left' | 'right' = marker.x > mid ? 'left' : 'right'
  const nearReference = Math.abs(X(marker.x) - X(reference.x)) < 14

  return (
    <div ref={ref} className="relative">
      <div className="mb-1 text-base font-bold text-ink-primary">{title}</div>
      <svg
        viewBox={`0 0 ${w} ${height}`}
        width="100%"
        height={height}
        role="img"
        aria-label={`${title} by discount depth`}
        onMouseLeave={() => setHover(null)}
        onMouseMove={(e) => {
          const rect = e.currentTarget.getBoundingClientRect()
          const px = ((e.clientX - rect.left) / rect.width) * w
          let best = 0
          let bestD = Infinity
          points.forEach((p, i) => {
            const d = Math.abs(X(p.x) - px)
            if (d < bestD) {
              bestD = d
              best = i
            }
          })
          setHover(best)
        }}
      >
        <defs>
          <clipPath id={clipId}>
            <rect x={padL} y={padT} width={innerW} height={innerH} />
          </clipPath>
        </defs>

        {/* Where the budget stops covering the whole scope. */}
        {bindingFrom != null && (
          <rect x={X(bindingFrom)} y={padT} width={Math.max(0, padL + innerW - X(bindingFrom))} height={innerH} fill="var(--status-warning)" opacity={0.07} />
        )}
        {/* Under break-even the promotion loses money. */}
        {breakEven && (
          <rect x={padL} y={Y(breakEven.value)} width={innerW} height={Math.max(0, Y(yMin) - Y(breakEven.value))} fill="var(--status-danger)" opacity={0.06} />
        )}

        {grid.map((v) => (
          <g key={v}>
            <line x1={padL} y1={Y(v)} x2={padL + innerW} y2={Y(v)} stroke="var(--border-subtle)" />
            <text x={padL - 8} y={Y(v) + 4} textAnchor="end" fontSize={12} fill="var(--text-muted)">
              {format(v)}
            </text>
          </g>
        ))}
        <line x1={padL} y1={Y(yMin)} x2={padL + innerW} y2={Y(yMin)} stroke="var(--border-default)" />
        {xTicks.map((x) => (
          <g key={x}>
            <line x1={X(x)} x2={X(x)} y1={Y(yMin)} y2={Y(yMin) + 4} stroke="var(--border-default)" />
            <text x={X(x)} y={Y(yMin) + 17} textAnchor="middle" fontSize={12} fill="var(--text-muted)">
              {x}%
            </text>
          </g>
        ))}
        <text x={padL + innerW / 2} y={height - 6} textAnchor="middle" fontSize={12} fontWeight={600} fill="var(--text-secondary)">
          Discount depth
        </text>

        <g clipPath={`url(#${clipId})`}>
          <path d={line} fill="none" stroke={CURVE} strokeWidth={2.4} strokeLinejoin="round" strokeLinecap="round" />
        </g>

        {breakEven && (
          <g>
            <line x1={padL} y1={Y(breakEven.value)} x2={padL + innerW} y2={Y(breakEven.value)} stroke="var(--status-danger)" strokeWidth={1.2} strokeDasharray="5 4" />
            <text x={padL + 6} y={Y(breakEven.value) - 5} fontSize={12} fontWeight={600} fill="var(--status-danger)">
              Break-even 1.00{breakEven.lossFrom != null ? ` · loses money from ${breakEven.lossFrom.toFixed(2)}%` : ''}
            </text>
          </g>
        )}

        {/* The current plan's depth. */}
        <line x1={X(reference.x)} x2={X(reference.x)} y1={padT - 6} y2={Y(yMin)} stroke={reference.color} strokeWidth={1.4} strokeDasharray="4 3" />
        <text
          x={X(reference.x) + (reference.x > mid ? -6 : 6)}
          y={padT - 12}
          textAnchor={reference.x > mid ? 'end' : 'start'}
          fontSize={12}
          fontWeight={700}
          fill={reference.color}
        >
          {reference.label} {reference.x.toFixed(2)}%
        </text>

        {/* The revenue peak, when it is not where the scenario already sits. */}
        {peak && Math.abs(peak.x - marker.x) > 0.01 && (
          <g>
            <circle cx={X(peak.x)} cy={Y(peak.y)} r={4.5} fill="var(--surface-card)" stroke={CURVE} strokeWidth={2} />
            <text
              x={X(peak.x)}
              y={Y(peak.y) - 10}
              textAnchor="middle"
              fontSize={12}
              fill="var(--text-secondary)"
              stroke="var(--surface-card)"
              strokeWidth={4}
              paintOrder="stroke"
              style={{ fontVariantNumeric: 'tabular-nums' }}
            >
              Peak {peak.display} at {peak.x.toFixed(2)}%
            </text>
          </g>
        )}

        {bindingFrom != null && (
          // Inside the plot whichever side has room: to the right of the
          // boundary when there is space, otherwise to its left.
          X(bindingFrom) + 200 < padL + innerW ? (
            <text x={X(bindingFrom) + 5} y={Y(yMin) - 6} fontSize={12} fill="var(--status-warning)" fontWeight={600}>
              Budget covers less of the scope →
            </text>
          ) : (
            <text x={X(bindingFrom) - 5} y={Y(yMin) - 6} textAnchor="end" fontSize={12} fill="var(--status-warning)" fontWeight={600}>
              Budget covers less of the scope →
            </text>
          )
        )}

        {hovered && hovered.v != null && (
          <line x1={X(hovered.x)} x2={X(hovered.x)} y1={padT} y2={Y(yMin)} stroke="var(--text-muted)" strokeDasharray="2 3" />
        )}

        {marker.y != null && (
          <g>
            <circle cx={X(marker.x)} cy={Y(marker.y)} r={8} fill="var(--surface-card)" />
            <circle cx={X(marker.x)} cy={Y(marker.y)} r={6} fill={marker.color} />
            <text
              x={X(marker.x) + (markerSide === 'right' ? 12 : -12)}
              y={Y(marker.y) + (nearReference ? 22 : 4)}
              textAnchor={markerSide === 'right' ? 'start' : 'end'}
              fontSize={12.5}
              fontWeight={700}
              fill="var(--text-primary)"
              stroke="var(--surface-card)"
              strokeWidth={4}
              paintOrder="stroke"
              style={{ fontVariantNumeric: 'tabular-nums' }}
            >
              {marker.label} {marker.x.toFixed(2)}% · {marker.display}
            </text>
          </g>
        )}
      </svg>

      {hovered && (
        <div
          className="pointer-events-none absolute top-7 z-10 rounded-[var(--r-md)] border border-border-subtle bg-surface-card px-3 py-2 text-sm shadow-[var(--shadow-md)] [font-variant-numeric:tabular-nums]"
          style={{ left: `${Math.min(78, Math.max(22, (X(hovered.x) / w) * 100))}%`, transform: 'translateX(-50%)' }}
        >
          <div className="font-bold text-ink-primary">{hovered.x.toFixed(2)}% discount</div>
          {hovered.v == null ? (
            <div className="mt-0.5 text-ink-muted">No promotion</div>
          ) : (
            <>
              <div className="mt-0.5 text-ink-secondary">
                <span className="font-semibold text-ink-primary">{hovered.display}</span>
              </div>
              {hovered.coverage < 1 && <div className="mt-0.5 text-ink-muted">Budget covers {(hovered.coverage * 100).toFixed(2)}% of the scope</div>}
            </>
          )}
        </div>
      )}
    </div>
  )
}
