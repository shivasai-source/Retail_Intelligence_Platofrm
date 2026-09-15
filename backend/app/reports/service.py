"""The report service — module registry, filenames, and the one dispatch point.

    request (module, format, scope, options)
        -> the module's adapter, which calls the SAME service the screen calls
        -> ReportDoc
        -> excel.write() / pdf.write()
        -> bytes + filename + media type

ONE FRAMEWORK, MODULE ADAPTERS. Adding a module is an entry in `MODULES` and a
function in adapters.py; it is never a new file-generation path. Adding a format
would be one writer, not one writer per module.

NOTHING HERE COMPUTES A BUSINESS FIGURE. This module resolves a scope into the
project's one `FilterState`, stamps a timestamp, picks a filename and calls a
writer.
"""

from __future__ import annotations

import re
from dataclasses import dataclass
from datetime import datetime, timezone
from typing import Any, Callable

from app.tpo import formatting as F
from app.tpo.filters import DIMENSIONS, FilterState
from app.tpo.loader import MONTHS, get_store

from app.reports import adapters, excel, pdf
from app.reports.model import ReportDoc
from app.store import reports as report_store

XLSX_MEDIA = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
PDF_MEDIA = "application/pdf"

FORMATS = ("xlsx", "pdf")


class UnsupportedModule(ValueError):
    """A module key the registry does not carry."""


class ReportUnavailable(ValueError):
    """The module is supported but this request cannot produce a report.

    Distinct from an internal failure: the caller is missing an input, or the
    scope holds nothing. Surfaced as a 422 with the reason, never as an
    empty-looking file that would read as a measured nothing.
    """


@dataclass(frozen=True)
class Module:
    """One exportable module."""

    key: str
    label: str
    #: (state, currency, options) -> ReportDoc
    build: Callable[[FilterState, str, dict[str, Any]], ReportDoc]
    #: Filename stem prefix, e.g. "TPO_Insights_Hub".
    stem: str
    #: Appended to the stem from the scope, e.g. the year or the mode.
    scoped_stem: bool = True


#: THE REGISTRY. Only modules with a real, computed source of truth are here.
#: Purely administrative screens are deliberately absent — the brief rules out
#: export controls with no reportable dataset behind them, and Settings and Data
#: Connections have none.
MODULES: dict[str, Module] = {
    "command-center": Module(
        "command-center", "Insights Hub", adapters.command_center, "TPO_Insights_Hub"),
    "simulation-investigation": Module(
        "simulation-investigation", "Simulation Studio — Investigation Simulation",
        adapters.simulation_investigation, "TPO_Simulation_Investigation"),
    "simulation-general-optimization": Module(
        "simulation-general-optimization", "Simulation Studio — General Optimization",
        adapters.simulation_general_optimization, "TPO_Simulation_General_Optimization"),
    "simulation-target-rescue": Module(
        "simulation-target-rescue", "Simulation Studio — Target Rescue",
        adapters.simulation_target_rescue, "TPO_Simulation_Target_Rescue"),
    "decision-center": Module(
        "decision-center", "Decision Center", adapters.decision_center, "TPO_Decision_Record"),
}


def module_keys() -> list[str]:
    return sorted(MODULES)


# --- scope ------------------------------------------------------------------


def to_state(scope: dict[str, Any]) -> FilterState:
    """The scope dict -> the project's ONE `FilterState`.

    AN UNKNOWN KEY IS REJECTED, NOT DROPPED. Silently ignoring `regionn` would
    hand back a report over a WIDER scope than the caller asked for, and it would
    look successful -- the worst kind of wrong answer for an export. The caller is
    told which key it got wrong.

    A BADLY TYPED VALUE IS REJECTED HERE TOO, for a duller reason: `year` and
    `month` are scalars on `FilterState`, and JSON has no way to say so. A caller
    that sends `{"month": [6]}` would otherwise build a state holding a list,
    which only fails much later inside a cached lookup -- as an unhashable-type
    TypeError, i.e. a 500 on what is really a malformed request. Every rejection
    from this function is a 422 naming the key at fault.
    """
    unknown = sorted(set(scope) - set(DIMENSIONS))
    if unknown:
        raise ValueError(
            f"Unknown filter dimension(s) in scope: {', '.join(unknown)}. "
            f"This project filters on: {', '.join(DIMENSIONS)}."
        )

    period = {}
    for key in ("year", "month"):
        value = scope.get(key)
        if value is None:
            continue
        # bool is an int in Python and would pass silently as year 1.
        if isinstance(value, bool) or not isinstance(value, int):
            raise ValueError(
                f"Scope '{key}' must be a single whole number, not "
                f"{type(value).__name__}. Received: {value!r}."
            )
        period[key] = value

    lists = {k: v for k, v in scope.items() if k not in ("year", "month")}
    for key, value in lists.items():
        if value is None or isinstance(value, (list, tuple, set, frozenset)):
            continue
        raise ValueError(
            f"Scope '{key}' must be a list of values, not {type(value).__name__}. "
            f"Received: {value!r}."
        )

    return FilterState.build(**period, **lists)


