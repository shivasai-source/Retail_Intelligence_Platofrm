import { useEffect, useId, useRef, useState } from 'react'
import { Icon } from '../../icons'
import { useToast } from '../ui'
import { fmtRoi } from '../../lib/roi'

/** THE TARGET ROI, set by the reader.
 *
 *  Every "below target" — the Target Hit Rate card, the alert bands and their
 *  counts, the money at stake, the dashed line on the trend chart — is judged
 *  against one hurdle. It shipped as a constant (1.50) and this form makes it
 *  the reader's: a value between the bounds the backend states, applied to
 *  every panel at once and remembered for the session.
 *
 *  Three ways to set it, all bound to one draft: type it, drag it, or pick a
 *  preset. The draft is validated as it is typed; an out-of-range or
 *  non-numeric value shows why, disables Apply, and — if the reader tries to
 *  apply it anyway — says so in a toast. The "net return" line beneath the
 *  value translates the multiple into the language the 50% target was set
 *  in, so 1.75 reads as "75% net return on trade spend" at a glance.
 *
 *  A FORM, NOT A POPOVER. This was the body of a toolbar popover on the
 *  Insights Hub (TargetRoiControl). The target is now set in the alerts
 *  dialog on Investigations, as the first step before the events are listed
 *  — so the anchoring, positioning and outside-click machinery went, and
 *  what is left is the one thing both places ever needed: the form itself,
 *  rendered inside whatever surface holds it.
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

export function TargetRoiForm({
  target,
  onApply,
  submitLabel = 'Apply',
  autoFocus = true,
}: {
  target: TargetRoiInfo
  /** `null` means "back to the default". */
  onApply: (value: number | null) => void
  /** What the confirming button says — "Apply" on its own, "Show alerts"
   *  when applying is the step before a list. */
  submitLabel?: string
  autoFocus?: boolean
}) {
  const { show } = useToast()
  const [draft, setDraft] = useState(target.current.toFixed(2))
  const inputRef = useRef<HTMLInputElement>(null)
  const errorId = useId()

  // Reopen on the live value, whatever the last draft was.
  useEffect(() => {
    setDraft(target.current.toFixed(2))
  }, [target.current])

  // Land in the input, text selected, so a typed value replaces it.
  useEffect(() => {
    if (!autoFocus) return
    const id = window.requestAnimationFrame(() => inputRef.current?.select())
    return () => window.cancelAnimationFrame(id)
  }, [autoFocus])

  const custom = Math.abs(target.current - target.defaultValue) > 1e-9
  const parsed = parseDraft(draft)
  const valid = inRange(parsed, target.range)
  const [lo, hi] = target.range
  const error = valid
    ? null
    : parsed === null
      ? 'Enter a number, such as 1.50.'
      : `Enter a value between ${lo.toFixed(2)} and ${hi.toFixed(2)}.`

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
      isDefault ? `Target ROI back to the default ${fmtRoi(target.defaultValue)}` : `Target ROI set to ${fmtRoi(value)}`,
      { duration: 2200 },
    )
  }

  const nudge = (delta: number) => {
    const base = valid ? parsed : target.current
    const next = Math.min(hi, Math.max(lo, Math.round((base + delta) * 100) / 100))
    setDraft(next.toFixed(2))
  }

  const netReturn = valid ? Math.round((parsed - 1) * 100) : null

  return (
    <div>
      {/* THE VALUE. A stepper around a plain text input rather than a native
          number spinner, so the same field reads well in every browser and any
          typed text can be judged, not just numbers. */}
      <div className="flex items-stretch gap-1.5">
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

      {/* What the number means, in the words the target was first set in — or
          why it cannot be applied. Same slot, so the form does not jump
          between the two. */}
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
          }}
          className="cursor-pointer text-xs font-semibold text-ink-muted transition-colors hover:text-ink-primary disabled:cursor-default disabled:opacity-40 focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-violet"
        >
          Reset to {fmtRoi(target.defaultValue)}
        </button>
        <button
          type="button"
          onClick={apply}
          aria-disabled={!valid}
          className={`inline-flex h-9 cursor-pointer items-center gap-1.5 rounded-[var(--r-md)] px-4 text-sm font-semibold text-white transition-[background-color,opacity] focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-violet ${
            valid ? 'bg-brand-violet hover:bg-brand-violet-600' : 'bg-brand-violet opacity-45'
          }`}
        >
          {submitLabel}
          <Icon name="arrowRight" className="h-3.5 w-3.5" />
        </button>
      </div>
    </div>
  )
}
