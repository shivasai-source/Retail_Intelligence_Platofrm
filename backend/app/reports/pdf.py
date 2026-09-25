"""The PDF writer — one `ReportDoc` in, real `.pdf` bytes out.

A REAL PDF, via reportlab's platypus. Not HTML with the extension changed: what
comes out is a paginated document with a flowable frame, so tables break across
pages properly and headers repeat instead of being clipped.

IT KNOWS NOTHING ABOUT THE BUSINESS, for the same reason the Excel writer does
not — see excel.py. It walks the sections an adapter built.

VALUES ARRIVE RAW AND ARE RENDERED THROUGH THE PROJECT'S OWN FORMATTER. A
currency cell holds `9071892.0` and is printed by `app/tpo/formatting.money`,
which is the function the screen used — so the PDF carries the same figure in
the same currency the Insights Hub showed, rather than inventing a second
formatting rule. The one substitution is the rupee SYMBOL, which none of the
fonts available here can draw; see `_UNPRINTABLE`.

WIDE TABLES GET LANDSCAPE. A section can ask for it, and the document is built
in page templates so a landscape section genuinely re-frames rather than being
squeezed.

THE LAYOUT READS TOP-DOWN. Page one leads with the title, when and what it
covers, the KPIs as tiles, then a compact filter grid — the figures a reader
opened the report for come before the bookkeeping about how it was made. Tables
carry a dark header row that repeats on every page, status words in their tone,
and negative figures in red; a column blank on every row is left out.
"""

from __future__ import annotations

import io
from typing import Any

from reportlab.lib import colors
from reportlab.lib.enums import TA_LEFT, TA_RIGHT
from reportlab.lib.pagesizes import A4, landscape
from reportlab.lib.styles import ParagraphStyle, getSampleStyleSheet
from reportlab.lib.units import mm
from reportlab.pdfbase.pdfmetrics import stringWidth
from reportlab.platypus import (
    BaseDocTemplate,
    Frame,
    KeepTogether,
    NextPageTemplate,
    PageBreak,
    PageTemplate,
    Paragraph,
    Spacer,
    Table as PdfTable,
    TableStyle,
)
from reportlab.platypus.flowables import HRFlowable

from app.tpo import formatting as F

from app.reports.model import ReportDoc, Section, Table, is_numeric, status_tone, visible_columns

# --- the one palette, matching the application's own chrome -----------------

_INK = colors.HexColor("#1A1F2E")
_SECONDARY = colors.HexColor("#4B5563")
_MUTED = colors.HexColor("#6B7280")
_BRAND = colors.HexColor("#6B47FF")
_BRAND_TINT = colors.HexColor("#F3F0FF")
_BRAND_LINE = colors.HexColor("#DCD3FF")
_RULE = colors.HexColor("#E2E5EC")
_PANEL = colors.HexColor("#F7F8FB")
_BAND = colors.HexColor("#FAFAFC")
_HEAD = colors.HexColor("#262B3D")

_TONE = {
    "negative": colors.HexColor("#B91C1C"),
    "warning": colors.HexColor("#B45309"),
    "positive": colors.HexColor("#047857"),
    # The adapters' headline tones, which use a different vocabulary.
    "neutral": _INK,
}

_MARGIN = 14 * mm
#: The band at the top of every page: brand strip plus the running header.
_HEADER = 10 * mm

#: Characters the PDF's base fonts cannot draw, and what to draw instead.
#:
#: reportlab's built-in Helvetica is a Type 1 font on the standard encoding, and
#: none of the TTFs reportlab bundles (Bitstream Vera) carries U+20BC INDIAN RUPEE
#: SIGN either -- Vera predates it. Left alone, every rupee figure in every PDF
#: prints as a hollow box, which is worse than useless on a printed report.
#:
#: So INR renders as "Rs." in the PDF specifically. The workbook keeps the real
#: symbol, because Excel draws with a system font that has it -- verified in
#: tests/test_reports_export.py. Bundling a Unicode font to fix the glyph would
#: mean shipping a font file and tying the backend to it; substituting two
#: characters is the smaller, portable answer, and "Rs." is unambiguous.
_UNPRINTABLE = {"₹": "Rs."}


