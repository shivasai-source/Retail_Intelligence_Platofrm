"""
Loose, no-database data layer for Phase 1.

Every JSON file under app/data/ is loaded once at import time and cached in
memory — there's nothing to invalidate since nothing writes to it yet. When
a real database replaces this in a later phase, only this module and the
individual router functions that call it change; the route paths and
response shapes stay the same, so the frontend never has to know the
difference.
"""
import json
from functools import lru_cache
from pathlib import Path
from typing import Literal

DATA_DIR = Path(__file__).parent / "data"
InvestigationType = Literal["diagnostic", "optimization", "launch", "strategic"]
INVESTIGATION_TYPES: tuple[InvestigationType, ...] = ("diagnostic", "optimization", "launch", "strategic")
@lru_cache(maxsize=None)
def load(name: str):
    """Load and cache app/data/{name}.json. Raises FileNotFoundError with a
    clear message if the file's missing rather than a bare KeyError later."""
    path = DATA_DIR / f"{name}.json"
    if not path.is_file():
        raise FileNotFoundError(f"No such data file: {path}")
    return json.loads(path.read_text(encoding="utf-8"))
