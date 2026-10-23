"""The figures the MMM Analyst answers from.

ONE SOURCE, THE PAGE'S OWN. Every number here comes out of
`app.mmm.service.hub()` — the same call that draws the MMM Insights Hub. The
Analyst therefore cannot disagree with the page it is sitting on, and a
baseline is never re-derived a second way: `service.hub` is `lru_cache`d per
scope, so a turn asking three questions about one period pays for it once.

THIS IS THE MMM ANSWER TO app/agents/star_tools.py, and it is thinner on
purpose. TPO's tools plan over a star schema: six dimension tables, a resolver
for codes that are not display names, a breakdown engine. MMM is ONE DAILY
TABLE, and `service.hub` already returns every breakdown the page shows. So
there is nothing to join and nothing to re-aggregate — the work here is
choosing which of the hub's own lists answers the question, and ranking it.

WHAT A PART-OF-WHOLE CHART MAY SHOW, AND WHY IT MATTERS HERE. Per channel,
ad spend sums to total ad spend and ATTRIBUTED revenue sums to the revenue of
the days with ad spend — both are parts of one whole, so a donut is honest.
"Revenue on active days" is NOT: channels overlap, so a day with three
channels on air is counted three times and the parts add to more than the
whole. ROAS never sums to anything. Each dimension therefore carries its own
list of additive metrics, and `build_chart` downgrades a donut of anything
else to a bar rather than drawing a chart that lies about its own arithmetic.
"""

from __future__ import annotations

import math
from dataclasses import dataclass
from typing import Any

from app.agents import mmm_scope
from app.mmm import loader, service
from app.mmm.scope import EVENTS, Scope
from app.tpo import formatting as F

#: Must match MAX_SERIES in frontend/src/components/analyst/chartPalette.ts:
#: the categorical palette has six validated hues and is never cycled, so a
#: seventh group would have to reuse a colour. The tail folds into "Other"
#: where that is honest, and is simply not shown where it is not.
MAX_GROUPS = 6

#: Break-even. A ROAS chart is read against this line, not against its own
#: leader — see `AnalystChartSpec.reference`.
BREAKEVEN_ROAS = 1.0

CHART_TYPES = ("bar", "column", "line", "area", "pie", "donut")

#: How many trend buckets one answer carries. A weekly trend over three years
#: is 150 of them, which costs more in a prompt than it tells.
MAX_TREND_POINTS = 24


class MmmToolError(ValueError):
    """A question the MMM data cannot answer. The message is for the model."""


# --- the breakdowns the hub already computes -----------------------------------


@dataclass(frozen=True)
class Dimension:
    """One of the hub's own lists, and how to read it as a breakdown."""

    key: str
    #: Which list in the hub payload.
    source: str
    #: The field holding each row's name.
    label_field: str
    #: What one row is, for the model to choose by.
    about: str
    #: Metrics this list carries, in the order they are worth ranking by.
    metrics: tuple[str, ...]
    #: Of those, the ones whose groups genuinely sum to the selection's total.
    additive: frozenset[str]


DIMENSIONS: tuple[Dimension, ...] = (
    Dimension(
        "channel", "channels", "label",
        "One media channel (a *_Spend column): Digital Search, TV, Print, and so on.",
        ("spend", "revenue_attributed", "roas", "share", "active_days",
         "avg_active_day", "revenue"),
        frozenset({"spend", "revenue_attributed", "share"}),
    ),
    Dimension(
        "family", "families", "family",
        "A channel FAMILY — Digital, Traditional, Retail — above the channels in it.",
        ("spend", "revenue_attributed", "roas", "share", "active_days", "revenue"),
        frozenset({"spend", "revenue_attributed", "share"}),
    ),
    Dimension(
        "promotion", "promotions", "type",
        "One promotion type, measured over the days it ran.",
        ("revenue", "spend", "roas", "days", "avg_revenue",
         "share_of_revenue", "share_of_days"),
        # Promotion type is one value per DAY, so the days are a partition and
        # the revenue and spend over them add back to the period's own totals.
        frozenset({"revenue", "spend", "days", "share_of_revenue", "share_of_days"}),
    ),
    Dimension(
        "event", "events", "label",
        "A day flag — ad spend, Festival, Seasonal, Promotion, any event — with the "
        "average daily revenue on the days that had it and the days that did not.",
        ("difference", "with_avg", "without_avg", "with_days", "without_days"),
        # Each row is a DIFFERENT test over the same days, so nothing here is a
        # part of anything: "Festival" and "Seasonal" overlap by construction.
        frozenset(),
    ),
)
BY_KEY: dict[str, Dimension] = {d.key: d for d in DIMENSIONS}
BREAKDOWN_DIMENSIONS: tuple[str, ...] = tuple(d.key for d in DIMENSIONS)
#: Every metric any dimension offers, for a tool schema's enum.
BREAKDOWN_METRICS: tuple[str, ...] = tuple(
    dict.fromkeys(m for d in DIMENSIONS for m in d.metrics)
)

