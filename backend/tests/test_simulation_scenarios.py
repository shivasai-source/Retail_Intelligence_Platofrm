"""Validation for the Simulation Studio scenario/context foundation -- Part B1.

Part B1 adds no arithmetic, so these tests are almost entirely about a single
claim: MEASURED AND HYPOTHETICAL ARE NEVER MIXED. The Current Plan carries
values derived from fact_sales and the validated KPI engine, with a stated
derivation for each. The other two carry lever inputs and nothing else -- no
result, no zero, no baseline copy, no improvement factor.

Everything Phase A guaranteed still holds; tests/test_simulation.py is
unchanged and still runs.

Run with:

    ../venv/Scripts/python.exe -m pytest tests/ -q
"""

from __future__ import annotations

import pytest
from fastapi.testclient import TestClient

from app.main import app
from app.routers.simulation import SimulationFilters
from app.tpo import scenarios, simulation
from app.tpo.filters import DIMENSIONS, FilterState, rows_for

YEAR = 2025

#: A scope containing exactly one promotion, and one containing many. The
#: distinction drives every Current Plan field that can only be read per
#: promotion.
SINGLE_PROMOTION = {"year": YEAR, "promotion": ["PBDI25"]}
MANY_PROMOTIONS = {"year": YEAR, "channel": ["CH002"]}


@pytest.fixture(scope="session")
def client():
    return TestClient(app)


def _run(client, **body):
    response = client.post("/api/simulation/run", json=body)
    assert response.status_code == 200, response.text
    return response.json()


def _field(payload, key):
    return next(f for f in payload["current_plan"]["fields"] if f["key"] == key)


# --- 1-2: the context ------------------------------------------------------


@pytest.mark.parametrize("filters", [SINGLE_PROMOTION, MANY_PROMOTIONS, {"year": YEAR}, {}])
def test_context_resolves_the_selected_scope(client, filters):
    """1. The context describes the scope that was actually asked for."""
    context = _run(client, filters=filters)["context"]
    state = FilterState.build(**filters)

    assert context["filters_applied"] == state.applied()
    assert context["row_count"] == len(rows_for(state))
    assert context["year"] == state.year

    for dimension in context["dimensions"]:
        constrained = bool(getattr(state, dimension["key"]))
        assert dimension["constrained"] is constrained
        # A constrained dimension names its values; an unconstrained one says
        # so honestly rather than inventing a default.
        assert dimension["summary"], dimension["key"]
        if not constrained:
            assert dimension["summary"].startswith("All ")
            assert dimension["values"] == []


def test_context_uses_display_names_not_codes(client):
    """Codes are resolved through the SAME labeller the Insights Hub's
    breakdowns use, so CH002 reads as Modern Trade in both places or neither."""
    dimensions = {d["key"]: d for d in _run(client, filters={"year": YEAR, "channel": ["CH002"]})["context"]["dimensions"]}
    assert dimensions["channel"]["summary"] == "Modern Trade"
    assert dimensions["channel"]["values"] == [{"code": "CH002", "name": "Modern Trade"}]

    promotion = {d["key"]: d for d in _run(client, filters=SINGLE_PROMOTION)["context"]["dimensions"]}["promotion"]
    assert promotion["summary"] == "Diwali Special 25"


def test_context_reuses_the_one_filter_contract():
    """2. No second filtering system. The context dimensions are a subset of
    filters.DIMENSIONS, and the request model still mirrors it exactly."""
    context_keys = {key for key, _, _, _ in simulation._CONTEXT_DIMENSIONS}
    assert context_keys <= set(DIMENSIONS)
    assert set(SimulationFilters.model_fields) == set(DIMENSIONS)
    # year/month are scope, not list dimensions -- carried separately.
    assert context_keys == set(DIMENSIONS) - {"year", "month"}


# --- 3: the scenario model -------------------------------------------------


def test_scenario_model_validates(client):
    """3. Every scenario carries the full model, and only legal values."""
    for scenario in _run(client, filters=SINGLE_PROMOTION)["scenarios"]:
        assert set(scenario) == {
            "id", "name", "sub_label", "kind", "status",
            "levers", "editable_levers", "result", "result_reason",
        }
        assert scenario["kind"] in ("measured", "hypothetical")
        assert scenario["status"] in ("measured", "not_simulated")
        assert set(scenario["levers"]) == set(scenarios.LEVER_KEYS)
        assert isinstance(scenario["id"], str) and scenario["id"]


