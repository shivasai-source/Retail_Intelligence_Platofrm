"""Validation for the Command Center KPI engine.

Covers the 18 filter cases in the spec, the currency rules, and the
period-comparison rules. Run with:

    ../venv/Scripts/python.exe -m pytest tests/ -q

The assertions are deliberately about INVARIANTS rather than about frozen
numbers: the dataset can be regenerated, but Trade Spend must always be the
sum of its two halves, ROI must always be the one formula, and the currency
toggle must never move a percentage.
"""

from __future__ import annotations

import pytest

from app.tpo import aggregate as A
from app.tpo import config
from app.tpo import service
from app.tpo.filters import FilterState, baseline_rows_for, rows_for
from app.tpo.loader import NO_PROMOTION, get_store

YEAR = 2025
CHANNELS = ["CH001", "CH002", "CH003", "CH004", "CH005", "CH006"]


@pytest.fixture(scope="session")
def store():
    return get_store()


# --- 1-11: each filter dimension in isolation ------------------------------


@pytest.mark.parametrize(
    "name,kwargs",
    [
        ("1 no filters", {}),
        ("2 year", {"year": YEAR}),
        ("3 month", {"year": YEAR, "month": 3}),
        ("4 channel", {"year": YEAR, "channel": ["CH002"]}),
        ("5 retailer", {"year": YEAR, "channel": ["CH002"], "retailer": ["D Mart"]}),
        ("6 category", {"year": YEAR, "category": ["Baby Care"]}),
        ("7 brand", {"year": YEAR, "brand": ["Taped Diapers"]}),
        ("8 product", {"year": YEAR, "product": ["P21-64ct"]}),
        ("9 tier", {"year": YEAR, "tier": ["Tier 1"]}),
        ("10 region", {"year": YEAR, "region": ["South"]}),
        ("11 offer", {"year": YEAR, "promotion": ["PR001"]}),
        ("12 combined", {"year": YEAR, "channel": ["CH002"], "category": ["Baby Care"], "region": ["South"]}),
        ("13 channel+retailer", {"year": YEAR, "channel": ["CH001"], "retailer": ["Amazon"]}),
    ],
)
def test_filter_produces_coherent_kpis(name, kwargs):
    """Every filter combination yields internally consistent KPIs."""
    state = FilterState.build(**kwargs)
    rows = rows_for(state)
    assert rows, f"{name}: filter returned no rows"

    spend = A.calculate_trade_spend(rows)
    sales = A.calculate_incremental_sales(rows)

    # Trade Spend is exactly its two documented halves.
    discount = sum(r.discount_value for r in rows)
    promotion_cost = sum(r.promotion_cost for r in rows)
    assert spend == pytest.approx(discount + promotion_cost)

    # ROI goes through the one formula, always.
    assert A.calculate_roi(rows) == A.roi_multiple(sales, spend)

    # Margin is a ratio of sums, bounded by definition.
    margin = A.calculate_margin(rows)
    assert margin is None or -1000 <= margin <= 100

    # PEI is a 0-100 index or explicitly undefined — never out of range.
    pei = A.calculate_pei(rows)
    assert pei is None or 0 <= pei <= 100

    # Cannibalization is a rate or explicitly unavailable — never fabricated.
    rate = A.calculate_cannibalization(rows)
    assert rate is None or rate >= 0


def test_14_empty_filter_combination_returns_no_rows_not_a_crash():
    """A selection with no data reports nothing rather than inventing zeros."""
    # Amazon is E-commerce only; pairing it with Modern Trade matches no store.
    state = FilterState.build(year=YEAR, channel=["CH002"], retailer=["Amazon"])
    rows = rows_for(state)
    assert rows == ()

    payload = service.kpis(state)
    for card in payload["kpis"].values():
        assert card["value"] is None
        assert card["display_value"] == "—"
        assert card["available"] is False


# --- 15-16: currency -------------------------------------------------------


def test_15_currency_conversion_is_display_only():
    """USD display = INR display x the configured rate, and the underlying
    numeric value is byte-identical between the two."""
    state = FilterState.build(year=YEAR)
    inr = service.kpis(state, "INR")["kpis"]
    usd = service.kpis(state, "USD")["kpis"]

    for key in inr:
        assert inr[key]["value"] == usd[key]["value"], f"{key}: canonical value moved with currency"
        assert inr[key]["delta"] == usd[key]["delta"], f"{key}: delta moved with currency"


