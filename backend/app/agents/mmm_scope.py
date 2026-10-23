"""Turning "show me Q3 2025" into the MMM Insights Hub's own filter state.

THE MMM TWIN OF app/agents/hub_scope.py, and a shorter one, because the MMM
hub's scope is simpler than TPO's in one way and wider in another:

  * WIDER: MMM has QUARTERS. TPO's bar does not, so this is the one period
    field with no counterpart there.
  * SIMPLER: a custom range is two real DATES (`date_from`/`date_to`, ISO),
    not two business weeks. MMM's dataset is one row per day, so there is no
    week calendar to resolve a date against and nothing for the model to get
    wrong — which is the whole reason hub_scope has `week_containing`.

WHAT IS SHARED, AND WHY. The DATE PARSER is hub_scope's, called with MMM's own
years: reading "may'24", "Mar-24", "SEPT. 2024" or "11/3/2025" is the same job
whichever dataset the answer comes from, and a second copy of that parser would
drift from the first one the day either was fixed. What is NOT shared is
anything that touches TPO's star schema or its week calendar.

THE SERVER CHANGES NOTHING. Every function here returns a described ACTION for
the browser to apply, record and offer Undo on — see mmm_layout's note.
"""

from __future__ import annotations

import calendar
from datetime import date
from typing import Any

from app.agents.hub_scope import ScopeError, parse_day

#: The day and media filters the MMM scope can hold. The Insights Hub's own bar
#: offers only the period (see pages/MmmInsights.tsx: week, channels,
#: promotion types and events are cleared there), so these are the dimensions
#: the ANALYST can narrow by that the reader has no control for — which is why
#: a filter it sets is reported in the receipt and is undoable.
#:
#: Mirrors MmmListKey in frontend/src/mmm/store.ts.
FILTER_KEYS: tuple[str, ...] = ("channels", "promotion_types", "events")

#: What each one is called in a sentence, singular.
FILTER_LABELS: dict[str, str] = {
    "channels": "channel",
    "promotion_types": "promotion type",
    "events": "event",
}


def _years() -> list[int]:
    """The years the installed MMM dataset holds.

    Read through the loader rather than cached here: the dataset is replaced
    by an upload or a connector sync, and a remembered year list would then
    refuse a year that had just arrived.
    """
    try:
        from app.mmm import loader

        return sorted(int(y) for y in loader.years(loader.get_frame()))
    except Exception:  # no dataset installed: no guard, not a crash
        return []


def _options() -> dict[str, Any]:
    """Every value the MMM filters can take, from the installed file."""
    try:
        from app.mmm import service

        return service.filters()
    except Exception:
        return {}


def period_action(
    year: int | None = None,
    quarter: int | None = None,
    month: int | str | None = None,
    date_from: str | None = None,
    date_to: str | None = None,
    all_data: bool = False,
) -> dict[str, Any]:
    """The period the MMM hub should be on, as its filter bar holds it.

    One shape, checked here rather than in the browser: an action the page
    cannot apply is worse than no action, because the reader is told the period
    changed and the figures stay put.
    """
    if all_data:
        if year or quarter or month or date_from or date_to:
            raise ScopeError("Either all data, or a period — not both.")
        return {
            "kind": "period",
            "year": None, "quarter": None, "month": None,
            "date_from": None, "date_to": None,
            "summary": "set the period to all years",
        }

    # A RANGE WRITTEN AS DATES. Parsed here, with MMM's years, and passed on as
    # ISO dates — which is exactly what the hub's scope takes, so nothing has
    # to be converted on the way.
    if date_from or date_to:
        if not (date_from and date_to):
            raise ScopeError("A date range needs both ends: date_from and date_to.")
        years = _years()
        start = parse_day(date_from, years=years)
        end = parse_day(date_to, end=True, years=years)
        if start > end:
            start, end = end, start
        # NO SNAPPING. The MMM dataset is one row per day, so these two dates
        # are the two dates — see the module docstring. What they are checked
        # against is whether the data actually HAS those days.
        start, end, clamped = _clamp_to_data(start, end)
        summary = f"set the period to {start:%d %b %Y} – {end:%d %b %Y}"
        if clamped:
            summary += " (as far as the data goes)"
        return {
            "kind": "period",
            "year": None, "quarter": None, "month": None,
            "date_from": start.isoformat(), "date_to": end.isoformat(),
            "summary": summary,
        }

    number: int | None = None
    if month is not None:
        number = _month_number(month)

    if quarter is not None:
        try:
            quarter = int(quarter)
        except (TypeError, ValueError) as exc:
            raise ScopeError(f"'{quarter}' is not a quarter. Use 1, 2, 3 or 4.") from exc
        if not 1 <= quarter <= 4:
            raise ScopeError(f"There is no Q{quarter}. Quarters are 1 to 4.")

    # A QUARTER AND A MONTH TOGETHER select the days in both, which is either
    # the month (when it is in that quarter) or nothing at all. Neither is what
    # anybody means by it, so it is refused rather than silently resolved.
    if quarter is not None and number is not None:
        raise ScopeError(
            f"Q{quarter} and {calendar.month_name[number]} together select at most the "
            "month. Ask for one or the other."
        )

    if (number is not None or quarter is not None) and year is None:
        years = _years()
        what = f"Q{quarter}" if quarter is not None else calendar.month_name[number or 1]
        raise ScopeError(
            f"Which year's {what}? The data covers "
            f"{', '.join(str(y) for y in years) if years else 'no years yet'}."
        )

    if year is None:
        raise ScopeError(
            "Say a year, a quarter or month with its year, a date range, or all data."
        )

    years = _years()
    if years and year not in years:
        raise ScopeError(
            f"There is no {year} in the MMM data. It covers "
            f"{', '.join(str(y) for y in years)}."
        )

    if quarter is not None:
        label = f"Q{quarter} {year}"
    elif number is not None:
        label = f"{calendar.month_name[number]} {year}"
    else:
        label = str(year)
    return {
        "kind": "period",
        "year": year, "quarter": quarter, "month": number,
        "date_from": None, "date_to": None,
        "summary": f"set the period to {label}",
    }


