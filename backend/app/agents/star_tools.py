"""
Star-schema analysis tools for the investigation agents.

The agents do NOT recompute promotion economics here. Every number comes
from app/tpo/service.py — the same engine the Insights Hub renders and
that backend/tests covers with 289 tests. That is deliberate: incremental
sales are measured against a per-(product, channel) baseline derived from
non-promoted rows, not a naive `actual - base`. Reimplementing that in
pandas would quietly drift, and the Investigations tab would then contradict
the Insights Hub on the same dataset — the fastest way to make an
analytics product untrustworthy.

So this module is a thin, agent-shaped adapter over that engine:

  * `schema_summary()`  what the planner is allowed to filter and group by,
                        with the dataset's real values.
  * `run_analysis()`    one breakdown, optionally narrowed to a segment —
                        which is how interaction effects are found.
  * `segment_kpis()`    headline KPIs for a selection.

Note on additivity, carried over from service.breakdown's contract: Trade
Spend sums back to the headline; Incremental Sales does not, because its
baseline is re-derived per selection. Groups are therefore a RANKING, never
a composition, and the specialist prompt says so.
"""
import copy
import json
import threading
from typing import Any, Callable, TypeVar

from app.tpo import service
from app.tpo.filters import FilterState
from app.tpo.loader import get_store

T = TypeVar("T")

# --- memo ---------------------------------------------------------------------
#
# WHY. An investigation's six specialists each pull their own data, in
# parallel, and most of what they pull is the same: four of six ask for the
# segment's KPIs beside the whole business's, three ask for a whole-business
# ROI breakdown by channel, region or mechanic. Every one of those is a full
# pass over the fact table (~325k rows), the whole-business ones are
# identical for every question ever asked, and under the GIL six threads
# doing them at once serialise -- so the model calls could not start until
# ~15s of arithmetic had finished, out of a ~25s run. Measured: benchmark's
# fetch 6-8s, mechanic efficiency's 5s, geography's 2-3s, all before a byte
# reached the model.
#
# WHAT. The tool results are memoised on their arguments, keyed to the
# LOADED STORE: a dataset swap replaces the `get_store` object, and a key
# that carries its identity cannot survive it, so nothing here can serve a
# figure from a dataset that is no longer loaded. Per-key gates mean six
# threads asking for the same table compute it once and share it. Results are
# deep-copied out, so a caller trimming or annotating its copy cannot hand a
# changed table to the next.
_MEMO: dict[tuple[Any, ...], Any] = {}
_MEMO_STORE_ID: int | None = None
_MEMO_LOCK = threading.Lock()
_INFLIGHT: dict[tuple[Any, ...], threading.Lock] = {}


def _memo(kind: str, filters: dict[str, Any] | None, *parts: Any, compute: Callable[[], T]) -> T:
    global _MEMO_STORE_ID
    store_id = id(get_store())
    key = (kind, json.dumps(filters or {}, sort_keys=True, default=str), *parts)
    with _MEMO_LOCK:
        if _MEMO_STORE_ID != store_id:
            _MEMO.clear()
            _INFLIGHT.clear()
            _MEMO_STORE_ID = store_id
        if key in _MEMO:
            return copy.deepcopy(_MEMO[key])
        gate = _INFLIGHT.setdefault(key, threading.Lock())
    with gate:
        with _MEMO_LOCK:
            if key in _MEMO:
                return copy.deepcopy(_MEMO[key])
        value = compute()
        with _MEMO_LOCK:
            _MEMO[key] = value
            _INFLIGHT.pop(key, None)
        return copy.deepcopy(value)


def warm_tool_memo() -> None:
    """Compute the whole-business tables every investigation reads, so the
    first run after a start does not pay for them while the user watches the
    progress card. Called from the startup warmup; safe to call again."""
    schema_summary()
    segment_kpis({})
    for by in ("channel", "region", "promotion_mechanic"):
        run_analysis({}, by, "roi")

# Mirrors service.BREAKDOWN_DIMENSIONS / BREAKDOWN_METRICS. Read from the
# service rather than restated, so a change there cannot silently desync.
BREAKDOWN_DIMENSIONS: tuple[str, ...] = tuple(service.BREAKDOWN_DIMENSIONS)
BREAKDOWN_METRICS: tuple[str, ...] = tuple(service.BREAKDOWN_METRICS)

