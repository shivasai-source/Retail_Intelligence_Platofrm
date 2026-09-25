"""Module adapters — one authoritative result, one `ReportDoc`.

THE ONE ARCHITECTURAL RULE THIS FILE EXISTS TO ENFORCE. An adapter receives a
SCOPE (a `FilterState` plus whatever control values the screen was set to) and
calls the SAME service function the screen's own endpoint calls. It then copies
figures across. It never computes one.

    app/tpo/*  ->  the endpoint the screen used   ->  the screen
               ->  the adapter below              ->  ReportDoc -> xlsx / pdf

So the export cannot disagree with the screen: both are downstream of the same
call. Nothing here divides, multiplies or compares two KPIs to derive a third —
grep this file for arithmetic and you will find rounding for display and nothing
else.

WHY THE SCOPE TRAVELS AND THE RESULTS DO NOT. The client posts what it SELECTED,
not what it was shown. That is deliberate: a client that posted its own numbers
could put anything in a report carrying this project's name, and no amount of
review would catch it. Posting the scope and re-running the authoritative service
makes a fabricated figure impossible by construction.

WHAT IS NOT EXPORTED. Debug blocks, internal ids that mean nothing to a reader,
and anything a screen does not itself show. See `service.py` for the module
registry and the filename rules.
"""

from __future__ import annotations

from typing import Any

from app.tpo import decision as decision_service
from app.tpo import formatting as F, service, studio
from app.tpo.filters import DIMENSIONS, FilterState
from app.tpo.loader import MONTHS, get_store

from app.reports.model import Column, KpiEntry, ReportDoc, Section, Table

# --- shared scope description -----------------------------------------------

#: Every filter dimension, in the order a reader expects, with the label the
#: application uses for it. Read from `filters.DIMENSIONS` so a dimension added
#: there cannot silently vanish from a report's Filters block.
_DIMENSION_LABELS: dict[str, str] = {
    "year": "Year",
    "month": "Month",
    "channel": "Channel",
    "retailer": "Retailer",
    "region": "Region",
    "state": "State",
    "city": "City",
    "tier": "Tier",
    "distributor": "Distributor",
    "category": "Category",
    "brand": "Brand form",
    "product": "Product",
    "promotion": "Promotion",
    "promotion_type": "Promotion type",
}
assert set(_DIMENSION_LABELS) == set(DIMENSIONS), "a filter dimension has no report label"


def _channel_names(codes: list[str]) -> str:
    store = get_store()
    return ", ".join(
        store.dims.channels[c].name if c in store.dims.channels else c for c in codes
    )


def _product_names(codes: list[str]) -> str:
    store = get_store()
    names = [
        store.dims.products[p].name.strip() if p in store.dims.products else p for p in codes
    ]
    return ", ".join(names) if len(names) <= 3 else f"{len(names)} products"


def _promotion_names(codes: list[str]) -> str:
    store = get_store()
    return ", ".join(
        store.dims.promotions[p].label if p in store.dims.promotions else p for p in codes
    )


def filter_rows(state: FilterState) -> tuple[tuple[str, str], ...]:
    """Every dimension named, EVEN WHEN UNCONSTRAINED.

    A Filters block that lists only what was set leaves the reader guessing
    whether Region was filtered or forgotten. "All" is an answer; silence is not.
    """
    applied = state.applied()
    out: list[tuple[str, str]] = []
    for dimension in DIMENSIONS:
        label = _DIMENSION_LABELS[dimension]
        value = applied.get(dimension)
        if value is None:
            out.append((label, "All"))
        elif dimension == "year":
            out.append((label, f"{value} ({F.fiscal_label(int(value))})"))
        elif dimension == "month":
            out.append((label, MONTHS[int(value) - 1]))
        elif dimension == "channel":
            out.append((label, _channel_names(list(value))))
        elif dimension == "product":
            out.append((label, _product_names(list(value))))
        elif dimension == "promotion":
            out.append((label, _promotion_names(list(value))))
        else:
            out.append((label, ", ".join(map(str, value))))
    return tuple(out)


def scope_line(state: FilterState) -> str:
    """The one-line scope for the cover and the running footer."""
    parts = [F.period_label(state.year, state.month)]
    if state.channel:
        parts.append(_channel_names(sorted(state.channel)))
    else:
        parts.append("All channels")
    if state.category:
        parts.append(", ".join(sorted(state.category)))
    if state.product:
        parts.append(_product_names(sorted(state.product)))
    if state.promotion:
        parts.append(_promotion_names(sorted(state.promotion)))
    return " · ".join(parts)


def base_meta(state: FilterState, currency: str, source: str, extra: tuple = ()) -> tuple:
    """The metadata block every report carries.

    `source` is a plain statement of where the numbers came from. It never says
    "real-time" and never says "AI generated" — this application's figures are
    neither, and the brief forbids claiming either.
    """
    return (
        # The selected currency, and — when it is not the base one — the fact that
        # the conversion happens once at display time in app/tpo/formatting.py.
        # Written in words rather than by slicing a symbol out of a formatted
        # string, which produced "base Rs.INR".
        ("Currency",
         "INR" if currency == "INR"
         else f"{currency}, converted once at display from base currency INR"),
        ("Data period", F.period_label(state.year, state.month)),
        ("Source", source),
        ("Report status", "Generated from the current application view"),
        *extra,
    )


