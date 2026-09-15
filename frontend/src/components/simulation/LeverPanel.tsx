import { Icon } from '../../icons'
import { Button, InfoPopover } from '../ui'
import type { LeverDefinition, LeverValues, SimulateResponse } from '../../types/simulation'

/** The TPO levers, for ONE scenario.
 *
 *  DISCOUNT IS A SLIDER THAT CANNOT LEAVE THE APPROVED SET. Only five
 *  promotion treatments are approved — 5, 10, 15, 20 and 25 percent — and the
 *  backend rejects anything else rather than rounding or interpolating. The
 *  slider therefore travels over the APPROVED POINTS THEMSELVES rather than
 *  over a numeric range, so there is no handle position that means 7% or 12%.
 *  The list arrives from the API; the frontend keeps no copy of the rules.
 *
 *  0% IS A STOP, AND IT IS NOT A TREATMENT. It sits at the head of the slider
 *  because "run no promotion" is a question people genuinely ask, and a
 *  control that silently omits it reads as an oversight rather than as an
 *  answer. It is NOT an approved treatment: `response.get_treatment_response`
 *  admits five depths and 0 is not among them, so no approved uplift band
 *  exists for it and this project cannot say what it would earn. Selecting it
 *  therefore shows that reason and leaves Run disabled, which is what the
 *  existing `approvedSelected` gate in pages/Simulation.tsx already does
 *  without modification. Manufacturing a zero-discount response to make the
 *  button light up is exactly the invention this module refuses.
 *
 *  TRADE SPEND IS NOT EDITABLE. In the approved economics it is b(1+u)P(d+c) —
 *  an output of the treatment. The Current Plan shows the MEASURED spend for
 *  its scope; a hypothetical shows the range its treatment derives, once run.
 *  Neither is typed in, and neither is computed here.
 *
 *  DURATION IS SELECTABLE AND STILL NOT MODELLED, and the control says so.
 *  Weekly and monthly are the two cadences this project plans in, so a
 *  scenario can record which one it means and carry it to the API — which
 *  echoes it. No approved rule maps weeks to uplift, so the KPIs do not move,
 *  and a control that quietly implied otherwise would be the invention this
 *  module exists to refuse. The badge and the note are load-bearing.
 *
 *  READ-ONLY FOR THE CURRENT PLAN. Its levers are what the data says happened;
 *  editing them would quietly turn a measurement into a hypothesis.
 */
export function LeverPanel({
  definitions,
  values,
  readOnly,
  note,
  canRun,
  runLabel,
  running,
  simulation,
  onSelectDiscount,
  onSelectDuration,
  onReset,
  onRun,
  dirty,
}: {
  definitions: LeverDefinition[]
  values: LeverValues
  /** True for the measured Current Plan. */
  readOnly: boolean
  note: string
  canRun: boolean
  runLabel: string
  running: boolean
  /** The executed result, when this scenario has one — the source of the
   *  derived Trade Spend. */
  simulation: SimulateResponse | null
  onSelectDiscount: (discountPct: number) => void
  onSelectDuration: (durationWeeks: number) => void
  onReset: () => void
  onRun: () => void
  dirty: boolean
}) {
  const discount = definitions.find((d) => d.key === 'discount_pct')
  const duration = definitions.find((d) => d.key === 'duration_weeks')
  const spend = definitions.find((d) => d.key === 'spend_amount')
  const selected = values.discount_pct ?? null

  return (
    <div>
      {!readOnly && (
        <button
          onClick={onReset}
          disabled={!dirty}
          className="mb-3 inline-flex items-center gap-1 text-base font-semibold text-brand-violet disabled:cursor-not-allowed disabled:text-ink-muted"
        >
          ↺ Reset to this scenario’s starting levers
        </button>
      )}

      <div className="flex flex-col gap-4">
        <DiscountControl
          definition={discount}
          selected={selected}
          readOnly={readOnly}
          onSelect={onSelectDiscount}
        />
        <DurationControl
          definition={duration}
          selected={values.duration_weeks ?? null}
          readOnly={readOnly}
          onSelect={onSelectDuration}
        />
        <SpendField definition={spend} readOnly={readOnly} simulation={simulation} />
      </div>

      {/* Only a hypothetical scenario has a run button here. The measured
          baseline's "Recalculate baseline" duplicated the toolbar's
          Recalculate, one full-width violet bar under three read-only
          values, so it is gone; the toolbar button does the same thing. */}
      {!readOnly && (
        <Button variant="primary" block onClick={onRun} disabled={running || !canRun} className="mt-4">
          {running ? (
            <>Running simulation…</>
          ) : (
            <>
              <Icon name="play" /> {runLabel}
            </>
          )}
        </Button>
      )}

      <div className="mt-2.5 flex items-start gap-1.5 rounded-lg border border-border-subtle bg-surface-muted p-[8px_12px] text-sm [&_svg]:mt-px [&_svg]:h-[13px] [&_svg]:w-[13px] [&_svg]:shrink-0 [&_svg]:text-ink-muted">
        <Icon name="info" />
        <span className="text-ink-secondary">{note}</span>
      </div>
    </div>
  )
}

