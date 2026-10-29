import type { Band, Deltas, Direction, Figures, Trio } from '../../types/planner'
import { TYPE } from './shared'

/** The current plan beside a plan, figure by figure.
 *
 *  NOT A GRID OF COLUMNS. As a table this was four columns of near-identical
 *  numbers and a fifth of changes: ten rows deep, scrolling inside its panel,
 *  with nothing on it heavier than anything else -- Profit read exactly like
 *  Units -- and when the plan had not moved the Change column was a wall of
 *  em-dashes. The figures are of different kinds anyway (crores, per cents, a
 *  multiple, counts), so a column of digits was never really scannable down
 *  its length.
 *
 *  ONE CARD PER FIGURE, AND EVERY FIGURE CARRIES EVERY NUMBER. The plan's own
 *  value large, its change tinted beside it, then one aligned block: the
 *  modelled range, the zero point, and the plan being replaced. The card is
 *  the unit of reading, so nothing in it is a lookup into another part of the
 *  panel -- a reader never has to hold a column header in their head.
 *
 *  THE FIRST FIGURE ASKED FOR LEADS, at full width: profit, in all three
 *  places this is used. It is the same three numbers as any other card, set
 *  out as a comparison rather than packed into one -- the plan's figure with
 *  its change and range, and the two it is read against standing beside it at
 *  the same size, so the three can be read across in one line.
 *
 *  AND THE RANGES SAY WHAT THEY ARE. "₹463.17 Cr – ₹464.97 Cr" under a figure
 *  was identified only by a hover, so it read as a second, unexplained pair of
 *  numbers; every one is now labelled P10 - P90, and what those percentiles
 *  were taken over is stated once at the foot. */

type RowKey = keyof Figures

/** `neutral`: a change that is neither good nor bad news in itself. */
type Row = { key: RowKey; label: string; delta?: keyof Deltas; lowerIsBetter?: boolean; neutral?: boolean }

/** Ordered so related figures sit together -- what the plan earns, then what
 *  it costs to earn, then what it actually runs. The order does the grouping;
 *  heading rows were tried and only added furniture. */
const ROWS: Row[] = [
  { key: 'profit', label: 'Profit', delta: 'profit' },
  { key: 'profit_pct', label: 'Profit %', delta: 'profit_pct' },
  { key: 'margin_pct', label: 'Gross margin', delta: 'margin_pct' },
  { key: 'trade_spend', label: 'Trade spend', delta: 'trade_spend', lowerIsBetter: true },
  { key: 'incremental_sales', label: 'Incremental sales', delta: 'incremental_sales' },
  { key: 'roi', label: 'ROI', delta: 'roi' },
  { key: 'revenue', label: 'Revenue', delta: 'revenue' },
  { key: 'units', label: 'Units', delta: 'units' },
  { key: 'avg_discount', label: 'Average discount', delta: 'avg_discount', neutral: true },
  { key: 'promotions', label: 'Promotions', delta: 'promotions', neutral: true },
]

export interface CompareColumn {
  title: string
  sub?: string
  figures: Figures
  deltas?: Deltas
  /** Kept for the callers that set it; it no longer changes anything here.
   *  It used to tint the plan's figures, and the app has one text colour. */
  recommended?: boolean
  /** A reference column rather than a plan -- the no-promotion baseline. */
  muted?: boolean
  /** The plan's Monte Carlo ranges (P10 - P90). */
  band?: Band | null
}

/** Which of a band's ranges belongs to a row. */
const BAND_OF: Partial<Record<RowKey, keyof Band>> = {
  profit: 'profit',
  profit_pct: 'profit_pct',
  revenue: 'revenue',
  trade_spend: 'trade_spend',
  roi: 'roi',
  incremental_sales: 'incremental_sales',
  units: 'units',
  margin_pct: 'margin_pct',
}

