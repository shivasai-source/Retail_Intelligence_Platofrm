"""
Installing a new star-schema dataset into the Data/ folder — the Excel
connector's real job.

WHAT THIS IS FOR. `app/tpo/config.py` resolves ONE directory (`Data/` at the
repo root, unless $TPO_DATA_DIR overrides it) and every dashboard, KPI,
optimization and report in the platform reads the star CSVs sitting in it.
Uploading through the Excel connector used to drop files into a random
`app/data/uploads/<id>/` folder that only the investigation agents ever looked
at, so a user who uploaded a fresh fact table saw the old numbers everywhere.
This module closes that gap: the recognised files are written straight
into the folder the loader reads, replacing whatever was there.

MATCHING A FILE TO ITS ROLE — BY COLUMN HEADERS, AND ONLY BY HEADERS. Not by
filename and not by upload order. A user exporting from Excel produces
`Book1.xlsx`, `export (3).csv` or `Sales Q1 FINAL v2.csv`; none of those names
say which table the file is, and a file dialog hands them over in whatever
order the OS chose. The column names DO say, unambiguously — only the fact
carries Base_Quantity, only dim_product carries Product_Name — and they are
also what the loader indexes by, so a file recognised here is a file that will
actually load. Whatever the upload was called, it is written under the
canonical filename the loader opens.

Identification and completeness are two separate steps. A few discriminating
columns decide WHICH table a file is meant to be (ROLE_DISCRIMINATORS); the
full column list then decides whether it can actually be loaded (ROLE_COLUMNS).
Collapsing them would turn "your product file is missing the Size column" into
"no product dimension uploaded" — a message about the wrong problem.

ONE DATASET, OR NOTHING. A star schema is only consistent as a set — a new
fact table joined against last week's dim_product is a different dataset with
silently wrong joins. An install therefore requires a complete set and refuses
a partial upload, and there is no backup: the only two valid states are "one
whole dataset" and "empty, waiting for an upload". A failed install clears the
folder, which puts the app back at its upload prompt rather than booting on a
half-replaced schema.

THREE REQUIRED TABLES, THREE OPTIONAL ONES. The sales fact, dim_product and
dim_geo_store must be uploaded. dim_channel, dim_promotion and dim_date are
accepted when a source system has them and DERIVED by the loader when it does
not, because no client extract carries them:

  * dim_date      -- a calendar is arithmetic, never a source table
  * dim_channel   -- channel name/type live on the store master
  * dim_promotion -- the offer's name and mechanic ride on the fact row

Dropping one is therefore not a partial upload, it is the ordinary three-file
shape. What the loader cannot invent, it still demands: see CROSS_FILE_RULES,
which requires the columns that stand in for an absent dimension. Because the
rest of the set must agree, an install DELETES the files of any optional table
not in this upload — leaving last dataset's dim_promotion beside a new fact is
exactly the silent mis-join this module exists to prevent.

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
# `replace` is aliased: this module defines a function of that name (the
# sync path), which would otherwise shadow dataclasses' at runtime.
from dataclasses import dataclass, field, replace as _with_changes
from pathlib import Path
from typing import Any

from app import column_mapping, fact_union
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
#: file missing `Size` IS NOT a usable product dimension, so recognising it as
#: one and letting the loader fail on a KeyError would report the wrong problem;
#: `missing_columns` names the absent column instead.
ROLE_COLUMNS: dict[str, tuple[str, ...]] = {
    # Only what a source system records. Week/Month come from the calendar, the
    # channel from dim_geo_store, both revenues from units x price.
    # Base_Quantity (units expected without the promotion) is read when present
    # but not required -- see loader._build_store.
    "fact": (
        "Date", "Product_id", "Store_Id", "Promotion_Id",
        "Actual_Quantity", "Base_Price", "Actual_Price",
    ),
    "product": ("Product_id", "Product_Name", "Brand", "Category", "Size"),
    "geo_store": ("Store_Id", "Channel_Id", "Retailer", "Region", "State", "City", "Tier"),
    "channel": ("Channel_Id", "Channel_Name", "Channel_Type"),
    "promotion": ("Promotion_Id", "Promotion_Name", "Promotion_Type", "Promotion_Description"),
    "date": ("Date", "Year", "Month", "Week"),
}

#: The three tables an upload cannot do without, and the three the loader
#: derives when they are absent. Order is display order.
REQUIRED_ROLES: tuple[str, ...] = ("fact", "product", "geo_store")
DERIVABLE_ROLES: tuple[str, ...] = ("channel", "promotion", "date")

#: role -> groups of interchangeable columns, each group satisfied by ANY one
#: of its members. Cost of goods is the only one: a source states it for the
#: whole line (`Total_Cost`) or per unit (`CP`, what a pricing master holds),
#: and the loader multiplies by the fact's own quantity for the latter.
EITHER_COLUMNS: dict[str, tuple[tuple[str, ...], ...]] = {
    "fact": (("Total_Cost", "CP"),),
}

#: role -> columns the loader reads WHEN PRESENT and never requires. Listed so
#: the connector can show a file's extra columns as recognised rather than as
#: noise, and so `CROSS_FILE_RULES` has one place to point at.
OPTIONAL_COLUMNS: dict[str, tuple[str, ...]] = {
    "fact": ("Base_Quantity", "Promotion_Name", "Promotion_Type", "Promotion_Cost"),
    "product": (),
    "geo_store": ("Distributor_Name", "Country", "Channel_Name", "Channel_Type", "Schedule"),
    "channel": ("Schedule",),
    "promotion": (),
    "date": ("Quarter", "Day"),
}

#: What a table must carry to stand in for a dimension nobody uploaded:
#: (absent role, the role that must cover for it, the columns it needs).
#:
#: A calendar needs nothing -- `loader._derive_week` builds it from the fact's
#: Date column -- so dim_date has no rule here. The other two cannot be
#: invented: a channel with no name and an offer with no mechanic would leave
#: the dashboards grouping by raw ids.
CROSS_FILE_RULES: tuple[tuple[str, str, tuple[str, ...]], ...] = (
    ("channel", "geo_store", ("Channel_Name",)),
    ("promotion", "fact", ("Promotion_Name", "Promotion_Type")),
)

#: role -> the columns that tell this table apart from the other five, checked
#: in this order. Identification and completeness are deliberately SEPARATE
#: steps: a file is first recognised as "meant to be the product dimension" by
#: these few columns, and only then checked against the full ROLE_COLUMNS list.
#: One step would make a product file missing `Size` simply unrecognised —
#: reported as "no product dimension uploaded" when the truth is "your product
#: file is missing the Size column", which is the difference between a message
#: the user can act on and one they cannot.
#:
#: Order matters where signatures overlap. The fact table carries Product_id,
#: Store_Id and Promotion_Id, so it is tested first on its measure columns,
#: which no dimension has; dim_geo_store carries Channel_Id, so it is tested
#: before dim_channel.
ROLE_DISCRIMINATORS: tuple[tuple[str, tuple[str, ...]], ...] = (
    ("fact", ("Actual_Quantity", "Promotion_Cost")),
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
    #: visible rather than mysterious. One of "column headers" (the file
    #: already uses our names), "recognised column names" (our names were
    #: reached through `column_mapping`'s aliases) or "chosen by you" (the
    #: upload screen said which table this is).
    matched_by: str
    #: Columns `ROLE_COLUMNS[role]` requires that this file does not have.
    #: Empty for a usable file. Non-empty means the table was recognised but
    #: cannot be loaded, which is a different message from "not uploaded".
    missing_columns: tuple[str, ...] = ()
    #: Every column the file actually carries, as uploaded. Kept because the
    #: CROSS_FILE_RULES checks run over the whole upload rather than one file,
    #: and re-reading the header to answer them would mean parsing twice.
    columns: tuple[str, ...] = ()
    #: canonical column -> the file's own column standing for it. Empty when
    #: the file already uses our names for everything. Applied as a header
    #: rename by `_to_csv_bytes`, so what lands on disk is always canonical
    #: and nothing downstream of this module knows mapping happened.
    mapping: dict[str, str] = field(default_factory=dict)
    #: canonical column -> "exact", "alias" or "chosen". The upload screen
    #: shows a guessed field differently from one that needed no guessing, so
    #: the user's attention lands on the weak ones rather than being spread
    #: evenly over eleven rows that all look equally settled.
    mapping_sources: dict[str, str] = field(default_factory=dict)
    #: Columns the mapping forced out: the file carried a canonical name AND
    #: mapped something else onto it, and two columns cannot share a name.
    #: Reported rather than silently resolved — see `column_mapping`.
    dropped_columns: tuple[str, ...] = ()

    @property
    def is_usable(self) -> bool:
        return not self.missing_columns

    def has(self, column: str) -> bool:
        """Can this file supply `column` — under our name OR a mapped one?

        The CROSS_FILE_RULES checks ask this, and they are about what the
        loader will be able to READ. A store file whose channel name arrives
        as `ChannelDesc` does carry Channel_Name once the mapping is applied,
        so answering on raw headers alone would refuse an upload that works.
        """
        if column in self.mapping:
            return True
        return column.lower() in {c.strip().lower() for c in self.columns}


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


#: How many data rows to look at for examples, and how many DISTINCT examples
#: to keep per column. Scanning well past the first row is the whole point —
#: see the docstring below.
_SAMPLE_ROWS = 60
_SAMPLE_VALUES = 3


def read_samples(
    filename: str, content: bytes, rows: int = _SAMPLE_ROWS
) -> dict[str, list[str]]:
    """A few DISTINCT example values per column, for the mapping screen.

    THIS IS A SAFETY FEATURE, NOT A CONVENIENCE. Column names alone cannot
    tell `Base_Price` from `Actual_Price`, and getting that pair the wrong way
    round inverts every discount in the dataset — promotions become price
    rises, and no validation anywhere would catch it, because both columns are
    perfectly well-formed numbers. A value beside the proposal is what lets a
    human notice in a second what no check can see at all.

    DISTINCT VALUES, OVER MANY ROWS, BECAUSE ONE ROW CAN LIE. On an unpromoted
    row the base and actual price are equal, so a single example showed `80`
    against both and taught the user nothing about the one pair that matters
    most. Reading sixty rows and keeping up to three distinct values per column
    means a price column that varies shows that it varies — `80, 100, 64` reads
    as a selling price where `80` alone read as nothing at all.

    A genuinely constant column still shows its one value, which is itself
    worth seeing: it is how someone spots that they have mapped a flag column
    onto a measure.
    """
    header = read_header(filename, content)
    if not header:
        return {}

    values: dict[str, list[str]] = {}

    def offer(column: str, cell: str) -> None:
        """Keep a value if it is new, until this column has enough."""
        text = cell.strip()[:40]
        if not text:
            return
        seen = values.setdefault(column, [])
        if len(seen) < _SAMPLE_VALUES and text not in seen:
            seen.append(text)

    if Path(filename).suffix.lower() in (".xlsx", ".xls"):
        try:
            import pandas as pd

            frame = pd.read_excel(io.BytesIO(content), nrows=rows)
        except Exception:
            return {}
        for column in frame.columns:
            for cell in frame[column].dropna().tolist():
                offer(str(column), str(cell))
        return values

    try:
        text = content[: 512 * 1024].decode("utf-8-sig", errors="replace")
        reader = csv.reader(io.StringIO(text))
        next(reader, None)  # the header, already in hand
        for _, row in zip(range(rows), reader):
            for index, column in enumerate(header):
                if index < len(row):
                    offer(column, row[index])
    except Exception:
        return {}
    return values


@dataclass(frozen=True)
class Identified:
    """Which table a header belongs to, and how its columns line up with ours."""

    role: str
    #: For `Classified.matched_by` — see its docstring for the three values.
    matched_by: str
    proposal: column_mapping.Proposal


def propose_for(role: str, header: list[str]) -> column_mapping.Proposal:
    """What each canonical column of `role` would be read from, in this file."""
    return column_mapping.propose(
        header,
        ROLE_COLUMNS[role],
        EITHER_COLUMNS.get(role, ()),
        OPTIONAL_COLUMNS.get(role, ()),
    )


def _role_of(header: list[str]) -> tuple[str, str] | None:
    """Which table this header is meant to be, by discriminators, or None.

    TWO PASSES, AND THE ORDER MATTERS. The file's own names are tried first, so
    an already-canonical upload is identified exactly as it always was and no
    alias can come between a file and the role it plainly states. Only when
    nothing matches are the aliases consulted — a file whose quantity is called
    `UnitsSold` is still the sales fact, and refusing it as "not one of the
    standard tables" was a message about the wrong problem.
    """
    present = {column_mapping.normalise(h) for h in header if h and h.strip()}
    if not present:
        return None

    for role, discriminators in ROLE_DISCRIMINATORS:
        if all(column_mapping.normalise(col) in present for col in discriminators):
            return role, "column headers"

    reachable = {column_mapping.normalise(c) for c in column_mapping.canonical_names(header)}
    for role, discriminators in ROLE_DISCRIMINATORS:
        if all(column_mapping.normalise(col) in reachable for col in discriminators):
            return role, "recognised column names"

    return None


def identify(header: list[str], role: str | None = None) -> Identified | None:
    """Work out what a file is and how its columns map, or None if unknown.

    `role` overrides the discriminators: the upload screen lets a user say
    "this is the sales fact" for a file whose names are too idiosyncratic to
    recognise, and a declared role is never second-guessed. Everything else
    about the file — which column stands for which, what is still absent — is
    then answered against that role.
    """
    if role is not None:
        if role not in ROLE_COLUMNS:
            return None
        return Identified(role=role, matched_by="chosen by you", proposal=propose_for(role, header))

    found = _role_of(header)
    if found is None:
        return None
    matched_role, matched_by = found
    return Identified(
        role=matched_role, matched_by=matched_by, proposal=propose_for(matched_role, header)
    )


def match_columns(header: list[str]) -> tuple[str, tuple[str, ...]] | None:
    """Match a column list to a star role, or None if it matches none.

    THE identification rule, factored out so every source shares one copy. A
    CSV upload reaches it via `classify`, which parses a header row first; a
    Databricks table reaches it with the column list Unity Catalog already
    supplies, no file and no download involved. Both must agree on what a table
    IS, so neither gets its own version of this loop.

    Returns (role, missing_columns) — missing being empty for a usable table.
    """
    found = identify(header)
    if found is None:
        return None
    return found.role, found.proposal.unmapped


def classify(
    filename: str,
    content: bytes,
    role: str | None = None,
    mapping: dict[str, str] | None = None,
) -> Classified | None:
    """Identify one uploaded file BY ITS COLUMN HEADERS alone.

    The filename is never consulted — only its extension, to pick a reader.
    Returns None when the header matches none of the discriminators, which
    is not an error: the caller keeps such a file as an ordinary profiled
    dataset for the investigation agents.

    A file that IS recognised but lacks columns the loader needs comes back
    with `missing_columns` populated, so the caller can say which column is
    absent instead of reporting the whole table as missing.

    `role` and `mapping` carry what the upload screen settled with the user: a
    declared table, and canonical -> that file's own column. A CONFIRMED
    MAPPING WINS over anything proposed here. The proposal exists to save the
    user typing; once they have corrected it, this function must not quietly
    re-guess a field they chose — that is the difference between a suggestion
    and a decision made on their behalf.
    """
    safe = Path(filename).name
    if Path(safe).suffix.lower() not in (".csv", ".xlsx", ".xls"):
        return None

    header = read_header(safe, content)
    if not header:
        return None

    found = identify(header, role)
    if found is None:
        return None

    proposal = found.proposal
    if mapping:
        # Only the fields the user actually settled are overridden; the rest of
        # the proposal stands. A mapping naming a column the file does not have
        # is ignored rather than trusted — the browser may have been looking at
        # a different file by the time it was sent.
        actual_by_norm = {column_mapping.normalise(h): h.strip() for h in header if h and h.strip()}
        confirmed = dict(proposal.mapping)
        sources = dict(proposal.sources)
        for canonical, chosen in mapping.items():
            actual = actual_by_norm.get(column_mapping.normalise(chosen or ""))
            if actual is None:
                continue
            confirmed[canonical] = actual
            sources[canonical] = "chosen"
        proposal = column_mapping.Proposal(
            mapping=confirmed,
            sources=sources,
            unmapped=tuple(
                c for c in ROLE_COLUMNS[found.role] if c not in confirmed
            ) + tuple(
                " or ".join(group)
                for group in EITHER_COLUMNS.get(found.role, ())
                if not any(m in confirmed for m in group)
            ),
            spare=tuple(c for c in proposal.spare if c not in confirmed.values()),
        )

    # Computed now, while the header is in hand, so the upload screen can warn
    # about a collision before the install rather than after it.
    _, dropped = column_mapping.apply_to_header(list(header), proposal.renames)
    return Classified(
        role=found.role,
        target_name=ROLE_FILES[found.role],
        original_name=safe,
        content=content,
        matched_by=found.matched_by,
        missing_columns=proposal.unmapped,
        columns=tuple(header),
        mapping=proposal.mapping,
        mapping_sources=proposal.sources,
        dropped_columns=tuple(dropped),
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
    for (name, cols), (_, hit) in zip(sources, matched):
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
                # Carried so the CROSS_FILE_RULES checks see a Databricks
                # selection exactly as they see an upload.
                columns=tuple(cols),
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
    # Same rule as `validate`: several sales files are one delivery, a second
    # copy of a dimension is a mistake.
    satisfied = {
        r
        for r, f in by_role.items()
        if f and all(c.is_usable for c in f) and (r == "fact" or len(f) == 1)
    }

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
            {
                "role": role,
                "label": ROLE_LABELS[role],
                "required_columns": list(ROLE_COLUMNS[role]),
                # A derivable dimension is reported so the page can name it,
                # but it is not something the user has to supply.
                "required": role in REQUIRED_ROLES,
            }
            for role in ROLE_COLUMNS
            if role not in satisfied
        ],
        "ready": not message,
        "message": message,
        "locked": is_locked(),
    }


def _file_facts(data: bytes) -> dict[str, Any]:
    """Rows, size and a content fingerprint of one CSV, for "which file
    changed". Line endings are normalised first: the same data saved with
    CRLF instead of LF is not a change."""
    import hashlib

    body = data.replace(b"\r\n", b"\n").rstrip(b"\n")
    lines = body.count(b"\n") + 1 if body else 0
    return {
        "rows": max(0, lines - 1),
        "size_bytes": len(data),
        "digest": hashlib.blake2b(body, digest_size=16).hexdigest(),
    }


def _to_csv_bytes(item: Classified) -> bytes:
    """The bytes to write. Excel uploads are converted to CSV, because the
    loader opens these paths with `csv.DictReader` and nothing else.

    THE MAPPING IS APPLIED HERE, AND ONLY HERE. A client's `UnitsSold` becomes
    `Actual_Quantity` on the way to disk, so every file the loader opens is
    canonical and nothing downstream of this module — not the loader, not a
    KPI, not a frozen module — can tell a mapped upload from a native one.
    Rewriting the header is also all it takes: the loader indexes by column
    NAME, so the row data is passed through untouched.
    """
    excel = Path(item.original_name).suffix.lower() in (".xlsx", ".xls")
    renames = {
        actual: canonical
        for canonical, actual in item.mapping.items()
        if column_mapping.normalise(actual) != column_mapping.normalise(canonical)
    }

    if excel:
        try:
            import pandas as pd

            frame = pd.read_excel(io.BytesIO(item.content))
        except Exception as e:
            raise StarDatasetError(f"Couldn't read {item.original_name} as Excel: {e}") from e
        if renames:
            header, dropped = column_mapping.apply_to_header(
                [str(c) for c in frame.columns], renames
            )
            frame = frame.drop(columns=dropped, errors="ignore")
            frame.columns = header
        buffer = io.StringIO()
        frame.to_csv(buffer, index=False)
        return buffer.getvalue().encode("utf-8")

    if not renames:
        return item.content
    return _rename_csv_header(item.content, renames)


def _rename_csv_header(content: bytes, renames: dict[str, str]) -> bytes:
    """Rewrite a CSV's first row, leaving every data row byte-identical.

    The header alone is parsed and re-emitted; the rest of the file is sliced
    off and concatenated untouched. A 21 MB fact table is therefore renamed
    without being parsed, re-quoted or re-encoded — which also means no
    opportunity to mangle a value on the way through.

    A column dropped by the rename (a collision — see `apply_to_header`) has
    to come out of every row, so that one case does read the whole file. It is
    rare by construction: it needs the file to carry both a canonical name and
    something else mapped onto it.
    """
    text = content.decode("utf-8-sig", errors="replace")
    first, sep, rest = text.partition("\n")
    newline = "\r\n" if first.endswith("\r") else "\n"
    header = next(csv.reader(io.StringIO(first.rstrip("\r"))), [])
    if not header:
        return content

    renamed, dropped = column_mapping.apply_to_header(header, renames)

    out = io.StringIO()
    writer = csv.writer(out, lineterminator=newline)
    writer.writerow(renamed)

    if not dropped:
        # Nothing to take out of the rows, so they are concatenated as bytes
        # rather than parsed — the 21 MB path.
        return (out.getvalue() + rest).encode("utf-8") if sep else out.getvalue().encode("utf-8")

    # `apply_to_header` left the dropped names out of `renamed`, so the columns
    # it kept and the indices to keep are the same set, in the same order.
    keep = [i for i, name in enumerate(header) if name not in dropped]
    for row in csv.reader(io.StringIO(rest)):
        if row:
            writer.writerow([row[i] if i < len(row) else "" for i in keep])
    return out.getvalue().encode("utf-8")


def _coverage_of(classified: list[tuple[str, Classified | None]]) -> dict[str, Any]:
    """The coverage preview for a multi-file sales upload, or {} if not one.

    Computed from the MAPPED bytes, as the install will see them — the dates
    are in a column called `TxnDate` until the rename is applied, and a
    coverage report that disagreed with the installed dataset would be worse
    than none.

    Inspection reads only a prefix of each CSV (see HEADER_PREVIEW_BYTES in the
    datasets router), so the row counts and the last date here describe what
    was read, not necessarily the whole file. `truncated` says so rather than
    letting the screen state a span it cannot see the end of.
    """
    facts = [c for _, c in classified if c is not None and c.role == "fact"]
    if len(facts) < 2:
        return {}

    # The files are read AS UPLOADED, with each one's own date column named
    # rather than renamed. Rewriting a 3 MB extract just to turn `TxnDate`
    # into `Date` for a copy nobody keeps was pure cost.
    payloads = [(item.original_name, item.content) for item in facts]
    plan = fact_union.coverage(
        payloads,
        {item.original_name: item.mapping.get("Date", "Date") for item in facts},
    )
    return {
        "files": [
            {
                "filename": f.filename,
                "rows": f.rows,
                "first": f.first,
                "last": f.last,
                "missing_columns": list(f.missing_columns),
                "unreadable": f.unreadable,
            }
            for f in plan.files
        ],
        "first": plan.first,
        "last": plan.last,
        "weeks": plan.weeks,
        "rows_delivered": plan.rows_delivered,
        "gaps": list(plan.gaps),
        "overlaps": list(plan.overlaps),
        "dropped_columns": list(plan.dropped_columns),
    }


def _payloads_to_write(
    items: list[Classified],
) -> tuple[list[tuple[Classified, bytes]], dict[str, Any]]:
    """The bytes for each table, with several sales files merged into one.

    ORDER MATTERS HERE. The column mapping is applied first (`_to_csv_bytes`),
    so every file speaks canonical names, and only then are the sales files
    merged — `fact_union` keys rows on `Date` and `Product_id`, which do not
    exist until the rename has happened.

    Returns the list to stage plus what the merge did, which the caller passes
    back to the user: a set of monthly extracts that silently lost 2,340 rows
    to de-duplication is something they should be told, not something they
    should have to notice.
    """
    rendered = [(item, _to_csv_bytes(item)) for item in items]
    facts = [(item, payload) for item, payload in rendered if item.role == "fact"]
    if len(facts) < 2:
        return rendered, {}

    merged, stats = fact_union.merge([(item.original_name, payload) for item, payload in facts])
    first = facts[0][0]
    combined = _with_changes(
        first,
        original_name=f"{first.original_name} + {len(facts) - 1} more",
        # The merged header is the intersection, so a column one file lacked
        # is no longer there to be claimed.
        columns=tuple(fact_union._header(merged)),
    )
    others = [(item, payload) for item, payload in rendered if item.role != "fact"]
    return [(combined, merged), *others], stats


def _discard(folder: Path, names: list[str]) -> None:
    """Remove a half-applied install.

    There is no backup to restore from: an install must supply the COMPLETE
    set, so the previous contents are never a valid fallback — half the
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
    from app.tpo import filters, promo_calendar, service, studio
    from app.tpo.loader import get_store

    _SECTION_CACHE.clear()
    for cached in (
        filters.rows_for,
        filters.baseline_rows_for,
        filters._present_values,
        promo_calendar._aggregate,
        promo_calendar.available_years,
        promo_calendar.booking,
        fingerprint._compute,
        # The Insights Hub's memoised engine passes (app/tpo/service.py).
        service._bundle,
        service.promotion_events,
        service._period_totals,
        service._cannibalization_detail,
        service._breakdown_groups,
        # The Simulation Studio's fitted lift model (app/tpo/studio.py).
        studio.lift_model,
    ):
        cached.cache_clear()
    # The Promotion Planner's slot table, fitted response model and every
    # selection resolved against them (app/tpo/planner*.py).
    from app.tpo import planner, planner_model
    planner.clear()
    planner_model.clear()
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

    Five distinct problems, reported separately because the fix differs:
      * a REQUIRED table nobody uploaded     -> upload that file
      * a table uploaded twice               -> remove one of them
      * a table uploaded but missing columns -> fix the export
      * a derivable table left out, with no
        column standing in for it            -> add that column
      * a file that is none of the standard tables -> remove it

    A DERIVABLE table left out is not a problem by itself: dim_channel,
    dim_promotion and dim_date are reconstructed by the loader. What is a
    problem is leaving one out when the table that must cover for it does not
    carry the columns to do so — CROSS_FILE_RULES.

    `unrecognised` carries the filenames whose headers matched no table. One
    file per table may be uploaded: an extra file is a mistake the user should
    see now — silently profiling it elsewhere hid a wrong-file-picked slip
    behind a success message.
    """
    by_role: dict[str, list[Classified]] = {}
    for item in items:
        by_role.setdefault(item.role, []).append(item)

    problems: list[str] = []

    for name in unrecognised or []:
        problems.append(
            f"'{name}': its columns match none of the {len(ROLE_COLUMNS)} tables — "
            f"remove it, only the standard star-schema tables can be uploaded."
        )

    # SEVERAL SALES FILES ARE A DELIVERY, NOT A MISTAKE. A client's history
    # arrives as "Jan-Mar", "Apr-Jun", "Jul-Sep", so the fact table is merged
    # (see app/fact_union.py) rather than refused. Several copies of a
    # DIMENSION is still a mistake: two product masters are two versions of
    # one list, and silently picking either would join the new fact against
    # whichever happened to be chosen.
    duplicates = {
        role: found
        for role, found in by_role.items()
        if len(found) > 1 and role != "fact"
    }
    for role, found in duplicates.items():
        names = ", ".join(f"'{f.original_name}'" for f in found)
        problems.append(
            f"{ROLE_LABELS[role]}: {len(found)} files have these columns ({names}) — keep one."
        )

    # EVERY file of a role, not just the first: with four sales files, a
    # missing column in the third one has to be named as the third one's.
    incomplete = [
        item
        for role, found in by_role.items()
        if role not in duplicates
        for item in found
        if not item.is_usable
    ]
    for item in incomplete:
        problems.append(
            f"{ROLE_LABELS[item.role]}: '{item.original_name}' is missing "
            f"{'column' if len(item.missing_columns) == 1 else 'columns'} "
            f"{', '.join(item.missing_columns)}."
        )

    # A role is only satisfied by exactly one file that carries every column.
    satisfied = {
        role
        for role, found in by_role.items()
        if found and all(f.is_usable for f in found) and (role == "fact" or len(found) == 1)
    }
    unusable_roles = {i.role for i in incomplete} | set(duplicates)
    never_uploaded = [
        role for role in REQUIRED_ROLES
        if role not in satisfied and role not in unusable_roles
    ]

    if never_uploaded:
        problems.append(
            "Not uploaded: "
            + "; ".join(
                f"{ROLE_LABELS[role]} (needs {', '.join(ROLE_COLUMNS[role])})"
                for role in never_uploaded
            )
            + "."
        )

    # A derivable dimension left out is fine only if its stand-in columns are
    # there. Checked against the uploaded file itself, not against the folder:
    # the install is about to delete whatever that dimension's old file was.
    for absent_role, carrier, needed in CROSS_FILE_RULES:
        if absent_role in by_role or carrier not in satisfied:
            continue
        lacking = [col for col in needed if not by_role[carrier][0].has(col)]
        if lacking:
            problems.append(
                f"{ROLE_LABELS[absent_role]} was not uploaded, so "
                f"{ROLE_LABELS[carrier]} must carry "
                f"{'column' if len(lacking) == 1 else 'columns'} "
                f"{', '.join(lacking)} instead — add "
                f"{'it' if len(lacking) == 1 else 'them'} or upload "
                f"{ROLE_LABELS[absent_role].lower()}."
            )

    if problems:
        ready = len(satisfied & set(REQUIRED_ROLES))
        extra = sorted(satisfied - set(REQUIRED_ROLES))
        # The trailing instruction only fits when something is actually absent.
        # With every required table present and an extra file alongside them,
        # "upload the missing file(s)" told the user to do the opposite.
        remedy = (
            " Please upload the missing file(s) to continue the pipeline."
            if ready < len(REQUIRED_ROLES) or never_uploaded
            else " Fix the problem(s) above to continue the pipeline."
        )
        alongside = f" ({len(extra)} optional table(s) alongside)" if extra else ""
        raise StarDatasetError(
            f"{ready} of {len(REQUIRED_ROLES)} required tables ready{alongside}. "
            + " ".join(problems) + remedy
        )


def install(items: list[Classified], unrecognised: list[str] | None = None) -> dict[str, Any]:
    """Write a COMPLETE star schema into the data folder and reload from it.

    The three required tables must arrive in one upload, together with any
    optional dimension the source happens to have. A star schema is only
    meaningful as a set — a new fact table joined against the previous
    dim_product is a different dataset whose joins are quietly wrong — so a
    partial upload is refused outright rather than half-applied. That is also
    why there is no backup to roll back to: the only two valid states are "one
    whole dataset" and "empty, waiting for an upload".

    An optional dimension the user did NOT upload has its old file deleted in
    the same swap. Keeping it would join the previous dataset's channels or
    offers onto the new fact — the same silent mis-join a partial upload is
    refused for, arrived at by omission instead.
    """
    if is_locked():
        raise StarDatasetError(
            "A complete dataset is already loaded. Use Reset to clear it "
            "before uploading a new set — see the connector's Reset button."
        )

    validate(items, unrecognised)  # raises with a message naming exactly what is absent

    folder = data_dir()
    folder.mkdir(parents=True, exist_ok=True)

    payloads, union = _payloads_to_write(items)
    names = [item.target_name for item, _ in payloads]
    replaced = [item.target_name for item, _ in payloads if (folder / item.target_name).is_file()]

    # Derivable dimensions this upload left out: their old files belong to the
    # previous dataset and must not survive into this one.
    uploaded_roles = {item.role for item in items}
    superseded = [
        ROLE_FILES[role]
        for role in DERIVABLE_ROLES
        if role not in uploaded_roles and (folder / ROLE_FILES[role]).is_file()
    ]

    with _install_lock:
        # STAGE EVERYTHING FIRST, then swap. Writing and swapping one file at a
        # time meant a failure partway through left earlier tables replaced
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
            # Inside the same lock and after the swap, so the folder is never
            # observed holding the new fact beside a stale dimension.
            _discard(folder, superseded)
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
                f"kept — please upload the files again: {e}"
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
        # Empty unless several sales files were merged. Reported because a
        # delivery that quietly lost rows to de-duplication is something the
        # user should be told, not something they should have to notice.
        "union": union,
    }


def replace(items: list[Classified], unrecognised: list[str] | None = None) -> dict[str, Any]:
    """Swap a fresh copy of the SAME source's tables in over the loaded set.

    This is the sync path (see app/source_sync.py), and it differs from
    `install` in the two ways a sync needs:

      * It runs while a complete set is loaded. The lock exists to stop a user
        silently mixing two datasets; a sync re-reads the very files that were
        installed, so it is the same dataset, newer — not a mix.
      * It keeps the current files until the new set has loaded. A sync that
        fails (a malformed row pushed to the source, a file open in Excel) must
        leave the platform on yesterday's data, not on an empty folder — the
        user did nothing destructive, so nothing should be lost.

    The current files are renamed to `.<name>.previous`, the staged set is
    swapped in, and the store is rebuilt from it. Any failure moves the previous
    files back and rebuilds from them.
    """
    validate(items, unrecognised)

    folder = data_dir()
    folder.mkdir(parents=True, exist_ok=True)
    payloads, _union = _payloads_to_write(items)

    from app.tpo.loader import get_store
    # Each table as it was before this replace, to say which files changed.
    previous: dict[str, dict[str, Any]] = {}
    for item, _ in payloads:
        current = folder / item.target_name
        if current.is_file():
            try:
                previous[item.target_name] = _file_facts(current.read_bytes())
            except OSError:
                pass

    with _install_lock:
        try:
            previous_rows = get_store().row_count if is_locked() else 0
            before = snapshot(get_store()) if is_locked() else None
        except Exception:
            previous_rows = 0
            before = None

        staged: list[tuple[Path, Path]] = []
        try:
            for item, payload in payloads:
                target = folder / item.target_name
                staged.append((_stage(target, payload), target))
        except Exception as e:
            for temp, _ in staged:
                temp.unlink(missing_ok=True)
            raise StarDatasetError(f"Couldn't write the synced files into {folder}: {e}") from e

        backups: list[tuple[Path, Path]] = []
        try:
            for _, target in staged:
                if target.is_file():
                    backup = target.with_name(f".{target.name}.previous")
                    _replace_with_retry(target, backup)
                    backups.append((backup, target))
            for temp, target in staged:
                _replace_with_retry(temp, target)
            reset_caches()
            rows = get_store().row_count
            after = snapshot(get_store())
        except Exception as e:
            for temp, _ in staged:
                temp.unlink(missing_ok=True)
            for backup, target in backups:
                try:
                    _replace_with_retry(backup, target)
                except Exception:
                    pass  # reported below; the backup file is left in place to recover by hand
            reset_caches()
            raise StarDatasetError(
                f"The synced files couldn't be loaded, so the previous data was kept: {e}"
            ) from e

        for backup, _ in backups:
            backup.unlink(missing_ok=True)

    def _entry(item: Classified, payload: bytes) -> dict[str, Any]:
        now = _file_facts(payload)
        was = previous.get(item.target_name)
        return {
            "role": item.role,
            "filename": item.target_name,
            "original_name": item.original_name,
            "matched_by": item.matched_by,
            "size_bytes": len(payload),
            "rows": now["rows"],
            "previous_rows": was["rows"] if was else None,
            "previous_size_bytes": was["size_bytes"] if was else None,
            # None when there was no earlier copy to compare with.
            "changed": None if was is None else was["digest"] != now["digest"],
        }

    return {
        "installed": [_entry(item, payload) for item, payload in payloads],
        "rows": rows,
        "previous_rows": previous_rows,
        # What the data covered before the swap and after it, for the
        # "what changed" panel a sync opens (see `snapshot`).
        "before": before,
        "after": after,
        "data_dir": str(folder),
    }


def current_status() -> dict[str, Any]:
    """Which star files the data folder currently holds. Lets the frontend show
    what is connected without parsing anything.

    `required` separates the three tables that must be on disk from the three
    the loader derives, so the page can show an absent dim_date as "derived
    from the sales dates" rather than as a gap the user has to fill.
    """
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
                "optional_columns": list(OPTIONAL_COLUMNS.get(role, ())),
                "required": role in REQUIRED_ROLES,
                "present": present,
                "size_bytes": stat.st_size if stat else 0,
                "modified_at": int(stat.st_mtime * 1000) if stat else None,
            }
        )
    complete = all(f["present"] for f in files if f["required"])
    return {
        "data_dir": str(folder),
        "files": files,
        "complete": complete,
        # Complete means uploading is closed until a reset — the frontend uses
        # this to swap the dropzone for the View/Reset actions.
        "locked": complete,
    }


def reset() -> dict[str, Any]:
    """Delete every star file, putting the connector back at its upload prompt.

    The counterpart to `install`'s all-or-nothing rule: since the only two valid
    states are "one whole dataset" and "empty", clearing is what makes a
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
        # Likewise a sync's `.name.previous` backups (see `replace`).
        for temp in folder.glob(".*.previous"):
            temp.unlink(missing_ok=True)
        reset_caches()
    return {"removed": removed, "data_dir": str(folder)}


