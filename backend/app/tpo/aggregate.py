"""The aggregate KPI engine — ONE implementation, server-side.

Every consumer (KPI cards, trend chart, risk alerts, underperforming
promotions, promotion mix) calls into this module. There is deliberately no
second copy of this arithmetic anywhere — not in another endpoint, and not in
the frontend, which fetches results and formats them, nothing more.

Adapted from the validated engine in the previous TPO project. The formulas
are unchanged; what changed is the schema they read.

THE BASELINE -- what a promoted row would have sold without its promotion,
its EXPECTED UNITS -- is the whole chain's foundation, and it is taken from
the data in one of two ways:

  * The source's own Base_Quantity, when it is a real counterfactual: the
    file carries it and it differs from Actual_Quantity on at least one
    promoted row (`FactStore.counterfactual_base`). Retail panels (Nielsen,
    IRI) ship exactly this.
  * Otherwise the product's ORDINARY trading NEAR the promoted week: units per
    store-week over the nearest BASELINE_WINDOW non-promoted weeks either
    side, for that product IN THAT CHANNEL, inside the selection. Local rather
    than one flat average over the whole span, so a seasonal product's winter
    peak is not counted as promotional lift (Cough & Cold: a flat baseline
    overstated its winter promotions by 57 % and understated its summer ones
    by 42 %).

The chain, in the order it is computed:

    expected units per promoted row    (above)
        -> incremental quantity   Sum over promoted rows of (Actual_Quantity - expected)
        -> incremental sales      Sum over promoted rows of (that x Actual_Price)
        -> ROI                    Incremental Sales / Trade Spend
        -> PEI                    (last, from the components above)

Trade Spend is independent of that chain -- Sum(Base_Revenue - Actual_Revenue +
Promotion_Cost) over the filtered rows -- as is gross margin. Cannibalization
measures the neighbouring pack sizes against their own nearby ordinary weeks.

Invariants:

  * Only promoted rows contribute incremental volume. A product never promoted
    in the selection contributes zero -- its ordinary sales are not incremental
    sales.
  * Every product carries its OWN baseline, per CHANNEL: pooling products would
    measure pack size, pooling a weekly and a monthly channel period length.
  * A promoted (product, channel) with no expected units -- no real
    Base_Quantity and no ordinary week in the selection -- is skipped and
    reported, never defaulted to zero.
  * Every promoted row carries its own expected units, so the volume KPIs are
    additive: periods and events sum exactly to the headline.
"""

from __future__ import annotations

from bisect import bisect_left
from collections import defaultdict
from dataclasses import dataclass, field
from typing import Any, Callable, Iterable, Sequence

from app.tpo import config

# PEI = 0.40(ROI net return) + 0.30(Incremental qty %) + 0.30(Gross margin %).
#
# Trade Spend Efficiency and the cannibalization score are deliberately NOT
# components: TSE = ROI x 100 by definition, so carrying both would put 45% of
# the weight on one signal, and cannibalization is a headline KPI in its own
# right. Both are still computed and shown; they simply do not feed the index.
PEI_WEIGHTS = {
    "roi": 0.40,
    "incremental_quantity_percent": 0.30,
    "gross_margin": 0.30,
}

# Ceilings used to normalise each PEI component onto 0-100. Scale references
# for the composite only — no KPI is judged against a target here.
#
# ROI enters as its NET RETURN — the multiple less the 1.0 that is just the
# spend coming back — so a break-even promotion (1.0) scores zero on this
# component and a 2.0 one hits the ceiling. Scoring the raw multiple would
# hand every promotion a floor of 50 for merely returning its own spend.
PEI_SCALE = {
    "roi_net_return_cap": 1.0,
    "incremental_quantity_cap_pct": 50.0,
    "margin_cap_pct": 40.0,
}

CANNIBALIZATION_SCORE_BUCKETS: list[tuple[float | None, int]] = [
    (5, 100), (10, 90), (20, 75), (30, 60), (50, 40), (None, 20),
]


@dataclass(frozen=True)
class WeekRow:
    """One (product, channel, week, offer) slice of the filtered dataset.

    The grain is deliberately finer than any KPI needs: `promotion_id` and
    `week_key` are carried so Risk Alerts and Underperforming Promotions can
    report one row per real promotion EVENT without a second pass over the
    data, and `channel_id` so the baseline can be keyed on it.
    """

    product_id: str
    channel_id: str
    brand_form: str
    product_rank: int  # 1-4 by pack size within the Brand Form; neighbours are +/-1
    week_key: str  # "YYYY-Www"
    month: int
    is_promoted: bool
    promotion_id: str  # "-1" when not promoted
    base_quantity: float
    actual_quantity: float
    actual_revenue: float
    total_cost: float
    promotion_cost: float
    discount_value: float  # Base_Revenue - Actual_Revenue; half of Trade Spend
    actual_price_sum: float  # Sum of row-level Actual_Price over the group
    transaction_count: int
    #: Sum of Base_Quantity x Actual_Price over the group: the expected units
    #: valued at the price actually paid. Read only when `counterfactual`.
    base_value: float = 0.0
    #: True when Base_Quantity is a real "without the promotion" figure (see
    #: the module docstring); False for a source without one, and for the
    #: Simulation Studio's synthetic rows.
    counterfactual: bool = False
    #: COMPONENT A's answer for this group: the LightGBM baseline summed over
    #: exactly the store-weeks the current filter kept, so it scales with the
    #: selection the way the row's own measures do. None when the model is off
    #: or could not be fitted. See app/tpo/baseline_model.py.
    model_baseline: float | None = None

    @property
    def year(self) -> str:
        return self.week_key[:4]

    @property
    def baseline_key(self) -> tuple[str, str]:
        """What a baseline is computed per. See the module docstring."""
        return (self.product_id, self.channel_id)


@dataclass
class KpiMetric:
    value: float | None = None
    previous_year: float | None = None
    difference: float | None = None
    growth: float | None = None


@dataclass
class KpiBundle:
    trade_spend: KpiMetric = field(default_factory=KpiMetric)
    incremental_quantity: KpiMetric = field(default_factory=KpiMetric)
    incremental_quantity_percent: KpiMetric = field(default_factory=KpiMetric)
    incremental_sales: KpiMetric = field(default_factory=KpiMetric)
    roi: KpiMetric = field(default_factory=KpiMetric)
    margin_impact: KpiMetric = field(default_factory=KpiMetric)
    trade_spend_efficiency: KpiMetric = field(default_factory=KpiMetric)
    incremental_profit: KpiMetric = field(default_factory=KpiMetric)
    net_incremental_profit: KpiMetric = field(default_factory=KpiMetric)
    cannibalization: KpiMetric = field(default_factory=KpiMetric)
    cannibalization_score: float | None = None
    pei: KpiMetric = field(default_factory=KpiMetric)
    debug: dict[str, Any] = field(default_factory=dict)


# --- guards ----------------------------------------------------------------


def safe_divide(numerator: float, denominator: float) -> float | None:
    """Division yielding None rather than ZeroDivisionError or inf."""
    if not denominator:
        return None
    result = numerator / denominator
    return result if result == result and abs(result) != float("inf") else None


def _sum(rows: Iterable[WeekRow], pick: Callable[[WeekRow], float]) -> float:
    return sum(pick(r) for r in rows)