def _safe(text: str) -> str:
    """Replace characters the base fonts cannot draw, and escape markup.

    Every string reaches a `Paragraph`, which parses a small XML dialect — so a
    bare "&" or "<" in a product or promotion name would break the build."""
    for bad, good in _UNPRINTABLE.items():
        text = text.replace(bad, good)
    return text.replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;")


def _style(name: str, *, font: str = "Helvetica", size: float = 9.5, color: Any = _INK,
           leading: float | None = None, **kw: Any) -> ParagraphStyle:
    return ParagraphStyle(name, parent=_base["Normal"], fontName=font, fontSize=size,
                          textColor=color, leading=leading or size * 1.35, **kw)


_base = getSampleStyleSheet()
_S = {
    "brand": _style("brand", font="Helvetica-Bold", size=9, color=_BRAND, spaceAfter=3),
    "module": _style("module", size=11.5, color=_SECONDARY, spaceAfter=2),
    "title": _style("title", font="Helvetica-Bold", size=22, leading=27, spaceAfter=10),
    "h2": _style("h2", font="Helvetica-Bold", size=13, leading=16, spaceBefore=12,
                 spaceAfter=3, keepWithNext=1),
    "subtitle": _style("subtitle", size=9, color=_SECONDARY, spaceAfter=4, keepWithNext=1),
    "label": _style("label", size=9, color=_SECONDARY),
    "value": _style("value", size=10),
    "valueb": _style("valueb", font="Helvetica-Bold", size=10),
    "body": _style("body", size=10, leading=14.5, spaceAfter=6, alignment=TA_LEFT),
    "small": _style("small", size=8.5, color=_SECONDARY, leading=12, spaceAfter=3),
    "cell": _style("cell", size=8.5, leading=11),
    "cellb": _style("cellb", font="Helvetica-Bold", size=8.5, leading=11),
    "cellr": _style("cellr", size=8.5, leading=11, alignment=TA_RIGHT),
    "th": _style("th", font="Helvetica-Bold", size=8.5, leading=11, color=colors.white),
    "thr": _style("thr", font="Helvetica-Bold", size=8.5, leading=11, color=colors.white,
                  alignment=TA_RIGHT),
    "tile_label": _style("tile_label", font="Helvetica-Bold", size=8.5, color=_SECONDARY),
    "tile_value": _style("tile_value", font="Helvetica-Bold", size=16, leading=20),
    "tile_sub": _style("tile_sub", size=7.5, color=_MUTED, leading=10),
    "filter_label": _style("filter_label", size=8.5, color=_MUTED),
    "filter_all": _style("filter_all", size=9, color=_SECONDARY),
    "filter_set": _style("filter_set", font="Helvetica-Bold", size=9),
}


def _toned(text: str, base: ParagraphStyle, tone: str) -> Paragraph:
    """A paragraph in a tone's colour and weight, or plain when it has none."""
    if not tone:
        return Paragraph(text, base)
    return Paragraph(
        f'<font name="Helvetica-Bold" color="{_TONE[tone].hexval()}">{text}</font>', base
    )


def _display(value: Any, kind: str, currency: str) -> str:
    """Render one cell THROUGH THE PROJECT'S OWN FORMATTER.

    `app/tpo/formatting.py` is what the screen used, so the PDF cannot disagree
    with it about how a rupee, a percentage or a unit count looks — including
    the currency conversion, which that module applies once at display time.

    A `None` prints as the formatter's own empty marker, never as 0.
    """
    if value is None:
        return "—"
    if isinstance(value, (int, float)):
        if kind == "currency":
            return _safe(F.money(float(value), currency))
        if kind == "percent":
            return F.percent(float(value))
        if kind == "multiple":
            return F.multiple(float(value))
        if kind == "units":
            return F.quantity(float(value))
        if kind == "number":
            return F.score(float(value), dp=1)
    return _safe(str(value))


