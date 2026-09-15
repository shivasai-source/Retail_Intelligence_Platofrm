import { useEffect, useMemo, useRef } from 'react'
import { Button, Card, CardBody, CardHeader, Dropdown, Spinner, Table, Td, Th, Tr, useToast } from '../ui'
import { InfoBlock, InfoPopover } from '../ui/InfoPopover'
import { Icon } from '../../icons'
import { Slider } from './Slider'
import { useGeneralOptimization, useOptimizationScope } from '../../hooks/useOptimization'
import { useGeneralOptimizationStore } from '../../store/generalOptimization'
import { useDecisionCandidateStore } from '../../store/decisionCandidates'
import { candidateFromOptimization } from '../../lib/decisionCandidates'
import type { FiltersResponse } from '../../types/commandCenter'
import type { OptimizationResponse, OptimizationRow } from '../../types/optimization'

/** GENERAL OPTIMIZATION — the second Simulation Studio mode.
 *
 *  A different question from the Investigation Simulation's, answered by a
 *  different service: "given a category, a channel and a month, which products
 *  should carry a promotion, at which approved depth, so revenue is as high as
 *  it can be without the trade spend passing a stated ceiling?"
 *
 *  THIS COMPONENT COMPUTES NOTHING. It collects four constraints, posts them,
 *  and renders what comes back. The objective, the approved treatment set, the
 *  uplift bands and the budget constraint all live in app/tpo/optimization.py
 *  beside the economics that define them — a copy here would be a second set of
 *  business rules free to drift from the first.
 *
 *  EVERY OPTIMIZED FIGURE IS A BAND. An approved treatment gives an uplift
 *  RANGE, and the backend refuses to collapse one to a midpoint, so this screen
 *  shows both ends rather than inventing a single number to sit between them.
 *
 *  A PLAN THAT COULD NOT BE PRODUCED HAS NO NUMBERS. Three of the four statuses
 *  carry null summaries, and this renders the reason instead of a grid of
 *  zeros that would read as a measured outcome.
 */

const MONTH_NAMES = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
]

/** The year the controls open on: the most recent COMPLETED year the data
 *  holds, the same rule the Insights Hub applies — a year still in progress
 *  is a partial month-set and would make "October" mean nothing. */
function defaultYear(years: number[]): number | null {
  if (!years.length) return null
  const completed = years.filter((y) => y < new Date().getFullYear())
  return Math.max(...(completed.length ? completed : years))
}

/** Approved depths are 5/10/15/20/25, so the handle steps in fives and can
 *  never land between two of them. Nothing here writes down the approved list
 *  itself — the API sends it, and the panel shows what it sent. */
const DISCOUNT_STEP = 5

/** [2024, 2025, 2026] -> "2024, 2025 and 2026"; an empty list reads as
 *  "the reference years" until the scope has been measured. */
function joinYears(years: number[]): string {
  if (!years.length) return 'the reference years'
  if (years.length === 1) return String(years[0])
  return `${years.slice(0, -1).join(', ')} and ${years[years.length - 1]}`
}

