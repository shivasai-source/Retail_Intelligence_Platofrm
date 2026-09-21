import { Icon, type IconName } from '../../icons'
import { InfoBlock, InfoPopover } from './InfoPopover'

// Ported from css/tpo.css .tpo-kpi-grid / .tpo-kpi* — the icon-leading KPI tile used
// across the 5 main pages (Insights Hub, Investigations, Intelligence, Simulation,
// Decision), distinct from the generic `.kpi` tile (see ui/Kpi.tsx) used elsewhere
// (e.g. the simulate-recommendation modal).
const TINTS: Record<string, { bg: string; fg: string }> = {
  lavender: { bg: '#ECE6FF', fg: '#7C5CFF' },
  sky: { bg: '#E1ECFF', fg: '#4F7CFF' },
  violet: { bg: '#ECE6FF', fg: '#6B47FF' },
  amber: { bg: '#FEF1D7', fg: '#F59E0B' },
  mint: { bg: '#D8F3E6', fg: '#10B981' },
  rose: { bg: '#FFE4E6', fg: '#F43F5E' },
  // The Insights Hub's second row. Three tints the first row does not use,
  // so the nine cards stay tellable apart at a glance.
  teal: { bg: '#CCEFE9', fg: '#14B8A6' },
  peach: { bg: '#FFE4D1', fg: '#F97316' },
  lemon: { bg: '#FFF4CF', fg: '#CA8A04' },
}

// Six columns: the Insights Hub carries six addable KPI cards, and a reader
// who adds all six should get one row of them, not two. Six holds down to a
// 1180px container — a 1366px screen with the rail open — where each tile is
// still ~195px, room for its icon, value and movement; narrower than that the
// grid drops to three, then to two. The grid carries no bottom margin: the
// page owns the vertical rhythm between bands, so every gap is stated in one
// place. Breakpoints resolve against <main> (container queries), not the
// viewport.
export function TpoKpiGrid({ children }: { children: React.ReactNode }) {
  return (
    <div className="grid grid-cols-6 gap-4 @max-[1180px]:grid-cols-3 @max-[900px]:grid-cols-2">{children}</div>
  )
}

export interface KpiInfo {
  name: string
  formula: string
  meaning: string
}

/** The KPI card's ⓘ. THE FORMULA, AND ONLY THE FORMULA — the definition,
 *  not documentation. It used to carry the selection's inputs and a unit
 *  line too, and read as a small report; a reader who opens an ⓘ wants to
 *  know what the number is. Rendered through the shared InfoPopover so it
 *  is identical in size, placement and styling to every other info button
 *  on the page. */
function InfoDot({ info }: { info: KpiInfo }) {
  return (
    <InfoPopover label={`About ${info.name}`} title={info.name} width={232}>
      <InfoBlock label="Formula">{info.formula}</InfoBlock>
    </InfoPopover>
  )
}


