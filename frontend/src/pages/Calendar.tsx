import { useEffect, useMemo, useState } from 'react'
import { AppShell } from '../components/layout/AppShell'
import { Button, Card, CardBody, CardHeader, Dropdown, InfoPopover } from '../components/ui'
import { Icon } from '../icons'
import { LEGEND, LegendSwatch, PromotionMatrix } from '../components/calendar/PromotionMatrix'
import { PromotionDetailPanel } from '../components/calendar/PromotionDetailPanel'
import { UpcomingEventsPanel } from '../components/calendar/UpcomingEventsPanel'
import { usePromotionCell, usePromotionMatrix, useUpcoming } from '../hooks/usePromotionCalendar'

/** Monthly Promotion Calendar.
 *
 *      YEAR -> 12 MONTHS -> N CHANNELS -> PROMOTION -> PROMOTED PRODUCTS
 *
 *  A trade-promotion plan, not a diary: the primary view is a Channel x Month
 *  matrix for one year, never a grid of days. The year is the top-level
 *  control, so the question "which plan am I looking at?" is answered before
 *  anything else on the page.
 *
 *  All promotion metadata comes from `/api/promotion-calendar`, which resolves
 *  it from dim_promotion_final.csv. This page holds no promotion names, ids,
 *  product lists or counts of its own. */

const ALL_CHANNELS = 'All Channels'

