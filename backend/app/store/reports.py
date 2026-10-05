"""The Report Center's store — generated reports, and the artifacts themselves.

WHERE THIS LIVES, AND WHY IT LIVES HERE. Every write in this project goes through
`app/store/`, and `tests/test_store_persistence.test_the_store_is_the_only_thing_that_writes`
enforces it: no module outside this package may contain `sqlite3` or an `INSERT`.
This module was first written as `app/reports/store.py` and that guard caught it,
correctly — persistence belongs beside the rest of the persistence, not beside
the thing that happens to use it.

It reuses `db.py`'s connection: SQLite, in the standard library, one file, opened
per thread and migrated on first use. The table is created here with
`CREATE TABLE IF NOT EXISTS` on that shared connection, so `db.py` is untouched.

IT IS NOT `repository.py`, AND THAT IS THE POINT OF KEEPING THEM APART.
`repository.py` holds the scenario and decision history, which is append-only by
construction and guarded as such. This module holds DERIVED ARTIFACTS, which may
be deleted. Putting the two in one file would have meant either weakening that
guard or refusing users a way to tidy their own report library.

THE ARTIFACTS ARE BLOBS, NOT LOOSE FILES. `db.py`'s own rationale for SQLite is
that "it is a single file, so a deployment is a copy" — writing the .xlsx and
.pdf beside it as loose files would break that, and would make an orphaned
artifact possible the moment a metadata row and a directory disagreed. Holding
them in the row means a delete is atomic and cannot orphan anything, and no
filesystem path is ever exposed to the browser: a report is addressed only by
its `report_id`. Reports are 5-50 KB, so there is nothing to optimise here.

THIS TABLE IS NOT APPEND-ONLY, and that is a deliberate departure from the
scenario and decision tables beside it. Those are a record of what was decided
and must not be rewritable — `repository.py` carries them and is guarded against
UPDATE and DELETE by name. A report is a DERIVED ARTIFACT, regenerable from its
stored scope at any time, so deleting one destroys no history, and a library
nobody can tidy is a library that fills with noise.

NOTHING IS COMPUTED HERE. This module stores bytes and metadata that
`app/reports/service.py` produced.
"""

from __future__ import annotations

import json
import sqlite3
import uuid
from dataclasses import dataclass, field
from datetime import datetime, timezone
from typing import Any

from app.store import db

#: Report lifecycle. A row is written GENERATING, flipped to READY only once both
#: artifacts exist, and FAILED with a reason if generation raised. `READY` is
#: never written for a row whose bytes are absent -- see `finish`.
GENERATING = "generating"
READY = "ready"
FAILED = "failed"

_SCHEMA = """
CREATE TABLE IF NOT EXISTS reports (
    id             TEXT PRIMARY KEY,
    name           TEXT NOT NULL,
    module         TEXT NOT NULL,
    module_label   TEXT NOT NULL,
    title          TEXT NOT NULL,
    scope_label    TEXT NOT NULL,
    scope_json     TEXT NOT NULL,
    options_json   TEXT NOT NULL,
    filters_json   TEXT NOT NULL,
    currency       TEXT NOT NULL,
    status         TEXT NOT NULL,
    error          TEXT,
    preview_json   TEXT,
    xlsx_name      TEXT,
    xlsx_blob      BLOB,
    pdf_name       TEXT,
    pdf_blob       BLOB,
    owner          TEXT,          -- always NULL: this project has no auth
    created_at     TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_reports_created ON reports(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_reports_module  ON reports(module);
"""

#: Stated on every listing, for the same reason `db.NO_OWNER_NOTE` exists.
NO_OWNER_NOTE = db.NO_OWNER_NOTE


class ReportNotFound(LookupError):
    """No report with that id."""


class ArtifactNotFound(LookupError):
    """The report exists; the requested format does not.

    Distinct from `ReportNotFound` so the caller can say "this report has no
    PDF" rather than "no such report" -- and so the UI can disable one button
    without hiding the row.
    """


def _conn() -> sqlite3.Connection:
    connection = db.connect()
    connection.executescript(_SCHEMA)
    return connection


def _now() -> str:
    return datetime.now(timezone.utc).astimezone().isoformat(timespec="seconds")


