import { useState } from 'react'
import { useChartWidth } from '../charts/useChartWidth'
import { niceTicks } from './ticks'
import { Segmented } from './shared'
import type { WeekPoint } from '../../types/planner'

/** Week by week: the current plan against the new one.
 *
 *  Two lines over the selection's weeks -- the current plan (what happened)
 *  and the new plan -- with the new plan's P10 and P90 from the Monte Carlo
 *  as dashed bounds either side, and the festival weeks shaded behind. Read
 *  it as "where in the period does the plan earn more, and how sure is it".
 *  "Change" plots the difference itself, for when the two lines sit close.
 *  Hover any week for its figures. */

type Metric = 'profit' | 'revenue' | 'change'

const NOW = 'var(--text-primary)'
const PLAN = 'var(--brand-violet)'
const FESTIVAL = 'var(--status-warning)'
const MONTH = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

export function WeekTrend({
  weeks,
  format,
  planLabel,
}: {
  weeks: WeekPoint[]
  format: (v: number) => string
  /** What the new plan is called on this tab: Scenario, Re-planned, Optimized. */
  planLabel: string
}) {
  const [metric, setMetric] = useState<Metric>('profit')
  const [hover, setHover] = useState<number | null>(null)
  const { ref, width: w } = useChartWidth(720)
  if (!weeks.length) return null

  const series = weeks.map((p) => {
    if (metric === 'revenue') return { now: p.revenue_now, plan: p.revenue_plan, lo: p.revenue_p10, hi: p.revenue_p90 }
    if (metric === 'change') return { now: 0, plan: p.profit_plan - p.profit_now, lo: p.profit_p10 - p.profit_now, hi: p.profit_p90 - p.profit_now }
    return { now: p.profit_now, plan: p.profit_plan, lo: p.profit_p10, hi: p.profit_p90 }
  })
  const hasBand = series.some((s) => Math.abs(s.hi - s.lo) > 0.5)

  const height = 300
  const padL = 76
  const padR = 14
  const padT = 14
  const padB = 44
  const innerW = Math.max(1, w - padL - padR)
  const innerH = height - padT - padB
  const n = weeks.length
  const slot = innerW / n
  const X = (i: number) => padL + slot * i + slot / 2
  const values = series.flatMap((s) => [s.now, s.plan, s.lo, s.hi])
  const lo = Math.min(...values)
  const hi = Math.max(...values)
  const span = hi - lo || Math.abs(hi) || 1
  const yMin = lo - span * 0.08
  const yMax = hi + span * 0.1
  const Y = (v: number) => padT + innerH * (1 - (v - yMin) / (yMax - yMin))
  const ticks = niceTicks(yMin, yMax).filter((t) => t >= yMin && t <= yMax)
  const path = (pick: (s: (typeof series)[number]) => number) => series.map((s, i) => `${i ? 'L' : 'M'} ${X(i)} ${Y(pick(s))}`).join(' ')
  const sign = (v: number) => (metric === 'change' && v > 0 ? '+' : '')
  const fewWeeks = n <= 20
  const h = hover != null ? weeks[hover] : null
  const hs = hover != null ? series[hover] : null
  const festivals = weeks.some((p) => p.festival)

  return (
    <div>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <Segmented
          label="Measure"
          value={metric}
          onChange={setMetric}
          options={[
            { value: 'profit', label: 'Profit' },
            { value: 'revenue', label: 'Revenue' },
            { value: 'change', label: 'Profit change', title: `${planLabel} minus the current plan` },
          ]}
        />
        <div className="flex flex-wrap items-center gap-x-5 gap-y-1 text-[14px] text-ink-secondary">
          <span className="inline-flex items-center gap-1.5">
            <span className="inline-block h-0.5 w-5 rounded" style={{ background: NOW }} /> {metric === 'change' ? 'Current plan (zero line)' : 'Current plan'}
          </span>
          <span className="inline-flex items-center gap-1.5">
            <span className="inline-block h-0.5 w-5 rounded" style={{ background: PLAN }} /> {planLabel}
          </span>
          {hasBand && (
            <span className="inline-flex items-center gap-1.5">
              <span className="inline-block w-5 border-t-2 border-dashed" style={{ borderColor: PLAN, opacity: 0.6 }} /> P10 / P90
            </span>
          )}
          {festivals && (
            <span className="inline-flex items-center gap-1.5">
              <span className="inline-block h-3.5 w-3.5 rounded-[3px]" style={{ background: FESTIVAL, opacity: 0.25 }} /> Festival week
            </span>
          )}
        </div>
      </div>

      <div ref={ref} className="relative mt-3">
        <svg
          viewBox={`0 0 ${w} ${height}`}
          width="100%"
          height={height}
          role="img"
          aria-label={`${metric === 'revenue' ? 'Revenue' : 'Profit'} by week, current plan and ${planLabel.toLowerCase()}`}
          onMouseLeave={() => setHover(null)}
          onMouseMove={(e) => {
            const r = e.currentTarget.getBoundingClientRect()
            const px = ((e.clientX - r.left) / r.width) * w
            const i = Math.floor((px - padL) / slot)
            setHover(i >= 0 && i < n ? i : null)
          }}
        >
          {weeks.map((p, i) =>
            p.festival ? (
              <rect key={`f${p.week}`} x={padL + slot * i} y={padT} width={slot} height={innerH} fill={FESTIVAL} opacity={0.14} />
            ) : null,
          )}
          {ticks.map((t) => (
            <g key={t}>
              <line x1={padL} x2={padL + innerW} y1={Y(t)} y2={Y(t)} stroke="var(--border-subtle)" />
              <text x={padL - 8} y={Y(t) + 4} textAnchor="end" fontSize={13} fill="var(--text-muted)">
                {sign(t)}
                {format(t)}
              </text>
            </g>
          ))}
          <line x1={padL} x2={padL + innerW} y1={padT + innerH} y2={padT + innerH} stroke="var(--border-default)" />

          {hover != null && <line x1={X(hover)} x2={X(hover)} y1={padT} y2={padT + innerH} stroke="var(--text-muted)" strokeDasharray="3 3" />}

          {hasBand && (
            <>
              <path d={path((s) => s.hi)} fill="none" stroke={PLAN} strokeOpacity={0.55} strokeWidth={1.3} strokeDasharray="4 3" />
              <path d={path((s) => s.lo)} fill="none" stroke={PLAN} strokeOpacity={0.55} strokeWidth={1.3} strokeDasharray="4 3" />
            </>
          )}
          <path d={path((s) => s.now)} fill="none" stroke={NOW} strokeWidth={1.8} strokeLinejoin="round" />
          <path d={path((s) => s.plan)} fill="none" stroke={PLAN} strokeWidth={2.2} strokeLinejoin="round" />
          {n === 1 && (
            <>
              <circle cx={X(0)} cy={Y(series[0].now)} r={4} fill={NOW} />
              <circle cx={X(0)} cy={Y(series[0].plan)} r={4} fill={PLAN} />
            </>
          )}
          {hs && hover != null && (
            <>
              <circle cx={X(hover)} cy={Y(hs.now)} r={4} fill="var(--surface-card)" stroke={NOW} strokeWidth={2} />
              <circle cx={X(hover)} cy={Y(hs.plan)} r={4.5} fill={PLAN} stroke="var(--surface-card)" strokeWidth={1.5} />
            </>
          )}

          {weeks.map((p, i) => {
            const monthStart = i === 0 || p.month !== weeks[i - 1].month
            const axisY = padT + innerH + 18
            if (fewWeeks) {
              return (
                <g key={`a${p.week}`}>
                  <text x={X(i)} y={axisY} textAnchor="middle" fontSize={13} fill="var(--text-muted)">
                    {p.week.slice(5)}
                  </text>
                  {monthStart && (
                    <text x={X(i)} y={axisY + 16} textAnchor="middle" fontSize={13} fill="var(--text-secondary)">
                      {MONTH[p.month - 1]}
                    </text>
                  )}
                </g>
              )
            }
            if (!monthStart) return null
            const yearStart = i === 0 || p.week.slice(0, 4) !== weeks[i - 1].week.slice(0, 4)
            return (
              <g key={`a${p.week}`}>
                <line x1={padL + slot * i} x2={padL + slot * i} y1={padT + innerH} y2={padT + innerH + 6} stroke="var(--border-default)" />
                <text x={padL + slot * i + 3} y={axisY} fontSize={13} fill="var(--text-muted)">
                  {MONTH[p.month - 1]}
                  {yearStart ? ` ${p.week.slice(0, 4)}` : ''}
                </text>
              </g>
            )
          })}
        </svg>

        {h && hs && hover != null && (
          <div
            className="pointer-events-none absolute top-2 z-10 min-w-[230px] rounded-[var(--r-md)] border border-border-subtle bg-surface-card px-3 py-2 text-[14px] shadow-[var(--shadow-md)] [font-variant-numeric:tabular-nums]"
            style={{ left: `${Math.min(80, Math.max(20, (X(hover) / w) * 100))}%`, transform: 'translateX(-50%)' }}
          >
            <div className="text-ink-primary">
              {h.week.slice(5)} · {dateText(h.start)}
            </div>
            {h.festival && <div className="text-status-warning">{h.festival}</div>}
            {metric !== 'change' && <TipRow label="Current plan" value={format(hs.now)} dot={NOW} />}
            <TipRow label={planLabel} value={`${sign(hs.plan)}${format(hs.plan)}`} dot={PLAN} />
            {metric !== 'change' && (
              <TipRow
                label="Change"
                value={`${hs.plan - hs.now >= 0 ? '+' : ''}${format(hs.plan - hs.now)}`}
                tone={hs.plan - hs.now >= 0 ? 'text-status-success' : 'text-status-danger'}
              />
            )}
            {hasBand && <TipRow label="P10 – P90" value={`${sign(hs.lo)}${format(hs.lo)} – ${sign(hs.hi)}${format(hs.hi)}`} />}
            <TipRow label="Promotions" value={`${h.promoted_now} → ${h.promoted_plan}`} />
          </div>
        )}
      </div>
    </div>
  )
}

/** "2026-03-02" -> "02 Mar 2026". */
function dateText(iso: string): string {
  const [y, m, d] = iso.split('-')
  return y && m && d ? `${d} ${MONTH[Number(m) - 1]} ${y}` : iso
}

function TipRow({ label, value, dot, tone }: { label: string; value: string; dot?: string; tone?: string }) {
  return (
    <div className="mt-0.5 flex items-center justify-between gap-4">
      <span className="inline-flex items-center gap-1.5 text-ink-secondary">
        {dot && <span className="inline-block h-0.5 w-3 rounded" style={{ background: dot }} />}
        {label}
      </span>
      <span className={tone ?? 'text-ink-primary'}>{value}</span>
    </div>
  )
}
