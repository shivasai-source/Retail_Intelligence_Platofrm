import { create } from 'zustand'
import { createJSONStorage, persist } from 'zustand/middleware'
import { useStudioFilters } from './studioFilters'

/** Promotion Intelligence → Simulation Studio: the product under investigation.
 *
 *  "Go to Simulation" carries the investigation's product (and the scope
 *  dimensions the studio filters on, when the scope names them) into the
 *  studio's own filter store, and remembers that it did so the studio can
 *  show where its selection came from and offer the way back. Clearing the
 *  product — from the banner or from the Product dropdown — returns the
 *  studio to its ordinary, everything-selectable state.
 *
 *  Per-tab state (sessionStorage), so a reload keeps it; nothing is sent to
 *  the server. */
export interface StudioHandoff {
  productId: string
  /** The promotion the investigation is about, when it names one. It travels
   *  as the studio's Offer filter — not shown on the studio's bar, so the
   *  banner names it. */
  promotionId: string | null
  year: number | null
  /** The investigation's question, shown so the reader knows why this product. */
  question: string
  at: number
}

interface StudioHandoffStore {
  handoff: StudioHandoff | null
  carry: (handoff: StudioHandoff) => void
  clear: () => void
}

export const useStudioHandoff = create<StudioHandoffStore>()(
  persist(
    (set) => ({
      handoff: null,
      carry: (handoff) => set({ handoff }),
      clear: () => set({ handoff: null }),
    }),
    { name: 'tiq.studioHandoff', storage: createJSONStorage(() => sessionStorage) },
  ),
)

/** The dimensions carried: everything the investigation's scope names that
 *  the studio can filter on, INCLUDING the year and the offer. The year
 *  because the investigation is about one year's trading and the studio
 *  would otherwise open on its default (the latest year in the data) and
 *  measure a different population; the offer because the investigation's
 *  figures are that promotion's, and the studio's "measured" line must show
 *  the same ones. Month and promotion type are not carried: the studio's
 *  window has no month, and the offer already pins the promotion. */
const CARRIED: ListKey[] = ['channel', 'category', 'brand', 'product', 'promotion', 'retailer', 'region', 'state', 'city', 'tier', 'distributor']
type ListKey = 'channel' | 'category' | 'brand' | 'product' | 'promotion' | 'retailer' | 'region' | 'state' | 'city' | 'tier' | 'distributor'

/** Apply an investigation scope to the studio's filters and record the
 *  hand-off. Returns false when the scope names no single product — there
 *  is then nothing to carry, and the caller navigates to the studio as is. */
export function carryProductToStudio(scope: Record<string, unknown>, question: string): boolean {
  const list = (v: unknown) => (Array.isArray(v) ? v : v == null || v === '' ? [] : [v]).map(String)
  const products = list(scope.product)
  if (products.length !== 1) return false

  const carried: Record<string, unknown> = {}
  for (const key of CARRIED) {
    const values = list(scope[key])
    if (values.length) carried[key] = values
  }
  const year = Number(scope.year)
  if (scope.year != null && Number.isFinite(year)) carried.year = year
  useStudioFilters.getState().applyScope(carried)
  useStudioHandoff.getState().carry({
    productId: products[0],
    promotionId: list(scope.promotion)[0] ?? null,
    year: carried.year == null ? null : (carried.year as number),
    question,
    at: Date.now(),
  })
  return true
}
