import type { RiskAlert } from '../../types/commandCenter'

/** How Risk Alerts are prioritised in the Insights Hub.
 *
 *  Kept apart from the panel component so both the panel and the hero banner
 *  read ONE definition — the banner cannot disagree with the list beneath it.
 *
 *  This re-ranks, it never recomputes: every ROI, stake and severity is the
 *  value the backend produced. No financial figure is derived here.
 *
 *  SEVERITY decides the segment; FINANCIAL IMPACT decides the order within it.
 *  Ranking by worst ROI instead fills the Critical tab with tiny 5% Discount
 *  events — technically the lowest ROI, but a rounding error in money terms —
 *  and buries the large promotions that actually put revenue at risk.
 */

export const SEVERITIES = ['Critical', 'High', 'Medium'] as const
export type Severity = (typeof SEVERITIES)[number]

/** Critical beats High beats Medium. */
export const SEVERITY_RANK: Record<Severity, number> = { Critical: 0, High: 1, Medium: 2 }

/** Highest financial impact first: At Stake descending, with the weaker ROI
 *  breaking ties. `at_stake` is the API's own figure — the additional
 *  incremental revenue the event needs to reach target — not a number
 *  computed here. */
export function rankByImpact(a: RiskAlert, b: RiskAlert): number {
  return b.at_stake - a.at_stake || (a.roi_multiple ?? 0) - (b.roi_multiple ?? 0)
}

/** THE priority order: severity band first, then largest stake, with ROI only
 *  as a tie-break. So a Critical always outranks a High however small, and
 *  within Critical the most money at stake comes first.
 *
 *  It agrees with the ordering `service.risk_alerts` already emits — that route
 *  concatenates Critical -> High -> Medium and sorts each band by At Stake
 *  descending. Applying it here re-establishes that order over a set the client
 *  may have re-segmented; it does not replace it with a different one. */
function byPriority(a: RiskAlert, b: RiskAlert): number {
  return SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity] || rankByImpact(a, b)
}

/** The `count` highest-priority alerts, in order. Empty when there are none.
 *
 *  The notification bell and the hero banner both read this, so the bell can
 *  never disagree with the banner about which alert matters most. */
export function topAlerts(alerts: RiskAlert[] | undefined, count: number): RiskAlert[] {
  if (!alerts?.length) return []
  return [...alerts].sort(byPriority).slice(0, count)
}

/** The single highest-priority alert. Undefined when the selection has none. */
export function topPriorityAlert(alerts: RiskAlert[] | undefined): RiskAlert | undefined {
  return topAlerts(alerts, 1)[0]
}

/** "ROI below target — Diwali Special 25" -> "ROI below target".
 *
 *  The complement of RiskAlertsPanel's `promotionOf`: that one recovers the
 *  promotion the API appended, this one the reason it appended it to. Neither
 *  invents a message — both split the title the backend built. */
export function alertHeadline(alert: RiskAlert): string {
  const dash = alert.title.indexOf('—')
  return dash === -1 ? alert.title : alert.title.slice(0, dash).trim()
}

/** How many alerts the Insights Hub fetches.
 *
 *  DELIBERATELY THE WHOLE SET. `/risk-alerts` emits ONE concatenated
 *  Critical -> High -> Medium list and truncates the tail, so a small `limit`
 *  cannot reach the top of the High band. Both the Insights Hub panel and the
 *  notification bell request this same figure, which means React Query serves
 *  them from ONE cache entry and one request rather than two. */
export const ALERT_FETCH_LIMIT = 100000
