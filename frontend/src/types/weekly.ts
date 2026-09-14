/** The weekly impact contract — B5.
 *
 *  Mirrors backend/app/tpo/weekly.py.
 *
 *  A DECOMPOSITION, NOT A FORECAST. Every week is a week the data has rows
 *  for; nothing is projected, fitted or estimated. The frontend renders this
 *  and computes nothing — no uplift, no ROI, no promotion cost, no baseline.
 *
 *  `additive` on a metric is load-bearing: extensive quantities sum across
 *  weeks to the scope total, ratios do not. Summing a ratio is the specific
 *  error the flag exists to prevent.
 */

import type { SimulationKpiKey } from './simulation'

export type WeeklyMetricKey =
  | 'incremental_sales'
  | 'incremental_units'
  | 'trade_spend'
  | 'roi_multiple'
  | 'margin_percent'
  | 'cannibalization'

export interface WeeklyCell {
  key: string
  value: number | null
  display_value: string
  available: boolean
  /** Preserved from the KPI engine. Never zero-filled. */
  unavailable_reason: string | null
}

export interface WeeklyWeek {
  week_id: string
  week_label: string
  ordinal: number
  week_start: string | null
  low: Record<WeeklyMetricKey, WeeklyCell>
  high: Record<WeeklyMetricKey, WeeklyCell>
}

export interface WeeklyMetricSpec {
  key: WeeklyMetricKey
  label: string
  unit: string
  /** False for ROI, Margin and Cannibalization — they are ratios. */
  additive: boolean
  note: string
}

export interface WeeklyReconciliation {
  additive: Record<
    string,
    {
      summed: true
      tolerance: number
      week_count: number
      low: { weekly_total: number; aggregate: number | null; difference: number | null; within_tolerance: boolean }
      high: { weekly_total: number; aggregate: number | null; difference: number | null; within_tolerance: boolean }
    }
  >
  non_additive: Record<
    string,
    {
      summed: false
      reason: string
      aggregate_low: number | null
      aggregate_high: number | null
      aggregate_display_low: string | null
      aggregate_display_high: string | null
    }
  >
  note: string
}

export interface WeeklyRequest {
  filters: Record<string, unknown>
  scenario_id: string
  discount_pct: number
  currency?: string
}

export interface WeeklyResponse {
  scenario_id: string
  treatment: string
  discount_pct: number
  uplift: { low: number; high: number }
  range_label: string
  scope: {
    period: string
    filters_applied: Record<string, unknown>
    row_count: number
    promoted_row_count: number
    weeks_in_scope: number
    weeks_with_promotion: number
    weeks_without_promotion: number
    omitted_note: string
  }
  metrics: WeeklyMetricSpec[]
  weeks: WeeklyWeek[]
  aggregate: Record<'low' | 'high', { uplift: number; kpis: Record<SimulationKpiKey, WeeklyCell> }>
  reconciliation: WeeklyReconciliation
  provenance: {
    scenario_id: string
    treatment: string
    discount_pct: number
    uplift_low: number
    uplift_high: number
    response_rule: string
    kpi_engine: string
    week_source: string
    scope: Record<string, unknown>
    range_label: string
    method: string
  }
  meta: { currency: string; base_currency: string; phase: string }
}