#: How each metric is written. A metric not listed is a plain number, which is
#: right for a count.
_MONEY = frozenset({"spend", "revenue", "revenue_attributed", "avg_active_day",
                    "avg_revenue", "with_avg", "without_avg"})
_MULTIPLE = frozenset({"roas"})
_PERCENT = frozenset({"share", "share_of_revenue", "share_of_days", "difference"})


def display(metric: str, value: Any, currency: str) -> str:
    if value is None:
        return "—"
    try:
        number = float(value)
    except (TypeError, ValueError):
        return str(value)
    if metric in _MONEY:
        return F.money(number, currency)
    if metric in _MULTIPLE:
        return F.multiple(number)
    if metric in _PERCENT:
        return F.percent(number, signed=metric == "difference")
    return F.quantity(number)


def unit_label(metric: str, currency: str) -> str:
    symbol = "₹" if currency == "INR" else "$"
    return {
        "spend": f"Ad Spend ({symbol})",
        "revenue": f"Revenue on Active Days ({symbol})",
        "revenue_attributed": f"Attributed Revenue ({symbol})",
        "avg_active_day": f"Avg Spend per Active Day ({symbol})",
        "avg_revenue": f"Avg Daily Revenue ({symbol})",
        "with_avg": f"Avg Revenue on Those Days ({symbol})",
        "without_avg": f"Avg Revenue on Other Days ({symbol})",
        "roas": "ROAS (multiple of spend)",
        "share": "Share of Ad Spend (%)",
        "share_of_revenue": "Share of Revenue (%)",
        "share_of_days": "Share of Days (%)",
        "difference": "Lift vs Days Without (%)",
        "active_days": "Active Days",
        "with_days": "Days With",
        "without_days": "Days Without",
        "days": "Days",
    }.get(metric, metric.replace("_", " ").title())


# --- reading the hub ------------------------------------------------------------


def scope_of(filters: dict[str, Any] | None) -> Scope:
    """The hub's Scope from the Analyst's filter dict.

    The keys are the page's own (`frontend/src/mmm/store.ts` → `toWire`), so a
    filter the Analyst sets and a filter the reader sets are the same filter.

    NAMES ARE RESOLVED HERE, not only on the page-driving path. The model reads
    "TV" off a chart and writes "TV" back; the scope wants `TV_Spend`. Asked
    "just show TV and OTT" it set the page correctly and then called `compare`
    with the display names, which came back "Unknown channel(s): OTT, TV" — the
    question failing on the names the product puts on its own charts. One
    resolver on every path in, or the two paths disagree about what the reader
    said.
    """
    f = dict(filters or {})
    try:
        return Scope.build(
            year=_int(f.get("year")),
            quarter=_int(f.get("quarter")),
            month=_int(f.get("month")),
            week=_int(f.get("week")),
            date_from=f.get("date_from") or None,
            date_to=f.get("date_to") or None,
            channels=_resolve_values("channels", f.get("channels")),
            promotion_types=_resolve_values("promotion_types", f.get("promotion_types")),
            events=_resolve_values("events", f.get("events")),
        )
    except ValueError as exc:
        raise MmmToolError(str(exc)) from exc


