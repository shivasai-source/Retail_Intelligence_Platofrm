"""Simulation Studio -- Phase A: the measured scenario baseline.

ORCHESTRATION ONLY. Not one KPI is computed in this module. Every number it
returns comes out of app/tpo/aggregate.py by way of app/tpo/service.py -- the
same call the Insights Hub's cards make -- so a scenario baseline and the
Insights Hub cannot disagree about the same scope.

That matters most for ROI. There is exactly one Promotion ROI in this product,
`aggregate.roi_multiple`:

    ROI = Incremental Sales / Trade Spend        (a multiple: 1.4)

The Simulation Studio used to divide revenue by spend in the browser and call
the result "ROI" -- a different numerator, sitting next to a Insights Hub
reporting against a 1.5 target. It no longer computes anything.

WHAT PHASE A DELIBERATELY DOES NOT DO
-------------------------------------
The levers are accepted, validated, anchored on real measurements and echoed
back, and they MOVE NOTHING. There is no promotion-response model in this
project, so the only truthful answer to "what if the discount were 18%?" is
this scope's measured performance plus an explicit statement that the response
model has not been built. `levers.applied` is False in every response for that
reason and the frontend surfaces it. Manufacturing an uplift from a
coefficient is the thing this phase exists to remove.

Nothing here returns confidence, risk, target probability, sell-through, a
weekly series, an ROI trajectory or a recommendation. Every one of those was
mock data; none can be derived from the current datasets without the response
model, and a plausible-looking placeholder is worse than an absent number.
"""

from __future__ import annotations

from collections import defaultdict
from dataclasses import dataclass
from statistics import median
from typing import Any, Sequence

from app.tpo import aggregate as A
from app.tpo import config
from app.tpo import formatting as F
from app.tpo import response
from app.tpo import scenarios
from app.tpo import service
from app.tpo.filters import FilterState, baseline_rows_for, rows_for
from app.tpo.loader import get_store

#: The phase this service implements, carried in every response so a client
#: can never mistake a measured baseline for a modelled scenario.
PHASE = "A"

#: Shown by the UI wherever a lever is offered. One sentence, stated once.
LEVERS_NOT_MODELLED = (
    "Lever values are recorded but do not change these results. Scenario "
    "response modelling arrives in the next phase; until then every figure "
    "shown is this scope's measured performance."
)


# --- the KPI set -----------------------------------------------------------


@dataclass(frozen=True)
class SimulationKpi:
    """One output figure and where it is read from.

    `card_key` names the Insights Hub KPI card this figure IS -- not one
    computed the same way, the same call. Reading the label, formula text and
    unavailability reason from that card too means the Simulation Studio
    cannot describe a KPI differently from the way the Insights Hub
    describes it.
    """

    key: str  # the name this API returns
    card_key: str | None  # service.KPI_SPECS key, or None if it is not a card
    unit: str = ""
    label: str = ""
    formula: str = ""


#: The seven Phase A figures. `incremental_units` is the only one that is not
#: a Insights Hub card; it is read straight off the same engine function
#: `aggregate.calculate_kpis` uses for it (see `_incremental_units`).
SIMULATION_KPIS: tuple[SimulationKpi, ...] = (
    SimulationKpi("trade_spend", "trade_spend"),
    SimulationKpi(
        "incremental_units",
        None,
        unit="quantity",
        label="Incremental Units",
        formula="Sum over promoted rows of (Actual Quantity - baseline)",
    ),
    SimulationKpi("incremental_sales", "incremental_sales"),
    SimulationKpi("roi_multiple", "promotion_roi"),
    SimulationKpi("margin_percent", "margin_impact"),
    SimulationKpi("cannibalization", "cannibalization_rate"),
    SimulationKpi("pei", "pei"),
)


def _display(value: float | None, unit: str, currency: str) -> str:
    """Formatting dispatch only -- app/tpo/formatting.py owns every rule."""
    if unit == "currency":
        return F.money(value, currency)
    if unit == "percent":
        return F.percent(value)
    if unit == "multiple":
        return F.multiple(value)
    if unit == "quantity":
        return F.quantity(value)
    return F.score(value)


