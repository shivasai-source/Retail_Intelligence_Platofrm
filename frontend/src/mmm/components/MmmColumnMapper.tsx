import { useMemo, useState } from 'react'
import { Button, Select } from '../../components/ui'
import { Icon } from '../../icons'
import { channelLabel, MMM_COLUMNS, type MmmGroup } from '../schema'
import type { MmmInspectResult, MmmMatchSource, MmmProposal } from '../types'

// MMM — THE MAPPING SCREEN. "Your column → MMM's column", for a file whose
// header is not ours.
//
// WHY IT EXISTS. A real marketing extract calls the day `TxnDate`, revenue
// `NetSales` and television spend `TV`, so the whole upload was refused as
// "Missing required column: Revenue" — a message about the wrong problem,
// since the file holds exactly the right data under different names. The
// backend (app/mmm/mapping.py) proposes the mapping; this screen is where the
// reader confirms or corrects it, and only the confirmed mapping is installed.
//
// WHAT IT NEVER DOES IS DECIDE. Every row starts on what the server proposed,
// and each proposal carries WHICH PASS found it, so a guess reads as a guess:
//
//   exact    already MMM's name          — shown as found, not as a question
//   alias    a synonym that can only mean that column
//   channel  a channel named without _Spend (`TV`, `Meta Ads Investment`)
//   typo     a misspelling — the one kind that says "check this"
//   new      a spend column of its own (`Radio_Cost` → `Radio_Spend`)
//
// A column whose name is AMBIGUOUS is deliberately not proposed at all. `Print`
// could be Newspaper or Magazine; `OOH` could be any of three channels. Spend
// put on the wrong channel moves that channel's whole response curve and so
// every recommendation the Budget Optimizer makes, with no error anywhere — so
// the server leaves those spare and this screen asks.

const SOURCE_LABEL: Record<MmmMatchSource, string> = {
  exact: 'Already MMM’s name',
  alias: 'Recognised synonym',
  channel: 'Matched to this channel',
  typo: 'Looks like a misspelling — check this',
  new: 'Read as a channel of its own',
}

const SOURCE_TONE: Record<MmmMatchSource, string> = {
  exact: 'text-[var(--pill-success-ink)]',
  alias: 'text-[var(--pill-success-ink)]',
  channel: 'text-[var(--pill-success-ink)]',
  typo: 'text-[var(--pill-warning-ink)]',
  new: 'text-ink-muted',
}

const NOT_MAPPED = '—'

/** What MMM calls a column, for a reader who has never seen the contract. */
function targetLabel(canonical: string): string {
  const spec = MMM_COLUMNS.find((c) => c.name === canonical)
  if (spec) return spec.group === 'media' ? `${channelLabel(canonical)} spend` : spec.name
  if (canonical.toLowerCase().endsWith('_spend')) return `${channelLabel(canonical)} spend`
  return canonical
}

const GROUP_ORDER: MmmGroup[] = ['core', 'media', 'promo', 'calendar']

/** Which section a target belongs under. A channel MMM has never heard of is
 *  still media — that is the whole point of accepting it. */
function groupOf(canonical: string): MmmGroup {
  const spec = MMM_COLUMNS.find((c) => c.name === canonical)
  if (spec) return spec.group === 'rollup' ? 'media' : spec.group
  return canonical.toLowerCase().endsWith('_spend') ? 'media' : 'promo'
}

/** Every target worth offering a row for: what MMM requires, what the server
 *  proposed (including channels invented from the file), the optional columns
 *  MMM reads when they are there, and — when `allChannels` — the 22 reference
 *  channels nothing matched.
 *
 *  THE LAST PART IS NOT A DETAIL. A column the server deliberately refused to
 *  guess at, `Print` or `OOH`, can only be assigned to a channel that has a
 *  row; without the full list the screen would tell the reader to pick the
 *  channel and then offer nowhere to pick it. The rows are hidden behind a
 *  toggle rather than always drawn because 22 mostly-empty rows would bury the
 *  handful that matter in the common case. */
function targets(proposal: MmmProposal, allChannels: boolean): string[] {
  const required = ['Date', 'Revenue']
  const proposed = Object.keys(proposal.mapping)
  const optional = MMM_COLUMNS.filter((c) => c.group === 'promo' || c.group === 'calendar').map(
    (c) => c.name,
  )
  const channels = allChannels
    ? MMM_COLUMNS.filter((c) => c.group === 'media').map((c) => c.name)
    : []
  const all = [...new Set([...required, ...proposed, ...optional, ...channels])]
  return all.sort((a, b) => {
    const g = GROUP_ORDER.indexOf(groupOf(a)) - GROUP_ORDER.indexOf(groupOf(b))
    if (g !== 0) return g
    // Inside a group: what is mapped first, so the work left is at the bottom.
    const mapped = Number(Boolean(proposal.mapping[b])) - Number(Boolean(proposal.mapping[a]))
    return mapped !== 0 ? mapped : a.localeCompare(b)
  })
}

