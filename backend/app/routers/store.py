"""Storage routes -- B10.

FIVE THIN ROUTES AROUND THE FROZEN CONTRACTS, never inside them. Every payload
these routes store was produced by /api/simulation/simulate or
/api/decision/record; this module validates a body, delegates to the repository
and returns what came back. No KPI, uplift, comparison, recommendation, risk or
weekly value is computed here, and none of the B1-B9 contracts changed to make
these work.

    POST /api/store/scenarios       store a simulation result (or a new version)
    GET  /api/store/scenarios/{id}  read one back
    POST /api/store/decisions       store a B7 decision record (or a new version)
    GET  /api/store/decisions/{id}  read one back
    GET  /api/store/decisions       list what has been stored

NO CLIENT-SUPPLIED FINGERPRINT. The dataset fingerprint is computed
server-side at write time and compared server-side at read time. No request
model below accepts one, so a client cannot assert which data its numbers came
from.

NO OWNER. No request model accepts an owner, an author or a user, and every
response carries `owner: null` with the reason. There is no authentication in
this project, so there is no actor to record.

UNAUTHENTICATED, AND SAID SO OUT LOUD -- B11
--------------------------------------------
B11 was DEFERRED: this project has no identity provider, and building access
control on a self-asserted email would be an enforcement claim with nothing
behind it. So no route here is guarded, and none of the 52 routes in this
application is.

That makes the two POSTs below WRITE ENDPOINTS ANY CALLER CAN REACH. Anyone who
can reach this process can store a scenario or a decision, read every stored
decision, and append versions to records they did not create. Nothing in the
store is private, nothing is attributable, and there is no quota.

This is stated rather than fixed because the fix requires authentication, which
does not exist. It is safe on a single-user localhost deployment and is NOT safe
on a shared or public one -- see the deployment note in README.md. Every route
below repeats it in its OpenAPI description, so a reader of the API docs cannot
miss it.
"""

from __future__ import annotations

from typing import Any

from fastapi import APIRouter, HTTPException, Query
from pydantic import BaseModel, ConfigDict, Field

from app.store import repository

router = APIRouter(prefix="/api/store", tags=["store"])

#: Repeated on every route's OpenAPI description. One sentence, one place.
UNAUTHENTICATED = (
    "UNAUTHENTICATED: this endpoint is reachable by any caller. This project has "
    "no identity provider, so the request is not attributed to anyone and nothing "
    "stored here is private. Records carry owner: null."
)


def _handle(exc: repository.StoreError) -> HTTPException:
    """Map a storage refusal onto the status code that describes it."""
    if isinstance(exc, repository.NotFound):
        return HTTPException(status_code=404, detail=str(exc))
    if isinstance(exc, repository.VersionConflict):
        # 409, not 422: the request is well formed and would have been accepted
        # a moment ago. The body names the version that is actually current so
        # the caller can reload rather than guess.
        return HTTPException(
            status_code=409,
            detail={"message": str(exc), "current_version": exc.current_version},
        )
    return HTTPException(status_code=422, detail=str(exc))


class SaveScenarioRequest(BaseModel):
    """One simulated scenario, with the context that scopes it.

    Both are payloads the client ALREADY holds -- the /simulation/context and
    /simulation/simulate responses -- posted back rather than recomputed, so
    what is stored is exactly what the user was looking at.
    """

    model_config = ConfigDict(extra="forbid")

    #: /api/simulation/context
    context: dict[str, Any]
    #: /api/simulation/simulate
    simulation: dict[str, Any]
    #: Display name. Falls back to the scenario's own.
    name: str | None = None
    #: Present to save a NEW VERSION of an existing scenario. Absent mints one.
    scenario_id: str | None = None
    #: The version the caller believes is current. A write against a stale
    #: expectation is refused with 409 rather than applied over unseen work.
    expected_version: int | None = None


class SaveDecisionRequest(BaseModel):
    """One B7 decision record, stored whole and unedited."""

    model_config = ConfigDict(extra="forbid")

    #: The payload returned by POST /api/decision/record.
    record: dict[str, Any]
    #: Lineage, when the client has it. Both are server-minted ids returned by
    #: earlier store calls -- a client cannot invent one that resolves.
    investigation_id: str | None = None
    scenario_id: str | None = None
    #: Present to save a NEW VERSION of an existing decision.
    decision_id: str | None = None
    expected_version: int | None = None


@router.post(
    "/scenarios",
    summary="Store a simulation result (unauthenticated write)",
    description=UNAUTHENTICATED,
)
def store_scenario(body: SaveScenarioRequest) -> dict[str, Any]:
    """Store a simulation result durably.

    Appends a version; never overwrites one. The response carries the
    server-minted `scenario_id`, the durable `investigation_id` this scenario
    belongs to, the version, and the dataset fingerprint the result was
    computed against.
    """
    try:
        return repository.save_scenario(
            context=body.context,
            simulation=body.simulation,
            name=body.name,
            scenario_id=body.scenario_id,
            expected_version=body.expected_version,
        )
    except repository.StoreError as exc:
        raise _handle(exc) from exc


