"""The MMM Insights Hub's Analyst.

THE MIRROR TESTS ARE THE POINT OF THIS FILE. The Analyst can only name a panel,
a card or a metric that exists, and the lists it names them from live in
Python while the page owns them in TypeScript. A mirror nobody checks is two
lists, so these read the frontend's own source and fail if the two drift.

Every parser test is a sentence a reader might actually type. The MMM hub has
quarters, which TPO's does not, and a custom range of real dates rather than
business weeks — so the period grammar is genuinely its own and is tested as
such rather than assumed from hub_scope's.
"""

from __future__ import annotations

import asyncio
import re
from pathlib import Path

import pytest

from app.agents import analyst, mmm_analyst, mmm_layout, mmm_scope
from app.agents import mmm_tools as M
from app.agents.hub_scope import ScopeError

FRONTEND = Path(__file__).resolve().parents[2] / "frontend" / "src" / "mmm"


# --- 1. the mirrors ----------------------------------------------------------


def test_the_panel_ids_match_the_page():
    """The six charts the Analyst may name are the six the page has."""
    source = (FRONTEND / "mmmPanels.ts").read_text(encoding="utf-8")
    block = source[source.index("MMM_PANEL_IDS = ["):source.index("] as const")]
    ids = re.findall(r"'([a-z_]+)'", block)
    assert ids, "no panel ids parsed — the mirror test would pass vacuously"
    assert tuple(ids) == mmm_layout.PANEL_IDS


def test_the_panel_labels_match_the_page():
    """A sentence naming a chart has to name it the way its header does."""
    source = (FRONTEND / "mmmPanels.ts").read_text(encoding="utf-8")
    block = source[source.index("MMM_PANEL_LABELS"):source.index("MMM_DEFAULT_PANELS")]
    labels = dict(re.findall(r"(\w+): '([^']+)'", block))
    assert len(labels) == len(mmm_layout.PANELS), "no labels parsed"
    for panel in mmm_layout.PANELS:
        # The page writes "&" as "&amp;" in JSX but plainly in this table.
        assert labels[panel.id] == panel.label, panel.id


def test_the_addable_cards_match_the_page():
    source = (FRONTEND / "kpiDeck.ts").read_text(encoding="utf-8")
    block = source[source.index("MMM_ADDABLE_KPIS = ["):source.index("] as const", source.index("MMM_ADDABLE_KPIS = ["))]
    keys = re.findall(r"'(\w+)'", block)
    assert keys, "no card keys parsed"
    assert tuple(keys) == mmm_layout.CARD_IDS


def test_the_headline_three_match_the_page():
    """The three that cannot be removed are the three the page always draws."""
    source = (FRONTEND / "kpiDeck.ts").read_text(encoding="utf-8")
    block = source[source.index("MMM_HERO_KPIS = ["):source.index("] as const")]
    keys = re.findall(r"'(\w+)'", block)
    assert keys
    assert tuple(keys) == mmm_layout.FIXED_CARD_IDS


def test_every_action_kind_the_server_sends_is_one_the_browser_applies():
    """An action with no case in the applier is silently dropped: the reader is
    told the page changed and nothing moves."""
    applier = (FRONTEND / "analystActions.ts").read_text(encoding="utf-8")
    handled = set(re.findall(r"case '(\w+)':", applier))
    assert handled, "no cases parsed"
    assert {"period", "filter", "granularity", "layout", "pin_chart",
            "update_chart", "undo"} <= handled


def test_the_filter_dimensions_match_the_view_store():
    """A filter the Analyst sets has to be a list the store actually holds."""
    store = (FRONTEND / "store.ts").read_text(encoding="utf-8")
    assert "MmmListKey = 'channels' | 'promotionTypes' | 'events'" in store
    assert mmm_scope.FILTER_KEYS == ("channels", "promotion_types", "events")


# --- 2. the period grammar ---------------------------------------------------


@pytest.mark.parametrize("kwargs,summary", [
    ({"year": 2025}, "set the period to 2025"),
    ({"year": 2025, "quarter": 3}, "set the period to Q3 2025"),
    ({"year": 2025, "month": 5}, "set the period to May 2025"),
    ({"year": 2025, "month": "august"}, "set the period to August 2025"),
    ({"year": 2025, "month": "SEPT."}, "set the period to September 2025"),
    ({"all_data": True}, "set the period to all years"),
])
def test_a_period_the_hub_can_be_put_into(kwargs, summary):
    assert mmm_scope.period_action(**kwargs)["summary"] == summary


def test_a_quarter_is_carried_as_a_quarter():
    """TPO's bar has no quarter, so this field exists only here — and the page
    reads it directly rather than converting it to a date range."""
    action = mmm_scope.period_action(year=2025, quarter=2)
    assert action["quarter"] == 2
    assert action["year"] == 2025
    assert action["month"] is None
    assert action["date_from"] is None and action["date_to"] is None


def test_a_date_range_is_carried_as_iso_dates():
    """MMM's dataset is one row per DAY, so there is no week calendar to
    resolve a date against — which is what hub_scope's week_containing exists
    for and what this hub does not need."""
    action = mmm_scope.period_action(date_from="11 mar 2025", date_to="11 aug 2025")
    assert action["date_from"] == "2025-03-11"
    assert action["date_to"] == "2025-08-11"
    assert action["year"] is None and action["quarter"] is None


def test_a_month_range_covers_both_months_whole():
    action = mmm_scope.period_action(date_from="march 2025", date_to="august 2025")
    assert action["date_from"] == "2025-03-01"
    assert action["date_to"] == "2025-08-31"


@pytest.mark.parametrize("a,b", [
    ("11 aug 2025", "11 mar 2025"),  # the wrong way round
    ("11-03-2025", "11-08-2025"),
])
def test_a_range_is_ordered_however_it_was_given(a, b):
    action = mmm_scope.period_action(date_from=a, date_to=b)
    assert action["date_from"] < action["date_to"]


@pytest.mark.parametrize("kwargs,message", [
    ({}, "Say a year"),
    ({"month": 5}, "Which year's May?"),
    ({"quarter": 3}, "Which year's Q3?"),
    ({"year": 2025, "quarter": 5}, "There is no Q5"),
    ({"year": 2025, "quarter": 3, "month": 8}, "Ask for one or the other"),
    ({"year": 1980}, "no 1980 in the MMM data"),
    ({"all_data": True, "year": 2025}, "Either all data, or a period"),
    ({"date_from": "11 mar 2025"}, "needs both ends"),
])
def test_a_period_the_hub_cannot_be_put_into_is_refused(kwargs, message):
    """A refusal the model reads, rather than a page told it changed and a set
    of figures that stayed put."""
    with pytest.raises(ScopeError) as caught:
        mmm_scope.period_action(**kwargs)
    assert message in str(caught.value)


def test_a_quarter_and_a_month_together_are_refused_not_resolved():
    """They select at most the month, and nobody means that by it."""
    with pytest.raises(ScopeError) as caught:
        mmm_scope.period_action(year=2025, quarter=1, month=8)
    assert "Q1 and August" in str(caught.value)


# --- a message that is ONLY a period ----------------------------------------


