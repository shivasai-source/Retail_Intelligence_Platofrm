import asyncio
import logging
from typing import Any

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel

from app.agents.client import AgentConfigError
from app.agents.intelligence_agent import analyse, recommend
from app.deps import current_user
from app.intelligence_engine import SECTIONS, build_intelligence_facts
from app.investigation_runs import create_run, get_run, latest_completed, list_runs, update_run

log = logging.getLogger(__name__)

# NOTE: deliberately NOT /api/intelligence. That prefix was owned by the
# seed-JSON reader GET /api/intelligence/{type} (since removed), whose Literal
# path param would have swallowed /facts and /runs; the distinct prefix is
# kept because it is collision-proof by construction rather than by order.
router = APIRouter(prefix="/api/promotion-intelligence", tags=["promotion-intelligence"])


class IntelligenceRequest(BaseModel):
    """Promotion Intelligence deepens an investigation.

    Pass `investigation_run_id` and the question, scope and prior findings are
    inherited from it — that is the intended path. `question`/`filters` are the
    fallback for analysing a scope directly with no investigation behind it.
    """

    investigation_run_id: str | None = None
    question: str | None = None
    filters: dict[str, Any] | None = None


@router.get("/facts")
def get_facts(
    year: int | None = None,
    month: int | None = None,
    channel: str | None = None,
    region: str | None = None,
    state: str | None = None,
    city: str | None = None,
    retailer: str | None = None,
    category: str | None = None,
    brand: str | None = None,
    product: str | None = None,
    promotion: str | None = None,
    promotion_type: str | None = None,
    sections: str = "core",
    _user: dict[str, Any] = Depends(current_user),
) -> dict[str, Any]:
    """The deterministic picture — no model involved.

    Accepts the full investigation filter vocabulary, not a subset: when this
    page deepens an investigation scoped to (say) October Seasonal promotions,
    dropping `month` and `promotion_type` would show whole-year figures under
    that investigation's heading — numbers that quietly describe something
    else. List dimensions take comma-separated values.

    `sections` is a comma-separated subset of core|dimensions|risk|waterfall.
    Each breakdown re-runs the KPI engine once per group, so computing all of
    them is ~40s; the page requests one tab's worth at a time and results are
    memoised per scope.
    """
    filters: dict[str, Any] = {}
    if year:
        filters["year"] = year
    if month:
        filters["month"] = month
    for name, raw in (
        ("channel", channel),
        ("region", region),
        ("state", state),
        ("city", city),
        ("retailer", retailer),
        ("category", category),
        ("brand", brand),
        # An investigation drilled in from a risk alert is scoped to ONE
        # promotion on ONE product. Dropping those two here is what made
        # this page report a whole brand form under that alert's heading.
        ("product", product),
        ("promotion", promotion),
        ("promotion_type", promotion_type),
    ):
        values = [v.strip() for v in (raw or "").split(",") if v.strip()]
        if values:
            filters[name] = values

    wanted = tuple(s.strip() for s in sections.split(",") if s.strip() in SECTIONS)
    if not wanted:
        raise HTTPException(400, f"sections must name at least one of: {', '.join(SECTIONS)}")
    return build_intelligence_facts(filters, wanted)


@router.get("/context")
def get_context(
    investigation_run_id: str | None = None, user: dict[str, Any] = Depends(current_user)
) -> dict[str, Any]:
    """The investigation this page should deepen, plus any analysis already run
    against it — so the page can pick up where the user left off instead of
    asking them to re-run.

    Defaults to the most recent completed investigation; pass
    `investigation_run_id` to deepen a specific earlier one. `available` lists
    what else could be chosen, so the page can say plainly which investigation
    it is showing rather than silently resurrecting the newest.
    """
    if investigation_run_id:
        investigation = get_run(investigation_run_id)
        if not investigation or investigation.get("owner") != user["email_key"]:
            raise HTTPException(404, "Investigation run not found.")
    else:
        investigation = latest_completed(user["email_key"], kind="investigation")
    analysis = latest_completed(user["email_key"], kind="intelligence")
    available = [
        {"run_id": r["id"], "question": r["question"], "created_at": r["created_at"]}
        for r in list_runs(user["email_key"], limit=10, kind="investigation")
        if r.get("status") == "done"
    ]
    if not investigation:
        return {"investigation": None, "analysis": None, "available": available}

    result = investigation.get("result") or {}
    ctx = {
        "run_id": investigation["id"],
        "question": investigation.get("question"),
        "scope": result.get("global_filters") or {},
        "investigation_type": result.get("investigation_type"),
        "root_cause": (result.get("synthesis") or {}).get("root_cause"),
        "summary": (result.get("synthesis") or {}).get("summary"),
        "confidence": (result.get("synthesis") or {}).get("confidence"),
        "findings": [
            {"key": f.get("key"), "name": f.get("name"), "headline": f.get("headline"),
             "impact": f.get("impact"), "confidence": f.get("confidence")}
            for f in (result.get("findings") or [])
        ],
        "created_at": investigation.get("created_at"),
    }
    # Only offer a previous analysis if it was run against this same investigation.
    prior = None
    if analysis and (analysis.get("result") or {}).get("investigation_run_id") == investigation["id"]:
        prior = {"run_id": analysis["id"], "created_at": analysis.get("created_at")}
    return {"investigation": ctx, "analysis": prior, "available": available}


