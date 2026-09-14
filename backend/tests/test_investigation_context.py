"""Validation for the RCA -> Simulation context contract -- B3.1.

The contract's whole job is to be honest about a handoff whose upstream is
mostly static. So the tests are about what it REFUSES to do:

  * refuse to report the seeded example question as the user's question;
  * refuse to invent an investigation id, a problem statement or a KPI;
  * refuse to carry any KPI VALUE at all, because RCA's figures are display
    copy and one of them contradicts the validated engine by an order of
    magnitude;
  * refuse to build a second filter model out of RCA's display strings.

And, throughout: that B2.2's simulation is untouched by any of it.

Run with:

    ../venv/Scripts/python.exe -m pytest tests/ -q
"""

from __future__ import annotations

import pytest
from fastapi.testclient import TestClient

from app.data_loader import load
from app.main import app
from app.routers.simulation import InvestigationContextRequest, SimulationFilters
from app.tpo import investigation
from app.tpo.filters import DIMENSIONS, FilterState, rows_for

YEAR = 2025
SCOPE = {"year": YEAR, "channel": ["CH002"]}
FOCUSED = {"year": YEAR, "promotion": ["PBDI25"], "channel": ["CH002"], "region": ["South"]}

#: A question no seeded example contains.
REAL_QUESTION = "Did Diwali 25 pay for its Buy3Get1 giveaway in Modern Trade?"


@pytest.fixture(scope="session")
def client():
    return TestClient(app)


def _context(client, **body):
    response = client.post("/api/simulation/context", json=body)
    assert response.status_code == 200, response.text
    return response.json()


# --- 1-2: a valid context ---------------------------------------------------


def test_valid_investigation_context(client):
    """1. A real investigation produces a complete-as-possible context."""
    ctx = _context(
        client,
        filters=FOCUSED,
        question=REAL_QUESTION,
        investigation_started=True,
        investigation_type="diagnostic",
    )
    assert ctx["source"] == "rca"
    assert ctx["question"] == {"value": REAL_QUESTION, "source": "rca", "reason": None}
    assert ctx["investigation_type"]["value"] == "diagnostic"
    assert ctx["scope"]["has_data"] is True
    assert ctx["scope"]["row_count"] == len(rows_for(FilterState.build(**FOCUSED)))


def test_investigation_id_is_preserved_when_one_exists(client):
    """2. RCA has no id today, but the contract carries one when supplied --
    the field is not decorative."""
    ctx = _context(client, filters=SCOPE, investigation_id="inv-2025-014", investigation_started=True)
    assert ctx["investigation_id"] == {"value": "inv-2025-014", "source": "rca", "reason": None}
    assert "investigation_id" not in ctx["missing"]


def test_missing_investigation_id_is_reported_not_invented(client):
    """9. No id, no fabricated id. The gap is named and explained."""
    ctx = _context(client, filters=SCOPE, investigation_started=True, question=REAL_QUESTION)
    field = ctx["investigation_id"]
    assert field["value"] is None
    assert field["source"] == "unavailable"
    assert "no identifier" in field["reason"]
    assert "investigation_id" in ctx["missing"]


# --- 3-4: the filter contract ----------------------------------------------


@pytest.mark.parametrize("filters", [SCOPE, FOCUSED, {"year": YEAR}, {}])
def test_filter_state_is_preserved_exactly(client, filters):
    """3. The scope handed in is the scope handed on -- the same FilterState
    the simulation endpoints take, not a translation of it."""
    ctx = _context(client, filters=filters, investigation_started=True)
    assert ctx["filter_state"]["value"] == FilterState.build(**filters).applied()
    assert ctx["filter_state"]["source"] == "command_center"


def test_no_second_filter_model_exists():
    """4. The request reuses the simulation endpoints' own filter shape, whose
    fields are asserted elsewhere to be exactly filters.DIMENSIONS."""
    assert InvestigationContextRequest.model_fields["filters"].annotation is SimulationFilters
    assert set(SimulationFilters.model_fields) == set(DIMENSIONS)


def test_rca_display_strings_are_not_converted_into_filters(client):
    """RCA's context chips read "Modern Trade" and "Apr - Jun 2025". Nothing
    turns those into a Channel_Id or a month range -- that guess is the second
    filter model this contract exists to avoid. The endpoint accepts no such
    field at all."""
    rejected = client.post(
        "/api/simulation/context",
        json={"filters": SCOPE, "context_chips": {"channel": "Modern Trade", "period": "Apr - Jun 2025"}},
    )
    assert rejected.status_code == 422


