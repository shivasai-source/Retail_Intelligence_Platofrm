"""REVENUE DECOMPOSITION — what the revenue of a scope is made of.

    Revenue = Baseline + Festival + Seasonal + Promotion + Σ channel contribution

THE BASELINE is the page's own per-range baseline (app/mmm/baseline.py,
R − (X − Y) per day × days), so the donut's Baseline is the KPI deck's
Baseline Revenue to the rupee. What is left — the incremental revenue — is
split across its drivers.

THE SPLIT comes from one regression over every day of the dataset:

    Revenue_d = b0 + b_trend·t_d + b_media·Spend_d
                   + b_fest·Festival_d + b_seas·Seasonal_d + b_promo·Promotion_d

with b_media and the three event coefficients held ≥ 0 (a driver cannot take
revenue away) and the trend free, so growth over the years is not credited to
whatever else grew. Over the scope's days each driver's modelled contribution
is its coefficient × its summed input; the incremental revenue is divided in
proportion to those. Spend is the selected channels' total: a per-channel
regression credits the time trend to whichever channel happens to grow, so the
media slice is divided across channel families — and within a family across
its sub-channels — by share of spend. (Each channel's own ROAS cannot be used
as the weight: channels on air on the same days get the same revenue-on-air
lift whatever they spend, so it would split the slice evenly between them.)

Descriptive, not causal: the regression shows how revenue moved with each
driver in this data. The fit is cached per selected channel set and dropped
with every other MMM cache on a new upload.
"""

from __future__ import annotations

from dataclasses import dataclass
from functools import lru_cache
from typing import Any, Callable

import numpy as np
import pandas as pd

from app.mmm import loader, schema

#: The event drivers: flag column, key, label.
EVENTS: tuple[tuple[str, str, str], ...] = (
    ("Festival_Flag", "festival", "Festival"),
    ("Seasonal_Flag", "seasonal", "Seasonal"),
    ("Promotion_Flag", "promotion", "Promotion"),
)


@dataclass(frozen=True)
class Fit:
    intercept: float
    trend: float  # per year
    media: float  # revenue per rupee of selected-channel spend
    events: dict[str, float]  # flag column -> revenue per flagged day
    r2: float
    days: int
    start: pd.Timestamp


def _years(dates: pd.Series, start: pd.Timestamp) -> np.ndarray:
    return ((dates - start).dt.days / 365.25).to_numpy(dtype=float)


def _ols(design: np.ndarray, y: np.ndarray) -> np.ndarray:
    coef, *_ = np.linalg.lstsq(design, y, rcond=None)
    return coef


@lru_cache(maxsize=16)
def fit(media: tuple[str, ...]) -> Fit:
    """The regression over every day, for `media` as the ad-spend driver.

    Non-negativity by active set: fit, drop the most negative constrained
    coefficient, refit — exact for this handful of drivers."""
    frame = loader.get_frame()
    start = frame["Date"].min()
    y = frame["Revenue"].to_numpy(dtype=float)
    free = {"trend": _years(frame["Date"], start)}
    constrained: dict[str, np.ndarray] = {}
    if media:
        constrained["media"] = frame[list(media)].sum(axis=1).to_numpy(dtype=float)
    for flag, _key, _label in EVENTS:
        if flag in frame:
            constrained[flag] = frame[flag].to_numpy(dtype=float)

    active = [k for k, v in constrained.items() if v.any()]
    while True:
        names = ["intercept", *free, *active]
        design = np.column_stack([np.ones(len(y)), *free.values(), *(constrained[k] for k in active)])
        coef = dict(zip(names, _ols(design, y)))
        negative = [k for k in active if coef[k] < 0]
        if not negative:
            break
        active.remove(min(negative, key=lambda k: coef[k]))

    predicted = design @ np.array([coef[n] for n in names])
    total = ((y - y.mean()) ** 2).sum()
    r2 = float(1 - ((y - predicted) ** 2).sum() / total) if total else 0.0
    return Fit(
        intercept=float(coef["intercept"]),
        trend=float(coef["trend"]),
        media=float(coef.get("media", 0.0)),
        events={flag: float(coef.get(flag, 0.0)) for flag, _k, _l in EVENTS},
        r2=r2,
        days=len(y),
        start=start,
    )


