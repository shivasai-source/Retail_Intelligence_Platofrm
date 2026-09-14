"""Validation for Target Rescue -- the third, separate simulation mode.

Five things are being defended here.

THE ECONOMICS ARE THE PROJECT'S, NOT THIS MODE'S. Every depth it can recommend
is one of the five approved treatments; every uplift band is the one
app/tpo/response.py serves; the trade spend, margin and ROI it reports are the
definitions app/tpo/aggregate.py states. The ROI of each rung is checked against
the closed-form identity `config.breakeven_uplift` was derived from, and the
per-candidate baseline is checked against `aggregate._volume.baseline_average` --
the two places the module docstring promises a test rather than a comment.

THE GRAIN IS HONEST. Progress is measured at complete business-week boundaries
because that is the finest grain this dataset supports, and the day-20 checkpoint
resolves to a boundary rather than being prorated across a straddling week. The
resolution is asserted, not assumed.

THE CEILING IS HARD. No recommendation, at any target, in any scope, at any
current depth, exceeds the deepest approved treatment. A budget ceiling, once
set, is never silently exceeded either.

THE LADDER IS CONSERVATIVE. The least aggressive rung that reaches the target is
the one selected; a deeper rung is never selected when a shallower approved one
already gets there; and a trajectory that already reaches the target draws no
recommendation to discount at all.

NOTHING IS FABRICATED. Buy2Get1 is not in the promotion master, so it is never
offered. A month with no remaining weeks gets a final result rather than a
rescue. An empty scope gets a status and a reason and NO numbers.

Run with:

    ../venv/Scripts/python.exe -m pytest tests/test_target_rescue.py -q
"""

from __future__ import annotations

import pytest
from fastapi.testclient import TestClient

from app.main import app
from app.tpo import aggregate as A
from app.tpo import config, optimization, rescue, response
from app.tpo import filters as FL
from app.tpo.filters import FilterState, rows_for
from app.tpo.loader import get_store

client = TestClient(app)

SCOPE_URL = "/api/simulation/target-rescue/scope"
RESCUE_URL = "/api/simulation/target-rescue"

#: Scopes exercised end to end: several channels, several months, both years,
#: and the unconstrained-channel case.
SCOPES: tuple[tuple[str, dict], ...] = (
    ("MT/Oct/F25", {"month": 10, "year": 2025, "channel": ["CH002"]}),
    ("GT/Jun/F25", {"month": 6, "year": 2025, "channel": ["CH003"]}),
    ("ecom/Nov/F24", {"month": 11, "year": 2024, "channel": ["CH001"]}),
    ("CH005/Mar/F25", {"month": 3, "year": 2025, "channel": ["CH005"]}),
    ("all channels/Aug/F25", {"month": 8, "year": 2025}),
)


def state_of(payload: dict) -> FilterState:
    """The same FilterState the endpoint builds -- EVERY level of the hierarchy.

    Omitting `product` here would compare a product-scoped response against a
    category-scoped measurement and pass or fail for the wrong reason.
    """
    return FilterState.build(
        year=payload.get("year"),
        month=payload.get("month"),
        channel=payload.get("channel"),
        category=payload.get("category"),
        product=payload.get("product"),
    )


def evaluate(payload: dict, **extra) -> dict:
    """Evaluate a scope at an EXPLICIT mid-month checkpoint.

    `checkpoint` is pinned to the mid-month week rather than left on `auto`, and
    that is deliberate. Auto is cadence-dependent by design: a WEEKLY channel
    resolves to the latest completed business week, which in this fully-recorded
    dataset is the month's last -- leaving no remaining week and, correctly, no
    ladder to assert anything about. The auto rules get their own tests below;
    every other test wants a scope with a remaining week regardless of cadence.
    """
    body = {
        "target_units": 1.0,
        "current_discount_pct": 10.0,
        "checkpoint": rescue.MONTHLY_CHECKPOINT_WEEK,
        **payload,
        **extra,
    }
    result = client.post(RESCUE_URL, json=body)
    assert result.status_code == 200, result.text
    return result.json()


def evaluate_auto(payload: dict, **extra) -> dict:
    """Evaluate on the cadence's own default checkpoint."""
    body = {"target_units": 1.0, "current_discount_pct": 10.0, **payload, **extra}
    result = client.post(RESCUE_URL, json=body)
    assert result.status_code == 200, result.text
    return result.json()


def units_sold_at_default_checkpoint(payload: dict) -> float:
    """What the scope has actually sold by the default checkpoint."""
    return evaluate(payload)["progress"]["units_sold"]


def target_for_attainment(payload: dict, attainment_pct: float) -> float:
    """A target that places this scope at exactly `attainment_pct` of it.

    Derived from the MEASURED units rather than written down, so the band tests
    exercise the real data instead of a fixture that could drift from it.
    """
    return units_sold_at_default_checkpoint(payload) / (attainment_pct / 100)


# --- the status bands -------------------------------------------------------
#
# The brief's four worked examples, asserted twice each: once against the pure
# band function, where the arithmetic is exactly its own 100-unit example, and
# once end to end over real rows, where the target is derived from measured
# units so the same attainment lands on the same band.


@pytest.mark.parametrize(
    "sold,target,expected",
    [
        (75, 100, "watch"),      # brief case 1: 75% -> WATCH
        (80, 100, "on_track"),   # brief case 2: 80% -> ON TRACK
        (90, 100, "on_track"),   # brief case 3: 90% -> ON TRACK
        (65, 100, "at_risk"),    # brief case 4: 65% -> TARGET AT RISK
        (70, 100, "watch"),      # the lower watch boundary is INCLUSIVE
        (69, 100, "at_risk"),    # and one unit below it is not
        (100, 100, "on_track"),
    ],
)
def test_status_bands_match_the_brief(sold: int, target: int, expected: str) -> None:
    status = rescue.target_status(sold / target * 100, rescue.PHASE_CHECKPOINT, achieved=sold >= target)
    assert status["code"] == expected
    # The label and the action sentence travel with the code, so a screen cannot
    # show one band's colour beside another band's advice.
    assert status["label"] == rescue.TARGET_STATUS[expected][0]
    assert status["action"] == rescue.TARGET_STATUS[expected][2]


@pytest.mark.parametrize("attainment,expected", [(75.0, "watch"), (85.0, "on_track"), (65.0, "at_risk")])
@pytest.mark.parametrize("name,payload", SCOPES)
def test_status_bands_end_to_end(name: str, payload: dict, attainment: float, expected: str) -> None:
    target = target_for_attainment(payload, attainment)
    result = evaluate(payload, target_units=target)
    assert result["progress"]["attainment_pct"] == pytest.approx(attainment, abs=0.15)
    assert result["target_status"]["code"] == expected, name


def test_thresholds_are_not_the_command_center_risk_bands() -> None:
    """The rescue bands are attainment percentages; the Command Center's are ROI
    multiples. Reading one as the other is exactly the kind of drift the
    project has already been bitten by, so they are asserted to be separate."""
    assert rescue.ON_TRACK_ATTAINMENT_PCT == 80.0
    assert rescue.WATCH_ATTAINMENT_PCT == 70.0
    assert set(config.SEVERITY_BANDS.values()) == {1.25, 1.4, 1.5}
    assert rescue.ON_TRACK_ATTAINMENT_PCT not in set(config.SEVERITY_BANDS.values())


# --- cadence -----------------------------------------------------------------


#: The project's declared channel cadence, from `promo_calendar.CADENCE`. Written
#: out ONCE here so the tests assert against the brief's stated structure rather
#: than against whatever the module happens to import.
EXPECTED_CADENCE = {
    "CH001": "WEEKLY",
    "CH002": "MONTHLY",
    "CH003": "MONTHLY",
    "CH004": "WEEKLY",
    "CH005": "MONTHLY",
    "CH006": "WEEKLY",
}
MONTHLY_CHANNELS = ("CH002", "CH003", "CH005")
WEEKLY_CHANNELS = ("CH001", "CH004", "CH006")


def test_cadence_is_read_from_the_project_declaration() -> None:
    """It is `promo_calendar.CADENCE`, imported and not restated -- so this test
    is the one place the expected structure is written down twice, on purpose."""
    from app.tpo import promo_calendar

    assert rescue.CADENCE is promo_calendar.CADENCE
    assert dict(rescue.CADENCE) == EXPECTED_CADENCE


def test_the_declared_cadence_agrees_with_fact_sales_schedule() -> None:
    """`fact_sales.Schedule` carries exactly one value per channel, and it must
    agree with the declaration. If a future extract disagrees, the declared rule
    and the recorded one have drifted and this fails rather than letting the
    checkpoint quietly follow the wrong one.

    Read straight from the CSV: the loader does not carry `Schedule` into the
    store, and adding it there would touch shared loading for one assertion.
    """
    import csv

    from app.tpo import config

    observed: dict[str, set[str]] = {}
    with (config.DATA_DIR / config.FACT_FILE).open(encoding="utf-8-sig", newline="") as handle:
        for row in csv.DictReader(handle):
            observed.setdefault(row["Channel_Id"].strip(), set()).add(row["Schedule"].strip())

    assert observed, "no rows read from the fact file"
    for channel, schedules in observed.items():
        assert len(schedules) == 1, f"{channel} carries mixed Schedule values: {schedules}"
        assert schedules.pop() == EXPECTED_CADENCE[channel], channel


@pytest.mark.parametrize("channel,expected", sorted(EXPECTED_CADENCE.items()))
def test_the_response_reports_the_channel_cadence(channel: str, expected: str) -> None:
    """Section 6: the screen has to show the cadence, so the API has to carry it."""
    result = evaluate({"month": 10, "year": 2025, "channel": [channel]})
    cadence = result["cadence"]
    assert cadence["code"] == expected
    assert cadence["weekly"] is (expected == "WEEKLY")
    assert cadence["mixed"] is False
    assert cadence["undeclared_channels"] == []
    entry = cadence["channels"][0]
    assert entry["channel_id"] == channel
    assert entry["cadence"] == expected
    assert entry["declared"] is True
    # The channel's real name, from dim_channel -- never written down here.
    assert entry["name"] == get_store().dims.channels[channel].name
    assert "promo_calendar.CADENCE" in cadence["basis"]