def _incremental_units(state: FilterState) -> float | None:
    """Incremental Units for a selection, from the one engine function.

    Reproduces `aggregate.calculate_kpis`'s guard exactly and for its stated
    reason: an empty SELECTION means nothing was selected, full stop. The
    baseline-widened set can still hold rows under an Offer filter, and
    reporting an incremental off those would put a number against a population
    that is itself empty.
    """
    rows = rows_for(state)
    volume_rows = baseline_rows_for(state) if rows else ()
    return A.calculate_incremental_quantity(volume_rows)


def _kpis(state: FilterState, currency: str) -> dict[str, Any]:
    """The seven figures, read from the Insights Hub's own KPI payload.

    Deliberately `service.kpis` and not a fresh `aggregate.calculate_kpis`
    call: the scope rules that surround the engine -- the baseline-widened
    volume set, the Brand-Form widening cannibalization needs, the
    same-filters-previous-year comparison -- are decisions, and having them
    written down twice is how two screens start disagreeing. One call, one set
    of decisions.
    """
    payload = service.kpis(state, currency)
    cards = payload["kpis"]

    out: dict[str, Any] = {}
    for kpi in SIMULATION_KPIS:
        if kpi.card_key is not None:
            card = cards[kpi.card_key]
            out[kpi.key] = {
                "key": kpi.key,
                "label": card["label"],
                "unit": card["unit"],
                "value": card["value"],
                "display_value": card["display_value"],
                "available": card["available"],
                "unavailable_reason": card["unavailable_reason"],
                "formula": card["info"]["formula"],
            }
            # Cannibalization carries its EVIDENCE: how many comparable events
            # stood behind the rate, and -- when this scope could not support
            # one -- the wider scope `service.cannibalization_resolution`
            # settled on. Copied rather than recomputed, so the studio and the
            # Insights Hub cannot disagree about either.
            for extra in ("comparable_events", "measured_at"):
                if extra in card:
                    out[kpi.key][extra] = card[extra]
            continue

        value = _incremental_units(state)
        out[kpi.key] = {
            "key": kpi.key,
            "label": kpi.label,
            "unit": kpi.unit,
            "value": value,
            "display_value": _display(value, kpi.unit, currency),
            "available": value is not None,
            "unavailable_reason": None if value is not None else "No data in this selection.",
            "formula": kpi.formula,
        }

    return out


# --- scope measurements ----------------------------------------------------


@dataclass(frozen=True)
class ScopeMeasurement:
    """What the selected rows actually are, before any scenario is imagined."""

    row_count: int
    promoted_row_count: int
    promoted_weeks: int
    median_promotion_weeks: int
    average_discount_pct: float | None
    #: Promotion_Ids present on the promoted rows, in dataset order.
    promotion_ids: tuple[str, ...]
    #: Promotion_Id -> distinct business weeks it traded in, within this scope.
    weeks_by_promotion: dict[str, int]
    #: ("2025-W14", "2025-W17") over the promoted rows, or None.
    week_span: tuple[str, str] | None


