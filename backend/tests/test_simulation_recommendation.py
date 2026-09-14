"""Validation for the recommendation engine -- B4.3.

The engine turns a decision POLICY into a choice. So the tests come in three
kinds:

  * that the policy is obeyed -- the economic gate, the conservative low-end
    reading, each tie-breaker in its stated order;
  * that it refuses rather than guesses -- an unrun scenario, a missing
    required metric, a scope or provenance mismatch, and two candidates it
    genuinely cannot separate;
  * that the policy is CENTRALISED -- swapping the primary metric at runtime
    changes the outcome without a line of the algorithm changing.

Most cases use hand-built results. Real data cannot produce a tie (or a
sub-break-even ROI at an approved treatment -- B2.1 established that every
approved band clears break-even), and a decision engine has to be tested on
the inputs that make it decide, not only the ones that happen to occur.

Run with:

    ../venv/Scripts/python.exe -m pytest tests/ -q
"""

from __future__ import annotations

import copy
from dataclasses import replace

import pytest
from fastapi.testclient import TestClient

from app.main import app
from app.tpo import config, recommendation, response
from app.tpo.recommendation import RECOMMENDATION_POLICY, recommend

YEAR = 2025
SCOPE = {"year": YEAR, "channel": ["CH002"]}
OTHER_SCOPE = {"year": YEAR, "channel": ["CH001"]}

#: The seven metric keys a comparison carries.
ALL_METRICS = (
    "trade_spend", "incremental_units", "incremental_sales",
    "roi_multiple", "margin_percent", "cannibalization", "pei",
)

#: A plausible, self-consistent set of values to vary from.
DEFAULTS = {
    "trade_spend": (1_000_000.0, 1_100_000.0),
    "incremental_units": (10_000.0, 14_000.0),
    "incremental_sales": (2_000_000.0, 2_800_000.0),
    "roi_multiple": (1.4, 1.8),
    "margin_percent": (30.0, 32.0),
    "cannibalization": (None, None),
    "pei": (60.0, 70.0),
}


@pytest.fixture(scope="session")
def client():
    return TestClient(app)


def _kpi(key, value):
    available = value is not None
    return {
        "key": key,
        "label": key.replace("_", " ").title(),
        "unit": ("percent" if key.endswith("_percent") or key == "cannibalization"
                 else "multiple" if key == "roi_multiple" else "currency"),
        "value": value,
        "display_value": ("—" if value is None else f"{value:,.2f}"),
        "available": available,
        "unavailable_reason": None if available else "Not available in this selection.",
        "formula": "test fixture",
    }


def fake_simulated(scenario_id, *, scope=None, overrides=None, provenance=None, treatment="PR002", discount=10.0):
    """A /simulate payload with controllable metric values."""
    values = {**DEFAULTS, **(overrides or {})}
    ends = {
        end: {"uplift": 0.25 if end == "low" else 0.35,
              "kpis": {k: _kpi(k, values[k][0 if end == "low" else 1]) for k in ALL_METRICS}}
        for end in ("low", "high")
    }
    return {
        "scenario_id": scenario_id,
        "name": scenario_id,
        "simulated": {
            "scenario_id": scenario_id,
            "status": "simulated",
            "kind": "hypothetical",
            "treatment": treatment,
            "discount_pct": discount,
            "uplift": {"low": 0.25, "high": 0.35},
            "result": ends,
            "scope": {"filters_applied": scope if scope is not None else SCOPE},
            "provenance": provenance
            or {
                "response_rule": response.PROVENANCE,
                "kpi_engine": "app/tpo/aggregate.calculate_kpis",
                "promotion_cost_rate": config.PROMOTION_COST_RATE,
            },
        },
    }


def fake_baseline(overrides=None, scope=None):
    values = {**DEFAULTS, **(overrides or {})}
    return {
        "scenario_id": "current-plan",
        "name": "Current Plan",
        "measured": {k: _kpi(k, values[k][0]) for k in ALL_METRICS},
        "scope": scope if scope is not None else SCOPE,
    }


