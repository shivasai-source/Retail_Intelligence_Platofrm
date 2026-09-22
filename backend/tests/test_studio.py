"""Simulation Studio -- three levers, one window.

What these tests hold the studio to:

  * IT COMPUTES NO KPI. Revenue, Trade Spend, Incremental Sales and ROI on
    every payload are the engine's own functions over the window rows, and
    the ROI on the payload is exactly IS / TS of the same payload.
  * THE LEVERS DO WHAT THEY SAY. Discount moves lift and price; days scale the
    window; the budget buys coverage and nothing else.
  * THE WINDOW RECONCILES. The weekly rows sum to the window.
  * IT REFUSES RATHER THAN INVENTS. A depth outside the evidence, a window the
    data cannot support and a scope with nothing to base a scenario on are all
    422s with a reason, never a zeroed result.
  * THE MODEL SAYS WHERE IT CAME FROM. Provenance, evidence counts and the
    fade / dip findings travel on every response.

Run with:

    ../venv/Scripts/python.exe -m pytest tests/test_studio.py -q
"""

from __future__ import annotations

import inspect

import pytest
from fastapi.testclient import TestClient

from app.main import app
from app.routers.simulation import SimulationFilters
from app.tpo import aggregate as A
from app.tpo import studio
from app.tpo.filters import DIMENSIONS, FilterState, baseline_rows_for

SCOPE = {"year": 2025, "channel": ["CH002"]}


@pytest.fixture(scope="module")
def client():
    return TestClient(app)


def _post(client, path, body, expect=200):
    r = client.post(path, json=body)
    assert r.status_code == expect, r.text
    return r.json()


@pytest.fixture(scope="module")
def scope(client):
    return _post(client, "/api/simulation/scope", {"filters": SCOPE})


def _simulate(client, discount, spend, days, filters=SCOPE, expect=200):
    return _post(client, "/api/simulation/simulate",
                 {"filters": filters, "discount_pct": discount, "trade_spend": spend, "days": days},
                 expect)


@pytest.fixture(scope="module")
def default_run(client, scope):
    L = scope["levers"]
    return _simulate(client, L["discount_pct"]["default"], L["trade_spend"]["default"], L["days"]["default"])


# --- the contract -----------------------------------------------------------


def test_the_filter_model_is_exactly_the_projects_dimensions():
    assert set(SimulationFilters.model_fields) == set(DIMENSIONS)


def test_the_baseline_rule_is_the_engines():
    """The studio re-bases on exactly the number `aggregate._volume` measures
    against, for every (product, channel) the engine reports one for."""
    rows = baseline_rows_for(FilterState.build(**{"year": 2025, "channel": ["CH002"]}))
    ours = studio._baselines(rows)
    for p in A._volume(rows).products:
        assert ours[(p.product_id, p.channel_id)] == pytest.approx(p.baseline_average)


def test_the_studio_defines_no_kpi_of_its_own():
    source = inspect.getsource(studio)
    for forbidden in ("incremental_sales /", "/ trade_spend", "roi_multiple(", "safe_divide("):
        assert forbidden not in source, forbidden
    for required in ("A.calculate_trade_spend(", "A.calculate_incremental_sales(",
                     "A.calculate_roi(", "A.calculate_margin("):
        assert required in source, required


def test_roi_on_the_payload_is_incremental_sales_over_trade_spend(default_run):
    for plan in ("current_plan", "scenario"):
        block = default_run[plan]
        expected = A.roi_multiple(block["incremental_sales"]["value"], block["trade_spend"]["value"])
        assert block["roi"]["value"] == pytest.approx(expected, abs=0.011)


# --- scope ------------------------------------------------------------------


def test_scope_carries_levers_with_defaults_inside_their_ranges(scope):
    for key in ("discount_pct", "days", "trade_spend"):
        lever = scope["levers"][key]
        assert lever["min"] <= lever["default"] <= lever["max"], key
        assert lever["step"] > 0
    assert scope["levers"]["days"]["max"] == studio.MAX_DAYS
    assert scope["levers"]["discount_pct"]["max"] == scope["model"]["depth_domain_pct"]["max"]


def test_scope_states_the_models_provenance_and_evidence(scope):
    model = scope["model"]
    assert model["provenance"] in (studio.PROVENANCE_FITTED, studio.PROVENANCE_DATASET,
                                   studio.PROVENANCE_RULES)
    assert model["n_events"] > 0
    assert model["notes"]
    assert "fade" in model and "post_promotion_dip" in model
    # The band comes from the evidence: low below, high above the fit.
    assert model["residual_band"]["low"] < 0 < model["residual_band"]["high"]


