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

/** A chart the Analyst was asked to keep ON THE PAGE.
 *
 *  THE SHAPE IS STORED, NOT THE NUMBERS. The card runs the Hub's own breakdown
 *  query from the Hub's own filters, so a pinned chart moves with the period
 *  and the filters exactly as the nine built-in panels do. Storing the figures
 *  the Analyst computed would leave a chart that quietly disagreed with every
 *  card around it the moment the reader changed the period. */
export interface PinnedChart {
  id: string
  chart_type: 'bar' | 'column' | 'donut' | 'line'
  by: string
  metric: string
  title: string
}

/** Everything one change can touch, as it was before that change. */
interface Snapshot {
  charts: string[]
  cards: string[]
  pinned: PinnedChart[]
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
  /** Charts the Analyst added, in the order they were asked for. */
  pinned: PinnedChart[]
  history: Snapshot[]
  /** Replace the chart list — the reader's own Charts menu. */
  setCharts: (ids: string[]) => void
  /** Replace the added-card list — the reader's own Add KPI menu. */
  setCards: (keys: string[]) => void
  /** Add one Analyst chart to the page. */
  pinChart: (chart: Omit<PinnedChart, 'id'>) => void
  /** Change one in place — its type, metric, grouping or title. */
  updateChart: (id: string, patch: Partial<Omit<PinnedChart, 'id'>>) => void
  /** Remove one by id, or all of them. */
  unpinChart: (id: string) => void
  clearPinned: () => void
  /** What the Analyst needs to know about the page to act on it. */
  dashboardState: () => {
    pinned: PinnedChart[]
    hidden_charts: string[]
    cards: string[]
  }
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

/** How many Analyst charts the page will hold at once. */
const MAX_PINNED = 4
const PINNED_KEY = 'insights-hub.charts.pinned'

/** The same guarded per-browser memory the other two lists use: storage can
 *  be absent, disabled or throw, and the answer is then "none pinned". */
function readPinned(): PinnedChart[] {
  try {
    const raw = window.localStorage.getItem(PINNED_KEY)
    if (!raw) return []
    const parsed: unknown = JSON.parse(raw)
    if (!Array.isArray(parsed)) return []
    return parsed.filter(
      (p): p is PinnedChart =>
        !!p && typeof p === 'object' && typeof (p as PinnedChart).id === 'string'
        && typeof (p as PinnedChart).by === 'string',
    ).slice(0, MAX_PINNED)
  } catch {
    return []
  }
}

function writePinned(charts: PinnedChart[]) {
  try {
    window.localStorage.setItem(PINNED_KEY, JSON.stringify(charts))
  } catch {
    /* A remembered preference is a convenience, not a requirement. */
  }
}
const cardsInPageOrder = (keys: string[]) =>
  (ADDABLE_KPI_ORDER as readonly string[]).filter((k) => keys.includes(k))

export const useHubLayout = create<HubLayoutStore>((set, get) => ({
  charts: readVisiblePanels(),
  cards: readAddedKpis(),
  pinned: readPinned(),
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

  pinChart: (chart) => {
    const { pinned } = get()
    // Bounded: the dashboard already carries nine panels, and a chat that can
    // append to it without limit turns the page into a scroll of charts
    // nobody chose to keep. The oldest goes when the tenth arrives.
    const next = [...pinned, { ...chart, id: `pinned:${Date.now()}` }].slice(-MAX_PINNED)
    writePinned(next)
    set({ pinned: next })
  },

  updateChart: (id, patch) => {
    const next = get().pinned.map((p) => (p.id === id ? { ...p, ...patch } : p))
    writePinned(next)
    set({ pinned: next })
  },

  dashboardState: () => {
    const { pinned, charts, cards } = get()
    return {
      pinned,
      // What is OFF, not what is on: the model needs to know what it can put
      // back, and nine ids it cannot act on is noise in every prompt.
      hidden_charts: HUB_PANEL_IDS.filter((id) => !charts.includes(id)),
      cards,
    }
  },

  unpinChart: (id) => {
    const next = get().pinned.filter((p) => p.id !== id)
    writePinned(next)
    set({ pinned: next })
  },

  clearPinned: () => {
    writePinned([])
    set({ pinned: [] })
  },

  change: (label, apply) => {
    const { charts, cards, pinned } = get()
    const snapshot: Snapshot = {
      charts: [...charts],
      cards: [...cards],
      pinned: [...pinned],
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
    writePinned(last.pinned)
    // The period and filters come back too — see the note at the top. The
    // store's own applyScope is used rather than writing `filters` directly,
    // so the reconciliation that keeps contradictory selections honest still
    // runs on the way back.
    useCommandFilters.getState().applyScope(last.filters)
    set({
      charts: last.charts,
      cards: last.cards,
      pinned: last.pinned,
      history: history.slice(0, -1),
    })
    return { ok: true, label: last.label }
  },

  resetLayout: () =>
    get().change('put the Insights Hub back to its default charts and cards', () => {
      writeVisiblePanels([...DEFAULT_PANELS])
      writeAddedKpis([])
      writePinned([])
      set({ charts: [...DEFAULT_PANELS], cards: [], pinned: [] })
    }),

  lastChange: () => get().history[get().history.length - 1]?.label ?? null,
}))
