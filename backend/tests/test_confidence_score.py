"""The evidence score, and the figures that used to be asserted instead.

WHAT THESE PROVE. Four numbers this platform renders as percentages beside
measured KPIs — a finding's confidence, the synthesis's, the Intelligence
Analyst's and each recommendation's — are computed from the evidence the agent
worked from, not written by the agent. Plus the two figures fixed alongside
them: the Analyst's driver weights and the graph node's delta.

The load-bearing test is `test_no_agent_schema_asks_for_a_confidence`. Every
other guarantee here can be re-established by reading the formulas; that one
guards the thing a future edit is most likely to undo by accident, which is
putting the field back into a schema so the model starts supplying it again.

Formulas are documented in docs/CONFIDENCE_SCORE.md.

Run with:

    ../venv/Scripts/python.exe -m pytest tests/ -q
"""

from __future__ import annotations

import pytest

from app.agents.confidence import (
    OBSERVATIONS_PER_GROUP_HALF_SATURATION,
    SCORE_CEILING,
    SCORE_FLOOR,
    UNMEASURED_LEVER_FACTOR,
    analysis_confidence,
    breadth,
    completeness,
    finding_confidence,
    recommendation_confidence,
    support,
    synthesis_confidence,
    traceability,
)
from app.agents.figures import (
    computed_delta,
    numeric_provenance,
    traceable as figure_traceable,
    verified_viz_items,
)
from app.agents.intelligence_agent import RECOMMENDATION_SCHEMA, _analysis_schema
from app.agents.pipeline import FINDING_SCHEMA, SYNTHESIS_SCHEMA
from app.intelligence_engine import roi_gap_decomposition


def _breakdown(groups, scope_spend=1000.0):
    """The shape `star_tools.run_analysis` returns, which `breadth` reads."""
    return {
        "grouped_by": "promotion_mechanic",
        "selection_totals": {"trade_spend": scope_spend},
        "groups": groups,
    }


FULL = _breakdown([
    {"group": "Buy3Get1", "roi": 6.8, "trade_spend": 600.0},
    {"group": "10% Discount", "roi": 59.5, "trade_spend": 400.0},
])


def _finding(data=FULL, **over):
    finding = {
        "analysis_data": data,
        "viz_items": [{"label": "a", "value": 6.8, "tone": "accent"}],
        "metric": "Buy3Get1 6.8%",
        "headline": "",
        "body": "",
        "evidence": "",
    }
    finding.update(over)
    return finding


# --- the field is no longer the model's to supply -----------------------------


def test_no_agent_schema_asks_for_a_confidence():
    """The regression that would silently restore the old behaviour.

    A schema that lists `confidence` gets one back from the model, and the
    computed score would then be overwriting a figure the model still spent
    tokens inventing — or worse, be dropped in a later merge in favour of it.
    """
    schemas = {
        "finding": FINDING_SCHEMA,
        "synthesis": SYNTHESIS_SCHEMA,
        "recommendation": RECOMMENDATION_SCHEMA,
        "analysis": _analysis_schema(["Buy3Get1"]),
    }
    offenders = []
    for name, schema in schemas.items():
        for where, node in _walk(schema):
            if isinstance(node, dict) and "confidence" in (node.get("required") or []):
                offenders.append(f"{name}{where}")
            if isinstance(node, dict) and "confidence" in (node.get("properties") or {}):
                offenders.append(f"{name}{where}.properties")
    assert not offenders, offenders


def _walk(node, where=""):
    yield where, node
    if isinstance(node, dict):
        for key, value in node.items():
            yield from _walk(value, f"{where}.{key}")
    elif isinstance(node, list):
        for i, value in enumerate(node):
            yield from _walk(value, f"{where}[{i}]")


def test_the_analyst_cannot_express_a_driver_weight():
    """Weights are measured, so there is no field to write one in."""
    drivers = _analysis_schema(["Buy3Get1"])["properties"]["drivers"]["items"]
    assert set(drivers["required"]) == {"driver", "note"}
    assert "weight_pct" not in drivers["properties"]


# --- each component is a ratio of two measured quantities ---------------------


def test_support_is_half_at_the_stated_observations_per_group():
    K = OBSERVATIONS_PER_GROUP_HALF_SATURATION
    assert support(K, 1) == pytest.approx(0.5)
    assert support(K * 6, 6) == pytest.approx(0.5)
    assert support(0) == 0.0
    assert support(None) is None


def test_support_rises_with_observations_and_never_reaches_one():
    values = [support(n) for n in (1, 10, 100, 1_000, 205_920)]
    assert values == sorted(values)
    assert all(v < 1.0 for v in values)


