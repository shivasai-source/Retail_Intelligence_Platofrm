import type {
  CandidateMetric,
  CandidatePlanField,
  CandidateRisk,
  DecisionCandidate,
  MetricDirection,
} from '../types/decisionCandidate'
import type { DecisionDraft } from '../store/decisionDraft'
import type { OptimizationResponse } from '../types/optimization'
import type { RiskAssessment } from '../types/risk'
import type { Intervention, TargetRescueResponse } from '../types/targetRescue'
import type {
  SimulateResponse,
  SimulationKpi,
  SimulationKpiKey,
  SimulationRunResponse,
} from '../types/simulation'

/** Reading each module's scenario into the common candidate shape, and ranking
 *  the result — B-DC2.
 *
 *  PURE FUNCTIONS OVER PAYLOADS THE PAGE ALREADY HAS. Nothing here fetches,
 *  and nothing here computes a promotion figure: every value is lifted from the
 *  response that owns it, with that response's own display string. The only
 *  arithmetic in this file is the ranking's own bookkeeping — positions and
 *  points — and it is printed on screen beside the result it produced.
 */

/** WHICH WAY IS BETTER, stated once.
 *
 *  A comparison cannot mark a best value without this, and getting it from the
 *  metric's name is how "highest trade spend wins" happens. Discount depth and
 *  duration are deliberately `neutral`: they are SETTINGS the user chose, not
 *  outcomes to be scored.
 */
const DIRECTION: Record<string, MetricDirection> = {
  incremental_sales: 'higher',
  incremental_units: 'higher',
  revenue: 'higher',
  units: 'higher',
  roi_multiple: 'higher',
  margin_pct: 'higher',
  pei: 'higher',
  trade_spend: 'lower',
}

const LABEL: Record<string, string> = {
  incremental_sales: 'Incremental Sales',
  incremental_units: 'Incremental Units',
  revenue: 'Revenue',
  units: 'Units',
  roi_multiple: 'ROI',
  margin_pct: 'Margin',
  pei: 'PEI',
  trade_spend: 'Trade Spend',
}

/** The simulation's KPI keys, mapped onto the shared vocabulary. Where the
 *  two differ in spelling — `margin_percent` and `margin_pct` are the same
 *  figure from the same engine — this map is where that is said once. */
const SIM_KEYS: [SimulationKpiKey, string][] = [
  ['incremental_sales', 'incremental_sales'],
  ['trade_spend', 'trade_spend'],
  ['roi_multiple', 'roi_multiple'],
  ['margin_percent', 'margin_pct'],
  ['incremental_units', 'incremental_units'],
  ['pei', 'pei'],
]

function metric(
  key: string,
  low: number | null,
  high: number | null,
  display: string,
  available: boolean,
  unavailable_reason: string | null,
): CandidateMetric {
  return {
    key,
    label: LABEL[key] ?? key,
    direction: DIRECTION[key] ?? 'neutral',
    low,
    high,
    display,
    available,
    unavailable_reason,
  }
}

/** A band's two ends as one string, using the ENGINE's own formatting of each
 *  end. Collapsed when the ends coincide, because "₹2.9 Cr – ₹2.9 Cr" reads as
 *  a range that does not exist. */
function bandDisplay(lowDisplay: string, highDisplay: string): string {
  return lowDisplay === highDisplay ? lowDisplay : `${lowDisplay} – ${highDisplay}`
}

/** The scope a simulation was run against, in the words its own context block
 *  already uses. Composed from the backend's own summaries rather than from the
 *  filter object — a second phrasing of the same scope is a second answer. */
export function scopeLabelFromContext(context: {
  period_label: string
  dimensions: { constrained: boolean; summary: string }[]
}): string {
  const parts = [context.period_label, ...context.dimensions.filter((d) => d.constrained).map((d) => d.summary)]
  return parts.filter(Boolean).join(' · ') || 'Whole business'
}

// --- Simulation Studio -----------------------------------------------------

