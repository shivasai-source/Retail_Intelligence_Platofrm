import { useEffect, useMemo, useState } from 'react'
import { Card, CardBody, Spinner } from '../../components/ui'
import { InfoPopover } from '../../components/ui/InfoPopover'
import { Icon } from '../../icons'
import { ApiError } from '../../lib/api'
import { useChartWidth } from '../../components/charts/useChartWidth'
import { PeriodPicker } from '../../components/planner/PeriodPicker'
import { WeekTrend } from '../../components/planner/WeekTrend'
import { niceTicks } from '../../components/planner/ticks'
import {
  axisMoney,
  ControlGroup,
  FactList,
  Panel,
  QuickChip,
  Segmented,
  StaleOverlay,
  toneClass,
  TYPE,
} from '../../components/planner/shared'
import type { WeekPoint as StudioWeek } from '../../types/planner'
import { MmmShell } from '../components/MmmShell'
import { PlanSourceSwitch, usePlanSource } from '../components/PlanSource'
import {
  useBestPlan,
  useBudgetOptions,
  useBudgetStatus,
  useBudgetSummary,
  type BestPlan,
  type BudgetSummary,
  type ChannelCurve,
  type ChannelMoves,
  type CurvePoint,
  type FigureKey,
  type Mode,
  type ModelCard,
  type Source,
  type Move,
  type MoveKind,
  type WeekPoint as BudgetWeek,
} from '../budget'

/** THE MMM BUDGET OPTIMIZER -- laid out as TPO's Best plan.
 *
 *  Pick a period (whole ISO weeks) and what may be reallocated. The budget is
 *  fixed, so every change is a reallocation: money leaves one channel-week
 *  and arrives -- whole or in parts -- at one or more others, re-timed within
 *  the channel, shifted across channels in the same week, or both. The
 *  optimized plan is computed as soon as the period or scope changes.
 *
 *  Every figure is the backend's (app/mmm/budget.py): Net profit = revenue -
 *  ad spend, Profit % = net profit / ad spend, as TPO defines them. */

type WeekKey = [number, number]
const split = (key: number): WeekKey => [Math.floor(key / 100), key % 100]
const join = (k: WeekKey) => k[0] * 100 + k[1]
const weekLabel = (k: number) => `W${String(k % 100).padStart(2, '0')}`
const MONTH = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
/** "2026-09-14" -> "14 Sep 2026". */
const dateText = (iso: string) => {
  const [y, m, d] = iso.split('-')
  return y && m && d ? `${d} ${MONTH[Number(m) - 1]} ${y}` : iso
}

const NOW = 'var(--text-primary)'
const PLAN = 'var(--brand-violet)'

export const SCOPES: { value: Mode; label: string; title: string }[] = [
  { value: 'anywhere', label: 'Channels and weeks', title: 'Reallocate across channels and across weeks; only the period total is fixed' },
  { value: 'within_channel', label: 'Weeks only', title: 'Re-time each channel across its weeks; every channel keeps its total' },
  { value: 'across_channels', label: 'Channels only', title: 'Shift between channels within each week; every week keeps its total' },
]

/** The three kinds of reallocation, toned as TPO's change chips are. */
const KIND: Record<MoveKind, { label: string; short: string; icon: 'timing' | 'arrowRight' | 'arrowTransform'; tone: string }> = {
  week: { label: 'Re-timed within channel', short: 'Re-timed', icon: 'timing', tone: 'bg-brand-violet/10 text-brand-violet' },
  channel: { label: 'Shifted across channels, same week', short: 'Across channels', icon: 'arrowRight', tone: 'bg-status-info/10 text-status-info' },
  both: { label: 'Shifted across channels and weeks', short: 'Across channels and weeks', icon: 'arrowTransform', tone: 'bg-status-warning/10 text-status-warning' },
}

const ALLOWED: Record<Mode, MoveKind[]> = {
  anywhere: ['week', 'channel', 'both'],
  within_channel: ['week'],
  across_channels: ['channel'],
}

