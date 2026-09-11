"""Generate the 2026 fact rows (January-August) and carry the calendar and
promotion dimensions forward to hold them.

WHY
---
The fact table ends at 2025 W52, so every year-on-year view the platform has
(the Sales Performance Comparison's MAGO / YAGO / YTD, the KPI deltas, the
Calendar's year tabs) runs out at December 2025. This adds the first eight
months of 2026 -- business weeks W01-W35, 1 Jan to 30 Aug 2026 -- so F26 can be
read against F25 the way F25 is read against F24.

NOTHING STRUCTURAL IS INVENTED. Every rule below was measured on the live
2024/2025 file before being written down here, and the same checks are re-run
on the generated rows before anything is written:

  * grain            -- one row per (store, product, year, week); the same 65
                        stores per channel the 2024/2025 sample uses
  * calendar         -- Date is the business week's first day from dim_date and
                        Month is that day's month; 2026 W01-W35 resolve to the
                        same months as 2025 W01-W35, so the promotion calendar
                        the strategy produces for 2026 is the 2025 one
                        verbatim, with the seasonal ids re-issued as PB..26
  * mechanics        -- PR001/PR002/PR003 are 5/10/15 % price cuts; the 2026
                        seasonal events keep 2025's Buy3Get1 mechanic, booked
                        as the approved 25 % effective price discount
  * prices           -- Base_Price is per product and unchanged since 2024;
                        Actual_Price = round(Base_Price x (1 - d)), banker's
                        rounding, verified on every promoted 2024/2025 row
  * quantities       -- Actual_Quantity == Base_Quantity (project invariant);
                        Base_Quantity = round(Normal_Demand x (1 + uplift))
  * costs            -- Total_Cost keeps each channel's own basis (see
                        TOTAL_COST_BASIS); Promotion_Cost = round(3 % x
                        Base_Revenue) on promoted rows, 0 otherwise
  * ids              -- each channel's Transaction_Id sequence continues

THE ONLY NEW INPUT IS THE 2026 DEMAND LEVEL. Normal_Demand for 2026 is the
2025 uplift-free demand of the same (store, product, week) -- which carries
every channel's product index, store index and seasonal curve -- scaled by:

  1. a per-month growth pattern, MONTH_GROWTH, the requested F26-vs-F25 shape:
     some months 4.5-6 % up, some 2-2.5 % down, the eight together about +2.5 %.
     It is stated as a target on Sales (sum of Actual_Revenue per month, the
     same definition the Sales Performance Comparison uses) and CALIBRATED to
     it: the demand multiplier is solved by fixed-point iteration so the
     realised monthly Sales growth lands on the target to within 0.05 pp,
     after rounding, jitter and the uplift lift below.

     The up and down months are deliberately BALANCED across every grouping
     the promotion calendar makes, because a product's non-promoted baseline
     comes entirely from the weeks it is NOT promoted in: the monthly
     channels' three-month treatment cycle (PR001 in Jan/Apr/Jul, PR002 in
     Feb/May/Aug, PR003 in Mar/Jun), B2B's pack alternation (P3 in odd
     months, P2 in even), the weekly channels' odd/even-week pack alternation
     and their own treatment cycles, General Trade's unpromoted fifth weeks,
     and the seasonal weeks and months. A pattern that lifts the weeks a
     treatment runs in and cuts the weeks it does not has the engine read
     growth as promotional uplift and moves each channel's ROI by a different
     amount: a first draft that lifted every seasonal month measured a PB001
     uplift of 82 % against a 60-72 % band; one that lined up with the
     three-month cycle put PR001 at 21 %; one that cut the odd-week-heavy
     months (Jan, Jun) took two points off every weekly channel. The pattern
     above was searched for so that every grouping's revenue-weighted growth
     sits within 1.3 pp of the year-to-date figure; with the 2024/2025
     midpoint uplift it reproduces F25's ROI in every channel to within about
     a point, so the lift below is what moves ROI, and it moves every channel
     alike. Growth and promotion must not be confounded, and `measured_uplift`
     is the gate that says they are not.
  2. small deterministic drifts -- per channel, per brand within a channel,
     per store -- so channels, brands and stores do not all grow by the same
     number. They average out; the calibration absorbs whatever does not.
  3. jitter at the cadence the channel already shows: weekly channels vary
     week to week (measured within-month CV ~0.03), monthly channels move
     month to month and are near-flat inside a month (CV ~0.008).

The uplift applied to promoted rows stays inside the approved bands
(`config.TREATMENT_RULES`), a little above the midpoint 2024/2025 used --
2026's promotions ran slightly more efficiently, which is what lifts the
year-to-date Promotion ROI a couple of points above F25's while leaving every
channel and retailer in the same relative position (the calendar is channel-
wide, so within a channel every retailer moves together, exactly as in F25).

Run:  venv/Scripts/python.exe scripts/generate_2026.py            # writes Data/
      venv/Scripts/python.exe scripts/generate_2026.py <out_dir>  # stages a full
                                                                  # six-file copy
"""

