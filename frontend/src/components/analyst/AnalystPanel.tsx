import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { Icon } from '../../icons'
import { IconButton } from '../ui'
import { AnalystMarkdown } from './AnalystMarkdown'
import { AnalystChart } from './AnalystChart'
import { useAnalyst, type AnalystMessage, type MemoryUsage } from '../../hooks/useAnalyst'
import { useCurrentUser } from '../../hooks/useAuth'
import type { IconName } from '../../icons'

/** What the Analyst is good at, offered only on an empty thread. Deliberately
 *  four questions of DIFFERENT SHAPES — a lookup, a ranking, a comparison and
 *  a piece of arithmetic — because the first question a reader asks sets what
 *  they think the thing can do. */
const STARTERS: { kind: string; icon: IconName; q: string }[] = [
  { kind: 'Look up', icon: 'search', q: 'What was our trade spend last year?' },
  { kind: 'Rank', icon: 'barChart', q: 'Which channel had the best ROI?' },
  { kind: 'Chart', icon: 'pieChart', q: 'Chart trade spend by channel' },
  { kind: 'Compare', icon: 'variance', q: 'How much more did we spend in 2025 than 2024?' },
]

/** "Good morning" / "Good afternoon" / "Good evening", by the reader's clock. */
function greeting(): string {
  const h = new Date().getHours()
  return h < 12 ? 'Good morning' : h < 17 ? 'Good afternoon' : 'Good evening'
}

/** THE ANALYST'S FACE: a violet-to-blue orb, the same mark in the header, on
 *  the empty thread and beside every answer, so the reader always knows which
 *  voice is speaking. `live` adds the soft halo used while it is thinking. */
function Orb({ size = 36, live = false }: { size?: number; live?: boolean }) {
  return (
    <span
      className="relative grid shrink-0 place-items-center rounded-full text-white shadow-[0_4px_14px_rgba(107,71,255,0.35)]"
      style={{
        width: size,
        height: size,
        background: 'radial-gradient(circle at 30% 25%, #9D86FF 0%, #6B47FF 45%, #3B5BDB 100%)',
      }}
    >
      {live && (
        <span className="absolute inset-0 animate-ping rounded-full bg-brand-violet/30 motion-reduce:animate-none" />
      )}
      <span className="relative">
        <Icon name="sparkles" size={Math.round(size * 0.46)} />
      </span>
    </span>
  )
}

/** THE ANALYST PANEL — the dashboard's chat, as a right-hand drawer.
 *
 *  It covers a third of the screen and leaves the dashboard visible and
 *  slightly dimmed behind it: the questions are ABOUT what is on screen, so
 *  hiding the screen to ask them would be the wrong trade. The backdrop is a
 *  dim and a very light blur — enough to push the page back a plane and to
 *  make the panel's own edge legible, not enough to stop the reader reading a
 *  card while they type.
 *
 *  Portaled to <body> with `position: fixed` for the same reason every other
 *  floating surface here is (see ui/Dropdown.tsx): the page's entrance
 *  animations establish stacking contexts, and an in-tree drawer would be
 *  trapped beneath later siblings however it was z-indexed.
 */
