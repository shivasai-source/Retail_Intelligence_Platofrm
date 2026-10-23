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

import asyncio
from datetime import date
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

# --- 8. a period typed the way people type periods ---------------------------
#
# "may'24" was answered with invented nonsense ("...but only up to October
# 2023 for specific months") and no tool call at all. "may 2024" was treated as
# a QUESTION: nine KPIs read back as a bullet list, with the page left on
# whatever period it was already showing. Same shape of input, two different
# wrong behaviours.


@pytest.mark.parametrize("text,expected", [
    ("may'24", (2024, 5)),
    ("sep '25", (2025, 9)),
    ("mar-24", (2024, 3)),
])
def test_a_two_digit_year_is_a_month_not_a_day(text, expected):
    """The apostrophe form is unambiguous and common; "24" in it is a year."""
    day = hub_scope.parse_day(text)
    assert (day.year, day.month, day.day) == (*expected, 1)
    end = hub_scope.parse_day(text, end=True)
    assert end.day >= 28, "the end of a bare month is its last day"


def test_a_two_digit_year_resolves_against_the_real_years():
    """Not 2000 + nn: the answer is a year the data actually holds."""
    assert hub_scope._expand_year(24) == 2024
    with pytest.raises(hub_scope.ScopeError) as caught:
        hub_scope._expand_year(99)
    assert "no year ending 99" in str(caught.value)


def test_a_written_out_day_is_still_a_day():
    assert hub_scope.parse_day("11 may 2024").day == 11


def test_a_month_and_a_bare_number_is_refused_rather_than_guessed():
    """"may 24" is the 24th of May to as many readers as it is May 2024, and
    it carries no year either way. Guessing would put the page on a period
    nobody asked for."""
    with pytest.raises(hub_scope.ScopeError):
        hub_scope.parse_day("may 24")


# --- a message that is ONLY a period moves the page --------------------------


@pytest.mark.parametrize("text,summary", [
    ("may'24", "set the period to May 2024"),
    ("may 2024", "set the period to May 2024"),
    ("show me sep'25", "set the period to September 2025"),
    ("2025", "set the period to 2025"),
    ("all data", "set the period to all data"),
    ("change the period to march 2025", "set the period to March 2025"),
])
def test_a_bare_period_is_an_instruction(text, summary):
    action = analyst.period_only_request(text)
    assert action and action["summary"] == summary


@pytest.mark.parametrize("text", [
    "what was spend in may 2024",       # a question about a period
    "compare may 2024 with may 2025",   # two periods
    "may 2024 vs 2025",
    "chart spend by channel",
    "how did may 2024 compare?",
])
def test_anything_more_than_a_period_still_reaches_the_model(text):
    assert analyst.period_only_request(text) is None


def test_a_bare_period_costs_no_model_call(monkeypatch):
    async def forbidden(*args, **kwargs):  # pragma: no cover - must not run
        raise AssertionError("a bare period reached the model")

    monkeypatch.setattr(analyst, "chat_completion", forbidden)
    monkeypatch.setattr(analyst, "get_client", lambda: None)
    result = asyncio.run(analyst.answer("may'24"))
    assert result["actions"][0]["year"] == 2024
    assert result["actions"][0]["month"] == 5
    assert result["answer"] == "Period's now May 2024."


# --- 9. one instruction changes one thing ------------------------------------
#
# Asked to "replace sales by region chart with product performance" the model
# did the swap correctly AND edited a pinned chart called "ROI by Region" that
# the reader had never mentioned, because the two names look alike. The
# reader's own chart was re-grouped as a side effect of a sentence about a
# different one.


def test_a_layout_change_supersedes_a_stray_chart_edit():
    source = Path(analyst.__file__).read_text(encoding="utf-8")
    body = source[source.index("async def answer("):]
    assert 'actions[:] = [a for a in actions if a.get("kind") != "update_chart"]' in body
    assert "superseded" in body


def test_the_edit_is_dropped_from_the_actions_not_from_the_conversation():
    """`continue` here skipped the tool-response message, leaving an assistant
    tool_call unanswered — which the provider rejects outright on the next
    request."""
    source = Path(analyst.__file__).read_text(encoding="utf-8")
    body = source[source.index("async def answer("):]
    start = body.index("superseded =")
    end = body.index("messages.append(", start)
    assert "continue" not in body[start:end]


def test_the_note_warns_that_the_two_sets_of_names_look_alike():
    note = hub_layout.dashboard_note({
        "pinned": [{"id": "pinned:1", "title": "ROI by Region",
                    "chart_type": "bar", "by": "region", "metric": "roi"}],
        "hidden_charts": [], "cards": [],
    })
    assert "Sales by Region" in note and "ROI by Region" in note
    assert "set_layout" in note and "update_chart" in note


# --- 10. a date however it is written ----------------------------------------
#
# The parser used to work down a list of strptime formats, so "may 2024" was
# read and "may-2024" was refused — a distinction nobody is making when they
# type. It now finds the pieces instead, with the tolerance the column mapper
# already gives a spreadsheet header: case, spacing and punctuation stop
# mattering.