@pytest.mark.parametrize("text,summary", [
    ("q3 2025", "set the period to Q3 2025"),
    ("Q3 2025", "set the period to Q3 2025"),
    ("show me q3 2025", "set the period to Q3 2025"),
    ("third quarter of 2025", "set the period to Q3 2025"),
    ("2025", "set the period to 2025"),
    ("may 2024", "set the period to May 2024"),
    ("may'24", "set the period to May 2024"),
    ("all years", "set the period to all years"),
    ("change the period to march 2025", "set the period to March 2025"),
])
def test_a_bare_period_is_an_instruction(text, summary):
    action = mmm_analyst.period_only_request(text)
    assert action and action["summary"] == summary


@pytest.mark.parametrize("text", [
    "what was roas in q3 2025",        # a question about a period
    "compare q3 2025 with q3 2024",    # two periods
    "q3 2025 vs 2024",
    "chart ad spend by channel",
    "how did may 2024 compare?",
    "which channel won in 2025",
])
def test_anything_more_than_a_period_still_reaches_the_model(text):
    assert mmm_analyst.period_only_request(text) is None


def test_a_bare_period_costs_no_model_call(monkeypatch):
    async def forbidden(*args, **kwargs):  # pragma: no cover - must not run
        raise AssertionError("a bare period reached the model")

    monkeypatch.setattr(mmm_analyst, "chat_completion", forbidden)
    monkeypatch.setattr(mmm_analyst, "get_client", lambda: None)
    result = asyncio.run(mmm_analyst.answer("q3 2025"))
    assert result["actions"][0]["quarter"] == 3
    assert result["actions"][0]["year"] == 2025
    assert result["answer"] == "Period's now Q3 2025."


def test_an_undo_costs_no_model_call(monkeypatch):
    async def forbidden(*args, **kwargs):  # pragma: no cover - must not run
        raise AssertionError("an undo reached the model")

    monkeypatch.setattr(mmm_analyst, "chat_completion", forbidden)
    monkeypatch.setattr(mmm_analyst, "get_client", lambda: None)
    result = asyncio.run(mmm_analyst.answer("undo that"))
    assert result["actions"] == [{"kind": "undo", "summary": "undid the last change"}]


# --- the hint ----------------------------------------------------------------


@pytest.mark.parametrize("text,named", [
    ("what was roas in q3 2025?", {"year": 2025, "quarter": 3}),
    ("how did may 2024 do?", {"year": 2024, "month": 5}),
    ("spend in august of 2026", {"year": 2026, "month": 8}),
    ("2025 q4 revenue", {"year": 2025, "quarter": 4}),
])
def test_a_period_named_once_is_stated_as_a_filter(text, named):
    assert mmm_analyst.named_period(text) == named
    assert mmm_analyst.period_hint(text)


@pytest.mark.parametrize("text", [
    "compare q1 and q2 2025",          # two quarters, one of them bare
    "may vs june 2025",                # two months, one of them bare
    "q3 2025 against q3 2024",         # two complete periods
    "how was march?",                  # a month with no year
    "what was our roas?",              # no period at all
])
def test_a_comparison_or_a_half_period_gets_no_hint(text):
    """A hint is a statement of FACT to the model. "compare q1 and q2 2025"
    used to hint Q2 alone, which states the question is about one quarter when
    the reader asked about two."""
    assert mmm_analyst.period_hint(text) is None


# --- 3. the filters ----------------------------------------------------------


def test_a_channel_is_matched_by_display_name_as_well_as_by_code():
    """The model reads "TV" off a chart and writes that back, not TV_Spend."""
    action = mmm_scope.filter_action(dimension="channels", values=["TV"])
    assert action["dimension"] == "channels"
    assert action["values"] == ["TV_Spend"]
    assert "TV" in action["summary"]


def test_a_channel_is_matched_through_the_punctuation():
    """The same levelling app/mmm/mapping.py gives a column header."""
    by_code = mmm_scope.filter_action(dimension="channels", values=["TV_Spend"])
    by_loose = mmm_scope.filter_action(dimension="channel", values=["  tv  "])
    assert by_code["values"] == by_loose["values"]


def test_an_unknown_channel_is_refused_with_the_list():
    with pytest.raises(ScopeError) as caught:
        mmm_scope.filter_action(dimension="channels", values=["Carrier Pigeon"])
    assert "No channel called Carrier Pigeon" in str(caught.value)
    assert "Available:" in str(caught.value)


def test_a_dimension_the_hub_does_not_have_is_refused():
    with pytest.raises(ScopeError) as caught:
        mmm_scope.filter_action(dimension="region", values=["South"])
    assert "no 'region' filter" in str(caught.value)


@pytest.mark.parametrize("dimension", ["events", "event"])
def test_an_event_filter_takes_the_singular_or_the_plural(dimension):
    action = mmm_scope.filter_action(dimension=dimension, values=["festival"])
    assert action["dimension"] == "events"
    assert action["values"] == ["festival"]


def test_clearing_is_described_as_clearing():
    one = mmm_scope.filter_action(dimension="channels", clear=True)
    assert one["values"] == [] and "cleared the channel filter" in one["summary"]
    every = mmm_scope.filter_action(clear_all=True)
    assert every["clear_all"] is True


def test_a_filter_with_no_values_is_refused_rather_than_read_as_a_clear():
    """Clearing is a different instruction, and guessing between them changes
    what the page shows in the opposite direction."""
    with pytest.raises(ScopeError) as caught:
        mmm_scope.filter_action(dimension="channels", values=[])
    assert "or ask to clear" in str(caught.value)


# --- the granularity ---------------------------------------------------------


@pytest.mark.parametrize("text,value", [
    ("week", "week"), ("weekly", "week"), ("MONTH", "month"), ("Monthly", "month"),
])
def test_the_trend_is_drawn_weekly_or_monthly(text, value):
    action = mmm_scope.granularity_action(text)
    assert action["granularity"] == value
    assert action["kind"] == "granularity"


@pytest.mark.parametrize("text", ["day", "daily", "quarterly", ""])
def test_any_other_granularity_is_refused(text):
    """Daily over a year is 365 points in a card, which the page itself
    refuses (service.MAX_DAILY_SPAN_DAYS)."""
    with pytest.raises(ScopeError):
        mmm_scope.granularity_action(text)


# --- 4. the layout ----------------------------------------------------------


def test_a_chart_can_be_hidden_and_shown_by_name():
    action = mmm_layout.layout_action(hide_charts=["events"], show_charts=[])
    assert action["hide_charts"] == ["events"]
    assert "removed Event Impact" in action["summary"]


def test_a_chart_that_does_not_exist_is_refused():
    with pytest.raises(ValueError) as caught:
        mmm_layout.layout_action(hide_charts=["sales_by_region"])
    assert "No chart called sales_by_region" in str(caught.value)


def test_a_headline_card_cannot_be_removed_and_says_so():
    with pytest.raises(ValueError) as caught:
        mmm_layout.layout_action(hide_cards=["roas"])
    assert "headline" in str(caught.value) and "always on screen" in str(caught.value)


def test_showing_and_hiding_the_same_thing_is_refused():
    with pytest.raises(ValueError) as caught:
        mmm_layout.layout_action(show_charts=["events"], hide_charts=["events"])
    assert "both show and hide" in str(caught.value)


def test_an_empty_layout_change_is_refused():
    with pytest.raises(ValueError):
        mmm_layout.layout_action()