def _resolve_values(key: str, values: Any) -> tuple[str, ...]:
    """Display names or codes, as codes. Unknown values are REFUSED by name
    rather than dropped: a filter that quietly ignored half of what it was
    given would answer a narrower question than the one asked, and say
    nothing."""
    wanted = [str(v).strip() for v in (values or []) if str(v).strip()]
    if not wanted:
        return ()
    codes, unknown = mmm_scope._resolve(key, wanted)
    if unknown:
        available = ", ".join(mmm_scope._display_names(key)) or "none"
        raise MmmToolError(
            f"No {mmm_scope.FILTER_LABELS[key]} called {', '.join(unknown)}. "
            f"Available: {available}."
        )
    return tuple(codes)


def _int(value: Any) -> int | None:
    if value is None or value == "":
        return None
    try:
        return int(value)
    except (TypeError, ValueError) as exc:
        raise MmmToolError(f"{value!r} is not a whole number.") from exc


def payload(filters: dict[str, Any] | None, *, granularity: str = "month",
            currency: str = "INR") -> dict[str, Any]:
    """The hub payload for one scope. Cached by `service.hub`."""
    try:
        return service.hub(scope_of(filters), granularity, F.normalise_currency(currency))
    except loader.MmmDatasetMissing as exc:
        raise MmmToolError(
            "No MMM dataset is installed, so there is nothing to read. Connect a source "
            "on the MMM Data Connections page first."
        ) from exc
    except ValueError as exc:
        raise MmmToolError(str(exc)) from exc


def kpis(filters: dict[str, Any] | None, currency: str = "INR") -> dict[str, Any]:
    """Every headline figure for a scope, with the period it covers.

    The KPIs come back with the page's own displays attached — the model is
    never asked to format a figure, for the reason `_with_display` gives in
    app/agents/analyst.py: a model that writes "₹1.2 Cr" next to a value of
    123_456_789 has told the reader something false in the part they read.
    """
    data = payload(filters, currency=currency)
    meta = data["meta"]
    return {
        "period": meta["period_label"],
        "days_in_period": meta["period_days"],
        "days_after_filters": meta["days"],
        "channels_in_scope": meta["channels"],
        "channels_in_data": meta["channels_total"],
        "currency": meta["currency"],
        "comparison": meta["comparison"],
        "baseline_per_day": data["baseline"].get("per_day_display"),
        "baseline_available": data["baseline"].get("available"),
        "baseline_note": data["baseline"].get("reason") or "",
        "kpis": [
            {
                "key": k["key"], "label": k["label"], "value": k["value"],
                "display": k["display"], "unit": k["kind"],
                "change_vs_year_ago": k["delta_display"] or None,
                "available": k["available"],
                "unavailable_reason": k["unavailable_reason"] or None,
            }
            for k in data["kpis"]
        ],
    }


