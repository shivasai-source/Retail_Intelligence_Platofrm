import { useLayoutEffect, useMemo, useRef, useState } from 'react'
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
  /** A horizontal line the bars are read against — the ROI target.
   *
   *  WHY A RATIO NEEDS ONE. A bar chart must start at zero or its lengths
   *  lie, and ROI across a dashboard's groups is typically 1.4 to 1.9 — so
   *  every bar is between 74% and 100% of the longest and the chart says
   *  almost nothing. The reference line is what makes it readable without
   *  making it dishonest: the eye reads each bar against break-even or the
   *  target rather than against the leader. */
  reference?: { value: number; label: string }
}

const fmtNumber = (n: number) =>
  Math.abs(n) >= 1e7 ? `${(n / 1e7).toFixed(2)} Cr`
  : Math.abs(n) >= 1e5 ? `${(n / 1e5).toFixed(2)} L`
  : Math.abs(n) >= 1e3 ? `${(n / 1e3).toFixed(2)}k`
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
export function AnalystChart({
  spec,
  plain = false,
}: {
  spec: AnalystChartSpec
  /** Drawn INSIDE a dashboard card, which already has a border and a heading:
   *  the figure drops its own frame and title so the panel is not two nested
   *  boxes with the same name at the top of each. The toolbar stays — Table,
   *  CSV and PNG are as useful on the page as they are in the chat. */
  plain?: boolean
}) {
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
    <figure
      className={
        plain
          ? 'm-0'
          : 'my-2.5 rounded-[var(--r-md)] border border-border-subtle bg-surface-card p-3'
      }
    >
      <figcaption className="mb-2 flex items-start justify-between gap-2">
        <div className="min-w-0">
          {/* THE TITLE IS NOT TRUNCATED TO ONE LINE any more. "Incremental
              Sales (₹) by channel" came out as "Incremental Sales (₹) by
              cha…", which tells the reader less than nothing: the chart is
              about something, and they cannot see what. Two lines is enough
              for every title the builder produces, and the toolbar beside it
              no longer squeezes them. */}
          {spec.title && !plain && (
            <div className="line-clamp-2 text-sm font-medium leading-snug text-ink-primary">
              {spec.title}
            </div>
          )}
          {/* The unit, UNLESS the title already says it. A chart headed
              "Incremental Sales (₹) by channel" with "Incremental Sales (₹)"
              underneath spends a line repeating itself. */}
          {spec.unit && !(spec.title && !plain && spec.title.includes(spec.unit)) && (
            <div className="truncate text-xs text-ink-muted">{spec.unit}</div>
          )}
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
        <Columns
          points={points}
          color={colors[0]}
          label={label}
          max={max}
          gap={spec.type === 'histogram' ? 1 : 8}
          reference={spec.reference}
          {...common}
        />
      ) : (
        <Bars points={points} color={colors[0]} label={label} max={max} reference={spec.reference} {...common} />
      )}

      {spec.type === 'histogram' && spec.axis_label && !showTable && (
        <p className="mt-1.5 text-center text-2xs text-ink-muted">{spec.axis_label} →</p>
      )}
      {spec.independent_scales && !showTable && (
        <p className="mt-2 text-xs text-ink-disabled">
          Each series is scaled to its own maximum — compare a series across groups, not
          between series.
        </p>
      )}
      {spec.truncated && (
        <p className="mt-2 text-xs text-ink-disabled">
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
      className="shrink-0 cursor-pointer rounded-[var(--r-sm)] px-1.5 py-0.5 text-xs font-medium text-ink-muted transition-colors hover:bg-surface-hover hover:text-ink-primary focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-violet disabled:cursor-default disabled:opacity-50"
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
      className="pointer-events-none absolute z-10 -translate-x-1/2 -translate-y-full whitespace-nowrap rounded-[var(--r-sm)] bg-ink-primary px-1.5 py-1 text-2xs font-medium text-surface-card shadow-[var(--shadow-lg)]"
      style={{ left: x, top: y }}
    >
      {text}
    </div>
  )
}

/* ---------------------------------------------------------------- bar (horizontal) */