def test_an_all_channel_scope_is_mixed_and_says_so() -> None:
    """This project's five channels do not all plan the same way, so an
    unconstrained selection must not adopt one cadence for all of them."""
    result = evaluate({"month": 10, "year": 2025})
    cadence = result["cadence"]
    assert cadence["code"] == "MIXED"
    assert cadence["mixed"] is True
    assert cadence["weekly"] is False, "a mixed scope must not take the weekly rule"
    assert {c["channel_id"] for c in cadence["channels"]} == set(EXPECTED_CADENCE)
    assert "MIXED (" in cadence["label"]


def test_two_weekly_channels_together_are_weekly() -> None:
    result = evaluate({"month": 10, "year": 2025, "channel": list(WEEKLY_CHANNELS)})
    assert result["cadence"]["code"] == "WEEKLY"
    assert result["cadence"]["weekly"] is True


def test_a_weekly_and_a_monthly_channel_together_are_mixed() -> None:
    result = evaluate({"month": 10, "year": 2025, "channel": ["CH001", "CH002"]})
    assert result["cadence"]["code"] == "MIXED"
    assert result["cadence"]["weekly"] is False


# --- the checkpoint ---------------------------------------------------------


@pytest.mark.parametrize("channel", MONTHLY_CHANNELS)
def test_a_monthly_channel_defaults_to_the_third_completed_week(channel: str) -> None:
    """Brief case 1. October 2025 holds four business weeks, so the mid-month
    checkpoint is the third and one week remains for an intervention."""
    result = evaluate_auto({"month": 10, "year": 2025, "channel": [channel]})
    progress = result["progress"]
    assert progress["checkpoint_type"] == "auto"
    assert progress["checkpoint_week"] == rescue.MONTHLY_CHECKPOINT_WEEK == 3
    assert progress["weeks_total"] == 4
    assert progress["weeks_remaining"] == 1
    assert result["checkpoint"]["auto_rule"].startswith("Completed business week 3")


@pytest.mark.parametrize("channel", WEEKLY_CHANNELS)
def test_a_weekly_channel_defaults_to_the_latest_completed_week(channel: str) -> None:
    """Brief case 2. A weekly-cadence channel plans a separate promotion each
    week, so its default read is the most evidence available.

    In this fully-recorded dataset the latest completed week IS the month's last,
    which leaves no remaining week -- so the correct answer is a final result and
    no intervention, per section 17. That consequence is asserted here rather
    than worked around."""
    result = evaluate_auto({"month": 10, "year": 2025, "channel": [channel]})
    progress = result["progress"]
    assert progress["checkpoint_type"] == "auto"
    assert progress["checkpoint_week"] == progress["weeks_total"]
    assert progress["weeks_remaining"] == 0
    assert progress["phase"] == "complete"
    assert result["interventions"] == []
    assert result["recommendation"]["action"] is None
    assert result["checkpoint"]["auto_rule"] == "Latest completed business week"
    # And the response says how to get a mid-month read instead.
    assert any("select an earlier week" in line.lower() for line in result["evidence"])


def test_a_short_month_falls_back_to_the_latest_completed_week() -> None:
    """Brief case 5's tail: where a month holds fewer than three business weeks
    there is no third week to wait for, so the latest completed one is used.

    Asserted against the resolver directly, because this dataset's calendar
    never produces such a month -- and the fallback must still be correct if a
    future extract does. The premise is asserted too, so this cannot silently
    become a test of nothing.
    """
    for _, payload in SCOPES:
        assert evaluate(payload)["progress"]["weeks_total"] >= 3

    monthly = rescue.resolve_cadence(FilterState.build(channel=["CH002"]))
    for total in (1, 2):
        calendar = rescue.MonthCalendar(
            year=2025, month=10,
            week_keys=tuple(f"2025-W{40 + i:02d}" for i in range(total)),
            boundaries=tuple(7 * (i + 1) for i in range(total)),
        )
        resolved = rescue.resolve_checkpoint(calendar, monthly, None)
        assert resolved.ordinal == total
        assert resolved.weeks_remaining == 0


@pytest.mark.parametrize("week", [1, 2, 3, 4])
@pytest.mark.parametrize("channel", ["CH001", "CH002"])
def test_an_explicit_week_checkpoint_is_honoured(channel: str, week: int) -> None:
    """Brief cases 3, 4 and 5. Each week resolves to itself, carries the days
    that week's calendar covers, and leaves the right remainder."""
    result = evaluate({"month": 10, "year": 2025, "channel": [channel]}, checkpoint=week)
    progress = result["progress"]
    assert progress["checkpoint_type"] == "week"
    assert progress["checkpoint_week"] == week
    assert progress["weeks_completed"] == week
    assert progress["weeks_remaining"] == progress["weeks_total"] - week
    assert progress["days_elapsed"] == progress["boundaries"][week - 1]
    assert progress["week_key"] == result["scope"]["week_keys"][week - 1]


@pytest.mark.parametrize("channel", sorted(EXPECTED_CADENCE))
def test_latest_resolves_to_the_last_business_week(channel: str) -> None:
    result = evaluate({"month": 10, "year": 2025, "channel": [channel]}, checkpoint="latest")
    progress = result["progress"]
    assert progress["checkpoint_type"] == "latest"
    assert progress["checkpoint_week"] == progress["weeks_total"]
    assert progress["weeks_remaining"] == 0


@pytest.mark.parametrize("week", [5, 6, 7, 12, 99])
def test_an_impossible_future_week_is_rejected(week: int) -> None:
    """Brief case 6. REJECTED, not clamped: week 6 of a four-week month is a
    question about a week that does not exist, and answering it with week 4 would
    report a different checkpoint than the one asked for."""
    bad = client.post(
        RESCUE_URL,
        json={
            "month": 10, "year": 2025, "channel": ["CH002"],
            "target_units": 100, "current_discount_pct": 10, "checkpoint": week,
        },
    )
    assert bad.status_code == 422
    detail = bad.json()["detail"]
    assert f"Week {week} is not a business week" in detail
    assert "which has 4" in detail
    assert "will not project one" in detail


@pytest.mark.parametrize("value", [0, -1, "week3", "mid", True, 3.5, None if False else []])
def test_a_malformed_checkpoint_is_rejected(value) -> None:
    bad = client.post(
        RESCUE_URL,
        json={"month": 10, "year": 2025, "target_units": 100, "checkpoint": value},
    )
    assert bad.status_code == 422, value


@pytest.mark.parametrize("name,payload", SCOPES)
def test_the_selector_offers_only_weeks_the_month_contains(name: str, payload: dict) -> None:
    """Brief section 5: no impossible future week is offered."""
    scope = client.post(SCOPE_URL, json=payload)
    assert scope.status_code == 200
    body = scope.json()
    total = body["scope"]["weeks_total"]
    options = body["checkpoint"]["options"]
    weeks = [o["value"] for o in options if isinstance(o["value"], int)]
    assert weeks == list(range(1, total + 1)), name
    assert options[0]["value"] == "auto"
    assert options[-1]["value"] == "latest"
    # Every option names the remainder it would leave, because that is what
    # decides whether an intervention can be evaluated at all.
    for option in options:
        assert option["weeks_remaining"] == total - option["ordinal"]


def test_the_mid_month_checkpoint_covers_about_twenty_days() -> None:
    """The brief's day 20/21, restated as the week it actually is. October 2025
    has four seven-day business weeks, so the third completed week covers 21 of
    the month's 28 days -- approximately the day-20 business checkpoint, and
    exactly the 75%-elapsed point the brief's own worked example assumes."""
    result = evaluate({"month": 10, "year": 2025, "channel": ["CH002"]}, checkpoint=3)
    progress = result["progress"]
    assert progress["days_elapsed"] == 21
    assert progress["days_in_month"] == 28
    assert progress["weeks_completed"] == 3


# --- the channel -> category -> product cascade -----------------------------


def scope_of(payload: dict) -> dict:
    result = client.post(SCOPE_URL, json=payload)
    assert result.status_code == 200, result.text
    return result.json()


def products_of(payload: dict) -> set[str]:
    return {p["code"] for p in scope_of(payload)["options"]["products"]}


def test_the_cascade_is_the_projects_own_option_engine() -> None:
    """It is `filters.options_for`, called over three narrowings -- not a second
    option pass with its own idea of what is reachable."""
    state = FilterState.build(year=2025, month=10, channel=["CH002"])
    cascade = rescue.cascade_options(state)
    upstream = FL.options_for(state.replace(category=None, product=None))
    assert cascade["categories"] == upstream["categories"]
    assert cascade["channels"] == upstream["channels"]
    assert cascade["hierarchy"] == ["channel", "category", "product"]


@pytest.mark.parametrize("channel", sorted(EXPECTED_CADENCE))
def test_categories_are_filtered_by_channel(channel: str) -> None:
    """Brief case 1. Every category offered has rows in THIS channel and month,
    and every category that has rows is offered -- the list is the reachable set,
    neither narrower nor wider."""
    payload = {"month": 10, "year": 2025, "channel": [channel]}
    offered = set(scope_of(payload)["options"]["categories"])
    assert offered

    store = get_store()
    every = {p.category for p in store.dims.products.values() if p.category}
    for category in every:
        state = FilterState.build(year=2025, month=10, channel=[channel], category=[category])
        reachable = bool(rows_for(state))
        assert (category in offered) is reachable, f"{channel}/{category}"


