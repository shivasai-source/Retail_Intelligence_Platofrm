"""The data layer: the five finalized TPO CSVs -> one cached, in-memory store.

Loaded ONCE at first use and reused by every endpoint. The spec is explicit
that four endpoints must not each re-read the CSVs, so nothing here runs per
request except `filter_rows`, which walks already-parsed columns.

Layout is columnar: one array per field, dimensions held as integer codes into
a lookup table. 205,920 rows of Python objects would be tens of MB and slow to
scan; as `array('d')`/`array('i')` columns it is a few MB and a filter pass is
a tight loop over ints. Nothing here computes a KPI — this module only loads,
joins and indexes. See app/tpo/aggregate.py for the arithmetic.

TWO DATASET SHAPES, ONE STORE. The sales fact, dim_product and dim_geo_store
are required. The other three dimensions are read when present and DERIVED
when absent, so a client who only has a sales extract and two masters loads
the same way a full six-file star schema does:

  * dim_date      -> generated from the sales file's own years (`_derive_week`)
  * dim_channel   -> the distinct channels named in dim_geo_store
  * dim_promotion -> the Promotion_Name / Promotion_Type the fact carries

The fact also accepts `CP` (cost per unit) in place of `Total_Cost`, and a
blank `Promotion_Id` in place of the `-1` sentinel. Nothing downstream can tell
the two shapes apart; `star_dataset.py` holds the matching upload contract.
"""

from __future__ import annotations

import csv
import re
from array import array
from collections import defaultdict
from dataclasses import dataclass, field
from datetime import date, timedelta
from functools import lru_cache
from pathlib import Path
from typing import Any, Callable, Iterator

from app.tpo import config

#: Promotion_Id on a non-promoted row. The baseline every uplift is measured
#: against is built from exactly these rows, so this constant is load-bearing.
#:
#: `-1` is this platform's own sentinel, not something a source system writes:
#: a client extract leaves the cell empty on a row that carried no offer. Both
#: spellings mean "not promoted" and `_promotion_id` folds them together.
NO_PROMOTION = "-1"


def _promotion_id(value: str) -> str:
    """A fact row's Promotion_Id, with an empty cell read as "no promotion"."""
    cleaned = _clean(value)
    return cleaned if cleaned else NO_PROMOTION


# --- dimension records -----------------------------------------------------


@dataclass(frozen=True)
class Product:
    product_id: str
    name: str
    brand: str  # the Brand Form — 4 pack sizes share one
    category: str
    size: str
    rank: int  # 1-4 by pack size within the Brand Form; 1 is never promoted


@dataclass(frozen=True)
class Store:
    store_id: str
    channel_id: str
    retailer: str
    distributor: str
    region: str
    state: str
    city: str
    tier: str
    #: The channel's own name, type and promotion grain, when the store master
    #: carries them instead of a separate dim_channel. Blank when dim_channel
    #: was uploaded and holds them; `_load_channels` reads whichever is present.
    channel_name: str = ""
    channel_type: str = ""
    schedule: str = ""


@dataclass(frozen=True)
class Promotion:
    promotion_id: str
    name: str
    type: str  # Normal | Regular | Seasonal
    description: str

    @property
    def is_promotional(self) -> bool:
        return self.promotion_id != NO_PROMOTION

    @property
    def label(self) -> str:
        """THE display name for an offer — one source, used everywhere.

        `Promotion_Name` is NOT unique: seven promotions are called
        "20% Discount" and seven "Buy3Get1", because the seasonal calendar
        reuses the mechanic as the name. Rendering that put six identical
        entries in the Offer dropdown.

        `Promotion_Description` is unique across all 18 rows ("New Year
        Savings 24", "Diwali Special 25"), so it is the label. Both the filter
        options and the promotion-mix legend read this property, so the two can
        no longer disagree about what an offer is called.
        """
        return self.description.strip() or self.name.strip() or self.promotion_id


@dataclass(frozen=True)
class Channel:
    channel_id: str
    name: str
    type: str


# --- parsing helpers -------------------------------------------------------


#: Text an exporter writes when a cell is EMPTY. These are renderings of
#: absence, not values, and a dimension that keeps them offers the user a
#: filter option called "null".
#:
#: DELIBERATELY NARROW. "na" and "-" are left out because both are plausible
#: real values in this domain — "NA" is a region code and a dash appears inside
#: product names — and silently blanking a real value is a worse failure than
#: showing an odd one. Only renderings that cannot be a business value are here.
_ABSENT_TEXT = frozenset({"null", "none", "nan", "n/a"})