def _kpi_number(value: float | None, kind: str, currency: str) -> str:
    """A KPI's PREVIOUS value, at the precision the card renders its own value.

    The payload supplies `previous_value` but not always a rendered string for
    it, so this fills the gap — and it must fill it with the SAME rule the card
    used, or the two columns of one row disagree about precision. That is why
    `score` is called at its default zero decimals here and not at the one the
    generic table renderer uses: the Insights Hub prints PEI as "66", so the
    previous period must print as "70", not "70.0".
    """
    if value is None:
        return "—"
    if kind == "currency":
        return _safe(F.money(float(value), currency))
    if kind == "percent":
        return F.percent(float(value))
    if kind == "multiple":
        return F.multiple(float(value))
    if kind == "units":
        return F.quantity(float(value))
    return F.score(float(value))


class _Doc(BaseDocTemplate):
    """Page furniture: the brand strip, the running header and footer.

    The footer carries the module, the scope and `page N` on every page, which
    is what makes a printed extract self-describing when it is separated from
    its first page. From page two on, a running header names the report too.
    """

    def __init__(self, buffer: io.BytesIO, doc: ReportDoc, **kw: Any) -> None:
        super().__init__(buffer, **kw)
        self._doc = doc
        portrait_frame = Frame(_MARGIN, _MARGIN + 9 * mm, A4[0] - 2 * _MARGIN,
                               A4[1] - 2 * _MARGIN - 9 * mm - _HEADER, id="p")
        land = landscape(A4)
        landscape_frame = Frame(_MARGIN, _MARGIN + 9 * mm, land[0] - 2 * _MARGIN,
                                land[1] - 2 * _MARGIN - 9 * mm - _HEADER, id="l")
        self.addPageTemplates([
            PageTemplate(id="portrait", frames=[portrait_frame], pagesize=A4,
                         onPage=self._furniture),
            PageTemplate(id="landscape", frames=[landscape_frame], pagesize=land,
                         onPage=self._furniture),
        ])

    def _furniture(self, canvas: Any, doc: Any) -> None:
        canvas.saveState()
        width, height = canvas._pagesize
        page = canvas.getPageNumber()

        # Brand strip across the top edge of every page.
        canvas.setFillColor(_BRAND)
        canvas.rect(0, height - 2.2 * mm, width, 2.2 * mm, stroke=0, fill=1)

        # Running header from page two: the cover already says all of this.
        if page > 1:
            y = height - _MARGIN - 1 * mm
            canvas.setFont("Helvetica-Bold", 8)
            canvas.setFillColor(_BRAND)
            canvas.drawString(_MARGIN, y, _safe(self._doc.brand))
            canvas.setFont("Helvetica", 8)
            canvas.setFillColor(_SECONDARY)
            canvas.drawRightString(width - _MARGIN, y,
                                   _plain(f"{self._doc.module} · {self._doc.title}")[:110])
            canvas.setStrokeColor(_RULE)
            canvas.setLineWidth(0.5)
            canvas.line(_MARGIN, y - 2.5 * mm, width - _MARGIN, y - 2.5 * mm)

        # Footer.
        y = _MARGIN + 4 * mm
        canvas.setStrokeColor(_RULE)
        canvas.setLineWidth(0.5)
        canvas.line(_MARGIN, y + 4 * mm, width - _MARGIN, y + 4 * mm)
        canvas.setFont("Helvetica", 7.5)
        canvas.setFillColor(_MUTED)
        canvas.drawString(_MARGIN, y, _plain(f"{self._doc.brand} · {self._doc.module}")[:120])
        canvas.setFont("Helvetica-Bold", 7.5)
        canvas.drawRightString(width - _MARGIN, y, f"Page {page}")
        scope = self._doc.scope_line
        if scope:
            canvas.setFont("Helvetica", 7.5)
            canvas.drawCentredString(width / 2, y, _plain(scope)[:90])
        canvas.restoreState()


def _plain(text: str) -> str:
    """`_safe` for the canvas, which draws text literally and needs no escaping."""
    for bad, good in _UNPRINTABLE.items():
        text = text.replace(bad, good)
    return text


def _heading(title: str) -> list[Any]:
    """A section heading with a hairline under it, kept with what follows."""
    rule = HRFlowable(width="100%", thickness=0.6, color=_RULE, spaceBefore=1, spaceAfter=6)
    rule.keepWithNext = 1
    return [Paragraph(_safe(title), _S["h2"]), rule]