/** Rows the plan FIXES rather than models. The average discount and the number
 *  of promotions are decisions, not outcomes: every Monte Carlo draw sees the
 *  same ones, so their P10, P50 and P90 are the one value. Printing a dash
 *  there read as "we could not work it out" when the truth is "there is
 *  nothing to vary", so they are marked as what they are instead: set, not
 *  modelled. */
const EXACT: ReadonlySet<RowKey> = new Set<RowKey>(['avg_discount', 'promotions'])

type DeltaText = { text: string; percent: string | null; direction: Direction }

/** The change, split rather than packed. "+₹4.28 Cr (+0.93%)" put two numbers
 *  of different kinds in one breath; the amount leads and the relative change
 *  trails it, quieter, where it reads as a qualifier. */
function deltaText(d: Deltas[keyof Deltas] | undefined): DeltaText | null {
  if (!d || !('direction' in d)) return null
  if ('percent_display' in d) {
    return {
      text: d.absolute.display,
      percent: d.percent == null ? null : d.percent_display,
      direction: d.direction,
    }
  }
  return { text: d.absolute_display, percent: null, direction: d.direction }
}

/** `toneClass`'s tint: the same good/bad decision, as a fill plus ink rather
 *  than ink alone. The pair the KPI cards on both hubs use for a delta. */
function toneTint(direction: Direction, lowerIsBetter = false): string {
  if (direction === 'unchanged') return 'bg-ink-primary/[0.06] text-ink-muted'
  const good = (direction === 'up') !== lowerIsBetter
  return good ? 'bg-status-success/10 text-status-success' : 'bg-status-danger/10 text-status-danger'
}

/** THE CHANGE IS THE ANSWER, so it is the one mark on a card carrying a fill
 *  -- the same tinted pill the KPI cards on both hubs use for a delta, so the
 *  whole panel can be taken in by its greens and reds without reading a single
 *  number. Nothing is drawn for a figure that has not moved. */
function DeltaPill({ d, row }: { d: DeltaText; row: Row }) {
  return (
    <span
      className={`inline-flex items-baseline gap-1.5 rounded-[var(--r-sm)] px-2 py-0.5 ${TYPE.delta} ${
        row.neutral ? 'bg-ink-primary/[0.06] text-ink-secondary' : toneTint(d.direction, row.lowerIsBetter)
      }`}
    >
      <span className="whitespace-nowrap">{d.text}</span>
      {d.percent && <span className="whitespace-nowrap text-sm font-normal opacity-80">{d.percent}</span>}
    </span>
  )
}

/** One line of a card's footing: a named figure, label left and value right.
 *
 *  THE SAME LINE THE LEVER PANEL'S "At a glance" USES, deliberately: the two
 *  panels sit side by side, so a named figure has to look the same in both or
 *  the page reads as two designs. That means `FactList`'s pairing -- the name
 *  in the label role, the figure in the cell role -- and its ruled rows, at a
 *  tighter rhythm because these sit inside a card rather than down a column.
 *
 *  NAMED IS THE POINT. Unlabelled, the range read as a second figure and the
 *  comparisons read as figures with no owner. NOTHING WRAPS, either: a card is
 *  a column of a grid, and "Current plan · 17.49%" against "₹52.37 Cr" broke
 *  over two lines each way, the name onto a second line and the amount away
 *  from its own unit. */
function Note({ label, value, title }: { label: string; value: string; title?: string }) {
  return (
    <li className="flex items-baseline justify-between gap-3 py-1.5" title={title}>
      <span className={`min-w-0 flex-1 truncate ${TYPE.label}`}>{label}</span>
      <span className={`whitespace-nowrap ${TYPE.cell}`}>{value}</span>
    </li>
  )
}

