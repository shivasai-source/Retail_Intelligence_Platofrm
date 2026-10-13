"""
What the Analyst knows about the business, as opposed to what it looks up.

WHY THIS EXISTS. The bot could already fetch a number and could not say what
the number MEANT. Asked "is 1.34 good?" or "what counts as trade spend?" it had
two bad options: stay silent, or improvise a definition — and an improvised
definition of Trade Spend is how a reader ends up believing the figure excludes
the price cut, which is the larger half of it.

WHERE THESE DEFINITIONS COME FROM. Every formula below is transcribed from the
function that actually computes it in `app/tpo/aggregate.py`, and every
threshold from `app/tpo/config.py`. They are prose restatements of running
code, not domain lore written from memory. The `source` field on each entry
names that function so a reader — or the next person editing this — can check
the claim against the arithmetic rather than trusting this file.

THE STANDING RISK. A formula changed in aggregate.py and not changed here makes
this file confidently wrong, which is worse than absent. `test_definitions_name_real_functions`
guards the weaker half of that (the named function must exist); the prose still
has to be re-read when a formula moves. Definitions are kept short for exactly
that reason — the less restated, the less can rot.
"""
from typing import Any

from app.tpo import config as tpo_config

#: Written against the units the KPI cards display, so a definition and a card
#: never describe the same quantity differently.
#:
#: `good` is deliberately absent wherever the platform has no stated hurdle:
#: inventing "a good margin is 30%" would be domain lore dressed as a system
#: fact. ROI is the one metric with a real, configurable target, and it is the
#: one that carries a judgement.
DEFINITIONS: dict[str, dict[str, Any]] = {
    "trade_spend": {
        "label": "Trade Spend",
        "formula": "Sum of (discount value + promotion cost) across the selection",
        "means": (
            "The total investment behind the promotions — BOTH the money paid away as "
            "promotion cost AND the revenue given up as a price cut. The price cut is "
            "usually the larger half, so a figure that counted only promotion cost would "
            "understate spend badly and flatter every ratio built on it."
        ),
        "unit": "money",
        "direction": "lower is better for the same return",
        "source": "aggregate.calculate_trade_spend",
    },
    "incremental_sales": {
        "label": "Incremental Sales",
        "formula": "Sum over promoted rows of (Actual units − Expected units) × that row's own price",
        "means": (
            "The revenue the promotion ADDED, over and above what the same rows would have "
            "sold without it. Expected units are the file's Base_Quantity when it carries a "
            "real baseline, otherwise the product's average over its nearest ordinary weeks "
            "in that channel — so a seasonal peak is not mistaken for promotional lift."
        ),
        "unit": "money",
        "direction": "higher is better",
        "caveat": (
            "Every promoted row carries its own expected units, so periods and events add "
            "up to the total. Groups that split a product's stores (a region, a retailer) "
            "measure each group against its own ordinary weeks."
        ),
        "source": "aggregate.calculate_incremental_sales",
    },
    "incremental_units": {
        "label": "Incremental Units",
        "formula": "Sum over promoted rows of (Actual units − Expected units)",
        "means": (
            "The extra VOLUME the promotion moved, in units rather than money. May be "
            "negative, and is not clamped: a promotion that sold less than the baseline "
            "genuinely destroyed volume, and hiding that behind a zero would be a lie."
        ),
        "unit": "quantity",
        "direction": "higher is better",
        "source": "aggregate.calculate_incremental_quantity",
    },
    "promotion_roi": {
        "label": "Promotion ROI",
        "formula": "Incremental Sales ÷ Trade Spend",
        "means": (
            "How many rupees of incremental sales each rupee of trade spend returned. It "
            "is a MULTIPLE, not a percentage: 1.00 is break-even — the spend merely came "
            "back — and below 1.00 the promotion destroyed value."
        ),
        "unit": "multiple",
        "direction": "higher is better",
        "source": "aggregate.calculate_roi",
    },
    "net_incremental_profit": {
        "label": "Net Incremental Profit",
        "formula": "Margin Impact − Promotion Cost − gross margin lost on cannibalized sister packs",
        "means": (
            "What the promotions added to profit: the extra gross margin they earned, less "
            "what it cost to run them and the margin taken from neighbouring pack sizes. ROI "
            "is a revenue ratio; every extra unit also has to be made, so a promotion can "
            "show ROI above 1.00 and still lose money here."
        ),
        "unit": "money",
        "direction": "higher is better",
        "caveat": (
            "The cannibalized margin is measured only where the selection holds the "
            "promoted pack's neighbours; a single-product view therefore carries none."
        ),
        "source": "aggregate.calculate_net_incremental_profit",
    },
    "margin_impact": {
        "label": "Margin Impact",
        "formula": (
            "Gross margin with the promotion − gross margin the same products would have "
            "earned without it (list price, only the units that would have sold anyway); "
            "gross margin = revenue − Total_Cost"
        ),
        "means": (
            "The extra gross margin, in money, the promotions earned. The discount lowers "
            "the margin on every unit; the extra units add margin back. Positive when the "
            "extra volume more than pays for the price cut."
        ),
        "unit": "money",
        "direction": "higher is better",
        "source": "aggregate.calculate_margin_impact",
    },
    "cannibalization_rate": {
        "label": "Cannibalization Rate",
        "formula": "Total cannibalized quantity ÷ promotional incremental quantity × 100",
        "means": (
            "The share of a promotion's extra volume that came OUT OF its neighbouring "
            "products rather than being genuinely new. High cannibalization means the "
            "promotion mostly moved demand around the shelf instead of growing it."
        ),
        "unit": "percent",
        "direction": "lower is better",
        "source": "aggregate.calculate_cannibalization",
    },
    "volume_uplift": {
        "label": "Volume Uplift",
        "formula": "Incremental units ÷ expected units × 100, over promoted rows",
        "means": (
            "The extra volume as a percentage of what those same promoted rows would have "
            "moved at ordinary, non-promoted levels."
        ),
        "unit": "percent",
        "direction": "higher is better",
        "source": "aggregate.calculate_incremental_quantity_percent",
    },
    "pei": {
        "label": "PEI (Promotion Effectiveness Index)",
        "formula": (
            "0.40 × (ROI net return, capped at 1.0 over break-even) "
            "+ 0.30 × (incremental quantity %, capped at 50%) "
            "+ 0.30 × (gross margin %, capped at 40%), scored 0–100"
        ),
        "means": (
            "A single 0–100 composite of the three signals that matter most. ROI enters as "
            "its NET return — the multiple less the 1.00 that is just the spend coming back "
            "— so a break-even promotion scores zero on that component rather than being "
            "handed a floor of 50 for returning its own money."
        ),
        "unit": "score",
        "direction": "higher is better",
        "caveat": (
            "Trade Spend Efficiency and cannibalization are deliberately NOT components: "
            "TSE is ROI × 100 by definition, so including both would put 45% of the weight "
            "on one signal."
        ),
        "source": "aggregate.calculate_pei",
    },
    "target_hit_rate": {
        "label": "Target Hit Rate",
        "formula": "Promotion events with ROI at or above the target ÷ all promotion events × 100",
        "means": (
            "The percentage of promotion events that cleared the ROI hurdle, rather than an "
            "average. An event is one product in one channel on one offer, over its run of "
            "consecutive promoted weeks."
        ),
        "unit": "percent",
        "direction": "higher is better",
        "source": "app/tpo/service.py",
    },
    "baseline": {
        "label": "Baseline",
        "formula": (
            "The file's Base_Quantity on a promoted row when it is a real baseline; otherwise "
            "the average units per store-week over the nearest 4 ordinary weeks either side, "
            "for that (product, channel)"
        ),
        "means": (
            "The counterfactual every uplift measure is built on: what this product would "
            "have sold in this channel that week without the promotion. Local, so a seasonal "
            "peak is not counted as lift; per (product, channel), so a high-volume SKU never "
            "sets the yardstick for a small one."
        ),
        "unit": "quantity",
        "direction": "context",
        "caveat": (
            "A product with no real Base_Quantity and no ordinary week in the selection has no baseline. That is reported, never "
            "defaulted to zero — a zero baseline would make any promoted volume look "
            "infinitely incremental."
        ),
        "source": "aggregate._volume",
    },
}

