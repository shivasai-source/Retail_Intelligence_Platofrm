"""Upload -> validate -> install, for MMM's one daily table.

THE SAME PROMISES TPO's installer makes (app/star_dataset.py), for a simpler
dataset:

  * A file is identified by its COLUMN HEADERS, never its name.
  * Every problem is collected and reported together, not one per attempt —
    "Revenue has 3 blank values (rows 14, 15, 90)" beats a 500 on row 14.
  * The install is atomic: the new file is staged beside the old one and moved
    into place only once it has been fully written, so a failed upload never
    leaves half a dataset behind.

WHAT IS DIFFERENT. TPO installs six tables as a set and refuses an upload over
a complete one until the user resets. MMM is ONE table, so an upload simply
replaces the installed one — there is no mixed state to protect against.
"""

from __future__ import annotations

import csv
import io
import os
from dataclasses import dataclass, field
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

import pandas as pd

from app.mmm import config, loader, schema


class MmmDatasetError(ValueError):
    """The upload cannot be installed. The message lists every reason."""


# --- reading ----------------------------------------------------------------


def _is_excel(filename: str) -> bool:
    return Path(filename).suffix.lower() in (".xlsx", ".xls")


def read_header(filename: str, content: bytes) -> list[str]:
    """Column names of an uploaded file, without reading its rows."""
    try:
        if _is_excel(filename):
            return [str(c).strip() for c in pd.read_excel(io.BytesIO(content), nrows=0).columns]
        text = content[: 256 * 1024].decode("utf-8-sig", errors="replace")
        return [h.strip() for h in next(csv.reader(io.StringIO(text)), [])]
    except Exception:
        return []


def _read_frame(filename: str, content: bytes) -> pd.DataFrame:
    try:
        if _is_excel(filename):
            return pd.read_excel(io.BytesIO(content), dtype=str)
        return pd.read_csv(io.BytesIO(content), dtype=str, encoding="utf-8-sig",
                           keep_default_na=False)
    except Exception as exc:
        raise MmmDatasetError(f"Couldn't read {filename}: {exc}") from exc


# --- validation -------------------------------------------------------------

#: Day-first, because the reference file and TPO's date dimension both are.
_DATE_FORMATS = ("%d-%m-%Y", "%d/%m/%Y", "%Y-%m-%d", "%d-%m-%y", "%d/%m/%y")


def _parse_dates(values: pd.Series) -> pd.Series:
    """The format that parses the most rows wins; rows it cannot read are NaT
    and reported by the caller. One format for the whole column — a file mixing
    12-03-2020 with 2020-03-12 is ambiguous, and guessing per row is how
    March becomes December."""
    text = values.astype(str).str.strip()
    best = None
    for fmt in _DATE_FORMATS:
        parsed = pd.to_datetime(text, format=fmt, errors="coerce")
        if best is None or parsed.notna().sum() > best.notna().sum():
            best = parsed
    return best


def _rows(mask: pd.Series) -> str:
    """"rows 14, 15, 90" — 1-based spreadsheet rows (header is row 1)."""
    idx = [str(i + 2) for i in mask[mask].index[:5]]
    more = int(mask.sum()) - len(idx)
    return ", ".join(idx) + (f" and {more} more" if more > 0 else "")


def _numeric(frame: pd.DataFrame, column: str, problems: list[str], *,
             blank_as_zero: bool, allow_negative: bool = False) -> pd.Series:
    raw = frame[column].astype(str).str.strip().str.replace(",", "", regex=False)
    blank = raw.isin(("", "nan", "NaN", "None"))
    values = pd.to_numeric(raw.where(~blank), errors="coerce")
    bad = values.isna() & ~blank
    if bad.any():
        problems.append(f"{column} has {int(bad.sum())} non-numeric value(s) ({_rows(bad)}).")
    if blank.any() and not blank_as_zero:
        problems.append(f"{column} has {int(blank.sum())} blank value(s) ({_rows(blank)}).")
    if not allow_negative:
        neg = values < 0
        if neg.any():
            problems.append(f"{column} has {int(neg.sum())} negative value(s) ({_rows(neg)}).")
    return values.fillna(0.0) if blank_as_zero else values


@dataclass
class Prepared:
    frame: pd.DataFrame
    match: schema.HeaderMatch
    warnings: list[str] = field(default_factory=list)


