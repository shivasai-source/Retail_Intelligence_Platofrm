"""
The Analyst's conversation memory.

WHAT IT KEEPS. Not the transcript — a compact JSON record of what the
conversation established: the scope the reader keeps returning to, the figures
already looked up, and any preference they stated ("in USD", "just Modern
Trade"). That is what makes "and what about last year?" resolvable ten turns
later without replaying every word of the thread.

WHY A SUMMARY AND NOT THE TRANSCRIPT. A chat history grows without bound, and
every turn re-sends all of it: cost and latency climb until the model's context
is full and the oldest turns fall off silently, which is the worst failure mode
— the assistant forgets without saying so. A bounded fact store degrades
honestly instead: it fills, the reader can see how full, and they can clear it.

WHERE IT LIVES. In the request, not on the server. The browser holds the memory
and sends it back with each question; this module only folds a new turn into it
and reports how full it is. That keeps a shared deployment from leaking one
reader's context into another's, and it means memory survives exactly as long as
the reader's tab — which is what "reset whenever you want" should mean.

THE FIGURES ARE NOT AUTHORITATIVE. A remembered figure is a note about what was
said, never a substitute for looking it up: the prompt tells the model to
re-fetch before restating one, because the same question under a different
filter has a different answer.
"""
import json
from typing import Any

from app.agents.star_tools import FILTER_FIELDS as T_FILTER_FIELDS

#: The ceiling, in characters of serialised memory. Chosen so the memory block
#: stays a small fraction of the prompt even when full: ~2400 characters is
#: roughly 600 tokens, against a system prompt of ~900 and tool results that
#: can run to several thousand. Raising this trades money and latency on every
#: turn for recall the reader rarely needs.
CAPACITY_CHARS = 2400

#: Hard caps per section, so one runaway kind of fact cannot crowd out the
#: others. Oldest goes first within a section — the newest scope and the newest
#: figures are the ones a follow-up is most likely to mean.
MAX_FACTS = 12
MAX_FIGURES = 14
MAX_PREFERENCES = 6

EMPTY: dict[str, Any] = {"scope": None, "facts": [], "figures": [], "preferences": []}


def empty() -> dict[str, Any]:
    """A fresh, empty memory. Also what `reset` returns to."""
    return {"scope": None, "facts": [], "figures": [], "preferences": []}


def normalise(raw: Any) -> dict[str, Any]:
    """Accept whatever the client sent and return a well-formed memory.

    The client is the owner of this object, so it is validated on the way in
    like any other request field: a malformed or oversized memory becomes a
    smaller valid one rather than an error the reader cannot act on.
    """
    if not isinstance(raw, dict):
        return empty()
    out = empty()
    scope = raw.get("scope")
    if isinstance(scope, dict) and scope:
        # Only known filter fields, stringified — this is fed back to the model
        # as context, never used as a filter without it re-stating one.
        out["scope"] = {
            str(k): v for k, v in list(scope.items())[:12] if k in T_FILTER_FIELDS
        } or None
    for key, cap in (("facts", MAX_FACTS), ("figures", MAX_FIGURES), ("preferences", MAX_PREFERENCES)):
        values = raw.get(key)
        if isinstance(values, list):
            cleaned = [str(v)[:220] for v in values if isinstance(v, (str, int, float)) and str(v).strip()]
            # Keep the NEWEST when over cap: a follow-up refers to recent turns.
            out[key] = cleaned[-cap:]
    return _trim_to_capacity(out)


def _serialised_length(memory: dict[str, Any]) -> int:
    return len(json.dumps(memory, default=str, ensure_ascii=False))


def _trim_to_capacity(memory: dict[str, Any]) -> dict[str, Any]:
    """Drop the oldest entries until the memory fits.

    Facts go before figures: a figure is a concrete answer the reader may refer
    back to, while a fact is a restatement that is usually recoverable.
    """
    guard = 0
    while _serialised_length(memory) > CAPACITY_CHARS and guard < 200:
        guard += 1
        if memory["facts"]:
            memory["facts"].pop(0)
        elif memory["figures"]:
            memory["figures"].pop(0)
        elif memory["preferences"]:
            memory["preferences"].pop(0)
        else:
            memory["scope"] = None
            break
    return memory


def usage(memory: dict[str, Any]) -> dict[str, Any]:
    """How full the memory is — the number the UI shows as a percentage.

    Reported as a share of CAPACITY_CHARS rather than of an entry count,
    because that is what actually bounds the prompt.
    """
    used = _serialised_length(memory)
    pct = int(round(min(1.0, used / CAPACITY_CHARS) * 100))
    return {
        "used_chars": used,
        "capacity_chars": CAPACITY_CHARS,
        "percent": pct,
        "full": pct >= 100,
        "entries": len(memory.get("facts", []))
        + len(memory.get("figures", []))
        + len(memory.get("preferences", [])),
    }


def render(memory: dict[str, Any]) -> str:
    """The memory as a prompt block, or "" when there is nothing to say."""
    if not memory:
        return ""
    lines: list[str] = []
    if memory.get("scope"):
        pairs = ", ".join(f"{k}={v}" for k, v in memory["scope"].items())
        lines.append(f"Scope the reader has been working in: {pairs}")
    for preference in memory.get("preferences", []):
        lines.append(f"Preference: {preference}")
    for fact in memory.get("facts", []):
        lines.append(f"Established: {fact}")
    for figure in memory.get("figures", []):
        lines.append(f"Figure already given: {figure}")
    if not lines:
        return ""
    return (
        "WHAT THIS CONVERSATION HAS ESTABLISHED\n"
        + "\n".join(lines)
        + "\n(Use this to resolve references like \"that\", \"the same period\" or \"and for "
        "Modern Trade?\". A remembered figure is a note about what was SAID — re-fetch before "
        "restating it, because the same question under a different filter has a different answer.)"
    )


def remember(
    memory: dict[str, Any],
    *,
    scope: dict[str, Any] | None = None,
    facts: list[str] | None = None,
    figures: list[str] | None = None,
    preferences: list[str] | None = None,
) -> dict[str, Any]:
    """Fold one turn's take-aways into the memory and trim it back to size."""
    out = {
        "scope": memory.get("scope"),
        "facts": list(memory.get("facts", [])),
        "figures": list(memory.get("figures", [])),
        "preferences": list(memory.get("preferences", [])),
    }
    if scope:
        # The newest scope wins outright rather than merging: merging a
        # channel filter into last turn's region filter invents a selection
        # the reader never asked for.
        out["scope"] = {str(k): v for k, v in scope.items() if k in T_FILTER_FIELDS} or None
    for key, values, cap in (
        ("facts", facts, MAX_FACTS),
        ("figures", figures, MAX_FIGURES),
        ("preferences", preferences, MAX_PREFERENCES),
    ):
        for value in values or []:
            text = str(value).strip()[:220]
            if text and text not in out[key]:
                out[key].append(text)
        out[key] = out[key][-cap:]
    return _trim_to_capacity(out)
