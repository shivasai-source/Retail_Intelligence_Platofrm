"""Cross-module reconciliation: Command Center -> RCA -> Simulation -> Decision.

ONE SCOPE, WALKED ONCE, ASSERTED EVERYWHERE. Decision Center computes nothing,
so the only way it can be wrong is by carrying a value badly: dropping it,
renaming it, taking it from the wrong scenario, collapsing a range, or letting a
label drift from the number underneath. Every test here is an equality against
the module that owns the value.

FIVE PROPERTIES:

  1. SHARED KPIs RECONCILE. The measured figures Decision Center shows are the
     same ones Command Center shows for the same scope, to the character.
  2. SCENARIO VALUES RECONCILE. Every expected-impact figure equals the
     /simulate payload it came from, at BOTH ends of the band.
  3. NOTHING IS DROPPED IN ASSEMBLY. Fields the upstream payloads carry arrive
     in the record -- this is where `scope.excluded_reason` was being lost.
  4. IDENTITY RECONCILES. Scenario ids, names and scope agree across simulate,
     comparison, recommendation, risk and the record.
  5. A BLANK IS EXPLAINED OR IT IS A BUG. Every absent value carries a reason.

Run with:

    ../venv/Scripts/python.exe -m pytest tests/ -q
"""

from __future__ import annotations

import pytest
from fastapi.testclient import TestClient

from app.main import app

YEAR = 2025
#: A scope every module can serve, and one the simulation can actually run on.
SCOPE = {"year": YEAR, "channel": ["CH002"]}
#: A scope where the engine excludes EVERY promoted row -- the zero-result case.
EXCLUDING_SCOPE = {"year": YEAR, "month": 10, "channel": ["CH002"]}
QUESTION = "Why did Modern Trade underperform?"


@pytest.fixture(scope="session")
def client():
    return TestClient(app)


def _post(client, path, body, expect=200):
    r = client.post(path, json=body)
    assert r.status_code == expect, r.text
    return r.json()


def _journey(client, scope):
    context = _post(client, "/api/simulation/context", {
        "filters": scope, "question": QUESTION,
        "investigation_started": True, "investigation_type": "diagnostic"})
    run = _post(client, "/api/simulation/run", {"filters": scope})
    a = _post(client, "/api/simulation/simulate",
              {"filters": scope, "scenario_id": "scenario-a", "discount_pct": 10})
    b = _post(client, "/api/simulation/simulate",
              {"filters": scope, "scenario_id": "scenario-b", "discount_pct": 15})
    entries = [
        {"scenario_id": "current-plan", "name": "Current Plan",
         "measured": run["kpis"], "scope": run["scope"]["filters_applied"]},
        {"scenario_id": "scenario-a", "name": "Optimized Plan", "simulated": a},
        {"scenario_id": "scenario-b", "name": "Aggressive Growth", "simulated": b},
    ]
    req = {"filters": scope, "entries": entries}
    comparison = _post(client, "/api/simulation/compare", req)
    recommendation = _post(client, "/api/simulation/recommend", req)
    risk = _post(client, "/api/simulation/risk", {
        "scenario": b, "recommendation": recommendation, "weekly_included": False})
    record = _post(client, "/api/decision/record", {
        "context": context, "simulation": b, "recommendation": recommendation,
        "risk": risk, "comparison": comparison, "baseline": run})
    return {"context": context, "run": run, "selected": b, "comparison": comparison,
            "recommendation": recommendation, "risk": risk, "record": record,
            "scope": scope}


@pytest.fixture(scope="session")
def journey(client):
    return _journey(client, SCOPE)


@pytest.fixture(scope="session")
def excluding(client):
    return _journey(client, EXCLUDING_SCOPE)


# --- 1. Command Center -------------------------------------------------------

#: Command Center's key -> the label the simulation stack uses for the same KPI.
SHARED_KPIS = {
    "trade_spend": "Trade Spend",
    "incremental_sales": "Incremental Sales",
    "promotion_roi": "Promotion ROI",
    "margin_impact": "Margin Impact",
    "cannibalization_rate": "Cannibalization Rate",
}


def test_the_measured_figures_match_command_center_to_the_character(client, journey):
    """SAME SCOPE, SAME NUMBER. Decision Center's Current column is measured by
    the same engine Command Center reads, so a difference here means one of them
    is carrying a value badly -- there is no second calculation to blame."""
    cc = client.get("/api/command-center/kpis",
                    params={"year": YEAR, "channel": ["CH002"]}).json()["kpis"]
    baseline = {m["label"]: (m.get("baseline") or {})
                for m in journey["record"]["comparison"]["metrics"]}

    checked = 0
    for cc_key, label in SHARED_KPIS.items():
        card, measured = cc.get(cc_key), baseline.get(label)
        if card is None or measured is None:
            continue
        assert card["available"] == measured["available"], label
        if card["available"]:
            assert card["display_value"] == measured["display_value"], (
                f"{label}: command_center={card['display_value']!r} "
                f"decision={measured['display_value']!r}")
            assert card["value"] == measured["value"], label
        checked += 1
    assert checked >= 4, f"only {checked} shared KPIs reconciled"


