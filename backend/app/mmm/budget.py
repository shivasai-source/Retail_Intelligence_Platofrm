"""THE MMM BUDGET OPTIMIZER: a period's ad plan, as channel x week spend.

THE PLAN. For a selected run of ISO weeks (Monday-Sunday), every channel's
spend per week. The current plan is what the file holds; the best plan keeps
the period's total budget and MOVES money for the most net profit.

EVERY CHANGE IS A MOVE. The budget is fixed, so money taken from one
channel-week arrives -- whole or in parts -- at one or more others:

    week      within the channel, to other weeks
    channel   to other channels, in the same week
    both      to other channels, in other weeks

What may move is the reader's choice (MODES): within each channel only (every
channel keeps its total), across channels within each week only (every week
keeps its total), or anywhere (only the period's total is kept).

HOW A PLAN IS SCORED (budget_model's fitted response):

    A week's spend is spread over its days in the channel's own pattern for
    that week (evenly when the channel was dark that week), then run through
    each channel's carryover and diminishing-returns curve. The plan is
    measured over the period plus CARRYOVER_TAIL days after it, so spend late
    in the period is credited with what it drives after the period ends; its
    incremental revenue is the difference against the same window with the
    period's spend set to zero.

    Revenue        = baseline revenue over the period's days
                     + incremental revenue of the period's spend
    Net profit     = Revenue - ad spend     (there is no product cost in the
                     MMM data, so this is before cost of goods)
    Profit %       = Net profit / ad spend x 100
    ROAS           = incremental revenue / ad spend

Every figure is computed on the central fit and on every bootstrap draw; the
draws give each figure's P10 - P90 (ad spend is chosen, not estimated, so it
has none), the ranges of the changes, and the chance the best plan wins.

THE OPTIMIZER: projected gradient ascent on the central fit, onto the plans
the mode allows, with the exact gradient through carryover. Every response
curve is concave, so there is one best plan and this finds it.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any

import numpy as np
from scipy.signal import lfilter

from app.mmm.budget_model import Fit, Model, adstock, get_model, hill, hill_slope
from app.tpo import formatting as F

#: Days after the period over which its carryover is credited.
CARRYOVER_TAIL = 28
#: Days before the period that set the starting carryover.
WARMUP = 90
#: Weeks in the default period.
DEFAULT_WEEKS = 13
#: Projected-gradient iterations.
MAX_ITER = 400
#: Points on each channel's response curve.
CURVE_POINTS = 21

MODES = {
    "anywhere": "Anywhere: to other weeks and other channels",
    "within_channel": "Within each channel: to its other weeks",
    "across_channels": "Across channels: within the same week",
}

#: The KPIs the page shows, and which can carry a P10 - P90.
FIGURES = ("profit", "profit_pct", "revenue", "baseline", "incremental", "spend", "roas")


class ModelNotReady(RuntimeError):
    """The response model is still training; the router answers 409."""


# --------------------------------------------------------------- weeks


@dataclass(frozen=True)
class Week:
    key: int          # iso_year * 100 + iso_week
    year: int
    week: int
    first: int        # first day index
    last: int         # last day index (inclusive)
    start: str        # ISO date of its first day in the data


def weeks(model: Model) -> list[Week]:
    iso = model.dates.isocalendar()
    keys = (iso["year"].to_numpy() * 100 + iso["week"].to_numpy()).astype(int)
    out: list[Week] = []
    i, n = 0, len(keys)
    while i < n:
        j = i
        while j + 1 < n and keys[j + 1] == keys[i]:
            j += 1
        out.append(Week(int(keys[i]), int(keys[i] // 100), int(keys[i] % 100), i, j,
                        model.dates[i].strftime("%Y-%m-%d")))
        i = j + 1
    return out


def channel_label(column: str) -> str:
    name = column[:-len("_Spend")] if column.endswith("_Spend") else column
    return name.replace("_", " ").replace("Ecommerce", "E-commerce")


def peak_weeks(m: Model) -> list[float]:
    """Each channel's highest weekly spend in the data -- the observed
    weeks only, never a forecast's."""
    seen = [w for w in weeks(m) if np.isfinite(m.revenue[w.first])]
    return [max(m.spend[w.first:w.last + 1, j].sum() for w in seen) for j in range(len(m.channels))]


def _model() -> Model:
    model = get_model()
    if model is None:
        raise ModelNotReady("The budget model is still training.")
    return model


