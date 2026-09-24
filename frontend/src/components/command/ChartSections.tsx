import { useLayoutEffect, useMemo, useRef, useState } from 'react'
import { useBreakdown, useFilterOptions, useTargetRoi, useTopPromotions } from '../../hooks/useCommandCenter'
import { useCommandFilters } from '../../store/commandFilters'
import { ChartFrame } from './ChartFrame'
import { Segmented } from './Segmented'
import { SERIES, SERIES_CLASS } from './series'
import type { BreakdownGroup } from '../../types/commandCenter'
import { BREAKEVEN_ROI, ROI_TONE_CLASS, ROI_TONE_VAR, fmtRoi, roiTone } from '../../lib/roi'

/** The chart sections of the Insights Hub.
 *
 *  Every one takes its SCOPE from the same filter state as the KPI cards,
 *  through the same `useBreakdown` hook. There is no chart-local copy of a
 *  filter and no second serialisation path, so a chart cannot silently describe
 *  a different selection from the cards above it.
 *
 *  Each filter a chart honours is named EXPLICITLY in its query rather than
 *  reached by walking the filter object, so a dimension a chart does not use
 *  cannot leak into its requests — and a chart's cache survives a change to a
 *  filter it never sent.
 *
 *  The only card-local SCOPE on this page is the mechanic on Channel
 *  Performance, which is a chart-level Offer filter rather than a copy of
 *  anything the filter bar holds. The metric switches on the cards are not
 *  scopes: every card fetches its whole population once and re-ranks it in
 *  the browser, so switching the metric is instant and never puts a request
 *  on the wire — see `PERF_METRICS`. */

const SYMBOL = { INR: '₹', USD: '$' } as const

function useDisplay() {
  const currency = useCommandFilters((s) => s.currency)
  return { currency, symbol: SYMBOL[currency] }
}

/** The mechanics the SELECTED SCOPE actually ran, in ascending discount order.
 *
 *  Previously a hardcoded three-entry list of PR001/PR002/PR003. That list is
 *  why the 20% seasonal mechanic could never be selected here: it excluded, by
 *  construction, every mechanic whose discount is not carried in a regular
 *  offer code — the six 2024 seasonal offers that together ARE "20% Discount
 *  (Seasonal)", and the 2025 Buy3Get1.
 *
 *  Now derived from `by=promotion_mechanic`, whose groups carry the
 *  Promotion_Ids behind each mechanic. Selecting one scopes the channel query
 *  through the existing `promotion` list filter, so a mechanic made of six
 *  offers is one selection rather than six.
 *
 *  Sorted by the leading percentage in the mechanic name so the control reads
 *  5 -> 10 -> 15 -> 20; a mechanic with no percentage (Buy3Get1) sorts last. */
function mechanicRank(code: string): number {
  const pct = /^(\d+)%/.exec(code)
  return pct ? Number(pct[1]) : Number.POSITIVE_INFINITY
}

/** "5% Discount (Regular)" -> "5%", "Buy3Get1 (Seasonal)" -> "Buy3Get1". The
 *  header control is narrow, and the full label is in the card's hint. */
function shortMechanic(code: string): string {
  return code.replace(/\s*Discount$/, '')
}

/** The three metrics the ranking and comparison cards switch between. Shared
 *  so every card's control is the same control, in the same order, with the
 *  same labels.
 *
 *  Switching is CLIENT-SIDE. `/breakdown`'s `metric` only sorts and truncates
 *  the groups it returns — each group's figures are the same whichever metric
 *  is asked for — and every card here fetches its whole population (a limit
 *  above the group count), so re-ranking in the browser is the same ranking
 *  the server would return, without a refetch and a skeleton on every click. */
const PERF_METRICS = [
  { key: 'incremental_sales' as const, label: 'Incremental Sales' },
  { key: 'trade_spend' as const, label: 'Trade Spend' },
  { key: 'roi' as const, label: 'ROI' },
]
type PerfMetric = (typeof PERF_METRICS)[number]['key']

function perfLabel(metric: PerfMetric): string {
  return PERF_METRICS.find((m) => m.key === metric)?.label ?? metric
}

function perfValue(g: BreakdownGroup, metric: PerfMetric): number | null {
  return metric === 'trade_spend' ? g.trade_spend : metric === 'roi' ? g.roi : g.incremental_sales
}

function perfDisplay(g: BreakdownGroup, metric: PerfMetric): string {
  if (metric === 'roi') return fmtRoi(g.roi)
  return metric === 'trade_spend' ? g.trade_spend_display : g.incremental_sales_display
}

/** The colour of a metric, so a bar is always the colour of the figure it
 *  draws — the one rule series.ts states — whichever card it sits in. */
function perfFill(metric: PerfMetric): string {
  return metric === 'roi' ? SERIES.roi : metric === 'trade_spend' ? SERIES.spend : SERIES.incremental
}
function perfFillClass(metric: PerfMetric): string {
  return metric === 'roi' ? SERIES_CLASS.roi : metric === 'trade_spend' ? SERIES_CLASS.spend : SERIES_CLASS.incremental
}

/** Groups ranked on a metric, descending, with an undefined value dropped
 *  rather than drawn as zero. ROI breaks ties, then Incremental Sales. */
function rankBy(groups: BreakdownGroup[], metric: PerfMetric): BreakdownGroup[] {
  return [...groups]
    .filter((g) => perfValue(g, metric) !== null)
    .sort(
      (a, b) =>
        (perfValue(b, metric) ?? 0) - (perfValue(a, metric) ?? 0) ||
        (b.roi ?? 0) - (a.roi ?? 0) ||
        (b.incremental_sales ?? 0) - (a.incremental_sales ?? 0),
    )
}

/** The metric selector shared by the cards below. */
function PerfMetricSelect({
  value,
  onChange,
  label,
}: {
  value: PerfMetric
  onChange: (v: PerfMetric) => void
  label: string
}) {
  return <Segmented ariaLabel={label} value={value} onChange={onChange} options={PERF_METRICS} />
}

/** THE RANKED ROW the Channel and Product cards both draw: rank, name, the
 *  selected metric and the ROI beside it, and one bar in the metric's colour
 *  scaled against the leader. One component, so the two cards cannot drift
 *  apart in row height, bar shape or where the ROI sits. */
function MetricRows({
  groups,
  metric,
  targetRoi,
  rowTooltip,
  fill = false,
}: {
  groups: BreakdownGroup[]
  metric: PerfMetric
  /** `meta.target_roi` — what each row's ROI is judged against. */
  targetRoi: number
  rowTooltip: (g: BreakdownGroup) => string
  /** Distribute the rows over a stretched card instead of stacking them at
   *  its top, and grow the bars with it: a 10px bar adrift in a 450px card
   *  reads as a rendering fault. */
  fill?: boolean
}) {
  const peak = groups.length ? Math.abs(perfValue(groups[0], metric) ?? 1) || 1 : 1
  return (
    <div className={`flex flex-col gap-2.5 ${fill ? 'flex-1 justify-between' : ''}`}>
      {groups.map((g, i) => (
        <div key={g.code} className="group" title={rowTooltip(g)}>
          <div className="flex items-baseline justify-between gap-2 text-sm">
            <span className="flex min-w-0 items-baseline gap-1.5">
              <span className="tabular-nums text-ink-muted">{i + 1}</span>
              <span className="truncate font-semibold text-ink-primary">{g.label}</span>
            </span>
            <span className="shrink-0 tabular-nums">
              <span className="font-bold text-ink-primary">{perfDisplay(g, metric)}</span>
              {/* Ranking BY ROI already prints it in the value slot, so the
                  second copy is dropped rather than shown twice. */}
              {metric !== 'roi' && (
                <>
                  {' · '}
                  <span className={ROI_TONE_CLASS[roiTone(g.roi, targetRoi)]}>{fmtRoi(g.roi)}</span>
                </>
              )}
            </span>
          </div>
          <div className={`mt-1 ${fill ? 'h-4' : 'h-2.5'} w-full overflow-hidden rounded-full bg-ink-primary/[0.05]`}>
            <div
              className={`h-full rounded-full transition-[width] duration-300 group-hover:brightness-110 ${perfFillClass(metric)}`}
              style={{
                width: `${Math.max(0, Math.min(100, (Math.abs(perfValue(g, metric) ?? 0) / peak) * 100))}%`,
              }}
            />
          </div>
        </div>
      ))}
    </div>
  )
}

