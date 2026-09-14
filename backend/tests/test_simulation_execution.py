"""Validation for scenario execution -- B2.2.

The claim under test: a simulated scenario's numbers come from the SAME KPI
engine that measures the real ones, applied to rows that were rewritten under
an APPROVED treatment. So the tests are mostly of two kinds.

ENGINE PARITY. Every KPI the endpoint returns is asserted equal to a direct
`aggregate.calculate_*` call on the same synthesized rows. If anyone ever
computes a KPI inside the simulation service, these fail.

ORACLE AGREEMENT. The closed-form economics from the approved audit is
evaluated independently here and compared with what the engine produced. It is
a TEST ORACLE only -- production never uses it, and `aggregate.py` stays the
source of truth. Tolerance is documented at its single use.

Run with:

    ../venv/Scripts/python.exe -m pytest tests/ -q
"""

from __future__ import annotations

import pytest
from fastapi.testclient import TestClient

from app.main import app
from app.tpo import aggregate as A
from app.tpo import config, execution, response, scenarios
from app.tpo.filters import FilterState, baseline_rows_for, rows_for

YEAR = 2025
COST_RATE = 0.03

#: One scope per approved treatment, chosen so each really carries that
#: treatment's promotion in the data.
SCOPES = {
    "PR001": {"year": YEAR, "promotion": ["PR001"]},
    "PR002": {"year": YEAR, "promotion": ["PR002"]},
    "PR003": {"year": YEAR, "promotion": ["PR003"]},
    "PS001": {"year": 2024, "promotion": ["PBDI24"]},
    "PB001": {"year": YEAR, "promotion": ["PBDI25"]},
}
DISCOUNT = {"PR001": 5, "PR002": 10, "PR003": 15, "PS001": 20, "PB001": 25}

#: One promoted SKU in one channel, whose Brand Form neighbours did not trade
#: there that week. The engine reports no comparable event however wide the row
#: set is -- a genuine absence of evidence rather than a starved scope.
NO_EVIDENCE_SCOPE = {
    "year": YEAR, "promotion": ["PBDU25"], "product": ["P13-240ct"], "channel": ["CH003"],
}

#: The engine rounds the ROI multiple to two decimal places, so an exact
#: algebraic identity can still land up to half a step (0.005) away.
#: Everything looser than this would be hiding a real disagreement.
ROI_ROUNDING_TOLERANCE = 0.005


@pytest.fixture(scope="session")
def client():
    return TestClient(app)


def _simulate(client, filters, discount_pct, scenario_id="optimized-plan", **extra):
    body = {"filters": filters, "scenario_id": scenario_id, "discount_pct": discount_pct, **extra}
    return client.post("/api/simulation/simulate", json=body)


def _ok(client, filters, discount_pct, **extra):
    r = _simulate(client, filters, discount_pct, **extra)
    assert r.status_code == 200, r.text
    return r.json()


def closed_form_roi(u: float, d: float, c: float = COST_RATE) -> float:
    """THE ORACLE. ROI = u(1-d)/((1+u)(d+c)), as a multiple of trade spend.

    b and P cancel out of the ratio, which is why neither appears -- and why
    the identity holds for a whole selection of mixed products and prices, not
    just one row. Used only in this file.
    """
    return u * (1 - d) / ((1 + u) * (d + c))


def _synth(state: FilterState, uplift: float, discount: float):
    """The same three row sets the service builds, rebuilt here independently
    so a test can call the engine directly on them."""
    rows, volume_rows = rows_for(state), baseline_rows_for(state)
    # The cannibalization set takes BOTH widenings unconditionally, mirroring
    # `service._bundle` and `execution._evaluate`: the Brand Form for the
    # neighbours, and `baseline_rows_for` for the non-promoted rows every
    # baseline is derived from. A scenario scope names a promotion, so without
    # the second one this set holds no non-promoted row and the metric starves.
    widened = state.widened_to_brand_form()
    family_rows = baseline_rows_for(widened)
    targets = execution._target_keys(rows)
    baselines = execution._baselines(volume_rows)
    return (
        execution.synthesize(rows, targets, baselines, uplift, discount).rows,
        execution.synthesize(volume_rows, targets, baselines, uplift, discount).rows,
        execution.synthesize(family_rows, targets, baselines, uplift, discount).rows if family_rows else (),
    )