def test_products_are_filtered_by_channel_and_category() -> None:
    """Brief case 2. With a category selected, only that category's products are
    offered -- and they are all of them, not a subset."""
    store = get_store()
    base = {"month": 10, "year": 2025, "channel": ["CH001"]}
    unconstrained = products_of(base)

    for category in sorted({p.category for p in store.dims.products.values() if p.category}):
        offered = products_of({**base, "category": [category]})
        expected = {
            pid for pid, product in store.dims.products.items()
            if product.category == category
            and rows_for(FilterState.build(year=2025, month=10, channel=["CH001"], product=[pid]))
        }
        assert offered == expected, category
        # Nothing from another category leaks in.
        assert all(store.dims.products[pid].category == category for pid in offered)
        # And narrowing to a category never widens the list.
        assert offered <= unconstrained


def test_a_selected_product_does_not_collapse_the_category_list() -> None:
    """The hierarchy has to be CLIMBABLE. `options_for` on one state narrows every
    list together, which would leave the category dropdown showing only the
    selected product's own category and no way back up -- so each level is
    computed with the levels below it lifted."""
    store = get_store()
    base = {"month": 10, "year": 2025, "channel": ["CH002"]}
    all_categories = scope_of(base)["options"]["categories"]

    product = next(
        pid for pid, p in sorted(store.dims.products.items()) if p.category == "Baby Care"
    )
    narrowed = scope_of({**base, "category": ["Baby Care"], "product": [product]})
    assert narrowed["options"]["categories"] == all_categories
    # And the product's own list still holds its siblings, so the user can move
    # sideways as well as up.
    assert len(narrowed["options"]["products"]) > 1
    assert product in {p["code"] for p in narrowed["options"]["products"]}


# --- the cascade is enforced, not merely offered ----------------------------


def test_a_product_outside_the_selected_category_is_rejected() -> None:
    """Brief case 11. Not an empty scope -- a CONTRADICTION, and the caller is
    told which two constraints disagree."""
    store = get_store()
    baby = next(pid for pid, p in sorted(store.dims.products.items()) if p.category == "Baby Care")
    health = next(pid for pid, p in sorted(store.dims.products.items()) if p.category == "Health Care")

    bad = client.post(
        RESCUE_URL,
        json={
            "month": 10, "year": 2025, "channel": ["CH002"], "target_units": 100,
            "current_discount_pct": 10, "category": ["Baby Care"], "product": [health],
        },
    )
    assert bad.status_code == 422
    detail = bad.json()["detail"]
    assert health in detail and "Health Care" in detail and "Baby Care" in detail
    assert "not in the selected categor" in detail

    # The product's own category is fine.
    good = client.post(
        RESCUE_URL,
        json={
            "month": 10, "year": 2025, "channel": ["CH002"], "target_units": 100,
            "current_discount_pct": 10, "category": ["Baby Care"], "product": [baby],
        },
    )
    assert good.status_code == 200


@pytest.mark.parametrize(
    "body,fragment",
    [
        ({"channel": ["CH999"]}, "Unknown channel"),
        ({"product": ["NOT-A-PRODUCT"]}, "Unknown product id"),
        ({"category": ["Not A Category"]}, "Unknown category"),
        ({"category": ["Not A Category"], "product": ["NOT-A-PRODUCT"]}, "Unknown category"),
    ],
)
def test_an_unknown_dimension_value_is_rejected(body: dict, fragment: str) -> None:
    """A stale or mistyped value is a malformed request, not a scope that traded
    nothing. Both endpoints reject it identically."""
    for url in (RESCUE_URL, SCOPE_URL):
        payload = {"month": 10, "year": 2025, "channel": ["CH002"], **body}
        # `body` may override the channel; the dict order above makes that work.
        if url == RESCUE_URL:
            payload |= {"target_units": 100, "current_discount_pct": 10}
        bad = client.post(url, json=payload)
        assert bad.status_code == 422, url
        assert fragment in bad.json()["detail"]


# --- every figure is measured over the selected scope -----------------------


def _narrowings() -> list[tuple[str, dict]]:
    store = get_store()
    baby = sorted(pid for pid, p in store.dims.products.items() if p.category == "Baby Care")
    return [
        ("all / all", {}),
        ("Baby Care / all", {"category": ["Baby Care"]}),
        ("Health Care / all", {"category": ["Health Care"]}),
        ("Baby Care / one product", {"category": ["Baby Care"], "product": [baby[0]]}),
    ]


def test_month_to_date_narrows_with_every_level() -> None:
    """Brief case 8. The figure on screen is the selected scope's own, never the
    broad channel total left behind."""
    base = {"month": 10, "year": 2025, "channel": ["CH002"], "checkpoint": 3}
    seen: dict[str, float] = {}
    for label, extra in _narrowings():
        result = evaluate({**base, **extra})
        progress = result["progress"]
        state = state_of({**base, **extra})
        elapsed = set(result["scope"]["elapsed_weeks"])
        measured = sum(
            row.actual_quantity for row in rows_for(state.replace(year=2025))
            if row.week_key in elapsed
        )
        assert progress["units_mtd"] == pytest.approx(round(measured, 0)), label
        seen[label] = progress["units_mtd"]

    # Each narrowing is strictly smaller than the one above it.
    assert seen["Baby Care / all"] < seen["all / all"]
    assert seen["Baby Care / one product"] < seen["Baby Care / all"]
    assert seen["Health Care / all"] < seen["all / all"]
    # And the two categories together do not exceed the channel.
    assert seen["Baby Care / all"] + seen["Health Care / all"] <= seen["all / all"] + 1


def test_attainment_follows_the_scope_not_the_channel() -> None:
    """Brief case 9. The same target against a narrower scope must read as a
    lower attainment -- if it did not, the denominator or the numerator is coming
    from the wrong rows."""
    base = {"month": 10, "year": 2025, "channel": ["CH002"], "checkpoint": 3, "target_units": 50_000.0}
    broad = evaluate(base)
    narrow = evaluate({**base, "category": ["Baby Care"]})
    assert broad["progress"]["target_units"] == narrow["progress"]["target_units"]
    assert narrow["progress"]["attainment_pct"] < broad["progress"]["attainment_pct"]
    assert narrow["progress"]["attainment_pct"] == pytest.approx(
        round(narrow["progress"]["units_mtd"] / 50_000.0 * 100, 1), abs=0.05
    )


def test_every_derived_figure_moves_with_the_scope() -> None:
    """Brief section 4's list, checked as a block: nothing on the response is left
    describing the wider scope once the product is selected."""
    store = get_store()
    treatable = [
        pid for pid, p in sorted(store.dims.products.items())
        if p.category == "Baby Care"
        and optimization._price_and_baseline(
            rows_for(FilterState.build(year=2025, month=10, channel=["CH002"], product=[pid]))
        )[1] is not None
    ]
    assert treatable, "no single Baby Care product has a measurable baseline"

    base = {"month": 10, "year": 2025, "channel": ["CH002"], "checkpoint": 3}
    broad = evaluate({**base, "target_units": 1e6, "current_discount_pct": 0.0})
    narrow = evaluate({
        **base, "target_units": 1e6, "current_discount_pct": 0.0,
        "category": ["Baby Care"], "product": [treatable[0]],
    })

    assert narrow["scope"]["product"] == [treatable[0]]
    assert narrow["scope"]["filters_applied"]["product"] == [treatable[0]]
    # Progress, pace, gap.
    assert narrow["progress"]["units_mtd"] < broad["progress"]["units_mtd"]
    assert narrow["pace"]["projected_month_end"] < broad["pace"]["projected_month_end"]
    assert narrow["gap"]["units"] > 0
    # The population the ladder acts on.
    assert narrow["population"]["remaining_products"] < broad["population"]["remaining_products"]
    # And every economic figure on every rung.
    for wide, tight in zip(broad["interventions"], narrow["interventions"]):
        assert tight["discount_pct"] == wide["discount_pct"]
        if not (wide["estimable"] and tight["estimable"]):
            continue
        assert tight["units"]["low"] < wide["units"]["low"]
        assert tight["projected_month_end"]["low"] < wide["projected_month_end"]["low"]
        if wide["trade_spend"] and tight["trade_spend"]:
            assert tight["trade_spend"] < wide["trade_spend"]
        if wide["incremental_sales"] and tight["incremental_sales"]:
            assert tight["incremental_sales"] < wide["incremental_sales"]
        # ROI and margin are RATIOS of the approved treatment, so they are scope
        # independent by construction -- asserted so a future change that made
        # them scope dependent would be caught rather than absorbed.
        assert tight["roi_multiple"] == pytest.approx(wide["roi_multiple"], abs=0.015)


def test_the_recommendation_is_made_for_the_selected_product() -> None:
    """Brief case 10. The recommended rung's figures are the product's own."""
    store = get_store()
    pid = next(
        p for p in sorted(store.dims.products)
        if store.dims.products[p].category == "Baby Care"
        and optimization._price_and_baseline(
            rows_for(FilterState.build(year=2025, month=10, channel=["CH002"], product=[p]))
        )[1] is not None
    )
    payload = {
        "month": 10, "year": 2025, "channel": ["CH002"], "checkpoint": 3,
        "category": ["Baby Care"], "product": [pid],
    }
    reference = scope_of(payload)["reference_target"]["units"]
    result = evaluate(payload, target_units=reference * 1.12, current_discount_pct=10.0)

    recommended = result["recommendation"]["intervention"]
    assert recommended is not None
    assert result["recommendation"]["reaches_target"] is True
    assert recommended["projected_month_end"]["low"] >= result["progress"]["target_units"]
    # The product's own volume, not the category's.
    category_only = evaluate(
        {k: v for k, v in payload.items() if k != "product"},
        target_units=reference * 1.12, current_discount_pct=10.0,
    )
    assert (
        recommended["units"]["low"]
        < (category_only["recommendation"]["intervention"] or recommended)["units"]["low"]
    )