def _clamp(v: float, lo: float, hi: float) -> float:
    return max(lo, min(v, hi))


def _round(value: float | None, dp: int) -> float | None:
    return None if value is None else round(value, dp)


def promotion_rows(rows: Sequence[WeekRow]) -> list[WeekRow]:
    return [r for r in rows if r.is_promoted]


# --- the baseline ----------------------------------------------------------

#: Non-promoted weeks averaged on EACH side of a row for its local baseline.
BASELINE_WINDOW = 4


def _local_baselines(rows: Sequence[WeekRow]) -> list[float | None]:
    """Every row's ordinary level, in units per store-week: Sum(Base_Quantity)
    / Sum(store-weeks) over the nearest BASELINE_WINDOW non-promoted rows of
    the same (product, channel) on each side, in week order, the row itself
    excluded. None where the (product, channel) has no other ordinary row.

    A ratio of sums, so a week booked by many stores weighs more than one
    booked by few. On a non-promoted row Base_Quantity is its own units, so
    this is the product's nearby ordinary trading whatever the source.
    """
    by_key: dict[tuple[str, str], list[int]] = defaultdict(list)
    for i, r in enumerate(rows):
        by_key[r.baseline_key].append(i)
    out: list[float | None] = [None] * len(rows)
    for idxs in by_key.values():
        idxs.sort(key=lambda i: rows[i].week_key)
        ordinary = [p for p, i in enumerate(idxs) if not rows[i].is_promoted]
        if not ordinary:
            continue
        for p, i in enumerate(idxs):
            k = bisect_left(ordinary, p)
            after = k + 1 if k < len(ordinary) and ordinary[k] == p else k
            near = ordinary[max(0, k - BASELINE_WINDOW):k] + ordinary[after:after + BASELINE_WINDOW]
            stores = sum(rows[idxs[q]].transaction_count for q in near)
            if stores:
                out[i] = sum(rows[idxs[q]].base_quantity for q in near) / stores
    return out


def _expected(
    rows: Sequence[WeekRow], local: list[float | None] | None = None
) -> list[tuple[float, float] | None]:
    """Per PROMOTED row: (expected units, expected units valued at the row's
    own prices) -- what it would have sold without the promotion. None on a
    non-promoted row, and on a promoted one with nothing to measure against.

    THREE SOURCES, IN THIS ORDER. Observed data beats any estimate; a model
    that saw the whole dataset beats one local average:

      1. The source's own Base_Quantity, when it is a real counterfactual AND
         `config.BASELINE_PREFER_SOURCE`. Retail panels (Nielsen, IRI) ship
         this and it is measured, not predicted. On the reference dataset the
         model reproduces it only to within ~3%, so preferring it keeps the
         shipped figures exact.
      2. COMPONENT A, the LightGBM P50 (`row.model_baseline`). What actually
         runs on a client file, because practically none carry Base_Quantity.
      3. The nearest ordinary weeks (`_local_baselines`). The fallback for a
         cell the model could not be fitted for, and the engine's original rule.

    A promoted row that none of the three can answer for is left None --
    skipped and reported, never defaulted to zero.
    """
    out: list[tuple[float, float] | None] = [None] * len(rows)
    for i, r in enumerate(rows):
        if not r.is_promoted:
            continue
        if r.counterfactual and config.BASELINE_PREFER_SOURCE:
            out[i] = (r.base_quantity, r.base_value)
            continue
        if r.model_baseline is not None and r.transaction_count:
            # The model answers per store-week and `model_baseline` is already
            # summed over the group's store-weeks, so the per-store-week rate
            # is what prices the expected units -- the same shape the local
            # mean produces, which keeps the two interchangeable here.
            rate = r.model_baseline / r.transaction_count
            out[i] = (r.model_baseline, rate * r.actual_price_sum)
            continue
        if local is None:
            local = _local_baselines(rows)
        b = local[i]
        if b is not None:
            out[i] = (b * r.transaction_count, b * r.actual_price_sum)
    return out


# --- Trade Spend -----------------------------------------------------------


def calculate_trade_spend(rows: Sequence[WeekRow]) -> float | None:
    """Trade Spend, the approved business definition:

        Sum(Base_Revenue - Actual_Revenue + Promotion_Cost)

    Both halves of the promotional investment. `discount_value` is the price
    cut given away (Base_Revenue - Actual_Revenue); `promotion_cost` is the
    Promotion_Cost ledger.

    Summed over EVERY filtered row, not just promoted ones, exactly as the
    formula is written. Non-promoted rows contribute nothing on their own
    terms rather than by being filtered out: a Promotion_Id of -1 carries
    Base_Revenue == Actual_Revenue and a zero Promotion_Cost, so the two
    definitions agree numerically. Summing the whole filtered set is what the
    specification says, and it stays correct if a later extract ever books a
    discount against a non-promoted row.

    An earlier implementation summed Promotion_Cost alone, reasoning that the
    discount was already inside Actual_Revenue and would be double-counted.
    That does not survive contact with the definition: Trade Spend measures
    INVESTMENT, not revenue, and the price cut is the larger part of what was
    invested. That version understated the previous project's 2025 figure by
    Rs 23.10 Cr and flattered every ratio built on it.

    ROI, Trade Spend Efficiency and PEI all call this, so the definition is
    stated once and corrected once.
    """
    if not rows:
        return None
    return _sum(rows, lambda r: r.discount_value + r.promotion_cost)


# --- volume ----------------------------------------------------------------


@dataclass(frozen=True)
class ProductVolume:
    """One (product, channel)'s incremental trace."""

    product_id: str
    channel_id: str
    baseline_average: float
    non_promoted_rows: int
    promoted_rows: int
    promoted_quantity: float
    promoted_revenue: float
    promoted_price_sum: float
    baseline_quantity: float
    incremental_quantity: float
    incremental_sales: float
    promotion_price: float | None  # realised Sum(revenue)/Sum(quantity); reporting only
    unit_cost: float | None
    incremental_cost: float


@dataclass(frozen=True)
class Volume:
    """Every volume-derived quantity for one filtered dataset, computed once."""

    products: tuple[ProductVolume, ...] = ()
    incremental_quantity: float = 0.0
    baseline_quantity: float = 0.0
    incremental_sales: float = 0.0
    incremental_cost: float = 0.0
    #: Discount given on the EXPECTED units -- the price cut on volume that would
    #: have sold anyway. The cut on the extra units is already inside
    #: Incremental Sales, which values them at the price paid.
    baseline_discount: float = 0.0
    #: The measured promoted rows, as traded and as they would have traded
    #: without the promotion (expected units at list price, at their own cost).
    promoted_revenue: float = 0.0
    promoted_cost: float = 0.0
    counterfactual_revenue: float = 0.0
    counterfactual_cost: float = 0.0
    skipped: tuple[dict[str, Any], ...] = ()

    @property
    def has_promotion(self) -> bool:
        return bool(self.products)