# FilterState fields an agent may set. `tier` and `product` are allowed but
# rarely useful to a planner; kept for completeness.
FILTER_FIELDS: tuple[str, ...] = (
    "year", "month", "week", "channel", "retailer", "region", "state", "city",
    "tier", "distributor", "category", "brand", "product", "promotion",
    "promotion_type",
)

_LIST_FIELDS = {f for f in FILTER_FIELDS if f not in ("year", "month", "week")}


def _codes(values: list[Any]) -> list[str]:
    """Filter option lists are either bare strings or {code,name} dicts."""
    out = []
    for v in values:
        out.append(str(v["code"]) if isinstance(v, dict) else str(v))
    return out


def schema_summary() -> dict[str, Any]:
    """What the planning agent needs to choose filters and breakdowns: the
    dimensions that exist and the actual values they take."""
    opts = service.filters(FilterState())
    return {
        "row_count": None,  # not exposed by the service; unused by the planner
        "filter_dimensions": {
            "year": opts.get("years", []),
            "month": [m["code"] for m in opts.get("months", [])],
            "channel": [{"code": c["code"], "name": c["name"]} for c in opts.get("channels", [])],
            "region": _codes(opts.get("regions", [])),
            "state": _codes(opts.get("states", [])),
            "city": _codes(opts.get("cities", [])),
            "tier": _codes(opts.get("tiers", [])),
            "retailer": _codes(opts.get("retailers", []))[:30],
            "distributor": _codes(opts.get("distributors", [])),
            "category": _codes(opts.get("categories", [])),
            "brand": _codes(opts.get("brands", [])),
            "promotion_type": _codes(opts.get("promotion_types", [])),
            # `mechanic` is Promotion_Name -- "Buy3Get1", "20% Discount" -- which
            # the seasonal calendar shares across offers, so a question about
            # "Buy3Get1" can be scoped to every offer that runs it.
            "offers": [
                {"code": o["code"], "name": o["name"], "type": o.get("type"),
                 "mechanic": _mechanic_of(o["code"])}
                for o in opts.get("offers", [])
            ],
            "products": [{"code": p["code"], "name": p["name"]} for p in opts.get("products", [])],
        },
        "breakdown_dimensions": list(BREAKDOWN_DIMENSIONS),
        "breakdown_metrics": list(BREAKDOWN_METRICS),
        "year_labels": opts.get("year_labels", {}),
    }


def _bounded_int(value: Any, low: int, high: int) -> int | None:
    """Accept an integer only inside a sensible range, else drop it.

    A planner reading "week 41 of 2025" will happily emit month=41, and the
    engine's formatter indexes a 12-element month list — so an unchecked value
    becomes an IndexError deep inside code that is not ours. Validating at this
    boundary keeps malformed model output from ever reaching the KPI engine.
    """
    try:
        n = int(value)
    except (TypeError, ValueError):
        return None
    return n if low <= n <= high else None


#: Dimensions whose options carry a display name beside the code. A planner
#: shown `{"code": "P13-240ct", "name": "Outdoor Fresh Dryer Sheets 240 ct"}`
#: writes the NAME often enough that a scope built from it selected nothing.
_NAMED_DIMENSIONS = {"channel": "channels", "promotion": "offers", "product": "products"}


def _mechanic_of(code: str) -> str | None:
    promotion = get_store().dims.promotions.get(code)
    return promotion.name.strip() if promotion and promotion.name else None


def resolve_codes(raw: dict[str, Any] | None) -> dict[str, Any]:
    """Planner filter values written as display names, turned back into codes.

    Only the named dimensions are touched, only a value that is not already a
    code is looked up, and the lookup is exact after case-folding -- a value
    that matches neither a code nor a name is left as written, so the
    empty-scope guard downstream still reports it rather than a guess.
    """
    raw = dict(raw or {})
    options = service.filters(FilterState())
    for field, option_key in _NAMED_DIMENSIONS.items():
        values = raw.get(field)
        if not values:
            continue
        if isinstance(values, str):
            values = [values]
        if not isinstance(values, list):
            continue
        entries = [o for o in options.get(option_key, []) if isinstance(o, dict)]
        codes = {str(o["code"]) for o in entries}
        by_name = {str(o.get("name", "")).strip().casefold(): str(o["code"]) for o in entries}
        # An offer MECHANIC ("Buy3Get1", "20% Discount") is shared by several
        # seasonal offers; naming it means all of them.
        by_mechanic: dict[str, list[str]] = {}
        if field == "promotion":
            for o in entries:
                mechanic = _mechanic_of(str(o["code"]))
                if mechanic:
                    by_mechanic.setdefault(mechanic.casefold(), []).append(str(o["code"]))
        resolved: list[str] = []
        for v in values:
            key = str(v).strip().casefold()
            if str(v) in codes:
                resolved.append(str(v))
            elif key in by_name:
                resolved.append(by_name[key])
            elif key in by_mechanic:
                resolved.extend(by_mechanic[key])
            else:
                resolved.append(v)
        raw[field] = list(dict.fromkeys(resolved))
    # A SKU implies its brand and category, and an offer implies its promotion
    # type: a planner that names both can only agree with itself or contradict
    # itself, and it contradicted itself often enough (brand "L_Diapers" beside
    # a Taped Diapers SKU) to empty the scope. The most specific filter wins.
    if raw.get("product"):
        raw.pop("brand", None)
        raw.pop("category", None)
    if raw.get("promotion"):
        raw.pop("promotion_type", None)
    return raw


