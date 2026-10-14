import { useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { Icon } from '../../icons'
import type { PlannerOptions } from '../../types/planner'

/** The period: a date range, chosen like the Google Calendar date picker.
 *
 *  The header shows the period in big type; the date the next click will
 *  set is underlined in blue, and a line under it says what to do ("Now
 *  click the end date"). One month at a time, with arrows. The title climbs
 *  a level per click -- days, then the months of a year, then the years.
 *  Clicking a YEAR selects all of it and opens its months; Apply then takes
 *  the whole year, or a month click narrows it (a second month makes a
 *  range). The period is a soft band
 *  between two solid circles. Days with no data are greyed out. The panel is
 *  one fixed size.
 *
 *  SHARED. The Simulation Studio uses it as is; the Insights Hub passes
 *  `onClear` (an "All data" button -- its default) and `renderTrigger` (its
 *  own pill-shaped button), and may pass no period at all.
 *
 *  THE PLANNER WORKS IN BUSINESS WEEKS. Whatever is chosen, the plan covers
 *  the weeks that contain the start and the end -- the footer says which,
 *  and that is what Apply hands on. */

type WeekKey = [number, number]

const MONTH_ABBR = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
const MONTH_FULL = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December']
const DOW = ['Mo', 'Tu', 'We', 'Th', 'Fr', 'Sa', 'Su']
const PANEL_W = 360

const cmp = (a: WeekKey, b: WeekKey) => a[0] - b[0] || a[1] - b[1]

// --- ISO date strings (YYYY-MM-DD), computed in UTC so no timezone shifts --------

const toDate = (iso: string) => new Date(`${iso}T00:00:00Z`)
const toIso = (d: Date) => d.toISOString().slice(0, 10)
const addDays = (iso: string, n: number) => {
  const d = toDate(iso)
  d.setUTCDate(d.getUTCDate() + n)
  return toIso(d)
}
const fmtDay = (iso: string) => `${Number(iso.slice(8, 10))} ${MONTH_ABBR[Number(iso.slice(5, 7)) - 1]} ${iso.slice(0, 4)}`

interface WeekSpan {
  key: WeekKey
  start: string
  end: string
  month: number
}

/** Every business week with its first and last day, in order. The data's
 *  last week ends where the data does -- its own first day, the date every
 *  other page quotes as the end of the data. */
function weekSpans(calendar: PlannerOptions['calendar']): WeekSpan[] {
  const flat = calendar.flatMap((y) => y.weeks.map((w) => ({ key: [y.year, w.week] as WeekKey, start: w.start, month: w.month })))
  return flat.map((w, i) => ({ ...w, end: i + 1 < flat.length ? addDays(flat[i + 1].start, -1) : w.start }))
}

/** The business week a day falls in (clamped to the data's edges). */
function weekOf(iso: string, spans: WeekSpan[]): WeekSpan {
  let found = spans[0]
  for (const s of spans) {
    if (s.start <= iso) found = s
    else break
  }
  return found
}

export function periodLabel(start: WeekKey, end: WeekKey, calendar: PlannerOptions['calendar']): string {
  // First day of the first week to the LAST day of the last week -- the same
  // span the backend's labels name ("vs 3 Mar – 1 Jun 2025").
  const spans = weekSpans(calendar)
  const spanOf = (k: WeekKey) => spans.find((s) => cmp(s.key, k) === 0)
  const a = spanOf(start)
  const b = spanOf(end)
  return a && b ? `${fmtDay(a.start)} – ${fmtDay(b.end)}` : `${start[0]}-W${start[1]} – ${end[0]}-W${end[1]}`
}

/** The month a business week belongs to: the one holding most of its days
 *  (its 4th day, or its last for a short week). */
function monthOfSpan(x: WeekSpan): [number, number] {
  const mid = addDays(x.start, 3)
  const day = mid < x.end ? mid : x.end
  return [Number(day.slice(0, 4)), Number(day.slice(5, 7))]
}

/** A period by its months -- "Mar 2025", "Mar – Jun 2025", "Nov 2025 – Feb
 *  2026" -- or "2025" for one whole year. No days: the Insights Hub names
 *  periods in months and years only. */
export function monthPeriodLabel(start: WeekKey, end: WeekKey, calendar: PlannerOptions['calendar']): string {
  const spans = weekSpans(calendar)
  const a = spans.find((s) => cmp(s.key, start) === 0)
  const b = spans.find((s) => cmp(s.key, end) === 0)
  if (!a || !b) return `${start[0]}-W${start[1]} – ${end[0]}-W${end[1]}`
  const ofYear = spans.filter((s) => s.key[0] === start[0])
  if (start[0] === end[0] && cmp(a.key, ofYear[0].key) === 0 && cmp(b.key, ofYear[ofYear.length - 1].key) === 0) return String(start[0])
  const [ya, ma] = monthOfSpan(a)
  const [yb, mb] = monthOfSpan(b)
  if (ya === yb && ma === mb) return `${MONTH_ABBR[ma - 1]} ${ya}`
  if (ya === yb) return `${MONTH_ABBR[ma - 1]} – ${MONTH_ABBR[mb - 1]} ${yb}`
  return `${MONTH_ABBR[ma - 1]} ${ya} – ${MONTH_ABBR[mb - 1]} ${yb}`
}

export function weeksBetween(start: WeekKey, end: WeekKey, calendar: PlannerOptions['calendar']): number {
  let n = 0
  for (const y of calendar) for (const w of y.weeks) if (cmp([y.year, w.week], start) >= 0 && cmp([y.year, w.week], end) <= 0) n++
  return n
}

/** Which date the next click on a day sets.
 *
 *    new    the first click of a fresh period: it sets the start, and the
 *           next click sets the end
 *    end    the next click sets the end
 *    start  the user clicked the start date in the header: the next click
 *           moves the start only */
type Step = 'new' | 'end' | 'start'

export function PeriodPicker({
  calendar,
  start,
  end,
  onApply,
  locked,
  onClear,
  renderTrigger,
  monthsOnly = false,
}: {
  calendar: PlannerOptions['calendar']
  /** Null for "all data": the calendar opens on the data's whole extent. */
  start: WeekKey | null
  end: WeekKey | null
  onApply: (start: WeekKey, end: WeekKey) => void
  /** A promotion focus fixes the period to its month. */
  locked?: string
  /** Offers an "All data" button that drops the period. */
  onClear?: () => void
  /** A page's own trigger button, in place of the Studio's. */
  renderTrigger?: (t: { open: boolean; label: string; weeks: number | null; toggle: () => void }) => ReactNode
  /** Years and months only -- no day grid (the Insights Hub). */
  monthsOnly?: boolean
}) {
  const spans = useMemo(() => weekSpans(calendar), [calendar])
  const minDay = spans[0]?.start ?? ''
  const maxDay = spans[spans.length - 1]?.end ?? ''
  const spanOf = (k: WeekKey) => spans.find((s) => cmp(s.key, k) === 0)
  const years = calendar.filter((y) => y.weeks.length).map((y) => y.year)

  const [open, setOpen] = useState(false)
  const [range, setRange] = useState<{ from: string; to: string }>({ from: '', to: '' })
  const [step, setStep] = useState<Step>('new')
  const [hover, setHover] = useState<string | null>(null)
  const [month, setMonth] = useState<{ y: number; m: number }>({ y: start?.[0] ?? years[years.length - 1] ?? 2026, m: 1 })
  /** What the calendar shows: one month of days, the twelve months of a
   *  year, or the years. The title button climbs a level each click. */
  const [view, setView] = useState<'days' | 'months' | 'years'>('days')
  /** The grain of the last pick. A single month or year is a whole period
   *  already, so Apply needs no second click for it; a single day does. */
  const [grain, setGrain] = useState<'day' | 'month' | 'year'>('day')
  const [chooserYear, setChooserYear] = useState(start?.[0] ?? years[years.length - 1] ?? 2026)
  const anchorRef = useRef<HTMLSpanElement>(null)
  const panelRef = useRef<HTMLDivElement>(null)
  const [place, setPlace] = useState({ left: 0, top: 0, maxH: 600 })

  const showMonthOf = (iso: string) => setMonth({ y: Number(iso.slice(0, 4)), m: Number(iso.slice(5, 7)) })

  useEffect(() => {
    if (!open) return
    const from = (start && spanOf(start)?.start) || minDay
    const to = (end && spanOf(end)?.end) || maxDay
    setRange({ from, to })
    setStep('new')
    setView(monthsOnly ? 'months' : 'days')
    setGrain(monthsOnly ? 'month' : 'day')
    setChooserYear(Number(to.slice(0, 4)))
    showMonthOf(to)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open])

  // Sit under the button and never run past the bottom of the window (a
  // short window or a 90% zoom): re-measured on resize and scroll.
  useLayoutEffect(() => {
    if (!open) return
    const measure = () => {
      if (!anchorRef.current) return
      const r = anchorRef.current.getBoundingClientRect()
      setPlace({ left: Math.max(8, Math.min(r.left, window.innerWidth - PANEL_W - 8)), top: r.bottom + 6, maxH: Math.max(240, window.innerHeight - r.bottom - 14) })
    }
    measure()
    window.addEventListener('resize', measure)
    window.addEventListener('scroll', measure, true)
    return () => {
      window.removeEventListener('resize', measure)
      window.removeEventListener('scroll', measure, true)
    }
  }, [open])

  useEffect(() => {
    if (!open) return
    const onDown = (e: MouseEvent) => {
      if (panelRef.current?.contains(e.target as Node) || anchorRef.current?.contains(e.target as Node)) return
      setOpen(false)
    }
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && setOpen(false)
    document.addEventListener('mousedown', onDown)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onDown)
      document.removeEventListener('keydown', onKey)
    }
  }, [open])

  const pick = (iso: string) => {
    if (step === 'end' && grain === 'day') {
      setRange((r) => (iso < r.from ? { from: iso, to: r.from } : { from: r.from, to: iso }))
      setStep('new')
    } else if (step === 'start') {
      setRange((r) => (iso > r.to ? { from: r.to, to: iso } : { from: iso, to: r.to }))
      setStep('new')
    } else {
      setRange({ from: iso, to: iso })
      setStep('end')
    }
    setHover(null)
  }

  /** A whole month or year, as business weeks. A week counts toward the
   *  month that holds most of its days (its 4th day, or its last for a short
   *  week), so March reads 3 Mar – 30 Mar, not 3 Mar – 6 Apr. */
  const spanOfWeeks = (ws: WeekSpan[]) => (ws.length ? { from: ws[0].start, to: ws[ws.length - 1].end } : null)
  const monthOfWeek = monthOfSpan
  const monthSpan = (y: number, m: number) =>
    spanOfWeeks(spans.filter((x) => x.key[0] === y && monthOfWeek(x)[0] === y && monthOfWeek(x)[1] === m))
  const yearSpan = (y: number) => spanOfWeeks(spans.filter((x) => x.key[0] === y))

  /** A year: select all of it and open its months, so a month can narrow it. */
  const pickYear = (y: number) => {
    const span = yearSpan(y)
    if (!span) return
    setRange(span)
    setStep('new')
    setGrain('year')
    setChooserYear(y)
    setView('months')
  }

  /** A month: the first click selects it, a second click stretches the
   *  period to cover both months. */
  const pickMonth = (y: number, m: number) => {
    const span = monthSpan(y, m)
    if (!span) return
    if (step === 'end' && grain === 'month') {
      setRange((r) => ({ from: span.from < r.from ? span.from : r.from, to: span.to > r.to ? span.to : r.to }))
      setStep('new')
    } else if (step === 'start') {
      setRange((r) => ({ from: span.from, to: span.to > r.to ? span.to : r.to }))
      setStep('new')
    } else if (step === 'end') {
      setRange((r) => ({ from: span.from < r.from ? span.from : r.from, to: span.to > r.to ? span.to : r.to }))
      setStep('new')
    } else {
      setRange(span)
      setStep('end')
    }
    setGrain('month')
  }

  // While the end is being chosen, the band follows the pointer.
  const shown =
    step === 'end' && hover ? (hover < range.from ? { from: hover, to: range.from } : { from: range.from, to: hover }) : range
  const fromWeek = range.from ? weekOf(range.from, spans) : null
  const toWeek = range.to ? weekOf(range.to, spans) : null
  const nWeeks = fromWeek && toWeek ? weeksBetween(fromWeek.key, toWeek.key, calendar) : 0

  const first = `${month.y}-${String(month.m).padStart(2, '0')}-01`
  const canPrev = first > minDay
  const canNext = addDays(first, 31).slice(0, 7) <= maxDay.slice(0, 7)
  const go = (n: number) => {
    const i = month.y * 12 + month.m - 1 + n
    setMonth({ y: Math.floor(i / 12), m: (i % 12) + 1 })
  }

  const wholeYear = years.find((y) => {
    const span = yearSpan(y)
    return span && span.from === range.from && span.to === range.to
  })
  const hint =
    view === 'years'
      ? 'Click a year to select all of it'
      : view === 'months'
        ? step === 'start'
          ? 'Click the new first month'
          : step === 'end' && grain === 'month'
          ? 'Click another month for a range, or press Apply'
          : wholeYear
            ? `All of ${wholeYear} is selected · click a month to narrow it`
            : 'Click a month to select it'
        : step === 'end'
          ? 'Now click the end date'
          : step === 'start'
            ? 'Click the new start date'
            : 'Click a day to start a new period'
  // One day is not a period yet; one month or one year is.
  const incomplete = step === 'end' && grain === 'day'

  const triggerLabel = start && end ? (monthsOnly ? monthPeriodLabel(start, end, calendar) : periodLabel(start, end, calendar)) : 'All data'
  /** One edge of the period in the header: a day, or (months only) its month. */
  const edgeText = (iso: string) => {
    if (!iso || !monthsOnly) return undefined
    const [y, m] = monthOfSpan(weekOf(iso, spans))
    return `${MONTH_ABBR[m - 1]} ${y}`
  }
  const triggerWeeks = start && end ? weeksBetween(start, end, calendar) : null

  return (
    <>
      <span ref={anchorRef} className="inline-flex">
        {renderTrigger ? (
          renderTrigger({ open, label: triggerLabel, weeks: triggerWeeks, toggle: () => !locked && setOpen((v) => !v) })
        ) : (
        <button
          type="button"
          onClick={() => !locked && setOpen((v) => !v)}
          title={locked ?? 'Choose the period to plan'}
          aria-haspopup="dialog"
          aria-expanded={open}
          className={`inline-flex h-10 cursor-pointer items-center gap-2 rounded-[var(--r-md)] border px-3 text-base transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-violet [&_svg]:h-4 [&_svg]:w-4 ${
            open ? 'border-brand-violet/50 bg-brand-violet-50 text-brand-violet' : 'border-border-default bg-surface-card text-ink-secondary hover:border-border-strong hover:bg-surface-hover'
          } ${locked ? 'cursor-default' : ''}`}
        >
          <Icon name="calendar" />
          <span className="font-medium">Period</span>
          <span className="font-medium text-ink-primary">{triggerLabel}</span>
          {triggerWeeks !== null && (
            <span className="rounded-[var(--r-sm)] bg-brand-violet-50 px-1.5 py-0.5 text-sm font-medium text-brand-violet">{triggerWeeks} weeks</span>
          )}
          {locked ? <Icon name="lock" /> : <Icon name="chevronDown" />}
        </button>
        )}
      </span>
      {open &&
        createPortal(
          <div
            ref={panelRef}
            role="dialog"
            aria-label="Choose the period"
            className="dd-enter fixed z-[9999] flex flex-col overflow-hidden rounded-[var(--r-xl)] border border-border-default bg-surface-card shadow-[var(--shadow-lg)]"
            style={{ left: place.left, top: place.top, width: PANEL_W, maxWidth: 'calc(100vw - 16px)', maxHeight: place.maxH }}
          >
            {/* HEADER: the period in big type. Click a date to change just that one. */}
            <div className="shrink-0 border-b border-border-subtle px-5 pb-3 pt-4">
              <div className="text-sm text-ink-muted">Select period</div>
              <div className="mt-1 flex items-baseline gap-2 text-xl">
                <DateText value={range.from} text={edgeText(range.from)} active={step === 'start'} onClick={() => {
                    setStep('start')
                    setGrain(monthsOnly ? 'month' : 'day')
                    if (monthsOnly) {
                      setChooserYear(Number(range.from.slice(0, 4)))
                      setView('months')
                    } else {
                      setView('days')
                      showMonthOf(range.from)
                    }
                  }}
                  label="start"
                />
                <span className="text-ink-muted">–</span>
                <DateText value={step === 'end' && range.from === range.to ? '' : range.to} text={step === 'end' && range.from === range.to ? undefined : edgeText(range.to)} active={step === 'end'} onClick={() => {
                    setStep('end')
                    setGrain(monthsOnly ? 'month' : 'day')
                    if (monthsOnly) {
                      setChooserYear(Number(range.to.slice(0, 4)))
                      setView('months')
                    } else {
                      setView('days')
                      showMonthOf(range.to)
                    }
                  }}
                  label="end"
                />
              </div>
              <div className="mt-1 text-sm text-ink-muted">
                {nWeeks} {nWeeks === 1 ? 'week' : 'weeks'} · <span className={step === 'new' && view === 'days' ? '' : 'font-medium text-brand-blue'}>{hint}</span>
              </div>
            </div>

            {/* NAV BAR: the title climbs a level -- days, months, years. */}
            <div className="flex shrink-0 items-center justify-between px-3 pt-3">
              {view === 'years' ? (
                <span className="px-2 py-1 text-base font-medium text-ink-primary">Choose a year</span>
              ) : (
                <button
                  type="button"
                  title={view === 'days' ? 'Choose a month' : 'Choose a year'}
                  onClick={() => {
                    if (view === 'days') {
                      setChooserYear(month.y)
                      setView('months')
                    } else setView('years')
                  }}
                  className="inline-flex cursor-pointer items-center gap-1 rounded-[var(--r-md)] px-2 py-1 text-base font-medium text-ink-primary hover:bg-surface-hover [&_svg]:h-4 [&_svg]:w-4"
                >
                  {view === 'months' ? chooserYear : `${MONTH_FULL[month.m - 1]} ${month.y}`}
                  <Icon name="chevronDown" />
                </button>
              )}
              <div className="flex items-center">
                {view !== 'days' && !monthsOnly && (
                  <button
                    type="button"
                    onClick={() => {
                      showMonthOf(range.from || minDay)
                      setView('days')
                    }}
                    className="mr-1 h-8 cursor-pointer rounded-[var(--r-md)] px-2.5 text-sm font-medium text-brand-blue hover:bg-brand-blue-50"
                  >
                    Pick days
                  </button>
                )}
                {view !== 'years' && (
                  <>
                    <RoundButton
                      label={view === 'months' ? 'Previous year' : 'Previous month'}
                      icon="chevronLeft"
                      disabled={view === 'months' ? chooserYear <= years[0] : !canPrev}
                      onClick={() => (view === 'months' ? setChooserYear(chooserYear - 1) : go(-1))}
                    />
                    <RoundButton
                      label={view === 'months' ? 'Next year' : 'Next month'}
                      icon="chevronRight"
                      disabled={view === 'months' ? chooserYear >= years[years.length - 1] : !canNext}
                      onClick={() => (view === 'months' ? setChooserYear(chooserYear + 1) : go(1))}
                    />
                  </>
                )}
              </div>
            </div>

            {/* BODY: days, months or years. One fixed height. */}
            <div className="min-h-0 flex-1 overflow-y-auto px-3 pb-2 pt-1" onMouseLeave={() => setHover(null)}>
              <div className="h-[272px]">
              {view === 'years' ? (
                <div className="grid grid-cols-2 gap-2 pt-3">
                  {years.map((y) => {
                    const span = yearSpan(y)
                    const n = spans.filter((x) => x.key[0] === y).length
                    const on = !!span && span.to >= range.from && span.from <= range.to
                    const whole = wholeYear === y
                    return (
                      <button
                        key={y}
                        type="button"
                        onClick={() => pickYear(y)}
                        className={`flex h-16 cursor-pointer flex-col items-center justify-center rounded-[var(--r-lg)] transition-colors ${
                          whole ? 'bg-brand-violet text-white' : on ? 'bg-brand-blue-50 text-brand-violet hover:bg-brand-blue/15' : 'text-ink-primary hover:bg-surface-hover'
                        }`}
                      >
                        <span className="text-md font-medium">{y}</span>
                        <span className={`text-sm ${whole ? 'text-white/80' : 'text-ink-muted'}`}>{n < 50 ? `${n} weeks so far` : `${n} weeks`}</span>
                      </button>
                    )
                  })}
                </div>
              ) : view === 'months' ? (
                <div className="grid grid-cols-3 gap-2 pt-3">
                  {MONTH_ABBR.map((name, i) => {
                    const span = monthSpan(chooserYear, i + 1)
                    const on = !!span && span.to >= range.from && span.from <= range.to
                    const edge = !!span && !wholeYear && (span.from === range.from || span.to === range.to)
                    return (
                      <button
                        key={name}
                        type="button"
                        disabled={!span}
                        title={span ? `${MONTH_FULL[i]} ${chooserYear}` : 'No data'}
                        onClick={() => pickMonth(chooserYear, i + 1)}
                        className={`h-11 cursor-pointer rounded-[var(--r-pill)] text-base transition-colors disabled:cursor-not-allowed disabled:text-ink-disabled ${
                          edge ? 'bg-brand-violet font-medium text-white' : on ? 'bg-brand-blue-50 text-brand-violet hover:bg-brand-blue/15' : 'text-ink-primary hover:bg-surface-hover'
                        }`}
                      >
                        {name}
                      </button>
                    )
                  })}
                </div>
              ) : (
                <MonthGrid
                  year={month.y}
                  month={month.m}
                  minDay={minDay}
                  maxDay={maxDay}
                  from={shown.from}
                  to={shown.to}
                  onPick={(iso) => {
                    pick(iso)
                    setGrain('day')
                  }}
                  onHover={(iso) => step === 'end' && grain === 'day' && setHover(iso)}
                />
              )}
              </div>
            </div>

            {/* FOOTER: what the plan will cover, and the two actions. */}
            <div className="flex shrink-0 items-center justify-between gap-3 border-t border-border-subtle px-5 py-2.5">
              {onClear ? (
                <TextButton
                  title="Show every week the data holds"
                  onClick={() => {
                    onClear()
                    setOpen(false)
                  }}
                >
                  All data
                </TextButton>
              ) : (
              <span className="min-w-0 truncate text-sm text-ink-muted">
                {fromWeek && toWeek
                  ? fromWeek.key[0] === toWeek.key[0]
                    ? `Weeks ${fromWeek.key[1]}–${toWeek.key[1]}, ${toWeek.key[0]}`
                    : `Week ${fromWeek.key[1]} ${fromWeek.key[0]} – week ${toWeek.key[1]} ${toWeek.key[0]}`
                  : ''}
              </span>
              )}
              <div className="flex shrink-0 items-center gap-2">
                <TextButton onClick={() => setOpen(false)}>Cancel</TextButton>
                <TextButton
                  strong
                  disabled={incomplete || !fromWeek || !toWeek}
                  title={incomplete ? 'Click the end date first' : undefined}
                  onClick={() => {
                    if (fromWeek && toWeek) onApply(fromWeek.key, toWeek.key)
                    setOpen(false)
                  }}
                >
                  Apply
                </TextButton>
              </div>
            </div>
          </div>,
          document.body,
        )}
    </>
  )
}

