import { Icon, type IconName } from '../../icons'
import { STATUS, statusVars } from './statusColors'
import type { CalendarCell, CalendarMatrix, CellKind } from '../../types/promotionCalendar'

/** The Year x Month x Channel promotion grid.
 *
 *  One reusable component for every channel — never one calendar per
 *  channel. Every month column is the same width and every channel row shares
 *  the same twelve columns, so a promotion in October lines up across channels
 *  by eye.
 *
 *  Nothing here interprets promotion data. Labels, ids, counts and the `kind`
 *  bucket all arrive resolved from the backend, which reads
 *  dim_promotion_final.csv. */

/** Channel glyphs. Presentation only — a channel's icon is not a data
 *  attribute and cannot be sourced from the dimension. */
const CHANNEL_ICON: Record<string, IconName> = {
  CH001: 'shoppingCart',
  CH002: 'retailer',
  CH003: 'retailer',
  CH004: 'layers',
  CH005: 'database',
  CH006: 'zap',
}

/** Cell chrome. Colour comes from `statusColors`; these classes only say WHERE
 *  it goes — tint behind, accent on the border, solid on the title. */
const CELL_SURFACE =
  'border-[var(--st-border)] bg-[var(--st-tint)] hover:bg-[var(--st-hover)]'

export const LEGEND: { kind: CellKind; label: string }[] = [
  { kind: 'regular', label: 'Regular Promotion' },
  { kind: 'seasonal', label: 'Seasonal Promotion' },
  { kind: 'festival', label: 'Multi-event Month' },
  { kind: 'none', label: 'No Promotion' },
  { kind: 'no_data', label: 'No data yet' },
]

/** Drop a trailing two-digit year token from the promotion master's own
 *  description, for the CELL only: "Dussehra Deal 25" -> "Dussehra Deal".
 *
 *  A display transform of the real string, not a lookup table — the year is
 *  already the column the cell sits in, so repeating it costs a line of wrap in
 *  a 74px cell. The untouched description stays in the tooltip and in the
 *  detail panel. */
function cellLabel(label: string): string {
  return label
    .split(' + ')
    .map((part) => part.replace(/\s+\d{2}$/, ''))
    .join(' + ')
}

/** A solid semantic dot — the legend and the details panel share it, so the
 *  indicator a user learns in the legend is the same mark everywhere. */
export function LegendSwatch({ kind }: { kind: CellKind }) {
  return (
    <span
      className="inline-block h-2.5 w-2.5 shrink-0 rounded-full"
      style={{ background: STATUS[kind].solid }}
    />
  )
}

