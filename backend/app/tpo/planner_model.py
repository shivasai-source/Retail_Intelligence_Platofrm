"""Promotion Planner -- the response model (TPO_Algorithm_Workflow.pdf, B).

THE QUESTION. "If this product, in this store, ran THIS offer in THAT week,
how many extra units would it sell -- and how sure are we?" Everything the
planner prices -- a what-if discount, a profit target, a re-planned calendar
-- is that question asked many times, so it is answered in one place.

THE BASELINE (component A). Units without the promotion are the file's own
Base_Quantity: actual units on an ordinary week, the expected units on a
promoted one. A source without a real Base_Quantity falls back to the
nearest BASELINE_WINDOW ordinary weeks of the same product-store. Every slot
-- product x store x business week -- carries its own baseline, seasonality
included, so moving a promotion moves it onto that week's baseline.

THE RESPONSE (component B, the PDF's Step 3). A hierarchical Bayesian
regression, sampled with NUTS (app/tpo/nuts.py):

    log(1 + u) = beta1[g] * d + beta2[g] * d^2 + gamma[event] + e

  u          the uplift, Actual / Base - 1;  d the discount depth
  g          the pooling group, brand x channel. beta[g] ~ Normal(beta_brand,
             s_g) and beta_brand ~ Normal(beta_global, tau): a thin group
             borrows from its brand, a brand from the whole business.
  gamma      a festival's level over a regular week at the same depth,
             gamma[event] ~ Normal(mu_festival, s_e) -- Dussehra borrows from
             Diwali but can differ. Zero lift at zero discount on a regular week.
  CONFOUNDING RULE. Regular weeks (5/10/15%) identify the curve's shape;
             each festival ran one depth, so festivals identify only their own
             level. beta never varies by event.
  GRAIN.     Fitted on product x channel x week x offer totals, not single
             product-store rows; each row's noise scales with how many
             product-stores it sums.

The fit is 4 chains x 1,000 draws after 1,000 warm-up iterations, checked by
split R-hat, effective sample size and divergences. ~1,000 posterior draws
are kept for the Monte Carlo (Step 4, in the planner). A slot's expected
lift is the mean over draws of exp(eta + sigma^2 / 2) - 1, capped at the
largest lift the data shows. The posterior is cached on disk, keyed by the
data, so a restart does not re-sample.

VALIDATION. The PDF's backtest -- hold out the latest Diwali and Dussehra,
refit, compare the predicted uplift with the actual -- and a time hold-out
(fit on the first 80% of weeks, predict the rest) for accuracy and P10-P90
coverage.

NOTHING HERE IS A KPI. The model returns lift; the planner turns lift into
rows and money.
"""

from __future__ import annotations

import hashlib
import json
import logging
import math
import re
import threading
import time
from dataclasses import dataclass, field
from functools import lru_cache
from pathlib import Path
from typing import Any

import numpy as np

from app.tpo.loader import NO_PROMOTION, FactStore, get_store

log = logging.getLogger(__name__)

#: Ordinary weeks averaged either side of a slot when the source has no real
#: Base_Quantity -- the same window `aggregate.BASELINE_WINDOW` uses.
BASELINE_WINDOW = 4

#: A seasonal offer's event: its description without the trailing year
#: ("Diwali Special 25" -> "Diwali Special").
_YEAR_SUFFIX = re.compile(r"\s*(?:'?\d{2}|\d{4})\s*$")


def event_of(description: str) -> str:
    return _YEAR_SUFFIX.sub("", description).strip() or description


# --- the slot table ----------------------------------------------------------


@dataclass
class Slots:
    """The fact table as numpy columns at the planner's grain: one row per
    product x store x business week (the file holds exactly one)."""

    n: int
    cell: np.ndarray        # int: index into `cells`
    widx: np.ndarray        # int: index into `weeks` (chronological)
    promo: np.ndarray       # int: promotion code (FactStore.promotions)
    promoted: np.ndarray    # bool
    base: np.ndarray        # baseline units (Base_Quantity or local fallback)
    units: np.ndarray       # actual units
    price: np.ndarray       # list price per unit
    sell_price: np.ndarray  # price paid per unit
    cost: np.ndarray        # Total_Cost
    promo_cost: np.ndarray  # Promotion_Cost
    depth: np.ndarray       # 1 - paid / list
    run_pos: np.ndarray     # 1-based week within a run of one offer, 0 when not promoted
    month: np.ndarray       # analytical month 1-12

    cells: list[tuple[int, int]]          # (product code, store code)
    cell_channel: np.ndarray              # int: index into `channels`
    channels: list[str]
    weeks: list[tuple[int, int]]          # (year, business week)
    week_start: list[str]                 # ISO date of each week's first day
    week_month: np.ndarray                # analytical month of each week
    unit_cost: np.ndarray                 # per cell
    list_price: np.ndarray                # per cell, units-weighted
    slot_of: np.ndarray                   # [cell, week] -> slot index or -1
    counterfactual: bool


