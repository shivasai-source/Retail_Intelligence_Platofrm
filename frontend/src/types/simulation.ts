/** The Simulation Studio contract — Phase A.
 *
 *  Mirrors backend/app/tpo/simulation.py. Every figure is computed by the
 *  validated KPI engine; the frontend renders what it is given and calculates
 *  nothing. The old `Scenario`/`LeverValues`/`ImpactRow` shapes that carried
 *  the client-side coefficient model are gone with it.
 *
 *  `value` is null — never 0 — for any KPI the selection cannot support, and
 *  `unavailable_reason` says why. Render the reason, not a zero.
 */

/** The one filter contract, mirroring backend FilterState. Identical to the
 *  Command Center's `CommandFilters` by design: the two modules must select
 *  the same rows for the same selection. */
export interface SimulationFilters {
  year: number | null
  month: number | null
  channel: string[]
  retailer: string[]
  region: string[]
  state: string[]
  city: string[]
  tier: string[]
  distributor: string[]
  category: string[]
  brand: string[]
  product: string[]
  promotion: string[]
  promotion_type: string[]
}

/** The levers the backend accepts. Retailer Incentive and Inventory Allocation
 *  are absent because no dataset in the project backs them — the API rejects
 *  them rather than silently ignoring them. */
export interface LeverValues {
  discount_pct?: number | null
  duration_weeks?: number | null
  spend_amount?: number | null
}

export type LeverKey = keyof LeverValues

/** One approved promotion treatment the scenario discount may be set to.
 *  Sent by the backend from app/tpo/response.py — the frontend keeps no copy
 *  of the approved rules. */
export interface ApprovedPoint {
  discount_pct: number
  treatment: string
  uplift_low: number
  uplift_high: number
}

export interface LeverDefinition {
  key: LeverKey
  label: string
  unit: 'percent' | 'weeks' | 'currency'
  available: boolean
  unavailable_reason: string | null
  value: number | null
  display_value: string | null
  min: number | null
  max: number | null
  step: number
  decimals: number
  /** The measurement this lever's default and range were anchored on. Shown to
   *  the user so a control position is never an unexplained number. */
  basis: string | null
  /** Discount only. The five approved treatment depths a SCENARIO may use.
   *  Distinct from `value`, which is the scope's measured depth — a
   *  revenue-weighted blend that is frequently not an approved point at all. */
  approved_points?: ApprovedPoint[]
}

/** --- B2.3: executing a hypothetical scenario --------------------------- */

export interface SimulateRequest {
  filters: Partial<SimulationFilters>
  scenario_id: string
  /** Must be one of the approved treatment depths; the backend rejects
   *  anything else rather than rounding or interpolating. */
  discount_pct: number
  duration_weeks?: number | null
  currency?: string
}

/** One end of the approved uplift range, with the KPIs the engine produced
 *  for it. NOT a confidence bound — see `range_label`. */
export interface SimulationEnd {
  uplift: number
  kpis: Record<SimulationKpiKey, SimulationKpi & { note?: string }>
}

export interface SimulateResponse {
  scenario_id: string
  status: 'simulated'
  kind: 'hypothetical'
  treatment: string
  discount_pct: number
  uplift: { low: number; high: number }
  breakeven_uplift: number
  headroom: { low: number; high: number }
  /** "Approved uplift range". The bands are the project's approved promotion
   *  rules, not estimated uncertainty — never render this as a confidence or
   *  prediction interval. */
  range_label: string
  result: { low: SimulationEnd; high: SimulationEnd }
  levers: {
    discount_pct: { value: number; modelled: boolean }
    duration_weeks: { value: number | null; modelled: boolean; note: string }
    spend_amount: { value: null; derived: boolean; note: string }
  }
  scope: {
    period: string
    filters_applied: Record<string, unknown>
    row_count: number
    promoted_row_count: number
    excluded_rows: number
    excluded_reason: string | null
  }
  provenance: {
    response_rule: string
    treatment: string
    discount_pct: number
    uplift_low: number
    uplift_high: number
    promotion_cost_rate: number
    kpi_engine: string
    method: string
    range_label: string
  }
  meta: { currency: string; base_currency: string; target_roi: number; phase: string }
}

/** Where a cannibalization rate was measured, when the selected scope could
 *  not support one. NEVER a substitute for `value`: the figure belongs to the
 *  scope named in `scope_label`, and the UI must print that label with it. */
