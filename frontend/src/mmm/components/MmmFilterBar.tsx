import { useEffect, useState, type ReactNode } from 'react'
import { Button } from '../../components/ui'
import { Icon } from '../../icons'
import { isCustomRange, useMmmView } from '../store'
import type { MmmFilterOptions } from '../types'
import { MmmCurrencyToggle } from './MmmToolbar'

/** THE MMM INSIGHTS HUB TOOLBAR — Year, Quarter and Month pills, a Date range
 *  pill, the ₹ INR / $ USD switch, and whatever page actions are passed in.
 *  (Channel, Week, Promotion Type and Event Day were removed as clutter on
 *  2026-10-07; the page's scope ignores them — see MmmInsights.)
 *
 *  NOTHING HERE OPENS OVER THE KPI CARDS (2026-10-22). Every pill used to
 *  drop a floating menu — a portalled Dropdown for the periods, an absolutely
 *  positioned panel for the range — and the KPI deck starts 14px below the
 *  bar, so an open Quarter menu hid Total Revenue's figure outright and the
 *  range panel covered Total Ad Spend entirely. The reader could not see the
 *  number they were choosing a period for.
 *
 *  So the bar is its own raised surface (`cc-filter-surface`, the one TPO's
 *  More Filters panel is drawn on) and a pill EXPANDS IT: the choices open on
 *  a row inside the strip, under a hairline, and the deck below is pushed
 *  down rather than painted over. One panel at a time — the pills are four
 *  views of one scope, not four independent menus.
 *
 *  A CUSTOM RANGE REPLACES THE CALENDAR. While From or To is set, the Year
 *  pill reads "Custom range" and Quarter and Month rest; picking any of the
 *  three ends the range. A month outside the picked quarter is cleared. */

const QUARTER_OF_MONTH = (m: number) => Math.ceil(m / 3)

const ALL_YEARS = 'All Years'
const ALL_QUARTERS = 'All Quarters'
const ALL_MONTHS = 'All Months'

/** Which set of choices the strip is showing, or none. */
type PanelKey = 'year' | 'quarter' | 'month' | 'range'

const PANEL_TITLE: Record<PanelKey, string> = {
  year: 'Year',
  quarter: 'Quarter',
  month: 'Month',
  range: 'Custom date range',
}

/** A pill on the bar. `open` is the panel it owns being on screen — it wears
 *  the filled variant then, as the Date range button always has. */
function FilterPill({
  icon,
  label,
  open,
  muted,
  onClick,
}: {
  icon: 'filter' | 'calendar'
  label: string
  open: boolean
  /** Reading "All …" because a custom range overrides it. */
  muted?: boolean
  onClick: () => void
}) {
  return (
    <Button
      variant={open ? 'primary' : 'secondary'}
      size="pill"
      className={`cursor-pointer ${muted && !open ? 'opacity-60' : ''}`}
      onClick={onClick}
      aria-expanded={open}
      aria-controls={open ? 'mmm-filter-panel' : undefined}
    >
      <Icon name={icon} />
      <span>{label}</span>
      <Icon name="chevronDown" className={open ? 'rotate-180 transition-transform' : 'transition-transform'} />
    </Button>
  )
}

/** One choice inside an open panel. The `sm` control, so a year or a month
 *  list reads as a set of values rather than as more toolbar. */