def _measure(rows: Sequence[A.WeekRow]) -> ScopeMeasurement:
    """Descriptive statistics of the selection.

    NOT KPIs -- nothing here is a business metric and nothing here is used to
    compute one. They exist so a lever and a Current Plan field can be anchored
    on something real instead of on a number somebody typed into a JSON file.

    THREE DIFFERENT WEEK COUNTS live here, because they answer three different
    questions and confusing them puts a wrong number on a control:

      * `promoted_weeks` -- weeks of the scope containing ANY promotion. 52 for
        a channel over a full year. A statement about the SCOPE.
      * `weeks_by_promotion[pid]` -- the span of ONE promotion. This, and only
        this, is a promotion duration.
      * `median_promotion_weeks` -- the middle of those spans. Retained because
        Phase A's response contract carries it, and USED NOWHERE: it is a
        summary across promotions, and Part B1 §5 is explicit that it must not
        stand in for the duration of an identified promotion.
    """
    promoted = A.promotion_rows(rows)
    gross = sum(r.actual_revenue + r.discount_value for r in promoted)
    given_away = sum(r.discount_value for r in promoted)
    depth = A.safe_divide(given_away, gross)

    weeks_per_promotion: dict[str, set[str]] = defaultdict(set)
    for row in promoted:
        weeks_per_promotion[row.promotion_id].add(row.week_key)
    spans = sorted(len(weeks) for weeks in weeks_per_promotion.values())
    all_weeks = sorted({r.week_key for r in promoted})

    return ScopeMeasurement(
        row_count=len(rows),
        promoted_row_count=len(promoted),
        promoted_weeks=len(all_weeks),
        median_promotion_weeks=int(median(spans)) if spans else 0,
        average_discount_pct=None if depth is None else round(depth * 100, 1),
        promotion_ids=tuple(sorted(weeks_per_promotion)),
        weeks_by_promotion={pid: len(weeks) for pid, weeks in weeks_per_promotion.items()},
        week_span=(all_weeks[0], all_weeks[-1]) if all_weeks else None,
    )


# --- the simulation context ------------------------------------------------
#
# "What are we simulating?" answered from the ONE FilterState. No second
# filtering system, no second idea of scope: these are the same 14 dimensions
# app/tpo/filters.py defines, read back with their display names.

#: Dimension -> (singular label, what "unconstrained" honestly reads as).
#: `primary` dimensions are always shown, constrained or not, so the context
#: panel answers the question even when nothing is selected. The rest appear
#: only when they are actually constraining something.
_CONTEXT_DIMENSIONS: tuple[tuple[str, str, str, bool], ...] = (
    ("channel", "Channel", "All channels", True),
    ("region", "Region", "All regions", True),
    ("brand", "Brand", "All brands", True),
    ("product", "Product", "All products", True),
    ("promotion", "Promotion", "All promotions", True),
    ("retailer", "Retailer", "All retailers", False),
    ("state", "State", "All states", False),
    ("city", "City", "All cities", False),
    ("tier", "Tier", "All tiers", False),
    ("distributor", "Distributor", "All distributors", False),
    ("category", "Category", "All categories", False),
    ("promotion_type", "Promotion Type", "All promotion types", False),
)


def _context(state: FilterState, measurement: ScopeMeasurement) -> dict[str, Any]:
    """The resolved scope, with codes turned into the names people use.

    Labels come from `service._group_label`, the same function the Command
    Center's breakdown charts label their groups with, so "CH002" reads as
    "Modern Trade" in both places or in neither.
    """
    store = get_store()
    applied = state.applied()

    dimensions = []
    for key, label, all_label, primary in _CONTEXT_DIMENSIONS:
        codes = sorted(getattr(state, key) or ())
        values = [{"code": code, "name": service._group_label(store, key, code)} for code in codes]
        dimensions.append(
            {
                "key": key,
                "label": label,
                "constrained": bool(codes),
                "primary": primary,
                "values": values,
                # What the panel prints: the selected names, or the honest
                # "All channels" -- never an invented default.
                "summary": ", ".join(v["name"] for v in values) if values else all_label,
            }
        )

    return {
        "period": F.period_label(state.year, state.month),
        "period_label": F.fiscal_label(state.year),
        "year": state.year,
        "month": state.month,
        "dimensions": dimensions,
        "filters_applied": applied,
        "row_count": measurement.row_count,
        "promoted_row_count": measurement.promoted_row_count,
    }


# --- the Current Plan ------------------------------------------------------


def _observed(
    key: str,
    label: str,
    value: Any,
    display_value: str | None,
    derivation: str,
    unavailable_reason: str | None = None,
) -> dict[str, Any]:
    """One observed field. Either a value WITH the derivation that produced it,
    or no value with the reason it could not be derived. Never a value whose
    provenance is unstated."""
    available = unavailable_reason is None and value is not None
    return {
        "key": key,
        "label": label,
        "value": value if available else None,
        "display_value": display_value if available else None,
        "available": available,
        "unavailable_reason": unavailable_reason,
        "derivation": derivation if available else None,
    }


