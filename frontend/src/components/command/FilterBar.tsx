import { useEffect, useState, type ReactNode } from 'react'
import { Button, Dropdown, IconButton } from '../ui'
import { Icon } from '../../icons'
import { useCommandFilters, type FilterStoreHook, type ListFilterKey } from '../../store/commandFilters'
import { MultiSelect, SelectionChips, type MultiOption } from './MultiSelect'
import { smartPeriodLabel } from '../planner/PeriodPicker'
import { PeriodRangeFields } from '../planner/PeriodRangeFields'
import { usePeriodSelection, type WeekKey } from '../../hooks/usePeriodSelection'
import type { Currency, FiltersResponse, Option } from '../../types/commandCenter'

/** THE BAR IS A RAISED TILE, AND MORE FILTERS EXPANDS IT (2026-10-29).
 *
 *  Additional Filters used to be a floating panel: up to 680px wide, absolutely
 *  positioned under its button, measured against <main> so it would not run off
 *  the page. It still painted OVER the deck below — the KPI cards start 14px
 *  under the bar, so an open panel hid Incremental Sales and Promotion ROI
 *  outright and spilled onto the trend chart. The reader could not see the
 *  numbers they were choosing a filter for.
 *
 *  So the toolbar is drawn on its own surface and the panel opens INSIDE it,
 *  under a hairline, pushing the deck down instead of covering it. That is
 *  the MMM Insights Hub bar's arrangement (mmm/components/MmmFilterBar), and
 *  the two hubs now read the same way.
 *
 *  It also deletes the placement problem rather than solving it: a panel that
 *  is a block inside the tile is as wide as the tile, so there is nothing to
 *  measure, nothing to slide left, and nothing to re-measure when the sidebar
 *  pins or the Analyst docks. */

/** A single-select dropdown over a filter the API models as a list.
 *
 *  "All …" clears the constraint; the API treats an absent list as
 *  unconstrained. Used for every dimension NOT in `MULTI_SELECT`. */
function FilterSelect({
  label,
  allLabel: allLabelProp,
  value,
  options,
  onChange,
  size = 'pill',
}: {
  label: string
  /** The "no constraint" entry. Passed explicitly rather than derived as
   *  `label + "s"`, which mangles Category and City. */
  allLabel?: string
  value: string | null
  options: Option[]
  onChange: (value: string | null) => void
  /** `pill` is the toolbar's own size and the default; the Additional
   *  Filters panel passes `sm`. */
  size?: 'sm' | 'pill'
}) {
  const allLabel = allLabelProp ?? `All ${label}s`
  const selectedName = value ? (options.find((o) => o.code === value)?.name ?? value) : allLabel
  const items = [{ label: allLabel }, ...options.map((o) => ({ label: o.name }))]

  return (
    <Dropdown
      selected={selectedName}
      options={items}
      onSelect={(picked) => {
        if (picked === allLabel) return onChange(null)
        onChange(options.find((o) => o.name === picked)?.code ?? null)
      }}
      trigger={
        <Button variant="secondary" size={size} className="cursor-pointer">
          <Icon name="filter" />
          <span>{selectedName}</span>
          <Icon name="chevronDown" />
        </Button>
      }
    />
  )
}

/** A multi-select over one filter dimension. Values within it are ORed by the
 *  backend; different dimensions are ANDed. Selections render as individual
 *  chips so two picks never read as one ambiguous value. */
function FilterMulti({
  label,
  allLabel: allLabelProp,
  dimension,
  options,
  size = 'pill',
  store = useCommandFilters,
}: {
  label: string
  allLabel?: string
  dimension: ListFilterKey
  options: MultiOption[]
  size?: 'sm' | 'pill'
  store?: FilterStoreHook
}) {
  const selected = store((s) => s.filters[dimension])
  const toggle = store((s) => s.toggle)
  const set = store((s) => s.set)
  const allLabel = allLabelProp ?? `All ${label}s`

  return (
    <MultiSelect
      label={label}
      options={options}
      selected={selected}
      allLabel={allLabel}
      onToggle={(code) => toggle(dimension, code)}
      onClear={() => set(dimension, [])}
      trigger={
        <Button variant="secondary" size={size} className="cursor-pointer">
          <Icon name="filter" />
          {selected.length === 0 ? (
            <span>{allLabel}</span>
          ) : (
            <SelectionChips
              options={options}
              selected={selected}
              onRemove={(code) => toggle(dimension, code)}
            />
          )}
          <Icon name="chevronDown" />
        </Button>
      }
    />
  )
}