def offers_and_products_named_in(question: str) -> dict[str, list[str]]:
    """The offers, mechanics and SKUs a question names verbatim, as codes.

    THE BACKSTOP behind the planner. A question that says "Buy3Get1" or
    "Cruisers Diapers Size 3 84 ct" is about that thing whatever the planner
    made of it, and the planner leaves `promotion` unset often enough for a
    mechanic that this is checked deterministically: every offer label,
    mechanic and product name in the dimension tables is looked for in the
    question, longest first so "Diwali Special 25" is not also read as the
    "25" in another name. Case-insensitive, whole-string containment, nothing
    fuzzy -- a name that is not literally in the question is not matched.
    """
    text = " ".join(question.casefold().split())
    if not text:
        return {}
    options = service.filters(FilterState())
    found: dict[str, list[str]] = {}
    offers = [o for o in options.get("offers", []) if isinstance(o, dict)]
    names: list[tuple[str, list[str]]] = []
    for o in offers:
        names.append((str(o.get("name", "")).strip().casefold(), [str(o["code"])]))
    by_mechanic: dict[str, list[str]] = {}
    for o in offers:
        mechanic = _mechanic_of(str(o["code"]))
        if mechanic:
            by_mechanic.setdefault(mechanic.casefold(), []).append(str(o["code"]))
    names.extend(by_mechanic.items())
    for name, codes in sorted(names, key=lambda n: -len(n[0])):
        if name and name in text:
            found.setdefault("promotion", [])
            found["promotion"].extend(c for c in codes if c not in found["promotion"])
    products = [p for p in options.get("products", []) if isinstance(p, dict)]
    for p in sorted(products, key=lambda p: -len(str(p.get("name", "")))):
        name = " ".join(str(p.get("name", "")).casefold().split())
        if name and name in text:
            found.setdefault("product", []).append(str(p["code"]))
    return found


def build_filter_state(raw: dict[str, Any] | None) -> FilterState:
    """Build a FilterState from planner output, ignoring anything unknown or
    out of range so malformed model output can't crash a run."""
    raw = raw or {}
    lists: dict[str, list[str]] = {}
    for field in _LIST_FIELDS:
        value = raw.get(field)
        if value in (None, "", []):
            continue
        if isinstance(value, str):
            value = [value]
        if isinstance(value, list) and value:
            lists[field] = [str(v) for v in value]
    return FilterState.build(
        year=_bounded_int(raw.get("year"), 1900, 2200),
        month=_bounded_int(raw.get("month"), 1, 12),
        week=_bounded_int(raw.get("week"), 1, 53),
        **lists,
    )


def _compact_kpis(payload: dict[str, Any]) -> dict[str, Any]:
    """service.kpis() returns {"kpis": {name: {value, display_value, delta, …}}}.

    Keep the raw `value` (and the delta when there's a comparison period) and
    drop the pre-formatted strings — the model should reason on numbers, not
    on "₹147.7 Cr", and formatting is a presentation concern that belongs in
    app/tpo/formatting.py.
    """
    metrics = (payload or {}).get("kpis", payload) or {}
    out: dict[str, Any] = {}
    for key, metric in metrics.items():
        if not isinstance(metric, dict):
            continue
        if metric.get("available") is False:
            continue
        if "value" in metric:
            out[key] = metric["value"]
            if metric.get("delta") is not None:
                out[f"{key}_delta_pct"] = metric["delta"]
    return out


