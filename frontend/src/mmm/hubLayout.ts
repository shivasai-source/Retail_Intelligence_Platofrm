import { create } from 'zustand'
import {
  MMM_DEFAULT_PANELS,
  MMM_PANEL_IDS,
  readVisibleMmmPanels,
  writeVisibleMmmPanels,
  type MmmPanelId,
} from './mmmPanels'
import { MMM_ADDABLE_KPIS, readAddedMmmKpis, writeAddedMmmKpis } from './kpiDeck'
import { useMmmView, type MmmFilters } from './store'

/** WHAT THE MMM INSIGHTS HUB IS SHOWING — which charts, which KPI cards, which
 *  charts the Analyst added, and how the trend is bucketed.
 *
 *  THE MMM TWIN OF store/hubLayout.ts, and it exists for the same reason: the
 *  Analyst can change all of it, and a drawer that portals to <body> cannot
 *  reach a page's local state. Threading a setter down to it would make the
 *  Analyst a prop of the hub.
 *
 *  UNDO IS WHY THIS HOLDS THE SCOPE TOO. "Revert that" has to put back
 *  whatever the last change changed, and the Analyst can change the PERIOD as
 *  readily as the charts — that lives in ./store.ts. So a snapshot is all of
 *  it, taken before each change this store applies, and undo restores all of
 *  it. One stack, one meaning of "back".
 *
 *  THE GRANULARITY IS HERE AND NOT IN THE PAGE because the Analyst can set it
 *  ("show me that weekly"), which is the same argument as the lists above. It
 *  is NOT remembered between visits: it is a way of looking at the period on
 *  screen, and the period itself is not remembered either.
 *
 *  THE STACK IS RUNTIME ONLY. A remembered undo would offer to revert
 *  something from a session the reader does not remember having.
 */

/** A chart the Analyst was asked to keep ON THE HUB.
 *
 *  THE SHAPE IS STORED, NOT THE NUMBERS. The card runs the hub's own query
 *  from the hub's own scope, so a pinned chart moves with the period exactly
 *  as the six built-in panels do. Storing the figures the Analyst computed
 *  would leave a chart that quietly disagreed with every card around it the
 *  moment the reader changed the period — and on this page it would also
 *  disagree with a baseline that is re-estimated for every range. */
export interface MmmPinnedChart {
  id: string
  chart_type: 'bar' | 'column' | 'donut' | 'line'
  by: string
  metric: string
  title: string
}

export type MmmGranularity = 'week' | 'month'

/** Everything one change can touch, as it was before that change. */
interface Snapshot {
  charts: MmmPanelId[]
  cards: string[]
  pinned: MmmPinnedChart[]
  granularity: MmmGranularity
  filters: MmmFilters
  /** What the change said it did, so Undo can name it. */
  label: string
}

/** How many changes back a reader can go. Enough for a conversation's worth of
 *  "no, the other one"; short enough not to hold a session's history. */
const MAX_HISTORY = 20

/** How many Analyst charts the hub will hold at once. */
const MAX_PINNED = 4
const PINNED_KEY = 'mmm-insights-hub.charts.pinned'

export interface MmmHubLayoutStore {
  charts: MmmPanelId[]
  cards: string[]
  pinned: MmmPinnedChart[]
  granularity: MmmGranularity
  history: Snapshot[]
  setCharts: (ids: string[]) => void
  setCards: (keys: string[]) => void
  setGranularity: (granularity: MmmGranularity) => void
  pinChart: (chart: Omit<MmmPinnedChart, 'id'>) => void
  updateChart: (id: string, patch: Partial<Omit<MmmPinnedChart, 'id'>>) => void
  unpinChart: (id: string) => void
  clearPinned: () => void
  /** What the Analyst needs to know about the page to act on it. */
  dashboardState: () => {
    pinned: MmmPinnedChart[]
    hidden_charts: string[]
    cards: string[]
    granularity: MmmGranularity
  }
  /** Apply a change and make it undoable. `label` is what Undo will name. */
  change: (label: string, apply: () => void) => void
  undo: () => { ok: boolean; label?: string }
  resetLayout: () => void
  lastChange: () => string | null
}

/** Chart ids in page order, whatever order they were asked for in — the same
 *  rule the KPI deck follows, for the same reason: the page has an order and a
 *  reader's clicks are not it. */
const inPageOrder = (ids: string[]) => MMM_PANEL_IDS.filter((id) => ids.includes(id))
const cardsInPageOrder = (keys: string[]) =>
  (MMM_ADDABLE_KPIS as readonly string[]).filter((k) => keys.includes(k))