function OptionChip({ label, selected, onClick }: { label: string; selected: boolean; onClick: () => void }) {
  return (
    <Button
      variant={selected ? 'primary' : 'secondary'}
      size="sm"
      className="cursor-pointer"
      aria-pressed={selected}
      onClick={onClick}
    >
      {label}
    </Button>
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

export function MmmFilterBar({
  options,
  year,
  actions,
}: {
  options: MmmFilterOptions | undefined
  year: number | null
  /** The page's own controls — Add KPI, Refresh, Export — kept in the strip's
   *  right-hand corner so the whole toolbar is one surface. */
  actions?: ReactNode
}) {
  const view = useMmmView()
  const custom = isCustomRange(view)
  const [panel, setPanel] = useState<PanelKey | null>(null)
  const toggle = (key: PanelKey) => setPanel((open) => (open === key ? null : key))

  useEffect(() => {
    if (!panel) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setPanel(null)
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [panel])

  if (!options) return null

  const yearLabel = custom ? 'Custom range' : year === null ? ALL_YEARS : String(year)
  const quarterLabel =
    custom || view.quarter === null
      ? ALL_QUARTERS
      : (options.quarters.find((q) => q.code === view.quarter)?.name ?? ALL_QUARTERS)
  const monthLabel =
    custom || view.month === null
      ? ALL_MONTHS
      : (options.months.find((m) => m.code === view.month)?.name ?? ALL_MONTHS)

  const sortedYears = [...options.years].sort((a, b) => b - a)
  const { from: minDate, to: maxDate } = options.date_range
  const clearRange = () => {
    view.set('dateFrom', null)
    view.set('dateTo', null)
  }

  // The months on offer follow the quarter, as they did on the old bar: a
  // month outside it would select nothing.
  const monthsInScope =
    view.quarter && !custom ? options.months.filter((m) => QUARTER_OF_MONTH(m.code) === view.quarter) : options.months

  // Picking a period ends a custom range, and closes the panel — the choice is
  // made, and leaving it open would hold the deck down for nothing.
  const pick = (apply: () => void) => {
    clearRange()
    apply()
    setPanel(null)
  }

  return (
    <div className="cc-filter-surface rounded-[var(--r-lg)] border border-border-subtle p-2 shadow-[var(--shadow-card-soft)]">
      <div className="flex items-start justify-between gap-3">
        <div
          className="flex min-w-0 flex-1 flex-nowrap items-center gap-x-1.5 gap-y-2 @max-[1080px]:flex-wrap"
          role="group"
          aria-label="MMM Insights Hub filters"
        >
          <FilterPill
            icon={custom ? 'calendar' : 'filter'}
            label={yearLabel}
            open={panel === 'year'}
            onClick={() => toggle('year')}
          />
          <FilterPill
            icon="filter"
            label={quarterLabel}
            muted={custom}
            open={panel === 'quarter'}
            onClick={() => toggle('quarter')}
          />
          <FilterPill
            icon="filter"
            label={monthLabel}
            muted={custom}
            open={panel === 'month'}
            onClick={() => toggle('month')}
          />
          <FilterPill
            icon="calendar"
            label={custom ? `${fmtIso(view.dateFrom ?? minDate)} – ${fmtIso(view.dateTo ?? maxDate)}` : 'Date range'}
            open={panel === 'range'}
            onClick={() => toggle('range')}
          />
          <MmmCurrencyToggle />
        </div>
        {actions && <div className="flex shrink-0 items-center gap-1.5">{actions}</div>}
      </div>

      {panel && (
        <div
          id="mmm-filter-panel"
          role="region"
          aria-label={PANEL_TITLE[panel]}
          className="panel-enter mt-2 border-t border-border-subtle px-1 pb-1 pt-3"
        >
          <div className="mb-2 flex items-center justify-between gap-3">
            <span className="text-base font-medium text-ink-primary">{PANEL_TITLE[panel]}</span>
            {panel === 'range' && custom && (
              <Button variant="ghost" size="sm" className="cursor-pointer !text-brand-violet" onClick={clearRange}>
                <Icon name="x" />
                Clear range
              </Button>
            )}
          </div>

          {panel === 'year' && (
            <div className="flex flex-wrap items-center gap-1.5">
              <OptionChip
                label={ALL_YEARS}
                selected={!custom && year === null}
                onClick={() => pick(() => view.setYear(null))}
              />
              {sortedYears.map((y) => (
                <OptionChip
                  key={y}
                  label={String(y)}
                  selected={!custom && year === y}
                  onClick={() => pick(() => view.setYear(y))}
                />
              ))}
            </div>
          )}

          {panel === 'quarter' && (
            <div className="flex flex-wrap items-center gap-1.5">
              <OptionChip
                label={ALL_QUARTERS}
                selected={!custom && view.quarter === null}
                onClick={() => pick(() => view.set('quarter', null))}
              />
              {options.quarters.map((q) => (
                <OptionChip
                  key={q.code}
                  label={q.name}
                  selected={!custom && view.quarter === q.code}
                  onClick={() =>
                    pick(() => {
                      view.set('quarter', q.code)
                      // A month outside the new quarter would select nothing.
                      if (view.month !== null && QUARTER_OF_MONTH(view.month) !== q.code) view.set('month', null)
                    })
                  }
                />
              ))}
            </div>
          )}

          {panel === 'month' && (
            <div className="flex flex-wrap items-center gap-1.5">
              <OptionChip
                label={ALL_MONTHS}
                selected={!custom && view.month === null}
                onClick={() => pick(() => view.set('month', null))}
              />
              {monthsInScope.map((m) => (
                <OptionChip
                  key={m.code}
                  label={m.name}
                  selected={!custom && view.month === m.code}
                  onClick={() => pick(() => view.set('month', m.code))}
                />
              ))}
            </div>
          )}

          {panel === 'range' && (
            <>
              <div className="grid max-w-[460px] grid-cols-2 gap-2 @max-[640px]:grid-cols-1">
                <DateField
                  label="From"
                  value={view.dateFrom}
                  min={minDate}
                  max={view.dateTo ?? maxDate}
                  onChange={(v) => view.set('dateFrom', v)}
                />
                <DateField
                  label="To"
                  value={view.dateTo}
                  min={view.dateFrom ?? minDate}
                  max={maxDate}
                  onChange={(v) => view.set('dateTo', v)}
                />
              </div>
              <p className="mt-2 text-xs leading-[1.5] text-ink-muted">
                Replaces the year, quarter and month. Data runs from {fmtIso(minDate)} to {fmtIso(maxDate)}.
              </p>
            </>
          )}
        </div>
      )}
    </div>
  )
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

/** "2015-01-01" -> "01 Jan 2015", the backend's own date style. */
function fmtIso(iso: string): string {
  const [y, m, d] = iso.split('-')
  return `${d} ${MONTHS[Number(m) - 1]} ${y}`
}
