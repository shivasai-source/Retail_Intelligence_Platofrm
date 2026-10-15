"""The MMM Budget Allocator (app/mmm/allocator.py), on the Budget Optimizer's
synthetic dataset with a known media effect."""

from __future__ import annotations

import pytest

from app.mmm import allocator, budget
from tests.test_mmm_budget import _ready, client, installed  # noqa: F401  (fixture)


def _period() -> tuple[int, int, float]:
    _ready()
    opts = budget.options()
    start, end = opts["default"]["start"], opts["default"]["end"]
    return start, end, budget.period(start, end).budget


def test_at_the_actual_budget_same_mix_is_actual(installed):
    start, end, actual = _period()
    out = allocator.allocate(start, end, actual)
    s = out["scenarios"]
    assert s["same_mix"]["profit"]["value"] == pytest.approx(s["actual"]["profit"]["value"], rel=1e-9)
    assert s["optimized"]["spend"]["value"] == pytest.approx(actual, rel=1e-6)
    assert out["deltas"]["mix"]["profit"]["value"] >= 0


@pytest.mark.parametrize("factor", [0.6, 1.4])
def test_a_new_budget_is_spent_in_full_on_the_same_baseline(installed, factor):
    start, end, actual = _period()
    out = allocator.allocate(start, end, actual * factor)
    s, d = out["scenarios"], out["deltas"]
    for k in ("same_mix", "optimized"):
        assert s[k]["spend"]["value"] == pytest.approx(actual * factor, rel=1e-6)
    assert sum(c["optimized"] for c in out["channels"]) == pytest.approx(actual * factor, rel=1e-4)
    assert s["actual"]["baseline"]["value"] == s["same_mix"]["baseline"]["value"] == s["optimized"]["baseline"]["value"]
    assert d["mix"]["profit"]["value"] >= 0
    assert d["budget"]["profit"]["value"] + d["mix"]["profit"]["value"] == pytest.approx(d["total"]["profit"]["value"], rel=1e-6)
    assert min(c["optimized"] for c in out["channels"]) >= 0


def test_weeks_only_keeps_every_channels_share(installed):
    start, end, actual = _period()
    out = allocator.allocate(start, end, actual * 0.8, mode="within_channel")
    for c in out["channels"]:
        assert c["optimized"] == pytest.approx(c["same"], rel=1e-4, abs=1.0)


def test_frontier_starts_at_the_baseline_and_peaks(installed):
    start, end, actual = _period()
    f = allocator.frontier(start, end)
    first = f["points"][0]
    assert first["spend"] == 0 and first["same"] == pytest.approx(first["best"])
    tol = actual * 1e-4
    assert all(p["best"] >= p["same"] - tol for p in f["points"])
    assert f["peak"]["profit"] >= max(p["best"] for p in f["points"]) - tol
    # The peak agrees with allocating at the peak budget.
    at_peak = allocator.allocate(start, end, f["peak"]["spend"])
    assert at_peak["scenarios"]["optimized"]["profit"]["value"] == pytest.approx(f["peak"]["profit"], rel=1e-4)


def test_endpoints(installed):
    start, end, actual = _period()
    ok = client.post("/api/mmm/budget/allocate", json={"start": start, "end": end, "budget": actual * 1.2, "currency": "USD"})
    assert ok.status_code == 200
    assert ok.json()["budget"]["display"].startswith("$")
    assert client.post("/api/mmm/budget/allocate", json={"start": start, "end": end, "budget": 0}).status_code == 422
    fr = client.get(f"/api/mmm/budget/frontier?start={start}&end={end}&mode=across_channels")
    assert fr.status_code == 200 and fr.json()["peak"]["spend"] > 0