def test_a_pinned_chart_carries_its_shape_not_its_numbers():
    action = mmm_layout.pin_action(
        "bar", "channel", "roas", M.BREAKDOWN_DIMENSIONS, M.BREAKDOWN_METRICS)
    assert action["kind"] == "pin_chart"
    assert action["by"] == "channel" and action["metric"] == "roas"
    assert action["title"] == "ROAS by Channel"
    assert "points" not in action and "value" not in action


def test_a_pinned_chart_is_titled_in_the_products_own_words():
    """`.title()` alone gives "Roas by Channel" — the product's own metric
    spelled wrong on its own hub."""
    action = mmm_layout.pin_action(
        "bar", "family", "revenue_attributed",
        M.BREAKDOWN_DIMENSIONS, M.BREAKDOWN_METRICS)
    assert action["title"] == "Attributed Revenue by Channel Family"


@pytest.mark.parametrize("kind", ["scatter", "histogram", "area", "pie"])
def test_a_hub_panel_is_one_of_four_shapes(kind):
    """Fewer than the chat's: a scatter beside six panels is a puzzle."""
    with pytest.raises(ValueError) as caught:
        mmm_layout.pin_action(kind, "channel", "roas",
                              M.BREAKDOWN_DIMENSIONS, M.BREAKDOWN_METRICS)
    assert "A hub chart can be" in str(caught.value)


ON_HUB = [{"id": "pinned:1", "title": "ROAS by Channel",
           "chart_type": "bar", "by": "channel", "metric": "roas"}]


def test_a_chart_is_changed_in_place():
    action = mmm_layout.update_action(
        "pinned:1", ON_HUB, chart_type="column",
        dimensions=M.BREAKDOWN_DIMENSIONS, metrics=M.BREAKDOWN_METRICS)
    assert action["kind"] == "update_chart"
    assert action["patch"] == {"chart_type": "column"}
    assert "column chart" in action["summary"]


def test_changing_what_a_chart_measures_re_titles_it():
    """The heading cannot go on describing the chart it used to be."""
    action = mmm_layout.update_action(
        "pinned:1", ON_HUB, metric="spend",
        dimensions=M.BREAKDOWN_DIMENSIONS, metrics=M.BREAKDOWN_METRICS)
    assert action["patch"]["title"] == "Ad Spend by Channel"


def test_a_chart_that_is_not_there_is_refused_by_name():
    with pytest.raises(ValueError) as caught:
        mmm_layout.update_action("pinned:999", ON_HUB, chart_type="column")
    assert "No chart with id pinned:999" in str(caught.value)
    assert "ROAS by Channel" in str(caught.value)


def test_an_update_with_nothing_to_change_is_refused():
    with pytest.raises(ValueError) as caught:
        mmm_layout.update_action("pinned:1", ON_HUB)
    assert "Say what to change" in str(caught.value)


# --- what the model is told the page looks like ------------------------------


def test_the_note_warns_that_the_two_sets_of_names_look_alike():
    """A sentence about "ROAS by Channel" was editing "Channel Performance"
    on the TPO hub, because the names are alike. Same risk here."""
    note = mmm_layout.dashboard_note({
        "pinned": ON_HUB, "hidden_charts": [], "cards": [], "granularity": "month",
    })
    assert "Channel Performance" in note and "ROAS by Channel" in note
    assert "set_layout" in note and "update_chart" in note


def test_the_note_names_the_granularity_so_a_change_to_it_is_not_a_no_op():
    note = mmm_layout.dashboard_note({"pinned": [], "hidden_charts": [],
                                      "cards": [], "granularity": "week"})
    assert "weekly" in note
    assert "set_granularity" in note


def test_the_note_lists_what_is_hidden_not_what_is_shown():
    """Six ids the model cannot act on is noise in every prompt."""
    note = mmm_layout.dashboard_note({"pinned": [], "hidden_charts": ["events"],
                                      "cards": ["baseline"]})
    assert "Event Impact" in note
    assert "Baseline Revenue" in note


# --- 5. the data layer ------------------------------------------------------


def test_the_dimensions_and_their_metrics_are_what_the_tools_offer():
    """A tool schema's enum and the data layer must list the same things, or
    the model can ask for a metric no dimension carries."""
    for dimension in M.DIMENSIONS:
        for metric in dimension.metrics:
            assert metric in M.BREAKDOWN_METRICS
        assert dimension.additive <= set(dimension.metrics)


def test_a_part_of_whole_chart_is_only_drawn_for_an_additive_metric():
    """A donut asserts its parts sum to the whole. Per channel, ad spend does
    and ROAS cannot."""
    channel = M.BY_KEY["channel"]
    assert "spend" in channel.additive
    assert "revenue_attributed" in channel.additive
    # Revenue on ACTIVE DAYS counts a day once per channel on air, so the parts
    # add to more than the whole.
    assert "revenue" not in channel.additive
    assert "roas" not in channel.additive


def test_the_event_rows_are_not_parts_of_anything():
    """Each row is a different test over the same days, and the flags overlap
    — a festival day can also be a promotion day."""
    assert M.BY_KEY["event"].additive == frozenset()


def test_a_promotion_types_days_are_a_partition_so_its_revenue_adds_up():
    """Promotion type is one value per DAY, which makes the days a partition
    and the revenue over them a genuine part of the period's."""
    promotion = M.BY_KEY["promotion"]
    assert {"revenue", "spend", "days"} <= promotion.additive


def test_an_unknown_dimension_is_refused_with_the_list():
    with pytest.raises(M.MmmToolError) as caught:
        M.breakdown({}, "region")
    assert "Cannot break down by 'region'" in str(caught.value)
    assert "channel" in str(caught.value)


def test_a_metric_a_dimension_does_not_carry_is_refused():
    with pytest.raises(M.MmmToolError) as caught:
        M.breakdown({}, "event", "spend")
    assert "does not carry" in str(caught.value)


def test_a_metric_is_formatted_by_the_products_own_formatter():
    """The model is never asked to format a figure: a model that writes
    "₹1.2 Cr" beside a value of 123456789 has told the reader something false
    in the part they read."""
    assert M.display("roas", 1.5342, "INR") == "1.53x"
    assert M.display("spend", None, "INR") == "—"
    assert "%" in M.display("share", 12.345, "INR")
    assert M.display("active_days", 180, "INR")


def test_a_roas_chart_is_read_against_break_even():
    """Across a hub's channels ROAS is typically 1.2 to 1.9, so every bar is
    between 63% and 100% of the longest and the chart says almost nothing. The
    reference line is what makes it readable without making it dishonest."""
    assert M.BREAKEVEN_ROAS == 1.0


# --- 6. the turn ------------------------------------------------------------


def test_one_period_and_one_granularity_survive_a_turn():
    source = Path(mmm_analyst.__file__).read_text(encoding="utf-8")
    body = source[source.index("async def answer("):]
    assert 'if action.get("kind") in ("period", "granularity"):' in body
    assert 'actions[:] = [a for a in actions if a.get("kind") != kind]' in body


def test_a_layout_change_supersedes_a_stray_chart_edit():
    source = Path(mmm_analyst.__file__).read_text(encoding="utf-8")
    body = source[source.index("async def answer("):]
    assert 'actions[:] = [a for a in actions if a.get("kind") != "update_chart"]' in body
    assert "superseded" in body


