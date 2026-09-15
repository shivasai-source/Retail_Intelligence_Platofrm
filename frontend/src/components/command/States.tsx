import type { ReactNode } from 'react'
import { Button } from '../ui'
import { Icon } from '../../icons'
import { ApiError } from '../../lib/api'

/** Skeletons, empty and error states for the Insights Hub.
 *
 *  The rule they exist to enforce: while a new filter scope is loading, the
 *  screen must not keep presenting the previous scope's numbers as though they
 *  were current. React Query's `placeholderData` deliberately keeps the old
 *  response so the layout does not collapse between filter changes — these
 *  components are what marks that data as provisional instead of letting it
 *  read as fact. */

/** One shimmering block. `animate-pulse` only — no bespoke keyframes, and it
 *  respects `prefers-reduced-motion` through Tailwind's own handling. */
function Bar({ className = '', style }: { className?: string; style?: React.CSSProperties }) {
  return <div style={style} className={`animate-pulse rounded-[var(--r-sm)] bg-ink-primary/[0.07] ${className}`} />
}

/** A KPI tile placeholder that occupies the same box as the real tile, so the
 *  grid does not reflow when values arrive. */
export function KpiSkeleton({ delayMs = 0 }: { delayMs?: number }) {
  return (
    <div
      className="fade-in-up flex items-center gap-3 rounded-[var(--r-lg)] border border-border-subtle bg-surface-card p-[16px_18px] shadow-[var(--shadow-card-soft)]"
      style={{ animationDelay: `${delayMs}ms` }}
      aria-hidden="true"
    >
      <Bar className="h-11 w-11 shrink-0 rounded-xl" />
      <div className="min-w-0 flex-1">
        <Bar className="h-3 w-20" />
        <Bar className="mt-2.5 h-5 w-24" />
        <Bar className="mt-2.5 h-3 w-28" />
      </div>
    </div>
  )
}

export function PanelSkeleton({ height = 220 }: { height?: number }) {
  return (
    <div className="p-4" aria-hidden="true">
      <Bar className="h-3 w-32" />
      <Bar className="mt-3 w-full" style={{ height }} />
    </div>
  )
}

/** Wraps a region that is refetching. Keeps the content visible but visibly
 *  provisional, rather than blanking the dashboard on every filter click. */
export function Stale({
  when,
  children,
  className = '',
}: {
  when: boolean
  children: ReactNode
  /** Extra classes on the wrapper. A card that fills a stretched grid cell
   *  needs this element to participate in the flex column rather than collapse
   *  to its content height. Defaults to nothing, so every other caller renders
   *  exactly as before. */
  className?: string
}) {
  return (
    <div
      aria-busy={when}
      className={`transition-opacity duration-200 ${when ? 'pointer-events-none opacity-50' : ''} ${className}`}
    >
      {children}
    </div>
  )
}

/** No rows for the current filter combination.
 *
 *  Deliberately NOT "₹0": zero is a real KPI answer in some scopes, and
 *  rendering it for an empty selection would be a false statement. */
export function EmptyState({
  message = 'No data available for the selected filters.',
  hint,
  onClear,
  compact = false,
}: {
  message?: string
  hint?: string
  onClear?: () => void
  compact?: boolean
}) {
  return (
    <div
      role="status"
      className={`grid place-items-center px-6 text-center ${compact ? 'min-h-[120px]' : 'min-h-[220px]'}`}
    >
      <div>
        <div className="mx-auto grid h-9 w-9 place-items-center rounded-full bg-ink-primary/[0.05] text-ink-muted [&_svg]:h-4 [&_svg]:w-4">
          <Icon name="filter" />
        </div>
        <p className="mt-3 text-base font-semibold text-ink-primary">{message}</p>
        {hint && <p className="mt-1 text-sm text-ink-muted">{hint}</p>}
        {onClear && (
          <Button variant="ghost" size="sm" className="mt-3 cursor-pointer !text-brand-violet" onClick={onClear}>
            Clear all filters
          </Button>
        )}
      </div>
    </div>
  )
}

/** A failed request. Never silently falls back to stale values — the point is
 *  that the user knows the number on screen is not the one they asked for. */
export function ErrorState({
  error,
  onRetry,
  retrying = false,
  compact = false,
}: {
  error: unknown
  onRetry: () => void
  retrying?: boolean
  compact?: boolean
}) {
  const detail = error instanceof Error ? error.message : 'Unknown error'

  // NO DATASET IS NOT A FAILED REQUEST. The six CSVs have been removed — a
  // connector Reset, usually — so retrying cannot bring them back and offering
  // Retry invites the user to keep pressing a button that will never work.
  // `queryClient` re-checks the dataset status on this same error, so
  // `RequireDataset` is already on its way to replacing this with the upload
  // screen; this is what shows in the moment before it does.
  if (error instanceof ApiError && error.datasetMissing) {
    return (
      <div
        role="alert"
        className={`grid place-items-center px-6 text-center ${compact ? 'min-h-[140px]' : 'min-h-[60vh]'}`}
      >
        <div className="max-w-sm">
          <div className="mx-auto grid h-10 w-10 place-items-center rounded-full bg-tint-lavender text-tint-lavender-icon [&_svg]:h-5 [&_svg]:w-5">
            <Icon name="database" />
          </div>
          <p className="mt-3 text-md font-bold text-ink-primary">No dataset loaded</p>
          <p className="mt-1 text-base text-ink-muted">
            The six star-schema tables are no longer in place, so there is nothing to show. Upload them
            again through the connector to continue.
          </p>
        </div>
      </div>
    )
  }

  return (
    <div
      role="alert"
      className={`grid place-items-center px-6 text-center ${compact ? 'min-h-[140px]' : 'min-h-[60vh]'}`}
    >
      <div className="max-w-sm">
        <div className="mx-auto grid h-10 w-10 place-items-center rounded-full bg-status-danger-bg text-status-danger [&_svg]:h-5 [&_svg]:w-5">
          <Icon name="alertTriangle" />
        </div>
        <p className="mt-3 text-md font-bold text-ink-primary">Unable to load data</p>
        <p className="mt-1 text-base text-ink-muted">Please try again.</p>
        <p className="mt-2 break-words text-xs text-ink-muted/80">{detail}</p>
        <Button variant="secondary" size="sm" className="mt-4 cursor-pointer" onClick={onRetry} disabled={retrying}>
          <Icon name="refresh" className={retrying ? 'animate-spin' : ''} />
          {retrying ? 'Retrying…' : 'Retry'}
        </Button>
      </div>
    </div>
  )
}
