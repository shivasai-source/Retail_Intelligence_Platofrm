"""MMM module: upload contract, install, status, hub, calendar and report.

Runs against a throwaway MMM data folder (MMM_DATA_DIR) and a throwaway Report
Center database (db.use_path), so it never touches the live MMM dataset or
backend/.store/tiq.db. A small synthetic daily file stands in for the
reference MMM_Final_Daily_Dataset.csv â€” same column layout, made-up numbers.
"""

from __future__ import annotations

import csv
import io
from datetime import date, timedelta

import pytest
from fastapi.testclient import TestClient

from app.deps import current_user
from app.main import app
import numpy as np
import pandas as pd

from app.mmm import baseline, dataset, loader, schema, scope
from app.store import db

client = TestClient(app)

REFERENCE_HEADER = [c.name for c in schema.COLUMNS]


def daily_csv(days: int = 800, *, header: list[str] | None = None,
              start: date = date(2024, 1, 1), mutate=None) -> bytes:
    """A reference-shaped file: alternate days dark, every 7th day a festival day."""
    cols = header or REFERENCE_HEADER
    out = io.StringIO()
    writer = csv.writer(out)
    writer.writerow(cols)
    for i in range(days):
        d = start + timedelta(days=i)
        on = i % 2 == 0
        row = {
            "Date": d.strftime("%d-%m-%Y"), "Revenue": str(1_000_000 + i * 10),
            "Festival_Flag": "1" if i % 7 == 0 else "0", "Seasonal_Flag": "0",
            "Promotion_Flag": "1" if i % 3 == 0 else "0",
            "Discount_Percentage": "10" if i % 3 == 0 else "0",
            "Promotion_Type": "10% Discount" if i % 3 == 0 else "No Offer",
            "Month": str(d.month), "Quarter": f"Q{(d.month - 1) // 3 + 1}",
            "Week_of_Year": str(d.isocalendar()[1]), "Year": str(d.year),
        }
        for col, _ in schema.MEDIA_CHANNELS:
            row[col] = "1000" if on else "0"
        if mutate:
            mutate(i, row)
        writer.writerow([row.get(c, "") for c in cols])
    return out.getvalue().encode("utf-8")


@pytest.fixture(autouse=True)
def isolated(tmp_path, monkeypatch):
    monkeypatch.setenv("MMM_DATA_DIR", str(tmp_path / "mmm"))
    app.dependency_overrides[current_user] = lambda: {"email": "qa@example.test"}
    db.use_path(tmp_path / "reports.db")
    loader.reset_cache()
    yield
    loader.reset_cache()
    db.close()
    app.dependency_overrides.pop(current_user, None)


def upload(content: bytes, name: str = "MMM_Final_Daily_Dataset.csv"):
    return client.post("/api/mmm/dataset", files={"file": (name, content, "text/csv")})


# --- the contract -------------------------------------------------------------


def test_the_contract_lists_the_reference_files_41_columns():
    # 33 reference columns + 7 channel totals + Total_Spend.
    assert len(schema.COLUMNS) == 41
    assert schema.REQUIRED == ("Date", "Revenue")
    assert len(schema.MEDIA_CHANNELS) == 22
    assert len(schema.CHANNEL_TOTALS) == 7


def test_channel_totals_are_recognised_and_never_counted_as_channels():
    match = schema.match_header(["Date", "Revenue", "TV_Spend", "OTT_Spend",
                                 "Channel_Broadcast_Video_Spend", "Channel_Radio_Spend", "Total_Spend"])
    assert match.media == ("TV_Spend", "OTT_Spend")
    assert set(match.rollups) == {"Channel_Broadcast_Video_Spend", "Channel_Radio_Spend", "Total_Spend"}
    assert "Total_Spend" not in match.missing_optional


def test_old_flag_names_are_read_as_festival_and_seasonal():
    match = schema.match_header(["Date", "Revenue", "TV_Spend", "Holiday_Flag", "trending_flag"])
    assert match.rename["Holiday_Flag"] == "Festival_Flag"
    assert match.rename["trending_flag"] == "Seasonal_Flag"


