import { useState } from 'react'
import { AppShell } from '../components/layout/AppShell'
import {
  Button,
  Card,
  CardHeader,
  Dropdown,
  Input,
  Modal,
  Spinner,
  Table,
  Td,
  Th,
  Tr,
  useConfirm,
  useToast,
} from '../components/ui'
import { Icon } from '../icons'
import {
  downloadArtifact,
  useClearReports,
  useDeleteReport,
  useReportLibrary,
} from '../hooks/useReportCenter'
import type { ReportFormat, ReportRecord } from '../types/reportCenter'

/** THE TPO INTELLIGENCE REPORT CENTER.
 *
 *  The library of reports generated from the analytical modules. Every row here
 *  corresponds to a STORED ARTIFACT on the server — there are no seeded example
 *  rows, and the page this replaced had six of them ("Sanjay Kumar", "4.2 MB")
 *  with no file behind any.
 *
 *  THIS IS THE ONLY PLACE THE APPLICATION SAVES A FILE. Generating a report from
 *  Insights Hub, Simulation Studio or Decision Center stores it; a download
 *  happens here, and only when a person clicks Excel or PDF.
 *
 *  A BUTTON IS OFFERED ONLY FOR A FORMAT THAT EXISTS. `formats.xlsx` and
 *  `formats.pdf` are the stored filenames, null when that artifact was never
 *  written, and the button is disabled with a reason rather than hidden — a
 *  missing format is information.
 */

const ALL_MODULES = 'All modules'
const ALL_FORMATS = 'All formats'
const FORMAT_LABEL: Record<string, ReportFormat | null> = {
  [ALL_FORMATS]: null,
  'Excel (.xlsx)': 'xlsx',
  'PDF (.pdf)': 'pdf',
}