#: What a plan is made on: the installed data, or the uploaded future plan
#: appended to it (app/mmm/forecast.py).
SOURCES = ("history", "forecast")


def _source(source: str = "history") -> tuple[Model, int]:
    """The model to plan on and the first day a period may start on: the
    data's own days, or only the forecast's days after them."""
    if source not in SOURCES:
        raise ValueError(f"Unknown source: {source}")
    if source == "history":
        return _model(), 0
    from app.mmm import forecast  # the forecast builds on this module

    ext, first, _ = forecast.extended_model()
    return ext, first


def options(source: str = "history") -> dict[str, Any]:
    model, first = _source(source)
    ws = [w for w in weeks(model) if w.first >= first]
    calendar: dict[int, list[dict[str, Any]]] = {}
    for w in ws:
        calendar.setdefault(w.year, []).append({"week": w.week, "start": w.start, "month": int(w.start[5:7])})
    # The latest whole weeks: a week the data only partly covers would read as
    # a slump that is really missing days.
    whole = [w for w in ws if w.last - w.first == 6]
    # The past: its latest weeks. A forecast: its first weeks.
    default = whole[-DEFAULT_WEEKS:] if source == "history" else whole[:DEFAULT_WEEKS]
    return {
        "calendar": [{"year": y, "weeks": calendar[y]} for y in sorted(calendar)],
        "channels": [{"key": c, "label": channel_label(c)} for c in model.channels],
        "default": {"start": default[0].key, "end": default[-1].key},
        "modes": [{"key": k, "label": v} for k, v in MODES.items()],
    }


# --------------------------------------------------------------- the period


@dataclass
class Period:
    model: Model
    weeks: list[Week]
    current: np.ndarray       # channels x weeks, rupees
    shares: list[np.ndarray]  # per week: how its spend spreads over its days
    lo: int                   # window start (day index, warm-up included)
    first: int                # the period's first day
    last: int                 # the period's last day
    hi: int                   # window end in the data (exclusive)
    pad: int                  # tail days beyond the data's last day

    @property
    def budget(self) -> float:
        return float(self.current.sum())


def period(start: int, end: int, source: str = "history") -> Period:
    model, first_day = _source(source)
    chosen = [w for w in weeks(model) if start <= w.key <= end and w.first >= first_day]
    if not chosen:
        raise ValueError("The period holds no weeks of data.")
    current = np.array([[model.spend[w.first:w.last + 1, j].sum() for w in chosen]
                        for j in range(len(model.channels))])
    shares = []
    for w in chosen:
        actual = model.spend[w.first:w.last + 1]
        totals = actual.sum(axis=0)
        shares.append(np.where(totals > 0, actual / np.where(totals > 0, totals, 1.0), 1.0 / len(actual)))
    first, last, n = chosen[0].first, chosen[-1].last, len(model.dates)
    hi = last + 1 + CARRYOVER_TAIL
    return Period(model, chosen, current, shares, max(0, first - WARMUP), first, last, min(hi, n), max(0, hi - n))


def _daily(per: Period, plan: np.ndarray) -> np.ndarray:
    """The window's daily spend with the period's days replaced by `plan`."""
    m = per.model
    spend = np.vstack([m.spend[per.lo:per.hi], np.zeros((per.pad, len(m.channels)))])
    for wi, w in enumerate(per.weeks):
        spend[w.first - per.lo:w.last - per.lo + 1] = per.shares[wi] * plan[:, wi]
    return spend


def _lift(per: Period, fit: Fit, plan: np.ndarray) -> np.ndarray:
    """Incremental revenue of the period's spend, per day (from the period's
    first day to the window's end) and channel."""
    a = per.first - per.lo
    return fit.media(_daily(per, plan))[a:] - fit.media(_daily(per, np.zeros_like(plan)))[a:]


def _channel_lift(per: Period, fit: Fit, j: int, rows: np.ndarray) -> np.ndarray:
    """Incremental revenue of channel j for each of several weekly spend rows
    (k x weeks) at once -- one carryover pass for all of them, which is what
    makes 22 curves on every draw affordable. Channels add, so the rest of the
    plan does not matter."""
    m = per.model
    a = per.first - per.lo
    window = np.concatenate([m.spend[per.lo:per.hi, j], np.zeros(per.pad)])
    cols = np.repeat(window[:, None], len(rows) + 1, axis=1)
    for wi, w in enumerate(per.weeks):
        d0, d1 = w.first - per.lo, w.last - per.lo + 1
        share = per.shares[wi][:, j]
        cols[d0:d1, :-1] = share[:, None] * rows[:, wi][None, :]
        cols[d0:d1, -1] = 0.0  # the last column: the period without spend
    c = fit.curves[j]
    shape = hill(adstock(cols, c.decay), c.kappa, c.alpha) * fit.beta[j]
    return (shape[a:, :-1] - shape[a:, -1:]).sum(axis=0)