# --- 5: the question --------------------------------------------------------


def test_missing_question_is_represented_honestly(client):
    """5. No question, no invented question."""
    ctx = _context(client, filters=SCOPE, investigation_started=True)
    field = ctx["question"]
    assert field["value"] is None
    assert field["source"] == "unavailable"
    assert "does not provide a structured question" in field["reason"]
    assert "question" in ctx["missing"]


@pytest.mark.parametrize("question", sorted(investigation.seeded_questions())[:6])
def test_a_seeded_example_question_is_never_reported_as_the_users(client, question):
    """THE guard against the hardcoded question.

    `store/activeInvestigation.ts` seeds itself with an example copied from
    investigation-types.json, so a user who has never run an investigation is
    still carrying one. Reporting it as the investigation's question would put
    an authored sentence in front of the user as though they had asked it.
    """
    ctx = _context(client, filters=SCOPE, question=question, investigation_started=True)
    assert ctx["question"]["value"] is None
    assert ctx["question"]["source"] == "seed_example"
    assert "not a question the user asked" in ctx["question"]["reason"]


def test_the_store_default_question_is_one_of_the_seeded_examples():
    """The specific sentence `activeInvestigation.ts` defaults to is exactly an
    example from investigation-types.json -- which is why the guard above
    catches it. If the store's default ever stops matching, this fails and the
    guard needs another way to recognise it."""
    default = "Why did South Modern Trade Push underperform despite increased trade spend?"
    assert investigation._normalise(default) in investigation.seeded_questions()
    assert any(a.get("example") == default for a in load("investigation-types"))


def test_a_question_from_an_unstarted_investigation_is_not_the_users(client):
    """Even a novel-looking question is not the user's if they never ran an
    investigation -- the client says so with `investigation_started`."""
    ctx = _context(client, filters=SCOPE, question=REAL_QUESTION, investigation_started=False)
    assert ctx["question"]["value"] is None
    assert ctx["question"]["source"] == "seed_example"


def test_whitespace_and_case_do_not_defeat_the_seed_guard(client):
    """A question makes a round trip through an input box before it gets here."""
    seeded = "  WHY DID South   Modern Trade Push underperform despite increased trade spend? "
    ctx = _context(client, filters=SCOPE, question=seeded, investigation_started=True)
    assert ctx["question"]["value"] is None


# --- 6: focus ---------------------------------------------------------------


def test_focus_is_only_what_the_scope_actually_establishes(client):
    """6. A focus is a point. A dimension constrained to exactly one value
    gives one; anything else is unavailable with the reason."""
    ctx = _context(client, filters=FOCUSED, investigation_started=True)
    focus = ctx["focus"]

    assert focus["promotion_id"] == {"value": "PBDI25", "source": "filter_state", "reason": None}
    assert focus["channel_id"]["value"] == "CH002"
    assert focus["region"]["value"] == "South"
    assert focus["period"]["value"] == "F25 (Annual)"

    # Not constrained -> no focus on it, and the reason says what would give one.
    assert focus["product_id"]["value"] is None
    assert "Constrain product" in focus["product_id"]["reason"]


def test_a_multi_value_dimension_is_not_a_focus(client):
    """Two channels is not a channel focus."""
    ctx = _context(client, filters={"year": YEAR, "channel": ["CH001", "CH002"]}, investigation_started=True)
    assert ctx["focus"]["channel_id"]["value"] is None


def test_kpi_under_investigation_is_always_unavailable(client):
    """6. RCA records no KPI. The field exists so the contract need not change
    shape when it does, and it is honest until then."""
    ctx = _context(client, filters=FOCUSED, investigation_started=True)
    kpi = ctx["focus"]["kpi"]
    assert kpi["value"] is None
    assert kpi["source"] == "unavailable"
    assert "does not record which KPI" in kpi["reason"]


def test_missing_problem_statement_is_honest(client):
    ctx = _context(client, filters=SCOPE, investigation_started=True)
    assert ctx["problem_statement"]["value"] is None
    assert "no problem statement" in ctx["problem_statement"]["reason"]


# --- 7: no static KPI values -----------------------------------------------


