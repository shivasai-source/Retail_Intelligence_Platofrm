"""Remember where the star schema came from, so it can be pulled again.

A dataset installed from Azure Blob or Databricks is a snapshot of a source
that keeps changing: new weeks are appended to the fact table, a promotion is
added to the promotion file. Before this module, the only way to see those
changes was Reset followed by a full re-install through the connector dialog.

At install time the connection and the selection — which blobs, which tables —
are saved here. `sync()` re-reads exactly that selection and swaps it in via
`star_dataset.replace`, which keeps the current files until the new ones load.
A file upload clears the record: files on someone's laptop cannot be re-read.

THE RECORD HOLDS A SECRET. The Azure SAS token or Databricks access token is
written to `backend/app/data/source-connection.json` in plain text (git-ignored,
like the auth files beside it). That was a deliberate choice, so that a sync
works from any tab and after signing in again. The mitigation is on the
source side: connect with a read-only token that expires. `public_status()` is
the only view the API exposes, and it never includes the token.
"""

from __future__ import annotations

import asyncio
import json
import os
import threading
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from app import azure_blob, databricks_catalog, star_dataset
from app.azure_blob import AzureError, BlobRef
from app.databricks_catalog import DatabricksError, TableRef

DATA_DIR = Path(__file__).resolve().parent / "data"
#: Overridable so tests never touch the real record.
CONN_PATH = Path(os.environ.get("TPO_SOURCE_CONN_PATH", DATA_DIR / "source-connection.json"))

LABELS = {"azure": "Azure Blob Storage", "databricks": "Databricks"}

_file_lock = threading.Lock()
#: One sync at a time. A second click while one is running is refused rather
#: than queued: it would download the same files again for nothing.
_sync_lock = asyncio.Lock()


class SourceSyncError(Exception):
    """A sync that could not run or did not complete. The message is shown to the user."""


def _now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def _read() -> dict[str, Any] | None:
    with _file_lock:
        if not CONN_PATH.is_file():
            return None
        try:
            return json.loads(CONN_PATH.read_text(encoding="utf-8"))
        except (OSError, ValueError):
            return None


def _write(record: dict[str, Any]) -> None:
    with _file_lock:
        CONN_PATH.parent.mkdir(parents=True, exist_ok=True)
        temp = CONN_PATH.with_name(CONN_PATH.name + ".tmp")
        temp.write_text(json.dumps(record, indent=2), encoding="utf-8")
        os.replace(temp, CONN_PATH)
        try:
            os.chmod(CONN_PATH, 0o600)  # owner-only where the OS honours it
        except OSError:
            pass


def _save(kind: str, connection: dict[str, Any], selection: list[dict[str, str]], rows: int | None) -> None:
    now = _now()
    _write(
        {
            "kind": kind,
            "connection": connection,
            "selection": selection,
            "saved_at": now,
            # The install itself is the first sync.
            "last_sync": {"at": now, "ok": True, "rows": rows, "previous_rows": None, "error": None},
        }
    )


def save_azure(account: str, sas: str, blobs: list[BlobRef], rows: int | None = None) -> None:
    _save(
        "azure",
        {"account": account, "sas": sas},
        [{"container": b.container, "name": b.name} for b in blobs],
        rows,
    )


def save_databricks(workspace_url: str, token: str, tables: list[TableRef], rows: int | None = None) -> None:
    _save(
        "databricks",
        {"workspace_url": workspace_url, "token": token},
        [{"catalog": t.catalog, "schema_name": t.schema, "name": t.name} for t in tables],
        rows,
    )


def clear() -> None:
    """Forget the source — after a file upload or a reset, there is nothing to re-read."""
    with _file_lock:
        CONN_PATH.unlink(missing_ok=True)


def _item_label(kind: str, sel: dict[str, str]) -> str:
    if kind == "azure":
        return f"{sel['container']}/{sel['name']}"
    return f"{sel['catalog']}.{sel['schema_name']}.{sel['name']}"


def public_status() -> dict[str, Any]:
    """What the UI may know about the source. Never includes the token."""
    record = _read()
    if not record:
        return {"kind": None, "syncable": False, "label": None, "origin": None, "items": [],
                "saved_at": None, "last_sync": None, "syncing": _sync_lock.locked()}
    kind = record.get("kind")
    conn = record.get("connection", {})
    origin = conn.get("account") if kind == "azure" else conn.get("workspace_url")
    return {
        "kind": kind,
        "syncable": kind in LABELS,
        "label": LABELS.get(kind, kind),
        "origin": origin,
        "items": [_item_label(kind, s) for s in record.get("selection", [])],
        "saved_at": record.get("saved_at"),
        "last_sync": record.get("last_sync"),
        "syncing": _sync_lock.locked(),
    }


def _record_sync(outcome: dict[str, Any]) -> None:
    record = _read()
    if not record:
        return  # cleared while the sync ran (a reset); nothing to annotate
    record["last_sync"] = outcome
    _write(record)


async def _fetch(record: dict[str, Any]) -> list[tuple[str, bytes]]:
    kind, conn, sel = record["kind"], record["connection"], record["selection"]
    if kind == "azure":
        refs = [BlobRef(container=s["container"], name=s["name"]) for s in sel]
        return await azure_blob.fetch_all(conn["account"], conn["sas"], refs)
    if kind == "databricks":
        refs = [TableRef(catalog=s["catalog"], schema=s["schema_name"], name=s["name"]) for s in sel]
        warehouse = await databricks_catalog.pick_warehouse(conn["workspace_url"], conn["token"])
        return await databricks_catalog.export_all(conn["workspace_url"], conn["token"], warehouse, refs)
    raise SourceSyncError("This dataset's source can't be synced.")


async def sync() -> dict[str, Any]:
    """Re-read the saved selection from its source and swap it in.

    Raises SourceSyncError with a message fit for the user. On any failure the
    previously loaded data stays in place (see `star_dataset.replace`).
    """
    record = _read()
    if not record or record.get("kind") not in LABELS:
        raise SourceSyncError(
            "There is no connected source to sync from. Data loaded from a file upload has to be "
            "uploaded again from Data Connections."
        )
    if _sync_lock.locked():
        raise SourceSyncError("A sync is already running.")

    async with _sync_lock:
        started = _now()
        try:
            downloaded = await _fetch(record)
            items: list[star_dataset.Classified] = []
            unrecognised: list[str] = []
            for name, content in downloaded:
                classified = star_dataset.classify(name, content)
                if classified is None:
                    unrecognised.append(name)
                else:
                    items.append(classified)
            # The swap and store rebuild are blocking file and CPU work; keep
            # them off the event loop so the rest of the API stays responsive.
            result = await asyncio.to_thread(star_dataset.replace, items, unrecognised)
        except (AzureError, DatabricksError, star_dataset.StarDatasetError, SourceSyncError) as e:
            _record_sync({"at": started, "ok": False, "rows": None, "previous_rows": None, "error": str(e)})
            raise SourceSyncError(str(e)) from e

        outcome = {
            "at": _now(),
            "ok": True,
            "rows": result["rows"],
            "previous_rows": result["previous_rows"],
            "error": None,
        }
        _record_sync(outcome)
        return {**result, "source": LABELS[record["kind"]], "last_sync": outcome}
