"""The repository layer -- B10.

The ONLY module that reads or writes the store. Routes call these functions;
they do not hold SQL. Nothing in `app/tpo/` is imported except the dataset
fingerprint and, for validation, the frozen decision assembler's own section
list -- no KPI, uplift, comparison, recommendation, risk or weekly value is
computed, re-derived or adjusted anywhere in this file.

WHAT A SAVE IS. A save records a result the frozen contracts already produced,
exactly as they produced it, alongside the identity, lineage, version and
dataset fingerprint needed to find it again and to know what it was computed
from. A save is not a second opinion: if a stored number ever disagrees with
the same number in Simulation Studio, the cause is a bug here.

THE RECORD IS STORED UNTOUCHED, AND THE ENVELOPE CARRIES THE STORAGE FACTS.
B7 guarantees `decision_id: null`, `status: "draft"`, `meta.persisted: false`,
and B8's briefing REFUSES any record that claims otherwise. So the stored
DecisionRecord keeps all three exactly as B7 wrote them, and the storage
identity -- the minted `decision_id`, `version`, `persisted: true`,
`dataset_version`, `stale` -- lives in an envelope AROUND it. A record read
back out of the store can therefore be handed straight to
/api/decision/briefing, and B7's and B8's contracts are untouched.

STALE, NEVER SILENTLY REFRESHED. A stored record's dataset fingerprint is
compared with the dataset this process has loaded. When they differ the
envelope says `stale: true` and the historical payload is returned exactly as
written. Nothing is recomputed, nothing is overwritten and nothing is
presented as current.

NO OWNER. Every row's owner is NULL, and every envelope says why.
"""

from __future__ import annotations

import hashlib
import json
import sqlite3
import uuid
from datetime import datetime, timezone
from typing import Any

from app.store import db
from app.store.fingerprint import current_fingerprint, dataset_version

#: Sections a payload must carry to be a B7 decision record. Checked here so a
#: partial record cannot become a stored one.
_RECORD_SECTIONS = (
    "decision_id", "status", "scenario", "investigation", "scope",
    "expected_impact", "recommendation", "governance", "weekly", "readiness",
    "provenance", "meta",
)


class StoreError(ValueError):
    """The request cannot be stored as asked."""


class NotFound(StoreError):
    """No such stored record."""


class VersionConflict(StoreError):
    """Someone else wrote a newer version.

    Optimistic concurrency: the caller states the version it believes is
    current, and a write against a stale expectation is REFUSED rather than
    applied on top of work the caller never saw.
    """

    def __init__(self, message: str, current_version: int) -> None:
        super().__init__(message)
        self.current_version = current_version


def _now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def _mint(prefix: str) -> str:
    """A server-minted id.

    Server-side and opaque on purpose. The frontend's `scenario-${nextIndex}`
    is a session-local counter -- `scenario-1` in one session is a different
    scenario from `scenario-1` in the next -- so it can never be a durable key.
    """
    return f"{prefix}_{uuid.uuid4().hex}"


def _require(condition: bool, message: str) -> None:
    if not condition:
        raise StoreError(message)


# --- investigations -----------------------------------------------------------


def _natural_key(context: dict[str, Any]) -> str:
    """What makes two saves the same investigation.

    The archetype, the question and the scope. Hashed so the key is a fixed
    length whatever the scope contains, and derived server-side from the
    context the frozen /simulation/context endpoint produced -- the client
    never proposes an investigation id.
    """
    question = (context.get("question") or {}).get("value")
    kind = (context.get("investigation_type") or {}).get("value")
    scope = (context.get("filter_state") or {}).get("value")
    material = json.dumps([kind, question, scope], sort_keys=True, ensure_ascii=False)
    return hashlib.sha256(material.encode("utf-8")).hexdigest()


def resolve_investigation(conn: sqlite3.Connection, context: dict[str, Any]) -> str:
    """The durable id of the investigation this context describes.

    Minted on first sight, reused afterwards. B3.1 built `investigation_id` and
    the honest reason it was empty -- "nothing in the investigations router, its
    data files or its client state assigns one". This is where one is assigned,
    and once the client carries it back into /simulation/context the id travels
    through the frozen contracts into the decision record without any of them
    changing.
    """
    key = _natural_key(context)
    row = conn.execute(
        "SELECT id FROM investigations WHERE natural_key = ?", (key,)
    ).fetchone()
    if row:
        return row["id"]

    investigation_id = _mint("inv")
    conn.execute(
        "INSERT INTO investigations (id, natural_key, investigation_type, question,"
        " scope_json, source, owner, created_at)"
        " VALUES (?, ?, ?, ?, ?, ?, NULL, ?)",
        (
            investigation_id,
            key,
            (context.get("investigation_type") or {}).get("value"),
            (context.get("question") or {}).get("value"),
            json.dumps((context.get("filter_state") or {}).get("value"), ensure_ascii=False),
            context.get("source"),
            _now(),
        ),
    )
    return investigation_id


