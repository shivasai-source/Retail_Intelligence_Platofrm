"""
Installing a new star-schema dataset into the Data/ folder — the Excel
connector's real job.

WHAT THIS IS FOR. `app/tpo/config.py` resolves ONE directory (`Data/` at the
repo root, unless $TPO_DATA_DIR overrides it) and every dashboard, KPI,
optimization and report in the platform reads the six CSVs sitting in it.
Uploading through the Excel connector used to drop files into a random
`app/data/uploads/<id>/` folder that only the investigation agents ever looked
at, so a user who uploaded a fresh fact table saw the old numbers everywhere.
This module closes that gap: the six recognised files are written straight
into the folder the loader reads, replacing whatever was there.

MATCHING A FILE TO ITS ROLE — BY COLUMN HEADERS, AND ONLY BY HEADERS. Not by
filename and not by upload order. A user exporting from Excel produces
`Book1.xlsx`, `export (3).csv` or `Sales Q1 FINAL v2.csv`; none of those names
say which table the file is, and a file dialog hands the six over in whatever
order the OS chose. The column names DO say, unambiguously — only the fact
carries Base_Quantity, only dim_product carries Product_Name — and they are
also what the loader indexes by, so a file recognised here is a file that will
actually load. Whatever the upload was called, it is written under the
canonical filename the loader opens.

Identification and completeness are two separate steps. A few discriminating
columns decide WHICH table a file is meant to be (ROLE_DISCRIMINATORS); the
full column list then decides whether it can actually be loaded (ROLE_COLUMNS).
Collapsing them would turn "your product file is missing the Cost column" into
"no product dimension uploaded" — a message about the wrong problem.

ALL SIX, OR NOTHING. A star schema is only consistent as a set — a new fact
table joined against last week's dim_product is a different dataset with
silently wrong joins. An install therefore requires the complete set of six and
refuses a partial upload, and there is no backup: the only two valid states are
"all six of one dataset" and "empty, waiting for an upload". A failed install
clears the folder, which puts the app back at its upload prompt rather than
booting on a half-replaced schema.

STAGE, THEN SWAP. Every CSV is written to a temp file beside its destination
first, and only then os.replace()d into place, so a crash mid-write can never
leave the loader reading half a fact table.
"""

from __future__ import annotations

import csv
import io
import os
import threading
import time
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from app.tpo import config

#: role -> the filename the loader opens. Straight from config, so the two can
#: never disagree about what the loader is going to read.
ROLE_FILES: dict[str, str] = {"fact": config.FACT_FILE, **config.DIM_FILES}

#: role -> a human name for the table, for messages the user reads.
ROLE_LABELS: dict[str, str] = {
    "fact": "Sales fact table",
    "product": "Product dimension",
    "geo_store": "Store / geography dimension",
    "channel": "Channel dimension",
    "promotion": "Promotion dimension",
    "date": "Date dimension",
}

#: role -> EVERY column `app/tpo/loader.py` reads out of that table.
#:
#: THE HEADER IS THE IDENTITY. Filenames are not consulted at all: a user
#: exporting from Excel produces `Book1.xlsx`, `export (3).csv` or
#: `Sales Q1 FINAL v2.csv`, and none of that says which table it is. The column
#: names do, unambiguously, and they are also what the loader will actually
#: index by — so matching on them means a file is only accepted when it can be
#: read, rather than being accepted on its name and failing later.
#:
#: These lists are exhaustive rather than a minimal fingerprint on purpose. A
#: file missing `Cost` IS NOT a usable product dimension, so recognising it as
#: one and letting the loader fail on a KeyError would report the wrong problem;
#: `missing_columns` names the absent column instead.
ROLE_COLUMNS: dict[str, tuple[str, ...]] = {
    "fact": (
        "Date", "Week", "Month", "Product_id", "Store_Id", "Channel_Id", "Promotion_Id",
        "Base_Quantity", "Actual_Quantity", "Actual_Price", "Base_Revenue", "Actual_Revenue",
        "Total_Cost", "Promotion_Cost",
    ),
    "product": ("Product_id", "Product_Name", "Brand", "Category", "Size", "Cost"),
    "geo_store": ("Store_Id", "Channel_Id", "Retailer", "Region", "State", "City", "Tier"),
    "channel": ("Channel_Id", "Channel_Name", "Channel_Type"),
    "promotion": ("Promotion_Id", "Promotion_Name", "Promotion_Type", "Promotion_Description"),
    "date": ("Date", "Year", "Month", "Week"),
}

