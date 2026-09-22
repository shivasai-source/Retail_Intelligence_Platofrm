"""Simulation Studio -- three levers, one window, two KPIs.

THE QUESTION. "If I run this scope at discount d, with a trade-spend budget S,
for N days -- what happens to Revenue and to ROI over those N days?"

THE SHAPE. The studio never computes a KPI of its own. It decides WHICH ROWS
exist in the window and what quantity each carries, then hands those rows to
the validated engine in `app/tpo/aggregate.py` -- the same functions the
Insights Hub cards call. Revenue is the engine's own Sum(Actual_Revenue) (the
numerator of `calculate_margin`); Trade Spend is `calculate_trade_spend`;
Incremental Sales is `calculate_incremental_sales`; ROI is `calculate_roi`,
the IS / TS multiple at two decimals. None of those definitions is restated
here, and none is changed.

THE THREE LEVERS, and what each one physically does:

  discount_pct   The price cut. It sets the promoted price P(1 - d) and, via
                 the LIFT MODEL below, the volume uplift. Continuous, bounded
                 by the depths the data actually shows (plus a small margin).

  days           The window. N days is N/7 business weeks; a partial week is
                 pro-rated by its fraction, because this dataset is only
                 knowable at week grain (see `loader.Dimensions.week_start`).
                 A week-in-promotion fade and a post-promotion dip are BOTH
                 estimated from the data and applied only when detected.

  trade_spend    The budget. Discount and days set what promoting the WHOLE
                 scope for the window would cost (the engine's Trade Spend on
                 those rows); the budget sets how much of the scope can be
                 funded -- `coverage = min(1, S / full_cost)`. The uncovered
                 share trades at its ordinary level. Spend is therefore still
                 an OUTPUT of the promotion arithmetic (b(1+u)P(d+c)) -- the
                 slider decides how much of the scope that arithmetic applies
                 to, never the arithmetic itself.

THE LIFT MODEL. A response curve FITTED to the promoted rows the dataset
holds: for each promoted (product, channel, week, offer) row the observed
depth d and the observed uplift u against that (product, channel)'s
non-promotional baseline -- the baseline rule `aggregate._volume` uses, not a
second one -- and a weighted least-squares fit of

    log(1 + u) = b1 * d + b2 * d^2        (through the origin: no discount, no lift)

The quadratic term lets the curve saturate, which the data shows it does.
The band around it is the 10th-90th percentile of the residuals, so a wide
scatter in the evidence reads as a wide band on screen. Where a scope holds
too few promoted rows to fit, the fit falls back to the whole dataset, and
only if THAT is too thin to the approved treatment rules in `config` -- and
`model.provenance` says which one was used on every response.

WHAT IT DOES NOT INVENT. No display or feature effect (no data), no
cannibalization response (the approved rules define none; the engine can
still measure it), no daily distribution inside a week, no seasonality for a
window that has no calendar position. The fade and the dip are reported with
the evidence they were estimated from, including when that evidence says
they are zero.
"""

from __future__ import annotations

import dataclasses
import math
import statistics
from collections import defaultdict
from dataclasses import dataclass
from functools import lru_cache
from typing import Any, Sequence

from app.tpo import aggregate as A
from app.tpo import config
from app.tpo import formatting as F
from app.tpo.filters import FilterState, baseline_rows_for, rows_for

#: The window's grain. Days below a week are a fraction of one.
DAYS_PER_WEEK = 7
MIN_DAYS = 1
#: Five business weeks -- the longest run any promotion in the data holds is
#: five weeks, and the model has no evidence past it.
MAX_DAYS = 35

#: Promoted observations a fit needs before it is trusted. Below this the fit
#: falls back (scope -> whole dataset -> approved rules).
MIN_FIT_EVENTS = 40
#: ...and they must span at least this many distinct depths, or the quadratic
#: is undetermined.
MIN_FIT_DEPTHS = 2
#: How far past the deepest observed discount the slider may go.
DOMAIN_MARGIN_PCT = 5.0
#: The slider step. Half a point: fine enough to feel continuous, coarse
#: enough that every position is a distinct, displayable value at one decimal.
DISCOUNT_STEP_PCT = 0.5
#: |t| a fade or dip coefficient needs before it is applied. Two standard
#: errors -- conventional, and stated here so it is not a hidden threshold.
EFFECT_T_THRESHOLD = 2.0

#: Coverage this close to 1 is reported as full coverage -- see `simulate`.
BINDING_TOLERANCE = 0.005

PROVENANCE_FITTED = "fitted"
PROVENANCE_DATASET = "fitted_dataset_wide"
PROVENANCE_RULES = "approved_rules"

#: The synthetic week keys a window carries. `WeekRow.year` reads the first
#: four characters; "SIM0" never collides with a real year.
_WINDOW_WEEK_PREFIX = "SIM0-W"


class NothingToSimulate(ValueError):
    """The scope holds no (product, channel) with a non-promoted week to base
    a scenario on. Not a zeroed result: nothing here could be measured."""


class LeverOutOfRange(ValueError):
    """A lever value the model has no evidence for."""


# --- the lift model --------------------------------------------------------


