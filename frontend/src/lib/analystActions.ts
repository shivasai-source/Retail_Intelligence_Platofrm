import { LIST_FILTER_KEYS, useCommandFilters, type ListFilterKey } from '../store/commandFilters'
import { useHubLayout } from '../store/hubLayout'
import { HUB_PANEL_IDS } from '../components/command/hubPanels'
import { ADDABLE_KPI_ORDER } from '../components/command/kpiDeckState'

// APPLYING WHAT THE ANALYST ASKED THE PAGE TO DO.
//
// The Analyst runs on the server and cannot touch the page, so a turn that
// changes the dashboard comes back as a list of DESCRIBED ACTIONS beside the
// answer — the same shape a chart spec already arrives in. This is the one
// place that turns them into state.
//
// ONE PLACE, ON PURPOSE. Every change goes through `useHubLayout.change`,
// which snapshots the charts, the cards AND the filters first — so "revert
// that" means the same thing whichever of the three the last turn touched, and
// so there is a single answer to "what did the bot just do to my dashboard".
//
// THE SERVER HAS ALREADY CHECKED THE SHAPE (app/agents/hub_scope.py,
// hub_layout.py): a year that exists, a dimension the bar has, an id that is a
// real panel. What is re-checked here is only what a browser can know better —
// that an id is one this build of the page actually has — because a server
// talking to a stale frontend is the one way an action can name something that
// is not there. An unknown id is dropped and reported, never applied blind.

/** One change to the page, as the Analyst describes it. Mirrors the dicts in
 *  app/agents/hub_scope.py and app/agents/hub_layout.py. */
export type AnalystAction =
  | {
      kind: 'period'
      year: number | null
      month: number | null
      period_from: number | null
      period_to: number | null
      summary: string
    }
  | {
      kind: 'filter'
      dimension: string | null
      values: string[]
      clear_all: boolean
      summary: string
    }
  | {
      kind: 'layout'
      reset: boolean
      show_charts: string[]
      hide_charts: string[]
      show_cards: string[]
      hide_cards: string[]
      summary: string
    }
  | { kind: 'undo'; summary: string }

export interface AppliedActions {
  /** What was actually done, for the chip under the answer. */
  applied: string[]
  /** What could not be done, in the reader's words. */
  skipped: string[]
  /** True when at least one change can be undone. */
  undoable: boolean
  /** THE SENTENCE THE READER SEES, when only this side knows the truth.
   *
   *  An undo is the case: the stack lives here, so whether anything was put
   *  back — and what — is not something the server could have said. It sends
   *  a placeholder and this replaces it, so the bubble cannot claim a revert
   *  that did not happen. */
  answerOverride?: string
}

export function applyAnalystActions(actions: AnalystAction[] | undefined): AppliedActions {
  const applied: string[] = []
  const skipped: string[] = []
  let undoable = false
  let answerOverride: string | undefined

  for (const action of actions ?? []) {
    switch (action.kind) {
      case 'period': {
        useHubLayout.getState().change(action.summary, () => {
          // THE WHOLE PERIOD AT ONCE, through applyScope: setting `year` and
          // `period_from` in two calls would leave the page briefly scoped to
          // a year AND a custom range, which the backend reads as neither.
          //
          // AND THE REST OF THE SELECTION IS CARRIED OVER DELIBERATELY.
          // `applyScope` replaces rather than merges ({...EMPTY_FILTERS,
          // ...scope}), so passing the four period fields alone would silently
          // clear every channel, region and brand the reader had chosen —
          // "show me 2024" would widen the page in a way nobody asked for and
          // the KPIs would move for two reasons at once. Changing the period
          // changes the period.
          const { filters } = useCommandFilters.getState()
          useCommandFilters.getState().applyScope({
            ...filters,
            year: action.year,
            month: action.month,
            period_from: action.period_from,
            period_to: action.period_to,
          })
        })
        applied.push(action.summary)
        undoable = true
        break
      }

      case 'filter': {
        if (action.clear_all) {
          useHubLayout.getState().change(action.summary, () => {
            // `reset` clears the filters AND the period; a reader asking to
            // clear the filters has not asked to leave the period they chose.
            const { filters } = useCommandFilters.getState()
            const cleared = Object.fromEntries(LIST_FILTER_KEYS.map((k) => [k, []]))
            useCommandFilters.getState().applyScope({
              year: filters.year,
              month: filters.month,
              period_from: filters.period_from,
              period_to: filters.period_to,
              ...cleared,
            })
          })
          applied.push(action.summary)
          undoable = true
          break
        }
        const key = action.dimension as ListFilterKey | null
        if (!key || !LIST_FILTER_KEYS.includes(key)) {
          skipped.push(`this dashboard has no ${action.dimension ?? 'such'} filter`)
          break
        }
        useHubLayout.getState().change(action.summary, () => {
          useCommandFilters.getState().set(key, action.values)
        })
        applied.push(action.summary)
        undoable = true
        break
      }

      case 'layout': {
        const unknownCharts = [...action.show_charts, ...action.hide_charts].filter(
          (id) => !HUB_PANEL_IDS.includes(id),
        )
        const unknownCards = [...action.show_cards, ...action.hide_cards].filter(
          (key) => !(ADDABLE_KPI_ORDER as readonly string[]).includes(key),
        )
        if (unknownCharts.length || unknownCards.length) {
          skipped.push(
            `${[...unknownCharts, ...unknownCards].join(', ')} is not on this dashboard`,
          )
          break
        }
        if (action.reset) {
          useHubLayout.getState().resetLayout()
          applied.push(action.summary)
          undoable = true
          break
        }
        const layout = useHubLayout.getState()
        layout.change(action.summary, () => {
          const charts = layout.charts
            .filter((id) => !action.hide_charts.includes(id))
            .concat(action.show_charts.filter((id) => !layout.charts.includes(id)))
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

      case 'undo': {
        const result = useHubLayout.getState().undo()
        if (result.ok) {
          applied.push(`put back: ${result.label}`)
          answerOverride = `Put that back — ${result.label}.`
        } else {
          skipped.push('there is no change of mine left to undo')
          answerOverride =
            "There's nothing left for me to undo — I haven't changed anything on this dashboard yet."
        }
        break
      }
    }
  }

  return {
    applied,
    skipped,
    undoable: undoable || useHubLayout.getState().history.length > 0,
    // Only when this side knows better than the server did, and only when the
    // undo was the whole turn: a sentence that also answered a question must
    // not be thrown away.
    answerOverride: (actions ?? []).length === 1 ? answerOverride : undefined,
  }
}
