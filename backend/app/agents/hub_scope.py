"""Turning "show me 2024" into the Insights Hub's own filter state.

The Analyst already turns words into a scope to LOOK A NUMBER UP. This turns
words into the scope the PAGE should be on, which is a different job with one
hard constraint: the page's filter bar has an exact shape, and an action it
cannot apply is worse than no action at all — the reader is told the period
changed and the figures stay put.

So the shape is checked here, against the same `app/tpo` vocabulary the
look-up tools use:

  * a whole YEAR is held as `year`, because everything on the page keyed on a
    year reads that field (see store/commandFilters.ts: F24 and F25 are
    display labels over `year`, and the Period calendar writes a part-year as
    `period_from`/`period_to` instead);
  * a part of a year is two BUSINESS WEEKS as yyyyww, which is what the Period
    calendar means by a custom range;
  * "all data" is every period field null, which is the Hub's own default.

A MONTH NAME IS NOT A PERIOD ON ITS OWN. "March" without a year could be any
March in the data, and silently picking the latest would be a different
quarter's numbers under a confident sentence, so it is refused with the years
that exist.
"""

from __future__ import annotations

import calendar
from typing import Any

from app.agents import star_tools as T

#: The filter dimensions the Hub's bar actually has, in the page's own order.
#: Mirrors ListFilterKey in frontend/src/store/commandFilters.ts.
FILTER_KEYS: tuple[str, ...] = (
    "channel", "retailer", "region", "state", "city", "tier", "distributor",
    "category", "brand", "product", "promotion", "promotion_type",
)

#: Which dimensions the bar lets a reader hold several values in at once.
#: Mirrors MULTI_SELECT in the same file. A single-select dimension given two
#: values is refused rather than quietly truncated.
MULTI_SELECT: frozenset[str] = frozenset({"channel", "retailer", "category", "brand"})

MONTHS: dict[str, int] = {name.lower(): i for i, name in enumerate(calendar.month_name) if name}
MONTHS.update({name.lower(): i for i, name in enumerate(calendar.month_abbr) if name})


class ScopeError(ValueError):
    """A scope the page could not be put into. The message is for the model."""


def _dimensions() -> dict[str, Any]:
    """The real values every dimension takes, from the same summary the
    look-up tools plan with — so a filter the Analyst sets is a filter the
    dataset can satisfy."""
    try:
        return T.schema_summary().get("filter_dimensions", {})
    except Exception:  # the dataset is the authority; without it, no guard
        return {}


def _years() -> list[int]:
    out: list[int] = []
    for value in _dimensions().get("year", []) or []:
        try:
            out.append(int(value))
        except (TypeError, ValueError):
            continue
    return sorted(out)


def _week_of(value: int, label: str) -> int:
    """yyyyww, checked. 202611 is week 11 of 2026."""
    if value < 100_001:
        raise ScopeError(
            f"{label} must be a year and week together as yyyyww — 202611 is week 11 of 2026."
        )
    year, week = divmod(value, 100)
    if not 1 <= week <= 53:
        raise ScopeError(f"{label} has week {week}, which is not a week of a year.")
    years = _years()
    if years and not (years[0] <= year <= years[-1]):
        raise ScopeError(
            f"{label} is in {year}; the data covers {years[0]}–{years[-1]}."
        )
    return value


def period_action(
    year: int | None = None,
    month: int | str | None = None,
    week_from: int | None = None,
    week_to: int | None = None,
    all_data: bool = False,
) -> dict[str, Any]:
    """The period the page should be on, as the filter bar holds it."""
    if all_data:
        if year or month or week_from or week_to:
            raise ScopeError("Either all data, or a period — not both.")
        return {
            "kind": "period",
            "year": None, "month": None, "period_from": None, "period_to": None,
            "summary": "set the period to all data",
        }

    if (week_from is None) != (week_to is None):
        raise ScopeError("A custom range needs both ends: week_from and week_to.")

    if week_from is not None and week_to is not None:
        start, end = _week_of(week_from, "week_from"), _week_of(week_to, "week_to")
        if start > end:
            start, end = end, start
        return {
            "kind": "period",
            "year": None, "month": None, "period_from": start, "period_to": end,
            "summary": "set the period to " + (
                f"weeks {start % 100}–{end % 100} of {start // 100}"
                if start // 100 == end // 100
                else f"week {start % 100} of {start // 100} to week {end % 100} of {end // 100}"
            ),
        }

    number: int | None = None
    if month is not None:
        number = MONTHS.get(str(month).strip().lower()) if isinstance(month, str) else int(month)
        if isinstance(month, str) and str(month).strip().isdigit():
            number = int(str(month).strip())
        if not number or not 1 <= number <= 12:
            raise ScopeError(f"'{month}' is not a month.")
        if year is None:
            years = _years()
            raise ScopeError(
                f"Which year's {calendar.month_name[number]}? The data covers "
                f"{', '.join(str(y) for y in years) if years else 'no years yet'}."
            )

    if year is None:
        raise ScopeError("Say a year, a month with its year, a week range, or all data.")

    years = _years()
    if years and year not in years:
        raise ScopeError(
            f"There is no {year} in the data. It covers {', '.join(str(y) for y in years)}."
        )

    label = f"{calendar.month_name[number]} {year}" if number else str(year)
    return {
        "kind": "period",
        "year": year, "month": number, "period_from": None, "period_to": None,
        "summary": f"set the period to {label}",
    }


