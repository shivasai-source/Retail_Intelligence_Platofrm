"""The governed decision record -- B7.

Assembles one read-only record from results the earlier phases already
produced: the investigation context, the selected scenario's simulation, the
recommendation, the risk assessment and -- optionally -- the weekly
decomposition.

AN ASSEMBLY, NOT A CALCULATION. Nothing here computes a KPI, re-derives an
uplift, re-runs a comparison, re-applies the recommendation policy or
re-assesses risk. Every figure is carried through verbatim from the contract
that owns it, and `provenance.assembled_from` names each one. If a number in
Decision Center ever disagrees with the same number in Simulation Studio, the
cause is a bug in this file rather than a second opinion.

WHY THE SECTIONS ARE VALIDATED AGAINST EACH OTHER
-------------------------------------------------
A record silently combining scenario A's impact with scenario B's
recommendation, or a risk assessment computed over a different scope, would be
worse than no record at all -- it would look authoritative and be wrong. So
every section is checked to describe the SAME scenario over the SAME scope
before anything is assembled, and a mismatch is refused rather than merged.

The strongest of those checks costs nothing: B6 already carries the exact
simulation provenance it assessed, so `risk.provenance.scenario_provenance ==
simulation.provenance` proves the risk describes this scenario and no other.

NOT APPROVED, AND NOT APPROVABLE HERE
-------------------------------------
`can_be_approved` is False in every record. This project defines no approval
criteria -- nothing states who approves a promotion decision, against what
tests, or in what order -- so declaring a record approvable would be inventing
governance in code. The record instead states plainly what is recommended,
what is governed, what is unverified and why it cannot yet be approved.

RECOMMENDED IS NOT APPROVED, AND SELECTED IS NOT RECOMMENDED. The user chooses
which scenario to carry here. If that is the recommended one the record says
so; if it is not, the record says that too, and the recommendation is carried
through unchanged either way.
"""

from __future__ import annotations

from typing import Any

#: The KPI keys and lever keys of the RETIRED Simulation Studio payloads this
#: record is assembled from. The studio that produced them no longer exists
#: (it was replaced by app/tpo/studio.py, which carries nothing here); stored
#: decision records and their exports still hold payloads in that shape, and
#: this assembler keeps reading them. Formerly `simulation.SIMULATION_KPIS`
#: and `simulation._LEVER_META`, inlined verbatim when that module was removed.
LEGACY_KPI_KEYS: tuple[str, ...] = (
    "trade_spend", "incremental_units", "incremental_sales", "roi_multiple",
    "margin_percent", "cannibalization", "pei",
)
#: key -> (label, unit, decimals, step)
LEGACY_LEVER_META: dict[str, tuple[str, str, int, float]] = {
    "discount_pct": ("Discount Depth", "percent", 1, 0.5),
    "duration_weeks": ("Promotion Duration", "weeks", 0, 1),
    "spend_amount": ("Trade Spend", "currency", 1, 1),
}

#: Every source this record is assembled from, in the order it reads them.
ASSEMBLED_FROM = (
    "/api/simulation/context",
    "/api/simulation/simulate",
    "/api/simulation/recommend",
    "/api/simulation/risk",
    "/api/simulation/weekly (optional)",
    "/api/simulation/run (optional)",
    "/api/simulation/compare (optional)",
)

METHOD = (
    "A read-only assembly of results the simulation, recommendation and risk "
    "contracts already produced. No KPI, uplift, comparison, recommendation or "
    "risk finding is recalculated here; every figure is carried through verbatim."
)

#: Why a strategy row has no measured "current" beside it. Stated once.
NO_BASELINE_CARRIED = (
    "No measured baseline was carried with this scenario, so there is nothing to "
    "state the current value against. Open Simulation Studio, where the measured "
    "Current Plan is computed, and carry the scenario again."
)

#: Why a comparison table cannot be shown. Stated once.
NO_COMPARISON_CARRIED = (
    "No scenario comparison was carried with this scenario. A comparison needs at "
    "least one other run scenario over the same scope; run them in Simulation "
    "Studio and carry the decision again."
)

