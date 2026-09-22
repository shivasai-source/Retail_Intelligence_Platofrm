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

/** HOW AN ROI FIGURE IS COLOURED, everywhere on the Insights Hub.
 *
 *  Three states, judged against the page's target rather than break-even:
 *    success  at or above the target -- the promotion did what was asked
 *    neutral  returned its spend but missed the target -- a fact, not a win
 *    danger   below 1.00 -- lost money
 *
 *  It used to be two states around break-even, so a 1.07 printed GREEN in
 *  the ranked cards while the alerts panel beside them filed the same
 *  promotion as Critical. One rule, one reading. The middle state is plain
 *  ink rather than amber: amber text at 12px does not meet contrast on a
 *  white card, and "missed target" is already said by not being green. */
export type RoiTone = 'success' | 'neutral' | 'danger' | 'muted'

export function roiTone(roi: number | null | undefined, target: number): RoiTone {
  if (roi == null || !Number.isFinite(roi)) return 'muted'
  if (roi >= target) return 'success'
  if (roi >= BREAKEVEN_ROI) return 'neutral'
  return 'danger'
}

/** Tailwind text classes for each tone (`font-semibold` included for the
 *  judged states, so a muted dash never reads as a verdict). */
export const ROI_TONE_CLASS: Record<RoiTone, string> = {
  success: 'font-semibold text-status-success',
  neutral: 'font-semibold text-ink-primary',
  danger: 'font-semibold text-status-danger',
  muted: 'text-ink-muted',
}

/** The same tones as CSS colours, for SVG text. */
export const ROI_TONE_VAR: Record<RoiTone, string> = {
  success: 'var(--status-success)',
  neutral: 'var(--text-primary)',
  danger: 'var(--status-danger)',
  muted: 'var(--text-muted)',
}

export function fmtRoi(v: number | null | undefined, dp = 2): string {
  return v == null || !Number.isFinite(v) ? '—' : `${v.toFixed(dp)}x`
}

/** A difference between two multiples, signed: "+0.20", "-0.30", "0.00".
 *
 *  NO "x" HERE. The unit is on the VALUE (`fmtRoi`); a delta sits under a
 *  label that already says what it is, and suffixing it too read as a second
 *  quantity rather than a change. */
export function fmtRoiDelta(v: number | null | undefined, dp = 2): string {
  if (v == null || !Number.isFinite(v)) return '—'
  return `${v > 0 ? '+' : ''}${v.toFixed(dp)}`
}

/** The severity bands AT THE DEFAULT TARGET, restated for display (the
 *  authority is `config.SEVERITY_BANDS` in app/tpo/config.py, which every
 *  alert's own `severity` comes from). A promotion at or above the target is
 *  not an alert at all. Used where a page shows a scope's standing without an
 *  alert object in hand — the Investigations scope strip reads it off the
 *  scope's own ROI. The Insights Hub itself reads `meta.severity_bands`,
 *  which follow the reader's target; `medium` here doubles as the last-resort
 *  default target when no payload has answered yet. */
export const SEVERITY_BANDS = { critical: 1.25, high: 1.4, medium: 1.5 } as const

export type RoiStanding = 'Critical' | 'High' | 'Medium' | 'On target'

export function standingOf(roi: number | null | undefined): RoiStanding | null {
  if (roi == null || !Number.isFinite(roi)) return null
  if (roi < SEVERITY_BANDS.critical) return 'Critical'
  if (roi < SEVERITY_BANDS.high) return 'High'
  if (roi < SEVERITY_BANDS.medium) return 'Medium'
  return 'On target'
}
