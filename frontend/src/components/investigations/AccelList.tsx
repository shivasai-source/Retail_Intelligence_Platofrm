import { Icon, type IconName } from '../../icons'
import { Spinner } from '../ui'
import type { Accelerator } from '../../types/orchestration'

type LiveState = 'queued' | 'progress' | 'done'

const STATUS_STYLES: Record<LiveState, string> = {
  done: 'bg-status-success-bg text-[var(--pill-success-ink)]',
  progress: 'bg-status-warning-bg text-[var(--pill-warning-ink)]',
  queued: 'bg-surface-muted text-ink-muted',
}
const ICON_STYLES: Record<LiveState, { bg: string; fg: string }> = {
  done: { bg: 'var(--status-success-bg)', fg: 'var(--status-success)' },
  progress: { bg: 'var(--status-warning-bg)', fg: 'var(--status-warning)' },
  queued: { bg: 'var(--border-subtle)', fg: 'var(--text-muted)' },
}

/** What each specialist actually does, in plain words.
 *
 *  The API's own `desc` is a terse fragment written for the orchestrator's
 *  catalogue — "Which channels, regions and retailers break" — which names a
 *  topic rather than explaining a job. These say what the agent is for and,
 *  where it matters, how to read its answer.
 *
 *  They live here rather than in `agents/roster.py` because the API's string is
 *  copied into every run at the time it is recorded: rewording the roster would
 *  leave every already-stored investigation showing the old text. Keyed by the
 *  specialist key, which is identical in both places. Anything not listed —
 *  a specialist added later — falls back to whatever the API sent.
 */
export const PLAIN_DESC: Record<string, string> = {
  benchmark:
    "Compares this segment's ROI with the rest of the business, and with every other channel and region.",
  spend_allocation:
    'Shows where the trade spend went by mechanic and offer, and whether too much of it sits in one place.',
  mechanic_efficiency:
    "Compares each mechanic's ROI here with the same mechanic elsewhere — 5% Discount, Buy3Get1 and so on.",
  offer_forensics:
    'Lists the promotion events that missed target: the offer, SKU, channel and week, with the value at stake.',
  portfolio:
    'Breaks ROI down by category and brand, and spend by SKU, to see whether a few products drag the rest.',
  geography:
    'Breaks ROI down by region, state and retailer, to find the smallest place that explains the result.',
  cannibalization:
    'Checks whether other SKUs in the same brand form sold less in the promotion weeks — a link, not a cause.',
  temporal:
    'Tracks the KPIs month by month, to see whether results faded across the period or one month carried them.',
  risk_exposure:
    'Counts the events still below the ROI target by severity, and totals the trade spend they put at stake.',
  analyst:
    "Reads every specialist's findings together and writes the single explanation of what happened and why.",
  advisor:
    'Turns the diagnosis into what to do next — which offers to change, and where the trade spend should move.',
}

// Ported from js/pages/investigations.js's `.accel-list`/`.accel-row`/`setAccel()`.
export function AccelList({
  accelerators,
  statusOverride,
  onSelect,
}: {
  accelerators: Accelerator[]
  /** During the "New Investigation" staged build, overrides each row's live state;
   *  omit to just render each accelerator's own `status` field. */
  statusOverride?: Record<string, LiveState>
  /** Optional. Without it the rows render as the status readout they are,
   *  rather than as click targets that lead nowhere. */
  onSelect?: (a: Accelerator) => void
}) {
  return (
    // THE LIST FILLS THE CARD. This card is the short half of a two-column row,
    // so the grid stretches it to the height of the Investigation Graph beside
    // it and the rows used to stop well above its own bottom border. `grow` on
    // the rows (not `flex-1`) hands them the leftover height without letting
    // them shrink below their own content when there is none to share.
    <div className="flex h-full flex-col">
      {accelerators.map((a, i) => {
        const state: LiveState = statusOverride?.[a.key] ?? (a.status === 'Completed' ? 'done' : 'progress')
        return (
          <div
            key={a.key}
            onClick={onSelect ? () => onSelect(a) : undefined}
            className={`fade-in-up grid grow grid-cols-[36px_1fr_auto] items-center gap-3 border-b border-border-subtle py-3 transition-[opacity,background] duration-150 last:border-b-0 ${
              onSelect ? 'cursor-pointer hover:bg-surface-hover' : ''
            } ${state === 'queued' ? 'opacity-50' : ''}`}
            style={{ animationDelay: `${i * 60}ms` }}
          >
            <div
              className="grid h-9 w-9 place-items-center rounded-[10px] [&_svg]:h-[18px] [&_svg]:w-[18px]"
              style={{ background: ICON_STYLES[state].bg, color: ICON_STYLES[state].fg }}
            >
              <Icon name={a.icon as IconName} />
            </div>
            <div className="min-w-0">
              <div className="text-base font-medium text-ink-primary">{a.name}</div>
              <div className="mt-0.5 text-sm leading-snug text-ink-muted">
                {PLAIN_DESC[a.key] ?? a.desc}
              </div>
            </div>
            <span
              className={`inline-flex items-center gap-1.5 rounded-[var(--r-pill)] px-2.5 py-1 text-xs font-medium ${STATUS_STYLES[state]}`}
            >
              {state === 'done' && <Icon name="checkCircle" className="h-[13px] w-[13px]" />}
              {state === 'progress' && <Spinner />}
              {state === 'queued' && <Icon name="clock" className="h-[13px] w-[13px]" />}
              <span>{state === 'done' ? 'Completed' : state === 'progress' ? 'Running…' : 'Queued'}</span>
            </span>
          </div>
        )
      })}
    </div>
  )
}
