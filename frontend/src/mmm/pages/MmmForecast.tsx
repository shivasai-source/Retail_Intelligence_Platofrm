import { useMemo, useRef, useState, type ReactNode } from 'react'
import { useNavigate } from 'react-router-dom'
import { Card, CardBody, Spinner } from '../../components/ui'
import { InfoPopover } from '../../components/ui/InfoPopover'
import { Icon } from '../../icons'
import { useChartWidth } from '../../components/charts/useChartWidth'
import { niceTicks } from '../../components/planner/ticks'
import { axisMoney, Panel, Segmented, StaleOverlay, TYPE } from '../../components/planner/shared'
import { MmmShell } from '../components/MmmShell'
import { useBudgetStatus, type FigureKey, type ModelCard } from '../budget'
import {
  useForecastReset,
  useForecastStatus,
  useForecastSummary,
  useForecastUpload,
  type ForecastChannel,
  type ForecastPoint,
  type ForecastSummary,
  type ForecastYear,
  type Grain,
} from '../forecast'
import { MMM_ROUTES } from '../nav'
import { TrainingCard } from './MmmBudget'

/** THE MMM REVENUE FORECAST -- laid out as the Budget Optimizer.
 *
 *  Upload a daily ad plan for dates after the data, without Revenue; the page
 *  predicts each day's revenue with the Budget Optimizer's fitted model (with
 *  its P10 - P90), and the profit and KPIs that follow. The plan's weeks can
 *  then be planned in the Budget Optimizer and the Budget Allocator
 *  (`?source=forecast`). Every figure is the backend's (app/mmm/forecast.py). */

const NOW = 'var(--text-primary)'
const PLAN = 'var(--brand-violet)'
const MONTH = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
/** "2026-09-14" -> "14 Sep 2026". */
const dateText = (iso: string) => {
  const [y, m, d] = iso.split('-')
  return y && m && d ? `${d} ${MONTH[Number(m) - 1]} ${y}` : iso
}

export function MmmForecast() {
  const model = useBudgetStatus()
  const ready = model.data?.status === 'ready'
  const status = useForecastStatus()
  const loaded = !!status.data?.loaded
  const [currency, setCurrency] = useState<'INR' | 'USD'>('INR')
  const summary = useForecastSummary(ready && loaded, currency)
  const fs = summary.data
  const upload = useForecastUpload()
  const fmt = (v: number) => axisMoney(v, fs?.exchange_rate ?? 1, fs?.currency ?? currency)

  return (
    <MmmShell activeKey="forecast" page="Revenue Forecast">
      <div className="fade-in flex flex-wrap items-center justify-between gap-x-4 gap-y-3">
        <h1 className="flex items-center gap-2 text-2xl font-normal tracking-[-0.02em]">
          Revenue Forecast <Icon name="sparkles" className="h-5 w-5 text-brand-violet" />
          <HowItWorks model={fs?.model} />
        </h1>
        <Segmented
          label="Currency"
          value={currency}
          onChange={setCurrency}
          options={[
            { value: 'INR', label: '₹ INR' },
            { value: 'USD', label: '$ USD' },
          ]}
        />
      </div>

      {!ready && <TrainingCard status={model.data} error={model.error} />}

      {ready && status.isPending && (
        <div className={`mt-6 flex items-center gap-3 ${TYPE.label}`}>
          <Spinner /> Loading…
        </div>
      )}

      {ready && status.data && !loaded && (
        <UploadPanel onFile={(f) => upload.mutate(f)} busy={upload.isPending} error={upload.error} />
      )}

      {ready && loaded && (
        <>
          <PlanBar summary={fs} name={status.data?.name} onFile={(f) => upload.mutate(f)} busy={upload.isPending} />
          {upload.error && <ErrorCard title="That file could not be used" message={upload.error.message} />}
          {summary.isPending && (
            <div className={`mt-6 flex items-center gap-3 ${TYPE.label}`}>
              <Spinner /> Predicting revenue…
            </div>
          )}
          {summary.isError && <ErrorCard title="Could not forecast this plan" message={summary.error.message} />}
          {fs && (
            <StaleOverlay on={summary.isFetching || upload.isPending}>
              {fs.plan.notes.length > 0 && <Notes notes={fs.plan.notes} />}
              <Kpis s={fs} />
              <PlanIt s={fs} />
              <Panel title="Forecast over time" className="mt-5">
                <OverTime s={fs} format={fmt} />
              </Panel>
              <Panel title="Year by year" className="mt-5">
                <Years rows={fs.years} />
              </Panel>
              <Panel title="Channels in the plan" className="mt-5">
                <Channels rows={fs.channels} />
              </Panel>
            </StaleOverlay>
          )}
        </>
      )}
    </MmmShell>
  )
}

