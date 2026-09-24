import type { ReactNode } from 'react'

// Ported from css/components.css .pill / .pill-*.
//
// The four status inks were literal hexes here, carried over from the vanilla
// app "for exact fidelity". They are `--pill-*-ink` tokens now, because a hex
// cannot follow the theme: on a dark card the pill's background becomes a
// low-alpha wash and the near-black light-mode green measured 3.12:1 on it, so
// every Live/Roadmap/status chip in the product failed AA in dark mode. The
// LIGHT values are unchanged to the byte — see tokens.css for what each one is
// measured against.
export type PillTone = 'success' | 'warning' | 'danger' | 'info' | 'neutral' | 'violet'

const tones: Record<PillTone, string> = {
  success: 'bg-status-success-bg text-[var(--pill-success-ink)]',
  warning: 'bg-status-warning-bg text-[var(--pill-warning-ink)]',
  danger: 'bg-status-danger-bg text-[var(--pill-danger-ink)]',
  info: 'bg-status-info-bg text-[var(--pill-info-ink)]',
  neutral: 'bg-surface-muted text-ink-secondary',
  violet: 'bg-brand-violet-50 text-[var(--pill-violet-ink)]',
}

/** `sm` is the app's dense default — a chip inside a KPI card or a table row.
 *  `md` is for the surfaces with no density pressure (the portal), where an
 *  11px chip beside an 18px title reads as an afterthought. */
export type PillSize = 'sm' | 'md'

const sizes: Record<PillSize, string> = {
  sm: 'h-[22px] px-2.5 text-xs',
  md: 'h-7 px-3 text-sm',
}

export interface PillProps {
  tone?: PillTone
  size?: PillSize
  dot?: boolean
  pulse?: boolean
  children: ReactNode
  className?: string
}

export function Pill({ tone = 'neutral', size = 'sm', dot, pulse, children, className = '' }: PillProps) {
  return (
    <span
      className={`inline-flex items-center gap-1.5 rounded-[var(--r-pill)] font-semibold tracking-[0.01em] ${sizes[size]} ${tones[tone]} ${className}`}
    >
      {dot && (
        <span
          className={`h-1.5 w-1.5 rounded-full bg-current ${pulse ? 'animate-[pulseDot_1.4s_ease-in-out_infinite]' : ''}`}
        />
      )}
      {children}
    </span>
  )
}