def _panel(content: PdfTable, *, fill: Any = _PANEL, line: Any = _RULE) -> PdfTable:
    """Wrap one flowable in a tinted, ruled box."""
    box = PdfTable([[content]], colWidths=[None], hAlign="LEFT")
    box.setStyle(TableStyle([
        ("BACKGROUND", (0, 0), (-1, -1), fill),
        ("BOX", (0, 0), (-1, -1), 0.6, line),
        ("LEFTPADDING", (0, 0), (-1, -1), 10),
        ("RIGHTPADDING", (0, 0), (-1, -1), 10),
        ("TOPPADDING", (0, 0), (-1, -1), 8),
        ("BOTTOMPADDING", (0, 0), (-1, -1), 8),
    ]))
    return box


def _kv_rows(pairs: tuple[tuple[str, str], ...], label_width: float = 40 * mm,
             tones: dict[str, str] | None = None) -> PdfTable:
    data = []
    for k, v in pairs:
        tone = (tones or {}).get(str(k), "")
        data.append([Paragraph(_safe(str(k)), _S["label"]),
                     _toned(_safe(str(v)), _S["value"], tone)])
    table = PdfTable(data, colWidths=[label_width, None], hAlign="LEFT")
    table.setStyle(TableStyle([
        ("VALIGN", (0, 0), (-1, -1), "TOP"),
        ("TOPPADDING", (0, 0), (-1, -1), 2.5),
        ("BOTTOMPADDING", (0, 0), (-1, -1), 2.5),
        ("LEFTPADDING", (0, 0), (-1, -1), 0),
    ]))
    return table


def _filter_grid(filters: tuple[tuple[str, str], ...], avail: float) -> PdfTable:
    """Every filter dimension, three to a row.

    ALL ARE NAMED, EVEN WHEN UNCONSTRAINED — a list of only the set ones leaves
    a reader guessing whether Region was filtered or forgotten. But fourteen
    "All" rows down a page buried the two that mattered, so the grid is compact
    and a constrained filter is set in bold.
    """
    per_row = 4 if avail > 200 * mm else 3
    cells: list[Any] = []
    for label, value in filters:
        text = str(value)
        constrained = text.strip().lower() not in ("all", "")
        cells.append([
            Paragraph(_safe(str(label)), _S["filter_label"]),
            Paragraph(_safe(text), _S["filter_set"] if constrained else _S["filter_all"]),
        ])
    while len(cells) % per_row:
        cells.append("")
    rows = [cells[i:i + per_row] for i in range(0, len(cells), per_row)]
    inner = avail - 20
    grid = PdfTable(rows, colWidths=[inner / per_row] * per_row, hAlign="LEFT")
    grid.setStyle(TableStyle([
        ("VALIGN", (0, 0), (-1, -1), "TOP"),
        ("LEFTPADDING", (0, 0), (-1, -1), 0),
        ("TOPPADDING", (0, 0), (-1, -1), 3),
        ("BOTTOMPADDING", (0, 0), (-1, -1), 3),
    ]))
    return _panel(grid)


