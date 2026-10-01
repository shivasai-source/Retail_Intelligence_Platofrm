import { useMemo, useState } from 'react'
import { Input, Pill } from '../ui'
import { Icon } from '../../icons'
import { ConnectorLogo } from '../portal/ConnectorLogo'
import type { CatalogEntry } from '../portal/catalog'

// THE DATA CONNECTIONS CATALOGUE — one implementation, many intelligence modules.
//
// Lifted out of pages/Connections.tsx unchanged, so TPO renders exactly the
// markup and classes it rendered before. The page kept the search box, the
// family filter, the category sections and the tile grid inline, which meant a
// second module (MMM) could only have them by copying 200 lines of Tailwind —
// and the two would then drift apart on the first restyle. Everything that is
// the same for every module lives here; everything a module decides for itself
// (its catalogue, its copy, what a tile opens) arrives as a prop.
//
// WHAT THIS COMPONENT WILL NOT DO is decide whether a tile is clickable. That
// is `entry.status`, straight from the module's own catalogue, for the reason
// catalog.ts gives: an honest "Soon" beats a tile that fails after you have
// typed credentials into it. A module with no ingestion behind it supplies a
// catalogue of `planned` entries and gets a complete, inert landscape.

type FamilyFilter = 'all' | 'object' | 'tabular'

const FILTERS: Array<{ value: FamilyFilter; label: string }> = [
  { value: 'all', label: 'All sources' },
  { value: 'object', label: 'Files & objects' },
  { value: 'tabular', label: 'Tables & rows' },
]

const FAMILY_LABEL: Record<CatalogEntry['family'], string> = {
  object: 'Files & objects',
  tabular: 'Tables & rows',
}

export function ConnectionsCatalog({
  catalog,
  categoryOrder,
  connectedIds,
  onOpenTile,
}: {
  catalog: readonly CatalogEntry[]
  categoryOrder: readonly string[]
  /** Tiles to mark as connected. Empty for a module with no ingestion. */
  connectedIds: ReadonlySet<string>
  /** Raised only for an `available` entry — the tile is inert otherwise. */
  onOpenTile: (entry: CatalogEntry) => void
}) {
  const [query, setQuery] = useState('')
  const [family, setFamily] = useState<FamilyFilter>('all')

  const visible = useMemo(() => {
    const q = query.trim().toLowerCase()
    return catalog.filter((c) => {
      if (family !== 'all' && c.family !== family) return false
      if (!q) return true
      return (
        c.label.toLowerCase().includes(q) ||
        c.description.toLowerCase().includes(q) ||
        c.category.toLowerCase().includes(q)
      )
    })
  }, [catalog, query, family])

  const grouped = useMemo(
    () =>
      categoryOrder
        .map((category) => ({ category, items: visible.filter((c) => c.category === category) }))
        .filter((g) => g.items.length > 0),
    [categoryOrder, visible],
  )

  return (
    <>
      <div className="mb-5 flex flex-col gap-3 sm:flex-row sm:items-center">
        <div className="relative sm:max-w-xs sm:flex-1">
          <Icon
            name="search"
            className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-ink-disabled"
          />
          <Input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search connectors…"
            className="pl-9"
            aria-label="Search connectors"
          />
        </div>

        <div className="flex items-center gap-1 rounded-[var(--r-lg)] border border-border-subtle bg-surface-card p-1">
          {FILTERS.map((f) => (
            <button
              key={f.value}
              type="button"
              onClick={() => setFamily(f.value)}
              aria-pressed={family === f.value}
              className={`rounded-[var(--r-md)] px-3 py-1 text-sm font-semibold transition-colors duration-150 ${
                family === f.value
                  ? 'bg-brand-violet text-white'
                  : 'text-ink-secondary hover:bg-surface-muted hover:text-ink-primary'
              }`}
            >
              {f.label}
            </button>
          ))}
        </div>
      </div>

      {grouped.length === 0 ? (
        <p className="rounded-[var(--r-xl)] border border-border-subtle bg-surface-card py-12 text-center text-base text-ink-muted">
          No connectors match “{query}”.
        </p>
      ) : (
        <div className="flex flex-col gap-7">
          {grouped.map(({ category, items }) => (
            <section key={category}>
              <div className="mb-3 flex items-center gap-2">
                <h3 className="text-xs font-bold uppercase tracking-wide text-ink-muted">{category}</h3>
                <span className="text-sm text-ink-muted">{items.length}</span>
              </div>

              <div className="grid grid-cols-4 gap-4 @max-[1240px]:grid-cols-3 @max-[900px]:grid-cols-2 @max-[620px]:grid-cols-1">
                {items.map((entry) => (
                  <ConnectorTile
                    key={entry.id}
                    entry={entry}
                    connected={connectedIds.has(entry.id)}
                    onSelect={() => onOpenTile(entry)}
                  />
                ))}
              </div>
            </section>
          ))}
        </div>
      )}
    </>
  )
}

function ConnectorTile({
  entry,
  connected,
  onSelect,
}: {
  entry: CatalogEntry
  connected: boolean
  onSelect: () => void
}) {
  const available = entry.status === 'available'

  return (
    <button
      type="button"
      onClick={onSelect}
      disabled={!available}
      title={
        available
          ? connected
            ? `Reconnect or browse ${entry.label}`
            : `Connect ${entry.label}`
          : `${entry.label} is in the catalog but not wired up yet`
      }
      className={[
        'flex h-full flex-col gap-3 rounded-[var(--r-xl)] border bg-surface-card p-4 text-left shadow-[var(--shadow-sm)]',
        'transition-[box-shadow,border-color,transform] duration-150',
        available
          ? 'cursor-pointer hover:-translate-y-px hover:shadow-[var(--shadow-md)] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--brand-violet)]'
          : 'cursor-not-allowed opacity-55',
        connected ? 'border-[#A7D8C4]' : 'border-border-subtle',
        available && !connected ? 'hover:border-brand-violet' : '',
      ].join(' ')}
    >
      <div className="flex items-start gap-3">
        <ConnectorLogo connectorId={entry.id} label={entry.label} mark={entry.mark} />
        <div className="min-w-0 flex-1">
          <div className="truncate text-base font-bold text-ink-primary">{entry.label}</div>
          <div className="mt-0.5 text-sm text-ink-muted">{FAMILY_LABEL[entry.family]}</div>
        </div>
        {!available ? (
          <Pill tone="neutral">Soon</Pill>
        ) : connected ? (
          <Pill tone="success" dot>
            Connected
          </Pill>
        ) : null}
      </div>

      <p className="line-clamp-3 text-sm leading-[1.55] text-ink-secondary">{entry.description}</p>

      {available && (
        <span className="mt-auto flex items-center gap-1.5 pt-1 text-sm font-bold text-brand-violet [&_svg]:h-3.5 [&_svg]:w-3.5">
          <Icon name={entry.special ? 'database' : 'plus'} />
          {connected ? 'Browse / reconnect' : entry.special ? 'Connect account' : 'Upload files'}
        </span>
      )}
    </button>
  )
}
