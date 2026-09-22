"""Persistence and traceability -- B10.

B10 stores; it does not calculate. So these tests are about four things.

IT STORES WHAT THE ENGINES PRODUCED, UNEDITED. A stored result read back must
equal the payload that went in, byte for byte. If the store ever disagrees with
Simulation Studio about a number, one of these fails.

IT NEVER REWRITES HISTORY. Editing a scenario appends a version; re-saving a
decision appends a version; a write against a stale expectation is refused
rather than merged.

IT KNOWS WHAT IT WAS COMPUTED FROM. Every stored row carries a server-side
dataset fingerprint, and a record whose data has moved on is reported stale --
never recomputed, never overwritten, never called current.

IT INVENTS NOBODY. There is no authentication in this project, so no stored row
carries an owner and no route accepts one.

Run with:

    ../venv/Scripts/python.exe -m pytest tests/ -q
"""

from __future__ import annotations

import copy
import json
import re
import shutil
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from app.main import app
from app.store import db, repository
from app.store.fingerprint import dataset_version
from app.tpo import config
from tests import legacy_journey

SCOPE = {"year": 2025, "channel": ["CH002"]}
QUESTION = "Which approved treatment recovers the most incremental sales in Modern Trade?"


@pytest.fixture(scope="module", autouse=True)
def store(tmp_path_factory):
    """A throwaway database, so the tests never touch a real one."""
    path = tmp_path_factory.mktemp("store") / "b10.db"
    db.use_path(path)
    yield path
    db.close()


@pytest.fixture(scope="module")
def client():
    return TestClient(app)


def _post(client, path, body, expect=200):
    r = client.post(path, json=body)
    assert r.status_code == expect, r.text
    return r.json()


@pytest.fixture(scope="module")
def journey(client):
    """The retired studio's payloads, from the snapshot (tests/legacy_journey.py),
    and the record assembled from them."""
    snap = legacy_journey.load()
    record = _post(client, "/api/decision/record", legacy_journey.record_request(snap))
    return {"context": snap["context"], "ten": snap["scenario_a"], "fifteen": snap["scenario_b"],
            "recommendation": snap["recommendation"], "risk": snap["risk"],
            "weekly": snap["weekly"], "record": record}


def _context_variant(context, **changes):
    """A context payload describing something else -- another scope, another
    question, a traced investigation id. Built by editing a copy of the
    snapshot's, since the endpoint that produced it no longer exists."""
    out = copy.deepcopy(context)
    if "scope" in changes:
        out["filter_state"]["value"] = changes["scope"]
    if "question" in changes:
        out["question"] = {"value": changes["question"], "source": "rca", "reason": None}
    if "investigation_type" in changes:
        out["investigation_type"] = {"value": changes["investigation_type"], "source": "rca",
                                     "reason": None}
    if "investigation_id" in changes:
        out["investigation_id"] = {"value": changes["investigation_id"], "source": "rca",
                                   "reason": None}
    return out


# --- the dataset fingerprint --------------------------------------------------


def test_fingerprint_is_deterministic():
    first = dataset_version()
    second = dataset_version()
    assert first == second
    assert len(first.fingerprint) == 64
    assert {name for name, _ in first.files} == {config.FACT_FILE, *config.DIM_FILES.values()}


def test_fingerprint_changes_when_the_data_changes(tmp_path):
    """A byte of difference is a different dataset."""
    original = tmp_path / "a"
    original.mkdir()
    for name in (config.FACT_FILE, *config.DIM_FILES.values()):
        shutil.copy(config.DATA_DIR / name, original / name)
    before = dataset_version(original).fingerprint

    changed = tmp_path / "b"
    shutil.copytree(original, changed)
    target = changed / config.DIM_FILES["channel"]
    target.write_text(target.read_text(encoding="utf-8") + "\n", encoding="utf-8")

    assert dataset_version(changed).fingerprint != before
    # …and the untouched copy is unchanged, so the difference is the data.
    assert dataset_version(original).fingerprint == before


