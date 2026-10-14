import { Fragment, useMemo, useState } from 'react'
import { InfoPopover } from '../ui'
import { Icon } from '../../icons'
import { offerColor } from './shared'
import type { ChangeAction, ChangeOffer, ChangeRow, PlannedOffer } from '../../types/planner'

/** Which promotions change, product-store by product-store.
 *
 *  Each row lists its changes as short actions -- "W05 → W06 · 10% → 15%" --
 *  and what it earns. Open a row for its timeline: the period left to right,
 *  the current plan's promotions on the top lane and the optimized plan's
 *  below, coloured as the Promotion Calendar colours them. */

const PAGE = 12

const KIND: Record<ChangeAction['kind'], { icon: 'arrowRight' | 'pricing' | 'x' | 'plus'; tone: string }> = {
  moved: { icon: 'arrowRight', tone: 'bg-brand-violet/10 text-brand-violet' },
  repriced: { icon: 'pricing', tone: 'bg-status-info/10 text-status-info' },
  dropped: { icon: 'x', tone: 'bg-status-danger/10 text-status-danger' },
  added: { icon: 'plus', tone: 'bg-status-success/10 text-status-success' },
}

const shortPeriod = (label: string) => label.split(' · ')[0]
const depth = (o?: ChangeOffer) => (o ? (o.type === 'Seasonal' ? o.name.replace(/\s+\d{2}$/, '') : `${o.depth_pct}%`) : '')

