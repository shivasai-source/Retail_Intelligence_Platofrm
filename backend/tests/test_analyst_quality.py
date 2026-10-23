"""The four things the Analyst was getting wrong, each pinned by a test.

Every one of these was reported from the running product, reproduced against
the real model, and fixed. They are in their own file rather than appended to
`test_analyst_actions.py` because they are about the ANSWER — how a question is
read and what comes back — rather than about driving the page.

  1. A MONTH WAS READ AS A YEAR TO DATE. "What was our trade spend in august
     2026?" was answered with the whole of 2026 — which the engine labels
     "Jan–Aug 2026" for a part year, so eight months of spend appeared under a
     question about one. A second run refused outright: "The data does not
     cover August 2026. It only includes the years 2024, 2025, and 2026",
     which lists the very year it had just denied.

  2. ORDINARY QUESTIONS WERE REFUSED. "What is 2+2" got "I can't perform that
     calculation. My focus is on trade-promotion performance data."

  3. A CHART WAS RESTATED UNDERNEATH ITSELF. Every label and figure already on
     screen, repeated as a bullet list, doubling the height of the answer.

  4. A CHART COULD ONLY BE DRAWN IN THE CHAT. "Add a chart of ROI by region to
     the dashboard" drew one in the conversation, where it vanishes with the
     thread.
"""

from __future__ import annotations

import pytest

from pathlib import Path

from app.agents import analyst, hub_layout, hub_scope

RUPEE = "₹"


# --- 1. a month is a month ---------------------------------------------------


@pytest.mark.parametrize("text,expected", [
    ("what was our trade spend in august 2026?", {"year": 2026, "month": 8}),
    ("show me aug 2026", {"year": 2026, "month": 8}),
    ("2026 August please", {"year": 2026, "month": 8}),
    ("roi in March of 2025", {"year": 2025, "month": 3}),
    ("DECEMBER 2024", {"year": 2024, "month": 12}),
])
def test_a_month_and_year_are_read_out_of_the_question(text, expected):
    assert analyst.period_named_in(text) == expected


@pytest.mark.parametrize("text", [
    "what about march?",                      # which year?
    "compare august 2026 with august 2025",   # two periods; the model scopes each
    "what was our trade spend in 2026?",      # a year, which is already right
    "how did we do last year",
    "",
])
def test_an_ambiguous_period_is_left_to_the_model(text):
    assert analyst.period_named_in(text) is None


def test_the_hint_states_the_filter_and_says_it_is_not_the_year():
    hint = analyst.period_hint("trade spend in august 2026")
    assert '"year": 2026, "month": 8' in hint
    assert "not the year to date" in hint


def test_no_hint_when_no_month_is_named():
    assert analyst.period_hint("what was our trade spend in 2026?") is None


def test_the_schema_says_a_month_is_one_month():
    month = analyst._FILTER_SCHEMA["properties"]["month"]["description"]
    assert "that month ALONE" in month
    assert "not January to August" in month


def test_the_grounding_covers_months():
    prompt = analyst._system_prompt("INR")
    assert "EVERY ONE OF THOSE YEARS HOLDS MONTHS" in prompt
    assert "never say the data does not cover a month of a year" in prompt


# --- 2. ordinary questions ---------------------------------------------------


def test_the_prompt_allows_arithmetic_and_definitions():
    prompt = analyst._system_prompt("INR")
    assert "PLAIN ARITHMETIC AND UNIT CONVERSION you simply do" in prompt
    assert '"What is 2+2" is 4' in prompt


def test_the_line_is_still_drawn_at_figures_about_this_business():
    prompt = analyst._system_prompt("INR")
    assert "the moment an answer needs a number about" in prompt
    assert "THE ONE RULE" in prompt


# --- 3. a chart is not restated underneath it --------------------------------


