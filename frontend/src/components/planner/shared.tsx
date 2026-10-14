import type { ComponentProps, ReactNode } from 'react'
import { STATUS } from '../calendar/statusColors'
import { Button } from '../ui'
import type { Direction, Impact, Offer } from '../../types/planner'

/** Small pieces every Simulation Studio panel shares -- the type scale, the
 *  controls and the breakdown list -- so every panel looks and behaves alike. */

/** THE STUDIO'S TYPE SCALE -- one style per role, on every panel.
 *
 *  LARGE AND LIGHT, SMALL AND MEDIUM: big figures are regular weight with
 *  tight tracking; labels are medium; section labels are small, muted and in
 *  sentence case. 30px for the one figure a card is about, 22px for values in
 *  boxes and the strip, 17px card titles, 15px for figures in tables and
 *  lists, 14px for words and controls, 13px for section labels. Controls are
 *  40px tall.
 *
 *    hero    the one figure a panel is about (the lever, the gain)
 *    value   a headline figure: tiles, answer cards
 *    cell    a figure in a table or a list
 *    delta   a change beside or under a figure
 *    label   what a figure is
 *    eyebrow a section label */
export const TYPE = {
  hero: 'kpi-value text-brand-violet',
  value: 'kpi-value text-ink-primary',
  cell: 'text-base text-ink-primary [font-variant-numeric:tabular-nums]',
  delta: 'text-base font-medium [font-variant-numeric:tabular-nums]',
  label: 'text-base font-medium text-ink-secondary',
  eyebrow: 'text-sm font-medium text-ink-muted',
} as const

/** Abbreviated money for an axis tick or a slider readout. Every figure that
 *  DESCRIBES a result is the backend's own display string; this only labels
 *  a ruler. */
export function axisMoney(v: number, rate: number, currency: string): string {
  const a = v * rate
  const symbol = currency === 'USD' ? '$' : '₹'
  const sign = a < 0 ? '-' : ''
  const m = Math.abs(a)
  if (currency !== 'USD') {
    if (m >= 1e7) return `${sign}${symbol}${(m / 1e7).toFixed(2)} Cr`
    if (m >= 1e5) return `${sign}${symbol}${(m / 1e5).toFixed(2)} L`
    if (m >= 1e3) return `${sign}${symbol}${(m / 1e3).toFixed(2)} K`
    return `${sign}${symbol}${m.toFixed(0)}`
  }
  if (m >= 1e6) return `${sign}${symbol}${(m / 1e6).toFixed(2)} M`
  if (m >= 1e3) return `${sign}${symbol}${(m / 1e3).toFixed(2)} K`
  return `${sign}${symbol}${m.toFixed(0)}`
}

/** Good news is green, bad news red. `lowerIsBetter` for spend. */
export function toneClass(direction: Direction, lowerIsBetter = false): string {
  if (direction === 'unchanged') return 'text-ink-muted'
  const good = (direction === 'up') !== lowerIsBetter
  return good ? 'text-status-success' : 'text-status-danger'
}

/** THE STUDIO'S CONTROL HEIGHT AND RADIUS -- every filter, segmented group and
 *  chip is 36px tall with the same radius and type, so the bar and the panels
 *  read as one set of controls. */
const CONTROL = 'h-10 text-base font-medium'

/** The shared Button at the Studio's control size (40px, 14px), so every
 *  button sits level with the filters, chips and segmented groups. */
export function StudioButton({ className = '', ...props }: ComponentProps<typeof Button>) {
  return <Button {...props} className={`!h-10 !text-base ${className}`} />
}

/** A segmented control: one bordered group, the active segment solid violet. */
export function Segmented<T extends string>({
  value,
  options,
  onChange,
  label,
  disabled,
}: {
  value: T
  options: { value: T; label: string; title?: string }[]
  onChange: (value: T) => void
  label: string
  disabled?: boolean
}) {
  return (
    <div
      role="radiogroup"
      aria-label={label}
      className={`inline-flex ${CONTROL} items-stretch overflow-hidden rounded-[var(--r-md)] border border-border-default bg-surface-card ${disabled ? 'opacity-60' : ''}`}
    >
      {options.map((o) => (
        <button
          key={o.value}
          type="button"
          role="radio"
          aria-checked={o.value === value}
          title={o.title}
          disabled={disabled}
          onClick={() => onChange(o.value)}
          className={`cursor-pointer border-r border-border-subtle px-3.5 transition-colors last:border-r-0 focus:outline-none focus-visible:ring-1 focus-visible:ring-brand-violet disabled:cursor-not-allowed ${
            o.value === value ? 'bg-brand-violet text-white' : 'text-ink-secondary hover:bg-brand-violet/[0.08] hover:text-brand-violet'
          }`}
        >
          {o.label}
        </button>
      ))}
    </div>
  )
}

/** A pill-shaped quick choice: the what-if steps, the target presets. */
export function QuickChip({
  active,
  onClick,
  title,
  children,
  accent,
}: {
  active?: boolean
  onClick: () => void
  title?: string
  children: ReactNode
  /** The violet outline used for a recommendation ("Best"). */
  accent?: boolean
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      title={title}
      aria-pressed={active}
      className={`inline-flex ${CONTROL} cursor-pointer items-center gap-1.5 rounded-full border px-3.5 transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-violet [&_svg]:h-4 [&_svg]:w-4 ${
        active
          ? 'border-brand-violet bg-brand-violet text-white'
          : accent
            ? 'border-brand-violet/50 bg-brand-violet-50 text-brand-violet hover:bg-brand-violet/15'
            : 'border-border-default bg-surface-card text-ink-secondary hover:border-brand-violet/40 hover:bg-brand-violet/[0.06] hover:text-brand-violet'
      }`}
    >
      {children}
    </button>
  )
}