#: role -> the columns that tell this table apart from the other five, checked
#: in this order. Identification and completeness are deliberately SEPARATE
#: steps: a file is first recognised as "meant to be the product dimension" by
#: these few columns, and only then checked against the full ROLE_COLUMNS list.
#: One step would make a product file missing `Cost` simply unrecognised —
#: reported as "no product dimension uploaded" when the truth is "your product
#: file is missing the Cost column", which is the difference between a message
#: the user can act on and one they cannot.
#:
#: Order matters where signatures overlap. The fact table carries Product_id,
#: Store_Id and Promotion_Id, so it is tested first on its measure columns,
#: which no dimension has; dim_geo_store carries Channel_Id, so it is tested
#: before dim_channel.
ROLE_DISCRIMINATORS: tuple[tuple[str, tuple[str, ...]], ...] = (
    ("fact", ("Base_Quantity", "Actual_Revenue")),
    ("geo_store", ("Store_Id", "Retailer")),
    ("product", ("Product_id", "Product_Name")),
    ("promotion", ("Promotion_Id", "Promotion_Name")),
    ("channel", ("Channel_Id", "Channel_Name")),
    ("date", ("Date", "Year", "Week")),
)

_install_lock = threading.Lock()


class StarDatasetError(ValueError):
    """Raised with a user-facing message when files cannot be installed."""


@dataclass(frozen=True)
class Classified:
    """One uploaded file, matched to the star role it will be written as."""

    role: str
    target_name: str
    original_name: str
    content: bytes
    #: How the role was decided — surfaced to the user so a wrong guess is
    #: visible rather than mysterious. Always "column headers" now.
    matched_by: str
    #: Columns `ROLE_COLUMNS[role]` requires that this file does not have.
    #: Empty for a usable file. Non-empty means the table was recognised but
    #: cannot be loaded, which is a different message from "not uploaded".
    missing_columns: tuple[str, ...] = ()

    @property
    def is_usable(self) -> bool:
        return not self.missing_columns


def data_dir() -> Path:
    """The folder the loader reads. Resolved fresh rather than read from
    `config.DATA_DIR`, because that constant was computed at import time — when
    the folder may not yet have held a fact table."""
    return Path(config._resolve_data_dir())


def _read_header(content: bytes) -> list[str]:
    """Column names of a CSV payload, or [] if it cannot be read.

    utf-8-sig for the same reason the loader uses it: dim_promotion carries a
    BOM, which would otherwise corrupt its first header name.
    """
    try:
        text = content[: 64 * 1024].decode("utf-8-sig", errors="replace")
        reader = csv.reader(io.StringIO(text))
        return [h.strip() for h in next(reader, [])]
    except Exception:
        return []


def _excel_header(content: bytes) -> list[str]:
    try:
        import pandas as pd

        frame = pd.read_excel(io.BytesIO(content), nrows=0)
        return [str(c).strip() for c in frame.columns]
    except Exception:
        return []


def read_header(filename: str, content: bytes) -> list[str]:
    """Column names of an uploaded file, whatever its extension."""
    if Path(filename).suffix.lower() in (".xlsx", ".xls"):
        return _excel_header(content)
    return _read_header(content)


