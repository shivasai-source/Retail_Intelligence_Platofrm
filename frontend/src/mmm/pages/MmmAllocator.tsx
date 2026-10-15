import { createContext, useContext, useEffect, useState } from 'react'
import { Card, CardBody, Spinner } from '../../components/ui'
import { InfoPopover } from '../../components/ui/InfoPopover'
import { Icon } from '../../icons'
import { useChartWidth } from '../../components/charts/useChartWidth'
import { PeriodPicker } from '../../components/planner/PeriodPicker'
import { niceTicks } from '../../components/planner/ticks'
import { axisMoney, ControlGroup, FactList, Panel, QuickChip, Segmented, StaleOverlay, toneClass, TYPE } from '../../components/planner/shared'
import { MmmShell } from '../components/MmmShell'
import { useBudgetOptions, useBudgetStatus, useBudgetSummary, type FigureKey, type Mode, type ModelCard, type Source } from '../budget'
import { useAllocation, useFrontier, type AllocChannel, type Allocation, type Frontier } from '../allocator'
import { usePlanSource } from '../components/PlanSource'
import { CurveExplorer, PlanSourceSwitchRow, SCOPES, TrainingCard, Weekly } from './MmmBudget'

/** THE MMM BUDGET ALLOCATOR -- laid out as the Budget Optimizer.
 *
 *  Pick a period and enter a budget. Three plans are compared: what the
 *  period actually spent, the entered budget split as the actual plan splits
 *  it (same mix), and the entered budget split for the most net profit. The
 *  baseline -- revenue without ads -- is the same in all three.
 *
 *  Every figure is the backend's (app/mmm/allocator.py). */

type WeekKey = [number, number]
const split = (key: number): WeekKey => [Math.floor(key / 100), key % 100]
const join = (k: WeekKey) => k[0] * 100 + k[1]

const NOW = 'var(--text-primary)'
const PLAN = 'var(--brand-violet)'

/** What the uploaded or past plan is called: "Actual" on past data,
 *  "Planned" on a forecast plan. Capitalised; `.toLowerCase()` mid-sentence. */
const Base = createContext('Actual')

/** Quick budgets, as a share of what the period actually spent. */
const QUICK = [0.75, 0.9, 1, 1.1, 1.25, 1.5]

/** The budget box's unit: crore for rupees, millions for dollars. */
const UNIT = { INR: { size: 1e7, label: 'Cr', symbol: '₹' }, USD: { size: 1e6, label: 'M', symbol: '$' } } as const