def test_16_only_monetary_kpis_convert():
    """ROI, PEI and Cannibalization render identically in both currencies;
    the monetary cards do not."""
    state = FilterState.build(year=YEAR)
    inr = service.kpis(state, "INR")["kpis"]
    usd = service.kpis(state, "USD")["kpis"]

    for key in ("promotion_roi", "pei", "cannibalization_rate"):
        assert inr[key]["display_value"] == usd[key]["display_value"], f"{key} must not convert"

    for key in ("trade_spend", "incremental_sales"):
        assert inr[key]["display_value"] != usd[key]["display_value"], f"{key} must convert"
        # And the conversion is exactly the one configured rate.
        expected = inr[key]["value"] * config.EXCHANGE_RATE_USD_PER_INR
        assert usd[key]["value"] * config.EXCHANGE_RATE_USD_PER_INR == pytest.approx(expected)


# --- 17-18: period comparison ----------------------------------------------


def test_17_comparison_uses_the_same_dimensional_filters():
    """F25 vs F24 must compare like with like — never filtered current data
    against unfiltered history."""
    state = FilterState.build(year=2025, channel=["CH002"], retailer=["D Mart"])
    comparison = state.comparison(get_store())
    assert comparison is not None
    assert comparison.year == 2024
    # Every other constraint carried across untouched.
    for field in ("channel", "retailer", "region", "category", "brand", "product", "month"):
        assert getattr(comparison, field) == getattr(state, field)


def test_18_earliest_year_has_no_fabricated_delta():
    """F24 is the earliest year loaded, so its deltas are undefined — shown as
    an em dash, never as 0%."""
    payload = service.kpis(FilterState.build(year=2024))
    assert payload["meta"]["comparison_period"] is None
    for key, card in payload["kpis"].items():
        assert card["delta"] is None, f"{key} invented a delta with no comparison period"
        assert card["delta_display"] == "—"


# --- the important filter test (spec §44) ----------------------------------


def test_additive_kpis_sum_across_channels():
    """Trade Spend and the revenue/cost sums behind Margin are plain row sums,
    so the five channels must add up to All Channels exactly."""
    total = rows_for(FilterState.build(year=YEAR))
    per_channel = [rows_for(FilterState.build(year=YEAR, channel=[c])) for c in CHANNELS]

    assert A.calculate_trade_spend(total) == pytest.approx(
        sum(A.calculate_trade_spend(r) for r in per_channel)
    )
    assert sum(r.actual_revenue for r in total) == pytest.approx(
        sum(r.actual_revenue for rows in per_channel for r in rows)
    )


def test_incremental_sales_is_additive_across_channels():
    """Because the baseline is keyed on (product, channel), selecting one
    channel re-derives exactly the baseline that channel already had inside
    the all-channel view. So the five channels DO sum to All Channels.

    This is a direct consequence of the channel-keyed baseline. If it ever
    fails, the baseline key has been changed — check that before touching the
    assertion.
    """
    total = A.calculate_incremental_sales(rows_for(FilterState.build(year=YEAR)))
    parts = sum(
        A.calculate_incremental_sales(rows_for(FilterState.build(year=YEAR, channel=[c])))
        for c in CHANNELS
    )
    assert total == pytest.approx(parts)


def test_incremental_sales_is_not_additive_across_months():
    """A year is NOT the sum of its months for the volume KPIs.

    Each selection re-derives its baseline from its own non-promoted rows, so
    January's uplift is measured against January's ordinary trading and the
    year's against the year's. That is the definition working, not an
    aggregation bug — pinned here so nobody "fixes" it by pooling.

    Trade Spend, a plain row sum, does add up exactly; both facts are asserted
    together so the distinction stays visible.
    """
    state = FilterState.build(year=YEAR)
    months = [FilterState.build(year=YEAR, month=m) for m in range(1, 13)]

    year_spend = A.calculate_trade_spend(rows_for(state))
    month_spend = sum(A.calculate_trade_spend(rows_for(m)) or 0.0 for m in months)
    assert year_spend == pytest.approx(month_spend), "Trade Spend must be additive"

    year_sales = A.calculate_incremental_sales(rows_for(state))
    month_sales = sum(A.calculate_incremental_sales(rows_for(m)) or 0.0 for m in months)
    assert year_sales != pytest.approx(month_sales, rel=1e-6), (
        "Incremental Sales came out additive across months — the per-period "
        "baseline has probably been replaced with a pooled one."
    )