def _recommend(entries, scope=None, policy=RECOMMENDATION_POLICY):
    return recommend(scope if scope is not None else SCOPE, entries, policy=policy)


# --- 1-4: the economic gate and a clear winner ------------------------------


def test_a_clear_hypothetical_winner(client):
    """1, 10. Highest conservative incremental sales wins."""
    a = fake_simulated("a", overrides={"incremental_sales": (2_000_000.0, 3_000_000.0)})
    b = fake_simulated("b", overrides={"incremental_sales": (2_500_000.0, 2_600_000.0)})
    result = _recommend([fake_baseline(), a, b])

    assert result["status"] == "recommended"
    assert result["recommended_scenario_id"] == "b", (
        "b leads on the LOW end (2.5M vs 2.0M) even though a has the higher high end"
    )
    assert result["decision_path"][0]["criterion"] == "incremental_sales"
    assert result["decision_path"][0]["endpoint"] == "low"


def test_roi_low_at_or_below_breakeven_excludes_a_scenario():
    """3. The hard gate. Clearing 1.0 at the high end is not enough."""
    for roi in ((0.95, 1.4), (1.0, 1.4)):
        loser = fake_simulated("weak", overrides={"roi_multiple": roi})
        strong = fake_simulated("strong", overrides={"incremental_sales": (1.0, 2.0)})
        result = _recommend([fake_baseline(), loser, strong])

        excluded = {e["scenario_id"]: e["reason"] for e in result["excluded_scenarios"]}
        assert "weak" in excluded, roi
        assert "does not clear break-even" in excluded["weak"]
        assert result["recommended_scenario_id"] == "strong"


def test_roi_low_above_breakeven_is_eligible():
    """4. Barely above 1.0 still qualifies -- PB001's real 1.004 case."""
    thin = fake_simulated("thin", overrides={"roi_multiple": (1.004, 1.121)})
    result = _recommend([fake_baseline(), thin])
    assert result["status"] == "recommended"
    assert result["recommended_scenario_id"] == "thin"


def test_current_plan_fallback_when_nothing_is_viable():
    """2. No hypothetical is forced to win."""
    a = fake_simulated("a", overrides={"roi_multiple": (0.99, 1.05)})
    b = fake_simulated("b", overrides={"roi_multiple": (0.98, 1.05)})
    result = _recommend([fake_baseline(), a, b])

    assert result["status"] == "maintain_current_plan"
    assert result["recommended_scenario_id"] == "current-plan"
    assert "No simulated scenario satisfied" in result["reason"]
    assert len(result["excluded_scenarios"]) == 2


def test_current_plan_is_never_judged_by_the_hypothetical_roi_rule():
    """20. It is MEASURED, not a counterfactual: it has no band, and a measured
    ROI below break-even does not disqualify it as the fallback."""
    result = _recommend([fake_baseline(overrides={"roi_multiple": (0.941, 0.941)})])
    assert result["status"] == "maintain_current_plan"
    assert result["recommended_scenario_id"] == "current-plan"
    assert not any(e["scenario_id"] == "current-plan" for e in result["excluded_scenarios"])
    assert result["evidence"]["current_plan"]["roi_multiple"]["low"] == 0.941


# --- 5-9: refusals ----------------------------------------------------------


@pytest.mark.parametrize("metric", ["incremental_sales", "roi_multiple"])
def test_a_missing_required_metric_excludes_a_scenario(metric):
    """5, 6. Never substituted with zero, never inferred."""
    broken = fake_simulated("broken", overrides={metric: (None, None)})
    good = fake_simulated("good")
    result = _recommend([fake_baseline(), broken, good])

    reason = next(e["reason"] for e in result["excluded_scenarios"] if e["scenario_id"] == "broken")
    assert metric in reason
    assert "not substituted with zero" in reason
    assert result["recommended_scenario_id"] == "good"