@dataclass(frozen=True)
class ReportRow:
    """One report's metadata. NEVER carries the artifact bytes.

    Listing a library must not load every workbook into memory, so the blobs are
    fetched only by `artifact()`, and only for the one report being downloaded.
    """

    id: str
    name: str
    module: str
    module_label: str
    title: str
    scope_label: str
    scope: dict[str, Any]
    options: dict[str, Any]
    filters: list[list[str]]
    currency: str
    status: str
    error: str | None
    preview: dict[str, Any]
    formats: dict[str, str | None] = field(default_factory=dict)
    created_at: str = ""

    def as_dict(self) -> dict[str, Any]:
        return {
            "report_id": self.id,
            "name": self.name,
            "module": self.module,
            "module_label": self.module_label,
            "title": self.title,
            "scope_label": self.scope_label,
            "scope": self.scope,
            "filters": self.filters,
            "currency": self.currency,
            "status": self.status,
            "error": self.error,
            "preview": self.preview,
            # Which formats actually EXIST. A button is offered for a format only
            # when its bytes are in the row -- never for a file that was never
            # written.
            "formats": {
                "xlsx": self.formats.get("xlsx"),
                "pdf": self.formats.get("pdf"),
            },
            "available_formats": sorted(k for k, v in self.formats.items() if v),
            "created_at": self.created_at,
            "owner": None,
            "owner_note": NO_OWNER_NOTE,
        }


def _row(record: sqlite3.Row) -> ReportRow:
    return ReportRow(
        id=record["id"],
        name=record["name"],
        module=record["module"],
        module_label=record["module_label"],
        title=record["title"],
        scope_label=record["scope_label"],
        scope=json.loads(record["scope_json"]),
        options=json.loads(record["options_json"]),
        filters=json.loads(record["filters_json"]),
        currency=record["currency"],
        status=record["status"],
        error=record["error"],
        preview=json.loads(record["preview_json"]) if record["preview_json"] else {},
        formats={"xlsx": record["xlsx_name"], "pdf": record["pdf_name"]},
        created_at=record["created_at"],
    )


def begin(*, module: str, module_label: str, name: str, title: str, scope_label: str,
          scope: dict[str, Any], options: dict[str, Any], currency: str) -> str:
    """Open a report in GENERATING and return its id.

    THE ROW EXISTS BEFORE THE ARTIFACTS DO, on purpose: if generation dies
    halfway the library shows a FAILED report with its reason rather than
    silently nothing, which is the difference between a user knowing their
    report broke and wondering where it went.

    `options` is stored so a report can say what it was generated FROM. It is
    the module's own control values -- a discount, a ceiling, a target -- and
    never a credential; see `app/routers/reports.py` for what a caller may send.
    """
    report_id = uuid.uuid4().hex
    _conn().execute(
        """
        INSERT INTO reports (id, name, module, module_label, title, scope_label,
                             scope_json, options_json, filters_json, currency,
                             status, error, preview_json, owner, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, NULL, ?)
        """,
        (report_id, name, module, module_label, title, scope_label,
         json.dumps(scope), json.dumps(options), json.dumps([]), currency,
         GENERATING, _now()),
    )
    return report_id


def finish(report_id: str, *, artifacts: dict[str, tuple[str, bytes]],
           filters: list[list[str]], preview: dict[str, Any]) -> None:
    """Attach the generated artifacts and flip the report to READY.

    READY IS NOT WRITTEN WITHOUT BYTES. An empty artifact map leaves the report
    FAILED, because a library row that offers a download for a file that does
    not exist is worse than no row at all.
    """
    real = {fmt: pair for fmt, pair in artifacts.items() if pair and pair[1]}
    if not real:
        fail(report_id, "Generation produced no artifact.")
        return

    xlsx = real.get("xlsx")
    pdf = real.get("pdf")
    _conn().execute(
        """
        UPDATE reports
           SET status = ?, error = NULL, filters_json = ?, preview_json = ?,
               xlsx_name = ?, xlsx_blob = ?, pdf_name = ?, pdf_blob = ?
         WHERE id = ?
        """,
        (READY, json.dumps(filters), json.dumps(preview),
         xlsx[0] if xlsx else None, sqlite3.Binary(xlsx[1]) if xlsx else None,
         pdf[0] if pdf else None, sqlite3.Binary(pdf[1]) if pdf else None,
         report_id),
    )


def fail(report_id: str, reason: str) -> None:
    """Mark a report FAILED with a reason a person can act on."""
    _conn().execute(
        "UPDATE reports SET status = ?, error = ? WHERE id = ?",
        (FAILED, reason, report_id),
    )


def get(report_id: str) -> ReportRow:
    record = _conn().execute(
        """
        SELECT id, name, module, module_label, title, scope_label, scope_json,
               options_json, filters_json, currency, status, error, preview_json,
               xlsx_name, pdf_name, created_at
          FROM reports WHERE id = ?
        """,
        (report_id,),
    ).fetchone()
    if record is None:
        raise ReportNotFound(f"No report {report_id!r}.")
    return _row(record)