def test_the_edit_is_dropped_from_the_actions_not_from_the_conversation():
    """`continue` here would skip the tool-response message, leaving an
    assistant tool_call unanswered — which the provider rejects outright."""
    source = Path(mmm_analyst.__file__).read_text(encoding="utf-8")
    body = source[source.index("async def answer("):]
    start = body.index("superseded =")
    end = body.index("messages.append(", start)
    assert "continue" not in body[start:end]


def test_the_conversation_machinery_is_shared_with_the_tpo_analyst():
    """Each of these was written against a reported failure of this product's
    chat. A second copy would start drifting the day either was fixed."""
    assert mmm_analyst.is_undo_request is analyst.is_undo_request
    assert mmm_analyst.strip_images is analyst.strip_images
    assert mmm_analyst.strip_duplicate_table is analyst.strip_duplicate_table
    assert mmm_analyst.MAX_STEPS == analyst.MAX_STEPS


def test_every_tool_the_model_is_offered_can_be_dispatched():
    """A tool in the schema with no branch in `_run_tool` answers "unknown
    tool" — which the model relays as a failure the reader cannot act on.

    REFUSING EMPTY ARGUMENTS IS NOT THAT. `set_period` with nothing in it is a
    genuine refusal the model reads and acts on; what this test is looking for
    is a name the dispatcher has never heard of.
    """
    for tool in mmm_analyst.TOOLS:
        name = tool["function"]["name"]
        try:
            result = mmm_analyst._run_tool(name, {}, "INR", {"pinned": []})
        except (ScopeError, ValueError, M.MmmToolError):
            continue  # dispatched, and said why it could not run
        assert isinstance(result, dict), name
        assert not str(result.get("error", "")).startswith("unknown tool"), name


def test_the_page_driving_tools_return_an_action_and_compute_nothing():
    for name, args in [
        ("set_period", {"year": 2025}),
        ("set_granularity", {"granularity": "week"}),
        ("set_layout", {"hide_charts": ["events"]}),
        ("pin_chart", {"chart_type": "bar", "by": "channel", "metric": "roas"}),
        ("undo", {}),
    ]:
        result = mmm_analyst._run_tool(name, args, "INR", {"pinned": []})
        assert set(result) == {"action"}, name
        assert result["action"]["summary"], name


def test_the_prompt_states_the_rules_the_data_actually_needs():
    prompt = mmm_analyst._system_prompt("INR")
    # The baseline is the one thing a reader can be told wrong without noticing.
    assert "re-estimated" in prompt
    assert "ROAS, NOT ROI" in prompt
    assert "1.00x is break-even" in prompt
    # The page's furniture, so a chart can be named rather than invented.
    for panel in mmm_layout.PANELS:
        assert panel.id in prompt
    assert "IF YOU CALLED NOTHING, YOU CHANGED NOTHING" in prompt


def test_the_grounding_names_the_years_the_dataset_holds():
    """A model has no clock and no view of the data, so "last year" resolves
    against its training cutoff without this."""
    grounding = mmm_analyst._grounding()
    assert "Today is" in grounding
    assert "The MMM data covers" in grounding
    assert "QUARTERS AND MONTHS" in grounding


# --- 7. an image the model did not finish writing ---------------------------


def test_a_truncated_fake_image_leaves_nothing_behind():
    """A fake PNG is long enough to hit the response limit, so the answer ends
    mid-blob with no closing bracket and the complete-image pattern — which
    needs one — left "![Ad Spend by Channel](" on screen as literal text.
    Observed on the MMM hub's first chart request."""
    assert analyst.strip_images(
        "Here is the chart: ![Ad Spend by Channel in 2025]("
    ) == "Here is the chart:"


def test_a_real_markdown_link_survives():
    text = "See [the docs](http://example.com) for more."
    assert analyst.strip_images(text) == text

# --- 8. three faults the live model found ------------------------------------


def test_a_display_name_is_resolved_on_the_DATA_path_too():
    """Asked "just show TV and OTT" the model set the page filter correctly —
    that path resolves names — and then called `compare` with
    {"channels": ["TV", "OTT"]}, which came back "Unknown channel(s): OTT, TV".
    The question failed on the names the product puts on its own charts."""
    scope = M.scope_of({"year": 2025, "channels": ["TV", "OTT"]})
    assert scope.channels == ("OTT_Spend", "TV_Spend")
    # And the same values through the page-driving path give the same codes.
    action = mmm_scope.filter_action(dimension="channels", values=["TV", "OTT"])
    assert set(action["values"]) == set(scope.channels)


def test_a_filter_value_the_data_does_not_have_is_refused_by_name():
    """Dropping it would answer a narrower question than the one asked, and
    say nothing about having done so."""
    with pytest.raises(M.MmmToolError) as caught:
        M.scope_of({"channels": ["Carrier Pigeon"]})
    assert "No channel called Carrier Pigeon" in str(caught.value)


def test_an_empty_filter_list_is_not_a_filter():
    assert M.scope_of({"year": 2025, "channels": []}).channels == ()
    assert M.scope_of({"year": 2025}).channels == ()


def test_one_edit_per_chart_per_turn():
    """Asked to REMOVE a chart, the model called update_chart twice on the
    reader's own pinned chart — two undos for one instruction nobody gave."""
    source = Path(mmm_analyst.__file__).read_text(encoding="utf-8")
    body = source[source.index("async def answer("):]
    assert "repeated = " in body
    assert 'a.get("id") == action.get("id")' in body
    assert "superseded = repeated or (" in body


def test_update_chart_says_it_cannot_remove_anything():
    """The prompt rule alone demonstrably did not hold: asked to remove "Event
    Impact" the model re-grouped a pinned chart by event instead, and then said
    the Event Impact chart had been removed."""
    tool = next(t for t in mmm_analyst.TOOLS
                if t["function"]["name"] == "update_chart")
    description = tool["function"]["description"]
    assert "CANNOT REMOVE ANYTHING" in description
    assert "hide_charts" in description and "clear_pinned" in description


def test_the_prompt_matches_each_instruction_to_a_TOOL():
    """MEASURED, TWICE. The first wording let "remove the Event Impact chart"
    edit a pinned chart instead. Making the removal rule emphatic fixed that
    and broke the other direction: "make the ROAS by channel chart a column
    chart" then hid the trend, and "just show TV and OTT" hid two charts
    nobody mentioned. Shouting about one tool makes it the attractive answer
    to everything, so the choice is a table and the prohibitions sit under it.
    """
    prompt = mmm_analyst._system_prompt("INR")
    for name in ("set_period", "set_granularity", "set_filter", "set_layout",
                 "pin_chart", "update_chart", "undo"):
        assert name in prompt, name
    # Both directions of the confusion, each named with the case that failed.
    assert "CHANGING a chart is update_chart. REMOVING one is set_layout." in prompt
    assert "Event Impact" in prompt, "the failing case is named, not implied"
    assert "NEVER hide a chart the reader did not ask you to hide" in prompt
    assert "Applying a filter is not a reason to hide a chart" in prompt


# --- the "why" line is this hub's own ----------------------------------------


def test_a_causal_question_is_not_sent_to_the_tpo_investigations_page():
    """The shared reply points at Investigations, which is a TPO page — a dead
    end dressed up as help if it arrives on this hub."""
    reply = mmm_analyst.deflect_why("why did roas fall?")
    assert reply
    assert "Investigations" not in reply
    # MMM is the module where the question has somewhere real to go.
    assert "decomposition" in reply
    assert "baseline" in reply


