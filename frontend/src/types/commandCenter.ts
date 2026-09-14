// Wire types for /api/command-center/*. Mirrors app/tpo/service.py.
//
// Note what is NOT here: no KPI arithmetic. `value` is the canonical figure the
// backend computed and `display_value` is the string to render. The frontend
// never recomputes a KPI, never converts a currency and never applies a
// threshold — all three live in the backend so there is exactly one of each.

export type Unit = 'currency' | 'percent' | 'multiple' | 'score'
export type Currency = 'INR' | 'USD'

export interface KpiInfo {
  name: string
  formula: string
  meaning: string
}

export interface KpiCard {
  key: string
  label: string
  unit: Unit
  /** Canonical, always in the base currency. Null when unavailable. */
  value: number | null
  /** Formatted for display, converted if (and only if) the KPI is monetary. */
  display_value: string
  previous_value: number | null
  delta: number | null
  delta_display: string
  delta_sub: string
  difference: number | null
  trend: 'up' | 'down' | null
  available: boolean
  unavailable_reason: string | null
  info: KpiInfo
  /** Cannibalization only — see MeasuredAt in types/simulation.ts. */
  comparable_events?: number
  measured_at?: MeasuredAt | null
}

import type { MeasuredAt } from './simulation'

export interface Meta {
  period: string
  period_label: string
  comparison_period: string | null
  currency: Currency
  base_currency: Currency
  exchange_rate: number
  /** The ROI hurdle, as a multiple of trade spend (1.5 = 1.5). */
  target_roi: number
  row_count: number
  filters_applied: Record<string, unknown>
}

export interface KpiResponse {
  kpis: Record<string, KpiCard>
  meta: Meta
}

export interface Option {
  code: string
  name: string
  type?: string
}

export interface FiltersResponse {
  years: number[]
  year_labels: Record<string, string>
  months: Option[]
  channels: Option[]
  retailers: Option[]
  /** False when the selected channel has no usable retailer values (B2B
   *  carries a blank Retailer on every store) — the control hides. */
  retailer_available: boolean
  regions: string[]
  states: string[]
  cities: string[]
  tiers: string[]
  distributors: string[]
  categories: string[]
  brands: string[]
  products: Option[]
  offers: Option[]
  promotion_types: string[]
  currencies: Currency[]
  selected: Record<string, unknown>
}

export interface TrendResponse {
  granularity: 'week' | 'month'
  labels: string[]
  series: {
    roi: (number | null)[]
    incremental_sales: number[]
    trade_spend: number[]
    target_roi: number[]
  }
  display: { incremental_sales: string[]; trade_spend: string[]; roi: string[] }
  meta: Meta
}

export interface RiskAlert {
  id: string
  severity: 'Critical' | 'High' | 'Medium'
  tone: 'danger' | 'warning' | 'info'
  title: string
  description: string
  roi_multiple: number | null
  trade_spend: number
  trade_spend_display: string
  incremental_sales: number
  at_stake: number
  at_stake_display: string
  channel: string
  product: string
  /** The week the event ran. A LABEL, not a filter: an event's ROI is measured
   *  against the non-promoted rows of the selection, and the promoted week has
   *  none — see the note in service.risk_alerts. */
  week: string
  promotion_id: string
  product_id: string
  channel_id: string
}

export interface RiskAlertsResponse {
  counts: {
    critical: number
    high: number
    medium: number
    target_achieved: number
    total_events: number
  }
  alerts: RiskAlert[]
  meta: Meta
}

export interface UnderperformingRow {
  promotion: string
  /** The event's own dimension codes, from the rows it was measured over.
   *  A hand-off narrows by these rather than by the display names beside
   *  them — see CommandCenter's handOffPromotion. */
  promotion_id: string
  product: string
  product_id: string
  channel: string
  channel_id: string
  period: string
  roi_multiple: number
  roi_display: string
  /** Distance from the target, in multiples: -0.3 is 0.3 short. */
  vs_target: number
  trade_spend: number
  trade_spend_display: string
  at_stake: number
  at_stake_display: string
  primary_cause: string
  action: string
  status: string
}

export interface UnderperformingResponse {
  rows: UnderperformingRow[]
  total: number
  meta: Meta
}

export interface MixSlice {
  code: string
  label: string
  type: string
  spend: number
  spend_display: string
  pct: number
  color: string
}

export interface PromotionMixResponse {
  slices: MixSlice[]
  total_spend: number
  total_spend_display: string
  meta: Meta
}

/** One value of a breakdown dimension, with every KPI computed for it by the
 *  frozen engine. Monetary fields are base-currency; `*_display` is converted. */