export function MmmBudget() {
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
  const best = useBestPlan(period?.start ?? null, period?.end ?? null, currency, mode, source)
  const sd = summary.data
  const bp = best.data
  const fmt = (v: number) => axisMoney(v, bp?.exchange_rate ?? 1, bp?.currency ?? currency)

  return (
    <MmmShell activeKey="budget" page="Budget Optimizer">
      <div className="fade-in flex flex-wrap items-center justify-between gap-x-4 gap-y-3">
        <h1 className="flex items-center gap-2 text-2xl font-normal tracking-[-0.02em]">
          Budget Optimizer <Icon name="sparkles" className="h-5 w-5 text-brand-violet" />
          {sd && <HowItWorks model={sd.model} tail={sd.scope.carryover_tail_days} />}
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
          {best.isFetching && (
            <span className={`flex items-center gap-2 ${TYPE.label}`}>
              <Spinner /> Optimizing…
            </span>
          )}
        </div>
      )}

      {ready && summary.isPending && (
        <div className={`mt-6 flex items-center gap-3 ${TYPE.label}`}>
          <Spinner /> Loading…
        </div>
      )}
      {(summary.isError || best.isError || options.isError) && (
        <Card className="mt-4">
          <CardBody>
            <div className="text-md font-medium text-ink-primary">Could not plan this period</div>
            <div className={`mt-1 ${TYPE.label}`}>{(summary.error ?? best.error ?? options.error)?.message}</div>
          </CardBody>
        </Card>
      )}

      {sd && <CurrentPlan summary={sd} />}

      {sd && (
        <Panel className="mt-5">
          <div className="flex flex-wrap items-end justify-between gap-5">
            <div className="flex flex-wrap items-end gap-8">
              <div>
                <div className={TYPE.eyebrow}>Optimize for</div>
                <div className="mt-1.5 flex h-10 items-center text-md font-medium text-ink-primary">Maximum net profit</div>
              </div>
              <div>
                <div className={TYPE.eyebrow}>Budget</div>
                <div className="mt-1.5 flex h-10 items-center gap-2 text-md font-medium text-ink-primary">
                  {sd.current.budget_display}
                  <span className="rounded-full bg-surface-muted px-2.5 py-0.5 text-base text-ink-secondary">Fixed</span>
                </div>
              </div>
            </div>
            <ControlGroup label="Reallocate across">
              <Segmented label="Reallocation scope" value={mode} onChange={setMode} options={SCOPES} />
            </ControlGroup>
          </div>
        </Panel>
      )}

      {bp && sd && (
        <StaleOverlay on={best.isFetching}>
          <div className="mt-5 grid items-stretch gap-5 @min-[1100px]:grid-cols-[440px_minmax(0,1fr)]">
            <GainPanel plan={bp} />
            <Panel title="Current plan vs optimized">
              <Compare plan={bp} />
            </Panel>
          </div>

          <Panel title="Week by week" className="mt-5">
            <Weekly weekly={bp.weekly} format={fmt} />
          </Panel>

          <Panel title="Spend response" className="mt-5">
            <CurveExplorer curves={bp.curves} format={fmt} />
          </Panel>

          <Panel title="Budget reallocations" className="mt-5">
            <Reallocations plan={bp} summary={sd} format={fmt} />
          </Panel>

          <Panel title="Channel budgets" className="mt-5">
            <ChannelTable rows={bp.channels} />
          </Panel>
        </StaleOverlay>
      )}
    </MmmShell>
  )
}

/** The source switch on its own row, under the title. */
export function PlanSourceSwitchRow({ source, onChange }: { source: Source; onChange: (s: Source) => void }) {
  return (
    <div className="mt-4 empty:hidden">
      <PlanSourceSwitch source={source} onChange={onChange} />
    </div>
  )
}

// --- training ---------------------------------------------------------------

export function TrainingCard({ status, error }: { status?: { status: string; stage: string; progress: number; error: string | null }; error: Error | null }) {
  const failed = status?.status === 'error' || !!error
  // A 404 means the backend predates the optimizer: it needs a restart, not a retry.
  const outdated = error instanceof ApiError && error.status === 404
  return (
    <Card className="mt-4">
      <CardBody>
        <div className="flex items-center gap-3">
          {failed ? <Icon name="alertTriangle" className="h-5 w-5 text-status-danger" /> : <Spinner />}
          <div className="min-w-0 flex-1">
            <div className="text-ink-primary">
              {outdated ? 'The backend needs a restart' : failed ? 'The response model could not be trained' : 'Training the response model…'}
            </div>
            <div className="mt-1 text-ink-muted">
              {outdated
                ? 'The running backend was started before the Budget Optimizer was added, so it does not have its endpoints yet. Restart it and reload this page.'
                : failed
                  ? status?.error ?? error?.message
                  : `${status?.stage || 'Starting'} · once per dataset; it is saved and reused after this.`}
            </div>
          </div>
          {!failed && <span className="shrink-0 text-ink-muted [font-variant-numeric:tabular-nums]">{status?.progress ?? 0}%</span>}
        </div>
        {!failed && (
          <span className="mt-3 block h-1.5 overflow-hidden rounded-full bg-surface-muted">
            <span className="block h-full rounded-full bg-brand-violet transition-[width] duration-300" style={{ width: `${status?.progress ?? 0}%` }} />
          </span>
        )}
      </CardBody>
    </Card>
  )
}

// --- current plan -----------------------------------------------------------

