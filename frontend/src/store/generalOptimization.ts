import { create } from 'zustand'

/** The Simulation Studio's two modes, and General Optimization's own controls.
 *
 *  DELIBERATELY SEPARATE FROM `commandFilters`. The Investigation Simulation
 *  scopes itself from the Insights Hub's validated FilterState (or from the
 *  RCA hand-off that narrowed it), and General Optimization must not be able to
 *  move that. A shared month or channel would mean changing a control in one
 *  mode silently re-scoped the other — which is the exact state leakage the
 *  brief forbids.
 *
 *  So this store holds three dimensions of its own. They are the SAME
 *  dimensions `FilterState` defines and carry the same real codes; what is not
 *  shared is the SELECTION.
 *
 *  NOT PERSISTED. These are working constraints for one sitting, not a saved
 *  plan, and a ceiling restored from last week against this week's data would
 *  be a number nobody chose. The mode resets to Investigation Simulation on a
 *  fresh load for the same reason.
 */
/** ADDITIVE: `rescue` joins the union for the Simulation Studio's third mode.
 *  This type is the PAGE's mode enum rather than General Optimization's own
 *  state, which is why it lives here and why extending it changes nothing
 *  below — every selector, control and default in this store is untouched.
 *  Target Rescue keeps its controls in store/targetRescue.ts. */
export type SimulationMode = 'investigation' | 'general' | 'rescue'

export interface OptimizationControls {
  /** dim_product Category values, or null for every category. */
  category: string | null
  /** Channel_Id, or null for every channel. */
  channel: string | null
  /** Real calendar month 1–12, or null for every month. */
  month: number | null
  /** The ceiling, in base currency. Null until the historical average that
   *  bounds it has been measured — there is no honest default before that. */
  maxTradeSpend: number | null
  minDiscountPct: number
  maxDiscountPct: number
}

interface State {
  mode: SimulationMode
  controls: OptimizationControls
  setMode: (mode: SimulationMode) => void
  setControl: <K extends keyof OptimizationControls>(key: K, value: OptimizationControls[K]) => void
  /** Applied when a new scope's historical average arrives. The ceiling cannot
   *  outlive the scope it was measured for, so changing category, channel or
   *  month clears it and it is re-seeded from the new measurement. */
  seedCeiling: (average: number | null) => void
}

const DEFAULT_CONTROLS: OptimizationControls = {
  category: null,
  channel: null,
  month: null,
  maxTradeSpend: null,
  // The full approved window. 0 does not mean "no discount is allowed" — it
  // means the optimizer may leave a product unpromoted, which it always may.
  minDiscountPct: 0,
  maxDiscountPct: 25,
}

export const useGeneralOptimizationStore = create<State>()((set) => ({
  mode: 'investigation',
  controls: DEFAULT_CONTROLS,
  setMode: (mode) => set({ mode }),
  setControl: (key, value) =>
    set((s) => {
      const controls = { ...s.controls, [key]: value }
      // A ceiling belongs to the scope it was measured for. Moving the scope
      // invalidates it rather than carrying a stale number across.
      if (key === 'category' || key === 'channel' || key === 'month') {
        controls.maxTradeSpend = null
      }
      // The window cannot invert. Whichever handle moved wins, and the other
      // follows it — the alternative is a control that silently refuses input.
      if (key === 'minDiscountPct' && controls.minDiscountPct > controls.maxDiscountPct) {
        controls.maxDiscountPct = controls.minDiscountPct
      }
      if (key === 'maxDiscountPct' && controls.maxDiscountPct < controls.minDiscountPct) {
        controls.minDiscountPct = controls.maxDiscountPct
      }
      return { controls }
    }),
  seedCeiling: (average) =>
    set((s) => ({
      controls: {
        ...s.controls,
        // Start at the full measured average — the ceiling the data supports —
        // and let the user pull it down. Never above it.
        maxTradeSpend: average == null ? null : average,
      },
    })),
}))
