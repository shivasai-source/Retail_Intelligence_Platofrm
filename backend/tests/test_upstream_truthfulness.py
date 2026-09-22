"""Upstream truthfulness -- B9.

B6 established that this project defines no governance boundary, B7 removed the
compliance claims from Decision Center and B8 kept them out of the exported
briefing. B9 removes the same claims from the pages UPSTREAM of that work, so a
user cannot read "Budget compliance OK" on the RCA page and then be told, three
clicks later and about the same promotion, that no budget ceiling has ever been
defined.

THESE TESTS SCAN CLAIM SHAPE, NOT WORDS. The pages are REQUIRED to discuss
governance, forecasting and compliance -- in order to deny them. A test that
failed on the word "governance" would flag the honesty as the dishonesty, so
every scan asks whether a sentence ASSERTS the thing or DENIES it.

Run with:

    ../venv/Scripts/python.exe -m pytest tests/ -q
"""

from __future__ import annotations

import json
import re

import pytest
from fastapi.testclient import TestClient

from app.data_loader import INVESTIGATION_TYPES
from app.main import app
from tests import legacy_journey

#: The retired risk assessment's seven undefined-threshold statements, read off
#: the snapshot of its last payload (tests/legacy_journey.py). The module that
#: produced them is gone; the statements must still not be restated upstream.
UNDEFINED_THRESHOLDS = legacy_journey.load()["risk"]["governance_gaps"]

#: The exact claims B9 removed. None may return, in any archetype.
REMOVED_CLAIMS = (
    "14/14",
    "Governance Compliance",
    "Budget compliance",
    "Margin safe",
    "Cannibalization low",
    "Within risk envelope",
    "all 14 governance and policy checks",
    "14 governance checks",
    "within budget and policy thresholds",
    "Forecast confidence",
    "14 policy checks passed",
    "All 14 policy checks pass",
    "Live governance engine",
    "Budget ₹680 Cr",
    "Governance & Policy Check",
    "Within elasticity envelope",
    "SSO via Microsoft Entra ID",
)

#: Negations that turn a mention into a denial.
NEGATIONS = ("no ", "not ", "never", "cannot", "nothing", "nobody", "undefined",
             "without")

#: Claim shapes that must never appear as assertions.
CLAIM_SHAPES = (
    r"\b\d+\s*/\s*\d+\b(?=[^%]*(?:rule|check|polic))",
    r"\bcomplian(?:t|ce)\b",
    r"\ball\s+\d+\s+(?:governance|policy)",
    r"\bwithin\s+(?:budget|policy|governance|risk|all)\b",
    r"\b\d+%\s*confidence\b",
    r"\bconfidence\s+is\b",
    r"\bforecast\s+confidence\b",
    r"\bmargin\s+safe\b",
    r"\bchecks?\s+pass",
)


@pytest.fixture(scope="session")
def client():
    return TestClient(app)


def _strings(node, path=""):
    """Every string the API serves, with the path it sits at."""
    if isinstance(node, dict):
        for key, value in node.items():
            yield from _strings(value, f"{path}.{key}")
    elif isinstance(node, list):
        for index, value in enumerate(node):
            yield from _strings(value, f"{path}[{index}]")
    elif isinstance(node, str):
        yield path, node


def _numbers(node, path=""):
    if isinstance(node, dict):
        for key, value in node.items():
            yield from _numbers(value, f"{path}.{key}")
    elif isinstance(node, list):
        for index, value in enumerate(node):
            yield from _numbers(value, f"{path}[{index}]")
    elif isinstance(node, (int, float)) and not isinstance(node, bool):
        yield path, node


def _asserting(text: str, pattern: str) -> bool:
    """True when `text` matches `pattern` and does NOT deny it."""
    if not re.search(pattern, text, flags=re.I):
        return False
    return not any(word in text.lower() for word in NEGATIONS)


def _payloads(client):
    """Every upstream payload a page can actually read."""
    out = {}
    for kind in INVESTIGATION_TYPES:
        for path in (f"/api/investigations/{kind}", f"/api/intelligence-answers/{kind}"):
            response = client.get(path)
            assert response.status_code == 200, path
            out[path] = response.json()
    for path in ("/api/investigations/legacy", "/api/settings"):
        response = client.get(path)
        assert response.status_code == 200, path
        out[path] = response.json()
    return out


# --- the removed claims -------------------------------------------------------


def test_no_removed_claim_returns_in_any_archetype(client):
    """Every archetype, not just the first one that matched."""
    offenders = []
    for path, payload in _payloads(client).items():
        flat = json.dumps(payload, ensure_ascii=False)
        for claim in REMOVED_CLAIMS:
            if claim in flat:
                offenders.append(f"{path}: {claim!r}")
    assert not offenders, offenders


def test_no_compliance_or_governance_verdict_is_asserted(client):
    offenders = []
    for path, payload in _payloads(client).items():
        for where, text in _strings(payload):
            for shape in CLAIM_SHAPES:
                if _asserting(text, shape):
                    offenders.append(f"{path}{where}: {text!r} (matched {shape})")
    assert not offenders, offenders


def test_denials_are_not_mistaken_for_claims(client):
    """The scanner must pass sentences that DENY the thing they name.

    Without this, a future edit could satisfy the tests above by deleting the
    honest statements rather than the dishonest ones.
    """
    payload = client.get("/api/investigations/strategic").json()
    governance = payload["nodeDetails"]["governance"]
    assert "not defined" in governance["headline"].lower()
    assert "no approved governance thresholds" in governance["body"].lower()
    for shape in CLAIM_SHAPES:
        assert not _asserting(governance["body"], shape), shape


