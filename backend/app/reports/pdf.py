"""The PDF writer — one `ReportDoc` in, real `.pdf` bytes out.

A REAL PDF, via reportlab's platypus. Not HTML with the extension changed: what
comes out is a paginated document with a flowable frame, so tables break across
pages properly and headers repeat instead of being clipped.

IT KNOWS NOTHING ABOUT THE BUSINESS, for the same reason the Excel writer does
not — see excel.py. It walks the sections an adapter built.

VALUES ARRIVE RAW AND ARE RENDERED THROUGH THE PROJECT'S OWN FORMATTER. A
currency cell holds `9071892.0` and is printed by `app/tpo/formatting.money`,
which is the function the screen used — so the PDF carries the same figure in
the same currency the Command Center showed, rather than inventing a second
formatting rule. The one substitution is the rupee SYMBOL, which none of the
fonts available here can draw; see `_UNPRINTABLE`.

WIDE TABLES GET LANDSCAPE. A section can ask for it, and the document is built
in page templates so a landscape section genuinely re-frames rather than being
squeezed.
"""

from __future__ import annotations

import io
from typing import Any

from reportlab.lib import colors
from reportlab.lib.enums import TA_LEFT
from reportlab.lib.pagesizes import A4, landscape
from reportlab.lib.styles import ParagraphStyle, getSampleStyleSheet
from reportlab.lib.units import mm
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

from app.tpo import formatting as F

from app.reports.model import ReportDoc, Section, Table, is_numeric

_INK = colors.HexColor("#1A1F2E")
_MUTED = colors.HexColor("#6B7280")
_BRAND = colors.HexColor("#6B47FF")
_RULE = colors.HexColor("#E2E5EC")
_HEADER_BG = colors.HexColor("#F1F2F7")
_BAND = colors.HexColor("#FAFAFC")

_MARGIN = 14 * mm

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
    """Replace characters the base fonts cannot draw. See `_UNPRINTABLE`."""
    for bad, good in _UNPRINTABLE.items():
        text = text.replace(bad, good)
    return text

_base = getSampleStyleSheet()
_S = {
    "brand": ParagraphStyle("brand", parent=_base["Normal"], fontName="Helvetica-Bold",
                            fontSize=9, textColor=_BRAND, spaceAfter=2, leading=11),
    "module": ParagraphStyle("module", parent=_base["Normal"], fontName="Helvetica",
                             fontSize=11, textColor=_MUTED, spaceAfter=2, leading=14),
    "title": ParagraphStyle("title", parent=_base["Normal"], fontName="Helvetica-Bold",
                            fontSize=20, textColor=_INK, spaceAfter=10, leading=24),
    "h2": ParagraphStyle("h2", parent=_base["Normal"], fontName="Helvetica-Bold",
                         fontSize=12, textColor=_INK, spaceBefore=10, spaceAfter=5, leading=15),
    "label": ParagraphStyle("label", parent=_base["Normal"], fontName="Helvetica",
                            fontSize=8.5, textColor=_MUTED, leading=11),
    "value": ParagraphStyle("value", parent=_base["Normal"], fontName="Helvetica",
                            fontSize=9.5, textColor=_INK, leading=13),
    "valueb": ParagraphStyle("valueb", parent=_base["Normal"], fontName="Helvetica-Bold",
                             fontSize=9.5, textColor=_INK, leading=13),
    "body": ParagraphStyle("body", parent=_base["Normal"], fontName="Helvetica",
                           fontSize=9.5, textColor=_INK, leading=14, spaceAfter=5,
                           alignment=TA_LEFT),
    "small": ParagraphStyle("small", parent=_base["Normal"], fontName="Helvetica",
                            fontSize=8, textColor=_MUTED, leading=11, spaceAfter=3),
    "cell": ParagraphStyle("cell", parent=_base["Normal"], fontName="Helvetica",
                           fontSize=8, textColor=_INK, leading=10),
    "cellb": ParagraphStyle("cellb", parent=_base["Normal"], fontName="Helvetica-Bold",
                            fontSize=8, textColor=_INK, leading=10),
    "cellr": ParagraphStyle("cellr", parent=_base["Normal"], fontName="Helvetica",
                            fontSize=8, textColor=_INK, leading=10, alignment=2),
}


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
    generic table renderer uses: the Command Center prints PEI as "66", so the
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
    """Page furniture: the brand line, the running footer and page numbers.

    The footer carries the module, the scope and `page N of M` on every page,
    which is what makes a printed extract self-describing when it is separated
    from its first page.
    """

    def __init__(self, buffer: io.BytesIO, doc: ReportDoc, **kw: Any) -> None:
        super().__init__(buffer, **kw)
        self._doc = doc
        portrait_frame = Frame(_MARGIN, _MARGIN + 9 * mm,
                               A4[0] - 2 * _MARGIN, A4[1] - 2 * _MARGIN - 9 * mm, id="p")
        land = landscape(A4)
        landscape_frame = Frame(_MARGIN, _MARGIN + 9 * mm,
                                land[0] - 2 * _MARGIN, land[1] - 2 * _MARGIN - 9 * mm, id="l")
        self.addPageTemplates([
            PageTemplate(id="portrait", frames=[portrait_frame], pagesize=A4,
                         onPage=self._furniture),
            PageTemplate(id="landscape", frames=[landscape_frame], pagesize=land,
                         onPage=self._furniture),
        ])

    def _furniture(self, canvas: Any, doc: Any) -> None:
        canvas.saveState()
        width, _ = canvas._pagesize
        y = _MARGIN + 4 * mm
        canvas.setStrokeColor(_RULE)
        canvas.setLineWidth(0.5)
        canvas.line(_MARGIN, y + 4 * mm, width - _MARGIN, y + 4 * mm)
        canvas.setFont("Helvetica", 7.5)
        canvas.setFillColor(_MUTED)
        left = f"{self._doc.brand} · {self._doc.module}"
        canvas.drawString(_MARGIN, y, _safe(left)[:120])
        canvas.drawRightString(width - _MARGIN, y, f"Page {canvas.getPageNumber()}")
        scope = self._doc.scope_line
        if scope:
            canvas.drawCentredString(width / 2, y, _safe(scope)[:90])
        canvas.restoreState()


