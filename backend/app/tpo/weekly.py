"""Weekly impact decomposition -- B5.

Answers "when does this scenario's impact land?" by splitting the SAME
counterfactual B2.2 already builds across the business weeks the scope
actually contains.

THIS IS A DECOMPOSITION, NOT A FORECAST. No week is generated, no trend is
fitted, no future is projected and no interval is estimated. Every week
returned is a week the data has rows for, and every figure in it comes from
the same validated KPI engine that produced the aggregate. If the scope covers
four weeks, four weeks come back.

NO SECOND SIMULATION. The treatment, the approved uplift band and the
counterfactual rows all come from app/tpo/response.py and
app/tpo/execution.py unchanged. This module slices; it does not model.

HOW THE SLICE RECONCILES, which is the whole design problem
-----------------------------------------------------------
The engine derives a baseline per (product, channel) from the NON-PROMOTED
rows in whatever set it is handed. Slice naively -- one week's rows in, one
week's rows out -- and each week gets its own baseline, so the weekly
incrementals no longer add up to the scope's. The fix is to feed
`calculate_kpis` two different sets, which it already accepts:

  * `rows`        -> THAT WEEK's rows only. Trade Spend and Margin are sums and
                     ratios over the selection, so this makes them genuinely
                     weekly. Every row belongs to exactly one week, so Trade
                     Spend adds up exactly.
  * `volume_rows` -> the whole scope's non-promoted rows PLUS that week's
                     promoted rows. The baseline is therefore the SAME number
                     the aggregate measured against, and

                         incremental_W = p_qty_W - baseline x p_rows_W

                     sums across weeks to the aggregate incremental by
                     construction, not by luck.

Verified against the live data before this module was written: Trade Spend
reconciles exactly, Incremental Sales and Units to within the engine's own
rounding.

ADDITIVE AND NON-ADDITIVE ARE KEPT APART. Incremental Sales, Incremental Units
and Trade Spend are extensive quantities and their weekly values sum to the
aggregate. ROI, Margin and Cannibalization are RATIOS and are never summed or
averaged -- a weekly ROI is computed by the engine from that week's own
components, and the aggregate ROI is reported separately as the authority.
`reconciliation` states which is which rather than leaving a reader to guess.
"""

from __future__ import annotations

from collections import defaultdict
from dataclasses import dataclass
from typing import Any, Literal, Sequence

from app.tpo import aggregate as A
from app.tpo import config
from app.tpo import execution
from app.tpo import formatting as F
from app.tpo import response, service, simulation
from app.tpo.filters import FilterState, baseline_rows_for, rows_for
from app.tpo.loader import get_store

#: Said on every response, in the provenance and again in the method text.
METHOD = (
    "This is a scenario decomposition across observed business weeks, not a "
    "forecast. Each week's figures come from the existing validated KPI engine "
    "applied to the same counterfactual rows the aggregate simulation used."
)

RANGE_LABEL = "Approved uplift range"


@dataclass(frozen=True)
class WeeklyMetric:
    """One weekly figure, and whether it may be added up.

    `additive` is the load-bearing field. An extensive quantity sums across
    weeks to the scope total; a ratio does not, and summing one is the specific
    error this flag exists to prevent.
    """

    key: str
    additive: bool
    note: str


#: The metrics B5 exposes. Deliberately the five already central to Simulation,
#: plus cannibalization only because the engine either produces it for a weekly
#: slice or says why it cannot. PEI is left out: it is a composite index and
#: adding it here would be adding a KPI to this view rather than decomposing
#: one that is already central.
WEEKLY_METRICS: tuple[WeeklyMetric, ...] = (
    WeeklyMetric("incremental_sales", True, "Extensive: weekly values sum to the scope total."),
    WeeklyMetric("incremental_units", True, "Extensive: weekly values sum to the scope total."),
    WeeklyMetric("trade_spend", True, "Extensive: every row belongs to exactly one week."),
    WeeklyMetric(
        "roi_multiple", False,
        "A RATIO. Never summed and never averaged across weeks. Each week's ROI is "
        "computed by the engine from that week's own Incremental Sales and Trade "
        "Spend; the scope's ROI is reported separately and is the authority.",
    ),
    WeeklyMetric(
        "margin_percent", False,
        "A RATIO of summed revenue and cost. Never summed or averaged; each week is "
        "computed from that week's own rows.",
    ),
    WeeklyMetric(
        "cannibalization", False,
        "A RATE, and only present when the engine can measure it for the weekly "
        "slice. Never summed, never zero-filled.",
    ),
)

