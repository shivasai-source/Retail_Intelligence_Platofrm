"""Remember where MMM's daily table came from, so it can be pulled again.

A dataset installed from Azure Blob or Databricks is a snapshot of a source
that keeps growing: yesterday's spend and revenue are appended every morning.
Without this, the only way to see them was to open the connector dialog and
walk the whole selection again.

At install time the connection, EVERY blob or table of the delivery, AND THE
CONFIRMED COLUMN MAPPINGS are saved here (app/mmm/sources.py). `sync()`
re-reads exactly that selection, applies the same mappings, merges the periods
on the day as the install did, and installs the result. A file upload or a
reset clears the record: a file on someone's laptop cannot be re-read, and
nothing is loaded after a reset.

THE SAME SHAPE AS TPO'S `app/source_sync.py`. Where TPO's selection is six
DIFFERENT tables, MMM's is one table's PERIODS, so the record holds a list of
items either way and the difference is only what they mean. MMM's installer is
atomic (staged, then moved into place) and validates before it writes, so a
failed sync leaves the loaded data exactly as it was without needing TPO's
two-phase replace.

A RECORD WRITTEN BEFORE 2026-10-22 holds a single `item`; it is read as a
one-item selection rather than migrated, so a connection made yesterday still
syncs today.

THE RECORD HOLDS A SECRET. The Azure SAS token or Databricks access token is
written to `backend/app/data/mmm-source-connection.json` in plain text
(git-ignored, like the auth files beside it), the same deliberate choice TPO's
module made and for the same reason: a sync has to work from any tab and after
signing in again. The mitigation is on the source side — connect with a
read-only token that expires. `public_status()` is the only view the API
exposes, and it never includes the token.
"""

from __future__ import annotations

import asyncio
import json
import os
import threading
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from app import azure_blob, databricks_catalog
from app.azure_blob import AzureError, BlobRef
from app.databricks_catalog import DatabricksError, TableRef
from app.mmm import dataset

DATA_DIR = Path(__file__).resolve().parents[1] / "data"
#: Overridable so tests never touch the real record.
CONN_PATH = Path(
    os.environ.get("MMM_SOURCE_CONN_PATH", DATA_DIR / "mmm-source-connection.json")
)

LABELS = {"azure": "Azure Blob Storage", "databricks": "Databricks"}

_file_lock = threading.Lock()
#: One sync at a time. A second click while one is running is refused rather
#: than queued: it would download the same file again for nothing.
_sync_lock = asyncio.Lock()


class MmmSourceSyncError(Exception):
    """A sync that could not run or did not complete. The message is shown to the user."""


def _now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def _read() -> dict[str, Any] | None:
    # Read on every call, not cached, so the path can be pointed elsewhere by
    # a test and so a sync started in another worker is seen here.
    path = Path(os.environ.get("MMM_SOURCE_CONN_PATH", CONN_PATH))
    with _file_lock:
        if not path.is_file():
            return None
        try:
            return json.loads(path.read_text(encoding="utf-8"))
        except (OSError, ValueError):
            return None


def _write(record: dict[str, Any]) -> None:
    path = Path(os.environ.get("MMM_SOURCE_CONN_PATH", CONN_PATH))
    with _file_lock:
        path.parent.mkdir(parents=True, exist_ok=True)
        temp = path.with_name(path.name + ".tmp")
        temp.write_text(json.dumps(record, indent=2), encoding="utf-8")
        os.replace(temp, path)
        try:
            os.chmod(path, 0o600)  # owner-only where the OS honours it
        except OSError:
            pass


def _save(kind: str, connection: dict[str, Any], items: list[dict[str, str]],
          mappings: dict[str, dict[str, str]] | None, rows: int | None) -> None:
    now = _now()
    _write({
        "kind": kind,
        "connection": connection,
        "items": items,
        "mappings": {name: dict(m) for name, m in (mappings or {}).items()},
        "saved_at": now,
        # The install itself is the first sync.
        "last_sync": {"at": now, "ok": True, "rows": rows, "previous_rows": None, "error": None},
    })


def save_azure(account: str, sas: str, blobs: list[BlobRef],
               mappings: dict[str, dict[str, str]] | None = None,
               rows: int | None = None) -> None:
    _save("azure", {"account": account, "sas": sas},
          [{"container": b.container, "name": b.name} for b in blobs], mappings, rows)


def save_databricks(workspace_url: str, token: str, refs: list[TableRef],
                    mappings: dict[str, dict[str, str]] | None = None,
                    rows: int | None = None) -> None:
    _save("databricks", {"workspace_url": workspace_url, "token": token},
          [{"catalog": r.catalog, "schema_name": r.schema, "name": r.name} for r in refs],
          mappings, rows)


def _items(record: dict[str, Any]) -> list[dict[str, str]]:
    """The selection, from a record of either vintage."""
    items = record.get("items")
    if isinstance(items, list) and items:
        return items
    single = record.get("item")
    return [single] if isinstance(single, dict) and single else []


def _mappings(record: dict[str, Any]) -> dict[str, dict[str, str]]:
    """The saved mappings, from a record of either vintage.

    The older record held ONE flat mapping for its one file; it is keyed back
    onto that file's name so the merge path applies it exactly where it
    belongs rather than to whatever file happens to come first.
    """
    nested = record.get("mappings")
    if isinstance(nested, dict) and nested:
        return {k: v for k, v in nested.items() if isinstance(v, dict)}
    flat = record.get("mapping")
    if isinstance(flat, dict) and flat and all(isinstance(v, str) for v in flat.values()):
        items = _items(record)
        if items:
            return {_upload_name(record.get("kind", ""), items[0]): flat}
    return {}


