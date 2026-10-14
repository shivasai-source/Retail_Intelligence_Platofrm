import type { ReactNode } from 'react'
import { Icon, type IconName } from '../../icons'

// Ported from css/components.css .kpi / .kpi-label / .kpi-val / .kpi-delta
export function Kpi({
  label,
  value,
  delta,
  deltaDirection,
  icon,
  className = '',
}: {
  label: ReactNode
  value: ReactNode
  delta?: ReactNode
  deltaDirection?: 'up' | 'down'
  icon?: IconName
  className?: string
}) {
  return (
    <div
      className={`relative flex flex-col gap-1.5 overflow-hidden rounded-[var(--r-lg)] border border-border-subtle bg-surface-card p-[18px_20px] ${className}`}
    >
      <div className="flex items-center gap-1.5 text-sm font-medium text-ink-muted">
        {icon && <Icon name={icon} className="h-3.5 w-3.5" />}
        {label}
      </div>
      <div className="kpi-value text-ink-primary">
        {value}
      </div>
      {delta && (
        <div
          className={`inline-flex items-center gap-1 text-sm font-medium [&_svg]:h-3 [&_svg]:w-3 [&_svg]:shrink-0 ${
            deltaDirection === 'up'
              ? 'text-status-success'
              : deltaDirection === 'down'
                ? 'text-status-danger'
                : 'text-ink-muted'
          }`}
        >
          {delta}
        </div>
      )}
    </div>
  )
}