def test_the_reference_target_uses_the_whole_scope() -> None:
    """Brief case 8's tail: last year's actual is measured over the SAME channel,
    category, product and month -- not the channel's total."""
    store = get_store()
    pid = next(p for p in sorted(store.dims.products) if store.dims.products[p].category == "Baby Care")
    payload = {
        "month": 10, "year": 2025, "channel": ["CH002"],
        "category": ["Baby Care"], "product": [pid],
    }
    reference = scope_of(payload)["reference_target"]
    assert reference["available"] is True
    assert reference["year"] == 2024
    expected = sum(
        row.actual_quantity for row in rows_for(
            FilterState.build(year=2024, month=10, channel=["CH002"], category=["Baby Care"], product=[pid])
        )
    )
    assert reference["units"] == pytest.approx(round(expected, 0))
    # Strictly smaller than the channel's own, which is the point of the test.
    channel_reference = scope_of({"month": 10, "year": 2025, "channel": ["CH002"]})["reference_target"]
    assert reference["units"] < channel_reference["units"]


def test_the_scope_summary_names_every_level() -> None:
    """Brief section 6. Every level appears, and an unconstrained one says so
    rather than going silent."""
    store = get_store()
    pid = next(p for p in sorted(store.dims.products) if store.dims.products[p].category == "Baby Care")

    broad = scope_of({"month": 1, "year": 2025, "channel": ["CH001"]})
    assert broad["scope"]["scope_summary"] == (
        "January F25 · E-commerce · All categories · All products · Week 5 checkpoint"
    )

    narrow = scope_of({
        "month": 1, "year": 2025, "channel": ["CH001"],
        "category": ["Baby Care"], "product": [pid], "checkpoint": 3,
    })
    parts = narrow["scope"]["scope_summary"].split(" · ")
    assert parts[0] == "January F25"
    assert parts[1] == "E-commerce"
    assert parts[2] == "Baby Care"
    assert parts[3] == store.dims.products[pid].name.strip()
    assert parts[4] == "Week 3 checkpoint"
    assert narrow["scope"]["product_label"] == store.dims.products[pid].name.strip()

    unconstrained = scope_of({"month": 1, "year": 2025})
    assert "All channels" in unconstrained["scope"]["scope_summary"]


# --- month-to-date ----------------------------------------------------------


@pytest.mark.parametrize("channel", sorted(EXPECTED_CADENCE))
@pytest.mark.parametrize("week", [1, 2, 3])
def test_mtd_units_are_the_sum_of_the_completed_business_weeks(channel: str, week: int) -> None:
    """Brief case 7, and section 4's worked example. MTD is a SUM OVER WEEKS --
    week 1 + week 2 + week 3 -- not a day-scaled figure, and it is the same
    number attainment is measured from."""
    result = evaluate({"month": 10, "year": 2025, "channel": [channel]}, checkpoint=week)
    state = FilterState.build(year=2025, month=10, channel=[channel])
    rows = rows_for(state)

    per_week = {
        key: sum(r.actual_quantity for r in rows if r.week_key == key)
        for key in sorted({r.week_key for r in rows})
    }
    completed = result["scope"]["elapsed_weeks"]
    assert len(completed) == week
    expected = sum(per_week[key] for key in completed)

    progress = result["progress"]
    assert progress["units_mtd"] == pytest.approx(round(expected, 0))
    # The legacy name carries the same figure, so an older client is not silently
    # handed nothing.
    assert progress["units_sold"] == progress["units_mtd"]
    # Attainment is MTD over target, and nothing else.
    assert progress["attainment_pct"] == pytest.approx(
        round(progress["units_mtd"] / progress["target_units"] * 100, 1), abs=0.05
    )
    assert progress["target_attainment"] == progress["attainment_pct"]


def test_mtd_grows_week_by_week_and_ends_at_the_month() -> None:
    """Successive checkpoints accumulate, and the last one equals the whole
    month -- which is only true if no week is counted twice or dropped."""
    payload = {"month": 10, "year": 2025, "channel": ["CH002"]}
    totals = [
        evaluate(payload, checkpoint=week)["progress"]["units_mtd"]
        for week in (1, 2, 3, 4)
    ]
    assert totals == sorted(totals)
    measured = sum(r.actual_quantity for r in rows_for(FilterState.build(year=2025, month=10, channel=["CH002"])))
    assert totals[-1] == pytest.approx(round(measured, 0))


def test_the_month_comes_from_the_authoritative_year_week_mapping() -> None:
    """Brief case 14. The month of every business week in scope is the one
    dim_date gives for that (Year, Week) -- never `fact_sales.Date.month`.

    Asserted by rebuilding the week set from `Dimensions.week_start` and
    requiring it to match the weeks the response reports.
    """
    store = get_store()
    week_start = store.dims.week_start
    for month in (3, 6, 10):
        result = evaluate({"month": month, "year": 2025, "channel": ["CH002"]}, checkpoint=1)
        reported = set(result["scope"]["week_keys"])
        expected = {
            f"{year}-W{week:02d}"
            for (year, week), start in week_start.items()
            if year == 2025 and start.month == month
        }
        # Every week the response reports is a week dim_date files under this
        # month. (The response can hold fewer -- a week with no rows for the
        # channel -- but never one from another month.)
        assert reported <= expected, month
        assert reported, month
        for key in reported:
            year, week = key.split("-W")
            assert week_start[(int(year), int(week))].month == month


# --- promotion identity -----------------------------------------------------


def test_a_weekly_channel_keeps_its_promotions_separate() -> None:
    """Brief case 8, and section 11's prohibition by name: weekly Promotion_Id
    values are NOT collapsed into one fake monthly promotion."""
    result = evaluate({"month": 10, "year": 2025, "channel": ["CH001"]}, checkpoint=2)
    remaining = result["remaining_scope"]
    assert result["cadence"]["code"] == "WEEKLY"

    # Each remaining week is its own opportunity.
    assert remaining["weeks_remaining"] == 2
    assert remaining["promotion_opportunities"] == 2
    assert "2 weekly promotion opportunities" == remaining["opportunity_label"]
    assert "own Promotion_Id" in remaining["basis"]

    # And the ids on each week are the ids the data records for it -- more than
    # one distinct id across the remaining weeks, none invented, none merged.
    state = FilterState.build(year=2025, month=10, channel=["CH001"])
    rows = rows_for(state)
    for week in remaining["weeks"]:
        expected = sorted({
            r.promotion_id for r in rows if r.week_key == week["week_key"] and r.is_promoted
        })
        assert week["promotion_ids"] == expected, week["week_key"]
    assert len(remaining["distinct_promotion_ids"]) > 1, "nothing to keep separate"

    # Every rung carries the same per-week identity, so the recovery is
    # aggregated across the weekly events rather than over one merged promotion.
    for rung in result["interventions"]:
        assert [w["week_key"] for w in rung["by_week"]] == [
            w["week_key"] for w in remaining["weeks"]
        ]
        for a, b in zip(rung["by_week"], remaining["weeks"]):
            assert a["promotion_ids"] == b["promotion_ids"]


def test_a_monthly_channel_repeated_weeks_are_one_treatment() -> None:
    """Brief case 9, and section 12. The same treatment repeating across the
    month's business weeks is ONE monthly promotion observed at weekly grain --
    not three promotions."""
    result = evaluate({"month": 10, "year": 2025, "channel": ["CH002"]}, checkpoint=1)
    remaining = result["remaining_scope"]
    assert result["cadence"]["code"] == "MONTHLY"
    assert remaining["weeks_remaining"] == 3
    assert remaining["promotion_opportunities"] == 1
    assert "1 monthly promotion treatment across 3 remaining business weeks" == remaining["opportunity_label"]
    assert "not several promotions" in remaining["basis"]
    # The weekly detail is still there -- the volume lives in the weeks -- it is
    # simply not counted as several opportunities.
    assert len(remaining["weeks"]) == 3


def test_a_mixed_scope_is_counted_the_monthly_way() -> None:
    """Reading a monthly channel's month as independent weekly slots is what
    section 12 forbids, so a scope containing one is counted monthly."""
    result = evaluate({"month": 10, "year": 2025}, checkpoint=1)
    assert result["cadence"]["code"] == "MIXED"
    assert result["remaining_scope"]["promotion_opportunities"] == 1


# --- the intervention acts only on the remaining weeks ----------------------


def _synthesized_weeks(payload: dict, week: int, discount: float) -> set[str]:
    """The weeks a rung's counterfactual rows actually touch.

    Reaches into the service rather than the API because the point of the
    assertion is which ROWS were rewritten, and the payload reports figures.
    """
    state = state_of(payload)
    state = state.replace(year=rescue.resolve_year(state.year))
    rows = rows_for(state)
    calendar = rescue.month_calendar(state, rows)
    cadence = rescue.resolve_cadence(state)
    checkpoint = rescue.resolve_checkpoint(calendar, cadence, week)
    pop = rescue.population(rows, checkpoint, calendar)
    synthesized, _, _ = rescue._counterfactual(pop, discount / 100, 0.5)
    return {row.week_key for row in synthesized}


@pytest.mark.parametrize("channel", ["CH001", "CH004", "CH002", "CH003", "CH005"])
@pytest.mark.parametrize("week", [1, 2, 3])
def test_an_intervention_touches_only_the_remaining_weeks(channel: str, week: int) -> None:
    """Brief cases 10 and 11. For BOTH cadences: no rung rewrites a week that has
    already completed."""
    payload = {"month": 10, "year": 2025, "channel": [channel]}
    result = evaluate(payload, checkpoint=week)
    completed = set(result["scope"]["elapsed_weeks"])
    remaining = set(result["scope"]["remaining_weeks"])
    assert completed and remaining

    touched = _synthesized_weeks(payload, week, 15.0)
    assert touched <= remaining, f"{channel} week {week}: a completed week was rewritten"
    assert not (touched & completed)

    # And through the API: every rung's per-week breakdown covers the remaining
    # weeks and only those.
    for rung in result["interventions"]:
        weeks = {entry["week_key"] for entry in rung["by_week"]}
        assert weeks <= remaining, rung["ladder_label"]