def _kv_rows(pairs: tuple[tuple[str, str], ...]) -> PdfTable:
    data = [[Paragraph(_safe(str(k)), _S["label"]), Paragraph(_safe(str(v)), _S["value"])]
            for k, v in pairs]
    table = PdfTable(data, colWidths=[46 * mm, None], hAlign="LEFT")
    table.setStyle(TableStyle([
        ("VALIGN", (0, 0), (-1, -1), "TOP"),
        ("TOPPADDING", (0, 0), (-1, -1), 2),
        ("BOTTOMPADDING", (0, 0), (-1, -1), 2),
        ("LEFTPADDING", (0, 0), (-1, -1), 0),
    ]))
    return table


def _grid(table: Table, currency: str, avail: float) -> PdfTable:
    """One table, sized to the frame and styled to repeat its header."""
    header = [Paragraph(_safe(c.header), _S["cellb"]) for c in table.columns]
    body = []
    for record in table.rows:
        line = []
        for column in table.columns:
            value = record.get(column.key)
            text = _display(value, column.kind, currency)
            style = _S["cellr"] if is_numeric(column.kind) else _S["cell"]
            line.append(Paragraph(text, style))
        body.append(line)

    weights = [max(6, c.width) for c in table.columns]
    total = sum(weights) or 1
    widths = [avail * (w / total) for w in weights]

    grid = PdfTable([header] + body, colWidths=widths, repeatRows=1, hAlign="LEFT")
    style = [
        ("BACKGROUND", (0, 0), (-1, 0), _HEADER_BG),
        ("LINEBELOW", (0, 0), (-1, 0), 0.6, _RULE),
        ("GRID", (0, 0), (-1, -1), 0.25, _RULE),
        ("VALIGN", (0, 0), (-1, -1), "TOP"),
        ("TOPPADDING", (0, 0), (-1, -1), 3),
        ("BOTTOMPADDING", (0, 0), (-1, -1), 3),
        ("LEFTPADDING", (0, 0), (-1, -1), 4),
        ("RIGHTPADDING", (0, 0), (-1, -1), 4),
    ]
    for i in range(1, len(body) + 1):
        if i % 2 == 0:
            style.append(("BACKGROUND", (0, i), (-1, i), _BAND))
    grid.setStyle(TableStyle(style))
    return grid


