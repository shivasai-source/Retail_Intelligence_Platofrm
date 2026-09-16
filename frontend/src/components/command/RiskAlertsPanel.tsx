import { useMemo, useState } from 'react'
import { IconButton, Modal } from '../ui'
import { Icon, type IconName } from '../../icons'
import { SEVERITIES, rankByImpact, type Severity } from './riskRanking'
import type { RiskAlert, RiskAlertsResponse } from '../../types/commandCenter'
import { ROI_TONE_CLASS, fmtRoi, roiTone } from '../../lib/roi'

/** Top Risk Alerts, segmented by severity.
 *
 *  Severity picks the segment; financial impact orders it. Within the selected
 *  band the five events with the most money At Stake are shown, with the weaker
 *  ROI breaking ties.
 *
 *  The full alert set for the scope is still fetched rather than a truncated
 *  page: the API emits one concatenated Critical -> High -> Medium list and
 *  truncates the tail, so the top of the High band sits behind every Critical
 *  and cannot be reached by a small `limit`. Nothing is recomputed here — every
 *  ROI, stake and severity is the value the backend produced.
 *
 *  TWO WAYS IN, ONE HAND-OFF. An alert row hands the clicked event over
 *  through `onSelect`; a severity opens that band's own list, from which the
 *  user picks a specific event that goes through THE SAME `onSelect`. A
 *  severity is a band, not an event, so selecting one narrows the list and
 *  does nothing else — it never stands in for a promotion, and no identifier
 *  is derived from the word "Critical".
 */

