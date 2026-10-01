import { AppShell } from '../components/layout/AppShell'
import { Card, CardBody, CardHeader } from '../components/ui'
import { EmptyState } from '../components/command/States'
import { MMM_NAV, mmmDatasetStatus } from '../components/connections/mmm'

// MMM — INSIGHTS HUB. The same page TPO's Insights Hub is, with the one thing
// MMM does not have left out: numbers.
//
// WHAT IS SHARED. The shell (AppShell -> Sidebar + Topbar), the ambient wash,
// the title row and its type steps, the 1.7fr/1fr panel row, the two-column
// chart rows, Card/CardHeader/CardBody and the EmptyState disc are all the
// components pages/CommandCenter.tsx renders, used unchanged. Nothing here
// restyles anything: a reader moving between the two hubs sees one template.
//
// WHAT IS DELIBERATELY ABSENT. Every KPI tile, chart, filter, trend and alert
// on the TPO hub is computed by the backend from the six star-schema CSVs.
// MMM has no ingestion, no API and no dataset, so this page has nothing to
// compute from — and CommandCenter's own rule applies ("never a grid of 0s,
// which would read as a genuine result"). So there is no KPI deck of dashes,
// no chart drawn from placeholder series, and no metric whose formula this
// page invented. Each panel is its frame plus an explicit, honest empty state.
//
// WHY THE PANELS ARE NAMED AT ALL. The names below are the analysis areas the
// module brief lists — marketing contribution, channel performance, media
// effectiveness, baseline vs incremental, spend and return. They are layout
// slots, not a contract: no formula, no unit and no denominator is asserted
// anywhere on this page. When the MMM data contract is agreed and an
// /api/mmm/* endpoint exists, each panel's body is where its real content
// lands, and the frame around it does not have to change.

/** The panels this hub will carry, in TPO's own reading order: the trend that
 *  answers "what happened", then the breakdowns that answer "where". */
const LEAD_PANEL = 'Marketing Contribution Trend'
const SIDE_PANEL = 'Channel Performance'
const GRID_PANELS: Array<[string, string]> = [
  ['Media Effectiveness', 'Baseline vs Incremental Sales'],
  ['Spend & Return by Channel', 'Marketing ROI'],
]

/** One framed, empty panel. Same Card/CardHeader/CardBody as every panel on
 *  the TPO hub, so the two pages' panels are the same object. */
function Panel({ title, height = 220 }: { title: string; height?: number }) {
  return (
    <Card className="flex flex-col">
      <CardHeader title={title} />
      <CardBody className="flex-1">
        <div style={{ minHeight: height }} className="grid place-items-center">
          <EmptyState
            compact
            icon="database"
            message="No MMM data connected"
            hint="This panel stays empty until an MMM source is connected."
          />
        </div>
      </CardBody>
    </Card>
  )
}

export function MmmInsights() {
  return (
    <AppShell
      activeKey="insights"
      crumbs={[{ label: 'MMM Intelligence' }, { label: 'Insights Hub' }]}
      nav={MMM_NAV}
      brand="MMM Intelligence"
      brandHref="/home"
      datasetComplete={mmmDatasetStatus().complete}
    >
      {/* The same decorative wash the TPO hub carries behind its header. */}
      <div className="cc-ambient" aria-hidden="true" />

      <div className="fade-in relative z-20">
        <div className="flex flex-wrap items-center justify-between gap-x-6 gap-y-3">
          <div className="min-w-0">
            {/* Type steps copied from CommandCenter's title, not re-chosen. */}
            <h1 className="text-2xl font-extrabold tracking-[-0.025em] leading-[1.1]">MMM Insights Hub</h1>
            <p className="mt-1.5 text-base text-ink-muted">
              Where marketing investment meets its return
              <span className="text-ink-disabled"> · </span>
              No data connected
            </p>
          </div>
        </div>
      </div>

      {/* The panel rows, in the TPO hub's own grid: one wide + one narrow,
          then two-column rows. Same class strings as CommandCenter. */}
      <div className="mt-[14px] grid grid-cols-[minmax(0,1.7fr)_minmax(0,1fr)] gap-4 @max-[1000px]:grid-cols-1">
        <Panel title={LEAD_PANEL} height={260} />
        <Panel title={SIDE_PANEL} height={260} />
      </div>

      {GRID_PANELS.map(([left, right]) => (
        <div key={left} className="mt-[14px] grid grid-cols-2 gap-4 @max-[1000px]:grid-cols-1">
          <Panel title={left} />
          <Panel title={right} />
        </div>
      ))}
    </AppShell>
  )
}
