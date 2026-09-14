"""The /breakdown endpoint behind every ranking and scatter chart.

Two things matter most here and are asserted first:

  * a breakdown group returns EXACTLY what filtering to that value returns —
    the partition fast path must be indistinguishable from a real re-filter, and
  * no chart may claim Incremental Sales is additive. Trade Spend is; the
    baseline is re-derived per selection, so Incremental Sales is not
    guaranteed to be, and a composition chart built on it would be false.
"""

from __future__ import annotations

import pytest

from app.tpo import aggregate as A
from app.tpo import service
from app.tpo.filters import FilterState, baseline_rows_for, rows_for

YEAR = 2025

#: Dimensions the breakdown partitions from an already-filtered row set.
FAST_DIMENSIONS = ("channel", "product", "promotion", "promotion_type", "brand", "category")
#: Dimensions that genuinely re-filter (store attributes are pooled away).
SLOW_DIMENSIONS = ("retailer", "region", "state", "city")

#: The §21 chart-scope matrix.
SCOPES = [
    ("A F25", {"year": YEAR}),
    ("B F25+CH001", {"year": YEAR, "channel": ["CH001"]}),
    ("C F25+CH002", {"year": YEAR, "channel": ["CH002"]}),
    ("D F25+Seasonal", {"year": YEAR, "promotion_type": ["Seasonal"]}),
    ("E CH002+F25+Buy3Get1", {"year": YEAR, "channel": ["CH002"], "promotion": ["PBNY25"]}),
    ("F CH001+CH002", {"year": YEAR, "channel": ["CH001", "CH002"]}),
    ("G CH001+CH002+BabyCare", {"year": YEAR, "channel": ["CH001", "CH002"], "category": ["Baby Care"]}),
    ("H CH002+D Mart", {"year": YEAR, "channel": ["CH002"], "retailer": ["D Mart"]}),
]


def _direct(state: FilterState, by: str, code: str):
    """What filtering to this group value actually produces."""
    scoped = state.replace(**{by: frozenset({code})})
    rows, volume = rows_for(scoped), baseline_rows_for(scoped)
    if not rows:
        return None
    return (
        A.calculate_trade_spend(rows),
        A.calculate_incremental_quantity(volume),
        A.calculate_incremental_sales(volume),
        A.calculate_roi(rows, volume),
        A.calculate_margin(rows),
        A.calculate_pei(rows, volume),
        A.calculate_cannibalization(volume),
    )


# --- the partition fast path must equal a real re-filter --------------------


@pytest.mark.parametrize("by", FAST_DIMENSIONS)
@pytest.mark.parametrize("label,kwargs", SCOPES, ids=[s[0] for s in SCOPES])
def test_partition_equals_refilter(by, label, kwargs):
    """The optimisation may not change a single number."""
    state = FilterState.build(**kwargs)
    payload = service.breakdown(state, by=by, limit=50)
    for group in payload["groups"]:
        expected = _direct(state, by, group["code"])
        assert expected is not None, f"{label}/{by}={group['code']}: re-filter is empty"
        actual = (
            group["trade_spend"], group["incremental_units"], group["incremental_sales"],
            group["roi"], group["margin_impact"], group["pei"], group["cannibalization"],
        )
        for i, (want, got) in enumerate(zip(expected, actual)):
            if want is None or got is None:
                assert want is got, f"{label}/{by}={group['code']} field {i}: {want} vs {got}"
            else:
                assert want == pytest.approx(got, abs=0.011), f"{label}/{by}={group['code']} field {i}"


# --- additivity -------------------------------------------------------------


@pytest.mark.parametrize("by", ["channel", "promotion", "category"])
def test_trade_spend_reconciles_to_the_kpi_card(by):
    """Trade Spend is a plain row sum, so its groups add back exactly."""
    state = FilterState.build(year=YEAR)
    payload = service.breakdown(state, by=by, limit=50)
    total = A.calculate_trade_spend(rows_for(state))
    assert sum(g["trade_spend"] for g in payload["groups"]) == pytest.approx(total, abs=0.01)


def test_share_pct_is_computed_on_trade_spend_only():
    """`share_pct` must never be derived from Incremental Sales, which is not
    reliably additive — a share built on it would be a false claim."""
    payload = service.breakdown(FilterState.build(year=YEAR), by="channel", limit=50)
    total = sum(g["trade_spend"] for g in payload["groups"])
    for group in payload["groups"]:
        assert group["share_pct"] == pytest.approx(group["trade_spend"] / total * 100, abs=0.06)
    assert sum(g["share_pct"] for g in payload["groups"]) == pytest.approx(100, abs=0.3)


# --- filter scope -----------------------------------------------------------


