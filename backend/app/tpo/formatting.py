"""Presentation: currency, magnitude and period labels.

Two rules this module exists to enforce:

  * Currency conversion is a DISPLAY concern. Every KPI is calculated in the
    base currency and stays there; the canonical number travels in `value` and
    only `display_value` is converted. No KPI function anywhere takes a
    currency argument, and the rate is read from config in exactly one place —
    `_to_display`.
  * ROI, PEI and Cannibalization are a multiple, a score and a rate. They are
    NEVER converted, whatever the currency toggle says.

The F24/F25 labels are likewise display-only. The underlying year stays 2024 /
2025 everywhere else, and no dataset field is renamed to produce the label.
"""

from __future__ import annotations

from app.tpo import config
from app.tpo.loader import MONTHS

# --- period labels ---------------------------------------------------------


def fiscal_label(year: int | None) -> str:
    """2024 -> "F24". Display only.

    The spec asks for FY24 to read as F24; the calculation, the filter and the
    stored data all continue to use 2024.
    """
    return "All Years" if year is None else f"F{year % 100:02d}"


def period_label(year: int | None, month: int | None) -> str:
    if year is None:
        return "All Time"
    if month is None:
        return f"{fiscal_label(year)} (Annual)"
    return f"{MONTHS[month - 1]} {fiscal_label(year)}"


# --- currency --------------------------------------------------------------

def _rate(currency: str) -> float:
    """Units of `currency` per one unit of base currency. ONE place."""
    if currency == config.BASE_CURRENCY:
        return 1.0
    if currency == "USD":
        return config.EXCHANGE_RATE_USD_PER_INR
    raise ValueError(f"Unsupported display currency: {currency}")


def normalise_currency(currency: str | None) -> str:
    value = (currency or config.BASE_CURRENCY).upper()
    return value if value in config.SUPPORTED_CURRENCIES else config.BASE_CURRENCY


def convert(value: float | None, currency: str) -> float | None:
    """Canonical base-currency figure -> the display currency."""
    return None if value is None else value * _rate(currency)


# Magnitude steps. INR uses the Indian crore/lakh convention the existing cards
# already show; USD uses M/K. Chosen so an executive card never renders a raw
# 1624000000.
_INR_STEPS = ((1e7, "Cr"), (1e5, "L"), (1e3, "K"))
_USD_STEPS = ((1e9, "B"), (1e6, "M"), (1e3, "K"))

_SYMBOL = {"INR": "₹", "USD": "$"}


def money(value: float | None, currency: str = "INR", *, dp: int = 2) -> str:
    """A canonical base-currency amount as a compact display string.

    money(1624000000, "INR") -> "Rs 162.40 Cr"   (with the rupee sign)
    money(1624000000, "USD") -> "$18.70 M"
    """
    if value is None:
        return "—"
    converted = convert(value, currency) or 0.0
    symbol = _SYMBOL[currency]
    sign = "-" if converted < 0 else ""
    magnitude = abs(converted)
    steps = _INR_STEPS if currency == "INR" else _USD_STEPS
    for size, suffix in steps:
        if magnitude >= size:
            return f"{sign}{symbol}{magnitude / size:,.{dp}f} {suffix}"
    return f"{sign}{symbol}{magnitude:,.0f}"


# --- non-monetary units ----------------------------------------------------


def percent(value: float | None, *, dp: int = 2, signed: bool = False) -> str:
    """A percentage. Never touched by the currency toggle."""
    if value is None:
        return "—"
    sign = "+" if signed and value > 0 else ""
    return f"{sign}{value:,.{dp}f}%"


def multiple(value: float | None, *, dp: int = 2, signed: bool = False) -> str:
    """A multiple of trade spend — the Promotion ROI's unit: "1.40x".

    THE "x" IS THE UNIT, and it is on the VALUE only. A signed call is a
    DIFFERENCE between two multiples ("+0.20"), which sits under a label that
    already says what it is; suffixing that too read as an extra quantity
    rather than a change. `signed=True` therefore returns the bare number.
    Never touched by the currency toggle, since a ratio of two rupee amounts
    has no currency of its own."""
    if value is None:
        return "—"
    rounded = round(value, dp) + 0.0  # -0.004 -> 0.00, never "-0.00"
    if signed:
        return f"{'+' if rounded > 0 else ''}{rounded:,.{dp}f}"
    return f"{rounded:,.{dp}f}x"


def score(value: float | None, *, dp: int = 0) -> str:
    """A 0-100 index. Never touched by the currency toggle."""
    return "—" if value is None else f"{value:,.{dp}f}"


def quantity(value: float | None) -> str:
    return "—" if value is None else f"{value:,.0f}"


def delta_label(growth: float | None, comparison: str | None) -> tuple[str, str]:
    """The "8.6%" / "vs F24" pair under a KPI value.

    Returns an em dash when the movement is undefined — no comparison period
    loaded, or a prior value of zero to divide by. A fabricated 0% would read
    as "no change", which is a different and false claim.
    """
    if growth is None:
        return "—", (f"vs {comparison}" if comparison else "no comparison period")
    return f"{growth:+,.2f}%", f"vs {comparison}"
