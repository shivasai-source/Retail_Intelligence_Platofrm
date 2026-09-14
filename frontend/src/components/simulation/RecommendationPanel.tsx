import { Icon } from '../../icons'
import { InfoPopover } from '../ui'
import type {
  DecisionStep,
  EligibleScenario,
  Evidence,
  EvidenceMetric,
  Recommendation,
} from '../../types/recommendation'

/** The recommendation — B4.3 engine, B4.4 presentation.
 *
 *  Four states, each with its own honest wording: a scenario is recommended,
 *  the Current Plan is retained, the policy could not separate the leaders, or
 *  there is not enough data to decide.
 *
 *  IT IS ALWAYS "UNDER THE CURRENT DECISION POLICY". That phrase sits in the
 *  header, not buried in a tooltip, because a recommendation produced by one
 *  policy is not a statement that the scenario is universally best — swap the
 *  policy and a different scenario wins. The panel is written so a reader
 *  cannot take the stronger claim from it.
 *
 *  WHY IT WON IS SHOWN, NOT HIDDEN. The engine returns the decision path it
 *  actually walked; this renders it, criterion by criterion, with the readings
 *  that separated the candidates. A business user should be able to see the
 *  rule and the numbers that applied it without reading any code.
 *
 *  WHAT THIS PANEL DELIBERATELY IS NOT. No ranked list, no 1st/2nd/3rd, no
 *  score. The engine produces none of those. Scenarios appear in the order the
 *  engine returned them; nothing here sorts, and nothing recomputes — every
 *  number displayed is read off the recommendation payload.
 */
export function RecommendationPanel({ recommendation }: { recommendation: Recommendation }) {
  const { status } = recommendation
  const winner = recommendation.eligible_scenarios.find(
    (s) => s.scenario_id === recommendation.recommended_scenario_id,
  )
  const alsoConsidered = recommendation.eligible_scenarios.filter(
    (s) => s.scenario_id !== recommendation.recommended_scenario_id,
  )

  return (
    <div>
      <div className="flex flex-wrap items-start justify-between gap-2 border-b border-border-subtle px-5 py-4">
        <div>
          <div className="flex items-center gap-2">
            <h3 className="text-md font-bold">Recommendation</h3>
            <StatusPill status={status} />
          </div>
          {/* The qualifier is permanent furniture, not a tooltip. */}
          <div className="mt-0.5 text-sm text-ink-muted">
            Under the current decision policy
          </div>
        </div>
        <PolicyPopover recommendation={recommendation} />
      </div>

      <div className="px-5 py-4">
        {status === 'recommended' && winner ? (
          <RecommendedScenario scenario={winner} reason={recommendation.reason} />
        ) : (
          <div className="max-w-[640px] text-base leading-[1.6] text-ink-secondary">
            {status === 'maintain_current_plan' && (
              <>
                <div className="text-base font-bold text-ink-primary">Maintain Current Plan</div>
                <div className="mt-1.5">{recommendation.reason}</div>
                {recommendation.evidence.current_plan && (
                  <EvidenceGrid evidence={recommendation.evidence.current_plan} className="mt-3" />
                )}
              </>
            )}
            {status === 'no_clear_winner' && (
              <>
                <div className="text-base font-bold text-ink-primary">No clear winner</div>
                <div className="mt-1.5">{recommendation.reason}</div>
              </>
            )}
            {status === 'insufficient_data' && (
              <>
                <div className="text-base font-bold text-ink-primary">Not enough data to decide</div>
                <div className="mt-1.5">{recommendation.reason}</div>
                {recommendation.missing && recommendation.missing.length > 0 && (
                  <ul className="mt-2 list-disc pl-5">
                    {recommendation.missing.map((item) => (
                      <li key={item}>{item}</li>
                    ))}
                  </ul>
                )}
              </>
            )}
          </div>
        )}

        {recommendation.decision_path.length > 0 && (
          <DecisionPath recommendation={recommendation} />
        )}

        {alsoConsidered.length > 0 && (
          <Section label="Also considered">
            {alsoConsidered.map((scenario) => (
              <div key={scenario.scenario_id} className="text-sm leading-[1.5] text-ink-muted">
                <span className="font-semibold text-ink-secondary">{scenario.name}</span>
                {scenario.treatment && ` · ${scenario.treatment} at ${scenario.discount_pct}%`} —{' '}
                {describe(scenario)}
              </div>
            ))}
          </Section>
        )}

        {recommendation.excluded_scenarios.length > 0 && (
          <Section label="Not considered">
            {recommendation.excluded_scenarios.map((s) => (
              <div key={s.scenario_id} className="text-sm leading-[1.45] text-ink-muted">
                <span className="font-semibold text-ink-secondary">{s.name}</span> — {s.reason}
              </div>
            ))}
          </Section>
        )}
      </div>
    </div>
  )
}

