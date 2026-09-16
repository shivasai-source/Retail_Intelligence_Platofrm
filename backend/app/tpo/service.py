"""The Insights Hub service — every payload the UI reads, one filter state.

Nothing in here computes a KPI. Every number comes from app/tpo/aggregate.py,
so the cards, the trend chart, the alerts and the two tables cannot disagree.
ROI in particular is only ever `aggregate.roi_multiple`, whether it is being
computed for the whole selection or for one promotion event.
"""

from __future__ import annotations

from collections import defaultdict
from dataclasses import dataclass
from functools import lru_cache
from typing import Any, Sequence

from app.tpo import aggregate as A
from app.tpo import config, formatting as F
from app.tpo.filters import FilterState, baseline_rows_for, options_for, rows_for
from app.tpo.loader import MONTHS, get_store

# --- KPI card definitions --------------------------------------------------


@dataclass(frozen=True)
class KpiSpec:
    """One card: what it is called, how it is rendered, and what the ⓘ says.

    The formula text lives here, beside the code that reads the engine, so the
    tooltip cannot drift from the arithmetic it describes.
    """

    key: str
    label: str
    unit: str  # currency | percent | score
    formula: str
    meaning: str
    #: True when a lower value is the better outcome, so the delta arrow's
    #: colour can be right without the frontend knowing the semantics.
    lower_is_better: bool = False
    #: How the year-on-year movement is PRINTED. "growth" is the percent change
    #: every original card shows. "points" prints a rate's movement in
    #: percentage points (20.0% -> 25.0% is "+5.0 pp", not "+25.0%"), and
    #: "difference" prints a signed amount in the card's own currency -- for a
    #: figure that can be negative, where a percent change of the previous
    #: value says nothing a reader can use (-10 -> +5 is not "+150%").
    delta_as: str = "growth"


KPI_SPECS: tuple[KpiSpec, ...] = (
    KpiSpec(
        key="trade_spend",
        label="Trade Spend",
        unit="currency",
        formula="Base Revenue − Actual Revenue + Promotion Cost",
        meaning=(
            "Total investment behind the promotion — the discount given away plus "
            "the promotion expenditure booked against it."
        ),
        lower_is_better=True,
    ),
    KpiSpec(
        key="incremental_sales",
        label="Incremental Sales",
        unit="currency",
        formula="Σ over promoted rows of (Actual Quantity − baseline) × Actual Price",
        meaning=(
            "Revenue the promotion added above the product's ordinary trading level, "
            "with every row valued at its own actual price."
        ),
    ),
    KpiSpec(
        key="promotion_roi",
        label="Promotion ROI",
        unit="multiple",
        formula="Incremental Sales ÷ Trade Spend",
        meaning=(
            f"Incremental sales returned for every rupee invested; 1.00 is break-even. "
            f"The target is {config.PROMOTION_TARGET_ROI:.2f}."
        ),
    ),
    KpiSpec(
        key="margin_impact",
        label="Margin Impact",
        unit="percent",
        formula="Σ(Actual Revenue − Total Cost) ÷ Σ(Actual Revenue) × 100",
        meaning=(
            "Gross margin retained across the selected period — one ratio of summed "
            "revenue and cost, not an average of per-row margins."
        ),
    ),
    KpiSpec(
        key="pei",
        label="Promotion Efficiency Index",
        unit="score",
        formula="0.40 × (ROI − 1.00) + 0.30 × Incremental Qty % + 0.30 × Margin Impact",
        meaning=(
            "A 0–100 composite of the three KPIs above, with ROI counted as its return "
            "above break-even. If a component cannot be computed its weight is "
            "redistributed across the rest."
        ),
    ),
    KpiSpec(
        key="cannibalization_rate",
        label="Cannibalization Rate",
        unit="percent",
        formula="Total Cannibalized Quantity ÷ Promotional Incremental Quantity × 100",
        meaning=(
            "Share of a promotion's uplift taken from neighbouring pack sizes in the "
            "same Brand Form. Shown as — when the selection cannot support it."
        ),
        lower_is_better=True,
    ),
)

#: THE SECOND ROW. Three cards the Insights Hub reveals on request beneath the
#: six above. Kept in their own tuple, and returned under their own key, so
#: every reader of `KPI_SPECS` and of `kpis()["kpis"]` -- the reports, the
#: Simulation Studio, the comparison engine, the agent tools -- sees exactly
#: the six cards it saw before. Nothing about the first row moves.
#:
#: Each one answers a question the six cannot: Volume Uplift is the demand
#: response without the price in it; Net Incremental Profit is the money left
#: after spend, the scale a ROI multiple hides by construction;
#: Target Hit Rate is how many individual promotions cleared the target, which
#: a portfolio ROI of 1.6 built on a few big winners will never say.
SECONDARY_KPI_SPECS: tuple[KpiSpec, ...] = (
    KpiSpec(
        key="volume_uplift",
        label="Volume Uplift",
        unit="percent",
        formula="Incremental Quantity ÷ Baseline Quantity × 100",
        meaning=(
            "How much more volume the promoted rows moved than they would have "
            "at their ordinary trading level, independent of price. The same "
            "figure the Promotion Efficiency Index weights at 0.30."
        ),
        delta_as="points",
    ),
    KpiSpec(
        key="net_incremental_profit",
        label="Net Incremental Profit",
        unit="currency",
        formula="Incremental Sales − Trade Spend",
        meaning=(
            "The absolute money behind the ROI multiple: what the promotions "
            "returned above their ordinary trading level, less what was spent "
            "to run them. Negative when they cost more than they brought back."
        ),
        delta_as="difference",
    ),
    KpiSpec(
        key="target_hit_rate",
        label="Target Hit Rate",
        unit="percent",
        formula=(
            f"Promotion events with ROI ≥ {config.PROMOTION_TARGET_ROI:.2f} "
            "÷ All promotion events × 100"
        ),
        meaning=(
            "The share of individual promotion events -- one product, channel, "
            "week and offer -- that cleared the ROI target. Counted from the same "
            "events the Risk Alerts panel reports."
        ),
        delta_as="points",
    ),
)

#: KPI key -> the KpiBundle attribute holding it.
_BUNDLE_FIELD = {
    "trade_spend": "trade_spend",
    "incremental_sales": "incremental_sales",
    "promotion_roi": "roi",
    "margin_impact": "margin_impact",
    "pei": "pei",
    "cannibalization_rate": "cannibalization",
    "volume_uplift": "incremental_quantity_percent",
    "net_incremental_profit": "net_incremental_profit",
}


# --- helpers ---------------------------------------------------------------


@lru_cache(maxsize=256)
def _bundle(state: FilterState) -> tuple[A.KpiBundle, str | None]:
    """The KPI bundle for a selection, with its comparison period label.

    MEMOISED PER FILTER STATE, like `rows_for` beneath it. Currency is not in
    the key because it is not in the arithmetic: the bundle is canonical INR
    and the caller converts on the way out, so the USD toggle and a return to
    the page cost a lookup rather than a second pass over the rows. Cleared
    with the other row caches when a dataset is installed
    (app/star_dataset.py).

    The comparison uses the SAME dimensional filters over the previous year —
    never unfiltered history. When no earlier year is loaded there is no
    comparison, and every delta resolves to undefined rather than to zero.
    """
    store = get_store()
    rows = rows_for(state)
    volume_rows = baseline_rows_for(state)
    previous_state = state.comparison(store)
    previous_rows = rows_for(previous_state) if previous_state else ()
    previous_volume = baseline_rows_for(previous_state) if previous_state else ()

    # THE CANNIBALIZATION SCOPE. Two widenings, and BOTH are required before
    # the metric can be measured at all:
    #
    #   * `widened_to_brand_form()` lifts a Product filter to the SKU's Brand
    #     Form, so the neighbours a promoted pack steals from are present. The
    #     Product filter still travels separately as `promoted_products`, so a
    #     sibling can be a victim but never a promoter.
    #   * `baseline_rows_for` re-admits the NON-PROMOTED rows. Cannibalization
    #     needs them twice over -- `_sku_baselines` derives every baseline from
    #     them, and a neighbour only counts as a victim if it was un-promoted
    #     that week.
    #
    # The second one used to be conditional on the first, which starved the
    # metric under an Offer filter: `rows_for` drops every non-promoted row
    # when a promotion is selected, so no SKU had a baseline and EVERY
    # candidate event was excluded ("no non-promoted row in this selection").
    # A scope naming one promotion -- the Simulation Studio's normal scope, and
    # the Insights Hub's whenever an Offer is picked -- could therefore never
    # report a rate, however much evidence the Brand Form held.
    #
    # For every other scope shape this is the same row set as before:
    # `baseline_rows_for` returns `rows_for` unchanged when no Offer or
    # Promotion-type filter is active, and a Product-filtered scope already
    # took this path. Nothing but cannibalization reads these rows -- see
    # `aggregate.calculate_kpis`, where `family_rows` feeds `cannib_rows` and
    # nothing else.
    widened = state.widened_to_brand_form()
    family_rows = baseline_rows_for(widened)
    previous_family = ()
    if previous_state is not None:
        previous_family = baseline_rows_for(previous_state.widened_to_brand_form())

    bundle = A.calculate_kpis(
        rows,
        previous_rows,
        family_rows=family_rows,
        previous_family_rows=previous_family,
        promoted_products=frozenset(state.product) if state.product else None,
        volume_rows=volume_rows,
        previous_volume_rows=previous_volume,
    )
    label = F.fiscal_label(previous_state.year) if previous_state else None
    return bundle, label


