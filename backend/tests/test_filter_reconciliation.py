"""Filter-state reconciliation, multi-select semantics and control visibility.

The reconciliation itself lives in the frontend store
(`frontend/src/store/commandFilters.ts`). This project has no frontend test
runner, so the tests below mirror that algorithm in Python and run it against
the REAL `/filters` payloads. That is not a substitute for testing the TypeScript,
but it does pin the two things the algorithm depends on and the frontend cannot
guarantee alone:

  * the backend's option lists are context-valid and symmetric, and
  * applying "drop what is no longer offered" to any reachable state converges,
    never loops, and never discards a still-valid selection.

Everything else here (multi-select AND/OR, Distributor visibility, Promotion
Type, calendar-year periods, month resolution, row population) is pure backend
behaviour and is tested directly.
"""

from __future__ import annotations

import csv
from collections import defaultdict
from datetime import date

import pytest

from app.tpo import aggregate as A
from app.tpo import config
from app.tpo.filters import FilterState, options_for, rows_for
from app.tpo.loader import get_store

YEAR = 2025

#: Mirrors OPTION_KEY in commandFilters.ts.
OPTION_KEY = {
    "channel": "channels", "retailer": "retailers", "region": "regions",
    "state": "states", "city": "cities", "tier": "tiers",
    "distributor": "distributors", "category": "categories", "brand": "brands",
    "product": "products", "promotion": "offers", "promotion_type": "promotion_types",
}

#: Mirrors MULTI_SELECT in commandFilters.ts.
MULTI_SELECT = {"channel", "retailer", "category", "brand"}


def codes(state: FilterState, dimension: str) -> list[str]:
    raw = options_for(state)[OPTION_KEY[dimension]]
    return [x["code"] if isinstance(x, dict) else str(x) for x in raw]


def reconcile(
    selection: dict[str, list[str]], protect: str | None = None
) -> tuple[dict[str, list[str]], bool]:
    """The frontend `reconcile` action, mirrored.

    Drops any selected value the current scope no longer offers. `protect` is
    the store's `lastTouched`: everything else gives way first, and the
    protected dimension is pruned only if that resolved nothing — otherwise two
    contradictory selections would clear each other and one click would wipe an
    unrelated filter.
    """
    state = FilterState.build(**{k: v for k, v in selection.items() if v})

    def prune(skip: str | None) -> tuple[dict[str, list[str]], bool]:
        out: dict[str, list[str]] = {}
        changed = False
        for dimension, selected in selection.items():
            if dimension == skip or not selected:
                out[dimension] = selected
                continue
            available = set(codes(state, dimension))
            kept = [v for v in selected if v in available]
            out[dimension] = kept
            if len(kept) != len(selected):
                changed = True
        return out, changed

    out, changed = prune(protect)
    if not changed and protect is not None:
        out, changed = prune(None)
    return out, changed


def settle(
    selection: dict[str, list[str]], protect: str | None = None, limit: int = 25
) -> tuple[dict[str, list[str]], int]:
    """Run reconciliation to a fixed point, counting passes."""
    passes = 0
    while passes < limit:
        selection, changed = reconcile(selection, protect)
        passes += 1
        if not changed:
            return selection, passes
    raise AssertionError(f"reconciliation did not settle in {limit} passes: {selection}")


# --- 1/2. reconciliation clears invalid state, in both directions -----------


def test_1_parent_change_clears_invalid_child():
    """Channel = E-commerce alongside Region = Central resolves to no rows;
    reconciliation must drop the region."""
    settled, _ = settle({"channel": ["CH001"], "region": ["Central"]}, protect="channel")
    assert settled["channel"] == ["CH001"], "the dimension the user just set must survive"
    assert settled["region"] == [], "an unreachable region must be dropped"
    assert rows_for(FilterState.build(**{k: v for k, v in settled.items() if v}))


def test_2_child_change_clears_invalid_parent():
    """The symmetric case the old parent->child tree could not express: a geo
    selection that no longer admits the chosen channel."""
    settled, _ = settle({"region": ["Central"], "channel": ["CH001"]}, protect="region")
    assert settled["region"] == ["Central"]
    assert settled["channel"] == [], "a channel absent from the region must be dropped"


