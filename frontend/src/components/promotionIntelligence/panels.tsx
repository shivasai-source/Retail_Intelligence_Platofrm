import { Card, CardHeader, Pill, Table, Th, Td } from '../ui'
import { Icon, type IconName } from '../../icons'
import { useChartWidth } from '../charts/useChartWidth'
import { fmtRoi, fmtRoiDelta } from '../../lib/roi'
import type {
  AnalysisDriver,
  DimensionRow,
  KeyInsight,
  Recommendation,
  RiskFacts,
  TrendFacts,
} from '../../types/promotionIntelligence'

const CR = 1e7 // 1 crore — the unit Indian trade finance reports in

/** Lakhs only once a lakh has enough resolution to distinguish two rows.
 *
 *  One decimal in lakhs is a 10,000-rupee step. Just above a lakh that is an
 *  8% band, so a By Retailer column of 1.2-1.3 lakh values rendered as an
 *  identical '₹1.2 L' on row after row and the table read as though every
 *  retailer had returned the same incremental sales. They had not — the
 *  figures differed, the formatter hid it.
 *
 *  So the abbreviation starts at 10 lakh, where a decimal is a 0.2% step and
 *  loses nothing. Below that the exact rupee figure is shown, grouped, which
 *  is what Trade Spend was already doing on the same row — that column looked
 *  varied only because its values happened to fall under a lakh.
 */
const L_FLOOR = 1e6 // 10 lakh

export function fmtCr(v: number | null | undefined): string {
  if (v == null) return '—'
  const abs = Math.abs(v)
  if (abs >= CR) return `₹${(v / CR).toFixed(1)} Cr`
  if (abs >= L_FLOOR) return `₹${(v / 1e5).toFixed(1)} L`
  return `₹${Math.round(v).toLocaleString('en-IN')}`
}

export function fmtPct(v: number | null | undefined): string {
  return v == null ? '—' : `${v}%`
}

const STATUS_TONE = {
  on_track: 'success',
  watching: 'warning',
  underperforming: 'danger',
  unknown: 'neutral',
} as const

const STATUS_LABEL = {
  on_track: 'On Track',
  watching: 'Watching',
  underperforming: 'Underperforming',
  unknown: '—',
} as const

/** Reusable table for any dimension breakdown — channel, region, retailer, … */
export function DimensionTable({ title, rows, nameHeader }: { title: string; rows: DimensionRow[]; nameHeader: string }) {
  return (
    <Card className="fade-in">
      <CardHeader title={title} actions={<span className="text-sm text-ink-muted">{rows.length} shown</span>} />
      <div className="overflow-x-auto">
        <Table>
          <thead>
            <tr>
              <Th>{nameHeader}</Th>
              <Th>Trade Spend</Th>
              <Th>Share</Th>
              <Th>Incremental Sales</Th>
              <Th>ROI</Th>
              <Th>vs Target</Th>
              <Th>Status</Th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.name}>
                <Td>{r.name}</Td>
                <Td>{fmtCr(r.trade_spend)}</Td>
                <Td>{fmtPct(r.spend_share_pct)}</Td>
                <Td>{fmtCr(r.incremental_sales)}</Td>
                {/* PLAIN INK, REGULAR WEIGHT. The ROI used to be the one bold
                    cell in the row and both columns were coloured red or
                    green by standing, which on a table where every row is
                    below target painted two solid red columns. The Status
                    pill at the end of the row already says the standing. */}
                <Td>{fmtRoi(r.roi_multiple)}</Td>
                <Td>{fmtRoiDelta(r.vs_target)}</Td>
                <Td>
                  <Pill tone={STATUS_TONE[r.status]}>{STATUS_LABEL[r.status]}</Pill>
                </Td>
              </tr>
            ))}
          </tbody>
        </Table>
      </div>
    </Card>
  )
}

