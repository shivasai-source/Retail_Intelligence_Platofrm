"""The intermediate report document — ONE shape, two writers.

WHY THIS EXISTS. The brief asks for Excel and PDF from seven modules. Written
directly, that is fourteen bespoke generators, and the day one of them drifts is
the day the same report says two different things in two formats. So every
adapter builds ONE of these documents and the two writers render it:

    module adapter  ->  ReportDoc  ->  excel.write()   -> .xlsx bytes
                                   ->  pdf.write()     -> .pdf bytes

An adapter knows about promotions and KPIs and never about openpyxl or reportlab.
A writer knows about column widths and page breaks and never about ROI. Adding a
module is one adapter; changing how a currency renders is one line in each
writer.

THIS MODULE COMPUTES NOTHING. It is dataclasses and formatting metadata. Every
number it carries was produced by `app/tpo/*` and handed in.

VALUES ARE CARRIED RAW, WITH A KIND. A cell holds `9071892.0` and the column says
`currency`; it does not hold "₹90.7 L". That is what lets Excel receive a real
number it can sum and format, while the PDF receives the project's own display
string from `app/tpo/formatting.py`. Storing only the display string would give
Excel text that no one can total; storing only the number would make the PDF
invent its own formatting.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any, Literal

#: The brand every report carries, from the brief.
BRAND = "TPO INTELLIGENCE"

#: What a column holds, which decides its Excel number format, its alignment and
#: how the PDF stringifies it.
ColumnKind = Literal["text", "currency", "number", "units", "percent", "multiple", "date", "status"]

#: What a section is, which decides how a writer lays it out.
SectionKind = Literal["kv", "table", "text", "kpi"]


@dataclass(frozen=True)
class Column:
    """One column of one table."""

    key: str
    header: str
    kind: ColumnKind = "text"
    #: Approximate character width. The Excel writer uses it directly; the PDF
    #: writer uses it as a relative weight when it divides the page.
    width: int = 16


@dataclass(frozen=True)
class Table:
    """A grid of rows. `rows` are plain dicts keyed by `Column.key`.

    A MISSING KEY IS BLANK, NOT ZERO. A figure the engine could not produce must
    read as absent in the export exactly as it does on screen; writing 0 for it
    would turn "not measurable" into "measured as nothing".
    """

    columns: tuple[Column, ...]
    rows: tuple[dict[str, Any], ...]
    #: Shown above the grid, and used as the Excel sheet's section heading.
    title: str = ""
    #: Rendered under the table in small type. Provenance, caveats, counts.
    note: str = ""


@dataclass(frozen=True)
class KpiEntry:
    """One KPI card, as the Command Center displays it.

    THE DISPLAY STRING IS THE AUTHORITATIVE ONE. `display` is the card's own
    `display_value` — the exact text on screen — and a writer that shows text
    must show THAT, never a re-rendering of `value`. Re-formatting looks
    harmless and is not: `formatting.score` at one decimal turns the card's
    "66" into "66.0", which is precisely the precision drift a report must not
    introduce. The raw `value` is carried alongside for Excel, which needs a
    number it can sort and sum and applies its own format to it.

    Nothing here is recomputed. An adapter copies every field off the
    authoritative payload.
    """

    label: str
    value: float | None
    display: str
    kind: ColumnKind = "currency"
    previous: float | None = None
    previous_display: str = ""
    delta_display: str = ""
    delta_basis: str = ""
    trend: str = ""
    available: bool = True
    unavailable_reason: str = ""
    #: How much evidence stood behind the figure, where the card reports it.
    #: Cannibalization is the one that does.
    evidence: str = ""
    #: WHEN THE SELECTED SCOPE CANNOT SUPPORT THE FIGURE, the card still shows a
    #: measurement from the narrowest WIDER scope that can, and names that scope.
    #: The screen shows it; a report that dropped it would be showing less than
    #: the screen and would read as "no value exists".
    measured_at: str = ""


@dataclass(frozen=True)
class Section:
    """One block of the report, in the order it should appear."""

    title: str
    kind: SectionKind = "kv"
    #: kind="kv"   -> tuple[tuple[label, value], ...]
    #: kind="text" -> tuple[str, ...] (paragraphs)
    #: kind="kpi"  -> tuple[KpiEntry, ...]
    #: kind="table" -> unused; see `table`
    items: tuple[Any, ...] = ()
    table: Table | None = None
    #: Small print under the section.
    note: str = ""
    #: Excel only: force this section onto its own worksheet with this name.
    #: Sheet names are capped at 31 characters by the format itself.
    sheet: str = ""
    #: PDF only: start a new page before this section.
    page_break: bool = False
    #: PDF only: this section's table is wide and wants landscape.
    landscape: bool = False


@dataclass
class ReportDoc:
    """One report, ready to be written in either format."""

    #: "Command Center", "Simulation Studio — Target Rescue", ...
    module: str
    #: "Trade Promotion Performance Report"
    title: str
    #: ISO-8601 UTC, stamped by the service at request time.
    generated_at: str
    #: Human timestamp, e.g. "24 Aug 2026 · 12:42 PM".
    generated_display: str
    #: One line: "F25 · October · Modern Trade · Baby Care".
    scope_line: str
    #: The filter list, label -> value, every dimension named even when
    #: unconstrained so a reader never has to guess whether it was filtered or
    #: forgotten.
    filters: tuple[tuple[str, str], ...] = ()
    #: Report-level metadata: currency, data period, source description.
    meta: tuple[tuple[str, str], ...] = ()
    sections: tuple[Section, ...] = ()
    #: Module-relevant disclaimers only. Printed at the end of the PDF and on
    #: the Excel summary sheet.
    disclaimers: tuple[str, ...] = ()
    #: Filename WITHOUT extension, already sanitised by the service.
    filename_stem: str = "TPO_Report"
    #: Default page orientation for the PDF.
    landscape: bool = False
    #: Set when the module could produce no data. Writers render the reason
    #: instead of an empty grid that would read as a measured nothing.
    empty_reason: str = ""

    brand: str = BRAND
    #: Free-form extras an adapter wants on the cover, e.g. a status banner.
    headline: str = ""
    headline_tone: str = ""

    def with_sections(self, *sections: Section) -> "ReportDoc":
        self.sections = tuple(s for s in sections if s is not None)
        return self


# --- helpers shared by both writers -----------------------------------------


def excel_number_format(kind: ColumnKind, currency: str) -> str:
    """The Excel number format for one column kind.

    THE CURRENCY SYMBOL IS NOT HARD-CODED. It follows the currency the user had
    selected, which is the same one `app/tpo/formatting.py` renders with, so a
    USD session never produces a rupee-formatted workbook.
    """
    symbol = "$" if currency.upper() == "USD" else "₹"
    return {
        "currency": f'{symbol}#,##0.0;[Red]-{symbol}#,##0.0',
        "number": "#,##0.0",
        "units": "#,##0",
        "percent": '0.0"%";[Red]-0.0"%"',
        # The Promotion ROI: a bare multiple at two decimals (1.40). Red below
        # 1.00 would be the useful cue, but a number format can only colour on
        # sign, so it stays plain.
        "multiple": "0.00",
        "date": "dd mmm yyyy",
        "text": "@",
        "status": "@",
    }[kind]


def is_numeric(kind: ColumnKind) -> bool:
    return kind in ("currency", "number", "units", "percent", "multiple")
