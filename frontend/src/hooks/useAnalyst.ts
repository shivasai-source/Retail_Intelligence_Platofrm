import { useCallback, useRef, useState } from 'react'
import { ApiError, apiPost } from '../lib/api'
import { applyAnalystActions, type AnalystAction, type AppliedActions } from '../lib/analystActions'
import { useHubLayout } from '../store/hubLayout'
import type { AnalystChartSpec } from '../components/analyst/AnalystChart'
import type { IconName } from '../icons'

/** WHICH HUB THIS CONVERSATION IS ON.
 *
 *  Three things differ between the TPO Insights Hub and the MMM one: the
 *  endpoint, what "the page looks like this" means, and who applies the
 *  actions that come back. Everything else a conversation is — the thread, the
 *  ref that lets a follow-up resolve, the fact store, the pop-out handoff, the
 *  undo chip — is the same on both, so it lives here once.
 *
 *  Defaulted to TPO, so every existing caller is unchanged. */
export interface AnalystModule {
  /** The ask endpoint, relative to the API root. */
  endpoint: string
  /** What the page is showing, read at SEND time rather than held — the reader
   *  may have removed a chart since the last turn, and the model must not be
   *  told about one that is gone. */
  dashboardState: () => Record<string, unknown>
  /** Turn the described actions into state, and say what was done. */
  applyActions: (actions: AnalystAction[] | undefined) => AppliedActions
  /** How many changes are left to undo, for the chip under an answer. */
  undoDepth: () => number
  /** The header's second line, when it is not working. The dot beside it
   *  already says it is online, so this says what the thing IS. It is
   *  `truncate`d in a header that also carries the orb, the title and four
   *  controls, so about twenty-six characters survive — see the note in
   *  AnalystConversation. */
  subtitle: string
  /** The empty thread's paragraph: what this one can be asked about. */
  blurb: string
  /** Four questions that show its RANGE, each labelled with the kind of
   *  question it is, so the reader learns the shapes it answers rather than
   *  four sentences. */
  starters: readonly { kind: string; icon: IconName; q: string }[]
  /** Moving a conversation between windows. Each hub has its own pair of keys:
   *  localStorage is shared by every window of this origin, so one pair would
   *  let a thread about trade spend arrive in the MMM hub's pop-out, where
   *  every follow-up in it would be answered from the wrong dataset. */
  handoff: { toWindow: string; toPanel: string }
  /** The hash route the pop-out window opens, the name it opens under, its
   *  document title, and where it goes when it cannot close itself. */
  windowRoute: string
  windowName: string
  windowTitle: string
  homeRoute: string
  /** Whether this hub receives questions handed over from another page — the
   *  figure lookups typed into Investigations. TPO only: there is no MMM
   *  Investigations to hand one over. */
  usesInbox?: boolean
}

export const TPO_ANALYST: AnalystModule = {
  endpoint: '/analyst/ask',
  dashboardState: () => useHubLayout.getState().dashboardState(),
  applyActions: (actions) => applyAnalystActions(actions),
  undoDepth: () => useHubLayout.getState().history.length,
  subtitle: 'Promotion data assistant',
  blurb:
    'What would you like to know about your promotions today? Ask about spend, sales or ROI, '
    + 'by year, channel, region, brand or promotion — or tell me to change the period, the '
    + 'filters or which charts are on screen.',
  starters: [
    { kind: 'Look up', icon: 'search', q: 'What was our trade spend last year?' },
    { kind: 'Rank', icon: 'barChart', q: 'Which channel had the best ROI?' },
    { kind: 'Chart', icon: 'pieChart', q: 'Chart trade spend by channel' },
    { kind: 'Change the page', icon: 'filter', q: 'Change the period to 2024' },
  ],
  handoff: { toWindow: 'tiq.analyst.toWindow', toPanel: 'tiq.analyst.toPanel' },
  windowRoute: '#/analyst',
  windowName: 'tpo-analyst',
  windowTitle: 'Analyst · TPO Intelligence',
  homeRoute: '/command',
  usesInbox: true,
}

/** One turn in the thread. `pending` marks the assistant bubble that is still
 *  being written, so the panel can show a thinking state in the thread itself
 *  rather than as a separate banner. */
