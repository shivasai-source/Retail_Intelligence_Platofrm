/** Wire types for `/api/promotion-calendar`.
 *
 *  Every promotion name, mechanic, description and type on these objects is
 *  resolved server-side from dim_promotion_final.csv. The frontend must not
 *  keep a lookup table of its own — see `promo_calendar.py` for why there is
 *  exactly one source of truth. */

/** Presentation bucket behind the legend, not a business category. */
export type CellKind = 'none' | 'regular' | 'seasonal' | 'festival' | 'no_data'

/** How a channel's promotions actually run in a store, read from the data:
 *  single weeks, or a whole calendar month. */
export type Booking = 'week' | 'month'

export type Cadence = 'WEEKLY' | 'MONTHLY'

export interface CalendarCell {
  month: number
  kind: CellKind
  /** The event description(s) from the promotion master, or "Regular" / "No
   *  Promo". Never assembled in the frontend. */
  label: string
  promotion_ids: string[]
  /** DISTINCT products promoted in this Channel x Month. */
  product_count: number
  /** Distinct stores that ran any of the cell's promotions. */
  store_count: number
  /** Business weeks with a promotion running in the cell. */
  week_count: number
  promotion_count: number
  /** Regular promotions running alongside a named seasonal event. */
  extra_regular: number
}

export interface CalendarChannelRow {
  channel_id: string
  name: string
  cadence: Cadence
  booking: Booking
  cells: CalendarCell[]
}

export interface CalendarMatrix {
  year: number
  years: number[]
  months: { month: number; name: string; abbr: string }[]
  /** Every channel, regardless of the current filter — the channel picker is
   *  built from this so narrowing to one channel still offers the others. */
  all_channels: { channel_id: string; name: string; cadence: Cadence; booking: Booking }[]
  /** Only the channels in the current filter scope. */
  channels: CalendarChannelRow[]
}

export interface CalendarProduct {
  product_id: string
  name: string
  brand_form: string
  category: string
  size: string
  /** 1-4 within the Brand Form. Rank 1 is never promoted. */
  rank: number
}

export interface CalendarPromotion {
  promotion_id: string
  /** dim_promotion.Promotion_Name — the mechanic. */
  mechanic: string
  /** dim_promotion.Promotion_Type. */
  type: string
  /** dim_promotion.Promotion_Description — the event. */
  description: string
  /** True when the id has no row in the promotion master; the UI shows the id
   *  and flags the gap instead of inventing a name. */
  metadata_missing: boolean
  product_count: number
  store_count?: number
  weeks?: number[]
  /** First and last calendar day it ran in this month. */
  start?: string | null
  end?: string | null
  products: CalendarProduct[]
  stores?: { store_id: string; name: string; city: string; region: string }[]
}

export interface CalendarWeek {
  week_key: string
  week_number: number
  week_start: string | null
  promotions: CalendarPromotion[]
}

export interface CalendarCellDetail {
  year: number
  month: number
  month_name: string
  channel: { channel_id: string; name: string; cadence: Cadence; booking: Booking }
  cell: CalendarCell
  promotions: CalendarPromotion[]
  /** Populated for WEEKLY channels only. */
  weeks: CalendarWeek[]
}

/** One entry in the contextual Upcoming feed.
 *
 *  `source` says where it came from: `promotion` is a promotion start derived
 *  from the calendar aggregate, `event` is a business event from the app's
 *  existing calendar data. `channel_id` is null for an event that applies to
 *  every channel. */
export interface UpcomingEvent {
  date: string
  month: number
  name: string
  /** Regular | Seasonal for promotions; review | launch | extension | data |
   *  closure for business events. Never invented — both come from data. */
  type: string
  source: 'promotion' | 'event'
  promotion_id: string | null
  channel_id: string | null
  channel_name: string
  product_count: number | null
  store_count?: number | null
  week_number: number | null
}

export interface UpcomingResponse {
  year: number
  after_month: number
  total: number
  events: UpcomingEvent[]
}