export function MmmAllocator() {
  const status = useBudgetStatus()
  const ready = status.data?.status === 'ready'
  const [source, setSource] = usePlanSource()
  const options = useBudgetOptions(ready, source)
  const [currency, setCurrency] = useState<'INR' | 'USD'>('INR')
  const [mode, setMode] = useState<Mode>('anywhere')
  const [stored, setPeriod] = useState<{ start: number; end: number; source: Source } | null>(null)
  // Each source has its own weeks: switching opens the new one on its default period.
  const period = stored?.source === source ? stored : null

  useEffect(() => {
    if (options.data && !period) setPeriod({ ...options.data.default, source })
  }, [options.data, period, source])

  const summary = useBudgetSummary(period?.start ?? null, period?.end ?? null, currency, source)
  const sd = summary.isPlaceholderData ? undefined : summary.data
  const actual = sd?.current.budget ?? null
  const rate = sd?.exchange_rate ?? 1

  // The entered budget belongs to its period: a new period starts at its actual spend.
  const periodKey = period ? `${source}:${period.start}-${period.end}` : ''
  const [chosen, setChosen] = useState<{ key: string; value: number } | null>(null)
  const budget = chosen?.key === periodKey ? chosen.value : actual
  const choose = (value: number) => setChosen({ key: periodKey, value })

  const alloc = useAllocation(period?.start ?? null, period?.end ?? null, budget, currency, mode, source)
  const frontier = useFrontier(period?.start ?? null, period?.end ?? null, currency, mode, source)
  const al = alloc.data
  const fr = frontier.data
  const fmt = (v: number) => axisMoney(v, al?.exchange_rate ?? rate, al?.currency ?? currency)
  const error = options.error ?? summary.error ?? alloc.error ?? frontier.error
  const base = source === 'forecast' ? 'Planned' : 'Actual'

  return (
    <Base.Provider value={base}>
    <MmmShell activeKey="allocator" page="Budget Allocator">
      <div className="fade-in flex flex-wrap items-center justify-between gap-x-4 gap-y-3">
        <h1 className="flex items-center gap-2 text-2xl font-normal tracking-[-0.02em]">
          Budget Allocator <Icon name="sparkles" className="h-5 w-5 text-brand-violet" />
          {al && <HowItWorks model={al.model} tail={al.scope.carryover_tail_days} />}
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

      {!ready && <TrainingCard status={status.data} error={status.error} />}

      {ready && <PlanSourceSwitchRow source={source} onChange={setSource} />}

      {ready && options.data && period && (
        <div className="mt-4 flex flex-wrap items-center gap-3">
          <PeriodPicker
            calendar={options.data.calendar}
            start={split(period.start)}
            end={split(period.end)}
            onApply={(a, b) => setPeriod({ start: join(a), end: join(b), source })}
          />
          {alloc.isFetching && (
            <span className={`flex items-center gap-2 ${TYPE.label}`}>
              <Spinner /> Allocating…
            </span>
          )}
        </div>
      )}

      {ready && summary.isPending && (
        <div className={`mt-6 flex items-center gap-3 ${TYPE.label}`}>
          <Spinner /> Loading…
        </div>
      )}
      {error && (
        <Card className="mt-4">
          <CardBody>
            <div className="text-md font-medium text-ink-primary">Could not allocate this budget</div>
            <div className={`mt-1 ${TYPE.label}`}>{error.message}</div>
          </CardBody>
        </Card>
      )}

      {sd && actual != null && budget != null && (
        <Panel className="mt-5">
          <div className="flex flex-wrap items-end justify-between gap-5">
            <div className="flex flex-wrap items-end gap-8">
              <BudgetInput budget={budget} actual={actual} rate={rate} currency={currency} onChange={choose} />
              <div>
                <div className={TYPE.eyebrow}>{base} spend in the period</div>
                <div className="mt-1.5 flex h-10 items-center text-md font-medium text-ink-primary">{sd.current.budget_display}</div>
              </div>
              <div>
                <div className={TYPE.eyebrow}>Optimize for</div>
                <div className="mt-1.5 flex h-10 items-center text-md font-medium text-ink-primary">Maximum net profit</div>
              </div>
            </div>
            <ControlGroup label="Reallocate across">
              <Segmented label="Reallocation scope" value={mode} onChange={setMode} options={SCOPES} />
            </ControlGroup>
          </div>
          <div className="mt-4 flex flex-wrap items-center gap-2">
            {QUICK.map((f) => (
              <QuickChip key={f} active={Math.abs(budget - actual * f) < 1} onClick={() => choose(actual * f)}>
                {/* Worded, not signed: a signed figure is coloured green / red everywhere. */}
                {f === 1 ? base : `${Math.round(Math.abs(f - 1) * 100)}% ${f > 1 ? 'more' : 'less'}`}
              </QuickChip>
            ))}
            {fr && !frontier.isPlaceholderData && (
              <QuickChip
                active={Math.abs(budget - fr.peak.spend) < 1}
                onClick={() => choose(fr.peak.spend)}
                title="The budget where the optimized split earns the most net profit"
              >
                <Icon name="target" /> Profit peak · {fr.peak.spend_display}
              </QuickChip>
            )}
          </div>
        </Panel>
      )}

      {al && (
        <StaleOverlay on={alloc.isFetching}>
          <div className="mt-5 grid items-stretch gap-5 @min-[1100px]:grid-cols-[440px_minmax(0,1fr)]">
            <UpliftPanel a={al} />
            <Panel title={`${base} vs your budget`}>
              <Compare a={al} />
            </Panel>
          </div>

          <Panel title="Net profit at every budget" className="mt-5">
            {fr ? (
              <StaleOverlay on={frontier.isFetching}>
                <ProfitCurve f={fr} a={al} format={fmt} />
              </StaleOverlay>
            ) : (
              <div className={`flex items-center gap-3 py-10 ${TYPE.label}`}>
                <Spinner /> Optimizing every budget…
              </div>
            )}
          </Panel>

          <Panel title="Optimal spend by channel" className="mt-5">
            <ChannelTable a={al} />
          </Panel>

          <Panel title="Week by week" className="mt-5">
            <Weekly weekly={al.weekly} format={fmt} nowLabel={base} planLabel="Optimized" />
          </Panel>

          <Panel title="Spend response" className="mt-5">
            <CurveExplorer curves={al.curves} format={fmt} names={{ now: 'Same mix', plan: 'Optimized' }} />
          </Panel>
        </StaleOverlay>
      )}
    </MmmShell>
    </Base.Provider>
  )
}

