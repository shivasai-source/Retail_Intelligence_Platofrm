import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { AppShell } from '../components/layout/AppShell'
import { Button, Card, CardBody, CardHeader, Pill, Spinner, Textarea, useConfirm, useToast } from '../components/ui'
import { ExportReportButton } from '../components/reports/ExportReportButton'
import { RoiStatusPill } from '../components/studio/RoiStatusPill'
import { Icon } from '../icons'
import {
  useBoardDecisions,
  useClearBoardDecisions,
  useLoadBoardDecision,
  useSaveBoardDecision,
  type BoardDecisionSummary,
} from '../hooks/useDecisionBoard'
import { MAX_SCENARIOS, useDecisionScenarios, type DecisionScenario, type ScenarioKpi } from '../store/decisionScenarios'

/** Decision Center — choose between the scenarios the Simulation Studio sent
 *  here, say why, and keep the decision.
 *
 *  Up to three scenarios sit side by side as cards, with the figures that
 *  decide a promotion — revenue and ROI against the current plan — up front
 *  and the better of each marked. Choosing one, writing the rationale and
 *  saving stores the whole board
 *  (`/api/store/board-decisions`); the history below reopens any saved
 *  decision for review.
 *
 *  NOTHING ON THIS PAGE IS CALCULATED. Every figure is the display string the
 *  studio produced when the scenario was added; "best" is a comparison of the
 *  numbers behind those strings, never a new number. */

/** The two figures a card marks as best across the board, and whether a
 *  higher value is the better one. Revenue is a TOTAL over the window, so it
 *  is ranked only when every scenario runs for the same number of days — a
 *  14-day revenue is not "better" than a 7-day one. ROI is a rate and ranks
 *  regardless. */
const COMPARED: { key: string; higherIsBetter: boolean | null; perWindow: boolean }[] = [
  { key: 'revenue', higherIsBetter: true, perWindow: true },
  { key: 'roi', higherIsBetter: true, perWindow: false },
]

