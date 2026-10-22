"""MMM: mapping a client's own column names onto MMM's contract.

The point of the mapping screen is that a file holding exactly the right data
under different names is MAPPED rather than refused. These tests pin both
halves: what the proposal suggests (and, as importantly, what it refuses to
guess), and that a confirmed mapping installs a working dataset.

Runs against a throwaway MMM data folder and Report Center database, so the
live MMM dataset is never touched.
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
from app.mmm import loader, mapping, schema
from app.store import db

client = TestClient(app)


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


def client_csv(days: int = 30) -> bytes:
    """A real-looking client extract: not one column is spelled MMM's way."""
    out = io.StringIO()
    w = csv.writer(out)
    w.writerow(["TxnDate", "NetSales", "TV", "Facebook Ads", "Radio_Cost",
                "Holiday_Flag", "Promo Flag", "Region"])
    for i in range(days):
        day = date(2024, 1, 1) + timedelta(days=i)
        w.writerow([day.strftime("%d-%m-%Y"), 1_000_000 + i * 10, 5000, 2500, 1200,
                    1 if i % 7 == 0 else 0, 1 if i % 3 == 0 else 0, "North"])
    return out.getvalue().encode("utf-8")


def upload(content: bytes, mapping_json: dict[str, str] | None = None, name: str = "client.csv"):
    data = {"mapping": json.dumps(mapping_json)} if mapping_json is not None else {}
    return client.post("/api/mmm/dataset", files={"file": (name, content, "text/csv")}, data=data)


# --- what the proposal suggests ----------------------------------------------


def test_a_client_header_is_proposed_not_refused():
    p = mapping.propose(["TxnDate", "NetSales", "TV", "Facebook Ads", "Region"])
    assert p.mapping["Date"] == "TxnDate"
    assert p.mapping["Revenue"] == "NetSales"
    assert p.mapping["TV_Spend"] == "TV"
    assert p.mapping["Meta_Ads_Spend"] == "Facebook Ads"
    assert p.is_complete
    assert p.spare == ("Region",)


def test_our_own_names_need_no_mapping():
    p = mapping.propose(["Date", "Revenue", "TV_Spend"])
    assert p.sources == {"Date": "exact", "Revenue": "exact", "TV_Spend": "exact"}
    assert p.renames == {}, "nothing to rename when the file already uses our names"
    assert p.is_complete


def test_the_schemas_own_aliases_are_still_honoured():
    p = mapping.propose(["Date", "Revenue", "TV_Spend", "Holiday_Flag", "Trending_Flag"])
    assert p.mapping["Festival_Flag"] == "Holiday_Flag"
    assert p.mapping["Seasonal_Flag"] == "Trending_Flag"


def test_a_spend_column_under_another_word_reaches_its_channel():
    p = mapping.propose(["Date", "Revenue", "TV Cost", "Meta Ads Investment", "YouTube Budget"])
    assert p.mapping["TV_Spend"] == "TV Cost"
    assert p.mapping["Meta_Ads_Spend"] == "Meta Ads Investment"
    assert p.mapping["YouTube_Ads_Spend"] == "YouTube Budget"


def test_an_unlisted_channel_becomes_a_channel_of_its_own():
    p = mapping.propose(["Date", "Revenue", "Radio_Cost"])
    assert p.mapping["Radio_Spend"] == "Radio_Cost"
    assert p.sources["Radio_Spend"] == "new"
    assert p.is_complete, "one spend column is enough, even an unlisted one"


def test_a_misspelling_is_offered_as_a_guess():
    p = mapping.propose(["Date", "Revenue", "TV_Spend", "Discount_Percentge"])
    assert p.mapping.get("Discount_Percentage") == "Discount_Percentge"
    assert p.sources["Discount_Percentage"] == "typo"


@pytest.mark.parametrize("ambiguous", ["Print", "OOH", "Social", "Digital", "Media", "Video"])
def test_a_family_name_is_never_guessed_at(ambiguous):
    """Spend attributed to the wrong channel moves its whole response curve,
    so a name that names a FAMILY is left for the reader."""
    p = mapping.propose(["Date", "Revenue", "TV_Spend", ambiguous])
    assert ambiguous in p.spare
    assert ambiguous not in p.mapping.values()


def test_a_channel_total_is_never_proposed_as_a_channel():
    p = mapping.propose(["Date", "Revenue", "TV_Spend", "Total_Spend",
                         "Channel_Print_Spend"])
    assert p.mapping["Total_Spend"] == "Total_Spend"
    assert p.sources["Total_Spend"] == "exact"
    # Neither total may stand in for a media channel.
    assert all(not v.startswith("Total") for k, v in p.mapping.items() if k.endswith("_Spend")
               and k not in ("Total_Spend",) and not schema.is_rollup(k))