def artifact(report_id: str, fmt: str) -> tuple[str, bytes]:
    """One report's bytes for one format. Raises rather than returning empty."""
    if fmt not in ("xlsx", "pdf"):
        raise ArtifactNotFound(f"{fmt!r} is not a report format.")
    record = _conn().execute(
        f"SELECT status, {fmt}_name AS name, {fmt}_blob AS blob FROM reports WHERE id = ?",
        (report_id,),
    ).fetchone()
    if record is None:
        raise ReportNotFound(f"No report {report_id!r}.")
    if record["status"] != READY or not record["blob"]:
        raise ArtifactNotFound(
            f"This report has no {fmt.upper()} artifact. Its status is "
            f"{record['status']}."
        )
    return record["name"], bytes(record["blob"])


#: Module keys of the MMM intelligence module all start with this; everything
#: else is TPO's. Each module's Report Center lists, counts and clears only its
#: own family, so an MMM user never deletes a TPO report from the MMM page.
MMM_PREFIX = "mmm-"


def _family_clause(family: str | None) -> tuple[str, tuple[Any, ...]] | None:
    if family == "mmm":
        return "module LIKE ?", (f"{MMM_PREFIX}%",)
    if family == "tpo":
        return "module NOT LIKE ?", (f"{MMM_PREFIX}%",)
    return None


def listing(*, module: str | None = None, fmt: str | None = None,
            search: str | None = None, limit: int = 200,
            family: str | None = None) -> list[ReportRow]:
    """The library, newest first.

    Filtering happens in SQL rather than in the browser so a long library stays
    one request. `search` matches the name, the module label and the scope line —
    the three things a person actually remembers about a report.
    """
    clauses: list[str] = []
    params: list[Any] = []
    scoped = _family_clause(family)
    if scoped:
        clauses.append(scoped[0])
        params += scoped[1]
    if module:
        clauses.append("module = ?")
        params.append(module)
    if fmt in ("xlsx", "pdf"):
        clauses.append(f"{fmt}_blob IS NOT NULL")
    if search:
        clauses.append("(LOWER(name) LIKE ? OR LOWER(module_label) LIKE ? "
                       "OR LOWER(scope_label) LIKE ?)")
        needle = f"%{search.lower()}%"
        params += [needle, needle, needle]

    where = f"WHERE {' AND '.join(clauses)}" if clauses else ""
    rows = _conn().execute(
        f"""
        SELECT id, name, module, module_label, title, scope_label, scope_json,
               options_json, filters_json, currency, status, error, preview_json,
               xlsx_name, pdf_name, created_at
          FROM reports {where}
         ORDER BY created_at DESC, rowid DESC
         LIMIT ?
        """,
        (*params, max(1, min(limit, 500))),
    ).fetchall()
    return [_row(r) for r in rows]


def delete(report_id: str) -> None:
    """Remove a report and its artifacts together.

    One statement, so metadata and bytes cannot survive each other. See the
    module docstring for why this table permits a delete where the decision
    history beside it does not.
    """
    cursor = _conn().execute("DELETE FROM reports WHERE id = ?", (report_id,))
    if cursor.rowcount == 0:
        raise ReportNotFound(f"No report {report_id!r}.")


def clear(family: str | None = None) -> int:
    """Empty the Report Center. Returns how many reports were removed.

    ONE STATEMENT, so metadata and artifacts go together and nothing is left
    half-deleted — the same guarantee `delete` gives for a single report. The
    blobs live in the row, so there is no directory to sweep afterwards and no
    orphan is possible.

    NOT FILTERED. This empties the whole library rather than whatever the page
    happens to be showing: a "clear" that silently spared the rows behind an
    active filter would leave a library the user believes is empty. The caller
    is told the count first and confirms against it.

    Reports are DERIVED artifacts, regenerable from their stored scope, so this
    destroys no history. It is why the reports table permits deletion where the
    scenario and decision tables beside it do not.

    `family` narrows the clear to one intelligence module's reports (see
    MMM_PREFIX): the MMM page's Clear all must not empty TPO's library. Within
    a family it is still unfiltered.
    """
    scoped = _family_clause(family)
    if scoped:
        cursor = _conn().execute(f"DELETE FROM reports WHERE {scoped[0]}", scoped[1])
    else:
        cursor = _conn().execute("DELETE FROM reports")
    return int(cursor.rowcount or 0)


def count(family: str | None = None) -> int:
    scoped = _family_clause(family)
    if scoped:
        return int(_conn().execute(f"SELECT COUNT(*) AS n FROM reports WHERE {scoped[0]}",
                                   scoped[1]).fetchone()["n"])
    return int(_conn().execute("SELECT COUNT(*) AS n FROM reports").fetchone()["n"])
