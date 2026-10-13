"""Build the final TPO dataset from the committed source files.

Reads the six CSVs as committed at a git revision (default HEAD), so a rerun
always starts from the same inputs and never compounds on its own output, and
writes the cleaned set to --out.

WHAT THE FINAL SET HOLDS
------------------------
fact_sales keeps only what a source system records -- Date, Product_id,
Store_Id, Promotion_Id, Base_Quantity, Actual_Quantity, Base_Price,
Actual_Price, Total_Cost, Promotion_Cost. Week, Month and channel come from
the dimensions, both revenues from units x price (see app/tpo/loader.py).

WHAT CHANGES, AND WHY
---------------------
1. Promotional response is HETEROGENEOUS. The source drew every uplift from one
   narrow band, so ROI came out 1.35-1.42x in every region and only 2.5 % of
   promotions lost money. Here the uplift of a promoted row is

       u = LIFT_AT_10PCT (d / 0.10)^CONVEXITY x SCALE x channel x region
           x tier[mechanic] x brand[month] x event x retailer x fatigue^(week-1) x noise

   -- a response that grows with the discount depth d (slightly faster than in
   proportion: a deep "big deal" pulls stock-up buying a shallow one does not),
   shifted by where and what is promoted. Calibrated so that, at a 50 % gross
   margin, about half of all promotion events lose money while the programme
   as a whole makes a modest profit -- what retail trade-promotion studies
   report. Every multiplier is a stated assumption below, not a fit; the
   per-run noise makes some cells fail outright, as real promotions do.
   Offer depths and the price rule round(list x (1 - depth)) are the source's.

1a. The CALENDAR is re-dated and thinned. Festival offers sit in the week of
   the gazetted festival day (FESTIVALS) -- or, in a channel that books whole
   months (Modern Trade, B2B), in the month leading into it -- instead of where
   the source put them, which had Modern Trade running Dussehra and Diwali 2025
   side by side across the same four weeks. Regular offers are thinned to at
   most MAX_PROMO_SHARE of a product-store's weeks with MIN_GAP_WEEKS between
   offers; the source promoted some packs every other week. Where offers last
   a month (Modern Trade, B2B) regular offers are planned instead: one month in
   MONTH_GRAIN_CYCLE per product, staggered across the range, at the month's
   rotation offer, clear of the product's festival months.

1b. CANNIBALIZATION is real: a promoted pack takes a brand-specific share of
   its extra units from the pack sizes either side of it that week.

2. Base_Quantity is the expected units WITHOUT the promotion: Actual on a
   non-promoted row; on a promoted row the mean of the nearest non-promoted
   weeks of the same product-store, up to BASE_WINDOW either side.

3. Cough & Cold carries a winter season (it had the same curve as detergent).

4. Total_Cost = units x standard unit cost, round(0.50 x list price), in every
   channel -- a 50 % gross margin, typical of branded home, baby and oral care. The source used three rounding bases and booked General Trade at
   35 % of list -- half every other channel's cost for the same product.
   Promotion_Cost = round(0.03 x units x list price) on promoted rows.

5. Dimension hygiene: P21-68ct (a 98 ct pack) becomes P21-98ct; stray and
   doubled spaces go; the literal "null" becomes blank; dim_product drops
   `Cost` (it was the list price, which the fact carries); stores that never
   trade and promotions that never run are dropped; dim_date's 29-31 Dec are
   week 53 of their own year, not week 1.

Usage: venv/Scripts/python.exe scripts/build_final_dataset.py --out Data [--rev HEAD]
"""

from __future__ import annotations

import argparse
import hashlib
import io
import re
import subprocess
from pathlib import Path

import numpy as np
import pandas as pd

ROOT = Path(__file__).resolve().parents[1]
FACT = "fact_sales_2024_2025_all_channels.csv"
DIMS = {
    "product": "dim_product_reordered.csv",
    "store": "dim_geo_store_final.csv",
    "promotion": "dim_promotion_final.csv",
    "channel": "dim_channel.csv",
    "date": "dim_date2425_corrected.csv",
}
NO_PROMO = "-1"
SEED = 20261009

