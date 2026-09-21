import { useCallback, useRef, useState } from 'react'
import { ApiError, apiPost } from '../lib/api'
import type { AnalystChartSpec } from '../components/analyst/AnalystChart'

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
  /** The conversation's fact store with this turn folded in. Opaque to the
   *  UI — it is held and sent back unchanged, never edited here. */
  memory?: Record<string, unknown>
  memory_usage?: MemoryUsage
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
export function useAnalyst() {
  const [messages, setMessages] = useState<AnalystMessage[]>([])
  const [busy, setBusy] = useState(false)
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

  const ask = useCallback(async (question: string) => {
    const text = question.trim()
    if (!text || inFlight.current) return
    inFlight.current = true
    setBusy(true)

    const userMessage: AnalystMessage = { id: nextId(), role: 'user', content: text }
    const placeholder: AnalystMessage = { id: nextId(), role: 'assistant', content: '', pending: true }

    // The history the server sees is what was on screen BEFORE this question —
    // captured here rather than read back from state, which would race the
    // update below.
    let history: { role: 'user' | 'assistant'; content: string }[] = []
    setMessages((current) => {
      history = current
        .filter((m) => !m.pending && !m.error && m.content)
        .map((m) => ({ role: m.role, content: m.content }))
      return [...current, userMessage, placeholder]
    })

    try {
      const res = await apiPost<AskResponse>('/analyst/ask', {
        question: text,
        history,
        memory: memoryRef.current,
        // Currency is deliberately not sent: the bot answers in the dataset's
        // own base currency, and a reader toggling the cards to USD is
        // changing how the CARDS render, not what the data is.
      })
      if (res.memory) memoryRef.current = res.memory
      if (res.memory_usage) setUsage(res.memory_usage)
      setMessages((current) =>
        current.map((m) =>
          m.id === placeholder.id
            ? {
                ...m,
                content: res.answer,
                pending: false,
                deflected: res.deflected,
                charts: res.charts ?? [],
              }
            : m,
        ),
      )
    } catch (e) {
      const message =
        e instanceof ApiError
          ? e.status === 503
            ? "The Analyst isn't configured on this server yet — it needs an OpenAI key in backend/.env."
            : e.message
          : 'Something went wrong reaching the Analyst.'
      setMessages((current) =>
        current.map((m) =>
          m.id === placeholder.id ? { ...m, content: message, pending: false, error: true } : m,
        ),
      )
    } finally {
      inFlight.current = false
      setBusy(false)
    }
  }, [])

  /** Clear the thread AND the memory — one control, because a reader who
   *  clears the conversation means all of it. Sending `null` next turn is what
   *  the backend reads as a fresh conversation. */
  const clear = useCallback(() => {
    setMessages([])
    memoryRef.current = null
    setUsage(null)
  }, [])

  /** Forget what the conversation established but KEEP the visible thread.
   *  The reader can then start a new line of questioning without losing the
   *  answers they are still reading. */
  const resetMemory = useCallback(() => {
    memoryRef.current = null
    setUsage(null)
  }, [])

  return { messages, busy, ask, clear, usage, resetMemory }
}
