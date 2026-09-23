/** Simulation Studio — the contracts of `POST /api/simulation/scope` and
 *  `POST /api/simulation/simulate` (backend/app/tpo/studio.py).
 *
 *  Every figure is the validated KPI engine's over rows the studio
 *  synthesized for the window. `value` is base currency (INR); `display` is
 *  the formatted string the page shows, already in the requested currency. */

import type { ApiFilters } from '../lib/scope'

export interface Money {
  value: number | null
  display: string
}

export interface MoneyDelta {
  absolute: Money
  percent: number | null
  percent_display: string
  direction: Direction
}

export interface Figure {
  value: number | null
  display: string
}

export interface Lever {
  min: number
  max: number
  step: number
  default: number
  /** Days only: the longest run the data actually holds, before the planning
   *  cap is applied. `max` is the smaller of the two. */
  evidence_max?: number
  unit: 'percent' | 'days' | 'currency'
  max_display?: string
  default_display?: string
}

export interface LiftModel {
  provenance: 'fitted' | 'fitted_dataset_wide' | 'approved_rules'
  form: string
  coefficients: { b1: number; b2: number }
  residual_band: { low: number; high: number }
  n_events: number
  n_depths: number
  r_squared: number | null
  depth_observed_pct: { min: number; max: number }
  depth_domain_pct: { min: number; max: number }
  fade: { per_week: number; detected: boolean; t: number | null; runs: number }
  post_promotion_dip: { fraction: number; detected: boolean; t: number | null; events: number }
  notes: string[]
}

export interface StudioScope {
  filters_applied: Record<string, unknown>
  period: string
  row_count: number
  promoted_row_count: number
  product_channels: number
  excluded: { product_id: string; channel_id: string; reason: string }[]
}

export interface ScopeResponse {
  mode: 'studio'
  currency: string
  /** Display units per base-currency (INR) unit, for the budget slider's live readout. */
  exchange_rate: number
  scope: StudioScope
  measured: {
    revenue: Money
    trade_spend: Money
    incremental_sales: Money
    roi: Figure
  }
  observed_plan: {
    promoted_rows: number
    discount_pct: number
    typical_weeks: number
    days: number
    runs: number
  }
  levers: {
    discount_pct: Lever
    days: Lever
    trade_spend: Lever
  }
  model: LiftModel
}

export interface PlanFigures {
  label: string
  discount_pct: number
  days: number
  coverage: number
  note?: string
  revenue: Money
  units: Figure
  trade_spend: Money
  incremental_sales: Money
  incremental_units: Figure
  roi: Figure
  margin_pct: Figure
  band: {
    revenue: { low: Money; high: Money }
    roi: { low: Figure; high: Figure }
    incremental_sales: { low: Money; high: Money }
  }
}

export type Direction = 'up' | 'down' | 'unchanged' | 'not_applicable'
export type RoiStatus = 'profitable' | 'break_even' | 'loss_making' | 'not_applicable'

export interface WeekPoint {
  week: number
  label: string
  days: number
  baseline_revenue: Money
  /** Scenario revenue less the no-promotion baseline, for this week. */
  incremental_vs_baseline: Money
  current_revenue: Money
  scenario_revenue: Money
  scenario_revenue_low: Money
  scenario_revenue_high: Money
  current_roi: Figure
  scenario_roi: Figure
  scenario_trade_spend: Money
}

export interface SimulateRequest {
  filters: ApiFilters
  currency: string
  discount_pct: number
  trade_spend: number
  days: number
}

export interface SimulateResponse {
  mode: 'studio'
  currency: string
  scope: StudioScope
  levers: {
    discount_pct: number
    days: number
    trade_spend: {
      requested: Money
      consumed: Money
      full_coverage_cost: Money
      coverage: number
      coverage_display: string
      binding: boolean
      unspent: Money
    }
  }
  window: { days: number; weeks: number; partial_week_fraction: number | null }
  /** `mid_display` is the headline lift; `display` is the low–high band. */
  lift: { low: number; mid: number; high: number; mid_display: string; display: string }
  baseline: { label: string; revenue: Money; units: Figure }
  current_plan: PlanFigures
  scenario: PlanFigures
  deltas: {
    revenue: MoneyDelta
    /** Every compared money figure carries one, so no Change column is blank. */
    trade_spend: MoneyDelta
    incremental_sales: MoneyDelta
    incremental_units: { absolute: number | null; absolute_display: string; percent: number | null; percent_display: string; direction: Direction }
    /** Percentage POINTS, not a percent of a percent. */
    margin_pct: { absolute: number | null; absolute_display: string; direction: Direction }
    roi: {
      absolute: number | null
      absolute_display: string
      direction: Direction
      status: RoiStatus
      current_status: RoiStatus
    }
  }
  vs_baseline: { revenue: Money; direction: Direction }
  after_window: { week: number; revenue_effect: Money; note: string } | null
  weekly: WeekPoint[]
  model: LiftModel
  method: string
}

export interface CurvePoint {
  discount_pct: number
  is_current_plan: boolean
  coverage: number
  revenue: Money
  revenue_low: Money
  revenue_high: Money
  trade_spend: Money
  roi: Figure
  roi_low: Figure
  roi_high: Figure
  roi_status: RoiStatus
}

export interface CurveResponse {
  mode: 'studio'
  currency: string
  levers: { trade_spend: Money; days: number }
  current_plan_discount_pct: number
  break_even_roi: number
  points: CurvePoint[]
  method: string
}

// --- Optimize -------------------------------------------------------------

export type OptimizableLever = 'discount_pct' | 'trade_spend' | 'days'

/** `POST /api/simulation/optimize`: the levers as they stand, and which of
 *  them to search. `vary` maps a lever to the TOP of its range; every range
 *  starts at the lever's minimum, and a lever not named is held. */
export interface OptimizeRequest {
  filters: ApiFilters
  currency: string
  discount_pct: number
  trade_spend: number
  days: number
  vary: Partial<Record<OptimizableLever, number>>
}

export interface OptimizeFigures {
  revenue: Money
  units: Figure
  trade_spend: Money
  incremental_sales: Money
  incremental_units: Figure
  roi: Figure
  margin_pct: Figure
}

export interface OptimizeLevers {
  discount_pct: number
  trade_spend: number
  trade_spend_display: string
  days: number
}

export interface OptimizeResponse {
  mode: 'studio'
  currency: string
  objective: { maximise: 'roi'; then: string[]; note: string }
  searched: {
    discount_pct: { min: number; max: number; step: number; count: number } | null
    days: { min: number; max: number; step: number; count: number } | null
    trade_spend: { min: number; max: number; max_display: string; rule: string } | null
    evaluations: number
  }
  held: Partial<Record<OptimizableLever, number>>
  from: { levers: OptimizeLevers; figures: OptimizeFigures }
  best: {
    levers: OptimizeLevers
    figures: OptimizeFigures
    roi_status: RoiStatus
    changed: Record<OptimizableLever, boolean>
  }
  gain: SimulateResponse['deltas']
  /** The starting levers are already as good as anything in the ranges. */
  already_optimal: boolean
  method: string
}

