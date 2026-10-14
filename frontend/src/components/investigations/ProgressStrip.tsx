import { Button } from '../ui'
import { Card } from '../ui'
import { Icon } from '../../icons'

// Ported from js/pages/investigations.js's `.inv-progress-strip` block.
export function ProgressStrip({
  pct,
  sub,
  insights,
  records,
  canViewSummary,
  onViewSummary,
}: {
  pct: number
  sub: string
  /** Findings the completed run produced — `synthesis.insight_count`, which is
   *  the count of specialist findings, not of agents or of tools. */
  insights: number
  /** Rows the investigated SCOPE holds, from `orchestration.progress.sources`.
   *  This used to be labelled "Data Sources Connected" and carried the size of
   *  the whole fact table — the same 205,920 for every investigation, which
   *  described the dataset rather than the run. */
  records: number
  /** False until the run has produced a synthesis — there is nothing to carry
   *  into Promotion Intelligence before then. */
  canViewSummary: boolean
  onViewSummary: () => void
}) {
  return (
    // B9 removed the "Confidence Score" tile that stood here. It printed a
    // percentage — 82%, "↑ +6 pp vs last run" — that nothing in this project
    // computes. The remaining tiles count findings and rows, which are
    // properties of the run itself.
    <Card className="fade-in mt-4 grid grid-cols-[2fr_1fr_1fr_auto] items-center gap-6 p-[20px_24px] @max-[1000px]:grid-cols-1 @max-[1000px]:gap-4">
      <div>
        <div className="mb-1.5 text-md font-medium text-ink-primary">Investigation Progress</div>
        <div className="flex items-center gap-2.5">
          <div className="h-2.5 flex-1 overflow-hidden rounded [background:var(--surface-muted)]">
            <div
              className="h-full rounded bg-[linear-gradient(90deg,var(--brand-violet),var(--brand-blue))] transition-[width] duration-[1100ms] ease-[cubic-bezier(0.16,1,0.3,1)]"
              style={{ width: `${pct}%` }}
            />
          </div>
          <span className="text-lg font-normal text-ink-primary [font-variant-numeric:tabular-nums]">{pct}%</span>
        </div>
        <div className="mt-1.5 text-base text-ink-muted">{sub}</div>
      </div>

      <Stat label="Insights Identified" value={insights.toLocaleString()} sub="Key findings" />
      <Stat label="Total Records Analyzed" value={records.toLocaleString()} sub="Rows in this scope" />

      <Button
        variant="primary"
        size="md"
        className="cursor-pointer whitespace-nowrap"
        disabled={!canViewSummary}
        title={canViewSummary ? 'Open Promotion Intelligence' : 'Available once the investigation completes'}
        onClick={onViewSummary}
      >
        <Icon name="file" /> View Insights Summary
      </Button>
    </Card>
  )
}

function Stat({ label, value, sub }: { label: string; value: string; sub: string }) {
  return (
    <div>
      <div className="text-base font-medium text-ink-muted">{label}</div>
      <div className="kpi-value mt-0.5 text-ink-primary">
        {value}
      </div>
      <div className="mt-0.5 text-sm text-ink-muted">{sub}</div>
    </div>
  )
}