@dataclass(frozen=True)
class LiftModel:
    provenance: str
    #: log(1 + u) = b1 * d + b2 * d^2, with d a FRACTION.
    b1: float
    b2: float
    #: 10th / 90th percentile of the log residuals -- the band.
    resid_low: float
    resid_high: float
    n_events: int
    n_depths: int
    r_squared: float | None
    #: Observed depth range, PERCENT.
    depth_min_pct: float
    depth_max_pct: float
    #: Multiplicative change in log-lift per additional week in promotion.
    #: Zero unless the data showed one.
    fade_per_week: float
    fade_detected: bool
    fade_t: float | None
    fade_runs: int
    #: Post-promotion week's volume relative to baseline, as a fraction.
    #: Zero unless the data showed one.
    dip: float
    dip_detected: bool
    dip_t: float | None
    dip_events: int
    #: CALIBRATION. The depth curve is SCALED so that, at the depths this scope
    #: actually ran, it reproduces the lift this scope actually measured -- the
    #: ratio of the scope's observed log-lift to the fitted log-lift, weighted
    #: by transactions. A pooled curve then passes through the scope's own
    #: level, and the "current plan" the studio replays at the observed depth
    #: comes back with the figures the Insights Hub and Promotion Intelligence
    #: measured for it. A scale rather than a shift, so no discount still means
    #: no lift and a shallow depth can never be pushed below it. 1.0 when the
    #: scope holds no promoted week to calibrate on.
    scale: float = 1.0
    calibration_events: int = 0

    @property
    def domain_max_pct(self) -> float:
        return round(self.depth_max_pct + DOMAIN_MARGIN_PCT, 2)

    def log_lift(self, discount_pct: float, week_index: int = 1) -> float:
        d = discount_pct / 100.0
        return self.scale * (self.b1 * d + self.b2 * d * d) + self.fade_per_week * (week_index - 1)

    def lift(self, discount_pct: float, week_index: int = 1) -> tuple[float, float, float]:
        """(low, mid, high) uplift FRACTIONS for a depth in week `week_index`.
        Zero discount is zero lift by construction, band included."""
        if discount_pct <= 0:
            return (0.0, 0.0, 0.0)
        centre = self.log_lift(discount_pct, week_index)
        return (
            max(-1.0, math.expm1(centre + self.resid_low)),
            math.expm1(centre),
            math.expm1(centre + self.resid_high),
        )

    def as_dict(self) -> dict[str, Any]:
        return {
            "provenance": self.provenance,
            "form": "log(1 + uplift) = b1 * d + b2 * d^2",
            "coefficients": {"b1": round(self.b1, 4), "b2": round(self.b2, 4)},
            "residual_band": {"low": round(self.resid_low, 4), "high": round(self.resid_high, 4)},
            "n_events": self.n_events,
            "n_depths": self.n_depths,
            "r_squared": None if self.r_squared is None else round(self.r_squared, 3),
            "depth_observed_pct": {"min": self.depth_min_pct, "max": self.depth_max_pct},
            "depth_domain_pct": {"min": 0.0, "max": self.domain_max_pct},
            "fade": {
                "per_week": round(self.fade_per_week, 4),
                "detected": self.fade_detected,
                "t": None if self.fade_t is None else round(self.fade_t, 2),
                "runs": self.fade_runs,
            },
            "post_promotion_dip": {
                "fraction": round(self.dip, 4),
                "detected": self.dip_detected,
                "t": None if self.dip_t is None else round(self.dip_t, 2),
                "events": self.dip_events,
            },
            "calibration": {"scale": round(self.scale, 4), "events": self.calibration_events},
            "notes": _model_notes(self),
        }


def _model_notes(m: LiftModel) -> list[str]:
    notes: list[str] = []
    if m.provenance == PROVENANCE_FITTED:
        notes.append(
            f"Lift curve fitted to {m.n_events} promoted product-channel-weeks in this scope, "
            f"spanning {m.n_depths} discount depths ({m.depth_min_pct:.2f}%-{m.depth_max_pct:.2f}%)."
        )
    elif m.provenance == PROVENANCE_DATASET:
        notes.append(
            f"This scope holds too few promoted weeks to fit on its own; the lift curve is fitted "
            f"to the whole dataset ({m.n_events} promoted product-channel-weeks, "
            f"{m.depth_min_pct:.2f}%-{m.depth_max_pct:.2f}%)."
        )
    else:
        notes.append(
            "Too few promoted weeks anywhere in the data to fit a curve; the lift curve is drawn "
            "through the approved treatment rules in config instead, and the band is those "
            "rules' own bands."
        )
    if m.calibration_events:
        notes.append(
            f"Calibrated to this scope's own {m.calibration_events} measured promoted "
            f"week{'' if m.calibration_events == 1 else 's'}: the curve is scaled by "
            f"{m.scale:.2f} so that at the depth this scope ran it reproduces the lift the "
            "scope actually measured."
        )
    if m.fade_detected:
        notes.append(
            f"Lift changes by {m.fade_per_week * 100:+.1f}% (log) per additional week in "
            f"promotion, estimated from {m.fade_runs} second-and-later promoted weeks; applied."
        )
    else:
        notes.append(
            f"No week-in-promotion fade detected across {m.fade_runs} second-and-later promoted "
            "weeks once depth is accounted for; lift is held flat across the window."
        )
    if m.dip_detected:
        notes.append(
            f"The week after a promotion trades at {m.dip * 100:+.1f}% of baseline "
            f"({m.dip_events} events); applied after the window."
        )
    else:
        notes.append(
            f"No post-promotion dip detected ({m.dip_events} post-promotion weeks); "
            "nothing is deducted after the window."
        )
    notes.append(
        f"The discount slider runs to {m.domain_max_pct:.2f}%: the deepest observed depth "
        f"plus {DOMAIN_MARGIN_PCT:.0f} points. Nothing beyond it has evidence."
    )
    return notes


def _baselines(rows: Sequence[A.WeekRow]) -> dict[tuple[str, str], float]:
    """Each (product, channel)'s baseline: mean Base_Quantity per transaction
    over its non-promoted rows -- THE rule `aggregate._volume` applies, stated
    identically so a scenario is re-based on exactly what the engine measures
    against. `tests/test_studio.py` asserts the two agree."""
    acc: dict[tuple[str, str], list[float]] = defaultdict(lambda: [0.0, 0.0])
    for r in rows:
        if not r.is_promoted:
            a = acc[r.baseline_key]
            a[0] += r.base_quantity
            a[1] += r.transaction_count
    return {k: v[0] / v[1] for k, v in acc.items() if v[1]}


@dataclass(frozen=True)
class _Observation:
    depth: float          # fraction
    log_lift: float
    weight: float
    week_in_run: int


