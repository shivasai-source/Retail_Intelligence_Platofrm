import { useLayoutEffect, useMemo, useRef, useState } from 'react'
import { useBreakdown, useFilterOptions, useTopPromotions } from '../../hooks/useCommandCenter'
import { useCommandFilters } from '../../store/commandFilters'
import { ChartFrame } from './ChartFrame'
import { RankedBar } from './RankedBar'
import type { BreakdownGroup } from '../../types/commandCenter'

/** The chart sections of the Command Center.
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
 *  The only card-local control on this page is the mechanic on Channel
 *  Performance, which is a chart-level Offer scope rather than a copy of
 *  anything the filter bar holds. */

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

/** M2 · Channel Performance — "which channel performs best at this discount?"
 *
 *  Not a Top-N ranking: every channel the scope contains is shown, ordered by
 *  Incremental Sales descending (the backend's own ordering for this metric).
 *  The discount control is a chart-level Offer filter that genuinely re-queries
 *  `/breakdown`; it does not relabel a fixed dataset. */
export function ChannelSection() {
  const [picked, setPicked] = useState<string | null>(null)
  const { symbol } = useDisplay()

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

  // Year is the Command Center's only global filter, so the mechanic is the
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

  return (
    <ChartFrame
      fill
      title="Channel Performance"
      hint={`Compares channel-level promotion performance at the selected promotion mechanic. Metrics: Incremental Sales, Trade Spend, ROI. Currently showing ${level?.label ?? '—'}.`}
      actions={
        <div className="inline-flex items-center gap-1.5 text-xs text-ink-muted">
          <span>Mechanic</span>
          <div
            className="inline-flex overflow-hidden rounded-[var(--r-sm)] border border-border-subtle"
            role="radiogroup"
            aria-label="Promotion mechanic"
          >
            {levels.map((d) => (
              <button
                key={d.code}
                type="button"
                role="radio"
                aria-checked={d.code === level?.code}
                onClick={() => setPicked(d.code)}
                className={`cursor-pointer px-1.5 py-0.5 font-semibold transition-colors focus:outline-none focus-visible:ring-1 focus-visible:ring-brand-violet ${
                  d.code === level?.code
                    ? 'bg-brand-violet text-white'
                    : 'text-ink-muted hover:bg-surface-hover hover:text-ink-primary'
                }`}
              >
                {shortMechanic(d.code)}
              </button>
            ))}
          </div>
        </div>
      }
      isLoading={q.isLoading || mechanics.isLoading}
      isFetching={q.isFetching || mechanics.isFetching}
      error={q.error ?? mechanics.error}
      onRetry={() => {
        void mechanics.refetch()
        void q.refetch()
      }}
      isEmpty={!data || data.groups.length === 0}
      emptyMessage={`No ${level?.label ?? 'promotion'} activity in this scope.`}
      footnote="Ranked by Incremental Sales. Channels are compared, not summed."
    >
      {data && (
        <RankedBar
          fill
          groups={data.groups}
          rate={data.meta.exchange_rate}
          symbol={symbol}
          rowTooltip={(g) =>
            `${g.label}
Mechanic: ${level?.label ?? '—'}

` +
            `Incremental Sales: ${g.incremental_sales_display}
` +
            `Trade Spend: ${g.trade_spend_display}
` +
            `ROI: ${g.roi === null ? '—' : `${g.roi.toFixed(1)}%`}`
          }
        />
      )}
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
 *  economics, ROI = u(1-d) / ((1+u)(d+c)) - 1, so the shallowest discount
 *  always wins: PR001 invests 8% of base revenue and returns ~78%, while the
 *  seasonal mechanics invest 23-28% and return ~30%. Ranked naively, all ten
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
 *  because `roi_percent` is null exactly when Trade Spend is zero, that is also
 *  the zero-spend filter. Negative ROI is kept as-is and simply loses.
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
  const mechanicByPromotion = useMechanicByPromotion()

  const rows = useMemo(() => {
    const eligible = (q.data?.rows ?? []).filter(
      (r) => r.roi_pct !== null && Number.isFinite(r.roi_pct) && r.trade_spend > 0,
    )
    if (!eligible.length) return []

    const spends = eligible.map((r) => r.trade_spend).sort((a, b) => a - b)
    const mid = spends.length >> 1
    const median = spends.length % 2 ? spends[mid] : (spends[mid - 1] + spends[mid]) / 2

    const ranked = eligible
      .filter((r) => r.trade_spend >= median)
      .sort((a, b) => b.roi_pct - a.roi_pct || b.trade_spend - a.trade_spend)

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

  const peak = rows.length ? Math.max(rows[0].roi_pct, 1) : 1

  return (
    <ChartFrame
      fill
      title="Top Performing Promotions"
      hint="Top performing promotions ranked by ROI among meaningful-impact promotions."
      isLoading={q.isLoading}
      isFetching={q.isFetching}
      error={q.error}
      onRetry={() => void q.refetch()}
      isEmpty={rows.length === 0}
      emptyMessage="No promotion with a measurable return in this scope."
      height={230}
      footnote={`${rows.length} promotions ranked by ROI, among those at or above median Trade Spend. At most ${PER_MECHANIC_CAP} per mechanic.`}
    >
      {/* The list takes the height the card actually has instead of a fixed
          268px viewport, so the scrollbar appears only when the rows genuinely
          exceed the card rather than because of a hardcoded cap. min-h-0 is
          what lets a flex child shrink far enough to scroll at all. */}
      <div className="flex min-h-0 flex-1 flex-col gap-2 overflow-y-auto pr-1">
        {rows.map((r, i) => (
          <div
            key={`${r.promotion}-${r.channel}-${r.period}-${i}`}
            className="group"
            title={
              `${r.promotion}
${r.channel} · ${r.period}

` +
              `ROI: ${r.roi_display}
` +
              `Trade Spend: ${r.trade_spend_display}
` +
              `Incremental Sales: ${r.incremental_sales_display}`
            }
          >
            <div className="flex items-baseline justify-between gap-2 text-sm">
              <span className="min-w-0 truncate font-semibold text-ink-primary">
                <span className="mr-1.5 tabular-nums text-ink-disabled">{i + 1}</span>
                {r.promotion}
              </span>
              <span className="shrink-0 font-bold tabular-nums text-status-success">{r.roi_display}</span>
            </div>
            <div className="mt-1 h-2 w-full overflow-hidden rounded-full bg-ink-primary/[0.05]">
              <div
                className="h-full rounded-full bg-brand-violet transition-[width] duration-300 group-hover:brightness-110"
                style={{ width: `${Math.max(0, Math.min(100, (r.roi_pct / peak) * 100))}%` }}
              />
            </div>
            <div className="mt-0.5 flex items-baseline justify-between gap-2 text-xs text-ink-muted">
              <span className="min-w-0 truncate">
                {r.channel} · {r.period} · {r.mechanic}
              </span>
              <span className="shrink-0 tabular-nums">
                Spend {r.trade_spend_display} · Inc. Sales {r.incremental_sales_display}
              </span>
            </div>
          </div>
        ))}
      </div>
    </ChartFrame>
  )
}


/** N1 · Promotion Contribution — where Incremental Sales and Trade Spend sit
 *  across promotion MECHANICS.
 *
 *  Mechanic, not offer: `by=promotion_mechanic` groups on
 *  dim_promotion.Promotion_Name, so the six seasonal offers of a year collapse
 *  into the single mechanic they all run ("20% Discount" in 2024, "Buy3Get1"
 *  in 2025). The mechanics a year did not run simply do not appear.
 *
 *  A COMPOSITION, and legitimately so — unlike most breakdowns on this page.
 *  The endpoint's own warning is that Incremental Sales is not reliably
 *  additive, because the baseline is re-derived per selection. For an offer
 *  dimension it is: every group is measured against the same non-promoted
 *  rows, so the mechanics reconcile to the headline KPI exactly (verified to
 *  0.0000% on both metrics, both years and All Years). The percentage below is
 *  therefore a real share of the total, computed on the values the backend
 *  returned — not a second calculation of them. */

const CONTRIBUTION_METRICS = [
  { key: 'incremental_sales' as const, label: 'Incremental Sales' },
  { key: 'trade_spend' as const, label: 'Trade Spend' },
]
type ContributionMetric = (typeof CONTRIBUTION_METRICS)[number]['key']

export function PromotionContributionSection() {
  const [metric, setMetric] = useState<ContributionMetric>('incremental_sales')
  const q = useBreakdown('promotion_mechanic', { metric, limit: 50 })

  const { rows, total } = useMemo(() => {
    const groups = q.data?.groups ?? []
    const value = (g: BreakdownGroup) =>
      metric === 'trade_spend' ? (g.trade_spend ?? 0) : (g.incremental_sales ?? 0)
    // The backend already ranked by `metric`; sorting here keeps the card
    // correct even if a future response arrives in another order.
    const ordered = [...groups].sort((a, b) => value(b) - value(a))
    return { rows: ordered, total: ordered.reduce((sum, g) => sum + value(g), 0) }
  }, [q.data, metric])

  const value = (g: BreakdownGroup) =>
    metric === 'trade_spend' ? (g.trade_spend ?? 0) : (g.incremental_sales ?? 0)
  const display = (g: BreakdownGroup) =>
    metric === 'trade_spend' ? g.trade_spend_display : g.incremental_sales_display
  const metricLabel = CONTRIBUTION_METRICS.find((m) => m.key === metric)?.label
  const peak = rows.length ? value(rows[0]) || 1 : 1

  return (
    <ChartFrame
      fill
      title="Promotion Contribution"
      hint="Shows how Incremental Sales or Trade Spend is distributed across promotion mechanics."
      controls={
        <div
          className="inline-flex h-[23px] items-stretch overflow-hidden rounded-[var(--r-sm)] border border-border-subtle"
          role="radiogroup"
          aria-label="Contribution metric"
        >
          {CONTRIBUTION_METRICS.map((m) => (
            <button
              key={m.key}
              type="button"
              role="radio"
              aria-checked={metric === m.key}
              onClick={() => setMetric(m.key)}
              className={`cursor-pointer px-2 text-xs font-semibold transition-colors focus:outline-none focus-visible:ring-1 focus-visible:ring-brand-violet ${
                metric === m.key
                  ? 'bg-brand-violet text-white'
                  : 'text-ink-muted hover:bg-surface-hover hover:text-ink-primary'
              }`}
            >
              {m.label}
            </button>
          ))}
        </div>
      }
      isLoading={q.isLoading}
      isFetching={q.isFetching}
      error={q.error}
      onRetry={() => void q.refetch()}
      isEmpty={rows.length === 0}
      emptyMessage="No promotion mechanics ran in this scope."
      footnote={`${rows.length} mechanics · ${metricLabel} shares total 100% of the scope.`}
    >
      {/* Four or five mechanics against a ten-row neighbour: distributing them
          over the stretched height keeps the card filled and the spacing even,
          and the taller bar is what a chart with this few categories wants. */}
      <div className="flex flex-1 flex-col justify-between gap-3.5">
        {rows.map((g, i) => {
          const share = total ? (value(g) / total) * 100 : 0
          return (
            <div
              key={g.code}
              className="group"
              title={[
                g.label,
                '',
                `Trade Spend: ${g.trade_spend_display}`,
                `Incremental Sales: ${g.incremental_sales_display}`,
                `ROI: ${g.roi === null ? '—' : `${g.roi.toFixed(1)}%`}`,
              ].join('\n')}
            >
              <div className="flex items-baseline justify-between gap-2 text-sm">
                <span className="flex min-w-0 items-baseline gap-1.5">
                  <span className="tabular-nums text-ink-disabled">{i + 1}</span>
                  <span className="truncate font-semibold text-ink-primary">{g.label}</span>
                </span>
                <span className="shrink-0 tabular-nums">
                  <span className="font-bold text-ink-primary">{display(g)}</span>
                  {' · '}
                  <span className="font-semibold text-ink-muted">{share.toFixed(1)}%</span>
                </span>
              </div>
              {/* Bars are scaled against the LEADER, not against the total, so
                  the widths stay readable when one mechanic carries a third of
                  the money. The share is the number to the right. */}
              <div className="mt-1.5 h-10 w-full overflow-hidden rounded-[var(--r-sm)] bg-ink-primary/[0.05]">
                <div
                  className="h-full rounded-[var(--r-sm)] bg-brand-violet transition-[width] duration-300 group-hover:brightness-110"
                  style={{ width: `${Math.max(0, Math.min(100, (value(g) / peak) * 100))}%` }}
                />
              </div>
            </div>
          )
        })}
      </div>
    </ChartFrame>
  )
}

/** The three metrics both cards below rank on. Shared so the two controls are
 *  the same control, in the same order, with the same labels. */
const PERF_METRICS = [
  { key: 'incremental_sales' as const, label: 'Incremental Sales' },
  { key: 'trade_spend' as const, label: 'Trade Spend' },
  { key: 'roi' as const, label: 'ROI' },
]
type PerfMetric = (typeof PERF_METRICS)[number]['key']

function perfValue(g: BreakdownGroup, metric: PerfMetric): number | null {
  return metric === 'trade_spend' ? g.trade_spend : metric === 'roi' ? g.roi : g.incremental_sales
}

function perfDisplay(g: BreakdownGroup, metric: PerfMetric): string {
  if (metric === 'roi') return g.roi === null ? '—' : `${g.roi.toFixed(1)}%`
  return metric === 'trade_spend' ? g.trade_spend_display : g.incremental_sales_display
}

/** The metric selector shared by the two cards below. */
function PerfMetricSelect({
  value,
  onChange,
  label,
}: {
  value: PerfMetric
  onChange: (v: PerfMetric) => void
  label: string
}) {
  return (
    <div
      className="inline-flex h-[23px] items-stretch overflow-hidden rounded-[var(--r-sm)] border border-border-subtle"
      role="radiogroup"
      aria-label={label}
    >
      {PERF_METRICS.map((m) => (
        <button
          key={m.key}
          type="button"
          role="radio"
          aria-checked={value === m.key}
          onClick={() => onChange(m.key)}
          className={`cursor-pointer px-2 text-xs font-semibold transition-colors focus:outline-none focus-visible:ring-1 focus-visible:ring-brand-violet ${
            value === m.key
              ? 'bg-brand-violet text-white'
              : 'text-ink-muted hover:bg-surface-hover hover:text-ink-primary'
          }`}
        >
          {m.label}
        </button>
      ))}
    </div>
  )
}

const PRODUCT_ROWS = 10

/** N2 · Regular vs Seasonal Performance — the two promotion types side by side.
 *
 *  A COMPARISON of two groups, not a ranking of many, so it is drawn as two
 *  aligned bars on one shared scale: the bars are directly comparable in length
 *  because they share a maximum, which a pair of independently-scaled bars
 *  would not be.
 *
 *  The share is real. Promotion type is an offer dimension, so both groups are
 *  measured against the same non-promoted rows and the two add back to the
 *  headline KPI exactly (verified to 0.0000% on Incremental Sales and Trade
 *  Spend, both years and All Years).
 *
 *  ROI CARRIES NO SHARE. It is a ratio, not a quantity: "Regular is 89% of the
 *  combined ROI" would be an arithmetic accident, not a fact about the
 *  business. For ROI the card states the gap in percentage points instead. */
export function PromotionTypeSection() {
  const [metric, setMetric] = useState<PerfMetric>('incremental_sales')
  const q = useBreakdown('promotion_type', { metric, limit: 50 })

  const groups = useMemo(() => {
    const rows = [...(q.data?.groups ?? [])]
    // Regular first, always — the card is a fixed comparison, so the two rows
    // must not swap places when the ranking metric changes.
    return rows.sort((a, b) => (a.code === 'Regular' ? -1 : b.code === 'Regular' ? 1 : 0))
  }, [q.data])

  const isShareable = metric !== 'roi'
  const total = isShareable
    ? groups.reduce((sum, g) => sum + (perfValue(g, metric) ?? 0), 0)
    : 0
  const peak = Math.max(...groups.map((g) => Math.abs(perfValue(g, metric) ?? 0)), 1)
  const metricLabel = PERF_METRICS.find((m) => m.key === metric)?.label

  const [lead, trail] = [...groups].sort(
    (a, b) => (perfValue(b, metric) ?? 0) - (perfValue(a, metric) ?? 0),
  )
  const gapPts =
    lead && trail ? (perfValue(lead, metric) ?? 0) - (perfValue(trail, metric) ?? 0) : null

  return (
    <ChartFrame
      fill
      title="Regular vs Seasonal Performance"
      hint="Compares regular and seasonal promotion contribution and return."
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
          ? `Share of ${metricLabel}; the two types total 100% of the scope.`
          : gapPts !== null && lead
            ? `ROI is a ratio, so it carries no share — ${lead.code} leads by ${gapPts.toFixed(1)} pts.`
            : 'ROI is a ratio, so it carries no share.'
      }
    >
      {/* justify-CENTER, not space-between: two bars flung to the top and
          bottom of a tall card cannot be compared at a glance, which is the
          only thing this card exists to do. The pair stays adjacent and the
          stretched height is absorbed evenly above and below it. */}
      <div className="flex flex-1 flex-col justify-center gap-5">
        {groups.map((g) => {
          const value = perfValue(g, metric) ?? 0
          const share = total ? (value / total) * 100 : null
          return (
            <div
              key={g.code}
              className="group"
              title={[
                `${g.code} promotions`,
                '',
                `Trade Spend: ${g.trade_spend_display}`,
                `Incremental Sales: ${g.incremental_sales_display}`,
                `ROI: ${g.roi === null ? '—' : `${g.roi.toFixed(1)}%`}`,
              ].join('\n')}
            >
              <div className="flex items-baseline justify-between gap-2 text-sm">
                <span className="truncate font-semibold text-ink-primary">{g.code}</span>
                <span className="shrink-0 tabular-nums">
                  <span className="font-bold text-ink-primary">{perfDisplay(g, metric)}</span>
                  {share !== null && (
                    <>
                      {' · '}
                      <span className="font-semibold text-ink-muted">{share.toFixed(1)}%</span>
                    </>
                  )}
                </span>
              </div>
              {/* Both bars share `peak`, so their lengths are comparable.
                  Seasonal takes the teal the trend line draws ROI in -- the
                  page's third series colour -- rather than the info blue,
                  which appeared nowhere else on the Command Center. */}
              <div className="mt-1.5 h-28 w-full overflow-hidden rounded-[var(--r-sm)] bg-ink-primary/[0.05]">
                <div
                  className={`h-full rounded-[var(--r-sm)] transition-[width] duration-300 group-hover:brightness-110 ${
                    g.code === 'Regular' ? 'bg-brand-violet' : 'bg-tint-teal-icon'
                  }`}
                  style={{ width: `${Math.max(0, Math.min(100, (Math.abs(value) / peak) * 100))}%` }}
                />
              </div>
              {/* ROI stays visible whatever the ranking metric, so a type that
                  carries the most money is never read as the best return.
                  Ranking BY ROI already prints it above, so the second copy is
                  dropped rather than shown twice. */}
              {metric !== 'roi' && (
                <div className="mt-1 text-xs text-ink-muted">
                  ROI{' '}
                  <span
                    className={
                      g.roi === null ? 'text-ink-muted'
                      : g.roi < 0 ? 'font-semibold text-status-danger'
                      : 'font-semibold text-status-success'
                    }
                  >
                    {g.roi === null ? '—' : `${g.roi.toFixed(1)}%`}
                  </span>
                </div>
              )}
            </div>
          )
        })}
      </div>
    </ChartFrame>
  )
}

/** N3 · Product Performance — the top ten SKUs on the selected metric.
 *
 *  A RANKING, never a composition: Incremental Sales is re-baselined per
 *  selection, so ten of thirty-six products do not sum to anything meaningful
 *  and no share is shown. ROI rides on every row whatever the ranking metric,
 *  because a SKU can lead on spend and still be the worst return in the list. */
export function ProductSection() {
  const [metric, setMetric] = useState<PerfMetric>('incremental_sales')
  // The full population, so the tie-break below chooses from all 36 products
  // rather than from a head the server already cut at ten.
  const q = useBreakdown('product', { metric, limit: 50 })

  const rows = useMemo(() => {
    const groups = q.data?.groups ?? []
    return [...groups]
      .filter((g) => perfValue(g, metric) !== null)
      .sort(
        (a, b) =>
          (perfValue(b, metric) ?? 0) - (perfValue(a, metric) ?? 0) ||
          (b.roi ?? 0) - (a.roi ?? 0) ||
          (b.incremental_sales ?? 0) - (a.incremental_sales ?? 0),
      )
      .slice(0, PRODUCT_ROWS)
  }, [q.data, metric])

  const peak = rows.length ? Math.abs(perfValue(rows[0], metric) ?? 1) || 1 : 1
  const metricLabel = PERF_METRICS.find((m) => m.key === metric)?.label
  const total = q.data?.total_groups ?? rows.length

  return (
    <ChartFrame
      title="Product Performance"
      hint="Top 10 products ranked by the selected performance metric."
      controls={<PerfMetricSelect value={metric} onChange={setMetric} label="Performance metric" />}
      isLoading={q.isLoading}
      isFetching={q.isFetching}
      error={q.error}
      onRetry={() => void q.refetch()}
      isEmpty={rows.length === 0}
      emptyMessage="No products with measurable performance in this scope."
      footnote={`Top ${rows.length} of ${total} products by ${metricLabel}. ROI breaks ties. A ranking, not a share of the total.`}
    >
      <div className="flex flex-col gap-2.5">
        {rows.map((g, i) => (
          <div
            key={g.code}
            className="group"
            title={[
              g.label,
              '',
              `Trade Spend: ${g.trade_spend_display}`,
              `Incremental Sales: ${g.incremental_sales_display}`,
              `ROI: ${g.roi === null ? '—' : `${g.roi.toFixed(1)}%`}`,
            ].join('\n')}
          >
            <div className="flex items-baseline justify-between gap-2 text-sm">
              <span className="flex min-w-0 items-baseline gap-1.5">
                <span className="tabular-nums text-ink-disabled">{i + 1}</span>
                <span className="truncate font-semibold text-ink-primary">{g.label}</span>
              </span>
              <span className="shrink-0 tabular-nums">
                <span className="font-bold text-ink-primary">{perfDisplay(g, metric)}</span>
                {/* Ranking BY ROI already prints it in the value slot, so the
                    second copy is dropped rather than shown twice. */}
                {metric !== 'roi' && (
                  <>
                    {' · '}
                    <span
                      className={
                        g.roi === null ? 'text-ink-muted'
                        : g.roi < 0 ? 'font-semibold text-status-danger'
                        : 'font-semibold text-status-success'
                      }
                    >
                      {g.roi === null ? '—' : `${g.roi.toFixed(1)}%`}
                    </span>
                  </>
                )}
              </span>
            </div>
            <div className="mt-1 h-2.5 w-full overflow-hidden rounded-full bg-ink-primary/[0.05]">
              <div
                className="h-full rounded-full bg-brand-violet transition-[width] duration-300 group-hover:brightness-110"
                style={{
                  width: `${Math.max(0, Math.min(100, (Math.abs(perfValue(g, metric) ?? 0) / peak) * 100))}%`,
                }}
              />
            </div>
          </div>
        ))}
      </div>
    </ChartFrame>
  )
}


/** ---- Sales by Region · the plot ------------------------------------------
 *
 *  A GROUPED COLUMN chart: two money series per region, drawn as a pair of
 *  vertical bars on ONE shared axis. Both are rupees, so they are directly
 *  comparable in height and the gap between the pair IS the return.
 *
 *  ROI IS NOT PLOTTED. It is a percentage and shares no scale with money, so
 *  it rides in the axis band under each region as a direct label rather than
 *  on a second y-axis — the same rule TrendPanels states for its own ROI
 *  series, and the reason this card has one axis instead of two.
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

export const SERIES = {
  incremental: 'var(--brand-violet)',
  spend: 'var(--status-danger)',
} as const

function RegionColumns({
  groups,
  rate,
  symbol,
}: {
  groups: BreakdownGroup[]
  /** From `meta.exchange_rate` — the single backend-defined rate. Used for the
   *  AXIS TICKS only, which are synthetic values; every figure that names a
   *  group is the backend's own `*_display` string. */
  rate: number
  symbol: string
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

  // ONE axis, covering both money series. A null Incremental Sales is left out
  // of the extent entirely rather than counted as zero — see the bars below.
  const sales = groups.map((g) => g.incremental_sales).filter((v): v is number => v !== null)
  const rawMax = Math.max(1, ...sales, ...groups.map((g) => g.trade_spend))
  const rawMin = Math.min(0, ...sales)

  const step = columnNiceStep(
    (rawMin < 0 ? rawMax - rawMin : rawMax) / COLUMN_DIVISIONS,
  )
  const lo = rawMin < 0 ? Math.floor(rawMin / step) * step : 0
  let hi = lo + step * COLUMN_DIVISIONS
  // A negative floor can eat divisions the positive side still needs; extend
  // the axis rather than clipping a column at the top of the plot.
  while (hi < rawMax) hi += step

  const y = (v: number) => padT + innerH * (1 - (v - lo) / (hi - lo || 1))
  const zeroY = y(0)

  const ticks: number[] = []
  for (let t = lo; t <= hi + 1e-6; t += step) ticks.push(t)

  const slot = innerW / n
  // THIN marks. A saturated fill 30px wide reads as a block rather than as a
  // measurement; capped well below the slot so the pair sits inside its own
  // whitespace and the eye compares heights instead of areas.
  const barW = Math.max(7, Math.min(22, slot * 0.2))
  const gap = Math.max(4, barW * 0.26)
  const pairW = barW * 2 + gap
  const centreX = (i: number) => padL + slot * i + slot / 2
  const active = hover !== null && hover < n ? hover : null

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {/* A legend is always present: two series must never be identified by
          colour alone in the tooltip and nowhere else. */}
      <div className="mb-2 flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-ink-muted">
        <span className="inline-flex items-center gap-1.5">
          <span className="h-2.5 w-2.5 rounded-[2px]" style={{ background: SERIES.incremental }} />
          Incremental Sales
        </span>
        <span className="inline-flex items-center gap-1.5">
          <span className="h-2.5 w-2.5 rounded-[2px]" style={{ background: SERIES.spend }} />
          Trade Spend
        </span>
        <span className="ml-auto">ROI under each region</span>
      </div>

      <div ref={ref} className="relative min-h-[250px] w-full flex-1">
        <svg
          className="absolute inset-0"
          width={width}
          height={height}
          role="img"
          aria-label="Incremental Sales and Trade Spend by region"
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
                {money(t)}
              </text>
            </g>
          ))}

          {/* The zero line only exists when the axis crosses it. */}
          {lo < 0 && (
            <line x1={padL} x2={padL + innerW} y1={zeroY} y2={zeroY} stroke="var(--border-strong)" />
          )}

          {groups.map((g, i) => {
            const x1 = centreX(i) - pairW / 2
            const x2 = x1 + barW + gap
            const isActive = active === i

            /** A bar from the baseline to `v`. Null draws nothing at all — an
             *  unmeasurable Incremental Sales is not zero, and a zero-height
             *  column would claim it was. */
            const bar = (v: number | null, x: number, fill: string) => {
              if (v === null) return null
              const down = v < 0
              const top = Math.min(y(v), zeroY)
              const h = Math.max(Math.abs(y(v) - zeroY), v === 0 ? 0 : 2)
              if (h === 0) return null
              return (
                <path
                  d={columnPath(x, top, barW, h, down)}
                  fill={fill}
                  className="transition-opacity duration-150"
                  opacity={active === null || isActive ? 1 : 0.45}
                />
              )
            }

            const roi = g.roi

            return (
              <g key={g.code}>
                {/* Hover band, behind the columns. */}
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
                {bar(g.incremental_sales, x1, SERIES.incremental)}
                {bar(g.trade_spend, x2, SERIES.spend)}

                {/* SELECTIVE direct label: the primary series only. Trade Spend
                    is read off the axis beside it and named in the tooltip. */}
                <text
                  x={centreX(i)}
                  y={
                    g.incremental_sales !== null && g.incremental_sales < 0
                      ? Math.max(y(g.incremental_sales), zeroY) + 13
                      : Math.min(y(g.incremental_sales ?? 0), zeroY) - 7
                  }
                  textAnchor="middle"
                  fontSize={10.5}
                  fontWeight={700}
                  fill="var(--text-primary)"
                >
                  {g.incremental_sales === null ? '—' : g.incremental_sales_display}
                </text>

                {/* Axis band: the region, and its ROI as a direct label. */}
                <text
                  x={centreX(i)}
                  y={height - 21}
                  textAnchor="middle"
                  fontSize={11}
                  fontWeight={600}
                  fill="var(--text-primary)"
                >
                  {fitLabel(g.label, slot - 6)}
                </text>
                <text
                  x={centreX(i)}
                  y={height - 7}
                  textAnchor="middle"
                  fontSize={10}
                  fontWeight={700}
                  fill={
                    roi === null
                      ? 'var(--text-muted)'
                      : roi < 0
                        ? 'var(--status-danger)'
                        : 'var(--status-success)'
                  }
                >
                  {roi === null ? '—' : `${roi.toFixed(1)}%`}
                </text>

                {/* The hit area is the whole slot, not the columns. */}
                <rect
                  x={padL + slot * i}
                  y={0}
                  width={slot}
                  height={height}
                  fill="transparent"
                  onMouseEnter={() => setHover(i)}
                  onMouseLeave={() => setHover(null)}
                >
                  {/* Reaches assistive tech and survives a missing pointer. */}
                  <title>
                    {`${g.label}\nIncremental Sales: ${g.incremental_sales_display}\n` +
                      `Trade Spend: ${g.trade_spend_display}\n` +
                      `ROI: ${roi === null ? '—' : `${roi.toFixed(1)}%`}`}
                  </title>
                </rect>
              </g>
            )
          })}
        </svg>

        {active !== null && (
          <div
            className="pointer-events-none absolute top-1 z-20 w-52 rounded-[var(--r-md)] border border-border-default bg-surface-card p-2.5 text-xs shadow-[var(--shadow-lg)]"
            style={{ left: Math.min(Math.max(0, centreX(active) - 104), Math.max(0, width - 208)) }}
          >
            <div className="font-bold text-ink-primary">{groups[active].label}</div>
            <TipRow
              swatch={SERIES.incremental}
              k="Incremental Sales"
              v={groups[active].incremental_sales === null ? '—' : groups[active].incremental_sales_display}
            />
            <TipRow swatch={SERIES.spend} k="Trade Spend" v={groups[active].trade_spend_display} />
            <TipRow
              k="ROI"
              v={groups[active].roi === null ? '—' : `${groups[active].roi.toFixed(1)}%`}
            />
          </div>
        )}
      </div>
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
 *  Incremental Sales per geography, ranked, with Trade Spend riding underneath
 *  on the same money axis and ROI on every row — so a region that carries the
 *  most sales is never mistaken for the one that returns the most.
 *
 *  SCOPED BY THE PAGE FILTER BAR. It holds no controls of its own — Year,
 *  Month, Channel and everything under More Filters all come from the shared
 *  `commandFilters` store, through the same `toQuery` the KPI cards post with,
 *  so this card cannot describe a selection the rest of the page is not
 *  showing. That is `scope: 'page'` on the hook below.
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
  const { symbol } = useDisplay()
  const year = useCommandFilters((s) => s.filters.year)
  const month = useCommandFilters((s) => s.filters.month)
  const channel = useCommandFilters((s) => s.filters.channel)

  const q = useBreakdown('region', {
    metric: 'incremental_sales',
    limit: REGION_LIMIT,
    scope: 'page',
  })

  // The page's own option lists, already in flight for the filter bar — reused
  // here only to turn the selected month number and channel codes into the
  // names the bar itself shows. No second request, and no month or channel
  // name held in the frontend.
  const options = useFilterOptions()

  // The endpoint already ranks by the metric; sorting here keeps the card
  // correct if a future response arrives in another order, and dropping the
  // regions this scope left with nothing measurable beats drawing a
  // zero-length bar that reads as a real result.
  const rows = useMemo(
    () =>
      [...(q.data?.groups ?? [])]
        .filter((g) => g.incremental_sales !== null || g.trade_spend > 0)
        .sort(
          (a, b) =>
            (b.incremental_sales ?? 0) - (a.incremental_sales ?? 0) || b.trade_spend - a.trade_spend,
        ),
    [q.data],
  )

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

  return (
    <ChartFrame
      fill
      title="Sales by Region"
      hint={`Incremental Sales by geography, with Trade Spend and ROI alongside. Follows the page filter bar — every control on it, including Month and Channel under More Filters. Currently showing ${cut}.`}
      actions={
        rows.length > 0 ? (
          <span className="text-xs font-semibold text-ink-muted">
            {rows.length} region{rows.length === 1 ? '' : 's'}
          </span>
        ) : null
      }
      isLoading={q.isLoading}
      isFetching={q.isFetching}
      error={q.error}
      onRetry={() => void q.refetch()}
      isEmpty={rows.length === 0}
      emptyMessage={`No promotion activity in any region for ${cut}.`}
      footnote={`${rows.length} region${rows.length === 1 ? '' : 's'} ranked by Incremental Sales · ${cut}. A ranking, not a share — Incremental Sales is re-baselined per region, so the regions do not sum to the headline figure.`}
    >
      <RegionColumns groups={rows} rate={q.data?.meta.exchange_rate ?? 1} symbol={symbol} />
    </ChartFrame>
  )
}
