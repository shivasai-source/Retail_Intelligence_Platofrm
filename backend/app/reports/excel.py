"""The Excel writer — one `ReportDoc` in, real `.xlsx` bytes out.

A REAL WORKBOOK, via openpyxl. Not a CSV with the extension changed: what comes
out of here is the zipped OOXML a spreadsheet actually opens, with typed cells,
number formats, frozen headers and autofilters.

IT KNOWS NOTHING ABOUT THE BUSINESS. No KPI is named here, no module is special
cased, nothing is computed. It walks the sections an adapter built and lays them
out. That is what keeps fourteen format-times-module combinations down to two
writers.

NUMBERS GO IN AS NUMBERS. A currency cell receives `9071892.0` and a number
format, never the string "₹90.7 L" — so the recipient can sum a column, sort it
and chart it. The currency SYMBOL in that format follows the currency the user
had selected, so a USD session never yields a rupee-formatted book.

A MISSING VALUE STAYS EMPTY. `None` is written as a blank cell, never as 0: a
figure the engine could not produce must read as absent, exactly as it does on
screen.

LAID OUT TO BE READ, NOT JUST OPENED. The summary sheet leads with the KPIs and
keeps the filter bookkeeping compact; every table has a dark header row, banded
rows, status words in their tone and columns sized to what they hold; and every
sheet prints landscape at page width with its header row repeated.
"""

from __future__ import annotations

import io
from typing import Any

from openpyxl import Workbook
from openpyxl.styles import Alignment, Border, Font, PatternFill, Side
from openpyxl.utils import get_column_letter
from openpyxl.worksheet.worksheet import Worksheet

from app.reports.model import (
    Column,
    ReportDoc,
    Section,
    Table,
    excel_number_format,
    is_numeric,
    status_tone,
    visible_columns,
)

# --- the one palette, matching the application's own chrome -----------------

_INK = "1A1F2E"
_SECONDARY = "4B5563"
_MUTED = "6B7280"
_BRAND = "6B47FF"
_BRAND_TINT = "F3F0FF"
_HEAD = "262B3D"
_BAND = "F7F8FB"
_RULE = "E2E5EC"

_TONE = {"negative": "B91C1C", "warning": "B45309", "positive": "047857", "neutral": _INK}

_FONT = "Calibri"
_TITLE = Font(name=_FONT, size=20, bold=True, color=_INK)
_BRANDLINE = Font(name=_FONT, size=10, bold=True, color=_BRAND)
_MODULE = Font(name=_FONT, size=12, color=_SECONDARY)
_H1 = Font(name=_FONT, size=16, bold=True, color=_INK)
_H2 = Font(name=_FONT, size=13, bold=True, color=_INK)
_LABEL = Font(name=_FONT, size=10, color=_SECONDARY)
_VALUE = Font(name=_FONT, size=11, color=_INK)
_VALUE_BOLD = Font(name=_FONT, size=11, bold=True, color=_INK)
_KPI_VALUE = Font(name=_FONT, size=12, bold=True, color=_INK)
_TH = Font(name=_FONT, size=11, bold=True, color="FFFFFF")
_SMALL = Font(name=_FONT, size=10, color=_MUTED)
_SMALL_ITALIC = Font(name=_FONT, size=10, italic=True, color=_MUTED)

_TH_FILL = PatternFill("solid", fgColor=_HEAD)
_BAND_FILL = PatternFill("solid", fgColor=_BAND)
_TINT_FILL = PatternFill("solid", fgColor=_BRAND_TINT)
_THIN = Side(style="thin", color=_RULE)
_BRAND_SIDE = Side(style="medium", color=_BRAND)
_ROW = Border(bottom=_THIN)
_HEAD_BORDER = Border(bottom=Side(style="thin", color=_HEAD))

_WRAP = Alignment(vertical="top", wrap_text=True)
_RIGHT = Alignment(horizontal="right", vertical="center")
# A one-character indent on left-aligned text, so a text column that follows a
# right-aligned figure does not butt up against it.
_LEFT = Alignment(horizontal="left", vertical="center", indent=1)
_HEAD_LEFT = Alignment(horizontal="left", vertical="center", wrap_text=True, indent=1)
_HEAD_RIGHT = Alignment(horizontal="right", vertical="center", wrap_text=True)