def test_a_not_simulated_scenario_is_excluded():
    """7."""
    result = _recommend([fake_baseline(), {"scenario_id": "unrun", "name": "Unrun"}, fake_simulated("a")])
    reason = next(e["reason"] for e in result["excluded_scenarios"] if e["scenario_id"] == "unrun")
    assert "not been simulated" in reason


def test_a_scope_mismatch_is_excluded():
    """8."""
    elsewhere = fake_simulated("elsewhere", scope=OTHER_SCOPE)
    result = _recommend([fake_baseline(), elsewhere, fake_simulated("a")])
    reason = next(e["reason"] for e in result["excluded_scenarios"] if e["scenario_id"] == "elsewhere")
    assert "different scope" in reason


def test_a_provenance_mismatch_is_excluded():
    """9."""
    tampered = fake_simulated(
        "tampered",
        provenance={"response_rule": "something else", "kpi_engine": "x", "promotion_cost_rate": 0.1},
    )
    result = _recommend([fake_baseline(), tampered, fake_simulated("a")])
    reason = next(e["reason"] for e in result["excluded_scenarios"] if e["scenario_id"] == "tampered")
    assert "different economic basis" in reason


def test_no_baseline_is_insufficient_data():
    result = _recommend([fake_simulated("a")])
    assert result["status"] == "insufficient_data"
    assert result["recommended_scenario_id"] is None
    assert result["missing"] == ["measured baseline (Current Plan)"]


# --- 11-15: the tie-breakers, in order --------------------------------------


@pytest.mark.parametrize(
    "index,metric,winner_override,loser_override",
    [
        (1, "roi_multiple", (1.9, 1.95), (1.5, 1.95)),                  # 11
        (2, "incremental_units", (20_000.0, 25_000.0), (10_000.0, 25_000.0)),  # 12
        (3, "margin_percent", (40.0, 45.0), (20.0, 45.0)),              # 13
        (4, "pei", (80.0, 85.0), (50.0, 85.0)),                         # 14
        (5, "trade_spend", (500_000.0, 900_000.0), (900_000.0, 900_000.0)),  # 15 (lower wins)
    ],
)
def test_tie_breakers_apply_in_policy_order(index, metric, winner_override, loser_override):
    """11-15. Everything above the rung under test is held equal, so only that
    rung can separate the two."""
    equal_above = {
        c.metric: DEFAULTS[c.metric] for c in RECOMMENDATION_POLICY.hierarchy[:index]
    }
    winner = fake_simulated("winner", overrides={**equal_above, metric: winner_override})
    loser = fake_simulated("loser", overrides={**equal_above, metric: loser_override})

    result = _recommend([fake_baseline(), loser, winner])
    assert result["status"] == "recommended"
    assert result["recommended_scenario_id"] == "winner", f"{metric} did not separate them"

    separating = [s for s in result["decision_path"] if s.get("outcome") == "separated"]
    assert separating[-1]["criterion"] == metric


def test_trade_spend_is_a_tie_breaker_not_an_objective():
    """A cheaper scenario does NOT win when it is behind on the primary metric.
    Trade spend only decides between scenarios equivalent on everything above."""
    cheap_but_weaker = fake_simulated(
        "cheap", overrides={"trade_spend": (10.0, 20.0), "incremental_sales": (1_000_000.0, 2_000_000.0)}
    )
    dear_but_stronger = fake_simulated(
        "dear", overrides={"trade_spend": (9_000_000.0, 9_500_000.0)}
    )
    result = _recommend([fake_baseline(), cheap_but_weaker, dear_but_stronger])
    assert result["recommended_scenario_id"] == "dear"

    criterion = next(c for c in RECOMMENDATION_POLICY.hierarchy if c.metric == "trade_spend")
    assert criterion.role == "tie_breaker"
    assert criterion.direction == "lower_is_preferred"
    assert "NOT an optimisation target" in criterion.note


