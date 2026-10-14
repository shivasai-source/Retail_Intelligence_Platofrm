import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { Icon, type IconName } from '../../icons'
import type { GroupedOption } from '../../types/planner'

/** One Simulation Studio filter: a pill that says what is selected, and a
 *  panel to choose it.
 *
 *  The panel: a search box (focused on open), the options grouped -- products
 *  by brand, stores by channel -- each with a checkbox, "Select all" for what
 *  the search shows, "Clear", and a count of what is picked. Picks apply at
 *  once; the panel stays open until Done, Escape or a click outside, so
 *  choosing five stores is five clicks, not five trips through a menu.
 *
 *  The Studio's own control. The Insights Hub's MultiSelect is shared with a
 *  frozen page and is left exactly as it is. */

const PANEL_W = 400
const LIST_MAX_H = 320

export function FilterSelect({
  label,
  icon,
  options,
  selected,
  onChange,
  disabled,
  disabledReason,
}: {
  label: string
  icon: IconName
  options: GroupedOption[]
  selected: string[]
  onChange: (codes: string[]) => void
  disabled?: boolean
  disabledReason?: string
}) {
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const [place, setPlace] = useState({ left: 0, top: 0, maxH: 600 })
  const anchorRef = useRef<HTMLButtonElement>(null)
  const panelRef = useRef<HTMLDivElement>(null)
  const searchRef = useRef<HTMLInputElement>(null)

  // Sit under the button and never run past the bottom of the window (a
  // short window or a 90% zoom): re-measured on resize and scroll.
  useLayoutEffect(() => {
    if (!open) return
    const measure = () => {
      if (!anchorRef.current) return
      const r = anchorRef.current.getBoundingClientRect()
      setPlace({ left: Math.max(8, Math.min(r.left, window.innerWidth - PANEL_W - 8)), top: r.bottom + 6, maxH: Math.max(240, window.innerHeight - r.bottom - 14) })
    }
    measure()
    window.addEventListener('resize', measure)
    window.addEventListener('scroll', measure, true)
    return () => {
      window.removeEventListener('resize', measure)
      window.removeEventListener('scroll', measure, true)
    }
  }, [open])

  useEffect(() => {
    if (!open) return
    setQuery('')
    const t = window.setTimeout(() => searchRef.current?.focus(), 30)
    const onDown = (e: MouseEvent) => {
      if (panelRef.current?.contains(e.target as Node) || anchorRef.current?.contains(e.target as Node)) return
      setOpen(false)
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        setOpen(false)
        anchorRef.current?.focus()
      }
    }
    document.addEventListener('mousedown', onDown)
    document.addEventListener('keydown', onKey)
    return () => {
      window.clearTimeout(t)
      document.removeEventListener('mousedown', onDown)
      document.removeEventListener('keydown', onKey)
    }
  }, [open])

  const visible = useMemo(() => {
    const q = query.trim().toLowerCase()
    return q ? options.filter((o) => `${o.name} ${o.code} ${o.group ?? ''}`.toLowerCase().includes(q)) : options
  }, [options, query])

  const groups = useMemo(() => {
    const out: { group: string; items: GroupedOption[] }[] = []
    for (const o of visible) {
      const g = o.group ?? ''
      const last = out[out.length - 1]
      if (last && last.group === g) last.items.push(o)
      else out.push({ group: g, items: [o] })
    }
    return out
  }, [visible])

  const chosen = new Set(selected)
  const toggle = (code: string) => onChange(chosen.has(code) ? selected.filter((c) => c !== code) : [...selected, code])
  const allVisibleOn = visible.length > 0 && visible.every((o) => chosen.has(o.code))
  const selectVisible = () =>
    onChange(allVisibleOn ? selected.filter((c) => !visible.some((o) => o.code === c)) : [...new Set([...selected, ...visible.map((o) => o.code)])])
  const nameOf = (code: string) => options.find((o) => o.code === code)?.name ?? code
  const summary = selected.length === 0 ? 'All' : selected.length === 1 ? shortName(nameOf(selected[0])) : `${selected.length} selected`
  const active = selected.length > 0

  return (
    <>
      <button
        ref={anchorRef}
        type="button"
        disabled={disabled}
        title={disabled ? disabledReason : undefined}
        aria-haspopup="dialog"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
        className={`group inline-flex h-10 cursor-pointer items-center gap-2 rounded-[var(--r-md)] border px-3 text-base transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-violet disabled:cursor-not-allowed disabled:opacity-60 [&_svg]:h-4 [&_svg]:w-4 ${
          active || open
            ? 'border-brand-violet/50 bg-brand-violet-50 text-brand-violet'
            : 'border-border-default bg-surface-card text-ink-secondary hover:border-border-strong hover:bg-surface-hover'
        }`}
      >
        <Icon name={icon} />
        <span className="font-medium">{label}</span>
        <span className={`max-w-[160px] truncate font-medium ${active ? 'text-brand-violet' : 'text-ink-primary'}`}>{summary}</span>
        {disabled ? <Icon name="lock" /> : <Icon name="chevronDown" />}
      </button>

      {open &&
        createPortal(
          <div
            ref={panelRef}
            role="dialog"
            aria-label={`Choose ${label.toLowerCase()}`}
            className="dd-enter fixed z-[9999] flex flex-col font-medium overflow-hidden rounded-[var(--r-lg)] border border-border-default bg-surface-card shadow-[var(--shadow-lg)]"
            style={{ left: place.left, top: place.top, width: PANEL_W, maxWidth: 'calc(100vw - 16px)', maxHeight: place.maxH }}
          >
            <div className="flex shrink-0 items-center justify-between gap-2 border-b border-border-subtle px-4 py-3">
              <div>
                <div className="text-base font-medium text-ink-primary">{label}</div>
                <div className="text-base text-ink-muted">
                  {active ? `${selected.length} of ${options.length} selected` : `All ${options.length}`}
                </div>
              </div>
              {active && (
                <button
                  type="button"
                  onClick={() => onChange([])}
                  className="cursor-pointer rounded-[var(--r-sm)] px-2 py-1 text-base font-medium text-brand-violet hover:bg-brand-violet/[0.08]"
                >
                  Clear
                </button>
              )}
            </div>

            <div className="shrink-0 px-3 pt-3">
              <label className="flex h-10 items-center gap-2 rounded-[var(--r-md)] border border-border-default bg-surface-card px-3 focus-within:border-brand-violet [&_svg]:h-4 [&_svg]:w-4">
                <Icon name="search" className="text-ink-muted" />
                <input
                  style={{ outline: 'none' }}
                  ref={searchRef}
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                  placeholder={`Search ${label.toLowerCase()}`}
                  className="w-full bg-transparent text-base text-ink-primary outline-none placeholder:text-ink-muted focus:outline-none focus-visible:outline-none"
                />
                {query && (
                  <button type="button" aria-label="Clear search" onClick={() => setQuery('')} className="cursor-pointer text-ink-muted hover:text-ink-primary">
                    <Icon name="x" />
                  </button>
                )}
              </label>
            </div>

            {visible.length > 0 && (
              <button
                type="button"
                onClick={selectVisible}
                className="mx-3 mt-2 flex shrink-0 cursor-pointer items-center gap-2.5 rounded-[var(--r-sm)] px-2 py-1.5 text-left text-base font-medium text-ink-secondary hover:bg-surface-hover"
              >
                <Check on={allVisibleOn} />
                {query ? `Select all ${visible.length} shown` : 'Select all'}
              </button>
            )}

            <div className="mt-1 min-h-0 flex-1 overflow-y-auto px-3 pb-2" style={{ maxHeight: LIST_MAX_H }} role="listbox" aria-multiselectable="true">
              {groups.map(({ group, items }) => (
                <div key={group || '_'}>
                  {group && (
                    <div className="sticky top-0 z-10 bg-surface-card px-2 pb-1 pt-2.5 text-base font-medium text-ink-muted">{group}</div>
                  )}
                  {items.map((o) => {
                    const on = chosen.has(o.code)
                    const [main, sub] = splitName(o)
                    return (
                      <button
                        key={o.code}
                        type="button"
                        role="option"
                        aria-selected={on}
                        onClick={() => toggle(o.code)}
                        className={`flex w-full cursor-pointer items-center gap-2.5 rounded-[var(--r-sm)] px-2 py-1.5 text-left transition-colors hover:bg-surface-hover ${on ? 'bg-brand-violet/[0.05]' : ''}`}
                      >
                        <Check on={on} />
                        <span className="min-w-0 flex-1">
                          <span className={`block break-words text-base leading-snug ${on ? 'text-brand-violet' : 'text-ink-primary'}`}>{main}</span>
                          {sub && <span className="block break-words text-base leading-snug text-ink-muted">{sub}</span>}
                        </span>
                      </button>
                    )
                  })}
                </div>
              ))}
              {visible.length === 0 && <div className="px-2 py-6 text-center text-base text-ink-muted">Nothing matches “{query}”</div>}
            </div>

            <div className="flex shrink-0 items-center justify-end border-t border-border-subtle px-3 py-2.5">
              <button
                type="button"
                onClick={() => setOpen(false)}
                className="h-9 cursor-pointer rounded-[var(--r-md)] bg-brand-violet px-4 text-base font-medium text-white hover:bg-brand-violet-600"
              >
                Done
              </button>
            </div>
          </div>,
          document.body,
        )}
    </>
  )
}

function Check({ on }: { on: boolean }) {
  return (
    <span
      className={`grid h-4 w-4 shrink-0 place-items-center rounded-[4px] border transition-colors [&_svg]:h-3 [&_svg]:w-3 ${
        on ? 'border-brand-violet bg-brand-violet text-white' : 'border-border-strong bg-surface-card'
      }`}
    >
      {on && <Icon name="check" />}
    </span>
  )
}

/** A store reads "S001 · Reliance Fresh, Delhi": the id on top, where it is
 *  underneath. Anything else is one line. */
function splitName(o: GroupedOption): [string, string | null] {
  const i = o.name.indexOf(' · ')
  return i > 0 ? [o.name.slice(i + 3), o.name.slice(0, i)] : [o.name, null]
}

function shortName(name: string): string {
  const i = name.indexOf(' · ')
  return i > 0 ? name.slice(i + 3) : name
}