def test_spend_totals_are_checked_but_not_stored(tmp_path):
    rows = ["Date,Revenue,TV_Spend,OTT_Spend,Channel_Broadcast_Video_Spend,Total_Spend",
            "01-01-2024,1000,100,50,150,150",
            "02-01-2024,1000,100,50,150,999"]  # the second day's total is wrong
    r = upload(("\n".join(rows) + "\n").encode(), "totals.csv")
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["media_columns"] == ["TV_Spend", "OTT_Spend"]
    assert any("Total_Spend differs" in w for w in body["warnings"])
    assert not any("Channel_Broadcast_Video_Spend differs" in w for w in body["warnings"])
    stored = (tmp_path / "mmm" / "mmm_daily.csv").read_text(encoding="utf-8").splitlines()[0]
    assert "Total_Spend" not in stored and "Channel_" not in stored
    hub = client.get("/api/mmm/hub", params={"year": 2024}).json()
    spend = next(k for k in hub["kpis"] if k["key"] == "spend")
    assert spend["value"] == 300  # (100 + 50) × 2 — the totals are never added again


def test_header_matching_is_case_insensitive_and_keeps_unknown_spend_channels():
    match = schema.match_header(["date", "REVENUE", "tv_spend", "Radio_Spend", "Notes"])
    assert match.ok
    assert match.rename["date"] == "Date"
    assert match.media == ("TV_Spend", "Radio_Spend")
    assert match.ignored == ("Notes",)


def test_a_file_without_spend_is_refused_by_name():
    match = schema.match_header(["Date", "Revenue"])
    assert not match.ok
    assert any("_Spend" in p for p in match.problems())


# --- status before anything is installed --------------------------------------


def test_nothing_installed_reads_as_incomplete_and_data_routes_say_so():
    body = client.get("/api/mmm/dataset").json()
    assert body["complete"] is False
    assert body["total"] == 4 and body["present"] == 0
    hub = client.get("/api/mmm/hub")
    assert hub.status_code == 503
    assert hub.json()["mmm_dataset_missing"] is True


# --- install --------------------------------------------------------------------


def test_the_reference_layout_installs_and_reports_every_group():
    response = upload(daily_csv())
    assert response.status_code == 200, response.text
    body = response.json()
    assert body["rows"] == 800
    assert len(body["media_columns"]) == 22
    status = body["status"]
    assert status["complete"] is True
    assert status["present"] == 4
    assert status["source_name"] == "MMM_Final_Daily_Dataset.csv"
    assert status["period"] == {"from": "01-01-2024", "to": "10-03-2026"}


def test_core_only_file_installs_and_derives_the_calendar():
    header = ["Date", "Revenue", "TV_Spend"]
    response = upload(daily_csv(30, header=header))
    assert response.status_code == 200, response.text
    body = response.json()
    assert any("Derived from Date" in w for w in body["warnings"])
    frame = loader.get_frame()
    assert list(frame["Year"].unique()) == [2024]


def test_every_bad_value_is_reported_together():
    def spoil(i, row):
        if i == 3:
            row["Date"] = "31-31-2024"
        if i == 5:
            row["Revenue"] = "abc"
        if i == 8:
            row["TV_Spend"] = "-5"

    response = upload(daily_csv(20, mutate=spoil))
    assert response.status_code == 400
    detail = response.json()["detail"]
    assert "Date" in detail and "Revenue" in detail and "negative" in detail


def test_a_repeated_date_is_refused():
    def repeat(i, row):
        if i == 1:
            row["Date"] = "01-01-2024"

    assert upload(daily_csv(10, mutate=repeat)).status_code == 400


def test_a_new_upload_replaces_the_old_one_and_reset_clears_it():
    upload(daily_csv(800))
    upload(daily_csv(10))
    assert client.get("/api/mmm/dataset").json()["rows"] == 10
    assert client.delete("/api/mmm/dataset").json()["complete"] is False
    assert client.get("/api/mmm/hub").status_code == 503


def test_mmm_writes_only_into_its_own_folder(tmp_path):
    upload(daily_csv(10))
    assert (tmp_path / "mmm" / "mmm_daily.csv").exists()
    assert not any(p.name.startswith("mmm") for p in (tmp_path.parent).glob("Data/*"))


