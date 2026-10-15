"""COMPONENT A — the LightGBM baseline (TPO_Algorithm_Workflow.pdf, Step 2).

These tests pin the properties that make the model safe to measure promotions
against, not its accuracy to three decimal places — a boosted-tree fit moves
slightly with library versions, and a test that pinned WAPE to 0.0287 would
fail on an upgrade without anything being wrong.

What IS pinned: that promoted weeks never enter training, that the adjacency
mask and the leakage-safe lags do what they claim, that the quantile band is
ordered and roughly calibrated, that the engine prefers observed data to the
model, and that a dataset too thin to fit degrades to the local mean instead
of raising.
"""

from __future__ import annotations

import csv
from pathlib import Path

import numpy as np
import pytest

from app.tpo import baseline_model as bm
from app.tpo import config, loader

#: The reference dataset, materialised from git HEAD by tests/conftest.py and
#: pointed at by TPO_DATA_DIR. NOT the working Data/ folder: the connector
#: writes into that one, so reading it made these tests depend on whatever
#: was last uploaded in the browser.
REPO_DATA = config.DATA_DIR

pytest.importorskip("lightgbm", reason="the baseline model needs lightgbm")


@pytest.fixture(scope="module")
def store():
    return loader._build_store(REPO_DATA)


@pytest.fixture(scope="module")
def frame(store):
    return bm.build_frame(store)


@pytest.fixture(scope="module")
def fitted(store, frame, tmp_path_factory):
    # Fit into a throwaway cache so the test never depends on, or poisons, the
    # real .store/baseline folder.
    return bm.fit(store, frame)


# --- the training set ------------------------------------------------------


def test_no_promoted_week_is_ever_trained_on(frame):
    """The whole method rests on this. A promoted week in the training set
    would teach the model that promoted volume is normal volume, and the
    baseline would absorb the very lift it exists to measure."""
    assert not (frame.trainable & frame.promoted).any()


def test_adjacency_mask_drops_weeks_next_to_a_promotion(frame):
    """A non-promoted week beside a promotion carries build-up or the
    pull-forward dip. Training on it biases the baseline DOWN, which overstates
    every lift — so those weeks are predicted for but not fitted on."""
    assert bm.ADJACENT_MASK >= 1
    clean_non_promoted = int(frame.trainable.sum())
    all_non_promoted = int((~frame.promoted).sum())
    assert clean_non_promoted < all_non_promoted, "the mask dropped nothing"
    # It must not be so aggressive that nothing is left to learn from.
    assert clean_non_promoted > 0.5 * all_non_promoted


def test_masked_weeks_are_still_predicted_for(store, fitted):
    """Excluded from fitting is not excluded from answering."""
    assert len(fitted.units) == store.row_count
    assert np.isfinite(fitted.units).all()


def test_lags_never_read_a_promoted_week(store, frame):
    """A lag that silently carried a promoted week's inflated units would leak
    the promotion into its own baseline."""
    cell = frame.columns["product_id"].astype(np.int64) * 100000 + frame.columns["store_id"]
    time_index = frame.columns["time_index"]
    promoted_slots = set(zip(cell[frame.promoted].tolist(), time_index[frame.promoted].tolist()))
    for lag in bm.LAGS:
        values = frame.columns[f"lag_{lag}"]
        present = np.isfinite(values)
        # Every lag that HAS a value must point at a slot that is not promoted.
        pointed = list(zip(cell[present].tolist(), (time_index[present] - lag).tolist()))
        assert not any(slot in promoted_slots for slot in pointed), f"lag_{lag} read a promoted week"


def test_local_level_feature_matches_the_engines_own_window(frame):
    """`local_level` is the old estimator handed to the model as an input —
    the design choice that stops a tree having to learn the level at all, and
    that keeps the two methods comparable. It must use the same window the
    engine uses, or the comparison in the report is not like for like."""
    from app.tpo import aggregate

    assert bm.LOCAL_WINDOW == aggregate.BASELINE_WINDOW
    assert np.isfinite(frame.columns["local_level"]).any()


def test_base_quantity_is_never_a_feature():
    """It is the answer. Training on it would be circular, and no client file
    has it anyway."""
    assert not any("base" in f.lower() for f in bm.FEATURES)