def test_default_scenario_set_is_the_three_named_ones(client):
    payload = _run(client, filters=SINGLE_PROMOTION)
    assert [s["id"] for s in payload["scenarios"]] == ["current-plan", "optimized-plan", "aggressive-growth"]
    assert [s["name"] for s in payload["scenarios"]] == ["Current Plan", "Optimized Plan", "Aggressive Growth"]


# --- 4-6: measured vs hypothetical -----------------------------------------


@pytest.mark.parametrize("filters", [SINGLE_PROMOTION, MANY_PROMOTIONS, {"year": YEAR}])
def test_current_plan_is_measured(client, filters):
    """4. Current Plan is the measured baseline and carries the real result."""
    payload = _run(client, filters=filters)
    current = payload["scenarios"][0]

    assert current["id"] == "current-plan"
    assert current["kind"] == "measured"
    assert current["status"] == "measured"
    assert current["result"] == payload["kpis"]
    assert current["result_reason"] is None
    assert current["editable_levers"] is False, "editing the measured plan would make it hypothetical"
    assert payload["current_plan"]["status"] == "measured"


@pytest.mark.parametrize("scenario_id", ["optimized-plan", "aggressive-growth"])
@pytest.mark.parametrize("filters", [SINGLE_PROMOTION, MANY_PROMOTIONS, {"year": YEAR}])
def test_hypothetical_scenarios_start_not_simulated(client, scenario_id, filters):
    """5, 6. Optimized Plan and Aggressive Growth are hypothetical, unrun, and
    carry no result of any kind."""
    scenario = next(s for s in _run(client, filters=filters)["scenarios"] if s["id"] == scenario_id)
    assert scenario["kind"] == "hypothetical"
    assert scenario["status"] == "not_simulated"
    assert scenario["result"] is None
    assert scenario["result_reason"] == scenarios.NOT_SIMULATED_REASON
    assert scenario["editable_levers"] is True


def test_optimized_plan_promises_nothing(client):
    """20. "Optimized" is a label. Nothing makes it better than the Current
    Plan, because nothing evaluates either of them yet."""
    payload = _run(client, filters=SINGLE_PROMOTION)
    optimized = next(s for s in payload["scenarios"] if s["id"] == "optimized-plan")
    current = next(s for s in payload["scenarios"] if s["id"] == "current-plan")

    # Same levers it was seeded with -- no factor applied on the way out.
    assert optimized["levers"] == current["levers"]
    assert optimized["result"] is None
    for word in ("recommend", "best", "better", "uplift", "improve", "maximis", "maximiz"):
        assert word not in optimized["sub_label"].lower()


# --- 7-8: scenario isolation -----------------------------------------------


@pytest.mark.parametrize("filters", [SINGLE_PROMOTION, MANY_PROMOTIONS])
def test_scenario_lever_state_is_isolated(client, filters):
    """7. No two scenarios share one lever dict.

    They start EQUAL on purpose -- a what-if begins from what is -- so equality
    proves nothing. Identity is the question.
    """
    built = scenarios.build({"discount_pct": 10.0, "duration_weeks": 4.0, "spend_amount": 1.0}, None)
    assert scenarios.levers_are_isolated(built)

    # And over the wire: each scenario's levers survive a round trip as its own
    # object, so a client deserialises three dicts rather than three aliases.
    payload = _run(client, filters=filters)
    assert scenarios.levers_are_isolated(payload["scenarios"])


def test_editing_one_scenario_does_not_mutate_another():
    """8. THE isolation guarantee, exercised by actually mutating one."""
    built = scenarios.build({"discount_pct": 20.0, "duration_weeks": 6.0, "spend_amount": 100.0}, None)
    current, optimized, aggressive = built

    optimized["levers"]["discount_pct"] = 5.0
    aggressive["levers"]["duration_weeks"] = 12.0

    assert current["levers"]["discount_pct"] == 20.0, "editing Optimized Plan reached Current Plan"
    assert current["levers"]["duration_weeks"] == 6.0, "editing Aggressive Growth reached Current Plan"
    assert optimized["levers"]["duration_weeks"] == 6.0, "editing Aggressive Growth reached Optimized Plan"
    assert aggressive["levers"]["discount_pct"] == max(
        scenarios.APPROVED_DISCOUNT_PCT
    ), "editing Optimized Plan reached Aggressive Growth"


