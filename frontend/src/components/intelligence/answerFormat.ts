// Ported from js/pages/intelligence.js's `_parseSegments` — parses a markdown-lite
// string with [g]..[/g] (good), [r]..[/r] (bad), [n]..[/n] (neutral) tone markers and
// \n line breaks into flat segments the renderer/streamer can consume.
export type Tone = 'good' | 'bad' | 'neutral' | null

export interface Segment {
  text: string
  tone: Tone
}

const TOKENS: { open: string; close: string; tone: Tone }[] = [
  { open: '[g]', close: '[/g]', tone: 'good' },
  { open: '[r]', close: '[/r]', tone: 'bad' },
  { open: '[n]', close: '[/n]', tone: 'neutral' },
]

export function parseSegments(text: string): Segment[] {
  const out: Segment[] = []
  let i = 0
  let tone: Tone = null
  let buf = ''
  const flush = () => {
    if (buf) {
      out.push({ text: buf, tone })
      buf = ''
    }
  }
  while (i < text.length) {
    if (text[i] === '\n') {
      flush()
      out.push({ text: '\n', tone: null })
      i++
      continue
    }
    let matched = false
    for (const t of TOKENS) {
      if (text.substr(i, t.close.length) === t.close && tone === t.tone) {
        flush()
        tone = null
        i += t.close.length
        matched = true
        break
      }
      if (text.substr(i, t.open.length) === t.open && tone === null) {
        flush()
        tone = t.tone
        i += t.open.length
        matched = true
        break
      }
    }
    if (matched) continue
    buf += text[i++]
  }
  flush()
  return out
}

// Ported from .ai-answer-body .ai-key(-good|-bad|-neutral) — an underline wash
// rather than a solid highlight, via a two-stop gradient background.
//
// ONE STYLE FOR EVERY TONE. The tone is the model's own [g]/[r]/[n] marker, and
// it marked "100% of trade spend at this low ROI" as good — so the green wash
// told the reader a failure was a success. The highlight now says only "this
// figure matters"; whether it is good or bad is the sentence's job.
export function toneClass(tone: Tone): string {
  if (!tone) return ''
  return 'rounded-[3px] px-0.5 font-bold text-ink-primary bg-[linear-gradient(180deg,rgba(15,23,42,0)_60%,rgba(15,23,42,0.07)_60%)]'
}
