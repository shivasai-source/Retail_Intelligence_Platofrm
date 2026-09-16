// The remembered open/closed state of the Insights Hub's "more KPIs" row, and
// the tile shapes its skeleton and its live tiles share. Kept out of
// MoreKpis.tsx so that file exports only a component (fast refresh).

const STORAGE_KEY = 'insights-hub.kpis.more-open'

/** Whether the row was open last time. Read once, at first render, by the
 *  reveal and by the page's loading skeleton, so the skeleton lays out the
 *  same rows the data will fill. Every access is guarded: storage can be
 *  absent, disabled or throw, and the answer is then "closed". */
export function readMoreKpisOpen(): boolean {
  try {
    return window.localStorage.getItem(STORAGE_KEY) === '1'
  } catch {
    return false
  }
}

export function writeMoreKpisOpen(open: boolean) {
  try {
    window.localStorage.setItem(STORAGE_KEY, open ? '1' : '0')
  } catch {
    /* A remembered preference is a convenience, not a requirement. */
  }
}

/** The three headline tiles span two of the grid's six columns above
 *  1500px and one of its three down to 900px, so they fill exactly one row
 *  at both widths and are wide enough to carry their evidence line. On the
 *  two-column grid below 900px they take the full width and stack — three
 *  tiles on two columns would strand one on a row of its own. The six tiles
 *  behind the reveal are single-column throughout: one row of six at the
 *  widest, two rows of three, then three rows of two. */
export const HERO_TILE_CLASS = 'col-span-2 @max-[1500px]:col-span-1 @max-[900px]:col-span-2'