#: Why no record can be approved yet. Stated once.
NO_APPROVAL_CRITERIA = (
    "This project defines no approval criteria: nothing states who approves a "
    "promotion decision, against which tests, or in what order. A record cannot be "
    "declared approvable against rules that do not exist."
)


class SectionMismatch(ValueError):
    """Two sections of the record do not describe the same thing."""


def _require(condition: bool, message: str) -> None:
    if not condition:
        raise SectionMismatch(message)


def validate(
    context: dict[str, Any],
    scenario: dict[str, Any],
    recommendation: dict[str, Any],
    risk: dict[str, Any],
    weekly: dict[str, Any] | None,
    comparison: dict[str, Any] | None = None,
    baseline: dict[str, Any] | None = None,
) -> None:
    """Every section must describe the same scenario over the same scope.

    Checked rather than assumed. A record that combined one scenario's impact
    with another's recommendation would read as authoritative and be wrong.
    """
    scenario_id = scenario.get("scenario_id")
    _require(bool(scenario_id), "The simulation payload carries no scenario_id.")

    # --- risk was assessed on THIS simulation
    _require(
        risk.get("scenario_id") == scenario_id,
        f"The risk assessment is for scenario {risk.get('scenario_id')!r}, not "
        f"{scenario_id!r}.",
    )
    _require(
        (risk.get("provenance") or {}).get("scenario_provenance") == scenario.get("provenance"),
        "The risk assessment was computed from a different simulation result than the "
        "one supplied. Re-assess the selected scenario before carrying it here.",
    )

    # --- the scope the investigation established is the scope simulated
    context_scope = (context.get("filter_state") or {}).get("value")
    scenario_scope = (scenario.get("scope") or {}).get("filters_applied")
    _require(
        context_scope == scenario_scope,
        f"The investigation context describes a different scope ({context_scope}) "
        f"from the simulated scenario ({scenario_scope}).",
    )

    # --- the recommendation considered this scenario
    #
    # The recommendation payload carries no scope of its own, so membership is
    # the available proof: a recommendation that never saw this scenario cannot
    # be presented beside it.
    considered = {s.get("scenario_id") for s in recommendation.get("eligible_scenarios", [])} | {
        s.get("scenario_id") for s in recommendation.get("excluded_scenarios", [])
    }
    _require(
        scenario_id in considered,
        f"The recommendation did not consider scenario {scenario_id!r}. It covers "
        f"{sorted(c for c in considered if c)}.",
    )

    if comparison is not None:
        # A comparison computed over other rows would put this scenario beside
        # numbers that never described the same selection.
        _require(
            comparison.get("scope") == scenario_scope,
            "The scenario comparison covers a different scope from the selected "
            "scenario.",
        )
        # And it must actually contain the scenario being decided -- a table the
        # selected scenario is absent from cannot be presented as its comparison.
        listed = {s.get("scenario_id") for s in comparison.get("scenarios", [])}
        _require(
            scenario_id in listed,
            f"The comparison does not include scenario {scenario_id!r}. It covers "
            f"{sorted(c for c in listed if c)}.",
        )

    if baseline is not None:
        _require(
            (baseline.get("scope") or {}).get("filters_applied") == scenario_scope,
            "The measured baseline was computed over a different scope from the "
            "selected scenario.",
        )

    if weekly is not None:
        _require(
            weekly.get("scenario_id") == scenario_id,
            f"The weekly decomposition is for scenario {weekly.get('scenario_id')!r}, "
            f"not {scenario_id!r}.",
        )
        _require(
            weekly.get("discount_pct") == scenario.get("discount_pct"),
            "The weekly decomposition was built at a different treatment from the "
            "selected scenario.",
        )
        _require(
            (weekly.get("provenance") or {}).get("scope") == scenario_scope,
            "The weekly decomposition covers a different scope from the selected "
            "scenario.",
        )


# --- sections ---------------------------------------------------------------


