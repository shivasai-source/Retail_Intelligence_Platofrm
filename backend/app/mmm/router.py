"""Every MMM route, under /api/mmm.

    GET    /api/mmm/dataset               status (strip, gate, sidebar lock)
    POST   /api/mmm/dataset               upload a delivery (1..n period files)
    POST   /api/mmm/dataset/inspect       preflight: columns, mapping, coverage
    GET    /api/mmm/dataset/preview       installed rows, paged
    DELETE /api/mmm/dataset               remove the installed dataset
    POST   /api/mmm/dataset/azure/inspect      selected blobs' columns, coverage
    POST   /api/mmm/dataset/azure/install      install them as one daily table
    POST   /api/mmm/dataset/databricks/inspect selected tables' columns (no query)
    POST   /api/mmm/dataset/databricks/install export them and install
    GET    /api/mmm/dataset/source        where the loaded data came from
    POST   /api/mmm/dataset/source/sync   pull it again from there
    GET    /api/mmm/filters               every option the Insights Hub filter bar offers
    GET    /api/mmm/hub                   Insights Hub payload for one filter scope
    GET    /api/mmm/calendar              channel x month matrix for a year
    GET    /api/mmm/calendar/month        one month, day by day
    GET    /api/mmm/budget/status         the response model's training state
    GET    /api/mmm/budget/options        weeks (for the period calendar), channels
    GET    /api/mmm/budget/summary        a period's current plan: figures, weeks, curves
    POST   /api/mmm/budget/optimize       the best fixed-budget plan, as moves
    POST   /api/mmm/budget/allocate       Budget Allocator: an entered budget, three plans
    GET    /api/mmm/budget/frontier       net profit at every budget, current and best split
    GET    /api/mmm/forecast              whether a future plan is uploaded
    POST   /api/mmm/forecast              upload a future plan (no Revenue); replaces the last
    DELETE /api/mmm/forecast              remove the uploaded plan
    GET    /api/mmm/forecast/summary      predicted revenue, KPIs, series, channels, years
    GET    /api/mmm/forecast/download     the plan with its predicted revenue, as CSV
    GET    /api/mmm/forecast/sample/{n}   an n-year sample plan (1 - 5)

The budget routes take `source`: `history` (the installed data) or
`forecast` (the uploaded plan's weeks).

Reports go through the shared Report Center (/api/reports, module
`mmm-insights`) — see app/mmm/report.py.

Data routes answer 503 with `mmm_dataset_missing: true` when nothing is
installed, the MMM twin of TPO's `dataset_missing` (app/main.py), so the
frontend can tell "not loaded yet" from "loaded and genuinely zero".
"""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any, Callable

from fastapi import APIRouter, Depends, File, Form, HTTPException, Query, UploadFile
from fastapi.responses import FileResponse, JSONResponse, Response
from pydantic import BaseModel

from fastapi.concurrency import run_in_threadpool

from app.azure_blob import AzureError, BlobRef
from app.databricks_catalog import DatabricksError, TableRef
from app.deps import current_user
from app.mmm import (allocator, budget, budget_model, calendar, dataset, forecast,
                     service, source_sync, sources)
from app.mmm.loader import MmmDatasetMissing
from app.mmm.scope import Scope
from app import azure_blob

router = APIRouter(prefix="/api/mmm", tags=["mmm"])

#: Enough of a CSV to hold its header and the rows the samples come from.
#: Matches HEADER_PREVIEW_BYTES in app/routers/datasets.py.
HEADER_PREVIEW_BYTES = 256 * 1024


def _flat_mapping(parsed: Any, where: str) -> dict[str, str]:
    if not isinstance(parsed, dict) or not all(
        isinstance(k, str) and isinstance(v, str) for k, v in parsed.items()
    ):
        raise HTTPException(400, f"{where} must be an object of column name to column name.")
    return parsed