def breakdown(filters: dict[str, Any] | None, by: str, metric: str = "",
              limit: int = MAX_GROUPS, currency: str = "INR",
              order: str = "best") -> dict[str, Any]:
    """One of the hub's lists, ranked by one of its metrics.

    `order` is which END of the ranking to return: "best" is the largest first,
    "worst" the smallest.

    WHY BOTH. The list used to rank downwards only, so "which channel had the
    worst ROAS?" could not be asked. The model asked for a ranking, got the top
    six of twenty-two and read the last row — naming the SIXTH BEST channel as
    the worst, with a figure that was correct for a channel nobody had asked
    about. A ranking the reader can only see one end of is a ranking that
    answers half the questions wrongly rather than refusing them.

    A metric that is None for a group (a ROAS with no baseline behind it) sorts
    last whichever end is asked for, because "could not be measured" is not
    "measured as nothing" — and it is certainly not the worst.
    """
    dimension = BY_KEY.get(by)
    if dimension is None:
        raise MmmToolError(
            f"Cannot break down by {by!r}. Available: {', '.join(BREAKDOWN_DIMENSIONS)}."
        )
    chosen = metric or dimension.metrics[0]
    if chosen not in dimension.metrics:
        raise MmmToolError(
            f"{dimension.key} does not carry {chosen!r}. It has: "
            f"{', '.join(dimension.metrics)}."
        )

    data = payload(filters, currency=currency)
    rows = [r for r in (data.get(dimension.source) or []) if isinstance(r, dict)]
    if not rows:
        raise MmmToolError(
            f"This selection has no {dimension.key} rows — "
            f"{data['meta']['period_label']} may hold no matching days."
        )

    wanted = (order or "best").strip().lower()
    wanted = {"desc": "best", "asc": "worst", "lowest": "worst", "bottom": "worst",
              "highest": "best", "top": "best"}.get(wanted, wanted)
    if wanted not in ("best", "worst"):
        raise MmmToolError(f"order is 'best' or 'worst', not {order!r}.")
    sign = 1 if wanted == "worst" else -1
    ranked = sorted(
        rows,
        key=lambda r: (r.get(chosen) is None, sign * _number(r.get(chosen))),
    )
    bounded = max(2, min(int(limit or MAX_GROUPS), 50))
    groups = [
        {
            "group": str(r.get(dimension.label_field) or "—"),
            chosen: r.get(chosen),
            f"{chosen}_display": display(chosen, r.get(chosen), data["meta"]["currency"]),
            # The two figures a reader always wants beside a ranking, when the
            # row has them and they are not the ranking itself.
            **{
                k: r.get(k) for k in ("spend_display", "roas_display", "active_days", "days")
                if k in r and k != chosen and f"{chosen}_display" != k
            },
        }
        for r in ranked[:bounded]
    ]
    out: dict[str, Any] = {
        "period": data["meta"]["period_label"],
        "grouped_by": dimension.key,
        "ranked_by": chosen,
        "showing": f"the {wanted} {len(groups)} of {len(rows)}",
        "unit": unit_label(chosen, data["meta"]["currency"]),
        "groups": groups,
        "groups_in_total": len(rows),
        "truncated": len(rows) > bounded,
        "applied_filters": data["meta"]["scope"],
    }
    if chosen not in dimension.additive:
        out["note"] = _not_additive_note(dimension, chosen)
    if out["truncated"]:
        # The model read the last row of a top-six as "the worst". Saying which
        # end this is, in words, beside the rows themselves.
        out["warning"] = (
            f"These are the {wanted.upper()} {len(groups)} of {len(rows)} "
            f"{dimension.key}s. The other {len(rows) - len(groups)} are NOT here — do "
            f"not describe the last row as the "
            f"{'worst' if wanted == 'best' else 'best'}. Ask again with "
            f"order='{'worst' if wanted == 'best' else 'best'}' for the other end."
        )
    return out


def _not_additive_note(dimension: Dimension, metric: str) -> str:
    if dimension.key == "event":
        return (
            "Each row is a different test over the same days, and the flags overlap — "
            "a festival day can also be a promotion day. These do not add up to "
            "anything, and no share of them means anything."
        )
    if metric == "roas":
        return "A ranking only: ROAS is a ratio, so these do not add up to the period's ROAS."
    if metric == "revenue" and dimension.key in ("channel", "family"):
        return (
            "Revenue on ACTIVE DAYS: a day with three channels on air is counted once for "
            "each, so these add to more than the period's revenue. For parts of one whole, "
            "rank by revenue_attributed instead."
        )
    return "A ranking only — these groups do not sum to the selection's total."


def comparison(filters: dict[str, Any] | None, currency: str = "INR") -> dict[str, Any]:
    """This period against a year ago, the period before, and a month ago.

    The hub's own Period Comparison card, read as figures. Each window says
    whether it is AVAILABLE and why not when it is not — a period partly
    outside the data has no honest delta, and inventing one is the failure this
    returns a reason instead of.
    """
    data = payload(filters, currency=currency)
    card = data["comparison"]
    labels = {m["key"]: m["label"] for m in card["metrics"]}
    return {
        "period": card["period_label"],
        "current": {
            labels.get(k, k): v["display"] for k, v in card["current"].items()
        },
        "windows": [
            {
                "key": w["key"],
                "name": w["full"],
                "period": w["period_label"] or None,
                "available": w["available"],
                "reason": w["reason"] or None,
                "values": {labels.get(k, k): v["display"] for k, v in (w["values"] or {}).items()},
                "change": {
                    labels.get(k, k): d["display"] for k, d in (w["delta"] or {}).items()
                },
            }
            for w in card["windows"]
        ],
    }