def offer_label(promotion) -> str:
    """The name to show for an offer — see `Promotion.label`, the one source
    the filter options read too."""
    return promotion.label if promotion is not None else ""


def _display(value: float | None, unit: str, currency: str) -> str:
    if unit == "currency":
        return F.money(value, currency)
    if unit == "percent":
        return F.percent(value)
    if unit == "multiple":
        return F.multiple(value)
    return F.score(value)


def _meta(
    state: FilterState,
    rows: Sequence[A.WeekRow],
    currency: str,
    comparison: str | None,
    target: float = config.PROMOTION_TARGET_ROI,
) -> dict[str, Any]:
    return {
        "period": F.period_label(state.year, state.month),
        "period_label": F.fiscal_label(state.year),
        "comparison_period": comparison,
        "currency": currency,
        "base_currency": config.BASE_CURRENCY,
        "exchange_rate": F._rate(currency),
        # The target every figure in this payload was judged against, and the
        # default it can be reset to. The bands travel with it so the alert
        # legend can name them instead of restating 1.25 / 1.40 in code.
        "target_roi": target,
        "default_target_roi": config.PROMOTION_TARGET_ROI,
        "target_roi_range": [config.TARGET_ROI_MIN, config.TARGET_ROI_MAX],
        "severity_bands": config.severity_bands(target),
        "row_count": len(rows),
        "filters_applied": state.applied(),
    }


# --- cannibalization: the evidence floor and the measurement ladder --------
#
# TWO RULES, both ABOUT REPORTING and neither about the arithmetic.
# `aggregate.cannibalization_detail` stays the one implementation; what follows
# decides whether its answer is strong enough to show, and -- when it is not --
# whether a WIDER scope the same engine can measure should be offered beside
# the gap.

#: A rate off one or two comparable events is a coincidence with a percent
#: sign. Below this the metric reports unavailable, exactly as it does when no
#: event was comparable at all.
CANNIBALIZATION_MIN_EVENTS = 3

#: The ladder, walked in order, each rung lifting ONE dimension from the pinned
#: scope -- never cumulative, so the subject stays recognisable. Lifting the
#: channel keeps the same promotion on the same SKU; lifting the offer keeps
#: the same SKU in the same channel. The Product pin is never lifted: it is
#: what makes the answer about the SKU the user is looking at.
_CANNIBALIZATION_LADDER: tuple[tuple[str, ...], ...] = (
    ("channel",),
    ("promotion", "promotion_type"),
)

#: How a lifted dimension reads once it is no longer constraining.
_LIFTED_LABEL = {
    "channel": "all channels",
    "promotion": "all promotions",
    "promotion_type": "all promotion types",
}


@lru_cache(maxsize=256)
def _cannibalization_detail(state: FilterState) -> dict[str, Any]:
    """The engine's own answer for one scope. No arithmetic lives here.
    Memoised per filter state (see `_bundle`); callers only read it."""
    return A.cannibalization_detail(
        baseline_rows_for(state.widened_to_brand_form()),
        frozenset(state.product) if state.product else None,
    )


def _clears_the_floor(detail: dict[str, Any]) -> bool:
    return (
        detail["overall"] is not None
        and detail["comparable_events"] >= CANNIBALIZATION_MIN_EVENTS
    )


def _scope_label(state: FilterState, lifted: tuple[str, ...]) -> str:
    """What the reported scope IS, in words, so a wider figure can never be
    mistaken for the pinned one."""
    store = get_store()
    parts: list[str] = []
    for dimension in ("promotion", "product", "channel"):
        if dimension in lifted:
            parts.append(_LIFTED_LABEL[dimension])
            continue
        values = getattr(state, dimension)
        if values:
            parts.append(", ".join(sorted(_group_label(store, dimension, v) for v in values)))
    return " · ".join(parts) if parts else "the whole selection"


def cannibalization_resolution(state: FilterState) -> dict[str, Any]:
    """WHERE the reported rate was measured, and on how much evidence.

    The pinned scope first. If it cannot clear the floor, the ladder is walked
    and the FIRST rung that does wins -- so the reported figure is always the
    narrowest scope the evidence actually supports.

    `value` is the PINNED scope's rate and stays None whenever the pinned scope
    could not be measured; a fallback never overwrites it, because that field
    means "this selection" everywhere else in the payload. The wider figure
    travels beside it in `measured_at`, carrying the scope it belongs to.
    """
    pinned = _cannibalization_detail(state)
    resolution: dict[str, Any] = {
        "value": pinned["overall"] if _clears_the_floor(pinned) else None,
        "comparable_events": pinned["comparable_events"],
        "measured_at": None,
    }
    if resolution["value"] is not None:
        return resolution

    for lifted in _CANNIBALIZATION_LADDER:
        wider = state.replace(**{dimension: None for dimension in lifted})
        if wider == state:
            continue  # Nothing constrained on that dimension -- not a rung.
        detail = _cannibalization_detail(wider)
        if not _clears_the_floor(detail):
            continue
        resolution["measured_at"] = {
            "value": detail["overall"],
            "display_value": F.percent(detail["overall"]),
            "comparable_events": detail["comparable_events"],
            "lifted": list(lifted),
            "scope_label": _scope_label(state, lifted),
        }
        return resolution

    return resolution


def _cannibalization_card(card: dict[str, Any], state: FilterState, bundle: A.KpiBundle) -> None:
    """Apply the floor and the ladder to the assembled card, in place.

    NOTHING IS RECOMPUTED: the value is the engine's, and suppressing it drops
    every derived figure with it. A delta against a rate that is no longer
    reported would be a comparison to something the card does not show.
    """
    resolution = cannibalization_resolution(state)
    card["comparable_events"] = resolution["comparable_events"]
    card["measured_at"] = resolution["measured_at"]
    if resolution["value"] is not None:
        return

    card.update(
        value=None,
        display_value=F.percent(None),
        available=False,
        previous_value=None,
        delta=None,
        delta_display=None,
        delta_sub=None,
        difference=None,
        trend=None,
        unavailable_reason=_thin_evidence_reason(resolution["comparable_events"], bundle),
    )


def _thin_evidence_reason(comparable: int, bundle: A.KpiBundle) -> str:
    """Why the rate is absent -- no evidence, or not enough of it."""
    if comparable == 0:
        return _why_unavailable("cannibalization_rate", bundle)
    return (
        f"Measured on {comparable} comparable promotion "
        f"event{'' if comparable == 1 else 's'}, below the "
        f"{CANNIBALIZATION_MIN_EVENTS} this rate is reported from. A share "
        "computed over one or two events is not a rate this selection can "
        "support."
    )


# --- KPI cards -------------------------------------------------------------


