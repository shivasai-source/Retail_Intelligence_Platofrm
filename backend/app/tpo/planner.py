"""Promotion Planner -- what-if, profit targets and a re-planned calendar.

THE THREE QUESTIONS (TPO_Algorithm_Workflow.pdf, Q1-Q3, widened from one cell
to a whole selection):

  What-if     "If the promotions in this selection ran at a different
              discount, what happens to revenue, profit and ROI?"  One lever:
              the average discount. Every promotion moves by the same points;
              its weeks stay where they are.
  Target      "I want +X% profit. What has to change?"  Two answers: the
              discount change that gets there with the same weeks, and the
              FEWEST product-stores whose calendars must be re-planned. If X is
              out of reach, the most that is reachable (+Y%) and what blocks it.
  Best plan   "What earns the most profit?"  The best single discount, and the
              best calendar -- every product-store's promotions re-chosen
              (which offer, which weeks) inside the selected period.

THE SELECTION is a set of slots: product x store x business week, narrowed
by product, store, channel and region and bounded by a period. From the
Promotion Calendar it is one promotion's own slots: that offer, in that
channel, in that month.

HOW A CHANGE IS PRICED -- THE DELTA RULE. What the selection actually did is
measured, not modelled: current revenue, cost and profit are the fact rows'
own. A change is priced as the model's difference between the new option and
the current one on the same slot,

    new figure = measured figure + model(new option) - model(current option)

so "no change" reproduces the measured figures exactly, and a promotion that
happened to over- or under-perform is not credited with that luck when it is
kept or blamed for it when it is moved: both sides of every difference are
expectations. The model is app/tpo/planner_model.py.

PROFIT is the P&L's: revenue - Total_Cost - Promotion_Cost, less the margin a
promotion takes from its sister pack sizes (the Insights Hub's measured
cannibalization rate per brand). Trade Spend, Incremental Sales and ROI use
the Insights Hub's definitions (`aggregate`): Trade Spend = discount given +
Promotion_Cost; Incremental Sales = (units - expected units) x price paid;
ROI = Incremental Sales / Trade Spend via `aggregate.roi_multiple`.

THE RE-PLAN is exact, not a heuristic. Product-stores do not share a
constraint, so each one's calendar is optimised on its own by dynamic
programming over the periods of the selection:

  * a period is a business week, or a calendar month in a channel that books
    whole months (detected from the data: its promotions run 3+ weeks);
  * each period either runs nothing or ONE offer from the channel's own
    menu -- the regular offers it has run, plus the festival offer in a
    festival's own period (festival offers only ever ran at their festival,
    so they are never moved off it: the PDF's coverage rule);
  * consecutive promotions keep the channel's minimum gap, read from the data;
  * a product-store runs at most as many promotions as it does today, or --
    when "allow more promotions" is on -- up to the busiest share of periods
    any product-store in that channel has run;
  * only product-stores the data has seen promoted may be promoted.

With timing FIXED the same search keeps every promotion in its own period and
chooses only the offer (or drops it). "Fewest changes" for a target is then
exact too: each product-store's best calendar gains a known amount, so the
fewest product-stores that reach the target are the largest gains first.
"""

from __future__ import annotations

import math
from dataclasses import dataclass
from functools import lru_cache
from typing import Any, Iterable, Sequence

import numpy as np
from scipy.optimize import brentq

from app.tpo import aggregate as A
from app.tpo import formatting as F
from app.tpo.loader import MONTHS
from app.tpo.planner_model import Fitted, event_index_for, event_of, fitted

#: The what-if lever may run this many points past the deepest depth the data
#: shows -- a what-if, flagged on screen. Optimisation never leaves the data.
WHATIF_MARGIN_PCT = 5.0
#: Grid the discount curve and the uniform-discount search step along.
CURVE_STEP_PCT = 0.5
#: A gain smaller than this (in rupees) is "no change".
EPSILON = 1.0
#: Most changed product-stores returned in full; the totals cover them all.
MAX_CHANGES_LISTED = 300
_MONTH_ABBR = [m[:3] for m in MONTHS]


class EmptySelection(ValueError):
    """The selection holds no slots."""


class NothingPromoted(ValueError):
    """The selection runs no promotion, so there is no discount to move."""


# --- the selection -----------------------------------------------------------


@dataclass(frozen=True)
class PlanScope:
    products: frozenset[str] | None = None
    stores: frozenset[str] | None = None
    channels: frozenset[str] | None = None
    regions: frozenset[str] | None = None
    #: Inclusive (year, business week) bounds; None = the data's own edge.
    start: tuple[int, int] | None = None
    end: tuple[int, int] | None = None
    #: The Promotion Calendar's hand-off: only this offer's own slots.
    promotion: str | None = None

    @classmethod
    def build(cls, *, products: Iterable[str] | None = None, stores: Iterable[str] | None = None,
              channels: Iterable[str] | None = None, regions: Iterable[str] | None = None,
              start: Sequence[int] | None = None, end: Sequence[int] | None = None,
              promotion: str | None = None) -> "PlanScope":
        norm = lambda v: frozenset(x for x in v if x) or None if v else None  # noqa: E731
        pair = lambda v: (int(v[0]), int(v[1])) if v else None  # noqa: E731
        return cls(products=norm(products), stores=norm(stores), channels=norm(channels),
                   regions=norm(regions), start=pair(start), end=pair(end),
                   promotion=(promotion or None))


@dataclass
class Resolved:
    fit: Fitted
    scope: PlanScope
    cells: np.ndarray        # cell indices in the selection
    weeks: np.ndarray        # week indices, ascending, contiguous
    idx: np.ndarray          # slot indices in the selection
    promoted: np.ndarray     # bool per idx: currently promoted
    focus: bool              # a single promotion's own slots
    #: Lazily computed, kept with the cached selection: the measured slots and
    #: the model's view of today's promoted ones -- every curve point and
    #: every what-if re-reads both.
    meas_cache: "Econ | None" = None
    cur_promoted_cache: "Econ | None" = None
    plan_cache: "Plan | None" = None
    #: Today's promoted slots under every posterior draw (Monte Carlo).
    cur_mc_cache: "np.ndarray | None" = None


def _cell_mask(fit: Fitted, scope: PlanScope, *, skip: str | None = None) -> np.ndarray:
    store, slots = fit.store, fit.slots
    keep = np.ones(len(slots.cells), dtype=bool)
    for i, (p, s) in enumerate(slots.cells):
        product = store.products[p]
        st = store.stores[s]
        if skip != "product" and scope.products and product.product_id not in scope.products:
            keep[i] = False
        elif skip != "store" and scope.stores and st.store_id not in scope.stores:
            keep[i] = False
        elif skip != "channel" and scope.channels and st.channel_id not in scope.channels:
            keep[i] = False
        elif skip != "region" and scope.regions and st.region not in scope.regions:
            keep[i] = False
    return keep


def _week_range(fit: Fitted, scope: PlanScope) -> np.ndarray:
    weeks = fit.slots.weeks
    lo = 0 if scope.start is None else next((i for i, w in enumerate(weeks) if w >= scope.start), len(weeks))
    hi = len(weeks) - 1 if scope.end is None else max((i for i, w in enumerate(weeks) if w <= scope.end), default=-1)
    return np.arange(lo, hi + 1) if hi >= lo else np.zeros(0, dtype=np.int64)


@lru_cache(maxsize=32)
def resolve(scope: PlanScope) -> Resolved:
    fit = fitted()
    slots = fit.slots
    cells = np.flatnonzero(_cell_mask(fit, scope))
    weeks = _week_range(fit, scope)
    if not len(cells) or not len(weeks):
        raise EmptySelection("Nothing in this selection: no product-store trades in the chosen period.")
    grid = slots.slot_of[np.ix_(cells, weeks)].ravel()
    idx = grid[grid >= 0]
    focus = scope.promotion is not None
    if focus:
        code = _promo_code(fit, scope.promotion)
        idx = idx[slots.promo[idx] == code] if code is not None else idx[:0]
        if not len(idx):
            raise EmptySelection(f"{scope.promotion} did not run in this selection.")
        cells = np.unique(slots.cell[idx])
    if not len(idx):
        raise EmptySelection("Nothing in this selection: no product-store trades in the chosen period.")
    return Resolved(fit=fit, scope=scope, cells=cells, weeks=weeks, idx=idx,
                    promoted=slots.promoted[idx], focus=focus)


def _promo_code(fit: Fitted, promotion_id: str) -> int | None:
    for i, p in enumerate(fit.store.promotions):
        if p.promotion_id == promotion_id:
            return i
    return None


# --- options for the selection bar ---------------------------------------------


def options(scope: PlanScope) -> dict[str, Any]:
    """Every choice the bar offers, each list narrowed by the OTHER three
    selections -- so an option is offered only if picking it leaves something
    to plan, and the current picks stay in their own list."""
    fit = fitted()
    store, slots = fit.store, fit.slots

    def cells_without(dim: str) -> np.ndarray:
        return np.flatnonzero(_cell_mask(fit, scope, skip=dim))

    products: dict[str, dict[str, str]] = {}
    for c in cells_without("product"):
        p = store.products[slots.cells[c][0]]
        products[p.product_id] = {"code": p.product_id, "name": p.name.strip() or p.product_id,
                                  "group": p.brand}
    stores: dict[str, dict[str, str]] = {}
    for c in cells_without("store"):
        s = store.stores[slots.cells[c][1]]
        where = ", ".join(x for x in (s.retailer or s.distributor, s.city) if x)
        stores[s.store_id] = {"code": s.store_id, "name": f"{s.store_id} · {where}" if where else s.store_id,
                              "group": store.dims.channels[s.channel_id].name if s.channel_id in store.dims.channels else s.channel_id}
    channels: dict[str, dict[str, str]] = {}
    for c in cells_without("channel"):
        cid = store.stores[slots.cells[c][1]].channel_id
        name = store.dims.channels[cid].name if cid in store.dims.channels else cid
        channels[cid] = {"code": cid, "name": name}
    regions = sorted({store.stores[slots.cells[c][1]].region for c in cells_without("region")} - {""})

    years: dict[int, list[dict[str, Any]]] = {}
    for i, (y, w) in enumerate(slots.weeks):
        years.setdefault(y, []).append({
            "week": w, "start": slots.week_start[i], "month": int(slots.week_month[i]),
        })
    return {
        "products": sorted(products.values(), key=lambda o: (o["group"], o["name"])),
        "stores": sorted(stores.values(), key=lambda o: o["code"]),
        "channels": sorted(channels.values(), key=lambda o: o["code"]),
        "regions": [{"code": r, "name": r} for r in regions],
        "calendar": [{"year": y, "weeks": ws} for y, ws in sorted(years.items())],
        "default_period": _default_period(fit),
    }