def test_default_folder_is_data_mmm_and_legacy_store_is_moved_once(tmp_path, monkeypatch):
    """Without MMM_DATA_DIR the dataset lives in <repo>/Data/mmm/, and one
    left in the old backend/.store/mmm/ is MOVED there — so an MMM reset
    afterwards cannot be undone by adopting the old copy again."""
    from app.mmm import config as mmm_config

    monkeypatch.delenv("MMM_DATA_DIR", raising=False)
    repo = tmp_path / "repo"
    legacy = tmp_path / "legacy"
    legacy.mkdir()
    (legacy / "mmm_daily.csv").write_text("Date,Revenue\n", encoding="utf-8")
    (legacy / "mmm_source.txt").write_text("old.csv", encoding="utf-8")
    monkeypatch.setattr(mmm_config, "_REPO_ROOT", repo)
    monkeypatch.setattr(mmm_config, "_LEGACY_DIR", legacy)

    folder = mmm_config.data_dir()
    assert folder == repo / "Data" / "mmm"
    assert (folder / "mmm_daily.csv").read_text(encoding="utf-8") == "Date,Revenue\n"
    assert (folder / "mmm_source.txt").read_text(encoding="utf-8") == "old.csv"
    assert not (legacy / "mmm_daily.csv").exists()

    # A reset empties the folder; asking again must not resurrect anything.
    (folder / "mmm_daily.csv").unlink()
    assert not (mmm_config.data_dir() / "mmm_daily.csv").exists()


def test_inspect_reads_headers_without_installing():
    body = client.post("/api/mmm/dataset/inspect",
                       files={"file": ("x.csv", daily_csv(5), "text/csv")}).json()
    assert body["ok"] is True
    assert client.get("/api/mmm/dataset").json()["complete"] is False


# --- hub, calendar, report ------------------------------------------------------


def test_hub_compares_a_partial_year_like_for_like():
    upload(daily_csv(800))  # 2024-01-01 .. 2026-03-10 (2024 is a leap year)
    body = client.get("/api/mmm/hub", params={"year": 2026}).json()
    assert body["meta"]["days"] == 69
    revenue = next(k for k in body["kpis"] if k["key"] == "revenue")
    assert revenue["comparison"].startswith("vs 01 Jan")
    assert revenue["comparison"].endswith("10 Mar 2025")
    spend = next(k for k in body["kpis"] if k["key"] == "spend")
    assert spend["value"] == 34 * 22 * 1000
    assert body["channels"][0]["share"] == pytest.approx(100 / 22, abs=0.01)
    ads = next(e for e in body["events"] if e["key"] == "ad_spend")
    assert ads["without_days"] == 35
    # Seasonal_Flag is never 1 in this file, so there are no X or Y days and
    # no baseline -- reported as unavailable, never as zero.
    assert body["baseline"]["available"] is False
    roas = next(k for k in body["kpis"] if k["key"] == "roas")
    assert roas["value"] is None and roas["available"] is False


def test_hub_rejects_a_year_with_no_rows():
    upload(daily_csv(10))
    assert client.get("/api/mmm/hub", params={"year": 2001}).status_code == 422


def test_calendar_matrix_and_month_detail():
    upload(daily_csv(800))
    matrix = client.get("/api/mmm/calendar", params={"year": 2025}).json()
    assert len(matrix["channels"]) == 22
    assert len(matrix["months"]) == 12
    jan = matrix["channels"][0]["cells"][0]
    assert jan["active_days"] == 15 or jan["active_days"] == 16
    detail = client.get("/api/mmm/calendar/month", params={"year": 2025, "month": 2}).json()
    assert len(detail["days"]) == 28


def test_the_mmm_report_generates_into_the_report_center():
    upload(daily_csv(800))
    response = client.post("/api/reports", json={
        "module": "mmm-insights", "scope": {}, "options": {"year": 2025, "filename_hint": "2025"},
    })
    assert response.status_code == 201, response.text
    report = response.json()
    assert report["module"] == "mmm-insights"
    assert report["status"] == "ready"
    listed = client.get("/api/reports", params={"module": "mmm-insights"}).json()
    assert listed["total"] == 1


