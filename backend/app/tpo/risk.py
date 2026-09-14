"""Risk and governance assessment -- B6.

Answers a different question from B4.3. The recommendation engine says which
scenario is preferred under the decision policy; this says what a decision
maker should know before acting on it. A scenario can be recommended AND carry
attention-level risk, and nothing here changes which scenario B4.3 chose --
`recommendation_context` carries B4's answer through untouched.

WHAT THIS MODULE REFUSES TO DO, and why each refusal matters
------------------------------------------------------------
NO INVENTED THRESHOLDS. This project has never approved a budget ceiling, a
margin floor, a cannibalization limit, a PEI floor, a maximum discount or a
maximum duration. Writing "Trade Spend > 10 Cr = High Risk" here would create a
business rule by implementation, in a file nobody would think to review. So a
metric with no approved boundary is reported as a MEASUREMENT plus a stated
GOVERNANCE GAP -- "Trade Spend is X to Y; no approved budget ceiling is
defined" -- which is the true state of affairs and is actionable in a way a
fabricated verdict is not.

NO SCORE. No risk score, no weighting, no probability, no confidence. Severity
comes from explicit rules or is `unknown`, and the overall status is a stated
three-line rule rather than an average of anything.

NO RECOMPUTATION. Every number is read off results B2.2, B4.1, B4.3 and B5
already produced. This module runs no simulation and evaluates no KPI.

THE ONE BOUNDARY IT DOES USE IS CITED. `scripts/audit_roi_realism.py` marks a
treatment with less than 2 percentage points of break-even headroom as
"NO MARGIN". That is the project's own documented economic boundary, so it is
reused here with its provenance attached rather than replaced by a new number.
It lives in the policy below, so changing it is one edit.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any, Literal

from app.tpo import config, response, weekly

#: Where a finding sits. A category with no supporting evidence produces no
#: finding -- the panel is never padded to look thorough.
RiskCategory = Literal[
    "ECONOMIC", "ASSUMPTION", "DATA_AVAILABILITY", "SCOPE",
    "CANNIBALIZATION", "EXECUTION", "GOVERNANCE",
]

#: What the evidence says about this finding.
FindingStatus = Literal["clear", "attention", "unknown"]

#: How much it matters. `unknown` is a real answer, used whenever no approved
#: rule defines what "enough" would be.
Severity = Literal["low", "medium", "high", "unknown"]


@dataclass(frozen=True)
class GovernanceGap:
    """A boundary the project has NOT approved.

    Recorded as a gap rather than filled in with a plausible number. Each one
    is a decision somebody still has to make.
    """

    key: str
    label: str
    statement: str


#: Every threshold a risk engine would normally check, and which this project
#: has never defined. Reported, never invented.
UNDEFINED_THRESHOLDS: tuple[GovernanceGap, ...] = (
    GovernanceGap("budget_ceiling", "Promotion budget ceiling",
                  "No approved maximum Trade Spend is defined, so the scenario's spend "
                  "cannot be judged against a budget."),
    GovernanceGap("margin_floor", "Margin floor",
                  "No approved minimum Margin is defined."),
    GovernanceGap("cannibalization_limit", "Cannibalization limit",
                  "No approved maximum cannibalization is defined."),
    GovernanceGap("pei_floor", "Promotion Efficiency Index floor",
                  "No approved minimum PEI is defined."),
    GovernanceGap("max_discount", "Maximum discount depth",
                  "No approved maximum discount is defined beyond the five approved "
                  "treatments themselves."),
    GovernanceGap("max_duration", "Maximum promotion duration",
                  "No approved maximum duration is defined, and duration is not modelled "
                  "by the simulation."),
    GovernanceGap("weekly_concentration", "Weekly concentration limit",
                  "No approved limit on how much of a promotion's impact may fall in one "
                  "week is defined."),
)

@dataclass(frozen=True)
class RiskPolicy:
    """THE risk policy. One object, one place to change it.

    Nothing else in the codebase decides what counts as attention-worthy.
    """

    version: str
    principle: str
    #: Percentage points of break-even headroom below which the project's own
    #: ROI realism audit prints "NO MARGIN". Cited, not invented -- see
    #: `narrow_headroom_source`.
    narrow_headroom_pp: float
    narrow_headroom_source: str
    #: Findings whose `unknown` status makes the whole assessment unknown.
    governance_critical: tuple[str, ...]
    overall_status_rule: str
    undefined_thresholds: tuple[GovernanceGap, ...]


RISK_POLICY = RiskPolicy(
    version="B6-initial",
    principle=(
        "Report what the evidence supports and name what has not been decided. A "
        "metric with no approved boundary is reported as a measurement plus a "
        "governance gap, never as a verdict."
    ),
    narrow_headroom_pp=2.0,
    narrow_headroom_source=(
        "scripts/audit_roi_realism.py marks a treatment with less than 2 percentage "
        "points of break-even headroom as 'NO MARGIN'. That is the project's own "
        "documented boundary, reused here rather than replaced with a new one."
    ),
    governance_critical=("provenance", "approved_treatment", "required_kpis"),
    overall_status_rule=(
        "attention if any finding is attention with high severity; otherwise unknown "
        "if any governance-critical finding is unknown; otherwise clear. No score is "
        "computed and no severity is averaged."
    ),
    undefined_thresholds=UNDEFINED_THRESHOLDS,
)


def _finding(
    finding_id: str,
    category: RiskCategory,
    status: FindingStatus,
    severity: Severity,
    title: str,
    reason: str,
    evidence: dict[str, Any],
    source: str,
    impact: str,
    action: str | None,
) -> dict[str, Any]:
    """One finding.

    `recommended_action` is a GOVERNANCE step -- something to verify before
    executing -- and never a different scenario. B6 does not recommend.
    """
    return {
        "id": finding_id,
        "category": category,
        "status": status,
        "severity": severity,
        "title": title,
        "reason": reason,
        "evidence": evidence,
        "source": source,
        "impact": impact,
        "recommended_action": action,
    }


def _cell(scenario: dict[str, Any], end: str, metric: str) -> dict[str, Any]:
    return (scenario.get("result", {}).get(end, {}).get("kpis", {}) or {}).get(metric, {})


# --- the rules --------------------------------------------------------------


def _economic_findings(scenario: dict[str, Any], policy: RiskPolicy) -> list[dict[str, Any]]:
    """Rules 1 and 2: does the approved band clear break-even, and by how much?"""
    uplift = scenario.get("uplift") or {}
    breakeven = scenario.get("breakeven_uplift")
    headroom = (scenario.get("headroom") or {}).get("low")
    roi_low, roi_high = _cell(scenario, "low", "roi_multiple"), _cell(scenario, "high", "roi_multiple")

    if breakeven is None or uplift.get("low") is None:
        return [
            _finding(
                "breakeven", "ECONOMIC", "unknown", "unknown",
                "Break-even position could not be established",
                "The scenario result does not carry a break-even uplift, so the approved "
                "band cannot be checked against it.",
                {"uplift_low": uplift.get("low"), "breakeven_uplift": breakeven},
                "app/tpo/response.py", "Economic viability is unverified.",
                "Re-run the scenario and confirm the response rule is attached.",
            )
        ]

    evidence = {
        "uplift_low": uplift["low"],
        "uplift_high": uplift.get("high"),
        "breakeven_uplift": breakeven,
        "headroom_low": headroom,
        "headroom_low_pp": None if headroom is None else round(headroom * 100, 1),
        "roi_low": roi_low.get("value"),
        "roi_low_display": roi_low.get("display_value"),
        "roi_high": roi_high.get("value"),
        "roi_high_display": roi_high.get("display_value"),
    }

    if uplift["low"] <= breakeven:
        return [
            _finding(
                "breakeven", "ECONOMIC", "attention", "high",
                "Low end of the approved range does not clear break-even",
                "The low end of the approved uplift range does not clear the promotion "
                "break-even threshold, so the scenario is not economically viable across "
                "its whole approved range.",
                evidence, "app/tpo/response.py break-even algebra",
                "At the weak end of its approved band this treatment would not return its "
                "investment.",
                "Do not execute on this treatment without a revised economic case.",
            )
        ]

    headroom_pp = round(headroom * 100, 1)
    narrow = headroom_pp < policy.narrow_headroom_pp
    return [
        _finding(
            "breakeven", "ECONOMIC",
            "attention" if narrow else "clear",
            "medium" if narrow else "low",
            "Near break-even at the low end" if narrow else "Clears break-even across the approved range",
            (
                f"Low-end uplift clears break-even by {headroom_pp} percentage points. "
                + (
                    policy.narrow_headroom_source
                    if narrow
                    else "That is above the project's documented narrow-headroom boundary."
                )
            ),
            evidence,
            "app/tpo/response.py; " + policy.narrow_headroom_source,
            (
                "Small shortfalls against the approved uplift would erase the return."
                if narrow
                else "The approved band returns its investment at both ends."
            ),
            (
                "Confirm the uplift assumption with the commercial team before executing."
                if narrow
                else None
            ),
        )
    ]


def _metric_finding(
    scenario: dict[str, Any],
    metric: str,
    finding_id: str,
    category: RiskCategory,
    label: str,
    gap: GovernanceGap,
) -> dict[str, Any]:
    """Rules 3, 4 and 5: report the measurement, name the missing boundary.

    Deliberately identical in shape for Trade Spend, Margin and
    Cannibalization -- none of them has an approved limit, so none of them gets
    a verdict.
    """
    low, high = _cell(scenario, "low", metric), _cell(scenario, "high", metric)
    if not low.get("available"):
        return _finding(
            finding_id, category, "unknown", "unknown",
            f"{label} is unavailable for this scope",
            low.get("unavailable_reason") or "The KPI engine could not produce this metric.",
            {"available": False, "unavailable_reason": low.get("unavailable_reason")},
            "app/tpo/aggregate.calculate_kpis",
            f"{label} cannot be taken into account for this scenario.",
            f"Narrow or widen the scope so the engine can measure {label.lower()}, or "
            "record that it was not assessed.",
        )

    return _finding(
        finding_id, category, "clear", "unknown",
        f"{label} measured; no approved limit",
        f"{label} is {low.get('display_value')} to {high.get('display_value')} across the "
        f"approved uplift range. {gap.statement}",
        {
            "low": low.get("value"), "high": high.get("value"),
            "display_low": low.get("display_value"), "display_high": high.get("display_value"),
            "approved_limit": None, "governance_gap": gap.key,
        },
        "app/tpo/aggregate.calculate_kpis",
        f"{label} cannot be judged against a policy that does not exist.",
        f"Confirm {gap.label.lower()} with the commercial team before executing.",
    )


def _availability_finding(scenario: dict[str, Any]) -> dict[str, Any] | None:
    """Rule 6: any KPI the engine could not produce, named."""
    missing = []
    for metric in ("incremental_sales", "incremental_units", "trade_spend",
                   "roi_multiple", "margin_percent", "cannibalization", "pei"):
        cell = _cell(scenario, "low", metric)
        if cell and not cell.get("available"):
            missing.append({"metric": metric, "reason": cell.get("unavailable_reason")})
    if not missing:
        return None
    return _finding(
        "required_kpis", "DATA_AVAILABILITY", "attention", "medium",
        f"{len(missing)} metric(s) unavailable for this scope",
        "The KPI engine could not produce every metric for this scope. The values are "
        "absent rather than zero, and each carries the engine's own reason.",
        {"unavailable": missing}, "app/tpo/aggregate.calculate_kpis",
        "Those metrics cannot inform the decision for this scenario.",
        "Record which metrics were unavailable when the decision is documented.",
    )


def _scope_finding(scenario: dict[str, Any]) -> dict[str, Any]:
    """Rule 7: scope context, stated factually. No minimum sample size is
    asserted -- the project has approved none, and calling a scope
    'statistically weak' would be exactly that assertion."""
    scope = scenario.get("scope") or {}
    return _finding(
        "scope", "SCOPE", "clear", "unknown",
        "Scope context",
        f"This scenario is based on {scope.get('promoted_row_count', 0):,} promoted rows "
        f"out of {scope.get('row_count', 0):,} in scope, over {scope.get('period')}.",
        {
            "row_count": scope.get("row_count"),
            "promoted_row_count": scope.get("promoted_row_count"),
            "period": scope.get("period"),
            "filters_applied": scope.get("filters_applied"),
            "minimum_scope_policy": None,
        },
        "app/tpo/filters.FilterState",
        "A narrower scope describes fewer promotion events.",
        "Confirm the scope matches the decision being taken.",
    )


def _excluded_rows_finding(scenario: dict[str, Any]) -> dict[str, Any] | None:
    """Rule 8: only when rows were actually excluded."""
    scope = scenario.get("scope") or {}
    excluded = scope.get("excluded_rows") or 0
    if not excluded:
        return None
    return _finding(
        "excluded_rows", "EXECUTION", "attention", "medium",
        f"{excluded:,} promoted rows excluded from the scenario",
        scope.get("excluded_reason") or "Some promoted rows could not be re-based.",
        {"excluded_rows": excluded, "excluded_reason": scope.get("excluded_reason")},
        "app/tpo/execution.synthesize",
        "The scenario describes less of the scope than the measured baseline does.",
        "Check whether the excluded rows matter to the decision.",
    )


def _provenance_finding(scenario: dict[str, Any]) -> dict[str, Any]:
    """Rule 9: is this result traceable to the approved rules and engine?"""
    provenance = scenario.get("provenance") or {}
    required = ("response_rule", "treatment", "discount_pct", "uplift_low",
                "uplift_high", "kpi_engine", "promotion_cost_rate")
    missing = [f for f in required if provenance.get(f) is None]

    basis_ok = (
        provenance.get("response_rule") == response.PROVENANCE
        and provenance.get("kpi_engine") == "app/tpo/aggregate.calculate_kpis"
        and provenance.get("promotion_cost_rate") == config.PROMOTION_COST_RATE
    )

    if missing or not basis_ok:
        return _finding(
            "provenance", "GOVERNANCE", "attention", "high",
            "Scenario provenance is incomplete or does not match the approved basis",
            (
                f"Missing provenance fields: {', '.join(missing)}."
                if missing
                else "The result was produced on a different economic basis from the "
                "approved rules and KPI engine."
            ),
            {"missing_fields": missing, "provenance": provenance, "basis_matches": basis_ok},
            "app/tpo/execution.py provenance block",
            "This scenario cannot be described as fully governed.",
            "Re-run the scenario through the approved simulation endpoint before acting.",
        )

    return _finding(
        "provenance", "GOVERNANCE", "clear", "low",
        "Scenario is traceable to the approved rules and KPI engine",
        "The result carries the approved response rule, the validated KPI engine and the "
        "approved promotion cost rate.",
        {"provenance": provenance, "basis_matches": True},
        "app/tpo/execution.py provenance block",
        "The result can be traced end to end.",
        None,
    )


def _treatment_finding(scenario: dict[str, Any]) -> dict[str, Any]:
    """Rule 10: validate the treatment even though /simulate already does."""
    treatment = scenario.get("treatment")
    discount = scenario.get("discount_pct")
    approved = {t.treatment: t for t in response.all_treatments()}

    if treatment not in approved or approved[treatment].discount_pct != discount:
        return _finding(
            "approved_treatment", "GOVERNANCE", "attention", "high",
            "Treatment is not an approved promotion treatment",
            f"{treatment} at {discount}% does not match an approved treatment rule.",
            {"treatment": treatment, "discount_pct": discount,
             "approved": [t.treatment for t in response.all_treatments()]},
            "app/tpo/response.RECOMMENDATION rules",
            "The scenario is outside the approved promotion rules.",
            "Re-run using one of the approved treatments.",
        )

    rule = approved[treatment]
    return _finding(
        "approved_treatment", "GOVERNANCE", "clear", "low",
        f"{treatment} is an approved promotion treatment",
        f"{treatment} at {rule.discount_pct}% carries an approved uplift range of "
        f"{rule.uplift_low * 100:.0f}-{rule.uplift_high * 100:.0f}%.",
        {"treatment": treatment, "discount_pct": rule.discount_pct,
         "uplift_low": rule.uplift_low, "uplift_high": rule.uplift_high,
         "provenance": response.PROVENANCE},
        "app/tpo/response.py",
        "The scenario sits inside the approved rules.",
        None,
    )


def _limitations(scenario: dict[str, Any], weekly_included: bool) -> list[dict[str, Any]]:
    """Rules 11, 12, 13: properties of the METHOD, not of this scenario.

    Kept apart from findings because they are true of every scenario this
    project produces, and a reader should not have to infer that.
    """
    levers = scenario.get("levers") or {}
    items = [
        {
            "id": "unmodelled_duration",
            "category": "ASSUMPTION",
            "title": "Duration is not modelled",
            "statement": (
                (levers.get("duration_weeks") or {}).get("note")
                or "No approved rule maps promotion duration to uplift."
            ),
            "implication": (
                "The result must not be read as evidence that changing duration alone "
                "would produce the displayed impact."
            ),
        },
        {
            "id": "derived_spend",
            "category": "ASSUMPTION",
            "title": "Trade spend is derived, not an input",
            "statement": (
                (levers.get("spend_amount") or {}).get("note")
                or "Trade spend is an output of the scenario economics."
            ),
            "implication": (
                "Spending more or less than the derived figure is not a scenario this "
                "simulation can evaluate."
            ),
        },
        {
            "id": "range_interpretation",
            "category": "ASSUMPTION",
            "title": "The range is an approved uplift range",
            "statement": (
                "Simulation results are shown as an approved uplift range, not a "
                "confidence interval or a probability distribution."
            ),
            "implication": (
                "The two ends are the approved rule's bounds. Neither is more likely than "
                "the other, and there is no expected value between them."
            ),
        },
    ]
    if weekly_included:
        items.append(
            {
                "id": "weekly_decomposition",
                "category": "ASSUMPTION",
                "title": "The weekly view is a decomposition",
                "statement": weekly.METHOD,
                "implication": (
                    "Weekly shape reflects when the promotion ran and how much of it ran, "
                    "not week-to-week demand."
                ),
            }
        )
    return items


# --- the assessment ---------------------------------------------------------


def assess(
    scenario: dict[str, Any],
    recommendation: dict[str, Any] | None = None,
    weekly_included: bool = False,
    policy: RiskPolicy = RISK_POLICY,
) -> dict[str, Any]:
    """Assess one simulated scenario. Reads results; computes no KPI.

    `recommendation` is B4.3's answer, carried through unchanged. This function
    never selects a scenario and never alters the one B4 selected.
    """
    findings = [
        *_economic_findings(scenario, policy),
        _treatment_finding(scenario),
        _provenance_finding(scenario),
        _metric_finding(scenario, "trade_spend", "trade_spend", "ECONOMIC", "Trade Spend",
                        _gap("budget_ceiling")),
        _metric_finding(scenario, "margin_percent", "margin", "ECONOMIC", "Margin",
                        _gap("margin_floor")),
        _metric_finding(scenario, "cannibalization", "cannibalization", "CANNIBALIZATION",
                        "Cannibalization", _gap("cannibalization_limit")),
        _scope_finding(scenario),
    ]
    for optional in (_availability_finding(scenario), _excluded_rows_finding(scenario)):
        if optional is not None:
            findings.append(optional)

    # THE OVERALL RULE, applied literally. No score, no average.
    by_id = {f["id"]: f for f in findings}
    if any(f["status"] == "attention" and f["severity"] == "high" for f in findings):
        overall = "attention"
    elif any(
        by_id.get(key, {}).get("status") == "unknown" for key in policy.governance_critical
    ):
        overall = "unknown"
    else:
        overall = "clear"

    attention = [f for f in findings if f["status"] == "attention"]
    unknown = [f for f in findings if f["status"] == "unknown"]
    summary = _summarise(overall, attention, unknown)

    recommended_id = (recommendation or {}).get("recommended_scenario_id")
    return {
        "scenario_id": scenario.get("scenario_id"),
        "treatment": scenario.get("treatment"),
        "discount_pct": scenario.get("discount_pct"),
        "overall_status": overall,
        "overall_status_rule": policy.overall_status_rule,
        "summary": summary,
        "findings": findings,
        "governance_gaps": [
            {"key": g.key, "label": g.label, "statement": g.statement}
            for g in policy.undefined_thresholds
        ],
        "limitations": _limitations(scenario, weekly_included),
        # B4's answer, carried through. B6 does not change it.
        "recommendation_context": {
            "recommended_scenario_id": recommended_id,
            "recommendation_policy_version": (recommendation or {}).get("policy", {}).get("version"),
            "is_recommended": recommended_id is not None
            and recommended_id == scenario.get("scenario_id"),
            "note": (
                "Risk and governance are assessed independently of the recommendation. "
                "A scenario may be recommended under the current decision policy and "
                "still carry attention-level findings; this assessment does not change "
                "which scenario was recommended."
            ),
        },
        "policy": {
            "version": policy.version,
            "principle": policy.principle,
            "overall_status_rule": policy.overall_status_rule,
            "narrow_headroom_pp": policy.narrow_headroom_pp,
            "narrow_headroom_source": policy.narrow_headroom_source,
            "governance_critical": list(policy.governance_critical),
        },
        "provenance": {
            "assessed_by": "app/tpo/risk.RISK_POLICY",
            "policy_version": policy.version,
            "scenario_provenance": scenario.get("provenance"),
            "method": (
                "Deterministic rules over results the simulation, comparison and "
                "recommendation already produced. No KPI is recomputed, no score is "
                "calculated and no threshold is invented."
            ),
        },
        "meta": {"phase": "B6"},
    }


def _gap(key: str) -> GovernanceGap:
    return next(g for g in UNDEFINED_THRESHOLDS if g.key == key)


def _summarise(
    overall: str, attention: list[dict[str, Any]], unknown: list[dict[str, Any]]
) -> str:
    """One sentence, built from the findings that actually fired.

    THE OVERALL STATUS IS SEVERITY-GATED -- only a HIGH-severity finding makes
    it `attention` -- so `clear` can coexist with medium-severity attention
    findings. Saying "no attention-level findings" in that case would be
    false, so the summary names them explicitly instead. The status and the
    sentence have to agree with the same evidence.
    """
    if overall == "attention":
        titles = "; ".join(f["title"] for f in attention)
        return f"Attention: {titles}."
    if overall == "unknown":
        titles = "; ".join(f["title"] for f in unknown)
        return f"Parts of this scenario could not be assessed: {titles}."

    parts = [
        "No high-severity findings. The scenario is traceable to the approved rules and "
        "clears break-even across its approved range."
    ]
    if attention:
        titles = "; ".join(f["title"] for f in attention)
        parts.append(
            f"{len(attention)} item(s) still warrant attention: {titles}."
        )
    if unknown:
        parts.append(
            f"{len(unknown)} item(s) could not be assessed against an approved boundary "
            "because none is defined."
        )
    return " ".join(parts)