# --- 1-2: the route ---------------------------------------------------------


def test_simulate_route_exists(client):
    """1."""
    paths = client.get("/openapi.json").json()["paths"]
    assert "post" in paths["/api/simulation/simulate"]


def test_valid_request_succeeds(client):
    """2."""
    payload = _ok(client, SCOPES["PR002"], 10)
    assert payload["treatment"] == "PR002"
    assert payload["status"] == "simulated"
    assert payload["scenario_id"] == "optimized-plan"


# --- 3-7: rejected inputs ---------------------------------------------------


@pytest.mark.parametrize("discount", [0, 7, 12, 17, 22.5, 30, -5, 100])
def test_unsupported_discount_is_rejected(client, discount):
    """3, 4. No interpolation, no rounding, no snapping -- a 422 instead."""
    r = _simulate(client, SCOPES["PR002"], discount)
    assert r.status_code == 422
    assert "not an approved promotion treatment" in r.json()["detail"]


@pytest.mark.parametrize(
    "field,value,expect",
    [
        ("spend_amount", 1_000_000, "derived from scenario economics"),
        ("incentive_pct", 3.5, "retailer support"),
        ("inventory_allocation", "Aggressive", "no inventory data"),
    ],
)
def test_unsupported_causal_levers_are_rejected_by_name(client, field, value, expect):
    """5, 6, 7. Rejected WITH the reason -- a caller sending `spend_amount` has
    a mistaken model of the economics and needs to be told which one."""
    r = _simulate(client, SCOPES["PR002"], 10, **{field: value})
    assert r.status_code == 422
    assert expect in r.text


def test_malformed_request_is_rejected(client):
    assert client.post("/api/simulation/simulate", json={"discount_pct": 10}).status_code == 422
    assert _simulate(client, SCOPES["PR002"], 10, scenario_id="").status_code == 422
    assert _simulate(client, {"month": 13}, 10).status_code == 422


def test_scope_with_no_promotion_is_an_error_not_a_zero_result(client):
    """A scope holding nothing to replace has no result -- not a zeroed one."""
    r = _simulate(client, {"year": YEAR, "promotion": ["-1"]}, 10)
    assert r.status_code == 422
    assert "was promoted" in r.json()["detail"]


# --- 8: duration changes nothing -------------------------------------------


@pytest.mark.parametrize("duration", [None, 1, 4, 52])
def test_duration_does_not_alter_the_scenario_result(client, duration):
    """8. THE guarantee for the one lever with no approved response."""
    base = _ok(client, SCOPES["PR002"], 10)["result"]
    kwargs = {} if duration is None else {"duration_weeks": duration}
    assert _ok(client, SCOPES["PR002"], 10, **kwargs)["result"] == base


def test_duration_is_echoed_and_labelled_not_modelled(client):
    lever = _ok(client, SCOPES["PR002"], 10, duration_weeks=6)["levers"]["duration_weeks"]
    assert lever["value"] == 6
    assert lever["modelled"] is False
    assert "not modelled" in lever["note"].lower()


# --- 9-18: every treatment, both ends of its band ---------------------------


