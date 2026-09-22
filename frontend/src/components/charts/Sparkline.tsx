import { useId } from 'react'

// Ported from js/components/sparkline.js
export function Sparkline({
  values,
  width = 120,
  height = 36,
  color = 'var(--brand-violet)',
  fill = true,
}: {
  values: number[]
  width?: number
  height?: number
  color?: string
  fill?: boolean
}) {
  const gradId = useId()
  const min = Math.min(...values)
  const max = Math.max(...values)
  const range = max - min || 1
  const step = width / (values.length - 1)
  const pad = 2
  const usableH = height - pad * 2

  const pts = values.map((v, i) => {
    const x = i * step
    const y = pad + usableH * (1 - (v - min) / range)
    return [x, y] as const
  })

  const linePath = pts.map((p, i) => `${i === 0 ? 'M' : 'L'} ${p[0].toFixed(2)} ${p[1].toFixed(2)}`).join(' ')
  const fillPath = `${linePath} L ${width} ${height} L 0 ${height} Z`
  const last = pts[pts.length - 1]

  return (
    <svg
      viewBox={`0 0 ${width} ${height}`}
      width={width}
      height={height}
      preserveAspectRatio="none"
      style={{ overflow: 'visible' }}
    >
      <defs>
        <linearGradient id={gradId} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor={color} stopOpacity={0.3} />
          <stop offset="100%" stopColor={color} stopOpacity={0} />
        </linearGradient>
      </defs>
      {fill && <path d={fillPath} fill={`url(#${gradId})`} />}
      <path
        d={linePath}
        fill="none"
        stroke={color}
        strokeWidth={1.8}
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeDasharray={500}
        strokeDashoffset={500}
        style={{ animation: 'drawLine 1100ms var(--ease-out) forwards' }}
      />
      <circle
        cx={last[0]}
        cy={last[1]}
        r={2.5}
        fill={color}
        style={{ opacity: 0, animation: 'fadeIn 320ms ease 1100ms forwards' }}
      />
    </svg>
  )
}

// Demo-data helper, ported from Sparkline.fakeTrend — "noisy upward trend".
// Only used for placeholder/demo states, never in real data paths.
export function fakeTrend(n = 14, base = 50, amp = 18, drift = 1.5) {
  const out: number[] = []
  let cur = base
  for (let i = 0; i < n; i++) {
    cur += (Math.random() - 0.4) * amp * 0.3 + drift
    out.push(Math.max(0, cur))
  }
  return out
}
