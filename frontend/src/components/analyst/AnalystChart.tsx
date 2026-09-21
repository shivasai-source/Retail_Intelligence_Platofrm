import { useMemo, useRef, useState } from 'react'
import { downloadCsv, downloadSvgPng, slugify } from './chartDownload'
import { seriesColor, seriesColors } from './chartPalette'

/** THE SHAPE THE BACKEND SENDS. One spec covers every chart the Analyst can
 *  draw; `type` selects the mark, and the data is always the same
 *  label/value pairs so the model cannot emit a chart the renderer has no
 *  geometry for.
 *
 *  TWO DATA SHAPES, not one. A single-metric chart carries `points`; a
 *  comparison chart (grouped/stacked) carries `labels` + `series`, because
 *  several metrics over the same categories is a different shape and
 *  flattening it into points would lose which value belongs to which metric.
 *  A scatter reuses `points` but adds `x`/`y` — its dots are positions, not
 *  magnitudes. */
export interface AnalystChartSpec {
  type: 'bar' | 'column' | 'line' | 'area' | 'pie' | 'donut' | 'grouped' | 'stacked' | 'histogram' | 'scatter'
  title?: string
  /** What the values measure — "Trade Spend (₹)". Names the single series, so
   *  a one-series chart needs no legend box. */
  unit?: string
  points: { label: string; value: number; display?: string; x?: number; y?: number }[]
  /** Comparison charts only: the categories, and one entry per metric. */
  labels?: string[]
  series?: { name: string; metric?: string; values: number[]; displays?: string[] }[]
  /** Set when a grouped chart's metrics have different units, so each series
   *  is scaled to its own maximum and bar lengths are NOT comparable across
   *  series. The chart says so on its face — see the footnote. */
  independent_scales?: boolean
  /** Axis names for the charts where the axes measure different things. */
  x_label?: string
  y_label?: string
  axis_label?: string
  /** Set when the tail was folded into an "Other" row, so the chart can say
   *  so rather than implying six groups are all of them. */
  truncated?: boolean
}

const fmtNumber = (n: number) =>
  Math.abs(n) >= 1e7 ? `${(n / 1e7).toFixed(1)} Cr`
  : Math.abs(n) >= 1e5 ? `${(n / 1e5).toFixed(1)} L`
  : Math.abs(n) >= 1e3 ? `${(n / 1e3).toFixed(1)}k`
  : `${Math.round(n * 100) / 100}`

/** The CSV behind whatever is on screen.
 *
 *  Built from the SPEC, not from the pixels: the file a reader opens holds the
 *  same figures the chart was drawn from, including the display strings the
 *  dashboard would print, so a number in the export can never disagree with
 *  the number on the page.
 */
function toCsv(spec: AnalystChartSpec) {
  if (spec.series?.length && spec.labels?.length) {
    return {
      headers: [spec.x_label ?? 'Group', ...spec.series.map((s) => s.name)],
      rows: spec.labels.map((label, i) => [
        label,
        ...spec.series!.map((s) => s.displays?.[i] ?? s.values[i] ?? ''),
      ]),
    }
  }
  if (spec.type === 'scatter') {
    return {
      headers: ['Group', spec.x_label ?? 'X', spec.y_label ?? 'Y'],
      rows: spec.points.map((p) => [p.label, p.x ?? '', p.y ?? '']),
    }
  }
  return {
    headers: [spec.type === 'histogram' ? (spec.axis_label ?? 'Range') : 'Group', spec.unit ?? 'Value'],
    rows: spec.points.map((p) => [p.label, p.display ?? p.value]),
  }
}

/** A chart the Analyst drew, in the drawer's width.
 *
 *  DESIGN NOTES, from the project's dataviz guidance:
 *   - ONE AXIS, never two scales on one plot — with the single exception of a
 *     grouped chart of mixed units, which says so on its face.
 *   - Categorical colour assigned in fixed order and never cycled; a single
 *     series wears one colour and is named by the title, so no legend box.
 *   - Marks are thin with 4px rounded data-ends anchored to the baseline, and
 *     a 2px surface gap separates adjacent fills.
 *   - Grid and axes are recessive; values are direct-labelled selectively
 *     rather than on every mark.
 *   - Every chart carries a hover layer AND a table view, so the figures are
 *     reachable without colour and without a pointer.
 *
 *  EVERY MARK IS SVG, including the bars. They were HTML divs, which read
 *  identically but cannot be rasterised — and a chart that cannot become a
 *  PNG cannot be downloaded as one.
 */
