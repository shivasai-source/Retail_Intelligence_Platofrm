import { Icon, type IconName } from '../../icons'
import { Card, CardHeader } from '../ui'
import { InfoBlock, InfoPopover } from '../ui/InfoPopover'

/** One root cause and the agents whose findings support it. */
export interface RootCauseView {
  cause: string
  /** Its share of the problem, 0-100; the shares add up to 100. */
  share: number | null
  agents: { key: string; name: string; icon: string }[]
}

/** THE SYNTHESIS: the explanation, the root causes it is built from, and what
 *  to do next.
 *
 *  It sits UNDER the business-question card: the question and its scope are
 *  what was asked, the findings are the answer.
 *
 *  THE EXPLANATION IS WRITTEN FROM THE ROOT CAUSES. The synthesising agent
 *  lists every distinct root cause first -- one per agent, or one shared by the
 *  agents that agree on it -- and then writes the explanation from those
 *  causes alone (agents/pipeline.py). Each cause carries the agents behind it,
 *  so a reader can see who found what. A run recorded before causes were
 *  listed shows one cause per agent, from each agent's own finding.
 *
 *  `id` is the scroll target the progress strip's "View Insights Summary" jumps
 *  to. */
export function AgentFindings({
  summary,
  rootCauses,
  recommendations,
  id,
}: {
  summary: string
  rootCauses: RootCauseView[]
  recommendations: string[]
  id?: string
}) {
  const scored = rootCauses.some((rc) => rc.share !== null)
  return (
    <div id={id} className="scroll-mt-6">
      <Card className="fade-in mb-4">
        <CardHeader
          title={
            <span className="flex items-center gap-1.5">
              <Icon name="sparkles" className="h-5 w-5 text-brand-violet" /> Agent findings
            </span>
          }
        />
        <div className="flex flex-col gap-4 p-5 pt-3.5">
          {/* THE EXPLANATION */}
          <div>
            <SectionLabel icon="file">Explanation</SectionLabel>
            <p className="mt-1.5 text-base leading-[1.65] text-ink-secondary">{summary}</p>
          </div>

          {/* THE ROOT CAUSES, each with the agents behind it */}
          {rootCauses.length > 0 && (
            <div className="rounded-[var(--r-md)] border-l-4 border-brand-violet bg-brand-violet-50 p-[12px_16px]">
              <div className="flex items-center justify-between gap-2">
                <span className="flex items-center gap-1.5 text-sm font-medium text-brand-violet">
                  <Icon name="target" className="h-3.5 w-3.5" /> {rootCauses.length === 1 ? 'Root cause' : 'Root causes'}
                </span>
                <span className="flex items-center gap-1.5 text-xs text-brand-violet/80">
                  {scored ? 'Share of the problem' : `${rootCauses.length} found`}
                  {scored && (
                    <InfoPopover label="How the share is worked out" title="Share of the problem">
                      <InfoBlock label="Per agent">One unit of evidence: its confidence × how directly its finding points at a cause (a loss 1.0, risk 0.9, moderate 0.6, data 0.4, a strong result 0.3)</InfoBlock>
                      <InfoBlock label="Per cause">The units of the agents behind it; an agent behind several causes splits its unit between them</InfoBlock>
                      <InfoBlock label="Shares">Scaled so all causes add up to 100%</InfoBlock>
                    </InfoPopover>
                  )}
                </span>
              </div>
              <ol className="mt-2 flex flex-col divide-y divide-brand-violet/10">
                {rootCauses.map((rc, i) => (
                  <li key={i} className="flex items-start gap-3 py-2.5 first:pt-1 last:pb-0.5">
                    <span className="mt-[1px] inline-flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-brand-violet text-xs font-medium text-white">
                      {i + 1}
                    </span>
                    <div className="min-w-0 flex-1">
                      <div className="flex items-start justify-between gap-4">
                        <div className="text-base font-medium leading-[1.55] text-ink-primary">{rc.cause}</div>
                        {rc.share !== null && (
                          <span className="shrink-0 text-md font-medium text-brand-violet [font-variant-numeric:tabular-nums]">{rc.share}%</span>
                        )}
                      </div>
                      {rc.share !== null && (
                        <span className="mt-1.5 block h-1.5 overflow-hidden rounded-full bg-surface-card">
                          <span
                            className="block h-full rounded-full bg-brand-violet [animation:npGrow_700ms_var(--ease-out)_forwards]"
                            style={{ width: `${rc.share}%`, animationDelay: `${120 + i * 90}ms` }}
                          />
                        </span>
                      )}
                      {rc.agents.length > 0 && (
                        <div className="mt-1.5 flex flex-wrap gap-1.5">
                          {rc.agents.map((a) => (
                            <span
                              key={a.key}
                              className="inline-flex items-center gap-1 rounded-[var(--r-pill)] bg-surface-card px-2 py-0.5 text-xs font-medium text-ink-secondary shadow-[0_0_0_1px_var(--border-subtle)] [&_svg]:h-3 [&_svg]:w-3"
                            >
                              <span className="text-brand-violet">
                                <Icon name={a.icon as IconName} />
                              </span>
                              {a.name}
                            </span>
                          ))}
                        </div>
                      )}
                    </div>
                  </li>
                ))}
              </ol>
            </div>
          )}

          {recommendations.length > 0 && (
            <div className="rounded-[var(--r-md)] border-l-4 border-status-success bg-status-success-bg p-[12px_16px]">
              <div className="flex items-center gap-1.5 text-sm font-medium text-[var(--pill-success-ink)]">
                <Icon name="checkCircle" className="h-3.5 w-3.5" /> Recommended actions
              </div>
              <ol className="mt-2 flex flex-col gap-2">
                {recommendations.map((r, i) => (
                  <li key={i} className="flex items-start gap-2.5 text-base leading-[1.55] text-ink-primary">
                    <span className="mt-[1px] inline-flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-surface-card text-xs font-medium text-[var(--pill-success-ink)] shadow-[0_0_0_1px_var(--status-success)]">
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

function SectionLabel({ icon, children }: { icon: IconName; children: React.ReactNode }) {
  return (
    <span className="flex items-center gap-1.5 text-sm font-medium text-ink-muted [&_svg]:h-3.5 [&_svg]:w-3.5">
      <Icon name={icon} /> {children}
    </span>
  )
}
