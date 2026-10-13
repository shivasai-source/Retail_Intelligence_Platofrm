"""Promotion Planner -- what-if, profit target, best plan.

What these tests hold the planner to:

  * TODAY IS MEASURED, NOT MODELLED. At today's discount the what-if is the
    selection's own figures to the rupee, and its Trade Spend, Incremental
    Sales and ROI are the Insights Hub engine's over the same rows.
  * THE RE-PLAN KEEPS ITS RULES. "Same count" keeps every product-store's
    number of promotions; consecutive promotions keep the channel's gap;
    festival offers stay in their festival's period; a product-store the data
    never saw promoted is never promoted; and no plan is worse than today.
  * FEWEST CHANGES. A reachable target re-plans the largest gains first and
    no more of them than it needs.
  * IT REFUSES RATHER THAN INVENTS. An offer that did not run in the
    selection is a 422 with a reason.
  * THE PDF'S ALGORITHMS. B is a hierarchical Bayesian fit that passes its
    own diagnostics (R-hat < 1.01, no divergences, ESS > 400) and its
    festival hold-out; the Monte Carlo brackets every plan; Q2 is the
    highest median profit; Q3 is a goal programme, its depth found by Brent.

Run with:

    ../venv/Scripts/python.exe -m pytest tests/test_planner.py -q
"""

from __future__ import annotations

import pytest
from fastapi.testclient import TestClient

import numpy as np

from app.main import app
from app.tpo import aggregate as A
from app.tpo import planner as P
from app.tpo.filters import FilterState, rows_for

YEAR = P.PlanScope.build(start=(2025, 1), end=(2025, 53))
SOUTH_MT = P.PlanScope.build(channels=["CH002"], regions=["South"], start=(2025, 1), end=(2025, 53))
FOCUS = P.PlanScope.build(channels=["CH001"], start=(2025, 40), end=(2025, 44), promotion="PR002")


@pytest.fixture(scope="module")
def client():
    return TestClient(app)


def test_model_passes_its_diagnostics():
    m = P.fitted().model
    d = m.post.diagnostics
    assert d["rhat_max"] < 1.01, "chains agree"
    assert d["divergences"] == 0
    assert d["ess_min"] > 400
    assert m.draws >= 1000, "about a thousand draws for the Monte Carlo"
    assert m.events, "festival terms are estimated from the seasonal offers"


def test_lift_grows_with_depth_and_starts_at_zero():
    """log(1 + u) = b1 d + b2 d^2: zero lift at zero discount, more at 15%
    than at 5% in every pooling group (the data's regular depths)."""
    m = P.fitted().model
    cells = np.array([int(np.flatnonzero(m.cell_group == g)[0]) for g in range(len(m.groups))])
    none = -np.ones(len(cells), dtype=np.int64)
    assert np.all(m.lift(cells, np.zeros(len(cells)), none) == 0)
    assert np.all(m.lift(cells, np.full(len(cells), 0.15), none) > m.lift(cells, np.full(len(cells), 0.05), none))


def test_backtests():
    bt = P.fitted().model.backtest
    assert bt["time"]["wape_units_pct"] < 20
    assert 60 <= bt["time"]["band_coverage_pct"] <= 98, "P10-P90 holds about 80% of actuals"
    held = bt["festival"]["events"]
    assert {e["event"].split()[0] for e in held} >= {"Diwali", "Dussehra"}
    assert all(e["within_band"] for e in held), "the held-out festivals land inside the band"


def test_today_is_the_measured_plan():
    s = P.summary(YEAR)
    w = P.whatif(YEAR, s["lever"]["default"])
    assert w["deltas"]["profit"]["absolute"]["value"] == 0
    assert w["scenario"] == w["current"]


def test_trade_spend_and_roi_are_the_engines():
    """The planner's current plan over a year equals the Insights Hub's
    engine over the same year's rows."""
    cur = P.summary(YEAR)["current"]
    rows = rows_for(FilterState(year=2025))
    spend = A.calculate_trade_spend(rows)
    sales = A.calculate_incremental_sales(rows)
    assert cur["trade_spend"]["value"] == pytest.approx(spend, rel=1e-6)
    assert cur["incremental_sales"]["value"] == pytest.approx(sales, rel=1e-6)
    assert cur["roi"]["value"] == pytest.approx(A.calculate_roi(rows), abs=0.005)


def test_deeper_discount_costs_margin_and_buys_volume():
    s = P.summary(FOCUS)
    today = s["lever"]["default"]
    deeper = P.whatif(FOCUS, today + 5)
    assert deeper["scenario"]["units"]["value"] > deeper["current"]["units"]["value"]
    assert deeper["scenario"]["trade_spend"]["value"] > deeper["current"]["trade_spend"]["value"]
    assert deeper["shift_pts"] == pytest.approx(5.0)


