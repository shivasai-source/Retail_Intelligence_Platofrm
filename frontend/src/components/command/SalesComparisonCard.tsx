import { useEffect, useMemo, useRef, useState } from 'react'
import { useSalesComparison } from '../../hooks/useCommandCenter'
import { useCommandFilters } from '../../store/commandFilters'
import { ChartFrame } from './ChartFrame'
import { COLUMN_DIVISIONS, TipRow, columnNiceStep, columnPath, useChartSize } from './ChartSections'
import type {
  ComparisonMetricSpec,
  ComparisonPoint,
  SalesComparisonResponse,
} from '../../types/commandCenter'

/** Sales Performance Comparison — one month read beside the period it is
 *  normally judged against, in whichever measure is being asked about.
 *
 *  THREE COMPARISONS, ONE AT A TIME. They answer different questions and are
 *  not variations on one number:
 *
 *      PAGO  the month before               short-term momentum
 *      YAGO  the same month a year earlier  year on year, seasonality held
 *      YTD   January to here, cumulative,   where the whole year stands
 *            against the same window a year earlier
 *
 *  YTD is the odd one: not itself a comparison but a cumulative total, so it
 *  is shown against YTD YAGO — otherwise its growth has nothing to be a
 *  growth OF.
 *
 *  THE CHART IS THE CONTEXT. Two figures alone cannot say whether a 20% jump
 *  is a recovery, a spike or a trend, so the thirteen months ending at the
 *  selection are drawn and the comparison is expressed as HIGHLIGHTING within
 *  them: the selected period solid, the period it is measured against in the
 *  second colour, everything else recessive. Thirteen and not twelve so the
 *  year-ago column is the leftmost one rather than one step off the edge of
 *  the chart meant to show it.
 *
 *  NOTHING IS COMPUTED HERE. Every amount, delta and display string arrives
 *  formatted from the same engine the KPI cards read — including whether a
 *  movement is GOOD, which is not the same as which way it went: a rise in
 *  Trade Spend is a rise and not an improvement. The card scales bars and
 *  chooses colours; it never divides. */

const COMPARISONS = [
  { key: 'mago' as const, label: 'PAGO', full: 'Month Ago' },
  { key: 'yago' as const, label: 'YAGO', full: 'Year Ago' },
  { key: 'ytd' as const, label: 'YTD', full: 'Year to Date' },
]
type ComparisonKey = (typeof COMPARISONS)[number]['key']

const MONTH_ABBR = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

/** Column roles. The selected period and the one it is measured against must
 *  be told apart at a glance, and everything else has to stay quiet enough
 *  that they still read as the subject. */
const FILL = {
  current: 'var(--brand-violet)',
  against: 'color-mix(in srgb, var(--brand-violet) 42%, transparent)',
  idle: 'color-mix(in srgb, var(--text-primary) 12%, transparent)',
} as const

/** The compared-with bar is a tint of the selected one, which is what makes
 *  the pair read as one series — but a tint that pale loses its own edge
 *  against the plot. An outline in the full colour gives it back a boundary
 *  without darkening the fill and letting it compete with the selection. */
const STROKE = {
  current: 'transparent',
  against: 'color-mix(in srgb, var(--brand-violet) 55%, transparent)',
  idle: 'transparent',
} as const

/** Which of the five figures the selected comparison puts side by side. */
function pairKeys(key: ComparisonKey) {
  return key === 'ytd'
    ? ({ primary: 'ytd', against: 'ytd_yago' } as const)
    : ({ primary: 'current', against: key } as const)
}

function Segmented<T extends string>({
  options,
  value,
  onChange,
  ariaLabel,
}: {
  options: { key: T; label: string; title?: string }[]
  value: T
  onChange: (v: T) => void
  ariaLabel: string
}) {
  return (
    <div
      className="inline-flex h-[23px] items-stretch overflow-hidden rounded-[var(--r-sm)] border border-border-subtle"
      role="radiogroup"
      aria-label={ariaLabel}
    >
      {options.map((o) => (
        <button
          key={o.key}
          type="button"
          role="radio"
          aria-checked={value === o.key}
          title={o.title}
          onClick={() => onChange(o.key)}
          className={`cursor-pointer px-2 text-xs font-semibold transition-colors focus:outline-none focus-visible:ring-1 focus-visible:ring-brand-violet ${
            value === o.key
              ? 'bg-brand-violet text-white'
              : 'text-ink-muted hover:bg-surface-hover hover:text-ink-primary'
          }`}
        >
          {o.label}
        </button>
      ))}
    </div>
  )
}

