import { useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { Icon } from '../../icons'
import type { PlannerOptions } from '../../types/planner'

/** The period: a date range, chosen by dates or by whole months.
 *
 *  TWO MODES, ONE PANEL.
 *    Dates   a month of days. Click a start day, then an end day -- in the
 *            same month or any other: the arrows step a month, and the
 *            month title opens a month-and-year grid that JUMPS there, so a
 *            range across months or years is two clicks to reach.
 *    Months  the twelve months of a year. Click a start month, then an end
 *            month -- the arrows change year, so a range across years works
 *            the same way. One month alone is a period too. "All of 2025"
 *            takes a whole year.
 *  Shortcuts (last 3/6/12 months, the last two years) sit above both. While
 *  the end is being chosen the range follows the pointer. The header shows
 *  the two ends; click either to change just that one. Days and months with
 *  no data are greyed out.
 *
 *  THE DATA IS IN BUSINESS WEEKS. Whatever is chosen covers the weeks that
 *  contain its first and last day; the line under the header says exactly
 *  which dates and how many weeks that is, and that is what Apply hands on.
 *
 *  SHARED. The Simulation Studio uses it as is; the Insights Hub passes
 *  `onClear` (an "All data" button -- its default) and `renderTrigger` (its
 *  own pill-shaped button), and may pass no period at all. Both name the
 *  period the same way (`smartPeriodLabel`): whole months as months,
 *  anything that starts or ends inside a month as dates. */

type WeekKey = [number, number]

const MONTH_ABBR = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
const MONTH_FULL = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December']
const DOW = ['Mo', 'Tu', 'We', 'Th', 'Fr', 'Sa', 'Su']
const PANEL_W = 380

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
/** "10 Feb – 20 Apr 2025", or "29 Dec 2025 – 4 Jan 2026" across a year. */
const fmtSpan = (from: string, to: string) =>
  from.slice(0, 4) === to.slice(0, 4)
    ? `${Number(from.slice(8, 10))} ${MONTH_ABBR[Number(from.slice(5, 7)) - 1]} – ${fmtDay(to)}`
    : `${fmtDay(from)} – ${fmtDay(to)}`

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
 *  2026" -- or "2025" for one whole year. */
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

/** Whether a period runs over WHOLE months: it starts on the first week of
 *  a month and ends on the last week of a month (a week belongs to the month
 *  holding most of its days, as everywhere else in this picker). */
function isWholeMonths(start: WeekKey, end: WeekKey, spans: WeekSpan[]): boolean {
  const i = spans.findIndex((s) => cmp(s.key, start) === 0)
  const j = spans.findIndex((s) => cmp(s.key, end) === 0)
  if (i < 0 || j < 0) return false
  const sameMonth = (a: WeekSpan, b: WeekSpan) => {
    const [ya, ma] = monthOfSpan(a)
    const [yb, mb] = monthOfSpan(b)
    return ya === yb && ma === mb
  }
  const startsMonth = i === 0 || !sameMonth(spans[i - 1], spans[i])
  const endsMonth = j === spans.length - 1 || !sameMonth(spans[j], spans[j + 1])
  return startsMonth && endsMonth
}

/** THE PERIOD'S NAME, on every page that shows one. Whole months read as
 *  months -- "Jan – Apr 2026", or "2025" for a whole year -- because the dates
 *  add nothing; a period that starts or ends inside a month reads as its
 *  dates -- "12 Jan – 18 Apr 2026" -- because the month name would hide that
 *  it is partial. */
export function smartPeriodLabel(start: WeekKey, end: WeekKey, calendar: PlannerOptions['calendar']): string {
  return isWholeMonths(start, end, weekSpans(calendar))
    ? monthPeriodLabel(start, end, calendar)
    : periodLabel(start, end, calendar)
}

export function weeksBetween(start: WeekKey, end: WeekKey, calendar: PlannerOptions['calendar']): number {
  let n = 0
  for (const y of calendar) for (const w of y.weeks) if (cmp([y.year, w.week], start) >= 0 && cmp([y.year, w.week], end) <= 0) n++
  return n
}

/** What the next click does.
 *
 *    new        starts a fresh period: it sets the start, and the next
 *               click sets the end
 *    end        sets the end of the period being chosen
 *    editStart  the start was clicked in the header: moves the start only
 *    editEnd    the end was clicked in the header: moves the end only */
type Pending = 'new' | 'end' | 'editStart' | 'editEnd'
type Mode = 'days' | 'months'
interface Range {
  from: string
  to: string
}

/** The next range after clicking a day or a month (`span`: a day is a span
 *  of one day). Ends that cross are swapped, so any order of clicks works. */
function nextRange(range: Range, span: Range, pending: Pending): Range {
  if (pending === 'new') return span
  if (pending === 'end') return { from: span.from < range.from ? span.from : range.from, to: span.to > range.to ? span.to : range.to }
  if (pending === 'editStart') return span.from <= range.to ? { from: span.from, to: range.to } : { from: range.to, to: span.to }
  return span.to >= range.from ? { from: range.from, to: span.to } : { from: span.from, to: range.from }
}

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
  /** Months only -- no Dates mode. */
  monthsOnly?: boolean
}) {
  const spans = useMemo(() => weekSpans(calendar), [calendar])
  const minDay = spans[0]?.start ?? ''
  const maxDay = spans[spans.length - 1]?.end ?? ''
  const spanOf = (k: WeekKey) => spans.find((s) => cmp(s.key, k) === 0)

  /** Each calendar month's span in business weeks, keyed y*12+m-1. A week
   *  belongs to the month holding most of its days, so every week is in
   *  exactly one month -- including the weeks that straddle a new year. */
  const months = useMemo(() => {
    const out = new Map<number, Range>()
    for (const s of spans) {
      const [y, m] = monthOfSpan(s)
      const k = y * 12 + m - 1
      const cur = out.get(k)
      out.set(k, cur ? { from: cur.from, to: s.end } : { from: s.start, to: s.end })
    }
    return out
  }, [spans])
  const monthSpan = (y: number, m: number) => months.get(y * 12 + m - 1) ?? null
  /** A business year: its first week to its last. */
  const yearSpan = (y: number): Range | null => {
    const ws = spans.filter((x) => x.key[0] === y)
    return ws.length ? { from: ws[0].start, to: ws[ws.length - 1].end } : null
  }
  const monthYears = useMemo(() => [...new Set([...months.keys()].map((k) => Math.floor(k / 12)))], [months])
  const businessYears = calendar.filter((y) => y.weeks.length).map((y) => y.year)
  const monthKeys = [...months.keys()]
  const firstMonthKey = Math.min(...monthKeys)
  const lastMonthKey = Math.max(...monthKeys)

  const [open, setOpen] = useState(false)
  const [mode, setMode] = useState<Mode>('days')
  const [range, setRange] = useState<Range>({ from: '', to: '' })
  const [pending, setPending] = useState<Pending>('new')
  const [hover, setHover] = useState<Range | null>(null)
  /** The month the Dates grid shows, and the year the Months grid shows. */
  const [cursor, setCursor] = useState({ y: 2026, m: 1 })
  const [cursorYear, setCursorYear] = useState(2026)
  /** Dates mode's month-and-year jump grid, open over the days. */
  const [jumping, setJumping] = useState(false)
  const [jumpYear, setJumpYear] = useState(2026)
  const anchorRef = useRef<HTMLSpanElement>(null)
  const panelRef = useRef<HTMLDivElement>(null)
  const [place, setPlace] = useState({ left: 0, top: 0, maxH: 640 })

  const showMonthOf = (iso: string) => setCursor({ y: Number(iso.slice(0, 4)), m: Number(iso.slice(5, 7)) })

  // Opening: the current period, in the mode that names it best.
  useEffect(() => {
    if (!open) return
    const from = (start && spanOf(start)?.start) || minDay
    const to = (end && spanOf(end)?.end) || maxDay
    setRange({ from, to })
    setPending('new')
    setHover(null)
    setJumping(false)
    setMode(monthsOnly || !start || !end || isWholeMonths(start, end, spans) ? 'months' : 'days')
    setCursorYear(Number(to.slice(0, 4)))
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
      setPlace({ left: Math.max(8, Math.min(r.left, window.innerWidth - PANEL_W - 8)), top: r.bottom + 6, maxH: Math.max(260, window.innerHeight - r.bottom - 14) })
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
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return
      // Escape steps back: out of the jump grid, then out of a half-chosen
      // range, then closes.
      if (jumping) setJumping(false)
      else if (pending !== 'new') setPending('new')
      else setOpen(false)
    }
    document.addEventListener('mousedown', onDown)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onDown)
      document.removeEventListener('keydown', onKey)
    }
  }, [open, jumping, pending])

  /** A click on a day or a month: the next range, then what comes after. */
  const choose = (span: Range) => {
    setRange((r) => nextRange(r, span, pending))
    setPending(pending === 'new' ? 'end' : 'new')
    setHover(null)
  }
  const preset = (span: Range | null) => {
    if (!span) return
    setRange(span)
    setPending('new')
    setHover(null)
    setCursorYear(Number(span.to.slice(0, 4)))
    showMonthOf(span.to)
  }

  // While the end is being chosen, the range follows the pointer.
  const shown = hover && pending !== 'new' ? nextRange(range, hover, pending) : range
  const fromWeek = shown.from ? weekOf(shown.from, spans) : null
  const toWeek = shown.to ? weekOf(shown.to, spans) : null
  const nWeeks = fromWeek && toWeek ? weeksBetween(fromWeek.key, toWeek.key, calendar) : 0
  // One day is not a period yet; one month is.
  const incomplete = pending === 'end' && mode === 'days'

  // --- shortcuts, relative to the data's last month ---------------------------
  const lastMonths = (n: number): Range | null => {
    const a = months.get(Math.max(firstMonthKey, lastMonthKey - n + 1))
    const b = months.get(lastMonthKey)
    return a && b ? { from: a.from, to: b.to } : null
  }
  const lastYear = businessYears[businessYears.length - 1]
  const presets: { label: string; span: Range | null }[] = [
    { label: 'Last 3 months', span: lastMonths(3) },
    { label: 'Last 6 months', span: lastMonths(6) },
    { label: 'Last 12 months', span: lastMonths(12) },
    { label: String(lastYear), span: yearSpan(lastYear) },
    ...(businessYears.length > 1 ? [{ label: String(lastYear - 1), span: yearSpan(lastYear - 1) }] : []),
  ]
  const presetOn = (span: Range | null) => !!span && span.from === range.from && span.to === range.to && pending === 'new'

  // --- the Dates grid's month arrows: any month that holds a data day -------
  const cursorKey = cursor.y * 12 + cursor.m - 1
  const monthKeyOf = (iso: string) => Number(iso.slice(0, 4)) * 12 + Number(iso.slice(5, 7)) - 1
  const canPrevMonth = cursorKey > monthKeyOf(minDay)
  const canNextMonth = cursorKey < monthKeyOf(maxDay)
  const stepMonth = (n: number) => {
    const i = cursorKey + n
    setCursor({ y: Math.floor(i / 12), m: (i % 12) + 1 })
  }
  const dayMonthHasData = (y: number, m: number) => {
    const k = y * 12 + m - 1
    return k >= monthKeyOf(minDay) && k <= monthKeyOf(maxDay)
  }
  const dayYears = useMemo(() => {
    const out: number[] = []
    for (let y = Number(minDay.slice(0, 4)); y <= Number(maxDay.slice(0, 4)); y++) out.push(y)
    return out
  }, [minDay, maxDay])

  const wholeYear = businessYears.find((y) => {
    const span = yearSpan(y)
    return span && span.from === range.from && span.to === range.to
  })

  const hint =
    mode === 'months'
      ? pending === 'end'
        ? 'Now click the end month (‹ › change year), or Apply for this month alone'
        : pending === 'editStart'
          ? 'Click the new first month'
          : pending === 'editEnd'
            ? 'Click the new last month'
            : 'Click a start month, then an end month'
      : pending === 'end'
        ? 'Now click the end date. ‹ › or the month title reach any month or year'
        : pending === 'editStart'
          ? 'Click the new start date'
          : pending === 'editEnd'
            ? 'Click the new end date'
            : 'Click a start date, then an end date'

  /** An end of the period in the header: its month in Months mode, its day in Dates. */
  const edgeText = (iso: string) => {
    if (!iso) return ''
    if (mode === 'months') {
      const [y, m] = monthOfSpan(weekOf(iso, spans))
      return `${MONTH_ABBR[m - 1]} ${y}`
    }
    return fmtDay(iso)
  }
  const switchMode = (m: Mode) => {
    if (m === mode) return
    setMode(m)
    setPending('new')
    setHover(null)
    setJumping(false)
    if (m === 'months') setCursorYear(Number((range.to || maxDay).slice(0, 4)))
    else showMonthOf(range.to || maxDay)
  }
  const editEdge = (edge: 'editStart' | 'editEnd') => {
    setPending(edge)
    setHover(null)
    const iso = edge === 'editStart' ? range.from : range.to
    if (mode === 'months') setCursorYear(Number(iso.slice(0, 4)))
    else {
      setJumping(false)
      showMonthOf(iso)
    }
  }

  const gridYear = mode === 'months' ? cursorYear : jumpYear
  const gridYears = mode === 'months' ? monthYears : dayYears
  const triggerLabel = start && end ? (monthsOnly ? monthPeriodLabel(start, end, calendar) : smartPeriodLabel(start, end, calendar)) : 'All data'
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
            {/* HEADER: the two ends -- click either to change just that one --
                and exactly what the period will cover. */}
            <div className="shrink-0 border-b border-border-subtle px-5 pb-3 pt-4">
              <div className="flex items-center justify-between gap-3">
                <span className="text-ink-muted">Select period</span>
                {!monthsOnly && (
                  <div role="tablist" aria-label="Choose by" className="inline-flex rounded-[var(--r-pill)] bg-surface-muted p-0.5">
                    {(['days', 'months'] as Mode[]).map((m) => (
                      <button
                        key={m}
                        type="button"
                        role="tab"
                        aria-selected={mode === m}
                        onClick={() => switchMode(m)}
                        className={`h-7 cursor-pointer rounded-[var(--r-pill)] px-3 transition-colors ${mode === m ? 'bg-surface-card text-ink-primary shadow-[var(--shadow-sm)]' : 'text-ink-muted hover:text-ink-primary'}`}
                      >
                        {m === 'days' ? 'Dates' : 'Months'}
                      </button>
                    ))}
                  </div>
                )}
              </div>
              <div className="mt-1.5 flex flex-wrap items-baseline gap-x-2">
                <EdgeButton text={edgeText(shown.from)} active={pending === 'editStart'} onClick={() => editEdge('editStart')} label="start" />
                <span className="text-ink-muted">–</span>
                <EdgeButton
                  text={pending === 'end' && !hover ? '' : edgeText(shown.to)}
                  placeholder={mode === 'months' ? 'End month' : 'End date'}
                  active={pending === 'end' || pending === 'editEnd'}
                  onClick={() => editEdge('editEnd')}
                  label="end"
                />
              </div>
              <div className="mt-1 text-ink-muted [font-variant-numeric:tabular-nums]">
                {fromWeek && toWeek ? `Covers ${fmtSpan(fromWeek.start, toWeek.end)} · ${nWeeks} ${nWeeks === 1 ? 'week' : 'weeks'}` : ''}
              </div>
              <div className="mt-0.5 text-brand-blue">{hint}</div>
            </div>

            {/* SHORTCUTS */}
            <div className="flex shrink-0 flex-wrap gap-1.5 px-4 pt-3">
              {presets.map((p) => (
                <button
                  key={p.label}
                  type="button"
                  disabled={!p.span}
                  onClick={() => preset(p.span)}
                  className={`h-7 cursor-pointer rounded-[var(--r-pill)] border px-2.5 transition-colors disabled:cursor-not-allowed disabled:opacity-40 ${
                    presetOn(p.span) ? 'border-brand-violet bg-brand-violet text-white' : 'border-border-default text-ink-secondary hover:border-border-strong hover:bg-surface-hover'
                  }`}
                >
                  {p.label}
                </button>
              ))}
            </div>

            {/* NAV BAR */}
            <div className="flex shrink-0 items-center justify-between px-3 pt-2">
              {mode === 'days' && !jumping ? (
                <button
                  type="button"
                  title="Jump to another month or year"
                  onClick={() => {
                    setJumpYear(cursor.y)
                    setJumping(true)
                  }}
                  className="inline-flex cursor-pointer items-center gap-1 rounded-[var(--r-md)] px-2 py-1 text-ink-primary hover:bg-surface-hover [&_svg]:h-4 [&_svg]:w-4"
                >
                  {MONTH_FULL[cursor.m - 1]} {cursor.y}
                  <Icon name="chevronDown" />
                </button>
              ) : (
                <span className="px-2 py-1 text-ink-primary">{mode === 'days' ? `Go to a month in ${jumpYear}` : cursorYear}</span>
              )}
              <div className="flex items-center">
                {mode === 'months' && (
                  <button
                    type="button"
                    disabled={!yearSpan(cursorYear)}
                    onClick={() => preset(yearSpan(cursorYear))}
                    className={`mr-1 h-8 cursor-pointer rounded-[var(--r-md)] px-2.5 hover:bg-brand-blue-50 disabled:cursor-not-allowed disabled:opacity-40 ${
                      wholeYear === cursorYear ? 'text-brand-violet' : 'text-brand-blue'
                    }`}
                  >
                    All of {cursorYear}
                  </button>
                )}
                {mode === 'days' && jumping && (
                  <button type="button" onClick={() => setJumping(false)} className="mr-1 h-8 cursor-pointer rounded-[var(--r-md)] px-2.5 text-brand-blue hover:bg-brand-blue-50">
                    Back
                  </button>
                )}
                <RoundButton
                  label={mode === 'days' && !jumping ? 'Previous month' : 'Previous year'}
                  icon="chevronLeft"
                  disabled={mode === 'days' && !jumping ? !canPrevMonth : gridYear <= gridYears[0]}
                  onClick={() => (mode === 'days' && !jumping ? stepMonth(-1) : mode === 'days' ? setJumpYear(jumpYear - 1) : setCursorYear(cursorYear - 1))}
                />
                <RoundButton
                  label={mode === 'days' && !jumping ? 'Next month' : 'Next year'}
                  icon="chevronRight"
                  disabled={mode === 'days' && !jumping ? !canNextMonth : gridYear >= gridYears[gridYears.length - 1]}
                  onClick={() => (mode === 'days' && !jumping ? stepMonth(1) : mode === 'days' ? setJumpYear(jumpYear + 1) : setCursorYear(cursorYear + 1))}
                />
              </div>
            </div>

            {/* BODY: days, the jump grid, or months. One fixed height. */}
            <div className="min-h-0 flex-1 overflow-y-auto px-3 pb-2 pt-1" onMouseLeave={() => setHover(null)}>
              <div className="h-[272px]">
                {mode === 'months' || jumping ? (
                  <div className="grid grid-cols-3 gap-2 pt-3">
                    {MONTH_ABBR.map((name, i) => {
                      const span = monthSpan(gridYear, i + 1)
                      const hasData = mode === 'months' ? !!span : dayMonthHasData(gridYear, i + 1)
                      const on = mode === 'months' && !!span && span.to >= shown.from && span.from <= shown.to
                      const edge = on && !!span && (span.from === shown.from || span.to === shown.to)
                      const here = jumping && gridYear === cursor.y && i + 1 === cursor.m
                      return (
                        <button
                          key={name}
                          type="button"
                          disabled={!hasData}
                          title={hasData ? `${MONTH_FULL[i]} ${gridYear}` : 'No data'}
                          onMouseEnter={() => mode === 'months' && pending !== 'new' && span && setHover(span)}
                          onClick={() => {
                            if (jumping) {
                              setCursor({ y: gridYear, m: i + 1 })
                              setJumping(false)
                            } else if (span) choose(span)
                          }}
                          className={`h-11 cursor-pointer rounded-[var(--r-pill)] transition-colors disabled:cursor-not-allowed disabled:text-ink-disabled ${
                            edge
                              ? 'bg-brand-violet text-white'
                              : on
                                ? 'bg-brand-blue-50 text-brand-violet hover:bg-brand-blue/15'
                                : here
                                  ? 'bg-brand-violet text-white'
                                  : 'text-ink-primary hover:bg-surface-hover'
                          }`}
                        >
                          {name}
                        </button>
                      )
                    })}
                  </div>
                ) : (
                  <MonthGrid
                    year={cursor.y}
                    month={cursor.m}
                    minDay={minDay}
                    maxDay={maxDay}
                    from={shown.from}
                    to={shown.to}
                    onPick={(iso) => choose({ from: iso, to: iso })}
                    onHover={(iso) => pending !== 'new' && setHover({ from: iso, to: iso })}
                  />
                )}
              </div>
            </div>

            {/* FOOTER */}
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
                <span />
              )}
              <div className="flex shrink-0 items-center gap-2">
                <TextButton onClick={() => setOpen(false)}>Cancel</TextButton>
                <TextButton
                  strong
                  disabled={incomplete || !range.from || !range.to}
                  title={incomplete ? 'Click the end date first' : undefined}
                  onClick={() => {
                    onApply(weekOf(range.from, spans).key, weekOf(range.to, spans).key)
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

/** An end of the period in the header: big text, underlined in blue while it
 *  is the one the next click will set. */
function EdgeButton({ text, placeholder, active, onClick, label }: { text: string; placeholder?: string; active: boolean; onClick: () => void; label: string }) {
  return (
    <button
      type="button"
      onClick={onClick}
      title={`Change the ${label}`}
      className={`cursor-pointer border-b-2 pb-0.5 text-xl font-normal transition-colors ${
        active ? 'border-brand-blue text-brand-blue' : 'border-transparent text-ink-primary hover:border-border-strong'
      }`}
    >
      {text || <span className="text-ink-muted">{placeholder ?? 'End'}</span>}
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
              title={out ? 'No data for this day' : fmtDay(iso)}
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
