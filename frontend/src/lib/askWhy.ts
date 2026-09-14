// The Command Center -> Investigations handoff.
//
// "Ask why" used to navigate and drop everything it knew — the alert's
// promotion, product, channel, week and ROI were all discarded, so the
// Investigations page had nothing to work with and fell back to a hardcoded
// sample question. This carries the alert's context across so the
// investigation actually asks about the thing you clicked.

export interface AskWhyIntent {
  /** THIS CLICK, not this question.
   *
   *  The Investigations page has to tell a fresh hand-off from a re-render
   *  of one it already ran, and it used to do that by comparing the question
   *  text. Text is not identity: clicking the same alert a second time — to
   *  get back to it after typing something else into the box — composed the
   *  same sentence, so the page recognised it as already-run and did
   *  nothing at all. The click looked ignored, because it was. Every call
   *  mints a new id, so a hand-off is always a hand-off. */
  id: string
  /** The composed natural-language question. */
  question: string
  /** Where it came from, shown on the Investigations page. */
  sourceLabel: string
  /** Run the RCA immediately rather than waiting for the user to press enter. */
  autoRun: boolean
  /** THE SCOPE, not a re-reading of the sentence.
   *
   *  The validated FilterState the source drilled in with, narrowed by the
   *  identifiers it genuinely carried. The question names the promotion,
   *  product and channel in prose, but prose is what the planning agent had
   *  to guess from before: it read "Dryer Sheets 240 ct" and scoped the run
   *  to the whole brand form, so Promotion Intelligence reported a wider
   *  population than the alert that was clicked. Sending the codes pins the
   *  run, and every page reading its stored scope, to the same event.
   *
   *  Absent for a question the user simply typed — there is no scope to
   *  send, and the planner deriving one is then the honest behaviour. */
  scope?: Record<string, unknown>
}

/** Shape of the fields we use — both risk alerts and underperforming rows
 *  carry these, under slightly different names. */
export interface AskWhySource {
  promotion?: string | null
  product?: string | null
  channel?: string | null
  period?: string | null
  roi_multiple?: number | null
  vs_target?: number | null
  trade_spend_display?: string | null
  title?: string | null
  description?: string | null
  primary_cause?: string | null
}

/** Turn "2025-W36" into something a question can contain naturally. */
function readablePeriod(period?: string | null): string {
  if (!period) return ''
  const m = /^(\d{4})-W(\d{1,2})$/.exec(period)
  return m ? `week ${Number(m[2])} of ${m[1]}` : period
}

/**
 * Compose the question from whatever the alert actually carries, rather than a
 * fixed template — a row with no product shouldn't produce "for undefined".
 */
/** One per hand-off. Date.now() alone repeats inside a millisecond, which is
 *  well within reach of two clicks dispatched from the same handler. */
let handoffSeq = 0

export function buildAskWhyIntent(source: AskWhySource): AskWhyIntent {
  const subject = source.promotion?.trim()
  const qualifiers: string[] = []
  if (source.product) qualifiers.push(`on ${source.product}`)
  if (source.channel) qualifiers.push(`in ${source.channel}`)
  const period = readablePeriod(source.period)
  if (period) qualifiers.push(`during ${period}`)

  const roi =
    typeof source.roi_multiple === 'number'
      ? `It returned ${source.roi_multiple.toFixed(2)} ROI${
          typeof source.vs_target === 'number' ? ` — ${Math.abs(source.vs_target).toFixed(2)} below target` : ''
        }.`
      : ''

  let question: string
  if (subject) {
    question = `Why did ${subject} underperform${qualifiers.length ? ' ' + qualifiers.join(' ') : ''}?`
  } else if (source.title) {
    // Risk alerts phrase their own title, e.g. "ROI below target — New Year Savings 25"
    question = `Why is this happening: ${source.title}?`
  } else {
    question = 'Why is this promotion underperforming?'
  }

  if (roi) question += ` ${roi}`
  if (source.primary_cause) question += ` The reported cause is "${source.primary_cause}" — is that the real driver?`

  const sourceLabel = subject
    ? `Risk alert · ${subject}${source.channel ? ` · ${source.channel}` : ''}`
    : source.title
      ? `Risk alert · ${source.title}`
      : 'Risk alert'

  return { id: `${Date.now().toString(36)}-${++handoffSeq}`, question, sourceLabel, autoRun: true }
}

/** Router state key, so Investigations can tell a handoff from a normal visit. */
export const ASK_WHY_STATE_KEY = 'askWhy'
