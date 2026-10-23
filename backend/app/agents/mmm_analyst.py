"""The MMM Insights Hub's Analyst — the same assistant, over the MMM data.

WHAT IS SHARED WITH THE TPO ANALYST, AND WHAT IS NOT.

Shared, by import, because it is about CONVERSATION rather than about data:
the undo recogniser, the causal-question deflection, the image stripper, the
duplicate-table stripper, the history window, the step budget, and the
conversation's fact store. Each of those was written against a reported
failure of this product's chat, and a second copy would start drifting from
the first the day either was fixed.

NOT shared, because it is about THIS dataset and THIS page: the tools, the
system prompt, the period grammar (MMM has quarters; TPO has business weeks),
and the turn loop's own rules about which actions supersede which.

WHY THE LOOP IS NOT SHARED EITHER. It is about sixty lines of OpenAI
tool-protocol plumbing, and it would be tempting to factor out. What sits
INSIDE it is not shared: TPO drops a superseded `update_chart` when a
`set_layout` lands in the same turn, because its nine panels and its pinned
charts have names that look alike. MMM's rules are its own (one period and one
granularity per turn). Lifting the plumbing out would mean a shared function
with two sets of special cases threaded through it, which is harder to read
than the duplicate and easier to break in the module nobody was editing.

THE SERVER CHANGES NOTHING ON THE PAGE. Every page-driving tool returns a
described ACTION; the browser applies it, snapshots what it was, and offers
Undo. See app/agents/mmm_layout.py.
"""

from __future__ import annotations

import calendar
import copy
import json
import logging
import re
from datetime import date
from typing import Any

from app.agents import analyst_memory as memory_store
from app.agents import mmm_layout, mmm_scope
from app.agents import mmm_tools as M
from app.agents.analyst import (HISTORY_TURNS, MAX_STEPS, UNDO_ANSWER, _WHY_OPENERS,
                                AnalystError, _history_messages, _leader_sentence,
                                is_undo_request, strip_duplicate_table, strip_images)
from app.agents.client import chat_completion, get_client
from app.agents.hub_scope import ScopeError, resolve_month
from app.tpo import formatting as F

log = logging.getLogger(__name__)

__all__ = ["answer", "named_period", "period_hint", "period_only_request",
           "deflect_why", "is_undo_request", "AnalystError", "TOOLS",
           "WHY_DEFLECTION"]


# --- the "why" line ----------------------------------------------------------
#
# A PURELY CAUSAL QUESTION DOES NOT REACH THE MODEL, for the same reason it
# does not on the TPO hub: the honest answer is the same every time, so there
# is no key to spend on it.
#
# THE TEXT IS THIS HUB'S OWN. The TPO reply sends the reader to Investigations,
# which is a TPO page — a dead end dressed up as help if it arrives here. And
# MMM is the module where the question has somewhere real to go: the baseline
# and the decomposition are exactly what a reader asking "why did revenue
# move" wants, and this hub has both.
WHY_DEFLECTION = (
    "I can't tell you *why* something moved — that needs a designed "
    "experiment, and what this hub measures is description, not causation. "
    "Attributed revenue is a sharing rule, not a cause.\n\n"
    "What I CAN do is take the revenue apart. Ask me for the **revenue "
    "decomposition** and you get the baseline — what the revenue would have "
    "been without the ads — and the incremental revenue each channel is "
    "credited with. That is the closest this data comes to the question, and "
    "it is honest about what it is.\n\n"
    "Or ask me *what* the figure was, how it compares with a year ago, or "
    "which channel led on ROAS."
)


def deflect_why(question: str) -> str | None:
    """The reader-facing reply for a purely causal question, or None.

    Returns the message rather than raising: this is a normal answer the bot
    gives, not an error, and it renders in the thread like any other reply.
    """
    text = " ".join((question or "").casefold().split())
    if not text:
        return None
    return WHY_DEFLECTION if text.startswith(_WHY_OPENERS) else None


# --- the period a question names ---------------------------------------------

#: Every month word, longest first so "september" wins over "sep".
_MONTH_WORDS: dict[str, int] = {}
for _i, _name in enumerate(calendar.month_name):
    if _name:
        _MONTH_WORDS[_name.lower()] = _i
for _i, _name in enumerate(calendar.month_abbr):
    if _name:
        _MONTH_WORDS.setdefault(_name.lower(), _i)
_MONTH_WORDS.setdefault("sept", 9)
_MONTHS_RE = "|".join(sorted(_MONTH_WORDS, key=len, reverse=True))

#: "august 2026", "aug 2026", "august of 2026".
_MONTH_YEAR = re.compile(
    rf"\b(?P<month>{_MONTHS_RE})\b(?:\s+of)?\s+(?P<year>\d{{4}})\b", re.IGNORECASE)
_YEAR_MONTH = re.compile(
    rf"\b(?P<year>\d{{4}})\s+(?P<month>{_MONTHS_RE})\b", re.IGNORECASE)
#: "may'24", "sep '25". The apostrophe is required: "may 24" is the 24th of May
#: to as many readers as it is May 2024 — see hub_scope.parse_day.
_MONTH_SHORT_YEAR = re.compile(
    rf"\b(?P<month>{_MONTHS_RE})\b\s*['‘’]\s*(?P<year>\d{{2}})\b", re.IGNORECASE)
#: "q3 2025", "2025 q3", "third quarter of 2025".
_QUARTER_YEAR = re.compile(r"\bq(?P<q>[1-4])\b[\s,]*(?:of\s+)?(?P<year>\d{4})\b", re.IGNORECASE)
_YEAR_QUARTER = re.compile(r"\b(?P<year>\d{4})\b[\s,]*q(?P<q>[1-4])\b", re.IGNORECASE)
_WORD_QUARTER = re.compile(
    r"\b(?P<word>first|second|third|fourth|1st|2nd|3rd|4th)\s+quarter\b"
    r"(?:\s+of)?\s+(?P<year>\d{4})\b", re.IGNORECASE)
_QUARTER_WORDS = {"first": 1, "1st": 1, "second": 2, "2nd": 2,
                  "third": 3, "3rd": 3, "fourth": 4, "4th": 4}


