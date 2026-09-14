"""
Promotion Intelligence — the deterministic half.

Everything the Intelligence page shows as a number, chart or table is computed
here from the star schema, through app/tpo/service.py. No model touches these
figures; the agent layer (app/agents/intelligence_agent.py) only interprets
them and writes recommendations.

The headline analysis is the discount saturation curve. The dataset's mechanics
carry their own depth — "5% Discount" through "20% Discount", plus Buy3Get1,
which is one free unit in four and so 25% effective. That gives five real
depth points to plot ROI against, which is a genuine elasticity read rather
than a decorative curve.
"""
import json
import math
import re
from typing import Any

from app.agents.star_tools import build_filter_state, run_analysis, segment_kpis
from app.tpo import config, service
from app.tpo.filters import rows_for

# Effective discount depth per mechanic. Buy3Get1 is 25% (one unit free in
# four) — the same reading the Command Center's economics fix applied.
_BUY_N_GET_M = re.compile(r"buy\s*(\d+)\s*get\s*(\d+)", re.I)
_PERCENT = re.compile(r"(\d+(?:\.\d+)?)\s*%")


def mechanic_depth(label: str) -> float | None:
    """Effective discount depth implied by a mechanic's name, or None when the
    name carries no depth (so it's excluded rather than guessed at)."""
    if not label:
        return None
    if "no discount" in label.lower():
        return 0.0
    m = _BUY_N_GET_M.search(label)
    if m:
        buy, get = int(m.group(1)), int(m.group(2))
        total = buy + get
        return round(get / total * 100, 1) if total else None
    p = _PERCENT.search(label)
    return float(p.group(1)) if p else None


def saturation_curve(filters: dict[str, Any] | None = None) -> dict[str, Any]:
    """ROI and lift against discount depth — where deeper discounting stops
    paying for itself."""
    groups = run_analysis(filters, "promotion_mechanic", "roi", limit=20).get("groups") or []
    points = []
    for g in groups:
        depth = mechanic_depth(str(g.get("group", "")))
        if depth is None or g.get("roi") is None:
            continue
        points.append(
            {
                "mechanic": g["group"],
                "depth_pct": depth,
                "roi_multiple": g.get("roi"),
                "incremental_sales": g.get("incremental_sales"),
                "trade_spend": g.get("trade_spend"),
                "spend_share_pct": g.get("share_pct"),
            }
        )
    points.sort(key=lambda p: p["depth_pct"])

    # Saturation = the shallowest depth at or beyond which ROI has fallen below
    # the target hurdle and keeps falling. Reported as None when the curve never
    # crosses it, rather than inventing a threshold.
    target = config.PROMOTION_TARGET_ROI
    saturation = None
    for i, p in enumerate(points):
        if p["roi_multiple"] is not None and p["roi_multiple"] < target:
            later = [q["roi_multiple"] for q in points[i:] if q["roi_multiple"] is not None]
            if later and all(v < target for v in later):
                saturation = p["depth_pct"]
                break

    above = [p for p in points if p["roi_multiple"] is not None and p["roi_multiple"] >= target]
    optimal = (
        f"{min(p['depth_pct'] for p in above):.0f}–{max(p['depth_pct'] for p in above):.0f}%"
        if above
        else "no depth clears the target"
    )
    return {
        "points": points,
        "target_roi": target,
        "saturation_depth_pct": saturation,
        "optimal_range": optimal,
        "monotonic_decline": all(
            points[i]["roi_multiple"] >= points[i + 1]["roi_multiple"] for i in range(len(points) - 1)
        )
        if len(points) > 1
        else False,
    }


def contribution_waterfall(filters: dict[str, Any] | None = None) -> dict[str, Any]:
    """Which mechanics build or destroy incremental sales, largest first —
    the decomposition behind the headline number."""
    groups = run_analysis(filters, "promotion_mechanic", "incremental_sales", limit=10).get("groups") or []
    totals = segment_kpis(filters)
    items = [
        {
            "label": str(g.get("group")),
            "incremental_sales": g.get("incremental_sales"),
            "trade_spend": g.get("trade_spend"),
            "roi_multiple": g.get("roi"),
        }
        for g in groups
        if g.get("incremental_sales") is not None
    ]
    items.sort(key=lambda x: x["incremental_sales"], reverse=True)
    return {
        "items": items,
        "total_incremental_sales": totals.get("incremental_sales"),
        "total_trade_spend": totals.get("trade_spend"),
        "note": (
            "Incremental sales are re-baselined per selection, so mechanic figures "
            "rank contribution rather than summing to the total."
        ),
    }