def _totals(spend: float, baseline: float, incremental: float) -> dict[str, float | None]:
    revenue = baseline + incremental
    profit = revenue - spend
    return {
        "spend": spend, "baseline": baseline, "incremental": incremental, "revenue": revenue,
        "profit": profit,
        "profit_pct": profit / spend * 100 if spend else None,
        "roas": incremental / spend if spend else None,
    }


@dataclass
class Scored:
    plan: np.ndarray
    central: dict[str, float | None]
    draws: list[dict[str, float | None]]
    by_channel: np.ndarray     # incremental revenue per channel (central)
    weekly: np.ndarray         # points x [baseline, incremental] (central)
    weekly_draws: np.ndarray   # draws x points x [baseline, incremental]


def score(per: Period, plan: np.ndarray) -> Scored:
    """A plan's totals, per channel and week by week, on the central fit and
    every draw. The weekly points are the period's weeks plus one point for
    the carryover after it."""
    spend = float(plan.sum())

    def one(fit: Fit):
        lift = _lift(per, fit, plan)
        base = per.model.baseline_X[per.first:per.last + 1] @ fit.w
        days = lift.sum(axis=1)
        rows = [[base[w.first - per.first:w.last - per.first + 1].sum(), days[w.first - per.first:w.last - per.first + 1].sum()]
                for w in per.weeks]
        rows.append([0.0, days[per.last - per.first + 1:].sum()])
        return _totals(spend, float(base.sum()), float(days.sum())), lift.sum(axis=0), np.array(rows)

    central, by_channel, weekly = one(per.model.central)
    runs = [one(f) for f in per.model.draws]
    return Scored(plan, central, [r[0] for r in runs], by_channel, weekly, np.array([r[2] for r in runs]))


# --------------------------------------------------------------- formatting


def _fmt(key: str, value: float | None, currency: str) -> str:
    if value is None:
        return "—"
    if key == "profit_pct":
        return F.percent(value)
    if key == "roas":
        return F.multiple(value)
    return F.money(value, currency)


def _signed(value: float, currency: str) -> str:
    if abs(value) < 0.5:  # a rounding remainder, not a change: never "-₹0"
        return F.money(0.0, currency)
    return ("+" if value > 0 else "") + F.money(value, currency)


def _range(vals: np.ndarray, fmt) -> dict[str, Any]:
    lo, hi = np.percentile(vals, [10, 90])
    return {"p10": round(float(lo), 4), "p90": round(float(hi), 4), "display": f"{fmt(float(lo))} – {fmt(float(hi))}"}


def _figures_out(s: Scored, currency: str) -> dict[str, Any]:
    """Each KPI with its P10 - P90 over the draws. Ad spend is the plan's own
    choice, not an estimate, so it carries no range."""
    out: dict[str, Any] = {}
    for k in FIGURES:
        v = s.central[k]
        row: dict[str, Any] = {"value": None if v is None else round(v, 4), "display": _fmt(k, v, currency), "range": None}
        if k != "spend":
            vals = np.array([d[k] for d in s.draws if d[k] is not None])
            if len(vals):
                row["range"] = _range(vals, lambda x, k=k: _fmt(k, x, currency))
        out[k] = row
    return out


def _deltas(cur: Scored, new: Scored, currency: str) -> dict[str, Any]:
    """Each KPI's change, with the P10 - P90 of the change over the draws."""
    out: dict[str, Any] = {}
    for k in FIGURES:
        a, b = cur.central[k], new.central[k]
        if a is None or b is None:
            out[k] = None
            continue
        d = b - a

        def text(x: float, k: str = k) -> str:
            return f"{x:+,.2f} pts" if k == "profit_pct" else F.multiple(x, signed=True) if k == "roas" else _signed(x, currency)

        pct = d / abs(a) * 100 if a else None
        changes = np.array([n[k] - c[k] for n, c in zip(new.draws, cur.draws) if n[k] is not None and c[k] is not None])
        out[k] = {
            "value": round(d, 4), "display": text(d),
            "percent": None if pct is None else round(pct, 2),
            "percent_display": None if pct is None or k in ("profit_pct", "roas") else f"{pct:+.2f}%",
            "direction": "up" if d > 1e-6 else "down" if d < -1e-6 else "unchanged",
            "range": _range(changes, text) if k != "spend" and len(changes) else None,
        }
    return out