/** A simulated scenario: the KPIs at both ends of its approved uplift range. */
function simulatedMetrics(simulation: SimulateResponse): CandidateMetric[] {
  return SIM_KEYS.map(([simKey, key]) => {
    const low = simulation.result.low.kpis[simKey] as SimulationKpi | undefined
    const high = simulation.result.high.kpis[simKey] as SimulationKpi | undefined
    if (!low || !high) return null
    if (!low.available) return metric(key, null, null, '—', false, low.unavailable_reason)
    return metric(
      key,
      low.value,
      high.value,
      bandDisplay(low.display_value, high.display_value),
      true,
      null,
    )
  }).filter((m): m is CandidateMetric => m !== null)
}

/** The measured Current Plan: point figures, not a band — it is observed, not
 *  modelled, and rendering it as a range would claim an uncertainty the
 *  measurement does not have. */
function measuredMetrics(kpis: Record<SimulationKpiKey, SimulationKpi>): CandidateMetric[] {
  return SIM_KEYS.map(([simKey, key]) => {
    const kpi = kpis[simKey]
    if (!kpi) return null
    if (!kpi.available) return metric(key, null, null, '—', false, kpi.unavailable_reason)
    return metric(key, kpi.value, kpi.value, kpi.display_value, true, null)
  }).filter((m): m is CandidateMetric => m !== null)
}

function riskOf(risk: RiskAssessment | null): CandidateRisk | null {
  if (!risk) return null
  return {
    status: risk.overall_status,
    summary: risk.summary,
    clear: risk.findings.filter((f) => f.status === 'clear').length,
    attention: risk.findings.filter((f) => f.status === 'attention').length,
    unknown: risk.findings.filter((f) => f.status === 'unknown').length,
    policy_version: risk.policy.version,
  }
}

/** The Current Plan as a candidate — the measured baseline every other
 *  scenario is being compared against. */
export function candidateFromCurrentPlan(
  run: SimulationRunResponse,
  scopeLabel: string,
): DecisionCandidate {
  // THE CURRENT PLAN'S OWN OBSERVED FIELDS, whichever the engine could read.
  // Every one of them carries `available` and a reason, so an unreadable field
  // is simply not listed rather than printed as a blank.
  const plan: CandidatePlanField[] = run.current_plan.fields
    .filter((f) => f.available && f.display_value)
    .map((f) => ({ key: f.key, label: f.label, display: f.display_value! }))
  return {
    id: 'measured:current-plan',
    name: run.scenario.name,
    source: 'measured',
    sourceLabel: 'CURRENT PLAN',
    scopeLabel,
    addedAt: Date.now(),
    plan,
    metrics: measuredMetrics(run.kpis),
    risk: null,
    basis: 'Measured from the rows in scope by the validated KPI engine — observed, not modelled.',
    draft: null,
  }
}

/** A simulated scenario from Simulation Studio, with the decision payload the
 *  existing single-record view assembles from when one is available. */
export function candidateFromSimulation(input: {
  scenarioId: string
  name: string
  simulation: SimulateResponse
  risk: RiskAssessment | null
  scopeLabel: string
  draft: DecisionDraft | null
}): DecisionCandidate {
  const { simulation } = input
  const plan: CandidatePlanField[] = [
    { key: 'treatment', label: 'Treatment', display: simulation.treatment },
    { key: 'discount_pct', label: 'Discount depth', display: `${simulation.discount_pct}%` },
  ]
  const weeks = simulation.levers.duration_weeks
  if (weeks.value != null) {
    plan.push({
      key: 'duration_weeks',
      label: 'Duration',
      // The engine's own note travels with it — this lever is RECORDED and not
      // modelled, and a duration printed without that is read as an input.
      display: `${weeks.value} week${weeks.value === 1 ? '' : 's'}${weeks.modelled ? '' : ' (recorded, not modelled)'}`,
    })
  }
  return {
    id: `simulation:${input.scenarioId}:${simulation.discount_pct}`,
    name: input.name,
    source: 'simulation',
    sourceLabel: 'SIMULATION',
    scopeLabel: input.scopeLabel,
    addedAt: Date.now(),
    plan,
    metrics: simulatedMetrics(simulation),
    risk: riskOf(input.risk),
    basis: `${simulation.provenance.method} ${simulation.range_label}.`,
    draft: input.draft,
  }
}

