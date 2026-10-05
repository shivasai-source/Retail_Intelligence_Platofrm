import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { Button, Dropdown } from '../../components/ui'
import { MultiSelect, SelectionChips, type MultiOption } from '../../components/command/MultiSelect'
import { Icon } from '../../icons'
import { isCustomRange, useMmmView, type MmmListKey } from '../store'
import type { MmmFilterOptions } from '../types'
import { MmmCurrencyToggle } from './MmmToolbar'

/** THE MMM INSIGHTS HUB FILTER BAR, built the way TPO's is
 *  (components/command/FilterBar.tsx): the Year pill and the Channel
 *  multi-select on the bar, everything else in the More Filters panel beneath
 *  it, and the ₹ INR / $ USD switch at the end. Same Button sizes, the same
 *  MultiSelect and chips, the same panel surface. State is ../store.ts, shared
 *  with every MMM page.
 *
 *  A CUSTOM RANGE REPLACES THE CALENDAR FILTERS. While From or To is set, the
 *  Year pill reads "Custom range" and Quarter, Month and Week are disabled. A
 *  range that also obeyed them could select nothing and would not say why. */

const ALL_YEARS = 'All Years'
const PANEL_MAX_W = 680
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

/** Single-select over a numeric dimension; "All …" clears it. */
function NumberSelect({
  allLabel,
  value,
  options,
  onChange,
  disabled = false,
}: {
  allLabel: string
  value: number | null
  options: Array<{ code: number; name: string }>
  onChange: (value: number | null) => void
  disabled?: boolean
}) {
  const selected = value === null ? allLabel : (options.find((o) => o.code === value)?.name ?? String(value))
  const trigger = (
    <Button variant="secondary" size="sm" className="w-full cursor-pointer justify-between" disabled={disabled}>
      <Icon name="filter" />
      <span className="flex-1 truncate text-left">{selected}</span>
      <Icon name="chevronDown" />
    </Button>
  )
  if (disabled) return trigger
  return (
    <Dropdown
      selected={selected}
      options={[{ label: allLabel }, ...options.map((o) => ({ label: o.name }))]}
      onSelect={(picked) => onChange(picked === allLabel ? null : (options.find((o) => o.name === picked)?.code ?? null))}
      trigger={trigger}
    />
  )
}

/** Multi-select over a list dimension, chips in the trigger, as TPO's
 *  FilterMulti draws them. */
