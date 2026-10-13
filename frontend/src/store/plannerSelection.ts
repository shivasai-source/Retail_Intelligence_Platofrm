import { create } from 'zustand'
import { createJSONStorage, persist } from 'zustand/middleware'
import type { CountRule, PlannerSelection, ProfitBasis, TimingRule } from '../types/planner'

/** The Simulation Studio's selection and controls.
 *
 *  Products, stores, channels and regions (each multi-select, empty meaning
 *  all) inside one period of business weeks. `promotion` + `month` are the
 *  Promotion Calendar's hand-off: one offer's own slots in one channel-month.
 *
 *  Per-tab state (sessionStorage): a reload keeps the working selection;
 *  nothing is sent to the server. */

export type PlannerDimension = 'products' | 'stores' | 'channels' | 'regions'
export type PlannerTab = 'whatif' | 'target' | 'best'
export type Currency = 'INR' | 'USD'

/** Where a selection came from, for the banner. */
export interface PlannerOrigin {
  source: 'calendar' | 'intelligence'
  title: string
  facts: string[]
}

export const EMPTY_SELECTION: PlannerSelection = {
  products: [],
  stores: [],
  channels: [],
  regions: [],
  start: null,
  end: null,
  promotion: null,
  month: null,
}

interface PlannerState {
  selection: PlannerSelection
  origin: PlannerOrigin | null
  tab: PlannerTab
  timing: TimingRule
  count: CountRule
  targetPct: number
  basis: ProfitBasis
  currency: Currency
  /** The what-if lever, per selection signature, so a scope change re-seeds it. */
  discount: { key: string; value: number } | null
  toggle: (dim: PlannerDimension, code: string) => void
  setList: (dim: PlannerDimension, codes: string[]) => void
  setPeriod: (start: [number, number], end: [number, number]) => void
  clearFocus: () => void
  reset: () => void
  setTab: (tab: PlannerTab) => void
  setTiming: (timing: TimingRule) => void
  setCount: (count: CountRule) => void
  setTargetPct: (pct: number) => void
  setCurrency: (currency: Currency) => void
  setDiscount: (key: string, value: number) => void
  carry: (selection: PlannerSelection, origin: PlannerOrigin) => void
}

/** The controls' starting values -- what Reset returns to. */
export const DEFAULTS = {
  origin: null,
  tab: 'whatif' as PlannerTab,
  timing: 'free' as TimingRule,
  count: 'keep' as CountRule,
  targetPct: 1,
  basis: 'cost' as ProfitBasis,
  discount: null,
}

export const usePlannerSelection = create<PlannerState>()(
  persist(
    (set) => ({
      ...DEFAULTS,
      selection: EMPTY_SELECTION,
      currency: 'INR',
      toggle: (dim, code) =>
        set((s) => {
          const list = s.selection[dim]
          const next = list.includes(code) ? list.filter((c) => c !== code) : [...list, code]
          return { selection: { ...s.selection, [dim]: next } }
        }),
      setList: (dim, codes) => set((s) => ({ selection: { ...s.selection, [dim]: codes } })),
      // A period chosen by hand replaces a calendar month.
      setPeriod: (start, end) => set((s) => ({ selection: { ...s.selection, start, end, month: null } })),
      clearFocus: () => set({ selection: EMPTY_SELECTION, origin: null, discount: null }),
      // Everything back to how the page opens: filters, period, the lever, the
      // target, both rules and the first tab. Currency is a display setting
      // and stays.
      reset: () => set({ ...DEFAULTS, selection: EMPTY_SELECTION }),
      setTab: (tab) => set({ tab }),
      setTiming: (timing) => set({ timing }),
      setCount: (count) => set({ count }),
      setTargetPct: (targetPct) => set({ targetPct }),
      setCurrency: (currency) => set({ currency }),
      setDiscount: (key, value) => set({ discount: { key, value } }),
      carry: (selection, origin) => set({ selection, origin, tab: 'whatif', discount: null }),
    }),
    {
      name: 'tiq.plannerSelection',
      storage: createJSONStorage(() => sessionStorage),
      // v2: the target became "+X points of profit % (SP − CP) ÷ CP"; an
      // older session's target and basis meant something else.
      version: 2,
      migrate: (state) => ({ ...(state as PlannerState), basis: DEFAULTS.basis, targetPct: DEFAULTS.targetPct }),
    },
  ),
)

/** Promotion Calendar → Simulation Studio: one promotion in one channel-month,
 *  its own product-stores only. The caller navigates. */
export function carryPromotionToPlanner(focus: {
  promotionId: string
  promotionName: string
  channelId: string
  channelName: string
  year: number
  month: number
  monthName: string
}) {
  usePlannerSelection.getState().carry(
    { ...EMPTY_SELECTION, channels: [focus.channelId], promotion: focus.promotionId, month: [focus.year, focus.month] },
    {
      source: 'calendar',
      title: focus.promotionName,
      facts: [focus.promotionId, focus.channelName, `${focus.monthName} ${focus.year}`],
    },
  )
}