/** Realised incremental sales against the spend-implied target, by month. */
export function TrendVsTarget({ trend, height = 230 }: { trend: TrendFacts; height?: number }) {
  const { ref, width: w } = useChartWidth(560)
  const padL = 52,
    padR = 16,
    padT = 18,
    padB = 34
  const innerW = Math.max(1, w - padL - padR)
  const innerH = Math.max(1, height - padT - padB)

  const vals = [...trend.actual, ...trend.target].filter((v): v is number => v != null)
  if (!vals.length) return <div className="grid h-[180px] place-items-center text-base text-ink-muted">No trend data.</div>
  const maxV = Math.max(...vals) * 1.12
  const n = Math.max(1, trend.labels.length - 1)
  const x = (i: number) => padL + (i / n) * innerW
  const y = (v: number) => padT + innerH * (1 - v / maxV)
  // A null month is a gap, not a zero: the line lifts (M) after every gap
  // rather than bridging it, and a series whose first month is null no
  // longer opens with an "L" -- which is not a path and drew nothing at all.
  const line = (series: (number | null)[]) =>
    series
      .map((v, i) => (v == null ? '' : `${i === 0 || series[i - 1] == null ? 'M' : 'L'} ${x(i)} ${y(v)}`))
      .filter(Boolean)
      .join(' ')

  const ticks = [0, 0.25, 0.5, 0.75, 1].map((f) => maxV * f)

  return (
    <div ref={ref}>
      <svg viewBox={`0 0 ${w} ${height}`} width="100%" height={height}>
        {ticks.map((v) => (
          <g key={v}>
            <line x1={padL} y1={y(v)} x2={padL + innerW} y2={y(v)} stroke="var(--border-subtle)" strokeDasharray="3 4" />
            <text x={padL - 8} y={y(v) + 3} textAnchor="end" fontSize={9.5} fill="var(--text-muted)">
              {fmtCr(v)}
            </text>
          </g>
        ))}
        <path d={line(trend.target)} fill="none" stroke="#9CA3AF" strokeWidth={1.6} strokeDasharray="5 4" />
        <path d={line(trend.actual)} fill="none" stroke="#7C5CFF" strokeWidth={2.4} strokeLinejoin="round" />
        {trend.actual.map((v, i) =>
          v == null ? null : (
            <circle
              key={i}
              cx={x(i)}
              cy={y(v)}
              r={3}
              fill={(trend.gap_to_target[i] ?? 0) < 0 ? '#EF4444' : '#10B981'}
              stroke="white"
              strokeWidth={1.4}
            />
          ),
        )}
        {trend.labels.map((l, i) => (
          <text key={l} x={x(i)} y={padT + innerH + 16} textAnchor="middle" fontSize={9} fill="var(--text-muted)">
            {l.replace(' F', "'")}
          </text>
        ))}
      </svg>
      <div className="mt-1.5 flex flex-wrap items-center gap-4 px-1 text-xs text-ink-muted">
        <span className="inline-flex items-center gap-1.5">
          <span className="inline-block h-0.5 w-4 bg-brand-violet" /> Actual incremental sales
        </span>
        <span className="inline-flex items-center gap-1.5">
          <span className="inline-block h-0.5 w-4 border-t border-dashed border-[#9CA3AF]" /> Target (spend × {fmtRoi(trend.target_roi)})
        </span>
        <span className="font-semibold text-status-danger">{trend.months_below_target} of {trend.labels.length} months below target</span>
      </div>
    </div>
  )
}

const SEVERITY_TONE = {
  critical: 'danger',
  high: 'danger',
  medium: 'warning',
  low: 'neutral',
  positive: 'success',
} as const