export function AnalystChart({ spec }: { spec: AnalystChartSpec }) {
  const [showTable, setShowTable] = useState(false)
  const [hover, setHover] = useState<number | null>(null)
  const [busy, setBusy] = useState(false)
  const svgRef = useRef<SVGSVGElement | null>(null)
  const colors = useMemo(() => seriesColors(), [])

  const points = spec.points ?? []
  const isMulti = Boolean(spec.series?.length && spec.labels?.length)
  if (!points.length && !isMulti) return null

  const values = points.map((p) => p.value)
  const max = Math.max(...values, 0)
  const min = Math.min(...values, 0)
  const label = (i: number) => points[i].display ?? fmtNumber(points[i].value)

  const savePng = async () => {
    if (!svgRef.current) return
    setBusy(true)
    try {
      // The card's own ground, so the PNG matches what the reader is looking
      // at rather than arriving on a white rectangle in dark mode.
      const bg = getComputedStyle(document.documentElement)
        .getPropertyValue('--surface-card')
        .trim() || '#ffffff'
      await downloadSvgPng(svgRef.current, slugify(spec.title), { background: bg })
    } catch {
      // A failed rasterisation must not take the conversation down with it;
      // the table view and the CSV are both still there.
    } finally {
      setBusy(false)
    }
  }

  const common = { colors, hover, setHover, svgRef }

  return (
    <figure className="my-2.5 rounded-[var(--r-md)] border border-border-subtle bg-surface-card p-3">
      <figcaption className="mb-2 flex items-start justify-between gap-2">
        <div className="min-w-0">
          {spec.title && (
            <div className="truncate text-[13px] font-bold text-ink-primary">{spec.title}</div>
          )}
          {spec.unit && <div className="truncate text-[11px] text-ink-muted">{spec.unit}</div>}
        </div>
        <div className="flex shrink-0 items-center gap-0.5">
          {/* THE TABLE VIEW is not a nicety: it is how the figures stay available
              to a screen reader, to a colour-blind reader, and in print. */}
          <ToolbarButton onClick={() => setShowTable((v) => !v)} pressed={showTable}>
            {showTable ? 'Chart' : 'Table'}
          </ToolbarButton>
          <ToolbarButton onClick={() => downloadCsv(toCsv(spec), slugify(spec.title))}>
            CSV
          </ToolbarButton>
          {/* PNG is offered only in chart view: there is no SVG to rasterise
              while the table is showing, and a button that silently does
              nothing is worse than one that is not there. */}
          {!showTable && (
            <ToolbarButton onClick={savePng} disabled={busy}>
              {busy ? '…' : 'PNG'}
            </ToolbarButton>
          )}
        </div>
      </figcaption>

      {showTable ? (
        <Table spec={spec} points={points} label={label} />
      ) : isMulti ? (
        <MultiSeries spec={spec} {...common} />
      ) : spec.type === 'scatter' ? (
        <Scatter spec={spec} points={points} color={colors[0]} {...common} />
      ) : spec.type === 'pie' || spec.type === 'donut' ? (
        <Pie points={points} colors={colors} label={label} hover={hover} setHover={setHover} svgRef={svgRef} />
      ) : spec.type === 'line' || spec.type === 'area' ? (
        <Line points={points} color={colors[0]} label={label} max={max} min={min} area={spec.type === 'area'} {...common} />
      ) : spec.type === 'column' || spec.type === 'histogram' ? (
        <Columns points={points} color={colors[0]} label={label} max={max} gap={spec.type === 'histogram' ? 1 : 3} {...common} />
      ) : (
        <Bars points={points} color={colors[0]} label={label} max={max} {...common} />
      )}

      {spec.type === 'histogram' && spec.axis_label && !showTable && (
        <p className="mt-1.5 text-center text-[10px] text-ink-muted">{spec.axis_label} →</p>
      )}
      {spec.independent_scales && !showTable && (
        <p className="mt-2 text-[11px] text-ink-disabled">
          Each series is scaled to its own maximum — compare a series across groups, not
          between series.
        </p>
      )}
      {spec.truncated && (
        <p className="mt-2 text-[11px] text-ink-disabled">
          Showing the largest groups; the rest are grouped as “Other”.
        </p>
      )}
    </figure>
  )
}