def kpis(
    state: FilterState, currency: str = "INR", target: float = config.PROMOTION_TARGET_ROI
) -> dict[str, Any]:
    """The six KPI cards, and the three the Insights Hub reveals beneath them.

    `value` is always the canonical base-currency number; `display_value` is
    what the card shows, converted only if the KPI is monetary. ROI, PEI and
    Cannibalization carry the same `value` in both currencies by construction.

    `kpis` holds the six and nothing else -- see `SECONDARY_KPI_SPECS` for why
    the second row travels under `secondary` rather than joining them.

    `target` is the ROI hurdle the Insights Hub reader may set (see
    `config.TARGET_ROI_MIN/MAX`). It reaches ONLY what is judged against a
    target -- Target Hit Rate, and the target named in a card's text. No
    figure the six cards report depends on it.
    """
    currency = F.normalise_currency(currency)
    bundle, comparison = _bundle(state)
    rows = rows_for(state)

    cards: dict[str, Any] = {}
    for spec in KPI_SPECS:
        metric: A.KpiMetric = getattr(bundle, _BUNDLE_FIELD[spec.key])
        cards[spec.key] = _card(spec, metric, comparison, currency, bundle, target)

    # The floor and the ladder, applied ONCE and here, so the Insights Hub
    # card and everything reading `service.kpis` -- the Simulation Studio
    # included -- report the same rate from the same evidence.
    _cannibalization_card(cards["cannibalization_rate"], state, bundle)

    secondary: dict[str, Any] = {}
    for spec in SECONDARY_KPI_SPECS:
        if spec.key == "target_hit_rate":
            metric = _target_hit_rate_metric(state, target)
        else:
            metric = getattr(bundle, _BUNDLE_FIELD[spec.key])
        secondary[spec.key] = _card(spec, metric, comparison, currency, bundle, target)

    # The reconciliation line, on every card. A display string beside the
    # figure, never a figure of its own: the six cards' values, deltas and
    # every other field are exactly what they were before it existed. It
    # belongs to a figure, so an unavailable card carries its reason instead,
    # never a row of zeros.
    for card in (*cards.values(), *secondary.values()):
        card["evidence"] = _evidence(card, state, bundle, currency, target) if card["available"] else None

    return {
        "kpis": cards,
        "secondary": secondary,
        "meta": _meta(state, rows, currency, comparison, target),
    }


def _card(
    spec: KpiSpec,
    metric: A.KpiMetric,
    comparison: str | None,
    currency: str,
    bundle: A.KpiBundle,
    target: float = config.PROMOTION_TARGET_ROI,
) -> dict[str, Any]:
    """One card's payload. The six original cards and the second row are
    built by this same function, so a field cannot exist on one and not the
    other."""
    delta_display, delta_sub = F.delta_label(metric.growth, comparison)
    trend = _trend_of(metric.growth, spec.lower_is_better)
    if spec.unit == "multiple" and metric.difference is not None:
        # A ratio moves by its DIFFERENCE, the same rule the comparison
        # card states: 1.5 -> 1.3 is "-0.2", not "-13.3%" -- a percent
        # change of a multiple reads as a change in the return itself.
        # `delta` still carries the growth figure the trend arrow and the
        # sort order read; only the printed movement changes.
        delta_display = F.multiple(metric.difference, signed=True)
    elif spec.delta_as != "growth" and comparison and metric.value is not None and metric.previous_year is not None:
        # Points and differences are taken from the pair directly rather than
        # from `growth`, which is undefined when the prior value is zero -- a
        # hit rate that rose from 0.0% to 12.5% moved by 12.5 pp, and saying
        # so is not a fabricated figure the way a percent change would be.
        difference = round(metric.value - metric.previous_year, 1)
        delta_display = (
            f"{difference:+,.1f} pp" if spec.delta_as == "points"
            else _signed_money(difference, currency)
        )
        trend = None if difference == 0 else ("up" if difference > 0 else "down")
    return {
        "key": spec.key,
        "label": spec.label,
        "unit": spec.unit,
        "value": metric.value,
        "display_value": _display(metric.value, spec.unit, currency),
        "previous_value": metric.previous_year,
        "delta": metric.growth,
        "delta_display": delta_display,
        "delta_sub": delta_sub,
        "difference": metric.difference,
        "trend": trend,
        "available": metric.value is not None,
        "unavailable_reason": None if metric.value is not None else _why_unavailable(spec.key, bundle),
        "info": {
            "name": spec.label,
            "formula": _retarget(spec.formula, target),
            "meaning": _retarget(spec.meaning, target),
        },
    }


def _retarget(text: str, target: float) -> str:
    """A spec's text names the DEFAULT target ("The target is 1.50"); when
    the reader has set another, the text says that one instead. The specs
    themselves stay written at the default, because every other reader of
    `KPI_SPECS` -- scenarios, the comparison engine, the weekly view --
    describes the KPI at the default and must go on doing so."""
    if target == config.PROMOTION_TARGET_ROI:
        return text
    return text.replace(f"{config.PROMOTION_TARGET_ROI:.2f}", f"{target:.2f}")


def _signed_money(value: float, currency: str) -> str:
    """`F.money` with an explicit plus, for a movement rather than an amount."""
    text = F.money(value, currency)
    return f"+{text}" if value > 0 else text


def _target_hits(events: Sequence[PromotionEvent], target: float = config.PROMOTION_TARGET_ROI) -> tuple[int, int]:
    """(events at or above the ROI target, all events). THE one count the
    Risk Alerts panel and the Target Hit Rate card both report, so a reader
    who divides the panel's figures gets the card's number exactly."""
    on_target = sum(1 for e in events if e.roi_multiple is not None and e.roi_multiple >= target)
    return on_target, len(events)


def _hit_rate(events: Sequence[PromotionEvent], target: float) -> float | None:
    hits, total = _target_hits(events, target)
    ratio = A.safe_divide(hits, total)
    return None if ratio is None else round(ratio * 100, 1)


def _target_hit_rate_metric(state: FilterState, target: float) -> A.KpiMetric:
    """Target Hit Rate against the same-filters-previous-year selection, the
    comparison every other card makes. Not in the bundle because it is a
    count of events, not a sum over rows -- it reads `promotion_events`, the
    same memoised set the alerts are ranked from."""
    previous_state = state.comparison(get_store())
    previous = _hit_rate(promotion_events(previous_state, target), target) if previous_state else None
    return A.calculate_growth(_hit_rate(promotion_events(state, target), target), previous)


def _evidence(
    card: dict[str, Any],
    state: FilterState,
    bundle: A.KpiBundle,
    currency: str,
    target: float = config.PROMOTION_TARGET_ROI,
) -> str | None:
    """The one line that lets a reader reconcile a card by hand: the inputs
    its value was made from, in the card's own currency. Read from the
    bundle's debug trace, which is the reconciliation record every headline
    figure is already traceable through, so nothing here is a second
    computation of anything."""
    d = bundle.debug
    key = card["key"]
    money = lambda v: F.money(v, currency)  # noqa: E731 -- one currency, many calls
    if key == "trade_spend":
        discount, cost = d.get("trade_spend_discount"), d.get("trade_spend_promotion_cost")
        if discount is None or cost is None:
            return None
        return f"{money(discount)} discount given + {money(cost)} promotion cost"
    if key == "incremental_sales":
        units, channels = d.get("incremental_quantity"), d.get("promoted_product_channels")
        if units is None or not channels:
            return None
        return f"{units:+,.0f} units across {channels:,} promoted product-channel{'' if channels == 1 else 's'}"
    if key == "promotion_roi":
        sales, spend = d.get("incremental_sales"), d.get("trade_spend")
        if sales is None or not spend:
            return None
        return f"{money(sales)} returned on {money(spend)} spend · target {target:.2f}"
    if key == "margin_impact":
        revenue, cost = d.get("actual_revenue"), d.get("total_cost")
        if not revenue or cost is None:
            return None
        return f"{money(revenue)} revenue − {money(cost)} cost"
    if key == "pei":
        roi, uplift, margin = d.get("roi"), d.get("incremental_quantity_percent"), d.get("margin_impact")
        parts = [
            f"ROI {F.multiple(roi)}" if roi is not None else None,
            f"uplift {F.percent(uplift)}" if uplift is not None else None,
            f"margin {F.percent(margin)}" if margin is not None else None,
        ]
        return " · ".join(p for p in parts if p) or None
    if key == "cannibalization_rate":
        events = card.get("comparable_events")
        if not isinstance(events, int) or not events:
            return None
        return f"Measured on {events:,} comparable promotion event{'' if events == 1 else 's'}"
    if key == "volume_uplift":
        incremental, baseline = d.get("incremental_quantity"), d.get("baseline_quantity")
        if incremental is None or not baseline:
            return None
        return f"{incremental:+,.0f} units on a {baseline:,.0f} baseline"
    if key == "net_incremental_profit":
        sales, spend = d.get("incremental_sales"), d.get("trade_spend")
        if sales is None or spend is None:
            return None
        return f"{money(sales)} incremental sales − {money(spend)} trade spend"
    if key == "target_hit_rate":
        hits, total = _target_hits(promotion_events(state, target), target)
        if not total:
            return None
        return f"{hits:,} of {total:,} events at or above {target:.2f}"
    return None