def _expected_impact(scenario: dict[str, Any]) -> list[dict[str, Any]]:
    """The scenario's KPIs, carried whole.

    BOTH ENDS OF THE APPROVED RANGE, never a midpoint: the band is the approved
    rule's bounds and collapsing it would invent a precision the rule does not
    grant. An unavailable metric keeps the engine's own reason and is never
    zero-filled.
    """
    low = (scenario.get("result", {}).get("low", {}) or {}).get("kpis", {}) or {}
    high = (scenario.get("result", {}).get("high", {}) or {}).get("kpis", {}) or {}

    impact = []
    for kpi_key in LEGACY_KPI_KEYS:
        low_cell, high_cell = low.get(kpi_key, {}), high.get(kpi_key, {})
        if not low_cell:
            continue
        available = bool(low_cell.get("available")) and bool(high_cell.get("available"))
        impact.append(
            {
                "metric": kpi_key,
                "label": low_cell.get("label"),
                "unit": low_cell.get("unit"),
                "low": low_cell.get("value"),
                "high": high_cell.get("value"),
                "display_low": low_cell.get("display_value"),
                "display_high": high_cell.get("display_value"),
                "available": available,
                "unavailable_reason": low_cell.get("unavailable_reason")
                or high_cell.get("unavailable_reason"),
            }
        )
    return impact


def _scenario_name(
    scenario: dict[str, Any], comparison: dict[str, Any] | None, scenario_id: str
) -> str:
    """The name a PERSON gave this scenario, not the id a session gave it.

    THE DEFECT THIS FIXES. `/simulation/simulate` carries no `name` -- it is
    keyed by `scenario_id`, and the label the user typed ("Aggressive Growth")
    lives in the browser's scenario store. So this record used to fall straight
    through to the id and every surface downstream said "scenario-b": the page
    header, the Recommended Plan card, the exported report and the AI brief.

    The name is not missing from the system, only from THIS payload -- the
    comparison request carries it, and `/simulation/compare` echoes it back on
    every entry. So it is read from there, by id.

    A LOOKUP, NOT A GUESS. If the comparison does not name this scenario the id
    stands, exactly as before. Nothing is invented and nothing is prettified.
    """
    if comparison is not None:
        for entry in comparison.get("scenarios", []):
            if entry.get("scenario_id") == scenario_id and entry.get("name"):
                return str(entry["name"])
    # `/simulate` has no `name` today. Read it anyway, so the day it grows one
    # this resolver already prefers it over the id.
    return str(scenario.get("name") or scenario_id)