@pytest.mark.parametrize(
    "selection",
    [
        {"channel": ["CH001"], "tier": ["Tier 2"]},
        {"channel": ["CH001"], "city": ["Amritsar"]},
        {"retailer": ["Amazon"], "region": ["Central"]},
        {"tier": ["Tier 1"], "region": ["Central"]},
        {"category": ["Baby Care"], "brand": ["Cough & Cold"]},
        {"brand": ["Cough & Cold"], "product": ["P22-07ct"]},
        {"promotion_type": ["Seasonal"], "promotion": ["PR002"]},
    ],
)
def test_contradictory_states_never_survive(selection):
    """Every contradictory pair found in the audit must resolve to a scope with
    rows, whichever way round it is expressed."""
    settled, _ = settle(dict(selection))
    active = {k: v for k, v in settled.items() if v}
    assert rows_for(FilterState.build(**active)), f"{selection} settled to an empty scope: {settled}"


# --- 3. valid selections are preserved --------------------------------------


@pytest.mark.parametrize(
    "selection",
    [
        {"channel": ["CH002"], "retailer": ["D Mart"]},
        {"channel": ["CH001"], "retailer": ["Amazon", "Flipkart"]},
        {"category": ["Baby Care"], "brand": ["Baby Wipes"]},
        {"channel": ["CH003"], "region": ["South"], "tier": ["Tier 1"]},
        {"channel": ["CH001", "CH002"]},
    ],
)
def test_3_valid_selections_are_never_cleared(selection):
    settled, passes = settle(dict(selection))
    assert settled == selection, f"reconciliation discarded a valid selection: {selection} -> {settled}"
    assert passes == 1, "a fully valid selection must settle on the first pass"


# --- 4. termination ---------------------------------------------------------


@pytest.mark.parametrize(
    "selection",
    [
        {"channel": ["CH001"], "region": ["Central"], "tier": ["Tier 3"], "city": ["Amritsar"]},
        {"retailer": ["Amazon"], "distributor": ["Distributor_01"]},
        {"channel": ["CH005"], "retailer": ["D Mart"], "category": ["Baby Care"]},
        {"promotion": ["PBNY24"], "promotion_type": ["Regular"], "product": ["P22-07ct"]},
    ],
)
def test_4_reconciliation_terminates(selection):
    """Each pass strictly removes values and never adds one, so the selection
    shrinks monotonically toward the empty fixed point. Nothing can oscillate."""
    settled, passes = settle(dict(selection))
    assert passes <= 4, f"took {passes} passes: {settled}"
    again, changed = reconcile(settled)
    assert not changed and again == settled, "the fixed point is not stable"
    for dimension, values in settled.items():
        assert len(values) <= len(selection[dimension]), "reconciliation added a value"


# --- 5/6. Distributor visibility -------------------------------------------

MIN_USEFUL_OPTIONS = 2  # mirrors FilterBar.tsx


def test_5_distributor_is_hidden_with_a_single_option():
    """One distributor covering the whole B2B estate is not a choice — it
    duplicates Channel = B2B."""
    distributors = codes(FilterState.build(), "distributor")
    assert len(distributors) < MIN_USEFUL_OPTIONS, distributors
    # And it really is coextensive with CH005.
    only = rows_for(FilterState.build(distributor=distributors))
    b2b = rows_for(FilterState.build(channel=["CH005"]))
    assert sum(r.transaction_count for r in only) == sum(r.transaction_count for r in b2b)


def test_6_distributor_visibility_rule_is_driven_by_option_count():
    """The control keys off how many options exist, not off the dimension, so
    richer data brings it back automatically."""
    assert (len(codes(FilterState.build(), "distributor")) >= MIN_USEFUL_OPTIONS) is False
    assert len(codes(FilterState.build(), "region")) >= MIN_USEFUL_OPTIONS


# --- 7-11. multi-select ------------------------------------------------------


@pytest.mark.parametrize("dimension,values", [
    ("channel", ["CH001", "CH002"]),
    ("retailer", ["Amazon", "Flipkart"]),
    ("category", ["Baby Care", "Health Care"]),
    ("brand", ["Baby Wipes", "Taped Diapers"]),
])
def test_7_to_10_multi_select_is_a_union_within_a_dimension(dimension, values):
    """Values inside one dimension are ORed: the pair selects exactly the union
    of what each selects alone, and nothing more."""
    both = sum(r.transaction_count for r in rows_for(FilterState.build(year=YEAR, **{dimension: values})))
    singles = [
        sum(r.transaction_count for r in rows_for(FilterState.build(year=YEAR, **{dimension: [v]})))
        for v in values
    ]
    assert both == sum(singles), f"{dimension}={values} is not the union of its parts"
    assert dimension in MULTI_SELECT