from __future__ import annotations

import csv
import hashlib
import io
import random
import re
import shutil
import sys
from collections import Counter, defaultdict
from datetime import date, timedelta
from pathlib import Path

REPO = Path(__file__).resolve().parents[1]
DATA = REPO / "Data"
FACT = DATA / "fact_sales_2024_2025_all_channels.csv"
DIM_DATE = DATA / "dim_date2425_corrected.csv"
DIM_PROMO = DATA / "dim_promotion_final.csv"
DIM_PRODUCT = DATA / "dim_product_reordered.csv"
UNTOUCHED_DIMS = ("dim_channel.csv", "dim_geo_store_final.csv", "dim_product_reordered.csv")

YEAR = 2026
SOURCE_YEAR = 2025
#: W36 starts 31 Aug and runs into September; the fact carries whole business
#: weeks only, so August closes at W35 (24-30 Aug), the last week that is
#: entirely inside the month. 2025 W01-W35 cover the same eight months, so
#: every 2026 month has exactly the number of weeks its 2025 counterpart has.
LAST_WEEK = 35
MONTHS_COVERED = range(1, 9)

NO_PROMOTION = "-1"
CHANNELS = ("CH001", "CH002", "CH003", "CH004", "CH005", "CH006")
WEEKLY_CHANNELS = {"CH001", "CH004", "CH006"}

HEADER = [
    "Transaction_Id", "Date", "Week", "Month", "Product_id", "Store_Id",
    "Channel_Id", "Promotion_Id", "Base_Quantity", "Actual_Quantity",
    "Base_Price", "Actual_Price", "Base_Revenue", "Actual_Revenue",
    "Total_Cost", "Promotion_Cost", "Schedule",
]
MONTH_NAMES = [
    "January", "February", "March", "April", "May", "June",
    "July", "August", "September", "October", "November", "December",
]
DAY_NAMES = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"]

# --- the requested F26 shape -------------------------------------------------

#: Sales growth vs the same month of 2025, as a fraction, month -> target.
#: Sales = sum of Actual_Revenue, month = business-week start month. Five
#: months up, three down; weighted by 2025's monthly Sales the eight come to
#: about +2.5 % year to date.
#:
#: The swing is kept moderate ON PURPOSE. The annual Cannibalization Rate
#: measures every neighbour against its whole-year mean baseline and counts
#: only shortfalls, so a year whose first four months all sit above the mean
#: and next three all below reads the low months as cannibalised volume even
#: when each month's own rate matches F25's. A +6.5..+8.5 / -5.5..-6.5 %
#: pattern put F26's annual rate at 21.8 % against F25's 11.2 % on identical
#: monthly rates; this one lands it in the mid-teens.
MONTH_GROWTH: dict[int, float] = {
    1: +0.050,   # New Year
    2: +0.060,
    3: +0.055,   # Holi
    4: +0.060,
    5: -0.025,   # a soft summer: May-July all down
    6: -0.020,
    7: -0.020,
    8: +0.045,   # Independence Day, recovering
}

#: Per-channel drift on top of the month pattern, as a fraction. Small, so no
#: channel leaves its month's 5-10 % band, and roughly revenue-neutral; the
#: calibration keeps the all-channel figure on target regardless.
CHANNEL_DRIFT: dict[str, float] = {
    "CH001": +0.010,   # E-commerce
    "CH002": +0.000,   # Modern Trade
    "CH003": -0.003,   # General Trade -- two thirds of revenue, so kept near zero
    "CH004": +0.005,   # Travel & Hospitality
    "CH005": +0.005,   # B2B
    "CH006": +0.015,   # Q-Commerce
}

#: Half-width of the per-(channel, brand) and per-store drifts, as fractions.
BRAND_DRIFT = 0.020
STORE_DRIFT = 0.015

#: Jitter, as coefficient of variation, at the cadence each channel shows.
WEEKLY_JITTER_CV = 0.025          # weekly channels, per (store, product, week)
MONTHLY_JITTER_CV = 0.015         # monthly channels, per (store, product, month)
MONTHLY_WEEK_JITTER_CV = 0.005    # ... plus a whisper per week

#: Reproducibility. Every random factor is hashed from its own coordinates
#: under this seed, so rerunning or regenerating a subset is byte-identical.
SEED = "F26-jan-aug-v1"