def _strategy(
    scenario: dict[str, Any],
    baseline: dict[str, Any] | None,
    comparison: dict[str, Any] | None,
    recommended_scenario_id: str | None,
) -> dict[str, Any]:
    """The levers this scenario actually moves -- measured, selected, recommended.

    ONLY LEVERS THE SCENARIO CARRIES. The row set is the scenario's own `levers`
    block, which the simulation engine wrote; nothing is added to it here.
    Retailer Incentive, Inventory Allocation and Budget Allocation are absent for
    the reason the retired studio's lever metadata gave -- no field in any dataset splits
    retailer support out of Promotion_Cost and the project holds no inventory
    data -- and a lever with nothing behind it is not offered.

    THREE COLUMNS FROM THREE OWNERS, none of them this file:

      current      the MEASURED plan, from /simulation/run's current_plan.fields
                   -- a real observation carrying its own derivation string.
      selected     the scenario's own lever block, from /simulation/simulate.
      recommended  the recommended scenario's treatment depth, read out of the
                   comparison's own scenario list by id.

    Nothing is computed, converted or defaulted. A column with no source says so
    and stays empty; `modelled` is carried through, so a lever the engine records
    but does not model cannot be read as one that moved a number.
    """
    levers = scenario.get("levers") or {}
    measured = {
        field.get("key"): field
        for field in ((baseline or {}).get("current_plan") or {}).get("fields", [])
        if isinstance(field, dict)
    }

    # The recommended scenario's depth, as the comparison recorded it. Read by
    # id rather than re-derived: a treatment this file worked out for itself
    # would be a second opinion about what the policy chose.
    recommended_entry: dict[str, Any] = {}
    if comparison is not None and recommended_scenario_id:
        recommended_entry = next(
            (
                entry
                for entry in comparison.get("scenarios", [])
                if entry.get("scenario_id") == recommended_scenario_id
            ),
            {},
        )

    rows: list[dict[str, Any]] = []
    for key in LEGACY_LEVER_META:
        lever = levers.get(key)
        if lever is None:
            continue
        label, unit, _decimals, _step = LEGACY_LEVER_META[key]
        observed = measured.get(key) or {}
        selected_value = lever.get("value")

        row: dict[str, Any] = {
            "key": key,
            "label": observed.get("label") or label,
            "unit": unit,
            # --- measured
            "current_value": observed.get("value"),
            "current_display": observed.get("display_value"),
            "current_available": bool(observed.get("available")),
            "current_unavailable_reason": (
                observed.get("unavailable_reason")
                if baseline is not None
                else NO_BASELINE_CARRIED
            ),
            "current_derivation": observed.get("derivation"),
            # --- selected
            "selected_value": selected_value,
            "selected_available": selected_value is not None,
            "selected_unavailable_reason": lever.get("note") if selected_value is None else None,
            # Carried verbatim. False means the engine records the lever and does
            # not model it -- the KPIs above do not move with it.
            "modelled": bool(lever.get("modelled")),
            "derived": bool(lever.get("derived")),
            "note": lever.get("note"),
            # --- recommended
            "recommended_value": None,
            "recommended_treatment": None,
            "recommended_available": False,
            "recommended_unavailable_reason": None,
            # Set only when the policy recommends keeping the measured plan --
            # the page labels that differently from an approved treatment depth.
            "recommended_display": None,
            "recommended_is_measured_plan": False,
        }

        # DISCOUNT ONLY, and said so. The decision policy chooses a SCENARIO, and
        # the only lever a scenario varies is its treatment depth. Claiming a
        # recommended duration or spend would invent a preference nothing
        # expressed.
        if key == "discount_pct":
            depth = recommended_entry.get("discount_pct")
            row["recommended_value"] = depth
            row["recommended_treatment"] = recommended_entry.get("treatment")
            row["recommended_available"] = depth is not None

            # THE POLICY OFTEN RECOMMENDS KEEPING THE CURRENT PLAN, and when it
            # does the recommended depth is the MEASURED one.
            #
            # The comparison stamps `treatment` and `discount_pct` only onto
            # SIMULATED entries -- a measured baseline has no approved treatment,
            # because its depth is a revenue-weighted blend of whatever actually
            # traded. So this column used to read "the recommended scenario
            # carries no treatment depth in the comparison": true, unhelpful,
            # and shown at exactly the moment the user most needs to know what
            # is being recommended.
            #
            # The depth is not missing. It is the measured one already sitting in
            # the Current column, carried from /simulation/run's current plan.
            # Same number, same source, relabelled -- nothing is recomputed and
            # no approved treatment is asserted for a plan that has none.
            if depth is None and recommended_entry.get("is_baseline"):
                if observed.get("available"):
                    row["recommended_value"] = observed.get("value")
                    row["recommended_display"] = observed.get("display_value")
                    row["recommended_available"] = True
                    row["recommended_is_measured_plan"] = True
                else:
                    row["recommended_unavailable_reason"] = observed.get(
                        "unavailable_reason"
                    ) or NO_BASELINE_CARRIED

            if not row["recommended_available"] and not row["recommended_unavailable_reason"]:
                if comparison is None:
                    row["recommended_unavailable_reason"] = NO_COMPARISON_CARRIED
                elif not recommended_scenario_id:
                    row["recommended_unavailable_reason"] = (
                        "No scenario is recommended under the current decision policy."
                    )
                else:
                    row["recommended_unavailable_reason"] = (
                        "The recommended scenario carries no treatment depth in the "
                        "comparison."
                    )
        elif key == "duration_weeks":
            # THE RECOMMENDATION RUNS OVER THE PROMOTION WEEKS ALREADY IN SCOPE,
            # which is the measured duration sitting in the Current column.
            #
            # This column used to read "Not available" on the grounds that the
            # policy chooses a scenario and not a duration. True, and beside the
            # point: no scenario changes the duration either -- the lever is
            # recorded and not modelled, so every scenario runs over the same
            # weeks the scope already contains. Saying nothing was recommended
            # implied a decision still to be made about a value that is fixed by
            # the data.
            #
            # Same number, same source, carried through verbatim -- the measured
            # display string, not a re-rendered float. Nothing is recomputed and
            # no preference is invented: the recommendation simply keeps the
            # duration that is already there.
            if observed.get("available"):
                row["recommended_value"] = observed.get("value")
                row["recommended_display"] = observed.get("display_value")
                row["recommended_available"] = True
            else:
                # No measured duration, nothing to carry. The engine's own reason
                # for that, never a stand-in.
                row["recommended_unavailable_reason"] = (
                    observed.get("unavailable_reason") or NO_BASELINE_CARRIED
                )
        else:
            row["recommended_unavailable_reason"] = (
                "The decision policy chooses a scenario, not a value for this lever. "
                "Nothing recommends one."
            )

        rows.append(row)

    return {
        "available": bool(rows),
        "treatment": scenario.get("treatment"),
        "levers": rows,
        "baseline_available": baseline is not None,
        "baseline_unavailable_reason": None if baseline is not None else NO_BASELINE_CARRIED,
        "note": (
            "These are the levers the simulation engine records for this scenario, "
            "and no others. Current is measured from the rows in scope; selected is "
            "the scenario's own setting; recommended is the treatment depth of the "
            "scenario the decision policy chose, over the measured promotion "
            "duration already in scope."
        ),
    }


