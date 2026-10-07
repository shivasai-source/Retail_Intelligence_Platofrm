"""Where MMM's dataset lives.

In the repository's `Data/` folder, beside TPO's star schema, in a subfolder
of its own: `Data/mmm/`. Every connector's data now lands under `Data/`, so
one folder holds everything the platform reads.

THE SUBFOLDER IS WHAT KEEPS THE TWO APART. TPO's connector owns the six star
files at the TOP of `Data/`: its reset deletes exactly those six names and its
temp files (`star_dataset.reset`), its install only ever writes them, and its
loader only ever opens them. None of that looks inside `Data/mmm/`, so a TPO
reset or reinstall cannot touch the MMM dataset, and the MMM file can never be
mistaken for a seventh star table.

`MMM_DATA_DIR` still overrides the location (the tests use it), as
`TPO_DATA_DIR` does for TPO.

Before 2026-10-06 the dataset lived in `backend/.store/mmm/`. A dataset still
there is MOVED across the first time the new folder is asked for and found
empty, so an upgrade keeps the data a user already loaded. Moved, not copied:
a copy left behind would be adopted again after every MMM reset, bringing a
deleted dataset back.
"""

from __future__ import annotations

import os
import shutil
from pathlib import Path

#: backend/
_BACKEND = Path(__file__).resolve().parents[2]
#: The repository root, which holds Data/.
_REPO_ROOT = _BACKEND.parent

#: The one installed table, whatever the uploaded file was called.
DATASET_FILE = "mmm_daily.csv"
#: The uploaded file's original name, kept beside it so the UI can say
#: "Dataset loaded from MMM_Final_Daily_Dataset.csv".
SOURCE_FILE = "mmm_source.txt"

#: Generous: the reference file is ~0.6 MB for 11 years of days.
MAX_UPLOAD_BYTES = 64 * 1024 * 1024

#: Where the dataset lived before it moved under Data/.
_LEGACY_DIR = _BACKEND / ".store" / "mmm"


def _adopt_legacy(folder: Path) -> None:
    """Move a dataset from the old location into `folder` when `folder` has
    none. A one-time step: once moved, the old location is empty."""
    if (folder / DATASET_FILE).is_file() or not (_LEGACY_DIR / DATASET_FILE).is_file():
        return
    folder.mkdir(parents=True, exist_ok=True)
    for name in (DATASET_FILE, SOURCE_FILE):
        old = _LEGACY_DIR / name
        if old.is_file():
            shutil.move(str(old), str(folder / name))


def data_dir() -> Path:
    """The folder holding the installed MMM dataset. Read on every call, not at
    import, so a test can point it at a temporary folder with the env var."""
    override = os.environ.get("MMM_DATA_DIR")
    if override:
        return Path(override)
    folder = _REPO_ROOT / "Data" / "mmm"
    _adopt_legacy(folder)
    return folder
