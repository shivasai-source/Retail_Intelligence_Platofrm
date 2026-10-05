"""The MMM filter scope: which days, and which channels, a figure covers.

Every MMM page posts the same filters, and they mean the same thing everywhere.

    TIME (selects the PERIOD):
        year, quarter, month, week   ANDed together, as TPO's year/month are
        date_from, date_to           a custom range. When either is set it
                                     REPLACES year/quarter/month/week.
    DAY (narrows the days WITHIN the period):
        promotion_types              Promotion_Type, any of
        events                       holiday / trending / promotion / none
                                     (none = no flag set), any of
    MEDIA:
        channels                     which *_Spend columns count as ad spend.
                                     Empty = all of them. A channel filter
                                     drops no days.

WHY TIME AND DAY ARE SEPARATE. The baseline (app/mmm/baseline.py) is estimated
over the PERIOD's days. A day filter cannot be applied first: on "10% Discount"
days the Promotion flag is always 1, so there would be no R days, and therefore
no baseline. The baseline per day comes from the period, and is then applied to
however many days the day filters leave.
"""

from __future__ import annotations

from dataclasses import dataclass, replace
from datetime import date
from typing import Any

import numpy as np
import pandas as pd

EVENTS: dict[str, str] = {
    "holiday": "Holiday",
    "trending": "Trending",
    "promotion": "Promotion",
    "none": "No event",
}


@dataclass(frozen=True)
class Scope:
    year: int | None = None
    quarter: int | None = None
    month: int | None = None
    week: int | None = None
    date_from: date | None = None
    date_to: date | None = None
    channels: tuple[str, ...] = ()
    promotion_types: tuple[str, ...] = ()
    events: tuple[str, ...] = ()

    @property
    def custom(self) -> bool:
        return self.date_from is not None or self.date_to is not None

    @property
    def has_day_filter(self) -> bool:
        return bool(self.promotion_types or self.events)

    def window(self, start: pd.Timestamp, end: pd.Timestamp) -> "Scope":
        """The same day and media filters over an explicit date range. This is
        how a comparison period is built."""
        return replace(self, year=None, quarter=None, month=None, week=None,
                       date_from=start.date(), date_to=end.date())

    @classmethod
    def build(cls, *, year: int | None = None, quarter: int | None = None,
              month: int | None = None, week: int | None = None,
              date_from: date | str | None = None, date_to: date | str | None = None,
              channels: Any = (), promotion_types: Any = (), events: Any = ()) -> "Scope":
        if quarter is not None and not 1 <= quarter <= 4:
            raise ValueError("quarter must be 1-4.")
        if month is not None and not 1 <= month <= 12:
            raise ValueError("month must be 1-12.")
        if week is not None and not 1 <= week <= 53:
            raise ValueError("week must be 1-53.")
        start, end = _date(date_from, "date_from"), _date(date_to, "date_to")
        if start and end and start > end:
            raise ValueError("date_from is after date_to.")
        bad = sorted(set(events or ()) - set(EVENTS))
        if bad:
            raise ValueError(f"Unknown event(s): {', '.join(bad)}. Use {', '.join(EVENTS)}.")
        return cls(year=year, quarter=quarter, month=month, week=week,
                   date_from=start, date_to=end,
                   channels=tuple(sorted(set(channels or ()))),
                   promotion_types=tuple(sorted(set(promotion_types or ()))),
                   events=tuple(sorted(set(events or ()))))

    def to_dict(self) -> dict[str, Any]:
        return {
            "year": self.year, "quarter": self.quarter, "month": self.month, "week": self.week,
            "date_from": self.date_from.isoformat() if self.date_from else None,
            "date_to": self.date_to.isoformat() if self.date_to else None,
            "channels": list(self.channels), "promotion_types": list(self.promotion_types),
            "events": list(self.events),
        }


def _date(value: date | str | None, name: str) -> date | None:
    if value is None or value == "":
        return None
    if isinstance(value, date):
        return value
    try:
        return date.fromisoformat(str(value))
    except ValueError as exc:
        raise ValueError(f"{name} must be a date in YYYY-MM-DD, not {value!r}.") from exc


