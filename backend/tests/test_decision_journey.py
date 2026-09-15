"""The decision journey, frozen -- B4.4.

B3.3 froze the chain up to a simulated scenario. This freezes the rest of it:

    Insights Hub -> RCA -> Simulation -> scenarios -> comparison ->
    recommendation

B4.4 is presentation and freeze, so nothing here tests new logic. It tests the
JOINS -- the properties that only exist once the parts are wired together, and
that a refactor could quietly break without any single module's own suite
noticing.

FOUR PROPERTIES, each a way the chain could become wrong:

  1. ONE SET OF NUMBERS. The comparison and the recommendation are built from
     the same request, so the panel and the table can never describe different
     scenarios or different values.
  2. THE UI CAN EXPLAIN ITSELF. Everything the recommendation panel renders --
     the policy, the decision path, the readings, the evidence -- is present in
     the payload. Nothing is recomputed in the browser, so nothing can drift.
  3. THE CLAIM STAYS NARROW. The result is a preference under one policy. No
     payload may carry a score, a rank, or language asserting the scenario is
     universally best.
  4. THE POLICY IS UNCHANGED. B4.4 was not permitted to alter it, and this
     pins every field of the shipped policy.

Run with:

    ../venv/Scripts/python.exe -m pytest tests/ -q
"""

from __future__ import annotations

import json

import pytest
from fastapi.testclient import TestClient

from app.main import app
from app.tpo.recommendation import RECOMMENDATION_POLICY

YEAR = 2025
SCOPE = {"year": YEAR, "channel": ["CH002"]}
REAL_QUESTION = "Which approved treatment recovers the most incremental sales in Modern Trade?"

#: The treatments the journey runs, one per scenario.
PLAN = (("scenario-a", "Scenario A", 10), ("scenario-b", "Scenario B", 15), ("scenario-c", "Scenario C", 20))


@pytest.fixture(scope="session")
def client():
    return TestClient(app)


def _post(client, path, body):
    response = client.post(path, json=body)
    assert response.status_code == 200, response.text
    return response.json()


@pytest.fixture(scope="session")
def journey(client):
    """One full pass, reused by every test in this file."""
    context = _post(
        client,
        "/api/simulation/context",
        {"filters": SCOPE, "question": REAL_QUESTION, "investigation_started": True,
         "investigation_type": "diagnostic"},
    )
    scope = context["filter_state"]["value"]
    run = _post(client, "/api/simulation/run", {"filters": scope})

    entries = [
        {"scenario_id": "current-plan", "name": "Current Plan",
         "measured": run["kpis"], "scope": run["scope"]["filters_applied"]}
    ]
    for scenario_id, name, discount in PLAN:
        simulated = _post(
            client,
            "/api/simulation/simulate",
            {"filters": scope, "scenario_id": scenario_id, "discount_pct": discount},
        )
        entries.append({"scenario_id": scenario_id, "name": f"{name} @ {discount}%",
                        "simulated": simulated})

    request = {"filters": scope, "entries": entries}
    return {
        "scope": scope,
        "context": context,
        "run": run,
        "request": request,
        "comparison": _post(client, "/api/simulation/compare", request),
        "recommendation": _post(client, "/api/simulation/recommend", request),
    }


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


# --- the journey ------------------------------------------------------------


def test_the_decision_journey_completes(journey):
    """Investigation -> scope -> baseline -> three scenarios -> a decision."""
    assert journey["context"]["question"]["source"] == "rca"
    assert journey["run"]["scenarios"][0]["status"] == "measured"

    recommendation = journey["recommendation"]
    assert recommendation["status"] in {
        "recommended", "maintain_current_plan", "no_clear_winner", "insufficient_data"
    }
    assert recommendation["status"] == "recommended"
    assert recommendation["recommended_scenario_id"] in {sid for sid, _, _ in PLAN}
    assert len(recommendation["eligible_scenarios"]) == len(PLAN)


# --- 1: one set of numbers --------------------------------------------------


