"""Future ad plans for the MMM Revenue Forecast: 1 to 5 years after the data.

Writes Data/mmm/future/mmm_future_{1..5}y.csv -- the installed dataset's
columns without Revenue, one row per day from the day after its last date.

HOW A FUTURE DAY IS MADE: every future ISO week copies the same week of the
year from one of the last RECENT_YEARS whole years in the data, day by day
(Monday to Monday), so the plan keeps the data's own patterns: which channels
run, the on / off runs of ad days and dark days, festival, seasonal and
promotion days and their discounts. Each channel's spend in a copied week is
then scaled by GROWTH a year (compounded) and a random factor around 1.
The five files are prefixes of one five-year plan, so they agree where they
overlap. Seeded: the same data always gives the same files.

    python scripts/make_mmm_future.py
"""

from __future__ import annotations

from pathlib import Path

import numpy as np
import pandas as pd

ROOT = Path(__file__).resolve().parents[1]
SOURCE = ROOT / "Data" / "mmm" / "mmm_daily.csv"
OUT = ROOT / "Data" / "mmm" / "future"
#: Whole years the weeks are copied from.
RECENT_YEARS = 4
#: Yearly growth of ad spend.
GROWTH = 0.03
#: Spread of the per-week, per-channel spend factor.
NOISE = 0.12
SEED = 11
#: Calendar columns the file carries after the flags.
CALENDAR = ("Month", "Quarter", "Week_of_Year", "Year")


def main() -> None:
    frame = pd.read_csv(SOURCE, encoding="utf-8-sig")
    frame["Date"] = pd.to_datetime(frame["Date"], format="%d-%m-%Y")
    frame = frame.sort_values("Date").reset_index(drop=True)
    spend_cols = [c for c in frame.columns if c.endswith("_Spend")]
    last = frame["Date"].max()
    whole_years = [y for y in sorted(frame["Date"].dt.year.unique()) if (frame["Date"].dt.year == y).sum() >= 365]
    years = whole_years[-RECENT_YEARS:]
    by_day = frame.set_index("Date")

    rng = np.random.default_rng(SEED)
    dates = pd.date_range(last + pd.Timedelta(days=1), periods=5 * 365 + 1, freq="D")
    rows = []
    week_pick: dict[tuple[int, int], tuple[int, np.ndarray]] = {}
    for d in dates:
        iso = d.isocalendar()
        key = (iso.year, iso.week)
        if key not in week_pick:
            week_pick[key] = (int(rng.choice(years)), rng.lognormal(0.0, NOISE, len(spend_cols)))
        src_year, factor = week_pick[key]
        # The same ISO week and weekday in the source year (week 53 falls back to 52).
        week = min(iso.week, 52)
        src = pd.Timestamp.fromisocalendar(src_year, week, iso.weekday)
        if src not in by_day.index:
            src = by_day.index[by_day.index.dayofyear == min(d.dayofyear, 365)][-1]
        row = by_day.loc[src]
        growth = (1 + GROWTH) ** ((d - last).days / 365.25)
        out = {"Date": d.strftime("%d-%m-%Y")}
        for j, c in enumerate(spend_cols):
            out[c] = int(round(float(row[c]) * factor[j] * growth))
        for c in ("Festival_Flag", "Seasonal_Flag", "Promotion_Flag", "Discount_Percentage", "Promotion_Type"):
            if c in frame.columns:
                out[c] = row[c]
        out.update({"Month": d.month, "Quarter": f"Q{(d.month - 1) // 3 + 1}", "Week_of_Year": iso.week, "Year": d.year})
        rows.append(out)

    plan = pd.DataFrame(rows)
    plan = plan[[c for c in frame.columns if c != "Revenue" and c in plan.columns]]
    OUT.mkdir(parents=True, exist_ok=True)
    for n in range(1, 6):
        end = last + pd.DateOffset(years=n)
        part = plan[pd.to_datetime(plan["Date"], format="%d-%m-%Y") <= end]
        path = OUT / f"mmm_future_{n}y.csv"
        part.to_csv(path, index=False, lineterminator="\n")
        spend = part[spend_cols].sum(axis=1)
        print(f"{path.name}: {len(part)} days, {part['Date'].iloc[0]} - {part['Date'].iloc[-1]}, "
              f"ad spend Rs {spend.sum() / 1e7:,.2f} Cr, {int((spend == 0).sum())} days without ads")


if __name__ == "__main__":
    main()
