import { useState } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { Button, Card, CardBody, CardHeader, Dropdown, IconButton, TpoKpiGrid, TpoKpiTile } from '../../components/ui'
import { InfoBlock, InfoPopover } from '../../components/ui/InfoPopover'
import { EmptyState, ErrorState, KpiSkeleton, PanelSkeleton, Stale } from '../../components/command/States'
import { HERO_TILE_CLASS } from '../../components/command/kpiDeckState'
import { SERIES } from '../../components/command/series'
import { ExportReportButton } from '../../components/reports/ExportReportButton'
import { Icon, type IconName } from '../../icons'
import { MmmShell } from '../components/MmmShell'
import { MmmAddKpiMenu } from '../components/MmmAddKpiMenu'
import { MmmFilterBar } from '../components/MmmFilterBar'
import { resolveYear } from '../components/MmmToolbar'
import { BREAKEVEN_ROAS, MMM_SERIES, MmmTrend, type MmmTrendSeries } from '../components/charts'
import { ChannelCard, ComparisonCard, EventsCard, PromotionsCard } from '../components/MmmPanels'
import { useMmmFilterOptions, useMmmHub } from '../hooks'
import { MMM_ADDABLE_KPIS, MMM_HERO_KPIS, readAddedMmmKpis, writeAddedMmmKpis } from '../kpiDeck'
import { MMM_ROUTES } from '../nav'
import { isCustomRange, toWire, useMmmView } from '../store'
import type { MmmKpi } from '../types'

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

/** Ad spend, like TPO's Trade Spend, is not better for rising. */
const LOWER_IS_BETTER = new Set(['spend'])

const GRANULARITIES = [
  { label: 'Daily', value: 'day' as const },
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
      info={{ name: kpi.label, formula: kpi.help, meaning: '' }}
      lowerIsBetter={LOWER_IS_BETTER.has(kpi.key)}
    />
  )
}

