import { useEffect, useState } from 'react'
import { useChartWidth } from './useChartWidth'

export interface ComboBarSpec {
  values: number[]
  color: string
  label?: string
}

export interface ComboLineSpec {
  values: number[]
  color: string
  dashed?: boolean
  label?: string
  axis: 'left' | 'right'
}

// Ported from js/components/charts.js Charts.comboBarLine — dual-axis bars + lines
// (Insights Hub trend chart).
export function ComboBarLine({
  labels,
  bars,
  lines,
  height = 290,
}: {
  labels: string[]
  bars: ComboBarSpec
  lines: ComboLineSpec[]
  height?: number
}) {
  const { ref, width: w } = useChartWidth(720)
  const [mounted, setMounted] = useState(false)
  useEffect(() => {
    const raf = requestAnimationFrame(() => setMounted(true))
    return () => cancelAnimationFrame(raf)
  }, [])

  const h = height
  const padL = 44,
    padR = 50,
    padT = 24,
    padB = 36
  const innerW = Math.max(1, w - padL - padR)
  const innerH = Math.max(1, h - padT - padB)

  const leftLines = lines.filter((l) => l.axis === 'left')
  const rightLines = lines.filter((l) => l.axis === 'right')
  const leftMax = Math.max(...leftLines.flatMap((l) => l.values), 2.5)
  const rightMax = Math.max(...rightLines.flatMap((l) => l.values), ...bars.values, 100)
  const step = innerW / (labels.length - 1)

  const yL = (v: number) => padT + innerH * (1 - v / leftMax)
  const yR = (v: number) => padT + innerH * (1 - v / rightMax)

  const leftTicks = [0, 0.5, 1, 1.5, 2, 2.5].filter((v) => v <= leftMax)
  const rightTicks = [0, Math.round(rightMax * 0.25), Math.round(rightMax * 0.5), Math.round(rightMax * 0.75), Math.round(rightMax)]

  const barW = (innerW / labels.length) * 0.32
  const linePath = (vals: number[], fn: (v: number) => number) =>
    vals.map((v, i) => `${i === 0 ? 'M' : 'L'} ${padL + i * step} ${fn(v)}`).join(' ')

  return (
    <div ref={ref}>
      <svg viewBox={`0 0 ${w} ${h}`} width="100%" height={h} preserveAspectRatio="none">
        {leftTicks.map((v) => (
          <g key={v}>
            <line
              x1={padL}
              y1={yL(v)}
              x2={padL + innerW}
              y2={yL(v)}
              stroke="var(--border-subtle)"
              strokeDasharray="3 4"
            />
            <text x={padL - 6} y={yL(v) + 5} textAnchor="end" fontSize={15} fill="var(--text-muted)">
              {v.toFixed(2)}
            </text>
          </g>
        ))}
        {rightTicks.map((v) => (
          <text key={v} x={padL + innerW + 6} y={yR(v) + 5} textAnchor="start" fontSize={15} fill="var(--text-muted)">
            {v}
          </text>
        ))}
        <text x={2} y={padT - 8} fontSize={15} fill="var(--text-muted)" fontWeight={500}>
          ROI
        </text>
        <text x={w - 2} y={padT - 8} textAnchor="end" fontSize={15} fill="var(--text-muted)" fontWeight={500}>
          Amount (Cr)
        </text>

        {labels.map((_, i) => {
          const x = padL + i * step - barW / 2
          const v = bars.values[i]
          const yTop = yR(v)
          const hgt = padT + innerH - yTop
          return (
            <rect
              key={i}
              x={x.toFixed(2)}
              y={mounted ? yTop : padT + innerH}
              width={barW.toFixed(2)}
              height={mounted ? hgt : 0}
              rx={2}
              fill={bars.color}
              opacity={0.65}
              style={{
                transition: `y 800ms cubic-bezier(0.16,1,0.3,1) ${i * 50}ms, height 800ms cubic-bezier(0.16,1,0.3,1) ${i * 50}ms`,
              }}
            />
          )
        })}

        {lines.map((l, idx) => {
          const fn = l.axis === 'left' ? yL : yR
          return (
            <g key={idx}>
              <path
                d={linePath(l.values, fn)}
                fill="none"
                stroke={l.color}
                strokeWidth={2.2}
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeDasharray={l.dashed ? '6 4' : 800}
                strokeDashoffset={l.dashed ? 0 : 800}
                style={l.dashed ? undefined : { animation: `drawLine 1100ms var(--ease-out) ${idx * 150}ms forwards` }}
              />
              {!l.dashed &&
                l.values.map((v, i) => (
                  <circle
                    key={i}
                    cx={padL + i * step}
                    cy={fn(v).toFixed(2)}
                    r={3}
                    fill={l.color}
                    stroke="white"
                    strokeWidth={1.5}
                    style={{ opacity: 0, animation: `fadeIn 240ms ease ${500 + i * 50 + idx * 100}ms forwards` }}
                  />
                ))}
            </g>
          )
        })}

        {labels.map((lab, i) => (
          <text
            key={lab}
            x={padL + i * step}
            y={padT + innerH + 20}
            textAnchor="middle"
            fontSize={15}
            fill="var(--text-muted)"
          >
            {lab}
          </text>
        ))}
      </svg>
    </div>
  )
}