def test_each_module_family_sees_and_clears_only_its_own_reports():
    upload(daily_csv(400))
    client.post("/api/reports", json={"module": "mmm-insights", "scope": {}, "options": {}})
    mmm = client.get("/api/reports", params={"family": "mmm"}).json()
    tpo = client.get("/api/reports", params={"family": "tpo"}).json()
    assert mmm["total"] == 1 and [m["key"] for m in mmm["modules"]] == ["mmm-insights"]
    assert tpo["total"] == 0 and "mmm-insights" not in [m["key"] for m in tpo["modules"]]
    # Clearing TPO's library leaves the MMM report alone.
    assert client.delete("/api/reports", params={"family": "tpo"}).json()["deleted"] == 0
    assert client.get("/api/reports", params={"family": "mmm"}).json()["total"] == 1

# --- the baseline -----------------------------------------------------------------


def _frame(kinds: str, start: str = "2025-01-01") -> pd.DataFrame:
    """One row per character: X, Y, R or . (any other day). Revenue per kind is
    fixed, so the formula's answer is known: X=150, Y=120, R=110, other=100."""
    revenue = {"X": 150.0, "Y": 120.0, "R": 110.0, ".": 100.0}
    rows = []
    for i, k in enumerate(kinds):
        flags = 1 if k in "XY" else 0
        rows.append({
            "Date": pd.Timestamp(start) + pd.Timedelta(days=i), "Revenue": revenue[k],
            "TV_Spend": 0.0 if k == "Y" or (k == "." and i % 2) else 10.0,
            "Festival_Flag": flags, "Seasonal_Flag": flags,
            "Promotion_Flag": 1 if k in "XY" or (k == "." and i % 2 == 0) else 0,
        })
    return pd.DataFrame(rows)


def test_baseline_is_r_minus_x_minus_y():
    frame = _frame("XXYRR....")
    est = baseline.Engine(frame, ["TV_Spend"]).estimate(np.ones(len(frame), dtype=bool))
    # Z = X - Y = 150 - 120 = 30; baseline = R - Z = 110 - 30 = 80
    assert est.z == pytest.approx(30)
    assert est.per_day == pytest.approx(80)
    assert est.days == {"x": 2, "y": 1, "r": 2}
    assert est.widened is False


def test_a_range_missing_a_kind_of_day_widens_and_says_so():
    frame = _frame("Y" + "." * 20 + "XR" + "." * 20)
    mask = np.zeros(len(frame), dtype=bool)
    mask[20:24] = True  # holds X and R but no Y
    est = baseline.Engine(frame, ["TV_Spend"]).estimate(mask)
    assert est.widened is True
    assert est.days["y"] == 1
    assert est.window_from == frame["Date"][0]
    assert est.per_day == pytest.approx(80)


def test_no_baseline_without_every_kind_of_day_or_without_flags():
    frame = _frame("XXRR....")
    est = baseline.Engine(frame, ["TV_Spend"]).estimate(np.ones(len(frame), dtype=bool))
    assert est.available is False and "Y" in est.reason
    est = baseline.Engine(frame.drop(columns=["Seasonal_Flag"]), ["TV_Spend"]).estimate(
        np.ones(len(frame), dtype=bool))
    assert est.available is False and "Seasonal_Flag" in est.reason


def _designed_csv() -> bytes:
    """daily_csv with a repeating X / Y / R / plain pattern: every channel on
    for X and R, off for Y; all flags on for X and Y, off for R."""
    def design(i, row):
        kind = "XYR."[i % 4]
        on = kind in "XR" or (kind == "." and i % 8 == 3)
        flag = "1" if kind in "XY" else "0"
        row["Revenue"] = {"X": "150", "Y": "120", "R": "110", ".": "100"}[kind]
        row["Festival_Flag"] = row["Seasonal_Flag"] = row["Promotion_Flag"] = flag
        if kind == ".":
            row["Festival_Flag"] = "1"  # one flag of three: neither X, Y nor R
        row["Promotion_Type"] = "10% Discount" if kind in "XY" else "No Offer"
        for col, _ in schema.MEDIA_CHANNELS:
            row[col] = "10" if on else "0"
    return daily_csv(800, mutate=design)