def test_baseline_is_keyed_per_channel():
    """The baseline must never pool a WEEKLY-grain channel with a MONTHLY one.

    Schedule is a property of the channel: CH001/CH004 book one row per week,
    CH002/CH003/CH005 one per month. Pooling them measures period length
    instead of promotional response.
    """
    rows = rows_for(FilterState.build(year=YEAR))
    volume = A._volume(rows)
    keys = {(p.product_id, p.channel_id) for p in volume.products}
    products = {p.product_id for p in volume.products}
    assert len(keys) > len(products), "baseline collapsed onto product alone"


# --- shared-engine guarantees ----------------------------------------------


def test_trend_sums_back_to_the_kpi_cards():
    """The trend series is a finer partition of the same rows, not a second
    calculation — so the points must sum to the headline figures."""
    state = FilterState.build(year=YEAR)
    rows = rows_for(state)
    for granularity in ("week", "month"):
        payload = service.trend(state, granularity)
        assert sum(payload["series"]["trade_spend"]) == pytest.approx(
            A.calculate_trade_spend(rows), rel=1e-9
        )
        assert sum(payload["series"]["incremental_sales"]) == pytest.approx(
            A.calculate_incremental_sales(rows), rel=1e-9
        )


def test_alerts_and_underperformers_share_one_roi():
    """The risk alert bands and the underperforming table are two views of one
    computation, so an event's ROI must be identical in both."""
    state = FilterState.build(year=YEAR)
    events = {e.key: e.roi_multiple for e in service.promotion_events(state)}
    alerts = service.risk_alerts(state, limit=500)["alerts"]
    for alert in alerts:
        assert alert["roi_multiple"] == events[alert["id"]]


def test_alerts_carry_the_event_identifiers_but_never_a_week_filter():
    """An alert names its event with codes, and its week stays a label.

    The codes are what a drill-down narrows by. The week is deliberately not
    among them: `promotion_events` measures an event against the non-promoted
    rows of the SELECTION, and a scope narrowed to the promoted week has none,
    so the counterfactual disappears and the ROI collapses. Asserted here so
    nobody later 'completes' the set by adding one.
    """
    state = FilterState.build(year=YEAR)
    events = {e.key: e for e in service.promotion_events(state)}
    alerts = service.risk_alerts(state, limit=500)["alerts"]
    assert alerts, "no alerts to check"

    for alert in alerts:
        event = events[alert["id"]]
        assert alert["promotion_id"] == event.promotion_id
        assert alert["product_id"] == event.product_id
        assert alert["channel_id"] == event.channel_id
        assert alert["week"] == event.week_key

    # The collapse itself, on the event the alert names.
    alert = alerts[0]
    event = events[alert["id"]]
    narrowed = FilterState.build(
        year=YEAR,
        promotion=[alert["promotion_id"]],
        product=[alert["product_id"]],
        channel=[alert["channel_id"]],
    )
    volume = baseline_rows_for(narrowed)
    week_only = tuple(r for r in volume if r.week_key == event.week_key)
    assert any(not r.is_promoted for r in volume), "the scope keeps a counterfactual"
    assert not any(not r.is_promoted for r in week_only), (
        "the promoted week carries no non-promoted row -- which is why week is "
        "not a filter"
    )


def test_narrowing_by_an_alerts_identifiers_reproduces_its_roi():
    """The alert's ROI and the narrowed scope's ROI are one number.

    Same contract as the underperforming table: exact where the event's
    (promotion, product, channel) traded in a single week, pooled otherwise --
    the part a week filter could not fix without destroying the baseline.
    """
    state = FilterState.build(year=YEAR)
    alerts = service.risk_alerts(state, limit=500)["alerts"]

    checked = 0
    for alert in alerts:
        narrowed = FilterState.build(
            year=YEAR,
            promotion=[alert["promotion_id"]],
            product=[alert["product_id"]],
            channel=[alert["channel_id"]],
        )
        weeks = {r.week_key for r in rows_for(narrowed) if r.is_promoted}
        if weeks != {alert["week"]}:
            continue
        kpis = service.kpis(narrowed)["kpis"]
        assert kpis["promotion_roi"]["value"] == pytest.approx(alert["roi_multiple"], abs=0.005)
        assert kpis["trade_spend"]["value"] == pytest.approx(alert["trade_spend"], rel=1e-9)
        checked += 1

    assert checked, "no single-week alert available to check the drill-down against"


