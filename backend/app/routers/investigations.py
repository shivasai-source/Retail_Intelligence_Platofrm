import asyncio
import logging
import re
import time
from typing import Any

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel

from app.agents.client import AgentConfigError
from app.agents.pipeline import run_pipeline
from app.agents.star_pipeline import run_star_pipeline
from app.data_loader import InvestigationType, load
from app.dataset_store import get_dataset, load_frame
from app.deps import current_user
from app.investigation_history import append_history, read_history
from app.investigation_runs import create_run, get_run, list_runs, update_run

log = logging.getLogger(__name__)

router = APIRouter(prefix="/api", tags=["investigations"])

# Ported from the frontend's former Investigations.tsx `inferType` — same
# patterns, same fallback-to-diagnostic order. Now the single source of
# truth for classification; the frontend calls POST /investigations/query
# instead of guessing client-side.
_TYPE_PATTERNS: list[tuple[re.Pattern[str], InvestigationType]] = [
    (re.compile(r"optimi[sz]e|maximi[sz]e|best plan|allocat|improve roi|lever", re.I), "optimization"),
    (re.compile(r"launch|new sku|new product|prioriti[sz]e", re.I), "launch"),
    (re.compile(r"portfolio|channel mix|strategic|fy26|long.?term|growth budget|rebalance", re.I), "strategic"),
]


def infer_investigation_type(question: str) -> InvestigationType:
    for pattern, itype in _TYPE_PATTERNS:
        if pattern.search(question):
            return itype
    return "diagnostic"


class InvestigationQueryRequest(BaseModel):
    question: str


class InvestigationQueryResponse(BaseModel):
    type: InvestigationType
    question: str
    at: int
    history: list[dict[str, Any]]


@router.get("/investigation-types")
def get_investigation_types() -> list[dict[str, Any]]:
    """The 4 archetypes (diagnostic/optimization/launch/strategic) shown on
    the "start an investigation" picker, each with its own example questions."""
    return load("investigation-types")


@router.get("/investigations/legacy")
def get_legacy_investigation() -> dict[str, Any]:
    """The original pre-multi-type investigation block. Kept for fidelity
    with the vanilla app; superseded in practice by /investigations/{type}."""
    return load("investigations")["legacyDefault"]


@router.post("/investigations/query")
def submit_investigation_query(body: InvestigationQueryRequest) -> InvestigationQueryResponse:
    """Classify a free-text question into one of the 4 investigation
    archetypes and record it in the shared recent-investigations history.
    The frontend used to do this classification itself (client-only regex,
    localStorage-only history); this is the server-side replacement — the
    single source of truth other browsers/devices now share too."""
    question = body.question.strip()
    if not question:
        raise HTTPException(400, "question must not be empty")
    itype = infer_investigation_type(question)
    entry = {"type": itype, "question": question, "at": int(time.time() * 1000)}
    history = append_history(entry)
    return InvestigationQueryResponse(type=itype, question=question, at=entry["at"], history=history)


# NOTE: must be declared before /investigations/{type} below — Starlette
# matches routes in registration order, and {type}'s Literal validation
# would otherwise 422 on "recent" before this route ever gets a chance.
@router.get("/investigations/recent")
def get_recent_investigations() -> list[dict[str, Any]]:
    """Shared recent-investigations history (last 8), replacing the
    formerly localStorage-only, per-browser list."""
    return read_history()


# ---------------------------------------------------------------------------
# Agent-backed investigations — the real analysis pipeline (app/agents/).
# Same route-ordering caveat as /recent above: these must precede
# /investigations/{type}.
# ---------------------------------------------------------------------------
class InvestigationRunRequest(BaseModel):
    question: str
    # Omit (or pass null) to investigate the built-in TPO star schema — the
    # same data the Insights Hub reports on. Pass an id to investigate an
    # uploaded file instead.
    dataset_id: str | None = None
    # The scope the caller drilled in with, as a FilterState-shaped dict.
    # A risk alert and an underperforming row both carry the promotion,
    # product and channel codes of the event they measured; passing them
    # here pins the investigation to that exact event instead of leaving
    # the planner to re-derive a scope from the question's wording.
    # Ignored for uploaded datasets, which have no star-schema dimensions.
    scope: dict[str, Any] | None = None


