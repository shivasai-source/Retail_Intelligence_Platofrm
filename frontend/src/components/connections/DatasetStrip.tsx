import type { ReactNode } from 'react'
import { Icon } from '../../icons'
import { Pill } from '../ui'

// THE DATASET STRIP — what a module currently has, and the way out once it has
// enough. Lifted out of pages/Connections.tsx; the markup and classes are the
// ones TPO already rendered.
//
// Generalised in exactly one direction: the headline, the body sentence, the
// unit the counter counts and the trailing action are now the module's to
// supply. The six-table wording was baked in here, and six is TPO's number —
// it comes from backend/app/star_dataset.py's ROLE_FILES, not from anything
// every intelligence module shares.
export function DatasetStrip({
  complete,
  present,
  total,
  unit,
  headline,
  body,
  action,
}: {
  complete: boolean
  present: number
  total: number
  /** What the counter counts, e.g. 'core tables'. Plural; the count precedes it. */
  unit: string
  headline: string
  body: string
  /** Trailing control, e.g. TPO's "Continue to Insights Hub". */
  action?: ReactNode
}) {
  return (
    <div
      className={`fade-in-up mb-6 flex flex-wrap items-center gap-4 rounded-[var(--r-xl)] border p-[16px_20px] ${
        complete ? 'border-[#A7D8C4] bg-status-success-bg' : 'border-border-subtle bg-surface-card'
      }`}
    >
      <span
        className={`grid h-11 w-11 shrink-0 place-items-center rounded-[11px] [&_svg]:h-5 [&_svg]:w-5 ${
          complete ? 'bg-[#047857] text-white' : 'bg-tint-lavender text-tint-lavender-icon'
        }`}
      >
        <Icon name={complete ? 'checkCircle' : 'database'} />
      </span>

      <div className="min-w-[240px] flex-1">
        <div className="text-md font-bold">{headline}</div>
        <p className="mt-0.5 text-base leading-[1.55] text-ink-muted">{body}</p>
      </div>

      <div className="flex shrink-0 items-center gap-3">
        <Pill tone={complete ? 'success' : 'neutral'} dot={complete}>
          {total ? `${present} of ${total} ${unit}` : 'Checking…'}
        </Pill>
        {action}
      </div>
    </div>
  )
}
