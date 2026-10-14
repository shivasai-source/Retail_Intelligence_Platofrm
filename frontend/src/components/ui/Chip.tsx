import type { ReactNode } from 'react'

// Ported from css/components.css .chip / .chip-key / .chip-val
export function Chip({ keyLabel, value }: { keyLabel: ReactNode; value: ReactNode }) {
  return (
    <span className="inline-flex items-center gap-1.5 rounded-[var(--r-md)] border border-border-subtle bg-surface-muted px-2.5 py-1 text-sm font-medium text-ink-primary">
      <span className="font-medium text-ink-muted">{keyLabel}</span>
      <span className="font-medium text-ink-primary">{value}</span>
    </span>
  )
}
