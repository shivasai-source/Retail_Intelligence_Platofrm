import { useEffect, useRef, useState } from 'react'
import { useLocation, useNavigate } from 'react-router-dom'
import { AppShell } from '../components/layout/AppShell'
import {
  Button,
  Card,
  CardHeader,
  Spinner,
  useToast,
} from '../components/ui'
import { ExportReportButton } from '../components/reports/ExportReportButton'
import { Icon } from '../icons'
import {
  useInvestigationTypes,
} from '../hooks/useInvestigations'
import { useStartInvestigationRun, useInvestigationRun } from '../hooks/useInvestigationRun'
import { ApiError } from '../lib/api'
import { ASK_WHY_STATE_KEY, type AskWhyIntent } from '../lib/askWhy'
import { useActiveInvestigationStore } from '../store/activeInvestigation'
import { InvestigationGraph } from '../components/investigations/InvestigationGraph'
import { bindCannibalizationNode } from '../components/investigations/cannibalizationNode'
import { NodeDetailPopover } from '../components/investigations/NodeDetailPopover'
import { BizQuestionCard } from '../components/investigations/BizQuestionCard'
import { AgentFindings } from '../components/investigations/AgentFindings'
import { AccelList } from '../components/investigations/AccelList'
import { ProgressStrip } from '../components/investigations/ProgressStrip'
import { QueryBar } from '../components/investigations/QueryBar'
import {
  CEILING,
  PhaseRail,
  ProgressTrack,
  eased,
  fmtElapsed,
  useRunClock,
} from '../components/agents/RunProgress'
import type { Accelerator, OrchNode } from '../types/orchestration'
import type { InvestigationType } from '../types/investigation'


// Ported from js/pages/investigations.js (PageInvestigations.render). Same data shape
// (orchestration.nodes/accelerators/progress/nodeDetails), same interactions (query
// bar -> staged build, node click -> side popover, header dropdowns), state-driven via
// hooks/useEffect timers instead of imperative DOM rebuilds + setInterval choreography.
//
// Question -> type classification used to happen right here, client-side, and fed a
// localStorage-only "recent investigations" list. Both now live on the backend (POST
// /investigations/query — see useSubmitInvestigationQuery) so the classification is a
// single source of truth and the history is shared across browsers/devices. This copy
// stays only as an offline fallback if that request fails outright.
function inferTypeOffline(q: string): InvestigationType {
  const s = (q || '').toLowerCase()
  if (/optimi[sz]e|maximi[sz]e|best plan|allocat|improve roi|lever/.test(s)) return 'optimization'
  if (/launch|new sku|new product|prioriti[sz]e/.test(s)) return 'launch'
  if (/portfolio|channel mix|strategic|fy26|long.?term|growth budget|rebalance/.test(s)) return 'strategic'
  return 'diagnostic'
}

/** The landing state: a prompt, not a pre-baked answer. Example questions come
 *  from the archetype metadata so they stay in step with what the agents can
 *  actually investigate. */
function AskSomething({
  types,
  onPick,
}: {
  types: { key: string; title: string; desc?: string; questions?: string[] }[] | undefined
  onPick: (q: string) => void
}) {
  return (
    <Card className="fade-in mt-4">
      <div className="grid place-items-center gap-2 p-[24px_24px_10px] text-center">
        <div className="grid h-12 w-12 place-items-center rounded-xl bg-brand-violet-50 text-brand-violet">
          <Icon name="search" className="h-6 w-6" />
        </div>
        <h2 className="text-lg font-extrabold">Ask a question to start an investigation</h2>
        <p className="max-w-[520px] text-base leading-[1.6] text-ink-muted">
          Specialist agents will pick the analyses your question needs, run them against your data, and report a root
          cause with evidence. Ask in plain English, or start from one of these.
        </p>
      </div>
      <div className="grid grid-cols-2 gap-3 p-[14px_24px_26px] @max-[900px]:grid-cols-1">
        {(types ?? []).map((t) => (
          <div key={t.key} className="rounded-[var(--r-lg)] border border-border-subtle p-[12px_14px]">
            <div className="mb-1.5 text-xs font-bold uppercase tracking-[0.06em] text-ink-muted">{t.title}</div>
            <div className="flex flex-col gap-1.5">
              {(t.questions ?? []).slice(0, 2).map((q) => (
                <button
                  key={q}
                  onClick={() => onPick(q)}
                  className="text-left text-base leading-[1.5] text-brand-violet hover:underline"
                >
                  {q}
                </button>
              ))}
            </div>
          </div>
        ))}
      </div>
    </Card>
  )
}

/** Shown while the agents are working. Previously this window rendered the
 *  static sample graph, so clicking "investigate" flashed up a finished-looking
 *  result for a different question before the real one arrived. */