def test_command_center_and_the_baseline_run_read_the_same_rows(client, journey):
    cc = client.get("/api/command-center/kpis",
                    params={"year": YEAR, "channel": ["CH002"]}).json()["kpis"]
    for key, label in SHARED_KPIS.items():
        run_key = {"promotion_roi": "roi_multiple", "margin_impact": "margin_percent",
                   "cannibalization_rate": "cannibalization"}.get(key, key)
        if key not in cc or run_key not in journey["run"]["kpis"]:
            continue
        assert cc[key]["display_value"] == journey["run"]["kpis"][run_key]["display_value"], label


# --- 2. RCA / investigation context -------------------------------------------


def test_the_investigation_question_survives_unchanged(journey):
    assert journey["record"]["investigation"]["question"] == QUESTION
    assert journey["record"]["investigation"]["question"] == \
        journey["context"]["question"]["value"]
    assert journey["record"]["investigation"]["question_source"] == "rca"


def test_rca_context_carries_no_kpi_value_into_the_decision(journey):
    """THE CONFLICT THAT CANNOT HAPPEN. Earlier audits found authored RCA figures
    contradicting the measured engine. The context contract carries none --
    `carries_kpi_values` is false -- so no RCA number can reach a Decision Center
    card. Every figure comes from the calculation services instead."""
    assert journey["context"]["carries_kpi_values"] is False


def test_an_absent_investigation_id_carries_its_reason(journey):
    inv = journey["record"]["investigation"]
    if inv["investigation_id"] is None:
        assert inv["investigation_id_unavailable_reason"]


# --- 3. Simulation ------------------------------------------------------------


@pytest.mark.parametrize("end", ["low", "high"])
def test_every_impact_figure_equals_the_simulate_payload(journey, end):
    """BOTH ENDS. A record that matched at one end and not the other would be a
    collapsed band wearing a range's clothes."""
    source = journey["selected"]["result"][end]["kpis"]
    checked = 0
    for metric in journey["record"]["expected_impact"]:
        cell = source[metric["metric"]]
        assert metric[end] == cell["value"], metric["metric"]
        assert metric[f"display_{end}"] == cell["display_value"], metric["metric"]
        # A metric is available in the record only when BOTH ends are available
        # in the engine -- a band with one usable end is not a usable band.
        if metric["available"]:
            assert cell["available"], metric["metric"]
        else:
            assert metric["unavailable_reason"], metric["metric"]
        checked += 1
    assert checked == len(source), "a KPI the engine produced is missing from the record"


def test_a_band_is_never_collapsed_to_one_number(journey):
    for metric in journey["record"]["expected_impact"]:
        if not metric["available"]:
            continue
        assert metric["low"] is not None and metric["high"] is not None
        if metric["low"] != metric["high"]:
            midpoint = (metric["low"] + metric["high"]) / 2
            assert metric["low"] != midpoint and metric["high"] != midpoint


def test_the_selected_scenario_is_the_one_that_was_carried(journey):
    record = journey["record"]
    assert record["scenario"]["scenario_id"] == journey["selected"]["scenario_id"]
    assert record["scenario"]["treatment"] == journey["selected"]["treatment"]
    assert record["scenario"]["discount_pct"] == journey["selected"]["discount_pct"]
    assert record["scenario"]["uplift"] == journey["selected"]["uplift"]


def test_the_scenario_carries_the_name_a_person_gave_it(journey):
    """THE DEFECT THIS PINS. /simulate has no `name`, so the record used to fall
    through to the session id and every surface said "scenario-b". The name is
    in the comparison; it is read from there."""
    record = journey["record"]
    named = {s["scenario_id"]: s["name"] for s in journey["comparison"]["scenarios"]}
    assert record["scenario"]["name"] == named[record["scenario"]["scenario_id"]]
    assert record["scenario"]["name"] != record["scenario"]["scenario_id"]


def test_the_recommended_scenario_is_named_as_well_as_identified(journey):
    rec = journey["record"]["recommendation"]
    if rec["recommended_scenario_id"]:
        named = {s["scenario_id"]: s["name"] for s in journey["comparison"]["scenarios"]}
        assert rec["recommended_scenario_name"] == named[rec["recommended_scenario_id"]]