export function Reports() {
  const [moduleFilter, setModuleFilter] = useState<string | null>(null)
  const [formatFilter, setFormatFilter] = useState<ReportFormat | null>(null)
  const [search, setSearch] = useState('')
  const [viewing, setViewing] = useState<ReportRecord | null>(null)
  const [busy, setBusy] = useState<string | null>(null)

  const library = useReportLibrary({ module: moduleFilter, format: formatFilter, search })
  const remove = useDeleteReport()
  const clear = useClearReports()
  const { show } = useToast()
  const confirm = useConfirm()

  const modules = library.data?.modules ?? []
  const reports = library.data?.reports ?? []
  const filtering = Boolean(moduleFilter || formatFilter || search.trim())
  const moduleLabel =
    modules.find((m) => m.key === moduleFilter)?.label ?? ALL_MODULES

  const download = async (report: ReportRecord, format: ReportFormat) => {
    const key = `${report.report_id}:${format}`
    if (busy) return
    setBusy(key)
    try {
      const result = await downloadArtifact(
        report.report_id,
        format,
        report.formats[format] ?? `TPO_Report.${format}`,
      )
      show(`${result.filename} · ${(result.bytes / 1024).toFixed(0)} KB downloaded`, {
        duration: 4000,
      })
    } catch (error) {
      show(
        error instanceof Error
          ? `Unable to download. ${error.message}`
          : 'Unable to download. Please try again.',
        { variant: 'info', duration: 7000 },
      )
    } finally {
      setBusy(null)
    }
  }

  const destroy = (report: ReportRecord) => {
    confirm({
      title: 'Delete report',
      body: `Delete "${report.name}"? Its Excel and PDF artifacts are removed with it. The report can be generated again from ${report.module_label}.`,
      primaryText: 'Delete report',
      icon: 'warning',
      onConfirm: () =>
        remove.mutate(report.report_id, {
          onSuccess: () => show('Report deleted', { duration: 3000 }),
          onError: (error) =>
            show(`Unable to delete. ${error.message}`, { variant: 'info', duration: 6000 }),
        }),
    })
  }

  /** EMPTY THE WHOLE LIBRARY, not the filtered view.
   *
   *  The confirmation names the real total rather than the number of rows on
   *  screen, because a filter can be hiding most of them — someone looking at
   *  "2 of 11" who clears must be told they are removing 11.
   */
  const clearAll = () => {
    const total = library.data?.total ?? 0
    if (!total) return
    confirm({
      title: 'Clear the Report Center',
      body:
        `Delete all ${total} report${total === 1 ? '' : 's'} and their Excel and PDF files? ` +
        (filtering
          ? 'This clears the whole library, not just the reports matching the current filters. '
          : '') +
        'Reports can be generated again from the module they came from.',
      primaryText: `Delete ${total} report${total === 1 ? '' : 's'}`,
      icon: 'warning',
      onConfirm: () =>
        clear.mutate(undefined, {
          onSuccess: (result) =>
            show(
              `Report Center cleared — ${result.deleted} report${result.deleted === 1 ? '' : 's'} and their files removed`,
              { duration: 4000 },
            ),
          onError: (error) =>
            show(`Unable to clear. ${error.message}`, { variant: 'info', duration: 6000 }),
        }),
    })
  }

  return (
    <AppShell activeKey="reports" crumbs={[{ label: 'Reports' }]}>
      <div className="fade-in flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="text-2xl font-extrabold tracking-[-0.02em]">Reports</h1>
          <p className="mt-1.5 text-base text-ink-muted">
            Generated business reports and analysis
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Dropdown
            selected={moduleLabel}
            options={[{ label: ALL_MODULES }, ...modules.map((m) => ({ label: m.label }))]}
            onSelect={(picked) =>
              setModuleFilter(
                picked === ALL_MODULES
                  ? null
                  : (modules.find((m) => m.label === picked)?.key ?? null),
              )
            }
            trigger={
              <Button variant="secondary" className="cursor-pointer">
                <Icon name="filter" /> <span className="truncate">{moduleLabel}</span>
                <Icon name="chevronDown" />
              </Button>
            }
          />
          <Dropdown
            selected={
              Object.keys(FORMAT_LABEL).find((k) => FORMAT_LABEL[k] === formatFilter) ??
              ALL_FORMATS
            }
            options={Object.keys(FORMAT_LABEL).map((label) => ({ label }))}
            onSelect={(picked) => setFormatFilter(FORMAT_LABEL[picked] ?? null)}
            trigger={
              <Button variant="secondary" className="cursor-pointer">
                <span>
                  {Object.keys(FORMAT_LABEL).find((k) => FORMAT_LABEL[k] === formatFilter) ??
                    ALL_FORMATS}
                </span>
                <Icon name="chevronDown" />
              </Button>
            }
          />
          {/* Disabled on an empty library rather than hidden: a control that
              appears and disappears is harder to find than one that is visibly
              inert, and the title says why. */}
          <Button
            variant="secondary"
            onClick={clearAll}
            disabled={!library.data?.total || clear.isPending}
            className={library.data?.total ? 'cursor-pointer' : undefined}
            title={
              library.data?.total
                ? `Delete all ${library.data.total} reports and their files`
                : 'The Report Center is already empty'
            }
          >
            <Icon name="x" />
            <span>{clear.isPending ? 'Clearing…' : 'Clear all'}</span>
          </Button>
        </div>
      </div>

      <Card className="fade-in mt-[14px]">
        <CardHeader
          title="Report Center"
          subtitle={
            library.data
              ? `${library.data.returned} of ${library.data.total} report${library.data.total === 1 ? '' : 's'}`
              : 'Loading…'
          }
          actions={
            <Input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search reports…"
              className="max-w-[240px]"
            />
          }
        />

        {library.isLoading ? (
          <div className="grid min-h-[200px] place-items-center">
            <Spinner />
          </div>
        ) : library.isError ? (
          <div className="px-5 py-6 text-center text-base text-status-danger">
            Could not load the Report Center. {library.error.message}
          </div>
        ) : reports.length === 0 ? (
          <EmptyState filtered={Boolean(moduleFilter || formatFilter || search.trim())} />
        ) : (
          <div className="overflow-x-auto rounded-b-[var(--r-lg)]">
            <Table>
              <thead>
                <tr>
                  <Th className="w-[24%]">Report</Th>
                  <Th className="w-[16%]">Module</Th>
                  <Th className="w-[20%]">Scope</Th>
                  <Th className="w-[13%]">Generated</Th>
                  <Th className="w-[8%]">Status</Th>
                  <Th className="w-[19%] text-right">Actions</Th>
                </tr>
              </thead>
              <tbody>
                {reports.map((report) => (
                  <ReportRow
                    key={report.report_id}
                    report={report}
                    busy={busy}
                    onView={() => setViewing(report)}
                    onDownload={download}
                    onDelete={() => destroy(report)}
                  />
                ))}
              </tbody>
            </Table>
          </div>
        )}
      </Card>

      {library.data && (
        <div className="mt-3 text-xs leading-[1.5] text-ink-muted">
          Every row is a report that was generated from a module and stored with its
          artifacts. {library.data.owner_note}
        </div>
      )}

      {viewing && <ReportPreviewModal report={viewing} onClose={() => setViewing(null)} />}
    </AppShell>
  )
}