// --- the budget box ---------------------------------------------------------

function BudgetInput({
  budget,
  actual,
  rate,
  currency,
  onChange,
}: {
  budget: number
  actual: number
  rate: number
  currency: 'INR' | 'USD'
  onChange: (rupees: number) => void
}) {
  const unit = UNIT[currency]
  const shown = (budget * rate) / unit.size
  const [draft, setDraft] = useState(shown.toFixed(2))
  useEffect(() => setDraft(shown.toFixed(2)), [shown])
  const value = Number(draft)
  const valid = draft.trim() !== '' && Number.isFinite(value) && value > 0
  const apply = () => {
    if (valid) onChange((value * unit.size) / rate)
    else setDraft(shown.toFixed(2))
  }
  const pct = ((budget - actual) / actual) * 100
  const base = useContext(Base).toLowerCase()
  return (
    <div>
      <div className={TYPE.eyebrow}>Your budget</div>
      <div className="mt-1.5 flex items-center gap-2">
        <label className="flex h-10 w-[200px] items-center gap-1.5 rounded-[var(--r-md)] border border-border-default bg-surface-card px-3 text-md focus-within:border-brand-violet">
          <span className="text-ink-muted">{unit.symbol}</span>
          <input
            aria-label={`Budget in ${unit.symbol} ${unit.label}`}
            inputMode="decimal"
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onBlur={apply}
            onKeyDown={(e) => e.key === 'Enter' && apply()}
            style={{ outline: 'none' }}
            className="w-full min-w-0 bg-transparent text-ink-primary [font-variant-numeric:tabular-nums] focus:outline-none"
          />
          <span className="text-ink-muted">{unit.label}</span>
        </label>
        <span className={`whitespace-nowrap text-base font-medium ${Math.abs(pct) < 0.05 ? 'text-ink-muted' : pct > 0 ? 'text-status-success' : 'text-status-danger'}`}>
          {Math.abs(pct) < 0.05 ? `same as ${base}` : `${pct > 0 ? '+' : '−'}${Math.abs(pct).toFixed(1)}% vs ${base}`}
        </span>
      </div>
    </div>
  )
}

// --- what optimizing adds ---------------------------------------------------

