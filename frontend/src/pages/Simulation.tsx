import { useEffect, useMemo, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { AppShell } from '../components/layout/AppShell'
import { Button, Card, CardBody, CardHeader, Spinner, useToast } from '../components/ui'
import { Icon } from '../icons'
import { FilterBar } from '../components/command/FilterBar'
import { ExportReportButton } from '../components/reports/ExportReportButton'
import { LeverSlider } from '../components/studio/LeverSlider'
import { ResultStrip } from '../components/studio/ResultStrip'
import { SeriesLegend, WindowChart } from '../components/studio/WindowChart'
import { CurveChart } from '../components/studio/CurveChart'
import { useFilterOptionsFor } from '../hooks/useCommandCenter'
import { useDebounced, useStudioCurve, useStudioScope, useStudioSimulate, type Levers } from '../hooks/useStudio'
import { ApiError } from '../lib/api'
import { toApiFilters } from '../lib/scope'
import { useStudioFilters } from '../store/studioFilters'
import { useStudioHandoff } from '../store/studioHandoff'
import { MAX_SCENARIOS, scenarioSignature, useDecisionScenarios, type ScenarioKpi } from '../store/decisionScenarios'
import type { FiltersResponse } from '../types/commandCenter'
import type { ScopeResponse, SimulateResponse } from '../types/studio'

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
 *  SCOPE. The studio's own filter state (store/studioFilters.ts), edited by
 *  the filter bar here. Promotion Intelligence's "Go to Simulation" pre-selects
 *  its product in that store (store/studioHandoff.ts); the option lists then
 *  cascade to that product's data, and clearing the product — from the banner
 *  or the Product dropdown — brings everything back.
 */
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

  const settled = useDebounced(levers)
  const live = seededFor === scopeKey ? settled : null
  const result = useStudioSimulate(filters, currency, live)
  const curve = useStudioCurve(filters, currency, live)

  const rate = scope.data?.exchange_rate ?? 1
  const symbol = currency === 'USD' ? '$' : '₹'
  const money = (v: number) => formatMoney(v, rate, symbol)

  const reset = () => scope.data && setLevers(defaultsOf(scope.data))
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

  const crumbs = [{ label: 'TPO Intelligence' }, { label: 'Simulation Studio' }]
  const scopeError = scope.error instanceof ApiError ? scope.error : null

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
          onRefresh={() => scope.refetch()}
          refreshing={scope.isFetching}
        />
      </div>

      {carriedProduct && (
        <div className="mt-3 flex flex-wrap items-center justify-between gap-3 rounded-[var(--r-lg)] border border-brand-violet-100 bg-brand-violet-50 px-4 py-2.5">
          <div className="flex min-w-0 flex-wrap items-center gap-x-2 text-base">
            <span className="font-semibold text-brand-violet">From Promotion Intelligence</span>
            <span className="text-ink-muted">·</span>
            <span className="font-bold text-ink-primary">{carriedName}</span>
            {offerName && (
              <>
                <span className="text-ink-muted">·</span>
                <span className="font-semibold text-ink-secondary">{offerName}</span>
              </>
            )}
            {carriedProduct.year && (
              <>
                <span className="text-ink-muted">·</span>
                <span className="text-ink-secondary">F{String(carriedProduct.year).slice(2)}</span>
              </>
            )}
          </div>
          <div className="flex items-center gap-2">
            <Button variant="ghost" size="sm" className="!text-brand-violet" onClick={() => navigate('/intelligence')}>
              ← Back to Promotion Intelligence
            </Button>
            <Button variant="secondary" size="sm" onClick={releaseProduct}>
              <Icon name="x" /> Show all products
            </Button>
          </div>
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

      {scope.data && levers && (
        <>
          <div className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-1 text-base text-ink-muted">
            <span>
              <strong className="font-semibold text-ink-secondary">{scope.data.scope.period}</strong>
              {offerName && !carriedProduct && <> · {offerName}</>}
              {' · '}
              {scope.data.scope.product_channels} product-channel{scope.data.scope.product_channels === 1 ? '' : 's'}
            </span>
            {/* THE MEASURED ANCHOR — the same engine over the same rows the
                Insights Hub and Promotion Intelligence report, so the studio's
                figures can be checked against theirs. */}
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
            </span>
          </div>

          <div className="mt-4 grid grid-cols-3 gap-4 @max-[1000px]:grid-cols-1">
            <LeverSlider
              label="Discount"
              lever={scope.data.levers.discount_pct}
              value={levers.discount_pct}
              format={(v) => `${v.toFixed(2)}%`}
              onChange={(v) => setLevers({ ...levers, discount_pct: v })}
              marks={['0%', `${scope.data.levers.discount_pct.max.toFixed(2)}%`]}
            >
              {result.data && levers.discount_pct > 0 && (
                <>
                  Volume lift <strong className="font-semibold text-ink-primary">{(result.data.lift.mid * 100).toFixed(2)}%</strong>
                </>
              )}
              {levers.discount_pct === 0 && <>No promotion</>}
            </LeverSlider>

            <LeverSlider
              label="Trade spend"
              lever={scope.data.levers.trade_spend}
              value={levers.trade_spend}
              format={money}
              onChange={(v) => setLevers({ ...levers, trade_spend: v })}
              marks={[money(0), scope.data.levers.trade_spend.max_display ?? money(scope.data.levers.trade_spend.max)]}
            >
              {result.data && <BudgetNote spend={result.data.levers.trade_spend} discount={levers.discount_pct} />}
            </LeverSlider>

            <LeverSlider
              label="Days"
              lever={scope.data.levers.days}
              value={levers.days}
              format={(v) => `${v} day${v === 1 ? '' : 's'}`}
              onChange={(v) => setLevers({ ...levers, days: v })}
              marks={['1 day', `${scope.data.levers.days.max} days`]}
            >
              {result.data && (
                <>
                  {result.data.window.weeks} business week{result.data.window.weeks === 1 ? '' : 's'}
                  {result.data.window.partial_week_fraction != null && <>, last one partial</>}
                </>
              )}
            </LeverSlider>
          </div>

          {result.isError && (
            <Card className="mt-4">
              <CardBody>
                <div className="text-md font-bold text-ink-primary">This scenario could not be run</div>
                <div className="mt-1 text-base text-ink-muted">{result.error.message}</div>
              </CardBody>
            </Card>
          )}

          {result.data && (
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
    { key: 'lift', label: 'Volume lift', value: `${(r.lift.mid * 100).toFixed(2)}%`, raw: r.lift.mid },
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

function BudgetNote({
  spend,
  discount,
}: {
  spend: { coverage_display: string; binding: boolean; unspent: { display: string }; full_coverage_cost: { display: string } }
  discount: number
}) {
  if (discount === 0) return <>Nothing to fund</>
  if (spend.binding) {
    return (
      <>
        Covers <strong className="font-semibold text-ink-primary">{spend.coverage_display}</strong> of the scope
      </>
    )
  }
  return (
    <>
      Covers the whole scope · <strong className="font-semibold text-ink-primary">{spend.unspent.display}</strong> unspent
    </>
  )
}

function SecondaryFigures({ result }: { result: SimulateResponse }) {
  const s = result.scenario
  const c = result.current_plan
  const cells: [string, string, string][] = [
    ['Trade spend', s.trade_spend.display, c.trade_spend.display],
    ['Incremental sales', s.incremental_sales.display, c.incremental_sales.display],
    ['Incremental units', s.incremental_units.display, c.incremental_units.display],
    ['Margin', s.margin_pct.display, c.margin_pct.display],
  ]
  return (
    <div className="mt-5 grid grid-cols-4 gap-4 border-t border-border-subtle pt-4 @max-[900px]:grid-cols-2">
      {cells.map(([label, scenario, current]) => (
        <div key={label}>
          <div className="text-sm font-semibold text-ink-muted">{label}</div>
          <div className="mt-0.5 text-md font-bold text-ink-primary [font-variant-numeric:tabular-nums]">
            {scenario} <span className="text-sm font-medium text-ink-muted">vs {current}</span>
          </div>
        </div>
      ))}
    </div>
  )
}
