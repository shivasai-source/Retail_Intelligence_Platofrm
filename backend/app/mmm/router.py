"""Every MMM route, under /api/mmm.

    GET    /api/mmm/dataset               status (strip, gate, sidebar lock)
    POST   /api/mmm/dataset               upload one file; replaces the installed one
    POST   /api/mmm/dataset/inspect       header-only preflight (for .xlsx)
    GET    /api/mmm/dataset/preview       installed rows, paged
    DELETE /api/mmm/dataset               remove the installed dataset
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

from typing import Any, Callable

from fastapi import APIRouter, Depends, File, HTTPException, Query, UploadFile
from fastapi.responses import FileResponse, JSONResponse, Response
from pydantic import BaseModel

from app.deps import current_user
from app.mmm import allocator, budget, budget_model, calendar, dataset, forecast, service
from app.mmm.loader import MmmDatasetMissing
from app.mmm.scope import Scope

router = APIRouter(prefix="/api/mmm", tags=["mmm"])


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
    file: UploadFile = File(...),
    user: dict[str, Any] = Depends(current_user),
) -> dict[str, Any]:
    content = await file.read()
    name = file.filename or "upload.csv"
    if not content:
        raise HTTPException(400, f"{name} is empty.")
    try:
        return dataset.install(name, content)
    except dataset.MmmDatasetError as exc:
        raise HTTPException(400, str(exc)) from exc


@router.post("/dataset/inspect")
async def inspect_dataset(
    file: UploadFile = File(...),
    user: dict[str, Any] = Depends(current_user),
) -> dict[str, Any]:
    return dataset.inspect(file.filename or "upload.csv", await file.read())


@router.get("/dataset/preview")
def preview_dataset(
    limit: int = Query(50, ge=1, le=500),
    offset: int = Query(0, ge=0),
    user: dict[str, Any] = Depends(current_user),
) -> Any:
    return _guard(lambda: dataset.preview(limit, offset))


@router.delete("/dataset")
def reset_dataset(user: dict[str, Any] = Depends(current_user)) -> dict[str, Any]:
    return dataset.reset()


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
