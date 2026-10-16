"""THE MMM BUDGET ALLOCATOR: a budget of the reader's choosing, split for the
most net profit.

For a selected run of ISO weeks (the Budget Optimizer's periods) the reader
enters a budget. Three plans are scored on budget_model's fitted response,
exactly as app/mmm/budget.py scores its plans:

    Actual      what the period really spent, as the file holds it
    Same mix    the entered budget, split as the actual plan splits it
                (every channel-week scaled by budget / actual)
    Optimized   the entered budget, split for the most net profit

The baseline is the same in all three: it is the period's own, with no ads.
The total is the entered budget, so the most net profit is the most revenue.
What may move follows budget.MODES, measured against the same-mix plan:
"weeks only" keeps every channel's share of the budget, "channels only"
every week's. There are no other limits: any channel may take any amount.

    budget effect   Same mix - Actual       what the new budget does alone
    mix effect      Optimized - Same mix    what splitting it well adds

THE PROFIT CURVE (frontier): net profit at every budget from zero to
FRONTIER_TOP x the actual, split as the actual plan splits it and split as
well as possible -- the optimizer run at each budget -- with its P10 - P90,
and the budget where the best split's net profit peaks. It does not depend on
the entered budget, so it is cached per period and mode.
"""

from __future__ import annotations

from dataclasses import replace
from typing import Any

import numpy as np

from app.mmm import budget as B
from app.tpo import formatting as F

#: The profit curve runs from zero to this multiple of the actual budget.
FRONTIER_TOP = 3.0
#: Budgets on the profit curve.
FRONTIER_POINTS = 19
#: Golden-section steps that place the peak between two curve budgets.
PEAK_STEPS = 8

_frontiers: dict[tuple, dict[str, Any]] = {}


def _scaled(per: B.Period, budget: float) -> B.Period:
    """The period with its actual plan scaled to `budget`: the same mix."""
    if per.budget <= 0:
        raise ValueError("Nothing was spent in this period, so there is no mix to scale.")
    return replace(per, current=per.current * (budget / per.budget))


def _central_profit(per: B.Period, plan: np.ndarray, baseline: float) -> float:
    return baseline + float(B._lift(per, per.model.central, plan).sum()) - float(plan.sum())


def _marginals(per: B.Period, plan: np.ndarray) -> np.ndarray:
    """What the next rupee returns in each channel, spread as its plan is."""
    g = B._gradient(per, per.model.central, plan)
    out = np.zeros(len(plan))
    for j in range(len(plan)):
        total = plan[j].sum()
        out[j] = float(plan[j] @ g[j] / total) if total > 0 else float(g[j].max())
    return out


def _channels(per: B.Period, same: B.Period, plan: np.ndarray,
              act: B.Scored, mix: B.Scored, new: B.Scored, currency: str) -> list[dict[str, Any]]:
    """Every channel: its spend and media-driven revenue in the three plans,
    its share of the budget, what its next rupee returns once optimized, and
    whether the optimized plan takes a week past its highest weekly spend in
    the data (the model's curve is extrapolated there)."""
    m = per.model
    peaks = B.peak_weeks(m)
    marg = _marginals(same, plan)
    sym = "$" if currency == "USD" else "₹"
    rows = []
    for j, c in enumerate(m.channels):
        a, s, o = float(per.current[j].sum()), float(same.current[j].sum()), float(plan[j].sum())
        rows.append({
            "key": c, "label": B.channel_label(c),
            "actual": round(a, 2), "actual_display": F.money(a, currency),
            "same": round(s, 2), "same_display": F.money(s, currency),
            "optimized": round(o, 2), "optimized_display": F.money(o, currency),
            "share_actual_pct": round(a / per.budget * 100, 2) if per.budget else 0.0,
            "share_optimized_pct": round(o / same.budget * 100, 2) if same.budget else 0.0,
            "change": round(o - s, 2), "change_display": B._signed(o - s, currency),
            "change_vs_actual": round(o - a, 2), "change_vs_actual_display": B._signed(o - a, currency),
            "media_actual_display": F.money(float(act.by_channel[j]), currency),
            "media_same_display": F.money(float(mix.by_channel[j]), currency),
            "media_optimized_display": F.money(float(new.by_channel[j]), currency),
            "media_change_display": B._signed(float(new.by_channel[j] - mix.by_channel[j]), currency),
            "marginal": round(float(marg[j]), 4), "marginal_display": f"{sym}{marg[j]:.2f}",
            "beyond_data": bool((plan[j] > peaks[j] * 1.0001).any()),
        })
    return sorted(rows, key=lambda r: -r["optimized"])


