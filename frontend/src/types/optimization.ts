/** General Optimization — the second, separate simulation mode.
 *
 *  Mirrors backend/app/tpo/optimization.py. Nothing in here overlaps the
 *  Investigation Simulation's contracts in types/simulation.ts: the two modes
 *  share the filter dimensions and the approved economics, and no type.
 *
 *  EVERY DERIVED FIGURE IS A BAND, never a point. An approved treatment gives
 *  an uplift RANGE (PR003 is 40–50%), and the backend refuses to collapse one
 *  to a midpoint — so `Band` is the shape every optimized number arrives in.
 */

/** One figure at both ends of its approved uplift band. */
export interface Band {
  low: number
  high: number
  display_low: string
  display_high: string
  /** Pre-formatted "₹2.9 Cr – ₹3.0 Cr", or the single value when the two ends
   *  coincide (an unpromoted product does not move). */
  display: string
}

export type OptimizationStatus =
  | 'optimized'
  | 'no_feasible_solution'
  | 'insufficient_data'
  | 'constraint_conflict'

export interface ApprovedPoint {
  discount_pct: number
  treatment: string
  uplift_low: number
  uplift_high: number
}

export interface ReferenceObservation {
  year: number
  trade_spend: number | null
  row_count: number
  available: boolean
}

/** The historical trade-spend average that bounds the ceiling slider. */
export interface HistoricalReference {
  years: number[]
  observations: ReferenceObservation[]
  observed_years: number
  average_trade_spend: number | null
  available: boolean
  basis: string
  unavailable_reason: string | null
  display_average: string
}

export interface OptimizationScopeBlock {
  category: string[] | null
  category_label: string
  channel: string[] | null
  channel_label: string
  channels_in_scope: number
  month: number | null
  month_label: string
  year: number | null
  years: number[]
  period_label: string
  candidate_count: number
  excluded_count: number
  excluded: { product_id: string; channel_id: string; reason: string }[]
  product_count: number
  brand_form_count: number
  filters_applied: Record<string, unknown>
  /** dim_product's own distinct Category values — never a hardcoded list. */
  available_categories: string[]
}

export interface HistoricalSummary {
  units: number
  units_display: string
  revenue: number
  revenue_display: string
  trade_spend: number
  trade_spend_display: string
  average_discount_pct: number | null
  average_discount_display: string
  promoted_candidates: number
  derivation: string
}

export interface OptimizedSummary {
  units: Band
  revenue: Band
  trade_spend: Band
  average_discount_pct: number | null
  average_discount_display: string
  promoted_candidates: number
  untouched_candidates: number
  budget_used_pct: number | null
}

export interface ComparisonEntry {
  historical: number | null
  optimized_low: number | null
  optimized_high: number | null
  change_pct_low: number | null
  change_pct_high: number | null
}

export interface OptimizationComparison {
  units: ComparisonEntry
  revenue: ComparisonEntry
  trade_spend: ComparisonEntry
  average_discount_pct: { historical: number | null; optimized: number | null }
}

export interface OptimizationRow {
  product_id: string
  product: string
  brand_form: string
  category: string
  channel_id: string
  channel: string
  base_units: number
  base_units_display: string
  base_revenue: number
  base_revenue_display: string
  base_trade_spend: number
  base_trade_spend_display: string
  /** The depth this (product, channel) ACTUALLY ran at in the selected scope,
   *  measured from prices. 0 when nothing here was promoted. This is the
   *  "before" the plan recommends changing — never the optimizer's answer. */
  base_discount_pct: number
  base_discount_display: string
  /** Whether the scope carries any promoted row for this product. "Not
   *  promoted" and "promoted at 0%" are different statements. */
  base_promoted: boolean
  /** Which promotions actually ran, e.g. ["PR001", "PR002"]. */
  base_promotions: string[]
  /** Whether the OPTIMIZER chose to place a treatment. Distinct from
   *  `base_promoted`, which is what history did. */
  promoted: boolean
  /** The approved treatment key (PR001 … PB001), or null when the product was
   *  left at its base allocation. */
  treatment: string | null
  /** The OPTIMIZED depth — what the optimizer proposes, not what ran. */
  discount_pct: number
  discount_display: string
  uplift: { low: number; high: number }
  optimized_units: Band
  optimized_revenue: Band
  optimized_trade_spend: Band
}

export interface OptimizationConstraints {
  max_trade_spend: number
  max_trade_spend_display: string
  min_discount_pct: number
  max_discount_pct: number
  allowed_treatments: { treatment: string; discount_pct: number }[]
  ceiling_basis: string
  /** Present only on a completed solve. */
  effective_max_trade_spend?: number
  effective_max_trade_spend_display?: string
  clamped?: boolean
}

export interface OptimizationProvenance {
  response_rule: string
  promotion_cost_rate: number
  approved_discount_pct: number[]
  economics: string
  objective: string
  constraint: string
  basis: string
  solver: string
  cannibalization: string
}

/** What the controls need before anything is optimized. */
export interface OptimizationScopeResponse {
  mode: string
  scope: OptimizationScopeBlock
  reference: HistoricalReference
  historical: HistoricalSummary | null
  discount: {
    min_pct: number
    max_pct: number
    approved_points: ApprovedPoint[]
    note: string
  }
  ready: boolean
  provenance: OptimizationProvenance
  meta: { mode: string; currency: string; base_currency: string; exchange_rate: number; max_discount_pct: number }
}

/** The plan. `optimized`, `comparison` and `historical` are null on every
 *  status except `optimized` — a plan that could not be produced has no
 *  numbers, and zeros would read as a result. */
export interface OptimizationResponse {
  mode: string
  status: OptimizationStatus
  message: string | null
  scope: OptimizationScopeBlock
  reference: HistoricalReference
  constraints: OptimizationConstraints
  historical: HistoricalSummary | null
  optimized: OptimizedSummary | null
  comparison: OptimizationComparison | null
  rows: OptimizationRow[]
  provenance: OptimizationProvenance
  meta: { mode: string; currency: string; base_currency: string; exchange_rate: number; max_discount_pct: number }
}

export interface OptimizationScopeRequest {
  /** Pins the plan and its reference to one year; omitted, every year the data holds is averaged. */
  year?: number | null
  category?: string[] | null
  channel?: string[] | null
  month?: number | null
  currency?: string
}

export interface OptimizationRequest extends OptimizationScopeRequest {
  max_trade_spend: number
  min_discount_pct: number
  max_discount_pct: number
}