def _mappings(raw: str, filenames: list[str]) -> dict[str, dict[str, str]]:
    """The reader's confirmed column mappings, keyed by filename.

    TWO SHAPES ARE ACCEPTED, because a delivery and a single file are asked
    about differently and both callers are real:

      {"NetSales": "Revenue"}                     one file's renames
      {"jan.csv": {"NetSales": "Revenue"}, ...}   a delivery, file by file

    The flat form is applied to the only file uploaded; sent with several, it
    is refused rather than guessed at, since applying one file's names to
    another's columns is how a column silently becomes the wrong measure.

    Malformed JSON is refused rather than ignored: installing with no mapping
    would answer "Missing required column: Revenue" for a file the reader had
    just finished mapping, which reads as the mapping screen lying.
    """
    if not raw.strip():
        return {}
    try:
        parsed = json.loads(raw)
    except ValueError as exc:
        raise HTTPException(400, f"mapping is not valid JSON: {exc}") from exc
    if not isinstance(parsed, dict):
        raise HTTPException(400, "mapping must be a JSON object.")
    if not parsed:
        return {}
    nested = all(isinstance(v, dict) for v in parsed.values())
    if nested:
        return {
            name: _flat_mapping(value, f"mapping[{name}]")
            for name, value in parsed.items()
        }
    flat = _flat_mapping(parsed, "mapping")
    if len(filenames) > 1:
        raise HTTPException(
            400,
            "Several files were uploaded, so mapping must be keyed by filename "
            "— one file's column names cannot be applied to another's.",
        )
    return {filenames[0]: flat} if filenames else {}


async def _uploads(files: list[UploadFile], file: UploadFile | None,
                   limit: int | None = None) -> list[tuple[str, bytes]]:
    """The delivery, as (filename, bytes).

    `file` is the single-file field this route has always taken; `files` is the
    delivery. Both are accepted so an existing caller keeps working.
    """
    chosen = [u for u in [*(files or []), file] if u is not None]
    if not chosen:
        raise HTTPException(400, "No file was uploaded.")
    out: list[tuple[str, bytes]] = []
    for upload in chosen:
        name = Path(upload.filename or "upload.csv").name
        # A WORKBOOK CANNOT BE READ FROM A PREFIX — a zip's central directory
        # sits at its end — and neither can coverage, which needs the last day
        # in the file. Both read in full; only a CSV's header check is capped.
        content = (
            await upload.read()
            if limit is None or Path(name).suffix.lower() in (".xlsx", ".xls")
            else await upload.read(limit)
        )
        if not content:
            raise HTTPException(400, f"{name} is empty.")
        out.append((name, content))
    return out


def _guard(fn: Callable[[], dict[str, Any]]) -> Any:
    try:
        return fn()
    except MmmDatasetMissing as exc:
        return JSONResponse(status_code=503, content={
            "detail": str(exc), "mmm_dataset_missing": True,
            "action": "Upload the daily MMM file on MMM Data Connections.",
        })
    except forecast.NoForecast as exc:
        return JSONResponse(status_code=404, content={"detail": str(exc), "forecast_missing": True})
    except budget.ModelNotReady:
        # Still training: 409 with the progress, which the page polls.
        return JSONResponse(status_code=409, content={"model_training": True, **budget_model.status()})
    except ValueError as exc:
        raise HTTPException(422, str(exc)) from exc


@router.get("/dataset")
def dataset_status(user: dict[str, Any] = Depends(current_user)) -> dict[str, Any]:
    return dataset.status()


