import { keepPreviousData, useQuery } from '@tanstack/react-query'
import { apiPost } from '../lib/api'
import type {
  BestResponse,
  CountRule,
  CurveResponse,
  PlannerOptions,
  PlannerSelection,
  SummaryResponse,
  TargetResponse,
  TimingRule,
  ProfitBasis,
  WhatIfResponse,
} from '../types/planner'

/** The Promotion Planner's reads. Every one is a QUERY keyed on its inputs:
 *  the answers are pure functions of the selection and the controls, so
 *  revisiting a position is instant from cache, and while a new one resolves
 *  the previous answer stays on screen (`placeholderData`) with `isFetching`
 *  saying it is stale. */

const COMMON = { staleTime: 5 * 60_000, retry: false, placeholderData: keepPreviousData } as const

export function usePlannerOptions(selection: PlannerSelection) {
  return useQuery({
    queryKey: ['planner', 'options', selection],
    queryFn: () => apiPost<PlannerOptions>('/planner/options', { selection }),
    ...COMMON,
  })
}

export function usePlannerSummary(selection: PlannerSelection | null, currency: string) {
  return useQuery({
    queryKey: ['planner', 'summary', selection, currency],
    queryFn: () => apiPost<SummaryResponse>('/planner/summary', { selection, currency }),
    enabled: selection !== null,
    staleTime: 5 * 60_000,
    retry: false,
  })
}

export function usePlannerWhatIf(selection: PlannerSelection | null, currency: string, discount: number | null) {
  return useQuery({
    queryKey: ['planner', 'whatif', selection, currency, discount],
    queryFn: () => apiPost<WhatIfResponse>('/planner/whatif', { selection, currency, discount_pct: discount }),
    enabled: selection !== null && discount !== null,
    ...COMMON,
  })
}

export function usePlannerCurve(selection: PlannerSelection | null, currency: string, enabled = true) {
  return useQuery({
    queryKey: ['planner', 'curve', selection, currency],
    queryFn: () => apiPost<CurveResponse>('/planner/curve', { selection, currency }),
    enabled: selection !== null && enabled,
    ...COMMON,
  })
}

export function usePlannerBest(selection: PlannerSelection | null, currency: string, timing: TimingRule, count: CountRule, enabled = true) {
  return useQuery({
    queryKey: ['planner', 'best', selection, currency, timing, count],
    queryFn: () => apiPost<BestResponse>('/planner/best', { selection, currency, timing, count }),
    enabled: selection !== null && enabled,
    ...COMMON,
  })
}

export function usePlannerTarget(
  selection: PlannerSelection | null,
  currency: string,
  targetPct: number | null,
  timing: TimingRule,
  count: CountRule,
  basis: ProfitBasis,
  enabled = true,
) {
  return useQuery({
    queryKey: ['planner', 'target', selection, currency, targetPct, timing, count, basis],
    queryFn: () => apiPost<TargetResponse>('/planner/target', { selection, currency, target_pct: targetPct, timing, count, basis }),
    enabled: selection !== null && enabled && targetPct !== null && targetPct > 0,
    ...COMMON,
  })
}