export interface AnalystMessage {
  id: string
  role: 'user' | 'assistant'
  content: string
  pending?: boolean
  /** Set when the turn failed — rendered as a quiet error bubble rather than
   *  a toast, so the question it belongs to stays next to it. */
  error?: boolean
  /** True when the backend turned the question away as a causal ask. Kept so
   *  the bubble can carry the "ask Investigations instead" affordance. */
  deflected?: boolean
  /** Charts drawn for this turn. Computed server-side from the KPI engine and
   *  rendered by the UI — never parsed out of the answer text. */
  charts?: AnalystChartSpec[]
  /** What this turn CHANGED on the Insights Hub, already applied, in the
   *  reader's words — and whether it can still be undone. A turn that only
   *  answered a question carries neither. */
  changed?: string[]
  /** What it was asked to change and could not. */
  unchanged?: string[]
  undoable?: boolean
}

/** How full the conversation's memory is. The backend owns the arithmetic; the
 *  UI only displays it. */
export interface MemoryUsage {
  percent: number
  entries: number
  full: boolean
  used_chars: number
  capacity_chars: number
}

interface AskResponse {
  answer: string
  deflected: boolean
  steps: { tool: string; arguments: unknown; result: unknown }[]
  charts?: AnalystChartSpec[]
  /** Changes to the dashboard this turn asked for. The server computes nothing
   *  and changes nothing — see lib/analystActions.ts. */
  actions?: AnalystAction[]
  /** The conversation's fact store with this turn folded in. Opaque to the
   *  UI — it is held and sent back unchanged, never edited here. */
  memory?: Record<string, unknown>
  memory_usage?: MemoryUsage
}

/** Everything a conversation is, in a form that survives JSON — what the
 *  pop-out window is handed so the thread moves with the reader. */
export interface AnalystSnapshot {
  messages: AnalystMessage[]
  memory: Record<string, unknown> | null
  usage: MemoryUsage | null
}

let counter = 0
const nextId = () => `m${++counter}`

/** THE ANALYST'S CONVERSATION, held in the component tree.
 *
 *  State lives here and nowhere else: the server keeps no session, so the
 *  thread is sent back with each question. That is what makes "and what about
 *  Modern Trade?" resolve against the question before it.
 *
 *  Only the ANSWERS are sent back as history, never the tool results — the
 *  backend re-fetches the figures for every turn. A conversation that carried
 *  its numbers forward would let a stale figure be restated under a new scope,
 *  which is the one failure mode that matters in an analytics assistant.
 */