export function Decision() {
  const navigate = useNavigate()
  const confirm = useConfirm()
  const { show } = useToast()
  const scenarios = useDecisionScenarios((s) => s.scenarios)
  const chosenId = useDecisionScenarios((s) => s.chosenId)
  const rationale = useDecisionScenarios((s) => s.rationale)
  const loadedFrom = useDecisionScenarios((s) => s.loadedFrom)
  const remove = useDecisionScenarios((s) => s.remove)
  const clear = useDecisionScenarios((s) => s.clear)
  const choose = useDecisionScenarios((s) => s.choose)
  const setRationale = useDecisionScenarios((s) => s.setRationale)
  const load = useDecisionScenarios((s) => s.load)

  const history = useBoardDecisions()
  const save = useSaveBoardDecision()
  const open = useLoadBoardDecision()
  const clearHistory = useClearBoardDecisions()
  const [savedId, setSavedId] = useState<string | null>(null)

  const slots: (DecisionScenario | null)[] = Array.from({ length: MAX_SCENARIOS }, (_, i) =>
    scenarios.find((s) => s.slot === i + 1) ?? null,
  )
  const chosen = scenarios.find((s) => s.id === chosenId) ?? null
  const best = bestBySlot(scenarios)

  const saveDecision = () => {
    if (!chosen) return
    save.mutate(
      { scenarios, chosen_slot: chosen.slot, rationale },
      {
        onSuccess: (saved) => {
          setSavedId(saved.decision_id)
          show(`Decision saved · Scenario ${chosen.slot}`, { duration: 3000 })
        },
        onError: (e) => show(e.message, { duration: 4000 }),
      },
    )
  }

  const reopen = (id: string) =>
    open.mutate(id, {
      onSuccess: (saved) => {
        load(saved)
        setSavedId(null)
        window.scrollTo({ top: 0, behavior: 'smooth' })
      },
      onError: (e) => show(e.message, { duration: 4000 }),
    })

  const crumbs = [{ label: 'TPO Intelligence' }, { label: 'Decision Center' }]
  const exportScope = () => (chosen ?? scenarios[0])?.scope.filters ?? {}

  return (
    <AppShell activeKey="decision" crumbs={crumbs}>
      <div className="fade-in flex flex-wrap items-center justify-between gap-x-4 gap-y-3">
        <h1 className="flex items-center gap-2 text-2xl font-extrabold tracking-[-0.02em]">
          Decision Center <Icon name="sparkles" className="h-5 w-5 text-brand-violet" />
        </h1>
        <div className="flex items-center gap-2">
          <ExportReportButton
            module="decision-center"
            scope={exportScope}
            options={() => ({ board: { scenarios, chosen_slot: chosen?.slot ?? null, rationale } })}
            currency={(chosen ?? scenarios[0])?.scope.currency}
            disabled={scenarios.length === 0}
            disabledReason="Add a scenario before exporting."
          />
          {scenarios.length > 0 && (
            <Button
              variant="secondary"
              onClick={() =>
                confirm({
                  title: 'Clear the board?',
                  body: 'Saved decisions stay in the history below. The scenarios themselves can be added again from Simulation Studio.',
                  primaryText: 'Clear',
                  onConfirm: clear,
                })
              }
            >
              <Icon name="x" /> <span>Clear</span>
            </Button>
          )}
          <Button variant="secondary" onClick={() => navigate('/simulation')} disabled={scenarios.length >= MAX_SCENARIOS}>
            <Icon name="plus" /> <span>Add scenario</span>
          </Button>
        </div>
      </div>

      {loadedFrom && (
        <div className="mt-3 flex flex-wrap items-center justify-between gap-3 rounded-[var(--r-lg)] border border-brand-violet-100 bg-brand-violet-50 px-4 py-2.5 text-base">
          <span>
            <span className="font-semibold text-brand-violet">Reviewing a saved decision</span>
            <span className="font-medium text-ink-secondary"> · {shortId(loadedFrom)}</span>
          </span>
          <Button variant="secondary" size="sm" onClick={clear}>
            <Icon name="x" /> Start a new board
          </Button>
        </div>
      )}

      {scenarios.length === 0 ? (
        <div className="mt-6 rounded-[var(--r-lg)] border border-dashed border-border-default bg-surface-card px-6 py-14 text-center">
          <div className="text-md font-bold text-ink-primary">No scenarios on the board</div>
          <div className="mt-1 text-base text-ink-secondary">
            Set the levers in Simulation Studio and press <strong className="font-semibold text-ink-secondary">Add to Decision Center</strong>. Up to {MAX_SCENARIOS} at a time.
          </div>
          <Button variant="primary" className="mt-5" onClick={() => navigate('/simulation')}>
            <Icon name="flow" /> Open Simulation Studio
          </Button>
        </div>
      ) : (
        <>
          {/* THE CARDS: one per slot, the deciding figures up front. */}
          <div className="mt-5 grid grid-cols-3 gap-4 @max-[1000px]:grid-cols-1">
            {slots.map((s, i) =>
              s ? (
                <ScenarioCard
                  key={s.id}
                  scenario={s}
                  chosen={s.id === chosenId}
                  bestKeys={best[s.slot] ?? new Set()}
                  onChoose={() => choose(s.id === chosenId ? null : s.id)}
                  onRemove={() => remove(s.id)}
                />
              ) : (
                <button
                  key={`empty-${i}`}
                  type="button"
                  onClick={() => navigate('/simulation')}
                  className="flex min-h-[220px] cursor-pointer flex-col items-center justify-center gap-2 rounded-[var(--r-lg)] border border-dashed border-border-default text-ink-muted transition-colors hover:border-brand-violet hover:text-brand-violet"
                >
                  <Icon name="plus" className="h-5 w-5" />
                  <span className="text-base font-semibold">Scenario {i + 1}</span>
                  <span className="text-sm">Add from Simulation Studio</span>
                </button>
              ),
            )}
          </div>

          {/* THE DECISION: which one, why, and keep it. */}
          <Card className="mt-4">
            <CardHeader
              title="Decision"
              subtitle={chosen ? `Scenario ${chosen.slot} · ${chosen.scope.label}` : 'Choose a scenario above'}
              actions={
                savedId ? (
                  <Pill tone="success" dot>
                    Saved · {shortId(savedId)}
                  </Pill>
                ) : undefined
              }
            />
            <CardBody>
              <div className="grid grid-cols-[1fr_auto] items-end gap-4 @max-[760px]:grid-cols-1">
                <div>
                  <label htmlFor="rationale" className="text-base font-bold text-ink-primary">
                    Rationale
                  </label>
                  <Textarea
                    id="rationale"
                    rows={3}
                    value={rationale}
                    onChange={(e) => setRationale(e.target.value)}
                    placeholder={chosen ? `Why Scenario ${chosen.slot}?` : 'Choose a scenario, then say why.'}
                    disabled={!chosen}
                    className="mt-1.5"
                  />
                </div>
                <Button
                  variant="primary"
                  onClick={saveDecision}
                  disabled={!chosen || save.isPending}
                  title={chosen ? undefined : 'Choose a scenario first'}
                >
                  {save.isPending ? <Spinner /> : <Icon name="checkCircle" />}
                  <span>{save.isPending ? 'Saving…' : 'Save decision'}</span>
                </Button>
              </div>
            </CardBody>
          </Card>
        </>
      )}

      {/* THE HISTORY: every saved decision, newest first. */}
      {(history.data?.decisions.length ?? 0) > 0 && (
        <Card className="mt-4">
          <CardHeader
            title="Saved decisions"
            subtitle={`${history.data!.decisions.length} on record`}
            actions={
              <Button
                variant="ghost"
                size="sm"
                className="!text-ink-muted"
                onClick={() =>
                  confirm({
                    title: 'Clear the decision history?',
                    body: 'Every saved decision is removed. This cannot be undone.',
                    primaryText: 'Clear history',
                    onConfirm: () => clearHistory.mutate(),
                  })
                }
              >
                Clear history
              </Button>
            }
          />
          <ul className="divide-y divide-border-subtle">
            {history.data!.decisions.map((d) => (
              <HistoryRow key={d.decision_id} decision={d} active={d.decision_id === loadedFrom} onOpen={() => reopen(d.decision_id)} />
            ))}
          </ul>
        </Card>
      )}
    </AppShell>
  )
}

