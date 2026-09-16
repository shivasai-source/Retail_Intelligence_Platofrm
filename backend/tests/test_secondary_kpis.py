"""The Insights Hub's second KPI row — Volume Uplift, Net Incremental Profit,
Target Hit Rate.

Two contracts. The six headline cards are FROZEN: `kpis()["kpis"]` must hold
exactly the same six keys it always has, so every other reader of the payload
is untouched. And each second-row card must reconcile to a figure the engine
already reports elsewhere — the debug trace, the Risk Alerts counts — so the
row adds no second definition of anything.
"""

import pytest

from app.tpo import config, service
from app.tpo.filters import FilterState

SIX = ["trade_spend", "incremental_sales", "promotion_roi", "margin_impact", "pei", "cannibalization_rate"]
THREE = ["volume_uplift", "net_incremental_profit", "target_hit_rate"]


@pytest.fixture(scope="module")
def payload():
    return service.kpis(FilterState.build(year=2025), "INR")


def test_the_six_headline_cards_are_exactly_the_six(payload):
    assert list(payload["kpis"]) == SIX


def test_the_second_row_is_its_own_key(payload):
    assert list(payload["secondary"]) == THREE
    for card in payload["secondary"].values():
        assert card["available"] is True
        assert card["info"]["formula"]


def test_every_card_carries_a_reconciliation_line(payload):
    for card in (*payload["kpis"].values(), *payload["secondary"].values()):
        assert card["evidence"], card["key"]


def test_headline_evidence_reads_from_the_debug_trace(payload):
    """The evidence line is a display of numbers the engine already reported,
    never a second computation of them."""
    state = FilterState.build(year=2025)
    d = service._bundle(state)[0].debug
    from app.tpo import formatting as F
    assert payload["kpis"]["trade_spend"]["evidence"] == (
        f"{F.money(d['trade_spend_discount'])} discount given + {F.money(d['trade_spend_promotion_cost'])} promotion cost"
    )
    assert payload["kpis"]["promotion_roi"]["evidence"] == (
        f"{F.money(d['incremental_sales'])} returned on {F.money(d['trade_spend'])} spend · target 1.50"
    )
    assert payload["kpis"]["margin_impact"]["evidence"] == (
        f"{F.money(d['actual_revenue'])} revenue − {F.money(d['total_cost'])} cost"
    )
    events = payload["kpis"]["cannibalization_rate"]["comparable_events"]
    assert payload["kpis"]["cannibalization_rate"]["evidence"] == f"Measured on {events:,} comparable promotion events"


def test_volume_uplift_is_the_pei_component():
    state = FilterState.build(year=2025)
    bundle, _ = service._bundle(state)
    card = service.kpis(state)["secondary"]["volume_uplift"]
    assert card["value"] == bundle.incremental_quantity_percent.value
    assert card["value"] == bundle.debug["incremental_quantity_percent"]


def test_net_incremental_profit_is_the_two_headline_cards_subtracted():
    """A reader can check it from the cards beside it: Incremental Sales
    minus Trade Spend, nothing they cannot see."""
    payload = service.kpis(FilterState.build(year=2025))
    sales = payload["kpis"]["incremental_sales"]["value"]
    spend = payload["kpis"]["trade_spend"]["value"]
    card = payload["secondary"]["net_incremental_profit"]
    assert card["value"] == pytest.approx(sales - spend, abs=0.11)
    # Positive exactly when ROI clears break-even.
    assert (card["value"] > 0) == (payload["kpis"]["promotion_roi"]["value"] > 1.0)


def test_target_hit_rate_is_the_alerts_panels_own_count():
    state = FilterState.build(year=2025)
    counts = service.risk_alerts(state)["counts"]
    card = service.kpis(state)["secondary"]["target_hit_rate"]
    assert card["value"] == round(counts["target_achieved"] / counts["total_events"] * 100, 1)
    assert card["evidence"].startswith(f"{counts['target_achieved']:,} of {counts['total_events']:,} events")


def test_rates_move_in_points_and_money_in_money(payload):
    uplift = payload["secondary"]["volume_uplift"]
    assert uplift["delta_display"].endswith(" pp")
    assert uplift["delta_display"] == f"{uplift['value'] - uplift['previous_value']:+,.1f} pp"
    profit = payload["secondary"]["net_incremental_profit"]
    assert "%" not in profit["delta_display"]
    assert profit["delta_display"].lstrip("+-").startswith("₹")