CHART = [{"points": [
    {"label": "General Trade", "value": 1225500000, "display": f"{RUPEE}122.55 Cr"},
    {"label": "B2B", "value": 177400000, "display": f"{RUPEE}17.74 Cr"},
    {"label": "Modern Trade", "value": 172500000, "display": f"{RUPEE}17.25 Cr"},
    {"label": "E-commerce", "value": 141200000, "display": f"{RUPEE}14.12 Cr"},
]}]


def test_a_bullet_restatement_is_removed_and_replaced_by_a_sentence():
    """What the model actually writes is a bullet list, not a table — which is
    why the first version of this guard, which looked for a '|', never fired."""
    text = "\n".join([
        "Here's the chart showing trade spend by channel:",
        "",
        f"- **General Trade**: {RUPEE}122.55 Cr",
        f"- **B2B**: {RUPEE}17.74 Cr",
        f"- **Modern Trade**: {RUPEE}17.25 Cr",
        f"- **E-commerce**: {RUPEE}14.12 Cr",
    ])
    out = analyst.strip_duplicate_table(text, CHART)
    assert "- **B2B**" not in out
    assert out == f"General Trade leads at {RUPEE}122.55 Cr."


def test_a_table_restatement_is_removed():
    text = "\n".join([
        "Here's the chart:",
        "",
        "| Channel | Spend |",
        "| --- | --- |",
        "| General Trade | 122 |",
        "| B2B | 17 |",
        "| Modern Trade | 17 |",
    ])
    assert "|" not in analyst.strip_duplicate_table(text, CHART)


def test_the_sentence_that_says_something_survives():
    text = "\n".join([
        "Spend is concentrated:",
        "",
        f"- **General Trade**: {RUPEE}122.55 Cr",
        f"- **B2B**: {RUPEE}17.74 Cr",
        f"- **Modern Trade**: {RUPEE}17.25 Cr",
        "",
        "General Trade is three quarters of the total.",
    ])
    assert analyst.strip_duplicate_table(text, CHART) == "General Trade is three quarters of the total."


def test_a_list_about_something_else_is_kept():
    """The point is to delete duplication, not lists."""
    text = "Two things stand out:\n\n- Spend grew 6% year on year\n- ROI slipped slightly"
    assert analyst.strip_duplicate_table(text, CHART) == text


def test_nothing_is_stripped_when_no_chart_was_drawn():
    text = f"- **General Trade**: {RUPEE}122.55 Cr\n- **B2B**: {RUPEE}17.74 Cr"
    assert analyst.strip_duplicate_table(text, []) == text


def test_the_fallback_sentence_comes_from_the_chart_itself():
    """So it cannot disagree with what is drawn."""
    assert analyst._leader_sentence(CHART) == f"General Trade leads at {RUPEE}122.55 Cr."
    assert analyst._leader_sentence([]) == ""


# --- 4. a chart on the dashboard ---------------------------------------------


def test_pinning_describes_a_shape_not_a_picture():
    """The browser redraws it from the Hub's own filters, so what travels is
    the shape. Pinning a computed picture would leave a chart that disagreed
    with every card around it the moment the period changed."""
    action = analyst._run_tool(
        "pin_chart", {"by": "region", "metric": "roi", "chart_type": "column"}, "INR"
    )["action"]
    assert action["kind"] == "pin_chart"
    assert (action["by"], action["metric"], action["chart_type"]) == ("region", "roi", "column")
    assert "points" not in action and "values" not in action


def test_a_pinned_chart_is_titled_in_the_products_own_words():
    title = analyst._run_tool("pin_chart", {"by": "channel", "metric": "roi"}, "INR")["action"]["title"]
    assert title == "ROI by Channel", "`.title()` alone spells the product's own metric 'Roi'"


@pytest.mark.parametrize("args,expected", [
    ({"by": "country"}, "Cannot group by country"),
    ({"by": "channel", "chart_type": "scatter"}, "A dashboard chart can be"),
    ({"by": "channel", "metric": "vibes"}, "Cannot measure vibes"),
])
def test_a_chart_the_hub_cannot_draw_is_refused(args, expected):
    with pytest.raises(ValueError) as caught:
        analyst._run_tool("pin_chart", args, "INR")
    assert expected in str(caught.value)