@router.post("/dataset")
async def upload_dataset(
    files: list[UploadFile] = File([]),
    file: UploadFile | None = File(None),
    mapping: str = Form(""),
    user: dict[str, Any] = Depends(current_user),
) -> dict[str, Any]:
    """Install an uploaded delivery, with the reader's confirmed mappings.

    ONE FILE OR SEVERAL PERIODS OF ONE TABLE. A client's history arrives as
    "Jan-Mar", "Apr-Jun", "Jul-Sep"; they are merged on the day
    (app/mmm/day_union.py) and installed as MMM's single daily table. What the
    merge decided — days counted once, days that disagreed, columns not every
    file had — comes back in `warnings` and `union`.

    `mapping` is the confirmed renames: one object for a single file, or one
    per filename for a delivery. Absent when the files already use MMM's own
    names, which is the common case.
    """
    uploads = await _uploads(files, file)
    try:
        # Parsing a workbook, validating every row and rewriting the table is
        # blocking work; off the event loop, so the rest of the API keeps
        # answering while it runs — the same reason the Azure and Databricks
        # installs below run off it. A 100k-row .xlsx takes openpyxl the better
        # part of a minute, and on the loop that minute froze EVERY request,
        # which read as "the other connectors are slow too".
        result = await run_in_threadpool(
            dataset.install_files,
            uploads,
            mappings=_mappings(mapping, [n for n, _c in uploads]),
        )
    except dataset.MmmDatasetError as exc:
        raise HTTPException(400, str(exc)) from exc
    # A file on someone's laptop cannot be re-read, so an upload ends any
    # standing connection rather than leaving the pill offering to sync one.
    source_sync.clear()
    return result


@router.post("/dataset/inspect")
async def inspect_dataset(
    files: list[UploadFile] = File([]),
    file: UploadFile | None = File(None),
    mapping: str = Form(""),
    coverage: str = Form(""),
    user: dict[str, Any] = Depends(current_user),
) -> dict[str, Any]:
    """What MMM would read from a delivery. Installs nothing.

    HOW MUCH OF EACH FILE IS READ DEPENDS ON WHAT IS BEING ASKED. Columns and
    the mapping proposal need the header and a few rows, so a 256 KB prefix is
    enough — and that is the request the mapping screen repeats as the reader
    edits, so it stays cheap.

    `coverage` asks a question a prefix cannot answer: which period each file
    covers and which days nobody sent. A prefix of a monthly extract ends
    mid-month, and the screen would announce gaps that are not there — worse
    than no preview at all. So that one request, made once per selection
    rather than per keystroke, reads the files in full.
    """
    want_coverage = coverage not in ("", "0", "false")
    uploads = await _uploads(files, file, None if want_coverage else HEADER_PREVIEW_BYTES)
    settled = _mappings(mapping, [n for n, _c in uploads])
    # Off the event loop for the same reason the install is: a workbook is
    # parsed whole however little is being asked of it, and `coverage` reads
    # every row of every file. On the loop a single large .xlsx held the whole
    # API — /api/health included — for a minute and a half.
    return await run_in_threadpool(
        dataset.inspect_files, uploads, settled, coverage=want_coverage
    )


@router.get("/dataset/preview")
def preview_dataset(
    limit: int = Query(50, ge=1, le=500),
    offset: int = Query(0, ge=0),
    user: dict[str, Any] = Depends(current_user),
) -> Any:
    return _guard(lambda: dataset.preview(limit, offset))


@router.delete("/dataset")
def reset_dataset(user: dict[str, Any] = Depends(current_user)) -> dict[str, Any]:
    result = dataset.reset()
    # Nothing is loaded, so there is nothing to keep a connection for.
    source_sync.clear()
    return result


# ============================== installing from a connected source ===========
# The other three ways in to the SAME one-file install the Excel upload does.
# Everything about what is acceptable is dataset.py's and is not restated here;
# these routes only get the bytes out of Azure or Databricks (app/mmm/sources.py).
#
# ONE TABLE, SEVERAL PERIODS. MMM reads a single daily table, so a selection of
# several blobs or tables is several periods of it — "Jan-Mar", "Apr-Jun" —
# merged on the day exactly as a multi-file upload is (app/mmm/day_union.py).
#
# CREDENTIALS ARRIVE PER REQUEST and are not stored. TPO saves them so its Live
# pill can re-pull the same blobs later; MMM has no such pill, so keeping a
# token would claim a standing connection nothing reads through.


class MmmBlobSel(BaseModel):
    container: str = ""
    name: str = ""


