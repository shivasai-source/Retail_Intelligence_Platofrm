import type { Band, Deltas, Figures, Trio } from '../../types/planner'
import { toneClass, TYPE } from './shared'

/** The current plan beside a plan, figure by figure.
 *
 *  One row per figure: its name, the current value, the plan's value and the
 *  change -- green when it is good news (spend is good news when it FALLS) --
 *  then, for a modelled plan, its P10 - P90 over the Monte Carlo draws.
 *  Every value and change is the backend's display string, in the Studio's
 *  one type scale. */

type RowKey = keyof Figures

/** `neutral`: a change that is neither good nor bad news in itself. */
const ROWS: { key: RowKey; label: string; delta?: keyof Deltas; lowerIsBetter?: boolean; neutral?: boolean }[] = [
  { key: 'profit', label: 'Profit', delta: 'profit' },
  { key: 'profit_pct', label: 'Profit %', delta: 'profit_pct' },
  { key: 'revenue', label: 'Revenue', delta: 'revenue' },
  { key: 'trade_spend', label: 'Trade spend', delta: 'trade_spend', lowerIsBetter: true },
  { key: 'roi', label: 'ROI', delta: 'roi' },
  { key: 'incremental_sales', label: 'Incremental sales', delta: 'incremental_sales' },
  { key: 'units', label: 'Units', delta: 'units' },
  { key: 'margin_pct', label: 'Gross margin', delta: 'margin_pct' },
  { key: 'avg_discount', label: 'Average discount', delta: 'avg_discount', neutral: true },
  { key: 'promotions', label: 'Promotions', delta: 'promotions', neutral: true },
]

export interface CompareColumn {
  title: string
  sub?: string
  figures: Figures
  deltas?: Deltas
  recommended?: boolean
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
}

function deltaText(d: Deltas[keyof Deltas] | undefined): { text: string; direction: 'up' | 'down' | 'unchanged' } | null {
  if (!d || !('direction' in d)) return null
  if ('percent_display' in d) {
    const text = d.percent == null ? d.absolute.display : `${d.absolute.display} (${d.percent_display})`
    return { text, direction: d.direction }
  }
  return { text: d.absolute_display, direction: d.direction }
}

export function FigureCompare({ columns, rows }: { columns: CompareColumn[]; rows?: RowKey[] }) {
  const shown = rows ? ROWS.filter((r) => rows.includes(r.key)) : ROWS
  const changed = columns.filter((c) => c.deltas)
  const band = columns.find((c) => c.band)?.band ?? null
  return (
    <div className="overflow-x-auto">
      <table className={`w-full ${band ? 'min-w-[720px]' : 'min-w-[560px]'}`}>
        <thead>
          <tr className="border-b border-border-subtle">
            <th className={`w-[26%] pb-2.5 text-left ${TYPE.eyebrow}`}>Figure</th>
            {columns.map((c) => (
              <th key={c.title} className="pb-2.5 text-right">
                <div className={`${TYPE.eyebrow} ${c.recommended ? '!text-brand-violet' : ''}`}>{c.title}</div>
                {c.sub && <div className={`mt-0.5 ${TYPE.delta} text-ink-muted`}>{c.sub}</div>}
              </th>
            ))}
            {changed.length === 1 && <th className={`pb-2.5 text-right ${TYPE.eyebrow}`}>Change</th>}
            {band && (
              <th className={`pb-2.5 pl-4 text-right ${TYPE.eyebrow}`} title={`10th to 90th percentile over ${band.draws.toLocaleString()} Monte Carlo draws`}>
                Range P10 – P90
              </th>
            )}
          </tr>
        </thead>
        <tbody>
          {shown.map((row) => {
            const d = changed.length === 1 && row.delta ? deltaText(changed[0].deltas![row.delta]) : null
            return (
              <tr key={row.key} className="border-b border-border-subtle last:border-b-0">
                <td className={`py-3 ${TYPE.label}`}>{row.label}</td>
                {columns.map((c) => (
                  <td key={c.title} className={`py-3 text-right ${TYPE.cell} ${c.recommended ? '!text-brand-violet' : ''}`}>
                    {c.figures[row.key].display}
                  </td>
                ))}
                {changed.length === 1 && (
                  <td className={`py-3 pl-4 text-right ${TYPE.delta} ${d && d.direction !== 'unchanged' ? (row.neutral ? 'text-ink-secondary' : toneClass(d.direction, row.lowerIsBetter)) : 'text-ink-muted'}`}>
                    {d && d.direction !== 'unchanged' ? d.text : '—'}
                  </td>
                )}
                {band && (
                  <td className={`whitespace-nowrap py-3 pl-4 text-right ${TYPE.cell} !text-ink-secondary`}>
                    {(BAND_OF[row.key] && (band[BAND_OF[row.key]!] as Trio | null)?.display) || '—'}
                  </td>
                )}
              </tr>
            )
          })}
        </tbody>
      </table>
    </div>
  )
}