/** THE INVESTIGATION STOPPED, AND SAYS SO.
 *
 *  Two different failures land here and the user does not need to care which:
 *  the request never started, or the pipeline raised and the backend recorded
 *  the reason on the run. Either way the work is over, so the page shows a
 *  finished state with the reason and a way to try again — rather than a
 *  spinner over something that has already stopped moving.
 *
 *  The message is whatever the API said. `routers/investigations._execute_run`
 *  stores an exception's type and message, never a traceback, and the agent's
 *  own configuration error names the missing setting without quoting it. No
 *  key, secret or environment value reaches this component.
 */
function FailedState({
  question,
  message,
  onRetry,
}: {
  question: string
  message: string
  onRetry: () => void
}) {
  return (
    <Card className="fade-in mt-4">
      <div className="border-b border-border-subtle p-[16px_20px]">
        <div className="flex items-start gap-2.5">
          <span className="mt-px grid h-5 w-5 shrink-0 place-items-center rounded-full bg-status-danger-bg text-status-danger [&_svg]:h-3 [&_svg]:w-3">
            <Icon name="warning" />
          </span>
          <div className="min-w-0 flex-1">
            <div className="text-base font-bold text-ink-primary">Investigation stopped</div>
            <div className="mt-1 truncate text-base text-ink-muted">{question}</div>
          </div>
        </div>
      </div>
      <div className="p-[16px_20px]">
        <div className="rounded-[var(--r-md)] border border-border-subtle bg-surface-muted p-3 text-base leading-[1.5] text-ink-secondary">
          {message}
        </div>
        <Button variant="primary" onClick={onRetry} className="mt-3">
          <Icon name="refresh" /> Retry investigation
        </Button>
      </div>
    </Card>
  )
}

/** Where each phase hands over. The middle band is the widest because it is the
 *  only one carrying real milestones; the two ends are single model calls that
 *  can only ever be estimated. */
const AGENTS_OPEN_KEY = 'investigations.agents-open'

const PLAN_ENDS_AT = 0.22
const INVESTIGATE_ENDS_AT = 0.82

/** Rough durations, used ONLY to shape the curve between real events. Being
 *  wrong about these makes the bar move at the wrong speed; it cannot make it
 *  report a milestone that has not happened. */
const PLAN_ESTIMATE_MS = 9_000
const SPECIALISTS_ESTIMATE_MS = 30_000
const SYNTHESIS_ESTIMATE_MS = 12_000

const PHASES = [
  { key: 'plan', label: 'Plan' },
  { key: 'investigate', label: 'Investigate' },
  { key: 'synthesise', label: 'Synthesise' },
] as const

/** What the page shows while the agents work.
 *
 *  THE BAR USED TO SPEND MOST OF THE RUN AT 0% AND THEN FREEZE AT 100%. It was
 *  driven by `done / specialists.length` alone, so it sat empty through
 *  planning — before any specialist exists — and filled completely the moment
 *  the last one reported, while the synthesis call, the longest single step
 *  after planning, was still running. Both ends of the run showed a bar that
 *  said nothing.
 *
 *  So progress is modelled on the pipeline that actually runs: plan, then N
 *  specialists in parallel, then synthesis. Two of those three are single model
 *  calls with no sub-progress to report, and the middle one has genuine
 *  milestones streamed from the backend.
 *
 *  WHAT IS MEASURED AND WHAT IS ESTIMATED, because the difference matters:
 *
 *    - Specialist completions are REAL. `done / total` is a true fraction, and
 *      it always wins.
 *    - Everything between milestones is an estimate, and is CLAMPED so it can
 *      creep towards the next completion but never past it. The bar cannot
 *      claim a specialist has reported when none has.
 *    - Planning and synthesis are estimates outright, inside their own bands.
 *
 *  Nothing here ever reaches 100%: the component unmounts when the run
 *  finishes, so a full bar can only ever mean done.
 */
