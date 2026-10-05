import { useState } from 'react'
import { SERIES } from './series'
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
 *
 *  The legend above the card toggles each series through `hidden`. A tried
 *  set of extras — below-target shading, a filled sales/spend band, curved
 *  lines and peak markers — was taken back out: on the real data the shading
 *  covered most of the year and the chart stopped matching the plain lines of
 *  every other chart on the page.
 */

/** The legend's toggles. `target` is the dashed Target ROI reference. */
export type TrendSeries = 'sales' | 'spend' | 'roi' | 'target'

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

const TOOLTIP_W = 224

export function TrendPanels({
  data,
  rate,
  symbol,
  granularity = 'week',
  height = 290,
  hidden = new Set<TrendSeries>(),
}: {
  data: TrendResponse
  /** From `meta.exchange_rate` — the single backend-defined rate. */
  rate: number
  symbol: string
  granularity?: 'week' | 'month'
  height?: number
  /** Series the legend has switched off. */
  hidden?: ReadonlySet<TrendSeries>
}) {
  const { ref: host, width } = useChartWidth(640)
  const [hover, setHover] = useState<number | null>(null)

  const show = {
    sales: !hidden.has('sales'),
    spend: !hidden.has('spend'),
    roi: !hidden.has('roi'),
    target: !hidden.has('target'),
  }

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
      if (Math.abs(a) >= 1e7) return `${symbol}${(a / 1e7).toFixed(2)} Cr`
      if (Math.abs(a) >= 1e5) return `${symbol}${(a / 1e5).toFixed(2)} L`
      return `${symbol}${a.toFixed(2)}`
    }
    if (Math.abs(a) >= 1e6) return `${symbol}${(a / 1e6).toFixed(2)} M`
    if (Math.abs(a) >= 1e3) return `${symbol}${(a / 1e3).toFixed(2)} K`
    return `${symbol}${a.toFixed(2)}`
  }

  // --- left axis: currency, 0 to a rounded maximum -------------------------
  // Scaled to the money series on screen, so hiding the taller one lets the
  // other fill the plot; with both hidden the axis keeps its full range.
  const visibleMoney = [
    ...(show.sales ? series.incremental_sales : []),
    ...(show.spend ? series.trade_spend : []),
  ]
  const moneyPeak = Math.max(
    ...(visibleMoney.length ? visibleMoney : [...series.incremental_sales, ...series.trade_spend]),
    1,
  )
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
  const roiAxis = show.roi || show.target

  // The tooltip sits BESIDE the hovered period — on the side with more room —
  // so it never covers the points it is describing.
  const tipLeft =
    active === null
      ? 0
      : cx(active) > width / 2
        ? Math.max(0, cx(active) - TOOLTIP_W - 14)
        : Math.min(cx(active) + 14, Math.max(0, width - TOOLTIP_W))

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
              {(show.sales || show.spend) && (
                <text x={padL - 8} y={y + 3} textAnchor="end" fontSize={10} fill="var(--text-muted)">
                  {money(moneyMax * f)}
                </text>
              )}
              {roiAxis && (
                <text x={width - padR + 8} y={y + 3} textAnchor="start" fontSize={10} fill="var(--text-muted)">
                  {fmtRoi(roiLo + (roiHi - roiLo) * f)}
                </text>
              )}
            </g>
          )
        })}

        {/* Target ROI — a reference on the ROI axis, never a business curve. */}
        {show.target && (
          <>
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
          </>
        )}

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
        {show.sales && (
          <polyline fill="none" stroke={SERIES.incremental} strokeWidth={2} strokeLinejoin="round"
            points={path(series.incremental_sales)} />
        )}
        {/* 2 — Trade Spend (left axis) */}
        {show.spend && (
          <polyline fill="none" stroke={SERIES.spend} strokeWidth={2} strokeLinejoin="round"
            points={path(series.trade_spend)} />
        )}
        {/* 3 — ROI (right axis), one run per unbroken stretch */}
        {show.roi &&
          runs.map((r, k) => (
            <polyline key={k} fill="none" stroke={SERIES.roi} strokeWidth={2} strokeLinejoin="round"
              points={r.map((p) => `${cx(p.i)},${yRoi(p.v)}`).join(' ')} />
          ))}

        {active !== null && (
          <>
            {show.sales && (
              <circle cx={cx(active)} cy={yMoney(series.incremental_sales[active])} r={3.5} fill={SERIES.incremental} />
            )}
            {show.spend && (
              <circle cx={cx(active)} cy={yMoney(series.trade_spend[active])} r={3.5} fill={SERIES.spend} />
            )}
            {show.roi && roiAt !== null && <circle cx={cx(active)} cy={yRoi(roiAt)} r={3.5} fill={SERIES.roi} />}
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
          className="pointer-events-none absolute top-2 z-20 rounded-[var(--r-md)] border border-border-default bg-surface-card p-2.5 text-xs shadow-[var(--shadow-lg)]"
          style={{ left: tipLeft, width: TOOLTIP_W }}
        >
          <div className="flex items-center justify-between gap-2 font-bold text-ink-primary">
            <span>
              {periodWord} {calendarYear(labels[active])}
            </span>
            {roiAt !== null && roiAt < targetRoi && (
              <span className="text-[11px] font-semibold text-status-danger">Below target</span>
            )}
          </div>
          {show.sales && <Row swatch={SERIES.incremental} k="Incremental Sales" v={data.display.incremental_sales[active]} />}
          {show.spend && <Row swatch={SERIES.spend} k="Trade Spend" v={data.display.trade_spend[active]} />}
          {show.roi &&
            (roiAt === null ? (
              <div className="mt-1 text-ink-muted">ROI — no promotion / insufficient baseline</div>
            ) : (
              <Row swatch={SERIES.roi} k="ROI" v={fmtRoi(roiAt)} />
            ))}
          {show.target && <Row k="Target ROI" v={fmtRoi(targetRoi)} dashed />}
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