/** The head of the slider: a real position, deliberately not a treatment.
 *  `treatment` is null, which is how every consumer below tells it apart from
 *  an ApprovedPoint without inspecting its number. */
const NO_PROMOTION: DiscountStop = { discount_pct: 0, treatment: null }

type DiscountStop = { discount_pct: number; treatment: string | null }

/** The approved treatment depths, behind a 0% "no promotion" stop. */
function DiscountControl({
  definition,
  selected,
  readOnly,
  onSelect,
}: {
  definition: LeverDefinition | undefined
  selected: number | null
  readOnly: boolean
  onSelect: (discountPct: number) => void
}) {
  const points = definition?.approved_points ?? []
  // Built here, not sent by the API: 0% is a control affordance, and adding it
  // to the approved list would be the frontend inventing a rule.
  const stops: DiscountStop[] = [NO_PROMOTION, ...points]

  return (
    <div>
      <div className="mb-1.5 flex items-center justify-between gap-2">
        <label className="flex items-center gap-1 text-sm font-semibold text-ink-secondary">
          Discount Depth
          <InfoPopover label="About the discount treatments" title="Approved treatments" width={264}>
            <div className="mt-1 text-sm leading-[1.5] text-ink-secondary">
              A scenario may use only these five approved promotion treatments. Depths between them are
              not offered: no approved rule defines an uplift for them, and inventing one would be a
              coefficient rather than a rule.
            </div>
          </InfoPopover>
        </label>
      </div>

      {readOnly ? (
        <div className="rounded-[var(--r-md)] border border-border-subtle bg-surface-muted p-2.5">
          <div className="text-base font-bold text-ink-primary [font-variant-numeric:tabular-nums]">
            {definition?.display_value ?? '—'}
          </div>
          <div className="mt-1 text-xs leading-[1.45] text-ink-muted">
            {definition?.basis ??
              'Measured for this scope. A blend across the promotions in scope, so it need not be one of the approved treatment depths.'}
          </div>
        </div>
      ) : (
        <>
          <SteppedSlider
            id="lever-discount"
            stops={stops}
            selectedIndex={stops.findIndex(
              (p) => selected !== null && Math.abs(selected - p.discount_pct) < 1e-9,
            )}
            labelOf={(p) => `${p.discount_pct}%`}
            onSelect={(p) => onSelect(p.discount_pct)}
          />
          <SelectedValue
            value={selected === null ? '—' : `${selected}%`}
            note={selectedNote(points, selected)}
          />
        </>
      )}
    </div>
  )
}

function selectedNote(
  points: NonNullable<LeverDefinition['approved_points']>,
  selected: number | null,
): string {
  if (selected === 0) {
    return 'No promotion. Not an approved treatment — no approved uplift band exists for a zero discount, so this scenario cannot be run.'
  }
  const point = points.find((p) => selected !== null && Math.abs(selected - p.discount_pct) < 1e-9)
  if (!point) return 'Select an approved treatment to run this scenario.'
  return `${point.treatment} · approved uplift range ${(point.uplift_low * 100).toFixed(0)}–${(point.uplift_high * 100).toFixed(0)}%`
}