#: Deliberately does NOT claim the spans differ -- that is not checked, and an
#: unverified claim in an explanation is the same defect as an unverified
#: number in a KPI. It states only what is known: there is more than one.
_MULTIPLE_PROMOTIONS = (
    "{count} promotions traded in this scope, so there is no single promotion "
    "duration to read. Filter to one promotion to see its span."
)


def current_plan(
    state: FilterState,
    measurement: ScopeMeasurement,
    kpis: dict[str, Any],
    currency: str,
) -> dict[str, Any]:
    """What the data says is happening now, for this scope.

    THE MEASURED BASELINE, not a scenario. Every field is derived from
    fact_sales or from the validated KPI engine, and every field states how.
    Where a field cannot be derived honestly it is returned unavailable with
    the reason -- there is no fallback value anywhere in this function.
    """
    store = get_store()
    promotion_ids = measurement.promotion_ids
    single = promotion_ids[0] if len(promotion_ids) == 1 else None

    # --- observed promotion
    labels = [service._group_label(store, "promotion", pid) for pid in promotion_ids]
    if not promotion_ids:
        promotion = _observed(
            "promotion", "Promotion", None, None, "",
            unavailable_reason="Nothing in this scope was promoted.",
        )
    else:
        promotion = _observed(
            "promotion",
            "Promotion",
            list(promotion_ids),
            labels[0] if single else f"{len(labels)} promotions",
            "Distinct Promotion_Ids on the promoted rows in scope, named through "
            "dim_promotion (Promotion_Description).",
        )

    # --- observed period
    span = measurement.week_span
    period = _observed(
        "period",
        "Period",
        list(span) if span else None,
        f"{span[0]} to {span[1]}" if span else None,
        "First and last business week carrying a promoted row in this scope. The "
        "week is the one dim_date gives for the row's (Year, Week); fact_sales.Month "
        "is never read.",
        unavailable_reason=None if span else "Nothing in this scope was promoted.",
    )

    # --- observed discount depth
    #
    # DERIVED FROM PRICES, NOT FROM THE PROMOTION'S NAME. dim_promotion calls
    # PR002 "10% Discount", but that is a label on a mechanic, not a
    # measurement of what was given away: the realised depth depends on which
    # SKUs traded and at what prices, and the project's own economics scripts
    # re-expressed Buy3Get1 as a price discount. So the depth is read off the
    # revenue columns the loader already split.
    depth = measurement.average_discount_pct
    discount_derivation = (
        "Sum(Base Revenue - Actual Revenue) / Sum(Base Revenue) across the "
        f"{measurement.promoted_row_count:,} promoted rows in scope, read from "
        "fact_sales prices. Not taken from the promotion's name or type."
    )
    if not single and len(promotion_ids) > 1:
        discount_derivation += (
            f" Blended across the {len(promotion_ids)} promotions in scope, weighted by revenue."
        )
    discount = _observed(
        "discount_pct",
        "Discount Depth",
        depth,
        F.percent(depth),
        discount_derivation,
        unavailable_reason=None if depth is not None else "Nothing in this scope was promoted.",
    )

    # --- observed duration
    #
    # A duration belongs to A PROMOTION. With several in scope there is no
    # single answer, and the median of their spans is a summary statistic
    # rather than anybody's plan -- so the field is unavailable and says why.
    if single:
        weeks = measurement.weeks_by_promotion[single]
        duration = _observed(
            "duration_weeks",
            "Promotion Duration",
            float(weeks),
            f"{weeks} weeks",
            f"Distinct business weeks in which {labels[0]} carried a promoted row "
            "in this scope.",
        )
    else:
        duration = _observed(
            "duration_weeks", "Promotion Duration", None, None, "",
            unavailable_reason=(
                _MULTIPLE_PROMOTIONS.format(count=len(promotion_ids))
                if promotion_ids
                else "Nothing in this scope was promoted."
            ),
        )

    # --- observed trade spend, straight from the Phase A KPI foundation
    spend_kpi = kpis["trade_spend"]
    spend = _observed(
        "spend_amount",
        "Trade Spend",
        spend_kpi["value"],
        spend_kpi["display_value"],
        f"The validated Trade Spend KPI for this scope: {spend_kpi['formula']}.",
        unavailable_reason=None if spend_kpi["available"] else spend_kpi["unavailable_reason"],
    )

    return {
        "status": "measured",
        "single_promotion": single,
        "fields": [promotion, period, discount, duration, spend],
        "levers": {
            "discount_pct": discount["value"],
            "duration_weeks": duration["value"],
            "spend_amount": spend["value"],
        },
    }


