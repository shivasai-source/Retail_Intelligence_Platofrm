"""Validation for the Insights Hub -> RCA -> Simulation hand-off -- B3.2.

B3.2 is mostly frontend wiring, so these tests cover the half a server can
actually prove: that a scope narrowed the way the Insights Hub narrows it
survives the context contract intact, reaches the simulation endpoints
unchanged, and carries none of RCA's authored figures with it.

The hand-off narrows by IDENTIFIERS THE SOURCE PROVIDES. A risk alert carries
a real `promotion_id` while its channel and product arrive as display names; an
underperforming row carries the promotion, product and channel codes of the
event it measured. Neither can narrow to a week, because FilterState has none.
So the tests below use the promotion narrowing that is genuinely available, and
assert that nothing invents the rest.

Run with:

    ../venv/Scripts/python.exe -m pytest tests/ -q
"""

from __future__ import annotations

import pytest
from fastapi.testclient import TestClient

from app.main import app
from app.tpo.filters import FilterState, rows_for

YEAR = 2025

#: What the Insights Hub holds when the user has narrowed to Modern Trade.
COMMAND_CENTER_SCOPE = {"year": YEAR, "channel": ["CH002"]}

#: The same scope after clicking a risk alert for PBDI25 -- narrowed by the one
#: identifier a RiskAlert genuinely carries.
HANDED_OFF_SCOPE = {"year": YEAR, "channel": ["CH002"], "promotion": ["PBDI25"]}

REAL_QUESTION = "Did the Diwali 25 Buy3Get1 pay for its giveaway in Modern Trade?"
SEEDED_QUESTION = "Why did South Modern Trade Push underperform despite increased trade spend?"


@pytest.fixture(scope="session")
def client():
    return TestClient(app)


def _context(client, **body):
    r = client.post("/api/simulation/context", json=body)
    assert r.status_code == 200, r.text
    return r.json()


def _run(client, filters):
    r = client.post("/api/simulation/run", json={"filters": filters})
    assert r.status_code == 200, r.text
    return r.json()


def _simulate(client, filters, discount_pct=25, scenario_id="optimized-plan"):
    return client.post(
        "/api/simulation/simulate",
        json={"filters": filters, "scenario_id": scenario_id, "discount_pct": discount_pct},
    )


# --- 1-6: the scope survives the hand-off ----------------------------------


def test_command_center_context_is_preserved(client):
    """1. Everything the Insights Hub held arrives intact."""
    ctx = _context(client, filters=HANDED_OFF_SCOPE, investigation_started=True, question=REAL_QUESTION)
    assert ctx["filter_state"]["value"] == FilterState.build(**HANDED_OFF_SCOPE).applied()
    assert ctx["filter_state"]["source"] == "command_center"


def test_promotion_identifier_is_preserved(client):
    """2. The one identifier a risk alert genuinely carries."""
    ctx = _context(client, filters=HANDED_OFF_SCOPE, investigation_started=True)
    assert ctx["filter_state"]["value"]["promotion"] == ["PBDI25"]
    assert ctx["focus"]["promotion_id"]["value"] == "PBDI25"
    assert ctx["focus"]["promotion_id"]["source"] == "filter_state"


def test_channel_identifier_is_preserved(client):
    """3. From the Insights Hub's own selection -- never parsed out of the
    alert's "Modern Trade" display name."""
    ctx = _context(client, filters=HANDED_OFF_SCOPE, investigation_started=True)
    assert ctx["filter_state"]["value"]["channel"] == ["CH002"]
    assert ctx["focus"]["channel_id"]["value"] == "CH002"


def test_product_identifier_is_preserved_when_available(client):
    """4. WHEN AVAILABLE. A risk alert reports its product as a name, so the
    hand-off cannot narrow by it; if the user's own selection carries a
    product, that survives."""
    without = _context(client, filters=HANDED_OFF_SCOPE, investigation_started=True)
    assert without["focus"]["product_id"]["value"] is None
    assert without["focus"]["product_id"]["reason"]

    with_product = _context(
        client,
        filters={**HANDED_OFF_SCOPE, "product": ["P21-64ct"]},
        investigation_started=True,
    )
    assert with_product["focus"]["product_id"]["value"] == "P21-64ct"


