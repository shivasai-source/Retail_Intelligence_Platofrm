"""Diagnose the promotion economics in the live fact file. READ-ONLY.

Nothing here writes. It answers one question: which economic driver in the
GENERATED DATA is producing the unrealistic ROI, given that the KPI engine is
frozen and correct.

Every KPI number is produced by importing app.tpo and calling the real engine
(filters.rows_for -> aggregate.calculate_*), so the diagnosis cannot drift from
what the Insights Hub shows. The per-treatment breakdown is computed straight
off the CSV, against the SAME baseline definition the engine uses:

    baseline(product, channel) = mean(Base_Quantity) over Promotion_Id = -1 rows

Usage:  venv/Scripts/python.exe scripts/diagnose_promotion_economics.py
"""

from __future__ import annotations

import csv
import sys
from collections import defaultdict
from pathlib import Path

REPO = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(REPO / "backend"))

from app.tpo import aggregate, filters  # noqa: E402
from app.tpo.filters import FilterState  # noqa: E402

# Honours $TPO_DATA_DIR, so the same diagnosis can be run against a candidate
# dataset before it is ever written to Data/.
from app.tpo import config  # noqa: E402
FACT = config.DATA_DIR / config.FACT_FILE
NO_PROMOTION = "-1"
CHANNELS = ["CH001", "CH002", "CH003", "CH004", "CH005"]
TREATMENTS = ["PR001", "PR002", "PR003", "PS001", "PB001"]


def treatment_of(promotion_id: str) -> str:
    """fact Promotion_Id -> treatment, exactly as scripts/regenerate_ch001.py
    defines it. The seasonal calendar books six ids per year sharing one
    mechanic: the 2024 events are the 20% discount, the 2025 events Buy3Get1."""
    if promotion_id == NO_PROMOTION or promotion_id.startswith("PR"):
        return promotion_id
    if promotion_id.endswith("24"):
        return "PS001"
    if promotion_id.endswith("25"):
        return "PB001"
    raise ValueError("Unmapped Promotion_Id: " + repr(promotion_id))


def load_rows():
    with FACT.open(newline="", encoding="utf-8") as fh:
        return list(csv.DictReader(fh))


def year_of(row):
    return row["Date"].strip()[-4:]


# --- engine-produced KPIs ---------------------------------------------------


def kpis(year, channel):
    state = FilterState.build(year=year, channel=[channel] if channel else None)
    rows = filters.rows_for(state)
    if not rows:
        return {}
    return {
        "trade_spend": aggregate.calculate_trade_spend(rows),
        "incremental_units": aggregate.calculate_incremental_quantity(rows),
        "incremental_sales": aggregate.calculate_incremental_sales(rows),
        "roi": aggregate.calculate_roi(rows),
        "margin": aggregate.calculate_margin(rows),
        "pei": aggregate.calculate_pei(rows),
        "cannibalization": aggregate.calculate_cannibalization(rows),
        "inc_qty_pct": aggregate.calculate_incremental_quantity_percent(rows),
    }


# --- CSV-side economics -----------------------------------------------------


def scope_stats(rows, channel, year):
    """Per-treatment economics for one (channel, year) scope, measured against
    the engine's own per-(product, channel) non-promotional baseline."""
    sel = [
        r for r in rows
        if (channel is None or r["Channel_Id"] == channel)
        and (year is None or year_of(r) == year)
    ]
    if not sel:
        return {}

    base_sum = defaultdict(float)
    base_n = defaultdict(int)
    for r in sel:
        if r["Promotion_Id"].strip() == NO_PROMOTION:
            key = (r["Product_id"], r["Channel_Id"])
            base_sum[key] += float(r["Base_Quantity"])
            base_n[key] += 1
    baseline = {k: base_sum[k] / base_n[k] for k in base_sum if base_n[k]}

    agg = defaultdict(lambda: defaultdict(float))
    promo_rows = 0
    non_promo_rows = 0
    for r in sel:
        pid = r["Promotion_Id"].strip()
        if pid == NO_PROMOTION:
            non_promo_rows += 1
            continue
        promo_rows += 1
        a = agg[treatment_of(pid)]
        bq = float(r["Base_Quantity"])
        bp = float(r["Base_Price"])
        ap = float(r["Actual_Price"])
        br = float(r["Base_Revenue"])
        ar = float(r["Actual_Revenue"])
        pc = float(r["Promotion_Cost"])
        b = baseline.get((r["Product_id"], r["Channel_Id"]))
        a["rows"] += 1
        a["qty"] += bq
        a["base_price_sum"] += bp
        a["actual_price_sum"] += ap
        a["base_revenue"] += br
        a["actual_revenue"] += ar
        a["promotion_cost"] += pc
        a["discount_value"] += br - ar
        a["disc_pct_sum"] += (1 - ap / bp) if bp else 0.0
        if b:
            u = bq / b - 1
            a["baseline_qty"] += b
            a["inc_qty"] += bq - b
            a["inc_sales"] += (bq - b) * ap
            a["uplift_sum"] += u
            a["uplift_n"] += 1
            a["uplift_min"] = min(a["uplift_min"], u) if a["uplift_n"] > 1 else u
            a["uplift_max"] = max(a["uplift_max"], u) if a["uplift_n"] > 1 else u
            if bq < b:
                a["uplift_neg"] += 1

    out = {"promo_rows": promo_rows, "non_promo_rows": non_promo_rows, "treatments": {}}
    for t in TREATMENTS:
        if t not in agg:
            continue
        a = agg[t]
        n = a["rows"]
        un = a["uplift_n"] or 1
        ts = a["discount_value"] + a["promotion_cost"]
        out["treatments"][t] = {
            "rows": int(n),
            "avg_uplift": a["uplift_sum"] / un,
            "min_uplift": a["uplift_min"],
            "max_uplift": a["uplift_max"],
            "neg_uplift_pct": 100 * a["uplift_neg"] / un,
            "avg_discount": a["disc_pct_sum"] / n,
            "avg_base_price": a["base_price_sum"] / n,
            "avg_actual_price": a["actual_price_sum"] / n,
            "base_revenue": a["base_revenue"],
            "promotion_cost": a["promotion_cost"],
            "pc_over_br": a["promotion_cost"] / a["base_revenue"] if a["base_revenue"] else 0.0,
            "discount_value": a["discount_value"],
            "trade_spend": ts,
            "inc_units": a["inc_qty"],
            "inc_sales": a["inc_sales"],
            "roi": (a["inc_sales"] / ts) if ts else 0.0,
            "ts_per_txn": ts / n,
            "is_per_txn": a["inc_sales"] / n,
        }
    return out


