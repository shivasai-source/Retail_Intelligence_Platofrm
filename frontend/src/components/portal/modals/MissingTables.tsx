import { Icon } from '../../../icons'
import { STAR_ROLES } from '../../../lib/starSchema'
import type { StarInspectResult } from '../../../types/dataset'

// "Not ready to load", rendered table by table instead of as one sentence.
//
// The backend already sends the structured answer — `missing_roles` carries a
// label and the required column list per table — but this box used to print
// `inspection.message` instead, a single run-on string that inlined fourteen
// fact-table column names mid-sentence. The information was all there and
// almost unreadable: you could not see at a glance which tables were missing,
// let alone which columns each one needed.
//
// So: one row per missing table, each naming the table and then its columns,
// in the canonical STAR_ROLES order (fact first, then the dimensions) rather
// than whatever order the server happened to iterate. The Excel connector's
// upload screen already presented it this way; this brings Azure and
// Databricks in line with it.
export function MissingTables({ inspection }: { inspection: StarInspectResult }) {
  const missing = [...inspection.missing_roles].sort(
    (a, b) => STAR_ROLES.indexOf(a.role) - STAR_ROLES.indexOf(b.role),
  )

  // Files that matched a table but lack columns are a different fix (repair the
  // export, not upload a new file), so they are named separately below.
  const incomplete = inspection.files.filter((f) => f.recognised && f.missing_columns.length > 0)
  const unrecognised = inspection.files.filter((f) => !f.recognised)
  const ready = STAR_ROLES.length - missing.length

  return (
    <div className="mt-3.5 rounded-[var(--r-md)] bg-status-danger-bg p-[11px_13px]">
      <div className="mb-2 flex items-center gap-1.5 text-sm font-medium text-[var(--pill-danger-ink)] [&_svg]:h-[14px] [&_svg]:w-[14px]">
        <Icon name="alertTriangle" />
        Not ready to load — {ready} of {STAR_ROLES.length} tables ready
      </div>

      {missing.length > 0 && (
        <ul className="flex flex-col gap-1.5">
          {missing.map(({ role, label, required_columns }) => {
            const broken = incomplete.find((f) => f.role === role)
            return (
              <li key={role} className="text-xs leading-[1.5] text-[var(--pill-danger-ink)]">
                <strong>{label}</strong>
                {broken ? (
                  <>
                    {' — '}
                    <span className="opacity-90">{broken.filename}</span> is missing{' '}
                    <span className="font-medium">{broken.missing_columns.join(', ')}</span>
                  </>
                ) : (
                  <>
                    <span className="opacity-80"> — not uploaded</span>
                    <div className="mt-px opacity-80">needs {required_columns.join(', ')}</div>
                  </>
                )}
              </li>
            )
          })}
        </ul>
      )}

      {unrecognised.length > 0 && (
        <div className="mt-2 border-t border-[var(--pill-danger-ink)]/20 pt-2 text-xs leading-[1.5] text-[var(--pill-danger-ink)]">
          <strong>Not one of the 6 tables</strong>
          <div className="mt-px opacity-80">
            {unrecognised.map((f) => f.filename).join(', ')} — remove to continue.
          </div>
        </div>
      )}
    </div>
  )
}
