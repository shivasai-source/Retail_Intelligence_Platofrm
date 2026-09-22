import { useEffect, useState } from 'react'
import { useChartWidth } from './useChartWidth'

export interface WaterfallItem {
  label: string
  value: number
  type: 'positive' | 'negative' | 'total' | 'base'
}

const PALETTE: Record<WaterfallItem['type'], string> = {
  positive: '#10B981',
  negative: '#EF4444',
  total: '#1F2937',
  base: '#94A3B8',
}

// Ported from js/components/charts.js Charts.waterfall / Charts.createWaterfall — merged
// into one prop-driven component; React re-renders on `items` change take the place of
// the original's imperative `.update()` controller.
export function Waterfall({
  items,
  height = 250,
  fixedMax,
}: {
  items: WaterfallItem[]
  height?: number
  fixedMax?: number
}) {
  const { ref, width: w } = useChartWidth(720)
  const [mounted, setMounted] = useState(false)
  useEffect(() => {
    const raf = requestAnimationFrame(() => setMounted(true))
    return () => cancelAnimationFrame(raf)
  }, [])

  const h = height
  const padL = 32,
    padR = 16,
    padT = 28,
    padB = 70
  const innerW = Math.max(1, w - padL - padR)
  const innerH = Math.max(1, h - padT - padB)

  let cum = 0
  const bars = items.map((it) => {
    const isBaseOrTotal = it.type === 'total' || it.type === 'base'
    const start = isBaseOrTotal ? 0 : cum
    const end = isBaseOrTotal ? it.value : cum + it.value
    if (it.type === 'base') cum = it.value
    else if (it.type !== 'total') cum += it.value
    return { ...it, start, end, top: Math.max(start, end), bot: Math.min(start, end) }
  })
  const maxTop = fixedMax ?? Math.max(...bars.map((b) => b.top)) * 1.15
  const groupW = innerW / bars.length
  const barW = groupW * 0.55
  const y = (v: number) => padT + innerH * (1 - v / maxTop)

  const grid = [0, 10, 20, 30, 40].filter((v) => v <= maxTop)

  return (
    <div ref={ref}>
      <svg viewBox={`0 0 ${w} ${h}`} width="100%" height={h} preserveAspectRatio="none">
        {grid.map((v) => (
          <g key={v}>
            <line
              x1={padL}
              y1={y(v)}
              x2={padL + innerW}
              y2={y(v)}
              stroke="var(--border-subtle)"
              strokeDasharray="3 4"
            />
            <text x={padL - 8} y={y(v) + 3} textAnchor="end" fontSize={10} fill="var(--text-muted)">
              {v}
            </text>
          </g>
        ))}

        {bars.map((b, i) => {
          const cx = padL + i * groupW + groupW / 2
          const xL = cx - barW / 2
          const yTop = y(b.top)
          const hgt = Math.max(2, y(b.bot) - y(b.top))
          const color = PALETTE[b.type] || '#94A3B8'
          const valLabel = b.value.toFixed(2)
          const next = bars[i + 1]

          const words = b.label.split(' ')
          let line1 = b.label
          let line2 = ''
          if (b.label.length > 12 && words.length > 1) {
            const mid = Math.ceil(words.length / 2)
            line1 = words.slice(0, mid).join(' ')
            line2 = words.slice(mid).join(' ')
          }

          return (
            <g key={b.label + i}>
              <rect
                x={xL}
                y={mounted ? yTop : y(maxTop)}
                width={barW}
                height={mounted ? hgt : 0}
                rx={2}
                fill={color}
                opacity={0.92}
                style={{
                  transition: `y 800ms cubic-bezier(0.16,1,0.3,1) ${i * 80}ms, height 800ms cubic-bezier(0.16,1,0.3,1) ${i * 80}ms`,
                }}
              />
              <text
                x={cx}
                y={yTop - 6}
                textAnchor="middle"
                fontSize={12}
                fontWeight={800}
                fill={b.type === 'negative' ? '#B91C1C' : b.type === 'total' ? '#1F2937' : b.type === 'base' ? '#475569' : '#047857'}
              >
                {valLabel}
              </text>
              {next && (
                <line
                  x1={xL + barW}
                  y1={y(b.end)}
                  x2={cx + groupW - barW / 2}
                  y2={y(b.end)}
                  stroke="var(--border-strong)"
                  strokeDasharray="2 3"
                />
              )}
              <text
                x={cx}
                y={padT + innerH + 18}
                textAnchor="middle"
                fontSize={10}
                fill="var(--text-secondary)"
                fontWeight={600}
              >
                {line1}
              </text>
              {line2 && (
                <text
                  x={cx}
                  y={padT + innerH + 30}
                  textAnchor="middle"
                  fontSize={10}
                  fill="var(--text-secondary)"
                  fontWeight={600}
                >
                  {line2}
                </text>
              )}
            </g>
          )
        })}
      </svg>
    </div>
  )
}
