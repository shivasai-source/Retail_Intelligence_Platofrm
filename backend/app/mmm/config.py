"""Where MMM's dataset lives.

NOT `Data/`. That folder is TPO's star schema, and an external connector can
reset or reinstall it wholesale; an MMM upload kept there could vanish with a
TPO reinstall, or be mistaken for a seventh star table. MMM's file lives in the
backend's own runtime store (`backend/.store/`, already git-ignored), beside the
SQLite database, unless `MMM_DATA_DIR` points somewhere else — the same escape
hatch `TPO_DATA_DIR` gives TPO.
"""

from __future__ import annotations

import os
from pathlib import Path

#: backend/
_BACKEND = Path(__file__).resolve().parents[2]


def data_dir() -> Path:
    """The folder holding the installed MMM dataset. Read on every call, not at
    import, so a test can point it at a temporary folder with the env var."""
    override = os.environ.get("MMM_DATA_DIR")
    return Path(override) if override else _BACKEND / ".store" / "mmm"


#: The one installed table, whatever the uploaded file was called.
DATASET_FILE = "mmm_daily.csv"
#: The uploaded file's original name, kept beside it so the UI can say
#: "Dataset loaded from MMM_Final_Daily_Dataset.csv".
SOURCE_FILE = "mmm_source.txt"

#: Generous: the reference file is ~0.6 MB for 11 years of days.
MAX_UPLOAD_BYTES = 64 * 1024 * 1024
