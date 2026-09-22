import type { OrchNode } from '../../types/orchestration'
import type { AgentFinding } from '../../types/agentRun'

/** What the node shows when the change cannot be computed — a baseline of zero
 *  neighbour sales has no percentage change to express. The popover carries the
 *  specialist's own sentence explaining why. */
export const NOT_AVAILABLE = '—'

/** The Cannibalization Agent's graph node has to show the figure the agent
 *  actually computed, not the one it wrote about.
 *
 *  WHY THIS EXISTS. Every node's headline figure comes from the specialist's
 *  free-text `metric`/`delta`, which the model fills in. For most specialists
 *  that is fine — the figure is one of many groups in their table and only the
 *  model knows which one is worth showing. Cannibalization is different: it has
 *  ONE defined headline number, `neighbour_units_change_pct`, computed by
 *  `neighbour_sales_decline()` in agents/star_tools.py. Binding the node to the
 *  prose let three things through:
 *
 *    - the raw field name, `neighbour_sales_change_pct`, printed as if a value
 *    - an empty figure where a computed one existed (8.7, 1.4)
 *    - a figure that CONTRADICTED the computed one (-9.7% shown against 0.3)
 *
 *  So the node reads the computed value directly. Nothing is invented: when the
 *  tool could not produce a number the node says so rather than filling the gap.
 *
 *  SIGN CONVENTION (fixed, mirrors the tool): negative = neighbour sales fell,
 *  which is consistent with cannibalization; positive = neighbour sales rose.
 *  The sign is always rendered, so '+8.7%' can never be misread as a decline.
 */
export function bindCannibalizationNode(nodes: OrchNode[], findings: AgentFinding[]): OrchNode[] {
  return nodes.map((n) => {
    if (n.key !== 'cannibalization') return n
    const finding = findings.find((f) => f.key === 'cannibalization')
    // VOLUME FIRST, MONEY AS THE FALLBACK. The tool reports both; units are the
    // headline because the money equivalent sums every store in the channel,
    // which reads as a huge number for what is a few hundred packs.
    //
    // The fallback is for RUNS RECORDED BEFORE the units measure existed. They
    // carry only `neighbour_sales_change_pct`, and reading the new field alone
    // left their node showing an em dash while the popover beside it still
    // displayed the money figure the run actually computed -- the node and its
    // own detail panel disagreeing about whether a figure exists. An older run
    // shows what it measured; a new one shows volume.
    const neighbours = finding?.analysis_data?.neighbour_analysis
    const pct = neighbours?.neighbour_units_change_pct ?? neighbours?.neighbour_sales_change_pct
    if (typeof pct !== 'number' || !Number.isFinite(pct)) {
      return { ...n, metric: NOT_AVAILABLE, delta: '', trend: '' as const }
    }
    const rounded = Math.round(pct * 10) / 10
    return {
      ...n,
      metric: `${rounded > 0 ? '+' : ''}${rounded.toFixed(2)}%`,
      delta: '',
      trend: '' as const,
    }
  })
}