def _volume(rows: Sequence[WeekRow]) -> Volume:
    """Per-(product, channel) incremental volume against each promoted row's
    expected units (`_expected`) -- the primitive every other volume KPI
    derives from.

        incremental quantity = Sum over promoted rows of (Actual_Quantity - expected)
        incremental sales    = Sum over promoted rows of (Actual_Quantity - expected) x Actual_Price

    Evaluated from the aggregate grain: a row's expected units carry their own
    value at the row's prices, so Sum(Actual_Revenue) - Sum(expected value) is
    the row-level formula exactly. Each promoted row is valued at its OWN
    Actual_Price -- two discounts in one selection are never pooled.

    Negative results are kept. A promoted row below its expected level is
    genuine underperformance; clamping it at zero would turn a loss-making
    promotion into a neutral one.
    """
    expected = _expected(rows)
    acc: dict[tuple[str, str], dict[str, float]] = defaultdict(
        lambda: {
            "n_rows": 0.0, "p_qty": 0.0, "p_rev": 0.0, "p_price": 0.0, "p_rows": 0.0,
            "p_cost": 0.0, "e_units": 0.0, "e_value": 0.0, "missing": 0.0,
            "e_discount": 0.0, "e_list": 0.0, "e_cost": 0.0,
        }
    )
    for r, e in zip(rows, expected):
        a = acc[r.baseline_key]
        if r.is_promoted:
            a["p_qty"] += r.actual_quantity
            a["p_rev"] += r.actual_revenue
            a["p_price"] += r.actual_price_sum
            a["p_rows"] += r.transaction_count
            a["p_cost"] += r.total_cost
            if e is None:
                a["missing"] += r.transaction_count
            else:
                a["e_units"] += e[0]
                a["e_value"] += e[1]
                # Per-unit list price, discount and cost of this row. One
                # product at one offer: the same for every store it pools.
                if r.actual_quantity:
                    a["e_discount"] += e[0] * r.discount_value / r.actual_quantity
                    a["e_list"] += e[0] * (r.actual_revenue + r.discount_value) / r.actual_quantity
                    a["e_cost"] += e[0] * r.total_cost / r.actual_quantity
        else:
            a["n_rows"] += r.transaction_count

    products: list[ProductVolume] = []
    skipped: list[dict[str, Any]] = []
    totals: dict[str, float] = defaultdict(float)

    for key in sorted(acc):
        product_id, channel_id = key
        a = acc[key]
        if not a["p_rows"]:
            continue  # Never promoted in this selection -> contributes nothing.
        if a["missing"]:
            skipped.append({
                "product_id": product_id,
                "channel_id": channel_id,
                "promoted_rows": int(a["p_rows"]),
                "reason": "no ordinary week of this product in the selection — no baseline to measure against",
            })
            continue

        baseline_quantity = a["e_units"]
        incremental = a["p_qty"] - baseline_quantity
        sales = a["p_rev"] - a["e_value"]

        price = safe_divide(a["p_rev"], a["p_qty"])
        unit_cost = safe_divide(a["p_cost"], a["p_qty"])
        cost = incremental * unit_cost if unit_cost is not None else 0.0

        totals["baseline_discount"] += a["e_discount"]
        totals["promoted_revenue"] += a["p_rev"]
        totals["promoted_cost"] += a["p_cost"]
        totals["counterfactual_revenue"] += a["e_list"]
        totals["counterfactual_cost"] += a["e_cost"]

        products.append(ProductVolume(
            product_id=product_id,
            channel_id=channel_id,
            baseline_average=baseline_quantity / a["p_rows"],
            non_promoted_rows=int(a["n_rows"]),
            promoted_rows=int(a["p_rows"]),
            promoted_quantity=a["p_qty"],
            promoted_revenue=a["p_rev"],
            promoted_price_sum=a["p_price"],
            baseline_quantity=baseline_quantity,
            incremental_quantity=incremental,
            incremental_sales=sales,
            promotion_price=price,
            unit_cost=unit_cost,
            incremental_cost=cost,
        ))

    return Volume(
        products=tuple(products),
        incremental_quantity=sum(p.incremental_quantity for p in products),
        baseline_quantity=sum(p.baseline_quantity for p in products),
        incremental_sales=sum(p.incremental_sales for p in products),
        incremental_cost=sum(p.incremental_cost for p in products),
        baseline_discount=totals["baseline_discount"],
        promoted_revenue=totals["promoted_revenue"],
        promoted_cost=totals["promoted_cost"],
        counterfactual_revenue=totals["counterfactual_revenue"],
        counterfactual_cost=totals["counterfactual_cost"],
        skipped=tuple(skipped),
    )


def calculate_incremental_quantity(rows: Sequence[WeekRow]) -> float | None:
    """Sum over promoted rows of (Actual_Quantity - expected units). May be
    negative; not clamped."""
    if not rows:
        return None
    return _round(_volume(rows).incremental_quantity, 0)


def calculate_incremental_quantity_percent(rows: Sequence[WeekRow]) -> float | None:
    """Incremental quantity against the counterfactual it was measured from —
    the volume those same promoted rows would have moved at ordinary levels."""
    if not rows:
        return None
    volume = _volume(rows)
    ratio = safe_divide(volume.incremental_quantity, volume.baseline_quantity)
    return None if ratio is None else _round(ratio * 100, 2)


def calculate_incremental_sales(rows: Sequence[WeekRow]) -> float | None:
    """Sum over promoted rows of (Actual_Quantity - baseline) x Actual_Price,
    valued at each row's OWN price.

    The single source of truth for incremental revenue: ROI, Trade Spend
    Efficiency and PEI all read this rather than recomputing it.
    """
    if not rows:
        return None
    return _round(_volume(rows).incremental_sales, 2)


def average_promotion_price(rows: Sequence[WeekRow]) -> float | None:
    """Realised price across all promoted volume. Reporting only — incremental
    sales values each product at its own price, never at this pooled one."""
    promo = promotion_rows(rows)
    if not promo:
        return None
    return safe_divide(
        _sum(promo, lambda r: r.actual_revenue), _sum(promo, lambda r: r.actual_quantity)
    )


def calculate_incremental_profit(
    rows: Sequence[WeekRow], volume_rows: Sequence[WeekRow] | None = None
) -> float | None:
    """Incremental Sales - Incremental Product Cost - Trade Spend: what the
    extra volume brought in, less what it cost to make and to move.

    Reads the two sets the same way `calculate_roi` does -- uplift and its
    product cost from the baseline-widened `volume_rows`, spend from the
    selection itself. The two agree on spend anyway (a non-promoted row
    contributes nothing to it), so the split is about reading the same rows
    ROI reads, not about a different number.
    """
    if not rows:
        return None
    volume = _volume(volume_rows if volume_rows is not None else rows)
    if not volume.has_promotion:
        return None
    spend = calculate_trade_spend(rows) or 0.0
    return _round(volume.incremental_sales - volume.incremental_cost - spend, 2)


def calculate_net_incremental_profit(
    rows: Sequence[WeekRow],
    volume_rows: Sequence[WeekRow] | None = None,
    cannibalized_margin: float | None = 0.0,
) -> float | None:
    """The change in profit the promotions caused.

        Margin Impact - Promotion Cost - margin lost on cannibalized sister packs

    Margin Impact is the gross margin the promoted rows earned above what they
    would have earned without the promotion (`calculate_margin_impact`), so
    the discount and the extra units are both already in it; what is left is
    the promotion's running cost and the margin it took from neighbouring
    pack sizes. The two cards reconcile by subtraction.

    Margin Impact reads the baseline-widened `volume_rows`; Promotion Cost the
    selection itself.
    """
    if not rows:
        return None
    margin = calculate_margin_impact(rows, volume_rows, precision=None)
    if margin is None:
        return None
    promotion_cost = _sum(rows, lambda r: r.promotion_cost)
    return _round(margin - promotion_cost - (cannibalized_margin or 0.0), 2)


