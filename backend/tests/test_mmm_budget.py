"""The MMM Budget Optimizer (app/mmm/budget_model.py, app/mmm/budget.py).

Runs on a small synthetic dataset with a KNOWN media effect, written to a
throwaway MMM data folder, so a full fit takes seconds and every check has a
right answer to compare with.
"""

from __future__ import annotations

import time

import numpy as np
import pandas as pd
import pytest
from fastapi.testclient import TestClient

from app.deps import current_user
from app.main import app
from app.mmm import budget, budget_model, loader

client = TestClient(app)

CHANNELS = ("TV_Spend", "Meta_Ads_Spend", "Google_Search_Spend")
#: decay, kappa (rupees), alpha, beta (rupees/day at saturation)
TRUE = {
    "TV_Spend": (0.4, 400_000.0, 0.9, 1_200_000.0),
    "Meta_Ads_Spend": (0.1, 150_000.0, 0.85, 600_000.0),
    "Google_Search_Spend": (0.0, 100_000.0, 0.8, 500_000.0),
}


def _dataset(days: int = 730, seed: int = 3) -> pd.DataFrame:
    rng = np.random.default_rng(seed)
    dates = pd.date_range("2023-01-02", periods=days, freq="D")
    frame = pd.DataFrame({"Date": dates})
    on = rng.random(days) < 0.5
    for c in CHANNELS:
        level = {"TV_Spend": 500_000, "Meta_Ads_Spend": 200_000, "Google_Search_Spend": 120_000}[c]
        frame[c] = np.where(on & (rng.random(days) < 0.8), rng.uniform(0.4, 1.6, days) * level, 0.0).round()
    frame["Festival_Flag"] = (rng.random(days) < 0.3).astype(int)
    frame["Seasonal_Flag"] = (rng.random(days) < 0.3).astype(int)
    frame["Promotion_Flag"] = (rng.random(days) < 0.3).astype(int)
    frame["Discount_Percentage"] = frame["Promotion_Flag"] * 10
    frame["Promotion_Type"] = np.where(frame["Promotion_Flag"] == 1, "10% Discount", "No Offer")
    base = 5_000_000 + 400_000 * np.sin(2 * np.pi * dates.dayofyear / 365.25) + 300_000 * frame["Festival_Flag"]
    media = np.zeros(days)
    for c, (decay, kappa, alpha, beta) in TRUE.items():
        media += beta * budget_model.hill(budget_model.adstock(frame[c].to_numpy(float), decay), kappa, alpha)
    frame["Revenue"] = (base + media + rng.normal(0, 150_000, days)).round()
    return frame


@pytest.fixture()
def installed(tmp_path, monkeypatch):
    folder = tmp_path / "mmm"
    folder.mkdir()
    monkeypatch.setenv("MMM_DATA_DIR", str(folder))
    monkeypatch.setattr(budget_model, "BOOTSTRAPS", 4)
    monkeypatch.setattr(budget_model, "_cache_path", lambda: tmp_path / "model.npz")
    frame = _dataset()
    out = frame.copy()
    out["Date"] = out["Date"].dt.strftime("%d-%m-%Y")
    (folder / "mmm_daily.csv").write_text(out.to_csv(index=False), encoding="utf-8")
    loader.reset_cache()
    app.dependency_overrides[current_user] = lambda: {"email": "qa@example.test"}
    yield frame
    app.dependency_overrides.pop(current_user, None)
    loader.reset_cache()


def _ready() -> budget_model.Model:
    for _ in range(600):
        if budget_model.status()["status"] == "ready":
            return budget_model.get_model()
        assert budget_model.status()["status"] != "error", budget_model.status()["error"]
        time.sleep(0.1)
    raise AssertionError("the model never finished training")


def test_endpoints_answer_409_while_training_then_serve(installed):
    budget_model.reset()
    first = client.get("/api/mmm/budget/options")
    # Either still training (409 with progress) or already done on a fast machine.
    assert first.status_code in (200, 409)
    if first.status_code == 409:
        assert first.json()["model_training"] is True
    _ready()
    opts = client.get("/api/mmm/budget/options").json()
    assert {c["key"] for c in opts["channels"]} == set(CHANNELS)
    assert opts["default"]["start"] <= opts["default"]["end"]


def test_fit_recovers_the_known_effects(installed):
    model = _ready()
    for j, c in enumerate(model.channels):
        decay, kappa, alpha, beta = TRUE[c]
        shape = budget_model.hill(budget_model.adstock(model.spend[:, j], decay), kappa, alpha)
        truth = beta * shape.sum() / model.spend[:, j].sum()
        assert abs(model.central.roas[j] - truth) / truth < 0.35, (c, model.central.roas[j], truth)
    assert model.checks["holdout_last_year"]["mape_pct"] < 6


def test_gradient_matches_a_finite_difference(installed):
    _ready()
    opts = budget.options()
    per = budget.period(opts["default"]["start"], opts["default"]["end"])
    fit = per.model.central
    g = budget._gradient(per, fit, per.current)
    for j in range(len(CHANNELS)):
        w = int(np.argmax(per.current[j]))
        h = max(per.current[j, w] * 1e-4, 10.0)
        bumped = per.current.copy()
        bumped[j, w] += h
        numeric = (budget._lift(per, fit, bumped).sum() - budget._lift(per, fit, per.current).sum()) / h
        assert g[j, w] == pytest.approx(numeric, rel=0.02, abs=1e-4)


