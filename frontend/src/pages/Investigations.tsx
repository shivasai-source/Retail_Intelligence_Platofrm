import { useEffect, useRef, useState } from 'react'
import { Link, useLocation, useNavigate } from 'react-router-dom'
import { AppShell } from '../components/layout/AppShell'
import {
  Button,
  IconButton,
  Card,
  CardHeader,
  Pill,
  Spinner,
  Dropdown,
  useToast,
  useConfirm,
} from '../components/ui'
import { Icon } from '../icons'
import {
  useInvestigationTypes,
  useLegacyInvestigation,
} from '../hooks/useInvestigations'
import { useStartInvestigationRun, useInvestigationRun } from '../hooks/useInvestigationRun'
import { useDatasets } from '../hooks/useDatasets'
import { ApiError } from '../lib/api'
import { ASK_WHY_STATE_KEY, type AskWhyIntent } from '../lib/askWhy'
import { useActiveInvestigationStore } from '../store/activeInvestigation'
import { InvestigationGraph } from '../components/investigations/InvestigationGraph'
import { bindCannibalizationNode } from '../components/investigations/cannibalizationNode'
import { NodeDetailPopover } from '../components/investigations/NodeDetailPopover'
import { BizQuestionCard } from '../components/investigations/BizQuestionCard'
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
    datasetId,
    setDatasetId,
    hasAsked,
    beginRun,
    clearRun,
    handoffLabel,
    setHandoffLabel,
    intentKey: launchedIntentKey,
    markIntent,
  } = useActiveInvestigationStore()
  const { data: types } = useInvestigationTypes()
  const { data: legacy } = useLegacyInvestigation()
  const { show } = useToast()
  const confirm = useConfirm()

  // Real agent run against an uploaded dataset. When one is active its
  // orchestration replaces the static per-archetype JSON below.
  const { data: datasets } = useDatasets()
  const startRun = useStartInvestigationRun()
  const { data: run, error: runError } = useInvestigationRun(runId ?? undefined)
  // `undefined` means the built-in TPO star schema — the same data the Command
  // Center reports on, so both tabs agree. Uploads are the alternative source.
  const selectedDataset = datasets?.find((d) => d.id === datasetId)
  const sourceLabel = selectedDataset
    ? `${selectedDataset.filename} · ${selectedDataset.rows.toLocaleString()} rows`
    : 'TPO star schema (built-in)'
  const liveOrch = run?.status === 'done' ? run.result?.orchestration : undefined

  // An "Ask why" handoff from the Command Center arrives as router state.
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

  // GRAPH TOOLBAR STATE. Zoom is read by <InvestigationGraph/>, so the
  // control changes the picture rather than announcing that it did.
  const [zoom, setZoom] = useState(1)
  // The graph card can take over the window. Escape leaves, so the expanded
  // view is never a state the user has to hunt for a button to get out of.
  const [graphExpanded, setGraphExpanded] = useState(false)
  useEffect(() => {
    if (!graphExpanded) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setGraphExpanded(false)
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [graphExpanded])
  const navigate = useNavigate()

  // Share actually copies now. There is no per-investigation permalink to hand
  // out — the page holds no shareable server-side state — so what goes on the
  // clipboard is this page's URL, and the dialog says exactly that.
  const copyShareLink = async () => {
    const link = window.location.href
    try {
      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(link)
      } else {
        // Clipboard API needs a secure context; fall back for plain http.
        const ta = document.createElement('textarea')
        ta.value = link
        ta.setAttribute('readonly', '')
        ta.style.position = 'fixed'
        ta.style.opacity = '0'
        document.body.appendChild(ta)
        ta.select()
        const ok = document.execCommand('copy')
        document.body.removeChild(ta)
        if (!ok) throw new Error('copy rejected')
      }
      show('Link copied to clipboard')
    } catch {
      show('Could not copy the link — copy it from the address bar', { duration: 3000 })
    }
  }

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

  const legend = legacy?.legend ?? []

  // Always a real agent run. Omitting dataset_id investigates the built-in
  // star schema; passing one investigates that uploaded file.
  // `scope` is only ever present on an "Ask why" hand-off: it is the
  // Command Center's validated FilterState narrowed to the clicked event.
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
        dataset_id: datasetId,
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
  const isAgentRun = Boolean(liveOrch)
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
      <div className="fade-in flex items-end justify-between gap-4">
        <div>
          <div className="flex items-center gap-3">
            <h1 className="flex items-center gap-2 text-2xl font-extrabold tracking-[-0.02em]">
              Promotion Investigation Workspace <Icon name="sparkles" className="h-5 w-5 text-brand-violet" />
            </h1>
          </div>
          <p className="mt-1.5 text-base text-ink-muted">
            {/* Agent count only means something once a run has produced one —
                "0 specialist agents orchestrated" reads like a failure. */}
            Investigation Compression Engine
            {(() => {
              const count = (runAccelerators ?? view?.accelerators ?? []).length
              if (!showWorkspace) return ' · ask a question to begin'
              if (!count) return ' · composing the specialist team…'
              return (
                <>
                  {' · '}
                  <strong className="text-brand-violet">{typeMeta.title}</strong> mode · {count} specialist agents
                  orchestrated
                </>
              )
            })()}
          </p>
        </div>
        <div className="flex items-center gap-2">
          <IconButton
            icon="arrowUpRight"
            title="Share"
            onClick={() =>
              confirm({
                title: 'Share Investigation',
                body: 'Copies this page’s link to your clipboard.',
                primaryText: 'Copy Link',
                icon: 'arrowUpRight',
                onConfirm: () => {
                  void copyShareLink()
                },
              })
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

      {/* Which uploaded dataset the agents analyse. Without one there's nothing
          real to investigate, so the page falls back to the sample orchestration. */}
      <div className="mt-2.5 flex flex-wrap items-center gap-2 text-base text-ink-muted">
        <Icon name="database" className="h-3.5 w-3.5" />
        <span>Analysing</span>
        <Dropdown
          selected={datasetId ?? 'star'}
          options={[
            { label: 'TPO star schema (built-in)', value: 'star' },
            ...(datasets ?? []).map((d) => ({
              label: `${d.filename} · ${d.rows.toLocaleString()} rows`,
              value: d.id,
            })),
          ]}
          onSelect={(val) => setDatasetId(val === 'star' ? null : val)}
          trigger={
            <Button variant="ghost" size="sm" className="cursor-pointer">
              {sourceLabel} <Icon name="chevronDown" />
            </Button>
          }
        />
        {handoffLabel && <Pill tone="violet">{handoffLabel}</Pill>}
        {isAgentRun && <Pill tone="success">Live agent analysis</Pill>}
        {!datasets?.length && (
          <Link to="/home" className="font-semibold text-brand-violet">
            Upload your own data →
          </Link>
        )}
      </div>

      {run?.status === 'error' && (
        <div className="mt-3 rounded-[var(--r-md)] bg-status-danger-bg p-[10px_14px] text-base text-[#B91C1C]">
          Investigation failed — {run.error}
        </div>
      )}

      {run?.status === 'done' && run.result && (
        // THE SUMMARY TARGET. "View Insights Summary" scrolls here rather than
        // opening a second rendering of the synthesis this card already shows.
        <div className="scroll-mt-6">
        <Card className="fade-in mt-3.5">
          <CardHeader
            title={
              <span className="flex items-center gap-1.5">
                <Icon name="sparkles" className="h-5 w-5 text-brand-violet" /> Agent Findings
              </span>
            }
            actions={<Pill tone="violet">{run.result.synthesis.confidence}% confidence</Pill>}
          />
          <div className="flex flex-col gap-2.5 p-5 pt-3.5">
            <p className="text-md leading-[1.65] text-ink-secondary">{run.result.synthesis.summary}</p>
            <div className="rounded-[var(--r-md)] border border-[rgba(124,92,255,0.2)] bg-brand-violet-50 p-[10px_14px]">
              <div className="text-xs font-bold uppercase tracking-[0.06em] text-ink-muted">Root cause</div>
              <div className="mt-1 text-md font-semibold text-ink-primary">{run.result.synthesis.root_cause}</div>
            </div>
            {run.result.synthesis.recommendations.length > 0 && (
              <div>
                <div className="mb-1.5 text-xs font-bold uppercase tracking-[0.06em] text-ink-muted">
                  Recommended actions
                </div>
                <ul className="flex flex-col gap-1.5">
                  {run.result.synthesis.recommendations.map((r, i) => (
                    <li key={i} className="flex items-start gap-2 text-base leading-[1.55] text-ink-secondary">
                      <Icon name="checkCircle" className="mt-0.5 h-3.5 w-3.5 shrink-0 text-status-success" />
                      <span>{r}</span>
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </div>
        </Card>
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
      <BizQuestionCard typeMeta={typeMeta} question={activeQuestion} contextChips={view.contextChips} />

      {/* 1000, not 1280: the content column is 1248px on a 1536-wide screen at
          100% zoom, so a 1280 threshold stacked the graph and the accelerator
          list on exactly the machine this is demonstrated on — they only sat
          side by side once the browser was zoomed out. Same threshold the
          Command Center's chart rows use. */}
      <div className="grid grid-cols-[1.7fr_1fr] gap-4 @max-[1000px]:grid-cols-1">
        <Card
          className={
            graphExpanded
              ? 'fade-in fixed inset-4 z-[9990] m-0 flex flex-col overflow-hidden shadow-[var(--shadow-lg)]'
              : 'fade-in'
          }
        >
          <CardHeader
            title={
              <span className="flex items-center gap-1.5">
                Investigation Graph <Icon name="info" className="h-3.5 w-3.5 text-ink-muted" />
              </span>
            }
            actions={
              <div className="flex items-center gap-1.5">
                {/* Names the arrangement on screen. Not a control: there is
                    one layout, so a picker here would be a click target that
                    could not change anything. */}
                <span className="mr-1 text-sm font-semibold text-ink-muted">Radial</span>
                {/* Zoom is clamped so the stage can never be scaled past the
                    point where nodes leave it or become unreadable. */}
                <IconButton
                  icon="zoomOut"
                  title="Zoom out"
                  disabled={zoom <= 0.6}
                  onClick={() => setZoom((z) => Math.max(0.6, Math.round((z - 0.1) * 10) / 10))}
                />
                <span className="min-w-[42px] text-center text-sm font-semibold tabular-nums text-ink-muted">
                  {Math.round(zoom * 100)}%
                </span>
                <IconButton
                  icon="zoomIn"
                  title="Zoom in"
                  disabled={zoom >= 1.6}
                  onClick={() => setZoom((z) => Math.min(1.6, Math.round((z + 0.1) * 10) / 10))}
                />
                <IconButton
                  icon={graphExpanded ? 'x' : 'expand'}
                  title={graphExpanded ? 'Exit full screen (Esc)' : 'Expand to full screen'}
                  onClick={() => setGraphExpanded((v) => !v)}
                />
              </div>
            }
          />
          <InvestigationGraph
            center={view.center}
            nodes={graphNodes}
            legend={legend}
            revealedKeys={revealedKeys}
            zoom={zoom}
            expanded={graphExpanded}
            onNodeClick={(node, el) => setPopover({ node, el })}
          />
        </Card>

        <Card className="fade-in flex h-full flex-col">
          <CardHeader
            title={
              <span className="flex items-center gap-1.5">
                Active Accelerators <Icon name="info" className="h-3.5 w-3.5 text-ink-muted" />
              </span>
            }
            actions={<Pill tone="violet">{typeMeta.title}</Pill>}
          />
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
