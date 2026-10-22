"""MMM: installing the daily table from Azure Blob Storage and Databricks.

The transport is stubbed — these tests are about MMM's half of the job, not
about Azure's or Databricks' APIs, which app/azure_blob.py and
app/databricks_catalog.py already cover. What matters here:

  * a blob and a table go through the SAME validation an upload does;
  * the dataset records WHICH source it came from, so Data Connections lights
    the right tile;
  * a file that does not match the contract is refused and the loaded dataset
    is left alone;
  * nothing written here can reach TPO's star schema.

Runs against a throwaway MMM data folder (MMM_DATA_DIR) and a throwaway Report
Center database (db.use_path), so the live MMM dataset and
backend/.store/tiq.db are never touched.
"""

from __future__ import annotations

import pytest
from fastapi.testclient import TestClient

from app import azure_blob, databricks_catalog
from app.deps import current_user
from app.main import app
from app.mmm import dataset, loader, sources
from app.store import db

from tests.test_mmm import daily_csv

client = TestClient(app)

AZURE_BODY = {
    "account": "acct",
    "sas": "sv=2022-11-02&ss=b&sig=x",
    "container": "mmm",
    "name": "exports/daily.csv",
}
DBX_BODY = {
    "workspace_url": "https://adb-1.1.azuredatabricks.net",
    "token": "dapi-test",
    "catalog": "main",
    "schema_name": "gold",
    "name": "mmm_daily",
}


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


@pytest.fixture
def azure(monkeypatch):
    """Stand in for the storage account. Returns the blobs it was asked for."""
    asked: list[str] = []

    async def fetch_header(client_, account, sas, blob):
        asked.append(f"header:{blob.container}/{blob.name}")
        return daily_csv(10)

    async def fetch_all(account, sas, blobs, progress=None):
        asked.extend(f"full:{b.container}/{b.name}" for b in blobs)
        return [(b.name.rsplit("/", 1)[-1], daily_csv(10)) for b in blobs]

    monkeypatch.setattr(azure_blob, "fetch_header", fetch_header)
    monkeypatch.setattr(azure_blob, "fetch_all", fetch_all)
    return asked


@pytest.fixture
def dbx(monkeypatch):
    """Stand in for Unity Catalog and a SQL warehouse."""
    asked: list[str] = []

    async def columns_for(workspace, token, tables):
        asked.extend(f"columns:{t.full_name}" for t in tables)
        from app.mmm import schema as mmm_schema

        return [(t, [c.name for c in mmm_schema.COLUMNS]) for t in tables]

    async def pick_warehouse(workspace, token):
        return "wh-1"

    async def export_table(workspace, token, warehouse_id, ref):
        asked.append(f"export:{ref.full_name}")
        return daily_csv(10)

    monkeypatch.setattr(databricks_catalog, "columns_for", columns_for)
    monkeypatch.setattr(databricks_catalog, "pick_warehouse", pick_warehouse)
    monkeypatch.setattr(databricks_catalog, "export_table", export_table)
    return asked


# --- the preflight ------------------------------------------------------------


def test_azure_inspect_reads_only_the_header_and_installs_nothing(azure):
    res = client.post("/api/mmm/dataset/azure/inspect", json=AZURE_BODY)
    assert res.status_code == 200
    body = res.json()
    assert body["ok"] is True
    # Delivery-shaped, as the upload's inspect is: one entry per selected
    # blob, then the verdict for the merged table.
    assert [f["filename"] for f in body["files"]] == ["daily.csv"]
    assert body["media_columns"], "the reference file's spend columns are channels"
    # Only the ranged read happened, and nothing was installed.
    assert azure == ["header:mmm/exports/daily.csv"]
    assert dataset.status()["complete"] is False


def test_databricks_inspect_costs_no_query(dbx):
    res = client.post("/api/mmm/dataset/databricks/inspect", json=DBX_BODY)
    assert res.status_code == 200
    body = res.json()
    assert body["ok"] is True
    assert [f["filename"] for f in body["files"]] == ["mmm_daily.csv"]
    # Columns only: no warehouse picked, no export run.
    assert dbx == ["columns:main.gold.mmm_daily"]
    assert dataset.status()["complete"] is False


def test_inspect_names_a_missing_required_column(monkeypatch, azure):
    async def no_revenue(client_, account, sas, blob):
        return b"Date,TV_Spend\n01-01-2024,100\n"

    monkeypatch.setattr(azure_blob, "fetch_header", no_revenue)
    body = client.post("/api/mmm/dataset/azure/inspect", json=AZURE_BODY).json()
    assert body["ok"] is False
    assert any("Revenue" in p for p in body["problems"])
    assert any("Revenue" in p for p in body["files"][0]["problems"])


# --- installing ---------------------------------------------------------------


def test_azure_install_loads_the_dataset_and_records_its_source(azure):
    res = client.post("/api/mmm/dataset/azure/install", json=AZURE_BODY)
    assert res.status_code == 200, res.text
    body = res.json()
    assert body["installed"] is True
    assert body["rows"] == 10

    status = client.get("/api/mmm/dataset").json()
    assert status["complete"] is True
    assert status["rows"] == 10
    assert status["source_kind"] == "azure-blob"
    assert status["source_name"] == "Azure Blob · mmm/exports/daily.csv"
    assert azure == ["full:mmm/exports/daily.csv"]


