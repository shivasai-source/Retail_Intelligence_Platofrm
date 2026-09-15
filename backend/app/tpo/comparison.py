"""The scenario comparison contract -- B4.1.

WHAT THIS MODULE DOES. It takes results that have ALREADY been computed --
the measured baseline from /simulation/run and executed scenarios from
/simulation/simulate -- checks that they are actually comparable, and lines
their metrics up side by side with a delta per metric.

WHAT IT DOES NOT DO, and this is the point of the phase. It does not rank, does
not score, does not weight and does not recommend. `recommendation` is null in
every response and `recommendation_status` says why: this project defines no
business objective for Simulation Studio, so there is nothing to optimise
towards. Choosing one is a business-policy decision, not an implementation
detail, and inventing it here would bury it in code where nobody would ever
review it.

THREE THINGS THAT MAKE A COMPARISON INVALID, all checked rather than assumed:

  1. A DIFFERENT SCOPE. A result computed over CH002 + PBDI25 says nothing
     about CH003. Every entry's `filters_applied` must equal the comparison's,
     or it is excluded with the reason.
  2. A DIFFERENT ECONOMIC BASIS. Two scenarios are only comparable if the same
     approved rules, the same promotion cost rate and the same KPI engine
     produced them. B2.2 stamps all three onto every result, so this is a check
     rather than a hope.
  3. NOTHING TO COMPARE. A scenario nobody has run is EXCLUDED, not zero. A
     zero would read as "we evaluated this and it came to nothing", which is a
     different and false claim.

THE RANGE IS PRESERVED WHOLE. A simulated scenario carries an approved uplift
BAND, so every metric keeps its low and its high, and every delta is computed
at both ends. No midpoint is produced anywhere in this module -- see
`test_simulation_comparison.py`, which asserts it over the real payload.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any, Literal

from app.tpo import config
from app.tpo import formatting as F
from app.tpo import response, service, simulation

#: How a metric's delta may be expressed.
#:
#:   absolute         same unit as the metric. Always valid.
#:   percentage_point the metric IS a percentage, so a difference between two
#:                    of them is a difference in points, never a percentage.
#:   percent_change   only for EXTENSIVE quantities -- money and units, things
#:                    you can have twice as much of. Applying it to a ratio is
#:                    the classic misreading this enum exists to prevent: an
#:                    ROI moving 1.3 -> 1.6 is +0.3, and calling it
#:                    "+23%" invites somebody to think returns grew by that
#:                    much when what moved was the rate.
DeltaType = Literal["absolute", "percentage_point", "percent_change"]

#: A scenario's standing in a comparison.
ComparisonStatus = Literal["measured", "simulated", "excluded"]


@dataclass(frozen=True)
class MetricRule:
    """How one KPI is compared, and why that way.

    `lower_is_better` is carried through from `service.KPI_SPECS` and is
    DELIBERATELY NOT a comparison objective. It is the Insights Hub's display
    convention -- which way the delta arrow points and what colour it takes --
    and service.py's own docstring is explicit that "a rising Trade Spend is a
    rise, not an improvement". Whether a scenario with lower spend is BETTER is
    a business-policy question this phase does not answer.
    """

    key: str
    delta_type: DeltaType
    #: True when a percent change of this metric is also meaningful.
    supports_percent_change: bool
    rationale: str


#: One rule per Phase A KPI. The delta type follows from what the number IS,
#: not from what would look tidiest.
METRIC_RULES: dict[str, MetricRule] = {
    "trade_spend": MetricRule(
        "trade_spend", "absolute", True,
        "Money. A difference is money and a ratio of two is meaningful.",
    ),
    "incremental_units": MetricRule(
        "incremental_units", "absolute", True,
        "A count. A difference is a count and a ratio of two is meaningful.",
    ),
    "incremental_sales": MetricRule(
        "incremental_sales", "absolute", True,
        "Money. A difference is money and a ratio of two is meaningful.",
    ),
    "roi_multiple": MetricRule(
        "roi_multiple", "absolute", False,
        "A multiple of trade spend. Two ROIs differ by a multiple (+0.3); a "
        "percent change of a rate reads as though the return itself had changed "
        "by that much.",
    ),
    "margin_percent": MetricRule(
        "margin_percent", "percentage_point", False,
        "Already a percentage, and a ratio of summed revenue and cost. Points "
        "only, for the same reason as ROI.",
    ),
    "cannibalization": MetricRule(
        "cannibalization", "percentage_point", False,
        "A rate: cannibalized quantity over promotional incremental quantity. "
        "Points only.",
    ),
    "pei": MetricRule(
        "pei", "absolute", False,
        "A bounded 0-100 composite index. A difference is index points; a "
        "percent change of an index compounds three weighted components into a "
        "number that means nothing.",
    ),
}

#: Why a comparison cannot proceed, stated once each.
_NOT_SIMULATED = (
    "This scenario has not been simulated, so it has no result to compare. It "
    "is excluded rather than counted as zero -- a zero would read as an "
    "evaluation that came to nothing."
)
_NO_OBJECTIVE = (
    "No recommendation is produced. This project defines no business objective "
    "for Simulation Studio -- nothing states whether a higher ROI, a larger "
    "incremental or a smaller spend should win, or how they trade off. "
    "Choosing that is a business-policy decision."
)


def _spec_for(key: str) -> Any:
    """The Insights Hub KPI spec behind a simulation metric key, so labels
    and units cannot drift between the two."""
    card_key = next(k.card_key for k in simulation.SIMULATION_KPIS if k.key == key)
    if card_key is None:
        return None
    return next(spec for spec in service.KPI_SPECS if spec.key == card_key)


# --- comparability ----------------------------------------------------------


def _economic_basis(simulated: dict[str, Any]) -> tuple[str, str, float]:
    """The three stamps that have to match for two results to mean the same
    thing: which rules, which engine, which cost rate."""
    provenance = simulated.get("provenance") or {}
    return (
        provenance.get("response_rule", ""),
        provenance.get("kpi_engine", ""),
        provenance.get("promotion_cost_rate", float("nan")),
    )


#: What a comparable result must have been produced by. Read from the modules
#: that own them rather than written down again here.
EXPECTED_BASIS = (response.PROVENANCE, "app/tpo/aggregate.calculate_kpis", config.PROMOTION_COST_RATE)


def _check_entry(entry: dict[str, Any], scope: dict[str, Any]) -> str | None:
    """The reason this entry cannot join the comparison, or None."""
    measured, simulated = entry.get("measured"), entry.get("simulated")

    if measured is None and simulated is None:
        return _NOT_SIMULATED

    entry_scope = (
        entry.get("scope")
        if measured is not None
        else (simulated.get("scope") or {}).get("filters_applied")
    )
    if entry_scope is None:
        return "This result carries no scope, so it cannot be shown to describe the same rows."
    if entry_scope != scope:
        return (
            "This result was computed over a different scope "
            f"({_scope_text(entry_scope)}) than the comparison "
            f"({_scope_text(scope)}). Results from different rows are not comparable."
        )

    if simulated is not None and _economic_basis(simulated) != EXPECTED_BASIS:
        return (
            "This result was produced on a different economic basis -- a different "
            "approved rule set, promotion cost rate or KPI engine -- so its numbers "
            "are not on the same footing as the others."
        )
    return None


def _scope_text(scope: dict[str, Any]) -> str:
    if not scope:
        return "all data"
    return ", ".join(
        f"{k}={','.join(v) if isinstance(v, list) else v}" for k, v in sorted(scope.items())
    )


# --- metric assembly --------------------------------------------------------


def _kpi_of(entry: dict[str, Any], key: str, end: str) -> dict[str, Any] | None:
    """One metric off one entry. A measured baseline has a single value and no
    band, so both ends read the same cell -- that is a property of a
    measurement, not a collapsed range."""
    if entry.get("measured") is not None:
        return entry["measured"].get(key)
    result = (entry.get("simulated") or {}).get("result") or {}
    return (result.get(end) or {}).get("kpis", {}).get(key)


def _delta_display(rule: MetricRule, unit: str, absolute: float, currency: str) -> str:
    """The difference as the UI should print it, formatted through
    app/tpo/formatting.py so a delta cannot be rendered on a different
    convention from the value it came from."""
    if rule.delta_type == "percentage_point":
        return f"{absolute:+,.1f} pts"
    if unit == "multiple":
        return F.multiple(absolute, signed=True)
    if unit == "currency":
        return ("+" if absolute >= 0 else "-") + F.money(abs(absolute), currency)
    if unit == "quantity":
        return f"{absolute:+,.0f}"
    return f"{absolute:+,.0f} pts"


def _delta(
    rule: MetricRule, unit: str, value: float | None, baseline: float | None, currency: str
) -> dict[str, Any]:
    """The difference, in the only units that mean anything for this metric.

    Returns nulls -- never a zero -- when either side is unavailable. A zero
    delta claims the two are equal, which is a stronger statement than "one of
    them could not be measured".
    """
    if value is None or baseline is None:
        return {"absolute": None, "display": None, "percent_change": None}
    absolute = value - baseline
    percent_change = None
    if rule.supports_percent_change and baseline:
        percent_change = round((value / baseline - 1) * 100, 1)
    return {
        "absolute": absolute,
        "display": _delta_display(rule, unit, absolute, currency),
        "percent_change": percent_change,
    }


def _direction(absolute: float | None) -> str | None:
    """Higher, lower or unchanged. A statement about the number ONLY -- whether
    that is good is not decided here (see MetricRule.lower_is_better)."""
    if absolute is None:
        return None
    if absolute > 0:
        return "higher"
    if absolute < 0:
        return "lower"
    return "unchanged"


def _metric(
    key: str,
    rule: MetricRule,
    baseline_entry: dict[str, Any] | None,
    comparable: list[dict[str, Any]],
    currency: str,
) -> dict[str, Any]:
    spec = _spec_for(key)
    sample = _kpi_of(comparable[0], key, "low") if comparable else None
    label = (spec.label if spec else None) or (sample or {}).get("label") or key
    unit = (spec.unit if spec else None) or (sample or {}).get("unit") or ""

    def side(entry: dict[str, Any], end: str) -> dict[str, Any]:
        kpi = _kpi_of(entry, key, end) or {}
        return {
            "value": kpi.get("value"),
            "display_value": kpi.get("display_value"),
            "available": bool(kpi.get("available")),
            "unavailable_reason": kpi.get("unavailable_reason"),
        }

    baseline = None
    if baseline_entry is not None:
        baseline = side(baseline_entry, "low")

    scenarios = []
    for entry in comparable:
        if baseline_entry is not None and entry is baseline_entry:
            continue
        low, high = side(entry, "low"), side(entry, "high")
        base_value = baseline["value"] if baseline else None
        delta_low = _delta(rule, unit, low["value"], base_value, currency)
        delta_high = _delta(rule, unit, high["value"], base_value, currency)
        scenarios.append(
            {
                "scenario_id": entry["scenario_id"],
                # BOTH ENDS, always. Never averaged into one figure.
                "low": low,
                "high": high,
                "delta_low": delta_low,
                "delta_high": delta_high,
                "direction_low": _direction(delta_low["absolute"]),
                "direction_high": _direction(delta_high["absolute"]),
            }
        )

    return {
        "key": key,
        "label": label,
        "unit": unit,
        "delta_type": rule.delta_type,
        "delta_rationale": rule.rationale,
        "supports_percent_change": rule.supports_percent_change,
        # From service.KPI_SPECS. A DISPLAY convention, not an objective --
        # see MetricRule's docstring.
        "lower_is_better_display": bool(spec.lower_is_better) if spec else None,
        "preference": None,
        "preference_reason": (
            "Whether a higher or lower value is better for the purposes of choosing "
            "a scenario is a business-policy decision and is not defined yet."
        ),
        "baseline": baseline,
        "scenarios": scenarios,
    }


# --- the contract -----------------------------------------------------------


def compare(
    scope: dict[str, Any],
    entries: list[dict[str, Any]],
    currency: str = "INR",
) -> dict[str, Any]:
    """Line up already-computed results side by side.

    `scope` is the FilterState every entry must have been computed over.
    Nothing is recomputed here and no scenario is executed -- this reads
    results that /run and /simulate already produced.
    """
    currency = F.normalise_currency(currency)

    assessed = []
    for entry in entries:
        reason = _check_entry(entry, scope)
        measured = entry.get("measured") is not None
        assessed.append(
            {
                "entry": entry,
                "reason": reason,
                "status": "excluded" if reason else ("measured" if measured else "simulated"),
            }
        )

    comparable = [a["entry"] for a in assessed if a["reason"] is None]
    baseline_entry = next(
        (e for e in comparable if e.get("measured") is not None), None
    )

    scenarios = []
    for a in assessed:
        entry, simulated = a["entry"], a["entry"].get("simulated") or {}
        scenarios.append(
            {
                "scenario_id": entry.get("scenario_id"),
                "name": entry.get("name"),
                "status": a["status"],
                "is_baseline": entry is baseline_entry,
                "comparable": a["reason"] is None,
                "exclusion_reason": a["reason"],
                "treatment": simulated.get("treatment"),
                "discount_pct": simulated.get("discount_pct"),
                "uplift": simulated.get("uplift"),
                "provenance": simulated.get("provenance"),
            }
        )

    # A comparison needs a baseline and at least one simulated scenario to
    # measure against it; anything less is reported as such rather than
    # rendered as an empty table.
    simulated_count = sum(1 for s in scenarios if s["status"] == "simulated")
    if baseline_entry is None:
        comparison_status = "no_baseline"
    elif simulated_count == 0:
        comparison_status = "nothing_to_compare"
    else:
        comparison_status = "comparable"

    metrics = (
        [_metric(key, rule, baseline_entry, comparable, currency) for key, rule in METRIC_RULES.items()]
        if comparison_status == "comparable"
        else []
    )

    return {
        "scope": scope,
        "comparison_status": comparison_status,
        "scenarios": scenarios,
        "metrics": metrics,
        "economic_basis": {
            "response_rule": EXPECTED_BASIS[0],
            "kpi_engine": EXPECTED_BASIS[1],
            "promotion_cost_rate": EXPECTED_BASIS[2],
        },
        "range_label": "Approved uplift range",
        # B4.1 produces no recommendation, and says why rather than leaving a
        # null somebody might fill in with a default.
        "recommendation": None,
        "recommendation_status": "not_defined",
        "recommendation_reason": _NO_OBJECTIVE,
        "recommendation_requires": RECOMMENDATION_REQUIREMENTS,
        "meta": {"currency": currency, "phase": "B4.1"},
    }


#: WHAT A RECOMMENDATION ENGINE WOULD NEED, recorded here so B4.3 starts from a
#: list rather than from an assumption. Every item is either satisfied today or
#: named as missing; none of them is filled in with a default.
RECOMMENDATION_REQUIREMENTS: list[dict[str, Any]] = [
    {
        "requirement": "Candidate scenarios",
        "satisfied": True,
        "note": "Simulated scenarios over one scope, which this contract assembles.",
    },
    {
        "requirement": "A comparable scope",
        "satisfied": True,
        "note": "Enforced here: same FilterState, same economic basis.",
    },
    {
        "requirement": "Available KPI results",
        "satisfied": True,
        "note": "Seven metrics from the validated engine, with availability preserved.",
    },
    {
        "requirement": "A business objective",
        "satisfied": False,
        "note": (
            "MISSING. Nothing in this project states what a scenario should maximise "
            "or minimise. `service.KPI_SPECS.lower_is_better` exists but is a display "
            "convention for arrow colour, not an objective."
        ),
    },
    {
        "requirement": "Metric weights or a decision rule",
        "satisfied": False,
        "note": (
            "MISSING. PEI carries internal component weights (0.40/0.30/0.30) but "
            "those define one KPI, not a preference between scenarios."
        ),
    },
    {
        "requirement": "Constraints",
        "satisfied": False,
        "note": (
            "MISSING. No budget ceiling, margin floor, cannibalization limit or "
            "policy rule is defined anywhere in the project."
        ),
    },
    {
        "requirement": "A rule for comparing RANGES rather than points",
        "satisfied": False,
        "note": (
            "MISSING. Every simulated metric is a low-high band. Whether a scenario "
            "wins on its floor, its ceiling, or on some other reading of the band is "
            "undecided, and collapsing the band to a midpoint to avoid the question "
            "would invent precision the approved rules do not grant."
        ),
    },
]