# --- approved treatment rules --------------------------------------------------

#: Treatment -> price discount. PB001 is Buy3Get1 booked as the approved 25 %
#: effective discount (see scripts/validate_fact_data.py EXPECTED_DISCOUNT).
DISCOUNT: dict[str, float] = {
    NO_PROMOTION: 0.00, "PR001": 0.05, "PR002": 0.10, "PR003": 0.15,
    "PS001": 0.20, "PB001": 0.25,
}

#: Approved uplift bands (config.TREATMENT_RULES). Never widened.
UPLIFT_RANGES: dict[str, tuple[float, float]] = {
    NO_PROMOTION: (0.00, 0.00),
    "PR001": (0.15, 0.20),
    "PR002": (0.25, 0.35),
    "PR003": (0.40, 0.50),
    "PS001": (0.55, 0.65),
    "PB001": (0.60, 0.72),
}

#: The uplift 2026 promoted rows carry, inside each band. 2024/2025 used the
#: exact midpoint (0.175 / 0.30 / 0.45 / 0.66); 2026 sits a little above it,
#: which is what moves year-to-date ROI up a couple of points. The measured
#: mean uplift per treatment (against each product's own non-promoted 2026
#: baseline, per channel) is asserted inside the band before writing.
UPLIFT_2026: dict[str, float] = {
    NO_PROMOTION: 0.000,
    "PR001": 0.180,
    "PR002": 0.310,
    "PR003": 0.460,
    "PB001": 0.670,
}

MANUFACTURING_COST_RATE = 0.65
GT_COST_RATE = 0.35
PROMOTION_COST_RATE = 0.03

#: Total_Cost basis per channel, measured exactly on every 2024/2025 row:
#:   flat   -- round(0.65 x Base_Revenue)                 (CH001, CH006)
#:   unit65 -- Base_Quantity x round(0.65 x Base_Price)   (CH002, CH004, CH005)
#:   unit35 -- Base_Quantity x round(0.35 x Base_Price)   (CH003)
TOTAL_COST_BASIS: dict[str, str] = {
    "CH001": "flat", "CH002": "unit65", "CH003": "unit35",
    "CH004": "unit65", "CH005": "unit65", "CH006": "flat",
}

#: The seasonal events that fall inside January-August, and the 2026 rows
#: dim_promotion needs for them. The mechanic continues 2025's.
SEASONAL_2026: dict[str, tuple[str, str]] = {
    "PBNY26": ("Buy3Get1", "New Year Savings 26"),
    "PBHO26": ("Buy3Get1", "Holi Special Deal 26"),
    "PBSU26": ("Buy3Get1", "Summer Special 26"),
    "PBIN26": ("Buy3Get1", "Independence Offer 26"),
}


def treatment_of(promotion_id: str) -> str:
    """fact Promotion_Id -> the treatment whose discount and uplift apply."""
    if promotion_id == NO_PROMOTION or promotion_id.startswith("PR"):
        return promotion_id
    if promotion_id.endswith("24"):
        return "PS001"
    if promotion_id.endswith(("25", "26")):
        return "PB001"
    raise ValueError(f"Unmapped Promotion_Id: {promotion_id!r}")


def source_uplift(promotion_id: str) -> float:
    """The uplift a 2024/2025 row carries: the band midpoint, as generated."""
    low, high = UPLIFT_RANGES[treatment_of(promotion_id)]
    return (low + high) / 2


def uplift_2026(promotion_id: str) -> float:
    return UPLIFT_2026[treatment_of(promotion_id)]


def _fmt(value: float) -> str:
    """Every numeric cell in the file is a plain integer."""
    rounded = round(value)
    return str(int(rounded)) if abs(value - rounded) < 1e-9 else repr(value)


def total_cost(channel: str, base_quantity: int, base_price: float, base_revenue: float) -> int:
    basis = TOTAL_COST_BASIS[channel]
    if basis == "flat":
        return round(MANUFACTURING_COST_RATE * base_revenue)
    rate = MANUFACTURING_COST_RATE if basis == "unit65" else GT_COST_RATE
    return base_quantity * round(rate * base_price)


