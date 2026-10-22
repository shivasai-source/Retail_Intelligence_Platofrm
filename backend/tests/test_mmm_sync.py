"""MMM: pulling the connected source again — the Live pill's half of the work.

What matters here:

  * an install from a source leaves a SYNCABLE record; an upload or a reset
    leaves none, because a file on a laptop cannot be re-read;
  * a sync pulls the same blob or table and brings in the days added since;
  * it re-applies the COLUMN MAPPING the install was given, so a client's own
    header keeps working on every later pull;
  * a failure — dead token, source no longer matching the contract — leaves
    the loaded data exactly as it was and says why;
  * the token never leaves the server.

The transport is stubbed; it is Azure's and Databricks' own modules that are
being stood in for, not MMM's logic.
"""

from __future__ import annotations

import csv
import io
import json
from datetime import date, timedelta

import pytest
from fastapi.testclient import TestClient

from app import azure_blob, databricks_catalog
from app.deps import current_user
from app.main import app
from app.mmm import loader, source_sync
from app.store import db

client = TestClient(app)

AZURE_BODY = {
    "account": "acct",
    "sas": "sv=2022-11-02&ss=b&sig=secret-token",
    "container": "mmm",
    "name": "exports/daily.csv",
}
DBX_BODY = {
    "workspace_url": "https://adb-1.1.azuredatabricks.net",
    "token": "dapi-secret-token",
    "catalog": "main",
    "schema_name": "gold",
    "name": "mmm_daily",
}


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


def daily(days: int, *, header: list[str] | None = None, revenue: int = 1_000_000) -> bytes:
    """`days` days from 01-01-2024, in MMM's own names unless told otherwise."""
    cols = header or ["Date", "Revenue", "TV_Spend"]
    out = io.StringIO()
    w = csv.writer(out)
    w.writerow(cols)
    for i in range(days):
        w.writerow([(date(2024, 1, 1) + timedelta(days=i)).strftime("%d-%m-%Y"),
                    revenue + i, 5000])
    return out.getvalue().encode("utf-8")


@pytest.fixture
def source(monkeypatch):
    """A stand-in source whose content the test can change between pulls."""
    state = {"content": daily(10), "pulls": 0}

    async def fetch_header(client_, account, sas, blob):
        return state["content"]

    async def fetch_all(account, sas, blobs, progress=None):
        state["pulls"] += 1
        return [(b.name.rsplit("/", 1)[-1], state["content"]) for b in blobs]

    async def columns_for(workspace, token, tables):
        header = next(csv.reader(io.StringIO(state["content"].decode())))
        return [(t, header) for t in tables]

    async def pick_warehouse(workspace, token):
        return "wh-1"

    async def export_table(workspace, token, warehouse_id, ref):
        state["pulls"] += 1
        return state["content"]

    monkeypatch.setattr(azure_blob, "fetch_header", fetch_header)
    monkeypatch.setattr(azure_blob, "fetch_all", fetch_all)
    monkeypatch.setattr(databricks_catalog, "columns_for", columns_for)
    monkeypatch.setattr(databricks_catalog, "pick_warehouse", pick_warehouse)
    monkeypatch.setattr(databricks_catalog, "export_table", export_table)
    return state


# --- what counts as a connected source ---------------------------------------


def test_nothing_loaded_means_nothing_to_sync():
    status = client.get("/api/mmm/dataset/source").json()
    assert status["syncable"] is False
    assert status["kind"] is None
    assert client.post("/api/mmm/dataset/source/sync").status_code == 400


def test_an_azure_install_leaves_a_syncable_source(source):
    assert client.post("/api/mmm/dataset/azure/install", json=AZURE_BODY).status_code == 200
    status = client.get("/api/mmm/dataset/source").json()
    assert status["syncable"] is True
    assert status["kind"] == "azure"
    assert status["label"] == "Azure Blob Storage"
    assert status["origin"] == "acct"
    assert status["items"] == ["mmm/exports/daily.csv"]
    assert status["last_sync"]["ok"] is True, "the install itself is the first sync"


def test_a_databricks_install_leaves_a_syncable_source(source):
    assert client.post("/api/mmm/dataset/databricks/install", json=DBX_BODY).status_code == 200
    status = client.get("/api/mmm/dataset/source").json()
    assert status["kind"] == "databricks"
    assert status["items"] == ["main.gold.mmm_daily"]