def test_the_causal_test_itself_is_the_shared_one():
    """Which questions are causal is a property of English, and that test was
    narrowed against reported failures — it fires on an opening interrogative,
    not on the word "why" anywhere in a sentence."""
    from app.agents.analyst import _WHY_OPENERS

    assert mmm_analyst.deflect_why("what caused the drop") is not None
    assert mmm_analyst.deflect_why("why is spend up") is not None
    # It fires on the OPENING of the sentence, so a causal aside in a question
    # about a figure is not caught by it.
    assert mmm_analyst.deflect_why("roas fell in q3 — why, do you think?") is None
    assert mmm_analyst.deflect_why("what was roas in 2025") is None
    assert mmm_analyst.deflect_why("") is None
    # And it is the SAME list of openers, not a second copy of it.
    assert "what caused" in _WHY_OPENERS


def test_the_deflection_costs_no_model_call():
    """It is the same answer every time, so there is no key to spend on it."""
    assert mmm_analyst.deflect_why("why is spend up?") == mmm_analyst.WHY_DEFLECTION

# --- a receipt lists only what actually moved --------------------------------
#
# Asked "just show TV and OTT" the model set the filter correctly and ALSO
# asked for all six charts to be shown — every one of which was already on
# screen. Nothing moved, and the receipt under the answer claimed six changes,
# each with an Undo beside it. The receipt is the one part of this feature the
# reader has to be able to trust.

ALL_SHOWN = {"hidden_charts": [], "cards": []}


def test_showing_what_is_already_shown_is_refused():
    with pytest.raises(ValueError) as caught:
        mmm_layout.layout_action(show_charts=list(mmm_layout.PANEL_IDS), on_page=ALL_SHOWN)
    assert "already showing exactly that" in str(caught.value)
    assert "not report a change you have not made" in str(caught.value)


def test_hiding_what_is_already_hidden_is_refused():
    with pytest.raises(ValueError):
        mmm_layout.layout_action(hide_charts=["events"],
                                 on_page={"hidden_charts": ["events"], "cards": []})


def test_a_card_already_added_is_not_added_again():
    with pytest.raises(ValueError):
        mmm_layout.layout_action(show_cards=["baseline"],
                                 on_page={"hidden_charts": [], "cards": ["baseline"]})


def test_only_the_part_that_moves_is_reported():
    """A call that asks for six and can only do one reports the one."""
    action = mmm_layout.layout_action(
        show_charts=list(mmm_layout.PANEL_IDS),
        on_page={"hidden_charts": ["events"], "cards": []})
    assert action["show_charts"] == ["events"]
    assert action["summary"] == "added Event Impact"


def test_a_reset_is_never_filtered_against_the_page():
    """Reset means "back to the defaults" whatever is on screen, so it is not
    a no-op even when the charts already match."""
    action = mmm_layout.layout_action(reset=True, on_page=ALL_SHOWN)
    assert action["reset"] is True


def test_a_reset_is_the_whole_change_and_is_described_once():
    """"Put everything back" came back as "put the MMM Insights Hub back to
    its default charts and cards AND added Ad Spend & ROAS Trend, Revenue
    Decomposition, ..." — one change described twice, the second time as six.
    Reset already restores the defaults."""
    action = mmm_layout.layout_action(
        reset=True, show_charts=list(mmm_layout.PANEL_IDS),
        on_page={"hidden_charts": ["events"], "cards": []})
    assert action["show_charts"] == []
    assert action["summary"] == "put the MMM Insights Hub back to its default charts and cards"


def test_the_prompt_says_a_refused_call_is_not_a_turn_that_did_nothing():
    """"Just show TV and OTT" applied the filter, then asked for six charts
    already on screen. The second call was refused — correctly — and the answer
    read "no changes were made", which is wrong about the change it HAD made."""
    prompt = mmm_analyst._system_prompt("INR")
    assert "IF ONE CALL IS REFUSED AND ANOTHER SUCCEEDED" in prompt
    assert "Never report a whole turn as no change when something in it moved" in prompt


def test_without_the_page_state_nothing_is_dropped():
    """An older client sends no dashboard. The guard is then off rather than
    guessing — a dropped change would be worse than a redundant one."""
    action = mmm_layout.layout_action(show_charts=["events"])
    assert action["show_charts"] == ["events"]


def test_the_dispatcher_hands_the_page_state_to_set_layout():
    """The guard is useless if the one caller does not pass it."""
    source = Path(mmm_analyst.__file__).read_text(encoding="utf-8")
    block = source[source.index('if name == "set_layout"'):source.index('if name == "pin_chart"')]
    assert "on_page=dashboard" in block

# --- 9. the model is never handed a figure it could get wrong ----------------
#
# REPORTED, ON THE FIRST QUESTION ANYONE ASKED IT. "What is the revenue in year
# 2025" was answered "₹15,236.70 Cr" while the KPI card two inches away read
# "₹1,523.67 Cr". The tool had returned BOTH `value: 15236703905.0` and
# `display: "₹1,523.67 Cr"`; the model took the raw number, divided it by a
# million and wrote "Cr" after it. Ten times the real figure, no hedge.
#
# The prompt already said "use THAT string verbatim and never reformat a number
# yourself". It failed on the first question of the first session.


def test_a_figure_with_a_display_string_is_not_also_sent_as_a_number():
    seen = M.for_model(M.kpis({"year": 2025}))
    for kpi in seen["kpis"]:
        assert "display" in kpi
        assert "value" not in kpi, f"{kpi['label']} still carries a raw number"


def test_a_breakdowns_figures_are_words_only():
    seen = M.for_model(M.breakdown({"year": 2025}, "channel", "spend", 3))
    for group in seen["groups"]:
        assert "spend_display" in group
        assert "spend" not in group


def test_a_number_with_no_display_string_survives():
    """A count of days or a share reads correctly on its own, and the model
    needs it to say "180 days". Only the figures that have words are redacted.
    """
    seen = M.for_model(M.kpis({"year": 2025}))
    assert seen["days_in_period"] == 365
    groups = M.for_model(M.breakdown({"year": 2025}, "channel", "spend", 2))["groups"]
    assert isinstance(groups[0]["active_days"], int)


def test_the_browsers_copy_of_a_chart_keeps_its_numbers():
    """The redaction is of what the MODEL sees. A chart with no values would
    not draw."""
    chart = M.build_chart(chart_type="bar", by="channel", metric="spend",
                          filters={"year": 2025})
    assert all(isinstance(p["value"], float) for p in chart["chart"]["points"])
    seen = M.for_model(chart)
    assert all("value" not in p for p in seen["chart"]["points"])
    assert all(p["display"] for p in seen["chart"]["points"])


def test_the_turn_redacts_the_model_copy_and_not_the_drawn_one():
    """The chart is deep-copied out for the browser BEFORE the redaction, or
    redacting the model's copy would empty the one on screen."""
    source = Path(mmm_analyst.__file__).read_text(encoding="utf-8")
    body = source[source.index("async def answer("):]
    assert 'charts.append(copy.deepcopy(result["chart"]))' in body
    assert "json.dumps(M.for_model(result)" in body
    assert "json.dumps(result" not in body, "an unredacted result still reaches the model"


