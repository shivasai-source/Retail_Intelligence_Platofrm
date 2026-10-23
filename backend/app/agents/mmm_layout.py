"""What the MMM Insights Hub can show, and what its Analyst may say about it.

THE MMM TWIN OF app/agents/hub_layout.py. Same contract, different furniture:
six panels instead of nine, nine KPIs instead of nine different ones, and a
trend whose granularity is part of the page rather than part of the scope.

THIS FILE IS A MIRROR. The page owns the panels; this is what they are called.
`tests/test_mmm_analyst.py` reads frontend/src/mmm/mmmPanels.ts and fails if
the two drift — which is the only thing that makes a mirror safe.

THE SERVER NEVER CHANGES ANYTHING. Every function returns a described ACTION
and nothing else. The browser applies it, records what it was before, and
offers Undo. A tool that cannot name a panel returns an error the model reads,
rather than the reader being told about a change that did not happen.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any


@dataclass(frozen=True)
class Panel:
    """One chart the MMM Insights Hub can show."""

    id: str
    #: What the page calls it, verbatim — so the Analyst's sentence and the
    #: card's header agree.
    label: str
    #: What it shows, for the model to choose by.
    about: str
    #: Words a reader might use for it that are not in the label.
    also: tuple[str, ...] = ()


PANELS: tuple[Panel, ...] = (
    Panel("trend", "Ad Spend & ROAS Trend",
          "Ad spend and ROAS over time, weekly or monthly, against break-even at 1.00x.",
          ("over time", "timeline", "line chart", "spend trend", "roas trend")),
    Panel("decomposition", "Revenue Decomposition",
          "What the revenue is made of: the baseline, and the incremental revenue each "
          "channel is credited with.",
          ("what drives revenue", "contribution", "baseline vs incremental", "waterfall")),
    Panel("channel", "Channel Performance",
          "Spend, attributed revenue, ROAS and active days for each media channel, and "
          "for the channel families above them.",
          ("channels", "by channel", "media performance", "families")),
    Panel("promotions", "Promotion Performance",
          "Revenue, spend and ROAS for each promotion type, by the days it ran.",
          ("promotion types", "by promotion", "discounts", "bogo")),
    Panel("comparison", "Period Comparison",
          "This period against a year ago, the period before it, and a month ago.",
          ("year on year", "yoy", "yago", "pago", "mago", "versus last year")),
    Panel("events", "Event Impact",
          "Average daily revenue on days with ad spend, a festival, a seasonal flag or a "
          "promotion, against days without.",
          ("festivals", "seasonality", "event lift", "with vs without")),
)

PANEL_IDS: tuple[str, ...] = tuple(p.id for p in PANELS)
BY_ID: dict[str, Panel] = {p.id: p for p in PANELS}

#: The six KPI cards a reader can add beside the headline three. Mirrors
#: MMM_ADDABLE_KPIS in frontend/src/mmm/kpiDeck.ts, in the page's own order.
CARDS: tuple[tuple[str, str], ...] = (
    ("baseline", "Baseline Revenue"),
    ("incremental", "Incremental Revenue"),
    ("baseline_per_day", "Avg Daily Baseline"),
    ("avg_daily_revenue", "Avg Daily Revenue"),
    ("ad_lift", "Ad Revenue Lift / Day"),
    ("media_days", "Days With Ad Spend"),
)
CARD_IDS: tuple[str, ...] = tuple(key for key, _label in CARDS)
CARD_LABELS: dict[str, str] = dict(CARDS)

#: The headline three, always on screen — what the page IS. Mirrors
#: MMM_HERO_KPIS. Named so the model can say so rather than fail silently.
FIXED_CARDS: tuple[tuple[str, str], ...] = (
    ("revenue", "Total Revenue"),
    ("spend", "Total Ad Spend"),
    ("roas", "ROAS"),
)
FIXED_CARD_IDS: tuple[str, ...] = tuple(key for key, _label in FIXED_CARDS)


def panel_catalogue() -> str:
    """The panels, for the system prompt. One line each, id first."""
    return "\n".join(
        f"  {p.id} — {p.label}: {p.about}"
        + (f" Also called: {', '.join(p.also)}." if p.also else "")
        for p in PANELS
    )


def card_catalogue() -> str:
    always = ", ".join(label for _k, label in FIXED_CARDS)
    addable = "\n".join(f"  {key} — {label}" for key, label in CARDS)
    return f"Always on screen (cannot be removed): {always}\nCan be added or removed:\n{addable}"


def describe_panels(ids: list[str]) -> str:
    return ", ".join(BY_ID[i].label for i in ids if i in BY_ID)


def describe_cards(ids: list[str]) -> str:
    return ", ".join(CARD_LABELS.get(i, i) for i in ids)


def unknown(ids: list[str], known: tuple[str, ...]) -> list[str]:
    return [i for i in ids if i not in known]


def layout_action(
    show_charts: list[str] | None = None,
    hide_charts: list[str] | None = None,
    show_cards: list[str] | None = None,
    hide_cards: list[str] | None = None,
    reset: bool = False,
    clear_pinned: bool = False,
    on_page: dict[str, Any] | None = None,
) -> dict[str, Any]:
    """One described change to what the MMM hub shows.

    Raises ValueError naming anything that does not exist, so the model is
    told rather than the reader being told a change happened that did not.

    `on_page` is what the browser says the page is showing. Given it, a show of
    something already shown — or a hide of something already hidden — is
    dropped, and a call with nothing left to do is refused. See
    `_only_what_moves` for the failure that caused.
    """
    show_charts = list(show_charts or [])
    hide_charts = list(hide_charts or [])
    show_cards = list(show_cards or [])
    hide_cards = list(hide_cards or [])

    bad_charts = unknown(show_charts + hide_charts, PANEL_IDS)
    if bad_charts:
        raise ValueError(
            f"No chart called {', '.join(bad_charts)}. The charts are: "
            f"{', '.join(PANEL_IDS)}."
        )
    bad_cards = unknown(show_cards + hide_cards, CARD_IDS)
    if bad_cards:
        fixed = [c for c in bad_cards if c in dict(FIXED_CARDS)]
        if fixed:
            raise ValueError(
                f"{', '.join(dict(FIXED_CARDS)[c] for c in fixed)} is one of the three "
                "headline cards and is always on screen; it cannot be added or removed."
            )
        raise ValueError(
            f"No card called {', '.join(bad_cards)}. The cards are: {', '.join(CARD_IDS)}."
        )
    if not (show_charts or hide_charts or show_cards or hide_cards or reset or clear_pinned):
        raise ValueError("Say what to show, what to hide, or ask for a reset.")

    both = (set(show_charts) & set(hide_charts)) | (set(show_cards) & set(hide_cards))
    if both:
        raise ValueError(f"Asked to both show and hide {', '.join(sorted(both))}.")

    if reset:
        # A RESET IS THE WHOLE CHANGE. Asked to put everything back, the model
        # called reset AND listed all six charts in `show_charts`, and the
        # receipt described one change twice — the second time as six. Reset
        # already restores the defaults; anything named beside it is the model
        # spelling out what reset means.
        show_charts, hide_charts, show_cards, hide_cards = [], [], [], []

    if on_page is not None and not reset:
        show_charts, hide_charts, show_cards, hide_cards = _only_what_moves(
            on_page, show_charts, hide_charts, show_cards, hide_cards)
        if not (show_charts or hide_charts or show_cards or hide_cards or clear_pinned):
            raise ValueError(
                "Nothing to do: the page is already showing exactly that. Do not report a "
                "change you have not made."
            )

    parts: list[str] = []
    if reset:
        parts.append("put the MMM Insights Hub back to its default charts and cards")
    if clear_pinned:
        parts.append("removed the charts added to the hub from this chat")
    if show_charts:
        parts.append(f"added {describe_panels(show_charts)}")
    if hide_charts:
        parts.append(f"removed {describe_panels(hide_charts)}")
    if show_cards:
        parts.append(f"added the {describe_cards(show_cards)} card")
    if hide_cards:
        parts.append(f"removed the {describe_cards(hide_cards)} card")

    return {
        "kind": "layout",
        "reset": reset,
        "clear_pinned": clear_pinned,
        "show_charts": show_charts,
        "hide_charts": hide_charts,
        "show_cards": show_cards,
        "hide_cards": hide_cards,
        "summary": _sentence(parts),
    }


#: What a card's heading calls each metric and dimension. `.title()` alone
#: produced "Roas by Channel", which is the product's own metric spelled wrong
#: on its own hub.
METRIC_LABELS: dict[str, str] = {
    "spend": "Ad Spend",
    "revenue": "Revenue on Active Days",
    "revenue_attributed": "Attributed Revenue",
    "roas": "ROAS",
    "share": "Share of Ad Spend",
    "active_days": "Active Days",
    "avg_active_day": "Avg Spend per Active Day",
    "days": "Days",
    "avg_revenue": "Avg Daily Revenue",
    "with_avg": "Avg Revenue With",
    "without_avg": "Avg Revenue Without",
    "difference": "Lift",
}
DIMENSION_LABELS: dict[str, str] = {
    "channel": "Channel",
    "family": "Channel Family",
    "promotion": "Promotion Type",
    "event": "Event",
}

#: The chart shapes the hub will draw for a pinned chart. Fewer than the
#: chat's: a hub panel is read at a glance beside six others, and a scatter or
#: a histogram there is a puzzle rather than a chart.
PINNABLE_TYPES: tuple[str, ...] = ("bar", "column", "donut", "line")


def pin_action(chart_type: str, by: str, metric: str, dimensions: tuple[str, ...],
               metrics: tuple[str, ...], title: str = "") -> dict[str, Any]:
    """A chart to keep ON THE MMM HUB, described rather than drawn.

    WHAT IS PINNED IS THE SHAPE, NOT THE NUMBERS. The browser redraws it from
    the hub's own scope, so a pinned chart moves with the period exactly as the
    six built-in panels do. Pinning a computed picture instead would leave a
    chart that quietly disagreed with every card around it the moment the
    reader changed the period — and on this page it would also disagree with a
    baseline that is re-estimated for every range.
    """
    kind = (chart_type or "bar").strip().lower()
    if kind not in PINNABLE_TYPES:
        raise ValueError(
            f"A hub chart can be {', '.join(PINNABLE_TYPES)} — not {chart_type}."
        )
    if by not in dimensions:
        raise ValueError(f"Cannot group by {by}. Available: {', '.join(dimensions)}.")
    if metric not in metrics:
        raise ValueError(f"Cannot measure {metric}. Available: {', '.join(metrics)}.")

    what = METRIC_LABELS.get(metric, metric.replace("_", " ").title())
    where = DIMENSION_LABELS.get(by, by.replace("_", " ").title())
    label = (title or f"{what} by {where}").strip()
    return {
        "kind": "pin_chart",
        "chart_type": kind,
        "by": by,
        "metric": metric,
        "title": label,
        "summary": f"added a {kind} chart of {what} by {where} to the hub",
    }


def update_action(chart_id: str, on_dashboard: list[dict[str, Any]],
                  chart_type: str = "", by: str = "", metric: str = "", title: str = "",
                  dimensions: tuple[str, ...] = (), metrics: tuple[str, ...] = ()) -> dict[str, Any]:
    """Change a chart that is ALREADY on the hub.

    Named by the id the browser sent with the question, so this cannot act on a
    chart that is not there. Only the parts named are changed; everything else
    stays, which is what "make it a column chart" means.
    """
    known = {str(c.get("id")): c for c in on_dashboard if c.get("id")}
    if not known:
        raise ValueError(
            "There are no charts from this chat on the hub to change. "
            "Add one with pin_chart, or use set_layout for the hub's own charts."
        )
    if chart_id not in known:
        names = ", ".join(f"{c.get('title')} ({i})" for i, c in known.items())
        raise ValueError(f"No chart with id {chart_id} on the hub. There is: {names}.")

    current = known[chart_id]
    patch: dict[str, Any] = {}
    if chart_type:
        kind = chart_type.strip().lower()
        if kind not in PINNABLE_TYPES:
            raise ValueError(
                f"A hub chart can be {', '.join(PINNABLE_TYPES)} — not {chart_type}."
            )
        patch["chart_type"] = kind
    if by:
        if dimensions and by not in dimensions:
            raise ValueError(f"Cannot group by {by}. Available: {', '.join(dimensions)}.")
        patch["by"] = by
    if metric:
        if metrics and metric not in metrics:
            raise ValueError(f"Cannot measure {metric}. Available: {', '.join(metrics)}.")
        patch["metric"] = metric
    if title:
        patch["title"] = title.strip()
    if not patch:
        raise ValueError("Say what to change about it: its type, what it measures, or its grouping.")

    # Re-title when the SHAPE changed and the reader did not name one, so the
    # heading cannot go on describing the chart it used to be.
    if ("by" in patch or "metric" in patch) and "title" not in patch:
        what = METRIC_LABELS.get(patch.get("metric", current.get("metric", "")), "")
        where = DIMENSION_LABELS.get(patch.get("by", current.get("by", "")), "")
        if what and where:
            patch["title"] = f"{what} by {where}"

    described = []
    if "chart_type" in patch:
        described.append(f"a {patch['chart_type']} chart")
    if "metric" in patch:
        described.append(f"measuring {METRIC_LABELS.get(patch['metric'], patch['metric'])}")
    if "by" in patch:
        described.append(f"grouped by {DIMENSION_LABELS.get(patch['by'], patch['by'])}")
    if "title" in patch and not described:
        described.append(f'titled "{patch["title"]}"')

    return {
        "kind": "update_chart",
        "id": chart_id,
        "patch": patch,
        "summary": f"made {current.get('title', 'that chart')} {' '.join(described)}",
    }


def dashboard_note(state: dict[str, Any] | None) -> str:
    """What is on the MMM Insights Hub right now, for the system prompt.

    The model cannot see the page. Without this it cannot change a chart it put
    there (it has no id to name), cannot avoid adding a second copy of
    something already on screen, and cannot answer "what's on my hub".
    """
    state = state or {}
    pinned = [c for c in (state.get("pinned") or []) if isinstance(c, dict)]
    hidden = [c for c in (state.get("hidden_charts") or []) if c in BY_ID]
    cards = [c for c in (state.get("cards") or []) if c in CARD_LABELS]
    granularity = str(state.get("granularity") or "")

    lines = ["WHAT IS ON THE MMM INSIGHTS HUB RIGHT NOW"]
    if hidden:
        lines.append(f"  Hidden charts (show with set_layout): {describe_panels(hidden)}")
    else:
        lines.append("  All six of the hub's own charts are on screen.")
    lines.append(
        f"  Added KPI cards: {describe_cards(cards)}" if cards
        else "  Added KPI cards: none beyond the headline three."
    )
    if granularity in ("week", "month"):
        lines.append(
            f"  The Ad Spend & ROAS Trend is drawn "
            f"{'weekly' if granularity == 'week' else 'monthly'} (change with set_granularity)."
        )
    if pinned:
        lines.append("  Charts YOU added, with the id to change or remove them.")
        lines.append(
            "  These are NOT the hub's own charts above, even when the names are alike "
            "— \"Channel Performance\" is the hub's, \"ROAS by Channel\" may be yours. "
            "Changing one of the hub's own is set_layout; changing one of these is "
            "update_chart."
        )
        for c in pinned:
            lines.append(
                f"    id={c.get('id')} — \"{c.get('title')}\": a {c.get('chart_type')} chart of "
                f"{c.get('metric')} by {c.get('by')}"
            )
        lines.append(
            "  To change one of those, call update_chart with its id. Do NOT remove and "
            "re-add it."
        )
    else:
        lines.append("  Charts you added: none.")
    return "\n".join(lines)


def _only_what_moves(
    on_page: dict[str, Any],
    show_charts: list[str],
    hide_charts: list[str],
    show_cards: list[str],
    hide_cards: list[str],
) -> tuple[list[str], list[str], list[str], list[str]]:
    """The requested changes, minus the ones already true.

    WHY THIS IS NOT PEDANTRY. Asked "just show TV and OTT" the model set the
    filter and ALSO asked for all six charts to be shown — every one of which
    was already on screen. The page did not move and the receipt claimed six
    changes, each with an Undo beside it. A receipt that lists something that
    did not happen is worse than no receipt: it is the one part of this feature
    the reader has to be able to trust.
    """
    hidden = {c for c in (on_page.get("hidden_charts") or []) if c in BY_ID}
    added = {c for c in (on_page.get("cards") or []) if c in CARD_LABELS}
    return (
        [c for c in show_charts if c in hidden],
        [c for c in hide_charts if c not in hidden],
        [c for c in show_cards if c not in added],
        [c for c in hide_cards if c in added],
    )


def _sentence(parts: list[str]) -> str:
    if not parts:
        return "changed the MMM Insights Hub"
    if len(parts) == 1:
        return parts[0]
    return ", ".join(parts[:-1]) + " and " + parts[-1]