def _kpi(card: dict[str, Any], kind: str) -> KpiEntry:
    """One Insights Hub KPI card, copied — not recomputed.

    Every field here exists on the payload the card itself rendered from, and
    the two the SCREEN shows but a naive copy would drop are picked up
    explicitly:

      * `comparable_events` — how much evidence stood behind the rate;
      * `measured_at` — the wider scope's measurement the tile falls back to
        when the selected scope cannot support one. The Insights Hub renders
        it as "2.3% across all channels · 144 comparable events"; a report
        without it says only "not available" and looks like a missing value.
    """
    events = card.get("comparable_events")
    wider = card.get("measured_at") or {}
    evidence = ""
    if isinstance(events, int):
        evidence = f"{events:,} comparable event{'' if events == 1 else 's'}"
    measured_at = ""
    if wider:
        wider_events = wider.get("comparable_events")
        measured_at = (
            f"{wider.get('display_value', '')} across {wider.get('scope_label', '')}"
            + (f" · {wider_events:,} comparable event{'' if wider_events == 1 else 's'}"
               if isinstance(wider_events, int) else "")
        )

    return KpiEntry(
        label=card.get("label", card.get("key", "")),
        value=card.get("value"),
        # THE CARD'S OWN RENDERING. See KpiEntry: re-formatting `value` is how a
        # report turns the screen's "66" into "66.0".
        display=card.get("display_value", ""),
        kind=kind,  # type: ignore[arg-type]
        previous=card.get("previous_value"),
        previous_display=card.get("previous_display", ""),
        delta_display=card.get("delta_display", "") or "",
        delta_basis=card.get("delta_sub", "") or "",
        trend=card.get("trend", "") or "",
        available=bool(card.get("available", True)),
        unavailable_reason=card.get("unavailable_reason") or "",
        evidence=evidence,
        measured_at=measured_at,
    )


#: KPI key -> the column kind it should be formatted as. The Insights Hub's own
#: `unit` field drives this; the map exists only to translate its vocabulary.
_UNIT_KIND = {"currency": "currency", "percent": "percent", "multiple": "multiple",
              "quantity": "units", "score": "number", "number": "number"}


# --- Insights Hub ----------------------------------------------------------


def command_center(state: FilterState, currency: str, options: dict[str, Any]) -> ReportDoc:
    """The Insights Hub, as the six cards, the risk summary and the alerts.

    `service.kpis` and `service.risk_alerts` are the SAME functions
    `/api/command-center/kpis` and `/risk-alerts` call. No formula is repeated.
    """
    kpis = service.kpis(state, currency)
    alerts = service.risk_alerts(state, currency, limit=int(options.get("alert_limit", 200)))
    mix = service.promotion_mix(state, currency)
    top = service.top_promotions(state, currency, limit=int(options.get("top_limit", 20)))

    cards = kpis["kpis"]
    entries = tuple(
        _kpi(card, _UNIT_KIND.get(card.get("unit", "number"), "number"))
        for card in cards.values()
    )

    counts = alerts.get("counts") or {}
    rows = alerts.get("alerts") or []

    # THE ALERT TOTAL IS THE SUM OF THE BANDS, AND NEVER A ROW COUNT.
    #
    # This used to read `counts.get("total", len(rows))`. `service.risk_alerts`
    # returns no "total" key -- its counts are critical/high/medium alongside
    # target_achieved and total_events -- so the fallback was taken on EVERY
    # export, and `rows` is the alert list already truncated to `alert_limit`
    # (200 above). The report therefore printed its own page size as the alert
    # population: "Total alerts 200" directly beneath "Critical 897 · High 350
    # · Medium 323". A reader outside this application has nothing to check that
    # against, which is exactly why it had to be caught here.
    #
    # THE BANDS ARE THE AUTHORITATIVE POPULATION, and they are mutually
    # exclusive by construction: `service._severity` returns exactly one of
    # critical/high/medium for an event, and `service.risk_alerts` files each
    # event into exactly one band. Their sum therefore counts every alert once
    # and no alert twice.
    #
    # IT IS NOT `total_events`. That counts every promotion event in scope,
    # on-target ones included -- the denominator the screen reports as
    # "{target_achieved} of {total_events} at target" -- and it is not an alert
    # count.
    #
    # No alert logic, threshold or band is touched here: the three numbers are
    # read back exactly as the service produced them, and the total is derived
    # from those same three numbers so the summary cannot contradict itself.
    # The scope is the report's own, because these counts come from the single
    # `risk_alerts(state, ...)` call above.
    severities = tuple(
        (label, int(counts.get(key) or 0))
        for label, key in (("Critical", "critical"), ("High", "high"), ("Medium", "medium"))
    )
    total_alerts = sum(count for _, count in severities)

    doc = ReportDoc(
        module="Insights Hub",
        title="Trade Promotion Performance Report",
        generated_at="", generated_display="",
        scope_line=scope_line(state),
        filters=filter_rows(state),
        meta=base_meta(
            state, currency,
            "Measured from fact_sales by the validated KPI engine "
            "(app/tpo/aggregate.py), through the same endpoints the Insights Hub "
            "screen reads.",
        ),
        disclaimers=(
            "Generated from the selected TPO Intelligence view and its authoritative "
            "calculation results.",
            "Every figure is a measurement of the filtered rows. Deltas compare the "
            "same filters against the previous year; a KPI with no comparable prior "
            "period is reported without one rather than against zero.",
        ),
        filename_stem="",
        landscape=False,
    )

    sections: list[Section] = [
        Section("KPI summary", "kpi", entries,
                note="Values, previous period and delta exactly as the Insights Hub "
                     "cards display them."),
        Section("Risk summary", "kv", (
            *((label, str(count)) for label, count in severities),
            ("Total alerts", str(total_alerts)),
        ), note=f"Alerts matching the current filters. Target ROI "
                f"{kpis['meta'].get('target_roi', '')}."),
    ]

    if mix.get("slices"):
        sections.append(Section(
            "Promotion mix", "table", table=Table(
                columns=(
                    Column("label", "Promotion", "text", 30),
                    Column("type", "Type", "text", 14),
                    Column("trade_spend", "Trade spend", "currency", 18),
                    Column("share_pct", "Share of spend", "percent", 14),
                ),
                rows=tuple(
                    {"label": slice_.get("label"), "type": slice_.get("type"),
                     "trade_spend": slice_.get("spend"), "share_pct": slice_.get("pct")}
                    for slice_ in mix["slices"]
                ),
                title="Trade spend by promotion",
                note=f"Total trade spend {mix.get('total_spend_display', '')}.",
            )))

    if top.get("rows"):
        sections.append(Section(
            "Promotion performance", "table", sheet="Promotion Performance", landscape=True,
            table=Table(
                columns=(
                    Column("promotion", "Promotion", "text", 26),
                    Column("product", "Product", "text", 32),
                    Column("channel", "Channel", "text", 15),
                    Column("period", "Period", "text", 12),
                    Column("trade_spend", "Trade spend", "currency", 16),
                    Column("incremental_sales", "Incremental sales", "currency", 18),
                    Column("roi_multiple", "ROI", "multiple", 11),
                    Column("vs_target", "vs target", "multiple", 14),
                    Column("status", "Status", "status", 16),
                ),
                rows=tuple(
                    {"promotion": r.get("promotion"), "product": r.get("product"),
                     "channel": r.get("channel"), "period": r.get("period"),
                     "trade_spend": r.get("trade_spend"),
                     "incremental_sales": r.get("incremental_sales"),
                     "roi_multiple": r.get("roi_multiple"), "vs_target": r.get("vs_target"),
                     "status": r.get("status")}
                    for r in top["rows"]
                ),
                title=f"{len(top['rows'])} promotion events in the current selection",
            )))

    if rows:
        sections.append(Section(
            "Risk alerts", "table", sheet="Risk Alerts", landscape=True,
            table=Table(
                columns=(
                    Column("severity", "Risk", "status", 11),
                    Column("promotion", "Promotion", "text", 26),
                    Column("product", "Product", "text", 30),
                    Column("channel", "Channel", "text", 15),
                    Column("period", "Period", "text", 12),
                    Column("roi_multiple", "ROI", "multiple", 11),
                    Column("target_roi", "Target", "multiple", 11),
                    Column("gap", "Gap", "multiple", 11),
                    Column("trade_spend", "Trade spend", "currency", 16),
                    Column("at_stake", "At stake", "currency", 16),
                ),
                rows=tuple(_alert_row(a, kpis["meta"].get("target_roi")) for a in rows),
                # THE SAME NUMBER THE SUMMARY PRINTS, and the listing says when it
                # is showing fewer rows than that. The title used to read
                # "{len(rows)} alert(s) matching the current filters" -- true of
                # the table, false of the filters, and the second half of the
                # contradiction the Total alerts row created: a capped listing
                # presented as the whole population.
                title=(
                    f"{len(rows)} of {total_alerts} alert(s) matching the current filters"
                    if len(rows) < total_alerts
                    else f"{len(rows)} alert(s) matching the current filters"
                ),
                note="The currently filtered alerts, not the whole dataset.",
            )))
    else:
        sections.append(Section(
            "Risk alerts", "text",
            ("No promotion in this scope falls below the ROI target, so no alert was "
             "raised. This is a measured result, not an empty table.",)))

    doc.sections = tuple(sections)
    return doc


