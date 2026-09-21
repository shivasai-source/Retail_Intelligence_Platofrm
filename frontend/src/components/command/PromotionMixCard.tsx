import { useMemo, useState } from 'react'
import { SERIES } from './series'
import { Segmented } from './Segmented'
import { Card, CardHeader, CardBody, InfoBlock, InfoPopover } from '../ui'
import { DonutBreakdown } from '../charts'
import type { BreakdownResponse, PromotionMixResponse } from '../../types/commandCenter'

/** Promotion Mix by Scheme, switchable between Trade Spend and Incremental
 *  Sales.
 *
 *  Values come from `/breakdown?by=promotion_mechanic`, which already returns
 *  BOTH metrics per scheme — no new endpoint. Grouping by SCHEME rather
 *  than by offer is what makes the 20% seasonal scheme visible: it is six
 *  Promotion_Ids (PBNY24 … PBDI24) sharing one Promotion_Name, so grouping by
 *  offer scattered the largest 2024 scheme across six slices and never named
 *  it.
 *
 *  COLOUR IS THE PAGE'S SERIES PALETTE, BY RANK (see series.ts). The
 *  Performance Trend draws Incremental Sales in the brand violet, Trade
 *  Spend in orange and ROI in teal; the slices take those three in order of
 *  size, then a light pink, so the two charts share one vocabulary.
 *  The six-colour palette `/promotion-mix` carries (violet, blue, teal,
 *  amber, red, grey) was the one thing on the page that did not match, and
 *  is ignored on purpose; its labels are still used.
 *
 *  Both metrics decompose exactly across schemes in this dataset: the slices
 *  sum to the headline Trade Spend and Incremental Sales to the rupee (each
 *  promoted row belongs to exactly one scheme). Shares are therefore taken
 *  against the sum of the slices, which IS the headline total, and they add up
 *  to 100%. The centre total is the KPI card's own display value for the same
 *  scope, so the donut and the card above it can never disagree.
 */

const METRICS = [
  { key: 'trade_spend' as const, label: 'Trade Spend' },
  { key: 'incremental_sales' as const, label: 'Incremental Sales' },
]
type MetricKey = (typeof METRICS)[number]['key']

const HINT: Record<MetricKey, string> = {
  trade_spend: 'Share of total trade spend by promotion scheme.',
  incremental_sales: 'Share of total incremental sales by promotion scheme.',
}

export function PromotionMixCard({
  mix,
  breakdown,
  tradeSpendTotal,
  incrementalSalesTotal,
  emptyState,
}: {
  mix: PromotionMixResponse | undefined
  breakdown: BreakdownResponse | undefined
  /** Formatted headline totals, straight from the KPI cards. */
  tradeSpendTotal: string
  incrementalSalesTotal: string
  emptyState: React.ReactNode
}) {
  const [metric, setMetric] = useState<MetricKey>('trade_spend')

  const segments = useMemo(() => {
    if (!breakdown?.groups.length) return []
    const style = new Map((mix?.slices ?? []).map((s) => [s.code, s]))
    const valued = breakdown.groups.map((g) => ({
      code: g.code,
      label: style.get(g.code)?.label ?? g.label,
      // null means the metric is undefined for that offer in this scope — it
      // contributes nothing to the total rather than being dropped silently.
      amount: (metric === 'trade_spend' ? g.trade_spend : g.incremental_sales) ?? 0,
      display: metric === 'trade_spend' ? g.trade_spend_display : g.incremental_sales_display,
    }))
    // Share is of the selected metric's own total — never carried over from
    // the other metric.
    const total = valued.reduce((sum, v) => sum + v.amount, 0)
    return valued
      .sort((a, b) => b.amount - a.amount)
      .map((v, rank) => ({
        key: v.label,
        pct: total ? Math.round((v.amount / total) * 1000) / 10 : 0,
        color: RAMP[Math.min(rank, RAMP.length - 1)],
        value: v.display,
      }))
  }, [breakdown, mix, metric])

  const centerValue = metric === 'trade_spend' ? tradeSpendTotal : incrementalSalesTotal
  const centerLabel = metric === 'trade_spend' ? 'Total Spend' : 'Total Inc. Sales'

  return (
    // A flex column so the body can take the height its row partner (the
    // channel chart) sets, and centre the ring in it instead of leaving the
    // bottom third of the card blank.
    <Card className="flex flex-col">
      <CardHeader
        title={
          <span className="flex items-center gap-1.5">
            Promotion Mix by Scheme
            <InfoPopover label="About Promotion Mix" title="Promotion Mix">
              <InfoBlock label="Shows">{HINT[metric]}</InfoBlock>
            </InfoPopover>
          </span>
        }
      />
      {/* The metric toggle sits on its own strip rather than in the header.
          At this card's width the header could not hold the title, its ⓘ and a
          two-button control on one line, so the title wrapped and the header
          grew to 82px while its row partner stayed at 63 — the two cards then
          started their content at different heights. Same strip the ChartFrame
          cards use. */}
      <div className="flex flex-wrap items-center gap-2 border-b border-border-subtle px-5 py-2.5">
        <Segmented ariaLabel="Promotion Mix metric" value={metric} onChange={setMetric} options={METRICS} />
      </div>
      <CardBody className="flex flex-1 items-center px-6">
        {segments.length > 0 ? (
          <DonutBreakdown
            segments={segments}
            size={236}
            stroke={34}
            centerValue={centerValue}
            centerLabel={centerLabel}
            bars
            decimals={1}
            className="w-full gap-8"
          />
        ) : (
          emptyState
        )}
      </CardBody>
    </Card>
  )
}

/** Largest slice first: the page's Incremental Sales, Trade Spend and ROI
 *  colours (series.ts), then a light pink -- the rose
 *  tint's icon colour, softened -- for the fourth, which the trend chart has
 *  no series for. The tokens resolve per theme, so the dark palette needs no
 *  second list. */
const RAMP = [
  SERIES.incremental,
  SERIES.spend,
  SERIES.roi,
  // Toward WHITE, not transparent: over the dark card a translucent pink
  // went mauve. A tint stays pink on either ground.
  'color-mix(in srgb, var(--tint-rose-icon) 55%, white)',
  'color-mix(in srgb, var(--text-primary) 14%, transparent)',
  'color-mix(in srgb, var(--text-primary) 8%, transparent)',
]