# --- scenarios ----------------------------------------------------------------


def save_scenario(
    context: dict[str, Any],
    simulation: dict[str, Any],
    name: str | None = None,
    scenario_id: str | None = None,
    expected_version: int | None = None,
) -> dict[str, Any]:
    """Store one simulation result.

    A NEW scenario when `scenario_id` is absent; a NEW VERSION of an existing
    one when it is present. Editing never overwrites: the previous result row
    stays exactly where it was and a new one is appended beside it.
    """
    _require(isinstance(simulation, dict) and simulation.get("result") is not None,
             "Only a scenario that has been simulated can be stored. Run it first.")
    _require(bool(simulation.get("provenance")),
             "The simulation payload carries no provenance and cannot be stored.")

    scope = (simulation.get("scope") or {}).get("filters_applied")
    context_scope = (context.get("filter_state") or {}).get("value")
    _require(
        context_scope == scope,
        "The investigation context describes a different scope from the simulated "
        "scenario. Storing them together would misattribute the result.",
    )

    fingerprint = current_fingerprint()
    conn = db.connect()
    with conn:
        conn.execute("BEGIN IMMEDIATE")
        investigation_id = resolve_investigation(conn, context)
        scope_json = json.dumps(scope, ensure_ascii=False)
        label = name or simulation.get("name") or simulation.get("scenario_id") or "Scenario"
        now = _now()

        if scenario_id is None:
            scenario_id = _mint("scn")
            version = 1
            conn.execute(
                "INSERT INTO scenarios (id, investigation_id, name, scope_json,"
                " current_version, owner, created_at, updated_at)"
                " VALUES (?, ?, ?, ?, ?, NULL, ?, ?)",
                (scenario_id, investigation_id, label, scope_json, version, now, now),
            )
        else:
            row = conn.execute(
                "SELECT current_version FROM scenarios WHERE id = ?", (scenario_id,)
            ).fetchone()
            if row is None:
                raise NotFound(f"No stored scenario {scenario_id!r}.")
            current = int(row["current_version"])
            if expected_version is not None and expected_version != current:
                raise VersionConflict(
                    f"This scenario has moved on: you are writing against version "
                    f"{expected_version}, but version {current} is current. Reload it "
                    f"and re-apply your change.",
                    current,
                )
            version = current + 1
            conn.execute(
                "UPDATE scenarios SET name = ?, current_version = ?, updated_at = ?"
                " WHERE id = ?",
                (label, version, now, scenario_id),
            )

        conn.execute(
            "INSERT INTO scenario_results (scenario_id, version, payload_json,"
            " dataset_version, created_at) VALUES (?, ?, ?, ?, ?)",
            (scenario_id, version, json.dumps(simulation, ensure_ascii=False),
             fingerprint, now),
        )

    return load_scenario(scenario_id)


def load_scenario(scenario_id: str, version: int | None = None) -> dict[str, Any]:
    """One stored scenario, with the result exactly as it was written."""
    conn = db.connect()
    head = conn.execute(
        "SELECT * FROM scenarios WHERE id = ?", (scenario_id,)
    ).fetchone()
    if head is None:
        raise NotFound(f"No stored scenario {scenario_id!r}.")

    wanted = head["current_version"] if version is None else version
    result = conn.execute(
        "SELECT * FROM scenario_results WHERE scenario_id = ? AND version = ?",
        (scenario_id, wanted),
    ).fetchone()
    if result is None:
        raise NotFound(f"Scenario {scenario_id!r} has no version {wanted}.")

    versions = [
        int(r["version"])
        for r in conn.execute(
            "SELECT version FROM scenario_results WHERE scenario_id = ? ORDER BY version",
            (scenario_id,),
        )
    ]

    return {
        "scenario_id": scenario_id,
        "investigation_id": head["investigation_id"],
        "name": head["name"],
        "version": int(result["version"]),
        "current_version": int(head["current_version"]),
        "versions": versions,
        "persisted": True,
        "owner": None,
        "owner_note": db.NO_OWNER_NOTE,
        "created_at": head["created_at"],
        "saved_at": result["created_at"],
        **_dataset_envelope(result["dataset_version"]),
        "simulation": json.loads(result["payload_json"]),
    }