def test_only_the_currency_card_converts():
    inr = service.kpis(FilterState.build(year=2025), "INR")["secondary"]
    usd = service.kpis(FilterState.build(year=2025), "USD")["secondary"]
    for key in THREE:
        assert inr[key]["value"] == usd[key]["value"]
    assert inr["net_incremental_profit"]["display_value"] != usd["net_incremental_profit"]["display_value"]
    assert inr["volume_uplift"]["display_value"] == usd["volume_uplift"]["display_value"]
    assert inr["target_hit_rate"]["display_value"] == usd["target_hit_rate"]["display_value"]


def test_earliest_year_has_no_fabricated_delta():
    for card in service.kpis(FilterState.build(year=2024))["secondary"].values():
        assert card["delta_display"] == "—"
        assert card["trend"] is None


def test_an_unpromoted_selection_says_so_rather_than_showing_zeros():
    cards = service.kpis(FilterState.build(year=2025, product=["P11-50ml"]))["secondary"]
    for card in cards.values():
        assert card["available"] is False
        assert card["display_value"] == "—"
        assert card["evidence"] is None
        assert card["unavailable_reason"]


def test_target_is_stated_in_the_formula(payload):
    formula = payload["secondary"]["target_hit_rate"]["info"]["formula"]
    assert f"{config.PROMOTION_TARGET_ROI:.2f}" in formula


# --- the reader's target ROI -------------------------------------------------


def test_default_target_is_the_config_default(payload):
    assert payload["meta"]["target_roi"] == config.PROMOTION_TARGET_ROI
    assert payload["meta"]["default_target_roi"] == config.PROMOTION_TARGET_ROI
    assert payload["meta"]["target_roi_range"] == [config.TARGET_ROI_MIN, config.TARGET_ROI_MAX]
    assert payload["meta"]["severity_bands"] == {"critical": 1.25, "high": 1.4, "medium": 1.5}


def test_target_reaches_only_what_is_judged_against_it():
    """A different target changes the hit rate, the alert bands and the money
    at stake -- and not one of the six headline figures."""
    state = FilterState.build(year=2025)
    base, moved = service.kpis(state, "INR", 1.5), service.kpis(state, "INR", 1.75)
    for key in SIX:
        assert base["kpis"][key]["value"] == moved["kpis"][key]["value"]
        assert base["kpis"][key]["delta"] == moved["kpis"][key]["delta"]
    assert moved["secondary"]["target_hit_rate"]["value"] < base["secondary"]["target_hit_rate"]["value"]
    assert moved["secondary"]["volume_uplift"]["value"] == base["secondary"]["volume_uplift"]["value"]
    assert moved["secondary"]["net_incremental_profit"]["value"] == base["secondary"]["net_incremental_profit"]["value"]
    assert "1.75" in moved["kpis"]["promotion_roi"]["info"]["meaning"]
    assert "1.75" in moved["secondary"]["target_hit_rate"]["info"]["formula"]
    assert moved["meta"]["severity_bands"] == {"critical": 1.5, "high": 1.65, "medium": 1.75}


def test_hit_rate_and_alert_counts_agree_at_any_target():
    state = FilterState.build(year=2025)
    for target in (1.2, 1.5, 1.9):
        counts = service.risk_alerts(state, target=target)["counts"]
        card = service.kpis(state, "INR", target)["secondary"]["target_hit_rate"]
        assert card["value"] == round(counts["target_achieved"] / counts["total_events"] * 100, 1)
        assert counts["critical"] + counts["high"] + counts["medium"] + counts["target_achieved"] <= counts["total_events"]


def test_at_stake_is_the_inversion_at_the_requested_target():
    state = FilterState.build(year=2025)
    for event in service.promotion_events(state, 1.8)[:50]:
        expected = max(round(event.trade_spend * 1.8, 1) - event.incremental_sales, 0.0)
        assert event.at_stake == pytest.approx(expected, abs=0.11)


def test_api_rejects_a_target_outside_the_range():
    from fastapi.testclient import TestClient
    from app.main import app
    with TestClient(app) as client:
        assert client.get("/api/command-center/kpis", params={"year": 2025, "target_roi": 2.5}).status_code == 422
        assert client.get("/api/command-center/kpis", params={"year": 2025, "target_roi": 0.9}).status_code == 422
        ok = client.get("/api/command-center/kpis", params={"year": 2025, "target_roi": 1.75})
        assert ok.status_code == 200
        assert ok.json()["meta"]["target_roi"] == 1.75