def filter_action(
    dimension: str,
    values: list[str] | None = None,
    clear: bool = False,
    clear_all: bool = False,
) -> dict[str, Any]:
    """One of the bar's filter dimensions, set or cleared.

    The values are checked against what the dataset actually holds, because a
    filter nobody can satisfy empties the page — and "no rows" reads as a
    broken dashboard rather than as a typo.
    """
    if clear_all:
        return {
            "kind": "filter", "clear_all": True, "dimension": None, "values": [],
            "summary": "cleared every filter",
        }

    key = (dimension or "").strip().lower()
    if key not in FILTER_KEYS:
        raise ScopeError(
            f"The Insights Hub has no '{dimension}' filter. It has: {', '.join(FILTER_KEYS)}."
        )

    if clear:
        return {
            "kind": "filter", "clear_all": False, "dimension": key, "values": [],
            "summary": f"cleared the {key.replace('_', ' ')} filter",
        }

    wanted = [str(v).strip() for v in (values or []) if str(v).strip()]
    if not wanted:
        raise ScopeError(f"Say which {key.replace('_', ' ')} to filter to, or ask to clear it.")
    if len(wanted) > 1 and key not in MULTI_SELECT:
        raise ScopeError(
            f"The {key.replace('_', ' ')} filter takes one value at a time on this page; "
            f"{', '.join(wanted)} were asked for."
        )

    resolved, missing = _resolve(key, wanted)
    if missing:
        choices = list(_names(key)) or _options(key)
        raise ScopeError(
            f"{', '.join(missing)} is not a {key.replace('_', ' ')} in the data."
            + (f" Try one of: {', '.join(choices[:8])}." if choices else "")
        )

    return {
        "kind": "filter", "clear_all": False, "dimension": key, "values": resolved,
        "summary": f"filtered {key.replace('_', ' ')} to {', '.join(resolved)}",
    }


#: Where a dimension's options live in the schema summary, when its name
#: there is not the filter's own name.
_SUMMARY_KEY: dict[str, str] = {"promotion": "offers"}


def _options(key: str) -> list[str]:
    """The codes one dimension accepts. Entries carrying a display name — a
    channel, an offer, a product — are reduced to their code, because that is
    what the page sends and what the engine filters on."""
    raw = _dimensions().get(_SUMMARY_KEY.get(key, key), [])
    if not isinstance(raw, list):
        return []
    out: list[str] = []
    for entry in raw:
        if isinstance(entry, dict):
            code = entry.get("code")
            if code is not None:
                out.append(str(code))
        elif entry is not None:
            out.append(str(entry))
    return out


def _names(key: str) -> dict[str, str]:
    """Display name (lowercased) -> code, for the dimensions that have both.
    A reader says "Modern Trade"; the page needs CH001."""
    raw = _dimensions().get(_SUMMARY_KEY.get(key, key), [])
    out: dict[str, str] = {}
    if not isinstance(raw, list):
        return out
    for entry in raw:
        if isinstance(entry, dict) and entry.get("name") and entry.get("code") is not None:
            out.setdefault(str(entry["name"]).strip().lower(), str(entry["code"]))
    return out


def _resolve(key: str, wanted: list[str]) -> tuple[list[str], list[str]]:
    """Match what was asked for against the real values, case-insensitively.

    The page sends the dataset's own code, so a reader's "modern trade" has to
    become whatever the data calls it. An exact match wins; otherwise one
    unambiguous case-insensitive match wins; anything else is unmatched and the
    caller refuses rather than guessing.
    """
    options = _options(key)
    if not options:
        return wanted, []
    by_lower: dict[str, list[str]] = {}
    for option in options:
        by_lower.setdefault(option.lower(), []).append(option)
    by_name = _names(key)

    resolved: list[str] = []
    missing: list[str] = []
    for value in wanted:
        if value in options:
            resolved.append(value)
            continue
        matches = by_lower.get(value.lower(), [])
        if len(matches) == 1:
            resolved.append(matches[0])
            continue
        # A display name — "Modern Trade" for CH001 — which is what a reader
        # says and what the model repeats back from a breakdown.
        named = by_name.get(value.strip().lower())
        if named:
            resolved.append(named)
        else:
            missing.append(value)
    return resolved, missing