function UpliftPanel({ a }: { a: Allocation }) {
  const Name = useContext(Base)
  const name = Name.toLowerCase()
  const s = a.scenarios
  const mix = a.deltas.mix.profit
  const d = (k: 'budget' | 'mix' | 'total') => a.deltas[k].profit
  const tone = (k: 'budget' | 'mix' | 'total') => {
    const x = d(k)
    return x ? toneClass(x.direction) : undefined
  }
  const tiles: { value: string; sub?: string; label: string; title: string }[] = [
    {
      value: a.budget.display,
      sub: Math.abs(a.budget_change.percent) < 0.05 ? `same as ${name}` : `${a.budget_change.display} vs ${name}`,
      label: 'your budget',
      title: `${Name} spend in the period: ${a.actual_budget.display}`,
    },
    {
      value: s.optimized.baseline.display,
      sub: 'same in every plan',
      label: 'baseline revenue (no ads)',
      title: 'Trend, season, festivals and promotions: the revenue the period earns with no ads',
    },
    {
      value: a.deltas.mix.revenue?.display ?? '—',
      sub: a.deltas.mix.revenue?.percent_display ? `${a.deltas.mix.revenue.percent_display} on same mix` : undefined,
      label: 'revenue uplift from optimizing',
      title: 'Optimized revenue − same-mix revenue, at your budget',
    },
    {
      value: s.optimized.roas.display,
      sub: `same mix ${s.same_mix.roas.display}`,
      label: 'ROAS, optimized',
      title: 'Media-driven revenue ÷ ad spend',
    },
  ]
  return (
    <Panel title="What optimizing adds">
      <div className={TYPE.hero}>{mix?.display ?? '—'}</div>
      <div className={`mt-2 ${TYPE.label}`}>
        Net profit <span className="text-ink-primary">{s.same_mix.profit.display}</span> → <span className="text-brand-violet">{s.optimized.profit.display}</span> at{' '}
        {a.budget.display}
      </div>

      <div className="mt-5 grid grid-cols-2 gap-3">
        {tiles.map((t) => (
          <div key={t.label} title={t.title} className="rounded-[var(--r-md)] border border-border-subtle bg-surface-muted px-4 py-3.5">
            <div className={TYPE.value}>{t.value}</div>
            {t.sub && <div className={`${TYPE.label} !text-ink-muted`}>{t.sub}</div>}
            <div className={`mt-1 leading-snug ${TYPE.label}`}>{t.label}</div>
          </div>
        ))}
      </div>

      <div className="mt-5">
        <div className={TYPE.eyebrow}>Net profit vs {name} ({s.actual.profit.display})</div>
        <div className="mt-1">
          <FactList
            items={[
              { label: 'Your budget, same mix', value: d('budget')?.display ?? '—', tone: tone('budget'), dot: NOW, title: `Same mix − ${name}: what the budget change alone does` },
              { label: 'Optimizing the split', value: d('mix')?.display ?? '—', tone: tone('mix'), dot: PLAN, title: 'Optimized − same mix' },
              { label: `Total vs ${name}`, value: d('total')?.display ?? '—', tone: tone('total'), dot: 'var(--border-strong)', title: `Optimized − ${name}` },
            ]}
          />
        </div>
      </div>

      {mix?.range && (
        <div className="mt-5">
          <div className={TYPE.eyebrow}>How sure · {a.draws} model refits</div>
          <div className="mt-1">
            <FactList
              items={[
                { label: 'Likely gain from optimizing', value: mix.range.display, dot: PLAN, title: 'In 8 of every 10 model refits the gain falls in this range (P10 – P90)' },
                { label: 'Refits where optimizing gains', value: `${a.chance_mix_gain_pct.toFixed(0)}%`, dot: PLAN },
              ]}
            />
          </div>
        </div>
      )}
    </Panel>
  )
}

// --- the three plans --------------------------------------------------------

const ROWS: { key: FigureKey; label: string; neutral?: boolean }[] = [
  { key: 'profit', label: 'Net profit' },
  { key: 'profit_pct', label: 'Profit %' },
  { key: 'revenue', label: 'Revenue' },
  { key: 'incremental', label: 'Media revenue' },
  { key: 'baseline', label: 'Baseline revenue', neutral: true },
  { key: 'spend', label: 'Ad spend', neutral: true },
  { key: 'roas', label: 'ROAS' },
]