#: Rows given to a header row, a data row and a section heading.
_HEAD_HEIGHT = 22
_ROW_HEIGHT = 18


def _tone_font(tone: str, *, size: int = 11) -> Font:
    return Font(name=_FONT, size=size, bold=True, color=_TONE[tone])


def _sheet_name(raw: str, used: set[str]) -> str:
    """A legal, unique worksheet name.

    Excel rejects []:*?/\\ and anything over 31 characters, and silently
    corrupts a workbook with duplicates — so both are handled here rather than
    left for an adapter to remember.
    """
    clean = "".join(c for c in raw if c not in set('[]:*?/\\')).strip() or "Sheet"
    clean = clean[:31]
    if clean not in used:
        used.add(clean)
        return clean
    for n in range(2, 100):
        suffix = f" {n}"
        candidate = clean[: 31 - len(suffix)] + suffix
        if candidate not in used:
            used.add(candidate)
            return candidate
    used.add(clean[:28] + "~99")
    return clean[:28] + "~99"


def _put(ws: Worksheet, row: int, col: int, value: Any, *, font=None, fmt=None, align=None,
         fill=None, border=None) -> None:
    cell = ws.cell(row=row, column=col, value=value)
    if font:
        cell.font = font
    if fmt:
        cell.number_format = fmt
    if align:
        cell.alignment = align
    if fill:
        cell.fill = fill
    if border:
        cell.border = border


def _widen(ws: Worksheet, col: int, width: float) -> None:
    letter = get_column_letter(col)
    ws.column_dimensions[letter].width = max(ws.column_dimensions[letter].width or 0, width)


def _heading(ws: Worksheet, row: int, title: str, span: int) -> int:
    """A section heading with a brand rule under it, across `span` columns."""
    _put(ws, row, 1, title, font=_H2)
    for c in range(1, max(span, 1) + 1):
        ws.cell(row=row, column=c).border = Border(bottom=_BRAND_SIDE)
    ws.row_dimensions[row].height = _HEAD_HEIGHT
    return row + 1