def from_options(raw: dict[str, Any] | None) -> Scope:
    """A Scope from a JSON dict: a report's `options.filters`, which has the
    same keys as `Scope.to_dict`. An unknown key is rejected rather than
    ignored, because ignoring it would export a wider scope than was asked for."""
    raw = dict(raw or {})
    unknown = sorted(set(raw) - set(Scope().to_dict()))
    if unknown:
        raise ValueError(f"Unknown MMM filter(s): {', '.join(unknown)}.")
    for key in ("year", "quarter", "month", "week"):
        value = raw.get(key)
        if value is not None and (isinstance(value, bool) or not isinstance(value, int)):
            raise ValueError(f"{key} must be a whole number or null, not {value!r}.")
    for key in ("channels", "promotion_types", "events"):
        value = raw.get(key)
        if value is not None and not isinstance(value, list):
            raise ValueError(f"{key} must be a list, not {value!r}.")
    return Scope.build(**{k: v for k, v in raw.items() if v is not None})


# --- masks ----------------------------------------------------------------------


def period_mask(frame: pd.DataFrame, scope: Scope) -> np.ndarray:
    dates = frame["Date"]
    mask = pd.Series(True, index=frame.index)
    if scope.custom:
        if scope.date_from:
            mask &= dates >= pd.Timestamp(scope.date_from)
        if scope.date_to:
            mask &= dates <= pd.Timestamp(scope.date_to)
        return mask.to_numpy()
    if scope.year is not None:
        mask &= dates.dt.year == scope.year
    if scope.quarter is not None:
        mask &= dates.dt.quarter == scope.quarter
    if scope.month is not None:
        mask &= dates.dt.month == scope.month
    if scope.week is not None:
        mask &= frame["Week_of_Year"] == scope.week
    return mask.to_numpy()


def day_mask(frame: pd.DataFrame, scope: Scope) -> np.ndarray:
    mask = pd.Series(True, index=frame.index)
    if scope.promotion_types and "Promotion_Type" in frame:
        mask &= frame["Promotion_Type"].isin(scope.promotion_types)
    if scope.events:
        hit = pd.Series(False, index=frame.index)
        cols = {"holiday": "Holiday_Flag", "trending": "Trending_Flag",
                "promotion": "Promotion_Flag"}
        present = [c for c in cols.values() if c in frame]
        for event in scope.events:
            if event == "none":
                hit |= (frame[present] != 1).all(axis=1) if present else True
            elif cols[event] in frame:
                hit |= frame[cols[event]] == 1
        mask &= hit
    return mask.to_numpy()


def spend_columns(scope: Scope, media: list[str]) -> list[str]:
    if not scope.channels:
        return media
    unknown = [c for c in scope.channels if c not in media]
    if unknown:
        raise ValueError(f"Unknown channel(s): {', '.join(unknown)}.")
    return [c for c in media if c in scope.channels]


# --- comparison periods ---------------------------------------------------------

#: The three comparisons, in the order the page lists them.
COMPARISONS: dict[str, str] = {
    "yago": "Year Ago",
    "pago": "Period Ago",
    "mago": "Month Ago",
}


def comparison_window(kind: str, start: pd.Timestamp, end: pd.Timestamp) -> tuple[pd.Timestamp, pd.Timestamp]:
    """YAGO the same dates a year earlier, MAGO a month earlier, PAGO the
    period of equal length immediately before.

    A period of WHOLE CALENDAR MONTHS (a year, a quarter, a month, or the
    Jan–Sep of a part year) shifts by calendar months. That makes June's MAGO
    all of May, not 1–30 May, and 2025's PAGO all of 2024, not 2 Jan – 31 Dec,
    which is what a count of 365 days gives across a leap year."""
    if start.day == 1 and end == end + pd.offsets.MonthEnd(0):
        months = (end.year - start.year) * 12 + end.month - start.month + 1
        back = {"yago": 12, "mago": 1, "pago": months}.get(kind)
        if back is None:
            raise ValueError(f"Unknown comparison {kind!r}.")
        c_start = start - pd.DateOffset(months=back)
        return c_start, c_start + pd.DateOffset(months=months) - pd.Timedelta(days=1)
    if kind == "yago":
        return start - pd.DateOffset(years=1), end - pd.DateOffset(years=1)
    if kind == "mago":
        return start - pd.DateOffset(months=1), end - pd.DateOffset(months=1)
    if kind == "pago":
        length = end - start + pd.Timedelta(days=1)
        return start - length, start - pd.Timedelta(days=1)
    raise ValueError(f"Unknown comparison {kind!r}.")


def span_label(start: pd.Timestamp, end: pd.Timestamp) -> str:
    if start == end:
        return start.strftime("%d %b %Y")
    if start.year == end.year:
        return f"{start.strftime('%d %b')} – {end.strftime('%d %b %Y')}"
    return f"{start.strftime('%d %b %Y')} – {end.strftime('%d %b %Y')}"
