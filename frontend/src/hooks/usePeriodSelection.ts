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
    // A MONTH IS A MONTH ON THE BUTTON TOO.
    //
    // `month` is part of the filter contract and the engine honours it, but
    // this hook used to ignore it — so a scope of September 2025, which the
    // Analyst sets as {year: 2025, month: 9}, drew the whole year's weeks and
    // the period button read "2025". The figures underneath were September's.
    // A control that disagrees with the numbers beside it is worse than one
    // that is merely coarse: the reader has no way to tell which is lying.
    //
    // Each calendar week carries the month it belongs to, so the span is the
    // first and last week of that month — which is exactly what the button's
    // own month label is built from.
    const inScope = filters.month == null ? ws : ws.filter((w) => w.month === filters.month)
    const span = inScope.length ? inScope : ws
    start = [filters.year, span[0].week]
    end = [filters.year, span[span.length - 1].week]
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

  /** EVERY MONTH THE DATA COVERS, oldest first, with the business weeks it
   *  holds. Each calendar week names its own month, so a month's span is its
   *  first and last week — the same rule `start`/`end` above read it by, and
   *  the same one the period calendar's Months grid uses.
   *
   *  The compact period panel on the Insights Hub bar builds its month chips
   *  from this, so a month chosen there covers exactly the weeks the calendar
   *  would have chosen for it. */
  const months = useMemo(() => {
    const out: Array<{ year: number; month: number; from: WeekKey; to: WeekKey }> = []
    for (const y of calendar) {
      const spans = new Map<number, { from: WeekKey; to: WeekKey }>()
      for (const w of y.weeks) {
        const key: WeekKey = [y.year, w.week]
        const cur = spans.get(w.month)
        spans.set(w.month, cur ? { from: cur.from, to: key } : { from: key, to: key })
      }
      for (const [month, span] of [...spans.entries()].sort((a, b) => a[0] - b[0])) {
        out.push({ year: y.year, month, ...span })
      }
    }
    return out
  }, [calendar])

  /** A WHOLE YEAR, and A SINGLE MONTH, written as the store's own fields
   *  rather than as a week range.
   *
   *  `apply` already folds a whole year back into `year`; a month has the same
   *  claim on `month`, which is part of the filter contract and is what gives
   *  the page its "September F25" labels and its month-aware comparisons. The
   *  calendar could not use these — it only ever knew about weeks — but the
   *  chip panel picks a year or a month by name, so it can say so exactly. */
  const applyYear = (year: number) =>
    store.setState((s) => ({
      filters: { ...s.filters, year, month: null, period_from: null, period_to: null },
      lastTouched: 'year',
    }))

  const applyMonth = (year: number, month: number) =>
    store.setState((s) => ({
      filters: { ...s.filters, year, month, period_from: null, period_to: null },
      lastTouched: 'year',
    }))

  return { calendar, start, end, apply, clear, months, applyYear, applyMonth }
}