export interface BreakdownGroup {
  code: string
  label: string
  /** Only on `by=promotion_mechanic`: the Promotion_Ids this mechanic is made
   *  of, so a caller can re-scope to one mechanic through the existing
   *  `promotion` filter rather than keeping its own offer-to-mechanic map. */
  members?: string[]
  trade_spend: number
  trade_spend_display: string
  incremental_units: number | null
  incremental_sales: number | null
  incremental_sales_display: string
  roi: number | null
  margin_impact: number | null
  pei: number | null
  cannibalization: number | null
  /** Share of TRADE SPEND only — the one money measure that is additive.
   *  Incremental Sales is not, so it must never be shown as a share. */
  share_pct: number
}

export type BreakdownDimension =
  | 'channel' | 'retailer' | 'product' | 'category' | 'brand'
  | 'promotion' | 'promotion_mechanic' | 'promotion_type' | 'distributor' | 'region' | 'state' | 'city'

export type BreakdownMetric = 'incremental_sales' | 'trade_spend' | 'incremental_units' | 'roi'

export interface BreakdownResponse {
  by: BreakdownDimension
  metric: BreakdownMetric
  groups: BreakdownGroup[]
  /** True when more groups exist than were returned — the UI must say so
   *  rather than implying the ranking is the whole population. */
  truncated: boolean
  total_groups: number
  meta: Meta
}

/** GET /command-center/top-promotions — best-performing promotion EVENTS
 *  (promotion x product x channel x week), already ranked ROI descending by
 *  the backend and carrying only values the frozen engine produced. */
export interface TopPromotionRow {
  promotion: string
  product: string
  channel: string
  period: string
  roi_multiple: number
  roi_display: string
  /** Distance from the target, in multiples: -0.3 is 0.3 short. */
  vs_target: number
  trade_spend: number
  trade_spend_display: string
  incremental_sales: number
  incremental_sales_display: string
  status: string
}

export interface TopPromotionsResponse {
  rows: TopPromotionRow[]
  meta: Meta
}

// --- Sales Performance Comparison -------------------------------------------

/** One measured amount, already formatted by its metric's unit. */
export interface ComparisonAmount {
  value: number | null
  display: string
}

/** One amount at one period. `available: false` means the dataset has no such
 *  period — a 2024 month has no year-ago figure at all — and `value` is null
 *  rather than zero, which would read as "sold nothing" instead of "there was
 *  no such period". */
export interface ComparisonFigure extends ComparisonAmount {
  label: string
  available: boolean
  unavailable_reason: string | null
}

/** How one period stands against another, in the metric's own terms.
 *
 *  `direction` is the raw movement; `good` is whether that movement is welcome,
 *  which is a different question — a rise in Trade Spend is a rise and not an
 *  improvement. Both computed server-side; the card never divides. */
export interface ComparisonDelta {
  value: number | null
  display: string
  direction: 'up' | 'down' | 'flat' | null
  good: boolean | null
  /** "percent change" or "multiple" — a ratio moves by its difference (+0.2). */
  basis: string | null
}

export interface ComparisonMetricSpec {
  key: string
  label: string
  unit: 'currency' | 'multiple'
  lower_is_better: boolean
  /** True for a ratio, which is compared by its DIFFERENCE, never a percent of itself. */
  ratio: boolean
  formula: string
  meaning: string
}

export interface ComparisonMetricFigures {
  current: ComparisonFigure
  mago: ComparisonFigure
  yago: ComparisonFigure
  ytd: ComparisonFigure
  ytd_yago: ComparisonFigure
  delta: { mago: ComparisonDelta; yago: ComparisonDelta; ytd: ComparisonDelta }
}

/** One month of the chart, carrying every metric so a hover can show them all
 *  without a second request. */
export interface ComparisonPoint {
  key: string
  year: number
  month: number
  label: string
  short: string
  year_short: string
  values: Record<string, ComparisonAmount>
}

export interface SalesPeriod {
  year: number
  month: number
  label: string
}

export interface SalesComparisonResponse {
  period: SalesPeriod | null
  /** Every month the SELECTION has data for — the period control is built from
   *  this, so a month that cannot be answered cannot be picked. */
  available_periods: SalesPeriod[]
  /** The latest month in the DATA, which is what an unspecified period means.
   *  Not today's date: this dataset ends before it. */
  latest: { year: number; month: number } | null
  metric_specs: ComparisonMetricSpec[]
  /** The months the chart draws, oldest first. */
  series: ComparisonPoint[]
  /** Which columns each mode highlights, by `ComparisonPoint.key`, so the chart
   *  never re-derives a window the figures were computed from. */
  windows: Record<string, { current: string[]; against: string[] }>
  figures: Record<string, ComparisonMetricFigures>
  meta: Meta
}