/** M2 · Channel Performance — "which channel performs best at this discount?"
 *
 *  Not a Top-N ranking: every channel the scope contains is shown, ranked on
 *  the metric the switch selects. The discount control is a chart-level Offer
 *  filter that genuinely re-queries `/breakdown`; it does not relabel a fixed
 *  dataset. The metric switch, by contrast, re-ranks in the browser. */
export function ChannelSection() {
  const [picked, setPicked] = useState<string | null>(null)
  const [metric, setMetric] = useState<PerfMetric>('incremental_sales')

  // Which mechanics the current Year holds, and the offers behind each.
  const mechanics = useBreakdown('promotion_mechanic', { limit: 50 })
  const levels = useMemo(
    () =>
      (mechanics.data?.groups ?? [])
        .filter((g) => (g.members?.length ?? 0) > 0)
        .map((g) => ({ code: g.code, label: g.label, promotions: g.members ?? [] }))
        .sort((a, b) => mechanicRank(a.code) - mechanicRank(b.code)),
    [mechanics.data],
  )
  // A mechanic the newly-selected year did not run falls back to the first one
  // available, so the card never sits on an empty selection.
  const level = levels.find((l) => l.code === picked) ?? levels[0]

  // Year is the Insights Hub's only global filter, so the mechanic is the
  // sole extra scope this card applies. limit 20 comfortably exceeds the five
  // channels, so nothing is truncated.
  //
  // Held while the mechanic list is PLACEHOLDER data. Without that, a year
  // switch fires this query against the previous year's offer ids — 2024 scope
  // carrying the six 2025 seasonal codes — because the mechanic query still
  // serves last year's groups until its own refetch lands. It self-corrected a
  // moment later, but it put one cross-year request on the wire, which is
  // exactly what the Year filter must never do.
  const q = useBreakdown('channel', {
    limit: 20,
    promotion: level?.promotions,
    enabled: Boolean(level) && !mechanics.isPlaceholderData,
  })
  const data = q.data
  const targetRoi = useTargetRoi(data?.meta)
  const rows = useMemo(() => rankBy(data?.groups ?? [], metric), [data, metric])

  return (
    <ChartFrame
      fill
      title="Channel Performance"
      hint={`Compares channel-level promotion performance at the selected promotion mechanic, ranked on the selected metric. Currently showing ${level?.label ?? '—'}.`}
      actions={
        <div className="inline-flex items-center gap-1.5 text-xs text-ink-muted">
          <span>Mechanic</span>
          <Segmented
            ariaLabel="Promotion mechanic"
            value={level?.code ?? ''}
            onChange={setPicked}
            options={levels.map((d) => ({ key: d.code, label: shortMechanic(d.code), title: d.label }))}
          />
        </div>
      }
      controls={<PerfMetricSelect value={metric} onChange={setMetric} label="Channel metric" />}
      isLoading={q.isLoading || mechanics.isLoading}
      isFetching={q.isFetching || mechanics.isFetching}
      error={q.error ?? mechanics.error}
      onRetry={() => {
        void mechanics.refetch()
        void q.refetch()
      }}
      isEmpty={rows.length === 0}
      emptyMessage={`No ${level?.label ?? 'promotion'} activity in this scope.`}
      footnote={`Ranked by ${perfLabel(metric)}. Channels are compared, not summed.`}
    >
      <MetricRows
        fill
        groups={rows}
        metric={metric}
        targetRoi={targetRoi}
        rowTooltip={(g) =>
          [
            g.label,
            `Mechanic: ${level?.label ?? '—'}`,
            '',
            `Incremental Sales: ${g.incremental_sales_display}`,
            `Trade Spend: ${g.trade_spend_display}`,
            `ROI: ${fmtRoi(g.roi)}`,
          ].join('\n')
        }
      />
    </ChartFrame>
  )
}

/** M4 · Top Performing Promotions.
 *
 *  The positive counterpart to the Underperforming table, at the same
 *  promotion EVENT grain (promotion x product x channel x week).
 *
 *  RANKING is ROI descending — but a raw ROI ranking is useless here, and the
 *  reason is structural rather than a data artefact. With the approved
 *  economics, ROI = u(1-d) / ((1+u)(d+c)), so the shallowest discount
 *  always wins: PR001 invests 8% of base revenue and returns ~1.8, while the
 *  seasonal mechanics invest 23-28% and return ~1.3. Ranked naively, all ten
 *  rows are "5% Discount" at every spend threshold. Three guards fix that
 *  without touching a single number:
 *
 *  1. MEANINGFUL IMPACT — drop events below the MEDIAN Trade Spend of the
 *     eligible population. Computed from the data on every render, never a
 *     hardcoded rupee figure, so it follows the year filter and the currency.
 *  2. DEDUPE on promotion + channel + period, keeping the best ROI. Without it
 *     three rows of "5% Discount · B2B · 2025-W14" (different products) read as
 *     three findings when they are one.
 *  3. DIVERSITY — a HARD cap of two rows per MECHANIC (5%/10%/15% Discount,
 *     20% Discount seasonal, Buy3Get1 seasonal). Capping by promotion NAME was
 *     not enough: the six seasonal events of one year are six different names
 *     but ONE mechanic. The cap is not relaxed to reach ten — doing so simply
 *     returned the spare slots to 5% Discount, which is what put four of it in
 *     a ten-row list. It never promotes a lower-ROI event ahead of a
 *     higher-ROI one; it only removes the surplus.
 *
 *  EXCLUSIONS: the endpoint already drops events with an undefined ROI, and
 *  because `roi_multiple` is null exactly when Trade Spend is zero, that is also
 *  the zero-spend filter. A sub-1.0 ROI is kept as-is and simply loses.
 */
const TOP_N = 10

/** A HARD maximum of rows any one mechanic may occupy. Not a soft preference:
 *  spare slots are left empty rather than handed back to a mechanic already at
 *  the cap, which is what previously filled four of ten rows with 5% Discount. */
const PER_MECHANIC_CAP = 2

/** Promotion display name -> mechanic label, built from the API rather than
 *  from any list held here.
 *
 *  `/breakdown?by=promotion_mechanic` returns each mechanic's label and the
 *  Promotion_Ids behind it; `/breakdown?by=promotion` maps those ids to the
 *  display names the top-promotions endpoint uses. Joining the two gives the
 *  mechanic for every event, scoped to the selected year, with no mechanic
 *  list, year map or Promotion_Id literal in the frontend.
 *
 *  This replaces a hardcoded {'2024': '20% Discount (Seasonal)', '2025':
 *  'Buy3Get1 (Seasonal)'} map. That map was the reason the 20% seasonal
 *  mechanic could not be shown on a row and, for any period outside those two
 *  years, collapsed every seasonal mechanic into one generic "Seasonal"
 *  bucket — which silently shares a single cap between mechanics that are not
 *  the same mechanic. */
function useMechanicByPromotion(): Map<string, string> {
  const mechanics = useBreakdown('promotion_mechanic', { limit: 50 })
  const offers = useBreakdown('promotion', { limit: 50 })

  return useMemo(() => {
    const nameOfOffer = new Map((offers.data?.groups ?? []).map((g) => [g.code, g.label]))
    const map = new Map<string, string>()
    for (const mechanic of mechanics.data?.groups ?? []) {
      for (const code of mechanic.members ?? []) {
        const name = nameOfOffer.get(code)
        if (name) map.set(name, mechanic.label)
      }
    }
    return map
  }, [mechanics.data, offers.data])
}

