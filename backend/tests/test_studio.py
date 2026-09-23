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
import math

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
    assert scope["levers"]["days"]["max"] == min(studio.MAX_DAYS, scope["levers"]["days"]["evidence_max"])
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
    """EXACTLY the observed plan, not the nearest slider position.

    The page prints the observed depth in its header and opens the discount
    lever on it. When the lever snapped to its 0.5-point step, a scope
    measured at 14.44% opened on 14.50% and the two contradicted each other
    on screen -- so the equality here is exact on purpose."""
    observed = scope["observed_plan"]
    assert scope["levers"]["discount_pct"]["default"] == observed["discount_pct"]
    assert scope["levers"]["days"]["default"] == observed["days"]


def test_the_default_budget_funds_the_plan_and_sits_on_the_sliders_grid(scope, default_run):
    """The budget opens at what the current plan costs -- no more.

    Rounding the starting budget up to the slider's step used to open a scope
    whose plan costs Rs 81.35 L on Rs 85.00 L, with a line about Rs 3.65 L
    unspent that no plan ever had. The grid check is the other half of it: a
    native range input snaps its thumb to `min + k * step`, so an off-grid
    starting budget would show its readout and its thumb at two amounts."""
    lever = scope["levers"]["trade_spend"]
    spend = default_run["levers"]["trade_spend"]
    assert spend["full_coverage_cost"]["value"] == pytest.approx(lever["default"], rel=1e-6)
    assert spend["binding"] is False
    assert spend["unspent"]["value"] == pytest.approx(0.0, abs=1.0)
    positions = lever["default"] / lever["step"]
    assert positions == pytest.approx(round(positions), abs=1e-6)


# --- the levers -------------------------------------------------------------


def test_the_payload_formats_the_lift_so_the_page_need_not(default_run):
    """`mid_display` exists because the page was doing `(mid * 100).toFixed(2)`
    itself -- arithmetic the studio is not supposed to do, and which threw away
    the low-high band the engine had already formatted."""
    lift = default_run["lift"]
    assert lift["mid_display"] == f"{lift['mid'] * 100:,.2f}%"
    assert "–" in lift["display"]


def test_the_window_is_coherent_across_the_whole_days_range(client, scope):
    """Weeks, the partial-week flag and the weekly rows have to agree with the
    days asked for, at every length the slider allows -- the three lever notes
    on the page are written straight off them."""
    L = scope["levers"]
    for days in (1, 6, 7, 8, 14, 25, 28, studio.MAX_DAYS):
        r = _simulate(client, L["discount_pct"]["default"], L["trade_spend"]["default"], days)
        window = r["window"]
        assert window["days"] == days
        assert window["weeks"] == math.ceil(days / 7), days
        assert (window["partial_week_fraction"] is None) == (days % 7 == 0), days
        assert sum(w["days"] for w in r["weekly"]) == pytest.approx(days), days
        assert len(r["weekly"]) == window["weeks"], days


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


# --- optimize ---------------------------------------------------------------

#: One product, one channel, one offer -- the shape of the Promotion
#: Intelligence hand-off. Optimize is that page's tool and refuses anything
#: wider, so its tests cannot share the module's broad SCOPE.
ONE_PRODUCT = {"year": 2025, "product": ["P13-240ct"], "promotion": ["PBDU25"], "channel": ["CH003"]}
PLAN_SPEND = 8_135_411.2  # what the current plan costs over its 7 days


def _optimize(client, vary, *, discount=25.0, spend=PLAN_SPEND, days=7, filters=ONE_PRODUCT, expect=200):
    return _post(client, "/api/simulation/optimize",
                 {"filters": filters, "discount_pct": discount, "trade_spend": spend, "days": days, "vary": vary},
                 expect)


