import { MMM_PANEL_IDS } from './mmmPanels'
import { MMM_ADDABLE_KPIS } from './kpiDeck'
import { useMmmHubLayout, type MmmGranularity } from './hubLayout'
import { useMmmView, type MmmListKey } from './store'
import type { AppliedActions } from '../lib/analystActions'

// APPLYING WHAT THE MMM ANALYST ASKED THE PAGE TO DO.
//
// THE MMM TWIN OF lib/analystActions.ts. The Analyst runs on the server and
// cannot touch the page, so a turn that changes the hub comes back as a list
// of DESCRIBED ACTIONS beside the answer. This is the one place that turns
// them into state.
//
// ONE PLACE, ON PURPOSE. Every change goes through `useMmmHubLayout.change`,
// which snapshots the charts, the cards, the granularity AND the scope first —
// so "revert that" means the same thing whichever of them the last turn
// touched, and so there is a single answer to "what did the bot just do to my
// hub".
//
// THE SERVER HAS ALREADY CHECKED THE SHAPE (app/agents/mmm_scope.py,
// mmm_layout.py): a year that exists, a dimension the data has, an id that is
// a real panel. What is re-checked here is only what a browser can know
// better — that an id is one THIS BUILD of the page actually has — because a
// server talking to a stale frontend is the one way an action can name
// something that is not there. An unknown id is dropped and reported, never
// applied blind.

/** One change to the MMM hub, as the Analyst describes it. Mirrors the dicts
 *  in app/agents/mmm_scope.py and app/agents/mmm_layout.py. */
export type MmmAnalystAction =
  | {
      kind: 'period'
      year: number | null
      quarter: number | null
      month: number | null
      date_from: string | null
      date_to: string | null
      summary: string
    }
  | {
      kind: 'filter'
      dimension: string | null
      values: string[]
      clear_all: boolean
      summary: string
    }
  | { kind: 'granularity'; granularity: MmmGranularity; summary: string }
  | {
      kind: 'layout'
      reset: boolean
      clear_pinned?: boolean
      show_charts: string[]
      hide_charts: string[]
      show_cards: string[]
      hide_cards: string[]
      summary: string
    }
  | {
      kind: 'pin_chart'
      chart_type: 'bar' | 'column' | 'donut' | 'line'
      by: string
      metric: string
      title: string
      summary: string
    }
  | {
      kind: 'update_chart'
      id: string
      patch: Partial<{
        chart_type: 'bar' | 'column' | 'donut' | 'line'
        by: string
        metric: string
        title: string
      }>
      summary: string
    }
  | { kind: 'undo'; summary: string }

/** Which view-store list each filter dimension writes. The server speaks the
 *  wire names (`promotion_types`); the store holds the page's own
 *  (`promotionTypes`). */
const FILTER_KEYS: Record<string, MmmListKey> = {
  channels: 'channels',
  promotion_types: 'promotionTypes',
  events: 'events',
}

