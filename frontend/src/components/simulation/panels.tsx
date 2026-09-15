import { Icon } from '../../icons'
import { InfoPopover, Table, Th, Td } from '../ui'
import type { SimulationKpi, SimulationKpiKey, SimulationRunResponse } from '../../types/simulation'

const events = (n: number) => `${n.toLocaleString()} comparable event${n === 1 ? '' : 's'}`

/** Whether a cannibalization cell has a figure to show in place of the gap.
 *
 *  When it does, the engine's long "no comparable promotion event…" sentence
 *  is left to the tooltip: the line that replaces it already says the rate
 *  could not be measured HERE by naming the scope where it could, and printing
 *  both put a paragraph of prose above a one-line answer. */
export function hasCannibalizationFallback(kpi: SimulationKpi, measured?: SimulationKpi | null) {
  return Boolean(kpi.measured_at || measured?.available || measured?.measured_at)
}

/** THE EVIDENCE BEHIND A CANNIBALIZATION RATE.
 *
 *  A rate is a share of promotion events, and how many stood behind it decides
 *  whether it means anything — so the count travels with the number rather
 *  than hiding in a payload.
 *
 *  WHEN THE SELECTION CANNOT SUPPORT ONE, the backend offers the narrowest
 *  WIDER scope that can (see service.cannibalization_resolution). That figure
 *  is real and engine-produced, but it is NOT this selection's, so it is
 *  always printed with the scope it belongs to. Never render `value` from it.
 *
 *  `measured` is the MEASURED cannibalization KPI, passed in by a scenario
 *  column. A scenario never resolves a wider scope of its own — widening would
 *  hand it a different population to re-base, which Phase A does not model —
 *  so a scenario cell points at what was measured instead.
 */
export function CannibalizationEvidence({
  kpi,
  measured,
}: {
  kpi: SimulationKpi
  measured?: SimulationKpi | null
}) {
  if (kpi.available) {
    if (kpi.comparable_events == null) return null
    return (
      <div className="mt-0.5 text-xs leading-[1.4] text-ink-muted">
        {events(kpi.comparable_events)}
      </div>
    )
  }

  // Its own resolved scope (the measured column), or the measured figure a
  // scenario column defers to.
  const own = kpi.measured_at
  if (own) {
    return (
      <div className="mt-1 max-w-[280px] text-xs leading-[1.45] text-ink-muted">
        <span className="font-bold text-ink-secondary">{own.display_value}</span> across{' '}
        {own.scope_label} · {events(own.comparable_events)}
      </div>
    )
  }
  if (!measured) return null
  if (measured.available) {
    return (
      <div className="mt-1 max-w-[280px] text-xs leading-[1.45] text-ink-muted">
        Measured for this selection:{' '}
        <span className="font-bold text-ink-secondary">{measured.display_value}</span>
        {measured.comparable_events != null && ` · ${events(measured.comparable_events)}`}
      </div>
    )
  }
  const wider = measured.measured_at
  if (!wider) return null
  return (
    <div className="mt-1 max-w-[280px] text-xs leading-[1.45] text-ink-muted">
      Measured across {wider.scope_label}:{' '}
      <span className="font-bold text-ink-secondary">{wider.display_value}</span> ·{' '}
      {events(wider.comparable_events)}
    </div>
  )
}

/** The order the seven figures are read in: what was invested, what it moved,
 *  what it returned, what it cost elsewhere. */
const KPI_ORDER: SimulationKpiKey[] = [
  'trade_spend',
  'incremental_units',
  'incremental_sales',
  'roi_multiple',
  'margin_percent',
  'cannibalization',
  'pei',
]

/** Projected Business Impact, Phase A: the scope's MEASURED performance.
 *
 *  Every row is a value the validated KPI engine produced — the same number
 *  the Insights Hub's card shows for the same selection. A KPI the selection
 *  cannot support renders its reason, never a zero.
 *
 *  There is one column because there is one result. A second column would have
 *  to differ from the first, and nothing in Phase A can make it differ
 *  honestly: the levers are not modelled yet, so two scenarios over the same
 *  scope are the same measurement twice.
 */