def test_the_prompt_separates_a_chat_chart_from_a_dashboard_chart():
    prompt = analyst._system_prompt("INR")
    assert "pin_chart" in prompt
    assert "a chart in the chat (draw_chart), not a change" in prompt

# --- 5. a date range is resolved from the real calendar ----------------------
#
# The set_period tool took only week numbers, so the model did the date
# arithmetic itself — against a week calendar it cannot see. Asked to "change
# date to 11 mar 2025 to 11 aug 2025" it answered "weeks 11-18 of 2025";
# asked for "march 2025 to august 2025" it answered "weeks 11-36". Both wrong,
# differently, and both reported confidently.
#
# 11 March 2025 is in business week 11 and 11 August is in week 33, as the
# dataset's own calendar has it.


def test_a_date_range_lands_on_the_weeks_that_hold_those_days():
    action = hub_scope.period_action(date_from="11 mar 2025", date_to="11 aug 2025")
    assert (action["period_from"], action["period_to"]) == (202511, 202533)
    assert action["year"] is None, "a custom range is not a year"
    assert action["summary"] == "set the period to 11 Mar 2025 \u2013 11 Aug 2025"


@pytest.mark.parametrize("start,end", [
    ("11 mar 2025", "11 aug 2025"),
    ("11-03-2025", "11-08-2025"),
    ("2025-03-11", "2025-08-11"),
    ("11 March 2025", "11 August 2025"),
    ("11 Mar, 2025", "11 Aug, 2025"),
])
def test_however_the_reader_writes_the_dates(start, end):
    action = hub_scope.period_action(date_from=start, date_to=end)
    assert (action["period_from"], action["period_to"]) == (202511, 202533)


def test_a_bare_month_range_covers_both_months_whole():
    """"march 2025 to august 2025" is two whole months, not two single days."""
    action = hub_scope.period_action(date_from="march 2025", date_to="august 2025")
    assert action["summary"] == "set the period to 01 Mar 2025 \u2013 31 Aug 2025"
    # The first week holding 1 March, through the last week holding 31 August.
    assert action["period_from"] < 202511 and action["period_to"] > 202533


def test_dates_given_backwards_are_put_the_right_way_round():
    action = hub_scope.period_action(date_from="11 aug 2025", date_to="11 mar 2025")
    assert (action["period_from"], action["period_to"]) == (202511, 202533)


def test_half_a_date_range_is_refused():
    with pytest.raises(hub_scope.ScopeError) as caught:
        hub_scope.period_action(date_from="11 mar 2025")
    assert "both ends" in str(caught.value)


def test_a_date_it_cannot_read_says_how_to_write_one():
    with pytest.raises(hub_scope.ScopeError) as caught:
        hub_scope.period_action(date_from="yesterday", date_to="today")
    assert "11 Mar 2025" in str(caught.value)


def test_a_date_outside_the_data_names_the_span_that_exists():
    with pytest.raises(hub_scope.ScopeError) as caught:
        hub_scope.period_action(date_from="01 jan 1999", date_to="31 dec 1999")
    assert "outside the data" in str(caught.value)


def test_the_tool_tells_the_model_not_to_do_the_arithmetic():
    schema = next(
        t["function"]["parameters"] for t in analyst.TOOLS if t["function"]["name"] == "set_period"
    )
    assert "date_from" in schema["properties"] and "date_to" in schema["properties"]
    assert "never convert dates to week numbers yourself" in schema["properties"]["date_from"]["description"]


def test_a_week_range_is_still_available_for_readers_who_name_weeks():
    action = hub_scope.period_action(week_from=202511, week_to=202520)
    assert (action["period_from"], action["period_to"]) == (202511, 202520)


# --- 6. one period change per turn -------------------------------------------


