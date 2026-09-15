"""General Optimization -- allocate a trade-spend budget across a scope.

A SECOND, SEPARATE simulation mode. It shares nothing with the Investigation
Simulation path except the two things that must not be written down twice: the
ONE `FilterState`, and the APPROVED PROMOTION ECONOMICS in app/tpo/response.py
and app/tpo/config.py. Nothing in app/tpo/simulation.py, execution.py,
scenarios.py, comparison.py, recommendation.py or risk.py is imported, called
or changed by this module.

THE QUESTION IT ANSWERS. "Given a category, a channel and a month, which
products should carry a promotion, at which approved depth, so that revenue is
as high as it can be without the trade spend exceeding a stated ceiling?"

------------------------------------------------------------------------------
THE ECONOMICS ARE NOT REDEFINED HERE
------------------------------------------------------------------------------
Every counterfactual figure comes out of the same algebra
`app/tpo/execution.synthesize` applies row by row, driven by the same approved
rules `app/tpo/response.py` serves. For a candidate whose non-promoted baseline
is `b` transactions' worth of volume at list price `P`, under approved
treatment `(d, u)` with the standing promotion cost rate `c`:

    units    = b . (1 + u)
    gross    = units . P                (the same volume valued at list)
    revenue  = gross . (1 - d)
    discount = gross . d
    overhead = gross . c
    spend    = discount + overhead = gross . (d + c)

`spend` is Trade Spend exactly as `aggregate.calculate_trade_spend` defines it
-- (Base_Revenue - Actual_Revenue) + Promotion_Cost -- so the ceiling the user
sets is enforced against the project's own definition and not a local one.

------------------------------------------------------------------------------
FIVE APPROVED DEPTHS, NOT A CONTINUUM
------------------------------------------------------------------------------
`response.get_treatment_response` admits 5, 10, 15, 20 and 25 percent and
REFUSES to interpolate: an unapproved depth has no approved uplift band, and
inventing one would be a coefficient wearing a rule as a disguise. So the
discount range the user selects is a WINDOW OVER THE APPROVED POINTS, not a
continuous interval. A window of 6-9% contains no approved point, and this
module says so (`constraint_conflict`) rather than quietly rounding to 5 or 10.

That is also why the optimizer is combinatorial rather than continuous: the
decision for each candidate is WHICH APPROVED TREATMENT, a choice among at most
six discrete options. A continuous NLP solver would return fractional depths
this project's economics cannot price.

------------------------------------------------------------------------------
THE BAND IS CARRIED WHOLE
------------------------------------------------------------------------------
An approved rule gives an uplift BAND (PR003 is 40-50%), and B2.1 refuses to
collapse one to a midpoint. So every derived figure here has a `low` and a
`high` end, and the two are used for different jobs, deliberately:

  * The OBJECTIVE is revenue at `uplift_low` -- what the plan returns if every
    treatment lands at the bottom of its approved band.
  * The BUDGET CONSTRAINT binds on spend at `uplift_high` -- volume rises with
    uplift and so does the spend that buys it, so the ceiling is enforced
    against the worst case. A plan that fits at the bottom of the band and
    bursts the budget at the top has not met the constraint.

Maximising a floor while funding a ceiling is the conservative reading of both,
and it is stated on every response in `provenance.basis`.

------------------------------------------------------------------------------
WHAT THIS MODULE DOES NOT DO
------------------------------------------------------------------------------
No forecast. No elasticity. No cannibalization response -- the approved rules
define none, and this module does not invent one, so a plan's figures are the
promoted products' own and say nothing about their neighbours. No product,
Brand Form, category, channel or historical value is generated: every candidate
is a (product, channel) the filtered dataset actually contains.
"""

from __future__ import annotations

from collections import defaultdict
from dataclasses import dataclass
from typing import Any, Iterable, Sequence

from app.tpo import aggregate as A
from app.tpo import config
from app.tpo import formatting as F
from app.tpo import response
from app.tpo.filters import FilterState, rows_for
from app.tpo.loader import MONTHS, get_store

#: The phase marker carried on every response, so a client can never mistake a
#: budget allocation for an investigation scenario.
MODE = "general_optimization"

#: The hard ceiling on discount depth this mode offers, as a PERCENTAGE. Not a
#: business rule of its own -- it is the deepest APPROVED treatment
#: (`PB001`, 25%), read from the rules rather than written down again.
MAX_DISCOUNT_PCT: float = max(response.APPROVED_DISCOUNT_PCT)

def reference_years(state: FilterState | None = None) -> tuple[int, ...]:
    """The years the historical reference is built from.

    A scope that names a YEAR is that year alone: the reference is then that
    year's own trading for the month, the plan describes that same year, and
    nothing is averaged. With no year named, it is EVERY year the dataset
    holds -- a single year is one observation of a month and the reference is
    an average across the years the data actually carries.

    Read from the loaded store rather than written down here. This was a
    literal `(2024, 2025)`, which stopped being true the day 2026 rows arrived:
    the plan's window (`rows_for(state)`, every year in the data) then held
    three years of a month while the ceiling divided by two, and the
    "historical" side of the screen no longer described the same trading as
    the budget it was compared with. A year the data holds but that carries no
    rows for a scope (2026 runs January-August) still contributes nothing --
    `historical_reference` counts observations, not years.
    """
    if state is not None and state.year is not None:
        return (state.year,)
    return tuple(get_store().years())

