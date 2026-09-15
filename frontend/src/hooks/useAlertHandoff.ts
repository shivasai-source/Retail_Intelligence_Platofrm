import { useNavigate } from 'react-router-dom'
import { useCommandFilters } from '../store/commandFilters'
import { useActiveInvestigationStore } from '../store/activeInvestigation'
import { ASK_WHY_STATE_KEY, buildAskWhyIntent } from '../lib/askWhy'
import { toSimulationFilters } from './useSimulation'
import type { RiskAlert } from '../types/commandCenter'

/** THE COMMAND CENTER -> RCA HAND-OFF for a risk alert (B3.2).
 *
 *  EXTRACTED, NOT REWRITTEN. This is the function that lived in
 *  `pages/CommandCenter.tsx`, moved verbatim so the notification bell in the
 *  Topbar can open the SAME investigation the Insights Hub's own alert rows
 *  open. A second copy in the header would be a second RCA flow, free to drift
 *  from the first about what scope it hands over.
 *
 *  These call sites already held the clicked entity and threw it away,
 *  navigating with nothing. They hand over the Insights Hub's own validated
 *  FilterState, narrowed only by identifiers the source ACTUALLY provides.
 *
 *  A RISK ALERT CARRIES THE EVENT'S CODES — promotion, product and channel —
 *  so all three narrow the scope. That is what makes a row's ROI and the
 *  Simulation Studio's Current Plan describe the same population: a -3.6%
 *  alert is one SKU in one channel, and handing over an unnarrowed selection
 *  made Simulation answer for the whole promotion instead.
 *
 *  THE WEEK NOW SCOPES THE INVESTIGATION, AND MUST. It used to be carried as a
 *  label only, because a week-narrowed scope reported -100% instead of the
 *  row's own ROI — the baseline set held nothing but the promoted row, so
 *  Incremental Sales computed as 0. That was a bug in `baseline_rows_for`,
 *  which now lifts the week for the baseline pass alone (the counterfactual is
 *  by definition the weeks the promotion was NOT running), so the reason for
 *  dropping it is gone.
 *
 *  Dropping it was not a harmless simplification. An alert's ROI is measured on
 *  ONE week, and an investigation scoped to the whole promotion answers a
 *  different question: across 250 alerts on this dataset, 106 of them — 42% —
 *  reported a different ROI once the week was dropped, and not by a little. An
 *  alert reading 12.9% became 73.3%, so the RCA explained a promotion as
 *  healthy while the row that launched it said it was failing. With the week
 *  carried, the investigation's headline matches the alert's own figure.
 *
 *  The YEAR comes from the same string for the same reason: "2025-W41" is only
 *  a week once you know which year's week it is, and the Insights Hub may be
 *  showing All Years.
 *
 *  Display names ("Modern Trade", not "CH002") still stay in `labels` —
 *  turning one back into a code by guessing would select different rows from
 *  the ones clicked.
 *
 *  Nothing here recomputes anything, and the Insights Hub's own filter state
 *  is not mutated — the hand-off is a copy.
 *
 *  TWO CONSUMERS, ONE CLICK. The scope above is what the Simulation Studio
 *  reads, so its Current Plan describes the population that was clicked. The
 *  Investigations page reads neither the store nor the filters — it takes the
 *  composed question from router state (lib/askWhy) — so the hand-off carries
 *  that too. Sending only one of the pair leaves the other page guessing: the
 *  RCA falls back to a blank prompt, or Simulation answers for the whole
 *  promotion instead of the one SKU in the alert.
 */
/** "2025-W41" -> the year and week that scope the investigation to that event.
 *
 *  Returns nothing for anything it does not recognise, so an alert without a
 *  readable period widens to the promotion rather than scoping to a guess. The
 *  same shape `lib/askWhy.readablePeriod` reads to write the question, so the
 *  sentence and the scope can never describe different periods. */
function periodOf(week?: string | null): { year?: number; week?: number } {
  const match = /^(\d{4})-W(\d{1,2})$/.exec((week ?? '').trim())
  if (!match) return {}
  const year = Number(match[1])
  const number = Number(match[2])
  return number >= 1 && number <= 53 ? { year, week: number } : {}
}

export function useAlertHandoff(): (alert: RiskAlert) => void {
  const navigate = useNavigate()
  // Read-only. The Insights Hub's own filter state is never written here.
  const filters = useCommandFilters((s) => s.filters)
  const startFromCommandCenter = useActiveInvestigationStore((s) => s.startFromCommandCenter)

  return (alert: RiskAlert) => {
    // ONE narrowed FilterState, built once and sent to both consumers, so
    // Simulation and the RCA cannot end up describing different populations
    // from the same click.
    const narrowed = {
      ...filters,
      promotion: [alert.promotion_id],
      product: [alert.product_id],
      channel: [alert.channel_id],
    }
    startFromCommandCenter({
      origin: 'risk_alert',
      label: alert.title,
      filters: narrowed,
      identifiers: {
        promotion_id: alert.promotion_id,
        product_id: alert.product_id,
        channel_id: alert.channel_id,
      },
      labels: { product: alert.product, channel: alert.channel, week: alert.week },
    })
    // `week` is this payload's name for the period; without it the question
    // loses its timeframe.
    const intent = buildAskWhyIntent({
      promotion: alert.title?.split('—').pop()?.trim() ?? alert.title,
      product: alert.product,
      channel: alert.channel,
      period: alert.week,
      roi_multiple: alert.roi_multiple,
      title: alert.title,
      description: alert.description,
    })
    // The same scope Simulation gets, PLUS the event's own week, in the shape
    // the API takes. The RCA runs against THIS, not against whatever the
    // planner reads out of the sentence — see AskWhyIntent.scope.
    //
    // The week is added here rather than to `narrowed` so that only the
    // investigation takes it: `narrowed` is also what Simulation reads, and
    // its own scope semantics are not this hand-off's to change.
    navigate('/investigations', {
      state: {
        [ASK_WHY_STATE_KEY]: {
          ...intent,
          scope: { ...toSimulationFilters(narrowed), ...periodOf(alert.week) },
        },
      },
    })
  }
}