def inc_sales_trend(filters: dict[str, Any] | None = None) -> dict[str, Any]:
    """Realised incremental sales against the spend-implied target, by month.

    Target comes from config.target_incremental_sales — the same inversion of
    the ROI definition the Command Center's "At Stake" figure uses, so the two
    pages cannot disagree about what "on target" means.
    """
    t = service.trend(build_filter_state(filters), "month")
    series = t.get("series") or {}
    spend = series.get("trade_spend") or []
    actual = series.get("incremental_sales") or []
    target = [config.target_incremental_sales(s) if s else None for s in spend]
    gap = [
        round(a - g, 1) if (a is not None and g is not None) else None
        for a, g in zip(actual, target)
    ]
    return {
        "labels": t.get("labels") or [],
        "actual": actual,
        "target": target,
        "trade_spend": spend,
        "roi": series.get("roi") or [],
        "gap_to_target": gap,
        "months_below_target": sum(1 for g in gap if g is not None and g < 0),
    }


def _watching_floor(target: float) -> float:
    """The ROI below which a group is `underperforming` rather than merely
    `watching`: 70% of the target's return ABOVE break-even, so 1.35 against a
    1.5 target. Measured from 1.0 and not from zero, because the first 1.0
    of any multiple is only the spend coming back."""
    return round(1 + (target - 1) * 0.7, 2)


def _dimension_table(filters: dict[str, Any] | None, by: str, limit: int = 10) -> list[dict[str, Any]]:
    groups = run_analysis(filters, by, "trade_spend", limit=limit).get("groups") or []
    target = config.PROMOTION_TARGET_ROI
    rows = []
    for g in groups:
        roi = g.get("roi")
        rows.append(
            {
                "name": g.get("group"),
                "trade_spend": g.get("trade_spend"),
                "incremental_sales": g.get("incremental_sales"),
                "roi_multiple": roi,
                "spend_share_pct": g.get("share_pct"),
                "vs_target": round(roi - target, 2) if roi is not None else None,
                "status": (
                    "unknown" if roi is None
                    else "on_track" if roi >= target
                    else "watching" if roi >= _watching_floor(target)
                    else "underperforming"
                ),
            }
        )
    return rows


# ---------------------------------------------------------------------------
# Driver decomposition.
#
# THIS EXISTS BECAUSE THE ANALYST USED TO SUPPLY THE WEIGHTS ITSELF. The
# schema asked for a `weight_pct` per driver described as "your judgement of
# relative contribution", and the Intelligence page rendered it as a labelled
# percentage beside a proportional bar. A reader cannot tell a judged 45% from
# a measured one, and nothing in this project computed it — so the figure was
# the one hallucination the page presented as arithmetic.
#
# It is now derived, exactly, from the same breakdown rows the page already
# shows. The agent's remaining job is which drivers matter and what they mean,
# which is judgement it is entitled to make.
# ---------------------------------------------------------------------------


def _largest_remainder(values: list[float], total: int = 100) -> list[int]:
    """Integer percentages that sum to exactly `total`.

    Rounding each share independently gives 34 + 33 + 32 = 99, and a set of
    contributions that visibly fails to add up reads as an error in the maths
    rather than in the rounding. Largest-remainder assigns the shortfall to the
    values that lost the most to flooring, which is the standard apportionment
    and is deterministic for a given input order.
    """
    if not values:
        return []
    pool = sum(values)
    if pool <= 0:
        return [0] * len(values)
    exact = [v / pool * total for v in values]
    floors = [int(math.floor(e)) for e in exact]
    shortfall = total - sum(floors)
    order = sorted(range(len(values)), key=lambda i: (exact[i] - floors[i], values[i]), reverse=True)
    for i in order[: max(0, shortfall)]:
        floors[i] += 1
    return floors


#: A driver has to account for at least this share of the movement to be worth
#: a row. Below it the bar renders at 0% and says nothing.
_DRIVER_FLOOR_PCT = 1

#: Pareto cut for calling a driver a root cause rather than a contributor.
_PRIMARY_CUMULATIVE_SHARE = 0.8