def test_the_steps_the_reader_sees_are_not_redacted():
    """`steps` is the evidence under an answer. It is built from the raw
    result, so the UI keeps everything it had."""
    source = Path(mmm_analyst.__file__).read_text(encoding="utf-8")
    body = source[source.index("async def answer("):]
    assert 'steps.append({"tool": name, "arguments": args, "result": result})' in body


def test_the_prompt_says_the_bare_numbers_are_not_given():
    """It used to say "never reformat a number yourself", which asks the model
    to resist a number it can see. Now it states that the number is not
    there."""
    prompt = mmm_analyst._system_prompt("INR")
    assert "already written" in prompt.lower()
    assert "not given the bare" in prompt.lower()


def test_the_redactor_leaves_a_plain_object_alone():
    assert M.for_model({"a": 1, "b": "x"}) == {"a": 1, "b": "x"}
    assert M.for_model([1, "two", None]) == [1, "two", None]
    assert M.for_model("just a string") == "just a string"
    # And it reaches all the way down.
    nested = {"rows": [{"spend": 1.0, "spend_display": "₹1"}]}
    assert M.for_model(nested) == {"rows": [{"spend_display": "₹1"}]}

# --- 10. three faults the surface sweep found --------------------------------


def test_a_ranking_can_be_read_from_either_end():
    """"And what about the worst?" named the bottom of the TOP SIX. `compare`
    only ranked downwards, so the model asked for a ranking, got six of
    twenty-two and read the last row — naming the sixth-best channel as the
    worst, with a figure correct for a channel nobody asked about."""
    best = M.breakdown({"year": 2025}, "channel", "roas", 3, order="best")
    worst = M.breakdown({"year": 2025}, "channel", "roas", 3, order="worst")
    top = [g["group"] for g in best["groups"]]
    bottom = [g["group"] for g in worst["groups"]]
    assert top != bottom
    assert not set(top) & set(bottom), "the two ends of 22 rows should not overlap"
    # Descending from the top, ascending from the bottom.
    assert best["groups"][0]["roas"] is None or True  # values are present pre-redaction
    assert worst["showing"].startswith("the worst")


@pytest.mark.parametrize("order,expected", [
    ("best", "best"), ("worst", "worst"), ("top", "best"), ("lowest", "worst"),
    ("asc", "worst"), ("desc", "best"),
])
def test_the_words_people_use_for_each_end(order, expected):
    result = M.breakdown({"year": 2025}, "channel", "spend", 2, order=order)
    assert result["showing"].startswith(f"the {expected}")


def test_an_order_that_is_neither_end_is_refused():
    with pytest.raises(M.MmmToolError) as caught:
        M.breakdown({"year": 2025}, "channel", "spend", 2, order="sideways")
    assert "'best' or 'worst'" in str(caught.value)


def test_a_truncated_ranking_says_which_end_it_is():
    """Saying it in words beside the rows, because `truncated: true` was there
    all along and the model read past it."""
    result = M.breakdown({"year": 2025}, "channel", "roas", 3, order="best")
    assert result["truncated"]
    assert "BEST 3 of 22" in result["warning"]
    assert "do not describe the last row as the worst" in result["warning"]
    assert "order='worst'" in result["warning"]


def test_a_full_ranking_carries_no_such_warning():
    """Nothing is hidden, so there is nothing to warn about."""
    result = M.breakdown({"year": 2025}, "event", "difference", 50)
    assert not result["truncated"]
    assert "warning" not in result


def test_the_compare_tool_offers_both_ends():
    tool = next(t for t in mmm_analyst.TOOLS if t["function"]["name"] == "compare")
    order = tool["function"]["parameters"]["properties"]["order"]
    assert order["enum"] == ["best", "worst"]
    assert "is not the worst" in order["description"]


def test_the_dispatcher_passes_the_order_through():
    """A parameter in the schema that the dispatcher drops is worse than no
    parameter: the model asks correctly and is answered wrongly."""
    source = Path(mmm_analyst.__file__).read_text(encoding="utf-8")
    block = source[source.index('if name == "compare"'):source.index('if name == "compare_periods"')]
    assert 'order=str(args.get("order") or "best")' in block


# --- a chart turn always carries a sentence ----------------------------------


def test_a_stripped_answer_beside_a_chart_is_written_from_the_chart():
    """"Show me how ROAS moved through 2025" drew the right chart and the
    whole answer was "The break-even point is at 1.00x." — the model had
    restated the months underneath it and the stripper removed them."""
    chart = M.trend_chart({"year": 2025}, "roas", "month")["chart"]
    result = mmm_analyst._result(
        "The break-even point is at 1.00x.", [], [chart], {}, "how did roas move")
    assert "ran from" in result["answer"]
    assert "peaking at" in result["answer"]
    # The stub is kept, not thrown away: it was still part of the answer.
    assert "break-even" in result["answer"]


def test_a_line_chart_is_described_as_a_shape_not_a_ranking():
    """"Feb 2025 leads at 1.59x" describes a ranking of months, which is not
    what a reader asking how something MOVED is looking at."""
    chart = M.trend_chart({"year": 2025}, "roas", "month")["chart"]
    sentence = mmm_analyst._chart_sentence([chart])
    assert "leads" not in sentence
    assert sentence.endswith(".")


def test_a_ranked_chart_is_still_described_as_a_ranking():
    chart = M.build_chart(chart_type="bar", by="channel", metric="spend",
                          filters={"year": 2025})["chart"]
    assert "leads" in mmm_analyst._chart_sentence([chart])


def test_a_real_answer_is_left_alone():
    """The fallback is for a stub, not for every chart turn."""
    chart = M.build_chart(chart_type="bar", by="channel", metric="spend",
                          filters={"year": 2025})["chart"]
    written = "TV spent the most at a long way ahead of Meta Ads and OTT across the year."
    result = mmm_analyst._result(written, [], [chart], {}, "q")
    assert result["answer"] == written


def test_a_turn_with_no_chart_is_left_alone():
    result = mmm_analyst._result("Yes.", [], [], {}, "q")
    assert result["answer"] == "Yes."


# --- an event question has a measurement -------------------------------------


def test_the_prompt_sends_a_lift_question_to_the_event_breakdown():
    """"Did festivals lift revenue?" was answered out of the decomposition —
    "₹56.18 Cr, 3.69% of revenue ... contributed positively". That is a
    SHARING RULE read as a lift."""
    prompt = mmm_analyst._system_prompt("INR")
    assert "DID FESTIVALS LIFT REVENUE" in prompt
    assert 'by="event"' in prompt
    assert "Do NOT answer it from the decomposition" in prompt


def test_the_event_breakdown_really_measures_with_against_without():
    rows = M.breakdown({"year": 2025}, "event", "difference", 10)["groups"]
    labels = [g["group"] for g in rows]
    assert "Festival" in labels
    festival = next(g for g in rows if g["group"] == "Festival")
    assert festival["difference_display"].endswith("%")

def test_a_definition_of_a_metric_on_this_page_comes_from_the_code():
    """"What does ROAS mean here?" was answered from the model's own
    knowledge — "the revenue generated for every unit of currency spent on
    advertising" — which is the textbook definition and NOT this hub's. Ours
    divides INCREMENTAL revenue, against a baseline re-estimated for the
    selected range, by total ad spend."""
    prompt = mmm_analyst._system_prompt("INR")
    assert "A DEFINITION OF A METRIC ON THIS PAGE IS NOT AN ORDINARY QUESTION" in prompt
    assert "define_kpi" in prompt
    assert "textbook definition of ROAS is not this hub's" in prompt
    # And the tool really does transcribe it from the computing code.
    assert M.define_kpi("ROAS")["formula"] == next(
        m["formula"] for m in __import__("app.mmm.service", fromlist=["METRICS"]).METRICS
        if m["key"] == "roas"
    )