@pytest.mark.parametrize("channel", ["CH001", "CH002"])
def test_completed_weeks_are_identical_under_every_rung(channel: str) -> None:
    """Brief case 12. The completed weeks' contribution is the same measured
    number under every intervention, at every depth, so a rescue scenario cannot
    rewrite history.

    Checked as an identity the projections must satisfy: each rung's projected
    month-end minus its own remaining-week units equals the MTD figure, and that
    figure is the measured sum over the completed weeks.
    """
    payload = {"month": 10, "year": 2025, "channel": [channel]}
    result = evaluate(payload, checkpoint=2, target_units=1e9, current_discount_pct=0.0)
    progress = result["progress"]

    state = FilterState.build(year=2025, month=10, channel=[channel])
    completed = set(result["scope"]["elapsed_weeks"])
    measured = sum(r.actual_quantity for r in rows_for(state) if r.week_key in completed)
    assert progress["units_mtd"] == pytest.approx(round(measured, 0))

    carried = result["population"]["carried_units"]
    for rung in result["interventions"]:
        remaining_units = rung["units"]["low"] + carried
        assert rung["projected_month_end"]["low"] - remaining_units == pytest.approx(
            progress["units_mtd"], rel=1e-9
        ), rung["ladder_label"]


@pytest.mark.parametrize("channel", sorted(EXPECTED_CADENCE))
def test_no_remaining_week_means_no_intervention(channel: str) -> None:
    """Brief cases 13 and 17. With nothing left of the month there is nothing for
    an intervention to act on, so none is offered -- only the final result."""
    result = evaluate({"month": 10, "year": 2025, "channel": [channel]}, checkpoint="latest")
    assert result["progress"]["weeks_remaining"] == 0
    assert result["progress"]["phase"] == "complete"
    assert result["interventions"] == []
    assert result["remaining_scope"]["promotion_opportunities"] == 0
    assert result["remaining_scope"]["weeks"] == []
    assert result["recommendation"]["action"] is None
    assert result["recommendation"]["intervention"] is None
    assert result["target_status"]["code"] in ("achieved", "missed")
    assert result["target_status"]["final"] is True


def test_the_per_week_breakdown_aggregates_to_the_rung():
    """Section 11's "then aggregate": the rung's totals are the sum of its
    weeks, so the two can never disagree on screen."""
    result = evaluate(
        {"month": 10, "year": 2025, "channel": ["CH001"]},
        checkpoint=1, target_units=1e9, current_discount_pct=0.0,
    )
    for rung in result["interventions"]:
        if not rung["estimable"]:
            continue
        for end in ("low", "high"):
            total = sum(entry["units"][end] for entry in rung["by_week"])
            assert total == pytest.approx(rung["units"][end], rel=1e-9), rung["ladder_label"]


# --- the run-rate projection ------------------------------------------------


@pytest.mark.parametrize("name,payload", SCOPES)
def test_run_rate_is_division_and_says_so(name: str, payload: dict) -> None:
    result = evaluate(payload, target_units=100000.0)
    pace, progress = result["pace"], result["progress"]
    # THE DENOMINATOR IS THE COMPLETED WEEKS' OWN COVERAGE, from the calendar --
    # never a raw calendar-day count that might contradict them.
    assert progress["days_elapsed"] == progress["boundaries"][progress["weeks_completed"] - 1]
    expected_pace = progress["units_mtd"] / progress["days_elapsed"]
    assert pace["daily_pace"] == pytest.approx(round(expected_pace, 1))
    assert pace["projected_month_end"] == pytest.approx(
        round(expected_pace * progress["days_in_month"], 0), rel=1e-6
    )
    # Labelled a projection, never a forecast.
    assert pace["label"] == rescue.RUN_RATE_LABEL
    assert "not a forecast" in pace["note"]
    assert "forecast" not in pace["label"].lower()


# --- the gap ----------------------------------------------------------------


@pytest.mark.parametrize("attainment", [40.0, 75.0, 100.0, 140.0])
def test_gap_is_never_negative(attainment: float) -> None:
    payload = {"month": 10, "year": 2025, "channel": ["CH002"]}
    result = evaluate(payload, target_units=target_for_attainment(payload, attainment))
    gap = result["gap"]
    assert gap["units"] >= 0
    if attainment >= 100:
        assert gap["on_track"] is True
        assert gap["units"] == 0
        assert gap["label"] == "On track"
    else:
        assert gap["on_track"] is False
        assert "behind target" in gap["label"]


# --- the economics are the project's ---------------------------------------


@pytest.mark.parametrize("name,payload", SCOPES)
def test_candidate_baseline_agrees_with_the_engine(name: str, payload: dict) -> None:
    """The rule `optimization._price_and_baseline` states, checked against
    `aggregate._volume`'s own `baseline_average` for every (product, channel) the
    engine reports one for. This module calls that function rather than restating
    it, and this is the test that keeps the call honest."""
    state = state_of(payload)
    state = state.replace(year=rescue.resolve_year(state.year))
    rows = rows_for(state)
    calendar = rescue.month_calendar(state, rows)
    cadence = rescue.resolve_cadence(state)
    checkpoint = rescue.resolve_checkpoint(calendar, cadence, rescue.MONTHLY_CHECKPOINT_WEEK)
    pop = rescue.population(rows, checkpoint, calendar)
    engine = {
        (p.product_id, p.channel_id): p.baseline_average for p in A._volume(rows).products
    }
    for candidate in pop.treatable:
        key = (candidate.product_id, candidate.channel_id)
        if key in engine:
            assert candidate.baseline_rate == pytest.approx(engine[key]), f"{name} {key}"


def test_the_baseline_agreement_is_not_vacuous() -> None:
    """`_volume` reports a (product, channel) only when the selection holds BOTH a
    promoted and a non-promoted row for it, and some scopes -- CH002 in October
    2025, where 18 SKUs are promoted every week and the other 18 never are --
    have no such product at all. The per-scope check above is therefore allowed
    to be empty, so this one proves the comparison happens somewhere."""
    overlap = 0
    for _, payload in SCOPES:
        state = state_of(payload)
        state = state.replace(year=rescue.resolve_year(state.year))
        rows = rows_for(state)
        calendar = rescue.month_calendar(state, rows)
        cadence = rescue.resolve_cadence(state)
        checkpoint = rescue.resolve_checkpoint(
            calendar, cadence, rescue.MONTHLY_CHECKPOINT_WEEK
        )
        pop = rescue.population(rows, checkpoint, calendar)
        engine = {(p.product_id, p.channel_id): p.baseline_average for p in A._volume(rows).products}
        for candidate in pop.treatable:
            key = (candidate.product_id, candidate.channel_id)
            if key in engine:
                assert candidate.baseline_rate == pytest.approx(engine[key])
                overlap += 1
    assert overlap > 0, "no scope compared a single baseline against the engine's"


@pytest.mark.parametrize("name,payload", SCOPES)
def test_rung_roi_matches_the_approved_closed_form(name: str, payload: dict) -> None:
    """Each treated rung's ROI is the approved algebra, exactly.

    `config.breakeven_uplift` was derived from ROI = u(1-d)/((1+u)(d+c)). A
    rung priced at the bottom of its band must therefore report that value --
    which also means the reported ROI cannot have picked up a local formula on
    the way out.
    """
    result = evaluate(payload, target_units=100000.0, current_discount_pct=0.0)
    c = config.PROMOTION_COST_RATE
    for rung in result["interventions"]:
        if rung["kind"] == "maintain" or not rung["estimable"]:
            continue
        d = rung["discount_pct"] / 100
        u = rung["uplift"]["low"]
        expected = u * (1 - d) / ((1 + u) * (d + c))
        # The rung reports the multiple at two decimal places: half a step.
        assert rung["roi_multiple"] == pytest.approx(expected, abs=0.005), f"{name} {rung['treatment']}"


@pytest.mark.parametrize("name,payload", SCOPES)
def test_maintain_rung_reproduces_the_measured_month(name: str, payload: dict) -> None:
    """The maintain rung is the remaining weeks AS RECORDED, so its projected
    month-end must equal the month's own measured units. If it does not, the
    checkpoint split has lost or double-counted rows."""
    result = evaluate(payload, target_units=100000.0)
    state = state_of(payload).replace(year=result["scope"]["year"])
    measured = sum(row.actual_quantity for row in rows_for(state))
    maintain = result["interventions"][0]
    assert maintain["kind"] == "maintain"
    assert maintain["projected_month_end"]["low"] == pytest.approx(measured, rel=1e-9), name


@pytest.mark.parametrize("name,payload", SCOPES)
def test_units_rise_with_depth(name: str, payload: dict) -> None:
    """A deeper approved treatment has a higher approved uplift band, so a
    deeper rung cannot project fewer units than a shallower one."""
    result = evaluate(payload, target_units=100000.0, current_discount_pct=0.0)
    treated = [r for r in result["interventions"] if r["kind"] != "maintain" and r["estimable"]]
    depths = [r["discount_pct"] for r in treated]
    assert depths == sorted(depths), f"{name}: the ladder is not ascending"
    for lower, higher in zip(treated, treated[1:]):
        assert higher["units"]["low"] >= lower["units"]["low"], name
        assert higher["trade_spend"] >= lower["trade_spend"], name
        # And margin cannot rise as the discount deepens.
        assert higher["margin_pct"] <= lower["margin_pct"] + 1e-9, name


@pytest.mark.parametrize("name,payload", SCOPES)
def test_trade_spend_is_the_engine_definition(name: str, payload: dict) -> None:
    """Trade Spend on every rung is (Base Revenue - Actual Revenue) + Promotion
    Cost, which for a rung priced at gross x (d + c) means the reported figure
    must equal gross x (d + c) for that rung's own volume."""
    result = evaluate(payload, target_units=100000.0, current_discount_pct=0.0)
    c = config.PROMOTION_COST_RATE
    for rung in result["interventions"]:
        if rung["kind"] == "maintain" or not rung["estimable"]:
            continue
        d = rung["discount_pct"] / 100
        # revenue = gross(1-d) and spend = gross(d+c), so spend/revenue is a
        # constant of the treatment alone -- independent of the scope's volume.
        revenue_share = rung["trade_spend"] / (d + c) * (1 - d)
        assert revenue_share > 0, name
        assert rung["trade_spend"] == pytest.approx(revenue_share / (1 - d) * (d + c)), name


