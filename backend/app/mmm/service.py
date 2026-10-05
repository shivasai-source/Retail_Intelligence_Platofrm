"""MMM Insights Hub payload — every figure for one filter scope, in one response.

WHAT IS MEASURED, AND WHAT IS ESTIMATED.
    Measured: revenue, ad spend, days, and averages and shares of them. Each
    is a plain aggregate of the uploaded file.
    Estimated: the BASELINE, and everything derived from it — Incremental
    Revenue, ROAS, the ad lift per day. The estimate is app/mmm/baseline.py,
    re-run for every range this module reports on: the scope, each comparison
    period, and each bucket of the trend. Nothing reuses a baseline estimated
    for a different range.

    ROAS = (Total Revenue − Baseline Revenue) ÷ Total Ad Spend, a multiple at
    2 dp ("1.34x"), the same unit TPO's ROI carries.

COMPARISONS ARE LIKE FOR LIKE. The KPI deltas compare with the same dates a
year earlier (YAGO). The comparison card adds PAGO (the equal-length period just
before) and MAGO (the same dates a month earlier). A comparison period that
falls outside the file, or a scope that is not one contiguous range (every
January across all years, say), has no comparison. It is shown as unavailable,
never as a 0% change.

Money is carried raw in rupees beside its display string (app/tpo/formatting,
so ₹ crore/lakh and the INR/USD toggle render exactly as TPO's do), two
decimals throughout. Counts stay whole.
"""

from __future__ import annotations

from functools import lru_cache
from typing import Any, Callable

import numpy as np
import pandas as pd

from app.mmm import baseline as B
from app.mmm import loader, schema
from app.mmm.scope import (COMPARISONS, EVENTS, Scope, comparison_window, day_mask,
                           period_mask, span_label, spend_columns)
from app.tpo import formatting as F

GRANULARITIES = ("day", "week", "month")
#: Longest scope a daily trend is drawn for. Past this it falls back to weekly.
MAX_DAILY_SPAN_DAYS = 400

MONTH_NAMES = ("January", "February", "March", "April", "May", "June", "July",
               "August", "September", "October", "November", "December")


def clear_cache() -> None:
    hub.cache_clear()
    filters.cache_clear()


# --- metrics --------------------------------------------------------------------

#: Every metric the hub reports, in the order the Add KPI menu and the
#: comparison card list them. `unit` picks the formatter; `better` says which
#: way is good news (None = a rise is neither, as with spend).
METRICS: tuple[dict[str, Any], ...] = (
    {"key": "revenue", "label": "Total Revenue", "unit": "currency", "better": "up",
     "formula": "Sum of Revenue over the days in scope."},
    {"key": "spend", "label": "Total Ad Spend", "unit": "currency", "better": None,
     "formula": "Sum of the selected channels' *_Spend columns over the days in scope "
                "(every channel when none is selected)."},
    {"key": "roas", "label": "ROAS", "unit": "multiple", "better": "up",
     "formula": "Incremental Revenue ÷ Total Ad Spend, where Incremental Revenue = "
                "Total Revenue − Baseline Revenue. 1.00x returns the spend."},
    {"key": "baseline", "label": "Baseline Revenue", "unit": "currency", "better": "up",
     "formula": "Baseline per day × days in scope. Baseline per day = R − (X − Y), "
                "estimated over this range."},
    {"key": "incremental", "label": "Incremental Revenue", "unit": "currency", "better": "up",
     "formula": "Total Revenue − Baseline Revenue."},
    {"key": "baseline_per_day", "label": "Avg Daily Baseline", "unit": "currency", "better": "up",
     "formula": "R − Z, where Z = X − Y. X: ad spend with all three event flags; Y: no ad "
                "spend with all three flags; R: ad spend with no flags. Each an average "
                "daily revenue."},
    {"key": "avg_daily_revenue", "label": "Avg Daily Revenue", "unit": "currency", "better": "up",
     "formula": "Total Revenue ÷ days in scope."},
    {"key": "ad_lift", "label": "Ad Revenue Lift / Day", "unit": "currency", "better": "up",
     "formula": "Z = X − Y: average daily revenue on days with ad spend and all three "
                "event flags, minus the same on days with no ad spend."},
    {"key": "media_days", "label": "Days With Ad Spend", "unit": "count", "better": "up",
     "formula": "Days on which the selected channels spent more than 0."},
)
METRIC = {m["key"]: m for m in METRICS}


def _fmt(unit: str, currency: str) -> Callable[[float | None], str]:
    if unit == "currency":
        return lambda v: F.money(v, currency)
    if unit == "multiple":
        return lambda v: F.multiple(v)
    return lambda v: F.quantity(v) if v is not None else "—"


