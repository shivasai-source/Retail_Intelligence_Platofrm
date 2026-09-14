import { useEffect, useState } from 'react'

export interface DonutSegment {
  key: string
  pct: number
  color: string
  /** Already-formatted amount for this slice, shown beside the share when the
   *  caller has one. Optional so existing callers are unaffected. */
  value?: string
}

// Ported from js/components/charts.js Charts.donutBreakdown
export function DonutBreakdown({
  segments,
  size = 180,
  stroke = 28,
  centerValue,
  centerLabel,
  bars = false,
  decimals,
  className = '',
}: {
  segments: DonutSegment[]
  size?: number
  stroke?: number
  /** Draw each legend row's share as a thin bar beneath it, so the legend
   *  carries the proportion visually and fills the row's width rather than
   *  leaving it to the ring alone. Opt-in; existing callers are unchanged. */
  bars?: boolean
  /** Fixed decimals for the share label -- 1 keeps a 10.0% share from
   *  printing as "10%" beside its 44.7% neighbours. Unset prints the number
   *  as given, which is what integer-share callers rely on. */
  decimals?: number
  className?: string
  /** Rendered in the ring's hole, e.g. a total-spend figure (ported from the DOM-appended
   *  SVG <text> nodes in js/pages/command.js's renderCharts — an absolutely positioned
   *  div is simpler and equally faithful since the ring's center is always empty). */
  centerValue?: string
  centerLabel?: string
}) {
  const r = (size - stroke) / 2
  const cx = size / 2
  const cy = size / 2
  const c = 2 * Math.PI * r

  const [animated, setAnimated] = useState(false)
  useEffect(() => {
    const raf = requestAnimationFrame(() => setAnimated(true))
    return () => cancelAnimationFrame(raf)
  }, [])

  let cumulative = 0
  const arcs = segments.map((s, i) => {
    const len = c * (s.pct / 100)
    const rotateDeg = -90 + (cumulative / c) * 360
    cumulative += len
    return (
      <circle
        key={s.key}
        cx={cx}
        cy={cy}
        r={r}
        fill="none"
        stroke={s.color}
        strokeWidth={stroke}
        strokeLinecap="butt"
        strokeDasharray={animated ? `${len} ${c - len}` : `0 ${c}`}
        transform={`rotate(${rotateDeg} ${cx} ${cy})`}
        style={{ transition: `stroke-dasharray 1100ms cubic-bezier(0.16,1,0.3,1) ${i * 130}ms` }}
      />
    )
  })

  return (
    <div className={`flex flex-wrap items-center gap-6 ${className}`}>
      <div className="relative shrink-0" style={{ width: size, height: size }}>
        <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`}>
          {arcs}
        </svg>
        {(centerValue || centerLabel) && (
          <div className="pointer-events-none absolute inset-0 grid place-items-center">
            <div className="text-center">
              {centerValue && (
                <div className="text-lg font-extrabold text-ink-primary">{centerValue}</div>
              )}
              {centerLabel && <div className="mt-0.5 text-2xs font-semibold text-ink-muted">{centerLabel}</div>}
            </div>
          </div>
        )}
      </div>
      <div className={`flex min-w-0 flex-1 flex-col ${bars ? 'gap-5' : 'gap-1.5'}`}>
        {segments.map((s) => (
          <div key={s.key} title={s.key}>
            <div className="flex items-center gap-2 text-base">
              <span className="h-2.5 w-2.5 shrink-0 rounded-full" style={{ background: s.color }} />
              <span className="min-w-0 flex-1 truncate text-ink-secondary">{s.key}</span>
              <span className="shrink-0 font-semibold tabular-nums text-ink-primary">
                {decimals === undefined ? s.pct : s.pct.toFixed(decimals)}%
              </span>
              {s.value && (
                <span className="shrink-0 tabular-nums text-sm text-ink-muted">{s.value}</span>
              )}
            </div>
            {bars && (
              <div className="mt-1.5 ml-[18px] h-1 overflow-hidden rounded-full bg-surface-hover">
                <div
                  className="h-full rounded-full"
                  style={{
                    width: animated ? `${s.pct}%` : 0,
                    background: s.color,
                    transition: 'width 1100ms cubic-bezier(0.16,1,0.3,1) 200ms',
                  }}
                />
              </div>
            )}
          </div>
        ))}
      </div>
    </div>
  )
}
