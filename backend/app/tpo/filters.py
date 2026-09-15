"""The shared filter engine — ONE filter state, applied ONCE, before any KPI.

The order is load -> filter -> aggregate -> calculate, never calculate then
filter the displayed values. Every Insights Hub endpoint resolves the same
`FilterState`, so the KPI cards, trend chart, risk alerts, promotion mix and
the two tables are always describing the same scope.

Two row sets come out of a selection, and the distinction matters:

  * `rows_for(state)` — EXACTLY what the user selected. Trade Spend and Margin
    Impact read this, so both describe the population on screen.
  * `baseline_rows_for(state)` — the same selection, plus the non-promoted rows
    the volume chain needs as a counterfactual. Incremental Sales, ROI and PEI
    read this. It differs from `rows_for` only when an Offer or Promotion-type
    filter is active; otherwise they are the same object.

They were previously one set, which let a "New Year Savings 24" filter under
F25 report Margin Impact 56.3% off 6,615 baseline rows while Trade Spend was
zero — six cards describing two different populations.

Filter OPTIONS are generated from the rows a selection actually admits, never
from the dimension tables alone. An option is offered if and only if choosing
it returns at least one row, so the UI cannot present a choice that empties the
dashboard.
"""

from __future__ import annotations

from collections import defaultdict
from dataclasses import dataclass, replace as _replace
from functools import lru_cache
from typing import Any, Iterable, Sequence

from app.tpo.aggregate import WeekRow
from app.tpo.loader import MONTHS, NO_PROMOTION, FactStore, get_store

_ALL_TOKENS = {
    "all", "all channels", "all retailers", "all regions", "all categories",
    "all brands", "all products", "all offers", "all tiers", "all states",
    "all cities", "all distributors", "all months", "all types", "all years",
    "all promotions", "all promotion types",
}


def _norm(values: Iterable[str] | None) -> frozenset[str] | None:
    """A filter list -> a set, or None for "no constraint".

    An empty list and an explicit "All …" both mean unconstrained. Treating an
    empty list as "match nothing" would blank the dashboard the moment a
    dependent dropdown was cleared, and treating "All Channels" as a literal
    value would match no channel at all.
    """
    if not values:
        return None
    cleaned = {
        v.strip() for v in values
        if v and v.strip() and v.strip().lower() not in _ALL_TOKENS
    }
    return frozenset(cleaned) or None


# --- the dimension registry ------------------------------------------------
#
# One entry per filterable dimension, naming where its value comes from. The
# filter pass, the option generator and the cascade all read this table, so a
# new dimension is added in one place rather than three.

#: Dimensions whose value hangs off the STORE.
_STORE_DIMS: dict[str, Any] = {
    "channel": lambda s: s.channel_id,
    "retailer": lambda s: s.retailer,
    "region": lambda s: s.region,
    "state": lambda s: s.state,
    "city": lambda s: s.city,
    "tier": lambda s: s.tier,
    "distributor": lambda s: s.distributor,
}

#: Dimensions whose value hangs off the PRODUCT.
_PRODUCT_DIMS: dict[str, Any] = {
    "category": lambda p: p.category,
    "brand": lambda p: p.brand,
    "product": lambda p: p.product_id,
}

#: Dimensions whose value hangs off the PROMOTION.
_PROMOTION_DIMS: dict[str, Any] = {
    "promotion": lambda p: p.promotion_id,
    "promotion_type": lambda p: p.type,
}

#: Dimensions read straight off the fact row.
_ROW_DIMS = ("year", "month")

DIMENSIONS: tuple[str, ...] = (
    *_ROW_DIMS, *_STORE_DIMS, *_PRODUCT_DIMS, *_PROMOTION_DIMS,
)