def test_seed_levers_returns_a_fresh_dict_every_call():
    observed = {"discount_pct": 1.0, "duration_weeks": 2.0, "spend_amount": 3.0}
    assert scenarios.seed_levers(observed) is not scenarios.seed_levers(observed)


# --- 9-10: unsupported levers stay rejected --------------------------------


@pytest.mark.parametrize(
    "levers,why",
    [
        ({"incentive_pct": 3.5}, "9. retailer incentive has no field in any dataset"),
        ({"inventory_allocation": "Aggressive"}, "10. the project holds no inventory data"),
        ({"incentive_pct": 0, "discount_pct": 10}, "an unsupported lever alongside a supported one"),
    ],
)
def test_unsupported_levers_remain_rejected(client, levers, why):
    """B1 must not weaken Phase A's validation to make room for scenarios."""
    assert client.post("/api/simulation/run", json={"levers": levers}).status_code == 422, why


def test_supported_lever_set_is_unchanged(client):
    assert scenarios.LEVER_KEYS == simulation.LEVER_KEYS == ("discount_pct", "duration_weeks", "spend_amount")


# --- 11: nothing fabricated ------------------------------------------------


@pytest.mark.parametrize("filters", [SINGLE_PROMOTION, MANY_PROMOTIONS, {"year": YEAR}, {}])
def test_no_hypothetical_scenario_receives_fabricated_values(client, filters):
    """11. The guard that runs on real payloads, asserted here on real
    payloads: a hypothetical scenario has no result at all -- not a zero, not
    the baseline's numbers, not the baseline's numbers scaled."""
    payload = _run(client, filters=filters)
    scenarios.assert_no_fabricated_results(payload["scenarios"])

    baseline = payload["kpis"]
    for scenario in payload["scenarios"]:
        if scenario["kind"] != "hypothetical":
            continue
        assert scenario["result"] is None
        assert scenario["result"] != baseline
        assert scenario["result"] != {}
        assert scenario["result"] != 0


def test_guard_rejects_a_fabricated_hypothetical_result():
    """The guard is not decorative -- it fails when the invariant is broken."""
    built = scenarios.build({"discount_pct": 1.0}, {"roi_multiple": {"value": 42}})
    built[1]["result"] = {"roi_multiple": {"value": 99}}  # someone "optimizes" a scenario
    with pytest.raises(AssertionError, match="hypothetical but carries a result"):
        scenarios.assert_no_fabricated_results(built)


# --- 12: Current Plan KPIs are still the Phase A numbers -------------------


@pytest.mark.parametrize("filters", [SINGLE_PROMOTION, MANY_PROMOTIONS, {"year": YEAR}, {}])
def test_current_plan_kpis_match_the_phase_a_endpoint(client, filters):
    """12. B1 changed no number. The Current Plan's result is the same KPI
    block Phase A returned, which is itself the Insights Hub's."""
    payload = _run(client, filters=filters)
    assert payload["scenarios"][0]["result"] == payload["kpis"]
    assert set(payload["kpis"]) == {
        "trade_spend", "incremental_units", "incremental_sales",
        "roi_multiple", "margin_percent", "cannibalization", "pei",
    }


# --- the Current Plan's observed fields ------------------------------------


def test_empty_scope_is_measured_not_unsimulated(client):
    """An empty scope and an unrun scenario are DIFFERENT facts.

    A scope that selects nothing still has a measured result: one whose every
    value is null with a reason. Handing the Current Plan no result at all
    would make it indistinguishable from a scenario nobody has run.
    """
    payload = _run(client, filters={"year": YEAR, "channel": ["CH003"], "city": ["Kolkata"], "month": 1})
    current = payload["scenarios"][0]
    assert current["status"] == "measured"
    assert current["result"] == payload["kpis"], "the measured plan always carries its measurement"
    assert current["result_reason"] is None
    if payload["scope"]["row_count"] == 0:
        assert all(kpi["value"] is None for kpi in current["result"].values())


def test_current_plan_fields_state_their_derivation(client):
    """Every observed value says how it was derived; every unavailable one says
    why. There is no third case."""
    for filters in (SINGLE_PROMOTION, MANY_PROMOTIONS, {"year": YEAR}):
        for field in _run(client, filters=filters)["current_plan"]["fields"]:
            if field["available"]:
                assert field["value"] is not None
                assert field["derivation"], f"{field['key']} has a value with no stated derivation"
                assert field["unavailable_reason"] is None
            else:
                assert field["value"] is None
                assert field["display_value"] is None
                assert field["unavailable_reason"], f"{field['key']} is unavailable with no reason"