# --- ROI, margin, efficiency -----------------------------------------------


def roi_multiple(
    incremental_sales: float | None,
    trade_spend: float | None,
    precision: int | None = 2,
) -> float | None:
    """THE Promotion ROI formula. One expression, one rounding rule.

        ROI = Incremental Sales / Trade Spend

    A multiple, displayed as `1.40`: every rupee of trade spend brought back
    1.40 rupees of incremental sales. 1.00 is break-even — the spend came back
    and nothing more — and anything below it lost money. (The earlier
    definition, `(Incremental Sales - Trade Spend) / Trade Spend x 100`, was
    the same ratio less one, in percent; 40.0% on the old scale is 1.40 here.)

    TWO DECIMAL PLACES -- the one deliberate exception to the project's
    one-decimal rule. A 0.1 step on this scale is ten points of the old one:
    the -3.6% event that reads 0.96 here would round to 1.00 and pass for
    break-even, which is a different and false claim.

    Every ROI the Insights Hub shows goes through this function — the KPI
    card via `calculate_roi`, and each promotion event via the service layer,
    which then feeds the Risk Alerts' displayed ROI, their severity banding,
    and the Underperforming Promotions table. The inputs differ (whole
    selection vs one event); the arithmetic cannot.

    Null — never zero, never infinite — when nothing was spent: there is no
    return to express against no investment.

    `precision` rounds the RESULT and nothing else. `None` returns the same
    arithmetic unrounded, for a period-over-period delta that must not be taken
    from two already-rounded numbers (see `_precise`). The inputs are whatever
    the caller passed either way — this parameter never reaches inside the
    formula.
    """
    if incremental_sales is None or trade_spend is None:
        return None
    ratio = safe_divide(incremental_sales, trade_spend)
    if ratio is None:
        return None
    return ratio if precision is None else _round(ratio, precision)


def calculate_roi(
    rows: Sequence[WeekRow],
    volume_rows: Sequence[WeekRow] | None = None,
    precision: int | None = 2,
) -> float | None:
    """Promotion ROI for a whole filtered selection — the KPI card.

    `volume_rows` is the selection widened with the non-promoted rows the
    baseline needs; it defaults to `rows` and differs only under an Offer
    filter. Trade Spend still comes from the selection itself — and the two
    agree numerically anyway, because a non-promoted row carries
    Base_Revenue == Actual_Revenue and a zero Promotion_Cost and so
    contributes nothing to spend.
    """
    if not rows:
        return None
    return roi_multiple(
        calculate_incremental_sales(volume_rows if volume_rows is not None else rows),
        calculate_trade_spend(rows),
        precision=precision,
    )


def calculate_margin(rows: Sequence[WeekRow], precision: int | None = 2) -> float | None:
    """Gross margin retained across the filtered period.

        Sum(Actual_Revenue - Total_Cost) / Sum(Actual_Revenue) x 100

    One ratio of summed revenue and cost, not an average of per-row margins —
    averaging ratios across rows of very different sizes is the classic error
    this deliberately avoids.
    """
    if not rows:
        return None
    revenue = _sum(rows, lambda r: r.actual_revenue)
    ratio = safe_divide(revenue - _sum(rows, lambda r: r.total_cost), revenue)
    if ratio is None:
        return None
    # `precision` rounds the RESULT only — see roi_multiple.
    return ratio * 100 if precision is None else _round(ratio * 100, precision)


def calculate_margin_impact(
    rows: Sequence[WeekRow],
    volume_rows: Sequence[WeekRow] | None = None,
    precision: int | None = 2,
) -> float | None:
    """The gross margin the promotions added, in money.

        gross margin of the promoted rows as sold
        - gross margin the SAME rows would have earned without the promotion
          (their expected units at list price, at their own unit cost)

    Gross margin = revenue - Total_Cost. The discount lowers the margin on
    every unit; the extra units add margin back. Positive when the extra
    volume more than pays for the price cut. Promotion cost is not in it --
    Net Incremental Profit takes that off. Null when nothing in the selection
    was promoted and measured.
    """
    if not rows:
        return None
    volume = _volume(volume_rows if volume_rows is not None else rows)
    if not volume.has_promotion:
        return None
    change = (
        (volume.promoted_revenue - volume.promoted_cost)
        - (volume.counterfactual_revenue - volume.counterfactual_cost)
    )
    return change if precision is None else _round(change, precision)


def calculate_trade_spend_efficiency(
    rows: Sequence[WeekRow], volume_rows: Sequence[WeekRow] | None = None
) -> float | None:
    """Incremental Sales / Trade Spend x 100 — returned per rupee invested."""
    if not rows:
        return None
    spend = calculate_trade_spend(rows)
    sales = calculate_incremental_sales(volume_rows if volume_rows is not None else rows)
    if spend is None or sales is None:
        return None
    ratio = safe_divide(sales, spend)
    return None if ratio is None else _round(ratio * 100, 2)


# --- trend series ----------------------------------------------------------


@dataclass(frozen=True)
class PeriodPoint:
    """One period's slice of the additive KPIs."""

    period_key: str
    trade_spend: float
    incremental_sales: float
    incremental_quantity: float = 0.0
    promoted_quantity: float = 0.0
    incremental_cost: float = 0.0
    baseline_discount: float = 0.0
    promotion_cost: float = 0.0
    margin_impact: float = 0.0


