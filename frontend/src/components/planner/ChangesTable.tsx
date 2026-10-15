import { Fragment, useMemo, useState } from 'react'
import { InfoPopover } from '../ui'
import { Icon } from '../../icons'
import type { ChangeAction, ChangeRow, PlannedOffer } from '../../types/planner'

/** Which promotions change, product-store by product-store.
 *
 *  Each row lists its changes as short actions -- "W05 → W06 · 10% → 15%" --
 *  and what it earns. Open a row for its timeline: the period left to right,
 *  the current plan's promotions on the top lane and the optimized plan's
 *  below, each marker coloured by WHAT HAPPENED to it and labelled with its
 *  own week, with a dashed connector drawn from a promotion to the week it
 *  moves to. See `MarkerState` for why colouring by the offer was the wrong
 *  encoding. */

const PAGE = 12

const KIND: Record<ChangeAction['kind'], { icon: 'arrowRight' | 'pricing' | 'x' | 'plus'; tone: string }> = {
  moved: { icon: 'arrowRight', tone: 'bg-brand-violet/10 text-brand-violet' },
  repriced: { icon: 'pricing', tone: 'bg-status-info/10 text-status-info' },
  dropped: { icon: 'x', tone: 'bg-status-danger/10 text-status-danger' },
  added: { icon: 'plus', tone: 'bg-status-success/10 text-status-success' },
}

const shortPeriod = (label: string) => label.split(' · ')[0]
/** What an offer is called in one or two words: "Buy3Get1" for a festival
 *  mechanic, "15%" for a plain discount. A seasonal offer's depth is not the
 *  whole story -- one free in four is not "25% off" to a reader -- so the
 *  mechanic's own name stands in. Shared by the action chips and the timeline,
 *  so the two never disagree about what an offer is called. */
const depth = (o?: { type: string; name: string; depth_pct: number }) =>
  o ? (o.type === 'Seasonal' ? o.name.replace(/\s+\d{2}$/, '') : `${o.depth_pct}%`) : ''

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
        <label className="flex h-10 w-full max-w-[340px] items-center gap-2 rounded-[var(--r-md)] border border-border-default bg-surface-card px-3 text-base focus-within:border-brand-violet [&_svg]:h-4 [&_svg]:w-4">
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

/** What happened to one promotion, which is what the timeline colours by.
 *
 *  The old chart coloured each block by its OFFER, so a row whose current plan
 *  ran Buy3Get1 and whose optimized plan runs 15% showed a navy lane above a
 *  green one -- and every reader concluded navy meant "current" and green meant
 *  "new". It did not. Colouring by what CHANGED instead matches the action
 *  chips directly above the chart, so the two read as one explanation. */
type MarkerState = 'moved' | 'repriced' | 'dropped' | 'added' | 'kept'

const MARKER: Record<MarkerState, { dot: string; ring: string; ink: string; word: string }> = {
  moved: { dot: 'bg-brand-violet', ring: 'border-brand-violet', ink: 'text-brand-violet', word: 'moved' },
  repriced: { dot: 'bg-status-info', ring: 'border-status-info', ink: 'text-status-info', word: 're-priced' },
  dropped: { dot: 'bg-status-danger', ring: 'border-status-danger', ink: 'text-status-danger', word: 'dropped' },
  added: { dot: 'bg-status-success', ring: 'border-status-success', ink: 'text-status-success', word: 'added' },
  kept: { dot: 'bg-ink-muted', ring: 'border-ink-muted', ink: 'text-ink-muted', word: 'unchanged' },
}

/** "W01 2026 · 01 Jan" -> "W01". The year is the same across a row's span and
 *  the date is in the tooltip, so the tick only has to say which week. */
const tick = (period: string) => period.split(' · ')[0].split(' ')[0]

interface Marker {
  offer: PlannedOffer
  state: MarkerState
  /** Where the midpoint of this period sits, 0-100 across the span. */
  x: number
  /** For a move, the week at the OTHER end -- so hovering either marker says
   *  where it goes or where it came from, and whether that is earlier or
   *  later. The connector shows the direction; this names it. */
  note?: string
}