def test_11_and_across_dimensions_or_within():
    """Across dimensions the backend must AND. Channel in (CH001, CH002) AND
    category = Baby Care is strictly narrower than the channel pair alone."""
    pair = FilterState.build(year=YEAR, channel=["CH001", "CH002"])
    narrowed = FilterState.build(year=YEAR, channel=["CH001", "CH002"], category=["Baby Care"])
    pair_rows = sum(r.transaction_count for r in rows_for(pair))
    narrowed_rows = sum(r.transaction_count for r in rows_for(narrowed))
    assert 0 < narrowed_rows < pair_rows

    store = get_store()
    for row in rows_for(narrowed):
        assert row.channel_id in {"CH001", "CH002"}          # OR held
        assert store.dims.products[row.product_id].category == "Baby Care"  # AND held


def test_multi_select_options_follow_the_union_of_selected_parents():
    """Channel = CH001 + CH002 must offer both channels' retailers, and dropping
    CH002 must leave only CH001's."""
    pair = set(codes(FilterState.build(channel=["CH001", "CH002"]), "retailer"))
    ch001 = set(codes(FilterState.build(channel=["CH001"]), "retailer"))
    ch002 = set(codes(FilterState.build(channel=["CH002"]), "retailer"))
    assert pair == ch001 | ch002

    # Removing CH002 must strand its retailers; reconciliation drops them.
    settled, _ = settle({"channel": ["CH001"], "retailer": sorted(ch001 | ch002)}, protect="channel")
    assert set(settled["retailer"]) == ch001


# --- 12. Promotion Type ------------------------------------------------------


def test_12_promotion_type_is_available_and_cascades():
    types = codes(FilterState.build(), "promotion_type")
    assert types == ["Regular", "Seasonal"]
    # It narrows the Offer list, and is narrowed by the period in turn.
    seasonal = codes(FilterState.build(promotion_type=["Seasonal"]), "promotion")
    assert seasonal and "PR001" not in seasonal
    f25_seasonal = codes(FilterState.build(year=2025, promotion_type=["Seasonal"]), "promotion")
    assert "PBNY25" in f25_seasonal and "PBNY24" not in f25_seasonal


# --- 13/14. calendar-year periods -------------------------------------------


def test_13_and_14_f24_f25_are_calendar_years():
    """Insights Hub periods are CALENDAR years. April-March fiscal semantics
    are deliberately not implemented — dim_date has no fiscal-year field."""
    from app.tpo import formatting as F

    assert F.fiscal_label(2024) == "F24"
    assert F.fiscal_label(2025) == "F25"

    store = get_store()
    for year in (2024, 2025, 2026):
        rows = rows_for(FilterState.build(year=year))
        assert {r.year for r in rows} == {str(year)}, "a period leaked into another calendar year"

    # January and December both belong to their own calendar year — which an
    # April-start fiscal year would not do.
    for month in (1, 12):
        rows = rows_for(FilterState.build(year=2025, month=month))
        assert rows and {r.year for r in rows} == {"2025"}
    # 2026 is January-August (business weeks W01-W35); its months are its own.
    assert rows_for(FilterState.build(year=2026, month=1))
    assert not rows_for(FilterState.build(year=2026, month=9))
    assert store.years() == [2024, 2025, 2026]


# --- 15. month resolution ----------------------------------------------------


def test_15_month_comes_from_year_week_via_dim_date():
    store = get_store()
    week_start = store.dims.week_start
    mismatched = sum(
        1 for i in range(store.row_count)
        if store.month[i] != week_start[(store.year[i], store.week[i])].month
    )
    assert mismatched == 0


# --- 16/17. clear-all and panel state ---------------------------------------


