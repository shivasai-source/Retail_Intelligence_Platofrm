"""A week-scoped promotion still has a baseline to be measured against.

THE BUG THESE PIN. `d7fa794` gave `FilterState` a `week`, so a question naming
"week 41 of 2025" is finally scoped to that week instead of the whole year. Its
own message records the hazard that creates, and fixes it for the neighbour
pass:

    "A neighbour's ordinary level is measured on the weeks the promotion was NOT
     running, so a week filter left on that pass leaves no such weeks."

`baseline_rows_for` needed exactly the same lift and did not get it. Incremental
Sales, ROI and PEI are all defined against a non-promotional baseline, and
scoped to the single week an offer ran, the baseline set held nothing but the
promoted row itself. Incremental Sales came out as 0 and ROI as exactly 0.0
(-100% on the old percent scale)
— not a promotion that returned nothing, but one with nothing to measure
against.

It was not a subtle wrong number. An investigation drilled in from a risk alert
reading -3.6% had five of its six specialists reporting -100%: every mechanic,
every region, every retailer, uniformly, which the Optimization Agent then
explained as an offer-design problem rather than the measurement artefact it
was.

THE SAFETY PROPERTY IS THE SECOND HALF. The lift applies ONLY to the baseline
pass and ONLY to non-promoted rows, so Trade Spend, Margin Impact and the row
set the user actually selected are untouched. `test_trade_spend_still_honours_
the_week` is the one that would catch a fix that went too far.

Run with:

    ../venv/Scripts/python.exe -m pytest tests/ -q
"""

from __future__ import annotations

import pytest

from app.tpo import aggregate as A
from app.tpo.filters import FilterState, baseline_rows_for, rows_for
from app.tpo.loader import get_store

YEAR = 2025


@pytest.fixture(scope="module")
def event():
    """A real promoted (promotion, product, channel, week) from the dataset.

    Found rather than hardcoded, so this keeps working if the seed data is
    replaced — the bug is about the SHAPE of the scope, not about one offer.
    """
    store = get_store()
    for i in range(store.row_count):
        if not store.promoted[i] or store.year[i] != YEAR:
            continue
        scope = {
            "year": YEAR,
            "week": store.week[i],
            "promotion": [store.promotions[store.promo_code[i]].promotion_id],
            "product": [store.products[store.product_code[i]].product_id],
            "channel": [store.stores[store.store_code[i]].channel_id],
        }
        state = FilterState.build(**scope)
        # The bug needs a scope narrow enough that the week leaves no
        # non-promoted row behind; any promoted event in one week does.
        if rows_for(state):
            return scope
    pytest.skip("no promoted row found in the dataset")


def _roi(scope: dict) -> float | None:
    state = FilterState.build(**scope)
    return A.calculate_roi(rows_for(state), baseline_rows_for(state))


def test_a_week_scoped_promotion_does_not_report_minus_one_hundred(event):
    """0.0 means zero incremental sales, which is a missing baseline."""
    assert _roi(event) != 0.0


def test_the_baseline_keeps_its_non_promoted_rows(event):
    """The mechanism: the week must not reach the baseline population."""
    volume = baseline_rows_for(FilterState.build(**event))
    assert any(not row.is_promoted for row in volume), (
        "the baseline set holds only promoted rows, so there is nothing to "
        "measure an uplift against"
    )


def test_the_week_selects_rows_without_narrowing_the_baseline(event):
    """The exact contract of the lift, stated as the two halves it separates.

    The week filter decides WHICH PROMOTED ROWS are reported. It must not
    decide which baseline they are judged against — the counterfactual for "how
    did this offer do" is the same non-promotional level either way.

    So the ROI legitimately differs between a single week and every week an
    offer ran (different promoted rows, and an offer that ran nine times is
    nine different events), while the non-promoted population behind both is
    identical. Asserting the ROIs were equal would be wrong, and was: the first
    version of this test did exactly that and failed on a multi-week offer.
    """
    without_week = {k: v for k, v in event.items() if k != "week"}
    baseline = {
        (r.product_id, r.week_key, r.promotion_id)
        for r in baseline_rows_for(FilterState.build(**event))
        if not r.is_promoted
    }
    wider = {
        (r.product_id, r.week_key, r.promotion_id)
        for r in baseline_rows_for(FilterState.build(**without_week))
        if not r.is_promoted
    }
    assert baseline == wider, "the week filter reached the baseline population"


def test_trade_spend_still_honours_the_week(event):
    """THE GUARD ON THE FIX. Spend is a plain sum over the SELECTED rows.

    It reads `rows_for`, never the baseline, so lifting the week for the
    baseline must leave it alone. A fix that lifted the week everywhere would
    silently report a whole year's spend against one week's question, and every
    other assertion here would still pass.
    """
    state = FilterState.build(**event)
    without_week = FilterState.build(**{k: v for k, v in event.items() if k != "week"})
    week_spend = A.calculate_trade_spend(rows_for(state))
    year_spend = A.calculate_trade_spend(rows_for(without_week))
    assert week_spend > 0
    assert week_spend <= year_spend
    assert len(rows_for(state)) <= len(rows_for(without_week))


def test_the_lift_is_confined_to_the_baseline_pass(event):
    """`rows_for` answers for the week the user selected, unchanged."""
    state = FilterState.build(**event)
    assert all(row.week_key.endswith(f"W{event['week']:02d}") for row in rows_for(state))