def month_bounds(year: int, month: int) -> tuple[tuple[int, int], tuple[int, int]] | None:
    """The first and last business week of an analytical month -- the month
    a week belongs to by its first day, the Promotion Calendar's rule."""
    s = fitted().slots
    mine = [w for i, w in enumerate(s.weeks) if w[0] == year and int(s.week_month[i]) == month]
    return (mine[0], mine[-1]) if mine else None


def _default_period(fit: Fitted) -> dict[str, list[int]]:
    """The latest year the data holds, as far as it goes."""
    weeks = fit.slots.weeks
    last = weeks[-1][0]
    mine = [w for w in weeks if w[0] == last]
    return {"start": list(mine[0]), "end": list(mine[-1])}


# --- the economics of one slot under one option -------------------------------


@dataclass
class Econ:
    units: np.ndarray
    revenue: np.ndarray
    cogs: np.ndarray
    promo_cost: np.ndarray
    discount: np.ndarray
    inc_units: np.ndarray
    inc_sales: np.ndarray
    cannibalized: np.ndarray   # sister-pack margin lost
    profit: np.ndarray
    promoted: np.ndarray

    def total(self) -> dict[str, float]:
        return {k: float(getattr(self, k).sum()) for k in
                ("units", "revenue", "cogs", "promo_cost", "discount", "inc_units",
                 "inc_sales", "cannibalized", "profit")} | {"promoted": float(self.promoted.sum())}


def _canni_rate(fit: Fitted, idx: np.ndarray) -> np.ndarray:
    table = fit.__dict__.get("_canni_table")
    if table is None:
        table = np.array([fit.cannibalization.get(b, 0.0) for b in fit.model.cell_brand])
        fit.__dict__["_canni_table"] = table
    return table[fit.slots.cell[idx]]


def econ(fit: Fitted, idx: np.ndarray, depth: np.ndarray, event: np.ndarray) -> Econ:
    """The model's expectation of every slot in `idx` under one option each
    (a depth and the offer's festival, -1 for a regular offer); depth 0 is
    "no promotion". The lift is B's posterior mean."""
    s, m = fit.slots, fit.model
    b = s.base[idx]
    price = s.price[idx]
    uc = s.unit_cost[s.cell[idx]]
    promoted = depth > 0
    u = np.zeros(len(idx))
    if promoted.any():
        u[promoted] = m.lift(s.cell[idx][promoted], depth[promoted], np.asarray(event)[promoted])
    units = b * (1 + u)
    paid = price * (1 - depth)
    revenue = units * paid
    cogs = units * uc
    promo_cost = np.where(promoted, fit.promo_cost_rate * units * price, 0.0)
    discount = units * price * depth
    inc_units = np.where(promoted, units - b, 0.0)
    inc_sales = inc_units * paid
    cannibalized = _canni_rate(fit, idx) * inc_units * np.maximum(price - uc, 0.0)
    profit = revenue - cogs - promo_cost - cannibalized
    return Econ(units, revenue, cogs, promo_cost, discount, inc_units, inc_sales, cannibalized, profit, promoted)


def _measured(fit: Fitted, idx: np.ndarray) -> Econ:
    """What the slots actually did. Incremental units are against the
    file's expected units, the Insights Hub's counterfactual."""
    s = fit.slots
    promoted = s.promoted[idx]
    units = s.units[idx]
    revenue = units * s.sell_price[idx]
    cogs = s.cost[idx]
    promo_cost = s.promo_cost[idx]
    discount = units * (s.price[idx] - s.sell_price[idx])
    inc_units = np.where(promoted, units - s.base[idx], 0.0)
    inc_sales = inc_units * s.sell_price[idx]
    zero = np.zeros(len(idx))
    profit = revenue - cogs - promo_cost
    return Econ(units, revenue, cogs, promo_cost, discount, inc_units, inc_sales, zero, profit, promoted)


def _current_option(fit: Fitted, idx: np.ndarray) -> tuple[np.ndarray, np.ndarray]:
    """Today's option on each slot: its depth (0 when not promoted) and festival."""
    s = fit.slots
    return np.where(s.promoted[idx], s.depth[idx], 0.0), event_index_for(fit.model, s.promo[idx])


def _current_model(fit: Fitted, idx: np.ndarray) -> Econ:
    depth, event = _current_option(fit, idx)
    return econ(fit, idx, depth, event)


@dataclass
class Plan:
    """Totals of a plan over the selection."""

    units: float
    revenue: float
    cogs: float
    promo_cost: float
    discount: float
    inc_units: float
    inc_sales: float
    cannibalized: float
    profit: float
    promotions: int          # promotion runs
    promoted_slots: int
    avg_discount_pct: float | None
    #: What the promotions add over not running them: the promoted slots'
    #: profit less the same slots at their expected units and list price, less
    #: the margin taken from sister packs -- the Insights Hub's Net Incremental
    #: Profit. The base a promotion target is normally set on.
    promo_profit: float = 0.0
    #: The CP profit % is measured on. A scenario is measured on the CURRENT
    #: plan's cost -- "CP 100, SP 105 -> 110" -- so more profit always reads
    #: as a higher profit %, never as a lower one because the plan sold more
    #: units at a higher total cost. None: the plan's own cost (the current plan).
    cp_base: float | None = None

    @property
    def trade_spend(self) -> float:
        return self.discount + self.promo_cost

    @property
    def roi(self) -> float | None:
        return A.roi_multiple(self.inc_sales, self.trade_spend, precision=None) if self.trade_spend > 0 else None

    @property
    def cost(self) -> float:
        """CP: product cost + promotion cost. The discount is not here -- it
        already lowered revenue (SP), so counting it again would count it twice."""
        return self.cogs + self.promo_cost

    @property
    def profit_pct(self) -> float | None:
        """Profit % = (SP - CP) / CP x 100, CP being the current plan's."""
        base = self.cp_base if self.cp_base is not None else self.cost
        return self.profit / base * 100 if base else None

    @property
    def margin_pct(self) -> float | None:
        return (self.revenue - self.cogs) / self.revenue * 100 if self.revenue else None


def _plan(totals: dict[str, float], promotions: int, list_value: float) -> Plan:
    return Plan(
        units=totals["units"], revenue=totals["revenue"], cogs=totals["cogs"],
        promo_cost=totals["promo_cost"], discount=totals["discount"], inc_units=totals["inc_units"],
        inc_sales=totals["inc_sales"], cannibalized=totals["cannibalized"], profit=totals["profit"],
        promotions=promotions, promoted_slots=int(totals["promoted"]),
        avg_discount_pct=(totals["discount_promoted"] / list_value * 100) if list_value > 0 else None,
    )


def _runs(fit: Fitted, idx: np.ndarray, promoted: np.ndarray, promo: np.ndarray) -> int:
    """Promotion runs: consecutive weeks of one offer in one product-store."""
    s = fit.slots
    if not promoted.any():
        return 0
    sel = idx[promoted]
    order = np.lexsort((s.widx[sel], s.cell[sel]))
    c, w, p = s.cell[sel][order], s.widx[sel][order], promo[promoted][order]
    new = np.ones(len(sel), dtype=bool)
    new[1:] = (c[1:] != c[:-1]) | (w[1:] != w[:-1] + 1) | (p[1:] != p[:-1])
    return int(new.sum())


def _meas(r: Resolved) -> Econ:
    if r.meas_cache is None:
        r.meas_cache = _measured(r.fit, r.idx)
    return r.meas_cache


def _cur_promoted(r: Resolved) -> Econ:
    if r.cur_promoted_cache is None:
        r.cur_promoted_cache = _current_model(r.fit, r.idx[r.promoted])
    return r.cur_promoted_cache


def current_plan(r: Resolved) -> Plan:
    if r.plan_cache is not None:
        return r.plan_cache
    fit, idx = r.fit, r.idx
    s = fit.slots
    meas = _meas(r)
    t = meas.total()
    p = r.promoted
    t["discount_promoted"] = float(meas.discount[p].sum())
    list_value = float((meas.units[p] * s.price[idx][p]).sum())
    plan = _plan(t, _runs(fit, idx, p, s.promo[idx]), list_value)
    pi = idx[p]
    unit_margin = np.maximum(s.price[pi] - s.unit_cost[s.cell[pi]], 0.0)
    without = s.base[pi] * (s.price[pi] - s.unit_cost[s.cell[pi]])
    sister = _canni_rate(fit, pi) * meas.inc_units[p] * unit_margin
    plan.promo_profit = float((meas.profit[p] - without - sister).sum())
    r.plan_cache = plan
    return plan


def _changed_plan(r: Resolved, changed: np.ndarray, new: Econ, new_promo: np.ndarray,
                  cur: Econ | None = None) -> Plan:
    """The measured plan with `changed` slots (positions into r.idx) re-priced
    by the delta rule. `new` and `new_promo` are aligned with `changed`;
    `cur` is the model's view of those slots today, when the caller has it."""
    fit, idx = r.fit, r.idx
    meas = _meas(r)
    t = meas.total()
    if cur is None:
        cur = _current_model(fit, idx[changed])
    for k in ("units", "revenue", "cogs", "promo_cost", "discount", "inc_units", "inc_sales", "cannibalized", "profit"):
        t[k] += float(getattr(new, k).sum() - getattr(cur, k).sum())
    promoted = r.promoted.copy()
    promoted[changed] = new.promoted
    t["promoted"] = float(promoted.sum())
    # The average discount of the new plan: discount given / list value, over
    # its promoted slots -- delta-adjusted where they changed.
    disc = meas.discount.copy()
    listv = meas.units * fit.slots.price[idx]
    disc[changed] += new.discount - cur.discount
    listv[changed] += (new.units - cur.units) * fit.slots.price[idx[changed]]
    t["discount_promoted"] = float(disc[promoted].sum())
    promo = fit.slots.promo[idx].copy()
    promo[changed] = new_promo
    plan = _plan(t, _runs(fit, idx, promoted, promo), float(listv[promoted].sum()))
    # Every change is a promotion change, so promotion profit moves by exactly
    # what total profit moves by.
    plan.promo_profit = current_plan(r).promo_profit + (plan.profit - float(meas.profit.sum()))
    plan.cp_base = current_plan(r).cost
    return plan


# --- Step 4: Monte Carlo over B's posterior draws ---------------------------------
#
# Every figure is linear in the lift: a slot under one option sells
# base x (1 + u), and its revenue, costs, discount and profit follow. So a
# metric over many slots is  sum(a) + sum(c x u)  with per-slot constants a
# and c, and the slots that share a (group, depth, festival) share u. Under
# each of B's ~1,000 posterior draws the plan's totals are one small matrix
# product -- parameter uncertainty. Noise is added on top for the slots whose
# offer changes: each product x channel x week (the grain B was fitted at)
# draws its own error, which sums to one normal term per draw. A plan is
# priced by the delta rule draw by draw:
#
#     plan_k = measured + model_k(new) - model_k(current) + noise_k
#
# so the current plan has no spread at all -- it happened.

