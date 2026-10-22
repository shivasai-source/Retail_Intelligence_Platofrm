"""MMM: several periods of daily history delivered as several files.

A client's history arrives as "Jan-Mar", "Apr-Jun", "Jul-Sep" — out of order,
with a month nobody cut, and with a boundary day re-sent. These tests pin the
three decisions app/mmm/day_union.py makes about that, which are the same three
TPO's app/fact_union.py makes:

  SCHEMA   a column only some files have is DROPPED and reported, never filled
           with zeros — a channel that looks switched off for one quarter moves
           its whole response curve.
  OVERLAP  a day in two files is counted once, the later period wins, and a
           disagreement is counted separately from a harmless re-send.
  COVERAGE a month nobody sent is an absent month, not zero spend, and the
           reader is told before the install.

Runs against a throwaway MMM data folder and Report Center database.
"""

from __future__ import annotations

import csv
import io
import json
from datetime import date, timedelta

import pytest
from fastapi.testclient import TestClient

from app.deps import current_user
from app.main import app
from app.mmm import dataset, day_union, loader
from app.store import db

client = TestClient(app)

HEADER = ["Date", "Revenue", "TV_Spend", "Meta_Ads_Spend"]


def period(start: date, days: int, *, header: list[str] | None = None,
           revenue: int = 1_000_000, tv: int = 5000) -> bytes:
    """`days` consecutive days from `start`, in MMM's own column names."""
    cols = header or HEADER
    out = io.StringIO()
    w = csv.writer(out)
    w.writerow(cols)
    for i in range(days):
        day = start + timedelta(days=i)
        row = {
            "Date": day.strftime("%d-%m-%Y"),
            "Revenue": str(revenue + i),
            "TV_Spend": str(tv),
            "Meta_Ads_Spend": "2500",
            "TikTok_Ads_Spend": "700",
            "NetSales": str(revenue + i),
            "TxnDate": day.strftime("%d-%m-%Y"),
            "TV": str(tv),
        }
        w.writerow([row.get(c, "0") for c in cols])
    return out.getvalue().encode("utf-8")


def upload(files: list[tuple[str, bytes]], mapping: dict | None = None):
    payload = [("files", (name, content, "text/csv")) for name, content in files]
    data = {"mapping": json.dumps(mapping)} if mapping is not None else {}
    return client.post("/api/mmm/dataset", files=payload, data=data)


def inspect(files: list[tuple[str, bytes]], mapping: dict | None = None, coverage: bool = True):
    payload = [("files", (name, content, "text/csv")) for name, content in files]
    data: dict[str, str] = {"coverage": "1" if coverage else ""}
    if mapping is not None:
        data["mapping"] = json.dumps(mapping)
    return client.post("/api/mmm/dataset/inspect", files=payload, data=data)


@pytest.fixture(autouse=True)
def isolated(tmp_path, monkeypatch):
    monkeypatch.setenv("MMM_DATA_DIR", str(tmp_path / "mmm"))
    monkeypatch.setenv("MMM_SOURCE_CONN_PATH", str(tmp_path / "conn.json"))
    app.dependency_overrides[current_user] = lambda: {"email": "qa@example.test"}
    db.use_path(tmp_path / "reports.db")
    loader.reset_cache()
    yield
    loader.reset_cache()
    db.close()
    app.dependency_overrides.pop(current_user, None)


# --- the ordinary case --------------------------------------------------------


def test_three_quarters_become_one_dataset():
    res = upload([
        ("q1.csv", period(date(2024, 1, 1), 91)),
        ("q2.csv", period(date(2024, 4, 1), 91)),
        ("q3.csv", period(date(2024, 7, 1), 92)),
    ])
    assert res.status_code == 200, res.text
    body = res.json()
    assert body["rows"] == 274
    assert body["files"] == ["q1.csv", "q2.csv", "q3.csv"]
    assert body["union"]["files"] == 3
    assert body["union"]["rows_out"] == 274

    status = client.get("/api/mmm/dataset").json()
    assert status["complete"] is True
    assert status["rows"] == 274
    assert status["period"] == {"from": "01-01-2024", "to": "30-09-2024"}


def test_files_out_of_order_still_land_in_date_order():
    res = upload([
        ("c-jul.csv", period(date(2024, 7, 1), 31)),
        ("a-jan.csv", period(date(2024, 1, 1), 31)),
        ("b-apr.csv", period(date(2024, 4, 1), 30)),
    ])
    assert res.status_code == 200, res.text
    preview = client.get("/api/mmm/dataset/preview?limit=200").json()
    dates = [row[preview["columns"].index("Date")] for row in preview["rows"]]
    assert dates[0] == "01-01-2024"
    assert dates[-1] == "31-07-2024"
    assert dates == sorted(dates, key=lambda d: (d[6:], d[3:5], d[:2]))