def named_period(question: str) -> dict[str, int] | None:
    """`{"year": 2025, "quarter": 3}` or `{"year": 2026, "month": 8}`.

    None when the question names a period only partly (a month with no year),
    or names two different ones — "Q3 2025 vs Q3 2024" is a comparison, which
    is the model's job to scope, one call each.
    """
    text = " ".join((question or "").split())
    if not text:
        return None
    found: list[tuple[str, int, int]] = []
    for pattern in (_QUARTER_YEAR, _YEAR_QUARTER):
        for match in pattern.finditer(text):
            found.append(("quarter", int(match.group("year")), int(match.group("q"))))
    for match in _WORD_QUARTER.finditer(text):
        found.append(("quarter", int(match.group("year")),
                      _QUARTER_WORDS[match.group("word").lower()]))
    for pattern in (_MONTH_YEAR, _YEAR_MONTH):
        for match in pattern.finditer(text):
            month = resolve_month(match.group("month"))
            if month:
                found.append(("month", int(match.group("year")), month))
    for match in _MONTH_SHORT_YEAR.finditer(text):
        month = resolve_month(match.group("month"))
        if month:
            year = _expand(int(match.group("year")))
            if year:
                found.append(("month", year, month))

    unique = list(dict.fromkeys(found))
    if len(unique) != 1:
        return None
    # A SECOND PERIOD THE PATTERNS COULD NOT COMPLETE still makes this a
    # comparison. "compare q1 and q2 2025" matches Q2 2025 once — "q1" has no
    # year of its own — and hinting Q2 alone would state as fact that the
    # question is about one quarter when the reader asked about two.
    if _period_words(text) > 1:
        return None
    field, year, value = unique[0]
    return {"year": year, field: value}


def _period_words(text: str) -> int:
    """How many periods the message MENTIONS, however incompletely."""
    lowered = text.lower()
    quarters = len(re.findall(r"\bq[1-4]\b", lowered))
    quarters += len(re.findall(
        r"\b(?:first|second|third|fourth|1st|2nd|3rd|4th)\s+quarter\b", lowered))
    months = sum(
        1 for word in re.split(r"\W+", lowered) if word in _MONTH_WORDS
    )
    return quarters + months


def _expand(two: int) -> int | None:
    """'24 -> a year the MMM data actually holds, or None if it is ambiguous.

    None rather than a guess: the hint this feeds is a statement of fact to the
    model, and a wrong year stated confidently is worse than no hint.
    """
    matches = [y for y in mmm_scope._years() if y % 100 == two]
    return matches[0] if len(matches) == 1 else None


def period_hint(question: str) -> str | None:
    """The note appended to a question that names a period, or None.

    WHY A HINT AND NOT A FILTER. The model reads the question too, and this is
    the one part of it a model reliably gets wrong — the TPO Analyst answered
    "trade spend in august 2026" with the whole of 2026 to date. Stating the
    filter removes the arithmetic without removing its judgement about what
    the question is.
    """
    period = named_period(question)
    if not period:
        return None
    year = period["year"]
    if "quarter" in period:
        what, filt = f"Q{period['quarter']} {year}", f'{{"year": {year}, "quarter": {period["quarter"]}}}'
    else:
        month = period["month"]
        what = f"{calendar.month_name[month]} {year}"
        filt = f'{{"year": {year}, "month": {month}}}'
    return (
        f"[The question names {what}. If you look a figure up for that period, the filter "
        f"is {filt} — that period alone, not the year to date. Note the baseline is "
        f"re-estimated over whatever range is selected, so {what}'s ROAS is not the year's.]"
    )


# --- a message that is ONLY a period -----------------------------------------
#
# The same deterministic path TPO's Analyst has, and for the same reason: a
# reader who types "q3 2025" into a dashboard's assistant means "show me that",
# and the model guesses — sometimes moving the page, sometimes reading nine
# figures back as a bullet list and leaving the page where it was.
_PERIOD_LEAD = re.compile(
    r"^(?:take me to|show me|go to|switch to|jump to|take me|show|set|change|switch|"
    r"jump|filter|select|view|open)"
    r"(?:\s+(?:to|the|it|me|period|date|data|dates|range|timeframe|time))*\s+",
    re.IGNORECASE,
)
_NOISE = {"of", "in", "for", "the", "me", "data", "period", "please", "only", "view", "fy",
          "quarter", "q"}


def period_only_request(question: str) -> dict[str, Any] | None:
    """The action a bare period message asks for, or None if it is not one.

    Already validated by `mmm_scope`, so the caller can answer with no model
    call at all — instant, free, and the same every time.
    """
    text = " ".join((question or "").strip().split())
    if not text or "?" in text:
        return None
    stripped = _PERIOD_LEAD.sub("", text).strip().strip(".!,")
    if not stripped:
        return None

    # A DATE TYPED IN DIGITS is a period too. "11-03-2025" and "2025-03-11"
    # carry no month WORD, so `named_period` cannot see them — and a reader
    # who types one into a dashboard's assistant means the same thing by it as
    # one who writes "11 mar 2025".
    if _is_only_period(stripped):
        day = _single_day(stripped)
        if day:
            try:
                return mmm_scope.period_action(date_from=day, date_to=day)
            except ScopeError:
                return None

    # A BARE RANGE: "11 mar 2025 to 11 aug 2025", "march 2025 - august 2025".
    # Both ends are resolved by the same parser everything else uses, and the
    # action is the same one set_period would have returned.
    ends = _bare_range(stripped)
    if ends:
        try:
            return mmm_scope.period_action(date_from=ends[0], date_to=ends[1])
        except ScopeError:
            return None

    named = named_period(stripped)
    if named and _is_only_period(stripped):
        # A MESSAGE THAT MEANT A DAY AND FAILED TO PARSE IS NOT ITS MONTH.
        # "31 feb 2025" reached here — `_single_day` could not resolve it, and
        # falling through set the whole of February: twenty-eight days of
        # figures in answer to a date that does not exist. It goes to the
        # model instead, which relays the refusal.
        if _names_a_day(stripped):
            return None
        try:
            return mmm_scope.period_action(**named)
        except ScopeError:
            return None

    # A WHOLE MONTH THE WORD-PATTERNS DID NOT CATCH. "mar-24" is the form a
    # spreadsheet writes and `parse_day` reads it, but `named_period` wants an
    # apostrophe — so the most mechanical spelling of a month was the one that
    # cost a model call. Decided by the parser rather than by another regex:
    # a month is a range from the 1st to the last day of one month.
    if _is_only_period(stripped) and not _names_a_day(stripped):
        span = _single_span(stripped)
        if span:
            start, end = span
            if (start.day == 1 and start.month == end.month and start.year == end.year
                    and end.day == calendar.monthrange(end.year, end.month)[1]):
                try:
                    return mmm_scope.period_action(year=start.year, month=start.month)
                except ScopeError:
                    return None

    if re.fullmatch(r"\d{4}", stripped):
        try:
            return mmm_scope.period_action(year=int(stripped))
        except ScopeError:
            return None
    if re.fullmatch(r"(?:all|all data|all years|everything|all periods|full history)",
                    stripped, re.IGNORECASE):
        return mmm_scope.period_action(all_data=True)
    return None