def match_columns(header: list[str]) -> tuple[str, tuple[str, ...]] | None:
    """Match a column list to a star role, or None if it matches none.

    THE identification rule, factored out so every source shares one copy. A
    CSV upload reaches it via `classify`, which parses a header row first; a
    Databricks table reaches it with the column list Unity Catalog already
    supplies, no file and no download involved. Both must agree on what a table
    IS, so neither gets its own version of this loop.

    Returns (role, missing_columns) — missing being empty for a usable table.
    """
    # Case-insensitive so `PRODUCT_ID` and `Product_id` both match — Excel
    # round-trips and hand-maintained exports rarely preserve exact casing.
    present = {h.strip().lower() for h in header if h and h.strip()}
    if not present:
        return None

    for role, discriminators in ROLE_DISCRIMINATORS:
        if all(col.lower() in present for col in discriminators):
            missing = tuple(col for col in ROLE_COLUMNS[role] if col.lower() not in present)
            return role, missing

    return None


def classify(filename: str, content: bytes) -> Classified | None:
    """Identify one uploaded file BY ITS COLUMN HEADERS alone.

    The filename is never consulted — only its extension, to pick a reader.
    Returns None when the header matches none of the six discriminators, which
    is not an error: the caller keeps such a file as an ordinary profiled
    dataset for the investigation agents.

    A file that IS recognised but lacks columns the loader needs comes back
    with `missing_columns` populated, so the caller can say which column is
    absent instead of reporting the whole table as missing.
    """
    safe = Path(filename).name
    if Path(safe).suffix.lower() not in (".csv", ".xlsx", ".xls"):
        return None

    header = read_header(safe, content)
    if not header:
        return None

    matched = match_columns(header)
    if matched is None:
        return None
    role, missing = matched
    return Classified(
        role=role,
        target_name=ROLE_FILES[role],
        original_name=safe,
        content=content,
        matched_by="column headers",
        missing_columns=missing,
    )


def inspect_columns(sources: list[tuple[str, list[str]]]) -> dict[str, Any]:
    """Pre-flight check for sources whose columns are known WITHOUT reading data.

    The Databricks equivalent of `inspect`: Unity Catalog hands over a table's
    column list as metadata, so a whole selection can be checked with no query,
    no warehouse and no bytes transferred. Returns the same shape `inspect`
    does, so the frontend renders either identically.

    `sources` is (display_name, column_names) per selected table.
    """
    matched = [(name, match_columns(cols)) for name, cols in sources]

    recognised: list[Classified] = []
    for name, hit in matched:
        if hit is None:
            continue
        role, missing = hit
        recognised.append(
            Classified(
                role=role,
                target_name=ROLE_FILES[role],
                original_name=name,
                content=b"",  # nothing is read at this stage
                matched_by="column names",
                missing_columns=missing,
            )
        )
    unrecognised = [name for name, hit in matched if hit is None]

    try:
        validate(recognised, unrecognised)
        message = ""
    except StarDatasetError as e:
        message = str(e)

    by_role: dict[str, list[Classified]] = {}
    for item in recognised:
        by_role.setdefault(item.role, []).append(item)
    satisfied = {r for r, f in by_role.items() if len(f) == 1 and f[0].is_usable}

    return {
        "files": [
            {
                "filename": name,
                "role": hit[0] if hit else None,
                "label": ROLE_LABELS[hit[0]] if hit else None,
                "missing_columns": list(hit[1]) if hit else [],
                "recognised": hit is not None,
            }
            for name, hit in matched
        ],
        "missing_roles": [
            {"role": role, "label": ROLE_LABELS[role], "required_columns": list(ROLE_COLUMNS[role])}
            for role in ROLE_COLUMNS
            if role not in satisfied
        ],
        "ready": not message,
        "message": message,
        "locked": is_locked(),
    }


def _to_csv_bytes(item: Classified) -> bytes:
    """The bytes to write. Excel uploads are converted to CSV, because the
    loader opens these six paths with `csv.DictReader` and nothing else."""
    if Path(item.original_name).suffix.lower() not in (".xlsx", ".xls"):
        return item.content
    try:
        import pandas as pd

        frame = pd.read_excel(io.BytesIO(item.content))
    except Exception as e:
        raise StarDatasetError(f"Couldn't read {item.original_name} as Excel: {e}") from e
    buffer = io.StringIO()
    frame.to_csv(buffer, index=False)
    return buffer.getvalue().encode("utf-8")