def _tiles(tiles: list[list[Any]], avail: float, per_row: int) -> PdfTable:
    """Cards in a grid: each tile is a list of flowables stacked in one cell."""
    while len(tiles) % per_row:
        tiles.append("")
    rows = [tiles[i:i + per_row] for i in range(0, len(tiles), per_row)]
    gap = 6
    width = (avail - gap * (per_row - 1)) / per_row
    # Interleave spacer columns so the cards read as separate boxes.
    data = []
    for row in rows:
        line: list[Any] = []
        for i, cell in enumerate(row):
            if i:
                line.append("")
            line.append(cell)
        data.append(line)
    col_widths = []
    for i in range(per_row):
        if i:
            col_widths.append(gap)
        col_widths.append(width)

    # A thin empty row between rows of cards, so stacked cards do not touch.
    spaced_data: list[list[Any]] = []
    spaced_style: list[Any] = [
        ("VALIGN", (0, 0), (-1, -1), "TOP"),
        ("LEFTPADDING", (0, 0), (-1, -1), 9),
        ("RIGHTPADDING", (0, 0), (-1, -1), 9),
        ("TOPPADDING", (0, 0), (-1, -1), 8),
        ("BOTTOMPADDING", (0, 0), (-1, -1), 9),
    ]
    for r, line in enumerate(data):
        if r:
            spaced_data.append([""] * len(line))
        spaced_data.append(line)
        out_r = r * 2
        for i, cell in enumerate(rows[r]):
            if cell == "":
                continue
            c = i * 2
            spaced_style += [
                ("BACKGROUND", (c, out_r), (c, out_r), _PANEL),
                ("BOX", (c, out_r), (c, out_r), 0.6, _RULE),
                ("LINEABOVE", (c, out_r), (c, out_r), 2, _BRAND),
            ]
        if r:
            spaced_style += [
                ("TOPPADDING", (0, out_r - 1), (-1, out_r - 1), 0),
                ("BOTTOMPADDING", (0, out_r - 1), (-1, out_r - 1), 0),
            ]
    grid = PdfTable(spaced_data, colWidths=col_widths, hAlign="LEFT",
                    rowHeights=[6 if (i % 2) else None for i in range(len(spaced_data))])
    grid.setStyle(TableStyle(spaced_style))
    return grid


def _kpi_tiles(section: Section, currency: str, avail: float) -> PdfTable:
    """KPI cards as the Insights Hub draws them: label, value, one line under.

    THE CARD'S OWN DISPLAY STRING, not a re-rendering of the raw value.
    `formatting.score` at one decimal would print the screen's "66" as "66.0";
    a report must not introduce that drift. See model.KpiEntry.
    """
    tiles: list[list[Any]] = []
    for e in section.items:
        if e.available and e.display:
            value, available = e.display, True
        elif e.available and e.value is not None:
            value, available = _display(e.value, e.kind, currency), True
        else:
            value, available = e.unavailable_reason or "Not available", False

        # WHAT THE TILE SHOWS UNDERNEATH: the change and its basis, or — when
        # this scope cannot support the figure — the wider scope's measurement
        # the screen falls back to. EITHER the fallback OR this scope's own
        # basis and evidence, never both: appending this selection's "0
        # comparable events" behind a wider scope's 144 would be two counts of
        # two different populations side by side.
        previous = e.previous_display or (
            _kpi_number(e.previous, e.kind, currency) if e.previous is not None else ""
        )
        # "—" is the card's own "no change to report", not a delta.
        delta = e.delta_display if e.delta_display not in ("", "—", "-") else ""
        parts = []
        if previous:
            parts.append(f"Previous {previous}" + (f" ({delta})" if delta else ""))
        elif delta:
            parts.append(delta)
        parts.append(
            e.measured_at if e.measured_at
            else " · ".join(x for x in (e.delta_basis, e.evidence) if x)
        )
        sub = " · ".join(p for p in parts if p) or " "

        # The change in bold ink, NOT green/red: whether a rise is good depends
        # on the KPI (more trade spend is not), and the card does not say.
        tiles.append([
            Paragraph(_safe(e.label), _S["tile_label"]),
            Spacer(1, 4),
            Paragraph(_safe(value), _S["tile_value"] if available else _S["small"]),
            Spacer(1, 3),
            _toned(_safe(sub), _S["tile_sub"], "neutral" if delta else ""),
        ])
    per_row = 4 if avail > 200 * mm else 3
    return _tiles(tiles, avail, per_row)


def _stat_tiles(section: Section, avail: float) -> PdfTable:
    """A short key/value section — counts, a few figures — as small cards."""
    tiles = [
        [Paragraph(_safe(str(label)), _S["tile_label"]), Spacer(1, 4),
         _toned(_safe(str(value)), _S["tile_value"], "")]
        for label, value in section.items
    ]
    return _tiles(tiles, avail, max(1, min(len(tiles), 4)))


def _is_stats(section: Section) -> bool:
    """Short labels with short values read better as cards than as a list."""
    items = section.items
    return (
        0 < len(items) <= 8
        and all(len(str(v)) <= 18 and len(str(k)) <= 28 for k, v in items)
    )


