import { useEffect, useState } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { AppShell } from '../components/layout/AppShell'
import {
  Button,
  Card,
  CardHeader,
  CardBody,
  TpoKpiGrid,
  TpoKpiTile,
  Dropdown,
  IconButton,
  useLiveStatus,
  useToast,
} from '../components/ui'
import { Icon, type IconName } from '../icons'
import { InfoBlock, InfoPopover } from '../components/ui/InfoPopover'
import { calendarYear } from '../lib/labels'
import { FilterBar } from '../components/command/FilterBar'
import { PromotionMixCard } from '../components/command/PromotionMixCard'
import { SalesComparisonCard } from '../components/command/SalesComparisonCard'
import { RiskAlertsPanel } from '../components/command/RiskAlertsPanel'
import { ALERT_FETCH_LIMIT, topPriorityAlert } from '../components/command/riskRanking'
import { EmptyState as CcEmptyState, ErrorState, KpiSkeleton, PanelSkeleton, Stale } from '../components/command/States'
import { MoreKpis } from '../components/command/MoreKpis'
import { SERIES_CLASS } from '../components/command/series'
import { PriorityAlert } from '../components/command/PriorityAlert'
import { HERO_TILE_CLASS, readMoreKpisOpen } from '../components/command/moreKpisState'
import { TrendPanels } from '../components/command/TrendPanels'
import {
  ChannelSection,
  ProductSection,
  PromotionTypeSection,
  PromotionContributionSection,
  SalesByRegionSection,
  TopPerformingSection,
} from '../components/command/ChartSections'
import {
  useFilterOptions,
  useKpis,
  usePromotionMix,
  useBreakdown,
  useRiskAlerts,
  useTrend,
} from '../hooks/useCommandCenter'
import { useCommandFilters } from '../store/commandFilters'
import { ExportReportButton } from '../components/reports/ExportReportButton'
// The SAME CommandFilters -> API filter-dict converter the Simulation Studio
// posts with. Reused rather than rewritten: a second implementation is how an
// export starts describing a different selection from the screen.
import { toSimulationFilters as toReportScope } from '../hooks/useSimulation'
import { useAlertHandoff } from '../hooks/useAlertHandoff'
import { fmtRoi } from '../lib/roi'
import type { KpiCard } from '../types/commandCenter'

const GRANULARITIES = [
  { label: 'Weekly', value: 'week' as const },
  { label: 'Monthly', value: 'month' as const },
]

// Presentation only — which glyph and tint each card wears. The label, value,
// formula and delta all come from the backend; nothing here computes or
// re-formats a KPI.
// `accent` is the hover rule along the card's bottom edge — one tone per KPI, so
// the six cards are distinguishable on hover without any of them shouting. Every
// value is an existing token from styles/tokens.css; no new colour is introduced,
// and none of them touches the KPI number, the icon or the card background.
const KPI_STYLE: Record<string, { icon: IconName; tint: string; accent: string }> = {
  trade_spend: { icon: 'wallet', tint: 'lavender', accent: 'var(--status-warning)' },
  incremental_sales: { icon: 'barChart', tint: 'sky', accent: 'var(--tint-mint-icon)' },
  promotion_roi: { icon: 'target', tint: 'violet', accent: 'var(--brand-violet)' },
  margin_impact: { icon: 'coins', tint: 'amber', accent: 'var(--brand-blue)' },
  pei: { icon: 'gauge', tint: 'mint', accent: 'var(--tint-teal-icon)' },
  cannibalization_rate: { icon: 'cannib', tint: 'rose', accent: 'var(--tint-peach-icon)' },
  // The second row (SecondaryKpis). Three tints and glyphs the first row
  // does not use, so a reader can tell the nine apart without reading.
  volume_uplift: { icon: 'uplift', tint: 'teal', accent: 'var(--tint-sky-icon)' },
  net_incremental_profit: { icon: 'trending', tint: 'peach', accent: 'var(--status-success)' },
  target_hit_rate: { icon: 'checkCircle', tint: 'lemon', accent: 'var(--tint-lemon-icon)' },
}

