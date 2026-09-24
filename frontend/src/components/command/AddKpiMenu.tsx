import { Button } from '../ui'
import { Icon } from '../../icons'
import { MultiSelect } from './MultiSelect'
import { ADDABLE_KPI_ORDER } from './kpiDeckState'
import type { KpiCard } from '../../types/commandCenter'

/** ADD A KPI CARD TO THE DECK, from the toolbar.
 *
 *  Three headline cards are always on screen — spend, what it returned, and
 *  the ratio of the two. The six beneath them explain those three rather than
 *  add to them, and a first-time reader should meet three numbers, not nine.
 *  So the six sit behind this control, and a reader picks the ones they want
 *  under the headline row; the choice is remembered per browser.
 *
 *  Same MultiSelect, same secondary Button and the same `pill` size as the
 *  Channels and Retailers pills beside it, so it reads as one more control on
 *  the row rather than a different kind of thing. Every name in the menu is the backend's own card
 *  label; nothing here names a KPI in code. */

/** "net_incremental_profit" -> "Net incremental profit", for the one render
 *  before a card's label has arrived. */
function humanise(key: string): string {
  const s = key.replace(/_/g, ' ')
  return s.charAt(0).toUpperCase() + s.slice(1)
}

export function AddKpiMenu({
  cards,
  selected,
  onToggle,
  onClear,
}: {
  cards: Record<string, KpiCard | undefined>
  selected: string[]
  onToggle: (key: string) => void
  onClear: () => void
}) {
  const options = ADDABLE_KPI_ORDER.map((key) => ({ code: key, name: cards[key]?.label ?? humanise(key) }))

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
          {/* "Add KPI", not "Add your KPI": the row has to hold seven controls
              and still end before Export, and the two dropped words bought
              the last of the width it needed. */}
          <span>Add KPI</span>
          {/* A count, not the names: six titles like "Net Incremental Profit"
              would push Export off the row. The cards themselves say what
              was added. */}
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
