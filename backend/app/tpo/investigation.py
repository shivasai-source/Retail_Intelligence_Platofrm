"""The RCA -> Simulation context contract -- B3.1.

WHAT THIS MODULE IS FOR. Simulation Studio needs to know what problem it is
being pointed at: which investigation, which question, which rows. This module
defines that handoff, validates it, and stamps every field with WHERE IT CAME
FROM. It is plumbing -- it computes no KPI, runs no scenario, and changes
nothing about how a simulation is calculated.

WHY EVERY FIELD CARRIES A PROVENANCE. The audit behind B3.1 found that the RCA
layer is entirely static: its causal graph, its node details, its progress and
confidence figures, and its context chips are all authored JSON. One of those
chips reports a trade spend of Rs 98.6 Cr for a scope the validated engine
measures at Rs 7.7 Cr. So a context assembled from RCA cannot be trusted
uniformly -- some of it is a real user input, some of it is display fiction,
and the difference has to travel WITH the data rather than live in somebody's
memory. `source` is that difference, and `unavailable` is a legitimate answer.

THREE RULES THIS MODULE ENFORCES
--------------------------------
NO INVENTED QUESTION. `activeInvestigation` seeds itself with an example
question copied from investigation-types.json, and a user who has never run an
investigation still carries it. A context built from that seed would put an
authored sentence in front of the user as though they had asked it. The seeded
examples are known -- they are in the same JSON -- so a question matching one
is reported as `seed_example`, not as `rca`, and does not count as the
investigation's question.

NO STATIC KPI AS A SIMULATION INPUT. RCA's numbers are presentation data. This
contract carries no KPI value at all: the scope is expressed as a FilterState
and Simulation measures it for itself, through the same engine the Command
Center uses.

NO SECOND FILTER MODEL. The scope is `FilterState`, the one the Insights Hub
builds and the one /simulation/run and /simulation/simulate already take. RCA's
own "context chips" are display strings -- "Modern Trade", "Apr - Jun 2025" --
and are NOT converted into filters here. A conversion that guessed at codes
from labels would be a second filter model wearing a disguise.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any, Literal

from app.data_loader import load
from app.tpo import formatting as F
from app.tpo.filters import FilterState, rows_for

#: Where a context field came from. `unavailable` is a real answer and is used
#: whenever no system in this project supplies the field.
Provenance = Literal["rca", "command_center", "filter_state", "seed_example", "unavailable"]

#: The handoff's origin. Only "rca" today; the field exists so a context
#: arriving from somewhere else later cannot be mistaken for an investigation.
ContextSource = Literal["rca"]

#: Stated once, wherever RCA has no structured field to offer.
_NO_QUESTION = (
    "The RCA investigation does not provide a structured question. The "
    "Investigations page stores a free-text query in browser state only."
)
_SEEDED_QUESTION = (
    "This matches an example question seeded from investigation-types.json, so "
    "it is not a question the user asked. Run an investigation to establish one."
)
_NO_ID = (
    "The RCA investigation has no identifier. Nothing in the investigations "
    "router, its data files or its client state assigns one, so a simulation "
    "cannot yet be traced back to the investigation that prompted it."
)
_NO_PROBLEM_STATEMENT = (
    "RCA provides no problem statement. Its node details are authored display "
    "copy, not a structured statement of the problem under investigation."
)
_NO_KPI = (
    "RCA does not record which KPI is under investigation. Its causal-graph "
    "nodes are presentation content and carry no structured KPI reference."
)


@dataclass(frozen=True)
class ContextField:
    """One field, its value, and where the value came from.

    A field with no value carries the reason instead. There is no third case
    and no silent fallback: a `value` of None always has a `reason`.
    """

    value: Any
    source: Provenance
    reason: str | None = None

    def as_dict(self) -> dict[str, Any]:
        return {"value": self.value, "source": self.source, "reason": self.reason}


def _available(value: Any, source: Provenance) -> ContextField:
    return ContextField(value=value, source=source, reason=None)


def _missing(reason: str) -> ContextField:
    return ContextField(value=None, source="unavailable", reason=reason)


# --- the seeded example questions -------------------------------------------


def seeded_questions() -> frozenset[str]:
    """Every example question shipped in investigation-types.json.

    Read from the same file the Investigations page seeds itself from, so this
    guard cannot drift from what is actually seeded. Compared case- and
    whitespace-insensitively because a question makes a round trip through an
    input box before it gets here.
    """
    questions: set[str] = set()
    for archetype in load("investigation-types"):
        example = archetype.get("example")
        if example:
            questions.add(_normalise(example))
        for question in archetype.get("questions", ()):
            questions.add(_normalise(question))
    return frozenset(questions)


def _normalise(text: str) -> str:
    return " ".join(text.split()).strip().lower()


def resolve_question(question: str | None, investigation_started: bool) -> ContextField:
    """The investigation's question, or an honest account of why there isn't one.

    `investigation_started` is the client telling us whether the user has ever
    actually run an investigation. It matters because the store carries a
    seeded default question from the moment the app loads: without this flag a
    fresh session would hand Simulation an authored sentence and call it the
    user's question.
    """
    if not question or not question.strip():
        return _missing(_NO_QUESTION)
    if not investigation_started:
        return ContextField(value=None, source="seed_example", reason=_SEEDED_QUESTION)
    if _normalise(question) in seeded_questions():
        return ContextField(value=None, source="seed_example", reason=_SEEDED_QUESTION)
    return _available(question.strip(), "rca")


# --- focus -------------------------------------------------------------------


def _one(values: frozenset[str] | None) -> str | None:
    """The single constrained value, or None when the dimension is
    unconstrained or holds several. A focus is a point, not a set."""
    if not values or len(values) != 1:
        return None
    return next(iter(values))


def _focus(state: FilterState) -> dict[str, Any]:
    """What the investigation is pointed AT, taken only from the FilterState.

    Every entry is either a dimension the user actually constrained to a single
    value -- which is a real, validated code -- or unavailable. Nothing is
    inferred from RCA's display copy: a chip reading "Modern Trade" is not a
    Channel_Id, and turning it into one by guessing is exactly the conversion
    this contract refuses to do.
    """
    def dimension(name: str, label: str) -> ContextField:
        code = _one(getattr(state, name))
        if code is None:
            return _missing(
                f"No single {label} in scope. Constrain {label} to one value for the "
                "investigation to have a focus on it."
            )
        return _available(code, "filter_state")

    period = (
        _available(F.period_label(state.year, state.month), "filter_state")
        if state.year is not None
        else _missing("No period in scope. The selection spans every year in the data.")
    )

    return {
        # RCA records no KPI under investigation, so this is always absent
        # today. The field exists because the contract should not have to
        # change shape when RCA gains one.
        "kpi": _missing(_NO_KPI).as_dict(),
        "promotion_id": dimension("promotion", "promotion").as_dict(),
        "product_id": dimension("product", "product").as_dict(),
        "channel_id": dimension("channel", "channel").as_dict(),
        "region": dimension("region", "region").as_dict(),
        "period": period.as_dict(),
    }


# --- the contract ------------------------------------------------------------


def build_context(
    state: FilterState,
    question: str | None = None,
    investigation_started: bool = False,
    investigation_id: str | None = None,
    investigation_type: str | None = None,
    problem_statement: str | None = None,
    source: ContextSource = "rca",
) -> dict[str, Any]:
    """Assemble and validate one RCA -> Simulation context.

    The scope is the caller's `FilterState` and is passed straight through --
    the same object /simulation/run and /simulation/simulate already accept, so
    the handoff cannot select different rows from the simulation it feeds.

    Nothing here is optional-but-defaulted. A field RCA cannot supply comes
    back with `value: null` and the reason, and `missing` lists them all so a
    caller can see the shape of the gap without walking the payload.
    """
    rows = rows_for(state)

    identity = (
        _available(investigation_id, "rca")
        if investigation_id
        else _missing(_NO_ID)
    )
    statement = (
        _available(problem_statement.strip(), "rca")
        if problem_statement and problem_statement.strip()
        else _missing(_NO_PROBLEM_STATEMENT)
    )
    resolved_question = resolve_question(question, investigation_started)

    context: dict[str, Any] = {
        "source": source,
        "investigation_id": identity.as_dict(),
        # The archetype IS real client state -- the user picks or infers it on
        # the Investigations page -- so it is reported as coming from RCA.
        "investigation_type": (
            _available(investigation_type, "rca") if investigation_type
            else _missing("No investigation type supplied.")
        ).as_dict(),
        "question": resolved_question.as_dict(),
        "problem_statement": statement.as_dict(),
        # THE one filter contract, carried whole. Sourced from the Command
        # Center because that is where the user's validated selection is made;
        # RCA itself produces no FilterState.
        "filter_state": _available(state.applied(), "command_center").as_dict(),
        "scope": {
            "period": F.period_label(state.year, state.month),
            "period_label": F.fiscal_label(state.year),
            "row_count": len(rows),
            "promoted_row_count": sum(1 for r in rows if r.is_promoted),
            "has_data": bool(rows),
        },
        "focus": _focus(state),
        # No KPI value appears anywhere in this payload, deliberately. RCA's
        # figures are display data; Simulation measures the scope itself.
        "carries_kpi_values": False,
    }
    context["missing"] = _missing_fields(context)
    context["complete"] = not context["missing"]
    return context


def _missing_fields(context: dict[str, Any]) -> list[str]:
    """Every field the contract could not fill, named. A gap the caller can
    see is a gap somebody can close."""
    missing: list[str] = []
    for key in ("investigation_id", "investigation_type", "question", "problem_statement"):
        if context[key]["value"] is None:
            missing.append(key)
    for key, field in context["focus"].items():
        if field["value"] is None:
            missing.append(f"focus.{key}")
    return missing
