"""Validation for the portable decision briefing -- B8.

B8 renders; it does not calculate. So these tests are about three things.

IT CARRIES THROUGH VERBATIM. The JSON artifact must contain the record byte for
byte, and every substantive value in the HTML must be traceable to it. If the
briefing ever disagrees with Decision Center about a number, one of these fails.

IT CLAIMS NOTHING IT HAS NOT EARNED. The artifact leaves the application, so it
is the one place a fabricated claim would go unchallenged. No author, no
approver, no approval, no compliance, no confidence, no forecast, no midpoint,
no score, no ranking.

IT IS GENUINELY PORTABLE. One file, no script, no external asset, no network
request -- it must render on a machine where this application does not exist.

Run with:

    ../venv/Scripts/python.exe -m pytest tests/ -q
"""

from __future__ import annotations

import copy
import html as html_lib
import json
import re
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from app.main import app
from app.tpo import briefing
from tests import legacy_journey

YEAR = 2025
SCOPE = {"year": YEAR, "channel": ["CH002"]}
QUESTION = "Which approved treatment recovers the most incremental sales in Modern Trade?"

#: A frozen stamp, so rendering is reproducible. The route uses the server
#: clock; only these tests pin it.
STAMP = "2026-01-01 00:00 UTC"

#: Authored values from the old static Decision Center. None may reach an
#: artifact that leaves the building.
AUTHORED = ("2.55", "98.6", "89%", "Retailer Incentive", "Inventory Allocation",
            "Finance team notified", "Target Achievement Probability",
            "Sell-through Forecast", "Data Confidence")


@pytest.fixture(scope="session")
def client():
    return TestClient(app)


def _post(client, path, body, expect=200):
    r = client.post(path, json=body)
    assert r.status_code == expect, r.text
    return r.json()


@pytest.fixture(scope="session")
def record(client):
    """One real B7 decision record, assembled from the retired studio's
    payloads (see tests/legacy_journey.py)."""
    return _post(client, "/api/decision/record", legacy_journey.record_request())


@pytest.fixture(scope="session")
def artifact(record):
    """The rendered briefing, at a fixed stamp so assertions are stable."""
    return briefing.build(record, exported_at=STAMP)


@pytest.fixture(scope="session")
def doc(artifact):
    return artifact["html"]


def _keys(node, acc=None):
    acc = acc if acc is not None else set()
    if isinstance(node, dict):
        for key, value in node.items():
            acc.add(str(key).lower())
            _keys(value, acc)
    elif isinstance(node, list):
        for item in node:
            _keys(item, acc)
    return acc


def _text(doc: str) -> str:
    """The document with tags and the style block removed.

    Prose assertions must read the words a person sees, not the CSS: a rule
    named `.state em` should never satisfy or trip a claim test.
    """
    stripped = re.sub(r"<style>.*?</style>", " ", doc, flags=re.S)
    return re.sub(r"<[^>]+>", " ", stripped)

#: Negations that turn a mention into a denial. The artifact is REQUIRED to
#: discuss midpoints, forecasting and approval -- in order to deny them -- so a
#: bare word scan flags the honesty as the dishonesty. Sentences are the unit.
_NEGATIONS = ("no ", "not ", "never", "cannot", "nothing", "nobody", "without")


def _claiming(doc: str, pattern: str) -> list[str]:
    """Sentences matching `pattern` WITHOUT denying it.

    Whitespace is normalised before splitting: the source wraps its prose
    across lines, and splitting on newlines would tear "this is not a /
    confidence interval" in half and read the second half as a claim.
    """
    flat = re.sub(r"\s+", " ", _text(doc))
    return [
        s.strip() for s in re.split(r"(?<=[.!?]) ", flat)
        if re.search(pattern, s, flags=re.I)
        and not any(n in s.lower() for n in _NEGATIONS)
    ]


# --- 1-3: the endpoint ------------------------------------------------------


def test_valid_record_produces_200(client, record):
    body = _post(client, "/api/decision/briefing", {"record": record})
    assert set(body) == {"briefing", "html", "filenames"}
    assert body["filenames"] == {"json": "briefing.json", "html": "briefing.html"}