def test_optimize_beats_or_matches_every_sampled_point_in_its_range(client):
    """Exhaustive means exhaustive: no point inside the searched range has a
    higher ROI than the best -- and at equal ROI, no higher revenue."""
    r = _optimize(client, {"discount_pct": 25.0})
    best = r["best"]["figures"]
    assert 0 <= r["best"]["levers"]["discount_pct"] <= 25.0
    assert r["searched"]["discount_pct"]["count"] == 51  # 0, 0.5, ..., 25
    for d in (2.0, 5.0, 8.0, 10.0, 12.5, 15.0, 20.0, 25.0):
        s = _simulate(client, d, PLAN_SPEND, 7, filters=ONE_PRODUCT)["scenario"]
        assert (s["roi"]["value"], s["revenue"]["value"]) <= (best["roi"]["value"], best["revenue"]["value"]), d
    assert r["gain"]["roi"]["direction"] == "up"


def test_optimize_with_the_budget_free_funds_the_scope_and_no_more(client):
    """ROI is the same at every budget, so the tie-break decides: the smaller
    of the ceiling and the full-coverage cost.

    With the budget searched, its baseline is the budget that funds the
    current plan -- which IS that smaller amount. So the honest answer is
    always "your plan already spends the right amount": overfunding is never
    recommended, and a range that cannot even reach the plan's cost has
    nothing in it that beats the plan."""
    full_cost = _simulate(client, 25.0, 20_000_000.0, 7, filters=ONE_PRODUCT)["levers"]["trade_spend"]["full_coverage_cost"]["value"]
    for top in (20_000_000.0, full_cost, 3_000_000.0):
        r = _optimize(client, {"trade_spend": top}, spend=top)
        assert r["from"]["levers"]["trade_spend"] == pytest.approx(full_cost, rel=1e-6), top
        assert r["best"]["levers"]["trade_spend"] == pytest.approx(full_cost, rel=1e-6), top
        assert r["best"]["changed"]["trade_spend"] is False, top
        assert r["already_optimal"] is True, top
        assert r["gain"]["roi"]["direction"] == "unchanged", top


def test_optimize_measures_a_searched_lever_against_the_current_plan(client):
    """"Now" is the plan, not the handle. A searched lever's slider is the top
    of its range, so reading the baseline off it compared the answer against
    wherever the reader had dragged while setting the range up -- a discount
    range of 0-19.50% reported the plan as running at 19.50%."""
    scope = _post(client, "/api/simulation/scope", {"filters": ONE_PRODUCT})
    plan_depth = scope["observed_plan"]["discount_pct"]
    plan_days = scope["observed_plan"]["days"]
    plan_cost = scope["levers"]["trade_spend"]["default"]

    # Search a range whose top is nowhere near the plan's own depth.
    r = _optimize(client, {"discount_pct": 19.5}, discount=19.5)
    assert r["from"]["levers"]["discount_pct"] == plan_depth
    assert r["searched"]["discount_pct"]["max"] == 19.5
    # ...and the figures are the current plan's, as `simulate` reports them.
    current = _simulate(client, plan_depth, plan_cost, plan_days, filters=ONE_PRODUCT)["current_plan"]
    assert r["from"]["figures"]["roi"]["display"] == current["roi"]["display"]
    assert r["from"]["figures"]["revenue"]["display"] == current["revenue"]["display"]

    # A HELD lever is held where the reader put it -- and the baseline is
    # STILL the plan, because the column is headed "Current plan" and holding
    # Days at 14 does not make the plan a 14-day one.
    held = _optimize(client, {"discount_pct": 19.5}, discount=19.5, days=14)
    assert held["held"]["days"] == 14
    assert held["best"]["levers"]["days"] == 14
    assert held["from"]["levers"]["days"] == plan_days
    assert held["from"]["levers"]["discount_pct"] == plan_depth
    assert held["from"]["levers"]["trade_spend"] == pytest.approx(plan_cost, rel=1e-6)