// --- pieces ----------------------------------------------------------------

function ScenarioCard({
  scenario,
  chosen,
  bestKeys,
  onChoose,
  onRemove,
}: {
  scenario: DecisionScenario
  chosen: boolean
  bestKeys: Set<string>
  onChoose: () => void
  onRemove: () => void
}) {
  const kpi = (key: string) => scenario.kpis.find((k) => k.key === key)
  const revenue = kpi('revenue')
  const roi = kpi('roi')
  return (
    <div
      className={`relative flex flex-col rounded-[var(--r-lg)] border bg-surface-card p-5 shadow-[var(--shadow-card-soft)] transition-colors ${
        chosen ? 'border-brand-violet ring-2 ring-brand-violet/20' : 'border-border-subtle'
      }`}
    >
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <span className="text-lg font-extrabold text-ink-primary">Scenario {scenario.slot}</span>
            {chosen && <Pill tone="violet">Chosen</Pill>}
          </div>
          {/* The scope in full, up to two lines: which year, channel and
              product this scenario is for is what tells the cards apart. */}
          <div className="mt-1 line-clamp-2 text-base font-semibold leading-[1.45] text-ink-primary [text-wrap:balance]" title={scenario.scope.label}>
            {scenario.scope.label}
          </div>
        </div>
        <button
          type="button"
          onClick={onRemove}
          className="grid h-7 w-7 shrink-0 cursor-pointer place-items-center rounded-full text-ink-muted hover:bg-surface-hover hover:text-ink-primary"
          aria-label={`Remove Scenario ${scenario.slot}`}
          title="Remove"
        >
          <Icon name="x" className="h-4 w-4" />
        </button>
      </div>

      {/* THE THREE LEVERS, EACH NAMED. Bare chips reading "25.00% · 7 days ·
          ₹81.35 L" left the reader to work out which was which. */}
      <div className="mt-4 grid grid-cols-3 gap-2">
        {([['discount', 'Discount'], ['days', 'Days'], ['budget', 'Budget']] as const).map(([k, name]) => {
          const v = kpi(k)
          return v ? (
            <div key={k} className="rounded-[var(--r-md)] border border-border-subtle px-3 py-2">
              <div className="text-xs font-semibold uppercase tracking-[0.05em] text-ink-muted">{name}</div>
              <div className="mt-0.5 truncate text-base font-bold text-ink-primary [font-variant-numeric:tabular-nums]" title={v.value}>
                {v.value}
              </div>
            </div>
          ) : null
        })}
      </div>

      <div className="mb-5 mt-3 grid grid-cols-2 gap-4 rounded-[var(--r-md)] bg-surface-muted p-3.5">
        <Figure label="Revenue" kpi={revenue} best={bestKeys.has('revenue')} />
        <Figure label="ROI" kpi={roi} best={bestKeys.has('roi')} showTone />
      </div>

      {/* Pinned to the card's foot, so the three buttons line up even when one
          card has no change lines and the others do. */}
      <Button variant={chosen ? 'secondary' : 'primary'} className="mt-auto w-full" onClick={onChoose}>
        <Icon name={chosen ? 'check' : 'target'} /> {chosen ? 'Chosen' : 'Choose this scenario'}
      </Button>
    </div>
  )
}

function Figure({ label, kpi, best, showTone }: { label: string; kpi?: ScenarioKpi; best: boolean; showTone?: boolean }) {
  if (!kpi) return null
  return (
    <div className="min-w-0">
      {/* The verdict pill sits beside the label, not after the value, so a
          narrow card never wraps it under the number. */}
      <div className="flex min-h-7 flex-wrap items-center gap-x-2 gap-y-1">
        <span className="flex items-center gap-1.5 text-base font-bold text-ink-secondary">
          {label}
          {best && <Icon name="checkCircle" className="h-3.5 w-3.5 text-status-success" />}
        </span>
        {showTone && kpi.tone && <RoiStatusPill tone={kpi.tone} />}
      </div>
      <div className="mt-1 text-xl font-extrabold tracking-[-0.01em] text-ink-primary [font-variant-numeric:tabular-nums]">{kpi.value}</div>
      <ChangeLine sub={kpi.sub} />
    </div>
  )
}

