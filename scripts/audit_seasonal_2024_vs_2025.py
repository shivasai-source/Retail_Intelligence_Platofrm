"""Seasonal promotion audit: 2024 vs 2025, and the root cause of sub-break-even PB001 ROI.

READ-ONLY. Writes nothing.

Every ROI comes from the frozen engine (aggregate.roi_multiple) via
calculate_roi(rows_for(state), baseline_rows_for(state)) -- the same call the
Offer breakdown makes, so the numbers here are the numbers the Command Center
shows. The per-row economics are read straight from the CSV.

Usage:  venv/Scripts/python.exe scripts/audit_seasonal_2024_vs_2025.py
"""

from __future__ import annotations

import csv
import sys
from collections import Counter, defaultdict
from pathlib import Path

REPO = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(REPO / "backend"))

from app.tpo import aggregate as A  # noqa: E402
from app.tpo import config, filters, loader  # noqa: E402
from app.tpo.filters import FilterState  # noqa: E402

FACT = config.DATA_DIR / config.FACT_FILE
NP = "-1"
CHANNELS = ["CH001", "CH002", "CH003", "CH004", "CH005"]

#: The six seasonal events, paired across years.
EVENTS = [
    ("New Year",     "PBNY24", "PBNY25"),
    ("Holi",         "PBHO24", "PBHO25"),
    ("Summer",       "PBSU24", "PBSU25"),
    ("Independence", "PBIN24", "PBIN25"),
    ("Dussehra",     "PBDU24", "PBDU25"),
    ("Diwali",       "PBDI24", "PBDI25"),
]

PROMOTION_COST_RATE = 0.03


def breakeven_uplift(d: float, c: float) -> float:
    """u* where ROI == 1.0 (break-even), for price discount d and promotion-cost rate c.

        ROI = u(1-d) / ((1+u)(d+c))  =>  ROI = 1 at  u* = (d+c) / (1 - c - 2d)
    """
    return (d + c) / (1 - c - 2 * d)


def load():
    return list(csv.DictReader(FACT.open(newline="", encoding="utf-8")))


def engine(year: int | None, promo: list[str] | None = None, channel: list[str] | None = None):
    st = FilterState.build(year=year, promotion=promo, channel=channel)
    rows = filters.rows_for(st)
    vol = filters.baseline_rows_for(st)
    if not rows:
        return None
    return {
        "ts": A.calculate_trade_spend(rows),
        "iu": A.calculate_incremental_quantity(vol),
        "is": A.calculate_incremental_sales(vol),
        "roi": A.calculate_roi(rows, vol),
        "mi": A.calculate_margin(rows),
    }


def csv_stats(rows, pid: str, year: str):
    """Row-level economics for one promotion, against the engine's own
    per-(product, channel) non-promotional baseline within that year."""
    yr_rows = [r for r in rows if r["Date"].strip()[-4:] == year]
    bs, bn = defaultdict(float), Counter()
    for r in yr_rows:
        if r["Promotion_Id"].strip() == NP:
            k = (r["Product_id"], r["Channel_Id"])
            bs[k] += float(r["Base_Quantity"])
            bn[k] += 1
    base = {k: bs[k] / bn[k] for k in bs}

    sel = [r for r in yr_rows if r["Promotion_Id"].strip() == pid]
    if not sel:
        return None
    a = defaultdict(float)
    stores, products, weeks, chans = set(), set(), set(), set()
    for r in sel:
        b = base.get((r["Product_id"], r["Channel_Id"]))
        bq = float(r["Base_Quantity"])
        bp, ap = float(r["Base_Price"]), float(r["Actual_Price"])
        a["rows"] += 1
        a["qty"] += bq
        a["bp"] += bp
        a["ap"] += ap
        a["br"] += float(r["Base_Revenue"])
        a["ar"] += float(r["Actual_Revenue"])
        a["pc"] += float(r["Promotion_Cost"])
        a["disc"] += 1 - ap / bp
        if b:
            a["base_units"] += b
            a["inc_units"] += bq - b
            a["inc_sales"] += (bq - b) * ap
            a["u"] += bq / b - 1
            a["un"] += 1
        stores.add(r["Store_Id"])
        products.add(r["Product_id"])
        weeks.add(r["Week"])
        chans.add(r["Channel_Id"])
    n, un = a["rows"], a["un"] or 1
    return {
        "rows": int(n), "stores": len(stores), "products": len(products),
        "weeks": len(weeks), "channels": len(chans),
        "base_units": a["base_units"] / un, "actual_units": a["qty"] / n,
        "inc_units": a["inc_units"], "uplift": a["u"] / un,
        "base_price": a["bp"] / n, "actual_price": a["ap"] / n,
        "discount": a["disc"] / n,
        "base_rev": a["br"], "actual_rev": a["ar"], "promo_cost": a["pc"],
        "trade_spend": a["br"] - a["ar"] + a["pc"],
        "inc_sales": a["inc_sales"],
    }