const SELECT =
  'h-[23px] cursor-pointer rounded-[var(--r-sm)] border border-border-subtle bg-surface-card px-1.5 text-xs font-semibold text-ink-primary focus:outline-none focus-visible:ring-1 focus-visible:ring-brand-violet'

/** Month and year — the only two values the card asks for.
 *
 *  Both are built from `available_periods`, so every option can actually be
 *  answered: the year list holds only years the selection has rows in, and the
 *  month list only the months present in the chosen year. Changing to a year
 *  whose data stops in June cannot leave July selected. */
function PeriodPicker({
  periods,
  year,
  month,
  onChange,
}: {
  periods: SalesComparisonResponse['available_periods']
  year: number
  month: number
  onChange: (period: { year: number; month: number }) => void
}) {
  const years = useMemo(
    () => [...new Set(periods.map((p) => p.year))].sort((a, b) => a - b),
    [periods],
  )
  const months = useMemo(
    () => periods.filter((p) => p.year === year).map((p) => p.month).sort((a, b) => a - b),
    [periods, year],
  )

  return (
    <div className="inline-flex items-center gap-1.5">
      <select
        className={SELECT}
        aria-label="Month"
        value={month}
        onChange={(e) => onChange({ year, month: Number(e.target.value) })}
      >
        {months.map((m) => (
          <option key={m} value={m}>
            {MONTH_ABBR[m - 1]}
          </option>
        ))}
      </select>
      <select
        className={SELECT}
        aria-label="Year"
        value={year}
        onChange={(e) => {
          const nextYear = Number(e.target.value)
          const has = periods.filter((p) => p.year === nextYear).map((p) => p.month)
          onChange({ year: nextYear, month: has.includes(month) ? month : Math.max(...has) })
        }}
      >
        {years.map((y) => (
          <option key={y} value={y}>
            {`F${String(y).slice(2)}`}
          </option>
        ))}
      </select>
    </div>
  )
}

/** Every measure for one month as plain text — the `<title>` a screen reader
 *  reads, and the tooltip a pointerless device gets. Labelled from the metric
 *  specs so it cannot drift from the selector above it. */
function describePoint(point: ComparisonPoint, labels: Record<string, string>): string {
  const lines = Object.keys(point.values).map(
    (key) => `${labels[key] ?? key}: ${point.values[key].display}`,
  )
  return [point.label, ...lines].join('\n')
}