export function PromotionMatrix({
  data,
  selected,
  onSelect,
}: {
  data: CalendarMatrix
  selected: { month: number; channel: string } | null
  onSelect: (month: number, channel: string) => void
}) {
  // Fixed channel column plus twelve equal month columns. `min-w` forces the
  // horizontal scroll to happen INSIDE this container rather than on the page.
  const grid = 'grid grid-cols-[168px_repeat(12,minmax(74px,1fr))]'

  return (
    <div className="overflow-x-auto">
      <div className="min-w-[1056px]">
        <div className={`${grid} border-b border-border-subtle`}>
          {/* Sticky so the channel stays readable while the months scroll —
              without it a horizontally scrolled row is unattributable. */}
          <div className="sticky left-0 z-20 bg-surface-card px-3 py-2.5 text-xs font-medium text-ink-muted">
            Channel
          </div>
          {data.months.map((m) => (
            <div
              key={m.month}
              /* The month being viewed is marked here as well as on the cell,
                 so the column stays identifiable while the eye is in the panel. */
              className={`px-1 py-2.5 text-center text-sm font-medium transition-colors ${
                selected?.month === m.month
                  ? 'rounded-t-[var(--r-sm)] bg-brand-violet/[0.08] text-brand-violet'
                  : 'text-ink-secondary'
              }`}
              title={m.name}
            >
              {m.abbr}
            </div>
          ))}
        </div>

        {data.channels.map((channel) => (
          <div key={channel.channel_id} className={`${grid} border-b border-border-subtle last:border-b-0`}>
            <div className="sticky left-0 z-20 flex items-center gap-2 border-r border-border-subtle bg-surface-card px-3 py-2">
              <span className="grid h-7 w-7 shrink-0 place-items-center rounded-[8px] bg-brand-violet/[0.08] text-brand-violet [&_svg]:h-3.5 [&_svg]:w-3.5">
                <Icon name={CHANNEL_ICON[channel.channel_id] ?? 'grid'} />
              </span>
              <span className="min-w-0">
                <span className="block text-sm font-medium text-ink-primary">{channel.channel_id}</span>
                <span className="block truncate text-xs text-ink-muted" title={channel.name}>
                  {channel.name}
                </span>
                {/* Cadence is deliberately loud: a weekly channel's monthly
                    cell is a SUMMARY of several promotions, a monthly
                    channel's is the plan itself. */}
                <span
                  title={channel.booking === 'week' ? 'Promotions run as single weeks in a store' : 'Promotions run for a whole month in a store'}
                  className={`mt-0.5 inline-block rounded-full px-1.5 py-px text-2xs font-medium ${
                    channel.booking === 'week'
                      ? 'bg-status-info/10 text-status-info'
                      : 'bg-ink-primary/[0.06] text-ink-muted'
                  }`}
                >
                  {channel.booking === 'week' ? 'Weekly' : 'Monthly'}
                </span>
              </span>
            </div>

            {channel.cells.map((cell) => (
              <MatrixCell
                key={cell.month}
                cell={cell}
                selected={selected?.month === cell.month && selected?.channel === channel.channel_id}
                onClick={() => onSelect(cell.month, channel.channel_id)}
              />
            ))}
          </div>
        ))}
      </div>
    </div>
  )
}

function MatrixCell({
  cell,
  selected,
  onClick,
}: {
  cell: CalendarCell
  selected: boolean
  onClick: () => void
}) {
  const ids = cell.promotion_ids.join(' + ')
  const tooltip = [
    cell.label,
    ids || '—',
    `${cell.product_count} products · ${cell.store_count} stores · ${cell.week_count} weeks`,
    cell.extra_regular > 0 ? `+${cell.extra_regular} regular promotion${cell.extra_regular > 1 ? 's' : ''}` : '',
  ]
    .filter(Boolean)
    .join('\n')

  if (cell.kind === 'no_data') {
    return (
      <div
        title="The data does not reach this month yet"
        className="m-1 flex min-h-[80px] items-center justify-center rounded-[var(--r-sm)] border border-dashed border-border-subtle text-2xs font-medium text-ink-disabled"
      >
        No data
      </div>
    )
  }

  return (
    <button
      type="button"
      onClick={onClick}
      title={tooltip}
      aria-pressed={selected}
      style={statusVars(cell.kind)}
      className={`m-1 flex min-h-[80px] cursor-pointer flex-col justify-center gap-[3px] rounded-[var(--r-sm)] border px-1.5 py-1.5 text-left transition-[background,box-shadow,border-color] duration-150 hover:shadow-[var(--shadow-sm)] focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-violet ${CELL_SURFACE} ${
        selected ? 'ring-2 ring-brand-violet ring-offset-1 ring-offset-surface-card' : ''
      }`}
    >
      {/* Wrapped over two lines rather than truncated: the label is the
          promotion master's own Promotion_Description, and shortening it here
          would mean inventing a name the data does not carry. */}
      <span
        className="line-clamp-2 text-2xs font-medium leading-[1.15] [overflow-wrap:anywhere]"
        style={{ color: STATUS[cell.kind].solid }}
      >
        {cellLabel(cell.label)}
      </span>
      {/* The id is the secondary line: smaller and quieter than the name it
          belongs to, so the eye reads name -> id -> count in that order. */}
      <span className="line-clamp-2 text-2xs font-medium leading-[1.15] text-ink-muted">
        {ids || '—'}
      </span>
      {/* The count alone; concurrent regular activity is in the tooltip and
          spelled out in the detail panel, where there is room for it. */}
      <span className="truncate text-2xs font-medium leading-tight text-ink-secondary">
        {cell.product_count} products
      </span>
    </button>
  )
}