def test_one_file_behaves_exactly_as_it_always_did():
    """The single-file path must not change shape just because several are now
    possible — it is the common case."""
    res = client.post(
        "/api/mmm/dataset",
        files={"file": ("one.csv", period(date(2024, 1, 1), 40), "text/csv")},
    )
    assert res.status_code == 200, res.text
    body = res.json()
    assert body["rows"] == 40
    assert body["union"] is None, "nothing was merged, so there is no merge to report"


# --- OVERLAP ------------------------------------------------------------------


def test_a_re_sent_day_is_counted_once():
    # 31 days from 1 Jan, then 31 days from 25 Jan: seven days in both.
    res = upload([
        ("jan.csv", period(date(2024, 1, 1), 31)),
        ("feb.csv", period(date(2024, 1, 25), 31)),
    ])
    assert res.status_code == 200, res.text
    body = res.json()
    assert body["rows"] == 55, "31 + 31 - 7 repeated days"
    assert body["union"]["duplicates_removed"] == 7
    assert any("counted once" in w for w in body["warnings"])


def test_the_later_period_wins_a_disagreement():
    """A restated extract: the same days, different numbers. The later file's
    version is installed and the disagreement is reported."""
    res = upload([
        ("a-first.csv", period(date(2024, 1, 1), 10, revenue=1_000_000)),
        ("b-restated.csv", period(date(2024, 1, 5), 10, revenue=9_000_000)),
    ])
    assert res.status_code == 200, res.text
    body = res.json()
    assert body["union"]["duplicates_removed"] == 6
    assert body["union"]["conflicts"] == 6
    assert any("disagreed" in w for w in body["warnings"])

    preview = client.get("/api/mmm/dataset/preview?limit=50").json()
    revenue = preview["columns"].index("Revenue")
    dates = preview["columns"].index("Date")
    by_day = {row[dates]: float(row[revenue]) for row in preview["rows"]}
    assert by_day["05-01-2024"] == 9_000_000, "the later period's version survived"
    assert by_day["01-01-2024"] == 1_000_000, "the earlier file still owns its own days"


def test_a_repeated_day_is_never_two_rows():
    """MMM's own rule — one row per day — holds across a delivery, or the
    installer would refuse the merged table outright."""
    res = upload([
        ("one.csv", period(date(2024, 1, 1), 20)),
        ("two.csv", period(date(2024, 1, 1), 20)),
    ])
    assert res.status_code == 200, res.text
    assert res.json()["rows"] == 20


# --- SCHEMA -------------------------------------------------------------------


def test_a_column_only_some_files_have_is_dropped_and_reported():
    with_tiktok = [*HEADER, "TikTok_Ads_Spend"]
    res = upload([
        ("q1.csv", period(date(2024, 1, 1), 31, header=with_tiktok)),
        ("q2.csv", period(date(2024, 2, 1), 29)),
    ])
    assert res.status_code == 200, res.text
    body = res.json()
    assert "TikTok_Ads_Spend" in body["union"]["dropped_columns"]
    assert "TikTok_Ads_Spend" not in body["media_columns"]
    assert any("zeros" in w for w in body["warnings"]), (
        "a channel that looks switched off for one quarter is worse than an absent channel"
    )


def test_a_delivery_with_no_shared_spend_column_is_refused():
    res = upload([
        ("a.csv", period(date(2024, 1, 1), 10, header=["Date", "Revenue", "TV_Spend"])),
        ("b.csv", period(date(2024, 2, 1), 10, header=["Date", "Revenue", "Meta_Ads_Spend"])),
    ])
    assert res.status_code == 400
    assert "_Spend" in res.json()["detail"]


# --- COVERAGE -----------------------------------------------------------------


def test_coverage_names_the_month_nobody_sent():
    res = inspect([
        ("jan.csv", period(date(2024, 1, 1), 31)),
        ("mar.csv", period(date(2024, 3, 1), 31)),
    ])
    assert res.status_code == 200, res.text
    plan = res.json()["coverage"]
    assert plan["days"] == 62
    assert plan["first"] == "01-01-2024" and plan["last"] == "31-03-2024"
    assert plan["gaps"], "all of February is missing and must be said"
    assert "01-02-2024" in plan["gaps"][0] and "29-02-2024" in plan["gaps"][0]
    assert plan["has_warnings"] is True


def test_coverage_reports_each_file_s_own_span():
    res = inspect([
        ("q1.csv", period(date(2024, 1, 1), 91)),
        ("q2.csv", period(date(2024, 4, 1), 91)),
    ])
    files = {f["filename"]: f for f in res.json()["coverage"]["files"]}
    assert files["q1.csv"]["first"] == "01-01-2024"
    assert files["q1.csv"]["last"] == "31-03-2024"
    assert files["q1.csv"]["days"] == 91
    assert files["q2.csv"]["first"] == "01-04-2024"


def test_coverage_says_which_files_repeat_days():
    res = inspect([
        ("jan.csv", period(date(2024, 1, 1), 31)),
        ("feb.csv", period(date(2024, 1, 25), 31)),
    ])
    plan = res.json()["coverage"]
    assert plan["duplicate_rows"] == 7
    assert plan["overlaps"] and "7 days" in plan["overlaps"][0]


