"""TPO backend configuration — every tunable number, in one place.

Nothing else in app/tpo/ reads os.environ or hardcodes a rate, a target or a
path. Two of these in particular are things the spec forbids scattering:

  * `EXCHANGE_RATE_USD_PER_INR` — currency conversion is a PRESENTATION
    concern. KPI functions never see it; they return canonical INR and the
    formatter applies this once. See app/tpo/formatting.py.
  * `PROMOTION_TARGET_ROI` — the hurdle the Risk Alert severity bands,
    the "vs Target" column and the trend chart's benchmark line all read.
    Two independently hardcoded targets would silently drift apart.
"""

from __future__ import annotations

import os
from pathlib import Path

# --- datasets --------------------------------------------------------------

#: The finalized TPO star schema, resolved in priority order:
#:
#:   1. $TPO_DATA_DIR              — explicit override, always wins
#:   2. <repo>/Data                — the in-repo copy, so a clone is self-contained
#:   3. ~/OneDrive/Desktop/TPO_FINAL — where the datasets were authored
#:
#: Deliberately NOT the previous project's fact_sales — that dataset is stale
#: (61,360 rows, no Channel_Id) and is superseded by these five files.
FACT_FILE = "fact_sales_2024_2025_all_channels.csv"
DIM_FILES = {
    "product": "dim_product_reordered.csv",
    "geo_store": "dim_geo_store_final.csv",
    "channel": "dim_channel.csv",
    "promotion": "dim_promotion_final.csv",
    "date": "dim_date2425_corrected.csv",
}

_REPO_ROOT = Path(__file__).resolve().parents[3]
_CANDIDATES = (
    _REPO_ROOT / "Data",
    Path.home() / "OneDrive" / "Desktop" / "TPO_FINAL",
)


def _resolve_data_dir() -> Path:
    override = os.environ.get("TPO_DATA_DIR")
    if override:
        return Path(override)
    for candidate in _CANDIDATES:
        if (candidate / FACT_FILE).is_file():
            return candidate
    # No candidate holds data yet — a first run against a clone with an empty
    # Data/ folder, before anything has been uploaded. Resolve to the in-repo
    # Data/ anyway rather than to the authoring machine's OneDrive path: it is
    # where the Excel connector writes, so pointing the loader anywhere else
    # would have an upload land in one folder while the loader read another.
    return _CANDIDATES[0]


DATA_DIR = _resolve_data_dir()


# --- targets ---------------------------------------------------------------

#: The ROI a promotion must clear, as a multiple of trade spend — the same
#: units the Promotion ROI card displays (`1.50`). The validated project's
#: 50% net-return target, restated on the multiple scale.
PROMOTION_TARGET_ROI: float = 1.5

#: The range a reader may set the target to on the Insights Hub. Below 1.00
#: a promotion "hits target" while losing money; above 2.00 nothing in the
#: data clears it and every panel goes red. Both ends are inclusive.
TARGET_ROI_MIN: float = 1.0
TARGET_ROI_MAX: float = 2.0

#: How far beneath the target each Risk Alert band starts, as ROI multiples.
#: Stated as OFFSETS so the bands travel with the target: at the default 1.50
#: they are the long-standing 1.25 / 1.40 / 1.50, and a reader who sets 1.70
#: gets 1.45 / 1.60 / 1.70 -- the same shape, moved.
SEVERITY_OFFSETS = {
    "critical": -0.25,  # ROI < target - 0.25
    "high": -0.10,      # target - 0.25 <= ROI < target - 0.10
    "medium": 0.0,      # target - 0.10 <= ROI < target
}


def severity_bands(target: float = PROMOTION_TARGET_ROI) -> dict[str, float]:
    """The three band ceilings for a given target. A promotion at or above
    the target is not an alert at all."""
    return {band: round(target + offset, 2) for band, offset in SEVERITY_OFFSETS.items()}


#: The bands at the default target -- what every module other than the
#: Insights Hub reads, and what the Insights Hub reads until a target is set.
SEVERITY_BANDS = severity_bands()


def target_incremental_sales(trade_spend: float, target: float = PROMOTION_TARGET_ROI) -> float:
    """Incremental revenue a given trade spend must return to hit target.

    Inverting the ROI definition,
        ROI = Incremental Sales / Trade Spend
    at ROI = target gives
        Target Incremental Sales = Trade Spend x target

    which at the default 1.5 target is `trade_spend x 1.5` — the "At Stake"
    formula. Written as the inversion rather than as a literal 1.5 so the two
    cannot disagree when the target moves.
    """
    return round(trade_spend * target, 2)


# --- approved promotion treatment rules ------------------------------------
#
# RELOCATED VERBATIM from scripts/audit_roi_realism.py, which now imports them
# back from here. Values, units and arithmetic are unchanged; the move exists
# so that application code has a source of truth that is not a script.
#
# WHAT THESE ARE, EXACTLY. They are the promotion rules this project's dataset
# was generated under, and every one of them has been verified to hold in the
# live file: the audit reports measured uplifts of 18.2 / 30.3 / 43.8 / 60.5 /
# 69.1 percent, each inside its own band. They are NOT an elasticity estimated
# from observed variation, NOT a model fit, and NOT a forecast. Anything built
# on them must say so -- see response.PROVENANCE.

#: The promotional overhead every promoted row in the fact file carries, as a
#: share of Base_Revenue. The same 0.03 the economics scripts book.
PROMOTION_COST_RATE: float = 0.03

#: Treatment -> (discount d, uplift band low, uplift band high), all as
#: FRACTIONS, not percentages. PR001-PR003 are the year-round mechanics;
#: PS001 is the 2024 seasonal 20% price cut and PB001 the 2025 seasonal
#: Buy3Get1, which `scripts/audit_roi_realism.treatment_of` maps the dated
#: seasonal ids onto.
TREATMENT_RULES: dict[str, tuple[float, float, float]] = {
    "PR001": (0.05, 0.15, 0.20),
    "PR002": (0.10, 0.25, 0.35),
    "PR003": (0.15, 0.40, 0.50),
    "PS001": (0.20, 0.55, 0.65),
    "PB001": (0.25, 0.60, 0.72),
}


def breakeven_uplift(d: float, c: float = PROMOTION_COST_RATE) -> float:
    """u* such that ROI == 1.0 — break-even.

    DERIVED, NOT FITTED. With Base_Quantity == Actual_Quantity == b(1+u), a
    price discount d and a promotion cost rate c on Base_Revenue:

        Incremental Sales = b.u.P.(1-d)
        Trade Spend       = b.(1+u).P.(d+c)
        ROI               = u(1-d) / ((1+u)(d+c))

        ROI = 1  <=>  u* = (d + c) / (1 - c - 2d)

    Relocated unchanged from scripts/audit_roi_realism.py, including its
    domain: the denominator goes non-positive once 2d + c >= 1, i.e. beyond a
    48.5% discount at the standard cost rate. No guard is added here, because
    adding one would change the behaviour of a function this move is only
    supposed to relocate. The approved treatments top out at d = 0.25, well
    inside the domain; app/tpo/studio.py bounds its discount slider by the data instead.
    """
    return (d + c) / (1 - c - 2 * d)


# --- currency --------------------------------------------------------------

#: Base currency of every stored figure and every KPI calculation. Nothing
#: converts on the way in.
BASE_CURRENCY = "INR"

#: USD per 1 INR. ONE configurable value, applied once at display time.
EXCHANGE_RATE_USD_PER_INR: float = float(os.environ.get("TPO_USD_PER_INR", "0.0115"))

SUPPORTED_CURRENCIES = ("INR", "USD")