def _note(ws: Worksheet, row: int, text: str, span: int) -> int:
    _put(ws, row, 1, text, font=_SMALL_ITALIC, align=_WRAP)
    if span > 1:
        ws.merge_cells(start_row=row, start_column=1, end_row=row, end_column=span)
    ws.row_dimensions[row].height = max(16, 15 * (1 + len(text) // 120))
    return row + 1


def _print_setup(ws: Worksheet, doc: ReportDoc, *, title_row: int | None = None) -> None:
    """Landscape at page width, header row repeated, page numbers in the footer."""
    ws.page_setup.orientation = "landscape"
    ws.page_setup.paperSize = ws.PAPERSIZE_A4
    ws.page_setup.fitToWidth = 1
    ws.page_setup.fitToHeight = 0
    ws.sheet_properties.pageSetUpPr.fitToPage = True
    ws.page_margins.left = ws.page_margins.right = 0.4
    ws.page_margins.top = ws.page_margins.bottom = 0.6
    if title_row:
        ws.print_title_rows = f"{title_row}:{title_row}"
    ws.oddFooter.left.text = f"{doc.brand} · {doc.module}"
    ws.oddFooter.left.size = 8
    ws.oddFooter.right.text = "Page &P of &N"
    ws.oddFooter.right.size = 8


# --- the summary sheet -------------------------------------------------------


def _cover(ws: Worksheet, doc: ReportDoc) -> int:
    """Brand, title, when and what — the top of the Executive Summary."""
    _widen(ws, 1, 30)
    _widen(ws, 2, 22)

    _put(ws, 1, 1, doc.brand, font=_BRANDLINE)
    _put(ws, 2, 1, doc.module, font=_MODULE)
    _put(ws, 3, 1, doc.title, font=_TITLE)
    ws.row_dimensions[3].height = 30
    r = 5

    rows = [("Generated", doc.generated_display, None), ("Scope", doc.scope_line, None)]
    if doc.headline:
        # Bold ink, not the adapter's tone — see pdf.py's cover.
        rows.append(("Status", doc.headline, None))
    for label, value, tone in rows:
        _put(ws, r, 1, label, font=_LABEL, fill=_TINT_FILL, align=_LEFT)
        _put(ws, r, 2, value, font=_tone_font(tone) if tone else _VALUE_BOLD,
             fill=_TINT_FILL, align=Alignment(vertical="center", wrap_text=True))
        ws.merge_cells(start_row=r, start_column=2, end_row=r, end_column=6)
        for c in range(3, 7):
            ws.cell(row=r, column=c).fill = _TINT_FILL
        ws.row_dimensions[r].height = 20 if len(str(value)) < 90 else 34
        r += 1

    if doc.empty_reason:
        r += 1
        r = _heading(ws, r, "No data", 6)
        r = _note(ws, r, doc.empty_reason, 6)
    return r + 1


def _filters(ws: Worksheet, row: int, doc: ReportDoc) -> int:
    """Every filter dimension, two to a row, a constrained one in bold.

    All are named even when unconstrained — a list of only the set ones leaves
    a reader guessing whether Region was filtered or forgotten — but compactly,
    so fourteen "All" rows do not bury the two that matter.
    """
    row = _heading(ws, row, "Filters", 6)
    pairs = list(doc.filters)
    for i in range(0, len(pairs), 2):
        for j, (label, value) in enumerate(pairs[i:i + 2]):
            col = 1 + j * 3
            text = str(value)
            constrained = text.strip().lower() not in ("all", "")
            _put(ws, row, col, label, font=_LABEL, align=_LEFT)
            _put(ws, row, col + 1, text, font=_VALUE_BOLD if constrained else _VALUE,
                 align=_LEFT)
        ws.row_dimensions[row].height = _ROW_HEIGHT
        row += 1
    _widen(ws, 4, 22)
    return row + 1


def _meta(ws: Worksheet, row: int, title: str, pairs: tuple[tuple[str, str], ...]) -> int:
    row = _heading(ws, row, title, 6)
    for label, value in pairs:
        _put(ws, row, 1, str(label), font=_LABEL, align=Alignment(vertical="top"))
        _put(ws, row, 2, value, font=_VALUE, align=_WRAP)
        ws.merge_cells(start_row=row, start_column=2, end_row=row, end_column=6)
        ws.row_dimensions[row].height = max(_ROW_HEIGHT, 15 * (1 + len(str(value)) // 95))
        row += 1
    return row + 1


def _kpi_block(ws: Worksheet, row: int, section: Section, currency: str) -> int:
    """KPI cards as a typed grid. Columns blank for every KPI are left out."""
    row = _heading(ws, row, section.title, 6)

    def basis(e: Any) -> str:
        # Either the wider-scope fallback or this scope's own basis — see pdf.py.
        return e.measured_at if e.measured_at else " · ".join(
            x for x in (e.delta_basis, e.evidence) if x
        )

    entries = section.items
    optional = [
        ("Previous", lambda e: e.previous is not None),
        ("Change", lambda e: e.delta_display not in ("", "—", "-")),
        ("Trend", lambda e: bool(e.trend)),
        ("Basis / evidence", lambda e: bool(basis(e))),
    ]
    headers = ["KPI", "Value", "As displayed"] + [
        name for name, present in optional if any(present(e) for e in entries)
    ]
    for i, h in enumerate(headers, start=1):
        _put(ws, row, i, h, font=_TH, fill=_TH_FILL,
             align=_HEAD_RIGHT if h in ("Value", "As displayed", "Previous", "Change") else _HEAD_LEFT)
    ws.row_dimensions[row].height = _HEAD_HEIGHT
    row += 1

    for n, entry in enumerate(entries):
        band = _BAND_FILL if n % 2 else None
        cells: dict[str, tuple[Any, dict[str, Any]]] = {
            "KPI": (entry.label, {"font": _VALUE_BOLD, "align": _LEFT}),
        }
        if entry.available and entry.value is not None:
            cells["Value"] = (entry.value, {"font": _KPI_VALUE, "align": _RIGHT,
                                            "fmt": excel_number_format(entry.kind, currency)})
        else:
            # NOT ZERO. The card had no value, and the reason travels with it.
            cells["Value"] = (entry.unavailable_reason or "Not available",
                              {"font": _SMALL, "align": _WRAP})
        # THE CARD'S OWN RENDERING beside the number, so a reader can check the
        # workbook against the screen without re-deriving anything, and so the
        # workbook and the PDF cannot disagree about precision.
        cells["As displayed"] = (entry.display or None, {"font": _VALUE, "align": _RIGHT})
        cells["Previous"] = (entry.previous, {"font": _VALUE, "align": _RIGHT,
                                              "fmt": excel_number_format(entry.kind, currency)})
        cells["Change"] = (entry.delta_display or None, {"font": _VALUE_BOLD, "align": _RIGHT})
        cells["Trend"] = (entry.trend or None, {"font": _VALUE, "align": _LEFT})
        cells["Basis / evidence"] = (basis(entry) or None, {"font": _SMALL, "align": _WRAP})

        for i, h in enumerate(headers, start=1):
            value, style = cells[h]
            _put(ws, row, i, value, fill=band, border=_ROW, **style)
        # Tall enough for the wrapped text: an unavailable KPI's reason sits in
        # the narrow Value column, the basis in the wide last one.
        reason_lines = -(-len(str(cells["Value"][0])) // 22) if not entry.available else 1
        basis_lines = -(-len(basis(entry)) // 48) if basis(entry) else 1
        ws.row_dimensions[row].height = max(22, 14 * max(reason_lines, basis_lines) + 4)
        row += 1

    widths = {"KPI": 30, "Value": 22, "As displayed": 18, "Previous": 18, "Change": 16,
              "Trend": 12, "Basis / evidence": 46}
    for i, h in enumerate(headers, start=1):
        _widen(ws, i, widths[h])
    if section.note:
        row = _note(ws, row, section.note, len(headers))
    return row + 1


def _kv_block(ws: Worksheet, row: int, section: Section) -> int:
    row = _heading(ws, row, section.title, 6)
    for label, value in section.items:
        _put(ws, row, 1, str(label), font=_LABEL, align=_LEFT, border=_ROW)
        _put(ws, row, 2, value, font=_VALUE_BOLD,
             align=_RIGHT if isinstance(value, (int, float)) else _LEFT, border=_ROW)
        ws.row_dimensions[row].height = _ROW_HEIGHT
        row += 1
    if section.note:
        row = _note(ws, row, section.note, 6)
    return row + 1


def _text_block(ws: Worksheet, row: int, section: Section) -> int:
    row = _heading(ws, row, section.title, 6)
    for paragraph in section.items:
        _put(ws, row, 1, str(paragraph), font=_VALUE, align=_WRAP)
        ws.merge_cells(start_row=row, start_column=1, end_row=row, end_column=6)
        ws.row_dimensions[row].height = max(18, 15 * (1 + len(str(paragraph)) // 110))
        row += 1
    return row + 1


# --- tables ------------------------------------------------------------------


def _width(column: Column, rows: tuple[dict[str, Any], ...]) -> float:
    """A column wide enough for its header and its values, within reason."""
    longest = len(column.header)
    for record in rows[:500]:
        value = record.get(column.key)
        if value is None:
            continue
        if is_numeric(column.kind) and isinstance(value, (int, float)):
            # Formatted width: grouping, two decimals and the unit.
            longest = max(longest, len(f"{abs(value):,.2f}") + 3)
        else:
            longest = max(longest, len(str(value)))
    return min(max(10, longest + 3), 48)


def _table_block(ws: Worksheet, row: int, table: Table, currency: str, *, freeze: bool) -> tuple[int, int]:
    """One grid, with a dark header row and an autofilter over the data.

    Returns the next free row and the header row."""
    columns = visible_columns(table)
    if table.title:
        _put(ws, row, 1, table.title, font=_SMALL)
        row += 1

    for i, column in enumerate(columns, start=1):
        _put(ws, row, i, column.header, font=_TH, fill=_TH_FILL, border=_HEAD_BORDER,
             align=_HEAD_RIGHT if is_numeric(column.kind) else _HEAD_LEFT)
        _widen(ws, i, _width(column, table.rows))
    ws.row_dimensions[row].height = _HEAD_HEIGHT
    header_row = row
    row += 1

    for n, record in enumerate(table.rows):
        band = _BAND_FILL if n % 2 else None
        for i, column in enumerate(columns, start=1):
            value = record.get(column.key)
            numeric = is_numeric(column.kind) and isinstance(value, (int, float))
            font = _VALUE
            if column.kind == "status" and status_tone(value):
                font = _tone_font(status_tone(value))
            _put(
                ws, row, i,
                value,
                font=font,
                border=_ROW,
                fill=band,
                align=_RIGHT if numeric else _LEFT,
                fmt=excel_number_format(column.kind, currency) if numeric else None,
            )
        ws.row_dimensions[row].height = _ROW_HEIGHT
        row += 1

    last = row - 1
    if table.rows:
        ws.auto_filter.ref = f"A{header_row}:{get_column_letter(len(columns))}{last}"
    if freeze:
        ws.freeze_panes = ws.cell(row=header_row + 1, column=1)
    if table.note:
        row += 1
        row = _note(ws, row, table.note, len(columns))
    return row + 1, header_row


# --- the book ----------------------------------------------------------------


def write(doc: ReportDoc, currency: str = "INR") -> bytes:
    """Render one report as `.xlsx` bytes.

    SHEET LAYOUT. The summary always leads. A section that names a `sheet` gets
    its own worksheet — that is how a detailed table stays usable instead of
    being buried under a summary — and everything else stacks onto the summary
    sheet in order, the KPIs first.

    THE SUMMARY IS NOT FROZEN. It is a page to read top to bottom; freezing it
    at its KPI header pinned thirty-odd rows to the top of the window, which on
    a laptop left almost no room to scroll the rest.
    """
    book = Workbook()
    used: set[str] = set()

    summary = book.active
    summary.title = _sheet_name("Executive Summary", used)
    summary.sheet_view.showGridLines = False
    summary.sheet_properties.tabColor = _BRAND
    row = _cover(summary, doc)

    sections = list(doc.sections)
    lead = [s for s in sections[:1] if s.kind == "kpi" and not s.sheet]
    for section in lead:
        row = _kpi_block(summary, row, section, currency)
        sections.remove(section)

    if doc.filters:
        row = _filters(summary, row, doc)
    if doc.meta:
        row = _meta(summary, row, "Report metadata", doc.meta)

    for section in sections:
        if section.sheet:
            sheet = book.create_sheet(_sheet_name(section.sheet, used))
            sheet.sheet_view.showGridLines = False
            sheet.sheet_properties.tabColor = _HEAD
            title_row = None
            if section.kind == "table" and section.table is not None:
                _put(sheet, 1, 1, doc.brand, font=_BRANDLINE)
                _put(sheet, 2, 1, section.title or section.table.title, font=_H1)
                sheet.row_dimensions[2].height = 24
                _put(sheet, 3, 1, f"{doc.module} · {doc.scope_line}", font=_SMALL)
                table = section.table
                if table.title == section.title:
                    table = Table(table.columns, table.rows, "", table.note)
                _, title_row = _table_block(sheet, 4, table, currency, freeze=True)
            elif section.kind == "kpi":
                _kpi_block(sheet, 1, section, currency)
            elif section.kind == "text":
                _text_block(sheet, 1, section)
            else:
                _kv_block(sheet, 1, section)
            _print_setup(sheet, doc, title_row=title_row)
            continue

        if section.kind == "kpi":
            row = _kpi_block(summary, row, section, currency)
        elif section.kind == "table" and section.table is not None:
            # THE SECTION'S OWN HEADING FIRST. `_table_block` writes the TABLE's
            # title, which is a subtitle describing the grid ("Trade spend by
            # promotion"); without this the section heading it belongs under
            # ("Promotion mix") never reached the sheet at all.
            columns = len(visible_columns(section.table))
            row = _heading(summary, row, section.title or section.table.title, max(columns, 6))
            table = section.table
            if table.title == section.title:
                table = Table(table.columns, table.rows, "", table.note)
            row, _ = _table_block(summary, row, table, currency, freeze=False)
        elif section.kind == "text":
            row = _text_block(summary, row, section)
        else:
            row = _kv_block(summary, row, section)

    if doc.disclaimers:
        row = _heading(summary, row, "Notes", 6)
        for line in doc.disclaimers:
            row = _note(summary, row, line, 6)

    _print_setup(summary, doc)

    buffer = io.BytesIO()
    book.save(buffer)
    return buffer.getvalue()