@router.get(
    "/scenarios/{scenario_id}",
    summary="Read a stored scenario (unauthenticated read)",
    description=UNAUTHENTICATED,
)
def read_scenario(scenario_id: str, version: int | None = None) -> dict[str, Any]:
    """Read a stored scenario back, exactly as it was written.

    `stale` says whether the source data has changed since. Nothing is
    recomputed either way.
    """
    try:
        return repository.load_scenario(scenario_id, version=version)
    except repository.StoreError as exc:
        raise _handle(exc) from exc


@router.post(
    "/decisions",
    summary="Store a decision record (unauthenticated write)",
    description=UNAUTHENTICATED,
)
def store_decision(body: SaveDecisionRequest) -> dict[str, Any]:
    """Store a decision record durably. Decision Center is the system of record.

    The record is stored untouched -- `decision_id: null`, `status: "draft"`,
    `meta.persisted: false`, exactly as B7 wrote it -- and the storage identity
    lives in the envelope around it. That is what lets a record read back out
    of the store be handed straight to /api/decision/briefing.
    """
    try:
        return repository.save_decision(
            record=body.record,
            investigation_id=body.investigation_id,
            scenario_id=body.scenario_id,
            decision_id=body.decision_id,
            expected_version=body.expected_version,
        )
    except repository.StoreError as exc:
        raise _handle(exc) from exc


@router.get(
    "/decisions",
    summary="List stored decisions (unauthenticated read)",
    description=UNAUTHENTICATED,
)
def list_decisions(limit: int = Query(default=50, ge=1, le=200)) -> dict[str, Any]:
    """Every stored decision, newest first. Headers only."""
    return repository.list_decisions(limit=limit)


@router.delete(
    "/decisions",
    summary="Clear the decision history (unauthenticated write)",
    description=UNAUTHENTICATED,
    status_code=200,
)
def clear_decisions() -> dict[str, Any]:
    """Empty the decision history.

    THE ONE DELETE ON THIS TABLE, and a deliberate exception to the store's
    append-only rule. Decision Center offers it as an explicit, confirmed
    action; nothing else in the application removes a decision, and there is no
    single-row delete and no filtered clear -- a history that looks empty is
    empty.

    It removes decisions and their versions. The investigations and scenarios
    those decisions referenced stay: they are the evidence a decision was taken
    from and are referenced by scenario results as well.

    Answers with the count removed rather than 204, so the caller can report
    what happened. Clearing an already-empty history is a success with zero.
    """
    removed = repository.clear_decisions()
    return {"deleted": removed, "total": repository.count_decisions()}


@router.get(
    "/decisions/{decision_id}",
    summary="Read a stored decision (unauthenticated read)",
    description=UNAUTHENTICATED,
)
def read_decision(decision_id: str, version: int | None = None) -> dict[str, Any]:
    """Read a stored decision back, byte for byte."""
    try:
        return repository.load_decision(decision_id, version=version)
    except repository.StoreError as exc:
        raise _handle(exc) from exc


# --- Decision Center board decisions -----------------------------------------


class SaveBoardDecisionRequest(BaseModel):
    """The Decision Center board, stored whole: the scenarios as the Simulation
    Studio snapshotted them, the chosen slot and the rationale."""

    model_config = ConfigDict(extra="forbid")

    scenarios: list[dict[str, Any]]
    chosen_slot: int | None = None
    rationale: str | None = Field(default=None, max_length=4000)


@router.post(
    "/board-decisions",
    summary="Store a Decision Center board decision (unauthenticated write)",
    description=UNAUTHENTICATED,
)
def store_board_decision(body: SaveBoardDecisionRequest) -> dict[str, Any]:
    try:
        return repository.save_board_decision(body.model_dump())
    except repository.StoreError as exc:
        raise _handle(exc) from exc


@router.get(
    "/board-decisions",
    summary="List stored board decisions (unauthenticated read)",
    description=UNAUTHENTICATED,
)
def list_board_decisions(limit: int = Query(default=50, ge=1, le=200)) -> dict[str, Any]:
    return repository.list_board_decisions(limit=limit)


@router.get(
    "/board-decisions/{decision_id}",
    summary="Read one board decision back (unauthenticated read)",
    description=UNAUTHENTICATED,
)
def load_board_decision(decision_id: str) -> dict[str, Any]:
    try:
        return repository.load_board_decision(decision_id)
    except repository.StoreError as exc:
        raise _handle(exc) from exc


@router.delete(
    "/board-decisions",
    summary="Clear the board decision history (unauthenticated write)",
    description=UNAUTHENTICATED,
    status_code=200,
)
def clear_board_decisions() -> dict[str, Any]:
    return {"removed": repository.clear_board_decisions()}