def roi_gap_decomposition(
    rows: list[dict[str, Any]], lens: str, limit: int = 8
) -> dict[str, Any]:
    """Each group's exact contribution to the ROI gap against target.

    THE FORMULA, and why it is exact rather than attributed. Promotion ROI is

        ROI = Incremental Sales / Trade Spend        (a multiple, 1.4)

    and Trade Spend is the one additive money measure in this engine (see
    `service.breakdown`'s additivity contract). So across the groups of one
    dimension the spend-weighted ROI is

        weighted_roi = SUM_g( spend_g x roi_g ) / SUM_g( spend_g )

    and its distance from the target hurdle decomposes with no residual:

        weighted_roi - target = SUM_g( spend_g x (roi_g - target) / SUM(spend) )
                              = SUM_g( contribution_g )

    `contribution` is that per-group term, in multiples of portfolio ROI (a
    group pulling the portfolio down by 0.1 contributes -0.1), and
    `weight_pct` is its share of the total absolute movement. Both are
    arithmetic on figures app/tpo/aggregate.py produced; neither is an opinion.

    A GROUP WITH HALF THE BUDGET AT A SMALL SHORTFALL OUTWEIGHS A TINY ONE AT A
    CATASTROPHIC ROI, which is the ranking the prompts have always asked for in
    words and can now stop asking for. `spend_g` is in the numerator precisely
    so that a 0.2 ROI on a few hundred rupees cannot lead the list.

    WHAT THIS IS NOT. It is not an attribution of cause: it says where the
    distance from target sits, not why. And because Incremental Sales is
    re-baselined per selection, `weighted_roi` is the spend-weighted mean of
    the group ROIs rather than the headline KPI — the two are close but not
    identical, and the payload reports it under its own name for that reason.
    """
    target = config.PROMOTION_TARGET_ROI
    usable = [
        r for r in rows
        if r.get("roi_multiple") is not None and (r.get("trade_spend") or 0) > 0
    ]
    total_spend = sum(r["trade_spend"] for r in usable)
    if not usable or total_spend <= 0:
        return {
            "lens": lens,
            "available": False,
            "reason": (
                "No group in this scope carries both trade spend and a defined ROI, "
                "so the gap cannot be decomposed."
            ),
            "target_roi": target,
            "drivers": [],
        }

    contributions = [
        r["trade_spend"] * (r["roi_multiple"] - target) / total_spend for r in usable
    ]
    weights = _largest_remainder([abs(c) for c in contributions])

    entries: list[dict[str, Any]] = []
    for row, contribution, weight in zip(usable, contributions, weights):
        spend = row["trade_spend"]
        roi = row["roi_multiple"]
        entries.append({
            "driver": str(row.get("name")),
            "weight_pct": weight,
            "direction": "negative" if contribution < 0 else "positive",
            "contribution": round(contribution, 2),
            "trade_spend": round(spend, 1),
            # Named for its denominator. It is NOT the row's own
            # `spend_share_pct`: groups with an undefined ROI cannot be
            # decomposed and are out of both sides of this ratio, so the two
            # figures differ whenever any group was excluded.
            "share_of_decomposed_spend_pct": round(spend / total_spend * 100, 1),
            "roi_multiple": roi,
            "vs_target": round(roi - target, 2),
            "incremental_sales": row.get("incremental_sales"),
            # The row a note can be written from without inventing anything.
            "measured_note": (
                f"₹{spend / 1e7:,.1f} Cr of trade spend "
                f"({round(spend / total_spend * 100, 1)}% of the scope) at {roi} ROI, "
                f"{round(roi - target, 2):+} against the {target} target."
            ),
            "is_primary": False,
        })
    entries.sort(key=lambda e: (-abs(e["contribution"]), e["driver"]))

    # PRIMARY = ROOT CAUSE, BY A STATED RULE. Take the drivers pulling the
    # portfolio the wrong way, largest first, until they account for 80% of
    # that adverse movement. Everything after them is a contributor. When
    # nothing is adverse the same cut is applied to what is carrying the
    # scope, so a healthy segment still names what is doing the work.
    adverse = [e for e in entries if e["contribution"] < 0]
    if not adverse:
        adverse = [e for e in entries if e["contribution"] > 0]
    pool = sum(abs(e["contribution"]) for e in adverse)
    running = 0.0
    for entry in adverse:
        if pool <= 0:
            break
        entry["is_primary"] = True
        running += abs(entry["contribution"])
        if running / pool >= _PRIMARY_CUMULATIVE_SHARE:
            break

    weighted_roi = sum(r["trade_spend"] * r["roi_multiple"] for r in usable) / total_spend
    shown = [e for e in entries if e["weight_pct"] >= _DRIVER_FLOOR_PCT][:limit]

    # NOTHING TO DECOMPOSE IS NOT THE SAME AS NOTHING TO REPORT. Every group
    # sitting on the target gives a gap of zero and therefore no weights, which
    # is a finding about the scope rather than a failure to measure it.
    reason = None
    if not shown:
        reason = (
            "Every group in this scope sits at the target ROI, so there is no gap to "
            "decompose."
            if abs(weighted_roi - target) < 0.005
            else "No group accounts for as much as 1% of the movement against target."
        )

    return {
        "lens": lens,
        "available": True,
        "reason": reason,
        "target_roi": target,
        "weighted_roi": round(weighted_roi, 2),
        "gap": round(weighted_roi - target, 2),
        "trade_spend_decomposed": round(total_spend, 1),
        "groups_decomposed": len(usable),
        "formula": (
            "contribution = trade_spend x (roi_multiple - target_roi) / total_trade_spend, in "
            "multiples; weight_pct = |contribution| as a share of the total absolute "
            "contribution, apportioned to integers summing to 100. The contributions sum to "
            "gap, which is weighted_roi - target_roi; each is reported to two decimal places, "
            "so adding the printed values back up can differ from gap in the last digit. "
            "gap is the figure to quote."
        ),
        "primary_rule": (
            "is_primary marks the adverse drivers that, taken largest first, account for "
            f"{int(_PRIMARY_CUMULATIVE_SHARE * 100)}% of the adverse movement."
        ),
        "weighted_roi_note": (
            "weighted_roi is the spend-weighted mean of the group ROIs, not the "
            "headline Promotion ROI: Incremental Sales is re-baselined per selection and "
            "so does not sum across groups. Cite the KPI for the headline."
        ),
        "displayed_weight_pct_total": sum(e["weight_pct"] for e in shown),
        "drivers": shown,
    }


