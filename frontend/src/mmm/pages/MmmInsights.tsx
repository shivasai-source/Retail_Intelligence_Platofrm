import { useState, type ReactNode } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { Button, Card, CardBody, CardHeader, Dropdown, IconButton, TpoKpiGrid, TpoKpiTile } from '../../components/ui'
import { InfoBlock, InfoPopover } from '../../components/ui/InfoPopover'
import { EmptyState, ErrorState, KpiSkeleton, PanelSkeleton, Stale } from '../../components/command/States'
import { HERO_TILE_CLASS } from '../../components/command/kpiDeckState'
import { SERIES } from '../../components/command/series'
import { ExportReportButton } from '../../components/reports/ExportReportButton'
import { AnalystButton } from '../../components/analyst/AnalystButton'
import { AnalystPanel } from '../../components/analyst/AnalystPanel'
import { Icon, type IconName } from '../../icons'
import { MmmShell } from '../components/MmmShell'
import { MmmAddKpiMenu } from '../components/MmmAddKpiMenu'
import { MmmFilterBar } from '../components/MmmFilterBar'
import { resolveYear } from '../components/MmmToolbar'
import { BREAKEVEN_ROAS, MMM_SERIES, MmmTrend, type MmmTrendSeries } from '../components/charts'
import { ChannelCard, ComparisonCard, DecompositionCard, EventsCard, PromotionsCard } from '../components/MmmPanels'
import { MmmPinnedChartCard } from '../components/MmmPinnedChartCard'
import { MMM_ANALYST } from '../analystModule'
import { useMmmHubLayout } from '../hubLayout'
import { useMmmFilterOptions, useMmmHub } from '../hooks'
import { MMM_ADDABLE_KPIS, MMM_HERO_KPIS } from '../kpiDeck'
import { MMM_ROUTES } from '../nav'
import { isCustomRange, toWire, useMmmView } from '../store'
import type { MmmHub, MmmKpi } from '../types'

// MMM — INSIGHTS HUB, built on TPO's Insights Hub template
// (pages/CommandCenter.tsx): title row; a toolbar with the scope filters on
// the left and Add KPI · Refresh · Export on the right; the three headline
// KPI tiles with any added beneath; the trend on a row of its own; then the
// panels in two columns. Every figure comes from GET /api/mmm/hub
// (backend/app/mmm/service.py) for the scope in ../store.ts.
//
// THE BASELINE IS PER RANGE. Baseline Revenue, Incremental Revenue and ROAS
// come from the formula in backend/app/mmm/baseline.py, re-estimated for
// whatever range the filters select, for each comparison period and for each
// point on the trend.
//
// THE ANALYST SITS ON THIS PAGE, as it does on TPO's: a launcher in the
// bottom-right corner, and a panel that shares the screen with the hub rather
// than covering it. It can answer questions about the MMM data AND change
// this page — the period, the trend's granularity, which charts and cards are
// on screen — and every change it makes is undoable. What it is allowed to
// name lives in backend/app/agents/mmm_layout.py, mirrored by ../mmmPanels.ts.
//
// WHICH CHARTS ARE ON SCREEN therefore comes from ../hubLayout.ts and not from
// this component's state: a panel that portals to <body> cannot reach a page's
// local state, and threading a setter down to it would make the Analyst a
// prop of the hub. The same goes for the added KPI cards and the trend's
// granularity.

const KPI_STYLE: Record<string, { icon: IconName; tint: string; accent: string }> = {
  // The headline three wear the tints of TPO's headline three: return, spend,
  // and the ratio of the two.
  revenue: { icon: 'barChart', tint: 'sky', accent: 'var(--tint-mint-icon)' },
  spend: { icon: 'wallet', tint: 'lavender', accent: 'var(--status-warning)' },
  roas: { icon: 'target', tint: 'violet', accent: 'var(--brand-violet)' },
  baseline: { icon: 'coins', tint: 'amber', accent: 'var(--brand-blue)' },
  incremental: { icon: 'uplift', tint: 'teal', accent: 'var(--tint-sky-icon)' },
  baseline_per_day: { icon: 'gauge', tint: 'mint', accent: 'var(--tint-teal-icon)' },
  avg_daily_revenue: { icon: 'trending', tint: 'peach', accent: 'var(--status-success)' },
  ad_lift: { icon: 'zap', tint: 'rose', accent: 'var(--tint-peach-icon)' },
  media_days: { icon: 'calendar', tint: 'lemon', accent: 'var(--tint-lemon-icon)' },
}
const FALLBACK_STYLE = { icon: 'gauge' as IconName, tint: 'lavender', accent: 'var(--brand-violet)' }

