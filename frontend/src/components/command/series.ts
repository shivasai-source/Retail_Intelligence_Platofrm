/** THE INSIGHTS HUB'S SERIES PALETTE. One colour per METRIC, used by every
 *  chart on the page, so a reader learns the vocabulary once:
 *
 *    Incremental Sales  violet   (the brand colour — the money promotions made)
 *    Trade Spend        orange   (warm against the violet, and NOT red)
 *    ROI                teal
 *
 *  Trade Spend used to be drawn in the danger red — the same red the Critical
 *  alert badge, the negative deltas and the below-break-even ROI figures
 *  wear. A reader's eye learns "red = something is wrong", and every spend
 *  bar and line then read as a problem. Spend is a fact, not a warning, so it
 *  gets a colour of its own; red is now reserved for alerts and bad movement.
 *
 *  `SERIES` is for SVG attributes and inline styles, `SERIES_CLASS` for the
 *  same colours as Tailwind background utilities. Both resolve through the
 *  theme tokens, so the dark palette needs no second list. */
export const SERIES = {
  incremental: 'var(--brand-violet)',
  spend: 'var(--tint-peach-icon)',
  roi: 'var(--tint-teal-icon)',
} as const

export const SERIES_CLASS = {
  incremental: 'bg-brand-violet',
  spend: 'bg-tint-peach-icon',
  roi: 'bg-tint-teal-icon',
} as const

export type SeriesKey = keyof typeof SERIES