def test_fingerprint_is_never_taken_from_the_client(client, journey):
    """No route accepts one; supplying one is a 422."""
    for path, body in (
        ("/api/store/scenarios",
         {"context": journey["context"], "simulation": journey["fifteen"],
          "dataset_version": "forged"}),
        ("/api/store/decisions", {"record": journey["record"], "dataset_version": "forged"}),
    ):
        assert client.post(path, json=body).status_code == 422, path


# --- scenario persistence -----------------------------------------------------


def test_scenario_save_mints_a_server_id_and_stores_the_result_verbatim(client, journey):
    stored = _post(client, "/api/store/scenarios",
                   {"context": journey["context"], "simulation": journey["fifteen"],
                    "name": "Scenario B @ 15%"})

    assert stored["scenario_id"].startswith("scn_")
    assert not stored["scenario_id"].startswith("scenario-")
    assert stored["version"] == 1
    assert stored["persisted"] is True
    assert stored["simulation"] == journey["fifteen"]
    assert stored["dataset_version"] == dataset_version().fingerprint
    assert stored["stale"] is False


def test_scenario_load_returns_exactly_what_was_written(client, journey):
    stored = _post(client, "/api/store/scenarios",
                   {"context": journey["context"], "simulation": journey["ten"]})
    read = client.get(f"/api/store/scenarios/{stored['scenario_id']}")
    assert read.status_code == 200
    assert read.json() == stored


def test_editing_a_scenario_appends_a_version_and_keeps_the_old_one(client, journey):
    """History is never overwritten."""
    first = _post(client, "/api/store/scenarios",
                  {"context": journey["context"], "simulation": journey["ten"],
                   "name": "Working scenario"})
    second = _post(client, "/api/store/scenarios",
                   {"context": journey["context"], "simulation": journey["fifteen"],
                    "name": "Working scenario", "scenario_id": first["scenario_id"],
                    "expected_version": 1})

    assert second["scenario_id"] == first["scenario_id"]
    assert second["version"] == 2
    assert second["versions"] == [1, 2]
    assert second["simulation"] == journey["fifteen"]

    original = client.get(
        f"/api/store/scenarios/{first['scenario_id']}", params={"version": 1}
    ).json()
    assert original["simulation"] == journey["ten"], "version 1 was overwritten"
    assert original["version"] == 1


def test_an_unrun_scenario_cannot_be_stored(client, journey):
    """A hypothetical with no result is not a result."""
    unrun = dict(journey["fifteen"], result=None)
    assert client.post("/api/store/scenarios",
                       json={"context": journey["context"],
                             "simulation": unrun}).status_code == 422


def test_a_scenario_from_another_scope_is_refused(client, journey):
    other = _context_variant(journey["context"], scope={"year": 2024})
    response = client.post("/api/store/scenarios",
                           json={"context": other, "simulation": journey["fifteen"]})
    assert response.status_code == 422
    assert "different scope" in response.json()["detail"]


def test_unknown_scenario_is_404(client):
    assert client.get("/api/store/scenarios/scn_nope").status_code == 404


# --- investigation traceability -----------------------------------------------


def test_investigation_id_is_server_minted_and_reused(client, journey):
    """The same investigation does not mint a second identity."""
    first = _post(client, "/api/store/scenarios",
                  {"context": journey["context"], "simulation": journey["ten"]})
    second = _post(client, "/api/store/scenarios",
                   {"context": journey["context"], "simulation": journey["fifteen"]})

    assert first["investigation_id"].startswith("inv_")
    assert first["investigation_id"] == second["investigation_id"]
    assert first["scenario_id"] != second["scenario_id"]


def test_a_different_investigation_gets_a_different_id(client, journey):
    other = _context_variant(journey["context"], question="A different question entirely?",
                             investigation_type="optimization")
    mine = _post(client, "/api/store/scenarios",
                 {"context": journey["context"], "simulation": journey["ten"]})
    theirs = _post(client, "/api/store/scenarios",
                   {"context": other, "simulation": journey["ten"]})
    assert mine["investigation_id"] != theirs["investigation_id"]


