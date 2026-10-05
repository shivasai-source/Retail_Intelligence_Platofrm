import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { apiDelete, apiFetch, apiUpload } from '../lib/api'
import type {
  MmmCalendar,
  MmmCalendarMonthDetail,
  MmmFilterOptions,
  MmmHub,
  MmmInspectResult,
  MmmInstallResult,
  MmmPreview,
  MmmScopeWire,
  MmmStatus,
} from './types'

/** Every /api/mmm/* call, as react-query hooks. The routes live in
 *  backend/app/mmm/router.py. Everything MMM reads shares the `mmm` key root,
 *  so an upload or reset refreshes the whole module in one invalidation. */

const ROOT = ['mmm'] as const

/** What is installed — the strip, the gate and the sidebar padlock all read
 *  this, the way TPO's read useStarStatus. */
export function useMmmStatus() {
  return useQuery({
    queryKey: [...ROOT, 'status'],
    queryFn: () => apiFetch<MmmStatus>('/mmm/dataset'),
  })
}

export function useMmmUpload() {
  const queries = useQueryClient()
  return useMutation<MmmInstallResult, Error, File>({
    mutationFn: (file) => {
      const form = new FormData()
      form.append('file', file)
      return apiUpload<MmmInstallResult>('/mmm/dataset', form)
    },
    onSuccess: () => void queries.invalidateQueries({ queryKey: ROOT }),
  })
}

/** Header-only check for workbooks, which the browser cannot open. */
export function useMmmInspect() {
  return useMutation<MmmInspectResult, Error, File>({
    mutationFn: (file) => {
      const form = new FormData()
      form.append('file', file)
      return apiUpload<MmmInspectResult>('/mmm/dataset/inspect', form)
    },
  })
}

export function useMmmReset() {
  const queries = useQueryClient()
  return useMutation<MmmStatus, Error, void>({
    mutationFn: () => apiDelete<MmmStatus>('/mmm/dataset'),
    onSuccess: () => void queries.invalidateQueries({ queryKey: ROOT }),
  })
}

export function useMmmPreview(limit = 100, enabled = true) {
  return useQuery({
    queryKey: [...ROOT, 'preview', limit],
    queryFn: () => apiFetch<MmmPreview>(`/mmm/dataset/preview?limit=${limit}`),
    enabled,
  })
}

/** Every option the Insights Hub filter bar offers. */
export function useMmmFilterOptions() {
  return useQuery({
    queryKey: [...ROOT, 'filters'],
    queryFn: () => apiFetch<MmmFilterOptions>('/mmm/filters'),
    staleTime: Infinity,
  })
}

/** The Insights Hub for one scope. Lists repeat their key, as the backend
 *  reads them (`channel=TV_Spend&channel=OTT_Spend`). */
export function useMmmHub(
  scope: MmmScopeWire,
  granularity: 'day' | 'week' | 'month',
  currency: string,
  enabled = true,
) {
  const qs = new URLSearchParams({ granularity, currency })
  for (const key of ['year', 'quarter', 'month', 'week', 'date_from', 'date_to'] as const) {
    const value = scope[key]
    if (value !== null && value !== undefined) qs.set(key, String(value))
  }
  for (const c of scope.channels) qs.append('channel', c)
  for (const p of scope.promotion_types) qs.append('promotion_type', p)
  for (const e of scope.events) qs.append('event', e)
  return useQuery({
    queryKey: [...ROOT, 'hub', qs.toString()],
    queryFn: () => apiFetch<MmmHub>(`/mmm/hub?${qs}`),
    placeholderData: (previous) => previous,
    enabled,
  })
}

/** `year` null asks for the latest year in the data. */
export function useMmmCalendar(year: number | null, currency: string) {
  const qs = new URLSearchParams({ currency })
  if (year !== null) qs.set('year', String(year))
  return useQuery({
    queryKey: [...ROOT, 'calendar', qs.toString()],
    queryFn: () => apiFetch<MmmCalendar>(`/mmm/calendar?${qs}`),
    placeholderData: (previous) => previous,
  })
}

export function useMmmCalendarMonth(year: number | null, month: number | null, currency: string) {
  return useQuery({
    queryKey: [...ROOT, 'calendar-month', year, month, currency],
    queryFn: () =>
      apiFetch<MmmCalendarMonthDetail>(
        `/mmm/calendar/month?year=${year}&month=${month}&currency=${currency}`,
      ),
    enabled: year !== null && month !== null,
  })
}
