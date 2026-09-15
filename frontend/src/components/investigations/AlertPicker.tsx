import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { Icon } from '../../icons'
import { Button, Pill, Spinner } from '../ui'
import { useFilterOptions, useRiskAlerts } from '../../hooks/useCommandCenter'
import { useAlertHandoff } from '../../hooks/useAlertHandoff'
import { useCommandFilters } from '../../store/commandFilters'
import { ALERT_FETCH_LIMIT, topAlerts } from '../command/riskRanking'
import { BREAKEVEN_ROI, fmtRoi } from '../../lib/roi'
import type { RiskAlert } from '../../types/commandCenter'

/** START AN INVESTIGATION FROM AN ALERT, without going back to the Insights Hub.
 *
 *  The workspace used to have exactly one way in from an alert: the "Ask why"
 *  on an Insights Hub row. Once here, starting the next investigation meant
 *  either typing a question from memory or leaving the page. This menu lists
 *  the same underperforming promotion events the Insights Hub ranks — the SAME
 *  query, the SAME priority order, the SAME hand-off — so picking one here is
 *  indistinguishable from clicking its row there: the question, the narrowed
 *  scope and the week all travel exactly as `useAlertHandoff` sends them.
 *
 *  It reads the Insights Hub's own filter scope, so the list is the one the
 *  user last looked at. When the page is opened cold (the scope's default year
 *  not yet resolved) the same year-picking rule the Insights Hub applies is run
 *  here, so the menu never sits empty waiting for a page the user has not
 *  visited.
 *
 *  Nothing is recomputed: every ROI, product, channel and week is the
 *  backend's own figure for that event. */

const SHOWN = 12

const SEVERITIES: RiskAlert['severity'][] = ['Critical', 'High', 'Medium']

// The Insights Hub's own tones (service._SEVERITY_TONE), so a row reads the
// same colour here as on the alerts panel it came from.
const SEVERITY_TONE: Record<RiskAlert['severity'], 'danger' | 'warning' | 'info'> = {
  Critical: 'danger',
  High: 'danger',
  Medium: 'warning',
}

/** "ROI below target — Dussehra Deal 25" -> "Dussehra Deal 25" (the API
 *  appends the promotion after the em dash; nothing here invents a name). */
function promotionOf(alert: RiskAlert): string {
  const dash = alert.title.indexOf('—')
  return dash === -1 ? alert.title : alert.title.slice(dash + 1).trim()
}

