import { useState } from 'react'
import { Button, Card, CardBody, CardHeader, Table, Td, Th, Tr } from '../../components/ui'
import { InfoBlock, InfoPopover } from '../../components/ui/InfoPopover'
import { TipRow } from '../../components/command/ChartSections'
import { Segmented } from '../../components/command/Segmented'
import { Stale } from '../../components/command/States'
import { Icon } from '../../icons'
import { ContextColumns, DecompositionDonut, DRIVERS, type DriverKey, FILL, MMM_SERIES, PairedColumns, RankedColumns, RunningLines, ShareBars, ShareDonut, ValueColumns, axisMoney, roasTone } from './charts'
import { useMmmHub } from '../hooks'
import type { MmmChannel, MmmFilterOptions, MmmHub, MmmScopeWire } from '../types'

/** The Insights Hub's panels below the trend. Every value and display string
 *  arrives formatted from app/mmm/service.py. These components choose
 *  colours and scale bars; they never divide. */

export function PanelTitle({ title, about }: { title: string; about: Array<[string, string]> }) {
  return (
    <span className="flex items-center gap-1.5">
      {title}
      <InfoPopover label={`About ${title}`} title={title}>
        {about.map(([label, text]) => (
          <InfoBlock key={label} label={label}>
            {text}
          </InfoBlock>
        ))}
      </InfoPopover>
    </span>
  )
}

/** A native <select> dressed as one of the card's controls, the 23px control
 *  TPO's Performance Comparison card uses. */
function Select({ children, ...props }: React.SelectHTMLAttributes<HTMLSelectElement>) {
  return (
    <span className="relative inline-flex">
      <select
        {...props}
        className="h-[23px] cursor-pointer appearance-none rounded-[var(--r-sm)] border border-border-subtle bg-surface-card pl-2 pr-6 text-xs font-semibold text-ink-primary transition-colors hover:bg-surface-hover focus:outline-none focus-visible:ring-1 focus-visible:ring-brand-violet"
      >
        {children}
      </select>
      <Icon name="chevronDown" className="pointer-events-none absolute right-1.5 top-1/2 h-3 w-3 -translate-y-1/2 text-ink-muted" />
    </span>
  )
}

function Swatch({ fill, label, outline }: { fill: string; label: string; outline?: boolean }) {
  return (
    <span className="inline-flex items-center gap-1.5">
      <span
        className="h-2.5 w-2.5 rounded-[2px]"
        style={{ background: fill, boxShadow: outline ? 'inset 0 0 0 1px color-mix(in srgb, var(--brand-violet) 55%, transparent)' : undefined }}
      />
      {label}
    </span>
  )
}

function Caveat({ children }: { children: React.ReactNode }) {
  return <p className="mt-2 text-xs leading-[1.5] text-ink-muted">{children}</p>
}

/** The per-day measures. They are KPI cards (Add KPI); the graphs compare
 *  totals and ratios only, so they are left out of the comparison's measure
 *  list. */
const PER_DAY_MEASURES = new Set(['baseline_per_day', 'avg_daily_revenue', 'ad_lift'])

/** One plain line per comparison measure for the ⓘ. The backend's
 *  `formula` is the full derivation; this is what a reader needs. */
const SHORT_DEFINITION: Record<string, string> = {
  revenue: 'Total sales in the period.',
  spend: 'Total spent on ads.',
  roas: 'Extra revenue for every 1 spent. Above 1.00x pays back.',
  baseline: 'Sales you would have made with no ads.',
  incremental: 'Sales the ads added: Revenue − Baseline.',
  media_days: 'Days with any ad spend.',
}

/** A metric value in the comparison's own unit, for the axis. */
function tickFor(unit: string, currency: string, rate: number) {
  if (unit === 'multiple') return (v: number) => `${v.toFixed(2)}x`
  if (unit === 'count') return (v: number) => v.toFixed(0)
  return (v: number) => axisMoney(v * rate, currency)
}

const MONTH_ABBR = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
const MONTH_FULL = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December']
/** The month select's "no month" option: the page's own period for that year. */
const WHOLE = 0

type ComparisonKind = 'yago' | 'pago' | 'mago' | 'ytd'
const COMPARISONS: Array<{ key: ComparisonKind; label: string; title: string }> = [
  { key: 'yago', label: 'YAGO', title: 'Year Ago' },
  { key: 'pago', label: 'PAGO', title: 'Period Ago' },
  { key: 'mago', label: 'MAGO', title: 'Month Ago' },
  { key: 'ytd', label: 'YTD', title: 'Year to Date vs the same window last year' },
]

/** The four measures the hub's monthly trend carries, by comparison key. */
const TREND_KEYS = ['revenue', 'spend', 'baseline', 'roas'] as const
type TrendKey = (typeof TREND_KEYS)[number]
function trendValues(t: MmmHub['trend'], k: TrendKey): Array<number | null> {
  return t[k]
}
function trendDisplays(t: MmmHub['trend'], k: TrendKey): string[] {
  return k === 'revenue' ? t.revenue_display : k === 'spend' ? t.spend_display : k === 'baseline' ? t.baseline_display : t.roas_display
}
const STROKE_PREV = 'var(--text-muted)'

const iso = (y: number, m: number, d: number) => `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`
const lastDay = (y: number, m: number) => new Date(y, m, 0).getDate()

