import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { Icon, type IconName } from '../../icons'
import { IconButton } from '../ui'
import { useRiskAlerts } from '../../hooks/useCommandCenter'
import { useAlertHandoff } from '../../hooks/useAlertHandoff'
import { ALERT_FETCH_LIMIT, alertHeadline, topAlerts } from './riskRanking'
import type { RiskAlert } from '../../types/commandCenter'
import { BREAKEVEN_ROI, fmtRoi } from '../../lib/roi'

/** The header's notification centre.
 *
 *  IT COMPUTES NOTHING. Every figure below — ROI, At Stake, severity, the
 *  counts — is the value `/api/command-center/risk-alerts` produced, read
 *  through the SAME `useRiskAlerts` hook the Insights Hub's own panel uses,
 *  at the SAME `ALERT_FETCH_LIMIT`. React Query therefore serves both from one
 *  cache entry: the bell costs no extra request, and it cannot disagree with
 *  the panel beneath it.
 *
 *  THE SCOPE IS THE COMMAND CENTER'S. `useRiskAlerts` reads the shared filter
 *  store, so changing a filter refreshes the badge and the list with it. No
 *  filter is added, removed or interpreted here.
 *
 *  THE ORDER IS THE EXISTING ONE. `topAlerts` is the ranking the hero banner
 *  already uses — severity band, then At Stake descending — which is also the
 *  order the backend emits. Nothing new is invented to pick the top three.
 *
 *  NO TIMESTAMP IS SHOWN, because the API supplies none. A risk alert carries
 *  the business `week` the event ran in and nothing finer, so that is what the
 *  row shows. Rendering "2h ago" against a figure with no time behind it would
 *  be a fabricated detail.
 *
 *  THE BELL IS THE INDICATOR. No badge, dot, count or halo: while the scope
 *  holds alerts the bell RINGS — a damped swing about its hanger, 600ms once
 *  every 5 seconds, then completely still. The figure lives in the panel the
 *  bell opens; on this data an unfiltered year carries 1,570 alerts, a number
 *  that informs nobody sitting on an icon.
 *
 *  It rings on its own, not on hover: something needing attention should say so
 *  while nobody is pointing at it. Opening the panel PAUSES the ring — the user
 *  is reading the alerts, so the thing that pointed at them has done its job.
 *
 *  At zero alerts the bell is inert. Under `prefers-reduced-motion` it does not
 *  move at all and takes the brand accent instead, so the state survives for a
 *  reader who cannot use motion. See `.bell-ring` in index.css.
 */

/** How many alerts the panel shows. The rest stay in the Insights Hub's own
 *  Risk Alerts panel, which is what the footer links to. */
const TOP_N = 3

const PANEL_W = 344
/** Gap from the viewport edge when the panel would otherwise overflow. */
const MARGIN = 8



const SEVERITY_ICON: Record<RiskAlert['severity'], IconName> = {
  Critical: 'warning',
  High: 'alertTriangle',
  Medium: 'trendingDown',
}

const TONE_BG: Record<RiskAlert['tone'], string> = {
  danger: 'var(--status-danger-bg)',
  warning: 'var(--status-warning-bg)',
  info: 'var(--status-info-bg)',
}
const TONE_FG: Record<RiskAlert['tone'], string> = {
  danger: 'var(--status-danger)',
  warning: 'var(--status-warning)',
  info: 'var(--status-info)',
}

export function NotificationBell() {
  const [open, setOpen] = useState(false)
  const [coords, setCoords] = useState({ left: 0, top: 0, width: PANEL_W })
  const anchorRef = useRef<HTMLDivElement>(null)
  const panelRef = useRef<HTMLDivElement>(null)

  const alerts = useRiskAlerts(ALERT_FETCH_LIMIT)
  const handOff = useAlertHandoff()

  const counts = alerts.data?.counts
  // Every banded alert, not just the rows on screen: `alerts[]` is capped by
  // the request's limit, `counts` is not. It decides whether the signal shows
  // at all, and it is what the panel header and the aria-label report.
  const total = counts ? counts.critical + counts.high + counts.medium : 0
  const rows = topAlerts(alerts.data?.alerts, TOP_N)

  /** Right-align the panel to the bell, then clamp it inside the viewport so a
   *  narrow window can never push it off-screen or scroll the page sideways. */
  useLayoutEffect(() => {
    if (!open || !anchorRef.current) return
    const rect = anchorRef.current.getBoundingClientRect()
    const width = Math.min(PANEL_W, window.innerWidth - MARGIN * 2)
    const left = Math.max(MARGIN, Math.min(rect.right - width, window.innerWidth - width - MARGIN))
    setCoords({ left, top: rect.bottom + 8, width })
  }, [open])

  // Outside click and Escape close it; the bell itself toggles, so the anchor is
  // excluded here or the two would fight and the panel would never open.
  useEffect(() => {
    if (!open) return
    const onPointer = (e: MouseEvent) => {
      const target = e.target as Node
      if (anchorRef.current?.contains(target) || panelRef.current?.contains(target)) return
      setOpen(false)
    }
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && setOpen(false)
    // Closed rather than repositioned on resize: a stale offset is the one way
    // this could overflow, and reopening is one click.
    const onResize = () => setOpen(false)
    document.addEventListener('mousedown', onPointer)
    document.addEventListener('keydown', onKey)
    window.addEventListener('resize', onResize)
    return () => {
      document.removeEventListener('mousedown', onPointer)
      document.removeEventListener('keydown', onKey)
      window.removeEventListener('resize', onResize)
    }
  }, [open])

  const openAlert = (alert: RiskAlert) => {
    setOpen(false)
    handOff(alert)
  }

  // WHETHER alerts exist, never HOW MANY: the bell signals state, and the count
  // lives in the panel it opens.
  const active = total > 0

  return (
    <div
      ref={anchorRef}
      className={`bell-wrap relative flex items-center ${open ? 'bell-wrap-open' : ''}`}
    >
      <IconButton
        icon="bell"
        className={active ? 'bell-ring' : undefined}
        title={active ? 'Risk alerts in this scope' : 'Notifications'}
        aria-haspopup="dialog"
        aria-expanded={open}
        // The count is deliberately absent from the visual, but a screen reader
        // has no signal to perceive, so it is stated here.
        aria-label={active ? `Notifications, ${total} risk alerts in scope` : 'Notifications, none'}
        onClick={() => setOpen((v) => !v)}
      />

      {open &&
        createPortal(
          <div
            ref={panelRef}
            role="dialog"
            aria-label="Notifications"
            className="fade-in-up fixed z-[9999] overflow-hidden rounded-[var(--r-md)] border border-border-default bg-surface-card shadow-[var(--shadow-lg)]"
            style={{ left: coords.left, top: coords.top, width: coords.width }}
          >
            <div className="flex items-center justify-between border-b border-border-subtle px-4 py-2.5">
              <span className="text-base font-bold text-ink-primary">Notifications</span>
              {total > 0 && (
                <span className="rounded-full bg-status-danger-bg px-2 py-0.5 text-xs font-bold tabular-nums text-status-danger">
                  {total}
                </span>
              )}
            </div>

            <PanelBody
              rows={rows}
              total={total}
              hasData={Boolean(alerts.data)}
              loading={alerts.isFetching && !alerts.data}
              error={Boolean(alerts.error)}
              onSelect={openAlert}
            />

            {rows.length > 0 && total > rows.length && (
              <div className="border-t border-border-subtle px-4 py-2 text-xs text-ink-muted">
                Showing the top {rows.length} of {total}. The Insights Hub lists them all.
              </div>
            )}
          </div>,
          document.body,
        )}
    </div>
  )
}

