"""
Dataset ingestion + profiling.

This is what makes the investigation agents possible: a real uploaded file
lands on disk, pandas parses it, and we cache a *profile* — schema, null
counts, numeric distributions, top categorical values, and a handful of
sample rows.

The profile exists because of one hard constraint: raw rows must never be
sent to an LLM. A promotion dataset is easily hundreds of thousands of
rows; it would blow the context window, cost a fortune, and produce worse
analysis than well-chosen aggregates. So Python does the counting and the
model reasons over the summary. Agents read profiles, never CSVs.

Storage follows the same JSON-file convention as the rest of Phase 1
(see data_loader.py's docstring) — uploads live under app/data/uploads/,
which is gitignored since it's user data, not seed data.
"""
import json
import math
import shutil
import threading
import time
import uuid
from pathlib import Path
from typing import Any

import pandas as pd

from app.data_loader import DATA_DIR

UPLOAD_DIR = DATA_DIR / "uploads"
INDEX_PATH = UPLOAD_DIR / "index.json"

SAMPLE_ROWS = 5
TOP_CATEGORICAL_VALUES = 10
# Anything above this is treated as free text / an identifier rather than a
# category worth enumerating — listing 50k distinct SKU ids helps nobody.
MAX_CATEGORICAL_CARDINALITY = 50

_lock = threading.Lock()


class DatasetError(ValueError):
    """Raised with a user-facing message when a file can't be ingested."""


def _jsonable(value: Any) -> Any:
    """numpy/pandas scalars and NaN/NaT don't survive json.dumps — normalize
    them to plain Python, with non-finite floats becoming None."""
    if value is None or value is pd.NaT:
        return None
    if isinstance(value, float) and not math.isfinite(value):
        return None
    if hasattr(value, "item"):  # numpy scalar
        try:
            value = value.item()
        except (ValueError, AttributeError):
            return str(value)
    if isinstance(value, float) and not math.isfinite(value):
        return None
    if isinstance(value, (str, int, bool)) or value is None:
        return value
    if isinstance(value, float):
        return round(value, 2)
    if pd.isna(value):
        return None
    return str(value)


def _coerce_dates(df: pd.DataFrame) -> pd.DataFrame:
    """Promote date-like text columns to real datetimes.

    Without this a `week` column of ISO strings profiles as just another
    low-cardinality category, and an agent reading that has no way to know
    it's the time axis — which is exactly the column most promotion
    questions ("did performance decay over the promo period?") hinge on.
    Only converts when nearly every non-null value parses, so genuine
    categories are left alone.
    """
    for name in df.columns:
        series = df[name]
        if not (series.dtype == object or isinstance(series.dtype, pd.StringDtype)):
            continue
        non_null = series.dropna()
        if non_null.empty:
            continue
        try:
            parsed = pd.to_datetime(non_null, errors="coerce", format="mixed")
        except (ValueError, TypeError):
            continue
        if parsed.notna().mean() >= 0.9:
            df[name] = pd.to_datetime(series, errors="coerce", format="mixed")
    return df


def _read_frame(path: Path) -> pd.DataFrame:
    suffix = path.suffix.lower()
    try:
        if suffix == ".csv":
            return _coerce_dates(pd.read_csv(path))
        if suffix in (".xlsx", ".xls"):
            return _coerce_dates(pd.read_excel(path))
    except DatasetError:
        raise
    except Exception as e:  # pandas raises a wide variety of parse errors
        raise DatasetError(f"Couldn't parse {path.name}: {e}") from e
    raise DatasetError(f"Unsupported file type '{suffix}' — upload .csv, .xlsx or .xls.")


