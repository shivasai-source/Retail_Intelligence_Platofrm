import { Icon, type IconName } from '../../icons'
import { useElementSize } from '../../hooks/useElementSize'
import { computeRadialLayout } from './graphLayout'
import type { OrchNode } from '../../types/orchestration'

/** "Benchmarking Agent" -> "Benchmarking". Every node on the graph is an
 *  agent, so the word said nothing six times over. Trimmed at render rather
 *  than in the roster: the API's name is copied into every run when it is
 *  recorded, so renaming there would leave stored investigations reading
 *  differently from new ones. */
function nodeTitle(label: string): string {
  return label.replace(/\s+agent$/i, '')
}

// Ported from the `.ig-stage` block + `layoutGraph()` in js/pages/investigations.js.
export function InvestigationGraph({
  center,
  nodes,
  revealedKeys,
  onNodeClick,
  zoom = 1,
  expanded = false,
}: {
  center: { label: string; sub: string }
  nodes: OrchNode[]
  /** Keys of nodes that have "arrived" — undefined means everything is revealed immediately. */
  revealedKeys?: Set<string>
  onNodeClick: (node: OrchNode, el: HTMLElement) => void
  /** Toolbar zoom. Applied as a transform on the stage's contents so the
   *  layout maths stays in unscaled pixels and nothing has to be recomputed
   *  when it changes. */
  zoom?: number
  /** Take the height the parent gives instead of the fixed 560px. Set while the
   *  card is expanded to fill the window; the stage is measured either way, so
   *  the radial layout simply recomputes at the larger size. */
  expanded?: boolean
}) {
  const { ref, size } = useElementSize<HTMLDivElement>({ width: 720, height: 560 })
  const laidOut = size.width && size.height ? computeRadialLayout(nodes, size.width, size.height) : []
  const byKey = new Map(laidOut.map((l) => [l.key, l]))

  const isRevealed = (key: string) => !revealedKeys || revealedKeys.has(key)

  return (
    <>
      <div
        ref={ref}
        className={`relative overflow-hidden ${expanded ? 'min-h-0 flex-1' : 'h-[560px]'}`}
        style={{ background: 'radial-gradient(circle at 50% 50%, rgba(124,92,255,0.04), transparent 70%)' }}
      >
        {/* ONE transform for the whole stage. Zooming a wrapper keeps the
            layout in real pixels, so the edge geometry and the node
            positions never have to know a zoom exists. */}
        <div
          className="absolute inset-0 origin-center transition-transform duration-200 ease-[var(--ease-out)]"
          style={{ transform: `scale(${zoom})` }}
        >
        <svg className="pointer-events-none absolute inset-0 h-full w-full" viewBox={`0 0 ${size.width} ${size.height}`}>
          <defs>
            {/* ONE ARROWHEAD, ONE COLOUR. The edges used to take a colour and
                a dash from each node's impact — solid blue, dashed red,
                dashed amber — which made the spokes a second, competing
                encoding of what the node's own delta already says. Every
                edge is now the same solid brand blue: the graph shows which
                agents looked at the event, the nodes say what they found. */}
            <marker
              id="arr-edge"
              markerWidth={8}
              markerHeight={8}
              refX={6}
              refY={3}
              orient="auto"
              markerUnits="userSpaceOnUse"
            >
              <path d="M0,0 L7,3 L0,6 Z" fill="var(--brand-blue)" />
            </marker>
          </defs>
          {laidOut.map((l) => (
            <line
              key={l.key}
              x1={l.px.toFixed(1)}
              y1={l.py.toFixed(1)}
              x2={l.edgeX2.toFixed(1)}
              y2={l.edgeY2.toFixed(1)}
              stroke="var(--brand-blue)"
              strokeWidth={2}
              strokeLinecap="round"
              markerEnd="url(#arr-edge)"
              className="transition-opacity duration-[420ms] ease-[var(--ease-out)]"
              style={{ opacity: isRevealed(l.key) ? 1 : 0 }}
            />
          ))}
        </svg>

        {nodes.map((n, i) => {
          const l = byKey.get(n.key)
          const st = l?.style
          const trendColor = n.trend === 'down' ? 'var(--status-danger)' : n.trend === 'up' ? 'var(--brand-blue)' : 'var(--text-muted)'
          const revealed = isRevealed(n.key)
          return (
            <div
              key={n.key}
              data-key={n.key}
              onClick={(e) => onNodeClick(n, e.currentTarget)}
              className={`absolute z-[1] flex h-[156px] w-[156px] cursor-pointer flex-col items-center justify-center rounded-full border-[1.5px] border-border-default bg-surface-card p-2 text-center shadow-[var(--shadow-sm)] transition-[opacity,transform,box-shadow,border-color] duration-300 hover:z-[3] hover:shadow-[var(--shadow-md)] ${
                revealed ? 'scale-100 opacity-100 hover:scale-105' : 'pointer-events-none scale-[0.82] opacity-0'
              }`}
              style={{
                left: l ? l.px : `${n.pos.x}%`,
                top: l ? l.py : `${n.pos.y}%`,
                transform: 'translate(-50%, -50%)',
                transitionDelay: revealed ? `${i * 30}ms` : '0ms',
              }}
            >
              <div
                className="mb-1.5 grid h-10 w-10 place-items-center rounded-xl [&_svg]:h-5 [&_svg]:w-5"
                style={{ background: st?.bg, color: st?.accent }}
              >
                <Icon name={n.icon as IconName} />
              </div>
              {/* ICON, NAME AND DELTA ONLY. `metric` is deliberately not drawn
                  here: it is a different figure on every node — an ROI, a
                  mechanic's return, a retailer's — so six of them side by side
                  invited comparison between numbers that are not comparable.
                  It leads the popover instead, where the bars it came from are
                  directly underneath it. */}
              <div className="text-base font-extrabold leading-tight tracking-[-0.01em] text-ink-primary">{nodeTitle(n.label)}</div>
              {n.delta && (
                <div className="mt-1 inline-flex items-center gap-0.5 text-base font-bold" style={{ color: trendColor }}>
                  <Icon name={n.trend === 'down' ? 'arrowDown' : 'arrowUp'} className="h-3 w-3" />
                  <span>{n.delta}</span>
                </div>
              )}
            </div>
          )
        })}

        <div
          className="absolute z-[2] rounded-[14px] px-[26px] py-[18px] text-center text-white"
          style={{
            left: size.width / 2,
            top: size.height / 2,
            transform: 'translate(-50%, -50%)',
            background: 'linear-gradient(135deg, #4F3CCC 0%, #6B47FF 100%)',
            boxShadow: '0 16px 32px -8px rgba(124, 92, 255, 0.55)',
          }}
        >
          <div className="text-lg font-extrabold tracking-[-0.01em]">{center.label}</div>
          <div className="mt-0.5 text-base opacity-[0.78]">{center.sub}</div>
        </div>
        </div>
      </div>
    </>
  )
}
