import { toneForEventType } from './statusColors'
import type { UpcomingEvent } from '../../types/promotionCalendar'

/** Upcoming Events — a CONTEXTUAL feed, never a fixed list.
 *
 *  It answers "what is coming next?" for exactly the calendar state on screen:
 *  the selected year, the month being viewed, and the channel scope. Selecting
 *  January shows February onward; selecting March shows April onward; filtering
 *  to CH002 drops every other channel. The feed never crosses into another
 *  year, because the matrix beside it is a one-year plan.
 *
 *  Every entry is a promotion start from the calendar aggregate -- the data's
 *  own promotions, nothing hand-written. No date, name, channel or type is
 *  written down here. */

const MONTH_ABBR = ['JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN', 'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC']

function EventRow({ event }: { event: UpcomingEvent }) {
  // Same palette as the grid: a Seasonal promotion here is the same violet it
  // is in the cell it belongs to.
  const tone = toneForEventType(event.type)
  const day = event.date.slice(8, 10)
  const month = MONTH_ABBR[event.month - 1]

  return (
    <div className="flex items-start gap-2.5 border-b border-border-subtle py-2.5 last:border-b-0">
      <div
        className="grid h-10 w-10 shrink-0 place-items-center rounded-[var(--r-sm)]"
        style={{ background: tone.tint }}
      >
        <span className="text-base font-medium leading-none tabular-nums" style={{ color: tone.solid }}>
          {day}
        </span>
        <span className="mt-0.5 text-2xs font-medium leading-none" style={{ color: tone.solid }}>
          {month}
        </span>
      </div>
      <div className="min-w-0 flex-1">
        <p className="truncate text-sm font-medium text-ink-primary" title={event.name}>
          {event.name}
        </p>
        <div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs">
          {/* Labelled as well as coloured — the status is never colour-only. */}
          <span
            className="rounded-full px-1.5 py-px font-medium"
            style={{ background: tone.tint, color: tone.solid }}
          >
            {event.type}
          </span>
          {/* The real channel, never a blanket "All" when one is selected. */}
          <span className="truncate text-ink-muted">
            {event.channel_id ? `${event.channel_id} · ${event.channel_name}` : event.channel_name}
          </span>
          {event.promotion_id && (
            <span className="text-ink-disabled">
              {event.promotion_id}
              {event.product_count !== null && ` · ${event.product_count} products`}
              {event.store_count != null && ` · ${event.store_count} stores`}
            </span>
          )}
        </div>
      </div>
    </div>
  )
}

export function UpcomingEventsPanel({
  events,
  total,
  contextLabel,
  loading,
  expanded,
  onToggleExpanded,
}: {
  events: UpcomingEvent[]
  total: number
  /** e.g. "after October · CH002" — says what the feed is relative to. */
  contextLabel: string
  loading: boolean
  /** Owned by the page, because expanding re-weights this panel against the
   *  Promotion Details panel sharing the same column. */
  expanded: boolean
  onToggleExpanded: () => void
}) {
  return (
    /* min-h-0 at every level, or the list expands its parent instead of
       scrolling and the right column drives the page height. */
    <div className="flex min-h-0 flex-1 flex-col">
      {/* Fixed header — only the list below it scrolls. */}
      <div className="shrink-0 border-b border-border-subtle px-5 py-4">
        <h3 className="text-md font-medium">Upcoming</h3>
        <p className="mt-0.5 truncate text-sm text-ink-muted" title={contextLabel}>
          {contextLabel}
        </p>
      </div>

      {events.length === 0 ? (
        <div className="grid min-h-[140px] place-items-center px-6 text-center text-sm text-ink-muted">
          {loading ? 'Loading upcoming activity…' : 'No upcoming events for this selection.'}
        </div>
      ) : (
        <>
          {/* Fills whatever height the column gives it; capped only when the
              layout has stacked and there is no row height to fill. */}
          <div className="min-h-0 flex-1 overflow-y-auto px-5 @max-[1179px]:max-h-[420px]">
            {events.map((event, i) => (
              <EventRow key={`${event.date}-${event.channel_id ?? 'all'}-${event.promotion_id ?? event.name}-${i}`} event={event} />
            ))}
          </div>

          {events.length > 5 && (
            <button
              type="button"
              onClick={onToggleExpanded}
              className="shrink-0 cursor-pointer border-t border-border-subtle px-5 py-2.5 text-sm font-medium text-brand-violet transition-colors hover:bg-surface-hover"
            >
              {expanded ? 'Show less' : `View more events (${total})`}
            </button>
          )}
        </>
      )}
    </div>
  )
}
