import { useEffect, useState } from 'react'
import { useChartWidth } from './useChartWidth'

// Ported from js/components/charts.js Charts.groupedBar
export function GroupedBar({
  labels,
  target,
  actual,
  height = 215,
}: {
  labels: string[]
  target: number[]
  actual: number[]
  height?: number
}) {
  const { ref, width: w } = useChartWidth(520)
  const [mounted, setMounted] = useState(false)
  useEffect(() => {
    const raf = requestAnimationFrame(() => setMounted(true))
    return () => cancelAnimationFrame(raf)
  }, [])

  const h = height
  const padL = 40,
    padR = 16,
    padT = 16,
    padB = 36
  const innerW = Math.max(1, w - padL - padR)
  const innerH = Math.max(1, h - padT - padB)
  const maxV = Math.max(...target, ...actual) * 1.15
  const groupW = innerW / labels.length
  const barW = groupW * 0.32
  const y = (v: number) => padT + innerH * (1 - v / maxV)

  const gridLines = [0, 0.5, 1, 1.5, 2].filter((v) => v <= maxV)
  const targetPath = labels
    .map((_, i) => {
      const cx = padL + i * groupW + groupW / 2
      return `${i === 0 ? 'M' : 'L'} ${cx} ${y(target[i])}`
    })
    .join(' ')

  return (
    <div ref={ref}>
      <svg viewBox={`0 0 ${w} ${h}`} width="100%" height={h} preserveAspectRatio="none">
        {gridLines.map((v) => (
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
              {v.toFixed(2)}
            </text>
          </g>
        ))}

        {labels.map((lab, i) => {
          const cx = padL + i * groupW + groupW / 2
          const yA = y(actual[i])
          const yT = y(target[i])
          const aBelow = actual[i] < target[i]
          const top = mounted ? y(maxV) : y(maxV)
          return (
            <g key={lab}>
              <rect
                x={cx - barW - 2}
                y={mounted ? yA : top}
                width={barW}
                height={mounted ? padT + innerH - yA : 0}
                rx={2}
                fill={aBelow ? '#EF4444' : '#10B981'}
                opacity={0.85}
                style={{
                  transition: `y 900ms cubic-bezier(0.16,1,0.3,1) ${i * 40}ms, height 900ms cubic-bezier(0.16,1,0.3,1) ${i * 40}ms`,
                }}
              />
              <rect
                x={cx + 2}
                y={mounted ? yT : top}
                width={barW}
                height={mounted ? padT + innerH - yT : 0}
                rx={2}
                fill="var(--brand-violet)"
                opacity={0.35}
                style={{
                  transition: `y 900ms cubic-bezier(0.16,1,0.3,1) ${i * 40 + 40}ms, height 900ms cubic-bezier(0.16,1,0.3,1) ${i * 40 + 40}ms`,
                }}
              />
              <text
                x={cx}
                y={padT + innerH + 18}
                textAnchor="middle"
                fontSize={11}
                fill="var(--text-secondary)"
                fontWeight={600}
              >
                {lab}
              </text>
              <text
                x={cx - barW / 2 - 2}
                y={yA - 6}
                textAnchor="middle"
                fontSize={11}
                fill={aBelow ? '#B91C1C' : '#047857'}
                fontWeight={700}
              >
                {actual[i].toFixed(2)}
              </text>
            </g>
          )
        })}

        <path d={targetPath} fill="none" stroke="var(--brand-violet)" strokeWidth={1.5} strokeDasharray="5 4" />
      </svg>
    </div>
  )
}