function ErrorCard({ title, message }: { title: string; message: string }) {
  return (
    <Card className="mt-4">
      <CardBody>
        <div className="flex items-start gap-3 [&_svg]:h-5 [&_svg]:w-5">
          <Icon name="alertTriangle" className="mt-0.5 shrink-0 text-status-danger" />
          <div>
            <div className="text-md font-medium text-ink-primary">{title}</div>
            <div className={`mt-1 ${TYPE.label}`}>{message}</div>
          </div>
        </div>
      </CardBody>
    </Card>
  )
}

// --- uploading --------------------------------------------------------------

function SampleLinks() {
  return (
    <div className="flex flex-wrap items-center gap-2">
      <span className={`${TYPE.label} !text-ink-muted`}>Sample plans:</span>
      {[1, 2, 3, 4, 5].map((n) => (
        <a
          key={n}
          href={`/api/mmm/forecast/sample/${n}`}
          download
          className="inline-flex h-9 items-center gap-1.5 rounded-full border border-border-default bg-surface-card px-3 text-base text-ink-secondary transition-colors hover:border-brand-violet hover:text-brand-violet [&_svg]:h-3.5 [&_svg]:w-3.5"
        >
          <Icon name="download" /> {n} year{n > 1 ? 's' : ''}
        </a>
      ))}
    </div>
  )
}

function UploadPanel({ onFile, busy, error }: { onFile: (f: File) => void; busy: boolean; error: Error | null }) {
  const input = useRef<HTMLInputElement>(null)
  const [over, setOver] = useState(false)
  return (
    <Panel title="Upload a future ad plan" className="mt-5">
      <div
        role="button"
        tabIndex={0}
        onClick={() => input.current?.click()}
        onKeyDown={(e) => (e.key === 'Enter' || e.key === ' ') && input.current?.click()}
        onDragOver={(e) => {
          e.preventDefault()
          setOver(true)
        }}
        onDragLeave={() => setOver(false)}
        onDrop={(e) => {
          e.preventDefault()
          setOver(false)
          const f = e.dataTransfer.files[0]
          if (f) onFile(f)
        }}
        className={`flex cursor-pointer flex-col items-center justify-center gap-2 rounded-[var(--r-lg)] border-2 border-dashed px-6 py-12 text-center transition-colors ${
          over ? 'border-brand-violet bg-brand-violet-50' : 'border-border-default hover:border-brand-violet hover:bg-surface-hover'
        }`}
      >
        <span className="grid h-12 w-12 place-items-center rounded-xl bg-brand-violet-50 text-brand-violet [&_svg]:h-5 [&_svg]:w-5">
          {busy ? <Spinner /> : <Icon name="download" className="rotate-180" />}
        </span>
        <div className="text-md font-medium text-ink-primary">{busy ? 'Reading the plan…' : 'Drop a CSV here, or click to choose one'}</div>
        <div className={`max-w-[640px] ${TYPE.label} !text-ink-muted`}>
          One row per day, starting after the last day of the installed data. The same columns as the data, without Revenue: Date, each
          channel’s spend (TV_Spend, Meta_Ads_Spend, …; 0 on days without ads), and the festival, seasonal and promotion flags, discount and
          promotion type.
        </div>
        <input
          ref={input}
          type="file"
          accept=".csv,text/csv"
          className="hidden"
          onChange={(e) => {
            const f = e.target.files?.[0]
            if (f) onFile(f)
            e.target.value = ''
          }}
        />
      </div>
      <div className="mt-4">
        <SampleLinks />
      </div>
      {error && (
        <div className="mt-4 flex items-start gap-2 rounded-[var(--r-md)] border border-status-danger/30 bg-status-danger/5 px-4 py-3 text-base text-ink-primary [&_svg]:h-4 [&_svg]:w-4">
          <Icon name="alertTriangle" className="mt-0.5 shrink-0 text-status-danger" />
          {error.message}
        </div>
      )}
    </Panel>
  )
}