function ActionChip({ a }: { a: ChangeAction }) {
  const k = KIND[a.kind]
  const what =
    a.kind === 'moved'
      ? `${shortPeriod(a.period)} → ${shortPeriod(a.to_period ?? '')} · ${a.from_offer?.id !== a.to_offer?.id ? `${depth(a.from_offer)} → ${depth(a.to_offer)}` : depth(a.to_offer)}`
      : a.kind === 'repriced'
        ? `${shortPeriod(a.period)} · ${depth(a.from_offer)} → ${depth(a.to_offer)}`
        : `${shortPeriod(a.period)} · ${depth(a.from_offer ?? a.to_offer)}`
  const title =
    a.kind === 'moved'
      ? `${a.from_offer?.name} in ${a.period} moves to ${a.to_period} as ${a.to_offer?.name}`
      : a.kind === 'repriced'
        ? `${a.period}: ${a.from_offer?.name} becomes ${a.to_offer?.name}`
        : a.kind === 'dropped'
          ? `${a.period}: ${a.from_offer?.name} is not run`
          : `${a.period}: ${a.to_offer?.name} is added`
  return (
    <span title={title} className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-base font-medium [font-variant-numeric:tabular-nums] [&_svg]:h-3 [&_svg]:w-3 ${k.tone}`}>
      <Icon name={k.icon} />
      {what}
    </span>
  )
}

export function ChangesTable({ rows, truncated, total }: { rows: ChangeRow[]; truncated: number; total: number }) {
  const [query, setQuery] = useState('')
  const [open, setOpen] = useState<string | null>(null)
  const [page, setPage] = useState(0)
  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase()
    if (!q) return rows
    return rows.filter((r) => [r.product, r.product_id, r.store, r.store_id, r.channel, r.region, r.brand].some((v) => v.toLowerCase().includes(q)))
  }, [rows, query])
  const pages = Math.max(1, Math.ceil(filtered.length / PAGE))
  const shown = filtered.slice(page * PAGE, page * PAGE + PAGE)

  if (!rows.length) {
    return (
      <div className="flex items-center justify-center gap-2 rounded-[var(--r-md)] bg-ink-primary/[0.03] px-4 py-6 text-base text-ink-muted [&_svg]:h-4 [&_svg]:w-4">
        <Icon name="checkCircle" className="text-status-success" /> The current plan is already the best under these rules
      </div>
    )
  }

  return (
    <div>
      <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
        <label className="flex h-10 min-w-[260px] items-center gap-2 rounded-[var(--r-md)] border border-border-default bg-surface-card px-3 text-base focus-within:border-brand-violet [&_svg]:h-4 [&_svg]:w-4">
          <Icon name="search" className="text-ink-muted" />
          <input
            style={{ outline: 'none' }}
            value={query}
            onChange={(e) => {
              setQuery(e.target.value)
              setPage(0)
            }}
            placeholder="Search product, store, channel, region"
            className="w-full bg-transparent text-ink-primary outline-none placeholder:text-ink-muted focus:outline-none focus-visible:outline-none"
          />
        </label>
        <span className="flex items-center gap-1.5 text-base text-ink-muted">
          {filtered.length.toLocaleString()} of {total.toLocaleString()}
          {truncated > 0 && ` · top ${rows.length} listed`}
          <InfoPopover label="How changes work" title="How changes work" width={300}>
            <div className="mt-1.5 space-y-1.5 text-base leading-snug text-ink-secondary">
              <p>
                <b>Move</b> takes a promotion to another week. A product-store runs one offer a week, so a move never lands on
                one of its own promotions — its whole calendar is re-planned together.
              </p>
              <p>Other product-stores' promotions in that week are not touched.</p>
            </div>
          </InfoPopover>
        </span>
      </div>

      <div className="overflow-x-auto rounded-[var(--r-md)] border border-border-subtle">
        <table className="w-full min-w-[820px] text-base [font-variant-numeric:tabular-nums]">
          <thead className="bg-surface-muted">
            <tr className="text-left text-base font-medium text-ink-muted">
              <th className="px-3 py-2 font-medium">Product</th>
              <th className="px-3 py-2 font-medium">Store</th>
              <th className="px-3 py-2 font-medium">Changes</th>
              <th className="px-3 py-2 text-right font-medium">Profit gain</th>
              <th className="w-8 px-2 py-2" aria-label="Open" />
            </tr>
          </thead>
          <tbody>
            {shown.map((r) => {
              const key = `${r.product_id}|${r.store_id}`
              const isOpen = open === key
              return (
                <Fragment key={key}>
                  <tr
                    className={`cursor-pointer border-t border-border-subtle align-top transition-colors hover:bg-surface-hover ${isOpen ? 'bg-brand-violet/[0.04]' : ''}`}
                    onClick={() => setOpen(isOpen ? null : key)}
                  >
                    <td className="px-3 py-2.5">
                      <div className="font-medium text-ink-primary">{r.product}</div>
                      <div className="text-base text-ink-muted">{r.brand}</div>
                    </td>
                    <td className="px-3 py-2.5">
                      <div className="font-medium text-ink-primary">{r.store}</div>
                      <div className="text-base text-ink-muted">
                        {r.channel} · {r.region}
                      </div>
                    </td>
                    <td className="px-3 py-2.5">
                      <div className="flex max-w-[440px] flex-wrap gap-1">
                        {r.actions.slice(0, 4).map((a) => (
                          <ActionChip key={`${a.kind}-${a.index}`} a={a} />
                        ))}
                        {r.actions.length > 4 && (
                          <span className="rounded-full bg-ink-primary/[0.05] px-2 py-0.5 text-base font-medium text-ink-secondary">+{r.actions.length - 4}</span>
                        )}
                      </div>
                    </td>
                    <td className="px-3 py-2.5 text-right text-base font-medium text-status-success [font-variant-numeric:tabular-nums]">+{r.gain.display}</td>
                    <td className="px-2 py-2.5 text-ink-muted [&_svg]:h-4 [&_svg]:w-4">
                      <Icon name={isOpen ? 'chevronDown' : 'chevronRight'} />
                    </td>
                  </tr>
                  {isOpen && (
                    <tr className="border-t border-border-subtle bg-brand-violet/[0.02]">
                      <td colSpan={5} className="px-4 py-4">
                        <Timeline row={r} />
                        {r.actions.length > 4 && (
                          <div className="mt-3 flex flex-wrap gap-1">
                            {r.actions.map((a) => (
                              <ActionChip key={`all-${a.kind}-${a.index}`} a={a} />
                            ))}
                          </div>
                        )}
                      </td>
                    </tr>
                  )}
                </Fragment>
              )
            })}
          </tbody>
        </table>
      </div>

      {pages > 1 && (
        <div className="mt-3 flex items-center justify-end gap-2 text-base text-ink-secondary">
          <button
            type="button"
            className="grid h-9 w-9 cursor-pointer place-items-center rounded-[var(--r-md)] border border-border-subtle hover:bg-surface-hover disabled:cursor-not-allowed disabled:opacity-40 [&_svg]:h-4 [&_svg]:w-4"
            disabled={page === 0}
            onClick={() => setPage(page - 1)}
            aria-label="Previous page"
          >
            <Icon name="chevronLeft" />
          </button>
          <span className="tabular-nums">
            {page + 1} / {pages}
          </span>
          <button
            type="button"
            className="grid h-9 w-9 cursor-pointer place-items-center rounded-[var(--r-md)] border border-border-subtle hover:bg-surface-hover disabled:cursor-not-allowed disabled:opacity-40 [&_svg]:h-4 [&_svg]:w-4"
            disabled={page >= pages - 1}
            onClick={() => setPage(page + 1)}
            aria-label="Next page"
          >
            <Icon name="chevronRight" />
          </button>
        </div>
      )}
    </div>
  )
}

/** Summary counts, for the answer cards. */
export function SummaryChips({ summary }: { summary: ChangeRow['summary'] }) {
  const parts: [keyof ChangeRow['summary'], ChangeAction['kind'], string][] = [
    ['moved', 'moved', 'moved'],
    ['repriced', 'repriced', 're-priced'],
    ['dropped', 'dropped', 'dropped'],
    ['added', 'added', 'added'],
  ]
  return (
    <span className="flex flex-wrap gap-1">
      {parts
        .filter(([k]) => summary[k] > 0)
        .map(([k, kind, word]) => (
          <span key={k} className={`rounded-full px-2 py-0.5 text-base font-medium ${KIND[kind].tone}`}>
            {summary[k].toLocaleString()} {word}
          </span>
        ))}
    </span>
  )
}

function Timeline({ row }: { row: ChangeRow }) {
  const n = row.periods
  const lanes: { label: string; offers: PlannedOffer[] }[] = [
    { label: 'Current plan', offers: row.current },
    { label: 'Optimized', offers: row.best },
  ]
  return (
    <div>
      <div className="space-y-2">
        {lanes.map((lane) => {
          const at = new Map(lane.offers.map((o) => [o.index, o]))
          return (
            <div key={lane.label} className="flex items-center gap-3">
              <span className={`w-24 shrink-0 text-base font-medium ${lane.label === 'Optimized' ? 'text-brand-violet' : 'text-ink-secondary'}`}>{lane.label}</span>
              <div className="flex h-7 min-w-0 flex-1 overflow-hidden rounded-[var(--r-sm)] bg-ink-primary/[0.04]">
                {Array.from({ length: n }, (_, i) => {
                  const o = at.get(i)
                  const c = o ? offerColor(o) : null
                  return (
                    <div
                      key={i}
                      title={o ? `${o.period} · ${o.name} · ${o.depth_pct}%` : undefined}
                      className="h-full flex-1 border-r border-surface-card last:border-r-0"
                      style={c ? { background: c.bg, boxShadow: `inset 0 0 0 1px ${c.border}` } : undefined}
                    />
                  )
                })}
              </div>
            </div>
          )
        })}
      </div>
      <div className="mt-1 flex justify-between pl-[108px] text-base text-ink-muted">
        <span>{row.first_period}</span>
        <span>{row.last_period}</span>
      </div>
    </div>
  )
}