class MmmAzureReq(BaseModel):
    account: str = ""
    sas: str = ""
    #: The selection. `container`/`name` below are the single-file form this
    #: route first took and are still accepted.
    blobs: list[MmmBlobSel] = []
    container: str = ""
    name: str = ""
    #: Chosen by the client so it can poll GET /api/datasets/azure/progress/{id}
    #: while the download runs. Optional: '' installs without progress tracking.
    progress_id: str = ""
    #: The reader's confirmed renames — one object for a single file, or one
    #: per filename for a delivery. See `_mappings`.
    mapping: dict[str, Any] = {}
    #: Read every row to work out which days each file covers. Costs a full
    #: download, so the client asks once per selection.
    coverage: bool = False


class MmmTableSel(BaseModel):
    catalog: str = ""
    schema_name: str = ""
    name: str = ""


class MmmDbxReq(BaseModel):
    workspace_url: str = ""
    token: str = ""
    tables: list[MmmTableSel] = []
    catalog: str = ""
    schema_name: str = ""
    name: str = ""
    mapping: dict[str, Any] = {}
    coverage: bool = False


def _blobs(req: MmmAzureReq) -> list[BlobRef]:
    chosen = [b for b in req.blobs if b.container and b.name]
    if not chosen and req.container and req.name:
        chosen = [MmmBlobSel(container=req.container, name=req.name)]
    if not chosen:
        raise HTTPException(400, "Select the file to load.")
    return [BlobRef(container=b.container, name=b.name) for b in chosen]


def _tables(req: MmmDbxReq) -> list[TableRef]:
    chosen = [t for t in req.tables if t.catalog and t.schema_name and t.name]
    if not chosen and req.catalog and req.schema_name and req.name:
        chosen = [MmmTableSel(catalog=req.catalog, schema_name=req.schema_name, name=req.name)]
    if not chosen:
        raise HTTPException(400, "Select the table to load.")
    return [TableRef(catalog=t.catalog, schema=t.schema_name, name=t.name) for t in chosen]


def _body_mappings(raw: dict[str, Any], filenames: list[str]) -> dict[str, dict[str, str]]:
    """The same two shapes `_mappings` accepts, from a JSON body."""
    return _mappings(json.dumps(raw or {}), filenames)


def _blob_names(blobs: list[BlobRef]) -> list[str]:
    return [b.name.rsplit("/", 1)[-1] for b in blobs]


@router.post("/dataset/azure/inspect")
async def azure_inspect_dataset(
    req: MmmAzureReq, user: dict[str, Any] = Depends(current_user)
) -> dict[str, Any]:
    """What MMM would read from the selected blobs, without installing them."""
    blobs = _blobs(req)
    try:
        return await sources.azure_inspect(
            req.account, req.sas, blobs,
            _body_mappings(req.mapping, _blob_names(blobs)),
            coverage=req.coverage,
        )
    except AzureError as exc:
        raise HTTPException(400, str(exc)) from exc


@router.post("/dataset/azure/install")
async def azure_install_dataset(
    req: MmmAzureReq, user: dict[str, Any] = Depends(current_user)
) -> dict[str, Any]:
    """Download the selected blobs and install them as MMM's dataset.

    Several blobs are several PERIODS of the one daily table, merged on the day
    before validation. Replaces any loaded dataset — the same rule the Excel
    upload follows.
    """
    blobs = _blobs(req)
    mappings = _body_mappings(req.mapping, _blob_names(blobs))
    progress = azure_blob.start_progress(req.progress_id)
    try:
        uploads = [
            await sources.azure_fetch(req.account, req.sas, blob, progress) for blob in blobs
        ]
    except AzureError as exc:
        if progress:
            progress.set_stage("failed")
        raise HTTPException(400, str(exc)) from exc

    if progress:
        progress.set_stage("installing")
    try:
        # Validating every row, merging the periods and rewriting the table is
        # blocking work; on the event loop it would stall every other request,
        # the progress poll included — the same reason TPO's installs run off it.
        result = await run_in_threadpool(
            sources.azure_install, uploads, blobs, req.account, req.sas, mappings
        )
    except dataset.MmmDatasetError as exc:
        if progress:
            progress.set_stage("failed")
        raise HTTPException(400, str(exc)) from exc
    if progress:
        progress.set_stage("done")
    return result


