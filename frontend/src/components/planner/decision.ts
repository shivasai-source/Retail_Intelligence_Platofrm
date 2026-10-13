import { scenarioSignature, type DecisionScenario, type ScenarioKpi } from '../../store/decisionScenarios'
import type { Deltas, Figures, PlannerSelection } from '../../types/planner'

/** A planner result as a Decision Center scenario.
 *
 *  The Decision Center renders display strings and never recalculates, so a
 *  scenario carries the planner's own strings. Its three "lever" chips become
 *  the plan's average discount, its period and its trade spend. */
export function plannerScenario({
  kind,
  label,
  selection,
  currency,
  current,
  plan,
  deltas,
  weeks,
}: {
  kind: string
  label: string
  selection: PlannerSelection
  currency: string
  current: Figures
  plan: Figures
  deltas: Deltas
  weeks: number
}): Omit<DecisionScenario, 'id' | 'slot' | 'addedAt'> {
  const roi = plan.roi.value
  const tone: ScenarioKpi['tone'] = roi == null ? 'neutral' : roi >= 1.05 ? 'success' : roi >= 0.95 ? 'warning' : 'danger'
  const vs = (d: { absolute: { display: string }; percent_display: string }) => `${d.absolute.display} (${d.percent_display}) vs current plan`
  const levers = {
    discount_pct: plan.avg_discount.value ?? 0,
    trade_spend: plan.trade_spend.value ?? 0,
    days: weeks * 7,
  }
  const filters = { ...selection, plan: kind } as Record<string, unknown>
  return {
    signature: scenarioSignature(filters, currency, levers),
    scope: { label: `${kind} · ${label}`, filters, currency },
    levers,
    kpis: [
      { key: 'discount', label: 'Average discount', value: plan.avg_discount.display, sub: `current plan ${current.avg_discount.display}` },
      { key: 'days', label: 'Period', value: `${weeks} weeks` },
      { key: 'budget', label: 'Trade spend', value: plan.trade_spend.display },
      { key: 'profit', label: 'Profit', value: plan.profit.display, sub: vs(deltas.profit), raw: plan.profit.value },
      { key: 'profit_pct', label: 'Profit %', value: plan.profit_pct.display, sub: `${deltas.profit_pct.absolute_display} vs current plan`, raw: plan.profit_pct.value },
      { key: 'revenue', label: 'Revenue', value: plan.revenue.display, sub: vs(deltas.revenue), raw: plan.revenue.value },
      { key: 'roi', label: 'ROI', value: plan.roi.display, sub: `${deltas.roi.absolute_display} vs current plan`, tone, raw: roi },
      { key: 'trade_spend', label: 'Trade spend', value: plan.trade_spend.display, sub: `current plan ${current.trade_spend.display}`, raw: plan.trade_spend.value },
      { key: 'incremental_sales', label: 'Incremental sales', value: plan.incremental_sales.display, sub: `current plan ${current.incremental_sales.display}`, raw: plan.incremental_sales.value },
      { key: 'incremental_units', label: 'Incremental units', value: plan.incremental_units.display, sub: `current plan ${current.incremental_units.display}`, raw: plan.incremental_units.value },
      { key: 'margin', label: 'Gross margin', value: plan.margin_pct.display, sub: `current plan ${current.margin_pct.display}`, raw: plan.margin_pct.value },
      { key: 'promotions', label: 'Promotions', value: plan.promotions.display, sub: `current plan ${current.promotions.display}` },
    ],
  }
}
