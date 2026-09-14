"""Validation for the weekly impact decomposition -- B5.

Two claims to defend, and the tests split along them.

IT RECONCILES. The weekly figures are a decomposition, so the extensive ones
must add back up to the aggregate the same scenario produced -- within the
engine's own rounding and no further. Anything else would mean the weekly view
and the headline disagree about the same scenario.

IT IS NOT A FORECAST. Every week returned is a week the data has rows for. No
week is generated, no trend is fitted, nothing is averaged, and the ratios --
ROI, Margin, Cannibalization -- are never summed.

Run with:

    ../venv/Scripts/python.exe -m pytest tests/ -q
"""

from __future__ import annotations

import json

import pytest
from fastapi.testclient import TestClient

from app.main import app
from app.tpo import response, weekly
from app.tpo.filters import FilterState, rows_for

YEAR = 2025
PROMOTION_SCOPE = {"year": YEAR, "channel": ["CH002"], "promotion": ["PBDU25"]}
CHANNEL_SCOPE = {"year": YEAR, "channel": ["CH002"]}
FULL_YEAR = {"year": YEAR}

ADDITIVE = ("incremental_sales", "incremental_units", "trade_spend")
NON_ADDITIVE = ("roi_multiple", "margin_percent", "cannibalization")


@pytest.fixture(scope="session")
def client():
    return TestClient(app)


def _weekly(client, filters=None, scenario_id="scenario-a", discount_pct=10, expect=200):
    r = client.post(
        "/api/simulation/weekly",
        json={"filters": filters or PROMOTION_SCOPE, "scenario_id": scenario_id,
              "discount_pct": discount_pct},
    )
    assert r.status_code == expect, r.text
    return r.json()


@pytest.fixture(scope="session")
def promotion_weekly(client):
    return _weekly(client)


@pytest.fixture(scope="session")
def channel_weekly(client):
    return _weekly(client, CHANNEL_SCOPE)


# --- 1-2: the weeks themselves ----------------------------------------------


def test_weeks_are_ordered(promotion_weekly, channel_weekly):
    """1."""
    for payload in (promotion_weekly, channel_weekly):
        ordinals = [w["ordinal"] for w in payload["weeks"]]
        assert ordinals == sorted(ordinals)
        ids = [w["week_id"] for w in payload["weeks"]]
        assert ids == sorted(ids)
        assert len(set(ids)) == len(ids), "a week appears twice"


def test_week_labels_and_identifiers(promotion_weekly):
    """2. The project's week convention, from dim_date -- never fact_sales.Month."""
    assert [w["week_id"] for w in promotion_weekly["weeks"]] == [
        "2025-W41", "2025-W42", "2025-W43", "2025-W44"
    ]
    first = promotion_weekly["weeks"][0]
    assert first["week_label"] == "W41 · 2025"
    assert first["ordinal"] == 202541
    assert first["week_start"] == "2025-10-06"
    assert "fact_sales.Month is never read" in promotion_weekly["provenance"]["week_source"]


# --- 3-5: scope -------------------------------------------------------------


@pytest.mark.parametrize("filters", [PROMOTION_SCOPE, CHANNEL_SCOPE, FULL_YEAR])
def test_scope_is_preserved_exactly(client, filters):
    """3, 4, 5. Neither widened nor narrowed."""
    payload = _weekly(client, filters)
    state = FilterState.build(**filters)
    assert payload["scope"]["filters_applied"] == state.applied()
    assert payload["provenance"]["scope"] == state.applied()
    assert payload["scope"]["row_count"] == len(rows_for(state))


def test_every_returned_week_exists_in_the_scope(client):
    """28. No fabricated week -- future or otherwise."""
    for filters in (PROMOTION_SCOPE, CHANNEL_SCOPE):
        payload = _weekly(client, filters)
        real = {r.week_key for r in rows_for(FilterState.build(**filters)) if r.is_promoted}
        assert {w["week_id"] for w in payload["weeks"]} == real


