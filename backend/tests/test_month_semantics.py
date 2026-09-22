"""The analytical month, and proof that deriving it changed nothing else.

`fact_sales.Month` is unusable: the CH002/CH004 generators set
`Date = Week_Start` but never re-derived Month from it, and CH002/CH004/CH005
also carry a scrambled `Date`. Together that put 46,440 of 205,920 rows (22.6%)
in the wrong month, which stranded promoted rows in months holding no
non-promoted row and left products with no baseline at all.

The month is therefore derived as (Year, Week) -> dim_date -> Week_Start.month.

The tests below split into two halves:

  * that the derivation is correct and total, and
  * that it is INERT — promotions, weeks, stores, products and every annual
    KPI are provably untouched by it.

The immutability half perturbs the month column in memory and asserts the
outputs do not move. That is a stronger statement than comparing two loads:
it shows the month cannot reach those results by any path.
"""

from __future__ import annotations

import collections
from array import array

import pytest

from app.tpo import aggregate as A
from app.tpo import filters as FL
from app.tpo import service
from app.tpo.filters import FilterState, baseline_rows_for, rows_for
from app.tpo.loader import NO_PROMOTION, get_store

YEAR = 2025
CHANNELS = ["CH001", "CH002", "CH003", "CH004", "CH005"]


@pytest.fixture(scope="module")
def store():
    return get_store()


@pytest.fixture
def perturbed(store):
    """Rotate every row's month by one, then restore.

    Any result that moves under this was reading the month; any result that
    does not, cannot be.
    """
    original = array("b", store.month)

    def apply():
        store.month[:] = array("b", [(m % 12) + 1 for m in original])
        _clear_caches()

    yield apply
    store.month[:] = original
    _clear_caches()


def _clear_caches() -> None:
    rows_for.cache_clear()
    baseline_rows_for.cache_clear()
    FL._present_values.cache_clear()
    # The service memoises its engine passes per FilterState on top of the
    # row caches, so a mutated store must drop those too.
    for cached in (service._bundle, service.promotion_events, service._period_totals, service._cannibalization_detail, service._breakdown_groups):
        cached.cache_clear()


# --- the derivation is correct and total -----------------------------------


def test_every_fact_week_resolves_in_dim_date(store):
    """The load-time assertion's precondition. If this fails the loader raises
    rather than silently misfiling a row."""
    week_start = store.dims.week_start
    unresolved = {
        (store.year[i], store.week[i])
        for i in range(store.row_count)
        if (store.year[i], store.week[i]) not in week_start
    }
    assert unresolved == set()


def test_month_equals_the_week_start_month(store):
    """Every row's month is its business week's first calendar day's month."""
    week_start = store.dims.week_start
    mismatched = sum(
        1
        for i in range(store.row_count)
        if store.month[i] != week_start[(store.year[i], store.week[i])].month
    )
    assert mismatched == 0


def test_month_is_a_pure_function_of_year_and_week(store):
    """No (Year, Week) may resolve to two different months."""
    seen: dict[tuple[int, int], int] = {}
    for i in range(store.row_count):
        key = (store.year[i], store.week[i])
        if key in seen:
            assert seen[key] == store.month[i], f"{key} resolved to two months"
        else:
            seen[key] = store.month[i]


def test_every_channel_shares_one_monthly_shape(store):
    """The corruption showed up as channels disagreeing about which month a
    week belongs to. Normalised by channel size, all five must now agree."""
    counts: dict[str, collections.Counter] = collections.defaultdict(collections.Counter)
    for i in range(store.row_count):
        counts[store.stores[store.store_code[i]].channel_id][store.month[i]] += 1

    shapes = set()
    for channel, months in counts.items():
        total = sum(months.values())
        shapes.add(tuple(round(months[m] / total, 6) for m in range(1, 13)))
    assert len(shapes) == 1, f"channels disagree on the monthly shape: {shapes}"