export interface MeasuredAt {
  value: number
  display_value: string
  comparable_events: number
  /** Which dimensions were lifted from the selection to reach this scope. */
  lifted: string[]
  scope_label: string
}

export interface SimulationKpi {
  key: string
  label: string
  unit: string
  value: number | null
  display_value: string
  available: boolean
  unavailable_reason: string | null
  formula: string
  /** Cannibalization only: how many comparable promotion events the rate was
   *  measured over, and — when the selection could not support one — a wider
   *  scope that could. */
  comparable_events?: number
  measured_at?: MeasuredAt | null
}

export type SimulationKpiKey =
  | 'trade_spend'
  | 'incremental_units'
  | 'incremental_sales'
  | 'roi_multiple'
  | 'margin_percent'
  | 'cannibalization'
  | 'pei'

/** --- Part B1: context, Current Plan and the scenario model --------------- */

/** One dimension of the simulation context. `summary` is what the panel
 *  prints: the selected names, or an honest "All channels" — never a default
 *  the backend invented. */
export interface ContextDimension {
  key: string
  label: string
  constrained: boolean
  /** Always shown, constrained or not, so the context answers "what are we
   *  simulating?" even when nothing is selected. */
  primary: boolean
  values: { code: string; name: string }[]
  summary: string
}

export interface SimulationContext {
  period: string
  period_label: string
  year: number | null
  month: number | null
  dimensions: ContextDimension[]
  filters_applied: Record<string, unknown>
  row_count: number
  promoted_row_count: number
}

/** One observed field of the Current Plan. Either a value WITH the derivation
 *  that produced it, or no value WITH the reason it could not be derived.
 *  There is no third case, and never a fallback. */
export interface ObservedField {
  key: string
  label: string
  value: number | string | string[] | null
  display_value: string | null
  available: boolean
  unavailable_reason: string | null
  derivation: string | null
}

export interface CurrentPlan {
  status: 'measured'
  /** The Promotion_Id when exactly one promotion is in scope, else null.
   *  Duration can only be read when this is set. */
  single_promotion: string | null
  fields: ObservedField[]
  levers: LeverValues
}

/** Measured, nobody has run it, or an execution actually produced it.
 *  `simulated` became legitimate in B2.2, which really does execute scenarios.
 *  Note there is no `running` here: that is frontend request state and is
 *  never sent to or received from the backend. */
export type ScenarioStatus = 'measured' | 'not_simulated' | 'simulated'
/** What KIND of thing the scenario is, independent of whether it has run. */
export type ScenarioKind = 'measured' | 'hypothetical'

export interface Scenario {
  id: string
  name: string
  sub_label: string
  kind: ScenarioKind
  status: ScenarioStatus
  levers: LeverValues
  editable_levers: boolean
  /** Null for every hypothetical scenario. Not zero, not the baseline's
   *  numbers, not the baseline's numbers scaled. */
  result: Record<SimulationKpiKey, SimulationKpi> | null
  result_reason: string | null
}

export interface SimulationRunRequest {
  filters: Partial<SimulationFilters>
  levers?: LeverValues | null
  scenario_name?: string | null
  currency?: string
}

export interface SimulationRunResponse {
  scenario: {
    name: string
    source: 'measured'
    phase: string
    /** False for the whole of Phase A. The one flag that separates a measured
     *  baseline from a modelled scenario. */
    modelled: boolean
  }
  scope: {
    period: string
    period_label: string
    filters_applied: Record<string, unknown>
    row_count: number
    promoted_row_count: number
    promoted_weeks: number
    /** A summary across the promotions in scope. NOT a promotion duration —
     *  see CurrentPlan.single_promotion. Retained for the Phase A contract and
     *  used nowhere. */
    median_promotion_weeks: number
    has_data: boolean
  }
  levers: {
    submitted: LeverValues | null
    /** False in Phase A — the levers were recorded, not modelled. */
    applied: boolean
    note: string
    definitions: LeverDefinition[]
  }
  context: SimulationContext
  current_plan: CurrentPlan
  /** The DEFAULT scenario set for this context. The frontend store seeds
   *  itself from this once per scope and owns the mutable state thereafter —
   *  the backend holds no scenario state and persists nothing. */
  scenarios: Scenario[]
  /** The Current Plan's result, also reachable as `scenarios[0].result`. Kept
   *  at the top level unchanged for the Phase A contract. */
  kpis: Record<SimulationKpiKey, SimulationKpi>
  meta: {
    currency: string
    base_currency: string
    exchange_rate: number
    target_roi: number
    phase: string
  }
}