/** The two cadences this project plans in.
 *
 *  WEEKLY AND MONTHLY, because those are the two the promotion calendar
 *  declares per channel (app/tpo/promo_calendar.CADENCE) — not an arbitrary
 *  pair. Days are what a commercial user says out loud and weeks are the unit
 *  the API takes, so the control shows both and sends the second.
 *
 *  STILL NOT MODELLED. The scenario records which cadence it means and the API
 *  echoes it back; no approved rule maps weeks to uplift, so no KPI moves. The
 *  badge says so rather than leaving the user to discover it from an unchanged
 *  number. The Current Plan keeps showing its measured span instead.
 */
const DURATION_STOPS: { weeks: number; days: number; cadence: string }[] = [
  { weeks: 1, days: 7, cadence: 'Weekly' },
  { weeks: 4, days: 30, cadence: 'Monthly' },
]

function DurationControl({
  definition,
  selected,
  readOnly,
  onSelect,
}: {
  definition: LeverDefinition | undefined
  selected: number | null
  readOnly: boolean
  onSelect: (durationWeeks: number) => void
}) {
  const index = DURATION_STOPS.findIndex((s) => selected !== null && Math.abs(selected - s.weeks) < 1e-9)
  const stop = index >= 0 ? DURATION_STOPS[index] : null

  return (
    <div>
      <div className="mb-1.5 flex items-center justify-between gap-2">
        <label htmlFor="lever-duration" className="text-sm font-semibold text-ink-secondary">
          Promotion Duration
        </label>
        <span className="rounded-[4px] bg-surface-muted px-1.5 py-[2px] text-2xs font-bold uppercase tracking-[0.04em] text-ink-muted">
          Response not modelled
        </span>
      </div>

      {readOnly ? (
        <div className="rounded-[var(--r-md)] border border-border-subtle bg-surface-muted p-2.5">
          <div className="text-base font-bold text-ink-primary [font-variant-numeric:tabular-nums]">
            {definition?.available ? definition.display_value : '—'}
          </div>
          <div className="mt-1 text-xs leading-[1.45] text-ink-muted">
            {definition?.available
              ? `${definition.basis}. No approved rule maps duration to uplift, so changing it would not change a result.`
              : definition?.unavailable_reason ?? 'Not available for this scope.'}
          </div>
        </div>
      ) : (
        <>
          <SteppedSlider
            id="lever-duration"
            stops={DURATION_STOPS}
            selectedIndex={index}
            labelOf={(s) => `${s.days} days`}
            onSelect={(s) => onSelect(s.weeks)}
          />
          <SelectedValue
            value={stop ? `${stop.days} days` : '—'}
            note={
              stop
                ? `${stop.cadence} cadence. Selects the VIEW of this scenario: weekly reads it per business week, monthly reads the whole scope. The treatment response is unchanged either way — no approved rule maps duration to uplift.`
                : 'Choose the cadence this scenario runs at.'
            }
          />
        </>
      )}
    </div>
  )
}

/** TRADE SPEND, FROM WHICHEVER AUTHORITY OWNS IT.
 *
 *  Two different numbers wear this label and the panel must not confuse them:
 *
 *    Current Plan  -> the MEASURED Trade Spend for the scope, which is the
 *                     validated KPI the backend already put on the
 *                     `spend_amount` lever definition. It is read, not run.
 *    a hypothetical -> the RANGE its approved treatment derives, which exists
 *                     only after /simulation/simulate has executed.
 *
 *  This panel used to render only the second, so selecting the Current Plan
 *  showed "calculated when this scenario is run" over a scope whose spend was
 *  measured, known, and sitting unread in the props. Nothing here computes
 *  either figure.
 *
 *  A hypothetical also shows the measured spend beneath its range, because the
 *  question the scenario exists to answer is "against what?".
 */
