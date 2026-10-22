"""What the Insights Hub can show, and what the Analyst may say about it.

WHY THE SERVER KNOWS THE PAGE'S FURNITURE. The Analyst can now change the
Insights Hub — the period, the filters, which cards and charts are on screen —
so the model has to be able to NAME those things. A tool whose argument is a
free string would let it invent `sales_by_country`, and the page would answer a
confident sentence with no change at all. So the ids live here, go into the
tool schemas as enums, and the model can only ask for something that exists.

THIS FILE IS A MIRROR. The page owns the panels; this is the list of what they
are called, kept in step with `frontend/src/components/command/hubPanels.ts`.
`test_analyst_actions.py` reads that file and fails if the two drift, which is
the only thing that makes a mirror safe.

THE SERVER NEVER CHANGES ANYTHING. Every tool here returns a described ACTION
and nothing else — no page state lives on the server, and the Analyst has no
session to mutate. The browser applies it, records what it was before, and
offers Undo. That is also why a refusal is impossible to get wrong: a tool that
cannot name a panel returns an error the model reads, rather than a silent no-op.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any


@dataclass(frozen=True)
class Panel:
    """One chart or table the Insights Hub can show."""

    id: str
    #: What the page calls it, verbatim — so the Analyst's sentence and the
    #: card's header agree.
    label: str
    #: What it shows, for the model to choose by.
    about: str
    #: Words a reader might use for it that are not in the label.
    also: tuple[str, ...] = ()
    #: On the page by default.
    default_on: bool = True


PANELS: tuple[Panel, ...] = (
    Panel("trend", "Promotion Performance Trend",
          "Incremental sales, trade spend and ROI over time, weekly or monthly.",
          ("over time", "timeline", "line chart", "performance over time")),
    Panel("region", "Sales by Region",
          "Incremental sales and ROI for each region.", ("geography", "regions", "map")),
    Panel("comparison", "Performance Comparison",
          "This period against the one before it, and against last year.",
          ("year on year", "yoy", "versus last year", "period comparison")),
    Panel("mix", "Promotion Mix by Scheme",
          "How trade spend and incremental sales split across promotion schemes.",
          ("scheme mix", "spend split", "donut", "share of spend")),
    Panel("channel", "Channel Performance",
          "Incremental sales, spend and ROI by sales channel.",
          ("channels", "modern trade", "by channel")),
    Panel("top", "Top Performing Promotions",
          "The promotion events with the best return in this selection.",
          ("best promotions", "winners", "leaderboard")),
    Panel("contribution", "Promotion Contribution",
          "What each promotion scheme contributed to incremental sales.",
          ("by scheme", "scheme contribution")),
    Panel("product", "Product Performance",
          "Incremental sales and ROI by product or brand.",
          ("products", "skus", "brands", "by product")),
    Panel("promotion_type", "Regular vs Seasonal Performance",
          "Regular promotions against seasonal ones.",
          ("regular vs seasonal", "seasonality", "promotion type")),
)

PANEL_IDS: tuple[str, ...] = tuple(p.id for p in PANELS)
BY_ID: dict[str, Panel] = {p.id: p for p in PANELS}

#: The six KPI cards a reader can add beside the headline three. Mirrors
#: ADDABLE_KPI_ORDER in frontend/src/components/command/kpiDeckState.ts.
CARDS: tuple[tuple[str, str], ...] = (
    ("margin_impact", "Margin Impact"),
    ("pei", "Promotion Effectiveness Index"),
    ("cannibalization_rate", "Cannibalization Rate"),
    ("volume_uplift", "Volume Uplift"),
    ("net_incremental_profit", "Net Incremental Profit"),
    ("target_hit_rate", "Target Hit Rate"),
)
CARD_IDS: tuple[str, ...] = tuple(key for key, _label in CARDS)
CARD_LABELS: dict[str, str] = dict(CARDS)

#: The headline three are always on screen and cannot be removed — they are
#: what the page IS. Named so the model can say so rather than fail silently.
FIXED_CARDS: tuple[tuple[str, str], ...] = (
    ("trade_spend", "Trade Spend"),
    ("incremental_sales", "Incremental Sales"),
    ("promotion_roi", "Promotion ROI"),
)


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
) -> dict[str, Any]:
    """One described change to what the Hub shows.

    Raises ValueError naming anything that does not exist, so the model is
    told rather than the reader being told a change happened that did not.
    """
    show_charts = [c for c in (show_charts or [])]
    hide_charts = [c for c in (hide_charts or [])]
    show_cards = [c for c in (show_cards or [])]
    hide_cards = [c for c in (hide_cards or [])]

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
                f"{describe_cards(fixed)} is one of the three headline cards and is always on "
                "screen; it cannot be added or removed."
            )
        raise ValueError(
            f"No card called {', '.join(bad_cards)}. The cards are: {', '.join(CARD_IDS)}."
        )
    if not (show_charts or hide_charts or show_cards or hide_cards or reset):
        raise ValueError("Say what to show, what to hide, or ask for a reset.")

    # Showing and hiding the same thing in one breath is a mistake worth
    # naming: whichever won would be arbitrary.
    both = (set(show_charts) & set(hide_charts)) | (set(show_cards) & set(hide_cards))
    if both:
        raise ValueError(f"Asked to both show and hide {', '.join(sorted(both))}.")

    parts: list[str] = []
    if reset:
        parts.append("put the Insights Hub back to its default charts and cards")
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
        "show_charts": show_charts,
        "hide_charts": hide_charts,
        "show_cards": show_cards,
        "hide_cards": hide_cards,
        "summary": _sentence(parts),
    }


def _sentence(parts: list[str]) -> str:
    if not parts:
        return "changed the Insights Hub"
    if len(parts) == 1:
        return parts[0]
    return ", ".join(parts[:-1]) + " and " + parts[-1]
