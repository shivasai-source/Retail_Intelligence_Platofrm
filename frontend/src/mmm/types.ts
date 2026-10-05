/** MMM payload types. Each mirrors one backend module in backend/app/mmm/. */

/** GET /api/mmm/dataset — app/mmm/dataset.py#status. Shaped like TPO's
 *  /api/datasets/star plus the present/total counts the strip and gate read. */
export interface MmmStatusGroup {
  key: 'core' | 'media' | 'promo' | 'calendar'
  label: string
  required: boolean
  columns: string[]
  found: number
  present: boolean
}

export interface MmmStatus {
  data_dir: string
  files: MmmStatusGroup[]
  present: number
  total: number
  complete: boolean
  rows: number
  period: { from: string | null; to: string | null }
  media_channels: number
  source_name: string | null
  size_bytes: number
  modified_at: string | null
}

/** POST /api/mmm/dataset */
export interface MmmInstallResult {
  installed: boolean
  rows: number
  media_columns: string[]
  missing_optional: string[]
  ignored: string[]
  warnings: string[]
  status: MmmStatus
}

/** POST /api/mmm/dataset/inspect */
export interface MmmInspectResult {
  filename: string
  columns: string[]
  ok: boolean
  problems: string[]
  media_columns: string[]
  missing_required: string[]
  missing_optional: string[]
  ignored: string[]
}

/** GET /api/mmm/dataset/preview */
export interface MmmPreview {
  columns: string[]
  rows: Array<Array<string | number | null>>
  total: number
  offset: number
}

/** GET /api/mmm/filters — app/mmm/service.py#filters */
export interface MmmFilterOptions {
  years: number[]
  quarters: Array<{ code: number; name: string }>
  months: Array<{ code: number; name: string }>
  weeks: number[]
  channels: Array<{ code: string; name: string; family: string }>
  promotion_types: string[]
  events: Array<{ code: string; name: string }>
  /** ISO dates, YYYY-MM-DD. */
  date_range: { from: string; to: string }
}

/** GET /api/mmm/hub — app/mmm/service.py#hub */
export interface MmmKpi {
  key: string
  label: string
  value: number | null
  display: string
  kind: 'currency' | 'multiple' | 'count'
  previous: number | null
  delta: number | null
  delta_display: string
  /** "vs 01 Jan – 30 Sep 2025", or '' when there is no comparison. */
  comparison: string
  available: boolean
  unavailable_reason: string
  help: string
}

export interface MmmChannel {
  column: string
  label: string
  family: string
  spend: number
  spend_display: string
  share: number
  share_display: string
  active_days: number
  avg_active_day: number | null
  avg_active_day_display: string
}

/** app/mmm/baseline.py#Estimate.to_dict, plus the scope's total. */
export interface MmmBaseline {
  available: boolean
  reason: string
  per_day: number | null
  per_day_display: string
  x: number | null
  x_display: string
  y: number | null
  y_display: string
  z: number | null
  z_display: string
  r: number | null
  r_display: string
  days: { x: number; y: number; r: number }
  window: { from: string | null; to: string | null; label: string }
  widened: boolean
  total: number | null
  total_display: string
  scope_days: number
}

export interface MmmFigure {
  value: number | null
  display: string
}

export interface MmmComparisonWindow {
  key: 'yago' | 'pago' | 'mago'
  label: string
  full: string
  available: boolean
  reason: string
  period_label: string
  values: Record<string, MmmFigure>
  delta: Record<string, { value: number | null; display: string; basis: string; good: boolean | null }>
}

export interface MmmHub {
  meta: {
    scope: MmmScopeWire
    years: number[]
    period: { from: string; to: string }
    period_label: string
    /** Days in scope after the promotion-type and event filters. */
    days: number
    /** Days in the period before those filters. */
    period_days: number
    contiguous: boolean
    currency: string
    /** Display-currency units per rupee; raw values are always rupees. */
    exchange_rate: number
    channels: number
    channels_total: number
    comparison: string
    data_range: string
  }
  baseline: MmmBaseline
  kpis: MmmKpi[]
  trend: {
    granularity: 'day' | 'week' | 'month'
    labels: string[]
    revenue: number[]
    spend: number[]
    baseline: Array<number | null>
    roas: Array<number | null>
    revenue_display: string[]
    spend_display: string[]
    baseline_display: string[]
    roas_display: string[]
    widened: boolean[]
  }
  comparison: {
    period_label: string
    metrics: Array<{ key: string; label: string; unit: 'currency' | 'multiple' | 'count'; formula: string }>
    current: Record<string, MmmFigure>
    windows: MmmComparisonWindow[]
  }
  channels: MmmChannel[]
  families: Array<{ family: string; spend: number; spend_display: string; share: number; share_display: string }>
  promotions: Array<{
    type: string
    days: number
    share_of_days: number
    revenue: number
    revenue_display: string
    share_of_revenue: number
    avg_revenue: number
    avg_revenue_display: string
  }>
  events: Array<{
    key: string
    label: string
    with_days: number
    without_days: number
    with_avg: number | null
    with_avg_display: string
    without_avg: number | null
    without_avg_display: string
    difference: number | null
    difference_display: string
  }>
}

/** The scope as the backend echoes it (app/mmm/scope.py#Scope.to_dict) and as
 *  a report carries it in `options.filters`. */
export interface MmmScopeWire {
  year: number | null
  quarter: number | null
  month: number | null
  week: number | null
  date_from: string | null
  date_to: string | null
  channels: string[]
  promotion_types: string[]
  events: string[]
}

/** GET /api/mmm/calendar — app/mmm/calendar.py#matrix */
export interface MmmCalendarCell {
  month: number
  spend: number
  spend_display: string
  active_days: number
  /** 0 = off air, 1–4 = quartile of the year's non-zero channel-months. */
  level: 0 | 1 | 2 | 3 | 4
  has_data: boolean
}

export interface MmmCalendarMonth {
  month: number
  name: string
  abbr: string
  has_data: boolean
  days: number
  revenue: number
  revenue_display: string
  spend: number
  spend_display: string
  media_days: number
  promo_days: number
  holidays: number
  trending_days: number
}

export interface MmmCalendar {
  year: number
  years: number[]
  currency: string
  months: MmmCalendarMonth[]
  channels: Array<{
    column: string
    label: string
    family: string
    total: number
    total_display: string
    cells: MmmCalendarCell[]
  }>
}

/** GET /api/mmm/calendar/month — app/mmm/calendar.py#month_detail */
export interface MmmCalendarDay {
  date: string
  weekday: string
  day: number
  revenue: number
  revenue_display: string
  spend: number
  spend_display: string
  channels: Array<{ label: string; spend_display: string }>
  holiday: boolean
  trending: boolean
  promotion: boolean
  promotion_type: string
}

export interface MmmCalendarMonthDetail {
  year: number
  month: number
  month_name: string
  currency: string
  days: MmmCalendarDay[]
}
