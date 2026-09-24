import { useNavigate } from 'react-router-dom'
import { Button, useToast } from '../ui'
import { Icon } from '../../icons'
import { useGenerateReport } from '../../hooks/useReportCenter'
import type { ReportModule } from '../../types/reportCenter'

/** THE ONE GENERATE CONTROL, used by every module that has a report.
 *
 *  IT DOES NOT DOWNLOAD ANYTHING. Clicking it generates a report into the TPO
 *  Intelligence Report Center and says so; the file is downloaded later, from the
 *  Reports page, by a person who explicitly asks for Excel or PDF. That is the
 *  whole shape of the workflow:
 *
 *      module -> Export Report -> stored in the Report Center
 *      Reports page -> Download Excel / Download PDF -> browser saves a file
 *
 *  A single button, not a format menu: both artifacts are produced and stored,
 *  and the choice of format belongs at the point of download rather than at the
 *  point of generation.
 *
 *  IT CLAIMS NOTHING IT DID NOT DO. The success toast fires only after the server
 *  confirms a READY report with artifacts behind it, and offers a link to it; a
 *  failure shows the server's own reason.
 *
 *  THE SCOPE IS RESOLVED AT CLICK TIME. `scope` and `options` are read through
 *  callbacks rather than captured props, so a report always reflects what the
 *  screen is showing at the moment the user asks for it — which is what makes
 *  "change a filter, generate again" produce a different report with no cache to
 *  invalidate.
 */
export function ExportReportButton({
  module,
  scope,
  options,
  currency,
  disabled,
  disabledReason,
  label = 'Export Report',
  collapse = false,
}: {
  module: ReportModule
  /** Read at click time — see the note above. */
  scope: () => Record<string, unknown>
  options?: () => Record<string, unknown>
  currency?: string
  /** Set when the screen has nothing to report on yet. */
  disabled?: boolean
  disabledReason?: string
  label?: string
  /** Icon only until pointed at, the label sliding out on hover or keyboard
   *  focus. For a toolbar that has run out of room — the Insights Hub's — where
   *  Export is the one control a reader reaches for deliberately rather than
   *  scans for. Off by default: every other module has the width, and a
   *  permanently captioned button is the more discoverable one. */
  collapse?: boolean
}) {
  const { show } = useToast()
  const navigate = useNavigate()
  const generate = useGenerateReport()

  const run = () => {
    if (generate.isPending) return
    generate.mutate(
      { module, scope: scope(), options: options?.() ?? {}, currency },
      {
        // ONE toast, and NO navigation. The brief is explicit that generating
        // must not force the user off the module they are working in, so the
        // follow-up is offered as the "View Report" button that appears beside
        // this one rather than taken for them.
        onSuccess: (report) =>
          show(
            `Report generated successfully — ${report.name}. Open Reports to download it.`,
            { duration: 7000 },
          ),
        onError: (error) =>
          show(
            `Unable to generate report. ${error.message}`,
            // The shared Toast offers 'success' and 'info' only; a failure is not
            // given a new variant here, so the MESSAGE carries the failure and is
            // held on screen longer than a success.
            { variant: 'info', duration: 8000 },
          ),
      },
    )
  }

  // Busy is never collapsed: "Generating…" is the whole point of the state, and
  // hiding it behind a hover would make the button look merely unresponsive.
  const text = generate.isPending ? 'Generating…' : label
  const showLabel = !collapse || generate.isPending

  /** The label, either plain or sliding out from zero width.
   *
   *  The reveal is a `grid-template-columns: 0fr -> 1fr` transition rather than
   *  a width or max-width one: it animates to the text's OWN width, so the
   *  button never overshoots or clips at a guessed maximum, and the row beside
   *  it is laid out from a real measurement. `group-focus-visible` is not
   *  decoration — without it the control is icon-only for anyone arriving by
   *  keyboard. */
  const caption = showLabel ? (
    <span>{text}</span>
  ) : (
    <span
      aria-hidden="true"
      className="grid grid-cols-[0fr] transition-[grid-template-columns] duration-200 ease-[var(--ease-out)] group-hover:grid-cols-[1fr] group-focus-visible:grid-cols-[1fr]"
    >
      <span className="overflow-hidden">
        <span className="block whitespace-nowrap pl-2">{text}</span>
      </span>
    </span>
  )

  // `gap-0` cancels the Button's own gap so the collapsed state is a square;
  // the padding that separates icon from label lives on the label instead.
  const shape = collapse ? 'group cursor-pointer !gap-0 !px-2.5' : 'cursor-pointer'

  if (disabled) {
    return (
      <Button
        variant="secondary"
        disabled
        title={disabledReason}
        aria-label={label}
        className={collapse ? '!gap-0 !px-2.5' : undefined}
      >
        <Icon name="download" />
        {showLabel && <span>{label}</span>}
      </Button>
    )
  }

  return (
    <span className="inline-flex items-center gap-2">
      <Button
        variant="secondary"
        onClick={run}
        disabled={generate.isPending}
        className={shape}
        aria-label={text}
        title="Generate this view as a report and store it in the Report Center"
      >
        <Icon name="download" />
        {caption}
      </Button>
      {generate.isSuccess && (
        <Button
          variant="secondary"
          onClick={() => navigate('/reports')}
          className="cursor-pointer"
          title="Open the Report Center"
        >
          <Icon name="arrowRight" /> <span>View Report</span>
        </Button>
      )}
    </span>
  )
}
