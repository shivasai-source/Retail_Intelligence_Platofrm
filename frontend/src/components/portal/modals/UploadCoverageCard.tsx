import { Icon } from '../../../icons'
import { Pill } from '../../ui'
import type { StarCoverage } from '../../../types/dataset'

// What several sales files add up to, shown before anything is installed.
//
// WHY THIS IS NOT COSMETIC. Three things about a multi-file delivery are
// invisible once it is installed, and each one is a wrong number rather than
// an error:
//
//   * A MONTH NOBODY SENT is not zero sales, it is an absent month. With no
//     dim_date uploaded the calendar is generated from the fact table's own
//     dates, so a missing October simply ceases to exist and no check
//     downstream would ever notice it.
//
//   * AN OVERLAPPING WEEK would double every measure in it. Rows are keyed on
//     the sales grain and counted once, which is the right thing to do and
//     still worth saying out loud, because "112,320 rows" from "114,660 rows
//     delivered" is otherwise an unexplained loss.
//
//   * WIDENING THE SPAN moves numbers that are already signed off. The MMM
//     baseline is re-estimated per selected range and the comparison card's
//     ROI uses a whole-span baseline, so uploading ten months instead of three
//     does not merely add data.
//
// So this card states the span, the per-file periods, and the two kinds of
// hole, and it does it at the moment the user is deciding to press Upload.
export function UploadCoverageCard({ coverage }: { coverage: StarCoverage }) {
  const readable = coverage.files.filter((f) => !f.unreadable)
  const deduped = coverage.overlaps.length > 0

  return (
    <div className="mt-3.5 overflow-hidden rounded-[var(--r-md)] border border-border-subtle">
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-border-subtle bg-surface-muted p-[10px_12px]">
        <div className="flex items-center gap-1.5 text-sm font-medium [&_svg]:h-[15px] [&_svg]:w-[15px]">
          <Icon name="calendar" />
          {readable.length} sales files · one table
        </div>
        <div className="flex flex-wrap items-center gap-1.5">
          <Pill tone="neutral">
            {coverage.first} – {coverage.last}
          </Pill>
          <Pill tone="neutral">{coverage.weeks} weeks</Pill>
          <Pill tone={coverage.gaps.length ? 'warning' : 'success'}>
            {coverage.rows_delivered.toLocaleString()} rows
          </Pill>
        </div>
      </div>

      <table className="w-full text-xs">
        <tbody>
          {coverage.files.map((f) => (
            <tr key={f.filename} className="border-b border-border-subtle last:border-0">
              <td className="max-w-[180px] truncate p-[7px_12px] font-medium">{f.filename}</td>
              <td className="whitespace-nowrap p-[7px_8px] text-ink-muted">
                {f.unreadable ? 'no date column' : `${f.first} – ${f.last}`}
              </td>
              <td className="whitespace-nowrap p-[7px_12px] text-right text-ink-muted">
                {f.rows.toLocaleString()} rows
              </td>
            </tr>
          ))}
        </tbody>
      </table>

      {(coverage.gaps.length > 0 ||
        deduped ||
        coverage.dropped_columns.length > 0) && (
        <div className="flex flex-col gap-1.5 border-t border-border-subtle p-[10px_12px]">
          {coverage.gaps.length > 0 && (
            <div className="flex items-start gap-1.5 text-xs leading-[1.55] text-[var(--pill-warning-ink)] [&_svg]:mt-px [&_svg]:h-[13px] [&_svg]:w-[13px] [&_svg]:shrink-0">
              <Icon name="alertTriangle" />
              <span>
                <strong className="font-medium">No data for {coverage.gaps.join('; ')}.</strong>{' '}
                Those weeks will be absent from the dataset rather than zero — add the missing
                file if you have it.
              </span>
            </div>
          )}
          {deduped && (
            <div className="flex items-start gap-1.5 text-xs leading-[1.55] text-ink-muted [&_svg]:mt-px [&_svg]:h-[13px] [&_svg]:w-[13px] [&_svg]:shrink-0">
              <Icon name="info" />
              <span>
                {coverage.overlaps.join('; ')}. Repeated rows are counted once, so the installed
                total will be lower than the rows delivered.
              </span>
            </div>
          )}
          {coverage.dropped_columns.length > 0 && (
            <div className="flex items-start gap-1.5 text-xs leading-[1.55] text-[var(--pill-warning-ink)] [&_svg]:mt-px [&_svg]:h-[13px] [&_svg]:w-[13px] [&_svg]:shrink-0">
              <Icon name="alertTriangle" />
              <span>
                <span className="font-mono">{coverage.dropped_columns.join(', ')}</span>{' '}
                {coverage.dropped_columns.length === 1 ? 'is' : 'are'} not in every file, so{' '}
                {coverage.dropped_columns.length === 1 ? 'it' : 'they'} will be left out
                altogether — filling the blanks would make that period look free.
              </span>
            </div>
          )}
        </div>
      )}
    </div>
  )
}