def _clean(value: str | None) -> str:
    """Trim a dimension value, and treat written-out absence as absent.

    Several dim_product / dim_promotion cells carry stray leading spaces
    (" Liquid Laundry Detergent 50 mL"), which would otherwise split one brand
    into two filter options.

    THE LITERAL "null" IS THE SAME CLASS OF PROBLEM. `dim_geo_store_final.csv`
    writes it where a store has no retailer and no distributor: all 64 B2B
    stores carry `Retailer = "null"`, and 493 of 557 rows carry
    `Distributor_Name = "null"`. Read as text it became a value — B2B reported
    one retailer group whose name was "null" instead of reporting none, and the
    distributor control offered a two-item list of "Distributor_01" and "null",
    which is what made it look like a real choice.

    Everything downstream already handles a blank correctly: `options_for`
    drops empty values and `retailer_available` hides the control rather than
    showing an empty dropdown. So the whole fix is to spell absence one way at
    the point every dimension cell is read, rather than teaching each consumer
    a second spelling of it.
    """
    text = (value or "").strip()
    return "" if text.lower() in _ABSENT_TEXT else text


def _float(value: str | None) -> float:
    try:
        return float(value)
    except (TypeError, ValueError):
        return 0.0


_SIZE_NUMBER = re.compile(r"([\d.]+)")


def _pack_size(size: str) -> float:
    """Leading number of a pack size ("250 mL" -> 250.0), for ranking within a
    Brand Form. Units are consistent inside a Brand Form — every Laundry
    Detergent is mL, every Dryer Sheet is ct — so the number alone orders them.
    """
    match = _SIZE_NUMBER.match(_clean(size))
    return float(match.group(1)) if match else 0.0


class DatasetNotLoaded(FileNotFoundError):
    """No star-schema CSVs in the data folder yet.

    A distinct type because this is the EXPECTED state of a fresh checkout —
    the Data/ folder ships empty and is filled by uploading the six files
    through the Excel connector. Routes turn this into an empty, well-formed
    response ("no data yet") instead of a 500, so the app is usable enough to
    reach the upload screen. A genuine parse failure is still a plain error.
    """


def _read_csv(path: Path) -> Iterator[dict[str, str]]:
    if not path.is_file():
        raise DatasetNotLoaded(
            f"No dataset loaded: {path.name} is missing from {path.parent}. "
            f"Upload the sales fact, product and store CSVs through the Excel / "
            f"Shared Drives connector, or set TPO_DATA_DIR to a folder that "
            f"already holds them."
        )
    # utf-8-sig: dim_promotion_final.csv carries a BOM, which would otherwise
    # turn its first header into a key no lookup matches.
    with path.open(newline="", encoding="utf-8-sig") as handle:
        yield from csv.DictReader(handle)


MONTHS = [
    "January", "February", "March", "April", "May", "June",
    "July", "August", "September", "October", "November", "December",
]


def _parse_date(value: str) -> date:
    """The datasets write dates as DD-MM-YYYY throughout."""
    day, month, year = _clean(value).split("-")
    return date(int(year), int(month), int(day))


# --- dimensions ------------------------------------------------------------


@dataclass
class Dimensions:
    products: dict[str, Product]
    stores: dict[str, Store]
    promotions: dict[str, Promotion]
    channels: dict[str, Channel]
    #: (year, week) -> the calendar days that business week covers, from
    #: dim_date. Used to tell a whole week from one clipped by a month filter.
    week_dates: dict[tuple[int, int], list[date]]

    @property
    def week_start(self) -> dict[tuple[int, int], date]:
        """(year, week) -> the first calendar day of that business week.

        THE source of the analytical month. `fact_sales.Month` cannot be used:
        the CH002 and CH004 generators set `Date = Week_Start` but never
        re-derived Month from it (CH004 literally writes
        `fact_sales["Month"] = fact_sales["Month"]`), and CH002/CH004/CH005
        also carry a scrambled `Date` — 51.9% of their rows disagree with the
        Week_Start dim_date gives for their own (Year, Week). Together those
        put 46,440 of 205,920 rows (22.6%) in the wrong month.

        `Week` is intact in every row and dim_date is clean (Month is strictly
        calendar, 0 mismatches), so the month is recovered by joining on the
        week. This reproduces the two known-good channels exactly and gives all
        five the same monthly shape.
        """
        return {key: min(days) for key, days in self.week_dates.items()}