/** A PILL THAT EXPANDS THE BAR instead of dropping a menu over the deck.
 *  The scope controls all wear this; `open` is the panel it owns being on
 *  screen, and it takes the filled variant then. */
function BarPill({
  icon = 'filter',
  label,
  count,
  open,
  muted,
  onClick,
  controls,
}: {
  icon?: 'filter' | 'calendar'
  label: string
  /** How many values are chosen, for a multi-select that is not on "All". */
  count?: number
  open: boolean
  /** Overridden by something else — Month, while a custom date range is set. */
  muted?: boolean
  onClick: () => void
  controls: string
}) {
  return (
    <Button
      variant={open ? 'primary' : 'secondary'}
      size="pill"
      className={`cursor-pointer ${muted && !open ? 'opacity-60' : ''}`}
      onClick={onClick}
      aria-expanded={open}
      aria-controls={open ? controls : undefined}
    >
      <Icon name={icon} />
      <span>
        {label}
        {count ? ` (${count})` : ''}
      </span>
      <Icon name="chevronDown" className={open ? 'rotate-180 transition-transform' : 'transition-transform'} />
    </Button>
  )
}

/** One choice inside an open panel — the `sm` control, so a row of values
 *  reads as a set of values rather than as more toolbar. The same chip the
 *  MMM Insights Hub bar uses, so the two hubs' panels match. */