def _compact_group(group: dict[str, Any]) -> dict[str, Any]:
    """Breakdown groups are flat, with a `_display` string beside each number.
    Keep the numbers and the label."""
    out: dict[str, Any] = {"group": group.get("label") or group.get("code")}
    for key, value in group.items():
        if key in ("code", "label") or key.endswith("_display"):
            continue
        if isinstance(value, (int, float)) or value is None:
            out[key] = value
    return out


def segment_kpis(filters: dict[str, Any] | None = None) -> dict[str, Any]:
    return _memo("segment_kpis", filters, compute=lambda: _segment_kpis(filters))


def _segment_kpis(filters: dict[str, Any] | None) -> dict[str, Any]:
    state = build_filter_state(filters)
    return _compact_kpis(service.kpis(state))


def run_analysis(
    filters: dict[str, Any] | None,
    by: str,
    metric: str = "incremental_sales",
    limit: int = 12,
) -> dict[str, Any]:
    """One breakdown, optionally scoped to a segment.

    Passing `filters` AND `by` together is what surfaces interactions: narrow
    to Modern Trade / South, then break down by mechanic, and a problem that
    is invisible in either dimension's overall average becomes obvious.
    """
    return _memo(
        "run_analysis", filters, by, metric, limit,
        compute=lambda: _run_analysis(filters, by, metric, limit),
    )


def _run_analysis(
    filters: dict[str, Any] | None, by: str, metric: str, limit: int
) -> dict[str, Any]:
    if by not in BREAKDOWN_DIMENSIONS:
        return {"error": f"unsupported breakdown dimension {by!r}"}
    if metric not in BREAKDOWN_METRICS:
        metric = "incremental_sales"

    state = build_filter_state(filters)
    try:
        result = service.breakdown(state, by=by, metric=metric, limit=limit)
    except ValueError as e:
        return {"error": str(e)}
    except Exception as e:  # a bad filter combination shouldn't kill the run
        return {"error": f"{type(e).__name__}: {e}"}

    groups = [_compact_group(g) for g in (result.get("groups") or [])]
    if not groups:
        return {"error": "no rows matched this filter combination"}

    return {
        "grouped_by": by,
        "ranked_by": metric,
        "applied_filters": filters or {},
        "note": (
            "roi is a multiple of trade spend at two decimals (1.00 = break-even, 1.50 = the target "
            "hurdle). Trade Spend sums back "
            "to the total; Incremental Sales does not (its baseline is re-derived "
            "per selection). Treat groups as a ranking, not a composition."
        ),
        "selection_totals": segment_kpis(filters),
        "truncated": bool(result.get("truncated")),
        "total_groups": result.get("total_groups"),
        "groups": groups,
    }


# --- neighbour cannibalization ---------------------------------------------


def neighbour_sales_decline(filters: dict[str, Any] | None = None) -> dict[str, Any]:
    return _memo("neighbour_sales_decline", filters, compute=lambda: _neighbour_sales_decline(filters))