// --- General Optimization --------------------------------------------------

/** The optimizer's plan.
 *
 *  THREE METRICS, NOT SEVEN. The optimizer reports units, revenue and trade
 *  spend and computes no ROI, no margin and no incremental sales — so this
 *  candidate carries three metrics and the comparison simply has fewer rows it
 *  can rank across every scenario. Deriving the missing four from what it does
 *  report would be inventing the figures the ranking then runs on.
 */
export function candidateFromOptimization(result: OptimizationResponse): DecisionCandidate | null {
  if (result.status !== 'optimized' || !result.optimized) return null
  const o = result.optimized
  const plan: CandidatePlanField[] = [
    { key: 'average_discount', label: 'Average discount', display: o.average_discount_display },
    { key: 'promoted', label: 'Promoted products', display: String(o.promoted_candidates) },
  ]
  if (o.budget_used_pct != null) {
    plan.push({ key: 'budget_used', label: 'Ceiling used', display: `${o.budget_used_pct}%` })
  }
  return {
    id: 'optimization:latest',
    name: 'Optimized Allocation',
    source: 'optimization',
    sourceLabel: 'AI OPTIMIZATION',
    scopeLabel: `${result.scope.category_label} · ${result.scope.channel_label} · ${result.scope.month_label}`,
    addedAt: Date.now(),
    plan,
    metrics: [
      metric('units', o.units.low, o.units.high, o.units.display, true, null),
      metric('revenue', o.revenue.low, o.revenue.high, o.revenue.display, true, null),
      metric('trade_spend', o.trade_spend.low, o.trade_spend.high, o.trade_spend.display, true, null),
    ],
    risk: null,
    basis: `${result.provenance.objective} ${result.provenance.constraint}`,
    draft: null,
  }
}

// --- Target Rescue ---------------------------------------------------------

/** The rescue rung the engine recommended, exactly as it computed it.
 *
 *  READ-ONLY, and deliberately so: Target Rescue chooses its own rung under its
 *  own ranking rule, and this reads that choice out. Nothing here re-ranks the
 *  ladder, re-decides the intervention or recomputes a figure.
 */
export function candidateFromRescue(
  result: TargetRescueResponse,
  intervention: Intervention,
): DecisionCandidate {
  const plan: CandidatePlanField[] = []
  if (intervention.treatment) {
    plan.push({ key: 'treatment', label: 'Treatment', display: intervention.treatment })
  }
  if (intervention.mechanic) {
    plan.push({ key: 'mechanic', label: 'Mechanic', display: intervention.mechanic })
  }
  plan.push({ key: 'discount', label: 'Discount depth', display: intervention.discount_display })
  plan.push({
    key: 'reaches_target',
    label: 'Reaches target',
    // The engine decides this at the LOW end of the approved band and says so;
    // the wording follows it rather than softening a no into a maybe.
    display: intervention.reaches_target ? 'Yes, at the low end' : 'No, not at the low end',
  })

  const metrics: CandidateMetric[] = []
  const add = (key: string, value: number | null, display: string, reason: string | null) => {
    if (value == null) metrics.push(metric(key, null, null, '—', false, reason))
    else metrics.push(metric(key, value, value, display, true, null))
  }
  add('incremental_sales', intervention.incremental_sales, intervention.incremental_sales_display, intervention.unavailable_reason)
  add('trade_spend', intervention.trade_spend, intervention.trade_spend_display, intervention.unavailable_reason)
  add('roi_multiple', intervention.roi_multiple, intervention.roi_display, intervention.unavailable_reason)
  add('margin_pct', intervention.margin_pct, intervention.margin_display, intervention.unavailable_reason)
  add('incremental_units', intervention.incremental_units, intervention.incremental_units_display, intervention.unavailable_reason)

  return {
    id: `rescue:level-${intervention.level}`,
    name: `Target Rescue — ${intervention.ladder_label}`,
    source: 'rescue',
    sourceLabel: 'TARGET RESCUE',
    scopeLabel: result.scope.scope_summary,
    addedAt: Date.now(),
    plan,
    metrics,
    risk: null,
    basis: `${result.provenance.decision_rule} ${result.provenance.ranking_basis}`,
    draft: null,
  }
}

