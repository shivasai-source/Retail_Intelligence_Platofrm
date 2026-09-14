"""
The specialist roster.

Previously the planner invented a specialist per question, and every one of
them did the same thing: one breakdown, one metric. Different names, identical
method — which is why findings overlapped and several agents just restated the
segment total.

This replaces that with a fixed roster of genuinely different analysts. Each
owns one link in the promotion-ROI causal chain, pulls its OWN data (different
service calls, not just a different `by`), and carries its own instructions.
The orchestrator's job becomes selection — deciding which lenses this question
actually needs — rather than invention.

The chain they decompose, since ROI = Incremental Sales / Trade Spend:

    Is it even abnormal?          -> benchmark
    Where did the money go?       -> spend_allocation
    Did the offer type convert?   -> mechanic_efficiency
    Which specific offers failed? -> offer_forensics
    Which products dragged?       -> portfolio
    Where did it break?           -> geography
    Was the "lift" even real?     -> cannibalization
    Did it decay over time?       -> temporal
    How much is still exposed?    -> risk_exposure

Each agent compares its segment against the wider business WHERE THAT MATTERS
for its own lens, rather than relying on the planner to remember to add a
comparison specialist.
"""
from dataclasses import dataclass
from typing import Any, Callable

from app.tpo import service
from app.tpo.filters import FilterState

from app.agents.star_tools import (
    build_filter_state,
    neighbour_sales_decline,
    run_analysis,
    segment_kpis,
)


def _kpi_compare(filters: dict[str, Any]) -> dict[str, Any]:
    """Segment KPIs beside the whole-business KPIs. Almost every lens needs
    this context: a 1.12 ROI means nothing until you know the norm is 1.39."""
    return {"segment": segment_kpis(filters), "whole_business": segment_kpis({})}


def _trim(rows: list[dict[str, Any]], keep: tuple[str, ...], limit: int) -> list[dict[str, Any]]:
    out = []
    for r in rows[:limit]:
        out.append({k: r[k] for k in keep if k in r})
    return out


# --- fetchers: each pulls the data its own lens needs -----------------------

def _fetch_benchmark(f: dict[str, Any]) -> dict[str, Any]:
    return {
        "question_this_answers": "Is this segment genuinely abnormal, or in line with the business?",
        "kpis": _kpi_compare(f),
        "roi_by_channel_whole_business": run_analysis({}, "channel", "roi").get("groups"),
        "roi_by_region_whole_business": run_analysis({}, "region", "roi").get("groups"),
    }


def _fetch_spend_allocation(f: dict[str, Any]) -> dict[str, Any]:
    mix = service.promotion_mix(build_filter_state(f))
    return {
        "question_this_answers": "Where did the trade spend actually go, and is it concentrated?",
        "kpis": _kpi_compare(f),
        "spend_by_mechanic": run_analysis(f, "promotion_mechanic", "trade_spend").get("groups"),
        "spend_mix_by_offer": _trim(mix.get("slices") or [], ("label", "type", "spend", "pct"), 10),
    }


def _fetch_mechanic_efficiency(f: dict[str, Any]) -> dict[str, Any]:
    return {
        "question_this_answers": "Which offer mechanics convert spend into sales, and which destroy it?",
        "kpis": _kpi_compare(f),
        "mechanic_roi_in_segment": run_analysis(f, "promotion_mechanic", "roi").get("groups"),
        "mechanic_roi_whole_business": run_analysis({}, "promotion_mechanic", "roi").get("groups"),
    }


def _fetch_offer_forensics(f: dict[str, Any]) -> dict[str, Any]:
    state = build_filter_state(f)
    under = service.underperforming_promotions(state)
    top = service.top_promotions(state, limit=8)
    keep = ("promotion", "product", "channel", "period", "roi_multiple", "vs_target", "trade_spend", "at_stake")
    return {
        "question_this_answers": "Which individual promotion events failed, and what did they cost?",
        "worst_events": _trim(under.get("rows") or [], keep + ("primary_cause", "action"), 10),
        "best_events": _trim(top.get("rows") or [], keep, 6),
    }


def _fetch_portfolio(f: dict[str, Any]) -> dict[str, Any]:
    return {
        "question_this_answers": "Which categories, brands or products are dragging the segment down?",
        "kpis": _kpi_compare(f),
        "roi_by_category": run_analysis(f, "category", "roi").get("groups"),
        "roi_by_brand": run_analysis(f, "brand", "roi").get("groups"),
        "spend_by_product": run_analysis(f, "product", "trade_spend").get("groups"),
    }


def _fetch_geography(f: dict[str, Any]) -> dict[str, Any]:
    return {
        "question_this_answers": "Where — which channel, region or retailer — does performance break?",
        "kpis": _kpi_compare(f),
        "roi_by_region": run_analysis(f, "region", "roi").get("groups"),
        "roi_by_state": run_analysis(f, "state", "roi").get("groups"),
        "roi_by_retailer": run_analysis(f, "retailer", "roi").get("groups"),
    }