def test_no_clear_winner_when_the_hierarchy_is_exhausted():
    """16. Identical on every rung -- nothing is chosen arbitrarily."""
    a = fake_simulated("a")
    b = fake_simulated("b")
    result = _recommend([fake_baseline(), a, b])

    assert result["status"] == "no_clear_winner"
    assert result["recommended_scenario_id"] is None
    assert "could not separate" in result["reason"]
    assert "arbitrarily" in result["reason"]


def test_a_tie_breaker_is_skipped_when_a_candidate_lacks_the_metric():
    """A candidate is never eliminated for MISSING a tie-breaker value."""
    a = fake_simulated("a", overrides={"pei": (None, None)})
    b = fake_simulated("b", overrides={"pei": (99.0, 99.0)})
    result = _recommend([fake_baseline(), a, b])

    pei_step = next(s for s in result["decision_path"] if s["criterion"] == "pei")
    assert pei_step["outcome"] == "skipped"
    assert "missing data" in pei_step["detail"]
    assert result["status"] == "no_clear_winner"


# --- 17-19: determinism and the range ---------------------------------------


def test_repeated_execution_is_deterministic():
    """17."""
    entries = [fake_baseline(), fake_simulated("a", overrides={"incremental_sales": (3.0, 4.0)}),
               fake_simulated("b", overrides={"incremental_sales": (2.0, 9.0)})]
    results = [_recommend(copy.deepcopy(entries)) for _ in range(5)]
    assert len({r["recommended_scenario_id"] for r in results}) == 1
    assert all(r == results[0] for r in results)


def test_no_midpoint_is_used_or_produced(client):
    """18, 19. The band decides on its LOW end and is never collapsed."""
    a = fake_simulated("a", overrides={"incremental_sales": (100.0, 900.0)})   # midpoint 500
    b = fake_simulated("b", overrides={"incremental_sales": (400.0, 420.0)})   # midpoint 410
    result = _recommend([fake_baseline(), a, b])

    # On midpoints a would win (500 > 410). On the policy's LOW end b wins.
    assert result["recommended_scenario_id"] == "b"

    evidence = result["evidence"]["recommended"]["incremental_sales"]
    assert evidence["low"] == 400.0 and evidence["high"] == 420.0

    def keys(node, acc=None):
        acc = acc if acc is not None else set()
        if isinstance(node, dict):
            for k, v in node.items():
                acc.add(str(k).lower())
                keys(v, acc)
        elif isinstance(node, list):
            for i in node:
                keys(i, acc)
        return acc

    for key in keys(result):
        assert not any(w in key for w in ("midpoint", "average", "mean", "score")), key


def test_the_range_is_never_called_a_confidence_interval():
    """The policy text DENIES the range is a confidence interval, so scanning
    the serialised payload would fail on its own negation. What must not
    happen is the result CLAIMING one: no such field, and no such word in the
    explanation."""
    result = _recommend([fake_baseline(), fake_simulated("a")])

    def keys(node, acc=None):
        acc = acc if acc is not None else set()
        if isinstance(node, dict):
            for k, v in node.items():
                acc.add(str(k).lower())
                keys(v, acc)
        elif isinstance(node, list):
            for i in node:
                keys(i, acc)
        return acc

    for key in keys(result):
        assert not any(w in key for w in ("confidence", "interval", "probability")), key
    for word in ("confidence", "prediction interval", "probability"):
        assert word not in result["reason"].lower()
    assert "not a confidence or prediction interval" in result["policy"]["range_policy"]


# --- 21-24: evidence, policy exposure, honest language ----------------------


def test_unavailable_cannibalization_does_not_block_a_recommendation():
    """21. It is evidence, not a requirement, and no threshold is invented."""
    result = _recommend([fake_baseline(), fake_simulated("a")])
    assert result["status"] == "recommended"
    cannib = result["evidence"]["recommended"]["cannibalization"]
    assert cannib["available"] is False
    assert cannib["unavailable_reason"]
    assert "cannibalization" not in [c.metric for c in RECOMMENDATION_POLICY.hierarchy]