function PlanBar({ summary: s, name, onFile, busy }: { summary?: ForecastSummary; name?: string; onFile: (f: File) => void; busy: boolean }) {
  const input = useRef<HTMLInputElement>(null)
  const reset = useForecastReset()
  const btn =
    'inline-flex h-10 cursor-pointer items-center gap-2 rounded-[var(--r-md)] border border-border-default bg-surface-card px-3.5 text-base text-ink-secondary transition-colors hover:border-brand-violet hover:text-brand-violet disabled:cursor-not-allowed disabled:opacity-50 [&_svg]:h-4 [&_svg]:w-4'
  return (
    <div className="mt-4 flex flex-wrap items-center justify-between gap-3 rounded-[var(--r-lg)] border border-border-subtle bg-surface-card px-5 py-3 shadow-[var(--shadow-card-soft)]">
      <div className="flex min-w-0 items-center gap-3">
        <span className="grid h-10 w-10 shrink-0 place-items-center rounded-xl bg-brand-violet-50 text-brand-violet [&_svg]:h-4 [&_svg]:w-4">
          <Icon name="file" />
        </span>
        <div className="min-w-0">
          <div className="truncate text-md font-medium text-ink-primary">{name ?? 'Future plan'}</div>
          {s && (
            <div className="text-base text-ink-muted">
              {dateText(s.plan.start)} – {dateText(s.plan.end)} · {s.plan.days.toLocaleString()} days · {s.plan.ad_days.toLocaleString()} with ads ·{' '}
              {s.plan.channels} channels
            </div>
          )}
        </div>
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <button type="button" className={btn} disabled={busy} onClick={() => input.current?.click()}>
          {busy ? <Spinner /> : <Icon name="refresh" />} Replace file
        </button>
        <a className={btn} href="/api/mmm/forecast/download" download>
          <Icon name="download" /> Download predictions
        </a>
        <button type="button" className={btn} disabled={reset.isPending} onClick={() => reset.mutate()}>
          <Icon name="x" /> Remove
        </button>
        <input
          ref={input}
          type="file"
          accept=".csv,text/csv"
          className="hidden"
          onChange={(e) => {
            const f = e.target.files?.[0]
            if (f) onFile(f)
            e.target.value = ''
          }}
        />
      </div>
    </div>
  )
}

function Notes({ notes }: { notes: string[] }) {
  return (
    <div className="mt-4 rounded-[var(--r-md)] border border-status-warning/30 bg-status-warning/5 px-4 py-3 text-base text-ink-secondary">
      <div className="flex items-center gap-2 font-medium text-ink-primary [&_svg]:h-4 [&_svg]:w-4">
        <Icon name="info" className="text-status-warning" /> Read with these assumptions
      </div>
      <ul className="mt-1 list-disc pl-6">
        {notes.map((n) => (
          <li key={n}>{n}</li>
        ))}
      </ul>
    </div>
  )
}

// --- the KPIs ---------------------------------------------------------------

function Kpis({ s }: { s: ForecastSummary }) {
  const f = s.figures
  const stats: { key: FigureKey; label: string; icon: Parameters<typeof Icon>[0]['name']; info: string }[] = [
    { key: 'revenue', label: 'Revenue', icon: 'wallet', info: 'Baseline + media-driven revenue, predicted' },
    { key: 'profit', label: 'Net profit', icon: 'coins', info: 'Revenue − ad spend' },
    { key: 'profit_pct', label: 'Profit %', icon: 'trending', info: 'Net profit ÷ ad spend × 100' },
    { key: 'spend', label: 'Ad spend', icon: 'tag', info: 'The plan’s total spend, as uploaded' },
    { key: 'roas', label: 'ROAS', icon: 'gauge', info: 'Media-driven revenue ÷ ad spend' },
    { key: 'incremental', label: 'Media revenue', icon: 'uplift', info: 'What the ads add over the baseline' },
  ]
  return (
    <div className="fade-in mt-4 rounded-[var(--r-lg)] border border-border-subtle bg-surface-card shadow-[var(--shadow-card-soft)]">
      <div className="flex flex-wrap items-baseline gap-x-3 border-b border-border-subtle px-5 py-3">
        <span className="text-md font-medium text-ink-primary">Forecast</span>
        <span className="text-base text-ink-muted">
          {dateText(s.plan.start)} – {dateText(s.plan.end)} · baseline revenue {f.baseline.display} (no ads) · ranges P10 – P90 over {s.draws} model
          refits
        </span>
      </div>
      {/* Three across, so each figure's P10 - P90 fits beside it. */}
      <div className="grid grid-cols-3 @max-[700px]:grid-cols-1">
        {stats.map((st, i) => (
          <div
            key={st.key}
            className={`flex items-center gap-3 border-border-subtle px-5 py-4 ${i % 3 ? 'border-l @max-[700px]:border-l-0' : ''} ${i >= 3 ? 'border-t' : ''}`}
            title={st.info}
          >
            <span className="grid h-10 w-10 shrink-0 place-items-center rounded-xl bg-brand-violet-50 text-brand-violet [&_svg]:h-4 [&_svg]:w-4">
              <Icon name={st.icon} />
            </span>
            <div className="min-w-0">
              <div className={`truncate ${TYPE.label}`}>{st.label}</div>
              <div className={`mt-0.5 truncate ${TYPE.value}`}>{f[st.key].display}</div>
              <div className={`truncate ${TYPE.eyebrow}`}>{f[st.key].range?.display ?? 'as planned'}</div>
            </div>
          </div>
        ))}
      </div>
    </div>
  )
}

