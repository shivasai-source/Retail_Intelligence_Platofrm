/** THE ONE SEGMENTED SWITCH every card on the Insights Hub draws.
 *
 *  It used to be five copies of the same markup — the metric switches on
 *  Promotion Mix, Promotion Contribution, Product Performance and Regular vs
 *  Seasonal, the comparison-period switch on Performance Comparison, and the
 *  mechanic switch on Channel Performance — each with its own small drift in
 *  height and padding. One component, so the strip is the same 23px control
 *  wherever a reader meets it, and a change to its look lands everywhere. */
export function Segmented<T extends string>({
  options,
  value,
  onChange,
  ariaLabel,
}: {
  options: { key: T; label: string; title?: string }[]
  value: T
  onChange: (v: T) => void
  ariaLabel: string
}) {
  return (
    <div
      className="inline-flex h-[23px] items-stretch overflow-hidden rounded-[var(--r-sm)] border border-border-subtle"
      role="radiogroup"
      aria-label={ariaLabel}
    >
      {options.map((o) => (
        <button
          key={o.key}
          type="button"
          role="radio"
          aria-checked={value === o.key}
          title={o.title}
          onClick={() => onChange(o.key)}
          className={`cursor-pointer px-2 text-xs font-semibold transition-colors focus:outline-none focus-visible:ring-1 focus-visible:ring-brand-violet ${
            value === o.key
              ? 'bg-brand-violet text-white'
              : 'text-ink-muted hover:bg-surface-hover hover:text-ink-primary'
          }`}
        >
          {o.label}
        </button>
      ))}
    </div>
  )
}