def _local_base(cell: np.ndarray, widx: np.ndarray, units: np.ndarray, promoted: np.ndarray) -> np.ndarray:
    """Units without the promotion for a source that does not carry them: the
    mean of the nearest BASELINE_WINDOW ordinary weeks either side, per cell."""
    base = units.astype(float).copy()
    order = np.lexsort((widx, cell))
    bounds = np.flatnonzero(np.diff(cell[order])) + 1
    for idx in np.split(order, bounds):
        ordinary = idx[~promoted[idx]]
        if not len(ordinary):
            continue
        pos = np.searchsorted(widx[ordinary], widx[idx])
        for j, i in enumerate(idx):
            if not promoted[i]:
                continue
            k = pos[j]
            near = ordinary[max(0, k - BASELINE_WINDOW):k + BASELINE_WINDOW]
            base[i] = units[near].mean() if len(near) else units[i]
    return base


def build_slots(store: FactStore) -> Slots:
    pc = np.frombuffer(store.product_code, dtype=np.int32).astype(np.int64)
    sc = np.frombuffer(store.store_code, dtype=np.int32).astype(np.int64)
    year = np.frombuffer(store.year, dtype=np.int16).astype(np.int64)
    week = np.frombuffer(store.week, dtype=np.int8).astype(np.int64)
    month = np.frombuffer(store.month, dtype=np.int8).astype(np.int64)
    promo = np.frombuffer(store.promo_code, dtype=np.int32).astype(np.int64)
    promoted = np.frombuffer(store.promoted, dtype=np.int8).astype(bool)
    units = np.frombuffer(store.actual_quantity, dtype=np.float64)
    base_q = np.frombuffer(store.base_quantity, dtype=np.float64)
    base_rev = np.frombuffer(store.base_revenue, dtype=np.float64)
    act_rev = np.frombuffer(store.actual_revenue, dtype=np.float64)
    sell = np.frombuffer(store.actual_price, dtype=np.float64)
    cost = np.frombuffer(store.total_cost, dtype=np.float64)
    pcost = np.frombuffer(store.promotion_cost, dtype=np.float64)

    # Chronological business weeks.
    wkey = year * 100 + week
    uweeks, widx = np.unique(wkey, return_inverse=True)
    weeks = [(int(k // 100), int(k % 100)) for k in uweeks]
    starts = store.dims.week_start
    week_start = [starts[w].isoformat() if w in starts else "" for w in weeks]
    week_month = np.zeros(len(weeks), dtype=np.int64)
    week_month[widx] = month

    ckey = pc * 100_000 + sc
    ucells, cell = np.unique(ckey, return_inverse=True)
    cells = [(int(k // 100_000), int(k % 100_000)) for k in ucells]
    channels = sorted({s.channel_id for s in store.stores})
    ch_index = {c: i for i, c in enumerate(channels)}
    cell_channel = np.array([ch_index[store.stores[s].channel_id] for _, s in cells], dtype=np.int64)

    with np.errstate(divide="ignore", invalid="ignore"):
        price = np.where(units > 0, base_rev / units, 0.0)
        depth = np.where(price > 0, 1.0 - sell / price, 0.0)
    depth = np.clip(np.where(promoted, depth, 0.0), 0.0, 0.95)
    # A row with no units carries no price; give it its cell's price so a
    # promotion moved onto it can still be priced.
    n_cells = len(cells)
    qty_by_cell = np.bincount(cell, weights=units, minlength=n_cells)
    list_price = np.divide(np.bincount(cell, weights=base_rev, minlength=n_cells), qty_by_cell,
                           out=np.zeros(n_cells), where=qty_by_cell > 0)
    unit_cost = np.divide(np.bincount(cell, weights=cost, minlength=n_cells), qty_by_cell,
                          out=np.zeros(n_cells), where=qty_by_cell > 0)
    price = np.where(price > 0, price, list_price[cell])

    counterfactual = bool(store.counterfactual_base)
    base = base_q.astype(float) if counterfactual else _local_base(cell, widx, units, promoted)

    # Week within a run: consecutive weeks of the same offer in one cell.
    run_pos = np.zeros(len(units), dtype=np.int64)
    order = np.lexsort((widx, cell))
    prev_cell = prev_w = prev_promo = -1
    for i in order:
        if promoted[i]:
            same = cell[i] == prev_cell and widx[i] == prev_w + 1 and promo[i] == prev_promo
            run_pos[i] = run_pos[prev_i] + 1 if same else 1
        prev_cell, prev_w, prev_promo, prev_i = cell[i], widx[i], promo[i] if promoted[i] else -1, i

    slot_of = np.full((n_cells, len(weeks)), -1, dtype=np.int64)
    slot_of[cell, widx] = np.arange(len(units))

    return Slots(
        n=len(units), cell=cell, widx=widx, promo=promo, promoted=promoted, base=base,
        units=units.astype(float), price=price, sell_price=sell.astype(float), cost=cost.astype(float),
        promo_cost=pcost.astype(float), depth=depth, run_pos=run_pos, month=month,
        cells=cells, cell_channel=cell_channel, channels=channels, weeks=weeks,
        week_start=week_start, week_month=week_month, unit_cost=unit_cost, list_price=list_price,
        slot_of=slot_of, counterfactual=counterfactual,
    )


# --- the fitting table (the PDF's grain) ---------------------------------------


@dataclass
class FitTable:
    """Promoted sales at product x channel x week x offer: the grain the PDF
    fits B on ("more stable and far faster to sample than product x store")."""

    y: np.ndarray          # log(1 + u) = log(units / base)
    depth: np.ndarray      # list-value-weighted discount, a fraction
    group: np.ndarray      # pooling group (brand x channel)
    event: np.ndarray      # festival index, -1 on a regular week
    weight: np.ndarray     # slots in the row / mean slots per row
    widx: np.ndarray       # business week
    units: np.ndarray
    base: np.ndarray
    slots: np.ndarray      # product-store slots summed into the row
    year: np.ndarray


def _events(store: FactStore) -> tuple[list[str], np.ndarray]:
    """The festivals (seasonal offers by name, years dropped) and each
    promotion code's festival index (-1 for a regular offer)."""
    names = sorted({event_of(p.description or p.name) for p in store.promotions if p.type.lower() == "seasonal"})
    index = {n: i for i, n in enumerate(names)}
    table = np.array([index[event_of(p.description or p.name)] if p.type.lower() == "seasonal" else -1
                      for p in store.promotions], dtype=np.int64)
    return names, table


def _groups(slots: Slots, store: FactStore) -> tuple[list[tuple[str, str]], np.ndarray, list[str], np.ndarray]:
    """Pooling groups: brand x channel, every one the data holds (promoted or
    not -- a group with no promotions still gets a curve, from its brand).
    Returns the groups, each cell's group, the brands and each group's brand."""
    cell_brand = [store.products[p].brand for p, _ in slots.cells]
    keys = sorted({(b, slots.channels[slots.cell_channel[c]]) for c, b in enumerate(cell_brand)})
    gidx = {k: i for i, k in enumerate(keys)}
    cell_group = np.array([gidx[(b, slots.channels[slots.cell_channel[c]])] for c, b in enumerate(cell_brand)], dtype=np.int64)
    brands = sorted({b for b, _ in keys})
    bidx = {b: i for i, b in enumerate(brands)}
    group_brand = np.array([bidx[b] for b, _ in keys], dtype=np.int64)
    return keys, cell_group, brands, group_brand


def build_fit_table(slots: Slots, store: FactStore, cell_group: np.ndarray, event_table: np.ndarray) -> FitTable:
    use = slots.promoted & (slots.base > 0) & (slots.depth > 0.005)
    i = np.flatnonzero(use)
    cell_product = np.array([p for p, _ in slots.cells], dtype=np.int64)
    n_ch, n_w, n_p = len(slots.channels), len(slots.weeks), len(store.promotions)
    key = ((cell_product[slots.cell[i]] * n_ch + slots.cell_channel[slots.cell[i]]) * n_w + slots.widx[i]) * n_p + slots.promo[i]
    _, first, inv = np.unique(key, return_index=True, return_inverse=True)
    units = np.bincount(inv, weights=slots.units[i])
    base = np.bincount(inv, weights=slots.base[i])
    listv = np.bincount(inv, weights=slots.units[i] * slots.price[i])
    disc = np.bincount(inv, weights=slots.units[i] * (slots.price[i] - slots.sell_price[i]))
    n = np.bincount(inv).astype(float)
    ok = (units > 0) & (base > 0) & (listv > 0)
    depth = np.divide(disc, listv, out=np.zeros(len(listv)), where=listv > 0)
    ok &= depth > 0.005
    rows = i[first]
    years = np.array([w[0] for w in slots.weeks], dtype=np.int64)
    return FitTable(
        y=np.log(units[ok] / base[ok]), depth=depth[ok], group=cell_group[slots.cell[rows]][ok],
        event=event_table[slots.promo[rows]][ok], weight=n[ok] / n[ok].mean(), widx=slots.widx[rows][ok],
        units=units[ok], base=base[ok], slots=n[ok], year=years[slots.widx[rows]][ok],
    )


# --- component B: the hierarchical Bayesian response model ---------------------

#: x = d / DEPTH_UNIT keeps the coefficients near one for the sampler.
DEPTH_UNIT = 0.10
#: Sampler settings: the PDF's "4 chains x 1,000 draws"; ~1,000 for Monte Carlo.
CHAINS, WARMUP, DRAWS, MC_DRAWS = 4, 1000, 1000, 1000
#: Lighter settings for the two backtest refits.
BT_CHAINS, BT_WARMUP, BT_DRAWS = 2, 1000, 1000
SEED = 20261012
#: Bump to invalidate the posterior cache on disk.
MODEL_VERSION = "b-quadratic-nuts-1"
CACHE_DIR = Path(__file__).resolve().parents[2] / ".store" / "planner"


@dataclass
class Layout:
    """Where each parameter sits in the sampler's unconstrained vector."""

    B: int
    G: int
    E: int
    sl: dict[str, slice]
    dim: int

    @classmethod
    def of(cls, B: int, G: int, E: int) -> "Layout":
        sl: dict[str, slice] = {}
        i = 0
        for name, n in (("g0", 2), ("ltau", 2), ("zb", 2 * B), ("lsg", 2), ("ag", 2 * G),
                        ("mu", 1 if E else 0), ("lse", 1 if E else 0), ("ge", E), ("lsig", 1)):
            sl[name] = slice(i, i + n)
            i += n
        return cls(B=B, G=G, E=E, sl=sl, dim=i)


def _design(t: FitTable, G: int, E: int, k: float) -> np.ndarray:
    """One row per fit row: the group's two curve terms, then the event."""
    x = t.depth / DEPTH_UNIT
    X = np.zeros((len(t.y), 2 * G + E))
    r = np.arange(len(t.y))
    X[r, 2 * t.group] = x
    X[r, 2 * t.group + 1] = x * x - k * x
    fest = t.event >= 0
    X[r[fest], 2 * G + t.event[fest]] = 1.0
    return X


def _log_density(t: FitTable, lay: Layout, group_brand: np.ndarray, k: float):
    """log p(q | data) and its gradient, for

        y = a1[g] x + a2[g] (x^2 - k x) + gamma[event] + e,   x = d / 10%
        e ~ Normal(0, sigma / sqrt(w))           w = slots in the row, scaled
        a[g]      ~ Normal(a_brand[b(g)], s_g)   centred: groups are data-rich
        a_brand   = a_global + tau * z,  z ~ N(0, 1)   non-centred: 9 brands
        gamma[e]  ~ Normal(mu_e, s_e)            Dussehra borrows from Diwali
        a_global, mu_e ~ N(0, 1); tau, s_g, s_e ~ HalfNormal(0.5); sigma ~ HalfNormal(1)

    The (x, x^2 - kx) basis is the PDF's (d, d^2) curve rotated so its two
    coefficients are nearly uncorrelated -- the same curve, read back as
    beta1 = (a1 - k a2) / 10%, beta2 = a2 / 10%^2. The likelihood uses the
    design's sufficient statistics, exact for a Gaussian error."""
    B, G, E, sl = lay.B, lay.G, lay.E, lay.sl
    X = _design(t, G, E, k)
    W = t.weight
    XtWX = X.T @ (X * W[:, None])
    XtWy = X.T @ (W * t.y)
    yWy = float(np.dot(W * t.y, t.y))
    N = float(len(t.y))
    gb = group_brand

    def f(q: np.ndarray) -> tuple[float, np.ndarray]:
        grad = np.zeros_like(q)
        g0 = q[sl["g0"]]
        tau = np.exp(q[sl["ltau"]])
        zb = q[sl["zb"]].reshape(B, 2)
        sg = np.exp(q[sl["lsg"]])
        ag = q[sl["ag"]].reshape(G, 2)
        sig = math.exp(q[sl["lsig"]][0])
        bb = g0 + tau * zb
        theta = ag.ravel()
        if E:
            mu = q[sl["mu"]][0]
            se = math.exp(q[sl["lse"]][0])
            ge = q[sl["ge"]]
            theta = np.concatenate([theta, ge])
        Ht = XtWX @ theta
        rss = max(yWy - 2.0 * float(theta @ XtWy) + float(theta @ Ht), 0.0)
        gth = (XtWy - Ht) / sig ** 2
        lp = -N * math.log(sig) - rss / (2 * sig ** 2)
        g_lsig = -N + rss / sig ** 2
        # Groups around their brand.
        dev = ag - bb[gb]
        lp += -0.5 * float(np.sum(dev ** 2 / sg ** 2)) - G * float(np.sum(np.log(sg)))
        g_ag = gth[:2 * G].reshape(G, 2) - dev / sg ** 2
        g_bb = np.zeros((B, 2))
        np.add.at(g_bb, gb, dev / sg ** 2)
        g_lsg = np.sum(dev ** 2, axis=0) / sg ** 2 - G
        lp += float(np.sum(-sg ** 2 / 0.5 + np.log(sg)))
        g_lsg += -sg ** 2 / 0.25 + 1
        # Brands around the global curve (non-centred).
        lp += -0.5 * float(np.sum(zb ** 2)) - 0.5 * float(np.sum(g0 ** 2))
        g_zb = g_bb * tau - zb
        g_ltau = np.sum(g_bb * zb, axis=0) * tau
        lp += float(np.sum(-tau ** 2 / 0.5 + np.log(tau)))
        g_ltau += -tau ** 2 / 0.25 + 1
        g_g0 = np.sum(g_bb, axis=0) - g0
        # Festivals around one festival level.
        if E:
            de = ge - mu
            lp += -0.5 * float(np.sum(de ** 2)) / se ** 2 - E * math.log(se) - 0.5 * mu ** 2
            lp += -se ** 2 / 0.5 + math.log(se)
            grad[sl["ge"]] = gth[2 * G:] - de / se ** 2
            grad[sl["mu"]] = float(np.sum(de)) / se ** 2 - mu
            grad[sl["lse"]] = float(np.sum(de ** 2)) / se ** 2 - E - se ** 2 / 0.25 + 1
        lp += -sig ** 2 / 2 + math.log(sig)
        g_lsig += -sig ** 2 + 1
        grad[sl["g0"]] = g_g0
        grad[sl["ltau"]] = g_ltau
        grad[sl["zb"]] = g_zb.ravel()
        grad[sl["lsg"]] = g_lsg
        grad[sl["ag"]] = g_ag.ravel()
        grad[sl["lsig"]] = g_lsig
        return lp, grad

    return f, X


def _init(t: FitTable, lay: Layout, X: np.ndarray) -> np.ndarray:
    """A sensible start: least squares with a little ridge, scales at 0.1."""
    q = np.zeros(lay.dim)
    W = t.weight
    A = X.T @ (X * W[:, None]) + 1e-3 * np.eye(X.shape[1])
    theta = np.linalg.solve(A, X.T @ (W * t.y))
    G, E = lay.G, lay.E
    ag = theta[:2 * G].reshape(G, 2)
    q[lay.sl["ag"]] = ag.ravel()
    q[lay.sl["g0"]] = ag.mean(axis=0)
    q[lay.sl["ltau"]] = math.log(0.1)
    q[lay.sl["lsg"]] = math.log(0.1)
    if E:
        ge = theta[2 * G:]
        q[lay.sl["ge"]] = ge
        q[lay.sl["mu"]] = float(ge.mean())
        q[lay.sl["lse"]] = math.log(max(float(ge.std()), 0.05))
    resid = t.y - X @ theta
    q[lay.sl["lsig"]] = math.log(max(float(np.sqrt(np.average(resid ** 2, weights=W))), 0.02))
    return q


@dataclass
class Posterior:
    beta1: np.ndarray     # draws x groups, per unit of depth (fraction)
    beta2: np.ndarray     # draws x groups
    gamma: np.ndarray     # draws x events
    sigma: np.ndarray     # draws
    diagnostics: dict[str, Any]


def _sample(t: FitTable, B: int, G: int, E: int, group_brand: np.ndarray, *,
            chains: int, warmup: int, draws: int, keep: int, seed: int) -> Posterior:
    from app.tpo.nuts import diagnostics, run_nuts

    x = t.depth / DEPTH_UNIT
    k = float(np.sum(t.weight * x ** 3) / np.sum(t.weight * x ** 2)) if len(x) else 0.0
    lay = Layout.of(B, G, E)
    f, X = _log_density(t, lay, group_brand, k)
    q0 = _init(t, lay, X)
    raw, results = run_nuts(f, q0, chains=chains, warmup=warmup, draws=draws, seed=seed, jitter=0.2)
    diag = diagnostics(raw, results)
    flat = raw.reshape(-1, lay.dim)
    take = np.linspace(0, len(flat) - 1, min(keep, len(flat))).round().astype(int)
    flat = flat[take]
    ag = flat[:, lay.sl["ag"]].reshape(len(flat), G, 2)
    a1, a2 = ag[:, :, 0], ag[:, :, 1]
    beta1 = (a1 - k * a2) / DEPTH_UNIT
    beta2 = a2 / DEPTH_UNIT ** 2
    gamma = flat[:, lay.sl["ge"]] if E else np.zeros((len(flat), 0))
    sigma = np.exp(flat[:, lay.sl["lsig"]][:, 0])
    g0 = flat[:, lay.sl["g0"]]
    diag["global_beta1"] = round(float(np.median((g0[:, 0] - k * g0[:, 1]) / DEPTH_UNIT)), 3)
    diag["global_beta2"] = round(float(np.median(g0[:, 1] / DEPTH_UNIT ** 2)), 3)
    diag["parameters"] = lay.dim
    return Posterior(beta1=beta1, beta2=beta2, gamma=gamma, sigma=sigma, diagnostics=diag)


def _eta(post: Posterior, group: np.ndarray, depth: np.ndarray, event: np.ndarray) -> np.ndarray:
    """log(1 + u) per draw (rows) and per key (columns), before noise."""
    d = depth[None, :]
    eta = post.beta1[:, group] * d + post.beta2[:, group] * d * d
    fest = event >= 0
    if fest.any() and post.gamma.shape[1]:
        eta[:, fest] += post.gamma[:, event[fest]]
    return eta


@dataclass
class ResponseModel:
    """B's posterior, ready to price any (product-store, depth, offer)."""

    post: Posterior
    groups: list[tuple[str, str]]
    brands: list[str]
    events: list[str]
    event_table: np.ndarray       # promotion code -> festival index (-1 regular)
    cell_group: np.ndarray
    cell_brand: list[str]
    cell_promoted: np.ndarray     # the data has seen this product-store promoted
    max_lift: float
    depth_max: float
    regular_depths: tuple[float, float]
    n_rows: int                   # fit rows (product x channel x week x offer)
    n_regular: int
    n_festival: int
    n_slots: int                  # product-store weeks behind them
    mean_row_slots: float
    backtest: dict[str, Any] = field(default_factory=dict)
    #: The last few evaluations: a scan point prices the same slots for its
    #: mean and for its draws.
    _memo: dict[bytes, tuple[np.ndarray, np.ndarray]] = field(default_factory=dict, repr=False, compare=False)

    @property
    def draws(self) -> int:
        return len(self.post.sigma)

    def _keys(self, cell: np.ndarray, depth: np.ndarray, event: np.ndarray):
        g = self.cell_group[cell]
        dq = np.round(depth * 1e4).astype(np.int64)
        key = (g * (len(self.events) + 1) + (event + 1)) * 100_001 + dq
        uniq, first, inv = np.unique(key, return_index=True, return_inverse=True)
        return g[first], dq[first] / 1e4, event[first], inv

    def lift_draws(self, cell: np.ndarray, depth: np.ndarray, event: np.ndarray) -> tuple[np.ndarray, np.ndarray]:
        """Expected lift u per posterior draw for every distinct (group, depth,
        festival) among the slots: (draws x keys, the slots' key index).
        Each draw's lift is the mean over its noise -- exp(eta + sigma^2/2) - 1 --
        capped at the largest lift the data shows."""
        cell = np.ascontiguousarray(cell, dtype=np.int64)
        depth = np.ascontiguousarray(depth, dtype=np.float64)
        event = np.ascontiguousarray(event, dtype=np.int64)
        h = hashlib.blake2b(cell.tobytes(), digest_size=16)
        h.update(depth.tobytes())
        h.update(event.tobytes())
        key = h.digest()
        hit = self._memo.get(key)
        if hit is not None:
            return hit
        g, d, e, inv = self._keys(cell, depth, event)
        eta = _eta(self.post, g, d.astype(np.float32), e)
        u = np.exp(eta + np.float32(0.5) * self.post.sigma[:, None] ** 2) - np.float32(1.0)
        np.clip(u, 0.0, self.max_lift, out=u)
        u[:, d <= 0] = 0.0
        if len(self._memo) >= 4:
            self._memo.pop(next(iter(self._memo)))
        self._memo[key] = (u, inv)
        return u, inv

    def lift(self, cell: np.ndarray, depth: np.ndarray, event: np.ndarray) -> np.ndarray:
        """The posterior expected lift of each slot: the mean over draws."""
        if not len(cell):
            return np.zeros(0)
        u, inv = self.lift_draws(cell, depth, event)
        return u.mean(axis=0, dtype=np.float64)[inv]

    def lift_point(self, cell: np.ndarray, depth: np.ndarray, event: np.ndarray) -> np.ndarray:
        """log(1 + u) at the posterior mean, per slot: the centre the noise
        spreads around (for the Monte Carlo's noise term)."""
        u, inv = self.lift_draws(cell, depth, event)
        return np.log1p(u.mean(axis=0))[inv]


def event_index_for(model: ResponseModel, promo_codes: np.ndarray) -> np.ndarray:
    """Festival index of each promotion code (-1 for a regular offer)."""
    return model.event_table[np.asarray(promo_codes, dtype=np.int64)]


# --- validation -----------------------------------------------------------------


def _predictive(post: Posterior, t: FitTable, rows: np.ndarray, rng: np.random.Generator):
    """Predicted units for `rows`: the posterior mean and per-draw predictive
    samples (parameter + noise), draws x rows."""
    eta = _eta(post, t.group[rows], t.depth[rows], t.event[rows])
    noise = rng.standard_normal(eta.shape) * (post.sigma[:, None] / np.sqrt(t.weight[rows])[None, :])
    sample = t.base[rows][None, :] * np.exp(eta + noise)
    mean = t.base[rows] * np.exp(eta + 0.5 * post.sigma[:, None] ** 2 / t.weight[rows][None, :]).mean(axis=0)
    return mean, sample


def _time_holdout(t: FitTable, n_weeks: int, B: int, G: int, E: int, gb: np.ndarray) -> dict[str, Any]:
    """Fit on the first 80% of weeks, predict the promoted rows after."""
    cut = int(n_weeks * 0.8)
    train = t.widx < cut
    test = np.flatnonzero(~train)
    if len(test) < 30 or train.sum() < 100:
        return {}
    post = _sample(_subset(t, train), B, G, E, gb, chains=BT_CHAINS, warmup=BT_WARMUP,
                   draws=BT_DRAWS, keep=BT_CHAINS * BT_DRAWS, seed=SEED + 1)
    rng = np.random.default_rng(SEED + 11)
    pred, sample = _predictive(post, t, test, rng)
    act, base = t.units[test], t.base[test]
    lo, hi = np.quantile(sample, 0.1, axis=0), np.quantile(sample, 0.9, axis=0)
    inc_act, inc_pred = act - base, pred - base
    return {
        "holdout_from_week": int(cut),
        "holdout_rows": int(len(test)),
        "wape_units_pct": round(float(np.abs(pred - act).sum() / act.sum() * 100), 2),
        "wape_incremental_pct": round(float(np.abs(inc_pred - inc_act).sum() / np.abs(inc_act).sum() * 100), 2),
        "bias_incremental_pct": round(float((inc_pred.sum() - inc_act.sum()) / inc_act.sum() * 100), 2),
        "band_coverage_pct": round(float(((act >= lo) & (act <= hi)).mean() * 100), 2),
        "rhat_max": post.diagnostics["rhat_max"],
        "divergences": post.diagnostics["divergences"],
    }


def _festival_holdout(t: FitTable, events: list[str], B: int, G: int, E: int, gb: np.ndarray) -> dict[str, Any]:
    """The PDF's backtest: hold out the latest Diwali and Dussehra, refit,
    and compare the predicted uplift with the actual."""
    if not E:
        return {}
    if not (t.event >= 0).any():
        return {}
    named = [i for i, n in enumerate(events) if any(w in n.lower() for w in ("diwali", "dussehra"))]
    if not named:
        counts = np.bincount(t.event[t.event >= 0], minlength=E)
        named = [int(i) for i in np.argsort(-counts)[:2] if counts[i] > 0]
    # Each festival's own latest occurrence that an earlier one can be
    # compared with (Diwali 2025 against Diwali 2024).
    latest = {e: int(t.year[t.event == e].max()) for e in named if (t.event == e).any()}
    named = [e for e in named if e in latest and (t.year[t.event == e] < latest[e]).any()]
    hold = np.zeros(len(t.y), dtype=bool)
    for e in named:
        hold |= (t.event == e) & (t.year == latest[e])
    if hold.sum() < 10:
        return {}
    post = _sample(_subset(t, ~hold), B, G, E, gb, chains=BT_CHAINS, warmup=BT_WARMUP,
                   draws=BT_DRAWS, keep=BT_CHAINS * BT_DRAWS, seed=SEED + 2)
    rng = np.random.default_rng(SEED + 12)
    out = []
    for e in named:
        rows = np.flatnonzero(hold & (t.event == e))
        if not len(rows):
            continue
        _, sample = _predictive(post, t, rows, rng)
        base = t.base[rows].sum()
        lift = sample.sum(axis=1) / base - 1          # per draw, the event's total uplift
        actual = float(t.units[rows].sum() / base - 1)
        p10, p50, p90 = (float(v) for v in np.quantile(lift, [0.1, 0.5, 0.9]))
        out.append({"event": events[e], "year": latest[e], "rows": int(len(rows)),
                    "actual_uplift_pct": round(actual * 100, 2), "predicted_uplift_pct": round(p50 * 100, 2),
                    "p10_pct": round(p10 * 100, 2), "p90_pct": round(p90 * 100, 2),
                    "within_band": bool(p10 <= actual <= p90)})
    return {"events": out, "rhat_max": post.diagnostics["rhat_max"], "divergences": post.diagnostics["divergences"]}


def _subset(t: FitTable, mask: np.ndarray) -> FitTable:
    kw = {f: getattr(t, f)[mask] for f in t.__dataclass_fields__}
    w = kw["slots"]
    kw["weight"] = w / w.mean()
    return FitTable(**kw)


# --- the fit, cached on disk ------------------------------------------------------


def _fingerprint(t: FitTable, groups: list[tuple[str, str]], events: list[str], gb: np.ndarray) -> str:
    h = hashlib.sha1()
    for a in (t.y, t.depth, t.group, t.event, t.weight, t.widx, t.year, gb):
        h.update(np.ascontiguousarray(a).tobytes())
    h.update(json.dumps([groups, events, MODEL_VERSION, CHAINS, WARMUP, DRAWS, MC_DRAWS, BT_CHAINS,
                         BT_WARMUP, BT_DRAWS, SEED]).encode())
    return h.hexdigest()[:16]


def _load(path: Path) -> tuple[Posterior, dict[str, Any]] | None:
    try:
        with np.load(path, allow_pickle=False) as z:
            meta = json.loads(str(z["meta"]))
            post = Posterior(beta1=z["beta1"], beta2=z["beta2"], gamma=z["gamma"], sigma=z["sigma"],
                             diagnostics=meta["diagnostics"])
            return post, meta["backtest"]
    except Exception:
        return None


def _save(path: Path, post: Posterior, backtest: dict[str, Any]) -> None:
    try:
        path.parent.mkdir(parents=True, exist_ok=True)
        tmp = path.with_suffix(".tmp.npz")
        np.savez_compressed(tmp, beta1=post.beta1, beta2=post.beta2, gamma=post.gamma, sigma=post.sigma,
                            meta=np.array(json.dumps({"diagnostics": post.diagnostics, "backtest": backtest})))
        tmp.replace(path)
    except OSError:
        log.warning("Could not cache the planner posterior at %s", path)


def fit_response(slots: Slots, store: FactStore) -> ResponseModel:
    events, event_table = _events(store)
    groups, cell_group, brands, group_brand = _groups(slots, store)
    t = build_fit_table(slots, store, cell_group, event_table)
    if len(t.y) < 20:
        raise ValueError("Too few promoted weeks to fit the response model.")
    B, G, E = len(brands), len(groups), len(events)
    path = CACHE_DIR / f"posterior-{_fingerprint(t, groups, events, group_brand)}.npz"
    cached = _load(path)
    if cached is not None:
        post, backtest = cached
        post.diagnostics.setdefault("seconds", None)
    else:
        t0 = time.time()
        post = _sample(t, B, G, E, group_brand, chains=CHAINS, warmup=WARMUP, draws=DRAWS, keep=MC_DRAWS, seed=SEED)
        post.diagnostics["seconds"] = round(time.time() - t0, 1)
        log.info("Planner response model sampled in %.1fs: %s", time.time() - t0, post.diagnostics)
        backtest = {"time": _time_holdout(t, len(slots.weeks), B, G, E, group_brand),
                    "festival": _festival_holdout(t, events, B, G, E, group_brand)}
        _save(path, post, backtest)

    u_obs = np.divide(slots.units - slots.base, slots.base, out=np.zeros(slots.n), where=slots.base > 0)
    use = slots.promoted & (slots.base > 0)
    # Draws in single precision: the per-draw lift is an exponential over
    # draws x keys; totals are summed in double precision downstream.
    post = Posterior(beta1=post.beta1.astype(np.float32), beta2=post.beta2.astype(np.float32),
                     gamma=post.gamma.astype(np.float32), sigma=post.sigma.astype(np.float32),
                     diagnostics=post.diagnostics)
    reg_depths = t.depth[t.event < 0]
    cell_promoted = np.bincount(slots.cell[slots.promoted], minlength=len(slots.cells)) > 0
    return ResponseModel(
        post=post, groups=groups, brands=brands, events=events, event_table=event_table,
        cell_group=cell_group, cell_brand=[store.products[p].brand for p, _ in slots.cells],
        cell_promoted=cell_promoted,
        max_lift=float(np.max(u_obs[use])) if use.any() else 3.0,
        depth_max=float(np.max(slots.depth[use])) if use.any() else 0.25,
        regular_depths=(float(reg_depths.min()), float(reg_depths.max())) if len(reg_depths) else (0.05, 0.15),
        n_rows=int(len(t.y)), n_regular=int((t.event < 0).sum()), n_festival=int((t.event >= 0).sum()),
        n_slots=int(t.slots.sum()), mean_row_slots=float(t.slots.mean()),
        backtest=backtest,
    )


# --- the planner's fitted bundle --------------------------------------------------


@dataclass
class Fitted:
    store: FactStore
    slots: Slots
    model: ResponseModel
    #: Share of a promotion's extra units taken from sister packs, per brand
    #: (the Insights Hub's cannibalization rate, as a fraction).
    cannibalization: dict[str, float]
    promo_cost_rate: float


def _cannibalization_rates(slots: Slots, store: FactStore) -> dict[str, float]:
    """Sister-pack margin lost per unit of a promotion's extra margin, per brand.

    CALIBRATED TO THE INSIGHTS HUB. The rate is the Hub's measured
    cannibalized margin for the brand (`aggregate.cannibalization_detail`)
    over the margin the brand's promoted extra units carried, across the
    whole dataset -- so the planner's promotion profit on history is the
    Hub's Net Incremental Profit, not a second estimate of it."""
    from app.tpo import aggregate as A
    from app.tpo.filters import FilterState, rows_for

    detail = A.cannibalization_detail(rows_for(FilterState()))
    lost: dict[str, float] = {}
    for e in detail.get("events") or []:
        lost[e["brand_form"]] = lost.get(e["brand_form"], 0.0) + float(e["cannibalized_margin"])
    promoted = slots.promoted
    extra = (slots.units - slots.base) * np.maximum(slots.price - slots.unit_cost[slots.cell], 0.0)
    brands = np.array([store.products[slots.cells[c][0]].brand for c in range(len(slots.cells))])
    brand_of = brands[slots.cell[promoted]]
    out: dict[str, float] = {}
    for b in set(brand_of):
        carried = float(extra[promoted][brand_of == b].sum())
        if carried > 0 and lost.get(b):
            out[str(b)] = lost[b] / carried
    return out


_lock = threading.Lock()


@lru_cache(maxsize=1)
def _fitted_for(store_id: int) -> Fitted:
    store = get_store()
    slots = build_slots(store)
    model = fit_response(slots, store)
    promoted = slots.promoted
    list_value = float((slots.units[promoted] * slots.price[promoted]).sum())
    rate = float(slots.promo_cost[promoted].sum() / list_value) if list_value > 0 else 0.03
    try:
        canni = _cannibalization_rates(slots, store)
    except Exception:  # a dataset without pack-size neighbours
        canni = {}
    return Fitted(store=store, slots=slots, model=model, cannibalization=canni, promo_cost_rate=rate)


def fitted() -> Fitted:
    """The slot table and the fitted model for the loaded dataset, cached for
    as long as that dataset is (`get_store` is cleared on a new upload). The
    first call samples the posterior (or reads it from disk); a lock keeps two
    first requests from sampling twice."""
    with _lock:
        return _fitted_for(id(get_store()))


def clear() -> None:
    _fitted_for.cache_clear()


__all__ = ["Fitted", "ResponseModel", "Slots", "event_index_for", "event_of", "fitted", "NO_PROMOTION"]
