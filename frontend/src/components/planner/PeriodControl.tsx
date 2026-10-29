import { useMemo } from 'react'
import { Button, ChipRow, OptionChip } from '../ui'
import { Icon } from '../../icons'
import { PeriodRangeFields } from './PeriodRangeFields'
import { smartPeriodLabel } from './PeriodPicker'
import type { WeekKey } from '../../hooks/usePeriodSelection'
import type { PlannerOptions } from '../../types/planner'

/** THE PERIOD, AS THREE PILLS — Year, Month and Date range.
 *
 *  ONE CONTROL, THREE PAGES. The Insights Hub bar, the Simulation Studio's
 *  selection bar and the alerts dialog on Investigations all choose the same
 *  thing: a span of business weeks. They chose it three different ways -- a
 *  chip panel, a floating 380x590 calendar and an embedded one -- so the same
 *  question looked and behaved differently depending on which page asked it.
 *  This is the Hub's arrangement, lifted out so the other two can have it.
 *
 *  WEEKS ARE THE COMMON CURRENCY. Every pick ends in `onApply(from, to)` over
 *  two business weeks, which is what all three stores hold. A host that ALSO
 *  keeps a year and a month of its own (the Hub, and the alerts dialog over
 *  the Hub's store) passes `onYear`/`onMonth`, so a year stays a year rather
 *  than becoming the weeks it happens to cover -- that is what keeps its
 *  "2025 (Annual)" labels and its month-aware comparisons. A host without
 *  those fields (the Studio) passes neither and gets the span.
 *
 *  WHAT IS SELECTED IS DERIVED, not tracked. `start`/`end` already say it: a
 *  span that is exactly one business year IS that year, and one that is
 *  exactly one month IS that month. A host holding the fields can pass them
 *  explicitly and skip the guessing. */

export type PeriodPanelKey = 'year' | 'month' | 'range'

/** A month of the data, with the business weeks it holds. */
interface MonthSpan {
  year: number
  month: number
  from: WeekKey
  to: WeekKey
}

const MONTH_ABBR = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

/** The rolling windows offered beside the years. */
const RECENT_SPANS = [3, 6, 12] as const

const sameKey = (a: WeekKey | null, b: WeekKey | null) => !!a && !!b && a[0] === b[0] && a[1] === b[1]

export interface PeriodScope {
  calendar: PlannerOptions['calendar']
  start: WeekKey | null
  end: WeekKey | null
  years: number[]
  monthsOfYear: MonthSpan[]
  selectedYear: number | null
  selectedMonth: number | null
  /** A span that is neither a whole year nor a single month. */
  custom: boolean
  labels: Record<PeriodPanelKey, string>
  /** Absent where the host always has a period (the Studio plans inside one). */
  clear: (() => void) | null
  pickYear: (year: number) => void
  pickMonth: (year: number, month: number) => void
  pickSpan: (from: WeekKey, to: WeekKey) => void
  recent: Array<{ months: number; span: { from: WeekKey; to: WeekKey } | null; active: boolean }>
}