def _delta(unit: str, now: float | None, before: float | None) -> tuple[float | None, str, str]:
    """(value, display, basis). A multiple moves in multiples (+0.20); every
    other unit moves as a growth percentage."""
    if now is None or before is None:
        return None, "", ""
    if unit == "multiple":
        d = round(now - before, 2)
        return d, F.multiple(d, signed=True), "multiples"
    if before == 0:
        return None, "", ""
    d = round((now - before) / abs(before) * 100, 2)
    return d, F.percent(d, signed=True), "percent"


def _good(metric: dict[str, Any], delta: float | None) -> bool | None:
    if delta is None or delta == 0 or metric["better"] is None:
        return None
    return delta > 0


# --- the measure of one set of days ------------------------------------------


class _Ctx:
    """Everything the measures of one request share."""

    def __init__(self, scope: Scope):
        self.frame = loader.get_frame()
        self.media_all = loader.media_columns(self.frame)
        self.media = spend_columns(scope, self.media_all)
        self.engine = B.Engine(self.frame, self.media)
        self.spend_day = self.frame[self.media].sum(axis=1).to_numpy()
        self.revenue = self.frame["Revenue"].to_numpy(dtype=float)
        self.dates = self.frame["Date"]
        self.day = day_mask(self.frame, scope)
        self.first, self.last = self.dates.iloc[0], self.dates.iloc[-1]


def _measure(ctx: _Ctx, pmask: np.ndarray) -> dict[str, Any]:
    """Every metric for the period `pmask`, after the scope's day filters. The
    baseline is estimated over the PERIOD's days (see app/mmm/scope.py)."""
    rows = pmask & ctx.day
    days = int(rows.sum())
    revenue = float(ctx.revenue[rows].sum())
    spend = float(ctx.spend_day[rows].sum())
    est = ctx.engine.estimate(pmask)
    base = est.per_day * days if est.available and days else None
    incremental = revenue - base if base is not None else None
    return {
        "values": {
            "revenue": revenue,
            "spend": spend,
            "roas": incremental / spend if incremental is not None and spend > 0 else None,
            "baseline": base,
            "incremental": incremental,
            "baseline_per_day": est.per_day,
            "avg_daily_revenue": revenue / days if days else None,
            "ad_lift": est.z,
            "media_days": int((ctx.spend_day[rows] > 0).sum()),
        },
        "days": days,
        "estimate": est,
    }


def _window_mask(ctx: _Ctx, start: pd.Timestamp, end: pd.Timestamp) -> np.ndarray:
    return ((ctx.dates >= start) & (ctx.dates <= end)).to_numpy()


# --- filters --------------------------------------------------------------------


@lru_cache(maxsize=1)
def filters() -> dict[str, Any]:
    """Every option the filter bar offers, read from the installed file."""
    frame = loader.get_frame()
    media = loader.media_columns(frame)
    months = sorted(int(m) for m in frame["Date"].dt.month.unique())
    return {
        "years": loader.years(frame),
        "quarters": [{"code": q, "name": f"Q{q}"} for q in
                     sorted(int(q) for q in frame["Date"].dt.quarter.unique())],
        "months": [{"code": m, "name": MONTH_NAMES[m - 1]} for m in months],
        "weeks": sorted(int(w) for w in frame["Week_of_Year"].unique()),
        "channels": [{"code": c, "name": schema.channel_label(c), "family": schema.family_of(c)}
                     for c in media],
        "promotion_types": sorted(frame["Promotion_Type"].astype(str).unique())
        if "Promotion_Type" in frame else [],
        "events": [{"code": k, "name": v} for k, v in EVENTS.items()
                   if k == "none" or f"{v}_Flag" in frame],
        "date_range": {"from": frame["Date"].min().date().isoformat(),
                       "to": frame["Date"].max().date().isoformat()},
    }


# --- the hub --------------------------------------------------------------------