def test_the_default_levers_are_the_observed_plan(scope):
    observed = scope["observed_plan"]
    assert scope["levers"]["discount_pct"]["default"] == pytest.approx(observed["discount_pct"], abs=0.26)
    assert scope["levers"]["days"]["default"] == observed["days"]


# --- the levers -------------------------------------------------------------


def test_at_the_defaults_the_scenario_is_the_current_plan(default_run):
    """Starting position: nothing moved, nothing changes."""
    assert default_run["deltas"]["revenue"]["direction"] == "unchanged"
    assert default_run["deltas"]["roi"]["direction"] == "unchanged"
    assert default_run["scenario"]["revenue"]["value"] == default_run["current_plan"]["revenue"]["value"]
    assert default_run["levers"]["trade_spend"]["coverage"] == 1.0


def test_no_discount_is_no_promotion(client, scope):
    r = _simulate(client, 0, scope["levers"]["trade_spend"]["max"], 14)
    assert r["scenario"]["revenue"]["value"] == r["baseline"]["revenue"]["value"]
    assert r["scenario"]["trade_spend"]["value"] == 0
    assert r["scenario"]["roi"]["value"] is None
    assert r["deltas"]["roi"]["status"] == "not_applicable"
    assert r["lift"]["mid"] == 0


def test_a_deeper_discount_lifts_volume_and_costs_more(client, scope):
    ceiling = scope["levers"]["trade_spend"]["max"]
    shallow = _simulate(client, 5, ceiling, 14)
    deep = _simulate(client, 20, ceiling, 14)
    assert deep["lift"]["mid"] > shallow["lift"]["mid"]
    assert deep["scenario"]["units"]["value"] > shallow["scenario"]["units"]["value"]
    assert deep["scenario"]["trade_spend"]["value"] > shallow["scenario"]["trade_spend"]["value"]


def test_the_band_brackets_the_estimate(client, scope):
    r = _simulate(client, 15, scope["levers"]["trade_spend"]["max"], 21)
    band = r["scenario"]["band"]
    assert band["revenue"]["low"]["value"] <= r["scenario"]["revenue"]["value"] <= band["revenue"]["high"]["value"]
    assert band["roi"]["low"]["value"] <= r["scenario"]["roi"]["value"] <= band["roi"]["high"]["value"]
    assert r["lift"]["low"] < r["lift"]["mid"] < r["lift"]["high"]


def test_days_scale_the_window(client, scope):
    ceiling = scope["levers"]["trade_spend"]["max"]
    one = _simulate(client, 10, ceiling, 7)
    two = _simulate(client, 10, ceiling, 14)
    assert one["window"]["weeks"] == 1 and two["window"]["weeks"] == 2
    assert len(one["weekly"]) == 1 and len(two["weekly"]) == 2
    # Lift is flat in this scope (no fade detected), so two weeks is twice one.
    if not one["model"]["fade"]["detected"]:
        assert two["scenario"]["revenue"]["value"] == pytest.approx(2 * one["scenario"]["revenue"]["value"], rel=1e-6)
        assert two["scenario"]["roi"]["value"] == one["scenario"]["roi"]["value"]


def test_a_partial_week_is_pro_rated_and_said(client, scope):
    ceiling = scope["levers"]["trade_spend"]["max"]
    ten = _simulate(client, 10, ceiling, 10)
    seven = _simulate(client, 10, ceiling, 7)
    assert ten["window"]["weeks"] == 2
    assert ten["window"]["partial_week_fraction"] == pytest.approx(3 / 7, abs=1e-3)
    assert seven["window"]["partial_week_fraction"] is None
    assert ten["weekly"][1]["days"] == 3.0
    assert ten["scenario"]["revenue"]["value"] == pytest.approx(
        seven["scenario"]["revenue"]["value"] * 10 / 7, rel=1e-6)


def test_the_weekly_rows_sum_to_the_window(client, scope):
    r = _simulate(client, 15, scope["levers"]["trade_spend"]["max"], 24)
    for plan, key in (("scenario", "scenario_revenue"), ("current_plan", "current_revenue")):
        total = sum(w[key]["value"] for w in r["weekly"])
        assert total == pytest.approx(r[plan]["revenue"]["value"], abs=0.5 * len(r["weekly"]))
    assert sum(w["scenario_trade_spend"]["value"] for w in r["weekly"]) == pytest.approx(
        r["scenario"]["trade_spend"]["value"], abs=0.5 * len(r["weekly"]))


