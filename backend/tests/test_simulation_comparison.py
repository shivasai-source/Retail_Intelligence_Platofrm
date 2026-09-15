"""Validation for the scenario comparison contract -- B4.1.

The contract's job is to line up results that are genuinely comparable and to
refuse the ones that are not. So the tests are mostly about refusals:

  * a different scope is refused, because a result over CH002 says nothing
    about CH003;
  * a different economic basis is refused, because two numbers produced by
    different rules are not on the same footing;
  * an unrun scenario is EXCLUDED, never counted as zero;
  * an unavailable KPI stays unavailable, never becomes a zero somebody could
    rank on.

And one refusal that is the whole point of the phase: NO RECOMMENDATION. This
project defines no business objective, so nothing here picks a winner.

Run with:

    ../venv/Scripts/python.exe -m pytest tests/ -q
"""

from __future__ import annotations

import copy
import json

import pytest
from fastapi.testclient import TestClient

from app.main import app
from app.tpo import comparison, config, response

YEAR = 2025
SCOPE = {"year": YEAR, "channel": ["CH002"], "promotion": ["PBDU25"]}
OTHER_SCOPE = {"year": YEAR, "channel": ["CH001"], "promotion": ["PBDI25"]}
#: A scope whose cannibalization the engine genuinely cannot measure: one SKU
#: in one channel with no Brand Form neighbour trading there that week. An
#: Offer filter alone is NOT one -- that only looked unavailable while the
#: metric was handed a row set holding no non-promoted row at all.
NO_CANNIBALIZATION_EVIDENCE = {
    "year": YEAR, "channel": ["CH003"], "promotion": ["PBDU25"], "product": ["P13-240ct"],
}

METRIC_KEYS = {
    "trade_spend", "incremental_units", "incremental_sales",
    "roi_multiple", "margin_percent", "cannibalization", "pei",
}


@pytest.fixture(scope="session")
def client():
    return TestClient(app)


@pytest.fixture(scope="session")
def baseline(client):
    run = client.post("/api/simulation/run", json={"filters": SCOPE}).json()
    return {
        "scenario_id": "current-plan",
        "name": "Current Plan",
        "measured": run["kpis"],
        "scope": run["scope"]["filters_applied"],
    }


def _simulate(client, discount_pct, scenario_id="optimized-plan", filters=None):
    payload = client.post(
        "/api/simulation/simulate",
        json={"filters": filters or SCOPE, "scenario_id": scenario_id, "discount_pct": discount_pct},
    ).json()
    return {"scenario_id": scenario_id, "name": scenario_id, "simulated": payload}


@pytest.fixture(scope="session")
def optimized(client):
    return _simulate(client, 10, "optimized-plan")


@pytest.fixture(scope="session")
def aggressive(client):
    return _simulate(client, 15, "aggressive-growth")


def _compare(client, entries, filters=None, expect=200):
    r = client.post("/api/simulation/compare", json={"filters": filters or SCOPE, "entries": entries})
    assert r.status_code == expect, r.text
    return r.json()


def _metric(payload, key):
    return next(m for m in payload["metrics"] if m["key"] == key)


def _all_keys(node) -> set[str]:
    """Every dict key in the payload, recursively, lowercased.

    Assertions about what the contract must NOT produce are made against keys
    rather than the serialised text, because the payload deliberately explains
    in prose why it does not rank and why it does not use a midpoint.
    """
    keys: set[str] = set()
    if isinstance(node, dict):
        for key, value in node.items():
            keys.add(str(key).lower())
            keys |= _all_keys(value)
    elif isinstance(node, list):
        for item in node:
            keys |= _all_keys(item)
    return keys


# --- 1-5: what is comparable -----------------------------------------------


def test_same_scope_is_comparable(client, baseline, optimized):
    """1, 3, 4. A measured baseline and a simulated scenario over one scope."""
    payload = _compare(client, [baseline, optimized])
    assert payload["comparison_status"] == "comparable"

    current, scenario = payload["scenarios"]
    assert current["status"] == "measured" and current["comparable"] is True and current["is_baseline"]
    assert scenario["status"] == "simulated" and scenario["comparable"] is True
    assert scenario["treatment"] == "PR002"


