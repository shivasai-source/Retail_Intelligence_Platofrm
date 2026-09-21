import type { ReactNode } from 'react'

/** THE SUBSET OF MARKDOWN THE ANALYST ACTUALLY WRITES — bold, bullet lists,
 *  and pipe tables. Rendered to real elements.
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
      <strong key={`${keyPrefix}-b${i}`} className="font-bold text-ink-primary tabular-nums">
        {piece}
      </strong>
    ) : (
      <span key={`${keyPrefix}-t${i}`}>{piece}</span>
    ),
  )
}

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
        <div key={`tbl-${i}`} className="my-2 overflow-x-auto">
          <table className="w-full border-collapse text-[13px]">
            <thead>
              <tr>
                {head.map((h, hi) => (
                  <th
                    key={hi}
                    className={`border-b border-border-default px-2 py-1.5 font-semibold text-ink-muted ${
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
                <tr key={ri} className="border-b border-border-subtle last:border-0">
                  {row.map((c, ci) => (
                    <td
                      key={ci}
                      className={`px-2 py-1.5 ${
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

    // --- bullet list ---
    if (/^\s*[-*]\s+/.test(line)) {
      const items: string[] = []
      while (i < lines.length && /^\s*[-*]\s+/.test(lines[i])) {
        items.push(lines[i].replace(/^\s*[-*]\s+/, ''))
        i++
      }
      blocks.push(
        <ul key={`ul-${i}`} className="my-1.5 list-disc space-y-1 pl-4.5 marker:text-ink-disabled">
          {items.map((item, ii) => (
            <li key={ii}>{inline(item, `li${ii}`)}</li>
          ))}
        </ul>,
      )
      continue
    }

    // --- paragraph: consecutive non-structural lines ---
    const para: string[] = []
    while (
      i < lines.length &&
      lines[i].trim() &&
      !isTableRow(lines[i]) &&
      !/^\s*[-*]\s+/.test(lines[i])
    ) {
      para.push(lines[i])
      i++
    }
    blocks.push(
      <p key={`p-${i}`} className="my-1 first:mt-0 last:mb-0">
        {inline(para.join(' '), `p${i}`)}
      </p>,
    )
  }

  return <>{blocks}</>
}