def _load_products(data_dir: Path) -> dict[str, Product]:
    """dim_product, with each SKU's rank inside its Brand Form derived here.

    The rank is what makes cannibalization possible: neighbours are the pack
    sizes immediately either side of a promoted one. It is computed from
    `Size`, never hardcoded, so a new pack slots in at the right position.
    """
    raw = [{k: _clean(v) for k, v in row.items()} for row in _read_csv(data_dir / config.DIM_FILES["product"])]

    by_brand: dict[str, list[dict[str, str]]] = defaultdict(list)
    for row in raw:
        by_brand[row["Brand"]].append(row)

    ranks: dict[str, int] = {}
    for rows in by_brand.values():
        ordered = sorted(rows, key=lambda r: (_pack_size(r["Size"]), r["Product_id"]))
        for position, row in enumerate(ordered, start=1):
            ranks[row["Product_id"]] = position

    return {
        row["Product_id"]: Product(
            product_id=row["Product_id"],
            name=row["Product_Name"],
            brand=row["Brand"],
            category=row["Category"],
            size=row["Size"],
            rank=ranks[row["Product_id"]],
        )
        for row in raw
    }


def _load_stores(data_dir: Path) -> dict[str, Store]:
    stores: dict[str, Store] = {}
    for raw in _read_csv(data_dir / config.DIM_FILES["geo_store"]):
        row = {k: _clean(v) for k, v in raw.items()}
        stores[row["Store_Id"]] = Store(
            store_id=row["Store_Id"],
            channel_id=row["Channel_Id"],
            retailer=row["Retailer"],
            distributor=row.get("Distributor_Name", ""),
            region=row["Region"],
            state=row["State"],
            city=row["City"],
            tier=row["Tier"],
            channel_name=row.get("Channel_Name", ""),
            channel_type=row.get("Channel_Type", ""),
            schedule=row.get("Schedule", ""),
        )
    return stores


def _load_promotions(data_dir: Path) -> dict[str, Promotion]:
    """dim_promotion, or {} when it was not uploaded.

    An empty result is not an error: the fact's own Promotion_Name and
    Promotion_Type then describe each offer, and `_build_store` registers them
    as it meets them. Returning {} rather than deriving here keeps the fact to
    a single pass.
    """
    path = data_dir / config.DIM_FILES["promotion"]
    if not path.is_file():
        return {}
    promotions: dict[str, Promotion] = {}
    for raw in _read_csv(path):
        row = {k: _clean(v) for k, v in raw.items()}
        promotions[row["Promotion_Id"]] = Promotion(
            promotion_id=row["Promotion_Id"],
            name=row["Promotion_Name"],
            type=row["Promotion_Type"],
            # Description is presentation-only and no client extract carries
            # it; the name stands in when the dimension was not uploaded.
            description=row.get("Promotion_Description", row["Promotion_Name"]),
        )
    return promotions


def _load_channels(data_dir: Path, stores: dict[str, Store]) -> dict[str, Channel]:
    """dim_channel, or the channels dim_geo_store names when it was not uploaded.

    A channel is an attribute of the stores that trade in it, so a store master
    carrying Channel_Name / Channel_Type already holds the whole dimension. Only
    the id is guaranteed; without a name the id doubles as the label, which is
    what the KPI pages group and filter by anyway.
    """
    path = data_dir / config.DIM_FILES["channel"]
    if path.is_file():
        channels: dict[str, Channel] = {}
        for raw in _read_csv(path):
            row = {k: _clean(v) for k, v in raw.items()}
            channels[row["Channel_Id"]] = Channel(
                channel_id=row["Channel_Id"],
                name=row["Channel_Name"],
                type=row["Channel_Type"],
            )
        return channels

    derived: dict[str, Channel] = {}
    for store in stores.values():
        if store.channel_id and store.channel_id not in derived:
            derived[store.channel_id] = Channel(
                channel_id=store.channel_id,
                name=store.channel_name or store.channel_id,
                type=store.channel_type,
            )
    return derived