# --- decisions ----------------------------------------------------------------


def save_decision(
    record: dict[str, Any],
    investigation_id: str | None = None,
    scenario_id: str | None = None,
    decision_id: str | None = None,
    expected_version: int | None = None,
) -> dict[str, Any]:
    """Store one B7 decision record, whole and unedited.

    The record goes in exactly as `/api/decision/record` produced it. Nothing
    is stripped, summarised or re-keyed: the recommendation, the risk findings,
    the governance gaps, the weekly decomposition, both ends of every KPI band
    and the whole provenance block are the payload.
    """
    _require(isinstance(record, dict), "A decision record object is required.")
    missing = [s for s in _RECORD_SECTIONS if s not in record]
    _require(not missing,
             "This is not a complete decision record. Missing: " + ", ".join(missing) + ".")
    _require(record.get("decision_id") is None,
             "This record already carries a decision_id. Only a freshly assembled "
             "record from /api/decision/record can be stored.")
    _require(record.get("status") == "draft",
             f"This record's status is {record.get('status')!r}. B10 stores drafts; no "
             "approval workflow exists to produce any other state.")
    _require((record.get("meta") or {}).get("persisted") is False,
             "This record already claims to have been persisted.")

    fingerprint = current_fingerprint()
    scenario = record.get("scenario") or {}
    now = _now()
    conn = db.connect()

    with conn:
        conn.execute("BEGIN IMMEDIATE")
        # B12: prefer the name the scenario was SAVED under.
        #
        # `record.scenario.name` is B7's own fallback -- it takes the name from
        # the /simulate payload, which carries none, and lands on the session id
        # ("scenario-b"). The store already holds the name the user typed
        # ("Scenario B @ 15%"), so the history list should show that. A label
        # choice only: no stored payload changes, and an unlinked decision keeps
        # B7's fallback exactly as before.
        label = scenario.get("name")
        if scenario_id:
            named = conn.execute(
                "SELECT name FROM scenarios WHERE id = ?", (scenario_id,)
            ).fetchone()
            if named and named["name"]:
                label = named["name"]

        if decision_id is None:
            decision_id = _mint("dec")
            version = 1
            conn.execute(
                "INSERT INTO decisions (id, investigation_id, scenario_id,"
                " scenario_name, current_version, owner, created_at, updated_at)"
                " VALUES (?, ?, ?, ?, ?, NULL, ?, ?)",
                (decision_id, investigation_id, scenario_id or scenario.get("scenario_id"),
                 label, version, now, now),
            )
        else:
            row = conn.execute(
                "SELECT current_version FROM decisions WHERE id = ?", (decision_id,)
            ).fetchone()
            if row is None:
                raise NotFound(f"No stored decision {decision_id!r}.")
            current = int(row["current_version"])
            if expected_version is not None and expected_version != current:
                raise VersionConflict(
                    f"This decision has moved on: you are writing against version "
                    f"{expected_version}, but version {current} is current. Reload it "
                    f"before saving again.",
                    current,
                )
            version = current + 1
            conn.execute(
                "UPDATE decisions SET scenario_id = ?, scenario_name = ?,"
                " current_version = ?, updated_at = ? WHERE id = ?",
                (scenario_id or scenario.get("scenario_id"), label,
                 version, now, decision_id),
            )

        conn.execute(
            "INSERT INTO decision_versions (decision_id, version, record_json,"
            " dataset_version, created_at) VALUES (?, ?, ?, ?, ?)",
            (decision_id, version, json.dumps(record, ensure_ascii=False),
             fingerprint, now),
        )

    return load_decision(decision_id)


