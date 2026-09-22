import { useMemo } from 'react'
import { keepPreviousData, useQuery } from '@tanstack/react-query'
import { apiFetch } from '../lib/api'
import { SEVERITY_BANDS } from '../lib/roi'
import { toQuery, useCommandFilters, type CommandFilters } from '../store/commandFilters'
import type {
  BreakdownDimension,
  BreakdownMetric,
  BreakdownResponse,
  Currency,
  FiltersResponse,
  KpiResponse,
  PromotionMixResponse,
  RiskAlertsResponse,
  SalesComparisonResponse,
  TopPromotionsResponse,
  TrendResponse,
  UnderperformingResponse,
} from '../types/commandCenter'

/** TWO SCOPES, DELIBERATELY.
 *
 *  KPI CARDS answer "what do the numbers look like for exactly this
 *  selection", so they receive the FULL global filter payload — year, channel,
 *  retailer and everything under More Filters.
 *
 *  CHARTS answer "how did promotions behave over the year", and each carries
 *  its own local control (granularity, discount level, severity, metric) for
 *  the cut it is about. They receive ONLY `{year, currency}` plus that chart's
 *  own parameters. Their query strings are assembled explicitly rather than by
 *  walking the filter object, so a dimension cannot leak in: what is not named
 *  is not sent.
 *
 *  That split is the whole point — the detailed dimensions are what make a
 *  chart request expensive, and they are exactly what the charts do not use.
 *  It also means chart caches survive a Channel or Product change untouched.
 *
 *  Every query keys off the scope it actually uses, so React Query refetches
 *  precisely the panels a given filter can affect and no others.
 */
function useScope() {
  const filters = useCommandFilters((s) => s.filters)
  const year = useCommandFilters((s) => s.filters.year)
  const currency = useCommandFilters((s) => s.currency)
  // The default year is only known once /filters has answered. Until then the
  // store still reads `year: null`, which is a VALID scope (All Years) — so
  // without this gate every panel would fetch the whole two-year dataset and
  // then immediately refetch the real year, doubling first-load traffic.
  const initialised = useCommandFilters((s) => s.initialised)
  const targetRoi = useCommandFilters((s) => s.targetRoi)
  return { filters, year, currency, targetRoi, enabled: initialised }
}

/** THE TARGET EVERY ROI ON THE PAGE IS JUDGED AGAINST.
 *
 *  The reader's value from the store when one is set, else the backend's
 *  configured default as every payload's `meta.default_target_roi` reports
 *  it. Read this rather than a payload's own `meta.target_roi`: only the
 *  requests that need the target send it (KPIs, trend, alerts, the ranked
 *  promotion lists), so a breakdown's meta still names the default even
 *  while the reader has set 1.75 -- and a chart that coloured its ROIs by
 *  that would disagree with the cards above it. */
export function useTargetRoi(meta?: { default_target_roi: number } | null): number {
  const set = useCommandFilters((s) => s.targetRoi)
  return set ?? meta?.default_target_roi ?? SEVERITY_BANDS.medium
}

/** Options every Insights Hub query shares.
 *
 *  `staleTime: Infinity` because the answer to a given scope cannot change
 *  while the process runs: the star schema is read once and every figure is
 *  a pure function of it, so refetching on a return to the page only repeats
 *  work. The two events that DO change the answer already invalidate the
 *  cache — installing a dataset (`useDatasets` calls `invalidateQueries()`)
 *  and the page's own Refresh button (`['command-center']`).
 *
 *  `placeholderData` keeps the previous scope's payload on screen while the
 *  next one loads, so a filter or currency change re-labels the cards rather
 *  than blanking them. */
const CACHED = { staleTime: Infinity, placeholderData: keepPreviousData } as const

/** `year` omitted entirely means All Years — the backend reads an absent year
 *  as unconstrained and aggregates 2024 + 2025 through the same KPI logic. It
 *  is never sent as an empty string, which would be a different request. */
function commandQuery(
  year: number | null,
  currency?: Currency,
  extra?: Record<string, string | number | string[] | undefined>,
  targetRoi?: number | null,
): string {
  const params = new URLSearchParams()
  if (year !== null && year !== undefined) params.set('year', String(year))
  if (currency) params.set('currency', currency)
  if (targetRoi !== null && targetRoi !== undefined) params.set('target_roi', String(targetRoi))
  for (const [k, v] of Object.entries(extra ?? {})) {
    if (v === undefined) continue
    // A list is REPEATED, not joined: the API models every list filter as
    // `?key=a&key=b` (routers/command_center.ListParam), which is how one
    // promotion mechanic made of six offers is expressed with no new contract.
    if (Array.isArray(v)) v.forEach((item) => params.append(k, item))
    else params.set(k, String(v))
  }
  return params.toString()
}

