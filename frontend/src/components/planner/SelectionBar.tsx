import { StudioButton as Button } from './shared'
import { Icon, type IconName } from '../../icons'
import { FilterSelect } from './FilterSelect'
import { PeriodPicker } from './PeriodPicker'
import { PeriodRangeFields } from './PeriodRangeFields'
import { usePlannerSelection, type PlannerDimension } from '../../store/plannerSelection'
import type { PlannerOptions } from '../../types/planner'

/** The Studio's selection bar: the period first -- everything is planned
 *  inside it -- then Product, Store, Channel and Region. Within a filter the
 *  picks are ORed, across filters ANDed, and each list is narrowed by the
 *  other three so no pick can empty the selection. */

const DIMS: { dim: PlannerDimension; label: string; icon: IconName; key: keyof Pick<PlannerOptions, 'products' | 'stores' | 'channels' | 'regions'> }[] = [
  { dim: 'products', label: 'Product', icon: 'package', key: 'products' },
  { dim: 'stores', label: 'Store', icon: 'retailer', key: 'stores' },
  { dim: 'channels', label: 'Channel', icon: 'layers', key: 'channels' },
  { dim: 'regions', label: 'Region', icon: 'grid', key: 'regions' },
]

export function SelectionBar({
  options,
  start,
  end,
  periodLocked,
  dimsLocked,
}: {
  options: PlannerOptions | undefined
  start: [number, number] | null
  end: [number, number] | null
  periodLocked?: string
  /** In a promotion focus the channel comes from the calendar. */
  dimsLocked?: PlannerDimension[]
}) {
  const selection = usePlannerSelection((s) => s.selection)
  const setList = usePlannerSelection((s) => s.setList)
  const setPeriod = usePlannerSelection((s) => s.setPeriod)
  const anySelected = DIMS.some(({ dim }) => selection[dim].length > 0)

  return (
    <div
      role="group"
      aria-label="Simulation Studio filters"
      className="flex flex-wrap items-center gap-2 rounded-[var(--r-lg)] border border-border-subtle bg-surface-card px-3 py-2.5 shadow-[var(--shadow-card-soft)]"
    >
      {options && start && end ? (
        <>
          {/* THE SAME TWO FIELDS THE INSIGHTS HUB OFFERS, beside the button
              rather than instead of it. The button BROWSES — months, the
              rolling windows — and opens a panel over the plan below to do it;
              the fields set either end outright, with the platform's own date
              popover, covering nothing. Neither can say anything the other
              cannot: both end in `setPeriod` over the same business weeks.

              So the button no longer spells the span out — the fields carry
              the dates now, and printing "Jan – Aug 2026" beside
              "01-01-2026 / 24-08-2026" was the same answer twice and pushed
              Region onto a second row. It keeps the week count, which is the
              one thing neither field shows.

              The fields are hidden while a promotion focus fixes the period:
              the button says so in that state, and two dead fields beside it
              would not. */}
          <PeriodPicker
            calendar={options.calendar}
            start={start}
            end={end}
            onApply={setPeriod}
            locked={periodLocked}
            renderTrigger={({ open, label, weeks, toggle }) => (
              <button
                type="button"
                onClick={toggle}
                title={periodLocked ?? `Choose the period to plan — ${label}`}
                aria-haspopup="dialog"
                aria-expanded={open}
                aria-label={`Period, ${label}`}
                className={`inline-flex h-10 cursor-pointer items-center gap-2 rounded-[var(--r-md)] border px-3 text-base transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-violet [&_svg]:h-4 [&_svg]:w-4 ${
                  open
                    ? 'border-brand-violet/50 bg-brand-violet-50 text-brand-violet'
                    : 'border-border-default bg-surface-card text-ink-secondary hover:border-border-strong hover:bg-surface-hover'
                } ${periodLocked ? 'cursor-default' : ''}`}
              >
                <Icon name="calendar" />
                <span className="font-medium">Period</span>
                {weeks !== null && (
                  <span className="rounded-[var(--r-sm)] bg-brand-violet-50 px-1.5 py-0.5 text-sm font-medium text-brand-violet">
                    {weeks} weeks
                  </span>
                )}
                {periodLocked ? <Icon name="lock" /> : <Icon name="chevronDown" />}
              </button>
            )}
          />
          {!periodLocked && (
            <PeriodRangeFields
              calendar={options.calendar}
              start={start}
              end={end}
              onApply={setPeriod}
              className="shrink-0"
            />
          )}
        </>
      ) : (
        <Button variant="secondary" size="md" disabled>
          <Icon name="calendar" /> <span>Loading…</span>
        </Button>
      )}
      <span className="mx-1 h-6 w-px bg-border-subtle" aria-hidden />
      {DIMS.map(({ dim, label, icon, key }) => (
        <FilterSelect
          key={dim}
          label={label}
          icon={icon}
          options={options?.[key] ?? []}
          selected={selection[dim]}
          onChange={(codes) => setList(dim, codes)}
          disabled={dimsLocked?.includes(dim)}
          disabledReason="Set by the promotion from the calendar"
        />
      ))}
      {anySelected && !dimsLocked?.length && (
        <Button variant="ghost" size="md" onClick={() => DIMS.forEach(({ dim }) => setList(dim, []))} className="ml-auto">
          <Icon name="x" /> Clear filters
        </Button>
      )}
    </div>
  )
}
