import { useChartWidth } from '../charts/useChartWidth'
import type { SaturationCurve } from '../../types/promotionIntelligence'
import { fmtRoi } from '../../lib/roi'

// ROI against discount depth. Unlike the sample curve this replaces, every
// point is a real mechanic from the dataset, so the x-axis is the actual set
// of depths the business runs (5/10/15/25%) rather than a smooth synthetic
// sweep. Points are plotted at their true depth, so the gap between 15% and
// 25% is visible rather than evenly spaced — that gap is information.
export function SaturationChart({ curve, height = 240 }: { curve: SaturationCurve; height?: number }) {
  const { ref, width: w } = useChartWidth(560)
  const padL = 44,
    padR = 18,
    padT = 26,
    padB = 42
  const innerW = Math.max(1, w - padL - padR)
  const innerH = Math.max(1, height - padT - padB)

  const pts = curve.points.filter((p) => p.roi_multiple !== null)
  if (!pts.length) {
    return <div className="grid h-[200px] place-items-center text-base text-ink-muted">No mechanic carries a discount depth.</div>
  }

  const maxDepth = Math.max(...pts.map((p) => p.depth_pct), 30)
  const maxRoi = Math.max(...pts.map((p) => p.roi_multiple as number), curve.target_roi) * 1.15
  const x = (d: number) => padL + (d / maxDepth) * innerW
  const y = (v: number) => padT + innerH * (1 - v / maxRoi)

  const path = pts.map((p, i) => `${i === 0 ? 'M' : 'L'} ${x(p.depth_pct)} ${y(p.roi_multiple as number)}`).join(' ')
  // Gridlines every 0.5; 1.00 is break-even, so it always earns a line.
  const gridVals = [0, 0.5, 1, 1.5, 2, 2.5, 3].filter((v) => v <= maxRoi)

  return (
    <div ref={ref}>
      <svg viewBox={`0 0 ${w} ${height}`} width="100%" height={height}>
        {gridVals.map((v) => (
          <g key={v}>
            <line x1={padL} y1={y(v)} x2={padL + innerW} y2={y(v)} stroke="var(--border-subtle)" strokeDasharray="3 4" />
            <text x={padL - 8} y={y(v) + 3} textAnchor="end" fontSize={10} fill="var(--text-muted)">
              {fmtRoi(v)}
            </text>
          </g>
        ))}

        {/* The hurdle every promotion must clear — the line that makes the curve mean something. */}
        <line x1={padL} y1={y(curve.target_roi)} x2={padL + innerW} y2={y(curve.target_roi)} stroke="#10B981" strokeWidth={1.4} strokeDasharray="6 4" />
        <text x={padL + innerW} y={y(curve.target_roi) - 6} textAnchor="end" fontSize={10} fill="#047857" fontWeight={700}>
          Target {fmtRoi(curve.target_roi)}
        </text>

        {curve.saturation_depth_pct !== null && (
          <>
            <line x1={x(curve.saturation_depth_pct)} y1={padT} x2={x(curve.saturation_depth_pct)} y2={padT + innerH} stroke="#EF4444" strokeWidth={1} strokeDasharray="4 3" />
            <text x={x(curve.saturation_depth_pct)} y={padT - 8} textAnchor="middle" fontSize={10} fill="#B91C1C" fontWeight={700}>
              Saturation {curve.saturation_depth_pct}%
            </text>
          </>
        )}

        <path d={path} fill="none" stroke="#7C5CFF" strokeWidth={2.4} strokeLinecap="round" strokeLinejoin="round" />

        {pts.map((p) => {
          const roi = p.roi_multiple as number
          const below = roi < curve.target_roi
          // Radius carries spend share: the biggest dot is where the money is,
          // which is the difference between a curiosity and a problem.
          const r = 4 + Math.min(7, ((p.spend_share_pct ?? 0) / 100) * 18)
          return (
            <g key={p.mechanic}>
              <circle cx={x(p.depth_pct)} cy={y(roi)} r={r} fill={below ? '#EF4444' : '#10B981'} opacity={0.9} stroke="white" strokeWidth={1.5} />
              <text x={x(p.depth_pct)} y={y(roi) - r - 6} textAnchor="middle" fontSize={10} fontWeight={800} fill={below ? '#B91C1C' : '#047857'}>
                {fmtRoi(roi)}
              </text>
              <text x={x(p.depth_pct)} y={padT + innerH + 16} textAnchor="middle" fontSize={9.5} fill="var(--text-muted)">
                {p.depth_pct}%
              </text>
              {p.spend_share_pct != null && (
                <text x={x(p.depth_pct)} y={padT + innerH + 29} textAnchor="middle" fontSize={9} fill="var(--text-secondary)" fontWeight={600}>
                  {p.spend_share_pct}% spend
                </text>
              )}
            </g>
          )
        })}

        <text x={padL - 30} y={padT - 10} fontSize={9.5} fill="var(--text-muted)" fontWeight={600}>
          ROI
        </text>
        <text x={padL + innerW} y={height - 4} textAnchor="end" fontSize={9.5} fill="var(--text-muted)" fontWeight={600}>
          Discount depth →
        </text>
      </svg>
    </div>
  )
}