/** Where the forecast goes next: its weeks, planned in the optimizer or the allocator. */
function PlanIt({ s }: { s: ForecastSummary }) {
  const navigate = useNavigate()
  const go = (route: string) => navigate(`${route}?source=forecast`)
  const btn =
    'inline-flex h-10 cursor-pointer items-center gap-2 rounded-[var(--r-md)] px-4 text-base font-medium transition-colors [&_svg]:h-4 [&_svg]:w-4'
  return (
    <Panel tone="violet" className="mt-5">
      <div className="flex flex-wrap items-center justify-between gap-4">
        <div className="min-w-0">
          <div className="text-md font-medium text-ink-primary">Plan this forecast</div>
          <div className={`mt-1 ${TYPE.label}`}>
            Open the plan’s weeks in the Budget Optimizer, to move its budget for more profit, or in the Budget Allocator, to try another budget.
            {!s.optimize_default && ' The plan has no whole week to plan.'}
          </div>
        </div>
        <div className="flex flex-wrap gap-2">
          <button
            type="button"
            disabled={!s.optimize_default}
            onClick={() => go(MMM_ROUTES.budget)}
            className={`${btn} bg-brand-violet text-white hover:opacity-90 disabled:opacity-50`}
          >
            <Icon name="sparkles" /> Optimize in Budget Optimizer <Icon name="arrowRight" />
          </button>
          <button
            type="button"
            disabled={!s.optimize_default}
            onClick={() => go(MMM_ROUTES.allocator)}
            className={`${btn} border border-brand-violet bg-surface-card text-brand-violet hover:bg-brand-violet-50 disabled:opacity-50`}
          >
            <Icon name="coins" /> Set a budget in Budget Allocator <Icon name="arrowRight" />
          </button>
        </div>
      </div>
    </Panel>
  )
}

// --- over time --------------------------------------------------------------

type Metric = 'revenue' | 'profit' | 'media' | 'spend'

const METRICS: { value: Metric; label: string }[] = [
  { value: 'revenue', label: 'Revenue' },
  { value: 'profit', label: 'Net profit' },
  { value: 'media', label: 'Media revenue' },
  { value: 'spend', label: 'Ad spend' },
]

function OverTime({ s, format }: { s: ForecastSummary; format: (v: number) => string }) {
  const [metric, setMetric] = useState<Metric>('revenue')
  // A long plan reads best by month, a short one by week.
  const [grain, setGrain] = useState<Grain>(s.plan.days > 400 ? 'month' : 'week')
  const points = s.series[grain]
  const totals = s.figures
  return (
    <div>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <Segmented label="Measure" value={metric} onChange={setMetric} options={METRICS} />
        <Segmented
          label="Grain"
          value={grain}
          onChange={setGrain}
          options={[
            { value: 'day', label: 'Daily' },
            { value: 'week', label: 'Weekly' },
            { value: 'month', label: 'Monthly' },
          ]}
        />
      </div>
      <TimeChart points={points} metric={metric} grain={grain} format={format} />
      <p className={`mt-3 leading-relaxed ${TYPE.label}`}>
        Over the plan: revenue {totals.revenue.display} ({totals.revenue.range?.display}), of which {totals.baseline.display} is baseline — what
        the days earn without ads — and {totals.incremental.display} is driven by {totals.spend.display} of ads.
        {grain !== 'day' && ' The first and last periods may be partial.'}
      </p>
    </div>
  )
}