def _trend_of(growth: float | None, lower_is_better: bool) -> str | None:
    """"up"/"down" as a DIRECTION, plus whether that direction is good.

    The card colours the arrow by `trend`; a rising Trade Spend is a rise, not
    an improvement, which is why `lower_is_better` travels with it.
    """
    if growth is None:
        return None
    return "up" if growth > 0 else "down"


def _why_unavailable(key: str, bundle: A.KpiBundle) -> str:
    if key == "cannibalization_rate":
        excluded = bundle.debug.get("excluded_events", 0)
        return (
            "No comparable promotion event in this selection — every candidate was "
            f"excluded ({excluded} checked). Cannibalization needs a promoted pack "
            "with an un-promoted neighbour in the same Brand Form and week."
        )
    if key == "pei":
        return "Nothing in this selection was promoted, so there is no promotion efficiency to index."
    if key in ("volume_uplift", "net_incremental_profit"):
        return "Nothing in this selection was promoted, so there is no uplift to measure."
    if key == "target_hit_rate":
        return "No promotion event in this selection, so there is nothing to score against the target."
    return "No data in this selection."


# --- promotion events ------------------------------------------------------


@dataclass(frozen=True)
class PromotionEvent:
    """One promotion event: Year + Week + Product + Promotion.

    This is the grain risk alerts and the underperforming table report at.
    Different Promotion_Ids are never merged — a week running both a 5% and a
    10% offer is two events, and combining them would report a promotion that
    never ran.
    """

    key: str
    year: int
    week_key: str
    product_id: str
    product_name: str
    brand_form: str
    channel_id: str
    channel_name: str
    promotion_id: str
    promotion_name: str
    promotion_type: str
    trade_spend: float
    incremental_sales: float
    roi_multiple: float | None
    at_stake: float

    @property
    def label(self) -> str:
        return f"{self.promotion_name} · {self.product_name.strip()} ({self.week_key})"


@lru_cache(maxsize=128)
def promotion_events(
    state: FilterState, target: float = config.PROMOTION_TARGET_ROI
) -> tuple[PromotionEvent, ...]:
    """Every promotion event in the selection, priced by the shared engine.

    Memoised per filter state AND target (see `_bundle`); returned as a tuple
    of frozen events so no caller can edit the cached copy. Only `at_stake`
    reads the target -- spend, sales and ROI are the same events whatever the
    hurdle.

    Trade Spend and Incremental Sales per event come from `period_series`,
    which holds the selection-wide baseline fixed — so the events sum exactly
    to the headline cards rather than forming a second, disagreeing total.
    """
    store = get_store()
    rows = baseline_rows_for(state)

    def key_of(r: A.WeekRow) -> str:
        return f"{r.product_id}|{r.channel_id}|{r.week_key}|{r.promotion_id}"

    points = {p.period_key: p for p in A.period_series(rows, key_of)}

    # The dimension labels for each event key, taken from the rows themselves.
    labels: dict[str, A.WeekRow] = {}
    for r in rows:
        if r.is_promoted:
            labels.setdefault(key_of(r), r)

    events: list[PromotionEvent] = []
    for key, row in labels.items():
        point = points.get(key)
        if point is None:
            continue
        spend = point.trade_spend
        sales = point.incremental_sales
        roi = A.roi_multiple(sales, spend)
        product = store.dims.products.get(row.product_id)
        channel = store.dims.channels.get(row.channel_id)
        promotion = store.dims.promotions.get(row.promotion_id)
        events.append(PromotionEvent(
            key=key,
            year=int(row.year),
            week_key=row.week_key,
            product_id=row.product_id,
            product_name=product.name if product else row.product_id,
            brand_form=row.brand_form,
            channel_id=row.channel_id,
            channel_name=channel.name if channel else row.channel_id,
            promotion_id=row.promotion_id,
            promotion_name=offer_label(promotion) or row.promotion_id,
            promotion_type=promotion.type if promotion else "",
            trade_spend=spend,
            incremental_sales=sales,
            roi_multiple=roi,
            # At Stake: the additional incremental revenue this event needs to
            # reach the ROI target. Never negative — an event already at target
            # has nothing at stake.
            at_stake=round(max(config.target_incremental_sales(spend, target) - sales, 0.0), 1),
        ))
    return tuple(events)


def _rank_key(event: PromotionEvent) -> tuple:
    """At Stake DESC, then Trade Spend DESC, then ROI ASC.

    At Stake leads deliberately: it is the business-priority metric — the money
    needed to reach target. Ranking by lowest ROI first would put a tiny
    promotion with a catastrophic multiple above a large one quietly losing
    far more money.
    """
    return (-event.at_stake, -event.trade_spend, event.roi_multiple if event.roi_multiple is not None else 0.0)


def _severity(roi_multiple: float | None, target: float = config.PROMOTION_TARGET_ROI) -> str | None:
    """The severity band for an event's ROI. None once the target is met."""
    if roi_multiple is None:
        return None
    bands = config.severity_bands(target)
    if roi_multiple < bands["critical"]:
        return "critical"
    if roi_multiple < bands["high"]:
        return "high"
    if roi_multiple < bands["medium"]:
        return "medium"
    return None


# --- risk alerts -----------------------------------------------------------

_SEVERITY_TONE = {"critical": "danger", "high": "danger", "medium": "warning"}
_SEVERITY_LABEL = {"critical": "Critical", "high": "High", "medium": "Medium"}


def risk_alerts(
    state: FilterState,
    currency: str = "INR",
    limit: int = 20,
    target: float = config.PROMOTION_TARGET_ROI,
) -> dict[str, Any]:
    """Promotion events below the ROI target, banded and ranked.

    Counts are of unique promotion EVENTS, and every ROI here is the same
    `roi_multiple` the KPI card uses.
    """
    currency = F.normalise_currency(currency)
    events = promotion_events(state, target)

    banded: dict[str, list[PromotionEvent]] = defaultdict(list)
    for event in events:
        severity = _severity(event.roi_multiple, target)
        if severity and event.trade_spend > 0:
            banded[severity].append(event)

    on_target, _ = _target_hits(events, target)

    alerts: list[dict[str, Any]] = []
    for severity in ("critical", "high", "medium"):
        for event in sorted(banded[severity], key=_rank_key):
            alerts.append({
                "id": event.key,
                "severity": _SEVERITY_LABEL[severity],
                "tone": _SEVERITY_TONE[severity],
                "title": f"ROI below target — {event.promotion_name}",
                "description": (
                    f"{event.product_name.strip()} · {event.channel_name} · {event.week_key}: "
                    f"ROI {event.roi_multiple:.2f} against a {target:.2f} target."
                ),
                "roi_multiple": event.roi_multiple,
                "trade_spend": event.trade_spend,
                "trade_spend_display": F.money(event.trade_spend, currency),
                "incremental_sales": event.incremental_sales,
                "at_stake": event.at_stake,
                "at_stake_display": F.money(event.at_stake, currency),
                "channel": event.channel_name,
                "product": event.product_name.strip(),
                "week": event.week_key,
                # The event's own dimension codes, for the same reason the
                # underperforming rows carry them: a drill-down narrows BY
                # IDENTITY instead of handing over the whole selection. The
                # names beside them stay display-only and are never converted.
                #
                # `week` is NOT among them, and cannot be. An event's
                # Incremental Sales is measured against the non-promoted rows
                # of the SELECTION -- `promotion_events` holds that
                # selection-wide baseline fixed on purpose -- and a scope
                # narrowed to the promoted week contains no such row, so the
                # counterfactual disappears and the ROI collapses to 0.0.
                # The week identifies the event; it cannot scope it.
                "promotion_id": event.promotion_id,
                "product_id": event.product_id,
                "channel_id": event.channel_id,
            })

    return {
        "counts": {
            "critical": len(banded["critical"]),
            "high": len(banded["high"]),
            "medium": len(banded["medium"]),
            "target_achieved": on_target,
            "total_events": len(events),
        },
        "alerts": alerts[:limit],
        "meta": _meta(state, rows_for(state), currency, None, target),
    }