@pytest.mark.parametrize("filters", [SCOPE, FOCUSED, {"year": YEAR}])
def test_no_kpi_value_is_carried_by_the_context(client, filters):
    """7. THE rule that keeps RCA's fiction out of Simulation.

    RCA's context chips report a trade spend of Rs 98.6 Cr for a scope the
    validated engine measures at Rs 7.7 Cr. No KPI value of any kind travels
    in this contract -- the scope travels instead, and Simulation measures it.
    """
    ctx = _context(client, filters=filters, investigation_started=True)
    assert ctx["carries_kpi_values"] is False

    flat = str(ctx).lower()
    for kpi in ("trade_spend", "roi", "incremental_sales", "incremental_units", "margin", "pei", "98.6"):
        assert kpi not in flat, f"the context carries a KPI value: {kpi}"


def test_the_endpoint_refuses_kpi_values_outright(client):
    """A caller cannot smuggle one in either."""
    for field in ("trade_spend", "roi_multiple", "incremental_sales", "kpi_values"):
        response = client.post("/api/simulation/context", json={"filters": SCOPE, field: 123})
        assert response.status_code == 422, field


# --- 8: provenance ----------------------------------------------------------


def test_every_field_carries_provenance(client):
    """8. Value plus source, always -- and a null value always has a reason."""
    ctx = _context(client, filters=FOCUSED, question=REAL_QUESTION, investigation_started=True)
    fields = [ctx[k] for k in ("investigation_id", "investigation_type", "question", "problem_statement", "filter_state")]
    fields += list(ctx["focus"].values())

    legal = {"rca", "command_center", "filter_state", "seed_example", "unavailable"}
    for field in fields:
        assert set(field) == {"value", "source", "reason"}
        assert field["source"] in legal
        if field["value"] is None:
            assert field["reason"], "a missing value must say why"
        else:
            assert field["reason"] is None


def test_missing_lists_exactly_the_absent_fields(client):
    ctx = _context(client, filters=FOCUSED, question=REAL_QUESTION, investigation_started=True)
    for name in ("investigation_id", "problem_statement"):
        assert name in ctx["missing"]
    assert "question" not in ctx["missing"]
    assert "focus.promotion_id" not in ctx["missing"]
    assert "focus.kpi" in ctx["missing"]
    assert ctx["complete"] is False


# --- 9: bad input -----------------------------------------------------------


@pytest.mark.parametrize(
    "body",
    [
        {"filters": {"month": 13}},
        {"filters": {"nonsense": ["x"]}},
        {"filters": SCOPE, "investigation_id": "x" * 65},
        {"filters": SCOPE, "unknown_field": 1},
    ],
)
def test_malformed_context_requests_are_rejected(client, body):
    """9."""
    assert client.post("/api/simulation/context", json=body).status_code == 422


def test_an_empty_scope_is_reported_not_rejected(client):
    """A scope selecting nothing is a valid context about an empty scope."""
    ctx = _context(client, filters={"year": YEAR, "channel": ["CH003"], "city": ["Kolkata"], "month": 1}, investigation_started=True)
    assert ctx["scope"]["has_data"] == (ctx["scope"]["row_count"] > 0)


# --- 10-11: nothing downstream moved ---------------------------------------


def test_simulation_endpoints_remain_compatible(client):
    """10. /run and /simulate are untouched by the new contract."""
    run = client.post("/api/simulation/run", json={"filters": SCOPE})
    assert run.status_code == 200
    payload = run.json()
    assert set(payload) == {
        "scenario", "context", "current_plan", "scenarios", "scope", "levers", "kpis", "meta"
    }
    assert payload["meta"]["phase"] == "A"

    simulate = client.post(
        "/api/simulation/simulate",
        json={"filters": SCOPE, "scenario_id": "optimized-plan", "discount_pct": 10},
    )
    assert simulate.status_code == 200
    assert simulate.json()["treatment"] == "PR002"


def test_b22_scenario_calculation_is_unchanged_by_building_a_context(client):
    """11. Building a context must not perturb a simulation -- the contract
    holds no state and feeds nothing into the engine."""
    body = {"filters": FOCUSED, "scenario_id": "optimized-plan", "discount_pct": 25}
    before = client.post("/api/simulation/simulate", json=body).json()

    _context(client, filters=FOCUSED, question=REAL_QUESTION, investigation_started=True)
    _context(client, filters=SCOPE, investigation_started=False)

    after = client.post("/api/simulation/simulate", json=body).json()
    assert after == before


def test_the_context_endpoint_runs_no_scenario(client):
    """The contract is plumbing: no treatment, no uplift, no result."""
    ctx = _context(client, filters=FOCUSED, question=REAL_QUESTION, investigation_started=True)
    flat = str(ctx).lower()
    for word in ("treatment", "uplift", "simulated", "scenario_id", "provenance_rule"):
        assert word not in flat, f"the context endpoint leaked simulation output: {word}"
