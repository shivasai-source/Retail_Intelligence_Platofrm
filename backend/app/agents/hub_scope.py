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
    calendar means by a custom range — AND THE MODEL MUST NOT WORK THOSE OUT.
    Asked for "11 mar 2025 to 11 aug 2025" it answered "weeks 11-18 of 2025";
    asked for "march 2025 to august 2025" it answered "weeks 11-36". Both are
    wrong, differently, for the same reason: converting a date to a business
    week needs the dataset's own week calendar, which the model cannot see. So
    dates are passed AS DATES and resolved here, against the calendar the
    engine itself filters on;
  * "all data" is every period field null, which is the Hub's own default.

A MONTH NAME IS NOT A PERIOD ON ITS OWN. "March" without a year could be any
March in the data, and silently picking the latest would be a different
quarter's numbers under a confident sentence, so it is refused with the years
that exist.
"""

from __future__ import annotations

import calendar
import re
from collections.abc import Sequence
from datetime import date, datetime
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


def _expand_year(two: int, years: Sequence[int] | None = None) -> int:
    """'24 -> 2024, chosen from the years the data actually holds.

    Blindly adding 2000 is right today and wrong the moment a dataset carries
    1999 or 2101. Matching against the real years means the answer is either
    a year that exists or a refusal naming the ones that do.

    `years` is which dataset's years to read it against. None means the TPO
    store's, which is what every caller on this page wants; the MMM Analyst
    passes its own (see app/agents/mmm_scope.py) so one parser serves both
    datasets rather than two copies drifting apart.
    """
    years = sorted(years) if years is not None else _years()
    matches = [y for y in years if y % 100 == two]
    if len(matches) == 1:
        return matches[0]
    if not years:
        return 2000 + two
    raise ScopeError(
        f"'{two:02d} could be {' or '.join(str(y) for y in matches)}."
        if matches else
        f"There is no year ending {two:02d} in the data. It covers "
        f"{', '.join(str(y) for y in years)}."
    )


#: Spellings of a month that are not in the C library's tables but are in
#: everyone's typing. Anything else resolves by unique prefix below.
_MONTH_ALIASES: dict[str, int] = {
    "sept": 9, "sepr": 9, "septr": 9,
    "jun": 6, "jly": 7, "augt": 8, "dec": 12, "feburary": 2, "febuary": 2,
}


def resolve_month(word: str) -> int | None:
    """A month from however it was written, or None if it is not one.

    THE SAME TOLERANCE THE COLUMN MAPPER GIVES A HEADER (app/mmm/mapping.py,
    app/column_mapping.py): case and punctuation are stripped before anything
    is compared, so "SEPT.", " september " and "Sep" are one word. A prefix of
    three letters or more resolves when it can only be one month — "septem" is
    September — and an ambiguous one ("ma", which is March and May) resolves
    to nothing rather than to a guess, because the wrong month is a whole
    different quarter of the business.
    """
    key = "".join(ch for ch in str(word or "").lower() if ch.isalpha())
    if not key:
        return None
    for table in (MONTHS, _MONTH_ALIASES):
        if key in table:
            return table[key]
    if len(key) >= 3:
        hits = {n for name, n in MONTHS.items() if name.startswith(key)}
        if len(hits) == 1:
            return hits.pop()
    return None


#: A whole date written in digits: 11-03-2025, 11/03/2025, 2025-03-11.
_ALL_DIGITS = re.compile(r"^(\d{1,4})\s*[-/.]\s*(\d{1,2})\s*[-/.]\s*(\d{1,4})$")


def parse_day(text: str, *, end: bool = False,
              years: Sequence[int] | None = None) -> date:
    """One date, from however a person wrote it.

    PARSED BY STRUCTURE, NOT BY A LIST OF FORMATS. Matching "%b %Y" and
    friends meant "may 2024" worked and "may-2024" did not, which is a
    distinction nobody intends to be making. The pieces are found instead: a
    month word, a year, and a day if there is one. Case, spacing and
    punctuation stop mattering, as they already do when a connector matches a
    column header.

    A month with no day resolves to its FIRST day, or its last when `end` — so
    "march 2025 to august 2025" is both months whole, which is what those
    words mean.

    `years` is which dataset to read a two-digit year against — see
    `_expand_year`. None is the TPO store's.
    """
    # Curly quotes become straight ones first, so "May \u201824" and "May '24"
    # are the same input. A word processor's apostrophe is not a different
    # intention.
    raw = " ".join(str(text or "").replace("\u2018", "'").replace("\u2019", "'").split())
    if not raw:
        raise ScopeError("Give a date, like 11 Mar 2025.")

    # All digits: day-first, because that is this product's convention and the
    # dataset's. A four-digit leading number is a year instead.
    digits = _ALL_DIGITS.match(raw)
    if digits:
        a, b, c = (int(g) for g in digits.groups())
        try:
            if a > 31:
                return date(a, b, c)
            year = c if c > 99 else _expand_year(c, years)
            return date(year, b, a)
        except ValueError as exc:
            raise ScopeError(f"'{text}' is not a date on any calendar.") from exc

    # "Mar-24", "Mar/24": a month word PUNCTUATED onto two digits is the month
    # and year, the form a spreadsheet writes. Normalised to the apostrophe
    # form below. A bare space ("mar 24") is left alone, because that one
    # really is ambiguous and is asked about instead of guessed.
    raw = re.sub(
        r"([A-Za-z]{3,})\s*[-/.]\s*(?<!\d)(\d{2})(?!\d)", r"\1 '\2", raw
    )

    # A word form: find the month, the year, and a day if one is there.
    tokens = [t for t in re.split(r"[^A-Za-z0-9']+", raw) if t]
    month: int | None = None
    year: int | None = None
    day: int | None = None
    #: Words that join a date together and mean nothing on their own.
    joining = {"of", "the", "in", "on", "to", "from", "fy", "month", "period"}
    for token in tokens:
        apostrophe = re.fullmatch(r"['\u2018\u2019](\d{2})", token)
        if apostrophe:
            year = _expand_year(int(apostrophe.group(1)), years)
            continue
        # "may'24" arrives whole when the apostrophe is not a separator.
        joined = re.fullmatch(r"([A-Za-z]+)['\u2018\u2019](\d{2})", token)
        if joined:
            month = month or resolve_month(joined.group(1))
            year = _expand_year(int(joined.group(2)), years)
            continue
        if token.isdigit():
            if len(token) == 4:
                year = int(token)
            elif day is None and 1 <= int(token) <= 31:
                day = int(token)
            continue
        found = resolve_month(token)
        if found:
            month = found
        elif token.lower() not in joining:
            # A word that is not a month and not grammar. "ma 2025" used to
            # fall through to the whole of 2025, quietly dropping the half-
            # written month the reader actually cared about.
            raise ScopeError(
                f"'{token}' is not a month I recognise. Write it out — "
                "March 2025, or 11 Mar 2025."
            )

    if month and year:
        if day:
            try:
                return date(year, month, day)
            except ValueError as exc:
                raise ScopeError(
                    f"There is no {day} {calendar.month_name[month]} {year}."
                ) from exc
        first = date(year, month, 1)
        return first.replace(day=calendar.monthrange(year, month)[1]) if end else first

    if month and not year:
        known = sorted(years) if years is not None else _years()
        raise ScopeError(
            f"Which year's {calendar.month_name[month]}? The data covers "
            f"{', '.join(str(y) for y in known) if known else 'no years yet'}."
        )
    if year and not month:
        return date(year, 12, 31) if end else date(year, 1, 1)

    raise ScopeError(
        f"'{text}' is not a date I can read. Try 11 Mar 2025, 11-03-2025 or 2025-03-11."
    )


def _calendar() -> dict[date, tuple[int, int]]:
    """Every day the dataset covers, mapped to the business week that holds it.

    The engine's own week calendar (`store.dims.week_dates`), inverted. Using
    anything else — ISO weeks, or arithmetic on day-of-year — would select
    different rows from the ones the Insights Hub shows for the same words.
    """
    from app.tpo.loader import get_store

    store = get_store()
    return {
        day: (year, week)
        for (year, week), days in store.dims.week_dates.items()
        for day in days
    }


def week_containing(day: date, *, after: bool) -> int:
    """The yyyyww business week a date falls in.

    A date the data does not cover — a weekend the calendar skips, or a day
    before the first week — resolves to the NEAREST week in the direction the
    range is growing: `after` for the start of a range, before it for the end.
    That is what makes "11 Mar to 11 Aug" include both ends rather than
    silently dropping one.
    """
    days = _calendar()
    if not days:
        raise ScopeError("The dataset has no week calendar to read dates against.")
    if day in days:
        year, week = days[day]
        return year * 100 + week
    candidates = [d for d in days if (d >= day if after else d <= day)]
    if not candidates:
        first, last = min(days), max(days)
        raise ScopeError(
            f"{day:%d %b %Y} is outside the data, which covers "
            f"{first:%d %b %Y} to {last:%d %b %Y}."
        )
    nearest = min(candidates) if after else max(candidates)
    year, week = days[nearest]
    return year * 100 + week


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
    date_from: str | None = None,
    date_to: str | None = None,
    all_data: bool = False,
) -> dict[str, Any]:
    """The period the page should be on, as the filter bar holds it."""
    if all_data:
        if year or month or week_from or week_to or date_from or date_to:
            raise ScopeError("Either all data, or a period — not both.")
        return {
            "kind": "period",
            "year": None, "month": None, "period_from": None, "period_to": None,
            "summary": "set the period to all data",
        }

    # A RANGE WRITTEN AS DATES is resolved here, against the dataset's own
    # week calendar — never by the model, which has no calendar to read.
    if date_from or date_to:
        if not (date_from and date_to):
            raise ScopeError("A date range needs both ends: date_from and date_to.")
        start_day = parse_day(date_from)
        end_day = parse_day(date_to, end=True)
        if start_day > end_day:
            start_day, end_day = end_day, start_day
        start = week_containing(start_day, after=True)
        end = week_containing(end_day, after=False)
        if start > end:
            raise ScopeError(
                f"{start_day:%d %b %Y} to {end_day:%d %b %Y} covers no week of the data."
            )
        return {
            "kind": "period",
            "year": None, "month": None, "period_from": start, "period_to": end,
            "summary": (
                f"set the period to {start_day:%d %b %Y} – {end_day:%d %b %Y}"
            ),
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
