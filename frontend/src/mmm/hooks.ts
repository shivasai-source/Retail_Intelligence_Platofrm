import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { apiDelete, apiFetch, apiPost, apiUpload } from '../lib/api'
import type {
  MmmAzureRef,
  MmmDbxRef,
  MmmDeliveryInspect,
  MmmSourceStatus,
  MmmSyncResult,
  MmmCalendar,
  MmmCalendarMonthDetail,
  MmmFilterOptions,
  MmmHub,
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

/** A DELIVERY: one file, or several periods of the one daily table.
 *
 *  `mappings` is keyed by filename, because a client who renamed a column half
 *  way through the year is the ordinary case and one file's names must never
 *  be applied to another's columns. */
export interface MmmUploadArgs {
  files: File[]
  /** filename -> (actual -> canonical). Omitted when the headers are ours. */
  mappings?: Record<string, Record<string, string>>
  /** Work out which days each file covers. Costs a full read of every file,
   *  so the caller asks once per selection rather than on every edit. */
  coverage?: boolean
}

function uploadForm({ files, mappings, coverage }: MmmUploadArgs): FormData {
  const form = new FormData()
  for (const file of files) form.append('files', file)
  // Sent even when empty, so the server reads one contract rather than
  // guessing whether an absent field means "no mapping" or "not supported".
  form.append('mapping', JSON.stringify(mappings ?? {}))
  if (coverage) form.append('coverage', '1')
  return form
}

export function useMmmUpload() {
  const queries = useQueryClient()
  return useMutation<MmmInstallResult, Error, MmmUploadArgs>({
    mutationFn: (args) => apiUpload<MmmInstallResult>('/mmm/dataset', uploadForm(args)),
    onSuccess: () => void queries.invalidateQueries({ queryKey: ROOT }),
  })
}

/** Header-only check: what MMM reads from this file, and what mapping it
 *  suggests. Used for workbooks, which the browser cannot open, and for every
 *  edit on the mapping screen — the answer comes from the rules the install
 *  will actually use, so the screen cannot promise something it will not do. */
export function useMmmInspect() {
  return useMutation<MmmDeliveryInspect, Error, MmmUploadArgs>({
    mutationFn: (args) => apiUpload<MmmDeliveryInspect>('/mmm/dataset/inspect', uploadForm(args)),
  })
}

// ===== installing from a connected source =====
// The Azure and Databricks halves of MMM's one-file install. Mutations rather
// than queries for the same reason TPO's are: each carries a SAS token or a
// personal access token in its body, which must never land in a react-query
// cache key.

/** The selected blobs, as MMM would read them. Downloads only each file's
 *  header unless `coverage` asks which days they cover. */
export function useMmmAzureInspect() {
  return useMutation<MmmDeliveryInspect, Error, MmmAzureRef>({
    mutationFn: (ref) => apiPost<MmmDeliveryInspect>('/mmm/dataset/azure/inspect', ref),
  })
}

/** Installs that blob as MMM's dataset, replacing any loaded one. */
export function useMmmAzureInstall() {
  const queries = useQueryClient()
  return useMutation<MmmInstallResult, Error, MmmAzureRef>({
    mutationFn: (ref) => apiPost<MmmInstallResult>('/mmm/dataset/azure/install', ref),
    onSuccess: () => void queries.invalidateQueries({ queryKey: ROOT }),
  })
}

/** The selected tables, as MMM would read them. Unity Catalog's column list
 *  only — no warehouse, no query, no data — unless `coverage` is asked for. */
export function useMmmDbxInspect() {
  return useMutation<MmmDeliveryInspect, Error, MmmDbxRef>({
    mutationFn: (ref) => apiPost<MmmDeliveryInspect>('/mmm/dataset/databricks/inspect', ref),
  })
}

/** Exports that table to CSV and installs it as MMM's dataset. */
export function useMmmDbxInstall() {
  const queries = useQueryClient()
  return useMutation<MmmInstallResult, Error, MmmDbxRef>({
    mutationFn: (ref) => apiPost<MmmInstallResult>('/mmm/dataset/databricks/install', ref),
    onSuccess: () => void queries.invalidateQueries({ queryKey: ROOT }),
  })
}

// ===== the connected source, and pulling it again =====

/** Where the loaded dataset came from, for MMM's Live pill. Never the token. */
export function useMmmSource() {
  return useQuery({
    queryKey: [...ROOT, 'source'],
    queryFn: () => apiFetch<MmmSourceStatus>('/mmm/dataset/source'),
  })
}

/** Re-read the connected blob or table, with the same column mapping the
 *  install used, and swap it in. */
export function useMmmSourceSync() {
  const queries = useQueryClient()
  return useMutation<MmmSyncResult, Error, void>({
    mutationFn: () => apiPost<MmmSyncResult>('/mmm/dataset/source/sync', {}),
    // Replaced the file behind every MMM page, as an install does. A failed
    // sync still records its error, so the status is refreshed either way.
    // NOT returned: react-query would hold the mutation pending — the pill
    // spinning — until every MMM query had refetched, long after the sync
    // itself finished. MmmSyncStatus waits for them deliberately instead.
    onSettled: () => {
      void queries.invalidateQueries()
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