# --- underperforming promotions --------------------------------------------

_CAUSES = (
    # (predicate, cause, action) — evaluated in order, first match wins. These
    # read only numbers the engine already produced; nothing is invented.
    (lambda e, m: e.incremental_sales <= 0,
     "No measurable uplift over baseline",
     "Review whether the offer reached the shelf"),
    (lambda e, m: m > 25,
     "High cannibalization within the Brand Form",
     "Shift the offer to a non-adjacent pack size"),
    (lambda e, m: e.trade_spend > 0 and e.incremental_sales / e.trade_spend < 1,
     "Trade spend exceeds the revenue it returned",
     "Reduce discount depth or promotion cost"),
    (lambda e, m: True,
     "Uplift below the level the spend requires",
     "Re-test at a shallower discount"),
)


def underperforming_promotions(
    state: FilterState,
    currency: str = "INR",
    limit: int = 20,
    target: float = config.PROMOTION_TARGET_ROI,
) -> dict[str, Any]:
    """Promotion events with ROI below target, sorted by At Stake DESC.

    Uses the same shared ROI and the same event grain as the risk alerts —
    the two panels are two views of one computation.
    """
    currency = F.normalise_currency(currency)
    events = promotion_events(state, target)
    bundle, _ = _bundle(state)
    by_brand = bundle.debug.get("brand_form_cannibalization", {}) or {}

    under = [e for e in events if e.roi_multiple is not None and e.roi_multiple < target]

    rows: list[dict[str, Any]] = []
    for event in sorted(under, key=_rank_key)[:limit]:
        cannib = by_brand.get(event.brand_form, 0.0)
        cause, action = next(
            (c, a) for predicate, c, a in _CAUSES if predicate(event, cannib)
        )
        rows.append({
            # THE EVENT'S OWN DIMENSION CODES, carried so a drill-down can
            # narrow BY IDENTITY. They are not derived here and nothing is
            # guessed: `PromotionEvent` was built from the WeekRows themselves,
            # so these are the same codes the row was selected by. Without them
            # a click on this table could only hand over the user's existing
            # selection, and the Simulation Studio would answer for the whole
            # promotion while the row on screen described one SKU in one
            # channel in one week.
            #
            # THE WEEK IS STILL NOT NARROWABLE. FilterState has `year` and
            # `month` and no week, so a hand-off reaches this event's
            # (promotion, product, channel) and pools whatever weeks that pair
            # traded in scope. Exact for a single-week event; a pooled figure
            # otherwise, which is a real number for a real scope rather than a
            # week invented out of a month.
            "promotion": event.promotion_name,
            "promotion_id": event.promotion_id,
            "product": event.product_name.strip(),
            "product_id": event.product_id,
            "channel": event.channel_name,
            "channel_id": event.channel_id,
            "period": event.week_key,
            "roi_multiple": event.roi_multiple,
            "roi_display": F.multiple(event.roi_multiple),
            "vs_target": round(event.roi_multiple - target, 2),
            "trade_spend": event.trade_spend,
            "trade_spend_display": F.money(event.trade_spend, currency),
            "at_stake": event.at_stake,
            "at_stake_display": F.money(event.at_stake, currency),
            "primary_cause": cause,
            "action": action,
            "status": "Underperforming",
        })

    return {
        "rows": rows,
        "total": len(under),
        "meta": _meta(state, rows_for(state), currency, None, target),
    }


def top_promotions(
    state: FilterState,
    currency: str = "INR",
    limit: int = 10,
    target: float = config.PROMOTION_TARGET_ROI,
) -> dict[str, Any]:
    """The best-performing promotion events, by ROI descending."""
    currency = F.normalise_currency(currency)
    events = [e for e in promotion_events(state, target) if e.roi_multiple is not None]
    ranked = sorted(events, key=lambda e: -(e.roi_multiple or 0))[:limit]
    return {
        "rows": [
            {
                "promotion": e.promotion_name,
                "product": e.product_name.strip(),
                "channel": e.channel_name,
                "period": e.week_key,
                "roi_multiple": e.roi_multiple,
                "roi_display": F.multiple(e.roi_multiple),
                "vs_target": round(e.roi_multiple - target, 2),
                "trade_spend": e.trade_spend,
                "trade_spend_display": F.money(e.trade_spend, currency),
                "incremental_sales": e.incremental_sales,
                "incremental_sales_display": F.money(e.incremental_sales, currency),
                "status": "On Track" if e.roi_multiple >= target else "Underperforming",
            }
            for e in ranked
        ],
        "meta": _meta(state, rows_for(state), currency, None, target),
    }


# --- promotion mix ---------------------------------------------------------

_MIX_COLORS = ("#7C5CFF", "#4F7CFF", "#14B8A6", "#F59E0B", "#EF4444", "#9CA3AF")


def promotion_mix(state: FilterState, currency: str = "INR") -> dict[str, Any]:
    """Trade Spend share by offer, read off dim_promotion.

    Grouped on the promotion's own name — never reverse-engineered from a
    realised price, which would invent buckets the promotion calendar never
    ran. Only offers actually present in the selection are returned.
    """
    currency = F.normalise_currency(currency)
    store = get_store()
    rows = rows_for(state)

    spend: dict[str, float] = defaultdict(float)
    for r in rows:
        if r.is_promoted:
            spend[r.promotion_id] += r.discount_value + r.promotion_cost

    total = sum(spend.values())
    slices = []
    for index, (promotion_id, value) in enumerate(
        sorted(spend.items(), key=lambda kv: -kv[1])
    ):
        promotion = store.dims.promotions.get(promotion_id)
        slices.append({
            "code": promotion_id,
            "label": offer_label(promotion) or promotion_id,
            "type": promotion.type if promotion else "",
            "spend": round(value, 1),
            "spend_display": F.money(value, currency),
            "pct": round(value / total * 100, 1) if total else 0.0,
            "color": _MIX_COLORS[index % len(_MIX_COLORS)],
        })

    return {
        "slices": slices,
        "total_spend": round(total, 1),
        "total_spend_display": F.money(total, currency),
        "meta": _meta(state, rows, currency, None),
    }


# --- trend -----------------------------------------------------------------


def trend(
    state: FilterState,
    granularity: str = "week",
    currency: str = "INR",
    target: float = config.PROMOTION_TARGET_ROI,
) -> dict[str, Any]:
    """Trade Spend, Incremental Sales and ROI over time.

    The series are a finer PARTITION of the same rows the cards read — Trade
    Spend and Incremental Sales sum back to the headline figures exactly — and
    each point's ROI goes through the same `roi_multiple`.
    """
    currency = F.normalise_currency(currency)
    # The baseline-widened set: its incremental figures sum to the card, and
    # the non-promoted rows add exactly zero to Trade Spend.
    rows = baseline_rows_for(state)
    monthly = granularity == "month"

    def key_of(r: A.WeekRow) -> str:
        return f"{r.year}-{r.month:02d}" if monthly else r.week_key

    points = A.period_series(rows, key_of)

    labels, roi, incremental, spend = [], [], [], []
    for point in points:
        labels.append(_period_label(point.period_key, monthly))
        roi.append(A.roi_multiple(point.incremental_sales, point.trade_spend))
        incremental.append(round(point.incremental_sales, 1))
        spend.append(round(point.trade_spend, 1))

    return {
        "granularity": "month" if monthly else "week",
        "labels": labels,
        "series": {
            "roi": roi,
            "incremental_sales": incremental,
            "trade_spend": spend,
            "target_roi": [target] * len(labels),
        },
        "display": {
            "incremental_sales": [F.money(v, currency) for v in incremental],
            "trade_spend": [F.money(v, currency) for v in spend],
            "roi": [F.multiple(v) for v in roi],
        },
        "meta": _meta(state, rows, currency, None, target),
    }


# --- sales performance comparison ------------------------------------------