function ListSelect({
  label,
  allLabel,
  dimension,
  options,
  size = 'sm',
}: {
  label: string
  allLabel: string
  dimension: MmmListKey
  options: MultiOption[]
  size?: 'sm' | 'pill'
}) {
  const selected = useMmmView((s) => s[dimension])
  const toggle = useMmmView((s) => s.toggle)
  const set = useMmmView((s) => s.set)
  return (
    <MultiSelect
      label={label}
      options={options}
      selected={selected}
      allLabel={allLabel}
      onToggle={(code) => toggle(dimension, code)}
      onClear={() => set(dimension, [])}
      trigger={
        <Button
          variant="secondary"
          size={size}
          className={`cursor-pointer ${size === 'sm' ? 'w-full justify-between' : ''}`}
        >
          <Icon name="filter" />
          {selected.length === 0 ? (
            <span className={size === 'sm' ? 'flex-1 truncate text-left' : ''}>{allLabel}</span>
          ) : (
            <SelectionChips options={options} selected={selected} onRemove={(code) => toggle(dimension, code)} />
          )}
          <Icon name="chevronDown" />
        </Button>
      }
    />
  )
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
    // Escape only: the menus inside portal to <body>, so a click-outside
    // handler would close the panel under a selection being made (as TPO's).
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') toggleExpanded()
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [expanded, toggleExpanded])

  if (!options) return null

  const yearLabel = custom ? 'Custom range' : year === null ? ALL_YEARS : String(year)
  const sortedYears = [...options.years].sort((a, b) => b - a)
  const channels: MultiOption[] = options.channels.map((c) => ({ code: c.code, name: c.name }))
  const activeCount = [
    view.quarter, view.month, view.week, view.dateFrom ?? view.dateTo,
  ].filter((v) => v !== null).length
    + (view.promotionTypes.length > 0 ? 1 : 0)
    + (view.events.length > 0 ? 1 : 0)
  const { from: minDate, to: maxDate } = options.date_range

  return (
    <div className="flex flex-nowrap items-center gap-x-1.5 gap-y-2 @max-[1080px]:flex-wrap" role="group" aria-label="MMM Insights Hub filters">
      <Dropdown
        selected={yearLabel}
        options={[{ label: ALL_YEARS }, ...sortedYears.map((y) => ({ label: String(y) }))]}
        onSelect={(picked) => {
          // Picking a year ends a custom range: the reader has gone back to
          // calendar periods.
          view.set('dateFrom', null)
          view.set('dateTo', null)
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

      <ListSelect label="Channel" allLabel="All Channels" dimension="channels" options={channels} size="pill" />

      <div ref={anchorRef} className="relative">
        <Button
          variant={view.expanded ? 'primary' : 'secondary'}
          size="pill"
          className="cursor-pointer"
          onClick={view.toggleExpanded}
          aria-expanded={view.expanded}
          aria-controls={view.expanded ? 'mmm-more-filters' : undefined}
        >
          <Icon name="filter" />
          <span>More Filters{activeCount > 0 ? ` (${activeCount})` : ''}</span>
          <Icon name="chevronDown" className={view.expanded ? 'rotate-180 transition-transform' : 'transition-transform'} />
        </Button>
        {view.expanded && (
          <div
            id="mmm-more-filters"
            role="region"
            aria-label="Additional filters"
            style={place ? { left: place.left, width: place.width } : { visibility: 'hidden' }}
            className="panel-enter cc-filter-surface absolute top-full z-30 mt-2 max-h-[min(70vh,560px)] overflow-y-auto rounded-[var(--r-lg)] border border-border-subtle p-4 shadow-[var(--shadow-lg)]"
          >
            <div className="mb-3 flex items-center justify-between gap-3">
              <span className="text-base font-bold text-ink-primary">Additional Filters</span>
              <Button variant="ghost" size="sm" className="cursor-pointer !text-brand-violet" onClick={view.reset} aria-label="Clear all filters">
                <Icon name="x" />
                Clear all
              </Button>
            </div>

            <div className="grid grid-cols-[repeat(auto-fill,minmax(180px,1fr))] gap-2 @max-[640px]:grid-cols-1">
              <NumberSelect allLabel="All Quarters" value={view.quarter} options={options.quarters}
                onChange={(v) => view.set('quarter', v)} disabled={custom} />
              <NumberSelect allLabel="All Months" value={view.month} options={options.months}
                onChange={(v) => view.set('month', v)} disabled={custom} />
              <NumberSelect allLabel="All Weeks" value={view.week}
                options={options.weeks.map((w) => ({ code: w, name: `Week ${w}` }))}
                onChange={(v) => view.set('week', v)} disabled={custom} />
              <ListSelect label="Promotion Type" allLabel="All Promotion Types" dimension="promotionTypes"
                options={options.promotion_types.map((p) => ({ code: p, name: p }))} />
              <ListSelect label="Event Day" allLabel="All Days" dimension="events"
                options={options.events.map((e) => ({ code: e.code, name: e.name }))} />
            </div>

            <div className="mt-3 border-t border-border-subtle pt-3">
              <div className="mb-2 flex items-center justify-between gap-3">
                <span className="text-sm font-semibold text-ink-primary">Custom date range</span>
                {custom && (
                  <Button
                    variant="ghost"
                    size="sm"
                    className="cursor-pointer"
                    onClick={() => {
                      view.set('dateFrom', null)
                      view.set('dateTo', null)
                    }}
                  >
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
                A date range replaces Year, Quarter, Month and Week. Data runs from {fmtIso(minDate)} to {fmtIso(maxDate)}.
              </p>
            </div>
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