/** The current plan: one strip of figures, as TPO's Simulation Studio shows it. */
function CurrentPlan({ summary: s }: { summary: BudgetSummary }) {
  const f = s.figures
  const stats: { label: string; value: string; icon: Parameters<typeof Icon>[0]['name']; info: string }[] = [
    { label: 'Net profit', value: f.profit.display, icon: 'coins', info: 'Revenue − ad spend' },
    { label: 'Profit %', value: f.profit_pct.display, icon: 'trending', info: 'Net profit ÷ ad spend × 100' },
    { label: 'Revenue', value: f.revenue.display, icon: 'wallet', info: 'Baseline + media-driven revenue, carryover included' },
    { label: 'Ad spend', value: f.spend.display, icon: 'tag', info: 'The fixed budget for the period' },
    { label: 'ROAS', value: f.roas.display, icon: 'gauge', info: 'Media-driven revenue ÷ ad spend' },
    { label: 'Media revenue', value: f.incremental.display, icon: 'uplift', info: 'Media-driven revenue: what the ads add over the baseline' },
  ]
  const first = s.scope.weeks[0]
  const last = s.scope.weeks[s.scope.weeks.length - 1]
  return (
    <div className="fade-in mt-4 rounded-[var(--r-lg)] border border-border-subtle bg-surface-card shadow-[var(--shadow-card-soft)]">
      <div className="flex flex-wrap items-baseline gap-x-3 border-b border-border-subtle px-5 py-3">
        <span className="text-md font-medium text-ink-primary">Current plan</span>
        <span className="text-base text-ink-muted">
          {s.scope.weeks.length} weeks · {first?.label} – {last?.label} · {s.channels.length} channels
        </span>
      </div>
      <div className="grid grid-cols-6 divide-x divide-border-subtle @max-[1100px]:grid-cols-3 @max-[1100px]:divide-y @max-[700px]:grid-cols-2">
        {stats.map((st) => (
          <div key={st.label} className="flex items-center gap-3 px-5 py-4" title={st.info}>
            <span className="grid h-10 w-10 shrink-0 place-items-center rounded-xl bg-brand-violet-50 text-brand-violet [&_svg]:h-4 [&_svg]:w-4">
              <Icon name={st.icon} />
            </span>
            <div className="min-w-0">
              <div className={`truncate ${TYPE.label}`}>{st.label}</div>
              <div className={`mt-0.5 truncate ${TYPE.value}`}>{st.value}</div>
            </div>
          </div>
        ))}
      </div>
    </div>
  )
}

// --- the gain ---------------------------------------------------------------

function GainPanel({ plan: p }: { plan: BestPlan }) {
  const gain = p.deltas.profit
  const pct = p.deltas.profit_pct
  const allowed = ALLOWED[p.mode]
  const tiles: { value: string; sub?: string; label: string; title: string }[] = [
    {
      value: p.impact.moved_display,
      sub: `${p.impact.moved_share_pct}% of budget`,
      label: 'reallocated in total',
      title: 'The budget stays the same; this much of it is spent somewhere else or at another time.',
    },
    // One kind of move only: its amount is the total, so count the channels instead.
    ...(allowed.length > 1
      ? allowed.map((k) => ({
          value: p.impact.kinds[k].amount_display,
          sub: `${p.impact.kinds[k].count} moves`,
          label: KIND[k].label.toLowerCase(),
          title: KIND[k].label,
        }))
      : [
          {
            value: String(new Set(p.moves.flatMap((m) => [m.from_channel, m.to_channel])).size),
            sub: `${p.moves.length} moves`,
            label: allowed[0] === 'week' ? 'channels re-timed' : 'channels change budget',
            title: KIND[allowed[0]].label,
          },
        ]),
  ]
  return (
    <Panel title="Net profit gain">
      <div className={TYPE.hero}>{gain?.display ?? '—'}</div>
      <div className={`mt-2 ${TYPE.label}`}>
        Profit % <span className="text-ink-primary">{p.current_figures.profit_pct.display}</span> →{' '}
        <span className="text-brand-violet">{p.figures.profit_pct.display}</span>{' '}
        {pct && pct.direction !== 'unchanged' && <span className={toneClass(pct.direction)}>({pct.display})</span>}
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
        <div className={TYPE.eyebrow}>Result</div>
        <div className="mt-1">
          <FactList
            items={[
              { label: 'Revenue', value: p.deltas.revenue?.display ?? '—', dot: 'var(--border-strong)' },
              { label: 'ROAS', value: `${p.current_figures.roas.display} → ${p.figures.roas.display}`, dot: 'var(--border-strong)' },
              { label: 'Ad spend', value: `${p.figures.spend.display} · unchanged`, dot: 'var(--border-strong)' },
            ]}
          />
        </div>
      </div>

      {gain?.range && (
        <div className="mt-5">
          <div className={TYPE.eyebrow}>How sure · {p.draws} model refits</div>
          <div className="mt-1">
            <FactList
              items={[
                {
                  label: 'Likely net profit gain',
                  value: gain.range.display,
                  dot: PLAN,
                  title: 'In 8 of every 10 model refits the gain falls in this range (P10 – P90)',
                },
                { label: 'Refits where the plan gains', value: `${p.chance_gain_pct.toFixed(0)}%`, dot: PLAN },
              ]}
            />
          </div>
        </div>
      )}
    </Panel>
  )
}

// --- current vs optimized ---------------------------------------------------

const ROWS: { key: FigureKey; label: string; neutral?: boolean }[] = [
  { key: 'profit', label: 'Net profit' },
  { key: 'profit_pct', label: 'Profit %' },
  { key: 'revenue', label: 'Revenue' },
  { key: 'incremental', label: 'Media-driven revenue' },
  { key: 'baseline', label: 'Baseline revenue', neutral: true },
  { key: 'spend', label: 'Ad spend', neutral: true },
  { key: 'roas', label: 'ROAS' },
]

