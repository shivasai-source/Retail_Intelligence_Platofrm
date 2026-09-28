import { useState } from 'react'
import { Icon, type IconName } from '../../../icons'
import { Modal, Button, IconButton, useToast } from '../../ui'
import { STAR_ROLES, STAR_ROLE_LABELS } from '../../../lib/starSchema'
import { COLUMN_TYPE_LABELS, guideFor, templateFor } from '../../../lib/starSchemaGuide'
import { downloadCsv } from '../../analyst/chartDownload'
import type { StarRole } from '../../../types/dataset'

// The data requirements — the one guide, opened from two places.
//
// From the Connections page (on its own while no dataset is loaded, or from the
// banner's "What do I upload?") it closes or hands off to the upload dialog.
// From inside the upload dialog it is a detour with `onBack` as the way home.
// Either way it is the same reference: every required column of every file,
// with its type, a real example and a plain description, plus the formatting
// rules the loader assumes.
//
// ONE PATTERN, READABLE TYPE. A list of seven entries on the left (the six
// files, then the formatting rules) and the chosen one on the right. Nothing
// else competes for attention: no schema diagram, no identifier pills, no
// inline cross-links — how the files connect is said in words in the
// description of each ID column. Body text is 14px and headings 18px; the
// app's dense 11–12px scale suits a dashboard, not a page someone reads.
//
// Inside the upload dialog it takes over like StarFileViewer does, so the files
// already picked survive the detour — `onBack` is the return trip.

const ROLE_ICON: Record<StarRole, IconName> = {
  fact: 'barChart',
  product: 'package',
  geo_store: 'retailer',
  channel: 'layers',
  promotion: 'tag',
  date: 'calendar',
}

const RULES: Array<{ title: string; body: string }> = [
  {
    title: 'Upload all six files together',
    body: 'The files only make sense as a set, so a partial upload is refused. Loading a new dataset replaces the current one.',
  },
  {
    title: 'Headers identify each file — names don’t matter',
    body: '“Book1.xlsx” is fine. Put the column names in row 1; upper or lower case both work, and extra columns are ignored.',
  },
  {
    title: 'Write dates as DD-MM-YYYY',
    body: '01-02-2024 means 1 February 2024. In Excel, set date columns to Text before saving so they keep this format.',
  },
  {
    title: 'Keep numbers plain',
    body: 'No ₹ signs, thousand separators or units. A value that isn’t a number is read as 0, without any warning.',
  },
  {
    title: 'Use -1 for “no promotion”',
    body: 'Sales without a promotion carry Promotion_Id -1, and the promotion file needs a -1 row too.',
  },
  {
    title: 'Use the same IDs in every file',
    body: 'Each Product_id, Store_Id and Promotion_Id in the sales file should exist in its own file, or it shows up without a name.',
  },
  {
    title: 'Cover every sales week in the date file',
    body: 'Each year and week that appears in your sales must be in the date file, otherwise loading stops.',
  },
  {
    title: 'Use CSV (UTF-8) or Excel',
    body: '.csv, .xlsx and .xls are accepted. For Excel files, only the first sheet is read.',
  },
]

type Section = StarRole | 'rules'

