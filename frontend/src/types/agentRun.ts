// Mirrors backend/app/investigation_runs.py + agents/pipeline.py.
import type { Orchestration } from './orchestration'
import type { InvestigationType } from './investigation'

export type RunStatus = 'running' | 'done' | 'error'
export type SpecialistStatus = 'queued' | 'running' | 'done'

export interface RunSpecialist {
  key: string
  name: string
  desc: string
  icon: string
  status: SpecialistStatus
}

export interface AgentFinding {
  key: string
  name: string
  desc: string
  analysis: string
  headline: string
  body: string
  evidence: string
  metric: string
  delta: string
  trend: 'up' | 'down' | ''
  impact: string
  confidence: number
  /** Raw tool output the specialist analysed. Only the fields the UI binds to
   *  are declared; the payload's shape is the specialist's, not this type's. */
  analysis_data?: {
    neighbour_analysis?: {
      /** Volume change: the lens's headline. Revenue travels beside it. */
      neighbour_units_change_pct?: number | null
      neighbour_sales_change_pct?: number | null
    }
  }
}

export interface AgentSynthesis {
  summary: string
  root_cause: string
  confidence: number
  insight_count: number
  recommendations: string[]
}

export interface AgentRunResult {
  /** False when the question can't be answered from promotion data. */
  answerable?: boolean
  refusal?: string
  investigation_type: InvestigationType
  /** The scope the run was measured over, as the star pipeline stored it —
   *  the caller's hand-off scope when there was one, else the planner's.
   *  FilterState-shaped plus `week`, which is a label rather than a filter.
   *  Absent on an upload run, which has no star-schema dimensions. */
  global_filters?: Record<string, unknown>
  totals: Record<string, string | number | null>
  findings: AgentFinding[]
  synthesis: AgentSynthesis
  // Assembled server-side into the exact shape the graph already renders.
  // Null when the question was refused as out of scope.
  orchestration: Orchestration | null
}

export interface InvestigationRun {
  id: string
  question: string
  dataset_id: string
  status: RunStatus
  stage: string
  specialists: RunSpecialist[]
  result: AgentRunResult | null
  error: string | null
  created_at: number
  updated_at: number
}