# --- levers ----------------------------------------------------------------
#
# THE RANGE RULE, stated once. A slider needs endpoints, and inventing them is
# how "Trade Spend (Cr) 40-150" ends up sitting next to a measured Trade Spend
# of 712. So every Phase A lever is anchored on a MEASURED value for the
# selected scope and offered over half to one-and-a-half times it. That is a
# CONTROL range -- how far the handle travels -- and NOT a claim about what is
# safe, supported by the data, or achievable. Each lever carries a `basis`
# string naming the measurement it was anchored on, and the UI shows it.
# Phase B replaces this rule with bounds the response model can defend.

#: Lever key -> (label, unit, decimals, step). Retailer Incentive and Inventory
#: Allocation are absent on purpose: no field in any of the five datasets
#: splits retailer support out of Promotion_Cost, and the project holds no
#: inventory data at all. A lever with nothing behind it is not offered.
_LEVER_META: dict[str, tuple[str, str, int, float]] = {
    "discount_pct": ("Discount Depth", "percent", 1, 0.5),
    "duration_weeks": ("Promotion Duration", "weeks", 0, 1),
    "spend_amount": ("Trade Spend", "currency", 1, 1),
}

LEVER_KEYS: tuple[str, ...] = tuple(_LEVER_META)


def _lever(key: str, anchor: float | None, basis: str, currency: str) -> dict[str, Any]:
    """One lever definition. An unanchorable lever is returned unavailable
    with the reason, never with a plausible default."""
    label, unit, decimals, step = _LEVER_META[key]
    if anchor is None:
        return {
            "key": key,
            "label": label,
            "unit": unit,
            "available": False,
            "unavailable_reason": basis,
            "value": None,
            "display_value": None,
            "min": None,
            "max": None,
            "step": step,
            "decimals": decimals,
            "basis": None,
        }

    low = round(anchor * 0.5, decimals)
    high = round(anchor * 1.5, decimals)
    if unit == "weeks":
        low, high = max(1, int(low)), max(2, int(high))
    if unit == "currency":
        # A rupee-granular handle across a range of hundreds of millions is not
        # a control. One hundred positions across whatever range was offered.
        step = max(1.0, round((high - low) / 100))
    definition = {
        "key": key,
        "label": label,
        "unit": unit,
        "available": True,
        "unavailable_reason": None,
        "value": round(anchor, decimals),
        "display_value": _display(anchor, unit, currency),
        "min": low,
        "max": high,
        "step": step,
        "decimals": decimals,
        "basis": basis,
    }
    if key == "discount_pct":
        # THE APPROVED TREATMENT POINTS, from app/tpo/response.py.
        #
        # A scenario may only be run at one of these five depths -- B2.2's
        # /simulate rejects anything else -- so the control that picks a
        # scenario discount has to offer exactly them. Sending the list from
        # here means the frontend does not write down a copy of the approved
        # rules, which is the same reason B2.1 moved them out of a script.
        #
        # NOTE the relationship to `value` above: that is the scope's MEASURED
        # depth, which is a revenue-weighted blend and frequently not an
        # approved point at all (21.1% for CH002 F25). It stays as the Current
        # Plan's observed reading; it is not a selectable treatment.
        definition["approved_points"] = [
            {
                "discount_pct": rule.discount_pct,
                "treatment": rule.treatment,
                "uplift_low": rule.uplift_low,
                "uplift_high": rule.uplift_high,
            }
            for rule in response.all_treatments()
        ]
    return definition


