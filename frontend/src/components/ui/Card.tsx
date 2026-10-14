import type { HTMLAttributes, ReactNode } from 'react'

// Ported from css/components.css .card / .card-hd / .card-bd / .card-ft
export function Card({ className = '', ...props }: HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      className={`rounded-[var(--r-lg)] border border-border-subtle bg-surface-card shadow-[var(--shadow-sm)] ${className}`}
      {...props}
    />
  )
}

export function CardHeader({
  title,
  subtitle,
  actions,
  className = '',
}: {
  title: ReactNode
  subtitle?: ReactNode
  actions?: ReactNode
  className?: string
}) {
  return (
    // min-h pins every card's divider to the same line. Without it a header
    // whose actions slot holds a 30px control (e.g. the trend card's
    // granularity dropdown) sits ~6px lower than one holding plain text, so
    // two cards side by side start their content at different heights.
    <div
      className={`flex min-h-[52px] items-center justify-between gap-3 border-b border-border-subtle px-5 py-3 ${className}`}
    >
      <div>
        <h3 className="text-md font-medium">{title}</h3>
        {subtitle && <div className="mt-0.5 text-sm text-ink-muted">{subtitle}</div>}
      </div>
      {actions}
    </div>
  )
}

export function CardBody({ className = '', ...props }: HTMLAttributes<HTMLDivElement>) {
  return <div className={`p-4 ${className}`} {...props} />
}

export function CardFooter({ className = '', ...props }: HTMLAttributes<HTMLDivElement>) {
  return <div className={`border-t border-border-subtle px-5 py-3 ${className}`} {...props} />
}