def test_weekly_points_add_up_to_the_totals(installed):
    _ready()
    opts = budget.options()
    out = budget.optimize(opts["default"]["start"], opts["default"]["end"])
    weekly = out["weekly"]
    assert weekly[-1]["after"] is True  # the carryover after the period
    for now, key in (("revenue_now", "current_figures"), ("revenue_plan", "figures")):
        assert sum(w[now] for w in weekly) == pytest.approx(out[key]["revenue"]["value"], rel=1e-6)
    assert sum(w["profit_plan"] for w in weekly) == pytest.approx(out["figures"]["profit"]["value"], rel=1e-6)


def test_every_change_is_classified(installed):
    _ready()
    opts = budget.options()
    out = budget.optimize(opts["default"]["start"], opts["default"]["end"])
    kinds = out["impact"]["kinds"]
    assert set(kinds) == {"week", "channel", "both"}
    assert sum(k["count"] for k in kinds.values()) == len(out["moves"])
    assert out["impact"]["channels_touched"] == len(out["channels"])
    # "All channels" first, then one per channel.
    assert out["curves"][0]["key"] == "__all__"
    assert len(out["curves"]) == len(CHANNELS) + 1
    assert out["curves"][0]["plan"]["incremental"] == pytest.approx(out["figures"]["incremental"]["value"], rel=1e-6)
    for c in out["curves"]:
        assert c["points"][0]["incremental"] == 0
        assert all(p["p10"] <= p["p90"] for p in c["points"] + c["plan_points"])


@pytest.mark.parametrize("mode,keeps", [("within_channel", 1), ("across_channels", 0)])
def test_each_mode_keeps_its_totals(installed, mode, keeps):
    _ready()
    opts = budget.options()
    per = budget.period(opts["default"]["start"], opts["default"]["end"])
    out = budget.optimize(opts["default"]["start"], opts["default"]["end"], "INR", mode)
    plan = np.array(out["matrix"])
    assert np.allclose(plan.sum(axis=keeps), per.current.sum(axis=keeps), rtol=1e-6, atol=1.0)
    allowed = {"within_channel": {"week"}, "across_channels": {"channel"}}[mode]
    assert {m["kind"] for m in out["moves"]} <= allowed


def test_every_kpi_but_spend_carries_a_range(installed):
    _ready()
    opts = budget.options()
    f = budget.summary(opts["default"]["start"], opts["default"]["end"])["figures"]
    assert f["spend"]["range"] is None
    for k in ("profit", "profit_pct", "revenue", "baseline", "incremental", "roas"):
        r = f[k]["range"]
        assert r is not None and r["p10"] <= r["p90"], k


def test_figures_follow_the_tpo_definitions(installed):
    _ready()
    opts = budget.options()
    f = budget.summary(opts["default"]["start"], opts["default"]["end"])["figures"]
    v = {k: f[k]["value"] for k in f}
    assert v["revenue"] == pytest.approx(v["baseline"] + v["incremental"], rel=1e-9)
    assert v["profit"] == pytest.approx(v["revenue"] - v["spend"], rel=1e-9)
    # The API rounds ratios to 4 decimals.
    assert v["profit_pct"] == pytest.approx(v["profit"] / v["spend"] * 100, abs=1e-4)
    assert v["roas"] == pytest.approx(v["incremental"] / v["spend"], abs=1e-4)


def test_optimizer_keeps_the_budget_and_raises_profit(installed):
    _ready()
    opts = budget.options()
    out = budget.optimize(opts["default"]["start"], opts["default"]["end"])
    budget_total = out["budget"]["value"]
    assert sum(map(sum, out["matrix"])) == pytest.approx(budget_total, rel=1e-6)
    assert min(min(r) for r in out["matrix"]) >= 0
    assert out["deltas"]["profit"]["value"] > 0
    assert out["deltas"]["spend"]["value"] == pytest.approx(0, abs=budget_total * 1e-6)


def test_moves_account_for_every_change(installed):
    _ready()
    opts = budget.options()
    per = budget.period(opts["default"]["start"], opts["default"]["end"])
    out = budget.optimize(opts["default"]["start"], opts["default"]["end"])
    plan = np.array(out["matrix"])
    moved = sum(m["amount"] for m in out["moves"])
    # Cells that move by less than the display threshold are not listed.
    assert moved == pytest.approx(np.clip(plan - per.current, 0, None).sum(), rel=0.01)
    assert {m["kind"] for m in out["moves"]} <= {"week", "channel", "both"}


def test_cache_round_trips_without_pickle(installed, tmp_path):
    model = _ready()
    key = budget_model._key()
    budget_model._save_cached(key, model)
    loaded = budget_model._load_cached(key)
    assert loaded is not None
    assert np.allclose(loaded.central.beta, model.central.beta)
    assert len(loaded.draws) == len(model.draws)
