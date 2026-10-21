"""
Several periods of sales, delivered as several files, made into one fact table.

WHY THIS EXISTS. A client's sales history does not arrive as one file. It
arrives as "Jan-Mar", "Apr-Jun", "Jul-Sep" — often out of order, usually with a
month missing because nobody cut that extract, and frequently with a boundary
week re-sent in two files because the second export was re-run. The connector
used to refuse all of that outright: two files claiming to be the fact table
was an error ("keep one"), which is the right answer for two copies of the same
table and the wrong one for twelve months of history.

THREE DECISIONS, EACH STATED RATHER THAN DEFAULTED. Combining files is not just
concatenation, and every shortcut here is a silent wrong number later:

  * SCHEMA. If one file lacks `Promotion_Cost`, filling blanks makes that
    period's promotions look free and sends its ROI to infinity. The
    intersection is taken instead and the dropped column is REPORTED, because
    a measure missing everywhere is visible in a way a zero in one month is
    not.

  * OVERLAP. Two files both holding 25-03-2024 would double every measure in
    that week. Rows are therefore keyed on the fact grain -- date, product,
    store, promotion -- and counted once. Where the two copies disagree, the
    one from the later period wins and the disagreement is counted separately
    from the harmless exact re-sends, because a conflict is a data problem the
    user should know they have.

  * COVERAGE. A month nobody sent is NOT zero sales, it is an absent month.
    Without dim_date the calendar is generated from the fact's own dates
    (`loader._derive_week`), so a missing October simply ceases to exist and
    nothing downstream would ever flag it. `coverage` finds those holes so the
    upload screen can say so BEFORE the install, which matters because
    widening the span re-estimates the MMM baseline and moves the comparison
    card's whole-span ROI -- numbers in modules that are frozen.

MEMORY. The merge is two passes over the files and holds only the grain keys in
memory, never the rows, so a set of monthly extracts is bounded by its row
count rather than its size. The keys are kept in full rather than hashed: a
hash collision would silently drop a legitimate row, which is exactly the class
of quiet error this module exists to prevent.
"""

from __future__ import annotations

import csv
import io
from dataclasses import dataclass, field
from datetime import date
from typing import Any, Iterator

from app.tpo.loader import _derive_week, _parse_date

#: The columns that make one sales row unique. A second row with the same four
#: is the same observation arriving twice, whatever its measures say.
GRAIN: tuple[str, ...] = ("Date", "Product_id", "Store_Id", "Promotion_Id")


@dataclass(frozen=True)
class FileSpan:
    """What one delivered file turned out to hold."""

    filename: str
    rows: int
    first: str = ""
    last: str = ""
    #: Weeks, as (year, week), this file carries. Kept for the gap arithmetic.
    weeks: frozenset[tuple[int, int]] = field(default_factory=frozenset)
    #: Columns this file has that the merged table will not, and vice versa.
    missing_columns: tuple[str, ...] = ()
    unreadable: bool = False


@dataclass(frozen=True)
class Coverage:
    """The whole delivery, as the upload screen reports it."""

    files: tuple[FileSpan, ...] = ()
    first: str = ""
    last: str = ""
    weeks: int = 0
    rows_delivered: int = 0
    #: Runs of absent weeks, each as a human phrase ("weeks 40-44 of 2024").
    gaps: tuple[str, ...] = ()
    #: Files that actually hold the SAME ROWS, phrased for the user.
    #:
    #: Sharing a PERIOD is not sharing rows, and saying otherwise was a bug:
    #: a client who splits one month into a north file and a south file has
    #: two files covering the same weeks and not one duplicated row between
    #: them, yet the screen announced that rows would be de-duplicated and
    #: the installed total would come out lower. It would not. This names
    #: only real repetition, counted on the sales grain.
    overlaps: tuple[str, ...] = ()
    #: Files that cover the same weeks WITHOUT sharing rows — a region or
    #: channel split. Worth stating, because it looks like an overlap and the
    #: reassurance that nothing will be dropped is the useful part.
    same_period: tuple[str, ...] = ()
    #: Rows that appear in more than one file, and how many of those disagree
    #: about their measures. A restated extract is the second kind.
    duplicate_rows: int = 0
    conflicting_rows: int = 0
    #: Columns dropped because not every file had them.
    dropped_columns: tuple[str, ...] = ()

    @property
    def has_warnings(self) -> bool:
        return bool(self.gaps or self.overlaps or self.dropped_columns)