def _split(amount: float, weights: dict[str, float]) -> dict[str, float]:
    """`amount` divided in proportion to `weights` (equal split if all zero)."""
    total = sum(w for w in weights.values() if w > 0)
    if total <= 0:
        n = len(weights) or 1
        return {k: amount / n for k in weights}
    return {k: amount * max(w, 0.0) / total for k, w in weights.items()}


def decompose(
    rows: pd.DataFrame,
    media: list[str],
    baseline_total: float | None,
    channels: list[dict[str, Any]],
    money: Callable[[float], str],
    percent: Callable[[float], str],
) -> dict[str, Any]:
    """The decomposition of the scope's days `rows`. `channels` are the hub's
    channel rows (spend, roas, family) for the same scope."""
    revenue = float(rows["Revenue"].sum())
    if not len(rows) or revenue <= 0:
        return {"available": False, "reason": "No revenue in this selection.", "total": 0.0,
                "total_display": money(0.0), "slices": []}
    model = fit(tuple(media))
    if baseline_total is None:
        # No per-range estimate for this scope: the model's own base instead.
        t = _years(rows["Date"], model.start)
        baseline_total = float((model.intercept + model.trend * t).sum())
        baseline_source = "model"
    else:
        baseline_source = "per-range"
    baseline = min(max(baseline_total, 0.0), revenue)
    incremental = revenue - baseline

    # Each driver's modelled contribution over these days.
    spend = float(rows[media].sum(axis=1).sum()) if media else 0.0
    drivers: dict[str, float] = {"media": model.media * spend}
    for flag, key, _label in EVENTS:
        drivers[key] = model.events[flag] * float(rows[flag].sum()) if flag in rows else 0.0
    shares = _split(incremental, drivers) if incremental > 0 else {k: 0.0 for k in drivers}

    slices: list[dict[str, Any]] = []

    def add(key: str, label: str, kind: str, value: float, members: list[dict[str, Any]] | None = None) -> None:
        share = value / revenue * 100
        slices.append({"key": key, "label": label, "kind": kind,
                       "value": round(value, 2), "display": money(value),
                       "share": round(share, 2), "share_display": percent(share),
                       "members": members or []})

    add("baseline", "Baseline", "baseline", baseline)
    for _flag, key, label in sorted(EVENTS, key=lambda e: -shares[e[1]]):
        if shares[key] > 0:
            add(key, label, "event", shares[key])

    # The media slice, across channel families and sub-channels by spend.
    media_total = shares["media"]
    if media_total > 0 and channels:
        per_channel = _split(media_total, {c["column"]: c["spend"] for c in channels})
        families: dict[str, list[dict[str, Any]]] = {}
        for c in channels:
            families.setdefault(c["family"], []).append(c)
        family_values = {f: sum(per_channel[c["column"]] for c in cs) for f, cs in families.items()}
        for family, value in sorted(family_values.items(), key=lambda kv: -kv[1]):
            if value <= 0:
                continue
            members = sorted(
                ({"label": c["label"], "value": round(per_channel[c["column"]], 2),
                  "display": money(per_channel[c["column"]])}
                 for c in families[family] if per_channel[c["column"]] > 0),
                key=lambda m: -m["value"])
            add(f"family:{family}", family, "media", value, members)

    return {
        "available": True,
        "reason": "" if incremental > 0 else "Revenue in this selection does not exceed its baseline.",
        "total": round(revenue, 2),
        "total_display": money(revenue),
        "incremental": round(incremental, 2),
        "incremental_display": money(incremental),
        "baseline_source": baseline_source,
        "r2": round(model.r2, 2),
        "slices": slices,
    }