def test_investigation_id_propagates_into_the_decision_record(client, journey):
    """Investigation -> Simulation -> Scenario -> Decision, end to end.

    Once the client carries the minted id back into /simulation/context, the id
    travels through the FROZEN contracts into the record without any of them
    changing: B3.1 already built the field and the reason it was empty.
    """
    seeded = _post(client, "/api/store/scenarios",
                   {"context": journey["context"], "simulation": journey["fifteen"]})
    investigation_id = seeded["investigation_id"]

    # The record built WITHOUT an id keeps B3.1's honest null and its reason.
    assert journey["record"]["investigation"]["investigation_id"] is None
    assert journey["record"]["investigation"]["investigation_id_unavailable_reason"]

    traced_context = _context_variant(journey["context"], investigation_id=investigation_id)
    assert traced_context["investigation_id"]["value"] == investigation_id

    traced_record = _post(client, "/api/decision/record",
                          {"context": traced_context, "simulation": journey["fifteen"],
                           "recommendation": journey["recommendation"],
                           "risk": journey["risk"], "weekly": journey["weekly"]})
    assert traced_record["investigation"]["investigation_id"] == investigation_id
    assert traced_record["investigation"]["investigation_id_unavailable_reason"] is None

    stored = _post(client, "/api/store/decisions",
                   {"record": traced_record, "investigation_id": investigation_id,
                    "scenario_id": seeded["scenario_id"]})
    assert stored["investigation_id"] == investigation_id
    assert stored["scenario_id"] == seeded["scenario_id"]


# --- decision persistence -----------------------------------------------------


def test_decision_save_mints_an_id_and_stores_the_record_whole(client, journey):
    stored = _post(client, "/api/store/decisions", {"record": journey["record"]})

    assert stored["decision_id"].startswith("dec_")
    assert stored["version"] == 1
    assert stored["persisted"] is True
    assert stored["status"] == "draft"
    assert stored["record"] == journey["record"]


def test_the_stored_record_keeps_b7s_three_guarantees(client, journey):
    """The envelope carries the storage facts; the record is untouched.

    B8's briefing REFUSES a record that claims a decision_id or persistence, so
    keeping those out of the record is what lets a stored decision still be
    exported.
    """
    stored = _post(client, "/api/store/decisions", {"record": journey["record"]})
    record = stored["record"]

    assert record["decision_id"] is None
    assert record["status"] == "draft"
    assert record["meta"]["persisted"] is False
    assert record["readiness"]["can_be_approved"] is False

    assert stored["decision_id"] is not None
    assert stored["persisted"] is True

    briefing = client.post("/api/decision/briefing", json={"record": record})
    assert briefing.status_code == 200, "a stored record can no longer be exported"


def test_every_section_of_the_record_survives(client, journey):
    stored = _post(client, "/api/store/decisions", {"record": journey["record"]})
    record = stored["record"]
    original = journey["record"]

    assert record["expected_impact"] == original["expected_impact"]
    assert record["recommendation"] == original["recommendation"]
    assert record["governance"] == original["governance"]
    assert record["weekly"] == original["weekly"]
    assert record["readiness"] == original["readiness"]
    assert record["provenance"] == original["provenance"]
    assert len(record["governance"]["governance_gaps"]) == 7
    assert record["weekly"]["week_count"] == original["weekly"]["week_count"]
    for metric in record["expected_impact"]:
        assert "low" in metric and "high" in metric