function EmptyState({ filtered }: { filtered: boolean }) {
  return (
    <div className="grid min-h-[160px] place-items-center px-6 py-7 text-center">
      <div className="max-w-[520px]">
        <div className="mx-auto mb-3 grid h-10 w-10 place-items-center rounded-full bg-surface-muted text-ink-muted [&_svg]:h-5 [&_svg]:w-5">
          <Icon name="file" />
        </div>
        <div className="text-base font-bold text-ink-primary">
          {filtered ? 'No reports match these filters' : 'No reports generated yet'}
        </div>
        <div className="mt-1 text-base leading-[1.55] text-ink-secondary">
          {filtered
            ? 'Clear the module, format or search filter to see the whole Report Center.'
            : 'Generate a report from Insights Hub, Simulation Studio or Decision Center. It will be stored here, and you can download it as Excel or PDF.'}
        </div>
      </div>
    </div>
  )
}

function ReportRow({
  report,
  busy,
  onView,
  onDownload,
  onDelete,
}: {
  report: ReportRecord
  busy: string | null
  onView: () => void
  onDownload: (report: ReportRecord, format: ReportFormat) => void
  onDelete: () => void
}) {
  const ready = report.status === 'ready'
  return (
    <Tr>
      <Td emphasis className="max-w-[260px]">
        <span className="block truncate" title={report.name}>
          {report.name}
        </span>
        <span className="block truncate text-xs font-normal text-ink-muted">
          {report.title}
        </span>
      </Td>
      <Td className="whitespace-nowrap">
        <span className="inline-flex items-center rounded-[var(--r-pill)] bg-brand-violet-50 px-2 py-0.5 text-xs font-bold text-brand-violet">
          {report.module_label}
        </span>
      </Td>
      <Td className="max-w-[240px]">
        <span className="block truncate text-sm" title={report.scope_label}>
          {report.scope_label || '—'}
        </span>
      </Td>
      <Td className="whitespace-nowrap text-sm tabular-nums">
        {report.preview?.generated_display || formatStamp(report.created_at)}
      </Td>
      <Td className="whitespace-nowrap">
        <StatusPill report={report} />
      </Td>
      <Td className="whitespace-nowrap text-right">
        <span className="inline-flex items-center justify-end gap-1">
          <Button variant="secondary" onClick={onView} className="cursor-pointer" title="Preview this report">
            <Icon name="eye" /> <span>View</span>
          </Button>
          <FormatButton
            report={report}
            format="xlsx"
            label="Excel"
            busy={busy}
            onDownload={onDownload}
            ready={ready}
          />
          <FormatButton
            report={report}
            format="pdf"
            label="PDF"
            busy={busy}
            onDownload={onDownload}
            ready={ready}
          />
          <Button
            variant="secondary"
            onClick={onDelete}
            className="cursor-pointer"
            title={`Delete "${report.name}" and its files`}
            aria-label={`Delete ${report.name}`}
          >
            <Icon name="x" />
          </Button>
        </span>
      </Td>
    </Tr>
  )
}

/** A download button for ONE format.
 *
 *  Disabled with a reason when that artifact does not exist, rather than hidden:
 *  "PDF not available" tells the reader something; a missing button does not.
 */
function FormatButton({
  report,
  format,
  label,
  busy,
  ready,
  onDownload,
}: {
  report: ReportRecord
  format: ReportFormat
  label: string
  busy: string | null
  ready: boolean
  onDownload: (report: ReportRecord, format: ReportFormat) => void
}) {
  const name = report.formats[format]
  const available = ready && Boolean(name)
  const key = `${report.report_id}:${format}`

  if (!available) {
    return (
      <Button
        variant="secondary"
        disabled
        title={
          ready
            ? `This report has no ${label} artifact.`
            : `The report is ${report.status}${report.error ? ` — ${report.error}` : ''}.`
        }
      >
        {label} — not available
      </Button>
    )
  }

  return (
    <Button
      variant="secondary"
      onClick={() => onDownload(report, format)}
      disabled={busy === key}
      className="cursor-pointer"
      title={`Download ${name}`}
    >
      <Icon name="download" /> <span>{busy === key ? 'Downloading…' : label}</span>
    </Button>
  )
}

function StatusPill({ report }: { report: ReportRecord }) {
  const tone =
    report.status === 'ready'
      ? 'bg-status-success-bg text-status-success'
      : report.status === 'failed'
        ? 'bg-status-danger-bg text-status-danger'
        : 'bg-status-warning-bg text-status-warning'
  const label =
    report.status === 'ready' ? 'Ready' : report.status === 'failed' ? 'Failed' : 'Generating'
  return (
    <span
      className={`inline-flex items-center rounded-[var(--r-pill)] px-2 py-0.5 text-xs font-bold ${tone}`}
      title={report.error ?? undefined}
    >
      {label}
    </span>
  )
}

/** The in-app preview.
 *
 *  Shows the summary the report was GENERATED with — not a fresh evaluation of
 *  the module. Re-running it here would show today's numbers under a report
 *  generated yesterday, and the library would quietly disagree with the files it
 *  is listing.
 */
