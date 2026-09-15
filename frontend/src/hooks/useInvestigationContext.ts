import { useMutation } from '@tanstack/react-query'
import { apiPost } from '../lib/api'
import { toSimulationFilters } from './useSimulation'
import type { CommandFilters } from '../store/commandFilters'
import type { ActiveInvEntry } from '../store/activeInvestigation'
import type { InvestigationType } from '../types/investigation'
import type { InvestigationContextRequest, SimulationContext } from '../types/investigationContext'

/** The RCA → Simulation handoff — B3.1.
 *
 *  Contract and data path only. Nothing in the UI calls this yet; B3.2 wires
 *  it into the Simulation Studio.
 */
export function useInvestigationContext() {
  return useMutation<SimulationContext, Error, InvestigationContextRequest>({
    mutationFn: (body) => apiPost<SimulationContext>('/simulation/context', body),
  })
}

/** Assemble the handoff from the state the app actually holds.
 *
 *  TWO STORES, TWO ROLES, and the split is the honest part:
 *
 *    * `activeInvestigation` holds the investigation — the archetype and the
 *      free-text question the user typed on the Investigations page. That is
 *      the only genuinely RCA-sourced content in the app.
 *    * `commandFilters` holds the scope. RCA produces no FilterState: its own
 *      "context chips" are display strings like "Modern Trade" and
 *      "Apr – Jun 2025", and converting those back into Channel_Ids and a
 *      month range would be guessing. The Insights Hub's selection is the
 *      validated scope, and it is what Simulation already simulates.
 *
 *  `investigation_started` is the load-bearing flag. The store seeds itself
 *  with an example question copied from investigation-types.json, so a user
 *  who has never run an investigation still carries one. Passing
 *  `list.length > 0` lets the backend refuse to report that seeded sentence as
 *  the user's question — without it, a fresh session would hand Simulation an
 *  authored question and present it as the investigation's own.
 *
 *  NO KPI VALUE IS SENT. RCA's figures are presentation data; Simulation
 *  measures the scope for itself.
 */
export function toInvestigationContextRequest(
  filters: CommandFilters,
  investigation: {
    activeType: InvestigationType
    activeQuestion: string
    list: ActiveInvEntry[]
  },
  /** B10: the SERVER-MINTED `inv_…` this browser was given the first time it
   *  stored a scenario for this investigation, or null before that. Never a
   *  browser-generated id — the store mints it and the client only carries it
   *  back, which is what lets a decision be traced to its investigation
   *  without any frozen contract changing. */
  investigationId: string | null = null,
): InvestigationContextRequest {
  return {
    filters: toSimulationFilters(filters),
    question: investigation.activeQuestion || null,
    investigation_started: investigation.list.length > 0,
    investigation_type: investigation.activeType,
    // RCA still assigns no identifier of its own. Until a scenario has been
    // stored there is nothing to send, and null keeps the gap visible in
    // `missing` rather than hiding it behind a made-up key.
    investigation_id: investigationId,
    // RCA records no structured problem statement either; its node details are
    // authored display copy.
    problem_statement: null,
  }
}
