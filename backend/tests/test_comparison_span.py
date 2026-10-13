"""A part year is compared like for like.

The data stops in late August 2026. Comparing those eight months with the
whole of 2025 reported a fall of about a third on every card -- not a
decline, just four missing months. The comparison year is read over the same
business weeks the current year reaches; a complete year is compared whole.

Usage:  ../venv/Scripts/python.exe -m pytest tests/test_comparison_span.py -q
"""

from __future__ import annotations

import pytest

from app.tpo import aggregate as A
from app.tpo import service
from app.tpo.filters import FilterState, rows_for
from app.tpo.loader import get_store


@pytest.fixture(scope="module")
def store():
    return get_store()


def test_a_part_year_is_compared_with_the_same_weeks(store):
    reached = store.last_week(2026)
    assert reached is not None and reached < store.last_week(2025), "2026 is a part year"
    previous = FilterState.build(year=2026).comparison(store)
    assert previous.year == 2025 and previous.through_week == reached
    assert max(r.week_key for r in rows_for(previous)) <= f"2025-W{reached:02d}"

    card = service.kpis(FilterState.build(year=2026))["kpis"]["trade_spend"]
    assert card["previous_value"] == A.calculate_trade_spend(rows_for(previous))
    assert card["delta_sub"].startswith("vs Jan–")


def test_a_complete_year_is_compared_whole(store):
    previous = FilterState.build(year=2025).comparison(store)
    assert previous.year == 2024 and previous.through_week is None
    card = service.kpis(FilterState.build(year=2025))["kpis"]["trade_spend"]
    assert card["delta_sub"] == "vs F24"


def test_other_filters_carry_across_with_the_span(store):
    previous = FilterState.build(year=2026, channel=["CH002"]).comparison(store)
    assert previous.channel == frozenset({"CH002"})
    assert previous.through_week == store.last_week(2026)
