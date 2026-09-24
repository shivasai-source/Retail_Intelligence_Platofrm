import { useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { Icon } from '../../icons'

// Ported from js/components/ui.js UI.openDropdown + css/tpo.css .ui-dropdown/.ui-dd-item.
// The original appends the menu straight to <body> with `position: fixed` at the
// trigger's getBoundingClientRect() — deliberately kept identical here (via a portal)
// rather than `position: absolute` inside the trigger's own subtree, since an absolute
// menu gets trapped by any ancestor that happens to establish a stacking context
// (e.g. our `.fade-in`/`.fade-in-up` entrance animations do, because they animate
// `opacity`/`transform`) and renders underneath later sibling cards instead of above
// them. Portaling to <body> sidesteps that class of bug entirely.
export interface DropdownOption {
  label: string
  value?: string
}

export function Dropdown({
  trigger,
  options,
  selected,
  onSelect,
}: {
  trigger: ReactNode
  options: DropdownOption[]
  selected?: string
  onSelect: (value: string) => void
}) {
  const [open, setOpen] = useState(false)
  const [coords, setCoords] = useState({ left: 0, top: 0, minWidth: 180 })
  const anchorRef = useRef<HTMLSpanElement>(null)
  const menuRef = useRef<HTMLDivElement>(null)
  const itemsRef = useRef<Array<HTMLButtonElement | null>>([])

  // THE MENU IS OPERABLE FROM THE KEYBOARD, and that was not a refinement.
  // Both the menu surface and its options used to be bare `<div onClick>`:
  // nothing in here could be focused, so Tab skipped the whole menu, Escape did
  // nothing, and an option could only be chosen with a pointer. Three of the
  // eleven call sites are the ACCOUNT MENU (topbar, sidebar, portal header),
  // which is the only route to Sign out anywhere in the product — so signing
  // out was pointer-only.
  //
  // The menu now follows the usual menu-button pattern: opening moves focus
  // into it, arrows/Home/End walk the options, Enter and Space choose one (free,
  // since they are real buttons now), Escape closes and hands focus back to
  // whatever opened it, and Tab closes without swallowing the focus move.
  const close = (restoreFocus: boolean) => {
    setOpen(false)
    if (!restoreFocus) return
    // Every call site's trigger is a real control; land on it rather than on
    // the wrapper span, which is not focusable.
    const back = anchorRef.current?.querySelector<HTMLElement>('button, [href], [tabindex]')
    back?.focus()
  }

  // Opening moves focus onto the selected option, or the first one. Standard
  // menu-button behaviour, and the only way an arrow key has somewhere to start.
  useEffect(() => {
    if (!open) return
    const i = options.findIndex((o) => (o.value ?? o.label) === selected)
    itemsRef.current[i >= 0 ? i : 0]?.focus()
  }, [open, options, selected])

  const onMenuKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    const items = itemsRef.current.filter(Boolean) as HTMLButtonElement[]
    if (!items.length) return
    const i = items.indexOf(document.activeElement as HTMLButtonElement)
    switch (e.key) {
      case 'Escape':
        e.preventDefault()
        close(true)
        break
      case 'ArrowDown':
        e.preventDefault()
        items[(i + 1) % items.length]?.focus()
        break
      case 'ArrowUp':
        e.preventDefault()
        items[(i - 1 + items.length) % items.length]?.focus()
        break
      case 'Home':
        e.preventDefault()
        items[0]?.focus()
        break
      case 'End':
        e.preventDefault()
        items[items.length - 1]?.focus()
        break
      case 'Tab':
        // Not prevented — the menu closes and the browser moves focus on, which
        // is what Tab out of an open menu should do.
        close(false)
        break
    }
  }

  // THE MENU IS KEPT INSIDE THE VIEWPORT. Anchoring it at the trigger's own
  // left/bottom is right only for a trigger with room below and to the right of
  // it. The account avatar sits ~16px from the window edge, so a menu pinned to
  // its left had ~73px of viewport to render into: the labels wrapped a word at
  // a time and "Profile & settings" ran off the screen. The sidebar's account
  // menu has the same problem downwards, opening a few px above the fold.
  useLayoutEffect(() => {
    if (!open || !anchorRef.current || !menuRef.current) return
    // Measurable in place because the menu is `width: max-content` (see the
    // style below): it keeps its natural width even when it is currently
    // rendered hard against an edge, so one pass is enough and nothing has to
    // mutate the DOM behind React's back to measure.
    const { offsetWidth: w, offsetHeight: h } = menuRef.current

    const rect = anchorRef.current.getBoundingClientRect()
    const GAP = 8
    const left = Math.max(GAP, Math.min(rect.left, window.innerWidth - w - GAP))
    // Below the trigger when it fits, above it when it does not.
    const below = rect.bottom + 4
    const top =
      below + h + GAP <= window.innerHeight ? below : Math.max(GAP, rect.top - h - 4)

    setCoords({ left, top, minWidth: Math.max(180, rect.width) })
  }, [open])

  useEffect(() => {
    if (!open) return
    const close = (e: MouseEvent) => {
      if (
        anchorRef.current &&
        !anchorRef.current.contains(e.target as Node) &&
        menuRef.current &&
        !menuRef.current.contains(e.target as Node)
      ) {
        setOpen(false)
      }
    }
    document.addEventListener('click', close)
    return () => document.removeEventListener('click', close)
  }, [open])

  return (
    <>
      <span ref={anchorRef} onClick={() => setOpen((v) => !v)} aria-haspopup="menu" aria-expanded={open}>
        {trigger}
      </span>
      {open &&
        createPortal(
          <div
            ref={menuRef}
            role="menu"
            onKeyDown={onMenuKeyDown}
            className="fade-in-up fixed z-[9999] rounded-[var(--r-md)] border border-border-default bg-surface-card p-1 shadow-[var(--shadow-lg)]"
            style={{
              left: coords.left,
              top: coords.top,
              minWidth: coords.minWidth,
              // `max-content` so the menu sizes to its labels rather than to
              // whatever gap is left between the trigger and the window edge —
              // that gap is what wrapped "Profile & settings" a word at a time.
              width: 'max-content',
              // And a ceiling, so a long sign-in address wraps inside the menu
              // instead of stretching it across the screen.
              maxWidth: 'min(320px, calc(100vw - 16px))',
            }}
          >
            {options.map((o, i) => {
              const val = o.value ?? o.label
              const isSelected = val === selected
              return (
                <button
                  key={val}
                  type="button"
                  role="menuitem"
                  aria-current={isSelected || undefined}
                  ref={(el) => {
                    itemsRef.current[i] = el
                  }}
                  onClick={() => {
                    close(true)
                    onSelect(val)
                  }}
                  className={`flex w-full cursor-pointer items-center gap-2 rounded-[var(--r-sm)] px-3 py-2 text-left text-base font-medium hover:bg-surface-hover focus-visible:bg-surface-hover ${
                    isSelected ? 'font-bold text-brand-violet' : 'text-ink-primary'
                  }`}
                >
                  <span className="flex-1">{o.label}</span>
                  {isSelected && <Icon name="check" className="h-3.5 w-3.5 text-brand-violet" />}
                </button>
              )
            })}
          </div>,
          document.body,
        )}
    </>
  )
}