def verify_identities(row: dict[str, str]) -> list[str]:
    """The generator identities, checked on every source and generated row."""
    bq, aq = float(row["Base_Quantity"]), float(row["Actual_Quantity"])
    bp, ap = float(row["Base_Price"]), float(row["Actual_Price"])
    br, ar = float(row["Base_Revenue"]), float(row["Actual_Revenue"])
    tc, pc = float(row["Total_Cost"]), float(row["Promotion_Cost"])
    pid = row["Promotion_Id"].strip()

    failures = []
    if aq != bq:
        failures.append("Actual_Quantity != Base_Quantity")
    if abs(br - bq * bp) > 0.51:
        failures.append("Base_Revenue != Base_Quantity x Base_Price")
    if abs(ar - aq * ap) > 0.51:
        failures.append("Actual_Revenue != Actual_Quantity x Actual_Price")
    if ap != round(bp * (1 - DISCOUNT[treatment_of(pid)])):
        failures.append("Actual_Price != round(Base_Price x (1 - d))")
    if tc != total_cost(row["Channel_Id"], int(bq), bp, br):
        failures.append("Total_Cost off its channel basis")
    expected_pc = round(PROMOTION_COST_RATE * br) if pid != NO_PROMOTION else 0
    if pc != expected_pc:
        failures.append("Promotion_Cost != round(0.03 x Base_Revenue)")
    return failures


# --- calendar ------------------------------------------------------------------


def _parse(value: str) -> date:
    day, month, year = value.strip().split("-")
    return date(int(year), int(month), int(day))


def _ddmmyyyy(day: date) -> str:
    return f"{day.day:02d}-{day.month:02d}-{day.year}"


def read_dim_date() -> list[dict[str, str]]:
    with DIM_DATE.open(newline="", encoding="utf-8-sig") as handle:
        return list(csv.DictReader(handle))


def extend_dim_date(existing: list[dict[str, str]]) -> list[dict[str, str]]:
    """The days dim_date lacks to finish 2026, numbered by its own convention.

    Measured on the file: W01 starts on 1 January whatever weekday that is,
    every later week starts on a Monday, and the Monday-started stub that
    runs past 31 December is labelled week 1 (2024: 30-31 Dec; 2025: 29-31
    Dec). Quarter is the calendar quarter. Nothing already present is touched.
    """
    have = {_parse(r["Date"]) for r in existing}
    last = max(d for d in have if d.year == YEAR)
    last_week = max(int(r["Week"]) for r in existing if int(r["Year"]) == YEAR)
    if last.weekday() != 6:
        raise ValueError(f"dim_date's 2026 coverage ends on {last} ({DAY_NAMES[last.weekday()]}), not a Sunday")

    rows: list[dict[str, str]] = []
    week = last_week
    day = last + timedelta(days=1)
    while day.year == YEAR:
        if day.weekday() == 0:
            week += 1
            # The final Monday-started stub crosses into next year: week 1.
            if (day + timedelta(days=6)).year != YEAR:
                week = 1
        rows.append({
            "Date": _ddmmyyyy(day),
            "Year": str(YEAR),
            "Month": MONTH_NAMES[day.month - 1],
            "Quarter": f"Q{(day.month - 1) // 3 + 1}",
            "Week": str(week),
            "Day": DAY_NAMES[day.weekday()],
        })
        day += timedelta(days=1)
    return rows


def week_starts(dim_date: list[dict[str, str]]) -> dict[tuple[int, int], date]:
    first: dict[tuple[int, int], date] = {}
    for row in dim_date:
        key = (int(row["Year"]), int(row["Week"]))
        day = _parse(row["Date"])
        if key not in first or day < first[key]:
            first[key] = day
    return first


# --- the 2025 reference structure ---------------------------------------------


class Reference:
    """Everything 2026 inherits from the 2025 rows, extracted once."""

    def __init__(self, rows: list[dict[str, str]]) -> None:
        stores: dict[str, list[str]] = defaultdict(list)
        products: list[str] = []
        promo: dict[tuple[str, int], dict[str, str]] = defaultdict(dict)
        price: dict[str, str] = {}
        demand: dict[tuple[str, str, int], float] = {}
        seen_products: set[str] = set()
        seen_stores: set[str] = set()

        for row in rows:
            if int(row["Date"].strip()[-4:]) != SOURCE_YEAR:
                continue
            week = int(row["Week"])
            channel, store, product = row["Channel_Id"], row["Store_Id"], row["Product_id"]
            promotion = row["Promotion_Id"].strip()
            if store not in seen_stores:
                seen_stores.add(store)
                stores[channel].append(store)          # file order
            if product not in seen_products:
                seen_products.add(product)
                products.append(product)               # file order
            if promotion != NO_PROMOTION:
                promo[(channel, week)][product] = promotion
            price.setdefault(product, row["Base_Price"])
            demand[(store, product, week)] = int(row["Base_Quantity"]) / (1 + source_uplift(promotion))

        #: channel -> its stores, in the order the file lists them.
        self.stores = dict(stores)
        #: the 36 products in the order every store-week lists them.
        self.products = products
        #: (channel, week) -> {product: 2025 promotion id}, promoted products only.
        self.promo = dict(promo)
        #: product -> Base_Price, as written (unchanged since 2024).
        self.price = price
        #: (store, product, week) -> 2025 uplift-free Normal_Demand.
        self.demand = demand