/** The months of `year` the dataset covers, from options.date_range. */
function monthsIn(year: number, range: { from: string; to: string }): number[] {
  const [fy, fm] = range.from.split('-').map(Number)
  const [ty, tm] = range.to.split('-').map(Number)
  const first = year === fy ? fm : 1
  const last = year === ty ? tm : 12
  const out: number[] = []
  for (let m = first; m <= last; m++) out.push(m)
  return out
}

/** PERFORMANCE COMPARISON — one period beside YAGO (same dates a year
 *  earlier), PAGO (the equal-length period just before) and MAGO (same dates
 *  a month earlier), on one measure at a time; or, on YTD, January to the
 *  picked month beside the same window a year earlier.
 *
 *  THE CARD PICKS ITS OWN PERIOD, as TPO's does: a Month and a Year select on
 *  the right of its controls. It opens on the latest month of the page's year
 *  and is re-seated whenever the page's year changes, so it never contradicts
 *  the Year pill; "Whole period" hands it back the page's own period. The
 *  channel, promotion-type and event filters always apply. While the page is
 *  on a custom date range the card follows that range and its pickers rest.
 *
 *  Every figure is the backend's: the card asks /api/mmm/hub for its period
 *  and reads `comparison`. Each period's baseline is its own, so ROAS and
 *  Incremental Revenue compare like for like. */