# --- filenames ---------------------------------------------------------------

_UNSAFE = re.compile(r'[<>:"/\\|?*\x00-\x1f]')
_COLLAPSE = re.compile(r"_+")
#: A bare 32/36-character hex-ish run: a raw identifier nobody wants in a
#: filename, and the brief rules them out by name.
_UUIDISH = re.compile(r"\b[0-9a-fA-F]{8}-?[0-9a-fA-F]{4}-?[0-9a-fA-F]{4}-?"
                      r"[0-9a-fA-F]{4}-?[0-9a-fA-F]{12}\b")


def sanitize(part: str) -> str:
    """One filename fragment: safe characters only, no raw identifiers."""
    text = _UUIDISH.sub("", str(part))
    text = _UNSAFE.sub("", text)
    text = re.sub(r"[^\w.\-]+", "_", text, flags=re.UNICODE)
    text = _COLLAPSE.sub("_", text).strip("._-")
    return text[:60]


def filename(module: Module, state: FilterState, extension: str,
             options: dict[str, Any]) -> str:
    """A predictable, sanitised filename.

    Shaped from what the reader actually chose — the period, and the one
    narrowing that matters most for the module — so two exports of two different
    scopes never collide in a Downloads folder.
    """
    parts = [module.stem]
    if module.scoped_stem:
        if state.year:
            parts.append(str(state.year))
        if state.month:
            parts.append(MONTHS[state.month - 1][:3])
        # THE CHANNEL TOO, when one is selected. Without it two exports of the
        # same month for two different channels land on the same name and the
        # browser silently suffixes "(1)" -- which is exactly the moment a reader
        # loses track of which file describes which channel.
        if state.channel:
            store = get_store()
            names = [
                store.dims.channels[c].name if c in store.dims.channels else c
                for c in sorted(state.channel)
            ]
            parts.append(names[0] if len(names) == 1 else f"{len(names)}_channels")
        label = options.get("filename_hint")
        if label:
            parts.append(sanitize(label))
    stem = "_".join(p for p in (sanitize(x) for x in parts) if p) or "TPO_Report"
    return f"{stem}.{extension}"


# --- dispatch ----------------------------------------------------------------


def _stamp(doc: ReportDoc, now: datetime) -> None:
    doc.generated_at = now.isoformat(timespec="seconds")
    # "24 Aug 2026 · 12:42 PM", the brief's own format.
    doc.generated_display = now.strftime("%d %b %Y · %I:%M %p").replace(" 0", " ")


def build(module_key: str, fmt: str, scope: dict[str, Any], options: dict[str, Any],
          currency: str = "INR", now: datetime | None = None) -> tuple[bytes, str, str]:
    """Produce one report's bytes. Returns `(bytes, filename, media type)`.

    INTERNAL. No route answers with what this returns any more: a report is
    generated into the Report Center by `generate` below, and bytes reach a
    browser only from the Report Center's own download route. This remains as the
    shared build-one-format primitive, and as the seam the tests exercise a
    single format through.

    Raises `UnsupportedModule` for an unknown module, `ValueError` for an
    unsupported format, and `ReportUnavailable` when the adapter cannot build a
    report from what it was given.
    """
    module = MODULES.get(module_key)
    if module is None:
        raise UnsupportedModule(
            f"'{module_key}' has no report. Exportable modules: {', '.join(module_keys())}."
        )
    if fmt not in FORMATS:
        raise ValueError(f"'{fmt}' is not a report format. Supported: {', '.join(FORMATS)}.")

    currency = F.normalise_currency(currency)
    state = to_state(scope)

    try:
        doc = module.build(state, currency, options or {})
    except ValueError as exc:
        # An adapter raising ValueError is saying "I was not given enough to
        # report on" -- a 422 with the reason, not a 500 and not a blank file.
        raise ReportUnavailable(str(exc)) from exc

    doc.module = doc.module or module.label
    _stamp(doc, now or datetime.now(timezone.utc).astimezone())
    doc.filename_stem = module.stem

    if fmt == "xlsx":
        return excel.write(doc, currency), filename(module, state, "xlsx", options), XLSX_MEDIA
    return pdf.write(doc, currency), filename(module, state, "pdf", options), PDF_MEDIA


# --- the Report Center -------------------------------------------------------
#
# GENERATE IS NOT DOWNLOAD. `build` above returns bytes to whoever asked; the
# function below stores them in the Report Center and returns METADATA. Nothing
# in this path hands a file to a browser -- that happens only when someone later
# asks for one report's artifact by id.


#: A readable report name, per module. Deliberately not the filename: a person
#: scanning a library reads "TPO Insights Hub — October F25 · Modern Trade",
#: not "TPO_Insights_Hub_2025_Oct_Modern_Trade.xlsx".
def report_name(module: Module, doc: ReportDoc) -> str:
    return f"{module.label} — {doc.scope_line}" if doc.scope_line else module.label


