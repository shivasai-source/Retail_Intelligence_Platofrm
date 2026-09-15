/** The RCA → Simulation context contract — B3.1.
 *
 *  Mirrors backend/app/tpo/investigation.py. Contract types only: B3.1
 *  establishes the data path, and no UI renders any of this yet.
 *
 *  EVERY FIELD CARRIES ITS PROVENANCE, because a context assembled from the
 *  current RCA layer cannot be trusted uniformly. RCA is entirely static —
 *  its causal graph, node details, progress and confidence figures and context
 *  chips are all authored JSON, and one chip reports a trade spend of ₹98.6 Cr
 *  for a scope the validated engine measures at ₹7.7 Cr. So `source` travels
 *  with the data, and `unavailable` is a legitimate answer.
 *
 *  NOTE what this contract does NOT carry: any KPI value. RCA's figures are
 *  presentation data. The scope travels as a FilterState and Simulation
 *  measures it for itself through the same engine the Insights Hub uses.
 */

/** Where a field's value came from. `unavailable` means no system in this
 *  project supplies it; `seed_example` means the value was the example
 *  question seeded into the store, not something the user asked. */
export type ContextProvenance =
  | 'rca'
  | 'command_center'
  | 'filter_state'
  | 'seed_example'
  | 'unavailable'

/** One field of the context. A `value` of null always has a `reason`. */
export interface ContextField<T> {
  value: T | null
  source: ContextProvenance
  reason: string | null
}

export interface ContextFocus {
  /** Always unavailable today — RCA records no KPI under investigation. */
  kpi: ContextField<string>
  promotion_id: ContextField<string>
  product_id: ContextField<string>
  channel_id: ContextField<string>
  region: ContextField<string>
  period: ContextField<string>
}

export interface InvestigationContextRequest {
  filters: Record<string, unknown>
  question?: string | null
  /** False means the user has not run an investigation, so whatever question
   *  the store holds is the seeded example rather than theirs. The backend
   *  refuses to report a seeded question as the investigation's own. */
  investigation_started?: boolean
  /** Reserved. RCA assigns no identifier today. */
  investigation_id?: string | null
  investigation_type?: string | null
  problem_statement?: string | null
}

export interface SimulationContext {
  source: 'rca'
  investigation_id: ContextField<string>
  investigation_type: ContextField<string>
  question: ContextField<string>
  problem_statement: ContextField<string>
  /** THE one filter contract, carried whole — the same object
   *  /simulation/run and /simulation/simulate accept. Sourced from the Command
   *  Center, because RCA produces no FilterState of its own. */
  filter_state: ContextField<Record<string, unknown>>
  scope: {
    period: string
    period_label: string
    row_count: number
    promoted_row_count: number
    has_data: boolean
  }
  focus: ContextFocus
  /** Always false. Stated as a field so a client cannot assume otherwise. */
  carries_kpi_values: boolean
  /** Every field the contract could not fill, named. */
  missing: string[]
  complete: boolean
}