def _grid(table: Table, currency: str, avail: float) -> PdfTable:
    """One table, sized to the frame and styled to repeat its header."""
    columns = visible_columns(table)
    header = [Paragraph(_safe(c.header), _S["thr"] if is_numeric(c.kind) else _S["th"])
              for c in columns]
    body = []
    for record in table.rows:
        line = []
        for column in columns:
            value = record.get(column.key)
            text = _display(value, column.kind, currency)
            if is_numeric(column.kind):
                negative = isinstance(value, (int, float)) and value < 0
                line.append(_toned(text, _S["cellr"], "negative" if negative else ""))
            elif column.kind == "status":
                line.append(_toned(text, _S["cell"], status_tone(value)))
            else:
                line.append(Paragraph(text, _S["cell"]))
        body.append(line)

    widths = _column_widths(table, columns, avail, currency)

    grid = PdfTable([header] + body, colWidths=widths, repeatRows=1, hAlign="LEFT")
    style = [
        ("BACKGROUND", (0, 0), (-1, 0), _HEAD),
        ("VALIGN", (0, 0), (-1, -1), "MIDDLE"),
        ("TOPPADDING", (0, 0), (-1, 0), 5),
        ("BOTTOMPADDING", (0, 0), (-1, 0), 5),
        ("TOPPADDING", (0, 1), (-1, -1), 4),
        ("BOTTOMPADDING", (0, 1), (-1, -1), 4),
        ("LEFTPADDING", (0, 0), (-1, -1), 5),
        ("RIGHTPADDING", (0, 0), (-1, -1), 5),
        ("LINEBELOW", (0, 1), (-1, -1), 0.4, _RULE),
        ("BOX", (0, 0), (-1, -1), 0.6, _RULE),
    ]
    for i in range(1, len(body) + 1):
        if i % 2 == 0:
            style.append(("BACKGROUND", (0, i), (-1, i), _BAND))
    grid.setStyle(TableStyle(style))
    return grid


def _column_widths(table: Table, columns: tuple, avail: float, currency: str) -> list[float]:
    """Divide the frame by the columns' weights, but never so narrow that a
    single word has to break — "Underperforming" split across two lines reads
    as two words. Columns that need more take it from those with room to spare.
    """
    pad = 11
    floors = []
    for column in columns:
        words = column.header.split()
        cells = [_display(r.get(column.key), column.kind, currency) for r in table.rows]
        if is_numeric(column.kind):
            words += cells  # a figure is one unbreakable token
        else:
            words += [w for text in cells for w in text.split()]
        widest = max((stringWidth(w, "Helvetica-Bold", 8.5) for w in words), default=0)
        floors.append(widest + pad)

    weights = [max(6, c.width) for c in columns]
    total = sum(weights) or 1
    widths = [avail * w / total for w in weights]
    for _ in range(4):
        short = sum(max(0.0, f - w) for f, w in zip(floors, widths))
        if short <= 0.5:
            break
        spare = [max(0.0, w - f) for f, w in zip(floors, widths)]
        pool = sum(spare)
        if pool <= 0:
            break
        take = min(short, pool)
        widths = [
            max(w, f) if f > w else w - take * (sp / pool)
            for f, w, sp in zip(floors, widths, spare)
        ]
    scale = avail / sum(widths)
    return [w * scale for w in widths]