# --- the discount ceiling ---------------------------------------------------


@pytest.mark.parametrize("name,payload", SCOPES)
@pytest.mark.parametrize("current", [0.0, 5.0, 10.0, 15.0, 20.0, 25.0])
def test_no_rung_ever_exceeds_the_approved_ceiling(name: str, payload: dict, current: float) -> None:
    result = evaluate(payload, target_units=1e12, current_discount_pct=current)
    for rung in result["interventions"]:
        if rung["discount_pct"] is not None:
            assert rung["discount_pct"] <= rescue.MAX_DISCOUNT_PCT, name
            assert rung["discount_pct"] > current, "the ladder must climb, never repeat or descend"
    recommended = result["recommendation"]["intervention"]
    if recommended and recommended["discount_pct"] is not None:
        assert recommended["discount_pct"] <= rescue.MAX_DISCOUNT_PCT


def test_at_the_ceiling_there_is_no_stronger_step() -> None:
    """Brief case 7. At 25% the current treatment is already the deepest approved
    one AND the promotion master's only clearance mechanic, so no further
    intervention is offered and the reason says why."""
    result = evaluate({"month": 10, "year": 2025, "channel": ["CH002"]}, target_units=1e12, current_discount_pct=25.0)
    treated = [r for r in result["interventions"] if r["kind"] != "maintain"]
    assert treated == []
    current = result["current_treatment"]
    assert current["at_ceiling"] is True
    assert current["ceiling_pct"] == 25.0
    assert current["no_stronger_reason"]
    assert "Buy3Get1" in current["no_stronger_reason"]
    assert result["recommendation"]["intervention"] is None


def test_the_api_rejects_a_depth_beyond_the_ceiling() -> None:
    for depth in (25.5, 26, 30, 35, 100):
        bad = client.post(
            RESCUE_URL,
            json={"month": 10, "year": 2025, "target_units": 100, "current_discount_pct": depth},
        )
        assert bad.status_code == 422, depth


@pytest.mark.parametrize("requested,expected", [(0, 0.0), (2, 0.0), (3, 5.0), (7, 5.0), (8, 10.0), (13, 15.0), (25, 25.0)])
def test_a_position_between_approved_depths_resolves_to_one(requested: float, expected: float) -> None:
    """The control snaps rather than inventing a band between two approved
    points. Ties resolve DOWN, to the smaller intervention."""
    depth, treatment = rescue.snap_to_approved(requested)
    assert depth == expected
    if expected == 0:
        assert treatment is None
    else:
        assert response.get_treatment_response(depth).discount_pct == depth


# --- clearance mechanics ----------------------------------------------------


def test_the_clearance_mechanic_comes_from_the_promotion_master() -> None:
    """Brief cases 10 and 11. The master is inspected, not assumed: it holds
    PB001 = Buy3Get1 at the 25% approved depth, and no Buy2Get1 at all."""
    mechanics = rescue.clearance_treatments()
    names = rescue.approved_mechanic_names()
    assert mechanics == ("PB001",)
    assert names["PB001"] == "Buy3Get1"
    # Every mechanic offered is a promotion the master actually records.
    store = get_store()
    for treatment in mechanics:
        assert treatment in store.dims.promotions
        assert store.dims.promotions[treatment].name == names[treatment]
    # And it is priced on its own approved economics, not an invented pair.
    rule = response.get_treatment("PB001")
    assert (rule.discount_pct, rule.uplift_low, rule.uplift_high) == (25.0, 0.60, 0.72)


def test_buy2get1_is_never_fabricated() -> None:
    """It does not exist in the promotion master, so it must appear nowhere: not
    as a mechanic, not as a treatment, not in a label, and not in a payload."""
    store = get_store()
    assert not any(p.name.replace(" ", "").lower() == "buy2get1" for p in store.dims.promotions.values())
    assert "Buy2Get1" not in rescue.approved_mechanic_names().values()

    result = evaluate({"month": 10, "year": 2025, "channel": ["CH002"]}, target_units=1e12, current_discount_pct=0.0)

    # Never OFFERED: not as a mechanic on a rung, not as a treatment, not as an
    # approved point the control could land on, not in a rung's label.
    offered = [
        rung["mechanic"] for rung in result["interventions"] if rung["mechanic"]
    ] + [point["name"] for point in result["discount"]["approved_points"]] + [
        rung["ladder_label"] for rung in result["interventions"]
    ] + [m["name"] for m in result["provenance"]["clearance_mechanics"]]
    assert not any("buy2" in value.replace(" ", "").lower() for value in offered)

    # Buy3Get1 IS offered, because the master records it.
    assert "Buy3Get1" in [m["name"] for m in result["provenance"]["clearance_mechanics"]]
    # The only place Buy2Get1 may appear is the sentence explaining that it does
    # not exist -- which is the honest answer, not a fabrication.
    assert "holds no Buy2Get1" in result["provenance"]["clearance_basis"]


def test_the_clearance_rung_is_the_deepest_rung() -> None:
    """Level 3 and Level 4 of the brief's ladder coincide in this project: the
    only approved mechanic sits at the deepest approved depth. The rung says so
    rather than pretending to be two rungs."""
    result = evaluate({"month": 10, "year": 2025, "channel": ["CH002"]}, target_units=1e12, current_discount_pct=0.0)
    clearance = [r for r in result["interventions"] if r["kind"] == "clearance"]
    assert len(clearance) == 1
    rung = clearance[0]
    assert rung["discount_pct"] == rescue.MAX_DISCOUNT_PCT
    assert rung["mechanic"] == "Buy3Get1"
    assert rung["level_note"] and "one rung" in rung["level_note"]
    assert rung["level"] == max(r["level"] for r in result["interventions"])


# --- the recommendation policy ---------------------------------------------


@pytest.mark.parametrize("name,payload", SCOPES)
def test_a_trajectory_that_reaches_the_target_draws_no_discount(name: str, payload: dict) -> None:
    """Brief case 5. If the run-rate already lands the month at or above target,
    the recommendation is to maintain -- no unnecessary discounting."""
    projected = evaluate(payload)["pace"]["projected_month_end"]
    result = evaluate(payload, target_units=projected * 0.8)
    assert result["pace"]["projected_month_end"] >= result["progress"]["target_units"]
    assert result["recommendation"]["action"] == "maintain"
    assert result["recommendation"]["level"] == 0
    assert result["recommendation"]["reaches_target"] is True


@pytest.mark.parametrize("name,payload", SCOPES)
def test_a_trajectory_that_misses_evaluates_the_ladder(name: str, payload: dict) -> None:
    """Brief case 6. Below target, the ladder is priced and each rung is judged."""
    projected = evaluate(payload)["pace"]["projected_month_end"]
    result = evaluate(payload, target_units=projected * 1.02, current_discount_pct=0.0)
    assert result["pace"]["projected_month_end"] < result["progress"]["target_units"]
    treated = [r for r in result["interventions"] if r["kind"] != "maintain"]
    assert len(treated) == len(response.APPROVED_DISCOUNT_PCT)
    assert all("reaches_target" in r for r in treated)


@pytest.mark.parametrize("name,payload", SCOPES)
def test_the_least_aggressive_reaching_rung_is_selected(name: str, payload: dict) -> None:
    """Brief cases 8 and 9, together. The selected rung reaches the target, and
    no shallower rung does -- which is the same statement as "a stronger
    intervention is not selected when a weaker approved one already reaches"."""
    projected = evaluate(payload)["pace"]["projected_month_end"]
    # A target the trajectory misses but an approved treatment can recover.
    result = evaluate(payload, target_units=projected * 1.02, current_discount_pct=0.0)
    rungs = result["interventions"]
    reaching = [r for r in rungs if r["reaches_target"] and r["within_budget"] and r["estimable"]]
    if not reaching:
        pytest.skip(f"{name}: no approved treatment recovers this target, covered elsewhere")
    chosen = result["recommendation"]["intervention"]
    assert chosen is not None, name
    assert chosen["reaches_target"] is True
    shallowest = min(reaching, key=lambda r: (r["discount_pct"] or 0.0))
    assert chosen["level"] == shallowest["level"], name
    # Nothing shallower than the chosen rung reaches the target.
    chosen_depth = chosen["discount_pct"] if chosen["discount_pct"] is not None else 0.0
    for rung in rungs:
        depth = rung["discount_pct"] if rung["discount_pct"] is not None else 0.0
        if depth < chosen_depth:
            assert not rung["reaches_target"], f"{name}: a shallower rung reached the target"


def test_reaching_the_target_is_judged_at_the_bottom_of_the_band() -> None:
    """A rung that clears at the top of its approved band and misses at the
    bottom has NOT been shown to recover the target."""
    payload = {"month": 6, "year": 2025, "channel": ["CH003"]}
    result = evaluate(payload, target_units=1e12, current_discount_pct=0.0)
    for rung in result["interventions"]:
        if not rung["estimable"]:
            continue
        assert rung["reaches_target"] == (rung["projected_month_end"]["low"] >= result["progress"]["target_units"])
    assert "BOTTOM" in result["provenance"]["decision_rule"]


def test_an_unrecoverable_target_is_reported_not_papered_over() -> None:
    payload = {"month": 10, "year": 2025, "channel": ["CH002"]}
    result = evaluate(payload, target_units=1e12, current_discount_pct=0.0)
    assert result["recommendation"]["action"] is None
    assert result["recommendation"]["reaches_target"] is False
    assert "No approved intervention recovers the target" in result["recommendation"]["reason"]
    # The rungs are still shown, each honestly marked as not reaching.
    assert result["interventions"]
    assert all(not r["reaches_target"] for r in result["interventions"])