def test_resaving_a_decision_appends_an_immutable_version(client, journey):
    first = _post(client, "/api/store/decisions", {"record": journey["record"]})

    risk_for_ten = copy.deepcopy(journey["risk"])
    risk_for_ten["scenario_id"] = journey["ten"]["scenario_id"]
    risk_for_ten["discount_pct"] = journey["ten"]["discount_pct"]
    risk_for_ten["provenance"]["scenario_provenance"] = journey["ten"]["provenance"]
    other = _post(client, "/api/decision/record",
                  {"context": journey["context"], "simulation": journey["ten"],
                   "recommendation": journey["recommendation"], "risk": risk_for_ten})
    second = _post(client, "/api/store/decisions",
                   {"record": other, "decision_id": first["decision_id"],
                    "expected_version": 1})

    assert second["decision_id"] == first["decision_id"]
    assert second["version"] == 2
    assert [v["version"] for v in second["versions"]] == [1, 2]

    original = client.get(f"/api/store/decisions/{first['decision_id']}",
                          params={"version": 1}).json()
    assert original["record"] == journey["record"], "version 1 was mutated"


def test_a_record_that_already_claims_an_id_or_persistence_is_refused(client, journey):
    for mutation in ({"decision_id": "dec_forged"}, {"status": "approved"}):
        bad = dict(journey["record"], **mutation)
        assert client.post("/api/store/decisions",
                           json={"record": bad}).status_code == 422, mutation
    bad = copy.deepcopy(journey["record"])
    bad["meta"]["persisted"] = True
    assert client.post("/api/store/decisions", json={"record": bad}).status_code == 422


def test_an_incomplete_record_is_refused(client, journey):
    for section in ("governance", "readiness", "provenance", "expected_impact"):
        partial = copy.deepcopy(journey["record"])
        partial.pop(section)
        response = client.post("/api/store/decisions", json={"record": partial})
        assert response.status_code == 422, section
        assert section in response.json()["detail"]


def test_decision_list_is_headers_only_and_newest_first(client, journey):
    _post(client, "/api/store/decisions", {"record": journey["record"]})
    listing = client.get("/api/store/decisions").json()

    assert listing["decisions"], "nothing listed"
    for entry in listing["decisions"]:
        assert entry["decision_id"].startswith("dec_")
        assert entry["persisted"] is True
        assert entry["owner"] is None
        assert "record" not in entry, "the list must not carry payloads"
    assert listing["current_dataset_version"] == dataset_version().fingerprint


def test_unknown_decision_is_404(client):
    assert client.get("/api/store/decisions/dec_nope").status_code == 404


# --- durability ---------------------------------------------------------------


def test_records_survive_a_process_restart(client, journey):
    """The point of the whole phase.

    Closing every connection and reopening the file is what a restarted
    process -- or a browser opened tomorrow -- actually does.
    """
    scenario = _post(client, "/api/store/scenarios",
                     {"context": journey["context"], "simulation": journey["fifteen"]})
    decision = _post(client, "/api/store/decisions", {"record": journey["record"]})

    db.close()  # every connection gone; nothing in memory

    assert client.get(f"/api/store/scenarios/{scenario['scenario_id']}").json() == scenario
    assert client.get(f"/api/store/decisions/{decision['decision_id']}").json() == decision


# --- staleness ----------------------------------------------------------------


def test_a_record_whose_data_has_changed_is_stale_and_is_not_recomputed(
    client, journey, monkeypatch
):
    """Report the difference; never resolve it."""
    stored = _post(client, "/api/store/decisions", {"record": journey["record"]})
    assert stored["stale"] is False and stored["stale_reason"] is None

    monkeypatch.setattr(repository, "current_fingerprint", lambda: "a-different-dataset")
    reread = client.get(f"/api/store/decisions/{stored['decision_id']}").json()

    assert reread["stale"] is True
    assert "not been recalculated" in reread["stale_reason"]
    assert reread["dataset_version"] == stored["dataset_version"]
    assert reread["current_dataset_version"] == "a-different-dataset"
    # The historical values are returned exactly as written.
    assert reread["record"] == stored["record"]