def prepare(filename: str, content: bytes) -> Prepared:
    """Parse and validate one upload into the canonical table, or raise
    `MmmDatasetError` listing every problem found."""
    if Path(filename).suffix.lower() not in (".csv", ".xlsx", ".xls"):
        raise MmmDatasetError(f"{filename} is not a .csv, .xlsx or .xls file.")

    raw = _read_frame(filename, content)
    match = schema.match_header(list(raw.columns))
    if not match.ok:
        raise MmmDatasetError(" ".join(match.problems()))

    frame = raw[list(match.rename)].rename(columns=match.rename)
    frame = frame[frame.astype(str).apply(lambda r: "".join(r).strip(), axis=1) != ""]
    frame = frame.reset_index(drop=True)
    if frame.empty:
        raise MmmDatasetError(f"{filename} has a header row but no data rows.")

    problems: list[str] = []
    warnings: list[str] = []
    out = pd.DataFrame()

    dates = _parse_dates(frame["Date"])
    if dates.isna().any():
        problems.append(
            f"Date has {int(dates.isna().sum())} value(s) that are not a date in DD-MM-YYYY "
            f"({_rows(dates.isna())})."
        )
    dupes = dates.duplicated(keep=False) & dates.notna()
    if dupes.any():
        problems.append(f"Date repeats on {int(dupes.sum())} rows ({_rows(dupes)}) — "
                        "MMM expects exactly one row per day.")
    out["Date"] = dates

    out["Revenue"] = _numeric(frame, "Revenue", problems, blank_as_zero=False)

    blank_spend = 0
    for col in match.media:
        blank_spend += int(frame[col].astype(str).str.strip().isin(("", "nan")).sum())
        out[col] = _numeric(frame, col, problems, blank_as_zero=True)
    if blank_spend:
        warnings.append(f"{blank_spend} blank spend cell(s) were read as 0.")

    present = set(match.rename.values())
    for flag in schema.FLAGS:
        if flag in present:
            values = _numeric(frame, flag, problems, blank_as_zero=True)
            bad = ~values.isin((0, 1))
            if bad.any():
                problems.append(f"{flag} must be 0 or 1 ({_rows(bad)}).")
            out[flag] = values.astype(int, errors="ignore")
    if "Discount_Percentage" in present:
        out["Discount_Percentage"] = _numeric(frame, "Discount_Percentage", problems,
                                              blank_as_zero=True)
    if "Promotion_Type" in present:
        out["Promotion_Type"] = (frame["Promotion_Type"].astype(str).str.strip()
                                 .replace({"": "No Offer", "nan": "No Offer"}))

    if problems:
        raise MmmDatasetError(" ".join(problems))

    # Calendar fields: the uploaded value when present, else derived from Date.
    # Derived either way when a file carries them blank.
    out["Month"] = out["Date"].dt.month.astype("int64")
    out["Quarter"] = "Q" + out["Date"].dt.quarter.astype(str)
    out["Week_of_Year"] = out["Date"].dt.isocalendar().week.astype("int64")
    out["Year"] = out["Date"].dt.year.astype("int64")
    for col in schema.CALENDAR:
        if col in present:
            given = frame[col].astype(str).str.strip()
            keep = ~given.isin(("", "nan"))
            if col == "Quarter":
                out.loc[keep, col] = given[keep]
            else:
                numbers = pd.to_numeric(given, errors="coerce")
                usable = keep & numbers.notna()
                out.loc[usable, col] = numbers[usable].astype("int64")
    derived = [c for c in schema.CALENDAR if c not in present]
    if derived:
        warnings.append(f"Derived from Date: {', '.join(derived)}.")

    out = out.sort_values("Date").reset_index(drop=True)
    return Prepared(frame=out, match=match, warnings=warnings)


# --- install / status / reset ------------------------------------------------


def _paths() -> tuple[Path, Path]:
    folder = config.data_dir()
    return folder / config.DATASET_FILE, folder / config.SOURCE_FILE