// --- Ranking ---------------------------------------------------------------

export interface RankedCriterion {
  key: string
  label: string
  direction: MetricDirection
  /** candidate id → points earned on this criterion. */
  points: Record<string, number>
  /** candidate id → the value it was ranked on, as its engine displayed it. */
  values: Record<string, string>
}

export interface CandidateRanking {
  /** The rule, in words, exactly as it was applied. Rendered on the page: a
   *  ranking nobody can read is indistinguishable from an opinion. */
  rule: string
  criteria: RankedCriterion[]
  totals: { id: string; points: number }[]
  /** Null when nothing could be ranked, or when the top two tie — a tie is a
   *  real outcome and naming an arbitrary winner would hide it. */
  winnerId: string | null
  /** Why there is no winner, when there is none. */
  blocked: string | null
  /** Set only when the points were level and ROI decided it — printed beside
   *  the winner so a tie-break is never invisible. */
  tieBreak?: string
}

export const RANKING_RULE =
  'Every metric that all compared scenarios report is ranked best to worst — higher for ' +
  'incremental sales, revenue, units, ROI, margin and PEI, lower for trade spend — and each ' +
  'scenario earns one point per scenario it beats. Bands are ' +
  'ranked at their LOW end, the same end Target Rescue decides on. Risk is not ranked: the ' +
  'risk engine computes no score, so there is no risk number to compare — the assessment is ' +
  'in Simulation Studio. Points are summed unweighted: no metric outranks another, and no figure is ' +
  'recomputed here. A tie on points is broken on ROI, which is the one metric this project ' +
  'sets a target for; a tie that ROI cannot break leaves both scenarios level and names no ' +
  'winner.'

/** Rank the candidates on what they can all actually be compared on.
 *
 *  ONLY METRICS EVERY CANDIDATE REPORTS. Ranking on a metric one scenario is
 *  missing would score it against a figure its engine never produced — the
 *  optimizer would lose every ROI comparison it was never in. A metric that
 *  not all of them carry is still SHOWN in the table; it just does not vote.
 *
 *  NO WEIGHTS, because there are none to reuse. The project defines no
 *  approved trade-off between ROI and spend, and inventing one here would be
 *  the invented policy the rest of the app refuses. Equal points per criterion
 *  is the assumption that can be stated in one sentence and audited on screen.
 */
