import { useState } from 'react'
import { Icon, type IconName } from '../../icons'
import { Button, IconButton, Modal, useToast } from '../../components/ui'
import { downloadCsv } from '../../components/analyst/chartDownload'
import {
  COLUMN_TYPE_LABELS,
  GROUP_LABELS,
  GROUP_PURPOSE,
  MMM_COLUMNS,
  MMM_GROUPS,
  MMM_RULES,
  columnsIn,
  mmmTemplate,
  type MmmGroup,
} from '../schema'

// MMM — DATA REQUIREMENTS. The MMM twin of TPO's DataRequirementsDetail, in the
// same layout and type scale: a list on the left (the four column groups of
// the daily file, then the formatting rules) and the chosen one on the right.
//
// TPO's guide describes six files; MMM's describes ONE file in four groups,
// so the template and "Copy headers" act on the whole file — one template with
// all 33 columns and three real rows from the reference dataset — rather than
// per group. Opened from the Data Connections page ("What do I upload?", and
// on its own while nothing is loaded) and from inside the upload dialog.

const GROUP_ICON: Record<MmmGroup, IconName> = {
  core: 'barChart',
  media: 'layers',
  promo: 'tag',
  calendar: 'calendar',
}

type Section = MmmGroup | 'rules'

export function MmmDataRequirements({
  onClose,
  onBack,
  onStartUpload,
  autoOpened = false,
  onDontShowAgain,
}: {
  onClose: () => void
  /** Opened from inside the upload dialog — returns to it. */
  onBack?: () => void
  /** Opened from the page — hands off to the upload dialog. */
  onStartUpload?: () => void
  autoOpened?: boolean
  onDontShowAgain?: (value: boolean) => void
}) {
  const [section, setSection] = useState<Section>('core')
  const [dontShow, setDontShow] = useState(false)
  const { show } = useToast()

  const copyHeaders = async () => {
    try {
      await navigator.clipboard.writeText(MMM_COLUMNS.map((c) => c.name).join(','))
      show('All 33 column headers copied — paste them into row 1 of your file.', { duration: 3000 })
    } catch {
      show("Couldn't copy — download the template instead.", { duration: 3500 })
    }
  }

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
            <p className="mt-0.5 text-[14px] text-ink-muted">
              One daily file — what its {MMM_COLUMNS.length} columns must contain.
            </p>
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <Button variant="secondary" onClick={copyHeaders} className="@max-[760px]:hidden">
            <Icon name="file" /> Copy headers
          </Button>
          <Button variant="violet-soft" onClick={() => downloadCsv(mmmTemplate(), 'MMM_template_daily')}>
            <Icon name="download" /> Download template
          </Button>
          <IconButton icon="x" title="Close" onClick={onClose} />
        </div>
      </div>

      <div className="grid h-[min(64vh,580px)] grid-cols-[250px_1fr] @max-[760px]:h-auto @max-[760px]:grid-cols-1">
        <nav
          aria-label="Requirements"
          className="overflow-y-auto border-r border-border-subtle bg-surface-muted/40 p-3 @max-[760px]:border-b @max-[760px]:border-r-0"
        >
          <div className="px-3 pb-2 pt-1 text-[13px] font-semibold text-ink-muted">Column groups</div>
          {MMM_GROUPS.map((group) => {
            const cols = columnsIn(group)
            const required = cols.filter((c) => c.required).length
            return (
              <NavItem
                key={group}
                icon={GROUP_ICON[group]}
                label={GROUP_LABELS[group]}
                sub={
                  group === 'media'
                    ? `${cols.length} channels · at least 1 required`
                    : required
                      ? `${cols.length} columns · required`
                      : `${cols.length} columns · optional`
                }
                active={section === group}
                onClick={() => setSection(group)}
              />
            )
          })}
          <div className="mx-3 my-2.5 border-t border-border-subtle" />
          <NavItem
            icon="shield"
            label="Formatting rules"
            sub={`${MMM_RULES.length} things to check`}
            active={section === 'rules'}
            onClick={() => setSection('rules')}
          />
        </nav>

        <div key={section} className="fade-in min-w-0 overflow-y-auto p-[22px_26px]">
          {section === 'rules' ? <RulesPane /> : <GroupPane group={section} />}
        </div>
      </div>

      <div className="flex flex-wrap items-center justify-between gap-3 border-t border-border-subtle p-[14px_24px]">
        {onBack ? (
          <>
            <span className="text-[13px] text-ink-muted">The file you already picked is kept.</span>
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
                  <Icon name="plus" /> Upload file
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

function GroupPane({ group }: { group: MmmGroup }) {
  const columns = columnsIn(group)
  return (
    <>
      <h4 className="text-[18px] font-bold text-ink-primary">{GROUP_LABELS[group]}</h4>
      <p className="mt-1 text-[14px] leading-[1.55] text-ink-secondary">{GROUP_PURPOSE[group]}</p>

      <table className="mt-5 w-full border-collapse">
        <thead>
          <tr className="border-b border-border-default text-left text-[13px] text-ink-muted">
            <th className="w-[34%] pb-2.5 pr-4 font-semibold">Column</th>
            <th className="w-[20%] pb-2.5 pr-4 font-semibold">Example</th>
            <th className="pb-2.5 font-semibold">Description</th>
          </tr>
        </thead>
        <tbody>
          {columns.map((c) => (
            <tr key={c.name} className="border-b border-border-subtle align-top last:border-b-0">
              <td className="py-3 pr-4">
                <div className="flex flex-wrap items-center gap-1.5">
                  <span className="font-mono text-[14px] font-semibold text-ink-primary">{c.name}</span>
                  {c.required && (
                    <span className="rounded-[var(--r-pill)] bg-brand-violet-50 px-1.5 py-px text-[11px] font-bold text-brand-violet">
                      Required
                    </span>
                  )}
                </div>
                <div className="mt-0.5 text-[12.5px] text-ink-muted">{COLUMN_TYPE_LABELS[c.type]}</div>
              </td>
              <td className="py-3 pr-4 font-mono text-[14px] text-ink-secondary">{c.example || '—'}</td>
              <td className="py-3 text-[14px] leading-[1.55] text-ink-secondary">{c.description}</td>
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
        {MMM_RULES.map((rule, i) => (
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