def test_duration_is_the_selected_promotion_span_not_a_scope_median(client):
    """§5. With ONE promotion in scope the duration is that promotion's own
    span -- and it is NOT the scope-level median, which is a summary across
    promotions and is retained only for the Phase A contract."""
    payload = _run(client, filters=SINGLE_PROMOTION)
    duration = _field(payload, "duration_weeks")

    assert payload["current_plan"]["single_promotion"] == "PBDI25"
    assert duration["available"] is True
    assert duration["value"] == 4.0, "Diwali Special 25 traded in 2025-W41..W44"
    assert "Diwali Special 25" in duration["derivation"]

    # The observed span and the period agree.
    period = _field(payload, "period")
    assert period["value"] == ["2025-W41", "2025-W44"]


def test_duration_is_unavailable_when_several_promotions_are_in_scope(client):
    """§5. No median stands in for a duration nobody can point at."""
    payload = _run(client, filters=MANY_PROMOTIONS)
    duration = _field(payload, "duration_weeks")

    assert payload["current_plan"]["single_promotion"] is None
    assert duration["available"] is False
    assert duration["value"] is None
    assert "promotions traded in this scope" in duration["unavailable_reason"]

    # The scope median still exists in the response and is NOT what was used.
    assert payload["scope"]["median_promotion_weeks"] > 0


def test_discount_is_derived_from_prices_not_from_the_promotion_name(client):
    """§6. dim_promotion calls PBDI25 a "Buy3Get1"; the depth is read off the
    revenue columns, and its derivation says so."""
    discount = _field(_run(client, filters=SINGLE_PROMOTION), "discount_pct")
    assert discount["available"] is True
    assert "Base Revenue" in discount["derivation"]
    assert "Not taken from the promotion's name or type" in discount["derivation"]


def test_trade_spend_comes_from_the_validated_kpi(client):
    """§7. One trade-spend definition, not a second one for the Current Plan."""
    payload = _run(client, filters=MANY_PROMOTIONS)
    spend = _field(payload, "spend_amount")
    assert spend["value"] == payload["kpis"]["trade_spend"]["value"]
    assert spend["display_value"] == payload["kpis"]["trade_spend"]["display_value"]


def test_current_plan_has_no_values_when_nothing_was_promoted(client):
    """No promotions means no observed plan -- reasons everywhere, values
    nowhere. Never a zero-discount, zero-week "plan"."""
    payload = _run(client, filters={"year": YEAR, "promotion": ["-1"]})
    for key in ("promotion", "period", "discount_pct", "duration_weeks"):
        field = _field(payload, key)
        assert field["available"] is False, key
        assert field["value"] is None, key


# --- levers follow the Current Plan ----------------------------------------


def test_lever_is_offered_only_when_the_current_plan_observed_it(client):
    """A lever with no measured anchor is not offered, and says why. The
    duration lever therefore disappears when the duration cannot be read."""
    for filters in (SINGLE_PROMOTION, MANY_PROMOTIONS, {"year": YEAR}):
        payload = _run(client, filters=filters)
        observed = {f["key"]: f for f in payload["current_plan"]["fields"]}
        for lever in payload["levers"]["definitions"]:
            assert lever["available"] == observed[lever["key"]]["available"], lever["key"]
            if lever["available"]:
                assert lever["value"] == observed[lever["key"]]["value"]
            else:
                assert lever["unavailable_reason"]


def test_duration_lever_disappears_with_several_promotions(client):
    levers = {l["key"]: l for l in _run(client, filters=MANY_PROMOTIONS)["levers"]["definitions"]}
    assert levers["duration_weeks"]["available"] is False
    assert levers["discount_pct"]["available"] is True

    levers = {l["key"]: l for l in _run(client, filters=SINGLE_PROMOTION)["levers"]["definitions"]}
    assert levers["duration_weeks"]["available"] is True
    assert levers["duration_weeks"]["value"] == 4.0


# --- the legacy readers ----------------------------------------------------


def test_legacy_simulation_endpoints_are_gone(client):
    """§16 kept them through B1; they were removed with routers/pages.py once
    nothing called them. The POST that replaced them still answers."""
    assert client.get("/api/simulation-default").status_code == 404
    assert client.get("/api/simulation/diagnostic").status_code in (404, 405)
    assert client.post("/api/simulation/run", json={}).status_code == 200
