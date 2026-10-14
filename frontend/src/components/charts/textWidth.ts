/** Every chart label is 15px Inter (see index.css), which averages a little
 *  under 8px per character for the digits, currency signs and capitals that
 *  axis labels are made of. Charts size their margins and tick spacing from
 *  this estimate instead of fixed pixel constants, so long labels such as
 *  "₹120.00 Cr" fit inside the SVG rather than being clipped at its edge. */
export const CHAR_W = 9

/** Estimated rendered width of a 15px chart label, in px. */
export function textW(text: string | number): number {
  return String(text).length * CHAR_W
}

/** Width of the widest label in `labels`, in px (0 for none). */
export function maxTextW(labels: readonly (string | number)[]): number {
  return labels.reduce<number>((m, l) => Math.max(m, textW(l)), 0)
}

/** Average width of mixed-case prose at 15px (names, not figures), used to
 *  decide how many characters of a name fit a column before it is cut. */
export const PROSE_CHAR_W = 8