function PanelBody({
  rows,
  total,
  hasData,
  loading,
  error,
  onSelect,
}: {
  rows: RiskAlert[]
  total: number
  hasData: boolean
  loading: boolean
  error: boolean
  onSelect: (alert: RiskAlert) => void
}) {
  if (error) return <Message text="Could not load alerts." />
  if (loading) return <Message text="Loading alerts…" />
  // Not an empty state: alerts are scoped to the Insights Hub's selection,
  // and before that has resolved there is nothing to report either way. Saying
  // "no alerts" here would be a claim the client cannot support yet.
  if (!hasData) return <Message text="Open the Insights Hub to load alerts." />

  if (total === 0) {
    return (
      <div className="flex flex-col items-center gap-1.5 px-4 py-8 text-center">
        <span className="grid h-9 w-9 place-items-center rounded-full bg-status-success-bg text-status-success [&_svg]:h-[18px] [&_svg]:w-[18px]">
          <Icon name="check" />
        </span>
        <span className="text-base font-bold text-ink-primary">No active alerts</span>
        <span className="text-sm text-ink-muted">Everything looks good.</span>
      </div>
    )
  }

  return (
    <div className="max-h-[min(60vh,360px)] overflow-y-auto">
      {rows.map((a) => (
        <AlertRow key={a.id} alert={a} onSelect={onSelect} />
      ))}
    </div>
  )
}

function Message({ text }: { text: string }) {
  return <div className="px-4 py-7 text-center text-sm text-ink-muted">{text}</div>
}

function AlertRow({ alert, onSelect }: { alert: RiskAlert; onSelect: (a: RiskAlert) => void }) {
  const roi = alert.roi_multiple
  return (
    <button
      type="button"
      onClick={() => onSelect(alert)}
      title={`${alert.title} · ${alert.product} · ${alert.channel} · ${alert.week}`}
      aria-label={`${alert.severity}: ${alert.title}, ${alert.product}, ${alert.channel}, ${alert.week}. Investigate.`}
      className="grid w-full cursor-pointer grid-cols-[28px_1fr] items-start gap-2.5 border-b border-border-subtle px-4 py-2.5 text-left transition-colors duration-150 last:border-b-0 hover:bg-surface-hover focus:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-brand-violet"
    >
      <span
        className="mt-0.5 grid h-7 w-7 place-items-center rounded-lg [&_svg]:h-3.5 [&_svg]:w-3.5"
        style={{ background: TONE_BG[alert.tone], color: TONE_FG[alert.tone] }}
        title={alert.severity}
      >
        <Icon name={SEVERITY_ICON[alert.severity]} />
      </span>

      <span className="min-w-0">
        <span className="flex items-baseline gap-1.5">
          <span className="truncate text-base font-bold text-ink-primary">
            {alertHeadline(alert)}
          </span>
          <span
            className="shrink-0 text-2xs font-bold uppercase tracking-[0.03em]"
            style={{ color: TONE_FG[alert.tone] }}
          >
            {alert.severity}
          </span>
        </span>
        <span className="mt-0.5 block truncate text-sm text-ink-muted">
          {alert.product_id} · {alert.channel}
        </span>
        <span className="mt-0.5 flex items-center gap-1.5 text-xs tabular-nums">
          <span
            className={
              roi !== null && roi < BREAKEVEN_ROI ? 'font-bold text-status-danger' : 'font-bold text-ink-primary'
            }
          >
            ROI {fmtRoi(roi)}
          </span>
          <span className="truncate text-ink-muted">· {alert.at_stake_display} at stake</span>
        </span>
        {/* The business week the event ran. The API carries no timestamp, so no
            relative time is shown — see the note at the top of this file. */}
        <span className="mt-0.5 block text-xs text-ink-disabled">{alert.week}</span>
      </span>
    </button>
  )
}