def test_16_clear_all_returns_to_the_unfiltered_scope():
    """Clearing every dimension but the default period must reproduce the plain
    period scope exactly."""
    baseline = rows_for(FilterState.build(year=YEAR))
    rows_for(FilterState.build(year=YEAR, channel=["CH001"], category=["Baby Care"], tier=["Tier 1"]))
    cleared = rows_for(FilterState.build(year=YEAR))
    assert cleared == baseline
    assert A.calculate_trade_spend(cleared) == A.calculate_trade_spend(baseline)


def test_17_more_filters_visibility_is_not_part_of_the_filter_state():
    """Opening or closing the panel is UI state; it must not appear in the
    filter contract, so it cannot alter a scope."""
    from app.tpo.filters import DIMENSIONS

    assert "expanded" not in DIMENSIONS
    assert "currency" not in DIMENSIONS


# --- 18. row population vs the CSV, unchanged --------------------------------


@pytest.fixture(scope="module")
def csv_rows():
    """Independent row index straight from the CSV: (year, month, channel,
    retailer). Month resolved the approved way."""
    geo = {
        r["Store_Id"].strip(): r
        for r in csv.DictReader(open(config.DATA_DIR / config.DIM_FILES["geo_store"],
                                     newline="", encoding="utf-8-sig"))
    }
    weeks = defaultdict(list)
    for r in csv.DictReader(open(config.DATA_DIR / config.DIM_FILES["date"],
                                 newline="", encoding="utf-8-sig")):
        d, m, y = r["Date"].split("-")
        weeks[(int(y), int(r["Week"]))].append(date(int(y), int(m), int(d)))
    week_start = {k: min(v) for k, v in weeks.items()}

    out = []
    for r in csv.DictReader(open(config.DATA_DIR / config.FACT_FILE,
                                 newline="", encoding="utf-8-sig")):
        year = int(r["Date"].split("-")[2])
        store = geo[r["Store_Id"].strip()]
        out.append((year, week_start[(year, int(r["Week"]))].month,
                    store["Channel_Id"].strip(), store["Retailer"].strip()))
    return out


@pytest.mark.parametrize("label,expected_filter,api_filter", [
    ("no filters", {}, {}),
    ("F24", {"year": 2024}, {"year": 2024}),
    ("F25", {"year": 2025}, {"year": 2025}),
    ("CH001", {"ch": "CH001"}, {"channel": ["CH001"]}),
    ("CH002", {"ch": "CH002"}, {"channel": ["CH002"]}),
    ("CH003", {"ch": "CH003"}, {"channel": ["CH003"]}),
    ("CH004", {"ch": "CH004"}, {"channel": ["CH004"]}),
    ("CH005", {"ch": "CH005"}, {"channel": ["CH005"]}),
    ("CH001+F25", {"ch": "CH001", "year": 2025}, {"year": 2025, "channel": ["CH001"]}),
    ("CH002+F25", {"ch": "CH002", "year": 2025}, {"year": 2025, "channel": ["CH002"]}),
    ("CH003+F25", {"ch": "CH003", "year": 2025}, {"year": 2025, "channel": ["CH003"]}),
    ("CH004+F25", {"ch": "CH004", "year": 2025}, {"year": 2025, "channel": ["CH004"]}),
    ("CH005+F25", {"ch": "CH005", "year": 2025}, {"year": 2025, "channel": ["CH005"]}),
    ("CH002+F25+March", {"ch": "CH002", "year": 2025, "month": 3},
     {"year": 2025, "channel": ["CH002"], "month": 3}),
    ("CH002+F25+D Mart", {"ch": "CH002", "year": 2025, "ret": "D Mart"},
     {"year": 2025, "channel": ["CH002"], "retailer": ["D Mart"]}),
    ("CH001+F25+Amazon", {"ch": "CH001", "year": 2025, "ret": "Amazon"},
     {"year": 2025, "channel": ["CH001"], "retailer": ["Amazon"]}),
])
def test_18_row_population_matches_the_csv(csv_rows, label, expected_filter, api_filter):
    expected = sum(
        1 for year, month, channel, retailer in csv_rows
        if (expected_filter.get("year") in (None, year))
        and (expected_filter.get("month") in (None, month))
        and (expected_filter.get("ch") in (None, channel))
        and (expected_filter.get("ret") in (None, retailer))
    )
    actual = sum(r.transaction_count for r in rows_for(FilterState.build(**api_filter)))
    assert actual == expected, f"{label}: backend {actual} vs CSV {expected}"