def _profile_column(series: pd.Series) -> dict[str, Any]:
    """One column's shape, in the form an agent can reason about."""
    non_null = series.dropna()
    col: dict[str, Any] = {
        "name": str(series.name),
        "dtype": str(series.dtype),
        "null_count": int(series.isna().sum()),
        "unique_count": int(non_null.nunique()),
    }

    if pd.api.types.is_numeric_dtype(series) and not pd.api.types.is_bool_dtype(series):
        col["kind"] = "numeric"
        if len(non_null):
            col.update(
                min=_jsonable(non_null.min()),
                max=_jsonable(non_null.max()),
                mean=_jsonable(non_null.mean()),
                median=_jsonable(non_null.median()),
                std=_jsonable(non_null.std()),
                p25=_jsonable(non_null.quantile(0.25)),
                p75=_jsonable(non_null.quantile(0.75)),
            )
    elif pd.api.types.is_datetime64_any_dtype(series):
        col["kind"] = "datetime"
        if len(non_null):
            col.update(min=_jsonable(non_null.min()), max=_jsonable(non_null.max()))
    else:
        # Low-cardinality strings are categories worth enumerating; high-cardinality
        # ones are identifiers or free text, where the top-values list is noise.
        if col["unique_count"] <= MAX_CATEGORICAL_CARDINALITY:
            col["kind"] = "categorical"
            counts = non_null.value_counts().head(TOP_CATEGORICAL_VALUES)
            col["top_values"] = [{"value": _jsonable(v), "count": int(c)} for v, c in counts.items()]
        else:
            col["kind"] = "text"

    return col


def profile_frame(df: pd.DataFrame) -> dict[str, Any]:
    return {
        "rows": int(len(df)),
        "column_count": int(len(df.columns)),
        "columns": [_profile_column(df[c]) for c in df.columns],
        "sample_rows": [
            {str(k): _jsonable(v) for k, v in row.items()} for row in df.head(SAMPLE_ROWS).to_dict("records")
        ],
    }


def _read_index() -> dict[str, Any]:
    if not INDEX_PATH.is_file():
        return {}
    return json.loads(INDEX_PATH.read_text(encoding="utf-8"))


def _write_index(index: dict[str, Any]) -> None:
    UPLOAD_DIR.mkdir(parents=True, exist_ok=True)
    INDEX_PATH.write_text(json.dumps(index, indent=2), encoding="utf-8")


def save_dataset(filename: str, content: bytes, owner: str) -> dict[str, Any]:
    """Persist one uploaded file and its profile. Returns the metadata record
    (without the profile — call get_dataset for that)."""
    dataset_id = uuid.uuid4().hex[:12]
    folder = UPLOAD_DIR / dataset_id
    folder.mkdir(parents=True, exist_ok=True)

    safe_name = Path(filename).name  # strip any path components from the client
    file_path = folder / safe_name
    file_path.write_bytes(content)

    try:
        df = _read_frame(file_path)
        profile = profile_frame(df)
    except Exception:
        shutil.rmtree(folder, ignore_errors=True)  # don't leave an unparseable orphan
        raise

    (folder / "profile.json").write_text(json.dumps(profile, indent=2), encoding="utf-8")

    record = {
        "id": dataset_id,
        "filename": safe_name,
        "owner": owner,
        "size_bytes": len(content),
        "rows": profile["rows"],
        "column_count": profile["column_count"],
        "uploaded_at": int(time.time() * 1000),
    }
    with _lock:
        index = _read_index()
        index[dataset_id] = record
        _write_index(index)
    return record


def list_datasets(owner: str | None = None) -> list[dict[str, Any]]:
    with _lock:
        records = list(_read_index().values())
    if owner is not None:
        records = [r for r in records if r.get("owner") == owner]
    return sorted(records, key=lambda r: r["uploaded_at"], reverse=True)


def get_dataset(dataset_id: str) -> dict[str, Any] | None:
    """Metadata + full profile, or None if unknown."""
    with _lock:
        record = _read_index().get(dataset_id)
    if not record:
        return None
    profile_path = UPLOAD_DIR / dataset_id / "profile.json"
    if not profile_path.is_file():
        return None
    return {**record, "profile": json.loads(profile_path.read_text(encoding="utf-8"))}


def delete_dataset(dataset_id: str) -> bool:
    with _lock:
        index = _read_index()
        if dataset_id not in index:
            return False
        del index[dataset_id]
        _write_index(index)
    shutil.rmtree(UPLOAD_DIR / dataset_id, ignore_errors=True)
    return True


def load_frame(dataset_id: str) -> pd.DataFrame | None:
    """Re-read the original file. For computing targeted aggregates on demand
    (what the specialist agents ask for) rather than re-profiling."""
    folder = UPLOAD_DIR / dataset_id
    if not folder.is_dir():
        return None
    for path in folder.iterdir():
        if path.suffix.lower() in (".csv", ".xlsx", ".xls"):
            return _read_frame(path)
    return None