def test_staleness_never_triggers_a_recomputation(client, journey, monkeypatch):
    """If reading a stale record touched an engine, this would explode."""
    stored = _post(client, "/api/store/scenarios",
                   {"context": journey["context"], "simulation": journey["fifteen"]})
    monkeypatch.setattr(repository, "current_fingerprint", lambda: "moved-on")

    from app.tpo import aggregate, studio

    monkeypatch.setattr(studio, "simulate",
                        lambda *a, **k: pytest.fail("re-ran the scenario"))
    monkeypatch.setattr(aggregate, "calculate_kpis",
                        lambda *a, **k: pytest.fail("called the KPI engine"))

    reread = client.get(f"/api/store/scenarios/{stored['scenario_id']}").json()
    assert reread["stale"] is True
    assert reread["simulation"] == journey["fifteen"]


# --- concurrency --------------------------------------------------------------


def test_a_conflicting_scenario_write_is_refused_not_merged(client, journey):
    first = _post(client, "/api/store/scenarios",
                  {"context": journey["context"], "simulation": journey["ten"]})
    _post(client, "/api/store/scenarios",
          {"context": journey["context"], "simulation": journey["fifteen"],
           "scenario_id": first["scenario_id"], "expected_version": 1})

    # A second writer still believes version 1 is current.
    response = client.post("/api/store/scenarios",
                           json={"context": journey["context"],
                                 "simulation": journey["ten"],
                                 "scenario_id": first["scenario_id"],
                                 "expected_version": 1})
    assert response.status_code == 409
    detail = response.json()["detail"]
    assert detail["current_version"] == 2
    assert "moved on" in detail["message"]

    # …and the write did not land.
    assert client.get(f"/api/store/scenarios/{first['scenario_id']}").json()["version"] == 2


def test_a_conflicting_decision_write_is_refused_not_merged(client, journey):
    first = _post(client, "/api/store/decisions", {"record": journey["record"]})
    _post(client, "/api/store/decisions",
          {"record": journey["record"], "decision_id": first["decision_id"],
           "expected_version": 1})

    response = client.post("/api/store/decisions",
                           json={"record": journey["record"],
                                 "decision_id": first["decision_id"],
                                 "expected_version": 1})
    assert response.status_code == 409
    assert response.json()["detail"]["current_version"] == 2


def test_a_failed_write_preserves_what_was_already_stored(client, journey):
    """A refusal must not damage the record it refused to change."""
    stored = _post(client, "/api/store/decisions", {"record": journey["record"]})
    before = client.get(f"/api/store/decisions/{stored['decision_id']}").json()

    broken = copy.deepcopy(journey["record"])
    broken.pop("governance")
    assert client.post("/api/store/decisions",
                       json={"record": broken, "decision_id": stored["decision_id"],
                             "expected_version": 1}).status_code == 422

    assert client.get(f"/api/store/decisions/{stored['decision_id']}").json() == before


# --- no fabricated identity ---------------------------------------------------


def test_nothing_stored_carries_an_owner(client, journey):
    scenario = _post(client, "/api/store/scenarios",
                     {"context": journey["context"], "simulation": journey["fifteen"]})
    decision = _post(client, "/api/store/decisions", {"record": journey["record"]})
    listing = client.get("/api/store/decisions").json()

    for payload in (scenario, decision):
        assert payload["owner"] is None
        assert "unverified" in payload["owner_note"].lower()
    assert all(e["owner"] is None for e in listing["decisions"])

    # Scanned as KEYS, not as prose: B5's weekly note legitimately contains the
    # word "authority", and a substring sweep would flag it as an author.
    def keys(node, acc=None):
        acc = acc if acc is not None else set()
        if isinstance(node, dict):
            for key, value in node.items():
                acc.add(str(key).lower())
                keys(value, acc)
        elif isinstance(node, list):
            for item in node:
                keys(item, acc)
        return acc

    present = keys([scenario, decision, listing])
    for field in ("author", "approver", "approved_by", "created_by", "user",
                  "signed_by", "reviewer"):
        assert field not in present, field

    flat = json.dumps([scenario, decision, listing], ensure_ascii=False).lower()
    for name in ("sanjay", "commercial analyst", "@company.com"):
        assert name not in flat, name


