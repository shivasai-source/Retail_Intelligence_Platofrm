// Mirrors backend/app/intelligence_engine.py and agents/intelligence_agent.py.

export interface SaturationPoint {
  mechanic: string
  depth_pct: number
  roi_multiple: number | null
  incremental_sales: number | null
  trade_spend: number | null
  spend_share_pct: number | null
}

export interface SaturationCurve {
  points: SaturationPoint[]
  target_roi: number
  /** null when the curve never falls below target — no threshold is invented. */
  saturation_depth_pct: number | null
  optimal_range: string
  monotonic_decline: boolean
}

export interface WaterfallEntry {
  label: string
  incremental_sales: number | null
  trade_spend: number | null
  roi_multiple: number | null
}

export interface TrendFacts {
  labels: string[]
  actual: (number | null)[]
  target: (number | null)[]
  trade_spend: (number | null)[]
  roi: (number | null)[]
  gap_to_target: (number | null)[]
  months_below_target: number
  /** The multiple the target series is spend × — the configured ROI hurdle. */
  target_roi: number
}

export type RowStatus = 'on_track' | 'watching' | 'underperforming' | 'unknown'

export interface DimensionRow {
  name: string
  trade_spend: number | null
  incremental_sales: number | null
  roi_multiple: number | null
  spend_share_pct: number | null
  vs_target: number | null
  status: RowStatus
}

export interface RiskFacts {
  counts: Record<string, number>
  at_stake_total: number
  top: { title: string; severity: string; roi_multiple: number | null; trade_spend: number | null; at_stake: number | null }[]
}

export interface IntelligenceFacts {
  scope: Record<string, unknown>
  currency: string
  currency_symbol: string
  kpis: Record<string, number | null>
  whole_business_kpis: Record<string, number | null>
  target_roi: number
  saturation: SaturationCurve
  waterfall: { items: WaterfallEntry[]; total_incremental_sales: number | null; total_trade_spend: number | null; note: string }
  trend: TrendFacts
  by_channel: DimensionRow[]
  by_region: DimensionRow[]
  by_retailer: DimensionRow[]
  by_category: DimensionRow[]
  by_brand: DimensionRow[]
  by_product: DimensionRow[]
  by_mechanic: DimensionRow[]
  risk: RiskFacts
}

export interface KeyInsight {
  title: string
  detail: string
  impact: string
  trend: 'up' | 'down' | 'flat'
  severity: 'critical' | 'high' | 'medium' | 'low' | 'positive'
}

export interface AnalysisDriver {
  driver: string
  weight_pct: number
  direction: 'negative' | 'positive'
  note: string
  is_primary: boolean
}

export interface IntelligenceAnalysis {
  headline: string
  /** Carries [r]/[g]/[n] tone markup for AiAnswerCard. */
  narrative: string
  key_insights: KeyInsight[]
  drivers: AnalysisDriver[]
  uncertainties: string[]
  confidence: number
}

export interface Recommendation {
  action: string
  rationale: string
  evidence: string
  expected_impact: string
  priority: 'high' | 'medium' | 'low'
  effort: 'low' | 'medium' | 'high'
  confidence: number
  simulation: {
    lever: string
    current_value: string
    proposed_value: string
    scope: string
    metric_to_watch: string
  }
}

export interface IntelligenceResult {
  source: string
  scope: Record<string, unknown>
  facts: IntelligenceFacts
  analysis: IntelligenceAnalysis
  recommendations: Recommendation[]
  do_not_do: string[]
  expected_combined_impact: string | null
}

export interface IntelligenceRun {
  id: string
  question: string
  status: 'running' | 'done' | 'error'
  stage: string
  specialists: { key: string; name: string; desc: string; icon: string; status: string }[]
  result: IntelligenceResult | null
  error: string | null
  created_at: number
}

/** What `sections=core` returns — always present once the page has loaded. */
export type CoreFacts = Pick<
  IntelligenceFacts,
  'scope' | 'currency' | 'currency_symbol' | 'target_roi' | 'kpis' | 'whole_business_kpis' | 'saturation' | 'trend' | 'by_mechanic'
>

/** The investigation this page deepens — from GET /promotion-intelligence/context. */
export interface InvestigationContext {
  run_id: string
  question: string
  scope: Record<string, unknown>
  investigation_type: string | null
  root_cause: string | null
  summary: string | null
  confidence: number | null
  findings: { key: string; name: string; headline: string; impact: string; confidence: number }[]
  created_at: number
  /** The run's own scope strip — `orchestration.center` and
   *  `orchestration.contextChips` as the Investigations page draws them.
   *  Null for a refused run, which has no orchestration. */
  subject: { label: string; sub: string } | null
  context_chips: { period: string; channel: string; region: string; spend: string; roi?: string } | null
}

export interface IntelligenceContextResponse {
  investigation: InvestigationContext | null
  analysis: { run_id: string; created_at: number } | null
  /** Other completed investigations that could be deepened instead. */
  available: { run_id: string; question: string; created_at: number }[]
}
