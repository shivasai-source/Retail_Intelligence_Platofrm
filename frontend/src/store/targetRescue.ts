import { create } from 'zustand'
import type { CheckpointValue } from '../types/targetRescue'

/** Target Rescue's own controls — the third Simulation Studio mode.
 *
 *  DELIBERATELY ITS OWN STORE, sharing state with nothing. The Investigation
 *  Simulation scopes itself from the Insights Hub's validated FilterState (or
 *  from the RCA hand-off that narrowed it) and General Optimization holds its
 *  own three dimensions; Target Rescue must not be able to move either, and
 *  neither may move this. A month or channel shared between two modes would
 *  mean changing a control in one silently re-scoped the other — the exact state
 *  leakage the brief forbids.
 *
 *  So this store holds five controls of its own. They are the SAME dimensions
 *  `FilterState` defines and carry the same real codes; what is not shared is
 *  the SELECTION.
 *
 *  NOT PERSISTED. A target is a commitment for one sitting's analysis, not a
 *  saved plan, and a target restored from last week against this week's data
 *  would be a number nobody chose. The mode itself resets to Investigation
 *  Simulation on a fresh load for the same reason.
 */
export interface RescueControls {
  /** Real calendar month 1–12. Required — a monthly target is a statement about
   *  one month, and a rescue across twelve of them has no days to count. */
  month: number
  /** Real calendar year, or null to let the server resolve the latest one. */
  year: number | null
  /** Channel_Id, or null for every channel. */
  channel: string | null
  /** dim_product Category value, or null for every category.
   *
   *  BELOW channel in the hierarchy: changing the channel clears it, because a
   *  category that does not trade in the new channel is not a narrower scope, it
   *  is an empty one. */
  category: string | null
  /** Product_id, or null for every product.
   *
   *  BELOW category. Cleared whenever anything above it moves -- the brief is
   *  explicit that an invalid product must never stay selected. */
  product: string | null
  /** The monthly unit target. Null until the user enters one — there is no
   *  honest default for a business commitment, so the evaluation waits. */
  targetUnits: number | null
  /** The treatment currently running, as a percentage. Stepped in fives, so it
   *  can only ever land on an approved treatment depth. */
  currentDiscountPct: number
  /** The progress checkpoint: a COMPLETED BUSINESS WEEK ordinal, `'latest'`, or
   *  `'auto'`.
   *
   *  A WEEK, NEVER A DAY. Progress in this dataset is knowable at complete-week
   *  boundaries and nowhere finer, so there is no day for this control to carry.
   *
   *  DEFAULTS TO `'auto'`, which is CADENCE-AWARE and resolved on the server: the
   *  latest completed week for a weekly-cadence channel, the mid-month week for a
   *  monthly one. Holding `'auto'` rather than a resolved ordinal is what lets the
   *  default follow the channel when the channel changes. */
  checkpoint: CheckpointValue
  /** Optional hard cap on ADDITIONAL trade spend. Null means no cap; the control
   *  is only offered when the server measured a ceiling to bound it. */
  maxAdditionalTradeSpend: number | null
}

interface State {
  controls: RescueControls
  setControl: <K extends keyof RescueControls>(key: K, value: RescueControls[K]) => void
}

const DEFAULT_CONTROLS: RescueControls = {
  // October has four whole business weeks in both reference years, so a day-20
  // checkpoint resolves cleanly — a sensible month to open on. Nothing depends
  // on it: every control is the user's to move.
  month: 10,
  year: null,
  channel: null,
  category: null,
  product: null,
  targetUnits: null,
  currentDiscountPct: 10,
  checkpoint: 'auto',
  maxAdditionalTradeSpend: null,
}

export const useTargetRescueStore = create<State>()((set) => ({
  controls: DEFAULT_CONTROLS,
  setControl: (key, value) =>
    set((s) => {
      const controls = { ...s.controls, [key]: value }
      // A checkpoint and a spend cap belong to the scope they were measured
      // for. Moving the scope resets both rather than carrying week 5 into a
      // four-week month, or one channel's cadence default into another's.
      if (key === 'month' || key === 'year' || key === 'channel' || key === 'category') {
        controls.checkpoint = 'auto'
        controls.maxAdditionalTradeSpend = null
      }
      // THE CASCADE, RESET DOWNWARD. Channel is above category, which is above
      // product, so moving a level clears everything below it. Reconciling
      // against the new option lists instead would leave an invalid value
      // selected for the round-trip it takes them to arrive, and the brief is
      // explicit: never leave an invalid product selected.
      //
      // The TARGET is deliberately NOT reset. It is the user's commitment for the
      // scope they are looking at, and silently rewriting it when they narrow the
      // scope would discard a number they typed.
      if (key === 'channel' || key === 'month' || key === 'year') {
        controls.category = null
        controls.product = null
      }
      if (key === 'category') {
        controls.product = null
      }
      return { controls }
    }),
}))
