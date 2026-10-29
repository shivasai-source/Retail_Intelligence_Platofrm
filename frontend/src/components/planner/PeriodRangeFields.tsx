import { dataDayRange, daySpanOfWeeks, weekForDay } from './PeriodPicker'
import type { WeekKey } from '../../hooks/usePeriodSelection'
import type { PlannerOptions } from '../../types/planner'

/** TWO DATE FIELDS FOR A PERIOD — "From 01-08-2025  To 31-08-2025".
 *
 *  WHY IT IS ITS OWN COMPONENT. The Insights Hub bar, the Simulation Studio's
 *  selection bar and the alerts dialog on Investigations all choose the same
 *  kind of thing: a span of business weeks. They used to do it three different
 *  ways — a chip panel, a floating 380x590 calendar, and an embedded one. The
 *  fields are the quick way into all three, and they are one component so the
 *  snapping rule below cannot drift between them.
 *
 *  NATIVE INPUTS, DELIBERATELY. `type="date"` brings the platform's own
 *  calendar popover, keyboard handling and locale, which is both less code and
 *  more familiar than anything hand-rolled.
 *
 *  DAYS IN, WEEKS OUT. The store holds a period as two business weeks, so each
 *  end is snapped to the week CONTAINING the day typed — never narrower than
 *  what was asked for, because the data is weekly and half a week is not
 *  something the fact table can answer for. The fields then show back the days
 *  those weeks actually cover, so the control never claims a span it did not
 *  select. `note` says so where there is room to say it.
 */
export function PeriodRangeFields({
  calendar,
  start,
  end,
  onApply,
  onClear,
  note = false,
  className = '',
}: {
  calendar: PlannerOptions['calendar']
  start: WeekKey | null
  end: WeekKey | null
  onApply: (from: WeekKey, to: WeekKey) => void
  /** Emptying a field clears the period where that is a thing the page can do
   *  (the Hub's "all data"). Without it an emptied field simply re-shows what
   *  is still selected — the Studio always plans inside some period. */
  onClear?: () => void
  /** The "Data runs from … to …" line under the fields. */
  note?: boolean
  className?: string
}) {
  const bounds = dataDayRange(calendar)
  if (!bounds) return null
  const span = start && end ? daySpanOfWeeks(calendar, start, end) : null

  const edit = (which: 'from' | 'to', iso: string | null) => {
    if (!iso) return onClear?.()
    const from = which === 'from' ? iso : (span?.from ?? bounds.from)
    const to = which === 'to' ? iso : (span?.to ?? bounds.to)
    // Typing a "from" after the "to" is a reversed range, not an error — the
    // two are read in order rather than refused.
    const a = weekForDay(calendar, from < to ? from : to)
    const b = weekForDay(calendar, from < to ? to : from)
    if (a && b) onApply(a, b)
  }

  return (
    <div className={className}>
      {/* TWO COLUMNS WHERE THERE IS ROOM, ONE WHERE THERE IS NOT. `auto-fit`
          with a floor rather than a container query: this renders inside a
          bar, a panel AND a 388px dialog column, and only the last of those is
          a container — so a query would never fire there and the native
          "dd-mm-yyyy" placeholder was clipped. The floor is what one field
          needs for its label, the date and the platform's picker glyph. */}
      <div className="grid max-w-[460px] grid-cols-[repeat(auto-fit,minmax(190px,1fr))] gap-2">
        <DateField
          label="From"
          value={span?.from ?? null}
          min={bounds.from}
          max={span?.to ?? bounds.to}
          onChange={(v) => edit('from', v)}
        />
        <DateField
          label="To"
          value={span?.to ?? null}
          min={span?.from ?? bounds.from}
          max={bounds.to}
          onChange={(v) => edit('to', v)}
        />
      </div>
      {note && (
        <p className="mt-2 text-xs leading-[1.5] text-ink-muted">
          Each end snaps to the business week holding it, because the data is weekly. Data runs from{' '}
          {fmtIso(bounds.from)} to {fmtIso(bounds.to)}.
        </p>
      )}
    </div>
  )
}

/** A native date input in the panel's control size. */
function DateField({
  label,
  value,
  min,
  max,
  onChange,
}: {
  label: string
  value: string | null
  min: string
  max: string
  onChange: (value: string | null) => void
}) {
  return (
    <label className="flex h-[30px] items-center gap-2 rounded-[var(--r-md)] border border-border-default bg-surface-card px-3 text-sm text-ink-primary transition-colors hover:border-border-strong focus-within:ring-2 focus-within:ring-brand-violet">
      <span className="shrink-0 text-ink-muted">{label}</span>
      <input
        type="date"
        aria-label={`${label} date`}
        value={value ?? ''}
        min={min}
        max={max}
        onChange={(e) => onChange(e.target.value || null)}
        className="min-w-0 flex-1 cursor-pointer bg-transparent text-sm tabular-nums text-ink-primary focus:outline-none [color-scheme:light] dark:[color-scheme:dark]"
      />
    </label>
  )
}

const MONTH_ABBR = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

/** "2015-01-01" -> "01 Jan 2015", the backend's own date style. */
function fmtIso(iso: string): string {
  const [y, m, d] = iso.split('-')
  return `${d} ${MONTH_ABBR[Number(m) - 1]} ${y}`
}