def test_what_is_still_missing_is_named():
    p = mapping.propose(["Region", "Notes", "TxnDate"])
    assert "Revenue" in p.unmapped
    assert "a media spend column" in p.unmapped
    assert not p.is_complete


# --- the preflight -----------------------------------------------------------


def test_inspect_returns_a_proposal_for_an_unmapped_file():
    """The answer is shaped as a DELIVERY — one entry per file, then the
    verdict for the merged table — as TPO's /star/inspect is."""
    res = client.post(
        "/api/mmm/dataset/inspect",
        files={"file": ("client.csv", client_csv(), "text/csv")},
    )
    assert res.status_code == 200
    body = res.json()
    assert body["ok"] is False, "the raw header is not MMM's, so it does not match as it stands"
    only = body["files"][0]
    assert only["filename"] == "client.csv"
    assert only["proposal"]["mapping"]["Revenue"] == "NetSales"
    assert only["proposal"]["is_complete"] is True, "but a complete mapping is available"


def test_inspect_with_the_mapping_applied_says_it_would_work():
    proposal = client.post(
        "/api/mmm/dataset/inspect",
        files={"file": ("client.csv", client_csv(), "text/csv")},
    ).json()["files"][0]["proposal"]
    res = client.post(
        "/api/mmm/dataset/inspect",
        files={"file": ("client.csv", client_csv(), "text/csv")},
        data={"mapping": json.dumps(proposal["renames"])},
    )
    body = res.json()
    assert body["ok"] is True
    assert "Revenue" in body["columns"] and "TxnDate" not in body["columns"]
    assert body["files"][0]["ok"] is True


def test_a_malformed_mapping_is_refused_rather_than_ignored():
    res = client.post(
        "/api/mmm/dataset/inspect",
        files={"file": ("client.csv", client_csv(), "text/csv")},
        data={"mapping": "{not json"},
    )
    assert res.status_code == 400
    assert "mapping" in res.json()["detail"]


# --- installing with a mapping -----------------------------------------------


def test_the_same_file_is_refused_unmapped_and_installs_mapped():
    refused = upload(client_csv())
    assert refused.status_code == 400
    assert "Revenue" in refused.json()["detail"]

    renames = mapping.propose(["TxnDate", "NetSales", "TV", "Facebook Ads", "Radio_Cost",
                               "Holiday_Flag", "Promo Flag", "Region"]).renames
    ok = upload(client_csv(), renames)
    assert ok.status_code == 200, ok.text
    body = ok.json()
    assert body["rows"] == 30
    # Keyed by filename, as TPO's upload reports it: a delivery can be
    # several files, each with its own names.
    assert body["mapping"] == {"client.csv": renames}
    assert body["files"] == ["client.csv"]
    assert set(body["media_columns"]) == {"TV_Spend", "Meta_Ads_Spend", "Radio_Spend"}

    status = client.get("/api/mmm/dataset").json()
    assert status["complete"] is True
    assert status["media_channels"] == 3


def test_a_mapped_dataset_serves_the_hub():
    renames = mapping.propose(["TxnDate", "NetSales", "TV", "Facebook Ads", "Radio_Cost",
                               "Holiday_Flag", "Promo Flag", "Region"]).renames
    assert upload(client_csv(), renames).status_code == 200
    hub = client.get("/api/mmm/hub?granularity=day&currency=INR")
    assert hub.status_code == 200, hub.text
    assert hub.json()["meta"]["days"] == 30


def test_mapping_onto_a_column_the_file_already_has_drops_the_original():
    """A file carrying both `Revenue` (junk) and `NetSales` (the real figure),
    with NetSales mapped onto Revenue. Two columns cannot share a name."""
    out = io.StringIO()
    w = csv.writer(out)
    w.writerow(["Date", "Revenue", "NetSales", "TV_Spend"])
    for i in range(10):
        w.writerow([(date(2024, 1, 1) + timedelta(days=i)).strftime("%d-%m-%Y"), 0, 500_000 + i, 1000])
    res = upload(out.getvalue().encode("utf-8"), {"NetSales": "Revenue"})
    assert res.status_code == 200, res.text
    assert any("dropped" in w for w in res.json()["warnings"])

    rows = client.get("/api/mmm/dataset/preview?limit=1").json()["rows"]
    revenue = rows[0][client.get("/api/mmm/dataset/preview?limit=1").json()["columns"].index("Revenue")]
    assert float(revenue) == 500_000, "the mapped column won, not the junk one"


def test_an_unmapped_column_is_still_simply_ignored():
    renames = {"TxnDate": "Date", "NetSales": "Revenue", "TV": "TV_Spend"}
    res = upload(client_csv(), renames)
    assert res.status_code == 200, res.text
    # Region was never mapped and is not read; the file installs anyway.
    assert "Region" in res.json()["ignored"]