@pytest.mark.parametrize("end", ["low", "high"])
@pytest.mark.parametrize("treatment", sorted(SCOPES))
def test_each_treatment_produces_a_result_at_each_end(client, treatment, end):
    """9-18. Ten cases: five treatments x low/high."""
    payload = _ok(client, SCOPES[treatment], DISCOUNT[treatment])
    assert payload["treatment"] == treatment

    side = payload["result"][end]
    rule = response.get_treatment_response(DISCOUNT[treatment])
    assert side["uplift"] == (rule.uplift_low if end == "low" else rule.uplift_high)

    kpis = side["kpis"]
    assert set(kpis) == {
        "trade_spend", "incremental_units", "incremental_sales",
        "roi_multiple", "margin_percent", "cannibalization", "pei",
    }
    for key in ("trade_spend", "incremental_units", "incremental_sales", "roi_multiple"):
        assert kpis[key]["available"], f"{treatment}/{end}: {key} unavailable"
        assert kpis[key]["value"] is not None


@pytest.mark.parametrize("treatment", sorted(SCOPES))
def test_low_high_preserve_the_approved_band(client, treatment):
    """19. The band is carried whole into the result -- no midpoint, and the
    two ends are the approved ones."""
    payload = _ok(client, SCOPES[treatment], DISCOUNT[treatment])
    rule = response.get_treatment_response(DISCOUNT[treatment])

    assert payload["uplift"] == {"low": rule.uplift_low, "high": rule.uplift_high}
    assert payload["result"]["low"]["uplift"] == rule.uplift_low
    assert payload["result"]["high"]["uplift"] == rule.uplift_high
    # More uplift at the same discount must return more.
    assert payload["result"]["high"]["kpis"]["roi_multiple"]["value"] > \
           payload["result"]["low"]["kpis"]["roi_multiple"]["value"]


def test_the_range_is_never_called_a_confidence_interval(client):
    """12 of the brief. These bands are approved rules, not estimated
    uncertainty, and the payload must not imply otherwise."""
    payload = _ok(client, SCOPES["PR002"], 10)
    assert payload["range_label"] == "Approved uplift range"
    flat = str(payload).lower()
    for word in ("confidence", "prediction interval", "probability", "significance", "std", "stderr"):
        assert word not in flat, f"payload implies statistical uncertainty: {word}"


# --- 20: provenance ---------------------------------------------------------


@pytest.mark.parametrize("treatment", sorted(SCOPES))
def test_result_carries_provenance(client, treatment):
    """20. Every result can be traced back to the rule that produced it."""
    payload = _ok(client, SCOPES[treatment], DISCOUNT[treatment])
    rule = response.get_treatment_response(DISCOUNT[treatment])
    p = payload["provenance"]

    assert p["response_rule"] == response.PROVENANCE == "Approved TPO promotion treatment rule"
    assert p["treatment"] == treatment
    assert p["discount_pct"] == rule.discount_pct
    assert p["uplift_low"] == rule.uplift_low
    assert p["uplift_high"] == rule.uplift_high
    assert p["promotion_cost_rate"] == config.PROMOTION_COST_RATE
    assert p["kpi_engine"] == "app/tpo/aggregate.calculate_kpis"
    for claim in ("ml", "mmm", "elasticity", "forecast", "learned"):
        assert claim not in str(p).lower()


# --- 21-22: status ----------------------------------------------------------


def test_status_becomes_simulated_only_after_execution(client):
    """21, 22. /run's hypotheticals are not_simulated with no result; only a
    successful /simulate produces the `simulated` status."""
    run = client.post("/api/simulation/run", json={"filters": SCOPES["PR002"]}).json()
    for scenario in run["scenarios"]:
        if scenario["kind"] == "hypothetical":
            assert scenario["status"] == "not_simulated"
            assert scenario["result"] is None

    assert _ok(client, SCOPES["PR002"], 10)["status"] == "simulated"


def test_a_failed_simulation_yields_no_simulated_status(client):
    """A rejected request must not hand back a `simulated` anything."""
    r = _simulate(client, SCOPES["PR002"], 12)
    assert r.status_code == 422
    assert "simulated" not in r.text.lower() or "not_simulated" in r.text.lower()