def _observations(rows: Sequence[A.WeekRow], baselines: dict[tuple[str, str], float]) -> list[_Observation]:
    """One observation per promoted row: its depth and its log-uplift against
    its own baseline, with its position inside a run of consecutive promoted
    weeks under the same offer."""
    by_key: dict[tuple[str, str], dict[str, A.WeekRow]] = defaultdict(dict)
    for r in rows:
        by_key[r.baseline_key][r.week_key] = r
    order = {w: i for i, w in enumerate(sorted({r.week_key for r in rows}))}

    out: list[_Observation] = []
    for key, by_week in by_key.items():
        b = baselines.get(key)
        if not b:
            continue
        weeks = sorted(by_week, key=lambda w: order[w])
        run_index = 0
        previous: A.WeekRow | None = None
        for w in weeks:
            r = by_week[w]
            if not r.is_promoted or not r.transaction_count or r.actual_quantity <= 0:
                run_index = 0
                previous = r
                continue
            consecutive = (
                previous is not None and previous.is_promoted
                and previous.promotion_id == r.promotion_id
                and order[w] == order[previous.week_key] + 1
            )
            run_index = run_index + 1 if consecutive else 1
            list_revenue = r.actual_revenue + r.discount_value
            if list_revenue <= 0:
                previous = r
                continue
            depth = r.discount_value / list_revenue
            ratio = r.actual_quantity / (b * r.transaction_count)
            if depth <= 0 or ratio <= 0:
                previous = r
                continue
            out.append(_Observation(depth, math.log(ratio), float(r.transaction_count), run_index))
            previous = r
    return out


def _post_promotion_ratios(rows: Sequence[A.WeekRow], baselines: dict[tuple[str, str], float]) -> list[float]:
    """log(volume / baseline) for every non-promoted week that immediately
    follows a promoted one -- the evidence for a post-promotion dip."""
    by_key: dict[tuple[str, str], dict[str, A.WeekRow]] = defaultdict(dict)
    for r in rows:
        by_key[r.baseline_key][r.week_key] = r
    order = {w: i for i, w in enumerate(sorted({r.week_key for r in rows}))}
    out: list[float] = []
    for key, by_week in by_key.items():
        b = baselines.get(key)
        if not b:
            continue
        weeks = sorted(by_week, key=lambda w: order[w])
        for prev_w, w in zip(weeks, weeks[1:]):
            prev, cur = by_week[prev_w], by_week[w]
            if prev.is_promoted and not cur.is_promoted and order[w] == order[prev_w] + 1:
                if cur.transaction_count and cur.actual_quantity > 0:
                    out.append(math.log(cur.actual_quantity / (b * cur.transaction_count)))
    return out


def _wls_quadratic(obs: Sequence[_Observation]) -> tuple[float, float]:
    """Weighted least squares for y = b1 d + b2 d^2 through the origin.
    Two normal equations, solved directly -- no library, nothing hidden."""
    s11 = s12 = s22 = t1 = t2 = 0.0
    for o in obs:
        d, d2, w = o.depth, o.depth * o.depth, o.weight
        s11 += w * d * d
        s12 += w * d * d2
        s22 += w * d2 * d2
        t1 += w * d * o.log_lift
        t2 += w * d2 * o.log_lift
    det = s11 * s22 - s12 * s12
    if abs(det) < 1e-18:
        # Collinear (one depth): fall back to the linear term alone.
        return (t1 / s11 if s11 else 0.0), 0.0
    return (t1 * s22 - t2 * s12) / det, (t2 * s11 - t1 * s12) / det


def _weighted_quantile(values: Sequence[float], weights: Sequence[float], q: float) -> float:
    pairs = sorted(zip(values, weights))
    total = sum(weights)
    if total <= 0:
        return 0.0
    cumulative = 0.0
    for v, w in pairs:
        cumulative += w
        if cumulative / total >= q:
            return v
    return pairs[-1][0]


def _slope_t(xs: Sequence[float], ys: Sequence[float]) -> tuple[float, float | None]:
    """OLS slope of y on x and its t statistic. (0, None) when undetermined."""
    n = len(xs)
    if n < 3:
        return 0.0, None
    mx, my = statistics.fmean(xs), statistics.fmean(ys)
    sxx = sum((x - mx) ** 2 for x in xs)
    if sxx <= 0:
        return 0.0, None
    slope = sum((x - mx) * (y - my) for x, y in zip(xs, ys)) / sxx
    resid = [y - my - slope * (x - mx) for x, y in zip(xs, ys)]
    se2 = sum(r * r for r in resid) / (n - 2) / sxx
    if se2 <= 0:
        return slope, None
    return slope, slope / math.sqrt(se2)


def _mean_t(values: Sequence[float]) -> tuple[float, float | None]:
    n = len(values)
    if n < 3:
        return 0.0, None
    m = statistics.fmean(values)
    sd = statistics.pstdev(values)
    if sd <= 0:
        return m, None
    return m, m / (sd / math.sqrt(n))


def _fit(obs: Sequence[_Observation], post: Sequence[float], provenance: str) -> LiftModel:
    b1, b2 = _wls_quadratic(obs)
    residuals = [o.log_lift - (b1 * o.depth + b2 * o.depth ** 2) for o in obs]
    weights = [o.weight for o in obs]
    low = _weighted_quantile(residuals, weights, 0.10)
    high = _weighted_quantile(residuals, weights, 0.90)
    mean_y = statistics.fmean(o.log_lift for o in obs)
    ss_tot = sum((o.log_lift - mean_y) ** 2 for o in obs)
    ss_res = sum(r * r for r in residuals)
    r2 = None if ss_tot <= 0 else 1 - ss_res / ss_tot

    # Fade: regress the depth-adjusted residual on week-in-run. Only the runs
    # that lasted more than a week carry information about it.
    fade, fade_t = _slope_t([o.week_in_run for o in obs], residuals)
    fade_detected = fade_t is not None and abs(fade_t) >= EFFECT_T_THRESHOLD
    later_weeks = sum(1 for o in obs if o.week_in_run >= 2)
    dip, dip_t = _mean_t(post)
    dip_detected = dip_t is not None and abs(dip_t) >= EFFECT_T_THRESHOLD

    depths = sorted({round(o.depth * 100, 2) for o in obs})
    return LiftModel(
        provenance=provenance,
        b1=b1, b2=b2, resid_low=low, resid_high=high,
        n_events=len(obs), n_depths=len(depths), r_squared=r2,
        depth_min_pct=depths[0], depth_max_pct=depths[-1],
        fade_per_week=fade if fade_detected else 0.0, fade_detected=fade_detected,
        fade_t=fade_t, fade_runs=later_weeks,
        dip=math.expm1(dip) if dip_detected else 0.0, dip_detected=dip_detected,
        dip_t=dip_t, dip_events=len(post),
    )