@router.post("/dataset/databricks/inspect")
async def dbx_inspect_dataset(
    req: MmmDbxReq, user: dict[str, Any] = Depends(current_user)
) -> dict[str, Any]:
    """What MMM would read from the selected tables, from Unity Catalog's
    column list — no warehouse, no query, no data read, unless `coverage` asks
    which days they cover, which only the rows can answer."""
    refs = _tables(req)
    try:
        return await sources.databricks_inspect(
            req.workspace_url, req.token, refs,
            _body_mappings(req.mapping, [r.csv_name for r in refs]),
            coverage=req.coverage,
        )
    except DatabricksError as exc:
        raise HTTPException(400, str(exc)) from exc


@router.post("/dataset/databricks/install")
async def dbx_install_dataset(
    req: MmmDbxReq, user: dict[str, Any] = Depends(current_user)
) -> dict[str, Any]:
    """Export the selected tables to CSV and install them as MMM's dataset.

    Several tables are several periods of the one daily table, merged on the
    day before validation.
    """
    refs = _tables(req)
    mappings = _body_mappings(req.mapping, [r.csv_name for r in refs])
    try:
        uploads = [
            await sources.databricks_fetch(req.workspace_url, req.token, ref) for ref in refs
        ]
    except DatabricksError as exc:
        raise HTTPException(400, str(exc)) from exc
    try:
        result = await run_in_threadpool(
            sources.databricks_install, uploads, refs, req.workspace_url, req.token, mappings
        )
    except dataset.MmmDatasetError as exc:
        raise HTTPException(400, str(exc)) from exc
    return result


@router.get("/dataset/source")
def source_status(user: dict[str, Any] = Depends(current_user)) -> dict[str, Any]:
    """Where the loaded dataset came from and when it was last synced — never
    the stored token. See app/mmm/source_sync.py."""
    return source_sync.public_status()


@router.post("/dataset/source/sync")
async def source_sync_now(user: dict[str, Any] = Depends(current_user)) -> dict[str, Any]:
    """Re-read the connected blob or table and install it again.

    Pulls the same file the dataset was installed from, with the same column
    mapping, so days added at the source since then come in. On any failure
    the previously loaded data stays in place.
    """
    try:
        return await source_sync.sync()
    except source_sync.MmmSourceSyncError as exc:
        raise HTTPException(400, str(exc)) from exc


@router.get("/filters")
def hub_filters(user: dict[str, Any] = Depends(current_user)) -> Any:
    return _guard(service.filters)


@router.get("/hub")
def hub(
    year: int | None = Query(None, ge=1900, le=2200),
    quarter: int | None = Query(None),
    month: int | None = Query(None),
    week: int | None = Query(None),
    date_from: str | None = Query(None, description="YYYY-MM-DD; replaces year/quarter/month/week"),
    date_to: str | None = Query(None, description="YYYY-MM-DD"),
    channel: list[str] = Query([], description="*_Spend column; repeat for several"),
    promotion_type: list[str] = Query([]),
    event: list[str] = Query([], description="festival, seasonal, promotion or none"),
    granularity: str = Query("month"),
    currency: str = Query("INR"),
    user: dict[str, Any] = Depends(current_user),
) -> Any:
    def run() -> dict[str, Any]:
        scope = Scope.build(year=year, quarter=quarter, month=month, week=week,
                            date_from=date_from, date_to=date_to, channels=channel,
                            promotion_types=promotion_type, events=event)
        return service.hub(scope, granularity, currency)

    return _guard(run)


@router.get("/calendar")
def calendar_matrix(
    year: int | None = Query(None, ge=1900, le=2200),
    currency: str = Query("INR"),
    user: dict[str, Any] = Depends(current_user),
) -> Any:
    def run() -> dict[str, Any]:
        from app.mmm import loader

        chosen = year or max(loader.years(loader.get_frame()))
        return calendar.matrix(chosen, currency)

    return _guard(run)