# ---------------------------------------------------------------------------
# Lever positions.
#
# The Advisor's `simulation.current_value` used to be prose it wrote from
# memory of the facts, and it renders on both the Intelligence panel and the
# Simulation handoff card as "<current> -> <proposed>" — i.e. as the measured
# status quo. A proposal is the Advisor's to make; the status quo is not.
# Every lever the recommendation schema offers is measurable from the facts
# already computed for the same scope, so it is measured here and the agent's
# version is replaced with it.
# ---------------------------------------------------------------------------

#: The levers `RECOMMENDATION_SCHEMA.simulation.lever` admits.
LEVERS: tuple[str, ...] = (
    "discount_depth", "mechanic_mix", "spend_allocation",
    "channel_mix", "product_mix", "promotion_calendar",
)


def _unavailable(lever: str, reason: str) -> dict[str, Any]:
    return {"lever": lever, "available": False, "value": None, "display": reason, "basis": reason}


def _top_share(rows: list[dict[str, Any]] | None, lever: str, noun: str) -> dict[str, Any]:
    """The largest holder of trade spend in one dimension, and its share."""
    usable = [r for r in (rows or []) if (r.get("trade_spend") or 0) > 0]
    if not usable:
        return _unavailable(lever, f"No {noun} in this scope carries trade spend.")
    total = sum(r["trade_spend"] for r in usable)
    top = max(usable, key=lambda r: r["trade_spend"])
    share = round(top["trade_spend"] / total * 100, 1)
    return {
        "lever": lever,
        "available": True,
        "value": share,
        "display": f"{top.get('name')} at {share}% of trade spend",
        "basis": (
            f"Largest {noun} by Trade Spend across {len(usable)} in scope: "
            f"₹{top['trade_spend'] / 1e7:,.1f} Cr of ₹{total / 1e7:,.1f} Cr."
        ),
    }