@dataclass(frozen=True)
class FilterState:
    """The single filter contract. Hashable so resolved row sets can be cached.

    `week` is the business week number carried on the fact row, the same one
    `WeekRow.week_key` is built from. It is a SCALAR like year and month, not a
    list dimension, so it never appears in `DIMENSIONS` and adds no filter-option
    list to the UI.

    `year`/`month` are the real calendar values from the data (2024, 2025 and
    1-12). The F24/F25 labels the UI shows are a display concern applied in
    app/tpo/formatting.py — no dataset field is renamed to produce them.
    """

    year: int | None = None
    month: int | None = None
    week: int | None = None            # business week number, 1-53
    channel: frozenset[str] | None = None      # Channel_Id, e.g. "CH002"
    retailer: frozenset[str] | None = None     # dim_geo_store.Retailer
    region: frozenset[str] | None = None
    state: frozenset[str] | None = None
    city: frozenset[str] | None = None
    tier: frozenset[str] | None = None
    distributor: frozenset[str] | None = None
    category: frozenset[str] | None = None
    brand: frozenset[str] | None = None        # the Brand Form
    product: frozenset[str] | None = None      # Product_id
    promotion: frozenset[str] | None = None    # Promotion_Id, the Offer
    promotion_type: frozenset[str] | None = None

    @classmethod
    def build(cls, year: int | None = None, month: int | None = None, week: int | None = None, **lists: Sequence[str] | None) -> "FilterState":
        unknown = set(lists) - set(DIMENSIONS)
        if unknown:
            raise ValueError(f"Unknown filter dimension(s): {sorted(unknown)}")
        return cls(year=year, month=month, week=week, **{k: _norm(v) for k, v in lists.items()})

    def replace(self, **changes: Any) -> "FilterState":
        return _replace(self, **changes)

    def constrained(self, dimension: str) -> bool:
        return getattr(self, dimension) is not None

    def comparison(self, store: FactStore) -> "FilterState | None":
        """The SAME dimensional filters over the comparison period.

        Only the year moves; every other constraint carries across unchanged.
        Comparing a filtered current period against unfiltered history would be
        comparing two different populations.

        None when there is no earlier year in the data — the earliest year
        loaded has no predecessor, and its deltas must render as undefined
        rather than as a fabricated 0%.
        """
        if self.year is None:
            return None
        previous = self.year - 1
        return self.replace(year=previous) if previous in set(store.years()) else None

    def widened_to_brand_form(self) -> "FilterState":
        """The same selection with the Product filter lifted to its Brand Form.

        Cannibalization measures a promoted SKU against its pack-size
        neighbours; a Product filter would have removed exactly those
        neighbours. Widened to the SKU's own Brand Form rather than to the
        whole catalogue — the neighbours live there and nowhere else.
        """
        if not self.product:
            return self
        store = get_store()
        forms = {
            store.dims.products[pid].brand
            for pid in self.product
            if pid in store.dims.products
        }
        brands = frozenset(forms) if forms else self.brand
        return self.replace(product=None, brand=brands)

    def applied(self) -> dict[str, Any]:
        """The active constraints, for the response meta block."""
        out: dict[str, Any] = {}
        for name in DIMENSIONS:
            value = getattr(self, name)
            if value:
                out[name] = value if isinstance(value, int) else sorted(value)
        return out


# --- code-level predicate masks --------------------------------------------
#
# Store, product and promotion attributes are constant per code, and there are
# only 55 / 36 / 16 of them. Evaluating each dimension's predicate once per
# CODE — rather than once per row across 205,920 rows — turns the row pass into
# three array lookups and two integer comparisons.


def _bit_index() -> dict[str, int]:
    return {name: 1 << i for i, name in enumerate(DIMENSIONS)}


BITS = _bit_index()


def _fail_masks(store: FactStore, state: FilterState) -> tuple[list[int], list[int], list[int]]:
    """Per code, a bitmask of which dimensions that code FAILS.

    Zero means the code satisfies every constraint that applies to it.
    """
    store_masks = []
    for s in store.stores:
        mask = 0
        for name, pick in _STORE_DIMS.items():
            allowed = getattr(state, name)
            if allowed is not None and pick(s) not in allowed:
                mask |= BITS[name]
        store_masks.append(mask)

    product_masks = []
    for p in store.products:
        mask = 0
        for name, pick in _PRODUCT_DIMS.items():
            allowed = getattr(state, name)
            if allowed is not None and pick(p) not in allowed:
                mask |= BITS[name]
        product_masks.append(mask)

    promotion_masks = []
    for p in store.promotions:
        mask = 0
        for name, pick in _PROMOTION_DIMS.items():
            allowed = getattr(state, name)
            if allowed is not None and pick(p) not in allowed:
                mask |= BITS[name]
        promotion_masks.append(mask)

    return store_masks, product_masks, promotion_masks