@lru_cache(maxsize=64)
def hub(scope: Scope, granularity: str = "month", currency: str = "INR") -> dict[str, Any]:
    if granularity not in GRANULARITIES:
        raise ValueError(f"granularity must be one of {', '.join(GRANULARITIES)}.")
    currency = F.normalise_currency(currency)
    money = lambda v: F.money(v, currency)  # noqa: E731
    ctx = _Ctx(scope)
    frame = ctx.frame

    pmask = period_mask(frame, scope)
    if not pmask.any():
        raise ValueError("The MMM dataset has no days in this period.")
    rows_mask = pmask & ctx.day
    rows = frame[rows_mask]
    period_dates = ctx.dates[pmask]
    start, end = period_dates.iloc[0], period_dates.iloc[-1]
    # One unbroken range? Every January across all years is not, and has no
    # "period before" to compare with.
    contiguous = int(pmask.sum()) == int(_window_mask(ctx, start, end).sum())

    current = _measure(ctx, pmask)
    est: B.Estimate = current["estimate"]

    # --- comparisons ----------------------------------------------------------
    windows: dict[str, dict[str, Any]] = {}
    for kind, full in COMPARISONS.items():
        entry: dict[str, Any] = {"key": kind, "label": kind.upper(), "full": full,
                                 "available": False, "reason": "", "period_label": "",
                                 "values": {}, "delta": {}}
        if not contiguous:
            entry["reason"] = "Pick one year, or a date range, to compare periods"
        else:
            c_start, c_end = comparison_window(kind, start, end)
            entry["period_label"] = span_label(c_start, c_end)
            if c_start < ctx.first or c_end > ctx.last:
                entry["reason"] = (f"{entry['period_label']} is outside the data "
                                   f"({span_label(ctx.first, ctx.last)})")
            else:
                then = _measure(ctx, _window_mask(ctx, c_start, c_end))
                if then["days"] == 0:
                    entry["reason"] = f"No days match these filters in {entry['period_label']}"
                else:
                    entry["available"] = True
                    for m in METRICS:
                        fmt = _fmt(m["unit"], currency)
                        v = then["values"][m["key"]]
                        d, d_display, basis = _delta(m["unit"], current["values"][m["key"]], v)
                        entry["values"][m["key"]] = {"value": _r(v), "display": fmt(v)}
                        entry["delta"][m["key"]] = {"value": d, "display": d_display or "—",
                                                    "basis": basis, "good": _good(m, d)}
        windows[kind] = entry

    yago = windows["yago"]
    kpis = []
    for m in METRICS:
        fmt = _fmt(m["unit"], currency)
        v = current["values"][m["key"]]
        prev = yago["values"].get(m["key"]) if yago["available"] else None
        delta = yago["delta"].get(m["key"]) if yago["available"] else None
        unavailable = v is None
        kpis.append({
            "key": m["key"], "label": m["label"], "kind": m["unit"],
            "value": _r(v), "display": fmt(v),
            "previous": prev["value"] if prev else None,
            "delta": delta["value"] if delta else None,
            "delta_display": delta["display"] if delta and delta["value"] is not None else "",
            "comparison": f"vs {yago['period_label']}" if delta and delta["value"] is not None else "",
            "available": not unavailable,
            "unavailable_reason": (est.reason or "No ad spend in scope") if unavailable else "",
            "help": m["formula"],
        })

    # --- trend ----------------------------------------------------------------
    gran = granularity
    if gran == "day" and (end - start).days + 1 > MAX_DAILY_SPAN_DAYS:
        gran = "week"
    trend = _trend(ctx, pmask, rows_mask, gran, currency)

    # --- channels -------------------------------------------------------------
    spend_total = current["values"]["spend"]
    channels = []
    for col in ctx.media:
        total = float(rows[col].sum())
        active = int((rows[col] > 0).sum())
        share = round(total / spend_total * 100, 2) if spend_total else 0.0
        channels.append({
            "column": col, "label": schema.channel_label(col), "family": schema.family_of(col),
            "spend": round(total, 2), "spend_display": money(total),
            "share": share, "share_display": F.percent(share), "active_days": active,
            "avg_active_day": round(total / active, 2) if active else None,
            "avg_active_day_display": money(total / active) if active else "—",
        })
    channels.sort(key=lambda c: c["spend"], reverse=True)
    families: dict[str, float] = {}
    for c in channels:
        families[c["family"]] = families.get(c["family"], 0.0) + c["spend"]
    family_rows = [
        {"family": name, "spend": round(v, 2), "spend_display": money(v),
         "share": round(v / spend_total * 100, 2) if spend_total else 0.0,
         "share_display": F.percent(v / spend_total * 100 if spend_total else 0.0)}
        for name, v in sorted(families.items(), key=lambda kv: kv[1], reverse=True)
    ]

    # --- promotions -----------------------------------------------------------
    promotions = []
    revenue_total = current["values"]["revenue"]
    days = current["days"]
    if "Promotion_Type" in rows and days:
        grouped = rows.groupby("Promotion_Type")["Revenue"].agg(["count", "sum", "mean"])
        for name, r in grouped.sort_values("mean", ascending=False).iterrows():
            promotions.append({
                "type": str(name), "days": int(r["count"]),
                "share_of_days": round(r["count"] / days * 100, 2),
                "revenue": round(float(r["sum"]), 2), "revenue_display": money(float(r["sum"])),
                "share_of_revenue": round(r["sum"] / revenue_total * 100, 2) if revenue_total else 0.0,
                "avg_revenue": round(float(r["mean"]), 2),
                "avg_revenue_display": money(float(r["mean"])),
            })

    # --- days with vs without events -----------------------------------------
    events = []
    on_air = ctx.spend_day[rows_mask] > 0
    tests: list[tuple[str, str, np.ndarray]] = [("ad_spend", "Ad spend", on_air)]
    for flag, label in (("Holiday_Flag", "Holiday"), ("Trending_Flag", "Trending"),
                        ("Promotion_Flag", "Promotion")):
        if flag in rows:
            tests.append((flag, label, (rows[flag] == 1).to_numpy()))
    present = [f for f in B.FLAGS if f in rows]
    if present:
        tests.append(("any_event", "Any event", (rows[present] == 1).any(axis=1).to_numpy()))
    revenue_rows = rows["Revenue"].to_numpy(dtype=float)
    for key, label, yes in tests:
        with_rev = float(revenue_rows[yes].mean()) if yes.any() else None
        without_rev = float(revenue_rows[~yes].mean()) if (~yes).any() else None
        lift = (with_rev - without_rev) / without_rev * 100 if with_rev is not None and without_rev else None
        events.append({
            "key": key, "label": label,
            "with_days": int(yes.sum()), "without_days": int((~yes).sum()),
            "with_avg": _r(with_rev), "with_avg_display": money(with_rev),
            "without_avg": _r(without_rev), "without_avg_display": money(without_rev),
            "difference": _r(lift), "difference_display": F.percent(lift, signed=True) if lift is not None else "—",
        })

    return {
        "meta": {
            "scope": scope.to_dict(),
            "years": loader.years(frame),
            "period": {"from": start.strftime("%d-%m-%Y"), "to": end.strftime("%d-%m-%Y")},
            "period_label": span_label(start, end),
            "days": days,
            "period_days": int(pmask.sum()),
            "contiguous": contiguous,
            "currency": currency,
            # Raw values are rupees; a chart axis multiplies by this to label
            # in the display currency, as TPO's trend does.
            "exchange_rate": F.convert(1.0, currency),
            "channels": len(ctx.media),
            "channels_total": len(ctx.media_all),
            "comparison": f"vs {yago['period_label']}" if yago["available"] else "",
            "data_range": span_label(ctx.first, ctx.last),
        },
        "baseline": {
            **est.to_dict(money),
            "total": _r(current["values"]["baseline"]),
            "total_display": money(current["values"]["baseline"]),
            "scope_days": days,
        },
        "kpis": kpis,
        "trend": trend,
        "comparison": {
            "period_label": span_label(start, end),
            "metrics": [{"key": m["key"], "label": m["label"], "unit": m["unit"],
                         "formula": m["formula"]} for m in METRICS],
            "current": {m["key"]: {"value": _r(current["values"][m["key"]]),
                                   "display": _fmt(m["unit"], currency)(current["values"][m["key"]])}
                        for m in METRICS},
            "windows": [windows[k] for k in COMPARISONS],
        },
        "channels": channels,
        "families": family_rows,
        "promotions": promotions,
        "events": events,
    }


