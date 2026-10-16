import { IconButton, Modal, Spinner } from '../ui'
import { InfoBlock, InfoPopover } from '../ui/InfoPopover'
import { Icon } from '../../icons'
import { Stale } from '../command/States'
import { RiskAlertsPanel } from '../command/RiskAlertsPanel'
import { ALERT_FETCH_LIMIT } from '../command/riskRanking'
import { PeriodPicker, smartPeriodLabel, weeksBetween } from '../planner/PeriodPicker'
import { useFilterOptions, useRiskAlerts } from '../../hooks/useCommandCenter'
import { useEnsureCommandScope } from '../../hooks/useCommandScope'
import { usePeriodSelection } from '../../hooks/usePeriodSelection'
import { useCommandFilters } from '../../store/commandFilters'
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
 *  trap, not a flow — so the page is reachable, just not by accident.
 *
 *  THE PERIOD SITS BESIDE THE LIST. The events were always scoped to the
 *  Insights Hub's period — pick 2025 there and these are 2025's events — but
 *  that was invisible from here, so a reader who had not just come from the
 *  Hub could not tell WHICH weeks they were looking at, let alone change
 *  them. The calendar on the left is the Hub's own `PeriodPicker` over the
 *  Hub's own filter store (hooks/usePeriodSelection), rendered inline rather
 *  than as a popover over a dialog. It is therefore the SAME selection, not a
 *  copy: a range chosen here is the range the Hub shows on the way back, and
 *  every panel that reads the scope re-answers for it. */

/** ONE HEIGHT FOR BOTH COLUMNS, so the dialog does not resize as the reader
 *  steps through months — tall enough for the calendar's own layout (its
 *  header, the shortcuts, a twelve-month grid and its footer) and capped
 *  against the window, because a laptop at 768px tall cannot show 600px of
 *  dialog plus its header. The calendar scrolls inside itself when capped. */
const COLUMN_H = 'h-[min(648px,calc(100vh-150px))]'

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
  const options = useFilterOptions()
  const period = usePeriodSelection(useCommandFilters, options.data)

  return (
    <Modal open={open} onClose={onClose} closeOnBackdrop={false} maxWidthClassName="max-w-[1080px]">
      <>
          <Header
            icon="alertTriangle"
            title="Promotion events below ROI target"
            subtitle={
              <>
                Judged against the ROI target of{' '}
                <span className="font-medium tabular-nums text-ink-primary">{fmtRoi(meta?.target_roi ?? 1.5)}</span>
                <span className="text-ink-disabled"> · </span>
                {period.start && period.end ? (
                  <>
                    <span className="font-medium text-ink-primary">
                      {smartPeriodLabel(period.start, period.end, period.calendar)}
                    </span>{' '}
                    ({weeksBetween(period.start, period.end, period.calendar)} weeks)
                  </>
                ) : (
                  <span className="font-medium text-ink-primary">every week in the data</span>
                )}
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

          {/* THE PERIOD, THEN THE EVENTS IN IT. One fixed height for both
              columns, so the dialog does not resize as the reader steps
              through months. It stacks below ~940px, where two columns would
              squeeze the list's figures; this is a portalled overlay, so the
              breakpoint is the VIEWPORT's rather than a container query —
              <main> is not this dialog's ancestor. */}
          <div className="grid grid-cols-[388px_1fr] max-[940px]:max-h-[calc(100vh-120px)] max-[940px]:grid-cols-1 max-[940px]:overflow-y-auto">
            <div className={`flex min-h-0 flex-col gap-2 border-r border-border-subtle p-4 max-[940px]:border-b max-[940px]:border-r-0 ${COLUMN_H} max-[940px]:h-[600px]`}>
              <div className="min-h-0 flex-1">
                {period.calendar.length > 0 ? (
                  <PeriodPicker
                    inline
                    calendar={period.calendar}
                    start={period.start}
                    end={period.end}
                    onApply={period.apply}
                    onClear={period.clear}
                  />
                ) : (
                  <div className="flex h-full items-center justify-center gap-2 rounded-[var(--r-lg)] border border-border-subtle text-sm text-ink-muted">
                    <Spinner /> Loading the calendar…
                  </div>
                )}
              </div>
              <p className="shrink-0 text-sm leading-[1.45] text-ink-muted">
                This is the Insights Hub's period — changing it here changes it there too.
              </p>
            </div>

            <div className={`flex min-h-0 min-w-0 flex-col ${COLUMN_H} max-[940px]:h-[460px]`}>
              {alerts.error ? (
                <Message text="Alerts could not be loaded." />
              ) : !alerts.data || (!initialised && alerts.isLoading) ? (
                <Message text="Loading alerts…" spinner />
              ) : alerts.data.alerts.length === 0 ? (
                <div className="flex flex-1 flex-col items-center justify-center gap-1.5 px-6 py-12 text-center">
                  <span className="grid h-10 w-10 place-items-center rounded-full bg-status-success-bg text-status-success [&_svg]:h-5 [&_svg]:w-5">
                    <Icon name="check" />
                  </span>
                  <span className="text-base font-medium text-ink-primary">Every event is at or above target</span>
                  <span className="text-sm text-ink-muted">
                    All {alerts.data.counts.total_events.toLocaleString()} promotion events in this period reached the {fmtRoi(meta?.target_roi ?? 1.5)} target.
                  </span>
                </div>
              ) : (
                // A fixed height, so the panel's own layout — a strip of tabs,
                // six rows spread to the bottom, "View all" beneath — has
                // something to fill, the way the card beside the trend chart
                // gave it one. The Stale wash covers the refetch after a
                // period change: the previous list stays readable but inert
                // until the re-judged one lands.
                <Stale when={alerts.isFetching} className="flex h-full flex-col">
                  <RiskAlertsPanel data={alerts.data} onSelect={onPick} />
                </Stale>
              )}
            </div>
          </div>
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
    <div className="flex flex-1 items-center justify-center gap-2 px-4 py-12 text-sm text-ink-muted">
      {spinner && <Spinner />} {text}
    </div>
  )
}