def _matching_indices(store: FactStore, state: FilterState, *, keep_baseline: bool) -> list[int]:
    """Indices of the fact rows the filter admits.

    `keep_baseline` re-admits non-promoted rows that an Offer or Promotion-type
    filter would otherwise exclude. The volume chain needs them — they are the
    counterfactual an uplift is measured against — but Trade Spend and Margin
    Impact must not see rows the user did not select.
    """
    store_masks, product_masks, promotion_masks = _fail_masks(store, state)
    promo_filtered = state.promotion is not None or state.promotion_type is not None

    year, month, week = state.year, state.month, state.week
    year_col, month_col, week_col = store.year, store.month, store.week
    product_col, store_col, promo_col = store.product_code, store.store_code, store.promo_code
    promoted_col = store.promoted

    out: list[int] = []
    append = out.append
    for i in range(store.row_count):
        if year is not None and year_col[i] != year:
            continue
        if month is not None and month_col[i] != month:
            continue
        if week is not None and week_col[i] != week:
            # THE BASELINE IS READ FROM THE WEEKS THE PROMOTION WAS NOT RUNNING,
            # so a week filter must not reach it. Scoped to the single week an
            # offer ran, this left the baseline set holding nothing but the
            # promoted row itself: Incremental Sales computed as 0 and ROI came
            # back as exactly -100% — not a promotion that returned nothing, but
            # one with nothing to measure against. The same drill-down without
            # the week reports -3.6%, which is the figure the risk alert that
            # launched it already showed.
            #
            # This is the lift `neighbour_sales_decline` already performs for the
            # same reason, in the same commit that introduced the week filter:
            # "a week filter left on that pass leaves no such weeks". Incremental
            # Sales, ROI and PEI need it just as much, and only the baseline pass
            # takes it — `rows_for` still answers for the week the user selected,
            # so Trade Spend and Margin Impact are untouched.
            if not (keep_baseline and promo_filtered and not promoted_col[i]):
                continue
        if store_masks[store_col[i]]:
            continue
        if product_masks[product_col[i]]:
            continue
        if promotion_masks[promo_col[i]]:
            # A non-promoted row survives an Offer filter only for the baseline
            # row set, and only because the uplift has nothing to be measured
            # against otherwise.
            if not (keep_baseline and promo_filtered and not promoted_col[i]):
                continue
        append(i)
    return out


def _to_week_rows(store: FactStore, indices: Sequence[int]) -> tuple[WeekRow, ...]:
    """Filtered fact rows -> the KPI engine's grain.

    Grouped on (product, channel, week, offer). Stores are POOLED inside that
    group — one product's week in one channel is one observation no matter how
    many outlets carried it — but OFFERS are not: a week running both a 5% and
    a 10% promotion is two promotion events, and merging them would report an
    event that never ran.
    """
    acc: dict[tuple[int, str, str, int], dict[str, float]] = {}
    for i in indices:
        product = store.products[store.product_code[i]]
        st = store.stores[store.store_code[i]]
        promo_code = store.promo_code[i]
        week_key = f"{store.year[i]}-W{store.week[i]:02d}"
        key = (store.product_code[i], st.channel_id, week_key, promo_code)
        group = acc.get(key)
        if group is None:
            group = acc[key] = {
                "base_quantity": 0.0, "actual_quantity": 0.0, "actual_revenue": 0.0,
                "total_cost": 0.0, "promotion_cost": 0.0, "discount_value": 0.0,
                "actual_price_sum": 0.0, "transaction_count": 0.0,
                "month": float(store.month[i]),
            }
        group["base_quantity"] += store.base_quantity[i]
        group["actual_quantity"] += store.actual_quantity[i]
        group["actual_revenue"] += store.actual_revenue[i]
        group["total_cost"] += store.total_cost[i]
        group["promotion_cost"] += store.promotion_cost[i]
        group["discount_value"] += store.base_revenue[i] - store.actual_revenue[i]
        group["actual_price_sum"] += store.actual_price[i]
        group["transaction_count"] += 1

    rows: list[WeekRow] = []
    for (product_code, channel_id, week_key, promo_code), g in acc.items():
        product = store.products[product_code]
        promotion = store.promotions[promo_code]
        rows.append(WeekRow(
            product_id=product.product_id,
            channel_id=channel_id,
            brand_form=product.brand,
            product_rank=product.rank,
            week_key=week_key,
            month=int(g["month"]),
            is_promoted=promotion.promotion_id != NO_PROMOTION,
            promotion_id=promotion.promotion_id,
            base_quantity=g["base_quantity"],
            actual_quantity=g["actual_quantity"],
            actual_revenue=g["actual_revenue"],
            total_cost=g["total_cost"],
            promotion_cost=g["promotion_cost"],
            discount_value=g["discount_value"],
            actual_price_sum=g["actual_price_sum"],
            transaction_count=int(g["transaction_count"]),
        ))
    rows.sort(key=lambda r: (r.week_key, r.product_id, r.channel_id, r.promotion_id))
    return tuple(rows)