async def _execute_run(
    run_id: str, question: str, dataset_id: str | None, scope: dict[str, Any] | None = None
) -> None:
    """Background task: run the pipeline, streaming stage updates into the
    run record so the frontend's poll shows genuine progress."""
    try:
        record = frame = None
        if dataset_id:
            record = get_dataset(dataset_id)
            frame = load_frame(dataset_id)
            if record is None or frame is None:
                update_run(run_id, status="error", error="Dataset not found.")
                return

        async def on_event(kind: str, payload: dict[str, Any]) -> None:
            run = get_run(run_id)
            if not run:
                return
            if kind == "planned":
                update_run(
                    run_id,
                    stage="analyzing",
                    specialists=[
                        {"key": s["key"], "name": s["name"], "desc": s.get("desc", ""),
                         "icon": s.get("icon", "variance"), "status": "queued"}
                        for s in payload["specialists"]
                    ],
                )
            elif kind in ("specialist_started", "specialist_done"):
                status = "running" if kind == "specialist_started" else "done"
                specs = [
                    {**s, "status": status} if s["key"] == payload["key"] else s
                    for s in (run.get("specialists") or [])
                ]
                update_run(run_id, specialists=specs)

        if dataset_id and frame is not None and record is not None:
            result = await run_pipeline(question, frame, record["profile"], record["filename"], on_event=on_event)
        else:
            result = await run_star_pipeline(question, on_event=on_event, scope=scope)
        update_run(run_id, status="done", stage="complete", result=result)

    except AgentConfigError as e:
        update_run(run_id, status="error", error=str(e))
    except Exception as e:  # surface the real reason rather than a silent stall
        log.exception("Investigation run %s failed", run_id)
        update_run(run_id, status="error", error=f"{type(e).__name__}: {e}")


@router.post("/investigations/run")
async def start_investigation_run(
    body: InvestigationRunRequest, user: dict[str, Any] = Depends(current_user)
) -> dict[str, Any]:
    """Kick off a real agent investigation against an uploaded dataset.
    Returns immediately with a run id — poll /investigations/runs/{id}."""
    question = body.question.strip()
    if not question:
        raise HTTPException(400, "question must not be empty")

    if body.dataset_id:
        record = get_dataset(body.dataset_id)
        if not record or record.get("owner") != user["email_key"]:
            raise HTTPException(404, "Dataset not found.")

    run = create_run(question, body.dataset_id, user["email_key"])
    # Recorded in the shared history immediately so it shows up even while running.
    append_history({"type": infer_investigation_type(question), "question": question, "at": run["created_at"]})
    asyncio.create_task(_execute_run(run["id"], question, body.dataset_id, body.scope))
    return run


@router.get("/investigations/runs")
def get_investigation_runs(user: dict[str, Any] = Depends(current_user)) -> list[dict[str, Any]]:
    return list_runs(user["email_key"], kind="investigation")


@router.get("/investigations/runs/{run_id}")
def get_investigation_run(run_id: str, user: dict[str, Any] = Depends(current_user)) -> dict[str, Any]:
    run = get_run(run_id)
    if not run or run.get("owner") != user["email_key"]:
        raise HTTPException(404, "Run not found.")
    return run


@router.get("/investigations/{type}")
def get_investigation_orchestration(type: InvestigationType) -> dict[str, Any]:
    """Causal graph (nodes, accelerators, progress, node detail popovers)
    for one investigation type — powers the Investigations page."""
    return load("investigations")["orchestrations"][type]


@router.get("/intelligence-answers/{type}")
def get_intelligence_answer(type: InvestigationType) -> dict[str, Any]:
    """The AI-synthesized narrative for one investigation type, with its
    [g]/[r]/[n] tone markup intact — the frontend owns rendering that."""
    return load("intelligence-answers")[type]