#: How many buckets the budget is discretised into for the exact solve. 2,000
#: over a ceiling of a few crore is sub-lakh granularity -- finer than any
#: figure this screen displays. Each option's spend is rounded UP into its
#: bucket, so the solution can only ever under-spend the true ceiling, never
#: burst it.
BUDGET_BUCKETS = 2000

#: Statuses this module can return. `optimizing` is a client-side transient and
#: is never produced here.
STATUS_OPTIMIZED = "optimized"
STATUS_NO_FEASIBLE = "no_feasible_solution"
STATUS_INSUFFICIENT = "insufficient_data"
STATUS_CONFLICT = "constraint_conflict"


class InvalidConstraints(ValueError):
    """A constraint set that cannot be honoured as stated.

    Distinct from an infeasible optimisation: this is a malformed REQUEST --
    a negative ceiling, a minimum above the maximum, a depth beyond the
    deepest approved treatment -- and the caller should be told which.
    """


# --- candidates -------------------------------------------------------------


@dataclass(frozen=True)
class Candidate:
    """One (product, channel) the optimizer may place a treatment on.

    Split into what was MEASURED and what a counterfactual needs:

      * `base_*` are the historical figures for this candidate in scope. They
        are what the data recorded, promotions and all, and they are the
        "before" side of the comparison.
      * `baseline_units` and `list_price` are the counterfactual anchors -- the
        volume this candidate does when it is NOT promoted, and the price it
        lists at. A treatment is applied to these, never to `base_units`, or a
        product that already ran a promotion would have that promotion's uplift
        counted twice.
    """

    product_id: str
    product_name: str
    brand_form: str
    category: str
    channel_id: str
    channel_name: str

    # measured
    base_units: float
    base_revenue: float
    base_trade_spend: float

    # counterfactual anchors
    baseline_units: float
    list_price: float

    # --- the CURRENT side, appended with defaults on purpose -----------------
    #
    # LAST, AND DEFAULTED, so constructing a Candidate for a solver test -- where
    # the historical side is irrelevant -- stays a short call. The one production
    # call site in `_candidates` always passes all three explicitly, and
    # `test_general_optimization_current_vs_optimized.py` re-derives every one of
    # them from the fact rows, so a call site that forgot would fail there rather
    # than quietly report a promoted product as unpromoted.

    #: What this (product, channel) ACTUALLY ran at in the selected scope: the
    #: measured depth, read from prices exactly as `_historical` reads it for the
    #: whole selection. 0.0 when nothing here was promoted. A RATIO, so it is
    #: never divided by the reference-year count.
    base_discount_pct: float = 0.0
    #: Whether the scope carries any promoted row for this candidate, and which
    #: promotions they were. "Not promoted" and "promoted at 0%" are different
    #: statements, and the row keeps them apart.
    base_promoted: bool = False
    base_promotions: tuple[str, ...] = ()
    #: Where the non-promoted baseline came from -- "scope" when the selected
    #: month itself holds non-promoted rows for this (product, channel),
    #: "year" when it did not and the same year's other months supplied them,
    #: "all_years" when only the whole dataset did. See `_baseline_fallback`.
    baseline_window: str = "scope"

    @property
    def base_gross(self) -> float:
        """The counterfactual's un-promoted volume valued at list."""
        return self.baseline_units * self.list_price


@dataclass(frozen=True)
class Option:
    """One approved treatment applied to one candidate, priced at both ends of
    the approved band. `discount_pct` of 0 is the NO-PROMOTION option -- the
    candidate is left at its baseline, which is what makes it legitimate for
    the optimizer to leave a product alone (see the module docstring)."""

    treatment: str | None  # None for the no-promotion option
    discount_pct: float
    uplift_low: float
    uplift_high: float

    units_low: float
    units_high: float
    revenue_low: float
    revenue_high: float
    spend_low: float
    spend_high: float

    @property
    def promoted(self) -> bool:
        return self.treatment is not None


def _price_and_baseline(rows: Sequence[A.WeekRow]) -> tuple[float | None, float | None, int]:
    """This candidate's list price, per-transaction non-promoted baseline, and
    total transactions in scope.

    THE BASELINE RULE IS `aggregate._volume`'s, restated for a population that
    function deliberately does not cover. `_volume` skips any (product,
    channel) that was never promoted in the selection, because an incremental
    is undefined without a promotion -- but such a product is a perfectly good
    OPTIMIZER CANDIDATE, and dropping it would hide from the plan exactly the
    products with room to be promoted.

    So the rule is written once more, and `tests/test_general_optimization.py`
    asserts it agrees with `A._volume(...).baseline_average` for every
    (product, channel) that `_volume` does report. The duplication is guarded
    by that test rather than by hope.

        baseline  = Sum(Base_Quantity over non-promoted rows) / their transactions
        listprice = Sum(Actual_Revenue + Discount_Value) / Sum(Base_Quantity)

    `list_price` is `execution.synthesize`'s own per-row identity
    `(actual_revenue + discount_value) / base_quantity`, aggregated. A
    non-promoted row carries a zero discount, so it contributes its plain
    price; a promoted one is grossed back up to list before averaging.
    """
    base_qty = 0.0
    base_txn = 0
    gross = 0.0
    quantity = 0.0
    transactions = 0

    for row in rows:
        transactions += row.transaction_count
        gross += row.actual_revenue + row.discount_value
        quantity += row.base_quantity
        if not row.is_promoted:
            base_qty += row.base_quantity
            base_txn += row.transaction_count

    baseline = base_qty / base_txn if base_txn else None
    price = gross / quantity if quantity else None
    return price, baseline, transactions