const SEVERITY_ICON: Record<Severity, IconName> = {
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

/** "ROI below target — Diwali Special 25" -> "Diwali Special 25". The API
 *  builds the title from the promotion name; this recovers it rather than
 *  repeating the string. */
function promotionOf(alert: RiskAlert): string {
  const dash = alert.title.indexOf('—')
  return dash === -1 ? alert.title : alert.title.slice(dash + 1).trim()
}

/** Rows on the card. Six, not five: the rows rest as one line each now, and
 *  the card is as tall as the trend chart beside it, so five left a blank
 *  band above "View all". The list also stretches to that height and
 *  spreads its rows across it -- see the list container below. */
const PER_SEGMENT = 6

/** How many rows the severity list renders. A band can hold several hundred
 *  events, and this cap is STATED in the list's own header rather than applied
 *  silently — the rows shown are the highest-impact ones, in the same order
 *  the panel itself uses. */
const PER_SEVERITY_LIST = 100

export function RiskAlertsPanel({
  data,
  onSelect,
}: {
  data: RiskAlertsResponse
  onSelect?: (alert: RiskAlert) => void
}) {
  const [severity, setSeverity] = useState<Severity>('Critical')
  /** The severity whose full list is open, or null. Held apart from the tab
   *  selection so opening a band does not disturb what the panel shows behind
   *  it. */
  const [listing, setListing] = useState<Severity | null>(null)

  const counts: Record<Severity, number> = {
    Critical: data.counts.critical,
    High: data.counts.high,
    Medium: data.counts.medium,
  }

  // Default to the most severe band that actually has alerts, so the panel
  // never opens on an empty segment when e.g. nothing is Critical.
  const active = counts[severity] > 0 ? severity : (SEVERITIES.find((s) => counts[s] > 0) ?? severity)

  // The whole band, ranked. `rows` is its head and the severity list renders
  // the same array, so a row cannot change place between the two views.
  const ranked = useMemo(
    () => data.alerts.filter((a) => a.severity === active).sort(rankByImpact),
    [data.alerts, active],
  )
  const rows = useMemo(() => ranked.slice(0, PER_SEGMENT), [ranked])

  const listedRanked = useMemo(
    () => (listing === null ? [] : data.alerts.filter((a) => a.severity === listing).sort(rankByImpact)),
    [data.alerts, listing],
  )

  /** Hand the clicked EVENT over. Closes the severity list first so the
   *  hand-off's own toast and navigation are not left behind a backdrop. */
  const choose = (alert: RiskAlert) => {
    setListing(null)
    onSelect?.(alert)
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div
        className="flex items-center gap-1 border-b border-border-subtle px-5 py-2.5"
        role="tablist"
        aria-label="Alert severity"
      >
        {SEVERITIES.map((s) => {
          const on = s === active
          return (
            <button
              key={s}
              type="button"
              role="tab"
              aria-selected={on}
              disabled={counts[s] === 0}
              onClick={() => setSeverity(s)}
              className={`inline-flex cursor-pointer items-center gap-1.5 rounded-[var(--r-md)] px-2.5 py-1 text-sm font-semibold transition-colors duration-150 focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-violet disabled:cursor-not-allowed disabled:opacity-40 ${
                on
                  ? 'bg-brand-violet text-white'
                  : 'text-ink-muted hover:bg-surface-hover hover:text-ink-primary'
              }`}
            >
              {s}
              <span className={on ? 'text-white/75' : 'text-ink-disabled'}>{counts[s]}</span>
            </button>
          )
        })}
        {/* The denominator the three bands are cut from, at the strip's far
            end where it has room; see the card header in pages/CommandCenter. */}
        <span className="ml-auto whitespace-nowrap text-xs font-semibold text-ink-muted">
          {data.counts.target_achieved} of {data.counts.total_events} at target
        </span>
      </div>

      {rows.length === 0 ? (
        <div className="grid min-h-[120px] flex-1 place-items-center px-4 text-center text-sm text-ink-muted">
          No {active.toLowerCase()} alerts in this selection.
        </div>
      ) : (
        <>
          {/* Takes the height the card has and spreads the rows over it, so
              the list ends where the card ends instead of a few rows short.
              `justify-between` is the one distribution that stays safe when
              the rows overflow (it falls back to flex-start); min-h-0 lets
              the column shrink enough to scroll at all. */}
          <div className="flex min-h-0 flex-1 flex-col justify-between overflow-y-auto px-5">
            {rows.map((a, i) => (
              <AlertRow
                key={a.id}
                alert={a}
                onSelect={choose}
                delayMs={i * 60}
                flip={i === rows.length - 1}
                targetRoi={data.meta.target_roi}
              />
            ))}
          </div>

          {/* How the rest of the SAME band is reached. The rows above are its
              head; every event behind them hands off exactly as they do. */}
          {counts[active] > rows.length && (
            <div className="border-t border-border-subtle px-5 py-2.5">
              <button
                type="button"
                onClick={() => setListing(active)}
                className="inline-flex cursor-pointer items-center gap-1 rounded-[var(--r-sm)] px-1.5 py-1 text-sm font-semibold text-brand-violet transition-colors duration-150 hover:bg-brand-violet-50 focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-violet [&_svg]:h-3 [&_svg]:w-3"
              >
                View all {counts[active].toLocaleString()} {active.toLowerCase()} alerts
                <Icon name="arrowRight" />
              </button>
            </div>
          )}
        </>
      )}

      <SeverityListModal
        severity={listing}
        alerts={listedRanked}
        total={listing === null ? 0 : counts[listing]}
        onClose={() => setListing(null)}
        onSelect={choose}
        targetRoi={data.meta.target_roi}
      />
    </div>
  )
}

/** One alert event. A BUTTON, because clicking it starts an investigation —
 *  the row is reachable and activatable from the keyboard for the same reason
 *  it is clickable with a mouse. */
function AlertRow({
  alert: a,
  onSelect,
  delayMs,
  flip = false,
  targetRoi,
}: {
  alert: RiskAlert
  onSelect: (alert: RiskAlert) => void
  delayMs: number
  /** `meta.target_roi` — what the row's ROI is judged against. */
  targetRoi: number
  /** Open the detail box ABOVE the row. For the last row of a scrolling
   *  list, where a box below it would be clipped by the list's edge. */
  flip?: boolean
}) {
  const roi = a.roi_multiple ?? 0
  return (
    <button
      type="button"
      onClick={() => onSelect(a)}
      aria-label={`Investigate ${promotionOf(a)} — ${a.product}, ${a.channel}, ${a.week}`}
      /* hover:z-30: `fade-in-up` animates opacity, which makes every row its own
         stacking context and traps the detail box's z-index inside it -- the
         next row then painted over the box. Lifting the hovered ROW puts its
         box above its siblings. */
      className="group fade-in-up relative grid w-full cursor-pointer grid-cols-[36px_1fr_auto] items-center gap-x-2.5 rounded-lg border-b border-border-subtle py-3 text-left transition-colors duration-150 last:border-b-0 hover:z-30 hover:bg-surface-hover focus:outline-none focus-visible:z-30 focus-visible:ring-2 focus-visible:ring-brand-violet"
      style={{ animationDelay: `${delayMs}ms` }}
    >
      <div
        className="grid h-9 w-9 place-items-center rounded-[10px] [&_svg]:h-[18px] [&_svg]:w-[18px]"
        style={{ background: TONE_BG[a.tone], color: TONE_FG[a.tone] }}
      >
        <Icon name={SEVERITY_ICON[a.severity]} />
      </div>

      {/* The row is the promotion and its ROI, like every other ranked row on
          the page. The event behind it -- week, channel, product, money at
          stake -- is in the detail box below, which opens on hover or
          keyboard focus. The aria-label above carries the same detail for
          assistive tech. */}
      <div className="flex min-w-0 items-baseline justify-between gap-3">
        <span className="truncate text-base font-bold text-ink-primary">{promotionOf(a)}</span>
        <span
          className={`shrink-0 text-sm font-bold tabular-nums ${ROI_TONE_CLASS[roiTone(roi, targetRoi)]}`}
        >
          ROI {fmtRoi(roi)}
        </span>
      </div>

      {/* No severity pill: the row already sits under the severity tab it
          belongs to, and the icon tint says the same thing again. */}
      <span className="inline-flex shrink-0 items-center gap-1 whitespace-nowrap text-xs font-semibold text-brand-violet [&_svg]:h-3 [&_svg]:w-3">
        Ask why
        <Icon name="arrowRight" />
      </span>

      {/* ONE detail box, drawn by the page, not the browser. There used to be
          two things on hover: a reserved line under the name AND the native
          `title` tooltip, which the browser shows only after its own ~1s
          delay and which no CSS can hurry. This is the chart tooltip the
          trend and column cards already use, shown the instant the row is
          hovered or focused. Absolutely positioned, so opening it moves
          nothing; `flip` puts it above the last row of a scrolling list. */}
      <div
        role="tooltip"
        className={`pointer-events-none absolute left-[46px] z-20 hidden w-max max-w-[calc(100%-46px)] rounded-[var(--r-md)] border border-border-default bg-surface-card px-3 py-2 text-xs shadow-[var(--shadow-lg)] group-hover:block group-focus-visible:block ${
          flip ? 'bottom-[calc(100%-4px)]' : 'top-[calc(100%-4px)]'
        }`}
      >
        <div className="truncate font-semibold text-ink-primary">{a.product}</div>
        <div className="mt-0.5 flex items-baseline justify-between gap-4 text-ink-muted">
          <span className="truncate">
            {a.channel} · {a.week}
          </span>
          <span className="shrink-0 tabular-nums">{a.at_stake_display} at stake</span>
        </div>
      </div>
    </button>
  )
}

/** One severity band, listed.
 *
 *  A SEVERITY IS NOT A PROMOTION. This is what a severity click resolves to:
 *  the band's own events, so the user picks the specific one they mean before
 *  anything narrows to it. Nothing here invents an identifier, and the rows
 *  are the same objects, in the same ranking, that the panel renders.
 */
function SeverityListModal({
  severity,
  alerts,
  total,
  onClose,
  onSelect,
  targetRoi,
}: {
  severity: Severity | null
  alerts: RiskAlert[]
  total: number
  onClose: () => void
  onSelect: (alert: RiskAlert) => void
  targetRoi: number
}) {
  const shown = alerts.slice(0, PER_SEVERITY_LIST)

  return (
    <Modal open={severity !== null} onClose={onClose} maxWidthClassName="max-w-[720px]">
      {severity !== null && (
        <>
          <div className="flex items-center justify-between border-b border-border-subtle p-[16px_20px]">
            <div>
              <h3 className="text-md font-bold">{severity} risk alerts</h3>
              <div className="mt-0.5 text-sm text-ink-muted">
                {/* The cap is named, not hidden: a band of several hundred
                    events would otherwise read as though it held only these. */}
                {shown.length < total
                  ? `The ${shown.length} highest-impact of ${total.toLocaleString()} — highest stake first.`
                  : `${total.toLocaleString()} event${total === 1 ? '' : 's'} — highest stake first.`}{' '}
                Pick one to investigate.
              </div>
            </div>
            <IconButton icon="x" title="Close" onClick={onClose} />
          </div>

          <div className="max-h-[60vh] overflow-y-auto px-5">
            {shown.map((a, i) => (
              <AlertRow
                key={a.id}
                alert={a}
                onSelect={onSelect}
                delayMs={0}
                flip={i === shown.length - 1}
                targetRoi={targetRoi}
              />
            ))}
          </div>
        </>
      )}
    </Modal>
  )
}