function RunningState({
  question,
  specialists,
  stage,
  startedAt,
}: {
  question: string
  specialists: { key: string; name: string; desc: string; status: string }[]
  stage?: string
  startedAt?: number
}) {
  const total = specialists.length
  const done = specialists.filter((s) => s.status === 'done').length
  const planning = stage === 'planning' || total === 0
  const synthesising = total > 0 && done === total
  const phase = planning ? 'plan' : synthesising ? 'synthesise' : 'investigate'


  const { now, stepElapsed } = useRunClock(`${phase}:${done}`)

  let fraction: number
  if (planning) {
    // MEASURED FROM THE RUN, NOT FROM MOUNT. Planning begins when the run is
    // created, so `startedAt` is exactly the right clock — and using it means
    // coming back to this page mid-run resumes the bar where it should be
    // rather than restarting it near zero. The later phases have no such
    // timestamp (the backend records no per-specialist start), so they measure
    // from the last event this component saw, which is the best available.
    //
    // Starts visibly non-zero: the request is already in flight, and an empty
    // trough is indistinguishable from a page that has not started.
    const planElapsed = startedAt ? now - startedAt : stepElapsed
    fraction = 0.04 + eased(planElapsed, PLAN_ESTIMATE_MS) * (PLAN_ENDS_AT - 0.04)
  } else if (!synthesising) {
    const reported = done / total
    const nextMilestone = (done + 1) / total
    const creep = eased(stepElapsed, SPECIALISTS_ESTIMATE_MS / total) * (nextMilestone - reported)
    const within = Math.min(reported + creep, nextMilestone)
    fraction = PLAN_ENDS_AT + within * (INVESTIGATE_ENDS_AT - PLAN_ENDS_AT)
  } else {
    fraction = INVESTIGATE_ENDS_AT + eased(stepElapsed, SYNTHESIS_ESTIMATE_MS) * (CEILING - INVESTIGATE_ENDS_AT)
  }
  const pct = Math.round(Math.min(fraction, CEILING) * 100)

  const heading = planning
    ? 'Planning the investigation…'
    : synthesising
      ? 'Weighing the findings against each other…'
      : `Investigating — ${done} of ${total} specialist${total === 1 ? '' : 's'} reported`

  return (
    <Card className="fade-in mt-4">
      <div className="border-b border-border-subtle p-[16px_20px]">
        <div className="flex items-center gap-2.5">
          <Spinner className="h-4 w-4 text-brand-violet" />
          <div className="min-w-0 flex-1">
            <div className="text-md font-bold">{heading}</div>
            <div className="mt-0.5 truncate text-sm text-ink-muted">{question}</div>
          </div>
          <span className="shrink-0 text-md font-extrabold tabular-nums text-brand-violet">{pct}%</span>
        </div>

        <div className="mt-3">
          <ProgressTrack pct={pct} label={heading} />
        </div>

        <div className="mt-2.5 flex items-center justify-between gap-3">
          <PhaseRail phases={PHASES} current={phase} />
          <span className="shrink-0 text-xs tabular-nums text-ink-muted">
            {startedAt ? `${fmtElapsed(now - startedAt)} elapsed` : ''}
          </span>
        </div>
      </div>

      {specialists.length > 0 ? (
        <div className="flex flex-col">
          {specialists.map((sp) => (
            <div key={sp.key} className="flex items-center gap-3 border-b border-border-subtle p-[12px_20px] last:border-b-0">
              <span
                className={`inline-block h-2 w-2 shrink-0 rounded-full ${
                  sp.status === 'done'
                    ? 'bg-status-success'
                    : sp.status === 'running'
                      ? 'animate-[pulseDot_1.2s_ease-in-out_infinite] bg-brand-violet'
                      : 'bg-border-strong'
                }`}
              />
              <div className="min-w-0 flex-1">
                <div className="text-base font-semibold">{sp.name}</div>
                <div className="text-sm text-ink-muted">{sp.desc}</div>
              </div>
              <span
                className={`shrink-0 text-sm font-semibold ${
                  sp.status === 'done' ? 'text-status-success' : sp.status === 'running' ? 'text-brand-violet' : 'text-ink-muted'
                }`}
              >
                {sp.status === 'done' ? 'Completed' : sp.status === 'running' ? 'Running' : 'Queued'}
              </span>
            </div>
          ))}
        </div>
      ) : (
        // NO SPECIALIST ROWS YET, so this stands in for them. Ghosted seats
        // rather than a sentence alone: the panel is what the next phase looks
        // like, and showing its shape means the card does not appear to change
        // into something else when the plan lands. Deliberately unlabelled —
        // which specialists get assigned is the planner's to decide, and
        // naming them here would be this page guessing at the answer.
        <div className="p-[16px_20px]">
          <div className="mb-3 text-base leading-[1.6] text-ink-muted">
            Choosing which specialists this question needs, and the scope they should analyse.
          </div>
          <div className="flex flex-col gap-2.5" aria-hidden>
            {[0, 1, 2].map((i) => (
              <div key={i} className="flex items-center gap-3" style={{ opacity: 1 - i * 0.28 }}>
                <span className="h-2 w-2 shrink-0 rounded-full bg-border-strong" />
                <span className="h-2.5 flex-1 rounded-full bg-surface-muted" style={{ maxWidth: `${64 - i * 12}%` }} />
              </div>
            ))}
          </div>
        </div>
      )}
    </Card>
  )
}

/** The question was outside what promotion data can answer. Saying so is far
 *  better than the previous behaviour, which attached real ROI figures to
 *  whatever the question named — "Who is shahrukh khan" returned a confident
 *  root cause about his promotions. */