@pytest.mark.parametrize("text", [
    "may 2024", "May 2024", "MAY 2024", "may-2024", "MAY/2024",
    "  May . 2024 ", "may of 2024", "2024 may", "may'24", "May \u201824",
])
def test_may_2024_is_may_2024_however_it_arrives(text):
    """One month, ten spellings, one answer: the whole of May 2024."""
    assert hub_scope.parse_day(text) == date(2024, 5, 1)
    assert hub_scope.parse_day(text, end=True) == date(2024, 5, 31)


@pytest.mark.parametrize("text,month", [
    ("sept 2024", 9), ("SEPTEMBER 2024", 9), ("septem 2024", 9),
    ("sep 2024", 9), ("feburary 2025", 2), ("jan 2025", 1),
])
def test_a_month_resolves_from_however_much_of_it_was_typed(text, month):
    assert hub_scope.parse_day(text).month == month


@pytest.mark.parametrize("word,month", [
    ("SEPT.", 9), (" september ", 9), ("Sep", 9), ("octo", 10), ("DECEM", 12),
])
def test_resolve_month_strips_case_and_punctuation_like_the_column_mapper(word, month):
    assert hub_scope.resolve_month(word) == month


@pytest.mark.parametrize("word", ["ma", "j", "ju", "banana", "", "2024"])
def test_an_ambiguous_or_unknown_month_resolves_to_nothing(word):
    """"ma" is March and May. A guess between them is a different quarter of
    the business, so there is no guess."""
    assert hub_scope.resolve_month(word) is None


@pytest.mark.parametrize("text", ["ma 2025", "mayy 2025", "banana 2025", "next tuesday"])
def test_a_word_that_is_not_a_month_is_refused_not_dropped(text):
    """"ma 2025" used to come back as the WHOLE of 2025 — the half-written
    month silently discarded, and a year's figures answered as if they were a
    month's."""
    with pytest.raises(hub_scope.ScopeError) as caught:
        hub_scope.parse_day(text)
    assert "not a month I recognise" in str(caught.value)


@pytest.mark.parametrize("text", [
    "11 mar 2025", "11-03-2025", "2025-03-11", "11/3/2025", "11 March, 2025",
])
def test_a_specific_day_is_still_a_specific_day(text):
    assert hub_scope.parse_day(text) == date(2025, 3, 11)
    assert hub_scope.parse_day(text, end=True) == date(2025, 3, 11)


def test_an_impossible_day_says_so_plainly():
    with pytest.raises(hub_scope.ScopeError) as caught:
        hub_scope.parse_day("31 feb 2025")
    assert "no 31 February 2025" in str(caught.value)


def test_a_month_with_no_year_asks_which_year():
    """"may 24" is the 24th to as many readers as it is May 2024, so it is
    asked about rather than assumed."""
    with pytest.raises(hub_scope.ScopeError) as caught:
        hub_scope.parse_day("may 24")
    assert "Which year's May?" in str(caught.value)


# --- 11. the conversation reaches the model ----------------------------------
#
# "it is not remembering even the just before message". It was not: the history
# was assembled INSIDE a `setMessages` updater, and React runs an updater while
# it processes the update, not when it is called. The variable was still the
# empty array it was initialised to when the request went out, on every turn —
# so no follow-up could ever resolve, however well the backend handled one.


ANALYST_HOOK = (
    Path(__file__).resolve().parents[2]
    / "frontend" / "src" / "hooks" / "useAnalyst.ts"
)


def test_the_history_is_not_built_inside_a_state_updater():
    source = ANALYST_HOOK.read_text(encoding="utf-8")
    ask = source[source.index("const ask = useCallback"):source.index("const clear =")]
    built = ask.index("const history = messagesRef.current")
    sent = ask.index("apiPost")
    assert built < sent, "the history must exist before the request goes out"
    assert "let history" not in ask, "a history captured by an updater is empty"


def test_every_write_to_the_thread_keeps_the_ref_in_step():
    """A raw setMessages leaves the ref stale, and the NEXT turn's history is
    then missing this one — the same bug, one turn later."""
    source = ANALYST_HOOK.read_text(encoding="utf-8")
    body = source[source.index("export function useAnalyst"):]
    assert "setMessages((current)" not in body
    assert body.count("setMessages(messagesRef.current)") == 1
    assert "writeMessages" in body


def test_the_backend_still_flattens_what_it_is_given():
    """The other half: history arrives as turns and must reach the model as
    plain user/assistant messages, trimmed to the window."""
    turns = [{"role": "user", "content": "roi by channel"},
             {"role": "assistant", "content": "Modern Trade leads at 1.80x."},
             {"role": "system", "content": "ignored"},
             {"role": "user", "content": ""}]
    out = analyst._history_messages(turns)
    assert [m["role"] for m in out] == ["user", "assistant"]
    assert out[1]["content"].startswith("Modern Trade")
    assert analyst._history_messages(None) == []
    assert len(analyst._history_messages(
        [{"role": "user", "content": f"q{i}"} for i in range(40)]
    )) == analyst.HISTORY_TURNS

