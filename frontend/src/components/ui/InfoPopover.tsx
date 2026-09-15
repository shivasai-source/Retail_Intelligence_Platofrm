import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { Icon } from '../../icons'

/** The one "i" affordance used across the Insights Hub.
 *
 *  Every info button on the page — KPI cards and card headers alike — renders
 *  through this, so size, icon, hover state, placement and popover styling
 *  cannot drift apart. It replaces the native `title` attribute, which the
 *  browser draws as a wide unstyled black box that ignores our typography.
 *
 *  Positioned against the VIEWPORT via a portal rather than inside the card:
 *  an absolutely-positioned panel gets clipped by the card's own overflow, and
 *  a button near the right edge would push the panel off-screen.
 *
 *  Opens on hover and on focus; a click pins it so it is reachable by keyboard
 *  and on touch. Closes on outside click, on Escape, and on mouse-out when not
 *  pinned.
 */
export function InfoPopover({
  label,
  title,
  children,
  width = 232,
}: {
  /** Accessible name, e.g. "About Promotion ROI". */
  label: string
  title: string
  children: ReactNode
  width?: number
}) {
  const [open, setOpen] = useState(false)
  const [pinned, setPinned] = useState(false)
  const [coords, setCoords] = useState({ left: 0, top: 0 })
  const ref = useRef<HTMLSpanElement>(null)
  const panelRef = useRef<HTMLDivElement>(null)

  useLayoutEffect(() => {
    if (!open || !ref.current) return
    const r = ref.current.getBoundingClientRect()
    const height = panelRef.current?.offsetHeight ?? 160
    // Flip above only when there genuinely is not room below.
    const above = r.bottom + height + 12 > window.innerHeight && r.top > height + 12
    setCoords({
      left: Math.max(8, Math.min(r.left + r.width / 2 - width / 2, window.innerWidth - width - 8)),
      top: above ? r.top - height - 8 : r.bottom + 8,
    })
  }, [open, width])

  useEffect(() => {
    if (!open) return
    const onPointer = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node) && !panelRef.current?.contains(e.target as Node)) {
        setPinned(false)
        setOpen(false)
      }
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        setPinned(false)
        setOpen(false)
        ref.current?.querySelector('button')?.focus()
      }
    }
    document.addEventListener('mousedown', onPointer)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onPointer)
      document.removeEventListener('keydown', onKey)
    }
  }, [open])

  return (
    <span ref={ref} className="relative inline-flex">
      <button
        type="button"
        aria-label={label}
        aria-expanded={open}
        className="grid h-5 w-5 cursor-pointer place-items-center rounded-full text-ink-muted opacity-45 transition-[opacity,background,color] duration-150 hover:bg-ink-primary/[0.06] hover:text-ink-secondary hover:opacity-100 focus:opacity-100 focus:outline-none focus-visible:opacity-100 focus-visible:ring-1 focus-visible:ring-brand-violet group-hover/kpi:opacity-80 [&_svg]:h-3.5 [&_svg]:w-3.5"
        onMouseEnter={() => setOpen(true)}
        onMouseLeave={() => !pinned && setOpen(false)}
        onFocus={() => setOpen(true)}
        onBlur={() => !pinned && setOpen(false)}
        onClick={(e) => {
          e.stopPropagation()
          setPinned((p) => !p)
          setOpen(true)
        }}
      >
        <Icon name="info" />
      </button>
      {open &&
        createPortal(
          <div
            ref={panelRef}
            role="tooltip"
            className="dd-enter fixed z-[9999] rounded-[var(--r-md)] border border-border-default bg-surface-card p-2.5 text-left shadow-[var(--shadow-lg)]"
            style={{ left: coords.left, top: coords.top, width }}
          >
            <div className="text-sm font-bold text-ink-primary">{title}</div>
            {children}
          </div>,
          document.body,
        )}
    </span>
  )
}

/** The standard body of an info popover: a label above a boxed value. Keeps
 *  every popover on the page to the same shape — a rule or a formula, nothing
 *  longer. */
export function InfoBlock({ label, children }: { label: string; children: ReactNode }) {
  return (
    <>
      <div className="mt-1.5 text-2xs font-semibold uppercase tracking-wide text-ink-muted">{label}</div>
      <div className="mt-0.5 rounded-[var(--r-sm)] bg-ink-primary/[0.04] px-1.5 py-1 text-xs leading-snug text-ink-secondary [font-variant-numeric:tabular-nums]">
        {children}
      </div>
    </>
  )
}