_NO_PROMOTIONS = (
    "Nothing in this selection was promoted, so there is no measured value to "
    "anchor this lever on."
)


def _levers(
    plan: dict[str, Any],
    submitted: dict[str, float | None] | None,
    currency: str,
) -> dict[str, Any]:
    """The lever block: what was submitted, and what the controls should offer.

    EVERY ANCHOR IS THE CURRENT PLAN'S OBSERVED VALUE. A lever the Current Plan
    could not observe is not offered -- the duration lever disappears when
    several promotions are in scope, because there is no single duration to
    move away from. The reason travels with it, so the control explains its own
    absence instead of quietly defaulting to something plausible.

    `applied` is a field rather than a comment because a client must be able to
    tell a measured baseline from a modelled scenario without reading this
    docstring.
    """
    observed = {field["key"]: field for field in plan["fields"]}
    definitions = [
        _lever(
            key,
            observed[key]["value"],
            f"Current Plan {observed[key]['label']}: {observed[key]['display_value']}"
            if observed[key]["available"]
            else (observed[key]["unavailable_reason"] or _NO_PROMOTIONS),
            currency,
        )
        for key in _LEVER_META
    ]
    return {
        "submitted": submitted,
        "applied": False,
        "note": LEVERS_NOT_MODELLED,
        "definitions": definitions,
    }


# --- the endpoint payload --------------------------------------------------


def run(
    state: FilterState,
    levers: dict[str, float | None] | None = None,
    scenario_name: str | None = None,
    currency: str = "INR",
) -> dict[str, Any]:
    """The measured baseline for one scope, plus the levers that were offered.

    Called by POST /api/simulation/run. Returns None -- never a fabricated
    zero -- for any KPI the selection cannot support, exactly as the Command
    Center does, and says why in `unavailable_reason`.
    """
    currency = F.normalise_currency(currency)
    rows = rows_for(state)
    measurement = _measure(rows)
    kpis = _kpis(state, currency)
    plan = current_plan(state, measurement, kpis, currency)

    # The measured KPI bundle belongs to the Current Plan and to nothing else.
    # `scenarios.build` hands it to that scenario alone; the guard re-checks on
    # the way out, on the real payload rather than only in a test.
    # The measured scenario always carries the KPI bundle, even for a scope
    # that selected nothing -- in that case every value inside it is null with
    # a reason, which IS the measurement. Handing it None instead would make an
    # empty scope indistinguishable from an unrun scenario, and those are
    # different facts.
    scenario_set = scenarios.build(plan["levers"], kpis)
    scenarios.assert_no_fabricated_results(scenario_set)

    return {
        "scenario": {
            "name": scenario_name or "Measured Baseline",
            #: Not an id. Phase A persists nothing, and handing out something
            #: that looked like a stable key would invite a client to store it.
            "source": "measured",
            "phase": PHASE,
            "modelled": False,
        },
        "context": _context(state, measurement),
        "current_plan": plan,
        "scenarios": scenario_set,
        "scope": {
            "period": F.period_label(state.year, state.month),
            "period_label": F.fiscal_label(state.year),
            "filters_applied": state.applied(),
            "row_count": measurement.row_count,
            "promoted_row_count": measurement.promoted_row_count,
            "promoted_weeks": measurement.promoted_weeks,
            "median_promotion_weeks": measurement.median_promotion_weeks,
            "has_data": measurement.row_count > 0,
        },
        "levers": _levers(plan, levers, currency),
        "kpis": kpis,
        "meta": {
            "currency": currency,
            "base_currency": config.BASE_CURRENCY,
            "exchange_rate": F._rate(currency),
            "target_roi": config.PROMOTION_TARGET_ROI,
            "phase": PHASE,
        },
    }