def allocate(start: int, end: int, budget: float, currency: str = "INR", mode: str = "anywhere",
             source: str = "history") -> dict[str, Any]:
    """The three plans for `budget` (in rupees) over the period."""
    currency = F.normalise_currency(currency)
    if mode not in B.MODES:
        raise ValueError(f"Unknown mode: {mode}")
    if not budget > 0:
        raise ValueError("Enter a budget above zero.")
    per = B.period(start, end, source)
    same = _scaled(per, budget)
    plan = B.optimize_plan(same, mode)
    act, mix, new = B.score(per, per.current), B.score(same, same.current), B.score(same, plan)
    gain = lambda a, b: round(float(np.mean([y["profit"] > x["profit"] for x, y in zip(a.draws, b.draws)]) * 100), 1)  # noqa: E731
    change = budget - per.budget
    return {
        "mode": mode,
        "currency": currency,
        "exchange_rate": F.convert(1.0, currency),
        "draws": len(new.draws),
        "scope": {"start": per.weeks[0].key, "end": per.weeks[-1].key,
                  "weeks": [{"key": w.key, "label": f"W{w.week:02d} {w.year}", "start": w.start} for w in per.weeks],
                  "carryover_tail_days": B.CARRYOVER_TAIL},
        "channel_count": len(per.model.channels),
        "budget": {"value": round(budget, 2), "display": F.money(budget, currency)},
        "actual_budget": {"value": round(per.budget, 2), "display": F.money(per.budget, currency)},
        "budget_change": {"value": round(change, 2), "display": B._signed(change, currency),
                          "percent": round(change / per.budget * 100, 2)},
        "scenarios": {
            "actual": B._figures_out(act, currency),
            "same_mix": B._figures_out(mix, currency),
            "optimized": B._figures_out(new, currency),
        },
        "deltas": {
            "budget": B._deltas(act, mix, currency),
            "mix": B._deltas(mix, new, currency),
            "total": B._deltas(act, new, currency),
        },
        "chance_mix_gain_pct": gain(mix, new),
        "chance_total_gain_pct": gain(act, new),
        "channels": _channels(per, same, plan, act, mix, new, currency),
        "weekly": B._weekly(per, act, new),
        "curves": B._curves(same, plan, currency),
        "model": B.model_card(per.model),
    }


# --------------------------------------------------------------- the profit curve


def _frontier(start: int, end: int, mode: str, source: str) -> dict[str, Any]:
    per = B.period(start, end, source)
    key = (id(per.model), tuple(per.model.checks.get("source") or ()), start, end, mode)
    if key in _frontiers:
        return _frontiers[key]
    baseline = B.score(per, np.zeros_like(per.current))
    base = float(baseline.central["baseline"])
    levels = np.linspace(0.0, FRONTIER_TOP * per.budget, FRONTIER_POINTS)
    points, plans, prev = [], [], None
    for b in levels:
        same = _scaled(per, float(b))
        best = B.optimize_plan(same, mode, None if prev is None or prev[0] <= 0 else prev[1] * (b / prev[0]))
        prev = (float(b), best)
        plans.append(best)
        s_mix, s_new = B.score(same, same.current), B.score(same, best)

        def band(s: B.Scored) -> list[float]:
            return [round(float(x), 2) for x in np.percentile([d["profit"] for d in s.draws], [10, 90])]

        points.append({
            "spend": round(float(b), 2),
            "same": round(s_mix.central["profit"], 2), "same_range": band(s_mix),
            "best": round(s_new.central["profit"], 2), "best_range": band(s_new),
        })

    # The peak: golden-section search on the best split's net profit around
    # the highest curve budget (net profit is concave in the budget).
    i = int(np.argmax([p["best"] for p in points]))
    lo, hi = levels[max(i - 1, 0)], levels[min(i + 1, len(levels) - 1)]
    warm = plans[i]
    ratio = (np.sqrt(5) - 1) / 2

    def value(b: float) -> tuple[float, np.ndarray]:
        same = _scaled(per, b)
        ref = levels[i] if levels[i] > 0 else None
        p = B.optimize_plan(same, mode, None if ref is None else warm * (b / ref))
        return _central_profit(same, p, base), p

    c, d = hi - ratio * (hi - lo), lo + ratio * (hi - lo)
    fc, fd = value(c)[0], value(d)[0]
    for _ in range(PEAK_STEPS):
        if fc > fd:
            hi, d, fd = d, c, fc
            c = hi - ratio * (hi - lo)
            fc = value(c)[0]
        else:
            lo, c, fc = c, d, fd
            d = lo + ratio * (hi - lo)
            fd = value(d)[0]
    peak_b = float((lo + hi) / 2)
    peak_same = _scaled(per, peak_b)
    peak_plan = value(peak_b)[1]
    s_peak = B.score(peak_same, peak_plan)
    out = {
        "points": points,
        "actual_budget": round(per.budget, 2),
        "peak": {
            "spend": round(peak_b, 2),
            "profit": round(s_peak.central["profit"], 2),
            "range": [round(float(x), 2) for x in np.percentile([d["profit"] for d in s_peak.draws], [10, 90])],
        },
    }
    _frontiers[key] = out
    return out


def frontier(start: int, end: int, currency: str = "INR", mode: str = "anywhere", source: str = "history") -> dict[str, Any]:
    """Net profit at every budget, current split and best split, in rupees;
    the page converts with `exchange_rate`."""
    currency = F.normalise_currency(currency)
    if mode not in B.MODES:
        raise ValueError(f"Unknown mode: {mode}")
    out = _frontier(start, end, mode, source)
    peak = out["peak"]
    return {
        **out,
        "currency": currency,
        "exchange_rate": F.convert(1.0, currency),
        "peak": {**peak, "spend_display": F.money(peak["spend"], currency), "profit_display": F.money(peak["profit"], currency)},
    }