def snapshot(store) -> dict[str, Any]:
    """What a loaded dataset covers: its rows, the span of days, and how many
    business weeks, products, stores, channels and promotions it holds. Data
    shape only -- no KPI figures. Compared before and after a sync."""
    weeks = set(zip(store.year, store.week))
    starts = store.dims.week_start
    days = sorted(d for key in weeks for d in store.dims.week_dates.get(key, ()))
    stores_seen = set(store.store_code)
    promos_seen = {c for c in set(store.promo_code) if store.promotions[c].is_promotional}
    return {
        "rows": store.row_count,
        "first_day": days[0].isoformat() if days else None,
        "last_day": (starts.get(max(weeks)) or days[-1]).isoformat() if days else None,
        "weeks": len(weeks),
        "products": len(set(store.product_code)),
        "stores": len(stores_seen),
        "channels": len({store.stores[c].channel_id for c in stores_seen}),
        "promotions": len(promos_seen),
    }


def is_locked() -> bool:
    """True when a complete set is installed and further uploads are refused.

    Uploading is a replace-the-world operation, so it is allowed only from the
    empty state. With a loadable dataset present the user's choices are to view
    it or to reset — see `reset` for why replacing in place is not one of them.

    Only the REQUIRED tables count. Testing all six would leave a three-file
    dataset permanently unlocked: the connector would go on offering its
    dropzone over a dataset the dashboards are already reading, and `install`
    would accept a second fact table on top of the first.
    """
    folder = data_dir()
    return all((folder / ROLE_FILES[role]).is_file() for role in REQUIRED_ROLES)


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


