"""The year-over-year delta under a KPI card -- precision and direction.

WHAT WAS WRONG. The delta was computed from the two ALREADY-ROUNDED KPI
values. PEI is reported as a whole number, so `(62 - 68) / 68` answered a
question about the rounded scores rather than about the promotions: the delta
moved by up to 2.4 percentage points against the same delta taken from the
underlying values. ROI and Margin Impact, reported to two decimals, moved by up
to 0.01.

Cannibalization never had the defect -- `_cannibalization_metric` has always
taken its delta from `overall_exact` -- and the fix is that pattern applied to
the other three through an optional `precision` parameter.

WHAT THESE TESTS GUARD.

  * The CARD VALUES do not move. The parameter defaults to the precision each
    KPI already used, so every existing caller is unaffected.
  * The delta is taken from the unrounded pair.
  * The denominator stays `abs(previous)`, so a KPI that got worse reads as
    worse even when the comparison value is negative.
  * Undefined comparisons stay undefined -- never a fabricated 0%.

Nothing here reimplements a KPI. Every expected value comes from the engine.

Run with:

    ../venv/Scripts/python.exe -m pytest tests/ -q
"""

from __future__ import annotations

import pytest

from app.tpo import aggregate as A
from app.tpo import service
from app.tpo.filters import FilterState, baseline_rows_for, rows_for
from app.tpo.loader import get_store

YEAR = 2025

#: The scope shapes the delta is exercised over. Chosen to span the cases the
#: card actually meets: unfiltered, every filter family, a month, an offer, and
#: the three periods that have no comparison at all.
SCOPES: tuple[tuple[str, dict], ...] = (
    ("no filters", {}),
    ("F25", {"year": YEAR}),
    ("F25+channel", {"year": YEAR, "channel": ["CH002"]}),
    ("F25+channel+retailer", {"year": YEAR, "channel": ["CH002"], "retailer": ["D Mart"]}),
    ("F25+brand", {"year": YEAR, "brand": ["Laundry Detergent"]}),
    ("F25+product", {"year": YEAR, "product": ["P11-250ml"]}),
    ("F25+category", {"year": YEAR, "category": ["Fabric & Home Care"]}),
    ("F25+offer", {"year": YEAR, "promotion": ["PR003"]}),
    ("F25+region", {"year": YEAR, "region": ["South"]}),
    ("F25+month", {"year": YEAR, "month": 10}),
    ("F25+multi", {"year": YEAR, "channel": ["CH002"], "brand": ["Laundry Detergent"], "month": 10}),
    ("F24", {"year": 2024}),
)

#: ROI here fell from one sub-break-even multiple to a lower one. On the old
#: percent scale both were negative -- deterioration that
#: `(current - previous) / previous` would report as a POSITIVE number -- and
#: the fixture is kept so the sign rule stays exercised on real data.
NEGATIVE_PREVIOUS = {"year": YEAR, "channel": ["CH005"], "month": 1}

#: A 2025-only promotion id. `F24 + PBDU25` selects nothing, so there is no
#: comparison to make and none is invented.
SEASONAL_OFFER = {"year": YEAR, "promotion": ["PBDU25"]}

#: KPI card -> (engine call, the precision that card reports at).
EXACT_CALLS = {
    "promotion_roi": (lambda rows, vol, p: A.calculate_roi(rows, vol, precision=p), 2),  # the ROI multiple is 2dp
    "margin_impact": (lambda rows, vol, p: A.calculate_margin(rows, precision=p), 2),
    "pei": (lambda rows, vol, p: A.calculate_pei(rows, vol, precision=p), 0),
}


def _sets(scope: dict):
    state = FilterState.build(**scope)
    return state, rows_for(state), baseline_rows_for(state)


def _cards(scope: dict):
    return service.kpis(FilterState.build(**scope))["kpis"]


# --- 1-2. the precision parameter itself ------------------------------------


@pytest.mark.parametrize("name,scope", SCOPES)
def test_the_default_precision_is_unchanged(name, scope):
    """1. Every existing caller gets exactly what it got before.

    The default is the rounding each function already applied, so a call
    without the parameter is the call that was there before it existed.
    """
    _, rows, vol = _sets(scope)
    assert A.calculate_roi(rows, vol) == A._round(A.calculate_roi(rows, vol, precision=None), 2)
    assert A.calculate_margin(rows) == A._round(A.calculate_margin(rows, precision=None), 2)
    assert A.calculate_pei(rows, vol) == A._round(A.calculate_pei(rows, vol, precision=None), 0)