function Compare({ a }: { a: Allocation }) {
  const Name = useContext(Base)
  const s = a.scenarios
  const head = `pb-2.5 pl-4 text-right ${TYPE.eyebrow}`
  const cell = `whitespace-nowrap py-3 pl-4 text-right ${TYPE.cell}`
  return (
    <div className="overflow-x-auto">
      <table className="w-full min-w-[720px]">
        <thead>
          <tr className="border-b border-border-subtle">
            <th className={`pb-2.5 text-left ${TYPE.eyebrow}`}>Figure</th>
            <th className={head} title={`What the period ${Name === 'Actual' ? 'actually spent' : 'plans to spend'}`}>
              {Name}
            </th>
            <th className={head} title={`Your budget, split as the ${Name.toLowerCase()} plan splits it`}>
              Same mix
            </th>
            <th className={`${head} !text-brand-violet`} title="Your budget, split for the most net profit">
              Optimized
            </th>
            <th className={head} title="Optimized − same mix">
              Optimizing adds
            </th>
            <th className={head} title={`Optimized: 10th to 90th percentile over ${a.draws} model refits`}>
              Range P10 – P90
            </th>
          </tr>
        </thead>
        <tbody>
          {ROWS.map((row) => {
            const d = a.deltas.mix[row.key]
            const moved = !!d && d.direction !== 'unchanged'
            const text = d?.display ?? ''
            return (
              <tr key={row.key} className="border-b border-border-subtle last:border-b-0">
                <td className={`whitespace-nowrap py-3 ${TYPE.label}`}>{row.label}</td>
                <td className={`${cell} !text-ink-secondary`}>{s.actual[row.key].display}</td>
                <td className={cell}>{s.same_mix[row.key].display}</td>
                <td className={`${cell} !text-brand-violet`}>{s.optimized[row.key].display}</td>
                <td className={`whitespace-nowrap py-3 pl-4 text-right ${TYPE.delta} ${moved && d ? (row.neutral ? 'text-ink-secondary' : toneClass(d.direction)) : 'text-ink-muted'}`}>
                  {moved ? text : '—'}
                </td>
                <td className={`${cell} !text-ink-secondary`}>{s.optimized[row.key].range?.display ?? '—'}</td>
              </tr>
            )
          })}
        </tbody>
      </table>
    </div>
  )
}

// --- net profit at every budget ---------------------------------------------

