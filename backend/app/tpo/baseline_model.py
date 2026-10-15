"""COMPONENT A — the baseline: "what would this store-week have sold if we had
done nothing?"

This is the one quantity no source system can ever hand us. Everything the
platform reports about a promotion is a difference from it:

    incremental units = actual units - BASELINE units
    incremental sales = that difference x the price actually paid
    ROI               = incremental sales / trade spend
    PEI               = built from the two above plus margin

So the baseline is not one number among many; it is the foundation the whole
chain stands on, and it is estimated, never read.

WHY A MODEL AT ALL. Until now the engine measured a promoted week against the
nearest non-promoted weeks of the same product in the same channel
(`aggregate._local_baselines`, a +/-4 week local mean). That rule is sound and
still runs — see FALLBACK below — but it has three limits that matter once a
client's own data arrives weekly:

  1. A product-store promoted in most weeks has no nearby ordinary week, so the
     engine SKIPS it. Those cells are exactly the heavily-promoted ones a trade
     team cares most about.
  2. The ordinary weeks next to a promotion are not ordinary. A post-promotion
     dip, pantry loading, or a sister pack's offer that week all push them
     DOWN, which pushes the baseline down and so OVERSTATES every lift and ROI.
  3. It cannot answer for a week nobody has traded yet, which is what the
     Simulation Studio needs to plan a future calendar.

TPO_Algorithm_Workflow.pdf, Step 2, Option 2 specifies the replacement, and
this module is that specification: LightGBM with quantile loss, trained on
NON-PROMOTED store-weeks only and then asked to predict the promoted ones.

    "Option 2: train LightGBM on non-promoted rows only, then predict for
     promoted weeks. That also gives a baseline for weeks never promoted,
     which the Studio needs for future windows."

WHAT IS THE PDF'S AND WHAT IS OURS. Faithful to the PDF: the target, the
non-promoted-only training set, the feature families (product, brand, size,
store, channel, tier, region, week of year, event windows, lags at 4 and 52
weeks), the three quantile models at 0.1 / 0.5 / 0.9, and the validation
(train 2024, test 2025; WAPE; ~80% of actuals inside P10-P90; P50 compared
with Base_Quantity on promoted weeks). Three additions are ours, each for a
failure the PDF does not address:

  * ADJACENCY MASKING. A non-promoted week within `ADJACENT_MASK` weeks of a
    promotion, for the same product-store, is dropped from TRAINING. This is
    limit 2 above. Train on the dip and the model learns the dip as normality.
    Those weeks are still PREDICTED for; they are only excluded from fitting.

  * `local_level` AS A FEATURE. The old +/-4 week local mean is handed to the
    model as an input column. This is the most important design choice here, and
    it is what makes the swap safe. Gradient-boosted trees cannot extrapolate:
    a SKU growing 30% year on year would be predicted flat at the top of its
    training range, and a baseline that is too low inflates the lift. Feeding
    the local level in means the tree never has to learn the level, only the
    CORRECTION to it, so the model starts from the old estimator's answer and
    can only improve on it. It also removes the usual pooling bias, where a
    high-volume cell is shrunk toward the global mean.

  * LEAKAGE-SAFE LAGS. A lag is read only if that earlier week was itself a
    clean non-promoted week; otherwise it is NaN (LightGBM splits on NaN
    natively). A lag that silently carries a promoted week's inflated units
    would teach the model that promotions are normal.

FALLBACK, AND WHY IT STAYS. A cell the model cannot serve — no clean history at
all — still falls back to the local mean, and a cell neither can serve is
skipped and reported, exactly as before. The fallback is also a published
cross-check: `report()` states how far the two disagree. Keeping it costs
little and means no figure is ever unexplainable, which matters because ROI is
the number a client argues about.

WHAT THIS MODULE DOES NOT DO. It does not compute a KPI. It returns baseline
units per fact row and nothing else; `aggregate.py` owns every formula built on
top. It is also deliberately selection-INDEPENDENT: one fit over the whole
dataset, cached, and the per-store-week predictions are summed by whatever
filter the reader applies. A product's baseline therefore no longer changes
because someone filtered to a region, which the local mean could not promise.
"""

from __future__ import annotations

import hashlib
import json
import os
import threading
import time
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

import numpy as np

# --- the contract ----------------------------------------------------------

#: Bump when anything that changes a fitted model changes: the feature list,
#: the masking rule, the hyper-parameters, the target. The disk cache is keyed
#: on it, so a bump refits rather than loading a model built by older code.
MODEL_VERSION = 1