def decomposition(filters: dict[str, Any] | None, currency: str = "INR") -> dict[str, Any]:
    """What the revenue is made of: the baseline, and each channel's credited
    incremental revenue. The hub's Revenue Decomposition card, as figures."""
    data = payload(filters, currency=currency)
    return {
        "period": data["meta"]["period_label"],
        "decomposition": data["decomposition"],
    }


def trend(filters: dict[str, Any] | None, granularity: str = "month",
          currency: str = "INR", limit: int = MAX_TREND_POINTS) -> dict[str, Any]:
    """Revenue, ad spend, baseline and ROAS per bucket, as rows.

    THE HUB HOLDS THE TREND AS PARALLEL ARRAYS, which is what a chart wants and
    the opposite of what a model reads well: asked "which month was worst" over
    nine lists it has to count positions in each. They are zipped into one row
    per bucket here.

    EACH BUCKET'S BASELINE IS ITS OWN. The baseline is re-estimated over the
    days in that bucket (app/mmm/baseline.py), so a monthly and a weekly trend
    of the same period do not hold the same numbers, and neither is wrong.

    BOUNDED. A weekly trend across three years is 150 buckets; past `limit` the
    MOST RECENT are kept and the answer says so, because a tail of 150 rows
    costs more than it tells and a silent truncation from the wrong end would
    answer "how did we finish" with how we started.
    """
    value = (granularity or "month").strip().lower()
    if value not in service.GRANULARITIES:
        raise MmmToolError(
            f"granularity must be one of {', '.join(service.GRANULARITIES)}."
        )
    data = payload(filters, granularity=value, currency=currency)
    series = data["trend"]
    labels = series.get("labels") or []
    rows = [
        {
            "bucket": labels[i],
            "revenue": series["revenue_display"][i],
            "ad_spend": series["spend_display"][i],
            "baseline": series["baseline_display"][i],
            "roas": series["roas_display"][i],
            "days": series["days"][i],
            "days_with_ad_spend": series["ad_days"][i],
        }
        for i in range(len(labels))
    ]
    bounded = max(2, min(int(limit or MAX_TREND_POINTS), MAX_TREND_POINTS))
    out: dict[str, Any] = {
        "period": data["meta"]["period_label"],
        "granularity": series.get("granularity", value),
        "buckets": rows[-bounded:],
    }
    if len(rows) > bounded:
        out["note"] = (
            f"{len(rows)} buckets in this period; the most recent {bounded} are shown. "
            "Narrow the period, or ask monthly instead of weekly, to see the rest."
        )
    return out


def trend_chart(filters: dict[str, Any] | None, metric: str = "roas",
                granularity: str = "month", currency: str = "INR",
                title: str | None = None) -> dict[str, Any]:
    """The trend as a LINE CHART of one measure over time.

    `breakdown` ranks groups; this is the other shape of question — the same
    measure at successive moments — and a bar chart of it would read as a
    ranking of months, which is not what a reader asked "how did ROAS move"
    wants to see.
    """
    allowed = ("roas", "spend", "revenue", "baseline")
    chosen = (metric or "roas").strip().lower()
    chosen = {"ad_spend": "spend", "roas_trend": "roas"}.get(chosen, chosen)
    if chosen not in allowed:
        raise MmmToolError(
            f"The trend carries {', '.join(allowed)} — not {metric!r}."
        )
    data = trend(filters, granularity, currency)
    key = {"spend": "ad_spend"}.get(chosen, chosen)
    raw = payload(filters, granularity=data["granularity"], currency=currency)["trend"]
    labels = raw.get("labels") or []
    shown = {b["bucket"] for b in data["buckets"]}
    points = [
        {
            "label": labels[i],
            "value": _number(raw[chosen][i]),
            "display": raw[f"{chosen}_display"][i],
        }
        for i in range(len(labels))
        if labels[i] in shown
    ]
    unit = {
        "roas": "ROAS (multiple of spend)",
        "spend": unit_label("spend", F.normalise_currency(currency)),
        "revenue": unit_label("revenue", F.normalise_currency(currency)).replace(
            "Revenue on Active Days", "Revenue"),
        "baseline": f"Baseline Revenue ({'₹' if F.normalise_currency(currency) == 'INR' else '$'})",
    }[chosen]
    spec: dict[str, Any] = {
        "type": "line",
        "title": title or f"{unit.split(' (')[0]} by "
                          f"{'week' if data['granularity'] == 'week' else 'month'}",
        "unit": unit,
        "points": points,
    }
    if chosen == "roas":
        spec["reference"] = {"value": BREAKEVEN_ROAS, "label": "Break-even 1.00x"}
    out = {"chart": spec, "period": data["period"], "granularity": data["granularity"],
           "measure": key}
    if "note" in data:
        out["note"] = data["note"]
    return out