def _rules_model() -> LiftModel:
    """The approved treatment rules as a curve: fitted through each band's
    midpoint, with the band read from the rules' own ends. The last resort."""
    obs: list[_Observation] = []
    half_widths: list[float] = []
    for d, lo, hi in config.TREATMENT_RULES.values():
        mid = math.log1p((lo + hi) / 2)
        obs.append(_Observation(d, mid, 1.0, 1))
        half_widths.append((math.log1p(hi) - math.log1p(lo)) / 2)
    b1, b2 = _wls_quadratic(obs)
    width = statistics.fmean(half_widths)
    depths = sorted(round(o.depth * 100, 2) for o in obs)
    return LiftModel(
        provenance=PROVENANCE_RULES, b1=b1, b2=b2, resid_low=-width, resid_high=width,
        n_events=len(obs), n_depths=len(depths), r_squared=None,
        depth_min_pct=depths[0], depth_max_pct=depths[-1],
        fade_per_week=0.0, fade_detected=False, fade_t=None, fade_runs=0,
        dip=0.0, dip_detected=False, dip_t=None, dip_events=0,
    )


def _fittable(obs: Sequence[_Observation]) -> bool:
    return len(obs) >= MIN_FIT_EVENTS and len({round(o.depth, 2) for o in obs}) >= MIN_FIT_DEPTHS


@lru_cache(maxsize=64)
def lift_model(state: FilterState) -> LiftModel:
    """The lift model for a scope. Memoised per FilterState like the row
    caches beneath it; cleared with them when a dataset is installed."""
    rows = baseline_rows_for(state)
    baselines = _baselines(rows)
    obs = _observations(rows, baselines)
    if _fittable(obs):
        model = _fit(obs, _post_promotion_ratios(rows, baselines), PROVENANCE_FITTED)
    else:
        model = None
        everything = FilterState.build()
        if state != everything:
            wide = baseline_rows_for(everything)
            wide_baselines = _baselines(wide)
            wide_obs = _observations(wide, wide_baselines)
            if _fittable(wide_obs):
                model = _fit(wide_obs, _post_promotion_ratios(wide, wide_baselines), PROVENANCE_DATASET)
        if model is None:
            model = _rules_model()
    return _calibrate(model, obs)


#: The calibration scale is bounded: one freak week must not turn the whole
#: curve into a flat line or a cliff. Stated here so it is not a hidden number.
CALIBRATION_SCALE_BOUNDS = (0.25, 4.0)


def _calibrate(model: LiftModel, obs: Sequence[_Observation]) -> LiftModel:
    """Scale the depth curve to the scope's own measured level -- see
    `LiftModel.scale`. The fade term is left as fitted."""
    if not obs:
        return model
    observed = sum(o.weight * (o.log_lift - model.fade_per_week * (o.week_in_run - 1)) for o in obs)
    fitted = sum(o.weight * (model.b1 * o.depth + model.b2 * o.depth ** 2) for o in obs)
    if fitted <= 0 or observed <= 0:
        return model
    lo, hi = CALIBRATION_SCALE_BOUNDS
    scale = min(hi, max(lo, observed / fitted))
    return dataclasses.replace(model, scale=scale, calibration_events=len(obs))


# --- the scope's templates -------------------------------------------------


@dataclass(frozen=True)
class Template:
    """One (product, channel) as it ordinarily trades in this scope: what a
    week of it looks like with no promotion on."""

    product_id: str
    channel_id: str
    brand_form: str
    product_rank: int
    month: int
    baseline: float             # units per transaction, non-promoted
    transactions_per_week: float
    list_price: float
    unit_cost: float


def templates(state: FilterState) -> tuple[list[Template], list[dict[str, Any]]]:
    rows = baseline_rows_for(state)
    baselines = _baselines(rows)
    acc: dict[tuple[str, str], dict[str, Any]] = {}
    for r in rows:
        a = acc.setdefault(r.baseline_key, {
            "row": r, "weeks": set(), "transactions": 0.0,
            "list_revenue": 0.0, "quantity": 0.0, "cost": 0.0,
        })
        a["weeks"].add(r.week_key)
        a["transactions"] += r.transaction_count
        a["list_revenue"] += r.actual_revenue + r.discount_value
        a["quantity"] += r.actual_quantity
        a["cost"] += r.total_cost

    out: list[Template] = []
    excluded: list[dict[str, Any]] = []
    for key in sorted(acc):
        a = acc[key]
        b = baselines.get(key)
        if b is None:
            excluded.append({"product_id": key[0], "channel_id": key[1],
                             "reason": "no non-promoted week in this scope to base a scenario on"})
            continue
        if a["quantity"] <= 0 or not a["weeks"]:
            excluded.append({"product_id": key[0], "channel_id": key[1],
                             "reason": "no priced volume in this scope"})
            continue
        r: A.WeekRow = a["row"]
        out.append(Template(
            product_id=key[0], channel_id=key[1], brand_form=r.brand_form,
            product_rank=r.product_rank, month=r.month, baseline=b,
            transactions_per_week=a["transactions"] / len(a["weeks"]),
            list_price=a["list_revenue"] / a["quantity"],
            unit_cost=a["cost"] / a["quantity"],
        ))
    return out, excluded


# --- the window ------------------------------------------------------------


@dataclass(frozen=True)
class Window:
    days: int

    @property
    def weeks(self) -> int:
        return math.ceil(self.days / DAYS_PER_WEEK)

    def fraction(self, week_index: int) -> float:
        """How much of week `week_index` (1-based) the window covers."""
        if week_index < self.weeks:
            return 1.0
        remainder = self.days - DAYS_PER_WEEK * (self.weeks - 1)
        return remainder / DAYS_PER_WEEK

    @property
    def partial_week_fraction(self) -> float | None:
        f = self.fraction(self.weeks)
        return None if f >= 1.0 else round(f, 3)


