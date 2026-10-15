"""The three-file client upload: sales fact + product + store, nothing else.

No source system ships a calendar, a channel table or a promotion table, so the
loader derives all three. These tests pin that the derived dataset is
indistinguishable from the six-file one on everything that is OBSERVED, and
that the two things it cannot invent -- a channel's name and an offer's
mechanic -- are demanded of the files that can carry them.

Throwaway folders only; the live Data/ folder is never written to.
"""

from __future__ import annotations

import csv
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from app import source_sync, star_dataset
from app.deps import current_user
from app.main import app
from app.tpo import config, loader

#: The reference dataset, materialised from git HEAD by tests/conftest.py and
#: pointed at by TPO_DATA_DIR. NOT the working Data/ folder: the connector
#: writes into that one, so reading it made these tests depend on whatever
#: was last uploaded in the browser.
REPO_DATA = config.DATA_DIR

#: Columns of the client contract's fact table. Cost arrives per unit as `CP`
#: and the offer rides on the row, so neither dim_promotion nor a Total_Cost
#: column is needed.
FACT_COLUMNS = [
    "Date", "Product_id", "Store_Id", "Promotion_Id", "Promotion_Name",
    "Promotion_Type", "Actual_Quantity", "Base_Price", "Actual_Price", "CP",
    "Promotion_Cost",
]

STORE_COLUMNS = [
    "Store_Id", "Channel_Id", "Channel_Name", "Channel_Type", "Schedule",
    "Retailer", "Distributor_Name", "Region", "Country", "State", "City", "Tier",
]


def _read(name):
    with (REPO_DATA / name).open(encoding="utf-8-sig", newline="") as fh:
        return list(csv.DictReader(fh))


def _write(path, columns, rows):
    with path.open("w", newline="", encoding="utf-8") as fh:
        writer = csv.DictWriter(fh, columns)
        writer.writeheader()
        for row in rows:
            writer.writerow({c: row.get(c, "") for c in columns})


@pytest.fixture(scope="module")
def three_file_dataset(tmp_path_factory):
    """The shipped dataset restated in the client contract: three files, no
    Base_Quantity, CP instead of Total_Cost, a blank cell instead of `-1`."""
    folder = tmp_path_factory.mktemp("three_file")
    promotions = {r["Promotion_Id"]: r for r in _read("dim_promotion_final.csv")}
    channels = {r["Channel_Id"]: r for r in _read("dim_channel.csv")}

    _write(folder / config.DIM_FILES["product"],
           ["Product_id", "Product_Name", "Brand", "Category", "Size"],
           _read("dim_product_reordered.csv"))

    _write(folder / config.DIM_FILES["geo_store"], STORE_COLUMNS, [
        {**store, **{
            "Channel_Name": channels[store["Channel_Id"]]["Channel_Name"],
            "Channel_Type": channels[store["Channel_Id"]]["Channel_Type"],
            "Schedule": channels[store["Channel_Id"]]["Schedule"],
        }}
        for store in _read("dim_geo_store_final.csv")
    ])

    fact = []
    for row in _read(config.FACT_FILE):
        promoted = row["Promotion_Id"] != loader.NO_PROMOTION
        offer = promotions[row["Promotion_Id"]]
        fact.append({
            **row,
            "Promotion_Id": row["Promotion_Id"] if promoted else "",
            "Promotion_Name": offer["Promotion_Name"] if promoted else "",
            "Promotion_Type": offer["Promotion_Type"] if promoted else "",
            "CP": int(float(row["Total_Cost"]) / float(row["Actual_Quantity"])),
        })
    _write(folder / config.FACT_FILE, FACT_COLUMNS, fact)
    return folder


# --- the derived dimensions ------------------------------------------------


def test_derived_week_reproduces_the_date_dimension_exactly():
    """The generated calendar is not an approximation of dim_date: on the
    shipped file every row's week number agrees, year-end stubs included."""
    for row in _read("dim_date2425_corrected.csv"):
        day = loader._parse_date(row["Date"])
        assert loader._derive_week(day) == int(row["Week"]), row["Date"]


def test_week_53_falls_out_of_the_rule():
    """29-31 Dec belong to week 53 of their own year, not week 1 of the next --
    the one case a naive ISO week number gets wrong."""
    from datetime import date

    assert loader._derive_week(date(2024, 12, 30)) == 53
    assert loader._derive_week(date(2025, 12, 29)) == 53
    assert loader._derive_week(date(2026, 12, 28)) == 53
    assert loader._derive_week(date(2025, 1, 1)) == 1