def _discard(folder: Path, names: list[str]) -> None:
    """Remove a half-applied install.

    There is no backup to restore from: an install must supply the COMPLETE
    set of six, so the previous contents are never a valid fallback — half the
    old schema joined against half the new one is exactly the silently-wrong
    dataset this module exists to prevent. A failed install therefore leaves
    the folder empty and the app back at its upload prompt, which is a state
    the user can see and fix.
    """
    for name in names:
        (folder / name).unlink(missing_ok=True)


#: How hard to try a rename before giving up, and the initial backoff.
#: Windows denies a rename while ANY process holds a handle to either path,
#: including one opened a millisecond ago by a virus scanner, the search
#: indexer, OneDrive, or Excel with the file still open. Those handles are
#: transient — the operation that fails now typically succeeds ~100 ms later —
#: so a bare os.replace turns a routine upload into "[WinError 5] Access is
#: denied". POSIX has no such behaviour and loses nothing by the retry.
_RENAME_ATTEMPTS = 12
_RENAME_BACKOFF = 0.05


def _stage(path: Path, payload: bytes) -> Path:
    """Write the new bytes beside their destination, without touching it yet.

    Returns the staged path. Kept out of `_commit` so that a whole set can be
    written to disk before any live file is disturbed — see `install`.
    """
    temp = path.with_name(f".{path.name}.incoming")
    temp.write_bytes(payload)
    return temp


def _replace_with_retry(src: Path, dst: Path) -> None:
    """os.replace, retried against transient Windows sharing violations.

    Raises the last error if the handle never clears, so a genuinely locked
    file (Excel open on the CSV, say) still fails loudly rather than silently
    skipping the write.
    """
    delay = _RENAME_BACKOFF
    for attempt in range(_RENAME_ATTEMPTS):
        try:
            os.replace(src, dst)
            return
        except PermissionError:
            if attempt == _RENAME_ATTEMPTS - 1:
                raise StarDatasetError(
                    f"Windows would not let {dst.name} be replaced — another program is holding "
                    f"it open. Close it in Excel (or any other app reading the Data folder) and "
                    f"upload again."
                ) from None
            time.sleep(delay)
            delay = min(delay * 2, 1.0)
        except OSError:
            raise


def reset_caches() -> None:
    """Drop every cache derived from the CSVs on disk.

    This is what actually makes an upload visible. `loader.get_store()` is
    `@lru_cache(maxsize=1)` and holds the parsed 205,920-row fact table for the
    process lifetime; without clearing it, new files sit on disk and every
    endpoint keeps answering from the old dataset. Everything downstream of the
    store — the filter row caches, the calendar aggregates, the Promotion
    Intelligence sections, and the content fingerprint that stamps stored
    records — is derived from it and has to go at the same time, or the app
    serves a mix of two datasets.

    Ordered store-last so nothing can repopulate a downstream cache from the
    old store while we are still clearing.
    """
    from app.intelligence_engine import _SECTION_CACHE
    from app.store import fingerprint
    from app.tpo import filters, promo_calendar, service
    from app.tpo.loader import get_store

    _SECTION_CACHE.clear()
    for cached in (
        filters.rows_for,
        filters.baseline_rows_for,
        filters._present_values,
        promo_calendar._aggregate,
        promo_calendar.available_years,
        fingerprint._compute,
        # The Command Center's memoised engine passes (app/tpo/service.py).
        service._bundle,
        service.promotion_events,
        service._period_totals,
        service._cannibalization_detail,
        service._breakdown_groups,
    ):
        cached.cache_clear()
    get_store.cache_clear()

    # config.DATA_DIR was resolved at import time. If Data/ was empty then, it
    # points at the fallback path; re-resolve so the loader reads the folder we
    # just wrote into.
    config.DATA_DIR = data_dir()