function OptionChip({
  label,
  selected,
  onClick,
}: {
  label: string
  selected: boolean
  onClick: () => void
}) {
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

/** A labelled row of chips inside a panel: "Year   [All data] [2024] …". The
 *  label is a fixed column so several rows line their chips up. */
function ChipRow({ label, children }: { label: string; children: ReactNode }) {
  return (
    // A GRID, NOT A FLEX ROW. As a flex row the label and the chip group were
    // two wrappable items, so a long group (Brand, City) pushed itself onto a
    // second line and left its label stranded above it, while short rows
    // stayed inline — the same panel reading two different ways down its own
    // length. In a grid the label keeps its own column whatever the chips do,
    // and they wrap inside theirs. `items-start` + the label's own top padding
    // sit it on the first line of chips rather than centred against all of them.
    <div className="grid grid-cols-[76px_minmax(0,1fr)] items-start gap-x-2 gap-y-1.5 @max-[640px]:grid-cols-1">
      <span className="pt-[7px] text-xs font-medium uppercase tracking-wide text-ink-muted">{label}</span>
      <span className="flex flex-wrap items-center gap-1.5">{children}</span>
    </div>
  )
}

/** A whole dimension as one wrapped row of toggles — the MMM bar's panel,
 *  over a multi-select. "All" clears, every other chip toggles that value, so
 *  the control says what is on without a menu over the cards below. */
function ChipMulti({
  allLabel,
  options,
  dimension,
  store,
}: {
  allLabel: string
  options: MultiOption[]
  dimension: ListFilterKey
  store: FilterStoreHook
}) {
  const selected = store((s) => s.filters[dimension])
  const toggle = store((s) => s.toggle)
  const set = store((s) => s.set)
  return (
    <div className="flex flex-wrap items-center gap-1.5">
      <OptionChip label={allLabel} selected={selected.length === 0} onClick={() => set(dimension, [])} />
      {options.map((o) => (
        <OptionChip
          key={o.code}
          label={o.name}
          selected={selected.includes(o.code)}
          onClick={() => toggle(dimension, o.code)}
        />
      ))}
    </div>
  )
}

/** Which set of choices the strip is showing, or none. */
type BarPanel = 'year' | 'month' | 'range' | 'channel' | 'retailer' | 'more' | null

const MONTH_ABBR = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

/** The rolling windows the period panel offers, in months. */
const RECENT_SPANS = [3, 6, 12] as const

/** The frame every expanded panel is drawn in: the hairline that separates it
 *  from the pills, its name, and a way to clear what it holds. One component
 *  so Period, Channel, Retailer and Additional Filters cannot drift apart. */
function PanelShell({
  label,
  onClear,
  clearLabel = 'Clear',
  children,
}: {
  label: string
  /** Omitted when there is nothing set to clear. */
  onClear?: () => void
  clearLabel?: string
  children: ReactNode
}) {
  return (
    <div
      id="cc-filter-panel"
      role="region"
      aria-label={label}
      className="panel-enter mt-2 max-h-[min(50vh,420px)] overflow-y-auto border-t border-border-subtle px-1 pb-1 pt-3"
    >
      <div className="mb-2 flex items-center justify-between gap-3">
        <span className="text-base font-medium text-ink-primary">{label}</span>
        {onClear && (
          <Button variant="ghost" size="sm" className="cursor-pointer !text-brand-violet" onClick={onClear}>
            <Icon name="x" />
            {clearLabel}
          </Button>
        )}
      </div>
      {children}
    </div>
  )
}

/** A dimension the API models as a list but the page treats as ONE choice,
 *  as a wrapped row of chips. "All" clears it; picking the chosen one again
 *  also clears it, so a single click always undoes a single click. */
function ChipSingle({
  allLabel,
  options,
  value,
  onChange,
}: {
  allLabel: string
  options: Option[]
  value: string | null
  onChange: (value: string | null) => void
}) {
  return (
    <div className="flex flex-wrap items-center gap-1.5">
      <OptionChip label={allLabel} selected={value == null} onClick={() => onChange(null)} />
      {options.map((o) => (
        <OptionChip
          key={o.code}
          label={o.name}
          selected={value === o.code}
          onClick={() => onChange(value === o.code ? null : o.code)}
        />
      ))}
    </div>
  )
}

const toOptions = (values: string[]): Option[] => values.map((v) => ({ code: v, name: v }))

/** Read a list-valued filter as a single selection (or null for "All"). */
const one = (list: string[]): string | null => list[0] ?? null

/** Below this, a filter offers no real choice. Distributor currently carries a
 *  single non-blank value covering the whole B2B estate, so it would duplicate
 *  "Channel = B2B" and select nothing the user could vary. The rule is on the
 *  option COUNT, not on the dimension, so the control reappears by itself if a
 *  future extract carries more than one distributor. */
const MIN_USEFUL_OPTIONS = 2

/** Which controls sit on the bar and which fold into "More Filters".
 *
 *  `insights` is the Insights Hub's layout, unchanged. `studio` is the
 *  Simulation Studio's: Year, Channel, Category, Brand and Product on the bar;
 *  geography and distributor behind the button; no Month, Offer or Promotion
 *  Type at all — a forward window has no month, and the studio decides the
 *  promotion itself. */
export type FilterBarLayout = 'insights' | 'studio'

/** Short month names for the period pill, in the app's own spelling. */
const MONTH_NAMES = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
                     'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'] as const

