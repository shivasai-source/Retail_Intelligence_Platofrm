import { Card, CardBody, CardHeader, IconButton } from '../../components/ui'
import { AnalystChart, type AnalystChartSpec } from '../../components/analyst/AnalystChart'
import { EmptyState } from '../../components/command/States'
import { BREAKEVEN_ROAS } from './charts'
import { useMmmHubLayout, type MmmPinnedChart } from '../hubLayout'
import type { MmmHub } from '../types'

// A CHART THE ANALYST WAS ASKED TO KEEP ON THE MMM HUB.
//
// "Add a chart of ROAS by channel to the hub" used to be answerable only with
// a chart in the chat — which is gone the moment the thread is cleared, and
// was never what was asked.
//
// IT IS A FIRST-CLASS PANEL, not a screenshot of one. It reads the breakdown
// out of the SAME `MmmHub` payload the six built-in panels are drawn from, so
// it moves with the period and the filters along with everything else, and it
// cannot disagree with the Channel card beside it. That is the whole reason
// the Analyst pins a SHAPE rather than the figures it computed: a chart
// carrying Q3's numbers while the cards beside it moved to Q4 would be worse
// than no chart at all — and on this page the baseline behind every ROAS is
// re-estimated per range, so a stale pinned chart would be stale in a way the
// reader could not see.
//
// NOTHING IS COMPUTED HERE. Every `value` and every `display` is the
// backend's, read straight off the payload.
//
// THE READER CAN TAKE IT OFF without going back to the chat — a × on the card,
// undoable like every other change. A panel you can only remove by asking the
// assistant that added it is a panel you are stuck with.

/** How many groups a pinned card draws. Six is the palette's limit (see
 *  chartPalette.ts) and also about as many bars as a half-width card reads at
 *  a glance. */
const MAX_GROUPS = 6

/** One row of a breakdown, levelled: a name, and the metrics it carries by
 *  key. The four source arrays have different shapes and different name
 *  fields, so they are read into this once rather than branched over twice. */
interface Row {
  label: string
  values: Record<string, number | null>
  displays: Record<string, string>
}

function rowsFor(by: string, data: MmmHub): Row[] {
  switch (by) {
    case 'channel':
      return data.channels.map((c) => ({
        label: c.label,
        values: {
          spend: c.spend, revenue: c.revenue, revenue_attributed: c.revenue_attributed,
          roas: c.roas, share: c.share, active_days: c.active_days,
          avg_active_day: c.avg_active_day,
        },
        displays: {
          spend: c.spend_display, revenue: c.revenue_display,
          revenue_attributed: c.revenue_attributed_display, roas: c.roas_display,
          share: c.share_display, active_days: String(c.active_days),
          avg_active_day: c.avg_active_day_display,
        },
      }))
    case 'family':
      return data.families.map((f) => ({
        label: f.family,
        values: {
          spend: f.spend, revenue: f.revenue, revenue_attributed: f.revenue_attributed,
          roas: f.roas, share: f.share, active_days: f.active_days,
        },
        displays: {
          spend: f.spend_display, revenue: f.revenue_display,
          revenue_attributed: f.revenue_attributed_display, roas: f.roas_display,
          share: f.share_display, active_days: String(f.active_days),
        },
      }))
    case 'promotion':
      return data.promotions.map((p) => ({
        label: p.type,
        values: {
          revenue: p.revenue, spend: p.spend, roas: p.roas, days: p.days,
          avg_revenue: p.avg_revenue, share_of_revenue: p.share_of_revenue,
          share_of_days: p.share_of_days,
        },
        displays: {
          revenue: p.revenue_display, spend: p.spend_display, roas: p.roas_display,
          days: String(p.days), avg_revenue: p.avg_revenue_display,
          share_of_revenue: `${p.share_of_revenue.toFixed(2)}%`,
          share_of_days: `${p.share_of_days.toFixed(2)}%`,
        },
      }))
    case 'event':
      return data.events.map((e) => ({
        label: e.label,
        values: {
          difference: e.difference, with_avg: e.with_avg, without_avg: e.without_avg,
          with_days: e.with_days, without_days: e.without_days,
        },
        displays: {
          difference: e.difference_display, with_avg: e.with_avg_display,
          without_avg: e.without_avg_display, with_days: String(e.with_days),
          without_days: String(e.without_days),
        },
      }))
    default:
      return []
  }
}

/** What the axis is called. Mirrors `unit_label` in
 *  backend/app/agents/mmm_tools.py, minus the currency symbol — the card's own
 *  header carries the period and the figures carry their units. */
const UNIT: Record<string, string> = {
  spend: 'Ad Spend',
  revenue: 'Revenue on Active Days',
  revenue_attributed: 'Attributed Revenue',
  roas: 'ROAS',
  share: 'Share of Ad Spend (%)',
  active_days: 'Active Days',
  avg_active_day: 'Avg Spend per Active Day',
  days: 'Days',
  avg_revenue: 'Avg Daily Revenue',
  share_of_revenue: 'Share of Revenue (%)',
  share_of_days: 'Share of Days (%)',
  difference: 'Lift vs Days Without (%)',
  with_avg: 'Avg Revenue on Those Days',
  without_avg: 'Avg Revenue on Other Days',
}

function toSpec(chart: MmmPinnedChart, rows: Row[]): AnalystChartSpec {
  const metric = chart.metric
  // A ROW THAT COULD NOT BE MEASURED SORTS LAST rather than as zero: a ROAS
  // with no baseline behind it is "not measured", not "nothing".
  const ranked = [...rows].sort((a, b) => {
    const x = a.values[metric]
    const y = b.values[metric]
    if (x == null && y == null) return 0
    if (x == null) return 1
    if (y == null) return -1
    return y - x
  })
  return {
    type: chart.chart_type,
    unit: UNIT[metric] ?? metric,
    points: ranked.slice(0, MAX_GROUPS).map((r) => ({
      label: r.label,
      value: r.values[metric] ?? 0,
      display: r.displays[metric] ?? '—',
    })),
    truncated: ranked.length > MAX_GROUPS,
    // A RATIO IS READ AGAINST SOMETHING. For ROAS that is break-even, the same
    // line the trend draws, so the panel agrees with the chart above it rather
    // than inventing its own scale.
    reference:
      metric === 'roas'
        ? { value: BREAKEVEN_ROAS, label: `Break-even ${BREAKEVEN_ROAS.toFixed(2)}x` }
        : undefined,
  }
}

export function MmmPinnedChartCard({ chart, data }: { chart: MmmPinnedChart; data: MmmHub }) {
  const unpin = useMmmHubLayout((s) => s.unpinChart)
  const change = useMmmHubLayout((s) => s.change)
  const rows = rowsFor(chart.by, data)
  const spec = toSpec(chart, rows)

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
            title="Remove this chart from the hub"
            onClick={() => change(`removed ${chart.title}`, () => unpin(chart.id))}
          />
        }
      />
      <CardBody className="flex-1">
        {spec.points.length === 0 ? (
          // The breakdown this chart groups by has no rows in the current
          // scope — a period with no promotion days, say. Said plainly rather
          // than drawn as an empty axis, which reads as a broken chart.
          <EmptyState
            compact
            icon="barChart"
            message="Nothing to chart in this period"
            hint={`This selection has no ${chart.by} rows. Try a wider period.`}
          />
        ) : (
          <AnalystChart spec={spec} plain />
        )}
      </CardBody>
    </Card>
  )
}