def test_weeks_without_promotion_are_omitted_not_zero_filled(client):
    """19. A week with no promotion has no impact to decompose, and is left
    out rather than returned as a measured zero."""
    payload = _weekly(client, PROMOTION_SCOPE)
    scope = payload["scope"]
    assert scope["weeks_with_promotion"] == len(payload["weeks"])
    assert scope["weeks_without_promotion"] == scope["weeks_in_scope"] - len(payload["weeks"])
    assert "omitted rather than returned as zeroes" in scope["omitted_note"]
    for week in payload["weeks"]:
        assert week["low"]["incremental_sales"]["value"] != 0


# --- 6-9: the scenario ------------------------------------------------------


def test_scenario_and_treatment_are_preserved(client):
    """6, 7, 8."""
    payload = _weekly(client, PROMOTION_SCOPE, scenario_id="optimized-plan", discount_pct=15)
    rule = response.get_treatment_response(15)
    assert payload["scenario_id"] == "optimized-plan"
    assert payload["treatment"] == rule.treatment == "PR003"
    assert payload["discount_pct"] == 15.0
    assert payload["uplift"] == {"low": rule.uplift_low, "high": rule.uplift_high}
    assert payload["provenance"]["uplift_low"] == rule.uplift_low
    assert payload["provenance"]["uplift_high"] == rule.uplift_high


def test_low_and_high_differ_per_week(promotion_weekly):
    """9. Both ends are computed, and they are not the same number."""
    for week in promotion_weekly["weeks"]:
        for metric in ("incremental_sales", "incremental_units"):
            low, high = week["low"][metric]["value"], week["high"][metric]["value"]
            assert low is not None and high is not None
            assert high > low, f"{week['week_id']}/{metric}"


def test_the_caller_cannot_supply_economics(client):
    """The frontend defines no uplift, cost rate or trade spend."""
    for field in ("uplift_low", "uplift_high", "promotion_cost_rate", "trade_spend", "uplift"):
        r = client.post(
            "/api/simulation/weekly",
            json={"filters": PROMOTION_SCOPE, "scenario_id": "a", "discount_pct": 10, field: 0.9},
        )
        assert r.status_code == 422, field


def test_an_unapproved_discount_is_rejected(client):
    r = client.post(
        "/api/simulation/weekly",
        json={"filters": PROMOTION_SCOPE, "scenario_id": "a", "discount_pct": 12},
    )
    assert r.status_code == 422
    assert "not an approved promotion treatment" in r.json()["detail"]


# --- 10-13: no midpoint, no averaging, no forecast --------------------------


def test_no_midpoint_or_average_is_produced(promotion_weekly):
    """10, 11."""
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

    for key in keys(promotion_weekly):
        assert not any(w in key for w in ("midpoint", "average", "mean", "expected")), key

    for week in promotion_weekly["weeks"]:
        for metric in ADDITIVE:
            low, high = week["low"][metric]["value"], week["high"][metric]["value"]
            if low is None or high is None:
                continue
            midpoint = (low + high) / 2
            assert low != midpoint and high != midpoint


def test_nothing_claims_to_be_a_forecast(promotion_weekly):
    """12, 13. The method says what this is; no field says otherwise."""
    assert "not a forecast" in promotion_weekly["provenance"]["method"]
    assert promotion_weekly["range_label"] == "Approved uplift range"

    flat = json.dumps(promotion_weekly, ensure_ascii=False).lower()
    for word in ("confidence interval", "prediction interval", "probability",
                 "predicted", "seasonality", "trend line"):
        assert word not in flat, word


# --- 14-16, 27: reconciliation ----------------------------------------------


@pytest.mark.parametrize("filters", [PROMOTION_SCOPE, CHANNEL_SCOPE, FULL_YEAR])
@pytest.mark.parametrize("metric", ADDITIVE)
@pytest.mark.parametrize("end", ["low", "high"])
def test_additive_metrics_reconcile_to_the_aggregate(client, filters, metric, end):
    """14, 27. THE decomposition property, checked independently of the
    payload's own arithmetic."""
    payload = _weekly(client, filters)
    total = sum(w[end][metric]["value"] or 0.0 for w in payload["weeks"])
    aggregate = payload["aggregate"][end]["kpis"][metric]["value"]

    entry = payload["reconciliation"]["additive"][metric]
    assert entry["summed"] is True
    assert abs(total - aggregate) <= entry["tolerance"], (
        f"{metric}/{end} drifted by {total - aggregate}"
    )
    assert entry[end]["within_tolerance"] is True
    assert entry[end]["weekly_total"] == pytest.approx(total, abs=1e-6)