export function ComparisonCard({
  data,
  scope,
  options,
  currency,
}: {
  data: MmmHub
  /** The page's scope, as the hub was asked for it. */
  scope: MmmScopeWire
  options: MmmFilterOptions | undefined
  currency: string
}) {
  const [metricKey, setMetricKey] = useState('revenue')
  const [kind, setKind] = useState<ComparisonKind>('yago')
  const custom = scope.date_from !== null || scope.date_to !== null
  const years = options?.years ?? []
  const range = options?.date_range
  const pageYear = scope.year ?? (years.length ? Math.max(...years) : null)
  // Narrower page periods (a quarter, a month, a week) are the page's to
  // say; the card then opens on them rather than replacing them.
  const pageNarrowed = scope.quarter !== null || scope.month !== null || scope.week !== null

  // The reader's pick, remembered with the page period it was made under:
  // any change to the page's year, quarter, month or week discards it, and
  // the card re-seats on the page's new period.
  const pagePeriod = `${pageYear}|${scope.quarter}|${scope.month}|${scope.week}`
  const [picked, setPicked] = useState<{ forPage: string; year: number; month: number } | null>(null)
  const seatMonth = (y: number) => {
    if (pageNarrowed) return WHOLE
    const ms = range ? monthsIn(y, range) : []
    return ms.length ? ms[ms.length - 1] : WHOLE
  }
  const period =
    picked && picked.forPage === pagePeriod
      ? picked
      : pageYear !== null
        ? { forPage: pagePeriod, year: pageYear, month: seatMonth(pageYear) }
        : null
  const months = period && range ? monthsIn(period.year, range) : []

  // The scope the card asks the hub for.
  const cardScope: MmmScopeWire = (() => {
    if (custom || !period) return scope
    if (kind === 'ytd') {
      const endMonth = period.month === WHOLE ? (months[months.length - 1] ?? 12) : period.month
      return {
        ...scope,
        year: null,
        quarter: null,
        month: null,
        week: null,
        date_from: iso(period.year, 1, 1),
        date_to: iso(period.year, endMonth, lastDay(period.year, endMonth)),
      }
    }
    if (period.month === WHOLE) return { ...scope, year: period.year }
    return { ...scope, year: period.year, quarter: null, month: period.month, week: null }
  })()

  const sameAsPage = JSON.stringify(cardScope) === JSON.stringify(scope)
  const own = useMmmHub(cardScope, 'month', currency, !sameAsPage)

  // THE CHART AROUND THE COMPARISON. The hub's monthly trend carries four
  // of the nine measures; the other five exist per period only and keep the
  // period columns.
  const trendKey = TREND_KEYS.find((k) => k === metricKey) ?? null
  const endMonth = period ? (period.month === WHOLE ? (months[months.length - 1] ?? 12) : period.month) : 12
  // A single picked month: the thirteen months ending at it, as TPO draws.
  const ctxOn = kind !== 'ytd' && !custom && trendKey !== null && period !== null && period.month !== WHOLE
  const ctxScope: MmmScopeWire =
    ctxOn && period
      ? {
          ...scope,
          year: null,
          quarter: null,
          month: null,
          week: null,
          date_from: iso(period.year - 1, period.month, 1),
          date_to: iso(period.year, period.month, lastDay(period.year, period.month)),
        }
      : cardScope
  const ctx = useMmmHub(ctxScope, 'month', currency, ctxOn)
  // YTD: this year's running total beside last year's, month by month. A
  // ratio (ROAS) does not accumulate, so it keeps the columns.
  const linesOn = kind === 'ytd' && !custom && trendKey !== null && trendKey !== 'roas' && period !== null
  const prevScope: MmmScopeWire =
    linesOn && period
      ? {
          ...scope,
          year: null,
          quarter: null,
          month: null,
          week: null,
          date_from: iso(period.year - 1, 1, 1),
          date_to: iso(period.year - 1, endMonth, lastDay(period.year - 1, endMonth)),
        }
      : cardScope
  const prevYtd = useMmmHub(prevScope, 'month', currency, linesOn)

  const source = sameAsPage ? data : (own.data ?? data)
  const loading =
    (!sameAsPage && (own.isFetching || !own.data)) ||
    (ctxOn && ctx.isFetching) ||
    (linesOn && prevYtd.isFetching)

  const cmp = source.comparison
  const measures = cmp.metrics.filter((m) => !PER_DAY_MEASURES.has(m.key))
  const spec = measures.find((m) => m.key === metricKey) ?? measures[0]
  const ytd = kind === 'ytd'
  // YTD is a cumulative window, so it is read against its year-ago window.
  const winKey = ytd ? 'yago' : kind
  const win = cmp.windows.find((w) => w.key === winKey)!
  const current = cmp.current[spec.key]
  const against = win.values[spec.key]
  const delta = win.delta[spec.key]
  const tone =
    delta?.good === true
      ? 'bg-status-success/10 text-status-success'
      : delta?.good === false
        ? 'bg-status-danger/10 text-status-danger'
        : 'bg-ink-primary/[0.06] text-ink-muted'

  const shownWindows = ytd ? [win] : cmp.windows
  const columns = [
    { key: 'current', label: ytd ? 'YTD' : 'Selected', value: current.value, display: current.display, role: 'current' as const },
    ...shownWindows.map((w) => ({
      key: w.key,
      label: ytd ? 'YTD YAGO' : w.label,
      value: w.available ? (w.values[spec.key]?.value ?? null) : null,
      display: w.available ? (w.values[spec.key]?.display ?? '—') : '—',
      role: w.key === winKey ? ('against' as const) : ('idle' as const),
    })),
  ]
  const periodOf = (i: number) => (i === 0 ? cmp.period_label : shownWindows[i - 1].period_label)
  const activeTitle = COMPARISONS.find((c) => c.key === kind)!.title
  // The footer names the two periods, as TPO's card does ("December 2025"),
  // falling back to the backend's date span when the period is not a month.
  const footer = (() => {
    if (custom || !period) return null
    const y = period.year
    if (ytd) return { now: `Jan – ${MONTH_ABBR[endMonth - 1]} ${y}`, then: `Jan – ${MONTH_ABBR[endMonth - 1]} ${y - 1}` }
    if (period.month === WHOLE) return null
    const m = period.month
    const pm = m === 1 ? 12 : m - 1
    const py = m === 1 ? y - 1 : y
    return {
      now: `${MONTH_FULL[m - 1]} ${y}`,
      then: kind === 'yago' ? `${MONTH_FULL[m - 1]} ${y - 1}` : `${MONTH_FULL[pm - 1]} ${py}`,
    }
  })()
  const rate = source.meta.exchange_rate
  const money = (v: number) => axisMoney(v * rate, source.meta.currency)

  // The thirteen context months, or null to fall back to the columns.
  const ctxPoints = (() => {
    const t = ctxOn && !ctx.isPlaceholderData ? ctx.data?.trend : undefined
    if (!t || !trendKey || !period) return null
    const sel = `${MONTH_ABBR[period.month - 1]} ${period.year}`
    const pm = period.month === 1 ? 12 : period.month - 1
    const py = period.month === 1 ? period.year - 1 : period.year
    const vs = kind === 'yago' ? `${MONTH_ABBR[period.month - 1]} ${period.year - 1}` : `${MONTH_ABBR[pm - 1]} ${py}`
    if (!t.labels.includes(sel)) return null
    const values = trendValues(t, trendKey)
    const displays = trendDisplays(t, trendKey)
    return t.labels.map((label, i) => {
      const [mon, yr] = label.split(' ')
      return {
        key: label,
        month: mon,
        year: i === 0 || mon === 'Jan' ? yr : null,
        value: values[i],
        display: displays[i],
        role: label === sel ? ('current' as const) : label === vs ? ('against' as const) : ('idle' as const),
        title: label,
        details: [
          ['Revenue', t.revenue_display[i], MMM_SERIES.revenue],
          ['Ad spend', t.spend_display[i], MMM_SERIES.spend],
          ['Baseline', t.baseline_display[i]],
          ['ROAS', t.roas_display[i], MMM_SERIES.roas],
        ] as Array<[string, string, string?]>,
      }
    })
  })()

  // The YTD running totals, or null to fall back to the columns.
  const ytdLines = (() => {
    const cur = linesOn && !own.isPlaceholderData ? own.data?.trend : undefined
    const prev = linesOn && !prevYtd.isPlaceholderData ? prevYtd.data?.trend : undefined
    if (!cur || !prev || !trendKey || !period) return null
    const run = (t: MmmHub['trend'], y: number) => {
      const vals = trendValues(t, trendKey)
      let sum = 0
      let seen = false
      return MONTH_ABBR.slice(0, endMonth).map((mon) => {
        const i = t.labels.indexOf(`${mon} ${y}`)
        const v = i === -1 ? null : vals[i]
        if (v !== null) {
          sum += v
          seen = true
        }
        return seen ? sum : null
      })
    }
    return {
      labels: MONTH_ABBR.slice(0, endMonth),
      current: run(cur, period.year),
      previous: run(prev, period.year - 1),
      currentName: `${period.year} YTD`,
      previousName: `${period.year - 1} YTD`,
    }
  })()

  return (
    <Card className="flex h-full flex-col">
      <CardHeader
        title={
          <PanelTitle
            title="Performance Comparison"
            about={[
              [spec.label, SHORT_DEFINITION[spec.key] ?? spec.formula],
              ['YAGO', 'Same dates, last year.'],
              ['PAGO', 'The equal-length period just before.'],
              ['MAGO', 'Same dates, last month.'],
              ['YTD', 'January to the picked month, vs the same window last year.'],
            ]}
          />
        }
      />
      <div className="flex flex-wrap items-center gap-2 border-b border-border-subtle px-5 py-2.5">
        <Select aria-label="Measure" value={spec.key} onChange={(e) => setMetricKey(e.target.value)}>
          {measures.map((m) => (
            <option key={m.key} value={m.key}>
              {m.label}
            </option>
          ))}
        </Select>
        <Segmented
          ariaLabel="Comparison period"
          value={kind}
          onChange={setKind}
          options={custom ? COMPARISONS.filter((c) => c.key !== 'ytd') : COMPARISONS}
        />
        {!custom && period && years.length > 0 && (
          <span className="inline-flex items-center gap-1.5">
            <Select
              aria-label="Month"
              value={period.month}
              onChange={(e) => setPicked({ forPage: pagePeriod, year: period.year, month: Number(e.target.value) })}
            >
              <option value={WHOLE}>{ytd ? 'Latest' : pageNarrowed ? 'Page period' : 'Full year'}</option>
              {months.map((m) => (
                <option key={m} value={m}>
                  {MONTH_ABBR[m - 1]}
                </option>
              ))}
            </Select>
            <Select
              aria-label="Year"
              value={period.year}
              onChange={(e) => {
                const y = Number(e.target.value)
                const has = range ? monthsIn(y, range) : []
                const m = period.month === WHOLE || has.includes(period.month) ? period.month : (has[has.length - 1] ?? WHOLE)
                setPicked({ forPage: pagePeriod, year: y, month: m })
              }}
            >
              {[...years].sort((a, b) => b - a).map((y) => (
                <option key={y} value={y}>
                  {y}
                </option>
              ))}
            </Select>
          </span>
        )}
      </div>
      <CardBody className="flex flex-1 flex-col">
        <Stale when={loading} className="flex flex-1 flex-col">
        <div className="mb-1.5 flex flex-wrap items-center gap-x-3.5 gap-y-1 text-xs text-ink-muted">
          {ytdLines ? (
            <>
              <span className="inline-flex items-center gap-1.5">
                <span className="h-0.5 w-[18px] rounded-sm bg-brand-violet" />
                {ytdLines.currentName}
              </span>
              <span className="inline-flex items-center gap-1.5">
                <span className="h-0 w-[18px] border-t-2 border-dashed" style={{ borderColor: STROKE_PREV }} />
                {ytdLines.previousName}
              </span>
            </>
          ) : (
            <>
              <Swatch fill={FILL.current} label={ytd ? 'Year to date' : 'Selected'} />
              <Swatch fill={FILL.against} label="Compared with" outline />
            </>
          )}
          <span className="ml-auto truncate">{ytdLines ? `${spec.label}, running total` : spec.label}</span>
        </div>
        {ytdLines ? (
          <RunningLines {...ytdLines} format={money} ariaLabel={`${spec.label}, year to date against last year`} />
        ) : ctxPoints ? (
          <ContextColumns
            points={ctxPoints}
            format={tickFor(spec.unit, source.meta.currency, spec.unit === 'currency' ? rate : 1)}
            ariaLabel={`${spec.label} by month, the selected month and the month it is compared with highlighted`}
            onPick={(i) => {
              const [mon, yr] = ctxPoints[i].key.split(' ')
              setPicked({ forPage: pagePeriod, year: Number(yr), month: MONTH_ABBR.indexOf(mon) + 1 })
            }}
          />
        ) : (
        <ValueColumns
          columns={columns}
          format={tickFor(spec.unit, source.meta.currency, spec.unit === 'currency' ? source.meta.exchange_rate : 1)}
          ariaLabel={`${spec.label}: selected period and comparison periods`}
          onPick={(i) => {
            if (i > 0 && !ytd) setKind(shownWindows[i - 1].key)
          }}
          tooltip={(i) => {
            const w = i > 0 ? shownWindows[i - 1] : null
            return (
              <>
                <div className="font-bold text-ink-primary">{w ? (ytd ? 'YTD a year ago' : w.full) : ytd ? 'Year to date' : 'Selected period'}</div>
                <div className="text-ink-muted">{periodOf(i) || '—'}</div>
                <TipRow swatch={FILL[columns[i].role]} k={spec.label} v={columns[i].display} />
                {w ? (
                  w.available ? (
                    <>
                      <TipRow k="Selected vs this" v={w.delta[spec.key]?.display ?? '—'} />
                      {!ytd && w.key !== kind && <div className="mt-1.5 text-ink-muted">Click to compare against {w.label}.</div>}
                    </>
                  ) : (
                    <div className="mt-1 leading-[1.4] text-ink-muted">{w.reason}</div>
                  )
                ) : (
                  shownWindows.map((cw) => (
                    <TipRow key={cw.key} k={`vs ${ytd ? 'YTD YAGO' : cw.label}`} v={cw.available ? (cw.delta[spec.key]?.display ?? '—') : '—'} />
                  ))
                )}
              </>
            )
          }}
        />
        )}
        <div className="mt-2 flex items-end justify-between gap-3 border-t border-border-subtle pt-2.5">
          <div className="grid min-w-0 grid-cols-2 gap-x-4">
            <div className="min-w-0">
              <div className="truncate text-xs text-ink-muted" title={cmp.period_label}>{footer?.now ?? cmp.period_label}</div>
              <div className="text-lg font-extrabold tabular-nums text-ink-primary">{current.display}</div>
            </div>
            <div className="min-w-0">
              <div className="truncate text-xs text-ink-muted" title={win.period_label}>{footer?.then ?? (win.period_label || win.full)}</div>
              <div className={`text-lg font-bold tabular-nums ${win.available ? 'text-ink-secondary' : 'text-ink-muted'}`}>
                {win.available ? against?.display : '—'}
              </div>
            </div>
          </div>
          <div className="shrink-0 text-right">
            <span
              className={`inline-block rounded-full px-2 py-0.5 text-sm font-bold tabular-nums ${tone}`}
              title={delta?.basis ? `Measured in ${delta.basis}` : undefined}
            >
              {win.available ? (delta?.display ?? '—') : '—'}
            </span>
            <div className="mt-0.5 text-xs text-ink-muted">{win.available ? activeTitle.replace(/ vs .*/, '') : 'no comparable period'}</div>
          </div>
        </div>
        </Stale>
      </CardBody>
    </Card>
  )
}

