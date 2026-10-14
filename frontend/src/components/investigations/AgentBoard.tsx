import { useEffect, useState } from 'react'
import { Icon, type IconName } from '../../icons'
import { Card, Spinner } from '../ui'
import { PLAIN_DESC } from './AccelList'
import type { Accelerator, NodeDetail } from '../../types/orchestration'
import type { AgentFinding } from '../../types/agentRun'

// THE AGENTS ON THIS INVESTIGATION, as one panel in two panes: the agents
// listed down the left, and everything about the selected one on the right --
// what it does, where it is, its confidence, what it found with the figures
// behind it, and which root causes it supports. Replaces the radial
// Investigation Graph and the pop-up each node opened.

type LiveState = 'queued' | 'progress' | 'done'

const STATUS: Record<LiveState, { dot: string; pill: string; label: string }> = {
  done: { dot: 'bg-status-success', pill: 'bg-status-success-bg text-[var(--pill-success-ink)]', label: 'Completed' },
  progress: { dot: 'bg-status-warning', pill: 'bg-status-warning-bg text-[var(--pill-warning-ink)]', label: 'Running' },
  queued: { dot: 'bg-border-strong', pill: 'bg-surface-muted text-ink-muted', label: 'Queued' },
}

export function AgentBoard({
  accelerators,
  statusOverride,
  findings,
  details,
  rootCauses,
}: {
  accelerators: Accelerator[]
  statusOverride?: Record<string, LiveState>
  /** Each agent's finding, by key. */
  findings: AgentFinding[]
  /** Each agent's figures (the bars it drew), by key. */
  details: Record<string, NodeDetail>
  /** The root causes, each with the agent keys that support it. */
  rootCauses: { cause: string; agents: string[]; share_pct?: number; recommendation?: string }[]
}) {
  const stateOf = (a: Accelerator): LiveState => statusOverride?.[a.key] ?? (a.status === 'Completed' ? 'done' : 'progress')
  const contribution = (key: string) => findings.find((f) => f.key === key)?.contribution_pct ?? null
  // Largest contribution first; agents still running keep their place.
  accelerators = [...accelerators].sort((a, b) => (contribution(b.key) ?? -1) - (contribution(a.key) ?? -1))
  const done = accelerators.filter((a) => stateOf(a) === 'done').length
  const [selected, setSelected] = useState<string | null>(accelerators[0]?.key ?? null)
  useEffect(() => {
    if (!selected || !accelerators.some((a) => a.key === selected)) setSelected(accelerators[0]?.key ?? null)
  }, [accelerators, selected])

  const agent = accelerators.find((a) => a.key === selected) ?? accelerators[0]
  if (!agent) return null
  const finding = findings.find((f) => f.key === agent.key)
  const detail = details[agent.key]
  const state = stateOf(agent)
  const supports = rootCauses.map((rc, i) => ({ ...rc, n: i + 1 })).filter((rc) => rc.agents.includes(agent.key))
  const evidence = detail?.evidence ?? finding?.evidence

  return (
    <Card className="fade-in mb-4 overflow-hidden">
      {/* HEADER */}
      <div className="flex items-center justify-between gap-3 border-b border-border-subtle px-5 py-3.5">
        <h2 className="flex items-center gap-2 text-md font-medium text-ink-primary [&_svg]:h-4 [&_svg]:w-4">
          <Icon name="cpu" className="text-brand-violet" /> Specialist agents
        </h2>
        <span className="text-sm text-ink-muted [font-variant-numeric:tabular-nums]">
          {done} of {accelerators.length} completed
        </span>
      </div>

      <div className="grid grid-cols-[280px_minmax(0,1fr)] @max-[900px]:grid-cols-1">
        {/* THE AGENTS */}
        <nav
          aria-label="Agents"
          className="border-r border-border-subtle bg-surface-muted p-2 @max-[900px]:border-b @max-[900px]:border-r-0"
        >
          {accelerators.map((a) => {
            const st = stateOf(a)
            const on = a.key === agent.key
            return (
              <button
                key={a.key}
                type="button"
                onClick={() => setSelected(a.key)}
                aria-current={on ? 'true' : undefined}
                className={`relative mb-0.5 flex w-full cursor-pointer items-center gap-3 rounded-[var(--r-md)] px-3 py-2.5 text-left transition-colors last:mb-0 ${
                  on ? 'bg-surface-card shadow-[var(--shadow-sm)]' : 'hover:bg-surface-card'
                }`}
              >
                {on && <span className="absolute inset-y-2 left-0 w-[3px] rounded-full bg-brand-violet" />}
                <span
                  className={`grid h-8 w-8 shrink-0 place-items-center rounded-[var(--r-md)] [&_svg]:h-4 [&_svg]:w-4 ${
                    on ? 'bg-brand-violet text-white' : 'bg-brand-violet-50 text-brand-violet'
                  }`}
                >
                  <Icon name={a.icon as IconName} />
                </span>
                <span className={`min-w-0 flex-1 truncate text-base ${on ? 'font-medium text-ink-primary' : 'text-ink-secondary'}`}>{a.name}</span>
                {contribution(a.key) != null && (
                  <span className="shrink-0 text-sm [font-variant-numeric:tabular-nums]" title="Contribution to total score">
                    {contribution(a.key)}%
                  </span>
                )}
                <span className={`h-2 w-2 shrink-0 rounded-full ${STATUS[st].dot}`} title={STATUS[st].label} />
              </button>
            )
          })}
        </nav>

        {/* THE SELECTED AGENT */}
        <div key={agent.key} className="fade-in min-w-0 p-5">
          <div className="flex items-start gap-3">
            <span className="grid h-11 w-11 shrink-0 place-items-center rounded-[var(--r-lg)] bg-brand-violet-50 text-brand-violet [&_svg]:h-5 [&_svg]:w-5">
              <Icon name={agent.icon as IconName} />
            </span>
            <div className="min-w-0 flex-1">
              <div className="text-lg font-normal text-ink-primary">{agent.name}</div>
              <div className="mt-1 flex flex-wrap items-center gap-1.5">
                <span className={`inline-flex items-center gap-1 rounded-[var(--r-pill)] px-2 py-0.5 text-xs font-medium ${STATUS[state].pill}`}>
                  {state === 'done' && <Icon name="checkCircle" className="h-3 w-3" />}
                  {state === 'progress' && <Spinner />}
                  {state === 'queued' && <Icon name="clock" className="h-3 w-3" />}
                  {STATUS[state].label}
                </span>
                {finding && (
                  <span className="rounded-[var(--r-pill)] bg-surface-muted px-2 py-0.5 text-xs font-medium text-ink-secondary [font-variant-numeric:tabular-nums]">
                    {finding.confidence}% confidence
                  </span>
                )}
              </div>
            </div>
          </div>

          <p className="mt-3 text-base leading-[1.6] text-ink-muted">{PLAIN_DESC[agent.key] ?? agent.desc}</p>

          {finding?.contribution_pct != null && (
            <div className="mt-4 rounded-[var(--r-md)] border border-border-subtle p-[10px_14px]">
              <div className="flex items-baseline justify-between gap-3">
                <span className="text-sm text-ink-muted">Contribution to total score</span>
                <span className="text-sm font-medium text-ink-primary [font-variant-numeric:tabular-nums]">{finding.contribution_pct}%</span>
              </div>
              <span className="mt-1.5 block h-1.5 overflow-hidden rounded-full bg-surface-muted">
                <span
                  className="block h-full rounded-full bg-brand-violet [animation:npGrow_700ms_var(--ease-out)_forwards]"
                  style={{ width: `${finding.contribution_pct}%` }}
                />
              </span>
            </div>
          )}

          {finding ? (
            <>
              <Divider label="What it found" />
              <div className="text-md font-medium leading-[1.45] text-ink-primary">{detail?.headline ?? finding.headline}</div>
              <p className="mt-1.5 text-base leading-[1.65] text-ink-secondary">{detail?.body ?? finding.body}</p>

              {detail?.viz?.type === 'bars' && detail.viz.items.length > 0 && <Bars items={detail.viz.items} unit={detail.viz.unit} />}

              {evidence && (
                <div className="mt-3 flex items-start gap-2 rounded-[var(--r-md)] bg-surface-muted px-3 py-2 text-sm leading-[1.5] text-ink-muted [&_svg]:mt-0.5 [&_svg]:h-3.5 [&_svg]:w-3.5 [&_svg]:shrink-0">
                  <Icon name="info" />
                  <span>{evidence}</span>
                </div>
              )}

              {supports.length > 0 && (
                <>
                  <Divider label={supports.length === 1 ? 'Its root cause' : 'Root causes it supports'} />
                  <ul className="flex flex-col gap-2">
                    {supports.map((rc) => (
                      <li key={rc.n} className="flex items-start gap-2.5 text-base leading-[1.5] text-ink-primary">
                        <span className="mt-[1px] inline-flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-brand-violet text-xs font-medium text-white">
                          {rc.n}
                        </span>
                        <span className="min-w-0 flex-1">
                          {rc.cause}
                          {rc.recommendation && (
                            <span className="mt-1 block text-ink-secondary">Recommendation: {rc.recommendation}</span>
                          )}
                        </span>
                        {rc.share_pct != null && (
                          <span className="shrink-0 text-sm font-medium text-brand-violet [font-variant-numeric:tabular-nums]">{rc.share_pct}%</span>
                        )}
                      </li>
                    ))}
                  </ul>
                </>
              )}
            </>
          ) : (
            <div className="mt-4 rounded-[var(--r-md)] border border-dashed border-border-default px-4 py-6 text-center text-base text-ink-muted">
              {state === 'done' ? 'This agent reported nothing material for this question.' : state === 'progress' ? 'Analysing…' : 'Waiting to start.'}
            </div>
          )}
        </div>
      </div>
    </Card>
  )
}

