"""Report Center adapter for the MMM Insights Hub (module key `mmm-insights`).

Same framework as every TPO report (app/reports): this builds ONE ReportDoc
from the SAME payload the hub renders (`service.hub`), and the shared writers
turn it into .xlsx and .pdf. Nothing is recomputed here.

MMM has no TPO filter dimensions, so the report's `scope` is empty. The MMM
filters travel in `options["filters"]`, as app/mmm/scope.py#from_options reads
them. The older `options["year"]` is still read when `filters` is absent.
"""

from __future__ import annotations

from typing import Any

from app.mmm import service
from app.mmm.scope import EVENTS, Scope, from_options
from app.reports.model import Column, KpiEntry, ReportDoc, Section, Table

BRAND = "MMM INTELLIGENCE"

DISCLAIMER = (
    "Revenue and ad spend are sums of the uploaded daily MMM dataset. Baseline Revenue, "
    "Incremental Revenue and ROAS are estimates: the baseline per day is R − (X − Y), "
    "re-estimated over the selected range (see the Baseline section)."
)

_KIND = {"currency": "currency", "percent": "percent", "count": "units", "multiple": "multiple"}


def year_option(options: dict[str, Any]) -> int | None:
    year = options.get("year")
    if year in (None, "", "all"):
        return None
    if isinstance(year, bool) or not isinstance(year, int):
        raise ValueError(f"options.year must be a whole number or null, not {year!r}.")
    return year


def scope_of(options: dict[str, Any]) -> Scope:
    if options.get("filters") is not None:
        if not isinstance(options["filters"], dict):
            raise ValueError("options.filters must be an object.")
        return from_options(options["filters"])
    return Scope.build(year=year_option(options))


def _filter_lines(scope: Scope) -> tuple[tuple[str, str], ...]:
    lines: list[tuple[str, str]] = []
    if scope.custom:
        lines.append(("Date range", f"{scope.date_from or 'start'} to {scope.date_to or 'end'}"))
    else:
        lines.append(("Year", str(scope.year) if scope.year else "All years"))
        if scope.quarter:
            lines.append(("Quarter", f"Q{scope.quarter}"))
        if scope.month:
            lines.append(("Month", service.MONTH_NAMES[scope.month - 1]))
        if scope.week:
            lines.append(("Week", str(scope.week)))
    if scope.channels:
        lines.append(("Channels", ", ".join(scope.channels)))
    if scope.promotion_types:
        lines.append(("Promotion type", ", ".join(scope.promotion_types)))
    if scope.events:
        lines.append(("Event day", ", ".join(EVENTS[e] for e in scope.events)))
    return tuple(lines)


def build(_state: Any, currency: str, options: dict[str, Any]) -> ReportDoc:
    scope = scope_of(options)
    payload = service.hub(scope, "month", currency)
    meta = payload["meta"]
    filters = _filter_lines(scope)
    scope_line = " · ".join(v for _k, v in filters)

    kpis = tuple(
        KpiEntry(
            label=k["label"], value=k["value"], display=k["display"],
            kind=_KIND.get(k["kind"], "number"),
            previous=k["previous"], delta_display=k["delta_display"],
            delta_basis=k["comparison"],
        )
        for k in payload["kpis"]
    )

    channels = Table(
        title="Media spend by channel",
        columns=(
            Column("label", "Channel", "text", 28),
            Column("family", "Family", "text", 24),
            Column("spend", "Spend", "currency", 16),
            Column("share", "Share of spend", "percent", 14),
            Column("active_days", "Days on air", "units", 12),
            Column("avg_active_day", "Avg spend / day on air", "currency", 18),
        ),
        rows=tuple(payload["channels"]),
        note="Sorted by spend. Share is of total media spend in scope.",
    )

    trend = Table(
        title="Revenue, ad spend, baseline and ROAS",
        columns=(
            Column("period", "Period", "text", 14),
            Column("revenue", "Revenue", "currency", 18),
            Column("spend", "Ad spend", "currency", 18),
            Column("baseline", "Baseline revenue", "currency", 18),
            Column("roas", "ROAS", "multiple", 10),
        ),
        rows=tuple(
            {"period": p, "revenue": r, "spend": s, "baseline": b, "roas": x}
            for p, r, s, b, x in zip(payload["trend"]["labels"], payload["trend"]["revenue"],
                                     payload["trend"]["spend"], payload["trend"]["baseline"],
                                     payload["trend"]["roas"])
        ),
        note="Each period's baseline is estimated over that period's own days.",
    )

    base = payload["baseline"]
    baseline_items = (
        ("X — ad spend, all three event flags", f"{base['x_display']} / day ({base['days']['x']} days)"),
        ("Y — no ad spend, all three event flags", f"{base['y_display']} / day ({base['days']['y']} days)"),
        ("Z = X − Y — revenue from ad spend", f"{base['z_display']} / day"),
        ("R — ad spend, no event flags", f"{base['r_display']} / day ({base['days']['r']} days)"),
        ("Baseline per day = R − Z", base["per_day_display"]),
        ("Baseline revenue", f"{base['total_display']} ({base['scope_days']:,} days)"),
        ("Estimated over", base["window"]["label"] + (" (widened to find every kind of day)"
                                                      if base["widened"] else "")),
    ) if base["available"] else (("Baseline", base["reason"]),)

    sections = [
        Section("Headline figures", "kpi", items=kpis),
        Section("Scope", "kv", items=(
            ("Period", meta["period_label"]),
            ("Days", f"{meta['days']:,}"),
            ("Media channels", f"{meta['channels']} of {meta['channels_total']}"),
            ("Comparison", meta["comparison"] or "None — no matching earlier period"),
        )),
        Section("Baseline", "kv", items=baseline_items),
        Section("Media spend by channel", "table", table=channels, sheet="Channels"),
        Section("Monthly trend", "table", table=trend, sheet="Monthly Trend"),
    ]

    if payload["promotions"]:
        sections.append(Section("Promotions", "table", sheet="Promotions", table=Table(
            title="Revenue by promotion type",
            columns=(
                Column("type", "Promotion type", "text", 22),
                Column("days", "Days", "units", 10),
                Column("share_of_days", "Share of days", "percent", 14),
                Column("revenue", "Revenue", "currency", 18),
                Column("avg_revenue", "Avg daily revenue", "currency", 18),
            ),
            rows=tuple(payload["promotions"]),
            note="Average daily revenue on days that offer ran. Offers do not run on random "
                 "days, so this is not the effect of the offer.",
        )))

    sections.append(Section("Days with and without events", "table", sheet="Events", table=Table(
        title="Average daily revenue, days with vs without each event",
        columns=(
            Column("label", "Event", "text", 16),
            Column("with_days", "Days with", "units", 10),
            Column("with_avg", "Avg revenue with", "currency", 18),
            Column("without_days", "Days without", "units", 12),
            Column("without_avg", "Avg revenue without", "currency", 18),
            Column("difference", "Difference", "percent", 12),
        ),
        rows=tuple(payload["events"]),
        note="A comparison of averages. Other factors differ between these days too.",
    )))

    doc = ReportDoc(
        module="MMM Insights Hub",
        title="Marketing Mix Performance Report",
        generated_at="",
        generated_display="",
        scope_line=scope_line,
        filters=(*filters, ("Currency", meta["currency"])),
        meta=(("Source", "Uploaded MMM daily dataset"), ("Period", meta["period_label"])),
        disclaimers=(DISCLAIMER,),
        brand=BRAND,
    )
    return doc.with_sections(*sections)
