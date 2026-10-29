import type { Band, Deltas, Direction, Figures, Trio } from '../../types/planner'
import { TYPE } from './shared'

/** The current plan beside a plan, figure by figure.
 *
 *  One row per figure: its name, the current value, the plan's value and the
 *  change -- green when it is good news (spend is good news when it FALLS) --
 *  then, for a modelled plan, its P10 - P90 over the Monte Carlo draws.
 *  Every value and change is the backend's display string, in the Studio's
 *  one type scale. */

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
  recommended?: boolean
  /** A reference column rather than a plan -- the no-promotion baseline. Set
   *  in the secondary ink so the eye lands on the two real plans first. */
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
 *  nothing to vary", so the value itself is shown instead, marked exact. */
const EXACT: ReadonlySet<RowKey> = new Set<RowKey>(['avg_discount', 'promotions'])

/** The change, split rather than packed. "+₹4.28 Cr (+0.93%)" put two
 *  numbers of different kinds on one line, so no column of digits lined up and
 *  the eye could not scan down either one. The amount keeps the column; the
 *  relative change sits under it, quieter, where it reads as a qualifier. */
function deltaText(
  d: Deltas[keyof Deltas] | undefined,
): { text: string; percent: string | null; direction: 'up' | 'down' | 'unchanged' } | null {
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

export function FigureCompare({ columns, rows }: { columns: CompareColumn[]; rows?: RowKey[] }) {
  const shown = rows ? ROWS.filter((r) => rows.includes(r.key)) : ROWS
  const changed = columns.filter((c) => c.deltas)
  /** Every figure on screen matches what it is compared with — ten dashes down
   *  the Change column, which reads as a table that failed rather than as an
   *  answer. Said once, in words, instead. */
  const nothingMoved =
    changed.length === 1 && shown.length > 0 && shown.every((r) => !r.delta || !deltaText(changed[0].deltas![r.delta]) || deltaText(changed[0].deltas![r.delta])!.direction === 'unchanged')
  //: The column the band belongs to -- the modelled plan. Its own figures
  //: stand in for the rows the plan fixes rather than models (see EXACT).
  const modelled = columns.find((c) => c.band) ?? null
  const band = modelled?.band ?? null
  // Framed, banded and ruled like "Promotions that change" below it -- the
  // page had two kinds of table, one with a header band and a border and one
  // with neither, and the eye read the unbordered one as loose text rather
  // than as a table to scan down.
  return (
    <div className="overflow-x-auto rounded-[var(--r-md)] border border-border-subtle">
      <table className={`w-full ${columns.length > 2 ? 'min-w-[620px]' : 'min-w-[520px]'}`}>
        <thead className="bg-surface-muted">
          <tr className="border-b border-border-subtle">
            <th className={`${columns.length > 2 ? 'w-[22%]' : 'w-[26%]'} px-4 py-2.5 text-left align-bottom ${TYPE.eyebrow}`}>
              Figure
            </th>
            {columns.map((c) => (
              <th key={c.title} className="px-4 py-2.5 text-right align-bottom">
                <div className={`${TYPE.eyebrow} ${c.recommended ? '!text-brand-violet' : ''}`}>{c.title}</div>
                {c.sub && <div className={`mt-0.5 ${TYPE.eyebrow} !font-normal`}>{c.sub}</div>}
              </th>
            ))}
            {changed.length === 1 && (
              <th className={`px-4 py-2.5 text-right align-bottom ${TYPE.eyebrow}`}>Change</th>
            )}
          </tr>
        </thead>
        <tbody>
          {shown.map((row) => {
            const d = changed.length === 1 && row.delta ? deltaText(changed[0].deltas![row.delta]) : null
            return (
              <tr key={row.key} className="border-b border-border-subtle last:border-b-0">
                <td className={`px-4 py-3 ${TYPE.label}`}>{row.label}</td>
                {columns.map((c) => {
                  // THE RANGE BELONGS TO THE FIGURE IT IS THE RANGE OF, so it
                  // sits under that figure rather than in a column of its own
                  // at the far right. As a column it was the sixth thing on a
                  // row, and the first to be cut off: at this panel's width
                  // the table overflowed and "₹463.86 Cr – ₹465.34 Cr" was
                  // read as "₹463.86 Cr – ₹465.3…". Under the value it is
                  // narrow, it is beside what it qualifies, and the table
                  // loses 200px it did not have.
                  const range =
                    c.band && band
                      ? (BAND_OF[row.key] && (band[BAND_OF[row.key]!] as Trio | null)?.display) ||
                        (EXACT.has(row.key) ? `${c.figures[row.key].display} exact` : null)
                      : null
                  return (
                    <td
                      key={c.title}
                      className={`px-4 py-3 text-right ${TYPE.cell} ${c.recommended ? '!text-brand-violet' : ''} ${c.muted ? '!text-ink-secondary' : ''}`}
                    >
                      <span className="block">{c.figures[row.key].display}</span>
                      {range && (
                        <span
                          className="mt-0.5 block whitespace-nowrap text-sm font-normal text-ink-muted"
                          title={`10th to 90th percentile over ${band!.draws.toLocaleString()} Monte Carlo draws`}
                        >
                          {range}
                        </span>
                      )}
                    </td>
                  )
                })}
                {changed.length === 1 && (
                  <td className={`px-4 py-3 text-right ${TYPE.delta}`}>
                    {d && d.direction !== 'unchanged' ? (
                      // THE CHANGE IS THE ANSWER, so it is the one thing on
                      // the row that carries a fill. Coloured text alone made
                      // it the lightest mark in its own column -- four columns
                      // of plain figures and then, at the far right, more
                      // plain figures. A tinted pill is what the KPI cards on
                      // both hubs already use for a delta, so the page reads
                      // the same way here, and a column of them can be scanned
                      // for green and red without reading a single number.
                      <span
                        className={`inline-flex flex-col items-end rounded-[var(--r-sm)] px-2 py-0.5 ${
                          row.neutral
                            ? 'bg-ink-primary/[0.06] text-ink-secondary'
                            : toneTint(d.direction, row.lowerIsBetter)
                        }`}
                      >
                        <span className="whitespace-nowrap">{d.text}</span>
                        {d.percent && <span className="text-sm font-normal opacity-80">{d.percent}</span>}
                      </span>
                    ) : (
                      <span className="text-ink-muted">—</span>
                    )}
                  </td>
                )}
              </tr>
            )
          })}
        </tbody>
      </table>
      {nothingMoved && (
        <p className={`border-t border-border-subtle px-4 py-2.5 ${TYPE.eyebrow} !font-normal`}>
          Every figure matches what it is compared with — nothing in this plan has moved yet.
        </p>
      )}
    </div>
  )
}