/** The mechanic one event belongs to. Falls back to the event's own name so an
 *  unmapped promotion occupies its OWN cap rather than being merged into a
 *  shared bucket with unrelated mechanics. */
function promotionMechanic(row: { promotion: string }, byPromotion: Map<string, string>): string {
  return byPromotion.get(row.promotion) ?? row.promotion
}

/** The whole eligible population, because the threshold is its MEDIAN: any
 *  prefix of an ROI-sorted list is biased towards small spends and would put
 *  the median in the wrong place. */
const TOP_FETCH_LIMIT = 100000

export function TopPerformingSection() {
  const q = useTopPromotions(TOP_FETCH_LIMIT)
  const targetRoi = useTargetRoi(q.data?.meta)
  const mechanicByPromotion = useMechanicByPromotion()

  const rows = useMemo(() => {
    const eligible = (q.data?.rows ?? []).filter(
      (r) => r.roi_multiple !== null && Number.isFinite(r.roi_multiple) && r.trade_spend > 0,
    )
    if (!eligible.length) return []

    const spends = eligible.map((r) => r.trade_spend).sort((a, b) => a - b)
    const mid = spends.length >> 1
    const median = spends.length % 2 ? spends[mid] : (spends[mid - 1] + spends[mid]) / 2

    const ranked = eligible
      .filter((r) => r.trade_spend >= median)
      .sort((a, b) => b.roi_multiple - a.roi_multiple || b.trade_spend - a.trade_spend)

    const seen = new Set<string>()
    const deduped = ranked.filter((r) => {
      const k = `${r.promotion}|${r.channel}|${r.period}`
      if (seen.has(k)) return false
      seen.add(k)
      return true
    })

    // The cap is never relaxed. A single year runs four mechanics, so a year
    // scope yields eight rows and All Years ten; a SHORTER, honest list beats
    // handing the spare slots back to the mechanic that already dominates.
    const used = new Map<string, number>()
    const picked: (typeof deduped[number] & { mechanic: string })[] = []
    for (const r of deduped) {
      const m = promotionMechanic(r, mechanicByPromotion)
      const n = used.get(m) ?? 0
      if (n >= PER_MECHANIC_CAP) continue
      used.set(m, n + 1)
      picked.push({ ...r, mechanic: m })
      if (picked.length >= TOP_N) break
    }
    return picked
  }, [q.data, mechanicByPromotion])

  return (
    <ChartFrame
      fill
      title="Top Performing Promotions"
      hint="Top performing promotions ranked by ROI among meaningful-impact promotions, each placed against the target ROI."
      isLoading={q.isLoading}
      isFetching={q.isFetching}
      error={q.error}
      onRetry={() => void q.refetch()}
      isEmpty={rows.length === 0}
      emptyMessage="No promotion with a measurable return in this scope."
      height={230}
      footnote={`${rows.length} promotions ranked by ROI, among those at or above median Trade Spend. At most ${PER_MECHANIC_CAP} per mechanic.`}
    >
      <RoiDotPlot rows={rows} targetRoi={targetRoi} />
    </ChartFrame>
  )
}

/** A step for an ROI axis over `range`: multiples read in tenths and
 *  quarters, so the money ladder's 1.5/2.5/6/7.5 steps would put ticks at 1.6
 *  and 2.2. The finest step that keeps the axis to six divisions or fewer, so
 *  a 1.0-3.05 spread gets 0.5s rather than a whole-number step that would
 *  run the axis out to 4.0 for nothing. */
function roiNiceStep(range: number): number {
  const ladder = [0.05, 0.1, 0.2, 0.25, 0.5, 1, 2]
  return ladder.find((c) => range / c <= 6) ?? 5
}

/** THE TOP PROMOTIONS AS DOTS ON ONE ROI AXIS, against the target.
 *
 *  A ranked bar said only "this one is longer". The question this card
 *  answers is "how far above the target is each of these?", and that is a
 *  position against a line, not a length from zero — so each event is a dot
 *  on a shared ROI axis with the target drawn as a dashed line and break-even
 *  as a solid one. The dot wears the same tone the ROI figure wears everywhere
 *  on the page (green at or above target, ink above break-even, red below),
 *  so the two never disagree. */