function SpendField({
  definition,
  readOnly,
  simulation,
}: {
  definition: LeverDefinition | undefined
  readOnly: boolean
  simulation: SimulateResponse | null
}) {
  const low = simulation?.result.low.kpis.trade_spend
  const high = simulation?.result.high.kpis.trade_spend
  const measured = definition?.available ? definition.display_value : null

  if (readOnly) {
    return (
      <div>
        <div className="mb-1.5 flex items-center justify-between gap-2">
          <label className="flex items-center gap-1 text-sm font-semibold text-ink-secondary">
            Current Trade Spend
            <InfoPopover label="About current trade spend" title="Measured, not proposed" width={264}>
              <div className="mt-1 text-sm leading-[1.5] text-ink-secondary">
                {definition?.basis ??
                  'The validated Trade Spend KPI for this scope, from the same engine the Insights Hub reads.'}
              </div>
            </InfoPopover>
          </label>
        </div>
        <div className="rounded-[var(--r-md)] border border-border-subtle bg-surface-muted p-2.5">
          <div className="text-base font-bold text-ink-primary [font-variant-numeric:tabular-nums]">
            {measured ?? '—'}
          </div>
          <div className="mt-1 text-xs leading-[1.45] text-ink-muted">
            {measured
              ? 'Measured for this scope by the validated KPI engine.'
              : definition?.unavailable_reason ?? 'Not available for this scope.'}
          </div>
        </div>
      </div>
    )
  }

  return (
    <div>
      <div className="mb-1.5 flex items-center justify-between gap-2">
        <label className="flex items-center gap-1 text-sm font-semibold text-ink-secondary">
          Derived Trade Spend
          <InfoPopover label="About derived trade spend" title="Derived, not entered" width={264}>
            <div className="mt-1 text-sm leading-[1.5] text-ink-secondary">
              {simulation?.levers.spend_amount.note ??
                'Trade spend is an output of the scenario economics, not an input, so there is nothing to type here.'}
            </div>
          </InfoPopover>
        </label>
      </div>
      <div className="rounded-[var(--r-md)] border border-border-subtle bg-surface-muted p-2.5">
        {low?.available && high?.available ? (
          <>
            <div className="text-base font-bold text-ink-primary [font-variant-numeric:tabular-nums]">
              {low.display_value} – {high.display_value}
            </div>
            <div className="mt-1 text-xs text-ink-muted">Across the approved uplift range.</div>
          </>
        ) : (
          <div className="text-xs leading-[1.45] text-ink-muted">
            Calculated from the scenario economics when this scenario is run.
          </div>
        )}
        {/* THE ANCHOR. A derived range means nothing without the measured
            figure it is being compared against, and that figure is already
            on the Current Plan's own lever definition. */}
        {measured && (
          <div className="mt-2 flex items-baseline justify-between gap-2 border-t border-border-subtle pt-2">
            <span className="text-xs font-semibold uppercase tracking-[0.04em] text-ink-muted">
              Current
            </span>
            <span className="text-sm font-bold text-ink-secondary [font-variant-numeric:tabular-nums]">
              {measured}
            </span>
          </div>
        )}
      </div>
    </div>
  )
}

/** A slider that can only stop on the values it was given.
 *
 *  THE HANDLE MOVES OVER AN INDEX, NOT OVER THE VALUE. A native range with
 *  `min=5 max=25 step=5` happens to land on the five approved depths today, but
 *  it encodes "evenly spaced" as a fact about the treatment rules rather than as
 *  the coincidence it is — the day an approved set is 5/10/20 it would silently
 *  offer 15. Sliding over `0..n-1` and reading the value out of the array cannot
 *  produce a stop that is not on the list, whatever the list is.
 *
 *  Native `<input type="range">` for the same reason components/optimization
 *  gives: keyboard operation, screen-reader semantics and touch behaviour are
 *  correct for free, and `aria-valuetext` is what makes an index-based handle
 *  announce "15%" rather than "3".
 */