export function TpoKpiTile({
  label,
  value,
  delta,
  deltaSub,
  trend,
  icon,
  tint,
  accent,
  delayMs = 0,
  info,
  lowerIsBetter = false,
  className = '',
  labelLines = 1,
}: {
  label: string
  value: string
  delta: string
  deltaSub: string
  /** null when there is no comparison period — the arrow is then omitted
   *  entirely rather than defaulting to a direction the data cannot support. */
  trend: 'up' | 'down' | null
  icon: IconName
  tint: string
  /** CSS colour for the hover accent along the card's bottom edge. Omitted
   *  means no accent — every other surface using this tile is unchanged. */
  accent?: string
  delayMs?: number
  info?: KpiInfo
  /** Trade Spend and Cannibalization improve as they fall, so a rise is not
   *  good news. Direction and desirability are separate facts. */
  lowerIsBetter?: boolean
  /** Grid placement only — a headline tile passes its column span. The
   *  tile itself never changes size: one card, one shape, everywhere. */
  className?: string
  /** How many lines the label may take. 1 truncates (the default every
   *  other page keeps); 2 wraps and reserves the space so a whole row of
   *  tiles keeps its values on one baseline. */
  labelLines?: 1 | 2
}) {
  const t = TINTS[tint] ?? { bg: 'var(--brand-violet-50)', fg: 'var(--brand-violet)' }
  const isGood = trend === null ? null : (trend === 'up') !== lowerIsBetter
  const tone = isGood === null ? 'text-ink-muted' : isGood ? 'text-status-success' : 'text-status-danger'

  return (
    // `[animation-fill-mode:backwards]` is load-bearing. `fade-in-up` ships as
    // `both`, which keeps its final `translateY(0)` applied forever — and an
    // animation's transform beats a hover rule, so the lift below would
    // silently never happen. `backwards` still applies the first keyframe
    // BEFORE the animation (so the entrance is unchanged) but releases the
    // element afterwards.
    //
    // Only transform and shadow move, so hovering can never change the card's
    // box or shift the grid. The transform is behind `motion-safe`, leaving
    // just the shadow under prefers-reduced-motion.
    <div
      className={`fade-in-up group/kpi relative flex items-center gap-3 rounded-[var(--r-lg)] border border-border-subtle bg-surface-card p-[16px_18px] shadow-[var(--shadow-card-soft)] transition-[transform,box-shadow,border-color] duration-[220ms] ease-[cubic-bezier(0.22,1,0.36,1)] [animation-fill-mode:backwards] hover:border-border-default hover:shadow-[0_6px_16px_rgba(0,0,0,0.12)] motion-safe:hover:-translate-y-[3px] motion-safe:hover:scale-[1.005] ${className}`}
      style={{ animationDelay: `${delayMs}ms` }}
    >
      {/* Top-right, and out of the label's flex row so a long label can use the
          full width before truncating. */}
      {info && (
        <span className="absolute right-2.5 top-2.5 z-10">
          <InfoDot info={info} />
        </span>
      )}
      <div
        className="grid h-11 w-11 shrink-0 place-items-center rounded-xl transition-transform duration-[220ms] ease-[cubic-bezier(0.22,1,0.36,1)] motion-safe:group-hover/kpi:scale-[1.04] [&_svg]:h-5 [&_svg]:w-5"
        style={{ background: t.bg, color: t.fg }}
      >
        <Icon name={icon} />
      </div>
      <div className="min-w-0 flex-1">
        {/* `labelLines: 2` reserves two lines for EVERY tile in the row and
            bottom-aligns the label inside them, so a name that wraps
            ("Promotion Efficiency Index" on a six-column row) and one that
            does not still put their values on the same baseline. The
            default keeps the single-line tile every other page renders. */}
        <div
          className={`flex gap-1 pr-4 text-sm font-medium leading-tight text-ink-muted transition-colors duration-[220ms] group-hover/kpi:text-brand-violet ${
            labelLines === 2 ? 'min-h-[2.5em] items-end' : 'items-center'
          }`}
        >
          <span className={labelLines === 2 ? 'line-clamp-2 break-words' : 'truncate'}>{label}</span>
        </div>
        <div className="mt-2.5 text-xl font-bold leading-[1.15] tracking-[-0.015em] text-ink-primary opacity-90 transition-opacity duration-[220ms] group-hover/kpi:opacity-100 [font-variant-numeric:tabular-nums]">
          {value}
        </div>
        <div className="mt-2.5 inline-flex items-center gap-1 text-sm text-ink-muted [&_svg]:h-3 [&_svg]:w-3">
          {trend && <Icon name={trend === 'up' ? 'arrowUp' : 'arrowDown'} className={tone} />}
          <span>
            <strong className={`font-bold ${tone}`}>{delta}</strong> {deltaSub}
          </span>
        </div>

      </div>

      {/* THE HOVER ACCENT. A 3px rule along the bottom edge that grows out of the
          centre to both sides.

          `scale-x` ONLY, on an absolutely-positioned element: the bar is out of
          flow, so it cannot move the card's box, its siblings or the grid — and
          `transform` is off the layout path regardless. Nothing about the card's
          size, spacing or type changes.

          Inset by the card's own corner radius so the bar's ends stop short of
          the rounded corners instead of poking past the outline — the card sets
          no `overflow`, and clipping it would have caught the icon's hover
          scale too.

          `motion-reduce:transition-none` leaves the accent fully visible on
          hover for a reader who has asked for less motion; only the growth
          goes. */}
      {accent && (
        <span
          aria-hidden="true"
          className="pointer-events-none absolute inset-x-[var(--r-lg)] bottom-0 h-[3px] scale-x-0 rounded-full transition-transform duration-[260ms] ease-[cubic-bezier(0.22,1,0.36,1)] group-hover/kpi:scale-x-100 motion-reduce:transition-none"
          style={{ background: accent }}
        />
      )}
    </div>
  )
}