/** The eligible-but-not-selected scenarios, described by the conservative
 *  figures the policy actually read. No ordinal, no "runner-up". */
function describe(scenario: EligibleScenario): string {
  const sales = scenario.evidence.incremental_sales
  const roi = scenario.evidence.roi_multiple
  const parts: string[] = []
  if (sales?.available) parts.push(`incremental sales from ${sales.display_low}`)
  if (roi?.available) parts.push(`ROI from ${roi.display_low}`)
  return parts.length ? `eligible, ${parts.join(', ')} at the low end.` : 'eligible.'
}

/** HOW THE POLICY DECIDED — the engine's own decision path, rendered.
 *
 *  Each rung shows the criterion, what happened, and the readings the policy
 *  compared. Readings appear in the engine's order and carry the engine's own
 *  display values; nothing here sorts them, which would turn an explanation
 *  into a ranking.
 */
function DecisionPath({ recommendation }: { recommendation: Recommendation }) {
  const names = new Map(recommendation.eligible_scenarios.map((s) => [s.scenario_id, s.name]))

  /** The engine's formatted figure for one scenario on one criterion, so the
   *  path shows "₹9.0 Cr" rather than a raw float. Falls back to the raw
   *  reading only if the metric is not among the evidence. */
  const display = (step: DecisionStep, scenarioId: string, raw: number | null): string => {
    const scenario = recommendation.eligible_scenarios.find((s) => s.scenario_id === scenarioId)
    const metric = scenario?.evidence[step.criterion as keyof Evidence] as EvidenceMetric | undefined
    const value = step.endpoint === 'high' ? metric?.display_high : metric?.display_low
    return value ?? (raw === null ? '—' : String(raw))
  }

  return (
    <Section label="How this was decided">
      <div className="flex flex-col gap-2">
        {recommendation.decision_path.map((step, index) => (
          <div key={`${step.criterion}-${index}`} className="text-sm leading-[1.5]">
            <div className="flex flex-wrap items-baseline gap-x-2">
              <span className="font-semibold text-ink-secondary">
                {step.role === 'primary' ? 'Primary' : 'Tie-breaker'}:{' '}
                {step.criterion.replace(/_/g, ' ')} at the {step.endpoint} end
              </span>
              <Outcome step={step} />
            </div>
            {step.detail && <div className="mt-0.5 text-ink-muted">{step.detail}</div>}
            <div className="mt-0.5 flex flex-wrap gap-x-4 gap-y-0.5 text-ink-muted">
              {Object.entries(step.readings).map(([scenarioId, raw]) => (
                <span key={scenarioId} className="[font-variant-numeric:tabular-nums]">
                  {names.get(scenarioId) ?? scenarioId}: {display(step, scenarioId, raw)}
                  {step.leaders?.includes(scenarioId) && step.outcome === 'separated' && (
                    <span className="ml-1 text-status-success">✓</span>
                  )}
                </span>
              ))}
            </div>
          </div>
        ))}
      </div>
    </Section>
  )
}

function Outcome({ step }: { step: DecisionStep }) {
  const label = {
    separated: 'separated the candidates',
    tied: 'could not separate them',
    skipped: 'skipped',
  }[step.outcome]
  return <span className="text-xs uppercase tracking-[0.04em] text-ink-muted">{label}</span>
}

function Section({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="mt-4 border-t border-border-subtle pt-3">
      <div className="text-xs font-semibold uppercase tracking-[0.04em] text-ink-muted">
        {label}
      </div>
      <div className="mt-1.5 flex flex-col gap-1">{children}</div>
    </div>
  )
}

function RecommendedScenario({ scenario, reason }: { scenario: EligibleScenario; reason: string }) {
  return (
    <div>
      <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
        <span className="text-base font-bold text-ink-primary">{scenario.name}</span>
        <span className="text-sm text-ink-secondary">
          {scenario.treatment} · {scenario.discount_pct}% discount
        </span>
        {scenario.uplift && (
          <span className="text-sm text-ink-muted">
            Approved uplift range {(scenario.uplift.low * 100).toFixed(0)}–
            {(scenario.uplift.high * 100).toFixed(0)}%
          </span>
        )}
      </div>

      <div className="mt-3 grid grid-cols-2 gap-3 @max-[700px]:grid-cols-1">
        <Conservative
          label="Conservative Incremental Sales"
          metric={scenario.evidence.incremental_sales}
        />
        <Conservative label="Conservative ROI" metric={scenario.evidence.roi_multiple} />
      </div>

      <div className="mt-3 max-w-[640px] text-base leading-[1.6] text-ink-secondary">{reason}</div>

      <EvidenceGrid evidence={scenario.evidence} className="mt-3" />
    </div>
  )
}