def test_a_different_scope_is_not_comparable(client, baseline, aggressive):
    """2, 17. A result over other rows is excluded, with both scopes named."""
    elsewhere = _simulate(client, 15, "aggressive-growth", filters=OTHER_SCOPE)
    payload = _compare(client, [baseline, elsewhere])

    excluded = payload["scenarios"][1]
    assert excluded["comparable"] is False
    assert excluded["status"] == "excluded"
    assert "different scope" in excluded["exclusion_reason"]
    assert payload["comparison_status"] == "nothing_to_compare"
    assert payload["metrics"] == []


def test_a_not_simulated_scenario_is_excluded_never_zero(client, baseline, optimized):
    """5. Excluded WITH the reason -- and it appears nowhere in the metrics."""
    unrun = {"scenario_id": "scenario-1", "name": "Scenario 2"}
    payload = _compare(client, [baseline, optimized, unrun])

    entry = payload["scenarios"][2]
    assert entry["status"] == "excluded" and entry["comparable"] is False
    assert "not been simulated" in entry["exclusion_reason"]
    assert "counted as zero" in entry["exclusion_reason"]

    for metric in payload["metrics"]:
        assert all(s["scenario_id"] != "scenario-1" for s in metric["scenarios"])


def test_a_comparison_without_a_baseline_says_so(client, optimized):
    payload = _compare(client, [optimized])
    assert payload["comparison_status"] == "no_baseline"
    assert payload["metrics"] == []


def test_the_measured_baseline_is_not_treated_as_a_hypothetical(client, baseline, optimized):
    """The Current Plan is the thing others are measured against, and it never
    appears as one of the scenarios being compared."""
    payload = _compare(client, [baseline, optimized])
    for metric in payload["metrics"]:
        assert metric["baseline"] is not None
        assert all(s["scenario_id"] != "current-plan" for s in metric["scenarios"])


# --- 6-7: the range ---------------------------------------------------------


def test_low_and_high_are_both_preserved(client, baseline, optimized):
    """6."""
    payload = _compare(client, [baseline, optimized])
    for key in ("trade_spend", "incremental_sales", "roi_multiple"):
        scenario = _metric(payload, key)["scenarios"][0]
        assert scenario["low"]["value"] is not None
        assert scenario["high"]["value"] is not None
        assert scenario["low"]["value"] != scenario["high"]["value"]
        assert scenario["delta_low"]["absolute"] != scenario["delta_high"]["absolute"]


def test_no_midpoint_is_generated(client, baseline, optimized):
    """7. THE refusal that keeps the approved band intact.

    Every float in the payload is checked against the midpoint of the band it
    could have come from -- which is what a smuggled point estimate would look
    like.
    """
    payload = _compare(client, [baseline, optimized])

    # KEYS, not prose. The requirements list legitimately DISCUSSES midpoints --
    # to explain why collapsing a band into one would be wrong -- so scanning
    # the serialised text would fail on its own explanation. What must not
    # exist is a midpoint FIELD.
    for key in _all_keys(payload):
        assert not any(w in key for w in ("midpoint", "mid_point", "average", "mean")), key

    for metric in payload["metrics"]:
        for scenario in metric["scenarios"]:
            low, high = scenario["low"]["value"], scenario["high"]["value"]
            if low is None or high is None or low == high:
                continue
            midpoint = (low + high) / 2
            for field, value in scenario["low"].items():
                if isinstance(value, float):
                    assert value != midpoint, f"{metric['key']}.{field} is the band midpoint"


def test_the_range_is_never_called_a_confidence_interval(client, baseline, optimized):
    payload = _compare(client, [baseline, optimized])
    assert payload["range_label"] == "Approved uplift range"
    flat = json.dumps(payload).lower()
    for word in ("confidence", "prediction interval", "probability", "significance"):
        assert word not in flat


# --- 8, 15: unavailable KPIs ------------------------------------------------


