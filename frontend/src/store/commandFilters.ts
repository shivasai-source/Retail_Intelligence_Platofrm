import { create, type StateCreator } from 'zustand'
import { createJSONStorage, persist } from 'zustand/middleware'
import type { Currency, FiltersResponse } from '../types/commandCenter'

/** ONE filter state for the whole Insights Hub.
 *
 *  Every panel — KPI cards, trend, risk alerts, promotion mix, both tables —
 *  reads this same object and sends it to the backend verbatim. There is no
 *  per-panel filter logic anywhere: if the cards are showing Modern Trade /
 *  D Mart, so is everything else, by construction.
 *
 *  PERIOD SEMANTICS. F24 and F25 are **calendar years 2024 and 2025**. They are
 *  display labels over `year`, nothing more. April–March fiscal-year semantics
 *  are deliberately NOT implemented, because the current `dim_date` carries no
 *  fiscal-year field (its `Quarter` is calendar: Q1 = Jan–Mar). Changing this
 *  would change which rows a period selects and would require re-baselining
 *  every KPI.
 *
 *  `currency` lives here too, but it is NOT part of the filter — it never
 *  reaches a KPI calculation. It is passed to the API only so the backend can
 *  format `display_value`; every `value` comes back in the base currency
 *  regardless. */
export interface CommandFilters {
  year: number | null
  month: number | null
  channel: string[]
  retailer: string[]
  region: string[]
  state: string[]
  city: string[]
  tier: string[]
  distributor: string[]
  category: string[]
  brand: string[]
  product: string[]
  promotion: string[]
  promotion_type: string[]
}

/** The filter keys whose value is a string list (everything except year/month). */
export type ListFilterKey = {
  [K in keyof CommandFilters]: CommandFilters[K] extends string[] ? K : never
}[keyof CommandFilters]

export const LIST_FILTER_KEYS: ListFilterKey[] = [
  'channel', 'retailer', 'region', 'state', 'city', 'tier', 'distributor',
  'category', 'brand', 'product', 'promotion', 'promotion_type',
]

/** Which filter dimensions accept more than one value at once. Within a
 *  dimension the backend ORs the values; across dimensions it ANDs them. */
export const MULTI_SELECT: ReadonlySet<ListFilterKey> = new Set<ListFilterKey>([
  'channel', 'retailer', 'category', 'brand',
])

export const EMPTY_FILTERS: CommandFilters = {
  year: null,
  month: null,
  channel: [],
  retailer: [],
  region: [],
  state: [],
  city: [],
  tier: [],
  distributor: [],
  category: [],
  brand: [],
  product: [],
  promotion: [],
  promotion_type: [],
}

/** Where each list-valued filter's options arrive in the /filters payload. */
const OPTION_KEY: Record<ListFilterKey, keyof FiltersResponse> = {
  channel: 'channels',
  retailer: 'retailers',
  region: 'regions',
  state: 'states',
  city: 'cities',
  tier: 'tiers',
  distributor: 'distributors',
  category: 'categories',
  brand: 'brands',
  product: 'products',
  promotion: 'offers',
  promotion_type: 'promotion_types',
}

function codesOf(options: FiltersResponse, key: ListFilterKey): string[] {
  const raw = options[OPTION_KEY[key]] as unknown
  if (!Array.isArray(raw)) return []
  return raw.map((entry) => (typeof entry === 'string' ? entry : String((entry as { code: string }).code)))
}

interface CommandFilterStore {
  filters: CommandFilters
  currency: Currency
  /** The ROI hurdle the reader set, or null for the backend's default. Not a
   *  filter — it selects no rows — but every "below target" on the page is
   *  judged against it, so it travels with every request the same way the
   *  currency does. Session-scoped: it is the reader's working assumption,
   *  not a saved setting. */
  targetRoi: number | null
  expanded: boolean
  /** The default period, adopted once the backend reports which years exist —
   *  never hardcoded to a year the data might not contain. */
  defaultYear: number | null
  initialised: boolean
  /** The dimension the user changed most recently.
   *
   *  Two contradictory selections invalidate EACH OTHER — with Channel =
   *  E-commerce and Region = Central both set, the channel list excludes
   *  E-commerce and the region list excludes Central. A reconciliation with no
   *  sense of recency would clear both, so touching one filter would silently
   *  wipe another. Protecting the just-touched dimension makes the outcome the
   *  intuitive one: the filter you clicked wins, the one it contradicts gives
   *  way. */
  lastTouched: keyof CommandFilters | null
  set: <K extends keyof CommandFilters>(key: K, value: CommandFilters[K]) => void
  toggle: (key: ListFilterKey, value: string) => void
  setCurrency: (currency: Currency) => void
  setTargetRoi: (target: number | null) => void
  toggleExpanded: () => void
  reset: () => void
  initialise: (year: number) => void
  /** Replace the selection wholesale — a scope carried in from another page.
   *  Marks the store initialised so the default-year seeding cannot then
   *  overwrite the carried year. */
  applyScope: (scope: Partial<CommandFilters>) => void
  reconcile: (options: FiltersResponse) => void
}

/** ONE STORE SHAPE, TWO INSTANCES. The Insights Hub's store is the one every
 *  Insights Hub panel reads; the Simulation Studio holds its own instance of
 *  the same shape (`store/studioFilters.ts`) so a scope chosen in the studio
 *  never re-scopes the Insights Hub, and vice versa. The behaviour — toggle,
 *  reconcile, reset — is written once here and shared. */
