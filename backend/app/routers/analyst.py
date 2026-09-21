"""The Analyst chat endpoint — natural-language questions over the TPO data.

One route, one turn. State lives in the browser: the client sends the prior
turns back with each question, exactly as the module's other agent routes do.
Nothing is persisted server-side, so a conversation cannot leak between users
of a shared deployment.
"""
import logging
from typing import Any, Literal

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field

from app.agents import analyst_memory
from app.agents.analyst import AnalystError, answer, deflect_why
from app.agents.client import AgentConfigError
from app.deps import current_user

log = logging.getLogger(__name__)

router = APIRouter(prefix="/api/analyst", tags=["analyst"])


class Turn(BaseModel):
    role: Literal["user", "assistant"]
    content: str


class AskRequest(BaseModel):
    # Bounded at the boundary: an unbounded question is a way to run up a bill
    # on a prompt that was never going to be a question.
    question: str = Field(min_length=1, max_length=2000)
    history: list[Turn] = Field(default_factory=list, max_length=20)
    currency: str = "INR"
    # The conversation's fact store, owned by the browser and sent back each
    # turn. Validated and trimmed server-side — see app/agents/analyst_memory.
    # `None` and `{}` both mean "a fresh conversation", which is what the
    # reader's Reset sends.
    memory: dict[str, Any] | None = None


@router.post("/ask")
async def ask(
    body: AskRequest,
    _user: dict[str, Any] = Depends(current_user),
) -> dict[str, Any]:
    """Answer one question about the promotion data.

    A purely causal question is turned away here, before any model call — see
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
        )
    except AgentConfigError as e:
        # The one failure with a fix the reader can act on, so it keeps its own
        # status and its own message rather than becoming a generic 500.
        raise HTTPException(503, str(e)) from e
    except AnalystError as e:
        raise HTTPException(422, str(e)) from e
    except Exception as e:
        log.exception("analyst turn failed")
        raise HTTPException(502, f"The Analyst couldn't answer that: {type(e).__name__}") from e

    return {**result, "deflected": False}
