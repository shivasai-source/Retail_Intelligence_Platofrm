import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { Button, Dropdown } from '../../components/ui'
import { Icon } from '../../icons'
import { isCustomRange, useMmmView } from '../store'
import type { MmmFilterOptions } from '../types'
import { MmmCurrencyToggle } from './MmmToolbar'

/** THE MMM INSIGHTS HUB FILTER BAR — kept short, by request: Year,
 *  Quarter and Month pills, a Date range button that opens the custom
 *  From / To panel, and the ₹ INR / $ USD switch. (Channel, Week, Promotion
 *  Type and Event Day were removed as clutter on 2026-10-07; the page's scope
 *  ignores them — see MmmInsights.)
 *
 *  A CUSTOM RANGE REPLACES THE CALENDAR. While From or To is set, the Year
 *  pill reads "Custom range" and Quarter and Month rest; picking any of the
 *  three ends the range. A month outside the picked quarter is cleared. */

const QUARTER_OF_MONTH = (m: number) => Math.ceil(m / 3)

/** A pill dropdown over a numeric period, "All …" clearing it. */
function PeriodPill({
  allLabel,
  value,
  options,
  onChange,
  muted,
}: {
  allLabel: string
  value: number | null
  options: Array<{ code: number; name: string }>
  onChange: (value: number | null) => void
  /** Shown as "All …" while a custom range overrides it. */
  muted: boolean
}) {
  const selected = muted || value === null ? allLabel : (options.find((o) => o.code === value)?.name ?? allLabel)
  return (
    <Dropdown
      selected={selected}
      options={[{ label: allLabel }, ...options.map((o) => ({ label: o.name }))]}
      onSelect={(picked) => onChange(picked === allLabel ? null : (options.find((o) => o.name === picked)?.code ?? null))}
      trigger={
        <Button variant="secondary" size="pill" className={`cursor-pointer ${muted ? 'opacity-60' : ''}`}>
          <Icon name="filter" />
          <span>{selected}</span>
          <Icon name="chevronDown" />
        </Button>
      }
    />
  )
}

const ALL_YEARS = 'All Years'
const PANEL_MAX_W = 460
const PANEL_GUTTER = 16

/** Placed by measurement against <main>, as TPO's panel is: as wide as the
 *  page allows, aligned to the button when that fits, never off either edge. */
function usePanelPlacement(open: boolean) {
  const anchorRef = useRef<HTMLDivElement>(null)
  const [place, setPlace] = useState<{ left: number; width: number } | null>(null)
  useLayoutEffect(() => {
    if (!open) {
      setPlace(null)
      return
    }
    const anchor = anchorRef.current
    const main = anchor?.closest('main')
    if (!anchor || !main) return
    const measure = () => {
      const a = anchor.getBoundingClientRect()
      const m = main.getBoundingClientRect()
      const minX = m.left + PANEL_GUTTER
      const maxX = m.right - PANEL_GUTTER
      const width = Math.min(PANEL_MAX_W, maxX - minX)
      const x = Math.max(minX, Math.min(a.left, maxX - width))
      setPlace({ left: x - a.left, width })
    }
    measure()
    const ro = new ResizeObserver(measure)
    ro.observe(main)
    window.addEventListener('resize', measure)
    return () => {
      ro.disconnect()
      window.removeEventListener('resize', measure)
    }
  }, [open])
  return { anchorRef, place }
}

/** A native date input in the panel's control size. Native, so the keyboard,
 *  the calendar popup and the locale come from the platform. */
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