export function GeneralOptimization({ options }: { options: FiltersResponse | undefined }) {
  const { controls, setControl, seedCeiling } = useGeneralOptimizationStore()
  const scope = useOptimizationScope()
  const optimize = useGeneralOptimization()

  // From the shared filter options, not from the scope response: the scope
  // cannot be measured until a category is chosen, so the list to choose from
  // has to come from somewhere that does not wait for it.
  const categories = options?.categories ?? scope.data?.scope.available_categories ?? []
  const channels = options?.channels ?? []
  const years = options?.years ?? []

  // EVERY CONTROL NAMES ONE VALUE. The scope used to open on "All Categories ·
  // All Channels · All Months", which is not a scope a budget is allocated
  // within, and the historical reference it produced described nothing a
  // planner would recognise. Each control is seeded from the data the first
  // time its options arrive, and the user picks from there.
  useEffect(() => {
    if (controls.year == null && years.length) setControl('year', defaultYear(years))
    if (controls.channel == null && channels.length) setControl('channel', channels[0].code)
    if (controls.category == null && categories.length) setControl('category', categories[0])
    if (controls.month == null) setControl('month', new Date().getMonth() + 1)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [years.length, channels.length, categories.length])

  const complete = controls.year != null && controls.category != null && controls.channel != null && controls.month != null

  const scopeBody = useMemo(
    () => ({
      year: controls.year,
      category: controls.category ? [controls.category] : null,
      channel: controls.channel ? [controls.channel] : null,
      month: controls.month,
    }),
    [controls.year, controls.category, controls.channel, controls.month],
  )

  // Re-measure whenever the scope moves. The ceiling slider cannot be bounded
  // until the historical average for THIS scope is known, so this is not a
  // convenience — the control is unusable without it.
  const measuredFor = useRef<string | null>(null)
  const scopeKey = JSON.stringify(scopeBody)
  const scopeMutate = scope.mutate
  useEffect(() => {
    // Not until every control has a value: measuring the unscoped dataset on
    // the way to the seeded scope would flash a meaningless reference first.
    if (!complete) return
    if (measuredFor.current === scopeKey) return
    measuredFor.current = scopeKey
    optimize.reset()
    scopeMutate(scopeBody, {
      onSuccess: (data) => seedCeiling(data.reference.average_trade_spend),
    })
    // Cleared on teardown for the same StrictMode reason the Simulation page
    // documents: a request fired on the discarded pass resolves to a listener
    // nobody holds, and the surviving pass must be free to issue its own.
    return () => {
      measuredFor.current = null
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scopeKey, complete])

  const reference = scope.data?.reference
  const ceilingMax = reference?.average_trade_spend ?? 0
  const ceiling = controls.maxTradeSpend ?? 0
  const canRun = Boolean(scope.data?.ready) && ceilingMax > 0

  const runOptimization = () => {
    if (!canRun) return
    optimize.mutate({
      ...scopeBody,
      max_trade_spend: ceiling,
      min_discount_pct: controls.minDiscountPct,
      max_discount_pct: controls.maxDiscountPct,
    })
  }

  // The reference window is named from the payload, never written down here:
  // it is every year the data holds, and the data has moved past a literal
  // "2024 and 2025" once already.
  const referenceYears = joinYears(scope.data?.reference.years ?? scope.data?.scope.years ?? [])
  const channelName = channels.find((c) => c.code === controls.channel)?.name

  return (
    <div className="flex flex-col gap-4">
      {/* ---- controls ---------------------------------------------------- */}
      <Card className="fade-in">
        <CardHeader
          title={
            <span className="flex items-center gap-1.5">
              Optimization Scope
              <InfoPopover label="About General Optimization" title="General Optimization">
                <InfoBlock label="Objective">
                  Maximise optimized revenue at the low end of each approved uplift band
                </InfoBlock>
                <InfoBlock label="Constraint">
                  Optimized trade spend at the high end of the band must stay within the ceiling
                </InfoBlock>
                <InfoBlock label="Trade Spend">(Base Revenue − Actual Revenue) + Promotion Cost</InfoBlock>
                <InfoBlock label="Reference">
                  Mean trade spend across {referenceYears} for this scope
                </InfoBlock>
              </InfoPopover>
            </span>
          }
          subtitle={scope.data ? scope.data.scope.period_label : 'Select a scope to measure'}
          actions={
            scope.data ? (
              <span className="text-xs font-semibold text-ink-muted">
                {scope.data.scope.candidate_count} products in scope
              </span>
            ) : null
          }
        />
        <CardBody>
          <div className="grid grid-cols-4 gap-4 @max-[900px]:grid-cols-2">
            <Picker
              label="Year"
              value={controls.year != null ? String(controls.year) : '—'}
              options={years.map(String)}
              onSelect={(v) => setControl('year', Number(v))}
            />
            <Picker
              label="Category"
              value={controls.category ?? '—'}
              options={categories}
              onSelect={(v) => setControl('category', v)}
            />
            <Picker
              label="Channel"
              value={channelName ?? '—'}
              options={channels.map((c) => c.name)}
              onSelect={(v) => setControl('channel', channels.find((c) => c.name === v)?.code ?? controls.channel)}
            />
            <Picker
              label="Month"
              value={controls.month ? MONTH_NAMES[controls.month - 1] : '—'}
              options={MONTH_NAMES}
              onSelect={(v) => setControl('month', MONTH_NAMES.indexOf(v) + 1)}
            />
          </div>

          <div className="mt-5 grid grid-cols-2 gap-x-8 gap-y-5 border-t border-border-subtle pt-5 @max-[900px]:grid-cols-1">
            <Slider
              label="Maximum Trade Spend"
              value={Math.min(ceiling, ceilingMax)}
              min={0}
              max={ceilingMax}
              step={Math.max(1, ceilingMax / 100)}
              minLabel={fmtZero(scope.data?.meta.currency)}
              maxLabel={reference?.display_average ?? '—'}
              valueLabel={ceilingLabel(scope.data, ceiling)}
              disabled={!reference?.available}
              hint={
                reference?.available
                  ? reference.years.length === 1
                    ? `Measured trade spend for this scope in ${reference.years[0]}: ${reference.display_average}`
                    : `Historical average: ${reference.display_average} · mean of ${reference.observed_years} of ${reference.years.length} reference years`
                  : (reference?.unavailable_reason ??
                     'Select a scope to measure its historical trade spend.')
              }
              onChange={(v) => setControl('maxTradeSpend', v)}
            />

            <div className="grid grid-cols-2 gap-x-5 gap-y-4">
              <Slider
                label="Minimum Discount"
                value={controls.minDiscountPct}
                min={0}
                max={25}
                step={DISCOUNT_STEP}
                minLabel="0%"
                maxLabel="25%"
                valueLabel={`${controls.minDiscountPct}%`}
                onChange={(v) => setControl('minDiscountPct', v)}
              />
              <Slider
                label="Maximum Discount"
                value={controls.maxDiscountPct}
                min={0}
                max={25}
                step={DISCOUNT_STEP}
                minLabel="0%"
                maxLabel="25%"
                valueLabel={`${controls.maxDiscountPct}%`}
                onChange={(v) => setControl('maxDiscountPct', v)}
              />
              <div className="col-span-2 -mt-1 text-xs leading-[1.45] text-ink-muted">
                {scope.data?.discount.note ??
                  'Only approved treatment depths can be priced.'}
              </div>
            </div>
          </div>

          <div className="mt-5 flex flex-wrap items-center justify-between gap-3 border-t border-border-subtle pt-4">
            <div className="text-sm text-ink-muted">
              {scope.isPending
                ? 'Measuring the selected scope…'
                : scope.data
                  ? `${scope.data.scope.category_label} · ${scope.data.scope.channel_label} · ${scope.data.scope.period_label}`
                  : ' '}
            </div>
            <Button variant="primary" onClick={runOptimization} disabled={!canRun || optimize.isPending}>
              {optimize.isPending ? (
                <>Optimizing…</>
              ) : (
                <>
                  <Icon name="play" /> Get Data
                </>
              )}
            </Button>
          </div>
        </CardBody>
      </Card>

      {scope.isError && <Problem title="Could not measure the scope" detail={scope.error.message} />}
      {optimize.isError && <Problem title="Optimization failed" detail={optimize.error.message} />}

      {optimize.isPending && (
        <Card className="fade-in">
          <CardBody>
            <div className="flex min-h-[160px] flex-col items-center justify-center gap-3 text-base text-ink-muted">
              <Spinner />
              <span>Optimizing…</span>
            </div>
          </CardBody>
        </Card>
      )}

      {optimize.data && !optimize.isPending && <Result result={optimize.data} />}
    </div>
  )
}

// --- pieces ------------------------------------------------------------------

function Picker({
  label,
  value,
  options,
  onSelect,
}: {
  label: string
  value: string
  options: string[]
  onSelect: (value: string) => void
}) {
  return (
    <div className="min-w-0">
      <div className="text-xs font-semibold uppercase tracking-[0.04em] text-ink-muted">{label}</div>
      <Dropdown
        selected={value}
        options={options.map((o) => ({ label: o }))}
        onSelect={onSelect}
        trigger={
          <Button variant="secondary" block className="mt-1.5 cursor-pointer justify-between">
            <span className="truncate">{value}</span>
            <Icon name="chevronDown" />
          </Button>
        }
      />
    </div>
  )
}

function Problem({ title, detail }: { title: string; detail: string }) {
  return (
    <Card className="fade-in border-[1.5px] border-[rgba(239,68,68,0.35)]">
      <CardBody>
        <div className="flex items-start gap-3">
          <div className="grid h-8 w-8 shrink-0 place-items-center rounded-lg bg-status-danger-bg text-status-danger [&_svg]:h-4 [&_svg]:w-4">
            <Icon name="warning" />
          </div>
          <div className="min-w-0 flex-1">
            <div className="text-base font-bold text-ink-primary">{title}</div>
            <div className="mt-1 break-words text-base text-ink-secondary">{detail}</div>
          </div>
        </div>
      </CardBody>
    </Card>
  )
}

/** The four statuses, and what each of them may show.
 *
 *  Only `optimized` carries numbers. The other three are rendered as a stated
 *  outcome with the backend's own explanation — never as an empty table or a
 *  zeroed summary, both of which read as "we looked and the answer is nothing"
 *  rather than "no plan exists".
 */
/** Put the optimizer's plan on the Decision Center's board.
 *
 *  A COPY OF THIS RESULT, not a re-run. The board carries the units, revenue
 *  and trade-spend bands this response already reports; the optimizer computes
 *  no ROI, no margin and no incremental sales, so the candidate carries none
 *  and the comparison there simply has fewer rows it can rank on. Nothing is
 *  derived to fill the gap.
 *
 *  IT DOES NOT NAVIGATE. The point of the board is more than one scenario, and
 *  leaving this page after adding the first makes the second harder to add. */
function AddToDecisionCenter({ result }: { result: OptimizationResponse }) {
  const addCandidate = useDecisionCandidateStore((s) => s.add)
  const { show } = useToast()
  const candidate = candidateFromOptimization(result)
  if (!candidate) return null
  return (
    <Button
      variant="secondary"
      size="sm"
      onClick={() => {
        addCandidate(candidate)
        show('Optimized Allocation added to Decision Center', { duration: 3000 })
      }}
    >
      <Icon name="plus" /> Add to Decision Center
    </Button>
  )
}

function Result({ result }: { result: OptimizationResponse }) {
  if (result.status !== 'optimized' || !result.optimized || !result.historical || !result.comparison) {
    return (
      <Card className="fade-in">
        <CardBody>
          <div className="flex items-start gap-3">
            <div className="grid h-8 w-8 shrink-0 place-items-center rounded-lg bg-status-warning-bg text-status-warning [&_svg]:h-4 [&_svg]:w-4">
              <Icon name="alertTriangle" />
            </div>
            <div className="min-w-0">
              <div className="text-base font-bold text-ink-primary">{STATUS_TITLE[result.status]}</div>
              <div className="mt-1 text-base leading-[1.5] text-ink-secondary">{result.message}</div>
            </div>
          </div>
        </CardBody>
      </Card>
    )
  }

  const { historical, optimized, comparison, rows } = result
  const multiChannel = result.scope.channels_in_scope > 1

  return (
    <>
      <Card className="fade-in">
        <CardHeader
          title="Optimization Summary"
          subtitle={`${optimized.promoted_candidates} promoted · ${optimized.untouched_candidates} left at base · ${optimized.budget_used_pct ?? 0}% of the ceiling used`}
          actions={
            <div className="flex items-center gap-2">
            <AddToDecisionCenter result={result} />
            <InfoPopover label="How this plan was produced" title="Method" width={320}>
              <InfoBlock label="Objective">{result.provenance.objective}</InfoBlock>
              <InfoBlock label="Constraint">{result.provenance.constraint}</InfoBlock>
              <InfoBlock label="Solver">{result.provenance.solver}</InfoBlock>
              <InfoBlock label="Economics">{result.provenance.economics}</InfoBlock>
              <InfoBlock label="Not modelled">{result.provenance.cannibalization}</InfoBlock>
            </InfoPopover>
            </div>
          }
        />
        <CardBody>
          <div className="grid grid-cols-4 gap-4 @max-[1100px]:grid-cols-2 @max-[620px]:grid-cols-1">
            <Compare
              label="Units"
              before={historical.units_display}
              after={optimized.units.display}
              changePct={comparison.units.change_pct_low}
            />
            <Compare
              label="Revenue"
              before={historical.revenue_display}
              after={optimized.revenue.display}
              changePct={comparison.revenue.change_pct_low}
            />
            <Compare
              label="Trade Spend"
              before={historical.trade_spend_display}
              after={optimized.trade_spend.display}
              changePct={comparison.trade_spend.change_pct_high}
              lowerIsBetter
            />
            <Compare
              label="Average Discount"
              before={historical.average_discount_display}
              after={optimized.average_discount_display}
              changePct={null}
            />
          </div>

          {result.constraints.clamped && (
            <div className="mt-4 rounded-[var(--r-md)] bg-surface-muted p-[10px_12px] text-sm leading-[1.5] text-ink-muted">
              The requested ceiling was above the historical average for this scope and was reduced to{' '}
              <strong className="text-ink-primary">{result.constraints.effective_max_trade_spend_display}</strong>.
            </div>
          )}

          <div className="mt-3 text-xs leading-[1.5] text-ink-muted">{result.provenance.basis}</div>
        </CardBody>
      </Card>

      <Card className="fade-in">
        <CardHeader
          title="Optimized Product Plan"
          subtitle={
            `${rows.length} products · ${result.scope.brand_form_count} brand forms · ` +
            'current is measured from the rows in scope, optimized is what the plan proposes'
          }
        />
        {/* Fixed-height internal scroller so the card keeps its shape whatever
            the product count, and `overflow-x` on the same element so a narrow
            viewport scrolls the table rather than the page. */}
        <div className="max-h-[420px] overflow-auto rounded-b-[var(--r-lg)] [&_td]:!px-2.5 [&_th]:!px-2.5">
          <Table>
            <thead className="sticky top-0 z-10 bg-surface-muted">
              <tr>
                <Th>Brand Form</Th>
                <Th>Product ID</Th>
                {multiChannel && <Th>Channel</Th>}
                <Th className="text-right">Base Units</Th>
                <Th className="text-right">Optimized Units</Th>
                <Th className="text-right">Base Revenue</Th>
                <Th className="text-right">Optimized Revenue</Th>
                {/* CURRENT AND OPTIMIZED ARE SEPARATE COLUMNS, not one
                    ambiguous "Discount". The old single column carried the
                    OPTIMIZER's proposed depth, which reads as the product's own
                    — and left the measured depth, already in the payload,
                    invisible. A recommendation you cannot see the "before" of
                    is not checkable. */}
                <Th className="text-right">Current Discount</Th>
                <Th className="text-right">Optimized Discount</Th>
                <Th className="text-right">Current Trade Spend</Th>
                <Th className="text-right">Optimized Trade Spend</Th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <PlanRow key={`${row.product_id}-${row.channel_id}`} row={row} showChannel={multiChannel} />
              ))}
            </tbody>
          </Table>
        </div>
      </Card>
    </>
  )
}