def test_year_is_preserved(client):
    """5."""
    ctx = _context(client, filters=HANDED_OFF_SCOPE, investigation_started=True)
    assert ctx["filter_state"]["value"]["year"] == YEAR
    assert ctx["focus"]["period"]["value"] == "F25 (Annual)"


def test_period_is_preserved_only_where_representable(client):
    """6. A single month survives. An authored RANGE like "Apr - Jun 2025"
    has no representation in FilterState and is not faked into one -- the
    endpoint has no field to receive it."""
    ctx = _context(client, filters={**HANDED_OFF_SCOPE, "month": 10}, investigation_started=True)
    assert ctx["filter_state"]["value"]["month"] == 10
    assert "October" in ctx["focus"]["period"]["value"]

    assert client.post(
        "/api/simulation/context",
        json={"filters": HANDED_OFF_SCOPE, "period_label": "Apr - Jun 2025"},
    ).status_code == 422


# --- 7-8: the question ------------------------------------------------------


def test_a_genuinely_entered_question_is_preserved(client):
    """7."""
    ctx = _context(client, filters=HANDED_OFF_SCOPE, question=REAL_QUESTION, investigation_started=True)
    assert ctx["question"] == {"value": REAL_QUESTION, "source": "rca", "reason": None}


def test_the_seeded_example_is_not_treated_as_a_real_question(client):
    """8. Both ways it can arrive: as the store's untouched default, and as a
    seeded example the user happened to submit."""
    fresh = _context(client, filters=HANDED_OFF_SCOPE, question=SEEDED_QUESTION, investigation_started=False)
    assert fresh["question"]["value"] is None
    assert fresh["question"]["source"] == "seed_example"

    submitted = _context(client, filters=HANDED_OFF_SCOPE, question=SEEDED_QUESTION, investigation_started=True)
    assert submitted["question"]["value"] is None
    assert submitted["question"]["source"] == "seed_example"


# --- 9-10: metadata RCA does not have --------------------------------------


def test_missing_investigation_id_remains_unavailable(client):
    """9. B3.2 generates no id to fill the gap."""
    ctx = _context(client, filters=HANDED_OFF_SCOPE, question=REAL_QUESTION, investigation_started=True)
    assert ctx["investigation_id"]["value"] is None
    assert ctx["investigation_id"]["source"] == "unavailable"
    assert "investigation_id" in ctx["missing"]


def test_missing_kpi_remains_unavailable(client):
    """10."""
    ctx = _context(client, filters=HANDED_OFF_SCOPE, question=REAL_QUESTION, investigation_started=True)
    assert ctx["focus"]["kpi"]["value"] is None
    assert ctx["focus"]["kpi"]["source"] == "unavailable"


# --- 11: RCA's numbers never enter Simulation -------------------------------


def test_rca_kpi_values_are_never_passed_into_simulation(client):
    """11. THE rule of this phase.

    RCA's authored chips report a trade spend of Rs 98.6 Cr where the engine
    measures a fraction of that. The context carries no KPI value at all, and
    the endpoint refuses one; Simulation's figures keep coming from /run and
    /simulate.
    """
    ctx = _context(client, filters=HANDED_OFF_SCOPE, question=REAL_QUESTION, investigation_started=True)
    assert ctx["carries_kpi_values"] is False
    flat = str(ctx).lower()
    for token in ("98.6", "trade_spend", "roi", "incremental", "margin", "pei", "at_stake"):
        assert token not in flat, f"the hand-off carried a KPI value: {token}"

    for field in ("trade_spend", "at_stake", "roi_multiple"):
        assert client.post(
            "/api/simulation/context", json={"filters": HANDED_OFF_SCOPE, field: 98.6}
        ).status_code == 422


