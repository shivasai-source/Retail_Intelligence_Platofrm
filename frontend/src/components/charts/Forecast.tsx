import { useChartWidth } from './useChartWidth'

export interface ForecastBand {
  upper: number[]
  lower: number[]
}

// Ported from js/components/charts.js Charts.forecast (entrance-animation variant).
// The original also had a `createForecast` stateful controller that tweens between
// datasets on `.update()`; here a prop change simply re-renders with the new path,
// which covers every current call site (initial mount is the only transition that
// needs to look good) — see DEV.md if a tweened transition is needed later.
export function Forecast({
  weeks,
  baseline,
  current,
  optimized,
  band,
  height = 250,
}: {
  weeks: string[]
  baseline: number[]
  current: number[]
  optimized: number[]
  band: ForecastBand
  height?: number
}) {
  const { ref, width: w } = useChartWidth(720)
  const h = height
  const padL = 36,
    padR = 16,
    padT = 28,
    padB = 36
  const innerW = Math.max(1, w - padL - padR)
  const innerH = Math.max(1, h - padT - padB)
  const maxV = Math.max(...current, ...optimized, ...baseline, ...band.upper) * 1.15
  const step = innerW / (weeks.length - 1)
  const y = (v: number) => padT + innerH * (1 - v / maxV)

  const grid = [0, 10, 20, 30, 40].filter((v) => v <= maxV)
  const line = (vals: number[]) => vals.map((v, i) => `${i === 0 ? 'M' : 'L'} ${padL + i * step} ${y(v)}`).join(' ')
  const bandPath =
    'M ' +
    padL +
    ' ' +
    y(band.upper[0]) +
    ' ' +
    band.upper.map((v, i) => `L ${padL + i * step} ${y(v)}`).join(' ') +
    band.lower
      .slice()
      .reverse()
      .map((v, i, arr) => `L ${padL + (arr.length - 1 - i) * step} ${y(v)}`)
      .join(' ') +
    ' Z'

  const dots = (vals: number[], color: string, keyPrefix: string) =>
    vals.map((v, i) => (
      <circle
        key={`${keyPrefix}-${i}`}
        cx={padL + i * step}
        cy={y(v)}
        r={3}
        fill={color}
        style={{ opacity: 0, animation: `fadeIn 240ms ease ${500 + i * 50}ms forwards` }}
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
            <text x={padL - 6} y={y(v) + 3} textAnchor="end" fontSize={10} fill="var(--text-muted)">
              {v}
            </text>
          </g>
        ))}
        <path
          d={bandPath}
          fill="rgba(16, 185, 129, 0.14)"
          stroke="none"
          style={{ opacity: 0, animation: 'fadeIn 600ms ease 600ms forwards' }}
        />
        <path
          d={line(baseline)}
          fill="none"
          stroke="var(--text-muted)"
          strokeWidth={1.8}
          strokeDasharray="5 4"
          strokeDashoffset={800}
          style={{ animation: 'drawLine 1100ms var(--ease-out) forwards' }}
        />
        <path
          d={line(current)}
          fill="none"
          stroke="var(--brand-blue)"
          strokeWidth={2.2}
          strokeDasharray={800}
          strokeDashoffset={800}
          style={{ animation: 'drawLine 1100ms var(--ease-out) 200ms forwards' }}
        />
        <path
          d={line(optimized)}
          fill="none"
          stroke="var(--status-success)"
          strokeWidth={2.4}
          strokeDasharray="6 4"
          strokeDashoffset={800}
          style={{ animation: 'drawLine 1100ms var(--ease-out) 400ms forwards' }}
        />
        {dots(current, 'var(--brand-blue)', 'current')}
        {dots(optimized, 'var(--status-success)', 'optimized')}
        {weeks.map((wk, i) => (
          <text
            key={wk}
            x={padL + i * step}
            y={padT + innerH + 18}
            textAnchor="middle"
            fontSize={10}
            fill="var(--text-muted)"
          >
            {wk}
          </text>
        ))}
      </svg>
    </div>
  )
}
