import { useEffect, useMemo, useState } from 'react'
import { Icon } from '../../../icons'
import { Modal, Button, IconButton, Pill, Select, Spinner } from '../../ui'
import type { PillTone } from '../../ui'
import { useInspectStarUpload } from '../../../hooks/useDatasets'
import {
  DERIVABLE_ROLES,
  EITHER_COLUMNS,
  OPTIONAL_COLUMNS,
  REQUIRED_ROLES,
  ROLE_COLUMNS,
  STAR_ROLE_LABELS,
} from '../../../lib/starSchema'
import type { StarColumnMapping, StarInspectFile, StarRole } from '../../../types/dataset'

// Saying which of the user's columns is which of ours.
//
// WHY THIS SCREEN EXISTS. No source system exports `Actual_Quantity`; it
// exports `UnitsSold`, `Qty` or `SalesUnits` — and sometimes `UnitsSld`,
// because someone typed the header by hand. Identification used to happen
// through the canonical names themselves, so a client's own export matched no
// table at all and the upload was refused as "not one of the standard tables"
// — a message about the wrong problem, since the data was right and only the
// names were not. Here the user answers the two questions that unblock it:
// which table is this, and which column is which.
//
// SERVER-DRIVEN, ON PURPOSE. Every proposal rendered here comes from
// /api/datasets/star/inspect, which runs the same code the install runs. The
// alias table behind it is 260-odd entries in backend/app/column_mapping.py,
// and the typo pass is scored edit distance over all of them; mirroring either
// into TypeScript would be two contracts to keep in step instead of one — the
// kind of drift where the screen promises something the install then refuses.
// It is also the only way to map an .xlsx: a workbook is a zip whose directory
// sits at the end of the file, so the browser cannot read its header at all.
//
// THE STATUS COLUMN IS THE POINT OF THE LAYOUT. Eleven rows that all look
// equally settled give the user nowhere to look. A field matched by our own
// name, one reached through a synonym, one that is a guess at a misspelling
// and one the user chose themselves deserve four different weights — so the
// weak ones draw the eye and the strong ones stay quiet.
//
// A SAMPLE VALUE SITS BESIDE EVERY CHOICE, and that is a safety feature rather
// than a nicety. Column names cannot tell `Base_Price` from `Actual_Price`,
// and getting that pair the wrong way round inverts every discount in the
// dataset — promotions become price rises, and nothing downstream would ever
// flag it, because both columns are perfectly well-formed numbers. Several
// DISTINCT values are shown rather than one, because on an unpromoted row the
// two prices are equal and a single example taught the user nothing.
//
// Takes over the whole dialog like StarFileViewer does, so the files already
// picked survive the detour — `onBack` is the way home.

/** The dropdown value meaning "no column of mine holds this". */
const ABSENT = ''

/** How a matched field is labelled, by which pass found it. */
const SOURCE_BADGE: Record<string, { tone: PillTone; label: string }> = {
  exact: { tone: 'neutral', label: 'Exact name' },
  alias: { tone: 'info', label: 'Matched by name' },
  typo: { tone: 'warning', label: 'Looks like a typo' },
  chosen: { tone: 'violet', label: 'Your choice' },
}

interface Field {
  /** One row. Several names means an either-group: any one of them satisfies it. */
  names: string[]
  required: boolean
}