export function usePeriodScope({
  calendar,
  start,
  end,
  onApply,
  onClear,
  onYear,
  onMonth,
  year,
  month,
}: {
  calendar: PlannerOptions['calendar']
  start: WeekKey | null
  end: WeekKey | null
  onApply: (from: WeekKey, to: WeekKey) => void
  onClear?: () => void
  onYear?: (year: number) => void
  onMonth?: (year: number, month: number) => void
  /** The host's own fields, where it keeps them. Derived when absent. */
  year?: number | null
  month?: number | null
}): PeriodScope {
  /** Every month the data covers, oldest first. Each calendar week names its
   *  own month, so a month's span is its first and last week -- the same rule
   *  usePeriodSelection and the period calendar both read it by. */
  const months = useMemo(() => {
    const out: MonthSpan[] = []
    for (const y of calendar) {
      const spans = new Map<number, { from: WeekKey; to: WeekKey }>()
      for (const w of y.weeks) {
        const key: WeekKey = [y.year, w.week]
        const cur = spans.get(w.month)
        spans.set(w.month, cur ? { from: cur.from, to: key } : { from: key, to: key })
      }
      for (const [m, span] of [...spans.entries()].sort((a, b) => a[0] - b[0])) {
        out.push({ year: y.year, month: m, ...span })
      }
    }
    return out
  }, [calendar])

  const years = useMemo(() => calendar.filter((y) => y.weeks.length).map((y) => y.year), [calendar])

  /** The whole-year span of each business year. */
  const yearSpan = (y: number) => {
    const ws = calendar.find((c) => c.year === y)?.weeks ?? []
    return ws.length ? { from: [y, ws[0].week] as WeekKey, to: [y, ws[ws.length - 1].week] as WeekKey } : null
  }

  // WHICH MONTH, MATCHED BY ITS WEEKS AND SO BY ITS YEAR TOO. Matching on the
  // month NUMBER and then looking its year up separately found the first May
  // in the data: picking May under 2026 left the Year pill reading 2024, and
  // the two pills then named a period that did not exist. A span identifies
  // exactly one entry, and that entry carries the year it belongs to.
  const spanMonth = months.find((m) => sameKey(m.from, start) && sameKey(m.to, end)) ?? null
  const spanYear =
    years.find((y) => {
      const s = yearSpan(y)
      return s && sameKey(s.from, start) && sameKey(s.to, end)
    }) ?? null

  // A host that keeps its own year and month is believed over the derivation;
  // only one without them (the Studio) has anything to work out.
  //
  // A WHOLE YEAR WINS OVER A MONTH when the two are the same span, which they
  // are wherever the data covers only one month of some year. Reading it as
  // the month would leave the Month pill naming one the reader never picked,
  // and "Whole year" unselected under a year that is nothing but that month.
  const selectedYear = year !== undefined ? year : (spanYear ?? spanMonth?.year ?? null)
  const selectedMonth = month !== undefined ? month : (spanYear != null ? null : (spanMonth?.month ?? null))
  const custom = !!start && !!end && selectedYear == null && selectedMonth == null

  const pickSpan = (from: WeekKey, to: WeekKey) => onApply(from, to)
  const pickYear = (y: number) => {
    if (onYear) return onYear(y)
    const s = yearSpan(y)
    if (s) onApply(s.from, s.to)
  }
  const pickMonth = (y: number, m: number) => {
    if (onMonth) return onMonth(y, m)
    const s = months.find((x) => x.year === y && x.month === m)
    if (s) onApply(s.from, s.to)
  }

  /** The last `n` whole months of data. Counted from the end of the data
   *  rather than from today: the dataset ends where it ends, and "the last
   *  three months" of an empty future is not a period. */
  const lastMonths = (n: number) => {
    const tail = months.slice(-n)
    return tail.length === n ? { from: tail[0].from, to: tail[tail.length - 1].to } : null
  }
  const isCurrent = (span: { from: WeekKey; to: WeekKey }) => sameKey(span.from, start) && sameKey(span.to, end)

  const spanLabel = start && end ? smartPeriodLabel(start, end, calendar) : null
  const labels: Record<PeriodPanelKey, string> = {
    year: custom ? (spanLabel ?? 'Custom range') : selectedYear != null ? String(selectedYear) : onClear ? 'All data' : (spanLabel ?? 'Period'),
    month: !custom && selectedMonth != null ? MONTH_ABBR[selectedMonth - 1] : 'All months',
    range: custom ? 'Custom range' : 'Date range',
  }

  return {
    calendar,
    start,
    end,
    years,
    monthsOfYear: selectedYear == null ? [] : months.filter((m) => m.year === selectedYear),
    selectedYear,
    selectedMonth,
    custom,
    labels,
    clear: onClear ?? null,
    pickYear,
    pickMonth,
    pickSpan,
    recent: RECENT_SPANS.map((n) => {
      const span = lastMonths(n)
      return { months: n, span, active: !!span && isCurrent(span) }
    }),
  }
}

/** The three pills. `open` is the panel showing, `onOpen` toggles it — the
 *  host owns that state, because it decides where the panel is drawn and what
 *  else closes when one opens. */