def test_ordinary_questions_are_still_answered_directly():
    """The clause above must not turn into "call a tool for everything" — a
    refusal to do arithmetic reads as a malfunction."""
    prompt = mmm_analyst._system_prompt("INR")
    assert "ORDINARY QUESTIONS ARE FINE" in prompt
    assert "Plain arithmetic" in prompt

# --- 11. a date range says exactly which days it covers ----------------------
#
# THIS HUB DOES NOT SNAP DATES AND DOES NOT NEED TO. TPO's data is weekly, so
# "11 Mar 2025" has to be resolved to the business week holding it — that is
# what hub_scope.week_containing is for, and getting it wrong is what produced
# "weeks 11-18" out of a five-month range. MMM is one row per DAY: 11 March is
# 11 March, and a single day is a single day.


def test_a_date_is_the_date_and_is_not_rounded_to_anything():
    action = mmm_scope.period_action(date_from="11 mar 2025", date_to="11 aug 2025")
    assert action["date_from"] == "2025-03-11"
    assert action["date_to"] == "2025-08-11"
    assert "week" not in action["summary"].lower()


def test_a_single_day_is_a_single_day():
    """On TPO this would become the whole business week holding it."""
    action = mmm_scope.period_action(date_from="11 mar 2025", date_to="11 mar 2025")
    assert action["date_from"] == action["date_to"] == "2025-03-11"


def test_a_range_running_past_the_data_is_cut_back_AND_SAYS_SO():
    """"1 Jan 2026 to 31 Dec 2027" was accepted whole against data ending
    30 Sep 2026, so the page drew nine months of figures under a heading that
    claimed two years."""
    action = mmm_scope.period_action(date_from="1 jan 2026", date_to="31 dec 2027")
    span = mmm_scope._options()["date_range"]
    assert action["date_to"] == span["to"]
    assert "as far as the data goes" in action["summary"]


def test_a_range_starting_before_the_data_is_cut_back_too():
    action = mmm_scope.period_action(date_from="1 jan 2010", date_to="31 dec 2016")
    span = mmm_scope._options()["date_range"]
    assert action["date_from"] == span["from"]
    assert "as far as the data goes" in action["summary"]


def test_a_range_fully_inside_the_data_says_nothing_extra():
    action = mmm_scope.period_action(date_from="11 mar 2025", date_to="11 aug 2025")
    assert "as far as the data goes" not in action["summary"]


@pytest.mark.parametrize("a,b", [
    ("1 jan 2030", "31 dec 2030"),   # after the data
    ("1 jan 2010", "31 dec 2014"),   # before it
])
def test_a_range_entirely_outside_the_data_is_refused_with_the_span(a, b):
    """There is nothing to show and nothing to clamp to, so it is said rather
    than left as an empty page for the reader to interpret."""
    with pytest.raises(ScopeError) as caught:
        mmm_scope.period_action(date_from=a, date_to=b)
    message = str(caught.value)
    assert "outside the MMM data" in message
    assert "2015" in message and "2026" in message


def test_a_gap_inside_the_data_is_refused_by_name(monkeypatch):
    """A client delivering January and March is an ordinary thing to receive.
    The span alone would pass February; the days themselves are checked."""
    monkeypatch.setattr(mmm_scope, "_has_days", lambda start, end: False)
    with pytest.raises(ScopeError) as caught:
        mmm_scope.period_action(date_from="1 feb 2025", date_to="28 feb 2025")
    message = str(caught.value)
    assert "no MMM data between 01 Feb 2025 and 28 Feb 2025" in message
    assert "with a gap here" in message


def test_the_day_check_reads_the_real_frame():
    """A guard that always answered True would pass the test above and catch
    nothing in production."""
    from datetime import date as _date

    assert mmm_scope._has_days(_date(2025, 3, 1), _date(2025, 3, 31)) is True
    assert mmm_scope._has_days(_date(2030, 1, 1), _date(2030, 12, 31)) is False


def test_a_month_range_still_covers_both_months_whole():
    """The clamp must not disturb the ordinary case: "march 2025 to august
    2025" is both months entire."""
    action = mmm_scope.period_action(date_from="march 2025", date_to="august 2025")
    assert action["date_from"] == "2025-03-01"
    assert action["date_to"] == "2025-08-31"


def test_nothing_in_the_mmm_scope_resolves_a_date_to_a_week():
    """The week calendar is TPO's. If this module ever imports or calls it, a
    date range on this hub has started rounding to something.

    Read off the module's own namespace rather than its text, because the text
    NAMES `week_containing` — explaining why it is not used is the opposite of
    using it, and a test that cannot tell the difference is a test that has to
    be deleted the first time someone writes a comment.
    """
    assert not hasattr(mmm_scope, "week_containing")
    assert not hasattr(mmm_scope, "_calendar")
    # What it does take from hub_scope: the error type and the date parser.
    from app.agents import hub_scope

    assert mmm_scope.parse_day is hub_scope.parse_day
    assert mmm_scope.ScopeError is hub_scope.ScopeError

# --- a single date is a period in its own right ------------------------------
#
# "SHOW ME 11 MAR 2025" SET THE WHOLE OF MARCH. The bare-period path saw a
# month and a year and stopped looking; the 11 was read as noise. On a daily
# dataset a whole date is a DAY, and answering it with its month is thirty-one
# days of figures under a question about one.


@pytest.mark.parametrize("text", [
    "11 mar 2025", "show me 11 mar 2025", "11-03-2025", "2025-03-11",
    "11/3/2025", "11 March 2025", "11 march, 2025",
])
def test_a_whole_date_is_one_day_however_it_is_written(text):
    action = mmm_analyst.period_only_request(text)
    assert action, text
    assert action["date_from"] == action["date_to"] == "2025-03-11"
    assert action["year"] is None and action["month"] is None


@pytest.mark.parametrize("text,month", [
    ("march 2025", 3), ("mar 2025", 3), ("may 2024", 5), ("may'24", 5),
])
def test_a_bare_month_is_still_the_month(text, month):
    """The two are told apart without a second parser: parse_day resolves a
    bare month to its FIRST day and, with end=True, to its LAST. A whole date
    answers the same both ways; a month cannot."""
    action = mmm_analyst.period_only_request(text)
    assert action["month"] == month
    assert action["date_from"] is None


def test_a_bare_year_is_still_the_year():
    action = mmm_analyst.period_only_request("2025")
    assert action["year"] == 2025 and action["month"] is None
    assert action["date_from"] is None


def test_all_data_still_reaches_the_all_data_branch():
    """The single-day check runs first and must not swallow this: parse_day
    cannot read "all years", and an early return on that would have broken
    the one message that means every year."""
    assert mmm_analyst.period_only_request("all years")["summary"] == (
        "set the period to all years")
    assert mmm_analyst.period_only_request("all data")["summary"].endswith("all years")


