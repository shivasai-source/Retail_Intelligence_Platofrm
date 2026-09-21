"""
Chart specs for the Analyst.

THE MODEL DOES NOT DRAW THE CHART AND DOES NOT SUPPLY ITS NUMBERS. It asks for
a chart of a breakdown it has already seen; this module re-reads that breakdown
from `app/tpo/service.py` — the same engine behind the KPI cards — and emits the
points. So a chart cannot disagree with the sentence beside it, and a model that
hallucinated a figure could not get it onto an axis.

WHAT IT REFUSES, AND WHY. A pie or donut asserts that the parts sum to the
whole. That is true of Trade Spend, whose groups add back to the total, and
FALSE of Incremental Sales, whose baseline is re-derived per group (see
service.breakdown's contract, restated in star_tools.run_analysis's `note`).
Asking for a pie of incremental sales is therefore a category error, and it is
downgraded to a bar chart rather than drawn — a chart that lies about its own
arithmetic is worse than no chart. The same rule governs stacking: a stacked
bar is a part-of-whole claim in a different costume, so it is held to the
identical test.

THE CHART FAMILIES. Three shapes of question, not one:
  * ONE metric across groups   — bar, column, line, area, pie, donut
  * TWO+ metrics across groups — grouped, stacked (comparison)
  * The SHAPE of a population  — histogram, scatter
The last family does not go through `run_analysis`: a distribution needs every
group, not a ranked top-N, so it reads a wide breakdown and bins it here.
"""
import math
from typing import Any

from app.agents import star_tools as T
from app.tpo import formatting as F

#: Must match MAX_SERIES in frontend/src/components/analyst/chartPalette.ts —
#: the categorical palette has six validated hues and is never cycled, so a
#: seventh group would have to reuse a colour. The tail folds into "Other".
MAX_GROUPS = 6

#: A histogram and a scatter describe a POPULATION, so they want every group
#: the engine will give rather than a top-N. Still bounded: an unbounded pull
#: is a way to hang the request on a dimension with thousands of members.
MAX_POPULATION = 400

#: How many bins a histogram draws. Enough to show a shape, few enough that
#: each bar still has a readable label at drawer width.
DEFAULT_BINS = 8
MAX_BINS = 20

#: Ranked metrics whose groups genuinely sum to the selection's total, so a
#: part-of-whole chart is honest. Everything else is a RANKING only.
ADDITIVE_METRICS = {"trade_spend", "incremental_units"}

#: Charts that assert "these parts make up the whole". Held to ADDITIVE_METRICS.
PART_OF_WHOLE_TYPES = {"pie", "donut", "stacked"}

#: Charts that plot several metrics at once rather than one.
MULTI_METRIC_TYPES = {"grouped", "stacked"}

CHART_TYPES = (
    "bar", "column", "line", "area", "pie", "donut",
    "grouped", "stacked", "histogram", "scatter",
)

#: How each metric is written. Mirrors the KPI cards' own units so a chart and
#: a card never render the same quantity differently.
_MONEY = {"trade_spend", "incremental_sales"}
_MULTIPLE = {"roi"}


def _display(metric: str, value: float | None, currency: str) -> str:
    if value is None:
        return "—"
    if metric in _MONEY:
        return F.money(value, currency)
    if metric in _MULTIPLE:
        return F.multiple(value)
    return F.quantity(value)


def _unit_label(metric: str, currency: str) -> str:
    symbol = "₹" if currency == "INR" else "$"
    return {
        "trade_spend": f"Trade Spend ({symbol})",
        "incremental_sales": f"Incremental Sales ({symbol})",
        "incremental_units": "Incremental Units",
        "roi": "ROI (multiple of spend)",
    }.get(metric, metric.replace("_", " ").title())


def _metric_unit(metric: str) -> str:
    """The UNIT a metric is measured in — money, multiple, quantity.

    Two metrics sharing a unit can share an axis; two that do not, cannot. This
    is the test behind `independent_scales`, and it is about the unit rather
    than the metric, which is what makes Trade Spend and Incremental Sales
    directly comparable on one scale.
    """
    if metric in _MONEY:
        return "money"
    if metric in _MULTIPLE:
        return "multiple"
    return "quantity"


