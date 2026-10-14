import { IconButton, Modal, Spinner } from '../ui'
import { InfoBlock, InfoPopover } from '../ui/InfoPopover'
import { Icon } from '../../icons'
import { Stale } from '../command/States'
import { RiskAlertsPanel } from '../command/RiskAlertsPanel'
import { ALERT_FETCH_LIMIT } from '../command/riskRanking'
import { useRiskAlerts } from '../../hooks/useCommandCenter'
import { useEnsureCommandScope } from '../../hooks/useCommandScope'
import { fmtRoi } from '../../lib/roi'
import type { RiskAlert } from '../../types/commandCenter'


/** THE ALERTS DIALOG — pick the event to investigate.
 *
 *  THE TARGET IS FIXED at the configured 1.50x (config.PROMOTION_TARGET_ROI);
 *  the reader no longer sets it. The dialog opens straight on
 *
 *    THE EVENTS BELOW IT, banded Critical / High / Medium and ranked by
 *       money at stake, in the very panel the Insights Hub used to draw beside
 *       its trend chart. An "Ask why" on any row hands that event to the
 *       investigation exactly as it always did — `onPick` is the caller's
 *       `useAlertHandoff` — and the dialog closes because the page behind it
 *       is now the answer.
 *
 *  NOTHING IS RECOMPUTED. The target lives in the Insights Hub's filter store;
 *  the events, the bands, the counts and every ROI are the `/risk-alerts`
 *  payload for that store's scope and target, through the same `useRiskAlerts`
 *  the Hub, the bell and the "From an alert" menu read. The scope is the
 *  Hub's own, initialised here if the reader has not visited the Hub yet
 *  (useEnsureCommandScope).
 *
 *  THE BACKDROP DOES NOT CLOSE IT. The reader came here to choose, and a
 *  stray click on the blurred page behind should not undo that. Escape and
 *  the ✕ still do — a dialog with no way out but "investigate something" is a
 *  trap, not a flow — so the page is reachable, just not by accident. */

export function AlertsModal({
  open,
  onClose,
  onPick,
}: {
  open: boolean
  onClose: () => void
  /** The event the reader chose — the caller hands it to the investigation. */
  onPick: (alert: RiskAlert) => void
}) {
  const initialised = useEnsureCommandScope()
  const alerts = useRiskAlerts(ALERT_FETCH_LIMIT)
  const meta = alerts.data?.meta

  return (
    <Modal open={open} onClose={onClose} closeOnBackdrop={false} maxWidthClassName="max-w-[680px]">
      <>
          <Header
            icon="alertTriangle"
            title="Promotion events below ROI target"
            subtitle={
              <>
                Judged against the ROI target of{' '}
                <span className="font-medium tabular-nums text-ink-primary">{fmtRoi(meta?.target_roi ?? 1.5)}</span>
                <span className="text-ink-disabled"> · </span>
                pick an event to investigate
              </>
            }
            actions={
              meta && (
                <InfoPopover label="About promotion events below ROI target" title="How events are banded">
                  <InfoBlock label="Event">One promotion on one product, in one channel, over its run of weeks</InfoBlock>
                  <InfoBlock label="Severity">
                    Critical ≤ {fmtRoi(meta.severity_bands.critical)}
                    <br />
                    High {fmtRoi(meta.severity_bands.critical)}–{fmtRoi(meta.severity_bands.high)}
                    <br />
                    Medium {fmtRoi(meta.severity_bands.high)}–{fmtRoi(meta.target_roi)}
                    <br />
                    On target ≥ {fmtRoi(meta.target_roi)}
                  </InfoBlock>
                  <InfoBlock label="Ranking">
                    Highest stake first
                    <br />
                    ROI as tie-breaker
                  </InfoBlock>
                </InfoPopover>
              )
            }
            onClose={onClose}
          />

          {alerts.error ? (
            <Message text="Alerts could not be loaded." />
          ) : !alerts.data || (!initialised && alerts.isLoading) ? (
            <Message text="Loading alerts…" spinner />
          ) : alerts.data.alerts.length === 0 ? (
            <div className="flex flex-col items-center gap-1.5 px-6 py-12 text-center">
              <span className="grid h-10 w-10 place-items-center rounded-full bg-status-success-bg text-status-success [&_svg]:h-5 [&_svg]:w-5">
                <Icon name="check" />
              </span>
              <span className="text-base font-medium text-ink-primary">Every event is at or above target</span>
              <span className="text-sm text-ink-muted">
                All {alerts.data.counts.total_events.toLocaleString()} promotion events in this selection reached the {fmtRoi(meta?.target_roi ?? 1.5)} target.
              </span>
            </div>
          ) : (
            // A fixed height, so the panel's own layout — a strip of tabs, six
            // rows spread to the bottom, "View all" beneath — has something to
            // fill, the way the card beside the trend chart gave it one. The
            // Stale wash covers the refetch after a target change: the previous
            // list stays readable but inert until the re-judged one lands.
            <Stale when={alerts.isFetching} className="flex h-[452px] flex-col">
              <RiskAlertsPanel data={alerts.data} onSelect={onPick} />
            </Stale>
          )}
      </>
    </Modal>
  )
}

function Header({
  icon,
  title,
  subtitle,
  actions,
  onClose,
}: {
  icon: 'target' | 'alertTriangle'
  title: string
  subtitle: React.ReactNode
  actions?: React.ReactNode
  onClose: () => void
}) {
  return (
    <div className="flex items-start justify-between gap-3 border-b border-border-subtle p-[16px_20px]">
      <div className="flex min-w-0 items-start gap-3">
        <span className="mt-0.5 grid h-9 w-9 shrink-0 place-items-center rounded-[10px] bg-brand-violet-50 text-brand-violet [&_svg]:h-[18px] [&_svg]:w-[18px]">
          <Icon name={icon} />
        </span>
        <div className="min-w-0">
          <h3 className="text-md font-medium text-ink-primary">{title}</h3>
          <div className="mt-0.5 text-sm text-ink-muted">{subtitle}</div>
        </div>
      </div>
      <div className="flex shrink-0 items-center gap-1">
        {actions}
        <IconButton icon="x" title="Close" onClick={onClose} />
      </div>
    </div>
  )
}

function Message({ text, spinner }: { text: string; spinner?: boolean }) {
  return (
    <div className="flex items-center justify-center gap-2 px-4 py-12 text-sm text-ink-muted">
      {spinner && <Spinner />} {text}
    </div>
  )
}
