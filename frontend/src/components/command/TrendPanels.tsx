import { useState } from 'react'
import { useChartWidth } from '../charts/useChartWidth'
import { calendarYear } from '../../lib/labels'
import type { TrendResponse } from '../../types/commandCenter'
import { fmtRoi } from '../../lib/roi'

/** Promotion Performance Trend — three line series on a dual axis.
 *
 *  LEFT axis  (currency): Incremental Sales, Trade Spend
 *  RIGHT axis (multiple): ROI, plus the dashed target reference
 *
 *  ROI is never plotted against the money axis: a multiple of spend and a rupee
 *  amount share no scale, and the previous single-axis version produced an
 *  axis whose labels described neither.
 *
 *  Both axes are divided into the SAME four intervals, so the left and right
 *  labels land on one shared set of gridlines rather than two interleaved
 *  grids — the standard dual-axis treatment, and the only one that stays
 *  readable at this card size.
 *
 *  NULL ROI IS NEVER DRAWN AS ZERO. A period with no promotion has undefined
 *  ROI; plotting 0 would claim the promotion returned nothing. The line breaks
 *  across the gap and the tooltip says why.
 */

/** The smallest round step at or above `raw`, so axis labels are readable
 *  numbers rather than whatever the data happened to reach.
 *
 *  The ladder is deliberately finer than the usual 1/2/5: with only those,
 *  an ₹8.3 Cr peak rounds up to a ₹20 Cr axis and the series sit squashed in
 *  the bottom 40% of the card. */
const NICE = [1, 1.5, 2, 2.5, 3, 4, 5, 6, 7.5, 10]

function niceStep(raw: number): number {
  if (raw <= 0) return 1
  const mag = 10 ** Math.floor(Math.log10(raw))
  const norm = raw / mag
  return (NICE.find((c) => c >= norm - 1e-9) ?? 10) * mag
}

const DIVISIONS = 4

/** Minimum horizontal pitch between x-axis ticks, in px. Ticks are spaced by
 *  PIXELS rather than by a fixed count: at 52 weekly points the old `n / 13`
 *  rule placed 13 ticks 48px apart while each one read "W01 2025" at ~45px
 *  wide, leaving 3px between them — the axis read as one grey smear. */
const TICK_PITCH = 48

