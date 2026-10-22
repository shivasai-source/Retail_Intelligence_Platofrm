"""The Analyst driving the Insights Hub: period, filters, charts, cards, undo.

WHAT MATTERS HERE is not that a tool returns a dict — it is that a tool which
CANNOT do what was asked says so, loudly, instead of returning something
harmless-looking. The failure this guards against is the model saying "I've set
the period to 2019" over a page still showing 2025: a confident sentence with
no change behind it is worse than an error message, because nothing on screen
contradicts it.

So every refusal path is pinned, and so is the mirror: the ids in the tool
schema come from `app/agents/hub_layout.py`, the page's own list lives in
`frontend/src/components/command/hubPanels.ts`, and a test that reads both is
the only thing that makes two copies of a list safe.
"""

from __future__ import annotations

import asyncio
import re
from pathlib import Path

import pytest

from app.agents import analyst, hub_layout, hub_scope

REPO = Path(__file__).resolve().parents[2]
PANELS_TS = REPO / "frontend" / "src" / "components" / "command" / "hubPanels.ts"
KPI_DECK_TS = REPO / "frontend" / "src" / "components" / "command" / "kpiDeckState.ts"


# --- the mirror ---------------------------------------------------------------


def _array_body(source: str, declaration: str) -> str:
    """The text between `= [` and its closing `]`.

    Cutting at the FIRST `]` would stop inside the type annotation —
    `HUB_PANELS: HubPanel[] = [` — and read an empty list, which is a test
    that passes by finding nothing. So the search starts after `= [`.
    """
    start = source.index(declaration)
    open_at = source.index("= [", start) + len("= [")
    return source[open_at : source.index("]", open_at)]


def _ts_panel_ids() -> list[str]:
    """The ids in HUB_PANELS, in order, read out of the page's own module."""
    body = _array_body(PANELS_TS.read_text(encoding="utf-8"), "export const HUB_PANELS")
    return re.findall(r"id:\s*'([a-z_]+)'", body)


def _ts_card_keys() -> list[str]:
    body = _array_body(KPI_DECK_TS.read_text(encoding="utf-8"), "export const ADDABLE_KPI_ORDER")
    return re.findall(r"'([a-z_]+)'", body)


def test_the_mirror_reader_actually_reads_something():
    """A parser that silently found nothing would make the two tests below
    pass while the lists drifted — which is the only way a mirror test is
    worse than no test."""
    assert len(_ts_panel_ids()) == 9
    assert len(_ts_card_keys()) == 6


def test_the_chart_ids_match_the_page():
    assert list(hub_layout.PANEL_IDS) == _ts_panel_ids(), (
        "app/agents/hub_layout.py and frontend hubPanels.ts have drifted; the Analyst "
        "would offer a chart the page does not have, or miss one it does."
    )


def test_the_card_keys_match_the_page():
    assert list(hub_layout.CARD_IDS) == _ts_card_keys()


def test_every_panel_is_described_for_the_model():
    for panel in hub_layout.PANELS:
        assert panel.label and panel.about, panel.id
    catalogue = hub_layout.panel_catalogue()
    for panel in hub_layout.PANELS:
        assert panel.id in catalogue and panel.label in catalogue


def test_the_tools_are_offered_to_the_model():
    names = {t["function"]["name"] for t in analyst.TOOLS}
    assert {"set_period", "set_filter", "set_layout", "undo"} <= names


def test_the_layout_tool_can_only_name_real_charts():
    schema = next(
        t["function"]["parameters"] for t in analyst.TOOLS if t["function"]["name"] == "set_layout"
    )
    for field in ("show_charts", "hide_charts"):
        assert schema["properties"][field]["items"]["enum"] == list(hub_layout.PANEL_IDS)
    for field in ("show_cards", "hide_cards"):
        assert schema["properties"][field]["items"]["enum"] == list(hub_layout.CARD_IDS)


def test_the_filter_tool_can_only_name_real_dimensions():
    schema = next(
        t["function"]["parameters"] for t in analyst.TOOLS if t["function"]["name"] == "set_filter"
    )
    assert schema["properties"]["dimension"]["enum"] == list(hub_scope.FILTER_KEYS)


# --- the period --------------------------------------------------------------


def test_a_year_becomes_the_pages_year_field():
    action = hub_scope.period_action(year=2024)
    assert action["kind"] == "period"
    # A whole year is `year`, not a week range: everything on the page keyed on
    # a year reads that field.
    assert action["year"] == 2024
    assert action["period_from"] is None and action["period_to"] is None
    assert action["summary"] == "set the period to 2024"