def test_full_precision_can_be_requested():
    """2. `precision=None` returns the arithmetic unrounded."""
    _, rows, vol = _sets({"year": YEAR, "channel": ["CH002"]})
    for key, (call, digits) in EXACT_CALLS.items():
        exact = call(rows, vol, None)
        assert exact is not None, key
        assert round(exact, digits) == call(rows, vol, digits), key
    # And it is genuinely unrounded -- at least one KPI carries more precision
    # than the card shows, or this test proves nothing.
    assert any(
        call(rows, vol, None) != call(rows, vol, digits)
        for call, digits in EXACT_CALLS.values()
    )


@pytest.mark.parametrize("precision", [0, 1, 2, 3])
def test_an_explicit_precision_rounds_the_result_only(precision):
    """2b. The parameter never reaches inside a formula."""
    _, rows, vol = _sets({"year": YEAR})
    for call, _ in EXACT_CALLS.values():
        assert call(rows, vol, precision) == round(call(rows, vol, None), precision)


# --- 3. the delta reads the unrounded pair ----------------------------------


@pytest.mark.parametrize("name,scope", SCOPES)
def test_the_delta_is_taken_from_full_precision_values(name, scope):
    """3. THE FIX. The reported delta is the one the unrounded pair gives."""
    state = FilterState.build(**scope)
    previous = state.comparison(get_store())
    cards = _cards(scope)
    if previous is None:
        for key in EXACT_CALLS:
            assert cards[key]["delta"] is None
        return

    _, rows, vol = _sets(scope)
    prev_rows, prev_vol = rows_for(previous), baseline_rows_for(previous)
    for key, (call, _) in EXACT_CALLS.items():
        current_exact = call(rows, vol, None)
        previous_exact = call(prev_rows, prev_vol, None)
        if current_exact is None or not previous_exact:
            assert cards[key]["delta"] is None, key
            continue
        expected = round((current_exact - previous_exact) / abs(previous_exact) * 100, 2)
        assert cards[key]["delta"] == expected, f"{name}/{key}"


def test_the_matrix_contains_deltas_the_old_rounding_got_wrong():
    """3c. The defect was real: over the matrix, the rounded pair disagrees
    with the unrounded one on several KPIs."""
    store = get_store()
    disagreements = []
    for name, scope in SCOPES:
        state = FilterState.build(**scope)
        previous = state.comparison(store)
        if previous is None:
            continue
        _, rows, vol = _sets(scope)
        prev_rows, prev_vol = rows_for(previous), baseline_rows_for(previous)
        for key, (call, digits) in EXACT_CALLS.items():
            exact_now, exact_prev = call(rows, vol, None), call(prev_rows, prev_vol, None)
            round_now, round_prev = call(rows, vol, digits), call(prev_rows, prev_vol, digits)
            if None in (exact_now, exact_prev) or not exact_prev or not round_prev:
                continue
            old = round((round_now - round_prev) / abs(round_prev) * 100, 2)
            new = round((exact_now - exact_prev) / abs(exact_prev) * 100, 2)
            if old != new:
                disagreements.append((name, key, old, new))
    assert disagreements, "no scope in the matrix exercises the fix"
    assert any(key == "pei" for _, key, _, _ in disagreements), (
        "PEI rounds to a whole number and must be among them"
    )


# --- 4-5. the denominator, and direction on negative comparisons ------------


def test_the_denominator_is_the_absolute_previous_value():
    """4. Growth is a MOVEMENT, so its sign is the direction of travel.

    Dividing by a signed negative flips it, and a KPI that got worse would
    render with an up arrow in the favourable colour.
    """
    assert A.calculate_growth(-44.5, -40.1).growth == pytest.approx(-11.0, abs=0.05)
    assert A.calculate_growth(-30.0, -40.0).growth == pytest.approx(25.0, abs=0.05)
    assert A.calculate_growth(10.0, -40.0).growth == pytest.approx(125.0, abs=0.05)