def test_the_budget_buys_coverage(client, scope):
    full = _simulate(client, 15, scope["levers"]["trade_spend"]["max"], 14)
    full_cost = full["levers"]["trade_spend"]["full_coverage_cost"]["value"]
    assert not full["levers"]["trade_spend"]["binding"]
    assert full["levers"]["trade_spend"]["unspent"]["value"] > 0

    half = _simulate(client, 15, full_cost / 2, 14)
    spend = half["levers"]["trade_spend"]
    assert spend["binding"] is True
    assert spend["coverage"] == pytest.approx(0.5, abs=1e-3)
    assert spend["consumed"]["value"] == pytest.approx(full_cost / 2, rel=1e-3)
    assert spend["unspent"]["value"] == 0
    # Half the scope promoted: half the spend, half the incremental sales,
    # the same ROI -- a budget scales a promotion, it does not change its economics.
    assert half["scenario"]["trade_spend"]["value"] == pytest.approx(full["scenario"]["trade_spend"]["value"] / 2, rel=1e-3)
    assert half["scenario"]["incremental_sales"]["value"] == pytest.approx(full["scenario"]["incremental_sales"]["value"] / 2, rel=1e-3)
    assert half["scenario"]["roi"]["value"] == pytest.approx(full["scenario"]["roi"]["value"], abs=0.011)
    assert half["scenario"]["revenue"]["value"] < full["scenario"]["revenue"]["value"]
    assert half["scenario"]["revenue"]["value"] > half["baseline"]["revenue"]["value"]


def test_a_zero_budget_funds_nothing(client):
    r = _simulate(client, 15, 0, 14)
    assert r["levers"]["trade_spend"]["coverage"] == 0
    assert r["scenario"]["revenue"]["value"] == r["baseline"]["revenue"]["value"]
    assert r["scenario"]["trade_spend"]["value"] == 0


def test_the_roi_status_flips_with_the_depth(client, scope):
    """ROI is a multiple: 1.00 is break-even. A deep enough discount in this
    scope pushes the scenario below it and the status says so."""
    ceiling = scope["levers"]["trade_spend"]["max"]
    statuses = {d: _simulate(client, d, ceiling, 14)["deltas"]["roi"]["status"]
                for d in (5, scope["levers"]["discount_pct"]["max"])}
    assert statuses[5] == "profitable"
    assert statuses[scope["levers"]["discount_pct"]["max"]] == "loss_making"


def test_deltas_are_against_the_current_plan_over_the_same_window(client, scope):
    r = _simulate(client, 5, scope["levers"]["trade_spend"]["max"], 14)
    assert r["current_plan"]["days"] == r["scenario"]["days"] == 14
    diff = r["scenario"]["revenue"]["value"] - r["current_plan"]["revenue"]["value"]
    assert r["deltas"]["revenue"]["absolute"]["value"] == pytest.approx(diff, abs=0.2)  # both sides rounded to 1 dp
    assert r["deltas"]["revenue"]["direction"] == ("up" if diff > 0 else "down")
    roi_diff = r["scenario"]["roi"]["value"] - r["current_plan"]["roi"]["value"]
    assert r["deltas"]["roi"]["absolute"] == pytest.approx(roi_diff, abs=0.011)


# --- refusals ---------------------------------------------------------------


def test_a_depth_beyond_the_evidence_is_refused_with_the_domain(client, scope):
    too_deep = scope["levers"]["discount_pct"]["max"] + 1
    detail = _simulate(client, too_deep, 1e6, 7, expect=422)["detail"]
    assert "discount_pct" in detail and str(scope["model"]["depth_observed_pct"]["max"]) in detail


@pytest.mark.parametrize("days", [0, studio.MAX_DAYS + 1])
def test_a_window_outside_the_data_is_refused(client, days):
    _simulate(client, 10, 1e6, days, expect=422)


def test_an_unknown_lever_is_refused_by_name(client):
    r = client.post("/api/simulation/simulate", json={
        "filters": SCOPE, "discount_pct": 10, "trade_spend": 1e6, "days": 7, "incentive_pct": 3,
    })
    assert r.status_code == 422
    assert "incentive_pct" in r.text


def test_a_scope_with_nothing_to_base_on_is_refused(client):
    detail = _post(client, "/api/simulation/scope",
                   {"filters": {"year": 2025, "channel": ["CH002"], "region": ["Nowhere"]}},
                   expect=422)["detail"]
    assert "Nothing to simulate" in detail


# --- honesty ----------------------------------------------------------------


def test_the_result_is_deterministic(client, scope):
    a = _simulate(client, 12.5, scope["levers"]["trade_spend"]["default"], 16)
    b = _simulate(client, 12.5, scope["levers"]["trade_spend"]["default"], 16)
    assert a == b


def test_no_score_confidence_or_forecast_is_claimed(default_run):
    import json
    text = json.dumps(default_run).lower()
    for claim in ("confidence score", "probability", "forecast", "ai generated", "machine learning"):
        assert claim not in text, claim
    # The one place the word appears is the disclaimer that the band is NOT one.
    assert text.count("confidence") == text.count("not an assumed confidence interval")