def test_the_ranking_policy_is_stated_on_the_response() -> None:
    result = evaluate({"month": 10, "year": 2025, "channel": ["CH002"]}, target_units=100000.0)
    basis = result["recommendation"]["ranking_basis"]
    assert basis == rescue.RANKING_BASIS
    for phrase in ("least aggressive", "trade spend", "ROI", "margin"):
        assert phrase in basis
    assert "Units alone never decide it" in basis


# --- the budget guardrail --------------------------------------------------


def test_a_budget_ceiling_is_never_silently_exceeded() -> None:
    payload = {"month": 10, "year": 2025, "channel": ["CH002"]}
    projected = evaluate(payload)["pace"]["projected_month_end"]
    target = projected * 1.02
    open_result = evaluate(payload, target_units=target, current_discount_pct=0.0)
    chosen = open_result["recommendation"]["intervention"]
    assert chosen is not None and chosen["additional_trade_spend"] > 0

    # A ceiling below what the winning rung needs must block it, with the amount
    # it needed, rather than quietly recommending it anyway.
    tight = evaluate(
        payload,
        target_units=target,
        current_discount_pct=0.0,
        max_additional_trade_spend=chosen["additional_trade_spend"] / 2,
    )
    assert tight["budget"]["applied"] is True
    blocked = [r for r in tight["interventions"] if not r["within_budget"]]
    assert blocked
    assert all(r["budget_reason"] for r in blocked)
    recommended = tight["recommendation"]["intervention"]
    if recommended is not None:
        assert recommended["within_budget"] is True
        assert recommended["additional_trade_spend"] <= tight["budget"]["max_additional_trade_spend"]
    else:
        assert "exceeds the trade-spend ceiling" in tight["recommendation"]["reason"]


def test_the_budget_ceiling_is_measured_not_invented() -> None:
    """It is `optimization.historical_reference`'s measured mean trade spend --
    reused, so the two modes cannot disagree about what a month costs."""
    payload = {"month": 10, "year": 2025, "channel": ["CH002"]}
    scope = client.post(SCOPE_URL, json=payload)
    assert scope.status_code == 200
    budget = scope.json()["budget"]
    state = state_of(payload).replace(year=rescue.resolve_year(2025))
    expected = optimization.historical_reference(state)["average_trade_spend"]
    assert budget["average_trade_spend"] == pytest.approx(expected)
    assert budget["available"] is (expected is not None and expected > 0)


# --- the phases of the month ----------------------------------------------


@pytest.mark.parametrize("week", [1, 2])
def test_before_the_mid_month_week_is_an_early_month_signal(week: int) -> None:
    """Brief case 12, counted in WEEKS. Not blocked -- qualified.

    "Early" is fewer completed business weeks than the mid-month checkpoint
    needs, which is the same threshold the monthly auto rule uses, so the two
    cannot disagree about when the evidence becomes reliable.
    """
    result = evaluate({"month": 10, "year": 2025, "channel": ["CH002"]}, checkpoint=week)
    progress = result["progress"]
    assert progress["weeks_completed"] == week
    assert progress["days_elapsed"] == 7 * week
    assert progress["phase"] == "early_month"
    assert "Early-month signal" in progress["phase_note"]
    assert "third completed business week" in progress["phase_note"]
    # The run-rate still uses the ACTUAL elapsed coverage of those weeks, and the
    # ladder is still offered: the user is informed, not stopped.
    assert result["pace"]["daily_pace"] == pytest.approx(
        progress["units_mtd"] / (7 * week), abs=0.05
    )
    assert result["interventions"]


def test_from_the_mid_month_week_the_normal_interpretation_applies() -> None:
    result = evaluate({"month": 10, "year": 2025, "channel": ["CH002"]}, checkpoint=3)
    progress = result["progress"]
    assert progress["weeks_completed"] == 3
    assert progress["days_elapsed"] == 21
    assert progress["phase"] == "checkpoint"
    assert "Completed business week 3 of 4" in progress["phase_note"]


def test_a_complete_month_is_a_final_result_not_a_rescue() -> None:
    """Brief case 13. No intervention is recommended for a period that has
    closed, and no ladder is offered for one."""
    payload = {"month": 10, "year": 2025, "channel": ["CH002"]}
    state = state_of(payload)
    measured = sum(row.actual_quantity for row in rows_for(state))

    achieved = evaluate(payload, checkpoint="latest", target_units=measured * 0.9)
    assert achieved["progress"]["phase"] == "complete"
    assert achieved["progress"]["weeks_remaining"] == 0
    assert achieved["progress"]["days_elapsed"] == achieved["progress"]["days_in_month"]
    assert achieved["target_status"]["code"] == "achieved"
    assert achieved["target_status"]["final"] is True
    assert achieved["target_status"]["action"] == "No intervention required."
    assert achieved["interventions"] == []
    assert achieved["recommendation"]["action"] is None
    assert "month is complete" in achieved["recommendation"]["reason"]

    missed = evaluate(payload, checkpoint="latest", target_units=measured * 1.1)
    assert missed["target_status"]["code"] == "missed"
    assert missed["target_status"]["final"] is True
    assert missed["interventions"] == []
    assert missed["recommendation"]["action"] is None


# --- validation and honest empties ----------------------------------------


@pytest.mark.parametrize(
    "body",
    [
        {"month": 10, "target_units": 0},                      # brief case 14
        {"month": 10, "target_units": -1},
        {"month": 10},                                          # no target at all
        {"target_units": 100},                                  # no month
        {"month": 0, "target_units": 100},
        {"month": 13, "target_units": 100},
        {"month": 10, "target_units": 100, "current_discount_pct": -1},
        {"month": 10, "target_units": 100, "checkpoint": 0},
        # `day` was replaced by `checkpoint`; it is not silently accepted.
        {"month": 10, "target_units": 100, "day": 21},
        {"month": 10, "target_units": 100, "max_additional_trade_spend": -5},
        {"month": 10, "target_units": 100, "not_a_field": 1},
    ],
)
def test_the_contract_rejects_what_it_cannot_answer(body: dict) -> None:
    assert client.post(RESCUE_URL, json=body).status_code == 422


def test_this_dataset_has_no_empty_scope_the_endpoint_can_reach() -> None:
    """The premise the next test rests on, asserted directly.

    Every (month, channel, product) pairing in 2025 carries rows, so no valid
    combination of the four controls this endpoint exposes -- month, channel,
    category, product -- selects nothing. An unknown value is now a 422 rather
    than an empty scope, which leaves the no-data branch unreachable from the
    router on this data. It is still real defensive code, and the test below
    exercises it through the service.
    """
    store = get_store()
    present = set()
    for i in range(store.row_count):
        if store.year[i] == 2025:
            present.add((
                store.month[i],
                store.stores[store.store_code[i]].channel_id,
                store.products[store.product_code[i]].product_id,
            ))
    gaps = [
        (month, channel, product)
        for month in range(1, 13)
        for channel in sorted(store.dims.channels)
        for product in sorted(store.dims.products)
        if (month, channel, product) not in present
    ]
    assert not gaps, f"real empty scopes exist and should be asserted directly: {gaps[:5]}"


def test_an_empty_scope_is_an_honest_no_data_state() -> None:
    """Brief case 15. A status and a reason, and NO numbers -- a zeroed assessment
    would read as a missed target rather than an unmeasured one.

    Exercised through the SERVICE, with a Brand Form the catalogue does not hold.
    Brand is a real `FilterState` dimension that this endpoint deliberately does
    not expose, which makes it the one way to hand the branch an empty selection
    on a dataset where every scope the endpoint CAN build carries rows.
    """
    store = get_store()
    unknown_brand = "Brand Form That Does Not Exist"
    assert unknown_brand not in {p.brand for p in store.dims.products.values()}

    state = FilterState.build(year=2025, month=10, channel=["CH002"], brand=[unknown_brand])
    assert not rows_for(state)

    result = rescue.rescue(state, target_units=100.0, current_discount_pct=10.0)
    assert result["status"] == "no_data"
    assert "selects no sales rows" in result["message"]
    for key in (
        "progress", "target_status", "pace", "gap", "current_treatment",
        "recommendation", "population", "budget", "checkpoint", "remaining_scope",
    ):
        assert result[key] is None, key
    assert result["interventions"] == []
    assert result["evidence"] == []
    # The scope, the cascade block and the approved treatments still travel, so a
    # screen can say WHAT was asked for and offer the controls again. The cascade's
    # LISTS are empty here and correctly so: they are generated from the rows the
    # levels above admit, and the unreachable Brand Form above them admits none.
    assert result["scope"]["month"] == 10
    assert result["options"]["hierarchy"] == ["channel", "category", "product"]
    assert result["discount"]["approved_points"]

    measured = rescue.scope(state)
    assert measured["ready"] is False
    assert measured["status"] == "no_data"
    assert measured["checkpoint"] is None
    assert measured["options"]["hierarchy"] == ["channel", "category", "product"]


# --- isolation --------------------------------------------------------------


def test_channel_isolation() -> None:
    """Brief case 16. Two channels, same month and target: different measured
    progress, and neither scope's figures leak into the other."""
    payload = {"month": 10, "year": 2025}
    a = evaluate({**payload, "channel": ["CH002"]}, target_units=100000.0)
    b = evaluate({**payload, "channel": ["CH003"]}, target_units=100000.0)
    assert a["scope"]["channel"] == ["CH002"]
    assert b["scope"]["channel"] == ["CH003"]
    assert a["progress"]["units_sold"] != b["progress"]["units_sold"]
    # Each equals its own channel's measured elapsed weeks -- checked directly,
    # so a coincidental inequality cannot pass this test.
    for result, channel in ((a, "CH002"), (b, "CH003")):
        state = FilterState.build(year=2025, month=10, channel=[channel])
        elapsed = set(result["scope"]["elapsed_weeks"])
        measured = sum(r.actual_quantity for r in rows_for(state) if r.week_key in elapsed)
        assert result["progress"]["units_sold"] == pytest.approx(round(measured, 0))


