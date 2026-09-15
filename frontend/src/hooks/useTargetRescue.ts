import { useMutation } from '@tanstack/react-query'
import { apiPost } from '../lib/api'
import type {
  TargetRescueRequest,
  TargetRescueResponse,
  TargetRescueScopeRequest,
  TargetRescueScopeResponse,
} from '../types/targetRescue'
import type { SimulateResponse } from '../types/simulation'

/** POST /api/simulation/target-rescue/scope.
 *
 *  MEASURES the selected month so the controls can be bounded. Three of the
 *  things it returns the client has no way to work out for itself:
 *
 *    * how many days the month's business weeks cover, and which boundaries the
 *      checkpoint may land on — the analytical month is 28 or 35 days depending
 *      on how its weeks fall, and only dim_date knows which;
 *    * the prior-year actual, so the target input starts from a measured figure
 *      rather than one the browser made up;
 *    * the depth the elapsed weeks actually ran at.
 *
 *  A mutation rather than a query because it is driven by an explicit control
 *  change, and its `isPending` / `error` are the states the panel renders.
 */
export function useTargetRescueScope() {
  return useMutation<TargetRescueScopeResponse, Error, TargetRescueScopeRequest>({
    mutationFn: (body) => apiPost<TargetRescueScopeResponse>('/simulation/target-rescue/scope', body),
  })
}

/** POST /api/simulation/target-rescue — evaluate the target and rank the ladder.
 *
 *  THE DECISION RUNS ON THE SERVER, deliberately. The status thresholds, the
 *  approved treatment ladder, the uplift bands, the discount ceiling and the
 *  ranking policy all live beside the economics that define them; a copy in the
 *  browser would be a second set of business rules free to drift from the first.
 *
 *  The frontend's whole job here is to collect the controls and render what
 *  comes back — including the states that carry no numbers at all.
 */
export function useTargetRescue() {
  return useMutation<TargetRescueResponse, Error, TargetRescueRequest>({
    mutationFn: (body) => apiPost<TargetRescueResponse>('/simulation/target-rescue', body),
  })
}

/** POST /api/simulation/simulate — the EXISTING scenario execution flow, run over
 *  Target Rescue's own scope at the recommended depth.
 *
 *  WHY THIS AND NOT A HAND-OFF INTO THE INVESTIGATION SIMULATION. That mode
 *  scopes itself from the Insights Hub's FilterState, and Target Rescue is
 *  state-isolated from it by design — pushing a scenario across would either
 *  simulate the recommended treatment over a scope the user never chose, or
 *  require moving the Insights Hub's filters from here. Neither is acceptable,
 *  so no new mutation path is invented: the recommended treatment is executed by
 *  the same validated endpoint, over the scope it was recommended for, and the
 *  result is shown in place for review.
 *
 *  IT MUTATES NOTHING. No promotion is created, no plan is changed, no calendar
 *  is touched. It is a read that returns a counterfactual.
 */
export function useReviewRecommendedScenario() {
  return useMutation<
    SimulateResponse,
    Error,
    { filters: Record<string, unknown>; scenario_id: string; discount_pct: number; currency: string }
  >({
    mutationFn: (body) => apiPost<SimulateResponse>('/simulation/simulate', body),
  })
}
