"""Several periods of daily history, delivered as several files, made into one
daily table.

WHY THIS EXISTS. A client's media and sales history does not arrive as one
file. It arrives as "Jan-Mar", "Apr-Jun", "Jul-Sep" — often out of order,
usually with a month nobody cut an extract for, and frequently with a boundary
day re-sent in two files because the second export was re-run. MMM's installer
refused all of that: it takes one file, and a second file was a second upload
that replaced the first. That is the right answer for two copies of the same
table and the wrong one for three years of history.

THE SAME THREE DECISIONS TPO's `app/fact_union.py` STATES, over MMM's grain.
Combining files is not concatenation, and every shortcut is a silent wrong
number later:

  * SCHEMA. If one file lacks `TikTok_Ads_Spend`, filling blanks makes that
    period look as though TikTok was off, and the channel's whole response
    curve — and so every Budget Optimizer recommendation — moves. The
    INTERSECTION is taken instead and the dropped column is REPORTED, because
    a channel missing everywhere is visible in a way a zero in one quarter is
    not.

  * OVERLAP. Two files both holding 25-03-2024 would be two rows for one day,
    which MMM refuses outright ("Date repeats"). Rows are therefore keyed on
    THE DAY and counted once. Where two copies of a day disagree, the one from
    the later period wins and the disagreement is counted separately from the
    harmless exact re-sends, because a conflict is a data problem the reader
    should know they have.

  * COVERAGE. A month nobody sent is NOT zero spend, it is an absent month.
    MMM derives its calendar from Date itself, so a missing October simply
    ceases to exist and nothing downstream would flag it — while the baseline
    is estimated over whatever days are present. `coverage` finds those holes
    so the upload screen can say so BEFORE the install.

WHY THIS IS PANDAS WHERE TPO's IS A CSV STREAM. TPO merges a 21 MB fact table
and streams it in two passes, holding only grain keys. MMM's grain is ONE ROW
PER DAY: eleven years of the reference dataset is 4,291 rows and 0.6 MB, and a
delivery of monthly extracts is smaller still. Streaming machinery to save
memory nobody needs would be the only hard part of this file, and MMM already
reads every upload into a frame to validate it. The DECISIONS above are what
had to be the same, not the plumbing.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from datetime import date, timedelta
from typing import Any

import pandas as pd

from app.mmm import schema

#: What makes one MMM row unique. A second row with the same day is the same
#: observation arriving twice, whatever its spend says.
GRAIN = "Date"

#: Runs of absent days are phrased, not listed, beyond this many.
_MAX_GAPS = 6


@dataclass(frozen=True)
class FileSpan:
    """What one delivered file turned out to hold."""

    filename: str
    rows: int
    first: str = ""
    last: str = ""
    #: The days this file carries, for the gap arithmetic.
    days: frozenset[date] = field(default_factory=frozenset)
    #: Columns the merged table will have that this file lacks.
    missing_columns: tuple[str, ...] = ()
    #: The file could not be read, or carries no readable Date.
    unreadable: bool = False
    error: str = ""


@dataclass(frozen=True)
class Coverage:
    """The whole delivery, as the upload screen reports it."""

    files: tuple[FileSpan, ...] = ()
    first: str = ""
    last: str = ""
    days: int = 0
    rows_delivered: int = 0
    #: Runs of absent days, each as a phrase ("12-03-2024 to 18-03-2024").
    gaps: tuple[str, ...] = ()
    #: Files that hold the SAME DAYS, phrased for the reader.
    overlaps: tuple[str, ...] = ()
    #: Days that appear in more than one file, and how many of those disagree
    #: about their figures. A restated extract is the second kind.
    duplicate_rows: int = 0
    conflicting_rows: int = 0
    #: Columns dropped because not every file had them.
    dropped_columns: tuple[str, ...] = ()
    #: Files that could not be read at all.
    unreadable: tuple[str, ...] = ()

    @property
    def has_warnings(self) -> bool:
        return bool(self.gaps or self.overlaps or self.dropped_columns or self.unreadable)

    def as_dict(self) -> dict[str, Any]:
        return {
            "files": [
                {
                    "filename": f.filename,
                    "rows": f.rows,
                    "first": f.first,
                    "last": f.last,
                    "days": len(f.days),
                    "missing_columns": list(f.missing_columns),
                    "unreadable": f.unreadable,
                    "error": f.error,
                }
                for f in self.files
            ],
            "first": self.first,
            "last": self.last,
            "days": self.days,
            "rows_delivered": self.rows_delivered,
            "gaps": list(self.gaps),
            "overlaps": list(self.overlaps),
            "duplicate_rows": self.duplicate_rows,
            "conflicting_rows": self.conflicting_rows,
            "dropped_columns": list(self.dropped_columns),
            "unreadable": list(self.unreadable),
            "has_warnings": self.has_warnings,
        }


def _phrase(run: list[date]) -> str:
    if len(run) == 1:
        return run[0].strftime("%d-%m-%Y")
    return f"{run[0].strftime('%d-%m-%Y')} to {run[-1].strftime('%d-%m-%Y')} ({len(run)} days)"


def describe_gaps(days: set[date]) -> tuple[str, ...]:
    """Runs of absent days between the first and last day present.

    Only the holes INSIDE the delivered span are reported. A dataset that
    starts in March says nothing about January, and announcing January as
    missing would be inventing a requirement the reader never stated.
    """
    if not days:
        return ()
    first, last = min(days), max(days)
    runs: list[str] = []
    run: list[date] = []
    day = first
    while day <= last:
        if day in days:
            if run:
                runs.append(_phrase(run))
                run = []
        else:
            run.append(day)
        day += timedelta(days=1)
    if run:
        runs.append(_phrase(run))
    if len(runs) > _MAX_GAPS:
        hidden = len(runs) - _MAX_GAPS
        return (*runs[:_MAX_GAPS], f"and {hidden} more {'gap' if hidden == 1 else 'gaps'}")
    return tuple(runs)


@dataclass(frozen=True)
class Delivered:
    """One file, read and renamed, ready to be merged."""

    filename: str
    frame: pd.DataFrame
    #: Parsed days, aligned with the frame's rows (NaT where unreadable).
    dates: pd.Series
    error: str = ""

    @property
    def ok(self) -> bool:
        return not self.error


def coverage(delivered: list[Delivered]) -> Coverage:
    """What a set of daily files spans, where it is thin, and what repeats.

    Every file has already been read and had its own column mapping applied,
    so this works in MMM's names throughout — which is what lets "these files
    repeat days" be a measurement rather than an inference from their periods.
    """
    if not delivered:
        return Coverage()

    readable = [d for d in delivered if d.ok]
    shared: list[str] = []
    if readable:
        shared = [
            c for c in readable[0].frame.columns
            if all(c in d.frame.columns for d in readable)
        ]

    spans: list[FileSpan] = []
    all_days: set[date] = set()
    delivered_rows = 0
    #: Which file first claimed each day, and what it said about it.
    owner: dict[date, str] = {}
    stated: dict[date, tuple[str, ...]] = {}
    repeated: dict[tuple[str, str], int] = {}
    duplicates = 0
    conflicts = 0

    for item in delivered:
        if not item.ok:
            spans.append(
                FileSpan(filename=item.filename, rows=0, unreadable=True, error=item.error)
            )
            continue
        dates = item.dates.dropna()
        days = {d.date() for d in dates}
        delivered_rows += len(item.frame)
        all_days |= days

        # Day by day, so a repeat is counted where it actually happens.
        measures = [c for c in shared if c in item.frame.columns]
        # EACH COLUMN IS CONVERTED ONCE, not each cell. What this needs is one
        # tuple of stated values per row, and reading them with `frame.at` per
        # cell cost one pandas scalar lookup per column per row — 3.4 million
        # of them for a 103k-row file of 33 columns, which took 70 seconds, more
        # than parsing the workbook it came from. Converting column-wise and
        # transposing gives the identical tuples in about a second.
        #
        # Positional throughout: `dates` is `_parse_dates(frame["Date"])`, so it
        # shares the frame's index AND its order, and row i of one is row i of
        # the other.
        if measures:
            value_rows = list(zip(*(item.frame[c].astype(str).to_numpy() for c in measures)))
        else:
            value_rows = [()] * len(item.frame)
        for position, parsed in enumerate(item.dates):
            if pd.isna(parsed):
                continue
            day = parsed.date()
            values = value_rows[position]
            if day in owner:
                duplicates += 1
                if stated[day] != values:
                    conflicts += 1
                pair = (
                    (owner[day], item.filename)
                    if owner[day] <= item.filename
                    else (item.filename, owner[day])
                )
                if pair[0] != pair[1]:
                    repeated[pair] = repeated.get(pair, 0) + 1
            owner[day] = item.filename
            stated[day] = values

        spans.append(
            FileSpan(
                filename=item.filename,
                rows=len(item.frame),
                first=min(days).strftime("%d-%m-%Y") if days else "",
                last=max(days).strftime("%d-%m-%Y") if days else "",
                days=frozenset(days),
                missing_columns=tuple(c for c in shared if c not in item.frame.columns),
            )
        )

    overlaps = tuple(
        f"{left} and {right} both hold {count:,} day{'' if count == 1 else 's'}"
        for (left, right), count in sorted(repeated.items())
    )
    every_column = list(
        dict.fromkeys(c for d in readable for c in d.frame.columns)
    )
    ordered = [s for s in spans if s.first]
    sortable = lambda text: (text[6:], text[3:5], text[:2])  # noqa: E731 — DD-MM-YYYY as a date
    return Coverage(
        files=tuple(spans),
        first=min((s.first for s in ordered), key=sortable, default=""),
        last=max((s.last for s in ordered), key=sortable, default=""),
        days=len(all_days),
        rows_delivered=delivered_rows,
        gaps=describe_gaps(all_days),
        overlaps=overlaps,
        duplicate_rows=duplicates,
        conflicting_rows=conflicts,
        dropped_columns=tuple(c for c in every_column if c not in shared),
        unreadable=tuple(s.filename for s in spans if s.unreadable),
    )


def merge(delivered: list[Delivered]) -> tuple[pd.DataFrame, dict[str, Any]]:
    """One daily table from several, de-duplicated on the day.

    Returns the merged frame and what happened: files in, rows in, rows out,
    duplicate days dropped, how many of those disagreed, and which columns were
    dropped for not being in every file.

    FILES ARE MERGED IN PERIOD ORDER, earliest first, so "the later file wins"
    means the later period's version of a re-sent day — not whichever file the
    browser happened to hand over first. TWO FILES COVERING THE SAME PERIOD
    TIE, and a tie is broken by FILENAME: not because alphabetical order is
    meaningful, but because it is stable, so the same two files cannot produce
    two different datasets depending on the order they were picked in. A
    restatement that disagrees with its original is reported as a conflict
    either way rather than being silently resolved.
    """
    readable = [d for d in delivered if d.ok]
    if not readable:
        return pd.DataFrame(), {
            "files": 0, "rows_in": 0, "rows_out": 0,
            "duplicates_removed": 0, "conflicts": 0, "dropped_columns": [],
        }

    plan = coverage(delivered)
    by_name = {d.filename: d for d in readable}
    sortable = lambda text: (text[6:], text[3:5], text[:2])  # noqa: E731
    order = sorted(
        (s for s in plan.files if not s.unreadable),
        key=lambda s: (sortable(s.first), s.filename),
    )
    columns = [
        c for c in readable[0].frame.columns
        if all(c in by_name[s.filename].frame.columns for s in order)
    ]

    pieces: list[pd.DataFrame] = []
    for span in order:
        item = by_name[span.filename]
        piece = item.frame.loc[:, columns].copy()
        piece[GRAIN] = item.dates
        pieces.append(piece)

    joined = pd.concat(pieces, ignore_index=True)
    rows_in = len(joined)
    # The LAST occurrence of a day survives, and the pieces are in period
    # order, so what remains is the latest version of every day.
    joined = joined[joined[GRAIN].notna()]
    joined = joined.drop_duplicates(subset=[GRAIN], keep="last")
    joined = joined.sort_values(GRAIN).reset_index(drop=True)

    return joined, {
        "files": len(order),
        "rows_in": rows_in,
        "rows_out": len(joined),
        "duplicates_removed": plan.duplicate_rows,
        "conflicts": plan.conflicting_rows,
        "dropped_columns": list(plan.dropped_columns),
    }


def parse_dates(values: pd.Series) -> pd.Series:
    """The upload's Date column as timestamps, by MMM's own rules.

    Shared with `dataset.prepare` through `dataset._parse_dates` so a day that
    merges is a day that validates: one format for the whole column, the one
    that reads the most rows.
    """
    from app.mmm import dataset

    return dataset._parse_dates(values)


def spend_columns_of(frame: pd.DataFrame) -> list[str]:
    """The media columns of a merged frame — for saying what survived."""
    return [
        c for c in frame.columns
        if str(c).lower().endswith(schema.SPEND_SUFFIX) and not schema.is_rollup(str(c))
    ]
