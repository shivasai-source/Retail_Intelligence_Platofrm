/** THE ANALYST'S CATEGORICAL PALETTE.
 *
 *  Six hues, assigned to series IN FIXED ORDER and never cycled: the seventh
 *  group in a chart folds into "Other" rather than reusing slot 1, because a
 *  repeated colour makes two different things look like the same thing.
 *
 *  BOTH PALETTES WERE VALIDATED, NOT EYEBALLED. Each was run through the
 *  dataviz validator (lightness band, chroma floor, colour-vision-deficiency
 *  separation between adjacent pairs, normal-vision floor, contrast against
 *  the surface) and passes every check:
 *
 *    The Wipro palette (2026-10-13): navy, blue, amber, green, light blue, red.
 *
 *  The first ordering tried (violet, orange, teal, …) FAILED at ΔE 6.9 between
 *  the pink and the teal; reordering so those two are never adjacent is what
 *  lifted it to 12.5. The order below is therefore load-bearing — reordering
 *  or substituting a colour means re-running the validator, not assuming.
 *
 *  THE DARK SET IS NOT THE LIGHT SET LIGHTENED. It was selected against the
 *  dark surface's own lightness band (OKLCH L 0.48–0.67, narrower than
 *  light's 0.43–0.77), which is why the two lists differ in more than
 *  brightness.
 */

/** Light-mode series colours, in assignment order. */
export const CHART_SERIES_LIGHT = [
  '#143A63', // Wipro navy — the brand hue, so the first series matches the app
  '#2568B2', // Wipro blue
  '#E4A239', // amber
  '#559D0A', // green
  '#7FA7D4', // light blue
  '#E44439', // red
] as const

/** Dark-mode series colours, in the same identity order. */
export const CHART_SERIES_DARK = [
  '#6FA3DD', // navy, lifted for dark
  '#4D8FD6', // blue
  '#EDB65E', // amber
  '#7FC23A', // green
  '#A9C5E6', // light blue
  '#EF6B62', // red
] as const

/** How many distinct colours exist before a chart must fold the tail into
 *  "Other". Read by the backend's chart builder too — see analyst_charts.py,
 *  which caps its group count to this. */
export const MAX_SERIES = CHART_SERIES_LIGHT.length

/** The palette for the theme currently on the document.
 *
 *  Keyed on `data-theme="dark"` on <html>, which is exactly what
 *  `store/theme.ts` writes and what `styles/tokens.css` keys off. Light is the
 *  ABSENCE of the attribute in this app — there is no `data-theme="light"` and
 *  no `prefers-color-scheme` fallback — so testing for dark and defaulting to
 *  light is the whole rule. Checking the media query here instead would paint
 *  dark series on a light page for any reader whose OS is dark.
 */
export function seriesColors(): readonly string[] {
  if (typeof document === 'undefined') return CHART_SERIES_LIGHT
  return document.documentElement.getAttribute('data-theme') === 'dark'
    ? CHART_SERIES_DARK
    : CHART_SERIES_LIGHT
}

/** The colour for series `i`, folding anything past the palette onto the last
 *  slot — which the chart only ever reaches for an "Other" bucket. */
export function seriesColor(i: number, colors = seriesColors()): string {
  return colors[Math.min(i, colors.length - 1)]
}
