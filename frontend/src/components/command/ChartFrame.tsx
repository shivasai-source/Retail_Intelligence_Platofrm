import type { ReactNode } from 'react'
import { Card, CardHeader, CardBody, InfoPopover } from '../ui'
import { EmptyState, ErrorState, PanelSkeleton, Stale } from './States'

/** The shell every chart sits in.
 *
 *  It exists so loading, staleness, emptiness and failure are handled once,
 *  identically, for every chart — rather than each chart inventing its own and
 *  drifting. A chart component receives only data it can actually draw; the
 *  frame decides whether there is any.
 *
 *  Order matters: error beats empty beats loading. A failed request must never
 *  be reported as "no data for these filters", which would blame the user's
 *  filter for a backend problem. */
export function ChartFrame({
  title,
  hint,
  actions,
  controls,
  fill = false,
  isLoading,
  isFetching,
  error,
  onRetry,
  isEmpty,
  emptyMessage,
  footnote,
  height = 210,
  children,
}: {
  title: ReactNode
  /** Optional ⓘ explanation of what the chart shows. */
  hint?: string
  actions?: ReactNode
  /** A control strip rendered directly under the header, on its own row.
   *
   *  For cards whose controls are too wide to share the header line with the
   *  title: forcing them in either clips them or wraps the header, and a
   *  wrapped header is taller than its neighbour's, so the two cards in a row
   *  stop starting their content at the same height. Same treatment the Risk
   *  Alerts panel already uses for its severity tabs.
   *
   *  It sits OUTSIDE the loading/error swap, so the controls keep their
   *  position while a refetch is in flight rather than vanishing and
   *  reappearing. */
  controls?: ReactNode
  /** Fill the grid cell rather than sitting at the natural height of the
   *  content. Cards in a two-column row are stretched to the taller of the
   *  pair; a chart with few categories otherwise leaves the remainder of its
   *  own border blank. With this set, the chart body receives the full height
   *  and decides how to use it. */
  fill?: boolean
  isLoading: boolean
  isFetching: boolean
  error: unknown
  onRetry: () => void
  isEmpty: boolean
  emptyMessage?: string
  /** Shown under the chart — used for the truncation notice, so a Top-N view
   *  never implies it is the whole population. */
  footnote?: ReactNode
  height?: number
  children: ReactNode
}) {
  return (
    <Card className={fill ? 'flex h-full flex-col' : ''}>
      <CardHeader
        title={
          <span className="flex items-center gap-1.5">
            {title}
            {hint && (
              <InfoPopover label={`About ${typeof title === 'string' ? title : 'this chart'}`} title="What this shows">
                <p className="mt-1.5 text-xs leading-snug text-ink-secondary">{hint}</p>
              </InfoPopover>
            )}
          </span>
        }
        actions={actions}
      />
      {controls && (
        <div className="flex flex-wrap items-center gap-2 border-b border-border-subtle px-5 py-2.5">
          {controls}
        </div>
      )}
      <CardBody className={fill ? 'flex flex-1 flex-col' : ''}>
        {error ? (
          <ErrorState error={error} onRetry={onRetry} retrying={isFetching} compact />
        ) : isLoading ? (
          <PanelSkeleton height={height} />
        ) : isEmpty ? (
          <EmptyState message={emptyMessage} compact />
        ) : (
          <Stale when={isFetching} className={fill ? 'flex flex-1 flex-col' : ''}>
            {children}
          </Stale>
        )}
        {!error && !isLoading && !isEmpty && footnote && (
          <p className="mt-2 text-xs text-ink-muted">{footnote}</p>
        )}
      </CardBody>
    </Card>
  )
}
