import { Button } from '../../components/ui'
import { MultiSelect } from '../../components/command/MultiSelect'
import { Icon } from '../../icons'
import { MMM_ADDABLE_KPIS } from '../kpiDeck'
import type { MmmKpi } from '../types'

/** ADD A KPI CARD TO THE DECK — the control TPO's Insights Hub uses
 *  (components/command/AddKpiMenu.tsx): the same MultiSelect, secondary pill
 *  and count badge. Every name in the menu is the backend's own card label. */
export function MmmAddKpiMenu({
  kpis,
  selected,
  onToggle,
  onClear,
}: {
  kpis: MmmKpi[] | undefined
  selected: string[]
  onToggle: (key: string) => void
  onClear: () => void
}) {
  const label = (key: string) => kpis?.find((k) => k.key === key)?.label ?? key.replace(/_/g, ' ')
  const options = MMM_ADDABLE_KPIS.map((key) => ({ code: key, name: label(key) }))

  return (
    <MultiSelect
      label="KPI cards"
      options={options}
      selected={selected}
      allLabel="Headline three only"
      onToggle={onToggle}
      onClear={onClear}
      trigger={
        <Button variant="secondary" size="pill" className="cursor-pointer">
          <Icon name="plus" />
          <span>Add KPI</span>
          {selected.length > 0 && (
            <span className="rounded-[var(--r-pill)] bg-brand-violet-50 px-1.5 text-xs font-bold tabular-nums text-brand-violet">
              {selected.length}
            </span>
          )}
          <Icon name="chevronDown" />
        </Button>
      }
    />
  )
}