def period_series(rows: Sequence[WeekRow], key: Callable[[WeekRow], str]) -> list[PeriodPoint]:
    """Trade Spend and Incremental Sales split across periods (or events), for
    the trend chart and the event list. The parts sum EXACTLY to
    `calculate_trade_spend(rows)` and `calculate_incremental_sales(rows)`
    over the same selection.

    Not a second definition of either KPI -- the same arithmetic, grouped.
    Every promoted row carries its own expected units (`_expected`), so its
    incremental is its own and grouping cannot move it. A (product, channel)
    `_volume` skips for want of a baseline is skipped here too.

    Sorted by period key, which is zero-padded ("2025-W07", "2025-03") and so
    sorts chronologically as a string, across a year boundary too.
    """
    expected = _expected(rows)
    skipped = {r.baseline_key for r, e in zip(rows, expected) if r.is_promoted and e is None}
    # Unit cost per (product, channel) over its promoted rows -- the rate
    # `_volume` costs the extra units at, so event costs add up to its total.
    promo_qty: dict[tuple[str, str], float] = defaultdict(float)
    promo_cost: dict[tuple[str, str], float] = defaultdict(float)
    for r in rows:
        if r.is_promoted:
            promo_qty[r.baseline_key] += r.actual_quantity
            promo_cost[r.baseline_key] += r.total_cost

    spend: dict[str, float] = defaultdict(float)
    sales: dict[str, float] = defaultdict(float)
    quantity: dict[str, float] = defaultdict(float)
    gross: dict[str, float] = defaultdict(float)
    cost: dict[str, float] = defaultdict(float)
    base_discount: dict[str, float] = defaultdict(float)
    overhead: dict[str, float] = defaultdict(float)
    margin: dict[str, float] = defaultdict(float)
    for r, e in zip(rows, expected):
        period = key(r)
        spend[period] += r.discount_value + r.promotion_cost
        overhead[period] += r.promotion_cost
        if r.is_promoted and r.baseline_key not in skipped:
            extra = r.actual_quantity - e[0]
            sales[period] += r.actual_revenue - e[1]
            quantity[period] += extra
            gross[period] += r.actual_quantity
            unit_cost = safe_divide(promo_cost[r.baseline_key], promo_qty[r.baseline_key])
            cost[period] += extra * unit_cost if unit_cost is not None else 0.0
            if r.actual_quantity:
                base_discount[period] += e[0] * r.discount_value / r.actual_quantity
                list_price = (r.actual_revenue + r.discount_value) / r.actual_quantity
                unit_cost_row = r.total_cost / r.actual_quantity
                margin[period] += (r.actual_revenue - r.total_cost) - e[0] * (list_price - unit_cost_row)
    return [
        PeriodPoint(
            period_key=period,
            trade_spend=round(spend[period], 2),
            # A period with no promoted row has no incremental sales -- 0, not a
            # gap: it traded, it simply ran no promotion.
            incremental_sales=round(sales.get(period, 0.0), 2),
            incremental_quantity=round(quantity.get(period, 0.0), 2),
            promoted_quantity=round(gross.get(period, 0.0), 2),
            incremental_cost=round(cost.get(period, 0.0), 2),
            baseline_discount=round(base_discount.get(period, 0.0), 2),
            promotion_cost=round(overhead.get(period, 0.0), 2),
            margin_impact=round(margin.get(period, 0.0), 2),
        )
        for period in sorted(spend)
    ]


# --- cannibalization -------------------------------------------------------


def _adjacent_ranks(promoted_rank: int) -> tuple[int, ...]:
    """A promoted SKU pulls from the pack sizes immediately either side of it.

    Rank is the SKU's position in its Brand Form ordered by pack size, so rank
    2 neighbours 1 and 3, and rank 4 neighbours only 3. Rank 1 (the smallest
    pack) is never promoted in this data — verified: 0 promoted rows at rank 1
    against 24,210 / 24,660 / 11,430 at ranks 2/3/4 — but it is the primary
    victim, so it appears as a neighbour and never as a promoter.
    """
    return tuple(r for r in (promoted_rank - 1, promoted_rank + 1) if 1 <= r <= 4)


def _sku_baselines(rows: Sequence[WeekRow]) -> dict[tuple[str, str], float]:
    """mean(Base_Quantity) over each (product, channel)'s NON-promoted rows --
    the flat whole-selection level, kept for the Simulation Studio's lift fit.
    The KPIs measure against `_expected` instead.

    The same baseline definition Incremental Sales uses, computed inside the
    current filter context — so a Region or Retailer selection re-derives the
    baseline from that scope's own ordinary trading rather than borrowing a
    global one. A product with no non-promoted row gets no entry and is
    skipped downstream; its baseline is never defaulted to zero.
    """
    acc: dict[tuple[str, str], list[float]] = defaultdict(lambda: [0.0, 0.0])
    for r in rows:
        if not r.is_promoted:
            a = acc[r.baseline_key]
            a[0] += r.base_quantity
            a[1] += r.transaction_count
    return {key: base / n for key, (base, n) in acc.items() if n}


@dataclass(frozen=True)
class CannibalizationEvent:
    """One promotion event: a promoted SKU in one Brand Form in one week."""

    brand_form: str
    week_key: str
    channel_id: str
    promoted_product_id: str
    promoted_rank: int
    promotion_id: str
    promoted_baseline: float
    promoted_expected: float
    promoted_actual: float
    increment: float  # promoted_actual - promoted_expected, > 0
    neighbours: tuple[dict[str, Any], ...]
    cannibalized: float  # Sum of the neighbours' clamped losses
    cannibalized_margin: float = 0.0  # those units at the neighbours' gross margin


#: The last few `cannibalization_detail` results, keyed on the identity of the
#: rows they were measured on. One page load asks for the same selection's
#: cannibalization several times (the card, its delta, the score, the debug
#: trace, Net Incremental Profit); the rows are immutable tuples, so the same
#: object is the same answer.
_CANNIBALIZATION_MEMO: list[tuple[Sequence[WeekRow], frozenset[str] | None, dict[str, Any]]] = []
_CANNIBALIZATION_MEMO_SIZE = 16


def cannibalization_detail(
    rows: Sequence[WeekRow], promoted_products: frozenset[str] | None = None
) -> dict[str, Any]:
    for cached_rows, cached_products, result in _CANNIBALIZATION_MEMO:
        if cached_rows is rows and cached_products == promoted_products:
            return result
    result = _cannibalization_detail(rows, promoted_products)
    _CANNIBALIZATION_MEMO.append((rows, promoted_products, result))
    del _CANNIBALIZATION_MEMO[:-_CANNIBALIZATION_MEMO_SIZE]
    return result