def _alert_row(alert: dict[str, Any], target: Any) -> dict[str, Any]:
    roi = alert.get("roi_multiple")
    gap = None
    if isinstance(roi, (int, float)) and isinstance(target, (int, float)):
        # Presentation subtraction of two figures the payload already carries,
        # not a KPI derivation: the screen shows the same shortfall.
        gap = round(roi - target, 2)
    return {
        "severity": alert.get("severity"),
        "promotion": alert.get("promotion") or alert.get("title"),
        "product": alert.get("product"),
        "channel": alert.get("channel"),
        # `risk_alerts` names the week `week`; the other two are kept for any
        # payload that already spells it that way.
        "period": alert.get("period") or alert.get("week") or alert.get("week_key"),
        "roi_multiple": roi,
        "target_roi": target,
        "gap": gap,
        "trade_spend": alert.get("trade_spend"),
        "at_stake": alert.get("at_stake"),
    }


# --- Simulation Studio --------------------------------------------------------


def _figure(block: dict[str, Any], key: str) -> Any:
    cell = block.get(key) or {}
    return cell.get("value")


def simulation_studio(state: FilterState, currency: str, options: dict[str, Any]) -> ReportDoc:
    """The three levers and the window they describe, as the studio computed it.

    `studio.simulate` is the function `/api/simulation/simulate` calls, invoked
    here with the lever values the page was holding, so the export shows the
    same window the reader was looking at. Nothing is re-derived: the band, the
    coverage, the weekly rows and the model's provenance are the payload's own.
    """
    missing = [k for k in ("discount_pct", "trade_spend", "days") if options.get(k) is None]
    if missing:
        raise ValueError(
            "A Simulation Studio export needs the three lever values the page is showing. "
            f"Missing: {', '.join(missing)}."
        )
    result = studio.simulate(
        state,
        discount_pct=float(options["discount_pct"]),
        trade_spend=float(options["trade_spend"]),
        days=int(options["days"]),
        currency=currency,
    )
    levers, window, model = result["levers"], result["window"], result["model"]
    spend = levers["trade_spend"]
    current, scenario, baseline = result["current_plan"], result["scenario"], result["baseline"]
    deltas = result["deltas"]

    doc = ReportDoc(
        module="Simulation Studio",
        title="Promotion Scenario Report",
        generated_at="", generated_display="",
        scope_line=scope_line(state),
        filters=filter_rows(state),
        meta=base_meta(
            state, currency,
            "Window rows synthesized from each product-channel's ordinary week in this scope "
            "and read by the validated KPI engine (app/tpo/studio.py). Revenue, Trade Spend, "
            "Incremental Sales and ROI carry the engine's own definitions.",
            extra=(("Lift model", model["provenance"]),),
        ),
        disclaimers=(
            "Generated from the selected TPO Intelligence view and its authoritative "
            "calculation results.",
            "Scenario values are estimates for a hypothetical window and are not historical "
            "actuals. The current plan is this scope's own promotions replayed over the same window.",
        ),
        headline=(
            f"Scenario revenue {deltas['revenue']['absolute']['display']} "
            f"({deltas['revenue']['percent_display']}) vs the current plan over {levers['days']} days; "
            f"ROI {scenario['roi']['display']} ({deltas['roi']['absolute_display']})."
        ),
        headline_tone={"profitable": "positive", "break_even": "neutral",
                       "loss_making": "warning", "not_applicable": "neutral"}[deltas["roi"]["status"]],
    )

    status = {"profitable": "Profitable (above 1.00)", "loss_making": "Loss-making (below 1.00)",
              "break_even": "Break-even (1.00)", "not_applicable": "Not applicable (no spend)"}
    weeks_word = "business week" if window["weeks"] == 1 else "business weeks"
    partial = window.get("partial_week_fraction")
    days_text = f"{levers['days']} days · {window['weeks']} {weeks_word}"
    if partial:
        days_text += f" (last week {partial * 100:.0f}% covered)"
    coverage_text = spend["coverage_display"] + (
        " — budget is binding" if spend["binding"]
        else " — budget not binding; " + spend["unspent"]["display"] + " unspent"
    )

    def plan_row(p: dict[str, Any]) -> dict[str, Any]:
        return {
            "plan": p["label"], "discount": p["discount_pct"], "coverage": p["coverage"] * 100,
            "revenue": _figure(p, "revenue"),
            "trade_spend": _figure(p, "trade_spend"),
            "incremental_sales": _figure(p, "incremental_sales"),
            "roi": _figure(p, "roi"),
            "margin": _figure(p, "margin_pct"),
        }

    sections: list[Section] = [
        Section("Levers", "kv", (
            ("Discount", F.percent(levers["discount_pct"])),
            ("Days", days_text),
            ("Trade spend budget", spend["requested"]["display"]),
            ("Budget consumed", spend["consumed"]["display"]),
            ("Coverage funded", coverage_text),
            ("Volume lift applied", result["lift"]["display"]),
        )),
        Section("Window result", "table", table=Table(
            columns=(
                Column("plan", "Plan", "text", 18),
                Column("discount", "Discount", "percent", 10),
                Column("coverage", "Coverage", "percent", 10),
                Column("revenue", "Revenue", "currency", 16),
                Column("trade_spend", "Trade spend", "currency", 16),
                Column("incremental_sales", "Incremental sales", "currency", 16),
                Column("roi", "ROI", "multiple", 8),
                Column("margin", "Margin", "percent", 10),
            ),
            rows=(
                {"plan": baseline["label"], "discount": 0.0, "coverage": 100.0,
                 "revenue": _figure(baseline, "revenue"), "trade_spend": 0.0},
                plan_row(current),
                plan_row(scenario),
            ),
            title=f"{levers['days']}-day window",
            note=current["note"],
        ), sheet="Window result", landscape=True),
        Section("Scenario vs current plan", "kv", (
            ("Revenue", f"{deltas['revenue']['absolute']['display']} "
                        f"({deltas['revenue']['percent_display']}) · {deltas['revenue']['direction']}"),
            ("ROI", f"{deltas['roi']['absolute_display']} · {deltas['roi']['direction']}"),
            ("Scenario ROI status", status[deltas["roi"]["status"]]),
            ("Revenue vs no promotion", result["vs_baseline"]["revenue"]["display"]),
        )),
        Section("Week by week", "table", table=Table(
            columns=(
                Column("week", "Week", "text", 10),
                Column("days", "Days", "number", 6),
                Column("baseline", "No promotion", "currency", 16),
                Column("current", "Current plan", "currency", 16),
                Column("scenario", "Scenario", "currency", 16),
                Column("current_roi", "Current ROI", "multiple", 10),
                Column("scenario_roi", "Scenario ROI", "multiple", 10),
            ),
            rows=tuple(
                {"week": w["label"], "days": w["days"],
                 "baseline": w["baseline_revenue"]["value"],
                 "current": w["current_revenue"]["value"],
                 "scenario": w["scenario_revenue"]["value"],
                 "current_roi": w["current_roi"]["value"],
                 "scenario_roi": w["scenario_roi"]["value"]}
                for w in result["weekly"]
            ),
            note="Each week is measured on its own against the scope's baseline, so the weekly "
                 "revenues sum to the window's exactly. ROI is that week's own Incremental "
                 "Sales / Trade Spend and is not additive.",
        ), sheet="Week by week", landscape=True),
        Section("Lift model", "text", tuple(model["notes"])),
        Section("Method", "text", (result["method"],)),
    ]
    if result.get("after_window"):
        sections.insert(4, Section("After the window", "kv", (
            ("Post-promotion week", result["after_window"]["revenue_effect"]["display"]),
            ("Note", result["after_window"]["note"]),
        )))
    doc.sections = tuple(sections)
    return doc