def _week_key(week_index: int) -> str:
    return f"{_WINDOW_WEEK_PREFIX}{week_index:02d}"


def _promoted_row(t: Template, week_index: int, transactions: float, uplift: float,
                  discount: float) -> A.WeekRow:
    """A promoted week of one template. The arithmetic is the counterfactual
    the earlier engine used, unchanged: b.n.(1+u) units at P.(1-d), with the
    standing promotion overhead on list revenue."""
    quantity = t.baseline * transactions * (1 + uplift)
    price = t.list_price * (1 - discount)
    base_revenue = quantity * t.list_price
    actual_revenue = quantity * price
    return A.WeekRow(
        product_id=t.product_id, channel_id=t.channel_id, brand_form=t.brand_form,
        product_rank=t.product_rank, week_key=_week_key(week_index), month=t.month,
        is_promoted=True, promotion_id="SIM",
        base_quantity=quantity, actual_quantity=quantity,
        actual_revenue=actual_revenue, total_cost=t.unit_cost * quantity,
        promotion_cost=config.PROMOTION_COST_RATE * base_revenue,
        discount_value=base_revenue - actual_revenue,
        actual_price_sum=price * transactions,
        transaction_count=transactions,  # type: ignore[arg-type]  # fractional under partial coverage
    )


def _ordinary_row(t: Template, week_index: int, transactions: float, factor: float = 1.0) -> A.WeekRow:
    """A non-promoted week of one template, at its ordinary level (times
    `factor`, which is 1 except for a detected post-promotion dip)."""
    quantity = t.baseline * transactions * factor
    revenue = quantity * t.list_price
    return A.WeekRow(
        product_id=t.product_id, channel_id=t.channel_id, brand_form=t.brand_form,
        product_rank=t.product_rank, week_key=_week_key(week_index), month=t.month,
        is_promoted=False, promotion_id="-1",
        base_quantity=quantity, actual_quantity=quantity,
        actual_revenue=revenue, total_cost=t.unit_cost * quantity,
        promotion_cost=0.0, discount_value=0.0,
        actual_price_sum=t.list_price * transactions,
        transaction_count=transactions,  # type: ignore[arg-type]
    )


def window_rows(temps: Sequence[Template], window: Window, model: LiftModel, discount_pct: float,
                coverage: float, end: str) -> list[A.WeekRow]:
    """Every row of the window: the promoted share of each template at the
    model's `end` ("low" | "mid" | "high") of the band, and the uncovered
    share at its ordinary level. Discount zero means nothing is promoted."""
    d = discount_pct / 100.0
    promoted = d > 0 and coverage > 0
    out: list[A.WeekRow] = []
    for t in temps:
        for k in range(1, window.weeks + 1):
            n = t.transactions_per_week * window.fraction(k)
            if n <= 0:
                continue
            if promoted:
                lo, mid, hi = model.lift(discount_pct, k)
                u = {"low": lo, "mid": mid, "high": hi}[end]
                out.append(_promoted_row(t, k, n * coverage, u, d))
                if coverage < 1:
                    out.append(_ordinary_row(t, k, n * (1 - coverage)))
            else:
                out.append(_ordinary_row(t, k, n))
    return out


def _revenue(rows: Sequence[A.WeekRow]) -> float:
    """Sum(Actual_Revenue) -- the engine's revenue total, as `calculate_margin`
    sums it. Stated via the engine's own reducer."""
    return A._sum(rows, lambda r: r.actual_revenue)


def _units(rows: Sequence[A.WeekRow]) -> float:
    return A._sum(rows, lambda r: r.actual_quantity)


@dataclass(frozen=True)
class Figures:
    revenue: float
    units: float
    trade_spend: float | None
    incremental_sales: float | None
    incremental_units: float | None
    roi: float | None
    margin_pct: float | None


def measure(rows: Sequence[A.WeekRow], scope_ordinary: Sequence[A.WeekRow]) -> Figures:
    """The engine, over the window rows.

    `rows` is the window; `volume_rows` is the scope's own non-promoted rows
    plus the window's -- so the baseline the engine derives is the very one
    the templates were built from, and Incremental Sales reconciles by
    construction. The same two-set call the old weekly decomposition used.
    """
    vrows = (*scope_ordinary, *rows)
    promoted = any(r.is_promoted for r in rows)
    return Figures(
        revenue=_revenue(rows),
        units=_units(rows),
        trade_spend=A.calculate_trade_spend(rows) if promoted else 0.0,
        incremental_sales=A.calculate_incremental_sales(vrows) if promoted else None,
        incremental_units=A.calculate_incremental_quantity(vrows) if promoted else None,
        roi=A.calculate_roi(rows, vrows) if promoted else None,
        margin_pct=A.calculate_margin(rows),
    )


# --- the scope response ----------------------------------------------------


def _observed_plan(state: FilterState) -> dict[str, Any]:
    """What this scope actually ran: its average depth (spend-weighted, the
    same identity the observations use) and its typical run length."""
    rows = rows_for(state)
    promoted = [r for r in rows if r.is_promoted]
    list_revenue = sum(r.actual_revenue + r.discount_value for r in promoted)
    depth = (sum(r.discount_value for r in promoted) / list_revenue * 100) if list_revenue > 0 else 0.0

    # Run lengths, per (product, channel), consecutive weeks under one offer.
    by_key: dict[tuple[str, str], dict[str, A.WeekRow]] = defaultdict(dict)
    for r in rows:
        by_key[r.baseline_key][r.week_key] = r
    order = {w: i for i, w in enumerate(sorted({r.week_key for r in rows}))}
    runs: list[int] = []
    for by_week in by_key.values():
        weeks = sorted(by_week, key=lambda w: order[w])
        length = 0
        previous: A.WeekRow | None = None
        for w in weeks:
            r = by_week[w]
            if r.is_promoted and previous is not None and previous.is_promoted \
                    and previous.promotion_id == r.promotion_id and order[w] == order[previous.week_key] + 1:
                length += 1
            else:
                if length:
                    runs.append(length)
                length = 1 if r.is_promoted else 0
            previous = r
        if length:
            runs.append(length)
    weeks = int(statistics.median(runs)) if runs else 1
    return {
        "promoted_rows": len(promoted),
        "discount_pct": round(depth, 2),
        "typical_weeks": weeks,
        "days": min(MAX_DAYS, weeks * DAYS_PER_WEEK),
        "runs": len(runs),
    }


