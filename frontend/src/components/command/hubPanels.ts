// WHICH CHARTS THE INSIGHTS HUB CAN SHOW, and how wide each one sits.
//
// The page used to hardcode its rows: five `<div className="grid grid-cols-2">`
// blocks with two panels written into each. That is exactly as many layouts as
// there are lines of JSX, so "remove the region chart" or "put product
// performance where the mix chart is" could not be expressed at all — by the
// reader with a control, or by the Analyst with a sentence.
//
// So the panels are a LIST now: ids in the order they appear, each declaring
// how much of its row it wants. The page renders whatever the list says
// (store/hubLayout.ts holds it), which is what makes the Analyst's
// `set_layout` possible and what makes Undo a one-liner.
//
// THE DEFAULT ORDER AND WIDTHS REPRODUCE THE PAGE EXACTLY as it was before
// this became a list — the trend across the top, then four rows of two, with
// Product Performance keeping the wider column it was given. That was not a
// nicety: this page is frozen, and a layout change nobody asked for would be
// a regression wearing a feature's clothes.
//
// MIRRORED IN backend/app/agents/hub_layout.py, which puts these ids into the
// Analyst's tool schema so the model can only ask for a panel that exists.
// `test_analyst_actions.py` reads this file and fails if the two drift.

export interface HubPanel {
  id: string
  /** What the card's own header says, verbatim. */
  label: string
  /** How much of its row it takes. 1 is half; 1.7 gives Product Performance
   *  the wider column it had. `full` takes the row on its own. */
  weight: number
  full?: boolean
  /** On the page unless the reader says otherwise. */
  defaultOn?: boolean
}

export const HUB_PANELS: HubPanel[] = [
  { id: 'trend', label: 'Promotion Performance Trend', weight: 1, full: true, defaultOn: true },
  { id: 'region', label: 'Sales by Region', weight: 1, defaultOn: true },
  { id: 'comparison', label: 'Performance Comparison', weight: 1, defaultOn: true },
  { id: 'mix', label: 'Promotion Mix by Scheme', weight: 1, defaultOn: true },
  { id: 'channel', label: 'Channel Performance', weight: 1, defaultOn: true },
  { id: 'top', label: 'Top Performing Promotions', weight: 1, defaultOn: true },
  { id: 'contribution', label: 'Promotion Contribution', weight: 1, defaultOn: true },
  { id: 'product', label: 'Product Performance', weight: 1.7, defaultOn: true },
  { id: 'promotion_type', label: 'Regular vs Seasonal Performance', weight: 1, defaultOn: true },
]

export const HUB_PANEL_IDS: string[] = HUB_PANELS.map((p) => p.id)
export const HUB_PANEL_BY_ID: Record<string, HubPanel> = Object.fromEntries(
  HUB_PANELS.map((p) => [p.id, p]),
)
export const DEFAULT_PANELS: string[] = HUB_PANELS.filter((p) => p.defaultOn !== false).map(
  (p) => p.id,
)

export const panelLabel = (id: string) => HUB_PANEL_BY_ID[id]?.label ?? id

/** The visible panels, chunked into the rows they will be drawn on, each row
 *  carrying the grid template its panels' weights ask for.
 *
 *  Two per row, except a `full` panel which takes one on its own. Keeping the
 *  template per row rather than on the container is what lets Product
 *  Performance stay 1.7 : 1 against its neighbour while every other row stays
 *  an even split — one `grid-cols-2` for the whole page could not. */
export function panelRows(visible: string[]): Array<{ template: string; ids: string[] }> {
  const rows: Array<{ template: string; ids: string[] }> = []
  let row: string[] = []

  const flush = () => {
    if (!row.length) return
    rows.push({ template: templateFor(row), ids: row })
    row = []
  }

  for (const id of visible) {
    const panel = HUB_PANEL_BY_ID[id]
    if (!panel) continue
    if (panel.full) {
      flush()
      rows.push({ template: 'minmax(0,1fr)', ids: [id] })
      continue
    }
    row.push(id)
    if (row.length === 2) flush()
  }
  flush()
  return rows
}

function templateFor(ids: string[]): string {
  // A lone panel on the last row stretches, rather than leaving a hole beside
  // it: a half-width card with empty space to its right reads as a chart that
  // failed to load.
  if (ids.length === 1) return 'minmax(0,1fr)'
  return ids.map((id) => `minmax(0,${HUB_PANEL_BY_ID[id]?.weight ?? 1}fr)`).join(' ')
}

// --- what the reader chose last time ----------------------------------------
//
// The same guarded, per-browser memory the KPI deck uses (kpiDeckState.ts):
// storage can be absent, disabled or throw, and the answer is then "the
// defaults". An unknown id — a chart since renamed or removed — is dropped
// rather than kept, so a stale preference cannot blank a row.

const STORAGE_KEY = 'insights-hub.charts.visible'

export function readVisiblePanels(): string[] {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY)
    if (!raw) return [...DEFAULT_PANELS]
    const parsed: unknown = JSON.parse(raw)
    if (!Array.isArray(parsed)) return [...DEFAULT_PANELS]
    const kept = parsed.filter((id): id is string => typeof id === 'string' && id in HUB_PANEL_BY_ID)
    // An empty list is a legitimate choice — every chart hidden — but a
    // corrupted one is not, and the two are indistinguishable from the array
    // alone. A list that kept nothing of what it held is treated as corrupt.
    return kept.length === 0 && parsed.length > 0 ? [...DEFAULT_PANELS] : kept
  } catch {
    return [...DEFAULT_PANELS]
  }
}

export function writeVisiblePanels(ids: string[]) {
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(ids))
  } catch {
    /* A remembered preference is a convenience, not a requirement. */
  }
}
