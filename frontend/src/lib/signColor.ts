/** SIGNED FIGURES ARE GREEN OR RED, EVERYWHERE.
 *
 *  Any signed quantity on any page -- "+2.66%", "−₹1.20 Cr", "-0.08",
 *  "+5" -- is green when positive and red when negative, in two ways:
 *
 *  1. An element whose WHOLE text is a signed figure ("+12.03%", a chart's
 *     "-0.75x" tick) is tagged `data-sign="pos"|"neg"`, and index.css colours
 *     it. This also reaches SVG chart labels.
 *  2. A signed figure INSIDE a longer line ("↑ +2.66% vs F24", "ROI −0.08
 *     against target") is coloured through the CSS Custom Highlight API: a
 *     Range over just those characters, registered as the `sign-pos` /
 *     `sign-neg` highlight and styled by `::highlight()` in index.css.
 *
 *  Only attributes and highlight ranges are touched -- never the text or the
 *  node tree -- so React's reconciliation is unaffected.
 */

const FIGURE = String.raw`([+\-−])\s?(?:[₹$€£]\s?)?\d[\d,]*(?:\.\d+)?\s?(?:%|x|×|pp|pts?|bps|Cr|L|K|M|Bn?)?`

/** A whole text that is nothing but a signed figure (an arrow may lead). */
const WHOLE = new RegExp(String.raw`^(?:[↑↓▲▼]\s*)?${FIGURE}$`, 'i')

/** A signed figure inside text. The sign must not follow a letter, digit or
 *  dot, so "2025-W33", "1-5" and "e-commerce" are never read as negatives. */
const INSIDE = new RegExp(String.raw`(?<![\w.])${FIGURE}(?![\w.])`, 'gi')

function signOf(text: string): 'pos' | 'neg' | null {
  const m = WHOLE.exec(text.trim())
  if (!m) return null
  return m[1] === '+' ? 'pos' : 'neg'
}

function tag(el: Element) {
  const sign = signOf(el.textContent ?? '')
  if (sign) {
    if (el.getAttribute('data-sign') !== sign) el.setAttribute('data-sign', sign)
  } else if (el.hasAttribute('data-sign')) {
    el.removeAttribute('data-sign')
  }
}

const canHighlight = typeof CSS !== 'undefined' && 'highlights' in CSS && typeof Highlight !== 'undefined'

function scan(root: Element) {
  const pos: Range[] = []
  const neg: Range[] = []
  const seen = new Set<Element>()
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT)
  let node: Node | null
  while ((node = walker.nextNode())) {
    const el = node.parentElement
    if (!el) continue
    if (!seen.has(el)) {
      seen.add(el)
      tag(el)
    }
    // Whole-element figures are already coloured by their tag; SVG text
    // takes no highlights.
    if (!canHighlight || el.closest('[data-sign]') || el.closest('svg')) continue
    const text = node.textContent ?? ''
    if (!/[+\-−]\s?[₹$€£]?\s?\d/.test(text)) continue
    for (const m of text.matchAll(INSIDE)) {
      const range = document.createRange()
      range.setStart(node, m.index!)
      range.setEnd(node, m.index! + m[0].length)
      ;(m[1] === '+' ? pos : neg).push(range)
    }
  }
  // An element that no longer holds a signed figure loses its colour.
  root.querySelectorAll('[data-sign]').forEach((el) => {
    if (!seen.has(el)) tag(el)
  })
  if (canHighlight) {
    CSS.highlights.set('sign-pos', new Highlight(...pos))
    CSS.highlights.set('sign-neg', new Highlight(...neg))
  }
}

/** Start colouring; call once at boot. Batches DOM changes to one pass a frame. */
export function startSignColor() {
  let queued = false
  const run = () => {
    queued = false
    scan(document.body)
  }
  new MutationObserver(() => {
    if (!queued) {
      queued = true
      requestAnimationFrame(run)
    }
  }).observe(document.body, { childList: true, subtree: true, characterData: true })
  run()
}