MC_METRICS = ("units", "revenue", "cogs", "promo_cost", "discount", "inc_units", "inc_sales", "cannibalized", "profit")
_M = {k: i for i, k in enumerate(MC_METRICS)}
#: The Monte Carlo's own noise draws are seeded: the same plan reads the same
#: range on every request.
MC_SEED = 4242


def _terms(fit: Fitted, idx: np.ndarray, depth: np.ndarray) -> tuple[np.ndarray, np.ndarray]:
    """Per slot, each metric as a + c x u (columns in MC_METRICS order)."""
    s = fit.slots
    b = s.base[idx]
    price = s.price[idx]
    uc = s.unit_cost[s.cell[idx]]
    prom = (depth > 0).astype(float)
    paid = price * (1 - depth)
    rate = fit.promo_cost_rate
    margin = np.maximum(price - uc, 0.0)
    canni = _canni_rate(fit, idx)
    unit_profit = paid - uc - prom * rate * price
    zero = np.zeros(len(idx))
    a = np.column_stack([b, b * paid, b * uc, prom * rate * b * price, b * price * depth,
                         zero, zero, zero, b * unit_profit])
    c = np.column_stack([b, b * paid, b * uc, prom * rate * b * price, b * price * depth,
                         prom * b, prom * b * paid, canni * prom * b * margin,
                         b * unit_profit - canni * prom * b * margin])
    return a, c


def _mc_option(fit: Fitted, idx: np.ndarray, depth: np.ndarray, event: np.ndarray) -> tuple[np.ndarray, np.ndarray, np.ndarray]:
    """Totals of `idx` under one option each, per posterior draw (draws x
    metrics); with each slot's c terms and posterior-mean lift, which the
    noise term reuses."""
    m = fit.model
    a, c = _terms(fit, idx, depth)
    out = np.tile(a.sum(axis=0), (m.draws, 1))
    u_mean = np.zeros(len(idx))
    prom = depth > 0
    if prom.any():
        u, inv = m.lift_draws(fit.slots.cell[idx[prom]], depth[prom], np.asarray(event)[prom])
        cp = c[prom]
        weights = np.column_stack([np.bincount(inv, weights=cp[:, j], minlength=u.shape[1])
                                   for j in range(len(MC_METRICS))])
        out += u @ weights
        u_mean[prom] = u.mean(axis=0, dtype=np.float64)[inv]
    return out, c, u_mean


def _noise_sd(fit: Fitted, idx: np.ndarray, depth: np.ndarray, c_all: np.ndarray, u_mean: np.ndarray) -> np.ndarray:
    """The spread one realisation adds to each metric's total: B's error,
    drawn once per product x channel x week. Signed so the metrics move
    together the way the units do."""
    s, m = fit.slots, fit.model
    prom = depth > 0
    if not prom.any():
        return np.zeros(len(MC_METRICS))
    pi = idx[prom]
    c = c_all[prom]
    onepu = 1.0 + u_mean[prom]
    products = np.array([p for p, _ in s.cells], dtype=np.int64)
    key = (products[s.cell[pi]] * len(s.channels) + s.cell_channel[s.cell[pi]]) * len(s.weeks) + s.widx[pi]
    _, inv = np.unique(key, return_inverse=True)
    n_g = np.bincount(inv).astype(float)
    sig2 = float(np.median(m.post.sigma)) ** 2
    var_g = np.expm1(sig2 / (n_g / m.mean_row_slots))
    S = np.column_stack([np.bincount(inv, weights=c[:, j] * onepu, minlength=len(n_g))
                         for j in range(len(MC_METRICS))])
    sd = np.sqrt((S ** 2 * var_g[:, None]).sum(axis=0))
    sign = np.sign((S * S[:, [0]] * var_g[:, None]).sum(axis=0))
    return sd * np.where(sign == 0, 1.0, sign)


def _z(n: int) -> np.ndarray:
    return np.random.default_rng(MC_SEED).standard_normal(n)


def _cur_mc(r: Resolved) -> np.ndarray:
    """Today's promoted slots under every draw (cached with the selection)."""
    if r.cur_mc_cache is None:
        pi = r.idx[r.promoted]
        depth, event = _current_option(r.fit, pi)
        r.cur_mc_cache = _mc_option(r.fit, pi, depth, event)[0]
    return r.cur_mc_cache


def _plan_draws(r: Resolved, changed: np.ndarray, depth: np.ndarray, event: np.ndarray,
                all_promoted: bool = False) -> np.ndarray:
    """A changed plan's totals under every draw (draws x metrics): measured,
    plus each draw's view of the new options less its view of today's.
    `all_promoted`: `changed` is every promoted slot of the selection (the
    what-if), so today's side is the cached one."""
    fit = r.fit
    meas = _meas(r).total()
    base = np.array([meas[k] for k in MC_METRICS])
    idx = r.idx[changed]
    new, c, u_mean = _mc_option(fit, idx, depth, event)
    if all_promoted:
        cur = _cur_mc(r)
    else:
        cd, ce = _current_option(fit, idx)
        cur = _mc_option(fit, idx, cd, ce)[0]
    noise = _z(fit.model.draws)[:, None] * _noise_sd(fit, idx, depth, c, u_mean)[None, :]
    return base[None, :] + new - cur + noise


def _trio(values: np.ndarray, fmt) -> dict[str, Any]:
    p10, p50, p90 = (float(v) for v in np.quantile(values, [0.1, 0.5, 0.9]))
    return {"p10": fmt(p10), "p50": fmt(p50), "p90": fmt(p90),
            "display": f"{fmt(p10)['display']} – {fmt(p90)['display']}"}


def _band(cur: Plan, draws: np.ndarray, currency: str, needed: float | None = None) -> dict[str, Any]:
    """P10 / P50 / P90 of the plan's figures over the draws, and the chance
    it beats the current plan (or reaches a target)."""
    profit = draws[:, _M["profit"]]
    revenue = draws[:, _M["revenue"]]
    inc_sales = draws[:, _M["inc_sales"]]
    spend = draws[:, _M["discount"]] + draws[:, _M["promo_cost"]]
    with np.errstate(divide="ignore", invalid="ignore"):
        roi = np.where(spend > 0, inc_sales / spend, np.nan)
    cp = cur.cost
    gain = profit - cur.profit

    def money(v: float) -> dict[str, Any]:
        return _money(v, currency)

    def signed(v: float) -> dict[str, Any]:
        return {"value": round(v, 2), "display": ("+" if v > 0.005 else "") + F.money(v, currency)}

    def pct(v: float) -> dict[str, Any]:
        return {"value": round(v, 2), "display": F.percent(v)}

    def pts(v: float) -> dict[str, Any]:
        return {"value": round(v, 2), "display": f"{v:+.2f} pts"}

    def multiple(v: float) -> dict[str, Any]:
        return {"value": round(v, 2), "display": F.multiple(v)}

    out: dict[str, Any] = {
        "draws": int(len(profit)),
        "profit": _trio(profit, money),
        "revenue": _trio(revenue, money),
        "incremental_sales": _trio(inc_sales, money),
        "trade_spend": _trio(spend, money),
        "roi": _trio(roi[np.isfinite(roi)], multiple) if np.isfinite(roi).any() else None,
        "profit_pct": _trio(profit / cp * 100, pct) if cp else None,
        "profit_change": _trio(gain, signed),
        "profit_pct_change": _trio(gain / cp * 100, pts) if cp else None,
        "chance_gain_pct": round(float((gain > 0.5).mean() * 100), 2),
    }
    if needed is not None:
        out["chance_reach_pct"] = round(float((gain >= needed - 1e-6).mean() * 100), 2)
    return out


# --- payload helpers ---------------------------------------------------------


def _money(v: float | None, currency: str) -> dict[str, Any]:
    return {"value": None if v is None else round(v, 2), "display": F.money(v, currency)}


def _figures(p: Plan, currency: str) -> dict[str, Any]:
    return {
        "revenue": _money(p.revenue, currency),
        "profit": _money(p.profit, currency),
        "promotion_profit": _money(p.promo_profit, currency),
        "cost": _money(p.cost, currency),
        "profit_pct": {"value": None if p.profit_pct is None else round(p.profit_pct, 2), "display": F.percent(p.profit_pct)},
        "trade_spend": _money(p.trade_spend, currency),
        "incremental_sales": _money(p.inc_sales, currency),
        "units": {"value": round(p.units, 2), "display": F.quantity(p.units)},
        "incremental_units": {"value": round(p.inc_units, 2), "display": F.quantity(p.inc_units)},
        "roi": {"value": None if p.roi is None else round(p.roi, 2), "display": F.multiple(p.roi)},
        "margin_pct": {"value": None if p.margin_pct is None else round(p.margin_pct, 2), "display": F.percent(p.margin_pct)},
        "promotions": {"value": p.promotions, "display": F.quantity(p.promotions)},
        "avg_discount": {"value": None if p.avg_discount_pct is None else round(p.avg_discount_pct, 2),
                         "display": F.percent(p.avg_discount_pct)},
    }


def _direction(delta: float, tol: float) -> str:
    return "unchanged" if abs(delta) <= tol else ("up" if delta > 0 else "down")


def _deltas(cur: Plan, new: Plan, currency: str) -> dict[str, Any]:
    def money(a: float, b: float) -> dict[str, Any]:
        d = b - a
        pct = d / abs(a) * 100 if a else None
        return {"absolute": {"value": round(d, 2), "display": ("+" if d > 0.005 else "") + F.money(d, currency)},
                "percent": None if pct is None else round(pct, 2),
                "percent_display": "—" if pct is None else F.percent(pct, signed=True),
                "direction": _direction(d, 0.5)}

    def plain(a: float | None, b: float | None, fmt, tol: float) -> dict[str, Any]:
        if a is None or b is None:
            return {"absolute": None, "absolute_display": "—", "direction": "unchanged"}
        d = b - a
        return {"absolute": round(d, 2), "absolute_display": fmt(d), "direction": _direction(d, tol)}

    return {
        "revenue": money(cur.revenue, new.revenue),
        "profit": money(cur.profit, new.profit),
        "promotion_profit": money(cur.promo_profit, new.promo_profit),
        "trade_spend": money(cur.trade_spend, new.trade_spend),
        "incremental_sales": money(cur.inc_sales, new.inc_sales),
        "units": plain(cur.units, new.units, lambda d: F.quantity(d, signed=True), 0.5),
        "incremental_units": plain(cur.inc_units, new.inc_units, lambda d: F.quantity(d, signed=True), 0.5),
        "roi": plain(cur.roi, new.roi, lambda d: F.multiple(d, signed=True), 0.005),
        "margin_pct": plain(cur.margin_pct, new.margin_pct, lambda d: f"{d:+.2f} pts", 0.005),
        "profit_pct": plain(cur.profit_pct, new.profit_pct, lambda d: f"{d:+.2f} pts", 0.005),
        "cost": money(cur.cost, new.cost),
        "promotions": plain(float(cur.promotions), float(new.promotions), lambda d: F.quantity(d, signed=True), 0.5),
        "avg_discount": plain(cur.avg_discount_pct, new.avg_discount_pct, lambda d: f"{d:+.2f} pts", 0.005),
        "sister_pack_margin": _money(-(new.cannibalized - cur.cannibalized), currency),
    }