def _cannibalization_detail(
    rows: Sequence[WeekRow], promoted_products: frozenset[str] | None = None
) -> dict[str, Any]:
    """Cannibalization at event, Brand Form and overall grain.

        loss(neighbour)   = max(its expected units - its actual units, 0)
        increment(promo)  = its actual units - its expected units
        rate              = Sum loss / Sum increment x 100

    Expected units are the engine's (`_expected`) for the promoted SKU, and the
    neighbour's own nearby ordinary weeks (`_local_baselines`) for the
    neighbour -- whose Base_Quantity on an un-promoted week is just its sales,
    so it cannot stand in for what the week would have been. The lost units
    are also valued at the neighbour's gross margin, `cannibalized_margin`,
    which Net Incremental Profit charges against the promotion.

    A *promotion event* is one (Brand Form, channel, business week, promoted
    SKU). The channel is part of the identity because a weekly-grain channel
    and a monthly-grain one are not comparable observations.

    Only losses count. A neighbour trading ABOVE its baseline was not
    cannibalized, and letting that subtract would net one Brand Form's loss
    against another's growth and understate the effect — hence max(..., 0) per
    neighbour. A neighbour on its own promotion that week is skipped entirely:
    its movement is its own uplift, not the promoted SKU's theft.

    An event whose promoted SKU shows no uplift (increment <= 0) is dropped
    from BOTH sides. There is no promotional gain for a loss to be a share of,
    and admitting it would put a negative or zero number in the denominator.

    Everything is confined to one Brand Form. Neighbours are the pack sizes
    immediately either side of the promoted rank, never across brands or
    categories.

    `promoted_products` restricts which SKUs may act as the PROMOTER. It
    carries the Product filter: the selection names the SKU under
    investigation, and its Brand Form siblings are present only so they can be
    measured as victims.
    """
    empty: dict[str, Any] = {
        "overall": None, "overall_exact": None, "score": None, "by_brand_form": {},
        "events": [], "comparable_events": 0, "excluded_events": 0, "excluded": [],
        "cannibalized_quantity": None, "incremental_quantity": None,
        "cannibalized_margin": None,
    }
    if not rows:
        return empty

    local = _local_baselines(rows)
    expected = _expected(rows, local)

    # (brand form, channel, week) -> rank -> that SKU's row indices that week.
    grid: dict[tuple[str, str, str], dict[int, list[int]]] = defaultdict(lambda: defaultdict(list))
    for i, r in enumerate(rows):
        grid[(r.brand_form, r.channel_id, r.week_key)][r.product_rank].append(i)

    events: list[CannibalizationEvent] = []
    excluded: list[dict[str, Any]] = []

    for (brand_form, channel_id, week_key), by_rank in sorted(grid.items()):
        for promoted_rank, idxs in sorted(by_rank.items()):
            promo = [i for i in idxs if rows[i].is_promoted]
            if not promo:
                continue  # Not a promotion event for this SKU this week.

            product_id = rows[promo[0]].product_id
            if promoted_products is not None and product_id not in promoted_products:
                continue
            if any(expected[i] is None for i in promo):
                excluded.append({
                    "brand_form": brand_form, "channel_id": channel_id, "week": week_key,
                    "rank": promoted_rank,
                    "reason": "promoted SKU has no baseline in this selection — no ordinary "
                              "week to measure its uplift against",
                })
                continue

            promo_txns = sum(rows[i].transaction_count for i in promo)
            expected_units = sum(expected[i][0] for i in promo)
            actual = sum(rows[i].actual_quantity for i in promo)
            increment = actual - expected_units
            if increment <= 0:
                excluded.append({
                    "brand_form": brand_form, "channel_id": channel_id, "week": week_key,
                    "rank": promoted_rank,
                    "reason": "no promotional uplift (actual <= expected) — nothing for a "
                              "neighbour's loss to be a share of",
                })
                continue

            neighbours: list[dict[str, Any]] = []
            cannibalized = 0.0
            lost_margin = 0.0
            for rank in _adjacent_ranks(promoted_rank):
                nb = by_rank.get(rank)
                if not nb:
                    continue
                # The neighbour must be genuinely un-promoted that week.
                clean = [i for i in nb if not rows[i].is_promoted]
                if not clean or any(rows[i].is_promoted for i in nb):
                    excluded.append({
                        "brand_form": brand_form, "channel_id": channel_id, "week": week_key,
                        "pair": f"rank{promoted_rank}->rank{rank}",
                        "reason": "neighbour was itself on promotion that week",
                    })
                    continue
                nb_id = rows[clean[0]].product_id
                if any(local[i] is None for i in clean):
                    excluded.append({
                        "brand_form": brand_form, "channel_id": channel_id, "week": week_key,
                        "pair": f"rank{promoted_rank}->rank{rank}",
                        "reason": "neighbour has no other ordinary week in this selection",
                    })
                    continue
                nb_txns = sum(rows[i].transaction_count for i in clean)
                nb_expected = sum(local[i] * rows[i].transaction_count for i in clean)
                nb_actual = sum(rows[i].actual_quantity for i in clean)
                loss = max(nb_expected - nb_actual, 0.0)
                nb_revenue = sum(rows[i].actual_revenue for i in clean)
                nb_cost = sum(rows[i].total_cost for i in clean)
                unit_margin = safe_divide(nb_revenue - nb_cost, nb_actual) or 0.0
                margin = loss * unit_margin
                cannibalized += loss
                lost_margin += margin
                neighbours.append({
                    "product_id": nb_id, "rank": rank,
                    "baseline": round(nb_expected / nb_txns, 2), "transactions": nb_txns,
                    "expected": round(nb_expected, 2), "actual": round(nb_actual, 2),
                    "loss": round(loss, 2), "lost_margin": round(margin, 2),
                })

            if not neighbours:
                excluded.append({
                    "brand_form": brand_form, "channel_id": channel_id, "week": week_key,
                    "rank": promoted_rank,
                    "reason": "no adjacent SKU available to measure cannibalization against",
                })
                continue

            events.append(CannibalizationEvent(
                brand_form=brand_form, week_key=week_key, channel_id=channel_id,
                promoted_product_id=product_id, promoted_rank=promoted_rank,
                promotion_id=rows[promo[0]].promotion_id,
                promoted_baseline=expected_units / promo_txns, promoted_expected=expected_units,
                promoted_actual=actual, increment=increment,
                neighbours=tuple(neighbours), cannibalized=cannibalized,
                cannibalized_margin=lost_margin,
            ))

    if not events:
        return {**empty, "excluded": excluded, "excluded_events": len(excluded)}

    total_loss = sum(e.cannibalized for e in events)
    total_increment = sum(e.increment for e in events)
    overall = safe_divide(total_loss, total_increment)
    if overall is None:
        return {**empty, "excluded": excluded, "excluded_events": len(excluded)}
    overall *= 100

    # Per Brand Form, the same ratio over that Brand Form's own events — a
    # ratio of sums, never a mean of ratios.
    by_brand: dict[str, float] = {}
    for brand_form in {e.brand_form for e in events}:
        mine = [e for e in events if e.brand_form == brand_form]
        ratio = safe_divide(sum(e.cannibalized for e in mine), sum(e.increment for e in mine))
        if ratio is not None:
            by_brand[brand_form] = round(ratio * 100, 2)

    return {
        "overall": _round(overall, 2),
        # Full precision, for the year-over-year delta. Dividing two values
        # already rounded to 1 dp moves the delta materially when the rates are
        # small. The card still SHOWS `overall`; only the delta reads this.
        "overall_exact": overall,
        "score": cannibalization_score(overall),
        "cannibalized_quantity": _round(total_loss, 2),
        "incremental_quantity": _round(total_increment, 2),
        "cannibalized_margin": _round(sum(e.cannibalized_margin for e in events), 2),
        "by_brand_form": dict(sorted(by_brand.items(), key=lambda kv: -kv[1])),
        "events": [
            {
                "brand_form": e.brand_form, "week": e.week_key, "channel_id": e.channel_id,
                "promoted_product_id": e.promoted_product_id, "promoted_rank": e.promoted_rank,
                "promotion_id": e.promotion_id,
                "promoted_baseline": round(e.promoted_baseline, 2),
                "promoted_expected": round(e.promoted_expected, 2),
                "promoted_actual": round(e.promoted_actual, 2),
                "increment": round(e.increment, 2),
                "cannibalized": round(e.cannibalized, 2),
                "cannibalized_margin": round(e.cannibalized_margin, 2),
                "neighbours": list(e.neighbours),
            }
            for e in sorted(events, key=lambda e: -e.cannibalized)
        ],
        "comparable_events": len(events),
        "excluded_events": len(excluded),
        "excluded": excluded,
    }


def calculate_cannibalization(
    rows: Sequence[WeekRow], promoted_products: frozenset[str] | None = None
) -> float | None:
    """Share of a promotion's extra volume that came out of its neighbours.

        Total Cannibalized Quantity / Promotional Incremental Quantity x 100

    Both quantities are accumulated over promotion events and divided once at
    the end. Returns None — never a fabricated number — when the selection
    cannot support the metric.
    """
    if not rows:
        return None
    return cannibalization_detail(rows, promoted_products)["overall"]


def cannibalization_score(rate_pct: float | None) -> float | None:
    if rate_pct is None:
        return None
    rate = max(rate_pct, 0.0)
    for ceiling, score in CANNIBALIZATION_SCORE_BUCKETS:
        if ceiling is None or rate <= ceiling:
            return float(score)
    return 20.0