def test_three_file_store_matches_the_six_file_store(three_file_dataset):
    """Every OBSERVED measure is identical. The two differences are the two
    intended ones: no counterfactual baseline, and base quantity standing in
    as actual quantity."""
    six = loader._build_store(REPO_DATA)
    three = loader._build_store(three_file_dataset)

    assert three.row_count == six.row_count
    assert three.years() == six.years()
    assert sum(three.promoted) == sum(six.promoted)
    assert list(three.week) == list(six.week)
    assert list(three.month) == list(six.month)
    for measure in ("actual_quantity", "actual_revenue", "base_revenue",
                    "total_cost", "promotion_cost"):
        assert sum(getattr(three, measure)) == pytest.approx(sum(getattr(six, measure))), measure

    # Dimensions rebuilt rather than read.
    assert set(three.dims.channels) == set(six.dims.channels)
    assert {c.name for c in three.dims.channels.values()} == {
        c.name for c in six.dims.channels.values()
    }
    assert set(three.dims.promotions) == set(six.dims.promotions)
    assert three.dims.week_dates.keys() == six.dims.week_dates.keys()

    # The baseline hands over to the estimator, which is the whole point.
    assert six.counterfactual_base is True
    assert three.counterfactual_base is False
    assert sum(three.base_quantity) == sum(three.actual_quantity)


def test_blank_promotion_id_means_not_promoted(three_file_dataset):
    """A client extract leaves the cell empty; `-1` is this platform's own
    sentinel. Both must read as "no offer", or every ordinary row would be
    counted as promoted and the baseline would have nothing to stand on."""
    store = loader._build_store(three_file_dataset)
    none = store.dims.promotions[loader.NO_PROMOTION]
    assert none.is_promotional is False
    assert sum(store.promoted) < store.row_count


def test_cp_per_unit_equals_total_cost(three_file_dataset):
    """Cost of goods is the same money whether the source states it per line or
    per unit."""
    assert sum(loader._build_store(three_file_dataset).total_cost) == pytest.approx(
        sum(loader._build_store(REPO_DATA).total_cost)
    )


# --- the upload contract ---------------------------------------------------


def _classify(folder, names):
    items, unrecognised = [], []
    for name in names:
        hit = star_dataset.classify(name, (folder / name).read_bytes())
        (items.append(hit) if hit else unrecognised.append(name))
    return items, unrecognised


THREE = (config.FACT_FILE, config.DIM_FILES["product"], config.DIM_FILES["geo_store"])


def test_three_files_are_a_complete_upload(three_file_dataset):
    items, unrecognised = _classify(three_file_dataset, THREE)
    assert sorted(i.role for i in items) == ["fact", "geo_store", "product"]
    assert all(i.is_usable for i in items)
    star_dataset.validate(items, unrecognised)  # does not raise


def test_six_files_are_still_a_complete_upload():
    names = [config.FACT_FILE, *config.DIM_FILES.values()]
    items, unrecognised = _classify(REPO_DATA, names)
    assert len(items) == 6
    star_dataset.validate(items, unrecognised)  # does not raise


def test_fact_accepts_either_cost_column_and_names_the_choice(three_file_dataset, tmp_path):
    with (three_file_dataset / config.FACT_FILE).open(encoding="utf-8-sig", newline="") as fh:
        reader = csv.DictReader(fh)
        sample = [next(reader) for _ in range(20)]
    keep = [c for c in FACT_COLUMNS if c != "CP"]
    broken = tmp_path / "fact_no_cost.csv"
    _write(broken, keep, sample)

    classified = star_dataset.classify(broken.name, broken.read_bytes())
    assert classified.role == "fact"
    assert classified.missing_columns == ("Total_Cost or CP",)


def test_missing_channel_name_is_refused_when_no_channel_file(three_file_dataset, tmp_path):
    """The loader can derive the channel dimension from the store master, but
    not invent a name for it."""
    keep = [c for c in STORE_COLUMNS if c != "Channel_Name"]
    stripped = tmp_path / config.DIM_FILES["geo_store"]
    with (three_file_dataset / config.DIM_FILES["geo_store"]).open(
        encoding="utf-8-sig", newline=""
    ) as fh:
        _write(stripped, keep, list(csv.DictReader(fh)))

    items, unrecognised = _classify(three_file_dataset, THREE[:2])
    hit = star_dataset.classify(stripped.name, stripped.read_bytes())
    with pytest.raises(star_dataset.StarDatasetError, match="Channel_Name"):
        star_dataset.validate([*items, hit], unrecognised)


