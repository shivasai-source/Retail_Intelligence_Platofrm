import { useCallback, useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { IconButton, useToast } from '../ui'
import { AnalystConversation } from './AnalystConversation'
import { useAnalyst } from '../../hooks/useAnalyst'
import { useAnalystLayout, ANALYST_MIN_W, ANALYST_MAX_W } from '../../store/analystLayout'
import { TO_PANEL, TO_WINDOW, dropHandoff, readHandoff, sendHandoff, takeHandoff } from '../../lib/analystHandoff'

/** Wide enough to give the Analyst a column AND leave the dashboard a usable
 *  one. Below this the docked panel overlays the page instead of pushing it. */
const DOCK_MEDIA = '(min-width: 1100px)'

function useMediaQuery(query: string): boolean {
  const [matches, setMatches] = useState(() => window.matchMedia(query).matches)
  useEffect(() => {
    const mql = window.matchMedia(query)
    const on = () => setMatches(mql.matches)
    mql.addEventListener('change', on)
    return () => mql.removeEventListener('change', on)
  }, [query])
  return matches
}

/** THE ANALYST PANEL — the dashboard's chat, in three ways of looking at it.
 *
 *  DOCKED (the default): a side panel with no backdrop. On a wide screen the
 *  page shell makes room for it (see store/analystLayout.ts), so the cards the
 *  questions are about stay fully visible and usable beside the conversation.
 *  Its left edge drags to resize. On a narrower screen there is no room to
 *  share, so it overlays the page as a drawer.
 *
 *  EXPANDED: a large centred workspace over a dimmed page, for a long answer
 *  or a wide chart.
 *
 *  POP OUT: a separate browser window (#/analyst) the reader can put on a
 *  second monitor. The conversation travels with it (lib/analystHandoff.ts)
 *  and can come back the same way.
 *
 *  Portaled to <body> with `position: fixed` for the same reason every other
 *  floating surface here is (see ui/Dropdown.tsx): the page's entrance
 *  animations establish stacking contexts, and an in-tree panel would be
 *  trapped beneath later siblings however it was z-indexed.
 */
export function AnalystPanel({
  open,
  onClose,
  onOpen,
}: {
  open: boolean
  onClose: () => void
  /** Called when a conversation is handed back from the pop-out window. */
  onOpen?: () => void
}) {
  const analyst = useAnalyst()
  const { restore } = analyst
  const { show } = useToast()
  const mode = useAnalystLayout((s) => s.mode)
  const width = useAnalystLayout((s) => s.width)
  const setMode = useAnalystLayout((s) => s.setMode)
  const setWidth = useAnalystLayout((s) => s.setWidth)
  const setInset = useAnalystLayout((s) => s.setInset)
  const setResizing = useAnalystLayout((s) => s.setResizing)
  const wide = useMediaQuery(DOCK_MEDIA)
  const panelRef = useRef<HTMLElement>(null)

  const docked = mode === 'docked'
  // Sharing the screen: docked, open, and room to do it.
  const sharing = open && docked && wide

  // Tell the shell how much room to make. Cleared on close and on unmount, so
  // leaving the page never strands the dashboard with an empty strip.
  useEffect(() => {
    setInset(sharing ? width : 0)
  }, [sharing, width, setInset])
  useEffect(() => () => setInset(0), [setInset])

  // Escape closes. While sharing the screen, only from inside the panel — the
  // page beside it is live, and Escape there belongs to its menus and dialogs.
  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return
      if (sharing && !panelRef.current?.contains(document.activeElement)) return
      onClose()
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [open, sharing, onClose])

  // A conversation handed back from the pop-out window: take it and open.
  const receive = useCallback(
    (snap: ReturnType<typeof readHandoff>) => {
      if (!snap) return
      restore(snap)
      onOpen?.()
    },
    [restore, onOpen],
  )
  useEffect(() => {
    receive(takeHandoff(TO_PANEL))
    const onStorage = (e: StorageEvent) => {
      if (e.key !== TO_PANEL || !e.newValue) return
      receive(takeHandoff(TO_PANEL))
      window.focus()
    }
    window.addEventListener('storage', onStorage)
    return () => window.removeEventListener('storage', onStorage)
  }, [receive])

  const popOut = () => {
    sendHandoff(TO_WINDOW, analyst.snapshot())
    const url = `${window.location.origin}${window.location.pathname}#/analyst`
    const win = window.open(url, 'tpo-analyst', 'popup,width=620,height=860')
    if (!win) {
      dropHandoff(TO_WINDOW)
      show('Your browser blocked the new window — allow pop-ups for this site and try again.', { duration: 4500 })
      return
    }
    win.focus()
    analyst.clear()
    onClose()
  }

  // Drag the left edge to resize. Pointer capture keeps the drag alive when
  // the pointer outruns the 8px handle; the width is only persisted on release.
  const startResize = (e: React.PointerEvent<HTMLDivElement>) => {
    e.preventDefault()
    const handle = e.currentTarget
    handle.setPointerCapture(e.pointerId)
    setResizing(true)
    const move = (ev: PointerEvent) => setWidth(window.innerWidth - ev.clientX, false)
    const up = (ev: PointerEvent) => {
      setWidth(window.innerWidth - ev.clientX)
      setResizing(false)
      handle.removeEventListener('pointermove', move)
      handle.removeEventListener('pointerup', up)
      handle.removeEventListener('pointercancel', up)
    }
    handle.addEventListener('pointermove', move)
    handle.addEventListener('pointerup', up)
    handle.addEventListener('pointercancel', up)
  }

  if (!open) return null

  const actions = (
    <>
      {docked ? (
        <IconButton icon="expand" className="!h-8 !w-8" title="Expand" aria-label="Expand the Analyst" onClick={() => setMode('expanded')} />
      ) : (
        <IconButton
          icon="dock"
          className="!h-8 !w-8"
          title="Dock to the side"
          aria-label="Dock to the side"
          onClick={() => setMode('docked')}
        />
      )}
      <IconButton
        icon="popOut"
        className="!h-8 !w-8"
        title={analyst.busy ? 'Wait for the answer, then open in a new window' : 'Open in a new window'}
        aria-label="Open in a new window"
        disabled={analyst.busy}
        onClick={popOut}
      />
      <IconButton icon="x" className="!h-8 !w-8" title="Close Analyst" aria-label="Close Analyst" onClick={onClose} />
    </>
  )

  return createPortal(
    <>
      {/* THE BACKDROP — only when the panel covers the page. Docked on a wide
          screen there is nothing to dim: the page sits beside it, live. */}
      {!sharing && (
        <div
          aria-hidden="true"
          onClick={onClose}
          className={`analyst-backdrop fixed inset-0 z-[120] ${
            docked ? 'bg-[rgba(15,22,41,0.28)]' : 'bg-[rgba(15,22,41,0.45)] backdrop-blur-[3px]'
          }`}
        />
      )}

      <aside
        ref={panelRef}
        role="dialog"
        aria-modal={!sharing}
        aria-label="Analyst"
        // `right: 0` on a `fixed` element stops at the viewport's scrollbar, not
        // at the window edge, leaving a ~10px strip of page showing down the
        // side of the panel. `100vw - 100%` IS the scrollbar's width, and 0
        // where there is none.
        style={
          docked
            ? { right: 'calc(100% - 100vw)', width: wide ? width : 'min(100vw, 480px)' }
            : undefined
        }
        className={
          docked
            ? 'analyst-panel fixed inset-y-0 z-[121] flex flex-col border-l border-border-default bg-surface-page shadow-[var(--shadow-lg)]'
            : 'fade-in-up fixed inset-0 z-[121] m-auto flex h-[calc(100vh-48px)] w-[min(1180px,calc(100vw-48px))] flex-col overflow-hidden rounded-[var(--r-xl)] border border-border-default bg-surface-page shadow-[var(--shadow-lg)]'
        }
      >
        {docked && wide && (
          <div
            role="separator"
            aria-orientation="vertical"
            aria-label="Resize the Analyst"
            aria-valuemin={ANALYST_MIN_W}
            aria-valuemax={ANALYST_MAX_W}
            aria-valuenow={width}
            tabIndex={0}
            onPointerDown={startResize}
            onKeyDown={(e) => {
              if (e.key === 'ArrowLeft') setWidth(width + 24)
              if (e.key === 'ArrowRight') setWidth(width - 24)
            }}
            title="Drag to resize"
            className="group absolute inset-y-0 left-0 z-10 w-2 -translate-x-1/2 cursor-col-resize touch-none focus:outline-none"
          >
            <span className="absolute inset-y-0 left-1/2 w-[3px] -translate-x-1/2 rounded-full bg-brand-violet opacity-0 transition-opacity duration-150 group-hover:opacity-60 group-focus-visible:opacity-100" />
          </div>
        )}
        <AnalystConversation analyst={analyst} actions={actions} centered={!docked} />
      </aside>
    </>,
    document.body,
  )
}
