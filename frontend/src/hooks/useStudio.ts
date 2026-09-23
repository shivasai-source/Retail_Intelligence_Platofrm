import { useEffect, useState } from 'react'
import { keepPreviousData, useMutation, useQuery } from '@tanstack/react-query'
import { apiPost } from '../lib/api'
import type { ApiFilters } from '../lib/scope'
import type { CurveResponse, OptimizeRequest, OptimizeResponse, ScopeResponse, SimulateResponse } from '../types/studio'

/** POST /api/simulation/scope — what the page needs before a slider moves:
 *  the measured plan, the fitted lift model and each lever's range and
 *  starting value. Re-fetched only when the scope or the currency changes. */
export function useStudioScope(filters: ApiFilters, currency: string) {
  return useQuery({
    queryKey: ['studio', 'scope', filters, currency],
    queryFn: () => apiPost<ScopeResponse>('/simulation/scope', { filters, currency }),
    staleTime: 5 * 60_000,
    retry: false,
  })
}

export interface Levers {
  discount_pct: number
  trade_spend: number
  days: number
}

/** POST /api/simulation/simulate — the three levers → the window.
 *
 *  A QUERY KEYED ON THE LEVERS, not a mutation: the levers are the page's
 *  state and the result is a pure function of them, so react-query's cache
 *  makes dragging back to a value you already visited instant. While a new
 *  position resolves the previous result stays on screen (`placeholderData`)
 *  and `isFetching` says it is stale, so the tiles never blank between ticks.
 */
export function useStudioSimulate(filters: ApiFilters, currency: string, levers: Levers | null) {
  return useQuery({
    queryKey: ['studio', 'simulate', filters, currency, levers],
    queryFn: () => apiPost<SimulateResponse>('/simulation/simulate', { filters, currency, ...levers }),
    enabled: levers !== null,
    placeholderData: keepPreviousData,
    staleTime: 5 * 60_000,
    retry: false,
  })
}

/** POST /api/simulation/curve — Revenue and ROI at every discount depth for
 *  the chosen budget and days. Keyed on those two only, so dragging the
 *  discount slider moves a marker along a curve that is already on screen. */
export function useStudioCurve(filters: ApiFilters, currency: string, levers: Levers | null) {
  const key = levers ? { trade_spend: levers.trade_spend, days: levers.days } : null
  return useQuery({
    queryKey: ['studio', 'curve', filters, currency, key],
    queryFn: () => apiPost<CurveResponse>('/simulation/curve', { filters, currency, ...key }),
    enabled: key !== null,
    placeholderData: keepPreviousData,
    staleTime: 5 * 60_000,
    retry: false,
  })
}

/** A value that follows `value` after it has stopped changing for `ms`.
 *
 *  The sliders update on every pointer move; the request goes out once the
 *  hand pauses. 120ms is below what reads as lag and above what a drag emits
 *  between frames. */
export function useDebounced<T>(value: T, ms = 120): T {
  const [settled, setSettled] = useState(value)
  useEffect(() => {
    const id = window.setTimeout(() => setSettled(value), ms)
    return () => window.clearTimeout(id)
  }, [value, ms])
  return settled
}

/** POST /api/simulation/optimize — the best levers, for ROI, inside the
 *  ranges the reader ticked.
 *
 *  A MUTATION, unlike the three queries above: it runs when the button is
 *  pressed, not whenever its inputs change, and its answer is a
 *  recommendation the reader applies or dismisses rather than state the page
 *  is always showing. */
export function useStudioOptimize() {
  return useMutation({
    mutationFn: (body: OptimizeRequest) => apiPost<OptimizeResponse>('/simulation/optimize', body),
  })
}