# --- PEI -------------------------------------------------------------------


def calculate_pei(
    rows: Sequence[WeekRow],
    volume_rows: Sequence[WeekRow] | None = None,
    precision: int | None = 0,
) -> float | None:
    """0-100 composite, computed LAST — every component is one of the KPIs
    above, not a parallel calculation.

        PEI = 0.40(ROI net return) + 0.30(Incremental qty %) + 0.30(Gross margin %)

    each component divided by its ceiling and clamped onto 0-100 first. The
    ROI component is the multiple less 1.0 (see `PEI_SCALE`), so the index is
    numerically what it was when ROI was expressed as a net percentage. A
    component with no value contributes nothing and ITS WEIGHT IS
    REDISTRIBUTED across the rest, so PEI stays on a 0-100 scale rather than
    being dragged toward zero whenever one input is undefined.

    Null when nothing in the selection was promoted. Two of the three
    components are undefined in that case and the redistribution would collapse
    the index onto Margin Impact alone — scoring a never-promoted SKU purely on
    its gross margin. There is no promotion to index the efficiency of.
    """
    volume = volume_rows if volume_rows is not None else rows
    if not rows or not promotion_rows(volume):
        return None

    components: list[tuple[float, float]] = []

    def add(raw: float | None, cap: float, weight: float) -> None:
        if raw is not None:
            components.append((_clamp(raw / cap, 0, 1) * 100, weight))

    # The ROI component is taken UNROUNDED. The card's 1 dp multiple is a
    # even a 0.01 step is a point of net return, and the composite should not
    # inherit display rounding at all. The percent-scale ROI this index was calibrated on carried three more
    # digits, and the unrounded multiple is that same figure.
    roi = calculate_roi(rows, volume, precision=None)
    add(None if roi is None else roi - 1, PEI_SCALE["roi_net_return_cap"], PEI_WEIGHTS["roi"])
    add(
        calculate_incremental_quantity_percent(volume),
        PEI_SCALE["incremental_quantity_cap_pct"],
        PEI_WEIGHTS["incremental_quantity_percent"],
    )
    add(calculate_margin(rows), PEI_SCALE["margin_cap_pct"], PEI_WEIGHTS["gross_margin"])

    if not components:
        return None
    total_weight = sum(w for _, w in components)
    weighted = sum(s * w for s, w in components)
    index = safe_divide(weighted, total_weight)
    # `precision` rounds the RESULT only. The two percentage COMPONENTS keep
    # their own rounding whatever is asked for here: they are the KPIs as this
    # project defines them, and re-deriving the index from unrounded components
    # would be a different composite -- and would move the score on the card.
    # ROI is the exception, for the reason given where it is added.
    return index if precision is None else _round(index, precision)


# --- period-over-period ----------------------------------------------------


def calculate_growth(value: float | None, previous: float | None) -> KpiMetric:
    """A KPI and its movement against the comparison period.

    When there is no comparable prior period, the movement is left undefined
    rather than reported as 0% — a fabricated zero reads as "no change", which
    is a different and false statement.
    """
    if value is None:
        return KpiMetric(value=None, previous_year=previous)
    if previous is None or previous == 0:
        return KpiMetric(value=value, previous_year=previous)
    difference = value - previous
    return KpiMetric(
        value=value,
        previous_year=previous,
        difference=round(difference, 2),
        growth=round(difference / abs(previous) * 100, 2),
    )


def _precise(current: float | None, previous: float | None, digits: int) -> KpiMetric:
    """A KPI and its movement, with the MOVEMENT TAKEN BEFORE ROUNDING.

    Two rounded numbers make a wrong ratio. PEI is reported as a whole number,
    so a delta computed from the reported pair moved by up to 0.4 percentage
    points against the same delta taken from the underlying values -- and ROI
    and Margin Impact, reported to one decimal, moved by up to 0.1 (0.01 for
    the ROI multiple, reported to two).

    So the pair arrives here unrounded, the growth is taken from it, and only
    the REPORTED values are rounded afterwards. The card's value is unchanged
    by construction: rounding the unrounded result to the same precision the
    KPI function used is the same number it already returned.

    `_cannibalization_metric` below has always worked this way; this is that
    pattern, applied to the KPIs that were still dividing rounded figures.
    """
    metric = calculate_growth(current, previous)
    return KpiMetric(
        value=_round(current, digits),
        previous_year=_round(previous, digits),
        # The difference at the KPI's own precision, from the unrounded pair.
        difference=None if metric.difference is None else _round(current - previous, digits),
        growth=metric.growth,
    )


def _cannibalization_metric(
    rows: Sequence[WeekRow],
    previous_rows: Sequence[WeekRow],
    promoted_products: frozenset[str] | None = None,
) -> KpiMetric:
    """Cannibalization with a comparison delta computed at full precision.

    Each period's rate is derived from its own promotions and its own
    baselines; the delta is then taken from the two UNROUNDED rates and only
    the reported values are rounded for display.
    """
    def exact(source: Sequence[WeekRow]) -> float | None:
        return cannibalization_detail(source, promoted_products)["overall_exact"] if source else None

    metric = calculate_growth(exact(rows), exact(previous_rows))
    return KpiMetric(
        value=_round(metric.value, 2),
        previous_year=_round(metric.previous_year, 2),
        difference=_round(metric.difference, 2),
        growth=metric.growth,
    )


def _pct(ratio: float | None) -> float | None:
    return None if ratio is None else ratio * 100


def build_debug(
    rows: Sequence[WeekRow],
    cannib_rows: Sequence[WeekRow] = (),
    promoted_products: frozenset[str] | None = None,
    volume_rows: Sequence[WeekRow] | None = None,
) -> dict[str, Any]:
    """Every KPI traceable back to the numbers behind it, so any headline
    figure can be reproduced by hand from the filtered data."""
    vrows = volume_rows if volume_rows is not None else rows
    volume = _volume(vrows)
    cannibalization = cannibalization_detail(cannib_rows or rows, promoted_products)
    return {
        "rows_in_scope": len(rows),
        "volume_rows_in_scope": len(vrows),
        "promoted_rows": len(promotion_rows(vrows)),
        "promoted_product_channels": len(volume.products),
        "average_promotion_price": _round(average_promotion_price(vrows), 2),
        # Margin Impact's own inputs, so the card reconciles against the fact
        # table without a second query.
        "actual_revenue": _round(_sum(rows, lambda r: r.actual_revenue), 2),
        "total_cost": _round(_sum(rows, lambda r: r.total_cost), 2),
        "baseline_quantity": _round(volume.baseline_quantity, 2),
        "incremental_product_cost": _round(volume.incremental_cost, 2),
        "incremental_profit": calculate_incremental_profit(rows, vrows),
        "cannibalized_margin": cannibalization["cannibalized_margin"],
        "net_incremental_profit": calculate_net_incremental_profit(
            rows, vrows, cannibalization["cannibalized_margin"]
        ),
        # Net Incremental Profit's terms beyond the headline cards.
        "baseline_discount": _round(volume.baseline_discount, 2),
        # Margin Impact's two sides -- the promoted rows as traded and as they
        # would have traded without the promotion -- and the gross margin PEI scores.
        "margin_promoted": _round(volume.promoted_revenue - volume.promoted_cost, 2),
        "margin_without_promotion": _round(
            volume.counterfactual_revenue - volume.counterfactual_cost, 2),
        "gross_margin": calculate_margin(rows),
        "products_without_baseline": list(volume.skipped),
        # --- KPIs ---
        "trade_spend": _round(calculate_trade_spend(rows), 2),
        # The two halves of Trade Spend, so the card reconciles: discount +
        # promotion cost == trade spend.
        "trade_spend_discount": _round(_sum(rows, lambda r: r.discount_value), 2),
        "trade_spend_promotion_cost": _round(_sum(rows, lambda r: r.promotion_cost), 2),
        "incremental_quantity": calculate_incremental_quantity(vrows),
        "incremental_quantity_percent": calculate_incremental_quantity_percent(vrows),
        "incremental_sales": calculate_incremental_sales(vrows),
        "roi": calculate_roi(rows, vrows),
        "margin_impact": calculate_margin_impact(rows, vrows),
        "trade_spend_efficiency": calculate_trade_spend_efficiency(rows, vrows),
        "cannibalization_rate": cannibalization["overall"],
        "cannibalization_score": cannibalization["score"],
        "pei": calculate_pei(rows, vrows),
        "cannibalization_debug": {
            "total_cannibalized_quantity": cannibalization["cannibalized_quantity"],
            "promotional_incremental_quantity": cannibalization["incremental_quantity"],
            "rate": cannibalization["overall"],
            "score": cannibalization["score"],
            "events": cannibalization["events"][:25],
        },
        "brand_form_cannibalization": cannibalization["by_brand_form"],
        "comparable_events": cannibalization["comparable_events"],
        "excluded_events": cannibalization["excluded_events"],
        "excluded_detail": cannibalization["excluded"][:25],
        "per_product": _per_product_rollup(volume),
    }