export function MmmInsights() {
  const view = useMmmView()
  const currency = view.currency
  const queryClient = useQueryClient()
  const options = useMmmFilterOptions()
  const [granularity, setGranularity] = useState<'day' | 'week' | 'month'>('month')
  const [trendHidden, setTrendHidden] = useState<ReadonlySet<MmmTrendSeries>>(() => new Set())
  const [added, setAddedState] = useState<string[]>(readAddedMmmKpis)
  const setAdded = (keys: string[]) => {
    const ordered = MMM_ADDABLE_KPIS.filter((k) => keys.includes(k))
    writeAddedMmmKpis(ordered)
    setAddedState(ordered)
  }

  // Opens on the latest year in the data, as before: until the reader picks
  // one, the year is the last in the file. The hub is not asked anything until
  // that is known, so it never fetches "all years" first.
  const year = resolveYear(view.year, options.data?.years)
  const scope = toWire(view, isCustomRange(view) ? null : year)
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
            <h1 className="text-2xl font-extrabold leading-[1.1] tracking-[-0.025em]">MMM Insights Hub</h1>
            <p className="mt-1.5 text-base text-ink-muted">
              Where marketing investment meets its return
              <span className="text-ink-disabled"> · </span>
              {data?.meta.period_label ?? 'Loading…'}
            </p>
          </div>
        </div>

        {/* THE TOOLBAR, IN TWO GROUPS, as TPO's: the scope on the left; on the
            right Add KPI, which changes the cards shown and never the scope,
            then a hairline, Refresh and Export. */}
        <div className="mt-4 flex items-start justify-between gap-3">
          <div className="min-w-0 flex-1">
            <MmmFilterBar options={options.data} year={year} />
          </div>
          <div className="flex shrink-0 items-center gap-1.5">
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
          </div>
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
            hint="No days in this period match the promotion type or event filter. Try removing one."
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
                  {added.map((key, i) => (
                    <KpiTile key={key} kpi={kpiByKey[key]} index={i} />
                  ))}
                </TpoKpiGrid>
              </div>
            )}
          </div>

          {/* The trend has the row to itself, as TPO's does. */}
          <div className="mt-[14px]">
            <Card>
              <CardHeader
                title={
                  <span className="flex items-center gap-1.5">
                    Ad Spend vs Revenue Trend
                    <InfoPopover label="About Ad Spend vs Revenue Trend" title="Ad Spend vs Revenue Trend">
                      <InfoBlock label="Revenue">Total sales in each period.</InfoBlock>
                      <InfoBlock label="Ad Spend">Total spent on ads in each period.</InfoBlock>
                      <InfoBlock label="Baseline">Sales you would have made with no ads.</InfoBlock>
                      <InfoBlock label="ROAS">Extra revenue for every 1 spent (right axis).</InfoBlock>
                      <InfoBlock label="Break-even">1.00x — ads paid for themselves.</InfoBlock>
                      <InfoBlock label="Tip">Click a legend item to hide or show a line.</InfoBlock>
                    </InfoPopover>
                  </span>
                }
                actions={
                  <Dropdown
                    selected={granularityLabel}
                    options={GRANULARITIES.map((g) => ({ label: g.label }))}
                    onSelect={(picked) => {
                      const next = GRANULARITIES.find((g) => g.label === picked)
                      if (next) setGranularity(next.value)
                    }}
                    trigger={
                      <Button variant="ghost" size="sm" className="cursor-pointer">
                        {granularityLabel} <Icon name="chevronDown" />
                      </Button>
                    }
                  />
                }
              />
              <CardBody>
                <div className="mb-2 flex flex-wrap items-center gap-4 pb-2">
                  <LegendItem
                    swatch={<span className="h-0.5 w-[18px] rounded-sm" style={{ background: MMM_SERIES.revenue }} />}
                    label={`Revenue (${data.meta.currency})`}
                    on={!trendHidden.has('revenue')}
                    onToggle={() => toggleTrend('revenue')}
                  />
                  <LegendItem
                    swatch={<span className="h-0.5 w-[18px] rounded-sm" style={{ background: MMM_SERIES.spend }} />}
                    label={`Ad Spend (${data.meta.currency})`}
                    on={!trendHidden.has('spend')}
                    onToggle={() => toggleTrend('spend')}
                  />
                  <LegendItem
                    swatch={<span className="h-0 w-[18px] border-t-2 border-dashed border-ink-muted" />}
                    label={`Baseline (${data.meta.currency})`}
                    on={!trendHidden.has('baseline')}
                    onToggle={() => toggleTrend('baseline')}
                  />
                  <LegendItem
                    swatch={<span className="h-0.5 w-[18px] rounded-sm" style={{ background: SERIES.roi }} />}
                    label="ROAS"
                    on={!trendHidden.has('roas')}
                    onToggle={() => toggleTrend('roas')}
                  />
                  <LegendItem
                    swatch={<span className="h-0 w-[18px] border-t-2 border-dotted" style={{ borderColor: MMM_SERIES.roas }} />}
                    label={`Break-even (${BREAKEVEN_ROAS.toFixed(2)}x)`}
                    on={!trendHidden.has('breakeven')}
                    onToggle={() => toggleTrend('breakeven')}
                  />
                  {granularity === 'day' && shownGranularity !== 'day' && (
                    <span className="ml-auto text-xs text-ink-muted">Daily is offered for ranges up to 400 days; showing weekly.</span>
                  )}
                </div>
                <MmmTrend trend={data.trend} rate={data.meta.exchange_rate} currency={data.meta.currency} hidden={trendHidden} height={400} />
              </CardBody>
            </Card>
          </div>

          <div className="mt-[14px] grid grid-cols-2 gap-4 @max-[1000px]:grid-cols-1">
            <ChannelCard data={data} />
            <PromotionsCard data={data} />
          </div>

          <div className="mt-[14px] grid grid-cols-2 gap-4 @max-[1000px]:grid-cols-1">
            <ComparisonCard data={data} scope={scope} options={options.data} currency={currency} />
            <EventsCard data={data} />
          </div>
        </Stale>
      )}
    </MmmShell>
  )
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
