"""Generate CH006 (Q-Commerce) fact rows and append them to the fact table.

WHY
---
`Data/dim_geo_store_final.csv` gained 48 CH006 stores (S510-S557) and
`dim_channel.csv` already carried `CH006,Q-Commerce,Retail`, but the fact table
had no CH006 transactions at all -- every Q-Commerce store read as zero volume
everywhere in the platform.

WHAT THIS DOES
--------------
Builds 10 stores x 36 products x 104 weeks = 37,440 rows and APPENDS them.
Nothing already in the file is read-modified-written: CH001-CH005 bytes are
copied through untouched and the new rows go after them.

Ten stores, not all 48, because the fact table samples its channels -- CH002 has
210 stores in the geo dimension and exactly 10 in the fact. Ten keeps CH006 at
the same weight as CH001/CH002/CH003/CH005 rather than letting it become 47% of
the dataset.
NOTHING HERE IS INVENTED. Every structural input is lifted from the existing
CH001 rows, which the project already treats as the reference weekly channel:

  * the 104-week calendar        -- (year, week) -> Date, Month, verbatim
  * the promotion calendar       -- (year, week) -> {product: promotion_id},
                                    verbatim, including which 9 of 36 products
                                    are promoted and the seasonal week map
  * Base_Price and Actual_Price  -- looked up from the CH001 row carrying the
                                    same (product, promotion), so the discount
                                    depth is copied rather than recomputed
  * the demand profile           -- (year, week, product) -> mean uplift-free
                                    Normal_Demand across CH001's ten stores,
                                    which carries CH001's product index, its
                                    seasonal curve and its +4.4% YoY growth

The only deliberate departures from CH001, both requested:

  1. BASKET_SCALE -- Q-Commerce runs smaller baskets than e-commerce, so the
     demand profile is scaled down uniformly. Product mix and every trend shape
     are preserved; only the level moves.
  2. per-store jitter -- CH001's ten stores are near-identical (cross-store CV
     0.033 at fixed product/year/week). The same spread is reproduced from a
     seeded draw so CH006's ten stores are not carbon copies of each other.

The generator identities are then applied exactly as `regenerate_ch001.py`
documents them, and re-verified on every generated row before anything is
written.
"""

from __future__ import annotations

import csv
import hashlib
import io
import random
import sys
from collections import Counter, defaultdict
from pathlib import Path

REPO = Path(__file__).resolve().parents[1]
FACT = REPO / "Data" / "fact_sales_2024_2025_all_channels.csv"
GEO = REPO / "Data" / "dim_geo_store_final.csv"

SOURCE_CHANNEL = "CH001"   # the reference weekly channel
CHANNEL = "CH006"
SCHEDULE = "WEEKLY"

#: Q-Commerce sells smaller baskets than e-commerce. Applied uniformly to the
#: CH001 demand profile, so CH006 keeps CH001's product mix, seasonal curve and
#: YoY growth and differs only in level.
BASKET_SCALE = 0.40

#: Cross-store spread, measured on CH001: at a fixed (product, year, week) the
#: coefficient of variation across its ten stores is mean 0.0326, median 0.0328.
STORE_JITTER_CV = 0.033

#: Reproducibility. Changing this reshuffles the jitter and nothing else.
SEED = "CH006-q-commerce-v1"

#: The ten CH006 stores that receive transactions, drawn from the 48 in the geo
#: dimension. All four brands appear; all ten are Tier 1, which is what makes
#: CH001's flat store index (every store x1.000) a faithful model -- a Tier 2
#: store carrying Tier 1 volume would be a visible artefact.
STORES: tuple[str, ...] = (
    "S510", "S511", "S512", "S513",   # Delhi     -- Blinkit, InstaMart, Zepto, BigBasket
    "S514", "S515", "S516", "S517",   # Mumbai    -- Blinkit, InstaMart, Zepto, BigBasket
    "S518", "S520",                   # Bengaluru -- Blinkit, Zepto
)

# --- constants lifted verbatim from scripts/regenerate_ch001.py -------------