def _neighbour_sales_decline(filters: dict[str, Any] | None = None) -> dict[str, Any]:
    """Did products sharing the promoted product's BRAND FORM lose sales while
    it was on promotion?

    AN OPERATIONAL INDICATOR, NOT A CAUSAL CLAIM. It reports what neighbouring
    sales did during the promotion weeks against their own ordinary level. A
    decline is consistent with cannibalization; it does not establish that the
    promotion caused it, and the payload says so in `causality_note`.

    NOT A SECOND KPI. `aggregate.cannibalization_detail` -- the Insights Hub's
    validated Cannibalization Rate -- is untouched and still travels beside this
    on the same finding. That one asks "what share of the promoted SKU's uplift
    came out of its ADJACENT pack sizes", in QUANTITY, at +/-1 rank. This asks
    the question the investigation brief poses: "did the brand form's OTHER
    products sell less, in MONEY, while this promotion ran". Two questions, two
    answers; the finding carries both rather than replacing one with the other.

    WHERE EVERY INPUT COMES FROM, so none of it is invented:

      * BRAND FORM  `Product.brand` -- the field app/tpo/loader.py documents as
        "the Brand Form, 4 pack sizes share one". This dataset carries no
        separate Form column; the Brand Form IS the brand+form grouping.
      * NEIGHBOURS  every other product in that brand form within the scope.
        The promoted product is excluded by construction.
      * PERIOD      the business weeks the promoted product actually carried a
        promotion, read off the rows. No date arithmetic, no fixed window.
    DIRECTION: the payload reports `neighbour_sales_change_pct`, defined as
    (promotion-period sales - baseline) / baseline x 100. NEGATIVE is a decline
    and is the cannibalization signal; POSITIVE is growth and means no decline
    was detected.

      * BASELINE    each neighbour's own mean revenue per week over the weeks it
        was NOT promoted and the promotion was NOT running -- the convention
        `aggregate._sku_baselines` already uses for quantity, read on revenue.
        No new baseline model.

    TWO PASSES, BECAUSE TWO DIFFERENT POPULATIONS ARE NEEDED. The promotion
    under investigation is identified in the SELECTED scope; the neighbours are
    by definition not on that promotion, so a Promotion filter would hide every
    one of them, exactly as a Product filter would. So:

      pass 1  the scope as selected  -> which product is promoted, and in which
                                        business weeks
      pass 2  the same scope with the Product filter lifted to its Brand Form
              (, which exists for exactly
              this) and the Promotion filter dropped -> the neighbours

    Nothing else about the selection is relaxed: year, channel, region, retailer
    and the rest still bound both passes.
    """
    from app.tpo.filters import rows_for
    from app.tpo.loader import get_store

    selected = build_filter_state(filters)
    scoped = rows_for(selected)
    if not scoped:
        return {"available": False, "reason": "No rows in this scope."}

    promoted_ids = sorted({r.product_id for r in scoped if r.is_promoted})
    if not promoted_ids:
        return {"available": False, "reason": "No promotion in this scope."}

    # The promotion(s) actually running, named through dim_promotion the way
    # `Promotion.label` already resolves them everywhere else — no second
    # naming rule, and an id with no dimension row keeps its id.
    promotions = get_store().dims.promotions
    promo_ids = sorted({r.promotion_id for r in scoped if r.is_promoted})
    promo_names = [
        promotions[p].label if p in promotions else p for p in promo_ids
    ]

    # The promotion period: the weeks the SELECTED promotion actually ran, per
    # brand form. Read off the rows, never computed from a date.
    weeks_by_form: dict[str, set[str]] = {}
    for r in scoped:
        if r.is_promoted:
            weeks_by_form.setdefault(r.brand_form, set()).add(r.week_key)

    # WEEK IS LIFTED HERE TOO, and for the same reason as Product and Promotion:
    # pass 1 has already read the promoted weeks off the selection, and a
    # neighbour's ordinary level is by definition measured on the weeks the
    # promotion was NOT running. Leaving a week filter on this pass leaves no
    # such weeks at all, so every neighbour reports 'no non-promoted weeks to
    # read an ordinary level from' and the whole check returns zero.
    rows = rows_for(
        selected.widened_to_brand_form().replace(promotion=None, promotion_type=None, week=None)
    )

    products = get_store().dims.products
    brand_forms = sorted({products[p].brand for p in promoted_ids if p in products})

    per_form: list[dict[str, Any]] = []
    total_expected = total_actual = 0.0
    total_expected_units = total_actual_units = 0.0

    for form in brand_forms:
        in_form = [r for r in rows if r.brand_form == form]
        promoted_here = sorted(p for p in promoted_ids if products[p].brand == form)
        promo_weeks = sorted(weeks_by_form.get(form, set()))
        neighbours = sorted({r.product_id for r in in_form if r.product_id not in promoted_here})

        if not neighbours:
            per_form.append({
                "brand_form": form,
                "promoted_products": promoted_here,
                "neighbour_count": 0,
                "computable": False,
                "reason": (
                    "No comparable neighbouring products found within the same brand form "
                    "in this scope."
                ),
            })
            continue

        detail: list[dict[str, Any]] = []
        form_expected = form_actual = 0.0
        form_expected_units = form_actual_units = 0.0
        for pid in neighbours:
            own = [r for r in in_form if r.product_id == pid]
            base_rows = [r for r in own if not r.is_promoted and r.week_key not in promo_weeks]
            during = [r for r in own if r.week_key in promo_weeks]
            base_weeks = {r.week_key for r in base_rows}
            during_weeks = {r.week_key for r in during}
            if not base_weeks or not during_weeks:
                detail.append({
                    "product_id": pid,
                    "product": products[pid].name.strip() if pid in products else pid,
                    "computable": False,
                    "reason": (
                        "No non-promoted weeks to read an ordinary level from."
                        if not base_weeks
                        else "No rows for this product during the promotion weeks."
                    ),
                })
                continue
            # UNITS ARE THE HEADLINE, REVENUE THE CORROBORATION. Both are read the
            # same way -- the neighbour's own mean per week over the weeks it was
            # not promoted, scaled to the promotion weeks measured -- so the two
            # answer the same question in two currencies and can be compared.
            # Units are what a reader can hold: 6,326 against 6,156 rather than
            # 3,637,925.3 against 3,544,560.0, which is the same finding pooled
            # across every store in the channel.
            per_week_units = sum(r.actual_quantity for r in base_rows) / len(base_weeks)
            expected_units = per_week_units * len(during_weeks)
            actual_units = sum(r.actual_quantity for r in during)
            per_week = sum(r.actual_revenue for r in base_rows) / len(base_weeks)
            expected = per_week * len(during_weeks)
            actual = sum(r.actual_revenue for r in during)
            form_expected_units += expected_units
            form_actual_units += actual_units
            form_expected += expected
            form_actual += actual
            detail.append({
                "product_id": pid,
                "product": products[pid].name.strip() if pid in products else pid,
                "computable": True,
                "baseline_weeks": len(base_weeks),
                "promotion_weeks_measured": len(during_weeks),
                "expected_units": round(expected_units, 2),
                "actual_units": round(actual_units, 2),
                "units_change_pct": (
                    round((actual_units - expected_units) / expected_units * 100, 2)
                    if expected_units else None
                ),
                "expected_sales": round(expected, 2),
                "actual_sales": round(actual, 2),
                # (during - baseline) / baseline: POSITIVE means it sold MORE.
                "sales_change_pct": round((actual - expected) / expected * 100, 2) if expected else None,
            })

        total_expected += form_expected
        total_actual += form_actual
        total_expected_units += form_expected_units
        total_actual_units += form_actual_units
        per_form.append({
            "brand_form": form,
            "promoted_products": promoted_here,
            "promotions": promo_names,
            "promotion_weeks": promo_weeks,
            "neighbour_count": len(neighbours),
            "computable": form_expected_units > 0,
            "reason": None if form_expected_units > 0 else (
                "Baseline neighbour volume is zero, so a percentage change cannot be expressed."
            ),
            "expected_neighbour_units": round(form_expected_units, 2),
            "actual_neighbour_units": round(form_actual_units, 2),
            "neighbour_units_change_pct": (
                round((form_actual_units - form_expected_units) / form_expected_units * 100, 2)
                if form_expected_units else None
            ),
            "expected_neighbour_sales": round(form_expected, 2),
            "actual_neighbour_sales": round(form_actual, 2),
            "neighbour_sales_change_pct": (
                round((form_actual - form_expected) / form_expected * 100, 2) if form_expected else None
            ),
            "neighbours": detail,
        })

    overall_units = (
        round((total_actual_units - total_expected_units) / total_expected_units * 100, 2)
        if total_expected_units else None
    )
    overall = round((total_actual - total_expected) / total_expected * 100, 2) if total_expected else None
    return {
        "available": True,
        "metric": "neighbour_units_change_pct",
        "direction": (
            "(promotion-period volume - baseline volume) / baseline volume x 100. NEGATIVE means "
            "neighbouring products sold LESS than their ordinary level -- report that as a "
            "decline of that size, indicating POTENTIAL cannibalization. POSITIVE means neighbour "
            "sales ROSE -- report the increase and state that no decline was detected. Never "
            "describe neighbour growth as negative cannibalization."
        ),
        "neighbour_definition": (
            "Every other product sharing the promoted product's Brand Form (dim_product.Brand, "
            "which this dataset uses as the brand+form grouping). The promoted product is excluded."
        ),
        "baseline_definition": (
            "Each neighbour's own mean UNITS per week over the weeks it was not promoted and the "
            "promotion was not running, scaled to the number of promotion weeks measured."
        ),
        "causality_note": (
            "An observed co-movement, not an attribution. A decline here is CONSISTENT WITH "
            "cannibalization and does not establish that the promotion caused it."
        ),
        # THE HEADLINE IS VOLUME. Revenue travels beside it, unchanged, as the
        # corroborating figure and for the evidence line -- a decline in units
        # that is not matched in money (or the reverse) is itself worth saying.
        "expected_neighbour_units": round(total_expected_units, 2),
        "actual_neighbour_units": round(total_actual_units, 2),
        "neighbour_units_change_pct": overall_units,
        "expected_neighbour_sales": round(total_expected, 2),
        "actual_neighbour_sales": round(total_actual, 2),
        "promotions": promo_names,
        "neighbour_sales_change_pct": overall,
        "by_brand_form": per_form,
    }
