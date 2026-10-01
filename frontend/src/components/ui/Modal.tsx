import { useEffect } from 'react'
import type { ReactNode } from 'react'
import { createPortal } from 'react-dom'

// Ported from css/components.css .modal-backdrop / .modal
//
// RENDERED THROUGH A PORTAL. A modal can hold another — the alerts dialog on
// Investigations holds RiskAlertsPanel, whose "View all" opens a second one —
// and the outer card is animated in with a transform. A transformed ancestor
// becomes the containing block for `position: fixed`, so an inner overlay
// rendered in place would be sized and positioned to the card rather than the
// viewport. Mounting every modal on <body> keeps each one a sibling of the
// others; React context and synthetic events still reach it as before.
export function Modal({
  open,
  onClose,
  children,
  maxWidthClassName = 'max-w-[480px]',
  closeOnBackdrop = true,
}: {
  open: boolean
  onClose: () => void
  children: ReactNode
  maxWidthClassName?: string
  /** Whether a click on the blurred page behind closes it. Off for a dialog
   *  the reader came to complete, where a stray click should not undo the
   *  step they are on; Escape and the dialog's own close still work. */
  closeOnBackdrop?: boolean
}) {
  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [open, onClose])

  if (!open) return null

  return createPortal(
    <div
      className="fade-in fixed inset-0 z-[100] grid place-items-center bg-[rgba(15,22,41,0.4)] backdrop-blur-[4px]"
      onClick={(e) => {
        if (closeOnBackdrop && e.target === e.currentTarget) onClose()
      }}
    >
      <div
        className={`fade-in-up w-[90%] rounded-[var(--r-xl)] bg-surface-card shadow-[var(--shadow-lg)] ${maxWidthClassName}`}
      >
        {children}
      </div>
    </div>,
    document.body,
  )
}