def test_malformed_record_is_refused(client):
    for payload in ({"record": {}}, {"record": {"status": "draft"}},
                    {"record": {"decision_id": "d-1"}}):
        r = client.post("/api/decision/briefing", json=payload)
        assert r.status_code == 422, r.text
        assert r.json()["detail"]


def test_incomplete_record_is_refused(client, record):
    """A record missing a section is refused, not rendered with a hole.

    A briefing that silently dropped the governance section would read as if
    there were nothing to report.
    """
    for section in ("governance", "readiness", "expected_impact", "provenance"):
        partial = copy.deepcopy(record)
        partial.pop(section)
        r = client.post("/api/decision/briefing", json={"record": partial})
        assert r.status_code == 422, section
        assert section in r.json()["detail"]


def test_record_claiming_persistence_or_approval_is_refused(client, record):
    """The three facts the artifact prints about itself are verified first."""
    cases = [
        ("decision_id", "d-1"),
        ("status", "approved"),
    ]
    for key, value in cases:
        bad = copy.deepcopy(record)
        bad[key] = value
        assert client.post("/api/decision/briefing", json={"record": bad}).status_code == 422

    bad = copy.deepcopy(record)
    bad["meta"]["persisted"] = True
    assert client.post("/api/decision/briefing", json={"record": bad}).status_code == 422

    bad = copy.deepcopy(record)
    bad["readiness"]["can_be_approved"] = True
    assert client.post("/api/decision/briefing", json={"record": bad}).status_code == 422


def test_request_accepts_nothing_but_the_record(client, record):
    """Filters, scenario ids, an author or an approval state are all refused.

    Every one would be a second source of truth the artifact could disagree
    with; the last would be fabricated governance.
    """
    for extra in ({"filters": SCOPE}, {"scenario_id": "scenario-b"},
                  {"author": "Sanjay Kumar"}, {"approver": "Finance"},
                  {"approved": True}, {"provenance": {}}):
        r = client.post("/api/decision/briefing", json={"record": record, **extra})
        assert r.status_code == 422, extra


# --- 4-5: the envelope and the record ---------------------------------------


def test_export_envelope_shape(artifact):
    env = artifact["briefing"]["export"]
    assert env["exported_at"] == STAMP
    assert env["record_status"] == "draft"
    assert env["persisted"] is False
    assert env["approved"] is False
    assert env["source"] == "/api/decision/record"
    assert "NOT APPROVED" in env["disclaimer"] and "NOT SAVED" in env["disclaimer"]


def test_record_contents_preserved_byte_for_byte(artifact, record):
    assert artifact["briefing"]["record"] == record


# --- 6-13: every section survives -------------------------------------------


def test_every_record_section_is_present(artifact, record):
    carried = artifact["briefing"]["record"]
    for section in briefing.REQUIRED_SECTIONS:
        assert section in carried
        assert carried[section] == record[section]


def test_governance_gaps_preserved(artifact, record, doc):
    gaps = record["governance"]["governance_gaps"]
    assert gaps, "the fixture must exercise a record that carries gaps"
    assert artifact["briefing"]["record"]["governance"]["governance_gaps"] == gaps
    for gap in gaps:
        assert html_lib.escape(gap["label"]) in doc


def test_limitations_preserved(artifact, record, doc):
    limitations = record["governance"]["limitations"]
    assert limitations
    assert artifact["briefing"]["record"]["governance"]["limitations"] == limitations
    for limitation in limitations:
        assert html_lib.escape(limitation["title"]) in doc


def test_recommendation_preserved(artifact, record, doc):
    assert artifact["briefing"]["record"]["recommendation"] == record["recommendation"]
    assert html_lib.escape(record["recommendation"]["reason"]) in doc
    assert html_lib.escape(record["recommendation"]["note"]) in doc


def test_decision_path_preserved(artifact, record, doc):
    """Where the record came from is printed, not just carried."""
    assert artifact["briefing"]["record"]["investigation"] == record["investigation"]
    assert artifact["briefing"]["record"]["scope"] == record["scope"]
    for source in record["provenance"]["assembled_from"]:
        assert html_lib.escape(source) in doc
    if record["investigation"]["question"]:
        assert html_lib.escape(record["investigation"]["question"]) in doc


