import { useState, type ReactNode } from 'react'
import { Link } from 'react-router-dom'
import { Icon } from '../icons'
import { Spinner } from './ui'
import { useStarStatus } from '../hooks/useDatasets'
import { STAR_ROLE_LABELS } from '../lib/starSchema'
import { UploadModal } from './portal/modals/UploadModal'
import { INITIAL_CONNECTORS } from './portal/connectors'

// Gates the whole app on the star-schema dataset actually being present, the
// same way RequireAuth gates it on a session.
//
// WHY A HARD GATE. The Data/ folder ships empty — every KPI, chart, filter and
// report in the platform reads the six CSVs in it, so until they are uploaded
// there is nothing any page can truthfully render. Letting the app through
// would mean a dozen screens each independently failing with their own empty
// state; blocking once, here, means the user sees exactly one instruction and
// cannot reach a broken page by URL.
//
// The gate lifts the moment the upload succeeds: the mutation invalidates every
// query, this one re-fetches, `complete` flips true and children render — no
// reload and no backend restart.

const EXCEL_CONNECTOR = INITIAL_CONNECTORS.find((c) => c.key === 'xls')!

export function RequireDataset({ children }: { children: ReactNode }) {
  const { data: status, isLoading, isError, refetch } = useStarStatus()
  const [uploadOpen, setUploadOpen] = useState(false)

  if (isLoading) {
    return (
      <div className="grid min-h-screen place-items-center bg-surface-page text-ink-muted">
        <Spinner className="h-5 w-5" />
      </div>
    )
  }

  // Can't reach /api/datasets/star at all — that's a backend problem, not a
  // missing upload, and telling the user to upload files would be wrong.
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

  const present = status.files.filter((f) => f.present).length
  const total = status.files.length

  return (
    <div className="grid min-h-screen place-items-center bg-surface-page p-6">
      <div className="w-full max-w-[520px] rounded-[var(--r-xl)] border border-border-subtle bg-surface-card shadow-[var(--shadow-sm)]">
        <div className="border-b border-border-subtle p-[20px_24px]">
          <div className="flex items-start gap-3">
            <div className="grid h-11 w-11 shrink-0 place-items-center rounded-[11px] bg-tint-lavender text-tint-lavender-icon [&_svg]:h-5 [&_svg]:w-5">
              <Icon name="database" />
            </div>
            <div className="min-w-0">
              <h2 className="text-md font-bold">Upload your dataset to continue</h2>
              <p className="mt-1 text-base leading-[1.6] text-ink-muted">
                The platform reads six core tables. All of them are required — every dashboard, KPI and report is
                built from them, so nothing can load until the full set is in place. Files are matched on their
                column headers, so it doesn't matter what they're named.
              </p>
            </div>
          </div>
        </div>

        <div className="p-[16px_24px]">
          <div className="mb-2.5 flex items-center justify-between">
            <span className="text-xs font-bold uppercase tracking-wide text-ink-muted">Required tables</span>
            <span className="text-sm font-semibold text-ink-muted">{present} of {total} present</span>
          </div>
          <div className="flex flex-col gap-1.5">
            {status.files.map((f) => (
              <div
                key={f.role}
                className="flex items-center gap-2.5 rounded-[var(--r-md)] bg-surface-muted p-[8px_12px]"
              >
                <span
                  className={`grid h-4 w-4 shrink-0 place-items-center rounded-full ${
                    f.present ? 'bg-[#047857] text-white' : 'border border-border-strong'
                  } [&_svg]:h-2.5 [&_svg]:w-2.5`}
                >
                  {f.present && <Icon name="check" />}
                </span>
                <div className="min-w-0 flex-1">
                  <div className={`truncate text-base ${f.present ? 'font-semibold' : 'text-ink-muted'}`}>
                    {f.label ?? STAR_ROLE_LABELS[f.role]}
                  </div>
                  {!f.present && (
                    <div className="mt-px truncate text-2xs text-ink-muted" title={f.required_columns?.join(', ')}>
                      needs {f.required_columns?.join(', ')}
                    </div>
                  )}
                </div>
              </div>
            ))}
          </div>
        </div>

        <div className="flex items-center justify-between gap-3 border-t border-border-subtle p-[14px_24px]">
          {/* This screen is the backstop for a typed URL. Connecting properly
              lives on Data Connections, which also offers Azure and Databricks
              — so the way there is on the gate rather than only the one
              connector the gate can raise itself. */}
          <Link to="/connections" className="text-sm font-semibold text-brand-violet hover:underline">
            Browse all connectors
          </Link>
          <button
            onClick={() => setUploadOpen(true)}
            className="flex items-center gap-1.5 rounded-[var(--r-md)] bg-brand-violet px-4 py-2 text-base font-bold text-white [&_svg]:h-[13px] [&_svg]:w-[13px]"
          >
            <Icon name="plus" /> Upload all 6 files
          </button>
        </div>
      </div>

      {uploadOpen && (
        <UploadModal
          connector={EXCEL_CONNECTOR}
          onClose={() => setUploadOpen(false)}
          onConnected={() => {
            // The upload mutation already invalidated every query, so the
            // status refetch that lifts this gate is in flight. Nothing to do
            // here but close.
            setUploadOpen(false)
          }}
        />
      )}
    </div>
  )
}