def test_the_scope_is_the_simulated_scope(journey):
    assert journey["record"]["scope"]["filters_applied"] == \
        journey["selected"]["scope"]["filters_applied"]
    assert journey["record"]["scope"]["filters_applied"] == \
        journey["context"]["filter_state"]["value"]
    for key in ("period", "row_count", "promoted_row_count", "excluded_rows"):
        assert journey["record"]["scope"][key] == journey["selected"]["scope"][key], key


# --- 4. nothing is dropped in assembly ----------------------------------------


def test_the_exclusion_reason_is_not_dropped(excluding):
    """THE DEFECT THIS PINS. The record carried `excluded_rows` and dropped
    `excluded_reason`, so a scenario whose every row was excluded rendered a row
    of zeros with nothing to explain them -- which reads as "we evaluated this
    promotion and it came to nothing"."""
    scope = excluding["record"]["scope"]
    assert scope["excluded_rows"] == excluding["selected"]["scope"]["excluded_rows"]
    assert scope["excluded_reason"] == excluding["selected"]["scope"]["excluded_reason"]
    assert scope["excluded_rows"] > 0
    assert scope["excluded_reason"], "rows were excluded with no reason carried"
    assert scope["all_promoted_rows_excluded"] is True


def test_the_zero_result_is_the_engines_own_and_is_not_rewritten(excluding):
    """NOT OVER-CORRECTED. The engine returns zeros for this scope; the record
    carries them unchanged. The fix was to explain them, never to hide them."""
    source = excluding["selected"]["result"]["low"]["kpis"]
    for metric in excluding["record"]["expected_impact"]:
        assert metric["low"] == source[metric["metric"]]["value"], metric["metric"]
        assert metric["available"] == source[metric["metric"]]["available"]


def test_the_measured_baseline_is_unaffected_by_the_exclusion(excluding):
    """MEASURED IS NOT SIMULATED. The scenario computed nothing; the scope was
    still measured, and its Trade Spend is real."""
    baseline = {m["label"]: (m.get("baseline") or {})
                for m in excluding["record"]["comparison"]["metrics"]}
    spend = baseline["Trade Spend"]
    assert spend["available"] is True
    assert spend["value"] > 0
    simulated = next(m for m in excluding["record"]["expected_impact"]
                     if m["metric"] == "trade_spend")
    assert simulated["low"] == 0
    assert spend["value"] != simulated["low"], "measured and simulated were conflated"


# --- 5. strategy --------------------------------------------------------------


def test_the_current_lever_column_is_the_measured_plan(journey):
    measured = {f["key"]: f for f in journey["run"]["current_plan"]["fields"]}
    for lever in journey["record"]["strategy"]["levers"]:
        observed = measured.get(lever["key"])
        if observed is None:
            continue
        assert lever["current_value"] == observed["value"], lever["key"]
        assert lever["current_display"] == observed["display_value"], lever["key"]


def test_the_selected_lever_column_is_the_scenarios_own(journey):
    for lever in journey["record"]["strategy"]["levers"]:
        assert lever["selected_value"] == \
            journey["selected"]["levers"][lever["key"]]["value"], lever["key"]


def test_when_the_measured_plan_is_recommended_its_depth_is_shown(excluding):
    """THE DEFECT THIS PINS. The policy often recommends keeping the current
    plan. A measured baseline has no approved treatment, so the comparison
    stamps no `discount_pct` on it and the column read "the recommended scenario
    carries no treatment depth" -- at exactly the moment the user needed to know
    what was being recommended. The depth is the measured one, already in the
    Current column."""
    rec = excluding["record"]["recommendation"]
    if rec["recommended_scenario_id"] != "current-plan":
        pytest.skip("this scope did not recommend the measured plan")

    discount = next(lever for lever in excluding["record"]["strategy"]["levers"]
                    if lever["key"] == "discount_pct")
    assert discount["recommended_available"] is True
    assert discount["recommended_is_measured_plan"] is True
    # The SAME number as the Current column -- carried, not recomputed.
    assert discount["recommended_value"] == discount["current_value"]
    assert discount["recommended_display"] == discount["current_display"]


def test_no_lever_outside_the_engines_own_set_appears(journey):
    engine = set(journey["selected"]["levers"])
    assert {lev["key"] for lev in journey["record"]["strategy"]["levers"]} == engine


# --- 6. recommendation, risk --------------------------------------------------


def test_the_recommendation_is_carried_verbatim(journey):
    source, carried = journey["recommendation"], journey["record"]["recommendation"]
    assert carried["recommended_scenario_id"] == source["recommended_scenario_id"]
    assert carried["status"] == source["status"]
    assert carried["reason"] == source["reason"]
    assert carried["policy_version"] == source["policy"]["version"]
    assert carried["objective"] == source["policy"]["objective"]
    assert carried["is_this_scenario"] == (
        source["recommended_scenario_id"] == journey["selected"]["scenario_id"])