function Timeline({ row }: { row: ChangeRow }) {
  const n = Math.max(1, row.periods)
  const at = (i: number) => ((i + 0.5) / n) * 100

  // Which action each promotion belongs to. A move is one action with two
  // ends: `index` in the current plan, `to_index` in the optimized one.
  const currentState = new Map<number, MarkerState>()
  const bestState = new Map<number, MarkerState>()
  const moves: { from: number; to: number }[] = []
  for (const a of row.actions) {
    if (a.kind === 'moved') {
      currentState.set(a.index, 'moved')
      if (a.to_index != null) {
        bestState.set(a.to_index, 'moved')
        moves.push({ from: a.index, to: a.to_index })
      }
    } else if (a.kind === 'repriced') {
      currentState.set(a.index, 'repriced')
      bestState.set(a.index, 'repriced')
    } else if (a.kind === 'dropped') {
      currentState.set(a.index, 'dropped')
    } else {
      bestState.set(a.index, 'added')
    }
  }

  const movedTo = new Map<number, number>(moves.map((m) => [m.from, m.to]))
  const movedFrom = new Map<number, number>(moves.map((m) => [m.to, m.from]))
  const shift = (from: number, to: number) => {
    const n = Math.abs(to - from)
    return `${n} ${n === 1 ? 'week' : 'weeks'} ${to > from ? 'later' : 'earlier'}`
  }
  const periodAt = new Map<number, string>(
    [...row.current, ...row.best].map((o) => [o.index, tick(o.period)]),
  )

  const mark = (offers: PlannedOffer[], states: Map<number, MarkerState>, ends: Map<number, number>, verb: string): Marker[] =>
    offers.map((offer) => {
      const other = ends.get(offer.index)
      return {
        offer,
        state: states.get(offer.index) ?? 'kept',
        x: at(offer.index),
        note:
          other == null
            ? undefined
            : `${verb} ${periodAt.get(other) ?? ''} — ${shift(offer.index, other)}`,
      }
    })

  const currentMarkers = mark(row.current, currentState, movedTo, 'moves to')
  const bestMarkers = mark(row.best, bestState, movedFrom, 'moved from')
  const legend = [...new Set([...currentMarkers, ...bestMarkers].map((m) => m.state))]

  const n_now = row.current.length
  const subject = n_now === 1 ? 'promotion' : `${n_now} promotions`
  // A move usually re-prices too, so the caption has to promise both or the
  // offer line under each marker reads as noise.
  const reprices = row.actions.some((a) => a.to_offer && a.from_offer && a.to_offer.id !== a.from_offer.id)
  const caption = `${subject[0].toUpperCase()}${subject.slice(1)}, as ${n_now === 1 ? 'it runs' : 'they run'} today and as the re-plan would run ${
    n_now === 1 ? 'it' : 'them'
  }${reprices ? ', with the offer under each' : ''}.`

  return (
    <div>
      {/* The chart answers a question nobody asked it out loud. Saying what it
          shows, in one sentence, does more for a reader than any amount of
          visual tuning -- without it the lanes, squares and dotted lines have
          to be decoded before they can be read. */}
      <p className="mb-3 text-base text-ink-secondary">{caption}</p>

      {/* The padding is the room the two-line labels need: the upper lane's
          hang above its track, the lower lane's below. It sits OUTSIDE the
          positioned box so the connector overlay still measures the lanes
          themselves -- pad the inner box and the lines detach from the
          markers. */}
      <div className="pt-10 pb-10">
      <div className="relative">
        {/* The connectors sit behind the markers and span both lanes, so they
            are one overlay rather than per-lane decoration. Straight lines,
            not curves -- the chart says where a promotion went, and a curve
            would only add ink. `non-scaling-stroke` keeps them 1px while the
            x axis stretches to the container. */}
        <svg
          className="pointer-events-none absolute inset-0 h-full w-full"
          viewBox="0 0 100 100"
          preserveAspectRatio="none"
          aria-hidden="true"
          style={{ left: LANE_LABEL_PX, width: `calc(100% - ${LANE_LABEL_PX}px)` }}
        >
          {moves.map((m) => (
            <line
              key={`${m.from}-${m.to}`}
              x1={at(m.from)}
              y1={26}
              x2={at(m.to)}
              y2={74}
              stroke="var(--brand-violet)"
              strokeWidth={1}
              strokeDasharray="4 3"
              vectorEffect="non-scaling-stroke"
              opacity={0.9}
            />
          ))}
        </svg>

        <Lane label="Today" markers={currentMarkers} above hollow />
        <div className="h-5" />
        <Lane label="Proposed" markers={bestMarkers} accent />
      </div>
      </div>

      {/* The period, anchored at both ends. One combined label on the right
          said how long the span was but not which way it ran. */}
      <div className="mt-1 flex items-center justify-between border-t border-border-subtle pt-1.5" style={{ marginLeft: LANE_LABEL_PX }}>
        <span className="text-base text-ink-muted">{row.first_period}</span>
        <span className="text-base text-ink-muted">{row.last_period}</span>
      </div>

      <div className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-2" style={{ paddingLeft: LANE_LABEL_PX }}>
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
          {/* Shape first, because it is what separates the two lanes; colour
              second, because it is what separates the kinds of change. */}
          <span className="inline-flex items-center gap-1.5 text-base text-ink-muted">
            <span className="h-2.5 w-2.5 rounded-[2px] border-2 border-ink-muted bg-surface-card" />
            runs today
          </span>
          <span className="inline-flex items-center gap-1.5 text-base text-ink-muted">
            <span className="h-2.5 w-2.5 rounded-[2px] bg-ink-muted" />
            after the re-plan
          </span>
          <span className="text-border-strong">|</span>
          {legend.map((s) => (
            <span key={s} className="inline-flex items-center gap-1.5 text-base text-ink-muted">
              <span className={`h-2.5 w-2.5 rounded-[2px] ${MARKER[s].dot}`} />
              {MARKER[s].word}
            </span>
          ))}
        </div>
      </div>

    </div>
  )
}