// A BAR CHART IS DRAWN AT THE WIDTH IT IS GIVEN, not scaled to it.
//
// This used to be `viewBox="0 0 320 H"` with `width="100%"`, which looks like
// responsive sizing and is not: the browser SCALES the whole drawing to the
// container. In the Analyst drawer, ~390px wide, every one of those 320 units
// was stretched by 1.22 — so the 15px type that matches the dashboard's charts
// rendered at ~18px, the 6px bars at 7.3px, and the gaps between rows grew to
// match. The chart was not styled differently from the page; it was the page's
// own geometry, enlarged, which is why it read as subtly wrong rather than
// obviously wrong.
//
// So the container is measured and the viewBox is the real pixel size, exactly
// as the dashboard's own charts do it (components/command/ChartSections.tsx,
// `useChartSize`). 15px is then 15px in both places.
const BAR_ROW = 42
//: Used only until the container has been measured, and as the floor for a
//: drawer narrow enough that bars would otherwise vanish.
const BAR_W_FALLBACK = 320
//: The bar itself, thicker than the 6px hairline it was: at 6px against a
//: 15px label and a 15px figure the bar was the quietest thing in its own
//: row, which is how a chart ends up reading as a list with underlines.
const BAR_H = 10

/** At 15px a character is ~9px wide; label every k-th slot so no two touch. */
const labelStride = (labels: string[], slot: number) =>
  Math.max(1, Math.ceil((Math.max(0, ...labels.map((l) => Math.min(l.length, 10))) * 9 + 8) / slot))

/** The share of the total each point carries, when that is a meaningful
 *  thing to say: one metric, all of it positive, and a total to be a share OF.
 *
 *  WHY A BAR CHART NEEDS IT. Incremental sales by channel is ₹226.93 Cr for
 *  General Trade against ₹14 Cr for the smallest — so five of six bars are
 *  slivers and the chart reads as "one big one and some noise". The bars are
 *  honest and must stay zero-based; the share is what makes the small ones
 *  legible, because "6%" is a figure a reader can compare even when the bar
 *  is three pixels long. */
function sharesOf(points: AnalystChartSpec['points']): string[] | null {
  if (points.length < 2) return null
  if (points.some((p) => (p.value ?? 0) < 0)) return null
  const total = points.reduce((sum, p) => sum + (p.value ?? 0), 0)
  if (total <= 0) return null
  const shares = points.map((p) => ((p.value ?? 0) / total) * 100)
  // All much of a muchness: the shares add nothing the bars do not already
  // show, and a column of near-identical percentages is just clutter.
  if (Math.max(...shares) - Math.min(...shares) < 5) return null
  return shares.map((v) => (v >= 10 ? `${Math.round(v)}%` : `${v.toFixed(1)}%`))
}

/** HORIZONTAL BARS — the default for ranking named categories, because the
 *  labels read horizontally at any length. */
function Bars({
  points, color, label, max, hover, setHover, svgRef, reference,
}: MarkProps & {
  points: AnalystChartSpec['points']
  color: string
  label: (i: number) => string
  max: number
  reference?: AnalystChartSpec['reference']
}) {
  const { ref, width } = useMeasuredWidth(BAR_W_FALLBACK)
  const BAR_W = Math.max(200, width)
  const H = points.length * BAR_ROW
  const shares = sharesOf(points)
  //: Room at the end of the bar line for the share, so the two never overlap.
  const shareGap = shares ? 46 : 0
  const trackW = Math.max(40, BAR_W - shareGap)
  return (
    <div ref={ref} className="w-full">
    <svg
      ref={svgRef}
      viewBox={`0 0 ${BAR_W} ${H}`}
      width={BAR_W}
      height={H}
      role="img"
      aria-label={`Bar chart with ${points.length} categories`}
    >
      {points.map((p, i) => {
        const w = max > 0 ? Math.max(1, (Math.max(0, p.value) / max) * trackW) : 1
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
            {/* The label is truncated by CHARACTER COUNT against the width
                actually available, not against a fixed 22: at a wider drawer
                "Travel & Hospitality" had room to spare and was cut anyway. */}
            <text x="0" y={y + 14} fontSize={15} fill="var(--text-secondary)">
              {truncate(p.label, Math.max(12, Math.floor((BAR_W * 0.58) / 8)))}
            </text>
            {/* DIRECT LABELS on every row is right here and only here: the
                rows are few and the number IS the answer to the question. */}
            <text
              x={BAR_W}
              y={y + 14}
              fontSize={15}
              fontWeight="500"
              textAnchor="end"
              fill="var(--text-primary)"
            >
              {label(i)}
            </text>
            {/* The share sits at the end of the bar's own line, in the
                width the bar gave up for it — quieter than the amount,
                because the amount is the answer and the share is the
                context. */}
            {shares && (
              <text x={BAR_W} y={y + 30} fontSize={13} textAnchor="end" fill="var(--text-muted)">
                {shares[i]}
              </text>
            )}
            <rect x="0" y={y + 21} width={trackW} height={BAR_H} rx={BAR_H / 2} fill="var(--surface-hover)" />
            <rect x="0" y={y + 21} width={w} height={BAR_H} rx={BAR_H / 2} fill={color} />
          </g>
        )
      })}
      {/* THE REFERENCE, drawn over every row so one line crosses them all —
          that is what makes it a scale rather than a decoration. */}
      {reference && max > 0 && reference.value <= max && (
        <g pointerEvents="none">
          <line
            x1={(reference.value / max) * trackW}
            x2={(reference.value / max) * trackW}
            y1={0}
            y2={H}
            stroke="var(--text-muted)"
            strokeWidth={1}
            strokeDasharray="3 3"
          />
          <text
            x={Math.min((reference.value / max) * trackW + 4, trackW - 4)}
            y={10}
            fontSize={13}
            fill="var(--text-muted)"
            textAnchor={(reference.value / max) > 0.8 ? 'end' : 'start'}
          >
            {reference.label}
          </text>
        </g>
      )}
    </svg>
    </div>
  )
}

