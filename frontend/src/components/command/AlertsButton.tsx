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
 *  IT WEARS ITS SEVERITY. A quiet, Add-KPI-style pill was tried and read as
 *  one more filter rather than an alert. So the button is tinted by the worst
 *  open event — red while any Critical exists, amber for High or Medium only,
 *  neutral at zero — with a solid count badge, but no pulse or animation: it
 *  should look urgent, not like an alarm going off. It keeps the toolbar's
 *  height, radius and type scale so it still sits in the row.
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

  // IT LOOKS LIKE AN ALERT. A neutral toolbar pill read as one more filter, so
  // the button now wears its severity: red while any Critical exists, amber
  // for High or Medium only, neutral at zero. The count sits in a solid badge
  // — the critical count when there is one, since that is what needs action
  // first; otherwise the total below target. Same height, radius and type
  // scale as the toolbar's other controls, so it still sits in the row.
  const tone =
    disabled || total === null || total === 0
      ? {
          btn: 'border-border-default bg-surface-card text-ink-secondary hover:bg-surface-hover hover:border-border-strong',
          icon: 'text-ink-muted',
          badge: 'bg-surface-muted text-ink-muted',
        }
      : critical > 0
        ? {
            btn: 'border-status-danger/30 bg-status-danger-bg text-status-danger hover:border-status-danger/60 hover:bg-status-danger/15',
            icon: 'text-status-danger',
            badge: 'bg-status-danger text-white',
          }
        : {
            btn: 'border-status-warning/40 bg-status-warning-bg text-status-warning hover:border-status-warning/70 hover:bg-status-warning/20',
            icon: 'text-status-warning',
            badge: 'bg-status-warning text-white',
          }
  const badgeNum = total === null ? null : critical > 0 ? critical : total
  const badgeWord = critical > 0 ? 'critical' : 'below target'
  const detail = counts
    ? `${total!.toLocaleString()} below target — ${counts.critical.toLocaleString()} critical, ${counts.high.toLocaleString()} high, ${counts.medium.toLocaleString()} medium. Open on Investigations.`
    : 'Set the target ROI and pick an event to investigate'

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
      title={disabled ? disabledReason : detail}
      aria-label={label}
      onClick={() => navigate('/investigations', { state: { [OPEN_ALERTS_STATE_KEY]: buildOpenAlertsIntent() } })}
      className={`group inline-flex h-9 cursor-pointer select-none items-center gap-2 whitespace-nowrap rounded-[var(--r-md)] border pl-3 pr-2 text-sm font-semibold tracking-[-0.005em] shadow-[var(--shadow-sm)] transition-[background-color,border-color,box-shadow] duration-150 hover:shadow-[var(--shadow-md)] active:translate-y-px focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--brand-violet)] disabled:cursor-not-allowed disabled:opacity-50 disabled:shadow-none ${tone.btn}`}
    >
      <Icon name="alertTriangle" className={`h-4 w-4 stroke-2 ${tone.icon}`} />
      <span>Alerts</span>
      {badgeNum !== null && badgeNum > 0 && !disabled && (
        <span
          className={`inline-flex h-5 items-center gap-1 rounded-[var(--r-pill)] px-2 text-xs font-bold leading-none tabular-nums ${tone.badge}`}
        >
          {badgeNum.toLocaleString()}
          <span className="font-semibold capitalize opacity-90">{badgeWord}</span>
        </span>
      )}
      <Icon
        name="chevronRight"
        className={`h-4 w-4 stroke-2 opacity-70 transition-transform duration-150 group-hover:translate-x-0.5 group-hover:opacity-100 group-disabled:translate-x-0 ${tone.icon}`}
      />
    </button>
  )
}