/** The low end, named as such. The high end sits beside it as context and
 *  decided nothing. */
function Conservative({ label, metric }: { label: string; metric: EvidenceMetric | undefined }) {
  return (
    <div className="rounded-[var(--r-md)] border border-border-subtle bg-surface-muted p-3">
      <div className="text-xs font-semibold uppercase tracking-[0.04em] text-ink-muted">
        {label}
      </div>
      {metric?.available ? (
        <>
          <div className="mt-1 text-lg font-extrabold text-ink-primary [font-variant-numeric:tabular-nums]">
            {metric.display_low}
          </div>
          <div className="mt-0.5 text-xs text-ink-muted">
            low end · {metric.display_high} at the high end
          </div>
        </>
      ) : (
        <div className="mt-1 text-sm text-ink-muted">{metric?.unavailable_reason ?? '—'}</div>
      )}
    </div>
  )
}

/** Supporting evidence. Trade Spend and Cannibalization appear here because
 *  the policy exposes them, NOT because they decided anything. */
function EvidenceGrid({ evidence, className = '' }: { evidence: Evidence; className?: string }) {
  const rows: [string, keyof Evidence][] = [
    ['Trade Spend', 'trade_spend'],
    ['Incremental Units', 'incremental_units'],
    ['Margin', 'margin_percent'],
    ['PEI', 'pei'],
    ['Cannibalization', 'cannibalization'],
  ]
  return (
    <div className={`flex flex-wrap gap-x-6 gap-y-2 ${className}`}>
      {rows.map(([label, key]) => {
        const metric = evidence[key]
        return (
          <div key={key} className="text-xs">
            <span className="font-semibold text-ink-muted">{label}: </span>
            {metric?.available ? (
              <span className="text-ink-primary [font-variant-numeric:tabular-nums]">
                {metric.display_low === metric.display_high
                  ? metric.display_low
                  : `${metric.display_low} – ${metric.display_high}`}
              </span>
            ) : (
              <span className="inline-flex items-center gap-1 text-ink-muted">
                —
                {metric?.unavailable_reason && (
                  <InfoPopover label={`Why ${label} is unavailable`} title={label} width={264}>
                    <div className="mt-1 text-sm leading-[1.5] text-ink-secondary">
                      {metric.unavailable_reason}
                    </div>
                  </InfoPopover>
                )}
              </span>
            )}
          </div>
        )
      })}
    </div>
  )
}

function StatusPill({ status }: { status: Recommendation['status'] }) {
  const label = {
    recommended: 'Recommended',
    maintain_current_plan: 'Maintain current plan',
    no_clear_winner: 'No clear winner',
    insufficient_data: 'Insufficient data',
  }[status]
  const tone =
    status === 'recommended'
      ? 'bg-status-success-bg text-status-success'
      : 'bg-surface-muted text-ink-muted'
  return (
    <span
      className={`inline-flex items-center rounded-[4px] px-2 py-[3px] text-2xs font-extrabold uppercase tracking-[0.04em] ${tone}`}
    >
      {label}
    </span>
  )
}

/** The rule that produced the answer, in full. */
function PolicyPopover({ recommendation }: { recommendation: Recommendation }) {
  const { policy } = recommendation
  return (
    <span className="inline-flex items-center gap-1 text-xs text-ink-muted">
      <Icon name="info" className="h-3 w-3" />
      Why this policy?
      <InfoPopover label="The decision policy" title="Decision policy" width={320}>
        <div className="mt-1 space-y-1.5 text-sm leading-[1.5] text-ink-secondary">
          <div>{policy.objective}</div>
          <div>
            <span className="font-semibold text-ink-primary">Constraint:</span>{' '}
            {policy.economic_constraint.note}
          </div>
          <div>
            <span className="font-semibold text-ink-primary">Primary:</span>{' '}
            {policy.primary_metric.replace(/_/g, ' ')} at the {policy.primary_endpoint} end.
          </div>
          <div>
            <span className="font-semibold text-ink-primary">Tie-breakers:</span>{' '}
            {policy.hierarchy
              .filter((c) => c.role === 'tie_breaker')
              .map((c) => c.metric.replace(/_/g, ' '))
              .join(' → ')}
          </div>
          <div className="text-ink-muted">{policy.range_policy}</div>
          <div className="text-ink-muted">{recommendation.provenance.method}</div>
          <div className="text-ink-muted">
            A different policy could select a different scenario. This is a preference under the rule
            above, not a statement that the scenario is best in every respect.
          </div>
        </div>
      </InfoPopover>
    </span>
  )
}