def test_the_guard_rejects_a_simulated_result_without_provenance():
    """17 of the brief: the guard was strengthened, not weakened."""
    built = scenarios.build({"discount_pct": 10.0}, {"roi_multiple": {"value": 1}})
    built[1]["status"] = "simulated"
    built[1]["result"] = {"roi_multiple": {"value": 99}}  # no provenance
    with pytest.raises(AssertionError, match="no provenance"):
        scenarios.assert_no_fabricated_results(built)

    built[1]["result"]["provenance"] = {"response_rule": response.PROVENANCE}
    scenarios.assert_no_fabricated_results(built)  # now legal

    built[2]["status"] = "simulated"  # claims simulated, carries nothing
    with pytest.raises(AssertionError, match="carries no result"):
        scenarios.assert_no_fabricated_results(built)


# --- 23-25: nothing else moves ---------------------------------------------


def test_baseline_and_other_scenarios_are_unchanged_by_a_simulation(client):
    """23, 24, 25. Simulating must not mutate the measured baseline, the
    Current Plan, the other scenarios, or /run's behaviour."""
    before = client.post("/api/simulation/run", json={"filters": SCOPES["PR002"]}).json()

    for discount in (5, 10, 15):
        _ok(client, SCOPES["PR002"], discount)

    after = client.post("/api/simulation/run", json={"filters": SCOPES["PR002"]}).json()
    assert after == before, "/run changed after a simulation"
    assert after["scenarios"][0] == before["scenarios"][0], "Current Plan moved"
    assert after["kpis"] == before["kpis"], "the measured baseline moved"
    for scenario in after["scenarios"][1:]:
        assert scenario["status"] == "not_simulated" and scenario["result"] is None


def test_simulating_one_scope_does_not_disturb_another(client):
    """Scenario isolation across requests: the service holds no state."""
    a1 = _ok(client, SCOPES["PR002"], 10)
    _ok(client, SCOPES["PR003"], 15)
    assert _ok(client, SCOPES["PR002"], 10) == a1


# --- 26-33: the KPI engine produced every number ---------------------------


@pytest.mark.parametrize("end", ["low", "high"])
@pytest.mark.parametrize("treatment", sorted(SCOPES))
def test_every_kpi_equals_a_direct_aggregate_call(client, treatment, end):
    """26-33. THE parity test. Each KPI is re-derived here by calling
    aggregate directly on the same synthesized rows. If the service ever
    computes one itself, this fails."""
    discount_pct = DISCOUNT[treatment]
    rule = response.get_treatment_response(discount_pct)
    uplift = rule.uplift_low if end == "low" else rule.uplift_high

    state = FilterState.build(**SCOPES[treatment])
    cf_rows, cf_volume, cf_family = _synth(state, uplift, discount_pct / 100)
    kpis = _ok(client, SCOPES[treatment], discount_pct)["result"][end]["kpis"]

    assert kpis["trade_spend"]["value"] == A.calculate_trade_spend(cf_rows)
    assert kpis["incremental_units"]["value"] == A.calculate_incremental_quantity(cf_volume)
    assert kpis["incremental_sales"]["value"] == A.calculate_incremental_sales(cf_volume)
    assert kpis["roi_multiple"]["value"] == A.calculate_roi(cf_rows, cf_volume)
    assert kpis["margin_percent"]["value"] == A.calculate_margin(cf_rows)
    assert kpis["pei"]["value"] == A.calculate_pei(cf_rows, cf_volume)

    expected_cannib = A.calculate_cannibalization(
        cf_family or cf_rows, frozenset(state.product) if state.product else None
    )
    assert kpis["cannibalization"]["value"] == expected_cannib