def test_hub_kpis_follow_the_formula_for_the_selected_range():
    upload(_designed_csv())
    body = client.get("/api/mmm/hub", params={"year": 2025}).json()
    assert body["baseline"]["per_day"] == pytest.approx(80)
    kpi = {k["key"]: k for k in body["kpis"]}
    days = body["meta"]["days"]
    assert kpi["baseline"]["value"] == pytest.approx(80 * days)
    incremental = kpi["revenue"]["value"] - 80 * days
    assert kpi["incremental"]["value"] == pytest.approx(incremental)
    assert kpi["roas"]["value"] == pytest.approx(round(incremental / kpi["spend"]["value"], 2))
    assert kpi["roas"]["display"].endswith("x")
    # Re-estimated per range: a single month has its own window.
    month = client.get("/api/mmm/hub", params={"year": 2025, "month": 6, "granularity": "day"}).json()
    assert month["baseline"]["window"]["from"] == "01-06-2025"
    assert len(month["trend"]["labels"]) == 30


def test_a_day_filter_keeps_the_period_baseline():
    upload(_designed_csv())
    whole = client.get("/api/mmm/hub", params={"year": 2025}).json()
    promo = client.get("/api/mmm/hub", params={"year": 2025, "promotion_type": "10% Discount"}).json()
    # 10% Discount days are all X or Y, so there are no R days among them.
    # The baseline still comes from the year.
    assert promo["baseline"]["per_day"] == whole["baseline"]["per_day"]
    assert promo["meta"]["days"] < whole["meta"]["days"]


def test_comparison_periods_shift_by_calendar_months():
    june = (pd.Timestamp("2025-06-01"), pd.Timestamp("2025-06-30"))
    assert scope.comparison_window("mago", *june) == (pd.Timestamp("2025-05-01"), pd.Timestamp("2025-05-31"))
    assert scope.comparison_window("yago", *june) == (pd.Timestamp("2024-06-01"), pd.Timestamp("2024-06-30"))
    year = (pd.Timestamp("2025-01-01"), pd.Timestamp("2025-12-31"))
    assert scope.comparison_window("pago", *year) == (pd.Timestamp("2024-01-01"), pd.Timestamp("2024-12-31"))
    week = (pd.Timestamp("2025-03-05"), pd.Timestamp("2025-03-11"))
    assert scope.comparison_window("pago", *week) == (pd.Timestamp("2025-02-26"), pd.Timestamp("2025-03-04"))


def test_comparisons_outside_the_data_or_over_split_ranges_are_unavailable():
    upload(_designed_csv())
    windows = client.get("/api/mmm/hub", params={"year": 2024}).json()["comparison"]["windows"]
    assert {w["key"]: w["available"] for w in windows} == {"yago": False, "pago": False, "mago": False}
    every_june = client.get("/api/mmm/hub", params={"month": 6}).json()
    assert every_june["meta"]["contiguous"] is False
    assert all("Pick one year" in w["reason"] for w in every_june["comparison"]["windows"])


def test_custom_range_channels_and_bad_filters():
    upload(_designed_csv())
    body = client.get("/api/mmm/hub", params={
        "year": 2024, "date_from": "2025-02-01", "date_to": "2025-02-14",
        "channel": ["TV_Spend", "OTT_Spend"]}).json()
    assert body["meta"]["days"] == 14
    assert body["meta"]["channels"] == 2
    assert client.get("/api/mmm/hub", params={"channel": "Radio_Spend"}).status_code == 422
    assert client.get("/api/mmm/hub", params={"event": "eclipse"}).status_code == 422
    assert client.get("/api/mmm/hub", params={"date_from": "2025-03-01",
                                              "date_to": "2025-02-01"}).status_code == 422


def test_filters_lists_every_option():
    upload(_designed_csv())
    body = client.get("/api/mmm/filters").json()
    assert body["years"] == [2024, 2025, 2026]
    assert len(body["channels"]) == 22
    assert body["promotion_types"] == ["10% Discount", "No Offer"]
    assert [e["code"] for e in body["events"]] == ["festival", "seasonal", "promotion", "none"]


def test_the_report_carries_the_filters():
    upload(_designed_csv())
    response = client.post("/api/reports", json={
        "module": "mmm-insights", "scope": {},
        "options": {"filters": {"year": 2025, "quarter": 2, "channels": ["TV_Spend"]}},
    })
    assert response.status_code == 201, response.text
    bad = client.post("/api/reports", json={
        "module": "mmm-insights", "scope": {}, "options": {"filters": {"yaer": 2025}}})
    assert bad.status_code in (400, 422)