#: TPO_FINAL/Modern_Trade.ipynb §20. The project's promotion response curve.
UPLIFT_RANGES: dict[str, tuple[float, float]] = {
    "-1": (0.00, 0.00),
    "PR001": (0.15, 0.20),
    "PR002": (0.25, 0.35),
    "PR003": (0.40, 0.50),
    "PS001": (0.55, 0.65),
    "PB001": (0.60, 0.72),
}

MANUFACTURING_COST_RATE = 0.65
PROMOTION_COST_RATE = 0.03
NO_PROMOTION = "-1"

HEADER = [
    "Transaction_Id", "Date", "Week", "Month", "Product_id", "Store_Id",
    "Channel_Id", "Promotion_Id", "Base_Quantity", "Actual_Quantity",
    "Base_Price", "Actual_Price", "Base_Revenue", "Actual_Revenue",
    "Total_Cost", "Promotion_Cost", "Schedule",
]


def treatment_of(promotion_id: str) -> str:
    """fact Promotion_Id -> the treatment whose uplift range applies."""
    if promotion_id == NO_PROMOTION or promotion_id.startswith("PR"):
        return promotion_id
    if promotion_id.endswith("24"):
        return "PS001"
    if promotion_id.endswith("25"):
        return "PB001"
    raise ValueError(f"Unmapped Promotion_Id: {promotion_id!r}")


def treatment_uplift(treatment_id: str) -> float:
    """Deterministic midpoint of the range, not a random draw."""
    low, high = UPLIFT_RANGES[treatment_id]
    return (low + high) / 2


def uplift_of(promotion_id: str) -> float:
    return treatment_uplift(treatment_of(promotion_id))


def _fmt(value: float) -> str:
    """Match the file's convention: every numeric cell is a plain integer."""
    rounded = round(value)
    return str(int(rounded)) if abs(value - rounded) < 1e-9 else repr(value)


def verify_identities(row: dict[str, str]) -> list[str]:
    """The six generator identities, from regenerate_ch001.py."""
    bq, aq = float(row["Base_Quantity"]), float(row["Actual_Quantity"])
    bp, ap = float(row["Base_Price"]), float(row["Actual_Price"])
    br, ar = float(row["Base_Revenue"]), float(row["Actual_Revenue"])
    tc, pc = float(row["Total_Cost"]), float(row["Promotion_Cost"])
    promoted = row["Promotion_Id"].strip() != NO_PROMOTION

    failures = []
    if aq != bq:
        failures.append("Actual_Quantity != Base_Quantity")
    if abs(br - bq * bp) > 0.51:
        failures.append("Base_Revenue != Base_Quantity x Base_Price")
    if abs(ar - aq * ap) > 0.51:
        failures.append("Actual_Revenue != Actual_Quantity x Actual_Price")
    if abs(tc - round(MANUFACTURING_COST_RATE * br)) > 1.01:
        failures.append("Total_Cost != round(0.65 x Base_Revenue)")
    expected_pc = round(PROMOTION_COST_RATE * br) if promoted else 0
    if abs(pc - expected_pc) > 1.01:
        failures.append("Promotion_Cost != round(0.03 x Base_Revenue)")
    return failures


# --- the CH001 reference structure -----------------------------------------


