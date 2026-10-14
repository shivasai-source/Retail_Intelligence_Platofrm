"""The Insights Hub's Period calendar: a business-week range on FilterState.

A custom period admits exactly the weeks it names, is compared with the same
weeks one year earlier, and is labelled by its real dates.
"""

from app.reports.service import to_state as scope_to_state
from app.tpo import service
from app.tpo.filters import FilterState, business_calendar, options_for, rows_for
from app.tpo.loader import get_store


def test_period_admits_only_its_weeks():
    rows = rows_for(FilterState.build(period_from=202611, period_to=202623))
    assert rows
    assert all(202611 <= int(r.week_key[:4]) * 100 + int(r.week_key[-2:]) <= 202623 for r in rows)


def test_whole_year_period_matches_the_year_filter():
    weeks = [w["week"] for y in business_calendar(get_store()) if y["year"] == 2025 for w in y["weeks"]]
    by_period = rows_for(FilterState.build(period_from=202500 + weeks[0], period_to=202500 + weeks[-1]))
    by_year = rows_for(FilterState.build(year=2025))
    assert len(by_period) == len(by_year)


def test_reversed_ends_are_swapped():
    assert FilterState.build(period_from=202623, period_to=202611) == FilterState.build(period_from=202611, period_to=202623)


def test_comparison_is_the_same_weeks_a_year_earlier():
    store = get_store()
    previous = FilterState.build(period_from=202611, period_to=202623, channel=["CH001"]).comparison(store)
    assert (previous.period_from, previous.period_to) == (202511, 202523)
    assert previous.channel == frozenset({"CH001"})
    # The earliest year has nothing before it.
    first = min(store.years())
    assert FilterState.build(period_from=first * 100 + 2, period_to=first * 100 + 5).comparison(store) is None


def test_kpis_label_the_period_and_its_comparison_by_date():
    payload = service.kpis(FilterState.build(period_from=202611, period_to=202623), "INR")
    assert payload["meta"]["period"].endswith("2026")
    assert payload["meta"]["comparison_period"].endswith("2025")


def test_options_carry_the_calendar_and_respect_the_period():
    options = options_for(FilterState.build(period_from=202611, period_to=202623))
    assert options["calendar"] and options["calendar"][0]["weeks"][0]["start"]
    assert options["years"] == [2026]


def test_report_scope_accepts_the_period():
    state = scope_to_state({"period_from": 202611, "period_to": 202623, "channel": ["CH001"]})
    assert (state.period_from, state.period_to) == (202611, 202623)
