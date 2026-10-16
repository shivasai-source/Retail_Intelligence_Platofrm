/** A rupee amount, spelled the way the rest of the app spells one.
 *
 *  THE SAME STEPS THE BACKEND USES. `app/tpo/formatting.money` renders every
 *  KPI the API ships a `display_value` for -- the Insights Hub's cards, the
 *  investigation scope strip, the levers -- as Cr above a crore, L above a
 *  lakh, K above a thousand, and the plain grouped rupees below that. A page
 *  that formats a RAW number client-side has to follow the same rule or the
 *  same figure reads two ways on two pages, which is exactly what happened:
 *  one event's ₹29,18,518 of trade spend was "₹0.29 Cr" on Investigations and
 *  "₹29.19 L" on Promotion Intelligence.
 *
 *  NOT A REPLACEMENT FOR `fmtCr`. That formatter (components/promotionIntelligence/
 *  panels.tsx) deliberately refuses to abbreviate below 10 lakh, because a
 *  dense COLUMN of neighbouring lakh values collapses into repeated strings
 *  and the table stops showing the differences it exists to show. This is for
 *  a SINGLE headline figure on a card, where there is no column to collapse
 *  and agreeing with the rest of the app is what matters.
 *
 *  Base currency only. The currency toggle converts server-side; nothing here
 *  touches a rate. */
const STEPS: [number, string][] = [
  [1e7, 'Cr'],
  [1e5, 'L'],
  [1e3, 'K'],
]

export function fmtMoney(value: number | null | undefined, dp = 2): string {
  if (value == null || !Number.isFinite(value)) return '—'
  const sign = value < 0 ? '-' : ''
  const magnitude = Math.abs(value)
  for (const [size, suffix] of STEPS) {
    if (magnitude >= size) return `${sign}₹${(magnitude / size).toFixed(dp)} ${suffix}`
  }
  return `${sign}₹${Math.round(magnitude).toLocaleString('en-IN')}`
}
