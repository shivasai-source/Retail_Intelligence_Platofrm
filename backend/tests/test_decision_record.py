"""Validation for the governed decision record -- B7.

B7 assembles; it does not calculate. So the tests are almost entirely about two
things.

IT CARRIES THROUGH VERBATIM. Every figure in the record is asserted equal to
the payload it came from -- the simulation's KPIs, the recommendation's reason
and policy, B6's findings, gaps and limitations. If Decision Center ever
disagrees with Simulation Studio about the same number, one of these fails.

IT REFUSES TO MERGE THINGS THAT DO NOT BELONG TOGETHER. A record combining
scenario A's impact with scenario B's recommendation, or a risk assessment from
another scope, would read as authoritative and be wrong. Each mismatch is
checked and refused.

And throughout: no persistence, no approval, no invented value.

Run with:

    ../venv/Scripts/python.exe -m pytest tests/ -q
"""

from __future__ import annotations

import copy
import json

import pytest
from fastapi.testclient import TestClient

from app.main import app
from app.tpo import decision
from tests import legacy_journey

YEAR = 2025
SCOPE = {"year": YEAR, "channel": ["CH002"]}
OTHER_SCOPE = {"year": YEAR, "channel": ["CH001"]}
QUESTION = "Which approved treatment recovers the most incremental sales in Modern Trade?"

#: Authored values from the old static Decision Center. None may appear.
AUTHORED = ("2.55", "98.6", "83.5", "24.8", "89%", "Retailer Incentive",
            "Inventory Allocation", "Finance team notified",
            "Target Achievement Probability", "Sell-through Forecast",
            "Data Confidence")


@pytest.fixture(scope="session")
def client():
    return TestClient(app)


def _post(client, path, body, expect=200):
    r = client.post(path, json=body)
    assert r.status_code == expect, r.text
    return r.json()


@pytest.fixture(scope="session")
def journey(client):
    """The retired studio's payloads, from the snapshot (tests/legacy_journey.py)."""
    snap = legacy_journey.load()
    context, scenario_a, scenario_b = snap["context"], snap["scenario_a"], snap["scenario_b"]
    recommendation, risk, weekly = snap["recommendation"], snap["risk"], snap["weekly"]
    return {
        "context": context, "run": snap["run"],
        "scenario_a": scenario_a, "scenario_b": scenario_b,
        "recommendation": recommendation, "risk": risk, "weekly": weekly,
        "request": {
            "context": context, "simulation": scenario_b,
            "recommendation": recommendation, "risk": risk, "weekly": weekly,
        },
    }


@pytest.fixture(scope="session")
def record(client, journey):
    return _post(client, "/api/decision/record", journey["request"])


def _keys(node, acc=None):
    acc = acc if acc is not None else set()
    if isinstance(node, dict):
        for key, value in node.items():
            acc.add(str(key).lower())
            _keys(value, acc)
    elif isinstance(node, list):
        for item in node:
            _keys(item, acc)
    return acc


# --- 1: assembly ------------------------------------------------------------


def test_a_valid_record_assembles(record, journey):
    """1."""
    assert record["scenario"]["scenario_id"] == "scenario-b"
    assert record["scenario"]["treatment"] == journey["scenario_b"]["treatment"]
    assert record["scenario"]["discount_pct"] == journey["scenario_b"]["discount_pct"]
    assert record["scenario"]["uplift"] == journey["scenario_b"]["uplift"]
    assert record["meta"]["phase"] == "B7"


def test_the_investigation_section_keeps_b31_honesty(record, journey):
    """A question the user actually asked is carried; an id RCA never assigned
    stays absent with its reason."""
    investigation = record["investigation"]
    assert investigation["question"] == QUESTION
    assert investigation["question_source"] == "rca"
    assert investigation["investigation_id"] is None
    assert investigation["investigation_id_unavailable_reason"]


# --- 2-3: mismatches refused ------------------------------------------------


