import { Icon } from '../../icons'
import { Card } from '../ui'
import { standingOf, type RoiStanding } from '../../lib/roi'

/** THE SCOPE STRIP — what was investigated, and the numbers it was measured on.
 *
 *  It no longer repeats the question. The question already sits in the query
 *  bar directly above, in the user's own words; printing it again here at
 *  headline size was the "three boxes that say the same thing" the page used
 *  to open with. What this card carries instead is what the bar does NOT say:
 *  the scope's STANDING against the ROI target in the Insights Hub's own
 *  severity colours (Critical / High / Medium, or On target), the SUBJECT it
 *  resolved the question to (the graph's centre — "Dussehra Deal 25 on Outdoor
 *  Fresh Dryer Sheets 240 ct"), and the scope figures every specialist ran on.
 *
 *  The standing is read from the scope's own ROI with the same bands the
 *  alerts are graded by, so an investigation opened from a Critical alert
 *  says Critical here, and a typed question about a healthy scope says On
 *  target rather than borrowing a severity it never had.
 *
 *  Every value is the run's own: `subject` is `orchestration.center`, the
 *  chips are `orchestration.contextChips`, both assembled server-side from the
 *  planner's filters and the KPI engine. Nothing here rephrases anything. */
// The Insights Hub's own tones (service._SEVERITY_TONE): Critical and High
// are danger, Medium is warning. Matched here so the same event reads the
// same colour on both pages.
const STANDING_CLASSES: Record<RoiStanding, string> = {
  Critical: 'bg-status-danger-bg text-[#B91C1C]',
  High: 'bg-status-danger-bg text-[#B91C1C]',
  Medium: 'bg-status-warning-bg text-[#B45309]',
  'On target': 'bg-status-success-bg text-[#047857]',
}

export function BizQuestionCard({
  subject,
  contextChips,
}: {
  subject: { label: string; sub: string }
  contextChips: { period: string; channel: string; region: string; spend: string; roi?: string }
}) {
  const roi = contextChips.roi != null ? Number(contextChips.roi) : null
  const standing = standingOf(roi)

  return (
    <Card
      className="fade-in relative mb-4 grid grid-cols-[1.3fr_2fr] items-center gap-[18px] overflow-hidden border-[color-mix(in_srgb,var(--brand-violet)_22%,var(--border-default))] p-[16px_22px] @max-[1000px]:grid-cols-1"
      style={{
        // The same low-alpha violet-to-blue wash the Insights Hub header sits
        // on, laid over the card surface so it lifts off the page without
        // fighting the white findings card beneath it. Built from the brand
        // tokens, so it follows the dark theme with them.
        background:
          'linear-gradient(90deg, color-mix(in srgb, var(--brand-violet) 10%, var(--surface-card)) 0%, ' +
          'color-mix(in srgb, var(--brand-violet) 5%, var(--surface-card)) 55%, ' +
          'color-mix(in srgb, var(--brand-blue) 6%, var(--surface-card)) 100%)',
      }}
    >
      <div className="min-w-0">
        <div className="flex items-center gap-1.5">
          {standing && (
            <span
              className={`inline-flex h-[18px] items-center rounded-[var(--r-pill)] px-2 text-xs font-semibold uppercase tracking-[0.04em] ${STANDING_CLASSES[standing]}`}
              title={`ROI ${contextChips.roi} against the 1.50 target`}
            >
              {standing}
            </span>
          )}
          <span className="text-xs font-bold uppercase tracking-[0.06em] text-ink-muted">Investigation scope</span>
        </div>
        <div className="mt-2 truncate text-md font-bold leading-[1.4] text-ink-primary" title={subject.label}>
          {subject.label}
        </div>
        {subject.sub && <div className="mt-0.5 text-sm text-ink-muted">{subject.sub}</div>}
      </div>

      <div className="grid grid-cols-5 gap-3.5 border-l border-[color-mix(in_srgb,var(--brand-violet)_18%,var(--border-subtle))] pl-[18px] @max-[1000px]:grid-cols-3 @max-[1000px]:border-l-0 @max-[1000px]:pl-0">
        <MetaItem icon="calendar" label="Period" value={contextChips.period} />
        <MetaItem icon="flow" label="Channel" value={contextChips.channel} />
        <MetaItem icon="target" label="Region" value={contextChips.region} />
        <MetaItem icon="pricing" label="Trade spend" value={contextChips.spend} />
        <MetaItem icon="trending" label="Promotion ROI" value={contextChips.roi ?? '—'} />
      </div>
    </Card>
  )
}

function MetaItem({ icon, label, value }: { icon: Parameters<typeof Icon>[0]['name']; label: string; value: string }) {
  return (
    <div className="flex min-w-0 flex-col gap-1">
      <span className="inline-flex items-center gap-1 text-xs font-semibold uppercase tracking-[0.04em] text-ink-muted [&_svg]:h-3.5 [&_svg]:w-3.5 [&_svg]:text-brand-violet">
        <Icon name={icon} />
        {label}
      </span>
      <span className="truncate text-md font-bold tabular-nums text-ink-primary" title={value}>
        {value}
      </span>
    </div>
  )
}