@pytest.mark.parametrize("scope", [YEAR, SOUTH_MT])
def test_replan_keeps_its_rules(scope):
    rp = P.replan(scope, "free", "keep")
    r = P.resolve(scope)
    rules = P.rules()
    s = P.fitted().slots
    fest = set(P._festival_depths(id(P.fitted())))
    for cp in rp.cells.values():
        assert len(cp.best) == len(cp.current), "same count keeps the number of promotions"
        assert cp.best_value >= cp.current_value - P.EPSILON, "never worse than today"
        ch = P.fitted().store.stores[s.cells[cp.cell][1]].channel_id
        gap = rules[ch].gap
        periods = sorted(p for p, _ in cp.best)
        if cp.best != cp.current:
            assert all(b - a > gap for a, b in zip(periods, periods[1:])), "the channel's gap holds"
        # A festival offer only where that festival ran in the channel.
        for p, code in cp.best:
            if code in fest and (p, code) not in cp.current:
                weeks = r.weeks[cp.period == p]
                ch_cells = [c for c in range(len(s.cells)) if s.cell_channel[c] == s.cell_channel[cp.cell]]
                ran = s.promo[s.slot_of[ch_cells][:, weeks]]
                assert (ran == code).any(), "festival offers never leave their festival"


def test_more_and_fewer_never_earn_less_than_keep():
    keep = P.best(SOUTH_MT, frequency="keep")["replan"]["figures"]["profit"]["value"]
    fewer = P.best(SOUTH_MT, frequency="fewer")["replan"]["figures"]["profit"]["value"]
    more = P.best(SOUTH_MT, frequency="more")["replan"]["figures"]["profit"]["value"]
    today = P.summary(SOUTH_MT)["current"]["profit"]["value"]
    assert today <= keep <= more + 1
    assert today <= fewer


def test_never_promoted_stays_unpromoted():
    rp = P.replan(YEAR, "free", "more")
    m = P.fitted().model
    for cp in rp.cells.values():
        assert m.cell_promoted[cp.cell]


def test_target_takes_the_fewest_product_stores():
    best = P.best(SOUTH_MT)["replan"]
    reach = best["deltas"]["profit"]["percent"]
    goal = round(reach / 2, 2)
    t = P.target(SOUTH_MT, target_pct=goal)
    assert t["replan"]["reachable"]
    gains = sorted((cp.gain for cp in P.replan(SOUTH_MT, "free", "keep").cells.values() if cp.gain > P.EPSILON), reverse=True)
    n = t["replan"]["changed_product_stores"]
    needed = t["needed"]["value"]
    assert sum(gains[:n]) >= needed - 1
    assert sum(gains[: n - 1]) < needed


def test_unreachable_target_reports_the_ceiling():
    t = P.target(SOUTH_MT, target_pct=500)
    assert not t["replan"]["reachable"]
    assert t["replan"]["max_profit_change_pct"] is not None
    assert t["replan"]["blocker"]


def test_focus_keeps_its_weeks():
    rp = P.replan(FOCUS, "free", "keep")
    for cp in rp.cells.values():
        assert [p for p, _ in cp.best] == [p for p, _ in cp.current]


def test_routes(client):
    sel = {"channels": ["CH001"], "month": [2025, 10], "promotion": "PR002"}
    r = client.post("/api/planner/summary", json={"selection": sel})
    assert r.status_code == 200
    assert r.json()["scope"]["promotion"]["id"] == "PR002"
    r = client.post("/api/planner/target", json={"selection": sel, "target_pct": 1})
    assert r.status_code == 200
    r = client.post("/api/planner/whatif", json={"selection": {"promotion": "NOPE"}, "discount_pct": 10})
    assert r.status_code == 422


def test_target_on_net_incremental_profit():
    """The default basis is what the promotions add; the rupees needed are
    X% of that, and the plan's promotion profit moves exactly with its total."""
    t = P.target(SOUTH_MT, target_pct=25, basis="promotion")
    base = t["current"]["promotion_profit"]["value"]
    assert t["basis"] == "promotion"
    assert t["needed"]["value"] == pytest.approx(abs(base) * 0.25, abs=0.02)
    d = t["replan"]["deltas"]
    assert d["promotion_profit"]["absolute"]["value"] == pytest.approx(d["profit"]["absolute"]["value"], abs=0.02)
    total = P.target(SOUTH_MT, target_pct=25, basis="cost")
    assert total["needed"]["value"] > t["needed"]["value"]


