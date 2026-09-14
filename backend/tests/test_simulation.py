"""Validation for the Simulation Studio -- Phase A.

The point of Phase A is that the Simulation Studio stopped computing and
started reading. So most of what follows is PARITY testing: every figure the
simulation endpoint returns must be the identical object the validated engine
produces for the same scope. If someone reintroduces a formula here, these
tests fail.

The other half is the honesty contract: levers are echoed, levers change
nothing, and nothing fabricated (confidence, risk, weekly series, a
recommendation) appears in the payload.

Run with:

    ../venv/Scripts/python.exe -m pytest tests/ -q
"""

from __future__ import annotations

import pytest
from fastapi.testclient import TestClient

from app.main import app
from app.routers.simulation import SimulationFilters
from app.tpo import aggregate as A
from app.tpo import config
from app.tpo import service, simulation
from app.tpo.filters import DIMENSIONS, FilterState, baseline_rows_for, rows_for

YEAR = 2025

#: Scopes exercised by the parity tests. Deliberately spans the awkward cases:
#: no filter at all, a single month, an Offer filter (which is what makes the
#: baseline-widened row set differ from the selection), and a Product filter
#: (which is what makes cannibalization widen to the Brand Form).
SCOPES: tuple[tuple[str, dict], ...] = (
    ("no filters", {}),
    ("year", {"year": YEAR}),
    ("year+month", {"year": YEAR, "month": 3}),
    ("channel", {"year": YEAR, "channel": ["CH002"]}),
    ("region", {"year": YEAR, "region": ["South"]}),
    ("offer", {"year": YEAR, "promotion": ["PR001"]}),
    ("product", {"year": YEAR, "product": ["P21-64ct"]}),
    ("combined", {"year": YEAR, "channel": ["CH002"], "category": ["Baby Care"]}),
)


@pytest.fixture(scope="session")
def client():
    return TestClient(app)


def _run(client, **body):
    response = client.post("/api/simulation/run", json=body)
    assert response.status_code == 200, response.text
    return response.json()


# --- 1-3: the endpoint itself ----------------------------------------------


def test_endpoint_responds(client):
    """1. POST /api/simulation/run exists and answers with a full payload."""
    payload = _run(client)
    for block in ("scenario", "scope", "levers", "kpis", "meta"):
        assert block in payload, f"missing response block: {block}"
    assert payload["meta"]["phase"] == "A"
    assert payload["scenario"]["modelled"] is False


@pytest.mark.parametrize("name,kwargs", SCOPES)
def test_valid_filter_state_works(client, name, kwargs):
    """2. Every filter combination the Command Center accepts is accepted here
    and returns the scope it was asked for."""
    payload = _run(client, filters=kwargs)
    applied = payload["scope"]["filters_applied"]
    assert applied == FilterState.build(**kwargs).applied(), name
    assert payload["scope"]["row_count"] > 0, f"{name}: scope selected no rows"


@pytest.mark.parametrize(
    "body,why",
    [
        ({"filters": {"month": 13}}, "month out of range"),
        ({"filters": {"nonsense": ["x"]}}, "unknown filter dimension"),
        ({"levers": {"incentive_pct": 3.5}}, "lever that does not exist"),
        ({"levers": {"discount_pct": -4}}, "negative discount"),
        ({"currency": "GBP"}, "unsupported currency"),
    ],
)
def test_invalid_request_is_rejected(client, body, why):
    """3. An invalid request is a 422, not a silent success.

    The lever case matters most: a client posting `incentive_pct` must be told
    the lever does not exist rather than be left believing a retailer incentive
    was taken into account.
    """
    assert client.post("/api/simulation/run", json=body).status_code == 422, why


# --- 4-10: KPI parity with the validated engine ----------------------------
#
# One test per required figure. Each asserts the endpoint's number IS the
# engine's number for the same scope -- not close to it, not rounded from it.

#: Simulation output key -> the aggregate call that defines it. `rows` is the
#: selection; `vrows` is the baseline-widened set the volume chain reads.
PARITY = {
    "trade_spend": lambda rows, vrows: A.calculate_trade_spend(rows),
    "incremental_units": lambda rows, vrows: A.calculate_incremental_quantity(vrows),
    "incremental_sales": lambda rows, vrows: A.calculate_incremental_sales(vrows),
    "roi_multiple": lambda rows, vrows: A.calculate_roi(rows, vrows),
    "margin_percent": lambda rows, vrows: A.calculate_margin(rows),
    "pei": lambda rows, vrows: A.calculate_pei(rows, vrows),
}