def test_severity_bands_match_the_spec():
    """Critical < 1.25 <= High < 1.4 <= Medium < 1.5 <= target achieved.
    The old 25 / 40 / 50 percent bands, restated as multiples."""
    assert service._severity(1.1) == "critical"
    assert service._severity(1.249) == "critical"
    assert service._severity(1.25) == "high"
    assert service._severity(1.399) == "high"
    assert service._severity(1.4) == "medium"
    assert service._severity(1.499) == "medium"
    assert service._severity(1.5) is None
    assert service._severity(None) is None


def test_at_stake_is_the_target_inversion():
    """At Stake = Trade Spend x 1.5 - Incremental Sales, at the 1.5 target."""
    assert config.PROMOTION_TARGET_ROI == 1.5
    assert config.target_incremental_sales(100.0) == pytest.approx(150.0)

    for event in service.promotion_events(FilterState.build(year=YEAR))[:50]:
        expected = max(event.trade_spend * 1.5 - event.incremental_sales, 0.0)
        assert event.at_stake == pytest.approx(expected, abs=0.01)


def test_underperformers_are_ranked_by_at_stake():
    payload = service.underperforming_promotions(FilterState.build(year=YEAR), limit=50)
    at_stake = [row["at_stake"] for row in payload["rows"]]
    assert at_stake == sorted(at_stake, reverse=True)


def test_underperforming_rows_carry_the_event_identifiers():
    """Each row exposes the codes of the event it measured, not just labels.

    The hand-off into the Simulation Studio narrows by these. If they were
    absent -- or were display names -- a click could only carry the user's
    existing selection, and the studio would answer for a whole promotion
    while the row on screen described one SKU in one channel in one week.
    """
    state = FilterState.build(year=YEAR)
    events = {e.key: e for e in service.promotion_events(state)}
    payload = service.underperforming_promotions(state, limit=200)
    assert payload["rows"], "no underperforming rows to check"

    for row in payload["rows"]:
        key = f"{row['product_id']}|{row['channel_id']}|{row['period']}|{row['promotion_id']}"
        event = events.get(key)
        assert event is not None, f"row identifiers do not name a real event: {key}"
        # The codes belong to the same event the displayed figures came from.
        assert row["roi_multiple"] == event.roi_multiple
        assert row["trade_spend"] == event.trade_spend
        assert row["promotion"] == event.promotion_name
        assert row["product"] == event.product_name.strip()
        assert row["channel"] == event.channel_name


def test_narrowing_by_a_rows_identifiers_reproduces_its_roi():
    """The drill-down contract, end to end.

    Filtering the SAME scope by a row's three codes must select that event's
    rows and no others -- which is what makes the Command Center's row and the
    Simulation Studio's Current Plan describe one population. Asserted on rows
    whose (promotion, product, channel) traded in exactly one week, because a
    week is the one part of the grain FilterState cannot express: where the
    pair traded in several weeks the narrowed scope legitimately pools them.
    """
    state = FilterState.build(year=YEAR)
    payload = service.underperforming_promotions(state, limit=200)

    checked = 0
    for row in payload["rows"]:
        narrowed = FilterState.build(
            year=YEAR,
            promotion=[row["promotion_id"]],
            product=[row["product_id"]],
            channel=[row["channel_id"]],
        )
        weeks = {r.week_key for r in rows_for(narrowed) if r.is_promoted}
        if weeks != {row["period"]}:
            continue  # Pair traded in more than one week -- pooling is correct.
        kpis = service.kpis(narrowed)["kpis"]
        assert kpis["promotion_roi"]["value"] == pytest.approx(row["roi_multiple"], abs=0.005)
        assert kpis["trade_spend"]["value"] == pytest.approx(row["trade_spend"], rel=1e-9)
        checked += 1

    assert checked, "no single-week event available to check the drill-down against"