function TimeChart({ points, metric, grain, format }: { points: ForecastPoint[]; metric: Metric; grain: Grain; format: (v: number) => string }) {
  const { ref, width: w } = useChartWidth(720)
  const [hover, setHover] = useState<number | null>(null)
  const H = 340
  const padR = 18
  const padT = 14
  const padB = 52
  const bars = metric === 'spend'
  const main = (p: ForecastPoint) => (metric === 'revenue' ? p.revenue : metric === 'profit' ? p.profit : metric === 'media' ? p.media : p.spend)
  const band = (p: ForecastPoint): [number, number] | null =>
    metric === 'revenue' ? p.revenue_range : metric === 'profit' ? p.profit_range : metric === 'media' ? p.media_range : null
  const values = points.flatMap((p) => [main(p), ...(band(p) ?? []), ...(metric === 'revenue' ? [p.baseline] : [])])
  const lo0 = bars ? 0 : Math.min(...values)
  const hi0 = Math.max(...values, 1)
  const pad = bars ? 0 : (hi0 - lo0) * 0.06
  const yt = niceTicks(Math.max(0, lo0 - pad), hi0 + pad)
  const y0 = bars ? 0 : Math.min(yt[0], lo0)
  const y1 = Math.max(yt[yt.length - 1], hi0)
  const padL = Math.max(64, Math.max(...yt.map((t) => format(t).length)) * 9 + 30)
  const innerW = Math.max(1, w - padL - padR)
  const n = points.length
  const slot = innerW / Math.max(n, 1)
  const x = (i: number) => padL + slot * (i + 0.5)
  const y = (v: number) => padT + (1 - (v - y0) / (y1 - y0)) * (H - padT - padB)
  const line = (pick: (p: ForecastPoint) => number) => points.map((p, i) => `${i ? 'L' : 'M'} ${x(i)} ${y(pick(p))}`).join(' ')

  // X labels: one at each new month ("Oct 26"), thinned to fit.
  const ticks = useMemo(() => {
    const out: { i: number; text: string }[] = []
    let prev = ''
    points.forEach((p, i) => {
      const [yy, mm] = p.start.split('-')
      if (`${yy}-${mm}` !== prev) out.push({ i, text: `${MONTH[Number(mm) - 1]} ${yy.slice(2)}` })
      prev = `${yy}-${mm}`
    })
    const every = Math.max(1, Math.ceil(out.length / Math.max(1, Math.floor(innerW / 64))))
    return out.filter((_, j) => j % every === 0)
  }, [points, innerW])

  const hp = hover != null ? points[hover] : null
  const legend: { label: string; node: ReactNode }[] = bars
    ? [{ label: 'Ad spend', node: <span className="inline-block h-2.5 w-3 rounded-sm" style={{ background: PLAN }} /> }]
    : [
        { label: METRICS.find((m) => m.value === metric)!.label, node: <span className="inline-block h-0.5 w-5 rounded" style={{ background: PLAN }} /> },
        { label: 'P10 / P90', node: <span className="inline-block w-5 border-t-2 border-dashed" style={{ borderColor: PLAN, opacity: 0.6 }} /> },
        ...(metric === 'revenue' ? [{ label: 'Baseline (no ads)', node: <span className="inline-block h-0.5 w-5 rounded" style={{ background: NOW }} /> }] : []),
      ]
  return (
    <div>
      <div className="mt-4 flex flex-wrap items-center gap-x-5 gap-y-1 text-base text-ink-secondary">
        {legend.map((l) => (
          <span key={l.label} className="inline-flex items-center gap-1.5">
            {l.node} {l.label}
          </span>
        ))}
      </div>
      <div ref={ref} className="relative mt-3" onMouseLeave={() => setHover(null)}>
        <svg
          viewBox={`0 0 ${w} ${H}`}
          width="100%"
          height={H}
          role="img"
          aria-label={`${METRICS.find((m) => m.value === metric)!.label} forecast by ${grain}`}
          onMouseMove={(e) => {
            const r = e.currentTarget.getBoundingClientRect()
            const px = ((e.clientX - r.left) / r.width) * w
            const i = Math.floor((px - padL) / slot)
            setHover(i >= 0 && i < n ? i : null)
          }}
        >
          {yt.map((t) => (
            <g key={`y${t}`}>
              <line x1={padL} x2={padL + innerW} y1={y(t)} y2={y(t)} stroke="var(--border-subtle)" />
              <text x={padL - 8} y={y(t) + 4} textAnchor="end" fontSize={15} fill="var(--text-muted)">
                {format(t)}
              </text>
            </g>
          ))}
          <line x1={padL} x2={padL + innerW} y1={H - padB} y2={H - padB} stroke="var(--border-default)" />
          {ticks.map((t) => (
            <text key={t.i} x={x(t.i)} y={H - padB + 22} textAnchor="middle" fontSize={15} fill="var(--text-muted)">
              {t.text}
            </text>
          ))}
          {bars ? (
            points.map((p, i) => (
              <rect
                key={i}
                x={x(i) - Math.max(0.5, slot * 0.35)}
                width={Math.max(1, slot * 0.7)}
                y={y(p.spend)}
                height={Math.max(0, y(0) - y(p.spend))}
                fill={PLAN}
                opacity={hover === i ? 1 : 0.85}
              />
            ))
          ) : (
            <>
              <path d={line((p) => band(p)![1])} fill="none" stroke={PLAN} strokeOpacity={0.55} strokeWidth={1.2} strokeDasharray="4 3" />
              <path d={line((p) => band(p)![0])} fill="none" stroke={PLAN} strokeOpacity={0.55} strokeWidth={1.2} strokeDasharray="4 3" />
              {metric === 'revenue' && <path d={line((p) => p.baseline)} fill="none" stroke={NOW} strokeWidth={1.6} strokeLinejoin="round" />}
              <path d={line(main)} fill="none" stroke={PLAN} strokeWidth={2} strokeLinejoin="round" />
            </>
          )}
          {hp && hover != null && <line x1={x(hover)} x2={x(hover)} y1={padT} y2={H - padB} stroke="var(--text-muted)" strokeDasharray="3 3" />}
        </svg>
        {hp && hover != null && (
          <div
            className="pointer-events-none absolute top-2 z-10 min-w-[250px] rounded-[var(--r-md)] border border-border-subtle bg-surface-card px-3 py-2 text-base shadow-[var(--shadow-md)] [font-variant-numeric:tabular-nums]"
            style={{ left: `${Math.min(80, Math.max(20, (x(hover) / w) * 100))}%`, transform: 'translateX(-50%)' }}
          >
            <div className="text-ink-primary">
              {grain === 'week' ? `${hp.label} · from ${dateText(hp.start)}` : hp.label}
              {grain !== 'day' && <span className="text-ink-muted"> · {hp.days} days</span>}
            </div>
            <TipRow label="Revenue" value={format(hp.revenue)} dot={PLAN} />
            <TipRow label="  P10 – P90" value={`${format(hp.revenue_range[0])} – ${format(hp.revenue_range[1])}`} />
            <TipRow label="Baseline" value={format(hp.baseline)} dot={NOW} />
            <TipRow label="Media revenue" value={format(hp.media)} />
            <TipRow label="Ad spend" value={format(hp.spend)} />
            <TipRow label="Net profit" value={format(hp.profit)} />
            <TipRow label="ROAS" value={hp.roas == null ? '—' : `${hp.roas.toFixed(2)}x`} />
          </div>
        )}
      </div>
    </div>
  )
}