# --- economics -------------------------------------------------------------
STANDARD_COST_RATE = 0.45   # unit cost as a share of list price, every channel
PROMOTION_COST_RATE = 0.03  # promotional overhead on promoted rows' list value
BASE_WINDOW = 4             # non-promoted weeks averaged on each side

# --- response curve: u0(d) = LIFT_AT_10PCT (d / 0.10)^CONVEXITY ----------------
# +18 % at 5 % off, +40 % at 10 %, +64 % at 15 %, +88 % at 20 %, +115 % at 25 %:
# close to the lift each depth needs to break even at a 50 % margin (+19 %,
# +35 %, +56 %, +83 %, +127 %), so the multipliers below decide which
# promotions pay and which do not.
LIFT_AT_10PCT, CONVEXITY = 0.40, 1.15
#: A store-week rarely sells more than this multiple of its normal volume --
#: shelf space and stock run out -- however many multipliers stack up.
MAX_LIFT = 4.0
SCALE = 1.4

#: Q-Commerce and e-commerce shoppers see and act on a deal; General Trade
#: retailers pass little of it through; B2B and travel buyers barely react.
CHANNEL = {"CH001": 1.20, "CH002": 1.00, "CH003": 1.00, "CH004": 0.35, "CH005": 0.55, "CH006": 1.35}
REGION = {"South": 1.25, "West": 1.05, "North": 0.95, "Central": 0.75, "East": 0.60}
#: Smaller towns chase a price cut but not a multi-buy that needs 4 units; metro
#: shoppers stock up on a multi-buy.
TIER = {
    "Percent_Off": {"Tier 1": 0.95, "Tier 2": 1.05, "Tier 3": 1.15},
    "Buy_X_Get_Y": {"Tier 1": 1.25, "Tier 2": 1.05, "Tier 3": 0.80},
}
#: Stockable, price-compared lines respond; habitual, low-ticket ones do not.
BRAND = {
    "Laundry Detergent": 1.30, "Fabric Conditioner": 0.90, "Fabric Softener Dryer Sheets": 0.70,
    "Taped Diapers": 1.00, "Baby Wipes": 1.20, "L_Diapers": 0.85,
    "Toothpaste": 1.10, "Toothbrushes": 0.60, "Cough & Cold": 1.00,
}
#: Cough & Cold promotions only move product in the cold season.
COLD_PROMO_MONTH = {1: 1.45, 2: 1.30, 3: 0.90, 4: 0.55, 5: 0.40, 6: 0.45,
                    7: 0.70, 8: 0.75, 9: 0.85, 10: 1.00, 11: 1.30, 12: 1.45}
EVENT = {"New Year Savings": 1.25, "Holi Special Deal": 1.35, "Summer Special": 0.95,
         "Independence Offer": 1.05, "Dussehra Deal": 1.30, "Diwali Special": 1.70}
RETAILER_SIGMA = 0.20  # execution: display, stock, pass-through
FATIGUE = 0.90         # each further consecutive week of the same offer
RUN_SIGMA = 0.35       # one draw per product-store promotion run
ROW_SIGMA = 0.05

#: Cough & Cold ordinary demand by month (mean 1.0, so the year total holds and
#: year-on-year growth by month is untouched).
COLD_SEASON = np.array([1.45, 1.30, 1.05, 0.80, 0.65, 0.70, 0.85, 0.90, 0.95, 1.05, 1.25, 1.45])
COLD_SEASON = COLD_SEASON / COLD_SEASON.mean()

#: Festival days, from the Government of India gazetted holiday lists (the
#: dates Google Calendar's "Holidays in India" shows). A festival offer ends in
#: the week holding its day -- the run-up -- except New Year, which starts in
#: it. Summer Special has no day and keeps the source's weeks.
FESTIVALS: dict[str, tuple[str, dict[int, str]]] = {
    "New Year Savings": ("start", {2024: "2024-01-01", 2025: "2025-01-01", 2026: "2026-01-01"}),
    "Holi Special Deal": ("end", {2024: "2024-03-25", 2025: "2025-03-14", 2026: "2026-03-04"}),
    "Independence Offer": ("end", {2024: "2024-08-15", 2025: "2025-08-15", 2026: "2026-08-15"}),
    "Dussehra Deal": ("end", {2024: "2024-10-12", 2025: "2025-10-02"}),
    "Diwali Special": ("end", {2024: "2024-10-31", 2025: "2025-10-20"}),
}