/** TPO's FigureCompare, on this page's figures. */
function Compare({ plan: p }: { plan: BestPlan }) {
  return (
    <div className="overflow-x-auto">
      <table className="w-full min-w-[720px]">
        <thead>
          <tr className="border-b border-border-subtle">
            <th className={`w-[24%] pb-2.5 text-left ${TYPE.eyebrow}`}>Figure</th>
            <th className={`pb-2.5 pl-4 text-right ${TYPE.eyebrow}`}>Current plan</th>
            <th className={`pb-2.5 pl-4 text-right ${TYPE.eyebrow} !text-brand-violet`}>Optimized</th>
            <th className={`pb-2.5 pl-4 text-right ${TYPE.eyebrow}`}>Change</th>
            <th className={`pb-2.5 pl-4 text-right ${TYPE.eyebrow}`} title={`10th to 90th percentile over ${p.draws} model refits`}>
              Range P10 – P90
            </th>
          </tr>
        </thead>
        <tbody>
          {ROWS.map((row) => {
            const d = p.deltas[row.key]
            const moved = !!d && d.direction !== 'unchanged'
            const text = d ? (d.percent_display && row.key !== 'profit_pct' && row.key !== 'roas' ? `${d.display} (${d.percent_display})` : d.display) : ''
            return (
              <tr key={row.key} className="border-b border-border-subtle last:border-b-0">
                <td className={`py-3 ${TYPE.label}`}>{row.label}</td>
                <td className={`whitespace-nowrap py-3 pl-4 text-right ${TYPE.cell}`}>{p.current_figures[row.key].display}</td>
                <td className={`whitespace-nowrap py-3 pl-4 text-right ${TYPE.cell} !text-brand-violet`}>{p.figures[row.key].display}</td>
                <td className={`whitespace-nowrap py-3 pl-4 text-right ${TYPE.delta} ${moved && d ? (row.neutral ? 'text-ink-secondary' : toneClass(d.direction)) : 'text-ink-muted'}`}>
                  {moved ? text : '—'}
                </td>
                <td className={`whitespace-nowrap py-3 pl-4 text-right ${TYPE.cell} !text-ink-secondary`}>{p.figures[row.key].range?.display ?? '—'}</td>
              </tr>
            )
          })}
        </tbody>
      </table>
    </div>
  )
}

// --- week by week -----------------------------------------------------------

/** TPO's WeekTrend on the optimizer's weeks; the carryover after the period
 *  is counted in the totals and noted beneath, not plotted as a week. */
export function Weekly({
  weekly,
  format,
  nowLabel,
  planLabel = 'Optimized',
}: {
  weekly: BudgetWeek[]
  format: (v: number) => string
  nowLabel?: string
  planLabel?: string
}) {
  const weeks = weekly.filter((w) => !w.after)
  const tail = weekly.find((w) => w.after)
  const points: StudioWeek[] = weeks.map((w) => ({
    week: `${w.start.slice(0, 4)}-${w.week}`,
    start: w.start,
    month: Number(w.start.slice(5, 7)),
    promoted_now: 0,
    promoted_plan: 0,
    profit_now: w.profit_now,
    profit_plan: w.profit_plan,
    profit_p10: w.profit_plan_range[0],
    profit_p90: w.profit_plan_range[1],
    revenue_now: w.revenue_now,
    revenue_plan: w.revenue_plan,
    revenue_p10: w.revenue_plan_range[0],
    revenue_p90: w.revenue_plan_range[1],
    festival: null,
  }))
  return (
    <div>
      <WeekTrend
        weeks={points}
        format={format}
        planLabel={planLabel}
        nowLabel={nowLabel}
        detail={(i) => ({ label: 'Ad spend', value: `${format(weeks[i].spend_now)} → ${format(weeks[i].spend_plan)}` })}
      />
      {tail && (
        <div className={`mt-3 ${TYPE.label} !text-ink-muted`}>
          Net profit is revenue − ad spend in each week. Carryover in the {tail.days} days after the period adds {format(tail.revenue_now)} →{' '}
          {format(tail.revenue_plan)} of revenue, counted in the totals above.
        </div>
      )}
    </div>
  )
}

// --- spend response ---------------------------------------------------------

/** Who the two curves are: the current plan and the optimized one, unless a page names its own. */
export type CurveNames = { now: string; plan: string }
const CURVE_NAMES: CurveNames = { now: 'Current plan', plan: 'Optimized' }