def test_a_month_needs_its_year():
    with pytest.raises(hub_scope.ScopeError) as caught:
        hub_scope.period_action(month="March")
    assert "Which year" in str(caught.value)


def test_a_month_name_is_read():
    action = hub_scope.period_action(year=2025, month="March")
    assert (action["year"], action["month"]) == (2025, 3)
    assert action["summary"] == "set the period to March 2025"


@pytest.mark.parametrize("month", ["Mar", "march", "3", 3])
def test_a_month_in_any_spelling(month):
    assert hub_scope.period_action(year=2025, month=month)["month"] == 3


def test_a_year_the_data_does_not_have_is_refused_with_the_ones_it_does():
    with pytest.raises(hub_scope.ScopeError) as caught:
        hub_scope.period_action(year=1999)
    message = str(caught.value)
    assert "1999" in message and "2024" in message


def test_all_data_clears_every_period_field():
    action = hub_scope.period_action(all_data=True)
    assert action["year"] is None and action["month"] is None
    assert action["period_from"] is None and action["period_to"] is None


def test_all_data_and_a_year_together_is_a_mistake():
    with pytest.raises(hub_scope.ScopeError):
        hub_scope.period_action(year=2024, all_data=True)


def test_a_week_range_is_two_business_weeks():
    action = hub_scope.period_action(week_from=202411, week_to=202420)
    assert (action["period_from"], action["period_to"]) == (202411, 202420)
    assert action["year"] is None, "a custom range is not a year"
    assert "weeks 11–20 of 2024" in action["summary"]


def test_a_backwards_range_is_put_the_right_way_round():
    action = hub_scope.period_action(week_from=202420, week_to=202411)
    assert (action["period_from"], action["period_to"]) == (202411, 202420)


def test_half_a_range_is_refused():
    with pytest.raises(hub_scope.ScopeError) as caught:
        hub_scope.period_action(week_from=202411)
    assert "both ends" in str(caught.value)


@pytest.mark.parametrize("bad", [11, 2024, 202499])
def test_a_week_that_is_not_yyyyww_is_refused(bad):
    with pytest.raises(hub_scope.ScopeError):
        hub_scope.period_action(week_from=bad, week_to=bad)


def test_nothing_at_all_is_refused():
    with pytest.raises(hub_scope.ScopeError) as caught:
        hub_scope.period_action()
    assert "year" in str(caught.value)


# --- the filters -------------------------------------------------------------


def test_a_filter_resolves_a_real_value():
    action = hub_scope.filter_action("region", ["North"])
    assert action["dimension"] == "region" and action["values"] == ["North"]


def test_a_display_name_becomes_the_code_the_page_sends():
    """A reader says "Modern Trade"; the page filters on a channel code."""
    action = hub_scope.filter_action("channel", ["Modern Trade"])
    assert action["values"] and action["values"][0].startswith("CH")


def test_a_value_the_data_does_not_have_is_refused_with_suggestions():
    with pytest.raises(hub_scope.ScopeError) as caught:
        hub_scope.filter_action("region", ["Atlantis"])
    message = str(caught.value)
    assert "Atlantis" in message and "North" in message


def test_a_dimension_the_bar_does_not_have_is_refused():
    with pytest.raises(hub_scope.ScopeError) as caught:
        hub_scope.filter_action("country", ["India"])
    assert "no 'country' filter" in str(caught.value)


def test_a_single_select_dimension_refuses_two_values():
    """The page's region pill holds one value; silently dropping the second
    would scope the dashboard to something nobody asked for."""
    with pytest.raises(hub_scope.ScopeError) as caught:
        hub_scope.filter_action("region", ["North", "South"])
    assert "one value at a time" in str(caught.value)


def test_a_multi_select_dimension_takes_several():
    options = hub_scope._options("channel")
    action = hub_scope.filter_action("channel", options[:2])
    assert len(action["values"]) == 2


def test_clearing_one_dimension_and_clearing_everything_are_different():
    one = hub_scope.filter_action("region", clear=True)
    assert one["dimension"] == "region" and one["values"] == [] and one["clear_all"] is False
    every = hub_scope.filter_action("", clear_all=True)
    assert every["clear_all"] is True


def test_a_filter_with_no_values_and_no_clear_is_refused():
    with pytest.raises(hub_scope.ScopeError):
        hub_scope.filter_action("region", [])


# --- the layout --------------------------------------------------------------


def test_a_swap_is_one_action():
    action = hub_layout.layout_action(hide_charts=["mix"], show_charts=["product"])
    assert action["hide_charts"] == ["mix"] and action["show_charts"] == ["product"]
    assert "removed Promotion Mix" in action["summary"]
    assert "added Product Performance" in action["summary"]


