import { create } from 'zustand'
import { persist } from 'zustand/middleware'

/** The scenarios the Simulation Studio has sent to the Decision Center.
 *
 *  A scenario is a snapshot of one studio result: its scope, its three lever
 *  values and the KPIs the engine returned for it — every value the DISPLAY
 *  STRING the studio showed, so the Decision Center renders and never
 *  recalculates. Up to three at a time, each named by the slot it holds
 *  ("Scenario 1", "Scenario 2", "Scenario 3"); a removed slot is reused by
 *  the next scenario added.
 *
 *  ONE SCENARIO, ONCE. `signature` is the scope, currency and the three lever
 *  values; a scenario whose signature is already held cannot be added again,
 *  and the studio disables its button with that reason. Change any lever or
 *  the scope and it is a different scenario.
 *
 *  Persisted (localStorage) so the columns survive navigating between the two
 *  pages and a reload. Nothing is sent to the server. */

export const MAX_SCENARIOS = 3

export interface ScenarioKpi {
  key: string
  label: string
  /** The figure as the studio displayed it. */
  value: string
  /** A second line under the figure — a range, a comparison — when there is one. */
  sub?: string
  /** For the ROI row: the engine's status, so the column can show it. */
  tone?: 'success' | 'warning' | 'danger' | 'neutral'
  /** The figure's number, when it has one — used only to MARK the best value
   *  across columns; never displayed or recomputed. */
  raw?: number | null
}

export interface DecisionScenario {
  id: string
  /** 1-based slot: the scenario's number on the page. */
  slot: number
  signature: string
  addedAt: number
  scope: {
    /** "F26 (Annual) · Modern Trade · Baby Care" */
    label: string
    filters: Record<string, unknown>
    currency: string
  }
  levers: { discount_pct: number; trade_spend: number; days: number }
  kpis: ScenarioKpi[]
}

/** A saved board, as the server returns it. */
export interface BoardDecision {
  decision_id: string
  created_at: string
  chosen_slot: number | null
  chosen_label: string | null
  scenario_count: number
  rationale: string
  scenarios: DecisionScenario[]
  dataset_version: string
  stale?: boolean
}

interface DecisionScenarioStore {
  scenarios: DecisionScenario[]
  /** The scenario chosen as the decision, by id. */
  chosenId: string | null
  rationale: string
  /** The saved decision this board was loaded from, when it was. */
  loadedFrom: string | null
  /** Adds and returns the scenario, or null when the board is full or the
   *  signature is already held. */
  add: (scenario: Omit<DecisionScenario, 'id' | 'slot' | 'addedAt'>) => DecisionScenario | null
  remove: (id: string) => void
  clear: () => void
  choose: (id: string | null) => void
  setRationale: (text: string) => void
  /** Replace the board with a saved decision's, for reviewing it. */
  load: (saved: BoardDecision) => void
}

export function scenarioSignature(filters: Record<string, unknown>, currency: string, levers: DecisionScenario['levers']): string {
  return JSON.stringify([filters, currency, levers.discount_pct, levers.trade_spend, levers.days])
}

export const useDecisionScenarios = create<DecisionScenarioStore>()(
  persist(
    (set, get) => ({
      scenarios: [],
      chosenId: null,
      rationale: '',
      loadedFrom: null,
      add: (scenario) => {
        const held = get().scenarios
        if (held.length >= MAX_SCENARIOS) return null
        if (held.some((s) => s.signature === scenario.signature)) return null
        const taken = new Set(held.map((s) => s.slot))
        let slot = 1
        while (taken.has(slot)) slot += 1
        const added: DecisionScenario = {
          ...scenario,
          id: `scn-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`,
          slot,
          addedAt: Date.now(),
        }
        set({ scenarios: [...held, added].sort((a, b) => a.slot - b.slot), loadedFrom: null })
        return added
      },
      remove: (id) =>
        set((s) => ({
          scenarios: s.scenarios.filter((x) => x.id !== id),
          chosenId: s.chosenId === id ? null : s.chosenId,
          loadedFrom: null,
        })),
      clear: () => set({ scenarios: [], chosenId: null, rationale: '', loadedFrom: null }),
      choose: (id) => set({ chosenId: id }),
      setRationale: (text) => set({ rationale: text }),
      load: (saved) => {
        const chosen = saved.scenarios.find((x) => x.slot === saved.chosen_slot)
        set({
          scenarios: [...saved.scenarios].sort((a, b) => a.slot - b.slot),
          chosenId: chosen?.id ?? null,
          rationale: saved.rationale ?? '',
          loadedFrom: saved.decision_id,
        })
      },
    }),
    { name: 'tiq.decisionScenarios', version: 2 },
  ),
)