def _baseline_fallback(state: FilterState, product_id: str, channel_id: str) -> tuple[float | None, str]:
    """The non-promoted baseline rate for a (product, channel) the selected
    scope holds NO non-promoted row for, from the nearest wider window.

    A product promoted in every week of the selected month has no ordinary
    demand level inside that month -- and it used to be dropped from the plan
    for exactly that reason, which emptied the optimizer of the products a
    planner most wants to reallocate: on a month-scoped run, half a category
    was "excluded" and the half that remained had never been promoted at all.

    The baseline is a per-transaction RATE (`_price_and_baseline`), so it can
    be read from a wider window without mixing volumes: first the same year
    with the month lifted, then every year the data holds. Only the rate is
    borrowed -- units, revenue, spend and price stay the selected scope's own.
    Nothing is interpolated: if no window holds a non-promoted row, there is
    still no baseline and the candidate is still excluded.
    """
    windows: list[tuple[str, FilterState]] = []
    if state.month is not None:
        windows.append(("year", state.replace(month=None)))
    if state.year is not None:
        windows.append(("all_years", state.replace(month=None, year=None)))
    for label, wider in windows:
        rows = [
            r for r in rows_for(wider)
            if r.product_id == product_id and r.channel_id == channel_id
        ]
        _, baseline, _ = _price_and_baseline(rows)
        if baseline is not None:
            return baseline, label
    return None, "scope"


def reference_year_count(state: FilterState) -> int:
    """How many of the reference years actually carry rows for this scope.

    THE PLAN AND THE BUDGET MUST DESCRIBE THE SAME AMOUNT OF TRADING. The
    ceiling is an AVERAGE year's trade spend for the selected month, by
    contract -- so the plan it funds has to be an AVERAGE year's volume too.
    The selection spans every year the data holds, which is two Novembers of
    units (three Junes); funding two Novembers from one November's budget would
    make the optimizer look starved and would report a revenue "uplift" against
    a base twice its size.

    So every candidate figure is divided by this count, and the whole screen
    describes ONE representative month. Zero years is impossible here -- a
    scope with no rows produces no candidates and never reaches this -- but the
    guard keeps the division total.
    """
    return sum(1 for year in reference_years(state) if rows_for(_reference_state(state, year))) or 1


def _candidates(state: FilterState) -> tuple[list[Candidate], list[dict[str, Any]]]:
    """Every (product, channel) in scope that a treatment could be placed on,
    plus the ones that could not be and why.

    A candidate needs a non-promoted row to form a baseline from. Without one
    there is nothing to apply an uplift TO, and the engine excludes such a
    (product, channel) from every volume KPI for the same reason -- so it is
    reported as excluded rather than optimised against its promoted volume,
    which would treat an existing promotion's uplift as the ordinary level.

    EVERY FIGURE IS PER AVERAGE YEAR -- see `reference_year_count`. The baseline
    RATE is untouched (it is a per-transaction mean and carries no year in it);
    what is divided is the VOLUME the rate is multiplied by, and the measured
    totals beside it, so the two sides of the comparison match the budget.
    """
    years = reference_year_count(state)
    store = get_store()
    grouped: dict[tuple[str, str], list[A.WeekRow]] = defaultdict(list)
    for row in rows_for(state):
        grouped[(row.product_id, row.channel_id)].append(row)

    candidates: list[Candidate] = []
    excluded: list[dict[str, Any]] = []

    for (product_id, channel_id) in sorted(grouped):
        rows = grouped[(product_id, channel_id)]
        price, baseline, transactions = _price_and_baseline(rows)
        product = store.dims.products.get(product_id)
        channel = store.dims.channels.get(channel_id)

        baseline_window = "scope"
        if baseline is None:
            baseline, baseline_window = _baseline_fallback(state, product_id, channel_id)
        if baseline is None:
            excluded.append({
                "product_id": product_id,
                "channel_id": channel_id,
                "reason": (
                    "No non-promoted row for this product and channel in the selected "
                    "scope, its year or the whole dataset, so there is no ordinary "
                    "demand level to apply a treatment to."
                ),
            })
            continue
        if not price:
            excluded.append({
                "product_id": product_id,
                "channel_id": channel_id,
                "reason": "No priced volume in this scope.",
            })
            continue

        # THE MEASURED DEPTH THIS CANDIDATE ACTUALLY RAN AT.
        #
        # The SAME rule `_historical` applies to the whole selection, applied to
        # one candidate's own rows: given-away revenue over gross revenue, read
        # from prices rather than from a promotion's name. Not a new formula and
        # not an inference from the optimizer's answer -- this is the "before"
        # the plan is recommending a change to.
        gross = sum(r.actual_revenue + r.discount_value for r in rows)
        given = sum(r.discount_value for r in rows)
        promotions = tuple(sorted({r.promotion_id for r in rows if r.is_promoted}))

        candidates.append(Candidate(
            product_id=product_id,
            product_name=(product.name.strip() if product else product_id),
            brand_form=(product.brand if product else ""),
            category=(product.category if product else ""),
            channel_id=channel_id,
            channel_name=(channel.name if channel else channel_id),
            base_units=sum(r.actual_quantity for r in rows) / years,
            base_revenue=sum(r.actual_revenue for r in rows) / years,
            base_trade_spend=sum(r.discount_value + r.promotion_cost for r in rows) / years,
            base_discount_pct=(given / gross * 100) if gross else 0.0,
            base_promoted=bool(promotions),
            base_promotions=promotions,
            baseline_units=baseline * transactions / years,
            list_price=price,
            baseline_window=baseline_window,
        ))

    return candidates, excluded