def lever_positions(facts: dict[str, Any]) -> dict[str, dict[str, Any]]:
    """The MEASURED current value of each simulation lever, for this scope.

    Every entry is arithmetic over figures already in `facts`; nothing here
    calls the engine again and nothing is estimated. A lever whose inputs the
    requested sections did not compute reports `available: false` and says so,
    rather than falling back to a plausible number.
    """
    out: dict[str, dict[str, Any]] = {}
    by_mechanic = facts.get("by_mechanic")

    # DISCOUNT DEPTH: spend-weighted mean of the depth each mechanic's name
    # carries. Mechanics whose name states no depth are excluded from both
    # sides of the ratio rather than counted as zero — see `mechanic_depth`.
    if by_mechanic is None:
        out["discount_depth"] = _unavailable(
            "discount_depth", "The mechanic breakdown was not computed for this scope."
        )
    else:
        weighted = [
            (mechanic_depth(str(r.get("name") or "")), r.get("trade_spend") or 0.0)
            for r in by_mechanic
        ]
        priced = [(d, s) for d, s in weighted if d is not None and s > 0]
        spend = sum(s for _, s in priced)
        if not priced or spend <= 0:
            out["discount_depth"] = _unavailable(
                "discount_depth", "No mechanic in this scope states a discount depth."
            )
        else:
            depth = round(sum(d * s for d, s in priced) / spend, 1)
            out["discount_depth"] = {
                "lever": "discount_depth",
                "available": True,
                "value": depth,
                "display": f"{depth}% average depth",
                "basis": (
                    f"Trade-spend-weighted mean of the depth {len(priced)} mechanics carry "
                    f"in their names, over ₹{spend / 1e7:,.1f} Cr."
                ),
            }

    out["mechanic_mix"] = (
        _top_share(by_mechanic, "mechanic_mix", "mechanic")
        if by_mechanic is not None
        else _unavailable("mechanic_mix", "The mechanic breakdown was not computed for this scope.")
    )
    out["channel_mix"] = (
        _top_share(facts.get("by_channel"), "channel_mix", "channel")
        if facts.get("by_channel") is not None
        else _unavailable("channel_mix", "The channel breakdown was not computed for this scope.")
    )
    out["product_mix"] = (
        _top_share(facts.get("by_category"), "product_mix", "category")
        if facts.get("by_category") is not None
        else _unavailable("product_mix", "The category breakdown was not computed for this scope.")
    )

    # SPEND ALLOCATION: the pot itself. The KPI, not a re-sum of the groups —
    # Trade Spend is additive, but the KPI is the figure every other page shows.
    spend_total = (facts.get("kpis") or {}).get("trade_spend")
    out["spend_allocation"] = (
        {
            "lever": "spend_allocation",
            "available": True,
            "value": round(float(spend_total), 1),
            "display": f"₹{float(spend_total) / 1e7:,.1f} Cr of trade spend in scope",
            "basis": "Trade Spend KPI for this scope, from app/tpo/aggregate.py.",
        }
        if isinstance(spend_total, (int, float))
        else _unavailable("spend_allocation", "Trade Spend is not available for this scope.")
    )

    # PROMOTION CALENDAR: how much of the period actually carries spend. Read
    # off the same monthly series the trend chart draws.
    trend = facts.get("trend") or {}
    labels = trend.get("labels") or []
    spends = trend.get("trade_spend") or []
    active = [s for s in spends if s]
    if not labels or not spends:
        out["promotion_calendar"] = _unavailable(
            "promotion_calendar", "No monthly series was computed for this scope."
        )
    else:
        out["promotion_calendar"] = {
            "lever": "promotion_calendar",
            "available": True,
            "value": len(active),
            "display": f"{len(active)} of {len(labels)} months carry trade spend",
            "basis": (
                "Months with non-zero Trade Spend in the monthly trend for this scope, "
                f"covering {labels[0]} to {labels[-1]}."
            ),
        }
    return out


def risk_summary(filters: dict[str, Any] | None = None) -> dict[str, Any]:
    alerts = service.risk_alerts(build_filter_state(filters), limit=8)
    return {
        "counts": alerts.get("counts"),
        "at_stake_total": round(sum(a.get("at_stake") or 0 for a in (alerts.get("alerts") or [])), 1),
        "top": [
            {
                "title": a.get("title"),
                "severity": a.get("severity"),
                "roi_multiple": a.get("roi_multiple"),
                "trade_spend": a.get("trade_spend"),
                "at_stake": a.get("at_stake"),
            }
            for a in (alerts.get("alerts") or [])[:6]
        ],
    }