function ToolbarButton({
  onClick, children, pressed, disabled,
}: {
  onClick: () => void
  children: React.ReactNode
  pressed?: boolean
  disabled?: boolean
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={pressed}
      disabled={disabled}
      className="shrink-0 cursor-pointer rounded-[var(--r-sm)] px-1.5 py-0.5 text-[11px] font-semibold text-ink-muted transition-colors hover:bg-surface-hover hover:text-ink-primary focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-violet disabled:cursor-default disabled:opacity-50"
    >
      {children}
    </button>
  )
}

/** Shared props for every mark component. */
interface MarkProps {
  colors: readonly string[]
  hover: number | null
  setHover: (i: number | null) => void
  svgRef: React.MutableRefObject<SVGSVGElement | null>
}

/** A tooltip positioned over the plot. Rendered in HTML rather than SVG so it
 *  is never part of the rasterised PNG — a frozen tooltip in an exported
 *  picture reads as a rendering artefact. */
function Tip({ text, x, y }: { text: string; x: string; y: string }) {
  return (
    <div
      className="pointer-events-none absolute z-10 -translate-x-1/2 -translate-y-full whitespace-nowrap rounded-[var(--r-sm)] bg-ink-primary px-1.5 py-1 text-[10px] font-semibold text-surface-card shadow-[var(--shadow-lg)]"
      style={{ left: x, top: y }}
    >
      {text}
    </div>
  )
}

/* ---------------------------------------------------------------- bar (horizontal) */

const BAR_ROW = 26
const BAR_W = 320

/** HORIZONTAL BARS — the default for ranking named categories, because the
 *  labels read horizontally at any length. */
function Bars({
  points, color, label, max, hover, setHover, svgRef,
}: MarkProps & {
  points: AnalystChartSpec['points']
  color: string
  label: (i: number) => string
  max: number
}) {
  const H = points.length * BAR_ROW
  return (
    <svg
      ref={svgRef}
      viewBox={`0 0 ${BAR_W} ${H}`}
      width="100%"
      height={H}
      role="img"
      aria-label={`Bar chart with ${points.length} categories`}
    >
      {points.map((p, i) => {
        const w = max > 0 ? Math.max(1, (Math.max(0, p.value) / max) * BAR_W) : 1
        const y = i * BAR_ROW
        return (
          <g
            key={`${p.label}-${i}`}
            onMouseEnter={() => setHover(i)}
            onMouseLeave={() => setHover(null)}
            opacity={hover === null || hover === i ? 1 : 0.45}
          >
            {/* A transparent hit band, so hovering anywhere on the row works. */}
            <rect x="0" y={y} width={BAR_W} height={BAR_ROW} fill="transparent" />
            <text x="0" y={y + 9} fontSize="10" fill="var(--ink-secondary)">
              {p.label.length > 26 ? `${p.label.slice(0, 25)}…` : p.label}
            </text>
            {/* DIRECT LABELS on every row is right here and only here: the
                rows are few and the number IS the answer to the question. */}
            <text
              x={BAR_W}
              y={y + 9}
              fontSize="10"
              fontWeight="600"
              textAnchor="end"
              fill="var(--ink-primary)"
            >
              {label(i)}
            </text>
            <rect x="0" y={y + 14} width={BAR_W} height="6" rx="3" fill="var(--surface-hover)" />
            <rect x="0" y={y + 14} width={w} height="6" rx="3" fill={color} />
          </g>
        )
      })}
    </svg>
  )
}

/* ---------------------------------------------------------------- column (vertical) */

const COL_H = 132

/** VERTICAL COLUMNS — for an ordered sequence (months, weeks) where the
 *  reading is left-to-right, and for a histogram's bins, which are ordered by
 *  construction and touch to show they are a continuum. */
