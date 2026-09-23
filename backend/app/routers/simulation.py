"""Simulation Studio routes.

Mounted at `/api/simulation`. Three endpoints:

  POST /scope     the measured plan, the fitted lift model and each lever's
                  range and starting value for a scope -- everything the page
                  needs before a slider moves.
  POST /simulate  three lever values -> the window's Revenue and ROI, beside
                  the current plan's over the same window.
  POST /curve     the budget and days -> Revenue and ROI at every discount
                  depth the slider allows; the shape the discount slider moves
                  along.
  POST /optimize  the levers to vary, each with the top of its range -> the
                  best values in those ranges for ROI, beside the starting
                  point. One product at a time.

No business logic here. The route parses a body into the ONE `FilterState`
every other module already uses, delegates to app/tpo/studio.py, and
serialises. The filter contract is deliberately the same object the Insights
Hub's query parameters build, so "the studio's South Modern Trade" and "the
Insights Hub's South Modern Trade" are the same rows by construction.
"""

from __future__ import annotations

from typing import Annotated, Any, Literal

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, ConfigDict, Field

from app.tpo import studio
from app.tpo.filters import FilterState

router = APIRouter(prefix="/api/simulation", tags=["simulation"])


class SimulationFilters(BaseModel):
    """The request-body form of `FilterState`.

    A transport shape, NOT a second filter model: every field is handed
    straight to `FilterState.build`, which owns normalisation and rejects any
    dimension it does not know. `tests/test_studio.py` asserts these field
    names are exactly `filters.DIMENSIONS`, so the two cannot drift apart.

    Year and month are the real calendar values, as everywhere else in the
    project; F24/F25 is a display label applied in app/tpo/formatting.py.
    """

    model_config = ConfigDict(extra="forbid")

    year: int | None = None
    month: Annotated[int | None, Field(ge=1, le=12)] = None
    channel: list[str] | None = None
    retailer: list[str] | None = None
    region: list[str] | None = None
    state: list[str] | None = None
    city: list[str] | None = None
    tier: list[str] | None = None
    distributor: list[str] | None = None
    category: list[str] | None = None
    brand: list[str] | None = None
    product: list[str] | None = None
    promotion: list[str] | None = None
    promotion_type: list[str] | None = None

    def to_state(self) -> FilterState:
        lists = self.model_dump(exclude={"year", "month"})
        return FilterState.build(year=self.year, month=self.month, **lists)


Currency = Annotated[str, Field(pattern="^(INR|USD|inr|usd)$")]


class ScopeRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    filters: SimulationFilters = Field(default_factory=SimulationFilters)
    currency: Currency = "INR"


class SimulateRequest(BaseModel):
    """The three levers. `extra="forbid"` on purpose: a client posting a lever
    that does not exist gets a 422 naming it, not a silent success."""

    model_config = ConfigDict(extra="forbid")

    filters: SimulationFilters = Field(default_factory=SimulationFilters)
    currency: Currency = "INR"
    #: Percent. The upper bound is the model's evidence domain, checked by the
    #: service with a reason; this is only the transport-level sanity bound.
    discount_pct: Annotated[float, Field(ge=0, le=100)]
    #: The budget, in base currency (INR). Zero means "fund nothing".
    trade_spend: Annotated[float, Field(ge=0)]
    days: Annotated[int, Field(ge=studio.MIN_DAYS, le=studio.MAX_DAYS)]


def _state(filters: SimulationFilters) -> FilterState:
    try:
        return filters.to_state()
    except ValueError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc


@router.post("/scope")
def scope(body: ScopeRequest) -> dict[str, Any]:
    try:
        return studio.scope(_state(body.filters), currency=body.currency)
    except studio.NothingToSimulate as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc


@router.post("/simulate")
def simulate(body: SimulateRequest) -> dict[str, Any]:
    try:
        return studio.simulate(
            _state(body.filters),
            discount_pct=body.discount_pct,
            trade_spend=body.trade_spend,
            days=body.days,
            currency=body.currency,
        )
    except (studio.NothingToSimulate, studio.LeverOutOfRange) as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc


class CurveRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    filters: SimulationFilters = Field(default_factory=SimulationFilters)
    currency: Currency = "INR"
    trade_spend: Annotated[float, Field(ge=0)]
    days: Annotated[int, Field(ge=studio.MIN_DAYS, le=studio.MAX_DAYS)]


@router.post("/curve")
def curve(body: CurveRequest) -> dict[str, Any]:
    try:
        return studio.curve(
            _state(body.filters), trade_spend=body.trade_spend, days=body.days, currency=body.currency,
        )
    except (studio.NothingToSimulate, studio.LeverOutOfRange) as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc


Optimizable = Literal["discount_pct", "trade_spend", "days"]


class OptimizeRequest(BaseModel):
    """The three levers as they stand, and which of them to search.

    `vary` maps a lever to the TOP of its range; every range starts at the
    lever's minimum. A lever not in `vary` is held at the value given. An
    empty `vary` is a 422, not a no-op: the button that sends this is
    disabled until something is ticked, and the API says the same."""

    model_config = ConfigDict(extra="forbid")

    filters: SimulationFilters = Field(default_factory=SimulationFilters)
    currency: Currency = "INR"
    discount_pct: Annotated[float, Field(ge=0, le=100)]
    trade_spend: Annotated[float, Field(ge=0)]
    days: Annotated[int, Field(ge=studio.MIN_DAYS, le=studio.MAX_DAYS)]
    vary: Annotated[dict[Optimizable, Annotated[float, Field(ge=0)]], Field(min_length=1)]


@router.post("/optimize")
def optimize(body: OptimizeRequest) -> dict[str, Any]:
    try:
        return studio.optimize(
            _state(body.filters),
            discount_pct=body.discount_pct,
            trade_spend=body.trade_spend,
            days=body.days,
            vary=body.vary,
            currency=body.currency,
        )
    except (studio.NothingToSimulate, studio.LeverOutOfRange, studio.NotOptimizable) as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc

