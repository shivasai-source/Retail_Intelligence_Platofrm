import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { apiDelete, apiFetch, apiPost, apiUpload } from '../lib/api'
import type {
  AzureBlobListing,
  AzureContainer,
  DatasetDetail,
  DatasetSummary,
  DbxCatalog,
  DbxSchema,
  DbxTableListing,
  DbxTableSel,
  SourceStatus,
  SourceSyncResult,
  StarInspectResult,
  StarInstallResult,
  StarPreview,
  StarResetResult,
  StarRole,
  StarStatus,
  UploadResult,
} from '../types/dataset'

/** Workspace URL + personal access token, as the Databricks routes take them.
 *  Held in component state for the life of the modal and sent per request. */
export interface DbxCreds {
  workspace_url: string
  token: string
}

/** Storage account + SAS, as the Azure routes take them. Held in component
 *  state for the life of the modal and sent per request; a successful install
 *  saves it server-side for syncing (backend/app/source_sync.py). */
export interface AzureCreds {
  account: string
  sas: string
}

/** A blob the user has picked, addressed within the account. */
export interface AzureBlobSel {
  container: string
  name: string
}

export function useDatasets() {
  return useQuery({
    queryKey: ['datasets'],
    queryFn: () => apiFetch<DatasetSummary[]>('/datasets'),
  })
}

// Which of the six star-schema CSVs the Data/ folder currently holds. This is
// the folder every dashboard and KPI reads, so it — not the uploads list — is
// what tells the Excel connector whether real data is wired up.
export function useStarStatus() {
  return useQuery({
    queryKey: ['datasets', 'star'],
    queryFn: () => apiFetch<StarStatus>('/datasets/star'),
  })
}

// Where the loaded dataset came from, and when it was last pulled. Drives the
// Live pill: a dataset from Azure or Databricks can be synced from there.
export function useSourceStatus() {
  return useQuery({
    queryKey: ['datasets', 'source'],
    queryFn: () => apiFetch<SourceStatus>('/datasets/source'),
  })
}

// Re-read the connected source's six tables and swap them in. On failure the
// server keeps the data it had, so there is nothing to undo here.
export function useSourceSync() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: () => apiPost<SourceSyncResult>('/datasets/source/sync', {}),
    // Replaced the CSVs behind every KPI, chart and filter, as an install does.
    // A failed sync still records its error, so the status is refreshed too.
    onSettled: () => queryClient.invalidateQueries(),
  })
}

export function useDataset(datasetId: string | undefined) {
  return useQuery({
    queryKey: ['datasets', datasetId],
    queryFn: () => apiFetch<DatasetDetail>(`/datasets/${datasetId}`),
    enabled: Boolean(datasetId),
  })
}

// Real multipart upload — the file actually lands on the backend, gets parsed
// by pandas and profiled (see backend/app/dataset_store.py). Replaces the old
// fake 1.1s setTimeout that never sent anything anywhere.
export function useUploadDatasets() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (files: File[]) => {
      const form = new FormData()
      files.forEach((f) => form.append('files', f))
      return apiUpload<UploadResult>('/datasets', form)
    },
    onSuccess: (result) => {
      queryClient.invalidateQueries({ queryKey: ['datasets'] })
      // A star install replaces the CSVs behind every KPI, chart and filter in
      // the platform, so nothing cached client-side describes the current data
      // any more. Blanket-invalidate rather than listing the dozens of query
      // keys that would each need naming here.
      if (result.star?.installed.length) queryClient.invalidateQueries()
    },
  })
}

// A page of rows from one installed star table. Enabled only when a role is
// actually selected, so opening the connector doesn't fetch six previews.
export function useStarPreview(role: StarRole | null, offset = 0) {
  return useQuery({
    queryKey: ['datasets', 'star', 'preview', role, offset],
    queryFn: () => apiFetch<StarPreview>(`/datasets/star/preview/${role}?offset=${offset}`),
    enabled: Boolean(role),
  })
}

