import { useState } from 'react'
import { Card, CardBody, CardHeader, Table, Td, Th, Tr } from '../../components/ui'
import { InfoBlock, InfoPopover } from '../../components/ui/InfoPopover'
import { TipRow } from '../../components/command/ChartSections'
import { Segmented } from '../../components/command/Segmented'
import { Stale } from '../../components/command/States'
import { Icon } from '../../icons'
import { FILL, MMM_SERIES, PairedColumns, RankedColumns, ShareBars, ValueColumns, axisMoney } from './charts'
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

/** One plain line per comparison measure for the ⓘ. The backend's
 *  `formula` is the full derivation; this is what a reader needs. */
const SHORT_DEFINITION: Record<string, string> = {
  revenue: 'Total sales in the period.',
  spend: 'Total spent on ads.',
  roas: 'Extra revenue for every 1 spent. Above 1.00x pays back.',
  baseline: 'Sales you would have made with no ads.',
  incremental: 'Sales the ads added: Revenue − Baseline.',
  baseline_per_day: 'No-ads sales per day.',
  avg_daily_revenue: 'Revenue per day.',
  ad_lift: 'Extra revenue per day on ad days.',
  media_days: 'Days with any ad spend.',
}

/** A metric value in the comparison's own unit, for the axis. */
function tickFor(unit: string, currency: string, rate: number) {
  if (unit === 'multiple') return (v: number) => `${v.toFixed(2)}x`
  if (unit === 'count') return (v: number) => v.toFixed(0)
  return (v: number) => axisMoney(v * rate, currency)
}

const MONTH_ABBR = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
/** The month select's "no month" option: the page's own period for that year. */
const WHOLE = 0