def schema_summary() -> dict[str, Any]:
    """What the MMM dataset holds — for the model to plan a filter with.

    Read from the installed file on every call, because the dataset is replaced
    by an upload or a connector sync and a remembered answer would describe one
    that is gone.
    """
    try:
        options = service.filters()
    except loader.MmmDatasetMissing as exc:
        raise MmmToolError(
            "No MMM dataset is installed. Connect a source on the MMM Data Connections "
            "page first."
        ) from exc
    return {
        "years": options.get("years") or [],
        "quarters": [q["name"] for q in options.get("quarters") or []],
        "months": [m["name"] for m in options.get("months") or []],
        "date_range": options.get("date_range") or {},
        "channels": [
            {"code": c["code"], "name": c["name"], "family": c.get("family")}
            for c in options.get("channels") or []
        ],
        "promotion_types": options.get("promotion_types") or [],
        "events": [e["name"] for e in options.get("events") or []],
        "breakdowns": {
            d.key: {"about": d.about, "metrics": list(d.metrics)} for d in DIMENSIONS
        },
        "kpis": [
            {"key": m["key"], "label": m["label"], "unit": m["unit"]}
            for m in service.METRICS
        ],
    }


def define_kpi(term: str) -> dict[str, Any]:
    """One MMM metric's formula, transcribed from the code that computes it.

    THE FORMULAS ARE NOT WRITTEN HERE. Each is `formula` on the metric in
    app/mmm/service.py METRICS, which is the same string the ⓘ on the card
    shows — so a definition the Analyst gives and a definition the page gives
    cannot differ.
    """
    wanted = _norm(term)
    if not wanted:
        raise MmmToolError("Say which metric to define.")
    for m in service.METRICS:
        if wanted in (_norm(m["key"]), _norm(m["label"])) or wanted in _norm(m["label"]):
            return {"term": m["label"], "unit": m["unit"], "formula": m["formula"]}
    extra = {
        "baselinerevenue": "Baseline per day × days in scope, re-estimated for every range.",
        "attributedrevenue": (
            "Each day's revenue shared across the channels on air that day, in proportion "
            "to what each spent. Every rupee is counted once, so channels are parts of one "
            "whole. Descriptive, not causal."
        ),
        "breakeven": "ROAS of 1.00x — the ads returned exactly what was spent on them.",
        "roi": (
            "This hub measures ROAS, not TPO's ROI: Incremental Revenue ÷ Total Ad Spend. "
            "Both are multiples of spend, but they are computed from different data."
        ),
    }
    for key, text in extra.items():
        if wanted == key or (len(wanted) > 3 and wanted in key):
            return {"term": term, "formula": text}
    raise MmmToolError(
        f"I have no definition for {term!r}. The metrics are: "
        f"{', '.join(m['label'] for m in service.METRICS)}."
    )


def _norm(text: str) -> str:
    return "".join(ch for ch in str(text or "").lower() if ch.isalnum())


def _number(value: Any) -> float:
    try:
        number = float(value)
    except (TypeError, ValueError):
        return 0.0
    return 0.0 if math.isnan(number) else number


# --- charts ---------------------------------------------------------------------


