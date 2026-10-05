// The MMM Insights Hub's KPI deck: the headline three always on screen, and
// the six a reader can add beneath them, remembered per browser. The same
// arrangement as TPO's (components/command/kpiDeckState.ts), with its own
// storage key so the two hubs remember their own choices.

const STORAGE_KEY = 'mmm-insights-hub.kpis.added'

/** Always on screen: what came in, what was spent, and the return on it. */
export const MMM_HERO_KPIS = ['revenue', 'spend', 'roas'] as const

/** The six a reader can add, in the order they take on the page. The baseline
 *  and its derivatives come first, because they explain ROAS. */
export const MMM_ADDABLE_KPIS = [
  'baseline',
  'incremental',
  'baseline_per_day',
  'avg_daily_revenue',
  'ad_lift',
  'media_days',
] as const

export function readAddedMmmKpis(): string[] {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY)
    if (!raw) return []
    const parsed: unknown = JSON.parse(raw)
    if (!Array.isArray(parsed)) return []
    return MMM_ADDABLE_KPIS.filter((k) => parsed.includes(k))
  } catch {
    return []
  }
}

export function writeAddedMmmKpis(keys: string[]) {
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(keys))
  } catch {
    /* A remembered preference is a convenience, not a requirement. */
  }
}