@lru_cache(maxsize=128)
def rows_for(state: FilterState) -> tuple[WeekRow, ...]:
    """EXACTLY the rows the filter selects, at KPI grain.

    Trade Spend and Margin Impact read this, so both describe the population
    the user chose and nothing else.
    """
    store = get_store()
    return _to_week_rows(store, _matching_indices(store, state, keep_baseline=False))


@lru_cache(maxsize=128)
def baseline_rows_for(state: FilterState) -> tuple[WeekRow, ...]:
    """The selection plus the non-promoted rows the volume chain needs.

    Identical to `rows_for` unless an Offer or Promotion-type filter is active.
    Incremental Sales, ROI and PEI read this; every one of them is defined
    against a non-promotional baseline and would be undefined without it.
    """
    if state.promotion is None and state.promotion_type is None:
        return rows_for(state)
    store = get_store()
    return _to_week_rows(store, _matching_indices(store, state, keep_baseline=True))


# --- filter options --------------------------------------------------------


@lru_cache(maxsize=64)
def _present_values(state: FilterState) -> dict[str, set[str]]:
    """For each dimension, the values that are actually reachable.

    A dimension's own constraint is LIFTED when computing its own list, so the
    control still offers the value currently selected and its siblings; every
    other constraint stays in force. An option therefore appears if and only if
    picking it returns at least one row.

    One pass. A row is scored by how many constraints it fails: none, and it
    contributes to every dimension; exactly one, and it contributes only to
    that dimension's lifted list. Rows failing two or more contribute nowhere,
    which is why the lists narrow together rather than one at a time.
    """
    store = get_store()
    store_masks, product_masks, promotion_masks = _fail_masks(store, state)
    year_bit, month_bit = BITS["year"], BITS["month"]
    year, month = state.year, state.month

    # Flags rather than sets: codes are small dense integers, so a bytearray
    # write is O(1) and avoids hashing on every one of 205,920 rows.
    n_store, n_product, n_promo = len(store.stores), len(store.products), len(store.promotions)
    seen_store = {d: bytearray(n_store) for d in (*_STORE_DIMS, "__all__")}
    seen_product = {d: bytearray(n_product) for d in (*_PRODUCT_DIMS, "__all__")}
    seen_promo = {d: bytearray(n_promo) for d in (*_PROMOTION_DIMS, "__all__")}
    seen_year: dict[str, set[int]] = defaultdict(set)
    seen_month: dict[str, set[int]] = defaultdict(set)

    for i in range(store.row_count):
        mask = store_masks[store.store_code[i]] | product_masks[store.product_code[i]] \
            | promotion_masks[store.promo_code[i]]
        if year is not None and store.year[i] != year:
            mask |= year_bit
        if month is not None and store.month[i] != month:
            mask |= month_bit
        if mask == 0:
            key = "__all__"
        elif mask & (mask - 1):
            continue  # fails two or more constraints — reachable from nowhere
        else:
            key = _DIM_OF_BIT[mask]

        # A fully-passing row feeds every dimension's list. A row failing only
        # dimension D feeds D's list alone, and only from the side D reads:
        # Category is a product attribute, so it records a product code.
        if key == "__all__":
            seen_store["__all__"][store.store_code[i]] = 1
            seen_product["__all__"][store.product_code[i]] = 1
            seen_promo["__all__"][store.promo_code[i]] = 1
            seen_year["__all__"].add(store.year[i])
            seen_month["__all__"].add(store.month[i])
        elif key in seen_store:
            seen_store[key][store.store_code[i]] = 1
        elif key in seen_product:
            seen_product[key][store.product_code[i]] = 1
        elif key in seen_promo:
            seen_promo[key][store.promo_code[i]] = 1
        elif key == "year":
            seen_year["year"].add(store.year[i])
        elif key == "month":
            seen_month["month"].add(store.month[i])

    # Lifting a dimension means BOTH the rows that fail only it and the rows
    # that fail nothing — the latter satisfy the lifted constraint as well, and
    # they are where the currently-selected value lives. Reading the
    # fails-only-D bucket alone dropped the active selection out of its own
    # dropdown.
    def _lifted(buckets: dict[str, bytearray], dim: str) -> list[int]:
        everything = buckets["__all__"]
        if not state.constrained(dim):
            return [c for c, on in enumerate(everything) if on]
        own = buckets[dim]
        return [c for c in range(len(everything)) if everything[c] or own[c]]

    def store_values(dim: str) -> set[str]:
        pick = _STORE_DIMS[dim]
        return {pick(store.stores[c]) for c in _lifted(seen_store, dim)}

    def product_values(dim: str) -> set[str]:
        pick = _PRODUCT_DIMS[dim]
        return {pick(store.products[c]) for c in _lifted(seen_product, dim)}

    def promo_values(dim: str) -> set[str]:
        pick = _PROMOTION_DIMS[dim]
        return {
            pick(store.promotions[c]) for c in _lifted(seen_promo, dim)
            if store.promotions[c].is_promotional
        }

    values: dict[str, set[str]] = {}
    for dim in _STORE_DIMS:
        values[dim] = store_values(dim)
    for dim in _PRODUCT_DIMS:
        values[dim] = product_values(dim)
    for dim in _PROMOTION_DIMS:
        values[dim] = promo_values(dim)
    values["year"] = {str(v) for v in (seen_year["__all__"] | seen_year["year"])}
    values["month"] = {str(v) for v in (seen_month["__all__"] | seen_month["month"])}
    return values


