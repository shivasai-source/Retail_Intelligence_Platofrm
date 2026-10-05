import { useState } from 'react'
import { Card, CardBody, CardHeader, Table, Td, Th, Tr } from '../../components/ui'
import { InfoBlock, InfoPopover } from '../../components/ui/InfoPopover'
import { TipRow } from '../../components/command/ChartSections'
import { Segmented } from '../../components/command/Segmented'
import { Icon } from '../../icons'
import { FILL, PairedColumns, ShareBars, ValueColumns, axisMoney } from './charts'
import type { MmmHub } from '../types'

/** The Insights Hub's panels below the trend. Every value and display string
 *  arrives formatted from app/mmm/service.py. These components choose
 *  colours and scale bars; they never divide. */

export function PanelTitle({ title, about }: { title: string; about: Array<[string, string]> }) {
  return (
    <span className="flex items-center gap-1.5">
      {title}
      <InfoPopover label={`About ${title}`} title={title}>
        {about.map(([label, text]) => (
          <InfoBlock key={label} label={label}>
            {text}
          </InfoBlock>
        ))}
      </InfoPopover>
    </span>
  )
}

/** A native <select> dressed as one of the card's controls, the 23px control
 *  TPO's Performance Comparison card uses. */
function Select({ children, ...props }: React.SelectHTMLAttributes<HTMLSelectElement>) {
  return (
    <span className="relative inline-flex">
      <select
        {...props}
        className="h-[23px] cursor-pointer appearance-none rounded-[var(--r-sm)] border border-border-subtle bg-surface-card pl-2 pr-6 text-xs font-semibold text-ink-primary transition-colors hover:bg-surface-hover focus:outline-none focus-visible:ring-1 focus-visible:ring-brand-violet"
      >
        {children}
      </select>
      <Icon name="chevronDown" className="pointer-events-none absolute right-1.5 top-1/2 h-3 w-3 -translate-y-1/2 text-ink-muted" />
    </span>
  )
}

function Swatch({ fill, label, outline }: { fill: string; label: string; outline?: boolean }) {
  return (
    <span className="inline-flex items-center gap-1.5">
      <span
        className="h-2.5 w-2.5 rounded-[2px]"
        style={{ background: fill, boxShadow: outline ? 'inset 0 0 0 1px color-mix(in srgb, var(--brand-violet) 55%, transparent)' : undefined }}
      />
      {label}
    </span>
  )
}

function Caveat({ children }: { children: React.ReactNode }) {
  return <p className="mt-2 text-xs leading-[1.5] text-ink-muted">{children}</p>
}

/** A metric value in the comparison's own unit, for the axis. */
function tickFor(unit: string, currency: string, rate: number) {
  if (unit === 'multiple') return (v: number) => `${v.toFixed(2)}x`
  if (unit === 'count') return (v: number) => v.toFixed(0)
  return (v: number) => axisMoney(v * rate, currency)
}

/** PERFORMANCE COMPARISON — the selected period beside YAGO (same dates a
 *  year earlier), PAGO (the equal-length period just before) and MAGO (same
 *  dates a month earlier), on one measure at a time. The selected column is
 *  solid violet, the comparison picked in the switch its tint, the other two
 *  recessive — TPO's comparison card's colouring. Each period's baseline is
 *  its own, so ROAS and Incremental Revenue compare like for like. */
