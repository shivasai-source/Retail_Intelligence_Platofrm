"""Promotion Planner routes.

Mounted at `/api/planner`. Every endpoint takes the same selection -- products,
stores, channels and regions (each a list, empty meaning all), a period as
inclusive (year, business week) bounds, and optionally one promotion carried
in from the Promotion Calendar -- and delegates to app/tpo/planner.py.

  POST /options   what the selection bar can offer, narrowed by the rest
  POST /summary   the selection as it stands: its plan, its promotions, the lever
  POST /whatif    the average discount -> revenue, profit and ROI against today
  POST /curve     profit, revenue and ROI at every average discount
  POST /best      the most profitable plan: one discount, and a re-planned calendar
  POST /target    +X% profit: what has to change, or the most that is reachable

No business logic here.
"""

from __future__ import annotations

from typing import Annotated, Any, Literal

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, ConfigDict, Field

from app.tpo import planner

router = APIRouter(prefix="/api/planner", tags=["planner"])

Currency = Annotated[str, Field(pattern="^(INR|USD|inr|usd)$")]
WeekRef = Annotated[list[int], Field(min_length=2, max_length=2)]


class Selection(BaseModel):
    model_config = ConfigDict(extra="forbid")

    products: list[str] = Field(default_factory=list)
    stores: list[str] = Field(default_factory=list)
    channels: list[str] = Field(default_factory=list)
    regions: list[str] = Field(default_factory=list)
    start: WeekRef | None = None
    end: WeekRef | None = None
    promotion: str | None = None
    #: [year, month] -- a calendar month, resolved to its business weeks. Used
    #: by the Promotion Calendar's hand-off; overrides start and end.
    month: WeekRef | None = None

    def to_scope(self) -> planner.PlanScope:
        start, end = self.start, self.end
        if self.month:
            bounds = planner.month_bounds(self.month[0], self.month[1])
            if bounds is None:
                raise HTTPException(status_code=422, detail=f"No business week falls in {self.month[1]}/{self.month[0]}.")
            start, end = list(bounds[0]), list(bounds[1])
        return planner.PlanScope.build(
            products=self.products, stores=self.stores, channels=self.channels, regions=self.regions,
            start=start, end=end, promotion=self.promotion,
        )


class Body(BaseModel):
    model_config = ConfigDict(extra="forbid")

    selection: Selection = Field(default_factory=Selection)
    currency: Currency = "INR"


class WhatIfBody(Body):
    discount_pct: Annotated[float, Field(ge=0, le=100)]


class PlanBody(Body):
    timing: Literal["free", "fixed"] = "free"
    count: Literal["keep", "fewer", "more"] = "keep"


class TargetBody(PlanBody):
    target_pct: Annotated[float, Field(gt=0, le=1000)]
    basis: Literal["cost", "promotion"] = "cost"


def _run(fn, *args: Any, **kwargs: Any) -> dict[str, Any]:
    try:
        return fn(*args, **kwargs)
    except (planner.EmptySelection, planner.NothingPromoted) as e:
        raise HTTPException(status_code=422, detail=str(e)) from e


@router.post("/options")
def options(body: Body) -> dict[str, Any]:
    return _run(planner.options, body.selection.to_scope())


@router.post("/summary")
def summary(body: Body) -> dict[str, Any]:
    return _run(planner.summary, body.selection.to_scope(), currency=body.currency.upper())


@router.post("/whatif")
def whatif(body: WhatIfBody) -> dict[str, Any]:
    return _run(planner.whatif, body.selection.to_scope(), body.discount_pct, currency=body.currency.upper())


@router.post("/curve")
def curve(body: Body) -> dict[str, Any]:
    return _run(planner.curve, body.selection.to_scope(), currency=body.currency.upper())


@router.post("/best")
def best(body: PlanBody) -> dict[str, Any]:
    return _run(planner.best, body.selection.to_scope(), timing=body.timing, frequency=body.count,
                currency=body.currency.upper())


@router.post("/target")
def target(body: TargetBody) -> dict[str, Any]:
    return _run(planner.target, body.selection.to_scope(), target_pct=body.target_pct, timing=body.timing,
                frequency=body.count, basis=body.basis, currency=body.currency.upper())