#: bit -> dimension name, for decoding a single-failure mask.
_DIM_OF_BIT = {BITS[name]: name for name in DIMENSIONS}


def options_for(state: FilterState) -> dict[str, Any]:
    """Dependent option lists for the current selection.

    Every list is derived from the rows the selection admits, so:

      * no duplicates — values are collected into a set and sorted;
      * no blanks — an empty dimension value (B2B carries no Retailer) is
        dropped, and `retailer_available` tells the UI to hide the control
        rather than show an empty dropdown;
      * no dead options — an option is present only if picking it returns a
        row. Selecting F25 no longer offers the six 2024-only seasonal offers,
        and selecting Region = South no longer offers the 17 retailers that
        trade nowhere near it.
    """
    store = get_store()
    present = _present_values(state)
    clean = lambda values: sorted(v for v in values if v and v.strip())

    retailers = clean(present["retailer"])
    months = sorted(int(m) for m in present["month"])
    years = sorted(int(y) for y in present["year"])

    products = [
        store.dims.products[pid] for pid in present["product"] if pid in store.dims.products
    ]
    offers = [
        store.dims.promotions[pid] for pid in present["promotion"] if pid in store.dims.promotions
    ]

    return {
        "years": years,
        "months": [{"code": str(m), "name": MONTHS[m - 1]} for m in months],
        "channels": [
            {"code": code, "name": store.dims.channels[code].name if code in store.dims.channels else code}
            for code in clean(present["channel"])
        ],
        "retailers": [{"code": r, "name": r} for r in retailers],
        # B2B (CH005) carries a blank Retailer on every store, so there is
        # nothing to choose from and the control hides instead of showing empty.
        "retailer_available": bool(retailers),
        "regions": clean(present["region"]),
        "states": clean(present["state"]),
        "cities": clean(present["city"]),
        "tiers": clean(present["tier"]),
        "distributors": clean(present["distributor"]),
        "categories": clean(present["category"]),
        "brands": clean(present["brand"]),
        "products": [
            {"code": p.product_id, "name": p.name.strip()}
            for p in sorted(products, key=lambda p: (p.brand, p.rank))
        ],
        # Labelled by dim_promotion.Promotion_Description via Promotion.label —
        # the one unique, shared name. Promotion_Name is reused across the
        # seasonal calendar and produced six identical "Buy3Get1" entries.
        "offers": [
            {"code": p.promotion_id, "name": p.label, "type": p.type}
            for p in sorted(offers, key=lambda p: (p.type, p.label))
        ],
        "promotion_types": clean(present["promotion_type"]),
    }
