import { useMemo } from 'react'
import { useNavigate } from 'react-router-dom'
import { AppShell } from '../components/layout/AppShell'
import { Card, CardBody, InfoPopover, Spinner, Tabs, useToast } from '../components/ui'
import { Icon } from '../icons'
import { SelectionBar } from '../components/planner/SelectionBar'
import { WhatIfPanel } from '../components/planner/WhatIfPanel'
import { TargetPanel } from '../components/planner/TargetPanel'
import { BestPlanPanel } from '../components/planner/BestPlanPanel'
import { plannerScenario } from '../components/planner/decision'
import { offerColor, Segmented, StudioButton as Button, TYPE } from '../components/planner/shared'
import { useDebounced } from '../hooks/useDebounced'
import { usePlannerBest, usePlannerCurve, usePlannerOptions, usePlannerSummary, usePlannerTarget, usePlannerWhatIf } from '../hooks/usePlanner'
import { ApiError } from '../lib/api'
import { MAX_SCENARIOS, useDecisionScenarios } from '../store/decisionScenarios'
import { DEFAULTS, EMPTY_SELECTION, usePlannerSelection, type PlannerTab } from '../store/plannerSelection'
import type { Deltas, Figures, PlannerSelection, SummaryResponse } from '../types/planner'

/** TPO Simulation Studio.
 *
 *  Pick a period and any products, stores, channels and regions; the studio
 *  reads every promotion that ran there and answers three questions:
 *  What-if (move the average discount), Profit target (+X% promotion profit:
 *  what has to change) and Best plan (every promotion's offer and week
 *  re-chosen). From the Promotion Calendar a single promotion arrives as the
 *  selection.
 *
 *  THIS PAGE COMPUTES NOTHING: the selection goes to /api/planner/*, and every
 *  figure on screen is the backend's display string. */

const TABS: { key: PlannerTab; label: string }[] = [
  { key: 'whatif', label: 'What-if discount' },
  { key: 'target', label: 'Profit target' },
  { key: 'best', label: 'Best plan' },
]