export function ColumnMappingPanel({
  files,
  initial,
  onBack,
  onClose,
  onApply,
}: {
  files: File[]
  /** What was settled last time this panel was open. */
  initial: StarColumnMapping[]
  onBack: () => void
  onClose: () => void
  onApply: (mapping: StarColumnMapping[]) => void
}) {
  // Keyed by filename, which is what the backend keys on too.
  const [roles, setRoles] = useState<Record<string, StarRole | null>>(() =>
    Object.fromEntries(initial.map((m) => [m.filename, m.role])),
  )
  const [columns, setColumns] = useState<Record<string, Record<string, string>>>(() =>
    Object.fromEntries(initial.map((m) => [m.filename, { ...m.columns }])),
  )
  const [selected, setSelected] = useState<string>(files[0]?.name ?? '')
  const inspect = useInspectStarUpload()

  // WHAT GOES BACK TO THE SERVER, in two flavours.
  //
  // `settled` is the user's own answers only — a declared role and the columns
  // they picked by hand. It is what re-inspection is given, so the proposals
  // that come back are still marked as proposals: send the server its own
  // suggestions and every field would report itself as "chosen", and the
  // screen would lose the one thing it uses to direct attention.
  const settled = useMemo<StarColumnMapping[]>(
    () =>
      files
        .map((f) => ({
          filename: f.name,
          role: roles[f.name] ?? null,
          columns: columns[f.name] ?? {},
        }))
        .filter((m) => m.role !== null || Object.keys(m.columns).length > 0),
    [files, roles, columns],
  )

  // Re-inspected whenever a role changes, because the proposal depends on it:
  // declaring a file the product dimension is what makes its columns line up
  // against Product_id, Product_Name and the rest. A column choice does NOT
  // refetch — the user is mid-edit and the local state is already the truth.
  const roleKey = files.map((f) => `${f.name}:${roles[f.name] ?? ''}`).join('|')
  useEffect(() => {
    inspect.mutate({ files, mapping: settled })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [roleKey])

  // THE LAST GOOD ANSWER IS KEPT, which is not mere polish. A mutation clears
  // its `data` while the next one is in flight, so every re-inspect blanked
  // the whole screen for a second — and `effective`, which is built from it,
  // briefly described only the fields the user had touched by hand. Pressing
  // "Use these columns" in that window sent a mapping with eleven fields
  // missing. Holding the previous result means the screen never has nothing
  // to show, and the button (disabled below while loading) never has nothing
  // to send.
  const [lastGood, setLastGood] = useState<StarInspectFile[] | null>(null)
  useEffect(() => {
    if (inspect.data?.files) setLastGood(inspect.data.files)
  }, [inspect.data])

  const result = inspect.data ?? (lastGood ? { files: lastGood } : undefined)
  const byName = useMemo(() => {
    const out: Record<string, StarInspectFile> = {}
    for (const f of result?.files ?? []) out[f.filename] = f
    return out
  }, [result])
  // Nothing may be sent while the server's view of these files is being
  // refreshed, because that view is half of what gets sent.
  const settling = inspect.isPending

  const current = byName[selected]
  const file = files.find((f) => f.name === selected)
  // The role in force: what the user declared, else what the server recognised.
  const role = roles[selected] ?? current?.role ?? null
  const available = current?.columns ?? []
  const samples = current?.samples ?? {}

  /** The canonical fields of a role, required first. */
  const fieldsFor = (r: StarRole): Field[] => {
    const groups = EITHER_COLUMNS[r] ?? []
    const inGroup = new Set(groups.flat())
    return [
      ...ROLE_COLUMNS[r].filter((c) => !inGroup.has(c)).map((c) => ({ names: [c], required: true })),
      ...groups.map((g) => ({ names: g, required: true })),
      ...OPTIONAL_COLUMNS[r].map((c) => ({ names: [c], required: false })),
    ]
  }

  /** Which column is standing for `canonical` right now: the user's choice
   *  first, then whatever the server proposed. */
  const chosenFor = (canonical: string): string =>
    columns[selected]?.[canonical] ?? current?.mapping?.[canonical] ?? ABSENT

  const choose = (canonical: string, column: string) => {
    setColumns((prev) => {
      const forFile = { ...(prev[selected] ?? {}) }
      if (column === ABSENT) delete forFile[canonical]
      else forFile[canonical] = column
      return { ...prev, [selected]: forFile }
    })
    // A column choice only means anything against a role, so choosing one
    // commits the role that was on screen when they chose it — but ONLY when
    // that differs from what the server already recognised. Writing back the
    // role it had just told us would change `roleKey` and trigger a pointless
    // re-inspect of every file, which re-reads megabytes and blanks the screen
    // mid-edit.
    if (role && !roles[selected] && role !== current?.role) {
      setRoles((prev) => ({ ...prev, [selected]: role }))
    }
  }

  /** Required fields of one file still without a column, or ['role'] when the
   *  file has not been identified at all. */
  const outstanding = (name: string): string[] => {
    const f = byName[name]
    const r = roles[name] ?? f?.role ?? null
    if (!r) return ['role']
    const picked = columns[name] ?? {}
    const proposed = f?.mapping ?? {}
    const has = (c: string) => Boolean(picked[c] ?? proposed[c])
    const groups = EITHER_COLUMNS[r] ?? []
    const inGroup = new Set(groups.flat())
    return [
      ...ROLE_COLUMNS[r].filter((c) => !inGroup.has(c) && !has(c)),
      ...groups.filter((g) => !g.some(has)).map((g) => g.join(' or ')),
    ]
  }

  const unresolved = files.filter((f) => outstanding(f.name).length > 0)

  // `effective` is the whole picture — what the server proposed with the
  // user's corrections on top — and it is what the upload is sent. Explicit
  // rather than re-derived later: the install then maps exactly what the user
  // was looking at when they pressed the button.
  const effective = useMemo<StarColumnMapping[]>(
    () =>
      files
        .map((f) => {
          const found = byName[f.name]
          return {
            filename: f.name,
            role: roles[f.name] ?? found?.role ?? null,
            columns: { ...(found?.mapping ?? {}), ...(columns[f.name] ?? {}) },
          }
        })
        .filter((m) => m.role !== null || Object.keys(m.columns).length > 0),
    [files, roles, columns, byName],
  )

  // Progress for the file on screen, which is what the header reports.
  const fields = role ? fieldsFor(role) : []
  const requiredFields = fields.filter((f) => f.required)
  const matchedRequired = requiredFields.filter((f) => f.names.some((n) => chosenFor(n))).length
  // Weak matches worth a second look before this is accepted.
  const toConfirm = fields.filter((f) => {
    const canonical = f.names.find((n) => chosenFor(n))
    return canonical && current?.mapping_sources?.[canonical] === 'typo'
      && !columns[selected]?.[canonical]
  }).length

  // Columns of this file that nothing claimed. Harmless — extra columns have
  // always been ignored — but shown so the user can see what is being left out
  // rather than wondering whether it was noticed.
  const ignored = available.filter(
    (c) => !fields.some((f) => f.names.some((n) => chosenFor(n) === c)),
  )

  return (
    <Modal open onClose={onClose} maxWidthClassName="max-w-[min(1060px,96vw)]">
      <div className="flex items-center justify-between gap-3 border-b border-border-subtle p-[16px_20px]">
        <div className="flex min-w-0 items-center gap-2.5">
          <IconButton icon="chevronLeft" onClick={onBack} />
          <div className="min-w-0">
            <h3 className="truncate text-md font-medium">Match your columns</h3>
            <div className="mt-0.5 truncate text-sm text-ink-muted">
              Your file keeps its own column names — this only tells us which one holds what
            </div>
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          {role && (
            <Pill tone={matchedRequired === requiredFields.length ? 'success' : 'danger'}>
              {matchedRequired} of {requiredFields.length} required matched
            </Pill>
          )}
          {toConfirm > 0 && <Pill tone="warning">{toConfirm} to confirm</Pill>}
          <IconButton icon="x" onClick={onClose} />
        </div>
      </div>

      <div className="flex max-h-[68vh] min-h-[380px]">
        {/* ---------------- the files ---------------- */}
        <div className="w-[244px] shrink-0 overflow-y-auto border-r border-border-subtle bg-surface-muted/40 p-2.5">
          <div className="mb-1.5 px-1.5 text-xs font-medium uppercase tracking-[0.04em] text-ink-muted">
            Your files
          </div>
          {files.map((f) => {
            const left = outstanding(f.name)
            const active = f.name === selected
            const found = byName[f.name]
            const label = found?.label ?? (roles[f.name] ? STAR_ROLE_LABELS[roles[f.name]!] : null)
            return (
              <button
                key={f.name}
                type="button"
                onClick={() => setSelected(f.name)}
                className={`mb-1 flex w-full items-start gap-2 rounded-[var(--r-md)] border p-[9px_10px] text-left transition-colors ${
                  active
                    ? 'border-brand-violet bg-surface-card shadow-[var(--shadow-sm)]'
                    : 'border-transparent hover:bg-surface-card'
                }`}
              >
                <Icon
                  name={left.length === 0 ? 'checkCircle' : 'alertTriangle'}
                  className={`mt-px h-4 w-4 shrink-0 ${
                    left.length === 0
                      ? 'text-[var(--pill-success-ink)]'
                      : 'text-[var(--pill-danger-ink)]'
                  }`}
                />
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-base font-medium">{f.name}</span>
                  <span className="mt-0.5 block truncate text-xs leading-[1.45] text-ink-muted">
                    {left.length === 0
                      ? label
                      : left[0] === 'role'
                        ? 'Not recognised — pick its table'
                        : `${left.length} column${left.length === 1 ? '' : 's'} to match`}
                  </span>
                </span>
              </button>
            )
          })}
        </div>

        {/* ---------------- the chosen file ---------------- */}
        <div className="min-w-0 flex-1 overflow-y-auto">
          {settling && !result && (
            <div className="flex items-center justify-center gap-2 py-16 text-sm text-ink-muted">
              <Spinner /> Reading your column names…
            </div>
          )}

          {inspect.isError && (
            <div className="m-5 rounded-[var(--r-md)] bg-status-danger-bg p-[10px_12px] text-sm leading-[1.55] text-[var(--pill-danger-ink)]">
              Couldn’t read these files — is the backend running?
            </div>
          )}

          {result && file && (
            <>
              {/* Which table, kept at the top because every row below depends
                  on the answer. */}
              <div className="flex flex-wrap items-end gap-3 border-b border-border-subtle p-[14px_20px]">
                <div className="min-w-[240px] flex-1">
                  <label className="mb-1 block text-sm font-medium text-ink-secondary">
                    This file is
                  </label>
                  <Select
                    value={role ?? ABSENT}
                    onChange={(e) =>
                      setRoles((prev) => ({
                        ...prev,
                        [selected]: (e.target.value || null) as StarRole | null,
                      }))
                    }
                  >
                    <option value={ABSENT}>Choose a table…</option>
                    {REQUIRED_ROLES.map((r) => (
                      <option key={r} value={r}>
                        {STAR_ROLE_LABELS[r]} — required
                      </option>
                    ))}
                    {DERIVABLE_ROLES.map((r) => (
                      <option key={r} value={r}>
                        {STAR_ROLE_LABELS[r]} — optional
                      </option>
                    ))}
                  </Select>
                </div>
                <div className="text-xs leading-[1.5] text-ink-muted">
                  {current?.matched_by && !roles[selected]
                    ? `Recognised by its ${current.matched_by}`
                    : roles[selected]
                      ? 'You chose this table'
                      : ''}
                  <br />
                  {available.length} column{available.length === 1 ? '' : 's'} in this file
                </div>
              </div>

              {!role && (
                <div className="m-5 rounded-[var(--r-md)] bg-surface-muted p-[12px_14px] text-sm leading-[1.55] text-ink-secondary">
                  Pick a table above, and its fields will be matched against this file’s{' '}
                  {available.length} column{available.length === 1 ? '' : 's'}.
                </div>
              )}

              {role && (
                <div className="p-[14px_20px]">
                  <Row header>
                    <span>We need</span>
                    <span>Your column</span>
                    <span>Example values</span>
                    <span>How it matched</span>
                  </Row>

                  {(['required', 'optional'] as const).map((band) => {
                    const rows = fields.filter((f) =>
                      band === 'required' ? f.required : !f.required,
                    )
                    if (!rows.length) return null
                    return (
                      <div key={band}>
                        <div className="mb-1 mt-3.5 text-xs font-medium uppercase tracking-[0.04em] text-ink-muted">
                          {band === 'required' ? 'Required' : 'Read when present'}
                        </div>
                        {rows.map(({ names, required }) => {
                          // An either-group is one row: whichever member has a
                          // column is the one that counts.
                          const canonical = names.find((n) => chosenFor(n)) ?? names[0]
                          const picked = chosenFor(canonical)
                          const mine = Boolean(columns[selected]?.[canonical])
                          const source = mine
                            ? 'chosen'
                            : (current?.mapping_sources?.[canonical] ?? '')
                          const badge = SOURCE_BADGE[source]
                          const values = samples[picked] ?? []
                          return (
                            <Row key={names.join('|')}>
                              <span className="min-w-0">
                                <span className="block truncate text-base">
                                  {names.join(' or ')}
                                </span>
                              </span>
                              <Select
                                value={picked}
                                onChange={(e) => choose(canonical, e.target.value)}
                                className="text-sm"
                              >
                                <option value={ABSENT}>
                                  {required ? '— none of my columns —' : '— not in this file —'}
                                </option>
                                {available.map((c) => (
                                  <option key={c} value={c}>
                                    {c}
                                  </option>
                                ))}
                              </Select>
                              <span
                                className="min-w-0 truncate font-mono text-xs text-ink-muted"
                                title={values.join(' · ')}
                              >
                                {values.length ? values.join('  ·  ') : picked ? '—' : ''}
                              </span>
                              <span>
                                {picked && badge ? (
                                  <Pill tone={badge.tone}>{badge.label}</Pill>
                                ) : picked ? (
                                  <Pill tone="neutral">Matched</Pill>
                                ) : required ? (
                                  <Pill tone="danger">Needs a column</Pill>
                                ) : (
                                  <span className="text-xs text-ink-muted">Not provided</span>
                                )}
                              </span>
                            </Row>
                          )
                        })}
                      </div>
                    )
                  })}

                  {/* Everything this file carries that we will not read. */}
                  {ignored.length > 0 && (
                    <div className="mt-4 rounded-[var(--r-md)] bg-surface-muted p-[10px_12px] text-xs leading-[1.6] text-ink-muted">
                      <strong className="font-medium text-ink-secondary">
                        {ignored.length} column{ignored.length === 1 ? '' : 's'} ignored
                      </strong>{' '}
                      — they stay in your file and are simply not read:{' '}
                      <span className="font-mono">{ignored.join(', ')}</span>
                    </div>
                  )}

                  {/* A collision: the file already had our name for a column
                      AND something else was mapped onto it. Said here rather
                      than discovered later as a wrong number. */}
                  {(current?.dropped_columns?.length ?? 0) > 0 && (
                    <div className="mt-3 rounded-[var(--r-md)] bg-status-danger-bg p-[10px_12px] text-xs leading-[1.55] text-[var(--pill-danger-ink)]">
                      This file already has a column called{' '}
                      <span className="font-mono">{current!.dropped_columns!.join(', ')}</span>, and
                      you’ve matched another column onto that name. Yours is kept and the original
                      is left out — two columns can’t share a name.
                    </div>
                  )}
                </div>
              )}
            </>
          )}
        </div>
      </div>

      <div className="flex items-center justify-between gap-2 border-t border-border-subtle p-[14px_22px]">
        <span className="text-xs text-ink-muted">
          {unresolved.length === 0
            ? `All ${files.length} file${files.length === 1 ? '' : 's'} matched`
            : unresolved.length === 1
              ? `1 file still needs a column`
              : `${unresolved.length} files still need a column`}
        </span>
        <div className="flex gap-2">
          <Button variant="ghost" onClick={onBack}>
            Cancel
          </Button>
          <Button variant="primary" onClick={() => onApply(effective)} disabled={settling}>
            <Icon name="check" /> {settling ? 'Reading your columns…' : 'Use these columns'}
          </Button>
        </div>
      </div>
    </Modal>
  )
}

/** One four-column row of the matching table, so the header and the rows can
 *  never drift apart. */
function Row({ children, header }: { children: React.ReactNode; header?: boolean }) {
  return (
    <div
      className={`grid grid-cols-[minmax(130px,1fr)_minmax(150px,1.15fr)_minmax(110px,1fr)_minmax(132px,auto)] items-center gap-3 ${
        header
          ? 'border-b border-border-subtle pb-1.5 text-xs font-medium uppercase tracking-[0.04em] text-ink-muted'
          : 'rounded-[var(--r-md)] px-1 py-1 hover:bg-surface-muted'
      }`}
    >
      {children}
    </div>
  )
}
