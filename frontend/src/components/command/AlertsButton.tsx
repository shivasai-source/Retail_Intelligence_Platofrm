import { useNavigate } from 'react-router-dom'
import { Icon } from '../../icons'
import { useRiskAlerts } from '../../hooks/useCommandCenter'
import { ALERT_FETCH_LIMIT } from './riskRanking'
import { OPEN_ALERTS_STATE_KEY, buildOpenAlertsIntent } from '../../lib/askWhy'

/** THE WAY INTO THE ALERTS, from the Insights Hub's title row.
 *
 *  The Hub used to carry three alert surfaces of its own: a strip leading with
 *  the single worst alert, a Target ROI popover in the toolbar, and a card
 *  listing every event below target by severity. All three now live in one
 *  place — the alerts dialog on Investigations, where an "Ask why" is a step
 *  away rather than a page away — and this button is the door to it. It sits
 *  where the strip sat: top-right, where a reader looks for status first.
 *
 *  IT LOOKS LIKE THE TOOLBAR'S OTHER CONTROLS, on purpose. A first cut wore
 *  the old strip's red border, pulsing icon and arrow, and read as an alarm
 *  going off in the corner rather than a control — a reader cannot tell a
 *  button from a warning when it dresses as one. So: the same quiet chrome as
 *  Add KPI beside it, and the state carried in ONE place, the count badge —
 *  red while any Critical exists, amber for High or Medium only, muted at
 *  zero. Severity of the worst event, not the size of the count.
 *
 *  IT COMPUTES NOTHING. The count is the sum of the three band counts the
 *  `/risk-alerts` payload reports, read through the same `useRiskAlerts` hook
 *  at the same `ALERT_FETCH_LIMIT` the notification bell uses, so React Query
 *  serves both from one cache entry — the button costs no extra request, and
 *  cannot disagree with the bell beside it. `counts` are computed over every
 *  banded event on the server, not over the `limit`-capped rows.
 *
 *  Navigation carries a per-click intent in router state, the channel the
 *  Ask-why hand-off already uses (lib/askWhy), so Investigations can tell "the
 *  reader pressed Alerts" from an ordinary visit and open the dialog. */
export function AlertsButton({
  disabled,
  disabledReason,
}: {
  disabled?: boolean
  disabledReason?: string
}) {
  const navigate = useNavigate()
  const alerts = useRiskAlerts(ALERT_FETCH_LIMIT)

  const counts = alerts.data?.counts
  const total = counts ? counts.critical + counts.high + counts.medium : null
  const critical = counts?.critical ?? 0

  const badge =
    critical > 0
      ? 'bg-status-danger-bg text-status-danger'
      : (total ?? 0) > 0
        ? 'bg-status-warning-bg text-status-warning'
        : 'bg-surface-muted text-ink-muted'

  const label =
    total === null
      ? 'Alerts'
      : total === 0
        ? 'Alerts, none in this selection'
        : `Alerts, ${total} promotion event${total === 1 ? '' : 's'} below target${critical ? `, ${critical} critical` : ''}`

  return (
    <button
      type="button"
      disabled={disabled}
      title={disabled ? disabledReason : 'Set the target ROI and pick an event to investigate'}
      aria-label={label}
      onClick={() => navigate('/investigations', { state: { [OPEN_ALERTS_STATE_KEY]: buildOpenAlertsIntent() } })}
      className="inline-flex h-9 cursor-pointer items-center gap-2 rounded-[var(--r-md)] border border-border-subtle bg-surface-card pl-3 pr-2 text-sm font-semibold text-ink-secondary transition-[border-color,background-color,color] duration-150 hover:border-border-strong hover:bg-surface-hover hover:text-ink-primary focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-violet disabled:cursor-not-allowed disabled:opacity-50 disabled:hover:border-border-subtle disabled:hover:bg-surface-card"
    >
      <Icon
        name="alertTriangle"
        className={`h-4 w-4 ${critical > 0 && !disabled ? 'text-status-danger' : 'text-ink-muted'}`}
      />
      <span>Alerts</span>
      {total !== null && (
        <span
          className={`inline-flex h-5 min-w-[20px] items-center justify-center rounded-full px-1.5 text-xs font-bold leading-none [font-variant-numeric:tabular-nums] ${badge}`}
        >
          {total.toLocaleString()}
        </span>
      )}
    </button>
  )
}