export function PromotionPlanner() {
  const navigate = useNavigate()
  const { show } = useToast()
  const selection = usePlannerSelection((s) => s.selection)
  const origin = usePlannerSelection((s) => s.origin)
  const tab = usePlannerSelection((s) => s.tab)
  const setTab = usePlannerSelection((s) => s.setTab)
  const timing = usePlannerSelection((s) => s.timing)
  const setTiming = usePlannerSelection((s) => s.setTiming)
  const count = usePlannerSelection((s) => s.count)
  const setCount = usePlannerSelection((s) => s.setCount)
  const targetPct = usePlannerSelection((s) => s.targetPct)
  const setTargetPct = usePlannerSelection((s) => s.setTargetPct)
  const basis = usePlannerSelection((s) => s.basis)
  const discount = usePlannerSelection((s) => s.discount)
  const setDiscount = usePlannerSelection((s) => s.setDiscount)
  const clearFocus = usePlannerSelection((s) => s.clearFocus)
  const resetAll = usePlannerSelection((s) => s.reset)
  const currency = usePlannerSelection((s) => s.currency)
  const setCurrency = usePlannerSelection((s) => s.setCurrency)

  //: Came in from the Promotion Calendar's "Simulate this promotion": one
  //: offer in one channel-month, so only What-if is shown. See the tab strip.
  const fromCalendar = origin?.source === 'calendar'
  //: What is actually rendered. `carry` sets the tab to What-if on the way in,
  //: but a session restored from storage can hold 'target' or 'best' with a
  //: calendar origin -- and with the strip hidden that would render nothing at
  //: all. Pinning it here means the page always has a panel to show.
  const activeTab: PlannerTab = fromCalendar ? 'whatif' : tab

  const atDefaults =
    JSON.stringify(selection) === JSON.stringify(EMPTY_SELECTION) &&
    origin === null && discount === null && tab === DEFAULTS.tab && timing === DEFAULTS.timing &&
    count === DEFAULTS.count && targetPct === DEFAULTS.targetPct

  const options = usePlannerOptions(selection)
  // No period chosen yet: the latest year the data holds, as far as it goes.
  const effective: PlannerSelection | null = useMemo(() => {
    if (selection.month || (selection.start && selection.end)) return selection
    if (!options.data) return null
    return { ...selection, start: options.data.default_period.start, end: options.data.default_period.end }
  }, [selection, options.data])
  const focus = !!effective?.promotion

  const summary = usePlannerSummary(effective, currency)
  const sd = summary.data
  const lever = sd?.lever ?? null
  const scopeKey = JSON.stringify(effective)
  const leverValue = lever ? (discount?.key === scopeKey ? discount.value : lever.default) : null
  const settled = useDebounced(leverValue, 150)

  const whatif = usePlannerWhatIf(activeTab === 'whatif' && lever ? effective : null, currency, settled)
  const curve = usePlannerCurve(effective, currency, activeTab === 'whatif' && !!lever)
  const target = usePlannerTarget(effective, currency, targetPct, timing, count, basis, activeTab === 'target' && !!sd)
  const best = usePlannerBest(effective, currency, timing, count, activeTab === 'best' && !!sd)

  // ADD TO DECISION CENTER: a snapshot of what is on screen.
  const held = useDecisionScenarios((s) => s.scenarios)
  const addScenario = useDecisionScenarios((s) => s.add)
  const label = sd ? scopeLabel(sd, origin?.title) : ''
  const addButton = (kind: string, plan: Figures | undefined, deltas: Deltas | undefined, current: Figures | undefined, busy: boolean) => {
    if (!effective || !sd) return null
    const full = held.length >= MAX_SCENARIOS
    const disabled = busy || !plan || !deltas || !current || full
    return (
      <span className="flex items-center gap-2">
        <Button
          variant="primary"
          size="md"
          disabled={disabled}
          title={full ? `Decision Center holds ${MAX_SCENARIOS} — remove one there first` : undefined}
          onClick={() => {
            if (!plan || !deltas || !current) return
            const added = addScenario(plannerScenario({ kind, label, selection: effective, currency, current, plan, deltas, weeks: sd.scope.weeks }))
            show(added ? `Added as Scenario ${added.slot} in Decision Center` : 'Already in Decision Center', { duration: 3000 })
          }}
        >
          <Icon name="plus" /> Decision Center
        </Button>
        {held.length > 0 && (
          <Button variant="ghost" size="md" className="!text-brand-violet" onClick={() => navigate('/decision')}>
            {held.length}/{MAX_SCENARIOS} →
          </Button>
        )}
      </span>
    )
  }

  const start = sd?.scope.start ?? effective?.start ?? null
  const end = sd?.scope.end ?? effective?.end ?? null
  const summaryError = summary.error instanceof ApiError ? summary.error : null
  const crumbs = [{ label: 'TPO Intelligence' }, { label: 'Simulation Studio' }]

  return (
    <AppShell activeKey="simulation" crumbs={crumbs}>
      <div>
      <div className="fade-in flex flex-wrap items-center justify-between gap-x-4 gap-y-3">
        <h1 className="flex items-center gap-2 text-2xl font-normal tracking-[-0.02em]">
          Simulation Studio <Icon name="sparkles" className="h-5 w-5 text-brand-violet" />
          {sd && <HowItWorks model={sd.model} />}
        </h1>
        <div className="flex items-center gap-2">
          <Segmented
            label="Currency"
            value={currency}
            onChange={setCurrency}
            options={[
              { value: 'INR', label: '₹ INR' },
              { value: 'USD', label: '$ USD' },
            ]}
          />
          <Button
            variant="secondary"
            disabled={atDefaults}
            title={atDefaults ? 'Nothing to reset' : 'Clear every filter and control'}
            onClick={() => {
              resetAll()
              show('Reset to the current plan', { duration: 2500 })
            }}
          >
            <Icon name="refresh" /> <span>Reset</span>
          </Button>
        </div>
      </div>

      <div className="mt-4">
        <SelectionBar
          options={options.data}
          start={start}
          end={end}
          periodLocked={focus ? 'The promotion’s own month' : undefined}
          dimsLocked={focus ? ['channels'] : undefined}
        />
      </div>

      {origin && (
        <div className="mt-3 flex flex-wrap items-center justify-between gap-3 rounded-[var(--r-lg)] border border-brand-violet-100 bg-brand-violet-50 px-4 py-2.5">
          <div className="flex min-w-0 flex-1 flex-wrap items-center gap-x-2 gap-y-1 text-base">
            <span className="inline-flex items-center gap-1.5 font-medium text-brand-violet [&_svg]:h-4 [&_svg]:w-4">
              <Icon name={origin.source === 'calendar' ? 'calendar' : 'investigations'} />
              {origin.source === 'calendar' ? 'From the calendar' : 'From Promotion Intelligence'}
            </span>
            {[origin.title, ...origin.facts].filter(Boolean).map((f) => (
              <span key={f} className="flex items-center gap-x-2 font-medium text-ink-primary">
                <span className="text-ink-muted">·</span>
                <span className="max-w-[420px] truncate" title={f}>
                  {f}
                </span>
              </span>
            ))}
          </div>
          <div className="flex items-center gap-2">
            {origin.source === 'calendar' && (
              <Button variant="secondary" size="md" onClick={() => navigate('/calendar')}>
                <Icon name="chevronLeft" /> Calendar
              </Button>
            )}
            <Button variant="secondary" size="md" onClick={clearFocus}>
              <Icon name="x" /> Clear
            </Button>
          </div>
        </div>
      )}

      {((summary.isPending && effective) || (!effective && options.isPending)) && (
        <div className="mt-6 flex items-center gap-3 text-base text-ink-muted">
          <Spinner /> Loading…
        </div>
      )}

      {/* THE BOOTSTRAP CAN FAIL TOO. Everything below waits on the period and
          the filter lists; if that call is the one that fails, nothing below
          renders and the page was simply blank under its own title -- no
          message, no retry, nothing to say the request was the problem. */}
      {!effective && options.isError && (
        <Card className="mt-4">
          <CardBody>
            <div className={TYPE.title}>Could not load this workspace</div>
            <div className="mt-1 text-base text-ink-muted">{options.error.message}</div>
            <Button variant="secondary" className="mt-3" onClick={() => options.refetch()}>
              <Icon name="refresh" /> Retry
            </Button>
          </CardBody>
        </Card>
      )}

      {summary.isError && (
        <Card className="mt-4">
          <CardBody>
            <div className={TYPE.title}>
              {summaryError?.status === 422 ? 'Nothing to plan here' : 'Could not read this selection'}
            </div>
            <div className="mt-1 text-base text-ink-muted">{summary.error.message}</div>
            {summaryError?.status !== 422 && (
              <Button variant="secondary" className="mt-3" onClick={() => summary.refetch()}>
                <Icon name="refresh" /> Retry
              </Button>
            )}
          </CardBody>
        </Card>
      )}

      {sd && (
        <>
          <CurrentPlan summary={sd} />

          {/* ONE PROMOTION, ONE QUESTION. Arriving from the Promotion Calendar
              the scope is a single offer in one channel-month, and the other
              two tabs do not mean anything there: Profit target re-plans the
              selection to hit a number, and Best plan rebuilds its calendar --
              both answer for a portfolio, not for the one promotion the reader
              clicked. So the hand-off shows What-if alone, and the tab strip is
              hidden rather than shown with two dead options. Clearing the
              origin (the Reset in SelectionBar) brings all three back. */}
          {!fromCalendar && (
            <div className="mt-5 [&_button]:!text-base">
              <Tabs tabs={TABS} active={tab} onChange={(k) => setTab(k as PlannerTab)} />
            </div>
          )}

          {activeTab === 'whatif' &&
            (lever && leverValue != null ? (
              <WhatIfPanel
                lever={lever}
                value={leverValue}
                onChange={(v) => setDiscount(scopeKey, v)}
                result={whatif.data}
                curve={curve.data}
                fetching={whatif.isFetching}
                error={whatif.error}
                curveError={curve.error}
                action={whatif.data && Math.abs(whatif.data.shift_pts) >= 0.005
                  ? addButton('What-if', whatif.data.scenario, whatif.data.deltas, whatif.data.current, whatif.isFetching)
                  : undefined}
              />
            ) : (
              <Card>
                <CardBody>
                  <div className={TYPE.title}>No promotion runs here</div>
                  <div className="mt-1 text-base text-ink-muted">Widen the period, or use Best plan with "Allow more".</div>
                </CardBody>
              </Card>
            ))}

          {activeTab === 'target' && (
            <TargetPanel
              targetPct={targetPct}
              onTarget={setTargetPct}
              timing={timing}
              count={count}
              onTiming={setTiming}
              onCount={setCount}
              focus={focus}
              data={target.data}
              fetching={target.isFetching}
              error={target.error}
            />
          )}

          {activeTab === 'best' && (
            <BestPlanPanel
              timing={timing}
              count={count}
              onTiming={setTiming}
              onCount={setCount}
              focus={focus}
              data={best.data}
              fetching={best.isFetching}
              error={best.error}
              action={best.data ? addButton('Optimized plan', best.data.replan.figures, best.data.replan.deltas, best.data.current, best.isFetching) : undefined}
            />
          )}
        </>
      )}
      </div>
    </AppShell>
  )
}