def test_weekly_section_preserved_when_present(artifact, record, doc):
    weekly = record["weekly"]
    assert weekly["available"] is True, "the fixture must carry a weekly view"
    assert artifact["briefing"]["record"]["weekly"] == weekly
    # every week, and both ends of every week
    assert doc.count("<tr><td>") >= len(weekly["weeks"])
    for week in weekly["weeks"][:5]:
        assert html_lib.escape(week["week_label"]) in doc
    first = weekly["weeks"][0]
    for metric in weekly["metrics"]:
        for end in ("low", "high"):
            cell = first[end][metric["key"]]
            if cell.get("display_value"):
                assert html_lib.escape(cell["display_value"], quote=True) in doc


def test_weekly_absence_is_stated_not_hidden(record):
    """A record without a weekly view says so; it does not print an empty table."""
    without = copy.deepcopy(record)
    without["weekly"] = {"available": False, "reason": "No weekly decomposition was carried."}
    doc = briefing.build(without, exported_at=STAMP)["html"]
    assert "No weekly decomposition was carried." in doc
    assert "(low)</th>" not in doc


def test_risk_section_preserved(artifact, record, doc):
    governance = record["governance"]
    assert artifact["briefing"]["record"]["governance"] == governance
    assert html_lib.escape(governance["summary"]) in doc
    for finding in governance["findings"]:
        assert html_lib.escape(finding["title"]) in doc
        assert html_lib.escape(finding["reason"]) in doc


def test_provenance_preserved(artifact, record, doc):
    provenance = record["provenance"]
    assert artifact["briefing"]["record"]["provenance"] == provenance
    assert html_lib.escape(provenance["kpi_engine"]) in doc
    assert html_lib.escape(provenance["response_rule"]) in doc


def test_readiness_preserved(artifact, record, doc):
    readiness = record["readiness"]
    assert artifact["briefing"]["record"]["readiness"] == readiness
    for blocker in readiness["blockers"]:
        assert html_lib.escape(blocker["title"]) in doc
    for item in readiness["unverified"]:
        assert html_lib.escape(item["title"]) in doc


# --- 14-17: the four facts that must not drift ------------------------------


def test_decision_id_remains_null(artifact, doc):
    assert artifact["briefing"]["record"]["decision_id"] is None
    assert "decision_id" not in _text(doc)


def test_status_remains_draft(artifact, doc):
    assert artifact["briefing"]["record"]["status"] == "draft"
    assert artifact["briefing"]["export"]["record_status"] == "draft"
    assert "Draft" in _text(doc)


def test_persisted_remains_false(artifact, doc):
    assert artifact["briefing"]["record"]["meta"]["persisted"] is False
    assert artifact["briefing"]["export"]["persisted"] is False
    assert "Not saved" in _text(doc)


def test_approved_remains_false(artifact, doc):
    assert artifact["briefing"]["export"]["approved"] is False
    assert artifact["briefing"]["record"]["readiness"]["states"]["approved"] is False
    assert artifact["briefing"]["record"]["readiness"]["can_be_approved"] is False
    assert "Not approved" in _text(doc)


# --- 18-24: claims the artifact must never make -----------------------------


def test_no_author_and_no_approver(artifact, doc):
    """No identity is fabricated, because none exists to fabricate from."""
    keys = _keys(artifact["briefing"])
    for forbidden in ("author", "approver", "approved_by", "prepared_by",
                      "owner", "signed_by", "reviewer", "user", "created_by"):
        assert forbidden not in keys, forbidden

    text = _text(doc).lower()
    for phrase in ("prepared by", "approved by", "authored by", "submitted by",
                   "reviewed by", "signed by", "sanjay kumar"):
        assert phrase not in text, phrase
    assert "no author" in text and "no approver" in text


def test_no_compliance_claim(artifact, doc):
    """B6 established the boundaries do not exist, so nothing can comply."""
    assert "compliant" not in json.dumps(artifact["briefing"], ensure_ascii=False).lower()
    assert "compliant" not in _text(doc).lower()
    assert "compliance" not in _text(doc).lower().replace("no compliance position", "")