def _period_text(fit: Fitted, weeks: np.ndarray) -> str:
    s = fit.slots
    a, b = s.weeks[weeks[0]], s.weeks[weeks[-1]]
    return f"{a[0]}-W{a[1]:02d} to {b[0]}-W{b[1]:02d}" if a != b else f"{a[0]}-W{a[1]:02d}"


def _scope_block(r: Resolved) -> dict[str, Any]:
    fit = r.fit
    s, store = fit.slots, fit.store
    cells = r.cells
    products = {s.cells[c][0] for c in cells}
    stores = {s.cells[c][1] for c in cells}
    channels = {store.stores[s.cells[c][1]].channel_id for c in cells}
    first, last = s.weeks[r.weeks[0]], s.weeks[r.weeks[-1]]
    block: dict[str, Any] = {
        "period": _period_text(fit, r.weeks),
        "start": list(first), "end": list(last),
        "start_date": s.week_start[r.weeks[0]], "end_date": s.week_start[r.weeks[-1]],
        "weeks": int(len(r.weeks)),
        "products": len(products), "stores": len(stores), "channels": sorted(channels),
        "product_stores": int(len(cells)), "slots": int(len(r.idx)),
        "promoted_slots": int(r.promoted.sum()),
    }
    if r.focus:
        code = _promo_code(fit, r.scope.promotion)  # type: ignore[arg-type]
        promo = store.promotions[code] if code is not None else None
        block["promotion"] = {
            "id": r.scope.promotion, "name": promo.label if promo else r.scope.promotion,
            "type": promo.type if promo else "", "mechanic": promo.name if promo else "",
        }
    return block


# --- the what-if lever ---------------------------------------------------------


def _avg_depth(fit: Fitted, idx: np.ndarray) -> float:
    s = fit.slots
    list_value = (s.units[idx] * s.price[idx]).sum()
    return float((s.units[idx] * (s.price[idx] - s.sell_price[idx])).sum() / list_value * 100) if list_value > 0 else 0.0


@dataclass
class Shift:
    """Every promoted slot at a new depth: where they sit in the selection,
    their new economics, offers and depths, and today's economics."""

    pos: np.ndarray
    new: Econ
    promo: np.ndarray
    was: Econ
    depth: np.ndarray
    event: np.ndarray


def _shifted(r: Resolved, target_pct: float, cap_pct: float) -> Shift:
    """Every promoted slot moved by the same points so the plan's average
    discount reads `target_pct`; each clipped to 0..cap."""
    fit = r.fit
    s = fit.slots
    pos = np.flatnonzero(r.promoted)
    idx = r.idx[pos]
    shift_pts = target_pct - round(_avg_depth(fit, idx), 2)
    depth = np.clip(s.depth[idx] + shift_pts / 100.0, 0.0, cap_pct / 100.0)
    event = event_index_for(fit.model, s.promo[idx])
    new = econ(fit, idx, depth, event)
    promo = np.where(depth > 0, s.promo[idx], _no_promo_code(fit))
    return Shift(pos, new, promo, _cur_promoted(r), depth, event)


def _plan_at(r: Resolved, discount_pct: float, cap_pct: float) -> Plan:
    sh = _shifted(r, discount_pct, cap_pct)
    return _changed_plan(r, sh.pos, sh.new, sh.promo, sh.was)


def _no_promo_code(fit: Fitted) -> int:
    for i, p in enumerate(fit.store.promotions):
        if not p.is_promotional:
            return i
    return -1


def _lever(fit: Fitted, r: Resolved) -> dict[str, Any]:
    current = _avg_depth(fit, r.idx[r.promoted])
    evidence = fit.model.depth_max * 100
    top = math.floor((evidence + WHATIF_MARGIN_PCT) / CURVE_STEP_PCT) * CURVE_STEP_PCT
    return {"min": 0.0, "max": round(top, 2), "step": 0.05, "default": round(current, 2),
            "evidence_max": round(evidence, 2), "unit": "percent"}


def whatif(scope: PlanScope, discount_pct: float, currency: str = "INR") -> dict[str, Any]:
    r = resolve(scope)
    fit = r.fit
    if not r.promoted.any():
        raise NothingPromoted("No promotion runs in this selection, so there is no discount to move. "
                              "Widen the period or use Best plan to add promotions.")
    lever = _lever(fit, r)
    target = float(np.clip(discount_pct, 0.0, lever["max"]))
    cur = current_plan(r)
    band = None
    if abs(target - lever["default"]) < 0.005:
        # Today's discount is today's plan, to the rupee -- and it happened,
        # so it has no range.
        target, plan = lever["default"], cur
        empty = np.zeros(0, dtype=np.int64)
        weekly = _weekly(r, empty, econ(r.fit, empty, np.zeros(0), empty), empty, currency)
    else:
        sh = _shifted(r, target, lever["max"])
        plan = _changed_plan(r, sh.pos, sh.new, sh.promo, sh.was)
        band = _band(cur, _plan_draws(r, sh.pos, sh.depth, sh.event, all_promoted=True), currency)
        weekly = _weekly(r, sh.pos, sh.new, sh.promo, currency, sh.depth, sh.event)
    clipped = bool((fit.slots.depth[r.idx[r.promoted]] * 100 + (target - lever["default"]) < 0).any())
    return {
        "currency": F.normalise_currency(currency),
        "exchange_rate": F.convert(1.0, F.normalise_currency(currency)),
        "discount_pct": round(target, 2),
        "shift_pts": round(target - lever["default"], 2),
        "shift_relative_pct": round((target - lever["default"]) / lever["default"] * 100, 2) if lever["default"] else None,
        "beyond_evidence": target > lever["evidence_max"] + 1e-9,
        "clipped_at_zero": clipped,
        "current": _figures(cur, currency),
        "scenario": _figures(plan, currency),
        "deltas": _deltas(cur, plan, currency),
        "band": band,
        "weekly": weekly,
    }


@dataclass
class CurvePoint:
    """One depth of the PDF's scan: the plan at its posterior mean, and its
    profit and revenue under every posterior draw."""

    d: float
    plan: Plan
    profit: np.ndarray
    revenue: np.ndarray


def _curve_points(r: Resolved, cap: float) -> list[CurvePoint]:
    """Step 5's scan: every depth from 0% in 0.5-point steps, across all draws."""
    grid = np.round(np.arange(0.0, cap + 1e-9, CURVE_STEP_PCT), 2)
    out = []
    for g in grid:
        sh = _shifted(r, float(g), cap)
        plan = _changed_plan(r, sh.pos, sh.new, sh.promo, sh.was)
        draws = _plan_draws(r, sh.pos, sh.depth, sh.event, all_promoted=True)
        out.append(CurvePoint(float(g), plan, draws[:, _M["profit"]].copy(), draws[:, _M["revenue"]].copy()))
    return out


@lru_cache(maxsize=32)
def _curve_cached(scope: PlanScope) -> tuple[float, list[CurvePoint]]:
    r = resolve(scope)
    lever = _lever(r.fit, r)
    return lever["max"], _curve_points(r, lever["max"])


def curve(scope: PlanScope, currency: str = "INR") -> dict[str, Any]:
    r = resolve(scope)
    if not r.promoted.any():
        raise NothingPromoted("No promotion runs in this selection.")
    lever = _lever(r.fit, r)
    _, points = _curve_cached(scope)
    cur = current_plan(r)
    best = _best_uniform(r, points, lever)
    money = lambda v: _money(v, currency)  # noqa: E731
    return {
        "currency": F.normalise_currency(currency),
        "exchange_rate": F.convert(1.0, F.normalise_currency(currency)),
        "current_discount_pct": lever["default"],
        "evidence_max": lever["evidence_max"],
        "points": [
            {"discount_pct": pt.d, "revenue": _money(pt.plan.revenue, currency), "profit": _money(pt.plan.profit, currency),
             "promotion_profit": _money(pt.plan.promo_profit, currency),
             "roi": {"value": None if pt.plan.roi is None else round(pt.plan.roi, 2), "display": F.multiple(pt.plan.roi)},
             "profit_range": _trio(pt.profit, money), "revenue_range": _trio(pt.revenue, money),
             "beyond_evidence": pt.d > lever["evidence_max"] + 1e-9}
            for pt in points
        ],
        "current": {"profit": _money(cur.profit, currency), "promotion_profit": _money(cur.promo_profit, currency),
                    "revenue": _money(cur.revenue, currency),
                    "roi": {"value": None if cur.roi is None else round(cur.roi, 2), "display": F.multiple(cur.roi)}},
        "best": best and {"discount_pct": best.d, "profit": _money(best.plan.profit, currency),
                          "promotion_profit": _money(best.plan.promo_profit, currency),
                          "profit_median": _money(float(np.median(best.profit)), currency),
                          "profit_range": _trio(best.profit, money)},
    }


def _inside(points: list[CurvePoint], lever: dict[str, Any]) -> list[CurvePoint]:
    """The scan never goes past the deepest depth the data shows."""
    return [pt for pt in points if pt.d <= lever["evidence_max"] + 1e-9]


def _best_uniform(r: Resolved, points: list[CurvePoint], lever: dict[str, Any]) -> CurvePoint | None:
    """Q2: the depth with the highest MEDIAN profit across the draws."""
    inside = _inside(points, lever)
    return max(inside, key=lambda pt: float(np.median(pt.profit))) if inside else None


@dataclass
class UniformHit:
    discount_pct: float
    plan: Plan
    #: P10 / P90 of the depth each draw needs, and the share of draws that
    #: reach the goal at some depth.
    range_pct: tuple[float, float] | None
    chance_pct: float


def _uniform_target(r: Resolved, points: list[CurvePoint], lever: dict[str, Any], goal: float) -> UniformHit | None:
    """Q3 for one discount, as goal programming: minimise the shortfall s in

        profit(d) + s >= goal,   s >= 0,   d within the data's depths.

    If s = 0 somewhere, Brent's method (scipy's brentq) finds the exact depth
    between the scan's grid points -- the SHALLOWEST that reaches, because it
    gives the least discount away. Under each posterior draw the same
    crossing is read off the scan, for the range of the required depth.
    None when s > 0 at every depth (the caller reports the closest)."""
    inside = _inside(points, lever)
    reach = [i for i, pt in enumerate(inside) if pt.plan.profit >= goal]
    if not reach:
        return None
    i0 = reach[0]
    d, plan = inside[i0].d, inside[i0].plan
    if i0 > 0:
        lo, hi = inside[i0 - 1].d, inside[i0].d
        root = brentq(lambda x: _plan_at(r, x, lever["max"]).profit - goal, lo, hi, xtol=1e-4)
        at = _plan_at(r, root, lever["max"])
        if at.profit >= goal - 0.5:
            d, plan = root, at
    grid = np.array([pt.d for pt in inside])
    P = np.stack([pt.profit for pt in inside], axis=1)           # draws x depths
    ok = P >= goal
    has = ok.any(axis=1)
    first = ok.argmax(axis=1)
    need = np.full(len(P), np.nan)
    rows = np.flatnonzero(has)
    for k in rows:
        j = first[k]
        if j == 0:
            need[k] = grid[0]
        else:
            a, b = P[k, j - 1], P[k, j]
            t = (goal - a) / (b - a) if b != a else 1.0
            need[k] = grid[j - 1] + t * (grid[j] - grid[j - 1])
    rng_pct = None
    if len(rows):
        q10, q90 = np.quantile(need[rows], [0.1, 0.9])
        rng_pct = (round(float(q10), 2), round(float(q90), 2))
    return UniformHit(round(d, 2), plan, rng_pct, round(float(has.mean() * 100), 2))