# --- confidence ---------------------------------------------------------------


def test_no_confidence_figure_is_served(client):
    """No engine in this project produces one, so nothing may report one."""
    offenders = []
    for path, payload in _payloads(client).items():
        for where, _ in _numbers(payload):
            if where.lower().endswith(("confidence", "confidencedelta", "probability")):
                offenders.append(f"{path}{where}")
        for where, text in _strings(payload):
            if where.lower().endswith(("confidence", "confidencedelta")):
                offenders.append(f"{path}{where}: {text!r}")
    assert not offenders, offenders


def test_investigation_progress_carries_no_confidence(client):
    for kind in INVESTIGATION_TYPES:
        progress = client.get(f"/api/investigations/{kind}").json()["progress"]
        assert "confidence" not in progress, kind
        assert "confidenceDelta" not in progress, kind
    legacy = client.get("/api/investigations/legacy").json()["progress"]
    assert "confidence" not in legacy and "confidenceDelta" not in legacy


def test_intelligence_answers_carry_no_confidence(client):
    for kind in INVESTIGATION_TYPES:
        answer = client.get(f"/api/intelligence-answers/{kind}").json()
        assert "confidence" not in answer, kind
        assert answer["summary"] and answer["text"]


# --- forecasting --------------------------------------------------------------


def test_no_forecast_is_asserted(client):
    """B5's weekly view is explicitly not a forecast; nothing upstream may claim one."""
    offenders = []
    for path, payload in _payloads(client).items():
        for where, text in _strings(payload):
            for shape in (r"\bforecast(?:ed|s)?\b", r"\bpredicted\b", r"\bprojected to\b"):
                if _asserting(text, shape):
                    offenders.append(f"{path}{where}: {text!r}")
    assert not offenders, offenders


# --- settings -----------------------------------------------------------------


def test_settings_claims_no_active_integration(client):
    settings = client.get("/api/settings").json()
    flat = json.dumps(settings, ensure_ascii=False).lower()
    for claim in ("active", "connected", "enabled", "entra"):
        assert claim not in flat, claim
    assert settings["integrations"], "the capabilities are still listed, just not claimed"


def test_settings_carries_no_fabricated_identity(client):
    """The page shows the signed-in persona; the payload supplies no identity."""
    profile = client.get("/api/settings").json()["profile"]
    for field in ("name", "email", "role"):
        assert field not in profile, field
    assert json.dumps(profile, ensure_ascii=False).lower().count("sanjay") == 0


# --- B6 remains the only source of truth --------------------------------------


def test_b6_thresholds_are_untouched():
    """The seven statements, as the retired assessment last produced them."""
    assert len(UNDEFINED_THRESHOLDS) == 7
    assert {gap["key"] for gap in UNDEFINED_THRESHOLDS} == {
        "budget_ceiling", "margin_floor", "cannibalization_limit", "pei_floor",
        "max_discount", "max_duration", "weekly_concentration",
    }


def test_b9_did_not_copy_the_b6_list(client):
    """No upstream payload re-states B6's seven statements.

    Naming them here would create a second policy source that could drift from
    the frozen one. The pages state that thresholds are undefined and point at
    the panel that reads B6 live.
    """
    payloads = json.dumps(_payloads(client), ensure_ascii=False)
    for gap in UNDEFINED_THRESHOLDS:
        assert gap["statement"] not in payloads, gap["key"]


def test_b9_introduced_no_threshold(client):
    """Nothing upstream defines a boundary that B6 says does not exist."""
    offenders = []
    for path, payload in _payloads(client).items():
        for where, text in _strings(payload):
            for shape in (r"\bmaximum\s+(?:trade\s+spend|discount|duration)\s+(?:is|of)\s+\d",
                          r"\bminimum\s+(?:margin|pei)\s+(?:is|of)\s+\d",
                          r"\b(?:ceiling|floor|cap|limit)\s+(?:is|of|:)\s*[₹$]?\s*\d"):
                if re.search(shape, text, flags=re.I):
                    offenders.append(f"{path}{where}: {text!r}")
    assert not offenders, offenders


# --- nothing downstream moved -------------------------------------------------


def test_b7_and_b8_contracts_still_answer(client):
    """B9 touched content, not contracts."""
    assert client.post("/api/decision/record", json={}).status_code == 422
    assert client.post("/api/decision/briefing", json={}).status_code == 422


def test_upstream_pages_still_serve_their_structure(client):
    """Removing claims must not have removed the pages.

    A sweep that emptied the payloads would pass every test above and destroy
    the product, so the shapes are pinned.
    """
    for kind in INVESTIGATION_TYPES:
        orchestration = client.get(f"/api/investigations/{kind}").json()
        assert len(orchestration["nodes"]) == 8, kind
        assert len(orchestration["accelerators"]) == 6, kind
        assert len(orchestration["nodeDetails"]) == 8, kind
        assert orchestration["progress"]["sources"] > 0
        for node in orchestration["nodes"]:
            assert node["label"], f"{kind}: an empty node label"
            detail = orchestration["nodeDetails"][node["key"]]
            assert detail["headline"] and detail["body"], f"{kind}.{node['key']}"