def install(filename: str, content: bytes) -> dict[str, Any]:
    """Validate and install one upload, replacing any installed dataset."""
    if len(content) > config.MAX_UPLOAD_BYTES:
        raise MmmDatasetError(f"{filename} is larger than the "
                              f"{config.MAX_UPLOAD_BYTES // (1024 * 1024)} MB limit.")
    prepared = prepare(Path(filename).name, content)

    target, source = _paths()
    target.parent.mkdir(parents=True, exist_ok=True)
    staged = target.with_name(f".{target.name}.incoming")
    frame = prepared.frame.copy()
    frame["Date"] = frame["Date"].dt.strftime("%d-%m-%Y")
    frame.to_csv(staged, index=False, encoding="utf-8")
    os.replace(staged, target)
    source.write_text(Path(filename).name, encoding="utf-8")
    loader.reset_cache()

    return {
        "installed": True,
        "rows": len(prepared.frame),
        "media_columns": list(prepared.match.media),
        "missing_optional": list(prepared.match.missing_optional),
        "ignored": list(prepared.match.ignored),
        "warnings": prepared.warnings,
        "status": status(),
    }


def inspect(filename: str, content: bytes) -> dict[str, Any]:
    """Header-only preflight: what MMM would read from this file. Installs
    nothing. The browser does this itself for CSVs; this exists for .xlsx,
    which it cannot open."""
    header = read_header(Path(filename).name, content)
    match = schema.match_header(header)
    return {
        "filename": Path(filename).name,
        "columns": header,
        "ok": match.ok,
        "problems": match.problems(),
        "media_columns": list(match.media),
        "missing_required": list(match.missing_required),
        "missing_optional": list(match.missing_optional),
        "ignored": list(match.ignored),
    }


def status() -> dict[str, Any]:
    """Shaped like TPO's `/api/datasets/star`, plus the counts MMM's strip,
    gate and sidebar lock read: `files`, `present`, `total`, `complete`.

    `files` are the four column GROUPS of the contract — the checklist a reader
    sees on the gate. Date & revenue and Media spend are what `complete` needs;
    the other two are optional and tick when the file carried them.
    """
    target, source = _paths()
    installed = target.exists()
    header: list[str] = []
    rows = 0
    period: dict[str, Any] = {"from": None, "to": None}
    if installed:
        try:
            frame = loader.get_frame()
            header = list(frame.columns)
            rows = len(frame)
            period = {"from": frame["Date"].min().strftime("%d-%m-%Y"),
                      "to": frame["Date"].max().strftime("%d-%m-%Y")}
        except Exception:
            installed = False

    present_cols = set(header)
    media = [c for c in header if c.lower().endswith(schema.SPEND_SUFFIX)]
    files = []
    for group, label in schema.GROUP_LABELS.items():
        cols = [c.name for c in schema.COLUMNS if c.group == group]
        if group == "media":
            ok = bool(media)
            found = len(media)
        elif group == "calendar":
            ok = installed  # always present once installed: derived from Date
            found = len(cols) if installed else 0
        else:
            found = sum(1 for c in cols if c in present_cols)
            ok = installed and found == len(cols)
        files.append({
            "key": group,
            "label": label,
            "required": group in ("core", "media"),
            "columns": cols,
            "found": found,
            "present": bool(installed and ok),
        })

    stat = target.stat() if installed else None
    return {
        "data_dir": str(config.data_dir()),
        "files": files,
        "present": sum(1 for f in files if f["present"]),
        "total": len(files),
        "complete": installed,
        "rows": rows,
        "period": period,
        "media_channels": len(media),
        "source_name": source.read_text(encoding="utf-8").strip()
        if installed and source.exists() else None,
        "size_bytes": stat.st_size if stat else 0,
        "modified_at": datetime.fromtimestamp(stat.st_mtime, timezone.utc).isoformat()
        if stat else None,
    }


def reset() -> dict[str, Any]:
    target, source = _paths()
    for path in (target, source):
        if path.exists():
            path.unlink()
    loader.reset_cache()
    return status()


def preview(limit: int = 50, offset: int = 0) -> dict[str, Any]:
    frame = loader.get_frame()
    page = frame.iloc[offset: offset + limit].copy()
    page["Date"] = page["Date"].dt.strftime("%d-%m-%Y")
    return {
        "columns": list(frame.columns),
        "rows": page.astype(object).where(page.notna(), None).values.tolist(),
        "total": len(frame),
        "offset": offset,
    }
