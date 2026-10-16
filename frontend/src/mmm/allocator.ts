import { keepPreviousData, useQuery } from '@tanstack/react-query'
import { apiFetch, apiPost } from '../lib/api'
import type { ChannelCurve, Delta, FigureKey, Figures, Mode, ModelCard, Source, WeekPoint } from './budget'

/** The MMM Budget Allocator's API (backend app/mmm/allocator.py).
 *
 *  For a period and an entered budget, three plans:
 *    actual     what the period really spent
 *    same_mix   the entered budget, split as the actual plan splits it
 *    optimized  the entered budget, split for the most net profit */

export type Scenario = 'actual' | 'same_mix' | 'optimized'

export interface AllocChannel {
  key: string
  label: string
  actual: number
  actual_display: string
  same: number
  same_display: string
  optimized: number
  optimized_display: string
  share_actual_pct: number
  share_optimized_pct: number
  /** Optimized - same mix. */
  change: number
  change_display: string
  change_vs_actual: number
  change_vs_actual_display: string
  media_actual_display: string
  media_same_display: string
  media_optimized_display: string
  media_change_display: string
  /** What the next rupee returns in the optimized plan. */
  marginal: number
  marginal_display: string
  /** A week of the optimized plan is past the channel's highest weekly spend in the data. */
  beyond_data: boolean
}

export interface Allocation {
  mode: Mode
  currency: string
  exchange_rate: number
  draws: number
  scope: { start: number; end: number; weeks: { key: number; label: string; start: string }[]; carryover_tail_days: number }
  channel_count: number
  budget: { value: number; display: string }
  actual_budget: { value: number; display: string }
  budget_change: { value: number; display: string; percent: number }
  scenarios: Record<Scenario, Figures>
  deltas: Record<'budget' | 'mix' | 'total', Record<FigureKey, Delta | null>>
  chance_mix_gain_pct: number
  chance_total_gain_pct: number
  channels: AllocChannel[]
  weekly: WeekPoint[]
  curves: ChannelCurve[]
  model: ModelCard
}

export interface FrontierPoint {
  spend: number
  same: number
  same_range: [number, number]
  best: number
  best_range: [number, number]
}

export interface Frontier {
  currency: string
  exchange_rate: number
  points: FrontierPoint[]
  actual_budget: number
  peak: { spend: number; profit: number; range: [number, number]; spend_display: string; profit_display: string }
}

export function useAllocation(
  start: number | null,
  end: number | null,
  budget: number | null,
  currency: string,
  mode: Mode,
  source: Source = 'history',
) {
  return useQuery({
    queryKey: ['mmm', 'allocator', 'plan', start, end, budget, currency, mode, source],
    queryFn: () => apiPost<Allocation>('/mmm/budget/allocate', { start, end, budget, currency, mode, source }),
    enabled: start != null && end != null && budget != null && budget > 0,
    placeholderData: keepPreviousData,
    staleTime: Infinity,
  })
}

/** Net profit at every budget -- independent of the entered budget. */
export function useFrontier(start: number | null, end: number | null, currency: string, mode: Mode, source: Source = 'history') {
  return useQuery({
    queryKey: ['mmm', 'allocator', 'frontier', start, end, currency, mode, source],
    queryFn: () => apiFetch<Frontier>(`/mmm/budget/frontier?start=${start}&end=${end}&currency=${currency}&mode=${mode}&source=${source}`),
    enabled: start != null && end != null,
    placeholderData: keepPreviousData,
    staleTime: Infinity,
  })
}
