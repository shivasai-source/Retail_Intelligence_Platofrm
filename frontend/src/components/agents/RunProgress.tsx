import { useEffect, useState } from 'react'
import { Icon } from '../../icons'

/** Shared mechanics for "an agent run is in progress" on Investigations and
 *  Promotion Intelligence.
 *
 *  WHAT IS SHARED IS THE MACHINERY, NOT THE MEANING. Both pages run a pipeline
 *  of phases, some with real milestones and some that can only be estimated, so
 *  the curve, the clock, the rail and the bar live here. What each phase IS,
 *  how wide its band is and when it hands over are the page's own — an
 *  investigation fans six specialists out in parallel, Promotion Intelligence
 *  computes a fact base and then runs two agents in sequence, and flattening
 *  those into one abstraction would describe neither.
 *
 *  The honesty rule both pages inherit: real milestones always win, estimates
 *  only fill the gaps between them, and nothing reaches 100% — the card
 *  unmounts when the run finishes, so a full bar could only ever mean done. */

/** Fraction complete for `elapsed` against `estimate`, as an asymptotic curve.
 *
 *  The same shape `InstallProgress` uses for the connectors, and for the same
 *  reason: a bar that reaches its end and stops reads as "finished, but
 *  frozen", which is worse than no bar. This one decelerates, so overrunning an
 *  estimate looks like slow progress — which is what it is. */
export const eased = (elapsed: number, estimate: number) =>
  estimate <= 0 ? 0 : 1 - Math.exp(-2 * (elapsed / estimate))

/** Nothing ever reaches 1. See the rule above. */
export const CEILING = 0.97

export function fmtElapsed(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000))
  return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${String(s % 60).padStart(2, '0')}s`
}

/** A ticking clock, plus one that restarts on every real event.
 *
 *  `stepKey` changes whenever something actually happened — a phase handover, a
 *  specialist reporting — so each estimate is measured from the last real event
 *  rather than from the start of the run.
 *
 *  THE STEP CLOCK IS ADJUSTED DURING RENDER, NOT IN AN EFFECT. An effect runs
 *  after the frame is committed, so the render that first saw a new milestone
 *  still measured against the PREVIOUS step's clock — one already long overrun
 *  — and the estimate was at full stretch against a further target. The bar
 *  jumped forward and then fell back: 51.8% -> 61.8% -> 52.0% on every
 *  specialist that reported. Setting it here re-renders before anything is
 *  painted, so the intermediate value never exists. */
export function useRunClock(stepKey: string): { now: number; stepElapsed: number } {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 250)
    return () => clearInterval(id)
  }, [])

  const [step, setStep] = useState(() => ({ key: stepKey, at: Date.now() }))
  if (step.key !== stepKey) setStep({ key: stepKey, at: Date.now() })

  return { now, stepElapsed: now - step.at }
}

export interface RunPhase {
  key: string
  label: string
}

/** The steps of the pipeline, so the wait has a shape the reader can see. */
export function PhaseRail({ phases, current }: { phases: readonly RunPhase[]; current: string }) {
  const index = phases.findIndex((p) => p.key === current)
  return (
    <div className="flex items-center gap-1.5">
      {phases.map((phase, i) => {
        const state = i < index ? 'done' : i === index ? 'active' : 'pending'
        return (
          <div key={phase.key} className="flex items-center gap-1.5">
            {i > 0 && <span aria-hidden className="h-px w-3 bg-border-strong" />}
            <span
              className={`inline-flex items-center gap-1 text-xs font-medium ${
                state === 'done'
                  ? 'text-status-success'
                  : state === 'active'
                    ? 'text-brand-violet'
                    : 'text-ink-disabled'
              }`}
            >
              {state === 'done' ? (
                <Icon name="check" className="h-3 w-3" />
              ) : (
                <span
                  className={`inline-block h-1.5 w-1.5 rounded-full ${
                    state === 'active'
                      ? 'animate-[pulseDot_1.2s_ease-in-out_infinite] bg-brand-violet motion-reduce:animate-none'
                      : 'bg-border-strong'
                  }`}
                />
              )}
              {phase.label}
            </span>
          </div>
        )
      })}
    </div>
  )
}

/** The bar. The sheen carries no information — it says the run is alive, which
 *  a bar sitting between two milestones cannot say on its own. */
export function ProgressTrack({ pct, label }: { pct: number; label: string }) {
  return (
    <div
      role="progressbar"
      aria-valuenow={pct}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-label={label}
      className="h-1.5 overflow-hidden rounded-full bg-surface-muted"
    >
      <div
        className="relative h-full overflow-hidden rounded-full bg-brand-violet transition-[width] duration-500 ease-out"
        style={{ width: `${pct}%` }}
      >
        <span
          aria-hidden
          className="absolute inset-0 bg-[linear-gradient(90deg,transparent,rgba(255,255,255,0.5),transparent)] bg-[length:200%_100%] animate-[shimmer_1.8s_linear_infinite] motion-reduce:hidden"
        />
      </div>
    </div>
  )
}
