"""
The Analyst's business knowledge, and the honesty guards on its charts.

WHAT THESE TESTS ARE PROTECTING. Two failures that would not show up as a
crash, and which a reader could not catch from the answer alone:

  1. A DEFINITION THAT NO LONGER MATCHES THE CODE. `analyst_knowledge` states
     formulas in prose. If `aggregate.py` changes and the prose does not, the
     bot explains the wrong arithmetic with complete confidence. The naming
     test below is the mechanical half of that guard — it cannot read the
     prose, but it can insist every `source` names a function that still
     exists, which is what catches a renamed or deleted formula.

  2. A CHART THAT LIES ABOUT ITS OWN ARITHMETIC. A pie of Incremental Sales
     asserts the groups sum to the whole; they do not. That guard lives in one
     `if` in `analyst_charts`, and nothing in the UI would reveal its loss —
     the chart would simply render, looking exactly as trustworthy as a
     truthful one.
"""
import inspect

import pytest

from app.agents import analyst_charts as charts
from app.agents import analyst_knowledge as knowledge
from app.tpo import aggregate, config


# --- the definitions ---------------------------------------------------------


def test_every_definition_names_a_real_function():
    """A `source` pointing at a function that no longer exists means the prose
    beside it is describing arithmetic the platform stopped doing."""
    missing = []
    for key, entry in knowledge.DEFINITIONS.items():
        source = entry.get("source", "")
        if not source.startswith("aggregate."):
            continue  # a module path, not a function — nothing to resolve
        func = source.split(".", 1)[1]
        if not hasattr(aggregate, func):
            missing.append(f"{key} -> {source}")
    assert not missing, f"definitions naming functions that no longer exist: {missing}"


def test_every_definition_is_reachable_by_its_own_key():
    """A definition nobody can look up is a definition the bot will never use."""
    for key in knowledge.DEFINITIONS:
        assert knowledge.resolve_term(key) == key, f"{key} does not resolve to itself"


@pytest.mark.parametrize(
    "term,expected",
    [
        ("roi", "promotion_roi"),
        ("ROI", "promotion_roi"),
        ("break-even", "promotion_roi"),      # hyphen, not underscore
        ("breakeven", "promotion_roi"),
        ("trade spend", "trade_spend"),
        ("cannibalisation", "cannibalization_rate"),  # British spelling
        ("net profit", "net_incremental_profit"),     # not shadowed by "profit"
        ("what is the baseline", "baseline"),
    ],
)
def test_reader_phrasings_resolve(term, expected):
    assert knowledge.resolve_term(term) == expected


def test_unknown_term_returns_error_not_a_guess():
    """The bot must be able to say it has no definition. A wrong definition is
    worse than an absent one, because the reader cannot tell."""
    assert knowledge.resolve_term("quarterly synergy") is None
    result = knowledge.define("quarterly synergy")
    assert "error" in result
    assert result["defined_terms"], "the refusal should still say what IS defined"


def test_roi_definition_carries_the_live_target():
    """The hurdle is read from config, so a deployment that moved it cannot be
    described with the old number."""
    result = knowledge.define("roi")
    assert result["target"] == config.PROMOTION_TARGET_ROI
    assert "break-even" in result["judgement"]


def test_glossary_covers_every_metric():
    text = knowledge.glossary_lines()
    for key in knowledge.DEFINITIONS:
        assert key in text, f"{key} missing from the prompt glossary"


def test_trade_spend_definition_names_both_halves():
    """The single most consequential misreading in the product: Trade Spend
    includes the price cut, not just the promotion cost."""
    entry = knowledge.DEFINITIONS["trade_spend"]
    blob = f"{entry['formula']} {entry['means']}".lower()
    assert "discount" in blob and "promotion cost" in blob


# --- the chart honesty guards ------------------------------------------------