export function AnalystPanel({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { messages, busy, ask, clear, usage, resetMemory } = useAnalyst()
  const { data: user } = useCurrentUser()
  const firstName = user?.name?.trim().split(/\s+/)[0] ?? ''
  const [draft, setDraft] = useState('')
  const inputRef = useRef<HTMLTextAreaElement>(null)
  const threadRef = useRef<HTMLDivElement>(null)
  const endRef = useRef<HTMLDivElement>(null)

  // Focus the input when the drawer opens, so a reader who opened it to ask
  // something can simply type.
  //
  // The `mousedown` also dismisses any open floating menu. Every dropdown here
  // portals to <body> and closes on an outside `mousedown` — which a keyboard
  // activation of the trigger never produces, leaving a menu stranded on top
  // of the drawer. Dispatching one costs nothing when no menu is open.
  useEffect(() => {
    if (!open) return
    document.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }))
    inputRef.current?.focus()
  }, [open])

  // Escape closes, from anywhere in the drawer.
  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [open, onClose])

  // Keep the newest turn in view. `useLayoutEffect` so the scroll happens in
  // the same frame the message is painted — with `useEffect` the thread visibly
  // jumps after the bubble appears.
  useLayoutEffect(() => {
    if (!open) return
    endRef.current?.scrollIntoView({ block: 'end', behavior: messages.length > 1 ? 'smooth' : 'auto' })
  }, [messages, open])

  // The textarea grows with its content, to a ceiling — a pasted paragraph
  // should not take over the drawer.
  useLayoutEffect(() => {
    const el = inputRef.current
    if (!el) return
    el.style.height = 'auto'
    el.style.height = `${Math.min(el.scrollHeight, 140)}px`
  }, [draft])

  const submit = () => {
    const text = draft.trim()
    if (!text || busy) return
    setDraft('')
    void ask(text)
  }

  if (!open) return null

  return createPortal(
    <>
      {/* THE BACKDROP. Click-to-close, and the dim that separates the drawer
          from the page. `aria-hidden` because it is not an interactive target
          a screen-reader user needs — Escape and the close button are. */}
      <div
        aria-hidden="true"
        onClick={onClose}
        className="analyst-backdrop fixed inset-0 z-[120] bg-[rgba(15,22,41,0.28)] backdrop-blur-[2px]"
      />

      <aside
        role="dialog"
        aria-modal="true"
        aria-label="Analyst"
        // `right: 0` on a `fixed` element stops at the viewport's scrollbar, not
        // at the window edge, leaving a ~10px strip of page showing down the
        // side of the drawer. Pulling it out by the scrollbar's width closes
        // that gap; `100vw - 100%` IS that width (vw includes the scrollbar,
        // a percentage of the containing block does not) and is 0 when there
        // is no scrollbar, so this costs nothing on a page that does not
        // scroll or on an overlay-scrollbar platform.
        style={{ right: 'calc(100% - 100vw)' }}
        className="analyst-panel fixed inset-y-0 z-[121] flex w-[min(33vw,560px)] min-w-[360px] flex-col border-l border-border-default bg-surface-page shadow-[var(--shadow-lg)] @max-[900px]:w-full @max-[900px]:min-w-0"
      >
        {/* HEADER */}
        <header className="flex items-center gap-3 border-b border-border-subtle bg-surface-card px-4 py-3.5">
          <Orb size={40} live={busy} />
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2">
              <h2 className="text-md font-extrabold leading-tight text-ink-primary">Analyst</h2>
              <span className="rounded-[var(--r-pill)] bg-brand-violet-50 px-1.5 py-px text-[10px] font-bold uppercase tracking-wide text-brand-violet">
                Beta
              </span>
            </div>
            {/* Its state in one line: thinking while a question is out,
                otherwise ready — so the reader never wonders if it heard. */}
            <p className="mt-0.5 flex items-center gap-1.5 truncate text-sm font-medium text-ink-secondary">
              <span
                className={`inline-block h-2 w-2 shrink-0 rounded-full ${
                  busy ? 'animate-[pulseDot_1.2s_ease-in-out_infinite] bg-brand-violet' : 'bg-status-success'
                }`}
              />
              {busy ? 'Analysing your data…' : 'Online · your promotion data assistant'}
            </p>
          </div>
          {messages.length > 0 && (
            <button
              type="button"
              onClick={clear}
              className="cursor-pointer rounded-[var(--r-sm)] px-2.5 py-1 text-sm font-semibold text-ink-secondary transition-colors hover:bg-surface-hover hover:text-ink-primary focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-violet"
            >
              Clear
            </button>
          )}
          <IconButton icon="x" className="!h-8 !w-8" title="Close Analyst" onClick={onClose} />
        </header>

        {/* THREAD */}
        <div ref={threadRef} className="min-h-0 flex-1 overflow-y-auto px-4 py-4">
          {messages.length === 0 ? (
            <Empty name={firstName} onPick={(q) => void ask(q)} />
          ) : (
            <div className="space-y-5">
              {messages.map((m) => (
                <Bubble key={m.id} message={m} />
              ))}
            </div>
          )}
          <div ref={endRef} />
        </div>

        {/* COMPOSER */}
        <div className="border-t border-border-subtle bg-surface-card px-3.5 pb-3 pt-3.5">
          <div className="flex items-end gap-2 rounded-[14px] border border-border-default bg-surface-card p-2 pl-3 shadow-[var(--shadow-card-soft)] transition-[border-color,box-shadow] focus-within:border-brand-violet focus-within:shadow-[0_0_0_3px_rgba(107,71,255,0.12)]">
            <textarea
              ref={inputRef}
              rows={1}
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={(e) => {
                // Enter sends; Shift+Enter is a newline. The convention every
                // chat surface uses, so it needs no explaining.
                if (e.key === 'Enter' && !e.shiftKey) {
                  e.preventDefault()
                  submit()
                }
              }}
              placeholder="Ask me anything — e.g. ROI by channel for 2025"
              aria-label="Ask the Analyst a question"
              className="max-h-[140px] min-h-[28px] flex-1 resize-none bg-transparent px-1.5 py-0.5 text-[14px] leading-6 text-ink-primary !outline-none placeholder:text-ink-muted"
            />
            <button
              type="button"
              onClick={submit}
              disabled={!draft.trim() || busy}
              aria-label="Send question"
              className="grid h-9 w-9 shrink-0 cursor-pointer place-items-center rounded-[10px] bg-brand-violet text-white transition-all duration-150 hover:bg-brand-violet-600 disabled:cursor-not-allowed disabled:bg-border-default disabled:text-ink-disabled focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-violet/60"
            >
              <Icon name="send" className="h-4 w-4" />
            </button>
          </div>
          {/* THE MEMORY METER, shown only once there is something to report.
              A reader needs to know the assistant's recall is finite BEFORE it
              runs out, not by discovering it has quietly forgotten. */}
          {usage && usage.entries > 0 && <MemoryMeter usage={usage} onReset={resetMemory} />}

        </div>
      </aside>
    </>,
    document.body,
  )
}