function Columns({
  points, color, label, max, gap, hover, setHover, svgRef,
}: MarkProps & {
  points: AnalystChartSpec['points']
  color: string
  label: (i: number) => string
  max: number
  gap: number
}) {
  const W = 320
  const labelH = 22
  const slot = W / points.length
  const barW = Math.max(1, slot - gap)

  return (
    <div className="relative">
      <svg
        ref={svgRef}
        viewBox={`0 0 ${W} ${COL_H + labelH}`}
        width="100%"
        height={COL_H + labelH}
        role="img"
        aria-label={`Column chart with ${points.length} bars`}
      >
        <line x1="0" y1={COL_H} x2={W} y2={COL_H} stroke="var(--border-subtle)" strokeWidth="1" />
        {points.map((p, i) => {
          const h = max > 0 ? Math.max(1, (Math.max(0, p.value) / max) * COL_H) : 1
          const x = i * slot + gap / 2
          return (
            <g
              key={`${p.label}-${i}`}
              onMouseEnter={() => setHover(i)}
              onMouseLeave={() => setHover(null)}
              opacity={hover === null || hover === i ? 1 : 0.45}
            >
              <rect x={x} y="0" width={barW} height={COL_H} fill="transparent" />
              {/* 4px rounded data-end, anchored to the baseline. */}
              <rect x={x} y={COL_H - h} width={barW} height={h} rx="3" fill={color} />
              <text
                x={x + barW / 2}
                y={COL_H + 11}
                fontSize="8"
                textAnchor="middle"
                fill="var(--ink-muted)"
              >
                {p.label.length > 10 ? `${p.label.slice(0, 9)}…` : p.label}
              </text>
            </g>
          )
        })}
      </svg>
      {hover !== null && points[hover] && (
        <Tip
          text={`${points[hover].label}: ${label(hover)}`}
          x={`${((hover + 0.5) / points.length) * 100}%`}
          y="0px"
        />
      )}
    </div>
  )
}

/* ---------------------------------------------------------------- line / area */

/** A LINE for change over time. One series, one scale — never two y-axes.
 *  AREA is the same geometry with the region beneath it filled, for when the
 *  accumulated volume rather than the path is the point. */
function Line({
  points, color, label, max, min, area, hover, setHover, svgRef,
}: MarkProps & {
  points: AnalystChartSpec['points']
  color: string
  label: (i: number) => string
  max: number
  min: number
  area: boolean
}) {
  const W = 320
  const H = 132
  const padY = 10
  const span = max - min || 1
  const x = (i: number) => (points.length === 1 ? W / 2 : (i / (points.length - 1)) * W)
  const y = (v: number) => padY + (1 - (v - min) / span) * (H - padY * 2)
  const path = points.map((p, i) => `${i === 0 ? 'M' : 'L'} ${x(i)} ${y(p.value)}`).join(' ')
  const baseY = y(Math.max(min, 0))
  const fill = `${path} L ${x(points.length - 1)} ${baseY} L ${x(0)} ${baseY} Z`

  return (
    <div className="relative">
      <svg
        ref={svgRef}
        viewBox={`0 0 ${W} ${H}`}
        width="100%"
        height={H}
        preserveAspectRatio="none"
        role="img"
        aria-label={`${area ? 'Area' : 'Line'} chart with ${points.length} points`}
      >
        {/* Recessive baseline. */}
        <line x1="0" y1={baseY} x2={W} y2={baseY} stroke="var(--border-subtle)" strokeWidth="1" vectorEffect="non-scaling-stroke" />
        {area && <path d={fill} fill={color} opacity="0.16" stroke="none" />}
        <path d={path} fill="none" stroke={color} strokeWidth="2" vectorEffect="non-scaling-stroke" strokeLinecap="round" strokeLinejoin="round" />
        {points.map((p, i) => (
          <circle
            key={i}
            cx={x(i)}
            cy={y(p.value)}
            r={hover === i ? 4.5 : 3}
            fill={color}
            // A 2px surface ring keeps overlapping markers legible.
            stroke="var(--surface-card)"
            strokeWidth="2"
            vectorEffect="non-scaling-stroke"
          />
        ))}
      </svg>
      {/* Hit targets bigger than the marks, laid over the plot. */}
      <div className="absolute inset-0 flex">
        {points.map((p, i) => (
          <div
            key={i}
            className="relative min-w-0 flex-1"
            onMouseEnter={() => setHover(i)}
            onMouseLeave={() => setHover(null)}
          >
            {hover === i && (
              <div className="pointer-events-none absolute left-1/2 top-0 z-10 -translate-x-1/2 whitespace-nowrap rounded-[var(--r-sm)] bg-ink-primary px-1.5 py-1 text-[10px] font-semibold text-surface-card shadow-[var(--shadow-lg)]">
                {p.label}: {label(i)}
              </div>
            )}
          </div>
        ))}
      </div>
      <div className="mt-1 flex">
        {points.map((p, i) => (
          <div key={i} className="min-w-0 flex-1 truncate text-center text-[9px] text-ink-muted" title={p.label}>
            {/* Only the ends and the hovered point are labelled — a label on
                every tick is noise at this width. */}
            {i === 0 || i === points.length - 1 || hover === i ? p.label : ''}
          </div>
        ))}
      </div>
    </div>
  )
}