def _goal_programme(gains: Sequence[float], needed: float) -> tuple[list[int], float]:
    """The re-plan's goal programme, pre-emptive over product-stores. With
    x_c = 1 when product-store c takes its best calendar:

        priority 1   minimise s      s.t.  sum(gain_c x_c) + s >= needed,  s >= 0
        priority 2   minimise sum(x_c)     at that s

    Priority 1's optimum is s* = max(0, needed - sum of the positive gains).
    Priority 2 then needs the fewest product-stores covering needed - s*;
    product-stores share no constraint, so taking the largest gains first is
    exactly optimal. Returns the chosen indices (largest first) and s*."""
    order = sorted((i for i, g in enumerate(gains) if g > EPSILON), key=lambda i: -gains[i])
    total = sum(gains[i] for i in order)
    shortfall = max(0.0, needed - total)
    cover = needed - shortfall
    picked: list[int] = []
    running = 0.0
    for i in order:
        if running >= cover - 1e-9 and picked:
            break
        picked.append(i)
        running += gains[i]
    return (picked if needed > 0 else []), shortfall


# --- the calendar re-plan --------------------------------------------------------


@dataclass
class ChannelRules:
    channel: str
    month_grain: bool
    gap: int                      # empty periods required between two promotions
    max_share: float              # busiest share of periods a product-store has run
    regular: list[tuple[int, float]]   # (promotion code, depth) on the channel's menu


@lru_cache(maxsize=4)
def _rules(store_key: int) -> dict[str, ChannelRules]:
    """Each channel's booking grain, gap, frequency ceiling and offer menu,
    read from the data rather than written down."""
    fit = fitted()
    s, store = fit.slots, fit.store
    promos = store.promotions
    out: dict[str, ChannelRules] = {}
    order = np.lexsort((s.widx, s.cell))
    for ci, ch in enumerate(s.channels):
        mask = s.cell_channel[s.cell[order]] == ci
        rows = order[mask]
        lengths: list[int] = []
        gaps: list[int] = []
        prev_cell, run_len, last_end, cur_end = -1, 0, None, None
        for i in rows:
            c = s.cell[i]
            if c != prev_cell:
                if run_len:
                    lengths.append(run_len)
                prev_cell, run_len, last_end, cur_end = c, 0, None, None
            if s.promoted[i]:
                if s.run_pos[i] == 1:
                    if run_len:
                        lengths.append(run_len)
                        last_end = cur_end
                    if last_end is not None:
                        gaps.append(int(s.widx[i] - last_end - 1))
                    run_len = 0
                run_len += 1
                cur_end = s.widx[i]
        if run_len:
            lengths.append(run_len)
        month_grain = bool(lengths) and float(np.median(lengths)) >= 3
        min_gap = min(gaps) if gaps else 2
        gap = max(1, round(min_gap / 4.33)) if month_grain else max(1, min_gap)

        # The busiest product-store: share of its periods promoted.
        ch_rows = rows
        cells = np.unique(s.cell[ch_rows])
        weeks_n = len(s.weeks)
        if month_grain:
            months = len({(y, int(s.week_month[i])) for i, (y, _) in enumerate(s.weeks)})
            periods_n = months
        else:
            periods_n = weeks_n
        per_cell = np.bincount(s.cell[ch_rows][s.promoted[ch_rows] & (s.run_pos[ch_rows] == 1)],
                               minlength=len(s.cells))[cells]
        share = float(np.quantile(per_cell / max(periods_n, 1), 0.9)) if len(cells) else 0.3

        regular: dict[int, list[float]] = {}
        sel = ch_rows[s.promoted[ch_rows]]
        for code in np.unique(s.promo[sel]):
            if promos[code].type.lower() == "seasonal":
                continue
            m = sel[s.promo[sel] == code]
            lv = (s.units[m] * s.price[m]).sum()
            depth = float((s.units[m] * (s.price[m] - s.sell_price[m])).sum() / lv) if lv > 0 else 0.0
            if depth > 0:
                regular[int(code)] = [depth]
        out[ch] = ChannelRules(
            channel=ch, month_grain=month_grain, gap=gap, max_share=max(share, 0.05),
            regular=sorted(((c, d[0]) for c, d in regular.items()), key=lambda x: x[1]),
        )
    return out


def rules() -> dict[str, ChannelRules]:
    return _rules(id(fitted()))


@lru_cache(maxsize=4)
def _festival_depths(store_key: int) -> dict[int, float]:
    fit = fitted()
    s = fit.slots
    out: dict[int, float] = {}
    for code, p in enumerate(fit.store.promotions):
        if p.type.lower() != "seasonal":
            continue
        m = s.promoted & (s.promo == code)
        lv = (s.units[m] * s.price[m]).sum()
        if lv > 0:
            out[code] = float((s.units[m] * (s.price[m] - s.sell_price[m])).sum() / lv)
    return out


def _periods(fit: Fitted, weeks: np.ndarray, month_grain: bool) -> tuple[np.ndarray, np.ndarray, list[str]]:
    """Group the selection's weeks into periods. Returns the period of each
    week (0-based), each week's 1-based position inside its period, and a
    label per period."""
    s = fit.slots
    period = np.zeros(len(weeks), dtype=np.int64)
    pos = np.ones(len(weeks), dtype=np.int64)
    labels: list[str] = []
    key_prev = None
    p = -1
    for j, w in enumerate(weeks):
        y, wk = s.weeks[w]
        key = (y, int(s.week_month[w])) if month_grain else (y, wk)
        if key != key_prev:
            p += 1
            key_prev = key
            labels.append(f"{_MONTH_ABBR[key[1] - 1]} {y}" if month_grain
                          else f"W{wk:02d} {y} · {s.week_start[w][8:10]} {_MONTH_ABBR[int(s.week_start[w][5:7]) - 1]}"
                          if s.week_start[w] else f"W{wk:02d} {y}")
            pos[j] = 1
        else:
            pos[j] = pos[j - 1] + 1
        period[j] = p
    return period, pos, labels


@dataclass
class CellPlan:
    cell: int
    current_value: float      # model gain of today's promotions vs none
    best_value: float
    current: list[tuple[int, int]]   # (period, promo code)
    best: list[tuple[int, int]]
    labels: list[str]
    weeks: np.ndarray        # selection weeks
    period: np.ndarray       # period per selection week
    pos: np.ndarray

    @property
    def gain(self) -> float:
        return self.best_value - self.current_value


@dataclass
class Replan:
    cells: dict[int, CellPlan]
    eligible: int
    frozen: int              # product-stores the data never saw promoted


def _cell_current(fit: Fitted, slot_row: np.ndarray, period: np.ndarray) -> list[tuple[int, int]]:
    s = fit.slots
    out: dict[int, int] = {}
    for j, i in enumerate(slot_row):
        if i >= 0 and s.promoted[i]:
            out.setdefault(int(period[j]), int(s.promo[i]))
    return sorted(out.items())