export function ComparisonCard({ data }: { data: MmmHub }) {
  const [metricKey, setMetricKey] = useState('revenue')
  const [kind, setKind] = useState<'yago' | 'pago' | 'mago'>('yago')
  const cmp = data.comparison
  const spec = cmp.metrics.find((m) => m.key === metricKey) ?? cmp.metrics[0]
  const win = cmp.windows.find((w) => w.key === kind)!
  const current = cmp.current[spec.key]
  const against = win.values[spec.key]
  const delta = win.delta[spec.key]
  const tone =
    delta?.good === true
      ? 'bg-status-success/10 text-status-success'
      : delta?.good === false
        ? 'bg-status-danger/10 text-status-danger'
        : 'bg-ink-primary/[0.06] text-ink-muted'

  const columns = [
    { key: 'current', label: 'Selected', value: current.value, display: current.display, role: 'current' as const },
    ...cmp.windows.map((w) => ({
      key: w.key,
      label: w.label,
      value: w.available ? (w.values[spec.key]?.value ?? null) : null,
      display: w.available ? (w.values[spec.key]?.display ?? '—') : '—',
      role: w.key === kind ? ('against' as const) : ('idle' as const),
    })),
  ]
  const periodOf = (i: number) => (i === 0 ? cmp.period_label : cmp.windows[i - 1].period_label)

  return (
    <Card className="flex h-full flex-col">
      <CardHeader
        title={
          <PanelTitle
            title="Performance Comparison"
            about={[
              [spec.label, spec.formula],
              ['YAGO', 'The same dates a year earlier.'],
              ['PAGO', 'The period of the same length immediately before.'],
              ['MAGO', 'The same dates a month earlier.'],
              ['Baseline', 'Re-estimated for each period over that period’s own days.'],
            ]}
          />
        }
      />
      <div className="flex flex-wrap items-center gap-2 border-b border-border-subtle px-5 py-2.5">
        <Select aria-label="Measure" value={spec.key} onChange={(e) => setMetricKey(e.target.value)}>
          {cmp.metrics.map((m) => (
            <option key={m.key} value={m.key}>
              {m.label}
            </option>
          ))}
        </Select>
        <Segmented
          ariaLabel="Comparison period"
          value={kind}
          onChange={setKind}
          options={cmp.windows.map((w) => ({ key: w.key, label: w.label, title: w.full }))}
        />
      </div>
      <CardBody className="flex flex-1 flex-col">
        <div className="mb-1.5 flex flex-wrap items-center gap-x-3.5 gap-y-1 text-xs text-ink-muted">
          <Swatch fill={FILL.current} label="Selected" />
          <Swatch fill={FILL.against} label="Compared with" outline />
          <span className="ml-auto truncate">{spec.label}</span>
        </div>
        <ValueColumns
          columns={columns}
          format={tickFor(spec.unit, data.meta.currency, spec.unit === 'currency' ? data.meta.exchange_rate : 1)}
          ariaLabel={`${spec.label}: selected period and comparison periods`}
          tooltip={(i) => (
            <>
              <div className="font-bold text-ink-primary">{columns[i].label}</div>
              <div className="text-ink-muted">{periodOf(i) || '—'}</div>
              <TipRow k={spec.label} v={columns[i].display} />
              {i > 0 && !cmp.windows[i - 1].available && (
                <div className="mt-1 leading-[1.4] text-ink-muted">{cmp.windows[i - 1].reason}</div>
              )}
            </>
          )}
        />
        <div className="mt-2 flex items-end justify-between gap-3 border-t border-border-subtle pt-2.5">
          <div className="grid min-w-0 grid-cols-2 gap-x-4">
            <div className="min-w-0">
              <div className="truncate text-xs text-ink-muted" title={cmp.period_label}>{cmp.period_label}</div>
              <div className="text-lg font-extrabold tabular-nums text-ink-primary">{current.display}</div>
            </div>
            <div className="min-w-0">
              <div className="truncate text-xs text-ink-muted" title={win.period_label}>{win.period_label || win.full}</div>
              <div className={`text-lg font-bold tabular-nums ${win.available ? 'text-ink-secondary' : 'text-ink-muted'}`}>
                {win.available ? against?.display : '—'}
              </div>
            </div>
          </div>
          <div className="shrink-0 text-right">
            <span
              className={`inline-block rounded-full px-2 py-0.5 text-sm font-bold tabular-nums ${tone}`}
              title={delta?.basis ? `Measured in ${delta.basis}` : undefined}
            >
              {win.available ? (delta?.display ?? '—') : '—'}
            </span>
            <div className="mt-0.5 text-xs text-ink-muted">{win.available ? win.full : 'no comparable period'}</div>
          </div>
        </div>
        {!win.available && win.reason && (
          <div className="mt-1.5 text-xs leading-[1.45] text-ink-muted">{win.reason}.</div>
        )}
      </CardBody>
    </Card>
  )
}

/** DAYS WITH VS WITHOUT EVENTS — average daily revenue on days with each
 *  event beside the days without it, in the scope. */
export function EventsCard({ data }: { data: MmmHub }) {
  return (
    <Card className="flex h-full flex-col">
      <CardHeader
        title={
          <PanelTitle
            title="Days With vs Without Events"
            about={[
              ['Average daily revenue', 'Sum of Revenue ÷ number of days, for the days with the event and for the days without it.'],
              ['Difference', '(With − Without) ÷ Without.'],
              ['Ad spend', 'Days on which the selected channels spent more than 0.'],
            ]}
          />
        }
      />
      <CardBody className="flex flex-1 flex-col">
        <div className="mb-1.5 flex flex-wrap items-center gap-x-3.5 gap-y-1 text-xs text-ink-muted">
          <Swatch fill={FILL.current} label="Days with" />
          <Swatch fill={FILL.against} label="Days without" outline />
          <span className="ml-auto">Avg daily revenue</span>
        </div>
        <PairedColumns groups={data.events} rate={data.meta.exchange_rate} currency={data.meta.currency} />
        <Caveat>
          A comparison of averages, not the effect of the event: season and the other events also differ between these
          days.
        </Caveat>
      </CardBody>
    </Card>
  )
}

type PromoMetric = 'avg_revenue' | 'revenue' | 'days'
const PROMO_METRICS: Array<{ key: PromoMetric; label: string }> = [
  { key: 'avg_revenue', label: 'Avg / Day' },
  { key: 'revenue', label: 'Revenue' },
  { key: 'days', label: 'Days' },
]

