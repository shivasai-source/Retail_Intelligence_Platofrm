import { useMemo } from 'react'
import type { FilterStoreHook } from '../store/commandFilters'
import type { FiltersResponse } from '../types/commandCenter'

export type WeekKey = [number, number]

/** THE PERIOD, read and written the same way wherever it is edited.
 *
 *  EXTRACTED, NOT REWRITTEN. This is the logic that lived inline in
 *  `components/command/FilterBar.tsx` and nowhere else, moved here verbatim so
 *  the alerts dialog on the Investigations page can offer the same calendar
 *  over the same filter store. A second copy of the rules below is how the two
 *  calendars would drift apart about what "a whole year" means.
 *
 *  THE RULES, which are the store's contract (see CommandFilters):
 *    - a period is two business weeks, each `year * 100 + week`, inclusive;
 *    - EXACTLY ONE WHOLE YEAR is held as `year` instead, so everything keyed
 *      on the year (its comparisons, its "F25 (Annual)" labels) reads it as
 *      before;
 *    - both ends null is "all data", the Insights Hub's default.
 *
 *  `lastTouched: 'year'` on every write, because the period is the dimension
 *  the reader just touched and reconciliation protects that one first. */
export function usePeriodSelection(store: FilterStoreHook, options: FiltersResponse | undefined) {
  const filters = store((s) => s.filters)
  const calendar = useMemo(() => options?.calendar ?? [], [options])

  const weeksOf = (year: number) => calendar.find((c) => c.year === year)?.weeks ?? []
  const asKey = (code: number): WeekKey => [Math.floor(code / 100), code % 100]

  let start: WeekKey | null = null
  let end: WeekKey | null = null
  if (filters.period_from != null && filters.period_to != null) {
    start = asKey(filters.period_from)
    end = asKey(filters.period_to)
  } else if (filters.year != null && weeksOf(filters.year).length) {
    const ws = weeksOf(filters.year)
    start = [filters.year, ws[0].week]
    end = [filters.year, ws[ws.length - 1].week]
  }

  /** Apply a range. Exactly one whole year is held as `year`, so the year's
   *  own comparisons and labels ("F25 (Annual)") read it as before. */
  const apply = (a: WeekKey, b: WeekKey) => {
    const ws = weeksOf(a[0])
    const wholeYear = a[0] === b[0] && ws.length > 0 && a[1] === ws[0].week && b[1] === ws[ws.length - 1].week
    store.setState((s) => ({
      filters: {
        ...s.filters,
        year: wholeYear ? a[0] : null,
        month: null,
        period_from: wholeYear ? null : a[0] * 100 + a[1],
        period_to: wholeYear ? null : b[0] * 100 + b[1],
      },
      lastTouched: 'year',
    }))
  }

  const clear = () =>
    store.setState((s) => ({
      filters: { ...s.filters, year: null, month: null, period_from: null, period_to: null },
      lastTouched: 'year',
    }))

  return { calendar, start, end, apply, clear }
}