/** The ⓘ on each tile, as TPO writes its own: one line, the formula in terms
 *  of the other KPIs ("Incremental Sales ÷ Trade Spend"). The backend's `help`
 *  is the full derivation; it stays the fallback for a KPI not listed here. */
const KPI_FORMULA: Record<string, string> = {
  revenue: 'Σ Revenue over the days in scope',
  spend: 'Σ sub-channel spend (all channels = Total_Spend)',
  roas: 'Incremental Revenue ÷ Total Ad Spend',
  baseline: 'Avg Daily Baseline × days in scope',
  incremental: 'Total Revenue − Baseline Revenue',
  baseline_per_day: 'Baseline Revenue ÷ days in scope',
  avg_daily_revenue: 'Total Revenue ÷ days in scope',
  ad_lift: 'Revenue/day with ads − without, on Festival + Seasonal + Promo days',
  media_days: 'Count of days with Ad Spend > 0',
}

/** Ad spend, like TPO's Trade Spend, is not better for rising. */
const LOWER_IS_BETTER = new Set(['spend'])

/** The trend draws ad spend, ROAS and break-even only; revenue and the
 *  baseline are told by the Revenue Decomposition beside it. */
const TREND_SHOWN_ONLY = (hidden: ReadonlySet<MmmTrendSeries>): ReadonlySet<MmmTrendSeries> =>
  new Set<MmmTrendSeries>([...hidden, 'revenue', 'baseline'])

const GRANULARITIES = [
  { label: 'Weekly', value: 'week' as const },
  { label: 'Monthly', value: 'month' as const },
]

function KpiTile({ kpi, index, className }: { kpi: MmmKpi | undefined; index: number; className?: string }) {
  if (!kpi) return null
  const style = KPI_STYLE[kpi.key] ?? FALLBACK_STYLE
  return (
    <TpoKpiTile
      className={className}
      labelLines={2}
      label={kpi.label}
      value={kpi.display}
      delta={kpi.delta_display}
      deltaSub={kpi.available ? kpi.comparison || 'No matching earlier period' : kpi.unavailable_reason}
      trend={kpi.delta === null || kpi.delta === 0 ? null : kpi.delta > 0 ? 'up' : 'down'}
      icon={style.icon}
      tint={style.tint}
      accent={style.accent}
      delayMs={index * 60}
      info={{ name: kpi.label, formula: (kpi.attributed ? undefined : KPI_FORMULA[kpi.key]) ?? kpi.help, meaning: '' }}
      lowerIsBetter={LOWER_IS_BETTER.has(kpi.key)}
    />
  )
}

