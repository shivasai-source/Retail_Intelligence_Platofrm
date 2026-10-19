"""Several periods of sales, delivered as several files.

WHAT IS BEING PINNED. A client's history arrives as "Jan-Mar", "Apr-Jun",
"Jul-Sep" — out of order, with a month nobody cut, and with a boundary week
re-sent because the second export was re-run. The connector used to refuse all
of it ("2 files have these columns — keep one"), which is right for two copies
of one table and wrong for twelve months of history.

The three hazards each have a test here, because each one is a silent wrong
number rather than an error: double-counting an overlapping week, filling a
missing column with blanks, and losing a month without anything saying so.

Throwaway folders only; the live Data/ folder is never written to.
"""

from __future__ import annotations

import csv
import io
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from app import fact_union, source_sync, star_dataset
from app.deps import current_user
from app.main import app
from app.tpo import config, loader

REPO_DATA = config.DATA_DIR

FACT_COLUMNS = [
    "Date", "Product_id", "Store_Id", "Promotion_Id",
    "Base_Quantity", "Actual_Quantity", "Base_Price", "Actual_Price",
    "Total_Cost", "Promotion_Cost",
]


def _reference_rows() -> list[dict[str, str]]:
    with (REPO_DATA / config.FACT_FILE).open(encoding="utf-8-sig", newline="") as fh:
        return list(csv.DictReader(fh))


def _csv(rows: list[dict[str, str]], columns: list[str] | None = None) -> bytes:
    columns = columns or FACT_COLUMNS
    out = io.StringIO()
    writer = csv.DictWriter(out, columns, extrasaction="ignore")
    writer.writeheader()
    for row in rows:
        writer.writerow(row)
    return out.getvalue().encode("utf-8")


@pytest.fixture(scope="module")
def by_month() -> dict[str, list[dict[str, str]]]:
    grouped: dict[str, list[dict[str, str]]] = {}
    for row in _reference_rows():
        grouped.setdefault(row["Date"][3:], []).append(row)
    return grouped


@pytest.fixture(scope="module")
def parts(by_month) -> list[tuple[str, bytes]]:
    """Four 2024 extracts, delivered out of order, October absent, and the
    last week of March re-sent in the April file."""
    march = by_month["03-2024"]
    last_march = max(m["Date"] for m in march)
    resent = [m for m in march if m["Date"] == last_march]
    return [
        ("P1_JAN_MAR.csv", _csv(sum((by_month[m] for m in ("01-2024", "02-2024", "03-2024")), []))),
        ("P3_JUL_SEP.csv", _csv(sum((by_month[m] for m in ("07-2024", "08-2024", "09-2024")), []))),
        ("P2_APR_JUN.csv", _csv(resent + sum((by_month[m] for m in ("04-2024", "05-2024", "06-2024")), []))),
        ("P4_NOV_DEC.csv", _csv(sum((by_month[m] for m in ("11-2024", "12-2024")), []))),
    ]


# --- coverage --------------------------------------------------------------


def test_coverage_reports_the_whole_span_whatever_order_files_arrive_in(parts):
    plan = fact_union.coverage(parts)
    assert plan.first == "01-01-2024"
    assert plan.last.endswith("-12-2024")
    assert plan.rows_delivered == sum(
        len(list(fact_union._rows(payload))) for _, payload in parts
    )


def test_coverage_names_the_month_nobody_sent(parts):
    """A MISSING MONTH IS NOT ZERO SALES. Without dim_date the calendar is
    generated from the fact's own dates, so an absent October simply ceases to
    exist and no downstream check would ever notice."""
    plan = fact_union.coverage(parts)
    assert plan.gaps, "October was left out and must be reported"
    assert any("41" in gap and "44" in gap for gap in plan.gaps), plan.gaps


def test_coverage_names_the_files_that_overlap(parts):
    plan = fact_union.coverage(parts)
    assert len(plan.overlaps) == 1
    assert "P1_JAN_MAR.csv" in plan.overlaps[0]
    assert "P2_APR_JUN.csv" in plan.overlaps[0]


def test_a_contiguous_delivery_has_nothing_to_report(by_month):
    payloads = [
        (f"{month}.csv", _csv(by_month[month]))
        for month in ("01-2024", "02-2024", "03-2024")
    ]
    plan = fact_union.coverage(payloads)
    assert plan.gaps == ()
    assert plan.overlaps == ()
    assert plan.dropped_columns == ()


# --- merging ---------------------------------------------------------------


def test_an_overlapping_week_is_counted_once(parts):
    """Two files both holding 25-03-2024 would otherwise double every measure
    in that week."""
    merged, stats = fact_union.merge(parts)
    assert stats["duplicates_removed"] > 0
    assert stats["conflicts"] == 0
    assert stats["rows_out"] == stats["rows_in"] - stats["duplicates_removed"]

    dates = [row[0] for row in fact_union._rows(merged)]
    assert len(dates) == len(set(
        tuple(row[:4]) for row in fact_union._rows(merged)
    )), "the merged table still has duplicate grain keys"