def test_missing_promotion_columns_are_refused_when_no_promotion_file(
    three_file_dataset, tmp_path
):
    """Same rule for offers: no dim_promotion means the fact must name the
    offer and its mechanic, or the dashboards would group by raw ids."""
    with (three_file_dataset / config.FACT_FILE).open(encoding="utf-8-sig", newline="") as fh:
        reader = csv.DictReader(fh)
        sample = [next(reader) for _ in range(20)]
    keep = [c for c in FACT_COLUMNS if c not in ("Promotion_Name", "Promotion_Type")]
    stripped = tmp_path / config.FACT_FILE
    _write(stripped, keep, sample)

    items, unrecognised = _classify(three_file_dataset, THREE[1:])
    hit = star_dataset.classify(stripped.name, stripped.read_bytes())
    with pytest.raises(star_dataset.StarDatasetError, match="Promotion_Name"):
        star_dataset.validate([*items, hit], unrecognised)


def test_a_required_table_left_out_is_still_refused(three_file_dataset):
    items, unrecognised = _classify(three_file_dataset, (config.FACT_FILE,))
    with pytest.raises(star_dataset.StarDatasetError, match="1 of 3 required tables"):
        star_dataset.validate(items, unrecognised)


# --- the install path ------------------------------------------------------


def test_upload_installs_three_files_and_locks(three_file_dataset, tmp_path, monkeypatch):
    data = tmp_path / "Data"
    data.mkdir()
    monkeypatch.setenv("TPO_DATA_DIR", str(data))
    monkeypatch.setattr(source_sync, "CONN_PATH", tmp_path / "source-connection.json")
    app.dependency_overrides[current_user] = lambda: {
        "email_key": "qa", "email": "qa@example.test"
    }
    try:
        client = TestClient(app)
        files = [
            ("files", (n, (three_file_dataset / n).read_bytes(), "text/csv"))
            for n in THREE
        ]
        response = client.post("/api/datasets", files=files)
        assert response.status_code == 200, response.text
        star = response.json()["star"]
        assert len(star["installed"]) == 3
        assert star["rows"] > 0
        assert sorted(p.name for p in data.glob("*.csv")) == sorted(THREE)

        status = client.get("/api/datasets/star").json()
        assert status["complete"] is True
        assert status["locked"] is True
        required = {f["role"]: f for f in status["files"] if f["required"]}
        assert set(required) == {"fact", "product", "geo_store"}
        assert all(f["present"] for f in required.values())
        derived = [f for f in status["files"] if not f["required"]]
        assert {f["role"] for f in derived} == {"channel", "promotion", "date"}
        assert not any(f["present"] for f in derived)
    finally:
        app.dependency_overrides.pop(current_user, None)
        # No delenv: monkeypatch.setenv already restores the session-level
        # TPO_DATA_DIR (tests/conftest.py) at teardown. Deleting it here
        # left every later test reading the real Data/ folder.
        star_dataset.reset_caches()


def test_install_deletes_a_derivable_file_the_upload_left_out(
    three_file_dataset, tmp_path, monkeypatch
):
    """The silent mis-join this module exists to prevent, reached by omission:
    last dataset's dim_promotion sitting beside a new fact table."""
    data = tmp_path / "Data"
    data.mkdir()
    stale = data / config.DIM_FILES["promotion"]
    stale.write_bytes((REPO_DATA / config.DIM_FILES["promotion"]).read_bytes())
    monkeypatch.setenv("TPO_DATA_DIR", str(data))
    try:
        star_dataset.reset_caches()
        items, unrecognised = _classify(three_file_dataset, THREE)
        star_dataset.install(items, unrecognised)
        assert not stale.exists()
        assert sorted(p.name for p in data.glob("*.csv")) == sorted(THREE)
    finally:
        # No delenv: monkeypatch.setenv already restores the session-level
        # TPO_DATA_DIR (tests/conftest.py) at teardown. Deleting it here
        # left every later test reading the real Data/ folder.
        star_dataset.reset_caches()