/** DAYS WITH VS WITHOUT EVENTS — average daily revenue on days with each
 *  event beside the days without it, in the scope. */
export function EventsCard({ data }: { data: MmmHub }) {
  const [order, setOrder] = useState<'listed' | 'gap'>('listed')
  const groups =
    order === 'gap'
      ? [...data.events].sort((a, b) => Math.abs(b.difference ?? 0) - Math.abs(a.difference ?? 0))
      : data.events
  return (
    <Card className="flex h-full flex-col">
      <CardHeader
        title={
          <PanelTitle
            title="Days With vs Without Events"
            about={[
              ['Bars', 'Average revenue per day, on days with vs without the event.'],
              ['Difference', 'How much higher (or lower) days with the event are.'],
            ]}
          />
        }
      />
      <div className="flex flex-wrap items-center gap-2 border-b border-border-subtle px-5 py-2.5">
        <span className="inline-flex items-center gap-1.5 text-xs text-ink-muted">
          <span>Order</span>
          <Segmented
            ariaLabel="Event order"
            value={order}
            onChange={setOrder}
            options={[
              { key: 'listed', label: 'As listed' },
              { key: 'gap', label: 'Biggest gap', title: 'Largest difference first, up or down' },
            ]}
          />
        </span>
      </div>
      <CardBody className="flex flex-1 flex-col">
        <div className="mb-1.5 flex flex-wrap items-center gap-x-3.5 gap-y-1 text-xs text-ink-muted">
          <Swatch fill={FILL.current} label="Days with" />
          <Swatch fill={FILL.against} label="Days without" outline />
          <span className="ml-auto">Avg daily revenue</span>
        </div>
        <PairedColumns groups={groups} rate={data.meta.exchange_rate} currency={data.meta.currency} />
      </CardBody>
    </Card>
  )
}