def test_the_merged_table_equals_the_reference_for_that_period(parts, by_month):
    """The union is a concatenation, not a transformation: every row of 2024
    except October, exactly once."""
    merged, _ = fact_union.merge(parts)
    expected = sum(
        (by_month[m] for m in (
            "01-2024", "02-2024", "03-2024", "04-2024", "05-2024", "06-2024",
            "07-2024", "08-2024", "09-2024", "11-2024", "12-2024",
        )),
        [],
    )
    rows = list(fact_union._rows(merged))
    assert len(rows) == len(expected)
    assert sum(float(r[FACT_COLUMNS.index("Actual_Quantity")]) for r in rows) == pytest.approx(
        sum(float(r["Actual_Quantity"]) for r in expected)
    )


def test_a_conflicting_resend_is_counted_and_the_later_period_wins(by_month):
    """An exact re-send is harmless; the same row with different measures is a
    data problem the user should be told they have."""
    january = by_month["01-2024"][:5]
    altered = [{**row, "Actual_Quantity": str(int(float(row["Actual_Quantity"])) + 7)}
               for row in january]
    merged, stats = fact_union.merge([
        ("early.csv", _csv(january)),
        # Same rows, same dates, different quantities.
        ("late.csv", _csv(altered)),
    ])
    assert stats["duplicates_removed"] == 5
    assert stats["conflicts"] == 5
    rows = list(fact_union._rows(merged))
    assert len(rows) == 5
    index = FACT_COLUMNS.index("Actual_Quantity")
    assert sorted(r[index] for r in rows) == sorted(r["Actual_Quantity"] for r in altered)


def test_a_column_one_file_lacks_is_dropped_rather_than_blanked(by_month):
    """Filling blanks would make that period's promotions look free and send
    its ROI to infinity. The intersection is taken and reported instead."""
    full = by_month["01-2024"][:20]
    without = [c for c in FACT_COLUMNS if c != "Promotion_Cost"]
    merged, stats = fact_union.merge([
        ("has_cost.csv", _csv(full)),
        ("no_cost.csv", _csv(by_month["02-2024"][:20], without)),
    ])
    assert stats["dropped_columns"] == ["Promotion_Cost"]
    assert "Promotion_Cost" not in fact_union._header(merged)


def test_one_file_is_passed_straight_through(by_month):
    """The single-file path must stay byte-identical: every existing upload
    goes through here now."""
    payload = _csv(by_month["01-2024"])
    merged, stats = fact_union.merge([("only.csv", payload)])
    assert merged == payload
    assert stats["files"] == 1


# --- through the connector -------------------------------------------------


def test_uploading_four_sales_files_installs_one_merged_table(
    parts, by_month, tmp_path, monkeypatch
):
    """END TO END. Four files in, one canonical fact table out, and the loader
    reads the whole span."""
    data = tmp_path / "Data"
    data.mkdir()
    monkeypatch.setenv("TPO_DATA_DIR", str(data))
    monkeypatch.setattr(source_sync, "CONN_PATH", tmp_path / "source-connection.json")
    app.dependency_overrides[current_user] = lambda: {
        "email_key": "qa", "email": "qa@example.test"
    }
    try:
        star_dataset.reset_caches()
        client = TestClient(app)
        files = [("files", (name, payload, "text/csv")) for name, payload in parts]
        # The reference fact carries no Promotion_Name and the reference store
        # no Channel_Name, so CROSS_FILE_RULES wants both dimensions uploaded
        # rather than derived. That is the six-file shape, not this feature.
        dims = ("product", "geo_store", "channel", "promotion")
        for role in dims:
            name = config.DIM_FILES[role]
            files.append(("files", (name, (REPO_DATA / name).read_bytes(), "text/csv")))

        response = client.post("/api/datasets", files=files)
        assert response.status_code == 200, response.text
        star = response.json()["star"]

        # Four sales files became ONE table on disk, beside the dimensions.
        assert sorted(p.name for p in data.glob("*.csv")) == sorted(
            [config.FACT_FILE, *(config.DIM_FILES[r] for r in dims)]
        )
        assert star["union"]["files"] == 4
        assert star["union"]["duplicates_removed"] > 0
        assert star["union"]["rows_out"] == star["rows"]

        store = loader._build_store(data)
        assert store.row_count == star["union"]["rows_out"]
        # Every month delivered is present; October is not.
        assert store.years() == [2024]
    finally:
        app.dependency_overrides.pop(current_user, None)
        star_dataset.reset_caches()


def test_two_product_masters_are_still_refused(by_month):
    """Several SALES files are a delivery. Several copies of a DIMENSION are
    two versions of one list, and picking either silently mis-joins the fact."""
    master = (REPO_DATA / config.DIM_FILES["product"]).read_bytes()
    items = [
        star_dataset.classify("products_a.csv", master),
        star_dataset.classify("products_b.csv", master),
        star_dataset.classify(config.FACT_FILE, (REPO_DATA / config.FACT_FILE).read_bytes()),
        star_dataset.classify(
            config.DIM_FILES["geo_store"], (REPO_DATA / config.DIM_FILES["geo_store"]).read_bytes()
        ),
    ]
    with pytest.raises(star_dataset.StarDatasetError) as caught:
        star_dataset.validate([i for i in items if i], [])
    assert "keep one" in str(caught.value)
