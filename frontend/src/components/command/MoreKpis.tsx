import { useEffect, useId, useRef, useState, type ReactNode } from 'react'
import { Icon } from '../../icons'
import { TpoKpiGrid } from '../ui'
import { readMoreKpisOpen, writeMoreKpisOpen } from './moreKpisState'

/** THE REST OF THE KPI CARDS, revealed on request.
 *
 *  Three headline cards are always on screen — spend, what it returned, and
 *  the ratio of the two. The six beneath them explain those three rather than
 *  add to them, and a first-time reader should meet three numbers, not nine.
 *  So they sit folded behind one control on the seam under the headline row,
 *  and a reader who wants them opens the row once; the choice is remembered
 *  per browser, so it is not asked again.
 *
 *  The reveal is a `grid-template-rows: 0fr -> 1fr` transition on a wrapper,
 *  which animates to the content's own height without measuring it, and the
 *  tiles inside mount on open so their entrance stagger plays each time. On
 *  close the tiles stay mounted until the collapse has finished, then leave.
 *  Under prefers-reduced-motion the row simply appears and disappears.
 */
export function MoreKpis({
  children,
}: {
  /** The tiles, rendered only while the row is open or closing. */
  children: ReactNode
}) {
  const [open, setOpen] = useState(readMoreKpisOpen)
  // Mounted lags `open` on the way down so the collapse has something to
  // collapse; it leads it on the way up so the tiles exist before the grid
  // row starts growing.
  const [mounted, setMounted] = useState(open)
  // Once the open transition has finished the wrapper releases its overflow
  // so a hovered tile's lift and shadow are not clipped at the row's edge.
  const [settled, setSettled] = useState(open)
  const regionId = useId()
  const wrapperRef = useRef<HTMLDivElement>(null)

  const toggle = () => {
    const next = !open
    writeMoreKpisOpen(next)
    if (next) setMounted(true)
    setSettled(false)
    setOpen(next)
  }

  // Reduced motion: no transition fires, so `onTransitionEnd` never would.
  // Settle the row's state by hand in that case.
  useEffect(() => {
    const reduced = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches
    if (!reduced) return
    setMounted(open)
    setSettled(open)
  }, [open])

  const onTransitionEnd = (e: React.TransitionEvent<HTMLDivElement>) => {
    if (e.target !== wrapperRef.current || e.propertyName !== 'grid-template-rows') return
    if (open) setSettled(true)
    else setMounted(false)
  }

  return (
    <>
      {/* THE SEAM. A hairline across the full width with the control centred
          on it, so the hidden cards visibly unfold from beneath the headline
          row rather than from a button parked in a corner. The control is
          one verb; the cards it reveals introduce themselves. */}
      <div className="relative mt-3.5 flex items-center justify-center">
        <span aria-hidden="true" className="absolute inset-x-0 top-1/2 h-px bg-border-subtle" />
        <button
          type="button"
          aria-expanded={open}
          aria-controls={regionId}
          onClick={toggle}
          className="group/more relative inline-flex cursor-pointer items-center gap-2 rounded-[var(--r-pill)] border border-brand-violet-100 bg-surface-card py-[7px] pl-3.5 pr-3 text-sm font-semibold text-brand-violet shadow-[var(--shadow-card-soft)] transition-[border-color,box-shadow,background-color,transform] duration-[200ms] ease-[var(--ease-out)] hover:border-brand-violet hover:bg-brand-violet-50 hover:shadow-[0_6px_16px_rgba(107,71,255,0.16)] focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-violet/60 motion-safe:hover:-translate-y-px"
        >
          <Icon
            name="sparkles"
            className="h-3.5 w-3.5 transition-transform duration-[260ms] ease-[var(--ease-out)] motion-safe:group-hover/more:rotate-12"
          />
          <span className="whitespace-nowrap">{open ? 'Show less' : 'Explore more KPIs'}</span>
          {/* One chevron, flipped rather than swapped, so the control reads
              as the same thing in both states. */}
          <span
            aria-hidden="true"
            className="grid place-items-center transition-transform duration-[260ms] ease-[var(--ease-out)] [&_svg]:h-3.5 [&_svg]:w-3.5"
            style={{ transform: open ? 'rotate(180deg)' : 'rotate(0deg)' }}
          >
            <Icon name="chevronDown" />
          </span>
        </button>
      </div>

      <div
        ref={wrapperRef}
        id={regionId}
        onTransitionEnd={onTransitionEnd}
        className="grid transition-[grid-template-rows,opacity] duration-[320ms] ease-[var(--ease-out)] motion-reduce:transition-none"
        style={{ gridTemplateRows: open ? '1fr' : '0fr', opacity: open ? 1 : 0 }}
      >
        <div className={settled && open ? 'min-h-0' : 'min-h-0 overflow-hidden'}>
          {/* The row's own top gap lives INSIDE the collapsing box so nothing
              is left behind when it closes. */}
          {mounted && (
            <div className="pt-3">
              <TpoKpiGrid>{children}</TpoKpiGrid>
            </div>
          )}
        </div>
      </div>
    </>
  )
}