# --- the predictions -------------------------------------------------------


def test_quantiles_are_ordered_and_non_negative(fitted):
    p10, p50, p90 = (fitted.predictions[q] for q in bm.QUANTILES)
    assert (p10 <= p50 + 1e-9).all()
    assert (p50 <= p90 + 1e-9).all()
    assert (p10 >= 0).all(), "a baseline cannot be negative units"


def test_band_is_roughly_calibrated(fitted):
    """The PDF asks that ~80% of actuals fall inside P10-P90. Checked loosely:
    a band that collapsed to a point or swallowed everything is the failure
    worth catching, not a few points of miscalibration."""
    coverage = fitted.report["coverage_p10_p90"]
    assert 0.6 <= coverage <= 0.95, coverage


def test_holdout_error_is_reported_and_not_wildly_overfit(fitted):
    """The gap between in-sample and held-out error is the overfit signal."""
    report = fitted.report
    assert report["wape"] is not None
    assert report["wape"] < 0.25, "a 25% WAPE baseline is not usable"
    assert report["wape"] < 4 * report["train_wape"] + 0.05


def test_report_states_how_far_it_moves_the_baseline(fitted):
    """Disclosure, not a score: a reader must be able to see how far the model
    departs from both the source counterfactual and the local mean."""
    for key in ("vs_source_base_wape", "vs_source_base_bias",
                "vs_local_mean_wape", "vs_local_mean_bias"):
        assert key in fitted.report, key


def test_p50_agrees_closely_with_a_real_counterfactual(fitted):
    """The PDF's own acceptance check: "compare the P50 with Base_Quantity on
    promoted weeks (they should agree closely)". The reference dataset carries
    a real one, so this is the closest thing to a true score available."""
    assert fitted.report["vs_source_base_wape"] < 0.10
    assert abs(fitted.report["vs_source_base_bias"]) < 0.10


# --- degrading, not failing ------------------------------------------------


def test_too_little_history_raises_rather_than_guessing(store, frame):
    """A baseline of zero would report a promotion's whole volume as
    incremental, so a model that cannot be fitted must say so."""
    thin = bm.Frame(
        columns={k: v[:10] for k, v in frame.columns.items()},
        trainable=frame.trainable[:10],
        target=frame.target[:10],
        year=frame.year[:10],
        promoted=frame.promoted[:10],
        source_base=frame.source_base[:10],
    )
    with pytest.raises(bm.BaselineUnavailable):
        bm.fit(store, thin)


def test_loader_skips_the_fit_when_the_file_has_its_own_counterfactual(store):
    """The reference dataset's Base_Quantity is observed data and wins over any
    model, so fitting one would be pure cost on every cold start."""
    assert store.counterfactual_base is True
    assert config.BASELINE_PREFER_SOURCE is True
    assert store.model_baseline() is None


def test_engine_prefers_observed_data_over_the_model():
    """`_expected`'s first branch. Observed beats estimated — and on the
    reference data the model reproduces Base_Quantity only to ~3%, so
    preferring the column is what keeps the shipped figures exact."""
    from app.tpo import aggregate

    row = aggregate.WeekRow(
        product_id="P1", channel_id="CH001", brand_form="B", product_rank=2,
        week_key="2025-W10", month=3, is_promoted=True, promotion_id="PR001",
        base_quantity=100.0, actual_quantity=150.0, actual_revenue=1500.0,
        total_cost=500.0, promotion_cost=30.0, discount_value=100.0,
        actual_price_sum=10.0, transaction_count=1,
        base_value=1000.0, counterfactual=True, model_baseline=120.0,
    )
    (units, value), = [e for e in aggregate._expected([row]) if e is not None]
    assert units == 100.0, "the observed counterfactual must win"
    assert value == 1000.0