export function KpiTable({ kpis, targetRoi }: { kpis: Record<SimulationKpiKey, SimulationKpi>; targetRoi: number }) {
  return (
    <Table>
      <thead>
        <tr>
          <Th>Metric</Th>
          <Th className="text-right">Measured</Th>
        </tr>
      </thead>
      <tbody>
        {KPI_ORDER.map((key) => {
          const kpi = kpis[key]
          if (!kpi) return null
          return (
            <tr key={key}>
              <Td>
                <div className="flex items-center gap-1.5">
                  <span>{kpi.label}</span>
                  <InfoPopover label={`About ${kpi.label}`} title={kpi.label}>
                    <div className="text-base leading-[1.55] text-ink-secondary">
                      <div className="font-semibold text-ink-primary">Formula</div>
                      <div className="mt-0.5">{kpi.formula}</div>
                      {key === 'roi_multiple' && (
                        <div className="mt-2 text-ink-muted">Target: {targetRoi.toFixed(2)}</div>
                      )}
                    </div>
                  </InfoPopover>
                </div>
              </Td>
              <Td className="text-right">
                {kpi.available ? (
                  <span className="text-md font-bold text-ink-primary [font-variant-numeric:tabular-nums]">
                    {kpi.display_value}
                  </span>
                ) : (
                  <span
                    className="cursor-help text-base text-ink-muted"
                    title={kpi.unavailable_reason ?? undefined}
                  >
                    —
                  </span>
                )}
                {!kpi.available && kpi.unavailable_reason && !hasCannibalizationFallback(kpi) && (
                  <div className="mt-0.5 max-w-[320px] text-xs leading-[1.45] text-ink-muted">
                    {kpi.unavailable_reason}
                  </div>
                )}
                {key === 'cannibalization' && <CannibalizationEvidence kpi={kpi} />}
              </Td>
            </tr>
          )
        })}
      </tbody>
    </Table>
  )
}

/** What was actually measured — the scope the numbers above describe.
 *
 *  Replaces the promotion/period dropdowns, which were hardcoded strings that
 *  changed nothing when selected. Scope comes from the Insights Hub's filter
 *  selection, and this panel reports what the backend resolved it to.
 */
export function ScopeSummary({ scope }: { scope: SimulationRunResponse['scope'] }) {
  const applied = Object.entries(scope.filters_applied).filter(([key]) => key !== 'year' && key !== 'month')

  return (
    <div className="flex flex-col gap-2.5">
      <Row label="Period" value={scope.period} />
      <Row label="Rows in scope" value={scope.row_count.toLocaleString()} />
      <Row label="Promoted rows" value={scope.promoted_row_count.toLocaleString()} />
      <Row label="Weeks with promotions" value={String(scope.promoted_weeks)} />
      <div className="border-t border-border-subtle pt-2.5">
        <div className="text-xs font-semibold text-ink-muted">Filters applied</div>
        {applied.length === 0 ? (
          <div className="mt-1 text-sm text-ink-secondary">None — the full dataset for this period.</div>
        ) : (
          <div className="mt-1.5 flex flex-wrap gap-1.5">
            {applied.map(([key, value]) => (
              <span
                key={key}
                className="rounded-[var(--r-pill)] bg-surface-muted px-2 py-1 text-xs font-medium text-ink-secondary"
              >
                {key}: {Array.isArray(value) ? value.join(', ') : String(value)}
              </span>
            ))}
          </div>
        )}
      </div>
    </div>
  )
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-baseline justify-between gap-3">
      <span className="text-xs font-semibold text-ink-muted">{label}</span>
      <span className="text-base font-bold text-ink-primary [font-variant-numeric:tabular-nums]">{value}</span>
    </div>
  )
}

/** The empty-scope case: a real state, not a permanent spinner and not a
 *  screen full of zeroes. */
export function NoDataPanel() {
  return (
    <div className="grid min-h-[160px] place-items-center px-6 py-7 text-center">
      <div>
        <div className="mx-auto mb-3 grid h-10 w-10 place-items-center rounded-full bg-surface-muted text-ink-muted [&_svg]:h-5 [&_svg]:w-5">
          <Icon name="info" />
        </div>
        <div className="text-base font-bold text-ink-primary">No rows in this scope</div>
        <div className="mt-1 text-base text-ink-secondary">
          The current filter selection matches no sales rows, so there is nothing to measure. Widen the
          selection in the Insights Hub.
        </div>
      </div>
    </div>
  )
}
