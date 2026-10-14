import { useEffect, useMemo, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { Icon } from '../../icons'
import { carryPromotionToPlanner } from '../../store/plannerSelection'
import { LegendSwatch } from './PromotionMatrix'
import { STATUS, statusForPromotionType } from './statusColors'
import type { CalendarCellDetail, CalendarPromotion } from '../../types/promotionCalendar'

/** Promotion details for one Channel x Month.
 *
 *  MONTHLY-cadence channels show the month's promotions. WEEKLY-cadence ones
 *  additionally show the week-by-week breakdown, because a month there holds
 *  several separate promotion events —
 *  October's Dussehra and Diwali stay two distinct weekly promotions and are
 *  never merged into one.
 *
 *  Every field shown here is served resolved from dim_promotion_final.csv and
 *  dim_product_reordered.csv. The product list is the promotion's own list, so
 *  the count and the list cannot disagree. */

function TypeBadge({ type }: { type: string }) {
  // dim_promotion.Promotion_Type mapped onto the one calendar palette, so this
  // badge matches the cell the promotion came from.
  const tone = STATUS[statusForPromotionType(type)]
  return (
    <span
      className="inline-block rounded-full px-2 py-0.5 text-2xs font-medium"
      style={{ background: tone.tint, color: tone.solid }}
    >
      {type}
    </span>
  )
}

const MONTH_ABBR = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
const fmtDay = (iso: string) => `${Number(iso.slice(8, 10))} ${MONTH_ABBR[Number(iso.slice(5, 7)) - 1]} ${iso.slice(0, 4)}`

function PromotionBody({ promotion }: { promotion: CalendarPromotion }) {
  return (
    <div className="mt-3">
      {promotion.metadata_missing && (
        <p className="mb-2 rounded-[var(--r-sm)] border border-status-warning/30 bg-status-warning/10 px-2 py-1.5 text-xs text-ink-secondary">
          No row for <span className="font-medium">{promotion.promotion_id}</span> in the promotion master —
          showing the id rather than a name.
        </p>
      )}

      <dl className="grid grid-cols-[104px_minmax(0,1fr)] gap-x-3 gap-y-2 text-sm">
        <dt className="text-ink-muted">Promotion Type</dt>
        <dd className="font-medium text-ink-primary">{promotion.type}</dd>
        <dt className="text-ink-muted">Description</dt>
        <dd className="font-medium text-ink-primary">{promotion.description}</dd>
        {/* dim_promotion.Promotion_Name — the mechanic, not a derived label. */}
        <dt className="text-ink-muted">Mechanic</dt>
        <dd className="font-medium text-ink-primary">{promotion.mechanic}</dd>
        {promotion.start && promotion.end && (
          <>
            <dt className="text-ink-muted">Runs</dt>
            <dd className="font-medium tabular-nums text-ink-primary">
              {fmtDay(promotion.start)} – {fmtDay(promotion.end)}
            </dd>
          </>
        )}
        {promotion.store_count != null && (
          <>
            <dt className="text-ink-muted">Stores</dt>
            <dd className="font-medium text-ink-primary">{promotion.store_count}</dd>
          </>
        )}
        {promotion.weeks && promotion.weeks.length > 0 && (
          <>
            <dt className="text-ink-muted">Business Weeks</dt>
            <dd className="font-medium tabular-nums text-ink-primary">
              {promotion.weeks.map((w) => `W${String(w).padStart(2, '0')}`).join(', ')}
            </dd>
          </>
        )}
      </dl>

      {promotion.stores && promotion.stores.length > 0 && (
        <details className="mt-3.5 group">
          <summary className="cursor-pointer list-none text-xs font-medium text-ink-muted hover:text-ink-primary">
            Stores ({promotion.stores.length}) <span className="font-normal normal-case group-open:hidden">· show</span>
          </summary>
          <ul className="mt-1.5 flex flex-wrap gap-1">
            {promotion.stores.map((s) => (
              <li
                key={s.store_id}
                title={`${s.name} · ${s.city} · ${s.region}`}
                className="rounded-full bg-ink-primary/[0.04] px-2 py-0.5 text-xs font-medium text-ink-secondary"
              >
                {s.store_id} · {s.city}
              </li>
            ))}
          </ul>
        </details>
      )}

      <p className="mt-3.5 text-xs font-medium text-ink-muted">
        Products in Promotion ({promotion.product_count})
      </p>
      <ul className="mt-1.5 flex flex-col gap-1">
        {promotion.products.map((product) => (
          <li
            key={product.product_id}
            className="flex items-center gap-2 rounded-[var(--r-sm)] bg-ink-primary/[0.03] px-2 py-1.5"
            title={`${product.name} · ${product.brand_form} · ${product.category}`}
          >
            <span className="grid h-5 w-5 shrink-0 place-items-center rounded-[6px] bg-surface-card text-ink-muted [&_svg]:h-3 [&_svg]:w-3">
              <Icon name="package" />
            </span>
            <span className="min-w-0 flex-1 truncate text-sm font-medium text-ink-primary">
              {product.product_id}
            </span>
            <span className="shrink-0 text-xs text-ink-muted">P{product.rank}</span>
          </li>
        ))}
      </ul>
    </div>
  )
}

export function PromotionDetailPanel({
  detail,
  loading,
  onClose,
}: {
  detail: CalendarCellDetail | undefined
  loading: boolean
  onClose: () => void
}) {
  const [openId, setOpenId] = useState<string | null>(null)
  const navigate = useNavigate()

  // Default to the cell's headline promotion — the seasonal event when there
  // is one, which is what the grid cell is named after.
  const headline = useMemo(
    () => detail?.cell.promotion_ids[0] ?? detail?.promotions[0]?.promotion_id ?? null,
    [detail],
  )
  useEffect(() => setOpenId(headline), [headline])

  if (!detail) {
    return (
      <div className="grid min-h-[220px] flex-1 place-items-center px-6 text-center text-base text-ink-muted">
        {loading ? 'Loading promotion…' : 'Select a month to see its promotion details.'}
      </div>
    )
  }

  const { cell, channel, promotions, weeks } = detail
  const selected = promotions.find((p) => p.promotion_id === openId) ?? promotions[0]

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {/* Header stays put; the promotion body below it scrolls, so a long
          product list can never grow the page. */}
      <div className="flex shrink-0 items-start justify-between gap-3 border-b border-border-subtle px-5 py-4">
        <div className="min-w-0">
          <h3 className="text-md font-medium">
            {detail.month_name} {detail.year} — {channel.channel_id}
          </h3>
          <p className="mt-0.5 truncate text-sm text-ink-muted">
            {channel.name} · promotions run {channel.booking === 'week' ? 'by the week' : 'for the month'}
          </p>
        </div>
        <button
          type="button"
          onClick={onClose}
          aria-label="Close promotion details"
          className="grid h-6 w-6 shrink-0 cursor-pointer place-items-center rounded-full text-ink-muted transition-colors hover:bg-ink-primary/[0.06] hover:text-ink-primary [&_svg]:h-3.5 [&_svg]:w-3.5"
        >
          <Icon name="x" />
        </button>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4 @max-[1179px]:max-h-[560px]">
        <div className="flex items-center gap-2">
          <LegendSwatch kind={cell.kind} />
          <span className="text-base font-medium text-ink-primary">{cell.label}</span>
        </div>
        <p className="mt-1 text-sm text-ink-muted">
          {cell.promotion_ids.join(' + ') || 'No promotion scheduled'}
        </p>
        {/* The MONTH total: distinct products across every promotion in this
            cell. Worded apart from the per-promotion "Products in Promotion
            (n)" heading below, which counts one promotion only — the two are
            different questions and must not read as the same number. */}
        <p className="mt-1 text-sm font-medium text-ink-secondary">
          {cell.product_count} products · {cell.store_count} stores · {cell.week_count} week{cell.week_count === 1 ? '' : 's'}
        </p>

        {promotions.length === 0 ? (
          /* A genuinely empty month. No placeholder promotion, no products. */
          <p className="mt-4 rounded-[var(--r-sm)] bg-ink-primary/[0.03] px-3 py-3 text-sm text-ink-muted">
            No promotion is scheduled for this period.
          </p>
        ) : (
          <>
            {/* Weekly channels: the month is a summary, so show the weeks that
                make it up before drilling into any single promotion. */}
            {channel.booking === 'week' && weeks.length > 0 && (
              <div className="mt-4">
                <p className="text-xs font-medium text-ink-muted">
                  Weekly Promotions
                </p>
                <div className="mt-1.5 flex flex-col gap-1.5">
                  {weeks.map((week) => (
                    <div key={week.week_key} className="rounded-[var(--r-sm)] border border-border-subtle px-2.5 py-2">
                      <div className="flex items-baseline justify-between gap-2">
                        <span className="text-sm font-medium text-ink-primary">
                          Week {String(week.week_number).padStart(2, '0')}
                        </span>
                        {week.week_start && (
                          <span className="text-xs tabular-nums text-ink-muted">{week.week_start}</span>
                        )}
                      </div>
                      <div className="mt-1 flex flex-wrap gap-1">
                        {week.promotions.map((promotion) => (
                          <button
                            key={promotion.promotion_id}
                            type="button"
                            onClick={() => setOpenId(promotion.promotion_id)}
                            title={`${promotion.description} · ${promotion.mechanic}`}
                            className={`cursor-pointer rounded-full border px-2 py-0.5 text-xs font-medium transition-colors ${
                              promotion.promotion_id === openId
                                ? 'border-brand-violet bg-brand-violet text-white'
                                : 'border-border-subtle text-ink-secondary hover:bg-surface-hover'
                            }`}
                          >
                            {promotion.promotion_id} · {promotion.product_count}p{promotion.store_count != null ? ` · ${promotion.store_count}st` : ''}
                          </button>
                        ))}
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {/* Every promotion in the cell, so a seasonal headline never hides
                the regular activity running beside it. */}
            {promotions.length > 1 && (
              <div className="mt-4 flex flex-wrap gap-1.5">
                {promotions.map((promotion) => (
                  <button
                    key={promotion.promotion_id}
                    type="button"
                    onClick={() => setOpenId(promotion.promotion_id)}
                    className={`cursor-pointer rounded-full border px-2.5 py-1 text-xs font-medium transition-colors ${
                      promotion.promotion_id === selected?.promotion_id
                        ? 'border-brand-violet bg-brand-violet/10 text-brand-violet'
                        : 'border-border-subtle text-ink-secondary hover:bg-surface-hover'
                    }`}
                  >
                    {promotion.promotion_id}
                  </button>
                ))}
              </div>
            )}

            {selected && (
              <div className="mt-3 border-t border-border-subtle pt-3">
                <div className="flex items-center gap-2">
                  <span className="text-base font-medium text-ink-primary">{selected.description}</span>
                  <TypeBadge type={selected.type} />
                </div>
                {/* Into the Simulation Studio's Promotion Planner with this
                    promotion's own product-stores in this channel-month: its
                    discount, what-if, a profit target and its best offers. */}
                <button
                  type="button"
                  onClick={() => {
                    carryPromotionToPlanner({
                      promotionId: selected.promotion_id,
                      promotionName: selected.description,
                      channelId: channel.channel_id,
                      channelName: channel.name,
                      year: detail.year,
                      month: detail.month,
                      monthName: detail.month_name,
                    })
                    navigate('/simulation')
                  }}
                  className="mt-3 inline-flex w-full cursor-pointer items-center justify-center gap-2 rounded-[var(--r-md)] bg-brand-violet px-3 py-2 text-sm font-medium text-white shadow-[var(--shadow-violet)] transition-colors hover:bg-brand-violet-600 [&_svg]:h-4 [&_svg]:w-4"
                >
                  <Icon name="sparkles" /> Simulate this promotion
                </button>
                <PromotionBody promotion={selected} />
              </div>
            )}
          </>
        )}
      </div>
    </div>
  )
}