@lru_cache(maxsize=16)
def replan(scope: PlanScope, timing: str = "free", frequency: str = "keep") -> Replan:
    """Every product-store's best calendar in the selection. See the module
    docstring for the rules."""
    r = resolve(scope)
    fit = r.fit
    s, store, model = fit.slots, fit.store, fit.model
    chan_rules = rules()
    fest_depth = _festival_depths(id(fit))
    weeks = r.weeks
    result: dict[int, CellPlan] = {}
    eligible = frozen = 0
    focus_code = _promo_code(fit, scope.promotion) if scope.promotion else None

    for ci, ch in enumerate(s.channels):
        cells = r.cells[s.cell_channel[r.cells] == ci]
        if not len(cells):
            continue
        cr = chan_rules[ch]
        period, pos, labels = _periods(fit, weeks, cr.month_grain)
        P = len(labels)
        grid = s.slot_of[np.ix_(cells, weeks)]                 # C x T
        if focus_code is not None:
            # A promotion's own slots: everything else in those weeks is out.
            grid = np.where((grid >= 0) & (s.promo[np.maximum(grid, 0)] == focus_code), grid, -1)
        valid = grid >= 0
        flat = np.where(valid, grid, 0).ravel()
        C, T = grid.shape
        starts = np.flatnonzero(np.r_[True, period[1:] != period[:-1]])

        none = econ(fit, flat, np.zeros(len(flat)), np.full(len(flat), -1, dtype=np.int64))
        base_profit = none.profit.reshape(C, T)

        def gain_of(depth: float, event: int) -> np.ndarray:
            e = econ(fit, flat, np.full(len(flat), depth), np.full(len(flat), event, dtype=np.int64))
            g = np.where(valid, e.profit.reshape(C, T) - base_profit, 0.0)
            return np.add.reduceat(g, starts, axis=1)              # C x P

        # The menu: regular offers everywhere, festival offers in their own
        # periods only. In a promotion's own focus, the menu is that offer at
        # its own depth plus the channel's regular depths.
        options: list[tuple[int, np.ndarray]] = []     # (promo code, C x P gain, -inf where unavailable)
        for code, depth in cr.regular:
            options.append((code, gain_of(depth, -1)))
        fest_periods: dict[int, set[int]] = {}
        ch_cells_all = np.flatnonzero(s.cell_channel == ci)
        week_set = {int(w): j for j, w in enumerate(weeks)}
        rows = s.slot_of[np.ix_(ch_cells_all, weeks)]
        for j in range(T):
            col = rows[:, j]
            col = col[col >= 0]
            for code in np.unique(s.promo[col][s.promoted[col]]):
                if int(code) in fest_depth:
                    fest_periods.setdefault(int(code), set()).add(int(period[j]))
        del week_set
        for code, ps in fest_periods.items():
            g = gain_of(fest_depth[code], int(event_index_for(model, np.array([code]))[0]))
            avail = np.zeros(P, dtype=bool)
            avail[list(ps)] = True
            options.append((code, np.where(avail[None, :], g, -np.inf)))
        if not options:
            continue
        stack = np.stack([g for _, g in options])                  # O x C x P
        best_opt = np.argmax(stack, axis=0)                         # C x P
        best_val = np.max(stack, axis=0)
        codes = np.array([c for c, _ in options])

        # Today's value per cell (model gain of the current promotions).
        cur_e = _current_model(fit, flat)
        cur_gain = np.where(valid & s.promoted[flat].reshape(C, T),
                            cur_e.profit.reshape(C, T) - base_profit, 0.0).sum(axis=1)

        has_evidence = model.cell_promoted[cells]
        period_promoted = np.zeros((C, P), dtype=bool)
        pv = valid & s.promoted[flat].reshape(C, T)
        for j in range(T):
            period_promoted[:, period[j]] |= pv[:, j]
        k_now = period_promoted.sum(axis=1)

        if timing == "fixed" or focus_code is not None:
            # Every promotion stays in its own period. "keep" re-chooses its
            # offer; "fewer" may also drop it.
            allowed = period_promoted & has_evidence[:, None]
            take = allowed if frequency == "keep" else allowed & (best_val > EPSILON)
            chosen = [[(int(p), int(codes[best_opt[c, p]])) for p in np.flatnonzero(take[c])] for c in range(C)]
            best_total = np.where(take, best_val, 0.0).sum(axis=1)
        else:
            exact = frequency == "keep"
            if frequency == "more":
                cap = np.maximum(k_now, np.floor(cr.max_share * P).astype(int))
            else:
                cap = k_now.copy()
            cap = np.where(has_evidence, cap, 0)
            K = int(cap.max()) if len(cap) else 0
            g = cr.gap
            # "keep": EXACTLY today's number of promotions, each placed and
            # priced at its best -- a losing slot is still filled, with the
            # least bad offer. Otherwise AT MOST the cap, so a promotion that
            # loses money is simply not run.
            v = best_val if exact else np.where(best_val > EPSILON, best_val, -np.inf)    # C x P
            Fm = np.zeros((P + 1, C, K + 1))
            if exact:
                Fm[0, :, 1:] = -np.inf
            take_tbl = np.zeros((P + 1, C, K + 1), dtype=bool)
            for p in range(1, P + 1):
                stay = Fm[p - 1]
                prev = Fm[max(p - 1 - g, 0)]
                cand = np.full((C, K + 1), -np.inf)
                if K >= 1:
                    cand[:, 1:] = prev[:, :-1] + v[:, p - 1][:, None]
                better = cand > stay + 1e-9
                Fm[p] = np.where(better, cand, stay)
                take_tbl[p] = better
            if exact:
                # The gap can make today's count infeasible inside a short
                # period; then the most promotions that fit.
                finite = np.isfinite(Fm[P])
                ks = np.arange(K + 1)[None, :]
                cap = np.max(np.where(finite & (ks <= cap[:, None]), ks, 0), axis=1)
            best_total = Fm[P, np.arange(C), cap]
            chosen = []
            for c in range(C):
                picks = []
                p, k = P, int(cap[c])
                while p > 0 and k > 0:
                    if take_tbl[p, c, k]:
                        picks.append((p - 1, int(codes[best_opt[c, p - 1]])))
                        p, k = max(p - 1 - g, 0), k - 1
                    else:
                        p -= 1
                chosen.append(sorted(picks))

        for c in range(C):
            if not has_evidence[c]:
                frozen += 1
                continue
            eligible += 1
            current = _cell_current(fit, grid[c], period)
            best = chosen[c]
            bv = float(best_total[c])
            cv = float(cur_gain[c])
            # Today's calendar is always available to the search, so a "best"
            # that does not beat it by a rupee is today's calendar.
            if bv - cv <= EPSILON or best == current:
                best, bv = current, cv
            result[int(cells[c])] = CellPlan(
                cell=int(cells[c]), current_value=cv, best_value=bv, current=current, best=best,
                labels=labels, weeks=weeks, period=period, pos=pos,
            )
    return Replan(cells=result, eligible=eligible, frozen=frozen)


def _apply(r: Resolved, plans: Iterable[CellPlan]) -> tuple[np.ndarray, Econ, np.ndarray, np.ndarray, np.ndarray]:
    """Slots that change under the chosen cell plans, priced."""
    fit = r.fit
    s = fit.slots
    fest_depth = _festival_depths(id(fit))
    chan_rules = rules()
    reg_depth = {code: d for cr in chan_rules.values() for code, d in cr.regular}
    position = {int(i): j for j, i in enumerate(r.idx)}
    changed_pos: list[int] = []
    depth: list[float] = []
    codes: list[int] = []
    no_code = _no_promo_code(fit)
    for cp in plans:
        if cp.best == cp.current:
            continue
        new_of_period = dict(cp.best)
        row = s.slot_of[cp.cell, cp.weeks]
        for j, i in enumerate(row):
            if i < 0 or int(i) not in position:
                continue
            per = int(cp.period[j])
            code = new_of_period.get(per)
            was = s.promoted[i]
            if code is None and not was:
                continue
            changed_pos.append(position[int(i)])
            if code is None:
                depth.append(0.0)
                codes.append(no_code)
            else:
                depth.append(fest_depth.get(code, reg_depth.get(code, 0.0)))
                codes.append(code)
    if not changed_pos:
        empty = np.zeros(0, dtype=np.int64)
        return empty, econ(fit, empty, np.zeros(0), empty), empty, np.zeros(0), empty
    pos_arr = np.array(changed_pos, dtype=np.int64)
    idx = r.idx[pos_arr]
    code_arr = np.array(codes, dtype=np.int64)
    depth_arr = np.array(depth)
    event_arr = event_index_for(fit.model, code_arr)
    new = econ(fit, idx, depth_arr, event_arr)
    return pos_arr, new, code_arr, depth_arr, event_arr


def _offer(fit: Fitted, code: int) -> dict[str, Any]:
    p = fit.store.promotions[code]
    depth = _festival_depths(id(fit)).get(code)
    if depth is None:
        depth = next((d for cr in rules().values() for c, d in cr.regular if c == code), 0.0)
    return {"id": p.promotion_id, "name": p.label, "type": p.type, "mechanic": p.name,
            # The offer's NOMINAL discount, a whole number: "15% Discount" is
            # 15%, even though rounded shelf prices make it 14.98% on average.
            # Averages elsewhere keep their decimals; an offer does not.
            "depth_pct": int(round(depth * 100))}


def _actions(fit: Fitted, cp: CellPlan, cur: dict[int, int], new: dict[int, int]) -> list[dict[str, Any]]:
    """What happens to this product-store's promotions, one line each.

    A promotion that leaves a period and one that arrives in another are read
    as a MOVE, paired in calendar order (first to leave with first to
    arrive). A period that keeps a promotion with a different offer is a
    RE-PRICE. What is left over was dropped or added. A product-store runs at
    most one offer a week, so a promotion is never moved onto another one of
    its own -- the plan re-chooses the whole calendar of the product-store at
    once -- and no other product-store's promotions are touched."""
    def offer(code: int) -> dict[str, Any]:
        o = _offer(fit, code)
        return {"id": o["id"], "name": o["name"], "type": o["type"], "depth_pct": o["depth_pct"]}

    out: list[dict[str, Any]] = []
    for k in sorted(cur):
        if k in new and new[k] != cur[k]:
            out.append({"kind": "repriced", "period": cp.labels[k], "index": k,
                        "from_offer": offer(cur[k]), "to_offer": offer(new[k])})
    leaving = [k for k in sorted(cur) if k not in new]
    arriving = [k for k in sorted(new) if k not in cur]
    for a, b in zip(leaving, arriving):
        out.append({"kind": "moved", "period": cp.labels[a], "index": a, "to_period": cp.labels[b], "to_index": b,
                    "from_offer": offer(cur[a]), "to_offer": offer(new[b])})
    for k in leaving[len(arriving):]:
        out.append({"kind": "dropped", "period": cp.labels[k], "index": k, "from_offer": offer(cur[k])})
    for k in arriving[len(leaving):]:
        out.append({"kind": "added", "period": cp.labels[k], "index": k, "to_offer": offer(new[k])})
    out.sort(key=lambda a: a["index"])
    return out


def _change_rows(fit: Fitted, plans: Sequence[CellPlan], currency: str) -> list[dict[str, Any]]:
    store, s = fit.store, fit.slots
    out = []
    for cp in plans:
        p_code, s_code = s.cells[cp.cell]
        product, st = store.products[p_code], store.stores[s_code]
        cur, new = dict(cp.current), dict(cp.best)
        kept = sum(1 for k, v in cur.items() if new.get(k) == v)
        repriced = sum(1 for k, v in cur.items() if k in new and new[k] != v)
        removed = sum(1 for k in cur if k not in new)
        added = sum(1 for k in new if k not in cur)
        moved = min(removed, added)
        out.append({
            "actions": _actions(fit, cp, cur, new),
            "product_id": product.product_id, "product": product.name.strip() or product.product_id,
            "brand": product.brand, "store_id": st.store_id,
            "store": ", ".join(x for x in (st.retailer or st.distributor, st.city) if x) or st.store_id,
            "channel_id": st.channel_id,
            "channel": store.dims.channels[st.channel_id].name if st.channel_id in store.dims.channels else st.channel_id,
            "region": st.region,
            "gain": _money(cp.gain, currency),
            "summary": {"kept": kept, "repriced": repriced, "moved": moved,
                        "dropped": removed - moved, "added": added - moved},
            "current": [{"period": cp.labels[k], "index": k, **_offer(fit, v)} for k, v in sorted(cur.items())],
            "best": [{"period": cp.labels[k], "index": k, **_offer(fit, v)} for k, v in sorted(new.items())],
            "periods": len(cp.labels),
            "first_period": cp.labels[0] if cp.labels else "",
            "last_period": cp.labels[-1] if cp.labels else "",
            "grain": "month" if rules()[st.channel_id].month_grain else "week",
        })
    return out