#: Words a reader is likely to use for a metric that is not its key. Kept
#: small and unambiguous — a synonym that maps two metrics onto one key would
#: answer confidently about the wrong number.
_ALIASES: dict[str, str] = {
    "roi": "promotion_roi",
    "return on investment": "promotion_roi",
    "spend": "trade_spend",
    "trade spend": "trade_spend",
    "tradespend": "trade_spend",
    "incremental revenue": "incremental_sales",
    "inc sales": "incremental_sales",
    "sales": "incremental_sales",
    "uplift": "volume_uplift",
    "volume": "incremental_units",
    "units": "incremental_units",
    "margin": "margin_impact",
    "cannibalization": "cannibalization_rate",
    "cannibalisation": "cannibalization_rate",
    "profit": "net_incremental_profit",
    "net profit": "net_incremental_profit",
    "effectiveness": "pei",
    "promotion effectiveness index": "pei",
    "hit rate": "target_hit_rate",
    "break even": "promotion_roi",
    "breakeven": "promotion_roi",
}


def resolve_term(term: str) -> str | None:
    """A reader's word for a metric -> its key, or None if it names nothing.

    Tries the key, then the alias table, then a containment scan so "what is
    the ROI target" finds `promotion_roi`. Returns None rather than a guess:
    a wrong definition is worse than "I don't have one for that".
    """
    # Hyphens and underscores both become spaces: a reader writes "break-even"
    # and "cannibalisation rate" as readily as "break even", and an alias table
    # that only matched one spelling would answer None to half of them.
    text = " ".join((term or "").casefold().replace("_", " ").replace("-", " ").split())
    if not text:
        return None
    key = text.replace(" ", "_")
    if key in DEFINITIONS:
        return key
    if text in _ALIASES:
        return _ALIASES[text]
    # Longest alias first, so "net profit" is not shadowed by "profit".
    for alias in sorted(_ALIASES, key=len, reverse=True):
        if alias in text:
            return _ALIASES[alias]
    for name in DEFINITIONS:
        if name.replace("_", " ") in text:
            return name
    return None