export function DataRequirementsDetail({
  onClose,
  onBack,
  onStartUpload,
  autoOpened = false,
  onDontShowAgain,
}: {
  onClose: () => void
  /** Set when opened from inside the upload dialog — returns to it. */
  onBack?: () => void
  /** Set when opened from the page — hands off to the upload dialog. */
  onStartUpload?: () => void
  /** Opened by the page rather than by a click, so offer to stop doing that. */
  autoOpened?: boolean
  onDontShowAgain?: (value: boolean) => void
}) {
  const [section, setSection] = useState<Section>('fact')
  const [dontShow, setDontShow] = useState(false)

  return (
    <Modal open onClose={onClose} maxWidthClassName="max-w-[min(1000px,94vw)]">
      <div className="flex items-center justify-between gap-3 border-b border-border-subtle p-[18px_24px]">
        <div className="flex min-w-0 items-center gap-3">
          {onBack ? (
            <IconButton icon="chevronLeft" title="Back to upload" onClick={onBack} />
          ) : (
            <span className="grid h-10 w-10 shrink-0 place-items-center rounded-[10px] bg-tint-lavender text-tint-lavender-icon [&_svg]:h-5 [&_svg]:w-5">
              <Icon name="book" />
            </span>
          )}
          <div className="min-w-0">
            <h3 className="text-[19px] font-bold">Data requirements</h3>
            <p className="mt-0.5 text-[14px] text-ink-muted">What each of the six files must contain.</p>
          </div>
        </div>
        <IconButton icon="x" title="Close" onClick={onClose} />
      </div>

      <div className="grid h-[min(64vh,580px)] grid-cols-[250px_1fr] @max-[760px]:h-auto @max-[760px]:grid-cols-1">
        <nav
          aria-label="Requirements"
          className="overflow-y-auto border-r border-border-subtle bg-surface-muted/40 p-3 @max-[760px]:border-b @max-[760px]:border-r-0"
        >
          <div className="px-3 pb-2 pt-1 text-[13px] font-semibold text-ink-muted">Files</div>
          {STAR_ROLES.map((role) => (
            <NavItem
              key={role}
              icon={ROLE_ICON[role]}
              label={STAR_ROLE_LABELS[role]}
              sub={`${guideFor(role).columns.length} columns`}
              active={section === role}
              onClick={() => setSection(role)}
            />
          ))}
          <div className="mx-3 my-2.5 border-t border-border-subtle" />
          <NavItem
            icon="shield"
            label="Formatting rules"
            sub={`${RULES.length} things to check`}
            active={section === 'rules'}
            onClick={() => setSection('rules')}
          />
        </nav>

        <div key={section} className="fade-in min-w-0 overflow-y-auto p-[22px_26px]">
          {section === 'rules' ? <RulesPane /> : <FilePane role={section} />}
        </div>
      </div>

      <div className="flex flex-wrap items-center justify-between gap-3 border-t border-border-subtle p-[14px_24px]">
        {onBack ? (
          <>
            <span className="text-[13px] text-ink-muted">The files you already picked are kept.</span>
            <Button variant="primary" onClick={onBack}>
              Back to upload
            </Button>
          </>
        ) : (
          <>
            {autoOpened && onDontShowAgain ? (
              <label className="flex cursor-pointer items-center gap-2 text-[13px] text-ink-muted">
                <input
                  type="checkbox"
                  checked={dontShow}
                  onChange={(e) => {
                    setDontShow(e.target.checked)
                    onDontShowAgain(e.target.checked)
                  }}
                  className="h-3.5 w-3.5 accent-[var(--brand-violet)]"
                />
                Don't show this again
              </label>
            ) : (
              <span />
            )}
            <div className="flex gap-2">
              <Button variant="ghost" onClick={onClose}>
                Close
              </Button>
              {onStartUpload && (
                <Button variant="primary" onClick={onStartUpload}>
                  <Icon name="plus" /> Upload files
                </Button>
              )}
            </div>
          </>
        )}
      </div>
    </Modal>
  )
}

function NavItem({
  icon,
  label,
  sub,
  active,
  onClick,
}: {
  icon: IconName
  label: string
  sub: string
  active: boolean
  onClick: () => void
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-current={active}
      className={`relative mb-0.5 flex w-full items-center gap-3 rounded-[var(--r-md)] px-3 py-2 text-left transition-colors duration-150 ${
        active ? 'bg-surface-card shadow-[var(--shadow-sm)]' : 'hover:bg-surface-card/70'
      }`}
    >
      {active && <span className="absolute inset-y-2 left-0 w-[3px] rounded-full bg-brand-violet" />}
      <span
        className={`grid h-8 w-8 shrink-0 place-items-center rounded-[9px] [&_svg]:h-4 [&_svg]:w-4 ${
          active ? 'bg-brand-violet text-white' : 'bg-tint-lavender text-tint-lavender-icon'
        }`}
      >
        <Icon name={icon} />
      </span>
      <span className="min-w-0 flex-1">
        <span className={`block text-[14px] font-semibold leading-snug ${active ? 'text-ink-primary' : 'text-ink-secondary'}`}>
          {label}
        </span>
        <span className="block text-[12.5px] text-ink-muted">{sub}</span>
      </span>
    </button>
  )
}

