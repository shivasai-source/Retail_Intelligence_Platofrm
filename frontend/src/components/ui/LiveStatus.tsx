import { useEffect, useState } from 'react'
import { create } from 'zustand'

// Ported from js/components/ui.js UI.mountLiveStatus + css/tpo.css .live-status/.live-dot.
//
// ONE clock, not one per page. The pill is rendered once, in the Topbar's
// right-hand corner (components/layout/Topbar.tsx), so a page that refreshes
// its data and calls `reset()` has to reach the same "since" the Topbar reads.
// It used to sit inline beside each page title, which put it at a different
// x-position on every page; the Topbar is the one place that is the same
// everywhere.
const useLiveClock = create<{ since: number; reset: () => void }>((set) => ({
  since: Date.now(),
  reset: () => set({ since: Date.now() }),
}))

// `reset()` is called after a refresh/filter change to restart the "just now" clock.
export function useLiveStatus() {
  const since = useLiveClock((s) => s.since)
  const reset = useLiveClock((s) => s.reset)
  const [now, setNow] = useState(() => Date.now())

  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 4000)
    return () => window.clearInterval(timer)
  }, [])

  // `now` can lag `since` by up to one tick right after a reset; never negative.
  const elapsed = Math.max(0, Math.floor((now - since) / 1000))
  const label = elapsed < 60 ? `${elapsed}s ago` : `${Math.floor(elapsed / 60)} min ago`
  return { label, reset }
}

export function LiveStatus({ label, className = '' }: { label: string; className?: string }) {
  return (
    <span
      className={`inline-flex items-center gap-1.5 rounded-[var(--r-pill)] border border-border-subtle bg-surface-card px-3 py-1 text-sm text-ink-secondary ${className}`}
    >
      <span className="inline-block h-[7px] w-[7px] animate-[liveDot_1.4s_infinite] rounded-full bg-status-success" />
      <span>
        <strong className="font-bold text-status-success">Live</strong> · refreshed {label}
      </span>
    </span>
  )
}