def _per_product_rollup(volume: Volume) -> list[dict[str, Any]]:
    """One row per promoted (product, channel): the baseline, the rows behind
    it, and the incremental it produced.

    `baseline_avg` is the number the whole calculation turns on. It is reported
    unrounded to 4 dp precisely so nobody mistakes it for a constant: it is
    the promoted rows' expected units per store-week in THIS
    selection, and it moves with every filter.
    """
    return sorted(
        (
            {
                "product_id": p.product_id,
                "channel_id": p.channel_id,
                "baseline_avg": round(p.baseline_average, 2),
                "non_promo_rows": p.non_promoted_rows,
                "promo_rows": p.promoted_rows,
                "promoted_quantity": round(p.promoted_quantity, 2),
                "baseline_quantity": round(p.baseline_quantity, 2),
                "incremental": round(p.incremental_quantity, 2),
                "promotion_price": _round(p.promotion_price, 2),
                "unit_cost": _round(p.unit_cost, 2),
                "incremental_sales": round(p.incremental_sales, 2),
                "incremental_cost": round(p.incremental_cost, 2),
            }
            for p in volume.products
        ),
        key=lambda p: -p["incremental_sales"],
    )


def calculate_kpis(
    rows: Sequence[WeekRow],
    previous_rows: Sequence[WeekRow] = (),
    family_rows: Sequence[WeekRow] = (),
    previous_family_rows: Sequence[WeekRow] = (),
    promoted_products: frozenset[str] | None = None,
    volume_rows: Sequence[WeekRow] | None = None,
    previous_volume_rows: Sequence[WeekRow] | None = None,
) -> KpiBundle:
    """Every KPI for one filtered dataset, with its comparison-period delta.

    `previous_rows` is the SAME filter set applied to the comparison period —
    never the unfiltered history. Pass nothing when there is no comparable
    period and every `growth` comes back None.

    `family_rows` is the same selection with the Product filter widened to the
    whole Brand Form, used ONLY by cannibalization — which needs the promoted
    SKU's neighbours and would have nothing to compare against if a Product
    filter had already removed them. Falls back to `rows` when not supplied.
    """
    def both(fn: Callable[[Sequence[WeekRow]], float | None]) -> KpiMetric:
        """A KPI over the SELECTION — Trade Spend and Margin Impact."""
        return calculate_growth(fn(rows), fn(previous_rows))

    def volume(fn: Callable[[Sequence[WeekRow]], float | None]) -> KpiMetric:
        """A KPI over the baseline-widened set — the volume chain."""
        return calculate_growth(fn(vrows), fn(prior_vrows))

    def paired(fn: Callable[..., float | None]) -> KpiMetric:
        """A KPI reading both: spend from the selection, uplift from the
        baseline-widened set."""
        return calculate_growth(fn(rows, vrows), fn(previous_rows, prior_vrows))

    # An empty SELECTION means nothing was selected, full stop. The widened set
    # can still hold baseline rows (an Offer filter keeps them), and reporting
    # an incremental of zero off those would put a number on a card whose own
    # population is empty.
    vrows = (volume_rows if volume_rows is not None else rows) if rows else ()
    prior_vrows = (
        (previous_volume_rows if previous_volume_rows is not None else previous_rows)
        if previous_rows else ()
    )
    cannib_rows = family_rows or rows
    cannib_prior = previous_family_rows or previous_rows

    def lost_margin(source: Sequence[WeekRow]) -> float:
        """Gross margin the sister packs lost, as the Cannibalization card measures it."""
        if not source:
            return 0.0
        return cannibalization_detail(source, promoted_products)["cannibalized_margin"] or 0.0

    return KpiBundle(
        trade_spend=both(calculate_trade_spend),
        incremental_quantity=volume(calculate_incremental_quantity),
        incremental_quantity_percent=volume(calculate_incremental_quantity_percent),
        incremental_sales=volume(calculate_incremental_sales),
        # ROI, Margin Impact and PEI take their delta from the unrounded pair
        # -- see `_precise`. Trade Spend and Incremental Sales stay on the
        # generic path: they are rounded to 2dp on figures in the hundreds of
        # millions, so the reported delta is already the full-precision one.
        roi=_precise(
            calculate_roi(rows, vrows, precision=None),
            calculate_roi(previous_rows, prior_vrows, precision=None),
            2,
        ),
        margin_impact=_precise(
            calculate_margin_impact(rows, vrows, precision=None),
            calculate_margin_impact(previous_rows, prior_vrows, precision=None),
            2,
        ),
        trade_spend_efficiency=paired(calculate_trade_spend_efficiency),
        incremental_profit=paired(calculate_incremental_profit),
        net_incremental_profit=calculate_growth(
            calculate_net_incremental_profit(rows, vrows, lost_margin(cannib_rows)),
            calculate_net_incremental_profit(previous_rows, prior_vrows, lost_margin(cannib_prior)),
        ),
        cannibalization=_cannibalization_metric(cannib_rows, cannib_prior, promoted_products),
        cannibalization_score=cannibalization_score(
            calculate_cannibalization(cannib_rows, promoted_products)
        ),
        # PEI reads `rows` — the selection as filtered. Its three components
        # are all computed off that same selection, so the family-widening
        # applied to cannibalization does not reach PEI.
        pei=_precise(
            calculate_pei(rows, vrows, precision=None),
            calculate_pei(previous_rows, prior_vrows, precision=None),
            0,
        ),
        debug=build_debug(rows, cannib_rows, promoted_products, vrows),
    )