export function FigureCompare({ columns, rows }: { columns: CompareColumn[]; rows?: RowKey[] }) {
  const shown = rows ? ROWS.filter((r) => rows.includes(r.key)) : ROWS
  //: The plan being judged: the one carrying changes, or failing that the last
  //: given. Everything else is what it is read against.
  const plan = columns.find((c) => c.deltas) ?? columns[columns.length - 1]
  const refs = columns.filter((c) => c !== plan)
  const changed = columns.filter((c) => c.deltas)

  if (!plan || shown.length === 0) return null

  const band = plan.band ?? null
  const trioOf = (key: RowKey): Trio | null =>
    band && BAND_OF[key] ? ((band[BAND_OF[key]!] as Trio | null) ?? null) : null
  const rangeTitle = band ? `10th to 90th percentile over ${band.draws.toLocaleString()} Monte Carlo draws` : undefined
  const deltaOf = (row: Row): DeltaText | null => (plan.deltas && row.delta ? deltaText(plan.deltas[row.delta]) : null)

  /** The spread line for a row: its modelled range, or -- for a row the plan
   *  sets rather than models -- the fact that it was set. */
  const spreadOf = (key: RowKey) => {
    if (!band) return null
    const trio = trioOf(key)
    if (trio) return { label: 'P10 – P90', value: trio.display, title: rangeTitle }
    if (EXACT.has(key)) return { label: 'Set by the plan', value: 'not modelled' }
    return null
  }

  /** Every figure on screen matches what it is compared with. With no pills
   *  drawn the panel would simply go quiet, so it says so once, in words. */
  const nothingMoved =
    changed.length === 1 &&
    shown.every((r) => {
      const d = r.delta ? deltaText(changed[0].deltas![r.delta]) : null
      return !d || d.direction === 'unchanged'
    })

  const [lead, ...rest] = shown
  const leadDelta = deltaOf(lead)
  const leadSpread = spreadOf(lead.key)
  //: NO INK ROLE HERE, DELIBERATELY. index.css flattens every `text-ink-*`,
  //: `text-brand-*` and `text-status-*` class in the app to the one body
  //: colour (the rule is unlayered, so it outranks the utility), and the only
  //: exceptions are a figure that is wholly signed -- which `signColor`
  //: tags, and which is what makes the change pills green and red -- and
  //: `data-accent`. So the lead figure is marked by its surface and its rule,
  //: and a card's name by its weight. Writing `text-brand-violet` here would
  //: render as body text and read, in the source, as an accent that exists.
  //: What the change is a change FROM: the plan being replaced rather than the
  //: zero point. Said once, beside the pill, instead of left to be inferred.
  const against = refs.find((c) => !c.muted) ?? refs[0]

  return (
    <div className="grid gap-3">
      {/* THE LEAD FIGURE, AS A COMPARISON RATHER THAN A CARD. The plan's
          profit, the profit of the plan it replaces and the profit of
          promoting nothing at all are one question asked three ways, so they
          are set out side by side at the same size, divided, and read across.
          A rail was tried here and drawn honestly: at these spreads it was a
          few ticks in a wide empty gutter, which flattered neither the figures
          nor the panel. The numbers say it better than a 6px bar can. */}
      <div className="rounded-[var(--r-md)] border border-l-[3px] border-border-subtle border-l-brand-violet bg-surface-muted px-5 py-4">
        {/* THE THREE SHARE THE WIDTH. Packed to the left they left a third of
            the card empty and the dividers fell wherever the longest figure
            happened to end; given shares of the row, the rules land at the
            same two places whatever the figures are, and the card reads as
            three columns of one comparison rather than a line that stopped. */}
        <div className="flex flex-wrap items-stretch gap-x-6 gap-y-5">
          <div className="min-w-[240px] flex-[1.6]">
            <div className={TYPE.eyebrow}>
              {lead.label} · {plan.title}
              {plan.sub && <span className="font-normal"> · {plan.sub}</span>}
            </div>
            <div className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1.5">
              <span className="kpi-value">{plan.figures[lead.key].display}</span>
              {leadDelta && leadDelta.direction !== 'unchanged' && <DeltaPill d={leadDelta} row={lead} />}
              {leadDelta && leadDelta.direction !== 'unchanged' && against && (
                <span className={TYPE.eyebrow}>vs {against.title.toLowerCase()}</span>
              )}
            </div>
            {leadSpread && (
              <div className="mt-1.5 flex items-baseline gap-2" title={leadSpread.title}>
                <span className={TYPE.eyebrow}>{leadSpread.label}</span>
                <span className={TYPE.cell}>{leadSpread.value}</span>
              </div>
            )}
          </div>

          {/* The same figure for every plan it is read against, at the same
              size as the lead's own and in the reading ink, so the three can
              be compared without one of them shouting. */}
          {refs.map((c) => (
            <div key={c.title} className="min-w-[160px] flex-1 border-l border-border-subtle pl-6">
              <div className={TYPE.eyebrow}>
                {c.title}
                {c.sub && <span className="font-normal"> · {c.sub}</span>}
              </div>
              <div className="mt-1.5 kpi-value">{c.figures[lead.key].display}</div>
            </div>
          ))}
        </div>
      </div>

      {/* ONE CARD PER FIGURE, laid out on the element's own width rather than
          on a breakpoint: these panels are half a row wide in the Studio and
          the full width in focus, and auto-fit lets the same block be three
          columns in one and four in the other without being told about it.
          250px, MEASURED AT THE DEMO RESOLUTION, not guessed at a developer's
          monitor: at 1366 x 768 and 90% zoom this grid is 835px wide, where a
          280px minimum falls back to two columns of 412 -- eight cards in four
          rows, each nearly twice as wide as its content needs, and a panel so
          much taller than the lever beside it that the page ends in a field of
          white. At 250 the same width takes three. */}
      <div className="grid gap-3" style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(250px, 1fr))' }}>
        {rest.map((row) => {
          const d = deltaOf(row)
          const spread = spreadOf(row.key)
          return (
            // A COLUMN WITH THE FOOTING PUSHED DOWN, so that whatever each
            // card carries above it -- a pill that wrapped, or none -- the
            // named figures sit on one level right across a row.
            <div
              key={row.key}
              className="flex flex-col rounded-[var(--r-md)] border border-border-subtle bg-surface-card px-4 py-3.5"
            >
              <div className={TYPE.label}>{row.label}</div>
              <div className="mt-1 flex flex-wrap items-center gap-x-2.5 gap-y-1.5">
                <span className="kpi-value">{plan.figures[row.key].display}</span>
                {d && d.direction !== 'unchanged' && <DeltaPill d={d} row={row} />}
              </div>
              {/* THE RANGE GETS ITS OWN TWO LINES, unlike the comparisons
                  under it. At the width three columns gives, a label and
                  "₹102.42 Cr – ₹107.80 Cr" do not fit on one line together --
                  the label was the thing that gave way, truncating to "P10 –
                  …". The comparisons are short enough to stay as pairs. */}
              {spread && (
                <div className="mt-1.5" title={spread.title}>
                  <div className={TYPE.eyebrow}>{spread.label}</div>
                  <div className={`whitespace-nowrap ${TYPE.cell}`}>{spread.value}</div>
                </div>
              )}
              <div className="mt-auto pt-2">
                <ul className="divide-y divide-border-subtle border-t border-border-subtle">
                  {refs.map((c) => (
                    <Note key={c.title} label={c.title} value={c.figures[row.key].display} />
                  ))}
                </ul>
              </div>
            </div>
          )
        })}
      </div>

      {/* SAID ONCE, AT THE FOOT. Every card shows a P10 - P90; what those
          percentiles were taken over belongs here rather than nine times over
          in a hover. */}
      {(band || nothingMoved) && (
        <div className={`grid gap-1 ${TYPE.eyebrow} !font-normal`}>
          {nothingMoved && <p>Every figure matches what it is compared with — nothing in this plan has moved yet.</p>}
          {band && (
            <p>P10 – P90 is the range 8 of every 10 of {band.draws.toLocaleString()} simulations fall inside.</p>
          )}
        </div>
      )}
    </div>
  )
}