/** Width of the lane name, so the track, the connectors and the footer all
 *  start at the same x. */
const LANE_LABEL_PX = 108

function Lane({
  label,
  markers,
  accent,
  above,
  hollow,
}: {
  label: string
  markers: Marker[]
  accent?: boolean
  above?: boolean
  /** The "before" lane. Its markers are outlined rather than filled, so which
   *  lane is today's and which is the proposal reads without the labels --
   *  two identical rows of squares made the reader work that out every time. */
  hollow?: boolean
}) {
  return (
    <div className="flex items-center gap-3">
      <span className={`shrink-0 text-base font-medium ${accent ? 'text-brand-violet' : 'text-ink-secondary'}`} style={{ width: LANE_LABEL_PX - 12 }}>
        {label}
      </span>
      {/* The track is the period, left to right. An empty track is a plan that
          runs nothing at all, which is a real answer and says so. */}
      <div className="relative h-9 min-w-0 flex-1 rounded-[var(--r-sm)] bg-ink-primary/[0.04]">
        {markers.length === 0 && (
          <span className="absolute inset-0 grid place-items-center text-base text-ink-muted">No promotions</span>
        )}
        {markers.map((m) => (
          <span
            key={m.offer.index}
            title={`${m.offer.period} · ${m.offer.name} · ${m.offer.depth_pct}%${m.note ? ` — ${m.note}` : ` — ${MARKER[m.state].word}`}`}
            className="absolute top-1/2 flex -translate-x-1/2 -translate-y-1/2 flex-col items-center"
            style={{ left: `${m.x}%` }}
          >
            <span
              className={`h-4 w-4 rounded-[3px] ${hollow ? `border-2 bg-surface-card ${MARKER[m.state].ring}` : MARKER[m.state].dot}`}
            />
            {/* Week AND offer. A move usually re-prices as it re-schedules --
                "W33 Buy3Get1" becomes "W18 15%" -- and showing only the week
                hid half of what changed. */}
            <span
              className={`absolute flex flex-col items-center whitespace-nowrap ${
                above ? 'bottom-full mb-1' : 'top-full mt-1'
              }`}
            >
              <span className={`text-sm font-medium [font-variant-numeric:tabular-nums] ${MARKER[m.state].ink}`}>
                {tick(m.offer.period)}
              </span>
              <span className="text-sm text-ink-muted">{depth(m.offer)}</span>
            </span>
          </span>
        ))}
      </div>
    </div>
  )
}
