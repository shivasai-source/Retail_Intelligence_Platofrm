import { useQuery } from '@tanstack/react-query'
import { apiFetch } from '../lib/api'
import type { CalendarCellDetail, CalendarMatrix, UpcomingResponse } from '../types/promotionCalendar'

/** Promotion Calendar data access.
 *
 *  Two small requests, never the fact table: the matrix carries one summary per
 *  Channel x Month (60 objects at most) and the detail is fetched only for the
 *  cell the user actually opened. */

export function usePromotionMatrix(year: number, channels: string[]) {
  const query = new URLSearchParams({ year: String(year) })
  // Repeated `channel` params, matching the list-parameter convention the
  // Insights Hub filters already use.
  for (const channel of channels) query.append('channel', channel)

  return useQuery({
    queryKey: ['promotion-calendar', 'matrix', year, [...channels].sort()],
    queryFn: () => apiFetch<CalendarMatrix>(`/promotion-calendar/matrix?${query}`),
    // The calendar for a year does not change while the page is open; keeping
    // the previous year's grid mounted during a switch avoids a full-card
    // skeleton on every toggle.
    placeholderData: (previous) => previous,
  })
}

export function usePromotionCell(selection: { year: number; month: number; channel: string } | null) {
  return useQuery({
    queryKey: ['promotion-calendar', 'cell', selection?.year, selection?.month, selection?.channel],
    queryFn: () =>
      apiFetch<CalendarCellDetail>(
        `/promotion-calendar/cell?year=${selection!.year}&month=${selection!.month}&channel=${selection!.channel}`,
      ),
    enabled: selection !== null,
    placeholderData: (previous) => previous,
  })
}

/** The Upcoming feed for the current calendar context.
 *
 *  Keyed on year, the month being viewed and the channel scope, so changing
 *  any of the three refetches — the panel is never a fixed list. */
export function useUpcoming(year: number, afterMonth: number, channels: string[]) {
  const query = new URLSearchParams({ year: String(year), after_month: String(afterMonth), limit: '80' })
  for (const channel of channels) query.append('channel', channel)

  return useQuery({
    queryKey: ['promotion-calendar', 'upcoming', year, afterMonth, [...channels].sort()],
    queryFn: () => apiFetch<UpcomingResponse>(`/promotion-calendar/upcoming?${query}`),
    placeholderData: (previous) => previous,
  })
}