def test_optimize_never_recommends_a_move_that_changes_nothing(client):
    """When the sliders are already as good as anything in the range, the
    answer is "leave them", with the from and best levers identical."""
    r = _optimize(client, {"days": 7})
    assert r["already_optimal"] is True
    assert r["best"]["levers"] == r["from"]["levers"]
    assert not any(r["best"]["changed"].values())
    assert r["gain"]["roi"]["direction"] == "unchanged"


def test_optimize_ranks_at_the_precision_the_page_shows(client):
    """Ties at two decimals are ties, so the best window is the LONGEST one
    still earning the best two-decimal ROI: the day after it must be
    strictly worse at two decimals, or there is no day after it."""
    top = studio.MAX_DAYS
    r = _optimize(client, {"discount_pct": 30.45, "days": top}, discount=30.45, days=top)
    d, days = r["best"]["levers"]["discount_pct"], r["best"]["levers"]["days"]
    best_roi = r["best"]["figures"]["roi"]["value"]
    if days < top:
        after = _simulate(client, d, PLAN_SPEND, days + 1, filters=ONE_PRODUCT)["scenario"]["roi"]["value"]
        assert after < best_roi, (days, after, best_roi)


def test_optimize_over_three_levers_is_no_worse_than_over_one(client):
    one = _optimize(client, {"discount_pct": 25.0})
    three = _optimize(client, {"discount_pct": 25.0, "trade_spend": PLAN_SPEND, "days": 7})
    assert three["best"]["figures"]["roi"]["value"] >= one["best"]["figures"]["roi"]["value"]
    assert three["searched"]["evaluations"] >= one["searched"]["evaluations"]
    assert set(three["held"]) == set() and set(one["held"]) == {"trade_spend", "days"}


def test_optimize_is_deterministic(client):
    a = _optimize(client, {"discount_pct": 25.0, "days": 14})
    b = _optimize(client, {"discount_pct": 25.0, "days": 14})
    assert a == b


def test_optimize_refuses_rather_than_guesses(client):
    """Nothing to vary, a lever it does not know, a scope wider than one
    product, or a range outside the evidence: each a 422 with the reason,
    never a silent default."""
    _optimize(client, {}, expect=422)
    _optimize(client, {"margin": 5.0}, expect=422)
    wide = _optimize(client, {"days": 7}, filters=SCOPE, expect=422)
    assert "one product" in wide["detail"]
    deep = _optimize(client, {"discount_pct": 99.0}, expect=422)
    assert "discount" in deep["detail"].lower()


def test_the_days_ceiling_is_measured_not_assumed(client, scope):
    """The slider stops at the planning cap OR the longest run the data
    actually holds, whichever is shorter -- so a dataset of one-week
    promotions would narrow the slider by itself."""
    days = scope["levers"]["days"]
    assert days["max"] == min(studio.MAX_DAYS, days["evidence_max"])
    assert days["evidence_max"] % studio.DAYS_PER_WEEK == 0
    assert days["min"] <= days["default"] <= days["max"]


def test_every_compared_figure_carries_its_own_delta(default_run, client, scope):
    """No Change column is left blank. Revenue and ROI always had a delta;
    Trade Spend and Incremental Sales did not, and the Optimize card showed a
    dash for them."""
    L = scope["levers"]
    moved = _simulate(client, L["discount_pct"]["default"] / 2, L["trade_spend"]["default"], L["days"]["default"])
    for key in ("revenue", "trade_spend", "incremental_sales"):
        block = moved["deltas"][key]
        assert block["absolute"]["display"], key
        assert block["direction"] in {"up", "down", "unchanged", "not_applicable"}, key
        if block["percent"] is not None:
            assert block["percent_display"].endswith("%"), key
    # Counts and percentages move too, in their own units.
    assert moved["deltas"]["incremental_units"]["absolute_display"]
    assert moved["deltas"]["margin_pct"]["absolute_display"].endswith("pts")
    # At the defaults the scenario IS the current plan, so every one is flat.
    for key in ("revenue", "trade_spend", "incremental_sales", "incremental_units", "margin_pct"):
        assert default_run["deltas"][key]["direction"] == "unchanged", key

