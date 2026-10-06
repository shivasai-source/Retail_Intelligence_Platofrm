import { useState, type ReactNode } from 'react'
import { Link } from 'react-router-dom'
import { Icon } from '../../icons'
import { Spinner } from '../../components/ui'
import { useMmmStatus } from '../hooks'
import { MMM_ROUTES } from '../nav'
import { MmmUploadModal } from './MmmUploadModal'

// Gates MMM's data-backed pages on MMM data actually being present — the same
// job RequireDataset does for TPO, asked of MMM's own status endpoint
// (GET /api/mmm/dataset), never TPO's star schema.
//
// THE SHAPE IS TPO'S: a spinner while the status loads, "can't reach the
// server" when it cannot be asked at all (that is a backend problem, not a
// missing upload), then the card with the checklist and an Upload button that
// opens MMM's own upload dialog. The checklist is the daily file's four column
// groups; the gate lifts the moment an upload succeeds — the upload invalidates
// the status query and `complete` flips true, no reload.

export function RequireMmmDataset({ children }: { children: ReactNode }) {
  const { data: status, isLoading, isError, refetch } = useMmmStatus()
  const [uploadOpen, setUploadOpen] = useState(false)

  if (isLoading) {
    return (
      <div className="grid min-h-screen place-items-center bg-surface-page text-ink-muted">
        <Spinner className="h-5 w-5" />
      </div>
    )
  }

  if (isError || !status) {
    return (
      <div className="grid min-h-screen place-items-center bg-surface-page p-6">
        <div className="max-w-[420px] rounded-[var(--r-xl)] border border-border-subtle bg-surface-card p-6 text-center shadow-[var(--shadow-sm)]">
          <div className="mx-auto mb-3 grid h-11 w-11 place-items-center rounded-[11px] bg-status-danger-bg text-[#B91C1C] [&_svg]:h-5 [&_svg]:w-5">
            <Icon name="info" />
          </div>
          <h2 className="text-md font-bold">Can't reach the server</h2>
          <p className="mt-1.5 text-base leading-[1.6] text-ink-muted">
            The backend isn't responding. Start it with{' '}
            <code className="rounded bg-surface-muted px-1 py-0.5 text-sm">uvicorn app.main:app --reload --port 8100</code>{' '}
            and try again.
          </p>
          <button
            onClick={() => refetch()}
            className="mt-4 rounded-[var(--r-md)] bg-brand-violet px-4 py-2 text-base font-bold text-white"
          >
            Retry
          </button>
        </div>
      </div>
    )
  }

  if (status.complete) return <>{children}</>

  return (
    <div className="grid min-h-screen place-items-center bg-surface-page p-6">
      <div className="w-full max-w-[520px] rounded-[var(--r-xl)] border border-border-subtle bg-surface-card shadow-[var(--shadow-sm)]">
        <div className="border-b border-border-subtle p-[20px_24px]">
          <div className="flex items-start gap-3">
            <div className="grid h-11 w-11 shrink-0 place-items-center rounded-[11px] bg-tint-lavender text-tint-lavender-icon [&_svg]:h-5 [&_svg]:w-5">
              <Icon name="database" />
            </div>
            <div className="min-w-0">
              <h2 className="text-md font-bold">Upload your MMM dataset to continue</h2>
              <p className="mt-1 text-base leading-[1.6] text-ink-muted">
                MMM reads one daily file: Date, Revenue and spend per media channel, plus optional
                promotion and calendar columns. Columns are matched on their headers, so it doesn't
                matter what the file is named.
              </p>
            </div>
          </div>
        </div>

        <div className="p-[16px_24px]">
          <div className="mb-2.5 flex items-center justify-between">
            <span className="text-xs font-bold uppercase tracking-wide text-ink-muted">MMM dataset</span>
            <span className="text-sm font-semibold text-ink-muted">
              {status.complete ? 1 : 0} of 1 file present
            </span>
          </div>
          <div className="flex items-center gap-2.5 rounded-[var(--r-md)] bg-surface-muted p-[10px_12px]">
            <span className="h-4 w-4 shrink-0 rounded-full border border-border-strong" />
            <div className="min-w-0 flex-1">
              <div className="text-base text-ink-muted">One daily MMM file</div>
              <div className="mt-px text-2xs text-ink-muted">
                Date, Revenue and at least one media column ending in _Spend.
              </div>
            </div>
          </div>
        </div>

        <div className="flex items-center justify-between gap-3 border-t border-border-subtle p-[14px_24px]">
          <Link to={MMM_ROUTES.connections} className="text-sm font-semibold text-brand-violet hover:underline">
            Browse all connectors
          </Link>
          <button
            onClick={() => setUploadOpen(true)}
            className="inline-flex items-center gap-1.5 rounded-[var(--r-md)] bg-brand-violet px-4 py-2 text-base font-bold text-white [&_svg]:h-4 [&_svg]:w-4"
          >
            <Icon name="plus" /> Upload MMM file
          </button>
        </div>
      </div>

      {uploadOpen && <MmmUploadModal onClose={() => setUploadOpen(false)} />}
    </div>
  )
}