def test_no_route_accepts_an_owner(client, journey):
    for path, body in (
        ("/api/store/scenarios",
         {"context": journey["context"], "simulation": journey["fifteen"]}),
        ("/api/store/decisions", {"record": journey["record"]}),
    ):
        for field in ("owner", "author", "user", "created_by", "approved_by"):
            assert client.post(path, json={**body, field: "Sanjay Kumar"}).status_code == 422


def test_the_store_makes_no_approval_or_governance_claim(client, journey):
    stored = _post(client, "/api/store/decisions", {"record": journey["record"]})
    envelope = {k: v for k, v in stored.items() if k != "record"}
    flat = json.dumps(envelope, ensure_ascii=False).lower()
    for word in ("approved", "approval", "compliant", "authoris", "audit"):
        assert word not in flat, word
    assert stored["status"] == "draft"


# --- the frozen contracts -----------------------------------------------------


def test_b1_to_b9_contracts_are_unchanged(client, journey):
    """Storing changes nothing about what the assembler returns."""
    record_again = _post(client, "/api/decision/record",
                         {"context": journey["context"], "simulation": journey["fifteen"],
                          "recommendation": journey["recommendation"],
                          "risk": journey["risk"], "weekly": journey["weekly"]})
    assert record_again == journey["record"]
    assert record_again["decision_id"] is None
    assert record_again["meta"]["persisted"] is False


def test_no_engine_or_policy_module_is_imported_by_the_store():
    """The store records; it does not compute.

    Matched on import syntax: `repository` legitimately holds variables called
    `record` and `scenario`, and a bare-name scan would flag reading the
    payloads it exists to read.
    """
    import re

    for module in ("db", "repository", "fingerprint"):
        source = Path(f"app/store/{module}.py").read_text(encoding="utf-8")
        imports = re.findall(r"^[ \t]*(?:from|import)[ \t]+\S+.*$", source, flags=re.M)
        for line in imports:
            for engine in ("aggregate", "execution", "recommendation", "risk",
                           "weekly", "comparison", "scenarios", "response",
                           "simulation", "service", "filters", "decision", "briefing"):
                assert f" {engine}" not in line and f".{engine}" not in line, (module, line)


def test_the_store_is_the_only_thing_that_writes():
    """No write path was added anywhere outside app/store/."""
    import re

    for path in Path("app").rglob("*.py"):
        if "store" in path.parts:
            continue
        source = path.read_text(encoding="utf-8")
        code = re.sub(r'""".*?"""', "", source, flags=re.S)
        code = re.sub(r"#.*", "", code)
        for forbidden in ("sqlite3", "INSERT INTO", "UPDATE ", "json.dump("):
            assert forbidden not in code, f"{path}: {forbidden}"


def test_the_store_never_updates_a_stored_payload():
    """A stored payload is never rewritten. Versions are appended, not edited."""
    source = Path("app/store/repository.py").read_text(encoding="utf-8")
    assert "UPDATE scenario_results" not in source
    assert "UPDATE decision_versions" not in source


def test_the_only_delete_in_the_store_is_the_decision_history_clear():
    """Append-only, with ONE stated exception.

    The store was append-only by construction and this test asserted no DELETE
    appeared in the repository at all. Decision Center offers an explicit,
    confirmed "Clear history" action, so the deletes that exist are the decision
    rows, their versions, and -- since the 2026-09-22 rebuild -- the board
    decisions the new Decision Center stores.

    THE TEETH ARE IN WHAT IS STILL FORBIDDEN. Investigations, scenarios and
    scenario results are the evidence a decision was taken from and remain
    undeletable -- a decision may be cleared, the record of what was measured
    may not. Anything else acquiring a DELETE fails here.
    """
    source = Path("app/store/repository.py").read_text(encoding="utf-8")
    deleted_tables = set(re.findall(r"DELETE FROM (\w+)", source))
    assert deleted_tables == {"decisions", "decision_versions", "board_decisions"}, deleted_tables
