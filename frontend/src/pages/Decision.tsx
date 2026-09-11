import { useEffect, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { AppShell } from '../components/layout/AppShell'
import { Button, Card, CardBody, Modal, Spinner } from '../components/ui'
import { InfoPopover } from '../components/ui/InfoPopover'
import { Icon } from '../icons'
import { useDecisionRecord } from '../hooks/useDecision'
import { ApiError } from '../lib/api'
import { useDecisionBriefing } from '../hooks/useBriefing'
import { useDecisionDraftStore } from '../store/decisionDraft'
import { useDecisionCandidateStore } from '../store/decisionCandidates'
import { CandidateBoard } from '../components/decision/CandidateBoard'
import { candidateFromSimulation, scopeLabelFromContext } from '../lib/decisionCandidates'
import { useSavedRefsStore } from '../store/savedRefs'
import { useSaveDecision, useStoredDecision } from '../hooks/useStore'
import { useGenerateReport } from '../hooks/useReportCenter'
import { StrategySection } from '../components/decision/StrategySection'
import { ComparisonSection } from '../components/decision/ComparisonSection'
import { EvidenceSection } from '../components/decision/EvidenceSection'
import { DecisionHistory } from '../components/decision/DecisionHistory'
import { AiDecisionBrief } from '../components/decision/AiDecisionBrief'
import { useDecisionBrief } from '../hooks/useDecisionBrief'
import type { StoredDecision } from '../types/store'
import type { BriefingResponse } from '../types/briefing'
import type { DecisionImpactMetric, DecisionRecord } from '../types/decision'
import type { RiskFinding } from '../types/risk'

/** Governed Promotion Decision Center.
 *
 *  THE LAST STAGE OF THE WORKFLOW, and an assembly rather than a dashboard.
 *  Command Center → RCA → Simulation Studio → here. The page answers one
 *  question: what exactly am I deciding, why was this scenario selected, what
 *  is it expected to do, what is risky about it, and what evidence stands
 *  behind it.
 *
 *  NOTHING ON THIS PAGE IS CALCULATED. Every figure is carried verbatim from
 *  the contract that owns it — the simulation's KPI bands, the measured
 *  baseline, the comparison, the recommendation's reason, the risk findings.
 *  If a number here ever disagrees with the same number in Simulation Studio,
 *  the cause is a bug in the assembly, not a second opinion.
 *
 *  WHAT THIS PAGE USED TO DO. It read `decision.json` and rendered authored
 *  content: an ROI of 2.55 in units Simulation abandoned, a "Data Confidence —
 *  High (89%)", strategy rows for Retailer Incentive and Inventory Allocation
 *  (two levers no dataset in this project supports), a governance panel
 *  reporting "Budget Compliance — Compliant" and "Margin Threshold —
 *  Compliant", and an approval animation announcing that the finance team had
 *  been notified. None of it was connected to anything, and the compliance
 *  claims were made against thresholds the risk work established do not exist.
 *  All of it is gone.
 *
 *  RECOMMENDED IS NOT APPROVED. The record separates four states —
 *  recommended, governed, ready to review, approved — and `approved` is always
 *  false: this project defines no approval criteria, so nothing here can
 *  declare a decision approvable. No approval is executed, no reviewer is
 *  notified and no promotion is written back anywhere.
 *
 *  SAVED IS REAL. A saved decision goes to the server's store, which mints the
 *  id and appends the version. It survives a reload, it is retrievable by id,
 *  and it carries the fingerprint of the dataset it was computed against.
 */
export function Decision() {
  const carriedDraft = useDecisionDraftStore((s) => s.draft)
  const clearDraft = useDecisionDraftStore((s) => s.clear)

  // ARRIVE AT THE TOP OF THE PAGE. "Open Decision Center" sits near the bottom
  // of Simulation Studio, and a client-side route change keeps the document's
  // scroll offset — so walking over here landed the reader somewhere in the
  // middle of the evidence, on a page whose whole point is to be read from the
  // top. Mount only: reopening a stored decision from the history list must not
  // yank the page away from the list that was just clicked.
  useEffect(() => {
    window.scrollTo(0, 0)
  }, [])

  // --- the candidate board -------------------------------------------------
  //
  // WHICH RECORD IS BELOW THE BOARD. Selecting a candidate that carries a
  // decision draft assembles ITS record; the draft Simulation Studio carried
  // here is the fallback, which is exactly what this page did before the board
  // existed. One `draft` variable feeds the effect, the export and the retry,
  // so the three cannot end up describing different scenarios.
  const candidates = useDecisionCandidateStore((s) => s.candidates)
  const selectedCandidateId = useDecisionCandidateStore((s) => s.selectedId)
  const addCandidate = useDecisionCandidateStore((s) => s.add)
  const selectedCandidate = candidates.find((c) => c.id === selectedCandidateId) ?? null
  const draft = selectedCandidate?.draft ?? carriedDraft

  // A scenario carried here by "Open Decision Center" JOINS THE BOARD. Without
  // this it would render its record and be invisible to the comparison — the
  // one scenario the user explicitly walked over here would be the only one
  // missing from the list of scenarios under consideration.
  useEffect(() => {
    if (!carriedDraft) return
    addCandidate(
      candidateFromSimulation({
        scenarioId: carriedDraft.scenarioId,
        name: carriedDraft.scenarioName,
        simulation: carriedDraft.simulation,
        risk: carriedDraft.risk,
        // The SCOPE context, which lives on the baseline the draft carried —
        // `draft.context` is the investigation context (who is asking, about
        // what) and names no dimensions. Without a baseline the simulation's
        // own period is what is honestly known.
        scopeLabel: carriedDraft.baseline
          ? scopeLabelFromContext(carriedDraft.baseline.context)
          : carriedDraft.simulation.scope.period,
        draft: carriedDraft,
      }),
    )
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [carriedDraft?.signature])
  const record = useDecisionRecord()
  const briefing = useDecisionBriefing()
  /** The AI explanation. NEVER called on mount — see `generateAiBrief`. */
  const aiBrief = useDecisionBrief()

  // --- durable storage -----------------------------------------------------
  const savedDecisionId = useSavedRefsStore((s) => s.decisionId)
  const savedInvestigationId = useSavedRefsStore((s) => s.investigationId)
  const savedScenarioId = useSavedRefsStore((s) => s.scenarioId)
  const rememberDecision = useSavedRefsStore((s) => s.rememberDecision)
  const forgetDecision = useSavedRefsStore((s) => s.forgetDecision)
  const saveDecision = useSaveDecision()

  /** A decision the user explicitly opened from the history list. It outranks
   *  everything else on the page: asking for DC-000123 must show DC-000123,
   *  even with a fresh scenario carried here. */
  const [openedId, setOpenedId] = useState<string | null>(null)

  /** Open a stored decision, and drop any explanation of the previous one.
   *
   *  A brief describes ONE record. Leaving the last one on screen under a
   *  different decision's numbers would be the most misleading state this page
   *  could reach — prose that reads as an explanation of figures it has never
   *  seen. The same reset happens when a new scenario is carried here. */
  const openStoredDecision = (id: string) => {
    aiBrief.reset()
    setOpenedId(id)
  }

  /** With nothing carried here, fall back to the last decision THIS browser
   *  stored. The id is a pointer; the record itself comes from the server, so
   *  a cleared cache loses the shortcut and not the decision. */
  const lookupId = openedId ?? (draft ? null : savedDecisionId)
  const stored = useStoredDecision(lookupId)
  const viewingStored = Boolean(lookupId && stored.data)

  const requested = useRef<string | null>(null)
  const navigate = useNavigate()

  /** The six payloads the record is assembled from, in one place.
   *
   *  The effect below, the Retry button and the report export all need exactly
   *  this shape, and three hand-written copies of it is three chances for one
   *  of them to quietly drop `comparison` or `baseline`. */
  const assembleRequest = (from: NonNullable<typeof draft>) => ({
    context: from.context,
    simulation: from.simulation,
    recommendation: from.recommendation,
    risk: from.risk,
    weekly: from.weekly ?? undefined,
    comparison: from.comparison ?? undefined,
    baseline: from.baseline ?? undefined,
  })

  useEffect(() => {
    if (!draft) {
      requested.current = null
      record.reset()
      return
    }
    if (requested.current === draft.signature) return
    requested.current = draft.signature
    // A brief explains ONE record. Carrying a new scenario here must drop the
    // previous explanation rather than leave it sitting under different
    // numbers, which would be the most misleading state this page could reach.
    aiBrief.reset()
    record.mutate(assembleRequest(draft))
    // THE GUARD MUST NOT SURVIVE THIS EFFECT BEING TORN DOWN.
    //
    // This is the bug that left the page on "Building your decision record…"
    // forever. React's StrictMode mounts, unmounts and remounts on the first
    // mount, and react-query drops a mutation's observer on unsubscribe without
    // ever re-attaching it (MutationObserver has onUnsubscribe but no
    // onSubscribe). The request fired on the DISCARDED pass therefore returns
    // 200 to a listener nobody holds: `onSuccess` never runs, `data` never
    // arrives, `isPending` never clears and no error is ever raised — so the
    // page sits on the loading state with nothing to retry and nothing logged.
    //
    // Without this cleanup the surviving pass saw `requested.current` already
    // equal to the signature and returned early, so the only request in flight
    // was the one nobody was listening to. Clearing the ref lets the surviving
    // pass issue the request it can actually receive.
    //
    // Still one request per signature: the deps are unchanged, and Simulation
    // Studio's /run effect carries the same fix for the same reason.
    return () => {
      requested.current = null
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [draft?.signature])

  /** The record on screen, whether it was just assembled or read back out of
   *  the store. The stored one is the assembled record byte for byte — the
   *  storage facts live on the envelope beside it, never inside it. */
  const shown: DecisionRecord | undefined = viewingStored ? stored.data?.record : record.data

  /** What the store knows about what is on screen. Null before a save, because
   *  before a save there is genuinely nothing to know. */
  const envelope: StoredDecision | null = viewingStored
    ? (stored.data ?? null)
    : (saveDecision.data ?? null)

  /** Store the decision durably. Decision Center is the system of record.
   *
   *  The record goes to the server exactly as it was assembled; the server
   *  mints the id and appends a version. Nothing on this page changes if the
   *  write fails, and nothing historical is overwritten if it succeeds. */
  const persistDecision = () => {
    // SAVES WHAT IS ON SCREEN, OR NOTHING. Viewing a stored decision while a
    // draft happens to be assembled must not write the draft under the stored
    // one's id — the two are different decisions.
    if (!record.data || viewingStored) return
    // Appending to the decision THIS BROWSER owns, and only that one. The
    // history list can point `stored` at somebody else's record, and appending
    // a version to it because it happened to be loaded would be a write the
    // user never asked for.
    const appendTo =
      stored.data && stored.data.decision_id === savedDecisionId ? stored.data : null
    saveDecision.mutate(
      {
        record: record.data,
        investigation_id: savedInvestigationId,
        scenario_id: savedScenarioId,
        // Stating the version this browser believes is current — a write
        // against a stale expectation is refused with 409 rather than applied
        // over work nobody here has seen.
        ...(appendTo
          ? { decision_id: appendTo.decision_id, expected_version: appendTo.current_version }
          : {}),
      },
      { onSuccess: (saved) => rememberDecision(saved.decision_id, saved.version) },
    )
  }

  /** Render the portable briefing AND SHOW IT.
   *
   *  A CLICK OPENS THE BRIEFING, IT DOES NOT WRITE FILES. Two earlier shapes of
   *  this button were both wrong: the first only rendered, parking a Download
   *  control near the bottom of the page where nobody saw it, so the button read
   *  as dead; the second wrote briefing.html and briefing.json straight to the
   *  browser's downloads, which dropped a JSON file on the user before they had
   *  seen a single line of what was in it.
   *
   *  So generating now opens the briefing on screen — the real rendered
   *  document, not a summary of it — and downloading is a separate, deliberate
   *  act that goes through the Report Center like every other artifact in this
   *  application. Nothing is stored by this request and nothing on the page
   *  changes, success or failure. */
  const [briefingOpen, setBriefingOpen] = useState(false)
  const generateBriefing = () =>
    shown && briefing.mutate({ record: shown }, { onSuccess: () => setBriefingOpen(true) })

  /** Store this decision as a report, then go and download it.
   *
   *  THE ONE PLACE THIS APPLICATION SAVES A FILE IS THE REPORT CENTER, and the
   *  briefing is no exception. The preview's download control generates into the
   *  library — the same module, scope and payload the board's Export Report
   *  sends — and then opens Reports, where Excel and PDF are downloaded the way
   *  they are for every other module. Nothing is written to disk from here. */
  const generateReport = useGenerateReport()
  const downloadFromReports = () => {
    if (generateReport.isPending) return
    generateReport.mutate(
      { module: 'decision-center', scope: exportScope(), options: exportOptions() },
      {
        onSuccess: () => {
          setBriefingOpen(false)
          navigate('/reports')
        },
      },
    )
  }

  /** Ask for the AI explanation of the record ON SCREEN.
   *
   *  ON A CLICK, AND ONLY ON A CLICK. There is deliberately no effect that
   *  fires this: Decision Center renders completely from the deterministic
   *  record, and an automatic call would make the page's readiness depend on an
   *  external service that may be slow, unconfigured or down. The explanation
   *  arrives after the decision is already readable, or it does not arrive and
   *  nothing else is affected. */
  const generateAiBrief = () => shown && aiBrief.mutate({ record: shown })

  /** The scope and payloads a report export reads, resolved at click time.
   *
   *  A REOPENED DECISION EXPORTS ITS STORED BYTES. Handing the server the four
   *  Simulation payloads instead would re-assemble the record against today's
   *  dataset and quietly republish a historical decision at current numbers. */
  /** The scope a report is generated against — the record's own applied
   *  filters. Read at click time, and by both callers: the board's Export Report
   *  and the briefing's download must describe the same screen. */
  const exportScope = () => (shown?.scope.filters_applied as Record<string, unknown>) ?? {}

  const exportOptions = () => ({
    ...(viewingStored && stored.data
      ? { decision_record: stored.data.record }
      : { record: draft ? assembleRequest(draft) : undefined }),
    ...(envelope
      ? {
          storage: {
            decision_id: envelope.decision_id,
            version: envelope.version,
            dataset_version: envelope.dataset_version,
            stale: envelope.stale,
          },
        }
      : {}),
    filename_hint: shown?.scenario.scenario_id,
  })

  const crumbs = [{ label: 'TPO Intelligence' }, { label: 'Decision Center' }]
  /** Save is offered only for a record this page assembled and has not yet
   *  stored. A reopened decision is already in the store, and re-saving it
   *  would append a version identical to the one being read. */
  const canSave = Boolean(record.data) && !viewingStored && !saveDecision.isSuccess

  return (
    <AppShell activeKey="decision" crumbs={crumbs}>
      <div className="fade-in flex flex-wrap items-end justify-between gap-4">
        <div>
          <div className="flex items-center gap-3">
            <h1 className="flex items-center gap-2 text-2xl font-extrabold tracking-[-0.02em]">
              Decision Center <Icon name="sparkles" className="h-5 w-5 text-brand-violet" />
            </h1>
          </div>
          <p className="mt-1.5 max-w-[640px] text-base text-ink-muted">
            Compare promotion strategies and select the best business decision. Every figure is the
            one its own module computed — this page ranks and records, it never recalculates.
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Button variant="secondary" onClick={() => navigate('/simulation')}>
            <Icon name="flow" /> <span>Back to Simulation</span>
          </Button>
          <Button
            variant="secondary"
            onClick={persistDecision}
            disabled={!canSave || saveDecision.isPending}
            title={
              record.data
                ? saveDecision.isSuccess
                  ? 'This record is already stored'
                  : undefined
                : viewingStored
                  ? 'This decision is already stored. Carry a scenario from Simulation Studio to save a new version.'
                  : candidates.length > 0
                    ? // SCENARIOS ARE HERE; THE SELECTED ONE JUST HAS NO RECORD TO SAVE.
                      // "Carry a scenario here first" was still being shown in this
                      // state, which reads as a broken button to anyone who can see
                      // the scenarios they already carried sitting on the board. The
                      // same condition renders NoRecordForCandidate below, so the two
                      // now give the same reason.
                      'This scenario has no decision record. Select a scenario added from Simulation Studio — measured, Optimizer and Target Rescue plans produce none.'
                    : 'Carry a scenario here first'
            }
          >
            {saveDecision.isPending ? <Spinner /> : <Icon name="checkCircle" />}
            <span>{saveDecision.isPending ? 'Saving…' : 'Save Decision'}</span>
          </Button>
          {/* THE EXPORT LIVES ON THE BOARD, not here. It carries the compared
              scenarios AND the decision record, and two controls with the same
              label exporting different halves of the page is how a user ends up
              with the wrong report. */}
          <Button
            variant="primary"
            onClick={generateBriefing}
            disabled={!shown || briefing.isPending}
            title={shown ? undefined : 'Carry a scenario here first'}
          >
            {briefing.isPending ? <Spinner /> : <Icon name="file" />}
            <span>{briefing.isPending ? 'Generating…' : 'Generate Briefing'}</span>
          </Button>
        </div>
      </div>

      {saveDecision.isError && (
        <Card className="fade-in mt-4 border-[1.5px] border-[rgba(239,68,68,0.35)]">
          <CardBody>
            <div className="text-base font-bold text-ink-primary">
              Could not save the decision
            </div>
            <div className="mt-1 break-words text-base text-ink-secondary">
              {saveDecision.error.message}
            </div>
            <div className="mt-0.5 text-xs text-ink-muted">
              The record below is unchanged, and nothing was written.
            </div>
          </CardBody>
        </Card>
      )}

      {saveDecision.isSuccess && !saveDecision.isPending && (
        <StoredBanner stored={saveDecision.data} label="Decision saved" />
      )}

      {viewingStored && stored.data && !saveDecision.isSuccess && (
        <StoredBanner stored={stored.data} label="Loaded from the store" />
      )}

      {/* THE BOARD OWNS THE EXPORT AND THE APPROVE ACTION, because both act on
          what is on the board. `exportOptions` still comes from this page — it
          is what knows whether a stored record or a live draft is on screen —
          and the board merges its comparison into the same payload. */}
      <CandidateBoard
        exportScope={exportScope}
        exportOptions={exportOptions}
        onApprove={persistDecision}
        canApprove={canSave && !saveDecision.isPending}
        approveHint={
          saveDecision.isSuccess
            ? 'This decision is already recorded — see Decision History below.'
            : viewingStored
              ? 'This decision is already stored. Carry a new scenario here to record another.'
              : record.isPending
                ? 'Assembling this scenario’s decision record…'
                : 'Only a Simulation Studio scenario carries a governed record, and it must be selected above.'
        }
        approving={saveDecision.isPending}
        hasRecord={Boolean(shown)}
      />

      {shown ? (
        <RecordView
          record={shown}
          stored={envelope}
          briefing={briefing}
          aiBrief={aiBrief}
          onGenerateAi={generateAiBrief}
          canSave={canSave}
          saving={saveDecision.isPending}
          onViewBriefing={() => setBriefingOpen(true)}
        />
      ) : stored.isPending && lookupId ? (
        <Loading label="Loading the saved decision…" />
      ) : record.isError && draft ? (
        <ErrorState
          error={record.error}
          onRetry={() => record.mutate(assembleRequest(draft))}
          onDiscard={() => {
            clearDraft()
            navigate('/simulation')
          }}
        />
      ) : draft ? (
        <Loading label="Building your decision record…" />
      ) : (
        /* The board above already states what to do when it is empty. This is
           the second half of the page: a scenario on the board that carries no
           decision record — every source but Simulation Studio — still needs to
           say why there is nothing below it. */
        candidates.length > 0 && !draft && <NoRecordForCandidate />
      )}

      {/* DECISION HISTORY IS ALWAYS ON THE PAGE. It reads GET /api/store/decisions,
          so it survives navigation, a reload and this browser entirely — and it
          used to render only when nothing else was on screen, which meant the
          moment you recorded a decision the list of recorded decisions
          disappeared. */}
      <Card className="fade-in mt-[14px]">
        <DecisionHistory
          currentDecisionId={envelope?.decision_id ?? null}
          onOpen={openStoredDecision}
          // A cleared history has nothing left to point at: drop the opened id
          // and this browser's saved pointer, or the page would keep asking the
          // store for a decision it has just deleted.
          onCleared={() => {
            setOpenedId(null)
            forgetDecision()
            // And drop the save result itself: its "Decision saved · dec_…"
            // banner names a record the store no longer holds, which would sit
            // on screen directly above a history saying nothing is saved.
            // Resetting it also re-arms Approve, since the decision can now
            // legitimately be recorded again.
            saveDecision.reset()
          }}
        />
      </Card>

      {/* THE BRIEFING, ON SCREEN. Opened by Generate Briefing and reopened from
          the Actions card; downloading from it goes through the Report Center. */}
      <BriefingPreview
        open={briefingOpen && Boolean(briefing.data)}
        response={briefing.data}
        onClose={() => setBriefingOpen(false)}
        onDownload={downloadFromReports}
        preparing={generateReport.isPending}
        error={generateReport.isError ? generateReport.error.message : null}
      />
    </AppShell>
  )
}

/** THE BRIEFING PREVIEW — the artifact itself, not a description of it.
 *
 *  `briefing.html` is a complete, self-contained document: its own styles, no
 *  script, no external asset and no network request. So the preview renders THAT
 *  DOCUMENT rather than re-laying-out its values in React — a second rendering
 *  would be a second version of the briefing, and the two could disagree about a
 *  number while both claiming to be the artifact.
 *
 *  IN A SANDBOXED IFRAME, with no permissions granted at all: the document is
 *  built from record values that came back from the server, and nothing in this
 *  preview needs script, forms, popups or same-origin access to show it.
 *
 *  DOWNLOADING IS NOT DONE HERE. The control hands off to the Report Center,
 *  which is the only place in this application that saves a file.
 */
function BriefingPreview({
  open,
  response,
  onClose,
  onDownload,
  preparing,
  error,
}: {
  open: boolean
  response: BriefingResponse | undefined
  onClose: () => void
  onDownload: () => void
  preparing: boolean
  error: string | null
}) {
  if (!response) return null
  return (
    <Modal open={open} onClose={onClose} maxWidthClassName="max-w-[1040px]">
      <div className="flex items-start justify-between gap-3 border-b border-border-subtle px-5 py-4">
        <div className="min-w-0">
          <div className="text-md font-bold text-ink-primary">Decision briefing</div>
          <div className="mt-0.5 text-sm leading-[1.5] text-ink-muted">
            The rendered briefing, exactly as it would leave this application. Nothing has been
            stored and nothing has been written to your computer.
          </div>
        </div>
        <Button variant="secondary" onClick={onClose} title="Close the briefing">
          <Icon name="x" /> <span>Close</span>
        </Button>
      </div>

      <div className="px-5 pt-4">
        <iframe
          title="Decision briefing"
          srcDoc={response.html}
          sandbox=""
          className="h-[62vh] w-full rounded-[var(--r-md)] border border-border-subtle bg-white"
        />
      </div>

      <div className="flex flex-wrap items-center justify-between gap-3 px-5 pb-5 pt-4">
        <div className="max-w-[520px] text-sm leading-[1.5] text-ink-muted">
          {error ? (
            <span className="text-status-danger">
              Could not prepare the download — {error}. The briefing above is unchanged.
            </span>
          ) : (
            <>
              Download stores this decision in the Report Center and opens it there, where Excel
              and PDF are saved the same way as every other report.
            </>
          )}
        </div>
        <Button variant="primary" onClick={onDownload} disabled={preparing}>
          {preparing ? <Spinner /> : <Icon name="download" />}
          <span>{preparing ? 'Preparing…' : 'Download from Reports'}</span>
        </Button>
      </div>
    </Modal>
  )
}

type BriefingMutation = ReturnType<typeof useDecisionBriefing>

/** THE PAGE, in the order a decision is actually read.
 *
 *  Context first — what am I looking at. Then the recommendation, because that
 *  is the point of the page. Then how it would be executed, what it is expected
 *  to do, and how it compares. Then what is risky, whether it is ready, and
 *  finally where every number came from.
 */
function RecordView({
  record,
  stored,
  briefing,
  aiBrief,
  onGenerateAi,
  canSave,
  saving,
  onViewBriefing,
}: {
  record: DecisionRecord
  stored: StoredDecision | null
  briefing: BriefingMutation
  aiBrief: ReturnType<typeof useDecisionBrief>
  onGenerateAi: () => void
  canSave: boolean
  saving: boolean
  onViewBriefing: () => void
}) {
  return (
    <>
      <Card className="fade-in mt-4">
        <ContextSection record={record} stored={stored} />
      </Card>

      <Card className="fade-in mt-[14px]">
        <RecommendedPlanSection record={record} />
      </Card>

      <Card className="fade-in mt-[14px]">
        <StrategySection strategy={record.strategy} />
      </Card>

      <Card className="fade-in mt-[14px]">
        <ImpactSection record={record} />
      </Card>

      <Card className="fade-in mt-[14px]">
        <ComparisonSection comparison={record.comparison} />
      </Card>

      <Card className="fade-in mt-[14px]">
        <GovernanceSection record={record} />
      </Card>

      <Card className="fade-in mt-[14px]">
        <EvidenceSection record={record} stored={stored} />
      </Card>

      {/* AFTER the evidence, so a reader meets the computed record first and the
          explanation of it second — never the other way round. */}
      <Card className="fade-in mt-[14px]">
        <AiDecisionBrief brief={aiBrief} onGenerate={onGenerateAi} />
      </Card>

      <Card className="fade-in mt-[14px]">
        <ActionsSection
          briefing={briefing}
          canSave={canSave}
          saving={saving}
          stored={stored}
          onViewBriefing={onViewBriefing}
        />
      </Card>

      {/* NO DECISION HISTORY HERE. The page renders one, below this view and
          outside it, so it is on screen whether or not a record is — see the
          note at the end of `Decision`. A second copy inside the record view
          put two identical history cards on the page the moment a record was
          shown, each with its own "Clear history". */}

      <div className="mt-[14px] text-sm leading-[1.5] text-ink-muted">
        {stored
          ? 'This decision is stored on the server and remains retrievable by its id after a reload.'
          : record.meta.persistence_note}
      </div>
    </>
  )
}

/** WHAT IS BEING DECIDED — id, status, investigation, scope.
 *
 *  The first thing on the page, because a decision nobody can identify is not
 *  a decision. Nothing here is invented: an unavailable field carries the
 *  record's own reason, never a placeholder that could pass for a reference. */
function ContextSection({
  record,
  stored,
}: {
  record: DecisionRecord
  stored: StoredDecision | null
}) {
  const { scenario, investigation, scope } = record
  return (
    <>
      <div className="flex flex-wrap items-start justify-between gap-3 border-b border-border-subtle px-5 py-4">
        <div className="min-w-0">
          <div className="text-xs font-semibold uppercase tracking-[0.04em] text-ink-muted">
            Decision under review
          </div>
          <div className="mt-1 flex flex-wrap items-baseline gap-x-3 gap-y-1">
            <span className="text-lg font-extrabold text-ink-primary">{scenario.name}</span>
            <span className="text-base text-ink-secondary">
              {scenario.treatment} · {scenario.discount_pct}% discount
            </span>
            {scenario.uplift && (
              <span className="text-sm text-ink-muted">
                {scenario.range_label} {(scenario.uplift.low * 100).toFixed(0)}–
                {(scenario.uplift.high * 100).toFixed(0)}%
              </span>
            )}
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <span className="rounded-[4px] bg-surface-muted px-2 py-[3px] text-2xs font-extrabold uppercase tracking-[0.04em] text-ink-muted">
            {stored ? `${record.status} · saved` : `${record.status} · not saved`}
          </span>
          {stored?.stale && (
            <span className="rounded-[4px] bg-status-warning-bg px-2 py-[3px] text-2xs font-extrabold uppercase tracking-[0.04em] text-status-warning">
              Stale
            </span>
          )}
        </div>
      </div>

      <CardBody>
        <div className="flex flex-wrap gap-x-8 gap-y-3">
          <Field
            label="Decision ID"
            value={stored?.decision_id ?? null}
            fallback="Not saved yet"
            mono
          />
          <Field
            label="Version"
            value={stored ? `v${stored.version}` : null}
            fallback="Not saved yet"
          />
          <Field label="Period" value={scope.period} />
          <Field label="Rows in scope" value={scope.row_count?.toLocaleString() ?? null} />
          <Field label="Promoted rows" value={scope.promoted_row_count?.toLocaleString() ?? null} />
          <Field
            label="Excluded from scenario"
            value={scope.excluded_rows ? scope.excluded_rows.toLocaleString() : null}
            fallback="None"
            reason={scope.excluded_reason}
          />
          <Field
            label="Investigation"
            value={investigation.investigation_type}
            fallback="Not specified"
          />
          <Field
            label="Investigation ID"
            value={investigation.investigation_id}
            fallback="Not assigned"
            reason={investigation.investigation_id_unavailable_reason}
            mono
          />
        </div>

        <div className="mt-3 border-t border-border-subtle pt-3">
          <div className="text-xs font-semibold uppercase tracking-[0.04em] text-ink-muted">
            {investigation.question ? 'Investigation question' : 'Investigation'}
          </div>
          {investigation.question ? (
            <div className="mt-1 text-base font-semibold leading-[1.45] text-ink-primary">
              {investigation.question}
            </div>
          ) : (
            <div className="mt-1 flex items-start gap-1.5 text-sm leading-[1.45] text-ink-muted">
              <span>
                {investigation.question_source === 'seed_example'
                  ? 'No investigation question — the studio was showing an example, not something you asked.'
                  : 'No investigation question recorded.'}
              </span>
              {investigation.question_unavailable_reason && (
                <InfoPopover label="Why there is no question" title="Investigation question" width={280}>
                  <div className="mt-1 text-sm leading-[1.5] text-ink-secondary">
                    {investigation.question_unavailable_reason}
                  </div>
                </InfoPopover>
              )}
            </div>
          )}
        </div>
      </CardBody>
    </>
  )
}

/** THE RECOMMENDED PLAN — the point of the page.
 *
 *  The recommendation is carried verbatim from the decision policy that
 *  produced it. It is not re-derived here, not reworded into a new business
 *  recommendation, and not made to agree with the scenario the user chose:
 *  selecting a scenario the policy did not choose does not change what the
 *  policy chose, and the record says both things plainly. */
function RecommendedPlanSection({ record }: { record: DecisionRecord }) {
  const { recommendation, scenario } = record
  return (
    <>
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-border-subtle px-5 py-4">
        <h3 className="text-md font-bold">Recommended Plan</h3>
        <span
          className={`rounded-[4px] px-2 py-[3px] text-2xs font-extrabold uppercase tracking-[0.04em] ${
            recommendation.is_this_scenario
              ? 'bg-status-success-bg text-status-success'
              : 'bg-status-warning-bg text-status-warning'
          }`}
        >
          {recommendation.is_this_scenario ? 'Selected is recommended' : 'Selected differs'}
        </span>
      </div>
      <CardBody>
        <div className="grid grid-cols-[minmax(0,1fr)_minmax(0,1.6fr)] gap-6 @max-[900px]:grid-cols-1">
          <div>
            <div className="text-xs font-semibold uppercase tracking-[0.04em] text-ink-muted">
              Selected scenario
            </div>
            <div className="mt-1 text-md font-extrabold text-ink-primary">{scenario.name}</div>
            <div className="mt-0.5 text-sm text-ink-secondary">
              {scenario.treatment} · {scenario.discount_pct}%
            </div>

            <div className="mt-3 text-xs font-semibold uppercase tracking-[0.04em] text-ink-muted">
              Recommended scenario
            </div>
            {/* The NAME a person gave it, resolved from the comparison. This
                card used to print `scenario-b` — a session-local id — at a
                commercial director. */}
            <div className="mt-1 text-base font-bold text-ink-primary">
              {recommendation.recommended_scenario_name ??
                recommendation.recommended_scenario_id ??
                'None recommended'}
            </div>
            {recommendation.recommended_scenario_id && (
              <div className="mt-0.5 font-mono text-xs text-ink-muted">
                {recommendation.recommended_scenario_id}
              </div>
            )}
          </div>

          <div className="min-w-0">
            <div className="text-xs font-semibold uppercase tracking-[0.04em] text-ink-muted">
              Why this scenario?
            </div>
            <div className="mt-1 text-base leading-[1.6] text-ink-secondary">
              {recommendation.reason}
            </div>
            <div className="mt-3 flex flex-wrap gap-x-5 gap-y-1.5 text-xs text-ink-muted">
              <span>
                <span className="font-semibold">Objective:</span> {recommendation.objective}
              </span>
              <span>
                <span className="font-semibold">Primary:</span>{' '}
                {recommendation.primary_metric?.replace(/_/g, ' ')} at the{' '}
                {recommendation.primary_endpoint} end
              </span>
            </div>
            <div className="mt-2 text-xs leading-[1.5] text-ink-muted">
              {recommendation.note}
            </div>
          </div>
        </div>
      </CardBody>
    </>
  )
}

/** EXPECTED IMPACT — both ends of the approved range, never a midpoint. */
function ImpactSection({ record }: { record: DecisionRecord }) {
  return (
    <>
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-border-subtle px-5 py-4">
        <div className="flex items-center gap-2">
          <h3 className="text-md font-bold">Expected Impact</h3>
          {/* Said once, in the header, so no reader can take a row below for a
              historical actual. */}
          <span className="rounded-[4px] bg-surface-muted px-2 py-[3px] text-2xs font-extrabold uppercase tracking-[0.04em] text-ink-muted">
            Simulated
          </span>
        </div>
        <span className="text-xs text-ink-muted">
          {record.scenario.range_label} · low – high
        </span>
      </div>
      <div className="px-5 py-3">
        <ExcludedRowsNote scope={record.scope} />
        <div className="grid grid-cols-2 gap-x-8 @max-[760px]:grid-cols-1">
          {record.expected_impact
            // NOT SHOWN IN DECISION CENTER. The record still carries it and the
            // KPI engine still computes it — Simulation Studio reports it in
            // full. This page does not.
            .filter((metric) => metric.metric !== 'cannibalization')
            .map((metric) => (
              <ImpactRow key={metric.metric} metric={metric} />
            ))}
        </div>
        <div className="mt-2 border-t border-border-subtle pt-2.5 text-xs leading-[1.5] text-ink-muted">
          Both ends of the treatment&apos;s approved uplift range are shown. There is no midpoint and
          no expected value between them, and this is not a confidence interval. These are
          simulated values for a hypothetical scenario — the measured figures for this scope are in
          the Current column of the comparison below.
        </div>
        <WeeklyNote record={record} />
      </div>
    </>
  )
}

/** What the engine could not re-base — and why a zero below may not mean zero.
 *
 *  THE MOST DANGEROUS NUMBER ON THIS PAGE IS A ZERO NOBODY EXPLAINED. The
 *  simulation excludes promoted rows whose (product, channel) has no
 *  non-promoted row to form a baseline from. When some are excluded the
 *  scenario covers less than the scope suggests; when ALL of them are, the
 *  engine returns a row of zeros because there was nothing left to compute
 *  over — and an unexplained "₹0" reads as "we evaluated this promotion and it
 *  came to nothing", which is a different and false claim.
 *
 *  The count was already in the record; the REASON was being dropped in
 *  assembly. Both are carried now, and neither is computed here — the engine
 *  reported them and this states them. */
function ExcludedRowsNote({ scope }: { scope: DecisionRecord['scope'] }) {
  const excluded = scope.excluded_rows ?? 0
  if (excluded <= 0) return null

  const all = scope.all_promoted_rows_excluded
  return (
    <div
      className={`mb-3 flex items-start gap-2.5 rounded-[var(--r-md)] border px-3 py-2.5 ${
        all
          ? 'border-[rgba(245,158,11,0.4)] bg-status-warning-bg'
          : 'border-border-subtle bg-surface-muted'
      }`}
    >
      <Icon
        name="warning"
        className={`mt-px h-4 w-4 shrink-0 ${all ? 'text-status-warning' : 'text-ink-muted'}`}
      />
      <div className="min-w-0 text-sm leading-[1.55] text-ink-secondary">
        <span className="font-bold text-ink-primary">
          {excluded.toLocaleString()} of {(scope.promoted_row_count ?? 0).toLocaleString()} promoted
          rows {all ? 'were all excluded' : 'were excluded'} from this scenario.
        </span>{' '}
        {scope.excluded_reason}
        {all && (
          <div className="mt-1">
            Nothing was left for the scenario to compute over, so the figures below are the
            absence of a simulated result rather than a measured outcome. Widen the scope — or
            choose one with comparable non-promoted rows — to simulate this treatment.
          </div>
        )}
      </div>
    </div>
  )
}

function ImpactRow({ metric }: { metric: DecisionImpactMetric }) {
  return (
    <div className="flex items-baseline justify-between gap-3 border-b border-border-subtle py-2.5 last:border-b-0">
      <span className="text-base text-ink-secondary">{metric.label ?? metric.metric}</span>
      {metric.available ? (
        <span className="text-base font-bold text-ink-primary [font-variant-numeric:tabular-nums]">
          {metric.display_low} – {metric.display_high}
        </span>
      ) : (
        <span className="inline-flex items-center gap-1 text-sm text-ink-muted">
          Not available
          {metric.unavailable_reason && (
            <InfoPopover
              label={`Why ${metric.label ?? metric.metric} is unavailable`}
              title={metric.label ?? metric.metric}
              width={272}
            >
              <div className="mt-1 text-sm leading-[1.5] text-ink-secondary">
                {metric.unavailable_reason}
              </div>
            </InfoPopover>
          )}
        </span>
      )}
    </div>
  )
}

/** Weekly impact — carried if the user had it open, stated honestly if not. */
function WeeklyNote({ record }: { record: DecisionRecord }) {
  if (!record.weekly.available) {
    return (
      <div className="mt-2 text-xs leading-[1.5] text-ink-muted">{record.weekly.reason}</div>
    )
  }
  return (
    <div className="mt-2 flex items-start gap-1.5 text-xs leading-[1.5] text-ink-muted">
      <Icon name="activity" className="mt-px h-3 w-3 shrink-0" />
      <span>
        Weekly impact was carried with this scenario: {record.weekly.week_count} business weeks.{' '}
        {record.weekly.method}
      </span>
    </div>
  )
}

/** RISK & GOVERNANCE — the risk assessment, verbatim.
 *
 *  Nothing here converts a governance gap into a compliance verdict. Where the
 *  project has approved no boundary, the gap travels through saying so, and no
 *  badge claims a threshold was met that nobody ever set. */
function GovernanceSection({ record }: { record: DecisionRecord }) {
  const { governance } = record
  const tone = {
    clear: 'bg-status-success-bg text-status-success',
    attention: 'bg-status-warning-bg text-status-warning',
    unknown: 'bg-surface-muted text-ink-muted',
  }[governance.overall_status]

  return (
    <>
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-border-subtle px-5 py-4">
        <div className="flex items-center gap-2">
          <h3 className="text-md font-bold">Risk &amp; Governance</h3>
          <span
            className={`rounded-[4px] px-2 py-[3px] text-2xs font-extrabold uppercase tracking-[0.04em] ${tone}`}
          >
            {governance.overall_status}
          </span>
        </div>
      </div>
      <CardBody>
        <div className="max-w-[720px] text-base leading-[1.6] text-ink-secondary">
          {governance.summary}
        </div>

        <Group label="Findings">
          {governance.findings
            // NOT SHOWN IN DECISION CENTER, by its stable id rather than its
            // wording. The check still runs, the record still carries it and
            // Simulation Studio's Risk & Governance panel still reports it.
            .filter((finding) => finding.id !== 'cannibalization')
            .map((finding) => (
              <FindingRow key={finding.id} finding={finding} />
            ))}
        </Group>

        <Group label="Governance considerations">
          <div className="text-xs leading-[1.5] text-ink-muted">
            These boundaries are not defined anywhere in the project, so nothing above is judged
            against them.
          </div>
          <ul className="mt-1.5 flex flex-col gap-1">
            {governance.governance_gaps
              .filter((gap) => gap.key !== 'cannibalization_limit')
              .map((gap) => (
                <li key={gap.key} className="text-sm leading-[1.5] text-ink-muted">
                  <span className="font-semibold text-ink-secondary">{gap.label}</span> —{' '}
                  {gap.statement}
                </li>
              ))}
          </ul>
        </Group>

        <Group label="Method limitations">
          <ul className="flex flex-col gap-1.5">
            {governance.limitations.map((limitation) => (
              <li key={limitation.id} className="text-sm leading-[1.5] text-ink-muted">
                <span className="font-semibold text-ink-secondary">{limitation.title}</span> —{' '}
                {limitation.statement}
              </li>
            ))}
          </ul>
        </Group>
      </CardBody>
    </>
  )
}

function FindingRow({ finding }: { finding: RiskFinding }) {
  const tone = {
    high: 'bg-status-danger-bg text-status-danger',
    medium: 'bg-status-warning-bg text-status-warning',
    low: 'bg-surface-muted text-ink-muted',
    unknown: 'bg-surface-muted text-ink-muted',
  }[finding.severity]
  return (
    <div className="text-sm leading-[1.5]">
      <div className="flex flex-wrap items-baseline gap-x-2">
        <span className="font-semibold text-ink-primary">{finding.title}</span>
        <span
          className={`rounded-[4px] px-1.5 py-[1px] text-2xs font-extrabold uppercase tracking-[0.04em] ${tone}`}
        >
          {finding.severity}
        </span>
        <span className="text-2xs uppercase tracking-[0.04em] text-ink-muted">
          {finding.category.replace('_', ' ')}
        </span>
      </div>
      <div className="mt-0.5 text-ink-muted">{finding.reason}</div>
    </div>
  )
}

/** ACTIONS — save the record, and take it with you.
 *
 *  GENERATING IS NOT DOWNLOADING. The briefing is rendered on request and then
 *  offered; the browser saves a file only when a person asks for one. That is
 *  the same shape the Report Center uses — generate, then download — and it
 *  keeps a click that produces an artifact distinct from a click that writes to
 *  the user's disk. */
function ActionsSection({
  briefing,
  canSave,
  saving,
  stored,
  onViewBriefing,
}: {
  briefing: BriefingMutation
  canSave: boolean
  saving: boolean
  stored: StoredDecision | null
  /** Reopen a briefing that has already been generated. */
  onViewBriefing: () => void
}) {
  return (
    <>
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-border-subtle px-5 py-4">
        <h3 className="text-md font-bold">Actions</h3>
        {stored && (
          <span className="text-xs text-ink-muted">
            Stored as <span className="font-mono">{stored.decision_id}</span> · version{' '}
            {stored.version}
          </span>
        )}
      </div>
      <CardBody>
        <div className="grid grid-cols-2 gap-6 @max-[900px]:grid-cols-1">
          {/* --- save */}
          <div>
            <div className="text-base font-bold text-ink-primary">Save Decision</div>
            <div className="mt-1 max-w-[420px] text-sm leading-[1.6] text-ink-secondary">
              Stores this record on the server, which mints the decision id and appends a version.
              Re-saving never overwrites: the previous version stays exactly where it was.
            </div>
            {/* ONE BUTTON PER ACTION, IN THE ACTION BAR AT THE TOP.
                This section explains what each action does and reports what it
                did; the controls themselves live in the header, the same place
                every other page in the application puts them. A second button
                with the same label is a thing a user has to think about. */}
            <div className="mt-2 text-sm leading-[1.5] text-ink-muted">
              {saving
                ? 'Saving…'
                : stored
                  ? `Saved as ${stored.decision_id} · version ${stored.version}.`
                  : canSave
                    ? 'Use Save Decision at the top of the page.'
                    : 'Already stored — carry a scenario from Simulation Studio to save a new version.'}
            </div>
            {stored && (
              <div className="mt-2 text-xs leading-[1.5] text-ink-muted">
                {stored.owner_note}
              </div>
            )}
          </div>

          {/* --- briefing */}
          <div>
            <div className="text-base font-bold text-ink-primary">Generate Briefing</div>
            <div className="mt-1 max-w-[420px] text-sm leading-[1.6] text-ink-secondary">
              Renders this record as <strong>briefing.html</strong>, a self-contained page that
              opens on screen here, and <strong>briefing.json</strong>, the record itself. Both
              carry exactly what is on this page, and both state that this decision is a draft and
              is not approved. Saving a copy goes through the Report Center.
            </div>
            {/* GENERATING IS THE HEADER'S JOB. Once it has run, the briefing is
                on hand, so this reopens it rather than rebuilding it — and no
                control here writes a file. */}
            <div className="mt-3 flex flex-wrap items-center gap-2">
              {briefing.isPending ? (
                <span className="inline-flex items-center gap-2 text-sm text-ink-secondary">
                  <Spinner /> Generating…
                </span>
              ) : briefing.isSuccess && briefing.data ? (
                <Button variant="secondary" onClick={onViewBriefing}>
                  <Icon name="file" /> <span>View briefing</span>
                </Button>
              ) : (
                <span className="text-sm text-ink-muted">
                  Use Generate Briefing at the top of the page.
                </span>
              )}
            </div>
            {briefing.isSuccess && briefing.data && (
              <div className="mt-2 text-xs leading-[1.5] text-ink-muted">
                Briefing ready — {briefing.data.filenames.html} and{' '}
                {briefing.data.filenames.json}. Nothing was stored, nobody was notified and
                nothing was written to your computer; the briefing's Download control puts this
                decision in the Report Center, and the file is saved from there.
              </div>
            )}
            {briefing.isError && (
              <div className="mt-2 text-sm leading-[1.5] text-status-danger">
                Could not generate the briefing — {briefing.error.message}. The record above is
                unchanged.
              </div>
            )}
            <div className="mt-2 text-xs leading-[1.5] text-ink-muted">
              The briefing names no author and no approver: this application has no authentication,
              so it cannot establish who produced or reviewed it.
            </div>
          </div>
        </div>
      </CardBody>
    </>
  )
}

/** What the store knows about this decision.
 *
 *  STALE IS REPORTED, NEVER RESOLVED. When the source data has changed since
 *  the save, the banner says so and the values on the page stay exactly as they
 *  were stored. Nothing is recalculated and nothing is overwritten — a
 *  historical record is worth having precisely because it is historical. */
function StoredBanner({ stored, label }: { stored: StoredDecision; label: string }) {
  return (
    <Card
      className={`fade-in mt-4 ${
        stored.stale ? 'border-[1.5px] border-[rgba(245,158,11,0.45)]' : ''
      }`}
    >
      <CardBody>
        <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
          <div className="text-base font-bold text-ink-primary">
            {label} · <span className="font-mono">{stored.decision_id}</span> · version{' '}
            {stored.version}
            {stored.stale && (
              <span className="ml-2 rounded-[4px] bg-status-warning-bg px-2 py-[3px] text-2xs font-extrabold uppercase tracking-[0.04em] text-status-warning">
                Stale
              </span>
            )}
          </div>
          <div className="text-xs text-ink-muted">
            Saved {stored.saved_at} · draft, not approved
          </div>
        </div>
        <div className="mt-1 text-sm leading-[1.5] text-ink-muted">
          {stored.stale ? stored.stale_reason : stored.owner_note}
        </div>
      </CardBody>
    </Card>
  )
}

function Group({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="mt-4 border-t border-border-subtle pt-3">
      <div className="text-xs font-semibold uppercase tracking-[0.04em] text-ink-muted">
        {label}
      </div>
      <div className="mt-1.5 flex flex-col gap-2">{children}</div>
    </div>
  )
}

function Field({
  label,
  value,
  fallback = '—',
  reason,
  mono,
}: {
  label: string
  value: string | null
  fallback?: string
  reason?: string | null
  mono?: boolean
}) {
  return (
    <div className="min-w-0">
      <div className="text-xs font-semibold uppercase tracking-[0.04em] text-ink-muted">
        {label}
      </div>
      {value ? (
        <div
          className={`mt-0.5 break-words text-base font-bold text-ink-primary ${
            mono ? 'font-mono text-sm font-semibold' : ''
          }`}
        >
          {value}
        </div>
      ) : (
        <div className="mt-0.5 inline-flex items-center gap-1 text-base text-ink-muted">
          {fallback}
          {reason && (
            <InfoPopover label={`Why ${label} is unavailable`} title={label} width={272}>
              <div className="mt-1 text-sm leading-[1.5] text-ink-secondary">{reason}</div>
            </InfoPopover>
          )}
        </div>
      )}
    </div>
  )
}

function Loading({ label }: { label: string }) {
  return (
    <div className="mt-4 grid min-h-[40vh] place-items-center">
      <div className="flex flex-col items-center gap-3 text-base text-ink-muted">
        <Spinner />
        <span>{label}</span>
      </div>
    </div>
  )
}

/** Never authored content — the honest state when nothing was carried here.
 *
 *  NO FAKE KPI CARDS. A Decision Center opened directly, with no scenario and
 *  nothing saved, has no decision to describe, and rendering plausible-looking
 *  cards for one would be the worst kind of lie this page could tell. */
/** A candidate is on the board, but it carries no decision record.
 *
 *  ONLY SIMULATION STUDIO PRODUCES ONE. `/api/decision/record` assembles from
 *  the four simulation payloads — context, simulation, recommendation, risk —
 *  and General Optimization, Target Rescue and the measured Current Plan
 *  produce none of them. Their scenarios compare perfectly well above; what
 *  they cannot do is become a governed record, and saying so is better than an
 *  empty page or a record assembled from figures they never reported. */
function NoRecordForCandidate() {
  return (
    <Card className="fade-in mt-[14px]">
      <div className="px-6 py-7 text-center">
        <div className="mx-auto mb-3 grid h-11 w-11 place-items-center rounded-full bg-surface-muted text-ink-muted [&_svg]:h-5 [&_svg]:w-5">
          <Icon name="checkCircle" />
        </div>
        <div className="text-base font-bold text-ink-primary">
          This scenario has no decision record
        </div>
        <div className="mx-auto mt-1.5 max-w-[500px] text-base leading-[1.55] text-ink-secondary">
          A governed record is assembled from a simulated scenario's context, recommendation and
          risk assessment. Optimizer, Target Rescue and measured plans compare above but produce
          none of those, so there is nothing to assemble. Select a scenario added from Simulation
          Studio to read its full record.
        </div>
      </div>
    </Card>
  )
}

/** The error state — and it never shows a partial record.
 *
 *  A DECISION RECORD IS ALL OF ITS SECTIONS OR NONE OF THEM. The backend
 *  refuses to merge sections that describe different scenarios or different
 *  scopes, and the right response to that refusal is this card rather than a
 *  page rendered with a hole in it — a half-assembled record would look
 *  authoritative and be wrong.
 *
 *  A 422 IS A DIFFERENT PROBLEM FROM A 500, AND SAYS SO. 422 means the payloads
 *  the page carried do not agree with each other: the scenario, its
 *  recommendation and its risk assessment describe different things. Retrying
 *  cannot fix that — the fix is to reopen the scenario in Simulation Studio —
 *  so the card leads with that instead of a Retry the user would press three
 *  times. The server's own message names which two sections disagree, and is
 *  shown verbatim underneath. */
function ErrorState({
  error,
  onRetry,
  onDiscard,
}: {
  error: Error
  onRetry: () => void
  onDiscard: () => void
}) {
  const inconsistent = error instanceof ApiError && error.status === 422
  return (
    <Card className="fade-in mt-4 border-[1.5px] border-[rgba(239,68,68,0.35)]">
      <CardBody>
        <div className="flex items-start gap-3">
          <div className="grid h-8 w-8 shrink-0 place-items-center rounded-lg bg-status-danger-bg text-status-danger [&_svg]:h-4 [&_svg]:w-4">
            <Icon name="warning" />
          </div>
          <div className="min-w-0 flex-1">
            <div className="text-base font-bold text-ink-primary">
              Unable to build the decision record
            </div>
            {inconsistent ? (
              <div className="mt-1 max-w-[680px] text-base leading-[1.55] text-ink-secondary">
                Scenario data is inconsistent. Please return to Simulation Studio and reopen the
                selected scenario.
              </div>
            ) : (
              <div className="mt-1 max-w-[680px] text-base leading-[1.55] text-ink-secondary">
                The record could not be assembled from the results carried here.
              </div>
            )}
            <div className="mt-1.5 break-words text-sm leading-[1.5] text-ink-muted">
              {error.message}
            </div>
            <div className="mt-3 flex flex-wrap gap-2">
              {/* Ordered by what will actually help. A mismatch does not resolve
                  itself on a second attempt, so Retry is the secondary action
                  there and the primary one everywhere else. */}
              {inconsistent ? (
                <>
                  <Button variant="primary" onClick={onDiscard}>
                    <Icon name="flow" /> Back to Simulation Studio
                  </Button>
                  <Button variant="secondary" onClick={onRetry}>
                    <Icon name="refresh" /> Retry
                  </Button>
                </>
              ) : (
                <>
                  <Button variant="primary" onClick={onRetry}>
                    <Icon name="refresh" /> Retry
                  </Button>
                  <Button variant="secondary" onClick={onDiscard}>
                    <Icon name="flow" /> Back to Simulation Studio
                  </Button>
                </>
              )}
            </div>
          </div>
        </div>
      </CardBody>
    </Card>
  )
}