def _month_number(month: int | str) -> int:
    """A month from a number or from however it was written."""
    from app.agents.hub_scope import resolve_month

    if isinstance(month, str) and month.strip().isdigit():
        month = int(month.strip())
    if isinstance(month, str):
        found = resolve_month(month)
        if not found:
            raise ScopeError(f"'{month}' is not a month.")
        return found
    try:
        number = int(month)
    except (TypeError, ValueError) as exc:
        raise ScopeError(f"'{month}' is not a month.") from exc
    if not 1 <= number <= 12:
        raise ScopeError(f"'{month}' is not a month.")
    return number


def _clamp_to_data(start: date, end: date) -> tuple[date, date, bool]:
    """The range, cut down to the days the dataset actually holds.

    Returns (start, end, clamped). A range ENTIRELY outside the data is a
    refusal — there is nothing to show and nothing to clamp to. A range that
    overhangs one end is cut back to the data and reports that it was, because
    the alternative is what this replaced: "1 Jan 2026 – 31 Dec 2027" accepted
    whole against data ending 30 Sep 2026, so the page drew nine months of
    figures under a heading claiming two years.

    A range INSIDE the span that still holds no days — a gap in a client's
    delivery — is refused too, naming the dates. An empty page is a thing the
    reader has to interpret; a sentence is not.
    """
    span = _options().get("date_range") or {}
    first_iso, last_iso = span.get("from"), span.get("to")
    if not (first_iso and last_iso):
        return start, end, False
    try:
        first, last = date.fromisoformat(first_iso), date.fromisoformat(last_iso)
    except ValueError:  # a span we cannot read is not a guard
        return start, end, False

    if end < first or start > last:
        raise ScopeError(
            f"{start:%d %b %Y} – {end:%d %b %Y} is outside the MMM data, which covers "
            f"{first:%d %b %Y} to {last:%d %b %Y}."
        )

    clamped = start < first or end > last
    start, end = max(start, first), min(end, last)

    if not _has_days(start, end):
        raise ScopeError(
            f"There is no MMM data between {start:%d %b %Y} and {end:%d %b %Y}. "
            f"The dataset covers {first:%d %b %Y} to {last:%d %b %Y}, with a gap here."
        )
    return start, end, clamped


def _has_days(start: date, end: date) -> bool:
    """Whether the dataset holds a single day in this range.

    Read off the loaded frame, which is cached — the alternative is trusting
    that the span has no holes in it, and a client's delivery of January and
    March is an ordinary thing to receive.
    """
    try:
        import pandas as pd

        from app.mmm import loader

        dates = loader.get_frame()["Date"]
        return bool(
            ((dates >= pd.Timestamp(start)) & (dates <= pd.Timestamp(end))).any()
        )
    except Exception:  # no dataset, or a frame we cannot read: no guard
        return True


