"""THE MMM BASELINE — the revenue a day makes with no advertising and no events.

ONE DEFINITION, re-estimated for EVERY range a reader selects (a year, a
quarter, a month, a week, a single bucket on a trend, or a custom date range).
It is never a fixed figure for the file: the Insights Hub, the comparison
periods, each point of the trend and any later MMM module all call `estimate`
over their own days.

THE FORMULA. Over the days of the range, read the average daily revenue of
three kinds of day:

    X  ad spend > 0, and Holiday, Trending and Promotion flags all 1
       = ads + holiday + trending + promotion + baseline
    Y  ad spend = 0, and all three flags 1
       = holiday + trending + promotion + baseline
    R  ad spend > 0, and all three flags 0
       = ads + baseline

    Z = X − Y              revenue from ad spend, per day
    baseline per day = R − Z
    baseline revenue = baseline per day × days in the range

"Ad spend" is the sum of the spend columns passed in. The hub passes the
channels the reader filtered to, or every `*_Spend` column when none is chosen.

AVERAGES, NOT SUMS. X, Y and R are means. The three groups have different
numbers of days, so their totals cannot be subtracted from one another.

A RANGE WITHOUT ONE OF THE THREE KINDS OF DAY. In the reference file a year
holds roughly 30 X, 15 Y and 30 R days, but a month holds 1–3 of each and a
week usually none. When the range has no day of one kind, the window is widened
symmetrically, a week at a time, until it holds at least one of each. The
widened window is returned with the estimate, and the page shows it, so a
figure is never presented as coming from days it did not use. When the whole
file cannot supply all three kinds, or the file has no event flags, there is
no baseline. It is reported as unavailable, never as zero.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any, Callable

import numpy as np
import pandas as pd

FLAGS: tuple[str, ...] = ("Holiday_Flag", "Trending_Flag", "Promotion_Flag")

#: Fewest days of each kind (X, Y, R) an estimate needs before the window
#: is widened.
MIN_DAYS = 1
#: How far each widening step reaches on either side of the range.
WIDEN_STEP = pd.Timedelta(days=7)

GROUPS = ("x", "y", "r")


@dataclass(frozen=True)
class Estimate:
    """One baseline estimate. Every average is per day, in rupees."""

    per_day: float | None
    x: float | None
    y: float | None
    r: float | None
    z: float | None
    days: dict[str, int]
    window_from: pd.Timestamp | None
    window_to: pd.Timestamp | None
    widened: bool
    #: Why there is no estimate, when there is none.
    reason: str = ""

    @property
    def available(self) -> bool:
        return self.per_day is not None

    def to_dict(self, money: Callable[[float | None], str]) -> dict[str, Any]:
        def r2(v: float | None) -> float | None:
            return round(v, 2) if v is not None else None

        return {
            "available": self.available,
            "reason": self.reason,
            "per_day": r2(self.per_day), "per_day_display": money(self.per_day),
            "x": r2(self.x), "x_display": money(self.x),
            "y": r2(self.y), "y_display": money(self.y),
            "z": r2(self.z), "z_display": money(self.z),
            "r": r2(self.r), "r_display": money(self.r),
            "days": dict(self.days),
            "window": {
                "from": self.window_from.strftime("%d-%m-%Y") if self.window_from is not None else None,
                "to": self.window_to.strftime("%d-%m-%Y") if self.window_to is not None else None,
                "label": _span_label(self.window_from, self.window_to),
            },
            "widened": self.widened,
        }


def _span_label(start: pd.Timestamp | None, end: pd.Timestamp | None) -> str:
    if start is None or end is None:
        return ""
    return f"{start.strftime('%d %b %Y')} – {end.strftime('%d %b %Y')}"


def unavailable(reason: str) -> Estimate:
    return Estimate(None, None, None, None, None, {g: 0 for g in GROUPS},
                    None, None, False, reason)


class Engine:
    """The day classification and running totals for one dataset and one set
    of spend columns. Building it is O(days); each estimate after that is a few
    vector operations, and each widening step is O(1) on the prefix sums. That
    is what lets a daily trend estimate a baseline for every day."""

    def __init__(self, frame: pd.DataFrame, spend_columns: list[str]):
        self.dates = frame["Date"].to_numpy(dtype="datetime64[ns]")
        self.revenue = frame["Revenue"].to_numpy(dtype=float)
        self.missing_flags = [f for f in FLAGS if f not in frame.columns]
        n = len(frame)
        if self.missing_flags or not spend_columns:
            self.ind = {g: np.zeros(n, dtype=bool) for g in GROUPS}
        else:
            on_air = frame[spend_columns].sum(axis=1).to_numpy() > 0
            flags = frame[list(FLAGS)].to_numpy()
            all_on = (flags == 1).all(axis=1)
            all_off = (flags == 0).all(axis=1)
            self.ind = {"x": on_air & all_on, "y": ~on_air & all_on, "r": on_air & all_off}
        self.count = {g: np.concatenate(([0], np.cumsum(self.ind[g]))) for g in GROUPS}
        self.total = {g: np.concatenate(([0.0], np.cumsum(self.revenue * self.ind[g])))
                      for g in GROUPS}

    def estimate(self, mask: np.ndarray) -> Estimate:
        """The baseline over the days `mask` selects (a boolean array over the
        dataset's rows, normally one contiguous date range)."""
        if self.missing_flags:
            return unavailable("The dataset has no " + ", ".join(self.missing_flags)
                               + " column, which the baseline needs.")
        if not mask.any():
            return unavailable("No days in this range.")
        days = {g: int((self.ind[g] & mask).sum()) for g in GROUPS}
        picked = np.flatnonzero(mask)
        start, end = self.dates[picked[0]], self.dates[picked[-1]]
        if all(days[g] >= MIN_DAYS for g in GROUPS):
            means = {g: float(self.revenue[self.ind[g] & mask].mean()) for g in GROUPS}
            return self._finish(means, days, start, end, widened=False)

        # Widen around the range, a week either side at a time.
        first, last = self.dates[0], self.dates[-1]
        pad = WIDEN_STEP
        while True:
            lo_date, hi_date = start - pad.to_timedelta64(), end + pad.to_timedelta64()
            lo = int(np.searchsorted(self.dates, lo_date, side="left"))
            hi = int(np.searchsorted(self.dates, hi_date, side="right"))
            days = {g: int(self.count[g][hi] - self.count[g][lo]) for g in GROUPS}
            if all(days[g] >= MIN_DAYS for g in GROUPS):
                means = {g: float((self.total[g][hi] - self.total[g][lo]) / days[g]) for g in GROUPS}
                return self._finish(means, days, self.dates[lo], self.dates[hi - 1], widened=True)
            if lo_date <= first and hi_date >= last:
                missing = [g.upper() for g in GROUPS if days[g] < MIN_DAYS]
                return unavailable(
                    "The dataset has no " + " or ".join(missing) + " days (see the baseline "
                    "definition), so a baseline cannot be estimated."
                )
            pad += WIDEN_STEP

    @staticmethod
    def _finish(means: dict[str, float], days: dict[str, int], start: Any, end: Any,
                *, widened: bool) -> Estimate:
        z = means["x"] - means["y"]
        return Estimate(
            per_day=means["r"] - z, x=means["x"], y=means["y"], r=means["r"], z=z,
            days=days, window_from=pd.Timestamp(start), window_to=pd.Timestamp(end),
            widened=widened,
        )