def validate(items: list[Classified], unrecognised: list[str] | None = None) -> None:
    """Check an upload is a complete, loadable star schema. Raises otherwise.

    Runs BEFORE anything touches disk, and its whole job is the error message:
    the user needs to know *which table* is absent and, if a file was
    recognised but unusable, *which column* it lacks. "Upload failed" would be
    true and useless.

    Four distinct problems, reported separately because the fix differs:
      * a table nobody uploaded             -> upload that file
      * a table uploaded twice              -> remove one of them
      * a table uploaded but missing columns -> fix the export
      * a file that is none of the six      -> remove it

    `unrecognised` carries the filenames whose headers matched no table. Exactly
    six files, one per table, may be uploaded: an extra file is a mistake the
    user should see now — silently profiling it elsewhere hid a
    wrong-file-picked slip behind a success message.
    """
    by_role: dict[str, list[Classified]] = {}
    for item in items:
        by_role.setdefault(item.role, []).append(item)

    problems: list[str] = []

    for name in unrecognised or []:
        problems.append(
            f"'{name}': its columns match none of the 6 tables — remove it, "
            f"only the 6 standard tables can be uploaded."
        )

    duplicates = {role: found for role, found in by_role.items() if len(found) > 1}
    for role, found in duplicates.items():
        names = ", ".join(f"'{f.original_name}'" for f in found)
        problems.append(
            f"{ROLE_LABELS[role]}: {len(found)} files have these columns ({names}) — keep one."
        )

    incomplete = [
        found[0] for role, found in by_role.items() if role not in duplicates and not found[0].is_usable
    ]
    for item in incomplete:
        problems.append(
            f"{ROLE_LABELS[item.role]}: '{item.original_name}' is missing "
            f"{'column' if len(item.missing_columns) == 1 else 'columns'} "
            f"{', '.join(item.missing_columns)}."
        )

    # A role is only satisfied by exactly one file that carries every column.
    satisfied = {
        role for role, found in by_role.items() if len(found) == 1 and found[0].is_usable
    }
    absent = [role for role in ROLE_COLUMNS if role not in satisfied]
    unusable_roles = {i.role for i in incomplete} | set(duplicates)
    never_uploaded = [role for role in absent if role not in unusable_roles]

    if never_uploaded:
        problems.append(
            "Not uploaded: "
            + "; ".join(
                f"{ROLE_LABELS[role]} (needs {', '.join(ROLE_COLUMNS[role])})"
                for role in never_uploaded
            )
            + "."
        )

    if problems:
        # The trailing instruction only fits when something is actually absent.
        # With all six present and an extra file alongside them, "upload the
        # missing file(s)" told the user to do the opposite of what was needed.
        remedy = (
            " Please upload the missing file(s) to continue the pipeline."
            if len(satisfied) < len(ROLE_COLUMNS)
            else " Remove the extra file(s) to continue the pipeline."
        )
        raise StarDatasetError(
            f"{len(satisfied)} of 6 tables ready. " + " ".join(problems) + remedy
        )


