import type { ReactNode } from 'react'

/** THE SUBSET OF MARKDOWN THE ANALYST ACTUALLY WRITES — bold, headings,
 *  bullet and numbered lists, and pipe tables. Rendered to real elements.
 *
 *  Why not a markdown library: this app carries five runtime dependencies on
 *  purpose, and a parser plus a sanitiser is a large amount of new surface for
 *  three constructs. Why not `dangerouslySetInnerHTML` with a regex: the text
 *  is model output — untrusted by construction — and building HTML from it is
 *  the one thing that turns a wrong answer into an injected script. Everything
 *  below produces React elements, so the content can only ever be text.
 *
 *  Anything unrecognised falls through as a plain paragraph, which is the right
 *  failure: the reader sees the sentence the model wrote, just without the
 *  formatting.
 */

/** `**bold**` -> <strong>. Splitting on the delimiter keeps this a text
 *  operation: the odd-indexed pieces are the emphasised ones. */
function inline(text: string, keyPrefix: string): ReactNode[] {
  return text.split('**').map((piece, i) =>
    i % 2 === 1 ? (
      // The figures that answer the question. Tabular numerals so a column of
      // them lines up, which is most of what this bold is used for.
      <strong key={`${keyPrefix}-b${i}`} className="font-medium text-ink-primary tabular-nums">
        {piece}
      </strong>
    ) : (
      <span key={`${keyPrefix}-t${i}`}>{piece}</span>
    ),
  )
}

/** `## Why this happened` -> a heading. The model writes them and they used
 *  to fall through to the paragraph branch, which printed the hashes and left
 *  the heading reading exactly like the sentence under it. All levels render
 *  the same: this app has ONE body size (see index.css), so a heading is
 *  marked by weight and spacing rather than by size, and a model's choice
 *  between ## and ### is not a design decision. */
const headingOf = (line: string): string | null => {
  const m = /^\s*#{1,6}\s+(.*?)\s*#*\s*$/.exec(line)
  return m && m[1] ? m[1] : null
}

/** `1. First` / `2) Second` -> an ordered list, for the same reason: a ranked
 *  answer rendered as one run-on paragraph with the numbers still in it. */
const isOrdered = (line: string) => /^\s*\d{1,2}[.)]\s+/.test(line)
const isBulleted = (line: string) => /^\s*[-*]\s+/.test(line)

const isTableRow = (line: string) => line.trim().startsWith('|') && line.trim().endsWith('|')

/** `| a | b |` -> ["a", "b"]. The leading and trailing pipes produce empty
 *  edge cells, which are dropped. */
const cells = (line: string) =>
  line.trim().slice(1, -1).split('|').map((c) => c.trim())

/** A table's separator row (`|---|:--:|`) — structure, never rendered. */
const isDivider = (line: string) => /^\|[\s:|-]+\|$/.test(line.trim())

export function AnalystMarkdown({ text }: { text: string }) {
  const lines = text.split('\n')
  const blocks: ReactNode[] = []
  let i = 0

  while (i < lines.length) {
    const line = lines[i]

    if (!line.trim()) {
      i++
      continue
    }

    // --- table ---
    if (isTableRow(line) && i + 1 < lines.length && isDivider(lines[i + 1])) {
      const head = cells(line)
      const body: string[][] = []
      i += 2
      while (i < lines.length && isTableRow(lines[i])) {
        if (!isDivider(lines[i])) body.push(cells(lines[i]))
        i++
      }
      blocks.push(
        // A ranking can be longer than the panel is wide; it scrolls on its own
        // rather than widening the thread.
        <div key={`tbl-${i}`} className="my-2.5 overflow-x-auto rounded-[10px] border border-border-subtle">
          <table className="w-full border-collapse text-sm">
            <thead>
              <tr>
                {head.map((h, hi) => (
                  <th
                    key={hi}
                    className={`border-b border-border-default bg-surface-page px-2.5 py-2 text-xs font-medium text-ink-secondary ${
                      hi === 0 ? 'text-left' : 'text-right'
                    }`}
                  >
                    {inline(h, `h${hi}`)}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {body.map((row, ri) => (
                <tr key={ri} className="border-b border-border-subtle last:border-0 even:bg-surface-page/60">
                  {row.map((c, ci) => (
                    <td
                      key={ci}
                      className={`px-2.5 py-2 ${
                        ci === 0 ? 'text-left text-ink-primary' : 'text-right tabular-nums text-ink-primary'
                      }`}
                    >
                      {inline(c, `c${ri}-${ci}`)}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>,
      )
      continue
    }

    // --- heading ---
    const heading = headingOf(line)
    if (heading) {
      blocks.push(
        <div key={`h-${i}`} className="mb-1 mt-3.5 font-medium text-ink-primary first:mt-0">
          {inline(heading, `h${i}`)}
        </div>,
      )
      i++
      continue
    }

    // --- bullet list ---
    if (isBulleted(line)) {
      const items: string[] = []
      while (i < lines.length && isBulleted(lines[i])) {
        items.push(lines[i].replace(/^\s*[-*]\s+/, ''))
        i++
      }
      blocks.push(
        <ul key={`ul-${i}`} className="my-2 list-disc space-y-1.5 pl-5 marker:text-brand-violet">
          {items.map((item, ii) => (
            <li key={ii}>{inline(item, `li${ii}`)}</li>
          ))}
        </ul>,
      )
      continue
    }

    // --- numbered list ---
    if (isOrdered(line)) {
      const items: string[] = []
      while (i < lines.length && isOrdered(lines[i])) {
        items.push(lines[i].replace(/^\s*\d{1,2}[.)]\s+/, ''))
        i++
      }
      blocks.push(
        <ol key={`ol-${i}`} className="my-2 list-decimal space-y-1.5 pl-5 marker:text-brand-violet">
          {items.map((item, ii) => (
            <li key={ii}>{inline(item, `li${ii}`)}</li>
          ))}
        </ol>,
      )
      continue
    }

    // --- paragraph: consecutive non-structural lines ---
    const para: string[] = []
    while (
      i < lines.length &&
      lines[i].trim() &&
      !isTableRow(lines[i]) &&
      !isBulleted(lines[i]) &&
      !isOrdered(lines[i]) &&
      !headingOf(lines[i])
    ) {
      para.push(lines[i])
      i++
    }
    blocks.push(
      <p key={`p-${i}`} className="my-2 first:mt-0 last:mb-0">
        {inline(para.join(' '), `p${i}`)}
      </p>,
    )
  }

  return <>{blocks}</>
}