/** REVENUE BY PROMOTION TYPE — one bar per offer, on the measure picked. */
export function PromotionsCard({ data }: { data: MmmHub }) {
  const [metric, setMetric] = useState<PromoMetric>('avg_revenue')
  const rows = [...data.promotions].sort((a, b) => b[metric] - a[metric])
  return (
    <Card className="flex h-full flex-col">
      <CardHeader
        title={
          <PanelTitle
            title="Revenue by Promotion Type"
            about={[
              ['Avg / Day', 'Sum of Revenue ÷ days that offer ran.'],
              ['Revenue', 'Sum of Revenue on days that offer ran; share is of all revenue in scope.'],
              ['Days', 'Days that offer ran; share is of all days in scope.'],
            ]}
          />
        }
      />
      <div className="flex flex-wrap items-center gap-2 border-b border-border-subtle px-5 py-2.5">
        <Segmented ariaLabel="Promotion measure" value={metric} onChange={setMetric} options={PROMO_METRICS} />
      </div>
      <CardBody className="flex flex-1 flex-col">
        {rows.length === 0 ? (
          <div className="grid min-h-[120px] place-items-center text-sm text-ink-muted">No promotion types in this selection.</div>
        ) : (
          <ShareBars
            color={FILL.current}
            rows={rows.map((p) => ({
              key: p.type,
              label: p.type,
              sub: metric === 'days' ? undefined : `${p.days.toLocaleString()} days`,
              value: p[metric],
              display:
                metric === 'avg_revenue' ? p.avg_revenue_display : metric === 'revenue' ? p.revenue_display : p.days.toLocaleString(),
              share: metric === 'days' ? `${p.share_of_days.toFixed(2)}%` : metric === 'revenue' ? `${p.share_of_revenue.toFixed(2)}%` : `${p.share_of_days.toFixed(2)}% of days`,
            }))}
          />
        )}
        <Caveat>Descriptive, not causal: offers do not run on random days.</Caveat>
      </CardBody>
    </Card>
  )
}

/** BASELINE CALCULATION — the formula's steps for the selected range, with
 *  the averages and the day counts behind each. Shown so every ROAS on the
 *  page can be traced back to the days it came from. */
export function BaselineCard({ data }: { data: MmmHub }) {
  const b = data.baseline
  const rows: Array<[string, string, string, string]> = [
    ['X', 'Ad spend, and Holiday, Trending and Promotion all 1', `${b.x_display}`, `${b.days.x} days`],
    ['Y', 'No ad spend, and all three flags 1', b.y_display, `${b.days.y} days`],
    ['Z = X − Y', 'Revenue from ad spend, per day', b.z_display, ''],
    ['R', 'Ad spend, and no flags', b.r_display, `${b.days.r} days`],
    ['R − Z', 'Baseline revenue per day', b.per_day_display, ''],
  ]
  return (
    <Card className="flex h-full flex-col">
      <CardHeader
        title={
          <PanelTitle
            title="Baseline Calculation"
            about={[
              ['Baseline per day', 'R − (X − Y). X, Y and R are each an average daily revenue.'],
              ['Baseline revenue', 'Baseline per day × days in scope.'],
              ['Per range', 'Re-estimated whenever the range changes. Never a fixed figure for the file.'],
            ]}
          />
        }
        subtitle={b.window.label ? `Estimated over ${b.window.label}` : undefined}
      />
      {!b.available ? (
        <CardBody>
          <div className="grid min-h-[140px] place-items-center px-4 text-center text-sm text-ink-muted">{b.reason}</div>
        </CardBody>
      ) : (
        <>
          <div className="overflow-x-auto">
            <Table>
              <thead>
                <tr>
                  <Th>Step</Th>
                  <Th>Days</Th>
                  <Th className="text-right">Avg / day</Th>
                </tr>
              </thead>
              <tbody>
                {rows.map(([step, what, value, days]) => (
                  <Tr key={step}>
                    <Td emphasis>
                      <div>{step}</div>
                      <div className="text-xs font-normal text-ink-muted">{what}</div>
                    </Td>
                    <Td className="tabular-nums text-ink-muted">{days}</Td>
                    <Td className={`text-right tabular-nums ${step === 'R − Z' ? 'font-bold text-ink-primary' : ''}`}>{value}</Td>
                  </Tr>
                ))}
              </tbody>
            </Table>
          </div>
          <CardBody className="pt-3">
            <div className="flex items-baseline justify-between gap-3 rounded-[var(--r-md)] bg-surface-muted p-[10px_14px]">
              <span className="text-sm text-ink-muted">
                Baseline revenue · {b.scope_days.toLocaleString()} days
              </span>
              <span className="text-lg font-extrabold tabular-nums text-ink-primary">{b.total_display}</span>
            </div>
            {b.widened && (
              <Caveat>
                The selected range has no day of one of the three kinds, so the window was widened a week at a time, on
                both sides, until it had one of each: {b.window.label}.
              </Caveat>
            )}
          </CardBody>
        </>
      )}
    </Card>
  )
}