#: Reconciliation tolerance per additive metric: the engine's own rounding step
#: multiplied by the number of weeks, because each week is rounded once.
#: aggregate.py rounds every additive figure to 1dp, so each week can be off
#: by at most half a step; Units keep the wider step their KPI already used.
_ROUNDING_STEP = {"incremental_sales": 0.05, "incremental_units": 0.5, "trade_spend": 0.05}
_FLOAT_NOISE = 0.01


def _spec_for(key: str):
    card_key = next(k.card_key for k in simulation.SIMULATION_KPIS if k.key == key)
    return next((s for s in service.KPI_SPECS if s.key == card_key), None) if card_key else None


def _week_label(week_key: str) -> tuple[str, int, str | None]:
    """"2025-W41" -> ("W41 · 2025", 202541, "2025-10-06").

    The week comes from `WeekRow.week_key`, which the loader built by joining
    (Year, Week) to dim_date. `fact_sales.Month` is not read here or anywhere
    near here -- the project established that 22.6% of fact rows carry a month
    that disagrees with their own business week.
    """
    year, week = int(week_key[:4]), int(week_key[6:])
    store = get_store()
    start = store.dims.week_start.get((year, week))
    return f"W{week:02d} · {year}", year * 100 + week, start.isoformat() if start else None


def _kpi_entry(key: str, value: float | None, currency: str, reason: str | None) -> dict[str, Any]:
    spec = _spec_for(key)
    unit = spec.unit if spec else ("quantity" if key == "incremental_units" else "")
    return {
        "key": key,
        "value": value,
        "display_value": simulation._display(value, unit, currency),
        "available": value is not None,
        "unavailable_reason": None if value is not None else reason,
    }


def _week_kpis(
    week_rows: Sequence[A.WeekRow],
    volume_rows: Sequence[A.WeekRow],
    promoted_products: frozenset[str] | None,
    currency: str,
) -> dict[str, Any]:
    """One week, through the existing engine.

    `calculate_kpis` is called exactly as the aggregate calls it, with the two
    row sets described in the module docstring. Nothing is computed here: ROI
    in particular is `aggregate.calculate_roi` over this week's components, not
    a ratio assembled locally and not a mean of anything.
    """
    bundle = A.calculate_kpis(
        week_rows,
        (),
        family_rows=(),
        previous_family_rows=(),
        promoted_products=promoted_products,
        volume_rows=volume_rows,
        previous_volume_rows=(),
    )
    field = {
        "incremental_sales": bundle.incremental_sales.value,
        "incremental_units": bundle.incremental_quantity.value,
        "trade_spend": bundle.trade_spend.value,
        "roi_multiple": bundle.roi.value,
        "margin_percent": bundle.margin_impact.value,
        "cannibalization": bundle.cannibalization.value,
    }
    reasons = {
        "cannibalization": service._why_unavailable("cannibalization_rate", bundle),
    }
    return {
        metric.key: _kpi_entry(
            metric.key,
            field[metric.key],
            currency,
            reasons.get(metric.key, "The engine could not produce this metric for this week."),
        )
        for metric in WEEKLY_METRICS
    }