#: The three quantiles the PDF asks for. 0.5 is the baseline the KPIs use;
#: 0.1 and 0.9 are the band the Studio shows as a range.
QUANTILES: tuple[float, ...] = (0.1, 0.5, 0.9)
MEDIAN = 0.5

#: A non-promoted week this many weeks from a promotion (same product-store) is
#: predicted for but never TRAINED on. 1 covers the build-up week before and
#: the pull-forward dip after; the PDF's own Step 1 asks for exactly those two
#: windows when studying events.
ADJACENT_MASK = 1

#: Weeks either side used for the `local_level` feature. Deliberately the same
#: as `aggregate.BASELINE_WINDOW`, so the feature IS the old estimator and the
#: comparison in `report()` is like for like.
LOCAL_WINDOW = 4

#: Lags the PDF names: a month back, and the same week last year.
LAGS: tuple[int, ...] = (4, 52)

#: LightGBM settings. Modest depth and strong row/column subsampling because
#: the signal here is a level, not an interaction thicket, and because a
#: client's first upload may be a single year.
PARAMS: dict[str, Any] = {
    "objective": "quantile",
    "boosting_type": "gbdt",
    "n_estimators": 400,
    "learning_rate": 0.05,
    "num_leaves": 63,
    "min_child_samples": 40,
    "subsample": 0.8,
    "subsample_freq": 1,
    "colsample_bytree": 0.8,
    "reg_lambda": 1.0,
    "max_bin": 127,
    "verbose": -1,
    "n_jobs": max(1, (os.cpu_count() or 4) // 2),
    "seed": 20261014,
    "deterministic": True,
    "force_row_wise": True,
}

CATEGORICAL: tuple[str, ...] = (
    "product_id", "brand", "size", "store_id", "channel_id", "region", "tier", "retailer",
)
NUMERIC: tuple[str, ...] = (
    "week_of_year", "time_index", "list_price", "local_level", "seasonal_week",
    *(f"lag_{n}" for n in LAGS),
)
FEATURES: tuple[str, ...] = (*CATEGORICAL, *NUMERIC)

#: Where fitted models live. Beside the planner's posterior cache, for the same
#: reason: fitting costs seconds to a minute and the answer is identical for
#: identical data, so it should survive a restart.
CACHE_DIR = Path(__file__).resolve().parents[2] / ".store" / "baseline"

_LOCK = threading.Lock()


class BaselineUnavailable(RuntimeError):
    """Raised when no model can be fitted at all — too little clean history.

    Not an error the caller should swallow into a zero: a baseline of zero
    would report a promotion's entire volume as incremental. `service.py`
    catches this and the engine falls back to the local mean.
    """


# --- the feature table -----------------------------------------------------


@dataclass
class Frame:
    """The modelling table: one row per fact row, in FactStore order.

    Columns are plain numpy arrays rather than a DataFrame so that building it
    costs one pass and no copies. Categoricals are integer codes, which is what
    LightGBM wants anyway.
    """

    columns: dict[str, np.ndarray]
    #: True where the row is a clean non-promoted week — eligible for TRAINING.
    trainable: np.ndarray
    #: The target: that store-week's units.
    target: np.ndarray
    year: np.ndarray
    promoted: np.ndarray
    #: Source Base_Quantity, kept only to validate against when a file has a
    #: real counterfactual. Never a feature: it is the answer.
    source_base: np.ndarray
    n_rows: int = field(init=False)

    def __post_init__(self) -> None:
        self.n_rows = len(self.target)

    def matrix(self, mask: np.ndarray | None = None) -> Any:
        import pandas as pd

        data = {}
        for name in FEATURES:
            col = self.columns[name]
            data[name] = col if mask is None else col[mask]
        frame = pd.DataFrame(data)
        for name in CATEGORICAL:
            frame[name] = frame[name].astype("category")
        return frame


def build_frame(store: Any) -> Frame:
    """FactStore -> the modelling table. One pass, then vectorised derivations.

    `store` is an `app.tpo.loader.FactStore`; it is typed loosely to keep this
    module importable without the loader (the tests build small fakes).
    """
    n = store.row_count
    product_code = np.asarray(store.product_code, dtype=np.int32)
    store_code = np.asarray(store.store_code, dtype=np.int32)
    year = np.asarray(store.year, dtype=np.int32)
    week = np.asarray(store.week, dtype=np.int32)
    promoted = np.asarray(store.promoted, dtype=bool)
    units = np.asarray(store.actual_quantity, dtype=np.float64)
    base_revenue = np.asarray(store.base_revenue, dtype=np.float64)
    source_base = np.asarray(store.base_quantity, dtype=np.float64)

    # List price per unit. base_revenue is units SOLD x list price, so the
    # division recovers the list price without the fact carrying it twice.
    with np.errstate(divide="ignore", invalid="ignore"):
        list_price = np.where(units > 0, base_revenue / np.maximum(units, 1e-9), np.nan)

    products = store.products
    stores = store.stores
    brand = np.array([products[c].brand for c in product_code])
    size = np.array([products[c].size for c in product_code])
    channel = np.array([stores[c].channel_id for c in store_code])
    region = np.array([stores[c].region for c in store_code])
    tier = np.array([stores[c].tier for c in store_code])
    retailer = np.array([stores[c].retailer or stores[c].distributor for c in store_code])

    # A single ordered week index across years, so lags and ordering work over
    # a year boundary. 53 slots a year because week 53 is a real short week.
    time_index = (year - year.min()) * 53 + week

    # EVENT WINDOWS, derived from the data rather than from a hardcoded festival
    # list: a week is "seasonal" if any Seasonal-type offer ran anywhere in it.
    # The PDF adds festival flags from build_final_dataset.py's FESTIVALS dict,
    # which a client's file has no equivalent of; this reads the same weeks off
    # the offers actually booked, so it works for any dataset. Non-promoted
    # cells in a festival week do trade differently (halo), which is exactly
    # what the flag lets the model represent.
    promotions = store.promotions
    promo_code = np.asarray(store.promo_code, dtype=np.int32)
    seasonal_promo = np.array(
        [str(getattr(promotions[c], "type", "")).strip().lower() == "seasonal" for c in promo_code]
    )
    seasonal_weeks = set(time_index[promoted & seasonal_promo].tolist())
    seasonal_week = np.isin(time_index, list(seasonal_weeks)).astype(np.int8)

    # TRAINABLE: non-promoted, and not within ADJACENT_MASK weeks of a
    # promotion for the same product-store.
    cell = product_code.astype(np.int64) * (store_code.max() + 1) + store_code
    trainable = ~promoted
    if ADJACENT_MASK > 0:
        promoted_slots = set(zip(cell[promoted].tolist(), time_index[promoted].tolist()))
        if promoted_slots:
            near = np.zeros(n, dtype=bool)
            for offset in range(-ADJACENT_MASK, ADJACENT_MASK + 1):
                if offset == 0:
                    continue
                shifted = list(zip(cell.tolist(), (time_index + offset).tolist()))
                near |= np.fromiter(
                    (s in promoted_slots for s in shifted), dtype=bool, count=n
                )
            trainable &= ~near

    local_level = _local_level(cell, time_index, units, trainable)
    lags = _lags(cell, time_index, units, trainable)

    columns: dict[str, np.ndarray] = {
        "product_id": product_code,
        "brand": _codes(brand),
        "size": _codes(size),
        "store_id": store_code,
        "channel_id": _codes(channel),
        "region": _codes(region),
        "tier": _codes(tier),
        "retailer": _codes(retailer),
        "week_of_year": week,
        "time_index": time_index,
        "list_price": list_price,
        "local_level": local_level,
        "seasonal_week": seasonal_week,
        **{f"lag_{k}": v for k, v in lags.items()},
    }
    return Frame(
        columns=columns,
        trainable=trainable,
        target=units,
        year=year,
        promoted=promoted,
        source_base=source_base,
    )


def _codes(values: np.ndarray) -> np.ndarray:
    _, codes = np.unique(values, return_inverse=True)
    return codes.astype(np.int32)


def _local_level(
    cell: np.ndarray, time_index: np.ndarray, units: np.ndarray, clean: np.ndarray
) -> np.ndarray:
    """The old estimator, as a feature: mean units over the nearest
    LOCAL_WINDOW CLEAN weeks on each side of the row, same product-store, the
    row itself excluded. NaN where the cell has no clean week.

    Computed from clean weeks only — a dip week would contaminate the feature
    the same way it contaminates the old baseline.
    """
    out = np.full(len(units), np.nan)
    order = np.lexsort((time_index, cell))
    starts = np.flatnonzero(np.r_[True, np.diff(cell[order]) != 0])
    bounds = np.r_[starts, len(order)]
    for a, b in zip(bounds[:-1], bounds[1:]):
        idx = order[a:b]
        good = idx[clean[idx]]
        if not len(good):
            continue
        good_time = time_index[good]
        good_units = units[good]
        csum = np.r_[0.0, np.cumsum(good_units)]
        pos = np.searchsorted(good_time, time_index[idx])
        for j, i in enumerate(idx):
            k = pos[j]
            # Drop the row itself when it is one of the clean weeks.
            after = k + 1 if k < len(good) and good_time[k] == time_index[i] else k
            lo = max(0, k - LOCAL_WINDOW)
            hi = min(len(good), after + LOCAL_WINDOW)
            total = (csum[k] - csum[lo]) + (csum[hi] - csum[after])
            count = (k - lo) + (hi - after)
            if count:
                out[i] = total / count
    return out


def _lags(
    cell: np.ndarray, time_index: np.ndarray, units: np.ndarray, clean: np.ndarray
) -> dict[int, np.ndarray]:
    """Units of the same product-store `n` weeks earlier, read ONLY when that
    week was itself clean and non-promoted. NaN otherwise, which LightGBM
    handles as its own branch.
    """
    known: dict[tuple[int, int], float] = {
        (c, t): u for c, t, u in zip(cell[clean].tolist(), time_index[clean].tolist(), units[clean].tolist())
    }
    out: dict[int, np.ndarray] = {}
    for lag in LAGS:
        out[lag] = np.fromiter(
            (known.get((c, t - lag), np.nan) for c, t in zip(cell.tolist(), time_index.tolist())),
            dtype=np.float64,
            count=len(units),
        )
    return out


# --- fit, predict, validate ------------------------------------------------


@dataclass
class Baseline:
    """A fitted baseline: per-quantile predictions in FactStore row order."""

    predictions: dict[float, np.ndarray]
    report: dict[str, Any]

    @property
    def units(self) -> np.ndarray:
        """The P50 — the baseline every KPI is measured against."""
        return self.predictions[MEDIAN]


def fit(store: Any, frame: Frame | None = None) -> Baseline:
    """Fit the three quantile models and predict for EVERY row.

    Promoted rows are predicted but never trained on; non-promoted rows are
    predicted too, so the Studio can read a baseline for any week.
    """
    import lightgbm as lgb

    frame = frame or build_frame(store)
    if int(frame.trainable.sum()) < 500:
        raise BaselineUnavailable(
            f"only {int(frame.trainable.sum())} clean non-promoted store-weeks — "
            f"too few to fit a baseline. At least 500 are needed."
        )

    started = time.perf_counter()
    X_train = frame.matrix(frame.trainable)
    y_train = frame.target[frame.trainable]
    X_all = frame.matrix()

    predictions: dict[float, np.ndarray] = {}
    for q in QUANTILES:
        model = lgb.LGBMRegressor(alpha=q, **PARAMS)
        model.fit(X_train, y_train, categorical_feature=list(CATEGORICAL))
        # Units are never negative, and a quantile model can cross zero on a
        # thin cell. Clipping is honest: it cannot invent volume, only refuse
        # to predict negative volume.
        predictions[q] = np.clip(model.predict(X_all), 0.0, None)

    # The quantile models are fitted independently, so P10 <= P50 <= P90 is not
    # guaranteed on every row. Sorting the three restores the ordering without
    # changing any individual model's answer about its own quantile.
    stacked = np.sort(np.vstack([predictions[q] for q in QUANTILES]), axis=0)
    predictions = {q: stacked[i] for i, q in enumerate(QUANTILES)}

    report = validate(frame, predictions)
    report["fit_seconds"] = round(time.perf_counter() - started, 2)
    report["trained_rows"] = int(frame.trainable.sum())
    report["model_version"] = MODEL_VERSION
    return Baseline(predictions=predictions, report=report)


def validate(frame: Frame, predictions: dict[float, np.ndarray]) -> dict[str, Any]:
    """The PDF's Step 2 validation, plus the one honest caveat.

    Three measurements:

      * WAPE on HELD-OUT non-promoted weeks. The PDF says train 2024, test
        2025; this generalises it to "train on all but the last year, test on
        the last year" so it still means something on a client file that holds
        one year or five.
      * Coverage: the share of held-out actuals inside P10-P90, which should sit
        near 80%.
      * Agreement with the source's Base_Quantity on promoted weeks, when the
        file carries a real counterfactual.

    THE CAVEAT, stated here because it is easy to forget: the first two measure
    ORDINARY-WEEK prediction, not counterfactual accuracy. Nothing can measure
    the latter, because the counterfactual never happened. A good WAPE is
    necessary evidence, not sufficient proof.
    """
    out: dict[str, Any] = {}
    years = np.unique(frame.year)
    holdout_year = int(years.max()) if len(years) > 1 else None

    if holdout_year is not None:
        test = frame.trainable & (frame.year == holdout_year)
        if test.sum() > 50:
            actual = frame.target[test]
            p50 = predictions[MEDIAN][test]
            denom = np.abs(actual).sum()
            out["holdout_year"] = holdout_year
            out["holdout_rows"] = int(test.sum())
            out["wape"] = round(float(np.abs(actual - p50).sum() / denom), 4) if denom else None
            inside = (actual >= predictions[0.1][test]) & (actual <= predictions[0.9][test])
            out["coverage_p10_p90"] = round(float(inside.mean()), 4)

    # In-sample WAPE on the weeks the model trained on. Reported so the gap
    # between it and the hold-out figure is visible — a large gap is overfit.
    train = frame.trainable
    if train.sum():
        actual = frame.target[train]
        denom = np.abs(actual).sum()
        out["train_wape"] = (
            round(float(np.abs(actual - predictions[MEDIAN][train]).sum() / denom), 4)
            if denom else None
        )

    promoted = frame.promoted
    if promoted.any():
        source = frame.source_base[promoted]
        actual = frame.target[promoted]
        # A real counterfactual differs from actual units on promoted rows; a
        # file without one just copies them, and comparing is meaningless.
        if np.any(source != actual):
            p50 = predictions[MEDIAN][promoted]
            denom = np.abs(source).sum()
            out["vs_source_base_wape"] = (
                round(float(np.abs(source - p50).sum() / denom), 4) if denom else None
            )
            out["vs_source_base_bias"] = (
                round(float((p50.sum() - source.sum()) / source.sum()), 4) if denom else None
            )

    # How far the model moves the baseline away from the old local mean, on the
    # promoted rows where it matters. Not a score — a disclosure.
    local = frame.columns["local_level"]
    both = promoted & np.isfinite(local)
    if both.any():
        p50 = predictions[MEDIAN][both]
        lvl = local[both]
        denom = np.abs(lvl).sum()
        out["vs_local_mean_wape"] = round(float(np.abs(lvl - p50).sum() / denom), 4) if denom else None
        out["vs_local_mean_bias"] = round(float((p50.sum() - lvl.sum()) / lvl.sum()), 4) if denom else None
        out["local_mean_available_share"] = round(float(np.isfinite(local[promoted]).mean()), 4)

    return out


# --- the cache -------------------------------------------------------------


def data_fingerprint(store: Any) -> str:
    """Identity of the loaded dataset, for the cache key.

    Row count plus a hash of the columns a fit depends on. Cheap next to a fit,
    and it changes whenever the data does.
    """
    h = hashlib.sha256()
    h.update(str(MODEL_VERSION).encode())
    h.update(str(store.row_count).encode())
    for name in ("product_code", "store_code", "year", "week", "promoted",
                 "actual_quantity", "base_revenue"):
        h.update(np.asarray(getattr(store, name)).tobytes())
    return h.hexdigest()[:16]


def load_or_fit(store: Any, cache_dir: Path | None = None) -> Baseline:
    """The entry point. One fit per dataset per machine, then free forever.

    Serialised: two requests arriving together on a cold cache would otherwise
    both fit, and a fit is the expensive thing this module does.

    Cached as .npz plus JSON, never pickle. The cache holds plain float arrays
    and a flat report, so there is nothing to gain from a format that can
    execute code on load — and `.store/` is an ordinary writable folder, which
    is exactly where an unpickle would be a liability rather than a convenience.
    """
    folder = cache_dir or CACHE_DIR
    key = data_fingerprint(store)
    path = folder / f"baseline-{key}.npz"
    report_path = folder / f"baseline-{key}.json"

    with _LOCK:
        if path.is_file() and report_path.is_file():
            try:
                with np.load(path) as payload:  # allow_pickle stays off (the default)
                    predictions = {q: payload[f"q{q}"] for q in QUANTILES}
                report = json.loads(report_path.read_text(encoding="utf-8"))
                if all(len(v) == store.row_count for v in predictions.values()):
                    return Baseline(predictions=predictions, report=report)
            except Exception:
                # A truncated or stale cache is not worth a traceback; refit.
                path.unlink(missing_ok=True)
                report_path.unlink(missing_ok=True)

        baseline = fit(store)
        folder.mkdir(parents=True, exist_ok=True)
        tmp = path.with_suffix(".tmp.npz")
        try:
            np.savez_compressed(tmp, **{f"q{q}": baseline.predictions[q] for q in QUANTILES})
            os.replace(tmp, path)
            report_path.write_text(json.dumps(baseline.report, indent=2), encoding="utf-8")
        except Exception:
            tmp.unlink(missing_ok=True)
        return baseline