def install(items: list[Classified], unrecognised: list[str] | None = None) -> dict[str, Any]:
    """Write a COMPLETE star schema into the data folder and reload from it.

    All six tables are required in one upload. A star schema is only meaningful
    as a set — a new fact table joined against the previous dim_product is a
    different dataset whose joins are quietly wrong — so a partial upload is
    refused outright rather than half-applied. That is also why there is no
    backup to roll back to: the only two valid states are "all six of one
    dataset" and "empty, waiting for an upload".
    """
    if is_locked():
        raise StarDatasetError(
            "A complete dataset is already loaded. Use Reset to clear all 6 files "
            "before uploading a new set — see the connector's Reset button."
        )

    validate(items, unrecognised)  # raises with a message naming exactly what is absent

    folder = data_dir()
    folder.mkdir(parents=True, exist_ok=True)

    payloads = [(item, _to_csv_bytes(item)) for item in items]
    names = [item.target_name for item in items]
    replaced = [item.target_name for item in items if (folder / item.target_name).is_file()]

    with _install_lock:
        # STAGE EVERYTHING FIRST, then swap. Writing and swapping one file at a
        # time meant a failure on file 4 of 6 left three tables already replaced
        # and a mismatched star schema on disk until rollback undid it. Staging
        # separates the slow, failure-prone part (writing 21 MB, and any
        # scanner that wakes up for it) from the swap, which is then a short
        # burst of renames with nothing else happening in between.
        staged: list[tuple[Path, Path]] = []
        try:
            for item, payload in payloads:
                target = folder / item.target_name
                staged.append((_stage(target, payload), target))
        except Exception as e:
            for temp, _ in staged:
                temp.unlink(missing_ok=True)
            raise StarDatasetError(f"Couldn't write the new files into {folder}: {e}") from e

        try:
            for temp, target in staged:
                _replace_with_retry(temp, target)
            reset_caches()
            from app.tpo.loader import get_store

            rows = get_store().row_count
        except Exception as e:
            # Clear the folder rather than restoring: the old files are not a
            # valid fallback (see `_discard`), and leaving a partial set behind
            # would let the app boot on a mismatched schema. Empty puts the user
            # back at the upload prompt, which is honest and recoverable.
            _discard(folder, names)
            for temp, _ in staged:
                temp.unlink(missing_ok=True)  # anything not yet swapped in
            reset_caches()
            raise StarDatasetError(
                f"The uploaded files couldn't be loaded as a star schema, so nothing was "
                f"kept — please upload all six files again: {e}"
            ) from e

    return {
        "installed": [
            {
                "role": item.role,
                "filename": item.target_name,
                "original_name": item.original_name,
                "matched_by": item.matched_by,
                "size_bytes": len(payload),
            }
            for item, payload in payloads
        ],
        "replaced": replaced,
        "rows": rows,
        "data_dir": str(folder),
    }


def current_status() -> dict[str, Any]:
    """Which of the six files the data folder currently holds. Lets the
    frontend show what is connected without parsing anything."""
    folder = data_dir()
    files = []
    for role, name in ROLE_FILES.items():
        path = folder / name
        present = path.is_file()
        stat = path.stat() if present else None
        files.append(
            {
                "role": role,
                "label": ROLE_LABELS[role],
                "filename": name,
                "required_columns": list(ROLE_COLUMNS[role]),
                "present": present,
                "size_bytes": stat.st_size if stat else 0,
                "modified_at": int(stat.st_mtime * 1000) if stat else None,
            }
        )
    complete = all(f["present"] for f in files)
    return {
        "data_dir": str(folder),
        "files": files,
        "complete": complete,
        # Complete means uploading is closed until a reset — the frontend uses
        # this to swap the dropzone for the View/Reset actions.
        "locked": complete,
    }


def reset() -> dict[str, Any]:
    """Delete all six star files, putting the connector back at its upload prompt.

    The counterpart to `install`'s all-or-nothing rule: since the only two valid
    states are "all six of one dataset" and "empty", clearing is what makes a
    SECOND upload possible at all. Uploading over a complete set is refused (see
    `is_locked`) because a fresh fact table silently joined against the previous
    dimensions is the mismatched-schema bug this module exists to prevent — so
    the user resets first, which is an explicit, visible discard rather than an
    accidental half-replacement.

    Caches are dropped afterwards for the same reason `install` drops them: the
    parsed store is held for the process lifetime, so without clearing it every
    endpoint would keep answering from a dataset whose files no longer exist.
    """
    folder = data_dir()
    removed: list[str] = []
    with _install_lock:
        for name in ROLE_FILES.values():
            path = folder / name
            if path.is_file():
                try:
                    path.unlink()
                except OSError as e:
                    raise StarDatasetError(
                        f"Couldn't delete {name} — another program is holding it open. "
                        f"Close it in Excel (or any other app reading the Data folder) "
                        f"and try again. Detail: {e}"
                    ) from e
                removed.append(name)
        # Sweep any `.name.incoming` left behind by an install that died between
        # staging and swapping; they are invisible to current_status() but would
        # otherwise sit in the folder forever.
        for temp in folder.glob(".*.incoming"):
            temp.unlink(missing_ok=True)
        reset_caches()
    return {"removed": removed, "data_dir": str(folder)}