def test_a_scenario_id_mismatch_is_rejected(client, journey):
    """2. Scenario A's risk beside scenario B's simulation."""
    risk_for_a = copy.deepcopy(journey["risk"])
    risk_for_a["scenario_id"] = "scenario-a"
    request = {**journey["request"], "risk": risk_for_a}
    detail = _post(client, "/api/decision/record", request, expect=422)["detail"]
    assert "scenario-a" in detail and "scenario-b" in detail


def test_a_scope_mismatch_is_rejected(client, journey):
    """3. An investigation context describing other rows."""
    elsewhere = copy.deepcopy(journey["context"])
    elsewhere["filter_state"]["value"] = OTHER_SCOPE
    request = {**journey["request"], "context": elsewhere}
    detail = _post(client, "/api/decision/record", request, expect=422)["detail"]
    assert "different scope" in detail


def test_a_risk_assessment_of_a_different_simulation_is_rejected(client, journey):
    """The strongest check: B6 carries the exact simulation provenance it
    assessed, so a risk computed from another run cannot slip through even for
    the same scenario id."""
    stale = copy.deepcopy(journey["risk"])
    stale["provenance"]["scenario_provenance"]["discount_pct"] = 99
    request = {**journey["request"], "risk": stale}
    detail = _post(client, "/api/decision/record", request, expect=422)["detail"]
    assert "different simulation result" in detail


def test_a_recommendation_that_never_saw_this_scenario_is_rejected(client, journey):
    """A recommendation covering other scenarios cannot be shown beside this
    one as though it had considered it."""
    narrowed = copy.deepcopy(journey["recommendation"])
    narrowed["eligible_scenarios"] = [
        s for s in narrowed["eligible_scenarios"] if s["scenario_id"] != "scenario-b"
    ]
    narrowed["excluded_scenarios"] = []
    request = {**journey["request"], "recommendation": narrowed}
    detail = _post(client, "/api/decision/record", request, expect=422)["detail"]
    assert "did not consider" in detail


@pytest.mark.parametrize("field,value", [("scenario_id", "other"), ("discount_pct", 25)])
def test_a_mismatched_weekly_payload_is_rejected(client, journey, field, value):
    weekly = copy.deepcopy(journey["weekly"])
    weekly[field] = value
    request = {**journey["request"], "weekly": weekly}
    _post(client, "/api/decision/record", request, expect=422)


def test_a_weekly_payload_from_another_scope_is_rejected(client, journey):
    weekly = copy.deepcopy(journey["weekly"])
    weekly["provenance"]["scope"] = OTHER_SCOPE
    request = {**journey["request"], "weekly": weekly}
    detail = _post(client, "/api/decision/record", request, expect=422)["detail"]
    assert "different scope" in detail


# --- 4-9: carried through verbatim ------------------------------------------


def test_the_recommendation_is_carried_verbatim(record, journey):
    """4. Not re-derived, not reinterpreted."""
    source, section = journey["recommendation"], record["recommendation"]
    assert section["recommended_scenario_id"] == source["recommended_scenario_id"]
    assert section["status"] == source["status"]
    assert section["reason"] == source["reason"]
    assert section["policy_version"] == source["policy"]["version"]
    assert section["objective"] == source["policy"]["objective"]
    assert section["primary_metric"] == source["policy"]["primary_metric"]
    assert section["is_this_scenario"] is True


def test_the_risk_assessment_is_carried_verbatim(record, journey):
    """5. Findings, gaps and limitations unchanged, object for object."""
    source, section = journey["risk"], record["governance"]
    assert section["overall_status"] == source["overall_status"]
    assert section["summary"] == source["summary"]
    assert section["findings"] == source["findings"]
    assert section["governance_gaps"] == source["governance_gaps"]
    assert section["limitations"] == source["limitations"]
    assert section["policy_version"] == source["policy"]["version"]


@pytest.mark.parametrize("end", ["low", "high"])
def test_simulation_metrics_are_carried_verbatim(record, journey, end):
    """6, 7. Every KPI, at both ends of the approved range."""
    source = journey["scenario_b"]["result"][end]["kpis"]
    for metric in record["expected_impact"]:
        cell = source[metric["metric"]]
        assert metric[end] == cell["value"], metric["metric"]
        assert metric[f"display_{end}"] == cell["display_value"], metric["metric"]