def _r(v: float | None) -> float | None:
    return round(float(v), 2) if v is not None else None


def _trend(ctx: _Ctx, pmask: np.ndarray, rows_mask: np.ndarray, gran: str,
           currency: str) -> dict[str, Any]:
    """Revenue, ad spend, baseline and ROAS per bucket. Each bucket's baseline
    is estimated over that bucket's own days."""
    money = lambda v: F.money(v, currency)  # noqa: E731
    dates = ctx.dates
    if gran == "day":
        bucket = dates.dt.normalize()
        fmt = "%d %b %Y"
    elif gran == "week":
        bucket = dates.dt.to_period("W-SUN").dt.start_time
        fmt = "%d %b %Y"
    else:
        bucket = dates.dt.to_period("M").dt.start_time
        fmt = "%b %Y"
    bucket_arr = bucket.to_numpy()
    keys = pd.unique(bucket_arr[rows_mask])

    out: dict[str, list[Any]] = {k: [] for k in (
        "labels", "revenue", "spend", "baseline", "roas",
        "revenue_display", "spend_display", "baseline_display", "roas_display", "widened")}
    for key in sorted(keys):
        in_bucket = bucket_arr == key
        rows = rows_mask & in_bucket
        days = int(rows.sum())
        revenue = float(ctx.revenue[rows].sum())
        spend = float(ctx.spend_day[rows].sum())
        est = ctx.engine.estimate(pmask & in_bucket)
        base = est.per_day * days if est.available else None
        roas = (revenue - base) / spend if base is not None and spend > 0 else None
        out["labels"].append(pd.Timestamp(key).strftime(fmt))
        out["revenue"].append(round(revenue, 2))
        out["spend"].append(round(spend, 2))
        out["baseline"].append(_r(base))
        out["roas"].append(_r(roas))
        out["revenue_display"].append(money(revenue))
        out["spend_display"].append(money(spend))
        out["baseline_display"].append(money(base))
        out["roas_display"].append(F.multiple(roas))
        out["widened"].append(est.widened)
    return {"granularity": gran, **out}