def _weekly_draws(r: Resolved, pos: np.ndarray, depth: np.ndarray, event: np.ndarray) -> np.ndarray:
    """The plan's change in profit and revenue per week, under every draw
    (draws x 2 x weeks): each draw's view of the new options less its view
    of today's, plus each week's own noise -- the Monte Carlo, week by week."""
    fit = r.fit
    s, m = fit.slots, fit.model
    n = len(r.weeks)
    D = m.draws
    out = np.zeros((D, 2, n))
    if not len(pos):
        return out
    idx = r.idx[pos]
    wk = s.widx[idx] - r.weeks[0]
    cols = (_M["profit"], _M["revenue"])

    def side(dep: np.ndarray, ev: np.ndarray) -> tuple[np.ndarray, np.ndarray, np.ndarray]:
        a, c = _terms(fit, idx, dep)
        tot = np.zeros((D, 2, n))
        for t, j in enumerate(cols):
            tot[:, t, :] += np.bincount(wk, weights=a[:, j], minlength=n)[None, :]
        u_mean = np.zeros(len(idx))
        prom = dep > 0
        if prom.any():
            u, inv = m.lift_draws(s.cell[idx[prom]], dep[prom], np.asarray(ev)[prom])
            K = u.shape[1]
            key = inv * n + wk[prom]
            for t, j in enumerate(cols):
                W = np.bincount(key, weights=c[prom][:, j], minlength=K * n).reshape(K, n)
                tot[:, t, :] += u @ W
            u_mean[prom] = u.mean(axis=0, dtype=np.float64)[inv]
        return tot, c, u_mean

    new, c, u_mean = side(depth, event)
    cd, ce = _current_option(fit, idx)
    cur, _, _ = side(cd, ce)
    # Noise: each product x channel x week draws its own error, so weeks are
    # independent of each other.
    prom = depth > 0
    if prom.any():
        pi = idx[prom]
        products = np.array([p for p, _ in s.cells], dtype=np.int64)
        gkey = (products[s.cell[pi]] * len(s.channels) + s.cell_channel[s.cell[pi]]) * len(s.weeks) + s.widx[pi]
        _, ginv = np.unique(gkey, return_inverse=True)
        n_g = np.bincount(ginv).astype(float)
        var_g = np.expm1(float(np.median(m.post.sigma)) ** 2 / (n_g / m.mean_row_slots))
        g_week = np.zeros(len(n_g), dtype=np.int64)
        g_week[ginv] = wk[prom]
        z = np.random.default_rng(MC_SEED + 1).standard_normal((D, n))
        for t, j in enumerate(cols):
            S = np.bincount(ginv, weights=c[prom][:, j] * (1.0 + u_mean[prom]), minlength=len(n_g))
            sd = np.sqrt(np.bincount(g_week, weights=S ** 2 * var_g, minlength=n))
            new[:, t, :] += z * sd[None, :]
    return new - cur


def _week_festivals(r: Resolved) -> list[str | None]:
    """The festival offer running in each week of the selection, if any."""
    fit = r.fit
    s = fit.slots
    n = len(r.weeks)
    out: list[str | None] = [None] * n
    p = r.idx[r.promoted]
    ev = event_index_for(fit.model, s.promo[p])
    fest = ev >= 0
    if not fest.any():
        return out
    wk = s.widx[p[fest]] - r.weeks[0]
    e = ev[fest]
    # A festival's own week(s): where its offer runs at least half as widely
    # as at its peak. Month-booked channels run it all month, which would
    # otherwise shade the whole month.
    counts = np.zeros((len(fit.model.events), n))
    np.add.at(counts, (e, wk), 1.0)
    peak = counts.max(axis=1, keepdims=True)
    strong = counts >= 0.5 * np.maximum(peak, 1.0)
    for j in range(n):
        hits = np.flatnonzero(strong[:, j] & (counts[:, j] > 0))
        if len(hits):
            out[j] = fit.model.events[int(hits[np.argmax(counts[hits, j])])]
    return out


def _weekly(r: Resolved, pos: np.ndarray, new: Econ, new_promo: np.ndarray, currency: str,
            depth: np.ndarray | None = None, event: np.ndarray | None = None) -> list[dict[str, Any]]:
    """Per week of the selection: profit and revenue under the current plan
    and under the new one, the new one's P10 - P90 from the Monte Carlo, the
    promoted product-stores, and the festival running -- the chart the page
    draws."""
    fit = r.fit
    s = fit.slots
    meas = _meas(r)
    w_of = s.widx[r.idx]
    weeks = r.weeks
    off = weeks[0]
    n = len(weeks)
    profit_now = np.bincount(w_of - off, weights=meas.profit, minlength=n)
    revenue_now = np.bincount(w_of - off, weights=meas.revenue, minlength=n)
    promo_now = np.bincount(w_of - off, weights=r.promoted.astype(float), minlength=n)
    profit_new = profit_now.copy()
    revenue_new = revenue_now.copy()
    promo_new = promo_now.copy()
    if len(pos):
        cur = _current_model(fit, r.idx[pos])
        wk = w_of[pos] - off
        profit_new += np.bincount(wk, weights=new.profit - cur.profit, minlength=n)
        revenue_new += np.bincount(wk, weights=new.revenue - cur.revenue, minlength=n)
        promo_new += np.bincount(wk, weights=new.promoted.astype(float) - r.promoted[pos].astype(float), minlength=n)
    if len(pos) and depth is not None and event is not None:
        d = _weekly_draws(r, pos, depth, event)
        p_lo, p_hi = np.quantile(profit_now[None, :] + d[:, 0, :], [0.1, 0.9], axis=0)
        r_lo, r_hi = np.quantile(revenue_now[None, :] + d[:, 1, :], [0.1, 0.9], axis=0)
    else:
        p_lo, p_hi, r_lo, r_hi = profit_new, profit_new, revenue_new, revenue_new
    festivals = _week_festivals(r)
    out = []
    for j, w in enumerate(weeks):
        y, wk_no = s.weeks[w]
        out.append({
            "week": f"{y}-W{wk_no:02d}", "start": s.week_start[w], "month": int(s.week_month[w]),
            "promoted_now": int(round(promo_now[j])), "promoted_plan": int(round(promo_new[j])),
            "profit_now": round(float(profit_now[j]), 2), "profit_plan": round(float(profit_new[j]), 2),
            "profit_p10": round(float(p_lo[j]), 2), "profit_p90": round(float(p_hi[j]), 2),
            "revenue_now": round(float(revenue_now[j]), 2), "revenue_plan": round(float(revenue_new[j]), 2),
            "revenue_p10": round(float(r_lo[j]), 2), "revenue_p90": round(float(r_hi[j]), 2),
            "festival": festivals[j],
        })
    return out


def _rules_block(r: Resolved, timing: str, frequency: str) -> dict[str, Any]:
    fit = r.fit
    chan = {fit.store.stores[fit.slots.cells[c][1]].channel_id for c in r.cells}
    out = []
    for ch, cr in sorted(rules().items()):
        if ch not in chan:
            continue
        name = fit.store.dims.channels[ch].name if ch in fit.store.dims.channels else ch
        out.append({
            "channel_id": ch, "channel": name,
            "grain": "month" if cr.month_grain else "week",
            "gap": cr.gap,
            "max_share_pct": round(cr.max_share * 100, 2),
            "menu": [_offer(fit, code) for code, _ in cr.regular],
        })
    return {"timing": "fixed" if r.focus else timing, "frequency": frequency, "channels": out}


def _impact(r: Resolved, rows: Sequence[dict[str, Any]]) -> dict[str, Any]:
    """What a plan changes, counted two ways -- promotions and the
    product-stores they belong to:

      discount_changed  promotions whose discount VALUE changes, whether in
                        their own week or as they shift (a promotion can be
                        both re-priced and shifted)
      shifted           promotions run in a different week
      shifted_and_repriced  both: a new week AND a new discount
      stopped / added   promotions dropped or new (only when the count rule
                        allows it)

    plus the shifted promotions by offer, and the product-stores affected
    out of every product-store in the selection."""
    def bucket() -> dict[str, Any]:
        return {"promotions": 0, "stores": set()}

    out = {k: bucket() for k in ("discount_changed", "shifted", "shifted_and_repriced", "stopped", "added")}
    by_offer: dict[str, dict[str, Any]] = {}
    for row in rows:
        ps = (row["product_id"], row["store_id"])
        for a in row["actions"]:
            kind = a["kind"]
            f, t = a.get("from_offer"), a.get("to_offer")
            if kind == "moved":
                out["shifted"]["promotions"] += 1
                out["shifted"]["stores"].add(ps)
                name = event_of(f["name"]) if f and f["type"].lower() == "seasonal" else (f["name"] if f else "")
                o = by_offer.setdefault(name, {"name": name, "type": f["type"] if f else "", "depth_pct": f["depth_pct"] if f else 0,
                                                "promotions": 0, "stores": set()})
                o["promotions"] += 1
                o["stores"].add(ps)
            if (kind == "repriced" or kind == "moved") and f and t and f["depth_pct"] != t["depth_pct"]:
                out["discount_changed"]["promotions"] += 1
                out["discount_changed"]["stores"].add(ps)
                if kind == "moved":
                    out["shifted_and_repriced"]["promotions"] += 1
                    out["shifted_and_repriced"]["stores"].add(ps)
            if kind == "dropped":
                out["stopped"]["promotions"] += 1
                out["stopped"]["stores"].add(ps)
            if kind == "added":
                out["added"]["promotions"] += 1
                out["added"]["stores"].add(ps)
    flat = {k: {"promotions": v["promotions"], "product_stores": len(v["stores"])} for k, v in out.items()}
    flat["shifted_by_offer"] = sorted(
        ({"name": o["name"], "type": o["type"], "depth_pct": o["depth_pct"], "promotions": o["promotions"],
          "product_stores": len(o["stores"])} for o in by_offer.values()),
        key=lambda o: -o["promotions"])
    flat["product_stores_affected"] = len(rows)
    flat["product_stores_total"] = int(len(r.cells))
    return flat


def _plan_payload(r: Resolved, chosen: Sequence[CellPlan], currency: str,
                  needed: float | None = None) -> tuple[Plan, dict[str, Any]]:
    pos, new, promo, depth, event = _apply(r, chosen)
    cur = current_plan(r)
    plan = _changed_plan(r, pos, new, promo) if len(pos) else cur
    band = _band(cur, _plan_draws(r, pos, depth, event), currency, needed) if len(pos) else None
    rows = _change_rows(r.fit, sorted(chosen, key=lambda cp: -cp.gain), currency)
    summary = {k: sum(x["summary"][k] for x in rows) for k in ("kept", "repriced", "moved", "dropped", "added")}
    return plan, {
        "figures": _figures(plan, currency),
        "deltas": _deltas(cur, plan, currency),
        "changed_product_stores": len(rows),
        "change_summary": summary,
        "impact": _impact(r, rows),
        "changes": rows[:MAX_CHANGES_LISTED],
        "changes_truncated": max(0, len(rows) - MAX_CHANGES_LISTED),
        "weekly": _weekly(r, pos, new, promo, currency, depth, event),
        "band": band,
    }


