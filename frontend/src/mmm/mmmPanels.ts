// THE MMM INSIGHTS HUB'S OWN CHARTS — which six they are, and which of them
// the reader is currently showing.
//
// THE PAGE OWNS THIS LIST; backend/app/agents/mmm_layout.py mirrors it so the
// Analyst can NAME a panel rather than invent one. tests/test_mmm_analyst.py
// reads this file and fails if the two drift, which is the only thing that
// makes a mirror safe. Change one, change both.
//
// The same arrangement as TPO's components/command/hubPanels.ts, with its own
// storage key so the two hubs remember their own choices.

export const MMM_PANEL_IDS = [
  'trend',
  'decomposition',
  'channel',
  'promotions',
  'comparison',
  'events',
] as const

export type MmmPanelId = (typeof MMM_PANEL_IDS)[number]

/** What the page calls each one, verbatim — so the Analyst's sentence and the
 *  card's header agree. */
export const MMM_PANEL_LABELS: Record<MmmPanelId, string> = {
  trend: 'Ad Spend & ROAS Trend',
  decomposition: 'Revenue Decomposition',
  channel: 'Channel Performance',
  promotions: 'Promotion Performance',
  comparison: 'Period Comparison',
  events: 'Event Impact',
}

/** All six, which is also the default. */
export const MMM_DEFAULT_PANELS: readonly MmmPanelId[] = MMM_PANEL_IDS

const STORAGE_KEY = 'mmm-insights-hub.panels.visible'

/** The same guarded per-browser memory the KPI deck uses: storage can be
 *  absent, disabled or throw, and the answer is then "all six", never none —
 *  a hub that opened empty because localStorage was blocked would read as a
 *  broken page rather than as a lost preference. */
export function readVisibleMmmPanels(): MmmPanelId[] {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY)
    if (!raw) return [...MMM_DEFAULT_PANELS]
    const parsed: unknown = JSON.parse(raw)
    if (!Array.isArray(parsed)) return [...MMM_DEFAULT_PANELS]
    const kept = MMM_PANEL_IDS.filter((id) => parsed.includes(id))
    return kept.length ? kept : []
  } catch {
    return [...MMM_DEFAULT_PANELS]
  }
}

export function writeVisibleMmmPanels(ids: readonly MmmPanelId[]) {
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(ids))
  } catch {
    /* A remembered preference is a convenience, not a requirement. */
  }
}