def define(term: str) -> dict[str, Any]:
    """One definition for the model, with the ROI hurdle attached where it
    applies. `{"error": ...}` when the term names nothing we define."""
    key = resolve_term(term)
    if not key:
        return {
            "error": f"no definition held for {term!r}",
            "defined_terms": sorted(DEFINITIONS),
        }

    entry = dict(DEFINITIONS[key])
    entry["metric"] = key

    # The one real, configurable hurdle in the platform. Read live from config
    # so a deployment that moved the target cannot be described with the old one.
    if key in ("promotion_roi", "target_hit_rate", "net_incremental_profit"):
        target = tpo_config.PROMOTION_TARGET_ROI
        entry["target"] = target
        entry["judgement"] = (
            f"The platform's target ROI is {target:.2f}x. 1.00x is break-even; "
            f"below 1.00x the promotion lost money; at or above {target:.2f}x it cleared "
            "the hurdle the Insights Hub judges against."
        )
    return entry


def glossary_lines() -> str:
    """The compact glossary that goes into the system prompt.

    One line per metric — enough for the bot to use a term correctly in a
    sentence without a tool call. The FULL definition, with formula and
    caveats, stays behind `define_kpi`, because pasting all of it into every
    turn would spend tokens on context that most questions never need.
    """
    out = []
    for key, entry in DEFINITIONS.items():
        line = f"- {entry['label']} ({key}): {entry['formula']}."
        if entry.get("direction") in ("higher is better", "lower is better"):
            line += f" {entry['direction'].capitalize()}."
        out.append(line)
    out.append(
        f"- Target ROI: {tpo_config.PROMOTION_TARGET_ROI:.2f}x is the hurdle; "
        "1.00x is break-even."
    )
    return "\n".join(out)
