"""FINAL ROI REALISM AUDIT. READ-ONLY -- this script writes nothing.

Every ROI is produced by the frozen engine (app.tpo.aggregate.roi_multiple), at
the same grain the Insights Hub uses:

  * headline / channel scopes -> aggregate.calculate_roi(rows, volume_rows)
  * per promotion             -> the same, with an Offer filter, so the
                                 baseline widening matches the Offer breakdown
  * per event                 -> service.promotion_events(), i.e.
                                 (product, channel, week, promotion)

The break-even algebra used in section 5 is derived, not fitted. With
Base_Quantity == Actual_Quantity == b(1+u), a price discount d and a promotion
cost rate c on Base_Revenue:

    Incremental Sales = b.u.P.(1-d)
    Trade Spend       = b.(1+u).P.(d+c)
    ROI               = u(1-d) / ((1+u)(d+c))        (a multiple; 1.0 = break-even)

    ROI = 1  <=>  u* = (d + c) / (1 - c - 2d)

Usage:  venv/Scripts/python.exe scripts/audit_roi_realism.py
"""

from __future__ import annotations

import csv
import sys
from collections import Counter, defaultdict
from pathlib import Path

REPO = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(REPO / "backend"))

from app.tpo import aggregate as A  # noqa: E402
from app.tpo import config, filters, loader, service  # noqa: E402
from app.tpo.filters import FilterState  # noqa: E402

FACT = config.DATA_DIR / config.FACT_FILE
NO_PROMOTION = "-1"
CHANNELS = ["CH001", "CH002", "CH003", "CH004", "CH005"]

#: The approved rules and the break-even algebra now live in app/tpo/config.py
#: so that application code has a source of truth that is not a script. Values
#: and arithmetic are unchanged by the move; this script reads them back.
PROMOTION_COST_RATE = config.PROMOTION_COST_RATE
TREATMENT_RULES = config.TREATMENT_RULES
breakeven_uplift = config.breakeven_uplift


def treatment_of(pid: str) -> str:
    if pid == NO_PROMOTION or pid.startswith("PR"):
        return pid
    return "PS001" if pid.endswith("24") else "PB001"


def roi_for(state: FilterState) -> float | None:
    return A.calculate_roi(filters.rows_for(state), filters.baseline_rows_for(state))


def scope(state: FilterState) -> dict:
    rows = filters.rows_for(state)
    vol = filters.baseline_rows_for(state)
    if not rows:
        return {}
    return {
        "ts": A.calculate_trade_spend(rows),
        "iu": A.calculate_incremental_quantity(vol),
        "is": A.calculate_incremental_sales(vol),
        "roi": A.calculate_roi(rows, vol),
    }


def cr(v) -> str:
    return "     -" if v is None else f"{v/1e7:6.2f}"