def test_no_midpoint_is_produced(record):
    """8. The band is carried whole."""
    for key in _keys(record):
        assert not any(w in key for w in ("midpoint", "average", "mean", "expected_value")), key
    for metric in record["expected_impact"]:
        if metric["low"] is None or metric["high"] is None or metric["low"] == metric["high"]:
            continue
        midpoint = (metric["low"] + metric["high"]) / 2
        assert metric["low"] != midpoint and metric["high"] != midpoint




def test_governance_gaps_are_preserved(record, journey):
    """10. Every undefined boundary still reported as undefined."""
    gaps = {g["key"] for g in record["governance"]["governance_gaps"]}
    assert gaps == {g["key"] for g in journey["risk"]["governance_gaps"]}
    for gap in record["governance"]["governance_gaps"]:
        assert "No approved" in gap["statement"]


def test_no_governance_gap_becomes_a_compliance_verdict(record):
    """THE defect B7 exists to remove. The old Decision Center claimed
    'Budget Compliance — Compliant' against a ceiling that does not exist."""
    flat = json.dumps(record, ensure_ascii=False).lower()
    for claim in ("compliant", "within approved trade spend",
                  "above minimum required margin", "within acceptable limit"):
        assert claim not in flat, f"the record claims compliance: {claim}"


# --- 11-14: not approved, not persisted -------------------------------------


def test_the_record_cannot_be_approved(record):
    """11. No approval criteria exist, so none is invented."""
    readiness = record["readiness"]
    assert readiness["can_be_approved"] is False
    assert "no approval criteria" in readiness["reason"].lower()
    assert any(b["id"] == "no_approval_criteria" for b in readiness["blockers"])


def test_recommended_governed_and_approved_are_distinguished(record):
    """A scenario can be recommended and governed without being approved."""
    states = record["readiness"]["states"]
    assert set(states) == {"recommended", "governed", "ready_to_review", "approved"}
    assert states["recommended"] is True
    assert states["approved"] is False
    assert "four different things" in record["readiness"]["states_note"]


def test_the_record_is_a_draft_with_no_identity(record):
    """12, 13, 14. Nothing is stored, so nothing has an id to retrieve."""
    assert record["decision_id"] is None
    assert record["status"] == "draft"
    assert record["meta"]["persisted"] is False
    assert "stored nowhere" in record["meta"]["persistence_note"]


def test_nothing_is_persisted_between_requests(client, journey):
    """14. Two identical requests produce two independent assemblies; there is
    no store to read back from."""
    first = _post(client, "/api/decision/record", journey["request"])
    second = _post(client, "/api/decision/record", journey["request"])
    assert first == second
    assert first["decision_id"] is second["decision_id"] is None


def test_the_module_writes_nothing():
    """No file, no database, no cache."""
    import inspect

    source = inspect.getsource(decision)
    for forbidden in ("open(", ".write(", "sqlite", "session.add", "commit(", "pickle"):
        assert forbidden not in source, forbidden


# --- 15-19: no authored value, no score -------------------------------------


def test_no_authored_decision_value_survives(record):
    """15. The old static Decision Center's numbers appear nowhere."""
    flat = json.dumps(record, ensure_ascii=False)
    for value in AUTHORED:
        assert value not in flat, f"authored Decision Center value leaked: {value}"


def test_no_score_confidence_probability_or_forecast(record):
    """16, 17, 18, 19."""
    for key in _keys(record):
        assert not any(
            w in key for w in ("score", "confidence", "probability", "weight", "rank")
        ), key
    flat = json.dumps(record, ensure_ascii=False).lower()
    # The only mentions of forecasting are the weekly limitation denying it.
    assert "not a forecast" in flat
    assert flat.count("forecast") == flat.count("not a forecast")


def test_no_notification_or_execution_claim(record):
    """No false external action, of any kind."""
    flat = json.dumps(record, ensure_ascii=False).lower()
    for claim in ("notified", "submitted", "approved by", "executed", "sent to"):
        assert claim not in flat, claim


# --- 20-22: provenance, determinism, isolation ------------------------------