def test_the_token_never_leaves_the_server(source):
    client.post("/api/mmm/dataset/azure/install", json=AZURE_BODY)
    body = client.get("/api/mmm/dataset/source").text
    assert "secret-token" not in body
    client.post("/api/mmm/dataset/databricks/install", json=DBX_BODY)
    assert "dapi-secret-token" not in client.get("/api/mmm/dataset/source").text


def test_an_upload_ends_the_connection(source):
    client.post("/api/mmm/dataset/azure/install", json=AZURE_BODY)
    assert client.get("/api/mmm/dataset/source").json()["syncable"] is True

    client.post("/api/mmm/dataset", files={"file": ("f.csv", daily(5), "text/csv")})
    status = client.get("/api/mmm/dataset/source").json()
    assert status["syncable"] is False, "a file on a laptop cannot be re-read"
    assert client.post("/api/mmm/dataset/source/sync").status_code == 400


def test_a_reset_ends_the_connection(source):
    client.post("/api/mmm/dataset/azure/install", json=AZURE_BODY)
    client.delete("/api/mmm/dataset")
    assert client.get("/api/mmm/dataset/source").json()["syncable"] is False


def test_a_failed_install_leaves_no_connection(source):
    source["content"] = b"Notes,Owner\nhello,me\n"
    assert client.post("/api/mmm/dataset/azure/install", json=AZURE_BODY).status_code == 400
    assert client.get("/api/mmm/dataset/source").json()["syncable"] is False


# --- syncing ------------------------------------------------------------------


def test_a_sync_brings_in_the_days_added_since(source):
    client.post("/api/mmm/dataset/azure/install", json=AZURE_BODY)
    assert client.get("/api/mmm/dataset").json()["rows"] == 10

    source["content"] = daily(14)  # four more days at the source
    res = client.post("/api/mmm/dataset/source/sync")
    assert res.status_code == 200, res.text
    body = res.json()
    assert body["before"]["rows"] == 10
    assert body["after"]["rows"] == 14
    assert body["source"] == "Azure Blob Storage"
    assert body["last_sync"]["previous_rows"] == 10
    assert client.get("/api/mmm/dataset").json()["rows"] == 14


def test_a_databricks_sync_re_exports_the_same_table(source):
    client.post("/api/mmm/dataset/databricks/install", json=DBX_BODY)
    source["content"] = daily(20)
    body = client.post("/api/mmm/dataset/source/sync").json()
    assert body["item"] == "main.gold.mmm_daily"
    assert body["after"]["rows"] == 20
    assert source["pulls"] == 2, "installed once, synced once"


def test_a_sync_re_applies_the_saved_column_mapping(source):
    """The whole point: a client's own header keeps working on every pull."""
    client_header = ["TxnDate", "NetSales", "TV"]
    source["content"] = daily(10, header=client_header)
    renames = {"TxnDate": "Date", "NetSales": "Revenue", "TV": "TV_Spend"}
    install = client.post(
        "/api/mmm/dataset/azure/install", json={**AZURE_BODY, "mapping": renames}
    )
    assert install.status_code == 200, install.text
    assert client.get("/api/mmm/dataset/source").json()["mapped_columns"] == 3

    # The source grows, still under its own names.
    source["content"] = daily(18, header=client_header)
    res = client.post("/api/mmm/dataset/source/sync")
    assert res.status_code == 200, res.text
    assert res.json()["after"]["rows"] == 18


def test_a_dead_token_leaves_the_loaded_data_alone(source, monkeypatch):
    client.post("/api/mmm/dataset/azure/install", json=AZURE_BODY)

    async def expired(account, sas, blobs, progress=None):
        raise azure_blob.AzureError("403 — this SAS token has expired.")

    monkeypatch.setattr(azure_blob, "fetch_all", expired)
    res = client.post("/api/mmm/dataset/source/sync")
    assert res.status_code == 400
    assert "expired" in res.json()["detail"]

    assert client.get("/api/mmm/dataset").json()["rows"] == 10, "the old data is still loaded"
    last = client.get("/api/mmm/dataset/source").json()["last_sync"]
    assert last["ok"] is False and "expired" in last["error"]


def test_a_source_that_stops_matching_the_contract_is_refused(source):
    client.post("/api/mmm/dataset/azure/install", json=AZURE_BODY)
    # Someone renames the revenue column at the source.
    source["content"] = daily(12, header=["Date", "NetSales", "TV_Spend"])
    res = client.post("/api/mmm/dataset/source/sync")
    assert res.status_code == 400
    assert "Revenue" in res.json()["detail"]
    assert client.get("/api/mmm/dataset").json()["rows"] == 10