class Reference:
    """Everything CH006 copies from CH001, extracted once."""

    def __init__(self, source_rows: list[dict[str, str]]) -> None:
        calendar: dict[tuple[str, str], tuple[str, str]] = {}
        promo: dict[tuple[str, str], dict[str, str]] = defaultdict(dict)
        demand: dict[tuple[str, str, str], list[float]] = defaultdict(list)
        price: dict[tuple[str, str], tuple[str, str]] = {}
        products: set[str] = set()

        for row in source_rows:
            year = row["Date"].split("-")[-1]
            week = row["Week"]
            key = (year, week)
            product = row["Product_id"]
            promotion = row["Promotion_Id"].strip()
            products.add(product)

            calendar.setdefault(key, (row["Date"], row["Month"]))
            if promotion != NO_PROMOTION:
                promo[key][product] = promotion
            price.setdefault((product, promotion), (row["Base_Price"], row["Actual_Price"]))
            demand[(year, week, product)].append(
                int(row["Base_Quantity"]) / (1 + uplift_of(promotion))
            )

        #: (year, week) in file order -> (Date, Month). 104 entries.
        self.calendar = calendar
        #: (year, week) -> {product: promotion_id} for the promoted products only.
        self.promo = dict(promo)
        #: (product, promotion_id) -> (Base_Price, Actual_Price), copied as strings
        #: so the discount depth is inherited rather than re-derived.
        self.price = price
        #: (year, week, product) -> mean uplift-free Normal_Demand across stores.
        self.demand = {k: sum(v) / len(v) for k, v in demand.items()}
        self.products = sorted(products)
        self.weeks = list(calendar)


def jitter(store: str, product: str, year: str, week: str) -> float:
    """Per-store multiplier, deterministic in its inputs.

    Seeded from a hash rather than a global RNG so a row's value depends only on
    its own coordinates -- rerunning, reordering or generating a subset produces
    byte-identical output.
    """
    digest = hashlib.sha256(
        f"{SEED}|{store}|{product}|{year}|{week}".encode()
    ).digest()
    rng = random.Random(int.from_bytes(digest[:8], "big"))
    return rng.gauss(1.0, STORE_JITTER_CV)


def build_rows(ref: Reference) -> list[dict[str, str]]:
    rows: list[dict[str, str]] = []
    for year, week in ref.weeks:
        date, month = ref.calendar[(year, week)]
        promoted = ref.promo.get((year, week), {})
        for store in STORES:
            for product in ref.products:
                promotion = promoted.get(product, NO_PROMOTION)
                base_price_s, actual_price_s = ref.price[(product, promotion)]
                base_price = float(base_price_s)
                actual_price = float(actual_price_s)

                normal_demand = (
                    ref.demand[(year, week, product)]
                    * BASKET_SCALE
                    * jitter(store, product, year, week)
                )
                base_quantity = max(1, int(round(normal_demand * (1 + uplift_of(promotion)))))

                base_revenue = base_quantity * base_price
                actual_revenue = base_quantity * actual_price

                rows.append({
                    "Transaction_Id": f"{CHANNEL}-{year}-W{int(week):02d}-{store}-{product}",
                    "Date": date,
                    "Week": week,
                    "Month": month,
                    "Product_id": product,
                    "Store_Id": store,
                    "Channel_Id": CHANNEL,
                    "Promotion_Id": promotion,
                    "Base_Quantity": str(base_quantity),
                    "Actual_Quantity": str(base_quantity),   # project invariant
                    "Base_Price": base_price_s,
                    "Actual_Price": actual_price_s,
                    "Base_Revenue": _fmt(base_revenue),
                    "Actual_Revenue": _fmt(actual_revenue),
                    "Total_Cost": _fmt(round(MANUFACTURING_COST_RATE * base_revenue)),
                    "Promotion_Cost": (
                        _fmt(round(PROMOTION_COST_RATE * base_revenue))
                        if promotion != NO_PROMOTION else "0"
                    ),
                    "Schedule": SCHEDULE,
                })
    return rows


