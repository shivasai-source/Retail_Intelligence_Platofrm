"""Install MMM's daily table from Azure Blob Storage or a Databricks table.

WHY THIS MODULE EXISTS. MMM's installer (app/mmm/dataset.py) takes one file's
bytes and writes MMM's data folder. Getting those bytes out of a storage
account or a warehouse is already solved — app/azure_blob.py and
app/databricks_catalog.py do it for TPO — but TPO's ROUTES wrap those helpers
in the six-table star-schema installer, which MMM must never reach. So the
transport is reused and the installer is MMM's own: nothing is re-implemented
and no TPO file is touched.

WHAT IS DIFFERENT FROM TPO. TPO installs six DIFFERENT tables as a set and
makes the user reset before loading another. MMM has one table, so a selection
of several blobs or tables is several PERIODS of it — "Jan-Mar", "Apr-Jun" —
merged on the day by app/mmm/day_union.py exactly as a multi-file upload is,
and installing simply replaces whatever was loaded.

THE PREFLIGHT IS CHEAP ON BOTH. An Azure blob is identified from a 256 KB
ranged GET (a workbook is fetched whole — a zip's directory sits at its end);
a Databricks table from Unity Catalog's column list, with no query at all. The
full read happens once, at install time.
"""

from __future__ import annotations

from typing import Any

import httpx

from app import azure_blob, databricks_catalog
from app.azure_blob import BlobRef
from app.databricks_catalog import TableRef
from app.mmm import dataset, source_sync

#: What the dataset records as its source, for the strip and the lit tile.
AZURE_KIND = "azure-blob"
DATABRICKS_KIND = "databricks"


def _basename(blob_name: str) -> str:
    return blob_name.rsplit("/", 1)[-1]


# --- Azure Blob Storage ------------------------------------------------------


async def azure_inspect(account: str, sas: str, blobs: list[BlobRef],
                        mappings: dict[str, dict[str, str]] | None = None,
                        *, coverage: bool = False) -> dict[str, Any]:
    """What MMM would read from the selected blobs. Installs nothing.

    Without `coverage` only each blob's header is fetched, so checking the
    columns of a selection costs 256 KB per file however large they are. With
    it the blobs are read in full, because which days a file covers is a
    question its first 256 KB cannot answer — see `dataset.inspect_files`.
    """
    uploads: list[tuple[str, bytes]] = []
    if coverage:
        # `azure_fetch` opens its own pooled client per blob, so no second one
        # is opened here just to go unused.
        for blob in blobs:
            _name, content = await azure_fetch(account, sas, blob)
            uploads.append((_basename(blob.name), content))
    else:
        async with httpx.AsyncClient(timeout=azure_blob.LIST_TIMEOUT,
                                     follow_redirects=True) as client:
            for blob in blobs:
                content = await azure_blob.fetch_header(client, account, sas, blob)
                uploads.append((_basename(blob.name), content))
    return dataset.inspect_files(uploads, mappings, coverage=coverage)


async def azure_fetch(
    account: str, sas: str, blob: BlobRef, progress: Any | None = None
) -> tuple[str, bytes]:
    """The whole blob, as (filename, bytes) for the installer."""
    downloaded = await azure_blob.fetch_all(account, sas, [blob], progress=progress)
    if not downloaded:
        raise azure_blob.AzureError(f"'{blob.name}' could not be read from Azure.")
    return downloaded[0]


def azure_label(blobs: list[BlobRef]) -> str:
    if len(blobs) == 1:
        return f"Azure Blob · {blobs[0].container}/{blobs[0].name}"
    return f"Azure Blob · {len(blobs)} files from {blobs[0].container}"


def azure_install(uploads: list[tuple[str, bytes]], blobs: list[BlobRef], account: str = "",
                  sas: str = "", mappings: dict[str, dict[str, str]] | None = None) -> dict[str, Any]:
    """Blocking half of an Azure install — call through run_in_threadpool.

    On success the connection, EVERY blob of the delivery and the confirmed
    mappings are remembered so the Live pill can pull the same selection again
    later (app/mmm/source_sync.py). Saved AFTER the install, so a delivery that
    fails validation never leaves a connection claiming to be the source of
    data that was refused.
    """
    result = dataset.install_files(
        uploads,
        source_kind=AZURE_KIND,
        source_label=azure_label(blobs),
        mappings=mappings,
    )
    if account:
        source_sync.save_azure(account, sas, blobs, mappings, result.get("rows"))
    return result


# --- Databricks --------------------------------------------------------------


async def databricks_inspect(workspace_url: str, token: str, refs: list[TableRef],
                             mappings: dict[str, dict[str, str]] | None = None,
                             *, coverage: bool = False) -> dict[str, Any]:
    """What MMM would read from the selected tables.

    Without `coverage` this is pure metadata — Unity Catalog already knows the
    columns, so no warehouse runs and no data is read. With it the tables are
    exported, because which days a table covers cannot be answered from its
    column list.
    """
    if coverage:
        uploads = [await databricks_fetch(workspace_url, token, ref) for ref in refs]
        return dataset.inspect_files(uploads, mappings, coverage=True)

    pairs = await databricks_catalog.columns_for(workspace_url, token, refs)
    chosen = mappings or {}
    files = [
        dataset.inspect_columns(ref.csv_name, columns, chosen.get(ref.csv_name))
        for ref, columns in pairs
    ]
    return dataset.verdict_for(files)


async def databricks_fetch(workspace_url: str, token: str, ref: TableRef) -> tuple[str, bytes]:
    """Export one table to CSV, as (filename, bytes) for the installer.

    A SQL warehouse is picked automatically, preferring one already RUNNING to
    avoid a cold start — the same choice TPO's install makes, for the same
    reason: which warehouse serves the export changes nothing about the result.
    """
    warehouse_id = await databricks_catalog.pick_warehouse(workspace_url, token)
    content = await databricks_catalog.export_table(workspace_url, token, warehouse_id, ref)
    if not content:
        raise databricks_catalog.DatabricksError(f"{ref.full_name} exported no rows.")
    return ref.csv_name, content


def databricks_label(refs: list[TableRef]) -> str:
    if len(refs) == 1:
        return f"Databricks · {refs[0].full_name}"
    return f"Databricks · {len(refs)} tables from {refs[0].catalog}.{refs[0].schema}"


def databricks_install(uploads: list[tuple[str, bytes]], refs: list[TableRef],
                       workspace_url: str = "", token: str = "",
                       mappings: dict[str, dict[str, str]] | None = None) -> dict[str, Any]:
    """Blocking half of a Databricks install — call through run_in_threadpool.

    Remembers the warehouse connection, every table of the delivery and the
    mappings for the Live pill, on success only — see `azure_install`.
    """
    result = dataset.install_files(
        uploads,
        source_kind=DATABRICKS_KIND,
        source_label=databricks_label(refs),
        mappings=mappings,
    )
    if workspace_url:
        source_sync.save_databricks(workspace_url, token, refs, mappings, result.get("rows"))
    return result