def test_a_narrow_scope_is_a_census_not_a_thin_sample():
    """The bug this replaced: scoring a drill-down down for being specific.

    36 rows across 6 mechanics is the COMPLETE population for that question.
    Under the old raw-row-count rule it scored 0.067 and capped the whole
    finding near 40% however good its evidence was.
    """
    assert support(36, 6) > 0.5


def test_splitting_the_same_rows_further_lowers_support():
    """What actually threatens a lens: too few observations per group."""
    assert support(36, 6) > support(36, 30)


def test_no_evidence_base_scores_a_hundred_percent():
    """A perfect ratio on every component is still not certainty."""
    flawless = _finding()
    scored = finding_confidence(flawless, 10_000_000)
    assert scored["confidence"] == round(SCORE_CEILING * 100)
    assert scored["confidence"] < 100


def test_breadth_is_the_spend_the_lens_resolved():
    """Groups with no ROI are money the lens could not place."""
    assert breadth(FULL) == pytest.approx(1.0)
    partial = _breakdown([
        {"group": "A", "roi": 6.8, "trade_spend": 300.0},
        {"group": "B", "roi": None, "trade_spend": 700.0},
    ])
    assert breadth(partial) == pytest.approx(0.3)


def test_breadth_takes_the_weakest_breakdown_a_lens_holds():
    """A lens reasoning across two tables is limited by the thinner one."""
    payload = {"first": FULL, "second": _breakdown([
        {"group": "A", "roi": 6.8, "trade_spend": 200.0},
        {"group": "B", "roi": None, "trade_spend": 800.0},
    ])}
    assert breadth(payload) == pytest.approx(0.2)


def test_breadth_is_unmeasurable_without_a_breakdown():
    """Risk alerts and event lists have no groups; that is not a breadth of 1."""
    assert breadth({"top_alerts": [{"title": "x", "at_stake": 4.0}]}) is None


def test_completeness_counts_the_holes_the_engine_names():
    assert completeness({"a": 1.0, "b": 2.0}) == pytest.approx(1.0)
    assert completeness({"a": 1.0, "b": None}) == pytest.approx(0.5)
    # `computable: false` is how the cannibalization tool reports a brand form
    # it could not read a baseline for. It is a hole, not a value.
    assert completeness({"a": 1.0, "d": {"computable": False}}) == pytest.approx(0.5)
    assert completeness({"a": 1.0, "d": {"available": False}}) == pytest.approx(0.5)
    assert completeness({"a": 1.0, "d": {"error": "no rows matched"}}) == pytest.approx(0.5)


def test_traceability_is_the_share_of_citations_that_come_from_the_data():
    supplied = numeric_provenance(FULL)
    assert traceability(["ROI was 6.8% against 59.5%"], supplied) == pytest.approx(1.0)
    assert traceability(["ROI was 6.8% against 77.3%"], supplied) == pytest.approx(0.5)
    assert traceability(["ROI collapsed to 77.3%"], supplied) == pytest.approx(0.0)


def test_traceability_is_unmeasurable_when_nothing_checkable_was_cited():
    assert traceability(["Performance fell sharply."], numeric_provenance(FULL)) is None


# --- how the components combine ----------------------------------------------


def test_a_weak_component_cannot_be_bought_off_by_a_strong_one():
    """The point of the geometric mean, stated as a test.

    Same rows, same completeness, same traceability — only the share of money
    the lens resolved differs, and the score has to follow it.
    """
    strong = finding_confidence(_finding(FULL), 20_000)["confidence"]
    thin = finding_confidence(
        _finding(_breakdown([
            {"group": "A", "roi": 6.8, "trade_spend": 100.0},
            {"group": "B", "roi": None, "trade_spend": 900.0},
        ])),
        20_000,
    )["confidence"]
    assert strong > thin
    # Both are reported on the FLOOR..CEILING band, so the drop is read as a
    # share of the band above the floor: the thin lens keeps well under two
    # thirds of what the strong one earned, on the same rows.
    floor = round(SCORE_FLOOR * 100)
    assert (thin - floor) < 0.65 * (strong - floor), (thin, strong)


def test_a_finding_whose_figures_do_not_trace_scores_the_floor():
    """Nothing it wrote came from its table, so there is nothing behind it:
    the evidence ratio is zero, which reports as the floor of the band."""
    fabricated = _finding(
        viz_items=[{"label": "a", "value": 88.4, "tone": "accent"}],
        metric="ROI 77.3%",
        evidence="costing 41250000",
    )
    scored = finding_confidence(fabricated, 20_000)
    assert scored["confidence"] == round(SCORE_FLOOR * 100)
    assert scored["confidence_basis"]["components"]["traceability"] == 0.0


def test_the_score_is_deterministic():
    first = finding_confidence(_finding(), 20_000)
    second = finding_confidence(_finding(), 20_000)
    assert first == second