def reissue(promotion_id: str) -> str:
    """PBNY25 -> PBNY26; the regular ids are year-free."""
    if promotion_id.startswith("PB") and promotion_id.endswith("25"):
        out = promotion_id[:-2] + "26"
        if out not in SEASONAL_2026:
            raise ValueError(f"{promotion_id} runs in Jan-Aug but {out} is not declared in SEASONAL_2026")
        return out
    return promotion_id


# --- deterministic random factors ---------------------------------------------


def _rng(*coords: object) -> random.Random:
    digest = hashlib.sha256("|".join([SEED, *map(str, coords)]).encode()).digest()
    return random.Random(int.from_bytes(digest[:8], "big"))


def brand_drift(channel: str, brand: str) -> float:
    return _rng("brand", channel, brand).uniform(-BRAND_DRIFT, BRAND_DRIFT)


def store_drift(store: str) -> float:
    return _rng("store", store).uniform(-STORE_DRIFT, STORE_DRIFT)


def jitter(channel: str, store: str, product: str, week: int, month: int) -> float:
    if channel in WEEKLY_CHANNELS:
        return _rng("week", store, product, week).gauss(1.0, WEEKLY_JITTER_CV)
    return (_rng("month", store, product, month).gauss(1.0, MONTHLY_JITTER_CV)
            * _rng("week", store, product, week).gauss(1.0, MONTHLY_WEEK_JITTER_CV))


# --- generation ----------------------------------------------------------------


def read_products() -> dict[str, str]:
    """Product_id -> Brand (the Brand Form the drift is keyed on)."""
    with DIM_PRODUCT.open(newline="", encoding="utf-8-sig") as handle:
        return {r["Product_id"].strip(): r["Brand"].strip() for r in csv.DictReader(handle)}


def next_ids(rows: list[dict[str, str]]) -> dict[str, int]:
    """Where each sequential channel's Transaction_Id numbering has got to."""
    top: dict[str, int] = defaultdict(int)
    for row in rows:
        channel = row["Channel_Id"]
        if channel in ("CH001", "CH006"):
            continue
        number = int(re.sub(r"\D", "", row["Transaction_Id"].split(channel, 1)[1]))
        top[channel] = max(top[channel], number)
    return {channel: n + 1 for channel, n in top.items()}


def transaction_id(channel: str, week: int, store: str, product: str, counter: dict[str, int]) -> str:
    if channel in ("CH001", "CH006"):
        return f"{channel}-{YEAR}-W{week:02d}-{store}-{product}"
    n = counter[channel]
    counter[channel] = n + 1
    if channel == "CH002":
        return f"CH002_{n:05d}"
    if channel == "CH003":
        return f"CH003-TX{n:07d}"
    return f"{channel}_{n:07d}"


def build_rows(
    ref: Reference,
    brand_of: dict[str, str],
    starts: dict[tuple[int, int], date],
    multiplier: dict[int, float],
    id_start: dict[str, int],
) -> list[dict[str, str]]:
    counter = dict(id_start)
    rows: list[dict[str, str]] = []
    for week in range(1, LAST_WEEK + 1):
        start = starts[(YEAR, week)]
        month = start.month
        date_s, month_s = _ddmmyyyy(start), MONTH_NAMES[month - 1]
        for channel in CHANNELS:
            promoted = ref.promo.get((channel, week), {})
            schedule = "WEEKLY" if channel in WEEKLY_CHANNELS else "MONTHLY"
            for store in ref.stores[channel]:
                s_drift = store_drift(store)
                for product in ref.products:
                    promotion = reissue(promoted.get(product, NO_PROMOTION))
                    treatment = treatment_of(promotion)
                    base_price_s = ref.price[product]
                    base_price = float(base_price_s)
                    actual_price = round(base_price * (1 - DISCOUNT[treatment]))

                    growth = (multiplier[month]
                              * (1 + CHANNEL_DRIFT[channel])
                              * (1 + brand_drift(channel, brand_of[product]))
                              * (1 + s_drift))
                    normal_demand = (ref.demand[(store, product, week)]
                                     * growth
                                     * jitter(channel, store, product, week, month))
                    base_quantity = max(1, round(normal_demand * (1 + UPLIFT_2026[treatment])))

                    base_revenue = base_quantity * base_price
                    actual_revenue = base_quantity * actual_price
                    rows.append({
                        "Transaction_Id": transaction_id(channel, week, store, product, counter),
                        "Date": date_s,
                        "Week": str(week),
                        "Month": month_s,
                        "Product_id": product,
                        "Store_Id": store,
                        "Channel_Id": channel,
                        "Promotion_Id": promotion,
                        "Base_Quantity": str(base_quantity),
                        "Actual_Quantity": str(base_quantity),   # project invariant
                        "Base_Price": base_price_s,
                        "Actual_Price": _fmt(actual_price),
                        "Base_Revenue": _fmt(base_revenue),
                        "Actual_Revenue": _fmt(actual_revenue),
                        "Total_Cost": _fmt(total_cost(channel, base_quantity, base_price, base_revenue)),
                        "Promotion_Cost": (_fmt(round(PROMOTION_COST_RATE * base_revenue))
                                           if promotion != NO_PROMOTION else "0"),
                        "Schedule": schedule,
                    })
    return rows