def test_trade_spend_reconciles_exactly(client):
    """Every row belongs to exactly one week, and the engine does not round
    Trade Spend, so this one should agree to floating-point noise."""
    for filters in (PROMOTION_SCOPE, CHANNEL_SCOPE):
        payload = _weekly(client, filters)
        entry = payload["reconciliation"]["additive"]["trade_spend"]
        assert abs(entry["low"]["difference"]) < 0.01
        assert abs(entry["high"]["difference"]) < 0.01


@pytest.mark.parametrize("metric", NON_ADDITIVE)
def test_ratios_are_never_summed(promotion_weekly, metric):
    """15, 16. A ratio has no weekly total. The entry says so and carries the
    aggregate as the authority instead."""
    entry = promotion_weekly["reconciliation"]["non_additive"][metric]
    assert entry["summed"] is False
    assert "RATIO" in entry["reason"] or "RATE" in entry["reason"]
    assert "weekly_total" not in entry
    assert metric not in promotion_weekly["reconciliation"]["additive"]


def test_weekly_roi_is_computed_not_aggregated(promotion_weekly):
    """16. Weekly ROI is the engine's own function over that week's
    components -- demonstrably neither the sum nor the mean of the weeks."""
    rois = [w["low"]["roi_multiple"]["value"] for w in promotion_weekly["weeks"]]
    assert all(r is not None for r in rois)

    aggregate = promotion_weekly["aggregate"]["low"]["kpis"]["roi_multiple"]["value"]
    assert aggregate != pytest.approx(sum(rois)), "ROI was summed"
    # Each week's ROI is a real ratio in its own right.
    for week in promotion_weekly["weeks"]:
        sales = week["low"]["incremental_sales"]["value"]
        spend = week["low"]["trade_spend"]["value"]
        roi = week["low"]["roi_multiple"]["value"]
        assert roi == pytest.approx(sales / spend, abs=0.005)


def test_the_metric_catalogue_declares_additivity(promotion_weekly):
    """Which metrics may be added is data, not folklore."""
    catalogue = {m["key"]: m for m in promotion_weekly["metrics"]}
    for key in ADDITIVE:
        assert catalogue[key]["additive"] is True
    for key in NON_ADDITIVE:
        assert catalogue[key]["additive"] is False
        assert catalogue[key]["note"]


# --- 17-18: honest absences -------------------------------------------------


def test_an_unavailable_metric_keeps_its_reason(promotion_weekly):
    """17. Cannibalization is unavailable for an offer-filtered slice."""
    for week in promotion_weekly["weeks"]:
        cell = week["low"]["cannibalization"]
        assert cell["available"] is False
        assert cell["value"] is None
        assert cell["unavailable_reason"]


def test_an_unpromoted_scope_is_an_error_not_an_empty_series(client):
    """18. No weeks are fabricated to fill the gap."""
    r = client.post(
        "/api/simulation/weekly",
        json={"filters": {"year": YEAR, "promotion": ["-1"]}, "scenario_id": "a",
              "discount_pct": 10},
    )
    assert r.status_code == 422
    assert "no promotion weeks to decompose" in r.json()["detail"]
    assert "fabricated" in r.json()["detail"]


def test_no_value_is_fabricated(promotion_weekly):
    """29. Every figure is either available with a value, or absent with a
    reason. There is no third case."""
    for week in promotion_weekly["weeks"]:
        for end in ("low", "high"):
            for cell in week[end].values():
                if cell["available"]:
                    assert cell["value"] is not None
                    assert cell["unavailable_reason"] is None
                else:
                    assert cell["value"] is None
                    assert cell["unavailable_reason"]


# --- 20-23: scopes and scenarios differ -------------------------------------