/** Cache key for a chart: the year scope only, so a Channel or Product change
 *  cannot invalidate it. */
function key(name: string, year: number | null, currency?: Currency, targetRoi?: number | null) {
  return ['command-center', name, year ?? 'all', currency ?? null, targetRoi ?? null] as const
}

/** Cache key for a KPI-scoped query: every filter, because every filter moves
 *  the answer. */
function fullKey(name: string, filters: CommandFilters, currency?: Currency, targetRoi?: number | null) {
  return ['command-center', name, filters, currency ?? null, targetRoi ?? null] as const
}

export function useKpis() {
  const { filters, currency, targetRoi, enabled } = useScope()
  return useQuery({
    queryKey: fullKey('kpis', filters, currency, targetRoi),
    queryFn: () => apiFetch<KpiResponse>(`/command-center/kpis?${toQuery(filters, currency, targetRoi)}`),
    enabled,
    ...CACHED,
  })
}

/** Filter options depend on the selection but never on the currency — asking
 *  for them per currency would double the cache for identical answers. */
/** Filter options depend on the whole selection — that is what makes the
 *  dropdowns cascade — but never on the currency. */
export function useFilterOptions() {
  const filters = useCommandFilters((s) => s.filters)
  return useFilterOptionsFor(filters)
}

/** The same cascading option lists for a filter state held elsewhere — the
 *  Simulation Studio's own store. Same endpoint, same cache key shape. */
export function useFilterOptionsFor(filters: CommandFilters) {
  return useQuery({
    queryKey: fullKey('filters', filters),
    queryFn: () => apiFetch<FiltersResponse>(`/command-center/filters?${toQuery(filters)}`),
    ...CACHED,
  })
}

/** Every channel in the dataset as `code -> display name`, read from
 *  dim_channel through the options payload.
 *
 *  DELIBERATELY UNFILTERED, unlike `useFilterOptions`. That hook narrows its
 *  lists to the current selection, which is what a control wants and exactly
 *  what a LABEL does not: a scope saved earlier can name a channel the user
 *  has since filtered out, and it would then render as a raw "CH006" instead
 *  of its name. Asking for the whole roster means a label never depends on
 *  what happens to be selected now.
 *
 *  Nothing here enumerates channels. Adding a channel to dim_channel makes it
 *  appear everywhere this map is used, with no code change.
 */
export function useChannelNames(): Record<string, string> {
  const query = useQuery({
    queryKey: ['command-center', 'channel-names'],
    queryFn: () => apiFetch<FiltersResponse>('/command-center/filters'),
    staleTime: Infinity,
  })
  return useMemo(() => {
    const names: Record<string, string> = {}
    for (const channel of query.data?.channels ?? []) names[channel.code] = channel.name
    return names
  }, [query.data])
}

/** Sales Performance Comparison — one month against MAGO, YAGO and YTD.
 *
 *  PAGE SCOPE plus its own period. The full filter payload goes up, so the
 *  card moves with Channel, Region and the rest exactly like the KPI cards.
 *  The PERIOD, though, is the card's own: it is sent as `period_year` /
 *  `period_month` and the backend lifts the shared year/month/week before
 *  aggregating, because the comparisons reach outside the selected period by
 *  definition — inheriting a year filter would empty the year-ago figure that
 *  is the entire point of the card.
 *
 *  `period` null means "the latest month with data", which the response then
 *  reports back as `period`. */
export function useSalesComparison(period: { year: number; month: number } | null) {
  const { filters, currency, enabled } = useScope()
  const query = toQuery(filters, currency)
  const own = period ? `&period_year=${period.year}&period_month=${period.month}` : ''
  return useQuery({
    queryKey: [
      ...fullKey('sales-comparison', filters, currency),
      period?.year ?? null,
      period?.month ?? null,
    ],
    queryFn: () =>
      apiFetch<SalesComparisonResponse>(`/command-center/sales-comparison?${query}${own}`),
    enabled,
    ...CACHED,
  })
}