# --- Decision Center ----------------------------------------------------------


def decision_center(state: FilterState, currency: str, options: dict[str, Any]) -> ReportDoc:
    """The Decision Center board: the scenarios compared, the one chosen, and why.

    `options["board"]` is the page's own state -- the scenarios exactly as the
    Simulation Studio snapshotted them (every figure a display string), the
    chosen slot and the rationale. Nothing is recomputed: a report of a
    decision shows the numbers the decision was taken on.

    A payload without `board` is the retired record path, still served for
    decisions stored before 2026-09-22 (see `_decision_record_doc`).
    """
    board = options.get("board")
    if not isinstance(board, dict):
        return _decision_record_doc(state, currency, options)
    scenarios = [s for s in board.get("scenarios", []) if isinstance(s, dict)]
    if not scenarios:
        raise ValueError(
            "A Decision Center export needs the scenarios on the board. Add at least one "
            "from Simulation Studio before exporting."
        )
    scenarios.sort(key=lambda s: int(s.get("slot", 0)))
    chosen_slot = board.get("chosen_slot")
    chosen = next((s for s in scenarios if s.get("slot") == chosen_slot), None)
    rationale = str(board.get("rationale") or "").strip()

    def cell(s: dict[str, Any], key: str) -> str:
        k = next((k for k in s.get("kpis", []) if k.get("key") == key), None)
        return "" if k is None else str(k.get("value", ""))

    def sub(s: dict[str, Any], key: str) -> str:
        k = next((k for k in s.get("kpis", []) if k.get("key") == key), None)
        return "" if k is None else str(k.get("sub") or "")

    name = lambda s: f"Scenario {s.get('slot')}" + (" (chosen)" if s.get("slot") == chosen_slot else "")

    doc = ReportDoc(
        module="Decision Center",
        title="Promotion Decision",
        generated_at="", generated_display="",
        scope_line=scope_line(state),
        filters=filter_rows(state),
        meta=base_meta(
            state, currency,
            "Scenarios as the Simulation Studio computed them (validated KPI engine over "
            "synthesized window rows) and snapshotted on adding to Decision Center. "
            "Nothing is recomputed for this report.",
            extra=(("Scenarios compared", str(len(scenarios))),
                   ("Chosen", f"Scenario {chosen_slot}" if chosen else "None chosen yet")),
        ),
        disclaimers=(
            "Generated from the selected TPO Intelligence view and its authoritative "
            "calculation results.",
            "Scenario values are estimates for a hypothetical window and are not historical "
            "actuals.",
        ),
        headline=(
            f"Scenario {chosen_slot} chosen: {cell(chosen, 'discount')} for {cell(chosen, 'days')} at "
            f"{cell(chosen, 'budget')} -- revenue {cell(chosen, 'revenue')}, ROI {cell(chosen, 'roi')}."
            if chosen else "No scenario has been chosen yet."
        ),
        headline_tone="positive" if chosen else "neutral",
    )

    rows_spec = (
        ("discount", "Discount"), ("days", "Days"), ("budget", "Trade spend budget"),
        ("revenue", "Revenue"),
        ("roi", "ROI"),
        ("trade_spend", "Trade spend"), ("incremental_sales", "Incremental sales"),
        ("incremental_units", "Incremental units"), ("margin", "Margin"),
        ("lift", "Volume lift"), ("vs_baseline", "Revenue vs no promotion"),
    )
    columns = [Column("metric", "Metric", "text", 24)]
    columns += [Column(f"s{s.get('slot')}", name(s), "text", 22) for s in scenarios]
    table_rows = []
    for key, label in rows_spec:
        row: dict[str, Any] = {"metric": label}
        for s in scenarios:
            v = cell(s, key)
            extra = sub(s, key)
            row[f"s{s.get('slot')}"] = f"{v} · {extra}" if extra else v
        table_rows.append(row)

    sections: list[Section] = [
        Section("Decision", "kv", (
            ("Chosen scenario", f"Scenario {chosen_slot} · {chosen.get('scope', {}).get('label', '')}" if chosen else "None chosen yet"),
            ("Rationale", rationale or "—"),
            ("Scenarios compared", ", ".join(f"Scenario {s.get('slot')} ({s.get('scope', {}).get('label', '')})" for s in scenarios)),
        )),
        Section("Scenario comparison", "table", table=Table(
            columns=tuple(columns), rows=tuple(table_rows),
            title=f"{len(scenarios)} scenario{'' if len(scenarios) == 1 else 's'} side by side",
            note="Every value is the one Simulation Studio showed when the scenario was added.",
        ), sheet="Comparison", landscape=True),
    ]
    doc.sections = tuple(sections)
    return doc


