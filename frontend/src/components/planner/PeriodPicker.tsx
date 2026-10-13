import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { Icon } from '../../icons'
import { Segmented, StudioButton as Button, TYPE } from './shared'
import type { PlannerOptions } from '../../types/planner'

/** The period: a date range, picked the way a booking calendar picks one.
 *
 *  LEFT, QUICK RANGES -- each year in the data, the last 4 / 13 / 26 / 52
 *  weeks, everything. TOP, THE RANGE ITSELF -- a start date and an end date,
 *  typed or picked. BELOW, FOUR WAYS TO PICK IT:
 *
 *    Range   two months of days side by side: click the first day, then the
 *            last; the days between light up as the pointer moves.
 *    Week    the year's business weeks.     \
 *    Month   the year's months.              > click where it starts, then
 *    Year    every year in the data.        /  where it ends.
 *
 *  Year and Month drill down: the arrow on a year opens its months, the arrow
 *  on a month opens its weeks. Days outside the data are greyed out.
 *
 *  THE PLANNER WORKS IN BUSINESS WEEKS. Whatever is picked, the range is the
 *  weeks that contain the start and end dates -- the footer says which, and
 *  that is what "Apply" hands on. */

type View = 'range' | 'week' | 'month' | 'year'
type WeekKey = [number, number]

const MONTH_ABBR = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
const MONTH_FULL = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December']
const DOW = ['Mo', 'Tu', 'We', 'Th', 'Fr', 'Sa', 'Su']
const PANEL_W = 860

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
  const startOf = (k: WeekKey) => calendar.find((y) => y.year === k[0])?.weeks.find((w) => w.week === k[1])
  const a = startOf(start)
  const b = startOf(end)
  return a && b ? `${fmtDay(a.start)} – ${fmtDay(b.start)}` : `${start[0]}-W${start[1]} – ${end[0]}-W${end[1]}`
}

export function weeksBetween(start: WeekKey, end: WeekKey, calendar: PlannerOptions['calendar']): number {
  let n = 0
  for (const y of calendar) for (const w of y.weeks) if (cmp([y.year, w.week], start) >= 0 && cmp([y.year, w.week], end) <= 0) n++
  return n
}

interface Cell {
  key: string
  label: string
  sub: string
  from: string
  to: string
  empty: boolean
  /** Drill-down target: a year opens its months, a month its weeks. */
  drill?: { view: View; year: number; month?: number }
}