function SteppedSlider<T>({
  id,
  stops,
  selectedIndex,
  labelOf,
  disabled,
  onSelect,
}: {
  id: string
  stops: T[]
  /** -1 when nothing is selected yet. */
  selectedIndex: number
  labelOf: (stop: T) => string
  disabled?: boolean
  onSelect: (stop: T, index: number) => void
}) {
  if (stops.length === 0) return null
  const inert = Boolean(disabled) || stops.length < 2
  // An unselected control still has to put its handle somewhere; the first stop
  // is the least surprising place, and `selectedIndex` stays -1 so the caller
  // can keep saying "nothing selected".
  const position = selectedIndex >= 0 ? selectedIndex : 0
  const unselected = selectedIndex < 0

  return (
    <div>
      <input
        id={id}
        type="range"
        min={0}
        max={stops.length - 1}
        step={1}
        value={position}
        disabled={inert}
        // WHILE NOTHING IS SELECTED THE HANDLE IS A PLACEHOLDER, NOT A VALUE.
        // The scope's measured depth is frequently not an approved stop, so the
        // control legitimately opens with no selection — and announcing the
        // parked handle's label would tell a screen reader a value had been
        // chosen when none had.
        aria-valuetext={unselected ? 'No treatment selected' : labelOf(stops[position])}
        onChange={(e) => {
          const i = Number(e.target.value)
          onSelect(stops[i], i)
        }}
        // THE FIRST KEY PRESS MUST COMMIT, even when it moves the handle
        // nowhere. Parked at index 0 with nothing selected, Home and ArrowLeft
        // set the input to a value it already holds, so `change` never fires and
        // the keystroke did nothing at all. Committing the resolved index here
        // closes that gap; once something IS selected, `change` does the work and
        // this stands down rather than firing twice.
        onKeyDown={(e) => {
          if (inert || !unselected) return
          const target =
            e.key === 'Home' || e.key === 'ArrowLeft' || e.key === 'ArrowDown'
              ? 0
              : e.key === 'End'
                ? stops.length - 1
                : e.key === 'ArrowRight' || e.key === 'ArrowUp'
                  ? Math.min(position + 1, stops.length - 1)
                  : -1
          if (target < 0) return
          e.preventDefault()
          onSelect(stops[target], target)
        }}
        className="h-1.5 w-full cursor-pointer appearance-none rounded-full bg-border-default accent-[var(--brand-violet)] disabled:cursor-not-allowed disabled:opacity-50"
      />
      {/* The stops are rendered, and each is a click target of its own. A
          pointer user should not have to drag to a value that is written on
          screen a few pixels away. */}
      <div
        className="mt-1.5 grid gap-1"
        style={{ gridTemplateColumns: `repeat(${stops.length}, minmax(0, 1fr))` }}
      >
        {stops.map((stop, i) => {
          const active = i === selectedIndex
          return (
            <button
              key={labelOf(stop)}
              type="button"
              disabled={inert}
              aria-pressed={active}
              onClick={() => onSelect(stop, i)}
              className={`rounded-[5px] py-[3px] text-xs font-bold transition-colors [font-variant-numeric:tabular-nums] disabled:cursor-not-allowed ${
                active ? 'bg-brand-violet-50 text-brand-violet' : 'text-ink-muted hover:text-ink-secondary'
              }`}
            >
              {labelOf(stop)}
            </button>
          )
        })}
      </div>
    </div>
  )
}

/** The chosen value, spelled out. A handle position is not a number, and a
 *  control the user is about to run an economic scenario from should not ask
 *  them to read one off a track. */
function SelectedValue({ value, note }: { value: string; note: string }) {
  return (
    <div className="mt-2 rounded-[var(--r-md)] border border-border-subtle bg-surface-muted p-2.5">
      <div className="flex items-baseline gap-1.5">
        <span className="text-xs font-semibold uppercase tracking-[0.04em] text-ink-muted">
          Selected
        </span>
        <span className="text-base font-bold text-ink-primary [font-variant-numeric:tabular-nums]">
          {value}
        </span>
      </div>
      <div className="mt-1 text-xs leading-[1.45] text-ink-muted">{note}</div>
    </div>
  )
}