def _derive_week(day: date) -> int:
    """The business week a day falls in, when no date dimension was uploaded.

    Week 1 runs from 1 January to the first Sunday; every Monday after that
    opens a new week. Verified against the reference dim_date: week number,
    month, quarter and day label reproduce EXACTLY on all 1,096 of its rows,
    the short year-end week included — 29–31 Dec land in week 53 as a
    consequence of the rule rather than as a special case.
    """
    jan2 = date(day.year, 1, 2)
    first_monday = jan2 + timedelta(days=(7 - jan2.weekday()) % 7)
    return 1 if day < first_monday else 2 + (day - first_monday).days // 7


def _fact_years(data_dir: Path) -> set[int]:
    """The years the sales file covers, from its Date column alone.

    One narrow pass (~0.3 s over 325k rows, against ~0.6 s for a DictReader
    one) so the generated calendar spans exactly the years in play instead of a
    guessed range. Only reached when dim_date is absent, and the store is
    cached for the process lifetime, so it costs once.
    """
    path = data_dir / config.FACT_FILE
    with path.open(newline="", encoding="utf-8-sig") as handle:
        reader = csv.reader(handle)
        header = next(reader, [])
        try:
            at = header.index("Date")
        except ValueError:
            return set()
        return {
            int(row[at][-4:])
            for row in reader
            if len(row) > at and row[at][-4:].isdigit()
        }


def _load_week_dates(data_dir: Path) -> dict[tuple[int, int], list[date]]:
    """(year, week) -> its calendar days.

    From dim_date when that file was uploaded: the dataset numbers its own
    business weeks and this reads that numbering rather than re-deriving one. A
    week whose day count inside the selected period falls short of this is a
    fragment, and the week-average comparisons skip it.

    Without dim_date the same calendar is generated by `_derive_week` over the
    sales file's own years. EVERY calendar day of those years is included, not
    only the days that carry sales: a week's full day count is exactly what
    tells a whole week from one clipped by a month filter, so generating only
    the days present would turn a channel that books one row a week into a
    one-day week and have the comparisons discard it.
    """
    path = data_dir / config.DIM_FILES["date"]
    weeks: dict[tuple[int, int], list[date]] = defaultdict(list)
    if path.is_file():
        for row in _read_csv(path):
            day = _parse_date(row["Date"])
            weeks[(int(row["Year"]), int(row["Week"]))].append(day)
    else:
        for year in _fact_years(data_dir):
            day = date(year, 1, 1)
            while day.year == year:
                weeks[(year, _derive_week(day))].append(day)
                day += timedelta(days=1)
    for days in weeks.values():
        days.sort()
    return dict(weeks)


# --- fact ------------------------------------------------------------------