def _reconciliation(
    weeks: list[dict[str, Any]], aggregate: dict[str, Any], currency: str
) -> dict[str, Any]:
    """Do the weekly figures add up? Stated per metric, not assumed.

    Additive metrics are summed and compared against the aggregate the same
    scenario produced. Non-additive metrics are NOT summed -- the entry records
    why, and carries the aggregate value as the authority.
    """
    additive: dict[str, Any] = {}
    non_additive: dict[str, Any] = {}
    count = len(weeks)

    for metric in WEEKLY_METRICS:
        agg_low = aggregate["low"]["kpis"].get(metric.key, {}).get("value")
        agg_high = aggregate["high"]["kpis"].get(metric.key, {}).get("value")

        if not metric.additive:
            non_additive[metric.key] = {
                "summed": False,
                "reason": metric.note,
                "aggregate_low": agg_low,
                "aggregate_high": agg_high,
                "aggregate_display_low": aggregate["low"]["kpis"].get(metric.key, {}).get("display_value"),
                "aggregate_display_high": aggregate["high"]["kpis"].get(metric.key, {}).get("display_value"),
            }
            continue

        tolerance = max(_FLOAT_NOISE, _ROUNDING_STEP[metric.key] * count)
        entry: dict[str, Any] = {"summed": True, "tolerance": tolerance, "week_count": count}
        for end, agg in (("low", agg_low), ("high", agg_high)):
            total = sum(
                (w[end][metric.key]["value"] or 0.0)
                for w in weeks
                if w[end][metric.key]["available"]
            )
            difference = None if agg is None else total - agg
            entry[end] = {
                "weekly_total": total,
                "aggregate": agg,
                "difference": difference,
                "within_tolerance": difference is not None and abs(difference) <= tolerance,
            }
        additive[metric.key] = entry

    return {
        "additive": additive,
        "non_additive": non_additive,
        "note": (
            "Additive metrics are summed across weeks and checked against the "
            "aggregate simulation. Ratios are never summed or averaged: their weekly "
            "values are computed per week by the engine, and the scope figure is "
            "reported separately as the authority."
        ),
    }


class NoWeeklyData(ValueError):
    """The scope holds no promoted week to decompose."""