type BreakdownMetric = 'revenue' | 'spend' | 'roas'
const BREAKDOWN_METRICS: Array<{ key: BreakdownMetric; label: string; title: string }> = [
  { key: 'revenue', label: 'Revenue', title: 'Rank by revenue' },
  { key: 'spend', label: 'Ad Spend', title: 'Rank by ad spend' },
  { key: 'roas', label: 'ROAS', title: 'Rank by ROAS' },
]
const metricColor = (m: BreakdownMetric) => MMM_SERIES[m]

/** How many rows a ranking shows before "All" is picked. */
const TOP_N = 10
type Limit = 'top' | 'all'

/** Sort descending on a metric; a row with no value sinks to the bottom
 *  rather than being ranked as 0. */
function rankBy<T>(rows: T[], value: (row: T) => number | null): T[] {
  return [...rows].sort((a, b) => (value(b) ?? -Infinity) - (value(a) ?? -Infinity))
}

/** The strip under a ranking card's header: the measure, and — when there are
 *  more rows than TOP_N — the Top 10 / All switch. */
function RankControls({
  label,
  metric,
  onMetric,
  limit,
  onLimit,
  count,
  children,
}: {
  label: string
  metric: BreakdownMetric
  onMetric: (m: BreakdownMetric) => void
  limit: Limit
  onLimit: (l: Limit) => void
  count: number
  children?: React.ReactNode
}) {
  return (
    <div className="flex flex-wrap items-center gap-2 border-b border-border-subtle px-5 py-2.5">
      <Segmented ariaLabel={label} value={metric} onChange={onMetric} options={BREAKDOWN_METRICS} />
      {children}
      {count > TOP_N && (
        <span className="ml-auto">
          <Segmented
            ariaLabel="Rows shown"
            value={limit}
            onChange={onLimit}
            options={[
              { key: 'top', label: `Top ${TOP_N}` },
              { key: 'all', label: `All ${count}` },
            ]}
          />
        </span>
      )}
    </div>
  )
}

/** CHANNELS, THEN SUB-CHANNELS. The card opens on the dataset's channels
 *  (the families the sub-channels roll up into), ranked on the measure picked;
 *  clicking a channel drills into its sub-channels, and the breadcrumb climbs
 *  back. A row shows only the measure picked; every figure is on hover. The
 *  drill is the card's own view — it never changes the page's scope. */
