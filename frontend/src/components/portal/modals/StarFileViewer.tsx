import { useState } from 'react'
import { Icon } from '../../../icons'
import { Modal, Button, IconButton, Spinner, Table, Th, Td, Tr } from '../../ui'
import { fmtSize } from '../../../lib/portalConnectors'
import { useStarPreview } from '../../../hooks/useDatasets'
import type { StarRole } from '../../../types/dataset'

// Reads one installed star table, a page at a time.
//
// PAGED, NOT WHOLE-FILE, because the fact table is 205,920 rows / ~21 MB. The
// point of this panel is to let the user confirm the right file landed — the
// first screenful answers that, and shipping the rest as JSON would cost orders
// of magnitude more than the question is worth. The backend streams and skips
// rather than loading the file, so a page deep into the fact table is no more
// expensive to serve than the first.
export function StarFileViewer({
  role,
  onBack,
  onClose,
}: {
  role: StarRole
  onBack: () => void
  onClose: () => void
}) {
  const [offset, setOffset] = useState(0)
  const preview = useStarPreview(role, offset)
  const data = preview.data
  const limit = data?.limit ?? 100
  const rowCount = data?.row_count ?? 0
  const showingTo = Math.min(offset + limit, rowCount)

  return (
    <Modal open onClose={onClose} maxWidthClassName="max-w-[min(1100px,94vw)]">
      <div className="flex items-center justify-between gap-3 border-b border-border-subtle p-[16px_20px]">
        <div className="flex min-w-0 items-center gap-2.5">
          <IconButton icon="chevronLeft" onClick={onBack} />
          <div className="min-w-0">
            <h3 className="truncate text-md font-medium">{data?.label ?? 'Loading…'}</h3>
            <div className="mt-0.5 truncate text-sm text-ink-muted">
              {data
                ? `${data.filename} · ${data.row_count.toLocaleString()} rows · ${data.columns.length} columns · ${fmtSize(data.size_bytes)}`
                : 'Reading the file…'}
            </div>
          </div>
        </div>
        <IconButton icon="x" onClick={onClose} />
      </div>

      <div className="max-h-[64vh] overflow-auto">
        {preview.isLoading && (
          <div className="flex items-center justify-center gap-2 py-16 text-sm text-ink-muted">
            <Spinner /> Loading rows…
          </div>
        )}

        {preview.isError && (
          <div className="m-5 rounded-[var(--r-md)] bg-status-danger-bg p-[10px_12px] text-sm leading-[1.55] text-[var(--pill-danger-ink)]">
            {preview.error instanceof Error ? preview.error.message : "Couldn't read this file."}
          </div>
        )}

        {data && !preview.isLoading && (
          <Table>
            <thead>
              <tr>
                {/* Absolute row number, so paging deep into the fact table still
                    tells the user where they are in the file. */}
                <Th className="w-[70px]">#</Th>
                {data.columns.map((col) => (
                  <Th key={col} className="whitespace-nowrap">
                    {col}
                  </Th>
                ))}
              </tr>
            </thead>
            <tbody>
              {data.rows.map((row, i) => (
                <Tr key={offset + i}>
                  <Td className="text-ink-muted tabular-nums">{offset + i + 1}</Td>
                  {data.columns.map((col) => (
                    <Td key={col} className="whitespace-nowrap">
                      {row[col] ?? ''}
                    </Td>
                  ))}
                </Tr>
              ))}
            </tbody>
          </Table>
        )}
      </div>

      <div className="flex items-center justify-between gap-2 border-t border-border-subtle p-[14px_22px]">
        <span className="text-xs text-ink-muted tabular-nums">
          {data ? `Rows ${(offset + 1).toLocaleString()}–${showingTo.toLocaleString()} of ${rowCount.toLocaleString()}` : ''}
        </span>
        <div className="flex gap-2">
          <Button
            variant="secondary"
            size="sm"
            onClick={() => setOffset((o) => Math.max(0, o - limit))}
            disabled={offset === 0 || preview.isFetching}
          >
            <Icon name="chevronLeft" /> Previous
          </Button>
          <Button
            variant="secondary"
            size="sm"
            onClick={() => setOffset((o) => o + limit)}
            disabled={showingTo >= rowCount || preview.isFetching}
          >
            Next <Icon name="chevronRight" />
          </Button>
          <Button variant="ghost" size="sm" onClick={onBack}>
            Back
          </Button>
        </div>
      </div>
    </Modal>
  )
}