@dataclass(frozen=True)
class ComparisonMetric:
    """One measure the comparison card can be read in."""

    key: str
    label: str
    unit: str  # currency | percent
    formula: str
    meaning: str
    lower_is_better: bool = False
    #: A ratio is compared by its DIFFERENCE, not as a percentage OF a ratio.
    #: ROI moving 1.30 -> 1.40 is +0.10; calling it +7.7% would be
    #: arithmetically true of the number and useless about the business.
    ratio: bool = False


COMPARISON_METRICS: tuple[ComparisonMetric, ...] = (
    ComparisonMetric(
        key="sales",
        label="Sales",
        unit="currency",
        formula="Σ Actual Revenue",
        meaning=(
            "Everything rung up in the period, promoted or not. A plain row sum, so "
            "it divides across periods exactly."
        ),
    ),
    ComparisonMetric(
        key="incremental_sales",
        label="Incremental Sales",
        unit="currency",
        formula="Σ over promoted rows of (Actual Quantity − baseline) × Actual Price",
        meaning=(
            "Revenue the promotions added above ordinary trading level. Every month "
            "here is measured against ONE baseline taken over the whole span, so two "
            "months differ by performance and not by baseline."
        ),
    ),
    ComparisonMetric(
        key="trade_spend",
        label="Trade Spend",
        unit="currency",
        formula="Σ (Base Revenue − Actual Revenue + Promotion Cost)",
        meaning="The investment behind the promotions — discount given away plus promotion cost.",
        lower_is_better=True,
    ),
    ComparisonMetric(
        key="roi",
        label="Promotion ROI",
        unit="multiple",
        formula="Incremental Sales ÷ Trade Spend",
        meaning=(
            "Incremental sales returned per rupee of trade spend for the period. A ratio "
            "of the two sums above, so it is compared as a difference in multiples."
        ),
        ratio=True,
    ),
)

_METRIC_BY_KEY = {m.key: m for m in COMPARISON_METRICS}

#: How many months the chart shows, ending at the selected one. Thirteen and
#: not twelve so the YEAR-AGO month is always the leftmost column rather than
#: one step off the edge of the chart that is meant to show the comparison.
COMPARISON_SPAN = 13


def _pkey(year: int, month: int) -> str:
    """"2025-09". Zero-padded, so it sorts chronologically as a string."""
    return f"{year}-{month:02d}"


@lru_cache(maxsize=128)
def _period_totals(state: FilterState) -> dict[tuple[int, int], dict[str, float | None]]:
    """Every measure, per (year, month), for the selection with its own PERIOD
    constraint lifted. Memoised per filter state (see `_bundle`); callers only
    read it.

    ONE BASELINE ACROSS THE WHOLE SPAN, which is the point. `A.period_series`
    holds the baseline fixed at the level computed over every row passed in and
    groups only the per-row terms — the same treatment the trend chart gets. So
    September and the September before it are measured against the same trading
    level, and the difference between them is performance rather than partly an
    artefact of two separately-derived baselines.

    That is also why the year filter is dropped: a year-ago comparison spans
    years by definition, and re-baselining per year would make the two halves
    of the comparison incommensurable.

    NOTE this is not the same baseline the KPI card uses when you filter it to
    a single month — that card re-derives from that month alone, which is right
    for a card describing one period and wrong for one comparing two.

    Two row sets, each the standard one for its measure:
      * SALES is gross revenue over `rows_for` — the actual selection.
      * The promotional measures use `baseline_rows_for`, which re-admits the
        non-promoted rows the baseline is derived from. Those rows contribute
        exactly zero to Trade Spend, so it is unaffected.
    They are the same rows unless an Offer or Promotion-type filter is active.
    """
    period_free = state.replace(year=None, month=None, week=None)

    sales: dict[str, float] = defaultdict(float)
    for row in rows_for(period_free):
        sales[_pkey(int(row.year), row.month)] += row.actual_revenue

    points = A.period_series(
        baseline_rows_for(period_free),
        lambda r: _pkey(int(r.year), r.month),
    )

    totals: dict[tuple[int, int], dict[str, float | None]] = {}
    for point in points:
        year, month = int(point.period_key[:4]), int(point.period_key[-2:])
        totals[(year, month)] = {
            "sales": sales.get(point.period_key, 0.0),
            "incremental_sales": point.incremental_sales,
            "trade_spend": point.trade_spend,
            "roi": A.roi_multiple(point.incremental_sales, point.trade_spend),
        }
    return totals


def _window_totals(
    totals: dict[tuple[int, int], dict[str, float | None]],
    window: Sequence[tuple[int, int]],
) -> dict[str, float | None] | None:
    """The measures over a run of months, or None if the run is incomplete.

    The three additive measures sum. ROI does NOT: it is recomputed from the
    summed parts through the same `roi_multiple` every other ROI goes through,
    because a mean of monthly ratios is not the ratio of the period.

    An incomplete window returns None rather than a total over the months that
    happen to exist — a real number computed over the wrong period is worse
    than an honest gap, because nothing about it looks wrong.
    """
    if not window or any(k not in totals for k in window):
        return None
    summed = {
        key: sum(totals[k][key] or 0.0 for k in window)
        for key in ("sales", "incremental_sales", "trade_spend")
    }
    summed["roi"] = A.roi_multiple(summed["incremental_sales"], summed["trade_spend"])
    return summed


def _previous_month(year: int, month: int) -> tuple[int, int]:
    """The month before, crossing the year boundary: Jan 2025 -> Dec 2024."""
    return (year - 1, 12) if month == 1 else (year, month - 1)


def _month_label(year: int, month: int) -> str:
    return f"{MONTHS[month - 1]} {F.fiscal_label(year)}"


def _ytd_label(year: int, month: int) -> str:
    """"Jan-Sep F25", or just "Jan F25" when the year is one month old."""
    if month == 1:
        return f"{MONTHS[0][:3]} {F.fiscal_label(year)}"
    return f"{MONTHS[0][:3]}-{MONTHS[month - 1][:3]} {F.fiscal_label(year)}"


def _amount(value: float | None, metric: ComparisonMetric, currency: str) -> dict[str, Any]:
    """One measured amount, formatted by the metric's own unit."""
    return {
        "value": None if value is None else round(value, 2 if metric.unit == "multiple" else 1),
        "display": _display(value, metric.unit, currency),
    }


def _delta(
    current: float | None,
    prior: float | None,
    metric: ComparisonMetric,
    currency: str,
) -> dict[str, Any]:
    """How `current` stands against `prior`, in the metric's own terms.

    A ratio moves by its difference (0.1); an amount moves by a percentage of
    itself. Both are formatted here so the card never divides and never has to
    know which kind of number it is holding.

    `direction` is the raw movement. `good` is whether that movement is welcome,
    which is not the same question — a rise in Trade Spend is a rise and not an
    improvement — and is None when the metric has no better direction.
    """
    if current is None or prior is None:
        return {"value": None, "display": "—", "direction": None, "good": None, "basis": None}

    if metric.ratio:
        value = current - prior
        display = F.multiple(value, signed=True) if value else "0.00"
        basis = "multiple"
    else:
        if not prior:
            return {"value": None, "display": "—", "direction": None, "good": None, "basis": None}
        value = (current - prior) / prior * 100
        display = F.percent(value, signed=True)
        basis = "percent change"

    direction = "up" if value > 0 else "down" if value < 0 else "flat"
    good = None if direction == "flat" else (direction == "down") == metric.lower_is_better
    return {
        "value": round(value, 2 if metric.ratio else 1),
        "display": display,
        "direction": direction,
        "good": good,
        "basis": basis,
    }