export function TrendPanels({
  data,
  rate,
  symbol,
  granularity = 'week',
  height = 290,
}: {
  data: TrendResponse
  /** From `meta.exchange_rate` — the single backend-defined rate. */
  rate: number
  symbol: string
  granularity?: 'week' | 'month'
  height?: number
}) {
  const { ref: host, width } = useChartWidth(640)
  const [hover, setHover] = useState<number | null>(null)

  const { labels, series } = data
  const n = labels.length
  const padL = 60
  const padR = 52
  const padT = 14
  const padB = 26
  const innerW = Math.max(120, width - padL - padR)
  const innerH = Math.max(80, height - padT - padB)
  const step = n > 1 ? innerW / n : innerW
  const targetRoi = series.target_roi[0] ?? data.meta.target_roi

  const money = (v: number) => {
    const a = v * rate
    if (symbol === '₹') {
      if (Math.abs(a) >= 1e7) return `${symbol}${(a / 1e7).toFixed(1)} Cr`
      if (Math.abs(a) >= 1e5) return `${symbol}${(a / 1e5).toFixed(1)} L`
      return `${symbol}${a.toFixed(0)}`
    }
    if (Math.abs(a) >= 1e6) return `${symbol}${(a / 1e6).toFixed(1)} M`
    if (Math.abs(a) >= 1e3) return `${symbol}${(a / 1e3).toFixed(1)} K`
    return `${symbol}${a.toFixed(0)}`
  }

  // --- left axis: currency, 0 to a rounded maximum -------------------------
  const moneyPeak = Math.max(...series.incremental_sales, ...series.trade_spend, 1)
  const moneyStep = niceStep(moneyPeak / DIVISIONS)
  const moneyMax = moneyStep * DIVISIONS
  const yMoney = (v: number) => padT + innerH * (1 - v / moneyMax)

  // --- right axis: ROI multiple, negatives preserved -----------------------
  const roiValues = series.roi.filter((v): v is number => v !== null)
  const rawLo = Math.min(0, ...roiValues, targetRoi)
  const rawHi = Math.max(...roiValues, targetRoi, 1)
  const roiStep = niceStep((rawHi - rawLo) / DIVISIONS)
  const roiLo = Math.floor(rawLo / roiStep) * roiStep
  const roiHi = roiLo + roiStep * DIVISIONS
  const yRoi = (v: number) => padT + innerH * (1 - (v - roiLo) / (roiHi - roiLo || 1))

  // Break the ROI line into runs of consecutive non-null points, so a gap is a
  // gap rather than a line dropping to zero.
  const runs: { i: number; v: number }[][] = []
  let run: { i: number; v: number }[] = []
  series.roi.forEach((v, i) => {
    if (v === null) {
      if (run.length) runs.push(run)
      run = []
    } else run.push({ i, v })
  })
  if (run.length) runs.push(run)

  const cx = (i: number) => padL + step * i + step / 2
  const labelEvery = Math.max(1, Math.ceil(TICK_PITCH / step))

  // The year is identical on almost every tick, so it is printed only when it
  // CHANGES. That is what shortens "W01 2025" to "W01" and lets the periods
  // themselves be read; the first tick always carries it.
  const xTicks = (() => {
    const out: { i: number; text: string }[] = []
    const yearOf = (label: string) => calendarYear(label).match(/\b(\d{4})\b/)?.[1] ?? null
    // Seeded with the FIRST tick's own year, so the axis never repeats what the
    // year filter above the chart already states. It reappears only where the
    // year actually turns over — the one case week numbers alone are ambiguous,
    // since an "All Years" range holds two W01s.
    let lastYear = n ? yearOf(labels[0]) : null
    for (let i = 0; i < n; i += labelEvery) {
      const full = calendarYear(labels[i])
      const year = yearOf(labels[i])
      out.push({ i, text: year && year === lastYear ? full.replace(/\s*\b\d{4}\b/, '').trim() : full })
      lastYear = year
    }
    return out
  })()
  const active = hover !== null && hover < n ? hover : null
  const path = (values: number[]) => values.map((v, i) => `${cx(i)},${yMoney(v)}`).join(' ')

  const periodWord = granularity === 'month' ? 'Month' : 'Week'
  const roiAt = active === null ? null : series.roi[active]

  return (
    <div ref={host} className="relative w-full">
      <svg width={width} height={height} role="img" aria-label="Promotion performance trend">
        {/* One shared grid: both axes use the same four divisions. */}
        {Array.from({ length: DIVISIONS + 1 }, (_, k) => {
          const f = k / DIVISIONS
          const y = padT + innerH * (1 - f)
          return (
            <g key={k}>
              <line x1={padL} x2={width - padR} y1={y} y2={y} stroke="var(--border-subtle)" />
              <text x={padL - 8} y={y + 3} textAnchor="end" fontSize={10} fill="var(--text-muted)">
                {money(moneyMax * f)}
              </text>
              <text x={width - padR + 8} y={y + 3} textAnchor="start" fontSize={10} fill="var(--text-muted)">
                {fmtRoi(roiLo + (roiHi - roiLo) * f)}
              </text>
            </g>
          )
        })}

        {/* Target ROI — a reference on the ROI axis, never a business curve. */}
        <line
          x1={padL}
          x2={width - padR}
          y1={yRoi(targetRoi)}
          y2={yRoi(targetRoi)}
          stroke="var(--text-muted)"
          strokeWidth={1.5}
          strokeDasharray="5 4"
          opacity={0.75}
        />
        <text
          x={width - padR - 4}
          y={yRoi(targetRoi) - 4}
          textAnchor="end"
          fontSize={10}
          fill="var(--text-muted)"
          fontWeight={700}
        >
          Target {fmtRoi(targetRoi)}
        </text>

        {/* Hover guide */}
        {active !== null && (
          <line
            x1={cx(active)}
            x2={cx(active)}
            y1={padT}
            y2={padT + innerH}
            stroke="var(--border-strong)"
            strokeDasharray="3 3"
          />
        )}

        {/* 1 — Incremental Sales (left axis) */}
        <polyline fill="none" stroke="var(--brand-violet)" strokeWidth={2} strokeLinejoin="round"
          points={path(series.incremental_sales)} />
        {/* 2 — Trade Spend (left axis) */}
        <polyline fill="none" stroke="var(--status-danger)" strokeWidth={2} strokeLinejoin="round"
          points={path(series.trade_spend)} />
        {/* 3 — ROI (right axis), one run per unbroken stretch */}
        {runs.map((r, k) => (
          <polyline key={k} fill="none" stroke="var(--tint-teal-icon)" strokeWidth={2} strokeLinejoin="round"
            points={r.map((p) => `${cx(p.i)},${yRoi(p.v)}`).join(' ')} />
        ))}

        {active !== null && (
          <>
            <circle cx={cx(active)} cy={yMoney(series.incremental_sales[active])} r={3.5} fill="var(--brand-violet)" />
            <circle cx={cx(active)} cy={yMoney(series.trade_spend[active])} r={3.5} fill="var(--status-danger)" />
            {roiAt !== null && <circle cx={cx(active)} cy={yRoi(roiAt)} r={3.5} fill="var(--tint-teal-icon)" />}
          </>
        )}

        {xTicks.map((t) => (
          <text key={t.i} x={cx(t.i)} y={height - 6} textAnchor="middle" fontSize={10} fill="var(--text-muted)">
            {t.text}
          </text>
        ))}

        {/* Invisible hover columns across the full plot height */}
        {labels.map((_, i) => (
          <rect key={`h${i}`} x={cx(i) - step / 2} y={0} width={step} height={height}
            fill="transparent" onMouseEnter={() => setHover(i)} onMouseLeave={() => setHover(null)} />
        ))}
      </svg>

      {active !== null && (
        <div
          className="pointer-events-none absolute top-2 z-20 w-56 rounded-[var(--r-md)] border border-border-default bg-surface-card p-2.5 text-xs shadow-[var(--shadow-lg)]"
          style={{ left: Math.min(Math.max(0, cx(active) - 112), Math.max(0, width - 224)) }}
        >
          <div className="font-bold text-ink-primary">
            {periodWord} {calendarYear(labels[active])}
          </div>
          <Row swatch="var(--brand-violet)" k="Incremental Sales" v={data.display.incremental_sales[active]} />
          <Row swatch="var(--status-danger)" k="Trade Spend" v={data.display.trade_spend[active]} />
          {roiAt === null ? (
            <div className="mt-1 text-ink-muted">ROI — no promotion / insufficient baseline</div>
          ) : (
            <Row swatch="var(--tint-teal-icon)" k="ROI" v={fmtRoi(roiAt)} />
          )}
          <Row k="Target ROI" v={fmtRoi(targetRoi)} dashed />
        </div>
      )}
    </div>
  )
}

function Row({ k, v, swatch, dashed }: { k: string; v: string; swatch?: string; dashed?: boolean }) {
  return (
    <div className="mt-1 flex items-center justify-between gap-3">
      <span className="flex min-w-0 items-center gap-1.5 text-ink-muted">
        {dashed ? (
          <span className="h-0 w-2.5 shrink-0 border-t border-dashed border-ink-muted" />
        ) : (
          <span className="h-0.5 w-2.5 shrink-0 rounded-sm" style={{ background: swatch }} />
        )}
        <span className="truncate">{k}</span>
      </span>
      <span className="shrink-0 font-semibold tabular-nums text-ink-primary">{v}</span>
    </div>
  )
}