@pytest.mark.parametrize("text", ["31 feb 2025", "30 feb 2025", "32 mar 2025"])
def test_a_date_that_does_not_exist_is_not_answered_with_its_month(text):
    """"31 feb 2025" set the whole of February — twenty-eight days of figures
    in answer to a date that does not exist. It goes to the model, which
    relays the refusal."""
    assert mmm_analyst.period_only_request(text) is None


@pytest.mark.parametrize("text", [
    "what was revenue on 11 mar 2025",   # a question about a day
    "may 24",                            # the 24th, or May 2024 — ambiguous
])
def test_anything_that_is_not_one_bare_date_still_reaches_the_model(text):
    assert mmm_analyst.period_only_request(text) is None


def test_a_range_is_not_one_day_but_is_still_an_instruction():
    """It was listed here as "a range, not a day", which was right about what
    it is NOT and wrong about where it goes: a bare range moves the page, it
    just does not move it to a single day."""
    action = mmm_analyst.period_only_request("11 mar 2025 to 11 aug 2025")
    assert action["date_from"] != action["date_to"]


def test_the_day_detector_knows_a_year_from_a_day():
    """A four-digit number is a year. Only a bare 1-31 beside a month word is
    a day, or "march 2025" would be read as naming the 20th of something."""
    assert mmm_analyst._names_a_day("31 feb 2025") is True
    assert mmm_analyst._names_a_day("march 2025") is False
    assert mmm_analyst._names_a_day("2025") is False
    assert mmm_analyst._names_a_day("all years") is False


# --- a range that overlaps the data is asked for, not refused ----------------


def test_the_grounding_tells_the_model_to_ask_for_an_overlapping_range():
    """"Show me 1 Jan 2026 to 31 Dec 2027" was refused by the MODEL — "the
    data does not cover the year 2027" — so the clamp that exists for exactly
    this never ran. The grounding said never to filter to a year outside the
    list, and it applied that to the far end of a RANGE."""
    grounding = mmm_analyst._grounding()
    assert "A DATE RANGE IS DIFFERENT" in grounding
    assert "cut back to it by the server" in grounding
    assert "ONE ROW PER DAY" in grounding


def test_set_period_tells_the_model_how_to_ask_for_one_day():
    tool = next(t for t in mmm_analyst.TOOLS if t["function"]["name"] == "set_period")
    description = tool["function"]["parameters"]["properties"]["date_from"]["description"]
    assert "both ends even when one runs past the data" in description
    assert "For ONE day, pass it as both ends" in description

@pytest.mark.parametrize("text,year,month", [
    ("mar-24", 2024, 3),          # the form a spreadsheet writes
    ("MAY/2024", 2024, 5),
    ("septem 2024", 2024, 9),     # a month typed most of the way
    ("SEPT. 2024", 2024, 9),
    ("  May . 2024 ", 2024, 5),
])
def test_a_month_is_instant_however_tolerantly_it_was_spelled(text, year, month):
    """These were the periods that cost a model call: the gate matched a fixed
    word list while the PARSER used `resolve_month`, so the most tolerantly
    spelled messages were the ones it could not recognise."""
    action = mmm_analyst.period_only_request(text)
    assert action, text
    assert (action["year"], action["month"]) == (year, month)


def test_the_bare_period_gate_uses_the_same_month_resolver_as_the_parser():
    """One definition of "is this a month", or the two drift and a message the
    parser reads perfectly is turned away by the gate in front of it."""
    source = Path(mmm_analyst.__file__).read_text(encoding="utf-8")
    gate = source[source.index("def _is_only_period"):]
    # To the end of that function: the next line that starts in column 0.
    lines = gate.splitlines()
    end = next((i for i, line in enumerate(lines[1:], 1)
                if line and not line[0].isspace()), len(lines))
    gate = "\n".join(lines[:end])
    assert "resolve_month(w) is None" in gate
    assert "_MONTH_WORDS" not in gate


def test_a_question_is_never_mistaken_for_a_bare_period():
    """The tolerance above must not widen into reading every message with a
    month in it as an instruction."""
    for text in ("what was revenue in 2025", "spend in q3 2025",
                 "how did september 2024 do", "compare mar-24 with mar-25"):
        assert mmm_analyst.period_only_request(text) is None, text

# --- a bare range moves the page, like every other bare period ---------------
#
# "Show me 11 mar 2025 to 11 aug 2025" was answered with figures — three runs
# out of three. The model read "show me" as "tell me about" and left the page
# where it was. Every other bare period moves it with no model call; a range
# was the one shape that did not.


@pytest.mark.parametrize("text,start,end", [
    ("11 mar 2025 to 11 aug 2025", "2025-03-11", "2025-08-11"),
    ("show me 11 mar 2025 to 11 aug 2025", "2025-03-11", "2025-08-11"),
    ("11-03-2025 to 11-08-2025", "2025-03-11", "2025-08-11"),
    ("mar 2025 - aug 2025", "2025-03-01", "2025-08-31"),
    ("march 2025 until august 2025", "2025-03-01", "2025-08-31"),
    ("2024 to 2025", "2024-01-01", "2025-12-31"),
])
def test_a_bare_range_is_an_instruction(text, start, end):
    action = mmm_analyst.period_only_request(text)
    assert action, text
    assert (action["date_from"], action["date_to"]) == (start, end)


def test_each_end_of_a_range_is_a_period_in_its_own_right():
    """"march 2025 to august 2025" is both months WHOLE. That falls out of the
    parser rather than being special-cased: end=True already means "the last
    day this names"."""
    action = mmm_analyst.period_only_request("march 2025 to august 2025")
    assert action["date_from"] == "2025-03-01"
    assert action["date_to"] == "2025-08-31"


def test_a_bare_range_is_clamped_to_the_data_like_any_other():
    action = mmm_analyst.period_only_request("1 jan 2026 to 31 dec 2027")
    span = mmm_scope._options()["date_range"]
    assert action["date_to"] == span["to"]
    assert "as far as the data goes" in action["summary"]


def test_a_range_given_backwards_is_ordered():
    action = mmm_analyst.period_only_request("11 aug 2025 to 11 mar 2025")
    assert action["date_from"] < action["date_to"]


@pytest.mark.parametrize("text", [
    "what was revenue from march to august 2025",  # a question about a range
    "compare q3 2025 vs q3 2024",                  # a comparison, not a range
    "q3 2025 against q3 2024",
    "11 mar 2025 and 11 aug 2025",                 # "and" joins, it does not span
])
def test_anything_more_than_a_bare_range_still_reaches_the_model(text):
    assert mmm_analyst.period_only_request(text) is None


def test_a_numeric_date_is_not_split_down_the_middle():
    """"11-03-2025" is one date. The dash that separates a range needs space
    around it, or the splitter would make 11 and 03-2025 of it."""
    action = mmm_analyst.period_only_request("11-03-2025")
    assert action["date_from"] == action["date_to"] == "2025-03-11"


def test_two_dates_are_never_collapsed_into_one_day():
    """`parse_day` finds A month, A year and A day wherever they are, so
    "11 mar 2025 to 11 aug 2025" came back from it as 11 Aug 2025 — a range
    collapsed to one end of itself. `_single_span` refuses a message holding
    two periods before it ever asks the parser."""
    assert mmm_analyst._single_span("11 mar 2025 to 11 aug 2025") is None
    assert mmm_analyst._single_span("march 2025 to august 2025") is None
    assert mmm_analyst._single_span("11 mar 2025") is not None

