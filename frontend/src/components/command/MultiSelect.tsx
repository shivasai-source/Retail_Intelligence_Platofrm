import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { Icon } from '../../icons'

// Same portal + fixed-positioning approach as components/ui/Dropdown.tsx, and
// the same tokens, so the two controls are visually indistinguishable. It could
// not simply reuse Dropdown: that one closes on every pick, which makes
// selecting three channels three round-trips through the menu.
//
// The menu stays open while values are toggled and closes on outside click or
// Escape. Placement flips above the trigger when there is not enough room
// below, so a control near the bottom of the viewport does not open off-screen.

export interface MultiOption {
  code: string
  name: string
}

const MENU_MAX_HEIGHT = 320
const GAP = 4

export function MultiSelect({
  trigger,
  options,
  selected,
  onToggle,
  onClear,
  allLabel,
  label,
}: {
  trigger: ReactNode
  options: MultiOption[]
  selected: string[]
  onToggle: (code: string) => void
  onClear: () => void
  allLabel: string
  /** Names the control for assistive tech, e.g. "Channel". */
  label: string
}) {
  const [open, setOpen] = useState(false)
  const [active, setActive] = useState(-1)
  const [placement, setPlacement] = useState({ left: 0, top: 0, minWidth: 200, maxHeight: MENU_MAX_HEIGHT })
  const anchorRef = useRef<HTMLSpanElement>(null)
  const menuRef = useRef<HTMLDivElement>(null)

  useLayoutEffect(() => {
    if (!open || !anchorRef.current) return
    const rect = anchorRef.current.getBoundingClientRect()
    const below = window.innerHeight - rect.bottom - GAP * 2
    const above = rect.top - GAP * 2
    // Flip upward only when below genuinely cannot hold the menu AND above has
    // more room — otherwise a control mid-screen would flip for no reason.
    const flip = below < Math.min(MENU_MAX_HEIGHT, 160) && above > below
    const maxHeight = Math.min(MENU_MAX_HEIGHT, flip ? above : below)
    setPlacement({
      left: Math.max(GAP, Math.min(rect.left, window.innerWidth - rect.width - GAP)),
      top: flip ? rect.top - GAP - maxHeight : rect.bottom + GAP,
      minWidth: Math.max(200, rect.width),
      maxHeight,
    })
  }, [open])

  useEffect(() => {
    if (!open) return
    const onPointer = (e: MouseEvent) => {
      if (
        anchorRef.current && !anchorRef.current.contains(e.target as Node) &&
        menuRef.current && !menuRef.current.contains(e.target as Node)
      ) {
        setOpen(false)
      }
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation()
        setOpen(false)
        // Return focus to the trigger so the keyboard user is not stranded.
        anchorRef.current?.querySelector('button')?.focus()
      } else if (e.key === 'ArrowDown') {
        e.preventDefault()
        setActive((i) => Math.min(i + 1, options.length - 1))
      } else if (e.key === 'ArrowUp') {
        e.preventDefault()
        setActive((i) => Math.max(i - 1, -1))
      } else if ((e.key === 'Enter' || e.key === ' ') && active >= 0) {
        e.preventDefault()
        onToggle(options[active].code)
      }
    }
    document.addEventListener('mousedown', onPointer)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onPointer)
      document.removeEventListener('keydown', onKey)
    }
  }, [open, active, options, onToggle])

  useEffect(() => {
    if (!open) setActive(-1)
  }, [open])

  return (
    <>
      <span
        ref={anchorRef}
        onClick={() => setOpen((v) => !v)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault()
            setOpen((v) => !v)
          }
        }}
        role="button"
        tabIndex={-1}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-label={`${label} filter`}
      >
        {trigger}
      </span>
      {open &&
        createPortal(
          <div
            ref={menuRef}
            role="listbox"
            aria-multiselectable="true"
            aria-label={`${label} options`}
            className="dd-enter fixed z-[9999] overflow-y-auto rounded-[var(--r-md)] border border-border-default bg-surface-card p-1 shadow-[var(--shadow-lg)]"
            style={{
              left: placement.left,
              top: placement.top,
              minWidth: placement.minWidth,
              maxHeight: placement.maxHeight,
            }}
          >
            <div
              role="option"
              aria-selected={selected.length === 0}
              tabIndex={0}
              onClick={onClear}
              onKeyDown={(e) => (e.key === 'Enter' || e.key === ' ') && (e.preventDefault(), onClear())}
              className={`flex cursor-pointer items-center gap-2 rounded-[var(--r-sm)] px-3 py-2 text-base font-medium transition-colors hover:bg-surface-hover focus:bg-surface-hover focus:outline-none ${
                selected.length === 0 ? 'font-medium text-brand-violet' : 'text-ink-primary'
              }`}
            >
              <span className="flex-1">{allLabel}</span>
              {selected.length === 0 && <Icon name="check" className="h-3.5 w-3.5 text-brand-violet" />}
            </div>
            <div className="my-1 h-px bg-border-subtle" />
            {options.map((o, i) => {
              const isSelected = selected.includes(o.code)
              return (
                <div
                  key={o.code}
                  role="option"
                  aria-selected={isSelected}
                  tabIndex={0}
                  onMouseEnter={() => setActive(i)}
                  onClick={() => onToggle(o.code)}
                  onKeyDown={(e) => (e.key === 'Enter' || e.key === ' ') && (e.preventDefault(), onToggle(o.code))}
                  className={`flex cursor-pointer items-center gap-2 rounded-[var(--r-sm)] px-3 py-2 text-base font-medium transition-colors focus:outline-none ${
                    i === active ? 'bg-surface-hover' : ''
                  } ${isSelected ? 'font-medium text-brand-violet' : 'text-ink-primary'}`}
                >
                  {/* A checkbox affordance, so multi-select reads as multi-select
                      rather than as a list that mysteriously keeps its highlight. */}
                  <span
                    className={`grid h-3.5 w-3.5 shrink-0 place-items-center rounded-[3px] border transition-colors ${
                      isSelected ? 'border-brand-violet bg-brand-violet text-white' : 'border-border-default'
                    }`}
                  >
                    {isSelected && <Icon name="check" className="h-2.5 w-2.5" />}
                  </span>
                  <span className="flex-1">{o.name}</span>
                </div>
              )
            })}
            {options.length === 0 && (
              <div className="px-3 py-2 text-base text-ink-muted">No options in this scope</div>
            )}
          </div>,
          document.body,
        )}
    </>
  )
}

