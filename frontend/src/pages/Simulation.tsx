import { useEffect, useMemo, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { AppShell } from '../components/layout/AppShell'
import { Button, Card, CardBody, CardHeader, InfoPopover, Spinner, useToast } from '../components/ui'
import { Icon } from '../icons'
import { FilterBar } from '../components/command/FilterBar'
import { ExportReportButton } from '../components/reports/ExportReportButton'
import { LeverSlider } from '../components/studio/LeverSlider'
import { ResultStrip } from '../components/studio/ResultStrip'
import { RoiStatusPill } from '../components/studio/RoiStatusPill'
import { SeriesLegend, WindowChart } from '../components/studio/WindowChart'
import { CurveChart } from '../components/studio/CurveChart'
import { useFilterOptionsFor } from '../hooks/useCommandCenter'
import { useDebounced, useStudioCurve, useStudioOptimize, useStudioScope, useStudioSimulate, type Levers } from '../hooks/useStudio'
import { ApiError } from '../lib/api'
import { toApiFilters } from '../lib/scope'
import { useStudioFilters } from '../store/studioFilters'
import { useStudioHandoff } from '../store/studioHandoff'
import { MAX_SCENARIOS, scenarioSignature, useDecisionScenarios, type ScenarioKpi } from '../store/decisionScenarios'
import type { FiltersResponse } from '../types/commandCenter'
import type { Direction, MoneyDelta, OptimizableLever, OptimizeResponse, ScopeResponse, SimulateResponse } from '../types/studio'

/** TPO Simulation Studio — three levers, one window.
 *
 *  Discount, trade-spend budget and days. Move any of them and the page shows
 *  what happens to Revenue and to ROI over that many days, beside the scope's
 *  current plan run over the same window.
 *
 *  THIS PAGE COMPUTES NOTHING. It posts the scope to /api/simulation/scope for
 *  the lever ranges, the three lever values to /api/simulation/simulate for the
 *  window, and the budget and days to /api/simulation/curve for the shape the
 *  discount slider moves along. Every figure on screen is a display string
 *  produced by the validated KPI engine over rows the studio synthesized.
 *  Nothing here subtracts, divides or rounds.
 *
 *  OPTIMIZE. Only while a product carried in from Promotion Intelligence is
 *  the selection. Each lever card gets a tick; a ticked lever is free to
 *  vary from its minimum up to where its slider sits (the slider IS the
 *  ceiling — move it and the range follows), an unticked one is held. The
 *  button posts the three levers and the ranges to /api/simulation/optimize
 *  and shows what came back beside what is on the sliders; "Apply" moves
 *  the sliders there. The page never searches anything itself.
 *
 *  SCOPE. The studio's own filter state (store/studioFilters.ts), edited by
 *  the filter bar here. Promotion Intelligence's "Go to Simulation" pre-selects
 *  its product in that store (store/studioHandoff.ts); the option lists then
 *  cascade to that product's data, and clearing the product — from the banner
 *  or the Product dropdown — brings everything back.
 */
const NO_VARY: Record<OptimizableLever, number | null> = { discount_pct: null, trade_spend: null, days: null }
const LEVER_LABEL: Record<OptimizableLever, string> = { discount_pct: 'Discount', trade_spend: 'Trade spend', days: 'Days' }
/** In the Optimize card the budget sits one table away from the Trade Spend
 *  the engine measured, and they are different numbers — a budget of ₹81.35 L
 *  funding a 9% window that only costs ₹27.28 L. Naming them both "Trade
 *  spend" made the card look like it contradicted itself. */
const OPTIMIZE_LEVER_LABEL: Record<OptimizableLever, string> = {
  discount_pct: 'Discount',
  trade_spend: 'Trade spend budget',
  days: 'Days',
}

export function Simulation() {
  const studioFilters = useStudioFilters((s) => s.filters)
  const currency = useStudioFilters((s) => s.currency)
  const initialise = useStudioFilters((s) => s.initialise)
  const resetFilters = useStudioFilters((s) => s.reset)
  const filterOptions = useFilterOptionsFor(studioFilters)
  const handoff = useStudioHandoff((s) => s.handoff)
  const clearHandoff = useStudioHandoff((s) => s.clear)

  // The default period, once the backend says which years exist — the same
  // rule the Insights Hub applies, never a hardcoded year.
  useEffect(() => {
    const years = filterOptions.data?.years
    if (years?.length) initialise(Math.max(...years))
  }, [filterOptions.data?.years, initialise])

  // The hand-off is live only while its product is still the selection.
  const carriedProduct = handoff && studioFilters.product[0] === handoff.productId ? handoff : null
  const carriedName = carriedProduct
    ? (filterOptions.data?.products.find((p) => p.code === carriedProduct.productId)?.name ?? carriedProduct.productId)
    : null
  const offerName = studioFilters.promotion[0]
    ? (filterOptions.data?.offers.find((o) => o.code === studioFilters.promotion[0])?.name ?? studioFilters.promotion[0])
    : null
  const releaseProduct = () => {
    clearHandoff()
    resetFilters()
  }
  // The offer travels with the product and is not on the bar. If the product
  // is cleared from the dropdown instead of the banner, the offer must not
  // linger as an invisible filter.
  const setFilter = useStudioFilters((s) => s.set)
  useEffect(() => {
    if (handoff && studioFilters.product[0] !== handoff.productId) {
      clearHandoff()
      if (studioFilters.promotion.length) setFilter('promotion', [])
    }
  }, [handoff, studioFilters.product, studioFilters.promotion, clearHandoff, setFilter])

  const filters = useMemo(() => toApiFilters(studioFilters), [studioFilters])
  const scopeKey = JSON.stringify([filters, currency])
  const scope = useStudioScope(filters, currency)

  // THE LEVERS. Seeded from the scope's own plan when a scope arrives — its
  // observed depth, its typical run length, and what that costs at full
  // coverage — so the page opens with the scenario equal to the current plan
  // and every delta at zero.
  const [levers, setLevers] = useState<Levers | null>(null)
  const [seededFor, setSeededFor] = useState<string | null>(null)
  useEffect(() => {
    if (!scope.data || seededFor === scopeKey) return
    setLevers(defaultsOf(scope.data))
    setSeededFor(scopeKey)
  }, [scope.data, scopeKey, seededFor])

  // OPTIMIZE'S TICKS. Per lever, the top of the range it may search, or
  // null when the lever is held. Set to the slider's value when ticked, and
  // kept at the slider's value while ticked, so the reader has one control
  // for "how far": the slider. Cleared with the scope and with the hand-off,
  // since both are what the ranges were about.
  const [vary, setVary] = useState<Record<OptimizableLever, number | null>>(NO_VARY)
  const [optimized, setOptimized] = useState<{ response: OptimizeResponse; forLevers: string } | null>(null)
  const optimize = useStudioOptimize()
  useEffect(() => {
    setVary(NO_VARY)
    setOptimized(null)
  }, [scopeKey, carriedProduct?.productId])

  const moveLever = (key: OptimizableLever, value: number) => {
    if (!levers) return
    setLevers({ ...levers, [key]: value })
    if (vary[key] != null) setVary({ ...vary, [key]: value })
  }
  const toggleVary = (key: OptimizableLever) => {
    if (!levers) return
    setVary({ ...vary, [key]: vary[key] == null ? levers[key] : null })
  }

  const settled = useDebounced(levers)
  const live = seededFor === scopeKey ? settled : null
  const result = useStudioSimulate(filters, currency, live)
  const curve = useStudioCurve(filters, currency, live)

  const rate = scope.data?.exchange_rate ?? 1
  const symbol = currency === 'USD' ? '$' : '₹'
  const money = (v: number) => formatMoney(v, rate, symbol)

  // THE BUDGET SLIDER'S RANGE follows the other two levers. The scope's
  // ceiling is the worst case — the deepest depth over the longest window,
  // priced at the top of the band — so at a 7-day plan costing ₹81.35 L it
  // put seven eighths of the track beyond full coverage, where dragging
  // changed nothing but the unspent figure. The live full-coverage cost is
  // what "the whole scope" costs AT these levers, so the track runs a
  // quarter past it: the binding range is most of the travel, the starting
  // budget sits where the scope is exactly funded, and there is room to
  // overspend on purpose.
  //
  // THE BUDGET IS NEVER CLAMPED. It is the one lever that is a constraint
  // the reader brings ("this is the money I have"), not a plan choice, and
  // "how many days can I fund with this?" is the reason to drag Days at all.
  // So the track also never ends below the budget already settled: shortening
  // the window makes the budget generous, it does not confiscate it. The
  // settled budget, not the live one, so dragging this slider cannot stretch
  // the track it is being dragged along.
  const spendLever = useMemo(() => {
    const base = scope.data?.levers.trade_spend
    if (!base) return null
    const cost = result.data?.levers.trade_spend.full_coverage_cost.value ?? 0
    const settledSpend = result.data?.levers.trade_spend.requested.value ?? 0
    if (cost <= 0) return base
    const useful = Math.ceil((cost * 1.25) / base.step) * base.step
    const max = Math.min(base.max, Math.max(useful, settledSpend))
    return { ...base, max, max_display: formatMoney(max, rate, symbol) }
  }, [scope.data, result.data, rate, symbol])

  const reset = () => {
    if (!scope.data) return
    setLevers(defaultsOf(scope.data))
    setVary(NO_VARY)
    setOptimized(null)
  }
  const atDefaults = !!scope.data && !!levers && JSON.stringify(levers) === JSON.stringify(defaultsOf(scope.data))

  // ADD TO DECISION CENTER. A snapshot of what is on screen — the display
  // strings the engine returned for these levers over this scope. The same
  // scenario cannot be added twice, and the board holds three.
  const navigate = useNavigate()
  const { show } = useToast()
  const held = useDecisionScenarios((s) => s.scenarios)
  const addScenario = useDecisionScenarios((s) => s.add)
  const signature = levers ? scenarioSignature(filters, currency, levers) : null
  const alreadyAdded = signature != null && held.some((s) => s.signature === signature)
  const boardFull = held.length >= MAX_SCENARIOS
  const settledOnScreen = !!result.data && !result.isFetching && JSON.stringify(levers) === JSON.stringify(settled)
  const addBlocker = !settledOnScreen
    ? 'Wait for the scenario to finish'
    : alreadyAdded
      ? 'This scenario is already in Decision Center'
      : boardFull
        ? `Decision Center holds ${MAX_SCENARIOS} scenarios — remove one there first`
        : null
  const addToDecisionCenter = () => {
    if (!result.data || !levers || !scope.data || addBlocker) return
    const added = addScenario({
      signature: signature!,
      scope: { label: scopeLabel(scope.data, studioFilters, filterOptions.data), filters, currency },
      levers,
      kpis: kpisOf(result.data),
    })
    if (added) show(`Added as Scenario ${added.slot} · ${held.length + 1} of ${MAX_SCENARIOS} in Decision Center`, { duration: 3000 })
  }

  // OPTIMIZE. The blocker names the reason the button is off, so nobody
  // has to guess which of the three conditions is unmet.
  const ticked = (Object.keys(vary) as OptimizableLever[]).filter((k) => vary[k] != null)
  const emptyRange = ticked.find((k) => (vary[k] ?? 0) <= 0)
  // An Optimize answer is standing in for the exploration deck -- but only
  // while it still describes what is on the sliders. The moment the reader
  // moves one they are exploring again, the card says so itself, and hiding
  // the charts would leave them unable to see the move they just made.
  const optimizeStale = !!optimized && JSON.stringify(levers) !== optimized.forLevers
  const optimizeAnswered = !!optimized && !!carriedProduct && !optimizeStale
  const optimizeBlocker = !carriedProduct
    ? 'Optimize is for the product carried in from Promotion Intelligence'
    : !levers || !scope.data
      ? 'Wait for the scope'
      : ticked.length === 0
        ? 'Tick at least one lever to give Optimize something to vary'
        : emptyRange
          ? `Move the ${LEVER_LABEL[emptyRange]} slider above zero to give Optimize a range`
          : optimize.isPending
            ? 'Optimizing…'
            : null
  const runOptimize = () => {
    if (!levers || optimizeBlocker) return
    const ranges = Object.fromEntries(ticked.map((k) => [k, vary[k]])) as Partial<Record<OptimizableLever, number>>
    optimize.mutate(
      { filters, currency, ...levers, vary: ranges },
      {
        onSuccess: (response) => setOptimized({ response, forLevers: JSON.stringify(levers) }),
        onError: (e) => show(e instanceof Error ? e.message : 'Optimize could not run', { duration: 4000 }),
      },
    )
  }
  const applyOptimized = () => {
    if (!optimized) return
    const b = optimized.response.best.levers
    setLevers({ discount_pct: b.discount_pct, trade_spend: b.trade_spend, days: b.days })
    setVary(NO_VARY)
    setOptimized(null)
    show('Sliders set to the optimized values', { duration: 3000 })
  }
  const varyRange = (key: OptimizableLever): string => {
    const top = vary[key] ?? 0
    if (key === 'discount_pct') return `0% → ${top.toFixed(2)}%`
    if (key === 'days') return `1 → ${top} day${top === 1 ? '' : 's'}`
    return `${symbol}0 → ${money(top)}`
  }
  const varyProps = (key: OptimizableLever) =>
    carriedProduct ? { on: vary[key] != null, range: varyRange(key), onToggle: () => toggleVary(key) } : undefined

  const crumbs = [{ label: 'TPO Intelligence' }, { label: 'Simulation Studio' }]
  const scopeError = scope.error instanceof ApiError ? scope.error : null

  // A CARRIED PRODUCT'S FIGURES, for its banner: what it measured and the
  // plan the three levers open on. The period, the product-channel count and
  // the plan's cost are left out — the banner names the product, and the
  // Trade Spend lever below already shows what the plan costs.
  const sd = scope.data
  const bannerFacts = sd
    ? [
        sd.measured.roi.value != null
          ? `Trade spend ${sd.measured.trade_spend.display} · Incremental sales ${sd.measured.incremental_sales.display} · ROI ${sd.measured.roi.display}`
          : null,
        `Current plan ${sd.observed_plan.discount_pct.toFixed(2)}% for ${sd.observed_plan.days} days`,
      ].filter((f): f is string => f != null)
    : []

  return (
    <AppShell activeKey="simulation" crumbs={crumbs}>
      <div className="fade-in flex flex-wrap items-center justify-between gap-x-4 gap-y-3">
        <h1 className="flex items-center gap-2 text-2xl font-extrabold tracking-[-0.02em]">
          Simulation Studio <Icon name="sparkles" className="h-5 w-5 text-brand-violet" />
        </h1>
        <div className="flex items-center gap-2">
          <ExportReportButton
            module="simulation-studio"
            scope={() => filters as Record<string, unknown>}
            options={() => ({ ...(levers ?? {}) })}
            currency={currency}
            disabled={!levers || !result.data}
            disabledReason="Set the three levers before exporting."
          />
          <Button variant="secondary" onClick={reset} disabled={!scope.data || atDefaults}>
            <Icon name="refresh" /> <span>Reset</span>
          </Button>
          {carriedProduct && (
            <span className="inline-flex items-center gap-1">
              <Button variant="secondary" onClick={runOptimize} disabled={!!optimizeBlocker} title={optimizeBlocker ?? undefined}>
                {optimize.isPending ? <Spinner /> : <Icon name="target" />} <span>Optimize</span>
              </Button>
              <InfoPopover label="How Optimize works" title="How Optimize works" width={320}>
                <div className="mt-1.5 space-y-1.5 text-xs leading-snug text-ink-secondary">
                  <p>
                    Tick a lever to let Optimize vary it from its minimum up to where its slider sits — the slider is
                    the ceiling, so move it to widen or narrow the range. Unticked levers are held where they are.
                  </p>
                  <p>
                    It then prices every position in those ranges with the same engine the sliders use — every step
                    of discount, every whole day, and for the budget the smaller of the ceiling and what full coverage
                    costs — and returns the combination with the highest ROI.
                  </p>
                  <p>
                    Where ROIs tie it prefers the higher revenue, then the lower spend: the budget only scales a
                    promotion, so without that rule it would have no best value. Only for the product carried in from
                    Promotion Intelligence.
                  </p>
                </div>
              </InfoPopover>
            </span>
          )}
          <Button variant="primary" onClick={addToDecisionCenter} disabled={!!addBlocker} title={addBlocker ?? undefined}>
            <Icon name="plus" /> <span>Add to Decision Center</span>
          </Button>
          {held.length > 0 && (
            <Button variant="ghost" className="!text-brand-violet" onClick={() => navigate('/decision')}>
              {held.length}/{MAX_SCENARIOS} in Decision Center →
            </Button>
          )}
        </div>
      </div>

      <div className="mt-4">
        <FilterBar
          store={useStudioFilters}
          layout="studio"
          groupLabel="Simulation Studio filters"
          options={filterOptions.data}
        />
      </div>

      {carriedProduct && (
        <div className="mt-3 flex flex-wrap items-center justify-between gap-3 rounded-[var(--r-lg)] border border-brand-violet-100 bg-brand-violet-50 px-4 py-2.5">
          {/* THE CARRIED PRODUCT, AND EVERYTHING ABOUT IT, ON ONE LINE. The
              scope facts follow it here instead of on a line of their own, so
              everything about the product is stated once, in one place. */}
          <div className="flex min-w-0 flex-1 flex-wrap items-center gap-x-2 gap-y-1 text-base">
            <span className="font-bold text-ink-primary">{carriedName}</span>
            {[offerName, ...bannerFacts].filter(Boolean).map((f) => (
              <span key={f} className="flex items-center gap-x-2 font-bold text-ink-primary">
                <span className="font-normal text-ink-muted">·</span>
                {f}
              </span>
            ))}
          </div>
          <Button variant="secondary" size="sm" onClick={releaseProduct}>
            <Icon name="x" /> Show all products
          </Button>
        </div>
      )}

      {scope.isPending && (
        <div className="mt-6 flex items-center gap-3 text-base text-ink-muted">
          <Spinner /> Measuring the scope…
        </div>
      )}

      {scope.isError && (
        <Card className="mt-4">
          <CardBody>
            <div className="text-md font-bold text-ink-primary">
              {scopeError?.status === 422 ? 'Nothing to simulate for this scope' : 'The studio could not measure this scope'}
            </div>
            <div className="mt-1 text-base text-ink-muted">{scope.error.message}</div>
            {scopeError?.status !== 422 && (
              <Button variant="secondary" className="mt-3" onClick={() => scope.refetch()}>
                <Icon name="refresh" /> Retry
              </Button>
            )}
          </CardBody>
        </Card>
      )}

      {scope.data && levers && spendLever && (
        <>
          {/* THE SCOPE IN WORDS, when no product is carried (a carried
              product's banner says it instead): the period and count, the
              measured anchor — the same engine over the same rows the Insights
              Hub and Promotion Intelligence report, so the studio's figures can
              be checked against theirs — and the plan the three levers open on. */}
          {!carriedProduct && (
            <div className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-1 text-base text-ink-muted">
              <span>
                <strong className="font-semibold text-ink-secondary">{scope.data.scope.period}</strong>
                {offerName && <> · {offerName}</>}
                {' · '}
                {scope.data.scope.product_channels} product-channel{scope.data.scope.product_channels === 1 ? '' : 's'}
              </span>
              {scope.data.measured.roi.value != null && (
                <span>
                  Measured{offerName ? ` (${offerName})` : ''}: trade spend{' '}
                  <strong className="font-semibold text-ink-secondary">{scope.data.measured.trade_spend.display}</strong> · incremental sales{' '}
                  <strong className="font-semibold text-ink-secondary">{scope.data.measured.incremental_sales.display}</strong> · ROI{' '}
                  <strong className="font-semibold text-ink-secondary">{scope.data.measured.roi.display}</strong>
                </span>
              )}
              <span>
                Current plan{' '}
                <strong className="font-semibold text-ink-secondary">{scope.data.observed_plan.discount_pct.toFixed(2)}%</strong> for{' '}
                <strong className="font-semibold text-ink-secondary">{scope.data.observed_plan.days} days</strong>
                {scope.data.levers.trade_spend.default > 0 && (
                  <>
                    , costing{' '}
                    <strong className="font-semibold text-ink-secondary">{scope.data.levers.trade_spend.default_display}</strong>
                  </>
                )}
              </span>
            </div>
          )}

          <div className="mt-4 grid grid-cols-3 gap-4 @max-[1000px]:grid-cols-1">
            <LeverSlider
              label="Discount"
              lever={scope.data.levers.discount_pct}
              value={levers.discount_pct}
              format={(v) => `${v.toFixed(2)}%`}
              onChange={(v) => moveLever('discount_pct', v)}
              marks={['0%', `${scope.data.levers.discount_pct.max.toFixed(2)}%`]}
              vary={varyProps('discount_pct')}
            />

            <LeverSlider
              label="Trade spend"
              lever={spendLever}
              value={levers.trade_spend}
              format={money}
              onChange={(v) => moveLever('trade_spend', v)}
              marks={[`${symbol}0`, spendLever.max_display ?? money(spendLever.max)]}
              vary={varyProps('trade_spend')}
            />

            <LeverSlider
              label="Days"
              lever={scope.data.levers.days}
              value={levers.days}
              format={(v) => `${v} day${v === 1 ? '' : 's'}`}
              onChange={(v) => moveLever('days', v)}
              marks={['1 day', `${scope.data.levers.days.max} days`]}
              vary={varyProps('days')}
            />
          </div>

          {optimized && carriedProduct && (
            <OptimizeResult
              response={optimized.response}
              stale={optimizeStale}
              symbol={symbol}
              atBest={
                !!levers &&
                levers.discount_pct === optimized.response.best.levers.discount_pct &&
                levers.trade_spend === optimized.response.best.levers.trade_spend &&
                levers.days === optimized.response.best.levers.days
              }
              onApply={applyOptimized}
              onDismiss={() => setOptimized(null)}
            />
          )}

          {result.isError && (
            <Card className="mt-4">
              <CardBody>
                <div className="text-md font-bold text-ink-primary">This scenario could not be run</div>
                <div className="mt-1 text-base text-ink-muted">{result.error.message}</div>
              </CardBody>
            </Card>
          )}

          {/* THE EXPLORATION DECK -- the two result tiles, the week chart and
              the depth curve. It is what the sliders are for: move one, watch
              these. It stands down in exactly one case: an Optimize answer is
              on screen FOR A PRODUCT CARRIED IN FROM PROMOTION INTELLIGENCE.
              There the reader arrived with a question, not an exploration,
              and the answer card already carries the figures on both sides of
              it -- leaving four more panels underneath, all still showing the
              position Optimize has just superseded, asks them to work out for
              themselves which numbers are the answer. Dismissing the card
              brings the deck straight back. Every other case keeps it: no
              Optimize run yet, a scope with no product carried in (where
              Optimize does not appear at all), or the card dismissed. */}
          {result.data && !optimizeAnswered && (
            <>
              <div className="mt-4">
                <ResultStrip
                  result={result.data}
                  stale={result.isFetching}
                  measuredRoi={scope.data.measured.roi.value != null ? scope.data.measured.roi.display : null}
                />
              </div>

              <Card className="mt-4">
                <CardHeader title="Revenue by week" subtitle={takeaway(result.data)} actions={<SeriesLegend />} />
                <CardBody className={result.isFetching ? 'opacity-70 transition-opacity' : 'transition-opacity'}>
                  <WindowChart weeks={result.data.weekly} format={money} />
                  <SecondaryFigures result={result.data} />
                </CardBody>
              </Card>

              <Card className="mt-4">
                <CardHeader
                  title="Every discount depth"
                  subtitle={`Budget ${result.data.levers.trade_spend.requested.display} · ${result.data.window.days} days`}
                />
                <CardBody className={curve.isFetching ? 'opacity-70 transition-opacity' : 'transition-opacity'}>
                  {curve.data ? (
                    <CurveChart
                      curve={curve.data}
                      current={{
                        discount_pct: result.data.current_plan.discount_pct,
                        revenue: result.data.current_plan.revenue.value,
                        roi: result.data.current_plan.roi.value,
                        revenueDisplay: result.data.current_plan.revenue.display,
                        roiDisplay: result.data.current_plan.roi.display,
                      }}
                      scenario={{
                        discount_pct: result.data.scenario.discount_pct,
                        revenue: result.data.scenario.revenue.value,
                        roi: result.data.scenario.roi.value,
                        revenueDisplay: result.data.scenario.revenue.display,
                        roiDisplay: result.data.scenario.roi.display,
                      }}
                      format={money}
                    />
                  ) : curve.isError ? (
                    <div className="text-base text-ink-muted">{curve.error.message}</div>
                  ) : (
                    <div className="flex items-center gap-3 text-base text-ink-muted">
                      <Spinner /> Working out every depth…
                    </div>
                  )}
                </CardBody>
              </Card>
            </>
          )}
        </>
      )}
    </AppShell>
  )
}

// --- pieces ----------------------------------------------------------------

/** What Optimize found, beside what is on the sliders.
 *
 *  Every figure is the payload's. The card says which ranges were searched,
 *  which levers moved and which were held, and the ROI, revenue and spend at
 *  both points with the engine's own delta; "Apply" moves the sliders to the
 *  best levers, and until then the sliders are untouched. `stale` means the
 *  sliders have moved since this ran, so the "now" column is history. */
function OptimizeResult({
  response: r,
  stale,
  symbol,
  atBest,
  onApply,
  onDismiss,
}: {
  response: OptimizeResponse
  stale: boolean
  symbol: string
  /** The sliders are already on the best levers, so Apply has nothing to do.
   *  NOT the same as `already_optimal`: when the current plan is the best
   *  answer, Apply still has work — moving the sliders back to it. */
  atBest: boolean
  onApply: () => void
  onDismiss: () => void
}) {
  const roiTone = { profitable: 'success', break_even: 'warning', loss_making: 'danger', not_applicable: 'neutral' } as const
  const searched = (key: OptimizableLever): string => {
    const s = r.searched[key]
    if (!s) return 'held'
    if (key === 'discount_pct') return `0% – ${s.max.toFixed(2)}%`
    if (key === 'days') return `1 – ${s.max} days`
    return `${symbol}0 – ${(s as { max_display: string }).max_display}`
  }
  const leverValue = (l: OptimizeResponse['from']['levers'], key: OptimizableLever): string =>
    key === 'discount_pct' ? `${l.discount_pct.toFixed(2)}%` : key === 'days' ? `${l.days} day${l.days === 1 ? '' : 's'}` : l.trade_spend_display
  const money = (d: OptimizeResponse['gain']['revenue']) =>
    d.percent == null ? d.absolute.display : `${d.absolute.display} (${d.percent_display})`
  // Every row carries its own change now. Trade spend and incremental sales
  // used to print a dash — not because they were flat, but because the
  // payload had no delta for them.
  const figures: [string, string, string, string, Direction][] = [
    ['ROI', r.from.figures.roi.display, r.best.figures.roi.display, r.gain.roi.absolute_display, r.gain.roi.direction],
    ['Revenue', r.from.figures.revenue.display, r.best.figures.revenue.display, money(r.gain.revenue), r.gain.revenue.direction],
    ['Trade spend', r.from.figures.trade_spend.display, r.best.figures.trade_spend.display, money(r.gain.trade_spend), r.gain.trade_spend.direction],
    ['Incremental sales', r.from.figures.incremental_sales.display, r.best.figures.incremental_sales.display, money(r.gain.incremental_sales), r.gain.incremental_sales.direction],
  ]
  const deltaTone = (d: Direction) => (d === 'up' ? 'text-status-success' : d === 'down' ? 'text-status-danger' : 'text-ink-muted')
  return (
    <Card className="mt-4 border-brand-violet-100">
      <CardHeader
        title={r.already_optimal ? 'Nothing in the searched ranges beats the current plan' : 'Best levers in the searched ranges'}
        subtitle={`${r.searched.evaluations.toLocaleString()} positions priced · highest ROI, then revenue, then lower spend`}
        actions={<RoiStatusPill tone={roiTone[r.best.roi_status]} />}
      />
      <CardBody>
        {stale && (
          <div className="mb-3 rounded-[var(--r-md)] bg-status-warning/10 px-3 py-2 text-sm text-ink-secondary">
            The sliders have moved since this ran — the "now" column is where they were. Run Optimize again for the current position.
          </div>
        )}
        <div className="grid grid-cols-2 gap-6 @max-[900px]:grid-cols-1">
          <table className="w-full text-base [font-variant-numeric:tabular-nums]">
            <thead>
              <tr className="text-sm font-semibold text-ink-muted">
                <th className="pb-2 text-left font-semibold">Lever</th>
                <th className="pb-2 text-left font-semibold">Searched</th>
                <th className="pb-2 text-right font-semibold">Current plan</th>
                <th className="pb-2 text-right font-semibold">Best</th>
              </tr>
            </thead>
            <tbody>
              {(['discount_pct', 'trade_spend', 'days'] as OptimizableLever[]).map((key) => (
                <tr key={key} className="border-t border-border-subtle">
                  <td className="py-1.5 font-semibold text-ink-primary">{OPTIMIZE_LEVER_LABEL[key]}</td>
                  <td className="py-1.5 text-ink-muted">{searched(key)}</td>
                  <td className="py-1.5 text-right font-semibold text-ink-primary">{leverValue(r.from.levers, key)}</td>
                  {/* Violet marks what OPTIMIZE found. A held lever can also
                      differ from the plan — the reader pinned it there — and
                      dressing that as a finding would take credit for their
                      own choice. */}
                  <td className={`py-1.5 text-right ${r.searched[key] && r.best.changed[key] ? 'font-bold text-brand-violet' : 'font-bold text-ink-primary'}`}>
                    {leverValue(r.best.levers, key)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          <table className="w-full text-base [font-variant-numeric:tabular-nums]">
            <thead>
              <tr className="text-sm font-semibold text-ink-muted">
                {/* Each column says which window it is over. They are not the
                    same window whenever Optimize moved Days, and one shared
                    "Over N days" heading quietly mislabelled the Now column. */}
                <th className="pb-2 text-left font-semibold">Figure</th>
                <th className="pb-2 text-right font-semibold">Current plan · {r.from.levers.days}d</th>
                <th className="pb-2 text-right font-semibold">Best · {r.best.levers.days}d</th>
                <th className="pb-2 text-right font-semibold">Change</th>
              </tr>
            </thead>
            <tbody>
              {figures.map(([label, now, best, delta, direction]) => (
                <tr key={label} className="border-t border-border-subtle">
                  <td className="py-1.5 font-semibold text-ink-primary">{label}</td>
                  <td className="py-1.5 text-right font-semibold text-ink-primary">{now}</td>
                  <td className="py-1.5 text-right font-bold text-ink-primary">{best}</td>
                  <td className={`py-1.5 text-right font-semibold ${deltaTone(direction)}`}>{delta}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <div className="mt-4 flex flex-wrap items-center gap-x-2 gap-y-1">
          <Button variant="primary" onClick={onApply} disabled={atBest}>
            <Icon name="target" /> <span>Apply to sliders</span>
          </Button>
          <Button variant="ghost" onClick={onDismiss}>
            Dismiss
          </Button>
          {/* The deck below is hidden while this card is up, so say so --
              otherwise the charts look like they broke. */}
          <span className="ml-1 text-sm text-ink-muted">Dismiss to go back to the charts</span>
        </div>
      </CardBody>
    </Card>
  )
}

/** The scope in words, from the option lists' own names. */
function scopeLabel(
  scope: ScopeResponse,
  filters: { channel: string[]; category: string[]; brand: string[]; product: string[]; retailer: string[]; region: string[]; state: string[]; city: string[]; tier: string[]; distributor: string[] },
  options: FiltersResponse | undefined,
): string {
  const name = (list: { code: string; name: string }[] | undefined, code: string) => list?.find((o) => o.code === code)?.name ?? code
  const parts = [scope.scope.period]
  filters.channel.forEach((c) => parts.push(name(options?.channels, c)))
  filters.category.forEach((c) => parts.push(c))
  filters.brand.forEach((b) => parts.push(b))
  filters.product.forEach((p) => parts.push(name(options?.products, p)))
  ;[...filters.retailer, ...filters.region, ...filters.state, ...filters.city, ...filters.tier, ...filters.distributor].forEach((v) => parts.push(v))
  return parts.join(' · ')
}

/** The KPI rows a Decision Center column shows — the studio's own display
 *  strings, in the order the studio itself presents them. */
function kpisOf(r: SimulateResponse): ScenarioKpi[] {
  const s = r.scenario
  const c = r.current_plan
  const roiTone = { profitable: 'success', break_even: 'warning', loss_making: 'danger', not_applicable: 'neutral' } as const
  const spend = r.levers.trade_spend
  return [
    { key: 'discount', label: 'Discount', value: `${r.levers.discount_pct.toFixed(2)}%`, sub: `current plan ${c.discount_pct.toFixed(2)}%` },
    { key: 'days', label: 'Days', value: `${r.window.days} days`, sub: `${r.window.weeks} business week${r.window.weeks === 1 ? '' : 's'}` },
    { key: 'budget', label: 'Trade spend budget', value: spend.requested.display, sub: spend.binding ? `covers ${spend.coverage_display} of the scope` : 'covers the whole scope' },
    { key: 'revenue', label: 'Revenue', value: s.revenue.display, sub: `${r.deltas.revenue.absolute.display} (${r.deltas.revenue.percent_display}) vs current plan`, raw: s.revenue.value },
    { key: 'roi', label: 'ROI', value: s.roi.display, sub: `${r.deltas.roi.absolute_display} vs current plan`, tone: roiTone[r.deltas.roi.status], raw: s.roi.value },
    { key: 'trade_spend', label: 'Trade spend', value: s.trade_spend.display, sub: `current plan ${c.trade_spend.display}`, raw: s.trade_spend.value },
    { key: 'incremental_sales', label: 'Incremental sales', value: s.incremental_sales.display, sub: `current plan ${c.incremental_sales.display}`, raw: s.incremental_sales.value },
    { key: 'incremental_units', label: 'Incremental units', value: s.incremental_units.display, sub: `current plan ${c.incremental_units.display}`, raw: s.incremental_units.value },
    { key: 'margin', label: 'Margin', value: s.margin_pct.display, sub: `current plan ${c.margin_pct.display}`, raw: s.margin_pct.value },
    { key: 'lift', label: 'Volume lift', value: r.lift.mid_display, sub: r.lift.display, raw: r.lift.mid },
    { key: 'vs_baseline', label: 'Revenue vs no promotion', value: r.vs_baseline.revenue.display, raw: r.vs_baseline.revenue.value },
  ]
}

function defaultsOf(scope: ScopeResponse): Levers {
  return {
    discount_pct: scope.levers.discount_pct.default,
    trade_spend: scope.levers.trade_spend.default,
    days: scope.levers.days.default,
  }
}

/** One sentence a reader takes away from the week chart, in the payload's own
 *  words: which way revenue moved against the current plan and by how much. */
function takeaway(r: SimulateResponse): string {
  const d = r.deltas.revenue
  if (d.direction === 'unchanged') return `Same as the current plan over ${r.window.days} days`
  const verb = d.direction === 'up' ? 'earns' : 'gives up'
  return `Scenario ${verb} ${d.absolute.display.replace(/^[-−]/, '')} (${d.percent_display.replace(/^[-−+]/, '')}) against the current plan over ${r.window.days} days`
}

/** Abbreviated money for a slider readout or an axis tick, in the display
 *  currency. A synthetic value; every figure that describes a result is the
 *  backend's own string. */
function formatMoney(v: number, rate: number, symbol: string): string {
  const a = v * rate
  if (symbol === '₹') {
    if (Math.abs(a) >= 1e7) return `${symbol}${(a / 1e7).toFixed(2)} Cr`
    if (Math.abs(a) >= 1e5) return `${symbol}${(a / 1e5).toFixed(2)} L`
    return `${symbol}${a.toFixed(2)}`
  }
  if (Math.abs(a) >= 1e6) return `${symbol}${(a / 1e6).toFixed(2)} M`
  if (Math.abs(a) >= 1e3) return `${symbol}${(a / 1e3).toFixed(2)} K`
  return `${symbol}${a.toFixed(2)}`
}

/** The four figures the week chart does not draw.
 *
 *  "₹81.35 L vs ₹81.35 L" is a sentence that makes a reader look twice for
 *  the difference. When the scenario IS the current plan — which it is every
 *  time the page opens — each cell says so once, in words, and the two
 *  figures that carry an engine delta show it instead of restating the
 *  number they were compared against. */
function SecondaryFigures({ result }: { result: SimulateResponse }) {
  const s = result.scenario
  const c = result.current_plan
  const d = result.deltas
  const withPct = (m: MoneyDelta) => (m.percent == null ? m.absolute.display : `${m.absolute.display} (${m.percent_display})`)
  const tone = (dir: Direction) => (dir === 'up' ? 'text-status-success' : dir === 'down' ? 'text-status-danger' : 'text-ink-muted')
  // Every cell carries the engine's own change; none falls back to restating
  // the figure it was compared against.
  const cells: { label: string; value: string; current: string; change: string; direction: Direction }[] = [
    { label: 'Trade spend', value: s.trade_spend.display, current: c.trade_spend.display, change: withPct(d.trade_spend), direction: d.trade_spend.direction },
    { label: 'Incremental sales', value: s.incremental_sales.display, current: c.incremental_sales.display, change: withPct(d.incremental_sales), direction: d.incremental_sales.direction },
    {
      label: 'Incremental units',
      value: s.incremental_units.display,
      current: c.incremental_units.display,
      change: d.incremental_units.percent == null
        ? d.incremental_units.absolute_display
        : `${d.incremental_units.absolute_display} (${d.incremental_units.percent_display})`,
      direction: d.incremental_units.direction,
    },
    { label: 'Margin', value: s.margin_pct.display, current: c.margin_pct.display, change: d.margin_pct.absolute_display, direction: d.margin_pct.direction },
  ]
  return (
    <div className="mt-5 grid grid-cols-4 gap-4 border-t border-border-subtle pt-4 @max-[900px]:grid-cols-2">
      {cells.map(({ label, value, current, change, direction }) => (
        <div key={label}>
          <div className="text-base font-bold text-ink-primary">{label}</div>
          <div className="mt-1 text-lg font-bold text-ink-primary [font-variant-numeric:tabular-nums]">{value}</div>
          <div className={`mt-0.5 text-sm font-semibold [font-variant-numeric:tabular-nums] ${value === current ? 'text-ink-secondary' : tone(direction)}`}>
            {value === current ? 'Same as current plan' : change}
          </div>
        </div>
      ))}
    </div>
  )
}