function RoiDotPlot({
  rows,
  targetRoi,
}: {
  rows: {
    promotion: string
    channel: string
    period: string
    roi_multiple: number
    roi_display: string
    trade_spend_display: string
    incremental_sales_display: string
  }[]
  targetRoi: number
}) {
  const { ref, width, height } = useChartSize(560, 260)
  const [hover, setHover] = useState<number | null>(null)

  const n = rows.length
  // The name column takes what it needs up to ~40% of the card; the rest is
  // the axis. Below 150px the names would be unreadable stubs.
  const labelW = Math.round(Math.min(270, Math.max(150, width * 0.4)))
  const padL = labelW + 10
  const padR = 48 // the value label to the right of the last dot
  const padT = 18 // the "Target" caption above the line
  const padB = 22 // the tick labels
  const innerW = Math.max(120, width - padL - padR)
  const innerH = Math.max(n * 18, height - padT - padB)
  const rowH = innerH / n

  const rois = rows.map((r) => r.roi_multiple)
  const rawLo = Math.min(BREAKEVEN_ROI, targetRoi, ...rois)
  const rawHi = Math.max(targetRoi, ...rois)
  const step = roiNiceStep(rawHi - rawLo)
  const lo = Math.floor(rawLo / step + 1e-9) * step
  let hi = Math.ceil(rawHi / step - 1e-9) * step
  if (hi <= rawHi) hi += step
  const x = (v: number) => padL + ((v - lo) / (hi - lo || 1)) * innerW
  const y = (i: number) => padT + rowH * (i + 0.5)

  const ticks: number[] = []
  for (let t = lo; t <= hi + 1e-6; t += step) ticks.push(Math.round(t * 1000) / 1000)

  // Name column: rank, name in bold, channel in muted ink, cut to fit. The
  // channel goes first when space runs out — two "5% Discount" rows are told
  // apart by it, so it is only dropped when the name itself does not fit.
  const chars = Math.max(6, Math.floor((labelW - 18) / 6.3))
  const fitName = (r: (typeof rows)[number]) => {
    if (r.promotion.length + 3 + r.channel.length <= chars) return { name: r.promotion, channel: r.channel }
    if (r.promotion.length + 4 <= chars)
      return { name: r.promotion, channel: fitLabel(r.channel, (chars - r.promotion.length - 3) * 6.3) }
    return { name: fitLabel(r.promotion, chars * 6.3), channel: '' }
  }

  const active = hover !== null && hover < n ? hover : null

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div ref={ref} className="relative min-h-[200px] w-full flex-1">
        <svg className="absolute inset-0" width={width} height={height} role="img" aria-label="Top promotions by ROI against the target">
          {/* Vertical hairline grid at each tick, ticks in the axis band. */}
          {ticks.map((t) => (
            <g key={t}>
              <line x1={x(t)} x2={x(t)} y1={padT} y2={padT + innerH} stroke="var(--border-subtle)" />
              <text x={x(t)} y={height - 6} textAnchor="middle" fontSize={10} fill="var(--text-muted)">
                {fmtRoi(t)}
              </text>
            </g>
          ))}

          {/* Break-even, solid; the target, dashed and captioned. */}
          {lo < BREAKEVEN_ROI && (
            <line x1={x(BREAKEVEN_ROI)} x2={x(BREAKEVEN_ROI)} y1={padT} y2={padT + innerH} stroke="var(--border-strong)" />
          )}
          <line
            x1={x(targetRoi)}
            x2={x(targetRoi)}
            y1={padT - 4}
            y2={padT + innerH}
            stroke="var(--brand-violet)"
            strokeDasharray="3 3"
          />
          <text x={x(targetRoi)} y={padT - 8} textAnchor="middle" fontSize={10} fontWeight={600} fill="var(--brand-violet)">
            Target {fmtRoi(targetRoi)}
          </text>

          {rows.map((r, i) => {
            const cy = y(i)
            const cx = x(r.roi_multiple)
            const tone = roiTone(r.roi_multiple, targetRoi)
            const { name, channel } = fitName(r)
            const isActive = active === i
            return (
              <g key={`${r.promotion}-${r.channel}-${r.period}-${i}`}>
                <rect
                  x={0}
                  y={cy - rowH / 2 + 1}
                  width={width}
                  height={Math.max(0, rowH - 2)}
                  rx={6}
                  fill="var(--surface-hover)"
                  opacity={isActive ? 1 : 0}
                  className="transition-opacity duration-150"
                />
                <text x={6} y={cy + 4} fontSize={11} fill="var(--text-primary)">
                  <tspan fill="var(--text-disabled)">{i + 1}</tspan>
                  <tspan dx={6} fontWeight={600}>
                    {name}
                  </tspan>
                  {channel && <tspan fill="var(--text-muted)">{` · ${channel}`}</tspan>}
                </text>
                {/* The row's own track, from the axis start to the dot, so the
                    eye is led to the dot without a bar's weight. */}
                <line x1={padL} x2={cx} y1={cy} y2={cy} stroke="var(--border-default)" strokeDasharray="1 3" />
                <circle
                  cx={cx}
                  cy={cy}
                  r={isActive ? 7 : 6}
                  fill={ROI_TONE_VAR[tone]}
                  stroke="var(--surface-card)"
                  strokeWidth={2}
                  className="transition-[r] duration-150"
                />
                <text x={cx + 11} y={cy + 4} fontSize={10} fontWeight={700} fill={ROI_TONE_VAR[tone]}>
                  {r.roi_display}
                </text>
                <rect
                  x={0}
                  y={cy - rowH / 2}
                  width={width}
                  height={rowH}
                  fill="transparent"
                  onMouseEnter={() => setHover(i)}
                  onMouseLeave={() => setHover(null)}
                />
              </g>
            )
          })}
        </svg>

        {/* Pinned to a corner of the axis area — the bottom-right while the
            hovered row is in the top half, the top-right otherwise — so it
            never covers the names or the row it describes. */}
        {active !== null && (
          <div
            className="pointer-events-none absolute right-0 z-20 w-52 rounded-[var(--r-md)] border border-border-default bg-surface-card p-2.5 text-xs shadow-[var(--shadow-lg)]"
            style={y(active) < padT + innerH / 2 ? { bottom: padB } : { top: padT }}
          >
            <div className="font-bold text-ink-primary">{rows[active].promotion}</div>
            <div className="text-ink-muted">
              {rows[active].channel} · {rows[active].period}
            </div>
            <TipRow swatch={ROI_TONE_VAR[roiTone(rows[active].roi_multiple, targetRoi)]} k="ROI" v={rows[active].roi_display} />
            <TipRow k="Trade Spend" v={rows[active].trade_spend_display} />
            <TipRow k="Incremental Sales" v={rows[active].incremental_sales_display} />
          </div>
        )}
      </div>

      <ul className="sr-only">
        {rows.map((r, i) => (
          <li key={`${r.promotion}-${r.channel}-${r.period}-${i}`}>
            {i + 1}. {r.promotion}, {r.channel}, {r.period}: ROI {r.roi_display} against a target of {fmtRoi(targetRoi)}; Trade Spend{' '}
            {r.trade_spend_display}; Incremental Sales {r.incremental_sales_display}
          </li>
        ))}
      </ul>
    </div>
  )
}


/** N1 · Promotion Contribution — what each promotion MECHANIC cost and what
 *  it returned, on one money axis.
 *
 *  Mechanic, not offer: `by=promotion_mechanic` groups on
 *  dim_promotion.Promotion_Name, so the six seasonal offers of a year collapse
 *  into the single mechanic they all run ("20% Discount" in 2024, "Buy3Get1"
 *  in 2025). The mechanics a year did not run simply do not appear.
 *
 *  It USED TO BE a ranked bar of one metric with a share beside it — which
 *  was the Promotion Mix donut on the same page, drawn a second time: the
 *  same `promotion_mechanic` groups, the same two metrics, the same shares.
 *  What the donut cannot show is the GAP between what a mechanic cost and
 *  what it brought in, so this card now draws exactly that: a dumbbell per
 *  mechanic from Trade Spend to Incremental Sales, both on one rupee axis,
 *  with the ROI at the end of the row. Both metrics are on screen at once,
 *  so the card needs no metric switch.
 *
 *  The share still rides on the Incremental Sales label. It is real for this
 *  dimension — every mechanic is measured against the same non-promoted rows,
 *  so the mechanics reconcile to the headline KPI exactly (verified to
 *  0.0000% on both metrics, both years and All Years). */
export function PromotionContributionSection() {
  const { symbol } = useDisplay()
  const q = useBreakdown('promotion_mechanic', { limit: 50 })
  const targetRoi = useTargetRoi(q.data?.meta)

  const { rows, total } = useMemo(() => {
    const ordered = rankBy(q.data?.groups ?? [], 'incremental_sales')
    return { rows: ordered, total: ordered.reduce((sum, g) => sum + (g.incremental_sales ?? 0), 0) }
  }, [q.data])

  return (
    <ChartFrame
      fill
      title="Promotion Contribution"
      hint="What each promotion mechanic cost in Trade Spend and what it returned in Incremental Sales, on one axis, with its ROI. The share is of the scope's total Incremental Sales."
      isLoading={q.isLoading}
      isFetching={q.isFetching}
      error={q.error}
      onRetry={() => void q.refetch()}
      isEmpty={rows.length === 0}
      emptyMessage="No promotion mechanics ran in this scope."
      footnote={`${rows.length} mechanics ranked by Incremental Sales · shares total 100% of the scope.`}
    >
      {q.data && (
        <Dumbbell groups={rows} total={total} rate={q.data.meta.exchange_rate} symbol={symbol} targetRoi={targetRoi} />
      )}
    </ChartFrame>
  )
}

/** Abbreviated money for an axis tick, in the display currency. Synthetic
 *  values only; every figure that names a group is the backend's own string. */
