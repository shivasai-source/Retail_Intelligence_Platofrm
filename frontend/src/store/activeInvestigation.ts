import { create } from 'zustand'
import { persist } from 'zustand/middleware'
import type { InvestigationType } from '../types/investigation'
import type { CommandFilters } from './commandFilters'

// Ported from data.js's window.getActiveInvType/setActiveInvType/addActiveInv, which
// read/wrote localStorage directly. Same persisted shape and default question, now as
// a Zustand store — pages read it with useActiveInvestigationStore() instead of calling
// global functions.
//
// `list` is the CLIENT-side recent-investigation trail. The SHARED, cross-device
// history now lives on the backend — see useRecentInvestigations() in
// hooks/useInvestigations.ts, which is what the Investigations page renders. This
// local copy is kept because Simulation.tsx still passes it as descriptive
// investigation context (it carries no KPI value).
export interface ActiveInvEntry {
  type: InvestigationType
  question: string
  at: number
}

/** Where an investigation was started from. */
export type InvestigationOrigin = 'risk_alert' | 'underperforming' | 'query'

/** The context the Insights Hub HANDS OVER when the user drills into an
 *  investigation — B3.2.
 *
 *  Until B3.2 this was thrown away: the alert and promotion click handlers had
 *  the clicked entity in hand and called a bare `navigate('/investigations')`,
 *  so every downstream page had to guess what the user was looking at.
 *
 *  THE ONE RULE HERE. `filters` is the Insights Hub's own validated
 *  FilterState, narrowed only by identifiers the source ACTUALLY PROVIDED.
 *  Display labels stay in `labels` and are never turned into codes.
 *  Converting a name back into a code by guessing would be a second filter
 *  model wearing a disguise, and it would silently select different rows from
 *  the ones the user clicked.
 *
 *  WHAT EACH SOURCE PROVIDES. A risk alert carries a real `promotion_id`,
 *  while its channel and product arrive as display names and so narrow
 *  nothing. An underperforming row carries the promotion, product and channel
 *  codes of the event it measured, so all three narrow. Neither can narrow to
 *  a week: FilterState has no week.
 */
export interface InvestigationScope {
  /** The validated Insights Hub FilterState at the moment of hand-off. */
  filters: CommandFilters
  origin: InvestigationOrigin
  /** What the user clicked, for display. */
  label: string
  /** Real identifiers the source genuinely provided. Absent means absent. */
  identifiers: { promotion_id?: string; product_id?: string; channel_id?: string }
  /** Display-only attributes. NOT converted into filters — see above. */
  labels: { product?: string; channel?: string; week?: string; period?: string }
  at: number
}

/** THE INVESTIGATION CURRENTLY ON THE WORKSPACE, and everything needed to put
 *  it back on screen.
 *
 *  WHY IT LIVES HERE AND NOT IN THE PAGE. All of this used to be `useState`
 *  inside Investigations.tsx, so React unmounting the page — which is what
 *  navigating to Promotion Intelligence does — destroyed it. The user came
 *  back to a blank workspace and the "Ask something" prompt, with a finished
 *  investigation still sitting on the server that nothing pointed at any more.
 *  Re-running it was the only way back, which is paying twice for an answer
 *  already given.
 *
 *  IT IS A POINTER, NOT A COPY. The run itself stays where it already was: on
 *  the backend (`investigation-runs.json`, 50 runs deep) and in the React
 *  Query cache under ['investigation-run', id]. This carries the id and the
 *  few pieces of view state that are not derivable from the run, so returning
 *  to the page is a cache read or at worst one GET — never a re-run.
 *
 *  PERSISTED BECAUSE THIS STORE ALREADY IS. No new persistence layer was
 *  introduced for it; it rides the same localStorage entry as the question
 *  and the recent list, which is why a reload restores the workspace too. */