def _decision_record_doc(state: FilterState, currency: str, options: dict[str, Any]) -> ReportDoc:
    """The current decision record, with its draft semantics preserved.

    TWO WAYS IN, ONE RECORD OUT.

      * `options["decision_record"]` -- a record that ALREADY exists, handed
        over whole. This is what a decision read back out of the store carries:
        the stored bytes, which must be exported exactly as they were saved.
        Re-assembling one from a live dataset would silently republish a
        historical decision at today's numbers, which is the one thing the
        dataset fingerprint exists to prevent.
      * `options["record"]` -- the four Simulation Studio payloads, assembled
        here by `app/tpo/decision.build_record`, the SAME function
        `/api/decision/record` calls. This is the live path.

    Either way this adapter decides nothing about approval -- it prints what the
    record says, and the record says this project has no approval criteria.
    """
    board = options.get("comparison_board")
    assembled = options.get("decision_record")
    if isinstance(assembled, dict) and assembled.get("expected_impact") is not None:
        record = assembled
    else:
        payloads = options.get("record") or {}
        required = ("context", "simulation", "recommendation", "risk")
        missing = [k for k in required if not payloads.get(k)]
        if missing:
            # A COMPARISON IS A REPORTABLE THING ON ITS OWN.
            #
            # Decision Center now holds several candidate scenarios, and only
            # those from Simulation Studio can become a governed record -- the
            # optimizer, Target Rescue and the measured plan produce none of the
            # four payloads `build_record` needs. Refusing to export the board
            # because of that would mean the comparison the user is actually
            # looking at is the one thing they cannot take away.
            if isinstance(board, dict) and board.get("scenarios"):
                return _comparison_only_doc(state, currency, board)
            raise ValueError(
                "A decision record needs the Simulation Studio results it is assembled "
                f"from. Missing: {', '.join(missing)}. Open the decision in Decision "
                "Center before exporting."
            )

        record = decision_service.build_record(
            context=payloads["context"],
            scenario=payloads["simulation"],
            recommendation=payloads["recommendation"],
            risk=payloads["risk"],
            weekly=payloads.get("weekly"),
            comparison=payloads.get("comparison"),
            baseline=payloads.get("baseline"),
        )

    doc = ReportDoc(
        module="Decision Center",
        title="Decision Record",
        generated_at="", generated_display="",
        scope_line=scope_line(state),
        filters=filter_rows(state),
        meta=base_meta(
            state, currency,
            "Assembled by app/tpo/decision.py from the Simulation Studio results the "
            "screen already holds. Nothing is recalculated when a record is assembled.",
        ),
        disclaimers=(
            "Generated from the selected TPO Intelligence view and its authoritative "
            "calculation results.",
            "Decision status reflects the current application record and does not imply "
            "approval unless explicitly shown.",
            "Simulated values are scenario estimates and are not historical actuals.",
        ),
    )
    doc.sections = _decision_sections(record, options)
    # The board travels WITH the record when both exist: the record says what
    # is being decided, the comparison says what it was chosen over.
    if isinstance(board, dict) and board.get("scenarios"):
        doc.sections = doc.sections + _comparison_sections(board)
    return doc