export function rankCandidates(candidates: DecisionCandidate[]): CandidateRanking {
  if (candidates.length < 2) {
    return {
      rule: RANKING_RULE,
      criteria: [],
      totals: candidates.map((c) => ({ id: c.id, points: 0 })),
      winnerId: null,
      blocked:
        candidates.length === 0
          ? 'No scenarios have been added yet.'
          : 'A recommendation needs at least two scenarios to compare.',
    }
  }

  const criteria: RankedCriterion[] = []
  const keys = Array.from(new Set(candidates.flatMap((c) => c.metrics.map((m) => m.key))))

  for (const key of keys) {
    const direction = DIRECTION[key] ?? 'neutral'
    if (direction === 'neutral') continue
    const entries = candidates.map((c) => {
      const m = c.metrics.find((x) => x.key === key)
      return { id: c.id, metric: m, value: m?.available ? m.low : null }
    })
    // Every scenario, or the criterion does not vote.
    if (entries.some((e) => e.value == null)) continue

    const points: Record<string, number> = {}
    const values: Record<string, string> = {}
    for (const a of entries) {
      let beaten = 0
      for (const b of entries) {
        if (a.id === b.id) continue
        const better = direction === 'higher' ? a.value! > b.value! : a.value! < b.value!
        if (better) beaten += 1
      }
      points[a.id] = beaten
      values[a.id] = a.metric?.display ?? '—'
    }
    criteria.push({ key, label: LABEL[key] ?? key, direction, points, values })
  }

  // RISK DOES NOT VOTE HERE, AND IS NOT SHOWN HERE.
  //
  // The risk engine computes no score, no weight and no probability (see
  // app/tpo/risk.py) — it returns checks with a status. Turning those counts
  // into ranking points made Decision Center the one place in the app where
  // risk looked like a number that could be compared, which is precisely the
  // impression the engine refuses to give. The assessment stays where it is
  // produced and read: Simulation Studio's Risk & Governance panel, in full.
  // Candidates still CARRY their assessment — the decision record below the
  // board is assembled from it — but this page neither ranks nor prints it.

  const totals = candidates
    .map((c) => ({
      id: c.id,
      points: criteria.reduce((sum, criterion) => sum + (criterion.points[c.id] ?? 0), 0),
    }))
    .sort((a, b) => b.points - a.points)

  // WHAT IS ENOUGH TO RECOMMEND ON.
  //
  // Two scenarios can share a single metric and still be unrankable. The case
  // that forced this: with General Optimization on the board — which reports no
  // ROI, no margin and no incremental sales — the only figure all four
  // scenarios carried was TRADE SPEND, and ranking on that alone crowned the
  // cheapest scenario. "Spend the least" is not a promotion strategy, and a
  // recommendation resting on one cost metric is worse than no recommendation
  // because it looks like it weighed something.
  //
  // So a winner needs at least two criteria, one of which must be a metric
  // where MORE IS BETTER — something the promotion is meant to produce. Short
  // of that the page says what the scenarios have in common and stops.
  const valueCriteria = criteria.filter((c) => c.direction === 'higher')
  if (criteria.length < 2 || valueCriteria.length === 0) {
    const shared = criteria.map((c) => c.label.toLowerCase())
    return {
      rule: RANKING_RULE,
      criteria,
      totals,
      winnerId: null,
      blocked:
        criteria.length === 0
          ? 'These scenarios report no metric in common, so there is nothing to rank them on. ' +
            'The comparison above still shows what each module measured.'
          : `The only figure all these scenarios report is ${shared.join(' and ')}, which is not ` +
            'enough to choose between promotion strategies — a ranking on cost alone would just ' +
            'name the cheapest. Remove the scenario that reports the fewest metrics, or compare ' +
            'scenarios from modules that measure the same things.',
    }
  }
  const tied = totals.length > 1 && totals[0].points === totals[1].points
  if (!tied) {
    return { rule: RANKING_RULE, criteria, totals, winnerId: totals[0].id, blocked: null }
  }

  // A TIE IS BROKEN ON ROI, AND ONLY ON ROI.
  //
  // Two scenarios trading wins across the metrics finish level surprisingly
  // often — a deeper treatment buys incremental sales with trade spend, which
  // is the trade-off the whole studio exists to show. Leaving it there means
  // the page usually declines to recommend anything, which is not a decision
  // aid. ROI is the tie-break because it is the ONE metric this project sets a
  // target against (PROMOTION_TARGET_ROI in app/tpo/config.py), so
  // preferring the higher one is reusing a hurdle that already exists rather
  // than inventing a preference. It is stated in the rule above and shown as a
  // separate line in the result, never applied silently.
  const leaders = totals.filter((t) => t.points === totals[0].points).map((t) => t.id)
  const roiOf = (id: string) =>
    candidates.find((c) => c.id === id)?.metrics.find((m) => m.key === 'roi_multiple' && m.available)?.low ?? null
  const withRoi = leaders.map((id) => ({ id, roi: roiOf(id) })).filter((x) => x.roi != null) as {
    id: string
    roi: number
  }[]
  if (withRoi.length === leaders.length && leaders.length > 0) {
    const sortedByRoi = [...withRoi].sort((a, b) => b.roi - a.roi)
    if (sortedByRoi.length === 1 || sortedByRoi[0].roi > sortedByRoi[1].roi) {
      return {
        rule: RANKING_RULE,
        criteria,
        totals,
        winnerId: sortedByRoi[0].id,
        blocked: null,
        tieBreak: `Level on points; decided on ROI, the metric this project sets a target for.`,
      }
    }
  }
  return {
    rule: RANKING_RULE,
    criteria,
    totals,
    winnerId: null,
    blocked:
      'These scenarios finish level on points and ROI cannot separate them, so neither is put ' +
      'ahead of the other. The comparison above is the answer.',
  }
}