# --- options ----------------------------------------------------------------


def allowed_treatments(min_discount_pct: float, max_discount_pct: float) -> list[response.TreatmentResponse]:
    """The approved treatments whose depth falls inside the selected window.

    Possibly empty -- a 6-9% window contains none. That is a real answer and
    the caller reports it as `constraint_conflict`; it is NOT rounded to the
    nearest approved point, because the nearest approved point is a different
    treatment with a different approved band.
    """
    return [
        rule for rule in response.all_treatments()
        if min_discount_pct <= rule.discount_pct <= max_discount_pct
    ]


def _options(candidate: Candidate, rules: Iterable[response.TreatmentResponse]) -> list[Option]:
    """Every allocation this candidate may receive, cheapest first.

    The first is always NO PROMOTION: the candidate sits at its baseline, draws
    nothing from the budget and returns its un-promoted revenue. Section 15 of
    the brief -- a product may stay at its base allocation -- is this option,
    and having it means a feasible plan always exists.
    """
    cost_rate = config.PROMOTION_COST_RATE
    gross = candidate.base_gross

    options = [Option(
        treatment=None,
        discount_pct=0.0,
        uplift_low=0.0,
        uplift_high=0.0,
        units_low=candidate.baseline_units,
        units_high=candidate.baseline_units,
        revenue_low=gross,
        revenue_high=gross,
        spend_low=0.0,
        spend_high=0.0,
    )]

    for rule in rules:
        d = rule.discount_pct / 100
        lo_units = candidate.baseline_units * (1 + rule.uplift_low)
        hi_units = candidate.baseline_units * (1 + rule.uplift_high)
        lo_gross = lo_units * candidate.list_price
        hi_gross = hi_units * candidate.list_price
        options.append(Option(
            treatment=rule.treatment,
            discount_pct=rule.discount_pct,
            uplift_low=rule.uplift_low,
            uplift_high=rule.uplift_high,
            units_low=lo_units,
            units_high=hi_units,
            revenue_low=lo_gross * (1 - d),
            revenue_high=hi_gross * (1 - d),
            spend_low=lo_gross * (d + cost_rate),
            spend_high=hi_gross * (d + cost_rate),
        ))
    return options


# --- the solver -------------------------------------------------------------