def monthly_sales(rows: list[dict[str, str]], year: int, starts: dict[tuple[int, int], date]) -> dict[int, float]:
    """Sales per business-week-start month -- the Sales Performance
    Comparison's own definition -- for the weeks 2026 covers."""
    out: Counter = Counter()
    for row in rows:
        if int(row["Date"].strip()[-4:]) != year:
            continue
        week = int(row["Week"])
        if week > LAST_WEEK:
            continue
        out[starts[(year, week)].month] += float(row["Actual_Revenue"])
    return dict(out)


def calibrate(
    ref: Reference,
    brand_of: dict[str, str],
    starts: dict[tuple[int, int], date],
    source_sales: dict[int, float],
    id_start: dict[str, int],
) -> tuple[dict[int, float], list[dict[str, str]]]:
    """Solve the per-month demand multiplier so realised Sales growth meets
    MONTH_GROWTH. Fixed-point: each pass rescales a month by target/realised.
    Converges in a handful of passes because everything else is deterministic.
    """
    multiplier = {m: 1 + g for m, g in MONTH_GROWTH.items()}
    for _ in range(12):
        rows = build_rows(ref, brand_of, starts, multiplier, id_start)
        realised = monthly_sales(rows, YEAR, starts)
        worst = 0.0
        for month, target in MONTH_GROWTH.items():
            got = realised[month] / source_sales[month] - 1
            worst = max(worst, abs(got - target))
            multiplier[month] *= (1 + target) / (1 + got)
        if worst < 0.0005:
            return multiplier, rows
    raise RuntimeError(f"Sales calibration did not converge (worst miss {worst:.4f})")


# --- checks on the generated rows ---------------------------------------------


def measured_uplift(rows: list[dict[str, str]]) -> dict[str, float]:
    """Mean uplift per treatment against each product's own non-promoted
    baseline, per channel -- validate_fact_data.py's check E, for 2026."""
    base_sum: Counter = Counter()
    base_n: Counter = Counter()
    for row in rows:
        if row["Promotion_Id"] == NO_PROMOTION:
            key = (row["Product_id"], row["Channel_Id"])
            base_sum[key] += float(row["Base_Quantity"])
            base_n[key] += 1
    total: Counter = Counter()
    count: Counter = Counter()
    for row in rows:
        if row["Promotion_Id"] == NO_PROMOTION:
            continue
        key = (row["Product_id"], row["Channel_Id"])
        baseline = base_sum[key] / base_n[key]
        treatment = treatment_of(row["Promotion_Id"])
        total[treatment] += float(row["Base_Quantity"]) / baseline - 1
        count[treatment] += 1
    return {t: total[t] / count[t] for t in total}


def roi(rows: list[dict[str, str]]) -> float:
    """Promotion ROI as app/tpo/aggregate.py defines it, over these rows."""
    base_sum: Counter = Counter()
    base_n: Counter = Counter()
    for row in rows:
        if row["Promotion_Id"].strip() == NO_PROMOTION:
            key = (row["Product_id"], row["Channel_Id"])
            base_sum[key] += float(row["Base_Quantity"])
            base_n[key] += 1
    incremental = spend = 0.0
    for row in rows:
        spend += float(row["Base_Revenue"]) - float(row["Actual_Revenue"]) + float(row["Promotion_Cost"])
        if row["Promotion_Id"].strip() == NO_PROMOTION:
            continue
        key = (row["Product_id"], row["Channel_Id"])
        baseline = base_sum[key] / base_n[key]
        incremental += (float(row["Actual_Quantity"]) - baseline) * float(row["Actual_Price"])
    return (incremental - spend) / spend * 100


# --- writing -------------------------------------------------------------------


def _newline_of(path: Path) -> str:
    """Match whatever the file uses ON DISK. Git flips these between LF in the
    index and CRLF in the working tree, so it is measured, never assumed."""
    return "\r\n" if b"\r\n" in path.read_bytes()[:65536] else "\n"