def _single_day(text: str) -> str | None:
    """The ISO date when `text` names one DAY, else None.

    See the note in `period_only_request`. A date the MMM data does not cover
    is not resolved here — `period_action` refuses it, with the span, which is
    a better message than this function could write.
    """
    span = _single_span(text)
    if not span:
        return None
    start, end = span
    return start.isoformat() if start == end else None


#: The two forms in which a SHORT NUMBER beside a month is a year, not a day:
#: "may'24" and the spreadsheet's "mar-24". Removed before a day is looked for.
_SHORT_YEAR_FORMS = (
    re.compile(r"['\u2018\u2019]\s*\d{2}\b"),
    re.compile(r"\b([a-z]{3,})\s*[-/.]\s*(?<!\d)\d{2}(?!\d)"),
)


#: Two dates in one message. `parse_day` finds A month, A year and A day
#: wherever they are, so "11 mar 2025 to 11 aug 2025" comes back as 11 Aug
#: 2025 — a range collapsed to one end of itself. A message naming two periods
#: is a RANGE and belongs to the model, which will call set_period with both
#: ends; it is never one day and never one month.
_TWO_PERIODS = re.compile(
    r"\b(?:to|until|till|through|thru|and|vs|versus|against)\b", re.IGNORECASE)

#: What a reader puts BETWEEN the two ends of a range. Narrower than
#: `_TWO_PERIODS` above: "vs" and "against" join two periods for a COMPARISON,
#: which is a question for the model, not a range to put the page into. A bare
#: dash counts, so "mar 2025 - aug 2025" works, but only with space around it
#: — "11-03-2025" is one date and must not be split down the middle.
_RANGE_BETWEEN = re.compile(
    r"\s+(?:to|until|till|through|thru|\u2013|\u2014|-)\s+", re.IGNORECASE)


def _single_span(text: str) -> tuple[date, date] | None:
    """The (first, last) day `text` covers, or None if it is not one period.

    The one place the bare-period path asks the parser what a message MEANS,
    rather than asking another regex what it looks like — with one check in
    front of it, because the parser answers a question about a single period
    and this is where we decide the message asks one.
    """
    from app.agents.hub_scope import parse_day

    if _TWO_PERIODS.search(text) or _period_words(text) > 1:
        return None
    years = mmm_scope._years()
    try:
        return parse_day(text, years=years), parse_day(text, end=True, years=years)
    except ScopeError:
        return None


def _bare_range(text: str) -> tuple[str, str] | None:
    """The two ISO dates a bare range names, or None if it is not one.

    EACH END IS A PERIOD IN ITS OWN RIGHT, resolved by `_single_span`, so a
    range of months covers both months whole ("march 2025 to august 2025" is
    01 Mar to 31 Aug) while a range of days is exactly those days. That falls
    out of the parser rather than being special-cased: `end=True` already
    means "the last day this names".

    Returns None for anything carrying a word that is not part of the range,
    so "what was revenue from march to august" still reaches the model.
    """
    parts = _RANGE_BETWEEN.split(text, maxsplit=1)
    if len(parts) != 2:
        return None
    left, right = (p.strip() for p in parts)
    if not (left and right):
        return None
    if not (_is_only_period(left) and _is_only_period(right)):
        return None
    first, second = _single_span(left), _single_span(right)
    if not (first and second):
        return None
    # The FIRST day of the left end to the LAST day of the right end.
    start, end = first[0], second[1]
    if start > end:
        start, end = second[0], first[1]
    return start.isoformat(), end.isoformat()


def _names_a_day(text: str) -> bool:
    """True when the message names a DAY OF A MONTH, parseable or not.

    Used only after `_single_day` has already failed, to tell "31 feb 2025" —
    a date that does not exist — from "february 2025", which is a month.

    A NUMBER THAT IS NOT A VALID DAY STILL SHOWS ONE WAS MEANT. An earlier
    version required 1-31, so "32 mar 2025" fell through to the whole of
    March: a month of figures in answer to a date that cannot exist.

    A TWO-DIGIT YEAR IS NOT A DAY. "may'24" is May 2024, and reading its 24 as
    a day sent the most common period form anyone types back to the model.
    Both spellings of that form are removed before anything is counted.
    """
    cleaned = text.lower()
    for pattern in _SHORT_YEAR_FORMS:
        cleaned = pattern.sub(" ", cleaned)
    words = [w for w in re.split(r"\W+", cleaned) if w]
    if not any(w in _MONTH_WORDS for w in words):
        return False
    # A four-digit number is a year; one or two digits beside a month is a day.
    return any(w.isdigit() and len(w) <= 2 for w in words)


def _is_only_period(text: str) -> bool:
    """True when the message carries nothing BUT the period.

    Guards against "spend in q3 2025" being read as an instruction: whatever is
    left once the period and the joining words are removed has to be nothing.
    """
    words = [w for w in re.split(r"\W+", text.lower()) if w]
    rest = {
        w for w in words
        # resolve_month, not a fixed word list: "septem 2024" and "SEPT. 2024"
        # are months to the parser and were noise to this gate, so the most
        # tolerantly-spelled periods were the ones that cost a model call.
        if resolve_month(w) is None and not w.isdigit() and w not in _NOISE
        and not re.fullmatch(r"q[1-4]", w) and w not in _QUARTER_WORDS
    }
    return not rest


# --- tools -------------------------------------------------------------------

#: The filter every data tool takes. ONE definition, so two tools cannot drift
#: into accepting different scopes — the mistake that lets a chart and the
#: sentence beside it describe different days.
_FILTERS_SCHEMA: dict[str, Any] = {
    "type": "object",
    "description": (
        "Which days a figure covers. Year, quarter and month pick the period and are "
        "ANDed; date_from/date_to is a custom range and REPLACES them. channels picks "
        "which *_Spend columns count as ad spend (empty = all). promotion_types and "
        "events narrow the days WITHIN the period. Omit everything for the whole dataset."
    ),
    "properties": {
        "year": {"type": "integer"},
        "quarter": {"type": "integer", "minimum": 1, "maximum": 4},
        "month": {"type": "integer", "minimum": 1, "maximum": 12},
        "date_from": {"type": "string", "description": "YYYY-MM-DD"},
        "date_to": {"type": "string", "description": "YYYY-MM-DD"},
        "channels": {"type": "array", "items": {"type": "string"},
                     "description": "Spend column names, e.g. TV_Spend. get_schema lists them."},
        "promotion_types": {"type": "array", "items": {"type": "string"}},
        "events": {"type": "array", "items": {"type": "string",
                   "enum": ["festival", "seasonal", "promotion", "none"]}},
    },
    "additionalProperties": False,
}