def _comparison_section(
    comparison: dict[str, Any] | None, scenario_id: str, recommended_scenario_id: str | None
) -> dict[str, Any]:
    """The scenario comparison, carried whole.

    NOT RE-RUN AND NOT RE-RANKED. Every value, delta and exclusion reason is the
    one /api/simulation/compare produced. The only things added are two id
    comparisons -- which row is the one being decided, and which one the policy
    chose -- and neither changes a number.

    MEASURED AND SIMULATED STAY APART. Each metric's `baseline` is MEASURED from
    the rows in scope; each metric's `scenarios` carry SIMULATED bands. They are
    different kinds of fact, so they stay in different fields and no renderer can
    flatten one into the other.
    """
    if comparison is None:
        return {"available": False, "reason": NO_COMPARISON_CARRIED}

    return {
        "available": True,
        "status": comparison.get("comparison_status"),
        "range_label": comparison.get("range_label"),
        "scenarios": [
            {
                **entry,
                "is_selected": entry.get("scenario_id") == scenario_id,
                "is_recommended": (
                    recommended_scenario_id is not None
                    and entry.get("scenario_id") == recommended_scenario_id
                ),
            }
            for entry in comparison.get("scenarios", [])
        ],
        "metrics": comparison.get("metrics", []),
        "economic_basis": comparison.get("economic_basis"),
        "recommendation_status": comparison.get("recommendation_status"),
        "recommendation_reason": comparison.get("recommendation_reason"),
        "measured_note": (
            "The baseline column is MEASURED from the rows in scope. Every scenario "
            "column is SIMULATED at both ends of the approved uplift range. Simulated "
            "values are not historical actuals."
        ),
    }


def _investigation(context: dict[str, Any]) -> dict[str, Any]:
    """Who is asking, and about what -- with B3.1's honest nulls intact.

    A question the user never asked stays absent: B3.1 reports the seeded
    example as `seed_example` rather than as the investigation's own, and that
    distinction survives into the decision record.
    """
    question = context.get("question") or {}
    identity = context.get("investigation_id") or {}
    return {
        "question": question.get("value"),
        "question_source": question.get("source"),
        "question_unavailable_reason": question.get("reason"),
        "investigation_id": identity.get("value"),
        "investigation_id_unavailable_reason": identity.get("reason"),
        "investigation_type": (context.get("investigation_type") or {}).get("value"),
        "source": context.get("source"),
    }


