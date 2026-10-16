"""The MMM Revenue Forecast (app/mmm/forecast.py), on the Budget Optimizer's
synthetic dataset, whose true revenue formula is known."""

from __future__ import annotations

import numpy as np
import pandas as pd
import pytest

from app.mmm import budget, budget_model, forecast, loader
from tests.test_mmm_budget import TRUE, _ready, client, installed  # noqa: F401  (fixture)


def _plan(frame: pd.DataFrame, days: int = 120, seed: int = 5) -> pd.DataFrame:
    """Future days patterned on the data: on / off ad days and flags."""
    rng = np.random.default_rng(seed)
    dates = pd.date_range(frame["Date"].max() + pd.Timedelta(days=1), periods=days, freq="D")
    src = frame.iloc[-days:].reset_index(drop=True)
    plan = src.drop(columns="Revenue").copy()
    plan["Date"] = dates
    for c in TRUE:
        plan[c] = (plan[c] * rng.uniform(0.8, 1.2, days)).round()
    return plan


def _truth(frame: pd.DataFrame, plan: pd.DataFrame) -> float:
    """Revenue the synthetic data's own formula gives the plan's days."""
    both = pd.concat([frame.drop(columns="Revenue"), plan], ignore_index=True)
    dates = both["Date"]
    base = 5_000_000 + 400_000 * np.sin(2 * np.pi * dates.dt.dayofyear / 365.25) + 300_000 * both["Festival_Flag"]
    media = np.zeros(len(both))
    for c, (decay, kappa, alpha, beta) in TRUE.items():
        media += beta * budget_model.hill(budget_model.adstock(both[c].to_numpy(float), decay), kappa, alpha)
    return float((base + media).to_numpy()[len(frame):].sum())


def _csv(plan: pd.DataFrame) -> bytes:
    out = plan.copy()
    out["Date"] = out["Date"].dt.strftime("%d-%m-%Y")
    return out.to_csv(index=False).encode()


def test_baseline_features_for_the_history_are_the_fitted_ones(installed):
    model = _ready()
    history = loader.get_frame().sort_values("Date").reset_index(drop=True)
    assert np.allclose(budget_model.baseline_features(history, history), model.baseline_X)


def test_forecast_predicts_the_known_revenue(installed):
    _ready()
    plan = _plan(installed)
    res = client.post("/api/mmm/forecast", files={"file": ("plan.csv", _csv(plan), "text/csv")})
    assert res.status_code == 200 and res.json()["loaded"] is True
    s = client.get("/api/mmm/forecast/summary").json()
    revenue = s["figures"]["revenue"]["value"]
    assert revenue == pytest.approx(_truth(installed, plan), rel=0.04)
    assert s["figures"]["spend"]["value"] == pytest.approx(plan[list(TRUE)].to_numpy().sum())
    for by in ("day", "week", "month"):
        assert sum(p["revenue"] for p in s["series"][by]) == pytest.approx(revenue, rel=1e-6)
    assert s["plan"]["days"] == len(plan)
    lo, hi = s["figures"]["revenue"]["range"]["p10"], s["figures"]["revenue"]["range"]["p90"]
    # Tests refit only a few times, so the central fit may sit outside the band.
    assert lo < hi and abs(revenue - (lo + hi) / 2) < (hi - lo) * 2
    csv = client.get("/api/mmm/forecast/download")
    assert csv.status_code == 200 and "Predicted_Revenue" in csv.text.splitlines()[0]


def test_bad_plans_are_refused_with_a_reason(installed):
    _ready()
    plan = _plan(installed)
    early = plan.copy()
    early.loc[0, "Date"] = installed["Date"].max()
    res = client.post("/api/mmm/forecast", files={"file": ("p.csv", _csv(early), "text/csv")})
    assert res.status_code == 422 and "must start after" in res.json()["detail"]
    neg = plan.copy()
    neg.loc[3, "TV_Spend"] = -5
    assert client.post("/api/mmm/forecast", files={"file": ("p.csv", _csv(neg), "text/csv")}).status_code == 422
    partial = plan.drop(columns=["Meta_Ads_Spend"]).assign(Revenue=1)
    ok = client.post("/api/mmm/forecast", files={"file": ("p.csv", _csv(partial), "text/csv")})
    assert ok.status_code == 200
    notes = client.get("/api/mmm/forecast/summary").json()["plan"]["notes"]
    assert any("Meta Ads" in n for n in notes) and any("Revenue" in n for n in notes)


def test_the_optimizer_plans_the_forecast_weeks(installed):
    model = _ready()
    client.post("/api/mmm/forecast", files={"file": ("plan.csv", _csv(_plan(installed)), "text/csv")})
    opts = client.get("/api/mmm/budget/options?source=forecast").json()
    per = budget.period(opts["default"]["start"], opts["default"]["end"], "forecast")
    assert per.weeks[0].first >= len(model.dates)
    out = client.post("/api/mmm/budget/optimize", json={**opts["default"], "source": "forecast"}).json()
    assert out["deltas"]["profit"]["value"] >= 0
    alloc = client.post("/api/mmm/budget/allocate", json={**opts["default"], "source": "forecast", "budget": per.budget * 1.1})
    assert alloc.status_code == 200


def test_without_a_plan_the_forecast_routes_say_so(installed):
    _ready()
    forecast.reset()
    assert client.get("/api/mmm/forecast").json() == {"loaded": False}
    res = client.get("/api/mmm/forecast/summary")
    assert res.status_code == 404 and res.json()["forecast_missing"] is True
    assert client.get("/api/mmm/forecast/sample/3").status_code == 200
