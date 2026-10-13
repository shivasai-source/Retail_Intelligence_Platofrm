import { EMPTY_SELECTION, usePlannerSelection } from './plannerSelection'

/** Promotion Intelligence → Simulation Studio: the product under investigation.
 *
 *  "Go to Simulation" opens the studio on the investigation's product, in the
 *  channels and regions its scope names, over the investigation's year, and
 *  on the promotion it is about when it names one -- so the studio's current
 *  plan is the population the investigation measured. Returns false when the
 *  scope names no single product; the caller then opens the studio as it is. */
export function carryProductToStudio(scope: Record<string, unknown>, question: string): boolean {
  const list = (v: unknown) => (Array.isArray(v) ? v : v == null || v === '' ? [] : [v]).map(String)
  const products = list(scope.product)
  if (products.length !== 1) return false
  const year = Number(scope.year)
  const hasYear = scope.year != null && Number.isFinite(year)
  usePlannerSelection.getState().carry(
    {
      ...EMPTY_SELECTION,
      products,
      channels: list(scope.channel),
      regions: list(scope.region),
      start: hasYear ? [year, 1] : null,
      end: hasYear ? [year, 53] : null,
    },
    { source: 'intelligence', title: products[0], facts: [question].filter(Boolean) },
  )
  return true
}