def investigation(state: FilterState, currency: str, options: dict[str, Any]) -> ReportDoc:
    """A finished investigation: the question, the agents' answer, and the
    findings that answer rests on.

    THE RUN IS HANDED OVER WHOLE, in `options["run"]`, the way a decision
    record is: it is what the screen is showing, it is the reader's own run
    (the runs store is per user and the Report Center is not, so loading one
    here by id would let any signed-in reader export any run), and nothing
    is re-run. Every sentence and figure below is copied off the run's
    stored synthesis and findings; this adapter computes nothing.

    `options["source_label"]` names the data the agents analysed, exactly as
    the page names it -- "TPO star schema (built-in)" or an upload's filename
    and row count -- because the run record holds only a dataset id.
    """
    run = options.get("run")
    if not isinstance(run, dict) or run.get("status") != "done" or not isinstance(run.get("result"), dict):
        raise ValueError(
            "An investigation report needs a finished run. Ask a question, let the "
            "specialist agents complete, then export."
        )
    result = run["result"]
    synthesis = result.get("synthesis")
    if not isinstance(synthesis, dict):
        raise ValueError(
            "This run produced no answer to report: "
            + str(result.get("refusal") or "the question was out of scope.")
        )
    findings = [f for f in (result.get("findings") or []) if isinstance(f, dict)]
    totals = result.get("totals") or {}
    global_filters = result.get("global_filters") or {}

    def pct(value: Any) -> str:
        return f"{int(value)}%" if isinstance(value, (int, float)) and not isinstance(value, bool) else "—"

    about = [
        ("Question", _text(run.get("question"))),
        ("Investigation type", _text(result.get("investigation_type") or "diagnostic").replace("_", " ").title()),
        ("Data analysed", _text(options.get("source_label") or "TPO star schema (built-in)")),
    ]
    # The week the event ran, when the run was pinned to one. It is a label
    # on the run, not a report dimension (see FilterState), so it is named
    # here rather than in the filter list.
    if global_filters.get("week"):
        about.append(("Week", _text(global_filters["week"])))
    rows = totals.get("rows")
    if isinstance(rows, (int, float)) and not isinstance(rows, bool):
        about.append(("Rows analysed", f"{int(rows):,}"))
    about += [
        ("Specialists run", str(len(findings))),
        ("Findings", str(synthesis.get("insight_count") if synthesis.get("insight_count") is not None else len(findings))),
        ("Confidence", pct(synthesis.get("confidence"))),
    ]

    recommendations = [str(r) for r in (synthesis.get("recommendations") or []) if r]
    actions = Table(
        title="Recommended actions",
        columns=(
            Column("n", "#", "units", 4),
            Column("action", "Action", "text", 90),
        ),
        rows=tuple({"n": i, "action": text} for i, text in enumerate(recommendations, 1)),
        note="In the order the synthesis gave them." if recommendations else "The synthesis made no recommendation.",
    )

    finding_rows = tuple(
        {
            "specialist": _text(f.get("name")),
            "headline": _text(f.get("headline")),
            "body": _text(f.get("body")),
            "evidence": _text(f.get("evidence")),
            "metric": _text(f.get("metric")),
            "delta": _text(f.get("delta")),
            "impact": _text(f.get("impact")).title(),
            "confidence": pct(f.get("confidence")),
        }
        for f in findings
    )
    specialists = Table(
        title="Specialist findings",
        columns=(
            Column("specialist", "Specialist", "text", 18),
            Column("headline", "Finding", "text", 30),
            Column("body", "Detail", "text", 44),
            Column("evidence", "Evidence", "text", 34),
            Column("metric", "Metric", "text", 12),
            Column("delta", "Change", "text", 10),
            Column("impact", "Impact", "status", 8),
            Column("confidence", "Confidence", "text", 10),
        ),
        rows=finding_rows,
        note=(
            "Each specialist analysed one lens of the scoped data and reported what it "
            "found; confidence is the share of its claims the data could verify."
        ),
    )

    doc = ReportDoc(
        module="Investigations",
        title="Promotion Investigation Report",
        generated_at="", generated_display="",
        scope_line=scope_line(state),
        filters=filter_rows(state),
        meta=base_meta(
            state, currency,
            "The stored result of the specialist-agent run shown on the Investigations "
            "page. Nothing is re-run or recalculated when a report is generated.",
        ),
        headline=_text(synthesis.get("root_cause")),
        headline_tone="warning",
        disclaimers=(
            "Generated from the selected TPO Intelligence view and its authoritative "
            "calculation results.",
            "Findings are the specialist agents' reading of the scoped data at the time "
            "the investigation ran, and are not a substitute for the underlying figures.",
        ),
    )
    return doc.with_sections(
        Section("Investigation", "kv", tuple(about)),
        Section("Summary", "text", tuple(p for p in (_text(synthesis.get("summary")),) if p)),
        Section("Root cause", "text", tuple(p for p in (_text(synthesis.get("root_cause")),) if p)),
        Section("Recommended actions", "table", table=actions),
        Section("Specialist findings", "table", table=specialists, landscape=True, page_break=True),
    )


def _comparison_only_doc(state: FilterState, currency: str, board: dict[str, Any]) -> ReportDoc:
    """The candidate board on its own, when no governed record exists for it."""
    doc = ReportDoc(
        module="Decision Center",
        title="Scenario Comparison",
        generated_at="", generated_display="",
        scope_line=scope_line(state),
        filters=filter_rows(state),
        meta=base_meta(
            state, currency,
            "Compared in Decision Center from results each module computed. Every figure is "
            "the one its own engine produced and is reprinted here unchanged; the ranking is "
            "the Decision Center's own deterministic rule, stated with the result.",
        ),
        disclaimers=(
            "Generated from the selected TPO Intelligence view and its authoritative "
            "calculation results.",
            "This is a comparison of candidate scenarios, not an approved decision, and it "
            "implies no approval.",
            "Simulated values are scenario estimates and are not historical actuals.",
        ),
    )
    doc.sections = _comparison_sections(board)
    return doc