export function KeyInsightsGrid({ insights }: { insights: KeyInsight[] }) {
  return (
    <div className="grid grid-cols-2 gap-3.5 @max-[900px]:grid-cols-1">
      {insights.map((k) => (
        <div key={k.title} className="rounded-[var(--r-lg)] border border-border-subtle bg-surface-card p-[14px_16px]">
          <div className="mb-1.5 flex items-start justify-between gap-2">
            <strong className="text-base leading-[1.35]">{k.title}</strong>
            <Pill tone={SEVERITY_TONE[k.severity]}>{k.severity}</Pill>
          </div>
          <p className="text-base leading-[1.55] text-ink-secondary">{k.detail}</p>
          <div className="mt-2 inline-flex items-center gap-1.5 text-sm font-medium text-ink-primary">
            <Icon name={k.trend === 'down' ? 'arrowDown' : k.trend === 'up' ? 'arrowUp' : 'variance'} className="h-3 w-3" />
            {k.impact}
          </div>
        </div>
      ))}
    </div>
  )
}

/** Weighted contribution of each driver — primary causes separated from secondary. */
export function DriversPanel({ drivers }: { drivers: AnalysisDriver[] }) {
  const max = Math.max(1, ...drivers.map((d) => d.weight_pct))
  return (
    <div className="flex flex-col gap-3">
      {drivers.map((d) => (
        <div key={d.driver}>
          <div className="mb-1 flex items-center justify-between gap-3">
            <span className="flex items-center gap-2 text-base font-semibold">
              {d.is_primary && <Pill tone="violet">Primary</Pill>}
              {d.driver}
            </span>
            <span className="shrink-0 text-base font-normal tabular-nums text-ink-primary">{d.weight_pct}%</span>
          </div>
          <div className="h-2 overflow-hidden rounded-[3px] bg-surface-muted">
            <div
              className="h-full rounded-[3px]"
              style={{
                width: `${(d.weight_pct / max) * 100}%`,
                background: d.direction === 'negative' ? 'var(--status-danger)' : 'var(--status-success)',
              }}
            />
          </div>
          <div className="mt-1 text-sm leading-[1.5] text-ink-muted">{d.note}</div>
        </div>
      ))}
    </div>
  )
}

const PRIORITY_TONE = { high: 'danger', medium: 'warning', low: 'neutral' } as const

/** The payoff panel: what to actually do, with parameters Simulation can take. */
export function RecommendationsPanel({
  recommendations,
  doNotDo,
  combined,
  onSimulate,
}: {
  recommendations: Recommendation[]
  doNotDo: string[]
  combined: string | null
  onSimulate: (r: Recommendation) => void
}) {
  return (
    <div className="flex flex-col gap-3.5">
      {recommendations.map((r, i) => (
        <Card key={i} className="fade-in">
          <div className="flex items-start gap-3 p-[16px_18px]">
            <div className="grid h-8 w-8 shrink-0 place-items-center rounded-[9px] bg-brand-violet-50 text-base font-extrabold text-brand-violet">
              {i + 1}
            </div>
            <div className="min-w-0 flex-1">
              <div className="mb-1.5 flex flex-wrap items-center gap-2">
                <strong className="text-base leading-[1.35]">{r.action}</strong>
                <Pill tone={PRIORITY_TONE[r.priority]}>{r.priority} priority</Pill>
                <Pill tone="neutral">{r.effort} effort</Pill>
                <Pill tone="violet">{r.confidence}% confident</Pill>
              </div>
              <p className="text-base leading-[1.55] text-ink-secondary">{r.rationale}</p>

              <div className="mt-2.5 grid grid-cols-2 gap-2.5 @max-[760px]:grid-cols-1">
                <div className="rounded-[var(--r-md)] bg-surface-muted p-[9px_12px]">
                  <div className="text-xs font-bold uppercase tracking-[0.06em] text-ink-muted">Evidence</div>
                  <div className="mt-0.5 text-sm leading-[1.5] text-ink-secondary">{r.evidence}</div>
                </div>
                <div className="rounded-[var(--r-md)] border border-[rgba(16,185,129,0.25)] bg-status-success-bg p-[9px_12px]">
                  <div className="text-xs font-bold uppercase tracking-[0.06em] text-ink-muted">Expected impact</div>
                  <div className="mt-0.5 text-sm leading-[1.5] text-ink-secondary">{r.expected_impact}</div>
                </div>
              </div>

              <div className="mt-2.5 flex flex-wrap items-center justify-between gap-2 rounded-[var(--r-md)] border border-[rgba(124,92,255,0.2)] bg-[linear-gradient(135deg,rgba(124,92,255,0.06),rgba(79,124,255,0.04))] p-[9px_12px]">
                <div className="min-w-0 text-sm leading-[1.5] text-ink-secondary">
                  <span className="font-bold text-ink-primary">Simulate:</span> {r.simulation.lever} ·{' '}
                  <span className="text-ink-muted">{r.simulation.current_value}</span> → {r.simulation.proposed_value}
                  <span className="text-ink-muted"> · watch {r.simulation.metric_to_watch}</span>
                </div>
                <button
                  onClick={() => onSimulate(r)}
                  className="shrink-0 whitespace-nowrap text-base font-semibold text-brand-violet"
                >
                  Open in Simulation →
                </button>
              </div>
            </div>
          </div>
        </Card>
      ))}

      {doNotDo.length > 0 && (
        <Card className="fade-in">
          <CardHeader
            title={
              <span className="flex items-center gap-1.5">
                <Icon name={'shield' as IconName} className="h-4 w-4 text-status-warning" /> What the evidence does not support
              </span>
            }
          />
          <ul className="flex flex-col gap-2 p-[14px_18px]">
            {doNotDo.map((d, i) => (
              <li key={i} className="flex items-start gap-2 text-base leading-[1.55] text-ink-secondary">
                <Icon name="x" className="mt-0.5 h-3.5 w-3.5 shrink-0 text-status-danger" />
                <span>{d}</span>
              </li>
            ))}
          </ul>
        </Card>
      )}

      {combined && (
        <div className="rounded-[var(--r-md)] bg-surface-muted p-[12px_16px] text-base leading-[1.55] text-ink-secondary">
          <span className="font-bold text-ink-primary">Combined effect: </span>
          {combined}
        </div>
      )}
    </div>
  )
}