def test_an_unavailable_kpi_stays_unavailable(client):
    """8, 15. A KPI the engine cannot measure keeps its reason and gets a null
    delta -- never a zero.

    Built on its own scope rather than the module's: cannibalization is
    measurable for an Offer-filtered scope now that the metric is handed the
    Brand-Form and baseline-widened rows it asks for, so an unavailable case
    has to be one where the EVIDENCE is genuinely absent.
    """
    run = client.post(
        "/api/simulation/run", json={"filters": NO_CANNIBALIZATION_EVIDENCE}
    ).json()
    base = {
        "scenario_id": "current-plan", "name": "Current Plan",
        "measured": run["kpis"], "scope": run["scope"]["filters_applied"],
    }
    scenario = _simulate(client, 10, filters=NO_CANNIBALIZATION_EVIDENCE)
    metric = _metric(
        _compare(client, [base, scenario], filters=NO_CANNIBALIZATION_EVIDENCE),
        "cannibalization",
    )

    assert metric["baseline"]["available"] is False
    assert metric["baseline"]["value"] is None
    scenario = metric["scenarios"][0]
    assert scenario["low"]["available"] is False
    assert scenario["low"]["value"] is None
    assert scenario["low"]["unavailable_reason"]
    assert scenario["delta_low"] == {"absolute": None, "display": None, "percent_change": None}
    assert scenario["direction_low"] is None


def test_no_delta_is_fabricated_when_a_side_is_missing():
    """A null delta, not a zero. A zero claims the two are equal."""
    rule = comparison.METRIC_RULES["roi_multiple"]
    assert comparison._delta(rule, "multiple", None, 1.1, "INR")["absolute"] is None
    assert comparison._delta(rule, "multiple", 1.1, None, "INR")["absolute"] is None


# --- 9-14: delta semantics per metric ---------------------------------------


@pytest.mark.parametrize(
    "key,delta_type,percent_change_allowed",
    [
        ("roi_multiple", "absolute", False),             # 9 -- a difference in multiples
        ("margin_percent", "percentage_point", False),   # 10
        ("incremental_sales", "absolute", True),         # 11
        ("incremental_units", "absolute", True),         # 12
        ("trade_spend", "absolute", True),               # 13
        ("pei", "absolute", False),                      # 14
        ("cannibalization", "percentage_point", False),
    ],
)
def test_metric_delta_semantics(client, baseline, optimized, key, delta_type, percent_change_allowed):
    """9-14. Each metric's delta is expressed the only way that means anything
    for that metric, and says why."""
    metric = _metric(_compare(client, [baseline, optimized]), key)
    assert metric["delta_type"] == delta_type
    assert metric["supports_percent_change"] is percent_change_allowed
    assert metric["delta_rationale"]

    scenario = metric["scenarios"][0]
    if scenario["low"]["value"] is None:
        return
    if not percent_change_allowed:
        assert scenario["delta_low"]["percent_change"] is None, (
            f"{key} is a rate or an index; a percent change of it is misleading"
        )
    assert scenario["delta_low"]["absolute"] == pytest.approx(
        scenario["low"]["value"] - metric["baseline"]["value"]
    )


@pytest.mark.parametrize("key", sorted(METRIC_KEYS))
def test_every_metric_is_present_and_labelled_from_the_kpi_spec(client, baseline, optimized, key):
    metric = _metric(_compare(client, [baseline, optimized]), key)
    assert metric["label"] and metric["unit"]
    assert {m["key"] for m in _compare(client, [baseline, optimized])["metrics"]} == METRIC_KEYS


def test_roi_delta_is_a_difference_in_multiples_not_a_ratio(client, baseline, optimized):
    """9, spelled out. The baseline ROI here is BELOW BREAK-EVEN, which is
    exactly the case where a percent change of the multiple would mislead."""
    metric = _metric(_compare(client, [baseline, optimized]), "roi_multiple")
    base, low = metric["baseline"]["value"], metric["scenarios"][0]["low"]["value"]
    assert metric["scenarios"][0]["delta_low"]["absolute"] == pytest.approx(low - base)
    # A signed bare difference ("+0.5"), never a percent sign or a unit sign.
    display = metric["scenarios"][0]["delta_low"]["display"]
    assert "%" not in display and not display.endswith("x") and display[0] in "+-0"
    assert metric["scenarios"][0]["delta_low"]["percent_change"] is None


def test_trade_spend_direction_is_stated_but_not_judged(client, baseline, optimized):
    """11 of the brief. Higher or lower is a fact; better or worse is not
    decided in B4.1."""
    metric = _metric(_compare(client, [baseline, optimized]), "trade_spend")
    scenario = metric["scenarios"][0]
    assert scenario["direction_low"] in ("higher", "lower", "unchanged")
    assert metric["preference"] is None
    assert "business-policy" in metric["preference_reason"]
    # The Insights Hub's display convention is reported, and labelled as one.
    assert metric["lower_is_better_display"] is True