export function MmmInsights() {
  const view = useMmmView()
  const currency = view.currency
  const queryClient = useQueryClient()
  const options = useMmmFilterOptions()
  const [trendHidden, setTrendHidden] = useState<ReadonlySet<MmmTrendSeries>>(() => new Set())
  const [analystOpen, setAnalystOpen] = useState(false)

  // WHAT THE PAGE IS SHOWING — shared with the Analyst, which can change all
  // three. The legend's own show/hide stays local above: it is a way of
  // reading the trend, not part of what the hub is showing.
  const visibleCharts = useMmmHubLayout((s) => s.charts)
  const pinnedCharts = useMmmHubLayout((s) => s.pinned)
  const added = useMmmHubLayout((s) => s.cards)
  const setAdded = useMmmHubLayout((s) => s.setCards)
  const granularity = useMmmHubLayout((s) => s.granularity)
  const setGranularity = useMmmHubLayout((s) => s.setGranularity)

  // As TPO's Insights Hub: until the reader picks a year, open on the most
  // recent COMPLETED year in the data — never the year still in progress,
  // whose part-year totals would sit beside a full year on every YAGO
  // delta. Only a dataset holding nothing but the running year opens on it.
  // The hub is not asked anything until that is known, so it never fetches
  // "all years" first.
  const allYears = options.data?.years
  const completed = allYears?.filter((y) => y < new Date().getFullYear())
  const year = resolveYear(view.year, completed?.length ? completed : allYears)
  // The hub's scope is year · quarter · month, or a custom date range, plus
  // whatever the Analyst has narrowed it to. The week filter was removed from
  // the bar, so it is cleared here: a value left in the shared store must not
  // narrow the page with no control to undo it. The channel, promotion-type
  // and event filters ARE passed on, because the Analyst can set them and
  // every change it makes is reported and undoable.
  const scope = toWire({ ...view, week: null }, isCustomRange(view) ? null : year)
  const hub = useMmmHub(scope, granularity, currency, options.isSuccess)
  const data = hub.data
  const refreshing = hub.isFetching

  const kpiByKey = Object.fromEntries((data?.kpis ?? []).map((k) => [k.key, k])) as Record<string, MmmKpi | undefined>
  const toggleTrend = (key: MmmTrendSeries) =>
    setTrendHidden((prev) => {
      const next = new Set(prev)
      if (next.has(key)) next.delete(key)
      else next.add(key)
      return next
    })
  const shownGranularity = data?.trend.granularity ?? granularity
  const granularityLabel = GRANULARITIES.find((g) => g.value === shownGranularity)?.label ?? 'Monthly'
  const error = options.error ?? (hub.isError && !data ? hub.error : null)

  return (
    <MmmShell activeKey="insights" page="Insights Hub">
      <div className="cc-ambient" aria-hidden="true" />

      <div className="fade-in relative z-20">
        <div className="flex flex-wrap items-center justify-between gap-x-6 gap-y-3">
          <div className="min-w-0">
            <h1 className="text-2xl font-normal leading-[1.1] tracking-[-0.02em]">MMM Insights Hub</h1>
            <p className="mt-1.5 text-md text-ink-muted">
              Where marketing investment meets its return
              <span className="text-ink-disabled"> · </span>
              {data?.meta.period_label ?? 'Loading…'}
            </p>
          </div>
        </div>

        {/* THE TOOLBAR, IN TWO GROUPS, as TPO's: the scope on the left; on the
            right Add KPI, which changes the cards shown and never the scope,
            then a hairline, Refresh and Export.
            Both groups live inside MmmFilterBar's own surface, because a pill
            there expands that surface downwards rather than opening a menu
            over the KPI deck — see the note at the top of that file. */}
        <div className="mt-4">
          <MmmFilterBar
            options={options.data}
            year={year}
            actions={
              <>
                <MmmAddKpiMenu
                  kpis={data?.kpis}
                  selected={added}
                  onToggle={(key) => setAdded(added.includes(key) ? added.filter((k) => k !== key) : [...added, key])}
                  onClear={() => setAdded([])}
                />
                <span aria-hidden="true" className="mx-1 h-5 w-px shrink-0 bg-border-subtle" />
                <IconButton
                  icon="refresh"
                  className="!h-9 !w-9"
                  title="Refresh data"
                  spinning={refreshing}
                  disabled={refreshing}
                  onClick={() => void queryClient.invalidateQueries({ queryKey: ['mmm'] })}
                />
                <ExportReportButton
                  module="mmm-insights"
                  label="Export"
                  collapse
                  scope={() => ({})}
                  options={() => ({
                    filters: scope,
                    filename_hint: isCustomRange(view) ? 'Custom_range' : year === null ? 'All_years' : String(year),
                  })}
                  currency={currency}
                  reportsHref={MMM_ROUTES.reports}
                  disabled={!data || data.meta.days === 0}
                  disabledReason="Loading the MMM dataset…"
                />
              </>
            }
          />
        </div>
      </div>

      {error ? (
        <Card className="mt-[14px]">
          <ErrorState
            error={error}
            onRetry={() => {
              void options.refetch()
              void hub.refetch()
            }}
            retrying={options.isFetching || hub.isFetching}
          />
        </Card>
      ) : !data ? (
        <div className="mt-[14px]">
          <TpoKpiGrid>
            {MMM_HERO_KPIS.map((key, i) => (
              <KpiSkeleton key={key} delayMs={i * 50} className={HERO_TILE_CLASS} />
            ))}
          </TpoKpiGrid>
          <div className="mt-[14px]">
            <PanelSkeleton height={420} />
          </div>
        </div>
      ) : data.meta.days === 0 ? (
        <Card className="mt-[14px]">
          <EmptyState
            hint="This date range has no days of data. Pick another year or range."
            onClear={view.reset}
          />
        </Card>
      ) : (
        <Stale when={refreshing}>
          <div className="mt-[14px]">
            <TpoKpiGrid>
              {MMM_HERO_KPIS.map((key, i) => (
                <KpiTile key={key} kpi={kpiByKey[key]} index={i} className={HERO_TILE_CLASS} />
              ))}
            </TpoKpiGrid>
            {added.length > 0 && (
              <div className="mt-4">
                <TpoKpiGrid>
                  {/* In the page's own order, whatever order they were asked
                      for in — the store sorts them, so a card the Analyst
                      added lands where the menu would have put it. */}
                  {MMM_ADDABLE_KPIS.filter((k) => added.includes(k)).map((key, i) => (
                    <KpiTile key={key} kpi={kpiByKey[key]} index={i} />
                  ))}
                </TpoKpiGrid>
              </div>
            )}
          </div>

          {/* ---- THE CHARTS, as the reader (or the Analyst) arranged them ----

              One list, two to a row. The default list reproduces the three
              hardcoded rows this replaced, in the same order: spend and its
              return beside what the revenue is made of; then the channels
              beside the promotions; then the period comparison beside the
              events. Charts the Analyst pinned follow them.

              EVERY PANEL READS THE SAME SCOPE as the cards: what moved is
              which ones are drawn, never what they are scoped to. */}
          {rows([...visibleCharts, ...pinnedCharts.map((p) => p.id)]).map((ids) => (
            <div
              key={ids.join('+')}
              className="mt-[14px] grid grid-cols-2 gap-4 @max-[1000px]:grid-cols-1"
            >
              {ids.map((id) => (
                <div key={id} className="min-w-0">
                  {panel(id, {
                    data,
                    granularityLabel,
                    setGranularity,
                    trendHidden,
                    toggleTrend,
                    scope,
                    options: options.data,
                    currency,
                    pinned: pinnedCharts,
                  })}
                </div>
              ))}
            </div>
          ))}

          {/* Every chart hidden is a legitimate choice, but a page that simply
              ends under the cards reads as one that failed to load. */}
          {visibleCharts.length === 0 && pinnedCharts.length === 0 && (
            <div className="mt-[14px] rounded-[var(--r-lg)] border border-dashed border-border-strong p-7 text-center">
              <p className="text-base text-ink-secondary">No charts on the hub.</p>
              <p className="mt-1 text-sm text-ink-muted">
                Ask the Analyst to put them back — "show every chart again".
              </p>
            </div>
          )}
        </Stale>
      )}

      {/* OUTSIDE every branch above: a scope with no days is a perfectly good
          thing to ask the Analyst about, so the launcher and the panel have to
          survive that state. Both portal to <body> regardless of where they
          sit here. */}
      <AnalystButton onClick={() => setAnalystOpen(true)} open={analystOpen} />
      <AnalystPanel
        module={MMM_ANALYST}
        open={analystOpen}
        onClose={() => setAnalystOpen(false)}
        onOpen={() => setAnalystOpen(true)}
      />
    </MmmShell>
  )
}