export function Calendar() {
  // Opens on the LATEST year the data carries, adopted from the matrix payload
  // once it reports which years exist -- the same rule the Insights Hub
  // initialises its period by. The literal below is only the first request's
  // year; the data decides where the page lands, and a year the user has
  // clicked is never overridden.
  const [year, setYear] = useState(2025)
  const [yearChosen, setYearChosen] = useState(false)
  const [channel, setChannel] = useState<string | null>(null)
  const [selected, setSelected] = useState<{ month: number; channel: string } | null>(null)
  // Owned here, not in the panel: expanding Upcoming re-weights it against the
  // Promotion Details panel sharing the same column.
  const [upcomingExpanded, setUpcomingExpanded] = useState(false)

  const channels = useMemo(() => (channel ? [channel] : []), [channel])
  const matrix = usePromotionMatrix(year, channels)
  const availableYears = matrix.data?.years
  useEffect(() => {
    if (yearChosen || !availableYears?.length) return
    const latest = Math.max(...availableYears)
    if (latest !== year) setYear(latest)
  }, [availableYears, yearChosen, year])
  const detail = usePromotionCell(selected ? { ...selected, year } : null)
  // The feed is relative to the month being viewed: nothing selected means the
  // whole year is still ahead, so `after_month` is 0.
  const upcoming = useUpcoming(year, selected?.month ?? 0, channels)

  const crumbs = [{ label: 'TPO Intelligence' }, { label: 'Calendar' }, { label: 'Promotion Calendar' }]

  // Channel options come from the matrix payload, so the dropdown can never
  // offer a channel the calendar does not carry.
  const channelOptions = useMemo(() => {
    // The full roster, never the filtered rows — otherwise picking CH001
    // leaves CH002-CH005 unreachable without clearing the filter first.
    const rows = matrix.data?.all_channels ?? []
    return [{ label: ALL_CHANNELS }, ...rows.map((c) => ({ label: `${c.channel_id} — ${c.name}` }))]
  }, [matrix.data])

  const channelLabel = channel
    ? (channelOptions.find((o) => o.label.startsWith(channel))?.label ?? channel)
    : ALL_CHANNELS

  // Named from the payload's cadence, not written down here. The sentence used
  // to read "Weekly channels (CH001, CH004)", which was already wrong the day a
  // third weekly channel arrived and told the user the opposite of what the
  // grid was showing them.
  const weeklyNames = useMemo(
    () => (matrix.data?.all_channels ?? []).filter((c) => c.cadence === 'WEEKLY').map((c) => c.name),
    [matrix.data],
  )

  const years = matrix.data?.years ?? [year]

  const monthName = selected ? (matrix.data?.months[selected.month - 1]?.name ?? '') : null
  const channelScope = channel
    ? `${channel} · ${matrix.data?.all_channels.find((c) => c.channel_id === channel)?.name ?? ''}`
    : 'All channels'
  const upcomingContext = monthName
    ? `After ${monthName} ${year} · ${channelScope}`
    : `${year} · ${channelScope}`

  return (
    <AppShell activeKey="calendar" crumbs={crumbs}>
      <div className="fade-in mb-5 flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1>Monthly Promotion Calendar</h1>
          <p className="mt-1.5 text-base text-ink-muted">
            View monthly promotional activities, events and promoted products across channels
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Dropdown
            selected={channelLabel}
            options={channelOptions}
            onSelect={(picked) => {
              setChannel(picked === ALL_CHANNELS ? null : picked.slice(0, 5))
              setSelected(null)
            }}
            trigger={
              <Button variant="secondary" className="cursor-pointer">
                <Icon name="filter" />
                <span>{channelLabel}</span>
                <Icon name="chevronDown" />
              </Button>
            }
          />
        </div>
      </div>

      {/* The matrix sets the row height; the right column stretches to it and
          absorbs any overflow with internal scrolling, so the page never grows
          taller than the calendar itself. Below 1180px the two stack and each
          panel falls back to its own height. */}
      <div className="grid gap-4 @min-[1180px]:grid-cols-[minmax(0,1fr)_336px] @min-[1180px]:items-stretch">
        <Card className="fade-in flex min-w-0 flex-col">
          <CardHeader
            title={
              <span className="flex items-center gap-1.5">
                {year} Promotion Plan
                <InfoPopover label="About the promotion calendar" title="What this shows">
                  <p className="mt-1.5 text-xs leading-snug text-ink-secondary">
                    Every promotion running in each channel, by month. The month comes from the
                    promotion's business week via the date dimension, not from a transaction date.
                    Weekly channels summarise several promotions per cell — open one to see the weeks.
                  </p>
                </InfoPopover>
              </span>
            }
            actions={
              // 26px tall gave 24px segments, right on the WCAG 2.5.8 floor for
              // a pointer target and visibly shorter than every other control
              // in a card header. 30px clears it and lines the group up with
              // the header's other actions; the type and padding are unchanged.
              <div
                className="inline-flex h-[30px] items-stretch overflow-hidden rounded-[var(--r-md)] border border-border-subtle"
                role="radiogroup"
                aria-label="Calendar year"
              >
                {years.map((y) => (
                  <button
                    key={y}
                    type="button"
                    role="radio"
                    aria-checked={y === year}
                    onClick={() => {
                      setYear(y)
                      setYearChosen(true)
                      setSelected(null)
                    }}
                    className={`cursor-pointer px-3 text-sm font-bold tabular-nums transition-colors focus:outline-none focus-visible:ring-1 focus-visible:ring-brand-violet ${
                      y === year
                        ? 'bg-brand-violet text-white'
                        : 'text-ink-secondary hover:bg-brand-violet/[0.08] hover:text-brand-violet'
                    }`}
                  >
                    {y}
                  </button>
                ))}
              </div>
            }
          />

          <div className="flex flex-wrap items-center gap-x-4 gap-y-1.5 border-b border-border-subtle px-5 py-2.5">
            {LEGEND.map((entry) => (
              <span key={entry.kind} className="inline-flex items-center gap-1.5 text-xs text-ink-secondary">
                <LegendSwatch kind={entry.kind} />
                {entry.label}
              </span>
            ))}
          </div>

          <CardBody className="!p-2">
            {matrix.isLoading && !matrix.data ? (
              <div className="grid min-h-[320px] place-items-center text-base text-ink-muted">
                Loading promotion plan…
              </div>
            ) : matrix.error ? (
              <div className="grid min-h-[320px] place-items-center gap-2 text-center text-base text-ink-muted">
                <span>Could not load the promotion calendar.</span>
                <Button variant="secondary" onClick={() => void matrix.refetch()}>
                  <Icon name="refresh" /> Retry
                </Button>
              </div>
            ) : matrix.data ? (
              <PromotionMatrix
                data={matrix.data}
                selected={selected}
                onSelect={(month, channelId) =>
                  setSelected((prev) =>
                    prev && prev.month === month && prev.channel === channelId
                      ? null
                      : { month, channel: channelId },
                  )
                }
              />
            ) : null}
          </CardBody>

          <div className="flex items-start gap-2 border-t border-border-subtle px-5 py-3 text-sm text-ink-muted">
            <span className="mt-px text-status-info [&_svg]:h-3.5 [&_svg]:w-3.5">
              <Icon name="info" />
            </span>
            <span>
              {weeklyNames.length > 0
                ? `Weekly channels (${weeklyNames.join(', ')}) may run several promotions in one month — the cell is a summary. `
                : 'A cell summarises the month. '}
              Click any month to see its promotions, and the weekly breakdown where it applies.
            </span>
          </div>
        </Card>

        {/* The row height must come from the CALENDAR alone. A grid item is
            sized by its own content even with min-h-0, so the right column's
            long lists would otherwise stretch the row — and the calendar with
            it. Taking the content out of flow with absolute positioning makes
            this item contribute nothing to the row height, then fill exactly
            what the calendar sets. Below 1180px it returns to normal flow and
            the panels stack at their own heights. */}
        <div className="@min-[1180px]:relative">
          <div className="flex min-h-0 flex-col gap-4 @min-[1180px]:absolute @min-[1180px]:inset-0">
          {/* Details takes the larger share while it is open; expanding
              Upcoming flips the weighting. With nothing selected, Upcoming is
              the only child and fills the column on its own. */}
          {selected && (
            <Card
              className={`fade-in flex min-h-0 flex-col overflow-hidden ${
                upcomingExpanded ? '@min-[1180px]:flex-[1]' : '@min-[1180px]:flex-[1.35]'
              }`}
            >
              <PromotionDetailPanel
                detail={detail.data}
                loading={detail.isLoading}
                onClose={() => setSelected(null)}
              />
            </Card>
          )}
          <Card
            className={`fade-in flex min-h-0 flex-col overflow-hidden ${
              selected && !upcomingExpanded ? '@min-[1180px]:flex-[1]' : '@min-[1180px]:flex-[1.6]'
            }`}
          >
            <UpcomingEventsPanel
              events={upcoming.data?.events ?? []}
              total={upcoming.data?.total ?? 0}
              contextLabel={upcomingContext}
              loading={upcoming.isLoading}
              expanded={upcomingExpanded}
              onToggleExpanded={() => setUpcomingExpanded((v) => !v)}
            />
          </Card>
          </div>
        </div>
      </div>
    </AppShell>
  )
}
