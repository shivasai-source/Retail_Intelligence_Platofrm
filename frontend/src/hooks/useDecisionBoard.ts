import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { apiDelete, apiFetch, apiPost } from '../lib/api'
import type { BoardDecision, DecisionScenario } from '../store/decisionScenarios'

/** The Decision Center's saved decisions — `/api/store/board-decisions`.
 *  A save stores the board whole (the studio's snapshots, the chosen slot and
 *  the rationale); the list is the history; a load brings one back to review. */

export interface BoardDecisionSummary {
  decision_id: string
  created_at: string
  chosen_slot: number | null
  chosen_label: string | null
  scenario_count: number
  rationale: string
  summary: Partial<Record<'revenue' | 'roi' | 'discount' | 'days' | 'budget', string>>
  dataset_version: string
  stale?: boolean
}

const KEY = ['board-decisions'] as const

export function useBoardDecisions() {
  return useQuery({
    queryKey: KEY,
    queryFn: () => apiFetch<{ decisions: BoardDecisionSummary[] }>('/store/board-decisions'),
    staleTime: 30_000,
  })
}

export function useSaveBoardDecision() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (body: { scenarios: DecisionScenario[]; chosen_slot: number | null; rationale: string }) =>
      apiPost<BoardDecision>('/store/board-decisions', body),
    onSuccess: () => qc.invalidateQueries({ queryKey: KEY }),
  })
}

export function useLoadBoardDecision() {
  return useMutation({
    mutationFn: (id: string) => apiFetch<BoardDecision>(`/store/board-decisions/${id}`),
  })
}

export function useClearBoardDecisions() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: () => apiDelete<{ removed: number }>('/store/board-decisions'),
    onSuccess: () => qc.invalidateQueries({ queryKey: KEY }),
  })
}
