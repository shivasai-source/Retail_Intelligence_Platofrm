"""Syncing a connected source: the Live pill's "pull the latest data" path.

Runs the real routes against a throwaway data folder and a fake Azure account
whose blobs the test rewrites between calls — the scenario the feature exists
for: 1,000 fact rows installed, more rows appended at the source, one click
brings them in. The six tables are the repository's own (read from git), so
the store is built by the real loader, not a stub.

Nothing here touches the live Data/ folder or the real saved connection:
TPO_DATA_DIR and source_sync.CONN_PATH both point into tmp_path, and the store
is rebuilt from the live folder again on the way out.
"""

from __future__ import annotations

import subprocess
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from app import azure_blob, source_sync, star_dataset
from app.deps import current_user
from app.main import app
from app.tpo import config

REPO = Path(__file__).resolve().parents[2]
FILES = [config.FACT_FILE, *config.DIM_FILES.values()] if isinstance(config.DIM_FILES, dict) else [
    config.FACT_FILE, *config.DIM_FILES]


def _from_git(name: str) -> bytes:
    try:
        return subprocess.run(
            ["git", "show", f"HEAD:Data/{name}"], cwd=REPO, capture_output=True, check=True
        ).stdout
    except (OSError, subprocess.CalledProcessError):
        pytest.skip(f"Data/{name} is not available from git")


def _head(csv: bytes, rows: int) -> bytes:
    lines = csv.splitlines(keepends=True)
    return b"".join(lines[: rows + 1])


@pytest.fixture(scope="module")
def tables() -> dict[str, bytes]:
    return {name: _from_git(name) for name in FILES}


@pytest.fixture()
def env(tmp_path, monkeypatch, tables):
    data = tmp_path / "data"
    data.mkdir()
    monkeypatch.setenv("TPO_DATA_DIR", str(data))
    monkeypatch.setattr(source_sync, "CONN_PATH", tmp_path / "source-connection.json")

    # The fake account: container "sales", one blob per table. Tests edit it.
    remote = {name: content for name, content in tables.items()}
    remote[config.FACT_FILE] = _head(tables[config.FACT_FILE], 1000)

    async def fake_fetch_all(account, sas, refs):
        assert (account, sas) == ("acct", "sv=secret-sas")
        return [(r.name, remote[r.name]) for r in refs]

    monkeypatch.setattr(azure_blob, "fetch_all", fake_fetch_all)
    app.dependency_overrides[current_user] = lambda: {"email_key": "qa", "email": "qa@example.test"}
    star_dataset.reset_caches()
    yield {"data": data, "remote": remote, "client": TestClient(app)}
    app.dependency_overrides.pop(current_user, None)
    monkeypatch.delenv("TPO_DATA_DIR")
    star_dataset.reset_caches()  # point the store back at the live folder


def _install(client):
    body = {"account": "acct", "sas": "sv=secret-sas",
            "blobs": [{"container": "sales", "name": n} for n in FILES]}
    r = client.post("/api/datasets/azure/install", json=body)
    assert r.status_code == 200, r.text
    return r.json()


def test_sync_pulls_rows_added_at_the_source(env, tables):
    client, remote = env["client"], env["remote"]
    installed = _install(client)
    assert installed["rows"] == 1000

    status = client.get("/api/datasets/source").json()
    assert status["syncable"] and status["kind"] == "azure"
    assert status["items"][0].startswith("sales/")
    assert "secret-sas" not in str(status)  # the token never leaves the server

    full = len(tables[config.FACT_FILE].splitlines()) - 1
    remote[config.FACT_FILE] = tables[config.FACT_FILE]  # rows appended at the source
    r = client.post("/api/datasets/source/sync")
    assert r.status_code == 200, r.text
    body = r.json()
    assert (body["previous_rows"], body["rows"]) == (1000, full)
    assert body["source"] == "Azure Blob Storage"

    # Every endpoint now answers from the synced data.
    assert client.get("/api/datasets/source").json()["last_sync"]["rows"] == full
    assert not list(env["data"].glob(".*.previous"))


def test_failed_sync_keeps_the_previous_data(env):
    client, remote = env["client"], env["remote"]
    _install(client)
    before = {p.name: p.read_bytes() for p in env["data"].glob("*.csv")}

    # A broken export at the source: the fact table loses its header row.
    remote[config.FACT_FILE] = b"not,a,star,table\n1,2,3,4\n"
    r = client.post("/api/datasets/source/sync")
    assert r.status_code == 400

    after = {p.name: p.read_bytes() for p in env["data"].glob("*.csv")}
    assert after == before
    status = client.get("/api/datasets/source").json()
    assert status["last_sync"]["ok"] is False and status["last_sync"]["error"]
    assert star_dataset.current_status()["complete"]


# How the six files are spread over containers is whatever the user picked:
# all in one, 1 + 2 + 3, one per container, ... Nothing assumes a count.
SPREADS = {
    "one container": [6],
    "two containers": [2, 4],
    "1 + 2 + 3": [1, 2, 3],
    "one per container": [1, 1, 1, 1, 1, 1],
}


@pytest.mark.parametrize("sizes", SPREADS.values(), ids=SPREADS.keys())
def test_sync_reads_each_file_from_the_container_it_was_picked_in(env, monkeypatch, tables, sizes):
    """Each sync fetches every file by its saved name from the container it was
    picked in — however many containers that is — and nowhere else."""
    split, start = {}, 0
    for i, size in enumerate(sizes):
        split[f"container-{i + 1}"] = FILES[start:start + size]
        start += size
    remote = {(c, n): tables[n] for c, names in split.items() for n in names}
    fact_home = next(c for c, names in split.items() if config.FACT_FILE in names)
    remote[(fact_home, config.FACT_FILE)] = _head(tables[config.FACT_FILE], 1000)
    # Same names in a container that was never picked: must never be read.
    remote.update({("not-picked", n): b"never,read\n" for n in FILES})
    fetched: list[tuple[str, str]] = []

    async def fake_fetch_all(account, sas, refs):
        fetched.extend((r.container, r.name) for r in refs)
        return [(r.name, remote[(r.container, r.name)]) for r in refs]

    monkeypatch.setattr(azure_blob, "fetch_all", fake_fetch_all)
    client = env["client"]
    picked = [{"container": c, "name": n} for c, names in split.items() for n in names]
    r = client.post("/api/datasets/azure/install", json={"account": "acct", "sas": "sv=secret-sas", "blobs": picked})
    assert r.status_code == 200 and r.json()["rows"] == 1000, r.text

    remote[(fact_home, config.FACT_FILE)] = tables[config.FACT_FILE]  # rows added at the source
    fetched.clear()
    body = client.post("/api/datasets/source/sync").json()
    assert body["rows"] == len(tables[config.FACT_FILE].splitlines()) - 1
    assert sorted(fetched) == sorted((p["container"], p["name"]) for p in picked)


def test_reset_forgets_the_source(env):
    client = env["client"]
    _install(client)
    assert client.delete("/api/datasets/star").status_code == 200
    assert client.get("/api/datasets/source").json()["syncable"] is False
    r = client.post("/api/datasets/source/sync")
    assert r.status_code == 400 and "no connected source" in r.json()["detail"]