# --- promotion frequency -----------------------------------------------------
MAX_PROMO_SHARE = 0.30  # of a product-store's weeks on any offer, at most
PROMO_BURST = 5         # weeks of headroom, so a month-long first offer fits
MIN_GAP_WEEKS = 2       # ordinary weeks between two offers on one product-store
MIN_GAP_MONTH_GRAIN = 4 # ...in a channel that books whole months: a month off
MONTH_GRAIN_CYCLE = 4   # a month-grain product's regular offer: one month in four
MAX_FESTIVALS_PER_YEAR = 2  # month-long festival offers one month-grain product joins a year
MAX_PROMO_MONTHS_PER_YEAR = 4  # ...and promoted months in all, festival + regular (a third)
MONTH_RUN_UP_DAY = 15   # a festival before this day of its month runs up in the month before

#: Share of a promoted pack's extra units taken from the pack sizes either side
#: of it (same brand, same store, same week). Size-switching lines (diapers,
#: detergent) cannibalize most; toothbrushes barely.
CANNIBALIZATION = {
    "Laundry Detergent": 0.25, "Fabric Conditioner": 0.20, "Fabric Softener Dryer Sheets": 0.15,
    "Taped Diapers": 0.30, "Baby Wipes": 0.20, "L_Diapers": 0.30,
    "Toothpaste": 0.20, "Toothbrushes": 0.10, "Cough & Cold": 0.15,
}
CANNIBALIZATION_SIGMA = 0.30


def _pack_size(size: str) -> float:
    """The number in "50 mL" / "17 oz" / "40 ct" -- packs only compare in-brand."""
    return float(re.match(r"\s*([\d.]+)", size).group(1))


def _git_csv(rev: str, name: str) -> pd.DataFrame:
    blob = subprocess.run(["git", "show", f"{rev}:Data/{name}"], cwd=ROOT, check=True,
                          capture_output=True).stdout
    return pd.read_csv(io.BytesIO(blob), dtype=str, keep_default_na=False, encoding="utf-8-sig")


def _tidy(text: pd.Series) -> pd.Series:
    text = text.str.strip().str.replace(r"\s{2,}", " ", regex=True)
    return text.mask(text.str.lower().isin({"null", "none", "nan"}), "")


def _keyed_normal(key: str, sigma: float) -> float:
    """A deterministic lognormal factor per key, independent of row order."""
    seed = int.from_bytes(hashlib.sha256(f"{SEED}:{key}".encode()).digest()[:8], "little")
    return float(np.exp(np.random.default_rng(seed).normal(0.0, sigma) - sigma**2 / 2))


def _mechanic(name: str) -> tuple[str, float]:
    if m := re.fullmatch(r"(\d+(?:\.\d+)?)% Discount", name):
        return "Percent_Off", float(m.group(1)) / 100
    if m := re.fullmatch(r"Buy(\d+)Get(\d+)", name):
        return "Buy_X_Get_Y", int(m.group(2)) / (int(m.group(1)) + int(m.group(2)))
    return "None", 0.0