def test_databricks_install_exports_the_table_and_records_its_source(dbx):
    res = client.post("/api/mmm/dataset/databricks/install", json=DBX_BODY)
    assert res.status_code == 200, res.text
    assert res.json()["rows"] == 10

    status = client.get("/api/mmm/dataset").json()
    assert status["complete"] is True
    assert status["source_kind"] == "databricks"
    assert status["source_name"] == "Databricks · main.gold.mmm_daily"
    assert dbx == ["export:main.gold.mmm_daily"]


def test_an_installed_source_dataset_serves_the_hub(azure):
    client.post("/api/mmm/dataset/azure/install", json=AZURE_BODY)
    hub = client.get("/api/mmm/hub?granularity=day&currency=INR")
    assert hub.status_code == 200, hub.text


def test_a_source_install_replaces_an_uploaded_one(azure):
    up = client.post(
        "/api/mmm/dataset",
        files={"file": ("MMM_Final_Daily_Dataset.csv", daily_csv(20), "text/csv")},
    )
    assert up.status_code == 200
    assert client.get("/api/mmm/dataset").json()["source_kind"] == "excel"

    client.post("/api/mmm/dataset/azure/install", json=AZURE_BODY)
    status = client.get("/api/mmm/dataset").json()
    # One table, so the newer install simply takes over — no reset needed.
    assert status["rows"] == 10
    assert status["source_kind"] == "azure-blob"


def test_a_bad_file_is_refused_and_the_loaded_dataset_survives(monkeypatch, azure):
    client.post("/api/mmm/dataset/azure/install", json=AZURE_BODY)
    before = client.get("/api/mmm/dataset").json()

    async def rubbish(account, sas, blobs, progress=None):
        return [("notes.csv", b"Notes,Owner\nhello,me\n")]

    monkeypatch.setattr(azure_blob, "fetch_all", rubbish)
    res = client.post("/api/mmm/dataset/azure/install", json=AZURE_BODY)
    assert res.status_code == 400
    assert "Revenue" in res.json()["detail"]

    after = client.get("/api/mmm/dataset").json()
    assert after["rows"] == before["rows"]
    assert after["source_name"] == before["source_name"]


def test_an_azure_failure_is_reported_not_installed(monkeypatch, azure):
    async def boom(account, sas, blobs, progress=None):
        raise azure_blob.AzureError("403 — the SAS token cannot read this blob.")

    monkeypatch.setattr(azure_blob, "fetch_all", boom)
    res = client.post("/api/mmm/dataset/azure/install", json=AZURE_BODY)
    assert res.status_code == 400
    assert "SAS token" in res.json()["detail"]
    assert dataset.status()["complete"] is False


def test_a_warehouse_failure_is_reported_not_installed(monkeypatch, dbx):
    async def no_warehouse(workspace, token):
        raise databricks_catalog.DatabricksError("No SQL warehouse is visible to this token.")

    monkeypatch.setattr(databricks_catalog, "pick_warehouse", no_warehouse)
    res = client.post("/api/mmm/dataset/databricks/install", json=DBX_BODY)
    assert res.status_code == 400
    assert "warehouse" in res.json()["detail"]
    assert dataset.status()["complete"] is False


# --- the selection ------------------------------------------------------------


@pytest.mark.parametrize("missing", ["container", "name"])
def test_azure_needs_a_container_and_a_blob(missing, azure):
    body = {**AZURE_BODY, missing: ""}
    res = client.post("/api/mmm/dataset/azure/install", json=body)
    assert res.status_code == 400
    assert "Select the file" in res.json()["detail"]


@pytest.mark.parametrize("missing", ["catalog", "schema_name", "name"])
def test_databricks_needs_a_fully_qualified_table(missing, dbx):
    body = {**DBX_BODY, missing: ""}
    res = client.post("/api/mmm/dataset/databricks/install", json=body)
    assert res.status_code == 400
    assert "Select the table" in res.json()["detail"]


# --- what the source record means --------------------------------------------


def test_an_upload_still_records_itself_as_excel():
    client.post("/api/mmm/dataset", files={"file": ("My_Export.csv", daily_csv(5), "text/csv")})
    status = client.get("/api/mmm/dataset").json()
    assert status["source_kind"] == "excel"
    assert status["source_name"] == "My_Export.csv"


def test_a_dataset_installed_before_sources_were_recorded_reads_as_excel(tmp_path):
    """The source file used to hold only the uploaded file's name. That is an
    Excel upload by definition — it was the only way in."""
    client.post("/api/mmm/dataset", files={"file": ("Old.csv", daily_csv(5), "text/csv")})
    legacy = tmp_path / "mmm" / "mmm_source.txt"
    legacy.write_text("Old.csv", encoding="utf-8")
    status = client.get("/api/mmm/dataset").json()
    assert status["source_kind"] == "excel"
    assert status["source_name"] == "Old.csv"


def test_a_source_install_never_writes_tpos_data_folder(azure, monkeypatch):
    """MMM's installer is the only thing these routes reach."""
    from app import star_dataset

    def forbidden(*args, **kwargs):  # pragma: no cover - must never run
        raise AssertionError("an MMM install reached TPO's star-schema installer")

    monkeypatch.setattr(star_dataset, "install", forbidden)
    assert client.post("/api/mmm/dataset/azure/install", json=AZURE_BODY).status_code == 200
    assert sources.AZURE_KIND == "azure-blob"