function tickMoney(v: number, rate: number, symbol: string): string {
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

/** One row per group: a dot at Trade Spend, a dot at Incremental Sales, and
 *  the line between them — the return — on one shared money axis. The dots
 *  wear the page's series colours (orange spend, violet sales), the ROI sits
 *  at the row's end in its tone. */
function Dumbbell({
  groups,
  total,
  rate,
  symbol,
  targetRoi,
}: {
  groups: BreakdownGroup[]
  /** Incremental Sales summed, for the share on each label. */
  total: number
  rate: number
  symbol: string
  targetRoi: number
}) {
  const { ref, width, height } = useChartSize(560, 260)
  const [hover, setHover] = useState<number | null>(null)

  const n = groups.length
  const labelW = Math.round(Math.min(190, Math.max(110, width * 0.3)))
  const padL = labelW + 10
  const padR = 52 // the ROI column
  const padT = 8
  const padB = 22
  const innerW = Math.max(120, width - padL - padR)
  const innerH = Math.max(n * 40, height - padT - padB)
  const rowH = innerH / n

  const values = groups.flatMap((g) => [g.trade_spend, g.incremental_sales ?? 0])
  const rawMax = Math.max(1, ...values)
  const rawMin = Math.min(0, ...values)
  const step = columnNiceStep((rawMax - rawMin) / COLUMN_DIVISIONS)
  const lo = rawMin < 0 ? Math.floor(rawMin / step) * step : 0
  let hi = lo + step * COLUMN_DIVISIONS
  while (hi < rawMax) hi += step
  // Room for the label centred on the right-most dot.
  if (((hi - rawMax) / (hi - lo)) * innerW < 34) hi += step
  const x = (v: number) => padL + ((v - lo) / (hi - lo || 1)) * innerW
  const y = (i: number) => padT + rowH * (i + 0.5)

  const ticks: number[] = []
  for (let t = lo; t <= hi + 1e-6; t += step) ticks.push(t)

  const active = hover !== null && hover < n ? hover : null

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {/* Two series, so a legend — the dots are told apart by colour, and
          colour is never the only cue in the tooltip alone. */}
      <div className="mb-1 flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-ink-muted">
        <span className="inline-flex items-center gap-1.5">
          <span className="h-2.5 w-2.5 rounded-full" style={{ background: SERIES.spend }} />
          Trade Spend
        </span>
        <span className="inline-flex items-center gap-1.5">
          <span className="h-2.5 w-2.5 rounded-full" style={{ background: SERIES.incremental }} />
          Incremental Sales · share
        </span>
        <span className="ml-auto">ROI at the row end</span>
      </div>

      <div ref={ref} className="relative min-h-[200px] w-full flex-1">
        <svg className="absolute inset-0" width={width} height={height} role="img" aria-label="Trade Spend and Incremental Sales by promotion mechanic">
          {ticks.map((t) => (
            <g key={t}>
              <line
                x1={x(t)}
                x2={x(t)}
                y1={padT}
                y2={padT + innerH}
                stroke={t === lo ? 'var(--border-default)' : 'var(--border-subtle)'}
              />
              <text x={x(t)} y={height - 6} textAnchor="middle" fontSize={10} fill="var(--text-muted)">
                {tickMoney(t, rate, symbol)}
              </text>
            </g>
          ))}

          {groups.map((g, i) => {
            const cy = y(i)
            const xs = x(g.trade_spend)
            const sales = g.incremental_sales
            const xi = sales === null ? null : x(sales)
            const share = total && sales !== null ? (sales / total) * 100 : null
            const isActive = active === i
            const tone = roiTone(g.roi, targetRoi)
            return (
              <g key={g.code}>
                <rect
                  x={0}
                  y={cy - rowH / 2 + 1}
                  width={width}
                  height={Math.max(0, rowH - 2)}
                  rx={6}
                  fill="var(--surface-hover)"
                  opacity={isActive ? 1 : 0}
                  className="transition-opacity duration-150"
                />
                <text x={6} y={cy + 4} fontSize={11} fontWeight={600} fill="var(--text-primary)">
                  {fitLabel(g.label, labelW - 8)}
                </text>

                {/* The return: the line from what it cost to what it made. */}
                {xi !== null && (
                  <line
                    x1={xs}
                    x2={xi}
                    y1={cy}
                    y2={cy}
                    stroke="color-mix(in srgb, var(--text-primary) 28%, transparent)"
                    strokeWidth={2}
                    strokeLinecap="round"
                  />
                )}
                <circle cx={xs} cy={cy} r={6} fill={SERIES.spend} stroke="var(--surface-card)" strokeWidth={2} />
                <text x={xs} y={cy + 17} textAnchor="middle" fontSize={10} fill="var(--text-muted)">
                  {g.trade_spend_display}
                </text>
                {xi !== null && (
                  <>
                    <circle cx={xi} cy={cy} r={6} fill={SERIES.incremental} stroke="var(--surface-card)" strokeWidth={2} />
                    <text x={xi} y={cy - 10} textAnchor="middle" fontSize={10} fontWeight={700} fill="var(--text-primary)">
                      {g.incremental_sales_display}
                      {share !== null && (
                        <tspan fontWeight={400} fill="var(--text-muted)">{` · ${share.toFixed(2)}%`}</tspan>
                      )}
                    </text>
                  </>
                )}

                <text x={padL + innerW + 12} y={cy + 4} fontSize={11} fontWeight={700} fill={ROI_TONE_VAR[tone]}>
                  {fmtRoi(g.roi)}
                </text>

                <rect
                  x={0}
                  y={cy - rowH / 2}
                  width={width}
                  height={rowH}
                  fill="transparent"
                  onMouseEnter={() => setHover(i)}
                  onMouseLeave={() => setHover(null)}
                />
              </g>
            )
          })}
        </svg>

        {/* No tooltip: spend, sales, share and ROI are all printed on the
            row itself, so a hover has nothing left to add. */}
      </div>

      <ul className="sr-only">
        {groups.map((g) => (
          <li key={g.code}>
            {g.label}: Trade Spend {g.trade_spend_display}, Incremental Sales{' '}
            {g.incremental_sales === null ? 'not measurable' : g.incremental_sales_display}, ROI {fmtRoi(g.roi)}
          </li>
        ))}
      </ul>
    </div>
  )
}

/** N2 · Regular vs Seasonal Performance — the two promotion types side by side.
 *
 *  A COMPARISON of two groups, not a ranking of many, so it is drawn as two
 *  aligned columns on one shared scale: the columns are directly comparable in
 *  height because they share a maximum, which a pair of independently-scaled
 *  bars would not be.
 *
 *  The share is real. Promotion type is an offer dimension, so both groups are
 *  measured against the same non-promoted rows and the two add back to the
 *  headline KPI exactly (verified to 0.0000% on Incremental Sales and Trade
 *  Spend, both years and All Years).
 *
 *  ROI CARRIES NO SHARE. It is a ratio, not a quantity: "Regular is 89% of the
 *  combined ROI" would be an arithmetic accident, not a fact about the
 *  business. For ROI the card states the gap as a difference in multiples. */
export function PromotionTypeSection() {
  const [metric, setMetric] = useState<PerfMetric>('incremental_sales')
  const { symbol } = useDisplay()
  const q = useBreakdown('promotion_type', { limit: 50 })
  const targetRoi = useTargetRoi(q.data?.meta)

  const groups = useMemo(() => {
    const rows = [...(q.data?.groups ?? [])]
    // Regular first, always — the card is a fixed comparison, so the two rows
    // must not swap places when the ranking metric changes.
    return rows.sort((a, b) => (a.code === 'Regular' ? -1 : b.code === 'Regular' ? 1 : 0))
  }, [q.data])

  const isShareable = metric !== 'roi'
  const total = isShareable
    ? groups.reduce((sum, g) => sum + (perfValue(g, metric) ?? 0), 0)
    : null

  const [lead, trail] = rankBy(groups, metric)
  const gapPts =
    lead && trail ? (perfValue(lead, metric) ?? 0) - (perfValue(trail, metric) ?? 0) : null

  return (
    <ChartFrame
      fill
      title="Regular vs Seasonal Performance"
      hint="Compares regular and seasonal promotion contribution and return on the selected metric."
      controls={
        <PerfMetricSelect value={metric} onChange={setMetric} label="Comparison metric" />
      }
      isLoading={q.isLoading}
      isFetching={q.isFetching}
      error={q.error}
      onRetry={() => void q.refetch()}
      isEmpty={groups.length === 0}
      emptyMessage="No promotions in this scope."
      footnote={
        isShareable
          ? `Share of ${perfLabel(metric)}; the two types total 100% of the scope.`
          : gapPts !== null && lead
            ? `ROI is a ratio, so it carries no share — ${lead.code} leads by ${gapPts.toFixed(2)}.`
            : 'ROI is a ratio, so it carries no share.'
      }
    >
      {q.data && (
        <MetricColumns
          groups={groups}
          metric={metric}
          total={total}
          rate={q.data.meta.exchange_rate}
          symbol={symbol}
          targetRoi={targetRoi}
          noun="type"
        />
      )}
    </ChartFrame>
  )
}