def _kpi_grid(section: Section, currency: str, avail: float) -> PdfTable:
    columns = ("KPI", "Value", "Previous", "Delta", "Trend", "Basis / evidence")
    header = [Paragraph(_safe(c), _S["cellb"]) for c in columns]
    body = []
    for e in section.items:
        # THE CARD'S OWN DISPLAY STRING, not a re-rendering of the raw value.
        # `formatting.score` at one decimal would print the screen's "66" as
        # "66.0"; a report must not introduce that drift. See model.KpiEntry.
        if e.available and e.display:
            value = e.display
        elif e.available and e.value is not None:
            value = _display(e.value, e.kind, currency)
        else:
            value = e.unavailable_reason or "Not available"

        # WHAT THE TILE SHOWS UNDERNEATH: the comparison basis, the evidence
        # count, or — when this scope cannot support the figure — the wider
        # scope's measurement the screen falls back to. Dropping the last one is
        # what made a report look like it was missing a KPI the screen had.
        # EITHER the wider-scope fallback OR this scope's own basis and evidence,
        # never both — the tile shows one or the other, and appending this
        # selection's "0 comparable events" behind a wider scope's 144 would be
        # two counts of two different populations side by side.
        basis = (
            e.measured_at
            if e.measured_at
            else " · ".join(x for x in (e.delta_basis, e.evidence) if x)
        )

        body.append([
            Paragraph(_safe(e.label), _S["cellb"]),
            Paragraph(_safe(value), _S["cellr"] if e.available else _S["cell"]),
            Paragraph(
                _safe(e.previous_display or _kpi_number(e.previous, e.kind, currency)),
                _S["cellr"],
            ),
            Paragraph(_safe(e.delta_display or "—"), _S["cellr"]),
            Paragraph(_safe(e.trend or "—"), _S["cell"]),
            Paragraph(_safe(basis or "—"), _S["cell"]),
        ])
    weights = [24, 17, 16, 11, 9, 30]
    total = sum(weights)
    grid = PdfTable([header] + body, colWidths=[avail * w / total for w in weights],
                    repeatRows=1, hAlign="LEFT")
    grid.setStyle(TableStyle([
        ("BACKGROUND", (0, 0), (-1, 0), _HEADER_BG),
        ("GRID", (0, 0), (-1, -1), 0.25, _RULE),
        ("VALIGN", (0, 0), (-1, -1), "TOP"),
        ("TOPPADDING", (0, 0), (-1, -1), 4),
        ("BOTTOMPADDING", (0, 0), (-1, -1), 4),
    ]))
    return grid


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

    # ---- page 1: cover + executive summary ---------------------------------
    flow += [
        Paragraph(_safe(doc.brand), _S["brand"]),
        Paragraph(_safe(doc.module), _S["module"]),
        Paragraph(_safe(doc.title), _S["title"]),
    ]
    cover = [("Generated", doc.generated_display), ("Scope", doc.scope_line)]
    if doc.headline:
        cover.append(("Status", doc.headline))
    flow.append(_kv_rows(tuple(cover)))

    if doc.empty_reason:
        flow += [Paragraph("No data", _S["h2"]), Paragraph(_safe(doc.empty_reason), _S["body"])]

    if doc.filters:
        flow += [Paragraph("Filters", _S["h2"]), _kv_rows(doc.filters)]
    if doc.meta:
        flow += [Paragraph("Report metadata", _S["h2"]), _kv_rows(doc.meta)]

    # ---- sections ----------------------------------------------------------
    for section in doc.sections:
        want_landscape = section.landscape or doc.landscape
        if want_landscape != current_landscape:
            flow.append(NextPageTemplate("landscape" if want_landscape else "portrait"))
            flow.append(PageBreak())
            current_landscape = want_landscape
            avail = landscape_w if current_landscape else portrait_w
        elif section.page_break:
            flow.append(PageBreak())

        heading = Paragraph(_safe(section.title), _S["h2"])

        if section.kind == "kpi" and section.items:
            flow.append(KeepTogether([heading, _kpi_grid(section, currency, avail)]))
        elif section.kind == "table" and section.table is not None:
            flow.append(heading)
            if section.table.title and section.table.title != section.title:
                flow.append(Paragraph(_safe(section.table.title), _S["small"]))
            flow.append(_grid(section.table, currency, avail))
            if section.table.note:
                flow.append(Spacer(1, 3))
                flow.append(Paragraph(_safe(section.table.note), _S["small"]))
        elif section.kind == "text":
            flow.append(heading)
            for paragraph in section.items:
                flow.append(Paragraph(_safe(str(paragraph)), _S["body"]))
        else:
            flow.append(KeepTogether([heading, _kv_rows(tuple(section.items))]))

        if section.note:
            flow.append(Spacer(1, 3))
            flow.append(Paragraph(_safe(section.note), _S["small"]))
        flow.append(Spacer(1, 6))

    # ---- disclaimers, last -------------------------------------------------
    if doc.disclaimers:
        flow.append(Spacer(1, 8))
        flow.append(Paragraph("Notes and data scope", _S["h2"]))
        for line in doc.disclaimers:
            flow.append(Paragraph(_safe(line), _S["small"]))

    template.build(flow)
    return buffer.getvalue()
