/** The AI decision brief — an explanation layer.
 *
 *  Mirrors backend/app/tpo/decision_brief.py.
 *
 *  TEXT, NOT TRUTH. Every field below is prose. Nothing in this file is a
 *  number, a metric, a status or a decision, and nothing on the Decision Center
 *  page reads it for a value — the deterministic `DecisionRecord` remains the
 *  source of truth for every figure on screen. If this whole response were
 *  discarded, not one card would change.
 *
 *  `authoritative` is `false` in every response, and the card says so.
 */

/** The six paragraphs, keyed. Rendered as fixed sections rather than parsed
 *  from prose, so the model cannot introduce a heading of its own. */
export interface DecisionBriefText {
  why_this_scenario: string
  expected_impact: string
  key_evidence: string
  key_risks: string
  unverified: string
  next_action: string
}

export type DecisionBriefKey = keyof DecisionBriefText

export interface DecisionBriefSection {
  key: DecisionBriefKey
  heading: string
}

export interface DecisionBriefResponse {
  brief: DecisionBriefText
  /** Order and headings, supplied by the server so the two cannot drift. */
  sections: DecisionBriefSection[]
  /** The LLM model that produced it. Shown for traceability. */
  model: string
  disclaimer: string
  /** Numbers the model wrote that do NOT appear in the record it was given.
   *  Normally empty. Non-empty shows a caution on the card — it never
   *  suppresses the text, and it never affects a figure on the page. */
  unverified_figures: string[]
  source: string
  /** Always false. The deterministic record is authoritative. */
  authoritative: false
}

export interface DecisionBriefRequest {
  record: unknown
}