def _comparison_sections(board: dict[str, Any]) -> tuple[Section, ...]:
    """Print the board exactly as the screen shows it.

    NOTHING IS RECOMPUTED HERE, and nothing is filled in. Each scenario carries
    the display strings its own module formatted; a metric a module does not
    produce arrives as an empty cell and stays empty, because the alternative --
    a zero -- would read as a measurement.
    """
    sections: list[Section] = []
    scenarios = [s for s in board.get("scenarios") or [] if isinstance(s, dict)]
    labels = [str(x) for x in (board.get("metric_labels") or [])]

    sections.append(Section(
        "Scenarios compared", "table",
        table=Table(
            columns=(
                Column("name", "Scenario"),
                Column("source", "Source"),
                Column("scope", "Scope"),
                Column("plan", "Plan"),
            ),
            rows=tuple(
                {
                    "name": _text(s.get("name")),
                    "source": _text(s.get("source")),
                    "scope": _text(s.get("scope")),
                    "plan": _text(s.get("plan")),
                }
                for s in scenarios
            ),
        ),
    ))

    if labels and scenarios:
        # One column per scenario, one row per metric -- the shape on screen.
        columns = [Column("metric", "Metric")]
        for index, s in enumerate(scenarios):
            columns.append(Column(f"s{index}", _text(s.get("name"))))
        rows = []
        for label in labels:
            row: dict[str, Any] = {"metric": label}
            for index, s in enumerate(scenarios):
                metrics = s.get("metrics") or {}
                row[f"s{index}"] = _text(metrics.get(label))
            rows.append(row)
        sections.append(Section("Comparison", "table", table=Table(columns=tuple(columns), rows=tuple(rows))))

    recommendation = board.get("recommendation") or {}
    if recommendation:
        kv: list[tuple[str, str]] = []
        if recommendation.get("name"):
            kv.append(("Recommended scenario", _text(recommendation.get("name"))))
            kv.append(("Source", _text(recommendation.get("source"))))
            kv.append(("Points", _text(recommendation.get("points"))))
            if recommendation.get("tie_break"):
                kv.append(("Tie-break", _text(recommendation.get("tie_break"))))
        else:
            kv.append(("Recommended scenario", "None"))
            kv.append(("Why not", _text(recommendation.get("blocked"))))
        kv.append(("Ranking rule", _text(recommendation.get("rule"))))
        kv.append(("Method", "Deterministic ranking in the Decision Center. No model was called."))
        sections.append(Section("Recommendation", "kv", tuple(kv)))

    why = board.get("why") or {}
    lines = [(f"Leads on", str(x)) for x in (why.get("strengths") or [])]
    lines += [(f"Does not lead on", str(x)) for x in (why.get("caveats") or [])]
    if lines:
        sections.append(Section("Why this plan is recommended", "kv", tuple(lines)))

    return tuple(sections)


def _text(value: Any) -> str:
    """One cell, printed as it is -- never zero-filled and never rounded."""
    return "" if value is None else str(value)