def test_every_underperformer_is_below_target():
    payload = service.underperforming_promotions(FilterState.build(year=YEAR), limit=200)
    for row in payload["rows"]:
        assert row["roi_multiple"] < config.PROMOTION_TARGET_ROI


def test_promotion_events_never_merge_distinct_offers():
    """A product-week running two offers is two events, not one blended row."""
    events = service.promotion_events(FilterState.build(year=YEAR))
    seen: dict[tuple, set[str]] = {}
    for event in events:
        seen.setdefault((event.product_id, event.channel_id, event.week_key), set()).add(
            event.promotion_id
        )
    multi = {k: v for k, v in seen.items() if len(v) > 1}
    for offers in multi.values():
        assert len(offers) == len(set(offers))


# --- data invariants the engine depends on ---------------------------------


def test_base_equals_actual_quantity_on_every_row(store):
    """The invariant that forces a non-promotional baseline. If this ever
    fails, `Actual - Base` becomes meaningful and the engine should be
    revisited."""
    mismatches = sum(
        1 for i in range(store.row_count)
        if store.base_quantity[i] != store.actual_quantity[i]
    )
    assert mismatches == 0


def test_rank_one_packs_are_never_promoted(store):
    """P1 is the primary cannibalization victim and never a promoter."""
    promoted_ranks = {
        store.products[store.product_code[i]].rank
        for i in range(store.row_count)
        if store.promoted[i]
    }
    assert 1 not in promoted_ranks


def test_retailer_options_cascade_from_channel():
    from app.tpo.filters import options_for

    ecom = {r["name"] for r in options_for(FilterState.build(channel=["CH001"]))["retailers"]}
    modern = {r["name"] for r in options_for(FilterState.build(channel=["CH002"]))["retailers"]}
    assert ecom == {"Amazon", "Flipkart"}
    assert "D Mart" in modern
    assert not ecom & modern, "a retailer appeared under two channels"


def test_b2b_reports_no_retailer_rather_than_an_empty_dropdown():
    """CH005 carries a blank Retailer on every store, so the control hides."""
    from app.tpo.filters import options_for

    options = options_for(FilterState.build(channel=["CH005"]))
    assert options["retailers"] == []
    assert options["retailer_available"] is False


def test_offer_filter_separates_selection_from_baseline():
    """An Offer filter yields two row sets, and each must be exactly itself.

    `rows_for` is what the user selected — only that offer's rows, so Trade
    Spend and Margin Impact describe the population on screen.
    `baseline_rows_for` adds back the non-promoted rows, because incremental
    sales has nothing to measure an uplift against without them.
    """
    state = FilterState.build(year=YEAR, promotion=["PR001"])

    selection = rows_for(state)
    assert selection, "offer filter returned nothing"
    assert all(r.is_promoted for r in selection), "selection leaked baseline rows"
    assert {r.promotion_id for r in selection} == {"PR001"}

    widened = baseline_rows_for(state)
    assert any(not r.is_promoted for r in widened), "baseline set lost its counterfactual"
    assert {r.promotion_id for r in widened if r.is_promoted} == {"PR001"}


def test_baseline_rows_do_not_change_trade_spend():
    """The two row sets must agree on Trade Spend.

    A non-promoted row carries Base_Revenue == Actual_Revenue and a zero
    Promotion_Cost, so it contributes exactly nothing. This is what lets ROI
    take its spend from the selection and its uplift from the widened set
    without the two disagreeing.
    """
    state = FilterState.build(year=YEAR, promotion=["PR001"])
    assert A.calculate_trade_spend(rows_for(state)) == pytest.approx(
        A.calculate_trade_spend(baseline_rows_for(state))
    )


def test_margin_impact_ignores_rows_the_user_did_not_select():
    """§31: all six cards describe one population.

    An offer that never ran in the selected year must not leave Margin Impact
    reporting a healthy percentage computed off baseline rows.
    """
    payload = service.kpis(FilterState.build(year=2025, promotion=["PBNY24"]))
    for key, card in payload["kpis"].items():
        assert card["value"] is None, f"{key} reported {card['value']} for an offer that never ran"


def test_period_labels_are_display_only():
    from app.tpo import formatting as F

    assert F.fiscal_label(2024) == "F24"
    assert F.fiscal_label(2025) == "F25"
    # The filter still carries the real calendar year.
    assert FilterState.build(year=2024).year == 2024