/** The selected values, shown as individual removable chips rather than as one
 *  comma-joined string — "E-commerce, Modern Trade" reads as a single ambiguous
 *  value, which is exactly what a multi-select must not look like. */
export function SelectionChips({
  options,
  selected,
  onRemove,
  max = 2,
}: {
  options: MultiOption[]
  selected: string[]
  onRemove: (code: string) => void
  /** Beyond this, collapse the tail into "+N" so the filter bar cannot grow
   *  unbounded when many values are picked. */
  max?: number
}) {
  if (selected.length === 0) return null
  const nameOf = (code: string) => options.find((o) => o.code === code)?.name ?? code
  const shown = selected.slice(0, max)
  const overflow = selected.length - shown.length

  return (
    <span className="inline-flex flex-wrap items-center gap-1">
      {shown.map((code) => (
        <span
          key={code}
          className="chip-enter inline-flex items-center gap-1 rounded-[var(--r-sm)] bg-brand-violet-50 px-1.5 py-0.5 text-xs font-medium text-brand-violet"
        >
          {nameOf(code)}
          <button
            type="button"
            aria-label={`Remove ${nameOf(code)}`}
            className="cursor-pointer rounded-full opacity-60 transition-opacity hover:opacity-100 focus:opacity-100 focus:outline-none focus-visible:ring-1 focus-visible:ring-brand-violet [&_svg]:h-2.5 [&_svg]:w-2.5"
            onClick={(e) => {
              e.stopPropagation()
              onRemove(code)
            }}
          >
            <Icon name="x" />
          </button>
        </span>
      ))}
      {overflow > 0 && (
        <span className="rounded-[var(--r-sm)] bg-ink-primary/[0.06] px-1.5 py-0.5 text-xs font-medium text-ink-secondary">
          +{overflow}
        </span>
      )}
    </span>
  )
}