/* ---------------------------------------------------------------- grouped / stacked */

/** SEVERAL METRICS over the same categories.
 *
 *  GROUPED puts the metrics side by side per category — the right shape when
 *  the reader is comparing metrics within a group. STACKED sums them into one
 *  column per category, which the backend only ever sends when the metrics are
 *  genuinely additive, because stacking non-additive series asserts a total
 *  that does not exist.
 *
 *  WHEN THE UNITS DIFFER (`independent_scales`), each series is normalised to
 *  its OWN maximum, so a 1.34 ROI is visible beside a figure in crore. That
 *  makes bar lengths comparable ACROSS groups but meaningless BETWEEN series —
 *  which the chart states in a footnote rather than leaving to be inferred.
 */
function MultiSeries({
  spec, colors, hover, setHover, svgRef,
}: MarkProps & { spec: AnalystChartSpec }) {
  const labels = spec.labels ?? []
  const series = spec.series ?? []
  const stacked = spec.type === 'stacked'
  const W = 320
  const H = 132
  const labelH = 22
  const slot = W / labels.length

  // One shared scale unless the units genuinely differ.
  const seriesMax = series.map((s) => Math.max(...s.values.map((v) => Math.max(0, v)), 0))
  const sharedMax = Math.max(...seriesMax, 0)
  const stackMax = Math.max(
    ...labels.map((_, i) => series.reduce((sum, s) => sum + Math.max(0, s.values[i] ?? 0), 0)),
    0,
  )
  const scaleFor = (si: number) =>
    stacked ? stackMax : spec.independent_scales ? seriesMax[si] || 1 : sharedMax || 1

  return (
    <div>
      {/* THE LEGEND IS ALWAYS PRESENT for a multi-series chart — identity is
          never colour alone, so each swatch is paired with its metric name. */}
      <div className="mb-1.5 flex flex-wrap gap-x-3 gap-y-1">
        {series.map((s, si) => (
          <span key={s.name} className="flex items-center gap-1 text-[10px] text-ink-secondary">
            <span
              className="h-2 w-2 shrink-0 rounded-[2px]"
              style={{ background: seriesColor(si, colors) }}
            />
            {s.name}
          </span>
        ))}
      </div>
      <div className="relative">
        <svg
          ref={svgRef}
          viewBox={`0 0 ${W} ${H + labelH}`}
          width="100%"
          height={H + labelH}
          role="img"
          aria-label={`${stacked ? 'Stacked' : 'Grouped'} bar chart, ${series.length} series over ${labels.length} groups`}
        >
          <line x1="0" y1={H} x2={W} y2={H} stroke="var(--border-subtle)" strokeWidth="1" />
          {labels.map((name, i) => {
            const gx = i * slot
            const inner = slot - 4
            const barW = stacked ? inner : Math.max(1, inner / series.length - 1)
            let stackY = H
            return (
              <g
                key={`${name}-${i}`}
                onMouseEnter={() => setHover(i)}
                onMouseLeave={() => setHover(null)}
                opacity={hover === null || hover === i ? 1 : 0.45}
              >
                <rect x={gx} y="0" width={slot} height={H} fill="transparent" />
                {series.map((s, si) => {
                  const v = Math.max(0, s.values[i] ?? 0)
                  const h = Math.max(1, (v / scaleFor(si)) * (H - 4))
                  const x = stacked ? gx + 2 : gx + 2 + si * (barW + 1)
                  const y = stacked ? (stackY -= h) : H - h
                  return (
                    <rect
                      key={s.name}
                      x={x}
                      y={y}
                      width={barW}
                      height={h}
                      rx={stacked ? 0 : 2}
                      fill={seriesColor(si, colors)}
                    />
                  )
                })}
                <text
                  x={gx + slot / 2}
                  y={H + 11}
                  fontSize="8"
                  textAnchor="middle"
                  fill="var(--ink-muted)"
                >
                  {name.length > 10 ? `${name.slice(0, 9)}…` : name}
                </text>
              </g>
            )
          })}
        </svg>
        {hover !== null && labels[hover] && (
          <div
            className="pointer-events-none absolute z-10 -translate-x-1/2 -translate-y-full whitespace-nowrap rounded-[var(--r-sm)] bg-ink-primary px-1.5 py-1 text-[10px] text-surface-card shadow-[var(--shadow-lg)]"
            style={{ left: `${((hover + 0.5) / labels.length) * 100}%`, top: '0px' }}
          >
            <span className="font-semibold">{labels[hover]}</span>
            {series.map((s, si) => (
              <span key={s.name} className="ml-1.5">
                {s.name.split('(')[0].trim()}: {s.displays?.[hover] ?? fmtNumber(s.values[hover] ?? 0)}
                {si < series.length - 1 ? ' ·' : ''}
              </span>
            ))}
          </div>
        )}
      </div>
    </div>
  )
}