def _weekly(per: Period, cur: Scored, new: Scored) -> list[dict[str, Any]]:
    """Week by week: baseline, revenue, profit and spend, current and best,
    each modelled figure with its P10 - P90. The last point is the carryover
    after the period."""
    labels = [(f"W{w.week:02d}", w.start, w.last - w.first + 1) for w in per.weeks] + [(f"+{CARRYOVER_TAIL}d", "", CARRYOVER_TAIL)]
    spend_now = [*cur.plan.sum(axis=0), 0.0]
    spend_plan = [*new.plan.sum(axis=0), 0.0]
    pct = lambda a: [round(float(x), 2) for x in np.percentile(a, [10, 90])]  # noqa: E731
    out = []
    for i, (label, start, days) in enumerate(labels):
        base = cur.weekly[i][0]
        rev_now = cur.weekly_draws[:, i].sum(axis=1)
        rev_plan = new.weekly_draws[:, i].sum(axis=1)
        out.append({
            "week": label, "start": start, "days": days, "after": i == len(labels) - 1,
            "baseline": round(float(base), 2), "baseline_range": pct(cur.weekly_draws[:, i, 0]),
            "spend_now": round(float(spend_now[i]), 2), "spend_plan": round(float(spend_plan[i]), 2),
            "revenue_now": round(float(base + cur.weekly[i][1]), 2), "revenue_now_range": pct(rev_now),
            "revenue_plan": round(float(base + new.weekly[i][1]), 2), "revenue_plan_range": pct(rev_plan),
            "profit_now": round(float(base + cur.weekly[i][1] - spend_now[i]), 2), "profit_now_range": pct(rev_now - spend_now[i]),
            "profit_plan": round(float(base + new.weekly[i][1] - spend_plan[i]), 2), "profit_plan_range": pct(rev_plan - spend_plan[i]),
        })
    return out


# --------------------------------------------------------------- the optimizer


def _gradient(per: Period, fit: Fit, plan: np.ndarray) -> np.ndarray:
    """d incremental revenue / d spend, per channel-week: what one more rupee
    in that cell returns, through carryover, over the whole window."""
    a = per.first - per.lo
    daily = _daily(per, plan)
    out = np.zeros_like(plan)
    for j, c in enumerate(fit.curves):
        slope = fit.beta[j] * hill_slope(adstock(daily[:, j], c.decay), c.kappa, c.alpha)
        slope[:a] = 0.0  # effects before the period are not the plan's
        # A rupee on day t works on every later day tau with weight decay^(tau - t).
        g = lfilter([1.0], [1.0, -c.decay], slope[::-1])[::-1] if c.decay else slope
        for wi, w in enumerate(per.weeks):
            out[j, wi] = float(per.shares[wi][:, j] @ g[w.first - per.lo:w.last - per.lo + 1])
    return out


def _project(x: np.ndarray, budget: float) -> np.ndarray:
    """Euclidean projection onto {x >= 0, sum(x) = budget}."""
    if budget <= 0:
        return np.zeros_like(x)
    v = x.ravel()
    u = np.sort(v)[::-1]
    css = np.cumsum(u) - budget
    rho = np.nonzero(u - css / np.arange(1, len(u) + 1) > 0)[0][-1]
    return np.maximum(v - css[rho] / (rho + 1), 0.0).reshape(x.shape)


def _project_mode(x: np.ndarray, current: np.ndarray, mode: str) -> np.ndarray:
    """Projection onto the plans `mode` allows: every channel keeps its total
    (within_channel), every week keeps its total (across_channels), or only
    the period's total is kept (anywhere)."""
    if mode == "within_channel":
        return np.vstack([_project(x[j], current[j].sum()) for j in range(len(x))])
    if mode == "across_channels":
        return np.column_stack([_project(x[:, w], current[:, w].sum()) for w in range(x.shape[1])])
    return _project(x, current.sum())