export function createFilterStore(persistKey?: string) {
  const initializer: StateCreator<CommandFilterStore> = (set, get) => ({
  filters: EMPTY_FILTERS,
  currency: 'INR',
  targetRoi: null,
  expanded: false,
  defaultYear: null,
  initialised: false,
  lastTouched: null,

  set: (key, value) =>
    set((s) => ({ filters: { ...s.filters, [key]: value }, lastTouched: key })),

  /** Add or remove one value from a list-valued filter. Single-select
   *  dimensions replace rather than accumulate. */
  toggle: (key, value) =>
    set((s) => {
      const current = s.filters[key]
      if (!MULTI_SELECT.has(key)) {
        return {
          filters: { ...s.filters, [key]: current.includes(value) ? [] : [value] },
          lastTouched: key,
        }
      }
      const next = current.includes(value)
        ? current.filter((v) => v !== value)
        : [...current, value]
      return { filters: { ...s.filters, [key]: next }, lastTouched: key }
    }),

  setCurrency: (currency) => set({ currency }),
  setTargetRoi: (targetRoi) => set({ targetRoi }),
  toggleExpanded: () => set((s) => ({ expanded: !s.expanded })),

  /** Reset restores the default period and clears everything else to "All".
   *  The primary controls keep a valid selection — never a blank one. */
  reset: () => set({ filters: { ...EMPTY_FILTERS, year: get().defaultYear }, lastTouched: null }),

  applyScope: (scope) =>
    set((s) => ({
      filters: { ...EMPTY_FILTERS, ...scope },
      initialised: true,
      defaultYear: s.defaultYear ?? scope.year ?? null,
      lastTouched: null,
    })),

  initialise: (year) =>
    set((s) =>
      s.initialised
        ? s
        : { ...s, initialised: true, defaultYear: year, filters: { ...s.filters, year } },
    ),

  /** Drop any selection the backend no longer offers under the current scope.
   *
   *  This is THE guarantee that filter state stays valid, and it replaces the
   *  hand-written parent→child tree this store used to rely on. That tree was
   *  one-directional: it cleared children when a parent changed but never the
   *  reverse, so 138 contradictory states (Channel = E-commerce held alongside
   *  Region = Central, Tier = Tier 3 held alongside Region = West, …) survived
   *  it and resolved to an empty dashboard. Reconciliation is symmetric by
   *  construction: it asks only whether a value is still reachable, so it fixes
   *  a contradiction no matter which side of it the user created.
   *
   *  Recency breaks the tie. Two contradictory selections invalidate each other,
   *  so a purely stateless pass would clear both and one click would wipe an
   *  unrelated filter. `lastTouched` is therefore pruned last: everything else
   *  gives way first, and the protected dimension is only cleared if that
   *  resolved nothing.
   *
   *  Only values genuinely absent from the returned options are removed — a
   *  valid selection is never cleared. `month` is checked the same way.
   *
   *  TERMINATION. Every pass strictly removes values and never adds one, so the
   *  selection set shrinks monotonically and the empty selection is a fixed
   *  point. When nothing is removed the object identity is unchanged and no
   *  state update is emitted, so React Query is not re-triggered and the
   *  update → refetch → reconcile cycle cannot loop. */
  reconcile: (options) =>
    set((s) => {
      const next: CommandFilters = { ...s.filters }
      const protectedKey = s.lastTouched

      /** Drop values this scope no longer offers, optionally skipping the
       *  dimension the user just touched. */
      const prune = (skip: keyof CommandFilters | null): boolean => {
        let changed = false
        for (const key of LIST_FILTER_KEYS) {
          if (key === skip) continue
          const selected = next[key]
          if (selected.length === 0) continue
          const available = new Set(codesOf(options, key))
          const kept = selected.filter((value) => available.has(value))
          if (kept.length !== selected.length) {
            next[key] = kept
            changed = true
          }
        }
        if (skip !== 'month' && next.month !== null) {
          const months = new Set((options.months ?? []).map((m) => Number(m.code)))
          if (!months.has(next.month)) {
            next.month = null
            changed = true
          }
        }
        return changed
      }

      // Everything except the just-touched dimension gives way first. Only if
      // that resolved nothing is the protected dimension itself pruned — which
      // is what stops a permanently-invalid protected value from surviving, and
      // what guarantees the pass always makes progress or stops.
      let changed = prune(protectedKey)
      if (!changed && protectedKey !== null) changed = prune(null)

      return changed ? { filters: next } : s
    }),
  })
  // The Insights Hub's store is session-only by design. A page that carries a
  // scope in from elsewhere (the Simulation Studio) keeps it in sessionStorage
  // — per tab, gone when the tab closes — so a reload does not drop it.
  if (!persistKey) return create<CommandFilterStore>()(initializer)
  return create<CommandFilterStore>()(
    persist(initializer, {
      name: persistKey,
      storage: createJSONStorage(() => sessionStorage),
      partialize: (s) => ({ filters: s.filters, currency: s.currency, initialised: s.initialised, defaultYear: s.defaultYear }) as CommandFilterStore,
    }),
  )
}

export const useCommandFilters = createFilterStore()

export type FilterStoreHook = ReturnType<typeof createFilterStore>

/** Query-string form of the filter state, for the API layer. Empty lists are
 *  omitted entirely so "no constraint" and "constrained to nothing" stay
 *  distinguishable on the wire. */
export function toQuery(filters: CommandFilters, currency?: Currency, targetRoi?: number | null): string {
  const params = new URLSearchParams()
  for (const [key, value] of Object.entries(filters)) {
    if (value === null || value === undefined) continue
    if (Array.isArray(value)) {
      for (const item of value) params.append(key, item)
    } else {
      params.set(key, String(value))
    }
  }
  if (currency) params.set('currency', currency)
  // Omitted entirely at the default, so the request is byte-for-byte the one
  // the page has always sent and the backend's own default answers it.
  if (targetRoi !== null && targetRoi !== undefined) params.set('target_roi', String(targetRoi))
  return params.toString()
}