/* ---------------------------------------------------------------- scatter */

/** TWO METRICS AGAINST EACH OTHER, one dot per group.
 *
 *  The only chart here whose position encodes two variables rather than one
 *  magnitude. It shows whether spend and return move together — a PATTERN,
 *  which the prompt is careful to keep the model from narrating as a cause.
 */
function Scatter({
  spec, points, color, hover, setHover, svgRef,
}: MarkProps & {
  spec: AnalystChartSpec
  points: AnalystChartSpec['points']
  color: string
}) {
  const W = 320
  const H = 150
  const pad = { l: 8, r: 8, t: 10, b: 20 }
  const xs = points.map((p) => p.x ?? 0)
  const ys = points.map((p) => p.y ?? 0)
  // The axes include zero so a cloud of similar values is not magnified into
  // a spurious spread by an auto-zoomed origin.
  const xMin = Math.min(0, ...xs)
  const xMax = Math.max(...xs, 0) || 1
  const yMin = Math.min(0, ...ys)
  const yMax = Math.max(...ys, 0) || 1
  const px = (v: number) => pad.l + ((v - xMin) / (xMax - xMin || 1)) * (W - pad.l - pad.r)
  const py = (v: number) => H - pad.b - ((v - yMin) / (yMax - yMin || 1)) * (H - pad.t - pad.b)

  return (
    <div className="relative">
      <svg
        ref={svgRef}
        viewBox={`0 0 ${W} ${H}`}
        width="100%"
        height={H}
        role="img"
        aria-label={`Scatter plot of ${points.length} groups`}
      >
        <line x1={pad.l} y1={H - pad.b} x2={W - pad.r} y2={H - pad.b} stroke="var(--border-subtle)" strokeWidth="1" />
        <line x1={pad.l} y1={pad.t} x2={pad.l} y2={H - pad.b} stroke="var(--border-subtle)" strokeWidth="1" />
        {points.map((p, i) => (
          <circle
            key={`${p.label}-${i}`}
            cx={px(p.x ?? 0)}
            cy={py(p.y ?? 0)}
            r={hover === i ? 5 : 3.5}
            fill={color}
            // Dots overlap in any real scatter; a surface ring keeps two
            // neighbouring groups from reading as one blob.
            stroke="var(--surface-card)"
            strokeWidth="1.5"
            opacity={hover === null || hover === i ? 0.85 : 0.35}
            onMouseEnter={() => setHover(i)}
            onMouseLeave={() => setHover(null)}
          />
        ))}
        <text x={W - pad.r} y={H - 4} fontSize="8" textAnchor="end" fill="var(--ink-muted)">
          {spec.x_label} →
        </text>
      </svg>
      {hover !== null && points[hover] && (
        <Tip
          text={`${points[hover].label}: ${points[hover].display ?? ''}`}
          x={`${(px(points[hover].x ?? 0) / W) * 100}%`}
          y={`${py(points[hover].y ?? 0) - 6}px`}
        />
      )}
    </div>
  )
}

/* ---------------------------------------------------------------- pie / donut */

/** A DONUT for composition. Only ever drawn when the parts genuinely sum to a
 *  whole — the backend refuses to build one for Incremental Sales, whose
 *  groups are a ranking rather than a composition. */