export function ChannelCard({ data }: { data: MmmHub }) {
  const [metric, setMetric] = useState<BreakdownMetric>('spend')
  const [limit, setLimit] = useState<Limit>('top')
  const [drill, setDrill] = useState<string | null>(null)
  // Pie by default. Ad Spend and Revenue are parts of one whole — spend adds
  // to total spend, and Revenue here is ATTRIBUTED revenue (each day's revenue
  // shared among the channels on air that day by spend), which adds to the
  // revenue of the ad days. ROAS is a ratio, so it is always bars.
  const [chart, setChart] = useState<'bar' | 'pie'>('pie')
  const pie = chart === 'pie' && metric !== 'roas'
  // A channel the new scope no longer holds climbs back to the top level.
  const family = drill && data.families.some((f) => f.family === drill) ? drill : null
  const currency = data.meta.currency
  const measure = BREAKDOWN_METRICS.find((m) => m.key === metric)!.label
  const title = `${measure} by ${family ? 'Sub-channel' : 'Channel'}`

  type Family = MmmHub['families'][number]
  type Row = Family | MmmChannel
  const valueOf = (r: Row) => (metric === 'roas' ? r.roas : metric === 'revenue' ? r.revenue_attributed : r.spend)
  const displayOf = (r: Row) =>
    metric === 'roas' ? r.roas_display : metric === 'revenue' ? r.revenue_attributed_display : r.spend_display
  /** The share beside a bar: of total spend, or of attributed revenue. */
  const shareOf = (r: Row) =>
    metric === 'spend' ? r.share_display : metric === 'revenue' ? `${r.revenue_attributed_share.toFixed(2)}%` : ''
  // The tooltip: what the row is, its three figures (each with its share),
  // then what else was on during its active days.
  const details = (r: Row, extra: Array<[string, string, string?]>): Array<[string, string, string?]> => [
    ...extra,
    [`Ad spend (${currency})`, `${r.spend_display} · ${r.share_display}`, MMM_SERIES.spend],
    [`Revenue, attributed (${currency})`, `${r.revenue_attributed_display} · ${r.revenue_attributed_share.toFixed(2)}%`, MMM_SERIES.revenue],
    ['ROAS', r.roas_display, MMM_SERIES.roas],
  ]
  const mixOf = (r: Row) => ({ days: r.active_days, of: r.period_days, events: r.events })

  const subs = family ? rankBy(data.channels.filter((c) => c.family === family), valueOf) : []
  const families = rankBy(data.families, valueOf)
  const count = family ? subs.length : families.length
  const visibleSubs = limit === 'top' ? subs.slice(0, TOP_N) : subs
  const familyRow = family ? data.families.find((f) => f.family === family) : undefined

  return (
    <Card className="flex h-full flex-col">
      <CardHeader
        title={
          <PanelTitle
            title={title}
            about={[
              ['Channel', 'A group of sub-channels. Click one to see them.'],
              ['Revenue', 'Each day’s revenue shared across the channels running that day, by spend.'],
              ['Ad Spend', 'Money spent on the channel.'],
              ['ROAS', 'Extra revenue for every 1 spent. Above 1.00x pays back.'],
            ]}
          />
        }
      />
      <RankControls label="Channel measure" metric={metric} onMetric={setMetric} limit={pie ? 'all' : limit} onLimit={setLimit} count={pie ? 0 : count}>
        {metric !== 'roas' && (
          <span className="ml-auto">
            <Segmented
              ariaLabel="Chart type"
              value={chart}
              onChange={setChart}
              options={[
                { key: 'pie', label: 'Pie', title: 'Share of the whole' },
                { key: 'bar', label: 'Bar', title: 'Ranked bars' },
              ]}
            />
          </span>
        )}
      </RankControls>
      <CardBody className="flex max-h-[520px] flex-1 flex-col overflow-y-auto">
        {/* Inside a channel: the way back, and where the reader is — at the
            app's normal control size, not a caption. */}
        {family && (
          <nav aria-label="Channel level" className="mb-3 flex flex-wrap items-center gap-2 text-sm">
            <Button variant="secondary" size="sm" className="cursor-pointer !bg-surface-muted hover:!bg-surface-hover" onClick={() => setDrill(null)}>
              <Icon name="chevronLeft" /> All channels
            </Button>
            <span className="text-ink-disabled">/</span>
            <span className="font-bold text-ink-primary">{family}</span>
            <span className="text-ink-muted">
              · {subs.length} sub-channel{subs.length === 1 ? '' : 's'}
            </span>
          </nav>
        )}
        {families.length === 0 ? (
          <div className="grid min-h-[120px] place-items-center text-sm text-ink-muted">No channels in this selection.</div>
        ) : pie ? (
          <ShareDonut
            totalLabel={
              family ??
              (metric === 'revenue'
                ? data.meta.channels < data.meta.channels_total
                  ? 'Attributed revenue'
                  : 'Revenue on ad days'
                : 'Total ad spend')
            }
            totalDisplay={
              familyRow
                ? displayOf(familyRow)
                : metric === 'revenue'
                  ? data.revenue_attributed_total_display
                  : (data.kpis.find((k) => k.key === 'spend')?.display ?? '—')
            }
            onPick={family ? undefined : (key) => setDrill(key)}
            hint={family ? undefined : 'Click to see its sub-channels'}
            items={
              family
                ? subs.map((c) => ({
                    key: c.column,
                    label: c.label,
                    value: valueOf(c) ?? 0,
                    display: displayOf(c),
                    details: details(c, []),
                    mix: mixOf(c),
                  }))
                : families.map((f) => ({
                    key: f.family,
                    label: f.family,
                    value: valueOf(f) ?? 0,
                    display: displayOf(f),
                    details: details(f, [['Sub-channels', String(f.channels)]]),
                    mix: mixOf(f),
                  }))
            }
          />
        ) : family ? (
          <ShareBars
            fill
            color={metricColor(metric)}
            rows={visibleSubs.map((c) => ({
              key: c.column,
              label: c.label,
              value: valueOf(c) ?? 0,
              display: displayOf(c),
              share: shareOf(c),
              details: details(c, [['Channel', c.family || '—']]),
              mix: mixOf(c),
            }))}
          />
        ) : (
          <ShareBars
            fill
            color={metricColor(metric)}
            onPick={(key) => {
              setDrill(key)
              setLimit('top')
            }}
            hint="Click to see its sub-channels"
            rows={families.map((f) => ({
              key: f.family,
              label: f.family,
              value: valueOf(f) ?? 0,
              display: displayOf(f),
              share: shareOf(f),
              details: details(f, [['Sub-channels', String(f.channels)]]),
              mix: mixOf(f),
            }))}
          />
        )}
      </CardBody>
    </Card>
  )
}