@pytest.mark.parametrize("key", sorted(PARITY))
@pytest.mark.parametrize("name,kwargs", SCOPES)
def test_kpi_equals_validated_engine(client, key, name, kwargs):
    """4-8, 10. ROI, margin, trade spend, incremental units, incremental sales
    and PEI each equal the aggregate.py figure for the same scope."""
    state = FilterState.build(**kwargs)
    rows = rows_for(state)
    vrows = baseline_rows_for(state) if rows else ()

    expected = PARITY[key](rows, vrows)
    actual = _run(client, filters=kwargs)["kpis"][key]["value"]
    assert actual == expected, f"{name}: {key} diverged from the engine"


@pytest.mark.parametrize("name,kwargs", SCOPES)
def test_cannibalization_equals_validated_engine(client, name, kwargs):
    """9. Cannibalization equals the engine's rate -- including its Brand-Form
    widening, which is why it cannot be checked with the others."""
    state = FilterState.build(**kwargs)
    expected = service.kpis(state)["kpis"]["cannibalization_rate"]["value"]
    actual = _run(client, filters=kwargs)["kpis"]["cannibalization"]["value"]
    assert actual == expected, name


@pytest.mark.parametrize("name,kwargs", SCOPES)
def test_every_kpi_matches_the_command_center_card(client, name, kwargs):
    """The stronger statement the two tests above imply: for one scope, the
    Simulation Studio and the Command Center show the SAME numbers. This is the
    test that fails if a formula is ever reintroduced into the simulation."""
    cards = service.kpis(FilterState.build(**kwargs))["kpis"]
    kpis = _run(client, filters=kwargs)["kpis"]
    for kpi in simulation.SIMULATION_KPIS:
        if kpi.card_key is None:
            continue
        assert kpis[kpi.key]["value"] == cards[kpi.card_key]["value"], f"{name}: {kpi.key}"
        assert kpis[kpi.key]["display_value"] == cards[kpi.card_key]["display_value"]


def test_roi_is_the_one_roi_formula(client):
    """ROI is INCREMENTAL sales over spend against the project target, never revenue/spend.

    The client-side engine this phase replaced returned `revenue / spend` --
    around 2.1 where the validated ROI for the same scope is a multiple of
    trade spend with a different numerator.
    Asserting the identity rather than a frozen number keeps this true when the
    dataset is regenerated.
    """
    state = FilterState.build(year=YEAR)
    rows, vrows = rows_for(state), baseline_rows_for(state)
    spend = A.calculate_trade_spend(rows)
    sales = A.calculate_incremental_sales(vrows)

    roi = _run(client, filters={"year": YEAR})["kpis"]["roi_multiple"]
    # Against `roi_multiple` itself, so the rounding rule is the engine's too.
    assert roi["value"] == A.roi_multiple(sales, spend)
    assert roi["value"] == pytest.approx(sales / spend, abs=0.005)
    assert roi["unit"] == "multiple"
    # A bare number: no unit sign, no percent sign.
    assert roi["display_value"] == f"{roi['value']:.2f}"
    assert "Trade Spend" in roi["formula"]
    # And the target it is read against is the project's one target.
    assert _run(client, filters={"year": YEAR})["meta"]["target_roi"] == config.PROMOTION_TARGET_ROI


# --- 11-12: the Phase A honesty contract -----------------------------------


def test_submitted_levers_are_echoed(client):
    """11. What was posted comes back, unchanged and complete."""
    levers = {"discount_pct": 12.5, "duration_weeks": 8, "spend_amount": 140}
    block = _run(client, filters={"year": YEAR}, levers=levers)["levers"]
    assert block["submitted"] == levers
    assert block["applied"] is False
    assert block["note"] == simulation.LEVERS_NOT_MODELLED