def _rows(payload: bytes) -> Iterator[list[str]]:
    """Every data row of a CSV payload, header consumed."""
    reader = csv.reader(io.StringIO(payload.decode("utf-8-sig", errors="replace")))
    next(reader, None)
    for row in reader:
        if row:
            yield row


def _header(payload: bytes) -> list[str]:
    reader = csv.reader(io.StringIO(payload[: 256 * 1024].decode("utf-8-sig", errors="replace")))
    return [h.strip() for h in next(reader, [])]


def _read_date(text: str, memo: dict[str, tuple[date, int] | None]) -> tuple[date, int] | None:
    """(day, week) for a date cell, memoised, or None if it cannot be read.

    Uses the loader's own week rule rather than ISO's, because that rule is
    what will build the calendar when no dim_date is uploaded -- 29-31 Dec
    belong to week 53 of their own year. Two different answers to "which week
    is this" would make the coverage report describe a dataset that the
    dashboards then slice differently.

    MEMOISED BECAUSE SALES DATA REPEATS ITS DATES. A weekly extract of 114,000
    rows holds about fifty distinct date strings, one per week, so parsing per
    ROW did the same fifty conversions two thousand times over. The cache turns
    the scan into a dictionary lookup and is what makes the coverage preview
    cheap enough to run before the user has committed to anything.
    """
    if text in memo:
        return memo[text]
    try:
        day = _parse_date(text)
        parsed = (day, _derive_week(day)) if isinstance(day, date) else None
    except Exception:
        parsed = None
    memo[text] = parsed
    return parsed


def _describe_gaps(weeks: set[tuple[int, int]]) -> tuple[str, ...]:
    """Runs of absent weeks between the first and last week present."""
    if not weeks:
        return ()
    ordered = sorted(weeks)
    present = set(ordered)
    (first_year, first_week), (last_year, last_week) = ordered[0], ordered[-1]

    # Every week the span ought to contain, year by year. A year's last week is
    # whatever the loader's rule produced for 28 December, which is 52 or 53.
    expected: list[tuple[int, int]] = []
    for year in range(first_year, last_year + 1):
        final = _derive_week(date(year, 12, 28))
        start = first_week if year == first_year else 1
        end = last_week if year == last_year else final
        expected.extend((year, week) for week in range(start, end + 1))

    runs: list[str] = []
    run: list[tuple[int, int]] = []
    for slot in expected:
        if slot in present:
            if run:
                runs.append(_phrase(run))
                run = []
        else:
            run.append(slot)
    if run:
        runs.append(_phrase(run))
    return tuple(runs)


def _phrase(run: list[tuple[int, int]]) -> str:
    (y1, w1), (y2, w2) = run[0], run[-1]
    if run[0] == run[-1]:
        return f"week {w1} of {y1}"
    if y1 == y2:
        return f"weeks {w1}-{w2} of {y1}"
    return f"week {w1} of {y1} to week {w2} of {y2}"