/** A label above a control, for the rules rows. */
export function ControlGroup({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex flex-col gap-1.5">
      <span className={TYPE.eyebrow}>{label}</span>
      {children}
    </div>
  )
}

/** A bulleted list of figures: a coloured bullet, what it is, and the figure
 *  right-aligned. The breakdown of a re-plan, the what-if's facts. */
export interface FactItem {
  label: string
  value: string
  /** Bullet colour (CSS). */
  dot?: string
  tone?: string
  title?: string
}

export function FactList({ items }: { items: FactItem[] }) {
  return (
    <ul className="divide-y divide-border-subtle">
      {items.map((it) => (
        <li key={it.label} className="flex items-center gap-2.5 py-2.5" title={it.title}>
          <span className="h-2 w-2 shrink-0 rounded-full" style={{ background: it.dot ?? 'var(--border-strong)' }} />
          <span className={`min-w-0 flex-1 truncate ${TYPE.label}`}>{it.label}</span>
          <span className={`${TYPE.cell} ${it.tone ?? ''}`}>{it.value}</span>
        </li>
      ))}
    </ul>
  )
}

/** What a plan changes, in a glance: three tiles -- product-stores changed,
 *  promotions with a new discount, promotions moved to a new week, and how
 *  many of them do both (plus stopped / added when the count rule allows
 *  them). Plain words; the detail is in the table further down. */
export function PlanChanges({ impact }: { impact: Impact }) {
  const across = (n: number) => `Across ${n.toLocaleString()} product-stores`
  const tiles: { value: number; sub?: string; label: string; title: string }[] = [
    {
      value: impact.product_stores_affected,
      sub: `of ${impact.product_stores_total.toLocaleString()}`,
      label: 'product-stores change',
      title: 'A product-store is one product in one store. The rest keep their calendar as it is.',
    },
    { value: impact.discount_changed.promotions, label: 'promotions get a new discount', title: across(impact.discount_changed.product_stores) },
    { value: impact.shifted.promotions, label: 'promotions move to a new week', title: across(impact.shifted.product_stores) },
    {
      value: impact.shifted_and_repriced.promotions,
      label: 'of these move and get a new discount',
      title: `Counted in both boxes above. ${across(impact.shifted_and_repriced.product_stores)}`,
    },
  ]
  if (impact.stopped.promotions) tiles.push({ value: impact.stopped.promotions, label: 'loss-making promotions stopped', title: across(impact.stopped.product_stores) })
  if (impact.added.promotions) tiles.push({ value: impact.added.promotions, label: 'new promotions added', title: across(impact.added.product_stores) })
  return (
    <div className="grid grid-cols-2 gap-3">
      {tiles.map((t) => (
        <div key={t.label} title={t.title} className="rounded-[var(--r-md)] border border-border-subtle bg-surface-muted px-4 py-3.5">
          <div className={TYPE.value}>
            {t.value.toLocaleString()}
            {t.sub && <span className={`ml-1 ${TYPE.label} !text-ink-muted`}>{t.sub}</span>}
          </div>
          <div className={`mt-1 leading-snug ${TYPE.label}`}>{t.label}</div>
        </div>
      ))}
    </div>
  )
}

/** An offer's colour: the Calendar's own palette -- green for a regular
 *  offer, violet for a seasonal one -- deepening with the discount, so a
 *  lane of offers reads its depth at a glance and matches the calendar it
 *  came from. */
export function offerColor(offer: Pick<Offer, 'type' | 'depth_pct'>): { bg: string; fg: string; border: string } {
  const seasonal = offer.type === 'Seasonal'
  const solid = seasonal ? STATUS.seasonal.solid : STATUS.regular.solid
  // 5% -> 0.30, 25% -> 1.00 opacity.
  const strength = Math.max(0.3, Math.min(1, 0.3 + ((offer.depth_pct - 5) / 20) * 0.7))
  return {
    bg: `color-mix(in srgb, ${solid} ${Math.round(strength * 100)}%, transparent)`,
    fg: strength > 0.6 ? '#fff' : solid,
    border: solid,
  }
}

/** "+2.77 pts (+27.64%)" -- a discount change both ways: business readers mix
 *  points and relative change up. */
export function shiftText(pts: number, relative: number | null): string {
  const p = `${pts > 0 ? '+' : ''}${pts.toFixed(2)} pts`
  if (relative == null) return p
  return `${p} (${relative > 0 ? '+' : ''}${relative.toFixed(2)}%)`
}

export function StaleOverlay({ on, children }: { on: boolean; children: ReactNode }) {
  return <div className={on ? 'opacity-60 transition-opacity' : 'transition-opacity'}>{children}</div>
}

/** The card shell every panel uses: same border, radius, shadow, padding. */
export function Panel({ title, actions, children, className = '', tone }: { title?: ReactNode; actions?: ReactNode; children: ReactNode; className?: string; tone?: 'violet' }) {
  return (
    <section
      className={`rounded-[var(--r-lg)] border shadow-[var(--shadow-card-soft)] ${
        tone === 'violet' ? 'border-brand-violet-100 bg-brand-violet-50' : 'border-border-subtle bg-surface-card'
      } ${className}`}
    >
      {(title || actions) && (
        <header className="flex h-[64px] items-center justify-between gap-3 border-b border-border-subtle px-6">
          {title && <h3 className="text-md font-medium text-ink-primary">{title}</h3>}
          {actions}
        </header>
      )}
      <div className="p-6">{children}</div>
    </section>
  )
}
