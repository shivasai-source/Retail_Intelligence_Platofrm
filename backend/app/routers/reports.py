"""Report Center routes.

    POST   /api/reports                        generate into the library
    GET    /api/reports                        the library, filtered
    GET    /api/reports/modules                what can be generated
    GET    /api/reports/{report_id}            one report's metadata + preview
    GET    /api/reports/{report_id}/download/{fmt}   the artifact, as a download
    DELETE /api/reports/{report_id}            remove report and artifacts
    DELETE /api/reports                        empty the library

GENERATE IS NOT DOWNLOAD, and the route table is where that is enforced. `POST
/api/reports` returns METADATA -- a `report_id` and a status -- and never bytes.
A file crosses the wire only from the explicit download route, which is reached
only when a person clicks Excel or PDF in the Report Center. That separation is
the whole point of this module: the previous `/export` endpoint answered with a
file, which is why a click downloaded immediately.

NO EXISTING ENDPOINT WAS CHANGED to support any of this. The report service calls
the same `app/tpo/*` functions the Insights Hub, Simulation Studio and Decision
Center endpoints call, and those endpoints are untouched.

THE CLIENT POSTS A SCOPE, NOT RESULTS. What travels is what the user SELECTED --
filters, the mode, the control values. The server re-runs the authoritative
service over that scope, so a client cannot put a number into a stored report
that this project's engine did not produce.
"""

from __future__ import annotations

from typing import Annotated, Any, Literal

from fastapi import APIRouter, HTTPException, Query, Response
from pydantic import BaseModel, ConfigDict, Field

from app.reports import service
from app.store import reports as report_store

router = APIRouter(prefix="/api/reports", tags=["reports"])

_MEDIA = {"xlsx": service.XLSX_MEDIA, "pdf": service.PDF_MEDIA}


class GenerateRequest(BaseModel):
    """One report to generate into the Report Center.

    `scope` is the filter selection, in the dimension names `app/tpo/filters.py`
    defines; anything it does not know is rejected rather than dropped, so a
    typo cannot silently widen the report's scope. `options` carries the module's
    own control values -- the discount a scenario was set to, the optimizer's
    ceiling, Target Rescue's target and checkpoint -- which are INPUTS to the
    authoritative service, never results.
    """

    model_config = ConfigDict(extra="forbid")

    module: Annotated[str, Field(min_length=1, max_length=64)]
    scope: dict[str, Any] = Field(default_factory=dict)
    options: dict[str, Any] = Field(default_factory=dict)
    currency: Annotated[str, Field(pattern="^(INR|USD|inr|usd)$")] = "INR"
    #: Which artifacts to produce. Both by default -- the Report Center offers an
    #: Excel and a PDF button per report, and a format that was never generated
    #: shows as unavailable rather than as a dead button.
    formats: list[Literal["xlsx", "pdf"]] = Field(default_factory=lambda: ["xlsx", "pdf"])


@router.get("/modules")
def modules() -> dict[str, Any]:
    """Which modules can be generated, and in which formats.

    Lets the UI offer the control only where a real reportable dataset exists
    rather than hard-coding a list that could drift from the registry.
    """
    return {
        "modules": [
            {"key": m.key, "label": m.label, "formats": list(service.FORMATS)}
            for m in (service.MODULES[k] for k in service.module_keys())
        ],
        "formats": list(service.FORMATS),
    }


@router.post("", status_code=201)
def generate(body: GenerateRequest) -> dict[str, Any]:
    """Generate a report into the Report Center.

    RETURNS METADATA, NOT A FILE. The response is the stored report's id and
    status so the caller can say "generated" and offer a link to it; downloading
    is a separate, explicit act.
    """
    try:
        report_id = service.generate(
            body.module, body.scope, body.options,
            currency=body.currency, formats=tuple(body.formats),
        )
    except service.UnsupportedModule as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc
    except service.ReportUnavailable as exc:
        # 422: the request is well formed and the module cannot report on it.
        raise HTTPException(status_code=422, detail=str(exc)) from exc
    except ValueError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc

    report = report_store.get(report_id)
    if report.status != report_store.READY:
        # Never answer 201 for a report with no artifact behind it.
        raise HTTPException(
            status_code=500,
            detail=report.error or "The report generated no artifact.",
        )
    return report.as_dict()


@router.get("")
def library(
    module: Annotated[str | None, Query(max_length=64)] = None,
    format: Annotated[Literal["xlsx", "pdf"] | None, Query()] = None,
    search: Annotated[str | None, Query(max_length=120)] = None,
    limit: Annotated[int, Query(ge=1, le=500)] = 200,
) -> dict[str, Any]:
    """The Report Center's contents, newest first.

    Every row corresponds to a stored artifact. There are no seeded or example
    rows: an empty library returns an empty list, and the page says so.
    """
    rows = report_store.listing(module=module, fmt=format, search=search, limit=limit)
    return {
        "reports": [r.as_dict() for r in rows],
        "total": report_store.count(),
        "returned": len(rows),
        "modules": [
            {"key": m.key, "label": m.label}
            for m in (service.MODULES[k] for k in service.module_keys())
        ],
        "owner_note": report_store.NO_OWNER_NOTE,
    }


@router.get("/{report_id}")
def detail(report_id: str) -> dict[str, Any]:
    """One report's metadata and its stored preview.

    THE PREVIEW IS THE ONE THAT WAS GENERATED, not a fresh evaluation. Re-running
    the module here would show today's numbers under a report generated
    yesterday, and the library would disagree with the artifacts it lists.
    """
    try:
        return report_store.get(report_id).as_dict()
    except report_store.ReportNotFound as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc


@router.get("/{report_id}/download/{fmt}")
def download(report_id: str, fmt: Literal["xlsx", "pdf"]) -> Response:
    """THE ONLY ROUTE THAT ANSWERS WITH A FILE.

    Reached when a person clicks Excel or PDF in the Report Center, never as a
    side effect of generating.
    """
    try:
        name, payload = report_store.artifact(report_id, fmt)
    except report_store.ReportNotFound as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc
    except report_store.ArtifactNotFound as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc

    if not payload:
        raise HTTPException(
            status_code=500, detail="The stored artifact is empty. Nothing was sent."
        )

    return Response(
        content=payload,
        media_type=_MEDIA[fmt],
        headers={
            "Content-Disposition": f'attachment; filename="{name}"',
            # The browser fetch reads the filename from here, so it must be
            # exposed explicitly -- it is not a CORS-safelisted response header.
            "Access-Control-Expose-Headers": "Content-Disposition",
            "Content-Length": str(len(payload)),
            "Cache-Control": "no-store",
        },
    )


@router.delete("", status_code=200)
def clear() -> dict[str, Any]:
    """Empty the Report Center.

    Answers with the number removed rather than 204, so the caller can say "12
    reports cleared" instead of guessing. Clearing an already-empty library is a
    success with a count of zero, not an error -- there is nothing wrong with
    asking for a state you are already in.

    THIS IS NOT FILTERED. It empties the whole library, not the rows the page is
    currently showing; a clear that spared what a filter was hiding would leave
    reports behind in a library the user believes is empty.
    """
    removed = report_store.clear()
    return {"deleted": removed, "total": report_store.count()}


@router.delete("/{report_id}", status_code=204)
def remove(report_id: str) -> Response:
    """Remove a report and its artifacts together.

    A report is a DERIVED artifact -- regenerable from the same scope -- so
    deleting one destroys no history. That is why this exists here and why the
    scenario and decision tables beside it remain append-only.
    """
    try:
        report_store.delete(report_id)
    except report_store.ReportNotFound as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc
    return Response(status_code=204)