def _decision_sections(
    record: dict[str, Any], options: dict[str, Any] | None = None
) -> tuple[Section, ...]:
    """Flatten the record into sections WITHOUT reinterpreting any of it.

    EVERY STRING BELOW COMES OUT OF THE RECORD. No label is rewritten, no band
    is collapsed to a midpoint, no unavailable metric is filled with a zero and
    no governance verdict is synthesised. Where the record has a reason instead
    of a value, the reason is what is printed -- a blank cell beside an explained
    absence is what makes an export honest rather than merely short.
    """
    options = options or {}
    sections: list[Section] = []

    scenario = record.get("scenario") or {}
    scope = record.get("scope") or {}
    investigation = record.get("investigation") or {}
    storage = options.get("storage") or {}

    # --- 1. what is being decided
    identity: list[tuple[str, str]] = [
        ("Decision ID", _text(storage.get("decision_id")) or "Not saved"),
        ("Version", _text(storage.get("version")) or "Not saved"),
        ("Status", _text(record.get("status"))),
        ("Scenario", _text(scenario.get("name"))),
        ("Treatment", _text(scenario.get("treatment"))),
        ("Discount depth", _text(scenario.get("discount_pct"))),
        ("Investigation", _text(investigation.get("investigation_type")) or "Not specified"),
        ("Investigation question",
         _text(investigation.get("question"))
         or _text(investigation.get("question_unavailable_reason"))
         or "Not recorded"),
        ("Investigation ID",
         _text(investigation.get("investigation_id"))
         or _text(investigation.get("investigation_id_unavailable_reason"))
         or "Not assigned"),
        ("Period", _text(scope.get("period"))),
        ("Rows in scope", _text(scope.get("row_count"))),
        ("Promoted rows", _text(scope.get("promoted_row_count"))),
    ]
    # The same fact the screen shows above the impact figures. A report that
    # printed the zeros without it would be the version that outlives the page.
    if scope.get("excluded_rows"):
        identity.append(("Excluded from scenario", _text(scope.get("excluded_rows"))))
        identity.append(("Exclusion reason", _text(scope.get("excluded_reason"))))
        if scope.get("all_promoted_rows_excluded"):
            identity.append((
                "Note",
                "Every promoted row was excluded, so this scenario had nothing to "
                "compute over. The expected-impact figures below are the absence of a "
                "simulated result, not a measured outcome.",
            ))
    if storage.get("dataset_version"):
        identity.append(("Dataset version", _text(storage.get("dataset_version"))))
        identity.append(("Data freshness", "Stale" if storage.get("stale") else "Current"))
    sections.append(Section("Decision", "kv", tuple(identity)))

    # --- 2. strategy, only the levers the scenario actually carries
    strategy = record.get("strategy") or {}
    if strategy.get("levers"):
        sections.append(Section(
            "Strategy", "table",
            table=Table(
                columns=(
                    Column("lever", "Lever"),
                    Column("current", "Current (measured)"),
                    Column("selected", "Selected"),
                    Column("recommended", "Recommended"),
                    Column("basis", "Basis"),
                ),
                rows=tuple(
                    {
                        "lever": _text(lever.get("label")),
                        "current": (
                            _text(lever.get("current_display"))
                            if lever.get("current_available")
                            else _text(lever.get("current_unavailable_reason"))
                        ),
                        "selected": (
                            _text(lever.get("selected_value"))
                            if lever.get("selected_available")
                            else _text(lever.get("selected_unavailable_reason"))
                        ),
                        "recommended": (
                            (_text(lever.get("recommended_display"))
                             or _text(lever.get("recommended_value")))
                            + (" (measured plan)"
                               if lever.get("recommended_is_measured_plan") else "")
                            if lever.get("recommended_available")
                            else _text(lever.get("recommended_unavailable_reason"))
                        ),
                        "basis": _text(lever.get("note") or lever.get("current_derivation")),
                    }
                    for lever in strategy["levers"]
                ),
                note=_text(strategy.get("note")),
            ),
        ))

    # --- 3. expected impact, BOTH ends of the band
    impact = record.get("expected_impact") or []
    if impact:
        sections.append(Section(
            "Expected impact (simulated)", "table",
            table=Table(
                columns=(
                    Column("metric", "Metric"),
                    Column("low", "Low"),
                    Column("high", "High"),
                    Column("note", "Note"),
                ),
                rows=tuple(
                    {
                        "metric": _text(metric.get("label") or metric.get("metric")),
                        "low": _text(metric.get("display_low")) if metric.get("available") else "",
                        "high": _text(metric.get("display_high")) if metric.get("available") else "",
                        "note": "" if metric.get("available") else _text(metric.get("unavailable_reason")),
                    }
                    for metric in impact
                ),
                note=(
                    "Both ends of the approved uplift range. There is no midpoint and no "
                    "expected value between them, and this is not a confidence interval. "
                    "These are simulated values, not historical actuals."
                ),
            ),
        ))

    # --- 4. scenario comparison, measured baseline beside simulated bands
    comparison = record.get("comparison") or {}
    if comparison.get("available") and comparison.get("metrics"):
        entries = [
            entry for entry in comparison.get("scenarios", [])
            if entry.get("status") != "excluded"
        ]
        columns = [Column("metric", "Metric"), Column("baseline", "Current (measured)")]
        for entry in entries:
            columns.append(Column(
                f"s_{entry.get('scenario_id')}",
                f"{entry.get('name')}{' (selected)' if entry.get('is_selected') else ''}",
            ))
        rows = []
        for metric in comparison["metrics"]:
            baseline_side = metric.get("baseline") or {}
            row = {
                "metric": _text(metric.get("label")),
                "baseline": (
                    _text(baseline_side.get("display_value"))
                    if baseline_side.get("available") else ""
                ),
            }
            by_id = {m.get("scenario_id"): m for m in metric.get("scenarios", [])}
            for entry in entries:
                cell = by_id.get(entry.get("scenario_id")) or {}
                low, high = cell.get("low") or {}, cell.get("high") or {}
                if low.get("available") and high.get("available"):
                    text = f"{low.get('display_value')} - {high.get('display_value')}"
                elif low.get("available"):
                    text = _text(low.get("display_value"))
                else:
                    text = ""
                row[f"s_{entry.get('scenario_id')}"] = text
            rows.append(row)
        sections.append(Section(
            "Scenario comparison", "table", landscape=True,
            table=Table(
                columns=tuple(columns), rows=tuple(rows),
                note=_text(comparison.get("measured_note")),
            ),
        ))

    # --- 5. recommendation, verbatim
    recommendation = record.get("recommendation") or {}
    sections.append(Section("Recommendation", "kv", tuple(
        (label, _text(value)) for label, value in (
            ("Recommended scenario", recommendation.get("recommended_scenario_name")
             or recommendation.get("recommended_scenario_id")),
            ("Recommended scenario id", recommendation.get("recommended_scenario_id")),
            ("Is this scenario", "Yes" if recommendation.get("is_this_scenario") else "No"),
            ("Objective", recommendation.get("objective")),
            ("Primary metric", recommendation.get("primary_metric")),
            ("Primary endpoint", recommendation.get("primary_endpoint")),
            ("Reason", recommendation.get("reason")),
            ("Note", recommendation.get("note")),
        )
    )))

    # --- 6. risk and governance, B6's own findings
    governance = record.get("governance") or {}
    sections.append(Section("Risk and governance", "kv", tuple(
        (label, _text(value)) for label, value in (
            ("Overall status", governance.get("overall_status")),
            ("Rule", governance.get("overall_status_rule")),
            ("Summary", governance.get("summary")),
        )
    )))
    if governance.get("findings"):
        sections.append(Section(
            "Risk findings", "table",
            table=Table(
                columns=(
                    Column("finding", "Finding"), Column("severity", "Severity"),
                    Column("status", "Status"), Column("reason", "Reason"),
                ),
                rows=tuple(
                    {
                        "finding": _text(f.get("title")),
                        "severity": _text(f.get("severity")),
                        "status": _text(f.get("status")),
                        "reason": _text(f.get("reason")),
                    }
                    for f in governance["findings"]
                ),
            ),
        ))
    if governance.get("governance_gaps"):
        sections.append(Section(
            "Governance considerations", "text",
            tuple(
                f"{gap.get('label')} - {gap.get('statement')}"
                for gap in governance["governance_gaps"]
            ),
            note=(
                "These boundaries are not defined anywhere in this project, so nothing "
                "above is judged against them."
            ),
        ))

    # --- 7. readiness, and why nothing here is approved
    readiness = record.get("readiness") or {}
    states = readiness.get("states") or {}
    sections.append(Section("Decision readiness", "kv", tuple(
        (label, _text(value)) for label, value in (
            ("Can be approved", "Yes" if readiness.get("can_be_approved") else "No"),
            ("Reason", readiness.get("reason")),
            ("Recommended", "Yes" if states.get("recommended") else "No"),
            ("Governed", "Yes" if states.get("governed") else "No"),
            ("Ready to review", "Yes" if states.get("ready_to_review") else "No"),
            ("Approved", "Yes" if states.get("approved") else "No"),
            ("Note", readiness.get("states_note")),
        )
    )))
    if readiness.get("blockers"):
        sections.append(Section(
            "Blocking approval", "text",
            tuple(f"{b.get('title')} - {b.get('detail')}" for b in readiness["blockers"]),
        ))
    if readiness.get("unverified"):
        sections.append(Section(
            "Unverified before execution", "text",
            tuple(f"{u.get('title')} - {u.get('detail')}" for u in readiness["unverified"]),
        ))

    # --- 8. provenance
    provenance = record.get("provenance") or {}
    sections.append(Section("Record provenance and limits", "kv", tuple(
        (label, _text(value)) for label, value in (
            ("Assembled from", ", ".join(provenance.get("assembled_from") or [])),
            ("KPI engine", provenance.get("kpi_engine")),
            ("Response rule", provenance.get("response_rule")),
            ("Method", provenance.get("method")),
            ("Persistence", (record.get("meta") or {}).get("persistence_note")),
        )
    )))
    return tuple(sections)