export function RiskPanel({ risk }: { risk: RiskFacts }) {
  const counts = risk.counts || {}
  const order: [string, string][] = [
    ['critical', 'Critical'],
    ['high', 'High'],
    ['medium', 'Medium'],
    ['target_achieved', 'On target'],
  ]
  return (
    <Card className="fade-in">
      <CardHeader title="Risk Exposure" actions={<Pill tone="danger">{fmtCr(risk.at_stake_total)} at stake (top events)</Pill>} />
      <div className="p-5">
        <div className="mb-4 grid grid-cols-4 gap-2.5 @max-[760px]:grid-cols-2">
          {order.map(([k, label]) => (
            <div key={k} className="rounded-[var(--r-md)] bg-surface-muted p-[10px_12px]">
              <div className="text-sm font-bold text-ink-primary">{label}</div>
              <div className="mt-0.5 text-lg font-normal tabular-nums text-ink-primary">
                {(counts[k] ?? 0).toLocaleString()}
              </div>
            </div>
          ))}
        </div>
        <div className="overflow-x-auto">
          <Table>
            <thead>
              <tr>
                <Th>Alert</Th>
                <Th>Severity</Th>
                <Th>ROI</Th>
                <Th>Trade Spend</Th>
                <Th>At Stake</Th>
              </tr>
            </thead>
            <tbody>
              {risk.top.map((a, i) => (
                <tr key={i}>
                  <Td>{a.title}</Td>
                  <Td>
                    <Pill tone={a.severity?.toLowerCase() === 'critical' ? 'danger' : 'warning'}>{a.severity}</Pill>
                  </Td>
                  <Td className="text-status-danger">{fmtRoi(a.roi_multiple)}</Td>
                  <Td>{fmtCr(a.trade_spend)}</Td>
                  <Td>{fmtCr(a.at_stake)}</Td>
                </tr>
              ))}
            </tbody>
          </Table>
        </div>
      </div>
    </Card>
  )
}