function Pie({
  points, colors, label, hover, setHover, svgRef,
}: {
  points: AnalystChartSpec['points']
  colors: readonly string[]
  label: (i: number) => string
  hover: number | null
  setHover: (i: number | null) => void
  svgRef: React.MutableRefObject<SVGSVGElement | null>
}) {
  const total = points.reduce((s, p) => s + Math.max(0, p.value), 0)
  if (total <= 0) return null
  const R = 54
  const C = 2 * Math.PI * R
  let offset = 0

  return (
    <div className="flex items-center gap-3">
      <svg ref={svgRef} viewBox="0 0 140 140" width="118" height="118" className="shrink-0" role="img" aria-label="Donut chart">
        <g transform="translate(70,70) rotate(-90)">
          {points.map((p, i) => {
            const frac = Math.max(0, p.value) / total
            // A 2px surface gap between segments, so neighbouring fills read
            // as separate slices rather than one continuous band.
            const dash = `${Math.max(0, frac * C - 2)} ${C - Math.max(0, frac * C - 2)}`
            const el = (
              <circle
                key={i}
                r={R}
                fill="none"
                stroke={colors[Math.min(i, colors.length - 1)]}
                strokeWidth={hover === i ? 26 : 22}
                strokeDasharray={dash}
                strokeDashoffset={-offset}
                opacity={hover === null || hover === i ? 1 : 0.45}
                onMouseEnter={() => setHover(i)}
                onMouseLeave={() => setHover(null)}
                style={{ transition: 'stroke-width 150ms, opacity 150ms' }}
              />
            )
            offset += frac * C
            return el
          })}
        </g>
      </svg>
      {/* THE LEGEND IS ALWAYS PRESENT for a multi-series chart, and carries the
          share as text — identity is never colour alone. */}
      <div className="min-w-0 flex-1 space-y-1">
        {points.map((p, i) => (
          <div
            key={i}
            className="flex items-baseline gap-1.5 text-[11px]"
            onMouseEnter={() => setHover(i)}
            onMouseLeave={() => setHover(null)}
          >
            <span
              className="mt-[3px] h-2 w-2 shrink-0 rounded-[2px]"
              style={{ background: colors[Math.min(i, colors.length - 1)] }}
            />
            <span className="min-w-0 flex-1 truncate text-ink-secondary" title={p.label}>
              {p.label}
            </span>
            {/* The share AND the amount: a percentage alone makes the reader
                ask "of what?", and the figure is what they came for. */}
            <span className="shrink-0 tabular-nums text-ink-muted">{label(i)}</span>
            <span className="shrink-0 font-semibold tabular-nums text-ink-primary">
              {((Math.max(0, p.value) / total) * 100).toFixed(1)}%
            </span>
          </div>
        ))}
      </div>
    </div>
  )
}

/* ---------------------------------------------------------------- table view */

function Table({
  spec, points, label,
}: {
  spec: AnalystChartSpec
  points: AnalystChartSpec['points']
  label: (i: number) => string
}) {
  // A comparison chart's table has one column per metric — collapsing it to a
  // single value column would hide the very thing the chart was drawn to show.
  if (spec.series?.length && spec.labels?.length) {
    return (
      <div className="max-h-[220px] overflow-y-auto">
        <table className="w-full border-collapse text-[11px]">
          <thead>
            <tr className="border-b border-border-subtle">
              <th className="py-1 pr-2 text-left font-semibold text-ink-muted">Group</th>
              {spec.series.map((s) => (
                <th key={s.name} className="py-1 text-right font-semibold text-ink-muted">
                  {s.name.split('(')[0].trim()}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {spec.labels.map((name, i) => (
              <tr key={name} className="border-b border-border-subtle last:border-0">
                <td className="py-1 pr-2 text-ink-secondary">{name}</td>
                {spec.series!.map((s) => (
                  <td key={s.name} className="py-1 text-right font-semibold tabular-nums text-ink-primary">
                    {s.displays?.[i] ?? fmtNumber(s.values[i] ?? 0)}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    )
  }

  return (
    <div className="max-h-[220px] overflow-y-auto">
      <table className="w-full border-collapse text-[11px]">
        <tbody>
          {points.map((p, i) => (
            <tr key={i} className="border-b border-border-subtle last:border-0">
              <td className="py-1 pr-2 text-ink-secondary">{p.label}</td>
              <td className="py-1 text-right font-semibold tabular-nums text-ink-primary">{label(i)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}