def test_every_score_carries_its_own_workings():
    """A number a reader cannot take apart is what this replaced."""
    basis = finding_confidence(_finding(), 20_000)["confidence_basis"]
    assert basis["method"] == "evidence_score_v2"
    assert set(basis["components"]) == {"support", "breadth", "completeness", "traceability"}


# --- the failed-lens case that made this worth testing ------------------------


def test_a_lens_that_could_not_run_scores_zero():
    scored = finding_confidence({"analysis_failed": True}, 20_000)
    assert scored["confidence"] == 0
    assert scored["confidence_basis"]["components"] == {}


def test_one_failed_lens_does_not_zero_the_whole_synthesis():
    """A zero inside a geometric mean takes the product to zero.

    Five sound findings beside one fetch that raised is a run with five sixths
    of its panel, not a run with no confidence at all. The absence is counted
    once, in `panel_completed`.
    """
    good = _finding()
    good.update(finding_confidence(good, 20_000))
    failed = {"analysis_failed": True}
    failed.update(finding_confidence(failed, 20_000))

    whole = synthesis_confidence([good] * 6, attempted=6)
    partial = synthesis_confidence([good] * 5 + [failed], attempted=6)
    assert 0 < partial["confidence"] < whole["confidence"]
    # Counted once, and only in the panel term.
    assert partial["confidence_basis"]["components"]["panel_completed"] == pytest.approx(5 / 6, abs=0.01)
    assert partial["confidence_basis"]["components"]["findings_evidence"] == pytest.approx(
        whole["confidence_basis"]["components"]["findings_evidence"]
    )


def test_a_smaller_panel_is_less_confident_than_a_complete_one():
    good = _finding()
    good.update(finding_confidence(good, 20_000))
    assert (
        synthesis_confidence([good] * 3, attempted=6)["confidence"]
        < synthesis_confidence([good] * 6, attempted=6)["confidence"]
    )


# --- the two derived scores ---------------------------------------------------


def _facts():
    rows = [
        {"name": "Buy3Get1", "trade_spend": 600.0, "roi_multiple": 1.1},
        {"name": "10% Discount", "trade_spend": 400.0, "roi_multiple": 1.6},
    ]
    return {
        "kpis": {"trade_spend": 1000.0},
        "by_mechanic": rows,
        "rows_in_scope": 20_000,
        "drivers": roi_gap_decomposition(rows, "promotion_mechanic"),
    }


def test_the_analyst_is_scored_on_the_facts_it_was_given():
    analysis = {
        "headline": "ROI is 1.1 on the largest mechanic",
        "narrative": "Buy3Get1 returns 1.1 against 1.6.",
        "key_insights": [],
        "drivers": [],
    }
    scored = analysis_confidence(_facts(), analysis)
    assert 0 < scored["confidence"] <= 100
    assert scored["confidence_basis"]["components"]["traceability"] == pytest.approx(1.0)


def test_a_recommendation_cannot_outrank_its_diagnosis():
    rec = {
        "rationale": "Buy3Get1 at 6.8%",
        "evidence": "6.8 against 59.5",
        "expected_impact": "",
        "simulation": {"current_value_measured": True, "proposed_value": "30%"},
    }
    # Diagnoses are reported scores, so they sit on the band themselves.
    for diagnosis in (62, 75, 90):
        assert recommendation_confidence(rec, _facts(), diagnosis)["confidence"] <= diagnosis


def test_a_proposal_is_not_scored_as_a_citation():
    """`proposed_value` is supposed to be a number the business is not at yet.

    Checking it against the facts would mark the Advisor down for proposing
    any change at all, which is the whole job.
    """
    base = {
        "rationale": "Buy3Get1 at 6.8%",
        "evidence": "6.8 against 59.5",
        "expected_impact": "",
        "simulation": {"current_value_measured": True, "proposed_value": ""},
    }
    proposing = {**base, "simulation": {**base["simulation"], "proposed_value": "37.4%"}}
    assert (
        recommendation_confidence(proposing, _facts(), 90)["confidence"]
        == recommendation_confidence(base, _facts(), 90)["confidence"]
    )


def test_an_unmeasured_lever_holds_the_recommendation_back():
    rec = {
        "rationale": "Buy3Get1 at 6.8%",
        "evidence": "6.8 against 59.5",
        "expected_impact": "",
        "simulation": {"current_value_measured": False, "proposed_value": ""},
    }
    measured = {**rec, "simulation": {**rec["simulation"], "current_value_measured": True}}
    held = recommendation_confidence(rec, _facts(), 90)["confidence"]
    full = recommendation_confidence(measured, _facts(), 90)["confidence"]
    # The factor halves the EVIDENCE, which is then reported on the band --
    # so undo the band on `full`, halve, and put it back.
    band = SCORE_CEILING - SCORE_FLOOR
    full_evidence = (full / 100 - SCORE_FLOOR) / band
    expected = round((SCORE_FLOOR + full_evidence * UNMEASURED_LEVER_FACTOR * band) * 100)
    assert held == pytest.approx(expected, abs=1)


