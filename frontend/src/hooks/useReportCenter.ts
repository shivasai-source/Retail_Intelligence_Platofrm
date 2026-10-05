import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { apiFetch, apiPost } from '../lib/api'
import type {
  GenerateReportRequest,
  ReportFamily,
  ReportFormat,
  ReportLibrary,
  ReportRecord,
} from '../types/reportCenter'

/** The Report Center client.
 *
 *  GENERATE IS NOT DOWNLOAD, and this file is where the separation lives on the
 *  client. `useGenerateReport` posts a scope and receives METADATA; nothing here
 *  touches a blob or an anchor. A file reaches the browser only through
 *  `downloadArtifact`, which the Report Center calls when a person clicks Excel
 *  or PDF.
 */

const KEY = ['report-center'] as const

/** GET /api/reports — the library.
 *
 *  A query, not a mutation: it is page state that several actions invalidate.
 */
export function useReportLibrary(params: {
  module?: string | null
  format?: ReportFormat | null
  search?: string
  /** One intelligence module's reports only — TPO's or MMM's. */
  family?: ReportFamily
}) {
  const search = new URLSearchParams()
  if (params.family) search.set('family', params.family)
  if (params.module) search.set('module', params.module)
  if (params.format) search.set('format', params.format)
  if (params.search?.trim()) search.set('search', params.search.trim())
  const qs = search.toString()

  return useQuery({
    queryKey: [...KEY, qs],
    queryFn: () => apiFetch<ReportLibrary>(`/reports${qs ? `?${qs}` : ''}`),
  })
}

/** POST /api/reports — generate into the Report Center.
 *
 *  RESOLVES WITH METADATA. The caller shows "Report generated successfully" and
 *  offers a link to the library; it does not receive, and cannot save, a file.
 */
export function useGenerateReport() {
  const queries = useQueryClient()
  return useMutation<ReportRecord, Error, GenerateReportRequest>({
    mutationFn: (body) => apiPost<ReportRecord>('/reports', body),
    // The library is stale the moment a report lands in it.
    onSuccess: () => void queries.invalidateQueries({ queryKey: KEY }),
  })
}

/** DELETE /api/reports/{id} — remove a report and its artifacts together. */
export function useDeleteReport() {
  const queries = useQueryClient()
  return useMutation<void, Error, string>({
    mutationFn: async (reportId) => {
      const response = await fetch(`/api/reports/${encodeURIComponent(reportId)}`, {
        method: 'DELETE',
      })
      if (!response.ok && response.status !== 204) {
        throw new Error(await detailOf(response))
      }
    },
    onSuccess: () => void queries.invalidateQueries({ queryKey: KEY }),
  })
}

/** DELETE /api/reports — empty the Report Center.
 *
 *  Removes every report and its artifacts, not just the rows the page is
 *  currently filtered to: a clear that spared what a filter was hiding would
 *  leave reports behind in a library the user believes is empty. The server
 *  answers with the count removed so the caller can report it.
 */
export function useClearReports(family?: ReportFamily) {
  const queries = useQueryClient()
  return useMutation<{ deleted: number; total: number }, Error, void>({
    mutationFn: async () => {
      const response = await fetch(`/api/reports${family ? `?family=${family}` : ''}`, {
        method: 'DELETE',
      })
      if (!response.ok) throw new Error(await detailOf(response))
      return (await response.json()) as { deleted: number; total: number }
    },
    onSuccess: () => void queries.invalidateQueries({ queryKey: KEY }),
  })
}

async function detailOf(response: Response): Promise<string> {
  try {
    const body = (await response.json()) as { detail?: unknown }
    if (typeof body.detail === 'string') return body.detail
  } catch {
    /* not JSON */
  }
  return `Request failed: ${response.status} ${response.statusText}`
}

function filenameFrom(header: string | null, fallback: string): string {
  if (!header) return fallback
  return /filename\*?=(?:UTF-8'')?"?([^";]+)"?/i.exec(header)?.[1]?.trim() || fallback
}

/** Download ONE stored artifact.
 *
 *  THE ONLY PLACE THIS APPLICATION SAVES A FILE. It fetches an artifact that
 *  already exists on the server — nothing is generated here — and resolves only
 *  once the browser has actually been handed the bytes, so a caller that
 *  announces a download has one behind it.
 */
export async function downloadArtifact(
  reportId: string,
  format: ReportFormat,
  fallbackName: string,
): Promise<{ filename: string; bytes: number }> {
  const response = await fetch(
    `/api/reports/${encodeURIComponent(reportId)}/download/${format}`,
  )
  if (!response.ok) throw new Error(await detailOf(response))

  const blob = await response.blob()
  if (blob.size === 0) {
    // Never announce a download for an empty file: an empty workbook opens to a
    // blank grid and reads as "we measured nothing", which is a different claim
    // from "the artifact is missing".
    throw new Error('The stored artifact came back empty. Nothing was downloaded.')
  }

  const filename = filenameFrom(response.headers.get('Content-Disposition'), fallbackName)
  // The same synthetic-anchor technique hooks/useBriefing.ts already uses for the
  // decision briefing — this project's one proven download path, not a second.
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = filename
  anchor.rel = 'noopener'
  document.body.appendChild(anchor)
  anchor.click()
  document.body.removeChild(anchor)
  setTimeout(() => URL.revokeObjectURL(url), 0)

  return { filename, bytes: blob.size }
}