export function useAnalyst(module: AnalystModule = TPO_ANALYST) {
  const [messages, setMessages] = useState<AnalystMessage[]>([])
  const [busy, setBusy] = useState(false)
  /** THE SAME THREAD, READABLE NOW.
   *
   *  `messages` is what renders; this is what a turn in progress reads. A
   *  state updater does not run when it is called — React runs it later, while
   *  it processes the update — so a value captured inside one is not available
   *  to the code that follows. The history was built in exactly that place and
   *  so went out EMPTY on every single turn: the Analyst could not resolve
   *  "and what about Modern Trade?" because it was never shown the question
   *  before it. Every write to the thread goes through `writeMessages`, which
   *  keeps the two in step. */
  const messagesRef = useRef<AnalystMessage[]>([])
  /** The conversation's fact store. Opaque here: the server builds it, the UI
   *  holds it and sends it back, and nothing in the browser edits it. Held in
   *  a ref rather than state because a turn reads it while it is being
   *  replaced, and re-rendering on it would buy nothing — the meter reads
   *  `usage`, which IS state. */
  const memoryRef = useRef<Record<string, unknown> | null>(null)
  const [usage, setUsage] = useState<MemoryUsage | null>(null)
  // Guards against a second submit racing the first — the send control is
  // disabled while busy, but Enter can outrun a re-render.
  const inFlight = useRef(false)

  /** Write the thread. Takes the same updater shape `setMessages` takes, and
   *  applies it to the ref first so the new thread can be read on the next
   *  line rather than on the next render. */
  const writeMessages = useCallback(
    (update: (current: AnalystMessage[]) => AnalystMessage[]) => {
      messagesRef.current = update(messagesRef.current)
      setMessages(messagesRef.current)
    },
    [],
  )

  const ask = useCallback(async (question: string) => {
    const text = question.trim()
    if (!text || inFlight.current) return
    inFlight.current = true
    setBusy(true)

    const userMessage: AnalystMessage = { id: nextId(), role: 'user', content: text }
    const placeholder: AnalystMessage = { id: nextId(), role: 'assistant', content: '', pending: true }

    // The history the server sees is what was on screen BEFORE this question,
    // read from the ref so it is the real thread and not an empty array. A
    // pending or failed bubble is left out: neither is a turn that happened.
    const history = messagesRef.current
      .filter((m) => !m.pending && !m.error && m.content)
      .map((m) => ({ role: m.role, content: m.content }))
    writeMessages((current) => [...current, userMessage, placeholder])

    try {
      const res = await apiPost<AskResponse>(module.endpoint, {
        question: text,
        history,
        memory: memoryRef.current,
        // WHAT THE PAGE LOOKS LIKE, read at send time rather than held: the
        // reader may have removed a chart since the last turn, and the model
        // must not be told about one that is gone. It is what lets "make that
        // a column chart" name a chart that actually exists.
        dashboard: module.dashboardState(),
        // Currency is deliberately not sent: the bot answers in the dataset's
        // own base currency, and a reader toggling the cards to USD is
        // changing how the CARDS render, not what the data is.
      })
      if (res.memory) memoryRef.current = res.memory
      if (res.memory_usage) setUsage(res.memory_usage)
      // THE PAGE CHANGES HERE, once, before the bubble renders — so the
      // reader's eye arrives at a sentence that is already true. Applying it
      // in a render or an effect would mean the answer "Period's now 2024"
      // could be on screen a frame before the period was.
      const change = module.applyActions(res.actions)
      writeMessages((current) =>
        current.map((m) =>
          m.id === placeholder.id
            ? {
                ...m,
                content: change.answerOverride ?? res.answer,
                pending: false,
                deflected: res.deflected,
                charts: res.charts ?? [],
                changed: change.applied,
                unchanged: change.skipped,
                undoable: change.undoable,
              }
            : m,
        ),
      )
    } catch (e) {
      const message =
        e instanceof ApiError
          ? e.status === 503
            ? "The Analyst isn't configured on this server yet — it needs an LLM API key in backend/.env."
            : e.message
          : 'Something went wrong reaching the Analyst.'
      writeMessages((current) =>
        current.map((m) =>
          m.id === placeholder.id ? { ...m, content: message, pending: false, error: true } : m,
        ),
      )
    } finally {
      inFlight.current = false
      setBusy(false)
    }
  }, [writeMessages, module])

  /** Clear the thread AND the memory — one control, because a reader who
   *  clears the conversation means all of it. Sending `null` next turn is what
   *  the backend reads as a fresh conversation. */
  const clear = useCallback(() => {
    writeMessages(() => [])
    memoryRef.current = null
    setUsage(null)
  }, [writeMessages])

  /** Forget what the conversation established but KEEP the visible thread.
   *  The reader can then start a new line of questioning without losing the
   *  answers they are still reading. */
  const resetMemory = useCallback(() => {
    memoryRef.current = null
    setUsage(null)
  }, [])

  /** The finished turns and the memory behind them. A pending bubble is left
   *  out: its answer would arrive in the window that asked, not this copy. */
  const snapshot = useCallback(
    (): AnalystSnapshot => ({
      messages: messages.filter((m) => !m.pending),
      memory: memoryRef.current,
      usage,
    }),
    [messages, usage],
  )

  /** Replace the conversation with one handed over from another window. Ids
   *  are reissued so they cannot collide with this window's counter. */
  const restore = useCallback(
    (snap: AnalystSnapshot) => {
      writeMessages(() => snap.messages.map((m) => ({ ...m, id: nextId(), pending: false })))
      memoryRef.current = snap.memory
      setUsage(snap.usage)
    },
    [writeMessages],
  )

  /** Put back the last change the Analyst made, from the chip under the
   *  answer. The same stack the `undo` tool pops, so typing "undo" and
   *  clicking Undo cannot disagree about what "the last change" was. */
  const undoChange = useCallback(() => {
    const result = undoFor(module)
    if (!result.ok) return
    writeMessages((current) => [
      ...current,
      {
        id: nextId(),
        role: 'assistant',
        content: `Put that back — ${result.label}.`,
        changed: [],
        unchanged: [],
        undoable: module.undoDepth() > 0,
      },
    ])
  }, [writeMessages, module])

  return { messages, busy, ask, clear, usage, resetMemory, snapshot, restore, undoChange, module }
}

/** Pop the module's own undo stack.
 *
 *  THE STACK IS NOT PART OF THE MODULE CONTRACT because `applyActions`
 *  already owns it: an `undo` action goes through the applier like every other
 *  change, and that is the path the Analyst itself uses. This is the CHIP's
 *  path — the reader clicking Undo beside an answer — and it is routed through
 *  the same applier so a click and the word "undo" cannot disagree about what
 *  "the last change" was. */
function undoFor(module: AnalystModule): { ok: boolean; label?: string } {
  const result = module.applyActions([
    { kind: 'undo', summary: 'undid the last change' } as AnalystAction,
  ])
  if (!result.applied.length) return { ok: false }
  return { ok: true, label: result.applied[0].replace(/^put back: /, '') }
}