def test_promotion_channel_and_full_year_scopes(client):
    """20, 21, 22."""
    promotion = _weekly(client, PROMOTION_SCOPE)
    channel = _weekly(client, CHANNEL_SCOPE)
    year = _weekly(client, FULL_YEAR)

    assert len(promotion["weeks"]) == 4
    assert len(channel["weeks"]) == 52
    assert len(year["weeks"]) == 52
    assert promotion["scope"]["row_count"] < channel["scope"]["row_count"] < year["scope"]["row_count"]


def test_different_treatments_produce_different_series(client):
    """23."""
    ten = _weekly(client, CHANNEL_SCOPE, discount_pct=10)
    fifteen = _weekly(client, CHANNEL_SCOPE, discount_pct=15)

    assert ten["treatment"] != fifteen["treatment"]
    assert ten["uplift"] != fifteen["uplift"]
    assert [w["low"]["incremental_sales"]["value"] for w in ten["weeks"]] != [
        w["low"]["incremental_sales"]["value"] for w in fifteen["weeks"]
    ]


def test_different_scopes_produce_different_series(client):
    """24, backend half: a series belongs to the scope it was built from, so a
    stale one could never be accidentally right."""
    a = _weekly(client, PROMOTION_SCOPE)
    b = _weekly(client, CHANNEL_SCOPE)
    assert a["weeks"] != b["weeks"]
    assert a["scope"]["filters_applied"] != b["scope"]["filters_applied"]


def test_the_series_varies_across_weeks_where_the_data_does(channel_weekly):
    """A decomposition should show shape where the promotion's footprint
    changes. Over a channel year it does."""
    values = {round(w["low"]["incremental_sales"]["value"], 2) for w in channel_weekly["weeks"]}
    assert len(values) > 1, "every week identical over a full channel year is suspicious"


# --- 25-26: provenance and determinism --------------------------------------


def test_provenance_is_complete(promotion_weekly):
    """25."""
    p = promotion_weekly["provenance"]
    for field in ("scenario_id", "treatment", "discount_pct", "uplift_low", "uplift_high",
                  "response_rule", "kpi_engine", "week_source", "scope", "range_label", "method"):
        assert p[field] is not None, field
    assert p["response_rule"] == response.PROVENANCE
    assert p["kpi_engine"] == "app/tpo/aggregate.calculate_kpis"
    assert p["range_label"] == "Approved uplift range"


def test_repeated_execution_is_deterministic(client):
    """26."""
    results = [_weekly(client, PROMOTION_SCOPE) for _ in range(3)]
    assert all(r == results[0] for r in results)


# --- 30: nothing upstream moved ---------------------------------------------


def test_the_simulate_endpoint_is_unchanged(client):
    """30. B5 decomposes the same counterfactual; it does not alter it."""
    body = {"filters": PROMOTION_SCOPE, "scenario_id": "optimized-plan", "discount_pct": 10}
    before = client.post("/api/simulation/simulate", json=body).json()
    _weekly(client, PROMOTION_SCOPE)
    after = client.post("/api/simulation/simulate", json=body).json()
    assert after == before


def test_the_weekly_aggregate_matches_the_simulate_aggregate(client):
    """The decomposition's own total is the scenario's result -- the weekly
    view and the headline cannot disagree."""
    simulated = client.post(
        "/api/simulation/simulate",
        json={"filters": PROMOTION_SCOPE, "scenario_id": "a", "discount_pct": 10},
    ).json()
    decomposed = _weekly(client, PROMOTION_SCOPE)

    for end in ("low", "high"):
        for metric in ADDITIVE + ("roi_multiple", "margin_percent"):
            assert decomposed["aggregate"][end]["kpis"][metric]["value"] == (
                simulated["result"][end]["kpis"][metric]["value"]
            ), f"{metric}/{end}"


def test_the_weekly_module_runs_no_second_simulation():
    """It slices the counterfactual B2.2 builds; it does not model."""
    import inspect

    source = inspect.getsource(weekly)
    assert "execution.synthesize" in source
    assert "response.get_treatment_response" in source
    # No local response rule, no local uplift, no local cost rate.
    assert "TREATMENT_RULES" not in source
    assert "PROMOTION_COST_RATE =" not in source
