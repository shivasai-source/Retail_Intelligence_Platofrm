"""The Excel/CSV connector installs the six tables off the event loop and
still lands them in the data folder. Throwaway folders only."""

from __future__ import annotations

from pathlib import Path

from fastapi.testclient import TestClient

from app import source_sync
from app.deps import current_user
from app.main import app
from app.tpo import config

REPO_DATA = Path(__file__).resolve().parents[2] / "Data"


def test_excel_upload_installs_the_six_tables(tmp_path, monkeypatch):
    data = tmp_path / "Data"
    data.mkdir()
    monkeypatch.setenv("TPO_DATA_DIR", str(data))
    monkeypatch.setattr(source_sync, "CONN_PATH", tmp_path / "source-connection.json")
    app.dependency_overrides[current_user] = lambda: {"email_key": "qa", "email": "qa@example.test"}
    try:
        client = TestClient(app)
        names = [config.FACT_FILE] + [p.name for p in REPO_DATA.glob("dim_*.csv")]
        files = [("files", (n, (REPO_DATA / n).read_bytes(), "text/csv")) for n in names]
        r = client.post("/api/datasets", files=files)
        assert r.status_code == 200, r.text
        star = r.json()["star"]
        assert len(star["installed"]) == 6
        assert star["rows"] > 0
        assert Path(star["data_dir"]) == data
        assert all((data / f["filename"]).is_file() for f in star["installed"])
    finally:
        app.dependency_overrides.pop(current_user, None)
        # Leave the live store pointed back at the real Data/ folder.
        monkeypatch.delenv("TPO_DATA_DIR")
        from app import star_dataset

        star_dataset.reset_caches()