/** REVENUE DECOMPOSITION — the scope's revenue by driver: the baseline (the
 *  KPI deck's own Baseline Revenue), then what the events and each channel
 *  added, split by a regression over the whole dataset (see
 *  app/mmm/decomposition.py). Follows every global filter. */
export function DecompositionCard({ data }: { data: MmmHub }) {
  const d = data.decomposition
  const [selected, setSelected] = useState<ReadonlySet<DriverKey>>(() => new Set())
  // Ad Spend opened into its channels. Any chip returns to the drivers.
  const [drilled, setDrilled] = useState(false)
  const toggle = (key: DriverKey) =>
    setSelected((prev) => {
      const next = new Set(prev)
      if (next.has(key)) next.delete(key)
      else next.add(key)
      return next
    })
  const present = (key: DriverKey) =>
    (d?.slices ?? []).some((sl) => (key === 'media' ? sl.kind === 'media' : sl.key === key) && sl.value > 0)
  const drivers = DRIVERS.filter((dr) => present(dr.key))
  return (
    <Card className="flex h-full flex-col">
      <CardHeader
        title={
          <PanelTitle
            title="Revenue Decomposition"
            about={[
              ['Baseline', 'Sales you would have made with no ads and no events.'],
              ['Festival · Seasonal · Promotion', 'What festival days, seasonal peaks and promotions added.'],
              ['Ad Spend', 'What the channels added, split across them by spend.'],
              ['Method', 'Revenue = b₀ + b·trend + b·spend + b·festival + b·seasonal + b·promotion, fitted on every day.'],
            ]}
          />
        }
      />
      {d?.available && (
        <div className="flex flex-wrap items-center gap-2 border-b border-border-subtle px-5 py-3">
          {/* Toggle chips, any combination — sized as buttons, since this
              card is driven by them. */}
          {drivers.map((dr) => {
            const on = selected.has(dr.key)
            return (
              <button
                key={dr.key}
                type="button"
                aria-pressed={on}
                onClick={() => {
                  setDrilled(false)
                  toggle(dr.key)
                }}
                // A selected chip wears its driver's own hue — tinted fill,
                // full-colour edge — so chip, slice and legend read as one.
                style={on ? { borderColor: dr.color, background: `color-mix(in srgb, ${dr.color} 14%, var(--surface-card))` } : undefined}
                className={`inline-flex h-8 cursor-pointer items-center gap-2 rounded-[var(--r-pill)] border px-3.5 text-sm font-semibold transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-violet ${
                  on ? 'text-ink-primary' : 'border-border-subtle text-ink-muted hover:bg-surface-hover hover:text-ink-primary'
                }`}
              >
                <span className="h-2.5 w-2.5 rounded-full" style={{ background: dr.color }} />
                {dr.label}
              </button>
            )
          })}
          {selected.size > 0 && (
            <button
              type="button"
              onClick={() => {
                setDrilled(false)
                setSelected(new Set())
              }}
              className="ml-1 cursor-pointer text-sm font-semibold text-brand-violet hover:underline focus:outline-none focus-visible:ring-1 focus-visible:ring-brand-violet"
            >
              Clear
            </button>
          )}
        </div>
      )}
      <CardBody className="flex flex-1 flex-col">
        {!d || !d.available ? (
          <div className="grid min-h-[250px] place-items-center text-sm text-ink-muted">{d?.reason || 'No revenue in this selection.'}</div>
        ) : (
          <>
            <DecompositionDonut
              slices={d.slices}
              totalDisplay={d.total_display}
              selected={selected}
              drilled={drilled}
              onDrill={setDrilled}
              format={(v) => axisMoney(v * data.meta.exchange_rate, data.meta.currency)}
            />
            {d.reason && <p className="mt-2 text-xs text-ink-muted">{d.reason}</p>}
          </>
        )}
      </CardBody>
    </Card>
  )
}

