"""The end-to-end TPO journey, frozen -- B3.3.

Command Center -> RCA -> Simulation Studio -> hypothetical scenario -> real
result. Every earlier phase has its own suite; this one walks the whole chain
in a single pass and asserts the properties that only appear when the parts are
joined together.

WHY THIS FILE EXISTS. B3.3 is a freeze, and a freeze that is only a manual
smoke test is a freeze that thaws the first time somebody refactors. The
journey is written down here so a future change that breaks the hand-off fails
a test rather than being discovered in a demo.

The four properties worth stating plainly, because each one is a way the chain
could quietly become wrong:

  1. THE SCOPE IS ONE SCOPE. What the Command Center selected, what the context
     reports, and what /run and /simulate measure are the same FilterState. Not
     equivalent, not converted -- the same.
  2. NO AUTHORED NUMBER CROSSES THE BOUNDARY. RCA's chips report a trade spend
     of Rs 98.6 Cr against an engine that measures a fraction of it. None of
     RCA's figures may appear downstream.
  3. A RESULT BELONGS TO ITS SCOPE AND ITS TREATMENT. Change either and the
     answer changes, so a stale result on screen could never be accidentally
     right.
  4. RCA IS NOT REQUIRED. Simulation opened directly still works.

Run with:

    ../venv/Scripts/python.exe -m pytest tests/ -q
"""

from __future__ import annotations

import json

import pytest
from fastapi.testclient import TestClient

from app.main import app
from app.tpo.filters import FilterState

YEAR = 2025
COMMAND_CENTER_SCOPE = {"year": YEAR, "channel": ["CH002"]}
SEEDED_QUESTION = "Why did South Modern Trade Push underperform despite increased trade spend?"
REAL_QUESTION = "Did Dussehra Deal 25 recover its Buy3Get1 giveaway in Modern Trade?"

#: Figures authored into RCA's static JSON. None may appear downstream.
#: 98.6 is the contradicted trade spend, 83.5 its "plan", 24.8 the authored
#: incremental sales.
AUTHORED_RCA_FIGURES = ("98.6", "83.5", "24.8")


@pytest.fixture(scope="session")
def client():
    return TestClient(app)


@pytest.fixture(scope="session")
def alert(client):
    """A real risk alert for the Command Center scope, with its real id."""
    response = client.get("/api/command-center/risk-alerts", params={**{"year": YEAR}, "channel": "CH002", "limit": 50})
    assert response.status_code == 200
    alerts = response.json()["alerts"]
    assert alerts, "the scope must carry at least one alert for the journey to start"
    return next((a for a in alerts if a["promotion_id"] == "PBDU25"), alerts[0])


def _post(client, path, body):
    response = client.post(path, json=body)
    assert response.status_code == 200, response.text
    return response.json()


# --- the journey ------------------------------------------------------------


def test_the_full_journey(client, alert):
    """Command Center -> RCA -> Simulation -> scenario -> real result."""
    # 1-3. The Command Center holds a validated scope.
    # 4-6. Clicking an alert narrows it by the identifiers the alert carries:
    #      the promotion, product and channel CODES of the event it measured.
    #      Its channel NAME travels alongside them as a label and narrows
    #      nothing, and its week narrows nothing either -- a scope cut to the
    #      promoted week keeps no non-promoted row to measure an uplift against.
    #      This journey stays on the promotion narrowing, so the scope it walks
    #      is the wider one; the drill-down's own reconciliation is asserted in
    #      test_command_center.test_narrowing_by_an_alerts_identifiers_...
    assert alert["promotion_id"], "the alert must carry a real promotion id"
    assert alert["product_id"] and alert["channel_id"], "and its other two codes"
    assert alert["channel"] == "Modern Trade", "channel arrives as a label too"
    handed_off = {**COMMAND_CENTER_SCOPE, "promotion": [alert["promotion_id"]]}

    # 7-8. A question the user actually asked.
    context = _post(
        client,
        "/api/simulation/context",
        {
            "filters": handed_off,
            "question": REAL_QUESTION,
            "investigation_started": True,
            "investigation_type": "diagnostic",
        },
    )
    assert context["question"] == {"value": REAL_QUESTION, "source": "rca", "reason": None}

    # 9-11. Simulation receives the SAME FilterState -- property 1.
    scope = context["filter_state"]["value"]
    assert scope == FilterState.build(**handed_off).applied()
    run = _post(client, "/api/simulation/run", {"filters": scope})
    assert run["scope"]["filters_applied"] == scope
    assert run["context"]["filters_applied"] == scope

    # 12. Current Plan is measured; nothing else has been run.
    current, *hypotheticals = run["scenarios"]
    assert current["status"] == "measured" and current["result"] is not None
    assert all(h["status"] == "not_simulated" and h["result"] is None for h in hypotheticals)

    # 13-15. An approved treatment produces a real result.
    ten = _post(
        client,
        "/api/simulation/simulate",
        {"filters": scope, "scenario_id": "optimized-plan", "discount_pct": 10},
    )
    assert ten["status"] == "simulated"
    assert ten["treatment"] == "PR002"
    assert ten["uplift"] == {"low": 0.25, "high": 0.35}
    for end in ("low", "high"):
        assert ten["result"][end]["kpis"]["roi_multiple"]["value"] is not None

    # 16. No authored RCA figure crossed the boundary -- property 2.
    downstream = json.dumps(context) + json.dumps(run) + json.dumps(ten)
    for figure in AUTHORED_RCA_FIGURES:
        assert figure not in downstream, f"RCA's authored {figure} reached Simulation"

    # 17-19. A different treatment is a different answer -- property 3.
    fifteen = _post(
        client,
        "/api/simulation/simulate",
        {"filters": scope, "scenario_id": "optimized-plan", "discount_pct": 15},
    )
    assert fifteen["treatment"] == "PR003"
    assert fifteen["result"] != ten["result"]

    # 20-23. A different investigation scope is a different answer too, so a
    # result left over from the previous scope could never be right.
    other_scope = {"year": YEAR, "channel": ["CH001"], "promotion": ["PBDI25"]}
    elsewhere = _post(
        client,
        "/api/simulation/simulate",
        {"filters": other_scope, "scenario_id": "optimized-plan", "discount_pct": 15},
    )
    assert elsewhere["result"] != fifteen["result"]
    assert elsewhere["scope"]["filters_applied"] == other_scope