# --- the other two figures fixed alongside the score --------------------------


def test_driver_weights_are_an_exact_decomposition():
    """Contributions sum to the gap, and the weights to 100."""
    rows = [
        {"name": "Buy3Get1", "trade_spend": 600.0, "roi_multiple": 1.1},
        {"name": "10% Discount", "trade_spend": 400.0, "roi_multiple": 1.6},
        {"name": "No Discount", "trade_spend": 0.0, "roi_multiple": None},
    ]
    decomposition = roi_gap_decomposition(rows, "promotion_mechanic")
    target = decomposition["target_roi"]
    expected = (600.0 * 1.1 + 400.0 * 1.6) / 1000.0

    assert decomposition["weighted_roi"] == pytest.approx(expected, abs=0.005)
    assert decomposition["gap"] == pytest.approx(expected - target, abs=0.005)
    assert sum(d["weight_pct"] for d in decomposition["drivers"]) == 100
    # Each contribution is reported to 0.01, so the printed parts can miss the
    # printed whole by one rounding step per driver.
    assert sum(d["contribution"] for d in decomposition["drivers"]) == pytest.approx(
        decomposition["gap"], abs=0.015
    )


def test_a_group_with_the_budget_outranks_a_worse_one_without_it():
    """The ranking the prompts asked for in words, now in the arithmetic."""
    rows = [
        {"name": "Big and mediocre", "trade_spend": 900.0, "roi_multiple": 1.3},
        {"name": "Tiny and awful", "trade_spend": 10.0, "roi_multiple": 0.2},
    ]
    drivers = roi_gap_decomposition(rows, "promotion_mechanic")["drivers"]
    assert drivers[0]["driver"] == "Big and mediocre"
    assert drivers[0]["weight_pct"] > drivers[1]["weight_pct"]


def test_prose_may_rescale_a_figure_but_a_drawn_one_may_not():
    """The split that took fabrications accepted on bars from 7.3% to 1.2%.

    "₹3.3 Cr" is a correct way to write 32,717,886.4 in a SENTENCE. It is not a
    correct way to write it in a CHART BAR: the popover prints bar values raw
    and never labels a unit, so a bar in crores beside one in rupees renders as
    comparable when it is not — and a delta cannot subtract across two scales
    either. Allowing five scales also meant five chances for a fabricated
    figure to collide with a supplied one.
    """
    supplied = numeric_provenance({"trade_spend": 32717886.4})
    assert figure_traceable(3.3, supplied) is True
    assert figure_traceable(3.3, supplied, allow_display_scales=False) is False
    # The figure itself, and its rounding, still pass at the scale it was given.
    assert figure_traceable(32717886.4, supplied, allow_display_scales=False) is True
    assert figure_traceable(32717886, supplied, allow_display_scales=False) is True


def test_chart_bars_are_checked_at_the_scale_they_were_given():
    """`verified_viz_items` must use the strict policy, not merely offer it."""
    data = _breakdown([{"group": "A", "roi": 6.8, "trade_spend": 32717886.4}])
    supplied = numeric_provenance(data)
    kept, dropped = verified_viz_items(
        [
            {"label": "raw", "value": 32717886.4, "tone": "accent"},
            {"label": "rescaled to Cr", "value": 3.3, "tone": "muted"},
        ],
        supplied,
    )
    assert [i["label"] for i in kept] == ["raw"]
    assert [i["label"] for i in dropped] == ["rescaled to Cr"]


def test_a_delta_operand_may_not_be_rescaled_either():
    """Subtracting crores from rupees yields a number in neither unit."""
    supplied = numeric_provenance({"a": 32717886.4, "b": 1000000.0})
    assert computed_delta(
        {"value": 3.3, "compared_to": 1.0, "kind": "percentage_point_gap", "label": "x"},
        supplied,
    ) == ("", "")


def test_the_node_delta_is_subtracted_here_not_by_the_model():
    supplied = numeric_provenance(FULL)
    assert computed_delta(
        {"value": 6.8, "compared_to": 59.5, "kind": "percentage_point_gap", "label": "x"},
        supplied,
    ) == ("-52.7 pp", "down")
    # An operand that is not in the table is not a comparison this can make.
    assert computed_delta(
        {"value": 6.8, "compared_to": 77.3, "kind": "percentage_point_gap", "label": "x"},
        supplied,
    ) == ("", "")