/** The change against the current plan, split so it never wraps mid-phrase:
 *  the change itself bold in its direction's colour, "vs current plan" on the
 *  line beneath — or "Same as current plan" when nothing moved. The figures
 *  are the studio's own strings; only their sign is read here, for colour. */
function ChangeLine({ sub }: { sub?: string }) {
  if (!sub) return null
  const suffix = ' vs current plan'
  if (!sub.endsWith(suffix)) {
    return <div className="mt-1 text-sm font-medium text-ink-secondary [font-variant-numeric:tabular-nums]">{sub}</div>
  }
  const change = sub.slice(0, -suffix.length).trim()
  const down = /^[-−]/.test(change) || /\([-−]/.test(change)
  const up = !down && (/^\+/.test(change) || /\(\+/.test(change))
  if (!up && !down) {
    return <div className="mt-1.5 text-sm font-bold text-ink-secondary">Same as current plan</div>
  }
  return (
    <div className="mt-1.5 leading-tight">
      <div
        className={`flex items-center gap-1 text-base font-bold [font-variant-numeric:tabular-nums] ${
          up ? 'text-[var(--pill-success-ink)]' : 'text-[var(--pill-danger-ink)]'
        }`}
      >
        <Icon name={up ? 'arrowUp' : 'arrowDown'} className="h-3.5 w-3.5 shrink-0" />
        <span className="truncate" title={change}>{change}</span>
      </div>
      <div className="mt-0.5 text-sm font-bold text-ink-secondary">vs current plan</div>
    </div>
  )
}

function HistoryRow({ decision, active, onOpen }: { decision: BoardDecisionSummary; active: boolean; onOpen: () => void }) {
  const s = decision.summary
  return (
    <li className={`flex flex-wrap items-center justify-between gap-3 px-5 py-3 ${active ? 'bg-brand-violet-50/40' : ''}`}>
      <div className="min-w-0">
        <div className="flex flex-wrap items-center gap-2 text-base">
          <span className="font-bold text-ink-primary">
            {decision.chosen_slot ? `Scenario ${decision.chosen_slot}` : 'No scenario chosen'}
          </span>
          {decision.chosen_label && <span className="font-medium text-ink-secondary">· {decision.chosen_label}</span>}
          {decision.stale && <Pill tone="warning">Data changed since</Pill>}
        </div>
        <div className="mt-1 flex flex-wrap gap-x-3 gap-y-0.5 text-sm text-ink-secondary [font-variant-numeric:tabular-nums]">
          <span>{when(decision.created_at)}</span>
          {s.discount && <span>Discount {s.discount}</span>}
          {s.days && <span>{s.days}</span>}
          {s.revenue && <span>Revenue {s.revenue}</span>}
          {s.roi && <span>ROI {s.roi}</span>}
          <span>{decision.scenario_count} compared</span>
        </div>
        {decision.rationale && <div className="mt-1 line-clamp-2 text-sm italic text-ink-primary">“{decision.rationale}”</div>}
      </div>
      <Button variant="secondary" size="sm" onClick={onOpen} disabled={active}>
        {active ? 'Open' : 'Review'}
      </Button>
    </li>
  )
}

/** Per slot, the keys where that scenario holds the best value. A row with
 *  fewer than two numbers, or a tie, marks nothing. */
function bestBySlot(scenarios: DecisionScenario[]): Record<number, Set<string>> {
  const out: Record<number, Set<string>> = {}
  const sameWindow = new Set(scenarios.map((s) => s.levers.days)).size <= 1
  for (const { key, higherIsBetter, perWindow } of COMPARED) {
    if (higherIsBetter === null) continue
    if (perWindow && !sameWindow) continue
    const values = scenarios
      .map((s) => ({ slot: s.slot, raw: s.kpis.find((k) => k.key === key)?.raw }))
      .filter((v): v is { slot: number; raw: number } => typeof v.raw === 'number')
    if (values.length < 2) continue
    const top = Math.max(...values.map((v) => v.raw))
    const winners = values.filter((v) => v.raw === top)
    if (winners.length !== 1) continue
    ;(out[winners[0].slot] ??= new Set()).add(key)
  }
  return out
}

function shortId(id: string): string {
  return id.replace(/^dec_/, '').slice(0, 8).toUpperCase()
}

function when(iso: string): string {
  const at = new Date(iso)
  return `${at.toLocaleDateString(undefined, { day: '2-digit', month: 'short', year: 'numeric' })} · ${at.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })}`
}
