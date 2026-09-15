import { create } from 'zustand'
import { EMPTY_FILTERS, LIST_FILTER_KEYS, type CommandFilters } from './commandFilters'
import type { Recommendation } from '../types/promotionIntelligence'

/** The Promotion Intelligence → Simulation Studio hand-off.
 *
 *  WHAT IT REPLACES. "Go Deeper" on a recommendation used to toast
 *  "Simulation Studio doesn't accept parameters yet" and then navigate with
 *  nothing at all: the studio opened on whatever scope the Insights Hub
 *  happened to be holding, in whichever mode was last selected, with no trace
 *  of the recommendation that sent the user there. The advice and the tool for
 *  testing it were two unconnected pages.
 *
 *  IT CARRIES WHAT EXISTS AND NOTHING ELSE. Every field below is copied from
 *  the investigation context or the recommendation the Advisor actually
 *  produced. Nothing is composed, defaulted or inferred — a recommendation
 *  that names no depth carries `proposedDiscountPct: null` and the studio
 *  leaves its levers where they were, rather than inventing a number that
 *  would then look like advice.
 *
 *  SESSION STATE, like the Decision Center draft it mirrors (store/
 *  decisionDraft.ts). Nothing is persisted and nothing is sent to the server.
 */
export interface IntelligenceHandoff {
  /** The investigation being deepened — its scope is what the studio simulates. */
  investigationRunId: string
  /** The analysis run the recommendation came from, when one produced it. */
  intelligenceRunId: string | null
  question: string
  /** The investigation's own scope object, forwarded verbatim. */
  scope: Record<string, unknown>
  /** That scope in words, as Promotion Intelligence already renders it. */
  scopeLabel: string
  rootCause: string | null
  /** Null when the user proceeded from the page without picking one. */
  recommendation: Recommendation | null
  /** The depth to pre-select, ONLY when the recommendation names exactly one
   *  and its lever is the one the studio models. See `proposedDiscountPct`. */
  proposedDiscountPct: number | null
  at: number
}

interface IntelligenceHandoffStore {
  handoff: IntelligenceHandoff | null
  carry: (handoff: IntelligenceHandoff) => void
  clear: () => void
}

export const useIntelligenceHandoffStore = create<IntelligenceHandoffStore>()((set) => ({
  handoff: null,
  carry: (handoff) => set({ handoff }),
  clear: () => set({ handoff: null }),
}))

/** The investigation's scope as the one FilterState every module speaks.
 *
 *  A STRAIGHT TRANSLATION, NOT A GUESS. Investigation scopes are written in
 *  the same dimension vocabulary `CommandFilters` defines and carry the same
 *  real codes — which is why Promotion Intelligence can already send them to
 *  /facts unchanged. Keys the scope does not carry stay EMPTY rather than
 *  inheriting the Insights Hub's current selection: merging the two would
 *  simulate a population neither the investigation nor the user chose.
 */
export function filtersFromScope(scope: Record<string, unknown>): CommandFilters {
  const list = (v: unknown) => (Array.isArray(v) ? v : v == null || v === '' ? [] : [v]).map(String)
  const num = (v: unknown) => {
    const n = Number(v)
    return Number.isFinite(n) ? n : null
  }
  const filters: CommandFilters = { ...EMPTY_FILTERS }
  filters.year = scope.year == null ? null : num(scope.year)
  filters.month = scope.month == null ? null : num(scope.month)
  for (const key of LIST_FILTER_KEYS) filters[key] = list(scope[key])
  return filters
}

/** The discount depth a recommendation proposes, or null.
 *
 *  STRICT ON PURPOSE. `proposed_value` is prose written by the Advisor, and
 *  the studio's discount control accepts only approved treatment depths. So a
 *  depth is read out ONLY when the recommendation's lever is discount depth
 *  and the text states exactly one percentage: "10%" pre-selects 10, while
 *  "10–12%", "shift spend to Modern Trade" or "reduce depth" pre-select
 *  nothing. Half-understood prose becomes a number the user never chose, and
 *  a number on that slider reads as a recommendation.
 */
export function proposedDiscountPct(simulation: Recommendation['simulation']): number | null {
  if (simulation.lever !== 'discount_depth') return null
  // EVERY NUMBER COUNTS, not just the ones wearing a % sign. Matching only
  // "<digits>%" read "10-12%" as the single value 12 — the lower bound has no
  // sign of its own — and pre-selected a depth from a RANGE, which is the one
  // thing this rule exists to refuse. A second number anywhere in the sentence
  // means the value is not unambiguous, so nothing is read out of it.
  const numbers = simulation.proposed_value.match(/\d+(?:\.\d+)?/g)
  if (!numbers || numbers.length !== 1) return null
  // And that one number must be the percentage itself, not a quantity that
  // happens to sit beside the word discount.
  const percent = simulation.proposed_value.match(/(\d+(?:\.\d+)?)\s*%/)
  if (!percent || percent[1] !== numbers[0]) return null
  const value = Number(percent[1])
  return Number.isFinite(value) ? value : null
}