def test_simulation_measures_the_handed_off_scope_itself(client):
    """The numbers under an investigation are the engine's, for the scope the
    hand-off carried -- not anything RCA said about it."""
    ctx = _context(client, filters=HANDED_OFF_SCOPE, question=REAL_QUESTION, investigation_started=True)
    run = _run(client, ctx["filter_state"]["value"])

    direct = _run(client, HANDED_OFF_SCOPE)
    assert run["kpis"] == direct["kpis"]
    assert run["scope"]["row_count"] == len(rows_for(FilterState.build(**HANDED_OFF_SCOPE)))


# --- 12-13: the same FilterState, and invalidation --------------------------


@pytest.mark.parametrize("filters", [COMMAND_CENTER_SCOPE, HANDED_OFF_SCOPE, {"year": YEAR}])
def test_simulation_receives_the_same_filter_state(client, filters):
    """12. What the context reports IS what the simulation endpoints select."""
    ctx = _context(client, filters=filters, investigation_started=True)
    handed = ctx["filter_state"]["value"]

    run = _run(client, handed)
    assert run["scope"]["filters_applied"] == FilterState.build(**filters).applied()
    assert run["context"]["filters_applied"] == handed


def test_a_different_investigation_scope_produces_a_different_result(client):
    """13. The backend half of scenario invalidation: the same treatment over
    a different hand-off scope is a different answer, so a stale result can
    never be silently correct.

    The frontend half -- reseeding the scenario store when the scope key
    changes -- is B2.3 behaviour and is exercised by the live smoke test.
    """
    narrow = _simulate(client, HANDED_OFF_SCOPE)
    wide = _simulate(client, COMMAND_CENTER_SCOPE)
    assert narrow.status_code == 200 and wide.status_code == 200
    assert narrow.json()["result"] != wide.json()["result"]
    assert narrow.json()["scope"]["filters_applied"] != wide.json()["scope"]["filters_applied"]


# --- 14-16: nothing else moved ---------------------------------------------


def test_direct_entry_still_works(client):
    """14. No investigation, no question, no hand-off -- the original path."""
    ctx = _context(client, filters=COMMAND_CENTER_SCOPE)
    assert ctx["question"]["value"] is None
    assert ctx["filter_state"]["value"] == FilterState.build(**COMMAND_CENTER_SCOPE).applied()

    run = _run(client, COMMAND_CENTER_SCOPE)
    assert run["kpis"]["trade_spend"]["available"] is True
    assert _simulate(client, COMMAND_CENTER_SCOPE, discount_pct=10).status_code == 200


def test_run_behaviour_is_unchanged(client):
    """15."""
    payload = _run(client, COMMAND_CENTER_SCOPE)
    assert set(payload) == {
        "scenario", "context", "current_plan", "scenarios", "scope", "levers", "kpis", "meta"
    }
    assert payload["meta"]["phase"] == "A"
    assert payload["scenarios"][0]["status"] == "measured"
    for scenario in payload["scenarios"][1:]:
        assert scenario["status"] == "not_simulated" and scenario["result"] is None


def test_simulate_behaviour_is_unchanged(client):
    """16."""
    payload = _simulate(client, HANDED_OFF_SCOPE, discount_pct=25).json()
    assert payload["treatment"] == "PB001"
    assert payload["uplift"] == {"low": 0.60, "high": 0.72}
    assert payload["range_label"] == "Approved uplift range"
    assert payload["provenance"]["kpi_engine"] == "app/tpo/aggregate.calculate_kpis"


def test_building_a_context_does_not_perturb_a_simulation(client):
    """The hand-off holds no state and feeds nothing into the engine."""
    before = _simulate(client, HANDED_OFF_SCOPE).json()
    _context(client, filters=HANDED_OFF_SCOPE, question=REAL_QUESTION, investigation_started=True)
    _context(client, filters=COMMAND_CENTER_SCOPE, investigation_started=False)
    assert _simulate(client, HANDED_OFF_SCOPE).json() == before