def _money(value: float | None, currency: str) -> dict[str, Any]:
    return {"value": None if value is None else round(value, 2), "display": F.money(value, currency)}


def _scope_block(state: FilterState, temps: Sequence[Template], excluded: Sequence[dict[str, Any]]) -> dict[str, Any]:
    rows = rows_for(state)
    return {
        "filters_applied": state.applied(),
        "period": F.period_label(state.year, state.month),
        "row_count": len(rows),
        "promoted_row_count": sum(1 for r in rows if r.is_promoted),
        "product_channels": len(temps),
        "excluded": list(excluded),
    }


def scope(state: FilterState, currency: str = "INR") -> dict[str, Any]:
    """Everything the page needs before a slider moves: the measured plan,
    the fitted model, and each lever's range and starting value."""
    currency = F.normalise_currency(currency)
    temps, excluded = templates(state)
    if not temps:
        raise NothingToSimulate(
            "Nothing to simulate: no product-channel in this scope has a non-promoted week "
            "to base a scenario on."
        )
    model = lift_model(state)
    observed = _observed_plan(state)
    default_discount = min(model.domain_max_pct, _snap(observed["discount_pct"]))
    default_days = observed["days"] if observed["promoted_rows"] else 2 * DAYS_PER_WEEK

    scope_ordinary = [r for r in baseline_rows_for(state) if not r.is_promoted]
    # The budget slider's ceiling: what promoting everything at the deepest
    # allowed depth for the longest window would cost. Nothing can spend more.
    ceiling = measure(
        window_rows(temps, Window(MAX_DAYS), model, model.domain_max_pct, 1.0, "high"),
        scope_ordinary,
    ).trade_spend or 0.0
    default_spend = 0.0
    if default_discount > 0:
        default_spend = measure(
            window_rows(temps, Window(default_days), model, default_discount, 1.0, "mid"),
            scope_ordinary,
        ).trade_spend or 0.0

    step = _spend_step(ceiling)
    default_spend = min(ceiling, math.ceil(default_spend / step) * step) if default_spend > 0 else 0.0

    # The scope as history measured it, for the reader's bearings.
    history = rows_for(state)
    history_volume = baseline_rows_for(state)
    measured = {
        "revenue": _money(_revenue(history), currency),
        "trade_spend": _money(A.calculate_trade_spend(history), currency),
        "incremental_sales": _money(A.calculate_incremental_sales(history_volume), currency),
        "roi": {"value": A.calculate_roi(history, history_volume),
                "display": F.multiple(A.calculate_roi(history, history_volume))},
    }

    return {
        "mode": "studio",
        "currency": currency,
        # Display units of `currency` per base-currency unit, so the page can
        # render the budget slider's live readout while it is dragged. The one
        # backend-defined rate, applied once at display -- never in arithmetic.
        "exchange_rate": F.convert(1.0, currency),
        "scope": _scope_block(state, temps, excluded),
        "measured": measured,
        "observed_plan": observed,
        "levers": {
            "discount_pct": {"min": 0.0, "max": model.domain_max_pct, "step": DISCOUNT_STEP_PCT,
                             "default": default_discount, "unit": "percent"},
            "days": {"min": MIN_DAYS, "max": MAX_DAYS, "step": 1, "default": default_days,
                     "unit": "days"},
            "trade_spend": {"min": 0.0, "max": round(ceiling, 2), "step": step,
                            # Rounded UP to the slider's step, so the starting
                            # position funds the whole current plan rather than
                            # landing a step short of it.
                            "default": default_spend, "unit": "currency",
                            "max_display": F.money(ceiling, currency),
                            "default_display": F.money(default_spend, currency)},
        },
        "model": model.as_dict(),
    }


def _snap(discount_pct: float) -> float:
    return round(round(discount_pct / DISCOUNT_STEP_PCT) * DISCOUNT_STEP_PCT, 2)


def _spend_step(ceiling: float) -> float:
    """A slider step that gives roughly 200 positions, on a round number."""
    if ceiling <= 0:
        return 1.0
    raw = ceiling / 200
    magnitude = 10 ** math.floor(math.log10(raw))
    for m in (1, 2, 5, 10):
        if m * magnitude >= raw:
            return float(m * magnitude)
    return float(10 * magnitude)


# --- the simulation --------------------------------------------------------


def _figures_block(fig: Figures, currency: str) -> dict[str, Any]:
    return {
        "revenue": _money(fig.revenue, currency),
        "units": {"value": round(fig.units, 0), "display": F.quantity(fig.units)},
        "trade_spend": _money(fig.trade_spend, currency),
        "incremental_sales": _money(fig.incremental_sales, currency),
        "incremental_units": {"value": fig.incremental_units,
                              "display": F.quantity(fig.incremental_units)},
        "roi": {"value": fig.roi, "display": F.multiple(fig.roi)},
        "margin_pct": {"value": fig.margin_pct, "display": F.percent(fig.margin_pct)},
    }


def _band(low: Figures, mid: Figures, high: Figures, currency: str) -> dict[str, Any]:
    block = _figures_block(mid, currency)
    block["band"] = {
        "revenue": {"low": _money(low.revenue, currency), "high": _money(high.revenue, currency)},
        "roi": {"low": {"value": low.roi, "display": F.multiple(low.roi)},
                "high": {"value": high.roi, "display": F.multiple(high.roi)}},
        "incremental_sales": {"low": _money(low.incremental_sales, currency),
                              "high": _money(high.incremental_sales, currency)},
    }
    return block


def _direction(delta: float | None, tolerance: float) -> str:
    if delta is None:
        return "not_applicable"
    if abs(delta) < tolerance:
        return "unchanged"
    return "up" if delta > 0 else "down"


def _roi_status(roi: float | None) -> str:
    """ROI is a multiple: 1.00 is break-even. Above it the spend came back
    with more; below it the promotion lost money; at exactly 1.00 (to the
    engine's two decimals) it broke even."""
    if roi is None:
        return "not_applicable"
    if roi > 1.0:
        return "profitable"
    if roi < 1.0:
        return "loss_making"
    return "break_even"