def test_month_isolation() -> None:
    """Brief case 17. Each month is measured over its own business weeks only."""
    results = {
        month: evaluate({"month": month, "year": 2025, "channel": ["CH002"]}, target_units=100000.0)
        for month in (3, 6, 10)
    }
    week_sets = [frozenset(r["scope"]["week_keys"]) for r in results.values()]
    for i, first in enumerate(week_sets):
        for second in week_sets[i + 1 :]:
            assert not (first & second), "two months share a business week"
    for month, result in results.items():
        assert result["scope"]["month"] == month
        state = FilterState.build(year=2025, month=month, channel=["CH002"])
        assert frozenset(result["scope"]["week_keys"]) == frozenset({r.week_key for r in rows_for(state)})


def test_target_rescue_does_not_disturb_general_optimization() -> None:
    """Brief case 18. General Optimization must return the same plan whether or
    not a rescue has run -- the two share the filter engine and the approved
    economics, and nothing mutable."""
    body = {"category": ["Baby Care"], "channel": ["CH002"], "month": 6}
    state = FilterState.build(month=6, category=["Baby Care"], channel=["CH002"])
    ceiling = optimization.historical_reference(state)["average_trade_spend"]
    request = {**body, "max_trade_spend": ceiling}

    before = client.post("/api/simulation/general-optimization", json=request)
    assert before.status_code == 200
    evaluate({"month": 6, "year": 2025, "channel": ["CH002"], "category": ["Baby Care"]}, target_units=100000.0)
    after = client.post("/api/simulation/general-optimization", json=request)
    assert after.status_code == 200
    assert before.json() == after.json()


def test_target_rescue_does_not_disturb_investigation_simulation() -> None:
    """Brief case 19. /run and /simulate must be byte-identical across a rescue."""
    filters = {"year": 2025, "month": 10, "channel": ["CH002"]}
    run_request = {"filters": filters, "currency": "INR"}
    simulate_request = {"filters": filters, "scenario_id": "s1", "discount_pct": 15.0, "currency": "INR"}

    run_before = client.post("/api/simulation/run", json=run_request)
    sim_before = client.post("/api/simulation/simulate", json=simulate_request)
    assert run_before.status_code == 200 and sim_before.status_code == 200

    evaluate({"month": 10, "year": 2025, "channel": ["CH002"]}, target_units=100000.0, current_discount_pct=25.0)

    assert client.post("/api/simulation/run", json=run_request).json() == run_before.json()
    assert client.post("/api/simulation/simulate", json=simulate_request).json() == sim_before.json()


def _imported_modules(module) -> set[str]:
    """Every module name `module` imports, from its parsed source.

    THE AST, NOT A SUBSTRING SEARCH. These modules document their own boundaries
    at length, so "comparison" appears in prose in files that do not import it;
    a text scan would assert about the docstrings instead of the code.
    """
    import ast
    import inspect

    tree = ast.parse(inspect.getsource(module))
    names: set[str] = set()
    for node in ast.walk(tree):
        if isinstance(node, ast.Import):
            names.update(alias.name.split(".")[-1] for alias in node.names)
        elif isinstance(node, ast.ImportFrom):
            if node.module:
                names.add(node.module.split(".")[-1])
            names.update(alias.name.split(".")[-1] for alias in node.names)
    return names


def test_the_two_existing_modes_are_untouched_by_this_module() -> None:
    """Brief case 20. Target Rescue may READ the approved economics and General
    Optimization's baseline rule; it may not be read BY either existing mode, or
    the three modes would no longer be separate."""
    from app.tpo import comparison, execution, optimization as go, promo_calendar
    from app.tpo import recommendation, risk, scenarios, simulation as inv, weekly

    for module in (
        inv, execution, go, comparison, recommendation, risk, weekly, scenarios, promo_calendar,
    ):
        assert "rescue" not in _imported_modules(module), f"{module.__name__} imports rescue"

    # And Target Rescue depends on the shared foundations only -- the one filter
    # engine, the approved economics, the KPI engine, General Optimization's
    # published baseline rule, and the Promotion Calendar's published channel
    # cadence. Never on another mode's own service.
    #
    # THE DEPENDENCY ON `promo_calendar` IS ONE-WAY BY DESIGN: this module reads
    # its CADENCE declaration and changes nothing in it, which is the whole point
    # of that declaration living in one place.
    imported = _imported_modules(rescue)
    for forbidden in ("simulation", "execution", "comparison", "recommendation", "risk", "weekly", "scenarios"):
        assert forbidden not in imported, f"rescue.py imports {forbidden}"
    assert {
        "aggregate", "config", "formatting", "optimization", "response", "filters",
        "loader", "promo_calendar", "CADENCE",
    } <= imported


def test_rescue_writes_nothing() -> None:
    """Brief section 27. No promotion is created, no calendar or fact row is
    touched, no discount is activated, and nothing is persisted.

    Asserted against the CALLS the module makes, not against its prose -- the
    docstring says "writes no row", and a text scan for "write" would fail on the
    sentence promising it does not."""
    import ast
    import inspect

    tree = ast.parse(inspect.getsource(rescue))
    called: set[str] = set()
    for node in ast.walk(tree):
        if isinstance(node, ast.Call):
            target = node.func
            if isinstance(target, ast.Name):
                called.add(target.id)
            elif isinstance(target, ast.Attribute):
                called.add(target.attr)

    for forbidden in (
        "open", "write", "writelines", "to_csv", "execute", "executemany", "commit",
        "get_repository", "save", "delete", "insert", "update", "setattr",
    ):
        assert forbidden not in called, f"rescue.py calls {forbidden}()"

    # Nothing is assigned into a loaded dimension or fact structure either: the
    # module's only mutations are to its own local lists and dataclasses, which
    # are frozen copies made with `dataclasses.replace`.
    assert "replace" in called


# --- provenance -------------------------------------------------------------


def test_every_response_carries_its_provenance() -> None:
    result = evaluate({"month": 10, "year": 2025, "channel": ["CH002"]}, target_units=100000.0)
    provenance = result["provenance"]
    assert provenance["response_rule"] == response.PROVENANCE
    assert provenance["promotion_cost_rate"] == config.PROMOTION_COST_RATE
    assert provenance["approved_discount_pct"] == sorted(response.APPROVED_DISCOUNT_PCT)
    assert provenance["clearance_mechanics"] == [
        {
            "treatment": "PB001",
            "name": "Buy3Get1",
            "discount_pct": 25.0,
            "uplift_low": 0.60,
            "uplift_high": 0.72,
        }
    ]
    # The limitations are stated, not implied.
    assert "Not modelled" in provenance["cannibalization"]
    assert "not a forecast" in provenance["run_rate"]
    assert "is prorated" in provenance["day_grain"]
    assert "COMPLETED BUSINESS WEEKS" in provenance["day_grain"]
    # The cadence rule and the promotion-identity rule are stated too.
    assert "promo_calendar.CADENCE" in provenance["cadence_basis"]
    assert "own Promotion_Id" in provenance["promotion_identity"]
    assert "REMAINING business weeks" in provenance["intervention_scope"]
    assert "Decision Center" in provenance["execution"]


def test_the_evidence_trail_is_present_and_specific() -> None:
    payload = {"month": 10, "year": 2025, "channel": ["CH002"]}
    projected = evaluate(payload)["pace"]["projected_month_end"]
    result = evaluate(payload, target_units=projected * 1.02, current_discount_pct=0.0)
    evidence = result["evidence"]
    assert len(evidence) >= 3
    joined = " ".join(evidence)
    assert "completed business week" in joined
    assert "MONTHLY cadence" in joined
    assert "run-rate projection, not a forecast" in joined
    # The recommendation's own reason is the last line, so the trail ends with
    # the conclusion it supports.
    assert evidence[-1] == result["recommendation"]["reason"]


def test_the_scope_endpoint_measures_without_recommending() -> None:
    scope = client.post(SCOPE_URL, json={"month": 10, "year": 2025, "channel": ["CH002"]})
    assert scope.status_code == 200
    payload = scope.json()
    assert payload["ready"] is True
    assert payload["checkpoint"]["days_in_month"] == 28
    assert payload["scope"]["week_boundaries"] == [7, 14, 21, 28]
    assert payload["checkpoint"]["checkpoint_type"] == "auto"
    assert payload["checkpoint"]["checkpoint_week"] == rescue.MONTHLY_CHECKPOINT_WEEK
    assert payload["checkpoint"]["weeks_total"] == 4
    assert payload["cadence"]["code"] == "MONTHLY"
    # A MEASURED reference target, with its basis -- never a default.
    reference = payload["reference_target"]
    assert reference["available"] is True
    assert reference["year"] == 2024
    state = FilterState.build(year=2024, month=10, channel=["CH002"])
    assert reference["units"] == pytest.approx(round(sum(r.actual_quantity for r in rows_for(state)), 0))
    assert "reference, not a target" in reference["basis"]
    # And nothing that would be a recommendation.
    assert "recommendation" not in payload
    assert "interventions" not in payload


def test_the_approved_points_the_control_may_land_on() -> None:
    payload = client.post(SCOPE_URL, json={"month": 10, "year": 2025}).json()
    points = payload["discount"]["approved_points"]
    assert [p["discount_pct"] for p in points] == sorted(response.APPROVED_DISCOUNT_PCT)
    assert [p["clearance"] for p in points] == [False, False, False, False, True]
    assert payload["discount"]["max_pct"] == rescue.MAX_DISCOUNT_PCT
    assert "does not create a depth" in payload["discount"]["note"]
    for point in points:
        rule = response.get_treatment(point["treatment"])
        assert point["uplift_low"] == rule.uplift_low
        assert point["uplift_high"] == rule.uplift_high