# ---------------------------------------------------------------------------
# Section cache.
#
# service.breakdown() re-runs the whole KPI engine once per group, so a single
# breakdown over 31 retailers is 31 passes. Computing every section eagerly
# took ~40s — unusable as a page load. Sections are therefore computed on
# demand and memoised per (section, scope): the first request for a tab pays
# for that tab only, and revisiting it is instant.
#
# The underlying data is immutable seed data (see data_loader), so nothing
# invalidates this. It would need clearing if uploads ever fed this engine.
# ---------------------------------------------------------------------------
_SECTION_CACHE: dict[tuple[str, str], Any] = {}

SECTIONS = ("core", "dimensions", "risk", "waterfall")


def _cached(section: str, filters: dict[str, Any], build) -> Any:
    key = (section, json.dumps(filters, sort_keys=True, default=str))
    if key not in _SECTION_CACHE:
        _SECTION_CACHE[key] = build()
    return _SECTION_CACHE[key]


def _core(filters: dict[str, Any]) -> dict[str, Any]:
    """What the Overview and Saturation tabs need — the cheap, high-value half."""
    by_mechanic = _dimension_table(filters, "promotion_mechanic")
    return {
        "kpis": segment_kpis(filters),
        "whole_business_kpis": segment_kpis({}),
        "saturation": saturation_curve(filters),
        "trend": inc_sales_trend(filters),
        "by_mechanic": by_mechanic,
        # Decomposed from the table above, so this costs no extra engine pass.
        "drivers": roi_gap_decomposition(by_mechanic, "promotion_mechanic"),
    }


def _dimensions(filters: dict[str, Any]) -> dict[str, Any]:
    tables = {
        "by_channel": _dimension_table(filters, "channel"),
        "by_region": _dimension_table(filters, "region"),
        "by_retailer": _dimension_table(filters, "retailer", limit=12),
        "by_category": _dimension_table(filters, "category"),
        "by_brand": _dimension_table(filters, "brand"),
        "by_product": _dimension_table(filters, "product", limit=12),
    }
    # The same decomposition through the other lenses, so the Analyst can see
    # whether the gap concentrates by mechanic, by place or by product before
    # it decides which drivers to lead with. Free — the tables are already built.
    return {
        **tables,
        "driver_lenses": {
            lens: roi_gap_decomposition(tables[key], lens)
            for key, lens in (
                ("by_channel", "channel"),
                ("by_region", "region"),
                ("by_category", "category"),
                ("by_brand", "brand"),
            )
        },
    }


def build_intelligence_facts(
    filters: dict[str, Any] | None = None, sections: tuple[str, ...] = SECTIONS
) -> dict[str, Any]:
    """The deterministic basis for the page and for the agent layer.

    `sections` selects how much to compute. The agents ask for everything; the
    page asks for one tab's worth at a time.
    """
    filters = filters or {}
    out: dict[str, Any] = {
        "scope": filters,
        # Stated explicitly because every figure below is INR, and a model not
        # told the currency will default to dollars.
        "currency": config.BASE_CURRENCY,
        "currency_symbol": "₹",
        "target_roi": config.PROMOTION_TARGET_ROI,
        "sections": list(sections),
        # The population every figure below was computed over. Carried because
        # the Analyst's evidence score reads it as its `support` term, and
        # because a reader is entitled to know how much data a scope holds
        # before weighing what it says. `rows_for` is the same resolver the
        # KPI calls go through, so this is exactly that population.
        "rows_in_scope": len(rows_for(build_filter_state(filters))),
    }
    if "core" in sections:
        out.update(_cached("core", filters, lambda: _core(filters)))
    if "dimensions" in sections:
        out.update(_cached("dimensions", filters, lambda: _dimensions(filters)))
    if "waterfall" in sections:
        out["waterfall"] = _cached("waterfall", filters, lambda: contribution_waterfall(filters))
    if "risk" in sections:
        out["risk"] = _cached("risk", filters, lambda: risk_summary(filters))
    # Measured, from whatever was computed above. Levers whose table this
    # `sections` selection skipped report themselves unavailable rather than
    # being filled in with something plausible.
    out["lever_positions"] = lever_positions(out)
    return out
