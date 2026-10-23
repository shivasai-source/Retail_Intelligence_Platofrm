import { useEffect } from 'react'
import { useNavigate } from 'react-router-dom'
import { IconButton } from '../components/ui'
import { AnalystConversation } from '../components/analyst/AnalystConversation'
import { TPO_ANALYST, useAnalyst, type AnalystModule } from '../hooks/useAnalyst'
import { sendHandoff, takeHandoff } from '../lib/analystHandoff'

/** THE ANALYST IN ITS OWN WINDOW (#/analyst) — what "Open in a new window"
 *  opens, so the conversation can sit on a second screen while the dashboard
 *  keeps the whole of the first.
 *
 *  No app shell: the window is the conversation. It arrives carrying the
 *  thread the panel handed it, picks up a later hand-off if the reader pops
 *  out again while it is open, and can send the thread back to the dashboard.
 *
 *  ONE COMPONENT, EITHER HUB: the MMM hub's pop-out is this window with
 *  `module` set (#/mmm/analyst, its own hand-off keys and its own endpoint).
 */
export function AnalystWindow({ module = TPO_ANALYST }: { module?: AnalystModule }) {
  const analyst = useAnalyst(module)
  const { restore } = analyst
  const navigate = useNavigate()
  const hasOpener = Boolean(window.opener && !window.opener.closed)

  const { toWindow } = module.handoff
  const { windowTitle } = module
  useEffect(() => {
    const previous = document.title
    document.title = windowTitle
    const initial = takeHandoff(toWindow)
    if (initial) restore(initial)
    const onStorage = (e: StorageEvent) => {
      if (e.key !== toWindow || !e.newValue) return
      const snap = takeHandoff(toWindow)
      if (snap && snap.messages.length) restore(snap)
    }
    window.addEventListener('storage', onStorage)
    return () => {
      document.title = previous
      window.removeEventListener('storage', onStorage)
    }
  }, [restore, toWindow, windowTitle])

  // window.close() only works on a window a script opened; reached by URL,
  // this tab stays, so fall back to the dashboard.
  const leave = () => {
    window.close()
    window.setTimeout(() => navigate(module.homeRoute), 150)
  }

  const dockBack = () => {
    sendHandoff(module.handoff.toPanel, analyst.snapshot())
    window.opener?.focus()
    leave()
  }

  return (
    <div className="flex h-screen flex-col bg-surface-page">
      <AnalystConversation
        analyst={analyst}
        centered
        actions={
          <>
            {hasOpener && (
              <IconButton
                icon="dock"
                className="!h-8 !w-8"
                title={analyst.busy ? 'Wait for the answer, then move back' : 'Move back to the dashboard'}
                aria-label="Move back to the dashboard"
                disabled={analyst.busy}
                onClick={dockBack}
              />
            )}
            <IconButton icon="x" className="!h-8 !w-8" title="Close window" aria-label="Close window" onClick={leave} />
          </>
        }
      />
    </div>
  )
}
