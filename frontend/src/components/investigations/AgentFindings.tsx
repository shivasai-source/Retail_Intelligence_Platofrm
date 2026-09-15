import { Icon } from '../../icons'
import { Card, CardHeader, Pill } from '../ui'

/** THE SYNTHESIS, as one card in three registers.
 *
 *  It sits UNDER the business-question card, not above it: the question and
 *  its scope are what was asked, the findings are the answer, and reading them
 *  in that order is how a post-mortem reads. (It used to render first, before
 *  the page even knew whether it had a workspace to show, which put the answer
 *  above the question it answered.)
 *
 *  The summary is prose; the root cause and the recommended actions are each
 *  boxed in their own tint so the eye can find "why" and "what now" without
 *  reading the paragraph — violet for the cause, the platform's success tint
 *  for the actions. Both are the agents' own words; nothing is rephrased here.
 *
 *  `id` is the scroll target the progress strip's "View Insights Summary" jumps
 *  to, so the summary is reached rather than rendered a second time. */
export function AgentFindings({
  summary,
  rootCause,
  recommendations,
  confidence,
  id,
}: {
  summary: string
  rootCause: string
  recommendations: string[]
  confidence: number
  id?: string
}) {
  return (
    <div id={id} className="scroll-mt-6">
      <Card className="fade-in mb-4">
        <CardHeader
          title={
            <span className="flex items-center gap-1.5">
              <Icon name="sparkles" className="h-5 w-5 text-brand-violet" /> Agent Findings
            </span>
          }
          actions={<Pill tone="violet">{confidence}% confidence</Pill>}
        />
        <div className="flex flex-col gap-3 p-5 pt-3.5">
          <p className="text-md leading-[1.65] text-ink-secondary">{summary}</p>

          <div className="rounded-[var(--r-md)] border border-[rgba(124,92,255,0.2)] bg-brand-violet-50 p-[12px_14px]">
            <div className="flex items-center gap-1.5 text-xs font-bold uppercase tracking-[0.06em] text-brand-violet">
              <Icon name="target" className="h-3.5 w-3.5" /> Root cause
            </div>
            <div className="mt-1.5 text-md font-semibold leading-[1.5] text-ink-primary">{rootCause}</div>
          </div>

          {recommendations.length > 0 && (
            <div className="rounded-[var(--r-md)] border border-[rgba(16,185,129,0.25)] bg-status-success-bg p-[12px_14px]">
              <div className="flex items-center gap-1.5 text-xs font-bold uppercase tracking-[0.06em] text-[#047857]">
                <Icon name="checkCircle" className="h-3.5 w-3.5" /> Recommended actions
              </div>
              <ol className="mt-2 flex flex-col gap-2">
                {recommendations.map((r, i) => (
                  <li key={i} className="flex items-start gap-2.5 text-base leading-[1.55] text-ink-primary">
                    <span className="mt-[1px] inline-flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-white text-xs font-bold text-[#047857] shadow-[0_0_0_1px_rgba(16,185,129,0.35)]">
                      {i + 1}
                    </span>
                    <span>{r}</span>
                  </li>
                ))}
              </ol>
            </div>
          )}
        </div>
      </Card>
    </div>
  )
}
