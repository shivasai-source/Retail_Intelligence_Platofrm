"""The installed MMM dataset as one cached DataFrame.

Parsed once and reused by the hub, the calendar and the report; `reset_cache`
is called by every install and reset so a new upload is read on the next
request, the way `star_dataset.reset_caches()` serves TPO.
"""

from __future__ import annotations

from functools import lru_cache

import pandas as pd

from app.mmm import config, schema


class MmmDatasetMissing(RuntimeError):
    """No MMM dataset is installed. The router answers 503 with
    `mmm_dataset_missing`, the flag the frontend keys its upload prompt on —
    the MMM twin of TPO's `DatasetNotLoaded`."""


@lru_cache(maxsize=1)
def get_frame() -> pd.DataFrame:
    path = config.data_dir() / config.DATASET_FILE
    if not path.exists():
        raise MmmDatasetMissing(
            "No MMM dataset is loaded. Upload the daily MMM file on MMM Data Connections."
        )
    frame = pd.read_csv(path, encoding="utf-8-sig")
    frame["Date"] = pd.to_datetime(frame["Date"], format="%d-%m-%Y")
    return frame


def media_columns(frame: pd.DataFrame) -> list[str]:
    return [c for c in frame.columns if c.lower().endswith(schema.SPEND_SUFFIX)]


def years(frame: pd.DataFrame) -> list[int]:
    return sorted(int(y) for y in frame["Date"].dt.year.unique())


def reset_cache() -> None:
    get_frame.cache_clear()
    # The derived payloads are cached per scope; drop them too.
    from app.mmm import calendar, service

    service.clear_cache()
    calendar.clear_cache()