def optimize_plan(per: Period, mode: str = "anywhere", start: np.ndarray | None = None) -> np.ndarray:
    """The best plan the mode allows; `start` (already allowed) warm-starts it."""
    fit = per.model.central

    def objective(p: np.ndarray) -> float:
        return float(_lift(per, fit, p).sum())

    budget = per.budget
    if budget <= 0:
        return np.zeros_like(per.current)
    x = per.current.copy() if start is None else start.copy()
    fx = objective(x)
    step = budget / x.size  # rupees per unit of gradient (gradients are ~ROAS)
    for _ in range(MAX_ITER):
        g = _gradient(per, fit, x)
        improved = False
        while step > budget * 1e-9:
            y = _project_mode(x + step * g, per.current, mode)
            fy = objective(y)
            if fy >= fx + 1e-4 * float(g.ravel() @ (y - x).ravel()):  # Armijo
                improved = fy - fx > 1e-9 * max(abs(fx), 1.0)
                x, fx = y, fy
                step *= 1.5
                break
            step /= 2
        if not improved:
            break
    return x


def _moves(per: Period, plan: np.ndarray, currency: str, mode: str = "anywhere") -> list[dict[str, Any]]:
    """The plan as moves, matched the way the mode allows them: within a
    channel (to its other weeks), within a week (to other channels), and --
    anywhere only -- what is left across both. Largest first."""
    diff = plan - per.current
    eps = per.budget * 1e-4
    ch = per.model.channels
    cuts = {(j, w): -diff[j, w] for j in range(diff.shape[0]) for w in range(diff.shape[1]) if diff[j, w] < -eps}
    adds = {(j, w): diff[j, w] for j in range(diff.shape[0]) for w in range(diff.shape[1]) if diff[j, w] > eps}
    out: list[dict[str, Any]] = []

    def match(same) -> None:
        for (fj, fw), _ in sorted(cuts.items(), key=lambda kv: -kv[1]):
            for (tj, tw), _ in sorted(adds.items(), key=lambda kv: -kv[1]):
                if cuts.get((fj, fw), 0) <= eps:
                    break
                if adds.get((tj, tw), 0) <= eps or not same(fj, fw, tj, tw):
                    continue
                amount = min(cuts[(fj, fw)], adds[(tj, tw)])
                out.append({
                    "from_channel": ch[fj], "from_week": per.weeks[fw].key,
                    "to_channel": ch[tj], "to_week": per.weeks[tw].key,
                    "amount": round(float(amount), 2), "amount_display": F.money(float(amount), currency),
                    "kind": "week" if fj == tj else "channel" if fw == tw else "both",
                })
                cuts[(fj, fw)] -= amount
                adds[(tj, tw)] -= amount

    if mode in ("anywhere", "within_channel"):
        match(lambda fj, fw, tj, tw: fj == tj)   # within the channel: other weeks
    if mode in ("anywhere", "across_channels"):
        match(lambda fj, fw, tj, tw: fw == tw)   # within the week: other channels
    if mode == "anywhere":
        match(lambda fj, fw, tj, tw: True)       # what is left: both
    return sorted(out, key=lambda m: -m["amount"])


def _channels(per: Period, plan: np.ndarray, cur: Scored, new: Scored, moves: list[dict[str, Any]], currency: str) -> list[dict[str, Any]]:
    """Every channel the plan touches: what it gives and receives, by kind of
    move, its spend and extra revenue, and each week before and after
    (flagged past the channel's highest weekly spend ever)."""
    m = per.model
    peaks = peak_weeks(m)
    eps = per.budget * 1e-4
    rows = []
    for j, c in enumerate(m.channels):
        before, after = per.current[j], plan[j]
        if np.abs(after - before).max() <= eps:
            continue
        out_by = {k: sum(mv["amount"] for mv in moves if mv["from_channel"] == c and mv["kind"] == k) for k in ("week", "channel", "both")}
        in_by = {k: sum(mv["amount"] for mv in moves if mv["to_channel"] == c and mv["kind"] == k) for k in ("week", "channel", "both")}
        gives, receives = sum(out_by.values()), sum(in_by.values())
        net = float(after.sum() - before.sum())
        rows.append({
            "key": c, "label": channel_label(c), "net": round(net, 2),
            "gives_display": F.money(gives, currency), "receives_display": F.money(receives, currency),
            "net_display": _signed(net, currency) if abs(net) > eps else "±₹0",
            "kinds": sorted({k for k in out_by if out_by[k] > 0} | {k for k in in_by if in_by[k] > 0}),
            "spend_now_display": F.money(float(before.sum()), currency),
            "spend_plan_display": F.money(float(after.sum()), currency),
            "incremental_change_display": _signed(float(new.by_channel[j] - cur.by_channel[j]), currency),
            "weeks": [
                {"label": f"W{w.week:02d}", "now": round(float(before[wi]), 2), "plan": round(float(after[wi]), 2),
                 "changed": bool(abs(after[wi] - before[wi]) > eps), "deeper": bool(after[wi] > peaks[j] * 1.0001)}
                for wi, w in enumerate(per.weeks)
            ],
        })
    return sorted(rows, key=lambda r: -max(abs(r["net"]), sum(abs(wk["plan"] - wk["now"]) for wk in r["weeks"]) / 2))