function Divider({ label }: { label: string }) {
  return (
    <div className="mb-2.5 mt-5 flex items-center gap-3">
      <span className="text-sm font-medium text-ink-muted">{label}</span>
      <span className="h-px flex-1 bg-border-subtle" />
    </div>
  )
}

/** The figures behind the finding, one labelled bar each. */
function Bars({ items, unit }: { items: { label: string; value: number; tone?: string }[]; unit: string }) {
  const max = Math.max(...items.map((it) => it.value)) * 1.1 || 1
  return (
    <div className="mt-4 flex flex-col gap-2.5 rounded-[var(--r-lg)] border border-border-subtle p-3.5">
      {items.map((it, i) => (
        <div key={it.label}>
          <div className="flex items-baseline justify-between gap-3">
            <span className="min-w-0 truncate text-sm text-ink-secondary" title={it.label}>
              {it.label}
            </span>
            <span className="shrink-0 text-sm font-medium text-ink-primary [font-variant-numeric:tabular-nums]">
              {it.value.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
            </span>
          </div>
          <span className="mt-1 block h-2 overflow-hidden rounded-full bg-surface-muted">
            <span
              className="block h-full rounded-full [animation:npGrow_700ms_var(--ease-out)_forwards]"
              style={{
                width: `${((Math.max(0, it.value) / max) * 100).toFixed(2)}%`,
                background: it.tone === 'muted' ? 'var(--border-strong)' : i === 0 ? 'var(--brand-violet)' : 'var(--brand-blue)',
                animationDelay: `${80 + i * 90}ms`,
              }}
            />
          </span>
        </div>
      ))}
      {unit && <div className="text-right text-xs text-ink-muted">{unit}</div>}
    </div>
  )
}