// --- pieces ----------------------------------------------------------------

function scopeLabel(s: SummaryResponse, title?: string): string {
  const parts = [title ?? '', s.scope.period, `${s.scope.product_stores} product-stores`].filter(Boolean)
  return parts.join(' · ')
}

/** The current plan: one strip of figures, then the offers it runs. */
function CurrentPlan({ summary: s }: { summary: SummaryResponse }) {
  const c = s.current
  const stats: { label: string; value: string; icon: Parameters<typeof Icon>[0]['name']; info?: string }[] = [
    { label: 'Profit', value: c.profit.display, icon: 'coins', info: 'SP − CP: revenue after discount − product cost − promotion cost' },
    { label: 'Profit %', value: c.profit_pct.display, icon: 'trending', info: '(SP − CP) ÷ CP × 100' },
    { label: 'Revenue', value: c.revenue.display, icon: 'wallet', info: 'SP: revenue at the prices paid' },
    { label: 'Trade spend', value: c.trade_spend.display, icon: 'tag', info: 'Discount given + promotion cost' },
    { label: 'ROI', value: c.roi.display, icon: 'gauge', info: 'Incremental sales ÷ trade spend' },
    { label: 'Avg discount', value: c.avg_discount.display, icon: 'pricing' },
  ]
  return (
    <div className="fade-in mt-4 rounded-[var(--r-lg)] border border-border-subtle bg-surface-card shadow-[var(--shadow-card-soft)]">
      <div className="flex flex-wrap items-baseline gap-x-3 border-b border-border-subtle px-5 py-3">
        <span className={TYPE.title}>Current plan</span>
        <span className="text-base text-ink-muted">
          {s.scope.weeks} weeks · {s.scope.product_stores.toLocaleString()} product-stores · {c.promotions.display} promotions · {s.scope.channels.length} channel{s.scope.channels.length === 1 ? '' : 's'}
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
      {s.offers.length > 0 && (
        <div className="flex flex-wrap items-center gap-1.5 border-t border-border-subtle px-5 py-3">
          {s.offers.map((o) => {
            const col = offerColor(o)
            return (
              <span
                key={o.id}
                title={`${o.name} · ${o.depth_pct}% · ${o.runs.toLocaleString()} runs · ${o.product_stores} product-stores · ROI ${o.roi}`}
                className="inline-flex items-center gap-1.5 rounded-full border bg-surface-card px-2.5 py-1 text-base"
                style={{ borderColor: col.border }}
              >
                <span className="h-2 w-2 rounded-full" style={{ background: col.border }} />
                <span className="font-medium text-ink-primary">{o.name.replace(/\s+\d{2}$/, '')}</span>
                <span className="text-ink-muted">{o.runs.toLocaleString()}</span>
              </span>
            )
          })}
        </div>
      )}
    </div>
  )
}