@dataclass
class FactStore:
    """The fact table as parallel columns, dimensions as integer codes.

    `product_code`/`store_code`/`promo_code` index into `products`/`stores`/
    `promotions`, so a filter compares ints and never chases a dict lookup per
    row. `promoted` is precomputed for the same reason — it is read on every
    row of every pass.
    """

    dims: Dimensions

    products: list[Product] = field(default_factory=list)
    stores: list[Store] = field(default_factory=list)
    promotions: list[Promotion] = field(default_factory=list)

    # dimension codes, one entry per source row
    product_code: array = field(default_factory=lambda: array("i"))
    store_code: array = field(default_factory=lambda: array("i"))
    promo_code: array = field(default_factory=lambda: array("i"))
    year: array = field(default_factory=lambda: array("h"))
    month: array = field(default_factory=lambda: array("b"))
    week: array = field(default_factory=lambda: array("b"))
    promoted: array = field(default_factory=lambda: array("b"))

    # measures
    base_quantity: array = field(default_factory=lambda: array("d"))
    actual_quantity: array = field(default_factory=lambda: array("d"))
    base_revenue: array = field(default_factory=lambda: array("d"))
    actual_revenue: array = field(default_factory=lambda: array("d"))
    actual_price: array = field(default_factory=lambda: array("d"))
    total_cost: array = field(default_factory=lambda: array("d"))
    promotion_cost: array = field(default_factory=lambda: array("d"))
    #: True when the source's Base_Quantity is a real "units without the
    #: promotion" figure -- it differs from Actual_Quantity on at least one
    #: promoted row. Then promoted rows are measured against it directly; a file
    #: without the column, or one that merely copies Actual_Quantity into it,
    #: is measured against the nearest ordinary weeks instead (aggregate._expected).
    counterfactual_base: bool = False

    @property
    def row_count(self) -> int:
        return len(self.product_code)

    def model_baseline(self) -> tuple[Any, dict[str, Any]] | None:
        """The LightGBM baseline for every row, in this store's row order, or
        None when the model is switched off or cannot be fitted.

        Fitted once per dataset and cached on disk (baseline_model.load_or_fit),
        then held here for the process. A cold fit is ~25 s on 325k rows, so it
        must never run per request — `filters._to_week_rows` reads this array.

        Failure is not fatal: a dataset with too little clean history has no
        model, and the engine measures against the nearest ordinary weeks
        instead, exactly as it did before. That is why this returns None rather
        than raising.
        """
        if getattr(self, "_model_baseline", "unset") != "unset":
            return self._model_baseline
        result: tuple[Any, dict[str, Any]] | None = None
        # A file with a real Base_Quantity that we are told to prefer never
        # consults the model (aggregate._expected takes its first branch), so
        # fitting one would be ~25 s of pure waste on every cold start.
        skip = self.counterfactual_base and config.BASELINE_PREFER_SOURCE
        if config.BASELINE_ENGINE == "model" and not skip:
            try:
                from app.tpo import baseline_model

                fitted = baseline_model.load_or_fit(self)
                result = (fitted.units, fitted.report)
            except baseline_model.BaselineUnavailable as e:
                print(f"[tpo] baseline model unavailable, using the local mean: {e}")
            except Exception as e:  # lightgbm missing, or a fit that blew up
                print(f"[tpo] baseline model failed, using the local mean: {e!r}")
        self._model_baseline = result
        return result

    def years(self) -> list[int]:
        return sorted(set(self.year))

    def last_week(self, year: int) -> int | None:
        """The last business week of `year` the data holds -- 35 for a year
        whose sales stop in late August. Computed once per store."""
        if not hasattr(self, "_last_week"):
            last: dict[int, int] = {}
            for y, w in zip(self.year, self.week):
                if w > last.get(y, 0):
                    last[y] = w
            self._last_week = last
        return self._last_week.get(year)

    def week_span(self, year: int, week: int) -> int:
        """How many calendar days this business week has in dim_date. Normally
        7; the year-end stub is shorter."""
        return len(self.dims.week_dates.get((year, int(week)), ())) or 7


