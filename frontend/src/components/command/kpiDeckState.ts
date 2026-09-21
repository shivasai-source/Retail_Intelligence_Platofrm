// Which of the Insights Hub's six non-headline KPI cards the reader has added
// to the deck, remembered per browser, and the tile shape the deck's skeleton
// and its live tiles share. Kept out of AddKpiMenu.tsx so that file exports
// only a component (fast refresh).

const STORAGE_KEY = 'insights-hub.kpis.added'

/** THE SIX A READER CAN ADD, in the order they take on the page whatever
 *  order they were picked in: the three remaining headline cards first, in
 *  their long-standing order, then the diagnostic three — volume (the demand
 *  response), the money it made after cost, and how many promotions cleared
 *  the bar. The headline three (spend, return, ROI) are always on screen and
 *  are not in this list. */
export const ADDABLE_KPI_ORDER = [
  'margin_impact',
  'pei',
  'cannibalization_rate',
  'volume_uplift',
  'net_incremental_profit',
  'target_hit_rate',
] as const

/** The keys added last time, in page order. Read once, at first render, by
 *  the page and by its loading skeleton, so the skeleton lays out the same
 *  rows the data will fill. Every access is guarded: storage can be absent,
 *  disabled or throw, and the answer is then "none". Unknown keys — a card
 *  that has since been renamed or removed — are dropped rather than kept. */
export function readAddedKpis(): string[] {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY)
    if (!raw) return []
    const parsed: unknown = JSON.parse(raw)
    if (!Array.isArray(parsed)) return []
    return ADDABLE_KPI_ORDER.filter((k) => parsed.includes(k))
  } catch {
    return []
  }
}

export function writeAddedKpis(keys: string[]) {
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(keys))
  } catch {
    /* A remembered preference is a convenience, not a requirement. */
  }
}

/** The three headline tiles span two of the grid's six columns above 1180px
 *  and one of its three down to 900px, so they fill exactly one row at both
 *  widths. On the two-column
 *  grid below 900px they take the full width and stack — three tiles on two
 *  columns would strand one on a row of its own. The tiles a reader adds are
 *  single-column throughout: one row of six down to 1180px, two rows of
 *  three, then three rows of two. */
export const HERO_TILE_CLASS = 'col-span-2 @max-[1180px]:col-span-1 @max-[900px]:col-span-2'