@router.get("/calendar/month")
def calendar_month(
    year: int = Query(..., ge=1900, le=2200),
    month: int = Query(..., ge=1, le=12),
    currency: str = Query("INR"),
    user: dict[str, Any] = Depends(current_user),
) -> Any:
    return _guard(lambda: calendar.month_detail(year, month, currency))


# --- Budget Optimizer ----------------------------------------------------------
# A period is a run of ISO weeks, each given as year * 100 + week (202614).


class PlanBody(BaseModel):
    start: int
    end: int
    currency: str = "INR"
    #: What may move: anywhere, within_channel or across_channels.
    mode: str = "anywhere"
    #: What is planned: history (the installed data) or forecast (the uploaded plan).
    source: str = "history"


@router.get("/budget/status")
def budget_status(user: dict[str, Any] = Depends(current_user)) -> Any:
    return _guard(budget_model.status)


@router.get("/budget/options")
def budget_options(source: str = Query("history"), user: dict[str, Any] = Depends(current_user)) -> Any:
    return _guard(lambda: budget.options(source))


@router.get("/budget/summary")
def budget_summary(
    start: int = Query(..., ge=190001, le=220053),
    end: int = Query(..., ge=190001, le=220053),
    currency: str = Query("INR"),
    source: str = Query("history"),
    user: dict[str, Any] = Depends(current_user),
) -> Any:
    return _guard(lambda: budget.summary(start, end, currency, source))


@router.post("/budget/optimize")
def budget_optimize(body: PlanBody, user: dict[str, Any] = Depends(current_user)) -> Any:
    return _guard(lambda: budget.optimize(body.start, body.end, body.currency, body.mode, body.source))


# --- Budget Allocator ----------------------------------------------------------


class AllocateBody(PlanBody):
    #: The budget to split, in rupees.
    budget: float


@router.post("/budget/allocate")
def budget_allocate(body: AllocateBody, user: dict[str, Any] = Depends(current_user)) -> Any:
    return _guard(lambda: allocator.allocate(body.start, body.end, body.budget, body.currency, body.mode, body.source))


@router.get("/budget/frontier")
def budget_frontier(
    start: int = Query(..., ge=190001, le=220053),
    end: int = Query(..., ge=190001, le=220053),
    currency: str = Query("INR"),
    mode: str = Query("anywhere"),
    source: str = Query("history"),
    user: dict[str, Any] = Depends(current_user),
) -> Any:
    return _guard(lambda: allocator.frontier(start, end, currency, mode, source))


# --- Revenue Forecast ----------------------------------------------------------


@router.get("/forecast")
def forecast_status(user: dict[str, Any] = Depends(current_user)) -> Any:
    return forecast.status()


@router.post("/forecast")
async def forecast_upload(file: UploadFile = File(...), user: dict[str, Any] = Depends(current_user)) -> Any:
    content = await file.read()
    name = file.filename or "plan.csv"
    if not content:
        raise HTTPException(400, f"{name} is empty.")
    return _guard(lambda: forecast.install(name, content))


@router.delete("/forecast")
def forecast_reset(user: dict[str, Any] = Depends(current_user)) -> Any:
    return forecast.reset()


@router.get("/forecast/summary")
def forecast_summary(currency: str = Query("INR"), user: dict[str, Any] = Depends(current_user)) -> Any:
    return _guard(lambda: forecast.summary(currency))


@router.get("/forecast/download")
def forecast_download(user: dict[str, Any] = Depends(current_user)) -> Any:
    out = _guard(forecast.predictions_csv)
    if not isinstance(out, str):
        return out
    return Response(out, media_type="text/csv",
                    headers={"Content-Disposition": 'attachment; filename="mmm_forecast_predictions.csv"'})


@router.get("/forecast/sample/{years}")
def forecast_sample(years: int, user: dict[str, Any] = Depends(current_user)) -> Any:
    try:
        path = forecast.sample_path(years)
    except FileNotFoundError as exc:
        raise HTTPException(404, str(exc)) from exc
    return FileResponse(path, media_type="text/csv", filename=path.name)