def _build_store(data_dir: Path) -> FactStore:
    stores = _load_stores(data_dir)
    dims = Dimensions(
        products=_load_products(data_dir),
        stores=stores,
        promotions=_load_promotions(data_dir),
        channels=_load_channels(data_dir, stores),
        week_dates=_load_week_dates(data_dir),
    )
    #: True when dim_promotion was not uploaded, so each offer is described by
    #: the fact row that first mentions it rather than by a dimension row.
    promotions_from_fact = not dims.promotions
    store = FactStore(dims=dims)

    indexes: dict[str, dict[str, int]] = {"product": {}, "store": {}, "promotion": {}}
    tables: dict[str, list[Any]] = {
        "product": store.products, "store": store.stores, "promotion": store.promotions,
    }
    lookups: dict[str, dict[str, Any]] = {
        "product": dims.products, "store": dims.stores, "promotion": dims.promotions,
    }
    placeholders: dict[str, Callable[[str], Any]] = {
        "product": lambda k: Product(k, k, "", "", "", 0),
        "store": lambda k: Store(k, "", "", "", "", "", "", ""),
        "promotion": lambda k: Promotion(k, k, "", ""),
    }
    unknown: dict[str, set[str]] = {"product": set(), "store": set(), "promotion": set()}
    # Sales dates dim_date does not hold. The business week and analytical
    # month both come from that join, so an unresolved date must fail loudly
    # rather than silently fall back and misfile the row.
    unresolved: set[date] = set()
    week_start = dims.week_start
    # The fact carries only what a source system records (see
    # star_dataset.ROLE_COLUMNS["fact"]); the business week is dim_date's, read
    # by the row's Date. A Date the calendar does not hold is unresolved.
    week_of_day = {day: week for (_, week), days in dims.week_dates.items() for day in days}

    def code(kind: str, key: str) -> int:
        index = indexes[kind]
        existing = index.get(key)
        if existing is not None:
            return existing
        record = lookups[kind].get(key)
        if record is None:
            unknown[kind].add(key)
            record = placeholders[kind](key)
        tables[kind].append(record)
        index[key] = len(tables[kind]) - 1
        return index[key]

    for row in _read_csv(data_dir / config.FACT_FILE):
        promotion_id = _promotion_id(row["Promotion_Id"])

        # Without dim_promotion, the first row to mention an offer defines it.
        # Registered before `code()` runs so the offer lands in the lookup as a
        # real Promotion rather than as an id-only placeholder — which would
        # also log it as a missing dimension reference.
        if promotions_from_fact and promotion_id not in dims.promotions:
            name = _clean(row.get("Promotion_Name", "")) or (
                "No Discount" if promotion_id == NO_PROMOTION else promotion_id
            )
            dims.promotions[promotion_id] = Promotion(
                promotion_id=promotion_id,
                name=name,
                type=_clean(row.get("Promotion_Type", "")),
                description=name,
            )

        store.product_code.append(code("product", _clean(row["Product_id"])))
        store.store_code.append(code("store", _clean(row["Store_Id"])))
        store.promo_code.append(code("promotion", promotion_id))
        store.promoted.append(1 if promotion_id != NO_PROMOTION else 0)

        day = _parse_date(row["Date"])
        week = week_of_day.get(day, 0)
        store.year.append(day.year)
        # The analytical month comes from (Year, Week) -> dim_date week start.
        # See Dimensions.week_start for why.
        start = week_start.get((day.year, week))
        if start is None:
            unresolved.add(day)
            store.month.append(day.month)
        else:
            store.month.append(start.month)
        store.week.append(week)

        # Units, list price and selling price are what the source records.
        # Base_Quantity -- expected units WITHOUT the promotion -- is optional:
        # equal to Actual_Quantity on a non-promoted row, and only those rows
        # feed the uplift baseline (aggregate._volume), so a source without it
        # loses nothing. `base_revenue` is the units SOLD at list price, never
        # Base_Quantity x price: Base_Revenue - Actual_Revenue is the discount
        # given away on what was sold, half of Trade Spend.
        quantity = _float(row["Actual_Quantity"])
        base_quantity = row.get("Base_Quantity")
        base_price = _float(row["Base_Price"])
        actual_price = _float(row["Actual_Price"])
        base = quantity if base_quantity in (None, "") else _float(base_quantity)
        store.base_quantity.append(base)
        if promotion_id != NO_PROMOTION and base != quantity:
            store.counterfactual_base = True
        store.actual_quantity.append(quantity)
        store.base_revenue.append(quantity * base_price)
        store.actual_revenue.append(quantity * actual_price)
        store.actual_price.append(actual_price)
        # Cost of goods, however the source states it: `Total_Cost` for the
        # whole row, or `CP` per unit -- which is what a client's pricing master
        # actually holds, quantity being the fact's own column.
        total_cost = row.get("Total_Cost")
        if total_cost in (None, ""):
            total_cost = quantity * _float(row.get("CP", 0))
        else:
            total_cost = _float(total_cost)
        store.total_cost.append(total_cost)
        # Trade spend beyond the discount. Absent on a source that books it per
        # event rather than per line; then trade spend is the discount alone.
        store.promotion_cost.append(_float(row.get("Promotion_Cost", 0) or 0))

    if unresolved:
        shown = ", ".join(d.strftime("%d-%m-%Y") for d in sorted(unresolved)[:10])
        source = (
            f"{config.DIM_FILES['date']}"
            if (data_dir / config.DIM_FILES["date"]).is_file()
            else "the calendar generated from the sales file's own years"
        )
        raise ValueError(
            f"{len(unresolved)} sales date(s) in {config.FACT_FILE} are missing from "
            f"{source}, so their week and month cannot be read: {shown}. "
            f"Every day the sales file uses must appear in the calendar."
        )

    for kind, missing in unknown.items():
        if missing:
            # Loud, but not fatal: a fact row referencing an absent dimension
            # still carries real money, and is better counted under a blank
            # label than silently dropped out of Trade Spend.
            print(
                f"[tpo] warning: {len(missing)} {kind} id(s) in fact_sales are "
                f"missing from its dimension: {sorted(missing)[:5]}"
            )

    return store


@lru_cache(maxsize=1)
def get_store() -> FactStore:
    """The one loaded dataset, cached for the process lifetime."""
    return _build_store(config.DATA_DIR)