def filter_action(
    dimension: str = "",
    values: Any = None,
    clear: bool = False,
    clear_all: bool = False,
) -> dict[str, Any]:
    """Narrow the MMM hub to some channels, promotion types or events.

    Values are matched the way the connectors match a column header — by
    DISPLAY NAME as readily as by code, case and spacing ignored — because the
    model has read "Digital · Search" off a chart and will write that back,
    not `Digital_Search_Spend`.
    """
    if clear_all:
        return {
            "kind": "filter",
            "dimension": None, "values": [], "clear_all": True,
            "summary": "cleared the channel, promotion-type and event filters",
        }

    key = (dimension or "").strip().lower().replace(" ", "_")
    # The singular a person writes, mapped to the plural the scope holds.
    key = {"channel": "channels", "promotion_type": "promotion_types",
           "promotion": "promotion_types", "event": "events"}.get(key, key)
    if key not in FILTER_KEYS:
        raise ScopeError(
            f"The MMM hub has no {dimension!r} filter. It has: "
            f"{', '.join(FILTER_LABELS[k] for k in FILTER_KEYS)}."
        )

    label = FILTER_LABELS[key]
    if clear:
        return {
            "kind": "filter",
            "dimension": key, "values": [], "clear_all": False,
            "summary": f"cleared the {label} filter",
        }

    wanted = [str(v).strip() for v in (values or []) if str(v).strip()]
    if not wanted:
        raise ScopeError(f"Say which {label}s, or ask to clear the filter.")

    codes, unknown = _resolve(key, wanted)
    if unknown:
        available = ", ".join(_display_names(key)) or "none"
        raise ScopeError(
            f"No {label} called {', '.join(unknown)}. Available: {available}."
        )
    names = _display_names(key, codes)
    return {
        "kind": "filter",
        "dimension": key, "values": codes, "clear_all": False,
        "summary": f"filtered to {label} {', '.join(names)}"
        if len(names) == 1
        else f"filtered to {len(names)} {label}s: {', '.join(names)}",
    }


def _entries(key: str) -> list[dict[str, str]]:
    """Each option as {code, name}. The three filters are stored differently in
    `service.filters()` — channels and events as objects, promotion types as
    plain strings — and are levelled here so one resolver serves all three."""
    raw = _options().get(key) or []
    out: list[dict[str, str]] = []
    for item in raw:
        if isinstance(item, dict):
            code = str(item.get("code") or "")
            if code:
                out.append({"code": code, "name": str(item.get("name") or code)})
        else:
            out.append({"code": str(item), "name": str(item)})
    return out


def _display_names(key: str, codes: list[str] | None = None) -> list[str]:
    entries = _entries(key)
    if codes is None:
        return [e["name"] for e in entries]
    by_code = {e["code"]: e["name"] for e in entries}
    return [by_code.get(c, c) for c in codes]


def _norm(text: str) -> str:
    """A value with nothing in it but its letters and digits, lowercased —
    the same levelling app/mmm/mapping.py gives a column header."""
    return "".join(ch for ch in str(text).lower() if ch.isalnum())


def _resolve(key: str, wanted: list[str]) -> tuple[list[str], list[str]]:
    """(codes, unknown). A value is matched against its code and its display
    name, then against either with the punctuation taken out."""
    entries = _entries(key)
    index: dict[str, str] = {}
    for e in entries:
        index.setdefault(_norm(e["code"]), e["code"])
        index.setdefault(_norm(e["name"]), e["code"])
        # "Digital_Search_Spend" is also "digital search" on every chart.
        trimmed = e["code"].replace("_Spend", "").replace("_", " ")
        index.setdefault(_norm(trimmed), e["code"])
    codes: list[str] = []
    unknown: list[str] = []
    for value in wanted:
        hit = index.get(_norm(value))
        if hit is None:
            unknown.append(value)
        elif hit not in codes:
            codes.append(hit)
    return codes, unknown


def granularity_action(granularity: str) -> dict[str, Any]:
    """Weekly or monthly, for the Ad Spend & ROAS trend.

    Daily is the hub's own fallback for a short range and is not offered here:
    over a year it draws 365 points into a card, which the page itself refuses
    (service.MAX_DAILY_SPAN_DAYS).
    """
    value = (granularity or "").strip().lower()
    value = {"weekly": "week", "monthly": "month", "weeks": "week",
             "months": "month"}.get(value, value)
    if value not in ("week", "month"):
        raise ScopeError(
            f"The trend is drawn weekly or monthly, not {granularity!r}."
        )
    return {
        "kind": "granularity",
        "granularity": value,
        "summary": f"set the trend to {'weekly' if value == 'week' else 'monthly'}",
    }