const STATUS_TITLE: Record<string, string> = {
  no_feasible_solution: 'No feasible allocation',
  insufficient_data: 'Insufficient data',
  constraint_conflict: 'Constraint conflict',
  optimized: 'Optimized',
}

function PlanRow({ row, showChannel }: { row: OptimizationRow; showChannel: boolean }) {
  return (
    <Tr>
      <Td emphasis className="max-w-[170px] truncate" title={row.brand_form}>
        {row.brand_form}
      </Td>
      <Td className="whitespace-nowrap" title={row.product}>
        {row.product_id}
      </Td>
      {showChannel && <Td className="whitespace-nowrap">{row.channel}</Td>}
      <Td className="whitespace-nowrap text-right tabular-nums">{row.base_units_display}</Td>
      <Td className="whitespace-nowrap text-right tabular-nums">{row.optimized_units.display}</Td>
      <Td className="whitespace-nowrap text-right tabular-nums">{row.base_revenue_display}</Td>
      <Td className="whitespace-nowrap text-right tabular-nums">{row.optimized_revenue.display}</Td>
      {/* CURRENT — what this product actually ran at, measured from the rows
          in scope. A product nobody promoted says so rather than showing 0%:
          "not promoted" and "promoted at nothing" are different facts. */}
      <Td className="whitespace-nowrap text-right">
        {row.base_promoted ? (
          <span
            className="inline-flex items-center rounded-[var(--r-pill)] bg-surface-muted px-2 py-0.5 text-xs font-bold tabular-nums text-ink-secondary"
            title={`Measured depth over the rows in scope · ${row.base_promotions.join(', ')}`}
          >
            {row.base_discount_display}
          </span>
        ) : (
          <span className="text-xs text-ink-muted">Not promoted</span>
        )}
      </Td>

      {/* OPTIMIZED — what the optimizer proposes. */}
      <Td className="whitespace-nowrap text-right">
        {row.promoted ? (
          <span
            className="inline-flex items-center rounded-[var(--r-pill)] bg-brand-violet-50 px-2 py-0.5 text-xs font-bold tabular-nums text-brand-violet"
            title={`${row.treatment} · approved uplift ${(row.uplift.low * 100).toFixed(0)}–${(row.uplift.high * 100).toFixed(0)}%`}
          >
            {row.discount_display}
          </span>
        ) : (
          // Not "0%" — the product was not given a treatment at all, and
          // saying so is different from saying it was given a zero one.
          <span className="text-xs text-ink-muted">Not promoted</span>
        )}
      </Td>

      <Td className="whitespace-nowrap text-right tabular-nums text-ink-secondary">
        {row.base_trade_spend_display}
      </Td>
      <Td className="whitespace-nowrap text-right tabular-nums">{row.optimized_trade_spend.display}</Td>
    </Tr>
  )
}