def inspect(
    uploads: list[tuple[str, bytes]],
    settled: dict[str, dict[str, Any]] | None = None,
    with_coverage: bool = False,
) -> dict[str, Any]:
    """Classify a set of files WITHOUT installing them.

    Lets the upload screen tell the user which table each file was recognised
    as, and what is still missing, before committing to a 21 MB round trip that
    can only be refused. Identical rules to `install`, so the preview and the
    real thing can never disagree.

    `settled` carries what the mapping screen has established so far, keyed by
    filename — a declared role, and any column choices the user has corrected.
    Passing it back through the same function is what keeps the mapping screen
    honest: the proposals it renders, the readiness it reports and the install
    that follows are all one code path, so the screen cannot promise something
    the install then refuses.
    """
    chosen = settled or {}
    classified = [
        (
            name,
            classify(
                name,
                content,
                role=chosen.get(Path(name).name, {}).get("role"),
                mapping=chosen.get(Path(name).name, {}).get("columns"),
            ),
        )
        for name, content in uploads
    ]
    recognised = [c for _, c in classified if c is not None]
    unrecognised = [name for name, c in classified if c is None]
    # An unrecognised file still has to offer its columns to the mapping
    # screen: "say which table this is" is useless without them.
    header_of = {
        name: read_header(name, content)
        for name, content in uploads
        if name in set(unrecognised)
    }
    samples_of = {name: read_samples(name, content) for name, content in uploads}

    try:
        validate(recognised, unrecognised)
        message = ""
    except StarDatasetError as e:
        message = str(e)

    by_role: dict[str, list[Classified]] = {}
    for item in recognised:
        by_role.setdefault(item.role, []).append(item)
    # Same rule as `validate`: several sales files are one delivery, a second
    # copy of a dimension is a mistake.
    satisfied = {
        r
        for r, f in by_role.items()
        if f and all(c.is_usable for c in f) and (r == "fact" or len(f) == 1)
    }

    return {
        "files": [
            {
                "filename": name,
                "role": c.role if c else None,
                "label": ROLE_LABELS[c.role] if c else None,
                "missing_columns": list(c.missing_columns) if c else [],
                "recognised": c is not None,
                # What the mapping settled, so the upload screen can show which
                # of the user's columns will be read as which of ours — and,
                # for an unrecognised file, offer every column as a candidate.
                "matched_by": c.matched_by if c else None,
                "mapping": dict(c.mapping) if c else {},
                "mapping_sources": dict(c.mapping_sources) if c else {},
                "dropped_columns": list(c.dropped_columns) if c else [],
                "columns": list(c.columns) if c else list(header_of.get(name, [])),
                # One example value per column, so a price mapping can be
                # checked by eye — see `read_samples`.
                "samples": samples_of.get(name, {}),
            }
            for name, c in classified
        ],
        "missing_roles": [
            {
                "role": role,
                "label": ROLE_LABELS[role],
                "required_columns": list(ROLE_COLUMNS[role]),
                # A derivable dimension is reported so the page can name it,
                # but it is not something the user has to supply.
                "required": role in REQUIRED_ROLES,
            }
            for role in ROLE_COLUMNS
            if role not in satisfied
        ],
        "ready": not message,
        "message": message,
        "locked": is_locked(),
        # What several sales files add up to, for the preview the user
        # confirms before anything is installed. Empty for a single-file
        # upload, and ASKED FOR rather than always computed: it is the only
        # part of this function that reads past the first rows of a file, and
        # the mapping screen re-inspects on every edit without needing it.
        "coverage": _coverage_of(classified) if with_coverage else {},
    }