export function AlertPicker({ disabled }: { disabled?: boolean }) {
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  // One band at a time. Ranked purely by priority, the first twelve rows were
  // all Critical and the High and Medium bands were unreachable; the Insights
  // Hub panel segments them the same way.
  const [severity, setSeverity] = useState<RiskAlert['severity']>('Critical')
  const anchorRef = useRef<HTMLSpanElement>(null)
  const menuRef = useRef<HTMLDivElement>(null)
  const [coords, setCoords] = useState({ left: 0, top: 0 })

  // The Insights Hub's scope, initialised the way that page initialises it if
  // the user has not been there yet this session.
  const initialised = useCommandFilters((s) => s.initialised)
  const initialise = useCommandFilters((s) => s.initialise)
  const options = useFilterOptions()
  useEffect(() => {
    if (initialised) return
    const years = options.data?.years
    if (!years?.length) return
    const completed = years.filter((y) => y < new Date().getFullYear())
    initialise(Math.max(...(completed.length ? completed : years)))
  }, [initialised, options.data?.years, initialise])

  const alerts = useRiskAlerts(ALERT_FETCH_LIMIT)
  const handoff = useAlertHandoff()

  const ranked = useMemo(() => topAlerts(alerts.data?.alerts, 100000), [alerts.data?.alerts])
  const counts = useMemo(
    () => Object.fromEntries(SEVERITIES.map((sev) => [sev, ranked.filter((a) => a.severity === sev).length])) as Record<RiskAlert['severity'], number>,
    [ranked],
  )
  const shown = useMemo(() => {
    const needle = query.trim().toLowerCase()
    // A typed filter searches every band — the user is naming an event, not
    // a severity — while the tabs browse one band at a time.
    const pool = needle
      ? ranked.filter((a) =>
          [promotionOf(a), a.product, a.channel, a.week].some((s) => s.toLowerCase().includes(needle)),
        )
      : ranked.filter((a) => a.severity === severity)
    return pool.slice(0, SHOWN)
  }, [ranked, query, severity])

  useLayoutEffect(() => {
    if (!open || !anchorRef.current || !menuRef.current) return
    const rect = anchorRef.current.getBoundingClientRect()
    const { offsetWidth: w, offsetHeight: h } = menuRef.current
    const pad = 8
    // Right-aligned to the trigger, kept inside the viewport both ways.
    let left = rect.right - w
    if (left < pad) left = pad
    let top = rect.bottom + 6
    if (top + h > window.innerHeight - pad) top = Math.max(pad, rect.top - h - 6)
    setCoords({ left, top })
  }, [open, shown.length, severity])

  useEffect(() => {
    if (!open) return
    const close = (e: MouseEvent) => {
      if (
        anchorRef.current &&
        !anchorRef.current.contains(e.target as Node) &&
        menuRef.current &&
        !menuRef.current.contains(e.target as Node)
      ) {
        setOpen(false)
      }
    }
    const esc = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false)
    }
    document.addEventListener('click', close)
    document.addEventListener('keydown', esc)
    return () => {
      document.removeEventListener('click', close)
      document.removeEventListener('keydown', esc)
    }
  }, [open])

  const total = alerts.data?.alerts.length ?? 0

  return (
    <>
      <span ref={anchorRef}>
        <Button
          variant="ghost"
          disabled={disabled}
          onClick={() => setOpen((v) => !v)}
          className="shrink-0 whitespace-nowrap"
          aria-haspopup="listbox"
          aria-expanded={open}
        >
          <Icon name="alertTriangle" /> <span>From an alert</span> <Icon name="chevronDown" />
        </Button>
      </span>
      {open &&
        createPortal(
          <div
            ref={menuRef}
            role="listbox"
            aria-label="Underperforming promotion events"
            className="fade-in-up fixed z-[9999] flex w-[460px] max-w-[calc(100vw-16px)] flex-col rounded-[var(--r-md)] border border-border-default bg-surface-card shadow-[var(--shadow-lg)]"
            style={{ left: coords.left, top: coords.top }}
          >
            <div className="border-b border-border-subtle p-3">
              <div className="flex items-center justify-between gap-2">
                <div className="text-sm font-bold text-ink-primary">Promotion events below ROI target</div>
                {total > 0 && <span className="text-xs text-ink-muted">{total.toLocaleString()} in scope</span>}
              </div>
              <div className="mt-2 flex gap-1" role="tablist" aria-label="Severity">
                {SEVERITIES.map((sev) => (
                  <button
                    key={sev}
                    type="button"
                    role="tab"
                    aria-selected={severity === sev && !query.trim()}
                    onClick={() => setSeverity(sev)}
                    className={`inline-flex h-7 items-center gap-1.5 rounded-[var(--r-pill)] px-2.5 text-xs font-semibold transition-colors ${
                      severity === sev && !query.trim()
                        ? 'bg-ink-primary text-white'
                        : 'bg-surface-muted text-ink-secondary hover:bg-surface-hover'
                    }`}
                  >
                    {sev}
                    <span className="tabular-nums opacity-70">{counts[sev].toLocaleString()}</span>
                  </button>
                ))}
              </div>
              <div className="mt-2 flex items-center gap-2 rounded-[var(--r-sm)] border border-border-default bg-surface-muted px-2.5 py-1.5 focus-within:border-brand-violet">
                <Icon name="search" className="h-3.5 w-3.5 shrink-0 text-ink-muted" />
                <input
                  autoFocus
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                  placeholder="Filter by promotion, product, channel or week"
                  className="min-w-0 flex-1 border-0 bg-transparent text-sm text-ink-primary outline-none placeholder:text-ink-muted"
                />
              </div>
            </div>

            <div className="max-h-[360px] overflow-y-auto p-1.5">
              {alerts.isLoading || (!initialised && !alerts.data) ? (
                <div className="flex items-center gap-2 px-3 py-6 text-sm text-ink-muted">
                  <Spinner /> Loading alerts…
                </div>
              ) : alerts.error ? (
                <div className="px-3 py-6 text-sm text-ink-muted">Alerts could not be loaded.</div>
              ) : shown.length === 0 ? (
                <div className="px-3 py-6 text-sm text-ink-muted">
                  {ranked.length ? (query.trim() ? 'Nothing matches that filter.' : `No ${severity} events in this scope.`) : 'No promotion event is below target in this scope.'}
                </div>
              ) : (
                shown.map((a) => {
                  const roi = a.roi_multiple
                  return (
                    <button
                      key={a.id}
                      type="button"
                      role="option"
                      aria-selected={false}
                      onClick={() => {
                        setOpen(false)
                        setQuery('')
                        handoff(a)
                      }}
                      className="flex w-full cursor-pointer items-center gap-3 rounded-[var(--r-sm)] px-2.5 py-2 text-left hover:bg-surface-hover"
                    >
                      <Pill tone={SEVERITY_TONE[a.severity]} className="w-[68px] shrink-0 justify-center">
                        {a.severity}
                      </Pill>
                      <span className="min-w-0 flex-1">
                        <span className="block truncate text-sm font-bold text-ink-primary">{promotionOf(a)}</span>
                        <span className="block truncate text-xs text-ink-muted">
                          {a.product} · {a.channel} · {a.week}
                        </span>
                      </span>
                      <span className="shrink-0 text-right">
                        <span
                          className={`block text-sm font-bold tabular-nums ${
                            roi !== null && roi < BREAKEVEN_ROI ? 'text-status-danger' : 'text-ink-primary'
                          }`}
                        >
                          ROI {fmtRoi(roi)}
                        </span>
                        <span className="block text-xs text-ink-muted">{a.at_stake_display} at stake</span>
                      </span>
                    </button>
                  )
                })
              )}
            </div>

            <div className="border-t border-border-subtle px-3 py-2 text-xs leading-[1.5] text-ink-muted">
              {shown.length >= SHOWN
                ? `Top ${SHOWN} of the ${query.trim() ? 'matches' : severity + ' band'} by priority — type above to narrow. `
                : ''}
              You can also close this and type or paste any question into the bar — an alert's own description from
              the Insights Hub works as-is.
            </div>
          </div>,
          document.body,
        )}
    </>
  )
}
