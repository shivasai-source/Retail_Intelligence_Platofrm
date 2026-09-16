import { createContext, useCallback, useContext, useRef, useState, type ReactNode } from 'react'
import { Icon } from '../../icons'

// React port of js/components/toast.js's imperative `Toast.show(message, opts)`.
// Same call shape via useToast().show(...), but state-driven instead of raw DOM mutation.
export type ToastVariant = 'success' | 'info' | 'error'

interface ToastItem {
  id: number
  message: string
  variant: ToastVariant
  leaving: boolean
}

interface ToastOptions {
  variant?: ToastVariant
  duration?: number
}

const ToastContext = createContext<{ show: (message: string, opts?: ToastOptions) => void } | null>(null)

export function useToast() {
  const ctx = useContext(ToastContext)
  if (!ctx) throw new Error('useToast must be used within a ToastProvider')
  return ctx
}

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<ToastItem[]>([])
  const nextId = useRef(0)

  const show = useCallback((message: string, opts: ToastOptions = {}) => {
    const id = nextId.current++
    const variant = opts.variant ?? 'success'
    setToasts((prev) => [...prev, { id, message, variant, leaving: false }])

    // Match the vanilla timing: fade out at `duration`, unmount 320ms later.
    window.setTimeout(() => {
      setToasts((prev) => prev.map((t) => (t.id === id ? { ...t, leaving: true } : t)))
      window.setTimeout(() => {
        setToasts((prev) => prev.filter((t) => t.id !== id))
      }, 320)
    }, opts.duration ?? 2400)
  }, [])

  return (
    <ToastContext.Provider value={{ show }}>
      {children}
      <div className="fixed bottom-6 right-6 z-[200] flex flex-col gap-2">
        {toasts.map((t) => (
          <div
            key={t.id}
            className={`fade-in-up flex max-w-[360px] items-center gap-2.5 rounded-[var(--r-md)] bg-ink-primary px-4 py-2.5 text-base font-medium text-white shadow-[var(--shadow-lg)] transition-[opacity,transform] duration-[280ms] ease-out [&_svg]:h-4 [&_svg]:w-4 [&_svg]:shrink-0 ${
              t.leaving ? 'translate-y-2 opacity-0' : ''
            }`}
          >
            <Icon
              name={t.variant === 'success' ? 'checkCircle' : t.variant === 'error' ? 'alertTriangle' : 'info'}
              className={t.variant === 'success' ? 'text-status-success' : t.variant === 'error' ? 'text-status-danger' : ''}
            />
            <span>{t.message}</span>
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  )
}
