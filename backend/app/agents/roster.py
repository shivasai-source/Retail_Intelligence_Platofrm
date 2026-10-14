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

FIVE AGENTS, ONE LENS EACH (2026-10-13). There were nine; a review of every
stored run found three that never ran (spend_allocation, portfolio, temporal)
and two that read the same promotion events and quoted the same figures in
35 of 44 runs (offer_forensics, risk_exposure). Their work was folded into
the agent whose lens it belongs to, so nothing a reader relied on was lost:

    Is it abnormal, now and over time?          -> benchmark            (+ temporal's monthly trend)
    Which mechanic, and where did spend go?      -> mechanic_efficiency  (+ spend_allocation's spend mix)
    Which events lost money, and how much?       -> offer_forensics      (+ risk_exposure's loss bands)
    Where -- place, partner, category, brand?    -> geography            (+ portfolio's category / brand)
    Was the lift real, or taken from neighbours? -> cannibalization

Older stored runs still name the retired keys; they render from the name,
description and icon copied into each run.

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
    t = service.trend(build_filter_state(f), "month")
    return {
        "question_this_answers": (
            "Is this segment genuinely abnormal against the business -- and did it hold, "
            "fade or spike across the period?"
        ),
        "kpis": _kpi_compare(f),
        "roi_by_channel_whole_business": run_analysis({}, "channel", "roi").get("groups"),
        "roi_by_region_whole_business": run_analysis({}, "region", "roi").get("groups"),
        # Folded in from the retired Temporal Analyst: the segment month by month.
        "monthly_trend": {"labels": t.get("labels"), "series": t.get("series")},
    }


def _fetch_mechanic_efficiency(f: dict[str, Any]) -> dict[str, Any]:
    mix = service.promotion_mix(build_filter_state(f))
    return {
        "question_this_answers": (
            "Which offer mechanics convert spend into sales, which destroy it, and where "
            "did the spend actually go?"
        ),
        "kpis": _kpi_compare(f),
        # Each group carries trade_spend, roi and share_pct -- spend and return
        # in one table, which is why the Spend Allocation Analyst was retired.
        "mechanic_roi_in_segment": run_analysis(f, "promotion_mechanic", "roi").get("groups"),
        "mechanic_roi_whole_business": run_analysis({}, "promotion_mechanic", "roi").get("groups"),
        "spend_mix_by_offer": _trim(mix.get("slices") or [], ("label", "type", "spend", "pct"), 10),
    }


def _fetch_offer_forensics(f: dict[str, Any]) -> dict[str, Any]:
    state = build_filter_state(f)
    alerts = service.risk_alerts(state, limit=10)
    under = service.underperforming_promotions(state)
    top = service.top_promotions(state, limit=8)
    keep = ("promotion", "product", "channel", "period", "roi_multiple", "vs_target", "trade_spend", "at_stake")
    return {
        "question_this_answers": (
            "Which individual promotion events missed the ROI target, how much is at "
            "stake in total, and which were the worst?"
        ),
        # Folded in from the retired Risk Agent: the events below the ROI
        # target, banded Critical / High / Medium, with the money at stake.
        "events_by_severity": alerts.get("counts"),
        "worst_by_stake": _trim(
            alerts.get("alerts") or [],
            ("title", "description", "severity", "roi_multiple", "trade_spend",
             "at_stake", "net_incremental_profit", "sales_less_spend"),
            8,
        ),
        "weakest_events": _trim(under.get("rows") or [], keep + ("primary_cause", "action"), 10),
        "best_events": _trim(top.get("rows") or [], keep, 6),
    }


def _fetch_geography(f: dict[str, Any]) -> dict[str, Any]:
    return {
        "question_this_answers": (
            "Where does performance break -- which region, state or retailer -- and is it "
            "concentrated in particular categories or brands?"
        ),
        "kpis": _kpi_compare(f),
        "roi_by_region": run_analysis(f, "region", "roi").get("groups"),
        "roi_by_state": run_analysis(f, "state", "roi").get("groups"),
        "roi_by_retailer": run_analysis(f, "retailer", "roi").get("groups"),
        # Folded in from the retired Portfolio Analyst.
        "roi_by_category": run_analysis(f, "category", "roi").get("groups"),
        "roi_by_brand": run_analysis(f, "brand", "roi").get("groups"),
    }


def _fetch_cannibalization(f: dict[str, Any]) -> dict[str, Any]:
    """Neighbour sales during the promotion, plus the validated rate for context.

    THE PRIMARY EVIDENCE IS `neighbour_analysis`: what the promoted product's
    same-brand-form neighbours sold while it was on promotion, against their own
    ordinary level. See star_tools.neighbour_sales_decline for where every input
    comes from.

    `kpis.segment.cannibalization` is the Insights Hub's validated rate and is
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
        desc="Compares the segment against the whole business, and over time",
        icon="target",
        role=(
            "Establishes whether there is a problem at all -- the segment against the business "
            "norm and peer channels/regions -- and whether it held, faded or spiked over the period."
        ),
        focus=(
            "Your job is CALIBRATION. State plainly whether this segment is genuinely "
            "abnormal or merely average, and by how much. If it is close to the norm, say "
            "so -- a confident 'nothing unusual here' is a valuable finding and stops the "
            "other analysts' results being over-read. Quantify the gap in percentage points. "
            "Then read `monthly_trend`: if one month carried or dragged the result, or the "
            "segment faded across the period, name it, because the average then describes "
            "that month rather than the promotion."
        ),
        fetch=_fetch_benchmark,
    ),
    Specialist(
        key="mechanic_efficiency",
        name="Effectiveness Agent",
        desc="Which offer mechanics convert spend into sales, and where the spend went",
        icon="tag",
        role=(
            "Tests whether the offer TYPE (discount depth, BOGO, bundle) is the inefficiency, "
            "and where the trade spend was concentrated."
        ),
        focus=(
            "Your job is MECHANIC EFFECTIVENESS. Compare each mechanic's ROI inside the "
            "segment against the same mechanic across the whole business. That difference "
            "is the key signal: a mechanic that works elsewhere but fails here is an "
            "execution or fit problem, whereas one that fails everywhere is a design "
            "problem. Name which of the two you are seeing. Always report each mechanic's "
            "share of spend beside its ROI -- a poor ROI on 2% of budget is trivia; a poor "
            "ROI on 50% of budget is the story."
        ),
        fetch=_fetch_mechanic_efficiency,
    ),
    Specialist(
        key="offer_forensics",
        name="Diagnostics Agent",
        desc="The specific promotion events that missed target, and the money at stake",
        icon="zoomIn",
        role=(
            "Drills to individual promotion events -- the actual offers, products and weeks "
            "that missed the ROI target -- and sizes the exposure and how severe it is."
        ),
        focus=(
            "Your job is SPECIFICS AND EXPOSURE. Everyone else works in aggregates; you name "
            "the actual offer, product and week. Lead with `worst_by_stake`: the events "
            "below the ROI target, banded Critical / High / Medium, with the money at "
            "stake. Give how many there are, the total at stake and the worst one. If "
            "every event reached target, say so plainly and name the weakest from "
            "`weakest_events` instead. Prefer the biggest money -- a 0.20 ROI on a few "
            "hundred rupees is noise next to a 1.40 ROI on lakhs."
        ),
        fetch=_fetch_offer_forensics,
    ),
    Specialist(
        key="geography",
        name="Optimization Agent",
        desc="Which regions, retailers, categories and brands break",
        icon="retailer",
        role="Localises the problem by place, trade partner, category and brand.",
        focus=(
            "Your job is LOCALISATION. Narrow the problem to the smallest place that "
            "explains it -- a region, a state, a specific retailer -- and say whether it is "
            "concentrated in particular categories or brands. If performance is even "
            "everywhere, say so: that rules out execution and product fit and points back "
            "at the offer design, which is itself a useful elimination."
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
)

BY_KEY: dict[str, Specialist] = {s.key: s for s in ROSTER}
KEYS: tuple[str, ...] = tuple(s.key for s in ROSTER)


def roster_catalogue() -> str:
    """The menu the orchestrator chooses from."""
    return "\n".join(f"  - {s.key}: {s.name} — {s.role}" for s in ROSTER)
