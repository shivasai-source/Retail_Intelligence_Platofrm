/** Wire types for `/api/planner` (backend/app/tpo/planner.py).
 *
 *  Every figure arrives as `{ value, display }`: the value for drawing and
 *  ranking, the display string for reading. The page never formats a KPI of
 *  its own. */

export interface Money {
  value: number | null
  display: string
}

export type Direction = 'up' | 'down' | 'unchanged'

export interface Figures {
  revenue: Money
  profit: Money
  /** Net incremental profit: what the promotions add over not running them. */
  promotion_profit: Money
  /** CP: product cost + promotion cost (the discount is already out of revenue). */
  cost: Money
  /** Profit % = (SP - CP) / CP x 100. */
  profit_pct: Money
  trade_spend: Money
  incremental_sales: Money
  units: Money
  incremental_units: Money
  roi: Money
  margin_pct: Money
  promotions: Money
  avg_discount: Money
}

export interface MoneyDelta {
  absolute: { value: number; display: string }
  percent: number | null
  percent_display: string
  direction: Direction
}

export interface PlainDelta {
  absolute: number | null
  absolute_display: string
  direction: Direction
}

export interface Deltas {
  revenue: MoneyDelta
  profit: MoneyDelta
  promotion_profit: MoneyDelta
  trade_spend: MoneyDelta
  incremental_sales: MoneyDelta
  units: PlainDelta
  incremental_units: PlainDelta
  roi: PlainDelta
  margin_pct: PlainDelta
  profit_pct: PlainDelta
  cost: MoneyDelta
  promotions: PlainDelta
  avg_discount: PlainDelta
  sister_pack_margin: Money
}

export interface PlannerSelection {
  products: string[]
  stores: string[]
  channels: string[]
  regions: string[]
  start: [number, number] | null
  end: [number, number] | null
  promotion: string | null
  /** [year, month]: a calendar month, resolved server-side to its weeks. */
  month: [number, number] | null
}

export interface GroupedOption {
  code: string
  name: string
  group?: string
}

export interface CalendarWeekRef {
  week: number
  start: string
  month: number
}

export interface PlannerOptions {
  products: GroupedOption[]
  stores: GroupedOption[]
  channels: GroupedOption[]
  regions: GroupedOption[]
  calendar: { year: number; weeks: CalendarWeekRef[] }[]
  default_period: { start: [number, number]; end: [number, number] }
}

export interface Offer {
  id: string
  name: string
  type: string
  mechanic: string
  /** The offer's nominal discount, a whole number (15, not 14.98). */
  depth_pct: number
}

export interface ScopeOffer extends Offer {
  runs: number
  product_stores: number
  profit: Money
  trade_spend: Money
  roi: string
}

export interface Lever {
  min: number
  max: number
  step: number
  default: number
  evidence_max: number
  unit: 'percent'
}

/** B, the response model: a hierarchical Bayesian regression sampled with
 *  NUTS, and how it checked out. */
export interface ModelInfo {
  method: string
  curve: string
  global_beta1: number | null
  global_beta2: number | null
  groups: number
  brands: number
  festivals: number
  chains: number | null
  draws_per_chain: number | null
  /** Posterior draws the Monte Carlo runs over. */
  mc_draws: number
  rhat_max: number | null
  ess_min: number | null
  divergences: number | null
  festival_lift: Record<string, number>
  fit_rows: number
  promoted_weeks_fitted: number
  regular_rows: number
  festival_rows: number
  deepest_observed_pct: number
  backtest: {
    holdout_rows?: number
    wape_units_pct?: number
    wape_incremental_pct?: number
    bias_incremental_pct?: number
    band_coverage_pct?: number
  }
  festival_backtest: {
    events?: {
      event: string
      year: number
      actual_uplift_pct: number
      predicted_uplift_pct: number
      p10_pct: number
      p90_pct: number
      within_band: boolean
    }[]
  }
  cannibalization_pct: Record<string, number>
  baseline: string
}

/** P10 / P50 / P90 of one figure over the Monte Carlo draws. */
export interface Trio {
  p10: Money
  p50: Money
  p90: Money
  /** "P10 – P90", ready to read. */
  display: string
}

/** A plan's Monte Carlo: ranges over B's posterior draws plus noise. */
export interface Band {
  draws: number
  profit: Trio
  revenue: Trio
  incremental_sales: Trio
  trade_spend: Trio
  roi: Trio | null
  units: Trio
  margin_pct: Trio | null
  profit_pct: Trio | null
  profit_change: Trio
  profit_pct_change: Trio | null
  /** Share of draws in which the plan earns more than the current one. */
  chance_gain_pct: number
  /** Share of draws in which it reaches the target (Profit target only). */
  chance_reach_pct?: number
}

export interface ScopeBlock {
  period: string
  start: [number, number]
  end: [number, number]
  start_date: string
  end_date: string
  weeks: number
  products: number
  stores: number
  channels: string[]
  product_stores: number
  slots: number
  promoted_slots: number
  promotion?: { id: string; name: string; type: string; mechanic: string }
}

export interface SummaryResponse {
  currency: string
  /** Display-currency units per rupee, for drawing axes. */
  exchange_rate: number
  scope: ScopeBlock
  current: Figures
  lever: Lever | null
  offers: ScopeOffer[]
  model: ModelInfo
}

export interface WhatIfResponse {
  currency: string
  /** Display-currency units per rupee, for drawing axes. */
  exchange_rate: number
  discount_pct: number
  shift_pts: number
  shift_relative_pct: number | null
  beyond_evidence: boolean
  clipped_at_zero: boolean
  current: Figures
  scenario: Figures
  /** The same selection with NOTHING promoted -- the zero point a scenario is
   *  read against, so a reader can see what promoting is worth at all. */
  baseline: Figures
  deltas: Deltas
  /** None at the current discount: the current plan has no range. */
  band: Band | null
  weekly: WeekPoint[]
}

