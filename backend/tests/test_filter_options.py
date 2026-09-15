"""Filter-option validity — the §30 test matrix.

Two properties are asserted for every filter combination, and they are the
whole point of the option generator:

  SOUNDNESS   every option offered returns at least one row when picked
  COMPLETENESS every value present in the filtered data is offered as an option

Plus the hygiene rules: no duplicates, no blanks, no whitespace variants.
"""

from __future__ import annotations

import pytest

from app.tpo import aggregate as A
from app.tpo import service
from app.tpo.filters import (
    DIMENSIONS,
    FilterState,
    baseline_rows_for,
    options_for,
    rows_for,
)
from app.tpo.loader import get_store

YEAR = 2025

#: The §30 matrix — one entry per filter shape the Insights Hub can produce.
CASES: list[tuple[str, dict]] = [
    ("1  no filters", {}),
    ("2  year", {"year": YEAR}),
    ("3  month", {"year": YEAR, "month": 3}),
    ("4  channel", {"year": YEAR, "channel": ["CH002"]}),
    ("5  retailer", {"year": YEAR, "retailer": ["D Mart"]}),
    ("6  category", {"year": YEAR, "category": ["Baby Care"]}),
    ("7  brand", {"year": YEAR, "brand": ["Taped Diapers"]}),
    ("8  product", {"year": YEAR, "product": ["P21-64ct"]}),
    ("9  offer", {"year": YEAR, "promotion": ["PR001"]}),
    ("10 region", {"year": YEAR, "region": ["South"]}),
    ("11 state", {"year": YEAR, "state": ["Karnataka"]}),
    ("12 tier", {"year": YEAR, "tier": ["Tier 1"]}),
    ("13 channel+retailer", {"year": YEAR, "channel": ["CH002"], "retailer": ["D Mart"]}),
    ("14 category+brand", {"year": YEAR, "category": ["Baby Care"], "brand": ["Baby Wipes"]}),
    ("15 brand+product", {"year": YEAR, "brand": ["Baby Wipes"], "product": ["P22-56ct"]}),
    ("16 region+state", {"year": YEAR, "region": ["South"], "state": ["Karnataka"]}),
    ("17 multiple", {"year": YEAR, "channel": ["CH003"], "category": ["Health Care"], "region": ["North"]}),
    ("18 promotion type", {"year": YEAR, "promotion_type": ["Seasonal"]}),
    ("19 F24", {"year": 2024}),
    ("20 F25", {"year": 2025}),
]

#: dimension -> the key its options arrive under in the /filters payload.
_OPTION_KEY = {
    "channel": "channels", "retailer": "retailers", "region": "regions",
    "state": "states", "city": "cities", "tier": "tiers",
    "distributor": "distributors", "category": "categories", "brand": "brands",
    "product": "products", "promotion": "offers", "promotion_type": "promotion_types",
    "month": "months", "year": "years",
}


def _codes(options: dict, dimension: str) -> list[str]:
    raw = options[_OPTION_KEY[dimension]]
    return [str(o["code"]) if isinstance(o, dict) else str(o) for o in raw]


def _labels(options: dict, dimension: str) -> list[str]:
    raw = options[_OPTION_KEY[dimension]]
    return [o["name"] if isinstance(o, dict) else str(o) for o in raw]


@pytest.mark.parametrize("name,kwargs", CASES, ids=[c[0] for c in CASES])
def test_no_duplicate_blank_or_whitespace_options(name, kwargs):
    """§4 — every list is unique, non-blank and trimmed."""
    options = options_for(FilterState.build(**kwargs))
    for dimension in _OPTION_KEY:
        labels = _labels(options, dimension)
        assert len(labels) == len(set(labels)), f"{name}: duplicate {dimension} options: {labels}"
        assert all(v and v.strip() for v in labels), f"{name}: blank {dimension} option"
        assert all(v == v.strip() for v in labels), f"{name}: untrimmed {dimension} option"


