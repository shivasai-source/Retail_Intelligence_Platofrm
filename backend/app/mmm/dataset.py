"""Upload -> validate -> install, for MMM's one daily table.

THE SAME PROMISES TPO's installer makes (app/star_dataset.py), for a simpler
dataset:

  * A file is identified by its COLUMN HEADERS, never its name.
  * A header that is not ours can be MAPPED onto ours rather than refused —
    `colmap.propose` suggests the mapping, the reader confirms it, and the
    confirmed renames arrive here as `mapping` (see app/mmm/mapping.py).
  * Every problem is collected and reported together, not one per attempt —
    "Revenue has 3 blank values (rows 14, 15, 90)" beats a 500 on row 14.
  * The install is atomic: the new file is staged beside the old one and moved
    into place only once it has been fully written, so a failed upload never
    leaves half a dataset behind.

WHAT IS DIFFERENT. TPO installs six tables as a set and refuses an upload over
a complete one until the user resets. MMM is ONE table, so an upload simply
replaces the installed one — there is no mixed state to protect against.

SEVERAL FILES ARE ONE DELIVERY, NOT SEVERAL UPLOADS. A client's history arrives
as "Jan-Mar", "Apr-Jun", "Jul-Sep": different periods of the same table, out of
order, sometimes with a re-sent boundary day. `app/mmm/day_union.py` merges
them on the day — intersection of columns, later period wins a repeated day,
holes reported — and what comes out of it is validated by exactly the same
code one file is, so a delivery can never be judged by looser rules than a
single upload.
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

from app.mmm import config, day_union, loader, schema
from app.mmm import mapping as colmap


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
    #: What `day_union.merge` decided, when the delivery was several files.
    union: dict[str, Any] | None = None


def read_mapped(filename: str, content: bytes,
                mapping: dict[str, str] | None = None) -> tuple[pd.DataFrame, list[str]]:
    """One upload, read and renamed into MMM's names. No validation.

    `mapping` is a CONFIRMED set of renames, the file's own column name to
    MMM's (`{"NetSales": "Revenue"}`). It is applied to the header before
    anything is matched, so everything downstream — the merge, the validation,
    the installed file — sees one canonical table however the client spelled
    it.
    """
    if Path(filename).suffix.lower() not in (".csv", ".xlsx", ".xls"):
        raise MmmDatasetError(f"{filename} is not a .csv, .xlsx or .xls file.")

    raw = _read_frame(filename, content)
    warnings: list[str] = []
    if mapping:
        renamed, dropped = colmap.apply_to_header(list(raw.columns), mapping)
        if dropped:
            # Two columns cannot share a name. The MAPPED one wins, because a
            # reader chose it, and the collision is reported rather than left
            # to be discovered from a wrong number. `apply_to_header` has
            # already left the dropped names out of `renamed`, so the frame
            # loses the same columns to keep the two in step.
            raw = raw.loc[:, [c for c in raw.columns if c not in dropped]]
            warnings.append(
                "Mapped onto a column the file already had, so the original was dropped: "
                f"{', '.join(dropped)}."
            )
        raw.columns = renamed
    return raw, warnings


def prepare(filename: str, content: bytes,
            mapping: dict[str, str] | None = None) -> Prepared:
    """Parse and validate one upload into the canonical table, or raise
    `MmmDatasetError` listing every problem found."""
    raw, warnings = read_mapped(filename, content, mapping)
    return prepare_frame(raw, filename, warnings)


def prepare_files(uploads: list[tuple[str, bytes]],
                  mappings: dict[str, dict[str, str]] | None = None) -> Prepared:
    """Validate a DELIVERY — one file or several periods of one table.

    Each file is read with its OWN mapping (a client who renamed a column
    half way through the year is the ordinary case), then merged on the day by
    `app/mmm/day_union.py`, then validated by `prepare_frame` — the very code
    a single upload goes through. What the merge decided is reported in the
    warnings: days de-duplicated, days that disagreed, columns dropped for not
    being in every file.
    """
    if not uploads:
        raise MmmDatasetError("No file was uploaded.")
    chosen = mappings or {}
    if len(uploads) == 1:
        name, content = uploads[0]
        return prepare(name, content, chosen.get(Path(name).name))

    delivered: list[day_union.Delivered] = []
    for name, content in uploads:
        label = Path(name).name
        try:
            frame, _ = read_mapped(label, content, chosen.get(label))
        except MmmDatasetError as exc:
            delivered.append(day_union.Delivered(label, pd.DataFrame(), pd.Series(dtype="object"),
                                                 error=str(exc)))
            continue
        if "Date" not in frame.columns:
            delivered.append(day_union.Delivered(
                label, pd.DataFrame(), pd.Series(dtype="object"),
                error=f"{label} has no Date column — map one before loading it."))
            continue
        delivered.append(day_union.Delivered(label, frame, _parse_dates(frame["Date"])))

    unreadable = [d for d in delivered if not d.ok]
    if not any(d.ok for d in delivered):
        raise MmmDatasetError(" ".join(d.error for d in unreadable))

    merged, report = day_union.merge(delivered)
    if merged.empty:
        raise MmmDatasetError("None of these files holds a readable day.")

    warnings: list[str] = []
    for item in unreadable:
        warnings.append(f"Skipped: {item.error}")
    if report["duplicates_removed"]:
        warnings.append(
            f"{report['duplicates_removed']} day(s) appeared in more than one file and were "
            f"counted once; the later period's version was kept."
            + (f" {report['conflicts']} of them disagreed about their figures."
               if report["conflicts"] else "")
        )
    if report["dropped_columns"]:
        warnings.append(
            "Not every file had these columns, so they were left out rather than filled with "
            f"zeros: {', '.join(report['dropped_columns'])}."
        )
    warnings.append(
        f"Merged {report['files']} files into {report['rows_out']} days."
    )

    # The merge parsed Date into timestamps; prepare_frame re-reads the column
    # from text, as it does for one file, so there is one parser and not two.
    merged = merged.copy()
    merged["Date"] = merged["Date"].dt.strftime("%d-%m-%Y")
    prepared = prepare_frame(merged, f"{report['files']} files", warnings)
    prepared.union = report
    return prepared


def prepare_frame(raw: pd.DataFrame, filename: str,
                  warnings: list[str] | None = None) -> Prepared:
    """Validate one already-renamed table, or raise `MmmDatasetError` listing
    every problem found. The single-file and many-file paths both end here."""
    warnings = list(warnings or [])
    match = schema.match_header(list(raw.columns))
    if not match.ok:
        raise MmmDatasetError(" ".join(match.problems()))

    frame = raw[list(match.rename)].rename(columns=match.rename)
    frame = frame[frame.astype(str).apply(lambda r: "".join(r).strip(), axis=1) != ""]
    frame = frame.reset_index(drop=True)
    if frame.empty:
        raise MmmDatasetError(f"{filename} has a header row but no data rows.")

    problems: list[str] = []
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

    # Channel totals are not stored — every figure is computed from the
    # sub-channels — but a total that disagrees with them is worth saying.
    if match.media and not problems:
        sub_total = out[list(match.media)].sum(axis=1)
        for col in match.rollups:
            given = pd.to_numeric(frame[col], errors="coerce").fillna(0)
            if col.lower() == schema.TOTAL_SPEND.lower():
                expected, what = sub_total, "all sub-channels"
            elif col in schema.ROLLUP_FAMILY:
                family = schema.ROLLUP_FAMILY[col]
                members = [c for c in match.media if schema.family_of(c) == family]
                expected = out[members].sum(axis=1) if members else pd.Series(0.0, index=out.index)
                what = f"its {family} sub-channels"
            else:
                continue
            off = (given - expected).abs() > (expected.abs() * 0.001).clip(lower=1)
            if off.any():
                warnings.append(f"{col} differs from the sum of {what} on {int(off.sum())} day(s) "
                                f"({_rows(off)}); MMM uses the sub-channels.")

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


#: The connector ids that may install an MMM dataset, as the catalogue spells
#: them (frontend/src/components/portal/catalog.ts). Stored with the dataset so
#: Data Connections can light the tile the data actually came from.
SOURCE_KINDS = ("excel", "azure-blob", "databricks")


def install(filename: str, content: bytes, *, source_kind: str = "excel",
            source_label: str | None = None,
            mapping: dict[str, str] | None = None) -> dict[str, Any]:
    """Validate and install ONE file, replacing any installed dataset.

    `source_kind` / `source_label` say where the bytes came from — a file
    dialog, a blob or a warehouse table. The validation and the write are the
    same for all three: one file in, one canonical daily table out. Only the
    transport differs, and it lives in app/mmm/sources.py.
    """
    return install_files([(filename, content)], source_kind=source_kind,
                         source_label=source_label,
                         mappings={Path(filename).name: mapping} if mapping else None)


def install_files(uploads: list[tuple[str, bytes]], *, source_kind: str = "excel",
                  source_label: str | None = None,
                  mappings: dict[str, dict[str, str]] | None = None) -> dict[str, Any]:
    """Validate and install a DELIVERY — one file or several periods of one
    table — replacing any installed dataset.

    One file behaves exactly as it always did. Several are merged on the day
    first (see `prepare_files`), and the result is written as the single
    canonical table every MMM page reads: the module has one dataset, however
    many files it arrived in.
    """
    if not uploads:
        raise MmmDatasetError("No file was uploaded.")
    for filename, content in uploads:
        if len(content) > config.MAX_UPLOAD_BYTES:
            raise MmmDatasetError(f"{Path(filename).name} is larger than the "
                                  f"{config.MAX_UPLOAD_BYTES // (1024 * 1024)} MB limit.")
    total = sum(len(c) for _n, c in uploads)
    if total > config.MAX_UPLOAD_BYTES:
        raise MmmDatasetError(
            f"These {len(uploads)} files come to more than the "
            f"{config.MAX_UPLOAD_BYTES // (1024 * 1024)} MB limit together.")

    prepared = prepare_files(uploads, mappings)
    filename = Path(uploads[0][0]).name

    target, source = _paths()
    target.parent.mkdir(parents=True, exist_ok=True)
    staged = target.with_name(f".{target.name}.incoming")
    frame = prepared.frame.copy()
    frame["Date"] = frame["Date"].dt.strftime("%d-%m-%Y")
    frame.to_csv(staged, index=False, encoding="utf-8")
    os.replace(staged, target)
    # Two lines: the connector id, then what to call the source on screen.
    # A one-line file is a dataset installed before sources were recorded and
    # is read back as an Excel upload — see `_read_source`.
    kind = source_kind if source_kind in SOURCE_KINDS else "excel"
    # A delivery is named by what it is, not by whichever file came first.
    default = (
        filename if len(uploads) == 1
        else f"{len(uploads)} files ({', '.join(Path(n).name for n in list(zip(*uploads))[0])})"
    )
    label = (source_label or default).strip()
    if len(label) > 300:
        label = f"{len(uploads)} files"
    source.write_text("\n".join((kind, label)), encoding="utf-8")
    loader.reset_cache()

    return {
        "installed": True,
        "rows": len(prepared.frame),
        "media_columns": list(prepared.match.media),
        "missing_optional": list(prepared.match.missing_optional),
        "ignored": list(prepared.match.ignored),
        "warnings": prepared.warnings,
        "mapping": {name: dict(m) for name, m in (mappings or {}).items()},
        "files": [Path(n).name for n, _c in uploads],
        "union": prepared.union,
        "status": status(),
    }


def inspect(filename: str, content: bytes,
            mapping: dict[str, str] | None = None) -> dict[str, Any]:
    """Header-only preflight: what MMM would read from this file. Installs
    nothing. The browser does this itself for CSVs; this exists for .xlsx,
    which it cannot open."""
    return inspect_columns(Path(filename).name, read_header(Path(filename).name, content), mapping)


def inspect_columns(name: str, columns: list[str],
                    mapping: dict[str, str] | None = None) -> dict[str, Any]:
    """The same answer as `inspect`, from COLUMN NAMES alone.

    A Databricks table has no header row to read — Unity Catalog already knows
    its columns — so the preflight for one costs no query, no warehouse and no
    data. Shared with `inspect` so a file and a table can never be judged by
    different rules.

    `mapping` is tried on without installing anything, which is what makes the
    mapping screen honest: every edit the reader makes is answered by the
    rules the install will actually use, not by a second opinion.
    """
    original = [str(c).strip() for c in columns]
    header = original
    dropped: list[str] = []
    if mapping:
        header, dropped = colmap.apply_to_header(original, mapping)
    match = schema.match_header(header)
    # The proposal is made from the file's OWN names, so the screen can still
    # offer alternatives for a column the reader has already remapped.
    proposal = colmap.propose(original)
    return {
        "filename": name,
        "columns": header,
        "source_columns": original,
        "mapping": dict(mapping or {}),
        "dropped": dropped,
        "proposal": {
            "mapping": proposal.mapping,
            "sources": proposal.sources,
            "unmapped": list(proposal.unmapped),
            "spare": list(proposal.spare),
            "renames": proposal.renames,
            "is_complete": proposal.is_complete,
        },
        "ok": match.ok,
        "problems": match.problems(),
        "media_columns": list(match.media),
        "rollup_columns": list(match.rollups),
        "missing_required": list(match.missing_required),
        "missing_optional": list(match.missing_optional),
        "ignored": list(match.ignored),
    }


def inspect_files(uploads: list[tuple[str, bytes]],
                  mappings: dict[str, dict[str, str]] | None = None,
                  *, coverage: bool = False) -> dict[str, Any]:
    """What MMM would read from a whole delivery. Installs nothing.

    Per file: its columns, the mapping proposal, and whether it would match
    the contract on its own. Then, for the delivery as a whole, what the
    MERGED table would look like — because that is what actually gets
    installed, and a file that is missing Revenue is perfectly fine when
    another file in the same delivery is the one that carries the month.

    `coverage` adds the span arithmetic: which period each file covers, which
    days nobody sent, which files repeat days. It reads every row, so the
    caller asks for it once per selection rather than on every edit.
    """
    chosen = mappings or {}
    files: list[dict[str, Any]] = []
    delivered: list[day_union.Delivered] = []

    for name, content in uploads:
        label = Path(name).name
        answer = inspect(label, content, chosen.get(label))
        files.append(answer)
        if not coverage:
            continue
        try:
            frame, _warnings = read_mapped(label, content, chosen.get(label))
        except MmmDatasetError as exc:
            delivered.append(day_union.Delivered(label, pd.DataFrame(),
                                                 pd.Series(dtype="object"), error=str(exc)))
            continue
        if "Date" not in frame.columns:
            delivered.append(day_union.Delivered(
                label, pd.DataFrame(), pd.Series(dtype="object"),
                error=f"{label} has no Date column — map one before loading it."))
            continue
        delivered.append(day_union.Delivered(label, frame, _parse_dates(frame["Date"])))

    out = verdict_for(files)
    if coverage:
        plan = day_union.coverage(delivered)
        out["coverage"] = plan.as_dict()
        # A column only SOME files have is dropped by the merge, so the
        # delivery's verdict is re-asked over what would actually survive.
        shared = [c for c in out["columns"] if c not in plan.dropped_columns]
        surviving = schema.match_header(shared)
        out.update(_verdict(surviving))
        out["ok"] = surviving.ok and any(d.ok for d in delivered)
    return out


def verdict_for(files: list[dict[str, Any]]) -> dict[str, Any]:
    """One answer for a whole delivery, from each file's own inspection.

    THE DELIVERY IS WHAT GETS INSTALLED, so it is the delivery that has to be
    judged. A file holding only the first quarter's spend is missing nothing —
    another file carries Revenue for those months — and a per-file verdict
    mistaken for the delivery's would refuse a perfectly good set of extracts.
    The union of what the files map to is matched against the contract once,
    which is the same question `install_files` will ask.
    """
    columns: list[str] = []
    for answer in files:
        for column in answer["columns"]:
            if column not in columns:
                columns.append(column)
    together = schema.match_header(columns)
    return {
        "files": files,
        "columns": columns,
        **_verdict(together),
    }


def _verdict(match: schema.HeaderMatch) -> dict[str, Any]:
    """One header match, as every inspect reports it — so the delivery's
    answer and a single file's answer are the same shape and the upload screen
    can draw its checklist from either."""
    return {
        "ok": match.ok,
        "problems": match.problems(),
        "media_columns": list(match.media),
        "rollup_columns": list(match.rollups),
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
    media = loader.media_columns(pd.DataFrame(columns=header))
    files = []
    for group, label in schema.GROUP_LABELS.items():
        if group == "rollup":
            continue  # never stored, so nothing to report as loaded
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
        "source_kind": _read_source(source)[0] if installed else None,
        "source_name": _read_source(source)[1] if installed else None,
        "size_bytes": stat.st_size if stat else 0,
        "modified_at": datetime.fromtimestamp(stat.st_mtime, timezone.utc).isoformat()
        if stat else None,
    }


def _read_source(path: Path) -> tuple[str | None, str | None]:
    """(connector id, display name) for the installed dataset.

    Written by `install` as two lines. A single-line file predates that and
    holds only the uploaded file's name, which is an Excel upload by
    definition — the only source there was.
    """
    if not path.exists():
        return None, None
    lines = [ln.strip() for ln in path.read_text(encoding="utf-8").splitlines() if ln.strip()]
    if not lines:
        return None, None
    if len(lines) >= 2 and lines[0] in SOURCE_KINDS:
        return lines[0], lines[1]
    return "excel", lines[0]


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