def test_the_comparison_and_the_recommendation_describe_the_same_scenarios(journey):
    """1. Both are built from one request, so they cannot disagree."""
    compared = {s["scenario_id"] for s in journey["comparison"]["scenarios"]}
    recommended = (
        {s["scenario_id"] for s in journey["recommendation"]["eligible_scenarios"]}
        | {s["scenario_id"] for s in journey["recommendation"]["excluded_scenarios"]}
        | {"current-plan"}
    )
    assert compared == recommended


def test_the_recommendation_reads_the_comparisons_values(journey):
    """The winner's evidence IS the comparison's figures, not a second read."""
    recommendation = journey["recommendation"]
    winner_id = recommendation["recommended_scenario_id"]
    evidence = recommendation["evidence"]["recommended"]

    for metric in journey["comparison"]["metrics"]:
        cell = next(
            (s for s in metric["scenarios"] if s["scenario_id"] == winner_id), None
        )
        if cell is None:
            continue
        assert evidence[metric["key"]]["low"] == cell["low"]["value"], metric["key"]
        assert evidence[metric["key"]]["high"] == cell["high"]["value"], metric["key"]


def test_the_recommended_scenario_is_comparable_in_the_comparison(journey):
    winner_id = journey["recommendation"]["recommended_scenario_id"]
    entry = next(s for s in journey["comparison"]["scenarios"] if s["scenario_id"] == winner_id)
    assert entry["comparable"] is True
    assert entry["status"] == "simulated"


# --- 2: the UI can explain itself -------------------------------------------


def test_everything_the_panel_renders_is_in_the_payload(journey):
    """2. The panel recomputes nothing, so every field it shows must be here."""
    recommendation = journey["recommendation"]

    # Header
    assert recommendation["policy"]["version"]
    assert recommendation["status"]
    # Winner block
    winner = next(
        s for s in recommendation["eligible_scenarios"]
        if s["scenario_id"] == recommendation["recommended_scenario_id"]
    )
    assert winner["treatment"] and winner["discount_pct"] is not None and winner["uplift"]
    for metric in ("incremental_sales", "roi_multiple", "trade_spend", "incremental_units",
                   "margin_percent", "pei", "cannibalization"):
        entry = winner["evidence"][metric]
        assert set(entry) == {
            "low", "high", "display_low", "display_high", "available", "unavailable_reason"
        }
        if not entry["available"]:
            assert entry["unavailable_reason"], metric
    # Explanation and policy popover
    assert recommendation["reason"]
    assert recommendation["policy"]["objective"]
    assert recommendation["policy"]["economic_constraint"]["note"]
    assert recommendation["policy"]["range_policy"]
    assert recommendation["provenance"]["method"]


def test_the_decision_path_is_renderable(journey):
    """2. Every step carries what the "How this was decided" section needs, and
    its readings name scenarios the payload also describes."""
    recommendation = journey["recommendation"]
    known = {s["scenario_id"] for s in recommendation["eligible_scenarios"]}
    assert recommendation["decision_path"], "a decision was made, so a path must exist"

    for step in recommendation["decision_path"]:
        assert step["criterion"] and step["endpoint"] in {"low", "high"}
        assert step["role"] in {"primary", "tie_breaker"}
        assert step["outcome"] in {"separated", "tied", "skipped"}
        assert set(step["readings"]) <= known
        if step["outcome"] == "skipped":
            assert step["detail"]
        else:
            assert step["leaders"]

    separating = [s for s in recommendation["decision_path"] if s["outcome"] == "separated"]
    assert separating, "a recommended status requires a step that separated the candidates"
    assert recommendation["recommended_scenario_id"] in separating[-1]["leaders"]


def test_the_first_decision_step_is_the_policys_primary(journey):
    first = journey["recommendation"]["decision_path"][0]
    assert first["criterion"] == RECOMMENDATION_POLICY.primary.metric
    assert first["endpoint"] == RECOMMENDATION_POLICY.primary.endpoint
    assert first["role"] == "primary"


# --- 3: the claim stays narrow ----------------------------------------------


