/** The scenario comparison contract — B4.1.
 *
 *  Mirrors backend/app/tpo/comparison.py. Contract types only: B4.1 defines
 *  the comparison, and no UI consumes it yet.
 *
 *  THREE PROPERTIES THE TYPES ENCODE:
 *
 *   * A scenario is `measured`, `simulated` or `excluded`. Excluded is a real
 *     answer — a scenario nobody ran has no result, and rendering a zero for
 *     it would read as an evaluation that came to nothing.
 *   * Every simulated metric keeps `low` AND `high`, with a delta at each end.
 *     There is no midpoint field, deliberately: the approved uplift band is a
 *     band, and collapsing it would invent precision the rules do not grant.
 *   * `recommendation` is always null. This project defines no business
 *     objective for Simulation Studio, so nothing here picks a winner.
 */

import type { SimulateResponse, SimulationKpi, SimulationKpiKey } from './simulation'

/** How a metric's delta may be expressed.
 *
 *  `percent_change` is offered only for EXTENSIVE quantities — money and
 *  units. A percent change of a rate is the classic misreading: an ROI moving
 *  1.3 → 1.6 is +0.3, and calling it "+23%" suggests returns grew by that
 *  much when what moved was the rate. */
export type DeltaType = 'absolute' | 'percentage_point' | 'percent_change'

export type ComparisonEntryStatus = 'measured' | 'simulated' | 'excluded'

export type ComparisonStatus = 'comparable' | 'no_baseline' | 'nothing_to_compare'

export interface MetricDelta {
  absolute: number | null
  /** Preformatted by the backend, so a delta cannot be rendered on a
   *  different convention from the value it came from. */
  display: string | null
  /** Null for every rate and for the PEI index — see DeltaType. */
  percent_change: number | null
}

export interface MetricSide {
  value: number | null
  display_value: string | null
  available: boolean
  /** Preserved from the KPI engine. An unavailable metric is never zeroed. */
  unavailable_reason: string | null
}

export interface MetricScenario {
  scenario_id: string
  low: MetricSide
  high: MetricSide
  delta_low: MetricDelta
  delta_high: MetricDelta
  /** A statement about the NUMBER only. Whether it is good is not decided. */
  direction_low: 'higher' | 'lower' | 'unchanged' | null
  direction_high: 'higher' | 'lower' | 'unchanged' | null
}

export interface ComparisonMetric {
  key: SimulationKpiKey
  label: string
  unit: string
  delta_type: DeltaType
  delta_rationale: string
  supports_percent_change: boolean
  /** The Command Center's DISPLAY convention for arrow colour — not a
   *  comparison objective. See `preference`. */
  lower_is_better_display: boolean | null
  /** Always null in B4.1: whether higher or lower wins is business policy. */
  preference: null
  preference_reason: string
  baseline: MetricSide | null
  scenarios: MetricScenario[]
}

export interface ComparisonScenario {
  scenario_id: string
  name: string
  status: ComparisonEntryStatus
  is_baseline: boolean
  comparable: boolean
  /** Why this scenario is not in the comparison. Null when it is. */
  exclusion_reason: string | null
  treatment: string | null
  discount_pct: number | null
  uplift: { low: number; high: number } | null
  provenance: SimulateResponse['provenance'] | null
}

export interface RecommendationRequirement {
  requirement: string
  satisfied: boolean
  note: string
}

export interface ComparisonRequestEntry {
  scenario_id: string
  name?: string
  /** The `kpis` block from /simulation/run, for the measured Current Plan. */
  measured?: Record<SimulationKpiKey, SimulationKpi> | null
  /** The scope that measured block was computed over. */
  scope?: Record<string, unknown> | null
  /** A whole /simulation/simulate payload. */
  simulated?: SimulateResponse | null
}

export interface ComparisonRequest {
  filters: Record<string, unknown>
  entries: ComparisonRequestEntry[]
  currency?: string
}

export interface ScenarioComparison {
  scope: Record<string, unknown>
  comparison_status: ComparisonStatus
  scenarios: ComparisonScenario[]
  metrics: ComparisonMetric[]
  economic_basis: {
    response_rule: string
    kpi_engine: string
    promotion_cost_rate: number
  }
  range_label: string
  /** Always null in B4.1. */
  recommendation: null
  recommendation_status: 'not_defined'
  recommendation_reason: string
  recommendation_requires: RecommendationRequirement[]
  meta: { currency: string; phase: string }
}
