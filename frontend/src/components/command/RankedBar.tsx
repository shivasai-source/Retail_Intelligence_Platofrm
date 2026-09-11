import type { BreakdownGroup } from '../../types/commandCenter'

/** Horizontal ranking of one breakdown dimension.
 *
 *  A RANKING, never a composition. Incremental Sales is not additive across
 *  groups — the baseline is re-derived per selection — so a stacked or
 *  percent-of-total bar would assert something false. Each row is scaled
 *  against the largest bar, not against a total.
 *
 *  Trade Spend rides as a thin underlay on the same axis: both are money, so
 *  the comparison is honest, and the gap between the two bars is the return. */
export function RankedBar({
  groups,
  rate,
  symbol,
  rowTooltip,
  fill = false,
}: {
  groups: BreakdownGroup[]
  /** Distribute the rows over a stretched card instead of stacking them at its
   *  top. Used where the grid row is taller than this chart's natural height,
   *  so the card fills rather than ending in blank space. Bars grow with it,
   *  because a 10px bar adrift in a 450px card reads as a rendering fault. */
  fill?: boolean
  /** Optional hover text for a whole row. Omitted by every caller that does
   *  not need it, so their rows behave exactly as before. */
  rowTooltip?: (group: BreakdownGroup) => string
  /** Display-currency multiplier from `meta.exchange_rate` — the one rate the
   *  backend defines. Never a second conversion mechanism. */
  rate: number
  symbol: string
}) {
  const max = Math.max(
    ...groups.map((g) => Math.max(g.incremental_sales ?? 0, g.trade_spend ?? 0)),
    1,
  )
  const pct = (v: number | null) => `${Math.max(0, ((v ?? 0) / max) * 100)}%`
  const money = (v: number | null) => {
    if (v === null) return '—'
    const x = v * rate
    const abs = Math.abs(x)
    if (symbol === '₹') {
      if (abs >= 1e7) return `${symbol}${(x / 1e7).toFixed(1)} Cr`
      if (abs >= 1e5) return `${symbol}${(x / 1e5).toFixed(1)} L`
    } else {
      if (abs >= 1e6) return `${symbol}${(x / 1e6).toFixed(1)} M`
      if (abs >= 1e3) return `${symbol}${(x / 1e3).toFixed(1)} K`
    }
    return `${symbol}${x.toFixed(0)}`
  }

  return (
    <div className={`flex flex-col gap-2.5 ${fill ? 'h-full justify-between' : ''}`}>
      {groups.map((g) => (
        <div key={g.code} className="group" title={rowTooltip?.(g)}>
          <div className="flex items-baseline justify-between gap-3 text-sm">
            <span className="truncate font-semibold text-ink-primary" title={g.label}>
              {g.label}
            </span>
            <span className="shrink-0 tabular-nums text-ink-muted">
              <span className="font-bold text-ink-primary">{money(g.incremental_sales)}</span>
              {' · '}
              {/* ROI is a percentage and is never currency-converted. */}
              <span
                className={
                  g.roi === null ? 'text-ink-muted'
                  : g.roi < 0 ? 'font-semibold text-status-danger'
                  : 'font-semibold text-status-success'
                }
              >
                {g.roi === null ? '—' : `${g.roi.toFixed(1)}%`}
              </span>
            </span>
          </div>
          <div className="mt-1 space-y-[3px]">
            <div className={`${fill ? 'h-4' : 'h-2.5'} w-full overflow-hidden rounded-full bg-ink-primary/[0.05]`}>
              <div
                className="h-full rounded-full bg-brand-violet transition-[width] duration-300 group-hover:brightness-110"
                style={{ width: pct(g.incremental_sales) }}
                title={`Incremental Sales ${g.incremental_sales_display}`}
              />
            </div>
            <div className={`${fill ? 'h-2' : 'h-1.5'} w-full overflow-hidden rounded-full bg-ink-primary/[0.03]`}>
              <div
                className="h-full rounded-full bg-status-danger transition-[width] duration-300 group-hover:brightness-110"
                style={{ width: pct(g.trade_spend) }}
                title={`Trade Spend ${g.trade_spend_display}`}
              />
            </div>
          </div>
        </div>
      ))}
      <div className="mt-1 flex items-center gap-3 text-xs text-ink-muted">
        <span className="inline-flex items-center gap-1">
          <span className="h-2 w-3 rounded-sm bg-brand-violet" /> Incremental Sales
        </span>
        <span className="inline-flex items-center gap-1">
          <span className="h-1.5 w-3 rounded-sm bg-status-danger" /> Trade Spend
        </span>
        <span>· ROI shown per row</span>
      </div>
    </div>
  )
}