def _fetch_cannibalization(f: dict[str, Any]) -> dict[str, Any]:
    """Neighbour sales during the promotion, plus the validated rate for context.

    THE PRIMARY EVIDENCE IS `neighbour_analysis`: what the promoted product's
    same-brand-form neighbours sold while it was on promotion, against their own
    ordinary level. See star_tools.neighbour_sales_decline for where every input
    comes from.

    `kpis.segment.cannibalization` is the Command Center's validated rate and is
    UNCHANGED. It answers a different question -- what share of the promoted
    SKU's uplift came out of its adjacent pack sizes, in quantity -- so it is
    carried alongside rather than replaced. The two can legitimately disagree,
    and the specialist is told which one answers which question.
    """
    return {
        "question_this_answers": (
            "Did neighbouring products in the same brand form lose sales while this "
            "promotion was running?"
        ),
        "neighbour_analysis": neighbour_sales_decline(f),
        "kpis": _kpi_compare(f),
        "note": (
            "TWO DIFFERENT MEASURES, DO NOT CONFLATE THEM. `neighbour_analysis` is the "
            "primary business explanation for this lens: the SALES change of "
            "same-brand-form neighbours during the promotion weeks, where a NEGATIVE "
            "neighbour_sales_change_pct means they sold LESS. "
            "`kpis.segment.cannibalization` is the separate validated Cannibalization "
            "Rate, measured in quantity against adjacent pack sizes only. Report the "
            "neighbour figure as the finding and use the rate as corroboration. Neither "
            "establishes causation."
        ),
        "units_by_brand": run_analysis(f, "brand", "incremental_units").get("groups"),
        "units_by_category": run_analysis(f, "category", "incremental_units").get("groups"),
    }


def _fetch_temporal(f: dict[str, Any]) -> dict[str, Any]:
    t = service.trend(build_filter_state(f), "month")
    return {
        "question_this_answers": "Did performance decay, spike or hold steady across the period?",
        "kpis": _kpi_compare(f),
        "granularity": t.get("granularity"),
        "labels": t.get("labels"),
        "series": t.get("series"),
    }


def _fetch_risk_exposure(f: dict[str, Any]) -> dict[str, Any]:
    alerts = service.risk_alerts(build_filter_state(f), limit=10)
    return {
        "question_this_answers": "How much money is still at stake, and how severe is the exposure?",
        "counts_by_severity": alerts.get("counts"),
        "top_alerts": _trim(
            alerts.get("alerts") or [],
            ("title", "description", "severity", "roi_multiple", "trade_spend", "at_stake"),
            8,
        ),
    }


@dataclass(frozen=True)
class Specialist:
    key: str
    name: str
    desc: str
    icon: str
    role: str          # shown to the orchestrator when it chooses
    focus: str         # appended to the specialist system prompt
    fetch: Callable[[dict[str, Any]], dict[str, Any]]