async def _execute(
    run_id: str, question: str, filters: dict[str, Any], prior: dict[str, Any] | None, investigation_run_id: str | None
) -> None:
    """Analyst then Advisor, streaming stage updates into the run record."""
    try:
        update_run(run_id, stage="computing", specialists=[
            {"key": "analyst", "name": "Intelligence Analyst", "desc": "Interprets the portfolio facts",
             "icon": "sparkles", "status": "queued"},
            {"key": "advisor", "name": "Recommendation Advisor", "desc": "Turns the diagnosis into actions",
             "icon": "target", "status": "queued"},
        ])
        # OFF THE EVENT LOOP. `build_intelligence_facts` is synchronous and slow
        # — it runs every breakdown the Analyst reads, each a pass of the KPI
        # engine per group — and awaiting nothing while it ran blocked the whole
        # server for its duration. Measured on a cold store, the POST that
        # STARTS this run took 4.4s to come back instead of 0.2s, because its
        # own response could not be flushed until this returned; on a wide scope
        # it is tens of seconds, and every other request queues behind it.
        #
        # The visible symptom was on the page that launched it: the run's
        # `specialists` are recorded immediately above, but the browser could
        # not fetch them until this finished, so the progress card sat with no
        # agents listed and no elapsed time for exactly as long as the slowest
        # phase of the run.
        #
        # A thread is the right tool and not a new risk: `get_facts` is a sync
        # `def` route, so FastAPI has always run this same function in its own
        # threadpool for every page load of the Intelligence tab.
        facts = await asyncio.to_thread(build_intelligence_facts, filters)

        def mark(key: str, status: str) -> None:
            run = get_run(run_id)
            if not run:
                return
            update_run(run_id, specialists=[
                {**s, "status": status} if s["key"] == key else s for s in (run.get("specialists") or [])
            ])

        update_run(run_id, stage="analyzing")
        mark("analyst", "running")
        analysis = await analyse(question, facts, prior)
        mark("analyst", "done")

        mark("advisor", "running")
        advice = await recommend(question, facts, analysis)
        mark("advisor", "done")

        update_run(
            run_id,
            status="done",
            stage="complete",
            result={
                "source": "star_schema",
                "investigation_run_id": investigation_run_id,
                "scope": filters,
                "facts": facts,
                "analysis": analysis,
                "recommendations": advice.get("recommendations", []),
                "do_not_do": advice.get("do_not_do", []),
                "expected_combined_impact": advice.get("expected_combined_impact"),
            },
        )
    except AgentConfigError as e:
        update_run(run_id, status="error", error=str(e))
    except Exception as e:
        log.exception("Intelligence run %s failed", run_id)
        update_run(run_id, status="error", error=f"{type(e).__name__}: {e}")


@router.post("/analyze")
async def start_analysis(
    body: IntelligenceRequest, user: dict[str, Any] = Depends(current_user)
) -> dict[str, Any]:
    """Run the Analyst + Advisor pair. Returns immediately with a run id —
    poll /intelligence/runs/{id}. Reuses the investigation run store so results
    persist and a reload doesn't re-run (and re-bill) the analysis."""
    prior: dict[str, Any] | None = None
    question = (body.question or "").strip()
    filters = {k: v for k, v in (body.filters or {}).items() if v not in (None, [], "")}

    if body.investigation_run_id:
        inv = get_run(body.investigation_run_id)
        if not inv or inv.get("owner") != user["email_key"]:
            raise HTTPException(404, "Investigation run not found.")
        if inv.get("status") != "done":
            raise HTTPException(409, "That investigation hasn't finished yet.")
        result = inv.get("result") or {}
        # Scope and question come FROM the investigation — this page deepens it
        # rather than analysing something unrelated.
        question = question or inv.get("question") or ""
        filters = filters or (result.get("global_filters") or {})
        prior = {
            "question": inv.get("question"),
            "synthesis": result.get("synthesis"),
            "findings": result.get("findings"),
        }

    if not question:
        raise HTTPException(400, "Provide investigation_run_id or a question.")

    run = create_run(question, None, user["email_key"], kind="intelligence")
    update_run(run["id"], stage="computing")
    asyncio.create_task(_execute(run["id"], question, filters, prior, body.investigation_run_id))
    return get_run(run["id"]) or run


@router.get("/runs")
def get_runs(user: dict[str, Any] = Depends(current_user)) -> list[dict[str, Any]]:
    return list_runs(user["email_key"], kind="intelligence")


@router.get("/runs/{run_id}")
def get_analysis_run(run_id: str, user: dict[str, Any] = Depends(current_user)) -> dict[str, Any]:
    run = get_run(run_id)
    if not run or run.get("owner") != user["email_key"]:
        raise HTTPException(404, "Run not found.")
    return run
