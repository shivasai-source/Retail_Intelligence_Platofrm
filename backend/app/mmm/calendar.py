"""MMM Calendar payload — when each channel was on air, month by month.

The MMM twin of TPO's promotion calendar (app/tpo/promo_calendar.py), shaped
the same way — rows by month for one year, plus a detail view for one cell —
but over media flighting instead of promotions:

    matrix(year)            channel x month: spend, active days, an intensity
                            level for the heat shading; and per month the
                            revenue, total spend and promotion/festival days.
    month_detail(year, m)   every day of that month: revenue, spend, the
                            channels that ran, and the day's flags.
"""

from __future__ import annotations

from functools import lru_cache
from typing import Any

import pandas as pd

from app.mmm import loader, schema
from app.tpo import formatting as F

MONTHS = ("January", "February", "March", "April", "May", "June", "July",
          "August", "September", "October", "November", "December")


def clear_cache() -> None:
    matrix.cache_clear()
    month_detail.cache_clear()


def _level(value: float, cuts: list[float]) -> int:
    """0 = no spend, 1-4 = quartile of the year's non-zero channel-months."""
    if value <= 0:
        return 0
    return 1 + sum(1 for c in cuts if value > c)


@lru_cache(maxsize=32)
def matrix(year: int, currency: str = "INR") -> dict[str, Any]:
    currency = F.normalise_currency(currency)
    frame = loader.get_frame()
    years = loader.years(frame)
    if year not in years:
        raise ValueError(f"The MMM dataset has no rows for {year}.")
    rows = frame[frame["Date"].dt.year == year]
    media = loader.media_columns(frame)
    month = rows["Date"].dt.month

    spend = rows[media].groupby(month).sum()
    active = (rows[media] > 0).groupby(month).sum()
    nonzero = [float(v) for v in spend.to_numpy().ravel() if v > 0]
    cuts = [float(q) for q in pd.Series(nonzero).quantile([0.25, 0.5, 0.75])] if nonzero else []

    channels = []
    for col in media:
        cells = []
        for m in range(1, 13):
            value = float(spend.at[m, col]) if m in spend.index else 0.0
            days = int(active.at[m, col]) if m in active.index else 0
            cells.append({
                "month": m, "spend": round(value, 2), "spend_display": F.money(value, currency)
                if value else "", "active_days": days, "level": _level(value, cuts),
                "has_data": m in spend.index,
            })
        total = float(rows[col].sum())
        channels.append({
            "column": col, "label": schema.channel_label(col), "family": schema.family_of(col),
            "total": round(total, 2), "total_display": F.money(total, currency), "cells": cells,
        })
    channels.sort(key=lambda c: c["total"], reverse=True)

    months = []
    for m in range(1, 13):
        part = rows[month == m]
        has = not part.empty
        total_spend = float(part[media].sum(axis=1).sum()) if has else 0.0
        revenue = float(part["Revenue"].sum()) if has else 0.0
        months.append({
            "month": m, "name": MONTHS[m - 1], "abbr": MONTHS[m - 1][:3], "has_data": has,
            "days": len(part),
            "revenue": round(revenue, 2), "revenue_display": F.money(revenue, currency) if has else "",
            "spend": round(total_spend, 2),
            "spend_display": F.money(total_spend, currency) if has else "",
            "media_days": int((part[media].sum(axis=1) > 0).sum()) if has else 0,
            "promo_days": int(part["Promotion_Flag"].sum()) if has and "Promotion_Flag" in part else 0,
            "festival_days": int(part["Festival_Flag"].sum()) if has and "Festival_Flag" in part else 0,
            "seasonal_days": int(part["Seasonal_Flag"].sum()) if has and "Seasonal_Flag" in part else 0,
        })

    return {"year": year, "years": years, "currency": currency,
            "months": months, "channels": channels}


@lru_cache(maxsize=64)
def month_detail(year: int, month: int, currency: str = "INR") -> dict[str, Any]:
    if not 1 <= month <= 12:
        raise ValueError("month must be 1-12.")
    currency = F.normalise_currency(currency)
    frame = loader.get_frame()
    media = loader.media_columns(frame)
    rows = frame[(frame["Date"].dt.year == year) & (frame["Date"].dt.month == month)]
    if rows.empty:
        raise ValueError(f"The MMM dataset has no rows for {MONTHS[month - 1]} {year}.")

    days = []
    for _, r in rows.sort_values("Date").iterrows():
        on = sorted(((c, float(r[c])) for c in media if r[c] > 0), key=lambda x: x[1], reverse=True)
        total = sum(v for _, v in on)
        days.append({
            "date": r["Date"].strftime("%d-%m-%Y"),
            "weekday": r["Date"].strftime("%a"),
            "day": int(r["Date"].day),
            "revenue": round(float(r["Revenue"]), 2),
            "revenue_display": F.money(float(r["Revenue"]), currency),
            "spend": round(total, 2),
            "spend_display": F.money(total, currency) if total else "—",
            "channels": [{"label": schema.channel_label(c), "spend_display": F.money(v, currency)}
                         for c, v in on],
            "festival": bool(r.get("Festival_Flag", 0) == 1),
            "seasonal": bool(r.get("Seasonal_Flag", 0) == 1),
            "promotion": bool(r.get("Promotion_Flag", 0) == 1),
            "promotion_type": str(r["Promotion_Type"]) if "Promotion_Type" in r else "",
        })
    return {"year": year, "month": month, "month_name": MONTHS[month - 1],
            "currency": currency, "days": days}