@pytest.mark.parametrize(
    "levers",
    [
        None,
        {"discount_pct": 0},
        {"discount_pct": 30, "duration_weeks": 12, "spend_amount": 900},
        {"discount_pct": 5, "duration_weeks": 2, "spend_amount": 10},
    ],
)
def test_levers_do_not_fabricate_kpi_changes(client, levers):
    """12. THE Phase A guarantee. Moving every lever to an extreme moves not
    one number, because nothing models them yet."""
    baseline = _run(client, filters={"year": YEAR})["kpis"]
    actual = _run(client, filters={"year": YEAR}, levers=levers)["kpis"]
    assert actual == baseline, "levers changed a KPI with no response model behind them"


def test_no_fabricated_metrics_are_returned(client):
    """Nothing that was mock survives in the payload. Named explicitly so
    reintroducing one is a deliberate act with a failing test attached."""
    payload = _run(client, filters={"year": YEAR})
    forbidden = (
        "confidence", "risk", "prob", "probability", "sellthrough", "sell_through",
        "weekly", "trajectory", "recommendation", "recommended", "breakeven",
        "break_even", "peak_roi",
    )
    flat = str(payload).lower()
    for word in forbidden:
        assert word not in flat, f"Phase A payload contains fabricated field: {word}"


def test_kpis_are_the_seven_required_figures(client):
    """The required output set, no more and no less."""
    assert set(_run(client)["kpis"]) == {
        "trade_spend", "incremental_units", "incremental_sales",
        "roi_multiple", "margin_percent", "cannibalization", "pei",
    }


# --- the filter contract ---------------------------------------------------


def test_request_model_matches_the_one_filter_contract():
    """The request body cannot drift from `FilterState`.

    This is what keeps `SimulationFilters` a transport shape rather than a
    second filter model: adding a dimension to filters.DIMENSIONS and not here
    fails immediately.
    """
    assert set(SimulationFilters.model_fields) == set(DIMENSIONS)


def test_unavailable_kpi_is_null_and_explained(client):
    """A KPI the selection cannot support comes back null with a reason --
    never a fabricated zero. An unpromoted Offer scope is the natural case."""
    payload = _run(client, filters={"year": YEAR, "promotion": ["-1"]})
    pei = payload["kpis"]["pei"]
    assert pei["value"] is None
    assert pei["available"] is False
    assert pei["unavailable_reason"]


def test_empty_scope_reports_no_data_rather_than_zeroes(client):
    """A scope that selects nothing says so. Every KPI is null, not 0."""
    payload = _run(client, filters={"year": YEAR, "month": 1, "region": ["South"], "channel": ["CH003"], "city": ["Kolkata"]})
    if payload["scope"]["row_count"] == 0:
        assert payload["scope"]["has_data"] is False
        assert all(k["value"] is None for k in payload["kpis"].values())


# --- levers are anchored on measurements, not on invented numbers ----------


@pytest.mark.parametrize("name,kwargs", SCOPES)
def test_lever_definitions_are_anchored_on_the_scope(client, name, kwargs):
    """Every offered lever states the measurement it came from, and its
    default sits inside the range it offers."""
    payload = _run(client, filters=kwargs)
    definitions = payload["levers"]["definitions"]
    assert [d["key"] for d in definitions] == list(simulation.LEVER_KEYS)

    for lever in definitions:
        if not lever["available"]:
            assert lever["value"] is None and lever["unavailable_reason"], f"{name}: {lever['key']}"
            continue
        assert lever["basis"], f"{name}: {lever['key']} has no stated basis"
        assert lever["min"] <= lever["value"] <= lever["max"], f"{name}: {lever['key']}"


def test_spend_lever_is_anchored_on_measured_trade_spend(client):
    """The spend slider tracks the scope's real Trade Spend, so the control and
    the KPI beside it are on the same scale."""
    payload = _run(client, filters={"year": YEAR})
    spend_lever = next(d for d in payload["levers"]["definitions"] if d["key"] == "spend_amount")
    assert spend_lever["value"] == pytest.approx(payload["kpis"]["trade_spend"]["value"], rel=1e-6)


def test_unbacked_levers_are_not_offered():
    """Retailer Incentive and Inventory Allocation have no field in any of the
    five datasets. They are not levers until they do."""
    assert "incentive_pct" not in simulation.LEVER_KEYS
    assert "inventory_allocation" not in simulation.LEVER_KEYS
