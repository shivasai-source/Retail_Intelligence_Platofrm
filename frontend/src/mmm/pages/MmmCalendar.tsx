import { useState } from 'react'
import { Card, CardBody, CardHeader, Spinner } from '../../components/ui'
import { InfoBlock, InfoPopover } from '../../components/ui/InfoPopover'
import { ErrorState, PanelSkeleton, Stale } from '../../components/command/States'
import { SERIES } from '../../components/command/series'
import { MmmShell } from '../components/MmmShell'
import { MmmToolbar, resolveYear } from '../components/MmmToolbar'
import { useMmmCalendar, useMmmCalendarMonth } from '../hooks'
import { useMmmView } from '../store'
import type { MmmCalendar as CalendarData } from '../types'

// MMM — CALENDAR. The MMM twin of TPO's Promotion Calendar: the same page
// shape (a year grid, with the chosen period's detail beside it) over media
// flighting instead of promotions.
//
//   THE GRID   channel x month for one year, shaded by spend: off air, then
//              four steps — the quartiles of that year's non-zero
//              channel-months (GET /api/mmm/calendar). Above it, each month's
//              revenue and spend, and how many promotion days, holidays and
//              trending days it held.
//   THE DETAIL a month, day by day: revenue, media spend, the channels that
//              ran and the day's flags (GET /api/mmm/calendar/month).

const LEVEL_OPACITY = [0, 0.16, 0.36, 0.62, 0.92]

export function MmmCalendar() {
  const chosen = useMmmView((s) => s.year)
  const currency = useMmmView((s) => s.currency)
  // The calendar is per year: "All years" on the hub opens the latest here.
  const asked = typeof chosen === 'number' ? chosen : null
  const calendar = useMmmCalendar(asked, currency)
  const data = calendar.data
  const year = data?.year ?? resolveYear(chosen, undefined, false)
  const [month, setMonth] = useState<number | null>(null)

  // Default the detail to the last month that has data.
  const lastWithData = data ? [...data.months].reverse().find((m) => m.has_data)?.month ?? null : null
  const shownMonth = month !== null && data?.months[month - 1]?.has_data ? month : lastWithData

  return (
    <MmmShell activeKey="calendar" page="Calendar">
      <div className="fade-in flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="text-2xl font-extrabold tracking-[-0.02em]">Media Calendar</h1>
          <p className="mt-1.5 text-base text-ink-muted">
            When each channel was on air, month by month{data ? ` · ${data.year}` : ''}
          </p>
        </div>
        <MmmToolbar years={data?.years ?? []} year={year} allowAll={false} />
      </div>

      {calendar.isError && !data ? (
        <Card className="mt-[14px]">
          <ErrorState error={calendar.error} onRetry={() => void calendar.refetch()} retrying={calendar.isFetching} />
        </Card>
      ) : !data ? (
        <div className="mt-[14px]">
          <PanelSkeleton height={520} />
        </div>
      ) : (
        <Stale when={calendar.isFetching}>
          <div className="mt-[14px] grid grid-cols-[minmax(0,1fr)_minmax(300px,360px)] gap-4 @max-[1150px]:grid-cols-1">
            <Card>
              <CardHeader
                title={
                  <span className="flex items-center gap-1.5">
                    Channel Flighting
                    <InfoPopover label="About Channel Flighting" title="Channel Flighting">
                      <InfoBlock label="Cell">A channel's total spend in a month, and the days it had spend above 0.</InfoBlock>
                      <InfoBlock label="Shading">
                        Off air, then the four quartiles of this year's non-zero channel-months — so the darkest
                        cells are the year's heaviest quarter of activity.
                      </InfoBlock>
                    </InfoPopover>
                  </span>
                }
                subtitle={`${data.channels.length} channels · click a month for its days`}
              />
              <CardBody className="overflow-x-auto">
                <FlightGrid data={data} month={shownMonth} onMonth={setMonth} />
                <Legend />
              </CardBody>
            </Card>

            <MonthDetail year={data.year} month={shownMonth} currency={currency} />
          </div>
        </Stale>
      )}
    </MmmShell>
  )
}