def solve(
    options_per_candidate: Sequence[Sequence[Option]],
    max_trade_spend: float,
    buckets: int = BUDGET_BUCKETS,
) -> list[int]:
    """Exact multiple-choice knapsack: pick one option per candidate,
    maximising total `revenue_low` subject to total `spend_high` <= budget.

    WHY THIS SOLVER, and not `scipy.optimize.minimize(method="trust-constr")`.

      * THE VARIABLES ARE DISCRETE. Each candidate chooses one of at most six
        APPROVED treatments. `trust-constr` optimises over a continuous box and
        would return depths like 11.3%, which `response.get_treatment_response`
        rejects outright -- there is no approved band between two approved
        points. Rounding its answer afterwards would discard the optimality
        that was the only reason to use it.
      * THIS IS EXACT. A dynamic program over the budget returns the true
        optimum for the discretised budget, with no starting point, no
        tolerance, no convergence to babysit and no local minimum to land in.
      * IT IS DETERMINISTIC. Same inputs, same plan, every run -- ties broken
        by the lower option index, which is the shallower discount.
      * IT ADDS NO DEPENDENCY. scipy is not installed in this environment, and
        the brief is explicit that a heavyweight optimisation dependency should
        not be added unless necessary. It is not necessary: the problem is
        ~36 candidates x <=6 options x 2,000 buckets, which is a fraction of a
        second in plain Python.

    THE DISCRETISATION IS SAFE IN ONE DIRECTION ONLY, on purpose. Each option's
    spend is rounded UP to a whole bucket, so the plan's true spend is always
    <= the ceiling. The cost is that up to one bucket of budget per promoted
    candidate goes unused; the benefit is that the hard constraint is never
    violated by a rounding artefact.

    Returns the chosen option index per candidate, positionally.
    """
    n = len(options_per_candidate)
    if n == 0:
        return []
    if max_trade_spend <= 0:
        # Only the zero-spend option is affordable. Every candidate has one.
        return [0] * n

    step = max_trade_spend / buckets

    # weights[i][j] -- option j's budget draw in whole buckets. Options that
    # cannot fit the whole budget by themselves are dropped from consideration
    # here rather than checked inside the inner loop.
    weights: list[list[int]] = []
    for options in options_per_candidate:
        row: list[int] = []
        for option in options:
            cost = int(-(-option.spend_high // step)) if option.spend_high > 0 else 0
            row.append(cost)
        weights.append(row)

    NEG = float("-inf")
    # best[w] -- the greatest total revenue_low achievable using exactly w
    # buckets or fewer, over the candidates processed so far.
    best: list[float] = [NEG] * (buckets + 1)
    best[0] = 0.0
    # choice[i][w] -- which option candidate i took to reach state w.
    choice: list[list[int]] = []

    for i, options in enumerate(options_per_candidate):
        nxt: list[float] = [NEG] * (buckets + 1)
        took: list[int] = [-1] * (buckets + 1)
        w_row = weights[i]
        for w in range(buckets + 1):
            current = best[w]
            if current == NEG:
                continue
            for j, option in enumerate(options):
                cost = w_row[j]
                total = w + cost
                if total > buckets:
                    continue
                value = current + option.revenue_low
                # Strict `>` keeps the FIRST option that reaches a value, and
                # options are ordered no-promotion first then by ascending
                # depth -- so a tie resolves to the shallower treatment.
                if value > nxt[total]:
                    nxt[total] = value
                    took[total] = j
        best = nxt
        choice.append(took)

    # The best reachable end state, then walk the choices back.
    end = max(range(buckets + 1), key=lambda w: (best[w], -w))
    if best[end] == NEG:
        return [0] * n

    picks = [0] * n
    w = end
    for i in range(n - 1, -1, -1):
        j = choice[i][w]
        if j < 0:
            # Unreachable in practice: candidate 0's zero-cost option makes
            # every prefix state reachable. Falling back to no-promotion keeps
            # the walk total rather than raising on a state that cannot occur.
            j = 0
        picks[i] = j
        w -= weights[i][j]
    return picks


# --- the historical reference ----------------------------------------------


def _reference_state(state: FilterState, year: int) -> FilterState:
    return state.replace(year=year)


def historical_reference(state: FilterState) -> dict[str, Any]:
    """The trade-spend ceiling the slider is bounded by.

    THE AVERAGE OF THE YEARS THE DATA ACTUALLY HAS, for the selected month,
    channel and category -- not a number chosen to look round. Each year that
    carries rows for the scope contributes one observation; a year with no rows
    contributes nothing and is NOT counted as a zero, which would halve the
    average and quietly tighten the ceiling.

    The scope is the OPTIMIZER'S OWN scope, category included. Bounding a
    single category's plan by every category's spend would leave the constraint
    non-binding and the slider meaningless.
    """
    years = reference_years(state)
    observations: list[dict[str, Any]] = []
    for year in years:
        rows = rows_for(_reference_state(state, year))
        if not rows:
            observations.append({"year": year, "trade_spend": None, "row_count": 0, "available": False})
            continue
        spend = A.calculate_trade_spend(rows)
        observations.append({
            "year": year,
            "trade_spend": spend,
            "row_count": len(rows),
            "available": spend is not None,
        })

    measured = [o["trade_spend"] for o in observations if o["available"]]
    average = sum(measured) / len(measured) if measured else None

    return {
        "years": list(years),
        "observations": observations,
        "observed_years": len(measured),
        "average_trade_spend": average,
        "available": average is not None and average > 0,
        "basis": (
            "Mean Trade Spend across the "
            f"{len(measured)} of {len(years)} reference year(s) carrying rows for "
            "this category, channel and month. Trade Spend is the validated definition: "
            "(Base Revenue - Actual Revenue) + Promotion Cost."
        ),
        "unavailable_reason": (
            None if measured else
            f"None of {years_label(years)} has rows for this category, channel and month, so "
            "there is no historical trade spend to bound the ceiling with."
        ),
    }


def years_label(years: Sequence[int]) -> str:
    """"2024, 2025 and 2026" -- the reference window, named from the data."""
    labels = [str(y) for y in years]
    if len(labels) <= 1:
        return "".join(labels)
    return ", ".join(labels[:-1]) + " and " + labels[-1]


# --- request validation -----------------------------------------------------


def validate(min_discount_pct: float, max_discount_pct: float, max_trade_spend: float) -> None:
    """Reject a constraint set that cannot be honoured AS STATED.

    Separate from feasibility. These are contradictions in the request itself,
    and the caller is told which one rather than being handed an empty plan.
    """
    if min_discount_pct < 0:
        raise InvalidConstraints("Minimum discount cannot be negative.")
    if max_discount_pct > MAX_DISCOUNT_PCT:
        raise InvalidConstraints(
            f"Maximum discount cannot exceed {MAX_DISCOUNT_PCT:g}% — the deepest approved "
            "promotion treatment. Depths beyond it have no approved uplift band."
        )
    if min_discount_pct > max_discount_pct:
        raise InvalidConstraints("Minimum discount cannot exceed the maximum discount.")
    if max_trade_spend < 0:
        raise InvalidConstraints("Maximum trade spend cannot be negative.")


# --- presentation -----------------------------------------------------------


def _band(low: float | None, high: float | None, unit: str, currency: str) -> dict[str, Any]:
    """One figure carried as the approved band it is, never as a midpoint."""
    fmt = F.money if unit == "currency" else F.quantity
    kwargs = {"currency": currency} if unit == "currency" else {}
    return {
        "low": low,
        "high": high,
        "display_low": fmt(low, **kwargs),  # type: ignore[arg-type]
        "display_high": fmt(high, **kwargs),  # type: ignore[arg-type]
        "display": (
            fmt(low, **kwargs)  # type: ignore[arg-type]
            if low is not None and high is not None and abs(high - low) < 0.5
            else f"{fmt(low, **kwargs)} – {fmt(high, **kwargs)}"  # type: ignore[arg-type]
        ),
    }


def _change_pct(before: float | None, after: float | None) -> float | None:
    """Percentage change, or None when the base is zero or missing. A change
    against a zero base is undefined, not infinite and not 100%."""
    if before is None or after is None or before == 0:
        return None
    return round((after - before) / abs(before) * 100, 1)


def _scope_block(state: FilterState, candidates: Sequence[Candidate], excluded: Sequence[dict[str, Any]]) -> dict[str, Any]:
    store = get_store()
    categories = sorted({c.category for c in candidates if c.category})
    channels = sorted({(c.channel_id, c.channel_name) for c in candidates})
    return {
        "category": sorted(state.category) if state.category else None,
        "category_label": ", ".join(categories) if categories else "All categories",
        "channel": sorted(state.channel) if state.channel else None,
        "channel_label": (
            ", ".join(name for _, name in channels) if channels else "All channels"
        ),
        "channels_in_scope": len(channels),
        "month": state.month,
        # The month by name. `F.period_label(None, month)` reads a missing year
        # as "All Time" whatever the month, which is how this strip came to say
        # "All Time" over a scope that was one month wide.
        "month_label": MONTHS[state.month - 1] if state.month else "All months",
        "year": state.year,
        "years": list(reference_years(state)),
        "period_label": (
            f"{MONTHS[state.month - 1]} · {years_label(reference_years(state))}"
            if state.month else years_label(reference_years(state))
        ),
        "candidate_count": len(candidates),
        "excluded_count": len(excluded),
        "excluded": list(excluded[:20]),
        "product_count": len({c.product_id for c in candidates}),
        "brand_form_count": len({c.brand_form for c in candidates if c.brand_form}),
        "filters_applied": state.applied(),
        "available_categories": sorted({p.category for p in store.dims.products.values() if p.category}),
    }


def _empty(state: FilterState, status: str, message: str, reference: dict[str, Any],
           constraints: dict[str, Any], currency: str) -> dict[str, Any]:
    """A result that could not be produced, WITHOUT numbers.

    Nothing is zeroed. A plan that does not exist has no revenue, no units and
    no spend, and printing zeros for them would read as a measured outcome.
    """
    return {
        "mode": MODE,
        "status": status,
        "message": message,
        "scope": _scope_block(state, (), ()),
        "reference": reference,
        "constraints": constraints,
        "historical": None,
        "optimized": None,
        "comparison": None,
        "rows": [],
        "provenance": _provenance(),
        "meta": _meta(currency),
    }


def _provenance() -> dict[str, Any]:
    return {
        "response_rule": response.PROVENANCE,
        "promotion_cost_rate": config.PROMOTION_COST_RATE,
        "approved_discount_pct": list(response.APPROVED_DISCOUNT_PCT),
        "economics": (
            "units = baseline x (1 + u); gross = units x list price; "
            "revenue = gross x (1 - d); trade spend = gross x (d + c). The same "
            "algebra app/tpo/execution.synthesize applies row by row."
        ),
        "objective": "Maximise total optimized revenue at the LOW end of each approved uplift band.",
        "constraint": (
            "Total optimized trade spend at the HIGH end of each approved uplift band "
            "must not exceed the selected maximum."
        ),
        "basis": (
            "Revenue is reported at the bottom of the approved band and the budget is "
            "funded at the top, so the plan cannot overspend anywhere inside the band it "
            "was approved over. Neither end is a forecast or a confidence bound — they "
            "are the two ends of the project's approved promotion rules."
        ),
        "solver": "Exact multiple-choice knapsack, dynamic program over a discretised budget.",
        "cannibalization": (
            "Not modelled. The approved rules define no cannibalization response to "
            "discount depth, so this plan describes the promoted products only."
        ),
    }


def _meta(currency: str) -> dict[str, Any]:
    return {
        "mode": MODE,
        "currency": currency,
        "base_currency": config.BASE_CURRENCY,
        "exchange_rate": F._rate(currency),
        "max_discount_pct": MAX_DISCOUNT_PCT,
    }


# --- the endpoint payloads --------------------------------------------------


def scope(state: FilterState, currency: str = "INR") -> dict[str, Any]:
    """What the controls need before anything is optimised.

    The trade-spend ceiling in particular: the slider cannot be bounded until
    the historical average for the selected category, channel and month is
    known, and that is a measurement rather than something the client can
    guess.
    """
    currency = F.normalise_currency(currency)
    candidates, excluded = _candidates(state)
    reference = historical_reference(state)
    rows = rows_for(state)

    return {
        "mode": MODE,
        "scope": _scope_block(state, candidates, excluded),
        "reference": {
            **reference,
            "display_average": F.money(reference["average_trade_spend"], currency),
        },
        "historical": _historical(rows, candidates, currency, reference_year_count(state)) if candidates else None,
        "discount": {
            "min_pct": 0.0,
            "max_pct": MAX_DISCOUNT_PCT,
            "approved_points": [
                {
                    "discount_pct": rule.discount_pct,
                    "treatment": rule.treatment,
                    "uplift_low": rule.uplift_low,
                    "uplift_high": rule.uplift_high,
                }
                for rule in response.all_treatments()
            ],
            "note": (
                "Only the approved treatment depths can be priced. The range selects "
                "which of them the optimizer may use; it does not create depths "
                "between them."
            ),
        },
        "ready": bool(candidates) and reference["available"],
        "provenance": _provenance(),
        "meta": _meta(currency),
    }


def _historical(
    rows: Sequence[A.WeekRow],
    candidates: Sequence[Candidate],
    currency: str,
    years: int = 1,
) -> dict[str, Any]:
    """The measured "before" side, PER AVERAGE REFERENCE YEAR.

    Nothing here is derived from a treatment: these are the engine's own
    figures for the filtered rows, divided by the number of reference years
    that carry them so the comparison is like for like with a plan the ceiling
    funds for one month. The average discount is a RATIO and is not divided --
    dividing it would be meaningless.
    """
    units = sum(c.base_units for c in candidates)
    revenue = sum(c.base_revenue for c in candidates)
    spend = (A.calculate_trade_spend(rows) or 0.0) / years
    gross = sum(r.actual_revenue + r.discount_value for r in rows)
    given = sum(r.discount_value for r in rows)
    depth = (given / gross * 100) if gross else None
    promoted = len({(r.product_id, r.channel_id) for r in rows if r.is_promoted})

    return {
        "units": units,
        "units_display": F.quantity(units),
        "revenue": revenue,
        "revenue_display": F.money(revenue, currency),
        "trade_spend": spend,
        "trade_spend_display": F.money(spend, currency),
        "average_discount_pct": None if depth is None else round(depth, 1),
        "average_discount_display": F.percent(None if depth is None else round(depth, 1)),
        "promoted_candidates": promoted,
        "reference_years": years,
        "derivation": (
            f"Measured over the filtered rows and divided by the {years} reference "
            "year(s) that carry them, so it describes one average month. Trade Spend is "
            "(Base Revenue - Actual Revenue) + Promotion Cost; the average discount is a "
            "ratio -- given-away revenue over gross revenue, read from prices rather than "
            "from a promotion's name -- and is not divided."
        ),
    }


def optimize(
    state: FilterState,
    max_trade_spend: float,
    min_discount_pct: float = 0.0,
    max_discount_pct: float = MAX_DISCOUNT_PCT,
    currency: str = "INR",
) -> dict[str, Any]:
    """Allocate the budget across the scope and return the plan.

    Raises `InvalidConstraints` for a request that contradicts itself. Every
    other unhappy outcome comes back as a STATUS with an explanation and no
    numbers -- an infeasible plan has no revenue, and reporting a zero for it
    would be a fabricated result.
    """
    currency = F.normalise_currency(currency)
    validate(min_discount_pct, max_discount_pct, max_trade_spend)

    candidates, excluded = _candidates(state)
    reference = historical_reference(state)
    rules = allowed_treatments(min_discount_pct, max_discount_pct)
    constraints = {
        "max_trade_spend": max_trade_spend,
        "max_trade_spend_display": F.money(max_trade_spend, currency),
        "min_discount_pct": min_discount_pct,
        "max_discount_pct": max_discount_pct,
        "allowed_treatments": [
            {"treatment": r.treatment, "discount_pct": r.discount_pct} for r in rules
        ],
        "ceiling_basis": reference["basis"],
    }
    reference_out = {**reference, "display_average": F.money(reference["average_trade_spend"], currency)}

    if not candidates:
        return _empty(
            state, STATUS_INSUFFICIENT,
            "No product in this category, channel and month has a non-promoted week to "
            "measure an ordinary demand level from, so there is nothing to optimise.",
            reference_out, constraints, currency,
        )
    if not reference["available"]:
        return _empty(
            state, STATUS_INSUFFICIENT,
            reference["unavailable_reason"] or "No historical trade spend for this scope.",
            reference_out, constraints, currency,
        )
    if not rules:
        approved = ", ".join(f"{d:g}%" for d in sorted(response.APPROVED_DISCOUNT_PCT))
        return _empty(
            state, STATUS_CONFLICT,
            f"No approved promotion treatment sits between {min_discount_pct:g}% and "
            f"{max_discount_pct:g}%. The approved depths are {approved}, and depths "
            "between them have no approved uplift band to price them with.",
            reference_out, constraints, currency,
        )
    # The ceiling is capped at the historical average by contract; a request
    # above it is clamped rather than rejected, and the response says so.
    ceiling = min(max_trade_spend, reference["average_trade_spend"])
    constraints["effective_max_trade_spend"] = ceiling
    constraints["effective_max_trade_spend_display"] = F.money(ceiling, currency)
    constraints["clamped"] = ceiling < max_trade_spend

    options = [_options(c, rules) for c in candidates]
    picks = solve(options, ceiling)

    chosen = [options[i][j] for i, j in enumerate(picks)]
    promoted = [o for o in chosen if o.promoted]

    rows = rows_for(state)
    historical = _historical(rows, candidates, currency, reference_year_count(state))

    opt_units_low = sum(o.units_low for o in chosen)
    opt_units_high = sum(o.units_high for o in chosen)
    opt_rev_low = sum(o.revenue_low for o in chosen)
    opt_rev_high = sum(o.revenue_high for o in chosen)
    opt_spend_low = sum(o.spend_low for o in chosen)
    opt_spend_high = sum(o.spend_high for o in chosen)

    if not promoted:
        cheapest = min(
            (o.spend_high for opts in options for o in opts if o.promoted),
            default=None,
        )
        return _empty(
            state, STATUS_NO_FEASIBLE,
            (
                "No promotion fits the selected trade-spend ceiling. The cheapest "
                f"approved treatment in range costs {F.money(cheapest, currency)} at the top "
                f"of its uplift band, against a ceiling of {F.money(ceiling, currency)}. "
                "Raise the ceiling or widen the discount range."
                if cheapest is not None else
                "No promotion fits the selected constraints."
            ),
            reference_out, constraints, currency,
        )

    # Revenue-weighted mean depth over the PROMOTED candidates only. Averaging
    # a zero in for every untouched product would report a depth nobody chose.
    promoted_gross = sum(o.revenue_low / (1 - o.discount_pct / 100) for o in promoted)
    weighted_depth = (
        sum((o.revenue_low / (1 - o.discount_pct / 100)) * o.discount_pct for o in promoted) / promoted_gross
        if promoted_gross else None
    )

    optimized = {
        "units": _band(opt_units_low, opt_units_high, "quantity", currency),
        "revenue": _band(opt_rev_low, opt_rev_high, "currency", currency),
        "trade_spend": _band(opt_spend_low, opt_spend_high, "currency", currency),
        "average_discount_pct": None if weighted_depth is None else round(weighted_depth, 1),
        "average_discount_display": F.percent(None if weighted_depth is None else round(weighted_depth, 1)),
        "promoted_candidates": len(promoted),
        "untouched_candidates": len(chosen) - len(promoted),
        "budget_used_pct": round(opt_spend_high / ceiling * 100, 1) if ceiling else None,
    }

    comparison = {
        "units": {
            "historical": historical["units"],
            "optimized_low": opt_units_low,
            "optimized_high": opt_units_high,
            "change_pct_low": _change_pct(historical["units"], opt_units_low),
            "change_pct_high": _change_pct(historical["units"], opt_units_high),
        },
        "revenue": {
            "historical": historical["revenue"],
            "optimized_low": opt_rev_low,
            "optimized_high": opt_rev_high,
            "change_pct_low": _change_pct(historical["revenue"], opt_rev_low),
            "change_pct_high": _change_pct(historical["revenue"], opt_rev_high),
        },
        "trade_spend": {
            "historical": historical["trade_spend"],
            "optimized_low": opt_spend_low,
            "optimized_high": opt_spend_high,
            "change_pct_low": _change_pct(historical["trade_spend"], opt_spend_low),
            "change_pct_high": _change_pct(historical["trade_spend"], opt_spend_high),
        },
        "average_discount_pct": {
            "historical": historical["average_discount_pct"],
            "optimized": optimized["average_discount_pct"],
        },
    }

    return {
        "mode": MODE,
        "status": STATUS_OPTIMIZED,
        "message": None,
        "scope": _scope_block(state, candidates, excluded),
        "reference": reference_out,
        "constraints": constraints,
        "historical": historical,
        "optimized": optimized,
        "comparison": comparison,
        "rows": [_row(c, o, currency) for c, o in zip(candidates, chosen)],
        "provenance": _provenance(),
        "meta": _meta(currency),
    }


def _row(candidate: Candidate, option: Option, currency: str) -> dict[str, Any]:
    """One line of the optimized product plan: the CURRENT state and the
    RECOMMENDED one, side by side.

    Business labels only. `treatment` and the uplift band travel too, because a
    row that says "15%" without saying which approved rule priced it is a
    number without a provenance.

    EVERY FIGURE IS PREFIXED WITH WHICH SIDE IT BELONGS TO. `base_*` is
    measured from the rows in scope; `optimized_*` is what the chosen treatment
    would do to them. The two were previously distinguishable only by name in
    some places and not at all in others -- a column headed "Discount" carrying
    `option.discount_pct` reads as the product's discount, when it is the one
    the optimizer is PROPOSING. A reader cannot check a recommendation they
    cannot see the "before" of.

    THE COMMONEST CASE THIS MAKES LEGIBLE: a product with a real current
    discount that the optimizer recommends NOT promoting. Its optimized units
    fall below its base units -- correctly, because the un-promoted option
    returns it to its ordinary demand and its base units include the promoted
    weeks. Without the current column that row reads as an error.
    """
    return {
        "product_id": candidate.product_id,
        "product": candidate.product_name,
        "brand_form": candidate.brand_form,
        "category": candidate.category,
        "channel_id": candidate.channel_id,
        "channel": candidate.channel_name,

        "base_units": candidate.base_units,
        "base_units_display": F.quantity(candidate.base_units),
        "base_revenue": candidate.base_revenue,
        "base_revenue_display": F.money(candidate.base_revenue, currency),
        "base_trade_spend": candidate.base_trade_spend,
        "base_trade_spend_display": F.money(candidate.base_trade_spend, currency),
        "base_discount_pct": round(candidate.base_discount_pct, 1),
        "base_discount_display": F.percent(round(candidate.base_discount_pct, 1)),
        "base_promoted": candidate.base_promoted,
        "base_promotions": list(candidate.base_promotions),
        "baseline_window": candidate.baseline_window,

        "promoted": option.promoted,
        "treatment": option.treatment,
        "discount_pct": option.discount_pct,
        "discount_display": F.percent(option.discount_pct),
        "uplift": {"low": option.uplift_low, "high": option.uplift_high},

        "optimized_units": _band(option.units_low, option.units_high, "quantity", currency),
        "optimized_revenue": _band(option.revenue_low, option.revenue_high, "currency", currency),
        "optimized_trade_spend": _band(option.spend_low, option.spend_high, "currency", currency),
    }