def coverage(
    payloads: list[tuple[str, bytes]],
    columns_of: dict[str, dict[str, str]] | None = None,
) -> Coverage:
    """What a set of fact files spans, where it is thin, and what repeats.

    `payloads` is (filename, CSV bytes). With no second argument the canonical
    names are assumed, so already-renamed bytes work unchanged.

    `columns_of` maps each file to its OWN names (canonical -> actual), which
    lets the upload screen report coverage without renaming anything first: a
    3 MB extract would otherwise have to be rewritten in full just to turn
    `TxnDate` into `Date` for a copy nobody keeps. It is also what makes real
    duplicate detection possible before the mapping is applied, since the
    grain is `Product_id` and `Store_Id`, not only the date.
    """
    if not payloads:
        return Coverage()

    named = columns_of or {}

    def actual(name: str, canonical: str) -> str:
        return named.get(name, {}).get(canonical, canonical)
    headers = {name: _header(payload) for name, payload in payloads}
    shared = [c for c in headers[payloads[0][0]] if all(c in h for h in headers.values())]
    shared_set = set(shared)

    spans: list[FileSpan] = []
    all_weeks: set[tuple[int, int]] = set()
    delivered = 0
    # One cache for the whole scan: the files are consecutive periods, so they
    # share no dates, but each file repeats its own fifty over and over.
    memo: dict[str, tuple[date, int] | None] = {}

    # Which file first claimed each sales row, and what it said about it.
    # This is what makes "these files repeat rows" a measurement rather than
    # an inference from their periods.
    owner: dict[tuple[str, ...], str] = {}
    stated: dict[tuple[str, ...], tuple[str, ...]] = {}
    repeated: dict[tuple[str, str], int] = {}
    duplicate_rows = 0
    conflicting_rows = 0

    for name, payload in payloads:
        header = headers[name]
        column = actual(name, "Date")
        if column not in header:
            spans.append(FileSpan(filename=name, rows=0, unreadable=True))
            continue
        index = header.index(column)
        # The grain, in this file's own names. Only the parts it actually has:
        # a file without Promotion_Id is keyed on what it does carry.
        grain = [
            header.index(actual(name, c))
            for c in GRAIN
            if actual(name, c) in header
        ]
        measures = [header.index(c) for c in shared if c in header]
        weeks: set[tuple[int, int]] = set()
        earliest: date | None = None
        latest: date | None = None
        count = 0
        for row in _rows(payload):
            count += 1
            if index >= len(row):
                continue
            read = _read_date(row[index], memo)
            if read is None:
                continue
            day, week = read
            weeks.add((day.year, week))
            # Tracked as we go rather than collected: holding 114,000 date
            # objects to take a min and a max of them is all cost, no benefit.
            if earliest is None or day < earliest:
                earliest = day
            if latest is None or day > latest:
                latest = day

            key = tuple(row[i] if i < len(row) else "" for i in grain)
            held = owner.get(key)
            if held is None:
                owner[key] = name
                stated[key] = tuple(row[i] if i < len(row) else "" for i in measures)
            else:
                duplicate_rows += 1
                pair = (held, name) if held <= name else (name, held)
                repeated[pair] = repeated.get(pair, 0) + 1
                if stated[key] != tuple(row[i] if i < len(row) else "" for i in measures):
                    conflicting_rows += 1
        delivered += count
        all_weeks |= weeks
        spans.append(
            FileSpan(
                filename=name,
                rows=count,
                first=earliest.strftime("%d-%m-%Y") if earliest else "",
                last=latest.strftime("%d-%m-%Y") if latest else "",
                weeks=frozenset(weeks),
                missing_columns=tuple(c for c in shared if c not in header),
            )
        )

    # Files that genuinely hold the same rows.
    overlaps = [
        f"{left} and {right} share {count:,} row{'' if count == 1 else 's'}"
        for (left, right), count in sorted(repeated.items())
    ]
    # Files that cover the same weeks and share nothing — a region or channel
    # split, which looks alarming and is not.
    shared_period: list[str] = []
    for i, left in enumerate(spans):
        for right in spans[i + 1 :]:
            if not (left.weeks & right.weeks):
                continue
            pair = (
                (left.filename, right.filename)
                if left.filename <= right.filename
                else (right.filename, left.filename)
            )
            if pair not in repeated:
                shared_period.append(
                    f"{left.filename} and {right.filename} cover the same period "
                    f"but hold different rows"
                )

    ordered_days = [s for s in spans if s.first]
    return Coverage(
        files=tuple(spans),
        first=min((s.first for s in ordered_days), key=_sortable, default=""),
        last=max((s.last for s in ordered_days), key=_sortable, default=""),
        weeks=len(all_weeks),
        rows_delivered=delivered,
        gaps=_describe_gaps(all_weeks),
        overlaps=tuple(overlaps),
        same_period=tuple(shared_period),
        duplicate_rows=duplicate_rows,
        conflicting_rows=conflicting_rows,
        dropped_columns=tuple(
            c for c in dict.fromkeys(sum((list(h) for h in headers.values()), []))
            if c not in shared_set
        ),
    )


