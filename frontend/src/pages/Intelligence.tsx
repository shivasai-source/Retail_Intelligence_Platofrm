import { useEffect, useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { AppShell } from '../components/layout/AppShell'
import {
  Button,
  Card,
  CardHeader,
  Pill,
  Spinner,
  Tabs,
  useToast,
} from '../components/ui'
import { Icon } from '../icons'
import { ApiError } from '../lib/api'
import {
  useCoreFacts,
  useFactSection,
  useIntelligenceContext,
  useIntelligenceRun,
  useStartIntelligenceAnalysis,
  type FactSection,
  type IntelligenceScope,
} from '../hooks/usePromotionIntelligence'
import { AiAnswerCard } from '../components/intelligence/AiAnswerCard'
import { BizQuestionCard } from '../components/investigations/BizQuestionCard'
import {
  CEILING,
  PhaseRail,
  ProgressTrack,
  eased,
  fmtElapsed,
  useRunClock,
} from '../components/agents/RunProgress'
import { SaturationChart } from '../components/promotionIntelligence/SaturationChart'
import {
  DimensionTable,
  DriversPanel,
  KeyInsightsGrid,
  RecommendationsPanel,
  RiskPanel,
  TrendVsTarget,
  fmtCr,
} from '../components/promotionIntelligence/panels'
import { fmtRoi } from '../lib/roi'
import { useChannelNames } from '../hooks/useCommandCenter'
import type { KeyInsight } from '../types/promotionIntelligence'
import { carryProductToStudio } from '../store/studioHandoff'

const TABS = [
  { key: '0', label: 'Synthesis' },
  { key: '1', label: 'Mechanism' },
  { key: '2', label: 'Drivers' },
  // By channel, region and retailer. Was "Where It Bites", which named the
  // question the tab answers but not what a reader would find in it.
  { key: '3', label: 'Channels & Regions' },
  { key: '4', label: 'Portfolio' },
  { key: '5', label: 'Exposure' },
  { key: '6', label: 'Recommendations' },
]

// Core drives Synthesis/Mechanism/Drivers/Recommendations; the heavier
// dimension tables and risk load only when their own tab is opened.
const EXTRA_SECTION: (FactSection | null)[] = [null, null, null, 'dimensions', 'dimensions', 'risk', null]

const MONTHS = ['', 'Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

/** Render the investigation's own filter object as something readable.
 *  Every dimension the scope carries is shown — an omitted one would make the
 *  page look broader than the figures actually are.
 *
 *  `channelNames` comes from `useChannelNames()`, i.e. from dim_channel, and is
 *  NOT a table kept here. The table this replaced had drifted: it mapped CH004
 *  to "B2B" and CH005 to "Travel & Hospitality", which is the two swapped, so
 *  every Travel & Hospitality investigation on this page was labelled B2B and
 *  vice versa. A hand-maintained copy of a dimension is exactly the thing that
 *  goes quietly wrong, so there is no longer one. Codes the roster has not
 *  loaded yet fall back to the raw code rather than to a guess. */
function describeScope(scope: Record<string, unknown>, channelNames: Record<string, string>): string {
  const parts: string[] = []
  const list = (v: unknown) => (Array.isArray(v) ? v : v == null || v === '' ? [] : [v]).map(String)
  list(scope.channel).forEach((c) => parts.push(channelNames[c] ?? c))
  for (const dim of ['region', 'state', 'city', 'retailer', 'category', 'brand', 'promotion_type'] as const) {
    list(scope[dim]).forEach((v) => parts.push(v))
  }
  const month = Number(scope.month)
  if (month >= 1 && month <= 12) parts.push(MONTHS[month])
  if (scope.year) parts.push(`F${String(scope.year).slice(2)}`)
  return parts.length ? parts.join(' · ') : 'whole business'
}

/** Cannibalisation does not appear on this page.
 *
 *  THE KPI CARD WAS ONLY HALF OF IT. Removing the card left the Advisor still
 *  reading `cannibalization_rate` from the facts payload, so it kept writing a
 *  key insight about it — "High cannibalization rate · the cannibalization rate
 *  increased to 11.3%" rendered as a card on Synthesis, which is the same
 *  metric the card was removed for, one component further down.
 *
 *  A DISPLAY FILTER, AND ONLY THAT. The analysis is not altered: the insight
 *  stays in the stored result, the Advisor still produces it, the facts payload
 *  still carries the rate, and every backend calculation — the Cannibalization
 *  Agent, its graph node, the RCA finding, the KPI engine — is untouched. This
 *  page simply does not render it. Cannibalisation is measured by another
 *  specialist and reported where that specialist reports: in the investigation.
 *
 *  MATCHED ON THE STEM, NOT ON A SENTENCE. `KeyInsight` carries no category or
 *  type field to key off (see types/promotionIntelligence.ts), so the subject
 *  has to be read from the text — and the text is written fresh by a model on
 *  every run, so today's exact wording is not something to depend on. The stem
 *  covers both spellings and every inflection the Advisor has produced or
 *  might: "High cannibalization rate", "Cannibalization increased",
 *  "Potential cannibalisation", "cannibalized volume". It is also specific:
 *  nothing about "loss", "risk", "sales" or "performance" matches it, so an
 *  insight on another subject is never caught by accident.
 *
 *  ALL THREE RENDERED FIELDS ARE READ. A card shows its title, its impact line
 *  and its detail; the rate quoted in any one of them would be the figure this
 *  page is not reporting, whatever the heading above it says. */
const CANNIBALIZATION = /cannibali[sz]/i

function withoutCannibalization(insights: KeyInsight[]): KeyInsight[] {
  return insights.filter((i) => !CANNIBALIZATION.test(`${i.title} ${i.impact} ${i.detail}`))
}

function SectionLoading({ loading }: { loading: boolean }) {
  return (
    <div className="grid min-h-[220px] place-items-center gap-3 text-center text-base text-ink-muted">
      {loading ? (
        <>
          <Spinner className="h-5 w-5" />
          Computing this breakdown — the KPI engine runs once per group, so the first load takes a moment.
        </>
      ) : (
        'No data for this scope.'
      )}
    </div>
  )
}

/** Shown when no investigation has been run — this page has nothing to deepen. */
function NoInvestigation() {
  return (
    <Card className="fade-in mt-6">
      <div className="grid place-items-center gap-3 p-7 text-center">
        <div className="grid h-12 w-12 place-items-center rounded-xl bg-brand-violet-50 text-brand-violet">
          <Icon name="sparkles" className="h-6 w-6" />
        </div>
        <h2 className="text-lg font-extrabold">Start with an investigation</h2>
        <p className="max-w-[460px] text-base leading-[1.6] text-ink-muted">
          Promotion Intelligence goes deeper on a root cause an investigation has already found — the mechanism behind it,
          which channels and regions it hits hardest, and what it's worth. It needs an investigation to build on.
        </p>
        <Link
          to="/investigations"
          className="mt-1 inline-flex items-center gap-2 rounded-[var(--r-md)] bg-brand-violet px-4 py-2 text-base font-semibold text-white"
        >
          <Icon name="search" className="h-4 w-4" /> Run an investigation
        </Link>
      </div>
    </Card>
  )
}


const DEEPEN_PHASES = [
  { key: 'compute', label: 'Compute' },
  { key: 'diagnose', label: 'Diagnose' },
  { key: 'advise', label: 'Advise' },
] as const

/** Where each phase hands over, and roughly how long each takes.
 *
 *  COMPUTE GETS THE WIDEST BAND BECAUSE IT IS THE LONGEST, which is the
 *  opposite of what the old card implied. `build_intelligence_facts` runs every
 *  breakdown the Analyst needs — each one a pass of the KPI engine per group —
 *  and takes ~11s warm and far longer cold, all of it before either agent has
 *  anything to read. The card showed two grey dots for that entire stretch and
 *  then two more while the agents ran, so the slowest part of the run was also
 *  the part that looked most like nothing happening. */
const COMPUTE_ENDS_AT = 0.42
const DIAGNOSE_ENDS_AT = 0.74
const COMPUTE_ESTIMATE_MS = 20_000
const ANALYST_ESTIMATE_MS = 16_000
const ADVISOR_ESTIMATE_MS = 16_000

/** Promotion Intelligence working, in the three steps it actually runs.
 *
 *  Unlike an investigation's six specialists, which fan out in parallel, this
 *  pipeline is strictly sequential: compute the fact base, diagnose it, then
 *  advise against the diagnosis. So every handover is a REAL milestone streamed
 *  from the backend — the bar only estimates WITHIN a step, never across one.
 */
function DeepeningState({
  specialists,
  stage,
  startedAt,
}: {
  specialists: { key: string; name: string; desc: string; status: string }[]
  stage?: string
  startedAt?: number
}) {
  const statusOf = (key: string) => specialists.find((s) => s.key === key)?.status
  const analyst = statusOf('analyst')
  const advisor = statusOf('advisor')
  // `analyst: done` and `advisor: queued` is the gap between the two calls; it
  // belongs to Advise, because the diagnosis is finished by then.
  const phase =
    advisor === 'done' || advisor === 'running' || analyst === 'done'
      ? 'advise'
      : analyst === 'running'
        ? 'diagnose'
        : 'compute'

  const { now, stepElapsed } = useRunClock(`${phase}`)

  let fraction: number
  if (phase === 'compute') {
    // Measured from the run, not from mount: computing starts when the run
    // does, so returning to this page mid-run resumes the bar where it belongs.
    const elapsed = startedAt ? now - startedAt : stepElapsed
    fraction = 0.04 + eased(elapsed, COMPUTE_ESTIMATE_MS) * (COMPUTE_ENDS_AT - 0.04)
  } else if (phase === 'diagnose') {
    fraction = COMPUTE_ENDS_AT + eased(stepElapsed, ANALYST_ESTIMATE_MS) * (DIAGNOSE_ENDS_AT - COMPUTE_ENDS_AT)
  } else {
    fraction = DIAGNOSE_ENDS_AT + eased(stepElapsed, ADVISOR_ESTIMATE_MS) * (CEILING - DIAGNOSE_ENDS_AT)
  }
  const pct = Math.round(Math.min(fraction, CEILING) * 100)

  const heading =
    phase === 'compute'
      ? 'Computing the figures the analysis reads…'
      : phase === 'diagnose'
        ? 'Explaining the mechanism behind the root cause…'
        : 'Turning the diagnosis into decisions…'

  return (
    <Card className="fade-in mt-3.5">
      <div className="p-[14px_18px]">
        <div className="flex items-center gap-3">
          <Spinner className="h-4 w-4 text-brand-violet" />
          <div className="min-w-0 flex-1">
            <div className="text-base font-semibold">{heading}</div>
            <div className="mt-0.5 text-sm text-ink-muted">
              Going deeper on the investigation's finding
            </div>
          </div>
          <span className="shrink-0 text-md font-extrabold tabular-nums text-brand-violet">{pct}%</span>
        </div>

        <div className="mt-3">
          <ProgressTrack pct={pct} label={heading} />
        </div>

        <div className="mt-2.5 flex items-center justify-between gap-3">
          <PhaseRail phases={DEEPEN_PHASES} current={phase} />
          <span className="shrink-0 text-xs tabular-nums text-ink-muted">
            {startedAt ? `${fmtElapsed(now - startedAt)} elapsed` : ''}
          </span>
        </div>

        {/* The two agents, with the step each is on. `stage` is carried so a
            run recorded before the phases existed still renders something
            truthful rather than an empty row. */}
        <div className="mt-3 flex flex-col gap-2 border-t border-border-subtle pt-3">
          {specialists.map((s) => (
            <div key={s.key} className="flex items-center gap-2.5">
              <span
                className={`inline-block h-1.5 w-1.5 shrink-0 rounded-full ${
                  s.status === 'done'
                    ? 'bg-status-success'
                    : s.status === 'running'
                      ? 'animate-[pulseDot_1.2s_ease-in-out_infinite] bg-brand-violet motion-reduce:animate-none'
                      : 'bg-border-strong'
                }`}
              />
              <span className="min-w-0 flex-1 truncate text-sm font-semibold">{s.name}</span>
              <span className="truncate text-xs text-ink-muted">{s.desc}</span>
              <span
                className={`shrink-0 text-xs font-semibold ${
                  s.status === 'done'
                    ? 'text-status-success'
                    : s.status === 'running'
                      ? 'text-brand-violet'
                      : 'text-ink-muted'
                }`}
              >
                {s.status === 'done' ? 'Done' : s.status === 'running' ? 'Running' : stage === 'computing' ? 'Waiting for facts' : 'Queued'}
              </span>
            </div>
          ))}
        </div>
      </div>
    </Card>
  )
}

// Promotion Intelligence is the layer BELOW an investigation, not a second
// Insights Hub. It inherits the investigation's question and scope and
// explains the mechanism behind the root cause — which is why there is no
// independent filter bar here: re-scoping is what the Insights Hub is for.
export function Intelligence() {
  const { show } = useToast()
  const channelNames = useChannelNames()

  const [tab, setTab] = useState(0)
  const [runId, setRunId] = useState<string | undefined>(undefined)
  // ALWAYS THE MOST RECENT COMPLETED INVESTIGATION. The header used to carry
  // a "Switch investigation" menu over `context.available`; the scope strip
  // now says which investigation this is, and the newest is the one a reader
  // arriving from the Investigations page has just finished.
  const { data: context, isLoading: ctxLoading } = useIntelligenceContext(undefined)
  const investigation = context?.investigation ?? null

  // Pick up an analysis already run against this investigation, so returning to
  // the page doesn't discard it (or pay for it twice).
  useEffect(() => {
    if (!runId && context?.analysis) setRunId(context.analysis.run_id)
  }, [context, runId])

  // Forward the investigation's scope verbatim. Narrowing it here would show
  // wider figures than the heading claims.
  const scope: IntelligenceScope = investigation?.scope ?? {}

  const { data: facts, isLoading: factsLoading } = useCoreFacts(scope)
  const extraSection = EXTRA_SECTION[tab] ?? null
  const { data: extra, isLoading: extraLoading } = useFactSection(scope, extraSection)

  const startAnalysis = useStartIntelligenceAnalysis()
  const { data: run } = useIntelligenceRun(runId)
  const analysis = run?.status === 'done' ? run.result?.analysis : undefined
  // See withoutCannibalization above — a display filter, nothing else.
  const keyInsights = analysis ? withoutCannibalization(analysis.key_insights) : []
  const result = run?.status === 'done' ? run.result : undefined
  const analysing = run?.status === 'running' || startAnalysis.isPending

  const runAnalysis = () => {
    if (!investigation) return
    setRunId(undefined)
    startAnalysis.mutate(
      { investigation_run_id: investigation.run_id },
      {
        onSuccess: (r) => {
          setRunId(r.id)
          show('Going deeper on the investigation…', { duration: 3000 })
        },
        onError: (e) => show(e instanceof ApiError ? e.message : "Couldn't start the analysis.", { duration: 4000 }),
      },
    )
  }

  /** Open the Simulation Studio on this investigation's product. The studio's
   *  filters take the product (and the channel, category and brand the scope
   *  names) so its dropdowns show only what belongs to that product's data;
   *  clearing the product there brings everything back. A scope with no
   *  single product opens the studio as it is. */
  const navigate = useNavigate()
  const goToSimulation = () => {
    if (!investigation) return
    const carried = carryProductToStudio(investigation.scope, investigation.question)
    show(carried ? 'Opening Simulation Studio on this product' : 'This investigation names no single product — opening Simulation Studio as it is', { duration: 3000 })
    navigate('/simulation')
  }

  const crumbs = [{ label: 'TPO Intelligence' }, { label: 'Promotion Intelligence' }]

  if (ctxLoading) {
    return (
      <AppShell activeKey="intelligence" crumbs={crumbs}>
        <div className="grid min-h-[60vh] place-items-center gap-3 text-base text-ink-muted">
          <Spinner className="h-5 w-5" />
          Loading…
        </div>
      </AppShell>
    )
  }

  if (!investigation) {
    return (
      <AppShell activeKey="intelligence" crumbs={crumbs}>
        <NoInvestigation />
      </AppShell>
    )
  }

  const k = facts?.kpis
  const roi = k?.promotion_roi
  const belowTarget = roi != null && facts != null && roi < facts.target_roi
  // At the ROI's own two decimals, so 1.50 - 0.96 reads 0.54 and not 0.50.
  const gapToTarget = roi != null && facts != null ? Math.round((facts.target_roi - roi) * 100) / 100 : null

  return (
    <AppShell activeKey="intelligence" crumbs={crumbs}>
      <div className="fade-in flex flex-wrap items-end justify-between gap-4">
        <div>
          <div className="flex items-center gap-3">
            <h1 className="flex items-center gap-2 text-2xl font-extrabold tracking-[-0.02em]">
              Promotion Intelligence <Icon name="sparkles" className="h-5 w-5 text-brand-violet" />
            </h1>
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Button variant={result ? 'secondary' : 'primary'} onClick={runAnalysis} disabled={analysing}>
            <Icon name={analysing ? 'clock' : 'sparkles'} />{' '}
            {analysing ? 'Analysing…' : result ? 'Re-run analysis' : 'Go deeper'}
          </Button>
          <Button variant="secondary" onClick={goToSimulation} disabled={!investigation}>
            <Icon name="flow" /> Go to Simulation
          </Button>
        </div>
      </div>

      {/* THE INVESTIGATION BEING DEEPENED, as one block: its question across
          the top with the way back, and beneath it the same scope strip the
          Investigations page draws for this run — its standing against the
          target, the subject the planner resolved the question to, and the
          period, channel and region every specialist ran on. All the run's
          own. The spend and ROI items are left to the KPI row directly
          below, which carries them at headline size. The card carries its
          own bottom margin for that page; cancelled here so the KPI row
          keeps this page's rhythm. */}
      {investigation.subject && investigation.context_chips ? (
        <div className="mt-[14px] [&>*]:mb-0">
          <BizQuestionCard
            subject={investigation.subject}
            contextChips={investigation.context_chips}
            figures={false}
            question={investigation.question}
            questionCaption="Deepening your investigation"
            trailing={
              <Link to="/investigations" className="whitespace-nowrap text-sm font-semibold text-brand-violet">
                ← Back to investigation
              </Link>
            }
          />
        </div>
      ) : (
        <Card className="fade-in mt-[14px]">
          <div className="flex flex-wrap items-start justify-between gap-x-6 gap-y-2 p-[14px_20px]">
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-1.5 text-xs font-bold uppercase tracking-[0.06em] text-brand-violet">
                <Icon name="sparkles" className="h-3.5 w-3.5" /> Deepening your investigation
              </div>
              <div className="mt-1 text-md font-bold leading-[1.45] text-ink-primary">{investigation.question}</div>
            </div>
            <Link to="/investigations" className="shrink-0 self-center whitespace-nowrap text-sm font-semibold text-brand-violet">
              ← Back to investigation
            </Link>
          </div>
        </Card>
      )}

      {/* Scope KPIs — the investigation's own numbers, not a portfolio dashboard */}
      {/* THREE CARDS, NOT FOUR. The fourth was Cannibalisation, and it is gone
          from THIS page only: the Cannibalization Agent, its node on the
          investigation graph, the RCA findings it produces and every backend
          calculation behind it are untouched. Promotion Intelligence explains
          the mechanism behind the investigation's root cause and what the
          scope is worth — a portfolio effect measured by another agent sat
          here as a headline KPI of this one. */}
      {facts && k && (
        <div className="mt-[14px] grid grid-cols-3 gap-3 @max-[900px]:grid-cols-2">
          {[
            {
              label: 'Trade Spend in scope',
              value: fmtCr(k.trade_spend),
              sub: describeScope(investigation.scope, channelNames),
              icon: 'wallet' as const,
              tint: { bg: '#ECE6FF', fg: '#7C5CFF' },
            },
            {
              label: 'Incremental Sales',
              value: fmtCr(k.incremental_sales),
              icon: 'barChart' as const,
              tint: { bg: '#E1ECFF', fg: '#4F7CFF' },
              // No sub-line: the "target is 1.50 × trade spend" it carried
              // restated the ROI card beside it.
              sub: null,
            },
            {
              label: 'Promotion ROI',
              value: fmtRoi(roi),
              icon: 'target' as const,
              tint: { bg: '#ECE6FF', fg: '#6B47FF' },
              sub:
                gapToTarget != null && gapToTarget > 0
                  ? `${fmtRoi(gapToTarget)} below target`
                  : `target ${fmtRoi(facts.target_roi)}`,
              danger: belowTarget,
            },
          ].map((c) => (
            <div
              key={c.label}
              className="flex items-center gap-3 rounded-[var(--r-lg)] border border-border-subtle bg-surface-card p-[14px_16px] shadow-[var(--shadow-card-soft)]"
            >
              {/* THE SAME GLYPH AND TINT the Insights Hub gives this KPI, so
                  the figure is recognisable across the two pages. */}
              <div
                className="grid h-10 w-10 shrink-0 place-items-center rounded-xl [&_svg]:h-[18px] [&_svg]:w-[18px]"
                style={{ background: c.tint.bg, color: c.tint.fg }}
              >
                <Icon name={c.icon} />
              </div>
              <div className="min-w-0">
                {/* THE LABEL LEADS, THE NUMBER FOLLOWS: the name in bold, the
                    value in regular weight, so a reader sees what each card
                    is before how big it is. */}
                <div className="text-sm font-bold text-ink-primary">{c.label}</div>
                <div
                  className={`mt-0.5 text-xl font-normal tabular-nums ${c.danger ? 'text-status-danger' : 'text-ink-primary'}`}
                >
                  {c.value}
                </div>
                {c.sub && (
                  <div className="mt-0.5 truncate text-sm font-medium leading-[1.4] text-ink-secondary" title={c.sub}>{c.sub}</div>
                )}
              </div>
            </div>
          ))}
        </div>
      )}

      {run?.status === 'error' && (
        <div className="mt-3.5 rounded-[var(--r-md)] bg-status-danger-bg p-[10px_14px] text-base text-[#B91C1C]">
          Analysis failed — {run.error}
        </div>
      )}

      {analysing && (
        <DeepeningState specialists={run?.specialists ?? []} stage={run?.stage} startedAt={run?.created_at} />
      )}

      <div className="mt-[14px]">
        <Tabs tabs={TABS} active={String(tab)} onChange={(key) => setTab(Number(key))} />
      </div>

      {factsLoading && !facts ? (
        <SectionLoading loading />
      ) : (
        <div key={tab} className="fade-in flex flex-col gap-4">
          {tab === 0 &&
            (analysis ? (
              <>
                <AiAnswerCard
                  answer={{ summary: analysis.headline, text: analysis.narrative }}
                  // The agents that actually produced this answer, named by the
                  // run itself. The card used to list five enterprise systems
                  // and a 205,920-row source count, both written here as
                  // constants: no such provenance is recorded anywhere, and
                  // the analysis reads the star schema through the KPI engine.
                  specialists={(run?.specialists ?? []).map((sp) => sp.name)}
                  streamKey={run?.id ?? 'none'}
                />
                {keyInsights.length > 0 && <KeyInsightsGrid insights={keyInsights} />}
              </>
            ) : (
              <Card className="fade-in">
                <div className="flex flex-wrap items-center justify-between gap-3 p-[18px_20px]">
                  <div className="min-w-0">
                    <div className="text-base font-bold">Go deeper on this finding</div>
                    <div className="mt-0.5 max-w-[560px] text-base leading-[1.55] text-ink-muted">
                      The investigation found the cause. This layer explains the mechanism behind it, which channels,
                      regions and products it hits hardest, and what it's worth — then recommends what to change.
                    </div>
                  </div>
                  <Button variant="primary" onClick={runAnalysis} disabled={analysing}>
                    <Icon name="sparkles" /> Go deeper
                  </Button>
                </div>
              </Card>
            ))}

          {tab === 1 && facts && (
            <>
              <Card className="fade-in">
                <CardHeader
                  title="Discount Saturation — the mechanism"
                  actions={
                    <div className="flex items-center gap-2">
                      {facts.saturation.monotonic_decline && <Pill tone="danger">ROI falls at every step</Pill>}
                      <Pill tone="success">Optimal {facts.saturation.optimal_range}</Pill>
                    </div>
                  }
                />
                <div className="p-5 pt-3">
                  <SaturationChart curve={facts.saturation} />
                  <p className="mt-3 text-base leading-[1.6] text-ink-secondary">
                    Each point is a real mechanic at its effective discount depth; dot size is share of trade spend.{' '}
                    {facts.saturation.saturation_depth_pct !== null ? (
                      <>
                        ROI drops below the {fmtRoi(facts.saturation.target_roi)} target from{' '}
                        <strong className="text-status-danger">{facts.saturation.saturation_depth_pct}% depth</strong> onward
                        and does not recover.
                      </>
                    ) : (
                      <>No depth in this scope falls below the {fmtRoi(facts.saturation.target_roi)} target.</>
                    )}
                  </p>
                </div>
              </Card>
              <Card className="fade-in">
                <CardHeader
                  title="Incremental Sales vs Target"
                  actions={
                    <Pill tone={facts.trend.months_below_target > 6 ? 'danger' : 'warning'}>
                      {facts.trend.months_below_target} months below
                    </Pill>
                  }
                />
                <div className="p-5 pt-3">
                  <TrendVsTarget trend={facts.trend} />
                </div>
              </Card>
              <DimensionTable title="By Mechanic" rows={facts.by_mechanic} nameHeader="Mechanic" />
            </>
          )}

          {tab === 2 && (
            <Card className="fade-in">
              <CardHeader
                title="Driver Decomposition"
                actions={analysis ? <Pill tone="violet">{analysis.confidence}% confidence</Pill> : undefined}
              />
              <div className="p-5">
                {analysis ? (
                  <>
                    <DriversPanel drivers={analysis.drivers} />
                    {analysis.uncertainties.length > 0 && (
                      <div className="mt-4 rounded-[var(--r-md)] bg-surface-muted p-[12px_14px]">
                        <div className="text-xs font-bold uppercase tracking-[0.06em] text-ink-muted">
                          What this analysis cannot determine
                        </div>
                        <ul className="mt-1.5 flex flex-col gap-1">
                          {analysis.uncertainties.map((u, i) => (
                            <li key={i} className="text-sm leading-[1.5] text-ink-secondary">
                              · {u}
                            </li>
                          ))}
                        </ul>
                      </div>
                    )}
                  </>
                ) : (
                  <div className="py-6 text-center text-base text-ink-muted">
                    Run "Go deeper" to break the root cause into weighted components.
                  </div>
                )}
              </div>
            </Card>
          )}

          {tab === 3 &&
            (extra?.by_channel ? (
              <>
                <DimensionTable title="By Channel" rows={extra.by_channel} nameHeader="Channel" />
                <DimensionTable title="By Region" rows={extra.by_region ?? []} nameHeader="Region" />
                <DimensionTable title="By Retailer" rows={extra.by_retailer ?? []} nameHeader="Retailer" />
              </>
            ) : (
              <SectionLoading loading={extraLoading} />
            ))}

          {tab === 4 &&
            (extra?.by_category ? (
              <>
                <DimensionTable title="By Category" rows={extra.by_category} nameHeader="Category" />
                <DimensionTable title="By Brand" rows={extra.by_brand ?? []} nameHeader="Brand" />
                <DimensionTable title="By Product" rows={extra.by_product ?? []} nameHeader="Product" />
              </>
            ) : (
              <SectionLoading loading={extraLoading} />
            ))}

          {tab === 5 && (extra?.risk ? <RiskPanel risk={extra.risk} /> : <SectionLoading loading={extraLoading} />)}

          {tab === 6 &&
            (result ? (
              <RecommendationsPanel
                recommendations={result.recommendations}
                doNotDo={result.do_not_do}
                combined={result.expected_combined_impact}
              />
            ) : (
              <Card className="fade-in">
                <div className="flex flex-wrap items-center justify-between gap-3 p-[18px_20px]">
                  <div>
                    <div className="text-base font-bold">Recommendations need the deeper analysis</div>
                    <div className="mt-0.5 text-base text-ink-muted">
                      The Advisor turns the diagnosis into actions Simulation can model.
                    </div>
                  </div>
                  <Button variant="primary" onClick={runAnalysis} disabled={analysing}>
                    <Icon name="sparkles" /> {analysing ? 'Analysing…' : 'Go deeper'}
                  </Button>
                </div>
              </Card>
            ))}
        </div>
      )}
    </AppShell>
  )
}