export function CurveExplorer({
  curves,
  format,
  names = CURVE_NAMES,
}: {
  curves: ChannelCurve[]
  format: (v: number) => string
  names?: CurveNames
}) {
  // All channels first, then the channels whose budget moves most.
  const ordered = useMemo(() => {
    const [all, ...rest] = curves
    return [all, ...rest.sort((a, b) => Math.abs(b.plan.spend - b.current.spend) - Math.abs(a.plan.spend - a.current.spend))]
  }, [curves])
  const [key, setKey] = useState('__all__')
  const c = ordered.find((o) => o.key === key) ?? ordered[0]
  if (!c) return null
  const delta = c.plan.spend - c.current.spend
  const isAll = c.key === '__all__'
  const explain = isAll
    ? `With the same ${c.current.spend_display}, the optimized split earns ${c.plan.incremental_display} of media-driven revenue instead of ${c.current.incremental_display}: the optimized curve sits above the current one at every budget.`
    : Math.abs(delta) < 1
      ? `${c.label} keeps its budget; only its timing across weeks changes.`
      : delta > 0
        ? `${c.label} receives ${format(delta)}. Its next rupee still earns more here than elsewhere, until it returns ${c.plan.marginal_display}, the same as every other channel in the optimized plan.`
        : `${c.label} gives up ${format(-delta)}. At its current budget the next rupee returns only ${c.current.marginal_display}, less than it earns elsewhere.`
  const stats = [
    { label: 'Budget', now: c.current.spend_display, best: c.plan.spend_display },
    { label: 'Media-driven revenue', now: c.current.incremental_display, best: c.plan.incremental_display },
    { label: 'ROAS', now: c.current.roas_display, best: c.plan.roas_display },
  ]
  return (
    <div className="grid min-w-0 gap-6 @min-[1000px]:grid-cols-[260px_minmax(0,1fr)] [&>*]:min-w-0">
      <div className="overflow-hidden rounded-[var(--r-md)] border border-border-subtle self-start">
        <div className={`border-b border-border-subtle bg-surface-muted px-3 py-2 ${TYPE.label} !text-ink-muted`}>Channel · budget change</div>
        <nav aria-label="Channels" className="flex max-h-[420px] flex-col overflow-y-auto">
          {ordered.map((o) => {
            const d = o.plan.spend - o.current.spend
            const on = o.key === c.key
            return (
              <button
                key={o.key}
                type="button"
                onClick={() => setKey(o.key)}
                aria-current={on ? 'true' : undefined}
                className={`flex cursor-pointer items-center justify-between gap-2 border-b border-border-subtle px-3 py-2.5 text-left text-base transition-colors last:border-b-0 ${
                  on ? 'bg-brand-violet-50 font-medium text-brand-violet shadow-[inset_3px_0_0_var(--brand-violet)]' : 'text-ink-secondary hover:bg-surface-hover'
                }`}
              >
                <span className="min-w-0 truncate">{o.label}</span>
                {o.key !== '__all__' && (
                  <span className={`shrink-0 [font-variant-numeric:tabular-nums] ${Math.abs(d) < 1 ? 'text-ink-muted' : d > 0 ? 'text-status-success' : 'text-status-danger'}`}>
                    {Math.abs(d) < 1 ? 'Re-timed' : `${d > 0 ? '+' : '-'}${format(Math.abs(d))}`}
                  </span>
                )}
              </button>
            )
          })}
        </nav>
      </div>
      <div>
        <BigCurve curve={c} format={format} names={names} />
        <div className="mt-4 grid grid-cols-3 gap-3 @max-[700px]:grid-cols-1">
          {stats.map((st) => (
            <div key={st.label} className="rounded-[var(--r-md)] border border-border-subtle bg-surface-muted px-4 py-3.5">
              <div className={TYPE.label}>{st.label}</div>
              <div className={`mt-1 ${TYPE.cell}`}>
                {st.now} <span className="text-ink-muted">→</span> <span className="text-brand-violet">{st.best}</span>
              </div>
            </div>
          ))}
        </div>
        <p className={`mt-3 leading-relaxed ${TYPE.label}`}>{explain}</p>
      </div>
    </div>
  )
}