def _recommendation_section(
    recommendation: dict[str, Any],
    scenario_id: str,
    comparison: dict[str, Any] | None = None,
) -> dict[str, Any]:
    """The recommendation, verbatim.

    Not re-derived and not reinterpreted. `is_this_scenario` is a comparison of
    two ids and nothing more -- selecting a scenario the policy did not choose
    does not change what the policy chose.
    """
    recommended_id = recommendation.get("recommended_scenario_id")
    policy = recommendation.get("policy") or {}
    # The same lookup the selected scenario gets. A card reading "the
    # recommended scenario is current-plan" names an id at a person; "Current
    # Plan" names the thing they chose.
    recommended_name = (
        _scenario_name({}, comparison, recommended_id) if recommended_id else None
    )
    return {
        "recommended_scenario_id": recommended_id,
        "recommended_scenario_name": recommended_name,
        "is_this_scenario": recommended_id is not None and recommended_id == scenario_id,
        "status": recommendation.get("status"),
        "policy_version": policy.get("version"),
        "objective": policy.get("objective"),
        "primary_metric": policy.get("primary_metric"),
        "primary_endpoint": policy.get("primary_endpoint"),
        "reason": recommendation.get("reason"),
        "note": (
            "Recommended under the current decision policy. A different policy could "
            "select a different scenario; this is a preference under the stated rule, "
            "not a statement that the scenario is best in every respect."
        ),
    }


def _governance_section(risk: dict[str, Any]) -> dict[str, Any]:
    """B6's assessment, verbatim -- findings, gaps and limitations unchanged.

    Nothing here converts a governance gap into a compliance verdict. Where the
    project has approved no boundary, the gap travels through saying so.
    """
    return {
        "overall_status": risk.get("overall_status"),
        "overall_status_rule": risk.get("overall_status_rule"),
        "summary": risk.get("summary"),
        "findings": risk.get("findings", []),
        "governance_gaps": risk.get("governance_gaps", []),
        "limitations": risk.get("limitations", []),
        "policy_version": (risk.get("policy") or {}).get("version"),
    }


def _readiness(risk: dict[str, Any], recommendation_section: dict[str, Any]) -> dict[str, Any]:
    """What stands between this record and an approval.

    `can_be_approved` is False in every record -- see NO_APPROVAL_CRITERIA. The
    blockers and unverified lists are built from B6's own findings so the record
    says exactly what remains open rather than gesturing at it.
    """
    findings = risk.get("findings", [])

    blockers = [
        {
            "id": "no_approval_criteria",
            "title": "No approval criteria are defined",
            "detail": NO_APPROVAL_CRITERIA,
        }
    ]
    blockers += [
        {"id": f["id"], "title": f["title"], "detail": f["reason"]}
        for f in findings
        if f.get("status") == "attention" and f.get("severity") == "high"
    ]

    unverified = [
        {"id": f["id"], "title": f["title"], "detail": f["reason"],
         "action": f.get("recommended_action")}
        for f in findings
        if f.get("status") in {"attention", "unknown"} and not (
            f.get("status") == "attention" and f.get("severity") == "high"
        )
    ]
    unverified += [
        {"id": gap["key"], "title": gap["label"], "detail": gap["statement"], "action": None}
        for gap in risk.get("governance_gaps", [])
    ]

    return {
        "can_be_approved": False,
        "reason": NO_APPROVAL_CRITERIA,
        "blockers": blockers,
        "unverified": unverified,
        "states": {
            "recommended": recommendation_section["is_this_scenario"],
            "governed": risk.get("overall_status") == "clear",
            "ready_to_review": True,
            "approved": False,
        },
        "states_note": (
            "Recommended, governed, ready to review and approved are four different "
            "things. A scenario can be recommended under the decision policy and still "
            "carry open governance items, and no record is approved here."
        ),
    }


# --- the record -------------------------------------------------------------


