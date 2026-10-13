/** Round axis ticks between `lo` and `hi`: a 1 / 2 / 2.5 / 5 step at the
 *  right magnitude, about five of them. Shared by the studio's charts so the
 *  two never label an axis differently. */
export function niceTicks(lo: number, hi: number): number[] {
  const span = Math.max(1e-9, hi - lo)
  const rough = span / 5
  const magnitude = 10 ** Math.floor(Math.log10(rough))
  const step = [1, 2, 2.5, 5, 10].map((m) => m * magnitude).find((s) => s >= rough) ?? magnitude
  const first = Math.ceil(lo / step) * step
  const out: number[] = []
  for (let v = first; v <= hi + step * 0.001; v += step) out.push(Number(v.toFixed(10)))
  return out
}
