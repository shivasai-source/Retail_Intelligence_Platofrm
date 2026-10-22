import { create } from 'zustand'
import {
  DEFAULT_PANELS,
  HUB_PANEL_IDS,
  readVisiblePanels,
  writeVisiblePanels,
} from '../components/command/hubPanels'
import { ADDABLE_KPI_ORDER, readAddedKpis, writeAddedKpis } from '../components/command/kpiDeckState'
import { useCommandFilters, type CommandFilters } from './commandFilters'

/** WHAT THE INSIGHTS HUB IS SHOWING — which charts, in what order, and which
 *  KPI cards the reader added beside the headline three.
 *
 *  WHY A STORE AND NOT PAGE STATE. Both lists used to be `useState` inside
 *  CommandCenter, which is the right place for them right up until something
 *  OTHER than the page needs to change them. The Analyst does now: "drop the
 *  region chart", "add the volume uplift card". A drawer that portals to
 *  <body> cannot reach a page's local state, and threading a setter down to it
 *  would make the Analyst a prop of the dashboard.
 *
 *  UNDO IS THE REASON THIS HOLDS FILTERS TOO. "Revert that" has to put back
 *  whatever the last change changed, and the Analyst can change the PERIOD as
 *  readily as the charts — those live in `commandFilters`. So a snapshot is
 *  all three, taken before each change this store applies, and undo restores
 *  all three. One stack, one meaning of "back".
 *
 *  THE STACK IS RUNTIME ONLY. A remembered undo would offer to revert
 *  something from a session the reader does not remember having. The lists
 *  themselves are remembered, in the same guarded per-browser way they were
 *  when they were page state. */

/** Everything one change can touch, as it was before that change. */
interface Snapshot {
  charts: string[]
  cards: string[]
  filters: CommandFilters
  /** What the change said it did, so Undo can name it. */
  label: string
}

/** How many changes back a reader can go. Enough for a conversation's worth
 *  of "no, the other one"; short enough not to hold a session's history. */
const MAX_HISTORY = 20

export interface HubLayoutStore {
  /** Visible charts, in page order. */
  charts: string[]
  /** KPI cards added beside the headline three, in page order. */
  cards: string[]
  history: Snapshot[]
  /** Replace the chart list — the reader's own Charts menu. */
  setCharts: (ids: string[]) => void
  /** Replace the added-card list — the reader's own Add KPI menu. */
  setCards: (keys: string[]) => void
  /** Apply a change and make it undoable. `label` is what Undo will name. */
  change: (label: string, apply: () => void) => void
  /** Put back the last change. False when there is nothing to put back. */
  undo: () => { ok: boolean; label?: string }
  /** The default charts and cards, undoably. */
  resetLayout: () => void
  /** What the last undoable change was called, for the Undo affordance. */
  lastChange: () => string | null
}

/** Chart ids in page order, whatever order they were asked for in — the same
 *  rule the KPI deck follows, for the same reason: the page has an order and a
 *  reader's clicks are not it. */
const inPageOrder = (ids: string[]) => HUB_PANEL_IDS.filter((id) => ids.includes(id))
const cardsInPageOrder = (keys: string[]) =>
  (ADDABLE_KPI_ORDER as readonly string[]).filter((k) => keys.includes(k))

export const useHubLayout = create<HubLayoutStore>((set, get) => ({
  charts: readVisiblePanels(),
  cards: readAddedKpis(),
  history: [],

  setCharts: (ids) => {
    const next = inPageOrder(ids)
    writeVisiblePanels(next)
    set({ charts: next })
  },

  setCards: (keys) => {
    const next = cardsInPageOrder(keys)
    writeAddedKpis(next)
    set({ cards: next })
  },

  change: (label, apply) => {
    const { charts, cards } = get()
    const snapshot: Snapshot = {
      charts: [...charts],
      cards: [...cards],
      filters: { ...useCommandFilters.getState().filters },
      label,
    }
    apply()
    set((s) => ({ history: [...s.history, snapshot].slice(-MAX_HISTORY) }))
  },

  undo: () => {
    const { history } = get()
    const last = history[history.length - 1]
    if (!last) return { ok: false }
    writeVisiblePanels(last.charts)
    writeAddedKpis(last.cards)
    // The period and filters come back too — see the note at the top. The
    // store's own applyScope is used rather than writing `filters` directly,
    // so the reconciliation that keeps contradictory selections honest still
    // runs on the way back.
    useCommandFilters.getState().applyScope(last.filters)
    set({ charts: last.charts, cards: last.cards, history: history.slice(0, -1) })
    return { ok: true, label: last.label }
  },

  resetLayout: () =>
    get().change('put the Insights Hub back to its default charts and cards', () => {
      writeVisiblePanels([...DEFAULT_PANELS])
      writeAddedKpis([])
      set({ charts: [...DEFAULT_PANELS], cards: [] })
    }),

  lastChange: () => get().history[get().history.length - 1]?.label ?? null,
}))