def test_a_deteriorating_negative_kpi_reads_as_a_decline():
    """5. On real data, and through the card."""
    card = _cards(NEGATIVE_PREVIOUS)["promotion_roi"]
    assert card["previous_value"] is not None and card["previous_value"] < 1, "below break-even"
    # Two multiples close enough to print alike still carry their movement:
    # it is taken from the unrounded pair -- see `_precise` -- so the growth
    # and the arrow show the deterioration whatever the display rounding.
    assert card["value"] <= card["previous_value"], "the fixture must be a deterioration"
    assert card["delta"] < 0, "a worse ROI must not report positive growth"
    assert card["trend"] == "down"
    assert not card["delta_display"].startswith("+")


# --- 6-8. undefined comparisons ---------------------------------------------


def test_a_zero_previous_value_produces_no_delta():
    """6. Never a fabricated 0%, which would read as "no change"."""
    assert A.calculate_growth(5.0, 0).growth is None
    assert A.calculate_growth(5.0, 0.0).difference is None


def test_a_null_previous_value_produces_no_delta():
    """7."""
    assert A.calculate_growth(5.0, None).growth is None
    assert A.calculate_growth(None, 5.0).growth is None


def test_a_season_only_offer_reports_no_comparison():
    """8. `F24 + PBDU25` selects nothing, so there is nothing to compare with.

    No promotion-id is mapped across years to manufacture one.
    """
    state = FilterState.build(**SEASONAL_OFFER)
    previous = state.comparison(get_store())
    assert previous is not None, "F24 exists; it is the OFFER that does not"
    assert not rows_for(previous), "the fixture must select no comparison rows"

    for key, card in _cards(SEASONAL_OFFER).items():
        assert card["delta"] is None, key
        assert card["previous_value"] is None, key
        assert card["delta_display"] == "—", key
        assert card["delta_sub"] == "vs F24", key


@pytest.mark.parametrize("name,scope", [("F24", {"year": 2024}), ("all years", {})])
def test_a_period_with_no_predecessor_reports_no_delta(name, scope):
    """8b. F24 has no F23 loaded, and All Years has no defined comparison."""
    assert FilterState.build(**scope).comparison(get_store()) is None
    for key, card in _cards(scope).items():
        assert card["delta"] is None, key
        assert card["delta_display"] == "—", key


# --- 9. the values themselves -----------------------------------------------


@pytest.mark.parametrize("name,scope", SCOPES)
def test_the_card_values_are_the_engines_own_rounded_values(name, scope):
    """9. THE REGRESSION GATE. Changing how a delta is computed must not move
    a single figure on a card."""
    _, rows, vol = _sets(scope)
    cards = _cards(scope)
    assert cards["trade_spend"]["value"] == A.calculate_trade_spend(rows)
    assert cards["incremental_sales"]["value"] == A.calculate_incremental_sales(vol)
    assert cards["promotion_roi"]["value"] == A.calculate_roi(rows, vol)
    assert cards["margin_impact"]["value"] == A.calculate_margin(rows)
    assert cards["pei"]["value"] == A.calculate_pei(rows, vol)


@pytest.mark.parametrize("name,scope", SCOPES)
def test_trade_spend_and_incremental_sales_deltas_are_untouched(name, scope):
    """9b. Both are rounded to 2dp on figures in the hundreds of millions, so
    their reported delta was already the full-precision one and stays on the
    generic path."""
    state = FilterState.build(**scope)
    previous = state.comparison(get_store())
    cards = _cards(scope)
    if previous is None:
        assert cards["trade_spend"]["delta"] is None
        return
    _, rows, vol = _sets(scope)
    prev_rows, prev_vol = rows_for(previous), baseline_rows_for(previous)
    for key, current, prior in (
        ("trade_spend", A.calculate_trade_spend(rows), A.calculate_trade_spend(prev_rows)),
        ("incremental_sales", A.calculate_incremental_sales(vol), A.calculate_incremental_sales(prev_vol)),
    ):
        expected = A.calculate_growth(current, prior).growth
        assert cards[key]["delta"] == expected, f"{name}/{key}"


def test_cannibalization_keeps_its_own_precise_metric():
    """9c. The precedent is untouched -- still `overall_exact`, still its own
    metric builder."""
    import inspect

    source = inspect.getsource(A._cannibalization_metric)
    assert "overall_exact" in source
    assert A._cannibalization_metric is not A._precise
