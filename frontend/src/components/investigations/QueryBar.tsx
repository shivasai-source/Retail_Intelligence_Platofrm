import { Icon } from '../../icons'
import { Button, Spinner } from '../ui'
import { AlertPicker } from './AlertPicker'

// Ported from js/pages/investigations.js's `.inv-query` block. Two ways in:
// type a question and run it, or pick one of the Insights Hub's underperforming
// promotion events (AlertPicker) and let the hand-off compose the question.
export function QueryBar({
  value,
  onChange,
  onSubmit,
  loading,
  loadingLabel,
}: {
  value: string
  onChange: (v: string) => void
  onSubmit: () => void
  loading?: boolean
  loadingLabel?: string
}) {
  return (
    <div className="fade-in mb-4 flex items-center gap-2.5 rounded-[var(--r-lg)] border border-border-default bg-surface-card p-[10px_12px_10px_16px] shadow-[var(--shadow-sm)] transition-[border-color,box-shadow] duration-150 focus-within:border-brand-violet focus-within:shadow-[0_0_0_3px_rgba(107,71,255,0.12)]">
      <span className="inline-flex shrink-0 text-brand-violet [&_svg]:h-[18px] [&_svg]:w-[18px]">
        <Icon name="sparkles" />
      </span>
      <input
        type="text"
        autoComplete="off"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            e.preventDefault()
            onSubmit()
          }
        }}
        placeholder="Ask TIQ to investigate a promotion… e.g. Why did South MT Push underperform despite higher trade spend?"
        className="min-w-0 flex-1 border-0 bg-transparent p-[6px_2px] text-base font-medium text-ink-primary outline-none placeholder:font-normal placeholder:text-ink-muted"
      />
      <AlertPicker disabled={loading} />
      <Button variant="primary" onClick={onSubmit} disabled={loading} className="shrink-0 whitespace-nowrap">
        {loading ? (
          <>
            <Spinner /> <span>{loadingLabel}</span>
          </>
        ) : (
          <>
            <Icon name="zap" /> <span>Investigate</span>
          </>
        )}
      </Button>
    </div>
  )
}