def append_rows(source: Path, destination: Path, rows: list[dict[str, str]], fieldnames: list[str]) -> None:
    """Copy `source` through as BYTES and append `rows` after it, so nothing
    above the append point can change quoting, spacing or line endings."""
    original = source.read_bytes()
    newline = _newline_of(source)
    if not original.endswith(b"\n"):
        original += newline.encode()
    buffer = io.StringIO(newline="")
    writer = csv.DictWriter(buffer, fieldnames=fieldnames, lineterminator=newline)
    writer.writerows(rows)
    destination.parent.mkdir(parents=True, exist_ok=True)
    destination.write_bytes(original + buffer.getvalue().encode("utf-8"))


def main() -> int:
    for path in (FACT, DIM_DATE, DIM_PROMO, DIM_PRODUCT):
        if not path.is_file():
            print(f"missing {path}", file=sys.stderr)
            return 1
    out_dir = Path(sys.argv[1]) if len(sys.argv) > 1 else DATA

    with FACT.open(newline="", encoding="utf-8") as handle:
        reader = csv.DictReader(handle)
        header = reader.fieldnames
        existing = list(reader)
    if header != HEADER:
        print(f"ABORT: unexpected header\n  {header}", file=sys.stderr)
        return 2
    years = {r["Date"].strip()[-4:] for r in existing}
    if str(YEAR) in years:
        print(f"ABORT: {YEAR} rows already present -- refusing to duplicate.", file=sys.stderr)
        return 2
    if str(SOURCE_YEAR) not in years:
        print(f"ABORT: no {SOURCE_YEAR} rows to build the {YEAR} profile from.", file=sys.stderr)
        return 2

    # The source rows must satisfy the identities this script relies on.
    source = [r for r in existing if r["Date"].strip()[-4:] == str(SOURCE_YEAR)]
    bad = [(i, f) for i, r in enumerate(source) if (f := verify_identities(r))]
    if bad:
        print(f"ABORT: {len(bad)} {SOURCE_YEAR} rows violate the generator identities.", file=sys.stderr)
        for index, failures in bad[:5]:
            print(f"  row {index}: {failures}", file=sys.stderr)
        return 2
    print(f"reference identities verified on all {len(source):,} {SOURCE_YEAR} rows")

    # Calendar: 2026 must map its first 35 weeks onto the same months 2025 does,
    # or the copied promotion calendar would put events in the wrong month.
    dim_date = read_dim_date()
    new_days = extend_dim_date(dim_date)
    starts = week_starts(dim_date + new_days)
    for week in range(1, LAST_WEEK + 1):
        if starts[(YEAR, week)].month != starts[(SOURCE_YEAR, week)].month:
            print(f"ABORT: {YEAR} W{week:02d} starts in month {starts[(YEAR, week)].month}, "
                  f"{SOURCE_YEAR} W{week:02d} in {starts[(SOURCE_YEAR, week)].month}", file=sys.stderr)
            return 2
    assert starts[(YEAR, LAST_WEEK + 1)].month == 8 and starts[(YEAR, LAST_WEEK)].month == 8
    print(f"calendar: {len(new_days)} days added to dim_date "
          f"({new_days[0]['Date']} .. {new_days[-1]['Date']}); "
          f"{YEAR} W01-W{LAST_WEEK} share {SOURCE_YEAR}'s week->month mapping")

    ref = Reference(existing)
    brand_of = read_products()
    id_start = next_ids(existing)
    source_sales = monthly_sales(existing, SOURCE_YEAR, starts)

    multiplier, generated = calibrate(ref, brand_of, starts, source_sales, id_start)

    # --- checks ----------------------------------------------------------------
    bad = [(i, f) for i, r in enumerate(generated) if (f := verify_identities(r))]
    if bad:
        print(f"ABORT: {len(bad)} generated rows violate the generator identities.", file=sys.stderr)
        for index, failures in bad[:5]:
            print(f"  row {index}: {failures}", file=sys.stderr)
        return 3
    ids = Counter(r["Transaction_Id"] for r in generated)
    dupes = [k for k, v in ids.items() if v > 1]
    clash = ids.keys() & {r["Transaction_Id"] for r in existing}
    if dupes or clash:
        print(f"ABORT: {len(dupes)} duplicate and {len(clash)} colliding Transaction_Ids", file=sys.stderr)
        return 3
    expected = LAST_WEEK * len(ref.products) * sum(len(s) for s in ref.stores.values())
    if len(generated) != expected:
        print(f"ABORT: built {len(generated):,} rows, expected {expected:,}", file=sys.stderr)
        return 3
    uplift = measured_uplift(generated)
    # The 2026 seasonal price must equal what the same product sold at under
    # the 2025 Buy3Get1 booking -- same mechanic, same price.
    price_2025 = {(r["Product_id"], treatment_of(r["Promotion_Id"].strip())): r["Actual_Price"] for r in source}
    mismatch = [r for r in generated
                if r["Promotion_Id"] != NO_PROMOTION
                and price_2025.get((r["Product_id"], treatment_of(r["Promotion_Id"]))) != r["Actual_Price"]]
    if mismatch:
        print(f"ABORT: {len(mismatch)} rows priced differently from the same treatment in {SOURCE_YEAR}", file=sys.stderr)
        return 3

    # --- report ----------------------------------------------------------------
    realised = monthly_sales(generated, YEAR, starts)
    print(f"\n{YEAR} rows generated : {len(generated):,}  (W01-W{LAST_WEEK}, "
          f"{sum(len(s) for s in ref.stores.values())} stores x {len(ref.products)} products)")
    print("  Sales vs same month F25 (target -> realised):")
    for month in MONTHS_COVERED:
        got = realised[month] / source_sales[month] - 1
        print(f"    {MONTH_NAMES[month - 1]:9s} {MONTH_GROWTH[month]:+.1%} -> {got:+.2%}   "
              f"demand x{multiplier[month]:.4f}")
    ytd_src = sum(source_sales[m] for m in MONTHS_COVERED)
    ytd_new = sum(realised[m] for m in MONTHS_COVERED)
    print(f"    YTD Jan-Aug       {ytd_new / ytd_src - 1:+.2%}   "
          f"({ytd_src / 1e7:.2f} Cr -> {ytd_new / 1e7:.2f} Cr)")
    src_ytd = [r for r in source if int(r["Week"]) <= LAST_WEEK]
    print(f"  Promotion ROI Jan-Aug: F25 {roi(src_ytd):.1f}%  ->  F26 {roi(generated):.1f}%")
    for channel in CHANNELS:
        a = roi([r for r in src_ytd if r["Channel_Id"] == channel])
        b = roi([r for r in generated if r["Channel_Id"] == channel])
        print(f"    {channel}: {a:5.1f}% -> {b:5.1f}%")
    print("  measured uplift by treatment: "
          + ", ".join(f"{t} {u:.1%} (band {lo:.0%}-{hi:.0%})"
                      for t, u in sorted(uplift.items()) for lo, hi in [UPLIFT_RANGES[t]]))
    promo_rows = sum(1 for r in generated if r["Promotion_Id"] != NO_PROMOTION)
    print(f"  promoted rows      : {promo_rows:,} ({promo_rows / len(generated):.1%})")

    # The gate on the numbers above: reported first so a failing run still
    # shows what it measured.
    out_of_band = {t: u for t, u in uplift.items() if not (UPLIFT_RANGES[t][0] <= u <= UPLIFT_RANGES[t][1])}
    if out_of_band:
        print(f"ABORT: measured uplift outside the approved band: {out_of_band}", file=sys.stderr)
        return 3

    # --- write -----------------------------------------------------------------
    out_dir.mkdir(parents=True, exist_ok=True)
    append_rows(FACT, out_dir / FACT.name, generated, header)
    append_rows(DIM_DATE, out_dir / DIM_DATE.name, new_days, ["Date", "Year", "Month", "Quarter", "Week", "Day"])
    with DIM_PROMO.open(newline="", encoding="utf-8-sig") as handle:
        promo_reader = csv.DictReader(handle)
        promo_fields = promo_reader.fieldnames
        known = {r["Promotion_Id"].strip() for r in promo_reader}
    used = {r["Promotion_Id"] for r in generated if r["Promotion_Id"].startswith("PB")}
    new_promos = [
        {"Promotion_Id": pid, "Promotion_Name": name, "Promotion_Type": "Seasonal",
         "Promotion_Description": description}
        for pid, (name, description) in SEASONAL_2026.items()
        if pid not in known and pid in used
    ]
    append_rows(DIM_PROMO, out_dir / DIM_PROMO.name, new_promos, promo_fields)
    if out_dir != DATA:
        for name in UNTOUCHED_DIMS:
            shutil.copyfile(DATA / name, out_dir / name)

    print(f"\nwritten to {out_dir}:")
    print(f"  {FACT.name}: {len(existing):,} -> {len(existing) + len(generated):,} rows")
    print(f"  {DIM_DATE.name}: +{len(new_days)} days")
    print(f"  {DIM_PROMO.name}: +{len(new_promos)} promotions ({', '.join(p['Promotion_Id'] for p in new_promos)})")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
