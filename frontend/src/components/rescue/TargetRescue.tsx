import { useEffect, useMemo, useRef } from 'react'
import { Button, Card, CardBody, CardHeader, Dropdown, Input, Spinner, Table, Td, Th, Tr, useToast } from '../ui'
import { InfoBlock, InfoPopover } from '../ui/InfoPopover'
import { Icon } from '../../icons'
import { Slider } from '../optimization/Slider'
import {
  useReviewRecommendedScenario,
  useTargetRescue,
  useTargetRescueScope,
} from '../../hooks/useTargetRescue'
import { useTargetRescueStore } from '../../store/targetRescue'
import { useDecisionCandidateStore } from '../../store/decisionCandidates'
import { candidateFromRescue } from '../../lib/decisionCandidates'
import type { FiltersResponse } from '../../types/commandCenter'
import type {
  CadenceBlock,
  CheckpointOption,
  CheckpointValue,
  Intervention,
  TargetRescueResponse,
} from '../../types/targetRescue'

/** TARGET RESCUE — the third Simulation Studio mode.
 *
 *  A different question from either of the other two, answered by a different
 *  service: "is this month's unit target on track, and if not, what is the least
 *  aggressive approved intervention that recovers it?"
 *
 *  THIS COMPONENT COMPUTES NOTHING. It collects the controls, posts them, and
 *  renders what comes back. The status thresholds, the approved treatment
 *  ladder, the uplift bands, the discount ceiling and the ranking policy all
 *  live in app/tpo/rescue.py beside the economics that define them — a copy here
 *  would be a second set of business rules free to drift from the first.
 *
 *  PROGRESS IS COUNTED IN COMPLETED BUSINESS WEEKS, and the checkpoint follows
 *  the channel's PROMOTION CADENCE: a weekly-cadence channel (E-commerce, Travel
 *  & Hospitality) is read at its latest completed week, a monthly one (Modern
 *  Trade, General Trade, B2B) at the mid-month week. The cadence is shown beside
 *  the control so the difference is explained rather than merely felt. No day
 *  figure is offered as a sales read — the day count on screen is what the
 *  completed weeks cover in the authoritative calendar, and it is labelled that
 *  way.
 *
 *  TWO PROJECTIONS, KEPT VISUALLY APART. The run-rate projection is division and
 *  is labelled as such. The intervention ladder is a counterfactual over the
 *  month's remaining business weeks under an approved treatment. They sit in
 *  different cards and are never blended into one headline.
 *
 *  EVERY MODELLED FIGURE IS A BAND. An approved treatment gives an uplift RANGE,
 *  and the backend refuses to collapse one to a midpoint, so this screen shows
 *  both ends rather than inventing a number to sit between them.
 *
 *  A RESULT THAT COULD NOT BE PRODUCED HAS NO NUMBERS. The no-data status and
 *  every unestimable rung render their stated reason, never a grid of zeros that
 *  would read as a measured outcome.
 */

const MONTH_NAMES = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
]

const ALL_CHANNELS = 'All Channels'
const ALL_CATEGORIES = 'All Categories'
const ALL_PRODUCTS = 'All Products'
const LATEST_YEAR = 'Latest year'

/** Approved depths are 5/10/15/20/25, so the handle steps in fives and can never
 *  land between two of them. Nothing here writes down the approved list itself —
 *  the API sends it, and the panel shows what it sent. */
const DISCOUNT_STEP = 5

/** Cadence badge tone. The cadence is not a status, so it borrows the neutral
 *  surface rather than a status colour — nothing about WEEKLY is "good". */
const CADENCE_TONE = 'bg-surface-muted text-ink-secondary'