def test_the_record_survives_a_sync_and_keeps_its_item(source):
    client.post("/api/mmm/dataset/azure/install", json=AZURE_BODY)
    client.post("/api/mmm/dataset/source/sync")
    status = client.get("/api/mmm/dataset/source").json()
    assert status["items"] == ["mmm/exports/daily.csv"]
    assert status["syncing"] is False


def test_the_status_shape_matches_tpos(source):
    """MMM's pill is TPO's pill; a different shape would mean a second
    component drawing the same thing."""
    client.post("/api/mmm/dataset/azure/install", json=AZURE_BODY)
    mmm = client.get("/api/mmm/dataset/source").json()
    for key in ("kind", "syncable", "label", "origin", "items", "saved_at",
                "last_sync", "syncing"):
        assert key in mmm, key
    for key in ("at", "ok", "rows", "previous_rows", "error"):
        assert key in mmm["last_sync"], key


def test_source_sync_error_is_not_a_500(source):
    """Every message this module raises is written for the reader."""
    with pytest.raises(source_sync.MmmSourceSyncError):
        import asyncio

        asyncio.run(source_sync.sync())

# --- several periods from one source -----------------------------------------


@pytest.fixture
def periods(monkeypatch):
    """A source holding three quarters as three separate files/tables."""
    state = {
        "files": {
            "q1.csv": daily_from(date(2024, 1, 1), 91),
            "q2.csv": daily_from(date(2024, 4, 1), 91),
            "q3.csv": daily_from(date(2024, 7, 1), 92),
        },
        "pulls": 0,
    }

    def pick(name: str) -> bytes:
        return state["files"][name.rsplit("/", 1)[-1]]

    async def fetch_header(client_, account, sas, blob):
        return pick(blob.name)

    async def fetch_all(account, sas, blobs, progress=None):
        state["pulls"] += 1
        return [(b.name.rsplit("/", 1)[-1], pick(b.name)) for b in blobs]

    async def columns_for(workspace, token, tables):
        out = []
        for t in tables:
            header = next(csv.reader(io.StringIO(pick(t.csv_name).decode())))
            out.append((t, header))
        return out

    async def pick_warehouse(workspace, token):
        return "wh-1"

    async def export_table(workspace, token, warehouse_id, ref):
        state["pulls"] += 1
        return pick(ref.csv_name)

    monkeypatch.setattr(azure_blob, "fetch_header", fetch_header)
    monkeypatch.setattr(azure_blob, "fetch_all", fetch_all)
    monkeypatch.setattr(databricks_catalog, "columns_for", columns_for)
    monkeypatch.setattr(databricks_catalog, "pick_warehouse", pick_warehouse)
    monkeypatch.setattr(databricks_catalog, "export_table", export_table)
    return state


def daily_from(start: date, days: int, *, header: list[str] | None = None) -> bytes:
    cols = header or ["Date", "Revenue", "TV_Spend"]
    out = io.StringIO()
    w = csv.writer(out)
    w.writerow(cols)
    for i in range(days):
        day = start + timedelta(days=i)
        w.writerow([day.strftime("%d-%m-%Y"), 1_000_000 + i, 5000][: len(cols)])
    return out.getvalue().encode("utf-8")


AZURE_THREE = {
    **{k: v for k, v in AZURE_BODY.items() if k in ("account", "sas")},
    "blobs": [
        {"container": "mmm", "name": "exports/q1.csv"},
        {"container": "mmm", "name": "exports/q2.csv"},
        {"container": "mmm", "name": "exports/q3.csv"},
    ],
}
DBX_THREE = {
    **{k: v for k, v in DBX_BODY.items() if k in ("workspace_url", "token")},
    "tables": [
        {"catalog": "main", "schema_name": "gold", "name": "q1"},
        {"catalog": "main", "schema_name": "gold", "name": "q2"},
        {"catalog": "main", "schema_name": "gold", "name": "q3"},
    ],
}


