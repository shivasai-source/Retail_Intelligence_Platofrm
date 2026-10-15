import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { apiDelete, apiFetch, apiUpload } from '../lib/api'
import type { Figures, ModelCard } from './budget'

/** The MMM Revenue Forecast's API (backend app/mmm/forecast.py): a future
 *  ad plan, uploaded without Revenue, and the revenue it is predicted to earn. */

export interface ForecastStatus {
  loaded: boolean
  name?: string
  uploaded_at?: string
}

/** One day, week or month of the forecast; amounts in rupees. */
export interface ForecastPoint {
  label: string
  start: string
  days: number
  spend: number
  baseline: number
  media: number
  media_range: [number, number]
  revenue: number
  revenue_range: [number, number]
  profit: number
  profit_range: [number, number]
  roas: number | null
}

export type Grain = 'day' | 'week' | 'month'

export interface ForecastChannel {
  key: string
  label: string
  spend: number
  spend_display: string
  share_pct: number
  media: number
  media_display: string
  media_range: { p10: number; p90: number; display: string }
  roas: number | null
  roas_display: string
  active_days: number
}

export interface ForecastYear {
  label: string
  from: string
  to: string
  days: number
  spend_display: string
  baseline_display: string
  media_display: string
  revenue_display: string
  revenue_range_display: string
  profit_display: string
  roas_display: string
}

export interface ForecastSummary {
  currency: string
  /** Display-currency units per rupee. */
  exchange_rate: number
  draws: number
  plan: {
    name: string | null
    uploaded_at: string | null
    notes: string[]
    start: string
    end: string
    days: number
    ad_days: number
    history_end: string
    channels: number
  }
  figures: Figures
  series: Record<Grain, ForecastPoint[]>
  channels: ForecastChannel[]
  years: ForecastYear[]
  /** The first whole weeks of the plan: where the optimizer opens. */
  optimize_default: { start: number; end: number } | null
  model: ModelCard
}

const ROOT = ['mmm', 'forecast'] as const

export function useForecastStatus(enabled = true) {
  return useQuery({
    queryKey: [...ROOT, 'status'],
    queryFn: () => apiFetch<ForecastStatus>('/mmm/forecast'),
    enabled,
  })
}

export function useForecastSummary(enabled: boolean, currency: string) {
  return useQuery({
    queryKey: [...ROOT, 'summary', currency],
    queryFn: () => apiFetch<ForecastSummary>(`/mmm/forecast/summary?currency=${currency}`),
    enabled,
    placeholderData: keepPreviousData,
  })
}

/** A new or removed plan changes every forecast-based plan, so all of them
 *  are dropped. */
function useInvalidate() {
  const queries = useQueryClient()
  return () => {
    void queries.invalidateQueries({ queryKey: ROOT })
    void queries.removeQueries({ predicate: (q) => q.queryKey.includes('forecast') && q.queryKey[0] === 'mmm' && q.queryKey[1] !== 'forecast' })
  }
}

export function useForecastUpload() {
  const invalidate = useInvalidate()
  return useMutation<ForecastStatus, Error, File>({
    mutationFn: (file) => {
      const form = new FormData()
      form.append('file', file)
      return apiUpload<ForecastStatus>('/mmm/forecast', form)
    },
    onSuccess: invalidate,
  })
}

export function useForecastReset() {
  const invalidate = useInvalidate()
  return useMutation<ForecastStatus, Error, void>({
    mutationFn: () => apiDelete<ForecastStatus>('/mmm/forecast'),
    onSuccess: invalidate,
  })
}