def test_the_twelve_months_partition_the_year(store):
    """Every row lands in exactly one month, and all twelve are present."""
    months = collections.Counter(
        store.month[i] for i in range(store.row_count) if store.year[i] == YEAR
    )
    assert set(months) == set(range(1, 13))
    assert sum(months.values()) == sum(1 for i in range(store.row_count) if store.year[i] == YEAR)


# --- the derivation is inert ------------------------------------------------


def _promotion_fingerprint(store) -> dict[str, collections.Counter]:
    """(Promotion_Id, Year, Week, Store_Id, Product_id) multiset, per channel."""
    per: dict[str, collections.Counter] = collections.defaultdict(collections.Counter)
    for i in range(store.row_count):
        st = store.stores[store.store_code[i]]
        per[st.channel_id][(
            store.promotions[store.promo_code[i]].promotion_id,
            int(store.year[i]),
            int(store.week[i]),
            st.store_id,
            store.products[store.product_code[i]].product_id,
        )] += 1
    return per


def test_promotion_assignment_is_untouched_by_month(store, perturbed):
    """Promotion_Id, Year, Week, Store_Id and Product_id cannot move."""
    before = _promotion_fingerprint(store)
    perturbed()
    after = _promotion_fingerprint(store)
    for channel in CHANNELS:
        assert before[channel] == after[channel], f"{channel}: promotion assignment moved"


def test_no_promotion_changes_week(store, perturbed):
    """Promotion_Id -> {(Year, Week)} is invariant."""

    def mapping():
        out: dict[str, set] = collections.defaultdict(set)
        for i in range(store.row_count):
            promotion = store.promotions[store.promo_code[i]]
            if promotion.promotion_id != NO_PROMOTION:
                out[promotion.promotion_id].add((int(store.year[i]), int(store.week[i])))
        return dict(out)

    before = mapping()
    perturbed()
    assert mapping() == before


def test_promotion_event_grain_is_untouched_by_month(store, perturbed):
    """The engine's own event set, keyed (product, channel, week, offer)."""

    def events():
        return {
            channel: {e.key for e in service.promotion_events(FilterState.build(year=YEAR, channel=[channel]))}
            for channel in CHANNELS
        }

    before = events()
    perturbed()
    after = events()
    for channel in CHANNELS:
        assert before[channel] == after[channel], f"{channel}: event grain moved"


def test_promotional_row_counts_are_untouched_by_month(store, perturbed):
    def counts():
        return collections.Counter(
            store.stores[store.store_code[i]].channel_id
            for i in range(store.row_count)
            if store.promoted[i]
        )

    before = counts()
    perturbed()
    assert counts() == before


@pytest.mark.parametrize("channel", CHANNELS)
def test_annual_kpis_are_untouched_by_month(store, perturbed, channel):
    """A month label cannot move a year. Trade Spend, Incremental Sales, ROI,
    PEI and Cannibalization must all be identical."""

    def bundle():
        state = FilterState.build(year=YEAR, channel=[channel])
        rows, volume = rows_for(state), baseline_rows_for(state)
        return (
            A.calculate_trade_spend(rows),
            A.calculate_incremental_sales(volume),
            A.calculate_roi(rows, volume),
            A.calculate_margin(rows),
            A.calculate_pei(rows, volume),
            A.calculate_cannibalization(volume),
        )

    before = bundle()
    perturbed()
    assert bundle() == before, f"{channel}: an annual KPI moved with the month"


def test_weekly_trend_is_untouched_by_month(store, perturbed):
    """The weekly series buckets on week_key, so it cannot move."""

    def series():
        payload = service.trend(FilterState.build(year=YEAR), "week")
        return payload["labels"], [round(v, 2) for v in payload["series"]["trade_spend"]]

    before = series()
    perturbed()
    assert series() == before


# --- the fix does what it was for -------------------------------------------


