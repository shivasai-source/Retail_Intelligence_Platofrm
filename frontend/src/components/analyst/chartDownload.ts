/** DOWNLOADING A CHART — as data (CSV) or as a picture (PNG).
 *
 *  WHY CSV IS THE PRIMARY FORMAT. A reader who wants a chart in a deck wants
 *  the numbers more often than the pixels: they paste them into a sheet, or
 *  into their own template. CSV also survives every downstream tool, where a
 *  PNG of a chart is a dead end the moment a figure needs to change.
 *
 *  WHY THE PNG IS RASTERISED FROM THE LIVE SVG, and what that costs. The chart
 *  on screen is SVG that inherits its colours from CSS custom properties on
 *  :root. Serialising that markup alone produces a picture with NO styling —
 *  black on transparent, or nothing at all — because the custom properties do
 *  not travel with the element. So `svgToPng` resolves every paint to a literal
 *  colour before serialising, and paints an explicit background. That is the
 *  whole reason this is thirty lines rather than three.
 */

/** Kick off a browser download for a blob, then release the object URL.
 *
 *  The revoke is deferred rather than immediate: Safari has historically
 *  cancelled an in-flight download when its URL was revoked synchronously.
 */
function saveBlob(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  document.body.appendChild(a)
  a.click()
  a.remove()
  setTimeout(() => URL.revokeObjectURL(url), 10_000)
}

/** A filename stem from a chart title: lowercase, no punctuation that a file
 *  system or a shell would object to. */
export function slugify(title: string | undefined, fallback = 'chart'): string {
  const base = (title ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60)
  return base || fallback
}

/** One CSV field, quoted per RFC 4180.
 *
 *  Always quoting — rather than only when a comma appears — keeps a label like
 *  `1,200–1,400` (which a histogram bin genuinely produces) from splitting
 *  into two columns, and costs nothing a spreadsheet will notice.
 */
function csvField(value: string | number): string {
  return `"${String(value).replace(/"/g, '""')}"`
}

export interface CsvTable {
  headers: string[]
  rows: (string | number)[][]
}

/** Save a table as CSV.
 *
 *  A BOM leads the file because Excel on Windows otherwise reads UTF-8 as the
 *  system codepage and renders ₹ as mojibake — which, for a rupee dashboard,
 *  makes every exported figure look broken.
 */
export function downloadCsv(table: CsvTable, filename: string) {
  const lines = [
    table.headers.map(csvField).join(','),
    ...table.rows.map((row) => row.map(csvField).join(',')),
  ]
  const blob = new Blob(['﻿' + lines.join('\r\n')], {
    type: 'text/csv;charset=utf-8',
  })
  saveBlob(blob, `${filename}.csv`)
}

/** CSS custom properties resolve to nothing once an SVG leaves the document,
 *  so every paint is frozen to a literal colour first. `getComputedStyle` is
 *  what does the resolving — it returns the used value, with var() already
 *  substituted. */
const PAINT_ATTRS = ['fill', 'stroke', 'stop-color'] as const

function inlinePaints(source: SVGSVGElement, clone: SVGSVGElement) {
  const from = source.querySelectorAll<SVGElement>('*')
  const to = clone.querySelectorAll<SVGElement>('*')
  for (let i = 0; i < from.length && i < to.length; i++) {
    const computed = getComputedStyle(from[i])
    for (const attr of PAINT_ATTRS) {
      const value = computed.getPropertyValue(attr)
      // `none` is meaningful (an unfilled path) and must be preserved; an
      // empty string means the property does not apply to this element.
      if (value && value !== 'none') to[i].setAttribute(attr, value.trim())
      else if (value === 'none') to[i].setAttribute(attr, 'none')
    }
    const weight = computed.getPropertyValue('stroke-width')
    if (weight) to[i].setAttribute('stroke-width', weight.trim())
  }
}

/** Rasterise a live SVG element to a PNG and save it.
 *
 *  `scale` is 2 by default so the result is legible when dropped into a deck
 *  at full width rather than looking soft next to native slide text.
 */
export async function downloadSvgPng(
  svg: SVGSVGElement,
  filename: string,
  { scale = 2, background = '#ffffff' }: { scale?: number; background?: string } = {},
): Promise<void> {
  const box = svg.getBoundingClientRect()
  const width = Math.max(1, Math.round(box.width))
  const height = Math.max(1, Math.round(box.height))

  const clone = svg.cloneNode(true) as SVGSVGElement
  inlinePaints(svg, clone)
  // An SVG without explicit dimensions rasterises at an implementation-defined
  // size — 300x150 in some engines — regardless of how it looked on screen.
  clone.setAttribute('width', String(width))
  clone.setAttribute('height', String(height))
  clone.setAttribute('xmlns', 'http://www.w3.org/2000/svg')

  const markup = new XMLSerializer().serializeToString(clone)
  // A data: URL, not a blob: URL. Chrome taints a canvas drawn from a blob-URL
  // SVG image in some versions, and a tainted canvas throws on toBlob —
  // turning the download into a silent failure.
  const svgUrl = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(markup)}`

  const image = new Image()
  await new Promise<void>((resolve, reject) => {
    image.onload = () => resolve()
    image.onerror = () => reject(new Error('could not rasterise the chart'))
    image.src = svgUrl
  })

  const canvas = document.createElement('canvas')
  canvas.width = width * scale
  canvas.height = height * scale
  const ctx = canvas.getContext('2d')
  if (!ctx) throw new Error('could not rasterise the chart')
  // An explicit ground, because a transparent PNG dropped on a dark slide
  // renders dark text on dark and reads as an empty box.
  ctx.fillStyle = background
  ctx.fillRect(0, 0, canvas.width, canvas.height)
  ctx.drawImage(image, 0, 0, canvas.width, canvas.height)

  const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/png'))
  if (!blob) throw new Error('could not rasterise the chart')
  saveBlob(blob, `${filename}.png`)
}