// Clear all six files. Destructive and deliberate: it is the only route back to
// the upload prompt, since uploading over a complete set is refused.
export function useResetStar() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: () => apiDelete<StarResetResult>('/datasets/star'),
    onSuccess: () => {
      // Same reasoning as a star install: every KPI, chart and filter in the
      // app was derived from the files just deleted, so nothing cached still
      // describes the current state.
      queryClient.invalidateQueries()
    },
  })
}

// ===== Azure Blob Storage =====
// All four are mutations rather than queries: each carries a SAS token in its
// body, which must not end up in a react-query cache key.

export function useAzureContainers() {
  return useMutation({
    mutationFn: (creds: AzureCreds) =>
      apiPost<{ containers: AzureContainer[]; container_scoped: boolean }>(
        '/datasets/azure/containers',
        creds,
      ),
  })
}

export function useAzureBlobs() {
  return useMutation({
    mutationFn: (req: AzureCreds & { container: string; prefix: string }) =>
      apiPost<AzureBlobListing>('/datasets/azure/blobs', req),
  })
}

// Header-only reads of the picked blobs, so the modal can name which table each
// file is before committing to downloading 21 MB.
export function useAzureInspect() {
  return useMutation({
    mutationFn: (req: AzureCreds & { blobs: AzureBlobSel[] }) =>
      apiPost<StarInspectResult>('/datasets/azure/inspect', req),
  })
}

export function useAzureInstall() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (req: AzureCreds & { blobs: AzureBlobSel[]; progress_id?: string }) =>
      apiPost<StarInstallResult>('/datasets/azure/install', req),
    onSuccess: () => {
      // Same blanket invalidation as an Excel install: this replaced the CSVs
      // behind every KPI, chart and filter in the platform.
      queryClient.invalidateQueries()
    },
  })
}

/** GET /datasets/azure/progress/{id} — how far an Azure install has got. */
export interface AzureInstallProgress {
  stage: 'downloading' | 'installing' | 'done' | 'failed'
  bytes_done: number
  bytes_total: number
}

/** Polls an in-flight Azure install's real progress, twice a second, while
 *  `active`. A 404 just means the server has not registered the id yet (the
 *  poll can beat the install request there), so it keeps polling. */
export function useAzureInstallProgress(progressId: string | null, active: boolean) {
  return useQuery({
    queryKey: ['azure-install-progress', progressId],
    queryFn: () => apiFetch<AzureInstallProgress>(`/datasets/azure/progress/${progressId}`),
    enabled: active && progressId !== null,
    refetchInterval: active ? 500 : false,
    retry: false,
    gcTime: 0,
  })
}

// ===== Databricks Unity Catalog =====
// Mutations for the same reason the Azure ones are: each carries a personal
// access token in its body, which must not end up in a react-query cache key.

export function useDbxCatalogs() {
  return useMutation({
    mutationFn: (creds: DbxCreds) =>
      apiPost<{ catalogs: DbxCatalog[] }>('/datasets/databricks/catalogs', creds),
  })
}

export function useDbxSchemas() {
  return useMutation({
    mutationFn: (req: DbxCreds & { catalog: string }) =>
      apiPost<{ schemas: DbxSchema[] }>('/datasets/databricks/schemas', req),
  })
}

export function useDbxTables() {
  return useMutation({
    mutationFn: (req: DbxCreds & { catalog: string; schema_name: string }) =>
      apiPost<DbxTableListing>('/datasets/databricks/tables', req),
  })
}

// Identification from catalog metadata alone — no query, no warehouse, no rows.
export function useDbxInspect() {
  return useMutation({
    mutationFn: (req: DbxCreds & { tables: DbxTableSel[] }) =>
      apiPost<StarInspectResult>('/datasets/databricks/inspect', req),
  })
}

export function useDbxInstall() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (req: DbxCreds & { tables: DbxTableSel[] }) =>
      apiPost<StarInstallResult>('/datasets/databricks/install', req),
    onSuccess: () => {
      // Replaced the CSVs behind every KPI, chart and filter in the platform.
      queryClient.invalidateQueries()
    },
  })
}

export function useDeleteDataset() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (datasetId: string) => apiDelete<{ ok: boolean }>(`/datasets/${datasetId}`),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['datasets'] })
    },
  })
}