def test_cannibalization_is_labelled_engine_derived(client):
    """13. Present when the engine can produce it, null with the engine's own
    reason when it cannot -- and never described as an estimated response."""
    available = _ok(client, {"year": YEAR, "product": ["P21-64ct"]}, 15)["result"]["low"]["kpis"]["cannibalization"]
    assert available["available"] and available["value"] is not None
    assert "Engine-derived" in available["note"]
    assert "no cannibalization response" in available["note"]

    # A scope with no evidence LEFT once the engine has been given everything
    # it asks for: one SKU in one channel, whose Brand Form siblings never
    # traded in that channel in the promoted week, so no adjacent pack exists
    # to measure a loss against. It must stay null -- not zero -- and say why.
    # (It is NOT an Offer-filtered scope: those starved on the row set rather
    # than on the evidence, which is the defect this file now guards against.)
    absent = _ok(client, NO_EVIDENCE_SCOPE, 10)["result"]["low"]["kpis"]["cannibalization"]
    assert absent["available"] is False
    assert absent["value"] is None
    assert absent["unavailable_reason"], "an absent KPI must say why"


def test_trade_spend_is_derived_from_the_synthesized_rows(client):
    """15. Spend is an output. It rises with volume at a fixed treatment,
    exactly as b(1+u)P(d+c) says it must."""
    payload = _ok(client, SCOPES["PR002"], 10)
    low = payload["result"]["low"]["kpis"]["trade_spend"]["value"]
    high = payload["result"]["high"]["kpis"]["trade_spend"]["value"]
    rule = response.get_treatment_response(10)

    assert high > low
    assert high / low == pytest.approx((1 + rule.uplift_high) / (1 + rule.uplift_low), rel=1e-9)
    assert payload["levers"]["spend_amount"]["derived"] is True


# --- 34: the closed-form oracle --------------------------------------------


@pytest.mark.parametrize("end", ["low", "high"])
@pytest.mark.parametrize("treatment", sorted(SCOPES))
def test_engine_roi_agrees_with_the_closed_form_oracle(client, treatment, end):
    """34. The engine's ROI over the synthesized rows equals the closed-form
    ROI for that (u, d), to within the engine's own 2dp rounding.

    This holds for a whole mixed selection because b and P cancel out of the
    ratio: Sum(b_i P_i) factors out of numerator and denominator alike.
    """
    rule = response.get_treatment_response(DISCOUNT[treatment])
    uplift = rule.uplift_low if end == "low" else rule.uplift_high
    engine_roi = _ok(client, SCOPES[treatment], DISCOUNT[treatment])["result"][end]["kpis"]["roi_multiple"]["value"]

    expected = closed_form_roi(uplift, rule.discount_pct / 100)
    assert engine_roi == pytest.approx(expected, abs=ROI_ROUNDING_TOLERANCE)


@pytest.mark.parametrize("treatment", sorted(SCOPES))
def test_scenario_roi_sits_where_the_breakeven_says_it_should(client, treatment):
    """35. PB001's narrow headroom stays visible: its low end barely clears
    break-even where every other treatment clears it comfortably."""
    rule = response.get_treatment_response(DISCOUNT[treatment])
    low_roi = _ok(client, SCOPES[treatment], DISCOUNT[treatment])["result"]["low"]["kpis"]["roi_multiple"]["value"]

    assert low_roi >= 1.0, "an approved band's floor must still return its money"
    if treatment == "PB001":
        # 1.004 unrounded: at two decimal places it prints as 1.00, break-even.
        assert low_roi < 1.01, f"PB001's floor should be barely above break-even, got {low_roi}"
    else:
        assert low_roi > 1.1


def test_pb001_headroom_is_reported_and_not_smoothed(client):
    """35. The tightest treatment reports its real headroom."""
    payload = _ok(client, SCOPES["PB001"], 25)
    assert payload["headroom"]["low"] == pytest.approx(0.004255, abs=1e-5)
    assert payload["breakeven_uplift"] == pytest.approx(0.5957, abs=1e-4)


# --- 22 of the brief: the measured-uplift regression -----------------------