# --- 16: provenance ---------------------------------------------------------


def test_a_provenance_mismatch_is_not_comparable(client, baseline, optimized):
    """16. Same scope, different economic basis -- refused."""
    for field, bad in (
        ("response_rule", "Some other rule"),
        ("kpi_engine", "somewhere/else"),
        ("promotion_cost_rate", 0.05),
    ):
        tampered = copy.deepcopy(optimized)
        tampered["simulated"]["provenance"][field] = bad
        payload = _compare(client, [baseline, tampered])

        excluded = payload["scenarios"][1]
        assert excluded["comparable"] is False, field
        assert "different economic basis" in excluded["exclusion_reason"]


def test_the_expected_basis_is_read_from_the_modules_that_own_it(client, baseline, optimized):
    """The contract does not write the basis down a second time."""
    payload = _compare(client, [baseline, optimized])
    assert payload["economic_basis"] == {
        "response_rule": response.PROVENANCE,
        "kpi_engine": "app/tpo/aggregate.calculate_kpis",
        "promotion_cost_rate": config.PROMOTION_COST_RATE,
    }


def test_a_result_with_no_scope_is_refused(client, baseline, optimized):
    stripped = copy.deepcopy(optimized)
    stripped["simulated"]["scope"] = {}
    payload = _compare(client, [baseline, stripped])
    assert payload["scenarios"][1]["comparable"] is False


# --- 18: no recommendation --------------------------------------------------


def test_no_recommendation_is_generated(client, baseline, optimized, aggressive):
    """18. THE boundary of this phase."""
    payload = _compare(client, [baseline, optimized, aggressive])

    assert payload["recommendation"] is None
    assert payload["recommendation_status"] == "not_defined"
    assert "business-policy decision" in payload["recommendation_reason"]

    # Again KEYS, not prose: "score" is PEI's unit and the requirements list
    # explains why weights are missing. What must not exist is a rank, a score
    # or a winner as DATA.
    for key in _all_keys(payload):
        assert not any(w in key for w in ("best", "winner", "rank", "score", "weight")), key
    assert all(s.get("is_baseline") is not None for s in payload["scenarios"])


def test_no_metric_declares_a_preference(client, baseline, optimized):
    """No weights, no objective, no "higher is better" as a decision rule."""
    for metric in _compare(client, [baseline, optimized])["metrics"]:
        assert metric["preference"] is None
        assert metric["preference_reason"]


def test_the_recommendation_requirements_are_recorded(client, baseline, optimized):
    """What B4.3 would need, with the gaps named rather than defaulted."""
    payload = _compare(client, [baseline, optimized])
    requirements = {r["requirement"]: r for r in payload["recommendation_requires"]}

    assert requirements["A business objective"]["satisfied"] is False
    assert requirements["Metric weights or a decision rule"]["satisfied"] is False
    assert requirements["Constraints"]["satisfied"] is False
    assert requirements["A rule for comparing RANGES rather than points"]["satisfied"] is False
    assert requirements["Candidate scenarios"]["satisfied"] is True
    assert requirements["A comparable scope"]["satisfied"] is True


# --- the endpoint's edges ---------------------------------------------------


@pytest.mark.parametrize(
    "body",
    [
        {"filters": SCOPE, "entries": []},
        {"filters": SCOPE, "entries": [{"name": "no id"}]},
        {"filters": {"month": 13}, "entries": [{"scenario_id": "x"}]},
        {"filters": SCOPE, "entries": [{"scenario_id": "x"}], "unknown": 1},
    ],
)
def test_malformed_comparison_requests_are_rejected(client, body):
    assert client.post("/api/simulation/compare", json=body).status_code == 422


def test_comparing_does_not_perturb_the_simulation_endpoints(client, baseline, optimized):
    """The contract reads results; it runs nothing and holds no state."""
    before = client.post(
        "/api/simulation/simulate",
        json={"filters": SCOPE, "scenario_id": "optimized-plan", "discount_pct": 10},
    ).json()
    _compare(client, [baseline, optimized])
    after = client.post(
        "/api/simulation/simulate",
        json={"filters": SCOPE, "scenario_id": "optimized-plan", "discount_pct": 10},
    ).json()
    assert after == before
