import type { ReactNode } from 'react'
import { Button } from './Button'

/** ONE CHOICE INSIDE AN EXPANDED FILTER PANEL — the `sm` control, so a row of
 *  values reads as a set of values rather than as more toolbar.
 *
 *  Shared rather than copied: the Insights Hub's bar, the Simulation Studio's
 *  selection bar and the alerts dialog on Investigations all offer periods and
 *  dimensions this way, and three copies of a chip is how three pages end up
 *  with three slightly different ones. */
export function OptionChip({
  label,
  selected,
  onClick,
  title,
}: {
  label: string
  selected: boolean
  onClick: () => void
  title?: string
}) {
  return (
    <Button
      variant={selected ? 'primary' : 'secondary'}
      size="sm"
      className="cursor-pointer"
      aria-pressed={selected}
      title={title}
      onClick={onClick}
    >
      {label}
    </Button>
  )
}

/** A labelled row of chips inside a panel: "Year   [All data] [2024] …". The
 *  label is a fixed column so several rows line their chips up. */
export function ChipRow({ label, children }: { label: string; children: ReactNode }) {
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