function ReportPreviewModal({
  report,
  onClose,
}: {
  report: ReportRecord
  onClose: () => void
}) {
  const preview = report.preview
  return (
    <Modal open onClose={onClose} maxWidthClassName="max-w-[720px]">
      <div className="flex flex-col gap-4">
        <div className="flex items-start justify-between gap-4">
          <div className="min-w-0">
            <div className="text-xs font-semibold uppercase tracking-[0.1em] text-brand-violet">
              TPO Intelligence · Report Center
            </div>
            <div className="truncate text-lg font-extrabold text-ink-primary" title={report.name}>
              {report.name}
            </div>
          </div>
          <Button variant="secondary" onClick={onClose} className="shrink-0 cursor-pointer">
            <Icon name="x" />
          </Button>
        </div>
        <div className="grid grid-cols-2 gap-x-6 gap-y-2 text-base @max-[620px]:grid-cols-1">
          <Line label="Module" value={report.module_label} />
          <Line label="Report" value={report.title} />
          <Line label="Scope" value={report.scope_label || '—'} />
          <Line label="Generated" value={preview?.generated_display || formatStamp(report.created_at)} />
          <Line label="Currency" value={report.currency} />
          <Line
            label="Formats"
            value={
              report.available_formats.length
                ? report.available_formats.map((f) => f.toUpperCase()).join(' + ')
                : 'None'
            }
          />
        </div>

        {preview?.headline && (
          <div className="rounded-[var(--r-md)] bg-surface-muted p-[10px_12px] text-base font-semibold text-ink-primary">
            {preview.headline}
          </div>
        )}

        {preview?.empty_reason && (
          <div className="rounded-[var(--r-md)] bg-status-warning-bg p-[10px_12px] text-sm text-ink-secondary">
            {preview.empty_reason}
          </div>
        )}

        {preview?.kpis?.length > 0 && (
          <div>
            <div className="mb-1.5 text-xs font-semibold uppercase tracking-[0.04em] text-ink-muted">
              Key KPIs
            </div>
            <Table>
              <thead>
                <tr>
                  <Th>KPI</Th>
                  <Th className="text-right">Value</Th>
                  <Th className="text-right">Previous</Th>
                  <Th className="text-right">Delta</Th>
                </tr>
              </thead>
              <tbody>
                {preview.kpis.map((kpi) => (
                  <Tr key={kpi.label}>
                    <Td emphasis>{kpi.label}</Td>
                    <Td className="text-right tabular-nums">{kpi.display}</Td>
                    <Td className="text-right tabular-nums">{kpi.previous_display || '—'}</Td>
                    <Td className="text-right tabular-nums">{kpi.delta_display || '—'}</Td>
                  </Tr>
                ))}
              </tbody>
            </Table>
          </div>
        )}

        {preview?.highlights?.length > 0 && (
          <div>
            <div className="mb-1.5 text-xs font-semibold uppercase tracking-[0.04em] text-ink-muted">
              Summary
            </div>
            <div className="grid grid-cols-2 gap-x-6 gap-y-1.5 text-base @max-[620px]:grid-cols-1">
              {preview.highlights.map((h) => (
                <Line key={h.label} label={h.label} value={h.value} />
              ))}
            </div>
          </div>
        )}

        {preview?.narrative?.length > 0 && (
          <div>
            <div className="mb-1.5 text-xs font-semibold uppercase tracking-[0.04em] text-ink-muted">
              Recommendation
            </div>
            <ul className="flex flex-col gap-1.5">
              {preview.narrative.map((line, i) => (
                <li key={i} className="text-base leading-[1.55] text-ink-secondary">
                  {line}
                </li>
              ))}
            </ul>
          </div>
        )}

        <div className="border-t border-border-subtle pt-3 text-xs leading-[1.5] text-ink-muted">
          This preview is the summary stored when the report was generated. Download the
          Excel or PDF for the full report.
        </div>
      </div>
    </Modal>
  )
}

function Line({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-baseline justify-between gap-3">
      <span className="shrink-0 text-ink-muted">{label}</span>
      <span className="truncate text-right font-semibold text-ink-primary" title={value}>
        {value}
      </span>
    </div>
  )
}

/** ISO timestamp -> "24 Aug 2026 · 12:42 PM". Only used when a report has no
 *  stored preview to read the server's own rendering from. */
function formatStamp(iso: string): string {
  const at = new Date(iso)
  if (Number.isNaN(at.getTime())) return iso
  return `${at.toLocaleDateString(undefined, { day: '2-digit', month: 'short', year: 'numeric' })} · ${at.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })}`
}