export function applyMmmAnalystActions(
  actions: MmmAnalystAction[] | undefined,
): AppliedActions {
  const applied: string[] = []
  const skipped: string[] = []
  let undoable = false
  let answerOverride: string | undefined

  for (const action of actions ?? []) {
    switch (action.kind) {
      case 'period': {
        useMmmHubLayout.getState().change(action.summary, () => {
          const view = useMmmView.getState()
          // THE WHOLE PERIOD AT ONCE. A date range REPLACES year/quarter/month
          // in the backend's scope (app/mmm/scope.py), so leaving a year set
          // beside a range would put the page in a state the server reads as
          // neither. Every period field is written, including the ones this
          // action leaves null.
          view.set('year', action.year)
          view.set('quarter', action.quarter)
          view.set('month', action.month)
          view.set('week', null)
          view.set('dateFrom', action.date_from)
          view.set('dateTo', action.date_to)
          // THE CHANNEL, PROMOTION-TYPE AND EVENT FILTERS ARE LEFT ALONE
          // deliberately: changing the period changes the period. Clearing
          // them here would widen the page in a way nobody asked for, and the
          // KPIs would move for two reasons at once.
        })
        applied.push(action.summary)
        undoable = true
        break
      }

      case 'filter': {
        if (action.clear_all) {
          useMmmHubLayout.getState().change(action.summary, () => {
            const view = useMmmView.getState()
            for (const key of Object.values(FILTER_KEYS)) view.set(key, [])
          })
          applied.push(action.summary)
          undoable = true
          break
        }
        const key = action.dimension ? FILTER_KEYS[action.dimension] : undefined
        if (!key) {
          skipped.push(`this hub has no ${action.dimension ?? 'such'} filter`)
          break
        }
        useMmmHubLayout.getState().change(action.summary, () => {
          useMmmView.getState().set(key, action.values)
        })
        applied.push(action.summary)
        undoable = true
        break
      }

      case 'granularity': {
        if (action.granularity !== 'week' && action.granularity !== 'month') {
          skipped.push(`the trend cannot be drawn ${String(action.granularity)}ly`)
          break
        }
        const layout = useMmmHubLayout.getState()
        layout.change(action.summary, () => layout.setGranularity(action.granularity))
        applied.push(action.summary)
        undoable = true
        break
      }

      case 'layout': {
        const unknownCharts = [...action.show_charts, ...action.hide_charts].filter(
          (id) => !(MMM_PANEL_IDS as readonly string[]).includes(id),
        )
        const unknownCards = [...action.show_cards, ...action.hide_cards].filter(
          (key) => !(MMM_ADDABLE_KPIS as readonly string[]).includes(key),
        )
        if (unknownCharts.length || unknownCards.length) {
          skipped.push(`${[...unknownCharts, ...unknownCards].join(', ')} is not on this hub`)
          break
        }
        if (action.reset) {
          useMmmHubLayout.getState().resetLayout()
          applied.push(action.summary)
          undoable = true
          break
        }
        if (action.clear_pinned) {
          const layout = useMmmHubLayout.getState()
          layout.change(action.summary, () => layout.clearPinned())
          applied.push(action.summary)
          undoable = true
          break
        }
        const layout = useMmmHubLayout.getState()
        layout.change(action.summary, () => {
          const charts = (layout.charts as readonly string[])
            .filter((id) => !action.hide_charts.includes(id))
            .concat(action.show_charts.filter((id) => !(layout.charts as readonly string[]).includes(id)))
          const cards = layout.cards
            .filter((key) => !action.hide_cards.includes(key))
            .concat(action.show_cards.filter((key) => !layout.cards.includes(key)))
          layout.setCharts(charts)
          layout.setCards(cards)
        })
        applied.push(action.summary)
        undoable = true
        break
      }

      case 'pin_chart': {
        const layout = useMmmHubLayout.getState()
        layout.change(action.summary, () =>
          layout.pinChart({
            chart_type: action.chart_type,
            by: action.by,
            metric: action.metric,
            title: action.title,
          }),
        )
        applied.push(action.summary)
        undoable = true
        break
      }

      case 'update_chart': {
        const layout = useMmmHubLayout.getState()
        if (!layout.pinned.some((p) => p.id === action.id)) {
          // The page moved on between the question and the answer — the chart
          // was removed while the turn was in flight. Saying so is better than
          // silently doing nothing to a chart that is no longer there.
          skipped.push('that chart is no longer on the hub')
          break
        }
        layout.change(action.summary, () => layout.updateChart(action.id, action.patch))
        applied.push(action.summary)
        undoable = true
        break
      }

      case 'undo': {
        const result = useMmmHubLayout.getState().undo()
        if (result.ok) {
          applied.push(`put back: ${result.label}`)
          answerOverride = `Put that back — ${result.label}.`
        } else {
          skipped.push('there is no change of mine left to undo')
          answerOverride =
            "There's nothing left for me to undo — I haven't changed anything on this hub yet."
        }
        break
      }
    }
  }

  return {
    applied,
    skipped,
    undoable: undoable || useMmmHubLayout.getState().history.length > 0,
    // Only when this side knows better than the server did, and only when the
    // undo was the whole turn: a sentence that also answered a question must
    // not be thrown away.
    answerOverride: (actions ?? []).length === 1 ? answerOverride : undefined,
  }
}