type ComparisonKind = 'yago' | 'pago' | 'mago' | 'ytd'
const COMPARISONS: Array<{ key: ComparisonKind; label: string; title: string }> = [
  { key: 'yago', label: 'YAGO', title: 'Year Ago' },
  { key: 'pago', label: 'PAGO', title: 'Period Ago' },
  { key: 'mago', label: 'MAGO', title: 'Month Ago' },
  { key: 'ytd', label: 'YTD', title: 'Year to Date vs the same window last year' },
]

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
  const source = sameAsPage ? data : (own.data ?? data)
  const loading = !sameAsPage && (own.isFetching || !own.data)

  const cmp = source.comparison
  const spec = cmp.metrics.find((m) => m.key === metricKey) ?? cmp.metrics[0]
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
          {cmp.metrics.map((m) => (
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
          <Swatch fill={FILL.current} label={ytd ? 'Year to date' : 'Selected'} />
          <Swatch fill={FILL.against} label="Compared with" outline />
          <span className="ml-auto truncate">{spec.label}</span>
        </div>
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
        <div className="mt-2 flex items-end justify-between gap-3 border-t border-border-subtle pt-2.5">
          <div className="grid min-w-0 grid-cols-2 gap-x-4">
            <div className="min-w-0">
              <div className="truncate text-xs text-ink-muted" title={cmp.period_label}>{cmp.period_label}</div>
              <div className="text-lg font-extrabold tabular-nums text-ink-primary">{current.display}</div>
            </div>
            <div className="min-w-0">
              <div className="truncate text-xs text-ink-muted" title={win.period_label}>{win.period_label || win.full}</div>
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

type BreakdownMetric = 'revenue' | 'spend' | 'roas' | 'avg'
const BREAKDOWN_METRICS: Array<{ key: BreakdownMetric; label: string; title: string }> = [
  { key: 'revenue', label: 'Revenue', title: 'Rank by revenue' },
  { key: 'spend', label: 'Ad Spend', title: 'Rank by ad spend' },
  { key: 'roas', label: 'ROAS', title: 'Rank by ROAS' },
  { key: 'avg', label: 'Avg / Day', title: 'Rank by average revenue per day' },
]
const metricColor = (m: BreakdownMetric) => (m === 'avg' ? MMM_SERIES.revenue : MMM_SERIES[m])

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
  caption = true,
}: {
  /** The "Rank by" words before the switch. */
  caption?: boolean
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
      <span className="inline-flex items-center gap-1.5 text-xs text-ink-muted">
        {caption && <span>Rank by</span>}
        <Segmented ariaLabel={label} value={metric} onChange={onMetric} options={BREAKDOWN_METRICS} />
      </span>
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

const ALL_FAMILIES = '__all__'

/** CHANNELS — one bar per media channel, ranked on the measure picked. A row
 *  shows only that measure; the channel's every figure is on hover. The
 *  family switch narrows the card to one channel family — a card-level view
 *  filter, as TPO's Mechanic switch is on Channel Performance; it never
 *  changes the page's scope. */
export function ChannelCard({ data }: { data: MmmHub }) {
  const [metric, setMetric] = useState<BreakdownMetric>('spend')
  const [limit, setLimit] = useState<Limit>('top')
  const [family, setFamily] = useState(ALL_FAMILIES)
  const families = [...new Set(data.channels.map((c) => c.family).filter(Boolean))].sort()
  // A family the new scope no longer holds falls back to all of them, so the
  // card never sits on an empty selection.
  const shownFamily = families.includes(family) ? family : ALL_FAMILIES
  const pool = shownFamily === ALL_FAMILIES ? data.channels : data.channels.filter((c) => c.family === shownFamily)
  const value = (c: MmmChannel) =>
    metric === 'avg' ? c.avg_active_day : metric === 'roas' ? c.roas : metric === 'revenue' ? c.revenue : c.spend
  const ranked = rankBy(pool, value)
  const rows = limit === 'top' ? ranked.slice(0, TOP_N) : ranked
  const title = metric === 'spend' ? 'Ad Spend by Channel' : metric === 'revenue' ? 'Revenue by Channel' : metric === 'roas' ? 'ROAS by Channel' : 'Avg Revenue per Active Day by Channel'
  const currency = data.meta.currency

  return (
    <Card className="flex h-full flex-col">
      <CardHeader
        title={
          <PanelTitle
            title={title}
            about={[
              ['Revenue', 'Total revenue on days the channel was running.'],
              ['Ad Spend', 'Money spent on the channel.'],
              ['ROAS', 'Extra revenue for every 1 spent. Above 1.00x pays back.'],
              ['Avg / Day', 'Revenue per day the channel was running.'],
            ]}
          />
        }
      />
      <RankControls caption={false} label="Channel measure" metric={metric} onMetric={setMetric} limit={limit} onLimit={setLimit} count={pool.length}>
        {families.length > 1 && (
          <span className="inline-flex items-center gap-1.5 text-xs text-ink-muted">
            <span>Family</span>
            <Select aria-label="Channel family" value={shownFamily} onChange={(e) => setFamily(e.target.value)}>
              <option value={ALL_FAMILIES}>All families</option>
              {families.map((f) => (
                <option key={f} value={f}>
                  {f}
                </option>
              ))}
            </Select>
          </span>
        )}
      </RankControls>
      <CardBody className="max-h-[520px] flex-1 overflow-y-auto">
        {rows.length === 0 ? (
          <div className="grid min-h-[120px] place-items-center text-sm text-ink-muted">No channels in this selection.</div>
        ) : (
          <ShareBars
            inline
            color={metricColor(metric)}
            rows={rows.map((c) => ({
              key: c.column,
              label: c.label,
              value: value(c) ?? 0,
              display:
                metric === 'revenue' ? c.revenue_display : metric === 'spend' ? c.spend_display : metric === 'roas' ? c.roas_display : c.avg_active_day_display,
              // Only the measure picked is on the row, plus — on Ad Spend —
              // its share of the total, the one share that adds to 100%
              // (channels' on-air revenue overlaps; ROAS and Avg / Day are
              // ratios). Everything else is in the hover tooltip.
              share: metric === 'spend' ? c.share_display : '',
              details: [
                ['Family', c.family || '—'],
                [`Ad spend (${currency})`, c.spend_display, MMM_SERIES.spend],
                ['Share of ad spend', c.share_display],
                [`Revenue on air (${currency})`, c.revenue_display, MMM_SERIES.revenue],
                ['ROAS', c.roas_display, MMM_SERIES.roas],
                ['Active days', c.active_days.toLocaleString()],
                ['Avg revenue / active day', c.avg_active_day_display],
              ],
            }))}
          />
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
    metric === 'avg' ? p.avg_revenue : metric === 'roas' ? p.roas : metric === 'revenue' ? p.revenue : p.spend
  const ranked = rankBy(data.promotions, value)
  const rows = limit === 'top' ? ranked.slice(0, TOP_N) : ranked
  const title =
    metric === 'revenue' ? 'Revenue by Promotion Type' : metric === 'spend' ? 'Ad Spend by Promotion Type' : metric === 'roas' ? 'ROAS by Promotion Type' : 'Avg Daily Revenue by Promotion Type'
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
              ['Avg / Day', 'Revenue per promotion day.'],
            ]}
          />
        }
      />
      <RankControls caption={false} label="Promotion measure" metric={metric} onMetric={setMetric} limit={limit} onLimit={setLimit} count={data.promotions.length} />
      <CardBody className="flex flex-1 flex-col">
        {rows.length === 0 ? (
          <div className="grid min-h-[120px] place-items-center text-sm text-ink-muted">No promotion types in this selection.</div>
        ) : (
          // Columns, not the channel card's bars: a handful of offer types
          // read as a comparison of heights, and the plot fills the card to
          // the height of its neighbour. Only the measure picked is printed;
          // the rest is in the tooltip.
          <>
          <div className="mb-1.5 flex flex-wrap items-center gap-x-3.5 gap-y-1 text-xs text-ink-muted">
            <Swatch fill={metricColor(metric)} label={BREAKDOWN_METRICS.find((m) => m.key === metric)?.label ?? ''} />
            {metric !== 'roas' && (
              <span className="inline-flex items-center gap-1.5">
                <span className="h-2.5 w-2.5 rounded-full" style={{ background: MMM_SERIES.roas }} />
                ROAS (right axis)
              </span>
            )}
          </div>
          <RankedColumns
            color={metricColor(metric)}
            overlay={
              metric === 'roas'
                ? undefined
                : { color: MMM_SERIES.roas, values: rows.map((p) => p.roas), format: (v) => `${v.toFixed(2)}x` }
            }
            format={
              metric === 'roas'
                ? tickFor('multiple', currency, 1)
                : tickFor('currency', currency, data.meta.exchange_rate)
            }
            ariaLabel={`${title}, ranked`}
            items={rows.map((p) => ({
              key: p.type,
              label: p.type,
              value: value(p),
              display:
                metric === 'revenue' ? p.revenue_display : metric === 'spend' ? p.spend_display : metric === 'roas' ? p.roas_display : p.avg_revenue_display,
              details: [
                [`Revenue (${currency})`, p.revenue_display, MMM_SERIES.revenue],
                ['Share of revenue', `${p.share_of_revenue.toFixed(2)}%`],
                [`Ad spend (${currency})`, p.spend_display, MMM_SERIES.spend],
                ['ROAS', p.roas_display, MMM_SERIES.roas],
                ['Days', p.days.toLocaleString()],
                ['Share of days', `${p.share_of_days.toFixed(2)}%`],
                ['Avg revenue / day', p.avg_revenue_display],
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
    ['X', 'Ad spend, and Holiday, Trending and Promotion all 1', `${b.x_display}`, `${b.days.x} days`],
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