def test_no_approval_claim(artifact, doc):
    """Every mention of approval is a denial or a named blocker.

    Scanned by CLAIM SHAPE, not by the word: the artifact legitimately prints
    "Approved uplift range" -- the name of the response rule's own band, which
    the project approved -- and "Approved TPO promotion treatment rule" in the
    provenance. Neither says a decision was approved.
    """
    text = _text(doc)
    for pattern in (r"\b(is|was|were|has been|have been|been)\s+approved\b",
                    r"\bapproved\s+by\b", r"\bapproval\s+(granted|complete|received)\b",
                    r"\bauthoris(ed|ation)\s+(granted|by)\b"):
        assert not _claiming(doc, pattern), (pattern, _claiming(doc, pattern))

    assert "Not approved" in text
    assert "authorises spend" in text.lower()


def test_no_midpoint_and_both_ends_survive(artifact, record, doc):
    keys = _keys(artifact["briefing"])
    for forbidden in ("midpoint", "expected_value", "average", "mean", "point_estimate"):
        assert forbidden not in keys, forbidden

    assert not _claiming(doc, "midpoint"), _claiming(doc, "midpoint")

    for metric in record["expected_impact"]:
        if metric["available"]:
            assert html_lib.escape(metric["display_low"], quote=True) in doc
            assert html_lib.escape(metric["display_high"], quote=True) in doc


def test_no_score_and_no_ranking(artifact, doc):
    keys = _keys(artifact["briefing"])
    for forbidden in ("score", "rank", "ranking", "weight", "rating", "grade"):
        assert forbidden not in keys, forbidden
    for word in ("ranked", "ranking", "best scenario", "winner", "optimal", "score"):
        assert not _claiming(doc, word), (word, _claiming(doc, word))


def test_no_confidence_or_prediction_claim(artifact, doc):
    """The only mentions of confidence or forecasting are denials of them."""
    keys = _keys(artifact["briefing"])
    for forbidden in ("confidence", "probability", "likelihood", "prediction"):
        assert forbidden not in keys, forbidden

    for word in ("confidence", "forecast", "predict", "probability", "likelihood"):
        assert not _claiming(doc, word), (word, _claiming(doc, word))


def test_unavailable_metrics_keep_their_reason(record):
    """An unavailable metric is never zero-filled on its way into print."""
    blanked = copy.deepcopy(record)
    target = blanked["expected_impact"][0]
    target.update({"available": False, "low": None, "high": None,
                   "display_low": None, "display_high": None,
                   "unavailable_reason": "The engine could not compute this."})
    doc = briefing.build(blanked, exported_at=STAMP)["html"]
    assert "The engine could not compute this." in doc
    assert "Not available" in doc


def test_no_authored_value_reaches_the_artifact(artifact, doc):
    flat = json.dumps(artifact["briefing"], ensure_ascii=False)
    for value in AUTHORED:
        assert value not in flat, value
        assert value not in doc, value


# --- 25-27: rendering discipline --------------------------------------------


def test_rendering_is_deterministic_at_a_fixed_stamp(record):
    first = briefing.build(record, exported_at=STAMP)
    second = briefing.build(record, exported_at=STAMP)
    assert first == second


def test_input_record_is_not_mutated(client, record):
    before = copy.deepcopy(record)
    briefing.build(record, exported_at=STAMP)
    client.post("/api/decision/briefing", json={"record": record})
    assert record == before


def test_no_engine_is_imported_or_called(monkeypatch, record):
    """The renderer touches no engine -- proved statically and at runtime."""
    source = Path(briefing.__file__).read_text(encoding="utf-8")
    # Matched on IMPORT SYNTAX, not on the word: the renderer holds local
    # variables called `recommendation` and `governance`, and a bare-name scan
    # would flag reading the record it is meant to read.
    imports = re.findall(r"^[ \t]*(?:from|import)[ \t]+\S+.*$", source, flags=re.M)
    assert imports == ["from __future__ import annotations", "import html",
                       "from datetime import datetime, timezone",
                       "from typing import Any"], imports

    # If anything reached for the dataset or the KPI engine, this would explode.
    from app.tpo import aggregate, loader, studio

    monkeypatch.setattr(loader, "get_store", lambda: pytest.fail("read the dataset"))
    monkeypatch.setattr(aggregate, "calculate_kpis",
                        lambda *a, **k: pytest.fail("called the KPI engine"))
    monkeypatch.setattr(studio, "simulate",
                        lambda *a, **k: pytest.fail("re-ran the scenario"))
    assert briefing.build(record, exported_at=STAMP)["html"]