def test_decomposition_adds_up_and_shares_the_kpi_baseline():
    upload(daily_csv(800))
    hub = client.get("/api/mmm/hub", params={"year": 2024}).json()
    d = hub["decomposition"]
    assert d["available"]
    assert abs(sum(s["value"] for s in d["slices"]) - d["total"]) < 1
    kpi = {k["key"]: k for k in hub["kpis"]}
    assert abs(d["total"] - kpi["revenue"]["value"]) < 1
    base = d["slices"][0]
    assert base["key"] == "baseline"
    if kpi["baseline"]["value"] is not None and kpi["baseline"]["value"] <= d["total"]:
        assert abs(base["value"] - kpi["baseline"]["value"]) < 1
    # Only the selected channels can carry a media slice.
    one = client.get("/api/mmm/hub", params={"year": 2024, "channel": "TV_Spend"}).json()["decomposition"]
    media = [s for s in one["slices"] if s["kind"] == "media"]
    assert all(m["label"] == schema.family_of("TV_Spend") for m in media)


def test_families_carry_revenue_and_roas_for_the_drill_down():
    upload(daily_csv(800))
    hub = client.get("/api/mmm/hub", params={"year": 2024}).json()
    fam = {f["family"]: f for f in hub["families"]}
    for f in fam.values():
        assert {"revenue", "roas", "active_days", "channels"} <= set(f)
    assert abs(sum(f["spend"] for f in fam.values()) - sum(c["spend"] for c in hub["channels"])) < 1


def test_attributed_revenue_is_a_whole_the_pie_can_divide():
    upload(daily_csv(800))
    hub = client.get("/api/mmm/hub", params={"year": 2024}).json()
    total = hub["revenue_attributed_total"]
    assert abs(sum(c["revenue_attributed"] for c in hub["channels"]) - total) < 1
    assert abs(sum(f["revenue_attributed"] for f in hub["families"]) - total) < 1
    assert abs(sum(f["revenue_attributed_share"] for f in hub["families"]) - 100) < 0.1
    # The whole is the revenue of the days with ad spend — never more.
    assert total <= next(k for k in hub["kpis"] if k["key"] == "revenue")["value"] + 1


def test_revenue_kpi_reads_attributed_revenue_under_a_channel_filter():
    upload(daily_csv(800))
    every = client.get("/api/mmm/hub", params={"year": 2024}).json()
    tv_only = client.get("/api/mmm/hub", params={"year": 2024, "channel": "TV_Spend"}).json()
    k_all = next(k for k in every["kpis"] if k["key"] == "revenue")
    k_tv = next(k for k in tv_only["kpis"] if k["key"] == "revenue")
    assert k_all["attributed"] is False and k_all["label"] == "Total Revenue"
    assert k_tv["attributed"] is True and "(attributed)" in k_tv["label"]
    # The selection's part of the all-channel attribution — never all of it.
    tv_part = next(c for c in every["channels"] if c["column"] == "TV_Spend")["revenue_attributed"]
    assert abs(k_tv["value"] - tv_part) < 1
    assert k_tv["value"] < k_all["value"]


def test_channels_carry_the_event_mix_of_their_active_days():
    upload(daily_csv(800))
    hub = client.get("/api/mmm/hub", params={"year": 2024}).json()
    for row in hub["channels"] + hub["families"]:
        assert row["active_days"] <= row["period_days"]
        # Every active day in exactly one combination.
        assert sum(e["days"] for e in row["events"]) == row["active_days"]
        if row["active_days"]:
            assert abs(sum(e["pct"] for e in row["events"]) - 100) < 0.1
        labels = [e["label"] for e in row["events"]]
        if "Ad spend only" in labels:
            assert labels[-1] == "Ad spend only"


def test_trend_buckets_carry_their_event_mix():
    upload(daily_csv(800))
    trend = client.get("/api/mmm/hub", params={"year": 2024}).json()["trend"]
    assert len(trend["events"]) == len(trend["labels"]) == len(trend["ad_days"])
    for days, ad_days, mix in zip(trend["days"], trend["ad_days"], trend["events"]):
        assert ad_days <= days
        # Every AD day in exactly one combination; days without ads are out.
        assert sum(e["days"] for e in mix) == ad_days
        if ad_days:
            assert abs(sum(e["pct"] for e in mix) - 100) < 0.1
        labels = [e["label"] for e in mix]
        if "Ad spend only" in labels:
            assert labels[-1] == "Ad spend only"