def _deltas(current: Figures, scenario: Figures, currency: str) -> dict[str, Any]:
    rev_delta = scenario.revenue - current.revenue
    rev_pct = (rev_delta / current.revenue * 100) if current.revenue else None
    roi_delta = None if current.roi is None or scenario.roi is None else round(scenario.roi - current.roi, 2)
    return {
        "revenue": {
            "absolute": _money(rev_delta, currency),
            "percent": None if rev_pct is None else round(rev_pct, 2),
            "percent_display": F.percent(rev_pct, signed=True),
            "direction": _direction(rev_delta, 0.05),
        },
        "roi": {
            "absolute": roi_delta,
            "absolute_display": F.multiple(roi_delta, signed=True),
            "direction": _direction(roi_delta, 0.005),
            "status": _roi_status(scenario.roi),
            "current_status": _roi_status(current.roi),
        },
    }


def _weekly(temps: Sequence[Template], window: Window, model: LiftModel, scope_ordinary: Sequence[A.WeekRow],
            current_pct: float, scenario_pct: float, coverage: float, currency: str) -> list[dict[str, Any]]:
    """The window week by week. Each week's rows are measured on their own
    against the scope's baseline set, so the weekly revenues sum to the window's
    exactly and the weekly ROI is that week's own IS / TS."""
    def by_week(rows: Sequence[A.WeekRow]) -> dict[str, list[A.WeekRow]]:
        out: dict[str, list[A.WeekRow]] = defaultdict(list)
        for r in rows:
            out[r.week_key].append(r)
        return out

    base = by_week(window_rows(temps, window, model, 0.0, 1.0, "mid"))
    cur = by_week(window_rows(temps, window, model, current_pct, 1.0, "mid"))
    mid = by_week(window_rows(temps, window, model, scenario_pct, coverage, "mid"))
    low = by_week(window_rows(temps, window, model, scenario_pct, coverage, "low"))
    high = by_week(window_rows(temps, window, model, scenario_pct, coverage, "high"))

    out: list[dict[str, Any]] = []
    for k in range(1, window.weeks + 1):
        key = _week_key(k)
        c = measure(cur.get(key, ()), scope_ordinary)
        s = measure(mid.get(key, ()), scope_ordinary)
        out.append({
            "week": k,
            "label": f"Week {k}",
            "days": round(window.fraction(k) * DAYS_PER_WEEK, 2),
            "baseline_revenue": _money(_revenue(base.get(key, ())), currency),
            "current_revenue": _money(c.revenue, currency),
            "scenario_revenue": _money(s.revenue, currency),
            "scenario_revenue_low": _money(_revenue(low.get(key, ())), currency),
            "scenario_revenue_high": _money(_revenue(high.get(key, ())), currency),
            "current_roi": {"value": c.roi, "display": F.multiple(c.roi)},
            "scenario_roi": {"value": s.roi, "display": F.multiple(s.roi)},
            "scenario_trade_spend": _money(s.trade_spend, currency),
        })
    return out


def simulate(state: FilterState, *, discount_pct: float, trade_spend: float, days: int,
             currency: str = "INR") -> dict[str, Any]:
    """The three levers -> the window's Revenue and ROI, beside the current
    plan's over the same window and the no-promotion baseline."""
    currency = F.normalise_currency(currency)
    temps, excluded = templates(state)
    if not temps:
        raise NothingToSimulate(
            "Nothing to simulate: no product-channel in this scope has a non-promoted week "
            "to base a scenario on."
        )
    model = lift_model(state)
    if not (MIN_DAYS <= days <= MAX_DAYS):
        raise LeverOutOfRange(f"days must be between {MIN_DAYS} and {MAX_DAYS}; got {days}.")
    if not (0 <= discount_pct <= model.domain_max_pct):
        raise LeverOutOfRange(
            f"discount_pct must be between 0 and {model.domain_max_pct:.2f} -- the deepest depth "
            f"the data shows ({model.depth_max_pct:.2f}%) plus {DOMAIN_MARGIN_PCT:.0f} points; "
            f"got {discount_pct}."
        )
    if trade_spend < 0:
        raise LeverOutOfRange("trade_spend cannot be negative.")

    window = Window(days)
    scope_ordinary = [r for r in baseline_rows_for(state) if not r.is_promoted]
    observed = _observed_plan(state)
    current_pct = min(model.domain_max_pct, _snap(observed["discount_pct"]))

    # The budget -> coverage. Full coverage is priced by the engine at the
    # band's midpoint; the budget buys a share of it.
    full = measure(window_rows(temps, window, model, discount_pct, 1.0, "mid"), scope_ordinary)
    full_cost = full.trade_spend or 0.0
    if discount_pct <= 0 or full_cost <= 0:
        coverage = 1.0
    else:
        coverage = min(1.0, trade_spend / full_cost)
        # A budget within half a percent of full coverage IS full coverage:
        # the slider's step and the payload's one-decimal rounding can land a
        # "fund everything" request a rupee short, and reporting 99.6% of the
        # scope for it would be precision the request never had.
        if coverage >= 1 - BINDING_TOLERANCE:
            coverage = 1.0
    consumed = full_cost * coverage

    baseline = measure(window_rows(temps, window, model, 0.0, 1.0, "mid"), scope_ordinary)
    current = tuple(
        measure(window_rows(temps, window, model, current_pct, 1.0, end), scope_ordinary)
        for end in ("low", "mid", "high")
    )
    scenario = tuple(
        measure(window_rows(temps, window, model, discount_pct, coverage, end), scope_ordinary)
        for end in ("low", "mid", "high")
    )

    after: dict[str, Any] | None = None
    if model.dip_detected and discount_pct > 0:
        dip_rows = [
            _ordinary_row(t, window.weeks + 1, t.transactions_per_week * coverage, 1 + model.dip)
            for t in temps
        ]
        ordinary = [_ordinary_row(t, window.weeks + 1, t.transactions_per_week * coverage) for t in temps]
        after = {
            "week": window.weeks + 1,
            "revenue_effect": _money(_revenue(dip_rows) - _revenue(ordinary), currency),
            "note": "The week after the window, at the detected post-promotion level. Not part of the window figures.",
        }

    lo, mid, hi = model.lift(discount_pct)
    return {
        "mode": "studio",
        "currency": currency,
        "scope": _scope_block(state, temps, excluded),
        "levers": {
            "discount_pct": discount_pct,
            "days": days,
            "trade_spend": {
                "requested": _money(trade_spend, currency),
                "consumed": _money(consumed, currency),
                "full_coverage_cost": _money(full_cost, currency),
                "coverage": round(coverage, 3),
                "coverage_display": F.percent(coverage * 100),
                "binding": coverage < 1.0,
                "unspent": _money(max(0.0, trade_spend - consumed), currency),
            },
        },
        "window": {
            "days": days,
            "weeks": window.weeks,
            "partial_week_fraction": window.partial_week_fraction,
        },
        "lift": {"low": round(lo, 4), "mid": round(mid, 4), "high": round(hi, 4),
                 "display": f"{lo * 100:.2f}%–{hi * 100:.2f}%"},
        "baseline": {
            "label": "No promotion",
            "revenue": _money(baseline.revenue, currency),
            "units": {"value": round(baseline.units, 0), "display": F.quantity(baseline.units)},
        },
        "current_plan": {
            "label": "Current plan",
            "discount_pct": current_pct,
            "days": days,
            "coverage": 1.0,
            "note": (
                f"This scope's own promotions, at their spend-weighted average depth of "
                f"{current_pct:.2f}%, run for the same {days} days at full coverage."
                if observed["promoted_rows"] else
                "This scope ran no promotion, so the current plan is its ordinary trading."
            ),
            **_band(*current, currency),
        },
        "scenario": {
            "label": "Scenario",
            "discount_pct": discount_pct,
            "days": days,
            "coverage": round(coverage, 3),
            **_band(*scenario, currency),
        },
        "deltas": _deltas(current[1], scenario[1], currency),
        "vs_baseline": {
            "revenue": _money(scenario[1].revenue - baseline.revenue, currency),
            "direction": _direction(scenario[1].revenue - baseline.revenue, 0.05),
        },
        "after_window": after,
        "weekly": _weekly(temps, window, model, scope_ordinary, current_pct, discount_pct, coverage, currency),
        "model": model.as_dict(),
        "method": (
            "Rows for the window are synthesized from each product-channel's ordinary week "
            "(its non-promotional baseline, transactions per week, list price and unit cost) "
            "and read by the validated KPI engine. Revenue is Sum(Actual_Revenue); Trade Spend "
            "is Sum(Base_Revenue - Actual_Revenue + Promotion_Cost); ROI is Incremental Sales / "
            "Trade Spend. No KPI is computed here."
        ),
    }