@pytest.mark.parametrize("label,kwargs", SCOPES, ids=[s[0] for s in SCOPES])
def test_breakdown_respects_the_filter_scope(label, kwargs):
    """A breakdown may only contain values reachable under the current filter —
    no channel may leak into another channel's scope."""
    state = FilterState.build(**kwargs)
    payload = service.breakdown(state, by="channel", limit=50)
    selected = kwargs.get("channel")
    if selected:
        assert {g["code"] for g in payload["groups"]} <= set(selected)
    for group in payload["groups"]:
        scoped = state.replace(channel=frozenset({group["code"]}))
        assert {r.channel_id for r in rows_for(scoped)} == {group["code"]}


def test_breakdown_changes_with_the_filter():
    a = service.breakdown(FilterState.build(year=YEAR), by="promotion", limit=50)
    b = service.breakdown(FilterState.build(year=2024), by="promotion", limit=50)
    assert {g["code"] for g in a["groups"]} != {g["code"] for g in b["groups"]}


# --- Top-N and truncation ---------------------------------------------------


@pytest.mark.parametrize("limit", [5, 10, 15])
def test_top_n(limit):
    payload = service.breakdown(FilterState.build(year=YEAR), by="product", limit=limit)
    assert len(payload["groups"]) == min(limit, payload["total_groups"])
    assert payload["truncated"] is (payload["total_groups"] > limit)


def test_truncated_is_false_when_everything_fits():
    payload = service.breakdown(FilterState.build(year=YEAR), by="channel", limit=15)
    assert payload["total_groups"] == 6
    assert payload["truncated"] is False


def test_default_ranking_is_incremental_sales_descending():
    """Never raw ROI: a tiny-spend promotion posts 1,398% and would top a chart
    that ranked on it."""
    payload = service.breakdown(FilterState.build(year=YEAR), by="promotion", limit=50)
    values = [g["incremental_sales"] or 0 for g in payload["groups"]]
    assert values == sorted(values, reverse=True)


def test_undefined_metric_sorts_last_not_first():
    """A null ROI is not a ranking position."""
    payload = service.breakdown(FilterState.build(year=YEAR), by="product", metric="roi", limit=50)
    rois = [g["roi"] for g in payload["groups"]]
    defined = [r for r in rois if r is not None]
    assert rois[: len(defined)] == defined


# --- currency ---------------------------------------------------------------


def test_currency_converts_display_only():
    state = FilterState.build(year=YEAR)
    inr = service.breakdown(state, by="channel", currency="INR")["groups"]
    usd = service.breakdown(state, by="channel", currency="USD")["groups"]
    for a, b in zip(inr, usd):
        assert a["trade_spend"] == b["trade_spend"], "canonical value moved with currency"
        assert a["incremental_sales"] == b["incremental_sales"]
        # Percentages and scores are never converted.
        assert a["roi"] == b["roi"]
        assert a["margin_impact"] == b["margin_impact"]
        assert a["pei"] == b["pei"]
        assert a["cannibalization"] == b["cannibalization"]
        assert a["trade_spend_display"] != b["trade_spend_display"], "display did not convert"


# --- target ROI and B2B -----------------------------------------------------


def test_target_roi_comes_from_config_not_a_literal():
    from app.tpo import config

    payload = service.breakdown(FilterState.build(year=YEAR), by="channel")
    assert payload["meta"]["target_roi"] == config.PROMOTION_TARGET_ROI


def test_b2b_has_no_retailer_groups_so_the_chart_can_hide():
    payload = service.breakdown(
        FilterState.build(year=YEAR, channel=["CH005"]), by="retailer", limit=10
    )
    assert payload["total_groups"] == 0
    assert payload["groups"] == []


def test_empty_scope_returns_no_groups():
    payload = service.breakdown(
        FilterState.build(year=YEAR, channel=["CH001"], retailer=["D Mart"]), by="channel"
    )
    assert payload["groups"] == []
    assert payload["total_groups"] == 0


# --- guards -----------------------------------------------------------------


def test_unsupported_dimension_is_rejected():
    with pytest.raises(ValueError, match="Unsupported breakdown dimension"):
        service.breakdown(FilterState.build(year=YEAR), by="store")


def test_unsupported_metric_is_rejected():
    with pytest.raises(ValueError, match="Unsupported breakdown metric"):
        service.breakdown(FilterState.build(year=YEAR), by="channel", metric="margin_impact")


@pytest.mark.parametrize("by", SLOW_DIMENSIONS)
def test_slow_path_dimensions_still_work(by):
    payload = service.breakdown(FilterState.build(year=YEAR), by=by, limit=10)
    assert payload["total_groups"] > 0
    for group in payload["groups"]:
        assert group["trade_spend"] is not None
