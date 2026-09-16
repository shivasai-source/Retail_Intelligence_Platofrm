import { useEffect, useId, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { Icon } from '../../icons'
import { useToast } from '../ui'
import { fmtRoi } from '../../lib/roi'

/** THE TARGET ROI, set by the reader.
 *
 *  Every "below target" on the Insights Hub — the Target Hit Rate card, the
 *  alert bands and their counts, the money at stake, the underperformer
 *  list, the dashed line on the trend chart — is judged against one hurdle.
 *  It shipped as a constant (1.50) and this control makes it the reader's:
 *  a value between the bounds the backend states, applied to every panel at
 *  once and remembered for the session.
 *
 *  Three ways to set it, all bound to one draft: type it, drag it, or pick a
 *  preset. The draft is validated as it is typed; an out-of-range or
 *  non-numeric value shows why, disables Apply, and — if the reader tries to
 *  apply it anyway — says so in a toast. The "net return" line beneath the
 *  value translates the multiple into the language the 50% target was set
 *  in, so 1.75 reads as "75% net return on trade spend" at a glance.
 */

export interface TargetRoiInfo {
  /** The target every figure on screen was judged against. */
  current: number
  /** What Reset returns to — the backend's configured default. */
  defaultValue: number
  /** Inclusive bounds, from the backend. */
  range: [number, number]
}

const STEP = 0.05
const PRESETS = [1.25, 1.5, 1.75, 2.0]

function parseDraft(text: string): number | null {
  const trimmed = text.trim()
  if (!/^\d+(\.\d+)?$/.test(trimmed)) return null
  return Number(trimmed)
}

function inRange(value: number | null, [lo, hi]: [number, number]): value is number {
  return value !== null && value >= lo && value <= hi
}

export function TargetRoiControl({
  target,
  onApply,
}: {
  target: TargetRoiInfo
  /** `null` means "back to the default". */
  onApply: (value: number | null) => void
}) {
  const { show } = useToast()
  const [open, setOpen] = useState(false)
  const [draft, setDraft] = useState(target.current.toFixed(2))
  const [coords, setCoords] = useState({ left: 0, top: 0 })
  const anchorRef = useRef<HTMLButtonElement>(null)
  const panelRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLInputElement>(null)
  const panelId = useId()
  const errorId = useId()

  const custom = Math.abs(target.current - target.defaultValue) > 1e-9
  const parsed = parseDraft(draft)
  const valid = inRange(parsed, target.range)
  const [lo, hi] = target.range
  const error = valid
    ? null
    : parsed === null
      ? 'Enter a number, such as 1.50.'
      : `Enter a value between ${lo.toFixed(2)} and ${hi.toFixed(2)}.`

  // Reopen on the live value, whatever the last draft was.
  const openPanel = () => {
    setDraft(target.current.toFixed(2))
    setOpen(true)
  }

  useLayoutEffect(() => {
    if (!open || !anchorRef.current) return
    const r = anchorRef.current.getBoundingClientRect()
    const width = 320
    setCoords({
      left: Math.max(8, Math.min(r.right - width, window.innerWidth - width - 8)),
      top: r.bottom + 8,
    })
    // Land in the input, text selected, so a typed value replaces it.
    window.requestAnimationFrame(() => inputRef.current?.select())
  }, [open])

  useEffect(() => {
    if (!open) return
    const onPointer = (e: MouseEvent) => {
      if (!panelRef.current?.contains(e.target as Node) && !anchorRef.current?.contains(e.target as Node)) setOpen(false)
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        setOpen(false)
        anchorRef.current?.focus()
      }
    }
    // The panel is position: fixed against the anchor's last measured
    // place. A scroll would leave it hanging in space, so it closes; a
    // resize re-measures instead, since the reader is likely mid-edit.
    const onScroll = (e: Event) => {
      if (panelRef.current?.contains(e.target as Node)) return
      setOpen(false)
    }
    const onResize = () => {
      const r = anchorRef.current?.getBoundingClientRect()
      if (!r) return
      const width = 320
      setCoords({ left: Math.max(8, Math.min(r.right - width, window.innerWidth - width - 8)), top: r.bottom + 8 })
    }
    document.addEventListener('mousedown', onPointer)
    document.addEventListener('keydown', onKey)
    window.addEventListener('scroll', onScroll, true)
    window.addEventListener('resize', onResize)
    return () => {
      document.removeEventListener('mousedown', onPointer)
      document.removeEventListener('keydown', onKey)
      window.removeEventListener('scroll', onScroll, true)
      window.removeEventListener('resize', onResize)
    }
  }, [open])

  const apply = () => {
    if (!valid) {
      show(error ?? 'Enter a value between 1.00 and 2.00.', { variant: 'error', duration: 2600 })
      inputRef.current?.select()
      return
    }
    const value = Math.round(parsed * 100) / 100
    const isDefault = Math.abs(value - target.defaultValue) < 1e-9
    onApply(isDefault ? null : value)
    show(
      isDefault
        ? `Target ROI back to the default ${fmtRoi(target.defaultValue)}`
        : `Target ROI set to ${fmtRoi(value)} · every panel re-judged`,
      { duration: 2200 },
    )
    setOpen(false)
  }

  const nudge = (delta: number) => {
    const base = valid ? parsed : target.current
    const next = Math.min(hi, Math.max(lo, Math.round((base + delta) * 100) / 100))
    setDraft(next.toFixed(2))
  }

  const netReturn = valid ? Math.round((parsed - 1) * 100) : null

  return (
    <>
      <button
        ref={anchorRef}
        type="button"
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-controls={open ? panelId : undefined}
        aria-label={`Target ROI ${fmtRoi(target.current)}${custom ? ', changed from the default' : ''}`}
        onClick={() => (open ? setOpen(false) : openPanel())}
        className={`inline-flex h-9 cursor-pointer items-center gap-1.5 rounded-[var(--r-md)] border bg-surface-card pl-2.5 pr-1.5 text-sm font-semibold transition-[border-color,box-shadow,background-color] duration-150 hover:bg-surface-hover focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-violet ${
          custom ? 'border-brand-violet-100 text-brand-violet' : 'border-border-subtle text-ink-secondary'
        }`}
      >
        <span className="relative grid place-items-center [&_svg]:h-4 [&_svg]:w-4">
          <Icon name="target" />
          {/* The "changed" dot: the one signal that the figures on screen are
              judged against something other than the default. */}
          {custom && <span aria-hidden="true" className="absolute -right-0.5 -top-0.5 h-2 w-2 rounded-full bg-brand-violet ring-2 ring-surface-card" />}
        </span>
        <span className="whitespace-nowrap">Target ROI</span>
        <span
          className={`rounded-[calc(var(--r-md)-3px)] px-1.5 py-0.5 text-sm font-bold leading-tight [font-variant-numeric:tabular-nums] ${
            custom ? 'bg-brand-violet text-white' : 'bg-surface-muted text-ink-primary'
          }`}
        >
          {fmtRoi(target.current)}
        </span>
        <Icon name="chevronDown" className="h-3 w-3 text-ink-muted" />
      </button>

      {open &&
        createPortal(
          <div
            ref={panelRef}
            id={panelId}
            role="dialog"
            aria-label="Set the target ROI"
            className="dd-enter fixed z-[9999] w-[320px] rounded-[var(--r-lg)] border border-border-default bg-surface-card p-4 shadow-[var(--shadow-lg)]"
            style={{ left: coords.left, top: coords.top }}
          >
            <div className="flex items-start justify-between gap-3">
              <div>
                <div className="text-md font-bold text-ink-primary">Target ROI</div>
                <div className="mt-0.5 text-xs text-ink-muted">
                  The hurdle every promotion on this page is judged against.
                </div>
              </div>
              <span className="grid h-8 w-8 shrink-0 place-items-center rounded-lg bg-brand-violet-50 text-brand-violet [&_svg]:h-4 [&_svg]:w-4">
                <Icon name="target" />
              </span>
            </div>

            {/* THE VALUE. A stepper around a plain text input rather than a
                native number spinner, so the same field reads well in every
                browser and any typed text can be judged, not just numbers. */}
            <div className="mt-3.5 flex items-stretch gap-1.5">
              <button
                type="button"
                aria-label={`Decrease by ${STEP.toFixed(2)}`}
                onClick={() => nudge(-STEP)}
                className="grid w-10 cursor-pointer place-items-center rounded-[var(--r-md)] border border-border-subtle text-lg font-semibold text-ink-secondary transition-colors hover:bg-surface-hover focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-violet"
              >
                −
              </button>
              <div className="relative flex-1">
                <input
                  ref={inputRef}
                  value={draft}
                  inputMode="decimal"
                  aria-label="Target ROI value"
                  aria-invalid={!valid}
                  aria-describedby={valid ? undefined : errorId}
                  onChange={(e) => setDraft(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') apply()
                    if (e.key === 'ArrowUp') { e.preventDefault(); nudge(STEP) }
                    if (e.key === 'ArrowDown') { e.preventDefault(); nudge(-STEP) }
                  }}
                  className={`h-11 w-full rounded-[var(--r-md)] border bg-surface-card text-center text-xl font-bold tracking-[-0.015em] text-ink-primary outline-none transition-[border-color,box-shadow] duration-150 [font-variant-numeric:tabular-nums] focus:ring-2 ${
                    valid
                      ? 'border-border-default focus:border-brand-violet focus:ring-brand-violet/30'
                      : 'border-status-danger text-status-danger focus:ring-status-danger/30'
                  }`}
                />
                <span className="pointer-events-none absolute right-2.5 top-1/2 -translate-y-1/2 text-2xs font-semibold uppercase tracking-wide text-ink-muted">
                  ×
                </span>
              </div>
              <button
                type="button"
                aria-label={`Increase by ${STEP.toFixed(2)}`}
                onClick={() => nudge(STEP)}
                className="grid w-10 cursor-pointer place-items-center rounded-[var(--r-md)] border border-border-subtle text-lg font-semibold text-ink-secondary transition-colors hover:bg-surface-hover focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-violet"
              >
                +
              </button>
            </div>

            {/* What the number means, in the words the target was first set
                in — or why it cannot be applied. Same slot, so the panel does
                not jump between the two. */}
            <div
              id={errorId}
              role={valid ? undefined : 'alert'}
              className={`mt-2 min-h-[18px] text-xs ${valid ? 'text-ink-muted' : 'font-semibold text-status-danger'}`}
            >
              {valid ? (
                <>
                  = <strong className="font-semibold text-ink-secondary">{netReturn}% net return</strong> on every rupee of trade spend
                  {netReturn === 0 ? ' · break-even' : ''}
                </>
              ) : (
                error
              )}
            </div>

            <input
              type="range"
              min={lo}
              max={hi}
              step={0.01}
              value={valid ? parsed : target.current}
              aria-label="Target ROI slider"
              onChange={(e) => setDraft(Number(e.target.value).toFixed(2))}
              className="mt-3 w-full cursor-pointer accent-brand-violet"
            />
            <div className="mt-1 flex justify-between text-2xs font-semibold text-ink-muted [font-variant-numeric:tabular-nums]">
              <span>{lo.toFixed(2)}</span>
              <span>{hi.toFixed(2)}</span>
            </div>

            <div className="mt-3 flex flex-wrap gap-1.5">
              {PRESETS.filter((p) => p >= lo && p <= hi).map((preset) => {
                const active = valid && Math.abs(parsed - preset) < 1e-9
                const isDefault = Math.abs(preset - target.defaultValue) < 1e-9
                return (
                  <button
                    key={preset}
                    type="button"
                    onClick={() => setDraft(preset.toFixed(2))}
                    className={`cursor-pointer rounded-[var(--r-pill)] border px-2.5 py-1 text-xs font-semibold transition-colors [font-variant-numeric:tabular-nums] focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-violet ${
                      active
                        ? 'border-brand-violet bg-brand-violet text-white'
                        : 'border-border-subtle text-ink-secondary hover:border-brand-violet-100 hover:bg-brand-violet-50 hover:text-brand-violet'
                    }`}
                  >
                    {preset.toFixed(2)}
                    {isDefault && <span className={`ml-1 ${active ? 'text-white/80' : 'text-ink-muted'}`}>· default</span>}
                  </button>
                )
              })}
            </div>

            <div className="mt-4 flex items-center justify-between gap-2 border-t border-border-subtle pt-3">
              <button
                type="button"
                disabled={!custom}
                onClick={() => {
                  onApply(null)
                  show(`Target ROI back to the default ${fmtRoi(target.defaultValue)}`, { duration: 2200 })
                  setOpen(false)
                }}
                className="cursor-pointer text-xs font-semibold text-ink-muted transition-colors hover:text-ink-primary disabled:cursor-default disabled:opacity-40 focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-violet"
              >
                Reset to {fmtRoi(target.defaultValue)}
              </button>
              <button
                type="button"
                onClick={apply}
                aria-disabled={!valid}
                className={`inline-flex h-8 cursor-pointer items-center gap-1.5 rounded-[var(--r-md)] px-3.5 text-sm font-semibold text-white transition-[background-color,opacity] focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-violet ${
                  valid ? 'bg-brand-violet hover:bg-brand-violet-600' : 'bg-brand-violet opacity-45'
                }`}
              >
                Apply
                <Icon name="check" className="h-3.5 w-3.5" />
              </button>
            </div>
          </div>,
          document.body,
        )}
    </>
  )
}