function ProfitCurve({ f, a, format }: { f: Frontier; a: Allocation; format: (v: number) => string }) {
  const Name = useContext(Base)
  const { ref, width: w } = useChartWidth(720)
  const [hover, setHover] = useState<number | null>(null)
  const H = 340
  const padR = 18
  const padT = 30
  const padB = 56
  const pts = f.points
  const marks = {
    actual: { spend: a.actual_budget.value, profit: a.scenarios.actual.profit.value ?? 0 },
    same: { spend: a.budget.value, profit: a.scenarios.same_mix.profit.value ?? 0 },
    best: { spend: a.budget.value, profit: a.scenarios.optimized.profit.value ?? 0 },
  }
  const maxX = Math.max(pts[pts.length - 1]?.spend ?? 1, a.budget.value * 1.05)
  const ys = [...pts.flatMap((p) => [p.same, p.best, p.best_range[0], p.best_range[1]]), ...Object.values(marks).map((m) => m.profit)]
  const yLo = Math.min(...ys)
  const yHi = Math.max(...ys)
  const padY = (yHi - yLo) * 0.06
  const yt = niceTicks(yLo - padY, yHi + padY)
  const y0 = Math.min(yt[0], yLo - padY)
  const y1 = Math.max(yt[yt.length - 1], yHi + padY)
  const xt = niceTicks(0, maxX).filter((t) => t >= 0 && t <= maxX)
  const padL = Math.max(64, Math.max(...yt.map((t) => format(t).length)) * 9 + 30)
  const innerW = Math.max(1, w - padL - padR)
  const x = (v: number) => padL + (v / maxX) * innerW
  const y = (v: number) => padT + (1 - (v - y0) / (y1 - y0)) * (H - padT - padB)
  const path = (pick: (p: (typeof pts)[number]) => number) => pts.map((p, i) => `${i ? 'L' : 'M'} ${x(p.spend)} ${y(pick(p))}`).join(' ')
  const step = innerW / Math.max(pts.length - 1, 1)
  const hp = hover != null ? pts[hover] : null
  const sameAsActual = Math.abs(a.budget.value - a.actual_budget.value) < 1
  const gap = a.budget.value - f.peak.spend
  const note =
    Math.abs(gap) <= f.actual_budget * 0.02
      ? `Your budget is at the profit peak: spent the optimized way, a rupee more or less would not raise net profit.`
      : gap > 0
        ? `Your budget is ${format(gap)} above the profit peak: past ${f.peak.spend_display}, the next rupee of ads earns back less than a rupee, so net profit falls even with the best split.`
        : `Your budget is ${format(-gap)} below the profit peak: up to ${f.peak.spend_display}, the next rupee of ads, spent the optimized way, still earns back more than a rupee.`
  return (
    <div>
      <div className="flex flex-wrap items-center gap-x-5 gap-y-1 text-base text-ink-secondary">
        <span className="inline-flex items-center gap-1.5">
          <span className="inline-block h-0.5 w-5 rounded" style={{ background: NOW }} /> Same mix as {Name.toLowerCase()}
        </span>
        <span className="inline-flex items-center gap-1.5">
          <span className="inline-block h-0.5 w-5 rounded" style={{ background: PLAN }} /> Optimized split
        </span>
        <span className="inline-flex items-center gap-1.5">
          <span className="inline-block w-5 border-t-2 border-dashed" style={{ borderColor: PLAN, opacity: 0.6 }} /> P10 / P90
        </span>
        <span className="inline-flex items-center gap-1.5">
          <span className="inline-block h-2.5 w-2.5 rounded-full border-2" style={{ borderColor: NOW }} /> {Name}
        </span>
        <span className="inline-flex items-center gap-1.5">
          <span className="inline-block h-2.5 w-2.5 rounded-full" style={{ background: PLAN }} /> Your budget, optimized
        </span>
        <span className="inline-flex items-center gap-1.5">
          <span className="inline-block h-3 border-l-2 border-dashed border-status-success" /> Profit peak
        </span>
      </div>
      <div ref={ref} className="relative mt-3" onMouseLeave={() => setHover(null)}>
        <svg viewBox={`0 0 ${w} ${H}`} width="100%" height={H} role="img" aria-label="Net profit at every budget">
          {yt.map((t) => (
            <g key={`y${t}`}>
              <line x1={padL} x2={padL + innerW} y1={y(t)} y2={y(t)} stroke="var(--border-subtle)" />
              <text x={padL - 8} y={y(t) + 4} textAnchor="end" fontSize={15} fill="var(--text-muted)">
                {format(t)}
              </text>
            </g>
          ))}
          {xt.map((t) => (
            <text key={`x${t}`} x={x(t)} y={H - padB + 20} textAnchor="middle" fontSize={15} fill="var(--text-muted)">
              {format(t)}
            </text>
          ))}
          <text x={padL + innerW / 2} y={H - 6} textAnchor="middle" fontSize={15} fill="var(--text-secondary)">
            Budget for the period
          </text>
          <text
            x={14}
            y={padT + (H - padT - padB) / 2}
            textAnchor="middle"
            fontSize={15}
            fill="var(--text-secondary)"
            transform={`rotate(-90 14 ${padT + (H - padT - padB) / 2})`}
          >
            Net profit
          </text>
          <line x1={x(f.peak.spend)} x2={x(f.peak.spend)} y1={padT} y2={H - padB} stroke="var(--status-success)" strokeDasharray="5 4" />
          <text x={x(f.peak.spend)} y={padT - 10} textAnchor="middle" fontSize={15} fill="var(--status-success)">
            Peak {f.peak.spend_display}
          </text>
          <path d={path((p) => p.best_range[1])} fill="none" stroke={PLAN} strokeOpacity={0.55} strokeWidth={1.3} strokeDasharray="4 3" />
          <path d={path((p) => p.best_range[0])} fill="none" stroke={PLAN} strokeOpacity={0.55} strokeWidth={1.3} strokeDasharray="4 3" />
          <path d={path((p) => p.same)} fill="none" stroke={NOW} strokeWidth={1.8} strokeLinejoin="round" />
          <path d={path((p) => p.best)} fill="none" stroke={PLAN} strokeWidth={2.2} strokeLinejoin="round" />
          {hp && <line x1={x(hp.spend)} x2={x(hp.spend)} y1={padT} y2={H - padB} stroke="var(--text-muted)" strokeDasharray="3 3" />}
          <circle cx={x(marks.actual.spend)} cy={y(marks.actual.profit)} r={5.5} fill="var(--surface-card)" stroke={NOW} strokeWidth={2} />
          {!sameAsActual && <circle cx={x(marks.same.spend)} cy={y(marks.same.profit)} r={4.5} fill="var(--surface-card)" stroke={NOW} strokeWidth={1.5} />}
          <circle cx={x(marks.best.spend)} cy={y(marks.best.profit)} r={6} fill={PLAN} stroke="var(--surface-card)" strokeWidth={1.5} />
          {pts.map((p, i) => (
            <rect key={i} x={x(p.spend) - step / 2} y={0} width={step} height={H - padB} fill="transparent" onMouseEnter={() => setHover(i)} />
          ))}
        </svg>
        {hp && (
          <div
            className="pointer-events-none absolute top-2 z-10 min-w-[240px] rounded-[var(--r-md)] border border-border-subtle bg-surface-card px-3 py-2 text-base shadow-[var(--shadow-md)] [font-variant-numeric:tabular-nums]"
            style={{ left: `${Math.min(80, Math.max(20, (x(hp.spend) / w) * 100))}%`, transform: 'translateX(-50%)' }}
          >
            <div className="text-ink-primary">Budget {format(hp.spend)}</div>
            <TipRow label="Same mix" value={format(hp.same)} dot={NOW} />
            <TipRow label="Optimized" value={format(hp.best)} dot={PLAN} />
            <TipRow label="P10 – P90" value={`${format(hp.best_range[0])} – ${format(hp.best_range[1])}`} />
          </div>
        )}
      </div>
      <div className="mt-4 grid grid-cols-3 gap-3 @max-[700px]:grid-cols-1">
        <Stat label="Profit peak, optimized" value={f.peak.spend_display} sub={`net profit ${f.peak.profit_display}`} />
        <Stat label="Your budget, optimized" value={a.budget.display} sub={`net profit ${a.scenarios.optimized.profit.display}`} />
        <Stat label={Name} value={a.actual_budget.display} sub={`net profit ${a.scenarios.actual.profit.display}`} />
      </div>
      <p className={`mt-3 leading-relaxed ${TYPE.label}`}>
        Each budget is split the best way for that budget; the gap between the two lines is what optimizing earns. {note}
      </p>
    </div>
  )
}

