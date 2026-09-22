"""
LLM client wiring.

Speaks the OpenAI chat-completions protocol, which is also what xAI (Grok)
and most other hosted providers accept — point OPENAI_BASE_URL at a different
provider and set OPENAI_MODEL to one of its models, and nothing else changes.

The API key is read from backend/.env (gitignored) and lives only on the
server — it is never sent to the browser and never appears in a response
body. That's the whole reason this is separate from the existing
/api/openai/chat proxy in routers/connectors.py, which is the portal
Advisor's deliberately different bring-your-own-key flow.
"""
import asyncio
import json
import logging
import os
import re
from pathlib import Path
from typing import Any

from dotenv import load_dotenv
from openai import AsyncOpenAI, RateLimitError

log = logging.getLogger(__name__)

# backend/.env — explicit path rather than find_dotenv(), which walks the call
# stack and misbehaves depending on how the process was started.
BACKEND_ROOT = Path(__file__).resolve().parent.parent.parent
load_dotenv(BACKEND_ROOT / ".env")

DEFAULT_MODEL = os.environ.get("OPENAI_MODEL", "gpt-4o-mini")

# Empty means the SDK's own default (api.openai.com). Set to e.g.
# https://api.x.ai/v1 to use Grok with an xAI key.
BASE_URL = os.environ.get("OPENAI_BASE_URL", "").strip() or None

# How long one call may spend waiting out per-minute rate limits before it
# gives up. Providers such as Groq cap free-tier keys at a few thousand tokens
# per minute, which the investigation fan-out exceeds in one go; without
# waiting, most specialists would fail on the first attempt.
RATE_LIMIT_BUDGET_S = float(os.environ.get("LLM_RATE_LIMIT_BUDGET_SECONDS", "240"))


class AgentConfigError(RuntimeError):
    """Raised when the server has no API key configured."""


def get_client() -> AsyncOpenAI:
    key = os.environ.get("OPENAI_API_KEY", "").strip()
    if not key:
        raise AgentConfigError(
            "No OPENAI_API_KEY configured. Add it to backend/.env and restart the server."
        )
    return AsyncOpenAI(api_key=key, base_url=BASE_URL)


_RETRY_IN = re.compile(r"try again in (\d+(?:\.\d+)?)\s*(ms|s|m)(?![a-z])", re.I)


def _retry_delay(exc: RateLimitError, attempt: int) -> float | None:
    """Seconds to wait before retrying, or None when a retry cannot help.

    A quota exhausted at the billing level is a 429 too, but no amount of
    waiting fixes it — it has to surface as-is so the user sees why.
    """
    text = str(exc)
    if "insufficient_quota" in text or "credit_balance_exhausted" in text:
        return None
    headers = getattr(getattr(exc, "response", None), "headers", None) or {}
    if headers.get("retry-after-ms"):
        return float(headers["retry-after-ms"]) / 1000 + 0.5
    if headers.get("retry-after"):
        try:
            return float(headers["retry-after"]) + 0.5
        except ValueError:
            pass
    if m := _RETRY_IN.search(text):
        value, unit = float(m.group(1)), m.group(2).lower()
        return {"ms": value / 1000, "s": value, "m": value * 60}[unit] + 0.5
    return min(2.0 * 2**attempt, 30.0)


async def chat_completion(**kwargs: Any) -> Any:
    """`client.chat.completions.create` that waits out per-minute rate limits.

    Every LLM call in the app goes through here so the retry policy lives in
    one place. Waiting is bounded by RATE_LIMIT_BUDGET_S per call.
    """
    client = get_client()
    kwargs.setdefault("model", DEFAULT_MODEL)
    waited = 0.0
    attempt = 0
    while True:
        try:
            return await client.chat.completions.create(**kwargs)
        except RateLimitError as exc:
            delay = _retry_delay(exc, attempt)
            if delay is None or waited + delay > RATE_LIMIT_BUDGET_S:
                raise
            log.info("Rate limited by the LLM provider; retrying in %.1fs", delay)
            await asyncio.sleep(delay)
            waited += delay
            attempt += 1


async def complete_json(
    system: str,
    user: str,
    schema: dict[str, Any],
    schema_name: str,
    *,
    model: str | None = None,
    temperature: float = 0.2,
) -> dict[str, Any]:
    """One structured-output call.

    Uses json_schema response format with strict=True so the model must
    return exactly this shape — the graph renders from these fields, so
    parsing prose and hoping would be the wrong trade.
    """
    response = await chat_completion(
        model=model or DEFAULT_MODEL,
        messages=[{"role": "system", "content": system}, {"role": "user", "content": user}],
        temperature=temperature,
        response_format={
            "type": "json_schema",
            "json_schema": {"name": schema_name, "strict": True, "schema": schema},
        },
    )
    content = response.choices[0].message.content or "{}"
    return json.loads(content)