def _clean_metrics(metrics: Any, fallback: str) -> list[str]:
    """The requested metric list, filtered to ones the engine really has.

    Order is the reader's, de-duplicated. Falls back to a single metric rather
    than erroring: a comparison chart with one series is a plain bar chart,
    which is still a useful answer to a slightly over-ambitious request.
    """
    if not isinstance(metrics, (list, tuple)):
        return [fallback]
    seen: list[str] = []
    for m in metrics:
        name = str(m)
        if name in T.BREAKDOWN_METRICS and name not in seen:
            seen.append(name)
    return seen or [fallback]


def _population(
    by: str, metric: str, filters: dict[str, Any] | None
) -> tuple[list[dict[str, Any]], str | None]:
    """Every group in scope, for the charts that describe a distribution."""
    result = T.run_analysis(filters or {}, by, metric, MAX_POPULATION)
    if "error" in result:
        return [], result["error"]
    groups = result.get("groups") or []
    if not groups:
        return [], "no rows matched this selection, so there is nothing to chart"
    return groups, None


def _build_histogram(
    *, by: str, metric: str, filters: dict[str, Any] | None,
    title: str | None, bins: Any, currency: str,
) -> dict[str, Any]:
    """The DISTRIBUTION of a metric across the members of a dimension.

    Answers "how are ROIs spread across my promotions" — a different question
    from "which promotion had the best ROI", and one a ranked bar chart cannot
    show. Each bar is a COUNT of groups falling in a value range, so the y-axis
    is a frequency and never the metric itself.
    """
    groups, error = _population(by, metric, filters)
    if error:
        return {"error": error}

    values = [float(g.get(metric) or 0.0) for g in groups]
    if len(values) < 3:
        return {
            "error": (
                f"only {len(values)} {by.replace('_', ' ')} group(s) in this selection — "
                "a distribution needs more than that to mean anything. Use a bar chart."
            )
        }

    try:
        n_bins = max(3, min(int(bins or DEFAULT_BINS), MAX_BINS))
    except (TypeError, ValueError):
        n_bins = DEFAULT_BINS

    low, high = min(values), max(values)
    if math.isclose(low, high):
        return {
            "error": (
                f"every {by.replace('_', ' ')} has the same {metric} here, so there is no "
                "distribution to draw."
            )
        }

    width = (high - low) / n_bins
    counts = [0] * n_bins
    for v in values:
        # The top value belongs in the last bin, not in a phantom bin above it.
        idx = min(int((v - low) / width), n_bins - 1)
        counts[idx] += 1

    points = []
    for i, count in enumerate(counts):
        start, end = low + i * width, low + (i + 1) * width
        points.append({
            "label": f"{_display(metric, start, currency)}–{_display(metric, end, currency)}",
            "value": float(count),
            "display": f"{count} {by.replace('_', ' ')}{'s' if count != 1 else ''}",
        })

    return {
        "chart": {
            "type": "histogram",
            "title": title or f"Distribution of {_unit_label(metric, currency)} by {by.replace('_', ' ')}",
            "unit": f"Number of {by.replace('_', ' ')}s",
            "axis_label": _unit_label(metric, currency),
            "points": points,
            "truncated": False,
        },
        "grouped_by": by,
        "ranked_by": metric,
        "population": len(values),
        "applied_filters": filters or {},
        "note": (
            f"Each bar counts how many {by.replace('_', ' ')}s fall in that {metric} range — "
            f"the height is a COUNT, not a {metric} total. {len(values)} in scope."
        ),
    }