/** N3 · Product Performance — the top ten SKUs on the selected metric.
 *
 *  A TABLE, because ten products carry three figures each and a bar of one
 *  metric hid the other two in a tooltip. Every row shows Incremental Sales,
 *  Trade Spend and ROI side by side, each with a thin in-cell bar scaled to
 *  its own column, so a SKU that leads on spend and trails on return is
 *  visible in one glance rather than one hover. The switch picks the column
 *  the table is RANKED on; it is highlighted so the order is never a mystery.
 *
 *  A RANKING, never a composition: Incremental Sales is re-baselined per
 *  selection, so ten of thirty-six products do not sum to anything meaningful
 *  and no share is shown. */
const PRODUCT_ROWS = 10

export function ProductSection() {
  const [metric, setMetric] = useState<PerfMetric>('incremental_sales')
  // The full population, so the ranking below chooses from all 36 products
  // rather than from a head the server already cut at ten.
  const q = useBreakdown('product', { limit: 50 })
  const targetRoi = useTargetRoi(q.data?.meta)

  const rows = useMemo(() => rankBy(q.data?.groups ?? [], metric).slice(0, PRODUCT_ROWS), [q.data, metric])
  const total = q.data?.total_groups ?? rows.length

  return (
    <ChartFrame
      title="Product Performance"
      hint="Top 10 products with Incremental Sales, Trade Spend and ROI side by side, ranked by the selected metric."
      controls={
        <div className="inline-flex items-center gap-1.5 text-xs text-ink-muted">
          <span>Rank by</span>
          <PerfMetricSelect value={metric} onChange={setMetric} label="Performance metric" />
        </div>
      }
      isLoading={q.isLoading}
      isFetching={q.isFetching}
      error={q.error}
      onRetry={() => void q.refetch()}
      isEmpty={rows.length === 0}
      emptyMessage="No products with measurable performance in this scope."
      footnote={`Top ${rows.length} of ${total} products by ${perfLabel(metric)}. ROI breaks ties. A ranking, not a share of the total.`}
    >
      <MetricTable rows={rows} metric={metric} targetRoi={targetRoi} />
    </ChartFrame>
  )
}

/** The three-figure table. Each numeric cell is the backend's display string
 *  over a thin bar scaled against the column's own leader — a bar table, so
 *  the numbers align like a table and still read at a glance like a chart. */
function MetricTable({
  rows,
  metric,
  targetRoi,
}: {
  rows: BreakdownGroup[]
  metric: PerfMetric
  targetRoi: number
}) {
  const peak = (m: PerfMetric) => Math.max(1e-9, ...rows.map((g) => Math.abs(perfValue(g, m) ?? 0)))
  const peaks = { incremental_sales: peak('incremental_sales'), trade_spend: peak('trade_spend'), roi: 1 }
  const pct = (g: BreakdownGroup, m: PerfMetric) =>
    `${Math.max(0, Math.min(100, (Math.abs(perfValue(g, m) ?? 0) / peaks[m]) * 100))}%`

  // ROI gets no bar: a ratio drawn from zero is all but full on every row
  // (1.53 against 1.59), and its tone already says what matters — where it
  // stands against the target.
  const cell = (g: BreakdownGroup, m: PerfMetric) => {
    const ranked = m === metric
    if (m === 'roi') {
      return <div className={`text-right text-sm tabular-nums ${ROI_TONE_CLASS[roiTone(g.roi, targetRoi)]}`}>{fmtRoi(g.roi)}</div>
    }
    return (
      <div className="min-w-0">
        <div className={`text-right text-sm tabular-nums ${ranked ? 'font-bold text-ink-primary' : 'text-ink-secondary'}`}>
          {perfDisplay(g, m)}
        </div>
        <div className="mt-1 h-1.5 w-full overflow-hidden rounded-full bg-ink-primary/[0.05]">
          <div
            className={`h-full rounded-full transition-[width] duration-300 ${perfFillClass(m)} ${ranked ? '' : 'opacity-45'}`}
            style={{ width: pct(g, m) }}
          />
        </div>
      </div>
    )
  }

  const head = (m: PerfMetric) => (
    <div
      className={`text-right text-[11px] font-bold uppercase tracking-[0.06em] ${
        m === metric ? 'text-brand-violet' : 'text-ink-muted'
      }`}
      aria-sort={m === metric ? 'descending' : undefined}
      role="columnheader"
    >
      {perfLabel(m)}
    </div>
  )

  return (
    <div role="table" aria-label="Top products" className="grid grid-cols-[minmax(0,1fr)_8.5rem_7.5rem_3.5rem] gap-x-4">
      <div role="row" className="contents">
        <div role="columnheader" className="text-[11px] font-bold uppercase tracking-[0.06em] text-ink-muted">
          Product
        </div>
        {head('incremental_sales')}
        {head('trade_spend')}
        {head('roi')}
      </div>
      {rows.map((g, i) => (
        <div
          key={g.code}
          role="row"
          className="group contents"
          title={[g.label, '', `Incremental Sales: ${g.incremental_sales_display}`, `Trade Spend: ${g.trade_spend_display}`, `ROI: ${fmtRoi(g.roi)}`].join('\n')}
        >
          <div role="cell" className="flex min-w-0 items-center gap-1.5 border-t border-border-subtle py-2 text-sm group-hover:bg-surface-hover">
            <span className="tabular-nums text-ink-muted">{i + 1}</span>
            <span className="truncate font-semibold text-ink-primary">{g.label}</span>
          </div>
          <div role="cell" className="border-t border-border-subtle py-2 group-hover:bg-surface-hover">{cell(g, 'incremental_sales')}</div>
          <div role="cell" className="border-t border-border-subtle py-2 group-hover:bg-surface-hover">{cell(g, 'trade_spend')}</div>
          <div role="cell" className="flex items-center justify-end border-t border-border-subtle py-2 group-hover:bg-surface-hover">{cell(g, 'roi')}</div>
        </div>
      ))}
    </div>
  )
}


/** ---- The column plot · Sales by Region and Regular vs Seasonal ----------
 *
 *  ONE metric at a time, as a column per group on ONE axis. The card's switch
 *  picks the metric; the columns are the colour of that metric (series.ts),
 *  so a reader who has learned "violet is Incremental Sales" on any other card
 *  reads this one without a legend.
 *
 *  ROI RIDES UNDER EVERY GROUP whatever the axis shows, as a direct label in
 *  the axis band — a region that carries the most sales must never be mistaken
 *  for the one that returns the most. When ROI IS the axis the label would
 *  repeat the column's own value, so it is dropped.
 *
 *  Same idiom as TrendPanels: width and height measured from the container,
 *  real px text, design tokens for every colour so dark mode follows the
 *  theme, and an HTML tooltip over the SVG rather than a native title.
 */

/** The smallest round step at or above `raw` — the ladder TrendPanels uses,
 *  finer than the usual 1/2/5 so a ₹29.7 Cr peak does not round up to a ₹50 Cr
 *  axis and leave every column squashed into the bottom half of the card. */
const COLUMN_NICE = [1, 1.5, 2, 2.5, 3, 4, 5, 6, 7.5, 10]

export function columnNiceStep(raw: number): number {
  if (raw <= 0) return 1
  const mag = 10 ** Math.floor(Math.log10(raw))
  return (COLUMN_NICE.find((c) => c >= raw / mag - 1e-9) ?? 10) * mag
}

export const COLUMN_DIVISIONS = 4

/** Width AND height from the container, so the plot fills the card the grid
 *  row actually gives it instead of a hardcoded box. The SVG is positioned
 *  absolutely inside the measured element, so it can never feed its own height
 *  back into the measurement. */
export function useChartSize(fallbackW: number, fallbackH: number) {
  const ref = useRef<HTMLDivElement>(null)
  const [size, setSize] = useState({ width: fallbackW, height: fallbackH })

  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    const read = () =>
      setSize({ width: el.clientWidth || fallbackW, height: el.clientHeight || fallbackH })
    read()
    const ro = new ResizeObserver(read)
    ro.observe(el)
    return () => ro.disconnect()
  }, [fallbackW, fallbackH])

  return { ref, width: size.width, height: size.height }
}

