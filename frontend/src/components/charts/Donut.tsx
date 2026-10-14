import { useEffect, useState } from 'react'

// Ported from js/components/donut.js — small progress ring (e.g. score gauges).
export function Donut({
  value,
  size = 88,
  stroke = 8,
  track = 'rgba(255,255,255,0.08)',
  fill = 'var(--status-success)',
}: {
  value: number
  size?: number
  stroke?: number
  track?: string
  fill?: string
}) {
  const r = (size - stroke) / 2
  const c = 2 * Math.PI * r
  const clamped = Math.max(0, Math.min(100, value))

  // Two-phase mount so the ring animates in from 0 rather than snapping to value.
  const [rendered, setRendered] = useState(0)
  useEffect(() => {
    const raf = requestAnimationFrame(() => setRendered(clamped))
    return () => cancelAnimationFrame(raf)
  }, [clamped])

  return (
    <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`}>
      <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke={track} strokeWidth={stroke} />
      <circle
        cx={size / 2}
        cy={size / 2}
        r={r}
        fill="none"
        stroke={fill}
        strokeWidth={stroke}
        strokeLinecap="round"
        strokeDasharray={c}
        strokeDashoffset={c * (1 - rendered / 100)}
        transform={`rotate(-90 ${size / 2} ${size / 2})`}
        style={{ transition: 'stroke-dashoffset 1200ms cubic-bezier(0.16,1,0.3,1)' }}
      />
    </svg>
  )
}