def load_decision(decision_id: str, version: int | None = None) -> dict[str, Any]:
    """One stored decision.

    The envelope carries the storage facts; `record` is the B7 payload byte for
    byte, still `decision_id: null` / `status: "draft"` / `persisted: false`,
    so it can be handed straight back to /api/decision/briefing.
    """
    conn = db.connect()
    head = conn.execute("SELECT * FROM decisions WHERE id = ?", (decision_id,)).fetchone()
    if head is None:
        raise NotFound(f"No stored decision {decision_id!r}.")

    wanted = head["current_version"] if version is None else version
    stored = conn.execute(
        "SELECT * FROM decision_versions WHERE decision_id = ? AND version = ?",
        (decision_id, wanted),
    ).fetchone()
    if stored is None:
        raise NotFound(f"Decision {decision_id!r} has no version {wanted}.")

    versions = [
        {"version": int(r["version"]), "saved_at": r["created_at"],
         "dataset_version": r["dataset_version"]}
        for r in conn.execute(
            "SELECT version, created_at, dataset_version FROM decision_versions"
            " WHERE decision_id = ? ORDER BY version",
            (decision_id,),
        )
    ]

    return {
        "decision_id": decision_id,
        "version": int(stored["version"]),
        "current_version": int(head["current_version"]),
        "versions": versions,
        "status": "draft",
        "persisted": True,
        "owner": None,
        "owner_note": db.NO_OWNER_NOTE,
        "investigation_id": head["investigation_id"],
        "scenario_id": head["scenario_id"],
        "scenario_name": head["scenario_name"],
        "created_at": head["created_at"],
        "saved_at": stored["created_at"],
        **_dataset_envelope(stored["dataset_version"]),
        "record": json.loads(stored["record_json"]),
    }


def list_decisions(limit: int = 50) -> dict[str, Any]:
    """Every stored decision, newest first. Headers only -- no record payloads."""
    conn = db.connect()
    rows = conn.execute(
        "SELECT d.*, v.dataset_version AS dv, v.created_at AS saved_at"
        " FROM decisions d"
        " JOIN decision_versions v"
        "   ON v.decision_id = d.id AND v.version = d.current_version"
        " ORDER BY d.updated_at DESC, d.id DESC LIMIT ?",
        (max(1, min(limit, 200)),),
    ).fetchall()

    return {
        "decisions": [
            {
                "decision_id": r["id"],
                "version": int(r["current_version"]),
                "status": "draft",
                "persisted": True,
                "owner": None,
                "investigation_id": r["investigation_id"],
                "scenario_id": r["scenario_id"],
                "scenario_name": r["scenario_name"],
                "created_at": r["created_at"],
                "saved_at": r["saved_at"],
                **_dataset_envelope(r["dv"]),
            }
            for r in rows
        ],
        "owner_note": db.NO_OWNER_NOTE,
        "current_dataset_version": current_fingerprint(),
    }


def clear_decisions() -> int:
    """Empty the decision history, versions and all.

    APPEND-ONLY WAS THE RULE, AND THIS IS THE STATED EXCEPTION. Reports are
    derived artifacts and have always been clearable; scenarios and decisions
    are the record, which is why nothing here ever deleted one. This exists
    because the Decision Center now asks for it explicitly, and it is
    deliberately the ONLY delete on this table: there is no single-row remove
    and no filtered clear, so a history that looks empty is empty.

    IT DELETES DECISIONS AND NOTHING ELSE. The investigations and scenarios a
    decision referenced are untouched -- they are the evidence a decision was
    taken from, they are referenced by scenario results as well, and removing
    them would take away work the decision merely pointed at.

    Answers with the number removed rather than nothing, so the caller can say
    what happened. Clearing an already-empty history is a success with a count
    of zero.
    """
    conn = db.connect()
    with conn:
        removed = conn.execute("SELECT COUNT(*) AS n FROM decisions").fetchone()["n"]
        # Versions first: they reference the decision rows.
        conn.execute("DELETE FROM decision_versions")
        conn.execute("DELETE FROM decisions")
    return int(removed)


def count_decisions() -> int:
    """How many decisions the store holds."""
    return int(db.connect().execute("SELECT COUNT(*) AS n FROM decisions").fetchone()["n"])


# --- dataset lineage ----------------------------------------------------------


def _dataset_envelope(stored_fingerprint: str) -> dict[str, Any]:
    """Which data this was computed from, and whether that is still the data.

    A DIFFERENCE IS REPORTED, NEVER RESOLVED. The stored values are returned
    exactly as written; nothing is recomputed against the current dataset and
    nothing is overwritten. A stale record is a historical record, and saying
    so is the whole point of the fingerprint.
    """
    current = current_fingerprint()
    stale = stored_fingerprint != current
    return {
        "dataset_version": stored_fingerprint,
        "current_dataset_version": current,
        "stale": stale,
        "stale_reason": (
            "The source data has changed since this was saved. The values below are "
            "the historical ones, exactly as they were computed and stored. They have "
            "not been recalculated against the current data and are not current."
            if stale
            else None
        ),
    }