/** PROMOTION TYPES — one bar per offer type, ranked on the measure picked. */
export function PromotionsCard({ data }: { data: MmmHub }) {
  const [metric, setMetric] = useState<BreakdownMetric>('revenue')
  const [limit, setLimit] = useState<Limit>('top')
  type Promo = MmmHub['promotions'][number]
  const value = (p: Promo) =>
    metric === 'roas' ? p.roas : metric === 'revenue' ? p.revenue : p.spend
  const ranked = rankBy(data.promotions, value)
  const rows = limit === 'top' ? ranked.slice(0, TOP_N) : ranked
  const title =
    metric === 'revenue' ? 'Revenue by Promotion Type' : metric === 'spend' ? 'Ad Spend by Promotion Type' : 'ROAS by Promotion Type'
  const currency = data.meta.currency

  return (
    <Card className="flex h-full flex-col">
      <CardHeader
        title={
          <PanelTitle
            title={title}
            about={[
              ['Revenue', 'Total revenue on days the promotion ran.'],
              ['Ad Spend', 'Ad spend on those same days.'],
              ['ROAS', 'Extra revenue for every 1 spent. Above 1.00x pays back.'],
            ]}
          />
        }
      />
      <RankControls label="Promotion measure" metric={metric} onMetric={setMetric} limit={limit} onLimit={setLimit} count={data.promotions.length} />
      <CardBody className="flex flex-1 flex-col">
        {rows.length === 0 ? (
          <div className="grid min-h-[120px] place-items-center text-sm text-ink-muted">No promotion types in this selection.</div>
        ) : (
          // Columns, not the channel card's bars: a handful of offer types
          // read as a comparison of heights, and the plot fills the card to
          // the height of its neighbour. Only the measure picked is printed;
          // the rest is in the tooltip.
          <>
          {/* TPO's Sales by Region note: the switch above names the measure,
              so the one line here says where the ROAS is. */}
          {metric !== 'roas' && <div className="mb-2 text-right text-xs text-ink-muted">ROAS under each type</div>}
          <RankedColumns
            color={metricColor(metric)}
            format={
              metric === 'roas'
                ? tickFor('multiple', currency, 1)
                : tickFor('currency', currency, data.meta.exchange_rate)
            }
            ariaLabel={`${title}, ranked`}
            items={rows.map((p, i) => ({
              key: p.type,
              label: p.type,
              value: value(p),
              display:
                metric === 'revenue' ? p.revenue_display : metric === 'spend' ? p.spend_display : p.roas_display,
              // ROAS rides under every type, whatever the axis shows, unless
              // ROAS IS the axis — then it would repeat the column's label.
              sub: metric === 'roas' ? undefined : { text: p.roas_display, color: roasTone(p.roas) },
              details: [
                [`Revenue (${currency})`, p.revenue_display, MMM_SERIES.revenue],
                ['Rank', `#${i + 1} of ${rows.length} by ${BREAKDOWN_METRICS.find((m) => m.key === metric)?.label}`],
                ['Share of revenue', `${p.share_of_revenue.toFixed(2)}%`],
                [`Ad spend (${currency})`, p.spend_display, MMM_SERIES.spend],
                ['ROAS', p.roas_display, MMM_SERIES.roas],
                ['Days', p.days.toLocaleString()],
                ['Share of days', `${p.share_of_days.toFixed(2)}%`],
              ],
            }))}
          />
          </>
        )}
      </CardBody>
    </Card>
  )
}

/** BASELINE CALCULATION — the formula's steps for the selected range, with
 *  the averages and the day counts behind each. Shown so every ROAS on the
 *  page can be traced back to the days it came from. */
export function BaselineCard({ data }: { data: MmmHub }) {
  const b = data.baseline
  const rows: Array<[string, string, string, string]> = [
    ['X', 'Ad spend, and Festival, Seasonal and Promotion all 1', `${b.x_display}`, `${b.days.x} days`],
    ['Y', 'No ad spend, and all three flags 1', b.y_display, `${b.days.y} days`],
    ['Z = X − Y', 'Revenue from ad spend, per day', b.z_display, ''],
    ['R', 'Ad spend, and no flags', b.r_display, `${b.days.r} days`],
    ['R − Z', 'Baseline revenue per day', b.per_day_display, ''],
  ]
  return (
    <Card className="flex h-full flex-col">
      <CardHeader
        title={
          <PanelTitle
            title="Baseline Calculation"
            about={[
              ['Baseline per day', 'R − (X − Y). X, Y and R are each an average daily revenue.'],
              ['Baseline revenue', 'Baseline per day × days in scope.'],
              ['Per range', 'Re-estimated whenever the range changes. Never a fixed figure for the file.'],
            ]}
          />
        }
        subtitle={b.window.label ? `Estimated over ${b.window.label}` : undefined}
      />
      {!b.available ? (
        <CardBody>
          <div className="grid min-h-[140px] place-items-center px-4 text-center text-sm text-ink-muted">{b.reason}</div>
        </CardBody>
      ) : (
        <>
          <div className="overflow-x-auto">
            <Table>
              <thead>
                <tr>
                  <Th>Step</Th>
                  <Th>Days</Th>
                  <Th className="text-right">Avg / day</Th>
                </tr>
              </thead>
              <tbody>
                {rows.map(([step, what, value, days]) => (
                  <Tr key={step}>
                    <Td emphasis>
                      <div>{step}</div>
                      <div className="text-xs font-normal text-ink-muted">{what}</div>
                    </Td>
                    <Td className="tabular-nums text-ink-muted">{days}</Td>
                    <Td className={`text-right tabular-nums ${step === 'R − Z' ? 'font-bold text-ink-primary' : ''}`}>{value}</Td>
                  </Tr>
                ))}
              </tbody>
            </Table>
          </div>
          <CardBody className="pt-3">
            <div className="flex items-baseline justify-between gap-3 rounded-[var(--r-md)] bg-surface-muted p-[10px_14px]">
              <span className="text-sm text-ink-muted">
                Baseline revenue · {b.scope_days.toLocaleString()} days
              </span>
              <span className="text-lg font-extrabold tabular-nums text-ink-primary">{b.total_display}</span>
            </div>
            {b.widened && (
              <Caveat>
                The selected range has no day of one of the three kinds, so the window was widened a week at a time, on
                both sides, until it had one of each: {b.window.label}.
              </Caveat>
            )}
          </CardBody>
        </>
      )}
    </Card>
  )
}
