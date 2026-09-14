import { Icon } from '../../icons'
import { InfoPopover } from '../ui'
import type { SimulationContext } from '../../types/simulation'
import type { SimulationContext as InvestigationSimulationContext } from '../../types/investigationContext'
import type { InvestigationOrigin } from '../../store/activeInvestigation'

/** "What are we simulating?" — the resolved scope, in the words people use.
 *
 *  Every value comes from the API's resolved FilterState: channel codes are
 *  already turned into names by the same labeller the Command Center's
 *  breakdowns use, and an unconstrained dimension reads "All channels" rather
 *  than being given an invented default. Nothing on this bar is written down
 *  in the frontend.
 *
 *  Primary dimensions are always shown so the question has an answer even when
 *  nothing is selected; the rest appear only when they are constraining
 *  something.
 */
export function ContextBar({
  context,
  investigation = null,
  origin = null,
  originLabel = null,
}: {
  context: SimulationContext
  /** The RCA hand-off, when one was made. Null on direct entry. */
  investigation?: InvestigationSimulationContext | null
  origin?: InvestigationOrigin | null
  originLabel?: string | null
}) {
  const primary = context.dimensions.filter((d) => d.primary)
  const extra = context.dimensions.filter((d) => !d.primary && d.constrained)

  return (
    <div className="rounded-[var(--r-lg)] border border-border-default bg-surface-card p-[16px_18px]">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <div className="inline-flex items-center gap-1.5 text-xs font-bold uppercase tracking-[0.06em] text-brand-violet [&_svg]:h-3 [&_svg]:w-3">
          <Icon name="target" /> What are we simulating?
        </div>
        <div className="text-sm text-ink-muted">
          {context.row_count.toLocaleString()} {context.row_count === 1 ? 'row' : 'rows'} ·{' '}
          {context.promoted_row_count.toLocaleString()} promoted
        </div>
      </div>

      {investigation && (
        <InvestigationBlock
          investigation={investigation}
          origin={origin}
          originLabel={originLabel}
        />
      )}

      <div className="mt-3 flex flex-wrap gap-x-6 gap-y-2.5">
        <Item label="Period" summary={context.period} constrained={context.year !== null} />
        {primary.map((d) => (
          <Item key={d.key} label={d.label} summary={d.summary} constrained={d.constrained} />
        ))}
      </div>

      {extra.length > 0 && (
        <div className="mt-2.5 flex flex-wrap gap-x-6 gap-y-2 border-t border-border-subtle pt-2.5">
          {extra.map((d) => (
            <Item key={d.key} label={d.label} summary={d.summary} constrained />
          ))}
        </div>
      )}
    </div>
  )
}

function Item({ label, summary, constrained }: { label: string; summary: string; constrained: boolean }) {
  return (
    <div className="min-w-0">
      <div className="text-xs font-semibold uppercase tracking-[0.04em] text-ink-muted">{label}</div>
      <div
        className={`mt-0.5 text-base ${
          // An "All channels" is a real answer, but a weaker one than a
          // selection — muted so the eye finds what is actually constrained.
          constrained ? 'font-bold text-ink-primary' : 'text-ink-muted'
        }`}
      >
        {summary}
      </div>
    </div>
  )
}

/** The investigation this simulation belongs to — B3.2.
 *
 *  THE QUESTION IS SHOWN ONLY IF IT IS ONE. `store/activeInvestigation.ts`
 *  seeds itself with an example copied from investigation-types.json, so a
 *  user who has never run an investigation is still carrying a
 *  plausible-sounding sentence. The backend reports that as `seed_example`
 *  rather than as the investigation's question, and this block renders the
 *  distinction instead of hiding it.
 *
 *  THE QUESTION AND WHERE IT CAME FROM, AND NOTHING ELSE. This block used
 *  to carry a metadata row -- investigation type, an `inv_...` id, promotion
 *  and product CODES, and a note for each field the investigation had not
 *  specified. None of it was for the person reading: the type is on the
 *  banner above, the id is an internal key, the codes are the same promotion
 *  and product the scope line beneath names in words, and "not specified"
 *  told them nothing they could act on. The fields still travel in the
 *  context payload for anything that needs them.
 */
function InvestigationBlock({
  investigation,
  origin,
  originLabel,
}: {
  investigation: InvestigationSimulationContext
  origin: InvestigationOrigin | null
  originLabel: string | null
}) {
  const question = investigation.question
  const asked = question.value !== null

  return (
    <div className="mt-3 border-t border-border-subtle pt-3">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <div className="text-xs font-semibold uppercase tracking-[0.04em] text-ink-muted">
          {asked ? 'Investigation question' : 'Investigation'}
        </div>
        {origin && originLabel && (
          <div className="text-xs text-ink-muted">
            From {origin === 'risk_alert' ? 'risk alert' : 'underperforming promotions'}: {originLabel}
          </div>
        )}
      </div>

      {asked ? (
        <div className="mt-1 text-base font-semibold leading-[1.45] text-ink-primary">{question.value}</div>
      ) : (
        <div className="mt-1 flex items-start gap-1.5 text-sm leading-[1.45] text-ink-muted">
          <span>
            {question.source === 'seed_example'
              ? 'No investigation question yet — the studio is showing an example, not something you asked.'
              : 'No investigation question recorded.'}
          </span>
          <InfoPopover label="Why there is no question" title="Investigation question" width={280}>
            <div className="mt-1 text-sm leading-[1.5] text-ink-secondary">{question.reason}</div>
          </InfoPopover>
        </div>
      )}
    </div>
  )
}
