import { useMutation } from '@tanstack/react-query'
import { ApiError, apiPost } from '../lib/api'
import type { DecisionBriefRequest, DecisionBriefResponse } from '../types/decisionBrief'

/** POST /api/decision/brief — the AI explanation of the decision record.
 *
 *  A MUTATION, AND ONLY ON A CLICK. Never a query, and never fired on mount:
 *  Decision Center must render completely without this call, and an automatic
 *  request would make the page's readiness depend on an external service. The
 *  user asks for the brief; until then nothing is sent and nothing is billed.
 *
 *  FAILURE IS ORDINARY HERE. No key configured, the service unreachable, a slow
 *  response — the page keeps working through all of them, because nothing on it
 *  reads this result for a value. `isError` drives one card, and that card is
 *  the only thing that changes.
 */
export function useDecisionBrief() {
  return useMutation<DecisionBriefResponse, Error, DecisionBriefRequest>({
    mutationFn: (body) => apiPost<DecisionBriefResponse>('/decision/brief', body),
    // An explanation that failed to generate will not generate on a second
    // identical attempt a moment later, and a retry loop against a paid API is
    // the wrong default. Retrying is the user's call, on the card's own button.
    retry: false,
  })
}

/** Why the brief is unavailable, in the user's terms rather than the wire's.
 *
 *  The two failures need different words: a missing key is a five-second fix by
 *  whoever runs the server, and an unreachable service is nobody's fix and will
 *  probably work later. Collapsing them into "unavailable" would hide the first
 *  one behind the second. */
export function briefFailure(error: Error): { title: string; detail: string } {
  const status = error instanceof ApiError ? error.status : 0
  if (status === 503) {
    return {
      title: 'AI explanation not configured',
      detail:
        'This server has no LLM API key configured, so the explanation layer is switched ' +
        'off. Everything else on this page is unaffected — the decision record, its ' +
        'figures and its risk assessment are computed here and do not use it.',
    }
  }
  if (status === 502) {
    return {
      title: 'AI explanation unavailable',
      detail: `${error.message} The decision record above is unchanged.`,
    }
  }
  return {
    title: 'AI explanation unavailable',
    detail: `${error.message} The decision record above is unchanged.`,
  }
}