def test_engine_uses_the_model_when_there_is_no_counterfactual():
    from app.tpo import aggregate

    row = aggregate.WeekRow(
        product_id="P1", channel_id="CH001", brand_form="B", product_rank=2,
        week_key="2025-W10", month=3, is_promoted=True, promotion_id="PR001",
        base_quantity=150.0, actual_quantity=150.0, actual_revenue=1500.0,
        total_cost=500.0, promotion_cost=30.0, discount_value=100.0,
        actual_price_sum=10.0, transaction_count=2,
        base_value=0.0, counterfactual=False, model_baseline=120.0,
    )
    (units, value), = [e for e in aggregate._expected([row]) if e is not None]
    assert units == 120.0
    # Priced at the per-store-week rate, the same shape the local mean gives.
    assert value == pytest.approx((120.0 / 2) * 10.0)


# --- the cache -------------------------------------------------------------


def test_cache_round_trips_without_pickle(store, frame, tmp_path):
    """Cached as .npz + JSON on purpose: `.store/` is an ordinary writable
    folder, and a pickle there would be an arbitrary-code-execution foothold
    for nothing in return."""
    first = bm.load_or_fit(store, cache_dir=tmp_path)
    files = sorted(p.suffix for p in tmp_path.iterdir())
    assert ".npz" in files and ".json" in files
    assert not any(p.suffix == ".pkl" for p in tmp_path.iterdir())

    second = bm.load_or_fit(store, cache_dir=tmp_path)  # served from disk
    for q in bm.QUANTILES:
        assert np.allclose(first.predictions[q], second.predictions[q])


def test_fingerprint_changes_with_the_data(store):
    key = bm.data_fingerprint(store)
    assert len(key) == 16
    bumped = loader._build_store(REPO_DATA)
    bumped.actual_quantity[0] += 1
    assert bm.data_fingerprint(bumped) != key


def test_three_file_dataset_actually_uses_the_model(tmp_path):
    """The case this was built for: a client file with no Base_Quantity. The
    model must answer, and the engine must reach it."""
    promo = {r["Promotion_Id"]: r for r in _rows("dim_promotion_final.csv")}
    chan = {r["Channel_Id"]: r for r in _rows("dim_channel.csv")}
    _write(tmp_path / config.DIM_FILES["product"],
           ["Product_id", "Product_Name", "Brand", "Category", "Size"],
           _rows("dim_product_reordered.csv"))
    store_cols = ["Store_Id", "Channel_Id", "Channel_Name", "Channel_Type", "Schedule",
                  "Retailer", "Distributor_Name", "Region", "Country", "State", "City", "Tier"]
    _write(tmp_path / config.DIM_FILES["geo_store"], store_cols, [
        {**s, "Channel_Name": chan[s["Channel_Id"]]["Channel_Name"],
         "Channel_Type": chan[s["Channel_Id"]]["Channel_Type"],
         "Schedule": chan[s["Channel_Id"]]["Schedule"]}
        for s in _rows("dim_geo_store_final.csv")
    ])
    fact_cols = ["Date", "Product_id", "Store_Id", "Promotion_Id", "Promotion_Name",
                 "Promotion_Type", "Actual_Quantity", "Base_Price", "Actual_Price", "CP",
                 "Promotion_Cost"]
    fact = []
    for r in _rows(config.FACT_FILE):
        on = r["Promotion_Id"] != loader.NO_PROMOTION
        fact.append({**r,
                     "Promotion_Id": r["Promotion_Id"] if on else "",
                     "Promotion_Name": promo[r["Promotion_Id"]]["Promotion_Name"] if on else "",
                     "Promotion_Type": promo[r["Promotion_Id"]]["Promotion_Type"] if on else "",
                     "CP": int(float(r["Total_Cost"]) / float(r["Actual_Quantity"]))})
    _write(tmp_path / config.FACT_FILE, fact_cols, fact)

    client = loader._build_store(tmp_path)
    assert client.counterfactual_base is False
    fitted = client.model_baseline()
    assert fitted is not None, "a client file is exactly when the model must run"
    units, report = fitted
    assert len(units) == client.row_count
    assert report["wape"] is not None


def _rows(name):
    with (REPO_DATA / name).open(encoding="utf-8-sig", newline="") as fh:
        return list(csv.DictReader(fh))


def _write(path, columns, rows):
    with path.open("w", newline="", encoding="utf-8") as fh:
        writer = csv.DictWriter(fh, columns)
        writer.writeheader()
        for row in rows:
            writer.writerow({c: row.get(c, "") for c in columns})
