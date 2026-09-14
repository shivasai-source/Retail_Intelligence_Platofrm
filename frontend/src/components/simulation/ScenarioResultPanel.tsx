import { Icon } from '../../icons'
import { InfoPopover, Table, Th, Td } from '../ui'
import { CannibalizationEvidence, hasCannibalizationFallback } from './panels'
import type { SimulateResponse, SimulationKpi, SimulationKpiKey } from '../../types/simulation'
import type { WeeklyWeek } from '../../types/weekly'

const KPI_ORDER: SimulationKpiKey[] = [
  'trade_spend',
  'incremental_units',
  'incremental_sales',
  'roi_multiple',
  'margin_percent',
  'cannibalization',
  'pei',
]

/** A simulated scenario's result — the APPROVED UPLIFT RANGE.
 *
 *  Two columns, low and high, because the approved rule for a treatment is a
 *  band and not a point. NOTHING HERE COLLAPSES THEM INTO A MIDPOINT: PR002 is
 *  approved for 25–35% uplift, not 30%, and printing a single ROI would
 *  manufacture a precision the rule does not grant.
 *
 *  The range is NOT a confidence or prediction interval. The bands are the
 *  project's approved promotion rules — generator design parameters verified
 *  against the dataset — not uncertainty estimated from variation. The header
 *  says so and the provenance popover repeats it.
 */
export function ScenarioResultPanel({
  simulation,
  measuredCannibalization,
  perWeek,
}: {
  simulation: SimulateResponse
  /** THE SAME SCENARIO, READ PER BUSINESS WEEK.
   *
   *  Present only when the scenario's duration lever is set to the weekly
   *  cadence. These are the weeks `/api/simulation/weekly` returned — the
   *  SAME counterfactual this result came from, sliced by
   *  app/tpo/weekly.py, which states of itself that it "slices; it does not
   *  model". Nothing is divided, averaged or scaled here: the envelope is
   *  the lowest and highest figures the engine produced across those weeks,
   *  and both endpoints are engine-formatted strings this component never
   *  computes. A one-week scope collapses the envelope onto that week,
   *  which is why weekly and monthly read alike for a promotion that traded
   *  once. */
  perWeek?: WeeklyWeek[] | null
  /** The MEASURED cannibalization figure for this scope, which the scenario's
   *  own cells defer to when the scenario cannot report one. A scenario never
   *  widens its scope to find a rate: the widening would give it rows the user
   *  did not select to re-base, and Phase A models no response over those. */
  measuredCannibalization?: SimulationKpi | null
}) {
  const { low, high } = simulation.result
  const weeks = perWeek ?? []

  return (
    <div>
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-border-subtle px-5 py-3">
        <div className="flex items-center gap-2">
          <span className="rounded-[4px] bg-status-success-bg px-2 py-[3px] text-2xs font-extrabold uppercase tracking-[0.04em] text-status-success">
            Simulated
          </span>
          <span className="text-sm text-ink-secondary">
            {simulation.treatment} · {simulation.discount_pct}% discount
          </span>
          {weeks.length > 0 && (
            <span className="rounded-[4px] bg-brand-violet-50 px-2 py-[3px] text-2xs font-extrabold uppercase tracking-[0.04em] text-brand-violet">
              Per week · {weeks.length} in scope
            </span>
          )}
        </div>
        <div className="flex items-center gap-1 text-sm text-ink-muted">
          <span>
            {simulation.range_label}: {(simulation.uplift.low * 100).toFixed(0)}–
            {(simulation.uplift.high * 100).toFixed(0)}% uplift
          </span>
          <ProvenancePopover simulation={simulation} />
        </div>
      </div>

      <div className="overflow-x-auto">
        <Table>
          <thead>
            <tr>
              <Th>Metric</Th>
              <Th className="text-right">
                Low
                <div className="text-2xs font-normal normal-case text-ink-muted">
                  {(low.uplift * 100).toFixed(0)}% uplift
                </div>
              </Th>
              <Th className="text-right">
                High
                <div className="text-2xs font-normal normal-case text-ink-muted">
                  {(high.uplift * 100).toFixed(0)}% uplift
                </div>
              </Th>
            </tr>
          </thead>
          <tbody>
            {KPI_ORDER.map((key) => {
              const envelope = weeks.length > 0 ? weeklyEnvelope(weeks, key) : null
              // The metric's identity (label, formula, note) always comes from
              // the aggregate cell; only the FIGURES change to the weekly ones.
              const l = envelope ? { ...low.kpis[key], ...envelope.low } : low.kpis[key]
              const h = envelope ? { ...high.kpis[key], ...envelope.high } : high.kpis[key]
              if (!l) return null
              return (
                <tr key={key}>
                  <Td>
                    <div className="flex items-center gap-1.5">
                      <span>{l.label}</span>
                      <InfoPopover label={`About ${l.label}`} title={l.label} width={280}>
                        <div className="mt-1 text-sm leading-[1.5] text-ink-secondary">
                          <div className="font-semibold text-ink-primary">Formula</div>
                          <div className="mt-0.5">{l.formula}</div>
                          {l.note && <div className="mt-2 text-ink-muted">{l.note}</div>}
                        </div>
                      </InfoPopover>
                    </div>
                  </Td>
                  <Value kpi={l} measured={key === 'cannibalization' ? measuredCannibalization : null} />
                  <Value kpi={h} measured={key === 'cannibalization' ? measuredCannibalization : null} />
                </tr>
              )
            })}
          </tbody>
        </Table>
      </div>

      {weeks.length === 1 && (
        <div className="border-t border-border-subtle px-5 py-2.5 text-xs leading-[1.45] text-ink-muted">
          This promotion traded in one business week ({weeks[0].week_label}) within the selected scope, so
          the weekly and monthly views describe the same population and report the same figures.
        </div>
      )}

      {simulation.scope.excluded_rows > 0 && (
        <div className="border-t border-border-subtle px-5 py-2.5 text-xs leading-[1.45] text-ink-muted">
          {simulation.scope.excluded_rows.toLocaleString()} rows excluded — {simulation.scope.excluded_reason}
        </div>
      )}
    </div>
  )
}