def test_provenance_is_complete(record, journey):
    """20."""
    provenance = record["provenance"]
    assert provenance["assembled_from"] == list(decision.ASSEMBLED_FROM)
    assert provenance["kpi_engine"] == "app/tpo/aggregate.calculate_kpis"
    assert provenance["response_rule"] == journey["scenario_b"]["provenance"]["response_rule"]
    assert provenance["recommendation_policy_version"] == journey["recommendation"]["policy"]["version"]
    assert provenance["risk_policy_version"] == journey["risk"]["policy"]["version"]
    assert provenance["scenario_provenance"] == journey["scenario_b"]["provenance"]
    assert "recalculated" in provenance["method"]


def test_the_response_is_deterministic(client, journey):
    """21."""
    records = [_post(client, "/api/decision/record", journey["request"]) for _ in range(3)]
    assert all(r == records[0] for r in records)




def test_the_module_recomputes_nothing():
    """It assembles. No engine call, no policy call, no simulation."""
    import inspect

    source = inspect.getsource(decision)
    for call in ("calculate_kpis(", "rows_for(", "execution.synthesize(",
                 "comparison.compare(", "recommendation.recommend(", "risk.assess(",
                 "weekly.weekly(", "get_treatment_response("):
        assert call not in source, call


# --- a scenario the policy did NOT recommend --------------------------------


def test_a_non_recommended_scenario_is_carried_honestly(client, journey):
    """Selecting a scenario the policy did not choose does not change what the
    policy chose -- the record states the difference instead."""
    # Scenario A's own risk assessment, derived from the snapshot's assessment
    # of B: the assembler checks the risk's scenario id and simulation
    # provenance against the scenario it is filed beside, and both are A's.
    risk_for_a = copy.deepcopy(journey["risk"])
    risk_for_a["scenario_id"] = "scenario-a"
    risk_for_a["discount_pct"] = journey["scenario_a"]["discount_pct"]
    risk_for_a["provenance"]["scenario_provenance"] = journey["scenario_a"]["provenance"]
    record = _post(client, "/api/decision/record", {
        "context": journey["context"], "simulation": journey["scenario_a"],
        "recommendation": journey["recommendation"], "risk": risk_for_a,
    })

    assert record["scenario"]["scenario_id"] == "scenario-a"
    assert record["recommendation"]["is_this_scenario"] is False
    assert record["recommendation"]["recommended_scenario_id"] == (
        journey["recommendation"]["recommended_scenario_id"]
    )
    assert record["readiness"]["states"]["recommended"] is False


# --- weekly is optional -----------------------------------------------------


def test_the_weekly_section_is_honest_when_absent(client, journey):
    request = {k: v for k, v in journey["request"].items() if k != "weekly"}
    record = _post(client, "/api/decision/record", request)
    assert record["weekly"]["available"] is False
    assert "No weekly decomposition was carried" in record["weekly"]["reason"]


def test_the_weekly_section_is_carried_verbatim_when_present(record, journey):
    assert record["weekly"]["available"] is True
    assert record["weekly"]["week_count"] == len(journey["weekly"]["weeks"])
    assert record["weekly"]["weeks"] == journey["weekly"]["weeks"]
    assert record["weekly"]["reconciliation"] == journey["weekly"]["reconciliation"]


# --- the endpoint's edges ---------------------------------------------------


@pytest.mark.parametrize(
    "body",
    [
        {},
        {"context": {}, "simulation": {}, "recommendation": {}, "risk": {}},
        {"context": {}, "simulation": {"scenario_id": "a"}, "recommendation": {},
         "risk": {}, "unknown": 1},
    ],
)
def test_malformed_requests_are_rejected(client, body):
    assert client.post("/api/decision/record", json=body).status_code == 422


def test_the_legacy_decision_readers_are_gone(client):
    """The seed-JSON page readers (`/api/decision-default`, `/api/decision/{type}`)
    were removed with routers/pages.py once nothing called them. The POST that
    replaced them is unaffected."""
    assert client.get("/api/decision-default").status_code == 404
    assert client.get("/api/decision/diagnostic").status_code in (404, 405)
    assert client.post("/api/decision/record", json={}).status_code == 422
