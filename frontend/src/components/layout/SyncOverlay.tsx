import { createPortal } from 'react-dom'
import { Icon } from '../../icons'
import { ConnectorLogo } from '../portal/ConnectorLogo'
import { InstallProgress } from '../portal/modals/InstallProgress'

// WHILE A SYNC RUNS. A centred card over a softened page: the connector's own
// logo inside a turning ring, what is being pulled, and the same progress
// strip the Data Connections installs use -- a percentage, the time elapsed
// and roughly how long is left. The percentage is an estimate (the sync is one
// request that streams no progress), so the strip eases towards it and only
// fills once the work has actually finished.
//
// A SYNC IS TWO WAITS, and the card names both. `pulling` is the request to
// the source; `loading` is every screen coming back on the data it brought in,
// which on a large dataset is the longer of the two. Each stage gets its own
// strip (`key={stage}`) so the elapsed clock and the bar restart with it,
// rather than one bar sitting at 100% through a wait it has already claimed to
// have finished.

/** What the sync is doing: pulling from the source, reloading the screens on
 *  what it brought back, or finished. */
export type SyncStage = 'pulling' | 'loading' | 'done'

/** Rough sync times, from the connectors' own install estimates. */
const ESTIMATE_MS: Record<string, number> = { databricks: 60_000, azure: 45_000 }

/** Rough time for the invalidated queries to come back. */
const RELOAD_ESTIMATE_MS = 12_000

/** The source kinds the sync knows, as the connector catalogue's logo ids --
 *  so the real Databricks / Azure marks show, the same ones Data Connections
 *  uses. A new connector only needs its id added here. */
const LOGO_ID: Record<string, string> = { databricks: 'databricks', azure: 'azure-blob' }

/** The connector's logo, ringed: turning while the sync runs, green when done. */
export function SourceMark({ kind, name, state }: { kind: string; name: string; state: 'busy' | 'done' | 'idle' }) {
  return (
    <span className="relative grid h-16 w-16 shrink-0 place-items-center">
      <svg viewBox="0 0 56 56" className={`absolute inset-0 h-16 w-16 ${state === 'busy' ? 'animate-spin [animation-duration:1.4s]' : ''}`} aria-hidden>
        <circle cx="28" cy="28" r="25" fill="none" strokeWidth="3" className="stroke-border-subtle" />
        <circle
          cx="28"
          cy="28"
          r="25"
          fill="none"
          strokeWidth="3"
          strokeLinecap="round"
          strokeDasharray={state === 'busy' ? '42 157' : '157 157'}
          className={state === 'done' ? 'stroke-status-success' : 'stroke-brand-blue'}
          transform="rotate(-90 28 28)"
        />
      </svg>
      <ConnectorLogo connectorId={LOGO_ID[kind] ?? kind} label={name} mark={name.slice(0, 2).toUpperCase()} className="shadow-[var(--shadow-sm)]" />
      {state === 'done' && (
        <span className="absolute -bottom-0.5 -right-0.5 grid h-5 w-5 place-items-center rounded-full border-2 border-surface-card bg-status-success text-white [&_svg]:h-3 [&_svg]:w-3">
          <Icon name="check" />
        </span>
      )}
    </span>
  )
}

export function SyncOverlay({
  kind,
  source,
  items,
  stage,
}: {
  kind: string
  source: string
  items: string[]
  stage: SyncStage
}) {
  const tables = items.length
  const done = stage === 'done'
  const title = stage === 'pulling' ? `Syncing from ${source}` : 'Sync complete'
  const subtitle =
    stage === 'pulling'
      ? `Pulling ${tables || 'all'} ${tables === 1 ? 'table' : 'tables'}`
      : stage === 'loading'
        ? 'Loading the new data into every screen…'
        : 'Preparing the summary…'
  return createPortal(
    <div
      role="status"
      aria-live="polite"
      className="fade-in fixed inset-0 z-[130] grid place-items-center bg-[rgba(15,22,41,0.35)] p-4 backdrop-blur-[3px]"
    >
      <div className="fade-in-up w-[480px] max-w-full overflow-hidden rounded-[var(--r-xl)] border border-border-default bg-surface-card shadow-[var(--shadow-lg)]">
        <div className="h-1 bg-[linear-gradient(90deg,var(--brand-violet),var(--brand-blue),var(--status-success))]" />
        <div className="px-6 pb-6 pt-5">
          <div className="flex items-center gap-4">
            <SourceMark kind={kind} name={source} state={done ? 'done' : 'busy'} />
            <div className="min-w-0">
              <div className="text-lg font-normal text-ink-primary">{title}</div>
              <div className="truncate text-sm text-ink-muted">{subtitle}</div>
            </div>
          </div>

          <InstallProgress
            key={stage === 'pulling' ? 'pulling' : 'loading'}
            active={!done}
            done={done}
            estimateMs={stage === 'pulling' ? (ESTIMATE_MS[kind] ?? 60_000) : RELOAD_ESTIMATE_MS}
            label={stage === 'pulling' ? `Exporting from ${source}` : 'Rebuilding the screens'}
          />

          {tables > 0 && (
            <div className="mt-4 flex flex-wrap gap-1.5">
              {items.map((name) => (
                <span
                  key={name}
                  title={name}
                  className="inline-flex max-w-[210px] items-center gap-1.5 rounded-[var(--r-pill)] border border-border-subtle bg-surface-muted px-2.5 py-1 text-xs text-ink-secondary [&_svg]:h-3 [&_svg]:w-3 [&_svg]:shrink-0"
                >
                  {/* Pulled is pulled: the ticks appear when the export
                      finishes, not when the reload behind it does. */}
                  <span className={stage === 'pulling' ? 'text-ink-muted' : 'text-status-success'}>
                    <Icon name={stage === 'pulling' ? 'database' : 'check'} />
                  </span>
                  <span className="truncate">{name.split('.').pop()}</span>
                </span>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>,
    document.body,
  )
}