ROSTER: tuple[Specialist, ...] = (
    Specialist(
        key="benchmark",
        name="Benchmarking Agent",
        desc="Compares the segment against the whole business",
        icon="target",
        role="Establishes whether there is a problem at all, by comparing the segment to the business norm and to peer channels/regions.",
        focus=(
            "Your job is CALIBRATION. State plainly whether this segment is genuinely "
            "abnormal or merely average, and by how much. If it is close to the norm, say "
            "so — a confident 'nothing unusual here' is a valuable finding and stops the "
            "other analysts' results being over-read. Quantify the gap in percentage points."
        ),
        fetch=_fetch_benchmark,
    ),
    Specialist(
        key="spend_allocation",
        name="Spend Allocation Analyst",
        desc="Where the trade spend went and how concentrated it is",
        icon="pieChart",
        role="Follows the money: which mechanics and offers absorbed the budget, and whether spend is dangerously concentrated.",
        focus=(
            "Your job is FOLLOWING THE MONEY. Identify concentration: if one mechanic or "
            "offer absorbs a large share of spend, that is where the ROI is decided, "
            "regardless of how any small offer performed. Always report the share of spend "
            "alongside the ROI — a poor ROI on 2% of budget is trivia; a poor ROI on 50% "
            "of budget is the story."
        ),
        fetch=_fetch_spend_allocation,
    ),
    Specialist(
        key="mechanic_efficiency",
        name="Effectiveness Agent",
        desc="Which offer mechanics convert spend into sales",
        icon="tag",
        role="Tests whether the offer TYPE (discount depth, BOGO, bundle) is the inefficiency.",
        focus=(
            "Your job is MECHANIC EFFECTIVENESS. Compare each mechanic's ROI inside the "
            "segment against the same mechanic across the whole business. That difference "
            "is the key signal: a mechanic that works elsewhere but fails here is an "
            "execution or fit problem, whereas one that fails everywhere is a design "
            "problem. Name which of the two you are seeing."
        ),
        fetch=_fetch_mechanic_efficiency,
    ),
    Specialist(
        key="offer_forensics",
        name="Diagnostics Agent",
        desc="The specific promotion events that failed",
        icon="zoomIn",
        role="Drills to individual promotion events — the actual offers, products and weeks that lost money.",
        focus=(
            "Your job is SPECIFICS. Everyone else works in aggregates; you name the actual "
            "offer, product and week that lost money, and the value at stake. Prefer the "
            "events with the largest trade spend or at_stake — a 0.20 ROI on a few hundred "
            "rupees is noise next to a 0.96 ROI on lakhs."
        ),
        fetch=_fetch_offer_forensics,
    ),
    Specialist(
        key="portfolio",
        name="Portfolio Analyst",
        desc="Which categories, brands and products drag performance",
        icon="package",
        role="Finds whether the problem is concentrated in particular products rather than the promotion design.",
        focus=(
            "Your job is PRODUCT MIX. Determine whether underperformance is broad-based or "
            "concentrated in specific categories/brands. Broad-based points at the promotion "
            "design; concentrated points at product fit, pricing or availability. State which."
        ),
        fetch=_fetch_portfolio,
    ),
    Specialist(
        key="geography",
        name="Optimization Agent",
        desc="Which channels, regions and retailers break",
        icon="retailer",
        role="Localises the problem geographically and by trade partner.",
        focus=(
            "Your job is LOCALISATION. Narrow the problem to the smallest place that "
            "explains it — a region, a state, a specific retailer. If performance is even "
            "across every location, say so: that rules out execution and points back at the "
            "offer design, which is itself a useful elimination."
        ),
        fetch=_fetch_geography,
    ),
    Specialist(
        key="cannibalization",
        name="Cannibalization Agent",
        desc="Whether same-brand-form neighbours lost sales during the promotion",
        icon="cannib",
        role="Checks whether products sharing the promoted product's brand form sold less while it ran.",
        focus=(
            "Your job is THE NEIGHBOURS. Lead with `neighbour_analysis`: the promotion, "
            "the brand form, the promotion weeks, how many same-brand-form neighbours "
            "there were, their baseline and promotion-period VOLUME, and "
            "neighbour_units_change_pct. THAT is the headline figure and the one your "
            "viz_items should chart -- units are what a reader can hold, where the "
            "money equivalent is every store in the channel added together. Cite "
            "expected/actual_neighbour_sales alongside it as corroboration, and say so "
            "if volume and money disagree. NEGATIVE means they sold LESS -- report a "
            "decline of that size and call it POTENTIAL cannibalization. POSITIVE means "
            "neighbour volume ROSE -- report the increase and say no decline was detected; "
            "never call neighbour growth negative cannibalization. If available is false, "
            "or a brand form reports computable false, say plainly what could not be "
            "measured and why, and never substitute a number. Corroborate with the "
            "validated cannibalization rate in kpis, naming it as the separate "
            "quantity-based measure it is. NEVER claim the promotion CAUSED the change "
            "-- this is co-movement, not attribution."
        ),
        fetch=_fetch_cannibalization,
    ),
    Specialist(
        key="temporal",
        name="Temporal Analyst",
        desc="Decay, spikes and timing across the period",
        icon="history",
        role="Tests whether performance degraded over time or was driven by a few periods.",
        focus=(
            "Your job is TIME. Look for decay (early strength fading), spikes (one period "
            "carrying the whole result) and volatility. A single extreme month can drag or "
            "flatter an average — if one period dominates, name it, because the aggregate "
            "then describes that period rather than the promotion."
        ),
        fetch=_fetch_temporal,
    ),
    Specialist(
        key="risk_exposure",
        name="Risk Agent",
        desc="Money still at stake and severity of exposure",
        icon="shield",
        role="Quantifies remaining downside — how many events are below target and what they put at risk.",
        focus=(
            "Your job is EXPOSURE, not diagnosis. Quantify how much is still at risk and "
            "how concentrated the severe cases are. This is what makes the investigation "
            "actionable: the reader needs to know the size of the problem in money, not "
            "only its cause."
        ),
        fetch=_fetch_risk_exposure,
    ),
)

BY_KEY: dict[str, Specialist] = {s.key: s for s in ROSTER}
KEYS: tuple[str, ...] = tuple(s.key for s in ROSTER)


def roster_catalogue() -> str:
    """The menu the orchestrator chooses from."""
    return "\n".join(f"  - {s.key}: {s.name} — {s.role}" for s in ROSTER)