/** THE HEADLINE ROW: what was spent, what it returned, and the ratio of the
 *  two. Always on screen. */
const HERO_KPI_ORDER = ['trade_spend', 'incremental_sales', 'promotion_roi']

const FALLBACK_KPI_STYLE = { icon: 'gauge' as IconName, tint: 'lavender', accent: 'var(--brand-violet)' }

/** THE REST, behind the reveal (MoreKpis). The three remaining headline
 *  cards first, in their long-standing order, then the diagnostic three —
 *  volume (the demand response), the money it made after cost, and how many
 *  promotions cleared the bar. */
const MORE_KPI_ORDER = [
  'margin_impact',
  'pei',
  'cannibalization_rate',
  'volume_uplift',
  'net_incremental_profit',
  'target_hit_rate',
]

const LOWER_IS_BETTER = new Set(['trade_spend', 'cannibalization_rate'])

/** The evidence line for the Cannibalization card, or null for every other
 *  card. Uses the tile's existing sub-label slot rather than adding a row to
 *  a fixed-height tile. The comparable-event count is not shown. */
function cannibalizationSub(card: KpiCard): string | null {
  if (card.key !== 'cannibalization_rate') return null
  if (card.available) return null
  const wider = card.measured_at
  if (!wider) return null
  return `${wider.display_value} across ${wider.scope_label}`
}


/** One KPI card as a tile. Both rows render through this, so a card cannot
 *  be wired differently depending on where it sits. */
function KpiTile({
  card,
  index,
  className,
}: {
  card: KpiCard | undefined
  index: number
  className?: string
}) {
  if (!card) return null
  // A card the page has no glyph for (a KPI added on the backend before the
  // page learned its icon) still renders, in the neutral tint, rather than
  // taking the page down on `style.icon`.
  const style = KPI_STYLE[card.key] ?? FALLBACK_KPI_STYLE
  return (
    <TpoKpiTile
      className={className}
      labelLines={2}
      label={card.label}
      value={card.display_value}
      delta={card.delta_display}
      // Cannibalization carries its evidence: how many comparable events
      // stood behind the rate, or -- when this selection cannot support
      // one -- the narrowest wider scope that can, named so it is never
      // read as this selection's own figure.
      deltaSub={calendarYear(cannibalizationSub(card) ?? (card.available ? card.delta_sub : (card.unavailable_reason ?? card.delta_sub)))}
      trend={card.trend}
      icon={style.icon}
      tint={style.tint}
      accent={style.accent}
      delayMs={index * 60}
      info={card.info}
      unit={card.unit}
      lowerIsBetter={LOWER_IS_BETTER.has(card.key)}
      evidence={card.evidence}
    />
  )
}