def sales_comparison(
    state: FilterState,
    year: int | None = None,
    month: int | None = None,
    currency: str = "INR",
) -> dict[str, Any]:
    """One month read beside the periods a planner judges it against.

        MAGO  the month before               short-term momentum
        YAGO  the same month a year earlier  year on year, seasonality held
        YTD   January to the selected month, cumulative, against the same
              window a year earlier          where the year stands

    YTD is not itself a comparison but a cumulative total, so it is reported
    beside YTD YAGO — otherwise its growth would have nothing to be a growth OF.

    Four measures, each carried for every period: Sales, Incremental Sales,
    Trade Spend and ROI. See `COMPARISON_METRICS` for what each one is and
    `_period_totals` for the one baseline they share.

    WHAT "AVAILABLE" MEANS HERE. This dataset starts in January 2024, so a 2024
    month has no year-ago period at all, and January 2024 has no month-ago
    period either. Those come back unavailable, with a reason. They are never
    filled with zero, which would read as "sold nothing last year" rather than
    "there was no last year".
    """
    currency = F.normalise_currency(currency)
    totals = _period_totals(state)
    periods = sorted(totals)

    empty = {
        "period": None,
        "available_periods": [],
        "latest": None,
        "metric_specs": [],
        "series": [],
        "windows": {},
        "figures": {},
        "meta": _meta(state, [], currency, None),
    }
    if not periods:
        return empty

    # The DATA's latest month, never today's date: this fact table ends before
    # the current date, so a wall-clock default would open the card on a month
    # with no rows at all.
    latest_year, latest_month = periods[-1]
    if year is None or month is None or (year, month) not in totals:
        year, month = latest_year, latest_month

    mago_key = _previous_month(year, month)
    yago_key = (year - 1, month)
    ytd_window = [(year, m) for m in range(1, month + 1)]
    yago_window = [(year - 1, m) for m in range(1, month + 1)]

    current = totals.get((year, month))
    mago = totals.get(mago_key)
    yago = totals.get(yago_key)
    ytd = _window_totals(totals, ytd_window)
    ytd_yago = _window_totals(totals, yago_window)

    no_prior_year = f"{F.fiscal_label(year - 1)} is not in this dataset"
    reasons = {
        "mago": None if mago else f"{_month_label(*mago_key)} is not in this dataset",
        "yago": None if yago else no_prior_year,
        "ytd_yago": None if ytd_yago else no_prior_year,
    }

    # The months the chart draws: the span ending at the selected month, and
    # only months the selection actually has.
    span: list[tuple[int, int]] = []
    cursor = (year, month)
    for _ in range(COMPARISON_SPAN):
        if cursor in totals:
            span.append(cursor)
        cursor = _previous_month(*cursor)
    span.reverse()

    figures: dict[str, Any] = {}
    for metric in COMPARISON_METRICS:
        pick = lambda bucket: None if bucket is None else bucket[metric.key]  # noqa: E731
        figures[metric.key] = {
            "current": {
                **_amount(pick(current), metric, currency),
                "label": _month_label(year, month),
                "available": current is not None,
                "unavailable_reason": None,
            },
            "mago": {
                **_amount(pick(mago), metric, currency),
                "label": _month_label(*mago_key),
                "available": mago is not None,
                "unavailable_reason": reasons["mago"],
            },
            "yago": {
                **_amount(pick(yago), metric, currency),
                "label": _month_label(*yago_key),
                "available": yago is not None,
                "unavailable_reason": reasons["yago"],
            },
            "ytd": {
                **_amount(pick(ytd), metric, currency),
                "label": _ytd_label(year, month),
                "available": ytd is not None,
                "unavailable_reason": None,
            },
            "ytd_yago": {
                **_amount(pick(ytd_yago), metric, currency),
                "label": _ytd_label(year - 1, month),
                "available": ytd_yago is not None,
                "unavailable_reason": reasons["ytd_yago"],
            },
            "delta": {
                "mago": _delta(pick(current), pick(mago), metric, currency),
                "yago": _delta(pick(current), pick(yago), metric, currency),
                "ytd": _delta(pick(ytd), pick(ytd_yago), metric, currency),
            },
        }

    return {
        "period": {"year": year, "month": month, "label": _month_label(year, month)},
        # Every month the SELECTION has rows for. The control is built from
        # this, so a period that cannot be answered cannot be picked.
        "available_periods": [
            {"year": y, "month": m, "label": _month_label(y, m)} for y, m in periods
        ],
        "latest": {"year": latest_year, "month": latest_month},
        "metric_specs": [
            {
                "key": m.key,
                "label": m.label,
                "unit": m.unit,
                "lower_is_better": m.lower_is_better,
                "ratio": m.ratio,
                "formula": m.formula,
                "meaning": m.meaning,
            }
            for m in COMPARISON_METRICS
        ],
        "series": [
            {
                "key": _pkey(y, m),
                "year": y,
                "month": m,
                "label": _month_label(y, m),
                "short": MONTHS[m - 1][:3],
                "year_short": F.fiscal_label(y),
                "values": {
                    metric.key: _amount(totals[(y, m)][metric.key], metric, currency)
                    for metric in COMPARISON_METRICS
                },
            }
            for y, m in span
        ],
        # Which columns each mode highlights, named so the chart never has to
        # re-derive a window the figures were already computed from.
        "windows": {
            "mago": {
                "current": [_pkey(year, month)],
                "against": [_pkey(*mago_key)] if mago else [],
            },
            "yago": {
                "current": [_pkey(year, month)],
                "against": [_pkey(*yago_key)] if yago else [],
            },
            "ytd": {
                "current": [_pkey(y, m) for y, m in ytd_window],
                "against": [_pkey(y, m) for y, m in yago_window] if ytd_yago else [],
            },
        },
        "figures": figures,
        "meta": _meta(state, [], currency, None),
    }


def _period_label(period_key: str, monthly: bool) -> str:
    """"2025-03" -> "Mar F25"; "2025-W07" -> "W07 F25"."""
    year, part = period_key.split("-", 1)
    fiscal = F.fiscal_label(int(year))
    if monthly:
        return f"{MONTHS[int(part) - 1][:3]} {fiscal}"
    return f"{part} {fiscal}"


# --- filters ---------------------------------------------------------------


def filters(state: FilterState) -> dict[str, Any]:
    """Dependent filter options for the current selection, plus the labels the
    period control shows (F24 / F25)."""
    options = options_for(state)
    options["year_labels"] = {str(y): F.fiscal_label(y) for y in options["years"]}
    options["currencies"] = list(config.SUPPORTED_CURRENCIES)
    options["selected"] = state.applied()
    return options


# --- breakdown -------------------------------------------------------------
#
# ONE endpoint behind every ranking and scatter chart. It does not contain a
# single line of KPI arithmetic: for each group it narrows the SAME FilterState
# by one more constraint and calls the frozen functions in aggregate.py. If a
# formula ever changes there, these charts move with it automatically.

#: Dimensions a breakdown can group by -> where its option list lives and how a
#: group value is labelled for display.
BREAKDOWN_DIMENSIONS: dict[str, str] = {
    "channel": "channels",
    "retailer": "retailers",
    "product": "products",
    "category": "categories",
    "brand": "brands",
    "promotion": "offers",
    # The MECHANIC: dim_promotion.Promotion_Name ("5% Discount", "20%
    # Discount", "Buy3Get1"), as opposed to "promotion", which is the
    # individual offer. Deliberately absent from every option list because it
    # is NOT unique per promotion — six seasonal offers share one mechanic —
    # so `breakdown` derives its group values from the offers in scope rather
    # than reading this key. Whitelist entry only: no new arithmetic, and every
    # KPI is still produced by app/tpo/aggregate.py unchanged.
    "promotion_mechanic": "offers",
    "promotion_type": "promotion_types",
    # Distributor lives on the store, so it takes the same generic re-filter
    # path as region/state/city. Whitelist entry only — no new arithmetic, and
    # every KPI below is still produced by app/tpo/aggregate.py unchanged.
    "distributor": "distributors",
    "region": "regions",
    "state": "states",
    "city": "cities",
}

#: What a breakdown may be ranked by. Incremental Sales is the default
#: everywhere: ranking by raw ROI surfaces trivia, because a promotion with
#: Rs 17k of trade spend can post 1,398% and outrank one carrying real money.
BREAKDOWN_METRICS = ("incremental_sales", "trade_spend", "incremental_units", "roi")


def _group_label(store, dimension: str, code: str) -> str:
    """The display name for one group value."""
    if dimension == "channel":
        channel = store.dims.channels.get(code)
        return channel.name if channel else code
    if dimension == "product":
        product = store.dims.products.get(code)
        return product.name.strip() if product else code
    if dimension == "promotion":
        promotion = store.dims.promotions.get(code)
        # Promotion_Description via Promotion.label — the one shared source.
        # Never deduplicated by Promotion_Name.
        return offer_label(promotion) or code
    if dimension == "promotion_mechanic":
        # The code IS Promotion_Name. Qualify it with the Promotion_Type every
        # promotion carrying that mechanic shares, so "20% Discount" reads as
        # the seasonal mechanic it is. Qualified only when the type is
        # unambiguous; a mechanic spanning two types keeps its bare name rather
        # than claiming one of them.
        types = {
            promotion.type
            for promotion in store.dims.promotions.values()
            if promotion.name.strip() == code and promotion.type
        }
        return f"{code} ({types.pop()})" if len(types) == 1 else code
    return code



