/** Promotion ROI is a MULTIPLE of trade spend — Incremental Sales ÷ Trade
 *  Spend — and prints as "1.40". 1.00 is break-even; below it the promotion
 *  lost money. The backend renders the same unit through
 *  `app/tpo/formatting.multiple`, and every `roi_display` string it sends is
 *  already in this form; these helpers exist for the places that format a raw
 *  number themselves, so no chart or tooltip can fall back to a percent sign.
 *
 *  TWO DECIMAL PLACES -- the project's one exception to its one-decimal rule,
 *  because a 0.1 step here is ten points of the old percent scale and would
 *  print a 0.96 (the old -3.6%) as break-even. A delta between two multiples
 *  is a difference in the same unit ("+0.20"), never a percentage of a
 *  multiple. */

/** The ROI multiple at which trade spend has exactly come back. */
export const BREAKEVEN_ROI = 1

export function fmtRoi(v: number | null | undefined, dp = 2): string {
  return v == null || !Number.isFinite(v) ? '—' : `${v.toFixed(dp)}`
}

/** A difference between two multiples, signed: "+0.20", "-0.30", "0.00". */
export function fmtRoiDelta(v: number | null | undefined, dp = 2): string {
  if (v == null || !Number.isFinite(v)) return '—'
  return `${v > 0 ? '+' : ''}${v.toFixed(dp)}`
}

/** The Insights Hub's severity bands, restated for display (the authority is
 *  `config.SEVERITY_BANDS` in app/tpo/config.py, which every alert's own
 *  `severity` comes from). A promotion at or above the 1.50 target is not an
 *  alert at all. Used where a page shows a scope's standing without an alert
 *  object in hand — the Investigations scope strip reads it off the scope's
 *  own ROI — and kept in step with the popover text on the Insights Hub. */
export const SEVERITY_BANDS = { critical: 1.25, high: 1.4, medium: 1.5 } as const

export type RoiStanding = 'Critical' | 'High' | 'Medium' | 'On target'

export function standingOf(roi: number | null | undefined): RoiStanding | null {
  if (roi == null || !Number.isFinite(roi)) return null
  if (roi < SEVERITY_BANDS.critical) return 'Critical'
  if (roi < SEVERITY_BANDS.high) return 'High'
  if (roi < SEVERITY_BANDS.medium) return 'Medium'
  return 'On target'
}