export function PeriodPicker({
  calendar,
  start,
  end,
  onApply,
  locked,
}: {
  calendar: PlannerOptions['calendar']
  start: WeekKey
  end: WeekKey
  onApply: (start: WeekKey, end: WeekKey) => void
  /** A promotion focus fixes the period to its month. */
  locked?: string
}) {
  const spans = useMemo(() => weekSpans(calendar), [calendar])
  const minDay = spans[0]?.start ?? ''
  const maxDay = spans[spans.length - 1]?.end ?? ''
  const spanOf = (k: WeekKey) => spans.find((s) => cmp(s.key, k) === 0)

  const [open, setOpen] = useState(false)
  const [view, setView] = useState<View>('range')
  const [range, setRange] = useState<{ from: string; to: string }>({ from: '', to: '' })
  const [pending, setPending] = useState<string | null>(null) // first click of a range, awaiting the second
  const [hover, setHover] = useState<string | null>(null)
  const [monthView, setMonthView] = useState<{ y: number; m: number }>({ y: start[0], m: 1 })
  const [yearView, setYearView] = useState(start[0])
  const [monthFilter, setMonthFilter] = useState<number | null>(null)
  const anchorRef = useRef<HTMLSpanElement>(null)
  const panelRef = useRef<HTMLDivElement>(null)
  const [place, setPlace] = useState({ left: 0, top: 0 })

  useEffect(() => {
    if (!open) return
    const a = spanOf(start)
    const b = spanOf(end)
    const from = a?.start ?? minDay
    const to = b?.end ?? maxDay
    setRange({ from, to })
    setPending(null)
    setMonthFilter(null)
    setYearView(Number(to.slice(0, 4)))
    // Show the months the range ends in: the end month on the right.
    const ey = Number(to.slice(0, 4))
    const em = Number(to.slice(5, 7))
    setMonthView(em === 1 ? { y: ey - 1, m: 12 } : { y: ey, m: em - 1 })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open])

  useLayoutEffect(() => {
    if (!open || !anchorRef.current) return
    const r = anchorRef.current.getBoundingClientRect()
    setPlace({ left: Math.max(8, Math.min(r.left, window.innerWidth - PANEL_W - 8)), top: r.bottom + 6 })
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

  // --- the chosen range, as days and as the business weeks that hold them ------
  const shown = pending ? { from: pending < (hover ?? pending) ? pending : hover ?? pending, to: pending < (hover ?? pending) ? hover ?? pending : pending } : range
  const fromWeek = range.from ? weekOf(range.from, spans) : null
  const toWeek = range.to ? weekOf(range.to, spans) : null
  const nWeeks = fromWeek && toWeek ? weeksBetween(fromWeek.key, toWeek.key, calendar) : 0

  const setOrdered = (a: string, b: string) => setRange(a <= b ? { from: a, to: b } : { from: b, to: a })
  const clampDay = (iso: string) => (iso < minDay ? minDay : iso > maxDay ? maxDay : iso)

  const pickDay = (iso: string) => {
    if (!pending) {
      setPending(iso)
      setRange({ from: iso, to: iso })
      return
    }
    setOrdered(pending, iso)
    setPending(null)
  }

  // Week / month / year cells pick the same way: first click, second click.
  const pickCell = (c: Cell) => {
    if (c.empty) return
    if (!pending) {
      setPending(c.from)
      setRange({ from: c.from, to: c.to })
      return
    }
    const lo = pending < c.from ? pending : c.from
    const firstCell = cells.find((x) => x.from === pending)
    const hi = [c.to, firstCell?.to ?? c.to].sort()[1]
    setRange({ from: lo, to: hi })
    setPending(null)
  }

  // --- presets, from the data's own extent -------------------------------------
  const years = calendar.filter((y) => y.weeks.length).map((y) => y.year)
  const lastN = (n: number) => ({ from: spans[Math.max(0, spans.length - n)].start, to: maxDay })
  const presets: { label: string; range: { from: string; to: string } }[] = spans.length
    ? [
        ...[...years].reverse().map((y) => {
          const ws = spans.filter((s) => s.key[0] === y)
          return { label: ws.length < 50 ? `${y} so far` : `Year ${y}`, range: { from: ws[0].start, to: ws[ws.length - 1].end } }
        }),
        { label: 'Last 4 weeks', range: lastN(4) },
        { label: 'Last 13 weeks', range: lastN(13) },
        { label: 'Last 26 weeks', range: lastN(26) },
        { label: 'Last 52 weeks', range: lastN(52) },
        { label: 'Everything', range: { from: minDay, to: maxDay } },
      ]
    : []

  // --- week / month / year cells -----------------------------------------------
  const cells: Cell[] = useMemo(() => {
    const out: Cell[] = []
    if (view === 'year') {
      for (const y of years) {
        const ws = spans.filter((s) => s.key[0] === y)
        out.push({ key: `${y}`, label: String(y), sub: `${ws.length} weeks`, from: ws[0].start, to: ws[ws.length - 1].end, empty: false, drill: { view: 'month', year: y } })
      }
    } else if (view === 'month') {
      for (let m = 1; m <= 12; m++) {
        const ws = spans.filter((s) => s.key[0] === yearView && s.month === m)
        out.push({
          key: `${yearView}-${m}`, label: MONTH_ABBR[m - 1], sub: ws.length ? `${ws.length} weeks` : 'no data',
          from: ws[0]?.start ?? '', to: ws[ws.length - 1]?.end ?? '', empty: !ws.length,
          drill: ws.length ? { view: 'week', year: yearView, month: m } : undefined,
        })
      }
    } else if (view === 'week') {
      for (const s of spans.filter((x) => x.key[0] === yearView && (monthFilter == null || x.month === monthFilter))) {
        out.push({ key: `${s.key[0]}-${s.key[1]}`, label: `W${String(s.key[1]).padStart(2, '0')}`, sub: fmtDay(s.start).slice(0, -5), from: s.start, to: s.end, empty: false })
      }
    }
    return out
  }, [view, years, spans, yearView, monthFilter])

  const cellOn = (c: Cell) => !c.empty && c.to >= shown.from && c.from <= shown.to
  const cellEdge = (c: Cell) => !c.empty && (c.from === range.from || c.to === range.to) && !pending

  const triggerLabel = periodLabel(start, end, calendar)
  const triggerWeeks = weeksBetween(start, end, calendar)

  return (
    <>
      <span ref={anchorRef}>
        <button
          type="button"
          onClick={() => !locked && setOpen((v) => !v)}
          title={locked ?? 'Choose the period to plan'}
          aria-haspopup="dialog"
          aria-expanded={open}
          className={`inline-flex h-10 cursor-pointer items-center gap-2 rounded-[var(--r-md)] border px-3 text-[14px] transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-violet [&_svg]:h-4 [&_svg]:w-4 ${
            open ? 'border-brand-violet/50 bg-brand-violet-50 text-brand-violet' : 'border-border-default bg-surface-card text-ink-secondary hover:border-border-strong hover:bg-surface-hover'
          } ${locked ? 'cursor-default' : ''}`}
        >
          <Icon name="calendar" />
          <span className="font-semibold">Period</span>
          <span className="font-semibold text-ink-primary">{triggerLabel}</span>
          <span className="rounded-[var(--r-sm)] bg-brand-violet-50 px-1.5 py-0.5 text-[14px] font-semibold text-brand-violet">{triggerWeeks} wk</span>
          {locked ? <Icon name="lock" /> : <Icon name="chevronDown" />}
        </button>
      </span>
      {open &&
        createPortal(
          <div
            ref={panelRef}
            role="dialog"
            aria-label="Choose the period"
            className="dd-enter fixed z-[9999] flex overflow-hidden rounded-[var(--r-lg)] border border-border-default bg-surface-card font-semibold shadow-[var(--shadow-lg)]"
            style={{ left: place.left, top: place.top, width: PANEL_W, maxWidth: 'calc(100vw - 16px)' }}
          >
            {/* QUICK RANGES */}
            <div className="w-[176px] shrink-0 border-r border-border-subtle bg-surface-muted/60 p-3">
              <div className={`px-2 pb-2 ${TYPE.eyebrow}`}>Quick ranges</div>
              <div className="flex flex-col gap-0.5">
                {presets.map((p) => {
                  const on = p.range.from === range.from && p.range.to === range.to && !pending
                  return (
                    <button
                      key={p.label}
                      type="button"
                      onClick={() => {
                        setRange(p.range)
                        setPending(null)
                        setYearView(Number(p.range.to.slice(0, 4)))
                        const ey = Number(p.range.to.slice(0, 4))
                        const em = Number(p.range.to.slice(5, 7))
                        setMonthView(em === 1 ? { y: ey - 1, m: 12 } : { y: ey, m: em - 1 })
                      }}
                      className={`flex cursor-pointer items-center justify-between rounded-[var(--r-md)] px-2.5 py-2 text-left text-[14px] transition-colors [&_svg]:h-4 [&_svg]:w-4 ${
                        on ? 'bg-brand-violet text-white' : 'text-ink-secondary hover:bg-surface-card hover:text-ink-primary'
                      }`}
                    >
                      {p.label}
                      {on && <Icon name="check" />}
                    </button>
                  )
                })}
              </div>
            </div>

            <div className="flex min-w-0 flex-1 flex-col">
              {/* THE RANGE: start and end dates, typed or picked */}
              <div className="flex flex-wrap items-end justify-between gap-3 border-b border-border-subtle px-5 py-4">
                <div className="flex items-end gap-2">
                  <DateField label="Start date" value={range.from} min={minDay} max={maxDay} active={!!pending} onChange={(v) => setOrdered(clampDay(v), range.to)} />
                  <span className="mb-2.5 text-ink-muted [&_svg]:h-4 [&_svg]:w-4">
                    <Icon name="arrowRight" />
                  </span>
                  <DateField label="End date" value={range.to} min={minDay} max={maxDay} onChange={(v) => setOrdered(range.from, clampDay(v))} />
                </div>
                <Segmented
                  label="Pick by"
                  value={view}
                  onChange={(v) => {
                    setView(v)
                    setPending(null)
                    setMonthFilter(null)
                  }}
                  options={[
                    { value: 'range', label: 'Range' },
                    { value: 'week', label: 'Week' },
                    { value: 'month', label: 'Month' },
                    { value: 'year', label: 'Year' },
                  ]}
                />
              </div>

              {/* THE PICKER */}
              <div className="min-h-[330px] px-5 py-4" onMouseLeave={() => setHover(null)}>
                {view === 'range' ? (
                  <div className="grid grid-cols-2 gap-6">
                    {[0, 1].map((k) => {
                      const y = monthView.m + k > 12 ? monthView.y + 1 : monthView.y
                      const m = ((monthView.m + k - 1) % 12) + 1
                      return (
                        <MonthGrid
                          key={`${y}-${m}`}
                          year={y}
                          month={m}
                          minDay={minDay}
                          maxDay={maxDay}
                          from={shown.from}
                          to={shown.to}
                          pending={!!pending}
                          onPick={pickDay}
                          onHover={setHover}
                          onPrev={k === 0 ? () => setMonthView(monthView.m === 1 ? { y: monthView.y - 1, m: 12 } : { y: monthView.y, m: monthView.m - 1 }) : undefined}
                          onNext={k === 1 ? () => setMonthView(monthView.m === 12 ? { y: monthView.y + 1, m: 1 } : { y: monthView.y, m: monthView.m + 1 }) : undefined}
                          prevDisabled={`${y}-${String(m).padStart(2, '0')}-01` <= minDay}
                          nextDisabled={`${y}-${String(m).padStart(2, '0')}-31` >= maxDay}
                        />
                      )
                    })}
                  </div>
                ) : (
                  <>
                    {view !== 'year' && (
                      <div className="mb-3 flex items-center justify-between">
                        <NavButton dir="left" disabled={years.indexOf(yearView) <= 0} onClick={() => setYearView(years[years.indexOf(yearView) - 1])} />
                        <span className="text-[15px] text-ink-primary">
                          {view === 'week' && monthFilter ? `${MONTH_FULL[monthFilter - 1]} ${yearView}` : yearView}
                          {view === 'week' && monthFilter && (
                            <button type="button" onClick={() => setMonthFilter(null)} className="ml-2 cursor-pointer text-[14px] text-brand-violet hover:underline">
                              All weeks of {yearView}
                            </button>
                          )}
                        </span>
                        <NavButton dir="right" disabled={years.indexOf(yearView) >= years.length - 1} onClick={() => setYearView(years[years.indexOf(yearView) + 1])} />
                      </div>
                    )}
                    <div
                      className={`grid gap-2 ${view === 'year' ? 'grid-cols-3' : view === 'month' ? 'grid-cols-4' : 'grid-cols-6'} ${view === 'week' ? 'max-h-[270px] overflow-y-auto pr-1' : ''}`}
                    >
                      {cells.map((c) => {
                        const on = cellOn(c)
                        const edge = cellEdge(c) || pending === c.from
                        return (
                          <div
                            key={c.key}
                            onMouseEnter={() => !c.empty && setHover(c.to)}
                            className={`group relative flex flex-col items-center rounded-[var(--r-md)] border px-2 transition-colors ${view === 'week' ? 'py-1.5' : 'py-3'} ${
                              c.empty
                                ? 'border-border-subtle text-ink-muted opacity-50'
                                : edge
                                  ? 'border-brand-violet bg-brand-violet text-white'
                                  : on
                                    ? 'border-brand-violet/30 bg-brand-violet/10 text-brand-violet'
                                    : 'border-border-subtle text-ink-primary hover:border-brand-violet/40 hover:bg-surface-hover'
                            }`}
                          >
                            <button type="button" disabled={c.empty} onClick={() => pickCell(c)} className="flex w-full cursor-pointer flex-col items-center disabled:cursor-not-allowed">
                              <span className={view === 'week' ? 'text-[14px]' : 'text-[15px]'}>{c.label}</span>
                              <span className={`text-[13px] ${edge ? 'text-white/80' : 'text-ink-muted'}`}>{c.sub}</span>
                            </button>
                            {c.drill && (
                              <button
                                type="button"
                                title={c.drill.view === 'month' ? `Open the months of ${c.label}` : `Open the weeks of ${c.label}`}
                                onClick={() => {
                                  setView(c.drill!.view)
                                  setYearView(c.drill!.year)
                                  setMonthFilter(c.drill!.month ?? null)
                                  setPending(null)
                                }}
                                className={`absolute right-1 top-1 grid h-6 w-6 cursor-pointer place-items-center rounded-full opacity-70 hover:opacity-100 [&_svg]:h-3.5 [&_svg]:w-3.5 ${
                                  edge ? 'text-white hover:bg-white/20' : 'text-ink-muted hover:bg-brand-violet/10 hover:text-brand-violet'
                                }`}
                              >
                                <Icon name="chevronRight" />
                              </button>
                            )}
                          </div>
                        )
                      })}
                    </div>
                  </>
                )}
                <div className={`mt-3 ${TYPE.label} !text-ink-muted`}>
                  {pending
                    ? 'Now click where the period ends.'
                    : view === 'range'
                      ? 'Click the first day, then the last day.'
                      : view === 'week'
                        ? 'Click the first week, then the last week.'
                        : `Click the first ${view}, then the last. The arrow opens a ${view === 'year' ? 'year’s months' : 'month’s weeks'}.`}
                </div>
              </div>

              {/* WHAT WILL BE PLANNED */}
              <div className="flex flex-wrap items-center justify-between gap-3 border-t border-border-subtle bg-surface-muted/40 px-5 py-3">
                <div className="min-w-0 text-[14px]">
                  {fromWeek && toWeek ? (
                    <>
                      <div className="text-ink-primary">
                        {fmtDay(range.from)} – {fmtDay(range.to)}
                      </div>
                      <div className="text-ink-muted">
                        Plans W{String(fromWeek.key[1]).padStart(2, '0')} {fromWeek.key[0]} – W{String(toWeek.key[1]).padStart(2, '0')} {toWeek.key[0]} ·{' '}
                        <span className="text-brand-violet">{nWeeks} business weeks</span>
                      </div>
                    </>
                  ) : (
                    <span className="text-ink-muted">Pick a start and an end</span>
                  )}
                </div>
                <div className="flex items-center gap-2">
                  <Button variant="ghost" onClick={() => setOpen(false)}>
                    Cancel
                  </Button>
                  <Button
                    variant="primary"
                    disabled={!!pending || !fromWeek || !toWeek}
                    onClick={() => {
                      if (fromWeek && toWeek) onApply(fromWeek.key, toWeek.key)
                      setOpen(false)
                    }}
                  >
                    <Icon name="check" /> Apply
                  </Button>
                </div>
              </div>
            </div>
          </div>,
          document.body,
        )}
    </>
  )
}

function DateField({ label, value, min, max, onChange, active }: { label: string; value: string; min: string; max: string; onChange: (v: string) => void; active?: boolean }) {
  return (
    <label className="flex flex-col gap-1">
      <span className={TYPE.eyebrow}>{label}</span>
      <input
        type="date"
        value={value}
        min={min}
        max={max}
        onChange={(e) => e.target.value && onChange(e.target.value)}
        style={{ outline: 'none' }}
        className={`h-10 w-[168px] rounded-[var(--r-md)] border bg-surface-card px-3 text-[14px] font-semibold text-ink-primary [font-variant-numeric:tabular-nums] focus:border-brand-violet ${
          active ? 'border-brand-violet' : 'border-border-default'
        }`}
      />
    </label>
  )
}

function NavButton({ dir, disabled, onClick }: { dir: 'left' | 'right'; disabled?: boolean; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      aria-label={dir === 'left' ? 'Previous' : 'Next'}
      className="grid h-8 w-8 cursor-pointer place-items-center rounded-full text-ink-secondary hover:bg-surface-hover disabled:cursor-not-allowed disabled:opacity-30 [&_svg]:h-4 [&_svg]:w-4"
    >
      <Icon name={dir === 'left' ? 'chevronLeft' : 'chevronRight'} />
    </button>
  )
}

/** One month of days, Monday first. */
function MonthGrid({
  year,
  month,
  minDay,
  maxDay,
  from,
  to,
  pending,
  onPick,
  onHover,
  onPrev,
  onNext,
  prevDisabled,
  nextDisabled,
}: {
  year: number
  month: number
  minDay: string
  maxDay: string
  from: string
  to: string
  pending: boolean
  onPick: (iso: string) => void
  onHover: (iso: string) => void
  onPrev?: () => void
  onNext?: () => void
  prevDisabled?: boolean
  nextDisabled?: boolean
}) {
  const first = `${year}-${String(month).padStart(2, '0')}-01`
  const lead = (toDate(first).getUTCDay() + 6) % 7
  const days = new Date(Date.UTC(year, month, 0)).getUTCDate()
  const slots: (string | null)[] = [...Array(lead).fill(null), ...Array.from({ length: days }, (_, i) => addDays(first, i))]
  return (
    <div>
      <div className="mb-2 flex h-8 items-center justify-between">
        {onPrev ? <NavButton dir="left" disabled={prevDisabled} onClick={onPrev} /> : <span className="w-8" />}
        <span className="text-[15px] text-ink-primary">
          {MONTH_FULL[month - 1]} {year}
        </span>
        {onNext ? <NavButton dir="right" disabled={nextDisabled} onClick={onNext} /> : <span className="w-8" />}
      </div>
      <div className="grid grid-cols-7 text-center">
        {DOW.map((d) => (
          <span key={d} className="pb-1 text-[13px] text-ink-muted">
            {d}
          </span>
        ))}
        {slots.map((iso, i) => {
          if (!iso) return <span key={`b${i}`} />
          const out = iso < minDay || iso > maxDay
          const inRange = from && to && iso >= from && iso <= to
          const edge = iso === from || iso === to
          return (
            <span
              key={iso}
              className={`py-0.5 ${inRange && !out ? 'bg-brand-violet/10' : ''} ${iso === from ? 'rounded-l-full' : ''} ${iso === to ? 'rounded-r-full' : ''}`}
            >
              <button
                type="button"
                disabled={out}
                onClick={() => onPick(iso)}
                onMouseEnter={() => onHover(iso)}
                className={`mx-auto grid h-9 w-9 cursor-pointer place-items-center rounded-full text-[14px] [font-variant-numeric:tabular-nums] transition-colors disabled:cursor-not-allowed ${
                  out
                    ? 'text-ink-muted opacity-35'
                    : edge
                      ? 'bg-brand-violet text-white'
                      : inRange
                        ? 'text-brand-violet hover:bg-brand-violet/20'
                        : `text-ink-primary hover:bg-surface-hover ${pending ? 'hover:ring-1 hover:ring-brand-violet' : ''}`
                }`}
              >
                {Number(iso.slice(8, 10))}
              </button>
            </span>
          )
        })}
      </div>
    </div>
  )
}