def _upload_name(kind: str, item: dict[str, str]) -> str:
    """What the installer will see this item's file called."""
    if kind == "azure":
        return item["name"].rsplit("/", 1)[-1]
    return f"{item['name']}.csv"


def clear() -> None:
    """Forget the source — after an upload or a reset there is nothing to re-read."""
    path = Path(os.environ.get("MMM_SOURCE_CONN_PATH", CONN_PATH))
    with _file_lock:
        path.unlink(missing_ok=True)


def _item_label(kind: str, item: dict[str, str]) -> str:
    if kind == "azure":
        return f"{item['container']}/{item['name']}"
    return f"{item['catalog']}.{item['schema_name']}.{item['name']}"


def _label(kind: str, items: list[dict[str, str]]) -> str:
    """How the installed dataset names where it came from."""
    if kind == "azure":
        if len(items) == 1:
            return f"Azure Blob · {items[0]['container']}/{items[0]['name']}"
        return f"Azure Blob · {len(items)} files from {items[0]['container']}"
    if len(items) == 1:
        return f"Databricks · {_item_label(kind, items[0])}"
    return f"Databricks · {len(items)} tables from {items[0]['catalog']}.{items[0]['schema_name']}"


def public_status() -> dict[str, Any]:
    """What the UI may know about the source. Never includes the token."""
    record = _read()
    if not record:
        return {"kind": None, "syncable": False, "label": None, "origin": None, "items": [],
                "mapped_columns": 0, "saved_at": None, "last_sync": None,
                "syncing": _sync_lock.locked()}
    kind = record.get("kind")
    conn = record.get("connection", {})
    items = _items(record)
    return {
        "kind": kind,
        "syncable": kind in LABELS,
        "label": LABELS.get(kind, kind),
        "origin": conn.get("account") if kind == "azure" else conn.get("workspace_url"),
        "items": [_item_label(kind, i) for i in items],
        # How many columns the saved mappings rename in total, so the pill can
        # say that a sync will read the source the same way the install did.
        "mapped_columns": sum(len(m) for m in _mappings(record).values()),
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


def _snapshot() -> dict[str, Any]:
    """The before/after figures the summary panel compares. Data only — days,
    period and channels — never a KPI, which belongs to the pages."""
    status = dataset.status()
    return {
        "rows": status["rows"],
        "media_channels": status["media_channels"],
        "first_day": status["period"]["from"],
        "last_day": status["period"]["to"],
        "source_name": status["source_name"],
    }


async def _fetch(record: dict[str, Any]) -> list[tuple[str, bytes]]:
    """Every item of the saved selection, as the installer takes them."""
    kind, conn = record["kind"], record["connection"]
    items = _items(record)
    if not items:
        raise MmmSourceSyncError("The saved connection names no file to re-read.")
    if kind == "azure":
        blobs = [BlobRef(container=i["container"], name=i["name"]) for i in items]
        downloaded = await azure_blob.fetch_all(conn["account"], conn["sas"], blobs)
        if not downloaded:
            raise MmmSourceSyncError("Nothing could be read from Azure.")
        return list(downloaded)
    if kind == "databricks":
        refs = [TableRef(catalog=i["catalog"], schema=i["schema_name"], name=i["name"])
                for i in items]
        warehouse = await databricks_catalog.pick_warehouse(conn["workspace_url"], conn["token"])
        out: list[tuple[str, bytes]] = []
        for ref in refs:
            content = await databricks_catalog.export_table(
                conn["workspace_url"], conn["token"], warehouse, ref
            )
            if not content:
                raise MmmSourceSyncError(f"{ref.full_name} exported no rows.")
            out.append((ref.csv_name, content))
        return out
    raise MmmSourceSyncError("This dataset's source can't be synced.")


async def sync() -> dict[str, Any]:
    """Re-read the saved blob or table and install it again.

    Raises `MmmSourceSyncError` with a message fit for the user. On any
    failure — a dead token, a source that no longer matches the contract — the
    previously loaded data stays in place, because `dataset.install` validates
    the whole file before it writes anything.
    """
    record = _read()
    if not record or record.get("kind") not in LABELS:
        raise MmmSourceSyncError(
            "There is no connected source to sync from. A dataset loaded from a file upload "
            "has to be uploaded again from Data Connections."
        )
    if _sync_lock.locked():
        raise MmmSourceSyncError("A sync is already running.")

    async with _sync_lock:
        started = _now()
        before = _snapshot()
        kind = record["kind"]
        items = _items(record)
        try:
            uploads = await _fetch(record)
            # Validating every row, merging the periods and rewriting the table
            # is blocking file and CPU work; off the event loop so the rest of
            # the API — the status poll included — stays responsive.
            result = await asyncio.to_thread(
                dataset.install_files,
                uploads,
                source_kind="azure-blob" if kind == "azure" else "databricks",
                source_label=_label(kind, items),
                mappings=_mappings(record) or None,
            )
        except (AzureError, DatabricksError, dataset.MmmDatasetError, MmmSourceSyncError) as exc:
            _record_sync({"at": started, "ok": False, "rows": None,
                          "previous_rows": before["rows"], "error": str(exc)})
            raise MmmSourceSyncError(str(exc)) from exc

        after = _snapshot()
        outcome = {"at": _now(), "ok": True, "rows": after["rows"],
                   "previous_rows": before["rows"], "error": None}
        _record_sync(outcome)
        return {
            "source": LABELS[kind],
            "kind": kind,
            "item": ", ".join(_item_label(kind, i) for i in items),
            "items": [_item_label(kind, i) for i in items],
            "before": before,
            "after": after,
            "warnings": result.get("warnings", []),
            "last_sync": outcome,
            "synced_at": outcome["at"],
            "status": result["status"],
        }
