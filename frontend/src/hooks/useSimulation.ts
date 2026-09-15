import { useMutation } from '@tanstack/react-query'
import { apiPost } from '../lib/api'
import type { CommandFilters } from '../store/commandFilters'
import type {
  SimulateRequest,
  SimulateResponse,
  SimulationRunRequest,
  SimulationRunResponse,
} from '../types/simulation'
import type { ComparisonRequest, ScenarioComparison } from '../types/comparison'
import type { Recommendation } from '../types/recommendation'
import type { WeeklyRequest, WeeklyResponse } from '../types/weekly'
import type { RiskAssessment, RiskRequest } from '../types/risk'

/** POST /api/simulation/run.
 *
 *  A MUTATION, not a query: a run is an action the user takes, its result is
 *  what the page shows, and `isPending` / `error` are the real request state.
 *  The page's loading and error states are these two fields — there is no
 *  timer anywhere, and a failed request surfaces as an error with a retry
 *  rather than as a spinner that never resolves.
 *
 *  The two `/api/simulation-default` and `/api/simulation/{type}` readers this
 *  hook used to merge are gone from the flow. They served the authored demo
 *  payload — the impact strings, the weekly arrays, the risk percentages and
 *  the confidence scores that the client-side engine then rescaled.
 */
export function useSimulationRun() {
  return useMutation<SimulationRunResponse, Error, SimulationRunRequest>({
    mutationFn: (body) => apiPost<SimulationRunResponse>('/simulation/run', body),
  })
}

/** POST /api/simulation/simulate — execute ONE hypothetical scenario.
 *
 *  Also a mutation, for the same reason: running a scenario is an action, and
 *  the request state is what the page shows. There is no timer and no
 *  artificial delay anywhere in the path.
 *
 *  Per-scenario state (running, result, error) lives in
 *  `store/simulationScenarios.ts`, not here — a second scenario-state system
 *  in the hook is exactly how two views of the same scenario start to
 *  disagree. This hook only performs the request; the page hands the outcome
 *  to the store.
 *
 *  CALL IT WITH `mutateAsync`, NEVER WITH `mutate`'s PER-CALL CALLBACKS.
 *
 *  Several scenarios can be in flight at once — a user runs one, then selects
 *  another and runs that before the first returns. This is ONE observer shared
 *  by all of them, and `mutate(vars, { onSuccess })` stores those callbacks on
 *  the observer, not on the request: a second `mutate` overwrites them, and the
 *  first scenario's `onSuccess` never fires. Its request still succeeds on the
 *  server; nothing on the client ever hears about it, so the card sits on
 *  "Running against the KPI engine…" forever.
 *
 *  `mutateAsync` returns the promise belonging to THAT execution, so each run
 *  carries its own resolution and cannot be displaced by a later one. The page
 *  attaches its handling to the promise. See `onRun` in pages/Simulation.tsx.
 */
export function useSimulateScenario() {
  return useMutation<SimulateResponse, Error, SimulateRequest>({
    mutationFn: (body) => apiPost<SimulateResponse>('/simulation/simulate', body),
  })
}

/** POST /api/simulation/compare — line up results that already exist.
 *
 *  The frontend holds every number this needs and could subtract them itself.
 *  It deliberately does not: WHICH DELTA IS VALID depends on what each metric
 *  IS — a difference in multiples for ROI, points for Margin,
 *  absolute-plus-percent-change for money and units, index points for PEI —
 *  and that rule already lives in app/tpo/comparison.py. Computing deltas
 *  here would be a second copy of it, free to drift, and the first thing to
 *  drift would be somebody dividing two ROIs and printing "+100%".
 *
 *  The response carries no recommendation, and this hook adds none.
 */
export function useScenarioComparison() {
  return useMutation<ScenarioComparison, Error, ComparisonRequest>({
    mutationFn: (body) => apiPost<ScenarioComparison>('/simulation/compare', body),
  })
}

/** POST /api/simulation/recommend — apply the decision policy.
 *
 *  Takes the same body as the comparison, because a recommendation IS the
 *  comparison plus a policy. Building both from one input is what stops the
 *  recommendation panel and the comparison table from disagreeing on screen.
 *
 *  No preference is encoded here. The policy lives in exactly one place,
 *  app/tpo/recommendation.RECOMMENDATION_POLICY, and travels back inside the
 *  response so the UI can show which rule decided.
 */
export function useScenarioRecommendation() {
  return useMutation<Recommendation, Error, ComparisonRequest>({
    mutationFn: (body) => apiPost<Recommendation>('/simulation/recommend', body),
  })
}

/** POST /api/simulation/weekly — decompose one scenario across its weeks.
 *
 *  The request carries only WHICH scenario and WHICH treatment. It cannot
 *  supply an uplift, a promotion cost or a trade spend: the economics live in
 *  app/tpo/response.py, so the weekly view cannot drift from the scenario it
 *  decomposes. The frontend renders the result and calculates nothing.
 */
export function useWeeklyImpact() {
  return useMutation<WeeklyResponse, Error, WeeklyRequest>({
    mutationFn: (body) => apiPost<WeeklyResponse>('/simulation/weekly', body),
  })
}

/** POST /api/simulation/risk — assess one simulated scenario.
 *
 *  Sends results the client already holds: the /simulate payload and, when it
 *  exists, the /recommend payload. Nothing is recomputed, and the assessment
 *  cannot change which scenario B4.3 recommended — it carries that answer
 *  through. The frontend calculates no risk of its own.
 */
export function useRiskAssessment() {
  return useMutation<RiskAssessment, Error, RiskRequest>({
    mutationFn: (body) => apiPost<RiskAssessment>('/simulation/risk', body),
  })
}

/** Build the comparison request from scenario state.
 *
 *  A scenario contributes whichever result it actually has: the measured
 *  baseline sends its KPI block and the scope it was measured over, a
 *  simulated scenario sends its whole /simulate payload so the backend can
 *  check the scope and economic basis it was produced under. A scenario with
 *  neither sends only its identity — the backend excludes it WITH a reason,
 *  which is the honest rendering of "nobody has run this".
 */
export function toComparisonRequest(
  filters: Record<string, unknown>,
  measuredScope: Record<string, unknown>,
  scenarios: {
    id: string
    name: string
    kind: string
    result: Record<string, unknown> | null
    simulation: unknown | null
  }[],
  currency?: string,
): ComparisonRequest {
  return {
    filters,
    currency,
    entries: scenarios.map((s) => {
      if (s.kind === 'measured' && s.result) {
        return { scenario_id: s.id, name: s.name, measured: s.result as never, scope: measuredScope }
      }
      if (s.simulation) {
        return { scenario_id: s.id, name: s.name, simulated: s.simulation as never }
      }
      return { scenario_id: s.id, name: s.name }
    }),
  }
}

/** The Insights Hub's filter state, as the simulation API wants it.
 *
 *  Empty lists are dropped rather than sent as `[]`: an absent dimension means
 *  unconstrained, which is a different request from one constrained to
 *  nothing. `year: null` is likewise omitted — the backend reads an absent
 *  year as All Years, exactly as the Insights Hub's own query strings do.
 */
export function toSimulationFilters(filters: CommandFilters): SimulationRunRequest['filters'] {
  const out: SimulationRunRequest['filters'] = {}
  for (const [key, value] of Object.entries(filters)) {
    if (value === null || value === undefined) continue
    if (Array.isArray(value)) {
      if (value.length) out[key as 'channel'] = value
    } else {
      out[key as 'year'] = value as number
    }
  }
  return out
}