/**
 * `renames` is actual -> canonical, which is what the installer takes. The
 * screen works the other way round (one row per MMM column), so it holds
 * canonical -> actual and inverts on confirm.
 */
export function MmmColumnMapper({
  inspection,
  busy,
  deliveryOk,
  deliveryProblems,
  onBack,
  onConfirm,
  onTry,
}: {
  /** The latest preflight — the proposal, the file's own columns, and whether
   *  the mapping as it stands would install. */
  inspection: MmmInspectResult
  busy?: boolean
  /** Whether the WHOLE delivery would install. A file holding only Q1's spend
   *  is missing nothing when another file carries Q1's revenue, so the footer
   *  reports the delivery's verdict and the rows report this file's. */
  deliveryOk?: boolean
  deliveryProblems?: string[]
  onBack: () => void
  /** The confirmed mapping, actual -> canonical. */
  onConfirm: (renames: Record<string, string>) => void
  /** Re-run the preflight with the mapping as it stands, so the verdict under
   *  the rows is the server's and not this component's opinion. */
  onTry?: (renames: Record<string, string>) => void
}) {
  const proposal = inspection.proposal
  const [chosen, setChosen] = useState<Record<string, string>>(() => ({ ...proposal.mapping }))
  /** Rows the reader has touched, so a correction is never relabelled as the
   *  server's own guess. */
  const [edited, setEdited] = useState<ReadonlySet<string>>(() => new Set())

  /** The 22 reference channels, shown on request — or straight away when the
   *  file still needs a spend column, since that is exactly when the reader
   *  has to reach one the server would not guess. */
  const [allChannels, setAllChannels] = useState(
    () => !Object.keys(proposal.mapping).some((c) => c.toLowerCase().endsWith('_spend')),
  )
  const rows = useMemo(() => targets(proposal, allChannels), [proposal, allChannels])
  const columns = inspection.source_columns
  const hiddenChannels = useMemo(
    () => targets(proposal, true).length - targets(proposal, false).length,
    [proposal],
  )

  /** actual -> canonical, dropping the columns that keep their name. */
  const renames = useMemo(() => {
    const out: Record<string, string> = {}
    for (const [canonical, actual] of Object.entries(chosen)) {
      if (actual && actual !== canonical) out[actual] = canonical
    }
    return out
  }, [chosen])

  /** A column already spoken for by another row — offered, but flagged, since
   *  one column cannot be two things. */
  const takenBy = useMemo(() => {
    const out: Record<string, string> = {}
    for (const [canonical, actual] of Object.entries(chosen)) if (actual) out[actual] = canonical
    return out
  }, [chosen])

  const set = (canonical: string, actual: string) => {
    setEdited((prev) => new Set(prev).add(canonical))
    setChosen((prev) => {
      const next = { ...prev }
      if (actual === NOT_MAPPED) delete next[canonical]
      else {
        // One column, one meaning: claiming it releases the row that had it.
        for (const [other, value] of Object.entries(next)) {
          if (other !== canonical && value === actual) delete next[other]
        }
        next[canonical] = actual
      }
      return next
    })
  }

  const mappedSpend = Object.keys(chosen).filter(
    (c) => c.toLowerCase().endsWith('_spend') && !c.toLowerCase().startsWith('channel_') && c !== 'Total_Spend',
  )
  const missing = [
    ...(chosen.Date ? [] : ['Date']),
    ...(chosen.Revenue ? [] : ['Revenue']),
    ...(mappedSpend.length ? [] : ['at least one media spend column']),
  ]
  // This file's own completeness, and then the delivery's — which is what the
  // install actually judges, and the only one that may enable the button.
  const ownReady = missing.length === 0
  const ready = deliveryOk === undefined ? ownReady : ownReady || deliveryOk

  return (
    <>
      <div className="max-h-[56vh] overflow-y-auto p-[16px_20px]">
        <div className="mb-3 flex items-start gap-2 rounded-[var(--r-md)] bg-surface-muted p-[10px_12px] text-sm leading-[1.5] text-ink-muted [&_svg]:mt-px [&_svg]:h-[15px] [&_svg]:w-[15px] [&_svg]:shrink-0">
          <Icon name="info" />
          <span>
            This file uses its own column names, so MMM has matched what it could and left the rest
            to you. Nothing is read until you confirm. {columns.length} columns were found in{' '}
            <strong className="font-medium text-ink-primary">{inspection.filename}</strong>.
          </span>
        </div>

        {GROUP_ORDER.map((group) => {
          const inGroup = rows.filter((r) => groupOf(r) === group)
          if (!inGroup.length) return null
          return (
            <div key={group} className="mb-3.5">
              <div className="mb-1.5 text-xs font-medium text-ink-muted">
                {group === 'core'
                  ? 'Required — date & revenue'
                  : group === 'media'
                    ? 'Media spend — at least one is required'
                    : group === 'promo'
                      ? 'Promotions & events — optional'
                      : 'Calendar — optional, worked out from Date when absent'}
              </div>
              <div className="flex flex-col gap-1.5">
                {inGroup.map((canonical) => {
                  const actual = chosen[canonical] ?? ''
                  const source = proposal.sources[canonical]
                  const touched = edited.has(canonical)
                  const clash = actual && takenBy[actual] !== canonical
                  return (
                    <div
                      key={canonical}
                      className="flex flex-wrap items-center gap-2 rounded-[var(--r-md)] bg-surface-muted p-[8px_11px]"
                    >
                      <span className="min-w-[132px] flex-1 truncate text-base" title={canonical}>
                        {targetLabel(canonical)}
                        {(canonical === 'Date' || canonical === 'Revenue') && (
                          <span className="ml-1 text-[var(--pill-danger-ink)]">*</span>
                        )}
                      </span>
                      <Icon name="arrowRight" className="h-3.5 w-3.5 shrink-0 text-ink-muted" />
                      <div className="min-w-[170px]">
                        <Select
                          value={actual || NOT_MAPPED}
                          aria-label={`The column holding ${targetLabel(canonical)}`}
                          onChange={(e) => set(canonical, e.target.value)}
                        >
                          <option value={NOT_MAPPED}>Not in this file</option>
                          {columns.map((c) => (
                            <option key={c} value={c}>
                              {takenBy[c] && takenBy[c] !== canonical ? `${c} (already used)` : c}
                            </option>
                          ))}
                        </Select>
                      </div>
                      <span className="w-full text-xs leading-[1.45] text-ink-muted @min-[520px]:w-[190px] @min-[520px]:text-right">
                        {clash ? (
                          <span className="text-[var(--pill-danger-ink)]">
                            Also used for {takenBy[actual]}
                          </span>
                        ) : !actual ? (
                          canonical === 'Date' || canonical === 'Revenue' ? (
                            <span className="text-[var(--pill-danger-ink)]">Required — pick a column</span>
                          ) : (
                            'Not read'
                          )
                        ) : touched ? (
                          'Your choice'
                        ) : source ? (
                          <span className={SOURCE_TONE[source]}>{SOURCE_LABEL[source]}</span>
                        ) : (
                          'Your choice'
                        )}
                      </span>
                    </div>
                  )
                })}
              </div>
              {group === 'media' && hiddenChannels > 0 && (
                <button
                  type="button"
                  onClick={() => setAllChannels((v) => !v)}
                  className="mt-1.5 inline-flex items-center gap-1.5 text-sm font-medium text-brand-violet hover:underline [&_svg]:h-3.5 [&_svg]:w-3.5"
                >
                  {/* Rotated rather than a second glyph — the icon set has
                      no chevronUp and this is not worth adding one for. */}
                  <Icon name="chevronDown" className={allChannels ? 'rotate-180' : ''} />
                  {allChannels
                    ? 'Hide the channels this file has nothing for'
                    : `Show all ${hiddenChannels} other media channels`}
                </button>
              )}
            </div>
          )
        })}

        {proposal.spare.length > 0 && (
          <div className="rounded-[var(--r-md)] border border-border-subtle p-[10px_12px] text-xs leading-[1.5] text-ink-muted">
            Not matched to anything, so not read:{' '}
            {proposal.spare.filter((c) => !takenBy[c]).join(', ') || 'none'}.{' '}
            {proposal.spare.some((c) => !takenBy[c]) &&
              'A name that could mean two channels — Print, OOH, Social — is never guessed at; pick it above if you know which it is.'}
          </div>
        )}

        {inspection.dropped.length > 0 && (
          <div className="mt-2.5 rounded-[var(--r-md)] bg-status-warning-bg p-[10px_12px] text-xs leading-[1.5] text-[var(--pill-warning-ink)]">
            Mapped onto a column the file already has, so the original will be dropped:{' '}
            {inspection.dropped.join(', ')}.
          </div>
        )}
      </div>

      <div className="flex items-center justify-between gap-2 border-t border-border-subtle p-[14px_20px]">
        <span className="text-xs leading-[1.45] text-ink-muted">
          {!ownReady && deliveryOk
            ? `${missing.join(', ')} come from another file in this delivery`
            : ready
              ? `${Object.keys(chosen).length} of ${columns.length} columns mapped`
              : `Still needed: ${(deliveryProblems?.length ? deliveryProblems : missing).join(', ')}`}
        </span>
        <div className="flex gap-2">
          <Button variant="ghost" onClick={onBack} disabled={busy}>
            Back
          </Button>
          {onTry && (
            <Button variant="secondary" onClick={() => onTry(renames)} disabled={!ready || busy}>
              <Icon name="refresh" /> Re-check
            </Button>
          )}
          <Button variant="primary" onClick={() => onConfirm(renames)} disabled={!ready || busy}>
            <Icon name="check" /> {busy ? 'Loading dataset…' : 'Use this mapping'}
          </Button>
        </div>
      </div>
    </>
  )
}