def test_only_the_last_period_action_of_a_turn_survives():
    """The model called set_period twice for one question and the receipt read
    "Set the period to March 2025; Set the period to weeks 11-36 of 2025" —
    two contradictory changes reported as though both had happened."""
    source = Path(analyst.__file__).read_text(encoding="utf-8")
    body = source[source.index("async def answer("):]
    assert 'if action.get("kind") == "period":' in body
    assert 'actions[:] = [a for a in actions if a.get("kind") != "period"]' in body

# --- 7. changing a chart that is already on the dashboard --------------------
#
# "Make that a column chart" was impossible: the only tools were add and
# remove, so the model either removed and re-added (two changes, two undos, and
# the card losing its place) or said it had changed it and did nothing.

ON_DASHBOARD = [{
    "id": "pinned:1", "title": "ROI by Region",
    "chart_type": "bar", "by": "region", "metric": "roi",
}]


def test_a_chart_can_be_retyped_in_place():
    action = hub_layout.update_action("pinned:1", ON_DASHBOARD, chart_type="column")
    assert action["kind"] == "update_chart"
    assert action["id"] == "pinned:1"
    assert action["patch"] == {"chart_type": "column"}, "only what was asked for changes"
    assert action["summary"] == "made ROI by Region a column chart"


def test_changing_what_it_measures_retitles_it():
    """A chart headed "ROI by Region" that now draws trade spend is a card
    lying about itself."""
    action = hub_layout.update_action(
        "pinned:1", ON_DASHBOARD, metric="trade_spend",
        dimensions=("region",), metrics=("roi", "trade_spend"),
    )
    assert action["patch"]["metric"] == "trade_spend"
    assert action["patch"]["title"] == "Trade Spend by Region"


def test_a_title_the_reader_gave_is_kept():
    action = hub_layout.update_action(
        "pinned:1", ON_DASHBOARD, metric="trade_spend", title="What we spent",
        dimensions=("region",), metrics=("roi", "trade_spend"),
    )
    assert action["patch"]["title"] == "What we spent"


def test_a_chart_that_is_not_there_is_refused_by_name():
    with pytest.raises(ValueError) as caught:
        hub_layout.update_action("pinned:nope", ON_DASHBOARD, chart_type="column")
    message = str(caught.value)
    assert "pinned:nope" in message and "ROI by Region" in message


def test_with_nothing_pinned_it_says_so():
    with pytest.raises(ValueError) as caught:
        hub_layout.update_action("pinned:1", [], chart_type="column")
    assert "no charts from this chat" in str(caught.value)


def test_a_type_the_hub_cannot_draw_is_refused():
    with pytest.raises(ValueError) as caught:
        hub_layout.update_action("pinned:1", ON_DASHBOARD, chart_type="scatter")
    assert "A dashboard chart can be" in str(caught.value)


def test_an_empty_change_is_refused():
    with pytest.raises(ValueError) as caught:
        hub_layout.update_action("pinned:1", ON_DASHBOARD)
    assert "Say what to change" in str(caught.value)


def test_the_tool_forbids_remove_and_re_add():
    tool = next(t for t in analyst.TOOLS if t["function"]["name"] == "update_chart")
    assert "NEVER remove and re-add" in tool["function"]["description"]


# --- what the model is told about the page -----------------------------------


def test_the_prompt_lists_the_charts_it_can_change():
    note = hub_layout.dashboard_note({
        "pinned": ON_DASHBOARD, "hidden_charts": ["region"], "cards": ["volume_uplift"],
    })
    assert "id=pinned:1" in note
    assert "ROI by Region" in note
    assert "Sales by Region" in note, "a hidden chart is named so it can be put back"
    assert "Volume Uplift" in note


def test_the_note_is_honest_when_the_page_is_untouched():
    note = hub_layout.dashboard_note({})
    assert "All nine" in note
    assert "Charts you added: none." in note


def test_the_note_survives_a_client_that_sends_nothing():
    assert hub_layout.dashboard_note(None)


def test_the_turn_is_given_the_page_state():
    source = Path(analyst.__file__).read_text(encoding="utf-8")
    assert "hub_layout.dashboard_note(dashboard)" in source
