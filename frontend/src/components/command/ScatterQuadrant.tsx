import { useState } from 'react'
import { useChartWidth } from '../charts/useChartWidth'
import type { BreakdownGroup } from '../../types/commandCenter'
import { BREAKEVEN_ROI, fmtRoi } from '../../lib/roi'

/** Trade Spend against ROI — where money went versus what it returned.
 *
 *  The one chart that puts investment and return on the same picture, so
 *  "high spend, weak return" becomes a position rather than a calculation.
 *  Point area encodes Incremental Sales.
 *
 *  A linear ROI axis, deliberately: ROI is a multiple of spend that is
 *  legitimately below 1.0, and even negative (a promotion can sell below
 *  baseline), so a log scale cannot represent it. The axis is clamped to the
 *  data's own range including negatives, and the break-even line sits at 1.0.
 *
 *  The target line is drawn at `targetRoi`, which the caller reads from
 *  `meta.target_roi`. Nothing here hard-codes 1.5. */
export function ScatterQuadrant({
  groups,
  targetRoi,
  rate,
  symbol,
  height = 230,
}: {
  groups: BreakdownGroup[]
  targetRoi: number
  rate: number
  symbol: string
  height?: number
}) {
  const { ref: host, width } = useChartWidth(560)
  const [hover, setHover] = useState<number | null>(null)

  const padL = 52
  const padR = 16
  const padT = 14
  const padB = 34
  const innerW = Math.max(120, width - padL - padR)
  const innerH = height - padT - padB

  const points = groups.filter((g) => g.roi !== null && g.trade_spend !== null)
  const maxSpend = Math.max(...points.map((p) => p.trade_spend), 1)
  const rois = points.map((p) => p.roi as number)
  const roiMin = Math.min(0, ...rois, targetRoi)
  const roiMax = Math.max(...rois, targetRoi) * 1.08
  const maxSales = Math.max(...points.map((p) => p.incremental_sales ?? 0), 1)

  const x = (v: number) => padL + (v / maxSpend) * innerW
  const y = (v: number) => padT + innerH * (1 - (v - roiMin) / (roiMax - roiMin || 1))
  const r = (v: number | null) => 4 + Math.sqrt((v ?? 0) / maxSales) * 9

  const money = (v: number) => {
    const a = v * rate
    if (symbol === '₹') return Math.abs(a) >= 1e7 ? `${symbol}${(a / 1e7).toFixed(1)}Cr` : `${symbol}${(a / 1e5).toFixed(1)}L`
    return Math.abs(a) >= 1e6 ? `${symbol}${(a / 1e6).toFixed(1)}M` : `${symbol}${(a / 1e3).toFixed(1)}K`
  }

  const roiTicks = 4
  const active = hover === null ? null : points[hover]

  return (
    <div ref={host} className="relative w-full">
      <svg width={width} height={height} role="img" aria-label="Trade spend versus ROI">
        {/* ROI gridlines */}
        {Array.from({ length: roiTicks + 1 }, (_, i) => {
          const v = roiMin + ((roiMax - roiMin) / roiTicks) * i
          return (
            <g key={i}>
              <line x1={padL} x2={width - padR} y1={y(v)} y2={y(v)} stroke="var(--border-subtle)" strokeWidth={1} />
              <text x={padL - 8} y={y(v) + 3} textAnchor="end" fontSize={10} fill="var(--text-muted)">
                {fmtRoi(v)}
              </text>
            </g>
          )
        })}

        {/* Target ROI — from the API, never a literal */}
        <line
          x1={padL} x2={width - padR} y1={y(targetRoi)} y2={y(targetRoi)}
          stroke="var(--brand-violet)" strokeWidth={1.5} strokeDasharray="5 4" opacity={0.75}
        />
        <text x={width - padR} y={y(targetRoi) - 4} textAnchor="end" fontSize={10} fill="var(--brand-violet)" fontWeight={700}>
          Target {fmtRoi(targetRoi)}
        </text>

        {/* Break-even (1.0), when it is in range: below it the spend did not come back */}
        {roiMin < BREAKEVEN_ROI && roiMax > BREAKEVEN_ROI && (
          <line x1={padL} x2={width - padR} y1={y(BREAKEVEN_ROI)} y2={y(BREAKEVEN_ROI)} stroke="var(--text-muted)" strokeWidth={1} opacity={0.4} />
        )}

        {points.map((p, i) => {
          const below = (p.roi as number) < targetRoi
          return (
            <circle
              key={p.code}
              cx={x(p.trade_spend)}
              cy={y(p.roi as number)}
              r={r(p.incremental_sales)}
              fill={below ? 'var(--status-danger)' : 'var(--brand-violet)'}
              fillOpacity={hover === i ? 0.85 : 0.45}
              stroke={below ? 'var(--status-danger)' : 'var(--brand-violet)'}
              strokeWidth={hover === i ? 2 : 1}
              className="cursor-default transition-opacity"
              onMouseEnter={() => setHover(i)}
              onMouseLeave={() => setHover(null)}
            />
          )
        })}

        <line x1={padL} x2={width - padR} y1={padT + innerH} y2={padT + innerH} stroke="var(--border-default)" />
        <text x={padL} y={height - 8} fontSize={10} fill="var(--text-muted)">0</text>
        <text x={width - padR} y={height - 8} fontSize={10} fill="var(--text-muted)" textAnchor="end">
          {money(maxSpend)} trade spend →
        </text>
      </svg>

      {active && (
        <div
          className="pointer-events-none absolute z-20 w-52 rounded-[var(--r-md)] border border-border-default bg-surface-card p-2.5 text-xs shadow-[var(--shadow-lg)]"
          style={{
            left: Math.min(Math.max(0, x(active.trade_spend) - 104), Math.max(0, width - 208)),
            top: Math.max(0, y(active.roi as number) - 96),
          }}
        >
          <div className="font-bold text-ink-primary">{active.label}</div>
          <Row k="Trade Spend" v={active.trade_spend_display} />
          <Row k="Incremental Sales" v={active.incremental_sales_display} />
          <Row k="ROI" v={fmtRoi(active.roi)} />
          <Row k="Target ROI" v={fmtRoi(targetRoi)} />
        </div>
      )}
    </div>
  )
}

function Row({ k, v }: { k: string; v: string }) {
  return (
    <div className="mt-1 flex justify-between gap-3">
      <span className="text-ink-muted">{k}</span>
      <span className="font-semibold tabular-nums text-ink-primary">{v}</span>
    </div>
  )
}