TOOLS: list[dict[str, Any]] = [
    {
        "type": "function",
        "function": {
            "name": "get_kpis",
            "description": (
                "Every headline figure for a scope: revenue, ad spend, ROAS, the baseline "
                "and incremental revenue, the daily averages, and the count of days with ad "
                "spend — each with its change versus a year ago. START HERE for any 'what "
                "was/how much' question."
            ),
            "parameters": {"type": "object", "properties": {"filters": _FILTERS_SCHEMA}},
        },
    },
    {
        "type": "function",
        "function": {
            "name": "compare",
            "description": (
                "One breakdown, ranked. Use for 'which channel/promotion/event' and for "
                "'best, worst, top N'. Says in a note when the groups do NOT add up to the "
                "selection's total, which is most of them — read that note before writing a "
                "sentence about shares."
            ),
            "parameters": {
                "type": "object",
                "properties": {
                    "filters": _FILTERS_SCHEMA,
                    "by": {"type": "string", "enum": list(M.BREAKDOWN_DIMENSIONS),
                           "description": "channel, family (the group above channels), "
                                          "promotion (type) or event (day flag)."},
                    "metric": {"type": "string", "enum": list(M.BREAKDOWN_METRICS),
                               "description": "Which figure to rank by. get_schema says "
                                              "which dimension carries which."},
                    "limit": {"type": "integer", "minimum": 2, "maximum": 50},
                    "order": {"type": "string", "enum": ["best", "worst"],
                              "description": "Which END of the ranking. 'best' is the "
                                             "largest first, 'worst' the smallest. For "
                                             "'which was worst/lowest/weakest' you MUST "
                                             "pass 'worst' — the last row of a 'best' "
                                             "list is not the worst, it is the last one "
                                             "that fitted."},
                },
                "required": ["by"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "compare_periods",
            "description": (
                "This period against a year ago (YAGO), the period before it (PAGO) and a "
                "month ago (MAGO) — every metric, with the change. Use for 'how does this "
                "compare', 'versus last year', 'is it improving'. A window that falls partly "
                "outside the data comes back unavailable WITH A REASON; relay the reason "
                "rather than answering from the other windows."
            ),
            "parameters": {"type": "object", "properties": {"filters": _FILTERS_SCHEMA}},
        },
    },
    {
        "type": "function",
        "function": {
            "name": "get_trend",
            "description": (
                "Revenue, ad spend, baseline and ROAS per week or month over the period. Use "
                "for 'how did it move', 'which month was best', 'is it trending up'. Each "
                "bucket's baseline is estimated over its OWN days."
            ),
            "parameters": {
                "type": "object",
                "properties": {
                    "filters": _FILTERS_SCHEMA,
                    "granularity": {"type": "string", "enum": ["week", "month"]},
                },
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "get_decomposition",
            "description": (
                "What the revenue is made of: the baseline, and the incremental revenue each "
                "channel is credited with. Use for 'what drove revenue', 'how much was the "
                "baseline', 'what did the ads actually add'."
            ),
            "parameters": {"type": "object", "properties": {"filters": _FILTERS_SCHEMA}},
        },
    },
    {
        "type": "function",
        "function": {
            "name": "draw_chart",
            "description": (
                "Draw a chart IN THE CONVERSATION. The figures are computed here from the "
                "hub — you supply the shape, never the numbers. A pie or donut of something "
                "whose parts do not sum to the whole is downgraded to a bar and says so."
            ),
            "parameters": {
                "type": "object",
                "properties": {
                    "chart_type": {"type": "string", "enum": list(M.CHART_TYPES)},
                    "by": {"type": "string", "enum": list(M.BREAKDOWN_DIMENSIONS)},
                    "metric": {"type": "string", "enum": list(M.BREAKDOWN_METRICS)},
                    "filters": _FILTERS_SCHEMA,
                    "title": {"type": "string"},
                    "limit": {"type": "integer", "minimum": 2, "maximum": 6},
                    "order": {"type": "string", "enum": ["best", "worst"]},
                },
                "required": ["chart_type", "by"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "draw_trend_chart",
            "description": (
                "Draw one measure OVER TIME in the conversation, as a line. Use this rather "
                "than draw_chart when the question is about movement — a bar chart of months "
                "reads as a ranking of them."
            ),
            "parameters": {
                "type": "object",
                "properties": {
                    "metric": {"type": "string", "enum": ["roas", "spend", "revenue", "baseline"]},
                    "granularity": {"type": "string", "enum": ["week", "month"]},
                    "filters": _FILTERS_SCHEMA,
                    "title": {"type": "string"},
                },
                "required": ["metric"],
            },
        },
    },
    # --- the page -----------------------------------------------------------
    {
        "type": "function",
        "function": {
            "name": "set_period",
            "description": (
                "MOVE THE MMM INSIGHTS HUB to a period. Use when the reader asks to SEE a "
                "period rather than asking a figure about one. Dates are passed AS WRITTEN "
                "and resolved on the server — never work a date out yourself."
            ),
            "parameters": {
                "type": "object",
                "properties": {
                    "year": {"type": "integer"},
                    "quarter": {"type": "integer", "minimum": 1, "maximum": 4},
                    "month": {"type": "integer", "minimum": 1, "maximum": 12,
                              "description": "Needs `year` too. Selects that month alone."},
                    "date_from": {"type": "string",
                                  "description": "A date as the reader wrote it: "
                                                 "'11 Mar 2025', '11-03-2025', 'March 2025'. "
                                                 "A bare month means that month whole. Pass "
                                                 "both ends even when one runs past the data "
                                                 "— the range is cut back to the data and the "
                                                 "result says so. For ONE day, pass it as "
                                                 "both ends."},
                    "date_to": {"type": "string"},
                    "all_data": {"type": "boolean", "description": "Every year."},
                },
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "set_filter",
            "description": (
                "Narrow the hub to some channels, promotion types or events. The hub's own "
                "bar has no control for these, so say in your answer that you have applied "
                "one — otherwise the figures move for a reason the reader cannot see."
            ),
            "parameters": {
                "type": "object",
                "properties": {
                    "dimension": {"type": "string",
                                  "enum": ["channels", "promotion_types", "events"]},
                    "values": {"type": "array", "items": {"type": "string"},
                               "description": "Codes or display names; both are matched."},
                    "clear": {"type": "boolean", "description": "Clear this one."},
                    "clear_all": {"type": "boolean", "description": "Clear all three."},
                },
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "set_granularity",
            "description": "Draw the Ad Spend & ROAS Trend weekly or monthly.",
            "parameters": {
                "type": "object",
                "properties": {"granularity": {"type": "string", "enum": ["week", "month"]}},
                "required": ["granularity"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "set_layout",
            "description": (
                "Show or hide the hub's own charts and KPI cards, or put the page back to "
                "its defaults. For the charts THIS CHAT added, use update_chart instead."
            ),
            "parameters": {
                "type": "object",
                "properties": {
                    "show_charts": {"type": "array", "items": {"type": "string",
                                    "enum": list(mmm_layout.PANEL_IDS)}},
                    "hide_charts": {"type": "array", "items": {"type": "string",
                                    "enum": list(mmm_layout.PANEL_IDS)}},
                    "show_cards": {"type": "array", "items": {"type": "string",
                                   "enum": list(mmm_layout.CARD_IDS)}},
                    "hide_cards": {"type": "array", "items": {"type": "string",
                                   "enum": list(mmm_layout.CARD_IDS)}},
                    "reset": {"type": "boolean"},
                    "clear_pinned": {"type": "boolean",
                                     "description": "Remove every chart this chat added."},
                },
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "pin_chart",
            "description": (
                "Keep a chart ON THE HUB, beside its own panels. What is kept is the SHAPE: "
                "the browser redraws it from the hub's own scope, so it moves with the "
                "period. Use when asked to add a chart to the hub or the dashboard; "
                "draw_chart is for the conversation."
            ),
            "parameters": {
                "type": "object",
                "properties": {
                    "chart_type": {"type": "string", "enum": list(mmm_layout.PINNABLE_TYPES)},
                    "by": {"type": "string", "enum": list(M.BREAKDOWN_DIMENSIONS)},
                    "metric": {"type": "string", "enum": list(M.BREAKDOWN_METRICS)},
                    "title": {"type": "string"},
                },
                "required": ["chart_type", "by", "metric"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "update_chart",
            "description": (
                "Change a chart THIS CHAT put on the hub — its type, what it measures, its "
                "grouping or its title. Name it by the id in the state above. Only what you "
                "name changes. Do NOT remove and re-add a chart to change it.\n"
                "THIS TOOL CANNOT REMOVE ANYTHING, and it can only act on a chart listed "
                "under \"Charts YOU added\". To remove one of the hub's OWN six charts use "
                "set_layout with hide_charts; to remove one you added use set_layout with "
                "clear_pinned. If the chart the reader named is one of the hub's own, this is "
                "the wrong tool even when the names look alike."
            ),
            "parameters": {
                "type": "object",
                "properties": {
                    "chart_id": {"type": "string"},
                    "chart_type": {"type": "string", "enum": list(mmm_layout.PINNABLE_TYPES)},
                    "by": {"type": "string", "enum": list(M.BREAKDOWN_DIMENSIONS)},
                    "metric": {"type": "string", "enum": list(M.BREAKDOWN_METRICS)},
                    "title": {"type": "string"},
                },
                "required": ["chart_id"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "undo",
            "description": "Put back the last change you made to the hub.",
            "parameters": {"type": "object", "properties": {}},
        },
    },
    {
        "type": "function",
        "function": {
            "name": "get_schema",
            "description": (
                "What the MMM dataset holds: its years, its date range, every channel with "
                "its family, the promotion types, the events, and which metrics each "
                "breakdown carries. Call this when you are unsure a name exists."
            ),
            "parameters": {"type": "object", "properties": {}},
        },
    },
    {
        "type": "function",
        "function": {
            "name": "define_kpi",
            "description": (
                "What a metric means, transcribed from the code that computes it. Use this "
                "rather than describing a formula from memory."
            ),
            "parameters": {
                "type": "object",
                "properties": {"term": {"type": "string"}},
                "required": ["term"],
            },
        },
    },
]


def _run_tool(name: str, args: dict[str, Any], currency: str,
              dashboard: dict[str, Any] | None = None) -> dict[str, Any]:
    """Dispatch one tool call. Every figure that leaves here already carries
    its display string — the model is never asked to format one."""
    # THE PAGE-DRIVING TOOLS first and returning early: they take no filters,
    # compute nothing, and must not be run through the data layer below.
    if name == "set_period":
        return {"action": mmm_scope.period_action(
            year=args.get("year"),
            quarter=args.get("quarter"),
            month=args.get("month"),
            date_from=args.get("date_from"),
            date_to=args.get("date_to"),
            all_data=bool(args.get("all_data")),
        )}
    if name == "set_filter":
        return {"action": mmm_scope.filter_action(
            dimension=str(args.get("dimension") or ""),
            values=args.get("values"),
            clear=bool(args.get("clear")),
            clear_all=bool(args.get("clear_all")),
        )}
    if name == "set_granularity":
        return {"action": mmm_scope.granularity_action(str(args.get("granularity") or ""))}
    if name == "set_layout":
        return {"action": mmm_layout.layout_action(
            show_charts=args.get("show_charts"),
            hide_charts=args.get("hide_charts"),
            show_cards=args.get("show_cards"),
            hide_cards=args.get("hide_cards"),
            reset=bool(args.get("reset")),
            clear_pinned=bool(args.get("clear_pinned")),
            # What the page is showing, so a show of something already shown
            # is dropped rather than reported — see _only_what_moves.
            on_page=dashboard,
        )}
    if name == "pin_chart":
        return {"action": mmm_layout.pin_action(
            chart_type=str(args.get("chart_type") or "bar"),
            by=str(args.get("by") or ""),
            metric=str(args.get("metric") or ""),
            dimensions=M.BREAKDOWN_DIMENSIONS,
            metrics=M.BREAKDOWN_METRICS,
            title=str(args.get("title") or ""),
        )}
    if name == "update_chart":
        return {"action": mmm_layout.update_action(
            chart_id=str(args.get("chart_id") or ""),
            on_dashboard=list(dashboard.get("pinned") or []) if dashboard else [],
            chart_type=str(args.get("chart_type") or ""),
            by=str(args.get("by") or ""),
            metric=str(args.get("metric") or ""),
            title=str(args.get("title") or ""),
            dimensions=M.BREAKDOWN_DIMENSIONS,
            metrics=M.BREAKDOWN_METRICS,
        )}
    if name == "undo":
        return {"action": {"kind": "undo", "summary": "undid the last change"}}

    filters = args.get("filters") or {}
    if name == "get_kpis":
        return M.kpis(filters, currency)
    if name == "compare":
        return M.breakdown(filters, str(args.get("by") or "channel"),
                           str(args.get("metric") or ""),
                           limit=int(args.get("limit") or M.MAX_GROUPS), currency=currency,
                           order=str(args.get("order") or "best"))
    if name == "compare_periods":
        return M.comparison(filters, currency)
    if name == "get_trend":
        return M.trend(filters, str(args.get("granularity") or "month"), currency)
    if name == "get_decomposition":
        return M.decomposition(filters, currency)
    if name == "draw_chart":
        return M.build_chart(
            chart_type=str(args.get("chart_type") or "bar"),
            by=str(args.get("by") or "channel"),
            metric=str(args.get("metric") or ""),
            filters=filters,
            title=args.get("title"),
            limit=int(args.get("limit") or M.MAX_GROUPS),
            currency=currency,
            order=str(args.get("order") or "best"),
        )
    if name == "draw_trend_chart":
        return M.trend_chart(filters, str(args.get("metric") or "roas"),
                             str(args.get("granularity") or "month"), currency,
                             args.get("title"))
    if name == "get_schema":
        return M.schema_summary()
    if name == "define_kpi":
        return M.define_kpi(str(args.get("term") or ""))
    return {"error": f"unknown tool {name!r}"}


# --- the prompt ---------------------------------------------------------------


def _grounding() -> str:
    """Today's date and the years the MMM dataset actually holds.

    WHY THIS IS NOT OPTIONAL. A model has no clock and no view of the data, so
    "last year" resolves against its training cutoff. The years come from the
    installed file, so this cannot drift when the dataset is replaced.
    """
    today = date.today()
    try:
        schema = M.schema_summary()
        years = [int(y) for y in schema.get("years") or []]
        span = schema.get("date_range") or {}
    except Exception:
        return f"Today is {today:%d %B %Y}."
    if not years:
        return f"Today is {today:%d %B %Y}. No MMM dataset is installed."
    complete = [y for y in years if y < today.year]
    latest = max(complete) if complete else max(years)
    lines = [
        f"Today is {today:%d %B %Y}.",
        f"The MMM data covers {min(years)}–{max(years)}"
        + (f" ({span.get('from')} to {span.get('to')})." if span.get("from") else "."),
        f'"Last year" means {latest} — the most recent COMPLETE year in the data.',
    ]
    if today.year in years:
        lines.append(
            f"{today.year} is still in progress and holds only part of a year, so never "
            "compare it against a full year without saying so."
        )
    lines.append(
        "EVERY ONE OF THOSE YEARS HOLDS QUARTERS AND MONTHS. A question naming a quarter or "
        'a month with a year — "Q3 2025", "August 2026" — is about that period ALONE: '
        'filter {year: 2025, quarter: 3}. Never say the data does not cover a month of a '
        "year that is in the range."
    )
    lines.append(
        "Never filter to a year outside that range; say the data does not cover it instead."
    )
    lines.append(
        "A DATE RANGE IS DIFFERENT. Pass the dates the reader wrote, even when one end runs "
        "past the data: a range that OVERLAPS the data is cut back to it by the server, "
        "which tells you it did so, and only a range entirely outside is refused. Do not "
        "turn away \"1 Jan 2026 to 31 Dec 2027\" because 2027 is not in the list — ask for "
        "it and report the period you are given."
    )
    lines.append(
        "This dataset is ONE ROW PER DAY, so a single date is a period in its own right: "
        "\"11 Mar 2025\" means that day, not its month."
    )
    return "\n".join(lines)


def _system_prompt(currency: str) -> str:
    symbol = "₹" if currency == "INR" else "$"
    return f"""You are the Analyst on the MMM Insights Hub of a Marketing Mix Modelling \
product. You answer questions about MARKETING INVESTMENT AND ITS RETURN from the installed \
MMM dataset, and you can change what the hub is showing.

{_grounding()}

WHAT THIS DATA IS. One row per DAY. Each day carries the revenue, the spend on each media \
channel, and flags for whether a festival, a seasonal peak or a promotion was on. There are \
no stores, no products and no customers in it — if a question needs one of those, say it is \
not in the MMM data and point at the TPO modules.

THE BASELINE IS THE HEART OF IT, AND IT IS PER RANGE. Baseline Revenue is what the revenue \
would have been without the ads, estimated from the days in the SELECTED range by the \
formula R − (X − Y). Incremental Revenue is Total Revenue − Baseline Revenue, and ROAS is \
Incremental Revenue ÷ Total Ad Spend. Because the baseline is re-estimated for every range, \
a month's ROAS is NOT a slice of the year's, and two ranges' baselines are two separate \
estimates. Never add them up, never average them, and never present a bucket's figure as a \
part of a larger one's.

ROAS, NOT ROI. 1.00x is break-even — the ads returned exactly what was spent. Write it as a \
multiple to two decimal places: 1.53x. This hub's ROAS and the TPO module's ROI are both \
multiples of spend and are computed from different data; do not treat them as the same \
number.

EVERY FIGURE COMES FROM A TOOL. You have no figures of your own. Never state, estimate or \
round a number about this business that did not come back from a tool call in this turn. If \
a tool fails or returns nothing, say so plainly.

Money is in {currency} ({symbol}). Every figure arrives ALREADY WRITTEN — "₹1,523.67 Cr", \
"1.53x", "+2.64%". Quote those strings exactly as they are. You are not given the bare \
numbers behind them and must never reconstruct one: a figure you compute is not a figure \
this business measured.

Two decimal places everywhere, except counts of days, which are whole.

WHAT PARTS ADD UP, AND WHAT DOES NOT. Per channel, ad spend and ATTRIBUTED revenue are parts \
of one whole and may be described as shares. "Revenue on active days" is not — channels \
overlap, so those add to more than the period's revenue. ROAS is a ratio and never adds up. \
Every breakdown says so in a `note`; read it before writing a sentence about shares or \
totals.

YOU CAN CHANGE THE PAGE. Match the instruction to the tool:

  "show me 2025" / "go to Q3" / "last year"        -> set_period
  "show it weekly" / "monthly"                     -> set_granularity
  "just TV and OTT" / "only festival days"         -> set_filter
  "remove the Event Impact chart"                  -> set_layout, hide_charts
  "bring back the channel chart" / "show them all" -> set_layout, show_charts
  "add the incremental revenue card"               -> set_layout, show_cards
  "add a chart of ROAS by channel to the hub"      -> pin_chart
  "make that a column chart" / "group it by family"
  / "measure spend instead"                        -> update_chart
  "remove the charts you added"                    -> set_layout, clear_pinned
  "undo" / "put that back"                         -> undo

Rules, each of which has been broken in testing:
  * IF YOU CALLED NOTHING, YOU CHANGED NOTHING. Never say the page has changed \
unless a tool returned the change, and describe only what the tools you called \
actually did.
  * ONE instruction, ONE change. Do not tidy anything up, and NEVER hide a chart the \
reader did not ask you to hide. Applying a filter is not a reason to hide a chart; \
changing one chart is not a reason to remove another.
  * CHANGING a chart is update_chart. REMOVING one is set_layout. update_chart cannot \
remove anything and can only touch a chart listed under "Charts YOU added"; set_layout \
cannot change what a chart measures. Asked to remove "Event Impact", hide the `events` \
chart — do not re-group a chart of your own that happens to mention events. Asked to \
make a chart you added a column chart, call update_chart with its id — do not hide \
anything.
  * A question about a period is NOT a request to move to it. "What was ROAS in Q3?" is \
a look-up; "show me Q3" moves the page.
  * Charts in the chat are draw_chart / draw_trend_chart; charts on the page are pin_chart.
  * After changing the page, one short sentence saying what you did. The receipt beside \
your answer lists it — do not list it again.
  * IF ONE CALL IS REFUSED AND ANOTHER SUCCEEDED, say what you DID do. A tool that \
answers "nothing to do" has told you that one call changed nothing — not that the turn \
did. Never report a whole turn as no change when something in it moved.

THE CHARTS THE HUB CAN SHOW:
{mmm_layout.panel_catalogue()}

THE KPI CARDS:
{mmm_layout.card_catalogue()}

"DID FESTIVALS LIFT REVENUE?" IS AN EVENT QUESTION. Answer it from compare with \
by="event", which measures average daily revenue on the days that had the flag against the \
days that did not. Do NOT answer it from the decomposition: attributed revenue is a sharing \
rule — every rupee divided among whatever was running — and reading it as a lift says a \
festival caused revenue it was merely present for.

A CAUSAL QUESTION IS NOT YOURS. You report what the figures are and how they compare. You do \
not explain WHY something moved — that needs a designed experiment, and the honest answer is \
that this is description, not causation. Attributed revenue is a sharing rule, not a causal \
claim, and you must say so if you quote it as a channel's contribution.

ORDINARY QUESTIONS ARE FINE. Plain arithmetic, a unit conversion, a question about marketing \
in general — answer it briefly and directly. The rule above is about figures concerning \
THIS BUSINESS: the moment an answer needs one of those, it needs a tool.

A DEFINITION OF A METRIC ON THIS PAGE IS NOT AN ORDINARY QUESTION. "What does ROAS mean \
here?" asks what the number on the reader's screen IS, so it comes from define_kpi, which \
transcribes the formula from the code that computes it. The textbook definition of ROAS is \
not this hub's — ours divides INCREMENTAL revenue, against a baseline re-estimated for the \
selected range, by total ad spend. Answering from memory hands the reader a sentence that \
does not describe their own dashboard.

HOW TO WRITE. Lead with the answer in one sentence, then the figures that support it. Plain \
sentences and short bold labels; no preamble, no "based on the data", no restating the \
question. Never mention tools, filters as JSON, or that you called anything. If you drew a \
chart, do not restate its rows underneath it — the reader can see them."""


# --- one turn -----------------------------------------------------------------


#: Shorter than this, beside a chart, is not an answer to the question that
#: drew the chart. Long enough to let a genuine one-liner through ("Native
#: Advertising leads at 70.08x." is 41) and short enough to catch a stub.
MIN_CHART_ANSWER = 45


def _chart_sentence(charts: list[dict[str, Any]]) -> str:
    """A sentence written from the chart's own figures, so it cannot disagree
    with what is drawn.

    A LINE CHART IS NOT A RANKING. "Feb 2025 leads at 1.59x" describes a
    ranking of months, which is not what a reader asking how something MOVED
    is looking at — they want the shape, and the peak is the part of it a
    sentence can carry.
    """
    for chart in charts:
        points = [p for p in (chart.get("points") or []) if p.get("label")]
        if not points:
            continue
        top = max(points, key=lambda p: p.get("value") or 0)
        low = min(points, key=lambda p: p.get("value") or 0)
        unit = str(chart.get("unit") or "").split(" (")[0] or "It"
        if chart.get("type") == "line" and len(points) > 2:
            return (
                f"{unit} ran from {points[0]['display']} in {points[0]['label']} "
                f"to {points[-1]['display']} in {points[-1]['label']}, "
                f"peaking at {top['display']} in {top['label']} and bottoming at "
                f"{low['display']} in {low['label']}."
            )
        shown = top.get("display")
        return f"{top['label']} leads" + (f" at {shown}." if shown else ".")
    return ""


def _result(text: str, steps: list[dict[str, Any]], charts: list[dict[str, Any]],
            store: dict[str, Any], question: str,
            actions: list[dict[str, Any]] | None = None) -> dict[str, Any]:
    """One turn's reply, with the conversation's memory folded forward.

    THE MEMORY IS BUILT FROM WHAT WAS COMPUTED, NOT FROM WHAT WAS SAID — see
    app/agents/analyst_memory.py. A sentence the model phrased loosely cannot
    put a wrong figure into the context of every later turn.
    """
    scope: dict[str, Any] | None = None
    figures: list[str] = []

    for step in steps:
        result = step.get("result") or {}
        if not isinstance(result, dict):
            continue
        applied = result.get("applied_filters")
        if isinstance(applied, dict) and applied:
            scope = {k: v for k, v in applied.items() if v not in (None, "", [])}
        where = f" in {result['period']}" if result.get("period") else ""
        # The KPI list is the one result worth remembering figure by figure: it
        # is what a reader refers back to ("and the baseline again?").
        for kpi in result.get("kpis") or []:
            if isinstance(kpi, dict) and kpi.get("display"):
                figures.append(f"{kpi.get('label')}{where} = {kpi['display']}")

    facts = [f"Asked: {question[:160]}"]
    for action in actions or []:
        if action.get("summary") and action.get("kind") != "undo":
            facts.append(f"Changed the page: {action['summary']}")
    for chart in charts:
        if chart.get("title"):
            facts.append(f"Drew a chart: {chart['title']}")
        points = chart.get("points") or []
        if points:
            top = max(points, key=lambda pt: pt.get("value") or 0)
            if top.get("display"):
                figures.append(
                    f"{chart.get('title', 'chart')} — largest: {top['label']} {top['display']}"
                )

    updated = memory_store.remember(store, scope=scope, facts=facts, figures=figures[:6])

    # WHAT IS LEFT AFTER THE STRIPPERS HAS TO STILL BE AN ANSWER. A model that
    # restates a chart underneath it loses that restatement here — correctly —
    # and has sometimes left nothing behind but a stray remark. The sentence is
    # then written from the chart itself.
    answer = strip_duplicate_table(strip_images(text), charts)
    if charts and len(answer) < MIN_CHART_ANSWER:
        written = _chart_sentence(charts)
        if written:
            answer = f"{written} {answer}".strip() if answer else written

    return {
        "answer": answer,
        "steps": steps,
        "charts": charts,
        "actions": list(actions or []),
        "memory": updated,
        "memory_usage": memory_store.usage(updated),
    }


async def answer(
    question: str,
    *,
    history: list[dict[str, Any]] | None = None,
    currency: str = "INR",
    memory: dict[str, Any] | None = None,
    dashboard: dict[str, Any] | None = None,
) -> dict[str, Any]:
    """One chat turn on the MMM Insights Hub.

    Returns `{answer, steps, charts, actions, memory, memory_usage}` — the same
    shape TPO's Analyst returns, so the browser's conversation component does
    not care which hub it is on.
    """
    question = (question or "").strip()
    if not question:
        raise AnalystError("Ask me something about the marketing data.")

    # An undo needs no model and no key. The sentence the reader sees is
    # written by the browser from what the undo stack ACTUALLY put back; this
    # text is the fallback for a client that ignores `actions`.
    if is_undo_request(question):
        store = memory_store.normalise(memory)
        return _result(UNDO_ANSWER, [], [], store, question,
                       [{"kind": "undo", "summary": "undid the last change"}])

    # A message that is ONLY a period moves the page, with no model call.
    bare = period_only_request(question)
    if bare:
        store = memory_store.normalise(memory)
        label = bare["summary"].replace("set the period to ", "")
        return _result(f"Period's now {label}.", [], [], store, question, [bare])

    currency = F.normalise_currency(currency)
    get_client()  # fail fast when no key is configured

    store = memory_store.normalise(memory)
    remembered = memory_store.render(store)

    system = _system_prompt(currency) + "\n\n" + mmm_layout.dashboard_note(dashboard)
    if remembered:
        system = system + "\n\n" + remembered

    hint = period_hint(question)
    messages: list[dict[str, Any]] = [
        {"role": "system", "content": system},
        *_history_messages(history),
        {"role": "user", "content": f"{question}\n\n{hint}" if hint else question},
    ]

    steps: list[dict[str, Any]] = []
    charts: list[dict[str, Any]] = []
    actions: list[dict[str, Any]] = []

    for _ in range(MAX_STEPS):
        response = await chat_completion(messages=messages, tools=TOOLS, temperature=0.1)
        message = response.choices[0].message
        calls = message.tool_calls or []

        if not calls:
            text = (message.content or "").strip()
            if not text:
                raise AnalystError(
                    "I couldn't put an answer together. Try rephrasing the question."
                )
            return _result(text, steps, charts, store, question, actions)

        messages.append({
            "role": "assistant",
            "content": message.content,
            "tool_calls": [
                {"id": c.id, "type": "function",
                 "function": {"name": c.function.name, "arguments": c.function.arguments}}
                for c in calls
            ],
        })

        for call in calls:
            name = call.function.name
            try:
                args = json.loads(call.function.arguments or "{}")
            except json.JSONDecodeError:
                args = {}
            try:
                result = _run_tool(name, args, currency, dashboard)
            except Exception as e:  # a bad scope must not take the whole turn down
                log.warning("mmm analyst tool %s failed: %s", name, e, exc_info=True)
                result = {"error": f"{type(e).__name__}: {e}"}

            # THE BROWSER'S COPY OF THE CHART IS TAKEN FIRST, with its
            # numbers intact — it is what gets drawn. What the model is shown
            # below is redacted; see `for_model`.
            if isinstance(result, dict) and isinstance(result.get("chart"), dict):
                charts.append(copy.deepcopy(result["chart"]))

            if isinstance(result, dict) and isinstance(result.get("action"), dict):
                action = result["action"]
                # ONE PERIOD AND ONE GRANULARITY PER TURN. Asked for a range the
                # model has called set_period twice — once for the start month,
                # then for the range — and the receipt then read as two
                # contradictory changes that both happened. The later call is
                # the one it settled on, so the earlier is dropped rather than
                # applied and immediately overwritten.
                if action.get("kind") in ("period", "granularity"):
                    kind = action["kind"]
                    actions[:] = [a for a in actions if a.get("kind") != kind]
                # A SWAP OF THE HUB'S OWN CHARTS IS ONE CHANGE, NOT TWO — the
                # same rule TPO's Analyst needed, for the same reason: the
                # hub's panel names and the chat's chart titles look alike
                # ("Channel Performance" against "ROAS by Channel"), and a
                # sentence about one was editing the other as a side effect.
                #
                # DROPPED FROM THE ACTION LIST, NOT SKIPPED: `continue` here
                # would jump the tool-response message below, leaving an
                # assistant tool_call unanswered — which the provider rejects
                # outright on the next request.
                # ONE EDIT PER CHART PER TURN. Asked to remove a chart the
                # model called update_chart twice on the same pinned chart,
                # which is two undos for one instruction nobody gave. A second
                # edit of the same id is the model talking itself further into
                # a change, not a second thing the reader asked for.
                repeated = action.get("kind") == "update_chart" and any(
                    a.get("kind") == "update_chart" and a.get("id") == action.get("id")
                    for a in actions
                )
                superseded = repeated or (
                    action.get("kind") == "update_chart"
                    and any(a.get("kind") == "layout" for a in actions)
                )
                if action.get("kind") == "layout":
                    actions[:] = [a for a in actions if a.get("kind") != "update_chart"]
                if not superseded:
                    actions.append(action)

            # The schema dump is context for the model, not evidence for the
            # reader — kept out of `steps`.
            if name != "get_schema":
                steps.append({"tool": name, "arguments": args, "result": result})

            messages.append({
                "role": "tool",
                "tool_call_id": call.id,
                # REDACTED: a figure the model can read in words is not also
                # handed to it as a bare number to do arithmetic on. See
                # mmm_tools.for_model for the answer that cost.
                "content": json.dumps(M.for_model(result), default=str)[:24000],
            })

    # Out of steps. Make it answer from what it already has rather than
    # returning nothing — by this point the figures are usually all in hand.
    messages.append({
        "role": "user",
        "content": "Answer now, using only the figures you already have. "
                   "Do not call anything else.",
    })
    final = await chat_completion(messages=messages, temperature=0.1)
    text = (final.choices[0].message.content or "").strip()
    if not text:
        if charts:
            # A chart with no sentence is still an answer; write the sentence
            # from the chart rather than losing the turn.
            return _result(_leader_sentence(charts), steps, charts, store, question, actions)
        raise AnalystError(
            "That question needed more digging than I can do in one go. Try narrowing it."
        )
    return _result(text, steps, charts, store, question, actions)