def test_the_risk_assessment_is_carried_verbatim(journey):
    source, carried = journey["risk"], journey["record"]["governance"]
    assert carried["overall_status"] == source["overall_status"]
    assert carried["summary"] == source["summary"]
    assert carried["findings"] == source["findings"]
    assert carried["governance_gaps"] == source["governance_gaps"]
    assert carried["limitations"] == source["limitations"]


def test_no_governance_verdict_is_manufactured(journey):
    """Every gap the risk contract reports as undefined stays undefined. Nothing
    turns an absent threshold into a compliance claim."""
    for gap in journey["record"]["governance"]["governance_gaps"]:
        assert gap["statement"]
    assert journey["record"]["readiness"]["can_be_approved"] is False


# --- 7. the comparison --------------------------------------------------------


def test_the_comparison_is_carried_verbatim(journey):
    assert journey["record"]["comparison"]["metrics"] == journey["comparison"]["metrics"]


def test_exactly_one_scenario_is_marked_selected(journey):
    marked = [s for s in journey["record"]["comparison"]["scenarios"] if s["is_selected"]]
    assert len(marked) == 1
    assert marked[0]["scenario_id"] == journey["record"]["scenario"]["scenario_id"]


# --- 8. every blank is explained ----------------------------------------------


def test_no_user_facing_value_is_blank_without_a_reason(journey, excluding):
    """A BLANK IS EXPLAINED OR IT IS A BUG. Each surface the page renders is
    checked for a value or the reason there is none -- never both absent."""
    for case in (journey, excluding):
        record = case["record"]

        for metric in record["expected_impact"]:
            if not metric["available"]:
                assert metric["unavailable_reason"], metric["metric"]
            else:
                assert metric["display_low"] and metric["display_high"], metric["metric"]

        for lever in record["strategy"]["levers"]:
            for column in ("current", "selected", "recommended"):
                if not lever[f"{column}_available"]:
                    assert lever[f"{column}_unavailable_reason"], f"{lever['key']}.{column}"

        if record["comparison"]["available"]:
            for metric in record["comparison"]["metrics"]:
                base = metric.get("baseline") or {}
                if base and not base.get("available"):
                    assert base.get("unavailable_reason"), metric["label"]
            for entry in record["comparison"]["scenarios"]:
                if entry["status"] == "excluded":
                    assert entry["exclusion_reason"], entry["scenario_id"]

        inv = record["investigation"]
        if inv["question"] is None:
            assert inv["question_unavailable_reason"]
        if inv["investigation_id"] is None:
            assert inv["investigation_id_unavailable_reason"]

        if record["scope"]["excluded_rows"]:
            assert record["scope"]["excluded_reason"]

        if not record["weekly"]["available"]:
            assert record["weekly"]["reason"]
        if not record["comparison"]["available"]:
            assert record["comparison"]["reason"]


# --- 9. downstream: report and AI receive the same record ---------------------


def test_the_report_is_built_from_this_record_and_no_other(client, journey):
    r = client.post("/api/reports", json={
        "module": "decision-center", "scope": SCOPE,
        "options": {"decision_record": journey["record"]}})
    assert r.status_code == 201, r.text
    assert r.json()["status"] == "ready"


def test_the_ai_projection_carries_the_same_figures_the_page_shows(journey):
    """THE MODEL EXPLAINS WHAT THE UI DISPLAYS. Same record, same display
    strings, same names, same exclusion facts -- there is no second set of
    numbers for the explanation to disagree with."""
    from app.tpo import decision_brief

    record = journey["record"]
    sent = decision_brief.projection(record)

    assert sent["scenario_being_decided"]["name"] == record["scenario"]["name"]
    assert sent["recommendation"]["recommended_scenario_name"] == \
        record["recommendation"]["recommended_scenario_name"]
    assert sent["scope"]["promoted_rows_excluded_from_this_scenario"] == \
        record["scope"]["excluded_rows"]

    shown = {m["label"] or m["metric"]:
             f"{m['display_low']} - {m['display_high']}" if m["available"] else None
             for m in record["expected_impact"]}
    for row in sent["expected_impact_simulated"]:
        assert row["expected_range"] == shown[row["metric"]], row["metric"]


def test_the_ai_projection_states_when_nothing_could_be_simulated(excluding):
    from app.tpo import decision_brief

    sent = decision_brief.projection(excluding["record"])
    assert sent["scope"]["every_promoted_row_was_excluded"] is True
    assert sent["scope"]["exclusion_reason"]