def test_march_ch002_p11_250ml_month_scope_has_no_in_scope_control():
    """KNOWN AND ACCEPTED LIMITATION — baseline scope, not a data defect.

    This test previously asserted the opposite. It passed only because the
    promotion assignment was wrong: the TPO_FINAL generators parsed dim_date
    month-first (`pd.to_datetime(..., format="mixed")` with no `dayfirst=True`),
    which scattered CH002's seasonal events across the year and left accidental
    non-promoted gaps inside a month. Correcting the generators restored the
    documented behaviour — a MONTHLY channel runs one treatment across EVERY
    business week of the month, on a disjoint product subset.

    So inside a month-filtered scope a promoted SKU now has zero non-promoted
    observations, `_volume()` correctly refuses to invent a baseline, and
    Incremental Sales is 0 (ROI 0.0) for 37 of the 120 channel-months, all in
    CH002 and CH005. The DATA is right; the baseline definition simply has no
    in-scope control to measure against. Accepted by the project owner rather
    than widening baseline scope, which is frozen.

    Drop the month filter and the same data is healthy — asserted below.
    """
    scoped = FilterState.build(year=2025, month=3, channel=["CH002"], product=["P11-250ml"])
    volume = A._volume(baseline_rows_for(scoped))

    # Promoted all five March weeks, so no control inside the month.
    assert volume.products == ()
    assert any(s["product_id"] == "P11-250ml" for s in volume.skipped)

    # Without the month filter the product measures normally.
    year_scope = FilterState.build(year=2025, channel=["CH002"], product=["P11-250ml"])
    annual = A._volume(baseline_rows_for(year_scope))
    product = next((p for p in annual.products if p.product_id == "P11-250ml"), None)
    assert product is not None, "P11-250ml has no baseline even at year scope"
    assert product.non_promoted_rows > 0
    assert product.promoted_rows > 0
    assert product.baseline_average > 0


def test_months_sum_to_the_year_in_rows(store):
    """Every row of the year lands in exactly one month bucket, so the twelve
    month selections must partition the annual selection."""
    annual = rows_for(FilterState.build(year=YEAR))
    annual_source = sum(r.transaction_count for r in annual)
    monthly_source = sum(
        sum(r.transaction_count for r in rows_for(FilterState.build(year=YEAR, month=m)))
        for m in range(1, 13)
    )
    assert monthly_source == annual_source


def test_trade_spend_is_additive_across_months():
    """Trade Spend is a plain row sum, so the twelve months must add to the
    year exactly. (Incremental Sales deliberately does not — each month is
    measured against its own baseline; see test_command_center.)"""
    annual = A.calculate_trade_spend(rows_for(FilterState.build(year=YEAR)))
    monthly = sum(
        A.calculate_trade_spend(rows_for(FilterState.build(year=YEAR, month=m))) or 0.0
        for m in range(1, 13)
    )
    assert annual == pytest.approx(monthly)


def test_the_declared_cadence_agrees_with_the_fact_files_schedule():
    """`promo_calendar.CADENCE` is a DECLARATION, not an inference from the
    transaction pattern — but it must still match what the data records.

    Read straight from the CSV, because `FactStore` does not carry `Schedule`:
    the column is not part of any KPI, only of the planning cadence.

    This assertion lived in `test_target_rescue.py` until the three-mode
    Simulation Studio was removed on 2026-09-22. The module it guards
    (`promo_calendar`) is still live, so the check moved here rather than
    going with it.
    """
    import csv

    from app.tpo import config
    from app.tpo.promo_calendar import CADENCE, DEFAULT_CADENCE

    seen: dict[str, set[str]] = {}
    with open(config.DATA_DIR / "fact_sales_2024_2025_all_channels.csv", newline="", encoding="utf-8") as fh:
        for row in csv.DictReader(fh):
            seen.setdefault(row["Channel_Id"].strip(), set()).add(row["Schedule"].strip())

    assert seen, "no fact rows were read"
    for channel, schedules in sorted(seen.items()):
        assert len(schedules) == 1, f"{channel} carries mixed schedules: {schedules}"
        declared = CADENCE.get(channel, DEFAULT_CADENCE)
        assert declared == next(iter(schedules)), (
            f"{channel}: CADENCE declares {declared}, fact_sales records {schedules}"
        )
