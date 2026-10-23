"""The MMM Analyst chat endpoint — natural-language questions over the MMM data.

    POST /api/mmm/analyst/ask

ONE ROUTE, ONE TURN, NO SESSION. State lives in the browser: the client sends
the prior turns and the conversation's fact store back with each question, the
same way app/routers/analyst.py does for TPO. Nothing is persisted here, so a
conversation cannot leak between users of a shared deployment.

WHY ITS OWN ROUTER AND NOT A `module` PARAMETER ON TPO'S. The two answer from
different datasets, and the failure modes differ: this one 503s when no MMM
dataset is installed, which is a state TPO's route has no equivalent of. A
shared route with a branch per module would have both sets of error paths in
one function and a reader of either would have to read both.
"""

import logging
from typing import Any, Literal

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field

from app.agents import analyst_memory
from app.agents.client import AgentConfigError
from app.agents.mmm_analyst import AnalystError, answer, deflect_why
from app.deps import current_user
from app.mmm.loader import MmmDatasetMissing

log = logging.getLogger(__name__)

router = APIRouter(prefix="/api/mmm/analyst", tags=["mmm"])


class Turn(BaseModel):
    role: Literal["user", "assistant"]
    content: str


class AskRequest(BaseModel):
    # Bounded at the boundary: an unbounded question is a way to run up a bill
    # on a prompt that was never going to be a question.
    question: str = Field(min_length=1, max_length=2000)
    history: list[Turn] = Field(default_factory=list, max_length=20)
    currency: str = "INR"
    #: The conversation's fact store, owned by the browser and sent back each
    #: turn. `None` and `{}` both mean a fresh conversation, which is what the
    #: reader's Reset sends.
    memory: dict[str, Any] | None = None
    #: What the MMM Insights Hub is showing: the charts this chat added (with
    #: their ids), which of the hub's own charts are hidden, which KPI cards
    #: were added, and the trend's granularity. The browser owns that state —
    #: see frontend/src/mmm/hubLayout.ts — so it is sent, never remembered here.
    dashboard: dict[str, Any] | None = None


@router.post("/ask")
async def ask(
    body: AskRequest,
    _user: dict[str, Any] = Depends(current_user),
) -> dict[str, Any]:
    """Answer one question about the marketing-mix data.

    A purely causal question is turned away before any model call — see
    `deflect_why`. It comes back as a normal answer with `deflected: true`, not
    as an error, because from the reader's side it is simply what the bot said.
    """
    refusal = deflect_why(body.question)
    if refusal:
        # A deflection establishes nothing, so the memory passes through
        # untouched rather than recording a question that was never answered.
        store = analyst_memory.normalise(body.memory)
        return {
            "answer": refusal,
            "steps": [],
            "charts": [],
            # One shape for every turn: the browser reads `actions` on all of
            # them, and a missing key would be a second code path in the UI for
            # a turn that simply changed nothing.
            "actions": [],
            "deflected": True,
            "memory": store,
            "memory_usage": analyst_memory.usage(store),
        }

    try:
        result = await answer(
            body.question,
            history=[t.model_dump() for t in body.history],
            currency=body.currency,
            memory=body.memory,
            dashboard=body.dashboard,
        )
    except AgentConfigError as e:
        # The one failure with a fix the reader can act on, so it keeps its own
        # status and its own message rather than becoming a generic 500.
        raise HTTPException(503, str(e)) from e
    except MmmDatasetMissing as e:
        # The MMM twin of that: nothing to answer FROM, and the fix is a page
        # away. Carries the same flag every other MMM route uses, so the
        # frontend can tell "not loaded yet" from "loaded and genuinely zero".
        raise HTTPException(
            503,
            detail={
                "detail": str(e),
                "mmm_dataset_missing": True,
                "action": "Connect an MMM source on MMM Data Connections first.",
            },
        ) from e
    except AnalystError as e:
        raise HTTPException(422, str(e)) from e
    except Exception as e:
        log.exception("mmm analyst turn failed")
        raise HTTPException(
            502, f"The Analyst couldn't answer that: {type(e).__name__}"
        ) from e

    return {**result, "deflected": False}