export function PeriodPills({
  scope,
  open,
  onOpen,
  controls,
  big = false,
}: {
  scope: PeriodScope
  open: PeriodPanelKey | null
  onOpen: (next: PeriodPanelKey | null) => void
  /** The id of the element the pills expand, for `aria-controls`. */
  controls: string
  /** The Studio'scontrol height — its bar is a row of 40px controls, where the
   *  Hub's is 36px. One flag rather than two components. */
  big?: boolean
}) {
  const pill = (key: PeriodPanelKey, icon: 'filter' | 'calendar', muted = false) => (
    <Button
      variant={open === key ? 'primary' : 'secondary'}
      size="pill"
      className={`cursor-pointer ${big ? '!h-10 !text-base' : ''} ${muted && open !== key ? 'opacity-60' : ''}`}
      onClick={() => onOpen(open === key ? null : key)}
      aria-expanded={open === key}
      aria-controls={open === key ? controls : undefined}
    >
      <Icon name={icon} />
      <span>{scope.labels[key]}</span>
      <Icon name="chevronDown" className={open === key ? 'rotate-180 transition-transform' : 'transition-transform'} />
    </Button>
  )
  return (
    <>
      {pill('year', 'calendar')}
      {pill('month', 'filter', scope.custom)}
      {pill('range', 'calendar')}
    </>
  )
}

/** What an open pill shows. The host wraps this in its own panel frame, so the
 *  Hub's hairline strip and the Studio's bar can each look like themselves. */
export function PeriodPanel({ scope, which }: { scope: PeriodScope; which: PeriodPanelKey }) {
  if (which === 'year') {
    return (
      <div className="flex flex-col gap-2">
        <ChipRow label="Year">
          {scope.clear && (
            <OptionChip label="All data" selected={!scope.custom && scope.selectedYear == null} onClick={scope.clear} />
          )}
          {scope.years.map((y) => (
            <OptionChip
              key={y}
              label={String(y)}
              selected={!scope.custom && scope.selectedYear === y}
              onClick={() => scope.pickYear(y)}
            />
          ))}
        </ChipRow>
        {/* The rolling windows, beside the years rather than on a pill of
            their own: they answer the same question a year does. */}
        <ChipRow label="Recent">
          {scope.recent.map((r) => (
            <OptionChip
              key={r.months}
              label={`Last ${r.months} months`}
              selected={r.active}
              onClick={() => r.span && scope.pickSpan(r.span.from, r.span.to)}
            />
          ))}
        </ChipRow>
      </div>
    )
  }

  if (which === 'month') {
    if (scope.selectedYear == null || scope.custom) {
      return (
        <p className="text-sm leading-[1.5] text-ink-muted">
          {scope.custom
            ? 'A date range is set. Pick a year to choose months again.'
            : 'Pick a year first — a month needs one to be a period.'}
        </p>
      )
    }
    return (
      // One row, already headed by the panel, so the chips sit on their own
      // rather than under a second "Month" label.
      <div className="flex flex-wrap items-center gap-1.5">
        <OptionChip
          label="Whole year"
          selected={scope.selectedMonth == null}
          onClick={() => scope.pickYear(scope.selectedYear as number)}
        />
        {scope.monthsOfYear.map((m) => (
          <OptionChip
            key={m.month}
            label={MONTH_ABBR[m.month - 1]}
            selected={scope.selectedMonth === m.month}
            onClick={() => scope.pickMonth(m.year, m.month)}
          />
        ))}
      </div>
    )
  }

  return (
    <>
      <PeriodRangeFields
        calendar={scope.calendar}
        start={scope.start}
        end={scope.end}
        onApply={scope.pickSpan}
        onClear={scope.clear ?? undefined}
        note
      />
      <p className="mt-1.5 text-xs leading-[1.5] text-ink-muted">Replaces the year and month.</p>
    </>
  )
}

/** What the host should title the open panel. */
export const PERIOD_PANEL_TITLE: Record<PeriodPanelKey, string> = {
  year: 'Period',
  month: 'Month',
  range: 'Custom date range',
}