/** HOW MUCH THE CONVERSATION REMEMBERS.
 *
 *  The Analyst keeps a bounded summary of what a conversation established —
 *  the scope in play, the figures already given — not the whole transcript.
 *  This says how full that store is and lets the reader empty it.
 *
 *  It is shown rather than hidden because a memory with a limit that nobody
 *  can see is a memory that appears to fail at random: the assistant answers
 *  "and the same for last year?" correctly ten times and then does not, with
 *  no visible reason. A meter makes the limit a fact the reader can work with.
 *
 *  The bar turns amber past 80% — the point where the next few turns will
 *  start pushing the oldest facts out.
 */
function MemoryMeter({ usage, onReset }: { usage: MemoryUsage; onReset: () => void }) {
  const pct = Math.min(100, Math.max(0, usage.percent))
  const tight = pct >= 80
  return (
    <div className="mt-2 flex items-center gap-2 px-1">
      <span className="shrink-0 text-[11px] font-bold uppercase tracking-wide text-ink-secondary">
        Memory
      </span>
      <div
        className="h-1 min-w-0 flex-1 overflow-hidden rounded-full bg-surface-hover"
        role="progressbar"
        aria-valuenow={pct}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-label={`Conversation memory ${pct}% full, ${usage.entries} things remembered`}
      >
        <div
          className="h-full rounded-full transition-[width,background-color] duration-300"
          style={{
            width: `${Math.max(2, pct)}%`,
            background: tight ? 'var(--status-warning)' : 'var(--brand-violet)',
          }}
        />
      </div>
      <span className="shrink-0 tabular-nums text-[11px] font-bold text-ink-secondary">{pct}%</span>
      <button
        type="button"
        onClick={onReset}
        title="Forget what this conversation established, but keep the messages on screen"
        className="shrink-0 cursor-pointer rounded-[var(--r-sm)] px-1.5 py-0.5 text-[11px] font-bold text-ink-secondary transition-colors hover:bg-surface-hover hover:text-brand-violet focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-violet"
      >
        Reset
      </button>
    </div>
  )
}

/** The empty thread: a greeting, what it can do, and four questions that show
 *  its range — each labelled with the KIND of question it is, so the reader
 *  learns the shapes it answers, not just four sentences. */
