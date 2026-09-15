import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { apiFetch, apiPost } from '../lib/api'
import type { InvestigationRun } from '../types/agentRun'

// Starts a real agent investigation against an uploaded dataset. Returns
// immediately with a run id — the pipeline continues server-side.
export function useStartInvestigationRun() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (body: {
      question: string
      dataset_id: string | null
      /** The scope a Insights Hub hand-off drilled in with, when there was
       *  one. The backend pins the run to it instead of letting the planning
       *  agent infer a scope from the question's wording. */
      scope?: Record<string, unknown> | null
    }) => apiPost<InvestigationRun>('/investigations/run', body),
    onSuccess: (run) => {
      queryClient.setQueryData(['investigation-run', run.id], run)
      queryClient.invalidateQueries({ queryKey: ['investigations', 'recent'] })
    },
  })
}

// Polls a run while it's in flight. 1.5s is a deliberate middle ground: the
// specialists take a few seconds each, so faster polling is wasted requests,
// and slower makes the progress strip feel laggy. Polling stops the moment
// the run reaches a terminal state.
export function useInvestigationRun(runId: string | undefined) {
  return useQuery({
    queryKey: ['investigation-run', runId],
    queryFn: () => apiFetch<InvestigationRun>(`/investigations/runs/${runId}`),
    enabled: Boolean(runId),
    refetchInterval: (query) => {
      const status = query.state.data?.status
      return status === 'running' ? 1500 : false
    },
  })
}
