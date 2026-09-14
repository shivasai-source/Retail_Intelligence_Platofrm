"""The scenario recommendation engine -- B4.3.

Answers one question: given the scenarios that were actually simulated, which
one should TPO prefer UNDER THE CURRENT DECISION POLICY?

THE POLICY IS DATA, NOT CODE. `RECOMMENDATION_POLICY` below is the single
definition of what "preferred" means -- the objective, the economic
constraint, the primary metric, which end of the range to read, and the
tie-breakers in order. `recommend()` walks that structure; it hardcodes no
metric name and no direction. Changing the policy means editing one object,
and `test_simulation_recommendation.py` proves it by swapping the primary
metric at runtime and watching the outcome follow.

That matters because everything here is a BUSINESS DECISION, not a technical
one. B4.1 found this project had no stated objective at all; the one encoded
below is an initial policy, and the shape exists so replacing it is a review
of one object rather than an archaeology of the algorithm.

WHY THE LOW END. A simulated scenario carries an approved uplift BAND, not a
point. The policy reads the LOW end for every comparison, which is the
conservative reading: a scenario is preferred on what it delivers at the
weakest uplift its approved rule allows. The high end travels with it as
supporting evidence and never decides anything. No midpoint is computed
anywhere in this module -- averaging the ends would invent a precision the
approved rules do not grant, and would quietly make a wide, risky band look
like a narrow, safe one.

WHAT THIS IS NOT. No ML, no LLM, no embeddings, no probability, no confidence,
no forecasting, no optimiser, no learned weights and no hidden score. It is
deterministic business-rule logic over numbers the validated KPI engine
already produced, and it recomputes no KPI.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any, Literal

from app.tpo import comparison

#: How a criterion reads a scenario's band.
Endpoint = Literal["low", "high"]

#: Which way a criterion prefers. Stated per criterion so the algorithm never
#: assumes that more of something is better.
Direction = Literal["higher_is_preferred", "lower_is_preferred"]

#: What the engine concluded.
RecommendationStatus = Literal[
    "recommended", "maintain_current_plan", "no_clear_winner", "insufficient_data"
]


@dataclass(frozen=True)
class DecisionCriterion:
    """One rung of the decision hierarchy."""

    metric: str
    endpoint: Endpoint
    direction: Direction
    role: Literal["primary", "tie_breaker"]
    note: str


@dataclass(frozen=True)
class EconomicConstraint:
    """A hard gate. A scenario failing it cannot be recommended at all -- it is
    not traded off against anything."""

    metric: str
    #: EVERY listed endpoint must satisfy the rule, not just one.
    endpoints: tuple[Endpoint, ...]
    #: `above_breakeven`: the ROI multiple must exceed 1.0 -- the spend came
    #: back with something on top. (Was `strictly_positive` when ROI was a net
    #: percentage; the same gate, restated on the multiple scale.)
    must_be: Literal["above_breakeven"]
    note: str


@dataclass(frozen=True)
class RecommendationPolicy:
    """THE decision policy. One object, one place to change it."""

    version: str
    objective: str
    economic_constraint: EconomicConstraint
    #: Primary first, then tie-breakers in the order they are applied.
    hierarchy: tuple[DecisionCriterion, ...]
    #: A scenario missing any of these cannot take part in the decision. They
    #: are never defaulted to zero and never inferred.
    required_metrics: tuple[str, ...]
    range_policy: str
    #: Per-metric tie tolerance. DERIVED FROM THE ENGINE'S OWN PRECISION, not
    #: chosen: aggregate.py rounds the ROI multiple to 2dp, Margin to 1dp, Incremental Sales to
    #: 2dp, Incremental Units and PEI to 0dp, and does not round Trade Spend at
    #: all. Half a rounding step is the smallest difference the engine can
    #: actually express, so anything closer than that is a tie rather than a
    #: lead. Trade Spend, being unrounded currency in base units, uses half a
    #: paisa -- below any monetary difference that could matter.
    tolerance: dict[str, float] = field(default_factory=dict)

    def tolerance_for(self, metric: str) -> float:
        return self.tolerance.get(metric, 0.0)

    def as_dict(self) -> dict[str, Any]:
        """The policy as the API exposes it, so a recommendation is never a
        black box: the rule that produced it travels with it."""
        return {
            "version": self.version,
            "objective": self.objective,
            "economic_constraint": {
                "metric": self.economic_constraint.metric,
                "endpoints": list(self.economic_constraint.endpoints),
                "must_be": self.economic_constraint.must_be,
                "note": self.economic_constraint.note,
            },
            "primary_metric": self.primary.metric,
            "primary_endpoint": self.primary.endpoint,
            "hierarchy": [
                {
                    "metric": c.metric,
                    "endpoint": c.endpoint,
                    "direction": c.direction,
                    "role": c.role,
                    "note": c.note,
                }
                for c in self.hierarchy
            ],
            "required_metrics": list(self.required_metrics),
            "range_policy": self.range_policy,
            "tolerance": dict(self.tolerance),
        }

    @property
    def primary(self) -> DecisionCriterion:
        return self.hierarchy[0]


#: The ROI multiple at which a promotion has exactly returned its trade spend.
#: The economic gate is strict: a scenario must clear it, not merely reach it.
BREAKEVEN_ROI: float = 1.0

#: THE INITIAL DECISION POLICY.
#:
#: Change this object to change what "recommended" means. Nothing else in the
#: codebase encodes a preference between scenarios -- not the router, not the
#: comparison contract, not the React components.
RECOMMENDATION_POLICY = RecommendationPolicy(
    version="B4.3-initial",
    objective=(
        "Prefer a scenario that provides stronger incremental commercial impact "
        "while maintaining economically viable promotion performance."
    ),
    economic_constraint=EconomicConstraint(
        metric="roi_multiple",
        endpoints=("low", "high"),
        must_be="above_breakeven",
        note=(
            "ROI must stay above 1.00 across the ENTIRE approved uplift range. "
            "Deliberately conservative: the result is a band, not a point, so a "
            "scenario that only pays back at the top of its band is not treated as "
            "viable."
        ),
    ),
    hierarchy=(
        DecisionCriterion(
            metric="incremental_sales",
            endpoint="low",
            direction="higher_is_preferred",
            role="primary",
            note=(
                "The conservative commercial outcome: what the scenario returns at "
                "the weakest uplift its approved rule allows."
            ),
        ),
        DecisionCriterion(
            "roi_multiple", "low", "higher_is_preferred", "tie_breaker",
            "Stronger conservative return on the same conservative incremental.",
        ),
        DecisionCriterion(
            "incremental_units", "low", "higher_is_preferred", "tie_breaker",
            "More conservative volume behind the same value.",
        ),
        DecisionCriterion(
            "margin_percent", "low", "higher_is_preferred", "tie_breaker",
            "More margin retained.",
        ),
        DecisionCriterion(
            "pei", "low", "higher_is_preferred", "tie_breaker",
            "Higher promotion efficiency index.",
        ),
        DecisionCriterion(
            "trade_spend", "low", "lower_is_preferred", "tie_breaker",
            "FINAL TIE-BREAKER ONLY. Trade Spend is NOT an optimisation target: "
            "this policy does not hold that lower spend is better, only that "
            "between two scenarios equivalent on everything above, the cheaper one "
            "is preferred. It appears as supporting evidence regardless.",
        ),
    ),
    required_metrics=("incremental_sales", "roi_multiple"),
    range_policy=(
        "Comparisons read the LOW end of the approved uplift range. The high end is "
        "supporting context and decides nothing. No midpoint is computed, the band is "
        "never collapsed, and it is not a confidence or prediction interval."
    ),
    tolerance={
        "incremental_sales": 0.05,    # engine rounds to 1dp
        "roi_multiple": 0.005,        # 2dp -- the ROI multiple's own precision
        "margin_percent": 0.05,       # 1dp
        "incremental_units": 0.5,     # 0dp
        "pei": 0.5,                   # 0dp
        "trade_spend": 0.05,          # engine rounds to 1dp
    },
)

#: Metrics carried as evidence whether or not they decide anything.
EVIDENCE_METRICS = (
    "incremental_sales", "roi_multiple", "trade_spend",
    "incremental_units", "margin_percent", "pei", "cannibalization",
)


# --- reading the comparison -------------------------------------------------


def _metric_values(compared: dict[str, Any]) -> dict[str, dict[str, dict[str, Any]]]:
    """scenario_id -> metric -> {"low", "high", "available", "reason"}.

    Read straight off the B4.1 comparison payload. Nothing is recomputed here;
    if a value is absent it stays absent.
    """
    out: dict[str, dict[str, dict[str, Any]]] = {}
    for metric in compared["metrics"]:
        key = metric["key"]
        if metric.get("baseline") is not None:
            baseline_id = next(
                (s["scenario_id"] for s in compared["scenarios"] if s.get("is_baseline")), None
            )
            if baseline_id is not None:
                entry = out.setdefault(baseline_id, {})
                entry[key] = {
                    "low": metric["baseline"]["value"],
                    "high": metric["baseline"]["value"],
                    "available": metric["baseline"]["available"],
                    "reason": metric["baseline"]["unavailable_reason"],
                    "display_low": metric["baseline"]["display_value"],
                    "display_high": metric["baseline"]["display_value"],
                }
        for scenario in metric["scenarios"]:
            entry = out.setdefault(scenario["scenario_id"], {})
            entry[key] = {
                "low": scenario["low"]["value"],
                "high": scenario["high"]["value"],
                "available": scenario["low"]["available"] and scenario["high"]["available"],
                "reason": scenario["low"]["unavailable_reason"] or scenario["high"]["unavailable_reason"],
                "display_low": scenario["low"]["display_value"],
                "display_high": scenario["high"]["display_value"],
            }
    return out


def _measured_values(measured: dict[str, Any] | None) -> dict[str, dict[str, Any]]:
    """The baseline's metrics read straight off its own KPI block.

    NOT via the comparison. When no scenario has been simulated the comparison
    reports "nothing to compare" and emits no metrics at all -- correctly, since
    there is nothing to line the baseline up against. But the recommendation
    still returns `maintain_current_plan` in that case, and a fallback with no
    supporting numbers is a worse answer than one with them. So the Current
    Plan's evidence comes from the source the comparison itself would have
    read.

    A measured value has no band: `low` and `high` are the same figure, which
    is a property of a measurement rather than a collapsed range.
    """
    if not measured:
        return {}
    return {
        key: {
            "low": kpi.get("value"),
            "high": kpi.get("value"),
            "available": bool(kpi.get("available")),
            "reason": kpi.get("unavailable_reason"),
            "display_low": kpi.get("display_value"),
            "display_high": kpi.get("display_value"),
        }
        for key, kpi in measured.items()
    }


def _evidence(values: dict[str, dict[str, Any]]) -> dict[str, Any]:
    """Every metric a reader would want beside the decision, available or not."""
    return {
        metric: {
            "low": values.get(metric, {}).get("low"),
            "high": values.get(metric, {}).get("high"),
            "display_low": values.get(metric, {}).get("display_low"),
            "display_high": values.get(metric, {}).get("display_high"),
            "available": values.get(metric, {}).get("available", False),
            "unavailable_reason": values.get(metric, {}).get("reason"),
        }
        for metric in EVIDENCE_METRICS
    }


# --- eligibility ------------------------------------------------------------


def _constraint_failure(
    values: dict[str, dict[str, Any]], policy: RecommendationPolicy
) -> str | None:
    """The economic gate, applied to a HYPOTHETICAL scenario only."""
    constraint = policy.economic_constraint
    metric = values.get(constraint.metric, {})
    for endpoint in constraint.endpoints:
        value = metric.get(endpoint)
        if value is None:
            return (
                f"{constraint.metric} is unavailable at the {endpoint} end, so economic "
                "viability cannot be established."
            )
        if value <= BREAKEVEN_ROI:
            return (
                f"{constraint.metric} at the {endpoint} end is {value}, which does not "
                "clear break-even. The policy requires an ROI above 1.00 across the "
                "entire approved uplift range."
            )
    return None


def _missing_required(
    values: dict[str, dict[str, Any]], policy: RecommendationPolicy
) -> list[str]:
    return [
        metric
        for metric in policy.required_metrics
        if not values.get(metric, {}).get("available")
        or values.get(metric, {}).get("low") is None
    ]


# --- the decision -----------------------------------------------------------


def _apply_hierarchy(
    candidates: list[dict[str, Any]], policy: RecommendationPolicy
) -> tuple[dict[str, Any] | None, list[dict[str, Any]]]:
    """Walk the hierarchy until one candidate is left, or the rungs run out.

    A criterion is SKIPPED when any surviving candidate lacks a value for it:
    comparing a scenario that has the metric against one that does not would
    eliminate the second on missing data rather than on merit.
    """
    remaining = candidates
    path: list[dict[str, Any]] = []

    for criterion in policy.hierarchy:
        if len(remaining) <= 1:
            break

        readings = {
            c["scenario_id"]: c["values"].get(criterion.metric, {}).get(criterion.endpoint)
            for c in remaining
        }
        if any(v is None for v in readings.values()):
            path.append(
                {
                    "criterion": criterion.metric,
                    "endpoint": criterion.endpoint,
                    "role": criterion.role,
                    "outcome": "skipped",
                    "detail": (
                        "At least one remaining scenario has no value for this metric, so "
                        "it cannot separate them without eliminating on missing data."
                    ),
                    "readings": readings,
                }
            )
            continue

        prefer_higher = criterion.direction == "higher_is_preferred"
        leading = max(readings.values()) if prefer_higher else min(readings.values())
        tolerance = policy.tolerance_for(criterion.metric)
        leaders = [sid for sid, value in readings.items() if abs(value - leading) <= tolerance]

        path.append(
            {
                "criterion": criterion.metric,
                "endpoint": criterion.endpoint,
                "direction": criterion.direction,
                "role": criterion.role,
                "outcome": "separated" if len(leaders) == 1 else "tied",
                "readings": readings,
                "leading_value": leading,
                "tolerance": tolerance,
                "leaders": leaders,
            }
        )
        remaining = [c for c in remaining if c["scenario_id"] in leaders]

    return (remaining[0] if len(remaining) == 1 else None), path


# --- the explanation --------------------------------------------------------


def _explain(
    winner: dict[str, Any], policy: RecommendationPolicy, path: list[dict[str, Any]]
) -> str:
    """Why this scenario, in the values that actually decided it.

    Every number quoted is read back off the winner. Deliberately free of
    "optimal", "best possible", "guaranteed" and "will increase": the policy
    selected a preference among the scenarios that were run, which is a
    narrower claim than any of those.
    """
    primary = policy.primary
    values = winner["values"]
    sales = values.get(primary.metric, {})
    roi = values.get(policy.economic_constraint.metric, {})

    parts = [
        f"{winner['name']} is recommended under the current decision policy: among the "
        f"economically viable scenarios it has the highest conservative "
        f"{primary.metric.replace('_', ' ')} at the low end of its approved uplift range "
        f"({sales.get('display_low')})."
    ]
    parts.append(
        f"Its ROI stays above break-even across the whole approved range "
        f"({roi.get('display_low')} at the low end, {roi.get('display_high')} at the high end)."
    )

    used = [step for step in path if step.get("outcome") == "separated" and step["role"] == "tie_breaker"]
    if used:
        step = used[-1]
        parts.append(
            f"It was separated from the remaining candidates on "
            f"{step['criterion'].replace('_', ' ')} at the {step['endpoint']} end."
        )

    spend = values.get("trade_spend", {})
    if spend.get("available"):
        parts.append(
            f"Supporting evidence: trade spend {spend.get('display_low')} to "
            f"{spend.get('display_high')} across the range."
        )
    return " ".join(parts)


# --- the contract -----------------------------------------------------------


def recommend(
    scope: dict[str, Any],
    entries: list[dict[str, Any]],
    currency: str = "INR",
    policy: RecommendationPolicy = RECOMMENDATION_POLICY,
) -> dict[str, Any]:
    """Apply the decision policy to already-computed scenario results.

    The comparison is built by app/tpo/comparison.py so the recommendation
    cannot disagree with the table beside it. No KPI is recomputed and no
    scenario is executed.
    """
    compared = comparison.compare(scope, entries, currency=currency)
    values_by_id = _metric_values(compared)

    baseline = next((s for s in compared["scenarios"] if s.get("is_baseline")), None)
    result: dict[str, Any] = {
        "status": "insufficient_data",
        "recommended_scenario_id": None,
        "policy": policy.as_dict(),
        "eligible_scenarios": [],
        "excluded_scenarios": [],
        "decision_path": [],
        "evidence": {},
        "reason": "",
        "comparison_status": compared["comparison_status"],
        "provenance": {
            "decided_by": "app/tpo/recommendation.RECOMMENDATION_POLICY",
            "policy_version": policy.version,
            "comparison": compared["economic_basis"],
            "method": (
                "Deterministic business rules over results the validated KPI engine "
                "produced. No model, no score, no weights."
            ),
        },
        "meta": {"currency": currency, "phase": "B4.3"},
    }

    if baseline is None:
        result["reason"] = (
            "No measured Current Plan is available for this scope, so there is no "
            "baseline to recommend or to compare against."
        )
        result["missing"] = ["measured baseline (Current Plan)"]
        return result

    # --- candidates
    candidates: list[dict[str, Any]] = []
    for scenario in compared["scenarios"]:
        sid = scenario["scenario_id"]
        values = values_by_id.get(sid, {})
        entry = {
            "scenario_id": sid,
            "name": scenario["name"],
            "treatment": scenario.get("treatment"),
            "discount_pct": scenario.get("discount_pct"),
            "uplift": scenario.get("uplift"),
            "values": values,
        }

        if scenario.get("is_baseline"):
            # THE CURRENT PLAN IS MEASURED, NOT A COUNTERFACTUAL. The economic
            # viability rule is written for a simulated band and is not applied
            # to it; it is retained as the fallback whatever its own ROI.
            source = next(
                (e for e in entries if e.get("scenario_id") == sid and e.get("measured")), None
            )
            result["evidence"]["current_plan"] = _evidence(
                values or _measured_values((source or {}).get("measured"))
            )
            continue

        if not scenario["comparable"]:
            result["excluded_scenarios"].append(
                {"scenario_id": sid, "name": scenario["name"], "reason": scenario["exclusion_reason"]}
            )
            continue

        missing = _missing_required(values, policy)
        if missing:
            result["excluded_scenarios"].append(
                {
                    "scenario_id": sid,
                    "name": scenario["name"],
                    "reason": (
                        "Required metrics are unavailable for this scenario: "
                        f"{', '.join(missing)}. They are not substituted with zero."
                    ),
                }
            )
            continue

        failure = _constraint_failure(values, policy)
        if failure:
            result["excluded_scenarios"].append(
                {"scenario_id": sid, "name": scenario["name"], "reason": failure}
            )
            continue

        candidates.append(entry)

    result["eligible_scenarios"] = [
        {
            "scenario_id": c["scenario_id"],
            "name": c["name"],
            "treatment": c["treatment"],
            "discount_pct": c["discount_pct"],
            "uplift": c["uplift"],
            "evidence": _evidence(c["values"]),
        }
        for c in candidates
    ]

    if not candidates:
        result["status"] = "maintain_current_plan"
        result["recommended_scenario_id"] = baseline["scenario_id"]
        result["reason"] = (
            "No simulated scenario satisfied the current economic viability rule, so "
            "the measured Current Plan is retained. "
            + policy.economic_constraint.note
        )
        return result

    winner, path = _apply_hierarchy(candidates, policy)
    result["decision_path"] = path

    if winner is None:
        result["status"] = "no_clear_winner"
        result["reason"] = (
            "The decision policy could not separate the leading scenarios: they are "
            "equivalent on every criterion in the hierarchy, within the tolerance the "
            "KPI engine's own precision allows. No scenario is selected arbitrarily."
        )
        return result

    result["status"] = "recommended"
    result["recommended_scenario_id"] = winner["scenario_id"]
    result["evidence"]["recommended"] = _evidence(winner["values"])
    result["reason"] = _explain(winner, policy, path)
    return result