def is_locked() -> bool:
    """True when a complete set is installed and further uploads are refused.

    Uploading is a replace-the-world operation, so it is allowed only from the
    empty state. With all six present the user's choices are to view them or to
    reset — see `reset` for why replacing in place is not one of them.
    """
    folder = data_dir()
    return all((folder / name).is_file() for name in ROLE_FILES.values())


#: Rows returned by `preview` in one page. Enough to see the shape of a table
#: without ever holding the 205,920-row fact table in memory as JSON.
PREVIEW_LIMIT = 100


def preview(role: str, limit: int = PREVIEW_LIMIT, offset: int = 0) -> dict[str, Any]:
    """Read a window of rows out of one installed table, for the View button.

    Streams and skips rather than loading the file: the fact table is ~21 MB, so
    materialising it to serve 100 rows would cost far more memory than the
    request is worth. `row_count` is counted the same way, in a second cheap
    pass, so the viewer can page without guessing at the end.
    """
    if role not in ROLE_FILES:
        raise StarDatasetError(f"Unknown table '{role}'.")
    path = data_dir() / ROLE_FILES[role]
    if not path.is_file():
        raise StarDatasetError(f"{ROLE_LABELS[role]} is not uploaded yet.")

    limit = max(1, min(limit, PREVIEW_LIMIT))
    offset = max(0, offset)

    rows: list[dict[str, str]] = []
    try:
        with path.open("r", encoding="utf-8-sig", newline="") as handle:
            reader = csv.DictReader(handle)
            columns = list(reader.fieldnames or [])
            total = 0
            for index, row in enumerate(reader):
                total += 1
                if offset <= index < offset + limit:
                    rows.append({k: ("" if v is None else str(v)) for k, v in row.items()})
    except OSError as e:
        raise StarDatasetError(f"Couldn't read {path.name}: {e}") from e

    stat = path.stat()
    return {
        "role": role,
        "label": ROLE_LABELS[role],
        "filename": path.name,
        "columns": columns,
        "rows": rows,
        "row_count": total,
        "offset": offset,
        "limit": limit,
        "size_bytes": stat.st_size,
        "modified_at": int(stat.st_mtime * 1000),
    }


def inspect(uploads: list[tuple[str, bytes]]) -> dict[str, Any]:
    """Classify a set of files WITHOUT installing them.

    Lets the upload screen tell the user which table each file was recognised
    as, and what is still missing, before committing to a 21 MB round trip that
    can only be refused. Identical rules to `install`, so the preview and the
    real thing can never disagree.
    """
    classified = [(name, classify(name, content)) for name, content in uploads]
    recognised = [c for _, c in classified if c is not None]
    unrecognised = [name for name, c in classified if c is None]

    try:
        validate(recognised, unrecognised)
        message = ""
    except StarDatasetError as e:
        message = str(e)

    by_role: dict[str, list[Classified]] = {}
    for item in recognised:
        by_role.setdefault(item.role, []).append(item)
    satisfied = {r for r, f in by_role.items() if len(f) == 1 and f[0].is_usable}

    return {
        "files": [
            {
                "filename": name,
                "role": c.role if c else None,
                "label": ROLE_LABELS[c.role] if c else None,
                "missing_columns": list(c.missing_columns) if c else [],
                "recognised": c is not None,
            }
            for name, c in classified
        ],
        "missing_roles": [
            {"role": role, "label": ROLE_LABELS[role], "required_columns": list(ROLE_COLUMNS[role])}
            for role in ROLE_COLUMNS
            if role not in satisfied
        ],
        "ready": not message,
        "message": message,
        "locked": is_locked(),
    }
