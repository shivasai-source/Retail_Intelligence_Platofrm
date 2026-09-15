/** Insights Hub label policy: calendar years, never fiscal shorthand.
 *
 *  The API renders periods through `app/tpo/formatting.fiscal_label`, which
 *  emits "F24" / "F25" — the label the analytical pages were specified with.
 *  The Insights Hub is specified the other way: plain 2024 / 2025.
 *
 *  Rewriting on the way out rather than changing `fiscal_label` is deliberate.
 *  That function is shared by every page's `_meta`, its KPI deltas and its
 *  period axis; changing it would silently relabel Investigations, Promotion
 *  Intelligence, Simulation Studio and Decision Center too. This keeps the
 *  change where it was asked for.
 *
 *  Only the display string moves. The underlying year stays 2024 / 2025 in the
 *  store, the query string and the engine — nothing here feeds a calculation.
 */

/** "F25 (Annual)" -> "2025 (Annual)", "W01 F25" -> "W01 2025", "vs F24" ->
 *  "vs 2024". Any other text is returned untouched. */
export function calendarYear(text: string): string
export function calendarYear(text: undefined): undefined
export function calendarYear(text: string | undefined): string | undefined
export function calendarYear(text: string | undefined): string | undefined {
  if (!text) return text
  // Two digits only, so a real four-digit year in the same string is left
  // alone. 20xx is the dataset's century and the only one it can express.
  //
  // "All Time" is the API's label for an unconstrained period. The Command
  // Center calls that selection "All Years" in its own control, and the
  // subtitle must not contradict the dropdown the user just used.
  return text
    .replace(/\bF(\d{2})\b/g, (_, yy: string) => `20${yy}`)
    .replace(/\bAll Time\b/g, 'All Years')
}
