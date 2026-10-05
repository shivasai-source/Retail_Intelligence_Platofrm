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

Reports go through the shared Report Center (/api/reports, module
`mmm-insights`) — see app/mmm/report.py.

Data routes answer 503 with `mmm_dataset_missing: true` when nothing is
installed, the MMM twin of TPO's `dataset_missing` (app/main.py), so the
frontend can tell "not loaded yet" from "loaded and genuinely zero".
"""

from __future__ import annotations

from typing import Any, Callable

from fastapi import APIRouter, Depends, File, HTTPException, Query, UploadFile
from fastapi.responses import JSONResponse

from app.deps import current_user
from app.mmm import calendar, dataset, service
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
    event: list[str] = Query([], description="holiday, trending, promotion or none"),
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