/** A date in the header: big text, underlined in blue while it is the one the
 *  next click will set. */
function DateText({ value, text, active, onClick, label }: { value: string; text?: string; active: boolean; onClick: () => void; label: string }) {
  return (
    <button
      type="button"
      onClick={onClick}
      title={`Change the ${label} date`}
      className={`cursor-pointer border-b-2 pb-0.5 font-normal transition-colors ${
        active ? 'border-brand-blue text-brand-blue' : 'border-transparent text-ink-primary hover:border-border-strong'
      }`}
    >
      {value ? (text ?? fmtDay(value)) : <span className="text-ink-muted">{text === undefined ? 'End' : 'End month'}</span>}
    </button>
  )
}

function RoundButton({ label, icon, disabled, onClick }: { label: string; icon: 'chevronLeft' | 'chevronRight'; disabled?: boolean; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      aria-label={label}
      title={label}
      className="grid h-9 w-9 cursor-pointer place-items-center rounded-full text-ink-secondary transition-colors hover:bg-surface-hover disabled:cursor-not-allowed disabled:opacity-30 [&_svg]:h-5 [&_svg]:w-5"
    >
      <Icon name={icon} />
    </button>
  )
}

function TextButton({ strong, className = '', ...props }: React.ButtonHTMLAttributes<HTMLButtonElement> & { strong?: boolean }) {
  return (
    <button
      type="button"
      {...props}
      className={`h-9 cursor-pointer rounded-[var(--r-md)] px-4 text-base font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-40 ${
        strong ? 'bg-brand-violet text-white shadow-[var(--shadow-sm)] hover:bg-brand-violet-600' : 'text-ink-secondary hover:bg-surface-hover hover:text-ink-primary'
      } ${className}`}
    />
  )
}