#: Dimensions carried on the WeekRow itself, so a breakdown can partition one
#: already-filtered row set instead of re-running the filter per group.
#:
#: This is an optimisation, not a different calculation. The KPI grain is
#: (product, channel, week, offer), so filtering to one channel yields exactly
#: the WeekRows whose channel_id is that channel — no other group's rows can
#: merge into them. Partitioning therefore hands the frozen engine byte-identical
#: input to what a re-filter would, and `tests/test_breakdown.py` asserts the two
#: paths agree for every supported dimension.
#:
#: Retailer/region/state/city are NOT here: stores are pooled when WeekRows are
#: built, so their values are no longer recoverable from a row and a real filter
#: pass is required.
_WEEKROW_DIMENSIONS = (
    "channel", "product", "promotion", "promotion_mechanic", "promotion_type", "brand", "category",
)


def _partition(
    rows: Sequence[A.WeekRow], volume: Sequence[A.WeekRow], by: str, store
) -> dict[str, tuple[tuple[A.WeekRow, ...], tuple[A.WeekRow, ...]]]:
    """One filtered row set -> per-group (selection rows, volume rows).

    The volume set needs care for offer dimensions. `baseline_rows_for` keeps
    the non-promoted rows an uplift is measured against, so each offer's volume
    partition is ITS promoted rows plus EVERY non-promoted row — exactly what
    filtering to that offer would have produced.
    """
    def key_of(row: A.WeekRow) -> str | None:
        if by == "channel":
            return row.channel_id
        if by == "product":
            return row.product_id
        if by == "brand":
            return row.brand_form
        if by == "category":
            product = store.dims.products.get(row.product_id)
            return product.category if product else None
        if by == "promotion":
            return row.promotion_id if row.is_promoted else None
        if by == "promotion_mechanic":
            promotion = store.dims.promotions.get(row.promotion_id)
            return promotion.name.strip() if promotion and row.is_promoted else None
        if by == "promotion_type":
            promotion = store.dims.promotions.get(row.promotion_id)
            return promotion.type if promotion and row.is_promoted else None
        return None

    offer_dimension = by in ("promotion", "promotion_mechanic", "promotion_type")
    selection: dict[str, list[A.WeekRow]] = defaultdict(list)
    volumes: dict[str, list[A.WeekRow]] = defaultdict(list)
    baseline_rows = [r for r in volume if not r.is_promoted] if offer_dimension else []

    for row in rows:
        key = key_of(row)
        if key is not None:
            selection[key].append(row)
    for row in volume:
        key = key_of(row)
        if key is not None:
            volumes[key].append(row)

    return {
        key: (tuple(selection.get(key, ())), tuple(volumes.get(key, ())) + tuple(baseline_rows))
        for key in set(selection) | set(volumes)
    }


def breakdown(
    state: FilterState,
    by: str,
    currency: str = "INR",
    metric: str = "incremental_sales",
    limit: int = 10,
) -> dict[str, Any]:
    """Every KPI, computed per value of one dimension, ranked and truncated.

    For each group: take the user's FilterState, add that one constraint, and
    run the frozen engine over the resulting rows. The group list comes from
    `options_for`, so a value is only ever computed if it actually returns rows.

    ADDITIVITY. Trade Spend is a plain row sum and its groups add back to the
    headline exactly. Incremental Sales does NOT reliably add up: the baseline
    is re-derived per selection, which is why a year is not the sum of its
    months (-17.6% on this data). `share_pct` is therefore computed on Trade
    Spend only, and the caller must render a ranking, never a composition.
    """
    if by not in BREAKDOWN_DIMENSIONS:
        raise ValueError(f"Unsupported breakdown dimension: {by!r}")
    if metric not in BREAKDOWN_METRICS:
        raise ValueError(f"Unsupported breakdown metric: {metric!r}")

    currency = F.normalise_currency(currency)
    groups = [dict(g) for g in _breakdown_groups(state, by)]
    for group in groups:
        group["trade_spend_display"] = F.money(group["trade_spend"], currency)
        group["incremental_sales_display"] = F.money(group["incremental_sales"], currency)

    # None sorts last regardless of direction — an undefined ROI is not a
    # ranking position, and must not masquerade as the worst or the best.
    groups.sort(key=lambda g: (g[metric] is None, -(g[metric] or 0.0)))

    total_groups = len(groups)
    truncated = limit > 0 and total_groups > limit
    if truncated:
        groups = groups[:limit]

    return {
        "by": by,
        "metric": metric,
        "groups": groups,
        "truncated": truncated,
        "total_groups": total_groups,
        "meta": _meta(state, rows_for(state), currency, None),
    }


@lru_cache(maxsize=256)
def _breakdown_groups(state: FilterState, by: str) -> tuple[dict[str, Any], ...]:
    """The engine pass behind `breakdown`: every KPI per group, in canonical
    INR and in first-seen order. Memoised per (filter state, dimension) — the
    expensive part — so ranking by another metric, truncating, or switching
    the display currency never re-runs the engine. Callers copy each dict
    before adding display strings."""
    store = get_store()

    mechanic_members: dict[str, list[str]] = {}
    if by == "promotion_mechanic":
        # Derived from the offers the CURRENT scope holds, so the mechanic list
        # narrows with the filters exactly as every other dimension does. Order
        # is first-seen; `groups.sort` below decides the ranking regardless.
        #
        # `mechanic_members` records which Promotion_Ids each mechanic is made
        # of. A caller that needs to SCOPE a query to one mechanic — the
        # Channel card's discount selector — passes those ids to the existing
        # `promotion` filter, instead of carrying its own hardcoded map of
        # which offers belong to which mechanic.
        for entry in options_for(state)["offers"]:
            promotion = store.dims.promotions.get(entry["code"])
            if promotion and promotion.name:
                mechanic_members.setdefault(promotion.name.strip(), []).append(entry["code"])
        codes = list(mechanic_members)
    else:
        raw = options_for(state)[BREAKDOWN_DIMENSIONS[by]]
        codes = [entry["code"] if isinstance(entry, dict) else str(entry) for entry in raw]

    base_rows = rows_for(state)
    base_volume = baseline_rows_for(state)
    partitioned = _partition(base_rows, base_volume, by, store) if by in _WEEKROW_DIMENSIONS else None

    groups: list[dict[str, Any]] = []
    for code in codes:
        if partitioned is not None:
            rows, volume = partitioned.get(code, ((), ()))
        else:
            # Geography lives on the STORE, which WeekRow has already pooled
            # away, so those dimensions genuinely need a re-filter.
            scoped = state.replace(**{by: frozenset({code})})
            rows, volume = rows_for(scoped), baseline_rows_for(scoped)
        if not rows:
            continue

        # Every number below comes from app/tpo/aggregate.py unchanged.
        trade_spend = A.calculate_trade_spend(rows)
        groups.append({
            "code": code,
            "label": _group_label(store, by, code),
            "trade_spend": trade_spend,
            "incremental_units": A.calculate_incremental_quantity(volume),
            "incremental_sales": A.calculate_incremental_sales(volume),
            "roi": A.calculate_roi(rows, volume),
            "margin_impact": A.calculate_margin(rows),
            "pei": A.calculate_pei(rows, volume),
            "cannibalization": A.calculate_cannibalization(volume),
        })

    # The Promotion_Ids behind each mechanic, so a caller can re-scope to one
    # mechanic through the existing `promotion` filter. Present only for this
    # dimension; every other breakdown group is unchanged.
    if by == "promotion_mechanic":
        for group in groups:
            group["members"] = mechanic_members.get(group["code"], [])

    # Share is of Trade Spend, the one additive money measure.
    total_spend = sum(g["trade_spend"] or 0.0 for g in groups)
    for group in groups:
        group["share_pct"] = (
            round((group["trade_spend"] or 0.0) / total_spend * 100, 1) if total_spend else 0.0
        )
    return tuple(groups)