def write(doc: ReportDoc, currency: str = "INR") -> bytes:
    """Render one report as `.pdf` bytes."""
    buffer = io.BytesIO()
    template = _Doc(
        buffer, doc,
        pagesize=landscape(A4) if doc.landscape else A4,
        leftMargin=_MARGIN, rightMargin=_MARGIN, topMargin=_MARGIN, bottomMargin=_MARGIN,
        title=f"{doc.brand} — {doc.module} — {doc.title}",
        author=doc.brand,
        subject=doc.scope_line,
    )
    portrait_w = A4[0] - 2 * _MARGIN
    landscape_w = landscape(A4)[0] - 2 * _MARGIN

    flow: list[Any] = [NextPageTemplate("landscape" if doc.landscape else "portrait")]
    current_landscape = doc.landscape
    avail = landscape_w if current_landscape else portrait_w

    # ---- page 1: cover ------------------------------------------------------
    flow += [
        Paragraph(_safe(doc.brand), _S["brand"]),
        Paragraph(_safe(doc.module), _S["module"]),
        Paragraph(_safe(doc.title), _S["title"]),
    ]
    cover = [("Generated", doc.generated_display), ("Scope", doc.scope_line)]
    if doc.headline:
        cover.append(("Status", doc.headline))
    # The status line in bold ink, not green or amber: the adapters' tone
    # follows one figure (the ROI status), and a green line reading "revenue
    # -3.87%" says the opposite of its own words.
    flow.append(_panel(
        _kv_rows(tuple(cover), 28 * mm, {"Status": "neutral"}),
        fill=_BRAND_TINT, line=_BRAND_LINE,
    ))

    if doc.empty_reason:
        flow += _heading("No data") + [Paragraph(_safe(doc.empty_reason), _S["body"])]

    # The KPIs lead the report; the filter and metadata bookkeeping follows
    # them, still on the cover.
    sections = list(doc.sections)
    lead = [s for s in sections[:1] if s.kind == "kpi" and s.items and not s.sheet
            and not s.landscape and not s.page_break]
    for section in lead:
        flow += _heading(section.title) + [_kpi_tiles(section, currency, avail)]
        if section.note:
            flow += [Spacer(1, 4), Paragraph(_safe(section.note), _S["small"])]
        sections.remove(section)

    if doc.filters:
        flow += _heading("Filters") + [_filter_grid(doc.filters, avail)]
    if doc.meta:
        flow += _heading("Report metadata") + [_kv_rows(doc.meta)]

    # ---- sections ----------------------------------------------------------
    for section in sections:
        # ONCE LANDSCAPE, STAY LANDSCAPE. A short section between two wide
        # tables used to flip back to portrait for a page of its own, leaving
        # three half-empty pages where one would do; prose and key/value
        # blocks read just as well across the wider frame.
        want_landscape = section.landscape or doc.landscape or current_landscape
        if want_landscape != current_landscape:
            flow.append(NextPageTemplate("landscape" if want_landscape else "portrait"))
            flow.append(PageBreak())
            current_landscape = want_landscape
            avail = landscape_w if current_landscape else portrait_w
        elif section.page_break:
            flow.append(PageBreak())

        heading = _heading(section.title)

        if section.kind == "kpi" and section.items:
            flow.append(KeepTogether(heading + [_kpi_tiles(section, currency, avail)]))
        elif section.kind == "table" and section.table is not None:
            flow += heading
            if section.table.title and section.table.title != section.title:
                flow.append(Paragraph(_safe(section.table.title), _S["subtitle"]))
            flow.append(_grid(section.table, currency, avail))
            if section.table.note:
                flow.append(Spacer(1, 4))
                flow.append(Paragraph(_safe(section.table.note), _S["small"]))
        elif section.kind == "text":
            flow += heading
            for paragraph in section.items:
                flow.append(Paragraph(_safe(str(paragraph)), _S["body"]))
        elif _is_stats(section):
            flow.append(KeepTogether(heading + [_stat_tiles(section, avail)]))
        else:
            flow.append(KeepTogether(heading + [_kv_rows(tuple(section.items))]))

        if section.note:
            flow.append(Spacer(1, 4))
            flow.append(Paragraph(_safe(section.note), _S["small"]))
        flow.append(Spacer(1, 6))

    # ---- disclaimers, last -------------------------------------------------
    if doc.disclaimers:
        flow.append(Spacer(1, 6))
        notes = PdfTable([[Paragraph(_safe(line), _S["small"])] for line in doc.disclaimers],
                         colWidths=[None], hAlign="LEFT")
        notes.setStyle(TableStyle([("LEFTPADDING", (0, 0), (-1, -1), 0),
                                   ("TOPPADDING", (0, 0), (-1, -1), 1),
                                   ("BOTTOMPADDING", (0, 0), (-1, -1), 1)]))
        flow.append(KeepTogether(_heading("Notes and data scope") + [_panel(notes)]))

    template.build(flow)
    return buffer.getvalue()
