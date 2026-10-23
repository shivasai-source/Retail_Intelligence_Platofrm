import type { AnalystModule } from '../hooks/useAnalyst'
import { applyMmmAnalystActions, type MmmAnalystAction } from './analystActions'
import { useMmmHubLayout } from './hubLayout'

/** THE ANALYST, ON THE MMM INSIGHTS HUB.
 *
 *  Everything that differs from the TPO hub's, in one object: its endpoint,
 *  how to read what the page is showing, who applies the changes, what it says
 *  about itself, and its own pair of hand-off keys for the pop-out window.
 *  Everything else — the thread, the fact store, the panel, the chart
 *  renderer, the undo chip — is the same component on both hubs.
 *
 *  WHY ITS OWN HAND-OFF KEYS. localStorage is shared by every window of this
 *  origin, so one pair would let a conversation about trade spend arrive in
 *  the MMM pop-out, where every follow-up in it would be answered from the
 *  wrong dataset.
 */
export const MMM_ANALYST: AnalystModule = {
  endpoint: '/mmm/analyst/ask',
  dashboardState: () => useMmmHubLayout.getState().dashboardState(),
  // The two action vocabularies are siblings, not the same type: MMM's period
  // carries a quarter and real dates, TPO's carries business weeks, and MMM
  // has a granularity action TPO has no equivalent of. The cast is the one
  // place that is admitted, and the applier below is the only thing that reads
  // these objects — the hook never looks inside one.
  applyActions: (actions) => applyMmmAnalystActions(actions as unknown as MmmAnalystAction[]),
  undoDepth: () => useMmmHubLayout.getState().history.length,
  subtitle: 'Marketing mix assistant',
  blurb:
    'What would you like to know about your marketing investment? Ask about revenue, ad '
    + 'spend, ROAS or the baseline, by year, quarter, channel or promotion — or tell me to '
    + 'change the period or which charts are on screen.',
  starters: [
    { kind: 'Look up', icon: 'search', q: 'What was our ROAS last year?' },
    { kind: 'Rank', icon: 'barChart', q: 'Which channel had the best ROAS?' },
    { kind: 'Chart', icon: 'pieChart', q: 'Chart ad spend by channel' },
    { kind: 'Change the page', icon: 'filter', q: 'Show me Q3 of last year' },
  ],
  handoff: { toWindow: 'tiq.mmm.analyst.toWindow', toPanel: 'tiq.mmm.analyst.toPanel' },
  windowRoute: '#/mmm/analyst',
  windowName: 'mmm-analyst',
  windowTitle: 'Analyst · MMM Intelligence',
  homeRoute: '/mmm/insights',
}
