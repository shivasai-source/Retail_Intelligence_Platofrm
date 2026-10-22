import { useEffect, useRef, useState } from 'react'
import { useIsFetching } from '@tanstack/react-query'
import { Icon } from '../../icons'
import { LiveStatus, useToast } from '../../components/ui'
import { SyncOverlay } from '../../components/layout/SyncOverlay'
import { useMmmSource, useMmmSourceSync } from '../hooks'
import { MmmSyncSummary, unchanged } from './MmmSyncSummary'
import { useMmmView } from '../store'
import type { MmmSyncResult } from '../types'

// MMM'S LIVE PILL — TPO's pill (components/layout/SyncStatus), over MMM's own
// source.
//
// A dataset installed from Azure Blob or Databricks is a snapshot of a source
// that grows every morning. Clicking the pill re-reads the same blob or table,
// WITH THE SAME COLUMN MAPPING the install was given, and swaps it in
// (backend/app/mmm/source_sync.py), so yesterday's spend and revenue arrive
// without walking the connector dialog again. What the pill says is then the
// real "last synced" time from the server, not a page-visit timer.
//
// A dataset from a file upload has nothing to re-read, so it keeps the plain
// timer pill — exactly as TPO's does.
//
// THE RELOAD IS PART OF THE SYNC. When the request returns, the page still
// shows the OLD numbers: every MMM query has just been invalidated and has to
// come back. So the overlay holds its "Sync complete" state until those
// queries land, and only then does the summary appear — the same two-stage
// wait TPO's pill makes visible, for the same reason: otherwise the only sign
// left that anything is loading is a spinning icon in a toolbar.

/** How long "Sync complete" stays up once the pages have their new numbers. */
const MIN_DONE_MS = 900
/** Grace for the invalidated queries to START coming back. */
const START_GRACE_MS = 700
/** The overlay never holds the page longer than this, whatever is in flight. */
const MAX_DONE_MS = 25_000

const ROWS = new Intl.NumberFormat('en-IN')

function ago(iso: string, now: number): string {
  const s = Math.max(0, Math.floor((now - Date.parse(iso)) / 1000))
  if (s < 60) return 'just now'
  if (s < 3600) return `${Math.floor(s / 60)} min ago`
  if (s < 86400) return `${Math.floor(s / 3600)} h ago`
  return `${Math.floor(s / 86400)} d ago`
}

export function MmmSyncStatus({
  liveLabel,
  onSynced,
  className = '',
}: {
  /** The page-visit timer, shown when the data cannot be synced. */
  liveLabel: string
  /** Restarts that timer, so pages that read it agree with the pill. */
  onSynced: () => void
  className?: string
}) {
  const { data: source } = useMmmSource()
  const sync = useMmmSourceSync()
  const { show } = useToast()
  const [now, setNow] = useState(() => Date.now())
  const [summary, setSummary] = useState<MmmSyncResult | null>(null)
  const [finishing, setFinishing] = useState(false)
  const pending = useRef<MmmSyncResult | null>(null)
  const returnedAt = useRef(0)
  const sawReload = useRef(false)
  const reloading = useIsFetching()

  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 15000)
    return () => window.clearInterval(timer)
  }, [])

  useEffect(() => {
    if (!finishing) return
    if (reloading > 0) {
      sawReload.current = true
      return
    }
    const elapsed = Date.now() - returnedAt.current
    const wait = Math.max(sawReload.current ? 0 : START_GRACE_MS, MIN_DONE_MS - elapsed)
    const timer = window.setTimeout(() => {
      setFinishing(false)
      setSummary(pending.current)
    }, wait)
    return () => window.clearTimeout(timer)
  }, [finishing, reloading])

  // Nothing holds the page for ever — a background poll that never settles
  // must not keep the overlay up.
  useEffect(() => {
    if (!finishing) return
    const timer = window.setTimeout(() => {
      setFinishing(false)
      setSummary(pending.current)
    }, MAX_DONE_MS)
    return () => window.clearTimeout(timer)
  }, [finishing])

  if (!source?.syncable) return <LiveStatus label={liveLabel} className={className} />

  const last = source.last_sync
  const failed = last !== null && !last.ok
  const busy = sync.isPending || source.syncing

  const onClick = () => {
    if (busy) return
    sync.mutate(undefined, {
      onSuccess: (r) => {
        setNow(Date.now())
        onSynced()
        // EVERY MMM PAGE OPENS ON THE NEW DATA. A sync can change which years
        // and weeks exist; a scope chosen before it may now select nothing —
        // and an empty Insights Hub reads as broken rather than as a stale
        // filter. `reset` goes back to the latest year OF THE NEW DATA, which
        // is where the pages open anyway. Left alone when the source held
        // nothing new, so a quiet sync does not move the reader.
        if (!unchanged(r.before, r.after)) useMmmView.getState().reset()
        pending.current = r
        returnedAt.current = Date.now()
        sawReload.current = false
        setFinishing(true)
      },
      onError: (e) => {
        show(`Sync failed — the previous data is still loaded. ${e.message}`, {
          variant: 'error',
          duration: 7000,
        })
      },
    })
  }

  const title = busy
    ? `Pulling the latest data from ${source.label}…`
    : failed
      ? `The last sync failed: ${last.error ?? 'unknown error'}. Click to try again.`
      : `Click to pull the latest data from ${source.label}${source.origin ? ` (${source.origin})` : ''}.` +
        (last?.rows != null ? ` Loaded now: ${ROWS.format(last.rows)} days.` : '') +
        (source.mapped_columns
          ? ` ${source.mapped_columns} mapped column${source.mapped_columns === 1 ? '' : 's'} are re-applied on every pull.`
          : '')

  return (
    <>
      {(busy || finishing) && (
        <SyncOverlay
          kind={source.kind === 'azure' ? 'azure' : 'databricks'}
          source={source.label ?? 'the source'}
          items={source.items}
          stage={busy ? 'pulling' : reloading > 0 || !sawReload.current ? 'loading' : 'done'}
        />
      )}
      {summary && <MmmSyncSummary result={summary} onClose={() => setSummary(null)} />}
      <button
        type="button"
        onClick={onClick}
        disabled={busy}
        title={title}
        aria-label={title}
        className={`group inline-flex cursor-pointer items-center gap-1.5 rounded-[var(--r-pill)] border border-border-subtle bg-surface-card px-3 py-1 text-sm text-ink-secondary transition-colors duration-150 hover:border-brand-violet hover:text-ink-primary focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-violet disabled:cursor-progress ${className}`}
      >
        <span
          className={`inline-block h-[7px] w-[7px] rounded-full ${
            failed && !busy ? 'bg-status-warning' : 'animate-[liveDot_1.4s_infinite] bg-status-success'
          }`}
        />
        {busy ? (
          <span>
            Syncing from <strong className="font-medium text-ink-primary">{source.label}</strong>…
          </span>
        ) : failed ? (
          <span>
            <strong className="font-medium text-status-warning">Sync failed</strong> · retry
          </span>
        ) : (
          <span>
            <strong className="font-medium text-status-success">Live</strong> · synced{' '}
            {ago(last?.at ?? source.saved_at ?? new Date(now).toISOString(), now)}
          </span>
        )}
        <Icon
          name="refresh"
          className={`h-3.5 w-3.5 stroke-2 ${busy ? 'animate-spin text-brand-violet' : 'text-ink-muted group-hover:text-brand-violet'}`}
        />
      </button>
    </>
  )
}
