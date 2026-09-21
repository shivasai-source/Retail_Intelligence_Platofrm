import { Link } from 'react-router-dom'
import { Card } from '../ui'
import { toneClass } from './answerFormat'
import { useStreamedAnswer } from './useStreamedAnswer'

// Ported from js/pages/intelligence.js's `.ai-answer-card` block.
//
// THE SOURCE PILLS ARE GONE. Five enterprise systems — SAP S/4HANA, NielsenIQ,
// DMS, Retail Exec, Promotion History — were listed under every answer as the
// systems that fed it, and they were a hardcoded array in this file. This
// analysis reads the project's star schema through the KPI engine; none of
// those connectors is involved, and no provenance of that kind is recorded
// anywhere in the response. The footer now names the specialist agents the RUN
// reports, which is a fact the payload actually carries, and nothing when it
// carries none.
export function AiAnswerCard({
  answer,
  specialists = [],
  streamKey,
}: {
  /** Only what the analysis produced. The old `IntelligenceAnswer` shape also
   *  required `sources` and `specialists` counts, which this card never
   *  rendered and the caller therefore filled with invented numbers. */
  answer: { summary: string; text: string }
  /** Names of the agents that produced the answer, from the run. */
  specialists?: string[]
  streamKey: string
}) {
  const { paragraphs, done } = useStreamedAnswer(answer.text, streamKey)

  return (
    <Card className="fade-in mb-5">
      <div className="flex items-start justify-between gap-3 border-b border-border-subtle p-[16px_20px]">
        {/* The title alone. The question used to sit under it; the hero
            block at the top of the page already carries it in full. */}
        <div className="min-w-0 flex-1">
          <h3 className="text-md font-bold">Investigation Synthesis</h3>
        </div>
        {/* B9 removed the "{confidence}% confidence" badge that stood here.
            It printed an authored 82-87%; nothing in this project computes a
            confidence figure. The synthesis line beside it describes how the
            answer was assembled, which is a property of the run. */}
        <div className="flex flex-wrap items-center gap-3.5 text-sm text-ink-muted">
          <span className="inline-flex items-center gap-1.5 text-ink-secondary">
            <span className="inline-block h-[7px] w-[7px] animate-[aiPulseDot_1.8s_ease-in-out_infinite] rounded-full bg-status-success shadow-[0_0_0_3px_rgba(16,185,129,0.15)]" />
            {answer.summary}
          </span>
        </div>
      </div>

      <div className="min-h-[60px] p-5 text-base leading-[1.65] text-ink-primary">
        {paragraphs.map((runs, pi) => (
          <p key={pi} className="mb-2.5 last:mb-0">
            {runs.map((r, ri) => (r.tone ? <strong key={ri} className={toneClass(r.tone)}>{r.text}</strong> : <span key={ri}>{r.text}</span>))}
            {!done && pi === paragraphs.length - 1 && (
              <span className="ml-0.5 inline-block h-[1em] w-2 animate-[aiCursorBlink_0.85s_steps(2,start)_infinite] rounded-[1px] bg-ink-primary align-text-bottom" />
            )}
          </p>
        ))}
      </div>

      <div className="flex flex-wrap items-center gap-2 border-t border-border-subtle p-[12px_20px]">
        {specialists.map((name) => (
          <span
            key={name}
            className="inline-flex items-center gap-1.5 rounded-full border border-border-subtle bg-surface-card py-[3px] px-2.5 text-xs font-semibold text-ink-secondary shadow-[0_1px_2px_rgba(15,23,42,0.04)]"
          >
            <span className="inline-block h-1.5 w-1.5 shrink-0 rounded-full bg-status-success" />
            {name}
          </span>
        ))}
        <span className="flex-1" />
        <Link to="/investigations" className="text-sm font-semibold text-ink-primary hover:underline">
          View full investigation →
        </Link>
      </div>
    </Card>
  )
}