def test_no_ranking_or_scoring_reaches_the_client(journey):
    """3. Keys, not prose -- the payload explains its own limits in words."""
    for payload in (journey["comparison"], journey["recommendation"]):
        for key in _keys(payload):
            assert not any(
                word in key for word in ("score", "rank", "weight", "midpoint", "confidence")
            ), key


def test_the_recommendation_makes_no_universal_claim(journey):
    """3. A preference under one policy is a narrower claim than "best"."""
    reason = journey["recommendation"]["reason"].lower()
    assert "under the current decision policy" in reason
    for word in ("guaranteed", "optimal", "perfect", "best possible", "will increase", "certain"):
        assert word not in reason, f"overclaim: {word}"


def test_the_result_is_deterministic(client, journey):
    """Same input, same answer -- five times."""
    results = [
        _post(client, "/api/simulation/recommend", journey["request"]) for _ in range(5)
    ]
    assert all(r == results[0] for r in results)
    assert results[0] == journey["recommendation"]


def test_no_authored_rca_figure_reaches_the_decision(journey):
    """The whole chain, swept once more: RCA's authored numbers stay out.

    `ensure_ascii=False` is load-bearing. Escaped, the rupee sign becomes
    `\\u20b9`, so a perfectly real "Rs 8.6 Cr" serialises as a string
    containing "98.6" and fails this sweep for a figure that is not there.
    Searching the unescaped text keeps the currency symbol whole, so a match
    means what it says.
    """
    blob = "".join(
        json.dumps(journey[part], ensure_ascii=False)
        for part in ("context", "run", "comparison", "recommendation")
    )
    for figure in ("98.6", "83.5", "24.8"):
        assert figure not in blob, f"authored RCA figure {figure} reached the decision"


# --- 4: the policy is unchanged ---------------------------------------------


def test_the_shipped_policy_is_exactly_the_approved_one():
    """4. B4.4 was a presentation phase. Every field is pinned here so a
    silent policy edit fails a test rather than changing a business decision."""
    policy = RECOMMENDATION_POLICY
    assert policy.primary.metric == "incremental_sales"
    assert policy.primary.endpoint == "low"
    assert policy.primary.direction == "higher_is_preferred"

    assert policy.economic_constraint.metric == "roi_multiple"
    assert policy.economic_constraint.endpoints == ("low", "high")
    assert policy.economic_constraint.must_be == "above_breakeven"

    assert [c.metric for c in policy.hierarchy] == [
        "incremental_sales", "roi_multiple", "incremental_units",
        "margin_percent", "pei", "trade_spend",
    ]
    assert [c.endpoint for c in policy.hierarchy] == ["low"] * 6
    assert [c.direction for c in policy.hierarchy] == (
        ["higher_is_preferred"] * 5 + ["lower_is_preferred"]
    )
    assert policy.required_metrics == ("incremental_sales", "roi_multiple")


def test_the_policy_travels_with_every_recommendation(journey):
    """A business user can see the rule that decided, from the response alone."""
    policy = journey["recommendation"]["policy"]
    assert policy["primary_metric"] == RECOMMENDATION_POLICY.primary.metric
    assert policy["primary_endpoint"] == "low"
    assert [c["metric"] for c in policy["hierarchy"]] == [
        c.metric for c in RECOMMENDATION_POLICY.hierarchy
    ]
    assert "LOW end" in policy["range_policy"]
    assert "not a confidence or prediction interval" in policy["range_policy"]


def test_the_endpoints_are_unchanged_by_b44(client, journey):
    """B4.4 consumed the engine; it did not alter any contract."""
    run = _post(client, "/api/simulation/run", {"filters": journey["scope"]})
    assert set(run) == {
        "scenario", "context", "current_plan", "scenarios", "scope", "levers", "kpis", "meta"
    }
    assert run["meta"]["phase"] == "A"

    simulated = _post(
        client,
        "/api/simulation/simulate",
        {"filters": journey["scope"], "scenario_id": "scenario-a", "discount_pct": 10},
    )
    assert simulated["treatment"] == "PR002"
    assert simulated["range_label"] == "Approved uplift range"
    assert journey["comparison"]["recommendation"] is None
    assert journey["comparison"]["recommendation_status"] == "not_defined"