def weekly(
    state: FilterState,
    scenario_id: str,
    discount_pct: float,
    currency: str = "INR",
) -> dict[str, Any]:
    """The weekly decomposition of one simulated scenario.

    The treatment and its approved uplift band are resolved from
    app/tpo/response.py -- a caller cannot supply an uplift, a promotion cost
    or a response rule. Raises `response.UnapprovedDiscount` for an unapproved
    depth and `NoWeeklyData` when the scope contains no promoted week.
    """
    currency = F.normalise_currency(currency)
    rule = response.get_treatment_response(discount_pct)
    discount = rule.discount_pct / 100

    rows = rows_for(state)
    volume_rows = baseline_rows_for(state)
    if not rows or not any(r.is_promoted for r in rows):
        raise NoWeeklyData(
            "Nothing in this scope was promoted, so there are no promotion weeks to "
            "decompose. No weeks are fabricated to fill the gap."
        )

    targets = execution._target_keys(rows)
    baselines = execution._baselines(volume_rows)
    promoted_products = frozenset(state.product) if state.product else None

    # Synthesize once per band end, then GROUP BY WEEK ONCE. Re-filtering the
    # whole counterfactual for every week is O(weeks x rows) and dominated the
    # runtime on wide scopes -- 104 weeks over the full dataset meant scanning
    # ~40k rows a hundred times per end. The non-promoted set is identical for
    # every week, so it is built once and concatenated.
    ends: dict[str, Any] = {}
    for end, uplift in (("low", rule.uplift_low), ("high", rule.uplift_high)):
        cf_rows = execution.synthesize(rows, targets, baselines, uplift, discount).rows
        cf_volume = execution.synthesize(volume_rows, targets, baselines, uplift, discount).rows

        rows_by_week: dict[str, list[A.WeekRow]] = defaultdict(list)
        for row in cf_rows:
            rows_by_week[row.week_key].append(row)

        promoted_by_week: dict[str, list[A.WeekRow]] = defaultdict(list)
        # Non-promoted rows indexed by BASELINE KEY -- (product, channel), the
        # thing `_volume` derives a baseline per.
        non_promoted_by_key: dict[tuple[str, str], list[A.WeekRow]] = defaultdict(list)
        for row in cf_volume:
            if row.is_promoted:
                promoted_by_week[row.week_key].append(row)
            else:
                non_promoted_by_key[row.baseline_key].append(row)

        ends[end] = {
            "rows": cf_rows,
            "volume": cf_volume,
            "rows_by_week": rows_by_week,
            "promoted_by_week": promoted_by_week,
            "non_promoted_by_key": non_promoted_by_key,
        }

    # WEEKS THAT ACTUALLY CARRY THE PROMOTION. A week with rows but no promoted
    # row contributes nothing to a scenario, and emitting it with zeroes would
    # read as a measured absence of impact rather than an absence of promotion.
    week_keys = sorted({r.week_key for r in rows if r.is_promoted})
    scope_weeks = sorted({r.week_key for r in rows})

    weeks: list[dict[str, Any]] = []
    for week_key in week_keys:
        label, ordinal, start = _week_label(week_key)
        entry: dict[str, Any] = {
            "week_id": week_key,
            "week_label": label,
            "ordinal": ordinal,
            "week_start": start,
        }
        for end, sets in ends.items():
            week_rows = tuple(sets["rows_by_week"].get(week_key, ()))
            promoted = sets["promoted_by_week"].get(week_key, ())

            # ONLY the non-promoted rows whose (product, channel) is promoted
            # THIS week. The scope-wide baseline is preserved exactly -- every
            # non-promoted row for a promoted pair is still here, so the
            # baseline that pair is measured against is unchanged -- while the
            # pairs this week never promoted are dropped. `_volume` already
            # skips those (`if not a["p_rows"]: continue`), so their rows
            # contribute nothing to any figure and passing them only costs
            # time. On the full dataset that is the difference between scanning
            # every non-promoted row 104 times and scanning a fifth of them.
            keys = {row.baseline_key for row in promoted}
            week_volume = tuple(
                row
                for key in keys
                for row in sets["non_promoted_by_key"].get(key, ())
            ) + tuple(promoted)
            entry[end] = _week_kpis(week_rows, week_volume, promoted_products, currency)
        weeks.append(entry)

    aggregate = {
        end: {
            "uplift": rule.uplift_low if end == "low" else rule.uplift_high,
            "kpis": _week_kpis(sets["rows"], sets["volume"], promoted_products, currency),
        }
        for end, sets in ends.items()
    }

    return {
        "scenario_id": scenario_id,
        "treatment": rule.treatment,
        "discount_pct": rule.discount_pct,
        "uplift": {"low": rule.uplift_low, "high": rule.uplift_high},
        "range_label": RANGE_LABEL,
        "scope": {
            "period": F.period_label(state.year, state.month),
            "filters_applied": state.applied(),
            "row_count": len(rows),
            "promoted_row_count": sum(1 for r in rows if r.is_promoted),
            "weeks_in_scope": len(scope_weeks),
            "weeks_with_promotion": len(week_keys),
            "weeks_without_promotion": len(scope_weeks) - len(week_keys),
            "omitted_note": (
                "Weeks in scope carrying no promoted row are omitted rather than "
                "returned as zeroes: a scenario has no impact to decompose in them."
            ),
        },
        "metrics": [
            {
                "key": m.key,
                "label": (_spec_for(m.key).label if _spec_for(m.key) else "Incremental Units"),
                "unit": (_spec_for(m.key).unit if _spec_for(m.key) else "quantity"),
                "additive": m.additive,
                "note": m.note,
            }
            for m in WEEKLY_METRICS
        ],
        "weeks": weeks,
        "aggregate": aggregate,
        "reconciliation": _reconciliation(weeks, aggregate, currency),
        "provenance": {
            "scenario_id": scenario_id,
            "treatment": rule.treatment,
            "discount_pct": rule.discount_pct,
            "uplift_low": rule.uplift_low,
            "uplift_high": rule.uplift_high,
            "response_rule": response.PROVENANCE,
            "kpi_engine": "app/tpo/aggregate.calculate_kpis",
            "week_source": "WeekRow.week_key, joined from dim_date. fact_sales.Month is never read.",
            "scope": state.applied(),
            "range_label": RANGE_LABEL,
            "method": METHOD,
        },
        "meta": {
            "currency": currency,
            "base_currency": config.BASE_CURRENCY,
            "phase": "B5",
        },
    }