/** The thirteen-month column chart for the active metric. */
function ComparisonColumns({
  series,
  spec,
  labels,
  current,
  against,
}: {
  series: ComparisonPoint[]
  spec: ComparisonMetricSpec
  /** metric key -> display label, for the tooltip and the <title>. */
  labels: Record<string, string>
  /** Point keys highlighted as the selected period. */
  current: Set<string>
  /** Point keys highlighted as what it is measured against. */
  against: Set<string>
}) {
  const { ref, width, height } = useChartSize(560, 250)
  const [hover, setHover] = useState<number | null>(null)
  const currency = useCommandFilters((s) => s.currency)

  const n = series.length
  const padL = 52
  const padR = 10
  const padT = 16
  const padB = 34
  const innerW = Math.max(120, width - padL - padR)
  const innerH = Math.max(80, height - padT - padB)

  const values = series
    .map((p) => p.values[spec.key]?.value)
    .filter((v): v is number => v !== null && v !== undefined)

  const rawMax = Math.max(spec.unit === 'multiple' ? 0 : 1, ...values)
  const rawMin = Math.min(0, ...values)
  const step = columnNiceStep((rawMin < 0 ? rawMax - rawMin : rawMax) / COLUMN_DIVISIONS)
  const lo = rawMin < 0 ? Math.floor(rawMin / step) * step : 0
  let hi = lo + step * COLUMN_DIVISIONS
  while (hi < rawMax) hi += step

  const y = (v: number) => padT + innerH * (1 - (v - lo) / (hi - lo || 1))
  const zeroY = y(0)
  const ticks: number[] = []
  for (let t = lo; t <= hi + 1e-6; t += step) ticks.push(t)

  const slot = innerW / Math.max(1, n)
  const barW = Math.max(6, Math.min(26, slot * 0.56))
  const centreX = (i: number) => padL + slot * i + slot / 2
  const active = hover !== null && hover < n ? hover : null

  /** Axis ticks in the metric's own unit. A multiple prints itself; money is
   *  abbreviated to keep the gutter narrow — the exact figure is on the bar's
   *  own tooltip, already formatted by the backend. */
  const tick = (v: number) => {
    if (spec.unit === 'multiple') return v.toFixed(2)
    const symbol = currency === 'USD' ? '$' : '₹'
    const a = Math.abs(v)
    if (currency === 'USD') {
      if (a >= 1e6) return `${symbol}${(v / 1e6).toFixed(1)} M`
      if (a >= 1e3) return `${symbol}${(v / 1e3).toFixed(1)} K`
      return `${symbol}${v.toFixed(0)}`
    }
    // "₹30.0 Cr", with the space -- the same tick the region and type
    // column charts print, so the three axes on the page read alike.
    if (a >= 1e7) return `${symbol}${(v / 1e7).toFixed(1)} Cr`
    if (a >= 1e5) return `${symbol}${(v / 1e5).toFixed(1)} L`
    return `${symbol}${v.toFixed(0)}`
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="mb-1.5 flex flex-wrap items-center gap-x-3.5 gap-y-1 text-xs text-ink-muted">
        <span className="inline-flex items-center gap-1.5">
          <span className="h-2.5 w-2.5 rounded-[2px]" style={{ background: FILL.current }} />
          Selected
        </span>
        <span className="inline-flex items-center gap-1.5">
          <span
            className="h-2.5 w-2.5 rounded-[2px]"
            style={{ background: FILL.against, boxShadow: `inset 0 0 0 1px ${STROKE.against}` }}
          />
          Compared with
        </span>
        <span className="ml-auto truncate">{spec.label}</span>
      </div>

      <div ref={ref} className="relative min-h-[170px] w-full flex-1">
        <svg
          className="absolute inset-0"
          width={width}
          height={height}
          role="img"
          aria-label={`${spec.label} by month`}
        >
          {ticks.map((t) => (
            <g key={t}>
              <line
                x1={padL}
                x2={padL + innerW}
                y1={y(t)}
                y2={y(t)}
                stroke={t === lo ? 'var(--border-default)' : 'var(--border-subtle)'}
              />
              <text x={padL - 7} y={y(t) + 3} textAnchor="end" fontSize={10} fill="var(--text-muted)">
                {tick(t)}
              </text>
            </g>
          ))}

          {/* The zero line only exists when the axis actually crosses it. */}
          {lo < 0 && (
            <line x1={padL} x2={padL + innerW} y1={zeroY} y2={zeroY} stroke="var(--border-strong)" />
          )}

          {series.map((p, i) => {
            const v = p.values[spec.key]?.value ?? null
            const role = current.has(p.key) ? 'current' : against.has(p.key) ? 'against' : 'idle'
            const isActive = active === i
            const x = centreX(i) - barW / 2

            // A null is drawn as nothing at all. An unmeasurable ROI is not
            // zero, and a zero-height column would claim it was.
            const bar =
              v === null ? null : (
                <path
                  d={columnPath(x, Math.min(y(v), zeroY), barW, Math.max(Math.abs(y(v) - zeroY), 2), v < 0)}
                  fill={FILL[role]}
                  stroke={STROKE[role]}
                  className="transition-opacity duration-150"
                  opacity={active === null || isActive ? 1 : 0.5}
                />
              )

            return (
              <g key={p.key}>
                {/* Hover band, behind the column: the whole slot is the hit
                    area, so the whole slot is what lights up. */}
                <rect
                  x={padL + slot * i + 1}
                  y={padT - 6}
                  width={Math.max(0, slot - 2)}
                  height={innerH + 12}
                  rx={6}
                  fill="var(--surface-hover)"
                  className="transition-opacity duration-150"
                  opacity={isActive ? 1 : 0}
                />
                {bar}

                {/* Only the two months under comparison are labelled on the
                    axis in full; the rest carry the month alone, so the pair
                    being compared stays findable in a row of thirteen. */}
                <text
                  x={centreX(i)}
                  y={height - 19}
                  textAnchor="middle"
                  fontSize={10}
                  fontWeight={role === 'idle' ? 500 : 700}
                  fill={role === 'idle' ? 'var(--text-muted)' : 'var(--text-primary)'}
                >
                  {p.short}
                </text>
                {(i === 0 || p.month === 1) && (
                  <text
                    x={centreX(i)}
                    y={height - 7}
                    textAnchor="middle"
                    fontSize={9}
                    fontWeight={700}
                    fill="var(--text-muted)"
                  >
                    {p.year_short}
                  </text>
                )}

                {/* The hit area is the whole slot, not the bar. */}
                <rect
                  x={padL + slot * i}
                  y={0}
                  width={slot}
                  height={height}
                  fill="transparent"
                  onMouseEnter={() => setHover(i)}
                  onMouseLeave={() => setHover(null)}
                >
                  {/* Reaches assistive tech and survives a missing pointer. */}
                  <title>{describePoint(p, labels)}</title>
                </rect>
              </g>
            )
          })}
        </svg>

        {active !== null && (
          <div
            className="pointer-events-none absolute top-0 z-20 w-48 rounded-[var(--r-md)] border border-border-default bg-surface-card p-2.5 text-xs shadow-[var(--shadow-lg)]"
            style={{ left: Math.min(Math.max(0, centreX(active) - 96), Math.max(0, width - 192)) }}
          >
            <div className="font-bold text-ink-primary">{series[active].label}</div>
            {/* Every measure, not just the one on the axis: the question a
                hover asks is "what happened that month", and the answer is
                incomplete in one number. */}
            <TipRow
              swatch={spec.key === 'sales' ? FILL.current : undefined}
              k="Sales"
              v={series[active].values.sales?.display ?? '—'}
            />
            <TipRow
              swatch={spec.key === 'incremental_sales' ? FILL.current : undefined}
              k="Incremental Sales"
              v={series[active].values.incremental_sales?.display ?? '—'}
            />
            <TipRow
              swatch={spec.key === 'trade_spend' ? FILL.current : undefined}
              k="Trade Spend"
              v={series[active].values.trade_spend?.display ?? '—'}
            />
            <TipRow
              swatch={spec.key === 'roi' ? FILL.current : undefined}
              k="ROI"
              v={series[active].values.roi?.display ?? '—'}
            />
          </div>
        )}
      </div>
    </div>
  )
}

