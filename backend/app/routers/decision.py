"""Decision Center routes -- B7.

Mounted at `/api/decision`. (The two seed-JSON page readers that once shared
the prefix, `/api/decision/{type}` and `/api/decision-default`, were removed
with routers/pages.py once nothing called them.)

No business logic here. The route validates a body and delegates to
app/tpo/decision.py, which assembles -- and recalculates nothing.
"""

from __future__ import annotations

from typing import Any

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, ConfigDict

from app.tpo import decision

router = APIRouter(prefix="/api/decision", tags=["decision"])


class DecisionRecordRequest(BaseModel):
    """The five results a decision record is assembled from.

    Every one is a payload the client ALREADY holds, posted back rather than
    recomputed. That is what guarantees Decision Center describes the same
    numbers the user was looking at in Simulation Studio -- there is no second
    evaluation that could disagree.
    """

    model_config = ConfigDict(extra="forbid")

    #: /api/simulation/context
    context: dict[str, Any]
    #: /api/simulation/simulate, for the scenario the user chose to carry.
    simulation: dict[str, Any]
    #: /api/simulation/recommend
    recommendation: dict[str, Any]
    #: /api/simulation/risk
    risk: dict[str, Any]
    #: /api/simulation/weekly, when the weekly view was open.
    weekly: dict[str, Any] | None = None
    #: /api/simulation/compare, when more than one scenario has been run.
    #: OPTIONAL and additive -- a record assembled without it says so rather
    #: than showing an empty comparison.
    comparison: dict[str, Any] | None = None
    #: /api/simulation/run -- the MEASURED baseline for the same scope. Optional
    #: for the same reason, and the only source of a measured value on this page.
    baseline: dict[str, Any] | None = None


@router.post("/record")
def decision_record(body: DecisionRecordRequest) -> dict[str, Any]:
    """Assemble one governed, read-only decision record.

    Every section is carried through verbatim from the contract that owns it.
    Nothing is recalculated, nothing is persisted, nothing is approved and no
    notification is sent.

    Sections are validated against each other first: a record that silently
    combined one scenario's impact with another's recommendation would read as
    authoritative and be wrong, so a mismatch is refused rather than merged.
    """
    try:
        return decision.build_record(
            context=body.context,
            scenario=body.simulation,
            recommendation=body.recommendation,
            risk=body.risk,
            weekly=body.weekly,
            comparison=body.comparison,
            baseline=body.baseline,
        )
    except decision.SectionMismatch as exc:
        # 422, not 500: the request is well-formed but internally inconsistent,
        # and the message names exactly which two sections disagree.
        raise HTTPException(status_code=422, detail=str(exc)) from exc