def _model_block(fit: Fitted) -> dict[str, Any]:
    m = fit.model
    diag = m.post.diagnostics
    gamma = np.median(m.post.gamma, axis=0) if m.post.gamma.size else np.zeros(0)
    return {
        "method": "Hierarchical Bayesian regression, sampled with NUTS",
        "curve": "log(1 + u) = b1·d + b2·d² + festival",
        "global_beta1": diag.get("global_beta1"), "global_beta2": diag.get("global_beta2"),
        "groups": len(m.groups), "brands": len(m.brands), "festivals": len(m.events),
        "chains": diag.get("chains"), "draws_per_chain": diag.get("draws_per_chain"),
        "mc_draws": m.draws,
        "rhat_max": diag.get("rhat_max"), "ess_min": diag.get("ess_min"), "divergences": diag.get("divergences"),
        "festival_lift": {name: round((math.exp(float(v)) - 1) * 100, 2)
                          for name, v in sorted(zip(m.events, gamma), key=lambda kv: -kv[1])},
        "fit_rows": m.n_rows, "promoted_weeks_fitted": m.n_slots,
        "regular_rows": m.n_regular, "festival_rows": m.n_festival,
        "deepest_observed_pct": round(m.depth_max * 100, 2),
        "backtest": m.backtest.get("time") or {},
        "festival_backtest": m.backtest.get("festival") or {},
        "cannibalization_pct": {k: round(v * 100, 2) for k, v in sorted(fit.cannibalization.items())},
        "baseline": "Base_Quantity from the file" if fit.slots.counterfactual else "nearest ordinary weeks",
    }


# --- the three answers -----------------------------------------------------------


def summary(scope: PlanScope, currency: str = "INR") -> dict[str, Any]:
    """The selection as it stands: its plan, the lever, the promotions in it."""
    r = resolve(scope)
    fit = r.fit
    s, store = fit.slots, fit.store
    cur = current_plan(r)
    # The promotions in the selection, by offer.
    offers: list[dict[str, Any]] = []
    if r.promoted.any():
        idx = r.idx[r.promoted]
        for code in np.unique(s.promo[idx]):
            m = idx[s.promo[idx] == code]
            meas = _measured(fit, m)
            t = meas.total()
            spend = t["discount"] + t["promo_cost"]
            offers.append({
                **_offer(fit, int(code)),
                "runs": _runs(fit, m, np.ones(len(m), dtype=bool), s.promo[m]),
                "product_stores": int(len(np.unique(s.cell[m]))),
                "profit": _money(t["profit"], currency),
                "trade_spend": _money(spend, currency),
                "roi": F.multiple(A.roi_multiple(t["inc_sales"], spend, precision=None) if spend > 0 else None),
            })
        offers.sort(key=lambda o: (o["type"] != "Seasonal", o["depth_pct"]))
    return {
        "currency": F.normalise_currency(currency),
        "exchange_rate": F.convert(1.0, F.normalise_currency(currency)),
        "scope": _scope_block(r),
        "current": _figures(cur, currency),
        "lever": _lever(fit, r) if r.promoted.any() else None,
        "offers": offers,
        "model": _model_block(fit),
    }


def best(scope: PlanScope, *, timing: str = "free", frequency: str = "keep", currency: str = "INR") -> dict[str, Any]:
    """The most profitable plan: the best single discount (Q2, the highest
    median profit over the draws), and the best calendar product-store by
    product-store."""
    r = resolve(scope)
    cur = current_plan(r)
    uniform = None
    if r.promoted.any():
        lever = _lever(r.fit, r)
        _, points = _curve_cached(scope)
        b = _best_uniform(r, points, lever)
        if b:
            uniform = {
                "discount_pct": b.d,
                "shift_pts": round(b.d - lever["default"], 2),
                "shift_relative_pct": round((b.d - lever["default"]) / lever["default"] * 100, 2) if lever["default"] else None,
                "figures": _figures(b.plan, currency),
                "deltas": _deltas(cur, b.plan, currency),
                "profit_range": _trio(b.profit, lambda v: _money(v, currency)),
            }
    rp = replan(scope, timing if not r.focus else "fixed", frequency)
    chosen = [cp for cp in rp.cells.values() if cp.best != cp.current and cp.gain > EPSILON]
    _, plan_block = _plan_payload(r, chosen, currency)
    return {
        "currency": F.normalise_currency(currency),
        "exchange_rate": F.convert(1.0, F.normalise_currency(currency)),
        "current": _figures(cur, currency),
        "uniform": uniform,
        "replan": {**plan_block, "eligible_product_stores": rp.eligible, "never_promoted_product_stores": rp.frozen},
        "rules": _rules_block(r, timing, frequency),
    }


def target(scope: PlanScope, *, target_pct: float, timing: str = "free", frequency: str = "keep",
           basis: str = "cost",
           currency: str = "INR") -> dict[str, Any]:
    """+X% profit (Q3): the discount change that reaches it with the same
    weeks, and the fewest product-stores to re-plan -- both as goal
    programmes that minimise the shortfall first. Out of reach -> the most
    that is reachable and what blocks the rest.

    THE TARGET, AS SP AND CP. Profit = SP - CP, where SP is revenue at the
    prices actually paid (the discount is already out of it) and CP is
    product cost + promotion cost; Profit % = Profit / CP. "+X%" adds X
    points to that percentage with CP held at the current plan's -- exactly
    "CP 100, SP 105 is 5%; +5% takes SP to 110" -- so the extra profit
    needed is X% of the current CP, a fixed amount in rupees. (Measured as a
    ratio AFTER the change instead, a plan could reach it by simply selling
    less: fewer units shrink CP.) `basis="promotion"` keeps the older
    reading, X% of promotion profit, for the API only.

    UNCERTAINTY. Each answer carries B's Monte Carlo: the P10-P90 of what
    the plan earns, and the share of posterior draws in which it reaches
    the target."""
    r = resolve(scope)
    cur = current_plan(r)
    if basis == "promotion" and abs(cur.promo_profit) >= 1.0:
        base = abs(cur.promo_profit)
    else:
        basis = "cost"
        base = cur.cost
    needed = base * target_pct / 100.0
    goal = cur.profit + needed   # what every search compares, in profit terms
    pct_of = lambda gain: gain / base * 100 if base else None  # noqa: E731

    # A. One discount change, same weeks.
    uniform: dict[str, Any] | None = None
    if r.promoted.any():
        lever = _lever(r.fit, r)
        _, points = _curve_cached(scope)
        hit = _uniform_target(r, points, lever, goal)
        b = _best_uniform(r, points, lever)
        if hit:
            d, p = hit.discount_pct, hit.plan
            uniform = {
                "reachable": True, "discount_pct": d,
                "shift_pts": round(d - lever["default"], 2),
                "shift_relative_pct": round((d - lever["default"]) / lever["default"] * 100, 2) if lever["default"] else None,
                "discount_range_pct": list(hit.range_pct) if hit.range_pct else None,
                "chance_reach_pct": hit.chance_pct,
                "shortfall": _money(0.0, currency),
                "method": "Shallowest depth that reaches the goal, by Brent's method",
                "figures": _figures(p, currency), "deltas": _deltas(cur, p, currency),
            }
        elif b:
            reach = pct_of(b.plan.profit - cur.profit)
            uniform = {
                "reachable": False, "discount_pct": b.d,
                "shift_pts": round(b.d - lever["default"], 2),
                "shift_relative_pct": round((b.d - lever["default"]) / lever["default"] * 100, 2) if lever["default"] else None,
                "max_profit_change_pct": None if reach is None else round(reach, 2),
                "shortfall": _money(max(0.0, goal - b.plan.profit), currency),
                "chance_reach_pct": round(float((b.profit >= goal).mean() * 100), 2),
                "figures": _figures(b.plan, currency), "deltas": _deltas(cur, b.plan, currency),
                "blocker": (f"Profit peaks at a {b.d:.2f}% average discount; a deeper or shallower one earns less, "
                            f"and the data shows nothing deeper than {lever['evidence_max']:.2f}%."),
            }

    # B. Re-plan the fewest product-stores: the goal programme.
    eff_timing = "fixed" if r.focus else timing
    rp = replan(scope, eff_timing, frequency)
    cells = list(rp.cells.values())
    picked_i, shortfall = _goal_programme([cp.gain for cp in cells], needed)
    ranked = [cells[i] for i in picked_i]
    total_gain = sum(cp.gain for cp in cells if cp.gain > EPSILON)
    reachable = needed > 0 and shortfall <= 1e-6
    plan, block = _plan_payload(r, ranked, currency, needed)
    achieved_pct = pct_of(plan.profit - cur.profit)
    max_pct = pct_of(total_gain)

    blocker = None
    alternatives: list[dict[str, Any]] = []
    if not reachable and needed > 0:
        # Name what binds by lifting each rule in turn.
        def reach_with(t: str, f: str) -> float:
            alt = replan(scope, t, f)
            g = sum(cp.gain for cp in alt.cells.values() if cp.gain > EPSILON)
            return pct_of(g) or 0.0

        if not r.focus and eff_timing == "fixed":
            alternatives.append({"rule": "timing", "label": "Let promotions move to other weeks",
                                 "max_profit_change_pct": round(reach_with("free", frequency), 2)})
        if frequency == "keep":
            alternatives.append({"rule": "count", "label": "Allow dropping promotions that lose money",
                                 "max_profit_change_pct": round(reach_with(eff_timing, "fewer"), 2)})
        if not r.focus and frequency != "more":
            alternatives.append({"rule": "count", "label": "Allow more promotions per product-store",
                                 "max_profit_change_pct": round(reach_with("free", "more"), 2)})
        lifts = [a for a in alternatives if a["max_profit_change_pct"] >= target_pct]
        if lifts:
            blocker = f"{lifts[0]['label']} reaches the target ({F.percent(lifts[0]['max_profit_change_pct'], signed=True)})."
        else:
            blocker = ("The response itself: no offer the data supports earns more on these product-stores. "
                       "Each one already runs its most profitable calendar under these rules.")

    return {
        "currency": F.normalise_currency(currency),
        "exchange_rate": F.convert(1.0, F.normalise_currency(currency)),
        "target_pct": round(target_pct, 2),
        "current": _figures(cur, currency),
        "basis": basis,
        "base_profit": _money(cur.profit, currency),
        "goal_profit": _money(goal, currency),
        "cost_base": _money(cur.cost, currency),
        "profit_pct": {"value": None if cur.profit_pct is None else round(cur.profit_pct, 2), "display": F.percent(cur.profit_pct)},
        "goal_profit_pct": {"value": None if cur.profit_pct is None else round(cur.profit_pct + target_pct, 2),
                            "display": F.percent(None if cur.profit_pct is None else cur.profit_pct + target_pct)},
        "needed": _money(needed, currency),
        "uniform": uniform,
        "replan": {
            **block,
            "reachable": reachable or needed <= 0,
            "max_profit_change_pct": None if max_pct is None else round(max_pct, 2),
            "achieved_profit_change_pct": None if achieved_pct is None else round(achieved_pct, 2),
            "shortfall": _money(shortfall, currency),
            "shortfall_pct": None if not base else round(shortfall / base * 100, 2),
            "product_stores_total": rp.eligible,
            "blocker": blocker,
            "alternatives": alternatives,
        },
        "rules": _rules_block(r, eff_timing, frequency),
    }


def clear() -> None:
    for cached in (resolve, _curve_cached, replan, _rules, _festival_depths):
        cached.cache_clear()


__all__ = [
    "EmptySelection", "NothingPromoted", "PlanScope", "best", "clear", "curve", "options",
    "summary", "target", "whatif", "event_of",
]