interface InvestigationRunState {
  /** The completed or in-flight run this workspace is showing. */
  runId: string | null
  /** The uploaded dataset it was run against, or null for the star schema. */
  datasetId: string | null
  /** Whether anything has been asked at all — the workspace renders its empty
   *  prompt until this is true, and a run id is not enough on its own because
   *  a launch that failed has no id and must still show its failure. */
  hasAsked: boolean
  /** The Insights Hub hand-off chip, when the question came from one. */
  handoffLabel: string | null
  /** The `AskWhyIntent` id already acted on.
   *
   *  A ref used to hold this, and a ref dies with the component. Browser-Back
   *  into the workspace replays the same router state, so the hand-off looked
   *  new and RE-RAN the investigation the user had just left — the exact
   *  "don't run it again" this state exists to prevent. */
  intentKey: string | null
}

interface ActiveInvestigationState extends InvestigationRunState {
  activeType: InvestigationType
  activeQuestion: string
  list: ActiveInvEntry[]
  /** Null when the user navigated straight to a page rather than drilling in
   *  from the Insights Hub. Both entry paths stay valid. */
  scope: InvestigationScope | null
  setActive: (type: InvestigationType, question: string) => void
  addActive: (type: InvestigationType, question: string) => void
  startFromCommandCenter: (scope: Omit<InvestigationScope, 'at'>) => void
  clearScope: () => void
  /** A launch has begun: the workspace leaves its empty state and the previous
   *  run's id is dropped, since it is no longer what is on screen. */
  beginRun: (handoffLabel?: string | null) => void
  /** The run the backend minted for that launch. */
  setRunId: (runId: string | null) => void
  setDatasetId: (datasetId: string | null) => void
  setHandoffLabel: (label: string | null) => void
  markIntent: (key: string) => void
  /** Back to the empty prompt — the user explicitly discarded the workspace. */
  clearRun: () => void
}

// Empty by design. A pre-filled question makes the Investigations page render
// an answer nobody asked for; the page now starts blank until the user asks
// something or arrives from an "Ask why" handoff.
const DEFAULT_QUESTION = ''

// The old default question is still sitting in localStorage for anyone who
// used the app before, and persisted state wins over the initial value — so
// clearing the constant alone would fix nothing for existing users. Version 2
// drops it on load.
const OLD_DEFAULT = 'Why did South Modern Trade Push underperform despite increased trade spend?'

export const useActiveInvestigationStore = create<ActiveInvestigationState>()(
  persist(
    (set, get) => ({
      activeType: 'diagnostic',
      activeQuestion: DEFAULT_QUESTION,
      list: [],
      scope: null,
      runId: null,
      datasetId: null,
      hasAsked: false,
      handoffLabel: null,
      intentKey: null,
      setActive: (type, question) => set({ activeType: type, activeQuestion: question }),
      addActive: (type, question) => {
        const list = get().list.filter((e) => !(e.type === type && e.question === question))
        set({ list: [{ type, question, at: Date.now() }, ...list].slice(0, 8) })
      },
      startFromCommandCenter: (scope) => set({ scope: { ...scope, at: Date.now() } }),
      clearScope: () => set({ scope: null }),
      beginRun: (handoffLabel) =>
        set((s) => ({
          runId: null,
          hasAsked: true,
          handoffLabel: handoffLabel === undefined ? s.handoffLabel : handoffLabel,
        })),
      setRunId: (runId) => set({ runId }),
      setDatasetId: (datasetId) => set({ datasetId }),
      setHandoffLabel: (handoffLabel) => set({ handoffLabel }),
      markIntent: (intentKey) => set({ intentKey }),
      clearRun: () => set({ runId: null, hasAsked: false, handoffLabel: null }),
    }),
    {
      name: 'tiq.activeInvestigation',
      version: 2,
      migrate: (persisted) => {
        const state = (persisted ?? {}) as Partial<ActiveInvestigationState>
        if (state.activeQuestion === OLD_DEFAULT) {
          return { ...state, activeQuestion: '' } as ActiveInvestigationState
        }
        return state as ActiveInvestigationState
      },
    },
  ),
)