export function useTrend(granularity: 'week' | 'month') {
  const { year, currency, targetRoi, enabled } = useScope()
  return useQuery({
    queryKey: [...key('trend', year, currency, targetRoi), granularity],
    queryFn: () =>
      apiFetch<TrendResponse>(`/command-center/trend?${commandQuery(year, currency, { granularity }, targetRoi)}`),
    enabled,
    ...CACHED,
  })
}

export function useRiskAlerts(limit = 20) {
  const { year, currency, targetRoi, enabled } = useScope()
  return useQuery({
    queryKey: [...key('risk-alerts', year, currency, targetRoi), limit],
    queryFn: () =>
      apiFetch<RiskAlertsResponse>(`/command-center/risk-alerts?${commandQuery(year, currency, { limit }, targetRoi)}`),
    enabled,
    ...CACHED,
  })
}

export function useUnderperforming(limit = 20) {
  const { year, currency, targetRoi, enabled } = useScope()
  return useQuery({
    queryKey: [...key('underperforming', year, currency, targetRoi), limit],
    queryFn: () =>
      apiFetch<UnderperformingResponse>(
        `/command-center/underperforming-promotions?${commandQuery(year, currency, { limit }, targetRoi)}`,
      ),
    enabled,
    ...CACHED,
  })
}

export function usePromotionMix() {
  const { year, currency, enabled } = useScope()
  return useQuery({
    queryKey: key('promotion-mix', year, currency),
    queryFn: () =>
      apiFetch<PromotionMixResponse>(`/command-center/promotion-mix?${commandQuery(year, currency)}`),
    enabled,
    ...CACHED,
  })
}

/** ONE hook for every ranking and scatter chart.
 *
 *  Deliberately not one hook per dimension: the filter state, currency and
 *  cache key are identical in each case, and duplicating them is how a chart
 *  ends up quietly querying a different scope from the KPI cards. */
export function useBreakdown(
  by: BreakdownDimension,
  {
    metric = 'incremental_sales',
    limit = 10,
    promotion,
    scope = 'chart',
    enabled: callerEnabled = true,
  }: {
    metric?: BreakdownMetric
    limit?: number
    /** One offer code, or the set of codes behind one promotion mechanic —
     *  a chart-level scope (the Channel card's mechanic), not a global filter. */
    promotion?: string | string[]
    /** Which selection this chart answers for.
     *
     *  'chart' (the default) is the split described at the top of this file:
     *  year and currency plus the chart's own parameters, nothing else.
     *
     *  'page' is the KPI cards' scope — the FULL filter payload, so the card
     *  moves with every control in the filter bar. Used by the cards that are
     *  meant to read as a cut of the headline numbers rather than as a
     *  standing view of the year. It costs a refetch on any filter change,
     *  which is the price of agreeing with the cards above it. */
    scope?: 'chart' | 'page'
    /** Hold the request until the caller has what it needs to scope it. */
    enabled?: boolean
  } = {},
) {
  const { filters, year, currency, enabled } = useScope()
  // Besides year, a 'chart'-scoped request sends ONLY the parameters named
  // here, so a card that does not name a dimension does not send it and its
  // cache survives a change to that filter untouched. A 'page'-scoped request
  // sends the same payload the KPI cards do, through the same `toQuery`.
  const chartParams = { by, metric, limit, promotion }
  const query =
    scope === 'page'
      ? `${toQuery(filters, currency)}&${commandQuery(null, undefined, chartParams)}`
      : commandQuery(year, currency, chartParams)
  return useQuery({
    queryKey:
      scope === 'page'
        ? [...fullKey('breakdown', filters, currency), by, metric, limit, promotion ?? null]
        : [...key('breakdown', year, currency), by, metric, limit, promotion ?? null],
    queryFn: () => apiFetch<BreakdownResponse>(`/command-center/breakdown?${query}`),
    enabled: enabled && callerEnabled,
    ...CACHED,
  })
}

export function useTopPromotions(limit = 100) {
  const { year, currency, targetRoi, enabled } = useScope()
  return useQuery({
    queryKey: [...key('top-promotions', year, currency, targetRoi), limit],
    queryFn: () =>
      apiFetch<TopPromotionsResponse>(
        `/command-center/top-promotions?${commandQuery(year, currency, { limit }, targetRoi)}`,
      ),
    enabled,
    ...CACHED,
  })
}
