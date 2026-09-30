import { useEffect, useState } from 'react'
import { Icon } from '../../icons'
import { LiveStatus, useToast } from '../ui'
import { useSourceStatus, useSourceSync } from '../../hooks/useDatasets'

// THE LIVE PILL, WHEN THERE IS SOMETHING TO SYNC FROM.
//
// A dataset installed from Azure Blob or Databricks is a snapshot of a source
// that keeps growing. Clicking the pill pulls the same blobs or tables again
// and swaps them in (backend/app/source_sync.py), so rows added at the source
// since the install arrive without a Reset and a re-upload. What the pill says
// is then the real "last synced" time from the server, not a page-visit timer.
//
// A dataset from a file upload has nothing to re-read, so it keeps the plain
// timer pill it always had.

const ROWS = new Intl.NumberFormat('en-IN')

function ago(iso: string, now: number): string {
  const s = Math.max(0, Math.floor((now - Date.parse(iso)) / 1000))
  if (s < 60) return 'just now'
  if (s < 3600) return `${Math.floor(s / 60)} min ago`
  if (s < 86400) return `${Math.floor(s / 3600)} h ago`
  return `${Math.floor(s / 86400)} d ago`
}

export function SyncStatus({
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
  const { data: source } = useSourceStatus()
  const sync = useSourceSync()
  const { show } = useToast()
  const [now, setNow] = useState(() => Date.now())

  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 15000)
    return () => window.clearInterval(timer)
  }, [])

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
        const change =
          r.rows === r.previous_rows
            ? `no new rows (${ROWS.format(r.rows)})`
            : `${ROWS.format(r.previous_rows)} → ${ROWS.format(r.rows)} rows`
        show(`Synced from ${r.source} · ${change}`, { variant: 'success', duration: 4500 })
      },
      onError: (e) => {
        show(`Sync failed — the previous data is still loaded. ${e.message}`, { variant: 'error', duration: 7000 })
      },
    })
  }

  const title = busy
    ? `Pulling the latest data from ${source.label}…`
    : failed
      ? `The last sync failed: ${last.error ?? 'unknown error'}. Click to try again.`
      : `Click to pull the latest data from ${source.label}${source.origin ? ` (${source.origin})` : ''}.` +
        (last?.rows != null ? ` Loaded now: ${ROWS.format(last.rows)} rows.` : '')

  return (
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
          Syncing from <strong className="font-semibold text-ink-primary">{source.label}</strong>…
        </span>
      ) : failed ? (
        <span>
          <strong className="font-bold text-status-warning">Sync failed</strong> · retry
        </span>
      ) : (
        <span>
          <strong className="font-bold text-status-success">Live</strong> · synced{' '}
          {ago(last?.at ?? source.saved_at ?? new Date(now).toISOString(), now)}
        </span>
      )}
      <Icon
        name="refresh"
        className={`h-3.5 w-3.5 stroke-2 ${busy ? 'animate-spin text-brand-violet' : 'text-ink-muted group-hover:text-brand-violet'}`}
      />
    </button>
  )
}