def dataset_version_detail() -> dict[str, Any]:
    return dataset_version().as_dict()


# --- board decisions (Decision Center, 2026-09-22) ---------------------------

def save_board_decision(board: dict[str, Any]) -> dict[str, Any]:
    """Store one Decision Center board: the compared scenarios exactly as the
    Simulation Studio snapshotted them, the chosen one and the rationale.

    STORED WHOLE. Every figure in `scenarios[*].kpis` is a display string the
    studio produced; nothing here reads, recomputes or re-keys it. The
    envelope carries the dataset fingerprint so a later reader knows which
    data the numbers came from.
    """
    _require(isinstance(board, dict), "A board object is required.")
    scenarios = board.get("scenarios")
    _require(isinstance(scenarios, list) and len(scenarios) > 0,
             "A decision needs at least one scenario on the board.")
    _require(len(scenarios) <= 3, "The board holds at most three scenarios.")
    for s in scenarios:
        _require(isinstance(s, dict) and isinstance(s.get("kpis"), list) and s.get("slot") is not None,
                 "Each scenario needs a slot and its KPI rows.")
    chosen = board.get("chosen_slot")
    _require(chosen is None or any(s.get("slot") == chosen for s in scenarios),
             "The chosen scenario is not on the board.")
    rationale = board.get("rationale")
    _require(rationale is None or isinstance(rationale, str), "The rationale must be text.")

    chosen_scenario = next((s for s in scenarios if s.get("slot") == chosen), None)
    decision_id = _mint("dec")
    now = _now()
    fingerprint = current_fingerprint()
    payload = {
        "scenarios": scenarios,
        "chosen_slot": chosen,
        "rationale": (rationale or "").strip(),
    }
    conn = db.connect()
    with conn:
        conn.execute(
            "INSERT INTO board_decisions (id, chosen_slot, chosen_label, scenario_count,"
            " payload_json, dataset_version, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
            (decision_id, chosen, (chosen_scenario or {}).get("scope", {}).get("label"),
             len(scenarios), json.dumps(payload, ensure_ascii=False), fingerprint, now),
        )
    return _board_row(conn, decision_id)


def _board_row(conn, decision_id: str) -> dict[str, Any]:
    r = conn.execute("SELECT * FROM board_decisions WHERE id = ?", (decision_id,)).fetchone()
    if r is None:
        raise NotFound(f"No board decision {decision_id!r}.")
    return {
        "decision_id": r["id"],
        "created_at": r["created_at"],
        "chosen_slot": r["chosen_slot"],
        "chosen_label": r["chosen_label"],
        "scenario_count": int(r["scenario_count"]),
        **_dataset_envelope(r["dataset_version"]),
        **json.loads(r["payload_json"]),
    }


def load_board_decision(decision_id: str) -> dict[str, Any]:
    return _board_row(db.connect(), decision_id)


def list_board_decisions(limit: int = 50) -> dict[str, Any]:
    """Newest first. Headers plus a one-line summary of the chosen scenario
    (its revenue and ROI rows), so a history list can describe each decision
    without loading the whole board."""
    conn = db.connect()
    rows = conn.execute(
        "SELECT * FROM board_decisions ORDER BY created_at DESC, rowid DESC LIMIT ?",
        (max(1, min(limit, 200)),),
    ).fetchall()
    out = []
    for r in rows:
        payload = json.loads(r["payload_json"])
        chosen = next((s for s in payload.get("scenarios", []) if s.get("slot") == r["chosen_slot"]), None)
        summary = {}
        for k in (chosen or {}).get("kpis", []):
            if k.get("key") in ("revenue", "roi", "discount", "days", "budget"):
                summary[k["key"]] = k.get("value")
        out.append({
            "decision_id": r["id"],
            "created_at": r["created_at"],
            "chosen_slot": r["chosen_slot"],
            "chosen_label": r["chosen_label"],
            "scenario_count": int(r["scenario_count"]),
            "rationale": payload.get("rationale", ""),
            "summary": summary,
            **_dataset_envelope(r["dataset_version"]),
        })
    return {"decisions": out, "current_dataset_version": current_fingerprint()}


def clear_board_decisions() -> int:
    conn = db.connect()
    with conn:
        return conn.execute("DELETE FROM board_decisions").rowcount