def test_target_is_points_of_profit_pct_on_cost():
    """Profit % = (SP - CP) / CP; +X% adds X points with CP held at the
    current plan's, so the profit needed is X% of the current CP."""
    t = P.target(SOUTH_MT, target_pct=2)
    cur = t["current"]
    assert t["basis"] == "cost"
    sp, cp, profit = cur["revenue"]["value"], cur["cost"]["value"], cur["profit"]["value"]
    assert profit == pytest.approx(sp - cp, abs=1)
    assert cur["profit_pct"]["value"] == pytest.approx(profit / cp * 100, abs=0.01)
    assert t["needed"]["value"] == pytest.approx(cp * 0.02, abs=1)
    assert t["goal_profit_pct"]["value"] == pytest.approx(cur["profit_pct"]["value"] + 2, abs=0.01)


def test_change_actions_account_for_every_promotion():
    """Every current promotion of a changed product-store is kept, moved,
    re-priced or dropped -- none disappears unexplained."""
    b = P.best(P.PlanScope.build(channels=["CH001"], start=(2025, 1), end=(2025, 26)))
    for row in b["replan"]["changes"]:
        acted = {a["index"] for a in row["actions"] if a["kind"] in ("moved", "repriced", "dropped")}
        kept = {o["index"] for o in row["current"]} - acted
        best = {(o["index"], o["id"]) for o in row["best"]}
        assert all((o["index"], o["id"]) in best for o in row["current"] if o["index"] in kept)
        moves = [a for a in row["actions"] if a["kind"] == "moved"]
        assert all(a["to_index"] not in {o["index"] for o in row["current"]} for a in moves), \
            "a move never lands on a week the product-store already promotes"


def test_monte_carlo_brackets_the_plan():
    """P10 <= P50 <= P90, the plan's own figure inside; the current plan has
    no range at all."""
    s = P.summary(YEAR)
    assert P.whatif(YEAR, s["lever"]["default"])["band"] is None
    w = P.whatif(YEAR, s["lever"]["default"] + 5)
    band = w["band"]
    assert band["draws"] >= 1000
    for key in ("profit", "revenue", "incremental_sales", "trade_spend"):
        lo, mid, hi = (band[key][q]["value"] for q in ("p10", "p50", "p90"))
        assert lo <= mid <= hi
        assert lo - 1 <= w["scenario"][key]["value"] <= hi + 1
    b = P.best(SOUTH_MT)["replan"]["band"]
    assert 0 <= b["chance_gain_pct"] <= 100


def test_best_discount_is_the_highest_median_profit():
    r = P.resolve(YEAR)
    lever = P._lever(r.fit, r)
    _, points = P._curve_cached(YEAR)
    inside = [pt for pt in points if pt.d <= lever["evidence_max"]]
    best = P.curve(YEAR)["best"]["discount_pct"]
    assert best == max(inside, key=lambda pt: float(np.median(pt.profit))).d


def test_goal_programme():
    """Shortfall first, then the fewest product-stores (gains in rupees;
    anything within a rupee of zero is no change)."""
    picked, short = P._goal_programme([500.0, 150.0, 300.0, 0.0, -200.0], 750.0)
    assert picked == [0, 2] and short == 0
    picked, short = P._goal_programme([500.0, 150.0, 300.0], 2000.0)
    assert sorted(picked) == [0, 1, 2] and short == pytest.approx(1050.0)


def test_uniform_target_is_the_shallowest_depth_by_brent():
    """A target one discount can reach: the depth found by Brent's method is
    the shallowest that reaches it -- half a point shallower falls short."""
    cur = P.summary(YEAR)["current"]
    best = P.curve(YEAR)["best"]
    gain = best["profit"]["value"] - cur["profit"]["value"]
    assert gain > 0
    pct = round(gain / 2 / cur["cost"]["value"] * 100, 4)
    t = P.target(YEAR, target_pct=pct)
    u = t["uniform"]
    assert u["reachable"]
    goal = t["goal_profit"]["value"]
    assert u["figures"]["profit"]["value"] >= goal - 1
    r = P.resolve(YEAR)
    shallower = P._plan_at(r, u["discount_pct"] - 0.5, P._lever(r.fit, r)["max"])
    assert shallower.profit < goal
    assert 0 <= u["chance_reach_pct"] <= 100


def test_weekly_ranges_bracket_the_plan():
    """Each week's P10 - P90 brackets the new plan; at the current discount
    the plan is the current plan, week by week, with no range."""
    s = P.summary(YEAR)
    for wk in P.best(SOUTH_MT)["replan"]["weekly"]:
        assert wk["profit_p10"] - 1 <= wk["profit_plan"] <= wk["profit_p90"] + 1
    for wk in P.whatif(YEAR, s["lever"]["default"])["weekly"]:
        assert wk["profit_plan"] == wk["profit_now"] == wk["profit_p10"] == wk["profit_p90"]