/** One column, with the DATA END rounded and the baseline end square — so the
 *  bar reads as growing out of the axis rather than floating above it. */
export function columnPath(x: number, top: number, w: number, h: number, down: boolean): string {
  const r = Math.min(4, w / 2, h)
  const b = top + h
  return down
    ? `M${x},${top} L${x + w},${top} L${x + w},${b - r} Q${x + w},${b} ${x + w - r},${b} ` +
      `L${x + r},${b} Q${x},${b} ${x},${b - r} Z`
    : `M${x},${b} L${x},${top + r} Q${x},${top} ${x + r},${top} ` +
      `L${x + w - r},${top} Q${x + w},${top} ${x + w},${top + r} L${x + w},${b} Z`
}

/** Ellipsise a region name that cannot fit its slot. SVG text does not wrap or
 *  truncate on its own, and an overrunning label would collide with its
 *  neighbour's. */
function fitLabel(text: string, px: number): string {
  const max = Math.max(3, Math.floor(px / 6.4))
  return text.length > max ? `${text.slice(0, max - 1)}…` : text
}

/** Where a hover tooltip sits so it never covers the column it describes.
 *
 *  It used to be centred over the hovered slot, which put it squarely on top
 *  of the column's own direct label — the one figure the hover was asking
 *  about. Now it goes BESIDE the slot: to the right when there is room, else
 *  to the left, and on a plot too narrow for either (the two-column type
 *  chart) it is anchored to the far half so the hovered column stays clear.
 *  Whatever it overlaps is a neighbour, which the hover already dims. */
export function tooltipLeft(width: number, slotL: number, slotR: number, tipW: number, gap = 4): number {
  if (slotR + gap + tipW <= width) return slotR + gap
  if (slotL - gap - tipW >= 0) return slotL - gap - tipW
  const mid = (slotL + slotR) / 2
  return mid < width / 2 ? Math.max(0, width - tipW) : 0
}

export { SERIES } from './series'

function MetricColumns({
  groups,
  metric,
  total,
  rate,
  symbol,
  targetRoi,
  noun,
}: {
  groups: BreakdownGroup[]
  metric: PerfMetric
  /** The values summed, for a share beside each label — only where the groups
   *  are a real composition of the scope (promotion type) and the metric is
   *  a quantity. Null for a ranking (regions) and always for ROI, which is a
   *  ratio and carries no share. */
  total: number | null
  /** From `meta.exchange_rate` — the single backend-defined rate. Used for the
   *  AXIS TICKS only, which are synthetic values; every figure that names a
   *  group is the backend's own `*_display` string. */
  rate: number
  symbol: string
  /** `meta.target_roi` — what the ROI under each column is judged against. */
  targetRoi: number
  /** What a column is, for the note above the plot: "region", "type". */
  noun: string
}) {
  const { ref, width, height } = useChartSize(700, 300)
  const [hover, setHover] = useState<number | null>(null)

  const n = groups.length
  const padL = 56
  const padR = 12
  const padT = 24
  const padB = 40
  const innerW = Math.max(140, width - padL - padR)
  const innerH = Math.max(90, height - padT - padB)

  const isRoi = metric === 'roi'
  const tick = (v: number) => {
    if (isRoi) return fmtRoi(v)
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

  // A null value is left out of the extent entirely rather than counted as
  // zero — see the columns below.
  const values = groups.map((g) => perfValue(g, metric))
  const present = values.filter((v): v is number => v !== null)
  const rawMax = Math.max(1, ...present)
  const rawMin = Math.min(0, ...present)

  const step = columnNiceStep((rawMin < 0 ? rawMax - rawMin : rawMax) / COLUMN_DIVISIONS)
  const lo = rawMin < 0 ? Math.floor(rawMin / step) * step : 0
  let hi = lo + step * COLUMN_DIVISIONS
  // A negative floor can eat divisions the positive side still needs; extend
  // the axis rather than clipping a column at the top of the plot.
  while (hi < rawMax) hi += step
  // HEADROOM for the direct label: a peak within ~14px of the axis top puts
  // its value on the top gridline. One more step keeps the label clear.
  if (((hi - rawMax) / (hi - lo)) * innerH < 14) hi += step

  const y = (v: number) => padT + innerH * (1 - (v - lo) / (hi - lo || 1))
  const zeroY = y(0)

  const ticks: number[] = []
  for (let t = lo; t <= hi + 1e-6; t += step) ticks.push(t)

  const slot = innerW / n
  // THIN marks. A saturated fill 30px wide reads as a block rather than as a
  // measurement; capped well below the slot so the column sits inside its own
  // whitespace and the eye compares heights instead of areas.
  const barW = Math.max(10, Math.min(28, slot * 0.22))
  const centreX = (i: number) => padL + slot * i + slot / 2
  const active = hover !== null && hover < n ? hover : null
  const fill = perfFill(metric)
  const metricLabel = perfLabel(metric)

  const TIP_W = 208

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {/* The switch above the plot already names the metric, so no legend:
          the one note here is where to find the figure the axis does not
          carry. */}
      {!isRoi && (
        <div className="mb-2 text-right text-xs text-ink-muted">ROI under each {noun}</div>
      )}

      <div ref={ref} className="relative min-h-[250px] w-full flex-1">
        <svg
          className="absolute inset-0"
          width={width}
          height={height}
          role="img"
          aria-label={`${metricLabel} by ${noun}`}
        >
          {/* Recessive hairline grid — solid, one shade off the surface. */}
          {ticks.map((t) => (
            <g key={t}>
              <line
                x1={padL}
                x2={padL + innerW}
                y1={y(t)}
                y2={y(t)}
                /* The baseline is the AXIS and carries one step more weight
                   than the grid above it; everything else stays a recessive
                   hairline one shade off the surface. */
                stroke={t === lo ? 'var(--border-default)' : 'var(--border-subtle)'}
              />
              <text
                x={padL - 8}
                y={y(t) + 3}
                textAnchor="end"
                fontSize={10}
                fill="var(--text-muted)"
              >
                {tick(t)}
              </text>
            </g>
          ))}

          {/* The zero line only exists when the axis crosses it. */}
          {lo < 0 && (
            <line x1={padL} x2={padL + innerW} y1={zeroY} y2={zeroY} stroke="var(--border-strong)" />
          )}

          {groups.map((g, i) => {
            const v = values[i]
            const isActive = active === i
            const share = total && v !== null ? (v / total) * 100 : null
            const label =
              v === null
                ? '—'
                : share !== null
                  ? `${perfDisplay(g, metric)} · ${share.toFixed(2)}%`
                  : perfDisplay(g, metric)

            /** A column from the baseline to `v`. Null draws nothing at all —
             *  an unmeasurable value is not zero, and a zero-height column
             *  would claim it was. */
            let column = null
            if (v !== null) {
              const down = v < 0
              const top = Math.min(y(v), zeroY)
              const h = Math.max(Math.abs(y(v) - zeroY), v === 0 ? 0 : 2)
              if (h > 0) {
                column = (
                  <path
                    d={columnPath(centreX(i) - barW / 2, top, barW, h, down)}
                    fill={fill}
                    className="transition-opacity duration-150"
                    opacity={active === null || isActive ? 1 : 0.45}
                  />
                )
              }
            }

            return (
              <g key={g.code}>
                {/* Hover band, behind the column. */}
                <rect
                  x={padL + slot * i + 1}
                  y={padT - 6}
                  width={Math.max(0, slot - 2)}
                  height={innerH + 12}
                  rx={6}
                  fill="var(--surface-hover)"
                  opacity={isActive ? 1 : 0}
                  className="transition-opacity duration-150"
                />
                {column}

                {/* Direct label on the column. */}
                <text
                  x={centreX(i)}
                  y={v !== null && v < 0 ? Math.max(y(v), zeroY) + 13 : Math.min(y(v ?? 0), zeroY) - 7}
                  textAnchor="middle"
                  fontSize={10}
                  fontWeight={700}
                  fill="var(--text-primary)"
                >
                  {label}
                </text>

                {/* Axis band: the group, and its ROI as a direct label — unless
                    ROI IS the axis, where it would repeat the label above. */}
                <text
                  x={centreX(i)}
                  y={isRoi ? height - 14 : height - 21}
                  textAnchor="middle"
                  fontSize={11}
                  fontWeight={600}
                  fill="var(--text-primary)"
                >
                  {fitLabel(g.label, slot - 6)}
                </text>
                {!isRoi && (
                  <text
                    x={centreX(i)}
                    y={height - 7}
                    textAnchor="middle"
                    fontSize={10}
                    fontWeight={700}
                    fill={ROI_TONE_VAR[roiTone(g.roi, targetRoi)]}
                  >
                    {fmtRoi(g.roi)}
                  </text>
                )}

                {/* The hit area is the whole slot, not the column. No <title>
                    here: the browser would draw its own tooltip on top of the
                    card's, and inside a role="img" it never reached assistive
                    tech anyway — the list after the plot does that. */}
                <rect
                  x={padL + slot * i}
                  y={0}
                  width={slot}
                  height={height}
                  fill="transparent"
                  onMouseEnter={() => setHover(i)}
                  onMouseLeave={() => setHover(null)}
                />
              </g>
            )
          })}
        </svg>

        {active !== null && (
          <div
            className="pointer-events-none absolute top-1 z-20 w-52 rounded-[var(--r-md)] border border-border-default bg-surface-card p-2.5 text-xs shadow-[var(--shadow-lg)]"
            style={{
              left: tooltipLeft(width, padL + slot * active, padL + slot * (active + 1), TIP_W),
            }}
          >
            <div className="font-bold text-ink-primary">{groups[active].label}</div>
            {/* Every measure, not just the one on the axis; the swatch marks
                the one the columns are drawing. */}
            <TipRow
              swatch={metric === 'incremental_sales' ? SERIES.incremental : undefined}
              k="Incremental Sales"
              v={groups[active].incremental_sales === null ? '—' : groups[active].incremental_sales_display}
            />
            <TipRow
              swatch={metric === 'trade_spend' ? SERIES.spend : undefined}
              k="Trade Spend"
              v={groups[active].trade_spend_display}
            />
            <TipRow swatch={isRoi ? SERIES.roi : undefined} k="ROI" v={fmtRoi(groups[active].roi)} />
          </div>
        )}
      </div>

      {/* The same figures as text, for readers the SVG cannot reach. */}
      <ul className="sr-only">
        {groups.map((g) => (
          <li key={g.code}>
            {g.label}: Incremental Sales {g.incremental_sales === null ? 'not measurable' : g.incremental_sales_display}, Trade
            Spend {g.trade_spend_display}, ROI {fmtRoi(g.roi)}
          </li>
        ))}
      </ul>
    </div>
  )
}