def money(v):
    if v is None:
        return "         -"
    if abs(v) >= 1e7:
        return "{:8.2f}Cr".format(v / 1e7)
    return "{:8.2f}L ".format(v / 1e5)


def pct(v):
    return "     -" if v is None else "{:6.1f}".format(v)


def mult(v):
    """An ROI multiple, one decimal, in the same 6-wide slot as `pct`."""
    return "     -" if v is None else "{:5.1f}".format(v)


def main():
    rows = load_rows()
    print("fact rows: {:,}\n".format(len(rows)))

    print("=" * 106)
    print("A. ENGINE KPIs BY SCOPE  (app.tpo.aggregate - the frozen formulas)")
    print("=" * 106)
    print("{:<12}{:>18}{:>12}{:>13}{:>12}{:>8}{:>9}{:>6}{:>9}".format(
        "scope", "promo/non rows", "TradeSpend", "Inc Units", "Inc Sales",
        "ROI x", "Margin%", "PEI", "Cannib%"))
    print("-" * 106)
    for ch in [None] + CHANNELS:
        for yr in (2024, 2025, None):
            k = kpis(yr, ch)
            if not k:
                continue
            s = scope_stats(rows, ch, str(yr) if yr else None)
            tag = "F24" if yr == 2024 else "F25" if yr == 2025 else "ALL"
            label = "{:<6}{:>4}".format(ch or "ALL", tag)
            print("{:<12}{:>8,}/{:<9,}{:>12}{:>13,.0f}{:>12}{:>8}{:>9}{:>6.0f}{:>9}".format(
                label, s["promo_rows"], s["non_promo_rows"],
                money(k["trade_spend"]), k["incremental_units"],
                money(k["incremental_sales"]), mult(k["roi"]), pct(k["margin"]),
                k["pei"] or 0, pct(k["cannibalization"])))
        print()

    print("=" * 118)
    print("B. ECONOMICS BY TREATMENT  (ALL CHANNELS)")
    print("=" * 118)
    for yr in ("2024", "2025", None):
        s = scope_stats(rows, None, yr)
        if not s or not s["treatments"]:
            continue
        tag = "F24" if yr == "2024" else "F25" if yr == "2025" else "ALL YEARS"
        print("\n--- {} ---".format(tag))
        print("{:<7}{:>8}{:>11}{:>8}{:>8}{:>7}{:>7}{:>8}{:>8}{:>7}{:>12}{:>12}{:>9}{:>9}{:>10}".format(
            "treat", "rows", "uplift avg", "min", "max", "neg%", "disc",
            "basePx", "actPx", "PC/BR", "TradeSpend", "IncSales", "ROI x",
            "TS/txn", "IS/txn"))
        print("-" * 118)
        for t, d in s["treatments"].items():
            print("{:<7}{:>8,}{:>10.1f}%{:>7.0f}%{:>7.0f}%{:>6.1f}%{:>6.1f}%"
                  "{:>8.0f}{:>8.0f}{:>6.2f}%{:>12}{:>12}{:>8.1f}{:>9,.0f}{:>10,.0f}".format(
                      t, d["rows"], d["avg_uplift"] * 100, d["min_uplift"] * 100,
                      d["max_uplift"] * 100, d["neg_uplift_pct"], d["avg_discount"] * 100,
                      d["avg_base_price"], d["avg_actual_price"], d["pc_over_br"] * 100,
                      money(d["trade_spend"]), money(d["inc_sales"]), d["roi"],
                      d["ts_per_txn"], d["is_per_txn"]))

    print("\n" + "=" * 118)
    print("C. TREATMENT x CHANNEL x YEAR   cells are:  uplift% / discount% / ROI x")
    print("=" * 118)
    print("{:<12}".format("scope") + "".join("{:>21}".format(t) for t in TREATMENTS))
    print("-" * 118)
    for ch in CHANNELS:
        for yr in ("2024", "2025"):
            s = scope_stats(rows, ch, yr)
            cells = []
            for t in TREATMENTS:
                d = s["treatments"].get(t)
                if not d:
                    cells.append("{:>21}".format("-"))
                else:
                    cells.append("{:>7.0f}%{:>5.0f}%{:>8.1f}".format(
                        d["avg_uplift"] * 100, d["avg_discount"] * 100, d["roi"]))
            tag = "F24" if yr == "2024" else "F25"
            print("{:<12}".format(ch + "/" + tag) + "".join(cells))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