function Stat({ label, value, sub }: { label: string; value: string; sub: string }) {
  return (
    <div className="rounded-[var(--r-md)] border border-border-subtle bg-surface-muted px-4 py-3.5">
      <div className={TYPE.label}>{label}</div>
      <div className={`mt-1 ${TYPE.cell}`}>{value}</div>
      <div className={`${TYPE.label} !text-ink-muted`}>{sub}</div>
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

// --- optimal spend by channel -----------------------------------------------

function ChannelTable({ a }: { a: Allocation }) {
  const Name = useContext(Base)
  const rows = a.channels
  const top = Math.max(...rows.map((r) => Math.max(r.share_actual_pct, r.share_optimized_pct)), 1)
  const th = 'px-2.5 py-2 text-right font-medium'
  return (
    <div>
      <div className="overflow-x-auto rounded-[var(--r-md)] border border-border-subtle">
        <table className="w-full min-w-[980px] whitespace-nowrap text-base [font-variant-numeric:tabular-nums]">
          <thead className="bg-surface-muted">
            <tr className="text-left text-base font-medium text-ink-muted">
              <th className="px-2.5 py-2 font-medium">Channel</th>
              <th className={th}>{Name}</th>
              <th className={th}>Same mix</th>
              <th className={`${th} !text-brand-violet`}>Optimized</th>
              <th className="px-2.5 py-2 font-medium">Share of budget</th>
              <th className={th} title="Optimized − same mix">Change</th>
              <th className={th}>Media revenue</th>
              <th className={th} title="What the next rupee in this channel returns, in the optimized plan">
                Next {UNIT[a.currency === 'USD' ? 'USD' : 'INR'].symbol}1 returns
              </th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <Row key={r.key} r={r} top={top} />
            ))}
          </tbody>
          <tfoot className="border-t border-border-default bg-surface-muted">
            <tr className="font-medium text-ink-primary">
              <td className="px-2.5 py-2.5">All channels</td>
              <td className="px-2.5 py-2.5 text-right">{a.actual_budget.display}</td>
              <td className="px-2.5 py-2.5 text-right">{a.budget.display}</td>
              <td className="px-2.5 py-2.5 text-right text-brand-violet">{a.budget.display}</td>
              <td className="px-2.5 py-2.5 text-ink-muted">100%</td>
              <td className="px-2.5 py-2.5 text-right text-ink-muted">—</td>
              <td className="px-2.5 py-2.5 text-right">
                {a.scenarios.same_mix.incremental.display} → <span className="text-brand-violet">{a.scenarios.optimized.incremental.display}</span>
              </td>
              <td className="px-2.5 py-2.5" />
            </tr>
          </tfoot>
        </table>
      </div>
      {rows.some((r) => r.beyond_data) && (
        <div className={`mt-3 flex items-center gap-2 ${TYPE.label} !text-ink-muted [&_svg]:h-4 [&_svg]:w-4`}>
          <Icon name="alertTriangle" className="text-status-warning" />
          Spends past a channel’s highest weekly spend in the data: the model extends its curve there, so treat those figures as a guide.
        </div>
      )}
    </div>
  )
}