/** The lowest and highest the engine reported for one metric across the
 *  scope's weeks.
 *
 *  MIN AND MAX OF MEASURED VALUES, NOT AN AVERAGE. Trade Spend and
 *  Incremental Sales are extensive and their weekly values sum to the
 *  aggregate; ROI and Margin are ratios that app/tpo/weekly.py computes per
 *  week from that week's own components and explicitly refuses to average.
 *  Taking the extremes respects both: it reports a span of figures the
 *  engine actually produced rather than deriving a new one. `display_value`
 *  travels with the chosen cell, so no number is formatted here.
 */
function weeklyEnvelope(
  weeks: WeeklyWeek[],
  key: SimulationKpiKey,
): { low: Partial<SimulationKpi>; high: Partial<SimulationKpi> } | null {
  const lows = weeks.map((w) => w.low[key as keyof typeof w.low]).filter((c) => c?.available)
  const highs = weeks.map((w) => w.high[key as keyof typeof w.high]).filter((c) => c?.available)
  if (!lows.length || !highs.length) return null
  const min = lows.reduce((a, b) => ((b.value ?? 0) < (a.value ?? 0) ? b : a))
  const max = highs.reduce((a, b) => ((b.value ?? 0) > (a.value ?? 0) ? b : a))
  return {
    low: { value: min.value, display_value: min.display_value, available: true, unavailable_reason: null },
    high: { value: max.value, display_value: max.display_value, available: true, unavailable_reason: null },
  }
}

function Value({
  kpi,
  measured,
}: {
  kpi: SimulateResponse['result']['low']['kpis'][SimulationKpiKey]
  measured?: SimulationKpi | null
}) {
  const isCannibalization = kpi.key === 'cannibalization'
  // The engine's reason stays reachable on the dash even when the cell shows a
  // resolved figure instead of printing it.
  const deferred = isCannibalization && hasCannibalizationFallback(kpi, measured)
  return (
    <Td className="text-right align-top">
      {kpi.available ? (
        <span className="text-base font-bold text-ink-primary [font-variant-numeric:tabular-nums]">
          {kpi.display_value}
        </span>
      ) : (
        <>
          <span className="cursor-help text-base text-ink-muted" title={kpi.unavailable_reason ?? undefined}>
            —
          </span>
          {kpi.unavailable_reason && !deferred && (
            <div className="mt-0.5 max-w-[260px] text-xs leading-[1.4] text-ink-muted">
              {kpi.unavailable_reason}
            </div>
          )}
        </>
      )}
      {isCannibalization && <CannibalizationEvidence kpi={kpi} measured={measured} />}
    </Td>
  )
}

/** Where the numbers came from. A popover rather than a panel — the detail
 *  matters, but not enough to sit permanently on the page. */
function ProvenancePopover({ simulation }: { simulation: SimulateResponse }) {
  const p = simulation.provenance
  return (
    <InfoPopover label="Where this result came from" title="Result provenance" width={300}>
      <div className="mt-1 space-y-1.5 text-sm leading-[1.5] text-ink-secondary">
        <div>
          <span className="font-semibold text-ink-primary">Rule:</span> {p.response_rule}
        </div>
        <div>
          <span className="font-semibold text-ink-primary">Treatment:</span> {p.treatment} at{' '}
          {p.discount_pct}%, approved uplift {(p.uplift_low * 100).toFixed(0)}–
          {(p.uplift_high * 100).toFixed(0)}%
        </div>
        <div>
          <span className="font-semibold text-ink-primary">KPI engine:</span> {p.kpi_engine}
        </div>
        <div className="text-ink-muted">{p.method}</div>
        <div className="text-ink-muted">
          Break-even uplift {(simulation.breakeven_uplift * 100).toFixed(1)}% — the approved band clears it
          by {(simulation.headroom.low * 100).toFixed(1)}pp at its floor.
        </div>
      </div>
    </InfoPopover>
  )
}

/** What a scenario shows before it has been run: the reason it has no result,
 *  never a zeroed KPI table. */
export function NotSimulatedPanel({ reason, error }: { reason: string | null; error: string | null }) {
  return (
    <div className="grid min-h-[180px] place-items-center px-6 py-7 text-center">
      <div className="max-w-[440px]">
        <div
          className={`mx-auto mb-3 grid h-10 w-10 place-items-center rounded-full [&_svg]:h-5 [&_svg]:w-5 ${
            error ? 'bg-status-danger-bg text-status-danger' : 'bg-surface-muted text-ink-muted'
          }`}
        >
          <Icon name={error ? 'warning' : 'flow'} />
        </div>
        {error ? (
          <>
            <div className="text-base font-bold text-ink-primary">Simulation failed</div>
            <div className="mt-1.5 break-words text-base leading-[1.55] text-ink-secondary">{error}</div>
            <div className="mt-3 text-sm text-ink-muted">
              The scenario is unchanged. Adjust the treatment and run again.
            </div>
          </>
        ) : (
          <>
            <div className="text-base font-bold text-ink-primary">Not simulated</div>
            <div className="mt-1.5 text-base leading-[1.55] text-ink-secondary">{reason}</div>
            <div className="mt-3 text-sm text-ink-muted">
              Pick an approved treatment and run the scenario to see its result.
            </div>
          </>
        )}
      </div>
    </div>
  )
}