# --- the discount curve ----------------------------------------------------

#: Depth step of the curve. Coarse enough to be cheap (a dozen or so engine
#: passes), fine enough that the line reads as a curve.
CURVE_STEP_PCT = 2.5


def curve(state: FilterState, *, trade_spend: float, days: int, currency: str = "INR") -> dict[str, Any]:
    """Revenue and ROI at every discount depth the slider allows, holding the
    budget and the window fixed -- the shape of the trade-off the discount
    slider is moving along. Each point is the same arithmetic `simulate` runs
    at that depth: window rows at the band's low, mid and high, read by the
    engine. No point is interpolated from its neighbours."""
    currency = F.normalise_currency(currency)
    temps, _excluded = templates(state)
    if not temps:
        raise NothingToSimulate(
            "Nothing to simulate: no product-channel in this scope has a non-promoted week "
            "to base a scenario on."
        )
    model = lift_model(state)
    if not (MIN_DAYS <= days <= MAX_DAYS):
        raise LeverOutOfRange(f"days must be between {MIN_DAYS} and {MAX_DAYS}; got {days}.")
    if trade_spend < 0:
        raise LeverOutOfRange("trade_spend cannot be negative.")

    window = Window(days)
    scope_ordinary = [r for r in baseline_rows_for(state) if not r.is_promoted]
    observed = _observed_plan(state)
    current_pct = min(model.domain_max_pct, _snap(observed["discount_pct"]))

    depths: list[float] = []
    d = 0.0
    while d < model.domain_max_pct:
        depths.append(round(d, 2))
        d += CURVE_STEP_PCT
    depths.append(model.domain_max_pct)
    if current_pct not in depths:
        depths.append(current_pct)
    depths.sort()

    points: list[dict[str, Any]] = []
    for depth in depths:
        full = measure(window_rows(temps, window, model, depth, 1.0, "mid"), scope_ordinary)
        full_cost = full.trade_spend or 0.0
        coverage = 1.0 if depth <= 0 or full_cost <= 0 else min(1.0, trade_spend / full_cost)
        if coverage >= 1 - BINDING_TOLERANCE:
            coverage = 1.0
        low, mid, high = (
            measure(window_rows(temps, window, model, depth, coverage, end), scope_ordinary)
            for end in ("low", "mid", "high")
        )
        points.append({
            "discount_pct": depth,
            "is_current_plan": depth == current_pct,
            "coverage": round(coverage, 3),
            "revenue": _money(mid.revenue, currency),
            "revenue_low": _money(low.revenue, currency),
            "revenue_high": _money(high.revenue, currency),
            "trade_spend": _money(mid.trade_spend, currency),
            "roi": {"value": mid.roi, "display": F.multiple(mid.roi)},
            "roi_low": {"value": low.roi, "display": F.multiple(low.roi)},
            "roi_high": {"value": high.roi, "display": F.multiple(high.roi)},
            "roi_status": _roi_status(mid.roi),
        })

    return {
        "mode": "studio",
        "currency": currency,
        "levers": {"trade_spend": _money(trade_spend, currency), "days": days},
        "current_plan_discount_pct": current_pct,
        "break_even_roi": 1.0,
        "points": points,
        "method": (
            "Each point is the window at that discount depth with the same budget and days, "
            "measured by the validated KPI engine exactly as the scenario is. Nothing between "
            "points is interpolated."
        ),
    }