function Empty({ name, onPick }: { name: string; onPick: (q: string) => void }) {
  return (
    <div className="flex h-full flex-col justify-center py-6">
      <div className="mb-6 text-center">
        <div className="mx-auto mb-4 w-fit">
          <Orb size={56} />
        </div>
        <h3 className="text-xl font-extrabold tracking-[-0.015em] text-ink-primary">
          {greeting()}
          {name ? `, ${name}` : ''}.
        </h3>
        <p className="mx-auto mt-2 max-w-[36ch] text-[14px] font-medium leading-relaxed text-ink-secondary">
          What would you like to know about your promotions today? Ask about spend, sales or ROI, by year,
          channel, region, brand or promotion.
        </p>
      </div>
      <div className="mb-2.5 px-0.5 text-xs font-bold uppercase tracking-[0.08em] text-ink-secondary">Try asking</div>
      <div className="grid grid-cols-2 gap-2">
        {STARTERS.map(({ kind, icon, q }) => (
          <button
            key={q}
            type="button"
            onClick={() => onPick(q)}
            className="group flex cursor-pointer flex-col gap-2 rounded-[var(--r-lg)] border border-border-subtle bg-surface-card p-3.5 text-left shadow-[var(--shadow-card-soft)] transition-all duration-150 hover:-translate-y-0.5 hover:border-brand-violet hover:shadow-[0_6px_18px_rgba(107,71,255,0.14)] focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-violet/60"
          >
            <span className="flex items-center gap-1.5 text-xs font-bold uppercase tracking-[0.05em] text-brand-violet">
              <Icon name={icon} className="h-3.5 w-3.5 shrink-0" />
              {kind}
            </span>
            <span className="text-[14px] font-semibold leading-snug text-ink-primary">{q}</span>
          </button>
        ))}
      </div>
    </div>
  )
}

/** One turn. The reader's question is a compact violet bubble on the right;
 *  the answer is full-width on the left, because an answer carrying a table
 *  needs the width and a bubble around a table reads as a quotation. */
function Bubble({ message }: { message: AnalystMessage }) {
  if (message.role === 'user') {
    return (
      <div className="analyst-turn flex flex-col items-end">
        <span className="mb-1.5 mr-1 text-xs font-bold text-ink-secondary">You</span>
        <div
          className="max-w-[85%] whitespace-pre-wrap rounded-[16px] rounded-tr-[6px] px-4 py-2.5 text-[14px] font-medium leading-relaxed text-white shadow-[0_4px_14px_rgba(107,71,255,0.25)]"
          style={{ background: 'linear-gradient(135deg, #7C5CFF 0%, #5B3FE6 100%)' }}
        >
          {message.content}
        </div>
      </div>
    )
  }

  if (message.pending) {
    return (
      <AssistantTurn live>
        <div className="inline-flex items-center gap-3 rounded-[16px] rounded-tl-[6px] border border-border-subtle bg-surface-card px-4 py-3 text-[14px] font-medium text-ink-secondary shadow-[var(--shadow-card-soft)]">
          <span className="analyst-dots flex items-center gap-1.5" aria-hidden="true">
            <i />
            <i />
            <i />
          </span>
          <span className="sr-only" role="status">
            The Analyst is working on your question
          </span>
          <span>Working through the numbers…</span>
        </div>
      </AssistantTurn>
    )
  }

  return (
    <AssistantTurn>
      <div
        className={`rounded-[16px] rounded-tl-[6px] px-4 py-3.5 text-[14px] leading-[1.65] text-ink-primary shadow-[var(--shadow-card-soft)] ${
          message.error
            ? 'border border-status-danger/30 bg-status-danger/5 text-ink-primary'
            : 'border border-border-subtle bg-surface-card text-ink-primary'
        }`}
      >
        {/* The chart comes FIRST: it is the answer, and the sentence beneath is
            the commentary on it. */}
        {message.charts?.map((chart, i) => (
          <AnalystChart key={i} spec={chart} />
        ))}
        <AnalystMarkdown text={message.content} />
      </div>
    </AssistantTurn>
  )
}

/** An answer, signed: the orb and the name above it, the way a person's
 *  message carries their face in any chat. */
function AssistantTurn({ live = false, children }: { live?: boolean; children: React.ReactNode }) {
  return (
    <div className="analyst-turn">
      <div className="mb-1.5 flex items-center gap-2">
        <Orb size={24} live={live} />
        <span className="text-xs font-bold text-ink-primary">Analyst</span>
      </div>
      {children}
    </div>
  )
}