def test_a_chart_that_does_not_exist_is_refused_with_the_ones_that_do():
    with pytest.raises(ValueError) as caught:
        hub_layout.layout_action(hide_charts=["sales_by_country"])
    message = str(caught.value)
    assert "sales_by_country" in message and "trend" in message


def test_a_headline_card_cannot_be_removed():
    """Spend, return and ROI are what the page IS; the model is told so rather
    than left to report a removal that never happened."""
    with pytest.raises(ValueError) as caught:
        hub_layout.layout_action(hide_cards=["promotion_roi"])
    assert "headline" in str(caught.value)


def test_showing_and_hiding_the_same_thing_is_refused():
    with pytest.raises(ValueError) as caught:
        hub_layout.layout_action(show_charts=["mix"], hide_charts=["mix"])
    assert "both show and hide" in str(caught.value)


def test_an_empty_layout_call_is_refused():
    with pytest.raises(ValueError):
        hub_layout.layout_action()


def test_a_reset_says_what_it_does():
    action = hub_layout.layout_action(reset=True)
    assert action["reset"] is True
    assert "default" in action["summary"]


def test_cards_are_named_as_the_page_names_them():
    action = hub_layout.layout_action(show_cards=["volume_uplift"])
    assert "Volume Uplift" in action["summary"]


# --- the dispatch ------------------------------------------------------------


def test_the_tools_return_an_action_and_compute_nothing():
    for name, args in (
        ("set_period", {"year": 2024}),
        ("set_filter", {"dimension": "region", "values": ["North"]}),
        ("set_layout", {"hide_charts": ["mix"]}),
        ("undo", {}),
    ):
        result = analyst._run_tool(name, args, "INR")
        assert set(result) == {"action"}, name
        assert result["action"]["summary"], name
        # Not a figure in sight: these move the page, they do not answer.
        assert "kpis" not in result and "groups" not in result


def test_undo_is_the_browsers_job():
    """The server holds no page state, so undo is a described intent and
    nothing more — the stack lives in store/hubLayout.ts."""
    assert analyst._run_tool("undo", {}, "INR")["action"] == {
        "kind": "undo",
        "summary": "undid the last change",
    }


def test_a_refusal_reaches_the_model_rather_than_the_reader():
    """`answer` turns a tool exception into a tool RESULT the model must read,
    so it can relay the real reason instead of claiming success."""
    source = Path(analyst.__file__).read_text(encoding="utf-8")
    assert 'result = {"error": f"{type(e).__name__}: {e}"}' in source


def test_the_prompt_tells_it_not_to_claim_a_refused_change():
    prompt = analyst._system_prompt("INR")
    assert "the page did NOT change" in prompt
    assert "never claim a change you were refused" in prompt

# --- "undo that" never reaches the model -------------------------------------


@pytest.mark.parametrize("text", [
    "undo", "Undo.", "undo that", "revert that", "put it back", "Put that back!",
    "go back", "never mind", "please undo", "Can you revert the last change?",
])
def test_an_undo_is_recognised_without_a_model(text):
    assert analyst.is_undo_request(text)


@pytest.mark.parametrize("text", [
    "undo the discount and tell me what ROI was",
    "what does undo mean",
    "why did you revert that",
    "show me 2024",
    "revert the spend to last year and compare",
])
def test_only_a_bare_undo_is_intercepted(text):
    """A message that is an undo AND something else still needs the model."""
    assert not analyst.is_undo_request(text)


def test_an_undo_turn_calls_no_model_and_returns_the_action(monkeypatch):
    """The failure this exists for: asked to undo, the model answered 'the
    chart is back on the dashboard' and called nothing, so the chart stayed
    off and the sentence was false. Nothing is asked now.

    Run with asyncio.run rather than an async test: the suite carries no
    async plugin, and one test is not a reason to add a dependency.
    """
    async def forbidden(*args, **kwargs):  # pragma: no cover - must not run
        raise AssertionError("an undo reached the model")

    monkeypatch.setattr(analyst, "chat_completion", forbidden)
    monkeypatch.setattr(analyst, "get_client", lambda: None)
    result = asyncio.run(analyst.answer("undo that"))
    assert result["actions"] == [{"kind": "undo", "summary": "undid the last change"}]
    assert result["steps"] == [] and result["charts"] == []


def test_the_prompt_forbids_claiming_an_uncalled_change():
    prompt = analyst._system_prompt("INR")
    assert "IF YOU CALLED NOTHING, YOU CHANGED NOTHING" in prompt