function FlightGrid({
  data,
  month,
  onMonth,
}: {
  data: CalendarData
  month: number | null
  onMonth: (m: number) => void
}) {
  return (
    <table className="w-full min-w-[760px] border-separate border-spacing-[3px] text-xs">
      <thead>
        <tr>
          <th className="w-[170px] pb-1 text-left font-semibold text-ink-muted">Channel</th>
          {data.months.map((m) => (
            <th key={m.month} className="pb-1 font-normal">
              <button
                type="button"
                disabled={!m.has_data}
                onClick={() => onMonth(m.month)}
                aria-pressed={month === m.month}
                className={`w-full rounded-[var(--r-sm)] px-1 py-1 text-center transition-colors ${
                  month === m.month
                    ? 'bg-brand-violet text-white'
                    : m.has_data
                      ? 'cursor-pointer text-ink-secondary hover:bg-surface-hover'
                      : 'text-ink-disabled'
                }`}
              >
                <div className="font-bold">{m.abbr}</div>
                <div className={`tabular-nums ${month === m.month ? 'text-white/85' : 'text-ink-muted'}`}>
                  {m.has_data ? m.spend_display : '—'}
                </div>
              </button>
            </th>
          ))}
        </tr>
        <tr>
          <th className="text-left font-normal text-ink-muted">Events</th>
          {data.months.map((m) => (
            <th key={m.month} className="font-normal">
              {m.has_data && (
                <div className="flex justify-center gap-1 text-[10px] tabular-nums text-ink-muted">
                  <span title="Promotion days">P{m.promo_days}</span>
                  <span title="Holidays">H{m.holidays}</span>
                </div>
              )}
            </th>
          ))}
        </tr>
      </thead>
      <tbody>
        {data.channels.map((c) => (
          <tr key={c.column}>
            <td className="truncate pr-2 font-semibold text-ink-primary" title={`${c.label} · ${c.family} · ${c.total_display}`}>
              {c.label}
              <div className="truncate text-[10.5px] font-normal text-ink-muted">{c.total_display}</div>
            </td>
            {c.cells.map((cell) => (
              <td key={cell.month} className="p-0">
                <button
                  type="button"
                  disabled={!cell.has_data}
                  onClick={() => onMonth(cell.month)}
                  title={
                    cell.has_data
                      ? cell.level
                        ? `${c.label} · ${data.months[cell.month - 1].name}: ${cell.spend_display} over ${cell.active_days} days`
                        : `${c.label} · ${data.months[cell.month - 1].name}: off air`
                      : 'No data for this month'
                  }
                  className={`h-8 w-full rounded-[5px] border transition-[outline] ${
                    month === cell.month ? 'outline outline-2 outline-brand-violet' : ''
                  } ${cell.has_data ? 'cursor-pointer border-border-subtle' : 'border-dashed border-border-subtle'}`}
                  style={{
                    background: cell.level
                      ? `color-mix(in srgb, ${SERIES.spend} ${Math.round(LEVEL_OPACITY[cell.level] * 100)}%, transparent)`
                      : undefined,
                  }}
                >
                  {cell.level > 0 && (
                    <span className={`text-[10px] font-semibold tabular-nums ${cell.level >= 3 ? 'text-white' : 'text-ink-secondary'}`}>
                      {cell.active_days}d
                    </span>
                  )}
                </button>
              </td>
            ))}
          </tr>
        ))}
      </tbody>
    </table>
  )
}

function Legend() {
  return (
    <div className="mt-3 flex flex-wrap items-center gap-3 text-xs text-ink-muted">
      <span>Spend in month:</span>
      {['Off air', 'Low', 'Medium', 'High', 'Heaviest'].map((label, level) => (
        <span key={label} className="inline-flex items-center gap-1.5">
          <span
            className="h-3 w-5 rounded-[3px] border border-border-subtle"
            style={{
              background: level
                ? `color-mix(in srgb, ${SERIES.spend} ${Math.round(LEVEL_OPACITY[level] * 100)}%, transparent)`
                : undefined,
            }}
          />
          {label}
        </span>
      ))}
      <span className="ml-auto">Nd = days on air · P = promotion days · H = holidays</span>
    </div>
  )
}

function MonthDetail({ year, month, currency }: { year: number; month: number | null; currency: string }) {
  const detail = useMmmCalendarMonth(month === null ? null : year, month, currency)
  const d = detail.data
  return (
    <Card className="flex max-h-[760px] flex-col">
      <CardHeader
        title={d ? `${d.month_name} ${d.year}` : 'Month detail'}
        subtitle={d ? `${d.days.length} days` : undefined}
      />
      <div className="min-h-0 flex-1 overflow-y-auto px-4 pb-4">
        {month === null ? (
          <p className="py-6 text-center text-sm text-ink-muted">Pick a month to see its days.</p>
        ) : detail.isLoading ? (
          <div className="grid min-h-[200px] place-items-center">
            <Spinner />
          </div>
        ) : detail.isError ? (
          <p className="py-6 text-center text-sm text-[#B91C1C]">{detail.error.message}</p>
        ) : (
          <ul className="flex flex-col gap-2">
            {d?.days.map((day) => (
              <li key={day.date} className="rounded-[var(--r-md)] border border-border-subtle p-[9px_11px]">
                <div className="flex items-baseline justify-between gap-2">
                  <span className="text-sm font-bold text-ink-primary">
                    {day.weekday} {day.day}
                  </span>
                  <span className="text-sm tabular-nums text-ink-secondary">{day.revenue_display}</span>
                </div>
                <div className="mt-1 flex flex-wrap items-center gap-1">
                  {day.holiday && <Tag tone="violet">Holiday</Tag>}
                  {day.trending && <Tag tone="teal">Trending</Tag>}
                  {day.promotion && <Tag tone="amber">{day.promotion_type || 'Promotion'}</Tag>}
                  <span className="ml-auto text-xs tabular-nums text-ink-muted">
                    {day.spend ? `${day.spend_display} media · ${day.channels.length} ch` : 'No media'}
                  </span>
                </div>
                {day.channels.length > 0 && (
                  <div className="mt-1 truncate text-[11px] text-ink-muted" title={day.channels.map((c) => `${c.label} ${c.spend_display}`).join(' · ')}>
                    {day.channels
                      .slice(0, 3)
                      .map((c) => c.label)
                      .join(' · ')}
                    {day.channels.length > 3 ? ` +${day.channels.length - 3}` : ''}
                  </div>
                )}
              </li>
            ))}
          </ul>
        )}
      </div>
    </Card>
  )
}

function Tag({ tone, children }: { tone: 'violet' | 'teal' | 'amber'; children: React.ReactNode }) {
  const cls = {
    violet: 'bg-brand-violet-50 text-brand-violet',
    teal: 'bg-tint-teal text-[#0F766E]',
    amber: 'bg-status-warning-bg text-[#B45309]',
  }[tone]
  return <span className={`rounded-[var(--r-pill)] px-1.5 py-px text-[10.5px] font-bold ${cls}`}>{children}</span>
}