def build(rev: str) -> dict[str, pd.DataFrame]:
    raw = {k: _git_csv(rev, v) for k, v in DIMS.items()}
    fact = _git_csv(rev, FACT)
    for k in raw:
        raw[k] = raw[k].apply(_tidy)

    # --- dimensions --------------------------------------------------------
    product = raw["product"].replace({"Product_id": {"P21-68ct": "P21-98ct"}})
    fact["Product_id"] = fact.Product_id.str.strip().replace({"P21-68ct": "P21-98ct"})
    list_price = product.set_index("Product_id").Cost.astype(float)
    product = product.drop(columns=["Cost"])

    store = raw["store"][raw["store"].Store_Id.isin(set(fact.Store_Id))].reset_index(drop=True)
    promotion = raw["promotion"][raw["promotion"].Promotion_Id.isin(set(fact.Promotion_Id))]
    promotion = promotion.reset_index(drop=True)

    channel = raw["channel"].copy()
    schedule = fact.groupby("Channel_Id").Schedule.agg(lambda s: s.str.strip().unique())
    assert schedule.map(len).eq(1).all(), "a channel books mixed schedules"
    channel["Schedule"] = channel.Channel_Id.map(schedule.str[0])

    date = raw["date"].copy()
    day = pd.to_datetime(date.Date, format="%d-%m-%Y")
    date.loc[(day.dt.month == 12) & (date.Week == "1"), "Week"] = "53"

    # --- fact: one (product-store) x (week) grid -----------------------------
    st = store.set_index("Store_Id")
    pr = product.set_index("Product_id")
    promo_attr = {r.Promotion_Id: (*_mechanic(r.Promotion_Name),
                                   re.sub(r"\s*\d{2}$", "", r.Promotion_Description)
                                   if r.Promotion_Type == "Seasonal" else "",
                                   2000 + int(r.Promotion_Description[-2:])
                                   if r.Promotion_Type == "Seasonal" else 0)
                  for r in promotion.itertuples()}
    depth_of = {k: v[1] for k, v in promo_attr.items()}

    fact["Store_Id"] = fact.Store_Id.str.strip()
    fact["Promotion_Id"] = fact.Promotion_Id.str.strip()
    when = pd.to_datetime(fact.Date, format="%d-%m-%Y")
    weeks = np.sort(when.unique())
    cell = fact.Product_id + "|" + fact.Store_Id
    cells = np.sort(cell.unique())
    gi = np.searchsorted(cells, cell.to_numpy())
    ti = np.searchsorted(weeks, when.to_numpy())
    G, T = len(cells), len(weeks)
    assert len(fact) == G * T, "every product-store must hold every week"

    def grid(values) -> np.ndarray:
        values = np.asarray(values)
        out = np.empty((G, T), dtype=values.dtype)
        out[gi, ti] = values
        return out

    src_pid = grid(fact.Promotion_Id.to_numpy().astype(object))
    src_price = grid(fact.Actual_Price.astype(float).to_numpy())
    qty = grid(fact.Actual_Quantity.astype(float).to_numpy())
    cell_product = np.array([c.split("|")[0] for c in cells])
    cell_store = np.array([c.split("|")[1] for c in cells])
    bp = list_price.reindex(cell_product).to_numpy()[:, None] * np.ones((1, T))
    assert (grid(fact.Base_Price.astype(float).to_numpy()) == bp).all(), "Base_Price drifted from list"
    brand = pr.Brand.reindex(cell_product).to_numpy()
    channel_of = st.Channel_Id.reindex(cell_store).to_numpy()
    month = pd.DatetimeIndex(weeks).month.to_numpy()

    def price_for(pid: np.ndarray) -> np.ndarray:
        depth = np.vectorize(lambda p: depth_of.get(p, 0.0), otypes=[float])(pid)
        return np.vectorize(round, otypes=[float])(bp * (1 - depth))

    src_promoted = src_pid != NO_PROMO
    assert (price_for(src_pid) == src_price).all(), "a source price is not round(list x (1 - depth))"

    def nearest_mean(values: np.ndarray, usable: np.ndarray) -> np.ndarray:
        """Each unusable week: mean of the nearest BASE_WINDOW usable weeks either side."""
        out = values.astype(float).copy()
        for g in range(G):
            ok = np.flatnonzero(usable[g])
            if not len(ok):
                continue
            for t in np.flatnonzero(~usable[g]):
                k = np.searchsorted(ok, t)
                out[g, t] = values[g, ok[max(0, k - BASE_WINDOW):k + BASE_WINDOW]].mean()
        return out

    # Ordinary demand: the source's non-promoted units; its promoted weeks are
    # filled from their neighbours. Cough & Cold then gets its winter season.
    season = np.where((brand == "Cough & Cold")[:, None], COLD_SEASON[month - 1][None, :], 1.0)
    demand = np.round(nearest_mean(qty, ~src_promoted) * season)

    # --- calendar 1: festival offers in the festival's own week(s) --------------
    # A festival offer runs at the grain of the channel's own REGULAR offers, so
    # one channel never mixes a weekly rhythm with a monthly one.
    #   week grain  -- the one business week holding the festival day.
    #   month grain -- the channel books an offer for a whole calendar month
    #                  (Modern Trade, B2B), so the festival takes every week of
    #                  the month leading INTO it: its own month from
    #                  MONTH_RUN_UP_DAY on, the month before otherwise.
    # New Year starts in its week / month rather than leading into it. Two
    # festivals claiming one month push the earlier one a month earlier.
    def runs_of(seq):
        out, t = [], 0
        while t < len(seq):
            if seq[t] == NO_PROMO:
                t += 1
                continue
            s = t
            while t < len(seq) and seq[t] == seq[s]:
                t += 1
            out.append((s, t - 1, seq[s]))
        return out

    plan = src_pid.copy()
    is_event = lambda p: bool(promo_attr.get(p, ("", 0, "", 0))[2])
    week_of = lambda day: int(np.searchsorted(weeks, np.datetime64(pd.Timestamp(day)), side="right") - 1)
    week_period = pd.DatetimeIndex(weeks).to_period("M")
    #: The monthly channels' regular rotation: 5 % in Jan/Apr/Jul/Oct, 10 % in
    #: Feb/May/Aug/Nov, 15 % in Mar/Jun/Sep/Dec -- read from the source, not set.
    by_month = pd.DataFrame({"m": np.tile(month, G), "p": src_pid.ravel()})
    by_month = by_month[by_month.p.str.startswith("PR")]
    rotation_of = by_month.groupby("m").p.agg(lambda x: x.value_counts().index[0])
    rotation = rotation_of.reindex(month).to_numpy().astype(object)
    month_grain = {}
    for c in np.unique(channel_of):
        mine = channel_of == c
        regular = [e - s + 1 for g in np.flatnonzero(mine) for s, e, p in runs_of(src_pid[g]) if not is_event(p)]
        month_grain[c] = bool(np.median(regular) > 1)
        blocks = {}
        for p, (_, _, event, year) in promo_attr.items():
            if event in FESTIVALS and year in FESTIVALS[event][1] and (src_pid[mine] == p).any():
                anchor, days = FESTIVALS[event]
                day = pd.Timestamp(days[year])
                if not month_grain[c]:
                    blocks[p] = week_of(day)
                else:
                    lead = anchor == "end" and day.day < MONTH_RUN_UP_DAY
                    blocks[p] = day.to_period("M") - (1 if lead else 0)
        if month_grain[c]:
            # A seasonal offer with no festival day (Summer Special) takes the
            # whole month its source week sat in.
            for p, (_, _, event, _) in promo_attr.items():
                hit = (src_pid[mine] == p).any(axis=0)
                if event and event not in FESTIVALS and hit.any():
                    blocks[p] = week_period[np.flatnonzero(hit)[0]]
            for p in sorted(blocks, key=lambda p: blocks[p], reverse=True):
                while list(blocks.values()).count(blocks[p]) > 1:
                    blocks[p] -= 1
        for p, at_ in blocks.items():
            span = (week_period == at_) if month_grain[c] else (np.arange(T) == at_)
            for g in np.flatnonzero(mine & (src_pid == p).any(axis=1)):
                vacated = plan[g] == p
                # A month a festival moves out of keeps a regular offer -- that
                # month's turn in the monthly rotation -- rather than going dark.
                plan[g][vacated] = rotation[vacated] if month_grain[c] else NO_PROMO
                plan[g, span] = p
    #: Ordinary weeks a product-store must have between two offers.
    gap_of = {c: MIN_GAP_MONTH_GRAIN if m else MIN_GAP_WEEKS for c, m in month_grain.items()}

    # Planners rotate products between festivals: a product-store never runs two
    # festival offers closer than its channel's gap. Festivals that would chain
    # (Independence -> Dussehra -> Diwali, month by month) are split by a fixed
    # per-product coin: a product keeps every other festival of the chain,
    # starting from the first or the second, the same choice in every store --
    # so each festival still runs, on its own part of the range.
    for g in range(G):
        gap = gap_of[channel_of[g]]
        festivals = [r for r in runs_of(plan[g]) if is_event(r[2])]
        chains, chain = [], festivals[:1]
        for a, b in zip(festivals, festivals[1:]):
            if b[0] - a[1] - 1 < gap:
                chain.append(b)
            else:
                chains.append(chain)
                chain = [b]
        chains.append(chain)
        for chain in (c for c in chains if len(c) > 1):
            parity = int(_keyed_normal(f"{cell_product[g]}|{chain[0][2]}", 1.0) < 1.0)
            for i, (s, e, _) in enumerate(chain):
                if i % 2 != parity:
                    plan[g, s:e + 1] = NO_PROMO

    # --- calendar 2: realistic frequency -----------------------------------------
    # Month-grain channels (offers last a calendar month) are PLANNED:
    #   * a product joins at most MAX_FESTIVALS_PER_YEAR festival months a year,
    #     rotated by its position in the range so every festival keeps an even
    #     share of products;
    #   * regular offers come once every MONTH_GRAIN_CYCLE months at that month's
    #     rotation offer, staggered across products so every month carries part
    #     of the range, never next to the product's own festival month, and
    #     never past MAX_PROMO_MONTHS_PER_YEAR promoted months in the year.
    # "Promotable" is any product the source ever promoted in the channel.
    months = week_period.unique()
    month_idx = np.searchsorted(months, week_period)
    month_year = months.year
    years = pd.DatetimeIndex(weeks).year.to_numpy()
    for c in (c for c, m in month_grain.items() if m):
        mine = channel_of == c
        promotable = sorted({cell_product[g] for g in np.flatnonzero(mine & src_promoted.any(axis=1))})
        position = {p: i for i, p in enumerate(promotable)}
        for g in np.flatnonzero(mine):
            plan[g][~np.vectorize(is_event, otypes=[bool])(plan[g])] = NO_PROMO
            if cell_product[g] not in position:
                plan[g] = NO_PROMO
                continue
            i = position[cell_product[g]]
            for y in np.unique(years):
                runs_y = [r for r in runs_of(plan[g]) if is_event(r[2]) and years[r[0]] == y]
                n = len(runs_y)
                kept = {(k + i) % n for k in range(min(n, MAX_FESTIVALS_PER_YEAR))} if n else set()
                for k, (s, e, _) in enumerate(runs_y):
                    if k not in kept:
                        plan[g, s:e + 1] = NO_PROMO
            festival_months = set(month_idx[np.vectorize(is_event, otypes=[bool])(plan[g])])
            used = {y: sum(1 for m in festival_months if month_year[m] == y) for y in np.unique(years)}
            for mi in range(len(months)):
                y = month_year[mi]
                near = {mi - 1, mi, mi + 1} & festival_months
                if (mi + i) % MONTH_GRAIN_CYCLE == 0 and not near and used[y] < MAX_PROMO_MONTHS_PER_YEAR:
                    plan[g, month_idx == mi] = rotation[month_idx == mi]
                    used[y] += 1

    # Week-grain channels: regular offers are kept in date order only while the
    # cell stays within MAX_PROMO_SHARE of its weeks so far and MIN_GAP_WEEKS
    # clear of any other offer. Festival offers are never dropped.
    for g in np.flatnonzero(~np.vectorize(month_grain.get)(channel_of)):
        gap = gap_of[channel_of[g]]
        runs = [(s, e, is_event(p)) for s, e, p in runs_of(plan[g])]
        event_starts = [s for s, _, fixed in runs if fixed]
        kept_weeks, last_end = 0, -10**6
        for s, e, fixed in runs:
            length = e - s + 1
            next_event = min([x for x in event_starts if x > e], default=10**6)
            ok = fixed or (s - last_end - 1 >= gap
                           and next_event - e - 1 >= gap
                           and kept_weeks + length <= MAX_PROMO_SHARE * (e + 1) + PROMO_BURST)
            if ok:
                kept_weeks += length
                last_end = e
            else:
                plan[g, s:e + 1] = NO_PROMO

    promoted = plan != NO_PROMO
    price = price_for(plan)
    depth = 1 - price / bp

    # --- quantities --------------------------------------------------------------
    base = np.where(promoted, np.round(nearest_mean(demand, ~promoted)), demand)
    run_week = np.zeros((G, T), dtype=int)
    run_id = np.empty((G, T), dtype=object)
    for g in range(G):
        for t in np.flatnonzero(promoted[g]):
            same = t > 0 and plan[g, t - 1] == plan[g, t]
            run_week[g, t] = run_week[g, t - 1] + 1 if same else 1
            run_id[g, t] = run_id[g, t - 1] if same else f"{cells[g]}|{plan[g, t]}|{t}"

    region = st.Region.reindex(cell_store).to_numpy()
    tier = st.Tier.reindex(cell_store).to_numpy()
    who = st.Retailer.where(st.Retailer != "", st.Distributor_Name).reindex(cell_store).to_numpy()
    rng = np.random.default_rng(SEED)
    actual = demand.copy()
    for g, t in zip(*np.nonzero(promoted)):
        mech, _, event, _ = promo_attr[plan[g, t]]
        b = brand[g]
        m = (CHANNEL[channel_of[g]] * REGION[region[g]] * TIER[mech][tier[g]]
             * (COLD_PROMO_MONTH[month[t]] if b == "Cough & Cold" else BRAND[b])
             * EVENT.get(event, 1.0) * _keyed_normal(f"{channel_of[g]}|{who[g]}", RETAILER_SIGMA)
             * FATIGUE ** (run_week[g, t] - 1) * _keyed_normal(run_id[g, t], RUN_SIGMA))
        u = (LIFT_AT_10PCT * (max(depth[g, t], 0.0) / 0.10) ** CONVEXITY
             * SCALE * m * np.exp(rng.normal(0, ROW_SIGMA)))
        actual[g, t] = max(base[g, t], round(base[g, t] * (1 + min(max(u, 0.0), MAX_LIFT - 1))))

    # --- cannibalization: the pack sizes either side give up part of the gain ----
    rank = pr.Size.map(_pack_size).groupby(pr.Brand).rank(method="first").astype(int)
    at = {(p, s): g for g, (p, s) in enumerate(zip(cell_product, cell_store))}
    by_rank = {(pr.Brand[p], rank[p]): p for p in pr.index}
    loss = np.zeros((G, T))
    for g, t in zip(*np.nonzero(promoted)):
        gain = actual[g, t] - base[g, t]
        if gain <= 0:
            continue
        b, r = brand[g], rank[cell_product[g]]
        victims = [at[(by_rank[(b, n)], cell_store[g])] for n in (r - 1, r + 1) if (b, n) in by_rank]
        victims = [v for v in victims if not promoted[v, t]]
        if victims:
            share = CANNIBALIZATION[b] * gain * _keyed_normal(run_id[g, t] + "|c", CANNIBALIZATION_SIGMA)
            for v in victims:
                loss[v, t] += share / len(victims)
    actual = np.where(promoted, actual, np.maximum(np.round(demand * 0.5), np.round(demand - loss)))
    base = np.where(promoted, base, actual)

    actual = actual.astype(int)
    unit_cost = np.round(STANDARD_COST_RATE * bp)
    flat = lambda m: m[gi, ti]
    out = pd.DataFrame({
        "Date": fact.Date,
        "Product_id": fact.Product_id,
        "Store_Id": fact.Store_Id,
        "Promotion_Id": flat(plan),
        "Base_Quantity": flat(base).astype(int),
        "Actual_Quantity": flat(actual),
        "Base_Price": flat(bp).astype(int),
        "Actual_Price": flat(price).astype(int),
        "Total_Cost": flat(actual * unit_cost).astype(int),
        "Promotion_Cost": flat(np.where(promoted, np.round(PROMOTION_COST_RATE * actual * bp), 0)).astype(int),
    })
    return {"fact": out, "product": product, "store": store, "promotion": promotion,
            "channel": channel, "date": date}


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--out", required=True, type=Path)
    ap.add_argument("--rev", default="HEAD")
    args = ap.parse_args()
    tables = build(args.rev)
    args.out.mkdir(parents=True, exist_ok=True)
    names = {"fact": FACT, **DIMS}
    for key, df in tables.items():
        df.to_csv(args.out / names[key], index=False, lineterminator="\n")
        print(f"{names[key]}: {len(df)} rows x {df.shape[1]} cols")


if __name__ == "__main__":
    main()