def _sortable(text: str) -> tuple[str, str, str]:
    """DD-MM-YYYY ordered as a date rather than as a string."""
    return (text[6:], text[3:5], text[:2])


def merge(payloads: list[tuple[str, bytes]]) -> tuple[bytes, dict[str, Any]]:
    """One fact table from several, deduplicated on the sales grain.

    Returns the merged CSV and what happened: rows in, rows out, duplicates
    dropped, how many of those disagreed, and which columns were dropped for
    not being in every file.

    Files are merged in PERIOD order, earliest first, so "the later file wins"
    means the later period's version of a re-sent week — not whichever file the
    OS happened to hand over first.

    TWO FILES COVERING THE SAME PERIOD TIE, and a tie has to be broken by
    something the user can predict. It was broken by upload order, which meant
    a restated extract dropped beside its original produced one answer dragged
    in one order and the opposite answer dragged in the other — the same two
    files, two different datasets. Filename settles it instead: not because
    alphabetical order is meaningful, but because it is stable, and a
    restatement that disagrees with its original is reported as a conflict
    either way rather than being silently resolved.
    """
    if len(payloads) == 1:
        return payloads[0][1], {
            "files": 1,
            "rows_in": 0,
            "rows_out": 0,
            "duplicates_removed": 0,
            "conflicts": 0,
            "dropped_columns": [],
        }

    plan = coverage(payloads)
    by_name = dict(payloads)
    order = sorted(
        (s for s in plan.files if not s.unreadable),
        key=lambda s: (_sortable(s.first), s.filename),
    )
    columns = [
        c
        for c in _header(payloads[0][1])
        if all(c in _header(by_name[s.filename]) for s in order)
    ]
    grain = [c for c in GRAIN if c in columns]

    # PASS ONE: which occurrence of each row survives. Later files overwrite
    # earlier ones, so what remains is the latest version of every row.
    chosen: dict[tuple[str, ...], tuple[int, int]] = {}
    seen_values: dict[tuple[str, ...], tuple[str, ...]] = {}
    duplicates = 0
    conflicts = 0
    rows_in = 0

    for file_index, span in enumerate(order):
        header = _header(by_name[span.filename])
        picks = [header.index(c) for c in grain]
        measures = [header.index(c) for c in columns]
        for row_index, row in enumerate(_rows(by_name[span.filename])):
            rows_in += 1
            key = tuple(row[i] if i < len(row) else "" for i in picks)
            values = tuple(row[i] if i < len(row) else "" for i in measures)
            if key in chosen:
                duplicates += 1
                if seen_values[key] != values:
                    conflicts += 1
            chosen[key] = (file_index, row_index)
            seen_values[key] = values

    del seen_values

    # PASS TWO: emit exactly those occurrences, in period order.
    out = io.StringIO()
    writer = csv.writer(out, lineterminator="\n")
    writer.writerow(columns)
    written = 0
    for file_index, span in enumerate(order):
        header = _header(by_name[span.filename])
        picks = [header.index(c) for c in grain]
        keep = [header.index(c) for c in columns]
        for row_index, row in enumerate(_rows(by_name[span.filename])):
            key = tuple(row[i] if i < len(row) else "" for i in picks)
            if chosen.get(key) != (file_index, row_index):
                continue
            writer.writerow([row[i] if i < len(row) else "" for i in keep])
            written += 1

    return out.getvalue().encode("utf-8"), {
        "files": len(order),
        "rows_in": rows_in,
        "rows_out": written,
        "duplicates_removed": duplicates,
        "conflicts": conflicts,
        "dropped_columns": list(plan.dropped_columns),
    }