export function SalesComparisonCard() {
  const [metricKey, setMetricKey] = useState('sales')
  const [comparison, setComparison] = useState<ComparisonKey>('mago')
  // Null until the user picks: the backend answers with its latest month, and
  // that is the month the card then shows. The default is the DATA's latest,
  // never today — this dataset ends before the current date.
  const [period, setPeriod] = useState<{ year: number; month: number } | null>(null)

  const q = useSalesComparison(period)
  const data = q.data

  // FOLLOWS THE PAGE'S YEAR. Every other chart on the page reads the Year
  // pill; this one opened on the data's latest month whatever the pill said,
  // so a page set to F24 showed an F26 comparison in this one card. When the
  // page year changes, seat the card on that year's latest month with data.
  // Applied once per page-year change, never on refetch, so a year or month
  // picked in the card's own selects is not fought.
  const pageYear = useCommandFilters((s) => s.filters.year)
  const appliedYear = useRef<number | null>(null)
  useEffect(() => {
    const periods = data?.available_periods
    if (pageYear === null || !periods?.length || appliedYear.current === pageYear) return
    const months = periods.filter((p) => p.year === pageYear).map((p) => p.month)
    if (!months.length) return
    appliedYear.current = pageYear
    setPeriod({ year: pageYear, month: Math.max(...months) })
  }, [pageYear, data?.available_periods])

  const spec =
    data?.metric_specs.find((m) => m.key === metricKey) ?? data?.metric_specs[0] ?? null
  const figures = spec ? data?.figures[spec.key] : undefined
  const labels = useMemo(
    () => Object.fromEntries((data?.metric_specs ?? []).map((m) => [m.key, m.label])),
    [data?.metric_specs],
  )
  const keys = pairKeys(comparison)
  const primary = figures?.[keys.primary]
  const against = figures?.[keys.against]
  const delta = figures?.delta[comparison]
  const highlight = data?.windows[comparison]
  const active = COMPARISONS.find((c) => c.key === comparison)!

  const tone =
    delta?.good === true
      ? 'bg-status-success/10 text-status-success'
      : delta?.good === false
        ? 'bg-status-danger/10 text-status-danger'
        : 'bg-ink-primary/[0.06] text-ink-muted'

  return (
    <ChartFrame
      title="Performance Comparison"
      hint={
        spec
          ? `${spec.label} — ${spec.meaning}\n\nFormula: ${spec.formula}\n\n` +
            'PAGO is the month before (short-term momentum), YAGO the same month a year ' +
            'earlier (year on year, with seasonality held), and YTD the cumulative ' +
            'January-to-here window against the same window last year. A ratio such as ' +
            'ROI is compared as a difference in multiples (+0.20), not as a percentage of a ratio.'
          : undefined
      }
      controls={
        <div className="flex flex-wrap items-center gap-2">
          <select
            className={SELECT}
            aria-label="Measure"
            value={spec?.key ?? ''}
            onChange={(e) => setMetricKey(e.target.value)}
          >
            {(data?.metric_specs ?? []).map((m) => (
              <option key={m.key} value={m.key}>
                {m.label}
              </option>
            ))}
          </select>
          <Segmented
            ariaLabel="Comparison period"
            value={comparison}
            onChange={setComparison}
            options={COMPARISONS.map((c) => ({ key: c.key, label: c.label, title: c.full }))}
          />
          {data?.period && data.available_periods.length > 0 && (
            <div className="ml-auto">
              <PeriodPicker
                periods={data.available_periods}
                year={data.period.year}
                month={data.period.month}
                onChange={setPeriod}
              />
            </div>
          )}
        </div>
      }
      fill
      isLoading={q.isLoading}
      isFetching={q.isFetching}
      error={q.error}
      onRetry={() => q.refetch()}
      isEmpty={!data?.period || !spec}
      emptyMessage="No sales in this selection."
      height={250}
    >
      {data && spec && primary && against && delta && highlight && (
        <div className="flex h-full min-h-0 flex-col">
          <ComparisonColumns
            series={data.series}
            spec={spec}
            labels={labels}
            current={new Set(highlight.current)}
            against={new Set(highlight.against)}
          />

          {/* The comparison itself, stated rather than left to be read off the
              bars — including when there is nothing to compare against. */}
          <div className="mt-2 flex items-end justify-between gap-3 border-t border-border-subtle pt-2.5">
            <div className="grid min-w-0 grid-cols-2 gap-x-4 gap-y-0.5">
              <div className="min-w-0">
                <div className="truncate text-xs text-ink-muted">{primary.label}</div>
                <div className="text-lg font-extrabold tabular-nums text-ink-primary">
                  {primary.display}
                </div>
              </div>
              <div className="min-w-0">
                <div className="truncate text-xs text-ink-muted">{against.label}</div>
                <div
                  className={`text-lg font-bold tabular-nums ${
                    against.available ? 'text-ink-secondary' : 'text-ink-muted'
                  }`}
                >
                  {against.available ? against.display : '—'}
                </div>
              </div>
            </div>

            <div className="shrink-0 text-right">
              <span
                className={`inline-block rounded-full px-2 py-0.5 text-sm font-bold tabular-nums ${tone}`}
                title={delta.basis ? `Measured in ${delta.basis}` : undefined}
              >
                {delta.display}
              </span>
              <div className="mt-0.5 text-xs text-ink-muted">
                {against.available ? active.full : 'no comparable period'}
              </div>
            </div>
          </div>

          {!against.available && against.unavailable_reason && (
            <div className="mt-1.5 text-xs leading-[1.45] text-ink-muted">
              {against.unavailable_reason}.
            </div>
          )}
        </div>
      )}
    </ChartFrame>
  )
}