def test_a_continuous_delivery_reports_no_gaps():
    res = inspect([
        ("jan.csv", period(date(2024, 1, 1), 31)),
        ("feb.csv", period(date(2024, 2, 1), 29)),
    ])
    plan = res.json()["coverage"]
    assert plan["gaps"] == []
    assert plan["has_warnings"] is False


def test_a_gap_outside_the_delivered_span_is_not_invented():
    """A dataset that starts in March says nothing about January."""
    assert day_union.describe_gaps({date(2024, 3, 1), date(2024, 3, 2)}) == ()


def test_coverage_is_not_computed_unless_asked():
    res = inspect([("jan.csv", period(date(2024, 1, 1), 31))], coverage=False)
    assert "coverage" not in res.json()


# --- the delivery's verdict ---------------------------------------------------


def test_a_file_missing_revenue_is_fine_when_another_carries_the_month():
    """The install judges the MERGED table, so a per-file verdict must not be
    mistaken for the delivery's."""
    res = inspect([
        ("a.csv", period(date(2024, 1, 1), 10)),
        ("b.csv", period(date(2024, 2, 1), 10)),
    ])
    body = res.json()
    assert body["ok"] is True
    assert all(f["ok"] for f in body["files"])


def test_each_file_keeps_its_own_column_mapping():
    """A client who renamed a column half way through the year is ordinary."""
    ours = period(date(2024, 1, 1), 31)
    theirs = period(date(2024, 2, 1), 29, header=["TxnDate", "NetSales", "TV"])
    res = upload(
        [("jan.csv", ours), ("feb.csv", theirs)],
        {"feb.csv": {"TxnDate": "Date", "NetSales": "Revenue", "TV": "TV_Spend"}},
    )
    assert res.status_code == 200, res.text
    body = res.json()
    assert body["rows"] == 60
    assert body["union"]["files"] == 2
    # Meta came only from January, so the merge dropped it rather than
    # inventing February's figures.
    assert "Meta_Ads_Spend" in body["union"]["dropped_columns"]
    assert body["media_columns"] == ["TV_Spend"]


def test_one_file_s_names_cannot_be_applied_to_another():
    """Sent flat with several files, the mapping is refused rather than guessed
    at: applying one file's names to another's columns is how a column
    silently becomes the wrong measure."""
    res = upload(
        [("a.csv", period(date(2024, 1, 1), 5)), ("b.csv", period(date(2024, 2, 1), 5))],
        {"TxnDate": "Date"},
    )
    assert res.status_code == 400
    assert "keyed by filename" in res.json()["detail"]


def test_an_unreadable_file_is_skipped_and_named():
    res = upload([
        ("good.csv", period(date(2024, 1, 1), 20)),
        ("notes.csv", b"Owner,Comment\nme,hello\n"),
    ])
    assert res.status_code == 200, res.text
    body = res.json()
    assert body["rows"] == 20
    assert any("notes.csv" in w and "Skipped" in w for w in body["warnings"])


def test_every_file_unreadable_is_a_refusal_not_an_empty_dataset():
    res = upload([
        ("a.csv", b"Owner,Comment\nme,hello\n"),
        ("b.csv", b"Owner,Comment\nyou,hi\n"),
    ])
    assert res.status_code == 400
    assert client.get("/api/mmm/dataset").json()["complete"] is False


def test_a_delivery_serves_the_hub():
    assert upload([
        ("q1.csv", period(date(2024, 1, 1), 91)),
        ("q2.csv", period(date(2024, 4, 1), 91)),
    ]).status_code == 200
    hub = client.get("/api/mmm/hub?granularity=month&currency=INR")
    assert hub.status_code == 200, hub.text
    assert hub.json()["meta"]["days"] == 182


def test_a_delivery_replaces_a_previous_dataset():
    assert upload([("one.csv", period(date(2024, 1, 1), 50))]).status_code == 200
    assert upload([
        ("a.csv", period(date(2023, 1, 1), 31)),
        ("b.csv", period(date(2023, 2, 1), 28)),
    ]).status_code == 200
    status = client.get("/api/mmm/dataset").json()
    assert status["rows"] == 59
    assert status["period"]["from"] == "01-01-2023"


def test_the_source_name_names_the_delivery():
    upload([("q1.csv", period(date(2024, 1, 1), 31)), ("q2.csv", period(date(2024, 2, 1), 29))])
    name = client.get("/api/mmm/dataset").json()["source_name"]
    assert "2 files" in name and "q1.csv" in name


def test_a_merged_install_is_still_validated_as_one_table():
    """The merge must not become a way past the row rules: a bad figure in one
    file is still a bad figure in the delivery."""
    bad = period(date(2024, 2, 1), 10).replace(b"5000", b"not-a-number", 1)
    res = upload([("good.csv", period(date(2024, 1, 1), 31)), ("bad.csv", bad)])
    assert res.status_code == 400
    assert "non-numeric" in res.json()["detail"]
    assert client.get("/api/mmm/dataset").json()["complete"] is False
