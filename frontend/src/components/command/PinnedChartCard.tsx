import { Card, CardBody, CardHeader, IconButton } from '../ui'
import { AnalystChart, type AnalystChartSpec } from '../analyst/AnalystChart'
import { useBreakdown } from '../../hooks/useCommandCenter'
import { useHubLayout, type PinnedChart } from '../../store/hubLayout'
import { EmptyState, ErrorState, PanelSkeleton } from './States'
import type { BreakdownDimension, BreakdownGroup, BreakdownMetric } from '../../types/commandCenter'

// A CHART THE ANALYST WAS ASKED TO KEEP ON THE PAGE.
//
// "Add a chart of ROI by channel to the dashboard" used to be answered with a
// chart in the chat — which is gone the moment the thread is cleared, and was
// never what was asked.
//
// IT IS A FIRST-CLASS PANEL, not a screenshot of one. The card runs the Hub's
// OWN breakdown query (`useBreakdown`, the same hook the Channel and Product
// panels use) from the Hub's OWN filter state, so it re-draws with everything
// else when the period or a filter changes. That is the whole reason the
// Analyst pins a SHAPE rather than the figures it had computed: a chart
// carrying August's numbers while the cards beside it moved to September would
// be worse than no chart at all.
//
// THE READER CAN TAKE IT OFF without going back to the chat — a × on the
// card, undoable like every other layout change. A panel you can only remove
// by asking the assistant that added it is a panel you are stuck with.

/** The breakdown's own display strings, turned into the one chart shape the
 *  renderer takes. Nothing is computed here: `value` and `display` are the
 *  backend's, so a pinned chart cannot disagree with the panel beside it. */
function toSpec(
  chart: PinnedChart,
  groups: BreakdownGroup[],
  unit: string,
  targetRoi?: number,
): AnalystChartSpec {
  const metric = chart.metric as BreakdownMetric
  const read = (g: BreakdownGroup): { value: number; display: string } => {
    if (metric === 'roi') return { value: g.roi ?? 0, display: g.roi == null ? '—' : `${g.roi.toFixed(2)}x` }
    if (metric === 'trade_spend') return { value: g.trade_spend, display: g.trade_spend_display }
    if (metric === 'incremental_units') {
      return { value: g.incremental_units ?? 0, display: (g.incremental_units ?? 0).toLocaleString('en-IN') }
    }
    return { value: g.incremental_sales ?? 0, display: g.incremental_sales_display }
  }
  return {
    type: chart.chart_type,
    unit,
    points: groups.map((g) => ({ label: g.label, ...read(g) })),
    // A RATIO IS READ AGAINST SOMETHING. For ROI that is the target the rest
    // of the page judges every promotion against, so the panel agrees with
    // the alerts and the trend line rather than inventing its own scale.
    reference:
      metric === 'roi' && targetRoi
        ? { value: targetRoi, label: `Target ${targetRoi.toFixed(2)}x` }
        : undefined,
  }
}

const UNIT: Record<string, string> = {
  incremental_sales: 'Incremental Sales',
  trade_spend: 'Trade Spend',
  incremental_units: 'Incremental Units',
  roi: 'ROI',
}

export function PinnedChartCard({ chart }: { chart: PinnedChart }) {
  const unpin = useHubLayout((s) => s.unpinChart)
  const change = useHubLayout((s) => s.change)
  const breakdown = useBreakdown(chart.by as BreakdownDimension, {
    metric: chart.metric as BreakdownMetric,
    limit: 8,
  })

  return (
    <Card className="flex flex-col">
      <CardHeader
        title={
          <span className="flex items-center gap-1.5">
            {chart.title}
            <span className="rounded-[var(--r-pill)] bg-brand-violet-50 px-1.5 py-0.5 text-2xs font-medium text-brand-violet">
              Added by the Analyst
            </span>
          </span>
        }
        actions={
          <IconButton
            icon="x"
            title="Remove this chart from the dashboard"
            onClick={() => change(`removed ${chart.title}`, () => unpin(chart.id))}
          />
        }
      />
      <CardBody>
        {breakdown.isLoading ? (
          <PanelSkeleton height={240} />
        ) : breakdown.error ? (
          <ErrorState
            error={breakdown.error}
            onRetry={() => void breakdown.refetch()}
            retrying={breakdown.isFetching}
            compact
          />
        ) : !breakdown.data?.groups.length ? (
          <EmptyState message="No rows in this selection." />
        ) : (
          <AnalystChart
            spec={toSpec(
              chart,
              breakdown.data.groups,
              UNIT[chart.metric] ?? chart.metric,
              breakdown.data.meta?.target_roi,
            )}
            plain
          />
        )}
      </CardBody>
    </Card>
  )
}
