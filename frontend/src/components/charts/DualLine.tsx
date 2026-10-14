import { useChartWidth } from './useChartWidth'

// Ported from js/components/charts.js Charts.dualLine
export function DualLine({
  weeks,
  spend,
  lift,
  height = 215,
}: {
  weeks: string[]
  spend: number[]
  lift: number[]
  height?: number
}) {
  const { ref, width: w } = useChartWidth(520)
  const h = height
  const padL = 36,
    padR = 16,
    padT = 12,
    padB = 30
  const innerW = Math.max(1, w - padL - padR)
  const innerH = Math.max(1, h - padT - padB)
  const maxV = Math.max(...spend, ...lift) * 1.1
  const step = innerW / (weeks.length - 1)
  const y = (v: number) => padT + innerH * (1 - v / maxV)
  const path = (vals: number[]) => vals.map((v, i) => `${i === 0 ? 'M' : 'L'} ${padL + i * step} ${y(v)}`).join(' ')
  const grid = [0, 25, 50, 75, 100].filter((v) => v <= maxV)

  const dots = (vals: number[], color: string, keyPrefix: string) =>
    vals.map((v, i) => (
      <circle
        key={`${keyPrefix}-${i}`}
        cx={padL + i * step}
        cy={y(v)}
        r={3}
        fill={color}
        style={{ opacity: 0, animation: `fadeIn 240ms ease ${600 + i * 60}ms forwards` }}
      />
    ))

  return (
    <div ref={ref}>
      <svg viewBox={`0 0 ${w} ${h}`} width="100%" height={h}>
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
            <text x={padL - 6} y={y(v) + 5} textAnchor="end" fontSize={15} fill="var(--text-muted)">
              {v}
            </text>
          </g>
        ))}
        <path
          d={path(spend)}
          fill="none"
          stroke="var(--brand-violet)"
          strokeWidth={2}
          strokeDasharray={800}
          strokeDashoffset={800}
          style={{ animation: 'drawLine 1200ms var(--ease-out) forwards' }}
        />
        <path
          d={path(lift)}
          fill="none"
          stroke="var(--status-success)"
          strokeWidth={2}
          strokeDasharray={800}
          strokeDashoffset={800}
          style={{ animation: 'drawLine 1200ms var(--ease-out) 200ms forwards' }}
        />
        {dots(spend, 'var(--brand-violet)', 'spend')}
        {dots(lift, 'var(--status-success)', 'lift')}
        {weeks.map((wk, i) => (
          <text
            key={wk}
            x={padL + i * step}
            y={padT + innerH + 20}
            textAnchor="middle"
            fontSize={15}
            fill="var(--text-muted)"
          >
            {wk}
          </text>
        ))}
      </svg>
    </div>
  )
}
