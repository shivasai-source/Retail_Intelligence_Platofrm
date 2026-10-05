import { create } from 'zustand'
import type { MmmScopeWire } from './types'

/** The MMM view state every MMM page shares: the filter scope and the display
 *  currency. Kept in one store so moving between the Insights Hub, the
 *  Calendar and Reports keeps the reader on the scope they chose, the way
 *  TPO's pages share store/commandFilters.
 *
 *  `year` undefined = not chosen yet, so each page opens on the latest year in
 *  the data; null = "All years" (the hub only — the calendar is per year).
 *
 *  THE FILTERS MEAN WHAT backend/app/mmm/scope.py SAYS. Year, quarter, month
 *  and week pick the PERIOD; a custom date range replaces all four. Promotion
 *  type and event narrow the days within it. Channels pick which spend counts
 *  as ad spend. The baseline is estimated over the period. */
export interface MmmFilters {
  year: number | null | undefined
  quarter: number | null
  month: number | null
  week: number | null
  /** ISO dates (YYYY-MM-DD). Either one set = a custom range. */
  dateFrom: string | null
  dateTo: string | null
  channels: string[]
  promotionTypes: string[]
  events: string[]
}

export type MmmListKey = 'channels' | 'promotionTypes' | 'events'

const EMPTY: Omit<MmmFilters, 'year'> = {
  quarter: null,
  month: null,
  week: null,
  dateFrom: null,
  dateTo: null,
  channels: [],
  promotionTypes: [],
  events: [],
}

interface MmmView extends MmmFilters {
  currency: 'INR' | 'USD'
  /** The More Filters panel. View state, never sent. */
  expanded: boolean
  setYear: (year: number | null) => void
  set: <K extends keyof MmmFilters>(key: K, value: MmmFilters[K]) => void
  toggle: (key: MmmListKey, code: string) => void
  setCurrency: (currency: 'INR' | 'USD') => void
  toggleExpanded: () => void
  /** Back to the opening scope: the latest year, everything else "All". */
  reset: () => void
}

export const useMmmView = create<MmmView>((set) => ({
  year: undefined,
  ...EMPTY,
  currency: 'INR',
  expanded: false,
  setYear: (year) => set({ year }),
  set: (key, value) => set({ [key]: value } as Partial<MmmView>),
  toggle: (key, code) =>
    set((s) => ({ [key]: s[key].includes(code) ? s[key].filter((c) => c !== code) : [...s[key], code] })),
  setCurrency: (currency) => set({ currency }),
  toggleExpanded: () => set((s) => ({ expanded: !s.expanded })),
  reset: () => set({ year: undefined, ...EMPTY }),
}))

/** True when a custom date range is replacing the year/quarter/month/week. */
export function isCustomRange(f: Pick<MmmFilters, 'dateFrom' | 'dateTo'>): boolean {
  return f.dateFrom !== null || f.dateTo !== null
}

/** The scope as /api/mmm/hub's query string and a report's `options.filters`
 *  both take it. `year` is the year resolved for display (see resolveYear). */
export function toWire(f: MmmFilters, year: number | null): MmmScopeWire {
  return {
    year,
    quarter: f.quarter,
    month: f.month,
    week: f.week,
    date_from: f.dateFrom,
    date_to: f.dateTo,
    channels: f.channels,
    promotion_types: f.promotionTypes,
    events: f.events,
  }
}