export function MmmFilterBar({ options, year }: { options: MmmFilterOptions | undefined; year: number | null }) {
  const view = useMmmView()
  const expanded = view.expanded
  const toggleExpanded = view.toggleExpanded
  const { anchorRef, place } = usePanelPlacement(expanded)
  const custom = isCustomRange(view)

  useEffect(() => {
    if (!expanded) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') toggleExpanded()
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [expanded, toggleExpanded])

  if (!options) return null

  const yearLabel = custom ? 'Custom range' : year === null ? ALL_YEARS : String(year)
  const sortedYears = [...options.years].sort((a, b) => b - a)
  const { from: minDate, to: maxDate } = options.date_range
  const clearRange = () => {
    view.set('dateFrom', null)
    view.set('dateTo', null)
  }

  return (
    <div className="flex flex-nowrap items-center gap-x-1.5 gap-y-2 @max-[1080px]:flex-wrap" role="group" aria-label="MMM Insights Hub filters">
      <Dropdown
        selected={yearLabel}
        options={[{ label: ALL_YEARS }, ...sortedYears.map((y) => ({ label: String(y) }))]}
        onSelect={(picked) => {
          // Picking a year ends a custom range.
          clearRange()
          view.setYear(picked === ALL_YEARS ? null : Number(picked))
        }}
        trigger={
          <Button variant="secondary" size="pill" className="cursor-pointer">
            <Icon name={custom ? 'calendar' : 'filter'} />
            <span>{yearLabel}</span>
            <Icon name="chevronDown" />
          </Button>
        }
      />

      <PeriodPill
        allLabel="All Quarters"
        value={view.quarter}
        options={options.quarters}
        muted={custom}
        onChange={(q) => {
          clearRange()
          view.set('quarter', q)
          // A month outside the new quarter would select nothing.
          if (q !== null && view.month !== null && QUARTER_OF_MONTH(view.month) !== q) view.set('month', null)
        }}
      />
      <PeriodPill
        allLabel="All Months"
        value={view.month}
        options={view.quarter && !custom ? options.months.filter((m) => QUARTER_OF_MONTH(m.code) === view.quarter) : options.months}
        muted={custom}
        onChange={(m) => {
          clearRange()
          view.set('month', m)
        }}
      />

      <div ref={anchorRef} className="relative">
        <Button
          variant={view.expanded || custom ? 'primary' : 'secondary'}
          size="pill"
          className="cursor-pointer"
          onClick={view.toggleExpanded}
          aria-expanded={view.expanded}
          aria-controls={view.expanded ? 'mmm-date-range' : undefined}
        >
          <Icon name="calendar" />
          <span>{custom ? `${fmtIso(view.dateFrom ?? minDate)} – ${fmtIso(view.dateTo ?? maxDate)}` : 'Date range'}</span>
          <Icon name="chevronDown" className={view.expanded ? 'rotate-180 transition-transform' : 'transition-transform'} />
        </Button>
        {view.expanded && (
          <div
            id="mmm-date-range"
            role="region"
            aria-label="Custom date range"
            style={place ? { left: place.left, width: Math.min(place.width, 460) } : { visibility: 'hidden' }}
            className="panel-enter cc-filter-surface absolute top-full z-30 mt-2 rounded-[var(--r-lg)] border border-border-subtle p-4 shadow-[var(--shadow-lg)]"
          >
            <div className="mb-3 flex items-center justify-between gap-3">
              <span className="text-base font-bold text-ink-primary">Custom date range</span>
              {custom && (
                <Button variant="ghost" size="sm" className="cursor-pointer !text-brand-violet" onClick={clearRange}>
                  <Icon name="x" />
                  Clear range
                </Button>
              )}
            </div>
            <div className="grid grid-cols-2 gap-2 @max-[640px]:grid-cols-1">
              <DateField label="From" value={view.dateFrom} min={minDate} max={view.dateTo ?? maxDate}
                onChange={(v) => view.set('dateFrom', v)} />
              <DateField label="To" value={view.dateTo} min={view.dateFrom ?? minDate} max={maxDate}
                onChange={(v) => view.set('dateTo', v)} />
            </div>
            <p className="mt-2 text-xs leading-[1.5] text-ink-muted">
              Replaces the year, quarter and month. Data runs from {fmtIso(minDate)} to {fmtIso(maxDate)}.
            </p>
          </div>
        )}
      </div>

      <MmmCurrencyToggle />
    </div>
  )
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

/** "2015-01-01" -> "01 Jan 2015", the backend's own date style. */
function fmtIso(iso: string): string {
  const [y, m, d] = iso.split('-')
  return `${d} ${MONTHS[Number(m) - 1]} ${y}`
}