def cr(v):
    return "   -" if v is None else f"{v/1e7:6.2f}"


def main() -> int:
    rows = load()
    store = loader.get_store()
    print("# SEASONAL AUDIT -- 2024 vs 2025\n")

    # ------------------------------------------------------ PHASE 1
    print("## PHASE 1 -- 2025 seasonal promotions, full decomposition")
    for _, _, p25 in EVENTS:
        s = csv_stats(rows, p25, "2025")
        e = engine(2025, [p25])
        promo = store.dims.promotions.get(p25)
        print(f"\n  {p25}  {promo.name}  |  {(promo.description or '').strip()}")
        print(f"    rows {s['rows']:,}   stores {s['stores']}   products {s['products']}"
              f"   weeks {s['weeks']}   channels {s['channels']}")
        print(f"    Baseline units/row {s['base_units']:8.1f}     Actual units/row {s['actual_units']:8.1f}"
              f"     uplift {100*s['uplift']:6.2f}%")
        print(f"    Base Price {s['base_price']:8.1f}          Actual Price {s['actual_price']:8.1f}"
              f"        direct discount {100*s['discount']:5.2f}%")
        print(f"    Base Revenue   {cr(s['base_rev'])}Cr   Actual Revenue {cr(s['actual_rev'])}Cr"
              f"   Promotion Cost {cr(s['promo_cost'])}Cr ({100*s['promo_cost']/s['base_rev']:.2f}% of BR)")
        print(f"    Trade Spend = BR - AR + PC = {cr(s['base_rev'])} - {cr(s['actual_rev'])}"
              f" + {cr(s['promo_cost'])} = {cr(s['trade_spend'])}Cr   [engine {cr(e['ts'])}Cr]")
        print(f"    Incremental Units {e['iu']:>10,.0f}     Incremental Sales {cr(e['is'])}Cr")
        print(f"    ROI = IS / TS = {cr(e['is'])} / {cr(e['ts'])}"
              f" = {e['roi']:6.1f}")

    # ------------------------------------------------------ PHASE 2
    print("\n\n## PHASE 2 -- economic driver, PB001 2025 vs PS001 2024")
    print("  Break-even uplift u* = (d + c) / (1 - c - 2d)\n")
    print(f"  {'':<26}{'2024 seasonal':>18}{'2025 seasonal':>18}")
    print("  " + "-" * 62)
    s24 = [csv_stats(rows, p, "2024") for _, p, _ in EVENTS]
    s25 = [csv_stats(rows, p, "2025") for _, _, p in EVENTS]
    agg24 = {k: sum(x[k] for x in s24) for k in ("rows", "base_rev", "actual_rev", "promo_cost")}
    agg25 = {k: sum(x[k] for x in s25) for k in ("rows", "base_rev", "actual_rev", "promo_cost")}
    d24 = sum(x["discount"] * x["rows"] for x in s24) / agg24["rows"]
    d25 = sum(x["discount"] * x["rows"] for x in s25) / agg25["rows"]
    u24 = sum(x["uplift"] * x["rows"] for x in s24) / agg24["rows"]
    u25 = sum(x["uplift"] * x["rows"] for x in s25) / agg25["rows"]
    c24 = agg24["promo_cost"] / agg24["base_rev"]
    c25 = agg25["promo_cost"] / agg25["base_rev"]
    line = lambda lbl, a, b: print(f"  {lbl:<26}{a:>18}{b:>18}")
    line("mechanic", "20% price cut", "Buy3Get1")
    line("direct price discount", f"{100*d24:.2f}%", f"{100*d25:.2f}%")
    line("promotion cost / BaseRev", f"{100*c24:.2f}%", f"{100*c25:.2f}%")
    line("total investment rate", f"{100*(d24+c24):.2f}%", f"{100*(d25+c25):.2f}%")
    line("measured uplift", f"{100*u24:.1f}%", f"{100*u25:.1f}%")
    line("approved uplift band", "55-65%", "60-72%")
    line("break-even uplift u*", f"{100*breakeven_uplift(d24, c24):.1f}%",
         f"{100*breakeven_uplift(d25, c25):.1f}%")
    line("headroom (band floor - u*)", f"{100*0.55 - 100*breakeven_uplift(d24, c24):+.1f}pp",
         f"{100*0.60 - 100*breakeven_uplift(d25, c25):+.1f}pp")

    # ------------------------------------------------------ PHASE 3
    print("\n\n## PHASE 3 -- matched event comparison")
    print(f"  {'Event':<14}{'2024 ROI':>10}{'2025 ROI':>10}{'d ROI':>9}"
          f"{'24 IncSales':>13}{'25 IncSales':>13}{'24 TS':>9}{'25 TS':>9}"
          f"{'24 upl':>8}{'25 upl':>8}{'24 rows':>9}{'25 rows':>9}")
    print("  " + "-" * 122)
    for name, p24, p25 in EVENTS:
        e24, e25 = engine(2024, [p24]), engine(2025, [p25])
        a24, a25 = csv_stats(rows, p24, "2024"), csv_stats(rows, p25, "2025")
        print(f"  {name:<14}{e24['roi']:>9.1f}{e25['roi']:>9.1f}{e25['roi']-e24['roi']:>+8.1f}"
              f"{cr(e24['is']):>12}Cr{cr(e25['is']):>12}Cr{cr(e24['ts']):>8}{cr(e25['ts']):>8}"
              f"{100*a24['uplift']:>7.1f}%{100*a25['uplift']:>7.1f}%{a24['rows']:>9,}{a25['rows']:>9,}")

    print("\n  Seasonal totals:")
    for yr, pids in ((2024, [p for _, p, _ in EVENTS]), (2025, [p for _, _, p in EVENTS])):
        e = engine(yr, pids)
        print(f"    {yr}  ROI {e['roi']:6.1f}   IncUnits {e['iu']:>10,.0f}   "
              f"IncSales {cr(e['is'])}Cr   TradeSpend {cr(e['ts'])}Cr   Margin {e['mi']:.1f}%")

    print("\n  Seasonal ROI by channel:")
    print(f"  {'channel':<10}" + "".join(f"{n:>16}" for n, _, _ in EVENTS))
    for ch in CHANNELS:
        cells = []
        for _, p24, p25 in EVENTS:
            a = engine(2024, [p24], [ch])
            b = engine(2025, [p25], [ch])
            cells.append(f"{a['roi'] if a else 0:>7.1f}/{b['roi'] if b else 0:>7.1f}")
        print(f"  {ch:<10}" + "".join(f"{c:>16}" for c in cells))
    print("  (cells are 2024 ROI / 2025 ROI)")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