function TipRow({ label, value, dot }: { label: string; value: string; dot?: string }) {
  return (
    <div className="mt-0.5 flex items-center justify-between gap-4">
      <span className="inline-flex items-center gap-1.5 text-ink-secondary">
        {dot && <span className="inline-block h-0.5 w-3 rounded" style={{ background: dot }} />}
        {label}
      </span>
      <span className="text-ink-primary">{value}</span>
    </div>
  )
}

// --- tables -----------------------------------------------------------------

const TH = 'px-3 py-2 text-right font-medium'
const TD = 'px-3 py-2.5 text-right'

function Years({ rows }: { rows: ForecastYear[] }) {
  return (
    <div className="overflow-x-auto rounded-[var(--r-md)] border border-border-subtle">
      <table className="w-full min-w-[980px] whitespace-nowrap text-base [font-variant-numeric:tabular-nums]">
        <thead className="bg-surface-muted">
          <tr className="text-left text-base font-medium text-ink-muted">
            <th className="px-3 py-2 font-medium">Year</th>
            <th className="px-3 py-2 font-medium">Dates</th>
            <th className={TH}>Ad spend</th>
            <th className={TH}>Baseline</th>
            <th className={TH}>Media revenue</th>
            <th className={`${TH} !text-brand-violet`}>Revenue</th>
            <th className={TH}>P10 – P90</th>
            <th className={TH}>Net profit</th>
            <th className={TH}>ROAS</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.label} className="border-t border-border-subtle transition-colors hover:bg-surface-hover">
              <td className="px-3 py-2.5 font-medium text-ink-primary">{r.label}</td>
              <td className="px-3 py-2.5 text-ink-secondary">
                {r.from} – {r.to}
                {r.days < 365 && <span className="text-ink-muted"> · {r.days} days</span>}
              </td>
              <td className={`${TD} text-ink-primary`}>{r.spend_display}</td>
              <td className={`${TD} text-ink-secondary`}>{r.baseline_display}</td>
              <td className={`${TD} text-ink-primary`}>{r.media_display}</td>
              <td className={`${TD} font-medium text-brand-violet`}>{r.revenue_display}</td>
              <td className={`${TD} text-ink-secondary`}>{r.revenue_range_display}</td>
              <td className={`${TD} text-ink-primary`}>{r.profit_display}</td>
              <td className={`${TD} text-ink-primary`}>{r.roas_display}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

function Channels({ rows }: { rows: ForecastChannel[] }) {
  const top = Math.max(...rows.map((r) => r.share_pct), 1)
  return (
    <div className="overflow-x-auto rounded-[var(--r-md)] border border-border-subtle">
      <table className="w-full min-w-[900px] whitespace-nowrap text-base [font-variant-numeric:tabular-nums]">
        <thead className="bg-surface-muted">
          <tr className="text-left text-base font-medium text-ink-muted">
            <th className="px-3 py-2 font-medium">Channel</th>
            <th className={TH}>Ad spend</th>
            <th className="px-3 py-2 font-medium">Share of spend</th>
            <th className={TH}>Days with ads</th>
            <th className={`${TH} !text-brand-violet`}>Media revenue</th>
            <th className={TH}>P10 – P90</th>
            <th className={TH}>ROAS</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.key} className="border-t border-border-subtle transition-colors hover:bg-surface-hover">
              <td className="px-3 py-2.5 font-medium text-ink-primary">{r.label}</td>
              <td className={`${TD} text-ink-primary`}>{r.spend_display}</td>
              <td className="px-3 py-2.5">
                <div className="flex items-center gap-3">
                  <span className="h-1.5 w-[90px] rounded-full bg-surface-muted">
                    <span className="block h-full rounded-full bg-brand-violet" style={{ width: `${(r.share_pct / top) * 100}%` }} />
                  </span>
                  <span className="text-ink-secondary">{r.share_pct.toFixed(1)}%</span>
                </div>
              </td>
              <td className={`${TD} text-ink-secondary`}>{r.active_days.toLocaleString()}</td>
              <td className={`${TD} font-medium text-brand-violet`}>{r.media_display}</td>
              <td className={`${TD} text-ink-secondary`}>{r.media_range.display}</td>
              <td className={`${TD} text-ink-primary`}>{r.roas_display}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

// --- how it works -----------------------------------------------------------

function HowItWorks({ model: m }: { model?: ModelCard }) {
  return (
    <InfoPopover label="How it works" title="How it works" width={380}>
      <ul className="mt-1.5 list-disc space-y-1 pl-4 leading-snug text-ink-secondary">
        <li>Revenue = baseline + media-driven revenue, from the same model as the Budget Optimizer, fitted on the installed data.</li>
        <li>Baseline: season, day of week, festival / seasonal / promotion flags and discount from the file; the trend goes on at its latest rate.</li>
        <li>Media: each channel’s carryover and diminishing returns, run on from the data’s last days into the plan.</li>
        {m?.holdout_last_year && (
          <li>
            Last year, unseen: revenue off by {m.holdout_last_year.mape_pct.toFixed(2)}% a day on average (R² {m.holdout_last_year.r2.toFixed(2)}).
          </li>
        )}
        <li>Ranges: {m?.bootstraps ?? 40} model refits, shown as P10 – P90. Spend far beyond what the data saw is extrapolated.</li>
        <li>Net profit = revenue − ad spend; Profit % = net profit ÷ ad spend; ROAS = media-driven revenue ÷ ad spend.</li>
      </ul>
    </InfoPopover>
  )
}