def test_available_cannibalization_is_exposed_as_evidence():
    a = fake_simulated("a", overrides={"cannibalization": (9.9, 12.1)})
    result = _recommend([fake_baseline(), a])
    cannib = result["evidence"]["recommended"]["cannibalization"]
    assert cannib["available"] is True and cannib["low"] == 9.9 and cannib["high"] == 12.1


def test_the_policy_is_exposed_in_the_result():
    """22. Not a black box: the rule that decided travels with the decision."""
    policy = _recommend([fake_baseline(), fake_simulated("a")])["policy"]
    assert policy["primary_metric"] == "incremental_sales"
    assert policy["primary_endpoint"] == "low"
    assert policy["version"] == RECOMMENDATION_POLICY.version
    assert [c["metric"] for c in policy["hierarchy"]] == [
        c.metric for c in RECOMMENDATION_POLICY.hierarchy
    ]
    assert policy["economic_constraint"]["must_be"] == "above_breakeven"
    assert policy["required_metrics"] == ["incremental_sales", "roi_multiple"]
    assert "LOW end" in policy["range_policy"]


def test_the_explanation_uses_real_evidence():
    """23. Every number quoted is the winner's own."""
    a = fake_simulated("a", overrides={"incremental_sales": (7_777_777.0, 8_000_000.0),
                                       "roi_multiple": (1.333, 1.444)})
    result = _recommend([fake_baseline(overrides={"incremental_sales": (1.0, 1.0)}), a])
    reason = result["reason"]
    evidence = result["evidence"]["recommended"]

    assert evidence["incremental_sales"]["display_low"] in reason
    assert evidence["roi_multiple"]["display_low"] in reason
    assert evidence["roi_multiple"]["display_high"] in reason
    assert "low end" in reason


def test_the_explanation_makes_no_overclaim():
    """24. No language the data cannot support."""
    for entries in (
        [fake_baseline(), fake_simulated("a")],
        [fake_baseline(), fake_simulated("a", overrides={"incremental_sales": (9.0, 9.0)})],
        [fake_baseline(), fake_simulated("a", overrides={"roi_multiple": (0.99, 1.01)})],
    ):
        reason = _recommend(entries)["reason"].lower()
        for word in ("guaranteed", "optimal", "perfect", "best possible", "will increase", "certain"):
            assert word not in reason, f"overclaim: {word}"


def test_no_ml_or_scoring_language_anywhere():
    result = _recommend([fake_baseline(), fake_simulated("a")])
    flat = str(result).lower()
    for word in ("machine learning", "embedding", "neural", "predicted", "forecast"):
        assert word not in flat
    assert "No model, no score, no weights" in result["provenance"]["method"]


# --- 25: the policy is centralised ------------------------------------------


def test_changing_the_policy_changes_the_outcome_without_touching_the_algorithm():
    """25. THE centralisation proof.

    The same two scenarios, the same engine, one different POLICY OBJECT: the
    winner follows the policy. If the hierarchy were hardcoded anywhere in
    `recommend()` this could not pass.

    The shipped policy is not modified -- a replacement is built and passed in.
    """
    strong_sales = fake_simulated(
        "sales-leader", overrides={"incremental_sales": (9_000_000.0, 9_500_000.0), "roi_multiple": (1.1, 1.2)}
    )
    strong_roi = fake_simulated(
        "roi-leader", overrides={"incremental_sales": (1_000_000.0, 1_200_000.0), "roi_multiple": (1.95, 1.99)}
    )
    entries = [fake_baseline(overrides={"incremental_sales": (1.0, 1.0)}), strong_sales, strong_roi]

    assert _recommend(entries)["recommended_scenario_id"] == "sales-leader"

    roi_first = replace(
        RECOMMENDATION_POLICY,
        version="test-roi-primary",
        hierarchy=(
            replace(RECOMMENDATION_POLICY.hierarchy[1], role="primary"),
            *RECOMMENDATION_POLICY.hierarchy[:1],
            *RECOMMENDATION_POLICY.hierarchy[2:],
        ),
    )
    switched = _recommend(entries, policy=roi_first)
    assert switched["recommended_scenario_id"] == "roi-leader"
    assert switched["policy"]["primary_metric"] == "roi_multiple"

    # The shipped policy is untouched by the experiment.
    assert RECOMMENDATION_POLICY.primary.metric == "incremental_sales"