def _build_scatter(
    *, by: str, metrics: list[str], filters: dict[str, Any] | None,
    title: str | None, currency: str,
) -> dict[str, Any]:
    """TWO metrics plotted against each other, one dot per group.

    The shape that answers "are we spending more where it actually returns?" —
    which no single-metric chart can show, because the question is about the
    RELATIONSHIP between two of them.
    """
    if len(metrics) < 2:
        return {
            "error": (
                "a scatter needs two metrics — an x and a y. Pass metrics like "
                "['trade_spend', 'incremental_sales']."
            )
        }
    x_metric, y_metric = metrics[0], metrics[1]

    # Both axes must come from the same set of groups, so each is fetched over
    # the same population and joined by name. A group missing from either side
    # is dropped rather than plotted at zero — a fabricated origin point would
    # invent a correlation.
    x_groups, error = _population(by, x_metric, filters)
    if error:
        return {"error": error}
    y_groups, error = _population(by, y_metric, filters)
    if error:
        return {"error": error}

    y_by_name = {str(g.get("group")): float(g.get(y_metric) or 0.0) for g in y_groups}
    points = []
    for g in x_groups:
        name = str(g.get("group") or "—")
        if name not in y_by_name:
            continue
        x_val = float(g.get(x_metric) or 0.0)
        y_val = y_by_name[name]
        points.append({
            "label": name,
            "x": x_val,
            "y": y_val,
            "value": y_val,  # so the table view and CSV have one value column
            "display": (
                f"{_display(x_metric, x_val, currency)} / {_display(y_metric, y_val, currency)}"
            ),
        })

    if len(points) < 3:
        return {"error": "too few groups with both metrics to plot a relationship"}

    return {
        "chart": {
            "type": "scatter",
            "title": title or f"{_unit_label(y_metric, currency)} vs {_unit_label(x_metric, currency)}",
            "unit": _unit_label(y_metric, currency),
            "x_label": _unit_label(x_metric, currency),
            "y_label": _unit_label(y_metric, currency),
            "points": points,
            "truncated": False,
        },
        "grouped_by": by,
        "x_metric": x_metric,
        "y_metric": y_metric,
        "population": len(points),
        "applied_filters": filters or {},
        "note": (
            "A relationship on this chart is not a cause. Describe the pattern; do not "
            "explain why it holds."
        ),
    }


def _build_multi(
    *, chart_type: str, by: str, metrics: list[str], filters: dict[str, Any] | None,
    title: str | None, limit: int, currency: str,
) -> dict[str, Any]:
    """SEVERAL metrics across the same groups — grouped or stacked bars.

    WHY THE SERIES ARE NOT NORMALISED. Trade Spend and ROI share no scale, and
    drawing them on one axis would make a 1.34 invisible beside a figure in
    crore. Each series therefore carries its own max, and the renderer scales
    each series independently for grouped bars — stated in `note` so the model
    describes it honestly rather than inviting a comparison of bar LENGTHS
    across series.
    """
    series: list[dict[str, Any]] = []
    labels: list[str] = []

    for metric in metrics:
        result = T.run_analysis(filters or {}, by, metric, limit)
        if "error" in result:
            return {"error": result["error"]}
        groups = result.get("groups") or []
        if not groups:
            return {"error": "no rows matched this selection, so there is nothing to chart"}
        if not labels:
            labels = [str(g.get("group") or "—") for g in groups]
        by_name = {str(g.get("group")): float(g.get(metric) or 0.0) for g in groups}
        series.append({
            "name": _unit_label(metric, currency),
            "metric": metric,
            # Aligned to the FIRST metric's group order, so every series in the
            # chart describes the same categories in the same places.
            "values": [by_name.get(name, 0.0) for name in labels],
            "displays": [
                _display(metric, by_name.get(name), currency) if name in by_name else "—"
                for name in labels
            ],
        })

    # Independent scales are for genuinely different UNITS, not different
    # metrics. Trade Spend and Incremental Sales are both money and belong on
    # one axis — comparing their bar lengths is exactly what the reader came
    # for. An earlier version compared the metric NAMES here, which differ
    # always, so every grouped chart wrongly told the reader not to compare it.
    mixed_units = len({_metric_unit(m) for m in metrics}) > 1

    spec: dict[str, Any] = {
        "type": chart_type,
        "title": title or f"{' vs '.join(s['name'] for s in series)} by {by.replace('_', ' ')}",
        "labels": labels,
        "series": series,
        "points": [],  # the multi-series shape carries data in `series`
        "independent_scales": chart_type == "grouped" and mixed_units,
        "truncated": False,
    }

    out: dict[str, Any] = {
        "chart": spec,
        "grouped_by": by,
        "metrics": metrics,
        "applied_filters": filters or {},
    }
    if spec["independent_scales"]:
        out["note"] = (
            "These metrics have different units, so each series is scaled to its own "
            "maximum. Compare each series ACROSS groups; do not compare bar lengths "
            "BETWEEN series."
        )
    return out