/** The same guarded per-browser memory the other two lists use. */
function readPinned(): MmmPinnedChart[] {
  try {
    const raw = window.localStorage.getItem(PINNED_KEY)
    if (!raw) return []
    const parsed: unknown = JSON.parse(raw)
    if (!Array.isArray(parsed)) return []
    return parsed
      .filter(
        (p): p is MmmPinnedChart =>
          !!p &&
          typeof p === 'object' &&
          typeof (p as MmmPinnedChart).id === 'string' &&
          typeof (p as MmmPinnedChart).by === 'string',
      )
      .slice(0, MAX_PINNED)
  } catch {
    return []
  }
}

function writePinned(charts: MmmPinnedChart[]) {
  try {
    window.localStorage.setItem(PINNED_KEY, JSON.stringify(charts))
  } catch {
    /* A remembered preference is a convenience, not a requirement. */
  }
}

/** The scope fields a snapshot restores. `currency` and `expanded` are not
 *  scope: one is a display choice and the other is whether a panel is open,
 *  and an undo that closed the filter panel would be answering a question
 *  nobody asked. */
const scopeOf = (view: ReturnType<typeof useMmmView.getState>): MmmFilters => ({
  year: view.year,
  quarter: view.quarter,
  month: view.month,
  week: view.week,
  dateFrom: view.dateFrom,
  dateTo: view.dateTo,
  channels: [...view.channels],
  promotionTypes: [...view.promotionTypes],
  events: [...view.events],
})

export const useMmmHubLayout = create<MmmHubLayoutStore>((set, get) => ({
  charts: readVisibleMmmPanels(),
  cards: readAddedMmmKpis(),
  pinned: readPinned(),
  granularity: 'month',
  history: [],

  setCharts: (ids) => {
    const next = inPageOrder(ids)
    writeVisibleMmmPanels(next)
    set({ charts: next })
  },

  setCards: (keys) => {
    const next = cardsInPageOrder(keys)
    writeAddedMmmKpis(next)
    set({ cards: next })
  },

  setGranularity: (granularity) => set({ granularity }),

  pinChart: (chart) => {
    // Bounded: the hub already carries six panels, and a chat that can append
    // to it without limit turns the page into a scroll of charts nobody chose
    // to keep. The oldest goes when the fifth arrives.
    const next = [...get().pinned, { ...chart, id: `pinned:${Date.now()}` }].slice(-MAX_PINNED)
    writePinned(next)
    set({ pinned: next })
  },

  updateChart: (id, patch) => {
    const next = get().pinned.map((p) => (p.id === id ? { ...p, ...patch } : p))
    writePinned(next)
    set({ pinned: next })
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

  dashboardState: () => {
    const { pinned, charts, cards, granularity } = get()
    return {
      pinned,
      // What is OFF, not what is on: the model needs to know what it can put
      // back, and six ids it cannot act on is noise in every prompt.
      hidden_charts: MMM_PANEL_IDS.filter((id) => !charts.includes(id)),
      cards,
      granularity,
    }
  },

  change: (label, apply) => {
    const { charts, cards, pinned, granularity } = get()
    const snapshot: Snapshot = {
      charts: [...charts],
      cards: [...cards],
      pinned: [...pinned],
      granularity,
      filters: scopeOf(useMmmView.getState()),
      label,
    }
    apply()
    set((s) => ({ history: [...s.history, snapshot].slice(-MAX_HISTORY) }))
  },

  undo: () => {
    const { history } = get()
    const last = history[history.length - 1]
    if (!last) return { ok: false }
    writeVisibleMmmPanels(last.charts)
    writeAddedMmmKpis(last.cards)
    writePinned(last.pinned)
    // The scope comes back too — see the note at the top. Written through the
    // view store's own setter so nothing else in it is disturbed, and field by
    // field rather than through setYear, because `year: undefined` ("not
    // chosen yet, open on the latest completed year") and `year: null` ("All
    // years") are different states and setYear cannot express the first.
    const view = useMmmView.getState()
    for (const key of ['year', 'quarter', 'month', 'week', 'dateFrom', 'dateTo', 'channels',
                        'promotionTypes', 'events'] as const) {
      view.set(key, last.filters[key] as never)
    }
    set({
      charts: last.charts,
      cards: last.cards,
      pinned: last.pinned,
      granularity: last.granularity,
      history: history.slice(0, -1),
    })
    return { ok: true, label: last.label }
  },

  resetLayout: () =>
    get().change('put the MMM Insights Hub back to its default charts and cards', () => {
      writeVisibleMmmPanels([...MMM_DEFAULT_PANELS])
      writeAddedMmmKpis([])
      writePinned([])
      set({ charts: [...MMM_DEFAULT_PANELS], cards: [], pinned: [], granularity: 'month' })
    }),

  lastChange: () => get().history[get().history.length - 1]?.label ?? null,
}))