/** One before/after pair. The change is shown only where it is defined — a
 *  percentage change against a zero base is not zero, it is undefined. */
function Compare({
  label,
  before,
  after,
  changePct,
  lowerIsBetter = false,
}: {
  label: string
  before: string
  after: string
  changePct: number | null
  lowerIsBetter?: boolean
}) {
  const good = changePct == null ? null : lowerIsBetter ? changePct <= 0 : changePct >= 0
  return (
    <div className="rounded-[var(--r-lg)] border border-border-subtle bg-surface-muted p-[12px_14px]">
      <div className="text-xs font-semibold uppercase tracking-[0.04em] text-ink-muted">{label}</div>
      <div className="mt-1.5 text-md font-extrabold leading-[1.2] tabular-nums text-ink-primary">{after}</div>
      <div className="mt-1 flex flex-wrap items-baseline gap-x-2 text-xs text-ink-muted">
        <span className="tabular-nums">from {before}</span>
        {changePct != null && (
          <span className={`font-bold tabular-nums ${good ? 'text-status-success' : 'text-status-danger'}`}>
            {changePct > 0 ? '+' : ''}
            {changePct.toFixed(1)}%
          </span>
        )}
      </div>
    </div>
  )
}

// --- formatting helpers ------------------------------------------------------
//
// Presentation of an ALREADY-FORMATTED figure only. The API formats every
// money value with the one formatter the whole platform shares; the two here
// exist because a slider's live handle position has no server-formatted string
// to read, and they format nothing the API also formats.

function fmtZero(currency: string | undefined): string {
  return currency === 'USD' ? '$0' : '₹0'
}

function ceilingLabel(scope: { meta: { currency: string } } | undefined, value: number): string {
  const symbol = scope?.meta.currency === 'USD' ? '$' : '₹'
  if (!value) return `${symbol}0`
  if (value >= 1e7) return `${symbol}${(value / 1e7).toFixed(1)} Cr`
  if (value >= 1e5) return `${symbol}${(value / 1e5).toFixed(1)} L`
  if (value >= 1e3) return `${symbol}${(value / 1e3).toFixed(1)} K`
  return `${symbol}${value.toFixed(0)}`
}