def test_three_blobs_install_as_one_daily_table(periods):
    res = client.post("/api/mmm/dataset/azure/install", json=AZURE_THREE)
    assert res.status_code == 200, res.text
    body = res.json()
    assert body["rows"] == 274
    assert body["union"]["files"] == 3

    status = client.get("/api/mmm/dataset").json()
    assert status["rows"] == 274
    assert status["period"] == {"from": "01-01-2024", "to": "30-09-2024"}
    assert "3 files" in status["source_name"]


def test_the_whole_selection_is_remembered_for_the_pill(periods):
    client.post("/api/mmm/dataset/azure/install", json=AZURE_THREE)
    status = client.get("/api/mmm/dataset/source").json()
    assert status["items"] == [
        "mmm/exports/q1.csv",
        "mmm/exports/q2.csv",
        "mmm/exports/q3.csv",
    ]


def test_a_sync_re_pulls_every_period_and_picks_up_a_new_one(periods):
    client.post("/api/mmm/dataset/azure/install", json=AZURE_THREE)
    assert client.get("/api/mmm/dataset").json()["rows"] == 274

    # The last quarter grows at the source, as it does every morning.
    periods["files"]["q3.csv"] = daily_from(date(2024, 7, 1), 100)
    res = client.post("/api/mmm/dataset/source/sync")
    assert res.status_code == 200, res.text
    body = res.json()
    assert body["before"]["rows"] == 274
    assert body["after"]["rows"] == 282
    assert len(body["items"]) == 3


def test_three_tables_install_and_sync(periods):
    assert client.post("/api/mmm/dataset/databricks/install", json=DBX_THREE).status_code == 200
    assert client.get("/api/mmm/dataset").json()["rows"] == 274

    # Q2 is re-cut four days longer, which now runs INTO Q3. The merge counts
    # those four days once rather than installing a table MMM would refuse for
    # repeating a date, so the span is unchanged.
    periods["files"]["q2.csv"] = daily_from(date(2024, 4, 1), 95)
    body = client.post("/api/mmm/dataset/source/sync").json()
    assert body["after"]["rows"] == 274
    assert body["after"]["last_day"] == "30-09-2024"
    assert len(body["items"]) == 3


def test_coverage_from_a_source_names_the_missing_quarter(periods):
    del periods["files"]["q2.csv"]
    body = client.post("/api/mmm/dataset/azure/inspect", json={
        **{k: v for k, v in AZURE_BODY.items() if k in ("account", "sas")},
        "blobs": [
            {"container": "mmm", "name": "exports/q1.csv"},
            {"container": "mmm", "name": "exports/q3.csv"},
        ],
        "coverage": True,
    }).json()
    assert body["coverage"]["gaps"], "all of Q2 is missing from the selection"
    assert "01-04-2024" in body["coverage"]["gaps"][0]


def test_each_source_file_keeps_its_own_mapping(periods):
    periods["files"]["q2.csv"] = daily_from(
        date(2024, 4, 1), 91, header=["TxnDate", "NetSales", "TV"]
    )
    res = client.post("/api/mmm/dataset/azure/install", json={
        **AZURE_THREE,
        "mapping": {"q2.csv": {"TxnDate": "Date", "NetSales": "Revenue", "TV": "TV_Spend"}},
    })
    assert res.status_code == 200, res.text
    assert res.json()["rows"] == 274
    # And the mapping is what a later sync will use again.
    assert client.get("/api/mmm/dataset/source").json()["mapped_columns"] == 3
    periods["files"]["q2.csv"] = daily_from(
        date(2024, 4, 1), 91, header=["TxnDate", "NetSales", "TV"]
    )
    assert client.post("/api/mmm/dataset/source/sync").status_code == 200


def test_a_record_from_before_deliveries_still_syncs(source, tmp_path):
    """A connection saved when MMM took one file holds `item`, not `items`."""
    import json as _json

    client.post("/api/mmm/dataset/azure/install", json=AZURE_BODY)
    path = tmp_path / "conn.json"
    record = _json.loads(path.read_text(encoding="utf-8"))
    old = {
        "kind": record["kind"],
        "connection": record["connection"],
        "item": record["items"][0],
        "mapping": {},
        "saved_at": record["saved_at"],
        "last_sync": record["last_sync"],
    }
    path.write_text(_json.dumps(old), encoding="utf-8")

    assert client.get("/api/mmm/dataset/source").json()["items"] == ["mmm/exports/daily.csv"]
    source["content"] = daily(13)
    res = client.post("/api/mmm/dataset/source/sync")
    assert res.status_code == 200, res.text
    assert res.json()["after"]["rows"] == 13