def test_nothing_is_written_to_disk(record):
    source = Path(briefing.__file__).read_text(encoding="utf-8")
    for forbidden in ("open(", ".write(", "sqlite", "session.add", "commit(",
                      "pickle", "Path(", "os.environ"):
        assert forbidden not in source, forbidden


# --- the HTML artifact ------------------------------------------------------


def test_html_is_self_contained(doc):
    """No script, no external asset, no network request of any kind."""
    lowered = doc.lower()
    assert "<script" not in lowered
    assert "javascript:" not in lowered
    assert "http://" not in lowered and "https://" not in lowered
    assert "src=" not in lowered
    assert 'href="' not in lowered and "href='" not in lowered
    assert "@import" not in lowered
    assert "url(" not in lowered
    assert "<link" not in lowered
    assert "<iframe" not in lowered


def test_html_uses_inline_css_only(doc):
    assert doc.count("<style>") == 1
    assert "stylesheet" not in doc.lower()
    assert "@media print" in doc


def test_html_opens_independently(tmp_path, doc, record):
    """Written out and read back, the document is whole and self-describing."""
    path: Path = tmp_path / "briefing.html"
    path.write_text(doc, encoding="utf-8")
    reopened = path.read_text(encoding="utf-8")

    assert reopened == doc
    assert reopened.startswith("<!doctype html>")
    assert reopened.rstrip().endswith("</html>")
    assert "<meta charset=\"utf-8\">" in reopened
    for heading in ("What is being decided", "Expected impact", "Recommendation",
                    "Weekly impact", "Risk &amp; governance", "Readiness",
                    "Decision path"):
        assert heading in reopened, heading
    assert html_lib.escape(record["scenario"]["name"]) in reopened


def test_html_escapes_record_content(record):
    """The record is data, not markup."""
    hostile = copy.deepcopy(record)
    hostile["scenario"]["name"] = "<script>alert(1)</script> & 'quoted'"
    doc = briefing.build(hostile, exported_at=STAMP)["html"]
    assert "<script>alert(1)</script>" not in doc
    assert "&lt;script&gt;" in doc


def test_html_states_all_three_facts_in_the_header(doc):
    head = doc[: doc.index("What is being decided")]
    for stamp in ("Draft", "Not approved", "Not saved"):
        assert stamp in head, stamp
    assert briefing.DISCLAIMER in html_lib.unescape(head)


# --- the JSON artifact ------------------------------------------------------


def test_json_artifact_is_valid_and_complete(artifact, record):
    serialized = json.dumps(artifact["briefing"], ensure_ascii=False, indent=2)
    reloaded = json.loads(serialized)
    assert reloaded["record"] == record
    assert set(reloaded) == {"export", "record"}


def test_json_artifact_carries_no_fabricated_identity(artifact):
    flat = json.dumps(artifact["briefing"], ensure_ascii=False).lower()
    for name in ("sanjay kumar", "abhinav", "\"author\"", "\"approver\""):
        assert name not in flat, name


def test_endpoint_matches_the_module(client, record):
    """The route adds nothing of its own beyond the clock."""
    body = _post(client, "/api/decision/briefing", {"record": record})
    stamp = body["briefing"]["export"]["exported_at"]
    assert body == briefing.build(record, exported_at=stamp)


def test_b7_record_contract_is_untouched(client, record):
    """B8 changes nothing about the record it renders."""
    assert record["decision_id"] is None
    assert record["status"] == "draft"
    assert record["meta"]["persisted"] is False
    assert record["readiness"]["can_be_approved"] is False