def _curves(per: Period, plan: np.ndarray, currency: str) -> list[dict[str, Any]]:
    """Each channel's response over the period, with its P10 - P90: incremental
    revenue as its period spend grows from zero, spread over the weeks as it is
    today, and as the best plan spreads it (re-timing alone changes what the
    same total earns). Plus the numbers that say where the channel stands:
    spend, revenue, ROAS and what the next rupee returns, before and after."""
    m = per.model
    n_weeks = per.current.shape[1]
    fits = [m.central, *m.draws]
    g_now = _gradient(per, m.central, per.current)
    g_plan = _gradient(per, m.central, plan)
    out = []
    for j, c in enumerate(m.channels):
        now, best = float(per.current[j].sum()), float(plan[j].sum())
        mix_now = per.current[j] / now if now > 0 else np.full(n_weeks, 1.0 / n_weeks)
        mix_plan = plan[j] / best if best > 0 else mix_now
        top = 1.5 * max(now, best, per.budget / len(m.channels))
        levels = np.linspace(0.0, top, CURVE_POINTS)
        rows = np.vstack([np.outer(levels, mix_now), np.outer(levels, mix_plan), per.current[j], plan[j]])
        lifts = np.array([_channel_lift(per, f, j, rows) for f in fits])  # fits x rows
        central, draws = lifts[0], lifts[1:]
        k = CURVE_POINTS

        def series(lo: int) -> list[dict[str, float]]:
            return [{"spend": round(float(levels[i]), 2), "incremental": round(float(central[lo + i]), 2),
                     "p10": round(float(np.percentile(draws[:, lo + i], 10)), 2),
                     "p90": round(float(np.percentile(draws[:, lo + i], 90)), 2)} for i in range(k)]

        def point(spend: float, idx: int, grad: np.ndarray, mix: np.ndarray) -> dict[str, Any]:
            inc = float(central[idx])
            marginal = float(mix @ grad[j])
            return {
                "spend": round(spend, 2), "spend_display": F.money(spend, currency),
                "incremental": round(inc, 2), "incremental_display": F.money(inc, currency),
                "incremental_range": _range(draws[:, idx], lambda x: F.money(x, currency)),
                "roas": round(inc / spend, 4) if spend > 0 else None,
                "roas_display": F.multiple(inc / spend) if spend > 0 else "—",
                "marginal": round(marginal, 4), "marginal_display": f"₹{marginal:.2f}",
            }

        out.append({
            "key": c, "label": channel_label(c),
            "points": series(0), "plan_points": series(k),
            "current": point(now, 2 * k, g_now, mix_now),
            "plan": point(best, 2 * k + 1, g_plan, mix_plan),
        })
    return [_combined_curve(per, plan, fits, g_now, g_plan, currency), *out]