def test_the_fade_and_dip_are_findings_not_assumptions(scope):
    model = scope["model"]
    if not model["fade"]["detected"]:
        assert model["fade"]["per_week"] == 0
        assert any("No week-in-promotion fade" in n for n in model["notes"])
    if not model["post_promotion_dip"]["detected"]:
        assert model["post_promotion_dip"]["fraction"] == 0
        assert any("No post-promotion dip" in n for n in model["notes"])


def test_a_thin_scope_falls_back_and_says_so(client):
    """One product in one channel for one month holds too few promoted weeks
    to fit on; the model comes from the whole dataset and says which."""
    thin = _post(client, "/api/simulation/scope",
                 {"filters": {"year": 2025, "month": 3, "channel": ["CH002"], "product": ["P11-100ml"]}})
    assert thin["model"]["provenance"] in (studio.PROVENANCE_DATASET, studio.PROVENANCE_RULES)
    assert any("whole dataset" in n or "approved treatment rules" in n for n in thin["model"]["notes"])


def test_the_rules_fallback_reproduces_the_approved_bands():
    """The last-resort curve passes through the approved rules' own bands."""
    from app.tpo import config
    m = studio._rules_model()
    assert m.provenance == studio.PROVENANCE_RULES
    for d, lo, hi in config.TREATMENT_RULES.values():
        low, mid, high = m.lift(d * 100)
        assert lo - 0.08 <= mid <= hi + 0.08, (d, lo, mid, hi)
        assert low < mid < high


# --- the discount curve -----------------------------------------------------


def test_the_curve_is_the_scenario_at_every_depth(client, scope):
    """Each point is what /simulate would say at that depth -- no
    interpolation, no second arithmetic."""
    spend, days = scope["levers"]["trade_spend"]["default"], 14
    c = _post(client, "/api/simulation/curve", {"filters": SCOPE, "trade_spend": spend, "days": days})
    depths = [p["discount_pct"] for p in c["points"]]
    assert depths == sorted(depths) and depths[0] == 0 and depths[-1] == scope["levers"]["discount_pct"]["max"]
    assert sum(1 for p in c["points"] if p["is_current_plan"]) == 1
    for p in c["points"][::4]:
        s = _simulate(client, p["discount_pct"], spend, days)
        assert p["revenue"]["value"] == s["scenario"]["revenue"]["value"]
        assert p["roi"]["value"] == s["scenario"]["roi"]["value"]
        assert p["roi_status"] == s["deltas"]["roi"]["status"]


def test_the_curve_refuses_what_simulate_refuses(client):
    _post(client, "/api/simulation/curve", {"filters": SCOPE, "trade_spend": 1e6, "days": 0}, expect=422)
    r = client.post("/api/simulation/curve", json={"filters": SCOPE, "trade_spend": 1e6, "days": 7, "discount_pct": 5})
    assert r.status_code == 422 and "discount_pct" in r.text


# --- calibration --------------------------------------------------------------


def test_the_current_plan_reproduces_what_the_scope_measured(client):
    """A scope pinned to one promotion (the Promotion Intelligence hand-off):
    the curve is calibrated to that scope's own lift, so replaying its depth
    over its own run length returns the figures the Insights Hub measured."""
    scope_filters = {"year": 2025, "channel": ["CH003"], "product": ["P13-240ct"], "promotion": ["PBDU25"]}
    sc = _post(client, "/api/simulation/scope", {"filters": scope_filters})
    L = sc["levers"]
    r = _simulate(client, L["discount_pct"]["default"], L["trade_spend"]["default"], L["days"]["default"], filters=scope_filters)
    current = r["current_plan"]
    assert current["trade_spend"]["value"] == pytest.approx(sc["measured"]["trade_spend"]["value"], rel=1e-3)
    assert current["incremental_sales"]["value"] == pytest.approx(sc["measured"]["incremental_sales"]["value"], rel=1e-3)
    assert current["roi"]["value"] == sc["measured"]["roi"]["value"]
    assert sc["model"]["calibration"]["events"] == 1
    assert any("Calibrated" in n for n in sc["model"]["notes"])


def test_a_scope_with_no_promotion_is_not_calibrated(client):
    sc = _post(client, "/api/simulation/scope", {"filters": {"year": 2025, "channel": ["CH002"], "promotion": ["-1"]}}, expect=200) \
        if client.post("/api/simulation/scope", json={"filters": {"year": 2025, "channel": ["CH002"], "promotion": ["-1"]}}).status_code == 200 else None
    if sc is None:
        pytest.skip("the dataset's no-promotion offer is not selectable as a scope")
    assert sc["model"]["calibration"]["events"] == 0
    assert sc["model"]["calibration"]["scale"] == 1