/** One month of days, Monday first, always six rows so the panel never
 *  changes height. The period is a soft band; its first and last days are
 *  solid circles; days outside the data are greyed out. */
function MonthGrid({
  year,
  month,
  minDay,
  maxDay,
  from,
  to,
  onPick,
  onHover,
}: {
  year: number
  month: number
  minDay: string
  maxDay: string
  from: string
  to: string
  onPick: (iso: string) => void
  onHover: (iso: string) => void
}) {
  const first = `${year}-${String(month).padStart(2, '0')}-01`
  const lead = (toDate(first).getUTCDay() + 6) % 7
  const days = new Date(Date.UTC(year, month, 0)).getUTCDate()
  const slots: (string | null)[] = [...Array(lead).fill(null), ...Array.from({ length: days }, (_, i) => addDays(first, i))]
  while (slots.length < 42) slots.push(null)
  return (
    <div className="grid grid-cols-7 text-center">
      {DOW.map((d) => (
        <span key={d} className="pb-1 text-sm text-ink-muted">
          {d}
        </span>
      ))}
      {slots.map((iso, i) => {
        if (!iso) return <span key={`b${i}`} className="h-9" />
        const out = iso < minDay || iso > maxDay
        const inRange = !out && !!from && !!to && iso >= from && iso <= to
        const edge = iso === from || iso === to
        const single = from === to
        return (
          <span
            key={iso}
            className={`relative flex h-9 items-center justify-center ${
              inRange && !single
                ? iso === from
                  ? 'bg-gradient-to-r from-transparent from-50% to-brand-blue-50 to-50%'
                  : iso === to
                    ? 'bg-gradient-to-r from-brand-blue-50 from-50% to-transparent to-50%'
                    : 'bg-brand-blue-50'
                : ''
            }`}
          >
            <button
              type="button"
              disabled={out}
              title={out ? 'No data for this day' : undefined}
              onClick={() => onPick(iso)}
              onMouseEnter={() => onHover(iso)}
              className={`relative grid h-9 w-9 cursor-pointer place-items-center rounded-full text-base [font-variant-numeric:tabular-nums] transition-colors disabled:cursor-not-allowed ${
                out
                  ? 'text-ink-disabled'
                  : edge
                    ? 'bg-brand-violet font-medium text-white'
                    : inRange
                      ? 'text-brand-violet hover:bg-brand-blue/15'
                      : 'text-ink-primary hover:bg-surface-hover'
              }`}
            >
              {Number(iso.slice(8, 10))}
            </button>
          </span>
        )
      })}
    </div>
  )
}