export interface WinnerCase {
  /** Where the winner leads, one line per comparison actually made. */
  strengths: string[]
  /** Where it does not. Printed with the strengths, not omitted. */
  caveats: string[]
}

/** "Why this plan is recommended", built from the comparison that produced it.
 *
 *  EVERY LINE IS A COMPARISON THAT WAS MADE, naming the other scenario and
 *  both engines' own figures. Nothing is templated from a phrase list, and the
 *  places the winner LOSES are collected the same way — a case for a decision
 *  that only lists its strengths is advocacy, not evidence.
 */
export function explainWinner(
  candidates: DecisionCandidate[],
  ranking: CandidateRanking,
): WinnerCase {
  const winner = candidates.find((c) => c.id === ranking.winnerId)
  if (!winner) return { strengths: [], caveats: [] }
  const others = candidates.filter((c) => c.id !== winner.id)
  const strengths: string[] = []
  const caveats: string[] = []

  /** A scenario reporting a RANGE was ranked at its low end, and a line that
   *  reads "39.6% vs 38.5% – 79.5%" without saying so looks like the wrong
   *  scenario won. The rule is printed above the result; this repeats it where
   *  the comparison actually happens. */
  const isBand = (candidateId: string, key: string) => {
    const m = candidates.find((c) => c.id === candidateId)?.metrics.find((x) => x.key === key)
    return Boolean(m && m.low != null && m.high != null && m.low !== m.high)
  }

  for (const criterion of ranking.criteria) {
    const mine = criterion.values[winner.id]
    for (const other of others) {
      const theirs = criterion.values[other.id]
      if (mine === undefined || theirs === undefined) continue
      const beat = (criterion.points[winner.id] ?? 0) > (criterion.points[other.id] ?? 0)
      const lost = (criterion.points[winner.id] ?? 0) < (criterion.points[other.id] ?? 0)
      if (!beat && !lost) continue
      const atLowEnd =
        isBand(winner.id, criterion.key) || isBand(other.id, criterion.key)
          ? ', comparing ranges at their low end'
          : ''
      const word = beat
        ? criterion.direction === 'higher' ? 'Higher' : 'Lower'
        : criterion.direction === 'higher' ? 'Lower' : 'Higher'
      const line = `${word} ${criterion.label} than ${other.name} — ${mine} vs ${theirs}${atLowEnd}.`
      ;(beat ? strengths : caveats).push(line)
    }
  }
  return { strengths, caveats }
}

/** The best and worst value on one metric row, for highlighting.
 *
 *  Only when the metric has a direction and more than one scenario reports it,
 *  and never when every value is identical — marking a "best" among equals is
 *  a distinction the numbers do not make.
 */
export function bestWorst(
  candidates: DecisionCandidate[],
  key: string,
): { bestId: string | null; worstId: string | null } {
  const direction = DIRECTION[key] ?? 'neutral'
  if (direction === 'neutral') return { bestId: null, worstId: null }
  const entries = candidates
    .map((c) => ({ id: c.id, value: c.metrics.find((m) => m.key === key && m.available)?.low ?? null }))
    .filter((e) => e.value != null) as { id: string; value: number }[]
  if (entries.length < 2) return { bestId: null, worstId: null }
  const values = entries.map((e) => e.value)
  if (Math.max(...values) === Math.min(...values)) return { bestId: null, worstId: null }
  const sorted = [...entries].sort((a, b) => (direction === 'higher' ? b.value - a.value : a.value - b.value))
  return { bestId: sorted[0].id, worstId: sorted[sorted.length - 1].id }
}
