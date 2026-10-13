import { StudioButton as Button } from './shared'
import { Icon, type IconName } from '../../icons'
import { FilterSelect } from './FilterSelect'
import { PeriodPicker } from './PeriodPicker'
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
        <PeriodPicker calendar={options.calendar} start={start} end={end} onApply={setPeriod} locked={periodLocked} />
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