/** One file: what it is, and every column it needs. */
function FilePane({ role }: { role: StarRole }) {
  const guide = guideFor(role)
  const { show } = useToast()

  const copyHeaders = async () => {
    try {
      await navigator.clipboard.writeText(guide.columns.map((c) => c.name).join(','))
      show('Column headers copied — paste them into row 1 of your file.', { duration: 3000 })
    } catch {
      show("Couldn't copy — download the template instead.", { duration: 3500 })
    }
  }

  return (
    <>
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="min-w-0">
          <h4 className="text-[18px] font-bold text-ink-primary">{guide.label}</h4>
          <p className="mt-1 text-[14px] leading-[1.55] text-ink-secondary">{guide.purpose}</p>
        </div>
        <div className="flex shrink-0 gap-2">
          <Button variant="secondary" onClick={copyHeaders}>
            <Icon name="file" /> Copy headers
          </Button>
          <Button variant="violet-soft" onClick={() => downloadCsv(templateFor(role), `template_${role}`)}>
            <Icon name="download" /> Download template
          </Button>
        </div>
      </div>

      <table className="mt-5 w-full border-collapse">
        <thead>
          <tr className="border-b border-border-default text-left text-[13px] text-ink-muted">
            <th className="w-[30%] pb-2.5 pr-4 font-semibold">Column</th>
            <th className="w-[26%] pb-2.5 pr-4 font-semibold">Example</th>
            <th className="pb-2.5 font-semibold">Description</th>
          </tr>
        </thead>
        <tbody>
          {guide.columns.map((c) => (
            <tr key={c.name} className="border-b border-border-subtle align-top last:border-b-0">
              <td className="py-3 pr-4">
                <div className="font-mono text-[14px] font-semibold text-ink-primary">{c.name}</div>
                <div className="mt-0.5 text-[12.5px] text-ink-muted">{COLUMN_TYPE_LABELS[c.type]}</div>
              </td>
              <td className="py-3 pr-4 font-mono text-[14px] text-ink-secondary">{c.example || '—'}</td>
              <td className="py-3 text-[14px] leading-[1.55] text-ink-secondary">
                {c.note}
                {c.joins && c.joins !== role && (
                  <span className="text-ink-muted"> Must match an ID in the {STAR_ROLE_LABELS[c.joins]}.</span>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </>
  )
}

function RulesPane() {
  return (
    <>
      <h4 className="text-[18px] font-bold text-ink-primary">Formatting rules</h4>
      <p className="mt-1 text-[14px] leading-[1.55] text-ink-secondary">
        Most upload problems come from one of these. Check them before you upload.
      </p>
      <ol className="mt-5 flex flex-col">
        {RULES.map((rule, i) => (
          <li key={rule.title} className="flex gap-4 border-b border-border-subtle py-3.5 last:border-b-0">
            <span className="grid h-7 w-7 shrink-0 place-items-center rounded-full bg-brand-violet-50 text-[13px] font-bold text-brand-violet">
              {i + 1}
            </span>
            <div className="min-w-0">
              <div className="text-[15px] font-semibold text-ink-primary">{rule.title}</div>
              <p className="mt-0.5 text-[14px] leading-[1.55] text-ink-secondary">{rule.body}</p>
            </div>
          </li>
        ))}
      </ol>
    </>
  )
}