def build_chart(*, chart_type: str, by: str, metric: str = "", limit: int = MAX_GROUPS,
                filters: dict[str, Any] | None = None, title: str | None = None,
                currency: str = "INR", order: str = "best") -> dict[str, Any]:
    """One chart spec, computed from the hub.

    THE MODEL DOES NOT SUPPLY THE NUMBERS. It asks for a chart of a breakdown;
    this re-reads that breakdown from `service.hub` and emits the points. So a
    chart cannot disagree with the sentence beside it, and a model that
    hallucinated a figure could not get it onto an axis.
    """
    kind = (chart_type or "bar").strip().lower()
    if kind not in CHART_TYPES:
        kind = "bar"
    dimension = BY_KEY.get(by)
    if dimension is None:
        raise MmmToolError(
            f"Cannot chart by {by!r}. Available: {', '.join(BREAKDOWN_DIMENSIONS)}."
        )
    chosen = metric or dimension.metrics[0]

    # A pie or a donut asserts that the parts sum to the whole. Held to the
    # dimension's own additive list — see the module docstring.
    downgraded = False
    if kind in ("pie", "donut") and chosen not in dimension.additive:
        kind = "bar"
        downgraded = True

    result = breakdown(filters, dimension.key, chosen,
                       limit=min(int(limit or MAX_GROUPS), MAX_GROUPS) + 1,
                       currency=currency, order=order)
    groups = result["groups"]
    shown = groups[: max(2, min(int(limit or MAX_GROUPS), MAX_GROUPS))]
    tail = groups[len(shown):]

    points = [
        {
            "label": g["group"],
            "value": _number(g.get(chosen)),
            "display": g.get(f"{chosen}_display") or "—",
        }
        for g in shown
    ]
    # The tail becomes one honest "Other" row, but ONLY where adding the groups
    # up means something. For a ranking the rest are simply not shown.
    if tail and chosen in dimension.additive:
        other = sum(_number(g.get(chosen)) for g in tail)
        if other > 0:
            points.append({
                "label": "Other", "value": other,
                "display": display(chosen, other, F.normalise_currency(currency)),
            })

    spec: dict[str, Any] = {
        "type": kind,
        "title": title or f"{unit_label(chosen, F.normalise_currency(currency))} "
                          f"by {dimension.key.replace('_', ' ')}",
        "unit": unit_label(chosen, F.normalise_currency(currency)),
        "points": points,
        "truncated": bool(tail) or result["truncated"],
    }
    # A ROAS chart is read against break-even, not against its own leader.
    if chosen == "roas":
        spec["reference"] = {"value": BREAKEVEN_ROAS, "label": "Break-even 1.00x"}

    out: dict[str, Any] = {
        "chart": spec,
        "grouped_by": dimension.key,
        "ranked_by": chosen,
        "period": result["period"],
        "applied_filters": result["applied_filters"],
    }
    if downgraded:
        out["note"] = (
            f"A pie would claim the groups sum to the whole, which is not true of {chosen} "
            f"for {dimension.key}. Drawn as a ranked bar chart instead; say so if the reader "
            "asked for a pie."
        )
    elif "note" in result:
        out["note"] = result["note"]
    return out


def for_model(result: Any) -> Any:
    """A tool result with every figure that has a display string redacted.

    REPORTED, ON THE FIRST QUESTION ANYONE ASKED IT. "What is the revenue in
    year 2025" came back "₹15,236.70 Cr" while the card beside it read
    "₹1,523.67 Cr" — ten times the real figure, stated with no hedge. The tool
    had returned `value: 15236703905.0` AND `display: "₹1,523.67 Cr"`; the
    model took the raw number, divided it by a million, and wrote "Cr".

    The prompt already forbade exactly that, and it failed on the first
    question of the first session. A rule the model can ignore is not a
    guarantee. The only guarantee is not handing it the number.

    THE RULE: a numeric field is dropped when something in the same object
    already says what it is in words — `value` beside `display`, `spend`
    beside `spend_display`. A number with NO display string stays, because it
    is a count of days or a share and reads correctly on its own.

    The browser's copy of a chart is taken out of the result before this runs,
    and `steps` keeps the whole thing, so what the reader sees is unchanged.
    """
    if isinstance(result, dict):
        out: dict[str, Any] = {}
        for key, value in result.items():
            if f"{key}_display" in result:
                continue
            if key == "value" and "display" in result:
                continue
            out[key] = for_model(value)
        return out
    if isinstance(result, list):
        return [for_model(item) for item in result]
    return result


def event_names() -> str:
    """The event codes a filter takes, for the prompt."""
    return ", ".join(f"{code} ({name})" for code, name in EVENTS.items())