function HowItWorks({ model: m }: { model: SummaryResponse['model'] }) {
  const b = m.backtest
  const held = m.festival_backtest.events ?? []
  return (
    <InfoPopover label="How it works" title="How it works" width={360}>
      <ul className="mt-1.5 list-disc space-y-1 pl-4 text-base font-medium leading-snug text-ink-secondary">
        <li>Baseline: {m.baseline}, per product, store and week.</li>
        <li>
          Lift: hierarchical Bayes, sampled with NUTS — {m.curve}, pooled across {m.groups} brand × channel groups.
        </li>
        <li>
          Fitted on {m.fit_rows.toLocaleString()} product-channel-weeks · {m.chains} chains × {m.draws_per_chain?.toLocaleString()} draws · R-hat{' '}
          {m.rhat_max?.toFixed(2)} · {m.divergences} divergences.
        </li>
        <li>Ranges: Monte Carlo over {m.mc_draws.toLocaleString()} posterior draws, shown as P10 – P90.</li>
        {b.wape_units_pct != null && <li>Unseen weeks: units within {b.wape_units_pct.toFixed(2)}%.</li>}
        {held.length > 0 && (
          <li>
            Held-out {held.map((e) => `${e.event.split(' ')[0]} ${e.year}`).join(' and ')}: {held.every((e) => e.within_band) ? 'inside the predicted range' : 'checked against the range'}.
          </li>
        )}
        <li>Best discount: highest median profit. Target: goal programming, exact discount by Brent’s method.</li>
        <li>Profit = SP − CP; Profit % = (SP − CP) ÷ CP. The current plan is always the measured figures.</li>
      </ul>
    </InfoPopover>
  )
}
