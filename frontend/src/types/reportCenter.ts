/** The Report Center — generated reports and their stored artifacts.
 *
 *  Mirrors backend/app/store/reports.py and app/routers/reports.py.
 *
 *  GENERATE RETURNS METADATA, NEVER BYTES. `generateReport` resolves with a
 *  `ReportRecord`; a file crosses the wire only from `downloadArtifact`, which is
 *  reached only when a person clicks Excel or PDF in the Report Center.
 *
 *  EVERY ROW CORRESPONDS TO A STORED ARTIFACT. There are no seeded or example
 *  reports: an empty library is an empty array, and the page says so.
 */

export type ReportFormat = 'xlsx' | 'pdf'

/** A report is written GENERATING, flipped to READY only once its artifacts
 *  exist, and FAILED with a reason if generation raised. READY is never stored
 *  for a report whose bytes are absent. */
export type ReportStatus = 'generating' | 'ready' | 'failed'

export type ReportModule =
  | 'command-center'
  | 'simulation-studio'
  | 'decision-center'
  | 'investigations'

/** One KPI line as the report captured it — the card's own display string, not
 *  a re-rendering. */
export interface ReportPreviewKpi {
  label: string
  display: string
  previous_display: string
  delta_display: string
  trend: string
  available: boolean
  basis: string
}

/** The stored summary the View action shows. It is the summary the report was
 *  GENERATED with, not a fresh evaluation — re-running the module on open would
 *  show today's numbers under yesterday's report. */
export interface ReportPreview {
  module: string
  title: string
  scope_line: string
  generated_display: string
  headline: string
  headline_tone: string
  kpis: ReportPreviewKpi[]
  highlights: { label: string; value: string }[]
  narrative: string[]
  empty_reason: string
  disclaimers: string[]
}

export interface ReportRecord {
  report_id: string
  name: string
  module: ReportModule
  module_label: string
  title: string
  scope_label: string
  scope: Record<string, unknown>
  /** Every filter dimension named, including the unconstrained ones. */
  filters: [string, string][]
  currency: string
  status: ReportStatus
  error: string | null
  preview: ReportPreview
  /** Filename per format, or null when that artifact does not exist. A download
   *  button is offered only for a format that is present. */
  formats: { xlsx: string | null; pdf: string | null }
  available_formats: ReportFormat[]
  created_at: string
  owner: null
  owner_note: string
}

export interface ReportLibrary {
  reports: ReportRecord[]
  total: number
  returned: number
  modules: { key: ReportModule; label: string }[]
  owner_note: string
}

export interface GenerateReportRequest {
  module: ReportModule
  /** The filter selection, in the dimension names `app/tpo/filters.py` defines. */
  scope: Record<string, unknown>
  /** The module's own control values — INPUTS to the authoritative service,
   *  never results. */
  options?: Record<string, unknown>
  currency?: string
  formats?: ReportFormat[]
}