def test_pie_of_a_non_additive_metric_is_downgraded():
    """Incremental Sales re-derives its baseline per group, so its groups do
    NOT sum to the selection's total. A pie would assert that they do."""
    result = charts.build_chart(chart_type="pie", by="channel", metric="incremental_sales")
    assert result["chart"]["type"] == "bar"
    assert "note" in result, "the downgrade must be explained, not silent"


def test_pie_of_an_additive_metric_is_allowed():
    result = charts.build_chart(chart_type="pie", by="channel", metric="trade_spend")
    assert result["chart"]["type"] == "pie"


def test_stacking_faces_the_same_test_as_a_pie():
    """A stacked bar is a part-of-whole claim in a different costume."""
    result = charts.build_chart(
        chart_type="stacked", by="channel", metrics=["trade_spend", "incremental_sales"]
    )
    assert result["chart"]["type"] == "grouped"
    assert "note" in result


def test_stacking_additive_metrics_is_allowed():
    result = charts.build_chart(
        chart_type="stacked", by="channel", metrics=["trade_spend", "incremental_units"]
    )
    assert result["chart"]["type"] == "stacked"


def test_same_unit_metrics_share_one_scale():
    """Trade Spend and Incremental Sales are both money: comparing their bar
    lengths is exactly what the chart is for, so it must NOT claim independent
    scales. An earlier version compared metric names here and got this wrong
    for every grouped chart."""
    result = charts.build_chart(
        chart_type="grouped", by="channel", metrics=["trade_spend", "incremental_sales"]
    )
    assert result["chart"]["independent_scales"] is False
    assert "note" not in result


def test_mixed_unit_metrics_get_independent_scales_and_say_so():
    result = charts.build_chart(
        chart_type="grouped", by="channel", metrics=["trade_spend", "roi"]
    )
    assert result["chart"]["independent_scales"] is True
    assert "each series is scaled to its own maximum" in result["note"].lower()


def test_histogram_bars_are_counts_not_totals():
    """The height of a histogram bar is a frequency. If this ever became the
    metric total, every figure a reader took off the chart would be wrong."""
    result = charts.build_chart(chart_type="histogram", by="promotion", metric="roi")
    if "error" in result:
        pytest.skip(f"dataset cannot support this histogram: {result['error']}")
    points = result["chart"]["points"]
    assert sum(p["value"] for p in points) == result["population"]
    assert all(float(p["value"]).is_integer() for p in points)
    assert "COUNT" in result["note"]


def test_scatter_needs_two_metrics():
    result = charts.build_chart(chart_type="scatter", by="promotion", metrics=["trade_spend"])
    assert "error" in result
    assert "two metrics" in result["error"]


def test_scatter_carries_both_axes():
    result = charts.build_chart(
        chart_type="scatter", by="promotion", metrics=["trade_spend", "incremental_sales"]
    )
    if "error" in result:
        pytest.skip(f"dataset cannot support this scatter: {result['error']}")
    assert result["chart"]["x_label"] and result["chart"]["y_label"]
    assert all("x" in p and "y" in p for p in result["chart"]["points"])


def test_unknown_dimension_is_refused_with_the_real_options():
    result = charts.build_chart(chart_type="bar", by="nonsense")
    assert "error" in result
    assert "channel" in result["error"], "the refusal should name what IS chartable"


def test_group_count_never_exceeds_the_palette():
    """A seventh group would have to reuse a colour, making two different
    things look like the same thing."""
    result = charts.build_chart(chart_type="bar", by="product", metric="trade_spend", limit=99)
    assert len(result["chart"]["points"]) <= charts.MAX_GROUPS + 1  # +1 for "Other"


# --- the tool surface --------------------------------------------------------


def test_every_declared_tool_has_a_dispatch_branch():
    """A tool the model can call but the dispatcher does not know returns
    `unknown tool`, which the reader sees as a failed answer."""
    from app.agents import analyst

    declared = {t["function"]["name"] for t in analyst.TOOLS}
    source = inspect.getsource(analyst._run_tool)
    for name in declared:
        assert f'"{name}"' in source, f"{name} is declared but never dispatched"