function OutOfScope({ question, reason, onReset }: { question: string; reason: string; onReset: () => void }) {
  return (
    <Card className="fade-in mt-4">
      <div className="grid place-items-center gap-3 p-[36px_24px] text-center">
        <div className="grid h-12 w-12 place-items-center rounded-xl bg-status-warning-bg text-status-warning">
          <Icon name="info" className="h-6 w-6" />
        </div>
        <h2 className="text-lg font-extrabold">That's outside what this data can answer</h2>
        <p className="max-w-[540px] text-base leading-[1.6] text-ink-muted">{reason}</p>
        <p className="max-w-[540px] text-sm italic leading-[1.5] text-ink-disabled">You asked: "{question}"</p>
        <button
          onClick={onReset}
          className="mt-1 rounded-[var(--r-md)] bg-brand-violet px-4 py-2 text-base font-semibold text-white"
        >
          Ask something else
        </button>
      </div>
    </Card>
  )
}

type AccelState = 'queued' | 'progress' | 'done'

export function Investigations() {
  // THE WORKSPACE STATE LIVES IN THE STORE, NOT IN THIS COMPONENT.
  //
  // `runId`, `hasAsked`, the dataset and the hand-off chip were `useState`
  // here, and React destroys those when the page unmounts. Navigating to
  // Promotion Intelligence — which is what "View Insights Summary" does —
  // unmounts it, so coming back showed the empty "ask something" prompt over
  // a finished investigation that was still on the server. The run itself is
  // untouched: the store carries its ID, and React Query still holds (or
  // re-fetches) the run behind it. Nothing here re-runs anything.
  const {
    activeType,
    activeQuestion,
    setActive,
    runId,
    setRunId,
    hasAsked,
    beginRun,
    clearRun,
    setHandoffLabel,
    intentKey: launchedIntentKey,
    markIntent,
  } = useActiveInvestigationStore()
  const { data: types } = useInvestigationTypes()
  const { show } = useToast()

  // A real agent run. When one is active its orchestration replaces the
  // static per-archetype JSON below.
  const startRun = useStartInvestigationRun()
  const { data: run, error: runError } = useInvestigationRun(runId ?? undefined)
  // EVERY RUN IS OVER THE BUILT-IN TPO STAR SCHEMA — the same data the
  // Insights Hub reports on, so the two pages agree. The dataset picker that
  // let a run analyse an uploaded file instead came off the header on
  // 2026-09-21; the run endpoint still accepts a dataset id, this page just
  // never sends one.
  const sourceLabel = 'TPO star schema (built-in)'
  const liveOrch = run?.status === 'done' ? run.result?.orchestration : undefined

  // An "Ask why" handoff from the Insights Hub arrives as router state.
  const location = useLocation()
  const intent = (location.state as Record<string, unknown> | null)?.[ASK_WHY_STATE_KEY] as
    | AskWhyIntent
    | undefined

  // Nothing is rendered until the user actually asks something. Opening the
  // page from the sidebar used to show a hardcoded question and a sample graph
  // — an answer to a question nobody asked. `hasAsked` is now store-backed, so
  // that stays true of a FIRST visit without being true again every time the
  // user comes back from another module.

  // A RUN THE SERVER NO LONGER HAS IS NOT A RUNNING RUN. The store outlives
  // the backend's 50-run window, so a restored id can 404. Left alone the page
  // would sit on "Planning the investigation…" against a run that does not
  // exist, so the pointer is dropped and the workspace returns to its prompt.
  const vanished = runError instanceof ApiError && runError.status === 404
  useEffect(() => {
    if (!vanished) return
    clearRun()
    show('That investigation is no longer stored on the server — ask again to re-run it.', { duration: 4000 })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [vanished])

  // THE MODE IS THE PLANNER'S DECISION, NOT A REGEX'S. `inferTypeOffline`
  // guesses an archetype from the wording so the badge has something to say
  // while the run is in flight; once the planner has classified the question
  // (`result.investigation_type`), that classification replaces the guess —
  // "diagnostic" on a question the agents treated as an optimisation was the
  // page contradicting its own run.
  const plannedType = run?.status === 'done' ? run.result?.investigation_type : undefined
  useEffect(() => {
    if (plannedType && plannedType !== activeType) setActive(plannedType, activeQuestion)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [plannedType])

  const typeMeta = types?.find((t) => t.key === activeType) ?? types?.[0]

  // THE BOX AND THE CHIP MUST COME FROM THE SAME PLACE. The chip has always
  // been seeded from the hand-off (`handoffLabel` above) while this was seeded
  // from the persisted store and only reached the hand-off's question later,
  // through an effect. Any reason that effect did not run left the two
  // disagreeing on screen: the alert you clicked named in the chip, the
  // question you asked some time ago still sitting in the field.
  const [queryInput, setQueryInput] = useState(intent?.question ?? activeQuestion)

  // Keep the field in step with the last question actually asked — but only
  // when that question has genuinely CHANGED since this effect last acted.
  //
  // IT HAS TO BE IDEMPOTENT, NOT ONCE-ONLY. A 'skip the first run' flag looks
  // equivalent and is not: StrictMode mounts, tears down and mounts again, a
  // ref survives that, so the discarded pass spent the flag and the real pass
  // overwrote the hand-off's question with the store's. In dev the field went
  // blank on a fresh workspace and showed the PREVIOUS alert's question
  // otherwise, while the chip beside it named the alert just clicked — and
  // none of it reproduced in a production build, where effects run once.
  //
  // Comparing against the last value actually synced makes a repeated run a
  // no-op instead of a stomp, whatever invokes it and however often.
  const syncedActiveQuestion = useRef(activeQuestion)
  useEffect(() => {
    if (syncedActiveQuestion.current === activeQuestion) return
    syncedActiveQuestion.current = activeQuestion
    setQueryInput(activeQuestion)
  }, [activeQuestion])

  // THE AGENT DESCRIPTIONS PANEL beside the graph shows and hides from the
  // graph card's own "Agents Info" control; hidden, the graph has the whole
  // row. The choice is remembered per browser. Guarded reads: storage can
  // be absent or throw, and the answer is then "open".
  const [agentsOpen, setAgentsOpen] = useState<boolean>(() => {
    try {
      return window.localStorage.getItem(AGENTS_OPEN_KEY) !== '0'
    } catch {
      return true
    }
  })
  const toggleAgents = () => {
    const next = !agentsOpen
    setAgentsOpen(next)
    try {
      window.localStorage.setItem(AGENTS_OPEN_KEY, next ? '1' : '0')
    } catch {
      /* A remembered preference is a convenience, not a requirement. */
    }
  }
  const navigate = useNavigate()

  // A LAUNCH THAT NEVER STARTED IS A TERMINAL STATE, NOT A SLOW ONE.
  // `hasAsked` flips the page into its running view the moment a question is
  // asked, and only a run id can flip it out again. So a POST that failed —
  // backend down, session expired, agent unconfigured — left the page showing
  // "Planning the investigation…" with a spinner, for ever, over a request
  // that was already dead. The reason existed and was never rendered.
  const [launchError, setLaunchError] = useState<string | null>(null)
  // What the last attempt was, so Retry repeats THAT rather than whatever the
  // question box happens to hold by then.
  const lastAttempt = useRef<{ question: string; scope?: Record<string, unknown> } | null>(null)

  const [submitting, setSubmitting] = useState(false)
  const [revealedKeys, setRevealedKeys] = useState<Set<string> | undefined>(undefined)
  const timers = useRef<number[]>([])
  const clearTimers = () => {
    timers.current.forEach((t) => window.clearTimeout(t))
    timers.current = []
  }
  const after = (ms: number, fn: () => void) => {
    timers.current.push(window.setTimeout(fn, ms))
  }

  const [popover, setPopover] = useState<{ node: OrchNode; el: HTMLElement } | null>(null)

  // Reveal the agent-produced nodes once a run finishes.
  useEffect(() => {
    if (!liveOrch) return
    clearTimers()
    const keys = new Set<string>()
    setRevealedKeys(new Set(keys))
    liveOrch.nodes.forEach((n, i) => {
      after(90 + i * 130, () => {
        keys.add(n.key)
        setRevealedKeys(new Set(keys))
      })
    })
    return () => clearTimers()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [liveOrch])

  // WHAT THE WORKSPACE ACTUALLY HAS TO SHOW.
  //
  // `hasAsked` outlives the page now, and a launch that FAILED leaves it true
  // with no run behind it — the failure message itself is local, so returning
  // from another module would have shown the running spinner for ever against
  // a request that died before this page was last unmounted. A workspace needs
  // a run, a launch in flight, or a failure to explain; with none of the three
  // the honest thing on screen is the prompt.
  const showWorkspace = hasAsked && (Boolean(runId) || submitting || Boolean(launchError))


  // Always a real agent run. Omitting dataset_id investigates the built-in
  // star schema; passing one investigates that uploaded file.
  // `scope` is only ever present on an "Ask why" hand-off: it is the
  // Insights Hub's validated FilterState narrowed to the clicked event.
  // Sending it pins the run to that event, so Promotion Intelligence and
  // the Decision Center — which read the run's stored scope — describe the
  // same population the alert did. A typed question carries none, and the
  // planner deriving one is then the only honest option.
  //
  // AWAITED, NOT CALLED BACK. `startRun.mutate(vars, {onSuccess})` looks
  // equivalent and is not: React Query drops the callbacks passed to a single
  // `mutate` call if the mutation's observer is torn down before the request
  // settles. StrictMode mounts, tears down and mounts again, so an
  // EFFECT-initiated launch — which is every "Ask why" hand-off — fired the
  // POST and then lost `setRunId(started.id)`. The run completed server-side
  // and the page polled for nothing, sitting on "Planning the investigation…"
  // for as long as you cared to watch. A typed question survived it only
  // because an event handler runs after mounting has settled.
  //
  // `mutateAsync` resolves a plain promise, so the continuation below is an
  // ordinary closure that no subscription lifecycle can discard.
  const launch = async (q: string, scope?: Record<string, unknown>) => {
    beginRun()
    setSubmitting(true)
    setLaunchError(null)
    lastAttempt.current = { question: q, scope }
    try {
      const started = await startRun.mutateAsync({
        question: q,
        dataset_id: null,
        scope: scope ?? null,
      })
      setSubmitting(false)
      setRunId(started.id)
      setActive(inferTypeOffline(q), q)
      show(`Analysing ${sourceLabel} — specialist agents running…`, { duration: 3000 })
    } catch (e) {
      setSubmitting(false)
      const message = e instanceof ApiError ? e.message : "Couldn't start the investigation."
      // Recorded as well as toasted. A toast that has already faded is not a
      // state the page can be read from.
      setLaunchError(message)
      show(message, { duration: 4000 })
    }
  }

  const runQuery = () => {
    const q = queryInput.trim()
    if (!q) {
      show('Type a question for TIQ to investigate', { duration: 2000 })
      return
    }
    // A question you typed is YOUR question. The hand-off chip named the
    // alert this page arrived from, and it used to survive the next thing
    // you asked — so the page went on attributing a freshly typed question
    // to a risk alert that had nothing to do with it.
    setHandoffLabel(null)
    void launch(q)
  }

  // Arriving from "Ask why": fill the question in and start immediately. The
  // user already expressed intent by clicking the alert; making them press
  // enter again would be asking twice.
  //
  // GUARDED ON THE CLICK, NOT ON THE SENTENCE. This compared
  // `intent.question` until it was found that two hand-offs from the SAME
  // alert compose the same sentence — so re-clicking an alert after typing
  // over the box was read as "already ran this" and silently did nothing,
  // leaving the previous question on screen under the new alert's chip.
  // `intent.id` is minted per click (see lib/askWhy), so it distinguishes a
  // genuine second hand-off from a re-render, which the text never could.
  //
  // THE ID IS PREFERRED, NOT REQUIRED. `location.state` outlives a deploy —
  // a reload, or a step back through history, replays an intent composed by
  // whatever version of the app pushed it. Demanding an id meant such an
  // intent was skipped outright and its question never reached the field,
  // while the chip beside it still named the alert. Falling back to the
  // question restores the older, weaker de-duplication rather than none.
  //  THE GUARD MUST OUTLIVE THIS COMPONENT. It was a `useRef`, which dies with
  //  the page — and `location.state` does not. Leaving the workspace and
  //  stepping back into it replays the same intent to a freshly mounted page
  //  with an empty ref, so the hand-off read as new and re-ran the very
  //  investigation the user had just come back to look at. The key is stored
  //  beside the run it launched, so a replay is recognised for what it is.
  const intentKey = intent?.id ?? intent?.question
  useEffect(() => {
    if (!intent?.question || !intentKey || launchedIntentKey === intentKey) return
    markIntent(intentKey)
    setQueryInput(intent.question)
    setHandoffLabel(intent.sourceLabel)
    if (intent.autoRun) void launch(intent.question, intent.scope)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [intentKey])

  const crumbs = [{ label: 'TPO Intelligence' }, { label: 'Investigations' }]

  if (!typeMeta) {
    return (
      <AppShell activeKey="investigations" crumbs={crumbs}>
        <div className="grid min-h-[60vh] place-items-center text-base text-ink-muted">Loading Investigations…</div>
      </AppShell>
    )
  }

  // A finished agent run's orchestration takes precedence over the static
  // per-archetype sample; everything below renders from `view` either way,
  // since the backend assembles agent results into this exact shape.
  // Only ever the live run. Falling back to the static sample here made the
  // old hardcoded graph flash up while a real investigation was still running.
  const view = liveOrch
  // The Cannibalization Agent's node shows the figure the agent computed rather
  // than the one it wrote about — see cannibalizationNode.ts. Every other node
  // passes through untouched.
  //
  // `bindComparisonDelta` used to sit here too, recomputing Benchmarking's and
  // Effectiveness's deltas from their first two chart bars, because the model
  // wrote `delta` as free text and got the units wrong most of the time. The
  // backend now does that arithmetic itself, from two operands the specialist
  // names and that are both checked against its own table, so this is no longer
  // a patch over bad data — it is a second, different answer competing with a
  // better one. It was also unsafe by then: bars that cannot be traced back to
  // the specialist's data are dropped before rendering, which shifts the very
  // indices it read as (subject, benchmark).
  const graphNodes = view ? bindCannibalizationNode(view.nodes, run?.result?.findings ?? []) : []
  const running = run?.status === 'running'

  // While the pipeline runs, accelerator rows mirror real specialist state
  // instead of the old timer-driven cascade.
  const runAccelerators: Accelerator[] | null = run?.specialists?.length
    ? run.specialists.map((s) => ({
        key: s.key,
        name: s.name,
        desc: s.desc,
        // Base status is only a fallback — statusOverride below is what AccelList
        // actually renders, and it carries the real three-state progress.
        status: s.status === 'done' ? ('Completed' as const) : ('In Progress' as const),
        icon: s.icon,
        tone: 'success' as const,
        node: s.key,
      }))
    : null
  const runAccelState: Record<string, AccelState> | undefined = run?.specialists?.length
    ? Object.fromEntries(
        run.specialists.map((s) => [
          s.key,
          s.status === 'done' ? 'done' : s.status === 'running' ? 'progress' : 'queued',
        ]),
      )
    : undefined

  const agentProgress = run
    ? {
        pct:
          run.status === 'done'
            ? 100
            : Math.round(
                ((run.specialists?.filter((s) => s.status === 'done').length ?? 0) /
                  Math.max(1, run.specialists?.length ?? 1)) *
                  100,
              ),
        insights: run.result?.synthesis.insight_count ?? 0,
        sub:
          run.status === 'error'
            ? (run.error ?? 'Investigation failed')
            : run.status === 'done'
              ? `${run.specialists?.length ?? 0} specialist agents completed`
              : run.stage === 'planning'
                ? 'Planning analysis — mapping your dataset…'
                : `${run.specialists?.filter((s) => s.status === 'done').length ?? 0} of ${run.specialists?.length ?? 0} agents completed`,
      }
    : null

  // Progress comes from the run itself; there is no simulated fallback any more.
  const progress = agentProgress ?? {
    pct: view?.progress.pct ?? 0,
    insights: view?.progress.insights ?? 0,
    sub: view ? `${view.progress.completed} of ${view.progress.total} accelerators completed` : '',
  }

  return (
    <AppShell activeKey="investigations" crumbs={crumbs}>
      {/* THE TITLE ROW: the page's name on the left and the Export on the
          right, in the corner every other page keeps it. The subtitle that
          used to sit under the title said what the query bar's placeholder
          already says. */}
      <div className="fade-in flex flex-wrap items-center justify-between gap-x-6 gap-y-3">
        <h1 className="flex items-center gap-2 text-2xl font-extrabold tracking-[-0.02em]">
          Promotion Investigation Workspace <Icon name="sparkles" className="h-5 w-5 text-brand-violet" />
        </h1>
        <div className="ml-auto flex items-center gap-2">
          {/* EXPORTS THE RUN ON SCREEN. The finished run travels whole, the
              way a decision record does, so the report is the stored
              synthesis and findings the page is showing — never a re-run.
              The scope is the run's own (`global_filters`), minus `week`,
              which is a label on the run rather than a report dimension; the
              adapter prints it from the run instead. Disabled until there is
              a finished run to report on. */}
          <ExportReportButton
            module="investigations"
            label="Export"
            scope={() => {
              const { week: _week, ...scope } = (run?.result?.global_filters ?? {}) as Record<string, unknown>
              return scope
            }}
            options={() => ({
              run: run && {
                ...run,
                result: run.result && {
                  ...run.result,
                  // The graph and each specialist's raw tool output are not
                  // in the report and would only bloat the stored record.
                  orchestration: null,
                  findings: run.result.findings.map(({ analysis_data: _a, ...f }) => f),
                },
              },
              source_label: sourceLabel,
            })}
            disabled={run?.status !== 'done' || !run.result?.synthesis}
            disabledReason={
              running
                ? 'The specialist agents are still running — export when they finish.'
                : 'Ask a question and let the specialist agents finish, then export the answer.'
            }
          />
        </div>
      </div>

      <div className="mt-4">
        <QueryBar
          value={queryInput}
          onChange={setQueryInput}
          onSubmit={runQuery}
          loading={submitting || running}
          loadingLabel={running ? 'Specialist agents analysing your data…' : `Composing ${typeMeta.title} agents…`}
        />
      </div>


      {run?.status === 'error' && (
        <div className="mt-3 rounded-[var(--r-md)] bg-status-danger-bg p-[10px_14px] text-base text-[#B91C1C]">
          Investigation failed — {run.error}
        </div>
      )}

      {!showWorkspace ? (
        <AskSomething types={types} onPick={(q) => { setQueryInput(q); void launch(q) }} />
      ) : run?.status === 'done' && run.result && run.result.answerable === false ? (
        <OutOfScope
          question={run.question}
          reason={run.result.refusal ?? ''}
          onReset={() => {
            clearRun()
            setQueryInput('')
          }}
        />
      ) : launchError || run?.status === 'error' ? (
        <FailedState
          question={queryInput || activeQuestion}
          // The launch failure if the request never started, otherwise the
          // reason the backend recorded on the run itself.
          message={launchError ?? run?.error ?? 'The investigation failed.'}
          onRetry={() => {
            const attempt = lastAttempt.current
            if (attempt) void launch(attempt.question, attempt.scope)
          }}
        />
      ) : !view ? (
        <RunningState
          question={queryInput || activeQuestion}
          specialists={run?.specialists ?? []}
          stage={run?.stage}
          startedAt={run?.created_at}
        />
      ) : (
        <>
      {/* The question and its scope first, the agents' answer second — the
          order a post-mortem is read in. The findings card used to sit above
          this one, before the workspace branch, so the answer came before the
          question and the three blocks read as repeats of each other. */}
      <BizQuestionCard subject={view.center} contextChips={view.contextChips} />

      {run?.status === 'done' && run.result && (
        <AgentFindings
          summary={run.result.synthesis.summary}
          rootCause={run.result.synthesis.root_cause}
          recommendations={run.result.synthesis.recommendations}
          confidence={run.result.synthesis.confidence}
        />
      )}

      {/* 1000, not 1280: the content column is 1248px on a 1536-wide screen at
          100% zoom, so a 1280 threshold stacked the graph and the accelerator
          list on exactly the machine this is demonstrated on — they only sat
          side by side once the browser was zoomed out. Same threshold the
          Insights Hub's chart rows use. */}
      <div className={`grid gap-4 @max-[1000px]:grid-cols-1 ${agentsOpen ? 'grid-cols-[1.7fr_1fr]' : 'grid-cols-1'}`}>
        <Card className="fade-in">
          <CardHeader
            title="Investigation Graph"
            actions={
              /* THE ONE CONTROL on the graph card. The zoom and full-screen
                 controls that used to sit here are gone — the graph is drawn
                 to fit its card — and what a reader wants beside the graph is
                 the panel that explains its agents. Set in the card title's
                 own type so the two headings read as a pair, with only the
                 chevron and the hover saying which one is the control.
                 Pressed, the panel opens alongside; released, the graph takes
                 the whole row. */
              <button
                type="button"
                aria-pressed={agentsOpen}
                aria-controls="agents-info-panel"
                onClick={toggleAgents}
                className="inline-flex cursor-pointer items-center gap-1.5 rounded-[var(--r-sm)] border-0 bg-transparent px-2 py-1 text-md font-bold text-ink-primary transition-colors hover:bg-surface-hover hover:text-brand-violet focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-violet/60 [&_svg]:h-4 [&_svg]:w-4"
              >
                <Icon name="cpu" className="text-brand-violet" /> <span>Agents Info</span>
                <Icon name={agentsOpen ? 'chevronRight' : 'chevronLeft'} />
              </button>
            }
          />
          <InvestigationGraph
            center={view.center}
            nodes={graphNodes}
            revealedKeys={revealedKeys}
            onNodeClick={(node, el) => setPopover({ node, el })}
          />
        </Card>

        {/* WHAT EACH AGENT DOES, beside the graph it explains: the
            specialists with their plain-words job and live status. Mounted
            only while the graph card's "Agents Info" control is pressed, so
            the entrance plays each time it opens. */}
        {agentsOpen && (
          <Card id="agents-info-panel" className="fade-in flex h-full flex-col">
            <CardHeader title="Agent Descriptions" />
            {/* Same `fill` shape the ChartFrame cards use: the card is a flex
                column and the body takes the remaining height, so the list can
                spread into it instead of leaving the card's tail blank. */}
            <div className="flex flex-1 flex-col px-4.5 py-1">
              <AccelList
                accelerators={runAccelerators ?? view.accelerators}
                statusOverride={runAccelState}
              />
            </div>
          </Card>
        )}
      </div>

      <ProgressStrip
        pct={progress.pct}
        sub={progress.sub}
        insights={progress.insights}
        // Rows the investigated SCOPE holds — see the note in
        // agents/star_pipeline.py. Not the size of the dataset.
        records={view.progress.sources}
        // Disabled until there is a synthesis to reveal, rather than
        // scrolling to an empty card.
        canViewSummary={Boolean(run?.result?.synthesis)}
        onViewSummary={() => navigate('/intelligence')}
      />

        </>
      )}

      {popover && view && (
        <NodeDetailPopover
          node={popover.node}
          detail={view.nodeDetails[popover.node.key]}
          anchorEl={popover.el}
          onClose={() => setPopover(null)}
        />
      )}
    </AppShell>
  )
}
