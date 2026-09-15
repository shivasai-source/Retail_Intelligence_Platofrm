export interface OrchNode {
  key: string
  label: string
  metric: string
  delta: string
  trend: 'up' | 'down' | ''
  impact: 'strong' | 'moderate' | 'negative' | 'risk' | 'data'
  icon: string
  pos: { x: number; y: number }
}

export interface Accelerator {
  key: string
  name: string
  desc: string
  status: 'Completed' | 'In Progress'
  icon: string
  tone: 'success' | 'warning'
  node?: string
}

export interface NodeVizItem {
  label: string
  value: number
  tone?: 'muted' | 'accent' | 'accent2'
}

export interface NodeDetail {
  headline: string
  body: string
  evidence: string
  viz?: { type: 'bars'; unit: string; items: NodeVizItem[] }
}

export interface OrchestrationProgress {
  completed: number
  total: number
  pct: number
  insights: number
  sources: number
  // B9 removed `confidence` and `confidenceDelta`. No engine in this project
  // produces a confidence figure — B6 assesses governance and reports what is
  // undefined, and B5's weekly view is explicitly not a forecast. The fields
  // are gone from the type as well as the data so nothing can re-read them.
}

export interface Orchestration {
  center: { label: string; sub: string }
  /** `roi` is the scope's Promotion ROI multiple as text ("0.96"); `source`
   *  names the dataset. Optional because older stored runs predate them. */
  contextChips: { period: string; channel: string; region: string; spend: string; roi?: string; source?: string }
  nodes: OrchNode[]
  accelerators: Accelerator[]
  progress: OrchestrationProgress
  nodeDetails: Record<string, NodeDetail>
}

export interface LegendItem {
  label: string
  color: string
  style: 'solid' | 'dashed'
}

export interface LegacyInvestigation {
  title: string
  subtitle: string
  businessQuestion: string
  contextChips: { period: string; channel: string; region: string; spend: string }
  center: { label: string; sub: string }
  nodes: OrchNode[]
  accelerators: Accelerator[]
  progress: OrchestrationProgress
  legend: LegendItem[]
  nodeDetails: Record<string, NodeDetail>
}

export interface InvestigationTypeMeta {
  key: string
  title: string
  badge: string
  tone: 'danger' | 'violet' | 'success' | 'warning'
  icon: string
  desc: string
  example: string
  duration: string
  questions: string[]
}

export interface InvestigationsData {
  legacyDefault: LegacyInvestigation
  orchestrations: Record<string, Orchestration>
}