def main() -> int:
    rows = list(csv.DictReader(FACT.open(newline="", encoding="utf-8")))
    store = loader.get_store()

    print("# FINAL ROI REALISM AUDIT\n")

    # ---------------------------------------------------------------- 1
    print("## 1. Overall ROI")
    overall = {}
    for yr, tag in ((2024, "F24"), (2025, "F25"), (None, "ALL")):
        s = scope(FilterState.build(year=yr))
        overall[tag] = s
        flag = "OK" if s["roi"] <= 1.5 else "OVER 1.5"
        print(f"  {tag}  ROI {s['roi']:6.1f}   TradeSpend {cr(s['ts'])}Cr   "
              f"IncSales {cr(s['is'])}Cr   IncUnits {s['iu']:>10,.0f}   [{flag}]")

    # ---------------------------------------------------------------- 2
    print("\n## 2. Channel x Year ROI")
    print(f"  {'scope':<12}{'TradeSpend Cr':>15}{'IncUnits':>13}{'IncSales Cr':>14}{'ROI x':>9}   flag")
    print("  " + "-" * 68)
    for ch in CHANNELS:
        for yr, tag in ((2024, "F24"), (2025, "F25")):
            s = scope(FilterState.build(year=yr, channel=[ch]))
            flag = "OK" if s["roi"] <= 1.5 else "OVER 1.5"
            print(f"  {ch + ' ' + tag:<12}{cr(s['ts']):>15}{s['iu']:>13,.0f}"
                  f"{cr(s['is']):>14}{s['roi']:>9.1f}   {flag}")

    # ---------------------------------------------------------------- 3
    print("\n## 3. Promotion-level ROI")
    # CSV-side economics per Promotion_Id, per year, against the engine baseline.
    per_year_stats: dict[tuple[str, str], dict] = {}
    for yr in ("2024", "2025"):
        bs, bn = defaultdict(float), Counter()
        for r in rows:
            if r["Date"].strip()[-4:] == yr and r["Promotion_Id"].strip() == NO_PROMOTION:
                k = (r["Product_id"], r["Channel_Id"])
                bs[k] += float(r["Base_Quantity"])
                bn[k] += 1
        base = {k: bs[k] / bn[k] for k in bs}
        acc = defaultdict(lambda: defaultdict(float))
        for r in rows:
            pid = r["Promotion_Id"].strip()
            if pid == NO_PROMOTION or r["Date"].strip()[-4:] != yr:
                continue
            b = base.get((r["Product_id"], r["Channel_Id"]))
            a = acc[pid]
            bq = float(r["Base_Quantity"])
            bp, ap = float(r["Base_Price"]), float(r["Actual_Price"])
            a["rows"] += 1
            a["qty"] += bq
            a["disc"] += 1 - ap / bp
            a["pc"] += float(r["Promotion_Cost"])
            a["br"] += float(r["Base_Revenue"])
            if b:
                a["base_units"] += b
                a["u"] += bq / b - 1
                a["un"] += 1
        for pid, a in acc.items():
            per_year_stats[(pid, yr)] = a

    print(f"  {'Promotion':<26}{'yr':>5}{'events':>8}{'TS Cr':>8}{'IncU':>11}{'IS Cr':>8}"
          f"{'ROI x':>9}{'baseU':>8}{'actU':>8}{'uplift':>8}{'disc':>7}{'PC/BR':>7}")
    print("  " + "-" * 118)
    negative_promos = []
    over50_promos = []
    for yr, ytag in (("2024", 2024), ("2025", 2025)):
        for pid in sorted({r["Promotion_Id"].strip() for r in rows
                           if r["Promotion_Id"].strip() != NO_PROMOTION
                           and r["Date"].strip()[-4:] == yr}):
            a = per_year_stats.get((pid, yr))
            if not a:
                continue
            st = FilterState.build(year=ytag, promotion=[pid])
            s = scope(st)
            promo = store.dims.promotions.get(pid)
            label = (promo.description or promo.name).strip() if promo else pid
            n = a["rows"]
            un = a["un"] or 1
            roi = s["roi"]
            row = (f"  {(pid + ' ' + label)[:25]:<26}{yr[-2:]:>5}{int(n):>8,}{cr(s['ts']):>8}"
                   f"{s['iu']:>11,.0f}{cr(s['is']):>8}{roi:>9.1f}"
                   f"{a['base_units']/un:>8.0f}{a['qty']/n:>8.0f}"
                   f"{100*a['u']/un:>7.1f}%{100*a['disc']/n:>6.1f}%{100*a['pc']/a['br']:>6.2f}%")
            print(row + ("   <-- BELOW 1.0" if roi < 1 else "   <-- >1.5" if roi > 1.5 else ""))
            if roi < 1:
                negative_promos.append((pid, yr, label, roi, 100 * a["u"] / un, 100 * a["disc"] / n))
            if roi > 1.5:
                over50_promos.append((pid, yr, label, roi, 100 * a["u"] / un))

    # ---------------------------------------------------------------- 4
    print("\n## 4. Below break-even (ROI < 1.0) -- event level")
    events = service.promotion_events(FilterState.build())
    by_treatment = defaultdict(lambda: {"n": 0, "neg": 0, "rois": []})
    for e in events:
        if e.roi_multiple is None:
            continue
        t = treatment_of(e.promotion_id)
        g = by_treatment[t]
        g["n"] += 1
        g["rois"].append(e.roi_multiple)
        if e.roi_multiple < 1:
            g["neg"] += 1
    print(f"  {'treatment':<12}{'events':>9}{'below 1':>10}{'neg %':>8}"
          f"{'min ROI':>10}{'median':>9}{'max ROI':>10}")
    print("  " + "-" * 68)
    for t in ["PR001", "PR002", "PR003", "PS001", "PB001"]:
        g = by_treatment.get(t)
        if not g:
            continue
        rs = sorted(g["rois"])
        med = rs[len(rs) // 2]
        print(f"  {t:<12}{g['n']:>9,}{g['neg']:>10,}{100*g['neg']/g['n']:>7.1f}%"
              f"{rs[0]:>10.1f}{med:>9.1f}{rs[-1]:>10.1f}")

    print("\n  Worst 12 events by ROI:")
    worst = sorted((e for e in events if e.roi_multiple is not None), key=lambda e: e.roi_multiple)[:12]
    for e in worst:
        print(f"    {e.roi_multiple:>7.1f}  {e.promotion_name[:26]:<27}{e.channel_name[:16]:<17}"
              f"{e.product_name.strip()[:30]:<31}{e.week_key}")

    # ---------------------------------------------------------------- 5
    print("\n## 5. Break-even uplift implied by the approved rules")
    print("  ROI = 1.0 when realized uplift u* = (d + 0.03) / (1 - 0.03 - 2d)")
    print(f"  {'treatment':<12}{'discount':>10}{'u* (ROI=1)':>13}{'approved band':>17}"
          f"{'headroom':>11}{'measured':>11}")
    print("  " + "-" * 76)
    measured_uplift = {}
    for t in ["PR001", "PR002", "PR003", "PS001", "PB001"]:
        tot, cnt = 0.0, 0
        for yr in ("2024", "2025"):
            for (pid, y), a in per_year_stats.items():
                if y == yr and treatment_of(pid) == t:
                    tot += a["u"]
                    cnt += a["un"]
        measured_uplift[t] = 100 * tot / cnt if cnt else 0.0
    for t, (d, lo, hi) in TREATMENT_RULES.items():
        u = breakeven_uplift(d)
        head = (lo - u) * 100
        print(f"  {t:<12}{d*100:>9.0f}%{u*100:>12.1f}%{f'{lo*100:.0f}-{hi*100:.0f}%':>17}"
              f"{head:>+10.1f}pp{measured_uplift[t]:>10.1f}%"
              + ("   <-- NO MARGIN" if head < 2 else ""))

    # ---------------------------------------------------------------- 6
    print("\n## 6. Data-integrity probes on the below-break-even population")
    pb = [r for r in rows if treatment_of(r["Promotion_Id"].strip()) == "PB001"]
    ratios = {round(float(r["Actual_Price"]) / float(r["Base_Price"]), 3) for r in pb}
    pcr = {round(float(r["Promotion_Cost"]) / float(r["Base_Revenue"]), 3) for r in pb}
    qty_ok = all(float(r["Base_Quantity"]) == float(r["Actual_Quantity"]) for r in pb)
    rev_ok = all(abs(float(r["Actual_Revenue"]) - float(r["Actual_Quantity"]) * float(r["Actual_Price"])) < 0.51
                 for r in pb)
    dupes = [k for k, v in Counter(r["Transaction_Id"] for r in rows).items() if v > 1]
    print(f"  PB001 rows                     : {len(pb):,}")
    print(f"  PB001 Actual_Price/Base_Price  : {sorted(ratios)}  (expect ~0.75)")
    print(f"  PB001 Promotion_Cost/Base_Rev  : {sorted(pcr)}  (expect 0.03)")
    print(f"  PB001 Base_Quantity==Actual    : {qty_ok}")
    print(f"  PB001 Actual_Rev == Aq x Ap    : {rev_ok}")
    print(f"  duplicate Transaction_Id       : {len(dupes)}")
    weeks = defaultdict(set)
    for r in pb:
        weeks[r["Promotion_Id"].strip()].add((r["Date"].strip()[-4:], r["Week"]))
    print(f"  PB001 promotions x weeks       : "
          + ", ".join(f"{k}:{len(v)}w" for k, v in sorted(weeks.items())))

    print("\n  Uplift distribution of PB001 events (the negative ones are the tail):")
    buckets = Counter()
    for yr in ("2024", "2025"):
        bs, bn = defaultdict(float), Counter()
        for r in rows:
            if r["Date"].strip()[-4:] == yr and r["Promotion_Id"].strip() == NO_PROMOTION:
                k = (r["Product_id"], r["Channel_Id"])
                bs[k] += float(r["Base_Quantity"])
                bn[k] += 1
        base = {k: bs[k] / bn[k] for k in bs}
        for r in rows:
            pid = r["Promotion_Id"].strip()
            if treatment_of(pid) != "PB001" or r["Date"].strip()[-4:] != yr:
                continue
            b = base.get((r["Product_id"], r["Channel_Id"]))
            if not b:
                continue
            u = float(r["Base_Quantity"]) / b - 1
            buckets[min(int(u * 10) * 10, 150)] += 1
    ustar = breakeven_uplift(0.25) * 100
    for k in sorted(buckets):
        mark = "  <-- below break-even" if k + 10 <= ustar else ""
        print(f"    uplift {k:>4}-{k+10:<4}%  {buckets[k]:>6,} rows{mark}")
    print(f"    break-even uplift for PB001 = {ustar:.1f}%")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