def _combined_curve(per: Period, plan: np.ndarray, fits: list[Fit], g_now: np.ndarray, g_plan: np.ndarray,
                    currency: str) -> dict[str, Any]:
    """All channels together: the period's total incremental revenue as the
    whole budget is scaled from zero, split as the current plan splits it and
    as the best plan does. Channels add, so it is the sum of their curves."""
    budget = per.budget
    factors = np.linspace(0.0, 1.5, CURVE_POINTS)
    k = CURVE_POINTS
    lifts = np.zeros((len(fits), 2 * k + 2))
    for j in range(len(per.model.channels)):
        rows = np.vstack([np.outer(factors, per.current[j]), np.outer(factors, plan[j]), per.current[j], plan[j]])
        lifts += np.array([_channel_lift(per, f, j, rows) for f in fits])
    central, draws = lifts[0], lifts[1:]

    def series(lo: int) -> list[dict[str, float]]:
        return [{"spend": round(float(factors[i] * budget), 2), "incremental": round(float(central[lo + i]), 2),
                 "p10": round(float(np.percentile(draws[:, lo + i], 10)), 2),
                 "p90": round(float(np.percentile(draws[:, lo + i], 90)), 2)} for i in range(k)]

    def point(idx: int, grad: np.ndarray, matrix: np.ndarray) -> dict[str, Any]:
        inc = float(central[idx])
        marginal = float((matrix * grad).sum() / budget) if budget else 0.0
        return {
            "spend": round(budget, 2), "spend_display": F.money(budget, currency),
            "incremental": round(inc, 2), "incremental_display": F.money(inc, currency),
            "incremental_range": _range(draws[:, idx], lambda x: F.money(x, currency)),
            "roas": round(inc / budget, 4) if budget else None,
            "roas_display": F.multiple(inc / budget) if budget else "—",
            "marginal": round(marginal, 4), "marginal_display": f"₹{marginal:.2f}",
        }

    return {
        "key": "__all__", "label": "All channels",
        "points": series(0), "plan_points": series(k),
        "current": point(2 * k, g_now, per.current), "plan": point(2 * k + 1, g_plan, plan),
    }


def model_card(m: Model) -> dict[str, Any]:
    c = m.checks
    return {k: c.get(k) for k in ("holdout_last_year", "media_share_pct", "bootstraps", "fit_seconds")}


# --------------------------------------------------------------- the endpoints


def summary(start: int, end: int, currency: str = "INR", source: str = "history") -> dict[str, Any]:
    """The current plan: its KPIs with their ranges."""
    currency = F.normalise_currency(currency)
    per = period(start, end, source)
    cur = score(per, per.current)
    return {
        "scope": {"start": per.weeks[0].key, "end": per.weeks[-1].key,
                  "weeks": [{"key": w.key, "label": f"W{w.week:02d} {w.year}", "start": w.start} for w in per.weeks],
                  "carryover_tail_days": CARRYOVER_TAIL},
        "channels": [{"key": c, "label": channel_label(c)} for c in per.model.channels],
        "current": {"budget": round(per.budget, 2), "budget_display": F.money(per.budget, currency)},
        "currency": currency,
        "exchange_rate": F.convert(1.0, currency),
        "figures": _figures_out(cur, currency),
        "model": model_card(per.model),
    }


def optimize(start: int, end: int, currency: str = "INR", mode: str = "anywhere", source: str = "history") -> dict[str, Any]:
    currency = F.normalise_currency(currency)
    if mode not in MODES:
        raise ValueError(f"Unknown mode: {mode}")
    per = period(start, end, source)
    plan = optimize_plan(per, mode)
    cur, new = score(per, per.current), score(per, plan)
    moves = _moves(per, plan, currency, mode)
    channels = _channels(per, plan, cur, new, moves, currency)
    moved = sum(mv["amount"] for mv in moves)
    deltas = _deltas(cur, new, currency)
    profit_change = np.array([n["profit"] - c["profit"] for n, c in zip(new.draws, cur.draws)])
    return {
        "mode": mode,
        "currency": currency,
        "exchange_rate": F.convert(1.0, currency),
        "matrix": np.round(plan, 2).tolist(),
        "figures": _figures_out(new, currency),
        "current_figures": _figures_out(cur, currency),
        "deltas": deltas,
        "chance_gain_pct": round(float((profit_change > 0).mean() * 100), 1),
        "draws": len(new.draws),
        "impact": {
            "kinds": {
                k: {"count": sum(1 for mv in moves if mv["kind"] == k),
                    "amount_display": F.money(sum(mv["amount"] for mv in moves if mv["kind"] == k), currency)}
                for k in ("week", "channel", "both")
            },
            "moved_display": F.money(moved, currency),
            "moved_share_pct": round(moved / per.budget * 100, 1) if per.budget else 0.0,
            "channels_touched": len(channels),
            "cells_changed": sum(wk["changed"] for r in channels for wk in r["weeks"]),
        },
        "moves": moves,
        "channels": channels,
        "weekly": _weekly(per, cur, new),
        "curves": _curves(per, plan, currency),
        "budget": {"value": round(per.budget, 2), "display": F.money(per.budget, currency)},
    }
