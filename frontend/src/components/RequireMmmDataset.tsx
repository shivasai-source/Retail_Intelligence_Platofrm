import type { ReactNode } from 'react'
import { Link } from 'react-router-dom'
import { Icon } from '../icons'
import { mmmDatasetStatus } from './connections/mmm'

// Gates MMM's data-backed pages on MMM data actually being present — the same
// job RequireDataset does for TPO, asked of MMM's own contract.
//
// WHY A SEPARATE GATE. RequireDataset checks `/api/datasets/star`, which is
// TPO's six-table star schema, matched on column headers (Base_Quantity,
// Promotion_Id) a media-spend extract does not carry. Pointing MMM at it would
// padlock the MMM hub behind someone else's upload and tell the reader to go
// and find six promotion tables — the wrong instruction, for the wrong module.
// So MMM gets the same gate over its own list.
//
// THE SHAPE IS TPO'S, DELIBERATELY: the same card, the same checklist of
// required tables with a tick per installed one, and the same footer link out
// to the module's connector catalogue. A reader who has met TPO's gate has
// already met this one.
//
// WHAT IS MISSING ON PURPOSE is TPO's "Upload all 6 files" button. That button
// raises UploadModal, which POSTs to /api/datasets and installs TPO's star
// schema; there is no MMM equivalent to raise, and a button that cannot do what
// it says is worse than no button. It belongs here the day MMM ingestion does.

export function RequireMmmDataset({ children }: { children: ReactNode }) {
  // Synchronous today — derived from the catalogue, with no request to wait on,
  // so there is no loading branch and no error branch to render. Both arrive
  // with the real status endpoint, at which point this mirrors RequireDataset
  // exactly (spinner, "can't reach the server", then the checklist).
  const status = mmmDatasetStatus()

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
              <h2 className="text-md font-bold">Connect MMM data to continue</h2>
              <p className="mt-1 text-base leading-[1.6] text-ink-muted">
                The MMM Insights Hub is built from the datasets below. No MMM connector is wired up
                yet, so none of them can be loaded — and nothing on the hub is estimated or stood in
                for in the meantime.
              </p>
            </div>
          </div>
        </div>

        <div className="p-[16px_24px]">
          <div className="mb-2.5 flex items-center justify-between">
            <span className="text-xs font-bold uppercase tracking-wide text-ink-muted">
              Required datasets
            </span>
            <span className="text-sm font-semibold text-ink-muted">
              {status.present} of {status.total} present
            </span>
          </div>
          <div className="flex flex-col gap-1.5">
            {status.files.map((f) => (
              <div
                key={f.key}
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
                    {f.label}
                  </div>
                  {!f.present && (
                    <div className="mt-px truncate text-2xs text-ink-muted" title={f.detail}>
                      {f.detail}
                    </div>
                  )}
                </div>
              </div>
            ))}
          </div>
        </div>

        <div className="flex items-center justify-between gap-3 border-t border-border-subtle p-[14px_24px]">
          <Link
            to="/mmm/connections"
            className="text-sm font-semibold text-brand-violet hover:underline"
          >
            Browse all connectors
          </Link>
          {/* Where TPO's gate puts its upload button. Left as the honest
              statement until there is an MMM connector to point at. */}
          <span className="text-sm text-ink-muted">No MMM connector available yet</span>
        </div>
      </div>
    </div>
  )
}