function Row({ r, top }: { r: AllocChannel; top: number }) {
  const same = Math.abs(r.change) < 1
  return (
    <tr className="border-t border-border-subtle transition-colors hover:bg-surface-hover">
      <td className="px-2.5 py-2.5 font-medium text-ink-primary">
        <span className="inline-flex items-center gap-1.5 [&_svg]:h-4 [&_svg]:w-4">
          {r.label}
          {r.beyond_data && (
            <span title="Past this channel’s highest weekly spend in the data">
              <Icon name="alertTriangle" className="text-status-warning" />
            </span>
          )}
        </span>
      </td>
      <td className="px-2.5 py-2.5 text-right text-ink-secondary">{r.actual_display}</td>
      <td className="px-2.5 py-2.5 text-right text-ink-primary">{r.same_display}</td>
      <td className="px-2.5 py-2.5 text-right font-medium text-brand-violet">{r.optimized_display}</td>
      <td className="px-2.5 py-2.5">
        <div className="flex items-center gap-3">
          <div className="flex w-[72px] flex-col gap-1">
            <span className="h-1.5 rounded-full bg-ink-primary/25" style={{ width: `${(r.share_actual_pct / top) * 100}%` }} />
            <span className="h-1.5 rounded-full bg-brand-violet" style={{ width: `${(r.share_optimized_pct / top) * 100}%` }} />
          </div>
          <span className="text-ink-secondary">
            {r.share_actual_pct.toFixed(1)}% → <span className="text-brand-violet">{r.share_optimized_pct.toFixed(1)}%</span>
          </span>
        </div>
      </td>
      <td className={`px-2.5 py-2.5 text-right font-medium ${same ? 'text-ink-muted' : r.change > 0 ? 'text-status-success' : 'text-status-danger'}`}>
        {same ? '—' : r.change_display}
      </td>
      <td className="px-2.5 py-2.5 text-right text-ink-secondary">
        {r.media_same_display} → <span className="text-brand-violet">{r.media_optimized_display}</span>
      </td>
      <td className="px-2.5 py-2.5 text-right text-ink-primary">{r.marginal_display}</td>
    </tr>
  )
}

// --- how it works -----------------------------------------------------------

function HowItWorks({ model: m, tail }: { model: ModelCard; tail: number }) {
  return (
    <InfoPopover label="How it works" title="How it works" width={380}>
      <ul className="mt-1.5 list-disc space-y-1 pl-4 leading-snug text-ink-secondary">
        <li>Actual (or Planned, on a forecast plan): what the period spends. Same mix: your budget, every channel-week scaled by the same factor. Optimized: your budget, split for the most net profit.</li>
        <li>Baseline revenue (no ads) is the same in all three: trend, season, festivals, promotions.</li>
        <li>Each channel has its own carryover and diminishing returns. There are no limits per channel; only the total is fixed.</li>
        {m.holdout_last_year && (
          <li>
            Last year, unseen: revenue off by {m.holdout_last_year.mape_pct.toFixed(2)}% a day on average (R² {m.holdout_last_year.r2.toFixed(2)}).
          </li>
        )}
        <li>Ranges: {m.bootstraps ?? 0} model refits on resampled months, shown as P10 – P90. Carryover is counted {tail} days after the period.</li>
        <li>Net profit = revenue − ad spend. With the total fixed, the most net profit is also the most revenue.</li>
      </ul>
    </InfoPopover>
  )
}