@pytest.mark.parametrize("name,kwargs", CASES, ids=[c[0] for c in CASES])
def test_every_offered_option_returns_rows(name, kwargs):
    """SOUNDNESS (§12) — picking any offered option must not empty the board."""
    state = FilterState.build(**kwargs)
    options = options_for(state)
    for dimension in ("channel", "retailer", "category", "brand", "product", "promotion", "region", "tier"):
        for code in _codes(options, dimension):
            candidate = state.replace(**{dimension: frozenset({code})})
            assert rows_for(candidate), f"{name}: {dimension}={code!r} is offered but returns no rows"


@pytest.mark.parametrize("name,kwargs", CASES, ids=[c[0] for c in CASES])
def test_every_present_value_is_offered(name, kwargs):
    """COMPLETENESS (§12) — nothing in the filtered data is missing from the
    dropdowns.

    Measured against `rows_for` — the user's actual SELECTION — not against the
    baseline-widened set. Under an Offer filter the widened set carries
    never-promoted packs (rank 1 is never promoted anywhere), and offering one
    of those would produce an empty result: picking Offer = PR001 with Product
    = P11-50ml selects nothing, so it must not be offered.
    """
    state = FilterState.build(**kwargs)
    options = options_for(state)
    store = get_store()
    rows = rows_for(state)
    if not rows:
        return

    present_products = {r.product_id for r in rows}
    present_brands = {r.brand_form for r in rows}
    present_channels = {r.channel_id for r in rows}
    present_offers = {r.promotion_id for r in rows if r.is_promoted}

    assert present_channels <= set(_codes(options, "channel")), f"{name}: channel missing"
    assert present_brands <= set(_codes(options, "brand")), f"{name}: brand missing"
    assert present_products <= set(_codes(options, "product")), f"{name}: product missing"
    assert present_offers <= set(_codes(options, "promotion")), f"{name}: offer missing"
    present_categories = {store.dims.products[p].category for p in present_products}
    assert present_categories <= set(_codes(options, "category")), f"{name}: category missing"


def test_offer_options_are_year_specific():
    """The seasonal calendar is year-scoped — F25 must not offer 2024's offers."""
    f24 = set(_codes(options_for(FilterState.build(year=2024)), "promotion"))
    f25 = set(_codes(options_for(FilterState.build(year=2025)), "promotion"))
    assert "PBNY24" in f24 and "PBNY24" not in f25
    assert "PBNY25" in f25 and "PBNY25" not in f24
    # The three always-on regular discounts run in both years.
    assert {"PR001", "PR002", "PR003"} <= f24 & f25


def test_offer_options_are_month_specific():
    """"New Year Savings 24" ran in January only."""
    january = set(_codes(options_for(FilterState.build(year=2024, month=1)), "promotion"))
    february = set(_codes(options_for(FilterState.build(year=2024, month=2)), "promotion"))
    assert "PBNY24" in january
    assert "PBNY24" not in february


def test_month_options_narrow_to_the_selected_offer():
    """Selecting an offer must narrow the month list to the months it runs in.

    The months are asserted against the offer's OWN weeks rather than against a
    literal, because the literal would encode whichever month semantics were in
    force when the test was written. An earlier version of this test asserted
    `["1"]` — true only under the corrupted `fact_sales.Month`. PBNY24 ("New
    Year Savings 24") in fact runs in CH002 weeks 1, 3, 4, 5, 14 and 27, and
    weeks 14 and 27 begin on 1 April and 1 July.
    """
    state = FilterState.build(year=2024, promotion=["PBNY24"])
    months = {int(m) for m in _codes(options_for(state), "month")}

    store = get_store()
    week_start = store.dims.week_start
    expected = {
        week_start[(int(r.year), int(r.week_key[-2:]))].month
        for r in rows_for(state)
        if r.is_promoted
    }

    assert months == expected, f"offered {sorted(months)}, weeks actually start in {sorted(expected)}"
    assert months < set(range(1, 13)), "a seasonal offer should not span every month"


def test_retailer_options_narrow_by_region():
    """Region = South must not offer the 17 retailers that trade elsewhere."""
    everywhere = set(_codes(options_for(FilterState.build()), "retailer"))
    south = set(_codes(options_for(FilterState.build(region=["South"])), "retailer"))
    assert south < everywhere, "region did not narrow the retailer list"
    store = get_store()
    for retailer in south:
        assert any(s.retailer == retailer and s.region == "South" for s in store.stores)