export function TipRow({ k, v, swatch }: { k: string; v: string; swatch?: string }) {
  return (
    <div className="mt-1 flex items-center justify-between gap-3">
      <span className="flex min-w-0 items-center gap-1.5 text-ink-muted">
        {swatch && <span className="h-2 w-2 shrink-0 rounded-[2px]" style={{ background: swatch }} />}
        <span className="truncate">{k}</span>
      </span>
      <span className="shrink-0 font-semibold tabular-nums text-ink-primary">{v}</span>
    </div>
  )
}

/** ---- Sales by Region -----------------------------------------------------
 *
 *  One metric per geography, ranked, with ROI on every column — so a region
 *  that carries the most sales is never mistaken for the one that returns
 *  the most.
 *
 *  SCOPED BY THE PAGE FILTER BAR. Year, Month, Channel and everything under
 *  More Filters all come from the shared `commandFilters` store, through the
 *  same `toQuery` the KPI cards post with, so this card cannot describe a
 *  selection the rest of the page is not showing. That is `scope: 'page'` on
 *  the hook below. The metric switch is the card's only control of its own,
 *  and it is not a scope: it re-ranks the fetched regions in the browser.
 *
 *  It is the one breakdown card on the page that takes the full selection
 *  rather than the year alone, and it pays a refetch on every filter change for
 *  it. That is deliberate: a geography ranking that ignored the bar's Region or
 *  Channel would sit directly beneath KPI cards that did not, and the two would
 *  disagree on screen with nothing to explain why.
 *
 *  A RANKING, never a composition. Region is a STORE dimension, so Incremental
 *  Sales is re-baselined per region and the regions do not add back to the
 *  headline KPI. No share is shown, for the same reason Product Performance
 *  shows none.
 */

/** 50 is the endpoint's maximum and comfortably exceeds the region count, so
 *  the ranking is the whole population rather than a head the server cut. */
const REGION_LIMIT = 50

export function SalesByRegionSection() {
  const [metric, setMetric] = useState<PerfMetric>('incremental_sales')
  const { symbol } = useDisplay()
  const year = useCommandFilters((s) => s.filters.year)
  const month = useCommandFilters((s) => s.filters.month)
  const channel = useCommandFilters((s) => s.filters.channel)

  const q = useBreakdown('region', { limit: REGION_LIMIT, scope: 'page' })
  const targetRoi = useTargetRoi(q.data?.meta)

  // The page's own option lists, already in flight for the filter bar — reused
  // here only to turn the selected month number and channel codes into the
  // names the bar itself shows. No second request, and no month or channel
  // name held in the frontend.
  const options = useFilterOptions()

  // Dropping the regions this scope left with nothing measurable on the
  // selected metric beats drawing a zero-length column that reads as a real
  // result.
  const rows = useMemo(() => rankBy(q.data?.groups ?? [], metric), [q.data, metric])

  const yearLabel = year === null ? 'All years' : String(year)
  const monthLabel =
    month === null
      ? 'all months'
      : ((options.data?.months ?? []).find((o) => Number(o.code) === month)?.name ?? `month ${month}`)
  const channelLabel =
    channel.length === 0
      ? 'all channels'
      : channel
          .map((code) => (options.data?.channels ?? []).find((o) => o.code === code)?.name ?? code)
          .join(', ')
  const cut = `${yearLabel} · ${monthLabel} · ${channelLabel}`
  const count = `${rows.length} region${rows.length === 1 ? '' : 's'}`

  return (
    <ChartFrame
      fill
      title="Sales by Region"
      hint={`The selected metric by geography, ranked, with ROI under every region. Follows the page filter bar — every control on it, including Month and Channel under More Filters. Currently showing ${cut}.`}
      actions={rows.length > 0 ? <span className="text-xs font-semibold text-ink-muted">{count}</span> : null}
      controls={<PerfMetricSelect value={metric} onChange={setMetric} label="Region metric" />}
      isLoading={q.isLoading}
      isFetching={q.isFetching}
      error={q.error}
      onRetry={() => void q.refetch()}
      isEmpty={rows.length === 0}
      emptyMessage={`No promotion activity in any region for ${cut}.`}
      footnote={`${count} ranked by ${perfLabel(metric)} · ${cut}. ${
        metric === 'incremental_sales'
          ? 'A ranking, not a share — Incremental Sales is re-baselined per region, so the regions do not sum to the headline figure.'
          : metric === 'roi'
            ? 'A ranking; ROI is a ratio and carries no share.'
            : 'A ranking, not a share of the total.'
      }`}
    >
      <MetricColumns
        groups={rows}
        metric={metric}
        total={null}
        rate={q.data?.meta.exchange_rate ?? 1}
        symbol={symbol}
        targetRoi={targetRoi}
        noun="region"
      />
    </ChartFrame>
  )
}
