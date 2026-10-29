import { useState } from 'react'
import { StudioButton as Button } from './shared'
import { Icon, type IconName } from '../../icons'
import { FilterSelect } from './FilterSelect'
import { PERIOD_PANEL_TITLE, PeriodPanel, PeriodPills, usePeriodScope, type PeriodPanelKey } from './PeriodControl'
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

  // THE PERIOD, AS THE INSIGHTS HUB ASKS IT — Year, Month and Date range,
  // three pills that expand this bar rather than a button that opened a
  // 380x590 calendar over the plan below. The arrangement and the rules are
  // planner/PeriodControl's, shared with the Hub and the alerts dialog on
  // Investigations, so the same question looks the same on all three.
  //
  // NO YEAR OR MONTH FIELD HERE. The planner's store holds a period as two
  // business weeks and nothing else, so no `onYear`/`onMonth` is passed and
  // every pick lands as the span it covers; the control works out which year
  // or month that span IS. There is no "All data" either -- the Studio always
  // plans inside some period -- which is why no `onClear` goes with it.
  const [panel, setPanel] = useState<PeriodPanelKey | null>(null)
  const period = usePeriodScope({
    calendar: options?.calendar ?? [],
    start,
    end,
    onApply: (from, to) => {
      setPeriod(from, to)
      setPanel(null)
    },
  })

  return (
    <div
      role="group"
      aria-label="Simulation Studio filters"
      className="rounded-[var(--r-lg)] border border-border-subtle bg-surface-card px-3 py-2.5 shadow-[var(--shadow-card-soft)]"
    >
      <div className="flex flex-wrap items-center gap-2">
      {options && start && end ? (
        periodLocked ? (
          // A promotion focus fixes the period, so it is stated rather than
          // offered. Three dead pills would read as controls that do nothing.
          <span
            className="inline-flex h-10 items-center gap-2 rounded-[var(--r-md)] border border-border-default bg-surface-muted px-3 text-base text-ink-secondary [&_svg]:h-4 [&_svg]:w-4"
            title={periodLocked}
          >
            <Icon name="calendar" />
            <span className="font-medium">Period</span>
            <span className="text-ink-primary">{period.labels.year}</span>
            <Icon name="lock" />
          </span>
        ) : (
          <PeriodPills scope={period} open={panel} onOpen={setPanel} controls="studio-period-panel" big />
        )
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

      {/* The open pill's choices, on a row inside the bar under a hairline —
          the Hub's arrangement, so the plan below is pushed down rather than
          painted over. */}
      {panel && !periodLocked && (
        <div
          id="studio-period-panel"
          role="region"
          aria-label={PERIOD_PANEL_TITLE[panel]}
          className="panel-enter mt-2.5 border-t border-border-subtle px-1 pb-1 pt-3"
        >
          <div className="mb-2 text-base font-medium text-ink-primary">{PERIOD_PANEL_TITLE[panel]}</div>
          <PeriodPanel scope={period} which={panel} />
        </div>
      )}
    </div>
  )
}