def test_tier_options_narrow_by_region():
    """West is Tier 1 only."""
    assert _codes(options_for(FilterState.build(region=["West"])), "tier") == ["Tier 1"]


def test_offer_labels_are_unique_and_from_the_description():
    """§4/§15 — the reported symptom. Promotion_Name repeats seven times over;
    Promotion_Description does not."""
    options = options_for(FilterState.build())
    labels = _labels(options, "promotion")
    assert len(labels) == len(set(labels)), f"duplicate offer labels: {labels}"
    assert "New Year Savings 24" in labels
    assert labels.count("Buy3Get1") == 0, "raw Promotion_Name leaked into the options"

    # And the mix legend must agree with the dropdown, label for label.
    store = get_store()
    mix = service.promotion_mix(FilterState.build(year=YEAR))
    for slice_ in mix["slices"]:
        assert slice_["label"] == store.dims.promotions[slice_["code"]].label


def test_a_selected_option_stays_visible():
    """A dimension's own constraint is lifted when building its own list, so
    the control still shows what is selected and its siblings."""
    state = FilterState.build(year=YEAR, channel=["CH002"])
    codes = _codes(options_for(state), "channel")
    assert "CH002" in codes
    assert len(codes) == 6, "selecting a channel collapsed the channel list to itself"


@pytest.mark.parametrize("name,kwargs", CASES, ids=[c[0] for c in CASES])
def test_all_six_kpis_share_one_population(name, kwargs):
    """§31 — every card is computed off the same selection.

    Asserted structurally: if the selection is empty every card is unavailable,
    and if it is non-empty no card may report a value while Trade Spend cannot.
    """
    state = FilterState.build(**kwargs)
    payload = service.kpis(state)
    cards = payload["kpis"]
    if not rows_for(state):
        assert all(c["value"] is None for c in cards.values()), f"{name}: value on an empty selection"
        return
    if cards["trade_spend"]["value"] is None:
        assert all(c["value"] is None for c in cards.values()), f"{name}: card outlived Trade Spend"


@pytest.mark.parametrize("name,kwargs", CASES, ids=[c[0] for c in CASES])
def test_scope_is_shared_by_every_panel(name, kwargs):
    """§32 — alerts, tables and mix never show a row outside the selection."""
    state = FilterState.build(**kwargs)
    channels = {r.channel_id for r in rows_for(state)}
    if not channels:
        return
    store = get_store()
    allowed = {store.dims.channels[c].name for c in channels if c in store.dims.channels}

    for alert in service.risk_alerts(state, limit=200)["alerts"]:
        assert alert["channel"] in allowed, f"{name}: alert from outside the scope"
    for row in service.underperforming_promotions(state, limit=200)["rows"]:
        assert row["channel"] in allowed, f"{name}: underperformer from outside the scope"
    offers = {r.promotion_id for r in baseline_rows_for(state) if r.is_promoted}
    for slice_ in service.promotion_mix(state)["slices"]:
        assert slice_["code"] in offers, f"{name}: mix slice from outside the scope"


def test_clear_all_returns_to_the_unfiltered_scope():
    """§22 — a cleared state is byte-identical to never having filtered."""
    baseline = service.kpis(FilterState.build(year=YEAR))
    service.kpis(FilterState.build(year=YEAR, channel=["CH001"], retailer=["Amazon"], category=["Baby Care"]))
    cleared = service.kpis(FilterState.build(year=YEAR))
    for key in baseline["kpis"]:
        assert baseline["kpis"][key]["value"] == cleared["kpis"][key]["value"]


def test_build_rejects_an_unknown_dimension():
    """A frontend typo must fail loudly rather than be silently ignored."""
    with pytest.raises(ValueError, match="Unknown filter dimension"):
        FilterState.build(year=YEAR, channel_id=["CH002"])


def test_widening_for_cannibalization_stays_inside_the_brand_form():
    """A Product filter widens to that SKU's Brand Form — not the catalogue."""
    state = FilterState.build(year=YEAR, product=["P22-56ct"])
    widened = state.widened_to_brand_form()
    assert widened.product is None
    assert widened.brand == frozenset({"Baby Wipes"})
    assert {r.brand_form for r in rows_for(widened)} == {"Baby Wipes"}