def test_the_policy_lives_in_exactly_one_place():
    """No preference between scenarios is encoded anywhere else."""
    from pathlib import Path

    root = Path(__file__).resolve().parents[1] / "app"
    owner = root / "tpo" / "recommendation.py"
    for path in root.rglob("*.py"):
        if path == owner:
            continue
        text = path.read_text(encoding="utf-8")
        assert "higher_is_preferred" not in text, f"{path.name} encodes a preference"
        assert "RECOMMENDATION_POLICY = " not in text, f"{path.name} defines a second policy"


# --- the endpoint -----------------------------------------------------------


def test_the_endpoint_answers(client):
    """The live path, over real simulated results."""
    run = client.post("/api/simulation/run", json={"filters": SCOPE}).json()
    entries = [
        {
            "scenario_id": "current-plan",
            "name": "Current Plan",
            "measured": run["kpis"],
            "scope": run["scope"]["filters_applied"],
        }
    ]
    for scenario_id, discount in (("a", 10), ("b", 15), ("c", 20)):
        simulated = client.post(
            "/api/simulation/simulate",
            json={"filters": SCOPE, "scenario_id": scenario_id, "discount_pct": discount},
        ).json()
        entries.append({"scenario_id": scenario_id, "name": scenario_id, "simulated": simulated})

    result = client.post("/api/simulation/recommend", json={"filters": SCOPE, "entries": entries})
    assert result.status_code == 200
    payload = result.json()
    assert payload["status"] == "recommended"
    assert payload["recommended_scenario_id"] in {"a", "b", "c"}
    assert len(payload["eligible_scenarios"]) == 3
    assert payload["policy"]["primary_metric"] == "incremental_sales"


def test_the_endpoint_does_not_recompute_kpis(client):
    """Recommendation consumes results; it must not perturb the simulation."""
    body = {"filters": SCOPE, "scenario_id": "optimized-plan", "discount_pct": 10}
    before = client.post("/api/simulation/simulate", json=body).json()

    run = client.post("/api/simulation/run", json={"filters": SCOPE}).json()
    client.post(
        "/api/simulation/recommend",
        json={
            "filters": SCOPE,
            "entries": [
                {"scenario_id": "current-plan", "name": "Current Plan",
                 "measured": run["kpis"], "scope": run["scope"]["filters_applied"]},
                {"scenario_id": "optimized-plan", "name": "Optimized", "simulated": before},
            ],
        },
    )
    assert client.post("/api/simulation/simulate", json=body).json() == before


@pytest.mark.parametrize(
    "body",
    [
        {"filters": SCOPE, "entries": []},
        {"filters": {"month": 13}, "entries": [{"scenario_id": "x"}]},
        {"filters": SCOPE, "entries": [{"scenario_id": "x"}], "unknown": 1},
    ],
)
def test_malformed_recommend_requests_are_rejected(client, body):
    assert client.post("/api/simulation/recommend", json=body).status_code == 422


def test_tolerances_are_derived_from_the_engines_precision():
    """Not arbitrary: half a rounding step of what aggregate.py actually emits."""
    tolerance = RECOMMENDATION_POLICY.tolerance
    assert tolerance["roi_multiple"] == 0.005        # engine rounds the ROI multiple to 2dp
    assert tolerance["margin_percent"] == 0.05       # 1dp
    assert tolerance["incremental_sales"] == 0.05    # 1dp
    assert tolerance["incremental_units"] == 0.5     # 0dp
    assert tolerance["pei"] == 0.5                   # 0dp
    assert recommendation.RECOMMENDATION_POLICY.tolerance_for("unknown_metric") == 0.0