def build_chart(
    *,
    chart_type: str,
    by: str,
    metric: str = "incremental_sales",
    metrics: list[str] | None = None,
    filters: dict[str, Any] | None = None,
    title: str | None = None,
    limit: int = MAX_GROUPS,
    bins: int | None = None,
    currency: str = "INR",
) -> dict[str, Any]:
    """One chart spec, computed from the KPI engine.

    Returns either `{"chart": {...}}` for the UI, or `{"error": ...}` — which
    the model is told to explain in words rather than retry blindly.
    """
    if chart_type not in CHART_TYPES:
        chart_type = "bar"
    if by not in T.BREAKDOWN_DIMENSIONS:
        return {"error": f"cannot chart by {by!r}; choose one of {list(T.BREAKDOWN_DIMENSIONS)}"}
    if metric not in T.BREAKDOWN_METRICS:
        metric = "incremental_sales"

    currency = F.normalise_currency(currency)
    wanted = _clean_metrics(metrics, metric) if metrics else [metric]

    try:
        limit = max(2, min(int(limit), MAX_GROUPS))
    except (TypeError, ValueError):
        limit = MAX_GROUPS

    # --- the families that do not draw a single ranked series ---------------
    if chart_type == "histogram":
        return _build_histogram(
            by=by, metric=wanted[0], filters=filters, title=title, bins=bins, currency=currency
        )
    if chart_type == "scatter":
        return _build_scatter(
            by=by, metrics=wanted, filters=filters, title=title, currency=currency
        )

    # A stacked chart claims its parts sum to a whole — the same claim a pie
    # makes, so it faces the same test before anything is computed.
    downgraded = False
    if chart_type == "stacked" and any(m not in ADDITIVE_METRICS for m in wanted):
        chart_type = "grouped"
        downgraded = True

    if chart_type in MULTI_METRIC_TYPES:
        # One metric is not a comparison; fall through to the single-series
        # path rather than drawing a "grouped" chart with a single group.
        if len(wanted) > 1:
            out = _build_multi(
                chart_type=chart_type, by=by, metrics=wanted, filters=filters,
                title=title, limit=limit, currency=currency,
            )
            if downgraded and "chart" in out:
                out["note"] = (
                    "Stacking would claim these groups sum to the whole, which is not true of "
                    f"{', '.join(m for m in wanted if m not in ADDITIVE_METRICS)} — the baseline "
                    "is re-derived per group. Drawn as grouped bars instead; say so if the "
                    "reader asked for a stack."
                )
            return out
        chart_type = "bar"
        metric = wanted[0]
    else:
        metric = wanted[0]

    # A part-of-whole chart is only honest for an additive metric.
    if chart_type in PART_OF_WHOLE_TYPES and metric not in ADDITIVE_METRICS:
        chart_type = "bar"
        downgraded = True

    # One more than we will draw, so we can tell a tail exists without a
    # second pass over the fact table.
    result = T.run_analysis(filters or {}, by, metric, limit + 1)
    if "error" in result:
        return {"error": result["error"]}

    groups = result.get("groups") or []
    if not groups:
        return {"error": "no rows matched this selection, so there is nothing to chart"}

    shown = groups[:limit]
    tail = groups[limit:]

    points = [
        {
            "label": str(g.get("group") or "—"),
            "value": float(g.get(metric) or 0.0),
            "display": _display(metric, g.get(metric), currency),
        }
        for g in shown
    ]

    # The tail becomes one honest "Other" row — but ONLY for an additive
    # metric, where adding the groups up means something. For a ranking, the
    # rest are simply not shown and the chart says so.
    truncated = bool(tail) or bool(result.get("truncated"))
    if tail and metric in ADDITIVE_METRICS:
        other = sum(float(g.get(metric) or 0.0) for g in tail)
        if other > 0:
            points.append(
                {"label": "Other", "value": other, "display": _display(metric, other, currency)}
            )

    spec: dict[str, Any] = {
        "type": chart_type,
        "title": title or f"{_unit_label(metric, currency)} by {by.replace('_', ' ')}",
        "unit": _unit_label(metric, currency),
        "points": points,
        "truncated": truncated,
    }

    out: dict[str, Any] = {
        "chart": spec,
        "grouped_by": by,
        "ranked_by": metric,
        "applied_filters": filters or {},
    }
    if downgraded:
        out["note"] = (
            f"A pie would claim the groups sum to the whole, which is not true of {metric} — "
            "its baseline is re-derived per group. Drawn as a ranked bar chart instead; say so "
            "if the reader asked for a pie."
        )
    return out