function BigCurve({ curve: c, format, names }: { curve: ChannelCurve; format: (v: number) => string; names: CurveNames }) {
  const { ref, width: w } = useChartWidth(720)
  const [hover, setHover] = useState<number | null>(null)
  const H = 320
  const padR = 18
  const padT = 14
  const padB = 56
  const all = [...c.points, ...c.plan_points]
  const maxX = Math.max(...all.map((p) => p.spend), 1)
  const yTop = Math.max(...all.map((p) => p.p90), 1) * 1.06
  const yt = niceTicks(0, yTop).filter((t) => t >= 0 && t <= yTop)
  const xt = niceTicks(0, maxX).filter((t) => t >= 0 && t <= maxX)
  const padL = Math.max(64, Math.max(...yt.map((t) => format(t).length)) * 9 + 30)
  const innerW = Math.max(1, w - padL - padR)
  const x = (v: number) => padL + (v / maxX) * innerW
  const y = (v: number) => padT + (1 - v / yTop) * (H - padT - padB)
  const path = (pts: CurvePoint[], pick: (p: CurvePoint) => number) => pts.map((p, i) => `${i ? 'L' : 'M'} ${x(p.spend)} ${y(pick(p))}`).join(' ')
  const be = Math.min(maxX, yTop)
  const hp = hover != null ? { now: c.points[hover], best: c.plan_points[hover] } : null
  const step = innerW / Math.max(c.points.length - 1, 1)
  return (
    <div>
      <div className="flex flex-wrap items-center gap-x-5 gap-y-1 text-base text-ink-secondary">
        <span className="inline-flex items-center gap-1.5">
          <span className="inline-block h-0.5 w-5 rounded" style={{ background: NOW }} /> {names.now}
        </span>
        <span className="inline-flex items-center gap-1.5">
          <span className="inline-block h-0.5 w-5 rounded" style={{ background: PLAN }} /> {names.plan}
        </span>
        <span className="inline-flex items-center gap-1.5">
          <span className="inline-block w-5 border-t-2 border-dashed" style={{ borderColor: PLAN, opacity: 0.6 }} /> P10 / P90
        </span>
        <span className="inline-flex items-center gap-1.5">
          <span className="inline-block w-5 border-t border-dashed border-[var(--text-muted)]" /> Break-even (ROAS 1)
        </span>
        <span className="inline-flex items-center gap-1.5">
          <span className="inline-block h-2.5 w-2.5 rounded-full" style={{ background: PLAN }} /> Each plan’s budget
        </span>
      </div>
      <div ref={ref} className="relative mt-3" onMouseLeave={() => setHover(null)}>
        <svg viewBox={`0 0 ${w} ${H}`} width="100%" height={H} role="img" aria-label={`${c.label} spend response`}>
          {yt.map((t) => (
            <g key={`y${t}`}>
              <line x1={padL} x2={padL + innerW} y1={y(t)} y2={y(t)} stroke="var(--border-subtle)" />
              <text x={padL - 8} y={y(t) + 4} textAnchor="end" fontSize={15} fill="var(--text-muted)">
                {format(t)}
              </text>
            </g>
          ))}
          <line x1={padL} x2={padL + innerW} y1={y(0)} y2={y(0)} stroke="var(--border-default)" />
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
            Media-driven revenue
          </text>
          <line x1={x(0)} y1={y(0)} x2={x(be)} y2={y(be)} stroke="var(--text-muted)" strokeDasharray="4 4" />
          <path d={path(c.plan_points, (p) => p.p90)} fill="none" stroke={PLAN} strokeOpacity={0.55} strokeWidth={1.3} strokeDasharray="4 3" />
          <path d={path(c.plan_points, (p) => p.p10)} fill="none" stroke={PLAN} strokeOpacity={0.55} strokeWidth={1.3} strokeDasharray="4 3" />
          <path d={path(c.points, (p) => p.incremental)} fill="none" stroke={NOW} strokeWidth={1.8} strokeLinejoin="round" />
          <path d={path(c.plan_points, (p) => p.incremental)} fill="none" stroke={PLAN} strokeWidth={2.2} strokeLinejoin="round" />
          <circle cx={x(c.current.spend)} cy={y(c.current.incremental)} r={5} fill="var(--surface-card)" stroke={NOW} strokeWidth={2} />
          <circle cx={x(c.plan.spend)} cy={y(c.plan.incremental)} r={5.5} fill={PLAN} stroke="var(--surface-card)" strokeWidth={1.5} />
          {hp && <line x1={x(hp.now.spend)} x2={x(hp.now.spend)} y1={padT} y2={H - padB} stroke="var(--text-muted)" strokeDasharray="3 3" />}
          {c.points.map((p, i) => (
            <rect key={i} x={x(p.spend) - step / 2} y={0} width={step} height={H - padB} fill="transparent" onMouseEnter={() => setHover(i)} />
          ))}
        </svg>
        {hp && hover != null && (
          <div
            className="pointer-events-none absolute top-2 z-10 min-w-[230px] rounded-[var(--r-md)] border border-border-subtle bg-surface-card px-3 py-2 text-base shadow-[var(--shadow-md)] [font-variant-numeric:tabular-nums]"
            style={{ left: `${Math.min(80, Math.max(20, (x(hp.now.spend) / w) * 100))}%`, transform: 'translateX(-50%)' }}
          >
            <div className="text-ink-primary">Budget {format(hp.now.spend)}</div>
            <TipRow label={names.now} value={format(hp.now.incremental)} dot={NOW} />
            <TipRow label={names.plan} value={format(hp.best.incremental)} dot={PLAN} />
            <TipRow label="P10 – P90" value={`${format(hp.best.p10)} – ${format(hp.best.p90)}`} />
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

// --- budget reallocations ---------------------------------------------------

type FlowView = 'source' | 'destination'
const PAGE = 10

function MoveChip({ m, view, label }: { m: Move; view: FlowView; label: (k: string) => string }) {
  const k = KIND[m.kind]
  const otherCh = view === 'source' ? m.to_channel : m.from_channel
  const otherWk = view === 'source' ? m.to_week : m.from_week
  const where = m.kind === 'week' ? weekLabel(otherWk) : m.kind === 'channel' ? label(otherCh) : `${label(otherCh)} · ${weekLabel(otherWk)}`
  return (
    <span
      title={`${k.label}: ${label(m.from_channel)} ${weekLabel(m.from_week)} → ${label(m.to_channel)} ${weekLabel(m.to_week)} · ${m.amount_display}`}
      className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-base font-medium [font-variant-numeric:tabular-nums] [&_svg]:h-3 [&_svg]:w-3 ${k.tone}`}
    >
      <Icon name={view === 'source' ? k.icon : 'arrowRight'} />
      {view === 'source' ? where : `from ${where}`} · {m.amount_display}
    </span>
  )
}

/** Every reallocation, TPO's "Promotions that change" table: one row per
 *  channel-week money leaves (or arrives at), its moves as chips. */
function Reallocations({ plan: p, summary: s, format }: { plan: BestPlan; summary: BudgetSummary; format: (v: number) => string }) {
  const [view, setView] = useState<FlowView>('source')
  const [kind, setKind] = useState<MoveKind | 'all'>('all')
  const [query, setQuery] = useState('')
  const [page, setPage] = useState(0)
  useEffect(() => setPage(0), [view, kind, query, p])
  const label = (k: string) => s.channels.find((c) => c.key === k)?.label ?? k
  const allowed = ALLOWED[p.mode]

  const groups = useMemo(() => {
    const moves = kind === 'all' ? p.moves : p.moves.filter((m) => m.kind === kind)
    const map = new Map<string, { channel: string; week: number; total: number; legs: Move[] }>()
    for (const m of moves) {
      const ch = view === 'source' ? m.from_channel : m.to_channel
      const wk = view === 'source' ? m.from_week : m.to_week
      const k = `${ch}|${wk}`
      const g = map.get(k) ?? { channel: ch, week: wk, total: 0, legs: [] }
      g.total += m.amount
      g.legs.push(m)
      map.set(k, g)
    }
    const q = query.trim().toLowerCase()
    return [...map.values()]
      .filter((g) => !q || [g.channel, ...g.legs.flatMap((m) => [m.from_channel, m.to_channel])].some((c) => label(c).toLowerCase().includes(q)))
      .sort((a, b) => b.total - a.total)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [p.moves, view, kind, query])
  const pages = Math.max(1, Math.ceil(groups.length / PAGE))
  const shown = groups.slice(page * PAGE, page * PAGE + PAGE)
  const startOf = (wk: number) => s.scope.weeks.find((w) => w.key === wk)?.start

  if (!p.moves.length) {
    return (
      <div className="flex items-center justify-center gap-2 rounded-[var(--r-md)] bg-ink-primary/[0.03] px-4 py-6 text-base text-ink-muted [&_svg]:h-4 [&_svg]:w-4">
        <Icon name="checkCircle" className="text-status-success" /> The current plan is already the best for this scope
      </div>
    )
  }

  return (
    <div>
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <QuickChip active={kind === 'all'} onClick={() => setKind('all')}>
          All · {p.impact.moved_display}
        </QuickChip>
        {allowed.map((k) => (
          <QuickChip key={k} active={kind === k} onClick={() => setKind(kind === k ? 'all' : k)} title={KIND[k].label}>
            <Icon name={KIND[k].icon} /> {KIND[k].short} · {p.impact.kinds[k].amount_display}
          </QuickChip>
        ))}
      </div>
      <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
        <div className="flex flex-wrap items-center gap-3">
          <Segmented
            label="View by"
            value={view}
            onChange={setView}
            options={[
              { value: 'source', label: 'Where it leaves' },
              { value: 'destination', label: 'Where it arrives' },
            ]}
          />
          <label className="flex h-10 w-[280px] items-center gap-2 rounded-[var(--r-md)] border border-border-default bg-surface-card px-3 text-base focus-within:border-brand-violet [&_svg]:h-4 [&_svg]:w-4">
            <Icon name="search" className="text-ink-muted" />
            <input
              style={{ outline: 'none' }}
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search channel"
              className="w-full bg-transparent text-ink-primary outline-none placeholder:text-ink-muted focus:outline-none"
            />
          </label>
        </div>
        <span className="text-base text-ink-muted">
          {groups.length} channel-weeks · {p.moves.length} moves
        </span>
      </div>

      <div className="overflow-x-auto rounded-[var(--r-md)] border border-border-subtle">
        <table className="w-full min-w-[820px] text-base [font-variant-numeric:tabular-nums]">
          <thead className="bg-surface-muted">
            <tr className="text-left text-base font-medium text-ink-muted">
              <th className="px-3 py-2 font-medium">{view === 'source' ? 'Moved from' : 'Moved to'}</th>
              <th className="px-3 py-2 font-medium">{view === 'source' ? 'Goes to' : 'Comes from'}</th>
              <th className="px-3 py-2 text-right font-medium">{view === 'source' ? 'Amount out' : 'Amount in'}</th>
            </tr>
          </thead>
          <tbody>
            {shown.map((g) => (
              <tr key={`${g.channel}|${g.week}`} className="border-t border-border-subtle align-top transition-colors hover:bg-surface-hover">
                <td className="px-3 py-2.5">
                  <div className="font-medium text-ink-primary">{label(g.channel)}</div>
                  <div className="text-base text-ink-muted">
                    {weekLabel(g.week)}
                    {startOf(g.week) && ` · week of ${dateText(startOf(g.week) as string)}`}
                  </div>
                </td>
                <td className="px-3 py-2.5">
                  <div className="flex max-w-[560px] flex-wrap gap-1">
                    {g.legs.map((m, i) => (
                      <MoveChip key={i} m={m} view={view} label={label} />
                    ))}
                  </div>
                </td>
                <td className={`px-3 py-2.5 text-right font-medium ${view === 'source' ? 'text-status-danger' : 'text-status-success'}`}>
                  {view === 'source' ? '-' : '+'}
                  {g.legs.length === 1 ? g.legs[0].amount_display : format(g.total)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {pages > 1 && <Pager page={page} pages={pages} onPage={setPage} />}
    </div>
  )
}

function Pager({ page, pages, onPage }: { page: number; pages: number; onPage: (p: number) => void }) {
  const btn =
    'grid h-9 w-9 cursor-pointer place-items-center rounded-[var(--r-md)] border border-border-subtle hover:bg-surface-hover disabled:cursor-not-allowed disabled:opacity-40 [&_svg]:h-4 [&_svg]:w-4'
  return (
    <div className="mt-3 flex items-center justify-end gap-2 text-base text-ink-secondary">
      <button type="button" className={btn} disabled={page === 0} onClick={() => onPage(page - 1)} aria-label="Previous page">
        <Icon name="chevronLeft" />
      </button>
      <span className="tabular-nums">
        {page + 1} / {pages}
      </span>
      <button type="button" className={btn} disabled={page >= pages - 1} onClick={() => onPage(page + 1)} aria-label="Next page">
        <Icon name="chevronRight" />
      </button>
    </div>
  )
}

// --- channel budgets --------------------------------------------------------

function ChannelTable({ rows }: { rows: ChannelMoves[] }) {
  return (
    <div className="overflow-x-auto rounded-[var(--r-md)] border border-border-subtle">
      <table className="w-full min-w-[860px] whitespace-nowrap text-base [font-variant-numeric:tabular-nums]">
        <thead className="bg-surface-muted">
          <tr className="text-left text-base font-medium text-ink-muted">
            <th className="px-3 py-2 font-medium">Channel</th>
            <th className="px-3 py-2 text-right font-medium">Current budget</th>
            <th className="px-3 py-2 text-right font-medium">Optimized budget</th>
            <th className="px-3 py-2 text-right font-medium">Change</th>
            <th className="px-3 py-2 text-right font-medium">Moved out</th>
            <th className="px-3 py-2 text-right font-medium">Moved in</th>
            <th className="px-3 py-2 text-right font-medium">Media revenue change</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => {
            const same = Math.abs(r.net) < 1
            return (
                <tr key={r.key} className="border-t border-border-subtle transition-colors hover:bg-surface-hover">
                  <td className="px-3 py-2.5 font-medium text-ink-primary">{r.label}</td>
                  <td className="px-3 py-2.5 text-right text-ink-primary">{r.spend_now_display}</td>
                  <td className="px-3 py-2.5 text-right text-brand-violet">{r.spend_plan_display}</td>
                  <td className={`px-3 py-2.5 text-right font-medium ${same ? 'text-ink-muted' : r.net > 0 ? 'text-status-success' : 'text-status-danger'}`}>
                    {same ? 'Re-timed only' : r.net_display}
                  </td>
                  <td className="px-3 py-2.5 text-right text-ink-secondary">{r.gives_display}</td>
                  <td className="px-3 py-2.5 text-right text-ink-secondary">{r.receives_display}</td>
                  <td className="px-3 py-2.5 text-right font-medium">{r.incremental_change_display}</td>
                </tr>
            )
          })}
        </tbody>
      </table>
    </div>
  )
}

// --- how it works -----------------------------------------------------------

function HowItWorks({ model: m, tail }: { model: ModelCard; tail: number }) {
  return (
    <InfoPopover label="How it works" title="How it works" width={380}>
      <ul className="mt-1.5 list-disc space-y-1 pl-4 leading-snug text-ink-secondary">
        <li>Baseline: trend, seasonality, day of week, festival / seasonal / promotion flags, discount and promotion type.</li>
        <li>Each channel: carryover and diminishing returns, fitted with the baseline; channel returns pooled toward their average.</li>
        {m.holdout_last_year && (
          <li>
            Last year, unseen: revenue off by {m.holdout_last_year.mape_pct.toFixed(2)}% a day on average (R² {m.holdout_last_year.r2.toFixed(2)}).
          </li>
        )}
        <li>Ranges: {m.bootstraps ?? 0} model refits on resampled months, shown as P10 – P90.</li>
        <li>
          The budget is fixed, so every change is a reallocation. One best plan exists, since every response curve flattens. Carryover is counted {tail}{' '}
          days after the period. Estimates tend to be optimistic.
        </li>
        <li>Net profit = revenue − ad spend; Profit % = net profit ÷ ad spend.</li>
      </ul>
    </InfoPopover>
  )
}