export function CommandCenter() {
  const [granularity, setGranularity] = useState<'week' | 'month'>('week')
  const { show } = useToast()
  const live = useLiveStatus()
  const queryClient = useQueryClient()

  const initialise = useCommandFilters((s) => s.initialise)
  const initialised = useCommandFilters((s) => s.initialised)
  const reset = useCommandFilters((s) => s.reset)
  const targetRoi = useCommandFilters((s) => s.targetRoi)
  /** The RCA hand-off for a risk alert. EXTRACTED to hooks/useAlertHandoff.ts
   *  so the header's notification bell opens the same investigation this page's
   *  own alert rows open — one definition, not two that can drift. Behaviour is
   *  unchanged; see that file for why the week and the display names stay
   *  labels rather than filters.
   *
   *  Called HERE, with the other hooks: this component returns early while the
   *  filters and KPIs are loading, so a hook called further down would run in
   *  some renders and not others.
   */
  const handOffAlert = useAlertHandoff()

  const options = useFilterOptions()
  const kpis = useKpis()
  const trend = useTrend(granularity)
  const alerts = useRiskAlerts(ALERT_FETCH_LIMIT)
  // Both metrics per SCHEME for the Promotion Mix toggle.
  //
  // Was `by=promotion`, which is why the 20% seasonal scheme never appeared
  // here: it is not one offer but six (PBNY24 … PBDI24), so the largest
  // scheme in 2024 was split into six slices each smaller than the 5%
  // Discount slice and was never named. `by=promotion_mechanic` groups them on
  // dim_promotion.Promotion_Name, which is what the Promotion Contribution
  // card already does. 50 comfortably exceeds the five schemes.
  const mixBreakdown = useBreakdown('promotion_mechanic', { limit: 50 })
  const mix = usePromotionMix()

  // Default the period to the most recent COMPLETED year the data contains --
  // never a hardcoded year a future extract might not have, and not the year
  // still in progress: F26 holds January to August, and opening on it put
  // eight months of spend beside twelve on every "vs F25" delta. Only when
  // the data holds nothing but the running year does that year open.
  useEffect(() => {
    const years = options.data?.years
    if (!years?.length) return
    const completed = years.filter((y) => y < new Date().getFullYear())
    initialise(Math.max(...(completed.length ? completed : years)))
  }, [options.data?.years, initialise])

  const crumbs = [{ label: 'TPO Intelligence' }, { label: 'Insights Hub' }]

  const refreshing = kpis.isFetching || trend.isFetching || alerts.isFetching || mix.isFetching

  const handleRefresh = () => {
    show('Refreshing all data sources...', { duration: 1500 })
    queryClient.invalidateQueries({ queryKey: ['command-center'] }).then(() => {
      live.reset()
      show('Data refreshed · all systems healthy', { duration: 2000 })
    })
  }

  // First load: lay out the real grid in skeleton form so the page does not
  // jump when data lands, and so nothing reads as a value before it is one.
  // `initialised` is part of the condition, not just a nicety: the data queries
  // are disabled until the default year is known, so `kpis.isLoading` is false
  // in that window and the page would fall through to the error branch.
  if (!initialised || options.isLoading || kpis.isLoading) {
    return (
      <AppShell activeKey="command" crumbs={crumbs}>
        <div className="relative">
          <div className="cc-ambient" aria-hidden="true" />
          <div className="flex items-end justify-between gap-4">
            <div>
              <h1 className="text-2xl font-extrabold leading-[1.1] tracking-[-0.025em]">TPO Insights Hub</h1>
              <p className="mt-1.5 text-base text-ink-muted">Loading the latest promotion performance…</p>
            </div>
          </div>
          <div className="mt-[14px]">
            <TpoKpiGrid>
              {HERO_KPI_ORDER.map((key, i) => (
                <KpiSkeleton key={key} delayMs={i * 50} className={HERO_TILE_CLASS} />
              ))}
            </TpoKpiGrid>
            {/* A reader who left the rest open gets its skeleton too, so the
                page lands in the shape it will keep. */}
            {readMoreKpisOpen() && (
              <div className="mt-[46px]">
                <TpoKpiGrid>
                  {MORE_KPI_ORDER.map((key, i) => (
                    <KpiSkeleton key={key} delayMs={150 + i * 50} />
                  ))}
                </TpoKpiGrid>
              </div>
            )}
          </div>
          <span className="sr-only" role="status">Loading Insights Hub</span>
        </div>
      </AppShell>
    )
  }

  const error = options.error ?? kpis.error
  if (error || !kpis.data || !options.data) {
    return (
      <AppShell activeKey="command" crumbs={crumbs}>
        <ErrorState
          error={error ?? new Error('No data returned')}
          retrying={options.isFetching || kpis.isFetching}
          onRetry={() => {
            void options.refetch()
            void kpis.refetch()
          }}
        />
      </AppShell>
    )
  }

  const meta = kpis.data.meta
  // Every card by key, headline and diagnostic alike. The backend keeps the
  // two under separate keys so its other readers see exactly the six they
  // always did; the page reads them as one set.
  const allCards: Record<string, KpiCard | undefined> = { ...kpis.data.kpis, ...(kpis.data.secondary ?? {}) }
  // Highest-priority risk in the CURRENT scope: Critical before High before
  // Medium, then worst ROI, then largest stake. Derived from the data, so it
  // follows every filter change and names no promotion in code.
  const headline = topPriorityAlert(alerts.data?.alerts)

  // No rows for this filter combination. Show the filter bar (so the user can
  // undo it) and say so plainly — never a grid of "0"s, which would read as a
  // genuine result.
  const isEmpty = meta.row_count === 0


  return (
    <AppShell activeKey="command" crumbs={crumbs}>
      {/* Decorative ambient wash behind the header — the "lights" feel, kept to
          two very low-alpha radial gradients. */}
      <div className="cc-ambient" aria-hidden="true" />
      {/* `relative z-20` so the More Filters popover inside this row can paint
          over the KPI cards and alert banner below it. It is needed because
          `.fade-in` animates opacity and therefore ESTABLISHES A STACKING
          CONTEXT — which traps the popover's own z-index inside this row, and
          the row would otherwise paint in normal document order, i.e. beneath
          its later siblings. Same trap components/ui/Dropdown.tsx documents.
          No effect while the popover is closed: nothing else here overlaps. */}
      <div className="fade-in relative z-20">
        {/* THE TITLE ROW: the page's name and what it is looking at on the
            left; its one leading alert on the right, where a reader looks for
            status first. The toolbar is its own row beneath. */}
        <div className="flex flex-wrap items-center justify-between gap-x-6 gap-y-3">
          <div className="min-w-0">
            <h1 className="text-2xl font-extrabold tracking-[-0.025em] leading-[1.1]">TPO Insights Hub</h1>
            {/* ONE SHORT LINE under the title: what this page is for, in
                seven words, and the period it is showing. The scope's own
                numbers live in the cards and panels -- a command centre's
                header should not be the first thing a reader has to read. */}
            <p className="mt-1.5 text-base text-ink-muted">
              Where promotion spend meets its return
              <span className="text-ink-disabled"> · </span>
              {calendarYear(meta.period)}
            </p>
          </div>
          {headline && !isEmpty && (
            <div className="ml-auto">
              <PriorityAlert alert={headline} onOpen={() => handOffAlert(headline)} />
            </div>
          )}
        </div>

        {/* THE TOOLBAR: every control that changes what the page shows on
            the left, Export pinned to the right. The outer row never wraps;
            when the width runs out the FILTER GROUP wraps inside itself, so
            Export keeps its corner instead of dropping to a line of its own. */}
        <div className="mt-4 flex items-start justify-between gap-3">
          <div className="min-w-0 flex-1">
            <FilterBar
              options={options.data}
              onRefresh={handleRefresh}
              refreshing={refreshing}
              // `current` is the STORE's value, not the payload's: the pill flips
              // the moment the reader applies a target, while the panels catch
              // up behind the Stale wash. The default and bounds are the
              // backend's, so nothing here hard-codes 1.5.
              target={{ current: targetRoi ?? meta.default_target_roi, defaultValue: meta.default_target_roi, range: meta.target_roi_range }}
              refreshInline={false}
            />
          </div>
          {/* EXPORTS WHAT THE SCREEN IS SHOWING. `scope` is read at click time
              from the same `commandFilters` store every card, chart and table on
              this page reads, so a report can never describe a different
              selection from the one on screen. */}
          <div className="flex shrink-0 items-center gap-2">
            <IconButton icon="refresh" className="!h-9 !w-9" title="Refresh data" spinning={refreshing} disabled={refreshing} onClick={handleRefresh} />
            <ExportReportButton
              module="command-center"
              label="Export"
              scope={() => toReportScope(useCommandFilters.getState().filters)}
              currency={meta.currency}
              disabled={isEmpty}
              disabledReason="This filter selection matches no sales rows, so there is nothing to report."
            />
          </div>
        </div>
      </div>

      {isEmpty ? (
        <Card className="mt-[14px]">
          <CcEmptyState
            hint="Try removing a filter, or clear them all to return to the full scope."
            onClear={reset}
          />
        </Card>
      ) : (
      <>
      <Stale when={refreshing}>
      <div className="mt-[14px]">
        <TpoKpiGrid>
          {HERO_KPI_ORDER.map((key, i) => (
            <KpiTile key={key} card={allCards[key]} index={i} className={HERO_TILE_CLASS} />
          ))}
        </TpoKpiGrid>

        {/* THE REST. Same tile, same backend card shape, same filter scope;
            only the reveal is new. Every value, delta and formula still
            comes from the backend — see MoreKpis for the fold. */}
        <MoreKpis>
          {MORE_KPI_ORDER.map((key, i) => (
            <KpiTile key={key} card={allCards[key]} index={i} />
          ))}
        </MoreKpis>
      </div>

      <div className="mt-[14px] grid grid-cols-[minmax(0,1.7fr)_minmax(0,1fr)] gap-4 @max-[1000px]:grid-cols-1">
        <Card>
          <CardHeader
            title={
              <span className="flex items-center gap-1.5">
                Promotion Performance Trend
                <InfoPopover label="About Promotion Performance Trend" title="Promotion Performance Trend">
                  <InfoBlock label="Incremental Sales">Actual Sales − Baseline Sales</InfoBlock>
                  <InfoBlock label="Trade Spend">Discount Value + Promotion Cost</InfoBlock>
                  <InfoBlock label="ROI">Incremental Sales ÷ Trade Spend — 1.00 is break-even</InfoBlock>
                  <InfoBlock label="Target ROI">{fmtRoi(meta.target_roi)}</InfoBlock>
                </InfoPopover>
              </span>
            }
            actions={
              <Dropdown
                selected={GRANULARITIES.find((g) => g.value === granularity)?.label ?? 'Weekly'}
                options={GRANULARITIES.map((g) => ({ label: g.label }))}
                onSelect={(picked) => {
                  const next = GRANULARITIES.find((g) => g.label === picked)
                  if (next) setGranularity(next.value)
                }}
                trigger={
                  <Button variant="ghost" size="sm" className="cursor-pointer">
                    {GRANULARITIES.find((g) => g.value === granularity)?.label} <Icon name="chevronDown" />
                  </Button>
                }
              />
            }
          />
          <CardBody>
            {/* Three business series, all lines, plus the dashed reference. The
                swatches mirror the stroke colours in TrendPanels. */}
            <div className="mb-2 flex flex-wrap gap-4 pb-2">
              <LegendItem swatch={<span className="h-0.5 w-[18px] rounded-sm bg-brand-violet" />} label={`Incremental Sales (${meta.currency})`} />
              <LegendItem swatch={<span className={`h-0.5 w-[18px] rounded-sm ${SERIES_CLASS.spend}`} />} label={`Trade Spend (${meta.currency})`} />
              <LegendItem swatch={<span className="h-0.5 w-[18px] rounded-sm" style={{ background: 'var(--tint-teal-icon)' }} />} label="ROI" />
              <LegendItem
                swatch={<span className="h-0 w-[18px] border-t-2 border-dashed border-ink-muted" />}
                label={`Target ROI (${fmtRoi(meta.target_roi)})`}
              />
            </div>
            {trend.isLoading ? (
              <PanelSkeleton height={300} />
            ) : trend.error ? (
              <ErrorState error={trend.error} onRetry={() => void trend.refetch()} retrying={trend.isFetching} compact />
            ) : trend.data && trend.data.labels.length > 0 ? (
              <Stale when={trend.isFetching}>
                {/* Symbol AND rate both come from the trend response. Taking
                    the symbol from the KPI response instead let the two
                    disagree mid-switch — the axis briefly rendered ₹ against
                    USD-converted numbers while the slower query settled. */}
                <TrendPanels
                  data={trend.data}
                  rate={trend.data.meta.exchange_rate}
                  symbol={trend.data.meta.currency === 'USD' ? '$' : '₹'}
                  granularity={granularity}
                  /* Sized to the height the grid row actually gives this card
                     (its Risk Alerts sibling drives it). At the previous 320
                     the plot stopped ~88px short of the card's own border; 408
                     left 30px once the card chrome tightened. */
                  height={438}
                />
              </Stale>
            ) : (
              <CcEmptyState compact message="No promotions in this selection." />
            )}
          </CardBody>
        </Card>

        {/* One row per promotion EVENT -- a promotion on one product, in one
            channel, in one business week -- whose ROI sits below the target.
            Named for that grain: "Underperforming Promotions" is already the
            table the Simulation context bar hands off from, and a promotion
            can be above target overall while one of its events is not. */}
        <Card className="flex flex-col">
          <CardHeader
            title="Promotion Events Below ROI Target"
            /* The "N of M at target" count lives on the severity strip below
               (RiskAlertsPanel), not here: beside this title it pushed the
               title onto two lines at the card's width, and the header grew
               past the trend card's so the two dividers no longer met. */
            actions={
              <div className="flex items-center gap-2">
                <InfoPopover label="About promotion events below ROI target" title="How events are banded">
                  <InfoBlock label="Event">
                    One promotion on one product, in one channel, in one business week
                  </InfoBlock>
                  <InfoBlock label="Severity">
                    Critical &lt; {fmtRoi(meta.severity_bands.critical)}
                    <br />
                    High {fmtRoi(meta.severity_bands.critical)}–{fmtRoi(meta.severity_bands.high)}
                    <br />
                    Medium {fmtRoi(meta.severity_bands.high)}–{fmtRoi(meta.target_roi)}
                    <br />
                    Target ≥ {fmtRoi(meta.target_roi)}
                  </InfoBlock>
                  <InfoBlock label="Ranking">
                    Highest stake first
                    <br />
                    ROI as tie-breaker
                  </InfoBlock>
                </InfoPopover>
              </div>
            }
          />
          {alerts.data && alerts.data.alerts.length > 0 ? (
            <RiskAlertsPanel
              data={alerts.data}
              onSelect={(a) => {
                show(`Investigating "${a.title}"…`, { duration: 1500 })
                window.setTimeout(() => handOffAlert(a), 700)
              }}
            />
          ) : (
            <CardBody className="px-5 py-1.5">
              <EmptyState message="Every promotion event in this selection is at or above target." />
            </CardBody>
          )}
        </Card>
      </div>

      {/* Sales by Region gives up the wide column it used to have: an even
          split leaves the comparison card room for two full-width bars and
          their labels, and the region list reads fine at half width. */}
      <div className="mt-[14px] grid grid-cols-2 gap-4 @max-[1000px]:grid-cols-1">
        <SalesByRegionSection />
        <SalesComparisonCard />
      </div>

      {/* ---- Chart sections. Each reads the same filter state as the cards. ---- */}
      <div className="mt-[14px] grid grid-cols-2 gap-4 @max-[1000px]:grid-cols-1">
        <PromotionMixCard
          mix={mix.data}
          breakdown={mixBreakdown.data}
          tradeSpendTotal={kpis.data.kpis.trade_spend?.display_value ?? '—'}
          incrementalSalesTotal={kpis.data.kpis.incremental_sales?.display_value ?? '—'}
          emptyState={<EmptyState message="No promotional spend in this selection." />}
        />
        <ChannelSection />
      </div>
      <div className="mt-[14px] grid grid-cols-2 gap-4 @max-[1000px]:grid-cols-1">
        <TopPerformingSection />
        <PromotionContributionSection />
      </div>
      <div className="mt-[14px] grid grid-cols-[minmax(0,1.7fr)_minmax(0,1fr)] gap-4 @max-[1000px]:grid-cols-1">
        <ProductSection />
        <PromotionTypeSection />
      </div>
      </Stale>
      </>
      )}
    </AppShell>
  )
}

function LegendItem({ swatch, label }: { swatch: React.ReactNode; label: string }) {
  return (
    <span className="inline-flex items-center gap-1.5 text-sm font-medium text-ink-secondary">
      {swatch}
      {label}
    </span>
  )
}

/** Shown when a filter combination genuinely has no data. Saying so is the
 *  point — the alternative is a chart of zeros that reads as a real result. */
function EmptyState({ message }: { message: string }) {
  return <div className="grid min-h-[120px] place-items-center px-4 text-center text-sm text-ink-muted">{message}</div>
}