/** The width this chart has actually been given.
 *
 *  The dashboard's own charts measure their container (`useChartSize` in
 *  components/command/ChartSections.tsx) rather than scaling a fixed drawing
 *  to it; this is the same thing, kept local so the Analyst's charts do not
 *  depend on a dashboard module. */
function useMeasuredWidth(fallback: number) {
  const ref = useRef<HTMLDivElement>(null)
  const [width, setWidth] = useState(fallback)
  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    const read = () => setWidth(el.clientWidth || fallback)
    read()
    const ro = new ResizeObserver(read)
    ro.observe(el)
    return () => ro.disconnect()
  }, [fallback])
  return { ref, width }
}

const truncate = (text: string, max: number) =>
  text.length > max ? `${text.slice(0, Math.max(1, max - 1))}…` : text

/* ---------------------------------------------------------------- column (vertical) */

const COL_H = 132

/** VERTICAL COLUMNS — for an ordered sequence (months, weeks) where the
 *  reading is left-to-right, and for a histogram's bins, which are ordered by
 *  construction and touch to show they are a continuum. */
function Columns({
  points, color, label, max, gap, hover, setHover, svgRef, reference,
}: MarkProps & {
  points: AnalystChartSpec['points']
  color: string
  label: (i: number) => string
  max: number
  gap: number
  reference?: AnalystChartSpec['reference']
}) {
  // DRAWN AT THE WIDTH IT IS GIVEN, like the bars — see BAR_W_FALLBACK. A
  // fixed 320-unit viewBox stretched to a dashboard card left the columns
  // huddled in the middle of a wide panel with empty space either side, which
  // is what made a pinned chart look like a placeholder for a real one.
  const { ref, width } = useMeasuredWidth(BAR_W_FALLBACK)
  const W = Math.max(220, width)
  const labelH = 24
  //: Room above the tallest column for its own figure.
  const valueH = 18
  const slot = W / points.length
  const barW = Math.max(1, slot - gap)
  const every = labelStride(points.map((p) => p.label), slot)
  //: Every column's figure, when they fit — a chart of five bars with no
  //: numbers on it makes the reader hover each one to learn anything.
  const showValues = points.length <= 8 && slot > 44

  return (
    <div className="relative" ref={ref}>
      <svg
        ref={svgRef}
        viewBox={`0 0 ${W} ${COL_H + labelH + valueH}`}
        width={W}
        height={COL_H + labelH + valueH}
        role="img"
        aria-label={`Column chart with ${points.length} bars`}
      >
        <line x1="0" y1={COL_H + valueH} x2={W} y2={COL_H + valueH} stroke="var(--border-subtle)" strokeWidth="1" />
        {/* THE REFERENCE a ratio is read against — see `reference` on the
            spec. Drawn under the columns so it never hides one. */}
        {reference && max > 0 && reference.value <= max && (
          <g pointerEvents="none">
            <line
              x1={0}
              x2={W}
              y1={valueH + COL_H - (reference.value / max) * COL_H}
              y2={valueH + COL_H - (reference.value / max) * COL_H}
              stroke="var(--text-muted)"
              strokeWidth={1}
              strokeDasharray="3 3"
            />
            <text
              x={W}
              y={valueH + COL_H - (reference.value / max) * COL_H - 4}
              fontSize={13}
              textAnchor="end"
              fill="var(--text-muted)"
            >
              {reference.label}
            </text>
          </g>
        )}
        {points.map((p, i) => {
          const h = max > 0 ? Math.max(1, (Math.max(0, p.value) / max) * COL_H) : 1
          const x = i * slot + gap / 2
          const top = valueH + COL_H - h
          return (
            <g
              key={`${p.label}-${i}`}
              onMouseEnter={() => setHover(i)}
              onMouseLeave={() => setHover(null)}
              opacity={hover === null || hover === i ? 1 : 0.45}
            >
              <rect x={x} y="0" width={barW} height={COL_H + valueH} fill="transparent" />
              {/* 4px rounded data-end, anchored to the baseline. */}
              <rect x={x} y={top} width={barW} height={h} rx="3" fill={color} />
              {showValues && (
                <text
                  x={x + barW / 2}
                  y={top - 5}
                  fontSize={14}
                  fontWeight={500}
                  textAnchor="middle"
                  fill="var(--text-primary)"
                >
                  {label(i)}
                </text>
              )}
              {(showValues || i % every === 0) && (
                <text
                  x={x + barW / 2}
                  y={COL_H + valueH + 17}
                  fontSize={15}
                  textAnchor="middle"
                  fill="var(--text-muted)"
                >
                  {truncate(p.label, Math.max(6, Math.floor(slot / 8)))}
                </text>
              )}
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
              <div className="pointer-events-none absolute left-1/2 top-0 z-10 -translate-x-1/2 whitespace-nowrap rounded-[var(--r-sm)] bg-ink-primary px-1.5 py-1 text-2xs font-medium text-surface-card shadow-[var(--shadow-lg)]">
                {p.label}: {label(i)}
              </div>
            )}
          </div>
        ))}
      </div>
      <div className="mt-1 flex">
        {points.map((p, i) => (
          <div key={i} className="min-w-0 flex-1 truncate text-center text-2xs text-ink-muted" title={p.label}>
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
  const labelH = 24
  const slot = W / labels.length
  const every = labelStride(labels, slot)

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
          <span key={s.name} className="flex items-center gap-1 text-2xs text-ink-secondary">
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
                {i % every === 0 && (
                  <text
                    x={gx + slot / 2}
                    y={H + 17}
                    fontSize={15}
                    textAnchor="middle"
                    fill="var(--text-muted)"
                  >
                    {name.length > 10 ? `${name.slice(0, 9)}…` : name}
                  </text>
                )}
              </g>
            )
          })}
        </svg>
        {hover !== null && labels[hover] && (
          <div
            className="pointer-events-none absolute z-10 -translate-x-1/2 -translate-y-full whitespace-nowrap rounded-[var(--r-sm)] bg-ink-primary px-1.5 py-1 text-2xs text-surface-card shadow-[var(--shadow-lg)]"
            style={{ left: `${((hover + 0.5) / labels.length) * 100}%`, top: '0px' }}
          >
            <span className="font-medium">{labels[hover]}</span>
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
  const pad = { l: 8, r: 8, t: 10, b: 26 }
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
        <text x={W - pad.r} y={H - 4} fontSize={15} textAnchor="end" fill="var(--text-muted)">
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
            className="flex items-baseline gap-1.5 text-xs"
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
            <span className="shrink-0 font-medium tabular-nums text-ink-primary">
              {((Math.max(0, p.value) / total) * 100).toFixed(2)}%
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
        <table className="w-full border-collapse text-xs">
          <thead>
            <tr className="border-b border-border-subtle">
              <th className="py-1 pr-2 text-left font-medium text-ink-muted">Group</th>
              {spec.series.map((s) => (
                <th key={s.name} className="py-1 text-right font-medium text-ink-muted">
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
                  <td key={s.name} className="py-1 text-right font-medium tabular-nums text-ink-primary">
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
      <table className="w-full border-collapse text-xs">
        <tbody>
          {points.map((p, i) => (
            <tr key={i} className="border-b border-border-subtle last:border-0">
              <td className="py-1 pr-2 text-ink-secondary">{p.label}</td>
              <td className="py-1 text-right font-medium tabular-nums text-ink-primary">{label(i)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}
