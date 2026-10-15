"""Session setup: run the whole suite against a PRISTINE copy of Data/.

WHY THIS EXISTS. `Data/` is not a fixture, it is the folder the application
writes to. The Excel / Shared Drives connector installs uploads straight into
it and `star_dataset.reset()` empties it, both of which are ordinary use of the
product. Any test that reads `Data/` directly therefore passes or fails
depending on what the last person did in the browser — and on 15 Oct 2026 that
is exactly what happened: a three-file client upload replaced the fact table,
deleted dim_channel, dim_promotion and dim_date, and sixteen tests broke
without a line of code changing.

So the suite does not read `Data/` at all. Before any app module is imported,
`TPO_DATA_DIR` is pointed at a throwaway directory holding the six reference
CSVs taken from **git HEAD**, which nothing at runtime can modify. Tests that
need the reference dataset read `config.DATA_DIR`, which now resolves there.

ORDERING MATTERS. `config.DATA_DIR` is computed once at import time, so the
environment variable is set at module scope below, before `from app.tpo import
config`. `config._resolve_data_dir` returns an explicit override without
checking that the files exist yet, so pointing at the directory first and
filling it afterwards is safe.

Tests that set `TPO_DATA_DIR` themselves (the connector tests, which install
into their own tmp_path) keep working: pytest's monkeypatch restores this
session value afterwards rather than the real folder.
"""

from __future__ import annotations

import os
import shutil
import subprocess
import tempfile
from pathlib import Path

import pytest

REPO = Path(__file__).resolve().parents[2]

#: The canonical six. Hardcoded rather than read from `config.DIM_FILES`
#: because the names are needed to build the folder that config will point at,
#: before config is imported.
REFERENCE_FILES: tuple[str, ...] = (
    "fact_sales_2024_2025_all_channels.csv",
    "dim_product_reordered.csv",
    "dim_geo_store_final.csv",
    "dim_channel.csv",
    "dim_promotion_final.csv",
    "dim_date2425_corrected.csv",
)


def _from_git(name: str) -> bytes | None:
    """`Data/<name>` as committed at HEAD, or None if git cannot supply it."""
    try:
        done = subprocess.run(
            ["git", "show", f"HEAD:Data/{name}"],
            cwd=REPO, capture_output=True, check=True,
        )
    except (OSError, subprocess.CalledProcessError):
        return None
    return done.stdout or None


def _materialise_reference_data() -> Path:
    """A temp folder holding the six reference CSVs from git HEAD.

    Falls back to copying the working `Data/` folder when git cannot answer —
    a shallow checkout, or a repository where Data/ is untracked. The suite
    then behaves as it did before this file existed, which is worse but not
    broken, so it degrades with a warning instead of skipping everything.
    """
    folder = Path(tempfile.mkdtemp(prefix="tpo-reference-data-"))
    missing: list[str] = []
    for name in REFERENCE_FILES:
        payload = _from_git(name)
        if payload is None:
            missing.append(name)
            continue
        (folder / name).write_bytes(payload)

    if missing:
        live = REPO / "Data"
        for name in missing:
            source = live / name
            if source.is_file():
                shutil.copy2(source, folder / name)
        print(
            f"[tests] git could not supply {len(missing)} reference file(s) "
            f"({', '.join(missing)}); copied what the working Data/ folder had."
        )
    return folder


REFERENCE_DATA = _materialise_reference_data()

# Set BEFORE app imports, so config.DATA_DIR resolves here. See the docstring.
os.environ["TPO_DATA_DIR"] = str(REFERENCE_DATA)


@pytest.fixture(scope="session")
def reference_data() -> Path:
    """The pristine reference dataset, for a test that wants the path."""
    return REFERENCE_DATA


@pytest.fixture(autouse=True)
def _keep_the_reference_dataset():
    """After any test that re-pointed the dataset, point it back.

    `star_dataset.reset_caches()` assigns `config.DATA_DIR` from the
    environment, and a connector test calls it while TPO_DATA_DIR still names
    its own tmp_path. monkeypatch then restores the variable but NOT the
    already-assigned constant, so without this the next test reads a deleted
    folder -- or worse, the 1,000-row truncated fact table the sync tests
    build, which fails much later with "nothing to simulate".

    Autouse and declared in conftest, so it tears down LAST, after each test's
    own fixtures and after monkeypatch has restored the variable.

    Guarded on having actually drifted: `reset_caches()` drops the parsed
    325k-row store, and paying that reload after all ~840 tests rather than
    the handful that move the dataset would turn a six-minute suite into an
    hour-long one.
    """
    yield
    from app import star_dataset
    from app.tpo import config

    if os.environ.get("TPO_DATA_DIR") != str(REFERENCE_DATA) or config.DATA_DIR != REFERENCE_DATA:
        os.environ["TPO_DATA_DIR"] = str(REFERENCE_DATA)
        star_dataset.reset_caches()


@pytest.fixture(scope="session", autouse=True)
def _guard_the_working_data_folder():
    """Fail loudly if the suite ever writes to the real Data/ folder.

    A test that installs a dataset is supposed to point TPO_DATA_DIR at its own
    tmp_path. One that forgets would silently overwrite the developer's working
    data — which has happened — so the state is captured before and compared
    after, and the suite reports it rather than leaving a mystery.
    """
    live = REPO / "Data"
    before = (
        sorted((p.name, p.stat().st_size) for p in live.glob("*.csv"))
        if live.is_dir() else None
    )
    yield
    if before is None or not live.is_dir():
        return
    after = sorted((p.name, p.stat().st_size) for p in live.glob("*.csv"))
    if after != before:
        pytest.fail(
            "the test suite modified the working Data/ folder.\n"
            f"  before: {before}\n  after:  {after}\n"
            "A test that installs a dataset must set TPO_DATA_DIR to its own "
            "tmp_path (see tests/conftest.py).",
            pytrace=False,
        )