@pytest.mark.parametrize("treatment", ["PR001", "PR002", "PR003"])
def test_synthesis_reproduces_measured_roi_at_the_uplift_the_data_implies(treatment):
    """THE STRONGEST REGRESSION CHECK.

    Re-synthesize the real scope at the uplift the measured ROI implies, and
    the engine returns the measured ROI back -- exactly. That is only possible
    if the row synthesis reproduces the engine's economics, so this is the test
    that would catch a broken counterfactual.

    The uplift is recovered by inverting the closed form:
        ROI = u(1-d)/((1+u)(d+c))  =>  u = R(d+c) / ((1-d) - R(d+c))

    The measured ROI is taken UNROUNDED for the inversion: a 0.1 display step
    is far too coarse to recover an uplift from, and the round trip is then
    checked at the engine's own rounding.
    """
    d = DISCOUNT[treatment] / 100
    state = FilterState.build(**SCOPES[treatment])
    measured = A.calculate_roi(rows_for(state), baseline_rows_for(state), precision=None)

    ratio = measured
    implied_u = ratio * (d + COST_RATE) / ((1 - d) - ratio * (d + COST_RATE))

    cf_rows, cf_volume, _ = _synth(state, implied_u, d)
    assert A.calculate_roi(cf_rows, cf_volume, precision=None) == pytest.approx(measured, abs=1e-6)


@pytest.mark.parametrize(
    "treatment,audit_mean_uplift", [("PR001", 0.182), ("PR002", 0.303), ("PR003", 0.438)]
)
def test_the_audit_mean_uplift_is_a_different_statistic_from_the_roi_one(treatment, audit_mean_uplift):
    """A DOCUMENTED, DELIBERATE NON-MATCH.

    The brief asked whether synthesizing at the audit's measured uplift
    reproduces the measured ROI. It does not, and it should not: the audit
    reports an UNWEIGHTED mean of per-(promotion, year) uplifts, while ROI is
    driven by the VOLUME-WEIGHTED uplift. Per-group uplift inside PR001 F25
    ranges 14.5%-26.8%, so the two means differ by a few tenths of a point and
    the ROIs differ by a few hundredths of a multiple.

    Nothing was changed in aggregate.py to close this gap, because there is no
    defect to close -- the two numbers answer different questions. This test
    pins the size of the gap so that a future real regression, which would move
    it much further, is still visible.
    """
    d = DISCOUNT[treatment] / 100
    state = FilterState.build(**SCOPES[treatment])
    # Unrounded on both sides: the gap being pinned is smaller than the 0.1
    # display step, so the rounded figures could straddle a boundary.
    measured = A.calculate_roi(rows_for(state), baseline_rows_for(state), precision=None)

    cf_rows, cf_volume, _ = _synth(state, audit_mean_uplift, d)
    at_audit_mean = A.calculate_roi(cf_rows, cf_volume, precision=None)

    assert at_audit_mean == pytest.approx(measured, abs=0.07), (
        "the gap between the unweighted and volume-weighted uplift grew beyond "
        "what the mix explains"
    )
    volume_weighted = A._volume(baseline_rows_for(state))
    implied = volume_weighted.incremental_quantity / volume_weighted.baseline_quantity
    assert implied != audit_mean_uplift
    assert abs(implied - audit_mean_uplift) < 0.02, "the two means should still be close"


# --- performance ------------------------------------------------------------


def test_a_representative_scope_simulates_promptly(client):
    """24 of the brief. Both band ends, three row sets each, over a real scope.
    Row selection is already lru_cached by filters.py; nothing new is cached
    here."""
    import time

    _ok(client, SCOPES["PR002"], 10)  # warm the filter caches
    start = time.perf_counter()
    _ok(client, {"year": YEAR, "channel": ["CH002"]}, 15)
    elapsed = time.perf_counter() - start
    assert elapsed < 10.0, f"simulate took {elapsed:.2f}s"