def test_rca_is_not_required(client):
    """Property 4. Direct entry: no investigation, no question, no hand-off."""
    context = _post(client, "/api/simulation/context", {"filters": COMMAND_CENTER_SCOPE})
    assert context["question"]["value"] is None
    assert context["filter_state"]["value"] == FilterState.build(**COMMAND_CENTER_SCOPE).applied()

    run = _post(client, "/api/simulation/run", {"filters": COMMAND_CENTER_SCOPE})
    assert run["scenarios"][0]["status"] == "measured"

    simulated = _post(
        client,
        "/api/simulation/simulate",
        {"filters": COMMAND_CENTER_SCOPE, "scenario_id": "optimized-plan", "discount_pct": 20},
    )
    assert simulated["treatment"] == "PS001"
    assert simulated["status"] == "simulated"


def test_a_fresh_session_shows_no_investigation_question(client):
    """The seeded example never becomes the investigation's question, whether
    the client is holding it untouched or submits it."""
    for started in (False, True):
        context = _post(
            client,
            "/api/simulation/context",
            {"filters": COMMAND_CENTER_SCOPE, "question": SEEDED_QUESTION, "investigation_started": started},
        )
        assert context["question"]["value"] is None
        assert context["question"]["source"] == "seed_example"


def test_investigation_id_is_still_honestly_unavailable(client):
    """B3.3 generates none. When RCA implements one, it will flow through the
    field that already exists."""
    context = _post(
        client,
        "/api/simulation/context",
        {"filters": COMMAND_CENTER_SCOPE, "question": REAL_QUESTION, "investigation_started": True},
    )
    assert context["investigation_id"]["value"] is None
    assert context["investigation_id"]["source"] == "unavailable"
    assert "investigation_id" in context["missing"]


def test_an_unnarrowed_scope_reports_the_gap_rather_than_inventing_one(client):
    """A hand-off that carries no promotion must SAY so.

    An underperforming row now narrows by the promotion, product and channel
    codes of the event it measured, so this is no longer that table's path.
    The property it guards is unchanged and still load-bearing: where a source
    genuinely provides no identifier, the scope stays the user's own selection
    and the focus reports what it cannot establish instead of guessing."""
    context = _post(
        client,
        "/api/simulation/context",
        {"filters": COMMAND_CENTER_SCOPE, "question": REAL_QUESTION, "investigation_started": True},
    )
    assert "promotion" not in context["filter_state"]["value"]
    assert context["focus"]["promotion_id"]["value"] is None
    assert context["focus"]["promotion_id"]["reason"]


@pytest.mark.parametrize(
    "field,value",
    [
        ("context_chips", {"channel": "Modern Trade"}),
        ("period_label", "Apr - Jun 2025"),
        ("trade_spend", 98.6),
        ("root_cause", "inefficient promotion"),
    ],
)
def test_authored_rca_content_cannot_enter_the_contract(client, field, value):
    """Display copy and authored figures are refused at the boundary rather
    than filtered out downstream."""
    response = client.post(
        "/api/simulation/context", json={"filters": COMMAND_CENTER_SCOPE, field: value}
    )
    assert response.status_code == 422, f"{field} was accepted"