def build_record(
    context: dict[str, Any],
    scenario: dict[str, Any],
    recommendation: dict[str, Any],
    risk: dict[str, Any],
    weekly: dict[str, Any] | None = None,
    comparison: dict[str, Any] | None = None,
    baseline: dict[str, Any] | None = None,
) -> dict[str, Any]:
    """Assemble one governed decision record.

    `comparison` (/api/simulation/compare) and `baseline` (/api/simulation/run)
    are OPTIONAL and additive: a record assembled without them carries the same
    sections it always did, each saying which source it is missing and why. They
    are what let the record state a measured value beside a simulated one and
    show the scenarios side by side, and NEITHER is recalculated -- both are
    carried through exactly as their own contracts produced them.

    Raises `SectionMismatch` when the sections do not describe the same
    scenario over the same scope. Nothing is recalculated.
    """
    validate(context, scenario, recommendation, risk, weekly, comparison, baseline)

    scenario_id = scenario["scenario_id"]
    recommendation_section = _recommendation_section(recommendation, scenario_id, comparison)
    recommended_id = recommendation_section["recommended_scenario_id"]
    scope = scenario.get("scope") or {}

    return {
        # NO PERSISTENCE IN B7. A record is assembled per request and stored
        # nowhere, so it has no identity to hand out -- an id here would invite
        # a client to believe it could be retrieved again.
        "decision_id": None,
        "status": "draft",
        "scenario": {
            "scenario_id": scenario_id,
            "name": _scenario_name(scenario, comparison, scenario_id),
            "treatment": scenario.get("treatment"),
            "discount_pct": scenario.get("discount_pct"),
            "uplift": scenario.get("uplift"),
            "range_label": scenario.get("range_label"),
        },
        "investigation": _investigation(context),
        "scope": {
            "filters_applied": scope.get("filters_applied"),
            "period": scope.get("period"),
            "row_count": scope.get("row_count"),
            "promoted_row_count": scope.get("promoted_row_count"),
            "excluded_rows": scope.get("excluded_rows"),
            # WAS BEING DROPPED, AND IT IS THE MOST IMPORTANT FIELD IN THIS
            # BLOCK. When the engine excludes promoted rows -- because their
            # (product, channel) has no non-promoted row to form a baseline
            # from -- the scenario has less to compute over than the scope
            # suggests, and if it excludes ALL of them the result is a row of
            # zeros. Carrying the count without the reason left a reader to
            # conclude the promotion was evaluated and came to nothing, which
            # is a different and false claim.
            "excluded_reason": scope.get("excluded_reason"),
            # A comparison of two counts the engine already reported. NOT a
            # KPI, not a rate and not a derivation: it exists so the page can
            # say plainly that nothing was left to simulate.
            "all_promoted_rows_excluded": bool(
                scope.get("promoted_row_count")
                and scope.get("excluded_rows") == scope.get("promoted_row_count")
            ),
        },
        "strategy": _strategy(scenario, baseline, comparison, recommended_id),
        "expected_impact": _expected_impact(scenario),
        "comparison": _comparison_section(comparison, scenario_id, recommended_id),
        "recommendation": recommendation_section,
        "governance": _governance_section(risk),
        "weekly": (
            {
                "available": True,
                "week_count": len(weekly.get("weeks", [])),
                "weeks": weekly.get("weeks", []),
                "metrics": weekly.get("metrics", []),
                "reconciliation": weekly.get("reconciliation"),
                "method": (weekly.get("provenance") or {}).get("method"),
            }
            if weekly is not None
            else {
                "available": False,
                "reason": (
                    "No weekly decomposition was carried with this scenario. Open the "
                    "weekly view in Simulation Studio to include it."
                ),
            }
        ),
        "readiness": _readiness(risk, recommendation_section),
        "provenance": {
            "assembled_from": list(ASSEMBLED_FROM),
            "kpi_engine": (scenario.get("provenance") or {}).get("kpi_engine"),
            "response_rule": (scenario.get("provenance") or {}).get("response_rule"),
            "promotion_cost_rate": (scenario.get("provenance") or {}).get("promotion_cost_rate"),
            "recommendation_policy_version": recommendation_section["policy_version"],
            "risk_policy_version": (risk.get("policy") or {}).get("version"),
            "scenario_provenance": scenario.get("provenance"),
            "method": METHOD,
        },
        "meta": {
            "phase": "B7",
            "persisted": False,
            "persistence_note": (
                "This record is assembled per request and stored nowhere. It cannot be "
                "retrieved later, and reloading the page does not recover it."
            ),
        },
    }