export function FilterBar({
  options,
  onRefresh,
  refreshing = false,
  refreshInline = true,
  store = useCommandFilters,
  layout = 'insights',
  groupLabel = 'Insights Hub filters',
  actions,
}: {
  options: FiltersResponse | undefined
  /** Omitted by a page with nothing to refresh by hand. The Simulation
   *  Studio re-runs on every lever move, so a Refresh button there offered
   *  to fetch again what it had just fetched. */
  onRefresh?: () => void
  refreshing?: boolean
  /** The filter store this bar edits. The Insights Hub's by default; the
   *  Simulation Studio passes its own instance of the same shape. */
  store?: FilterStoreHook
  layout?: FilterBarLayout
  groupLabel?: string
  /** False when the page draws the refresh button itself (the Insights Hub
   *  keeps it in the action group on the right). Ignored when there is no
   *  `onRefresh` to call. */
  refreshInline?: boolean
  /** The page's own buttons, kept on the tile's right-hand end — Investigate,
   *  Add KPI, Refresh, Export. They belong on the bar rather than beside it so
   *  that the expanding panel below them is part of the same surface: a panel
   *  opening under a tile that held only half the row would leave the other
   *  half floating beside it. */
  actions?: ReactNode
}) {
  const filters = store((s) => s.filters)
  const currency = store((s) => s.currency)
  const expanded = store((s) => s.expanded)
  const set = store((s) => s.set)
  const setCurrency = store((s) => s.setCurrency)
  const toggleExpanded = store((s) => s.toggleExpanded)
  const reset = store((s) => s.reset)
  const reconcile = store((s) => s.reconcile)
  const studio = layout === 'studio'
  const {
    calendar,
    start: periodStart,
    end: periodEnd,
    apply: applyPeriod,
    clear: clearPeriod,
    months: dataMonths,
    applyYear,
    applyMonth,
  } = usePeriodSelection(store, options)

  // ONE PANEL AT A TIME, as the MMM bar does it: every pill is a view of one
  // scope, not an independent menu, and they all expand the same strip — so
  // opening any one has to close the rest or the tile would grow by several
  // at once.
  //
  // Additional Filters keeps its `expanded` flag in the store because the
  // Analyst can open it; the rest are local, since nothing outside the bar
  // opens them.
  const [panel, setPanel] = useState<BarPanel>(null)
  const openPanel = (next: BarPanel) => {
    if (next !== 'more' && expanded) toggleExpanded()
    if (next === 'more' && !expanded) toggleExpanded()
    setPanel(next === 'more' ? null : next)
  }
  // `expanded` is the store's, so it can be turned on from outside the bar;
  // whichever is on is the one panel showing.
  const shown: BarPanel | 'more' = expanded ? 'more' : panel

  // THE PERIOD, AS THREE PILLS — Year, Month and Date range, the MMM bar's
  // arrangement. A custom range replaces the other two, exactly as it does
  // there: while one is set the Year pill reads the span, Month rests, and
  // picking either ends the range.
  const customRange = filters.period_from != null && filters.period_to != null

  const yearLabelNow = customRange
    ? periodStart && periodEnd
      ? smartPeriodLabel(periodStart, periodEnd, calendar)
      : 'Custom range'
    : filters.year != null
      ? String(filters.year)
      : 'All data'
  const monthLabelNow =
    !customRange && filters.year != null && filters.month != null ? MONTH_NAMES[filters.month - 1] : 'All Months'

  // A pill names the one value chosen, or counts them — "Modern Trade", then
  // "Channels (3)". Naming a single choice is what the old dropdown's chips
  // did, and it is the thing a reader most often wants to see without opening
  // anything.
  const pickedLabel = (chosen: string[], opts: MultiOption[], all: string, many: string) =>
    chosen.length === 0 ? all : chosen.length === 1 ? (opts.find((o) => o.code === chosen[0])?.name ?? chosen[0]) : many
  // `options` is still optional here — the guard that narrows it comes below,
  // after the hooks, so these two read through it.
  const channelLabel = pickedLabel(filters.channel, options?.channels ?? [], 'All Channels', 'Channels')
  const retailerLabel = pickedLabel(filters.retailer, options?.retailers ?? [], 'All Retailers', 'Retailers')

  /** The months the data actually holds for the chosen year — the chips never
   *  offer a month that would select nothing. */
  const monthsOfYear = filters.year == null ? [] : dataMonths.filter((m) => m.year === filters.year)

  /** The last `n` whole months of data, as a week span. Counted from the end
   *  of the data rather than from today, because the dataset ends where it
   *  ends and "the last 3 months" of an empty future is not a period. */
  const lastMonths = (n: number) => {
    const tail = dataMonths.slice(-n)
    return tail.length === n ? { from: tail[0].from, to: tail[tail.length - 1].to } : null
  }
  const isCurrentSpan = (span: { from: WeekKey; to: WeekKey }) =>
    !!periodStart &&
    !!periodEnd &&
    periodStart[0] === span.from[0] &&
    periodStart[1] === span.from[1] &&
    periodEnd[0] === span.to[0] &&
    periodEnd[1] === span.to[1]


  // A WAY OUT OTHER THAN THE BUTTON, for whichever panel is open — not just
  // Additional Filters, which was the only one when this was written. Escape
  // closing one panel and doing nothing for the other five is the kind of
  // difference a reader learns the hard way.
  //
  // ESCAPE ONLY, DELIBERATELY. Some controls inside a panel are `Dropdown`s,
  // and Dropdown PORTALS its menu to document.body — so a click on an option in
  // an open filter menu lands outside this panel's DOM subtree, and a naive
  // click-outside handler would close the panel out from under the selection
  // being made. The trigger button still toggles it shut.
  const anyOpen = expanded || panel !== null
  useEffect(() => {
    if (!anyOpen) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return
      setPanel(null)
      if (store.getState().expanded) toggleExpanded()
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [anyOpen, toggleExpanded, store])

  // Drop any selection the current scope no longer offers. Runs whenever the
  // options change; `reconcile` is a no-op when everything selected is still
  // available, so this cannot cycle. See the store for the termination
  // argument.
  useEffect(() => {
    if (options) reconcile(options)
  }, [options, reconcile])

  if (!options) return null

  // Calendar years. The API also ships F24/F25 display labels in
  // `year_labels`; the Insights Hub deliberately does not use them — see
  // lib/labels.ts for why the rest of the page rewrites that shorthand.
  const years: Option[] = options.years.map((y) => ({ code: String(y), name: String(y) }))

  const setList = (key: ListFilterKey, value: string | null) => set(key, value ? [value] : [])

  // What "More Filters (n)" counts. The Insights Hub counts every active
  // dimension but the year, as it always has. In the studio layout Category,
  // Brand and Product sit on the bar, so they are not counted twice.
  const onBar: string[] = studio
    ? ['year', 'channel', 'category', 'brand', 'product', 'month', 'promotion', 'promotion_type']
    : ['year', 'month', 'period_from', 'period_to']
  const activeCount = Object.entries(filters).filter(
    ([key, value]) =>
      !onBar.includes(key) && (Array.isArray(value) ? value.length > 0 : value !== null),
  ).length

  const yearLabel = filters.year ? String(filters.year) : 'All Years'

  // THE PERIOD, as the calendar sees it: a custom range, or the selected
  // year's own weeks, or nothing (all data). The rules live in
  // hooks/usePeriodSelection, because the alerts dialog on the Investigations
  // page offers the same calendar over this same store.

  return (
    <div className="cc-filter-surface rounded-[var(--r-lg)] border border-border-subtle p-2 shadow-[var(--shadow-card-soft)]">
      {/* The scope controls and the page's actions share one line; the panel
          below opens under both. `items-start` so a filter group that wraps on
          a narrow page grows downwards and leaves the actions on the top line
          rather than centring them against a two-line block. */}
      <div className="flex items-start justify-between gap-3">
      {/* IT WRAPS AT ANY WIDTH NOW. The row used to be `flex-nowrap` above
          1080px, which held while the period was one pill; splitting it into
          Year, Month and Date range made six controls plus the currency
          switch, and at 1500px `nowrap` stopped squeezing the pills (they set
          their own padding) and crushed the currency toggle into a sliver
          instead. Wrapping is the honest answer: the tile grows by a line,
          which it is built to do, and nothing is hidden or reordered.

          `gap-x-1.5` rather than a uniform `gap-2`: the controls are pills with
          their own padding, so 6px between them still reads as separate. The
          vertical gap stays at 8px for the widths where the row does wrap. */}
      <div
        className="flex min-w-0 flex-1 flex-wrap items-center gap-x-1.5 gap-y-2"
        role="group"
        aria-label={groupLabel}
      >
        {studio || !calendar.length ? (
          <Dropdown
            selected={yearLabel}
            options={[{ label: 'All Years' }, ...years.map((y) => ({ label: y.name }))]}
            onSelect={(picked) => {
              if (picked === 'All Years') return set('year', null)
              const match = years.find((y) => y.name === picked)
              set('year', match ? Number(match.code) : null)
            }}
            trigger={
              <Button variant="secondary" size="pill" className="cursor-pointer">
                <Icon name="filter" />
                <span>{yearLabel}</span>
                <Icon name="chevronDown" />
              </Button>
            }
          />
        ) : (
          // YEAR, MONTH, DATE RANGE — the MMM bar's three period pills. A
          // custom range overrides the other two, so while one is set the Year
          // pill names the span and Month rests at "All Months".
          <>
            <BarPill
              icon="calendar"
              label={yearLabelNow}
              open={shown === 'year'}
              onClick={() => openPanel(shown === 'year' ? null : 'year')}
              controls="cc-filter-panel"
            />
            <BarPill
              label={monthLabelNow}
              muted={customRange}
              open={shown === 'month'}
              onClick={() => openPanel(shown === 'month' ? null : 'month')}
              controls="cc-filter-panel"
            />
            <BarPill
              icon="calendar"
              label={customRange ? 'Custom range' : 'Date range'}
              open={shown === 'range'}
              onClick={() => openPanel(shown === 'range' ? null : 'range')}
              controls="cc-filter-panel"
            />
          </>
        )}

        <BarPill
          label={channelLabel}
          count={filters.channel.length}
          open={shown === 'channel'}
          onClick={() => openPanel(shown === 'channel' ? null : 'channel')}
          controls="cc-filter-panel"
        />

        {/* Hidden entirely when the selected channel has no retailer values —
            B2B stores carry a blank Retailer, and an empty list would be
            worse than no control. */}
        {!studio && options.retailer_available && (
          <BarPill
            label={retailerLabel}
            count={filters.retailer.length}
            open={shown === 'retailer'}
            onClick={() => openPanel(shown === 'retailer' ? null : 'retailer')}
            controls="cc-filter-panel"
          />
        )}

        {studio && (
          <>
            <FilterMulti label="Category" allLabel="All Categories" dimension="category"
              options={toOptions(options.categories)} store={store} />
            <FilterMulti label="Brand" dimension="brand" options={toOptions(options.brands)} store={store} />
            <FilterSelect label="Product" value={one(filters.product)} options={options.products}
              onChange={(v) => setList('product', v)} />
          </>
        )}

        <Button
          variant={expanded ? 'primary' : 'secondary'}
          size="pill"
          className="cursor-pointer"
          onClick={() => openPanel(expanded ? null : 'more')}
          aria-expanded={expanded}
          // Only while the panel exists. `aria-controls` pointing at an id
          // that is not in the document is an invalid reference, and some
          // screen readers announce the control as broken rather than
          // ignoring it. The panel is unmounted when collapsed, so the
          // attribute has to come and go with it.
          aria-controls={expanded ? 'cc-filter-panel' : undefined}
        >
          <Icon name="filter" />
          <span>More Filters{activeCount > 0 ? ` (${activeCount})` : ''}</span>
          <Icon name="chevronDown" className={expanded ? 'rotate-180 transition-transform' : 'transition-transform'} />
        </Button>

        {refreshInline && onRefresh && (
          <IconButton icon="refresh" className="!h-9 !w-9" title="Refresh data" spinning={refreshing} disabled={refreshing} onClick={onRefresh} />
        )}
      </div>
        {/* THE CURRENCY SWITCH SITS WITH THE ACTIONS, not the filters. It does
            not change the SELECTION — it changes how the selected figures are
            written — so it belongs beside Export rather than among the pills
            that choose rows. It moved here when the period became three pills:
            six pills plus the switch no longer fit a line, and the switch was
            the one thing left stranded on a second row of its own. */}
        <div className="flex shrink-0 items-center gap-1.5">
          <CurrencyToggle currency={currency} onChange={setCurrency} />
          {actions}
        </div>
      </div>

      {/* THE PERIOD IS THREE PILLS, AS IT IS ON THE MMM BAR — Year, Month and
          Date range, each expanding one short row. It was one pill over a
          calendar grid: 607px of tall, narrow control in a 380px column, with
          the rest of the strip blank. Years and months are short lists and
          read across; a range is two date fields. Nothing here is taller than
          about 90px.

          A CUSTOM RANGE REPLACES THE OTHER TWO, as it does in MMM: while one
          is set the Year pill names the span, Month rests, and picking a year
          or a month ends the range. */}
      {/* Titled "Period", not "Year": it carries the year chips AND the rolling
          windows, and a panel headed "Year" above a row labelled "Year" said
          the same word twice. */}
      {shown === 'year' && (
        <PanelShell label="Period">
          <div className="flex flex-col gap-2">
            <ChipRow label="Year">
              <OptionChip
                label="All data"
                selected={!customRange && filters.year == null}
                onClick={clearPeriod}
              />
              {years.map((y) => (
                <OptionChip
                  key={y.code}
                  label={y.name}
                  selected={!customRange && filters.year === Number(y.code)}
                  onClick={() => applyYear(Number(y.code))}
                />
              ))}
            </ChipRow>
            {/* The rolling windows, beside the years rather than on a pill of
                their own: they answer the same question a year does. */}
            <ChipRow label="Recent">
              {RECENT_SPANS.map((n) => {
                const span = lastMonths(n)
                return (
                  <OptionChip
                    key={n}
                    label={`Last ${n} months`}
                    selected={!!span && isCurrentSpan(span)}
                    onClick={() => span && applyPeriod(span.from, span.to)}
                  />
                )
              })}
            </ChipRow>
          </div>
        </PanelShell>
      )}

      {shown === 'month' && (
        <PanelShell label="Month">
          {filters.year == null || customRange ? (
            <p className="text-sm leading-[1.5] text-ink-muted">
              {customRange
                ? 'A date range is set. Pick a year to choose months again.'
                : 'Pick a year first — a month needs one to be a period.'}
            </p>
          ) : (
            // One row, already headed "Month" by the panel, so the chips sit
            // on their own rather than under a second "Month" label.
            <div className="flex flex-wrap items-center gap-1.5">
              <OptionChip
                label="Whole year"
                selected={filters.month == null}
                onClick={() => applyYear(filters.year as number)}
              />
              {monthsOfYear.map((m) => (
                <OptionChip
                  key={m.month}
                  label={MONTH_ABBR[m.month - 1]}
                  selected={filters.month === m.month}
                  onClick={() => applyMonth(m.year, m.month)}
                />
              ))}
            </div>
          )}
        </PanelShell>
      )}

      {shown === 'range' && (
        <PanelShell
          label="Custom date range"
          onClear={customRange ? clearPeriod : undefined}
          clearLabel="Clear range"
        >
          {/* The shared control — the Simulation Studio's selection bar and the
              alerts dialog on Investigations offer the same two fields over
              their own period. See components/planner/PeriodRangeFields. */}
          <PeriodRangeFields
            calendar={calendar}
            start={periodStart}
            end={periodEnd}
            onApply={applyPeriod}
            onClear={clearPeriod}
            note
          />
          <p className="mt-1.5 text-xs leading-[1.5] text-ink-muted">Replaces the year and month.</p>
        </PanelShell>
      )}

      {shown === 'channel' && (
        <PanelShell
          label="Channel"
          onClear={filters.channel.length ? () => set('channel', []) : undefined}
        >
          <ChipMulti allLabel="All Channels" options={options.channels} dimension="channel" store={store} />
        </PanelShell>
      )}

      {shown === 'retailer' && (
        <PanelShell
          label="Retailer"
          onClear={filters.retailer.length ? () => set('retailer', []) : undefined}
        >
          <ChipMulti allLabel="All Retailers" options={options.retailers} dimension="retailer" store={store} />
        </PanelShell>
      )}

      {shown === 'more' && (
          <PanelShell label="Additional Filters" onClear={reset} clearLabel="Clear all">
            {/* CHIP ROWS FOR THE SHORT LISTS, dropdowns for the long ones.
                A chip row shows every value at once, which is what makes the
                rest of this bar readable without opening anything — but it only
                works while the values fit on a line or three. Product (36) and
                Offer (19) would fill the panel on their own, so they keep a
                menu; everything here has a dozen values or fewer. */}
            <div className="flex flex-col gap-2">
              {!studio && (
                <>
                  <ChipRow label="Category">
                    <ChipMulti allLabel="All" options={toOptions(options.categories)} dimension="category" store={store} />
                  </ChipRow>
                  <ChipRow label="Brand">
                    <ChipMulti allLabel="All" options={toOptions(options.brands)} dimension="brand" store={store} />
                  </ChipRow>
                  {/* dim_promotion.Promotion_Type — its own dimension, cascading
                      through the same option engine as everything else. */}
                  <ChipRow label="Type">
                    <ChipSingle
                      allLabel="All"
                      options={toOptions(options.promotion_types)}
                      value={one(filters.promotion_type)}
                      onChange={(v) => setList('promotion_type', v)}
                    />
                  </ChipRow>
                </>
              )}
              {studio && options.retailer_available && (
                <ChipRow label="Retailer">
                  <ChipMulti allLabel="All" options={options.retailers} dimension="retailer" store={store} />
                </ChipRow>
              )}
              <ChipRow label="Region">
                <ChipSingle allLabel="All" options={toOptions(options.regions)}
                  value={one(filters.region)} onChange={(v) => setList('region', v)} />
              </ChipRow>
              <ChipRow label="State">
                <ChipSingle allLabel="All" options={toOptions(options.states)}
                  value={one(filters.state)} onChange={(v) => setList('state', v)} />
              </ChipRow>
              <ChipRow label="City">
                <ChipSingle allLabel="All" options={toOptions(options.cities)}
                  value={one(filters.city)} onChange={(v) => setList('city', v)} />
              </ChipRow>
              <ChipRow label="Tier">
                <ChipSingle allLabel="All" options={toOptions(options.tiers)}
                  value={one(filters.tier)} onChange={(v) => setList('tier', v)} />
              </ChipRow>

              {/* The two long lists, and Distributor when it offers a choice at
                  all. A menu each, on one row, under a hairline that separates
                  them from the chips above. */}
              {(!studio || options.distributors.length >= MIN_USEFUL_OPTIONS) && (
                <div className="mt-1 flex flex-wrap items-center gap-2 border-t border-border-subtle pt-3">
                  {!studio && (
                    <>
                      <FilterSelect label="Product" value={one(filters.product)} options={options.products}
                        onChange={(v) => setList('product', v)} size="sm" />
                      <FilterSelect label="Offer" value={one(filters.promotion)} options={options.offers}
                        onChange={(v) => setList('promotion', v)} size="sm" />
                    </>
                  )}
                  {options.distributors.length >= MIN_USEFUL_OPTIONS && (
                    <FilterSelect label="Distributor" value={one(filters.distributor)}
                      options={toOptions(options.distributors)} onChange={(v) => setList('distributor', v)} size="sm" />
                  )}
                </div>
              )}
            </div>
          </PanelShell>
        )}
    </div>
  )
}

/** ₹ INR / $ USD. Presentation only — it changes how monetary values are
 *  rendered and nothing else. ROI, PEI and Cannibalization are unaffected. */
function CurrencyToggle({ currency, onChange }: { currency: Currency; onChange: (c: Currency) => void }) {
  return (
    <div
      // `shrink-0`: a flex row with no room left took it out of this control
      // first, because it is the only one here that is not a pill with its own
      // intrinsic padding — ₹ INR / $ USD collapsed to a dark sliver.
      className="inline-flex h-9 shrink-0 items-center overflow-hidden rounded-[var(--r-md)] border border-border-subtle bg-surface-card p-0.5"
      role="radiogroup"
      aria-label="Display currency"
    >
      {(['INR', 'USD'] as const).map((code) => (
        <button
          key={code}
          type="button"
          role="radio"
          aria-checked={currency === code}
          aria-label={code === 'INR' ? 'Indian rupees' : 'US dollars'}
          onClick={() => onChange(code)}
          // `h-full` rather than `py-1`: the segments were 25px inside a 36px
          // shell, so a third of the control's height was a dead strip that
          // looked clickable and was not. Filling the shell makes the visible
          // pill and the hit target the same rectangle.
          className={`h-full cursor-pointer rounded-[calc(var(--r-md)-3px)] px-2.5 text-sm font-medium transition-all duration-150 focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-violet ${
            currency === code
              ? 'bg-brand-violet text-white shadow-[var(--shadow-card-soft)]'
              : 'text-ink-muted hover:bg-surface-hover hover:text-ink-primary'
          }`}
        >
          {code === 'INR' ? '₹ INR' : '$ USD'}
        </button>
      ))}
    </div>
  )
}