def _preview(doc: ReportDoc) -> dict[str, Any]:
    """A small, self-contained summary for the in-app View.

    STORED, NOT RECOMPUTED ON VIEW. Re-running the module when someone opens a
    report would show them TODAY's numbers under YESTERDAY's report -- the
    library would quietly disagree with the artifacts it is listing. So the
    figures the report was generated with are kept beside it.

    Only what a reader needs to confirm the report is the right one: the
    headline, the KPI lines, and the first recommendation-ish text block. Not the
    whole document -- that is what the artifacts are for.
    """
    kpis: list[dict[str, Any]] = []
    highlights: list[dict[str, str]] = []
    narrative: list[str] = []

    for section in doc.sections:
        if section.kind == "kpi":
            for entry in section.items:
                kpis.append({
                    "label": entry.label,
                    "display": entry.display or (entry.unavailable_reason or "—"),
                    "previous_display": entry.previous_display,
                    "delta_display": entry.delta_display,
                    "trend": entry.trend,
                    "available": entry.available,
                    "basis": entry.measured_at or entry.delta_basis,
                })
        elif section.kind == "kv" and not highlights:
            highlights = [
                {"label": str(k), "value": str(v)} for k, v in section.items[:8]
            ]
        elif section.kind == "text" and not narrative:
            narrative = [str(p) for p in section.items[:4]]

    return {
        "module": doc.module,
        "title": doc.title,
        "scope_line": doc.scope_line,
        "generated_display": doc.generated_display,
        "headline": doc.headline,
        "headline_tone": doc.headline_tone,
        "kpis": kpis,
        "highlights": highlights,
        "narrative": narrative,
        "empty_reason": doc.empty_reason,
        "disclaimers": list(doc.disclaimers),
    }


def generate(module_key: str, scope: dict[str, Any], options: dict[str, Any],
             currency: str = "INR", formats: tuple[str, ...] = FORMATS,
             now: datetime | None = None) -> str:
    """Generate one report into the Report Center and return its `report_id`.

    THE ORDER MATTERS. A row is opened GENERATING first, so a failure leaves a
    FAILED report with its reason in the library rather than nothing at all. The
    document is built ONCE and written in both formats from it -- two builds
    could disagree, and would run the authoritative service twice for one report.

    Returns the id. It does NOT return bytes: this is the generate half of the
    workflow, and handing a file back here is what made the old behaviour
    download on click.
    """
    module = MODULES.get(module_key)
    if module is None:
        raise UnsupportedModule(
            f"'{module_key}' has no report. Exportable modules: {', '.join(module_keys())}."
        )
    wanted = tuple(f for f in formats if f in FORMATS) or FORMATS

    currency = F.normalise_currency(currency)
    state = to_state(scope)

    # Built before the row is opened: a malformed scope is a rejected REQUEST,
    # not a failed report, and should not leave a FAILED row behind.
    try:
        doc = module.build(state, currency, options or {})
    except ValueError as exc:
        raise ReportUnavailable(str(exc)) from exc

    doc.module = doc.module or module.label
    _stamp(doc, now or datetime.now(timezone.utc).astimezone())
    doc.filename_stem = module.stem

    report_id = report_store.begin(
        module=module.key,
        module_label=module.label,
        name=report_name(module, doc),
        title=doc.title,
        scope_label=doc.scope_line,
        scope=scope,
        options=_safe_options(options or {}),
        currency=currency,
    )

    try:
        artifacts: dict[str, tuple[str, bytes]] = {}
        if "xlsx" in wanted:
            artifacts["xlsx"] = (
                filename(module, state, "xlsx", options or {}),
                excel.write(doc, currency),
            )
        if "pdf" in wanted:
            artifacts["pdf"] = (
                filename(module, state, "pdf", options or {}),
                pdf.write(doc, currency),
            )
    except Exception as exc:  # noqa: BLE001 - recorded on the row, not swallowed
        report_store.fail(report_id, f"{type(exc).__name__}: {exc}")
        raise

    report_store.finish(
        report_id,
        artifacts=artifacts,
        filters=[[label, value] for label, value in doc.filters],
        preview=_preview(doc),
    )
    return report_id


#: Option keys that must never be persisted with a report. The report options a
#: module needs are plain control values; anything that looks like a credential
#: is dropped rather than stored, even though no caller sends one today.
_SENSITIVE = ("password", "token", "secret", "authorization", "auth", "api_key",
              "apikey", "cookie", "session")


def _safe_options(options: dict[str, Any]) -> dict[str, Any]:
    """The module's control values, minus anything credential-shaped.

    A report is stored and later read back by whoever opens the library, so what
    goes into it is a data-safety decision and not just a tidiness one.
    """
    return {
        k: v for k, v in options.items()
        if not any(marker in k.lower() for marker in _SENSITIVE)
    }