export interface CurvePoint {
  discount_pct: number
  revenue: Money
  profit: Money
  promotion_profit: Money
  roi: Money
  profit_range: Trio
  revenue_range: Trio
  beyond_evidence: boolean
}

export interface CurveResponse {
  currency: string
  /** Display-currency units per rupee, for drawing axes. */
  exchange_rate: number
  current_discount_pct: number
  evidence_max: number
  points: CurvePoint[]
  current: { profit: Money; promotion_profit: Money; revenue: Money; roi: Money }
  /** The depth with the highest median profit across the draws. */
  best: { discount_pct: number; profit: Money; promotion_profit: Money; profit_median: Money; profit_range: Trio } | null
}

export interface PlannedOffer extends Offer {
  period: string
  index: number
}

export interface ChangeOffer {
  id: string
  name: string
  type: string
  depth_pct: number
}

/** One thing that happens to a product-store's promotions. */
export interface ChangeAction {
  kind: 'moved' | 'repriced' | 'dropped' | 'added'
  period: string
  index: number
  to_period?: string
  to_index?: number
  from_offer?: ChangeOffer
  to_offer?: ChangeOffer
}

export interface ChangeRow {
  actions: ChangeAction[]
  product_id: string
  product: string
  brand: string
  store_id: string
  store: string
  channel_id: string
  channel: string
  region: string
  gain: Money
  summary: { kept: number; repriced: number; moved: number; dropped: number; added: number }
  current: PlannedOffer[]
  best: PlannedOffer[]
  periods: number
  first_period: string
  last_period: string
  grain: 'week' | 'month'
}

export interface WeekPoint {
  week: string
  start: string
  month: number
  promoted_now: number
  promoted_plan: number
  profit_now: number
  profit_plan: number
  /** The new plan's P10 / P90 from the Monte Carlo (equal to the plan when nothing changes). */
  profit_p10: number
  profit_p90: number
  revenue_now: number
  revenue_plan: number
  revenue_p10: number
  revenue_p90: number
  /** The festival whose week this is, if any. */
  festival: string | null
}

export interface ImpactCount {
  promotions: number
  product_stores: number
}

/** What a plan changes, in promotions and in the product-stores they belong to. */
export interface Impact {
  /** Promotions whose discount value changes (in their week or as they shift). */
  discount_changed: ImpactCount
  /** Promotions run in a different week. */
  shifted: ImpactCount
  /** Both: a new week and a new discount. */
  shifted_and_repriced: ImpactCount
  stopped: ImpactCount
  added: ImpactCount
  shifted_by_offer: (ImpactCount & { name: string; type: string; depth_pct: number })[]
  product_stores_affected: number
  /** Every product-store in the selection (the Current plan strip's count). */
  product_stores_total: number
}

export interface ReplanBlock {
  figures: Figures
  deltas: Deltas
  changed_product_stores: number
  change_summary: { kept: number; repriced: number; moved: number; dropped: number; added: number }
  impact: Impact
  changes: ChangeRow[]
  changes_truncated: number
  weekly: WeekPoint[]
  band: Band | null
}

export interface UniformAnswer {
  discount_pct: number
  shift_pts: number
  shift_relative_pct: number | null
  figures: Figures
  deltas: Deltas
  /** Target only: the depth's P10-P90 across draws and the share that reach. */
  discount_range_pct?: [number, number] | null
  chance_reach_pct?: number
  shortfall?: Money
}

export interface RulesBlock {
  timing: 'free' | 'fixed'
  frequency: CountRule
  channels: {
    channel_id: string
    channel: string
    grain: 'week' | 'month'
    gap: number
    max_share_pct: number
    menu: Offer[]
  }[]
}

export type TimingRule = 'free' | 'fixed'
export type ProfitBasis = 'cost' | 'promotion'
export type CountRule = 'keep' | 'fewer' | 'more'

export interface BestResponse {
  currency: string
  /** Display-currency units per rupee, for drawing axes. */
  exchange_rate: number
  current: Figures
  /** The same selection with NOTHING promoted -- the zero point every tab
   *  compares against. See WhatIfResponse.baseline. */
  baseline: Figures
  uniform: UniformAnswer | null
  replan: ReplanBlock & { eligible_product_stores: number; never_promoted_product_stores: number }
  rules: RulesBlock
}

export interface TargetResponse {
  currency: string
  /** Display-currency units per rupee, for drawing axes. */
  exchange_rate: number
  target_pct: number
  basis: ProfitBasis
  base_profit: Money
  current: Figures
  /** The same selection with NOTHING promoted -- the zero point every tab
   *  compares against. See WhatIfResponse.baseline. */
  baseline: Figures

  /** CP of the current plan: the base the X% is taken on. */
  cost_base: Money
  profit_pct: Money
  goal_profit_pct: Money
  goal_profit: Money
  needed: Money
  uniform: (UniformAnswer & { reachable: boolean; max_profit_change_pct?: number | null; blocker?: string }) | null
  replan: ReplanBlock & {
    reachable: boolean
    max_profit_change_pct: number | null
    achieved_profit_change_pct: number | null
    /** The goal programme's shortfall: zero when the target is reached. */
    shortfall: Money
    shortfall_pct: number | null
    product_stores_total: number
    blocker: string | null
    alternatives: { rule: string; label: string; max_profit_change_pct: number }[]
  }
  rules: RulesBlock
}