def main() -> int:
    if not FACT.is_file():
        print(f"missing {FACT}", file=sys.stderr)
        return 1

    destination = Path(sys.argv[1]) if len(sys.argv) > 1 else FACT

    with FACT.open(newline="", encoding="utf-8") as handle:
        reader = csv.DictReader(handle)
        header = reader.fieldnames
        existing = list(reader)

    if header != HEADER:
        print(f"ABORT: unexpected header\n  {header}", file=sys.stderr)
        return 2

    if any(r["Channel_Id"] == CHANNEL for r in existing):
        print(f"ABORT: {CHANNEL} rows already present -- refusing to duplicate.",
              file=sys.stderr)
        return 2

    # The geo dimension must already know these stores, or the fact rows would
    # reference a store that cannot be joined.
    known = {r["Store_Id"] for r in csv.DictReader(GEO.open(newline="", encoding="utf-8"))
             if r["Channel_Id"] == CHANNEL}
    missing = [s for s in STORES if s not in known]
    if missing:
        print(f"ABORT: not {CHANNEL} stores in the geo dimension: {missing}", file=sys.stderr)
        return 2

    source = [r for r in existing if r["Channel_Id"] == SOURCE_CHANNEL]
    bad = [(i, f) for i, r in enumerate(source) if (f := verify_identities(r))]
    if bad:
        print(f"ABORT: {len(bad)} {SOURCE_CHANNEL} rows violate the generator identities.",
              file=sys.stderr)
        for index, failures in bad[:5]:
            print(f"  row {index}: {failures}", file=sys.stderr)
        return 2
    print(f"reference identities verified on all {len(source):,} {SOURCE_CHANNEL} rows")

    ref = Reference(source)
    print(f"reference structure: {len(ref.weeks)} weeks, {len(ref.products)} products, "
          f"{len(ref.promo)} weeks carrying promotions")

    generated = build_rows(ref)

    # Re-verify the identities on what we just built, not just on the input.
    bad = [(i, f) for i, r in enumerate(generated) if (f := verify_identities(r))]
    if bad:
        print(f"ABORT: {len(bad)} generated rows violate the generator identities.",
              file=sys.stderr)
        for index, failures in bad[:5]:
            print(f"  row {index}: {failures}", file=sys.stderr)
        return 3

    ids = Counter(r["Transaction_Id"] for r in generated)
    dupes = [k for k, v in ids.items() if v > 1]
    if dupes:
        print(f"ABORT: {len(dupes)} duplicate Transaction_Ids, e.g. {dupes[:3]}", file=sys.stderr)
        return 3
    clash = ids.keys() & {r["Transaction_Id"] for r in existing}
    if clash:
        print(f"ABORT: {len(clash)} Transaction_Ids collide with existing rows", file=sys.stderr)
        return 3

    expected = len(STORES) * len(ref.products) * len(ref.weeks)
    if len(generated) != expected:
        print(f"ABORT: built {len(generated):,} rows, expected {expected:,}", file=sys.stderr)
        return 3

    # LF, no BOM -- verified against the current file, which carries 205,921 LF
    # and zero CR. (`regenerate_ch001.py` says CRLF; that is stale, and writing
    # CRLF here would rewrite the line ending of every existing row.)
    #
    # The existing rows are copied as BYTES rather than re-serialized, so this
    # cannot alter quoting, spacing or line endings anywhere above the append
    # point no matter what csv module version is in play.
    original = FACT.read_bytes()
    if not original.endswith(b"\n"):
        original += b"\n"

    buffer = io.StringIO(newline="")
    writer = csv.DictWriter(buffer, fieldnames=header, lineterminator="\n")
    writer.writerows(generated)
    appended = buffer.getvalue().encode("utf-8")

    destination.parent.mkdir(parents=True, exist_ok=True)
    destination.write_bytes(original + appended)

    promo_rows = sum(1 for r in generated if r["Promotion_Id"] != NO_PROMOTION)
    src_qty = sum(int(r["Base_Quantity"]) for r in source) / len(source)
    new_qty = sum(int(r["Base_Quantity"]) for r in generated) / len(generated)
    print(f"\n{CHANNEL} rows generated : {len(generated):,}")
    print(f"  stores             : {len(STORES)}  ({', '.join(STORES)})")
    print(f"  promoted rows      : {promo_rows:,} ({promo_rows / len(generated):.1%})")
    print(f"  mean Base_Quantity : {new_qty:.1f}  vs {SOURCE_CHANNEL} {src_qty:.1f} "
          f"(x{new_qty / src_qty:.3f}, target x{BASKET_SCALE})")
    print(f"  file rows          : {len(existing):,} -> {len(existing) + len(generated):,}")
    print(f"written: {destination}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