/** The visible ids, two to a row. */
function rows(ids: string[]): string[][] {
  const out: string[][] = []
  for (let i = 0; i < ids.length; i += 2) out.push(ids.slice(i, i + 2))
  return out
}

interface PanelContext {
  data: MmmHub
  granularityLabel: string
  setGranularity: (g: 'week' | 'month') => void
  trendHidden: ReadonlySet<MmmTrendSeries>
  toggleTrend: (key: MmmTrendSeries) => void
  scope: ReturnType<typeof toWire>
  options: ReturnType<typeof useMmmFilterOptions>['data']
  currency: 'INR' | 'USD'
  pinned: ReturnType<typeof useMmmHubLayout.getState>['pinned']
}

/** WHAT EACH CHART IS, by the id the list refers to.
 *
 *  A function rather than a module-level table because every one of these
 *  closes over the page's own query and state — the trend alone needs the
 *  granularity, the legend and the payload. ../mmmPanels.ts holds what the
 *  Analyst and the store need instead: the ids and the labels.
 *
 *  An id that is not one of the six is a chart the Analyst pinned. */
function panel(id: string, ctx: PanelContext): ReactNode {
  const { data } = ctx
  switch (id) {
    case 'trend':
      return (
        <Card className="flex h-full flex-col">
          <CardHeader
            title={
              <span className="flex items-center gap-1.5">
                Ad Spend &amp; ROAS Trend
                <InfoPopover label="About Ad Spend & ROAS Trend" title="Ad Spend & ROAS Trend">
                  <InfoBlock label="Ad Spend">Total spent on ads in each period (left axis).</InfoBlock>
                  <InfoBlock label="ROAS">Extra revenue for every 1 spent (right axis).</InfoBlock>
                  <InfoBlock label="Break-even">1.00x — ads paid for themselves.</InfoBlock>
                  <InfoBlock label="Tip">Click a legend item to hide or show a line.</InfoBlock>
                </InfoPopover>
              </span>
            }
            actions={
              <Dropdown
                selected={ctx.granularityLabel}
                options={GRANULARITIES.map((g) => ({ label: g.label }))}
                onSelect={(picked) => {
                  const next = GRANULARITIES.find((g) => g.label === picked)
                  if (next) ctx.setGranularity(next.value)
                }}
                trigger={
                  <Button variant="ghost" size="sm" className="cursor-pointer">
                    {ctx.granularityLabel} <Icon name="chevronDown" />
                  </Button>
                }
              />
            }
          />
          <CardBody className="flex flex-1 flex-col">
            <div className="mb-2 flex flex-wrap items-center gap-4 pb-2">
              <LegendItem
                swatch={<span className="h-0.5 w-[18px] rounded-sm" style={{ background: MMM_SERIES.spend }} />}
                label={`Ad Spend (${data.meta.currency})`}
                on={!ctx.trendHidden.has('spend')}
                onToggle={() => ctx.toggleTrend('spend')}
              />
              <LegendItem
                swatch={<span className="h-0.5 w-[18px] rounded-sm" style={{ background: SERIES.roi }} />}
                label="ROAS"
                on={!ctx.trendHidden.has('roas')}
                onToggle={() => ctx.toggleTrend('roas')}
              />
              <LegendItem
                swatch={<span className="h-0 w-[18px] border-t-2 border-dotted" style={{ borderColor: MMM_SERIES.roas }} />}
                label={`Break-even (${BREAKEVEN_ROAS.toFixed(2)}x)`}
                on={!ctx.trendHidden.has('breakeven')}
                onToggle={() => ctx.toggleTrend('breakeven')}
              />
            </div>
            <MmmTrend
              trend={data.trend}
              rate={data.meta.exchange_rate}
              currency={data.meta.currency}
              hidden={TREND_SHOWN_ONLY(ctx.trendHidden)}
              height={330}
            />
          </CardBody>
        </Card>
      )
    case 'decomposition':
      return <DecompositionCard data={data} />
    case 'channel':
      return <ChannelCard data={data} />
    case 'promotions':
      return <PromotionsCard data={data} />
    case 'comparison':
      return (
        <ComparisonCard data={data} scope={ctx.scope} options={ctx.options} currency={ctx.currency} />
      )
    case 'events':
      return <EventsCard data={data} />
    default: {
      const chart = ctx.pinned.find((p) => p.id === id)
      return chart ? <MmmPinnedChartCard chart={chart} data={data} /> : null
    }
  }
}

function LegendItem({ swatch, label, on, onToggle }: { swatch: React.ReactNode; label: string; on: boolean; onToggle: () => void }) {
  return (
    <button
      type="button"
      aria-pressed={on}
      title={on ? `Hide ${label}` : `Show ${label}`}
      onClick={onToggle}
      className={`inline-flex cursor-pointer items-center gap-1.5 rounded-[var(--r-sm)] text-sm font-medium transition-[color,opacity] duration-150 hover:text-ink-primary focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-violet ${
        on ? 'text-ink-secondary' : 'text-ink-secondary opacity-40'
      }`}
    >
      {swatch}
      {label}
    </button>
  )
}
