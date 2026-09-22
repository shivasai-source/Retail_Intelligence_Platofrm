import { Link } from 'react-router-dom'
import { Icon, type IconName } from '../../icons'
import { SidePopover } from '../ui'
import { impactStyle } from './graphLayout'
import type { NodeDetail, OrchNode } from '../../types/orchestration'

// Ported from the `UI.openSidePopover({...})` call in js/pages/investigations.js's
// node click handler, including the mini bar-chart visual (`miniViz`).
export function NodeDetailPopover({
  node,
  detail,
  anchorEl,
  onClose,
}: {
  node: OrchNode
  detail: NodeDetail
  anchorEl: HTMLElement | null
  onClose: () => void
}) {
  const st = impactStyle(node.impact)

  return (
    <SidePopover anchorEl={anchorEl} onClose={onClose}>
      <div className="mb-2.5 flex items-center gap-2">
        <div
          className="grid h-8 w-8 place-items-center rounded-lg [&_svg]:h-4 [&_svg]:w-4"
          style={{ background: st.bg, color: st.accent }}
        >
          <Icon name={node.icon as IconName} />
        </div>
        <div className="min-w-0">
          <div className="text-base font-extrabold">{node.label}</div>
          {/* The delta moved here from the graph node, where it sat as a bare
              red figure with nothing to read it against. Beside the metric —
              and directly above the bars it is drawn from — it can at least be
              checked against the two values it compares. */}
          <div className="flex flex-wrap items-center gap-x-1.5 text-xs text-ink-muted">
            <span>{node.metric}</span>
            {node.delta && (
              <span
                className="inline-flex items-center gap-0.5 font-bold"
                style={{
                  color:
                    node.trend === 'down'
                      ? 'var(--status-danger)'
                      : node.trend === 'up'
                        ? 'var(--brand-blue)'
                        : 'var(--text-muted)',
                }}
              >
                <Icon name={node.trend === 'down' ? 'arrowDown' : 'arrowUp'} className="h-2.5 w-2.5" />
                {node.delta}
              </span>
            )}
          </div>
        </div>
      </div>

      <div className="text-base font-bold leading-[1.4] text-ink-primary">{detail.headline}</div>
      <p className="mt-2 text-base leading-[1.55] text-ink-secondary">{detail.body}</p>

      {detail.viz && detail.viz.type === 'bars' && (
        <div className="mt-3 rounded-[10px] p-3" style={{ background: st.bg }}>
          {(() => {
            const max = Math.max(...detail.viz.items.map((it) => it.value)) * 1.15 || 1
            // LABEL ABOVE THE BAR, NOT BESIDE IT. These labels are retailer,
            // mechanic and channel names — up to "20% Discount (Seasonal) ROI
            // (Whole Business)" at 44 characters. Beside the bar they had a
            // fixed 64px and `whitespace-nowrap` with nothing to clip them, so
            // anything longer than about eight characters ran straight under
            // the bar. Stacked, the name gets the panel's full width and only
            // the longest few need to truncate at all.
            return detail.viz.items.map((it, i) => (
              <div key={it.label} className="mb-2.5 last:mb-0">
                <div className="flex items-baseline justify-between gap-2">
                  <span
                    className="min-w-0 truncate text-xs font-semibold text-ink-secondary"
                    title={it.label}
                  >
                    {it.label}
                  </span>
                  <span className="shrink-0 text-sm font-extrabold text-ink-primary [font-variant-numeric:tabular-nums]">
                    {/* GROUPED, BUT NOT GIVEN A UNIT. The viz carries a `unit`
                        field that every recorded run leaves empty, so the only
                        thing known about a value is its magnitude — printed raw
                        it read "32717886.4". Most large ones are rupees (Trade
                        Spend, At Stake, Neighbour Sales) but some are counts
                        (Critical Events), so a currency symbol here would
                        mislabel the counts. Separators and TWO decimals, the
                        project-wide rule, and how the evidence line below
                        already writes them — at one decimal a 0.96 ROI bar
                        printed as "1" beside an evidence line saying 0.96. */}
                    {it.value.toLocaleString(undefined, {
                      minimumFractionDigits: 2,
                      maximumFractionDigits: 2,
                    })}
                  </span>
                </div>
                <span className="mt-1 block h-[9px] overflow-hidden rounded-full bg-black/[0.06]">
                  <span
                    className="block h-full rounded-full [animation:npGrow_700ms_var(--ease-out)_forwards]"
                    style={{
                      width: `${((it.value / max) * 100).toFixed(2)}%`,
                      background: it.tone === 'muted' ? 'var(--border-strong)' : st.accent,
                      opacity: it.tone === 'accent2' ? 0.55 : 1,
                      animationDelay: `${120 + i * 120}ms`,
                    }}
                  />
                </span>
              </div>
            ))
          })()}
          <div className="mt-0.5 text-right text-2xs font-semibold uppercase tracking-[0.04em] text-ink-muted">
            {detail.viz.unit}
          </div>
        </div>
      )}

      <div className="mt-2.5 flex items-start gap-1.5 rounded-md bg-surface-muted p-[8px_10px] text-xs leading-[1.45] text-ink-muted">
        <Icon name="info" className="h-3.5 w-3.5 shrink-0" />
        <span>{detail.evidence}</span>
      </div>

      <Link
        to="/intelligence"
        onClick={onClose}
        className="mt-3 flex h-[30px] w-full items-center justify-center gap-2 rounded-[var(--r-md)] bg-brand-violet-50 text-sm font-semibold text-brand-violet hover:bg-brand-violet-100"
      >
        View in Intelligence <Icon name="arrowRight" className="h-3.5 w-3.5" />
      </Link>
    </SidePopover>
  )
}
