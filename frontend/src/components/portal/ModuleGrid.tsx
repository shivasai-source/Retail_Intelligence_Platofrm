import type { CSSProperties, MouseEvent } from 'react'
import { Link } from 'react-router-dom'
import { Icon } from '../../icons'
import { Pill, useToast } from '../ui'
import { MODULES } from './modules'

// Ported from js/portal.js's renderModules + css/portal.css .module-*.
//
// THE PORTAL IS NOT A DASHBOARD, and is typed accordingly. Every other screen
// in the product is under density pressure — a filter bar, a KPI deck and three
// charts have to share one fold — so they live on the 13px body step. This page
// is six cards on an empty background, the same condition that already earned
// the sign-in screen its own 32px step. Card titles take `text-lg` (18px) and
// their descriptions `text-md` (15px), one step up from the dashboard's 15/13,
// which is what makes the portal read as the front door rather than as another
// panel.
//
// Still sized to the fold: six cards in two rows clear a 1366x768 laptop's
// ~625px viewport at 100% zoom. The larger type is paid for out of the gaps and
// the hero, not out of a scrollbar.
export function ModuleGrid({ tpoHref, needsData = false }: { tpoHref?: string; needsData?: boolean }) {
  const { show } = useToast()

  // Feeds the spotlight in index.css the pointer's position inside the card.
  // Written straight onto the node rather than held in state: this fires on
  // every mousemove, and a re-render per frame for a decorative gradient would
  // be the most expensive thing on the page.
  const track = (e: MouseEvent<HTMLElement>) => {
    const el = e.currentTarget
    const r = el.getBoundingClientRect()
    el.style.setProperty('--mx', `${e.clientX - r.left}px`)
    el.style.setProperty('--my', `${e.clientY - r.top}px`)
  }

  return (
    <div className="portal-grid grid grid-cols-3 gap-4 @max-[900px]:grid-cols-2 @max-[620px]:grid-cols-1">
      {MODULES.map((m) => {
        // The live module's destination is decided by the caller: /connections
        // while the platform has no dataset, /command once it has one. Every
        // other card is on the roadmap and goes nowhere either way.
        const href = m.key === 'tpo' ? (tpoHref ?? m.href) : m.href
        const gated = m.live && needsData
        const card = (
          <div
            onMouseMove={track}
            // The card's own palette, handed to the hover wash in index.css.
            // `tint` is the pale chip colour the icon already sits on and
            // `accent` its saturated counterpart, so a card's hover is the same
            // colour as its icon rather than a generic violet for all six.
            style={
              {
                '--card-tint': `var(--tint-${m.tint})`,
                '--card-accent': `var(--tint-${m.tint}-icon)`,
              } as CSSProperties
            }
            className={[
              'module-card portal-card relative flex h-full flex-col gap-2.5 overflow-hidden rounded-[var(--r-xl)] border bg-surface-card p-5',
              'transition-[box-shadow,border-color,transform] duration-200 ease-[var(--ease-out)] motion-reduce:transition-none',
              m.live
                ? 'module-card-live cursor-pointer border-brand-violet shadow-[var(--shadow-violet)] group-hover:-translate-y-1'
                : // A ROADMAP CARD LIFTS, BUT NOT LIKE THE LIVE ONE. It warms its
                  // border and takes a small shadow, so the grid feels alive under
                  // the pointer — and it stays put, because rising the way the live
                  // card rises is the gesture that means "this opens".
                  'cursor-default border-border-subtle group-hover:border-border-default group-hover:shadow-[var(--shadow-sm)]',
            ].join(' ')}
          >
            <div
              className="relative grid h-11 w-11 shrink-0 place-items-center rounded-[14px] transition-transform duration-200 ease-[var(--ease-out)] group-hover:scale-105 motion-reduce:transition-none [&_svg]:h-[22px] [&_svg]:w-[22px]"
              style={{ background: `var(--tint-${m.tint})`, color: `var(--tint-${m.tint}-icon)` }}
            >
              <Icon name={m.icon} />
            </div>
            <h3 className="relative text-lg leading-[1.28]">{m.title}</h3>
            <p className="relative flex-1 text-md leading-[1.5] text-ink-muted">{m.desc}</p>
            {/* HONEST AFFORDANCES. The live module gets its status and an
                arrow that goes somewhere. A roadmap module says so in a
                muted chip and gets NO arrow -- a button-shaped arrow that
                only raises a toast is a promise the card cannot keep. */}
            <div className="relative mt-0.5 flex items-center justify-between gap-2">
              {m.live ? (
                <span className="flex min-w-0 flex-wrap items-center gap-1.5">
                  <Pill tone="success" size="md" dot pulse>
                    Live
                  </Pill>
                  {/* Says where the arrow actually goes. Without data the card
                      opens the connector catalog, not the Insights Hub, and a
                      card that looks identical in both states hides that. */}
                  {gated && (
                    <Pill tone="violet" size="md">
                      Connect data first
                    </Pill>
                  )}
                </span>
              ) : (
                <Pill tone="neutral" size="md">
                  Roadmap
                </Pill>
              )}
              {m.live && (
                <span className="grid h-9 w-9 shrink-0 place-items-center rounded-full bg-brand-violet text-white transition-[background-color,transform] duration-200 ease-[var(--ease-out)] group-hover:translate-x-1 group-hover:bg-brand-violet-600 motion-reduce:transition-none [&_svg]:h-4 [&_svg]:w-4">
                  <Icon name="arrowRight" />
                </span>
              )}
            </div>
          </div>
        )
        return m.live && href ? (
          <Link
            key={m.key}
            to={href}
            // `group` is what lets the arrow, the icon tile and the card itself
            // respond to one hover rather than three separate ones — the card is
            // the target, not any part of it. The focus ring goes on the link so
            // a keyboard user sees the whole card outlined, not its inner div.
            className="group rounded-[var(--r-xl)] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--brand-violet)]"
          >
            {card}
          </Link>
        ) : (
          <div
            key={m.key}
            className="group rounded-[var(--r-xl)]"
            onClick={() => show(`${m.title} is on the roadmap — Trade Promotion Optimization is live today.`)}
          >
            {card}
          </div>
        )
      })}
    </div>
  )
}
