import { useEffect, type ReactNode } from 'react'
import { Button, Dropdown, IconButton } from '../ui'
import { Icon } from '../../icons'
import { useCommandFilters, type ListFilterKey } from '../../store/commandFilters'
import { MultiSelect, SelectionChips, type MultiOption } from './MultiSelect'
import { TargetRoiControl, type TargetRoiInfo } from './TargetRoiControl'
import type { Currency, FiltersResponse, Option } from '../../types/commandCenter'

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
  size = 'md',
}: {
  label: string
  /** The "no constraint" entry. Passed explicitly rather than derived as
   *  `label + "s"`, which mangles Category and City. */
  allLabel?: string
  value: string | null
  options: Option[]
  onChange: (value: string | null) => void
  size?: 'sm' | 'md'
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
  size = 'md',
}: {
  label: string
  allLabel?: string
  dimension: ListFilterKey
  options: MultiOption[]
  size?: 'sm' | 'md'
}) {
  const selected = useCommandFilters((s) => s.filters[dimension])
  const toggle = useCommandFilters((s) => s.toggle)
  const set = useCommandFilters((s) => s.set)
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

const toOptions = (values: string[]): Option[] => values.map((v) => ({ code: v, name: v }))

/** Read a list-valued filter as a single selection (or null for "All"). */
const one = (list: string[]): string | null => list[0] ?? null

/** Below this, a filter offers no real choice. Distributor currently carries a
 *  single non-blank value covering the whole B2B estate, so it would duplicate
 *  "Channel = B2B" and select nothing the user could vary. The rule is on the
 *  option COUNT, not on the dimension, so the control reappears by itself if a
 *  future extract carries more than one distributor. */
const MIN_USEFUL_OPTIONS = 2

export function FilterBar({
  options,
  onRefresh,
  refreshing,
  target,
  refreshInline = true,
  trailing,
}: {
  options: FiltersResponse | undefined
  onRefresh: () => void
  refreshing: boolean
  /** False when the page draws the refresh button itself (the Insights Hub
   *  keeps it beside Export, so a wrapping filter row never strands it). */
  refreshInline?: boolean
  /** The target ROI control — current value, default and bounds, from the
   *  KPI payload's meta. Omitted where the page has no target to set. */
  target?: TargetRoiInfo
  /** Controls a page adds to the end of the row — after the target — that
   *  change what the page shows without changing its scope, so they wrap
   *  with the filters rather than being stranded beside Export. */
  trailing?: ReactNode
}) {
  const filters = useCommandFilters((s) => s.filters)
  const currency = useCommandFilters((s) => s.currency)
  const expanded = useCommandFilters((s) => s.expanded)
  const set = useCommandFilters((s) => s.set)
  const setCurrency = useCommandFilters((s) => s.setCurrency)
  const setTargetRoi = useCommandFilters((s) => s.setTargetRoi)
  const toggleExpanded = useCommandFilters((s) => s.toggleExpanded)
  const reset = useCommandFilters((s) => s.reset)
  const reconcile = useCommandFilters((s) => s.reconcile)

  // THE PANEL IS AN OVERLAY NOW, so it needs a way out other than the button.
  // ESCAPE ONLY, DELIBERATELY. Every control inside the panel is a `Dropdown`,
  // and Dropdown PORTALS its menu to document.body — so a click on an option in
  // an open filter menu lands outside this panel's DOM subtree, and a naive
  // click-outside handler would close the panel out from under the selection
  // being made. The trigger button still toggles it shut.
  useEffect(() => {
    if (!expanded) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') toggleExpanded()
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [expanded, toggleExpanded])

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

  const activeCount = Object.entries(filters).filter(
    ([key, value]) =>
      key !== 'year' && (Array.isArray(value) ? value.length > 0 : value !== null),
  ).length

  const yearLabel = filters.year ? String(filters.year) : 'All Years'

  return (
    <>
      {/* Primary controls — same row, same order, same controls as before.
          `flex-wrap` lets the bar reflow on tablet/mobile instead of forcing a
          horizontal scrollbar; nothing is hidden or reordered. */}
      <div className="flex flex-wrap items-center gap-2" role="group" aria-label="Insights Hub filters">
        <Dropdown
          selected={yearLabel}
          options={[{ label: 'All Years' }, ...years.map((y) => ({ label: y.name }))]}
          onSelect={(picked) => {
            if (picked === 'All Years') return set('year', null)
            const match = years.find((y) => y.name === picked)
            set('year', match ? Number(match.code) : null)
          }}
          trigger={
            <Button variant="secondary" size="md" className="cursor-pointer">
              <Icon name="filter" />
              <span>{yearLabel}</span>
              <Icon name="chevronDown" />
            </Button>
          }
        />

        <FilterMulti label="Channel" dimension="channel" options={options.channels} />

        {/* Hidden entirely when the selected channel has no retailer values —
            B2B stores carry a blank Retailer, and an empty dropdown would be
            worse than no dropdown. */}
        {options.retailer_available && (
          <FilterMulti label="Retailer" dimension="retailer" options={options.retailers} />
        )}

        {/* THE ANCHOR. `relative` gives the panel below a containing block,
            so it opens under the button that owns it. Before this the panel
            was a sibling of the whole toolbar inside FilterBar's fragment —
            and since CommandCenter wraps FilterBar in `flex flex-wrap`, a
            fragment's children become FLEX ITEMS of that row. The panel was
            therefore laid out beside the toolbar rather than beneath it,
            shrink-fitted to its content, and it stretched the header row to
            its own height — which is where the empty band came from. */}
        <div className="relative">
          <Button
            variant={expanded ? 'primary' : 'secondary'}
            size="md"
            className="cursor-pointer"
            onClick={toggleExpanded}
            aria-expanded={expanded}
            aria-controls="cc-more-filters"
          >
            <Icon name="filter" />
            <span>More Filters{activeCount > 0 ? ` (${activeCount})` : ''}</span>
            <Icon name="chevronDown" className={expanded ? 'rotate-180 transition-transform' : 'transition-transform'} />
          </Button>
        {expanded && (
          <div
            id="cc-more-filters"
            role="region"
            aria-label="Additional filters"
            className="panel-enter cc-filter-surface absolute right-0 top-full z-30 mt-2 w-[min(680px,calc(100vw-2rem))] max-h-[min(70vh,560px)] overflow-y-auto rounded-[var(--r-lg)] border border-border-subtle p-4 shadow-[var(--shadow-lg)]"
          >
            <div className="mb-3 flex items-center justify-between gap-3">
              <span className="text-base font-bold text-ink-primary">Additional Filters</span>
              <Button
                variant="ghost"
                size="sm"
                className="cursor-pointer !text-brand-violet"
                onClick={reset}
                aria-label="Clear all filters"
              >
                <Icon name="x" />
                Clear all
              </Button>
            </div>
            <div className="grid grid-cols-[repeat(auto-fill,minmax(180px,1fr))] gap-2 @max-[640px]:grid-cols-1">
              <FilterSelect label="Month" allLabel="All Months" value={filters.month ? String(filters.month) : null}
                options={options.months} onChange={(v) => set('month', v ? Number(v) : null)} size="sm" />
              <FilterMulti label="Category" allLabel="All Categories" dimension="category"
                options={toOptions(options.categories)} size="sm" />
              <FilterMulti label="Brand" dimension="brand" options={toOptions(options.brands)} size="sm" />
              <FilterSelect label="Product" value={one(filters.product)} options={options.products}
                onChange={(v) => setList('product', v)} size="sm" />
              <FilterSelect label="Offer" value={one(filters.promotion)} options={options.offers}
                onChange={(v) => setList('promotion', v)} size="sm" />
              {/* dim_promotion.Promotion_Type — its own dimension, cascading through
                  the same option engine as everything else. */}
              <FilterSelect label="Promotion Type" allLabel="All Promotion Types" value={one(filters.promotion_type)}
                options={toOptions(options.promotion_types)} onChange={(v) => setList('promotion_type', v)} size="sm" />
              <FilterSelect label="Region" value={one(filters.region)} options={toOptions(options.regions)}
                onChange={(v) => setList('region', v)} size="sm" />
              <FilterSelect label="State" value={one(filters.state)} options={toOptions(options.states)}
                onChange={(v) => setList('state', v)} size="sm" />
              <FilterSelect label="City" allLabel="All Cities" value={one(filters.city)} options={toOptions(options.cities)}
                onChange={(v) => setList('city', v)} size="sm" />
              <FilterSelect label="Tier" value={one(filters.tier)} options={toOptions(options.tiers)}
                onChange={(v) => setList('tier', v)} size="sm" />
              {options.distributors.length >= MIN_USEFUL_OPTIONS && (
                <FilterSelect label="Distributor" value={one(filters.distributor)}
                  options={toOptions(options.distributors)} onChange={(v) => setList('distributor', v)} size="sm" />
              )}
            </div>
          </div>
        )}
        </div>

        <CurrencyToggle currency={currency} onChange={setCurrency} />

        {target && <TargetRoiControl target={target} onApply={setTargetRoi} />}

        {trailing}

        {refreshInline && (
          <IconButton icon="refresh" className="!h-9 !w-9" title="Refresh data" spinning={refreshing} disabled={refreshing} onClick={onRefresh} />
        )}
      </div>

    </>
  )
}

/** ₹ INR / $ USD. Presentation only — it changes how monetary values are
 *  rendered and nothing else. ROI, PEI and Cannibalization are unaffected. */
function CurrencyToggle({ currency, onChange }: { currency: Currency; onChange: (c: Currency) => void }) {
  return (
    <div
      className="inline-flex h-9 items-center overflow-hidden rounded-[var(--r-md)] border border-border-subtle bg-surface-card p-0.5"
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
          className={`cursor-pointer rounded-[calc(var(--r-md)-3px)] px-2.5 py-1 text-sm font-semibold transition-all duration-150 focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-violet ${
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
