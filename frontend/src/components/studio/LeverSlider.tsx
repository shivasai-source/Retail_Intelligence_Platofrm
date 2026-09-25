import { useId } from 'react'
import type { Lever } from '../../types/studio'

/** One lever: its name, its live value, a native range input, and one short
 *  line beneath it.
 *
 *  NATIVE `<input type="range">` on purpose: keyboard operation, screen-reader
 *  semantics and touch behaviour are correct for free, and the value is read
 *  out through `aria-valuetext` in the unit a person would say ("14 days",
 *  "₹1.4 Cr"), not the raw number. Min, max and step come from the API's
 *  lever definition — the page writes down no range of its own. */
export function LeverSlider({
  label,
  lever,
  value,
  format,
  onChange,
  disabled,
  marks,
  children,
  vary,
}: {
  label: string
  lever: Lever
  value: number
  /** The value as a person would say it — used for the readout and aria. */
  format: (value: number) => string
  onChange: (value: number) => void
  disabled?: boolean
  /** Labels for the two ends of the track. */
  marks: [string, string]
  /** One line beneath the track. */
  children?: React.ReactNode
  /** Optimize's tick for this lever: whether it is free to vary, the range
   *  it would search (in words), and the toggle. The tick renders only when
   *  this is given — a page without Optimize never shows it. */
  vary?: { on: boolean; range: string; onToggle: () => void }
}) {
  const id = useId()
  return (
    <div className="rounded-[var(--r-lg)] border border-border-subtle bg-surface-card px-5 py-4 shadow-[var(--shadow-card-soft)]">
      <div className="flex items-center justify-between gap-3">
        <div className="flex min-w-0 items-center gap-3">
          <label htmlFor={id} className="text-md font-bold text-ink-primary">
            {label}
          </label>
          {vary && (
            <label className="inline-flex cursor-pointer select-none items-center gap-1.5 text-sm font-medium text-ink-secondary">
              <input
                type="checkbox"
                checked={vary.on}
                onChange={vary.onToggle}
                className="h-3.5 w-3.5 cursor-pointer accent-brand-violet"
              />
              Optimize
            </label>
          )}
        </div>
        <output
          htmlFor={id}
          className="rounded-[var(--r-pill)] bg-brand-violet-50 px-3 py-1 text-md font-extrabold text-brand-violet [font-variant-numeric:tabular-nums]"
        >
          {format(value)}
        </output>
      </div>
      <input
        id={id}
        type="range"
        min={lever.min}
        max={lever.max}
        step={lever.step}
        value={value}
        disabled={disabled}
        aria-valuetext={format(value)}
        onChange={(e) => onChange(Number(e.target.value))}
        className="mt-4 w-full cursor-pointer accent-brand-violet disabled:cursor-not-allowed"
      />
      <div className="mt-1 flex justify-between text-sm text-ink-secondary [font-variant-numeric:tabular-nums]">
        <span>{marks[0]}</span>
        <span>{marks[1]}</span>
      </div>
      {vary?.on && (
        <div className="mt-2 text-sm font-semibold text-brand-violet [font-variant-numeric:tabular-nums]">
          Optimize searches {vary.range}
        </div>
      )}
      {children && <div className="mt-3 text-base text-ink-secondary">{children}</div>}
    </div>
  )
}