export function TargetRescue({ options }: { options: FiltersResponse | undefined }) {
  const { controls, setControl } = useTargetRescueStore()
  const scope = useTargetRescueScope()
  const evaluate = useTargetRescue()
  const review = useReviewRecommendedScenario()

  const scopeBody = useMemo(
    () => ({
      month: controls.month,
      year: controls.year,
      channel: controls.channel ? [controls.channel] : null,
      category: controls.category ? [controls.category] : null,
      // THE PRODUCT REACHES THE BACKEND. It is a scope constraint, not a display
      // filter -- every figure on the result is measured over the rows it admits.
      product: controls.product ? [controls.product] : null,
    }),
    [controls.month, controls.year, controls.channel, controls.category, controls.product],
  )

  // Re-measure whenever the scope moves. The checkpoint slider cannot be bounded
  // until the number of days this month's business weeks cover is known, so this
  // is not a convenience — the control is unusable without it.
  const measuredFor = useRef<string | null>(null)
  const scopeKey = JSON.stringify(scopeBody)
  const scopeMutate = scope.mutate
  useEffect(() => {
    if (measuredFor.current === scopeKey) return
    measuredFor.current = scopeKey
    evaluate.reset()
    review.reset()
    scopeMutate(scopeBody)
    // Cleared on teardown for the same StrictMode reason the Simulation page
    // documents: a request fired on the discarded pass resolves to a listener
    // nobody holds, and the surviving pass must be free to issue its own.
    return () => {
      measuredFor.current = null
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scopeKey])

  const checkpoint = scope.data?.checkpoint
  const cadence = scope.data?.cadence
  const budget = scope.data?.budget
  const target = controls.targetUnits
  const canRun = Boolean(scope.data?.ready) && target != null && target > 0

  const runEvaluation = () => {
    if (!canRun || target == null) return
    review.reset()
    evaluate.mutate({
      ...scopeBody,
      checkpoint: controls.checkpoint,
      target_units: target,
      current_discount_pct: controls.currentDiscountPct,
      max_additional_trade_spend: controls.maxAdditionalTradeSpend,
    })
  }

  // THE CASCADE'S OWN LISTS, from the scope measurement. `options` is the
  // Insights Hub's unconstrained channel list and is used only as the
  // first-paint fallback, before the first scope response arrives -- after that
  // every list is the one the backend generated for THIS scope.
  const cascade = scope.data?.options
  const channels = cascade?.channels ?? options?.channels ?? []
  const channelName = channels.find((c) => c.code === controls.channel)?.name
  const categories = cascade?.categories ?? []
  const products = cascade?.products ?? []
  const productName = products.find((p) => p.code === controls.product)?.name
  const years = scope.data?.scope.available_years ?? []

  const recommended = evaluate.data?.recommendation?.intervention ?? null
  const reviewScenario = () => {
    if (!recommended || recommended.discount_pct == null || !evaluate.data) return
    review.mutate({
      filters: {
        year: evaluate.data.scope.year,
        month: evaluate.data.scope.month,
        channel: evaluate.data.scope.channel,
        category: evaluate.data.scope.category,
      },
      scenario_id: `target-rescue-l${recommended.level}`,
      discount_pct: recommended.discount_pct,
      currency: evaluate.data.meta.currency,
    })
  }

  return (
    <div className="flex flex-col gap-4">
      {/* ---- controls ---------------------------------------------------- */}
      <Card className="fade-in">
        <CardHeader
          title={
            <span className="flex items-center gap-1.5">
              Target Rescue Scope
              <InfoPopover label="About Target Rescue" title="Target Rescue">
                <InfoBlock label="Question">
                  Is this month's unit target on track, and what is the least aggressive approved
                  intervention that recovers it?
                </InfoBlock>
                <InfoBlock label="Status bands">
                  {scope.data
                    ? `On track at or above ${scope.data.meta.on_track_attainment_pct}% attainment; watch at or above ${scope.data.meta.watch_attainment_pct}%; below that, at risk.`
                    : 'Raw target attainment against the monthly target.'}
                </InfoBlock>
                <InfoBlock label="Scope">
                  {scope.data?.provenance.selection_scope ?? '—'}
                </InfoBlock>
                <InfoBlock label="Option cascade">
                  {scope.data?.provenance.option_cascade ?? '—'}
                </InfoBlock>
                <InfoBlock label="Cadence">
                  {scope.data?.cadence.checkpoint_rule ?? '—'}
                </InfoBlock>
                <InfoBlock label="Progress grain">{scope.data?.provenance.day_grain ?? '—'}</InfoBlock>
                <InfoBlock label="Discount ceiling">
                  {scope.data?.provenance.discount_ceiling ?? '—'}
                </InfoBlock>
                <InfoBlock label="Execution">{scope.data?.provenance.execution ?? '—'}</InfoBlock>
              </InfoPopover>
            </span>
          }
          subtitle={
            scope.data
              ? `${scope.data.scope.period_label} · ${scope.data.scope.weeks_in_month} business weeks · ${scope.data.scope.days_in_month} days covered`
              : 'Select a month to measure'
          }
          actions={
            cadence ? <CadenceBadge cadence={cadence} /> : null
          }
        />
        <CardBody>
          {/* THE HIERARCHY, TWO CONTROLS PER ROW so the dependency reads
              top-to-bottom on screen the way it works in the data:

                  MONTH     CHANNEL
                  CATEGORY  PRODUCT
                  YEAR      CHECKPOINT

              Each list below the channel comes from the backend cascade, so a
              value that would empty the scope is never offered. */}
          <div className="grid grid-cols-2 gap-x-8 gap-y-5 @max-[620px]:grid-cols-1">
            <Picker
              label="Month"
              value={MONTH_NAMES[controls.month - 1]}
              options={MONTH_NAMES}
              onSelect={(v) => setControl('month', MONTH_NAMES.indexOf(v) + 1)}
            />
            <Picker
              label="Channel"
              value={channelName ?? ALL_CHANNELS}
              options={[ALL_CHANNELS, ...channels.map((c) => c.name)]}
              onSelect={(v) =>
                setControl('channel', v === ALL_CHANNELS ? null : (channels.find((c) => c.name === v)?.code ?? null))
              }
              hint="Top of the hierarchy. Changing it clears category and product."
            />

            <Picker
              label="Category"
              value={controls.category ?? ALL_CATEGORIES}
              options={[ALL_CATEGORIES, ...categories]}
              onSelect={(v) => setControl('category', v === ALL_CATEGORIES ? null : v)}
              hint={
                cascade
                  ? `${categories.length} categor${categories.length === 1 ? 'y' : 'ies'} trade in this channel and month.`
                  : 'Measuring the channel…'
              }
            />
            <Picker
              label="Product"
              value={productName ?? ALL_PRODUCTS}
              options={[ALL_PRODUCTS, ...products.map((p) => p.name)]}
              onSelect={(v) =>
                setControl('product', v === ALL_PRODUCTS ? null : (products.find((p) => p.name === v)?.code ?? null))
              }
              hint={
                cascade
                  ? `${products.length} product${products.length === 1 ? '' : 's'} in ${controls.category ?? 'all categories'}.`
                  : 'Measuring the channel…'
              }
            />

            <Picker
              label="Year"
              value={controls.year ? String(controls.year) : LATEST_YEAR}
              options={[LATEST_YEAR, ...years.map(String)]}
              onSelect={(v) => setControl('year', v === LATEST_YEAR ? null : Number(v))}
              // A month repeats across years and they are not the same length:
              // January 2024 covers 37 business-week days, January 2025 covers
              // 36. The user has to be able to see which one is on screen.
              hint={scope.data ? `Evaluating ${scope.data.scope.period_label}` : undefined}
            />
            <CheckpointPicker
              options={checkpoint?.options ?? []}
              value={controls.checkpoint}
              resolved={checkpoint ?? null}
              cadence={cadence}
              onSelect={(value) => setControl('checkpoint', value)}
            />
          </div>

          {/* THE TARGET AND THE TREATMENT -- what is being measured against, and
              what is running now. Below the hierarchy because they describe the
              scope rather than define it. */}
          <div className="mt-5 grid grid-cols-2 gap-x-8 gap-y-5 border-t border-border-subtle pt-5 @max-[620px]:grid-cols-1">
            <div className="min-w-0">
              <div className="flex items-baseline justify-between gap-2">
                <label
                  htmlFor="rescue-target"
                  className="text-xs font-semibold uppercase tracking-[0.04em] text-ink-muted"
                >
                  Monthly Target
                </label>
                <span className="text-xs text-ink-muted">units</span>
              </div>
              <Input
                id="rescue-target"
                type="number"
                min={1}
                step={1}
                inputMode="numeric"
                className="mt-1.5 tabular-nums"
                placeholder={scope.data?.reference_target?.units_display ?? 'Enter target'}
                value={controls.targetUnits ?? ''}
                onChange={(e) =>
                  setControl('targetUnits', e.target.value === '' ? null : Math.max(0, Number(e.target.value)))
                }
              />
              {/* A MEASURED reference, offered rather than applied. A target is a
                  business commitment and this screen has no standing to set one --
                  but it can say what the same month last year actually did. */}
              {scope.data?.reference_target?.available ? (
                <button
                  type="button"
                  onClick={() => setControl('targetUnits', scope.data?.reference_target?.units ?? null)}
                  className="mt-1.5 cursor-pointer text-left text-xs leading-[1.45] text-brand-violet hover:underline"
                >
                  Use {scope.data.reference_target.year} actual:{' '}
                  {scope.data.reference_target.units_display} units
                  <span className="block text-ink-muted">
                    same month, channel, category and product
                  </span>
                </button>
              ) : (
                <div className="mt-1.5 text-xs leading-[1.45] text-ink-muted">
                  {scope.data?.reference_target?.unavailable_reason ?? 'Enter the monthly unit target.'}
                </div>
              )}
            </div>
            <Slider
              label="Current Discount"
              value={controls.currentDiscountPct}
              min={0}
              max={scope.data?.discount.max_pct ?? 25}
              step={DISCOUNT_STEP}
              minLabel="0%"
              maxLabel={`${scope.data?.discount.max_pct ?? 25}%`}
              valueLabel={`${controls.currentDiscountPct}%`}
              hint={
                scope.data?.measured?.elapsed_depth_pct != null
                  ? `Measured depth over the elapsed weeks: ${scope.data.measured.elapsed_depth_display}. Only approved depths can be priced.`
                  : (scope.data?.discount.note ?? 'Only approved treatment depths can be priced.')
              }
              onChange={(v) => setControl('currentDiscountPct', v)}
            />
          </div>

          {/* THE BUDGET GUARDRAIL EXISTS ONLY WHERE IT CAN BE MEASURED.
              The brief forbids inventing a ceiling, so an unmeasurable scope gets
              the reason instead of a slider with a round number on it. */}
          <div className="mt-5 border-t border-border-subtle pt-5">
            {budget?.available && budget.average_trade_spend ? (
              <Slider
                label="Max Additional Trade Spend (optional)"
                value={controls.maxAdditionalTradeSpend ?? budget.average_trade_spend}
                min={0}
                max={budget.average_trade_spend}
                step={Math.max(1, budget.average_trade_spend / 100)}
                minLabel={moneyZero(scope.data?.meta.currency)}
                maxLabel={budget.display_average}
                valueLabel={money(
                  scope.data?.meta.currency,
                  controls.maxAdditionalTradeSpend ?? budget.average_trade_spend,
                )}
                hint={`${budget.note} Ceiling measured as: ${budget.basis}`}
                onChange={(v) => setControl('maxAdditionalTradeSpend', v)}
              />
            ) : (
              <div className="min-w-0">
                <div className="text-xs font-semibold uppercase tracking-[0.04em] text-ink-muted">
                  Max Additional Trade Spend
                </div>
                <div className="mt-2 text-sm leading-[1.5] text-ink-muted">
                  {budget?.unavailable_reason ??
                    'Unavailable until this scope has a measured historical trade spend. No ceiling is invented for it.'}
                </div>
              </div>
            )}
          </div>

          <div className="mt-5 flex flex-wrap items-center justify-between gap-3 border-t border-border-subtle pt-4">
            {/* SECTION 6's scope line, taken from the server rather than
                assembled here, so the screen and the API can never describe the
                same scope two different ways. Every level is named even when
                unconstrained — "All products" rather than silence. */}
            <div className="max-w-[560px] text-sm leading-[1.45] text-ink-muted">
              {scope.isPending ? (
                'Measuring the selected scope…'
              ) : scope.data ? (
                <>
                  <span className="font-semibold text-ink-secondary">
                    {scope.data.scope.scope_summary}
                  </span>
                  {target == null && (
                    <>
                      {' — '}enter a monthly unit target to evaluate. The target is a business
                      commitment; this screen will not choose one for you.
                    </>
                  )}
                </>
              ) : (
                ' '
              )}
            </div>
            <Button variant="primary" onClick={runEvaluation} disabled={!canRun || evaluate.isPending}>
              {evaluate.isPending ? (
                <>Evaluating...</>
              ) : (
                <>
                  <Icon name="target" /> Check Target
                </>
              )}
            </Button>
          </div>
        </CardBody>
      </Card>

      {scope.isError && <Problem title="Could not measure the month" detail={scope.error.message} />}
      {evaluate.isError && <Problem title="Target evaluation failed" detail={evaluate.error.message} />}

      {evaluate.isPending && (
        <Card className="fade-in">
          <CardBody>
            <div className="flex min-h-[160px] flex-col items-center justify-center gap-3 text-base text-ink-muted">
              <Spinner />
              <span>Evaluating target…</span>
            </div>
          </CardBody>
        </Card>
      )}

      {evaluate.data && !evaluate.isPending && (
        <Result
          result={evaluate.data}
          onReview={reviewScenario}
          reviewPending={review.isPending}
          reviewError={review.isError ? review.error.message : null}
          reviewed={review.data ? { treatment: review.data.treatment, discount: review.data.discount_pct } : null}
        />
      )}
    </div>
  )
}

// --- the result --------------------------------------------------------------

function Result({
  result,
  onReview,
  reviewPending,
  reviewError,
  reviewed,
}: {
  result: TargetRescueResponse
  onReview: () => void
  reviewPending: boolean
  reviewError: string | null
  reviewed: { treatment: string; discount: number } | null
}) {
  if (result.status === 'no_data' || !result.progress || !result.target_status || !result.pace || !result.gap) {
    return (
      <Card className="fade-in">
        <CardBody>
          <div className="flex items-start gap-3">
            <div className="grid h-8 w-8 shrink-0 place-items-center rounded-lg bg-status-warning-bg text-status-warning [&_svg]:h-4 [&_svg]:w-4">
              <Icon name="alertTriangle" />
            </div>
            <div className="min-w-0">
              <div className="text-base font-bold text-ink-primary">No data for this month</div>
              <div className="mt-1 text-base leading-[1.5] text-ink-secondary">{result.message}</div>
            </div>
          </div>
        </CardBody>
      </Card>
    )
  }

  const { progress, target_status: status, pace, gap, population } = result
  const remaining = result.remaining_scope

  return (
    <>
      {/* ---- summary cards ---------------------------------------------- */}
      <div className="fade-in grid grid-cols-5 gap-3 @max-[1100px]:grid-cols-3 @max-[620px]:grid-cols-2">
        <Stat label="Target" value={progress.target_units_display} unit="units" />
        <Stat label="Sold (MTD)" value={progress.units_mtd_display} unit="units to date" />
        <Stat
          label="Attainment"
          value={progress.attainment_display}
          unit={`week ${progress.weeks_completed} of ${progress.weeks_total}`}
        />
        <Stat
          label="Projected"
          value={pace.projected_month_end_display}
          unit={pace.label.toLowerCase()}
        />
        <Stat
          label="Gap"
          value={gap.on_track ? 'On track' : gap.units_display}
          unit={gap.on_track ? 'target already reached' : 'units behind'}
        />
      </div>

      {/* ---- progress --------------------------------------------------- */}
      <Card className="fade-in">
        <CardHeader
          title="Progress"
          subtitle={result.scope.scope_summary}
          actions={<StatusBadge status={status} />}
        />
        <CardBody>
          <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
            <span className="text-xl font-extrabold leading-none tabular-nums text-ink-primary">
              {progress.units_mtd_display}
            </span>
            <span className="text-base text-ink-muted">
              / {progress.target_units_display} units
            </span>
            <span className="text-base font-bold tabular-nums text-ink-secondary">
              {progress.attainment_display}
            </span>
          </div>

          <ProgressBar pct={progress.attainment_pct} intent={status.intent} />

          <div className="mt-3 grid grid-cols-2 gap-x-6 gap-y-2 text-sm @max-[620px]:grid-cols-1">
            <Line
              label="Completed business weeks"
              value={`${progress.weeks_completed} of ${progress.weeks_total}`}
              note={
                `${progress.weeks_remaining} remaining · ` +
                `${progress.days_elapsed} of ${progress.days_in_month} days covered` +
                (progress.week_key ? ` · through ${progress.week_key}` : '')
              }
            />
            <Line
              label={pace.label}
              value={pace.projected_month_end_display}
              note={
                pace.projected_achievement_pct != null
                  ? `${pace.projected_achievement_pct}% of target at ${pace.daily_pace_display} units/day`
                  : (pace.unavailable_reason ?? '')
              }
            />
          </div>

          <Callout icon="info">
            {result.cadence.code === 'MIXED'
              ? `Mixed cadence in scope (${result.cadence.channels
                  .map((c) => `${c.channel_id} ${c.cadence}`)
                  .join(', ')}). `
              : `${result.cadence.code} cadence. `}
            {progress.checkpoint_type === 'auto'
              ? `The checkpoint resolved automatically to ${result.checkpoint?.auto_rule.toLowerCase()} — week ${progress.checkpoint_week} of ${progress.weeks_total}.`
              : `Week ${progress.checkpoint_week} of ${progress.weeks_total} was selected.`}{' '}
            Progress is the sum of the completed business weeks; the day count beside it is what
            those weeks cover in the calendar, not a daily sales read.
          </Callout>
          {remaining && remaining.weeks_remaining > 0 && (
            <Callout icon="info">
              An intervention would act on {remaining.opportunity_label}.{' '}
              {remaining.completed_weeks_untouched}
            </Callout>
          )}
          {progress.phase !== 'checkpoint' && <Callout icon="alertTriangle">{progress.phase_note}</Callout>}
          {/* THE WEEKLY DEFAULT LANDS ON A CLOSED MONTH, and that is correct: the
              latest completed business week of a fully-recorded month IS its last,
              so nothing remains for an intervention to act on. Rather than leave
              the user at a dead end, say which control moves them off it. */}
          {progress.weeks_remaining === 0 && progress.checkpoint_type !== 'week' && (
            <Callout icon="info">
              The checkpoint resolved to the month's last business week, so there is no remaining
              week for an intervention to act on and this is a final result. Choose an earlier
              week in <strong className="font-semibold text-ink-secondary">Checkpoint</strong> to
              evaluate a mid-month rescue.
            </Callout>
          )}
          {population?.carried_reason && (
            <Callout icon="info">
              {population.carried_products} of {population.remaining_products} products in scope have
              no non-promoted week this month, so no approved treatment can be re-based on them.
              Their {population.carried_units_display} remaining units are carried at the measured
              level in every option, identically.
            </Callout>
          )}
        </CardBody>
      </Card>

      {/* ---- recommendation --------------------------------------------- */}
      <RecommendationCard
        result={result}
        onReview={onReview}
        reviewPending={reviewPending}
        reviewError={reviewError}
        reviewed={reviewed}
      />

      {/* ---- comparison -------------------------------------------------- */}
      {result.interventions.length > 0 && <ComparisonCard result={result} />}

      {/* ---- why --------------------------------------------------------- */}
      {result.evidence.length > 0 && (
        <Card className="fade-in">
          <CardHeader
            title="Why this recommendation?"
            subtitle="Every line below is derived from a figure on this screen"
          />
          <CardBody>
            <ul className="flex flex-col gap-2">
              {result.evidence.map((line, i) => (
                <li key={i} className="flex gap-2.5 text-base leading-[1.55] text-ink-secondary">
                  <span className="mt-[7px] h-1.5 w-1.5 shrink-0 rounded-full bg-brand-violet" />
                  <span>{line}</span>
                </li>
              ))}
            </ul>
            <div className="mt-4 border-t border-border-subtle pt-3 text-xs leading-[1.5] text-ink-muted">
              {result.provenance.decision_rule} {result.provenance.cannibalization}
            </div>
          </CardBody>
        </Card>
      )}
    </>
  )
}

/** Put the rung Target Rescue recommended on the Decision Center's board.
 *
 *  READ-ONLY OVER TARGET RESCUE. This adds a control and nothing else: the
 *  target calculation, the ladder, the ranking rule that chose this rung and
 *  every figure on it are untouched, and the candidate is a COPY of the
 *  intervention this card is already displaying. Nothing here re-decides which
 *  rung is recommended, and nothing recomputes its economics.
 *
 *  Absent when the engine recommended no intervention — there is no scenario
 *  to add, and a button that adds nothing is worse than no button. */
function AddRescueToDecisionCenter({ result }: { result: TargetRescueResponse }) {
  const addCandidate = useDecisionCandidateStore((s) => s.add)
  const { show } = useToast()
  const intervention = result.recommendation?.intervention ?? null
  if (!intervention) return null
  return (
    <Button
      variant="secondary"
      size="sm"
      onClick={() => {
        const candidate = candidateFromRescue(result, intervention)
        addCandidate(candidate)
        show(`${candidate.name} added to Decision Center`, { duration: 3000 })
      }}
    >
      <Icon name="plus" /> Add to Decision Center
    </Button>
  )
}

function RecommendationCard({
  result,
  onReview,
  reviewPending,
  reviewError,
  reviewed,
}: {
  result: TargetRescueResponse
  onReview: () => void
  reviewPending: boolean
  reviewError: string | null
  reviewed: { treatment: string; discount: number } | null
}) {
  const rec = result.recommendation
  const status = result.target_status
  const chosen = rec?.intervention ?? null
  const current = result.current_treatment

  return (
    <Card className="fade-in">
      <CardHeader
        title={status?.final ? 'Final Target Result' : 'Recommended Recovery'}
        subtitle={status?.action}
        actions={
          <div className="flex items-center gap-2">
            <AddRescueToDecisionCenter result={result} />
            {rec?.ranking_basis ? (
              <InfoPopover label="How this was chosen" title="Recommendation policy" width={340}>
                <InfoBlock label="Ranking">{rec.ranking_basis}</InfoBlock>
                <InfoBlock label="Decision rule">{result.provenance.decision_rule}</InfoBlock>
                <InfoBlock label="Ceiling">{result.provenance.discount_ceiling}</InfoBlock>
                <InfoBlock label="Clearance">{result.provenance.clearance_basis}</InfoBlock>
              </InfoPopover>
            ) : null}
          </div>
        }
      />
      <CardBody>
        {chosen && chosen.kind !== 'maintain' ? (
          <>
            <div className="text-xs font-semibold uppercase tracking-[0.04em] text-ink-muted">
              {chosen.mechanic ? 'Apply approved clearance mechanic' : 'Increase discount'}
            </div>
            <div className="mt-1.5 flex flex-wrap items-baseline gap-2.5">
              <span className="text-xl font-extrabold leading-none tabular-nums text-ink-primary">
                {current?.discount_display ?? '—'}
              </span>
              <Icon name="arrowRight" className="h-4 w-4 text-ink-muted" />
              <span className="text-xl font-extrabold leading-none tabular-nums text-brand-violet">
                {chosen.discount_display}
              </span>
              {chosen.mechanic && (
                <span className="rounded-[var(--r-pill)] bg-brand-violet-50 px-2 py-0.5 text-xs font-bold text-brand-violet">
                  {chosen.mechanic}
                </span>
              )}
              <span className="text-sm text-ink-muted">
                {chosen.ladder_label} · {chosen.treatment}
              </span>
            </div>

            <div className="mt-4 grid grid-cols-4 gap-3 @max-[900px]:grid-cols-2">
              <Mini label="Expected recovery" value={chosen.recovery_units.display} unit="units" />
              <Mini label="Projected month-end" value={chosen.projected_month_end.display} unit="units" />
              <Mini label="Additional trade spend" value={chosen.additional_trade_spend_display} unit="" />
              <Mini label="ROI" value={chosen.roi_display} unit={`margin ${chosen.margin_display}`} />
            </div>
          </>
        ) : (
          <div className="text-md font-extrabold text-ink-primary">
            {chosen?.kind === 'maintain'
              ? 'Maintain current treatment'
              : status?.final
                ? status.label
                : 'No approved intervention recommended'}
          </div>
        )}

        <div className="mt-3 text-base leading-[1.55] text-ink-secondary">{rec?.reason}</div>

        {chosen?.level_note && (
          <div className="mt-2 text-sm leading-[1.5] text-ink-muted">{chosen.level_note}</div>
        )}
        {current?.no_stronger_reason && (
          <Callout icon="alertTriangle">{current.no_stronger_reason}</Callout>
        )}
        {!chosen?.estimable && chosen?.unavailable_reason && (
          <Callout icon="alertTriangle">{chosen.unavailable_reason}</Callout>
        )}

        {/* REVIEW, NOT APPLY. Running the recommended treatment through the
            existing /simulation/simulate endpoint over THIS mode's own scope
            mutates nothing: no promotion is created, no plan is changed, and the
            Investigation Simulation's scope is not touched. See
            hooks/useTargetRescue.ts for why there is no cross-mode hand-off. */}
        {chosen && chosen.kind !== 'maintain' && chosen.discount_pct != null && (
          <div className="mt-4 flex flex-wrap items-center gap-3 border-t border-border-subtle pt-4">
            <Button variant="secondary" onClick={onReview} disabled={reviewPending}>
              {reviewPending ? <>Running…</> : <><Icon name="play" /> Review Scenario</>}
            </Button>
            <span className="text-xs leading-[1.5] text-ink-muted">
              {reviewed
                ? `Reviewed: ${reviewed.treatment} at ${reviewed.discount}% executed over this scope by the existing simulation engine. Nothing was created or activated.`
                : 'Executes the recommended treatment over this scope with the existing simulation engine, for review. It creates no promotion and changes no plan.'}
            </span>
            {reviewError && <span className="text-xs text-status-danger">{reviewError}</span>}
          </div>
        )}
      </CardBody>
    </Card>
  )
}

/** The ladder, side by side. The question the table has to answer at a glance is
 *  "which is the least aggressive option that reaches the target?", so the
 *  reaching rungs are marked and the recommended one is highlighted. */
function ComparisonCard({ result }: { result: TargetRescueResponse }) {
  const recommendedLevel = result.recommendation?.level ?? null
  return (
    <Card className="fade-in">
      <CardHeader
        title="Intervention Comparison"
        subtitle={
          result.remaining_scope
            ? `${result.interventions.length} options over ${result.remaining_scope.opportunity_label}`
            : `${result.interventions.length} options`
        }
        actions={
          <InfoPopover label="How these were priced" title="Economics" width={340}>
            <InfoBlock label="Economics">{result.provenance.economics}</InfoBlock>
            <InfoBlock label="KPI engine">{result.provenance.kpi_engine}</InfoBlock>
            <InfoBlock label="Approved rule">{result.provenance.response_rule}</InfoBlock>
            <InfoBlock label="Not modelled">{result.provenance.cannibalization}</InfoBlock>
          </InfoPopover>
        }
      />
      <div className="overflow-x-auto rounded-b-[var(--r-lg)] [&_td]:!px-2.5 [&_th]:!px-2.5">
        <Table>
          <thead>
            <tr>
              <Th>Action</Th>
              <Th>Discount / Mechanic</Th>
              <Th className="text-right">Expected Units</Th>
              <Th className="text-right">Projected Month-End</Th>
              <Th className="text-right">Target Achievement</Th>
              <Th className="text-right">Trade Spend</Th>
              <Th className="text-right">Incremental Sales</Th>
              <Th className="text-right">ROI</Th>
              <Th className="text-right">Margin Impact</Th>
              {/* WHICH WEEKS the option acts on. For a weekly channel these are
                  separate promotion events, so the column names them rather
                  than implying one monthly promotion. */}
              <Th>Applies to</Th>
            </tr>
          </thead>
          <tbody>
            {result.interventions.map((row) => (
              <LadderRow key={row.level} row={row} recommended={row.level === recommendedLevel} />
            ))}
          </tbody>
        </Table>
      </div>
      <div className="border-t border-border-subtle px-5 py-3 text-xs leading-[1.5] text-ink-muted">
        {result.provenance.decision_rule}
      </div>
    </Card>
  )
}

function LadderRow({ row, recommended }: { row: Intervention; recommended: boolean }) {
  return (
    <Tr className={recommended ? 'bg-brand-violet-50/50' : undefined}>
      <Td emphasis className="max-w-[220px]">
        <span className="flex items-center gap-1.5">
          {recommended && <Icon name="checkCircle" className="h-3.5 w-3.5 shrink-0 text-brand-violet" />}
          <span className="truncate" title={row.ladder_label}>
            {row.ladder_label}
          </span>
        </span>
      </Td>
      <Td className="whitespace-nowrap">
        {row.kind === 'maintain' ? (
          // NOT "0%" — the maintain rung is the remaining weeks as recorded, and
          // it ran at whatever depth the data holds. Saying so is different from
          // saying it ran at nothing.
          <span className="text-sm text-ink-muted">
            Current{row.measured_depth_pct != null ? ` · measured ${row.measured_depth_display}` : ''}
          </span>
        ) : (
          <span
            className="inline-flex items-center rounded-[var(--r-pill)] bg-brand-violet-50 px-2 py-0.5 text-xs font-bold tabular-nums text-brand-violet"
            title={`${row.treatment} · approved uplift ${(row.uplift.low * 100).toFixed(0)}–${(row.uplift.high * 100).toFixed(0)}%`}
          >
            {row.mechanic ? `${row.mechanic} · ${row.discount_display}` : row.discount_display}
          </span>
        )}
      </Td>
      <Td className="whitespace-nowrap text-right tabular-nums">{row.remaining_units.display}</Td>
      <Td className="whitespace-nowrap text-right tabular-nums">{row.projected_month_end.display}</Td>
      <Td className="whitespace-nowrap text-right tabular-nums">
        {row.achievement_pct.low == null ? (
          '—'
        ) : (
          <span className={row.reaches_target ? 'font-bold text-status-success' : 'text-ink-secondary'}>
            {row.achievement_pct.low}%
          </span>
        )}
      </Td>
      <Td className="whitespace-nowrap text-right tabular-nums">{row.trade_spend_display}</Td>
      <Td className="whitespace-nowrap text-right tabular-nums">{row.incremental_sales_display}</Td>
      <Td className="whitespace-nowrap text-right tabular-nums">{row.roi_display}</Td>
      <Td className="whitespace-nowrap text-right tabular-nums">{row.margin_display}</Td>
      <Td className="whitespace-nowrap">
        {row.by_week.length === 0 ? (
          <span className="text-xs text-ink-muted">No remaining week</span>
        ) : (
          <span className="flex flex-wrap gap-1">
            {row.by_week.map((week) => (
              <span
                key={week.week_key}
                className="inline-flex items-center rounded-[var(--r-sm)] bg-surface-muted px-1.5 py-0.5 text-xs font-semibold text-ink-secondary"
                title={
                  `${week.week_key} · ${week.units.display} units` +
                  (week.promotion_ids.length
                    ? ` · promotions ${week.promotion_ids.join(', ')}`
                    : ' · no promotion recorded')
                }
              >
                {week.label}
                {week.promotion_ids.length > 1 && (
                  <span className="ml-1 text-ink-muted">×{week.promotion_ids.length}</span>
                )}
              </span>
            ))}
          </span>
        )}
      </Td>
    </Tr>
  )
}


/** The channel's promotion cadence, stated plainly.
 *
 *  Section 6 of the brief: showing the cadence is what makes the checkpoint's
 *  different behaviour understandable rather than surprising. It is read from
 *  the API, which reads the project's own declaration — nothing here decides
 *  which channel plans which way.
 */
function CadenceBadge({ cadence }: { cadence: CadenceBlock }) {
  return (
    <span
      className={`inline-flex items-center gap-1.5 rounded-[var(--r-pill)] px-2.5 py-1 text-xs font-extrabold uppercase tracking-[0.04em] ${CADENCE_TONE}`}
      title={`${cadence.checkpoint_rule} ${cadence.basis}`}
    >
      <Icon name="calendar" className="h-3 w-3" />
      Cadence: {cadence.code}
      {cadence.mixed && (
        <span className="font-semibold normal-case tracking-normal text-ink-muted">
          ({cadence.channels.map((c) => `${c.channel_id} ${c.cadence}`).join(', ')})
        </span>
      )}
    </span>
  )
}


/** The progress checkpoint: a COMPLETED BUSINESS WEEK.
 *
 *  A list, not a slider, and the list comes from the API. Only weeks the selected
 *  month actually contains are offered — the brief forbids presenting an
 *  impossible future week — and each option says what it would leave for an
 *  intervention to act on, because an option leaving nothing produces a final
 *  result rather than a ladder.
 */
function CheckpointPicker({
  options,
  value,
  resolved,
  cadence,
  onSelect,
}: {
  options: CheckpointOption[]
  value: CheckpointValue
  resolved: TargetRescueResponse['checkpoint']
  cadence: CadenceBlock | undefined
  onSelect: (value: CheckpointValue) => void
}) {
  // ONE label function, used for display, for the menu and for matching the
  // selection back. `Dropdown` identifies an option by its label, so two
  // spellings of the same option would make it unselectable.
  //
  // The label carries what the choice would LEAVE, because an option leaving no
  // remaining week produces a final result rather than a ladder, and that is
  // worth knowing before it is picked rather than after.
  const labelOf = (option: CheckpointOption) => {
    const base = option.value === 'auto' ? `Auto · Week ${option.ordinal}` : option.label
    const left =
      option.weeks_remaining === 0
        ? 'no week left'
        : `${option.weeks_remaining} week${option.weeks_remaining === 1 ? '' : 's'} left`
    return `${base} · ${left}`
  }

  const current = options.find((option) => option.value === value)
  const display = current
    ? labelOf(current)
    : typeof value === 'number'
      ? `Week ${value}`
      : 'Auto'

  return (
    <div className="min-w-0">
      <div className="flex items-baseline justify-between gap-2">
        <div className="text-xs font-semibold uppercase tracking-[0.04em] text-ink-muted">
          Checkpoint
        </div>
        {resolved && (
          <span className="text-xs tabular-nums text-ink-muted">
            week {resolved.checkpoint_week} of {resolved.weeks_total}
          </span>
        )}
      </div>
      <Dropdown
        selected={display}
        options={options.map((option) => ({ label: labelOf(option) }))}
        onSelect={(picked) => {
          const match = options.find((option) => labelOf(option) === picked)
          if (match) onSelect(match.value)
        }}
        trigger={
          <Button variant="secondary" block className="mt-1.5 cursor-pointer justify-between">
            <span className="truncate">{display}</span>
            <Icon name="chevronDown" />
          </Button>
        }
      />
      <div className="mt-1.5 text-xs leading-[1.45] text-ink-muted">
        {resolved
          ? `${resolved.note} Auto: ${resolved.auto_rule.toLowerCase()}.`
          : (cadence?.checkpoint_rule ?? 'Select a month to list its business weeks.')}
      </div>
    </div>
  )
}


// --- pieces ------------------------------------------------------------------

function Picker({
  label,
  value,
  options,
  onSelect,
  hint,
}: {
  label: string
  value: string
  options: string[]
  onSelect: (value: string) => void
  hint?: string
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
      {hint && <div className="mt-1.5 text-xs leading-[1.45] text-ink-muted">{hint}</div>}
    </div>
  )
}

function Stat({ label, value, unit }: { label: string; value: string; unit: string }) {
  return (
    <div className="rounded-[var(--r-lg)] border border-border-subtle bg-surface-muted p-[12px_14px]">
      <div className="text-xs font-semibold uppercase tracking-[0.04em] text-ink-muted">{label}</div>
      <div className="mt-1.5 truncate text-md font-extrabold leading-[1.2] tabular-nums text-ink-primary" title={value}>
        {value}
      </div>
      <div className="mt-0.5 truncate text-xs text-ink-muted" title={unit}>
        {unit}
      </div>
    </div>
  )
}

function Mini({ label, value, unit }: { label: string; value: string; unit: string }) {
  return (
    <div>
      <div className="text-xs font-semibold uppercase tracking-[0.04em] text-ink-muted">{label}</div>
      <div className="mt-1 truncate text-base font-extrabold tabular-nums text-ink-primary" title={value}>
        {value}
      </div>
      {unit && <div className="text-xs text-ink-muted">{unit}</div>}
    </div>
  )
}

function Line({ label, value, note }: { label: string; value: string; note: string }) {
  return (
    <div>
      <div className="flex items-baseline justify-between gap-3">
        <span className="text-ink-muted">{label}</span>
        <span className="font-bold tabular-nums text-ink-primary">{value}</span>
      </div>
      {note && <div className="mt-0.5 text-xs leading-[1.45] text-ink-muted">{note}</div>}
    </div>
  )
}

/** The status band, in the platform's existing status vocabulary. The intent
 *  comes from the API so the label and the colour cannot disagree. */
function StatusBadge({ status }: { status: TargetRescueResponse['target_status'] }) {
  if (!status) return null
  const tone =
    status.intent === 'success'
      ? 'bg-status-success-bg text-status-success'
      : status.intent === 'warning'
        ? 'bg-status-warning-bg text-status-warning'
        : 'bg-status-danger-bg text-status-danger'
  return (
    <span
      className={`inline-flex items-center gap-1.5 rounded-[var(--r-pill)] px-2.5 py-1 text-xs font-extrabold uppercase tracking-[0.03em] ${tone}`}
      title={status.thresholds.basis}
    >
      {status.label}
    </span>
  )
}

/** Attainment as a proportion of the target. Capped at 100% of the BAR, never of
 *  the number beside it — a target overshot reads as a full bar and a figure
 *  above 100%, which is the truth. */
function ProgressBar({ pct, intent }: { pct: number | null; intent: 'success' | 'warning' | 'danger' }) {
  const width = pct == null ? 0 : Math.max(0, Math.min(100, pct))
  const fill =
    intent === 'success' ? 'bg-status-success' : intent === 'warning' ? 'bg-status-warning' : 'bg-status-danger'
  return (
    <div className="mt-3 h-2.5 w-full overflow-hidden rounded-full bg-border-default">
      <div className={`h-full rounded-full transition-[width] duration-300 ${fill}`} style={{ width: `${width}%` }} />
    </div>
  )
}

function Callout({ icon, children }: { icon: 'info' | 'alertTriangle'; children: React.ReactNode }) {
  return (
    <div className="mt-3 flex gap-2.5 rounded-[var(--r-md)] bg-surface-muted p-[10px_12px]">
      <Icon name={icon} className="mt-[1px] h-3.5 w-3.5 shrink-0 text-ink-muted" />
      <div className="text-sm leading-[1.5] text-ink-muted">{children}</div>
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

// --- formatting helpers ------------------------------------------------------
//
// The API formats every money value with the one formatter the whole platform
// shares. These two exist only because a slider's live handle position has no
// server-formatted string to read, and they format nothing the API also formats.

function moneyZero(currency: string | undefined): string {
  return currency === 'USD' ? '$0' : '₹0'
}

function money(currency: string | undefined, value: number): string {
  const symbol = currency === 'USD' ? '$' : '₹'
  if (!value) return `${symbol}0`
  if (value >= 1e7) return `${symbol}${(value / 1e7).toFixed(1)} Cr`
  if (value >= 1e5) return `${symbol}${(value / 1e5).toFixed(1)} L`
  if (value >= 1e3) return `${symbol}${(value / 1e3).toFixed(1)} K`
  return `${symbol}${value.toFixed(0)}`
}
