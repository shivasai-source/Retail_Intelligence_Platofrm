"""The store's connection and schema -- B10.

SQLITE, AND WHY. The project had no database and no driver. SQLite is in the
Python standard library, so this adds a store without adding a dependency; it
is a single file, so a deployment is a copy; and it is genuinely relational, so
the immutable-version tables below are enforced by primary keys rather than by
convention. Nothing in the repository argued for anything heavier -- there is
one process, one dataset and no concurrent writer beyond a handful of browser
tabs.

WHAT IS STORED, AND WHAT IS NOT. Scenario results and decision records are
stored WHOLE, as the JSON the frozen contracts produced, in a single column.
They are not shredded into per-metric rows: a KPI band split across columns
would be a second representation of a number the engine already computed, and
the first time the two disagreed the store would be lying. The columns beside
the payload are only what a query needs -- identity, ownership, lineage,
version, dataset fingerprint and time.

APPEND-ONLY. `scenario_results` and `decision_versions` are written once and
never updated. Editing a scenario appends a result; re-saving a decision
appends a version. There is no UPDATE and no DELETE statement anywhere in this
package, so history cannot be rewritten by the code that owns it.

NO OWNER. Every row carries `owner` and every row's `owner` is NULL. This
project has no authentication, so there is no actor to attribute a row to, and
writing the browser-typed name into an ownership column would manufacture the
attribution the preceding phases refused to fabricate. The column exists so
that identity, when it arrives, has somewhere to go.
"""

from __future__ import annotations

import os
import sqlite3
import threading
from pathlib import Path

#: Where the store lives. Overridable so the tests can use a temp file, and so
#: a deployment can put it on a mounted volume.
_DEFAULT_PATH = Path(__file__).resolve().parents[2] / ".store" / "tiq.db"

SCHEMA_VERSION = 1

#: Stated once, stored on every row, and returned by every read.
NO_OWNER_NOTE = (
    "Ownership is unverified. This application has no authentication, so there "
    "is no actor to attribute this record to and none has been invented."
)

_SCHEMA = """
PRAGMA journal_mode=WAL;

CREATE TABLE IF NOT EXISTS schema_meta (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL
);

-- One investigation. Identified by a server-minted id; found again by its
-- natural key so the same question over the same scope does not mint a second.
CREATE TABLE IF NOT EXISTS investigations (
    id                 TEXT PRIMARY KEY,
    natural_key        TEXT NOT NULL UNIQUE,
    investigation_type TEXT,
    question           TEXT,
    scope_json         TEXT NOT NULL,
    source             TEXT,
    owner              TEXT,          -- always NULL: see NO_OWNER_NOTE
    created_at         TEXT NOT NULL
);

-- A scenario's identity. Mutable only in `name` and `current_version`; the
-- lever sets and results live in the append-only table below.
CREATE TABLE IF NOT EXISTS scenarios (
    id               TEXT PRIMARY KEY,
    investigation_id TEXT REFERENCES investigations(id),
    name             TEXT NOT NULL,
    scope_json       TEXT NOT NULL,
    current_version  INTEGER NOT NULL,
    owner            TEXT,            -- always NULL
    created_at       TEXT NOT NULL,
    updated_at       TEXT NOT NULL
);

-- APPEND-ONLY. One row per save. Never updated, never deleted.
CREATE TABLE IF NOT EXISTS scenario_results (
    scenario_id     TEXT NOT NULL REFERENCES scenarios(id),
    version         INTEGER NOT NULL,
    payload_json    TEXT NOT NULL,   -- the whole /simulation/simulate response
    dataset_version TEXT NOT NULL,
    created_at      TEXT NOT NULL,
    PRIMARY KEY (scenario_id, version)
);

-- A decision's identity. Decision Center is the system of record, so this id
-- is the one a person cites.
CREATE TABLE IF NOT EXISTS decisions (
    id               TEXT PRIMARY KEY,
    investigation_id TEXT REFERENCES investigations(id),
    scenario_id      TEXT,
    scenario_name    TEXT,
    current_version  INTEGER NOT NULL,
    owner            TEXT,            -- always NULL
    created_at       TEXT NOT NULL,
    updated_at       TEXT NOT NULL
);

-- APPEND-ONLY. One row per save. `record_json` is the B7 DecisionRecord
-- verbatim -- decision_id null, status draft, persisted false -- exactly as
-- /api/decision/record produced it, so /api/decision/briefing still accepts it.
CREATE TABLE IF NOT EXISTS decision_versions (
    decision_id     TEXT NOT NULL REFERENCES decisions(id),
    version         INTEGER NOT NULL,
    record_json     TEXT NOT NULL,
    dataset_version TEXT NOT NULL,
    created_at      TEXT NOT NULL,
    PRIMARY KEY (decision_id, version)
);

-- Decision Center's board decisions: the scenarios that were compared, as the
-- Simulation Studio snapshotted them (display strings), which one was chosen
-- and why. One row per save; nothing is edited afterwards.
CREATE TABLE IF NOT EXISTS board_decisions (
    id              TEXT PRIMARY KEY,
    chosen_slot     INTEGER,
    chosen_label    TEXT,
    scenario_count  INTEGER NOT NULL,
    payload_json    TEXT NOT NULL,
    dataset_version TEXT NOT NULL,
    created_at      TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_scenarios_investigation
    ON scenarios(investigation_id);
CREATE INDEX IF NOT EXISTS idx_decisions_investigation
    ON decisions(investigation_id);
CREATE INDEX IF NOT EXISTS idx_decisions_updated
    ON decisions(updated_at DESC);
"""

_local = threading.local()
_path_lock = threading.Lock()
_configured_path: Path | None = None


def store_path() -> Path:
    """The database file this process is using."""
    global _configured_path
    with _path_lock:
        if _configured_path is None:
            override = os.environ.get("TPO_STORE_PATH")
            _configured_path = Path(override) if override else _DEFAULT_PATH
        return _configured_path


def use_path(path: Path) -> None:
    """Point the store at another file. For tests only; no route calls it."""
    global _configured_path
    with _path_lock:
        _configured_path = Path(path)
    close()


def connect() -> sqlite3.Connection:
    """This thread's connection, opened and migrated on first use.

    One connection per thread because SQLite objects are not shareable across
    them, and FastAPI runs sync endpoints on a worker pool.
    """
    path = store_path()
    existing = getattr(_local, "conn", None)
    if existing is not None and getattr(_local, "path", None) == path:
        return existing

    if existing is not None:
        existing.close()

    path.parent.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(path, check_same_thread=False, isolation_level=None)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA foreign_keys=ON")
    conn.executescript(_SCHEMA)
    conn.execute(
        "INSERT OR REPLACE INTO schema_meta (key, value) VALUES ('schema_version', ?)",
        (str(SCHEMA_VERSION),),
    )
    _local.conn = conn
    _local.path = path
    return conn


def close() -> None:
    conn = getattr(_local, "conn", None)
    if conn is not None:
        conn.close()
    _local.conn = None
    _local.path = None
